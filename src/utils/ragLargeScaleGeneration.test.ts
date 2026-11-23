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
  type EntityIndexLifecycleState,
} from '../services/memorySearchProvider.ts';
import { computeDeterministicRagSyncTaskId } from '../utils/changeProposalApprovalLogic.ts';
import type { RagGenerationStagingReceipt } from '../types/foundation.ts';

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
      `# ${tag}_SCENE_${i + 1}\n${marker}${tag} 장면 ${i + 1}번의 핵심 설정 및 사건 기록입니다.`
    );
  }
  return blocks.join('\n\n');
}

interface Stage25CMockFirestoreHooks {
  failBatchAtAttempt?: number;
  failManifestTxCount?: number;
  onBeforeStageBManifestRead?: (runIndex: number) => Promise<void> | void;
  onBeforeReservationManifestRead?: (runIndex: number) => Promise<void> | void;
}

function createStage25CMockFirestore(
  initialDocs: Record<string, Record<string, unknown>> = {},
  hooks: Stage25CMockFirestoreHooks = {}
): {
  db: Firestore;
  store: Map<string, Record<string, unknown>>;
  stats: {
    batchCommits: number;
    batchOpCounts: number[];
    txAttempts: number;
    manifestTxRuns: number;
  };
} {
  const store = new Map<string, Record<string, unknown>>();
  for (const [k, v] of Object.entries(initialDocs)) {
    store.set(k.replace(/^\/+/, ''), structuredClone(v));
  }

  let txQueue = Promise.resolve();
  let remainingManifestTxFailures = hooks.failManifestTxCount || 0;
  let batchAttemptCount = 0;

  const stats = {
    batchCommits: 0,
    batchOpCounts: [] as number[],
    txAttempts: 0,
    manifestTxRuns: 0,
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
    const cleanCol = rawColPath.replace(/^\/+|\/+$/g, '');
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
          batchAttemptCount += 1;
          stats.batchOpCounts.push(stagedOps.length);
          if (stagedOps.length > 500) {
            throw new Error(
              `Firestore batch op limit exceeded: ${stagedOps.length} > 500`
            );
          }
          if (
            hooks.failBatchAtAttempt &&
            batchAttemptCount === hooks.failBatchAtAttempt
          ) {
            throw new Error(
              `UNAVAILABLE: Simulated mid-batch failure at attempt #${batchAttemptCount}`
            );
          }
          stats.batchCommits += 1;
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
        let touchedManifest = false;
        let manifestEntityStatesWritten = false;
        const stagedWrites: Array<() => void> = [];
        const readPaths: string[] = [];

        const txObj = {
          async get(ref: { path: string; id: string }) {
            if (writeStarted) {
              throw new Error(
                'Firestore transactions require all reads before any writes!'
              );
            }
            readPaths.push(ref.path);
            if (ref.path.endsWith('/ragManifest/control')) {
              touchedManifest = true;
              stats.manifestTxRuns += 1;
              if (hooks.onBeforeReservationManifestRead) {
                await hooks.onBeforeReservationManifestRead(stats.manifestTxRuns);
              }
              if (hooks.onBeforeStageBManifestRead) {
                await hooks.onBeforeStageBManifestRead(stats.manifestTxRuns);
              }
              workingStore.clear();
              for (const [k, v] of store.entries()) {
                workingStore.set(k, structuredClone(v));
              }
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
            if (ref.path.endsWith('/ragManifest/control')) {
              touchedManifest = true;
              if ('entityStates' in data && data.entityStates) {
                manifestEntityStatesWritten = true;
              }
            }
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
            if (ref.path.endsWith('/ragManifest/control')) {
              touchedManifest = true;
              if ('entityStates' in data && data.entityStates) {
                manifestEntityStatesWritten = true;
              }
            }
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
        // Only apply manifest tx failure to Stage B activation commits (where entityStates is switched)
        const manifestWriteTouched =
          touchedManifest && manifestEntityStatesWritten;
        if (manifestWriteTouched && remainingManifestTxFailures > 0) {
          remainingManifestTxFailures -= 1;
          throw new Error(
            'ABORTED: Simulated Stage B ragManifest/control transaction failure'
          );
        }

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
    projectId: 'test-stage25c-phase422',
    databaseId: 'test-db-stage25c',
    runId: `run_stage25c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  });

  return {
    db: typedDb,
    store,
    stats,
  };
}

function createSeededProjectDocs(ownerId: string, projectId: string) {
  const basePath = `users/${ownerId}/projects/${projectId}`;
  return {
    basePath,
    seed: {
      [basePath]: {
        id: projectId,
        ownerId,
        title: '대규모 RAG 테스트 프로젝트',
        lifecycleStatus: 'ACTIVE',
      },
    } as Record<string, Record<string, unknown>>,
  };
}

test('Stage 2.5C Case 1: Op boundary switching (199/200 INLINE_DOC vs 201 MANIFEST_POINTER & 449/450/451/800/1200+ chunking)', async () => {
  resetRagTestRuntime();
  assert.equal(LARGE_SCALE_RAG_TX_OP_THRESHOLD, 200);

  const ownerId = 'author_s25c_bounds';
  const projectId = 'proj_s25c_bounds';
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  setCustomGeminiEmbedContentForTesting(async ({ contents, config }) => {
    const dim =
      typeof (config as { outputDimensionality?: number } | undefined)
        ?.outputDimensionality === 'number'
        ? (config as { outputDimensionality: number }).outputDimensionality
        : 768;
    return {
      embeddings: [
        { values: computeDeterministicSemanticEmbedding(contents, dim) },
      ],
    };
  });

  try {
    const cases: Array<{
      chunkCount: number;
      expectedDocs: number;
      expectedMode: 'INLINE_DOC' | 'MANIFEST_POINTER';
      expectedBatches: number;
    }> = [
      { chunkCount: 198, expectedDocs: 1, expectedMode: 'INLINE_DOC', expectedBatches: 1 }, // 199 ops
      { chunkCount: 199, expectedDocs: 1, expectedMode: 'INLINE_DOC', expectedBatches: 1 }, // 200 ops
      { chunkCount: 200, expectedDocs: 1, expectedMode: 'MANIFEST_POINTER', expectedBatches: 1 }, // 201 ops
      { chunkCount: 448, expectedDocs: 1, expectedMode: 'MANIFEST_POINTER', expectedBatches: 1 }, // 449 ops
      { chunkCount: 449, expectedDocs: 1, expectedMode: 'MANIFEST_POINTER', expectedBatches: 1 }, // 450 ops
      { chunkCount: 450, expectedDocs: 1, expectedMode: 'MANIFEST_POINTER', expectedBatches: 2 }, // 451 ops
      { chunkCount: 798, expectedDocs: 2, expectedMode: 'MANIFEST_POINTER', expectedBatches: 2 }, // 800 ops
      { chunkCount: 1200, expectedDocs: 3, expectedMode: 'MANIFEST_POINTER', expectedBatches: 3 }, // 1203 ops
    ];

    for (let idx = 0; idx < cases.length; idx++) {
      const c = cases[idx];
      const { basePath, seed } = createSeededProjectDocs(ownerId, projectId);
      const { db, store, stats } = createStage25CMockFirestore(seed);
      const entityId = `ent_bound_${c.chunkCount}`;

      const result = await indexMemoryInputOnServer(
        {
          ownerId,
          projectId,
          sourceEntityType: 'EPISODE',
          sourceEntityId: entityId,
          sourceRevisionId: `rev_${c.chunkCount}`,
          canonStatus: 'CANON',
          title: `경계값 테스트 ${c.chunkCount} 청크`,
          summary: `경계값 요약 ${c.chunkCount}`,
          fullText: buildExactChunkFullText(c.chunkCount, `BND_${c.chunkCount}`),
          maxChunkLength: 100,
          embeddingDimension: 64,
        },
        {
          db,
          cacheNamespace: `bounds_${c.chunkCount}`,
          authorConfirmedProductionBulkWrite: c.chunkCount + c.expectedDocs >= 1200,
          durableCommitPolicy: {
            requireDurableCloudCommit: true,
            requireActiveGenerationVerification: true,
          },
        }
      );

      assert.equal(result.durableCommitVerified, true);
      assert.equal(result.activeGenerationVerified, true);

      const allPartDocs = [
        result.document,
        ...(result.additionalParts?.map((p) => p.document) || []),
      ];
      assert.equal(
        allPartDocs.length,
        c.expectedDocs,
        `chunkCount=${c.chunkCount} should produce ${c.expectedDocs} document part(s)`
      );
      const actualChunkTotal =
        result.chunks.length +
        (result.additionalParts?.reduce((acc, p) => acc + p.chunks.length, 0) ||
          0);
      assert.equal(actualChunkTotal, c.chunkCount);

      assert.equal(
        stats.batchCommits,
        c.expectedBatches,
        `chunkCount=${c.chunkCount} totalOps=${c.chunkCount + c.expectedDocs} should take ${c.expectedBatches} batch commit(s)`
      );
      for (const batchSize of stats.batchOpCounts) {
        assert.ok(
          batchSize <= 450,
          `Every Firestore batch commit must stay <= 450 ops (got ${batchSize})`
        );
      }

      const manifest = store.get(`${basePath}/ragManifest/control`)!;
      const entityStates = manifest.entityStates as Record<
        string,
        EntityIndexLifecycleState
      >;
      const mState =
        entityStates[`${ownerId}:${projectId}:EPISODE:${entityId}`];
      assert.equal(mState.activationMode, c.expectedMode);

      if (c.expectedMode === 'MANIFEST_POINTER') {
        assert.match(result.document.id, /__g1$/);
        const expectedLogicalPrimaryId =
          c.expectedDocs > 1
            ? `memdoc_${projectId}_EPISODE_${entityId}_part_1`
            : `memdoc_${projectId}_EPISODE_${entityId}`;
        assert.equal(
          result.document.id,
          buildGenerationScopedDocId(expectedLogicalPrimaryId, 1)
        );
        const stagingId = buildRagStagingReceiptId({
          projectId,
          sourceEntityType: 'EPISODE',
          sourceEntityId: entityId,
          generation: 1,
        });
        const receipt = store.get(
          `${basePath}/ragGenerationStaging/${stagingId}`
        ) as unknown as RagGenerationStagingReceipt;
        assert.equal(receipt.status, 'ACTIVATED');
        assert.equal(receipt.verifiedDocumentCount, c.expectedDocs);
        assert.equal(receipt.verifiedChunkCount, c.chunkCount);
      } else {
        assert.equal(
          result.document.id.includes('__g1'),
          false,
          'INLINE_DOC below 201 ops must keep legacy base document ID'
        );
      }
    }
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
    resetRagTestRuntime();
  }
});

test('Stage 2.5C Cases 2 & 3: Active gen stays intact during mid-batch Stage A failure and Stage B Manifest TX failure + clean retry', async () => {
  resetRagTestRuntime();
  const ownerId = 'author_s25c_atomicity';
  const projectId = 'proj_s25c_atomicity';
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  setCustomGeminiEmbedContentForTesting(async ({ contents, config }) => {
    const dim =
      typeof (config as { outputDimensionality?: number } | undefined)
        ?.outputDimensionality === 'number'
        ? (config as { outputDimensionality: number }).outputDimensionality
        : 768;
    return {
      embeddings: [
        { values: computeDeterministicSemanticEmbedding(contents, dim) },
      ],
    };
  });

  try {
    const { basePath, seed } = createSeededProjectDocs(ownerId, projectId);
    const entityId = 'rel_large_saga';

    // Step 1: Index healthy gen 1 with 500 chunks (> 450, 2 batches) -> becomes active generation 1
    const env1 = createStage25CMockFirestore(seed);
    const gen1Res = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'RELATIONSHIP',
        sourceEntityId: entityId,
        sourceRevisionId: 'rev_gen1',
        canonStatus: 'CANON',
        title: '대규모 관계 서사 v1',
        summary: '청룡검 서약 v1 요약',
        fullText: buildExactChunkFullText(
          500,
          'GEN1',
          'ACTIVE_GEN1_BLUE_SWORD_OATH'
        ),
        maxChunkLength: 120,
        embeddingDimension: 64,
      },
      {
        db: env1.db,
        cacheNamespace: 'atomicity_ns',
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    const gen1DocId = gen1Res.document.id;
    assert.ok(env1.store.has(`${basePath}/memoryDocuments/${gen1DocId}`));
    const gen1InitialSnap = structuredClone(
      env1.store.get(`${basePath}/memoryDocuments/${gen1DocId}`)!
    );

    // Clone store state into env2 where Stage A fails at batch commit #2 (after batch #1 wrote partial __g2 docs!)
    const clonedForStageAFail: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of env1.store.entries()) clonedForStageAFail[k] = v;
    const env2 = createStage25CMockFirestore(clonedForStageAFail, {
      failBatchAtAttempt: 2,
    });

    await assert.rejects(
      async () => {
        await indexMemoryInputOnServer(
          {
            ownerId,
            projectId,
            sourceEntityType: 'RELATIONSHIP',
            sourceEntityId: entityId,
            sourceRevisionId: 'rev_gen2_abort',
            canonStatus: 'CANON',
            title: '대규모 관계 서사 v2 (중단)',
            summary: '중단될 v2 요약',
            fullText: buildExactChunkFullText(
              500,
              'GEN2_ABORT',
              'BROKEN_GEN2_BLOOD_CURSE'
            ),
            maxChunkLength: 120,
            embeddingDimension: 64,
          },
          {
            db: env2.db,
            cacheNamespace: 'atomicity_ns',
            forceRebuild: true,
            durableCommitPolicy: {
              requireDurableCloudCommit: true,
              requireActiveGenerationVerification: true,
            },
          }
        );
      },
      (err: Error) => {
        assert.match(err.message, /\[FIRESTORE_BATCH_COMMIT_FAILED\]/);
        return true;
      }
    );

    // Active gen 1 document in Firestore is 100% untouched; Manifest still points to gen 1; Staging g2 is ABORTED
    assert.deepEqual(
      env2.store.get(`${basePath}/memoryDocuments/${gen1DocId}`),
      gen1InitialSnap
    );
    const manifestAfterStageAFail = env2.store.get(
      `${basePath}/ragManifest/control`
    )!;
    const mStatesAfterA = manifestAfterStageAFail.entityStates as Record<
      string,
      EntityIndexLifecycleState
    >;
    const entityStateAfterA =
      mStatesAfterA[`${ownerId}:${projectId}:RELATIONSHIP:${entityId}`];
    assert.equal(entityStateAfterA.activeGeneration, 1);
    assert.deepEqual(entityStateAfterA.activeDocumentIds, [gen1DocId]);

    const g2StagingId = buildRagStagingReceiptId({
      projectId,
      sourceEntityType: 'RELATIONSHIP',
      sourceEntityId: entityId,
      generation: 2,
    });
    const g2Receipt = env2.store.get(
      `${basePath}/ragGenerationStaging/${g2StagingId}`
    ) as unknown as RagGenerationStagingReceipt;
    assert.equal(g2Receipt.status, 'ABORTED');

    // Step 2 (Case 3): Stage A reaches VERIFIED, then Stage B Manifest TX fails on gen 3 -> active gen 1 stays intact, gen 3 becomes ABORTED, retry reserves gen 4 and succeeds!
    const clonedForStageBFail: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of env2.store.entries()) clonedForStageBFail[k] = v;
    const env3 = createStage25CMockFirestore(clonedForStageBFail, {
      failManifestTxCount: 1,
    });

    await assert.rejects(
      async () => {
        await indexMemoryInputOnServer(
          {
            ownerId,
            projectId,
            sourceEntityType: 'RELATIONSHIP',
            sourceEntityId: entityId,
            sourceRevisionId: 'rev_gen3_tx_fail',
            canonStatus: 'CANON',
            title: '대규모 관계 서사 v3 (TX 실패)',
            summary: 'Stage B TX 실패 요약',
            fullText: buildExactChunkFullText(
              500,
              'GEN3_TXFAIL',
              'UNCOMMITTED_GEN3_PHANTOM'
            ),
            maxChunkLength: 120,
            embeddingDimension: 64,
          },
          {
            db: env3.db,
            cacheNamespace: 'atomicity_ns',
            forceRebuild: true,
            durableCommitPolicy: {
              requireDurableCloudCommit: true,
              requireActiveGenerationVerification: true,
            },
          }
        );
      },
      (err: Error) => {
        assert.match(err.message, /\[FIRESTORE_MANIFEST_ACTIVATION_FAILED\]/);
        return true;
      }
    );

    const g3StagingId = buildRagStagingReceiptId({
      projectId,
      sourceEntityType: 'RELATIONSHIP',
      sourceEntityId: entityId,
      generation: 3,
    });
    const g3Receipt = env3.store.get(
      `${basePath}/ragGenerationStaging/${g3StagingId}`
    ) as unknown as RagGenerationStagingReceipt;
    assert.equal(g3Receipt.status, 'ABORTED');

    // Active search still finds ONLY GEN1 phrase and ZERO GEN2/GEN3 phrases!
    const searchDuringFailure = await searchProjectMemoryOnServer({
      ownerId,
      query: {
        projectId,
        queryText: 'ACTIVE_GEN1_BLUE_SWORD_OATH',
        topK: 5,
      },
      db: env3.db,
      cacheNamespace: 'atomicity_ns',
      preferDeterministicEmbeddings: true,
    });
    assert.ok(searchDuringFailure.hits.length > 0);
    assert.equal(searchDuringFailure.hits[0].document.indexGeneration, 1);

    const leakedGen3Search = await searchProjectMemoryOnServer({
      ownerId,
      query: {
        projectId,
        queryText: 'UNCOMMITTED_GEN3_PHANTOM',
        topK: 5,
      },
      db: env3.db,
      cacheNamespace: 'atomicity_ns',
      preferDeterministicEmbeddings: true,
    });
    assert.equal(
      leakedGen3Search.hits.filter((h) => h.document.indexGeneration === 3)
        .length,
      0
    );

    // Retry cleanly -> reserves generation 4 and switches atomically
    const gen4Res = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'RELATIONSHIP',
        sourceEntityId: entityId,
        sourceRevisionId: 'rev_gen4_ok',
        canonStatus: 'CANON',
        title: '대규모 관계 서사 v4 (성공)',
        summary: '복구 재시도 성공 요약',
        fullText: buildExactChunkFullText(
          500,
          'GEN4_FINAL',
          'COMMITTED_GEN4_SILVER_CROWN'
        ),
        maxChunkLength: 120,
        embeddingDimension: 64,
      },
      {
        db: env3.db,
        cacheNamespace: 'atomicity_ns',
        forceRebuild: true,
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    assert.equal(gen4Res.document.indexGeneration, 4);
    assert.equal(gen4Res.durableCommitVerified, true);
    assert.equal(gen4Res.activeGenerationVerified, true);

    const searchAfterGen4 = await searchProjectMemoryOnServer({
      ownerId,
      query: {
        projectId,
        queryText: 'COMMITTED_GEN4_SILVER_CROWN',
        topK: 5,
      },
      db: env3.db,
      cacheNamespace: 'atomicity_ns',
      preferDeterministicEmbeddings: true,
    });
    assert.ok(searchAfterGen4.hits.length > 0);
    assert.equal(searchAfterGen4.hits[0].document.indexGeneration, 4);
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
    resetRagTestRuntime();
  }
});

test('Stage 2.5C Cases 4 & 5: Mid-Stage-A concurrent search visibility isolation + concurrent reservation uniqueness + Lease Fencing & CANON freshness rejection', async () => {
  resetRagTestRuntime();
  const ownerId = 'author_s25c_conc';
  const projectId = 'proj_s25c_conc';
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  setCustomGeminiEmbedContentForTesting(async ({ contents, config }) => {
    const dim =
      typeof (config as { outputDimensionality?: number } | undefined)
        ?.outputDimensionality === 'number'
        ? (config as { outputDimensionality: number }).outputDimensionality
        : 768;
    return {
      embeddings: [
        { values: computeDeterministicSemanticEmbedding(contents, dim) },
      ],
    };
  });

  try {
    const { basePath, seed } = createSeededProjectDocs(ownerId, projectId);
    const entityId = 'rel_kairen_aria';
    seed[`${basePath}/relationships/${entityId}`] = {
      id: entityId,
      ownerId,
      projectId,
      sourceCharacterId: 'char_kairen',
      targetCharacterId: 'char_aria',
      relationshipType: 'ALLY',
      status: 'ACTIVE',
      summary: '초기 동맹 서약',
      details: buildExactChunkFullText(
        240,
        'REL_V1',
        'ALLY_V1_IRON_PROMISE'
      ),
      strength: 80,
      canonStatus: 'CANON',
      sourceRevisionId: 'rev_1',
      updatedAt: '2026-06-15T10:00:00.000Z',
    };
    seed[`${basePath}/changeProposals/prop_rel_v1`] = {
      id: 'prop_rel_v1',
      ownerId,
      projectId,
      targetEntityType: 'RELATIONSHIP',
      targetEntityId: entityId,
      proposedAction: 'CREATE',
      title: '동맹 생성',
      rationale: '초기 동맹',
      beforeSummary: '',
      afterSummary: '초기 동맹 서약',
      proposedPayloadJson: '{}',
      canonStatus: 'CANON',
      triggerEpisodeId: 'ep_1',
      sourceRevisionId: 'rev_1',
      createdBy: 'AI_ENGINE',
      createdAt: '2026-06-15T10:00:00.000Z',
      updatedAt: '2026-06-15T10:00:00.000Z',
    };

    const { db, store } = createStage25CMockFirestore(seed);

    // Index gen 1 (240 chunks -> large-scale MANIFEST_POINTER)
    const gen1Res = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'RELATIONSHIP',
        sourceEntityId: entityId,
        sourceRevisionId: 'rev_1',
        canonStatus: 'CANON',
        title: '카이렌 ↔ 아리아 v1',
        summary: '초기 동맹 서약',
        fullText: buildExactChunkFullText(
          240,
          'REL_V1',
          'ALLY_V1_IRON_PROMISE'
        ),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'conc_ns',
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    assert.equal(gen1Res.document.indexGeneration, 1);

    // Concurrent search during Stage A of gen 2 MUST see ONLY gen 1 (via both local search AND Firestore vector findNearest)!
    let midStageLocalHitsCount = -1;
    let midStageLocalGen1Only = false;
    let midStageVectorLeakCount = -1;

    const gen2Res = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'RELATIONSHIP',
        sourceEntityId: entityId,
        sourceRevisionId: 'rev_1_mid',
        canonStatus: 'CANON',
        title: '카이렌 ↔ 아리아 v2',
        summary: '스테이징 중 동시 검색 검증',
        fullText: buildExactChunkFullText(
          240,
          'REL_V2_MIDSTAGE',
          'MIDSTAGE_GEN2_HIDDEN_SECRET'
        ),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'conc_ns',
        forceRebuild: true,
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
        onDuringStagingHook: async ({ generation, largeScaleGenerationMode }) => {
          assert.equal(generation, 2);
          assert.equal(largeScaleGenerationMode, true);

          const localSearch = await searchProjectMemoryOnServer({
            ownerId,
            query: {
              projectId,
              queryText: 'ALLY_V1_IRON_PROMISE',
              topK: 5,
            },
            db,
            cacheNamespace: 'conc_ns',
            preferDeterministicEmbeddings: true,
          });
          midStageLocalHitsCount = localSearch.hits.length;
          midStageLocalGen1Only = localSearch.hits.every(
            (h) => h.document.indexGeneration === 1
          );

          const vecRes = await tryFirestoreVectorFindNearest({
            ownerId,
            projectId,
            queryEmbedding: computeDeterministicSemanticEmbedding(
              'MIDSTAGE_GEN2_HIDDEN_SECRET',
              64
            ),
            queryEmbeddingGenerationMode: 'LIVE_API',
            queryEmbeddingModelId: 'gemini-embedding-2',
            limit: 10,
            canonOnly: false,
            db,
          });
          midStageVectorLeakCount = vecRes.candidates.filter(
            (h) =>
              h.indexGeneration === 2 ||
              Boolean(
                h.chunkSnapshot?.content?.includes(
                  'MIDSTAGE_GEN2_HIDDEN_SECRET'
                )
              )
          ).length;
        },
      }
    );

    assert.ok(midStageLocalHitsCount > 0);
    assert.equal(midStageLocalGen1Only, true);
    assert.equal(
      midStageVectorLeakCount,
      0,
      'Stage A unactivated gen 2 chunks must NEVER leak into Firestore vector search!'
    );
    assert.equal(gen2Res.document.indexGeneration, 2);

    // Test Case 5a: Concurrent Worker A & Worker B reserve distinct monotonic generations (3 & 4)
    const [resA, resB] = await Promise.all([
      reserveRagGenerationOnServer(
        {
          ownerId,
          projectId,
          sourceEntityType: 'RELATIONSHIP',
          sourceEntityId: entityId,
          largeScaleGenerationMode: true,
          expectedDocumentCount: 1,
          expectedChunkCount: 220,
        },
        { db, cacheNamespace: 'conc_ns' }
      ),
      reserveRagGenerationOnServer(
        {
          ownerId,
          projectId,
          sourceEntityType: 'RELATIONSHIP',
          sourceEntityId: entityId,
          largeScaleGenerationMode: true,
          expectedDocumentCount: 1,
          expectedChunkCount: 220,
        },
        { db, cacheNamespace: 'conc_ns' }
      ),
    ]);
    assert.notEqual(resA.generation, resB.generation);
    assert.notEqual(resA.stagingId, resB.stagingId);
    assert.deepEqual(
      [resA.generation, resB.generation].sort((a, b) => a - b),
      [3, 4]
    );

    // Test Case 5b: CANON freshness mismatch ([SUPERSEDED_BY_NEWER_CANON]) + Lease Fencing ([LEASE_LOST]) during Stage B of large-scale indexing
    const taskId = computeDeterministicRagSyncTaskId('prop_rel_v1');
    const staleTask = {
      id: taskId,
      ownerId,
      projectId,
      proposalId: 'prop_rel_v1',
      auditId: 'audit_rel_v1',
      targetEntityType: 'RELATIONSHIP' as const,
      targetEntityId: entityId,
      expectedSourceRevisionId: 'rev_1',
      expectedEntityUpdatedAt: '2026-06-15T10:00:00.000Z',
      expectedContentHash: 'hash_v1',
      sourceRevisionId: 'rev_1',
      memoryDocumentId: '',
      status: 'PROCESSING' as const,
      attemptCount: 1,
      maxAttempts: 5,
      leaseOwner: 'worker_stale',
      leaseGeneration: 1,
      leaseExpiresAtMs: Date.now() + 60_000,
      nextRetryAfterMs: 0,
      lastError: '',
      createdAt: '2026-06-15T10:00:00.000Z',
      updatedAt: '2026-06-15T10:00:00.000Z',
    };
    store.set(`${basePath}/ragSyncTasks/${taskId}`, staleTask);

    // Mutate leaseGeneration to 2 BEFORE Stage B TX runs
    await assert.rejects(
      async () => {
        await indexMemoryInputOnServer(
          {
            ownerId,
            projectId,
            sourceEntityType: 'RELATIONSHIP',
            sourceEntityId: entityId,
            sourceRevisionId: 'rev_1',
            canonStatus: 'CANON',
            title: 'Lease 만료 워커',
            summary: 'Lease fencing',
            fullText: buildExactChunkFullText(210, 'LEASE_FAIL'),
            maxChunkLength: 100,
            embeddingDimension: 64,
          },
          {
            db,
            cacheNamespace: 'conc_ns',
            forceRebuild: true,
            durableCommitPolicy: {
              requireDurableCloudCommit: true,
              requireActiveGenerationVerification: true,
            },
            activationGuard: {
              leasedTask: staleTask,
              activationToken: 'tok_stale_1',
            },
            onDuringStagingHook: async () => {
              // Higher generation worker took over lease during Stage A!
              store.set(`${basePath}/ragSyncTasks/${taskId}`, {
                ...staleTask,
                leaseOwner: 'worker_newer',
                leaseGeneration: 2,
              });
            },
          }
        );
      },
      (err: Error) => {
        assert.match(err.message, /\[LEASE_LOST\]/);
        return true;
      }
    );

    // Restore leaseOwner/leaseGeneration=1, then advance CANON revision mid-Stage A -> [SUPERSEDED_BY_NEWER_CANON]
    store.set(`${basePath}/ragSyncTasks/${taskId}`, staleTask);
    await assert.rejects(
      async () => {
        await indexMemoryInputOnServer(
          {
            ownerId,
            projectId,
            sourceEntityType: 'RELATIONSHIP',
            sourceEntityId: entityId,
            sourceRevisionId: 'rev_1',
            canonStatus: 'CANON',
            title: 'CANON 변경 후 워커',
            summary: 'CANON freshness',
            fullText: buildExactChunkFullText(210, 'CANON_STALE'),
            maxChunkLength: 100,
            embeddingDimension: 64,
          },
          {
            db,
            cacheNamespace: 'conc_ns',
            forceRebuild: true,
            durableCommitPolicy: {
              requireDurableCloudCommit: true,
              requireActiveGenerationVerification: true,
            },
            activationGuard: {
              leasedTask: staleTask,
              activationToken: 'tok_stale_canon',
            },
            onDuringStagingHook: async () => {
              store.set(`${basePath}/relationships/${entityId}`, {
                ...store.get(`${basePath}/relationships/${entityId}`)!,
                sourceRevisionId: 'rev_2_newer',
              });
            },
          }
        );
      },
      (err: Error) => {
        assert.match(err.message, /\[SUPERSEDED_BY_NEWER_CANON\]/);
        return true;
      }
    );
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
    resetRagTestRuntime();
  }
});

test('Stage 2.5C Cases 6, 7, 8 & 9: Cold recovery, Manifest-pointer Firestore Vector Search, tenant isolation, cleanup & integrity diagnostics', async () => {
  resetRagTestRuntime();
  const ownerId = 'author_s25c_recov';
  const otherOwnerId = 'author_s25c_intruder';
  const projectId = 'proj_s25c_recov';
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  setCustomGeminiEmbedContentForTesting(async ({ contents, config }) => {
    const dim =
      typeof (config as { outputDimensionality?: number } | undefined)
        ?.outputDimensionality === 'number'
        ? (config as { outputDimensionality: number }).outputDimensionality
        : 768;
    return {
      embeddings: [
        { values: computeDeterministicSemanticEmbedding(contents, dim) },
      ],
    };
  });

  try {
    const { basePath, seed } = createSeededProjectDocs(ownerId, projectId);
    const largeEntityId = 'ep_large_recov';
    const smallEntityId = 'rel_small_coexist';

    const rawEpisodeText =
      '카이렌과 엘린은 북부 성채 천문대에서 세 번째 별의 일식이 시작되는 순간을 목격하였다.';
    const quoteText =
      '카이렌과 엘린은 북부 성채 천문대에서 세 번째 별의 일식이 시작되는 순간을 목격하였다.';
    const makeProv = () => ({
      sourceType: 'MANUSCRIPT',
      createdBy: 'AI_ENGINE',
      ownerId,
      projectId,
      episodeId: 'ep_1',
      sceneId: 'sc_1',
      revisionId: 'rev_ep_1',
      excerpt: quoteText,
      startOffset: 0,
      endOffset: rawEpisodeText.length,
    });
    seed[`${basePath}/episodes/ep_1`] = {
      id: 'ep_1',
      ownerId,
      projectId,
      episodeNumber: 1,
      title: '1화. 별의 일식',
      content: rawEpisodeText,
      sourceRevisionId: 'rev_ep_1',
      updatedAt: '2026-06-15T09:00:00.000Z',
    };
    seed[`${basePath}/scenes/sc_1`] = {
      id: 'sc_1',
      ownerId,
      projectId,
      episodeId: 'ep_1',
      sceneNumber: 1,
      title: '천문대의 관측',
      content: rawEpisodeText,
    };
    seed[`${basePath}/revisions/rev_ep_1`] = {
      id: 'rev_ep_1',
      ownerId,
      projectId,
      episodeId: 'ep_1',
      sceneId: 'sc_1',
      revisionNumber: 1,
      canonStatus: 'CANON',
      content: rawEpisodeText,
      createdAt: '2026-06-15T09:00:00.000Z',
      updatedAt: '2026-06-15T09:00:00.000Z',
    };

    const largeTimelineSummary = [
      '# E0\nCOEXIST_TIMELINE_STAR_ECLIPSE',
      ...Array.from({ length: 229 }, (_, idx) => `# E${idx + 1}\n${idx + 1}`),
    ].join('\n\n');
    const proposalLargeId = 'prop_large_recov';
    seed[`${basePath}/changeProposals/${proposalLargeId}`] = {
      id: proposalLargeId,
      ownerId,
      projectId,
      targetEntityType: 'TIMELINE_EVENT',
      targetEntityId: largeEntityId,
      proposedAction: 'CREATE',
      title: '대규모 연표 사건 색인',
      rationale: '혼합 공존 테스트',
      beforeSummary: '없음',
      afterSummary: '대규모 연표 사건 요약',
      canonStatus: 'PROPOSED',
      triggerEpisodeId: 'ep_1',
      triggerSceneId: 'sc_1',
      sourceRevisionId: 'rev_ep_1',
      createdBy: 'AI_ENGINE',
      reviewedAt: '',
      createdAt: '2026-06-15T10:00:00.000Z',
      updatedAt: '2026-06-15T10:00:00.000Z',
      proposedPayloadJson: JSON.stringify({
        schemaVersion: 'PHASE_4_2_1_V1',
        proposalId: proposalLargeId,
        fingerprint: `fp_${proposalLargeId}`,
        extractionRunId: `extrun_${proposalLargeId}`,
        targetEntityType: 'TIMELINE_EVENT',
        targetEntityId: largeEntityId,
        proposedAction: 'CREATE',
        sourceEpisodeId: 'ep_1',
        sourceSceneId: 'sc_1',
        sourceRevisionId: 'rev_ep_1',
        confidenceScore: 0.95,
        temporalContext: 'PRESENT_EVENT',
        uncertaintyFlags: [],
        canonConflicts: [],
        verifiedExcerpt: {
          excerpt: quoteText,
          matchedText: quoteText,
          startOffset: 0,
          endOffset: rawEpisodeText.length,
          matchMethod: 'EXACT',
          matchCount: 1,
        },
        provenance: makeProv(),
        timelineEventDraft: {
          id: largeEntityId,
          ownerId,
          projectId,
          title: '대규모 연표 사건 색인',
          summary: largeTimelineSummary,
          inUniverseDate: '제3월 일식일',
          chronologicalOrder: 10,
          episodeId: 'ep_1',
          sceneId: 'sc_1',
          participantCharacterIds: [],
          linkedForeshadowingIds: [],
          linkedWorldbuildingIds: [],
          canonStatus: 'PROPOSED',
          sourceRevisionId: 'rev_ep_1',
          createdBy: 'AI_ENGINE',
          provenance: makeProv(),
        },
        existingEntitySnapshot: null,
      }),
    };

    const { db, store } = createStage25CMockFirestore(seed);

    // Small legacy entity (<= 200 ops, INLINE_DOC)
    const smallRes = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'RELATIONSHIP',
        sourceEntityId: smallEntityId,
        sourceRevisionId: 'rev_small_1',
        canonStatus: 'CANON',
        title: '소규모 기존 관계',
        summary: '레거시 INLINE_DOC 관계',
        fullText: 'LEGACY_SMALL_INLINE_REL_TOKEN 카이렌과 엘린의 기존 신뢰 관계.',
        maxChunkLength: 300,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'recov_ns',
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    assert.equal(smallRes.document.activationMode, 'INLINE_DOC');

    // Approve proposal + executeRagSyncForApprovedProposalOnServer (> 200 ops -> MANIFEST_POINTER)!
    await approveChangeProposalOnServer(
      { projectId, proposalId: proposalLargeId },
      { db, verifiedOwnerId: ownerId, nowIso: '2026-06-15T10:01:00.000Z' }
    );
    const largeSyncRes = await executeRagSyncForApprovedProposalOnServer(
      { projectId, proposalId: proposalLargeId },
      {
        db,
        verifiedOwnerId: ownerId,
        nowIso: '2026-06-15T10:01:05.000Z',
        ragIndexingOptions: {
          cacheNamespace: 'recov_ns',
        },
      }
    );
    assert.equal(largeSyncRes.ok, true);
    assert.equal(largeSyncRes.ragSyncStatus, 'SYNCED');
    const approvedMemDoc = store.get(
      `${basePath}/memoryDocuments/${largeSyncRes.documentId}`
    )!;
    assert.equal(approvedMemDoc.activationMode, 'MANIFEST_POINTER');

    // Index large entity gen 1 -> gen 2 via indexMemoryInputOnServer while gen 1 docs/chunks STAY on disk/Firestore with isActiveGeneration: true, and inject an ABORTED gen 3 staging!
    const largeV2 = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ms_recov_target',
        sourceRevisionId: 'rev_ms_1',
        canonStatus: 'CANON',
        title: '장편 원고 v1',
        summary: '구버전 원고',
        fullText: buildExactChunkFullText(
          215,
          'MS_OLD_G1',
          'OLD_GEN1_SHADOW_OBELISK'
        ),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'recov_ns',
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );

    const largeV3Active = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: 'ms_recov_target',
        sourceRevisionId: 'rev_ms_2',
        canonStatus: 'CANON',
        title: '장편 원고 v2 (최신)',
        summary: '최신 활성 세대 원고',
        fullText: buildExactChunkFullText(
          215,
          'MS_NEW_G_ACTIVE',
          'LATEST_ACTIVE_CRYSTAL_CITADEL'
        ),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        db,
        cacheNamespace: 'recov_ns',
        forceRebuild: true,
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );

    // In MANIFEST_POINTER mode, Stage B never rewrites 200+ chunks, so newChunk naturally carries isActiveGeneration: false!
    // Even if an old superseded chunk had isActiveGeneration: true, authoritative Manifest filtering must exclude old gen and include new active gen!
    const oldChunkId = buildGenerationScopedChunkId(largeV2.document.id, 0);
    const oldChunk = store.get(`${basePath}/memoryChunks/${oldChunkId}`)!;
    store.set(`${basePath}/memoryChunks/${oldChunkId}`, {
      ...oldChunk,
      isActiveGeneration: true, // adversarial stale flag on superseded generation
    });

    const newGenNumber = largeV3Active.document.indexGeneration!;
    const newChunkId = buildGenerationScopedChunkId(
      largeV3Active.document.id,
      0
    );
    const newChunk = store.get(`${basePath}/memoryChunks/${newChunkId}`)!;
    assert.equal(newChunk.isActiveGeneration, false);
    assert.equal(newChunk.activationMode, 'MANIFEST_POINTER');

    // Inject an ABORTED future generation doc/chunk + staging receipt
    const abortedGen = newGenNumber + 1;
    const abortedDocId = buildGenerationScopedDocId(
      `memdoc_${projectId}_EPISODE_ms_recov_target`,
      abortedGen
    );
    const abortedStagingId = buildRagStagingReceiptId({
      projectId,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ms_recov_target',
      generation: abortedGen,
    });
    store.set(`${basePath}/ragGenerationStaging/${abortedStagingId}`, {
      id: abortedStagingId,
      ownerId,
      projectId,
      entityKey: `${ownerId}:${projectId}:EPISODE:ms_recov_target`,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ms_recov_target',
      generation: abortedGen,
      activationMode: 'MANIFEST_POINTER',
      status: 'ABORTED',
      expectedDocumentIds: [abortedDocId],
      expectedDocumentCount: 1,
      expectedChunkCount: 1,
      expectedContentHash: 'h_abort',
      expectedSourceRevisionId: 'rev_abort',
      stagedDocumentCount: 1,
      stagedChunkCount: 1,
      verifiedDocumentCount: 0,
      verifiedChunkCount: 0,
      batchesCommitted: 1,
      createdAt: '2026-06-15T10:02:00.000Z',
      updatedAt: '2026-06-15T10:02:00.000Z',
    });
    store.set(`${basePath}/memoryDocuments/${abortedDocId}`, {
      ...largeV3Active.document,
      id: abortedDocId,
      indexGeneration: abortedGen,
      isActiveGeneration: false,
      stagingId: abortedStagingId,
    });
    store.set(
      `${basePath}/memoryChunks/${buildGenerationScopedChunkId(abortedDocId, 0)}`,
      {
        ...newChunk,
        id: buildGenerationScopedChunkId(abortedDocId, 0),
        documentId: abortedDocId,
        indexGeneration: abortedGen,
        isActiveGeneration: false,
        stagingId: abortedStagingId,
        content: 'ABORTED_GHOST_SHOULD_NEVER_RETURN',
        originalText: 'ABORTED_GHOST_SHOULD_NEVER_RETURN',
      }
    );

    // Case 6: Wipe local disk cache -> cold restart recovery via Manifest pointer!
    clearLocalRagDiskCacheForTesting(ownerId, projectId, {
      cacheNamespace: 'recov_ns',
    });

    const recoveredNewSearch = await searchProjectMemoryOnServer({
      ownerId,
      query: {
        projectId,
        queryText: 'LATEST_ACTIVE_CRYSTAL_CITADEL',
        topK: 5,
      },
      db,
      cacheNamespace: 'recov_ns',
      preferDeterministicEmbeddings: true,
    });
    assert.ok(recoveredNewSearch.hits.length > 0);
    assert.ok(
      recoveredNewSearch.hits.every(
        (h) => h.document.indexGeneration === newGenNumber
      ),
      'Cold recovery must restore only Manifest-pointed active generation'
    );

    const recoveredOldLeak = await searchProjectMemoryOnServer({
      ownerId,
      query: {
        projectId,
        queryText: 'OLD_GEN1_SHADOW_OBELISK',
        topK: 5,
      },
      db,
      cacheNamespace: 'recov_ns',
      preferDeterministicEmbeddings: true,
    });
    assert.equal(recoveredOldLeak.hits.length, 0);

    const recoveredAbortedLeak = await searchProjectMemoryOnServer({
      ownerId,
      query: {
        projectId,
        queryText: 'ABORTED_GHOST_SHOULD_NEVER_RETURN',
        topK: 5,
      },
      db,
      cacheNamespace: 'recov_ns',
      preferDeterministicEmbeddings: true,
    });
    assert.equal(recoveredAbortedLeak.hits.length, 0);

    // Coexistence check: small INLINE_DOC entity is ALSO searchable after cold recovery!
    const smallCoexistSearch = await searchProjectMemoryOnServer({
      ownerId,
      query: {
        projectId,
        queryText: 'LEGACY_SMALL_INLINE_REL_TOKEN',
        topK: 5,
      },
      db,
      cacheNamespace: 'recov_ns',
      preferDeterministicEmbeddings: true,
    });
    assert.ok(smallCoexistSearch.hits.length > 0);

    // Case 7: Direct Firestore Vector Search (findNearest + over-fetch backfill + Manifest filter + tenant isolation)
    const vecResults = await tryFirestoreVectorFindNearest({
      ownerId,
      projectId,
      queryEmbedding: computeDeterministicSemanticEmbedding(
        'LATEST_ACTIVE_CRYSTAL_CITADEL',
        64
      ),
      queryEmbeddingGenerationMode: 'LIVE_API',
      queryEmbeddingModelId: 'gemini-embedding-2',
      limit: 5,
      canonOnly: false,
      db,
    });
    assert.ok(vecResults.candidates.length > 0);
    assert.ok(
      vecResults.candidates.every(
        (r) => r.ownerId === ownerId && r.projectId === projectId
      )
    );
    assert.equal(
      vecResults.candidates.some(
        (r) => r.indexGeneration === largeV2.document.indexGeneration
      ),
      false,
      'Vector search must reject superseded old gen even if physical chunk still had isActiveGeneration: true'
    );
    assert.equal(
      vecResults.candidates.some((r) => r.indexGeneration === abortedGen),
      false,
      'Vector search must reject ABORTED generation chunks'
    );

    // Intruder / wrong owner cannot query owner's vector data!
    const intruderVec = await tryFirestoreVectorFindNearest({
      ownerId: otherOwnerId,
      projectId,
      queryEmbedding: computeDeterministicSemanticEmbedding(
        'LATEST_ACTIVE_CRYSTAL_CITADEL',
        64
      ),
      queryEmbeddingGenerationMode: 'LIVE_API',
      queryEmbeddingModelId: 'gemini-embedding-2',
      limit: 5,
      canonOnly: false,
      db,
    });
    assert.equal(intruderVec.candidates.length, 0);

    // Also add an ACTIVE IN-FLIGHT staging receipt (< 15 min) for another gen so cleanup MUST skip it!
    const inFlightGen = abortedGen + 1;
    const inFlightStagingId = buildRagStagingReceiptId({
      projectId,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ms_other_live',
      generation: inFlightGen,
    });
    store.set(`${basePath}/ragGenerationStaging/${inFlightStagingId}`, {
      id: inFlightStagingId,
      ownerId,
      projectId,
      entityKey: `${ownerId}:${projectId}:EPISODE:ms_other_live`,
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ms_other_live',
      generation: inFlightGen,
      activationMode: 'MANIFEST_POINTER',
      status: 'STAGED',
      expectedDocumentIds: [],
      expectedDocumentCount: 1,
      expectedChunkCount: 5,
      expectedContentHash: 'h_live',
      expectedSourceRevisionId: 'rev_live',
      stagedDocumentCount: 1,
      stagedChunkCount: 5,
      verifiedDocumentCount: 0,
      verifiedChunkCount: 0,
      batchesCommitted: 1,
      createdAt: '2026-06-15T10:04:00.000Z',
      updatedAt: '2026-06-15T10:04:00.000Z',
    });

    // Case 9: Integrity diagnostics detects STATE_F_INACTIVE_STAGED_DOCUMENTS_REMAINING and safely auto-recovers!
    const diagBefore = await diagnoseAndRecoverProjectRagIntegrityOnServer(
      { projectId, autoRecover: false },
      { db, verifiedOwnerId: ownerId, nowIso: '2026-06-15T10:05:00.000Z' }
    );
    assert.ok(
      diagBefore.anomalies.some(
        (a) => a.code === 'STATE_F_INACTIVE_STAGED_DOCUMENTS_REMAINING'
      )
    );
    assert.equal(
      diagBefore.anomalies.some(
        (a) => a.code === 'SYNCED_TASK_MISSING_MEMORY_DOCUMENT'
      ),
      false,
      'Valid large-scale MANIFEST_POINTER approved proposal task must NOT trigger false SYNCED_TASK_MISSING_MEMORY_DOCUMENT'
    );

    const diagRecovered = await diagnoseAndRecoverProjectRagIntegrityOnServer(
      { projectId, autoRecover: true },
      { db, verifiedOwnerId: ownerId, nowIso: '2026-06-15T10:05:10.000Z' }
    );
    const cleanedItem = diagRecovered.anomalies.find(
      (a) => a.code === 'STATE_F_INACTIVE_STAGED_DOCUMENTS_REMAINING'
    )!;
    assert.equal(cleanedItem.recovered, true);

    // Active docs (small + large proposal + largeV3Active) AND in-flight STAGED receipt remain completely intact!
    assert.ok(store.has(`${basePath}/memoryDocuments/${smallRes.document.id}`));
    assert.ok(store.has(`${basePath}/memoryDocuments/${largeV3Active.document.id}`));
    assert.ok(
      store.has(`${basePath}/ragGenerationStaging/${inFlightStagingId}`),
      'Concurrent worker in-flight staging receipt must NOT be deleted by cleanup'
    );
    // Aborted & old superseded docs/chunks & aborted staging receipt ARE purged!
    assert.equal(store.has(`${basePath}/memoryDocuments/${abortedDocId}`), false);
    assert.equal(store.has(`${basePath}/memoryDocuments/${largeV2.document.id}`), false);
    assert.equal(
      store.has(`${basePath}/ragGenerationStaging/${abortedStagingId}`),
      false
    );
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
    resetRagTestRuntime();
  }
});

