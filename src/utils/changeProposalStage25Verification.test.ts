import test from 'node:test';
import assert from 'node:assert/strict';
import type { Firestore } from 'firebase-admin/firestore';
import {
  approveChangeProposalOnServer,
  rejectChangeProposalOnServer,
  executeRagSyncForApprovedProposalOnServer,
  renewRagTaskLeaseOnServer,
} from '../server/changeProposalApprovalEngine';
import {
  canEnableCanonApprovalButton,
  computeDeterministicApprovalAuditId,
  computeDeterministicRagSyncTaskId,
  computeEntityCanonicalContentHash,
  evaluateRagSyncRetryPolicy,
  verifyCanonEntityFreshnessForRag,
  verifyRagTaskLeaseFencing,
} from './changeProposalApprovalLogic';
import {
  setCustomGeminiEmbedContentForTesting,
} from '../server/ragEngine';
import { computeDeterministicSemanticEmbedding } from '../services/memorySearchProvider';
import { registerIsolatedMockFirestoreForTest } from '../server/authMiddleware';
import type {
  ChangeProposalPreviewResponse,
  RagSyncTaskRecord,
} from '../types/changeProposalApproval';
import type { ChangeProposal, CharacterRelationship } from '../types/novel';

/**
 * Concurrency-capable In-Memory Mock Firestore for Stage 2.5 Transaction & Lease Fencing Tests.
 * Serializes `runTransaction` calls through a promise queue so `Promise.allSettled`
 * tests transaction atomicity and optimistic concurrency conflict detection.
 */
function createSerializedMockFirestore(
  initialDocs: Record<string, Record<string, unknown>> = {}
) {
  const store = new Map<string, Record<string, unknown>>();
  for (const [path, data] of Object.entries(initialDocs)) {
    store.set(path, structuredClone(data));
  }

  let txQueue = Promise.resolve();

  function makeDocRef(docPath: string) {
    const segments = docPath.split('/');
    const id = segments[segments.length - 1];
    return {
      id,
      path: docPath,
      async get() {
        const raw = store.get(docPath);
        return {
          exists: Boolean(raw),
          id,
          data: () => (raw ? structuredClone(raw) : undefined),
        };
      },
      async set(
        payload: Record<string, unknown>,
        options?: { merge?: boolean }
      ) {
        if (options?.merge) {
          const prev = store.get(docPath) || {};
          store.set(docPath, { ...prev, ...structuredClone(payload) });
        } else {
          store.set(docPath, structuredClone(payload));
        }
      },
      async delete() {
        store.delete(docPath);
      },
    };
  }

  function makeCollectionRef(colPath: string) {
    return {
      path: colPath,
      doc(docId: string) {
        return makeDocRef(`${colPath}/${docId}`);
      },
      async get() {
        const prefix = `${colPath}/`;
        const docs: Array<{
          id: string;
          exists: boolean;
          ref: ReturnType<typeof makeDocRef>;
          data: () => Record<string, unknown>;
        }> = [];
        for (const [k, v] of store.entries()) {
          if (k.startsWith(prefix)) {
            const rest = k.slice(prefix.length);
            if (!rest.includes('/')) {
              docs.push({
                id: rest,
                exists: true,
                ref: makeDocRef(k),
                data: () => structuredClone(v),
              });
            }
          }
        }
        return {
          empty: docs.length === 0,
          size: docs.length,
          docs,
        };
      },
    };
  }

  const db = {
    doc(docPath: string) {
      return makeDocRef(docPath);
    },
    collection(colPath: string) {
      return makeCollectionRef(colPath);
    },
    batch() {
      const ops: Array<() => void> = [];
      return {
        set(
          ref: { path: string },
          data: Record<string, unknown>,
          options?: { merge?: boolean }
        ) {
          ops.push(() => {
            if (options?.merge) {
              const prev = store.get(ref.path) || {};
              store.set(ref.path, { ...prev, ...structuredClone(data) });
            } else {
              store.set(ref.path, structuredClone(data));
            }
          });
        },
        delete(ref: { path: string }) {
          ops.push(() => {
            store.delete(ref.path);
          });
        },
        async commit() {
          for (const op of ops) op();
        },
      };
    },
    async runTransaction<T>(
      updateFunction: (tx: {
        get: (ref: { path: string; id: string }) => Promise<{
          exists: boolean;
          id: string;
          data: () => Record<string, unknown> | undefined;
        }>;
        set: (
          ref: { path: string },
          data: Record<string, unknown>,
          options?: { merge?: boolean }
        ) => void;
        delete: (ref: { path: string }) => void;
      }) => Promise<T>
    ): Promise<T> {
      const runNext = txQueue.then(async () => {
        const stagedSets = new Map<
          string,
          { data: Record<string, unknown>; merge?: boolean }
        >();
        const stagedDeletes = new Set<string>();

        const tx = {
          async get(ref: { path: string; id: string }) {
            const raw = store.get(ref.path);
            return {
              exists: Boolean(raw),
              id: ref.id,
              data: () => (raw ? structuredClone(raw) : undefined),
            };
          },
          set(
            ref: { path: string },
            data: Record<string, unknown>,
            options?: { merge?: boolean }
          ) {
            stagedDeletes.delete(ref.path);
            stagedSets.set(ref.path, {
              data: structuredClone(data),
              merge: options?.merge,
            });
          },
          delete(ref: { path: string }) {
            stagedSets.delete(ref.path);
            stagedDeletes.add(ref.path);
          },
        };

        const result = await updateFunction(tx);
        for (const delPath of stagedDeletes) {
          store.delete(delPath);
        }
        for (const [setPath, entry] of stagedSets.entries()) {
          if (entry.merge) {
            const prev = store.get(setPath) || {};
            store.set(setPath, { ...prev, ...entry.data });
          } else {
            store.set(setPath, entry.data);
          }
        }
        return result;
      });

      txQueue = runNext.then(
        () => undefined,
        () => undefined
      );
      return runNext;
    },
  } as unknown as Firestore;

  registerIsolatedMockFirestoreForTest(db, {
    projectId: 'test-stage25-phase422',
    databaseId: 'test-db-stage25',
    runId: `run_stage25_${Date.now()}`,
  });

  return {
    db,
    store,
  };
}

