import test from 'node:test';
import assert from 'node:assert/strict';
import type { Firestore } from 'firebase-admin/firestore';
import {
  approveChangeProposalOnServer,
  diagnoseAndRecoverProjectRagIntegrityOnServer,
  executeRagSyncForApprovedProposalOnServer,
} from '../server/changeProposalApprovalEngine.ts';
import {
  buildRagStagingReceiptId,
  cleanupInactiveRagGenerationsOnServer,
  clearEmbeddingCacheForTesting,
  clearLocalRagDiskCacheForTesting,
  InMemoryMockFirestoreRagBackend,
  indexMemoryInputOnServer,
  reserveRagGenerationOnServer,
  searchProjectMemoryOnServer,
  setCustomGeminiEmbedContentForTesting,
  setMockFirestoreRagBackendForTesting,
  simulateServerRestartForTesting,
  tryFirestoreVectorFindNearest,
  type FirestoreRagManifestDoc,
} from '../server/ragEngine.ts';
import {
  registerIsolatedMockFirestoreForTest,
  registerProjectOwnerForAdminCheck,
} from '../server/authMiddleware.ts';
import {
  buildGenerationScopedChunkId,
  buildGenerationScopedDocId,
  computeDeterministicSemanticEmbedding,
  LARGE_SCALE_RAG_TX_OP_THRESHOLD,
} from '../services/memorySearchProvider.ts';
import type {
  RagGenerationStagingReceipt,
} from '../types/foundation.ts';

function resetRagTestRuntime(): void {
  clearEmbeddingCacheForTesting();
  clearLocalRagDiskCacheForTesting();
  simulateServerRestartForTesting();
}

function buildExactChunkFullText(
  chunkCount: number,
  tag: string,
  uniquePhrase = ''
): string {
  const blocks: string[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const marker = uniquePhrase ? `${uniquePhrase} ` : '';
    blocks.push(
      `# ${tag}_SCENE_${i + 1}\n${marker}${tag} 장면 ${i + 1}번의 정사 기억 검증 텍스트입니다.`
    );
  }
  return blocks.join('\n\n');
}

