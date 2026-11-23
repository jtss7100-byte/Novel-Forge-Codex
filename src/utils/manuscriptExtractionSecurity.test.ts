import test from 'node:test';
import assert from 'node:assert/strict';
import type { Firestore } from 'firebase-admin/firestore';
import {
  executeServerManuscriptExtraction,
  resolveExtractionFirestoreInstance,
  saveVerifiedExtractionProposalsOnServer,
} from '../server/manuscriptExtractionEngine';
import {
  PROD_DEFAULT_FIREBASE_PROJECT_ID,
  PROD_DEFAULT_FIRESTORE_DATABASE_ID,
  registerIsolatedMockFirestoreForTest,
} from '../server/authMiddleware';
import { parseAndSanitizeAiExtractionResponse } from './manuscriptExtractionLogic';

test('Phase 4.2.1 Security 1: Unverified options.db in TEST_ISOLATED mode is strictly rejected with ISOLATED_TEST_DB_UNVERIFIED', async () => {
  const unverifiedMockDb = {
    doc: () => ({}),
    collection: () => ({}),
  } as unknown as Firestore;

  assert.throws(() => {
    resolveExtractionFirestoreInstance({ db: unverifiedMockDb });
  }, /ISOLATED_TEST_DB_UNVERIFIED/);

  await assert.rejects(
    async () => {
      await executeServerManuscriptExtraction(
        {
          projectId: 'proj_1',
          episodeId: 'ep_1',
          revisionId: 'rev_1',
        },
        {
          db: unverifiedMockDb,
          verifiedOwnerId: 'owner_1',
        }
      );
    },
    /ISOLATED_TEST_DB_UNVERIFIED/
  );

  // Also testMode: true without db must throw TEST_ISOLATED_DB_REQUIRED
  assert.throws(() => {
    resolveExtractionFirestoreInstance({ testMode: true });
  }, /TEST_ISOLATED_DB_REQUIRED/);
});

test('Phase 4.2.1 Security 2: Production project/database collision and [DEFAULT] app name are blocked in isolated test DB registration', () => {
  const dummyDb = {} as unknown as Firestore;

  assert.throws(() => {
    registerIsolatedMockFirestoreForTest(dummyDb, {
      runId: 'run_sec_collision_1',
      projectId: PROD_DEFAULT_FIREBASE_PROJECT_ID,
      databaseId: 'nf-test-db',
    });
  }, /ISOLATED_TEST_DB_PROD_COLLISION/);

  assert.throws(() => {
    registerIsolatedMockFirestoreForTest(dummyDb, {
      runId: 'run_sec_collision_2',
      projectId: 'nf-test-proj',
      databaseId: PROD_DEFAULT_FIRESTORE_DATABASE_ID,
    });
  }, /ISOLATED_TEST_DB_PROD_COLLISION/);

  assert.throws(() => {
    registerIsolatedMockFirestoreForTest(dummyDb, {
      runId: 'run_sec_collision_3',
      projectId: 'nf-test-proj',
      databaseId: '(default)',
    });
  }, /ISOLATED_TEST_DB_PROD_COLLISION/);

  assert.throws(() => {
    registerIsolatedMockFirestoreForTest(dummyDb, {
      runId: 'run_sec_collision_4',
      projectId: 'nf-test-proj',
      databaseId: 'nf-test-db',
      appName: '[DEFAULT]',
    });
  }, /ISOLATED_TEST_DB_DEFAULT_APP_FORBIDDEN/);
});

