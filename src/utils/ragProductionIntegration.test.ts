/**
 * NOVEL FORGE — PHASE 3.2.1 FINAL: Isolated Firestore Integration & RAG Production Verification
 *
 * Test Suites:
 * - Test A (Live Cloud): Live Gemini Embedding API (`gemini-embedding-2`, 768D, `LIVE_API`)
 * - Test B (Live Cloud): Isolated Firestore Remote Persistence, Ownership Check, Cold Recovery & 4-Step Cleanup
 * - Test C (Live Cloud): Isolated Firestore Vector Search (`findNearest`, 768D, `OK_WITH_HITS` vs `INDEX_NOT_READY`)
 * - Test D (Mock/CI): Novel Writer RAG Integration, Dynamic Viewpoint, Conflict Gate, Master Writing Rules & Draft Protection
 * - Test E (Mock/CI): Security Attack Suite, DB Consistency, Isolated Test DB Guard & Test Vector Isolation
 * - Test F (Mock/CI): Data Integrity (Revision Preservation, Partial Sync Protection, Vector Index Config & Optional DI Isolation)
 *
 * 투명성 원칙 (Section 1.1 & Section 8):
 * 라이브 클라우드 테스트(Test A, B, C)는 `RUN_LIVE_CLOUD_TESTS=true` 및 운영과 완전히 분리된
 * `TEST_FIREBASE_PROJECT_ID`, `TEST_FIRESTORE_DATABASE_ID`, 유효한 자격 증명이 모두 충족될 때만 실행됩니다.
 * 조건 미충족 시 가짜 성공(pass)으로 집계하지 않고 `t.skip('NOT_RUN: ...')`을 호출하여 명시적 SKIP(NOT_RUN)으로 분리 집계합니다.
 * 또한 Test C에서 복합 벡터 인덱스가 아직 생성 중이거나 미배포된 경우(`FAILED_PRECONDITION`)에는
 * `t.skip('INDEX_NOT_READY: ...')`로 분리 기록하며, 권한/인증/쿼리 문법 오류는 즉시 `FAIL` 처리합니다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Firestore } from 'firebase-admin/firestore';
import {
  assertNoClientTestEmbeddingModeInjection,
  clearEmbeddingCacheForTesting,
  clearLocalRagDiskCacheForTesting,
  deleteProjectIndexOnServer,
  generateServerEmbedding,
  getConfiguredEmbeddingDimension,
  getConfiguredEmbeddingModel,
  getProjectRagStatusOnServer,
  indexMemoryInputOnServer,
  isFirestoreVectorIndexMissingOrBuildingError,
  purgeIsolatedTestProjectData,
  retrieveVerifiedMemoryForWritingOnServer,
  searchProjectMemoryOnServer,
  setCustomGeminiEmbedContentForTesting,
  simulateServerRestartForTesting,
  syncOrRebuildProjectIndexOnServer,
  tryFirestoreVectorFindNearest,
} from '../server/ragEngine.ts';
import {
  PROD_DEFAULT_FIREBASE_PROJECT_ID,
  PROD_DEFAULT_FIRESTORE_DATABASE_ID,
  clearProjectOwnerRegistryForTesting,
  createIsolatedTestFirestoreClient,
  getFirebaseDatabaseId,
  getFirebaseProjectId,
  registerProjectOwnerForAdminCheck,
  resolveSecureRequestOwner,
  setCustomFirestoreProjectLookupForTesting,
  setServerCloudAuthEnforcementForTesting,
  verifyAdminFirestoreProjectOwnership,
  verifyIsolatedTestFirestoreBinding,
} from '../server/authMiddleware.ts';
import {
  MASTER_WRITING_RULES_V1_0_CONTENT,
  NovelForgeAppResultSchema,
  NovelForgeWriterResponseSchema,
  assembleNovelWriterPromptInOrder,
  enforceWritingResultInvariants,
  evaluatePreWritingConflictGate,
  resolveDynamicNarrativePerspective,
} from './aiEngineLogic.ts';
import {
  DETERMINISTIC_TEST_EMBEDDING_MODEL_ID,
  computeDeterministicSemanticEmbedding,
} from '../services/memorySearchProvider.ts';
import type { WritingContextBundle } from '../types/aiEngine.ts';
import type { Episode, Project } from '../types/novel.ts';

const PROD_FIREBASE_PROJECT_ID = PROD_DEFAULT_FIREBASE_PROJECT_ID;
const PROD_FIRESTORE_DATABASE_ID = PROD_DEFAULT_FIRESTORE_DATABASE_ID;

function isLiveCloudTestSwitchEnabled(): boolean {
  return process.env.RUN_LIVE_CLOUD_TESTS === 'true';
}

function hasValidGeminiApiKey(): boolean {
  const key = process.env.GEMINI_API_KEY?.trim();
  return Boolean(key && key.length > 5 && key !== 'MY_GEMINI_API_KEY');
}

function hasIsolatedLiveFirestoreTestEnv(): {
  ready: boolean;
  reason?: string;
  testProjectId: string;
  testDatabaseId: string;
} {
  if (!isLiveCloudTestSwitchEnabled()) {
    return {
      ready: false,
      reason: 'RUN_LIVE_CLOUD_TESTS=true 스위치가 비활성화되어 있습니다.',
      testProjectId: '',
      testDatabaseId: '',
    };
  }
  const testProjectId = (process.env.TEST_FIREBASE_PROJECT_ID || '').trim();
  const testDatabaseId = (process.env.TEST_FIRESTORE_DATABASE_ID || '').trim();
  if (!testProjectId || !testDatabaseId) {
    return {
      ready: false,
      reason:
        '격리된 테스트 환경변수(TEST_FIREBASE_PROJECT_ID, TEST_FIRESTORE_DATABASE_ID)가 지정되지 않았습니다.',
      testProjectId,
      testDatabaseId,
    };
  }
  if (
    testProjectId === PROD_FIREBASE_PROJECT_ID ||
    testDatabaseId === PROD_FIRESTORE_DATABASE_ID ||
    testDatabaseId === '(default)' ||
    testDatabaseId === 'default'
  ) {
    return {
      ready: false,
      reason:
        '안전 보호: 운영 Firebase 프로젝트, 운영 Firestore DB 또는 (default) DB와 동일한 식별자로는 라이브 테스트를 실행할 수 없습니다.',
      testProjectId,
      testDatabaseId,
    };
  }
  const hasCreds = Boolean(
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.FIREBASE_SERVICE_ACCOUNT_KEY ||
      process.env.FIRESTORE_EMULATOR_HOST
  );
  if (!hasCreds) {
    return {
      ready: false,
      reason:
        '클라우드 Firebase Admin 인증 자격 증명(GOOGLE_APPLICATION_CREDENTIALS, FIREBASE_SERVICE_ACCOUNT_KEY 또는 FIRESTORE_EMULATOR_HOST)이 제공되지 않았습니다.',
      testProjectId,
      testDatabaseId,
    };
  }
  return { ready: true, testProjectId, testDatabaseId };
}

describe('PHASE 3.2.1 FINAL — Isolated Firestore Integration, Security & Data Integrity Verification', () => {
  // ==========================================================================
  // Test A: Live Gemini Embedding API 호출 검증 (Requires RUN_LIVE_CLOUD_TESTS=true)
  // ==========================================================================
  describe('Test A: Live Gemini Embedding API 검증 (Live Cloud)', () => {
    it('RUN_LIVE_CLOUD_TESTS=true 및 유효한 API Key가 있을 때 gemini-embedding-2 768차원 LIVE_API 벡터를 생성하고, 미충족 시 NOT_RUN(SKIP)으로 기록한다', async (t) => {
      if (!isLiveCloudTestSwitchEnabled() || !hasValidGeminiApiKey()) {
        t.skip(
          'NOT_RUN: RUN_LIVE_CLOUD_TESTS=true 또는 유효한 GEMINI_API_KEY가 설정되지 않아 라이브 Gemini Embedding API 호출을 실행하지 않았습니다.'
        );
        return;
      }

      const res = await generateServerEmbedding('심연의 마검 카엘 각성', {
        modelId: 'gemini-embedding-2',
        dimension: 768,
        taskType: 'RETRIEVAL_QUERY',
      });
      assert.equal(res.usedLiveGeminiApi, true);
      assert.equal(res.embeddingGenerationMode, 'LIVE_API');
      assert.equal(res.modelId, 'gemini-embedding-2');
      assert.equal(Array.isArray(res.embedding), true);
      assert.equal(res.embedding.length, 768);
    });
  });

  // ==========================================================================
  // Test B: 격리된 테스트 Firestore 원격 영구 저장, 소유권 검증 및 콜드 복구 검증
  // ==========================================================================
  describe('Test B: 격리된 테스트 Firestore 원격 영구 저장 및 복구 검증 (Live Cloud)', () => {
    it('격리된 테스트 전용 Firestore(testDb)를 주입하여 소유권 확인 -> CANON 색인 -> 원격 저장 -> 서버 재시작 -> 콜드 복구 -> revisionId 일치 -> 4단계 하위 컬렉션 완전 정리까지 수행하며, 미충족 시 NOT_RUN(SKIP)으로 기록한다', async (t) => {
      const envCheck = hasIsolatedLiveFirestoreTestEnv();
      if (!envCheck.ready || !hasValidGeminiApiKey()) {
        t.skip(
          `NOT_RUN: ${envCheck.reason || 'GEMINI_API_KEY 미설정'} — 가짜 성공 처리 없이 라이브 Firestore 영구 저장 테스트를 건너뜁니다.`
        );
        return;
      }

      const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const liveOwner = `test_owner_live_${runId}`;
      const liveProject = `test_proj_live_${runId}`;
      const cacheNamespace = `isolated_live_b_${runId}`;

      const testClient = createIsolatedTestFirestoreClient({
        runId,
        projectId: envCheck.testProjectId,
        databaseId: envCheck.testDatabaseId,
      });
      const testDb = testClient.db;

      try {
        // 1. 주입된 testDb가 운영 DB가 아닌 격리된 테스트 프로젝트/DB에 바인딩되었는지 즉시 검증
        verifyIsolatedTestFirestoreBinding(testDb, {
          projectId: envCheck.testProjectId,
          databaseId: envCheck.testDatabaseId,
          runId,
        });

        // 2. 격리된 testDb에 테스트 부모 프로젝트 문서 생성 (정리 시 마커 검증용)
        const basePath = `users/${liveOwner}/projects/${liveProject}`;
        await testDb.doc(basePath).set({
          id: liveProject,
          ownerId: liveOwner,
          title: 'Phase 3.2.1 격리 라이브 테스트 작품 B',
          genre: '다크 판타지',
          status: 'confirmed',
          canonStatus: 'CANON',
          isIsolatedLiveTest: true,
          testRunId: runId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        // 3. 주입된 testDb를 대상으로 직접 소유권 검증 (200 OK) 및 타인 접근 차단(403) 확인
        const ownerCheck = await verifyAdminFirestoreProjectOwnership({
          authenticatedUid: liveOwner,
          isAuthenticatedCloud: true,
          projectId: liveProject,
          db: testDb,
          skipRegistryCache: true,
        });
        assert.equal(ownerCheck.ok, true);
        assert.equal(ownerCheck.statusCode, 200);

        const crossUserCheck = await verifyAdminFirestoreProjectOwnership({
          authenticatedUid: `other_attacker_${runId}`,
          isAuthenticatedCloud: true,
          projectId: liveProject,
          db: testDb,
          skipRegistryCache: true,
        });
        assert.equal(crossUserCheck.ok, false);
        assert.equal(crossUserCheck.statusCode, 403);

        // 4. Optional DI (`db: testDb`, `cacheNamespace`)로 CANON 원고 색인 및 원격 저장
        const indexed = await indexMemoryInputOnServer(
          {
            ownerId: liveOwner,
            projectId: liveProject,
            sourceEntityType: 'EPISODE',
            sourceEntityId: 'ep_live_b1',
            sourceRevisionId: 'rev_live_b1_v1',
            episodeId: 'ep_live_b1',
            episodeNumber: 1,
            title: '제1화 격리 테스트 원고',
            fullText:
              '카엘은 북부 빙하 제단에서 성검 아우로라의 봉인을 해제하고 서약을 맺었다.',
            canonStatus: 'CANON',
            embeddingModelId: 'gemini-embedding-2',
            embeddingGenerationMode: 'LIVE_API',
          },
          {
            db: testDb,
            cacheNamespace,
          }
        );
        assert.equal(indexed.document.indexStatus, 'INDEXED');
        assert.equal(indexed.document.sourceRevisionId, 'rev_live_b1_v1');

        // 5. 격리된 testDb에 실제로 memoryDocuments 및 memoryChunks가 기록되었는지 직접 확인
        const [remoteDocsSnap, remoteChunksSnap] = await Promise.all([
          testDb.collection(`${basePath}/memoryDocuments`).get(),
          testDb.collection(`${basePath}/memoryChunks`).get(),
        ]);
        assert.ok(
          remoteDocsSnap.size > 0,
          '격리된 testDb의 memoryDocuments 컬렉션에 문서가 저장되어야 합니다.'
        );
        assert.ok(
          remoteChunksSnap.size > 0,
          '격리된 testDb의 memoryChunks 컬렉션에 청크가 저장되어야 합니다.'
        );

        const preRestartStatus = getProjectRagStatusOnServer({
          ownerId: liveOwner,
          projectId: liveProject,
          db: testDb,
          cacheNamespace,
        });
        assert.equal(preRestartStatus.cloudSemanticSearchReady, true);

        // 6. 로컬 디스크 캐시 및 인메모리 스토어 초기화 후 격리된 testDb 원본에서 콜드 복구 검증
        clearLocalRagDiskCacheForTesting(liveOwner, liveProject, {
          db: testDb,
          cacheNamespace,
        });
        simulateServerRestartForTesting();

        const recovered = await searchProjectMemoryOnServer({
          ownerId: liveOwner,
          query: {
            projectId: liveProject,
            queryText: '북부 빙하 제단 성검 아우로라',
            limit: 5,
          },
          db: testDb,
          cacheNamespace,
        });
        assert.equal(recovered.recoveredFromFirestore, true);
        assert.ok(recovered.hits.length > 0);
        assert.equal(
          recovered.hits[0].chunk.sourceRevisionId,
          'rev_live_b1_v1'
        );
      } finally {
        try {
          const cleanupRes = await purgeIsolatedTestProjectData({
            db: testDb,
            testOwnerId: liveOwner,
            testProjectId: liveProject,
            expectedRunId: runId,
            cacheNamespace,
          });
          assert.equal(cleanupRes.remainingChunks, 0);
          assert.equal(cleanupRes.remainingDocuments, 0);
          assert.equal(cleanupRes.remainingManifests, 0);
          assert.equal(cleanupRes.remainingProjectRoot, 0);
        } finally {
          await testClient.cleanup();
        }
      }
    });
  });

  // ==========================================================================
  // Test C: 격리된 테스트 Firestore 벡터 검색(findNearest) 검증
  // ==========================================================================
  describe('Test C: 격리된 테스트 Firestore findNearest 벡터 검색 검증 (Live Cloud)', () => {
    it('격리된 테스트 전용 Firestore(testDb)에서 findNearest가 실제로 OK_WITH_HITS를 반환하는지 검증하고, 인덱스 미준비 시 INDEX_NOT_READY(SKIP), 쿼리/권한 오류 시 FAIL로 정확히 구분한다', async (t) => {
      const envCheck = hasIsolatedLiveFirestoreTestEnv();
      if (!envCheck.ready || !hasValidGeminiApiKey()) {
        t.skip(
          `NOT_RUN: ${envCheck.reason || 'GEMINI_API_KEY 미설정'} — 실제 Firestore findNearest 벡터 검색을 실행하지 않았습니다.`
        );
        return;
      }

      const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const liveOwner = `test_owner_live_${runId}`;
      const liveProject = `test_proj_live_${runId}`;
      const cacheNamespace = `isolated_live_c_${runId}`;

      const testClient = createIsolatedTestFirestoreClient({
        runId,
        projectId: envCheck.testProjectId,
        databaseId: envCheck.testDatabaseId,
      });
      const testDb = testClient.db;

      try {
        verifyIsolatedTestFirestoreBinding(testDb, {
          projectId: envCheck.testProjectId,
          databaseId: envCheck.testDatabaseId,
          runId,
        });

        const basePath = `users/${liveOwner}/projects/${liveProject}`;
        await testDb.doc(basePath).set({
          id: liveProject,
          ownerId: liveOwner,
          title: 'Phase 3.2.1 격리 라이브 테스트 작품 C',
          genre: '판타지',
          status: 'confirmed',
          canonStatus: 'CANON',
          isIsolatedLiveTest: true,
          testRunId: runId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        await indexMemoryInputOnServer(
          {
            ownerId: liveOwner,
            projectId: liveProject,
            sourceEntityType: 'EPISODE',
            sourceEntityId: 'ep_live_c1',
            sourceRevisionId: 'rev_live_c1_canon',
            episodeId: 'ep_live_c1',
            episodeNumber: 1,
            title: '제1화 심연의 성배',
            fullText:
              '엘레나는 심연의 성배에 깃든 고대 신성력을 깨워 북부 성벽을 수호했다.',
            canonStatus: 'CANON',
            embeddingModelId: 'gemini-embedding-2',
            embeddingGenerationMode: 'LIVE_API',
          },
          {
            db: testDb,
            cacheNamespace,
          }
        );

        const qEmb = await generateServerEmbedding('심연의 성배 고대 신성력', {
          modelId: 'gemini-embedding-2',
          dimension: 768,
          taskType: 'RETRIEVAL_QUERY',
        });

        const res = await tryFirestoreVectorFindNearest({
          ownerId: liveOwner,
          projectId: liveProject,
          queryEmbedding: qEmb.embedding,
          queryEmbeddingGenerationMode: 'LIVE_API',
          queryEmbeddingModelId: 'gemini-embedding-2',
          limit: 5,
          canonOnly: true,
          db: testDb,
        });

        // Section 8.2: 복합 벡터 인덱스가 아직 생성 중이거나 미배포된 경우(INDEX_NOT_READY)는
        // 가짜 PASS로 처리하지 않고 명시적으로 INDEX_NOT_READY 사유와 함께 SKIP 처리
        if (res.indexState === 'INDEX_NOT_READY') {
          t.skip(
            `INDEX_NOT_READY: 격리 테스트 DB('${envCheck.testDatabaseId}')에 memoryChunks 복합 벡터 인덱스가 아직 배포/생성 완료되지 않았습니다 — ${res.error || 'FAILED_PRECONDITION'}`
          );
          return;
        }

        // Section 8.2: 권한 오류, 인증 실패, 차원 불일치, 잘못된 쿼리 문법은 즉시 FAIL 처리
        if (res.status === 'API_ERROR') {
          assert.fail(
            `VECTOR_QUERY_OR_AUTH_ERROR: Firestore findNearest 실행 중 인덱스 미준비가 아닌 오류 발생 — ${res.error || 'UNKNOWN_API_ERROR'}`
          );
        }

        // OK_EMPTY나 SKIPPED는 성공으로 인정하지 않음
        assert.equal(res.status, 'OK_WITH_HITS');
        assert.equal(res.indexState, 'READY');
        assert.equal(res.usedFindNearest, true);
        assert.ok(res.candidates.length > 0);
        assert.equal(
          res.candidates[0].documentSnapshot?.sourceRevisionId,
          'rev_live_c1_canon'
        );
        assert.equal(res.candidates[0].canonStatus, 'CANON');
        assert.equal(res.candidates[0].projectId, liveProject);
        assert.equal(res.candidates[0].ownerId, liveOwner);

        // 실제 하이브리드 검색에서도 FIRESTORE_VECTOR_HYBRID 모드로 결합되는지 확인
        const hybridRes = await searchProjectMemoryOnServer({
          ownerId: liveOwner,
          query: {
            projectId: liveProject,
            queryText: '심연의 성배 고대 신성력',
            searchMode: 'HYBRID',
            limit: 5,
          },
          db: testDb,
          cacheNamespace,
        });
        assert.equal(hybridRes.firestoreVectorStatus, 'OK_WITH_HITS');
        assert.equal(hybridRes.vectorSearchMode, 'FIRESTORE_VECTOR_HYBRID');
        assert.ok(hybridRes.hits.length > 0);
        assert.equal(
          hybridRes.hits[0].chunk.sourceRevisionId,
          'rev_live_c1_canon'
        );
      } finally {
        try {
          const cleanupRes = await purgeIsolatedTestProjectData({
            db: testDb,
            testOwnerId: liveOwner,
            testProjectId: liveProject,
            expectedRunId: runId,
            cacheNamespace,
          });
          assert.equal(cleanupRes.remainingChunks, 0);
          assert.equal(cleanupRes.remainingDocuments, 0);
          assert.equal(cleanupRes.remainingManifests, 0);
          assert.equal(cleanupRes.remainingProjectRoot, 0);
        } finally {
          await testClient.cleanup();
        }
      }
    });
  });

  // ==========================================================================
  // Test D: Novel Writer 프롬프트 연동, 시점 상속, Conflict Gate & 초안 보호 검증
  // ==========================================================================
  describe('Test D: Novel Writer RAG 연결 및 기존 집필 기능 회귀 검증 (Mock/CI)', () => {
    it('검증된 CANON 기억만 집필 컨텍스트에 주입되고 DRAFT는 배제되며, 동적 시점 상속(장면->회차->작품), Conflict Gate, Master Writing Rules v1.0, JSON 스키마 및 초안 보호가 작동한다', async () => {
      const testOwner = 'author_test_d';
      const testProject = 'proj_test_d';

      await deleteProjectIndexOnServer({
        ownerId: testOwner,
        projectId: testProject,
      });

      try {
        // 1. 확정(CANON) 원고 및 캐릭터 설정 색인
        await indexMemoryInputOnServer(
          {
            ownerId: testOwner,
            projectId: testProject,
            sourceEntityType: 'EPISODE',
            sourceEntityId: 'ep_canon_1',
            sourceRevisionId: 'rev_canon_v100',
            episodeId: 'ep_canon_1',
            episodeNumber: 1,
            title: '제1화. 흑염의 각성',
            fullText:
              '카엘은 오른손에 흑염의 각인을 새기고 검을 쥐었다. 마검은 차갑게 빛났다.',
            canonStatus: 'CANON',
          },
          { preferDeterministicEmbeddings: true }
        );

        await indexMemoryInputOnServer(
          {
            ownerId: testOwner,
            projectId: testProject,
            sourceEntityType: 'CHARACTER',
            sourceEntityId: 'char_kael',
            sourceRevisionId: 'rev_char_kael_1',
            characterIds: ['char_kael'],
            title: '카엘 (주인공)',
            fullText:
              '카엘: 몰락한 북부 기사가문의 후계자. 오른손에 흑염의 각인이 있으며 냉철한 말투를 사용한다.',
            canonStatus: 'CANON',
          },
          { preferDeterministicEmbeddings: true }
        );

        // 미승인 초안(DRAFT) 원고 색인 -> 기본 집필 컨텍스트에 섞이면 안 됨
        await indexMemoryInputOnServer(
          {
            ownerId: testOwner,
            projectId: testProject,
            sourceEntityType: 'EPISODE',
            sourceEntityId: 'ep_draft_unapproved',
            sourceRevisionId: 'rev_draft_v1',
            episodeId: 'ep_draft_unapproved',
            episodeNumber: 2,
            title: '제2화 미승인 초안',
            fullText:
              '카엘이 흑염의 각인을 잃어버리고 마법사로 전직한다는 미확정 초안 설정이다.',
            canonStatus: 'DRAFT',
          },
          { preferDeterministicEmbeddings: true }
        );

        // 2. 동적 시점 상속(장면 -> 회차 -> 작품) 검증
        const resolvedViewpoint = resolveDynamicNarrativePerspective({
          projectDefaultPerspective: 'THIRD_LIMITED',
          episodePerspective: 'FIRST_PERSON',
          scenePerspective: null,
        });
        assert.equal(resolvedViewpoint.perspective, 'FIRST_PERSON');
        assert.equal(resolvedViewpoint.sourceScope, 'EPISODE');

        const sceneOverrideViewpoint = resolveDynamicNarrativePerspective({
          projectDefaultPerspective: 'FIRST_PERSON',
          episodePerspective: 'FIRST_PERSON',
          scenePerspective: 'OMNISCIENT',
        });
        assert.equal(sceneOverrideViewpoint.perspective, 'OMNISCIENT');
        assert.equal(sceneOverrideViewpoint.sourceScope, 'SCENE');

        // 3. 집필용 검증된 장기 기억 검색
        const context: WritingContextBundle = {
          projectId: testProject,
          projectTitle: '검의 심연',
          projectGenre: '다크 판타지',
          projectSynopsis: '마검의 각인을 품은 카엘의 투쟁기',
          episodeId: 'ep_canon_2',
          episodeNumber: 2,
          episodeTitle: '제2화. 불꽃의 계승',
          writingMode: 'FULL_EPISODE',
          narrativePerspective: resolvedViewpoint.perspective || 'FIRST_PERSON',
          targetEpisodeCharCount: 4000,
          targetSceneCharCount: 2000,
          tolerancePercent: 15,
          plotOutline: '카엘이 흑염의 각인을 시험하며 마검의 공명을 확인한다.',
          requiredEvents: ['흑염의 각인 시험', '마검의 공명 확인'],
          forbiddenDevelopments: ['각인 소멸'],
          canonCharacters: [
            {
              id: 'char_kael',
              name: '카엘',
              role: '주인공',
              affiliation: '북부 기사단',
              personality: '냉철하고 과묵함',
              abilities: '흑염 검술',
              appearance: '오른손의 흑염 각인',
            },
          ],
          canonWorldbuilding: [],
          previousEpisodeSummary: '제1화에서 카엘이 오른손에 흑염의 각인을 얻음.',
          previousEpisodeTailExcerpt: '마검은 차갑게 빛났다.',
          currentManuscript: '기존 집필 중이던 소중한 원고 초안입니다.',
          activePrompts: [
            {
              profileId: 'prof_master_v1',
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

        const retrieved = await retrieveVerifiedMemoryForWritingOnServer({
          ownerId: testOwner,
          context,
          topK: 5,
          preferDeterministicEmbeddings: true,
        });

        assert.equal(Array.isArray(retrieved), true);
        assert.ok(retrieved.length > 0, '최소 1개 이상의 확정 기억이 검색되어야 합니다');

        const canonHit = retrieved.find((c) => c.sourceEntityId === 'ep_canon_1');
        assert.ok(canonHit, '1화의 CANON 원고 기억이 검색 결과에 포함되어야 합니다');
        assert.equal(canonHit?.canonStatus, 'CANON');
        assert.equal(canonHit?.sourceRevisionId, 'rev_canon_v100');
        assert.equal(canonHit?.verifiedForWriting, true);

        const draftLeaked = retrieved.some(
          (c) =>
            c.sourceEntityId === 'ep_draft_unapproved' ||
            c.canonStatus !== 'CANON'
        );
        assert.equal(
          draftLeaked,
          false,
          '미승인 DRAFT 자료는 기본 집필 컨텍스트에 절대 포함되면 안 됩니다.'
        );

        // 4. 프롬프트 조립, Conflict Gate, JSON 스키마 및 초안 보호 불변성 검증
        const enrichedContext: WritingContextBundle = {
          ...context,
          retrievedMemoryChunks: retrieved,
        };
        const gate = evaluatePreWritingConflictGate(enrichedContext);
        assert.equal(gate.blocked, false);
        assert.equal(gate.manuscript_state, 'DRAFT_READY');

        const prompt = assembleNovelWriterPromptInOrder({
          context: enrichedContext,
          specialModeInstruction: '제2화 첫 장면을 집필하세요.',
        });
        assert.ok(prompt.orderedPrompt.includes('rev_canon_v100'));
        assert.ok(prompt.orderedPrompt.includes('NOVEL FORGE'));

        const sampleWriterOut = {
          manuscript_state: 'DRAFT_READY' as const,
          manuscript: '카엘은 오른손의 흑염 각인을 내려다보며 마검을 고쳐 쥐었다.',
          issues: [],
          proposals: [],
        };
        const parsedWriter = NovelForgeWriterResponseSchema.safeParse(sampleWriterOut);
        assert.equal(parsedWriter.success, true);

        const protectedResult = enforceWritingResultInvariants(
          {
            runId: 'run_test_d_1',
            projectId: testProject,
            episodeId: 'ep_canon_2',
            sceneId: 'scene_1',
            manuscript: sampleWriterOut.manuscript,
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
                title: '제1화. 흑염의 각성',
                canonStatus: 'CANON',
                revisionId: 'rev_canon_v100',
              },
            ],
            referencedMemoryChunks: retrieved,
            issues: [],
            proposals: [],
            appliedPromptVersionIds: [],
            usageMetadata: {
              promptTokenCount: 400,
              candidatesTokenCount: 250,
              totalTokenCount: 650,
              estimatedCostUsd: 0.001,
              isActualUsage: true,
            },
            status: 'COMPLETED',
            createdAt: new Date().toISOString(),
          },
          enrichedContext
        );
        // 작가 승인 전에는 CANON으로 자동 승격되지 않고 CANON_CANDIDATE 상태를 유지하며 기존 초안은 보존됨
        assert.equal(protectedResult.canonClassification, 'CANON_CANDIDATE');
        assert.equal(
          context.currentManuscript,
          '기존 집필 중이던 소중한 원고 초안입니다.'
        );
        const parsedApp = NovelForgeAppResultSchema.safeParse({
          manuscript_state: 'DRAFT_READY',
          canon_status: protectedResult.canonClassification,
          audit_execution_state: {
            continuity_checker: 'PASSED',
            style_editor: 'PASSED',
          },
          manuscript: protectedResult.manuscript,
          issues: [],
          proposals: [],
        });
        assert.equal(parsedApp.success, true);
      } finally {
        await deleteProjectIndexOnServer({
          ownerId: testOwner,
          projectId: testProject,
        });
      }
    });
  });

  // ==========================================================================
  // Test E: 보안 공격 방어, DB 일관성 및 운영 테스트 벡터 유입 차단 검증
  // ==========================================================================
  describe('Test E: 보안 공격 방어, DB 일관성 및 테스트 벡터 차단 (Security Suite)', () => {
    it('E-1: 유효하지 않은 Bearer 토큰은 401로 차단한다', async () => {
      const res = await resolveSecureRequestOwner({
        authorizationHeader: 'Bearer invalid_forged_jwt_token_xyz',
        claimedOwnerId: 'attacker_uid',
        requireCloudAuth: true,
      });
      assert.equal(res.ok, false);
      assert.equal(res.statusCode, 401);
    });

    it('E-2: 교차 사용자 ownerId 변조(Cross-User Tampering) 공격을 403으로 차단한다', async () => {
      clearProjectOwnerRegistryForTesting();
      const res = await verifyAdminFirestoreProjectOwnership({
        authenticatedUid: 'attacker_uid_123',
        isAuthenticatedCloud: true,
        projectId: 'victim_project_456',
        claimedOwnerId: 'victim_author_999',
      });
      assert.equal(res.ok, false);
      assert.equal(res.statusCode, 403);
      assert.match(res.error || '', /CLAIMED_OWNER_MISMATCH/);
    });

    it('E-3: 경로 탐색(Path Traversal) 공격 파라미터를 400으로 차단한다', async () => {
      const res = await verifyAdminFirestoreProjectOwnership({
        authenticatedUid: 'user_normal',
        isAuthenticatedCloud: true,
        projectId: '../../etc/passwd',
      });
      assert.equal(res.ok, false);
      assert.equal(res.statusCode, 400);
      assert.match(res.error || '', /경로 탐색/);
    });

    it('E-4: Firestore 지원 한도(2048차원)를 초과하는 임베딩 차원을 400으로 차단한다', async () => {
      const origEnv = process.env.GEMINI_EMBEDDING_DIMENSION;
      try {
        process.env.GEMINI_EMBEDDING_DIMENSION = '3072';
        assert.throws(
          () => getConfiguredEmbeddingDimension(),
          /FIRESTORE_VECTOR_DIMENSION_OUT_OF_RANGE/
        );
      } finally {
        if (origEnv !== undefined) {
          process.env.GEMINI_EMBEDDING_DIMENSION = origEnv;
        } else {
          delete process.env.GEMINI_EMBEDDING_DIMENSION;
        }
      }
    });

    it('E-5: 클라우드 운영 모드에서 미인증 local_author 계정 접근을 401로 차단한다', async () => {
      const res = await verifyAdminFirestoreProjectOwnership({
        authenticatedUid: 'local_author',
        isAuthenticatedCloud: true,
        projectId: 'any_project_id',
      });
      assert.equal(res.ok, false);
      assert.equal(res.statusCode, 401);
      assert.match(res.error || '', /CLOUD_AUTH_REQUIRED/);
    });

    it('E-6: 프로젝트 본문 내부의 소유자(payloadOwnerId) 불일치를 403으로 차단한다', async () => {
      const res = await verifyAdminFirestoreProjectOwnership({
        authenticatedUid: 'user_attacker',
        isAuthenticatedCloud: true,
        projectId: 'project_alpha',
        claimedOwnerId: 'user_attacker',
        projectPayloadOwnerId: 'victim_author_777',
      });
      assert.equal(res.ok, false);
      assert.equal(res.statusCode, 403);
      assert.match(res.error || '', /PAYLOAD_OWNER_MISMATCH/);
    });

    it('E-7: Firestore 소유권 문서 조회 실패(lookupFailed) 및 미존재 프로젝트 시 서버 캐시만으로 승인하지 않고 403으로 차단한다', async () => {
      clearProjectOwnerRegistryForTesting();
      // 설령 서버 메모리 레지스트리에 등록되어 있더라도, 운영 모드에서 Firestore 원본 조회가 실패하거나 문서가 없으면 차단되어야 함
      registerProjectOwnerForAdminCheck('project_alpha', 'user_valid');

      setCustomFirestoreProjectLookupForTesting(async () => ({
        existsUnderUserPath: false,
        lookupFailed: true,
        lookupError: 'Simulated Firestore connection timeout',
      }));

      const failedLookupRes = await verifyAdminFirestoreProjectOwnership({
        authenticatedUid: 'user_valid',
        isAuthenticatedCloud: true,
        projectId: 'project_alpha',
      });
      assert.equal(failedLookupRes.ok, false);
      assert.equal(failedLookupRes.statusCode, 403);
      assert.match(
        failedLookupRes.error || '',
        /FIRESTORE_VERIFICATION_FAILED/
      );

      // 문서가 존재하지 않는 경우(existsUnderUserPath: false)에도 레지스트리 캐시로 우회되지 않고 403 차단
      setCustomFirestoreProjectLookupForTesting(async () => ({
        existsUnderUserPath: false,
      }));
      const missingDocRes = await verifyAdminFirestoreProjectOwnership({
        authenticatedUid: 'user_valid',
        isAuthenticatedCloud: true,
        projectId: 'project_alpha',
      });
      assert.equal(missingDocRes.ok, false);
      assert.equal(missingDocRes.statusCode, 403);
      assert.match(missingDocRes.error || '', /FIRESTORE_PROJECT_NOT_OWNED/);

      clearProjectOwnerRegistryForTesting();
    });

    it('E-8: 정상 사용자 + 정상 DB는 통과(200)하고, 잘못된 DB 지정, 환경변수 DB 불일치 및 격리 테스트 팩토리의 운영 프로젝트/DB 연결 시도는 즉시 차단한다', async () => {
      clearProjectOwnerRegistryForTesting();
      setCustomFirestoreProjectLookupForTesting(async ({ authenticatedUid }) => ({
        existsUnderUserPath: true,
        docOwnerId: authenticatedUid,
        actualOwnerInDatabase: authenticatedUid,
      }));

      const expectedDbId = getFirebaseDatabaseId();
      assert.equal(expectedDbId, PROD_FIRESTORE_DATABASE_ID);
      assert.equal(getFirebaseProjectId(), PROD_FIREBASE_PROJECT_ID);

      // 1) 정상 사용자 + 정상 DB -> 200 OK
      const validDbCheck = await verifyAdminFirestoreProjectOwnership({
        authenticatedUid: 'author_valid_db',
        isAuthenticatedCloud: true,
        projectId: 'proj_valid_db',
        requestedDatabaseId: PROD_FIRESTORE_DATABASE_ID,
      });
      assert.equal(validDbCheck.ok, true);
      assert.equal(validDbCheck.statusCode, 200);

      // 2) 정상 사용자 + 잘못된 요청 DB -> 403 차단
      const wrongReqDbCheck = await verifyAdminFirestoreProjectOwnership({
        authenticatedUid: 'author_valid_db',
        isAuthenticatedCloud: true,
        projectId: 'proj_valid_db',
        requestedDatabaseId: 'wrong-firestore-db-id',
      });
      assert.equal(wrongReqDbCheck.ok, false);
      assert.equal(wrongReqDbCheck.statusCode, 403);
      assert.match(wrongReqDbCheck.error || '', /FIRESTORE_DATABASE_MISMATCH/);

      // 3) 환경변수 FIRESTORE_DATABASE_ID가 설정 파일과 불일치할 때 -> 403 차단
      const origDbEnv = process.env.FIRESTORE_DATABASE_ID;
      try {
        process.env.FIRESTORE_DATABASE_ID = 'conflicting-other-database-id';
        const envConflictCheck = await verifyAdminFirestoreProjectOwnership({
          authenticatedUid: 'author_valid_db',
          isAuthenticatedCloud: true,
          projectId: 'proj_valid_db',
        });
        assert.equal(envConflictCheck.ok, false);
        assert.equal(envConflictCheck.statusCode, 403);
        assert.match(
          envConflictCheck.error || '',
          /FIRESTORE_DATABASE_ID_MISMATCH/
        );
      } finally {
        if (origDbEnv !== undefined) {
          process.env.FIRESTORE_DATABASE_ID = origDbEnv;
        } else {
          delete process.env.FIRESTORE_DATABASE_ID;
        }
        clearProjectOwnerRegistryForTesting();
      }

      // 4) Phase 3.2.1: 격리 테스트 팩토리(createIsolatedTestFirestoreClient)가 운영 Project ID / 운영 Database ID / (default) 연결을 즉시 거부하는지 검증
      assert.throws(
        () =>
          createIsolatedTestFirestoreClient({
            runId: '',
            projectId: 'isolated-test-project',
            databaseId: 'isolated-test-db',
          }),
        /INVALID_TEST_RUN_ID/
      );
      assert.throws(
        () =>
          createIsolatedTestFirestoreClient({
            runId: 'run_check_1',
            projectId: '',
            databaseId: '',
          }),
        /MISSING_TEST_FIRESTORE_IDENTIFIERS/
      );
      assert.throws(
        () =>
          createIsolatedTestFirestoreClient({
            runId: 'run_check_2',
            projectId: PROD_FIREBASE_PROJECT_ID,
            databaseId: 'isolated-test-db',
          }),
        /TEST_FIRESTORE_PROD_ISOLATION_VIOLATION/
      );
      assert.throws(
        () =>
          createIsolatedTestFirestoreClient({
            runId: 'run_check_3',
            projectId: 'isolated-test-project',
            databaseId: PROD_FIRESTORE_DATABASE_ID,
          }),
        /TEST_FIRESTORE_PROD_ISOLATION_VIOLATION/
      );
      assert.throws(
        () =>
          createIsolatedTestFirestoreClient({
            runId: 'run_check_4',
            projectId: 'isolated-test-project',
            databaseId: '(default)',
          }),
        /TEST_FIRESTORE_PROD_ISOLATION_VIOLATION/
      );
    });

    it('E-9: 운영 모드 테스트 임베딩 강제 요청 차단, 클라이언트 DI/테스트 모드 주입 차단, API 키 부재 시 기존 LIVE_API 색인 보존을 검증한다', async () => {
      const guardOwner = 'author_guard_e9';
      const guardProj = 'proj_guard_e9';

      await deleteProjectIndexOnServer({
        ownerId: guardOwner,
        projectId: guardProj,
      });

      try {
        // 1) 클라이언트 API(index-entity / search)를 통한 테스트 모드 및 DI 파라미터 주입 차단 검증
        assert.throws(
          () =>
            assertNoClientTestEmbeddingModeInjection({
              input: {
                embeddingGenerationMode: 'DETERMINISTIC_TEST',
              },
            }),
          /CLIENT_TEST_EMBEDDING_INJECTION_BLOCKED/
        );
        assert.throws(
          () =>
            assertNoClientTestEmbeddingModeInjection({
              body: {
                preferDeterministicEmbeddings: true,
              },
            }),
          /CLIENT_TEST_EMBEDDING_INJECTION_BLOCKED/
        );
        assert.throws(
          () =>
            assertNoClientTestEmbeddingModeInjection({
              body: {
                db: { fake: true },
              },
            }),
          /CLIENT_TEST_EMBEDDING_INJECTION_BLOCKED/
        );
        assert.throws(
          () =>
            assertNoClientTestEmbeddingModeInjection({
              options: {
                cacheNamespace: 'spoofed_namespace',
              },
            }),
          /CLIENT_TEST_EMBEDDING_INJECTION_BLOCKED/
        );

        // 2) 기존 정상 LIVE_API 색인 생성 (Mock Gemini API 어댑터 사용)
        setCustomGeminiEmbedContentForTesting(async ({ contents }) => ({
          embeddings: [
            { values: computeDeterministicSemanticEmbedding(contents, 768) },
          ],
        }));

        const liveIndexed = await indexMemoryInputOnServer({
          ownerId: guardOwner,
          projectId: guardProj,
          sourceEntityType: 'EPISODE',
          sourceEntityId: 'ep_live_keep',
          sourceRevisionId: 'rev_live_v1',
          episodeId: 'ep_live_keep',
          episodeNumber: 1,
          title: '제1화 정상 운영 색인 원고',
          fullText: '성녀 아리아는 백은의 성당에서 고대 치유 주문을 완성했다.',
          canonStatus: 'CANON',
          embeddingModelId: 'gemini-embedding-2',
          embeddingGenerationMode: 'LIVE_API',
        });
        assert.equal(liveIndexed.document.embeddingGenerationMode, 'LIVE_API');
        assert.equal(liveIndexed.document.embeddingModelId, 'gemini-embedding-2');

        // 3) API 키 부재 상태에서 LIVE_API 재색인 요청 시 503 실패 및 기존 LIVE_API 색인 보존 확인
        setCustomGeminiEmbedContentForTesting(null);
        clearEmbeddingCacheForTesting();
        const origKey = process.env.GEMINI_API_KEY;
        try {
          delete process.env.GEMINI_API_KEY;
          await assert.rejects(
            async () => {
              await indexMemoryInputOnServer({
                ownerId: guardOwner,
                projectId: guardProj,
                sourceEntityType: 'EPISODE',
                sourceEntityId: 'ep_live_keep',
                sourceRevisionId: 'rev_live_v2_no_key',
                episodeId: 'ep_live_keep',
                episodeNumber: 1,
                title: '제1화 키 누락 상태 수정 시도',
                fullText: '키가 없을 때 실패해야 하는 수정본입니다.',
                canonStatus: 'CANON',
                embeddingGenerationMode: 'LIVE_API',
              });
            },
            /GEMINI_API_KEY_MISSING/
          );

          // 실패 후에도 기존 정상 LIVE_API 색인(rev_live_v1)은 삭제되거나 오염되지 않고 그대로 유지되어야 함
          const preservedCheck = await searchProjectMemoryOnServer({
            ownerId: guardOwner,
            query: {
              projectId: guardProj,
              queryText: '성녀 아리아 백은의 성당',
              searchMode: 'KEYWORD',
            },
          });
          assert.equal(preservedCheck.hits.length, 1);
          assert.equal(
            preservedCheck.hits[0].chunk.sourceRevisionId,
            'rev_live_v1'
          );
          assert.equal(
            preservedCheck.hits[0].chunk.embeddingGenerationMode,
            'LIVE_API'
          );
        } finally {
          if (origKey !== undefined) {
            process.env.GEMINI_API_KEY = origKey;
          }
        }

        // 4) 운영 클라우드 인증 강제 모드에서 결정적 테스트 임베딩 생성 시도 차단(403)
        setServerCloudAuthEnforcementForTesting(true);
        setCustomFirestoreProjectLookupForTesting(async ({ authenticatedUid }) => ({
          existsUnderUserPath: true,
          docOwnerId: authenticatedUid,
          actualOwnerInDatabase: authenticatedUid,
        }));
        try {
          await assert.rejects(
            async () => {
              await indexMemoryInputOnServer(
                {
                  ownerId: guardOwner,
                  projectId: guardProj,
                  sourceEntityType: 'EPISODE',
                  sourceEntityId: 'ep_test_forbidden',
                  sourceRevisionId: 'rev_test_1',
                  title: '운영 환경 테스트 벡터 주입 시도',
                  fullText: '운영 환경에서는 차단되어야 합니다.',
                  canonStatus: 'CANON',
                  embeddingGenerationMode: 'DETERMINISTIC_TEST',
                  embeddingModelId: DETERMINISTIC_TEST_EMBEDDING_MODEL_ID,
                },
                { preferDeterministicEmbeddings: true }
              );
            },
            /TEST_EMBEDDING_FORBIDDEN_IN_PRODUCTION/
          );
        } finally {
          setServerCloudAuthEnforcementForTesting(null);
          clearProjectOwnerRegistryForTesting();
        }
      } finally {
        setCustomGeminiEmbedContentForTesting(null);
        await deleteProjectIndexOnServer({
          ownerId: guardOwner,
          projectId: guardProj,
        });
      }
    });
  });

  // ==========================================================================
  // Test F: 데이터 무결성(원본 리비전 보존, 부분 동기화 보호, 벡터 인덱스 정의 & Optional DI 격리) 검증
  // ==========================================================================
  describe('Test F: 원본 리비전 보존, 부분 동기화 보호, 벡터 인덱스 규격 및 Optional DI 격리 검증', () => {
    it('F-1: 전체 재색인(forceRebuild) 시 원본 sourceRevisionId가 변조 없이 보존되고, 10개 회차 중 5개만 부분 동기화해도 나머지 5개 회차 색인이 삭제되지 않는다', async () => {
      const syncOwner = 'author_sync_f1';
      const syncProjId = 'proj_sync_f1';

      await deleteProjectIndexOnServer({
        ownerId: syncOwner,
        projectId: syncProjId,
      });

      try {
        const projectObj: Project = {
          id: syncProjId,
          ownerId: syncOwner,
          title: '불멸의 연대기',
          genre: '판타지',
          synopsis: '10개 회차 부분 동기화 보호 검증용 작품',
          status: 'confirmed',
          canonStatus: 'CANON',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const uniqueWords = [
          '알파성탑수호검',
          '베타성탑수호검',
          '감마성탑수호검',
          '델타성탑수호검',
          '엡실론성탑수호검',
          '제타성탑수호검',
          '에타성탑수호검',
          '세타성탑수호검',
          '이오타성탑수호검',
          '카파성탑수호검',
        ];
        const tenEpisodes: Episode[] = Array.from({ length: 10 }, (_, idx) => {
          const epNum = idx + 1;
          const content = `${uniqueWords[idx]} 카엘은 ${epNum}번째 성탑의 수호자를 격파하고 고대 각인을 획득했다.`;
          return {
            id: `ep_sync_${epNum}`,
            ownerId: syncOwner,
            projectId: syncProjId,
            episodeNumber: epNum,
            title: `제${epNum}화 불멸의 기록`,
            content,
            synopsis: `${epNum}화 요약`,
            authorNote: '',
            charCountWithSpaces: content.length,
            charCountWithoutSpaces: content.replace(/\s+/g, '').length,
            status: 'confirmed',
            canonStatus: 'CANON',
            linkedCharacterIds: [],
            linkedWorldbuildingIds: [],
            latestRevisionId: `rev_authentic_ep_${epNum}_v1`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        });

        // 1) 10개 회차 전체 색인 및 강제 재색인(forceRebuild: true) 후 원본 sourceRevisionId 보존 확인
        await syncOrRebuildProjectIndexOnServer({
          ownerId: syncOwner,
          projectId: syncProjId,
          project: projectObj,
          characters: [],
          worldbuilding: [],
          episodes: tenEpisodes,
          forceRebuild: true,
          authorConfirmedBulk: true,
          preferDeterministicEmbeddings: true,
        });

        const checkEp1 = await searchProjectMemoryOnServer({
          ownerId: syncOwner,
          query: {
            projectId: syncProjId,
            queryText: '알파성탑수호검',
            episodeId: 'ep_sync_1',
            searchMode: 'KEYWORD',
          },
          preferDeterministicEmbeddings: true,
        });
        assert.equal(checkEp1.hits.length, 1);
        assert.equal(
          checkEp1.hits[0].chunk.sourceRevisionId,
          'rev_authentic_ep_1_v1',
          '재색인 후에도 _rebuild_ 타임스탬프 오염 없이 원본 sourceRevisionId가 그대로 보존되어야 합니다.'
        );

        // 2) 클라이언트가 1~5화(5개)만 부분 전송하여 동기화 수행 -> 6~10화 색인이 삭제되지 않아야 함
        const partialFiveEpisodes = tenEpisodes.slice(0, 5);
        await syncOrRebuildProjectIndexOnServer({
          ownerId: syncOwner,
          projectId: syncProjId,
          project: projectObj,
          characters: [],
          worldbuilding: [],
          episodes: partialFiveEpisodes,
          forceRebuild: false,
          preferDeterministicEmbeddings: true,
        });

        const checkEp10AfterPartial = await searchProjectMemoryOnServer({
          ownerId: syncOwner,
          query: {
            projectId: syncProjId,
            queryText: '카파성탑수호검',
            episodeId: 'ep_sync_10',
            searchMode: 'KEYWORD',
          },
          preferDeterministicEmbeddings: true,
        });
        assert.equal(
          checkEp10AfterPartial.hits.length,
          1,
          '부분 동기화 목록에서 누락된 10화의 기존 정상 색인이 삭제되면 안 됩니다.'
        );
        assert.equal(
          checkEp10AfterPartial.hits[0].chunk.sourceRevisionId,
          'rev_authentic_ep_10_v1'
        );
      } finally {
        await deleteProjectIndexOnServer({
          ownerId: syncOwner,
          projectId: syncProjId,
        });
      }
    });

    it('F-2: 기본 임베딩 모델(gemini-embedding-2, 768차원), 복합 벡터 인덱스 규격, INDEX_NOT_READY 오류 분류, Optional DI(db, cacheNamespace) 격리 및 4단계 하위 컬렉션 정리가 정확히 작동한다', async () => {
      assert.equal(getConfiguredEmbeddingModel(), 'gemini-embedding-2');
      assert.equal(getConfiguredEmbeddingDimension(), 768);

      const indexesRaw = fs.readFileSync(
        path.resolve(process.cwd(), 'firestore.indexes.json'),
        'utf8'
      );
      const parsed = JSON.parse(indexesRaw) as {
        indexes: {
          collectionGroup: string;
          queryScope: string;
          fields: {
            fieldPath: string;
            order?: string;
            vectorConfig?: { dimension: number; flat?: Record<string, unknown> };
          }[];
        }[];
      };

      const collectionIndexes = parsed.indexes.filter(
        (idx) =>
          idx.collectionGroup === 'memoryChunks' &&
          idx.queryScope === 'COLLECTION'
      );

      // 1) CANON 전용 검색 필터 조합 검증
      const hasCanonVectorIndex = collectionIndexes.some((idx) => {
        const paths = idx.fields.map((f) => f.fieldPath);
        const vecField = idx.fields.find(
          (f) => f.fieldPath === 'embeddingVector'
        );
        return (
          paths.includes('ownerId') &&
          paths.includes('projectId') &&
          paths.includes('embeddingGenerationMode') &&
          paths.includes('embeddingModelId') &&
          paths.includes('canonStatus') &&
          paths[paths.length - 1] === 'embeddingVector' &&
          vecField?.vectorConfig?.dimension === 768 &&
          Boolean(vecField?.vectorConfig?.flat)
        );
      });
      assert.equal(
        hasCanonVectorIndex,
        true,
        'CANON 필터 포함 검색을 지원하는 768차원 COLLECTION 복합 벡터 인덱스가 존재해야 합니다.'
      );

      // 2) CANON 필터 미포함(초안 포함) 검색 필터 조합 검증
      const hasAllStatusVectorIndex = collectionIndexes.some((idx) => {
        const paths = idx.fields.map((f) => f.fieldPath);
        const vecField = idx.fields.find(
          (f) => f.fieldPath === 'embeddingVector'
        );
        return (
          paths.includes('ownerId') &&
          paths.includes('projectId') &&
          paths.includes('embeddingGenerationMode') &&
          paths.includes('embeddingModelId') &&
          !paths.includes('canonStatus') &&
          paths[paths.length - 1] === 'embeddingVector' &&
          vecField?.vectorConfig?.dimension === 768 &&
          Boolean(vecField?.vectorConfig?.flat)
        );
      });
      assert.equal(
        hasAllStatusVectorIndex,
        true,
        'CANON 필터 없는 검색을 지원하는 768차원 COLLECTION 복합 벡터 인덱스가 존재해야 합니다.'
      );

      // 3) Phase 3.2.1 Section 8.2: INDEX_NOT_READY vs 권한/쿼리 오류 엄격 구분 검증
      assert.equal(
        isFirestoreVectorIndexMissingOrBuildingError({
          code: 9,
          message:
            '9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/.../firestore/indexes?create_composite=...',
        }),
        true
      );
      assert.equal(
        isFirestoreVectorIndexMissingOrBuildingError({
          code: 9,
          message:
            '9 FAILED_PRECONDITION: The index is currently building and cannot be used yet.',
        }),
        true
      );
      assert.equal(
        isFirestoreVectorIndexMissingOrBuildingError({
          code: 7,
          message: '7 PERMISSION_DENIED: Missing or insufficient permissions.',
        }),
        false
      );
      assert.equal(
        isFirestoreVectorIndexMissingOrBuildingError({
          code: 16,
          message: '16 UNAUTHENTICATED: Request had invalid authentication credentials.',
        }),
        false
      );
      assert.equal(
        isFirestoreVectorIndexMissingOrBuildingError({
          code: 3,
          message: '3 INVALID_ARGUMENT: Vector dimension mismatch.',
        }),
        false
      );

      // 4) Phase 3.2.1 Optional DI (`db`, `cacheNamespace`) 및 4단계 하위 컬렉션 완전 삭제(`purgeIsolatedTestProjectData`) 검증
      const inMemoryDocs = new Map<string, Record<string, unknown>>();
      const deletionOrder: string[] = [];

      const makeDocSnap = (docPath: string) => ({
        id: docPath.split('/').pop() || '',
        exists: inMemoryDocs.has(docPath),
        data: () => inMemoryDocs.get(docPath),
        ref: {
          path: docPath,
          delete: async () => {
            deletionOrder.push(docPath);
            inMemoryDocs.delete(docPath);
          },
        },
      });

      const fakeIsolatedDb = {
        doc: (docPath: string) => ({
          path: docPath,
          get: async () => makeDocSnap(docPath),
          set: async (
            data: Record<string, unknown>,
            opts?: { merge?: boolean }
          ) => {
            const prev = opts?.merge ? inMemoryDocs.get(docPath) || {} : {};
            inMemoryDocs.set(docPath, { ...prev, ...data });
          },
          delete: async () => {
            deletionOrder.push(docPath);
            inMemoryDocs.delete(docPath);
          },
        }),
        collection: (colPath: string) => {
          const buildQuery = (
            filters: { field: string; val: unknown }[] = []
          ) => ({
            where: (field: string, _op: string, val: unknown) =>
              buildQuery([...filters, { field, val }]),
            get: async () => {
              const prefix = `${colPath}/`;
              const matched = Array.from(inMemoryDocs.entries())
                .filter(([k, v]) => {
                  if (!k.startsWith(prefix)) return false;
                  const rest = k.slice(prefix.length);
                  if (rest.includes('/')) return false;
                  return filters.every((f) => v[f.field] === f.val);
                })
                .map(([k]) => makeDocSnap(k));
              return {
                empty: matched.length === 0,
                size: matched.length,
                docs: matched,
              };
            },
          });
          return buildQuery();
        },
        batch: () => {
          const ops: (() => void)[] = [];
          return {
            set: (
              ref: { path: string },
              data: Record<string, unknown>,
              opts?: { merge?: boolean }
            ) => {
              ops.push(() => {
                const prev = opts?.merge
                  ? inMemoryDocs.get(ref.path) || {}
                  : {};
                inMemoryDocs.set(ref.path, { ...prev, ...data });
              });
            },
            delete: (ref: { path: string }) => {
              ops.push(() => {
                deletionOrder.push(ref.path);
                inMemoryDocs.delete(ref.path);
              });
            },
            commit: async () => {
              for (const op of ops) op();
            },
          };
        },
        runTransaction: async <T>(
          updateFn: (tx: {
            get: (ref: { path: string }) => Promise<ReturnType<typeof makeDocSnap>>;
            set: (
              ref: { path: string },
              data: Record<string, unknown>,
              opts?: { merge?: boolean }
            ) => void;
          }) => Promise<T>
        ): Promise<T> => {
          const tx = {
            get: async (ref: { path: string }) => makeDocSnap(ref.path),
            set: (
              ref: { path: string },
              data: Record<string, unknown>,
              opts?: { merge?: boolean }
            ) => {
              const prev = opts?.merge
                ? inMemoryDocs.get(ref.path) || {}
                : {};
              inMemoryDocs.set(ref.path, { ...prev, ...data });
            },
          };
          return updateFn(tx);
        },
      } as unknown as Firestore;

      const diRunId = 'unit_di_run_001';
      const diOwner = `test_owner_live_${diRunId}`;
      const diProject = `test_proj_live_${diRunId}`;
      const diNamespace = `ns_${diRunId}`;
      const diBasePath = `users/${diOwner}/projects/${diProject}`;

      await fakeIsolatedDb.doc(diBasePath).set({
        id: diProject,
        ownerId: diOwner,
        title: 'DI 격리 검증 작품',
        isIsolatedLiveTest: true,
        testRunId: diRunId,
      });

      // 주입된 Firestore(db) 모드에서 DETERMINISTIC_TEST 벡터 생성을 시도하면 즉시 403으로 차단됨을 검증
      await assert.rejects(
        async () => {
          await indexMemoryInputOnServer(
            {
              ownerId: diOwner,
              projectId: diProject,
              sourceEntityType: 'EPISODE',
              sourceEntityId: 'ep_di_blocked',
              sourceRevisionId: 'rev_di_v1',
              title: '테스트 벡터 차단 확인',
              fullText: '주입된 DB에서는 테스트 벡터가 차단되어야 한다.',
              canonStatus: 'CANON',
            },
            {
              preferDeterministicEmbeddings: true,
              db: fakeIsolatedDb,
              cacheNamespace: diNamespace,
            }
          );
        },
        /TEST_EMBEDDING_FORBIDDEN_IN_PRODUCTION/
      );

      setCustomGeminiEmbedContentForTesting(async ({ contents }) => ({
        embeddings: [
          { values: computeDeterministicSemanticEmbedding(contents, 768) },
        ],
      }));

      try {
        await indexMemoryInputOnServer(
          {
            ownerId: diOwner,
            projectId: diProject,
            sourceEntityType: 'EPISODE',
            sourceEntityId: 'ep_di_1',
            sourceRevisionId: 'rev_di_v1',
            episodeId: 'ep_di_1',
            episodeNumber: 1,
            title: '제1화 DI 격리 원고',
            fullText:
              '주입된 전용 DB에만 기록되고 기본 스토어와는 완전히 격리된다.',
            canonStatus: 'CANON',
            embeddingModelId: 'gemini-embedding-2',
            embeddingGenerationMode: 'LIVE_API',
          },
          {
            db: fakeIsolatedDb,
            cacheNamespace: diNamespace,
          }
        );

        // 기본 네임스페이스(운영/기본 스토어)에는 해당 프로젝트 문서가 전혀 없어야 함
        const defaultNamespaceStatus = getProjectRagStatusOnServer({
          ownerId: diOwner,
          projectId: diProject,
        });
        assert.equal(defaultNamespaceStatus.totalDocuments, 0);

        // 주입된 DI 네임스페이스에는 정상 색인 문서 1개(ep_di_1)와 앞서 차단된 실패 기록 1개(ep_di_blocked)만 존재하며 기본 네임스페이스에는 전혀 섞이지 않음
        const diNamespaceStatus = getProjectRagStatusOnServer({
          ownerId: diOwner,
          projectId: diProject,
          db: fakeIsolatedDb,
          cacheNamespace: diNamespace,
        });
        assert.equal(diNamespaceStatus.statusCounts.INDEXED, 1);
        assert.equal(diNamespaceStatus.statusCounts.FAILED, 1);

        // 4단계 하위 컬렉션 완전 정리(memoryChunks -> memoryDocuments -> ragManifest -> parent project doc) 검증
        const purgeRes = await purgeIsolatedTestProjectData({
          db: fakeIsolatedDb,
          testOwnerId: diOwner,
          testProjectId: diProject,
          expectedRunId: diRunId,
          cacheNamespace: diNamespace,
        });
        assert.ok(purgeRes.deletedChunks > 0);
        assert.equal(purgeRes.deletedDocuments, 1);
        assert.equal(purgeRes.deletedProjectRoot, true);
        assert.equal(purgeRes.remainingChunks, 0);
        assert.equal(purgeRes.remainingDocuments, 0);
        assert.equal(purgeRes.remainingManifests, 0);
        assert.equal(purgeRes.remainingProjectRoot, 0);
        assert.equal(inMemoryDocs.size, 0);

        const firstChunkIdx = deletionOrder.findIndex((p) =>
          p.includes('/memoryChunks/')
        );
        const firstDocIdx = deletionOrder.findIndex((p) =>
          p.includes('/memoryDocuments/')
        );
        const firstManifestIdx = deletionOrder.findIndex((p) =>
          p.includes('/ragManifest/')
        );
        const rootDeleteIdx = deletionOrder.findIndex((p) => p === diBasePath);
        assert.ok(firstChunkIdx >= 0 && firstDocIdx > firstChunkIdx);
        assert.ok(
          firstManifestIdx > firstDocIdx && rootDeleteIdx > firstManifestIdx
        );
      } finally {
        setCustomGeminiEmbedContentForTesting(null);
      }
    });
  });
});

