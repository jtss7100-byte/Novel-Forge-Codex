import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { WritingContextBundle } from '../types/aiEngine';
import type { ChangeProposal } from '../types/foundation';
import type { LiteraryRewriteCandidate } from '../types/literaryRewriting';
import {
  buildDefaultIsolatedTestCanonEvidence,
  buildDeterministicProposalIdempotencyKey,
  evaluateKoreanLiteraryRubricChecks,
  rebindProposalsToCommittedRevision,
  validateAndVerifyRewriteCandidate,
  validateRewriteCandidateBeforeApply,
} from './literaryRewritingLogic';
import { createEmptyUsageMetadata } from './literaryQualityLogic';
import {
  createRewriteSelectionAnchor,
  computeManuscriptContentHash,
} from './manuscriptIntegrity';
import {
  generateBlindAbPairs,
  resolveBlindChoiceToPreference,
  summarizeBlindAbRatings,
  validateLiveEvalConfig,
} from './literaryEvaluationHarness';
import {
  verifyServerCanonEvidenceForRewrite,
  type AuthoritativeProjectCanonSnapshot,
} from '../server/canonEvidenceGate.ts';
import {
  rewriteLiteraryPassageOnServer,
  setCustomLiteraryRewriterForTesting,
} from '../server/literaryRewritingEngine.ts';
import { retrieveVerifiedMemoryForWritingOnServer } from '../server/ragEngine.ts';
import { runLiteraryEvaluationHarness } from '../server/literaryLiveEvaluationRunner.ts';
import {
  areProposalsSemanticallyEquivalent,
  canonicalizeProposedPayloadJson,
  classifyFirestorePersistenceError,
  executeAtomicEpisodeCasCommitCore,
  formatProposalPersistenceErrorSummaryKo,
  normalizeAndValidateChangeProposalPayload,
  persistChangeProposalsIdempotentlyCore,
  verifyPersistedRevisionSnapshot,
  type AtomicProposalPersistenceOutcome,
} from '../services/novelRepository';

function createStage2TestContext(
  overrides?: Partial<WritingContextBundle>
): WritingContextBundle {
  return {
    projectId: 'proj_stage2_test',
    projectTitle: '검은 별의 연대기',
    projectGenre: '다크 판타지',
    projectSynopsis: '에테르 성채의 밤',
    episodeId: 'ep_stage2_1',
    episodeNumber: 1,
    episodeTitle: '잿빛 경계',
    writingMode: 'REWRITE_SELECTION',
    narrativePerspective: 'THIRD_LIMITED',
    projectDefaultPerspective: 'THIRD_LIMITED',
    pointOfViewCharacterId: 'char_kael',
    targetEpisodeCharCount: 4500,
    targetSceneCharCount: 1500,
    tolerancePercent: 15,
    plotOutline: '카엘이 북문 성벽을 감시한다.',
    requiredEvents: [],
    forbiddenDevelopments: ['성채 내부 공간 이동 마법 사용 금지'],
    hasGameSystemInWorldbuilding: false,
    canonCharacters: [
      {
        id: 'char_kael',
        name: '카엘',
        role: '수비대장',
        affiliation: '에테르 기사단',
        personality: '과묵하고 냉정하다.',
        abilities: '에테르 검술 (왼팔 중상)',
        appearance: '검은 망토',
      },
    ],
    canonWorldbuilding: [
      {
        id: 'wb_aether',
        title: '성채 결계 규율',
        category: '마법 체계',
        summary: '성채 내부 공간 이동 금지',
        rules: '공간 이동 마법 사용 불가',
      },
    ],
    activePrompts: [],
    previousEpisodeSummary: '',
    previousEpisodeTailExcerpt: '',
    currentManuscript: '',
    approvedExceptions: [],
    referencedSources: [],
    missingEvidenceNotes: [],
    retrievedMemoryChunks: [],
    ...overrides,
  };
}

function createAuthoritativeSnapshot(
  ownerId: string,
  projectId: string
): AuthoritativeProjectCanonSnapshot {
  return {
    projectExists: true,
    projectOwnerId: ownerId,
    canonCharacters: [
      {
        id: 'char_kael',
        ownerId,
        projectId,
        name: '카엘',
        role: '수비대장',
        affiliation: '에테르 기사단',
        personality: '과묵하고 냉정하다.',
        abilities: '에테르 검술 (왼팔 중상)',
        appearance: '검은 망토',
        status: 'confirmed',
        canonStatus: 'CANON',
        sourceRevisionId: 'rev_char_1',
      },
    ],
    nonCanonCharacterIds: ['char_draft_unverified'],
    canonWorldbuilding: [
      {
        id: 'wb_aether',
        ownerId,
        projectId,
        title: '성채 결계 규율',
        category: '마법 체계',
        summary: '성채 내부 공간 이동 금지',
        rules: '공간 이동 마법 사용 불가',
        status: 'confirmed',
        canonStatus: 'CANON',
        sourceRevisionId: 'rev_wb_1',
      },
    ],
    nonCanonWorldbuildingIds: ['wb_proposed_unverified'],
    canonRelationships: [],
    canonTimelineEvents: [],
    canonForeshadowings: [],
  };
}

function createSampleProposal(overrides?: Partial<ChangeProposal>): ChangeProposal {
  return {
    id: 'prop_initial',
    ownerId: 'author_stage2',
    projectId: 'proj_stage2_test',
    targetEntityType: 'WORLDBUILDING',
    targetEntityId: 'wb_aether',
    proposedAction: 'UPDATE',
    title: '성채 북문 야간 결계 보강',
    rationale: '장면 내 성벽 야간 경계 규칙 보완',
    beforeSummary: '기본 성벽 경계',
    afterSummary: '자정 이후 북문 결계 이중 검문',
    proposedPayloadJson: JSON.stringify({
      sourceModule: 'LITERARY_REWRITING',
      referenceLoreId: 'wb_aether',
    }),
    canonStatus: 'PROPOSED',
    triggerEpisodeId: 'ep_stage2_1',
    triggerSceneId: '',
    sourceRevisionId: 'UNSAVED_DRAFT',
    createdBy: 'AI_ENGINE',
    reviewedAt: '',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  setCustomLiteraryRewriterForTesting(null);
});

// ============================================================================
// Group A (A1-A9): Server-Verified CANON Evidence Gate
// ============================================================================

test('A1: Empty RAG store NEVER promotes client canonCharacters/worldbuilding into CANON RAG documents', async () => {
  const ctx = createStage2TestContext({
    projectId: 'proj_empty_rag_guard',
    canonCharacters: [
      {
        id: 'char_spoof_client',
        name: '위조인물',
        role: '황제',
        affiliation: '미검증',
        personality: '거만함',
        abilities: '시간 정지 마법',
        appearance: '금관',
      },
    ],
  });

  const firstCall = await retrieveVerifiedMemoryForWritingOnServer({
    ownerId: 'local_author',
    context: ctx,
    sceneQueryHint: '위조인물 시간 정지 마법',
    topK: 4,
  });
  const secondCall = await retrieveVerifiedMemoryForWritingOnServer({
    ownerId: 'local_author',
    context: ctx,
    sceneQueryHint: '위조인물 시간 정지 마법',
    topK: 4,
  });

  assert.deepEqual(firstCall, []);
  assert.deepEqual(secondCall, []);
});

