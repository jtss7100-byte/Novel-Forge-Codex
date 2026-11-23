import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  areEmbeddingsVectorSpaceCompatible,
  computeCosineSimilarity,
  computeDeterministicSemanticEmbedding,
  computeMemoryContentHash,
  DETERMINISTIC_TEST_EMBEDDING_MODEL_ID,
  estimateIndexingScaleAndCost,
  extractProjectMemoryIndexInputs,
  FoundationMemorySearchStore,
  splitTextIntoSemanticChunksWithOffsets,
  tokenizeKoreanSearchTerms,
  validateAndResolveEmbeddingMetadata,
  verifyChunkAgainstLiveSource,
} from '../services/memorySearchProvider.ts';
import {
  buildModelSpecificEmbeddingRequest,
  clearEmbeddingCacheForTesting,
  clearLocalRagDiskCacheForTesting,
  deleteEntityIndexOnServer,
  deleteProjectIndexOnServer,
  formatGeminiEmbedding2InstructionText,
  generateServerEmbedding,
  getMemorySourceOnServer,
  getProjectRagStatusOnServer,
  indexMemoryInputOnServer,
  InMemoryMockFirestoreRagBackend,
  isDeprecatedEmbeddingModel,
  isGeminiEmbedding2Model,
  retrieveVerifiedMemoryForWritingOnServer,
  retryFailedProjectIndicesOnServer,
  searchProjectMemoryOnServer,
  setCustomGeminiEmbedContentForTesting,
  setMockFirestoreRagBackendForTesting,
  simulateServerRestartForTesting,
  syncOrRebuildProjectIndexOnServer,
} from '../server/ragEngine.ts';
import {
  clearProjectOwnerRegistryForTesting,
  isServerCloudAuthEnforced,
  registerProjectOwnerForAdminCheck,
  resolveSecureRequestOwner,
  setServerCloudAuthEnforcementForTesting,
  verifyAdminFirestoreProjectOwnership,
} from '../server/authMiddleware.ts';
import {
  MASTER_WRITING_RULES_V1_0_CONTENT,
  NovelForgeAppResultSchema,
  NovelForgeWriterResponseSchema,
  assembleNovelWriterPromptInOrder,
  enforceWritingResultInvariants,
  evaluatePreWritingConflictGate,
} from './aiEngineLogic.ts';
import type {
  Character,
  Episode,
  WritingContextBundle,
} from '../types/novel.ts';

const TEST_OWNER_A = 'test_rag_owner_alpha';
const TEST_OWNER_B = 'test_rag_owner_beta';
const TEST_PROJECT_A = 'test_rag_proj_alpha';
const TEST_PROJECT_B = 'test_rag_proj_beta';