function createSampleRelationshipSeed(params: {
  ownerId: string;
  projectId: string;
  proposalId: string;
}) {
  const { ownerId, projectId, proposalId } = params;
  const basePath = `users/${ownerId}/projects/${projectId}`;
  const manuscriptContent =
    '성문 앞 광장에서 카이렌과 리아나는 서로의 검을 거두고 피의 맹약을 맺었다.';
  const quote = '카이렌과 리아나는 서로의 검을 거두고 피의 맹약을 맺었다.';
  const startOffset = manuscriptContent.indexOf(quote);
  const endOffset = startOffset + quote.length;

  const envelope = {
    schemaVersion: 'PHASE_4_2_1_V1',
    proposalId,
    fingerprint: `fp_${proposalId}`,
    extractionRunId: `extrun_${proposalId}`,
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: 'rel_kairen_liana',
    proposedAction: 'CREATE',
    sourceRevisionId: 'rev_ep_1_v1',
    sourceEpisodeId: 'ep_1',
    sourceSceneId: 'scene_1',
    confidenceScore: 0.96,
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
      episodeId: 'ep_1',
      sceneId: 'scene_1',
      revisionId: 'rev_ep_1_v1',
      excerpt: quote,
      startOffset,
      endOffset,
    },
    relationshipDraft: {
      id: 'rel_kairen_liana',
      ownerId,
      projectId,
      sourceCharacterId: 'char_kairen',
      sourceCharacterName: '카이렌',
      targetCharacterId: 'char_liana',
      targetCharacterName: '리아나',
      relationType: '맹약 동맹',
      affinityScore: 90,
      isDirectional: false,
      description: '피의 맹약을 맺은 생사 동맹 관계.',
      lastChangedEpisodeId: 'ep_1',
      canonStatus: 'PROPOSED',
      sourceRevisionId: 'rev_ep_1_v1',
      createdBy: 'AI_ENGINE',
      provenance: {
        sourceType: 'MANUSCRIPT',
        createdBy: 'AI_ENGINE',
        ownerId,
        projectId,
        episodeId: 'ep_1',
        sceneId: 'scene_1',
        revisionId: 'rev_ep_1_v1',
        excerpt: quote,
        startOffset,
        endOffset,
      },
    },
    existingEntitySnapshot: null,
  };

  return {
    basePath,
    seed: {
      [basePath]: {
        id: projectId,
        ownerId,
        title: 'Stage 2.5 통합 검증 소설',
      },
      [`${basePath}/characters/char_kairen`]: {
        id: 'char_kairen',
        ownerId,
        projectId,
        name: '카이렌',
        canonStatus: 'CANON',
      },
      [`${basePath}/characters/char_liana`]: {
        id: 'char_liana',
        ownerId,
        projectId,
        name: '리아나',
        canonStatus: 'CANON',
      },
      [`${basePath}/episodes/ep_1`]: {
        id: 'ep_1',
        ownerId,
        projectId,
        episodeNumber: 1,
        title: '1화. 맹약의 광장',
        content: manuscriptContent,
        sourceRevisionId: 'rev_ep_1_v1',
        updatedAt: '2026-06-01T08:00:00.000Z',
      },
      [`${basePath}/scenes/scene_1`]: {
        id: 'scene_1',
        ownerId,
        projectId,
        episodeId: 'ep_1',
        sceneNumber: 1,
        title: '1화 제1장면',
      },
      [`${basePath}/revisions/rev_ep_1_v1`]: {
        id: 'rev_ep_1_v1',
        ownerId,
        projectId,
        episodeId: 'ep_1',
        content: manuscriptContent,
      },
      [`${basePath}/changeProposals/${proposalId}`]: {
        id: proposalId,
        ownerId,
        projectId,
        targetEntityType: 'RELATIONSHIP',
        targetEntityId: 'rel_kairen_liana',
        proposedAction: 'CREATE',
        title: '카이렌-리아나 피의 맹약 동맹',
        beforeSummary: '',
        afterSummary: '생사를 함께하는 피의 맹약 동맹',
        rationale: '1화 원고 근거',
        canonStatus: 'PROPOSED',
        createdBy: 'AI_ENGINE',
        triggerEpisodeId: 'ep_1',
        triggerSceneId: 'scene_1',
        sourceRevisionId: 'rev_ep_1_v1',
        proposedPayloadJson: JSON.stringify(envelope),
        reviewedAt: '',
        createdAt: '2026-06-01T08:10:00.000Z',
        updatedAt: '2026-06-01T08:10:00.000Z',
      },
    },
  };
}

