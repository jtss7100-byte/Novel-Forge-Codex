import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { registerIsolatedMockFirestoreForTest } from '../server/authMiddleware';
import {
  approveChangeProposalOnServer,
  rejectChangeProposalOnServer,
} from '../server/changeProposalApprovalEngine';
import {
  executeServerManuscriptExtraction,
  saveVerifiedExtractionProposalsOnServer,
} from '../server/manuscriptExtractionEngine';
import type { ChangeProposalPayloadEnvelope } from '../types/manuscriptExtraction';

const OWNER_ID = 'user_tx_hardening_01';
const PROJECT_ID = 'proj_tx_hardening_01';
const EPISODE_ID = 'ep_tx_01';
const SCENE_ID = 'scn_tx_01';
const REVISION_ID = 'rev_tx_01';

const MANUSCRIPT_TEXT = [
  '검은 성채의 성벽 위에서 강현우는 이서연에게 차갑게 검을 겨누었다.',
  '"다시 만나면 적이라고 했을 텐데."',
  '그날의 맹세는 부서진 은빛 회중시계 속에 잠들어 있었다.',
].join('\n\n');

const EXCERPT_1 = '강현우는 이서연에게 차갑게 검을 겨누었다.';
const EXCERPT_1_START = MANUSCRIPT_TEXT.indexOf(EXCERPT_1);
const EXCERPT_1_END = EXCERPT_1_START + EXCERPT_1.length;

function createStrictTransactionalMockFirestore(options: {
  runId: string;
  failTxGetOnPathSubstring?: string;
}): {
  db: Firestore;
  store: Map<string, Record<string, unknown>>;
  txReadLog: string[];
  txWriteLog: string[];
  nonTransactionalGetLog: string[];
} {
  const store = new Map<string, Record<string, unknown>>();
  const txReadLog: string[] = [];
  const txWriteLog: string[] = [];
  const nonTransactionalGetLog: string[] = [];
  let insideTransaction = false;

  const makeDocSnapshot = (docPath: string) => {
    const raw = store.get(docPath);
    const segments = docPath.split('/');
    const id = segments[segments.length - 1] || '';
    return {
      id,
      exists: raw !== undefined,
      data: () => (raw ? { ...raw } : undefined),
    };
  };

  const makeCollectionSnapshot = (colPath: string) => {
    const prefix = `${colPath}/`;
    const docs: Array<{
      id: string;
      exists: boolean;
      data: () => Record<string, unknown>;
    }> = [];
    for (const [key, val] of store.entries()) {
      if (key.startsWith(prefix)) {
        const remainder = key.slice(prefix.length);
        if (!remainder.includes('/')) {
          docs.push({
            id: remainder,
            exists: true,
            data: () => ({ ...val }),
          });
        }
      }
    }
    return {
      empty: docs.length === 0,
      size: docs.length,
      docs,
    };
  };

  const makeDocRef = (docPath: string) => {
    const segments = docPath.split('/');
    const id = segments[segments.length - 1] || '';
    return {
      id,
      path: docPath,
      __kind: 'docRef' as const,
      get: async () => {
        if (insideTransaction) {
          nonTransactionalGetLog.push(`doc.get:${docPath}`);
          throw new Error(
            `[FORBIDDEN_NON_TX_GET] Non-transactional docRef.get(${docPath}) called inside db.runTransaction!`
          );
        }
        return makeDocSnapshot(docPath);
      },
      set: async (data: Record<string, unknown>) => {
        store.set(docPath, { ...data });
      },
    };
  };

  const makeColRef = (colPath: string) => ({
    path: colPath,
    __kind: 'colRef' as const,
    doc: (docId: string) => makeDocRef(`${colPath}/${docId}`),
    get: async () => {
      if (insideTransaction) {
        nonTransactionalGetLog.push(`col.get:${colPath}`);
        throw new Error(
          `[FORBIDDEN_NON_TX_GET] Non-transactional colRef.get(${colPath}) called inside db.runTransaction!`
        );
      }
      return makeCollectionSnapshot(colPath);
    },
  });

  const mockDb = {
    doc: (docPath: string) => makeDocRef(docPath),
    collection: (colPath: string) => makeColRef(colPath),
    runTransaction: async <T>(
      updateFunction: (tx: unknown) => Promise<T>
    ): Promise<T> => {
      const stagedWrites = new Map<string, Record<string, unknown>>();
      let hasStartedWriting = false;
      insideTransaction = true;

      const tx = {
        get: async (target: { __kind?: string; path: string }) => {
          if (hasStartedWriting) {
            throw new Error(
              '[FIRESTORE_TX_READ_AFTER_WRITE] Firestore transactions require all reads before any writes.'
            );
          }
          txReadLog.push(target.path);
          if (
            options.failTxGetOnPathSubstring &&
            target.path.includes(options.failTxGetOnPathSubstring)
          ) {
            throw new Error(
              `Simulated tx.get failure on ${target.path}`
            );
          }
          if (target.__kind === 'colRef') {
            return makeCollectionSnapshot(target.path);
          }
          return makeDocSnapshot(target.path);
        },
        set: (target: { path: string }, data: Record<string, unknown>) => {
          hasStartedWriting = true;
          txWriteLog.push(`set:${target.path}`);
          stagedWrites.set(target.path, { ...data });
        },
        create: (target: { path: string }, data: Record<string, unknown>) => {
          hasStartedWriting = true;
          txWriteLog.push(`create:${target.path}`);
          if (store.has(target.path) || stagedWrites.has(target.path)) {
            throw new Error(
              `[FIRESTORE_TX_ALREADY_EXISTS] Document already exists at ${target.path}`
            );
          }
          stagedWrites.set(target.path, { ...data });
        },
      };

      try {
        const result = await updateFunction(tx);
        for (const [k, v] of stagedWrites.entries()) {
          store.set(k, v);
        }
        return result;
      } finally {
        insideTransaction = false;
      }
    },
  } as unknown as Firestore;

  registerIsolatedMockFirestoreForTest(mockDb, {
    projectId: 'test-isolated-phase422-s15-tx',
    databaseId: 'test-db-phase422-s15-tx',
    runId: options.runId,
  });

  return {
    db: mockDb,
    store,
    txReadLog,
    txWriteLog,
    nonTransactionalGetLog,
  };
}