describe('NOVEL FORGE — Phase 3: Persistent Long-Term Memory & RAG Engine Verification', () => {
  after(async () => {
    // Clean up test disk snapshots after suite finishes
    await deleteProjectIndexOnServer({
      ownerId: TEST_OWNER_A,
      projectId: TEST_PROJECT_A,
    });
    await deleteProjectIndexOnServer({
      ownerId: TEST_OWNER_A,
      projectId: TEST_PROJECT_B,
    });
  });

  // ==========================================================================
  // 1. 검색 정확도 (Search Accuracy)
  // ==========================================================================
  describe('1. 검색 정확도 (Search Accuracy)', () => {
    it('1화 사건, 오래전 주인공 부상 기록, 특정 인물 대사, 유의어 의미 검색이 50화 집필 시 정확히 검색되고 없는 사건은 빈 배열을 반환한다', async () => {
      const store = new FoundationMemorySearchStore();

      // Index Episode 1 (Blood oath & protagonist right-arm fracture injury & specific dialogue)
      await store.indexDocument({
        ownerId: TEST_OWNER_A,
        projectId: TEST_PROJECT_A,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_001',
        sourceRevisionId: 'rev_ep_001_v1',
        episodeId: 'ep_001',
        episodeNumber: 1,
        title: '제1화. 잿빛 성소의 혈서와 부러진 검',
        canonStatus: 'CANON',
        characterIds: ['char_kael', 'char_elena'],
        fullText: [
          '검은 눈보라가 몰아치던 잿빛 성소에서 카엘은 오른팔 뼈에 심각한 골절과 내상을 입어 검을 쥐지 못했다.',
          '\n\n',
          '엘레나는 피 흘리는 카엘의 어깨를 붙잡고 단호하게 속삭였다. "붉은 달이 다시 뜨기 전까지는 절대 북부 봉인탑의 열쇠를 열지 마라."',
          '\n\n',
          '두 사람은 고대 성물의 제단 앞에서 영원히 배신하지 않겠다는 피의 서약과 계약을 맺었다.',
        ].join(''),
      });

      // Index Episodes 2..49 as filler history
      for (let epNum = 2; epNum <= 49; epNum++) {
        await store.indexDocument({
          ownerId: TEST_OWNER_A,
          projectId: TEST_PROJECT_A,
          sourceEntityType: 'EPISODE',
          sourceEntityId: `ep_${String(epNum).padStart(3, '0')}`,
          sourceRevisionId: `rev_ep_${epNum}`,
          episodeId: `ep_${String(epNum).padStart(3, '0')}`,
          episodeNumber: epNum,
          title: `제${epNum}화. 황량한 평원 행군 기록`,
          canonStatus: 'CANON',
          characterIds: ['char_kael'],
          fullText: `제${epNum}화 본문. 보급 마차가 황량한 남부 평원을 가로지르며 야영지를 정비하고 보초 교대 근무를 수행했다.`,
        });
      }

      // (A) 1화 사건이 50화 집필 시 검색되는지 확인
      const oathHits = await store.search({
        ownerId: TEST_OWNER_A,
        projectId: TEST_PROJECT_A,
        queryText: '1화 잿빛 성소에서 맺었던 맹세 사건',
        limit: 5,
        searchMode: 'HYBRID',
      });
      assert.ok(oathHits.length > 0, '1화 성소 맹세 사건이 검색되어야 합니다.');
      assert.equal(oathHits[0].chunk.episodeId, 'ep_001');
      assert.equal(oathHits[0].freshnessStatus, 'FRESH');

      // (B) 오래전 주인공 부상 기록이 유의어/의미 기반 질문("카엘이 다쳤던 부위")으로도 검색되는지 확인
      const injuryHits = await store.search({
        ownerId: TEST_OWNER_A,
        projectId: TEST_PROJECT_A,
        queryText: '주인공 카엘이 다쳤던 사건과 통증',
        limit: 5,
        searchMode: 'HYBRID',
      });
      assert.ok(
        injuryHits.some(
          (h) =>
            h.chunk.episodeId === 'ep_001' &&
            h.chunk.content.includes('오른팔 뼈에 심각한 골절과 내상')
        ),
        '정확한 단어가 달라도("다쳤던" -> "골절과 내상") 주인공 부상 기록이 검색되어야 합니다.'
      );

      // (C) 특정 인물 대사가 검색되는지 확인
      const dialogueHits = await store.search({
        ownerId: TEST_OWNER_A,
        projectId: TEST_PROJECT_A,
        queryText: '엘레나 붉은 달 북부 봉인탑 열쇠 대사',
        limit: 5,
        searchMode: 'HYBRID',
      });
      assert.ok(
        dialogueHits.some((h) =>
          h.chunk.content.includes('붉은 달이 다시 뜨기 전까지는 절대 북부 봉인탑의 열쇠를 열지 마라')
        ),
        '특정 인물(엘레나)의 대사가 원문 그대로 검색되어야 합니다.'
      );

      // (D) 존재하지 않는 사건 검색 시 억지 결과를 만들지 않고 빈 결과를 반환하는지 확인
      const nonExistentHits = await store.search({
        ownerId: TEST_OWNER_A,
        projectId: TEST_PROJECT_A,
        queryText: '은하계 우주선 워프 엔진 폭발 레이저 전투',
        limit: 5,
        searchMode: 'HYBRID',
      });
      assert.equal(
        nonExistentHits.length,
        0,
        '존재하지 않는 사건 검색 시 빈 배열([])을 반환해야 합니다.'
      );
    });
  });

  // ==========================================================================
  // 2. 데이터 관리 (Data Management & Persistence Lifecycle)
  // ==========================================================================
  describe('2. 데이터 관리 (Persistence, Re-indexing, Deletion, Idempotency & >500 Chunks)', () => {
    it('서버 재시작 후에도 디스크/영구 저장소 스냅샷에서 색인이 복원되며 동일 원고는 중복 색인되지 않는다', async () => {
      await deleteProjectIndexOnServer({
        ownerId: TEST_OWNER_A,
        projectId: TEST_PROJECT_A,
      });

      const firstIndex = await indexMemoryInputOnServer(
        {
          ownerId: TEST_OWNER_A,
          projectId: TEST_PROJECT_A,
          sourceEntityType: 'EPISODE',
          sourceEntityId: 'ep_persist_1',
          sourceRevisionId: 'rev_persist_v1',
          episodeId: 'ep_persist_1',
          episodeNumber: 1,
          title: '제1화. 심연의 검 각성',
          fullText:
            '심연의 제단에서 흑염의 마검이 깨어나며 카엘의 왼손 손등에 푸른 각인이 새겨졌다.',
          canonStatus: 'CANON',
        },
        { preferDeterministicEmbeddings: true }
      );
      assert.equal(Boolean(firstIndex.skippedAsUnchanged), false);
      assert.equal(firstIndex.document.indexStatus, 'INDEXED');

      // Identical second call must skip duplicate re-indexing
      const duplicateIndex = await indexMemoryInputOnServer(
        {
          ownerId: TEST_OWNER_A,
          projectId: TEST_PROJECT_A,
          sourceEntityType: 'EPISODE',
          sourceEntityId: 'ep_persist_1',
          sourceRevisionId: 'rev_persist_v1',
          episodeId: 'ep_persist_1',
          episodeNumber: 1,
          title: '제1화. 심연의 검 각성',
          fullText:
            '심연의 제단에서 흑염의 마검이 깨어나며 카엘의 왼손 손등에 푸른 각인이 새겨졌다.',
          canonStatus: 'CANON',
        },
        { preferDeterministicEmbeddings: true }
      );
      assert.equal(
        duplicateIndex.skippedAsUnchanged,
        true,
        '동일 리비전과 동일 해시의 원고는 중복 색인되지 않아야 합니다.'
      );

      // Simulate server restart by clearing in-memory stores and hydrating from persistent snapshot
      simulateServerRestartForTesting();
      const searchAfterRestart = await searchProjectMemoryOnServer({
        ownerId: TEST_OWNER_A,
        query: {
          projectId: TEST_PROJECT_A,
          queryText: '흑염의 마검 푸른 각인',
          limit: 5,
        },
        preferDeterministicEmbeddings: true,
      });
      assert.equal(searchAfterRestart.hits.length, 1);
      assert.equal(
        searchAfterRestart.hits[0].chunk.sourceRevisionId,
        'rev_persist_v1'
      );
      assert.ok(
        searchAfterRestart.hits[0].chunk.content.includes('푸른 각인이 새겨졌다')
      );
    });

    it('원고 수정 및 버전 복원 시 최신 내용으로 재색인되고, 원고 삭제 시 검색 결과에서 즉시 제외된다', async () => {
      // Ensure v1 baseline is indexed even if this test is executed in isolation
      await indexMemoryInputOnServer(
        {
          ownerId: TEST_OWNER_A,
          projectId: TEST_PROJECT_A,
          sourceEntityType: 'EPISODE',
          sourceEntityId: 'ep_persist_1',
          sourceRevisionId: 'rev_persist_v1',
          episodeId: 'ep_persist_1',
          episodeNumber: 1,
          title: '제1화. 심연의 검 각성',
          fullText:
            '심연의 제단에서 흑염의 마검이 깨어나며 카엘의 왼손 손등에 푸른 각인이 새겨졌다.',
          canonStatus: 'CANON',
        },
        { preferDeterministicEmbeddings: true }
      );

      // Check STALE detection before re-indexing when live revision changes
      const staleCheck = await searchProjectMemoryOnServer({
        ownerId: TEST_OWNER_A,
        query: {
          projectId: TEST_PROJECT_A,
          queryText: '푸른 각인',
          liveSources: {
            'EPISODE:ep_persist_1': {
              exists: true,
              latestRevisionId: 'rev_persist_v2_edited',
            },
          },
        },
        preferDeterministicEmbeddings: true,
      });
      assert.ok(staleCheck.hits.length > 0, 'STALE 상태의 기존 청크가 검색 결과에서 진단 가능해야 합니다.');
      assert.equal(staleCheck.hits[0].freshnessStatus, 'STALE');
      assert.equal(staleCheck.hits[0].verifiedForWriting, false);

      // Re-index after manuscript edit (v2)
      await indexMemoryInputOnServer(
        {
          ownerId: TEST_OWNER_A,
          projectId: TEST_PROJECT_A,
          sourceEntityType: 'EPISODE',
          sourceEntityId: 'ep_persist_1',
          sourceRevisionId: 'rev_persist_v2_edited',
          episodeId: 'ep_persist_1',
          episodeNumber: 1,
          title: '제1화. 심연의 검 각성 (수정본)',
          fullText:
            '심연의 제단에서 백은의 성검이 깨어나며 카엘의 오른손에 황금빛 문양이 새겨졌다.',
          canonStatus: 'CANON',
        },
        { preferDeterministicEmbeddings: true }
      );

      const searchEdited = await searchProjectMemoryOnServer({
        ownerId: TEST_OWNER_A,
        query: {
          projectId: TEST_PROJECT_A,
          queryText: '백은의 성검 황금빛 문양',
        },
        preferDeterministicEmbeddings: true,
      });
      assert.equal(searchEdited.hits.length, 1);
      assert.equal(
        searchEdited.hits[0].chunk.sourceRevisionId,
        'rev_persist_v2_edited'
      );

      // Old text ("푸른 각인") must no longer be returned
      const searchOldText = await searchProjectMemoryOnServer({
        ownerId: TEST_OWNER_A,
        query: {
          projectId: TEST_PROJECT_A,
          queryText: '푸른 각인',
          searchMode: 'KEYWORD',
        },
        preferDeterministicEmbeddings: true,
      });
      assert.equal(searchOldText.hits.length, 0);

      // Restore previous version (v1_restored)
      await indexMemoryInputOnServer(
        {
          ownerId: TEST_OWNER_A,
          projectId: TEST_PROJECT_A,
          sourceEntityType: 'EPISODE',
          sourceEntityId: 'ep_persist_1',
          sourceRevisionId: 'rev_persist_v1_restored',
          episodeId: 'ep_persist_1',
          episodeNumber: 1,
          title: '제1화. 심연의 검 각성 (복원본)',
          fullText:
            '심연의 제단에서 흑염의 마검이 깨어나며 카엘의 왼손 손등에 푸른 각인이 새겨졌다.',
          canonStatus: 'CANON',
        },
        { preferDeterministicEmbeddings: true }
      );

      const searchRestored = await searchProjectMemoryOnServer({
        ownerId: TEST_OWNER_A,
        query: {
          projectId: TEST_PROJECT_A,
          queryText: '푸른 각인',
        },
        preferDeterministicEmbeddings: true,
      });
      assert.equal(searchRestored.hits.length, 1);
      assert.equal(
        searchRestored.hits[0].chunk.sourceRevisionId,
        'rev_persist_v1_restored'
      );

      // Delete the manuscript and verify it is excluded from search
      await deleteEntityIndexOnServer({
        ownerId: TEST_OWNER_A,
        projectId: TEST_PROJECT_A,
        sourceEntityId: 'ep_persist_1',
        isEpisodeDelete: true,
      });

      const searchAfterDelete = await searchProjectMemoryOnServer({
        ownerId: TEST_OWNER_A,
        query: {
          projectId: TEST_PROJECT_A,
          queryText: '푸른 각인',
        },
        preferDeterministicEmbeddings: true,
      });
      assert.equal(
        searchAfterDelete.hits.length,
        0,
        '삭제된 원고는 검색 결과에서 즉시 제외되어야 합니다.'
      );
    });

    it('500청크 이상 긴 원고가 뒷부분 손실 없이 다중 파트(Multi-part)로 완전 색인되고 마지막 문단까지 정확히 검색된다', async () => {
      const paragraphs: string[] = [];
      for (let i = 1; i <= 540; i++) {
        if (i === 540) {
          paragraphs.push(
            `[제540문단 최종 결말] 태고의 용왕 바하무트가 심연의 왕좌에서 눈을 뜨며 마지막 봉인석을 파괴했다.`
          );
        } else {
          paragraphs.push(
            `[제${i}문단 기록] 북부 원정대 기사단이 설원 계곡의 제${i}초소를 통과하며 마력 결계를 점검했다.`
          );
        }
      }
      const hugeText = paragraphs.join('\n\n');

      const store = new FoundationMemorySearchStore();
      const indexRes = await store.indexDocument({
        ownerId: TEST_OWNER_A,
        projectId: TEST_PROJECT_A,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_huge_540',
        sourceRevisionId: 'rev_huge_v1',
        episodeId: 'ep_huge_540',
        episodeNumber: 99,
        title: '제99화. 540문단 장편 연대기',
        fullText: hugeText,
        maxChunkLength: 65, // Forces 1 chunk per paragraph = 540 chunks (> 500 limit)
        canonStatus: 'CANON',
      });

      const totalIndexedChunks =
        indexRes.chunks.length +
        (indexRes.additionalParts?.reduce((acc, p) => acc + p.chunks.length, 0) ||
          0);

      assert.equal(
        totalIndexedChunks,
        540,
        '540개 청크가 단 1개도 잘리지 않고 모두 색인되어야 합니다.'
      );
      assert.ok(
        indexRes.additionalParts && indexRes.additionalParts.length >= 1,
        '500청크 초과 시 자동으로 파트 문서(additionalParts)가 생성되어야 합니다.'
      );

      // Verify the 540th paragraph at the very end of the manuscript is searchable and has exact offsets
      const tailHits = await store.search({
        ownerId: TEST_OWNER_A,
        projectId: TEST_PROJECT_A,
        queryText: '태고의 용왕 바하무트 마지막 봉인석 파괴',
        limit: 5,
      });
      assert.ok(
        tailHits.length > 0,
        '500번째 이후(540번째 문단) 원고 끝부분 내용도 손실 없이 검색되어야 합니다.'
      );
      const hitChunk = tailHits[0].chunk;
      assert.equal(
        hugeText.slice(hitChunk.sourceStartOffset, hitChunk.sourceEndOffset),
        hitChunk.content,
        '청크의 sourceStartOffset~sourceEndOffset 슬라이스가 원문과 정확히 일치해야 합니다.'
      );
    });

    it('색인 실패(FAILED) 상태 기록 및 실패 항목 재시도(retryFailedProjectIndicesOnServer)가 정상 작동한다', async () => {
      await assert.rejects(
        () =>
          indexMemoryInputOnServer(
            {
              ownerId: TEST_OWNER_A,
              projectId: TEST_PROJECT_A,
              sourceEntityType: 'WORLDBUILDING',
              sourceEntityId: 'wb_fail_test',
              sourceRevisionId: 'rev_wb_1',
              title: '세계관 설정: 실패 복구 테스트',
              fullText: '고대 마탑의 7계위 금지된 공간 전이 마법 법칙.',
              canonStatus: 'CANON',
            },
            {
              preferDeterministicEmbeddings: true,
              simulateFailureForTesting: true,
            }
          ),
        /강제 색인 오류/
      );

      const statusAfterFail = getProjectRagStatusOnServer({
        ownerId: TEST_OWNER_A,
        projectId: TEST_PROJECT_A,
      });
      assert.equal(statusAfterFail.statusCounts.FAILED, 1);

      const retryRes = await retryFailedProjectIndicesOnServer({
        ownerId: TEST_OWNER_A,
        projectId: TEST_PROJECT_A,
        preferDeterministicEmbeddings: true,
      });
      assert.equal(retryRes.retriedCount, 1);
      assert.equal(retryRes.succeededCount, 1);
      assert.equal(retryRes.remainingFailedCount, 0);
    });
  });

  // ==========================================================================
  // 3. 보안 (Security & Ownership Isolation)
  // ==========================================================================
  describe('3. 보안 (Authentication, Spoofing Prevention, Cross-Project & Cross-User Isolation)', () => {
    it('비로그인 Cloud 모드 요청(401) 및 요청 본문의 위조된 ownerId(401/403)를 엄격히 차단한다', async () => {
      // Case 1: Unauthenticated request attempting to pass spoofed ownerId in body
      const spoofedAnonResult = await resolveSecureRequestOwner({
        claimedOwnerId: 'spoofed_victim_uid_999',
      });
      assert.equal(spoofedAnonResult.ok, false);
      assert.equal(spoofedAnonResult.statusCode, 401);

      // Case 2: Unauthenticated request in cloud mode
      const unauthCloudResult = await resolveSecureRequestOwner({
        requireCloudAuth: true,
      });
      assert.equal(unauthCloudResult.ok, false);
      assert.equal(unauthCloudResult.statusCode, 401);

      // Case 3: Authenticated user attempting to spoof another user's ownerId in body
      const crossUserSpoofResult = await resolveSecureRequestOwner({
        preVerifiedUid: TEST_OWNER_A,
        claimedOwnerId: TEST_OWNER_B,
      });
      assert.equal(crossUserSpoofResult.ok, false);
      assert.equal(crossUserSpoofResult.statusCode, 403);
    });

    it('search()와 getSource()가 다른 사용자(ownerId) 및 다른 작품(projectId)의 기억을 절대 반환하지 않는다', async () => {
      const store = new FoundationMemorySearchStore();
      const indexed = await store.indexDocument({
        ownerId: TEST_OWNER_A,
        projectId: TEST_PROJECT_A,
        sourceEntityType: 'CHARACTER',
        sourceEntityId: 'char_secret_a',
        sourceRevisionId: 'rev_sec_1',
        title: '기밀 등장인물: 그림자 황제 아슬란',
        fullText: '아슬란은 황실 지하 미궁의 유일한 생존자이자 암흑 성흔의 계승자다.',
        canonStatus: 'CANON',
      });

      // Same owner, different project -> empty
      const wrongProjectHits = await store.search({
        ownerId: TEST_OWNER_A,
        projectId: TEST_PROJECT_B,
        queryText: '그림자 황제 아슬란 암흑 성흔',
      });
      assert.equal(wrongProjectHits.length, 0);

      // Different owner, same project -> empty
      const wrongOwnerHits = await store.search({
        ownerId: TEST_OWNER_B,
        projectId: TEST_PROJECT_A,
        queryText: '그림자 황제 아슬란 암흑 성흔',
      });
      assert.equal(wrongOwnerHits.length, 0);

      // getSource() with wrong projectId or wrong ownerId -> null
      const sourceWrongProject = await store.getSource(
        TEST_PROJECT_B,
        indexed.document.id,
        TEST_OWNER_A
      );
      assert.equal(sourceWrongProject, null);

      const sourceWrongOwner = await store.getSource(
        TEST_PROJECT_A,
        indexed.document.id,
        TEST_OWNER_B
      );
      assert.equal(sourceWrongOwner, null);

      // Valid owner + valid project -> returns full source reference
      const validSource = await store.getSource(
        TEST_PROJECT_A,
        indexed.document.id,
        TEST_OWNER_A
      );
      assert.ok(validSource !== null);
      assert.equal(validSource?.document.id, indexed.document.id);
    });

    it('클라이언트 프론트엔드 코드에 GEMINI_API_KEY가 노출되지 않는다', () => {
      const clientFiles = [
        path.resolve(process.cwd(), 'src/App.tsx'),
        path.resolve(process.cwd(), 'src/components/MemorySearchView.tsx'),
        path.resolve(process.cwd(), 'src/components/AiWritingPanel.tsx'),
      ];
      for (const file of clientFiles) {
        const content = fs.readFileSync(file, 'utf8');
        assert.equal(
          content.includes('process.env.GEMINI_API_KEY'),
          false,
          `클라이언트 파일(${path.basename(file)})에 process.env.GEMINI_API_KEY가 포함되어서는 안 됩니다.`
        );
      }
    });
  });

  // ==========================================================================
  // 4. 집필 통합 (Novel Writer 12-Step Prompt Injection, Provenance & Schema Guard)
  // ==========================================================================
  describe('4. 집필 통합 (Novel Writer Step 2 Injection, Unverified Exclusion & Phase 2.1/2.5 Compatibility)', () => {
    it('검증된 FRESH 청크만 Novel Writer Step 2 프롬프트에 주입되고 SOURCE_UNVERIFIED/STALE 청크는 확정 근거에서 제외되며 Conflict Gate, Master Writing Rules, 2.1 스키마가 유지된다', async () => {
      await deleteProjectIndexOnServer({
        ownerId: TEST_OWNER_A,
        projectId: TEST_PROJECT_A,
      });

      // Index a valid CANON episode (Episode 1)
      await indexMemoryInputOnServer(
        {
          ownerId: TEST_OWNER_A,
          projectId: TEST_PROJECT_A,
          sourceEntityType: 'EPISODE',
          sourceEntityId: 'ep_canon_1',
          sourceRevisionId: 'rev_ep_canon_1',
          episodeId: 'ep_canon_1',
          episodeNumber: 1,
          title: '제1화. 북부 설원의 서약',
          fullText:
            '카엘은 설원 제단에서 빙결의 반지를 수호하겠다고 엘레나에게 맹세했다.',
          canonStatus: 'CANON',
        },
        { preferDeterministicEmbeddings: true }
      );

      // Index a DRAFT episode that must NOT be injected as confirmed CANON evidence
      await indexMemoryInputOnServer(
        {
          ownerId: TEST_OWNER_A,
          projectId: TEST_PROJECT_A,
          sourceEntityType: 'EPISODE',
          sourceEntityId: 'ep_draft_2',
          sourceRevisionId: 'rev_ep_draft_2',
          episodeId: 'ep_draft_2',
          episodeNumber: 2,
          title: '제2화. 미확정 초안 메모',
          fullText: '카엘이 빙결의 반지를 용암에 던져버리는 미확정 초안 시나리오.',
          canonStatus: 'DRAFT',
        },
        { preferDeterministicEmbeddings: true }
      );

      const mockContext: WritingContextBundle = {
        projectId: TEST_PROJECT_A,
        projectTitle: '창백한 성좌의 연대기',
        projectGenre: '다크 판타지',
        projectSynopsis:
          '몰락한 기사 카엘이 북부 설원의 서약을 지키며 심연에 맞서는 이야기',
        episodeId: 'ep_050',
        episodeNumber: 50,
        episodeTitle: '제50화. 다시 찾은 설원 제단',
        writingMode: 'FULL_EPISODE',
        narrativePerspective: 'THIRD_LIMITED',
        targetEpisodeCharCount: 4000,
        targetSceneCharCount: 2000,
        tolerancePercent: 15,
        plotOutline: '카엘과 엘레나가 1화 설원 제단의 빙결의 반지 맹세를 회상한다.',
        requiredEvents: ['설원 제단 재방문', '빙결의 반지 맹세 확인'],
        forbiddenDevelopments: [],
        canonCharacters: [
          {
            id: 'char_kael',
            name: '카엘',
            role: '주인공',
            affiliation: '북부 수호기사단',
            personality: '과묵하고 책임을 끝까지 지키는 성격',
            abilities: '빙결 검술',
            appearance: '검은 단발과 왼손의 각인',
          },
        ],
        canonWorldbuilding: [
          {
            id: 'wb_ring',
            title: '빙결의 반지',
            category: '성물',
            summary: '북부 봉인탑을 여는 고대 성물',
            rules: '서약자의 피가 아니면 반응하지 않는다.',
          },
        ],
        previousEpisodeSummary: '직전 회차에서 북부 관문을 돌파했다.',
        previousEpisodeTailExcerpt: '눈보라 너머로 제단의 그림자가 보였다.',
        currentManuscript: '',
        activePrompts: [
          {
            profileId: 'prof_master_1',
            promptType: 'CORE_WRITING_RULES',
            title: 'NOVEL FORGE Master Writing Rules',
            versionId: 'v1.0',
            versionLabel: '1.0',
            content: MASTER_WRITING_RULES_V1_0_CONTENT,
          },
        ],
        referencedSources: [],
        missingEvidenceNotes: [],
      };

      const verifiedEvidence = await retrieveVerifiedMemoryForWritingOnServer({
        ownerId: TEST_OWNER_A,
        context: mockContext,
        topK: 5,
        preferDeterministicEmbeddings: true,
      });

      assert.ok(
        verifiedEvidence.length > 0,
        '집필 컨텍스트에 맞는 확정(CANON) 장기 기억이 검색되어야 합니다.'
      );
      assert.ok(
        verifiedEvidence.every(
          (item) =>
            item.canonStatus === 'CANON' &&
            item.freshnessStatus === 'FRESH' &&
            item.verifiedForWriting === true
        ),
        '모든 주입 근거는 CANON 및 FRESH 상태여야 하며 초안(DRAFT)이나 미검증 청크는 제외되어야 합니다.'
      );

      // Assemble Novel Writer prompt with both a FRESH chunk and an artificial SOURCE_UNVERIFIED chunk
      const promptWithRag = assembleNovelWriterPromptInOrder({
        context: {
          ...mockContext,
          retrievedMemoryChunks: [
            ...verifiedEvidence,
            {
              chunkId: 'chk_unverified_ghost',
              documentId: 'doc_unverified_ghost',
              projectId: TEST_PROJECT_A,
              sourceEntityType: 'EPISODE',
              sourceEntityId: 'ep_deleted_999',
              sourceRevisionId: 'rev_deleted',
              episodeId: 'ep_deleted_999',
              sceneId: '',
              title: '삭제된 유령 회차',
              originalText: '이 문장은 출처가 검증되지 않아 절대 프롬프트에 들어가면 안 됩니다.',
              sourceStartOffset: 0,
              sourceEndOffset: 40,
              score: 0.99,
              relevanceScore: 0.99,
              keywordScore: 0.99,
              semanticScore: 0.99,
              matchedTerms: [],
              canonStatus: 'CANON',
              freshnessStatus: 'SOURCE_UNVERIFIED',
              verifiedForWriting: false,
            },
          ],
        },
        scenePlan: {
          sceneNumber: 1,
          title: '설원 제단의 재회',
          purpose: '카엘이 빙결의 반지 서약을 떠올린다.',
          characterIds: ['char_kael'],
          characterNames: ['카엘'],
          emotionalArc: '비장함',
          targetCharCount: 2000,
          connectionToNext: '제단 내부 진입',
          mustIncludeEvent: '빙결의 반지 맹세 확인',
        },
        totalScenesInPlan: 1,
      });

      assert.ok(
        promptWithRag.orderedPrompt.includes('[장기 기억(RAG) 검색 근거') &&
          promptWithRag.orderedPrompt.includes('장기 기억 근거 #1'),
        'Step 2 영역에 장기 기억(RAG) 검색 근거 섹션이 포함되어야 합니다.'
      );
      assert.ok(
        promptWithRag.orderedPrompt.includes(
          '빙결의 반지를 수호하겠다고 엘레나에게 맹세했다'
        ),
        '검증된 1화 원문 발췌가 프롬프트에 주입되어야 합니다.'
      );
      assert.equal(
        promptWithRag.orderedPrompt.includes('이 문장은 출처가 검증되지 않아'),
        false,
        'SOURCE_UNVERIFIED 청크는 확정 집필 프롬프트에서 엄격히 제외되어야 합니다.'
      );

      // Verify Master Writing Rules v1.0, Conflict Gate & Phase 2.1 Schemas remain intact
      const gateResult = evaluatePreWritingConflictGate(mockContext);
      assert.equal(gateResult.blocked, false);
      assert.equal(gateResult.manuscript_state, 'DRAFT_READY');

      const sampleWriterJson = {
        manuscript_state: 'DRAFT_READY' as const,
        manuscript:
          '차가운 눈보라 너머로 잿빛 제단이 모습을 드러냈다. 카엘은 빙결의 반지를 움켜쥐며 오래전 맹세를 되새겼다.',
        issues: [],
        proposals: [],
      };
      const writerSchemaValidation =
        NovelForgeWriterResponseSchema.safeParse(sampleWriterJson);
      assert.equal(writerSchemaValidation.success, true);

      const invariantChecked = enforceWritingResultInvariants(
        {
          runId: 'run_rag_test_1',
          projectId: TEST_PROJECT_A,
          episodeId: 'ep_050',
          sceneId: 'scene_1',
          manuscript: sampleWriterJson.manuscript,
          executionState: 'DRAFT_READY',
          auditState: {
            continuityAuditStatus: 'PASSED',
            styleAuditStatus: 'PASSED',
          },
          canonClassification: 'CANON_CANDIDATE',
          modelId: 'gemini-3.1-pro-preview',
          referencedSources: [
            {
              entityType: 'EPISODE',
              entityId: 'ep_canon_1',
              title: '제1화. 북부 설원의 서약',
              canonStatus: 'CANON',
              revisionId: 'rev_ep_canon_1',
            },
          ],
          referencedMemoryChunks: verifiedEvidence,
          issues: [],
          proposals: [],
          appliedPromptVersionIds: [],
          usageMetadata: {
            promptTokenCount: 500,
            candidatesTokenCount: 300,
            totalTokenCount: 800,
            estimatedCostUsd: 0.001,
            isActualUsage: true,
          },
          status: 'COMPLETED',
          createdAt: new Date().toISOString(),
        },
        {
          ...mockContext,
          retrievedMemoryChunks: verifiedEvidence,
        }
      );
      assert.ok(
        invariantChecked.referencedMemoryChunks &&
          invariantChecked.referencedMemoryChunks.length > 0
      );

      const appResultValidation = NovelForgeAppResultSchema.safeParse({
        manuscript_state: 'DRAFT_READY',
        canon_status: 'CANON_CANDIDATE',
        audit_execution_state: {
          continuity_checker: 'PASSED',
          style_editor: 'PASSED',
        },
        manuscript: sampleWriterJson.manuscript,
        issues: [],
        proposals: [],
      });
      assert.equal(appResultValidation.success, true);
    });
  });

  // ==========================================================================
  // 5. 10화 / 100화 / 1,000화 규모별 벤치마크 (Scale Benchmark)
  // ==========================================================================
  describe('5. 10화 / 100화 / 1,000화 규모별 색인·검색·출처 검증 벤치마크', () => {
    it('10화, 100화, 1,000화 규모에서 색인 시간, 하이브리드 검색 지연시간, Top-K 재현율, 출처 검증률을 측정하고 기준을 통과한다', async () => {
      const scales = [10, 100, 1000] as const;
      const benchmarkRows: {
        episodes: number;
        totalChunks: number;
        indexingTimeMs: number;
        avgSearchLatencyMs: number;
        topKRecallRate: string;
        provenanceVerifiedRate: string;
        estimatedTokens: number;
        estimatedCostUsd: number;
      }[] = [];

      for (const epCount of scales) {
        const store = new FoundationMemorySearchStore();
        const episodes: Episode[] = [];
        const characters: Character[] = [
          {
            id: 'char_kael',
            ownerId: TEST_OWNER_A,
            projectId: `bench_proj_${epCount}`,
            name: '카엘',
            role: '주인공',
            affiliation: '북부 수호기사단',
            appearance: '검은 단발, 푸른 문양',
            personality: '침착하고 신중한 지휘관',
            background: '잿빛 성소의 생존자',
            abilities: '심연의 흑염 검술',
            status: 'confirmed',
            canonStatus: 'CANON',
            linkedEpisodeIds: [],
            linkedWorldbuildingIds: [],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ];

        for (let i = 1; i <= epCount; i++) {
          let specialParagraph = `제${i}화 일반 행군 기록. 북부 원정대가 제${i}보급기지를 지나며 장비와 마력을 점검했다.`;
          if (i === 1) {
            specialParagraph =
              '제1화 핵심 사건: 잿빛 성소에서 카엘이 오른팔 골절과 중상을 입고 엘레나와 피의 맹세를 맺었다.';
          } else if (i === Math.floor(epCount / 2)) {
            specialParagraph = `제${i}화 핵심 사건: 심연의 군주 벨리알이 고대 흑요석 성문을 파괴하며 첫 번째 재앙의 나팔을 불었다.`;
          } else if (i === epCount) {
            specialParagraph = `제${i}화 핵심 사건: 천공의 부유성 아크투르스가 개방되며 황금 성배의 진실이 밝혀졌다.`;
          }

          episodes.push({
            id: `ep_bench_${i}`,
            ownerId: TEST_OWNER_A,
            projectId: `bench_proj_${epCount}`,
            episodeNumber: i,
            title: `제${i}화. 북부 연대기 제${i}장`,
            content: `${specialParagraph}\n\n이어지는 장면에서 기사단은 전열을 가다듬고 다음 관문으로 이동했다.`,
            synopsis: `${specialParagraph.slice(0, 80)}`,
            authorNote: '',
            status: 'confirmed',
            canonStatus: 'CANON',
            charCountWithSpaces: specialParagraph.length + 50,
            charCountWithoutSpaces: specialParagraph.length + 35,
            latestRevisionId: `rev_bench_${i}`,
            linkedCharacterIds: ['char_kael'],
            linkedWorldbuildingIds: [],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          });
        }

        const inputs = extractProjectMemoryIndexInputs({
          ownerId: TEST_OWNER_A,
          projectId: `bench_proj_${epCount}`,
          characters,
          worldbuilding: [],
          episodes,
          includeDrafts: false,
        });

        const costEst = estimateIndexingScaleAndCost(
          `bench_proj_${epCount}`,
          inputs
        );

        const idxStart = performance.now();
        let totalChunks = 0;
        for (const inp of inputs) {
          const res = await store.indexDocument(inp);
          totalChunks += res.chunks.length;
        }
        const indexingTimeMs = Number((performance.now() - idxStart).toFixed(2));

        // Execute 3 target queries (Episode 1 injury/oath, Mid-episode Belial gate, Final-episode Arcturus grail)
        const queries = [
          {
            q: '잿빛 성소에서 다쳤던 골절 부상과 피의 서약',
            expectedEpId: 'ep_bench_1',
          },
          {
            q: '심연의 군주 벨리알 흑요석 성문 파괴 나팔',
            expectedEpId: `ep_bench_${Math.floor(epCount / 2)}`,
          },
          {
            q: '천공의 부유성 아크투르스 개방 황금 성배',
            expectedEpId: `ep_bench_${epCount}`,
          },
        ];

        let totalSearchMs = 0;
        let recallSuccess = 0;
        let provenanceSuccess = 0;

        for (const item of queries) {
          const sStart = performance.now();
          const hits = await store.search({
            ownerId: TEST_OWNER_A,
            projectId: `bench_proj_${epCount}`,
            queryText: item.q,
            limit: 5,
            searchMode: 'HYBRID',
          });
          totalSearchMs += performance.now() - sStart;

          const matched = hits.some(
            (h) => h.chunk.episodeId === item.expectedEpId
          );
          if (matched) recallSuccess += 1;
          if (
            hits.length > 0 &&
            hits.every(
              (h) =>
                h.freshnessStatus === 'FRESH' &&
                Boolean(h.chunk.documentId) &&
                Boolean(h.chunk.sourceRevisionId)
            )
          ) {
            provenanceSuccess += 1;
          }
        }

        const avgSearchLatencyMs = Number(
          (totalSearchMs / queries.length).toFixed(2)
        );
        assert.equal(
          recallSuccess,
          queries.length,
          `${epCount}화 규모 벤치마크에서 핵심 사건 3건 모두 Top-5 내에 검색되어야 합니다.`
        );

        benchmarkRows.push({
          episodes: epCount,
          totalChunks,
          indexingTimeMs,
          avgSearchLatencyMs,
          topKRecallRate: `${Math.round((recallSuccess / queries.length) * 100)}% (${recallSuccess}/${queries.length})`,
          provenanceVerifiedRate: `${Math.round((provenanceSuccess / queries.length) * 100)}% (${provenanceSuccess}/${queries.length})`,
          estimatedTokens: costEst.estimatedTokenCount,
          estimatedCostUsd: costEst.estimatedCostUsd,
        });
      }

      console.log(
        '\n[BENCHMARK_SUMMARY_JSON]',
        JSON.stringify(benchmarkRows, null, 2)
      );
      assert.equal(benchmarkRows.length, 3);
    });
  });

  // ==========================================================================
  // 6. 추가 필수 안정성 조건 검증 (Section 13: 13-1, 13-2, 13-3, 13-4)
  // ==========================================================================
  describe('6. 추가 필수 안정성 조건 검증 (Section 13-1 ~ 13-4)', () => {
    it('[13-1] Firebase Admin SDK 권한 검증: 요청된 ownerId와 경로가 일치해도 실제 Firestore 프로젝트 소유권과 불일치하면 차단', async () => {
      clearProjectOwnerRegistryForTesting();
      // 실제 Firestore 프로젝트 'proj_victim_secret'의 소유자는 TEST_OWNER_A로 등록
      registerProjectOwnerForAdminCheck('proj_victim_secret', TEST_OWNER_A);

      // 공격자(TEST_OWNER_B)가 자신의 UID와 일치하는 claimedOwnerId(TEST_OWNER_B)를 경로/바디에 넣어 요청하더라도
      // 실제 Firestore의 proj_victim_secret 소유자가 TEST_OWNER_A이므로 403 차단되어야 함
      const crossProjectCheck = await verifyAdminFirestoreProjectOwnership({
        authenticatedUid: TEST_OWNER_B,
        claimedOwnerId: TEST_OWNER_B,
        projectId: 'proj_victim_secret',
      });
      assert.equal(crossProjectCheck.ok, false);
      assert.equal(crossProjectCheck.statusCode, 403);
      assert.match(
        crossProjectCheck.error || '',
        /ADMIN_SDK_OWNERSHIP_MISMATCH/
      );

      // 서버 측 RAG 검색·색인·삭제 API 직접 호출 시에도 거부되는지 검증
      await assert.rejects(
        async () => {
          await searchProjectMemoryOnServer({
            ownerId: TEST_OWNER_B,
            query: {
              ownerId: TEST_OWNER_B,
              projectId: 'proj_victim_secret',
              queryText: '기밀 세계관 설정',
            },
          });
        },
        /ADMIN_SDK_OWNERSHIP_MISMATCH/
      );

      await assert.rejects(
        async () => {
          await indexMemoryInputOnServer({
            ownerId: TEST_OWNER_B,
            projectId: 'proj_victim_secret',
            sourceEntityType: 'WORLDBUILDING',
            sourceEntityId: 'lore_hijack',
            title: '불법 색인 시도',
            fullText: '권한 없는 프로젝트에 색인 쓰기 시도',
            sourceRevisionId: 'rev_hijack_1',
            canonStatus: 'CANON',
            embeddingModelId: DETERMINISTIC_TEST_EMBEDDING_MODEL_ID,
            embeddingGenerationMode: 'DETERMINISTIC_TEST',
          });
        },
        /ADMIN_SDK_OWNERSHIP_MISMATCH/
      );

      await assert.rejects(
        async () => {
          await deleteProjectIndexOnServer({
            ownerId: TEST_OWNER_B,
            projectId: 'proj_victim_secret',
          });
        },
        /ADMIN_SDK_OWNERSHIP_MISMATCH/
      );

      // 정당한 소유자(TEST_OWNER_A)는 정상 통과
      const validOwnerCheck = await verifyAdminFirestoreProjectOwnership({
        authenticatedUid: TEST_OWNER_A,
        claimedOwnerId: TEST_OWNER_A,
        projectId: 'proj_victim_secret',
      });
      assert.equal(validOwnerCheck.ok, true);
      assert.equal(validOwnerCheck.statusCode, 200);
      clearProjectOwnerRegistryForTesting();
    });

    it('[13-2] 활성 색인 버전의 원자적 전환, 삭제 대기 즉시 차단, 동시 색인·동시 삭제·서버 재시작 안전성 검증', async () => {
      const atomicProjId = 'test_rag_proj_section13_atomic';
      await deleteProjectIndexOnServer({
        ownerId: TEST_OWNER_A,
        projectId: atomicProjId,
      });

      // 1) 초기 정상 버전(v1) 색인
      const v1Result = await indexMemoryInputOnServer(
        {
          ownerId: TEST_OWNER_A,
          projectId: atomicProjId,
          sourceEntityType: 'EPISODE',
          sourceEntityId: 'ep_atomic_1',
          episodeId: 'ep_atomic_1',
          episodeNumber: 1,
          title: '제1화 붉은 성좌의 계약',
          fullText:
            '강현우는 붉은 성좌와 첫 번째 피의 계약을 맺고 심연의 열쇠를 수령했다.',
          sourceRevisionId: 'rev_atomic_v1',
          canonStatus: 'CANON',
        },
        { preferDeterministicEmbeddings: true }
      );
      assert.equal(Boolean(v1Result.skippedAsUnchanged), false);
      const genV1 = v1Result.document.indexGeneration!;
      assert.ok(genV1 >= 1);

      // 2) 색인 갱신(v2) 도중(onDuringIndexingHook)에는 기존 정상 버전(v1)이 그대로 검색되어야 함
      let midIndexSearchHitsCount = 0;
      let midIndexActiveRevision = '';

      const v2Result = await indexMemoryInputOnServer(
        {
          ownerId: TEST_OWNER_A,
          projectId: atomicProjId,
          sourceEntityType: 'EPISODE',
          sourceEntityId: 'ep_atomic_1',
          episodeId: 'ep_atomic_1',
          episodeNumber: 1,
          title: '제1화 푸른 성좌의 재계약',
          fullText:
            '강현우는 푸른 성좌와 두 번째 영혼 계약을 맺고 천공의 방패를 수령했다.',
          sourceRevisionId: 'rev_atomic_v2',
          canonStatus: 'CANON',
          onDuringIndexingHook: async () => {
            // 아직 v2 검증 및 원자적 전환이 끝나기 전 시점 -> 기존 정상 버전 v1('붉은 성좌')이 검색되어야 함
            const midSearch = await searchProjectMemoryOnServer({
              ownerId: TEST_OWNER_A,
              query: {
                projectId: atomicProjId,
                queryText: '붉은 성좌 심연의 열쇠',
              },
              preferDeterministicEmbeddings: true,
            });
            midIndexSearchHitsCount = midSearch.hits.length;
            midIndexActiveRevision =
              midSearch.hits[0]?.chunk.sourceRevisionId || '';
          },
        },
        { preferDeterministicEmbeddings: true }
      );

      assert.ok(
        midIndexSearchHitsCount > 0,
        '신규 색인 갱신 중에도 기존 정상 버전(v1)이 끊김 없이 검색되어야 합니다.'
      );
      assert.equal(midIndexActiveRevision, 'rev_atomic_v1');

      // v2 완료 후에는 원자적으로 v2('푸른 성좌')로 전환되고 구버전(v1)은 검색되지 않아야 함
      const genV2 = v2Result.document.indexGeneration!;
      assert.ok(genV2 > genV1);

      const afterV2OldQuery = await searchProjectMemoryOnServer({
        ownerId: TEST_OWNER_A,
        query: {
          projectId: atomicProjId,
          queryText: '붉은 성좌 심연의 열쇠',
          searchMode: 'KEYWORD',
        },
        preferDeterministicEmbeddings: true,
      });
      assert.equal(
        afterV2OldQuery.hits.some(
          (h) => h.chunk.sourceRevisionId === 'rev_atomic_v1'
        ),
        false,
        '활성 버전 전환 이후 구버전(v1) 청크는 검색에서 완전히 제외되어야 합니다.'
      );

      const afterV2NewQuery = await searchProjectMemoryOnServer({
        ownerId: TEST_OWNER_A,
        query: {
          projectId: atomicProjId,
          queryText: '푸른 성좌 천공의 방패',
        },
        preferDeterministicEmbeddings: true,
      });
      assert.ok(afterV2NewQuery.hits.length > 0);
      assert.equal(
        afterV2NewQuery.hits[0].chunk.sourceRevisionId,
        'rev_atomic_v2'
      );

      // 3) 색인 검증 실패(simulateVerificationFailure) 시 기존 정상 버전(v2)이 손상 없이 유지되는지 검증
      await assert.rejects(
        async () => {
          await indexMemoryInputOnServer(
            {
              ownerId: TEST_OWNER_A,
              projectId: atomicProjId,
              sourceEntityType: 'EPISODE',
              sourceEntityId: 'ep_atomic_1',
              episodeId: 'ep_atomic_1',
              episodeNumber: 1,
              title: '제1화 손상된 색인 시도',
              fullText: '검증 실패로 롤백되어야 하는 원고',
              sourceRevisionId: 'rev_atomic_v3_bad',
              canonStatus: 'CANON',
              simulateVerificationFailure: true,
            },
            { preferDeterministicEmbeddings: true }
          );
        },
        /INDEX_VERIFICATION_FAILED/
      );

      const stillHealthyV2 = await searchProjectMemoryOnServer({
        ownerId: TEST_OWNER_A,
        query: {
          projectId: atomicProjId,
          queryText: '푸른 성좌 천공의 방패',
        },
        preferDeterministicEmbeddings: true,
      });
      assert.ok(
        stillHealthyV2.hits.length > 0,
        '신규 색인 검증 실패 시 기존 정상 버전(v2)이 그대로 유지되어야 합니다.'
      );
      assert.equal(
        stillHealthyV2.hits[0].chunk.sourceRevisionId,
        'rev_atomic_v2'
      );

      // 4) 동시 색인(Stale Writer) 방지 검증: 느린 구버전 색인이 진행 중일 때 더 최신 색인이 먼저 커밋되면 구버전 전환은 거부됨
      const isolatedStore = new FoundationMemorySearchStore();
      await isolatedStore.indexDocument({
        ownerId: TEST_OWNER_A,
        projectId: atomicProjId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_race_1',
        title: '초기 화',
        fullText: '초기 원고 데이터입니다.',
        sourceRevisionId: 'rev_race_v1',
        canonStatus: 'CANON',
        embeddingModelId: DETERMINISTIC_TEST_EMBEDDING_MODEL_ID,
        embeddingGenerationMode: 'DETERMINISTIC_TEST',
      });

      await assert.rejects(
        async () => {
          await isolatedStore.indexDocument({
            ownerId: TEST_OWNER_A,
            projectId: atomicProjId,
            sourceEntityType: 'EPISODE',
            sourceEntityId: 'ep_race_1',
            title: '느린 구버전 쓰기',
            fullText: '오래된 동시 색인 요청 데이터입니다.',
            sourceRevisionId: 'rev_race_stale',
            canonStatus: 'CANON',
            embeddingModelId: DETERMINISTIC_TEST_EMBEDDING_MODEL_ID,
            embeddingGenerationMode: 'DETERMINISTIC_TEST',
            onDuringIndexingHook: async () => {
              // 느린 색인이 진행되는 도중에 더 최신 색인(rev_race_latest)이 먼저 완료됨
              await isolatedStore.indexDocument({
                ownerId: TEST_OWNER_A,
                projectId: atomicProjId,
                sourceEntityType: 'EPISODE',
                sourceEntityId: 'ep_race_1',
                title: '최신 색인 쓰기',
                fullText: '가장 최신의 확정 원고 데이터입니다.',
                sourceRevisionId: 'rev_race_latest',
                canonStatus: 'CANON',
                embeddingModelId: DETERMINISTIC_TEST_EMBEDDING_MODEL_ID,
                embeddingGenerationMode: 'DETERMINISTIC_TEST',
              });
            },
          });
        },
        /STALE_INDEX_GENERATION_REJECTED/
      );

      const raceHits = await isolatedStore.search({
        ownerId: TEST_OWNER_A,
        projectId: atomicProjId,
        queryText: '확정 원고 데이터',
      });
      assert.ok(raceHits.length > 0);
      assert.equal(
        raceHits[0].chunk.sourceRevisionId,
        'rev_race_latest',
        '동시 색인 경합 시 오래된 색인이 최신 활성 버전을 덮어쓰면 안 됩니다.'
      );

      // 5) 삭제 대기(PENDING_DELETE) 표시 및 물리 삭제 완료 전 즉시 검색 차단 검증
      let hitsDuringPendingDelete = -1;
      await deleteEntityIndexOnServer({
        ownerId: TEST_OWNER_A,
        projectId: atomicProjId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_atomic_1',
        onDuringDeleteHook: async () => {
          // 물리 데이터가 삭제되기 직전(PENDING_DELETE 상태)에 검색 호출
          const res = await searchProjectMemoryOnServer({
            ownerId: TEST_OWNER_A,
            query: {
              projectId: atomicProjId,
              queryText: '푸른 성좌 천공의 방패',
              includeDrafts: true,
            },
            preferDeterministicEmbeddings: true,
          });
          hitsDuringPendingDelete = res.hits.length;
        },
      });
      assert.equal(
        hitsDuringPendingDelete,
        0,
        '삭제 요청 시 물리적 데이터 삭제가 끝나기 전이라도 PENDING_DELETE 상태에서 즉시 검색이 차단되어야 합니다.'
      );

      // 6) 서버 재시작(simulateServerRestartForTesting) 이후에도 삭제된 색인이나 구버전 색인이 부활하지 않는지 검증
      simulateServerRestartForTesting();
      const afterRestartSearch = await searchProjectMemoryOnServer({
        ownerId: TEST_OWNER_A,
        query: {
          projectId: atomicProjId,
          queryText: '푸른 성좌 천공의 방패',
          includeDrafts: true,
        },
        preferDeterministicEmbeddings: true,
      });
      assert.equal(
        afterRestartSearch.hits.length,
        0,
        '서버 재시작 후에도 삭제된 색인이 다시 활성화되면 안 됩니다.'
      );

      await deleteProjectIndexOnServer({
        ownerId: TEST_OWNER_A,
        projectId: atomicProjId,
      });
    });

    it('[13-3] 실제 임베딩(LIVE_API)과 테스트 임베딩(DETERMINISTIC_TEST)의 엄격한 분리 및 허위 성공 보고 차단 검증', async () => {
      const sepProjId = 'test_rag_proj_section13_embedding_sep';
      await deleteProjectIndexOnServer({
        ownerId: TEST_OWNER_A,
        projectId: sepProjId,
      });

      // 1) 결정적 테스트 임베딩에 'gemini-embedding-2' 모델 ID 부여 시 즉시 예외 발생 검증
      assert.throws(
        () => {
          validateAndResolveEmbeddingMetadata({
            requestedMode: 'DETERMINISTIC_TEST',
            requestedModelId: 'gemini-embedding-2',
            requestedDimension: 768,
            hasPrecomputedVectors: false,
          });
        },
        /EMBEDDING_MODE_MODEL_CONFLICT/
      );

      assert.throws(
        () => {
          validateAndResolveEmbeddingMetadata({
            requestedMode: 'LIVE_API',
            requestedModelId: DETERMINISTIC_TEST_EMBEDDING_MODEL_ID,
            requestedDimension: 768,
            hasPrecomputedVectors: true,
          });
        },
        /EMBEDDING_MODE_MODEL_CONFLICT/
      );

      // 2) LIVE_API 벡터와 DETERMINISTIC_TEST 벡터 간 코사인 유사도 혼합 차단 검증
      assert.equal(
        areEmbeddingsVectorSpaceCompatible({
          chunkMode: 'LIVE_API',
          chunkModelId: 'gemini-embedding-2',
          chunkDimension: 768,
          queryMode: 'DETERMINISTIC_TEST',
          queryModelId: DETERMINISTIC_TEST_EMBEDDING_MODEL_ID,
          queryDimension: 768,
        }),
        false,
        'LIVE_API 벡터와 DETERMINISTIC_TEST 벡터는 서로 다른 벡터 공간이므로 혼합 계산이 차단되어야 합니다.'
      );

      // 3) 결정적 모드에서 generateServerEmbedding 호출 시 정직한 메타데이터 반환 검증
      const generated = await generateServerEmbedding(
        '심연의 군주와 성좌의 계약',
        { preferDeterministicOnly: true }
      );
      assert.equal(generated.embeddingGenerationMode, 'DETERMINISTIC_TEST');
      assert.equal(
        generated.modelId,
        DETERMINISTIC_TEST_EMBEDDING_MODEL_ID,
        '결정적 테스트 벡터에는 절대로 gemini-embedding-2 모델 ID가 부여되면 안 됩니다.'
      );
      assert.equal(generated.usedLiveGeminiApi, false);

      // 4) 결정적 테스트 임베딩으로 색인 후 검색 시 cloudSemanticSearchSucceeded가 false로 정직하게 보고되는지 검증
      await indexMemoryInputOnServer(
        {
          ownerId: TEST_OWNER_A,
          projectId: sepProjId,
          sourceEntityType: 'WORLDBUILDING',
          sourceEntityId: 'lore_sep_1',
          title: '아르카나 마탑의 봉인 규칙',
          fullText:
            '아르카나 마탑의 7층 봉인은 오직 고대 룬 문자 열쇠로만 해제할 수 있다.',
          sourceRevisionId: 'rev_sep_1',
          canonStatus: 'CANON',
          embeddingModelId: DETERMINISTIC_TEST_EMBEDDING_MODEL_ID,
          embeddingGenerationMode: 'DETERMINISTIC_TEST',
        },
        { preferDeterministicEmbeddings: true }
      );

      const searchRes = await searchProjectMemoryOnServer({
        ownerId: TEST_OWNER_A,
        query: {
          projectId: sepProjId,
          queryText: '아르카나 마탑 고대 룬 문자 열쇠',
        },
        preferDeterministicEmbeddings: true,
      });

      assert.ok(searchRes.hits.length > 0);
      assert.equal(
        searchRes.hits[0].chunk.embeddingGenerationMode,
        'DETERMINISTIC_TEST'
      );
      assert.equal(
        searchRes.hits[0].chunk.embeddingModelId,
        DETERMINISTIC_TEST_EMBEDDING_MODEL_ID
      );
      assert.equal(
        searchRes.cloudSemanticSearchSucceeded,
        false,
        '실제 LIVE_API 임베딩이 생성되지 않은 경우 클라우드 시맨틱 검색 성공(cloudSemanticSearchSucceeded)으로 허위 보고하면 안 됩니다.'
      );

      const statusRes = getProjectRagStatusOnServer({
        ownerId: TEST_OWNER_A,
        projectId: sepProjId,
      });
      assert.equal(
        statusRes.cloudSemanticSearchReady,
        false,
        'DETERMINISTIC_TEST 청크만 존재하는 경우 cloudSemanticSearchReady는 false여야 합니다.'
      );
      assert.equal(statusRes.deterministicTestChunkCount > 0, true);
      assert.equal(statusRes.liveEmbeddedChunkCount, 0);

      await deleteProjectIndexOnServer({
        ownerId: TEST_OWNER_A,
        projectId: sepProjId,
      });
    });

    it('[13-4] 1,200개 이상 청크 경계 테스트(Mock Firestore 에뮬레이터 기반) 및 .novelforge_rag_cache Git 추적 제거 검증', async () => {
      const boundaryProjId = 'test_rag_proj_section13_1260_boundary';
      const mockFirestore = new InMemoryMockFirestoreRagBackend();
      mockFirestore.seedProjectDoc({
        userPathUid: TEST_OWNER_A,
        projectId: boundaryProjId,
        docOwnerId: TEST_OWNER_A,
      });
      setMockFirestoreRagBackendForTesting(mockFirestore);

      try {
        // 1,260개 청크를 가지는 대용량 원고 생성 (500개 멀티파트 경계 3개 분할: 500 + 500 + 260 = 1,260 청크)
        const paragraphs: string[] = [];
        for (let i = 1; i <= 1260; i++) {
          paragraphs.push(
            `[제${i}절_고유식별자_${i}] 강현우는 ${i}번째 봉인석을 돌파하며 심연의 기록을 해독했다.`
          );
        }
        const massiveManuscript = paragraphs.join('\n\n');

        const indexed = await indexMemoryInputOnServer(
          {
            ownerId: TEST_OWNER_A,
            projectId: boundaryProjId,
            sourceEntityType: 'EPISODE',
            sourceEntityId: 'ep_massive_1260',
            episodeId: 'ep_massive_1260',
            episodeNumber: 999,
            title: '제999화 대심연 1260절 연대기',
            fullText: massiveManuscript,
            maxChunkLength: 65, // 각 문단이 정확히 1개 청크로 분할되도록 설정 -> 총 1,260개 청크
            sourceRevisionId: 'rev_massive_1260_v1',
            canonStatus: 'CANON',
            embeddingModelId: DETERMINISTIC_TEST_EMBEDDING_MODEL_ID,
            embeddingGenerationMode: 'DETERMINISTIC_TEST',
          },
          { preferDeterministicEmbeddings: true }
        );

        const allDocs = [
          indexed.document,
          ...(indexed.additionalParts?.map((p) => p.document) || []),
        ];
        const allChunks = [
          ...indexed.chunks,
          ...(indexed.additionalParts?.flatMap((p) => p.chunks) || []),
        ];

        // 1) 1,260개 청크 및 3개 멀티파트 문서(500 + 500 + 260) 분할 검증
        assert.ok(
          allChunks.length >= 1200,
          `청크 개수는 최소 1,200개 이상이어야 합니다 (실제: ${allChunks.length}개).`
        );
        assert.equal(allChunks.length, 1260);
        assert.equal(
          allDocs.length,
          3,
          '1,260개 청크는 문서당 500개 제한에 따라 3개의 멀티파트 문서(500 + 500 + 260)로 분할되어야 합니다.'
        );
        assert.equal(allDocs[0].chunkCount, 500);
        assert.equal(allDocs[1].chunkCount, 500);
        assert.equal(allDocs[2].chunkCount, 260);

        // 2) Mock Firestore 에뮬레이터에 500-op 배치 제한을 준수하며 누락 없이 모두 기록되었는지 검증
        const basePath = `users/${TEST_OWNER_A}/projects/${boundaryProjId}`;
        let storedDocCount = 0;
        let storedChunkCount = 0;
        for (const key of mockFirestore.documentsByPath.keys()) {
          if (key.startsWith(`${basePath}/memoryDocuments/`)) {
            storedDocCount += 1;
          } else if (key.startsWith(`${basePath}/memoryChunks/`)) {
            storedChunkCount += 1;
          }
        }

        assert.equal(
          storedDocCount,
          3,
          '기존 syncDocsAndChunksToCloudFirestore의 400개 하드 캡 없이 모든 문서(3개)가 에뮬레이터에 저장되어야 합니다.'
        );
        assert.equal(
          storedChunkCount,
          1260,
          '1,260개 청크 전체가 누락 없이 Mock Firestore 백엔드에 저장되어야 합니다.'
        );
        assert.ok(
          mockFirestore.committedBatchCount >= 3,
          'Firestore 배치당 500개 연산 제한을 준수하기 위해 최소 3회 이상 멀티 배치 커밋이 수행되어야 합니다.'
        );
        assert.equal(
          mockFirestore.transactionCommitCount,
          1,
          '모든 청크 쓰기 검증 후 활성 버전 매니페스트가 Firestore 트랜잭션으로 원자적 커밋되어야 합니다.'
        );
        const manifest = mockFirestore.getManifest(
          TEST_OWNER_A,
          boundaryProjId
        );
        assert.equal(
          manifest?.activeGenerationCounter,
          indexed.document.indexGeneration
        );

        // 3) 1,260번째 마지막 경계 청크도 정확히 검색 및 출처 검증되는지 확인
        const boundaryHit = await searchProjectMemoryOnServer({
          ownerId: TEST_OWNER_A,
          query: {
            projectId: boundaryProjId,
            queryText: '제1260절_고유식별자_1260 1260번째 봉인석',
            limit: 5,
          },
          preferDeterministicEmbeddings: true,
        });
        assert.ok(boundaryHit.hits.length > 0);
        assert.match(
          boundaryHit.hits[0].chunk.content,
          /제1260절_고유식별자_1260/
        );
        assert.equal(
          boundaryHit.hits[0].chunk.documentId,
          allDocs[2].id,
          '1,260번째 청크는 3번째 멀티파트 문서(part3)를 정확히 가리켜야 합니다.'
        );
      } finally {
        setMockFirestoreRagBackendForTesting(null);
        await deleteProjectIndexOnServer({
          ownerId: TEST_OWNER_A,
          projectId: boundaryProjId,
        });
      }

      // 4) 워크스페이스 내 .novelforge_rag_cache 디렉토리가 제거되었고 .gitignore에 등록되었는지 검증
      const workspaceCacheDir = path.resolve(
        process.cwd(),
        '.novelforge_rag_cache'
      );
      assert.equal(
        fs.existsSync(workspaceCacheDir),
        false,
        '워크스페이스 루트의 .novelforge_rag_cache 디렉토리는 제거되어 Git 추적 대상에서 제외되어야 합니다.'
      );

      const gitignoreContent = fs.readFileSync(
        path.resolve(process.cwd(), '.gitignore'),
        'utf-8'
      );
      assert.match(
        gitignoreContent,
        /\.novelforge_rag_cache/,
        '.gitignore에 .novelforge_rag_cache가 등록되어 있어야 합니다.'
      );
    });
  });

  // ==========================================================================
  // 7. Phase 3.1.1 — P0-1 ~ P1-5 RAG Critical Fixes & Cloud Data Integrity
  // ==========================================================================
  describe('7. Phase 3.1.1 — P0-1 ~ P1-5 RAG Critical Fixes & Cloud Data Integrity 검증', () => {
    it('[P0-1] Firestore Vector Search 실제 결합(RRF + Score Fusion), 입력 벡터 순위 역전 시 최종 순위 역전, N+1 없는 배치 조회 검증', async () => {
      const vecProjId = 'test_rag_proj_p0_1_vector_rrf';
      const mockFirestore = new InMemoryMockFirestoreRagBackend();
      mockFirestore.seedProjectDoc({
        userPathUid: TEST_OWNER_A,
        projectId: vecProjId,
        docOwnerId: TEST_OWNER_A,
      });
      setMockFirestoreRagBackendForTesting(mockFirestore);

      // Mock Live Gemini Embedding 2 (768차원)
      setCustomGeminiEmbedContentForTesting(async ({ model, contents, config }) => {
        assert.equal(model, 'gemini-embedding-2');
        assert.equal(config?.outputDimensionality, 768);
        assert.equal('taskType' in (config || {}), false);
        assert.equal('title' in (config || {}), false);
        const vec = computeDeterministicSemanticEmbedding(contents, 768);
        return { embeddings: [{ values: vec }] };
      });

      try {
        // 동일한 키워드 가중치를 갖도록 3개의 확정 에피소드(Chunk A, B, C)를 LIVE_API 임베딩으로 색인
        const indexedA = await indexMemoryInputOnServer({
          ownerId: TEST_OWNER_A,
          projectId: vecProjId,
          sourceEntityType: 'EPISODE',
          sourceEntityId: 'ep_vec_a',
          episodeId: 'ep_vec_a',
          episodeNumber: 1,
          title: '제1화 고대 제단 기록 A',
          fullText: '심연의 열쇠와 고대 제단의 계약 기록 알파 문단입니다.',
          sourceRevisionId: 'rev_vec_a_1',
          canonStatus: 'CANON',
          embeddingModelId: 'gemini-embedding-2',
          embeddingGenerationMode: 'LIVE_API',
        });

        const indexedB = await indexMemoryInputOnServer({
          ownerId: TEST_OWNER_A,
          projectId: vecProjId,
          sourceEntityType: 'EPISODE',
          sourceEntityId: 'ep_vec_b',
          episodeId: 'ep_vec_b',
          episodeNumber: 2,
          title: '제2화 고대 제단 기록 B',
          fullText: '심연의 열쇠와 고대 제단의 계약 기록 베타 문단입니다.',
          sourceRevisionId: 'rev_vec_b_1',
          canonStatus: 'CANON',
          embeddingModelId: 'gemini-embedding-2',
          embeddingGenerationMode: 'LIVE_API',
        });

        const indexedC = await indexMemoryInputOnServer({
          ownerId: TEST_OWNER_A,
          projectId: vecProjId,
          sourceEntityType: 'EPISODE',
          sourceEntityId: 'ep_vec_c',
          episodeId: 'ep_vec_c',
          episodeNumber: 3,
          title: '제3화 고대 제단 기록 C',
          fullText: '심연의 열쇠와 고대 제단의 계약 기록 감마 문단입니다.',
          sourceRevisionId: 'rev_vec_c_1',
          canonStatus: 'CANON',
          embeddingModelId: 'gemini-embedding-2',
          embeddingGenerationMode: 'LIVE_API',
        });

        const chunkIdA = indexedA.chunks[0].id;
        const chunkIdB = indexedB.chunks[0].id;
        const chunkIdC = indexedC.chunks[0].id;

        // 1) Firestore Mock이 Chunk A(0.95), Chunk B(0.82), Chunk C(0.61) 순으로 반환하도록 설정
        mockFirestore.customVectorSearchResults = [
          { chunkId: chunkIdA, vectorScore: 0.95 },
          { chunkId: chunkIdB, vectorScore: 0.82 },
          { chunkId: chunkIdC, vectorScore: 0.61 },
        ];
        const prevBatchGetCount = mockFirestore.batchGetDocsCallCount;

        const forwardRes = await searchProjectMemoryOnServer({
          ownerId: TEST_OWNER_A,
          query: {
            projectId: vecProjId,
            queryText: '심연의 열쇠 고대 제단 계약 기록',
            searchMode: 'HYBRID',
            limit: 5,
          },
        });

        assert.equal(forwardRes.vectorSearchMode, 'FIRESTORE_VECTOR_HYBRID');
        assert.equal(forwardRes.searchExecutionStatus, 'FIRESTORE_VECTOR_HYBRID');
        assert.equal(forwardRes.cloudSemanticSearchSucceeded, true);
        assert.equal(forwardRes.hits.length, 3);

        // 순위 및 점수 검증: A(1위, 0.95) > B(2위, 0.82) > C(3위, 0.61)
        assert.equal(forwardRes.hits[0].chunk.id, chunkIdA);
        assert.equal(forwardRes.hits[1].chunk.id, chunkIdB);
        assert.equal(forwardRes.hits[2].chunk.id, chunkIdC);
        assert.equal(forwardRes.hits[0].vectorScore, 0.95);
        assert.equal(forwardRes.hits[1].vectorScore, 0.82);
        assert.equal(forwardRes.hits[2].vectorScore, 0.61);
        assert.equal(forwardRes.hits[0].vectorRank, 1);
        assert.equal(forwardRes.hits[1].vectorRank, 2);
        assert.equal(forwardRes.hits[2].vectorRank, 3);
        assert.ok(
          (forwardRes.hits[0].rrfScore || 0) >= (forwardRes.hits[1].rrfScore || 0) &&
            (forwardRes.hits[1].rrfScore || 0) >= (forwardRes.hits[2].rrfScore || 0),
          'RRF 점수가 Firestore 벡터 순위를 반영해야 합니다.'
        );
        assert.equal(
          mockFirestore.batchGetDocsCallCount - prevBatchGetCount,
          1,
          '문서 개별 N+1 재조회 대신 배치 조회(batchGetMemoryDocumentsByIds) 1회로 부모 문서를 결합해야 합니다.'
        );

        // 2) 입력 벡터 순위를 반대로 변경: Chunk C(0.95) > Chunk B(0.82) > Chunk A(0.61)
        mockFirestore.customVectorSearchResults = [
          { chunkId: chunkIdC, vectorScore: 0.95 },
          { chunkId: chunkIdB, vectorScore: 0.82 },
          { chunkId: chunkIdA, vectorScore: 0.61 },
        ];

        const reverseRes = await searchProjectMemoryOnServer({
          ownerId: TEST_OWNER_A,
          query: {
            projectId: vecProjId,
            queryText: '심연의 열쇠 고대 제단 계약 기록',
            searchMode: 'HYBRID',
            limit: 5,
          },
        });

        assert.equal(reverseRes.vectorSearchMode, 'FIRESTORE_VECTOR_HYBRID');
        assert.equal(reverseRes.hits.length, 3);
        assert.equal(
          reverseRes.hits[0].chunk.id,
          chunkIdC,
          'Firestore 입력 벡터 순위를 역전(C=0.95)시키면 최종 검색 1위도 C로 역전되어야 합니다 (로컬 점수만 따르는 경우 실패).'
        );
        assert.equal(reverseRes.hits[1].chunk.id, chunkIdB);
        assert.equal(
          reverseRes.hits[2].chunk.id,
          chunkIdA,
          'Firestore 입력 벡터 순위를 역전(A=0.61)시키면 최종 검색 3위도 A로 역전되어야 합니다.'
        );
        assert.equal(reverseRes.hits[0].vectorScore, 0.95);
        assert.equal(reverseRes.hits[2].vectorScore, 0.61);

        // 3) Firestore Vector Search 결과가 비어있는 경우(OK_EMPTY)와 API 실패(API_ERROR) 구분 검증
        mockFirestore.customVectorSearchResults = [];
        const emptyVecRes = await searchProjectMemoryOnServer({
          ownerId: TEST_OWNER_A,
          query: {
            projectId: vecProjId,
            queryText: '심연의 열쇠 고대 제단 계약 기록',
            searchMode: 'HYBRID',
          },
        });
        assert.equal(
          emptyVecRes.vectorSearchMode,
          'KEYWORD_ONLY',
          'Firestore 벡터 후보가 0건(OK_EMPTY)일 때 허위로 FIRESTORE_VECTOR_HYBRID를 반환하면 안 되며 KEYWORD_ONLY로 기록되어야 합니다.'
        );
        assert.equal(emptyVecRes.cloudSemanticSearchSucceeded, false);

        mockFirestore.customVectorSearchResults = null;
        mockFirestore.simulateVectorSearchError = true;
        const apiErrorVecRes = await searchProjectMemoryOnServer({
          ownerId: TEST_OWNER_A,
          query: {
            projectId: vecProjId,
            queryText: '심연의 열쇠 고대 제단 계약 기록',
            searchMode: 'HYBRID',
          },
        });
        assert.equal(apiErrorVecRes.vectorSearchMode, 'LOCAL_FALLBACK');
        assert.equal(apiErrorVecRes.cloudSemanticSearchSucceeded, false);
        assert.match(apiErrorVecRes.fallbackWarning || '', /SIMULATED_FIRESTORE_VECTOR_SEARCH_ERROR/);
      } finally {
        setCustomGeminiEmbedContentForTesting(null);
        setMockFirestoreRagBackendForTesting(null);
        await deleteProjectIndexOnServer({
          ownerId: TEST_OWNER_A,
          projectId: vecProjId,
        });
      }
    });

    it('[P0-2] Gemini Embedding 2 API 어댑터 호환성(taskType/title 제거, 768차원 검증), EoL 모델 차단, API 실패 시 테스트 벡터 대체 금지 검증', async () => {
      const embProjId = 'test_rag_proj_p0_2_embedding2';
      clearEmbeddingCacheForTesting();

      // 1) gemini-embedding-2 요청 빌더 검증: config에 taskType, title이 절대 포함되지 않아야 함
      const docReq = buildModelSpecificEmbeddingRequest({
        modelId: 'gemini-embedding-2',
        text: '강현우는 심연의 계약서를 펼쳐 들었다.',
        purpose: 'RETRIEVAL_DOCUMENT',
        title: '제1화 심연의 계약',
        dimension: 768,
      });
      assert.equal(isGeminiEmbedding2Model(docReq.model), true);
      assert.equal(docReq.config.outputDimensionality, 768);
      assert.equal('taskType' in docReq.config, false, 'gemini-embedding-2 config에 taskType을 넣으면 안 됩니다.');
      assert.equal('title' in docReq.config, false, 'gemini-embedding-2 config에 title을 넣으면 안 됩니다.');
      assert.match(docReq.contents, /\[NOVEL_FORGE_RETRIEVAL_DOCUMENT\]/);
      assert.match(docReq.contents, /Title: 제1화 심연의 계약/);

      const queryReq = buildModelSpecificEmbeddingRequest({
        modelId: 'gemini-embedding-2',
        text: '심연의 계약서 내용',
        purpose: 'RETRIEVAL_QUERY',
        dimension: 768,
      });
      assert.equal('taskType' in queryReq.config, false);
      assert.equal('title' in queryReq.config, false);
      assert.match(queryReq.contents, /\[NOVEL_FORGE_RETRIEVAL_QUERY\]/);

      // 2) 레거시 어댑터(gemini-embedding-001) 분리 및 EoL 모델(text-embedding-004) 차단 검증
      const legacyReq = buildModelSpecificEmbeddingRequest({
        modelId: 'gemini-embedding-001',
        text: '레거시 호환 문단',
        purpose: 'RETRIEVAL_DOCUMENT',
        title: '레거시 문서',
        dimension: 768,
      });
      assert.equal(legacyReq.config.taskType, 'RETRIEVAL_DOCUMENT');
      assert.equal(legacyReq.config.title, '레거시 문서');
      assert.equal(isDeprecatedEmbeddingModel('text-embedding-004'), true);
      assert.throws(
        () =>
          buildModelSpecificEmbeddingRequest({
            modelId: 'text-embedding-004',
            text: '지원 종료 모델 호출 시도',
            purpose: 'RETRIEVAL_QUERY',
            dimension: 768,
          }),
        /DEPRECATED_EMBEDDING_MODEL_REJECTED/
      );

      // 3) 반환 벡터 차원(768) 불일치 시 즉시 에러 발생 검증
      setCustomGeminiEmbedContentForTesting(async () => ({
        embeddings: [{ values: [0.1, 0.2, 0.3] }], // 잘못된 3차원 반환
      }));
      await assert.rejects(
        async () => {
          await generateServerEmbedding('차원 검증 테스트 문장', {
            modelId: 'gemini-embedding-2',
            dimension: 768,
            purpose: 'RETRIEVAL_QUERY',
          });
        },
        /EMBEDDING_DIMENSION_MISMATCH/
      );

      // 4) Gemini API 실패(400 / 429 / 503) 시 조용히 테스트용 결정적 벡터로 대체하지 않고 에러를 던지며,
      //    HYBRID 검색에서는 검증된 기존 색인의 KEYWORD_ONLY 검색으로 보호 전환되는지 검증
      await indexMemoryInputOnServer(
        {
          ownerId: TEST_OWNER_A,
          projectId: embProjId,
          sourceEntityType: 'EPISODE',
          sourceEntityId: 'ep_emb_fallback_1',
          episodeId: 'ep_emb_fallback_1',
          episodeNumber: 1,
          title: '제1화 천공의 성채 방어전',
          fullText: '성기사단장 레온은 천공의 성채 북문을 봉쇄하고 마왕군을 격퇴했다.',
          sourceRevisionId: 'rev_emb_fb_1',
          canonStatus: 'CANON',
        },
        { preferDeterministicEmbeddings: true }
      );

      for (const statusCode of [400, 429, 503]) {
        clearEmbeddingCacheForTesting();
        setCustomGeminiEmbedContentForTesting(async () => {
          throw new Error(`GEMINI_API_HTTP_${statusCode}: Simulated upstream error ${statusCode}`);
        });

        await assert.rejects(
          async () => {
            await generateServerEmbedding(`API_${statusCode}_직접호출_테스트`, {
              modelId: 'gemini-embedding-2',
              dimension: 768,
            });
          },
          new RegExp(`${statusCode}`),
          `Gemini API ${statusCode} 오류 시 테스트용 결정적 벡터로 조용히 대체하면 안 됩니다.`
        );

        // HYBRID 검색 시: KEYWORD_ONLY로 전환되어 기존 검증된 색인 결과를 반환하고 실제 검색 모드를 정직하게 보고
        const hybridProtected = await searchProjectMemoryOnServer({
          ownerId: TEST_OWNER_A,
          query: {
            projectId: embProjId,
            queryText: '성기사단장 레온 천공의 성채 북문',
            searchMode: 'HYBRID',
          },
          preferDeterministicEmbeddings: false,
        });
        assert.equal(hybridProtected.vectorSearchMode, 'KEYWORD_ONLY');
        assert.equal(hybridProtected.searchExecutionStatus, 'KEYWORD_ONLY');
        assert.equal(hybridProtected.cloudSemanticSearchSucceeded, false);
        assert.ok(hybridProtected.hits.length > 0);
        assert.match(hybridProtected.fallbackWarning || '', /KEYWORD_ONLY/);

        // SEMANTIC 전용 검색 시: 허위 성공 처리 없이 SEARCH_FAILED 에러 발생
        await assert.rejects(
          async () => {
            await searchProjectMemoryOnServer({
              ownerId: TEST_OWNER_A,
              query: {
                projectId: embProjId,
                queryText: '성기사단장 레온 천공의 성채 북문',
                searchMode: 'SEMANTIC',
              },
              preferDeterministicEmbeddings: false,
            });
          },
          /SEARCH_FAILED/
        );
      }

      // 5) 임베딩 모델 변경 시 modelMismatchRequiresReindex 감지 검증
      setCustomGeminiEmbedContentForTesting(null);
      const ragStatus = getProjectRagStatusOnServer({
        ownerId: TEST_OWNER_A,
        projectId: embProjId,
        expectedEmbeddingModelId: 'gemini-embedding-001',
      });
      assert.equal(
        ragStatus.modelMismatchRequiresReindex,
        true,
        '기존 색인 모델과 요청된 임베딩 모델이 다를 경우 modelMismatchRequiresReindex가 true로 표시되어야 합니다.'
      );

      await deleteProjectIndexOnServer({
        ownerId: TEST_OWNER_A,
        projectId: embProjId,
      });
    });

    it('[P0-3] Cloud Firestore 10단계 색인 삭제 파이프라인, >1,000 청크 멀티배치 삭제, 부분 배치 실패 시 DELETE_PENDING 유지·검색 차단·원본 보존 검증', async () => {
      const delProjId = 'test_rag_proj_p0_3_cloud_delete';
      const mockFirestore = new InMemoryMockFirestoreRagBackend();
      mockFirestore.seedProjectDoc({
        userPathUid: TEST_OWNER_A,
        projectId: delProjId,
        docOwnerId: TEST_OWNER_A,
      });
      mockFirestore.seedProjectDoc({
        userPathUid: TEST_OWNER_B,
        projectId: TEST_PROJECT_B,
        docOwnerId: TEST_OWNER_B,
      });

      // 원본 에피소드 문서 시딩 (색인 삭제나 부분 실패 시 절대 삭제되면 안 됨)
      mockFirestore.seedCanonicalEpisodeDoc({
        userPathUid: TEST_OWNER_A,
        projectId: delProjId,
        episodeId: 'ep_del_massive',
        title: '제10화 절대 보존되어야 하는 원본 원고',
        content: '이 원본 원고는 색인 삭제 중 어떤 오류가 발생해도 삭제되면 안 됩니다.',
        canonStatus: 'CANON',
        sourceRevisionId: 'rev_orig_keep_1',
      });
      mockFirestore.seedCanonicalEpisodeDoc({
        userPathUid: TEST_OWNER_B,
        projectId: TEST_PROJECT_B,
        episodeId: 'ep_other_user_keep',
        title: '타 사용자 원본 원고',
        content: '다른 사용자의 원고 데이터입니다.',
        canonStatus: 'CANON',
        sourceRevisionId: 'rev_other_1',
      });

      setMockFirestoreRagBackendForTesting(mockFirestore);

      try {
        // 1) 캐릭터 설정 및 일반 회차 색인 후 단일 엔티티 삭제 검증
        await indexMemoryInputOnServer(
          {
            ownerId: TEST_OWNER_A,
            projectId: delProjId,
            sourceEntityType: 'CHARACTER',
            sourceEntityId: 'char_del_1',
            characterIds: ['char_del_1'],
            title: '검성 아스란',
            fullText: '검성 아스란은 무형검을 다루는 제국의 수호자다.',
            sourceRevisionId: 'rev_char_1',
            canonStatus: 'CANON',
          },
          { preferDeterministicEmbeddings: true }
        );

        const charDelRes = await deleteEntityIndexOnServer({
          ownerId: TEST_OWNER_A,
          projectId: delProjId,
          sourceEntityType: 'CHARACTER',
          sourceEntityId: 'char_del_1',
        });
        assert.equal(charDelRes.deleted, true);
        assert.equal(charDelRes.cloudDeleteStatus, 'DELETED');
        assert.equal(charDelRes.remainingRemoteChunks, 0);

        // 2) 1,050개 청크(>1,000개) 생성 후 2번째 삭제 배치에서 부분 실패(simulateDeleteBatchFailureAtBatchNumber = 2) 유도
        const paragraphs: string[] = [];
        for (let i = 1; i <= 1050; i++) {
          paragraphs.push(
            `[삭제검증절_${i}] 아스란은 ${i}번째 차원 균열을 봉인하고 고대 성물을 회수했다.`
          );
        }
        await indexMemoryInputOnServer(
          {
            ownerId: TEST_OWNER_A,
            projectId: delProjId,
            sourceEntityType: 'EPISODE',
            sourceEntityId: 'ep_del_massive',
            episodeId: 'ep_del_massive',
            episodeNumber: 10,
            title: '제10화 1050절 차원 봉인록',
            fullText: paragraphs.join('\n\n'),
            maxChunkLength: 65,
            sourceRevisionId: 'rev_orig_keep_1',
            canonStatus: 'CANON',
          },
          { preferDeterministicEmbeddings: true }
        );

        mockFirestore.simulateDeleteBatchFailureAtBatchNumber = 2;

        await assert.rejects(
          async () => {
            await deleteEntityIndexOnServer({
              ownerId: TEST_OWNER_A,
              projectId: delProjId,
              sourceEntityType: 'EPISODE',
              sourceEntityId: 'ep_del_massive',
            });
          },
          /CLOUD_DELETE_BATCH_FAILED/
        );

        // 부분 삭제 실패 직후 검증:
        // - 매니페스트에 DELETE_PENDING 상태와 실패 배치 번호(failedBatchNumber: 2)가 유지되어야 함
        // - 검색 결과에서는 즉시 0건으로 제외되어야 함
        // - 원본 원고(episodes/ep_del_massive)와 타 사용자 데이터는 100% 보존되어야 함
        const manifestAfterPartialFail = mockFirestore.getManifest(TEST_OWNER_A, delProjId);
        const pendingEntityState =
          manifestAfterPartialFail?.entityDeletionStates?.['EPISODE:ep_del_massive'];
        assert.equal(
          pendingEntityState?.status,
          'DELETE_PENDING',
          '부분 삭제 실패 시 DELETE_PENDING 상태가 유지되어야 합니다.'
        );
        assert.equal(pendingEntityState?.failedBatchNumber, 2);
        assert.ok((pendingEntityState?.remainingChunks || 0) > 0);

        const searchDuringPartialFail = await searchProjectMemoryOnServer({
          ownerId: TEST_OWNER_A,
          query: {
            projectId: delProjId,
            queryText: '삭제검증절 아스란 차원 균열 봉인',
            includeDrafts: true,
          },
          preferDeterministicEmbeddings: true,
        });
        assert.equal(
          searchDuringPartialFail.hits.length,
          0,
          '부분 삭제 실패 상태(DELETE_PENDING)의 자료는 검색에서 완전히 차단되어야 합니다.'
        );

        assert.equal(
          mockFirestore.documentsByPath.has(
            `users/${TEST_OWNER_A}/projects/${delProjId}/episodes/ep_del_massive`
          ),
          true,
          '색인 삭제 중 오류가 발생해도 원본 원고(episodes 컬렉션)는 절대 삭제되면 안 됩니다.'
        );
        assert.equal(
          mockFirestore.documentsByPath.has(
            `users/${TEST_OWNER_B}/projects/${TEST_PROJECT_B}/episodes/ep_other_user_keep`
          ),
          true,
          '타 사용자의 원본 원고는 절대 영향받으면 안 됩니다.'
        );

        // 3) 장애 해제 후 삭제 재시도 시 남은 청크가 모두 삭제(0건)되고 DELETED 상태로 전환되는지 검증
        mockFirestore.simulateDeleteBatchFailureAtBatchNumber = null;
        const retryDelRes = await deleteEntityIndexOnServer({
          ownerId: TEST_OWNER_A,
          projectId: delProjId,
          sourceEntityType: 'EPISODE',
          sourceEntityId: 'ep_del_massive',
        });
        assert.equal(retryDelRes.deleted, true);
        assert.equal(retryDelRes.cloudDeleteStatus, 'DELETED');
        assert.equal(retryDelRes.remainingRemoteDocs, 0);
        assert.equal(retryDelRes.remainingRemoteChunks, 0);

        const manifestAfterRetry = mockFirestore.getManifest(TEST_OWNER_A, delProjId);
        assert.equal(
          manifestAfterRetry?.entityDeletionStates?.['EPISODE:ep_del_massive']?.status,
          'DELETED'
        );

        // 4) 프로젝트 전체 색인 삭제(deleteProjectIndexOnServer) 검증
        const projDelRes = await deleteProjectIndexOnServer({
          ownerId: TEST_OWNER_A,
          projectId: delProjId,
        });
        assert.equal(projDelRes.deleted, true);
        assert.equal(projDelRes.cloudDeleteStatus, 'DELETED');
        assert.equal(projDelRes.remainingRemoteDocs, 0);
        assert.equal(projDelRes.remainingRemoteChunks, 0);

        // 프로젝트 전체 색인 삭제 후에도 원본 에피소드 문서는 그대로 보존되어야 함
        assert.equal(
          mockFirestore.documentsByPath.has(
            `users/${TEST_OWNER_A}/projects/${delProjId}/episodes/ep_del_massive`
          ),
          true,
          '프로젝트 전체 색인 삭제 후에도 원본 에피소드 문서는 보존되어야 합니다.'
        );
      } finally {
        setMockFirestoreRagBackendForTesting(null);
      }
    });

    it('[P0-4] 클라우드 인증 강제 및 소유권/원본 위변조 공격(CANON 위장, 구버전 스냅샷 위장, 미존재 프로젝트, 헤더 우회) 차단 검증', async () => {
      const secProjId = 'test_rag_proj_p0_4_security';
      const mockFirestore = new InMemoryMockFirestoreRagBackend();
      mockFirestore.strictCloudOwnershipRequired = true;
      mockFirestore.seedProjectDoc({
        userPathUid: TEST_OWNER_A,
        projectId: secProjId,
        docOwnerId: TEST_OWNER_A,
      });

      // Firestore 원본 에피소드는 DRAFT 상태 및 최신 리비전 'rev_canonical_v2'로 시딩
      mockFirestore.seedCanonicalEpisodeDoc({
        userPathUid: TEST_OWNER_A,
        projectId: secProjId,
        episodeId: 'ep_sec_draft',
        title: '제5화 아직 초안인 원고',
        content: '강현우는 아직 공개되지 않은 초안 비기를 시험했다.',
        canonStatus: 'DRAFT',
        sourceRevisionId: 'rev_canonical_v1',
      });
      mockFirestore.seedCanonicalEpisodeDoc({
        userPathUid: TEST_OWNER_A,
        projectId: secProjId,
        episodeId: 'ep_sec_canon',
        title: '제6화 최신 확정 원고',
        content: '강현우는 최신 확정 리비전에서 심연의 왕관을 파괴했다.',
        canonStatus: 'CANON',
        sourceRevisionId: 'rev_canonical_v2',
      });

      setMockFirestoreRagBackendForTesting(mockFirestore);

      try {
        // 1) 서버 클라우드 인증 강제(setServerCloudAuthEnforcementForTesting(true)) 시
        //    클라이언트가 x-require-cloud-auth 헤더를 보내지 않아도 무인증 요청이 즉시 401 차단되는지 검증
        setServerCloudAuthEnforcementForTesting(true);
        assert.equal(isServerCloudAuthEnforced(), true);

        const unauthAttempt = await resolveSecureRequestOwner({
          authorizationHeader: undefined,
          requireCloudAuth: false, // 클라이언트가 헤더를 안 보냈더라도 서버 정책이 우선해야 함
        });
        assert.equal(unauthAttempt.ok, false);
        assert.equal(unauthAttempt.statusCode, 401);

        // verifyAdminFirestoreProjectOwnership에서도 local_author 차단 검증
        const localAuthorInCloudCheck = await verifyAdminFirestoreProjectOwnership({
          authenticatedUid: 'local_author',
          projectId: secProjId,
        });
        assert.equal(localAuthorInCloudCheck.ok, false);
        assert.equal(localAuthorInCloudCheck.statusCode, 401);
        assert.match(localAuthorInCloudCheck.error || '', /CLOUD_AUTH_REQUIRED/);

        setServerCloudAuthEnforcementForTesting(null);

        // 2) 타 사용자 UID(TEST_OWNER_B)로 피해자 프로젝트(secProjId) 검색·색인·삭제 시도 -> 403 차단
        await assert.rejects(
          async () => {
            await searchProjectMemoryOnServer({
              ownerId: TEST_OWNER_B,
              query: {
                projectId: secProjId,
                queryText: '심연의 왕관',
              },
            });
          },
          /ADMIN_SDK_OWNERSHIP_MISMATCH/
        );

        await assert.rejects(
          async () => {
            await deleteProjectIndexOnServer({
              ownerId: TEST_OWNER_B,
              projectId: secProjId,
            });
          },
          /ADMIN_SDK_OWNERSHIP_MISMATCH/
        );

        // 3) 존재하지 않는 projectId 요청 시 클라우드 엄격 모드에서 403 차단 검증
        await assert.rejects(
          async () => {
            await searchProjectMemoryOnServer({
              ownerId: TEST_OWNER_A,
              query: {
                projectId: 'non_existent_cloud_project_999',
                queryText: '임의 검색어',
              },
            });
          },
          /FIRESTORE_PROJECT_NOT_OWNED/
        );

        // 4) 초안(DRAFT) 원고를 클라이언트 liveSnapshots에서 CANON으로 위장하여 검색 시도 -> CANON_SPOOF_DETECTED 차단
        await assert.rejects(
          async () => {
            await searchProjectMemoryOnServer({
              ownerId: TEST_OWNER_A,
              query: {
                projectId: secProjId,
                queryText: '초안 비기',
              },
              liveSnapshots: [
                {
                  sourceEntityType: 'EPISODE',
                  sourceEntityId: 'ep_sec_draft',
                  fullText: '강현우는 아직 공개되지 않은 초안 비기를 시험했다.',
                  sourceRevisionId: 'rev_canonical_v1',
                  canonStatus: 'CANON', // 실제 Firestore 원본은 DRAFT인데 CANON으로 위장
                },
              ],
              preferDeterministicEmbeddings: true,
            });
          },
          /CANON_SPOOF_DETECTED/
        );

        // 5) 구버전 원고 리비전('rev_canonical_v1_stale')을 최신 확정본인 것처럼 liveSnapshots로 주입 시도 -> REVISION_SPOOF_DETECTED 차단
        await assert.rejects(
          async () => {
            await searchProjectMemoryOnServer({
              ownerId: TEST_OWNER_A,
              query: {
                projectId: secProjId,
                queryText: '심연의 왕관',
              },
              liveSnapshots: [
                {
                  sourceEntityType: 'EPISODE',
                  sourceEntityId: 'ep_sec_canon',
                  fullText: '강현우는 구버전 원고에서 심연의 왕관을 착용했다.',
                  sourceRevisionId: 'rev_canonical_v1_stale', // 실제 Firestore 원본은 rev_canonical_v2
                  canonStatus: 'CANON',
                },
              ],
              preferDeterministicEmbeddings: true,
            });
          },
          /REVISION_SPOOF_DETECTED/
        );
      } finally {
        setServerCloudAuthEnforcementForTesting(null);
        setMockFirestoreRagBackendForTesting(null);
      }
    });

    it('[P1-5] Firestore 영구 저장소 기준 서버 재시작 및 로컬 디스크 캐시 삭제 후 콜드 복구(Cold Recovery) 검증', async () => {
      const recProjId = 'test_rag_proj_p1_5_cloud_recovery';
      const mockFirestore = new InMemoryMockFirestoreRagBackend();
      mockFirestore.seedProjectDoc({
        userPathUid: TEST_OWNER_A,
        projectId: recProjId,
        docOwnerId: TEST_OWNER_A,
      });
      setMockFirestoreRagBackendForTesting(mockFirestore);

      try {
        // 1) v1 색인 후 v2로 갱신 (구버전 v1은 비활성화되어야 함)
        await indexMemoryInputOnServer(
          {
            ownerId: TEST_OWNER_A,
            projectId: recProjId,
            sourceEntityType: 'EPISODE',
            sourceEntityId: 'ep_rec_1',
            episodeId: 'ep_rec_1',
            episodeNumber: 1,
            title: '제1화 구버전 연대기',
            fullText: '구버전에서만 존재하던 폐기된 흑마법사 설정입니다.',
            sourceRevisionId: 'rev_rec_v1_old',
            canonStatus: 'CANON',
          },
          { preferDeterministicEmbeddings: true }
        );

        await indexMemoryInputOnServer(
          {
            ownerId: TEST_OWNER_A,
            projectId: recProjId,
            sourceEntityType: 'EPISODE',
            sourceEntityId: 'ep_rec_1',
            episodeId: 'ep_rec_1',
            episodeNumber: 1,
            title: '제1화 최신 확정 연대기',
            fullText: '강현우는 태양의 성검 아우로라를 각성시키고 대마법 탑을 재건했다.',
            sourceRevisionId: 'rev_rec_v2_active',
            canonStatus: 'CANON',
          },
          { preferDeterministicEmbeddings: true }
        );

        // 삭제된 엔티티도 하나 생성 후 삭제 (복구 시 부활하면 안 됨)
        await indexMemoryInputOnServer(
          {
            ownerId: TEST_OWNER_A,
            projectId: recProjId,
            sourceEntityType: 'WORLDBUILDING',
            sourceEntityId: 'lore_rec_deleted',
            title: '삭제된 금기 설정',
            fullText: '이 금기 설정은 삭제되었으므로 서버 복구 후에도 절대 검색되면 안 됩니다.',
            sourceRevisionId: 'rev_lore_del_1',
            canonStatus: 'CANON',
          },
          { preferDeterministicEmbeddings: true }
        );
        await deleteEntityIndexOnServer({
          ownerId: TEST_OWNER_A,
          projectId: recProjId,
          sourceEntityType: 'WORLDBUILDING',
          sourceEntityId: 'lore_rec_deleted',
        });

        // 2) 로컬 디스크 캐시 완전 삭제 + 인메모리 스토어 초기화(서버 재시작 시뮬레이션)
        clearLocalRagDiskCacheForTesting(TEST_OWNER_A, recProjId);
        simulateServerRestartForTesting();

        // 3) 로컬 캐시가 전혀 없는 상태에서 검색 요청 -> Firestore로부터 자동 콜드 복구 수행 검증
        const recoveredSearch = await searchProjectMemoryOnServer({
          ownerId: TEST_OWNER_A,
          query: {
            projectId: recProjId,
            queryText: '태양의 성검 아우로라 대마법 탑',
          },
          preferDeterministicEmbeddings: true,
        });

        assert.equal(
          recoveredSearch.recoveredFromFirestore,
          true,
          '로컬 캐시 삭제 및 서버 재시작 후 Firestore 영구 저장소에서 활성 색인을 자동 복구해야 합니다.'
        );
        assert.ok(recoveredSearch.hits.length > 0);
        assert.equal(
          recoveredSearch.hits[0].chunk.sourceRevisionId,
          'rev_rec_v2_active',
          '복구된 색인은 반드시 최신 활성 버전(rev_rec_v2_active)이어야 합니다.'
        );

        // 4) 구버전(rev_rec_v1_old)이나 삭제된 설정(lore_rec_deleted)이 복구 과정에서 부활하지 않았는지 검증
        const oldCheck = await searchProjectMemoryOnServer({
          ownerId: TEST_OWNER_A,
          query: {
            projectId: recProjId,
            queryText: '폐기된 흑마법사 금기 설정',
            includeDrafts: true,
          },
          preferDeterministicEmbeddings: true,
        });
        assert.equal(
          oldCheck.hits.some(
            (h) =>
              h.chunk.sourceRevisionId === 'rev_rec_v1_old' ||
              h.chunk.sourceEntityId === 'lore_rec_deleted'
          ),
          false,
          '서버 재시작 및 Firestore 복구 후에도 이전 세대(stale)나 삭제된 색인이 부활하면 안 됩니다.'
        );
      } finally {
        setMockFirestoreRagBackendForTesting(null);
        await deleteProjectIndexOnServer({
          ownerId: TEST_OWNER_A,
          projectId: recProjId,
        });
      }
    });
  });
});