// ============================================================================
// 1. Stage 2.5B Section 13: Concurrent Duplicate Approvals & Approve-vs-Reject
// ============================================================================
test('Stage 2.5B: Concurrent duplicate approvals result in single CANON entity, single APPROVED audit, and single ragSyncTask', async () => {
  const ownerId = 'author_s25_conc_1';
  const projectId = 'proj_s25_conc_1';
  const proposalId = 'prop_s25_conc_1';
  const { basePath, seed } = createSampleRelationshipSeed({
    ownerId,
    projectId,
    proposalId,
  });
  const { db, store } = createSerializedMockFirestore(seed);

  const [res1, res2] = await Promise.allSettled([
    approveChangeProposalOnServer(
      { projectId, proposalId, reviewNote: '동시 승인 요청 1' },
      {
        db,
        verifiedOwnerId: ownerId,
        nowIso: '2026-06-01T09:00:00.000Z',
      }
    ),
    approveChangeProposalOnServer(
      { projectId, proposalId, reviewNote: '동시 승인 요청 2' },
      {
        db,
        verifiedOwnerId: ownerId,
        nowIso: '2026-06-01T09:00:00.100Z',
      }
    ),
  ]);

  assert.equal(res1.status, 'fulfilled');
  assert.equal(res2.status, 'fulfilled');
  if (res1.status === 'fulfilled' && res2.status === 'fulfilled') {
    assert.equal(res1.value.ok, true);
    assert.equal(res2.value.ok, true);
    assert.equal(res1.value.status, 'APPROVED_APPLIED');
    assert.equal(res2.value.status, 'ALREADY_APPROVED');
  }

  // Verify exactly 1 relationship document, 1 audit document, 1 ragSyncTask
  const auditId = computeDeterministicApprovalAuditId(proposalId, 'APPROVED');
  const taskId = computeDeterministicRagSyncTaskId(proposalId);
  assert.equal(
    store.get(`${basePath}/relationships/rel_kairen_liana`)?.canonStatus,
    'CANON'
  );
  assert.equal(
    store.get(`${basePath}/changeProposalApprovalAudits/${auditId}`)?.decision,
    'APPROVED'
  );
  assert.equal(
    store.get(`${basePath}/ragSyncTasks/${taskId}`)?.status,
    'PENDING'
  );
});

test('Stage 2.5B: Concurrent approve vs reject race allows only one final decision without mixed state', async () => {
  const ownerId = 'author_s25_race';
  const projectId = 'proj_s25_race';
  const proposalId = 'prop_s25_race';
  const { basePath, seed } = createSampleRelationshipSeed({
    ownerId,
    projectId,
    proposalId,
  });
  const { db, store } = createSerializedMockFirestore(seed);

  const [approveOutcome, rejectOutcome] = await Promise.allSettled([
    approveChangeProposalOnServer(
      { projectId, proposalId, reviewNote: '승인 먼저 도착' },
      {
        db,
        verifiedOwnerId: ownerId,
        nowIso: '2026-06-01T09:05:00.000Z',
      }
    ),
    rejectChangeProposalOnServer(
      { projectId, proposalId, reviewNote: '거절 뒤늦게 도착' },
      {
        db,
        verifiedOwnerId: ownerId,
        nowIso: '2026-06-01T09:05:00.050Z',
      }
    ),
  ]);

  assert.equal(approveOutcome.status, 'fulfilled');
  assert.equal(rejectOutcome.status, 'rejected');
  if (
    approveOutcome.status === 'fulfilled' &&
    rejectOutcome.status === 'rejected'
  ) {
    assert.equal(approveOutcome.value.ok, true);
    assert.match(
      String(rejectOutcome.reason),
      /INVALID_PROPOSAL_STATE|PROPOSAL_NOT_PENDING|ALREADY_APPROVED|AUDIT_STATE_INCONSISTENCY/
    );
  }

  // Verify final state is strictly CANON + APPROVED (no REJECTED audit or status)
  assert.equal(
    store.get(`${basePath}/changeProposals/${proposalId}`)?.canonStatus,
    'CANON'
  );
  const auditId = computeDeterministicApprovalAuditId(proposalId, 'APPROVED');
  assert.equal(
    store.get(`${basePath}/changeProposalApprovalAudits/${auditId}`)?.decision,
    'APPROVED'
  );
});

