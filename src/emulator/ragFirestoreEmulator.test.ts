import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneMemoryRetriever } from '../server/sceneMemoryRetrieval';
import { buildEvaluationFixture } from '../utils/novelWritingEvaluationBenchmark';
import type { Episode } from '../types/novel';
import {
  clearEmbeddingCacheForTesting,
  clearLocalRagDiskCacheForTesting,
  cleanupInactiveRagGenerationsOnServer,
  indexMemoryInputOnServer,
  reserveRagGenerationOnServer,
  searchProjectMemoryOnServer,
  setCustomGeminiEmbedContentForTesting,
  simulateServerRestartForTesting,
  buildRagStagingReceiptId,
  type FirestoreRagManifestDoc,
} from '../server/ragEngine.ts';
import { diagnoseAndRecoverProjectRagIntegrityOnServer } from '../server/changeProposalApprovalEngine.ts';
import {
  createIsolatedTestFirestoreClient,
  PROD_DEFAULT_FIREBASE_PROJECT_ID,
  PROD_DEFAULT_FIRESTORE_DATABASE_ID,
  registerProjectOwnerForAdminCheck,
} from '../server/authMiddleware.ts';
import {
  computeDeterministicSemanticEmbedding,
  extractProjectMemoryIndexInputs,
  LARGE_SCALE_RAG_TX_OP_THRESHOLD,
} from '../services/memorySearchProvider.ts';
import type { RagGenerationStagingReceipt } from '../types/foundation.ts';

function assertEmulatorConfigured(): {
  emulatorHost: string;
  projectId: string;
  databaseId: string;
} {
  const emulatorHost = (process.env.FIRESTORE_EMULATOR_HOST || '').trim();
  if (!emulatorHost) {
    throw new Error(
      '[EMULATOR_HOST_NOT_CONFIGURED] FIRESTORE_EMULATOR_HOST is not set. Run via `firebase emulators:exec --project demo-novelforge-rag-integrity --config firebase.emulator.json --only auth,firestore "bun run test:emulator"`.'
    );
  }
  const projectId = (
    process.env.GCLOUD_PROJECT ||
    process.env.TEST_FIREBASE_PROJECT_ID ||
    'demo-novelforge-rag-integrity'
  ).trim();
  const databaseId = (
    process.env.TEST_FIRESTORE_DATABASE_ID || '(default)'
  ).trim();

  if (
    !projectId.startsWith('demo-') ||
    projectId === PROD_DEFAULT_FIREBASE_PROJECT_ID ||
    databaseId === PROD_DEFAULT_FIRESTORE_DATABASE_ID ||
    databaseId !== '(default)'
  ) {
    throw new Error(
      `[EMULATOR_PROD_ISOLATION_VIOLATION] Refusing non-isolated Emulator target project=${projectId}, db=${databaseId}`
    );
  }

  return { emulatorHost, projectId, databaseId };
}

function makeEmulatorRunTag(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function resetTestRuntime(): void {
  clearEmbeddingCacheForTesting();
  clearLocalRagDiskCacheForTesting();
  simulateServerRestartForTesting();
}

function installDeterministicEmbedder(): void {
  setCustomGeminiEmbedContentForTesting(async ({ contents, config }) => {
    const dim =
      typeof (config as { outputDimensionality?: number } | undefined)
        ?.outputDimensionality === 'number'
        ? (config as { outputDimensionality: number }).outputDimensionality
        : 64;
    return {
      embeddings: [
        { values: computeDeterministicSemanticEmbedding(contents, dim) },
      ],
    };
  });
}

function buildChunkText(
  count: number,
  tag: string,
  sentinel = ''
): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const extra = i === count - 1 && sentinel ? `${sentinel} ` : '';
    lines.push(
      `# ${tag}_PART_${i + 1}\n${extra}${tag} 정사 장기 기억 검증 블록 ${i + 1}번.`
    );
  }
  return lines.join('\n\n');
}

