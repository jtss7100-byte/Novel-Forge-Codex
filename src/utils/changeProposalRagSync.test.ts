import assert from 'node:assert/strict';
import test from 'node:test';
import { setCustomGeminiEmbedContentForTesting } from '../server/ragEngine';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { registerIsolatedMockFirestoreForTest } from '../server/authMiddleware';
import {
  approveChangeProposalOnServer,
  executeRagSyncForApprovedProposalOnServer,
} from '../server/changeProposalApprovalEngine';
import {
  computeDeterministicApprovalAuditId,
  computeDeterministicRagSyncTaskId,
} from './changeProposalApprovalLogic';
import {
  buildMemoryIndexInputFromApprovedEntity,
  computeDeterministicSemanticEmbedding,
} from '../services/memorySearchProvider';

function createStatefulMockFirestore(store: Map<string, Record<string, unknown>>): Firestore {
  const makeDocRef = (docPath: string) => ({
    id: docPath.split('/').pop() || '',
    path: docPath,
    __kind: 'docRef',
    get: async () => ({
      id: docPath.split('/').pop() || '',
      exists: store.has(docPath),
      data: () => store.get(docPath),
    }),
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      if (opts?.merge && store.has(docPath)) {
        store.set(docPath, { ...store.get(docPath), ...data });
      } else {
        store.set(docPath, { ...data });
      }
    },
    update: async (data: Record<string, unknown>) => {
      const existing = store.get(docPath) || {};
      store.set(docPath, { ...existing, ...data });
    },
    delete: async () => {
      store.delete(docPath);
    },
  });

  const makeColRef = (colPath: string) => {
    const queryFilter = (predicates: Array<{ field: string; value: unknown }>) => ({
      where: (field: string, _op: string, value: unknown) =>
        queryFilter([...predicates, { field, value }]),
      get: async () => {
        const prefix = `${colPath}/`;
        const docs = Array.from(store.entries())
          .filter(([k, v]) => {
            if (!k.startsWith(prefix) || k.slice(prefix.length).includes('/')) {
              return false;
            }
            return predicates.every((p) => v[p.field] === p.value);
          })
          .map(([k, v]) => ({
            id: k.split('/').pop() || '',
            ref: makeDocRef(k),
            exists: true,
            data: () => v,
          }));
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    });

    return {
      path: colPath,
      __kind: 'colRef',
      doc: (id: string) => makeDocRef(`${colPath}/${id}`),
      where: (field: string, _op: string, value: unknown) =>
        queryFilter([{ field, value }]),
      get: async () => queryFilter([]).get(),
    };
  };

  return {
    doc: (docPath: string) => makeDocRef(docPath),
    collection: (colPath: string) => makeColRef(colPath),
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        set: (
          target: { path: string },
          data: Record<string, unknown>,
          opts?: { merge?: boolean }
        ) => {
          ops.push(() => {
            if (opts?.merge && store.has(target.path)) {
              store.set(target.path, { ...store.get(target.path), ...data });
            } else {
              store.set(target.path, { ...data });
            }
          });
        },
        delete: (target: { path: string }) => {
          ops.push(() => store.delete(target.path));
        },
        commit: async () => {
          for (const op of ops) op();
        },
      };
    },
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const stagedWrites: Array<{
        path: string;
        data: Record<string, unknown>;
        merge?: boolean;
      }> = [];
      const tx = {
        get: async (target: { path: string }) => ({
          id: target.path.split('/').pop() || '',
          exists: store.has(target.path),
          data: () => store.get(target.path),
        }),
        set: (
          target: { path: string },
          data: Record<string, unknown>,
          opts?: { merge?: boolean }
        ) => {
          stagedWrites.push({
            path: target.path,
            data,
            merge: opts?.merge,
          });
        },
      };
      const result = await fn(tx);
      for (const w of stagedWrites) {
        if (w.merge && store.has(w.path)) {
          store.set(w.path, { ...store.get(w.path), ...w.data });
        } else {
          store.set(w.path, { ...w.data });
        }
      }
      return result;
    },
  } as unknown as Firestore;
}