// ============================================================================
// 2. Stage 2.5A Section 6: RAG Lease Fencing (Tests A, B, D, E)
// ============================================================================
test('Stage 2.5A Test A & B: Lease Fencing blocks expired Worker A from overwriting Worker B SYNCED result (both on late success and late failure)', async () => {
  const ownerId = 'author_s25_lease';
  const projectId = 'proj_s25_lease';
  const proposalId = 'prop_s25_lease';
  const { basePath, seed } = createSampleRelationshipSeed({
    ownerId,
    projectId,
    proposalId,
  });
  const { db, store } = createSerializedMockFirestore(seed);

  // 1. Approve proposal -> creates PENDING task with leaseGeneration: 0
  const approveRes = await approveChangeProposalOnServer(
    { projectId, proposalId },
    {
      db,
      verifiedOwnerId: ownerId,
      nowIso: '2026-06-01T10:00:00.000Z',
    }
  );
  assert.equal(approveRes.ok, true);

  const taskId = computeDeterministicRagSyncTaskId(proposalId);
  const auditId = computeDeterministicApprovalAuditId(proposalId, 'APPROVED');

  // 2. Worker A starts at 10:00:01 with a 10-second lease, but pauses mid-indexing while Worker B runs at 10:00:20
  let workerBPermittedToRun: () => void = () => {};
  const workerBReadyPromise = new Promise<void>((resolve) => {
    workerBPermittedToRun = resolve;
  });
  let releaseWorkerA: () => void = () => {};
  const workerAPausedPromise = new Promise<void>((resolve) => {
    releaseWorkerA = resolve;
  });

  const workerAPromise = executeRagSyncForApprovedProposalOnServer(
    { projectId, proposalId },
    {
      db,
      verifiedOwnerId: ownerId,
      workerId: 'worker_A',
      leaseDurationMs: 10_000,
      nowIso: '2026-06-01T10:00:01.000Z',
      customIndexRunner: async () => {
        // Worker A has acquired leaseGeneration = 1. Notify test to launch Worker B after lease expires.
        workerBPermittedToRun();
        await workerAPausedPromise;
        return { document: { id: 'doc_from_stale_worker_A' } };
      },
    }
  );

  await workerBReadyPromise;

  // Verify Worker A acquired leaseGeneration = 1
  const taskDuringA = store.get(
    `${basePath}/ragSyncTasks/${taskId}`
  ) as unknown as RagSyncTaskRecord;
  assert.equal(taskDuringA?.leaseOwner, 'worker_A');
  assert.equal(taskDuringA?.leaseGeneration, 1);

  // 3. At 10:00:20 (after Worker A's 10s lease expired), Worker B steals the lease (leaseGeneration = 2) and completes SYNCED
  const workerBRes = await executeRagSyncForApprovedProposalOnServer(
    { projectId, proposalId },
    {
      db,
      verifiedOwnerId: ownerId,
      workerId: 'worker_B',
      leaseDurationMs: 30_000,
      nowIso: '2026-06-01T10:00:20.000Z',
      customIndexRunner: async () => {
        return { document: { id: 'doc_from_authoritative_worker_B' } };
      },
    }
  );

  assert.equal(workerBRes.ok, true);
  assert.equal(workerBRes.ragSyncStatus, 'SYNCED');
  assert.equal(workerBRes.documentId, 'doc_from_authoritative_worker_B');
  assert.equal(workerBRes.leaseGeneration, 2);

  // 4. Now let Worker A resume and attempt to commit its late result -> MUST be blocked by Lease Fencing!
  releaseWorkerA();
  const workerARes = await workerAPromise;

  assert.equal(workerARes.ok, false);
  assert.equal(workerARes.skippedReason, 'LEASE_LOST');

  // Verify Worker B's SYNCED state and leaseGeneration = 2 remain intact!
  const finalTask = store.get(`${basePath}/ragSyncTasks/${taskId}`);
  assert.equal(finalTask?.status, 'SYNCED');
  assert.equal(finalTask?.leaseGeneration, 2);
  assert.equal(
    store.get(`${basePath}/changeProposalApprovalAudits/${auditId}`)?.ragSyncStatus,
    'SYNCED'
  );

  // 5. Verify Lease Renewal with stale Worker A generation is also rejected
  const renewRes = await renewRagTaskLeaseOnServer({
    db,
    ownerId,
    projectId,
    leasedTask: taskDuringA,
    nowIso: '2026-06-01T10:00:25.000Z',
  });
  assert.equal(renewRes.renewed, false);
  assert.equal(renewRes.reason, 'LEASE_LOST');
});