function seedBaseFixturesAndProposal(
  store: Map<string, Record<string, unknown>>,
  proposalId = 'prop_tx_rel_01'
) {
  const basePath = `users/${OWNER_ID}/projects/${PROJECT_ID}`;
  const ts = Timestamp.fromDate(new Date('2026-04-01T09:00:00.000Z'));

  store.set(basePath, {
    id: PROJECT_ID,
    ownerId: OWNER_ID,
    title: '트랜잭션 무결성 연대기',
    genre: '판타지',
    synopsis: '시놉시스',
    status: 'confirmed',
    canonStatus: 'CANON',
    createdAt: ts,
    updatedAt: ts,
  });

  store.set(`${basePath}/episodes/${EPISODE_ID}`, {
    id: EPISODE_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    episodeNumber: 1,
    title: '제1화',
    content: MANUSCRIPT_TEXT,
    synopsis: '',
    authorNote: '',
    charCountWithSpaces: MANUSCRIPT_TEXT.length,
    charCountWithoutSpaces: MANUSCRIPT_TEXT.replace(/\s+/g, '').length,
    status: 'confirmed',
    canonStatus: 'CANON',
    linkedCharacterIds: ['char_hyunwoo', 'char_seoyeon'],
    linkedWorldbuildingIds: [],
    createdAt: ts,
    updatedAt: ts,
  });

  store.set(`${basePath}/scenes/${SCENE_ID}`, {
    id: SCENE_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    sceneNumber: 1,
    title: '성벽 위',
    summary: '대치',
    location: '검은 성채',
    pointOfViewCharacterId: 'char_hyunwoo',
    eventIds: [],
    characterIds: ['char_hyunwoo', 'char_seoyeon'],
    foreshadowingIds: [],
    canonStatus: 'CANON',
    sourceRevisionId: REVISION_ID,
    createdAt: ts,
    updatedAt: ts,
  });

  store.set(`${basePath}/revisions/${REVISION_ID}`, {
    id: REVISION_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    episodeTitle: '제1화',
    content: MANUSCRIPT_TEXT,
    charCountWithSpaces: MANUSCRIPT_TEXT.length,
    label: '리비전 1',
    createdAt: ts,
  });

  store.set(`${basePath}/characters/char_hyunwoo`, {
    id: 'char_hyunwoo',
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    name: '강현우',
    role: '주인공',
    affiliation: '기사단',
    appearance: '',
    personality: '',
    background: '',
    abilities: '',
    status: 'confirmed',
    canonStatus: 'CANON',
    linkedEpisodeIds: [EPISODE_ID],
    linkedWorldbuildingIds: [],
    createdAt: ts,
    updatedAt: ts,
  });

  store.set(`${basePath}/characters/char_seoyeon`, {
    id: 'char_seoyeon',
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    name: '이서연',
    role: '주연',
    affiliation: '마탑',
    appearance: '',
    personality: '',
    background: '',
    abilities: '',
    status: 'confirmed',
    canonStatus: 'CANON',
    linkedEpisodeIds: [EPISODE_ID],
    linkedWorldbuildingIds: [],
    createdAt: ts,
    updatedAt: ts,
  });

  const relId = 'rel_char_hyunwoo_char_seoyeon';
  const envelope: ChangeProposalPayloadEnvelope = {
    schemaVersion: 'PHASE_4_2_1_V1',
    fingerprint: `fp_${proposalId}`,
    targetEntityType: 'RELATIONSHIP',
    proposedAction: 'CREATE',
    targetEntityId: relId,
    sourceEpisodeId: EPISODE_ID,
    sourceRevisionId: REVISION_ID,
    sourceSceneId: SCENE_ID,
    verifiedExcerpt: {
      excerpt: EXCERPT_1,
      matchedText: EXCERPT_1,
      startOffset: EXCERPT_1_START,
      endOffset: EXCERPT_1_END,
      matchMethod: 'EXACT',
    },
    precedingContext: '검은 성채의 성벽 위에서 ',
    followingContext: '\n\n"다시 만나면 적이라고 했을 텐데."',
    confidence: 0.96,
    dialogueClaimOnly: false,
    temporalContextType: 'PRESENT_EVENT',
    uncertaintyFlags: [],
    canonConflicts: [],
    provenance: {
      sourceType: 'AI_PROPOSAL',
      createdBy: 'AI_ENGINE',
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      revisionId: REVISION_ID,
    },
    relationshipDraft: {
      id: relId,
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      sourceCharacterId: 'char_hyunwoo',
      sourceCharacterName: '강현우',
      targetCharacterId: 'char_seoyeon',
      targetCharacterName: '이서연',
      relationType: '적대적 대립',
      affinityScore: -65,
      isDirectional: true,
      description: '검을 겨누는 사이',
      canonStatus: 'PROPOSED',
      lastChangedEpisodeId: EPISODE_ID,
      sourceRevisionId: REVISION_ID,
      provenance: {
        sourceType: 'AI_PROPOSAL',
        createdBy: 'AI_ENGINE',
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        revisionId: REVISION_ID,
      },
    },
    existingEntitySnapshot: null,
  };

  store.set(`${basePath}/changeProposals/${proposalId}`, {
    id: proposalId,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: relId,
    proposedAction: 'CREATE',
    title: '관계 생성 제안',
    rationale: '원문 근거',
    beforeSummary: '없음',
    afterSummary: '적대적 대립 생성',
    proposedPayloadJson: JSON.stringify(envelope),
    triggerEpisodeId: EPISODE_ID,
    triggerSceneId: SCENE_ID,
    sourceRevisionId: REVISION_ID,
    canonStatus: 'PROPOSED',
    reviewedAt: '',
    createdBy: 'AI_ENGINE',
    createdAt: ts,
    updatedAt: ts,
  });
}