test('Phase 4.2.2 Stage 2B (Sections 11 & 12): buildMemoryIndexInputFromApprovedEntity builds valid RAG inputs for TIMELINE_EVENT, FORESHADOWING, and RELATIONSHIP (CANON only)', () => {
  const charMap = {
    char_1: '카엘 반스',
    char_2: '세라피나 룩스',
  };

  const relCanon = {
    id: 'rel_01',
    ownerId: 'u_1',
    projectId: 'p_1',
    sourceCharacterId: 'char_1',
    targetCharacterId: 'char_2',
    relationType: '생사를 함께하는 동맹',
    affinityScore: 88,
    isDirectional: false,
    description: '북부 성채 강하 작전을 함께 수행하는 절대 신뢰 관계.',
    canonStatus: 'CANON' as const,
    effectiveEpisodeId: 'ep_01',
    effectiveEventId: 'evt_01',
    sourceRevisionId: 'rev_01',
    createdBy: 'AUTHOR' as const,
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
  };

  const relInput = buildMemoryIndexInputFromApprovedEntity({
    targetEntityType: 'RELATIONSHIP',
    entity: relCanon,
    characterNameMap: charMap,
  });

  assert.ok(relInput);
  assert.equal(relInput.sourceEntityType, 'RELATIONSHIP');
  assert.equal(relInput.sourceEntityId, 'rel_01');
  assert.equal(relInput.canonStatus, 'CANON');
  assert.ok(relInput.title.includes('카엘 반스'));
  assert.ok(relInput.title.includes('세라피나 룩스'));
  assert.deepEqual(relInput.relatedCharacterIds, ['char_1', 'char_2']);

  // Non-CANON relationship must return null
  const relDraft = { ...relCanon, canonStatus: 'DRAFT' as const };
  assert.equal(
    buildMemoryIndexInputFromApprovedEntity({
      targetEntityType: 'RELATIONSHIP',
      entity: relDraft,
      characterNameMap: charMap,
    }),
    null
  );
});