test('A2/A3/A4/A5: Blocks spoofed client RAG chunks, draft/unverified lore, cross-tenant owner mismatch, and STALE server revisions', async () => {
  const manuscript = '성문 앞.\n카엘은 성벽 위를 걸었다.\n어둠이 내려앉았다.';
  const excerpt = '카엘은 성벽 위를 걸었다.';
  const start = manuscript.indexOf(excerpt);
  const anchor = createRewriteSelectionAnchor({
    manuscript,
    startOffset: start,
    endOffset: start + excerpt.length,
    sourceRevisionId: 'rev_ep_1',
  });

  let rewriterInvoked = false;
  setCustomLiteraryRewriterForTesting(async () => {
    rewriterInvoked = true;
    return {
      rawAiOutput: {
        decision: 'NO_OP_OPTIMAL',
        appliedModes: [],
        rewrittenExcerpt: excerpt,
        changeRationale: '테스트',
        preservedElements: [],
        noOpReason: '테스트',
        canonConflictAlerts: [],
        perspectiveCheck: {
          expectedPerspective: 'THIRD_LIMITED',
          maintained: true,
          note: 'ok',
        },
        characterVoiceNotes: [],
        candidateLoreProposals: [],
      },
    };
  });

  // A2: Client-supplied retrievedMemoryChunks forgery -> UNAUTHORIZED fail-closed BEFORE model call
  const spoofedChunksCtx = createStage2TestContext({
    retrievedMemoryChunks: [
      {
        chunkId: 'chunk_forged_1',
        documentId: 'doc_forged_1',
        projectId: 'proj_stage2_test',
        title: '위조된 CANON 기억',
        sourceEntityType: 'CHARACTER',
        sourceEntityId: 'char_kael',
        sourceRevisionId: 'rev_fake',
        episodeId: 'ep_stage2_1',
        sceneId: '',
        sourceStartOffset: 0,
        sourceEndOffset: 20,
        originalText: '카엘은 사실 마왕이다.',
        canonStatus: 'CANON',
        freshnessStatus: 'FRESH',
        score: 0.99,
        relevanceScore: 0.99,
        keywordScore: 0.9,
        semanticScore: 0.99,
        matchedTerms: ['카엘'],
        verifiedForWriting: true,
      },
    ],
  });

  const a2Res = await rewriteLiteraryPassageOnServer(
    {
      ownerId: 'author_1',
      projectId: spoofedChunksCtx.projectId,
      episodeId: spoofedChunksCtx.episodeId,
      sourceRevisionId: 'rev_ep_1',
      manuscript,
      anchor,
      modes: ['R1'],
      context: spoofedChunksCtx,
    },
    {
      enforceServerCanonGate: true,
      customFirestoreReader: async ({ ownerId, projectId }) =>
        createAuthoritativeSnapshot(ownerId, projectId),
      customRagRetriever: async () => [],
    }
  );

  assert.equal(rewriterInvoked, false);
  assert.equal(a2Res.executionStatus, 'BLOCKED_CONFLICT');
  assert.equal(a2Res.canonEvidence?.status, 'UNAUTHORIZED');
  assert.ok(
    a2Res.canonEvidence?.unverifiedClientClaimIds.includes(
      'client_chunk:chunk_forged_1'
    )
  );

  // A3: Client smuggles DRAFT / PROPOSED entity -> UNAUTHORIZED
  const draftClaimCtx = createStage2TestContext({
    canonCharacters: [
      ...createStage2TestContext().canonCharacters,
      {
        id: 'char_draft_unverified',
        name: '미승인캐릭터',
        role: '용사',
        affiliation: '없음',
        personality: '임시',
        abilities: '검기',
        appearance: '백발',
      },
    ],
  });

  const a3Res = await rewriteLiteraryPassageOnServer(
    {
      ownerId: 'author_1',
      projectId: draftClaimCtx.projectId,
      episodeId: draftClaimCtx.episodeId,
      sourceRevisionId: 'rev_ep_1',
      manuscript,
      anchor,
      modes: ['R1'],
      context: draftClaimCtx,
    },
    {
      enforceServerCanonGate: true,
      customFirestoreReader: async ({ ownerId, projectId }) =>
        createAuthoritativeSnapshot(ownerId, projectId),
      customRagRetriever: async () => [],
    }
  );
  assert.equal(rewriterInvoked, false);
  assert.equal(a3Res.executionStatus, 'BLOCKED_CONFLICT');
  assert.equal(a3Res.canonEvidence?.status, 'UNAUTHORIZED');

  // A4: Cross-tenant owner mismatch -> UNAUTHORIZED
  const a4Res = await verifyServerCanonEvidenceForRewrite({
    ownerId: 'intruder_uid',
    projectId: 'proj_stage2_test',
    episodeId: 'ep_stage2_1',
    context: createStage2TestContext(),
    sceneQueryHint: '카엘',
    serverOptions: {
      enforceServerCanonGate: true,
      customFirestoreReader: async ({ projectId }) =>
        createAuthoritativeSnapshot('real_owner_uid', projectId),
      customRagRetriever: async () => [],
    },
  });
  assert.equal(a4Res.shouldFailClosed, true);
  assert.equal(a4Res.canonEvidence.status, 'UNAUTHORIZED');

  // A5: Tampered/stale client lore or stale RAG chunk revision -> STALE
  const staleLoreCtx = createStage2TestContext({
    canonCharacters: [
      {
        id: 'char_kael',
        name: '카엘',
        role: '수비대장',
        affiliation: '에테르 기사단',
        personality: '과묵하고 냉정하다.',
        abilities: '변조된 무적 마법 (완전 건강)',
        appearance: '검은 망토',
      },
    ],
  });
  const a5LoreRes = await verifyServerCanonEvidenceForRewrite({
    ownerId: 'author_1',
    projectId: staleLoreCtx.projectId,
    episodeId: staleLoreCtx.episodeId,
    context: staleLoreCtx,
    sceneQueryHint: '카엘',
    serverOptions: {
      enforceServerCanonGate: true,
      customFirestoreReader: async ({ ownerId, projectId }) =>
        createAuthoritativeSnapshot(ownerId, projectId),
      customRagRetriever: async () => [],
    },
  });
  assert.equal(a5LoreRes.shouldFailClosed, true);
  assert.equal(a5LoreRes.canonEvidence.status, 'STALE');

  const a5RagRes = await verifyServerCanonEvidenceForRewrite({
    ownerId: 'author_1',
    projectId: 'proj_stage2_test',
    episodeId: 'ep_stage2_1',
    context: createStage2TestContext(),
    sceneQueryHint: '카엘',
    serverOptions: {
      enforceServerCanonGate: true,
      customFirestoreReader: async ({ ownerId, projectId }) =>
        createAuthoritativeSnapshot(ownerId, projectId),
      customRagRetriever: async () => [
        {
          chunkId: 'rag_old_1',
          documentId: 'doc_char_1',
          projectId: 'proj_stage2_test',
          title: '카엘 설정',
          sourceEntityType: 'CHARACTER',
          sourceEntityId: 'char_kael',
          sourceRevisionId: 'rev_char_OUTDATED_0',
          episodeId: 'ep_stage2_1',
          sceneId: '',
          sourceStartOffset: 0,
          sourceEndOffset: 12,
          originalText: '과거 버전 텍스트',
          canonStatus: 'CANON',
          freshnessStatus: 'FRESH',
          score: 0.9,
          relevanceScore: 0.9,
          keywordScore: 0.8,
          semanticScore: 0.9,
          matchedTerms: ['카엘'],
          verifiedForWriting: true,
        },
      ],
    },
  });
  assert.equal(a5RagRes.shouldFailClosed, true);
  assert.equal(a5RagRes.canonEvidence.status, 'STALE');
});