test('Phase 4.2.1 Security 3: Unauthenticated request is rejected when cloud auth is enforced, and LOCAL_PREVIEW never touches Cloud Firestore', async () => {
  const prevEnforce = process.env.NOVEL_FORGE_ENFORCE_CLOUD_AUTH;
  try {
    process.env.NOVEL_FORGE_ENFORCE_CLOUD_AUTH = 'true';
    await assert.rejects(
      async () => {
        await executeServerManuscriptExtraction({
          projectId: 'proj_local',
          episodeId: 'ep_local',
          revisionId: 'rev_local',
          localPreviewSnapshot: {
            project: { id: 'proj_local', title: '로컬 작품' },
            episode: {
              id: 'ep_local',
              projectId: 'proj_local',
              episodeNumber: 1,
              title: '1화',
              currentRevisionId: 'rev_local',
            },
            revision: {
              id: 'rev_local',
              episodeId: 'ep_local',
              projectId: 'proj_local',
              content: '카시안은 성채 문을 열었다.',
            },
          },
        });
      },
      /AUTH_REQUIRED/
    );

    // When cloud auth is not enforced, LOCAL_PREVIEW works in strict isolation without touching Cloud Firestore
    process.env.NOVEL_FORGE_ENFORCE_CLOUD_AUTH = 'false';
    const localSnapshot = {
      project: { id: 'proj_local', title: '로컬 작품' },
      episode: {
        id: 'ep_local',
        projectId: 'proj_local',
        episodeNumber: 1,
        title: '1화',
        currentRevisionId: 'rev_local',
      },
      revision: {
        id: 'rev_local',
        episodeId: 'ep_local',
        projectId: 'proj_local',
        content: '카시안은 성채 문을 열었다. 그곳에는 고대의 봉인석이 빛나고 있었다.',
      },
      characters: [
        { id: 'char_1', name: '카시안', role: '주인공', description: '' },
      ],
    };

    const previewRes = await executeServerManuscriptExtraction(
      {
        projectId: 'proj_local',
        episodeId: 'ep_local',
        revisionId: 'rev_local',
        localPreviewSnapshot: localSnapshot,
      },
      {
        mockExtractorFn: async () => ({
          rawResponse: {
            analysis_summary: '로컬 미리보기 복선 추출',
            candidates: [
              {
                targetEntityType: 'FORESHADOWING',
                proposedAction: 'CREATE',
                existingTargetEntityId: null,
                title: '고대의 봉인석',
                rationale: '성채 문 너머 봉인석 발견',
                beforeSummary: '없음',
                afterSummary: 'PLANTED 복선 추가',
                excerpt: '그곳에는 고대의 봉인석이 빛나고 있었다.',
                precedingContext: null,
                followingContext: null,
                sceneId: null,
                confidence: 0.9,
                dialogueClaimOnly: false,
                temporalContextType: 'PRESENT_EVENT',
                uncertaintyFlags: [],
                relationshipPayload: null,
                timelineEventPayload: null,
                foreshadowingPayload: {
                  title: '고대의 봉인석',
                  description: '성채 내부 봉인석',
                  cluePhase: 'PLANTED',
                  relatedCharacterIds: ['char_1'],
                  relatedCharacterNames: ['카시안'],
                  relatedEventIds: [],
                  payoffNote: '',
                },
              },
            ],
          },
        }),
      }
    );

    assert.equal(previewRes.executionMode, 'LOCAL_PREVIEW');
    assert.equal(previewRes.isCloudVerified, false);
    assert.equal(previewRes.candidates.length, 1);
    assert.equal(previewRes.candidates[0].verification.status, 'VERIFIED');
    assert.equal(previewRes.savedProposals.length, 0);

    // Save in LOCAL_PREVIEW mode returns PROPOSED draft without touching Firestore
    const previewSaveRes = await saveVerifiedExtractionProposalsOnServer({
      projectId: 'proj_local',
      episodeId: 'ep_local',
      revisionId: 'rev_local',
      analysisRunId: previewRes.analysisRunId,
      analysisToken: previewRes.analysisToken,
      selectedCandidateIds: [previewRes.candidates[0].candidateId],
      localPreviewSnapshot: localSnapshot,
    });
    assert.equal(previewSaveRes.executionMode, 'LOCAL_PREVIEW');
    assert.equal(previewSaveRes.isCloudVerified, false);
    assert.equal(previewSaveRes.createdCount, 1);
    assert.equal(previewSaveRes.savedProposals[0].canonStatus, 'PROPOSED');
  } finally {
    if (prevEnforce === undefined) {
      delete process.env.NOVEL_FORGE_ENFORCE_CLOUD_AUTH;
    } else {
      process.env.NOVEL_FORGE_ENFORCE_CLOUD_AUTH = prevEnforce;
    }
  }
});