test('Phase 4.2.2 Stage 2B (Section 12): approveChangeProposalOnServer creates persistent ragSyncTask and executeRagSyncForApprovedProposalOnServer indexes RELATIONSHIP into RAG and handles failure/retry without rolling back CANON', async () => {
  const store = new Map<string, Record<string, unknown>>();
  const mockDb = createStatefulMockFirestore(store);

  registerIsolatedMockFirestoreForTest(mockDb, {
    projectId: 'test-ragsync-phase422',
    databaseId: 'test-db-ragsync',
    runId: 'run_ragsync_01',
  });

  const ownerId = 'user_rag_01';
  const projectId = 'proj_rag_01';
  const basePath = `users/${ownerId}/projects/${projectId}`;
  const ts = Timestamp.fromDate(new Date('2026-11-10T10:00:00.000Z'));

  store.set(basePath, { id: projectId, ownerId, title: 'RAG 동기화 테스트 작품' });
  const content = '전투가 시작되었다. 카엘과 세라피나는 서로의 등을 맡기며 심연의 결계를 돌파했다. 승리의 함성이 울렸다.';
  const quote = '카엘과 세라피나는 서로의 등을 맡기며 심연의 결계를 돌파했다.';
  const startOffset = content.indexOf(quote);
  const endOffset = startOffset + quote.length;

  store.set(`${basePath}/episodes/ep_01`, {
    id: 'ep_01',
    ownerId,
    projectId,
    episodeNumber: 1,
    title: '1화',
    content,
  });
  store.set(`${basePath}/scenes/scene_01`, {
    id: 'scene_01',
    ownerId,
    projectId,
    episodeId: 'ep_01',
    sceneNumber: 1,
    title: '1화 제1장면',
  });
  store.set(`${basePath}/revisions/rev_01`, {
    id: 'rev_01',
    ownerId,
    projectId,
    episodeId: 'ep_01',
    content,
  });
  store.set(`${basePath}/characters/char_1`, {
    id: 'char_1',
    ownerId,
    projectId,
    name: '카엘 반스',
  });
  store.set(`${basePath}/characters/char_2`, {
    id: 'char_2',
    ownerId,
    projectId,
    name: '세라피나 룩스',
  });

  const proposalId = 'prop_rel_rag_01';
  const envelope = {
    schemaVersion: 'PHASE_4_2_1_V1',
    proposalId,
    fingerprint: 'fp_prop_rel_rag_01',
    extractionRunId: 'extrun_rag_01',
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: 'rel_rag_new_01',
    proposedAction: 'CREATE',
    sourceRevisionId: 'rev_01',
    sourceEpisodeId: 'ep_01',
    sourceSceneId: 'scene_01',
    confidenceScore: 0.95,
    temporalContext: 'PRESENT_EVENT',
    uncertaintyFlags: [],
    canonConflicts: [],
    verifiedExcerpt: {
      excerpt: quote,
      matchedText: quote,
      startOffset,
      endOffset,
      matchMethod: 'EXACT',
      matchCount: 1,
    },
    provenance: {
      sourceType: 'MANUSCRIPT',
      createdBy: 'AI_ENGINE',
      ownerId,
      projectId,
      episodeId: 'ep_01',
      sceneId: 'scene_01',
      revisionId: 'rev_01',
      excerpt: quote,
      startOffset,
      endOffset,
    },
    relationshipDraft: {
      id: 'rel_rag_new_01',
      ownerId,
      projectId,
      sourceCharacterId: 'char_1',
      sourceCharacterName: '카엘 반스',
      targetCharacterId: 'char_2',
      targetCharacterName: '세라피나 룩스',
      relationType: '전장의 생사 동맹',
      affinityScore: 92,
      isDirectional: false,
      description: '심연의 결계를 함께 돌파하며 맺어진 생사 동맹 관계.',
      lastChangedEpisodeId: 'ep_01',
      canonStatus: 'PROPOSED',
      sourceRevisionId: 'rev_01',
      createdBy: 'AI_ENGINE',
      provenance: {
        sourceType: 'MANUSCRIPT',
        createdBy: 'AI_ENGINE',
        ownerId,
        projectId,
        episodeId: 'ep_01',
        sceneId: 'scene_01',
        revisionId: 'rev_01',
        excerpt: quote,
        startOffset,
        endOffset,
      },
    },
    existingEntitySnapshot: null,
  };

  store.set(`${basePath}/changeProposals/${proposalId}`, {
    id: proposalId,
    ownerId,
    projectId,
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: 'rel_rag_new_01',
    proposedAction: 'CREATE',
    title: '카엘 ↔ 세라피나 전장 동맹 생성',
    rationale: '1화 결계 돌파 장면',
    beforeSummary: '',
    afterSummary: '전장의 생사 동맹 (+92)',
    proposedPayloadJson: JSON.stringify(envelope),
    canonStatus: 'PROPOSED',
    triggerEpisodeId: 'ep_01',
    triggerSceneId: 'scene_01',
    sourceRevisionId: 'rev_01',
    createdBy: 'AI_ENGINE',
    reviewedAt: '',
    createdAt: ts,
    updatedAt: ts,
  });

  // 1. Approve proposal via atomic transaction
  const approveRes = await approveChangeProposalOnServer(
    {
      projectId,
      proposalId,
      reviewNote: '전장 동맹 설정 승인',
    },
    {
      db: mockDb,
      verifiedOwnerId: ownerId,
    }
  );

  assert.equal(approveRes.ok, true);
  assert.equal(approveRes.decision, 'APPROVED');

  const ragTaskId = computeDeterministicRagSyncTaskId(proposalId);
  const auditId = computeDeterministicApprovalAuditId(proposalId, 'APPROVED');

  const taskAfterApprove = store.get(`${basePath}/ragSyncTasks/${ragTaskId}`);
  assert.ok(taskAfterApprove, 'ragSyncTask must be created atomically in transaction');
  assert.equal(taskAfterApprove.status, 'PENDING');
  assert.equal(taskAfterApprove.targetEntityType, 'RELATIONSHIP');

  const auditAfterApprove = store.get(
    `${basePath}/changeProposalApprovalAudits/${auditId}`
  );
  assert.ok(auditAfterApprove);
  assert.equal(auditAfterApprove.ragSyncStatus, 'PENDING');
  const immutableBeforeSnapshot = auditAfterApprove.beforeSnapshotJson;
  const immutableAfterSnapshot = auditAfterApprove.afterSnapshotJson;

  // 2. Simulate transient failure in RAG indexer first: CANON entity & APPROVED audit must NOT roll back
  const failNowIso = '2026-06-01T10:00:00.000Z';
  const failedRagRes = await executeRagSyncForApprovedProposalOnServer(
    {
      projectId,
      proposalId,
    },
    {
      db: mockDb,
      verifiedOwnerId: ownerId,
      nowIso: failNowIso,
      customIndexRunner: async () => {
        throw new Error('SIMULATED_EMBEDDING_NETWORK_TIMEOUT');
      },
    }
  );

  assert.equal(failedRagRes.ok, false);
  assert.equal(failedRagRes.ragSyncStatus, 'FAILED');
  assert.equal(failedRagRes.taskStatus, 'FAILED');

  // Verify immediate retry before backoff expires is blocked with BACKOFF_WAITING
  const earlyRetryRes = await executeRagSyncForApprovedProposalOnServer(
    {
      projectId,
      proposalId,
      forceRetry: true,
    },
    {
      db: mockDb,
      verifiedOwnerId: ownerId,
      nowIso: '2026-06-01T10:00:01.000Z',
    }
  );
  assert.equal(earlyRetryRes.ok, false);
  assert.equal(earlyRetryRes.skippedReason, 'BACKOFF_WAITING');

  // Verify CANON entity and proposal status remain intact despite RAG failure
  const canonRel = store.get(`${basePath}/relationships/rel_rag_new_01`);
  assert.ok(canonRel);
  assert.equal(canonRel.canonStatus, 'CANON');
  assert.equal(
    store.get(`${basePath}/changeProposals/${proposalId}`)?.canonStatus,
    'CANON'
  );
  assert.equal(
    store.get(`${basePath}/changeProposalApprovalAudits/${auditId}`)?.ragSyncStatus,
    'FAILED'
  );

  // 3. Retry RAG sync after backoff window using real indexMemoryInputOnServer with mock Gemini embedder in DI Firestore mode
  setCustomGeminiEmbedContentForTesting(async ({ contents }) => ({
    embeddings: [
      { values: computeDeterministicSemanticEmbedding(contents, 768) },
    ],
  }));

  try {
    const retryRagRes = await executeRagSyncForApprovedProposalOnServer(
      {
        projectId,
        proposalId,
      },
      {
        db: mockDb,
        verifiedOwnerId: ownerId,
        nowIso: '2026-06-01T10:00:06.000Z',
      }
    );

    assert.equal(retryRagRes.ok, true);
    assert.equal(retryRagRes.ragSyncStatus, 'SYNCED');
    assert.equal(retryRagRes.taskStatus, 'SYNCED');
    assert.ok(retryRagRes.documentId);

    // Verify memoryDocument was persisted in Firestore with sourceEntityType == 'RELATIONSHIP'
    const indexedDoc = store.get(
      `${basePath}/memoryDocuments/${retryRagRes.documentId}`
    );
    assert.ok(indexedDoc, 'MemoryDocument for RELATIONSHIP must be persisted');
    assert.equal(indexedDoc.sourceEntityType, 'RELATIONSHIP');
    assert.equal(indexedDoc.canonStatus, 'CANON');
    assert.equal(indexedDoc.indexStatus, 'INDEXED');

    // Verify audit ragSyncStatus updated to SYNCED while preserving immutable fields
    const auditAfterSync = store.get(
      `${basePath}/changeProposalApprovalAudits/${auditId}`
    );
    assert.ok(auditAfterSync);
    assert.equal(auditAfterSync.ragSyncStatus, 'SYNCED');
    assert.equal(auditAfterSync.beforeSnapshotJson, immutableBeforeSnapshot);
    assert.equal(auditAfterSync.afterSnapshotJson, immutableAfterSnapshot);
    assert.equal(auditAfterSync.decision, 'APPROVED');

    // 4. Calling executeRagSyncForApprovedProposalOnServer again when already SYNCED is idempotent
    const idempotentRes = await executeRagSyncForApprovedProposalOnServer(
      {
        projectId,
        proposalId,
      },
      {
        db: mockDb,
        verifiedOwnerId: ownerId,
      }
    );
    assert.equal(idempotentRes.ok, true);
    assert.equal(idempotentRes.ragSyncStatus, 'SYNCED');
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
  }
});