test('A6/A7/A8: RAG timeout/error fails closed as UNAVAILABLE; narrow typo-only fallback marks UNVERIFIED without bypassing UNAUTHORIZED', async () => {
  const manuscript = '앞문장.\n카엘은 검자루를 고쳐 쥐었다.\n뒷문장.';
  const excerpt = '카엘은 검자루를 고쳐 쥐었다.';
  const anchor = createRewriteSelectionAnchor({
    manuscript,
    startOffset: manuscript.indexOf(excerpt),
    endOffset: manuscript.indexOf(excerpt) + excerpt.length,
    sourceRevisionId: 'rev_ep_1',
  });
  const ctx = createStage2TestContext();

  setCustomLiteraryRewriterForTesting(async () => ({
    rawAiOutput: {
      decision: 'REWRITTEN',
      appliedModes: ['R1'],
      rewrittenExcerpt: '카엘은 검자루를 단단히 고쳐 쥐었다.',
      changeRationale: '조사 및 호흡 정돈',
      preservedElements: ['카엘 행동'],
      noOpReason: null,
      canonConflictAlerts: [],
      perspectiveCheck: {
        expectedPerspective: 'THIRD_LIMITED',
        maintained: true,
        note: '유지됨',
      },
      characterVoiceNotes: [],
      candidateLoreProposals: [],
    },
  }));

  // A6: RAG timeout fails closed as UNAVAILABLE (BLOCKED_MISSING_INFO)
  const timeoutRes = await rewriteLiteraryPassageOnServer(
    {
      ownerId: 'author_1',
      projectId: ctx.projectId,
      episodeId: ctx.episodeId,
      sourceRevisionId: 'rev_ep_1',
      manuscript,
      anchor,
      modes: ['R1'],
      context: ctx,
    },
    {
      enforceServerCanonGate: true,
      ragTimeoutMs: 100,
      customFirestoreReader: async ({ ownerId, projectId }) =>
        createAuthoritativeSnapshot(ownerId, projectId),
      customRagRetriever: async () =>
        new Promise((resolve) => setTimeout(() => resolve([]), 300)),
    }
  );
  assert.equal(timeoutRes.executionStatus, 'BLOCKED_MISSING_INFO');
  assert.equal(timeoutRes.candidate, null);
  assert.equal(timeoutRes.canonEvidence?.status, 'UNAVAILABLE');
  assert.equal(timeoutRes.canonEvidence?.verificationMode, 'UNVERIFIED');
  assert.equal(timeoutRes.canonEvidence?.verifiedSourceIds.length, 0);

  // A7: RAG error throws -> fails closed as UNAVAILABLE
  const errorRes = await rewriteLiteraryPassageOnServer(
    {
      ownerId: 'author_1',
      projectId: ctx.projectId,
      episodeId: ctx.episodeId,
      sourceRevisionId: 'rev_ep_1',
      manuscript,
      anchor,
      modes: ['R1'],
      context: ctx,
    },
    {
      enforceServerCanonGate: true,
      customFirestoreReader: async ({ ownerId, projectId }) =>
        createAuthoritativeSnapshot(ownerId, projectId),
      customRagRetriever: async () => {
        throw new Error('ECONNRESET Firestore vector store unreachable');
      },
    }
  );
  assert.equal(errorRes.executionStatus, 'BLOCKED_MISSING_INFO');
  assert.equal(errorRes.canonEvidence?.status, 'UNAVAILABLE');
  assert.equal(errorRes.canonEvidence?.verifiedSourceIds.length, 0);

  // A8a: Explicit allowUnverifiedTypoOnlyPreview on UNAVAILABLE returns UNVERIFIED + canonConflictFree=false
  const typoFallbackRes = await rewriteLiteraryPassageOnServer(
    {
      ownerId: 'author_1',
      projectId: ctx.projectId,
      episodeId: ctx.episodeId,
      sourceRevisionId: 'rev_ep_1',
      manuscript,
      anchor,
      modes: ['R1'],
      allowUnverifiedTypoOnlyPreview: true,
      context: ctx,
    },
    {
      enforceServerCanonGate: true,
      customFirestoreReader: async ({ ownerId, projectId }) =>
        createAuthoritativeSnapshot(ownerId, projectId),
      customRagRetriever: async () => {
        throw new Error('RAG offline');
      },
    }
  );
  assert.equal(typoFallbackRes.executionStatus, 'CANDIDATE_READY');
  assert.ok(typoFallbackRes.candidate);
  assert.equal(typoFallbackRes.candidate.verification.canonEvidence.status, 'UNAVAILABLE');
  assert.equal(
    typoFallbackRes.candidate.verification.canonEvidence.verificationMode,
    'UNVERIFIED'
  );
  assert.equal(
    typoFallbackRes.candidate.verification.canonEvidence.fallbackTypoOnlyApplied,
    true
  );
  assert.equal(
    typoFallbackRes.candidate.verification.qualityDelta.canonConflictFree,
    false
  );

  // A8b: allowUnverifiedTypoOnlyPreview MUST NOT bypass UNAUTHORIZED!
  const authBlockedEvenWithFlag = await rewriteLiteraryPassageOnServer(
    {
      ownerId: 'intruder',
      projectId: ctx.projectId,
      episodeId: ctx.episodeId,
      sourceRevisionId: 'rev_ep_1',
      manuscript,
      anchor,
      modes: ['R1'],
      allowUnverifiedTypoOnlyPreview: true,
      context: ctx,
    },
    {
      enforceServerCanonGate: true,
      customFirestoreReader: async ({ projectId }) =>
        createAuthoritativeSnapshot('real_owner', projectId),
      customRagRetriever: async () => [],
    }
  );
  assert.equal(authBlockedEvenWithFlag.executionStatus, 'BLOCKED_CONFLICT');
  assert.equal(authBlockedEvenWithFlag.canonEvidence?.status, 'UNAUTHORIZED');
});

test('A9: validateRewriteCandidateBeforeApply rejects post-generation CANON drift and unverified fallback without explicit opt-in', () => {
  const manuscript = '앞문장.\n카엘은 검을 들었다.\n뒷문장.';
  const excerpt = '카엘은 검을 들었다.';
  const anchor = createRewriteSelectionAnchor({
    manuscript,
    startOffset: manuscript.indexOf(excerpt),
    endOffset: manuscript.indexOf(excerpt) + excerpt.length,
    sourceRevisionId: 'rev_ep_1',
  });
  const ctx = createStage2TestContext();

  const request = {
    ownerId: 'author_1',
    projectId: ctx.projectId,
    episodeId: ctx.episodeId,
    sourceRevisionId: 'rev_ep_1',
    manuscript,
    anchor,
    modes: ['R1'] as const,
    context: ctx,
  };

  const serverEvidence = {
    ...buildDefaultIsolatedTestCanonEvidence({
      request: { ...request, modes: ['R1'] },
      canonStateHash: 'hash_before_canon_edit',
    }),
    status: 'VERIFIED' as const,
    verificationMode: 'SERVER_AUTHORITY' as const,
  };

  const candidate: LiteraryRewriteCandidate = validateAndVerifyRewriteCandidate({
    rawAiOutput: {
      decision: 'REWRITTEN',
      appliedModes: ['R1'],
      rewrittenExcerpt: '카엘은 조용히 검을 들어 올렸다.',
      changeRationale: '동작 묘사 보강',
      preservedElements: ['검을 드는 동작'],
      noOpReason: null,
      canonConflictAlerts: [],
      perspectiveCheck: {
        expectedPerspective: 'THIRD_LIMITED',
        maintained: true,
        note: 'ok',
      },
      characterVoiceNotes: ['과묵함'],
      candidateLoreProposals: [],
    },
    request: { ...request, modes: ['R1'] },
    canonEvidence: serverEvidence,
    modelId: 'gemini-3.8-flash',
    usageMetadata: createEmptyUsageMetadata(),
  });

  // Drift between generation time CANON hash and apply time CANON hash -> blocked!
  const driftRes = validateRewriteCandidateBeforeApply({
    candidate,
    currentManuscript: manuscript,
    currentRevisionId: 'rev_ep_1',
    currentCanonStateHash: 'hash_after_canon_changed',
  });
  assert.equal(driftRes.valid, false);
  assert.equal(driftRes.reasonCode, 'CANON_DRIFT_AFTER_GENERATION');

  // Matching hash succeeds
  const okRes = validateRewriteCandidateBeforeApply({
    candidate,
    currentManuscript: manuscript,
    currentRevisionId: 'rev_ep_1',
    currentCanonStateHash: 'hash_before_canon_edit',
  });
  assert.equal(okRes.valid, true);
});

// ============================================================================
// Group B (B1-B6): Decoupled Manuscript Commit vs Idempotent ChangeProposal Recovery
// ============================================================================