function installDeterministicLiveEmbedder(): void {
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

function createFencingMockFirestore(
  initialDocs: Record<string, Record<string, unknown>> = {}
): {
  db: Firestore;
  store: Map<string, Record<string, unknown>>;
  stats: {
    writeBatchCommits: number;
    writeBatchOpCounts: number[];
    txAttempts: number;
  };
} {
  const store = new Map<string, Record<string, unknown>>();
  for (const [k, v] of Object.entries(initialDocs)) {
    store.set(k.replace(/^\/+/, ''), structuredClone(v));
  }

  let txQueue = Promise.resolve();
  const stats = {
    writeBatchCommits: 0,
    writeBatchOpCounts: [] as number[],
    txAttempts: 0,
  };

  const isPlainMapObject = (
    value: unknown
  ): value is Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  };

  const deepMergeFirestoreDoc = (
    existing: Record<string, unknown>,
    incoming: Record<string, unknown>
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = structuredClone(existing);
    for (const [k, v] of Object.entries(incoming)) {
      if (isPlainMapObject(v) && isPlainMapObject(out[k])) {
        out[k] = deepMergeFirestoreDoc(out[k] as Record<string, unknown>, v);
      } else {
        out[k] = structuredClone(v);
      }
    }
    return out;
  };

  const makeDocRef = (rawPath: string) => {
    const cleanPath = rawPath.replace(/^\/+/, '');
    const parts = cleanPath.split('/');
    const id = parts[parts.length - 1] || '';
    return {
      id,
      path: cleanPath,
      async get() {
        const cur = store.get(cleanPath);
        return {
          id,
          exists: Boolean(cur),
          data: () => (cur ? structuredClone(cur) : undefined),
        };
      },
      async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
        const existing = store.get(cleanPath) || {};
        store.set(
          cleanPath,
          opts?.merge
            ? deepMergeFirestoreDoc(existing, data)
            : structuredClone(data)
        );
      },
      async update(data: Record<string, unknown>) {
        const existing = store.get(cleanPath);
        if (!existing) {
          throw new Error(`NOT_FOUND: No document to update: ${cleanPath}`);
        }
        store.set(cleanPath, {
          ...structuredClone(existing),
          ...structuredClone(data),
        });
      },
      async delete() {
        store.delete(cleanPath);
      },
    };
  };

  const makeCollectionRef = (rawColPath: string) => {
    const cleanCol = rawColPath.replace(/^\/+/, '');
    const buildQuery = (
      filters: Array<{ field: string; op: string; val: unknown }>,
      selectedFields?: string[]
    ) => ({
      where(field: string, op: string, val: unknown) {
        return buildQuery(
          [...filters, { field, op, val }],
          selectedFields
        );
      },
      select(...fields: string[]) {
        return buildQuery(filters, fields);
      },
      orderBy() {
        return this;
      },
      limit() {
        return this;
      },
      findNearest(vectorOpts: { limit?: number }) {
        return {
          async get() {
            const prefix = `${cleanCol}/`;
            const docs: Array<{
              id: string;
              ref: ReturnType<typeof makeDocRef>;
              exists: boolean;
              data: () => Record<string, unknown>;
            }> = [];
            for (const [k, v] of store.entries()) {
              if (!k.startsWith(prefix)) continue;
              const rest = k.slice(prefix.length);
              if (rest.includes('/')) continue;
              let matched = true;
              for (const f of filters) {
                if (f.op === '==' && v[f.field] !== f.val) {
                  matched = false;
                  break;
                }
              }
              if (!matched) continue;
              const cloned = { ...structuredClone(v), vectorDistance: 0.05 };
              docs.push({
                id: rest,
                ref: makeDocRef(k),
                exists: true,
                data: () => structuredClone(cloned),
              });
            }
            return {
              empty: docs.length === 0,
              size: docs.length,
              docs: docs.slice(0, vectorOpts.limit || 20),
            };
          },
        };
      },
      async get() {
        const prefix = `${cleanCol}/`;
        const docs: Array<{
          id: string;
          ref: ReturnType<typeof makeDocRef>;
          exists: boolean;
          data: () => Record<string, unknown>;
        }> = [];
        for (const [k, v] of store.entries()) {
          if (!k.startsWith(prefix)) continue;
          const rest = k.slice(prefix.length);
          if (rest.includes('/')) continue;
          let matched = true;
          for (const f of filters) {
            if (f.op === '==' && v[f.field] !== f.val) {
              matched = false;
              break;
            }
          }
          if (!matched) continue;
          const payload = selectedFields
            ? Object.fromEntries(
                selectedFields.map((f) => [f, structuredClone(v[f])])
              )
            : structuredClone(v);
          docs.push({
            id: rest,
            ref: makeDocRef(k),
            exists: true,
            data: () => structuredClone(payload),
          });
        }
        return {
          empty: docs.length === 0,
          size: docs.length,
          docs,
        };
      },
    });

    return {
      path: cleanCol,
      doc(docId: string) {
        return makeDocRef(`${cleanCol}/${docId}`);
      },
      ...buildQuery([]),
    };
  };

  const dbMock = {
    doc(rawPath: string) {
      return makeDocRef(rawPath);
    },
    collection(rawColPath: string) {
      return makeCollectionRef(rawColPath);
    },
    async getAll(...refs: Array<{ path: string; id: string }>) {
      return Promise.all(
        refs.map(async (r) => {
          const cur = store.get(r.path);
          return {
            id: r.id,
            exists: Boolean(cur),
            data: () => (cur ? structuredClone(cur) : undefined),
          };
        })
      );
    },
    batch() {
      const stagedOps: Array<() => void> = [];
      return {
        set(
          ref: { path: string },
          data: Record<string, unknown>,
          opts?: { merge?: boolean }
        ) {
          stagedOps.push(() => {
            const existing = store.get(ref.path) || {};
            store.set(
              ref.path,
              opts?.merge
                ? deepMergeFirestoreDoc(existing, data)
                : structuredClone(data)
            );
          });
        },
        update(ref: { path: string }, data: Record<string, unknown>) {
          stagedOps.push(() => {
            const existing = store.get(ref.path);
            if (!existing) {
              throw new Error(`NOT_FOUND: No document to update: ${ref.path}`);
            }
            store.set(ref.path, {
              ...structuredClone(existing),
              ...structuredClone(data),
            });
          });
        },
        delete(ref: { path: string }) {
          stagedOps.push(() => {
            store.delete(ref.path);
          });
        },
        async commit() {
          stats.writeBatchOpCounts.push(stagedOps.length);
          if (stagedOps.length > 500) {
            throw new Error(
              `Firestore batch op limit exceeded: ${stagedOps.length} > 500`
            );
          }
          stats.writeBatchCommits += 1;
          for (const op of stagedOps) {
            op();
          }
        },
      };
    },
    async runTransaction<T>(
      updateFunction: (tx: unknown) => Promise<T>
    ): Promise<T> {
      const executeAttempt = async (): Promise<T> => {
        stats.txAttempts += 1;
        const workingStore = new Map<string, Record<string, unknown>>();
        for (const [k, v] of store.entries()) {
          workingStore.set(k, structuredClone(v));
        }

        let writeStarted = false;
        const stagedWrites: Array<() => void> = [];

        const txObj = {
          async get(ref: { path: string; id: string }) {
            if (writeStarted) {
              throw new Error(
                'Firestore transactions require all reads before any writes!'
              );
            }
            const doc = workingStore.get(ref.path);
            return {
              id: ref.id,
              exists: Boolean(doc),
              data: () => (doc ? structuredClone(doc) : undefined),
            };
          },
          set(
            ref: { path: string },
            data: Record<string, unknown>,
            opts?: { merge?: boolean }
          ) {
            writeStarted = true;
            stagedWrites.push(() => {
              const existing = workingStore.get(ref.path) || {};
              workingStore.set(
                ref.path,
                opts?.merge
                  ? deepMergeFirestoreDoc(existing, data)
                  : structuredClone(data)
              );
            });
            return txObj;
          },
          update(ref: { path: string }, data: Record<string, unknown>) {
            writeStarted = true;
            stagedWrites.push(() => {
              const existing = workingStore.get(ref.path);
              if (!existing) {
                throw new Error(`NOT_FOUND: No document to update: ${ref.path}`);
              }
              workingStore.set(ref.path, {
                ...structuredClone(existing),
                ...structuredClone(data),
              });
            });
            return txObj;
          },
          create(ref: { path: string }, data: Record<string, unknown>) {
            writeStarted = true;
            stagedWrites.push(() => {
              if (workingStore.has(ref.path)) {
                throw new Error(`ALREADY_EXISTS: ${ref.path}`);
              }
              workingStore.set(ref.path, structuredClone(data));
            });
            return txObj;
          },
          delete(ref: { path: string }) {
            writeStarted = true;
            stagedWrites.push(() => {
              workingStore.delete(ref.path);
            });
            return txObj;
          },
        };

        const result = await updateFunction(txObj);
        for (const op of stagedWrites) {
          op();
        }
        store.clear();
        for (const [k, v] of workingStore.entries()) {
          store.set(k, structuredClone(v));
        }
        return result;
      };

      const next = txQueue.then(executeAttempt, executeAttempt);
      txQueue = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    },
  };

  const typedDb = dbMock as unknown as Firestore;
  registerIsolatedMockFirestoreForTest(typedDb, {
    projectId: 'test-stage25cd-fencing',
    databaseId: 'test-db-stage25cd',
    runId: `run_s25cd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
  });

  return { db: typedDb, store, stats };
}

test('Stage 2.5C-D Test A: Cleaner scans STAGED gen -> Worker activates Stage B before Cleaner Claim TX -> Cleaner TX blocks with CLEANUP_BLOCKED_ACTIVE_GENERATION', async () => {
  resetRagTestRuntime();
  installDeterministicLiveEmbedder();

  const ownerId = 'author_test_a';
  const projectId = 'proj_test_a';
  const basePath = `users/${ownerId}/projects/${projectId}`;
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  const { db, store } = createFencingMockFirestore({
    [basePath]: { id: projectId, ownerId, lifecycleStatus: 'ACTIVE' },
  });

  try {
    let cleanupPromise: Promise<unknown> | null = null;
    let cleanerSawActiveBlock = false;

    const indexResult = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_race_a',
        sourceRevisionId: 'rev_a1',
        canonStatus: 'CANON',
        title: '레이스 테스트 A 대량 원고',
        summary: 'Stage A -> Cleaner -> Stage B race',
        fullText: buildExactChunkFullText(
          210,
          'RACE_A',
          'TEST_A_CRYSTAL_CHRONICLE'
        ),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'ns_test_a',
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
        onBetweenStageAAndBHook: async ({ generation, stagingId }) => {
          // Cleaner runs candidate scan right after Stage A VERIFIED,
          // then pauses inside onAfterCandidateScanBeforeClaimTx so Worker finishes Stage B first!
          cleanupPromise = (async () => {
            try {
              await cleanupInactiveRagGenerationsOnServer(
                {
                  ownerId,
                  projectId,
                  targetGeneration: generation,
                  targetStagingId: stagingId,
                  failOnActiveConflict: true,
                  staleStagingThresholdMs: 0,
                  onAfterCandidateScanBeforeClaimTx: async () => {
                    // Let synchronous caller proceed into Stage B TX before Cleaner Claim TX runs
                    await new Promise((r) => setTimeout(r, 35));
                  },
                },
                { db, cacheNamespace: 'ns_test_a' }
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (msg.includes('[CLEANUP_BLOCKED_ACTIVE_GENERATION]')) {
                cleanerSawActiveBlock = true;
                return;
              }
              throw err;
            }
          })();

          // Give Cleaner time to complete Candidate Scan before returning so Worker executes Stage B TX first
          await new Promise((r) => setTimeout(r, 10));
        },
      }
    );

    assert.ok(cleanupPromise);
    await cleanupPromise;

    assert.equal(indexResult.activeGenerationVerified, true);
    assert.equal(indexResult.document.indexGeneration, 1);
    assert.equal(
      cleanerSawActiveBlock,
      true,
      'Cleaner Claim TX must fail with [CLEANUP_BLOCKED_ACTIVE_GENERATION] once Worker commits Stage B'
    );

    // Newly activated gen 1 docs/chunks MUST remain 100% intact and searchable
    assert.ok(
      store.has(`${basePath}/memoryDocuments/${indexResult.document.id}`)
    );
    const searchRes = await searchProjectMemoryOnServer({
      ownerId,
      query: {
        projectId,
        queryText: 'TEST_A_CRYSTAL_CHRONICLE',
        topK: 5,
      },
      db,
      cacheNamespace: 'ns_test_a',
    });
    assert.ok(searchRes.hits.length > 0);

    // Also verify default non-throwing bulk sweep skips the newly activated generation in Claim TX
    const bulkSweep = await cleanupInactiveRagGenerationsOnServer(
      {
        ownerId,
        projectId,
        staleStagingThresholdMs: 0,
      },
      { db, cacheNamespace: 'ns_test_a' }
    );
    assert.equal(bulkSweep.deletedDocs, 0);
    assert.equal(bulkSweep.deletedChunks, 0);
    assert.ok(bulkSweep.skippedActiveCount >= 1);
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
    resetRagTestRuntime();
  }
});

test('Stage 2.5C-D Test B: Cleaner claims CLEANUP_PENDING before Worker Stage B TX -> Worker blocks with ACTIVATION_BLOCKED_BY_CLEANUP and preserves gen 1', async () => {
  resetRagTestRuntime();
  installDeterministicLiveEmbedder();

  const ownerId = 'author_test_b';
  const projectId = 'proj_test_b';
  const basePath = `users/${ownerId}/projects/${projectId}`;
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  const { db, store } = createFencingMockFirestore({
    [basePath]: { id: projectId, ownerId, lifecycleStatus: 'ACTIVE' },
  });

  try {
    // 1. First establish healthy active gen 1
    const gen1 = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_race_b',
        sourceRevisionId: 'rev_b1',
        canonStatus: 'CANON',
        title: '정상 활성 gen1',
        summary: 'Active gen 1',
        fullText: buildExactChunkFullText(
          210,
          'GEN1_B',
          'ACTIVE_GEN1_GOLDEN_CITADEL'
        ),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'ns_test_b',
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    assert.equal(gen1.document.indexGeneration, 1);

    let capturedGen2StagingId = '';
    let capturedBetweenHookCleanerOp = '';

    // 2. Worker stages gen 2, then Cleaner claims CLEANUP_PENDING BEFORE Worker Stage B TX
    await assert.rejects(
      async () => {
        await indexMemoryInputOnServer(
          {
            ownerId,
            projectId,
            sourceEntityType: 'EPISODE',
            sourceEntityId: 'ep_race_b',
            sourceRevisionId: 'rev_b2',
            canonStatus: 'CANON',
            title: '경합 gen2 (정리 선점됨)',
            summary: 'Contested gen 2',
            fullText: buildExactChunkFullText(
              210,
              'GEN2_B',
              'CONTESTED_GEN2_VOID_TOWER'
            ),
            maxChunkLength: 100,
            embeddingDimension: 64,
          },
          {
            db,
            cacheNamespace: 'ns_test_b',
            forceRebuild: true,
            durableCommitPolicy: {
              requireDurableCloudCommit: true,
              requireActiveGenerationVerification: true,
            },
            onBetweenStageAAndBHook: async ({ generation, stagingId }) => {
              capturedGen2StagingId = stagingId || '';
              assert.equal(generation, 2);

              // Cleaner runs Claim TX first and verifies BEFORE physical delete
              const cleanerRes = await cleanupInactiveRagGenerationsOnServer(
                {
                  ownerId,
                  projectId,
                  targetGeneration: generation,
                  targetStagingId: stagingId,
                  staleStagingThresholdMs: 0,
                  retainCompletedReceipts: true,
                  onBetweenClaimAndDeleteHook: async ({
                    cleanupOperationId,
                    claimKeys,
                  }) => {
                    capturedBetweenHookCleanerOp = cleanupOperationId;
                    assert.equal(claimKeys.length, 1);
                    const receiptBeforeDelete = store.get(
                      `${basePath}/ragGenerationStaging/${stagingId}`
                    ) as unknown as RagGenerationStagingReceipt;
                    assert.equal(receiptBeforeDelete.status, 'CLEANUP_PENDING');
                    const manifestBeforeDelete = store.get(
                      `${basePath}/ragManifest/control`
                    ) as {
                      cleanupClaims?: Record<string, { status: string }>;
                    };
                    assert.equal(
                      manifestBeforeDelete.cleanupClaims?.[claimKeys[0]]?.status,
                      'CLEANUP_PENDING'
                    );
                  },
                },
                { db, cacheNamespace: 'ns_test_b' }
              );

              assert.ok(cleanerRes.deletedDocs >= 1);
              assert.ok(cleanerRes.deletedChunks >= 210);
              assert.equal(cleanerRes.completedClaimKeys?.length, 1);
            },
          }
        );
      },
      /\[ACTIVATION_BLOCKED_BY_CLEANUP\]/
    );

    assert.ok(capturedBetweenHookCleanerOp.startsWith('cleanup_'));
    const finalizedReceipt = store.get(
      `${basePath}/ragGenerationStaging/${capturedGen2StagingId}`
    ) as unknown as RagGenerationStagingReceipt;
    assert.equal(
      finalizedReceipt.status,
      'CLEANUP_COMPLETED',
      'Worker catch handler must NOT overwrite CLEANUP_PENDING/CLEANUP_COMPLETED back to ABORTED'
    );

    // Gen 1 remains healthy active generation in Manifest & Search
    const manifestAfter = store.get(`${basePath}/ragManifest/control`) as {
      entityStates: Record<string, { activeGeneration: number }>;
    };
    const eState =
      manifestAfter.entityStates[
        `${ownerId}:${projectId}:EPISODE:ep_race_b`
      ];
    assert.equal(eState.activeGeneration, 1);

    const searchRes = await searchProjectMemoryOnServer({
      ownerId,
      query: {
        projectId,
        queryText: 'ACTIVE_GEN1_GOLDEN_CITADEL',
        topK: 5,
      },
      db,
      cacheNamespace: 'ns_test_b',
    });
    assert.ok(searchRes.hits.length > 0);
    assert.ok(
      searchRes.hits.every((h) => h.document.indexGeneration === 1)
    );

    // Next reservation MUST skip claimed gen 2 and reserve >= 3
    const nextRes = await reserveRagGenerationOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_race_b',
        largeScaleGenerationMode: true,
      },
      { db, cacheNamespace: 'ns_test_b' }
    );
    assert.ok(nextRes.generation >= 3);
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
    resetRagTestRuntime();
  }
});

test('Stage 2.5C-D Test C: Small-scale (<=200 ops) __staged writes are protected during concurrent cleanup & diagnostics, while old unleased __staged IS cleaned', async () => {
  resetRagTestRuntime();
  installDeterministicLiveEmbedder();

  const ownerId = 'author_test_c';
  const projectId = 'proj_test_c';
  const basePath = `users/${ownerId}/projects/${projectId}`;
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  const { db, store } = createFencingMockFirestore({
    [basePath]: { id: projectId, ownerId, lifecycleStatus: 'ACTIVE' },
  });

  try {
    // 1. Small INLINE_DOC active gen 1
    const smallG1 = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_small_c',
        sourceRevisionId: 'rev_c1',
        canonStatus: 'CANON',
        title: '소규모 v1',
        summary: '소규모 활성 v1',
        fullText: buildExactChunkFullText(4, 'SMALL_V1', 'SMALL_CANON_V1'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'ns_test_c',
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    assert.equal(smallG1.document.activationMode, 'INLINE_DOC');
    assert.equal(smallG1.document.indexGeneration, 1);

    let hookExecuted = false;
    // 2. Concurrent re-index v2 writes __staged copies while v1 is active
    const smallG2 = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_small_c',
        sourceRevisionId: 'rev_c2',
        canonStatus: 'CANON',
        title: '소규모 v2',
        summary: '소규모 업데이트 v2',
        fullText: buildExactChunkFullText(5, 'SMALL_V2', 'SMALL_CANON_V2'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'ns_test_c',
        forceRebuild: true,
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
        onDuringStagingHook: async () => {
          hookExecuted = true;
          const stagedDocPath = `${basePath}/memoryDocuments/${smallG1.document.id}__staged`;
          assert.ok(
            store.has(stagedDocPath),
            'Small-scale hybrid mode must write __staged doc before Stage B TX'
          );

          // Concurrent default cleaner MUST NOT delete fresh __staged doc even though activeGen > 0!
          const concurrentClean = await cleanupInactiveRagGenerationsOnServer(
            {
              ownerId,
              projectId,
            },
            { db, cacheNamespace: 'ns_test_c' }
          );
          assert.equal(concurrentClean.deletedDocs, 0);
          assert.equal(concurrentClean.deletedChunks, 0);
          assert.ok(concurrentClean.skippedInFlightStagingCount >= 1);
          assert.ok(
            store.has(stagedDocPath),
            'Fresh small-scale __staged doc MUST NOT be deleted by __staged heuristic!'
          );

          // Diagnostics MUST NOT falsely report STATE_F_INACTIVE_STAGED_DOCUMENTS_REMAINING
          const diag = await diagnoseAndRecoverProjectRagIntegrityOnServer(
            { projectId, autoRecover: false },
            { db, verifiedOwnerId: ownerId }
          );
          assert.equal(
            diag.anomalies.some(
              (a) => a.code === 'STATE_F_INACTIVE_STAGED_DOCUMENTS_REMAINING'
            ),
            false,
            'Diagnostics must NOT flag active small-scale __staged doc as orphan'
          );
        },
      }
    );

    assert.equal(hookExecuted, true);
    assert.equal(smallG2.document.indexGeneration, 2);
    assert.equal(
      store.has(`${basePath}/memoryDocuments/${smallG1.document.id}__staged`),
      false,
      'Stage B TX must remove __staged doc cleanly upon activation'
    );

    // 3. Genuinely old, unleased __staged orphan (>15 min) IS cleaned up!
    const oldIso = new Date(Date.now() - 30 * 60_000).toISOString();
    store.set(`${basePath}/memoryDocuments/${smallG1.document.id}__staged`, {
      ...smallG2.document,
      indexGeneration: 3,
      isActiveGeneration: false,
      lifecycleStatus: 'REINDEXING_KEEP_OLD',
      updatedAt: oldIso,
      createdAt: oldIso,
    });
    const staleClean = await cleanupInactiveRagGenerationsOnServer(
      { ownerId, projectId },
      { db, cacheNamespace: 'ns_test_c' }
    );
    assert.equal(staleClean.deletedDocs, 1);
    assert.equal(
      store.has(`${basePath}/memoryDocuments/${smallG1.document.id}__staged`),
      false
    );
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
    resetRagTestRuntime();
  }
});

test('Stage 2.5C-D Test D: CLOUD_AUTHENTICATED mode enforces authoritative Date.now() and 5-min floor, blocking spoofed future nowMs', async () => {
  resetRagTestRuntime();
  installDeterministicLiveEmbedder();

  const ownerId = 'author_test_d';
  const projectId = 'proj_test_d';
  const basePath = `users/${ownerId}/projects/${projectId}`;
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  const recentIso = new Date(Date.now() - 10_000).toISOString();
  const futureExpireMs = Date.now() + 120_000;
  const stagingId = buildRagStagingReceiptId({
    projectId,
    sourceEntityType: 'RELATIONSHIP',
    sourceEntityId: 'rel_live_d',
    generation: 2,
  });

  const { db, store } = createFencingMockFirestore({
    [basePath]: { id: projectId, ownerId, lifecycleStatus: 'ACTIVE' },
    [`${basePath}/ragGenerationStaging/${stagingId}`]: {
      id: stagingId,
      ownerId,
      projectId,
      entityKey: `${ownerId}:${projectId}:RELATIONSHIP:rel_live_d`,
      sourceEntityType: 'RELATIONSHIP',
      sourceEntityId: 'rel_live_d',
      generation: 2,
      activationMode: 'MANIFEST_POINTER',
      status: 'STAGED',
      expectedDocumentIds: ['doc_live_d'],
      expectedDocumentCount: 1,
      expectedChunkCount: 1,
      expectedContentHash: 'h_d',
      expectedSourceRevisionId: 'rev_d',
      stagedDocumentCount: 1,
      stagedChunkCount: 1,
      verifiedDocumentCount: 0,
      verifiedChunkCount: 0,
      batchesCommitted: 1,
      targetTaskId: 'task_live_d',
      targetLeaseGeneration: 1,
      createdAt: recentIso,
      updatedAt: recentIso,
    },
    [`${basePath}/ragSyncTasks/task_live_d`]: {
      id: 'task_live_d',
      ownerId,
      projectId,
      targetEntityType: 'RELATIONSHIP',
      targetEntityId: 'rel_live_d',
      status: 'PROCESSING',
      leaseOwner: 'worker_live',
      leaseGeneration: 1,
      leaseExpiresAtMs: futureExpireMs,
      createdAt: recentIso,
      updatedAt: recentIso,
    },
  });

  try {
    const spoofedRes = await cleanupInactiveRagGenerationsOnServer(
      {
        ownerId,
        projectId,
        nowMs: Date.now() + 365 * 86400_000, // adversarial +1 year spoof
        staleStagingThresholdMs: 0, // adversarial 0ms threshold
        executionMode: 'CLOUD_AUTHENTICATED',
      },
      { db, cacheNamespace: 'ns_test_d' }
    );

    assert.equal(spoofedRes.deletedDocs, 0);
    assert.equal(spoofedRes.deletedStagingReceipts, 0);
    assert.ok(spoofedRes.skippedInFlightStagingCount >= 1);
    assert.ok(store.has(`${basePath}/ragGenerationStaging/${stagingId}`));
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
    resetRagTestRuntime();
  }
});

test('Stage 2.5C-D Test E: Crash mid-cleanup leaves CLEANUP_PENDING claim & resumes idempotently to CLEANUP_COMPLETED (Injected DB & MockBackend)', async () => {
  resetRagTestRuntime();
  installDeterministicLiveEmbedder();

  const ownerId = 'author_test_e';
  const projectId = 'proj_test_e';
  const basePath = `users/${ownerId}/projects/${projectId}`;
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  const { db, store } = createFencingMockFirestore({
    [basePath]: { id: projectId, ownerId, lifecycleStatus: 'ACTIVE' },
  });

  try {
    // Stage gen 1 with >450 ops (e.g. 520 chunks -> spans 2 cleanup batches of <= 450!)
    const g1 = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_crash_e',
        sourceRevisionId: 'rev_e1',
        canonStatus: 'CANON',
        title: '대규모 g1',
        summary: '520 chunks',
        fullText: buildExactChunkFullText(520, 'E_G1', 'OLD_E_G1_RELIC'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'ns_test_e',
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );

    // Activate gen 2 (healthy latest generation that MUST NOT be deleted)
    const g2 = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_crash_e',
        sourceRevisionId: 'rev_e2',
        canonStatus: 'CANON',
        title: '대규모 g2 활성',
        summary: 'Active g2',
        fullText: buildExactChunkFullText(210, 'E_G2', 'ACTIVE_E_G2_SANCTUM'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'ns_test_e',
        forceRebuild: true,
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );

    const g1StagingId = buildRagStagingReceiptId({
      projectId,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_crash_e',
      generation: g1.document.indexGeneration!,
    });
    const claimKey = `${ownerId}:${projectId}:EPISODE:ep_crash_e::g${g1.document.indexGeneration}`;

    // Simulate crash at batch #2 during cleanup
    await assert.rejects(
      async () => {
        await cleanupInactiveRagGenerationsOnServer(
          {
            ownerId,
            projectId,
            simulateDeleteFailureAtBatchNumber: 2,
          },
          { db, cacheNamespace: 'ns_test_e' }
        );
      },
      /\[CLEANUP_BATCH_DELETE_FAILED\]/
    );

    // After partial crash: claim MUST be CLEANUP_PENDING, receipt MUST NOT be deleted or finalized
    const manifestMidCrash = store.get(`${basePath}/ragManifest/control`) as {
      cleanupClaims?: Record<string, { status: string }>;
    };
    assert.equal(
      manifestMidCrash.cleanupClaims?.[claimKey]?.status,
      'CLEANUP_PENDING'
    );
    const receiptMidCrash = store.get(
      `${basePath}/ragGenerationStaging/${g1StagingId}`
    ) as unknown as RagGenerationStagingReceipt;
    assert.equal(receiptMidCrash.status, 'CLEANUP_PENDING');

    // Resume cleanup without failure -> completes remaining ops and finalizes CLEANUP_COMPLETED!
    const resumeRes = await cleanupInactiveRagGenerationsOnServer(
      {
        ownerId,
        projectId,
        retainCompletedReceipts: true,
      },
      { db, cacheNamespace: 'ns_test_e' }
    );
    assert.ok(resumeRes.deletedChunks > 0 || resumeRes.deletedDocs > 0);
    assert.ok(resumeRes.completedClaimKeys?.includes(claimKey));

    const manifestAfterResume = store.get(
      `${basePath}/ragManifest/control`
    ) as {
      cleanupClaims?: Record<string, { status: string }>;
    };
    assert.equal(
      manifestAfterResume.cleanupClaims?.[claimKey]?.status,
      'CLEANUP_COMPLETED'
    );
    const receiptAfterResume = store.get(
      `${basePath}/ragGenerationStaging/${g1StagingId}`
    ) as unknown as RagGenerationStagingReceipt;
    assert.equal(receiptAfterResume.status, 'CLEANUP_COMPLETED');

    // Gen 2 active doc & chunks MUST remain untouched and searchable!
    assert.ok(store.has(`${basePath}/memoryDocuments/${g2.document.id}`));

    // MockBackend Parity check for cleanup claim + crash resume
    resetRagTestRuntime();
    const mockBackend = new InMemoryMockFirestoreRagBackend();
    const mockProject = 'proj_mock_e';
    const mockBase = `users/${ownerId}/projects/${mockProject}`;
    registerProjectOwnerForAdminCheck(mockProject, ownerId);
    mockBackend.documentsByPath.set(mockBase, { id: mockProject, ownerId });
    setMockFirestoreRagBackendForTesting(mockBackend);

    await indexMemoryInputOnServer(
      {
        ownerId,
        projectId: mockProject,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_mock_e',
        sourceRevisionId: 'rev_m1',
        canonStatus: 'CANON',
        title: 'Mock g1',
        summary: 'Mock 500 chunks',
        fullText: buildExactChunkFullText(500, 'MG1', 'MOCK_OLD'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        cacheNamespace: 'ns_mock_e',
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    const mg2 = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId: mockProject,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_mock_e',
        sourceRevisionId: 'rev_m2',
        canonStatus: 'CANON',
        title: 'Mock g2',
        summary: 'Mock active',
        fullText: buildExactChunkFullText(210, 'MG2', 'MOCK_ACTIVE'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        cacheNamespace: 'ns_mock_e',
        forceRebuild: true,
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );

    mockBackend.simulateDeleteBatchFailureAtBatchNumber = 2;
    await assert.rejects(
      async () => cleanupInactiveRagGenerationsOnServer({ ownerId, projectId: mockProject }),
      /\[CLEANUP_BATCH_DELETE_FAILED\]/
    );
    mockBackend.simulateDeleteBatchFailureAtBatchNumber = null;

    const mockManifestMid = mockBackend.getManifest(ownerId, mockProject)!;
    assert.equal(
      mockManifestMid.cleanupClaims?.[
        `${ownerId}:${mockProject}:EPISODE:ep_mock_e::g1`
      ]?.status,
      'CLEANUP_PENDING'
    );

    const mockResume = await cleanupInactiveRagGenerationsOnServer({
      ownerId,
      projectId: mockProject,
    });
    assert.ok(
      mockResume.completedClaimKeys?.includes(
        `${ownerId}:${mockProject}:EPISODE:ep_mock_e::g1`
      )
    );
    assert.ok(
      mockBackend.documentsByPath.has(
        `${mockBase}/memoryDocuments/${mg2.document.id}`
      )
    );
  } finally {
    setMockFirestoreRagBackendForTesting(null);
    setCustomGeminiEmbedContentForTesting(null);
    resetRagTestRuntime();
  }
});

test('Stage 2.5C-D Test F: Stage A completeness check rejects scalar corruption (offset/contentHash/dim/modelId) even when chunk count and indexGeneration match', async () => {
  resetRagTestRuntime();
  installDeterministicLiveEmbedder();

  const ownerId = 'author_test_f';
  const projectId = 'proj_test_f';
  const basePath = `users/${ownerId}/projects/${projectId}`;
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  const { db, store } = createFencingMockFirestore({
    [basePath]: { id: projectId, ownerId, lifecycleStatus: 'ACTIVE' },
  });

  try {
    // Healthy g1
    const g1 = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_corrupt_f',
        sourceRevisionId: 'rev_f1',
        canonStatus: 'CANON',
        title: '정상 v1',
        summary: 'Healthy v1',
        fullText: buildExactChunkFullText(210, 'F1', 'F1_HEALTHY_BASTION'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'ns_test_f',
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );

    // During g2 Stage A, corrupt 1 chunk's scalar field (contentHash & sourceStartOffset) without altering count or indexGeneration!
    await assert.rejects(
      async () => {
        await indexMemoryInputOnServer(
          {
            ownerId,
            projectId,
            sourceEntityType: 'EPISODE',
            sourceEntityId: 'ep_corrupt_f',
            sourceRevisionId: 'rev_f2',
            canonStatus: 'CANON',
            title: '청크 손상 v2',
            summary: 'Corrupted scalar v2',
            fullText: buildExactChunkFullText(
              210,
              'F2',
              'F2_CORRUPTED_PHANTOM'
            ),
            maxChunkLength: 100,
            embeddingDimension: 64,
          },
          {
            db,
            cacheNamespace: 'ns_test_f',
            forceRebuild: true,
            durableCommitPolicy: {
              requireDurableCloudCommit: true,
              requireActiveGenerationVerification: true,
            },
            onDuringStagingHook: async ({ generation }) => {
              let mutatedChunk = false;
              const targetDocPrefix = `memdoc_${projectId}_EPISODE_ep_corrupt_f__g${generation}`;
              for (const [k, v] of store.entries()) {
                if (
                  k.startsWith(`${basePath}/memoryChunks/`) &&
                  v.indexGeneration === generation &&
                  typeof v.documentId === 'string' &&
                  v.documentId.startsWith(targetDocPrefix)
                ) {
                  store.set(k, {
                    ...v,
                    contentHash: '0xCORRUPTED_HASH',
                    sourceStartOffset: -99,
                  });
                  mutatedChunk = true;
                  break;
                }
              }
              assert.equal(
                mutatedChunk,
                true,
                'Test F setup must tamper with at least one staged chunk'
              );
            },
          }
        );
      },
      /\[STAGING_VERIFICATION_INCOMPLETE\]/
    );

    const g2StagingId = buildRagStagingReceiptId({
      projectId,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_corrupt_f',
      generation: 2,
    });
    const receipt = store.get(
      `${basePath}/ragGenerationStaging/${g2StagingId}`
    ) as unknown as RagGenerationStagingReceipt;
    assert.equal(receipt.status, 'ABORTED');

    // g1 MUST stay active
    const m = store.get(`${basePath}/ragManifest/control`) as {
      entityStates: Record<string, { activeGeneration: number }>;
    };
    assert.equal(
      m.entityStates[`${ownerId}:${projectId}:EPISODE:ep_corrupt_f`]
        .activeGeneration,
      g1.document.indexGeneration
    );
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
    resetRagTestRuntime();
  }
});

test('Stage 2.5C-D Test G: Worker A lease expiry -> Worker B re-acquisition -> Cleaner cleans superseded Worker A staging while protecting live Worker B', async () => {
  resetRagTestRuntime();
  installDeterministicLiveEmbedder();

  const ownerId = 'author_test_g';
  const projectId = 'proj_test_g';
  const basePath = `users/${ownerId}/projects/${projectId}`;
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  const nowMs = Date.now();
  const recentIso = new Date(nowMs - 5_000).toISOString();
  const workerAStagingId = buildRagStagingReceiptId({
    projectId,
    sourceEntityType: 'RELATIONSHIP',
    sourceEntityId: 'rel_lease_g',
    generation: 2,
  });
  const workerBStagingId = buildRagStagingReceiptId({
    projectId,
    sourceEntityType: 'RELATIONSHIP',
    sourceEntityId: 'rel_lease_g',
    generation: 3,
  });

  const { db, store } = createFencingMockFirestore({
    [basePath]: { id: projectId, ownerId, lifecycleStatus: 'ACTIVE' },
    [`${basePath}/ragSyncTasks/task_g`]: {
      id: 'task_g',
      ownerId,
      projectId,
      targetEntityType: 'RELATIONSHIP',
      targetEntityId: 'rel_lease_g',
      status: 'PROCESSING',
      leaseOwner: 'worker_B',
      leaseGeneration: 2,
      leaseExpiresAtMs: nowMs + 120_000,
      createdAt: recentIso,
      updatedAt: recentIso,
    },
    [`${basePath}/ragGenerationStaging/${workerAStagingId}`]: {
      id: workerAStagingId,
      ownerId,
      projectId,
      entityKey: `${ownerId}:${projectId}:RELATIONSHIP:rel_lease_g`,
      sourceEntityType: 'RELATIONSHIP',
      sourceEntityId: 'rel_lease_g',
      generation: 2,
      activationMode: 'MANIFEST_POINTER',
      status: 'STAGED',
      expectedDocumentIds: ['doc_worker_a_g2'],
      expectedDocumentCount: 1,
      expectedChunkCount: 1,
      expectedContentHash: 'h_a',
      expectedSourceRevisionId: 'rev_1',
      stagedDocumentCount: 1,
      stagedChunkCount: 1,
      verifiedDocumentCount: 0,
      verifiedChunkCount: 0,
      batchesCommitted: 1,
      targetTaskId: 'task_g',
      targetLeaseGeneration: 1, // superseded by Worker B leaseGeneration 2
      createdAt: recentIso,
      updatedAt: recentIso,
    },
    [`${basePath}/memoryDocuments/doc_worker_a_g2`]: {
      id: 'doc_worker_a_g2',
      documentId: 'doc_worker_a_g2',
      ownerId,
      projectId,
      sourceEntityType: 'RELATIONSHIP',
      sourceEntityId: 'rel_lease_g',
      indexGeneration: 2,
      isActiveGeneration: false,
      stagingId: workerAStagingId,
      createdAt: recentIso,
      updatedAt: recentIso,
    },
    [`${basePath}/ragGenerationStaging/${workerBStagingId}`]: {
      id: workerBStagingId,
      ownerId,
      projectId,
      entityKey: `${ownerId}:${projectId}:RELATIONSHIP:rel_lease_g`,
      sourceEntityType: 'RELATIONSHIP',
      sourceEntityId: 'rel_lease_g',
      generation: 3,
      activationMode: 'MANIFEST_POINTER',
      status: 'STAGED',
      expectedDocumentIds: ['doc_worker_b_g3'],
      expectedDocumentCount: 1,
      expectedChunkCount: 1,
      expectedContentHash: 'h_b',
      expectedSourceRevisionId: 'rev_2',
      stagedDocumentCount: 1,
      stagedChunkCount: 1,
      verifiedDocumentCount: 0,
      verifiedChunkCount: 0,
      batchesCommitted: 1,
      targetTaskId: 'task_g',
      targetLeaseGeneration: 2, // matches live Worker B lease
      createdAt: recentIso,
      updatedAt: recentIso,
    },
    [`${basePath}/memoryDocuments/doc_worker_b_g3`]: {
      id: 'doc_worker_b_g3',
      documentId: 'doc_worker_b_g3',
      ownerId,
      projectId,
      sourceEntityType: 'RELATIONSHIP',
      sourceEntityId: 'rel_lease_g',
      indexGeneration: 3,
      isActiveGeneration: false,
      stagingId: workerBStagingId,
      createdAt: recentIso,
      updatedAt: recentIso,
    },
  });

  try {
    const cleanRes = await cleanupInactiveRagGenerationsOnServer(
      {
        ownerId,
        projectId,
        nowMs,
      },
      { db, cacheNamespace: 'ns_test_g' }
    );

    assert.equal(cleanRes.deletedDocs, 1);
    assert.equal(cleanRes.deletedStagingReceipts, 1);
    assert.ok(cleanRes.skippedInFlightStagingCount >= 1);
    assert.equal(
      store.has(`${basePath}/ragGenerationStaging/${workerAStagingId}`),
      false,
      'Superseded Worker A staging MUST be cleaned up'
    );
    assert.equal(
      store.has(`${basePath}/memoryDocuments/doc_worker_a_g2`),
      false
    );
    assert.equal(
      store.has(`${basePath}/ragGenerationStaging/${workerBStagingId}`),
      true,
      'Live leased Worker B staging MUST be protected'
    );
    assert.equal(
      store.has(`${basePath}/memoryDocuments/doc_worker_b_g3`),
      true
    );
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
    resetRagTestRuntime();
  }
});

test('Stage 2.5C-D Test H: Tenant isolation + Large-scale boundaries (199/200/201/450/451/800+ ops) & batch limit <=450 enforcement', async () => {
  resetRagTestRuntime();
  installDeterministicLiveEmbedder();

  const ownerId = 'author_test_h';
  const intruderId = 'intruder_test_h';
  const projectId = 'proj_test_h';
  const basePath = `users/${ownerId}/projects/${projectId}`;
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  const { db, stats } = createFencingMockFirestore({
    [basePath]: { id: projectId, ownerId, lifecycleStatus: 'ACTIVE' },
  });

  try {
    // 1. Cross-tenant cleanup call MUST be rejected with 403
    await assert.rejects(
      async () =>
        cleanupInactiveRagGenerationsOnServer(
          {
            ownerId: intruderId,
            projectId,
          },
          { db, cacheNamespace: 'ns_test_h' }
        ),
      /403|소유자|거부/
    );

    // 2. Boundary checks: 199 chunks (200 total ops with 1 doc) vs 200 chunks (201 total ops -> MANIFEST_POINTER!)
    assert.equal(LARGE_SCALE_RAG_TX_OP_THRESHOLD, 200);
    const smallBoundary = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'RELATIONSHIP',
        sourceEntityId: 'rel_b_199',
        sourceRevisionId: 'rev_199',
        canonStatus: 'CANON',
        title: '경계값 199 청크 (총 200 ops)',
        summary: 'Boundary 200 ops',
        fullText: buildExactChunkFullText(199, 'B199'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'ns_test_h',
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    assert.equal(smallBoundary.document.activationMode, 'INLINE_DOC');
    assert.equal(smallBoundary.largeScaleGenerationMode, false);

    const largeBoundary = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'RELATIONSHIP',
        sourceEntityId: 'rel_b_201',
        sourceRevisionId: 'rev_201',
        canonStatus: 'CANON',
        title: '경계값 200 청크 (총 201 ops)',
        summary: 'Boundary 201 ops',
        fullText: buildExactChunkFullText(200, 'B201'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'ns_test_h',
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    assert.equal(largeBoundary.document.activationMode, 'MANIFEST_POINTER');
    assert.equal(largeBoundary.largeScaleGenerationMode, true);

    // 3. Batch boundary 450 ops (1 batch) vs 451 ops (2 batches) & 900+ ops (3 batches <= 450)
    const opCountStartIdx = stats.writeBatchOpCounts.length;
    await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_b_450',
        sourceRevisionId: 'rev_450',
        canonStatus: 'CANON',
        title: '배치 경계값 450 ops',
        summary: '1 doc + 449 chunks = 450',
        fullText: buildExactChunkFullText(449, 'B450'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'ns_test_h',
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    const batchesFor450 = stats.writeBatchOpCounts.slice(opCountStartIdx);
    assert.deepEqual(batchesFor450, [450]);

    const idx451 = stats.writeBatchOpCounts.length;
    const large451 = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_b_451',
        sourceRevisionId: 'rev_451',
        canonStatus: 'CANON',
        title: '배치 경계값 451 ops',
        summary: '1 doc + 450 chunks = 451',
        fullText: buildExactChunkFullText(450, 'B451'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'ns_test_h',
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    const batchesFor451 = stats.writeBatchOpCounts.slice(idx451);
    assert.deepEqual(batchesFor451, [450, 1]);

    const idx905 = stats.writeBatchOpCounts.length;
    await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_b_451',
        sourceRevisionId: 'rev_905_new',
        canonStatus: 'CANON',
        title: '대용량 905+ 청크',
        summary: 'Over 900 chunks',
        fullText: buildExactChunkFullText(902, 'B905', 'FINAL_BOUNDARY_NEXUS'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'ns_test_h',
        forceRebuild: true,
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    const batchesFor905 = stats.writeBatchOpCounts.slice(idx905);
    assert.equal(batchesFor905.length, 3);
    assert.ok(batchesFor905.every((c) => c <= 450));

    // Cleanup removes superseded 451-op generation while preserving active 905+ gen
    const cleanAfterScale = await cleanupInactiveRagGenerationsOnServer(
      { ownerId, projectId },
      { db, cacheNamespace: 'ns_test_h' }
    );
    assert.ok(cleanAfterScale.deletedChunks >= 450);
    assert.ok(cleanAfterScale.batchesCommitted >= 2);
    assert.ok(cleanAfterScale.skippedActiveCount >= 1);

    const searchFinal = await searchProjectMemoryOnServer({
      ownerId,
      query: { projectId, queryText: 'FINAL_BOUNDARY_NEXUS', topK: 5 },
      db,
      cacheNamespace: 'ns_test_h',
    });
    assert.ok(searchFinal.hits.length > 0);
    assert.equal(
      searchFinal.hits.some((h) => h.document.id === large451.document.id),
      false
    );
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
    resetRagTestRuntime();
  }
});

test('Stage 2.5C-D2 Test I (P0-A): Staging Receipt TOCTOU eliminated via atomic TX (Cleaner wins, Worker wins, ACTIVATED/ABORTED/VERIFIED guards)', async () => {
  resetRagTestRuntime();
  installDeterministicLiveEmbedder();

  const ownerId = 'author_test_i';
  const projectId = 'proj_test_i';
  const basePath = `users/${ownerId}/projects/${projectId}`;
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  const { db, store } = createFencingMockFirestore({
    [basePath]: { id: projectId, ownerId, lifecycleStatus: 'ACTIVE' },
  });

  try {
    // 1. Active gen 1
    await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_toctou_i',
        sourceRevisionId: 'rev_i1',
        canonStatus: 'CANON',
        title: 'Test I gen1',
        summary: 'Active gen 1',
        fullText: buildExactChunkFullText(205, 'I1', 'I1_ACTIVE_CITADEL'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'ns_test_i',
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );

    // Seed stale gen 2 receipt
    const gen2 = 2;
    const gen2StagingId = buildRagStagingReceiptId({
      projectId,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_toctou_i',
      generation: gen2,
    });
    const staleIso = new Date(Date.now() - 30 * 60_000).toISOString();
    const staleDocId = buildGenerationScopedDocId(
      `memdoc_${projectId}_EPISODE_ep_toctou_i`,
      gen2
    );
    store.set(`${basePath}/memoryDocuments/${staleDocId}`, {
      id: staleDocId,
      documentId: staleDocId,
      ownerId,
      projectId,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_toctou_i',
      indexGeneration: gen2,
      isActiveGeneration: false,
      stagingId: gen2StagingId,
      updatedAt: staleIso,
      createdAt: staleIso,
    });
    store.set(`${basePath}/ragGenerationStaging/${gen2StagingId}`, {
      id: gen2StagingId,
      ownerId,
      projectId,
      entityKey: `${ownerId}:${projectId}:EPISODE:ep_toctou_i`,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_toctou_i',
      generation: gen2,
      activationMode: 'MANIFEST_POINTER',
      status: 'STAGED',
      expectedDocumentIds: [staleDocId],
      expectedDocumentCount: 1,
      expectedChunkCount: 205,
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

    // Subcase I1: Cleaner wins during onAfterStagingInitReadBeforeWriteHook -> Worker TX aborts and NEVER resets receipt to PREPARING
    await assert.rejects(
      async () =>
        indexMemoryInputOnServer(
          {
            ownerId,
            projectId,
            sourceEntityType: 'EPISODE',
            sourceEntityId: 'ep_toctou_i',
            sourceRevisionId: 'rev_i2',
            requestedGeneration: gen2,
            stagingId: gen2StagingId,
            canonStatus: 'CANON',
            title: 'Test I gen2 race',
            summary: 'Cleaner wins TOCTOU',
            fullText: buildExactChunkFullText(205, 'I2'),
            maxChunkLength: 100,
            embeddingDimension: 64,
          },
          {
            db,
            cacheNamespace: 'ns_test_i',
            forceRebuild: true,
            durableCommitPolicy: {
              requireDurableCloudCommit: true,
              requireActiveGenerationVerification: true,
            },
            onAfterStagingInitReadBeforeWriteHook: async () => {
              await cleanupInactiveRagGenerationsOnServer(
                {
                  ownerId,
                  projectId,
                  targetGeneration: gen2,
                  targetStagingId: gen2StagingId,
                  retainCompletedReceipts: true,
                },
                { db, cacheNamespace: 'ns_test_i' }
              );
            },
          }
        ),
      /\[ACTIVATION_BLOCKED_BY_CLEANUP\]/
    );
    const rAfterCleaner = store.get(
      `${basePath}/ragGenerationStaging/${gen2StagingId}`
    ) as unknown as RagGenerationStagingReceipt;
    assert.equal(rAfterCleaner.status, 'CLEANUP_COMPLETED');

    // Subcase I2: Worker wins with fresh PREPARING receipt inside Cleaner onAfterCandidateScanBeforeClaimTx -> Cleaner Claim TX skips!
    const gen3 = 3;
    const gen3StagingId = buildRagStagingReceiptId({
      projectId,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_toctou_i',
      generation: gen3,
    });
    const gen3DocId = `memdoc_${projectId}_EPISODE_ep_toctou_i_part_1__g${gen3}`;
    store.set(`${basePath}/memoryDocuments/${gen3DocId}`, {
      id: gen3DocId,
      documentId: gen3DocId,
      ownerId,
      projectId,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_toctou_i',
      indexGeneration: gen3,
      isActiveGeneration: false,
      stagingId: gen3StagingId,
      updatedAt: staleIso,
      createdAt: staleIso,
    });
    store.set(`${basePath}/ragGenerationStaging/${gen3StagingId}`, {
      id: gen3StagingId,
      ownerId,
      projectId,
      entityKey: `${ownerId}:${projectId}:EPISODE:ep_toctou_i`,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_toctou_i',
      generation: gen3,
      activationMode: 'MANIFEST_POINTER',
      status: 'STAGED',
      expectedDocumentIds: [gen3DocId],
      expectedDocumentCount: 1,
      expectedChunkCount: 2,
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
    const cleanerLose = await cleanupInactiveRagGenerationsOnServer(
      {
        ownerId,
        projectId,
        targetGeneration: gen3,
        targetStagingId: gen3StagingId,
        onAfterCandidateScanBeforeClaimTx: async () => {
          const prev = store.get(
            `${basePath}/ragGenerationStaging/${gen3StagingId}`
          )!;
          store.set(`${basePath}/ragGenerationStaging/${gen3StagingId}`, {
            ...prev,
            status: 'PREPARING',
            updatedAt: new Date().toISOString(),
          });
        },
      },
      { db, cacheNamespace: 'ns_test_i' }
    );
    assert.equal(cleanerLose.deletedDocs, 0);
    assert.ok(cleanerLose.skippedInFlightStagingCount >= 1);

    // Subcase I3: ACTIVATED / ABORTED / VERIFIED mismatch state guards
    const gen1StagingId = buildRagStagingReceiptId({
      projectId,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_toctou_i',
      generation: 1,
    });
    await assert.rejects(
      async () =>
        indexMemoryInputOnServer(
          {
            ownerId,
            projectId,
            sourceEntityType: 'EPISODE',
            sourceEntityId: 'ep_toctou_i',
            sourceRevisionId: 'rev_i1_overwrite',
            requestedGeneration: 1,
            stagingId: gen1StagingId,
            canonStatus: 'CANON',
            title: 'Overwrite ACTIVATED',
            summary: 'Must reject',
            fullText: buildExactChunkFullText(205, 'I1_NEW'),
            maxChunkLength: 100,
            embeddingDimension: 64,
          },
          { db, cacheNamespace: 'ns_test_i', forceRebuild: true }
        ),
      /\[STAGING_ALREADY_ACTIVATED\]|\[RAG_INDEX_ACTIVATION_CONFLICT\]/
    );

    const gen4StagingId = buildRagStagingReceiptId({
      projectId,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_toctou_i',
      generation: 4,
    });
    store.set(`${basePath}/ragGenerationStaging/${gen4StagingId}`, {
      id: gen4StagingId,
      ownerId,
      projectId,
      entityKey: `${ownerId}:${projectId}:EPISODE:ep_toctou_i`,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_toctou_i',
      generation: 4,
      activationMode: 'MANIFEST_POINTER',
      status: 'ABORTED',
      expectedDocumentIds: [],
      expectedDocumentCount: 1,
      expectedChunkCount: 205,
      expectedContentHash: 'x',
      expectedSourceRevisionId: 'r4',
      stagedDocumentCount: 0,
      stagedChunkCount: 0,
      verifiedDocumentCount: 0,
      verifiedChunkCount: 0,
      batchesCommitted: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await assert.rejects(
      async () =>
        indexMemoryInputOnServer(
          {
            ownerId,
            projectId,
            sourceEntityType: 'EPISODE',
            sourceEntityId: 'ep_toctou_i',
            sourceRevisionId: 'rev_i4',
            requestedGeneration: 4,
            stagingId: gen4StagingId,
            canonStatus: 'CANON',
            title: 'Reenter ABORTED',
            summary: 'Must reject',
            fullText: buildExactChunkFullText(205, 'I4'),
            maxChunkLength: 100,
            embeddingDimension: 64,
          },
          { db, cacheNamespace: 'ns_test_i', forceRebuild: true }
        ),
      /\[STAGING_ABORTED_CANNOT_REENTER\]/
    );

    const gen5StagingId = buildRagStagingReceiptId({
      projectId,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_toctou_i',
      generation: 5,
    });
    store.set(`${basePath}/ragGenerationStaging/${gen5StagingId}`, {
      id: gen5StagingId,
      ownerId,
      projectId,
      entityKey: `${ownerId}:${projectId}:EPISODE:ep_toctou_i`,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_toctou_i',
      generation: 5,
      activationMode: 'MANIFEST_POINTER',
      status: 'VERIFIED',
      activationToken: 'tok_alpha',
      targetTaskId: 'task_alpha',
      expectedDocumentIds: [],
      expectedDocumentCount: 1,
      expectedChunkCount: 205,
      expectedContentHash: 'different_hash',
      expectedSourceRevisionId: 'r5',
      stagedDocumentCount: 1,
      stagedChunkCount: 205,
      verifiedDocumentCount: 1,
      verifiedChunkCount: 205,
      batchesCommitted: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await assert.rejects(
      async () =>
        indexMemoryInputOnServer(
          {
            ownerId,
            projectId,
            sourceEntityType: 'EPISODE',
            sourceEntityId: 'ep_toctou_i',
            sourceRevisionId: 'rev_i5',
            requestedGeneration: 5,
            stagingId: gen5StagingId,
            canonStatus: 'CANON',
            title: 'Mismatch VERIFIED',
            summary: 'Must reject',
            fullText: buildExactChunkFullText(205, 'I5'),
            maxChunkLength: 100,
            embeddingDimension: 64,
          },
          { db, cacheNamespace: 'ns_test_i', forceRebuild: true }
        ),
      /\[STAGING_VERIFIED_TOKEN_MISMATCH\]/
    );
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
    resetRagTestRuntime();
  }
});

test('Stage 2.5C-D2 Test J (P0-B): Multi-Cleaner ownership conflict, unclean crash lease expiry takeover, and stale Cleaner Fenced Delete TX abort', async () => {
  resetRagTestRuntime();
  installDeterministicLiveEmbedder();

  const ownerId = 'author_test_j';
  const projectId = 'proj_test_j';
  const basePath = `users/${ownerId}/projects/${projectId}`;
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  const { db, store } = createFencingMockFirestore({
    [basePath]: { id: projectId, ownerId, lifecycleStatus: 'ACTIVE' },
  });

  try {
    // 1. Superseded g1 (450 chunks -> 3 Fenced Delete TXs of 200, 200, 51) + Active g2
    await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_owner_j1',
        sourceRevisionId: 'rev_j1',
        canonStatus: 'CANON',
        title: 'J g1',
        summary: '450 chunks',
        fullText: buildExactChunkFullText(450, 'J1'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'ns_test_j',
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    const g2 = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_owner_j1',
        sourceRevisionId: 'rev_j2',
        canonStatus: 'CANON',
        title: 'J g2 active',
        summary: 'Active g2',
        fullText: buildExactChunkFullText(205, 'J2', 'J2_ACTIVE_KEEP'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'ns_test_j',
        forceRebuild: true,
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );

    const t0 = Date.now();
    // Cleaner A holds live lease in onBetweenClaimAndDeleteHook -> Concurrent Cleaner B is rejected with [CLEANUP_OWNERSHIP_CONFLICT]
    let cleanerBSawConflict = false;
    const cleanerARes = await cleanupInactiveRagGenerationsOnServer(
      {
        ownerId,
        projectId,
        cleanupOwner: 'cleaner_A_live',
        cleanupLeaseDurationMs: 10_000,
        nowMs: t0,
        onBetweenClaimAndDeleteHook: async () => {
          try {
            await cleanupInactiveRagGenerationsOnServer(
              {
                ownerId,
                projectId,
                cleanupOwner: 'cleaner_B_rival',
                nowMs: t0 + 1_000,
                failOnOwnershipConflict: true,
              },
              { db, cacheNamespace: 'ns_test_j' }
            );
          } catch (err) {
            if (
              err instanceof Error &&
              err.message.includes('[CLEANUP_OWNERSHIP_CONFLICT]')
            ) {
              cleanerBSawConflict = true;
              return;
            }
            throw err;
          }
        },
      },
      { db, cacheNamespace: 'ns_test_j' }
    );
    assert.equal(cleanerBSawConflict, true);
    assert.equal(cleanerARes.completedClaimKeys?.length, 1);
    assert.ok(cleanerARes.batchesCommitted >= 3);
    assert.ok(store.has(`${basePath}/memoryDocuments/${g2.document.id}`));

    // 2. Unclean crash + Lease expiry takeover + Zombie stale cleaner Fenced Delete TX abort!
    await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_owner_j2',
        sourceRevisionId: 'rev_j3',
        canonStatus: 'CANON',
        title: 'J g3 superseded',
        summary: '450 chunks for crash/zombie',
        fullText: buildExactChunkFullText(450, 'J3'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'ns_test_j',
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_owner_j2',
        sourceRevisionId: 'rev_j4',
        canonStatus: 'CANON',
        title: 'J g4 active',
        summary: 'Active g4',
        fullText: buildExactChunkFullText(205, 'J4', 'J4_ACTIVE_KEEP'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'ns_test_j',
        forceRebuild: true,
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );

    const t1 = Date.now() + 50_000;
    await assert.rejects(
      async () =>
        cleanupInactiveRagGenerationsOnServer(
          {
            ownerId,
            projectId,
            sourceEntityId: 'ep_owner_j2',
            cleanupOwner: 'cleaner_crash',
            cleanupLeaseDurationMs: 5_000,
            nowMs: t1,
            simulateDeleteFailureAtBatchNumber: 2,
            simulateUncleanCrashLeaveLeaseActive: true,
          },
          { db, cacheNamespace: 'ns_test_j' }
        ),
      /\[CLEANUP_BATCH_DELETE_FAILED\]/
    );

    // Before expiry: rival blocked
    await assert.rejects(
      async () =>
        cleanupInactiveRagGenerationsOnServer(
          {
            ownerId,
            projectId,
            sourceEntityId: 'ep_owner_j2',
            cleanupOwner: 'cleaner_early',
            nowMs: t1 + 2_000,
            failOnOwnershipConflict: true,
          },
          { db, cacheNamespace: 'ns_test_j' }
        ),
      /\[CLEANUP_OWNERSHIP_CONFLICT\]/
    );

    // After expiry: Cleaner C takes over (epoch bumps)
    const takeoverRes = await cleanupInactiveRagGenerationsOnServer(
      {
        ownerId,
        projectId,
        sourceEntityId: 'ep_owner_j2',
        cleanupOwner: 'cleaner_takeover',
        nowMs: t1 + 10_000,
      },
      { db, cacheNamespace: 'ns_test_j' }
    );
    assert.ok((takeoverRes.cleanupEpoch ?? 0) >= 3);
    assert.equal(takeoverRes.completedClaimKeys?.length, 1);

    // Also verify MockBackend parity for ownership conflict & zombie abort
    resetRagTestRuntime();
    const mockBackend = new InMemoryMockFirestoreRagBackend();
    const mProj = 'proj_mock_j';
    const mBase = `users/${ownerId}/projects/${mProj}`;
    registerProjectOwnerForAdminCheck(mProj, ownerId);
    mockBackend.documentsByPath.set(mBase, { id: mProj, ownerId });
    setMockFirestoreRagBackendForTesting(mockBackend);

    await indexMemoryInputOnServer(
      {
        ownerId,
        projectId: mProj,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_mj',
        sourceRevisionId: 'r1',
        canonStatus: 'CANON',
        title: 'MJ 1',
        summary: '450 chunks',
        fullText: buildExactChunkFullText(450, 'MJ1'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      { cacheNamespace: 'ns_mock_j', durableCommitPolicy: { requireDurableCloudCommit: true, requireActiveGenerationVerification: true } }
    );
    await indexMemoryInputOnServer(
      {
        ownerId,
        projectId: mProj,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ep_mj',
        sourceRevisionId: 'r2',
        canonStatus: 'CANON',
        title: 'MJ 2',
        summary: '205 chunks',
        fullText: buildExactChunkFullText(205, 'MJ2'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      { cacheNamespace: 'ns_mock_j', forceRebuild: true, durableCommitPolicy: { requireDurableCloudCommit: true, requireActiveGenerationVerification: true } }
    );

    const tMock = Date.now() + 100_000;
    await assert.rejects(
      async () =>
        cleanupInactiveRagGenerationsOnServer({
          ownerId,
          projectId: mProj,
          cleanupOwner: 'mock_zombie',
          cleanupLeaseDurationMs: 2_000,
          nowMs: tMock,
          onAfterDeleteBatchHook: async ({ batchesCommitted }) => {
            if (batchesCommitted === 1) {
              await cleanupInactiveRagGenerationsOnServer({
                ownerId,
                projectId: mProj,
                cleanupOwner: 'mock_thief',
                nowMs: tMock + 10_000,
              });
            }
          },
        }),
      /\[CLEANUP_OWNERSHIP_LOST\]/
    );
  } finally {
    setMockFirestoreRagBackendForTesting(null);
    setCustomGeminiEmbedContentForTesting(null);
    resetRagTestRuntime();
  }
});

test('Stage 2.5C-D2 Test K (Section 4): Completed claim pruning (>40) compacts retiredGenerationsByEntity and blocks old Worker/Cleaner replay forever', async () => {
  resetRagTestRuntime();
  installDeterministicLiveEmbedder();

  const ownerId = 'author_test_k';
  const projectId = 'proj_test_k';
  const basePath = `users/${ownerId}/projects/${projectId}`;
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  const entityKey = `${ownerId}:${projectId}:RELATIONSHIP:rel_replay_k`;
  const seededClaims: Record<string, unknown> = {};
  for (let g = 1; g <= 45; g++) {
    seededClaims[`${entityKey}::g${g}`] = {
      claimKey: `${entityKey}::g${g}`,
      entityKey,
      ownerId,
      projectId,
      sourceEntityType: 'RELATIONSHIP',
      sourceEntityId: 'rel_replay_k',
      generation: g,
      cleanupOperationId: `op_seed_${g}`,
      cleanupEpoch: g,
      cleanupOwner: 'seed_cleaner',
      status: 'CLEANUP_COMPLETED',
      targetDocumentIds: [],
      claimedAt: '2026-06-01T00:00:00.000Z',
      completedAt: `2026-06-01T00:${String(g).padStart(2, '0')}:00.000Z`,
    };
  }

  const { db, store } = createFencingMockFirestore({
    [basePath]: { id: projectId, ownerId, lifecycleStatus: 'ACTIVE' },
    [`${basePath}/ragManifest/control`]: {
      ownerId,
      projectId,
      activeGenerationCounter: 46,
      cleanupEpochCounter: 45,
      cleanupClaims: seededClaims,
      entityStates: {},
    },
    [`${basePath}/memoryDocuments/doc_rel_46`]: {
      id: 'doc_rel_46',
      documentId: 'doc_rel_46',
      ownerId,
      projectId,
      sourceEntityType: 'RELATIONSHIP',
      sourceEntityId: 'rel_replay_k',
      indexGeneration: 46,
      isActiveGeneration: false,
      updatedAt: '2026-06-01T00:00:00.000Z',
    },
  });

  try {
    // Cleanup gen 46 triggers claim pruning (>40) and retired ledger compaction
    const cleanRes = await cleanupInactiveRagGenerationsOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'RELATIONSHIP',
        sourceEntityId: 'rel_replay_k',
        targetGeneration: 46,
        staleStagingThresholdMs: 0,
      },
      { db, cacheNamespace: 'ns_test_k' }
    );
    assert.equal(cleanRes.completedClaimKeys?.length, 1);

    const manifestAfter = store.get(
      `${basePath}/ragManifest/control`
    ) as unknown as FirestoreRagManifestDoc;
    assert.ok(
      Object.keys(manifestAfter.cleanupClaims || {}).length <= 30,
      'Manifest cleanupClaims map must stay bounded after pruning'
    );
    assert.equal(
      manifestAfter.cleanupClaims?.[`${entityKey}::g1`],
      undefined,
      'Old completed claim #1 should be pruned from cleanupClaims'
    );
    assert.ok(
      (manifestAfter.retiredGenerationsByEntity?.[entityKey]?.retiredThroughGen ??
        0) >= 46,
      'Compacted retiredGenerationsByEntity ledger must preserve retired watermark >= 46'
    );

    // Zombie Worker attempting to reuse/reactivate pruned gen 1 MUST be blocked permanently!
    await assert.rejects(
      async () =>
        indexMemoryInputOnServer(
          {
            ownerId,
            projectId,
            sourceEntityType: 'RELATIONSHIP',
            sourceEntityId: 'rel_replay_k',
            sourceRevisionId: 'rev_zombie_1',
            requestedGeneration: 1,
            canonStatus: 'CANON',
            title: 'Zombie Worker gen 1',
            summary: 'Pruned gen 1 replay must fail',
            fullText: buildExactChunkFullText(205, 'ZOMBIE_1'),
            maxChunkLength: 100,
            embeddingDimension: 64,
          },
          {
            db,
            cacheNamespace: 'ns_test_k',
            forceRebuild: true,
            durableCommitPolicy: {
              requireDurableCloudCommit: true,
              requireActiveGenerationVerification: true,
            },
          }
        ),
      /\[ACTIVATION_BLOCKED_BY_CLEANUP\]/
    );

    // New reservation skips all retired generations (> 46)
    const nextGen = await reserveRagGenerationOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'RELATIONSHIP',
        sourceEntityId: 'rel_replay_k',
        largeScaleGenerationMode: true,
      },
      { db, cacheNamespace: 'ns_test_k' }
    );
    assert.ok(nextGen.generation > 46);
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
    resetRagTestRuntime();
  }
});

test('Stage 2.5C-D2 P0-1 & P0-2 Regression: sanitizeFirestoreWriteData strips all undefined fields deeply while preserving sentinels, and (default) DB is permitted ONLY for demo-* + FIRESTORE_EMULATOR_HOST', async () => {
  const { FieldValue } = await import('firebase-admin/firestore');
  const { sanitizeFirestoreWriteData } = await import('../server/ragEngine.ts');
  const {
    isIsolatedEmulatorDemoDatabase,
    registerIsolatedMockFirestoreForTest,
  } = await import('../server/authMiddleware.ts');

  const nowDate = new Date('2026-06-01T00:00:00.000Z');
  const serverTs = FieldValue.serverTimestamp();
  const vectorVal = FieldValue.vector([0.1, 0.2, 0.3]);

  const rawPayload = {
    id: 'stg_p0_1',
    targetTaskId: undefined,
    episodeNumber: undefined,
    stagingId: undefined,
    nested: {
      activeTaskId: undefined,
      activeLeaseGeneration: 3,
      deepArray: [1, undefined, { insideUndefined: undefined, ok: 'yes' }],
    },
    createdAt: nowDate,
    updatedAt: serverTs,
    embedding: vectorVal,
  };

  const sanitized = sanitizeFirestoreWriteData(rawPayload) as Record<
    string,
    unknown
  >;

  assert.equal('targetTaskId' in sanitized, false);
  assert.equal('episodeNumber' in sanitized, false);
  assert.equal('stagingId' in sanitized, false);
  assert.equal(sanitized.id, 'stg_p0_1');
  assert.strictEqual(sanitized.createdAt, nowDate);
  assert.strictEqual(sanitized.updatedAt, serverTs);
  assert.strictEqual(sanitized.embedding, vectorVal);

  const nested = sanitized.nested as Record<string, unknown>;
  assert.equal('activeTaskId' in nested, false);
  assert.equal(nested.activeLeaseGeneration, 3);
  const deepArray = nested.deepArray as Array<unknown>;
  assert.equal(deepArray.length, 2);
  assert.equal(deepArray[0], 1);
  assert.deepEqual(deepArray[1], { ok: 'yes' });

  // P0-2: verify Emulator vs non-Emulator (default) isolation
  const prevEmuHost = process.env.FIRESTORE_EMULATOR_HOST;
  const fakeDb = {} as unknown as import('firebase-admin/firestore').Firestore;
  try {
    delete process.env.FIRESTORE_EMULATOR_HOST;
    assert.equal(
      isIsolatedEmulatorDemoDatabase({
        projectId: 'demo-novelforge-rag-integrity',
        databaseId: '(default)',
      }),
      false
    );
    assert.throws(
      () =>
        registerIsolatedMockFirestoreForTest(fakeDb, {
          runId: 'p0_2_no_emu',
          projectId: 'demo-novelforge-rag-integrity',
          databaseId: '(default)',
        }),
      /ISOLATED_TEST_DB_PROD_COLLISION/
    );

    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
    assert.equal(
      isIsolatedEmulatorDemoDatabase({
        projectId: 'demo-novelforge-rag-integrity',
        databaseId: '(default)',
      }),
      true
    );
    assert.equal(
      isIsolatedEmulatorDemoDatabase({
        projectId: 'non-demo-project',
        databaseId: '(default)',
      }),
      false
    );
    assert.doesNotThrow(() =>
      registerIsolatedMockFirestoreForTest(fakeDb, {
        runId: 'p0_2_emu_demo',
        projectId: 'demo-novelforge-rag-integrity',
        databaseId: '(default)',
      })
    );
    assert.throws(
      () =>
        registerIsolatedMockFirestoreForTest(fakeDb, {
          runId: 'p0_2_emu_nondemo',
          projectId: 'non-demo-project',
          databaseId: '(default)',
        }),
      /ISOLATED_TEST_DB_PROD_COLLISION/
    );
  } finally {
    if (prevEmuHost === undefined) {
      delete process.env.FIRESTORE_EMULATOR_HOST;
    } else {
      process.env.FIRESTORE_EMULATOR_HOST = prevEmuHost;
    }
  }
});

test('Stage 2.5C-D4 P0-B Regression: tx.update replaces cleanupClaims wholesale under real Firestore deep-merge semantics, preserves CLEANUP_PENDING claims and entityStates, and permanently deletes pruned keys', async () => {
  resetRagTestRuntime();
  installDeterministicLiveEmbedder();

  const ownerId = 'author_d4_p0b';
  const projectId = 'proj_d4_p0b';
  const basePath = `users/${ownerId}/projects/${projectId}`;
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  const entityKey = `${ownerId}:${projectId}:RELATIONSHIP:rel_d4`;
  const activeEntityKey = `${ownerId}:${projectId}:EPISODE:ep_active_keep`;
  const pendingEntityKey = `${ownerId}:${projectId}:TIMELINE_EVENT:tl_pending_keep`;
  const pendingClaimKey = `${pendingEntityKey}::g1`;

  const seededClaims: Record<string, unknown> = {};
  for (let g = 1; g <= 45; g++) {
    seededClaims[`${entityKey}::g${g}`] = {
      claimKey: `${entityKey}::g${g}`,
      entityKey,
      ownerId,
      projectId,
      sourceEntityType: 'RELATIONSHIP',
      sourceEntityId: 'rel_d4',
      generation: g,
      cleanupOperationId: `op_seed_${g}`,
      cleanupEpoch: g,
      cleanupOwner: 'seed_cleaner',
      status: 'CLEANUP_COMPLETED',
      targetDocumentIds: [],
      claimedAt: '2026-06-01T00:00:00.000Z',
      completedAt: `2026-06-01T00:${String(g).padStart(2, '0')}:00.000Z`,
    };
  }
  // Also include a live unexpired CLEANUP_PENDING claim that MUST NOT be pruned away
  seededClaims[pendingClaimKey] = {
    claimKey: pendingClaimKey,
    entityKey: pendingEntityKey,
    ownerId,
    projectId,
    sourceEntityType: 'TIMELINE_EVENT',
    sourceEntityId: 'tl_pending_keep',
    generation: 1,
    cleanupOperationId: 'op_live_pending',
    cleanupEpoch: 45,
    cleanupOwner: 'other_cleaner',
    status: 'CLEANUP_PENDING',
    targetDocumentIds: ['doc_pending_other'],
    claimedAt: '2026-06-01T00:50:00.000Z',
    cleanupLeaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    cleanupLeaseExpiresAtMs: Date.now() + 300_000,
  };

  const { db, store } = createFencingMockFirestore({
    [basePath]: { id: projectId, ownerId, lifecycleStatus: 'ACTIVE' },
    [`${basePath}/ragManifest/control`]: {
      ownerId,
      projectId,
      projectLifecycleStatus: 'ACTIVE',
      projectTombstoneGeneration: 2,
      activeGenerationCounter: 99,
      cleanupEpochCounter: 45,
      entityStates: {
        [activeEntityKey]: {
          entityKey: activeEntityKey,
          ownerId,
          projectId,
          sourceEntityType: 'EPISODE',
          sourceEntityId: 'ep_active_keep',
          activeGeneration: 99,
          activeDocumentIds: ['memdoc_keep_99'],
          lifecycleStatus: 'ACTIVE',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
      },
      cleanupClaims: seededClaims,
    },
    [`${basePath}/memoryDocuments/doc_rel_d4_46`]: {
      id: 'doc_rel_d4_46',
      documentId: 'doc_rel_d4_46',
      ownerId,
      projectId,
      sourceEntityType: 'RELATIONSHIP',
      sourceEntityId: 'rel_d4',
      indexGeneration: 46,
      isActiveGeneration: false,
      updatedAt: '2026-06-01T00:00:00.000Z',
    },
  });

  try {
    // 1. Confirm faithful mock Firestore reproduces real deep-merge behavior on set({ merge: true })
    await db.doc(`${basePath}/ragManifest/control`).set(
      {
        cleanupClaims: {
          [`${entityKey}::g45`]: { status: 'CLEANUP_COMPLETED' },
        },
      },
      { merge: true }
    );
    const afterMergeSnap = store.get(`${basePath}/ragManifest/control`) as {
      cleanupClaims?: Record<string, unknown>;
    };
    assert.ok(
      afterMergeSnap.cleanupClaims?.[`${entityKey}::g1`],
      'Faithful Firestore set({merge:true}) deep-merges maps and retains omitted keys'
    );

    // 2. Run real cleanup on gen 46; tx.update() MUST replace cleanupClaims wholesale so pruned keys actually disappear!
    const cleanRes = await cleanupInactiveRagGenerationsOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'RELATIONSHIP',
        sourceEntityId: 'rel_d4',
        targetGeneration: 46,
        staleStagingThresholdMs: 0,
      },
      { db, cacheNamespace: 'ns_d4_p0b' }
    );
    assert.equal(cleanRes.deletedDocs, 1);
    assert.deepEqual(cleanRes.completedClaimKeys, [`${entityKey}::g46`]);

    const manifestAfter = store.get(
      `${basePath}/ragManifest/control`
    ) as unknown as FirestoreRagManifestDoc;
    const claimKeysAfter = Object.keys(manifestAfter.cleanupClaims || {});
    assert.ok(
      claimKeysAfter.length <= 30,
      `Expected <= 30 cleanupClaims keys after pruning, got ${claimKeysAfter.length}`
    );
    assert.equal(
      `${entityKey}::g1` in (manifestAfter.cleanupClaims || {}),
      false,
      'Pruned old claim g1 MUST be completely deleted from stored cleanupClaims map'
    );
    assert.equal(
      `${entityKey}::g2` in (manifestAfter.cleanupClaims || {}),
      false,
      'Pruned old claim g2 MUST be completely deleted from stored cleanupClaims map'
    );
    assert.equal(
      manifestAfter.cleanupClaims?.[pendingClaimKey]?.status,
      'CLEANUP_PENDING',
      'Active CLEANUP_PENDING claim MUST survive pruning'
    );
    assert.equal(
      manifestAfter.cleanupClaims?.[`${entityKey}::g46`]?.status,
      'CLEANUP_COMPLETED'
    );

    // Untouched Manifest fields MUST remain intact after tx.update()
    assert.equal(manifestAfter.activeGenerationCounter, 99);
    assert.equal(manifestAfter.projectTombstoneGeneration, 2);
    assert.equal(manifestAfter.cleanupEpochCounter, 46);
    assert.equal(
      manifestAfter.entityStates?.[activeEntityKey]?.activeGeneration,
      99
    );

    // Retired generation ledger + replay protection MUST remain enforced
    assert.ok(
      (manifestAfter.retiredGenerationsByEntity?.[entityKey]?.retiredThroughGen ??
        0) >= 46
    );
    await assert.rejects(
      async () =>
        indexMemoryInputOnServer(
          {
            ownerId,
            projectId,
            sourceEntityType: 'RELATIONSHIP',
            sourceEntityId: 'rel_d4',
            sourceRevisionId: 'rev_d4_zombie',
            requestedGeneration: 1,
            canonStatus: 'CANON',
            title: 'Zombie replay after pruned cleanupClaims',
            summary: 'Must block',
            fullText: buildExactChunkFullText(205, 'D4_ZOMBIE'),
            maxChunkLength: 100,
            embeddingDimension: 64,
          },
          {
            db,
            cacheNamespace: 'ns_d4_p0b',
            forceRebuild: true,
            durableCommitPolicy: {
              requireDurableCloudCommit: true,
              requireActiveGenerationVerification: true,
            },
          }
        ),
      /\[ACTIVATION_BLOCKED_BY_CLEANUP\]/
    );
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
    resetRagTestRuntime();
  }
});