test('Stage 1.5 Transaction: All reads execute strictly via tx.get before any writes, with 0 non-transactional docRef.get / colRef.get calls', async () => {
  const { db, store, txReadLog, txWriteLog, nonTransactionalGetLog } =
    createStrictTransactionalMockFirestore({
      runId: 'run_strict_tx_reads_before_writes',
    });
  seedBaseFixturesAndProposal(store, 'prop_tx_01');

  const result = await approveChangeProposalOnServer(
    {
      projectId: PROJECT_ID,
      proposalId: 'prop_tx_01',
      reviewNote: '엄격한 트랜잭션 조회 테스트',
    },
    { db, verifiedOwnerId: OWNER_ID }
  );

  assert.equal(result.status, 'APPROVED_APPLIED');
  assert.equal(nonTransactionalGetLog.length, 0);
  assert.ok(txReadLog.length >= 7);
  assert.equal(txWriteLog.length, 4);
  assert.ok(txWriteLog.some((p) => p.includes('/ragSyncTasks/')));

  const basePath = `users/${OWNER_ID}/projects/${PROJECT_ID}`;
  assert.ok(txReadLog.includes(`${basePath}/characters/char_hyunwoo`));
  assert.ok(txReadLog.includes(`${basePath}/characters/char_seoyeon`));
  assert.ok(txReadLog.includes(`${basePath}/episodes/${EPISODE_ID}`));
  assert.ok(txReadLog.includes(`${basePath}/scenes/${SCENE_ID}`));
  assert.ok(txReadLog.includes(`${basePath}/revisions/${REVISION_ID}`));
});