test('Stage 2.5A Test B: Expired Worker A failure cannot overwrite Worker B SYNCED state with FAILED', async () => {
  const ownerId = 'author_s25_lease_fail';
  const projectId = 'proj_s25_lease_fail';
  const proposalId = 'prop_s25_lease_fail';
  const { basePath, seed } = createSampleRelationshipSeed({
    ownerId,
    projectId,
    proposalId,
  });
  const { db, store } = createSerializedMockFirestore(seed);

  await approveChangeProposalOnServer(
    { projectId, proposalId },
    {
      db,
      verifiedOwnerId: ownerId,
      nowIso: '2026-06-01T10:00:00.000Z',
    }
  );

  const taskId = computeDeterministicRagSyncTaskId(proposalId);
  const auditId = computeDeterministicApprovalAuditId(proposalId, 'APPROVED');

  let notifyWorkerAStarted: () => void = () => {};
  const workerAStarted = new Promise<void>((r) => {
    notifyWorkerAStarted = r;
  });
  let triggerWorkerAFailure: () => void = () => {};
  const waitForWorkerAFailure = new Promise<void>((r) => {
    triggerWorkerAFailure = r;
  });

  const workerAPromise = executeRagSyncForApprovedProposalOnServer(
    { projectId, proposalId },
    {
      db,
      verifiedOwnerId: ownerId,
      workerId: 'worker_A_failing',
      leaseDurationMs: 10_000,
      nowIso: '2026-06-01T10:00:01.000Z',
      customIndexRunner: async () => {
        notifyWorkerAStarted();
        await waitForWorkerAFailure;
        throw new Error('LATE_WORKER_A_EMBEDDING_ERROR');
      },
    }
  );

  await workerAStarted;

  // Worker B takes over after lease expiry and succeeds
  const workerBRes = await executeRagSyncForApprovedProposalOnServer(
    { projectId, proposalId },
    {
      db,
      verifiedOwnerId: ownerId,
      workerId: 'worker_B_succeeding',
      leaseDurationMs: 30_000,
      nowIso: '2026-06-01T10:00:15.000Z',
      customIndexRunner: async () => ({
        document: { id: 'doc_worker_B_valid' },
      }),
    }
  );
  assert.equal(workerBRes.ok, true);
  assert.equal(workerBRes.ragSyncStatus, 'SYNCED');

  // Now Worker A throws an error -> Step D2 must block Worker A from overwriting SYNCED with FAILED
  triggerWorkerAFailure();
  const workerARes = await workerAPromise;
  assert.equal(workerARes.ok, false);
  assert.equal(workerARes.skippedReason, 'LEASE_LOST');
  // Task & Audit remain SYNCED!
  assert.equal(store.get(`${basePath}/ragSyncTasks/${taskId}`)?.status, 'SYNCED');
  assert.equal(
    store.get(`${basePath}/changeProposalApprovalAudits/${auditId}`)?.ragSyncStatus,
    'SYNCED'
  );
});

// ============================================================================
// 3. Stage 2.5A Section 7: Latest CANON Entity Freshness Protection (Test C)
// ============================================================================
test('Stage 2.5A Test C: Older approval RAG task is marked SUPERSEDED_BY_NEWER_CANON and never overwrites newer CANON entity index', async () => {
  const ownerId = 'author_s25_fresh';
  const projectId = 'proj_s25_fresh';
  const proposalAId = 'prop_s25_fresh_A';
  const { basePath, seed } = createSampleRelationshipSeed({
    ownerId,
    projectId,
    proposalId: proposalAId,
  });
  const { db, store } = createSerializedMockFirestore(seed);

  // 1. Approve Proposal A (creates rel_kairen_liana v1 at 10:00:00)
  const approveARes = await approveChangeProposalOnServer(
    { projectId, proposalId: proposalAId },
    {
      db,
      verifiedOwnerId: ownerId,
      nowIso: '2026-06-01T10:00:00.000Z',
    }
  );
  assert.equal(approveARes.ok, true);

  // 2. Before Proposal A's RAG task runs, the entity is updated to a newer CANON version (v2 at 10:05:00)
  const currentRel = store.get(`${basePath}/relationships/rel_kairen_liana`)!;
  const newerRel = {
    ...currentRel,
    relationshipType: '불신의 적대 관계 (2화 반전)',
    intensity: 95,
    changeSummary: '2화 배신 사건으로 적대 관계로 전환됨',
    sourceRevisionId: 'rev_ep_2_v1',
    updatedAt: '2026-06-01T10:05:00.000Z',
  };
  store.set(`${basePath}/relationships/rel_kairen_liana`, newerRel);

  // 3. Now execute Proposal A's RAG sync task -> Freshness check must detect newer CANON entity and mark SUPERSEDED_BY_NEWER_CANON
  let indexRunnerCalled = false;
  const ragARes = await executeRagSyncForApprovedProposalOnServer(
    { projectId, proposalId: proposalAId },
    {
      db,
      verifiedOwnerId: ownerId,
      nowIso: '2026-06-01T10:06:00.000Z',
      customIndexRunner: async () => {
        indexRunnerCalled = true;
        return { document: { id: 'should_not_be_indexed' } };
      },
    }
  );

  assert.equal(indexRunnerCalled, false, 'Stale task must not run indexer');
  assert.equal(ragARes.ok, false);
  assert.equal(ragARes.skippedReason, 'SUPERSEDED_BY_NEWER_CANON');
  assert.equal(ragARes.taskStatus, 'SUPERSEDED');
});