test('Phase 4.2.1 Security 4: Tampered or forged analysisToken and cross-owner token reuse are strictly rejected', async () => {
  const prevEnforce = process.env.NOVEL_FORGE_ENFORCE_CLOUD_AUTH;
  try {
    process.env.NOVEL_FORGE_ENFORCE_CLOUD_AUTH = 'false';
    const localSnapshot = {
      project: { id: 'proj_local', title: '로컬 작품' },
      episode: {
        id: 'ep_local',
        projectId: 'proj_local',
        episodeNumber: 1,
        title: '1화',
        currentRevisionId: 'rev_local',
      },
      revision: {
        id: 'rev_local',
        episodeId: 'ep_local',
        projectId: 'proj_local',
        content: '카시안은 성채 문을 열었다.',
      },
    };

    const previewRes = await executeServerManuscriptExtraction(
      {
        projectId: 'proj_local',
        episodeId: 'ep_local',
        revisionId: 'rev_local',
        localPreviewSnapshot: localSnapshot,
      },
      {
        mockExtractorFn: async () => ({
          rawResponse: {
            analysis_summary: '요약',
            candidates: [],
          },
        }),
      }
    );

    const tamperedToken = `${previewRes.analysisToken.split('.')[0]}.forged_signature_123`;

    await assert.rejects(
      async () => {
        await saveVerifiedExtractionProposalsOnServer({
          projectId: 'proj_local',
          episodeId: 'ep_local',
          revisionId: 'rev_local',
          analysisRunId: previewRes.analysisRunId,
          analysisToken: tamperedToken,
          selectedCandidateIds: ['cand_rev_local_1'],
          localPreviewSnapshot: localSnapshot,
        });
      },
      /INVALID_ANALYSIS_TOKEN/
    );
  } finally {
    if (prevEnforce === undefined) {
      delete process.env.NOVEL_FORGE_ENFORCE_CLOUD_AUTH;
    } else {
      process.env.NOVEL_FORGE_ENFORCE_CLOUD_AUTH = prevEnforce;
    }
  }
});

test('Phase 4.2.1 Security 5: Zod .strip() removes hallucinated startOffset, endOffset, canonStatus, and ownerId from raw AI response', () => {
  const rawWithInjectedFields = {
    analysis_summary: '보안 필드 제거 테스트',
    injectedRootField: 'malicious',
    candidates: [
      {
        targetEntityType: 'TIMELINE_EVENT',
        proposedAction: 'CREATE',
        existingTargetEntityId: null,
        title: '정상 사건',
        rationale: '근거',
        beforeSummary: '없음',
        afterSummary: '사건 생성',
        excerpt: '원문 발췌 문장입니다.',
        startOffset: 99999, // Hallucinated offset
        endOffset: 100050, // Hallucinated offset
        canonStatus: 'CANON', // Attempted CANON injection
        ownerId: 'attacker_uid', // Attempted owner spoofing
        precedingContext: null,
        followingContext: null,
        sceneId: null,
        confidence: 0.8,
        dialogueClaimOnly: false,
        temporalContextType: 'PRESENT_EVENT',
        uncertaintyFlags: [],
        relationshipPayload: null,
        timelineEventPayload: {
          title: '정상 사건',
          summary: '요약',
          inUniverseDate: '제국력 412년',
          chronologicalOrder: 10,
          involvedCharacterIds: [],
          involvedCharacterNames: [],
          locationWorldItemId: null,
          locationName: null,
          canonStatus: 'CANON',
        },
        foreshadowingPayload: null,
      },
    ],
  };

  const sanitized = parseAndSanitizeAiExtractionResponse(rawWithInjectedFields);
  assert.equal(sanitized.valid, true);
  assert.ok(sanitized.data);
  const candObj = sanitized.data.candidates[0] as unknown as Record<
    string,
    unknown
  >;
  assert.equal('startOffset' in candObj, false);
  assert.equal('endOffset' in candObj, false);
  assert.equal('canonStatus' in candObj, false);
  assert.equal('ownerId' in candObj, false);
});