test('Stage 1.5 Transaction: When tx.get fails on any referenced document, transaction aborts immediately with [TRANSACTION_READ_FAILED], 0 fallback to colRef.get/docRef.get, and 0 writes', async () => {
  const { db, store, txWriteLog, nonTransactionalGetLog } =
    createStrictTransactionalMockFirestore({
      runId: 'run_tx_get_failure_no_fallback',
      failTxGetOnPathSubstring: '/characters/char_seoyeon',
    });
  seedBaseFixturesAndProposal(store, 'prop_tx_fail_01');
  const basePath = `users/${OWNER_ID}/projects/${PROJECT_ID}`;

  await assert.rejects(
    async () =>
      approveChangeProposalOnServer(
        {
          projectId: PROJECT_ID,
          proposalId: 'prop_tx_fail_01',
        },
        { db, verifiedOwnerId: OWNER_ID }
      ),
    /TRANSACTION_READ_FAILED/
  );

  // Zero fallback calls to non-transactional get()
  assert.equal(nonTransactionalGetLog.length, 0);
  // Zero staged or committed writes
  assert.equal(txWriteLog.length, 0);
  assert.equal(
    store.has(`${basePath}/relationships/rel_char_hyunwoo_char_seoyeon`),
    false
  );
  assert.equal(
    store.get(`${basePath}/changeProposals/prop_tx_fail_01`)?.canonStatus,
    'PROPOSED'
  );
  assert.equal(
    store.has(
      `${basePath}/changeProposalApprovalAudits/audit_prop_tx_fail_01_APPROVED`
    ),
    false
  );
});

test('Stage 1.5 Transaction: Missing referenced character or cross-project reference inside transaction blocks approval with 0 writes', async () => {
  const { db, store, txWriteLog } = createStrictTransactionalMockFirestore({
    runId: 'run_tx_missing_or_cross_project_ref',
  });
  seedBaseFixturesAndProposal(store, 'prop_tx_ref_check');
  const basePath = `users/${OWNER_ID}/projects/${PROJECT_ID}`;

  // Case 1: Referenced character belongs to another project
  const seoyeonDoc = store.get(`${basePath}/characters/char_seoyeon`)!;
  store.set(`${basePath}/characters/char_seoyeon`, {
    ...seoyeonDoc,
    projectId: 'proj_other_foreign_99',
  });

  await assert.rejects(
    async () =>
      approveChangeProposalOnServer(
        {
          projectId: PROJECT_ID,
          proposalId: 'prop_tx_ref_check',
        },
        { db, verifiedOwnerId: OWNER_ID }
      ),
    /REFERENCE_INTEGRITY_ERROR/
  );
  assert.equal(txWriteLog.length, 0);

  // Case 2: Referenced character is deleted before transaction commits
  store.delete(`${basePath}/characters/char_seoyeon`);

  await assert.rejects(
    async () =>
      approveChangeProposalOnServer(
        {
          projectId: PROJECT_ID,
          proposalId: 'prop_tx_ref_check',
        },
        { db, verifiedOwnerId: OWNER_ID }
      ),
    /REFERENCE_INTEGRITY_ERROR/
  );
  assert.equal(txWriteLog.length, 0);
});