test('Stage 2.5A Test C2: Mid-indexing entity update is caught by beforeCommitGuard before RAG index activation', async () => {
  const ownerId = 'author_s25_mid_fresh';
  const projectId = 'proj_s25_mid_fresh';
  const proposalId = 'prop_s25_mid_fresh';
  const { basePath, seed } = createSampleRelationshipSeed({
    ownerId,
    projectId,
    proposalId,
  });
  const { db, store } = createSerializedMockFirestore(seed);

  await approveChangeProposalOnServer(
    { projectId, proposalId },
    {
      db,
      verifiedOwnerId: ownerId,
      nowIso: '2026-06-01T10:00:00.000Z',
    }
  );

  // Simulate entity changing during Gemini embedding generation (right before beforeCommitGuard)
  setCustomGeminiEmbedContentForTesting(async ({ contents }) => {
    const rel = store.get(`${basePath}/relationships/rel_kairen_liana`)!;
    store.set(`${basePath}/relationships/rel_kairen_liana`, {
      ...rel,
      relationshipType: '임베딩 도중 변경된 최신 CANON 관계',
      sourceRevisionId: 'rev_ep_3_newer',
      updatedAt: '2026-06-01T10:02:00.000Z',
    });
    return {
      embeddings: [
        { values: computeDeterministicSemanticEmbedding(contents, 768) },
      ],
    };
  });

  try {
    const ragRes = await executeRagSyncForApprovedProposalOnServer(
      { projectId, proposalId },
      {
        db,
        verifiedOwnerId: ownerId,
        nowIso: '2026-06-01T10:00:05.000Z',
      }
    );

    assert.equal(ragRes.ok, false);
    assert.equal(ragRes.skippedReason, 'SUPERSEDED_BY_NEWER_CANON');
    assert.equal(ragRes.taskStatus, 'SUPERSEDED');

    // Verify 0 stale memoryDocuments were committed to Firestore!
    const memDocsSnap = await db
      .collection(`${basePath}/memoryDocuments`)
      .get();
    assert.equal(
      memDocsSnap.size,
      0,
      'beforeCommitGuard must block stale index from being written to memoryDocuments'
    );
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
  }
});

// ============================================================================
// 4. Stage 2.5A Test D & E: Duplicate Concurrent RAG Sync & Expired Lease Recovery
// ============================================================================
test('Stage 2.5A Test D & E: Simultaneous RAG sync calls allow only 1 worker lease (LEASE_ACTIVE), and expired PROCESSING lease is recovered cleanly', async () => {
  const ownerId = 'author_s25_concrag';
  const projectId = 'proj_s25_concrag';
  const proposalId = 'prop_s25_concrag';
  const { basePath, seed } = createSampleRelationshipSeed({
    ownerId,
    projectId,
    proposalId,
  });
  const { db, store } = createSerializedMockFirestore(seed);

  await approveChangeProposalOnServer(
    { projectId, proposalId },
    {
      db,
      verifiedOwnerId: ownerId,
      nowIso: '2026-06-01T11:00:00.000Z',
    }
  );

  // Test D: Two simultaneous RAG sync requests at 11:00:01
  const [r1, r2] = await Promise.all([
    executeRagSyncForApprovedProposalOnServer(
      { projectId, proposalId },
      {
        db,
        verifiedOwnerId: ownerId,
        workerId: 'worker_concurrent_1',
        nowIso: '2026-06-01T11:00:01.000Z',
        customIndexRunner: async () => {
          await new Promise((r) => setTimeout(r, 20));
          return { document: { id: 'doc_single_winner' } };
        },
      }
    ),
    executeRagSyncForApprovedProposalOnServer(
      { projectId, proposalId },
      {
        db,
        verifiedOwnerId: ownerId,
        workerId: 'worker_concurrent_2',
        nowIso: '2026-06-01T11:00:01.000Z',
        customIndexRunner: async () => {
          return { document: { id: 'doc_duplicate_loser' } };
        },
      }
    ),
  ]);

  const syncedResponses = [r1, r2].filter((r) => r.ragSyncStatus === 'SYNCED');
  const skippedResponses = [r1, r2].filter(
    (r) => r.skippedReason === 'LEASE_ACTIVE'
  );
  assert.equal(syncedResponses.length, 1);
  assert.equal(skippedResponses.length, 1);
  assert.equal(syncedResponses[0].documentId, 'doc_single_winner');

  // Test E: Simulate stuck PROCESSING task after crash and verify recovery after leaseExpiresAtMs
  const taskId = computeDeterministicRagSyncTaskId(proposalId);
  const existingTask = store.get(`${basePath}/ragSyncTasks/${taskId}`)!;
  store.set(`${basePath}/ragSyncTasks/${taskId}`, {
    ...existingTask,
    status: 'PROCESSING',
    leaseOwner: 'crashed_worker',
    leaseGeneration: 4,
    leaseExpiresAtMs: new Date('2026-06-01T11:05:00.000Z').getTime(),
  });

  const recoveredRes = await executeRagSyncForApprovedProposalOnServer(
    { projectId, proposalId },
    {
      db,
      verifiedOwnerId: ownerId,
      workerId: 'recovery_worker',
      nowIso: '2026-06-01T11:06:00.000Z',
      customIndexRunner: async () => ({
        document: { id: 'doc_recovered_after_crash' },
      }),
    }
  );
  assert.equal(recoveredRes.ok, true);
  assert.equal(recoveredRes.ragSyncStatus, 'SYNCED');
  assert.equal(recoveredRes.leaseGeneration, 5);
});