test('B1/B2/B5/B6: Decouples manuscript CAS save from ChangeProposal write; retry saves ONLY pending items cleanly bound to real rev_...', async () => {
  // B5: rebindProposalsToCommittedRevision rejects UNSAVED_DRAFT / empty / episodeId
  const prop1 = createSampleProposal({ title: '북문 야간 결계 규율' });
  const prop2 = createSampleProposal({
    targetEntityId: 'char_kael',
    targetEntityType: 'CHARACTER',
    title: '카엘 왼팔 부상 경과 메모',
    afterSummary: '왼쪽 팔꿈치 인대 손상 장기화',
  });

  assert.throws(
    () =>
      rebindProposalsToCommittedRevision({
        candidateId: 'rw_cand_b1',
        proposals: [prop1],
        projectId: 'proj_stage2_test',
        episodeId: 'ep_stage2_1',
        committedRevisionId: 'UNSAVED_DRAFT',
      }),
    /INVALID_PROPOSAL_SOURCE_REVISION/
  );
  assert.throws(
    () =>
      rebindProposalsToCommittedRevision({
        candidateId: 'rw_cand_b1',
        proposals: [prop1],
        projectId: 'proj_stage2_test',
        episodeId: 'ep_stage2_1',
        committedRevisionId: 'ep_stage2_1',
      }),
    /INVALID_PROPOSAL_SOURCE_REVISION/
  );

  // Step 1: Commit manuscript CAS first (simulating isolated repository DB)
  let epContent = '초기 본문';
  let epRevId = 'rev_initial_1';
  let epHash = computeManuscriptContentHash(epContent);
  let revisionCreateCount = 0;

  const commitRes = await executeAtomicEpisodeCasCommitCore(
    {
      uid: 'author_stage2',
      projectId: 'proj_stage2_test',
      updatedEpisode: {
        id: 'ep_stage2_1',
        ownerId: 'author_stage2',
        projectId: 'proj_stage2_test',
        episodeNumber: 1,
        title: '제1화',
        content: '리라이팅 반영 완료된 최신 본문',
        synopsis: '',
        authorNote: '',
        charCountWithSpaces: 17,
        charCountWithoutSpaces: 14,
        status: 'confirmed',
        linkedCharacterIds: [],
        linkedWorldbuildingIds: [],
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
      expectedRevisionId: epRevId,
      expectedContentHash: epHash,
      createBackupRevisionFirst: true,
      createRevision: true,
      revisionLabel: '정밀 리라이팅 반영',
    },
    {
      getEpisodeSnapshot: async () => ({
        exists: true,
        content: epContent,
        latestRevisionId: epRevId,
        contentHash: epHash,
      }),
      createRevision: async () => {
        revisionCreateCount += 1;
      },
      updateEpisode: async (committed) => {
        epContent = committed.content;
        epRevId = committed.latestRevisionId || '';
        epHash = committed.contentHash || '';
      },
    }
  );

  assert.ok(commitRes.targetRevision);
  assert.equal(revisionCreateCount, 2); // backup + target
  assert.equal(epRevId, commitRes.targetRevision.id);

  // B5 continued: Re-bind proposals strictly to REAL committed revision ID
  const rebound = rebindProposalsToCommittedRevision({
    candidateId: 'rw_cand_b1',
    proposals: [prop1, prop2],
    projectId: 'proj_stage2_test',
    episodeId: 'ep_stage2_1',
    committedRevisionId: commitRes.targetRevision.id,
  });
  assert.equal(rebound.length, 2);
  assert.ok(rebound.every((p) => p.id.startsWith('prop_rw_')));
  assert.ok(
    rebound.every((p) => p.sourceRevisionId === commitRes.targetRevision!.id)
  );

  // B1 & B6: Simulate partial proposal persistence failure (1st succeeds, 2nd fails)
  const proposalStore = new Map<string, ChangeProposal>();
  let injectSecondFailure = true;

  const firstAttempt = await persistChangeProposalsIdempotentlyCore(rebound, {
    getExistingProposalStatus: async (id) => {
      const found = proposalStore.get(id);
      return found ? { exists: true, canonStatus: found.canonStatus } : { exists: false };
    },
    createProposal: async (prop) => {
      if (injectSecondFailure && prop.id === rebound[1].id) {
        throw new Error('503 Transient Firestore Proposal Write Failure');
      }
      proposalStore.set(prop.id, prop);
    },
  });

  // Manuscript stays preserved & revisionCreateCount did NOT increment
  assert.equal(epContent, '리라이팅 반영 완료된 최신 본문');
  assert.equal(revisionCreateCount, 2);
  assert.equal(firstAttempt.createdCount, 1);
  assert.equal(firstAttempt.failedCount, 1);
  assert.equal(firstAttempt.failedProposals[0].id, rebound[1].id);

  // B2 & B3: Retry ALL or ONLY failed proposals without touching manuscript -> skips duplicate 1st, creates 2nd
  injectSecondFailure = false;
  const retryAllResult = await persistChangeProposalsIdempotentlyCore(rebound, {
    getExistingProposalStatus: async (id) => {
      const found = proposalStore.get(id);
      return found ? { exists: true, canonStatus: found.canonStatus } : { exists: false };
    },
    createProposal: async (prop) => {
      proposalStore.set(prop.id, prop);
    },
  });

  assert.equal(retryAllResult.createdCount, 1);
  assert.equal(retryAllResult.skippedDuplicateCount, 1);
  assert.equal(retryAllResult.failedCount, 0);
  assert.equal(proposalStore.size, 2);
  assert.equal(revisionCreateCount, 2); // ZERO extra manuscript revisions!
});

test('B4: Idempotent persistence NEVER overwrites or downgrades already-decided (CANON/REJECTED/ARCHIVED) ChangeProposals', async () => {
  const decidedCanonProp = createSampleProposal({
    id: buildDeterministicProposalIdempotencyKey({
      candidateId: 'rw_decided',
      projectId: 'proj_stage2_test',
      episodeId: 'ep_stage2_1',
      targetEntityType: 'WORLDBUILDING',
      targetEntityId: 'wb_aether',
      proposedAction: 'UPDATE',
      title: '승인된 결계 규율',
      afterSummary: '승인 내용',
    }),
    canonStatus: 'CANON',
    title: '승인된 결계 규율',
    afterSummary: '승인 내용',
  });

  const store = new Map<string, ChangeProposal>([
    [decidedCanonProp.id, decidedCanonProp],
  ]);

  let createCalled = 0;
  const retryPayload = { ...decidedCanonProp, canonStatus: 'PROPOSED' as const };
  const result = await persistChangeProposalsIdempotentlyCore([retryPayload], {
    getExistingProposalStatus: async (id) => {
      const found = store.get(id);
      return found ? { exists: true, canonStatus: found.canonStatus } : { exists: false };
    },
    createProposal: async () => {
      createCalled += 1;
    },
  });

  assert.equal(createCalled, 0);
  assert.equal(result.createdCount, 0);
  assert.equal(result.skippedDuplicateCount, 1);
  assert.equal(result.itemResults[0].status, 'SKIPPED_ALREADY_DECIDED');
  assert.equal(store.get(decidedCanonProp.id)?.canonStatus, 'CANON');
});

// ============================================================================
// Group C: Korean Literary Rubric Checks + Separated Opt-In Live & Blind A/B Harness
// ============================================================================

test('C1: evaluateKoreanLiteraryRubricChecks catches over-explanation creep, dialogue homogenization, foreshadowing shrinkage & treats regex as auxiliary', () => {
  const rubric = evaluateKoreanLiteraryRubricChecks({
    originalExcerpt:
      '카엘은 차가운 성벽 위에서 「제7봉인」이 3번 진동하는 것을 느꼈다. 적의 기척이 코앞까지 스며들었다.',
    rewrittenExcerpt:
      '참고로 카엘은 행복했다. 즉, 「제7봉인」 없이도 문득 평화가 찾아온 것이다. “그러니까 그렇소.” 가렌이 말했다. “저도 그렇소.” 리온이 말했다.',
    expectedPerspective: 'THIRD_LIMITED',
    povMaintained: true,
    canonCharacters: [
      { id: 'char_kael', name: '카엘' },
    ],
    appliedModes: ['R3', 'R5'],
    isNoOp: false,
  });

  assert.equal(rubric.overExplanationCreepDetected, true);
  assert.equal(rubric.voiceHomogenizationRisk, true);
  assert.equal(rubric.dialogueCharacterFitPreserved, false);
  assert.equal(rubric.emotionalSubtextPreserved, false);
  assert.ok(rubric.rubricWarnings.length >= 2);
  assert.ok(rubric.heuristicSignalNote.includes('보조 신호'));
});

test('C2/C3: Evaluation Harness is DISABLED by default, runs offline synthetic DRY_RUN_FIXTURE safely, and keeps Blind A/B ratings strictly NOT_RATED', async () => {
  // C2: Default config without RUN_LIVE_GEMINI_EVAL=true MUST stay DISABLED
  const configDisabled = validateLiveEvalConfig({
    runLiveFlag: undefined,
    geminiApiKey: 'fake_key_for_config_check',
  });
  assert.equal(configDisabled.enabled, false);

  const disabledReport = await runLiteraryEvaluationHarness({
    runLiveEnvFlag: 'false',
    geminiApiKey: '',
  });
  assert.equal(disabledReport.executionMode, 'DISABLED');
  assert.equal(disabledReport.calledGeminiCount, 0);
  assert.equal(disabledReport.results.length, 0);

  // C3: Dry-run fixture harness runs synthetic benchmarks cleanly with randomized Blind A/B pairs defaulting to NOT_RATED
  const dryRunReport = await runLiteraryEvaluationHarness({
    dryRunWithFixtures: true,
    blindSeed: 'deterministic_seed_stage2',
  });
  assert.equal(dryRunReport.executionMode, 'DRY_RUN_FIXTURE');
  assert.equal(dryRunReport.calledGeminiCount, 0);
  assert.equal(dryRunReport.results.length, 8);
  assert.ok(
    dryRunReport.results.every((r) => r.canonEvidenceStatus === 'VERIFIED')
  );

  assert.equal(dryRunReport.blindAbPairs.length, 8);
  assert.ok(
    dryRunReport.blindAbPairs.every((p) => p.preference === 'NOT_RATED')
  );

  // Ensure initial summary reports ZERO fabricated human wins
  const unratedStats = summarizeBlindAbRatings(dryRunReport.blindAbPairs);
  assert.equal(unratedStats.ratedCount, 0);
  assert.equal(unratedStats.notRatedCount, 8);
  assert.equal(unratedStats.rewriteWinRateExcludingTiesPercent, null);

  // Simulate genuine reviewer rating on first two blind pairs
  const updatedPairs = dryRunReport.blindAbPairs.map((pair, idx) => {
    if (idx === 0) {
      const targetChoice =
        pair.hiddenSideAssignment === 'A_REWRITE_B_ORIGINAL' ? 'A' : 'B';
      return {
        ...pair,
        preference: resolveBlindChoiceToPreference({
          choice: targetChoice,
          hiddenSideAssignment: pair.hiddenSideAssignment,
        }),
      };
    }
    if (idx === 1) {
      return { ...pair, preference: 'TIE' as const };
    }
    return pair;
  });

  const ratedStats = summarizeBlindAbRatings(updatedPairs);
  assert.equal(ratedStats.ratedCount, 2);
  assert.equal(ratedStats.notRatedCount, 6);
  assert.equal(ratedStats.rewritePreferredCount, 1);
  assert.equal(ratedStats.tieCount, 1);
  assert.equal(ratedStats.rewriteWinRateExcludingTiesPercent, 100);
});

// ============================================================================
// Group B Stage 2.1 (B7-B8): Fail-Closed Error Classification & Atomic CAS
// ============================================================================

test('B7: classifyFirestorePersistenceError & persistChangeProposalsIdempotentlyCore NEVER coerce PERMISSION_DENIED or NETWORK_ERROR to DOCUMENT_NOT_FOUND', async () => {
  assert.equal(
    classifyFirestorePersistenceError(
      Object.assign(new Error('Missing or insufficient permissions.'), {
        code: 'permission-denied',
      })
    ),
    'PERMISSION_DENIED'
  );
  assert.equal(
    classifyFirestorePersistenceError(
      new Error('{"error":"7 PERMISSION_DENIED: Missing or insufficient permissions."}')
    ),
    'PERMISSION_DENIED'
  );
  assert.equal(
    classifyFirestorePersistenceError(
      Object.assign(new Error('The service is currently unavailable.'), {
        code: 'unavailable',
      })
    ),
    'NETWORK_ERROR'
  );
  assert.equal(
    classifyFirestorePersistenceError(
      new Error('[SOURCE_REVISION_CONFLICT] immutable revision mismatch')
    ),
    'PROPOSAL_PAYLOAD_CONFLICT'
  );
  assert.equal(
    classifyFirestorePersistenceError(
      new Error('[SOURCE_REVISION_NOT_FOUND] revision missing')
    ),
    'SOURCE_REVISION_NOT_FOUND'
  );
  assert.equal(
    classifyFirestorePersistenceError(
      new Error('[SOURCE_REVISION_CONTENT_MISMATCH] content hash mismatch')
    ),
    'SOURCE_REVISION_CONTENT_MISMATCH'
  );
  assert.equal(
    classifyFirestorePersistenceError(
      new Error('[PROPOSAL_OWNER_MISMATCH] owner mismatch')
    ),
    'PROPOSAL_OWNER_MISMATCH'
  );

  const prop = createSampleProposal({
    id: buildDeterministicProposalIdempotencyKey({
      candidateId: 'rw_b7',
      projectId: 'proj_stage2_test',
      episodeId: 'ep_stage2_1',
      targetEntityType: 'WORLDBUILDING',
      targetEntityId: 'wb_aether',
      proposedAction: 'UPDATE',
      title: '권한 오류 전파 검증',
      afterSummary: '내용',
    }),
    sourceRevisionId: 'rev_ep_1',
  });

  // 1) Atomic path throws Firebase permission-denied ("Missing or insufficient permissions.") -> FAILED, NOT CREATED
  const permDeniedAtomic = await persistChangeProposalsIdempotentlyCore([prop], {
    persistProposalAtomically: async () => {
      throw Object.assign(new Error('Missing or insufficient permissions.'), {
        code: 'permission-denied',
      });
    },
  });
  assert.equal(permDeniedAtomic.createdCount, 0);
  assert.equal(permDeniedAtomic.failedCount, 1);
  assert.equal(permDeniedAtomic.itemResults[0].status, 'FAILED');
  assert.equal(permDeniedAtomic.itemResults[0].errorCode, 'PERMISSION_DENIED');
  assert.equal(
    permDeniedAtomic.itemResults[0].lookupStatus,
    'PERMISSION_DENIED'
  );

  // 2) Legacy lookup path returns lookupStatus: PERMISSION_DENIED or NETWORK_ERROR -> MUST fail closed without calling createProposal
  let createCalls = 0;
  const lookupBlockedRes = await persistChangeProposalsIdempotentlyCore([prop], {
    getExistingProposalStatus: async () => ({
      exists: false,
      lookupStatus: 'PERMISSION_DENIED',
      errorCode: 'PERMISSION_DENIED',
      errorMessage: 'Missing or insufficient permissions.',
    }),
    createProposal: async () => {
      createCalls += 1;
    },
  });
  assert.equal(createCalls, 0);
  assert.equal(lookupBlockedRes.createdCount, 0);
  assert.equal(lookupBlockedRes.failedCount, 1);
  assert.equal(lookupBlockedRes.itemResults[0].errorCode, 'PERMISSION_DENIED');

  const networkBlockedRes = await persistChangeProposalsIdempotentlyCore([prop], {
    getExistingProposalStatus: async () => ({
      exists: false,
      lookupStatus: 'NETWORK_ERROR',
      errorCode: 'NETWORK_ERROR',
      errorMessage: 'unavailable',
    }),
    createProposal: async () => {
      createCalls += 1;
    },
  });
  assert.equal(createCalls, 0);
  assert.equal(networkBlockedRes.createdCount, 0);
  assert.equal(networkBlockedRes.failedCount, 1);
  assert.equal(networkBlockedRes.itemResults[0].errorCode, 'NETWORK_ERROR');
});

test('B8: Atomic CAS create-only adapter handles concurrent same-ID creates, rejects payload/sourceRevisionId conflicts, and protects CANON/REJECTED/ARCHIVED', async () => {
  const store = new Map<string, ChangeProposal>();
  let mutex = Promise.resolve();

  const runSerializedCasCreate = (
    prop: ChangeProposal
  ): Promise<AtomicProposalPersistenceOutcome> => {
    const run = mutex.then(async (): Promise<AtomicProposalPersistenceOutcome> => {
      // Simulate real async Firestore tx.get boundary before tx.set
      await Promise.resolve();
      const existing = store.get(prop.id);
      if (existing) {
        const equiv = areProposalsSemanticallyEquivalent(existing, prop);
        if (!equiv.equivalent) {
          return {
            outcome:
              equiv.errorCode === 'PROPOSAL_OWNER_MISMATCH'
                ? 'FAILED'
                : 'CONFLICT',
            lookupStatus:
              existing.canonStatus !== 'PROPOSED' &&
              existing.canonStatus !== 'DRAFT'
                ? 'DOCUMENT_EXISTS_DECIDED'
                : 'DOCUMENT_EXISTS_PROPOSED',
            errorCode: equiv.errorCode || 'PROPOSAL_PAYLOAD_CONFLICT',
            canonStatus: existing.canonStatus,
            errorMessage: equiv.reason,
          };
        }
        if (
          existing.canonStatus !== 'PROPOSED' &&
          existing.canonStatus !== 'DRAFT'
        ) {
          return {
            outcome: 'SKIPPED_ALREADY_DECIDED',
            lookupStatus: 'DOCUMENT_EXISTS_DECIDED',
            canonStatus: existing.canonStatus,
          };
        }
        return {
          outcome: 'SKIPPED_ALREADY_EXISTS',
          lookupStatus: 'DOCUMENT_EXISTS_PROPOSED',
          canonStatus: existing.canonStatus,
        };
      }
      store.set(prop.id, { ...prop, canonStatus: 'PROPOSED' });
      return {
        outcome: 'CREATED',
        lookupStatus: 'DOCUMENT_NOT_FOUND',
        canonStatus: 'PROPOSED',
      };
    });
    mutex = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  const baseProp = createSampleProposal({
    id: buildDeterministicProposalIdempotencyKey({
      candidateId: 'rw_b8_race',
      projectId: 'proj_stage2_test',
      episodeId: 'ep_stage2_1',
      targetEntityType: 'WORLDBUILDING',
      targetEntityId: 'wb_aether',
      proposedAction: 'UPDATE',
      title: '성채 북문 이중 결계',
      afterSummary: '자정 이후 이중 검문',
    }),
    title: '성채 북문 이중 결계',
    afterSummary: '자정 이후 이중 검문',
    sourceRevisionId: 'rev_committed_b8',
  });

  // 1) Concurrent same-ID creates -> exactly 1 CREATED, 1 SKIPPED_ALREADY_EXISTS, 0 FAILED
  const [race1, race2] = await Promise.all([
    persistChangeProposalsIdempotentlyCore([baseProp], {
      persistProposalAtomically: runSerializedCasCreate,
    }),
    persistChangeProposalsIdempotentlyCore([baseProp], {
      persistProposalAtomically: runSerializedCasCreate,
    }),
  ]);
  assert.equal(race1.createdCount + race2.createdCount, 1);
  assert.equal(race1.skippedDuplicateCount + race2.skippedDuplicateCount, 1);
  assert.equal(race1.failedCount + race2.failedCount, 0);
  assert.equal(store.size, 1);

  // 2) Same ID with mutated sourceRevisionId or afterSummary -> FAILED (PROPOSAL_PAYLOAD_CONFLICT), existing doc intact
  const tamperedProp = {
    ...baseProp,
    afterSummary: '임의 변조 내용',
    sourceRevisionId: 'rev_tampered_b8',
  };
  const conflictRes = await persistChangeProposalsIdempotentlyCore(
    [tamperedProp],
    { persistProposalAtomically: runSerializedCasCreate }
  );
  assert.equal(conflictRes.createdCount, 0);
  assert.equal(conflictRes.failedCount, 1);
  assert.equal(conflictRes.itemResults[0].errorCode, 'PROPOSAL_PAYLOAD_CONFLICT');
  assert.equal(store.get(baseProp.id)?.afterSummary, '자정 이후 이중 검문');
  assert.equal(store.get(baseProp.id)?.sourceRevisionId, 'rev_committed_b8');

  // 3) Intra-batch conflicting duplicates under same ID -> 1st CREATED, 2nd FAILED (PROPOSAL_PAYLOAD_CONFLICT)
  const batchPropA = createSampleProposal({
    id: 'prop_rw_batch_conflict',
    title: '배치 내 동일 ID A',
    afterSummary: '원본 A',
    sourceRevisionId: 'rev_batch_1',
  });
  const batchPropB = {
    ...batchPropA,
    afterSummary: '충돌 B',
  };
  const batchConflictRes = await persistChangeProposalsIdempotentlyCore(
    [batchPropA, batchPropB],
    { persistProposalAtomically: runSerializedCasCreate }
  );
  assert.equal(batchConflictRes.createdCount, 1);
  assert.equal(batchConflictRes.failedCount, 1);
  assert.equal(
    batchConflictRes.itemResults[1].errorCode,
    'PROPOSAL_PAYLOAD_CONFLICT'
  );

  // 4) Decided CANON / REJECTED / ARCHIVED proposals stay completely untouched when immutable fields match
  for (const status of ['CANON', 'REJECTED', 'ARCHIVED'] as const) {
    const decidedId = `prop_rw_decided_${status.toLowerCase()}`;
    const decidedProp = createSampleProposal({
      id: decidedId,
      canonStatus: status,
      sourceRevisionId: 'rev_decided_1',
    });
    store.set(decidedId, decidedProp);
    const decidedRetry = await persistChangeProposalsIdempotentlyCore(
      [{ ...decidedProp, canonStatus: 'PROPOSED' }],
      { persistProposalAtomically: runSerializedCasCreate }
    );
    assert.equal(decidedRetry.createdCount, 0);
    assert.equal(decidedRetry.skippedDuplicateCount, 1);
    assert.equal(decidedRetry.itemResults[0].status, 'SKIPPED_ALREADY_DECIDED');
    assert.equal(store.get(decidedId)?.canonStatus, status);
  }
});

// ============================================================================
// Group B Stage 2.2 (B9-B11): Full 15-Field Semantic Integrity & Revision Binding
// ============================================================================

test('B9: Full 15-field semantic comparison blocks ANY immutable field mutation across PROPOSED, CANON, REJECTED, and ARCHIVED without overwrite', async () => {
  const base = createSampleProposal({
    id: 'prop_rw_15field_integrity',
    ownerId: 'author_stage2',
    projectId: 'proj_stage2_test',
    targetEntityType: 'WORLDBUILDING',
    targetEntityId: 'wb_aether',
    proposedAction: 'UPDATE',
    title: '성채 북문 야간 결계 보강',
    rationale: '장면 내 성벽 야간 경계 규칙 보완',
    beforeSummary: '기본 성벽 경계',
    afterSummary: '자정 이후 북문 결계 이중 검문',
    proposedPayloadJson: JSON.stringify({
      sourceModule: 'LITERARY_REWRITING',
      referenceLoreId: 'wb_aether',
      detail: { threshold: 2 },
    }),
    triggerEpisodeId: 'ep_stage2_1',
    triggerSceneId: 'scene_1',
    sourceRevisionId: 'rev_15field_1',
    createdBy: 'AI_ENGINE',
  });

  // Direct id mismatch check on areProposalsSemanticallyEquivalent
  const idDiff = areProposalsSemanticallyEquivalent(base, {
    ...base,
    id: 'prop_rw_other_id',
  });
  assert.equal(idDiff.equivalent, false);
  assert.equal(idDiff.errorCode, 'PROPOSAL_PAYLOAD_CONFLICT');
  assert.deepEqual(idDiff.mismatchFields, ['id']);

  const mutations: Array<{
    field: keyof ChangeProposal;
    mutated: Partial<ChangeProposal>;
    expectedError: 'PROPOSAL_OWNER_MISMATCH' | 'PROPOSAL_PAYLOAD_CONFLICT';
  }> = [
    {
      field: 'ownerId',
      mutated: { ownerId: 'other_author' },
      expectedError: 'PROPOSAL_OWNER_MISMATCH',
    },
    {
      field: 'projectId',
      mutated: { projectId: 'proj_other' },
      expectedError: 'PROPOSAL_PAYLOAD_CONFLICT',
    },
    {
      field: 'targetEntityType',
      mutated: { targetEntityType: 'CHARACTER' },
      expectedError: 'PROPOSAL_PAYLOAD_CONFLICT',
    },
    {
      field: 'targetEntityId',
      mutated: { targetEntityId: 'wb_different' },
      expectedError: 'PROPOSAL_PAYLOAD_CONFLICT',
    },
    {
      field: 'proposedAction',
      mutated: { proposedAction: 'ARCHIVE' },
      expectedError: 'PROPOSAL_PAYLOAD_CONFLICT',
    },
    {
      field: 'title',
      mutated: { title: '변경된 제안 제목' },
      expectedError: 'PROPOSAL_PAYLOAD_CONFLICT',
    },
    {
      field: 'rationale',
      mutated: { rationale: '변경된 근거 문구' },
      expectedError: 'PROPOSAL_PAYLOAD_CONFLICT',
    },
    {
      field: 'beforeSummary',
      mutated: { beforeSummary: '변경된 이전 요약' },
      expectedError: 'PROPOSAL_PAYLOAD_CONFLICT',
    },
    {
      field: 'afterSummary',
      mutated: { afterSummary: '변경된 이후 요약' },
      expectedError: 'PROPOSAL_PAYLOAD_CONFLICT',
    },
    {
      field: 'proposedPayloadJson',
      mutated: {
        proposedPayloadJson: JSON.stringify({
          sourceModule: 'LITERARY_REWRITING',
          referenceLoreId: 'wb_aether',
          detail: { threshold: 99 },
        }),
      },
      expectedError: 'PROPOSAL_PAYLOAD_CONFLICT',
    },
    {
      field: 'triggerEpisodeId',
      mutated: { triggerEpisodeId: 'ep_stage2_99' },
      expectedError: 'PROPOSAL_PAYLOAD_CONFLICT',
    },
    {
      field: 'triggerSceneId',
      mutated: { triggerSceneId: 'scene_99' },
      expectedError: 'PROPOSAL_PAYLOAD_CONFLICT',
    },
    {
      field: 'sourceRevisionId',
      mutated: { sourceRevisionId: 'rev_mutated_other' },
      expectedError: 'PROPOSAL_PAYLOAD_CONFLICT',
    },
    {
      field: 'createdBy',
      mutated: { createdBy: 'AUTHOR' },
      expectedError: 'PROPOSAL_PAYLOAD_CONFLICT',
    },
  ];

  for (const status of ['PROPOSED', 'CANON', 'REJECTED', 'ARCHIVED'] as const) {
    const existingDoc: ChangeProposal = { ...base, canonStatus: status };
    const store = new Map<string, ChangeProposal>([[existingDoc.id, existingDoc]]);
    let createCount = 0;

    const adapter = {
      getExistingProposalStatus: async (id: string) => {
        const found = store.get(id);
        if (!found) {
          return { exists: false, lookupStatus: 'DOCUMENT_NOT_FOUND' as const };
        }
        const decided =
          found.canonStatus !== 'PROPOSED' && found.canonStatus !== 'DRAFT';
        return {
          exists: true,
          lookupStatus: (decided
            ? 'DOCUMENT_EXISTS_DECIDED'
            : 'DOCUMENT_EXISTS_PROPOSED') as
            | 'DOCUMENT_EXISTS_DECIDED'
            | 'DOCUMENT_EXISTS_PROPOSED',
          canonStatus: found.canonStatus,
          existingProposal: found,
        };
      },
      createProposal: async () => {
        createCount += 1;
      },
    };

    for (const m of mutations) {
      const incoming = {
        ...base,
        ...m.mutated,
        canonStatus: 'PROPOSED' as const,
      };
      const res = await persistChangeProposalsIdempotentlyCore([incoming], adapter);
      assert.equal(res.createdCount, 0, `${status}/${String(m.field)} must not create`);
      assert.equal(
        res.skippedDuplicateCount,
        0,
        `${status}/${String(m.field)} must NEVER silently skip`
      );
      assert.equal(res.failedCount, 1, `${status}/${String(m.field)} must fail`);
      assert.equal(res.itemResults[0].status, 'FAILED');
      assert.equal(res.itemResults[0].errorCode, m.expectedError);
      assert.equal(store.size, 1);
      assert.deepEqual(store.get(existingDoc.id), existingDoc);
    }

    // Only identical immutable payload skips cleanly
    const identicalRes = await persistChangeProposalsIdempotentlyCore(
      [{ ...base, canonStatus: 'PROPOSED' }],
      adapter
    );
    assert.equal(identicalRes.createdCount, 0);
    assert.equal(identicalRes.failedCount, 0);
    assert.equal(identicalRes.skippedDuplicateCount, 1);
    assert.equal(
      identicalRes.itemResults[0].status,
      status === 'PROPOSED' ? 'SKIPPED_ALREADY_EXISTS' : 'SKIPPED_ALREADY_DECIDED'
    );
    assert.equal(createCount, 0);
  }
});

test('B10: Canonical proposedPayloadJson treats key-reordered JSON as equal, rejects malformed JSON, and fails strictly instead of truncating oversized fields', () => {
  const canonA = canonicalizeProposedPayloadJson(
    '{"z": 2, "a": {"y": true, "x": [1, 2]}}'
  );
  const canonB = canonicalizeProposedPayloadJson(
    '{"a":{"x":[1,2],"y":true},"z":2}'
  );
  assert.equal(canonA.ok, true);
  assert.equal(canonB.ok, true);
  if (canonA.ok && canonB.ok) {
    assert.equal(canonA.canonicalJson, canonB.canonicalJson);
  }

  const propA = createSampleProposal({
    id: 'prop_rw_json_order',
    sourceRevisionId: 'rev_json_1',
    proposedPayloadJson: ' { "b": 2, "a": 1, "nested": { "k2": "v2", "k1": "v1" } } ',
  });
  const propB = createSampleProposal({
    id: 'prop_rw_json_order',
    sourceRevisionId: 'rev_json_1',
    proposedPayloadJson: '{"nested":{"k1":"v1","k2":"v2"},"a":1,"b":2}',
  });
  assert.equal(areProposalsSemanticallyEquivalent(propA, propB).equivalent, true);

  // Malformed JSON is NEVER treated as equal even if identical string!
  const malformedA = createSampleProposal({
    id: 'prop_rw_json_bad',
    sourceRevisionId: 'rev_json_1',
    proposedPayloadJson: '{broken_json',
  });
  const malformedEquiv = areProposalsSemanticallyEquivalent(malformedA, {
    ...malformedA,
  });
  assert.equal(malformedEquiv.equivalent, false);
  assert.equal(malformedEquiv.errorCode, 'PROPOSAL_PAYLOAD_CONFLICT');

  const malformedNorm = normalizeAndValidateChangeProposalPayload(
    'author_stage2',
    'proj_stage2_test',
    malformedA
  );
  assert.equal(malformedNorm.ok, false);
  if (!malformedNorm.ok) {
    assert.equal(malformedNorm.errorCode, 'VALIDATION_ERROR');
  }

  // Strict length rejection (no silent .slice()!)
  const oversizedChecks: Array<Partial<ChangeProposal>> = [
    { title: '가'.repeat(151) },
    { rationale: '나'.repeat(2001) },
    { beforeSummary: '다'.repeat(2001) },
    { afterSummary: '라'.repeat(2001) },
    { proposedPayloadJson: JSON.stringify({ big: 'x'.repeat(20005) }) },
  ];
  for (const patch of oversizedChecks) {
    const res = normalizeAndValidateChangeProposalPayload(
      'author_stage2',
      'proj_stage2_test',
      createSampleProposal({
        ...patch,
        sourceRevisionId: 'rev_valid_1',
      })
    );
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.errorCode, 'VALIDATION_ERROR');
    }
  }

  const draftRes = normalizeAndValidateChangeProposalPayload(
    'author_stage2',
    'proj_stage2_test',
    createSampleProposal({ sourceRevisionId: 'UNSAVED_DRAFT' })
  );
  assert.equal(draftRes.ok, false);
  if (!draftRes.ok) {
    assert.equal(draftRes.errorCode, 'SOURCE_REVISION_UNVERIFIED');
  }

  const ownerRes = normalizeAndValidateChangeProposalPayload(
    'author_stage2',
    'proj_stage2_test',
    createSampleProposal({
      ownerId: 'wrong_owner',
      sourceRevisionId: 'rev_valid_1',
    })
  );
  assert.equal(ownerRes.ok, false);
  if (!ownerRes.ok) {
    assert.equal(ownerRes.errorCode, 'PROPOSAL_OWNER_MISMATCH');
  }
});