test('Stage 1.5 Transaction: manuscriptExtractionEngine saveVerifiedExtractionProposalsOnServer aborts with [TRANSACTION_READ_FAILED] if tx.get(collectionRef) fails instead of falling back to collectionRef.get()', async () => {
  const { db, store, nonTransactionalGetLog } =
    createStrictTransactionalMockFirestore({
      runId: 'run_extraction_save_tx_get_strict',
      failTxGetOnPathSubstring: '/changeProposals',
    });
  seedBaseFixturesAndProposal(store, 'prop_seed_01');
  const basePath = `users/${OWNER_ID}/projects/${PROJECT_ID}`;
  store.delete(`${basePath}/changeProposals/prop_seed_01`);

  // Analysis runs outside transaction (reads project/episode/revision/proposals)
  const analysisResult = await executeServerManuscriptExtraction(
    {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      revisionId: REVISION_ID,
      persistProposals: false,
    },
    {
      db,
      verifiedOwnerId: OWNER_ID,
      mockExtractorFn: async () => ({
        rawResponse: {
          analysis_summary: '트랜잭션 컬렉션 조회 실패 검증',
          candidates: [
            {
              targetEntityType: 'RELATIONSHIP',
              proposedAction: 'CREATE',
              existingTargetEntityId: null,
              title: '강현우와 이서연의 대립',
              rationale: '검을 겨누었다',
              beforeSummary: '없음',
              afterSummary: '대립 관계 생성',
              excerpt: EXCERPT_1,
              precedingContext: null,
              followingContext: null,
              sceneId: SCENE_ID,
              confidence: 0.95,
              dialogueClaimOnly: false,
              temporalContextType: 'PRESENT_EVENT',
              uncertaintyFlags: [],
              relationshipPayload: {
                sourceCharacterId: 'char_hyunwoo',
                sourceCharacterName: '강현우',
                targetCharacterId: 'char_seoyeon',
                targetCharacterName: '이서연',
                relationType: '적대적 대립',
                affinityScore: -60,
                isDirectional: true,
                description: '성벽 위 대치',
              },
              timelineEventPayload: null,
              foreshadowingPayload: null,
            },
          ],
        },
      }),
    }
  );

  const candidateId = analysisResult.candidates[0]!.candidateId;
  await assert.rejects(
    async () =>
      saveVerifiedExtractionProposalsOnServer(
        {
          projectId: PROJECT_ID,
          episodeId: EPISODE_ID,
          revisionId: REVISION_ID,
          analysisRunId: analysisResult.analysisRunId,
          analysisToken: analysisResult.analysisToken,
          selectedCandidateIds: [candidateId],
        },
        { db, verifiedOwnerId: OWNER_ID }
      ),
    /TRANSACTION_READ_FAILED/
  );

  assert.equal(nonTransactionalGetLog.length, 0);
});

test('Stage 1.5 Transaction: rejectChangeProposalOnServer aborts with [TRANSACTION_READ_FAILED] if tx.get fails, with 0 writes', async () => {
  const { db, store, txWriteLog, nonTransactionalGetLog } =
    createStrictTransactionalMockFirestore({
      runId: 'run_reject_tx_get_fail',
      failTxGetOnPathSubstring: 'changeProposalApprovalAudits',
    });
  seedBaseFixturesAndProposal(store, 'prop_reject_tx_fail');

  await assert.rejects(
    async () =>
      rejectChangeProposalOnServer(
        {
          projectId: PROJECT_ID,
          proposalId: 'prop_reject_tx_fail',
          reviewNote: '반려 시도',
        },
        { db, verifiedOwnerId: OWNER_ID }
      ),
    /TRANSACTION_READ_FAILED/
  );

  assert.equal(nonTransactionalGetLog.length, 0);
  assert.equal(txWriteLog.length, 0);
});