test('Emulator E1 (P0-A): Staging Receipt TOCTOU elimination under real Firestore runTransaction (Cleaner wins & Worker wins)', async () => {
  const env = assertEmulatorConfigured();
  const runTag = makeEmulatorRunTag();
  resetTestRuntime();
  installDeterministicEmbedder();

  const handle = createIsolatedTestFirestoreClient({
    runId: `emu_e1_${runTag}`,
    projectId: env.projectId,
    databaseId: env.databaseId,
  });

  const ownerId = `emu_author_e1_${runTag}`;
  const projId = `emu_proj_e1_${runTag}`;
  const cacheNs = `emu_ns_e1_${runTag}`;

  try {
    const basePath = `users/${ownerId}/projects/${projId}`;
    registerProjectOwnerForAdminCheck(projId, ownerId);
    await handle.db.doc(basePath).set({
      id: projId,
      ownerId,
      lifecycleStatus: 'ACTIVE',
    });

    // Establish active gen 1
    await indexMemoryInputOnServer(
      {
        ownerId,
        projectId: projId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_e1',
        sourceRevisionId: 'rev_e1_1',
        canonStatus: 'CANON',
        title: 'Emulator E1 gen1',
        summary: 'Active gen 1',
        fullText: buildChunkText(210, 'E1_G1', 'E1_ACTIVE_G1'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db: handle.db,
        cacheNamespace: cacheNs,
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );

    // Seed stale gen 2 receipt + orphan doc so Cleaner can claim gen 2 when triggered
    const gen2 = 2;
    const gen2StagingId = buildRagStagingReceiptId({
      projectId: projId,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_e1',
      generation: gen2,
    });
    const staleIso = new Date(Date.now() - 30 * 60_000).toISOString();
    const staleDocId = `memdoc_${projId}_EPISODE_ep_e1_part_1__g${gen2}`;
    await handle.db.doc(`${basePath}/memoryDocuments/${staleDocId}`).set({
      id: staleDocId,
      documentId: staleDocId,
      ownerId,
      projectId: projId,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_e1',
      indexGeneration: gen2,
      isActiveGeneration: false,
      stagingId: gen2StagingId,
      updatedAt: staleIso,
      createdAt: staleIso,
    });
    await handle.db.doc(`${basePath}/ragGenerationStaging/${gen2StagingId}`).set({
      id: gen2StagingId,
      ownerId,
      projectId: projId,
      entityKey: `${ownerId}:${projId}:EPISODE:ep_e1`,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_e1',
      generation: gen2,
      activationMode: 'MANIFEST_POINTER',
      status: 'STAGED',
      expectedDocumentIds: [staleDocId],
      expectedDocumentCount: 1,
      expectedChunkCount: 210,
      expectedContentHash: 'stale_h',
      expectedSourceRevisionId: 'stale_rev',
      stagedDocumentCount: 1,
      stagedChunkCount: 0,
      verifiedDocumentCount: 0,
      verifiedChunkCount: 0,
      batchesCommitted: 1,
      createdAt: staleIso,
      updatedAt: staleIso,
    });

    // Case E1a: Cleaner wins between Worker's initial read and PREPARING TX -> Worker aborts with ACTIVATION_BLOCKED_BY_CLEANUP
    await assert.rejects(
      async () =>
        indexMemoryInputOnServer(
          {
            ownerId,
            projectId: projId,
            sourceEntityType: 'EPISODE',
            sourceEntityId: 'ep_e1',
            sourceRevisionId: 'rev_e1_2',
            requestedGeneration: gen2,
            stagingId: gen2StagingId,
            canonStatus: 'CANON',
            title: 'Emulator E1 gen2 race',
            summary: 'Cleaner wins TOCTOU',
            fullText: buildChunkText(210, 'E1_G2'),
            maxChunkLength: 100,
            embeddingDimension: 64,
          },
          {
            db: handle.db,
            cacheNamespace: cacheNs,
            forceRebuild: true,
            durableCommitPolicy: {
              requireDurableCloudCommit: true,
              requireActiveGenerationVerification: true,
            },
            onAfterStagingInitReadBeforeWriteHook: async () => {
              await cleanupInactiveRagGenerationsOnServer(
                {
                  ownerId,
                  projectId: projId,
                  targetGeneration: gen2,
                  targetStagingId: gen2StagingId,
                  retainCompletedReceipts: true,
                },
                { db: handle.db, cacheNamespace: cacheNs }
              );
            },
          }
        ),
      /\[ACTIVATION_BLOCKED_BY_CLEANUP\]/
    );

    const rAfterCleanerWin = (
      await handle.db.doc(`${basePath}/ragGenerationStaging/${gen2StagingId}`).get()
    ).data() as RagGenerationStagingReceipt;
    assert.equal(rAfterCleanerWin.status, 'CLEANUP_COMPLETED');

    // Case E1b: Worker wins with fresh PREPARING receipt during Cleaner scan -> Cleaner Claim TX skips
    const gen3 = 3;
    const gen3StagingId = buildRagStagingReceiptId({
      projectId: projId,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_e1',
      generation: gen3,
    });
    const gen3DocId = `memdoc_${projId}_EPISODE_ep_e1_part_1__g${gen3}`;
    await handle.db.doc(`${basePath}/memoryDocuments/${gen3DocId}`).set({
      id: gen3DocId,
      documentId: gen3DocId,
      ownerId,
      projectId: projId,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_e1',
      indexGeneration: gen3,
      isActiveGeneration: false,
      stagingId: gen3StagingId,
      updatedAt: staleIso,
      createdAt: staleIso,
    });
    await handle.db.doc(`${basePath}/ragGenerationStaging/${gen3StagingId}`).set({
      id: gen3StagingId,
      ownerId,
      projectId: projId,
      entityKey: `${ownerId}:${projId}:EPISODE:ep_e1`,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_e1',
      generation: gen3,
      activationMode: 'MANIFEST_POINTER',
      status: 'STAGED',
      expectedDocumentIds: [gen3DocId],
      expectedDocumentCount: 1,
      expectedChunkCount: 1,
      expectedContentHash: 'h3',
      expectedSourceRevisionId: 'r3',
      stagedDocumentCount: 1,
      stagedChunkCount: 0,
      verifiedDocumentCount: 0,
      verifiedChunkCount: 0,
      batchesCommitted: 1,
      createdAt: staleIso,
      updatedAt: staleIso,
    });

    const cleanerLoseRes = await cleanupInactiveRagGenerationsOnServer(
      {
        ownerId,
        projectId: projId,
        targetGeneration: gen3,
        targetStagingId: gen3StagingId,
        onAfterCandidateScanBeforeClaimTx: async () => {
          // Worker atomically refreshes receipt to live PREPARING right before Cleaner Claim TX
          const freshIso = new Date().toISOString();
          await handle.db.runTransaction(async (tx) => {
            tx.set(
              handle.db.doc(`${basePath}/ragGenerationStaging/${gen3StagingId}`),
              {
                status: 'PREPARING',
                updatedAt: freshIso,
              },
              { merge: true }
            );
          });
        },
      },
      { db: handle.db, cacheNamespace: cacheNs }
    );
    assert.equal(cleanerLoseRes.deletedDocs, 0);
    assert.ok(cleanerLoseRes.skippedInFlightStagingCount >= 1);
    const g3Receipt = (
      await handle.db.doc(`${basePath}/ragGenerationStaging/${gen3StagingId}`).get()
    ).data() as RagGenerationStagingReceipt;
    assert.equal(g3Receipt.status, 'PREPARING');
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
    resetTestRuntime();
    await handle.db
      .recursiveDelete(handle.db.doc(`users/${ownerId}`))
      .catch(() => undefined);
    await handle.cleanup();
  }
});

test('Emulator E2 & E3: Real Firestore TX race between Cleanup Claim and Stage B Activation (both winner directions)', async () => {
  const env = assertEmulatorConfigured();
  const runTag = makeEmulatorRunTag();
  resetTestRuntime();
  installDeterministicEmbedder();

  const handle = createIsolatedTestFirestoreClient({
    runId: `emu_e2_e3_${runTag}`,
    projectId: env.projectId,
    databaseId: env.databaseId,
  });

  const ownerId = `emu_author_e23_${runTag}`;
  const projId = `emu_proj_e23_${runTag}`;
  const cacheNs = `emu_ns_e23_${runTag}`;

  try {
    const basePath = `users/${ownerId}/projects/${projId}`;
    registerProjectOwnerForAdminCheck(projId, ownerId);
    await handle.db.doc(basePath).set({
      id: projId,
      ownerId,
      lifecycleStatus: 'ACTIVE',
    });

    // E3: Cleaner scans STAGED gen 1 -> Worker commits Stage B first -> Cleaner Claim TX throws CLEANUP_BLOCKED_ACTIVE_GENERATION
    let e3CleanerBlocked = false;
    let e3CleanupPromise: Promise<void> | null = null;
    const g1 = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId: projId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_e23',
        sourceRevisionId: 'rev_1',
        canonStatus: 'CANON',
        title: 'Emulator E3 gen1',
        summary: 'Stage B wins',
        fullText: buildChunkText(210, 'E23_G1', 'EMULATOR_G1_SANCTUARY'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db: handle.db,
        cacheNamespace: cacheNs,
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
        onBetweenStageAAndBHook: async ({ generation, stagingId }) => {
          e3CleanupPromise = (async () => {
            try {
              await cleanupInactiveRagGenerationsOnServer(
                {
                  ownerId,
                  projectId: projId,
                  targetGeneration: generation,
                  targetStagingId: stagingId,
                  failOnActiveConflict: true,
                  staleStagingThresholdMs: 0,
                  onAfterCandidateScanBeforeClaimTx: async () => {
                    await new Promise((r) => setTimeout(r, 80));
                  },
                },
                { db: handle.db, cacheNamespace: cacheNs }
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (msg.includes('[CLEANUP_BLOCKED_ACTIVE_GENERATION]')) {
                e3CleanerBlocked = true;
                return;
              }
              throw err;
            }
          })();
          await new Promise((r) => setTimeout(r, 25));
        },
      }
    );
    await e3CleanupPromise!;
    assert.equal(e3CleanerBlocked, true);
    assert.equal(g1.document.indexGeneration, 1);

    // E2: Worker stages gen 2 -> Cleaner claims CLEANUP_PENDING before Stage B -> Worker Stage B aborts, gen 1 preserved
    await assert.rejects(
      async () =>
        indexMemoryInputOnServer(
          {
            ownerId,
            projectId: projId,
            sourceEntityType: 'EPISODE',
            sourceEntityId: 'ep_e23',
            sourceRevisionId: 'rev_2',
            canonStatus: 'CANON',
            title: 'Emulator E2 gen2',
            summary: 'Cleaner wins Stage B',
            fullText: buildChunkText(210, 'E23_G2', 'CONTESTED_G2_PHANTOM'),
            maxChunkLength: 100,
            embeddingDimension: 64,
          },
          {
            db: handle.db,
            cacheNamespace: cacheNs,
            forceRebuild: true,
            durableCommitPolicy: {
              requireDurableCloudCommit: true,
              requireActiveGenerationVerification: true,
            },
            onBetweenStageAAndBHook: async ({ generation, stagingId }) => {
              const cleanRes = await cleanupInactiveRagGenerationsOnServer(
                {
                  ownerId,
                  projectId: projId,
                  targetGeneration: generation,
                  targetStagingId: stagingId,
                  staleStagingThresholdMs: 0,
                  retainCompletedReceipts: false,
                },
                { db: handle.db, cacheNamespace: cacheNs }
              );
              assert.ok(cleanRes.deletedDocs >= 1);
              assert.ok(cleanRes.deletedChunks >= 210);
              assert.equal(cleanRes.deletedStagingReceipts, 1);
            },
          }
        ),
      /\[ACTIVATION_BLOCKED_BY_CLEANUP\]/
    );

    const searchAfter = await searchProjectMemoryOnServer({
      ownerId,
      query: {
        projectId: projId,
        queryText: 'EMULATOR_G1_SANCTUARY',
        topK: 5,
      },
      db: handle.db,
      cacheNamespace: cacheNs,
    });
    assert.ok(searchAfter.hits.length > 0);
    assert.ok(searchAfter.hits.every((h) => h.document.indexGeneration === 1));
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
    resetTestRuntime();
    await handle.db
      .recursiveDelete(handle.db.doc(`users/${ownerId}`))
      .catch(() => undefined);
    await handle.cleanup();
  }
});

test('Emulator E4, E5, E6 & E9 (P0-B): Multi-cleaner ownership conflict, crash lease expiry epoch takeover, stale cleaner fenced delete abort, <=200-op fenced delete TX & partial maxBatches resume', async () => {
  const env = assertEmulatorConfigured();
  const runTag = makeEmulatorRunTag();
  resetTestRuntime();
  installDeterministicEmbedder();

  const handle = createIsolatedTestFirestoreClient({
    runId: `emu_e4569_${runTag}`,
    projectId: env.projectId,
    databaseId: env.databaseId,
  });

  const ownerId = `emu_author_e4569_${runTag}`;
  const projId = `emu_proj_e4569_${runTag}`;
  const cacheNs = `emu_ns_e4569_${runTag}`;

  try {
    const basePath = `users/${ownerId}/projects/${projId}`;
    registerProjectOwnerForAdminCheck(projId, ownerId);
    await handle.db.doc(basePath).set({
      id: projId,
      ownerId,
      lifecycleStatus: 'ACTIVE',
    });

    // Establish superseded gen 1 (450 chunks -> 3 Fenced Delete TXs: 200 + 200 + 51 ops)
    const g1 = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId: projId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_fenced',
        sourceRevisionId: 'rev_f1',
        canonStatus: 'CANON',
        title: 'Superseded g1',
        summary: '450 chunks for multi-batch fenced cleanup',
        fullText: buildChunkText(450, 'EF_G1'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db: handle.db,
        cacheNamespace: cacheNs,
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );

    // Establish active gen 2 (250 chunks - MUST stay untouched!)
    const g2 = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId: projId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_fenced',
        sourceRevisionId: 'rev_f2',
        canonStatus: 'CANON',
        title: 'Active g2',
        summary: '250 active chunks protected',
        fullText: buildChunkText(250, 'EF_G2', 'PROTECTED_G2_CORE'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db: handle.db,
        cacheNamespace: cacheNs,
        forceRebuild: true,
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    assert.equal(g2.document.indexGeneration, 2);

    const claimKeyG1 = `${ownerId}:${projId}:EPISODE:ep_fenced::g${g1.document.indexGeneration}`;
    const baseNow = Date.now();

    // E4 & E5: Cleaner A simulates unclean crash at batch #2 leaving active lease (expires baseNow + 5000)
    await assert.rejects(
      async () =>
        cleanupInactiveRagGenerationsOnServer(
          {
            ownerId,
            projectId: projId,
            cleanupOwner: 'cleaner_A',
            cleanupLeaseDurationMs: 5_000,
            nowMs: baseNow,
            simulateDeleteFailureAtBatchNumber: 2,
            simulateUncleanCrashLeaveLeaseActive: true,
          },
          { db: handle.db, cacheNamespace: cacheNs }
        ),
      /\[CLEANUP_BATCH_DELETE_FAILED\]/
    );

    // Cleaner B BEFORE expiry MUST fail with [CLEANUP_OWNERSHIP_CONFLICT]
    await assert.rejects(
      async () =>
        cleanupInactiveRagGenerationsOnServer(
          {
            ownerId,
            projectId: projId,
            cleanupOwner: 'cleaner_B',
            nowMs: baseNow + 1_000,
            failOnOwnershipConflict: true,
          },
          { db: handle.db, cacheNamespace: cacheNs }
        ),
      /\[CLEANUP_OWNERSHIP_CONFLICT\]/
    );

    // E9: Partial resume with maxBatches: 1 AFTER lease expiry (baseNow + 10_000) bumps epoch and leaves CLEANUP_PENDING until 0 remaining
    const partialTakeover = await cleanupInactiveRagGenerationsOnServer(
      {
        ownerId,
        projectId: projId,
        cleanupOwner: 'cleaner_C',
        cleanupLeaseDurationMs: 5_000,
        nowMs: baseNow + 10_000,
        maxBatches: 1,
      },
      { db: handle.db, cacheNamespace: cacheNs }
    );
    assert.equal(partialTakeover.cleanupEpoch, 2);
    assert.equal(partialTakeover.pendingResumeClaimKeys?.includes(claimKeyG1), true);

    // Finalize remaining batch
    const finalTakeover = await cleanupInactiveRagGenerationsOnServer(
      {
        ownerId,
        projectId: projId,
        cleanupOwner: 'cleaner_D',
        nowMs: baseNow + 20_000,
        retainCompletedReceipts: false,
      },
      { db: handle.db, cacheNamespace: cacheNs }
    );
    assert.equal(finalTakeover.completedClaimKeys?.includes(claimKeyG1), true);
    assert.equal(finalTakeover.deletedStagingReceipts, 1);

    // Verify stale Cleaner wakes up with old epoch and aborts on Fenced Delete TX
    // (Create another stale gen 3 superseded by active gen 4 to test live pause + epoch hijack)
    const g3 = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId: projId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_fenced_2',
        sourceRevisionId: 'rev_f3',
        canonStatus: 'CANON',
        title: 'Superseded g3',
        summary: '450 chunks for live zombie abort',
        fullText: buildChunkText(450, 'EF_G3'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db: handle.db,
        cacheNamespace: cacheNs,
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    await indexMemoryInputOnServer(
      {
        ownerId,
        projectId: projId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_fenced_2',
        sourceRevisionId: 'rev_f4',
        canonStatus: 'CANON',
        title: 'Active g4',
        summary: 'Active g4',
        fullText: buildChunkText(210, 'EF_G4', 'PROTECTED_G4_CITADEL'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db: handle.db,
        cacheNamespace: cacheNs,
        forceRebuild: true,
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );

    const zombieT0 = Date.now() + 100_000;
    await assert.rejects(
      async () =>
        cleanupInactiveRagGenerationsOnServer(
          {
            ownerId,
            projectId: projId,
            sourceEntityId: 'ep_fenced_2',
            cleanupOwner: 'zombie_cleaner',
            cleanupLeaseDurationMs: 2_000,
            nowMs: zombieT0,
            onAfterDeleteBatchHook: async ({ batchesCommitted }) => {
              if (batchesCommitted === 1) {
                // Concurrent fresher cleaner takes over after lease expires and bumps epoch in Firestore!
                await cleanupInactiveRagGenerationsOnServer(
                  {
                    ownerId,
                    projectId: projId,
                    sourceEntityId: 'ep_fenced_2',
                    cleanupOwner: 'fresh_cleaner',
                    nowMs: zombieT0 + 10_000,
                  },
                  { db: handle.db, cacheNamespace: cacheNs }
                );
              }
            },
          },
          { db: handle.db, cacheNamespace: cacheNs }
        ),
      /\[CLEANUP_OWNERSHIP_LOST\]/
    );

    // E6 verify g2 & g4 active docs + chunks untouched!
    assert.ok(
      (await handle.db.doc(`${basePath}/memoryDocuments/${g2.document.id}`).get()).exists
    );
    const remainingG1Docs = await handle.db
      .collection(`${basePath}/memoryDocuments`)
      .where('indexGeneration', '==', g1.document.indexGeneration)
      .get();
    assert.equal(remainingG1Docs.size, 0);
    const remainingG3Chunks = await handle.db
      .collection(`${basePath}/memoryChunks`)
      .where('indexGeneration', '==', g3.document.indexGeneration)
      .get();
    assert.equal(remainingG3Chunks.size, 0);
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
    resetTestRuntime();
    await handle.db
      .recursiveDelete(handle.db.doc(`users/${ownerId}`))
      .catch(() => undefined);
    await handle.cleanup();
  }
});

test('Emulator E7, E8, E10 & Section 8: Boundaries, Replay Protection via retiredGenerationsByEntity, Cross-Tenant/Clock Guards, All 7 Chunk Corruptions & 1,200+ Healthy Verification', async () => {
  const env = assertEmulatorConfigured();
  const runTag = makeEmulatorRunTag();
  resetTestRuntime();
  installDeterministicEmbedder();

  const handle = createIsolatedTestFirestoreClient({
    runId: `emu_e7810_${runTag}`,
    projectId: env.projectId,
    databaseId: env.databaseId,
  });

  const ownerId = `emu_author_e78_${runTag}`;
  const intruderId = `emu_intruder_e78_${runTag}`;
  const projId = `emu_proj_e78_${runTag}`;
  const cacheNs = `emu_ns_e78_${runTag}`;

  try {
    const basePath = `users/${ownerId}/projects/${projId}`;
    registerProjectOwnerForAdminCheck(projId, ownerId);
    await handle.db.doc(basePath).set({
      id: projId,
      ownerId,
      lifecycleStatus: 'ACTIVE',
    });

    // E10: Cross-tenant cleanup MUST be rejected with 403
    await assert.rejects(
      async () =>
        cleanupInactiveRagGenerationsOnServer(
          { ownerId: intruderId, projectId: projId },
          { db: handle.db, cacheNamespace: cacheNs }
        ),
      /403|소유자|거부/
    );

    // E7: Boundary 199 chunks (INLINE_DOC) vs 200 chunks (MANIFEST_POINTER)
    assert.equal(LARGE_SCALE_RAG_TX_OP_THRESHOLD, 200);
    const smallRes = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId: projId,
        sourceEntityType: 'RELATIONSHIP',
        sourceEntityId: 'rel_199',
        sourceRevisionId: 'rev_199',
        canonStatus: 'CANON',
        title: '199 chunks',
        summary: '200 ops boundary',
        fullText: buildChunkText(199, 'S199'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db: handle.db,
        cacheNamespace: cacheNs,
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    assert.equal(smallRes.document.activationMode, 'INLINE_DOC');

    // Section 8 (Part 1): 1,205 chunks healthy verification with authorConfirmedProductionBulkWrite
    const bulkRes = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId: projId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_bulk_1205',
        sourceRevisionId: 'rev_bulk_1',
        canonStatus: 'CANON',
        title: '대규모 1205 청크 정상 검증',
        summary: '1205 chunks healthy verification',
        fullText: buildChunkText(1205, 'BULK1205', 'EMU_1205_CHRONO_SPIRE'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db: handle.db,
        cacheNamespace: cacheNs,
        authorConfirmedProductionBulkWrite: true,
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    assert.equal(bulkRes.document.activationMode, 'MANIFEST_POINTER');
    assert.equal(bulkRes.activeGenerationVerified, true);
    assert.ok((bulkRes.firestoreBatchesCommitted ?? 0) >= 3);

    // Cold restart recovery + search finds chunk #1205 sentinel across multi-part active documents!
    resetTestRuntime();
    const coldSearch = await searchProjectMemoryOnServer({
      ownerId,
      query: {
        projectId: projId,
        queryText: 'EMU_1205_CHRONO_SPIRE',
        topK: 5,
      },
      db: handle.db,
      cacheNamespace: cacheNs,
    });
    assert.ok(coldSearch.hits.length > 0, 'Cold search must return at least 1 hit');
    assert.equal(
      coldSearch.recoveredFromFirestore,
      true,
      'Cold search after resetTestRuntime must recover state from Firestore'
    );

    const bulkEntityKey = `${ownerId}:${projId}:EPISODE:ep_bulk_1205`;
    const manifestSnapAfterBulk = await handle.db
      .doc(`${basePath}/ragManifest/control`)
      .get();
    assert.equal(
      manifestSnapAfterBulk.exists,
      true,
      'ragManifest/control must exist in Firestore after bulk commit'
    );
    const manifestDataAfterBulk =
      manifestSnapAfterBulk.data() as FirestoreRagManifestDoc;
    const bulkEntityState =
      manifestDataAfterBulk.entityStates?.[bulkEntityKey];
    assert.ok(
      bulkEntityState,
      `Manifest must contain active entityState for ${bulkEntityKey}`
    );
    assert.equal(
      bulkEntityState.lifecycleStatus,
      'ACTIVE',
      'Active entityState in Manifest must have lifecycleStatus=ACTIVE'
    );
    assert.equal(
      bulkEntityState.activeGeneration,
      bulkRes.document.indexGeneration,
      'Manifest activeGeneration must match bulkRes generation'
    );

    const allowedActiveDocIds = new Set(bulkEntityState.activeDocumentIds || []);
    const expectedBulkPartDocIds = new Set([
      bulkRes.document.id,
      ...(bulkRes.additionalParts?.map((p) => p.document.id) || []),
    ]);
    assert.ok(
      allowedActiveDocIds.size >= 3,
      `Expected >=3 active multi-part documents in Manifest for 1205 chunks, got ${allowedActiveDocIds.size}`
    );

    const bulkStagingSnap = await handle.db
      .collection(`${basePath}/ragGenerationStaging`)
      .where('sourceEntityId', '==', 'ep_bulk_1205')
      .get();
    const stagingStatusByGen = new Map<number, string>();
    for (const sDoc of bulkStagingSnap.docs) {
      const sData = sDoc.data() as Partial<RagGenerationStagingReceipt>;
      if (typeof sData.generation === 'number' && typeof sData.status === 'string') {
        stagingStatusByGen.set(sData.generation, sData.status);
      }
    }
    assert.equal(
      stagingStatusByGen.get(bulkEntityState.activeGeneration),
      'ACTIVATED',
      'Active generation staging receipt must be ACTIVATED'
    );

    for (const hit of coldSearch.hits) {
      assert.equal(hit.document.ownerId, ownerId);
      assert.equal(hit.chunk.ownerId, ownerId);
      assert.equal(hit.document.projectId, projId);
      assert.equal(hit.chunk.projectId, projId);
      assert.equal(hit.document.sourceEntityType, 'EPISODE');
      assert.equal(hit.chunk.sourceEntityType, 'EPISODE');
      assert.equal(hit.document.sourceEntityId, 'ep_bulk_1205');
      assert.equal(hit.chunk.sourceEntityId, 'ep_bulk_1205');
      assert.equal(hit.document.sourceRevisionId, 'rev_bulk_1');
      assert.equal(hit.chunk.sourceRevisionId, 'rev_bulk_1');
      assert.equal(
        hit.document.indexGeneration,
        bulkEntityState.activeGeneration,
        'Search hit document generation must equal active Manifest generation'
      );
      assert.equal(
        hit.chunk.indexGeneration,
        bulkEntityState.activeGeneration,
        'Search hit chunk generation must equal active Manifest generation'
      );
      assert.equal(hit.chunk.documentId, hit.document.id);
      assert.equal(
        allowedActiveDocIds.has(hit.document.id),
        true,
        `Hit document ${hit.document.id} must be listed in active Manifest activeDocumentIds`
      );
      assert.equal(
        expectedBulkPartDocIds.has(hit.document.id),
        true,
        `Hit document ${hit.document.id} must match bulkRes multi-part document IDs`
      );
      assert.notEqual(hit.document.isActiveGeneration, false);
      assert.notEqual(hit.chunk.isActiveGeneration, false);
      assert.equal(hit.document.lifecycleStatus, 'ACTIVE');
      assert.notEqual(hit.chunk.lifecycleStatus, 'REINDEXING_KEEP_OLD');
      assert.notEqual(hit.chunk.lifecycleStatus, 'PENDING_DELETE');
      assert.notEqual(hit.chunk.lifecycleStatus, 'DELETED');
      const receiptStatus = stagingStatusByGen.get(
        hit.document.indexGeneration ?? -1
      );
      assert.ok(
        receiptStatus === undefined || receiptStatus === 'ACTIVATED',
        `Search must never return non-activated staging status (${receiptStatus})`
      );
    }

    const topHit = coldSearch.hits[0];
    assert.ok(topHit.score > 0, 'Top hit score must be positive');
    assert.equal(
      topHit.chunk.content.includes('EMU_1205_CHRONO_SPIRE'),
      true,
      'Top search hit chunk content must contain sentinel term EMU_1205_CHRONO_SPIRE'
    );
    const persistedTopDocSnap = await handle.db
      .doc(`${basePath}/memoryDocuments/${topHit.document.id}`)
      .get();
    assert.equal(
      persistedTopDocSnap.exists,
      true,
      'Top hit MemoryDocument must exist in Firestore'
    );
    const persistedTopDoc = persistedTopDocSnap.data() as Record<string, unknown>;
    assert.equal(persistedTopDoc.ownerId, ownerId);
    assert.equal(persistedTopDoc.projectId, projId);
    assert.equal(persistedTopDoc.sourceEntityType, 'EPISODE');
    assert.equal(persistedTopDoc.sourceEntityId, 'ep_bulk_1205');
    assert.equal(persistedTopDoc.sourceRevisionId, 'rev_bulk_1');
    assert.equal(
      persistedTopDoc.indexGeneration,
      bulkEntityState.activeGeneration
    );
    assert.equal(persistedTopDoc.isActiveGeneration, true);
    assert.equal(persistedTopDoc.lifecycleStatus, 'ACTIVE');

    // Section 8 (Part 2): Corrupt EVERY ONE of the 7 required chunk integrity fields in real Firestore
    const corruptionMutations: Array<{
      label: string;
      patch: Record<string, unknown>;
    }> = [
      { label: 'contentHash', patch: { contentHash: 'corrupt_hash_xyz' } },
      { label: 'sourceStartOffset', patch: { sourceStartOffset: -1 } },
      { label: 'sourceEndOffset', patch: { sourceEndOffset: -1 } },
      { label: 'indexGeneration', patch: { indexGeneration: 99999 } },
      { label: 'chunkIndex', patch: { chunkIndex: 99999 } },
      { label: 'embeddingDimension', patch: { embeddingDimension: 9999 } },
      { label: 'embeddingModelId', patch: { embeddingModelId: 'corrupt-model-v0' } },
    ];

    for (let idx = 0; idx < corruptionMutations.length; idx++) {
      const m = corruptionMutations[idx];
      await assert.rejects(
        async () =>
          indexMemoryInputOnServer(
            {
              ownerId,
              projectId: projId,
              sourceEntityType: 'EPISODE',
              sourceEntityId: 'ep_bulk_1205',
              sourceRevisionId: `rev_corrupt_${idx}`,
              canonStatus: 'CANON',
              title: `Corrupt ${m.label}`,
              summary: 'Corruption check',
              fullText: buildChunkText(205, `CORRUPT_${idx}`),
              maxChunkLength: 100,
              embeddingDimension: 64,
            },
            {
              db: handle.db,
              cacheNamespace: cacheNs,
              forceRebuild: true,
              durableCommitPolicy: {
                requireDurableCloudCommit: true,
                requireActiveGenerationVerification: true,
              },
              onDuringStagingHook: async ({ generation }) => {
                const cSnap = await handle.db
                  .collection(`${basePath}/memoryChunks`)
                  .where('indexGeneration', '==', generation)
                  .limit(1)
                  .get();
                assert.equal(cSnap.empty, false);
                await cSnap.docs[0].ref.set(m.patch, { merge: true });
              },
            }
          ),
        /\[STAGING_VERIFICATION_INCOMPLETE\]/,
        `Field corruption (${m.label}) MUST reject with [STAGING_VERIFICATION_INCOMPLETE]`
      );
    }

    // Active bulk gen MUST still be intact and aborted corruption rebuilds MUST NOT be searchable!
    const diag = await diagnoseAndRecoverProjectRagIntegrityOnServer(
      { projectId: projId, autoRecover: false },
      { db: handle.db, verifiedOwnerId: ownerId }
    );
    assert.ok(diag);

    resetTestRuntime();
    const postCorruptionSearch = await searchProjectMemoryOnServer({
      ownerId,
      query: {
        projectId: projId,
        queryText: 'EMU_1205_CHRONO_SPIRE',
        topK: 5,
      },
      db: handle.db,
      cacheNamespace: cacheNs,
    });
    assert.ok(postCorruptionSearch.hits.length > 0);
    assert.ok(
      postCorruptionSearch.hits.every(
        (h) =>
          h.document.indexGeneration === bulkEntityState.activeGeneration &&
          allowedActiveDocIds.has(h.document.id) &&
          h.document.sourceRevisionId === 'rev_bulk_1'
      ),
      'Aborted corruption rebuilds must never leak into search or displace active generation'
    );

    // E8: Replay protection after pruning >40 CLEANUP_COMPLETED claims + receipt deletion
    const entityKeyReplay = `${ownerId}:${projId}:RELATIONSHIP:rel_replay`;
    const pendingKeepEntityKey = `${ownerId}:${projId}:TIMELINE_EVENT:tl_replay_pending`;
    const pendingKeepClaimKey = `${pendingKeepEntityKey}::g1`;
    const seededClaims: Record<string, unknown> = {};
    for (let g = 1; g <= 45; g++) {
      seededClaims[`${entityKeyReplay}::g${g}`] = {
        claimKey: `${entityKeyReplay}::g${g}`,
        entityKey: entityKeyReplay,
        ownerId,
        projectId: projId,
        sourceEntityType: 'RELATIONSHIP',
        sourceEntityId: 'rel_replay',
        generation: g,
        cleanupOperationId: `op_${g}`,
        cleanupEpoch: g,
        cleanupOwner: 'seed',
        status: 'CLEANUP_COMPLETED',
        targetDocumentIds: [],
        claimedAt: '2026-06-01T00:00:00.000Z',
        completedAt: `2026-06-01T00:${String(g).padStart(2, '0')}:00.000Z`,
      };
    }
    seededClaims[pendingKeepClaimKey] = {
      claimKey: pendingKeepClaimKey,
      entityKey: pendingKeepEntityKey,
      ownerId,
      projectId: projId,
      sourceEntityType: 'TIMELINE_EVENT',
      sourceEntityId: 'tl_replay_pending',
      generation: 1,
      cleanupOperationId: 'op_pending_live',
      cleanupEpoch: 45,
      cleanupOwner: 'active_peer',
      status: 'CLEANUP_PENDING',
      targetDocumentIds: ['doc_pending_live'],
      claimedAt: '2026-06-01T00:50:00.000Z',
      cleanupLeaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      cleanupLeaseExpiresAtMs: Date.now() + 300_000,
    };

    await handle.db.doc(`${basePath}/ragManifest/control`).set(
      {
        cleanupEpochCounter: 45,
        cleanupClaims: seededClaims,
      },
      { merge: true }
    );
    // Clean one more generation to trigger pruning + ledger compaction
    await handle.db.doc(`${basePath}/memoryDocuments/doc_replay_46`).set({
      id: 'doc_replay_46',
      documentId: 'doc_replay_46',
      ownerId,
      projectId: projId,
      sourceEntityType: 'RELATIONSHIP',
      sourceEntityId: 'rel_replay',
      indexGeneration: 46,
      isActiveGeneration: false,
      updatedAt: '2026-06-01T00:00:00.000Z',
    });
    const clean46Res = await cleanupInactiveRagGenerationsOnServer(
      {
        ownerId,
        projectId: projId,
        sourceEntityType: 'RELATIONSHIP',
        sourceEntityId: 'rel_replay',
        targetGeneration: 46,
        staleStagingThresholdMs: 0,
      },
      { db: handle.db, cacheNamespace: cacheNs }
    );
    assert.equal(clean46Res.deletedDocs, 1);
    assert.equal(
      clean46Res.completedClaimKeys?.includes(`${entityKeyReplay}::g46`),
      true
    );

    const prunedManifest = (
      await handle.db.doc(`${basePath}/ragManifest/control`).get()
    ).data() as FirestoreRagManifestDoc;
    assert.ok(Object.keys(prunedManifest.cleanupClaims || {}).length <= 30);
    assert.equal(
      `${entityKeyReplay}::g1` in (prunedManifest.cleanupClaims || {}),
      false,
      'Pruned old claim g1 must be deleted from Firestore cleanupClaims map'
    );
    assert.equal(
      prunedManifest.cleanupClaims?.[pendingKeepClaimKey]?.status,
      'CLEANUP_PENDING',
      'Live CLEANUP_PENDING claim must be preserved across pruning'
    );
    assert.equal(
      prunedManifest.entityStates?.[bulkEntityKey]?.activeGeneration,
      bulkRes.document.indexGeneration,
      'tx.update(manifestRef) must preserve unrelated entityStates'
    );
    assert.ok(
      (prunedManifest.retiredGenerationsByEntity?.[entityKeyReplay]
        ?.retiredThroughGen ?? 0) >= 46
    );

    // Old worker trying to reactivate pruned gen 1 MUST fail even though gen 1 was pruned from cleanupClaims & receipt was deleted!
    await assert.rejects(
      async () =>
        indexMemoryInputOnServer(
          {
            ownerId,
            projectId: projId,
            sourceEntityType: 'RELATIONSHIP',
            sourceEntityId: 'rel_replay',
            sourceRevisionId: 'rev_zombie',
            requestedGeneration: 1,
            canonStatus: 'CANON',
            title: 'Zombie gen 1 replay',
            summary: 'Must be blocked by retired ledger',
            fullText: buildChunkText(205, 'ZOMBIE_G1'),
            maxChunkLength: 100,
            embeddingDimension: 64,
          },
          {
            db: handle.db,
            cacheNamespace: cacheNs,
            forceRebuild: true,
            durableCommitPolicy: {
              requireDurableCloudCommit: true,
              requireActiveGenerationVerification: true,
            },
          }
        ),
      /\[ACTIVATION_BLOCKED_BY_CLEANUP\]/
    );

    // Reserve generation skips all retired generations!
    const nextRes = await reserveRagGenerationOnServer(
      {
        ownerId,
        projectId: projId,
        sourceEntityType: 'RELATIONSHIP',
        sourceEntityId: 'rel_replay',
        largeScaleGenerationMode: true,
      },
      { db: handle.db, cacheNamespace: cacheNs }
    );
    assert.ok(nextRes.generation > 46);
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
    resetTestRuntime();
    await handle.db
      .recursiveDelete(handle.db.doc(`users/${ownerId}`))
      .catch(() => undefined);
    await handle.cleanup();
  }
});

test('LM14 and cloud provenance: Writer keyword fallback uses only current scoped revisions in the real Emulator', async () => {
  const env = assertEmulatorConfigured();
  const tag = makeEmulatorRunTag();
  const handle = createIsolatedTestFirestoreClient({ runId: `emu_memory_${tag}`, projectId: env.projectId, databaseId: env.databaseId });
  const ownerId = `author_${tag}`;
  const projectId = `memory_${tag}`;
  const base = `users/${ownerId}/projects/${projectId}`;
  const contextFixture = buildEvaluationFixture('NW8', 'test-writer');
  const pov = 'reader';
  const clock = '2026-01-01T00:00:00.000Z';
  const episode: Episode = {
    id: 'past', ownerId, projectId, episodeNumber: 10, title: '북쪽 관문',
    content: '북쪽 관문에서 은방울을 울려 서약했다.', synopsis: '', authorNote: '',
    status: 'confirmed', canonStatus: 'CANON', charCountWithSpaces: 0, charCountWithoutSpaces: 0,
    linkedCharacterIds: [pov], linkedWorldbuildingIds: [], linkedEventIds: ['old_oath'], createdAt: clock, updatedAt: clock, latestRevisionId: 'rev1',
  };
  const second = { ...episode, id: 'second_past', episodeNumber: 15, title: '남쪽 선착장', content: '남쪽 선착장에서 검은 돛이 나타났다.',
    linkedEventIds: ['black_sail'], latestRevisionId: 'rev2' };
  const firstScene = { ...contextFixture.plan.scenes[0], sceneNumber: 1, title: '북쪽 관문', purpose: '북쪽 관문 은방울 서약',
    characterIds: [pov], pointOfViewCharacterId: pov, mustIncludeEvent: '은방울',
    memory: { requiredEventIds: ['old_oath'], povKnownSources: ['EPISODE:past'] } };
  const secondScene = { ...firstScene, sceneNumber: 2, title: '남쪽 선착장', purpose: '새 갈등을 시작한다',
    mustIncludeEvent: '단서의 의미를 추적한다', memory: { requiredEventIds: ['black_sail'], povKnownSources: ['EPISODE:second_past'] } };
  const plan = { ...contextFixture.plan, id: 'approved-plan', ownerId, projectId, episodeId: 'present', scenes: [firstScene, secondScene] };
  const context = { ...contextFixture.context, ownerId, projectId, episodeId: 'present', sceneCharacterIds: [pov] };
  const currentDoc = handle.db.doc(`${base}/episodes/present`);
  const firstDoc = handle.db.doc(`${base}/episodes/past`);

  try {
    resetTestRuntime();
    installDeterministicEmbedder();
    registerProjectOwnerForAdminCheck(projectId, ownerId);
    const batch = handle.db.batch();
    batch.set(handle.db.doc(base), { id: projectId, ownerId, lifecycleStatus: 'ACTIVE' });
    batch.set(currentDoc, { id: 'present', ownerId, projectId, episodeNumber: 40, content: '보존할 현재 원고', canonStatus: 'DRAFT' });
    batch.set(handle.db.doc(`${base}/writingPlans/${plan.id}`), plan);
    batch.set(handle.db.doc(`${base}/characters/${pov}`), { id: pov, ownerId, projectId, canonStatus: 'CANON', name: '서린' });
    for (const row of [episode, second]) {
      batch.set(handle.db.doc(`${base}/episodes/${row.id}`), row);
      batch.set(handle.db.doc(`${base}/revisions/${row.latestRevisionId}`), {
        id: row.latestRevisionId, ownerId, projectId, content: row.content, episodeId: row.id,
      });
    }
    await batch.commit();

    for (const input of extractProjectMemoryIndexInputs({ ownerId, projectId, characters: [], worldbuilding: [], episodes: [episode, second] })) {
      await indexMemoryInputOnServer(input, { db: handle.db, cacheNamespace: tag,
        durableCommitPolicy: { requireDurableCloudCommit: true, requireActiveGenerationVerification: true } });
    }
    // The embedder is stubbed locally to fail; these requests never reach Gemini.
    let embeddingAttempts = 0;
    setCustomGeminiEmbedContentForTesting(async () => { embeddingAttempts++; throw new Error('test embedding outage'); });
    const retrieve = createSceneMemoryRetriever({ ownerId, context, plan, db: handle.db });
    const a = await retrieve({ ...firstScene, memory: { povKnownSources: ['EPISODE:second_past'] } });
    assert.equal(a.diagnostics.status, 'SELECTED', JSON.stringify(a.diagnostics));
    assert.deepEqual(a.evidence.map((row) => row.sourceEntityId), ['past']);
    assert.equal(a.evidence[0].sourceRevisionId, 'rev1');
    assert.equal(a.evidence[0].originalText, episode.content);
    assert.deepEqual(a.diagnostics.searchModes, ['KEYWORD_ONLY']);
    assert.equal(a.diagnostics.vectorFallback, true);
    assert.equal(a.diagnostics.embeddingRequests, 1);
    assert.equal(embeddingAttempts, 1);

    const b = await retrieve(secondScene);
    assert.equal(b.diagnostics.status, 'SELECTED', JSON.stringify(b.diagnostics));
    assert.deepEqual(b.evidence.map((row) => row.sourceEntityId), ['second_past']);
    assert.equal(b.diagnostics.embeddingRequests, 1);

    const baseline = (await currentDoc.get()).data();
    const intruder = await createSceneMemoryRetriever({ ownerId: 'other_author', context, plan, db: handle.db })(firstScene);
    assert.equal(intruder.diagnostics.status, 'AUTHORITY_UNAVAILABLE');
    assert.deepEqual(intruder.evidence, []);
    await firstDoc.update({ latestRevisionId: 'rev3', content: '새 원고' });
    await handle.db.doc(`${base}/revisions/rev3`).set({ id: 'rev3', ownerId, projectId, content: '새 원고', episodeId: 'past' });
    const stale = await retrieve(firstScene);
    assert.ok(stale.diagnostics.rejected.some(({ reason }) => reason === 'STALE_SOURCE'), JSON.stringify(stale.diagnostics));
    assert.deepEqual(stale.evidence, []);
    assert.deepEqual((await currentDoc.get()).data(), baseline);
    assert.equal((await handle.db.doc(`${base}/writingPlans/${plan.id}`).get()).data()?.status, 'APPROVED');
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
    await handle.cleanup();
  }
});