// ============================================================================
// 5. Stage 2.5A Section 8: Retry Backoff & maxAttempts Enforcement
// ============================================================================
test('Stage 2.5A Section 8: evaluateRagSyncRetryPolicy and server engine block forceRetry bypass of backoff and maxAttempts', async () => {
  const nowMs = new Date('2026-06-01T12:00:10.000Z').getTime();

  const baseTask: RagSyncTaskRecord = {
    id: 'rag_task_prop_1',
    ownerId: 'author_1',
    projectId: 'proj_1',
    proposalId: 'prop_1',
    auditId: 'audit_prop_1',
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: 'rel_1',
    sourceRevisionId: 'rev_1',
    expectedSourceRevisionId: 'rev_1',
    expectedEntityUpdatedAt: '2026-06-01T12:00:00.000Z',
    expectedContentHash: 'hash_1',
    status: 'FAILED',
    attemptCount: 1,
    maxAttempts: 5,
    manualRetryCount: 0,
    leaseOwner: '',
    leaseGeneration: 1,
    leaseExpiresAtMs: nowMs - 10_000,
    nextRetryAfterMs: nowMs + 15_000,
    lastError: 'Simulated error',
    memoryDocumentId: '',
    createdAt: '2026-06-01T12:00:00.000Z',
    updatedAt: '2026-06-01T12:00:00.000Z',
  };

  // 1. Backoff active -> blocked even if forceRetry=true
  const backoffCheck = evaluateRagSyncRetryPolicy({
    task: baseTask,
    nowMs,
    workerId: 'worker_retry',
    forceRetry: true,
    manualRetry: true,
  });
  assert.equal(backoffCheck.allowed, false);
  if (!backoffCheck.allowed) {
    assert.equal(backoffCheck.reason, 'BACKOFF_WAITING');
    assert.equal(backoffCheck.retryAfterMs, 15_000);
  }

  // 2. maxAttempts reached -> blocked permanently even if forceRetry=true
  const maxAttemptsCheck = evaluateRagSyncRetryPolicy({
    task: {
      ...baseTask,
      attemptCount: 5,
      maxAttempts: 5,
      nextRetryAfterMs: nowMs - 1_000,
    },
    nowMs,
    workerId: 'worker_retry',
    forceRetry: true,
    manualRetry: true,
  });
  assert.equal(maxAttemptsCheck.allowed, false);
  if (!maxAttemptsCheck.allowed) {
    assert.equal(maxAttemptsCheck.reason, 'MAX_ATTEMPTS_EXCEEDED');
  }
});

// ============================================================================
// 6. Stage 2.5A Sections 3 & 5: Fail-Closed CANON Button Eligibility (9 Conditions)
// ============================================================================
test('Stage 2.5A Section 5: canEnableCanonApprovalButton enforces all 9 fail-closed conditions', () => {
  const baseProposal: ChangeProposal = {
    id: 'prop_ui_01',
    projectId: 'proj_ui_01',
    ownerId: 'user_ui_01',
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: 'rel_ui_01',
    proposedAction: 'CREATE',
    title: 'UI 승인 조건 검증 제안서',
    beforeSummary: '',
    afterSummary: '요약',
    rationale: '근거',
    proposedPayloadJson: '{}',
    triggerEpisodeId: 'ep_1',
    triggerSceneId: 'scene_1',
    sourceRevisionId: 'rev_ep_1_v1',
    canonStatus: 'PROPOSED',
    createdBy: 'AI_ENGINE',
    reviewedAt: '',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  };

  const validServerPreview: ChangeProposalPreviewResponse = {
    success: true,
    ok: true,
    executionMode: 'CLOUD_AUTHENTICATED',
    isCloudVerified: true,
    isLocalReferenceOnly: false,
    canApprove: true,
    conflictCode: null,
    conflictMessage: null,
    conflictDetails: null,
    projectId: 'proj_ui_01',
    proposalId: 'prop_ui_01',
    proposal: baseProposal,
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: 'rel_ui_01',
    proposedAction: 'CREATE',
    beforeEntity: null,
    afterEntityPreview: null,
    fieldDiffs: [],
    verifiedExcerpt: null,
    sourceRevisionId: 'rev_1',
    sourceEpisodeId: 'ep_1',
    sourceSceneId: 'scene_1',
    payoffNote: '',
    expectedUpdatedAt: null,
    entityDisplayNameMap: {},
    previewedAt: '2026-06-01T00:01:00.000Z',
  };

  // All 9 conditions satisfied -> enabled: true
  const validResult = canEnableCanonApprovalButton({
    isCloudAuthenticated: true,
    workspaceState: 'READY_FOR_REVIEW',
    preview: validServerPreview,
    selectedProposal: baseProposal,
    activeProjectId: 'proj_ui_01',
    latestRequestId: 7,
    previewRequestId: 7,
    isSubmitting: false,
  });
  assert.equal(validResult.enabled, true);

  // Condition 1: Unauthenticated -> disabled (CLOUD_AUTH_REQUIRED)
  assert.equal(
    canEnableCanonApprovalButton({
      isCloudAuthenticated: false,
      workspaceState: 'READY_FOR_REVIEW',
      preview: validServerPreview,
      selectedProposal: baseProposal,
      activeProjectId: 'proj_ui_01',
      latestRequestId: 7,
      previewRequestId: 7,
      isSubmitting: false,
    }).enabled,
    false
  );

  // Condition 4 & 5: Server preview failed / local fallback (isCloudVerified: false) -> disabled
  assert.equal(
    canEnableCanonApprovalButton({
      isCloudAuthenticated: true,
      workspaceState: 'READY_FOR_REVIEW',
      preview: {
        ...validServerPreview,
        isCloudVerified: false,
        isLocalReferenceOnly: true,
      },
      selectedProposal: baseProposal,
      activeProjectId: 'proj_ui_01',
      latestRequestId: 7,
      previewRequestId: 7,
      isSubmitting: false,
    }).enabled,
    false
  );

  // Condition 7: Stale preview response for a different proposal -> disabled
  assert.equal(
    canEnableCanonApprovalButton({
      isCloudAuthenticated: true,
      workspaceState: 'READY_FOR_REVIEW',
      preview: {
        ...validServerPreview,
        proposalId: 'prop_other_stale',
      },
      selectedProposal: baseProposal,
      activeProjectId: 'proj_ui_01',
      latestRequestId: 7,
      previewRequestId: 7,
      isSubmitting: false,
    }).enabled,
    false
  );

  // Condition 8: Request sequence mismatch (in-flight newer request) -> disabled
  assert.equal(
    canEnableCanonApprovalButton({
      isCloudAuthenticated: true,
      workspaceState: 'READY_FOR_REVIEW',
      preview: validServerPreview,
      selectedProposal: baseProposal,
      activeProjectId: 'proj_ui_01',
      latestRequestId: 8,
      previewRequestId: 7,
      isSubmitting: false,
    }).enabled,
    false
  );
});