test('Stage 2.5C MockBackend Parity: InMemoryMockFirestoreRagBackend isolates Stage A, checks over-fetch vector search & cleans up inactive generations', async () => {
  resetRagTestRuntime();
  const ownerId = 'author_s25c_mock_parity';
  const projectId = 'proj_s25c_mock_parity';
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  const mockBackend = new InMemoryMockFirestoreRagBackend();
  const basePath = `users/${ownerId}/projects/${projectId}`;
  mockBackend.documentsByPath.set(basePath, { id: projectId, ownerId });
  setMockFirestoreRagBackendForTesting(mockBackend);

  setCustomGeminiEmbedContentForTesting(async ({ contents, config }) => {
    const dim =
      typeof (config as { outputDimensionality?: number } | undefined)
        ?.outputDimensionality === 'number'
        ? (config as { outputDimensionality: number }).outputDimensionality
        : 768;
    return {
      embeddings: [
        { values: computeDeterministicSemanticEmbedding(contents, dim) },
      ],
    };
  });

  try {
    const g1 = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'RELATIONSHIP',
        sourceEntityId: 'rel_mock_large',
        sourceRevisionId: 'rev_1',
        canonStatus: 'CANON',
        title: 'Mock 백엔드 대량 색인 g1',
        summary: 'Mock g1',
        fullText: buildExactChunkFullText(210, 'MOCK_G1', 'MOCK_V1_ANCHOR'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        cacheNamespace: 'mock_parity_ns',
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    assert.equal(g1.document.indexGeneration, 1);

    // Stage g2 with simulated mid-batch failure -> g1 must remain active!
    mockBackend.simulateBatchFailureAtBatchNumber = 1;
    await assert.rejects(
      async () => {
        await indexMemoryInputOnServer(
          {
            ownerId,
            projectId,
            sourceEntityType: 'RELATIONSHIP',
            sourceEntityId: 'rel_mock_large',
            sourceRevisionId: 'rev_2_fail',
            canonStatus: 'CANON',
            title: 'Mock 백엔드 g2 실패',
            summary: 'Mock g2 fail',
            fullText: buildExactChunkFullText(210, 'MOCK_G2', 'MOCK_V2_FAIL'),
            maxChunkLength: 100,
            embeddingDimension: 64,
          },
          {
            cacheNamespace: 'mock_parity_ns',
            forceRebuild: true,
            durableCommitPolicy: {
              requireDurableCloudCommit: true,
              requireActiveGenerationVerification: true,
            },
          }
        );
      },
      /\[FIRESTORE_BATCH_COMMIT_FAILED\]/
    );
    mockBackend.simulateBatchFailureAtBatchNumber = null;

    // g3 succeeds cleanly
    const g3 = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'RELATIONSHIP',
        sourceEntityId: 'rel_mock_large',
        sourceRevisionId: 'rev_3',
        canonStatus: 'CANON',
        title: 'Mock 백엔드 g3 성공',
        summary: 'Mock g3 ok',
        fullText: buildExactChunkFullText(210, 'MOCK_G3', 'MOCK_V3_FINAL'),
        maxChunkLength: 100,
        embeddingDimension: 64,
      },
      {
        cacheNamespace: 'mock_parity_ns',
        forceRebuild: true,
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    assert.equal(g3.document.indexGeneration, 3);

    const cleanupRes = await cleanupInactiveRagGenerationsOnServer({
      ownerId,
      projectId,
    });
    assert.ok(cleanupRes.deletedDocs >= 1);
    assert.ok(cleanupRes.deletedChunks >= 210);
    assert.ok(cleanupRes.skippedActiveCount >= 1);
    assert.ok(
      mockBackend.documentsByPath.has(
        `${basePath}/memoryDocuments/${g3.document.id}`
      )
    );
  } finally {
    setMockFirestoreRagBackendForTesting(null);
    setCustomGeminiEmbedContentForTesting(null);
    resetRagTestRuntime();
  }
});