test('B11: Persisted Revision provenance verification enforces NOT_FOUND, MISMATCH, CONTENT_MISMATCH, PERMISSION_DENIED, and preserves historical Revision A after Revision B commit', async () => {
  const contentA = '제1화 리비전 A 본문';
  const hashA = computeManuscriptContentHash(contentA);
  const contentB = '제1화 리비전 B 최신 본문';
  const hashB = computeManuscriptContentHash(contentB);

  const revisions = new Map<
    string,
    {
      id: string;
      ownerId: string;
      projectId: string;
      episodeId: string;
      content: string;
    }
  >([
    [
      'rev_A',
      {
        id: 'rev_A',
        ownerId: 'author_stage2',
        projectId: 'proj_stage2_test',
        episodeId: 'ep_stage2_1',
        content: contentA,
      },
    ],
    [
      'rev_other_ep',
      {
        id: 'rev_other_ep',
        ownerId: 'author_stage2',
        projectId: 'proj_stage2_test',
        episodeId: 'ep_stage2_2',
        content: '다른 회차 본문',
      },
    ],
    [
      'rev_other_owner',
      {
        id: 'rev_other_owner',
        ownerId: 'stranger_uid',
        projectId: 'proj_stage2_test',
        episodeId: 'ep_stage2_1',
        content: contentA,
      },
    ],
  ]);

  const proposals = new Map<string, ChangeProposal>();

  const runCasWithRevisionCheck = async (
    prop: ChangeProposal,
    opts?: Parameters<typeof persistChangeProposalsIdempotentlyCore>[2]
  ): Promise<AtomicProposalPersistenceOutcome> => {
    const rev = revisions.get(prop.sourceRevisionId);
    if (opts?.requireVerifiedSourceRevision) {
      if (!prop.sourceRevisionId || prop.sourceRevisionId === 'UNSAVED_DRAFT' || prop.sourceRevisionId === 'ep_stage2_1') {
        return {
          outcome: 'FAILED',
          lookupStatus: 'SOURCE_REVISION_UNVERIFIED',
          errorCode: 'SOURCE_REVISION_UNVERIFIED',
          errorMessage: '검증되지 않은 sourceRevisionId',
        };
      }
      const check = verifyPersistedRevisionSnapshot({
        exists: Boolean(rev),
        revisionData: rev ?? null,
        revisionDocId: prop.sourceRevisionId,
        expectedOwnerId: 'author_stage2',
        expectedProjectId: 'proj_stage2_test',
        expectedEpisodeId: opts.expectedEpisodeId || prop.triggerEpisodeId,
        expectedContentHash: opts.expectedSourceContentHash,
      });
      if (!check.valid) {
        return {
          outcome: 'FAILED',
          lookupStatus: check.lookupStatus,
          errorCode: check.errorCode,
          errorMessage: check.errorMessage,
        };
      }
    }
    proposals.set(prop.id, prop);
    return {
      outcome: 'CREATED',
      lookupStatus: 'DOCUMENT_NOT_FOUND',
      canonStatus: 'PROPOSED',
    };
  };

  // 1) Missing revision -> SOURCE_REVISION_NOT_FOUND
  const [missingProp] = rebindProposalsToCommittedRevision({
    candidateId: 'rw_miss',
    proposals: [createSampleProposal()],
    projectId: 'proj_stage2_test',
    episodeId: 'ep_stage2_1',
    committedRevisionId: 'rev_does_not_exist',
  });
  const missingRes = await persistChangeProposalsIdempotentlyCore(
    [missingProp],
    { persistProposalAtomically: runCasWithRevisionCheck },
    {
      requireVerifiedSourceRevision: true,
      expectedEpisodeId: 'ep_stage2_1',
      expectedSourceContentHash: hashA,
    }
  );
  assert.equal(missingRes.failedCount, 1);
  assert.equal(missingRes.itemResults[0].errorCode, 'SOURCE_REVISION_NOT_FOUND');

  // 2) Wrong episode -> SOURCE_REVISION_MISMATCH
  const [wrongEpProp] = rebindProposalsToCommittedRevision({
    candidateId: 'rw_wrong_ep',
    proposals: [createSampleProposal()],
    projectId: 'proj_stage2_test',
    episodeId: 'ep_stage2_1',
    committedRevisionId: 'rev_other_ep',
  });
  const wrongEpRes = await persistChangeProposalsIdempotentlyCore(
    [wrongEpProp],
    { persistProposalAtomically: runCasWithRevisionCheck },
    {
      requireVerifiedSourceRevision: true,
      expectedEpisodeId: 'ep_stage2_1',
    }
  );
  assert.equal(wrongEpRes.failedCount, 1);
  assert.equal(wrongEpRes.itemResults[0].errorCode, 'SOURCE_REVISION_MISMATCH');

  // 3) Cross-owner -> PERMISSION_DENIED
  const [wrongOwnerProp] = rebindProposalsToCommittedRevision({
    candidateId: 'rw_wrong_owner',
    proposals: [createSampleProposal()],
    projectId: 'proj_stage2_test',
    episodeId: 'ep_stage2_1',
    committedRevisionId: 'rev_other_owner',
  });
  const wrongOwnerRes = await persistChangeProposalsIdempotentlyCore(
    [wrongOwnerProp],
    { persistProposalAtomically: runCasWithRevisionCheck },
    {
      requireVerifiedSourceRevision: true,
      expectedEpisodeId: 'ep_stage2_1',
    }
  );
  assert.equal(wrongOwnerRes.failedCount, 1);
  assert.equal(wrongOwnerRes.itemResults[0].errorCode, 'PERMISSION_DENIED');

  // 4) Hash mismatch -> SOURCE_REVISION_CONTENT_MISMATCH
  const [propA] = rebindProposalsToCommittedRevision({
    candidateId: 'rw_rev_a',
    proposals: [createSampleProposal()],
    projectId: 'proj_stage2_test',
    episodeId: 'ep_stage2_1',
    committedRevisionId: 'rev_A',
  });
  const badHashRes = await persistChangeProposalsIdempotentlyCore(
    [propA],
    { persistProposalAtomically: runCasWithRevisionCheck },
    {
      requireVerifiedSourceRevision: true,
      expectedEpisodeId: 'ep_stage2_1',
      expectedSourceContentHash: hashB,
    }
  );
  assert.equal(badHashRes.failedCount, 1);
  assert.equal(
    badHashRes.itemResults[0].errorCode,
    'SOURCE_REVISION_CONTENT_MISMATCH'
  );

  // 5) Commit Revision B on the same episode later -> Proposal bound to historical rev_A + hashA STILL verifies & persists!
  revisions.set('rev_B', {
    id: 'rev_B',
    ownerId: 'author_stage2',
    projectId: 'proj_stage2_test',
    episodeId: 'ep_stage2_1',
    content: contentB,
  });
  const historicalRes = await persistChangeProposalsIdempotentlyCore(
    [propA],
    { persistProposalAtomically: runCasWithRevisionCheck },
    {
      requireVerifiedSourceRevision: true,
      expectedEpisodeId: 'ep_stage2_1',
      expectedSourceContentHash: hashA,
    }
  );
  assert.equal(historicalRes.createdCount, 1);
  assert.equal(historicalRes.failedCount, 0);
  assert.equal(proposals.get(propA.id)?.sourceRevisionId, 'rev_A');

  const summary = formatProposalPersistenceErrorSummaryKo([
    badHashRes.itemResults[0],
    missingRes.itemResults[0],
  ]);
  assert.ok(summary.includes('SOURCE_REVISION_CONTENT_MISMATCH'));
  assert.ok(summary.includes('SOURCE_REVISION_NOT_FOUND'));
});