// ============================================================================
// 7. Unit tests for Pure Lease Fencing & Freshness Helpers
// ============================================================================
test('Stage 2.5A: verifyRagTaskLeaseFencing & verifyCanonEntityFreshnessForRag pure helpers', () => {
  const leasedTask: RagSyncTaskRecord = {
    id: 'rag_task_1',
    ownerId: 'author_1',
    projectId: 'proj_1',
    proposalId: 'prop_1',
    auditId: 'audit_1',
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: 'rel_1',
    sourceRevisionId: 'rev_1',
    expectedSourceRevisionId: 'rev_1',
    expectedEntityUpdatedAt: '2026-06-01T10:00:00.000Z',
    expectedContentHash: '',
    status: 'PROCESSING',
    attemptCount: 2,
    maxAttempts: 5,
    manualRetryCount: 0,
    leaseOwner: 'worker_1',
    leaseGeneration: 3,
    leaseExpiresAtMs: 100000,
    nextRetryAfterMs: 0,
    lastError: '',
    memoryDocumentId: '',
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
  };

  const leaseOk = verifyRagTaskLeaseFencing({
    currentTask: { ...leasedTask },
    leasedTask,
  });
  assert.equal(leaseOk.ok, true);

  const leaseMismatch = verifyRagTaskLeaseFencing({
    currentTask: {
      ...leasedTask,
      leaseOwner: 'worker_2',
      leaseGeneration: 4,
      attemptCount: 3,
    },
    leasedTask,
  });
  assert.equal(leaseMismatch.ok, false);
  if (!leaseMismatch.ok) {
    assert.equal(leaseMismatch.reason, 'LEASE_LOST');
  }

  const entityData: CharacterRelationship = {
    id: 'rel_1',
    ownerId: 'author_1',
    projectId: 'proj_1',
    sourceCharacterId: 'char_a',
    targetCharacterId: 'char_b',
    relationType: '동맹',
    affinityScore: 80,
    isDirectional: false,
    description: '맹약',
    canonStatus: 'CANON',
    effectiveEpisodeId: 'ep_1',
    effectiveEventId: '',
    sourceRevisionId: 'rev_1',
    createdBy: 'AI_ENGINE',
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
  };
  const hash = computeEntityCanonicalContentHash(entityData);
  const taskWithHash: RagSyncTaskRecord = {
    ...leasedTask,
    expectedContentHash: hash,
  };

  const freshOk = verifyCanonEntityFreshnessForRag({
    task: taskWithHash,
    authoritativeEntity: entityData,
  });
  assert.equal(freshOk.ok, true);

  const staleEntity = verifyCanonEntityFreshnessForRag({
    task: taskWithHash,
    authoritativeEntity: {
      ...entityData,
      relationType: '적대',
      updatedAt: '2026-06-01T10:05:00.000Z',
    },
  });
  assert.equal(staleEntity.ok, false);
  if (!staleEntity.ok) {
    assert.equal(staleEntity.reason, 'SUPERSEDED_BY_NEWER_CANON');
  }
});

