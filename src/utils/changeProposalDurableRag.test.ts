import test from 'node:test';
import assert from 'node:assert/strict';
import type { Firestore } from 'firebase-admin/firestore';
import {
  approveChangeProposalOnServer,
  diagnoseAndRecoverProjectRagIntegrityOnServer,
  executeRagSyncForApprovedProposalOnServer,
} from '../server/changeProposalApprovalEngine.ts';
import {
  clearEmbeddingCacheForTesting,
  InMemoryMockFirestoreRagBackend,
  indexMemoryInputOnServer,
  searchProjectMemoryOnServer,
  setCustomGeminiEmbedContentForTesting,
  setMockFirestoreRagBackendForTesting,
  simulateServerRestartForTesting,
} from '../server/ragEngine.ts';
import {
  registerIsolatedMockFirestoreForTest,
  registerProjectOwnerForAdminCheck,
} from '../server/authMiddleware.ts';
import {
  computeDeterministicSemanticEmbedding,
  type EntityIndexLifecycleState,
} from '../services/memorySearchProvider.ts';
import { computeDeterministicRagSyncTaskId } from '../utils/changeProposalApprovalLogic.ts';

function clearServerRagCachesForTesting(): void {
  clearEmbeddingCacheForTesting();
  simulateServerRestartForTesting();
}

interface AdvancedMockFirestoreOptions {
  failBatchCommitCount?: number;
  failManifestTxCount?: number;
  onBeforeManifestTxRead?: (attempt: number) => Promise<void> | void;
  corruptDocAfterManifestTx?: (docId: string) => void;
}

function createAdvancedTransactionalMockFirestore(
  initialDocs: Record<string, Record<string, unknown>> = {},
  hooks: AdvancedMockFirestoreOptions = {}
): {
  db: Firestore;
  store: Map<string, Record<string, unknown>>;
  stats: {
    txAttempts: number;
    batchCommits: number;
    manifestTxRuns: number;
  };
} {
  const store = new Map<string, Record<string, unknown>>();
  for (const [k, v] of Object.entries(initialDocs)) {
    store.set(k.replace(/^\/+/, ''), structuredClone(v));
  }

  let txQueue = Promise.resolve();
  let remainingBatchFailures = hooks.failBatchCommitCount || 0;
  let remainingManifestTxFailures = hooks.failManifestTxCount || 0;
  const stats = {
    txAttempts: 0,
    batchCommits: 0,
    manifestTxRuns: 0,
  };

  const makeDocRef = (rawPath: string) => {
    const cleanPath = rawPath.replace(/^\/+/, '');
    const segments = cleanPath.split('/');
    const id = segments[segments.length - 1] || '';
    return {
      id,
      path: cleanPath,
      async get() {
        const current = store.get(cleanPath);
        return {
          id,
          exists: Boolean(current),
          data: () => (current ? structuredClone(current) : undefined),
        };
      },
      async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
        const existing = store.get(cleanPath) || {};
        store.set(
          cleanPath,
          opts?.merge
            ? { ...structuredClone(existing), ...structuredClone(data) }
            : structuredClone(data)
        );
      },
      async delete() {
        store.delete(cleanPath);
      },
    };
  };

  const makeCollectionRef = (rawCollectionPath: string) => {
    const cleanCol = rawCollectionPath.replace(/^\/+|\/+$/g, '');
    const buildQuery = (
      filters: Array<{ field: string; op: string; val: unknown }>
    ) => ({
      where(field: string, op: string, val: unknown) {
        return buildQuery([...filters, { field, op, val }]);
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
              const id = rest;
              const cloned = { ...structuredClone(v), vectorDistance: 0.08 };
              docs.push({
                id,
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
          const id = rest;
          docs.push({
            id,
            ref: makeDocRef(k),
            exists: true,
            data: () => structuredClone(v),
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
    collection(rawCollectionPath: string) {
      return makeCollectionRef(rawCollectionPath);
    },
    async getAll(...refs: Array<{ path: string; id: string }>) {
      return Promise.all(
        refs.map(async (r) => {
          const current = store.get(r.path);
          return {
            id: r.id,
            exists: Boolean(current),
            data: () => (current ? structuredClone(current) : undefined),
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
                ? { ...structuredClone(existing), ...structuredClone(data) }
                : structuredClone(data)
            );
          });
        },
        delete(ref: { path: string }) {
          stagedOps.push(() => {
            store.delete(ref.path);
          });
        },
        async commit() {
          stats.batchCommits += 1;
          if (remainingBatchFailures > 0) {
            remainingBatchFailures -= 1;
            throw new Error(
              'UNAVAILABLE: Simulated Firestore batch.commit network failure'
            );
          }
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
        const stagedWrites: Array<() => void> = [];

        const txObj = {
          async get(ref: { path: string; id: string }) {
            if (writeStarted) {
              throw new Error(
                'Firestore transactions require all reads to be executed before all writes.'
              );
            }
            if (ref.path.endsWith('/ragManifest/control')) {
              touchedManifest = true;
              stats.manifestTxRuns += 1;
              if (hooks.onBeforeManifestTxRead) {
                await hooks.onBeforeManifestTxRead(stats.manifestTxRuns);
                // Refresh workingStore after external concurrent mutation hook!
                workingStore.clear();
                for (const [k, v] of store.entries()) {
                  workingStore.set(k, structuredClone(v));
                }
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
            }
            stagedWrites.push(() => {
              const existing = workingStore.get(ref.path) || {};
              workingStore.set(
                ref.path,
                opts?.merge
                  ? { ...structuredClone(existing), ...structuredClone(data) }
                  : structuredClone(data)
              );
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
        if (touchedManifest && remainingManifestTxFailures > 0) {
          remainingManifestTxFailures -= 1;
          throw new Error(
            'ABORTED: Simulated ragManifest/control transaction commit conflict'
          );
        }
        for (const op of stagedWrites) {
          op();
        }
        store.clear();
        for (const [k, v] of workingStore.entries()) {
          store.set(k, structuredClone(v));
        }
        if (touchedManifest && hooks.corruptDocAfterManifestTx) {
          for (const k of store.keys()) {
            if (k.includes('/memoryDocuments/')) {
              hooks.corruptDocAfterManifestTx(k);
            }
          }
        }
        return result;
      };

      if (hooks.onBeforeManifestTxRead) {
        return executeAttempt();
      }
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
    projectId: 'test-stage25b-phase422',
    databaseId: 'test-db-stage25b',
    runId: `run_stage25b_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  });

  return {
    db: typedDb,
    store,
    stats,
  };
}

function buildMultiEntityApprovalSeed(params: {
  ownerId: string;
  projectId: string;
}) {
  const { ownerId, projectId } = params;
  const basePath = `users/${ownerId}/projects/${projectId}`;
  const rawText =
    '카이렌은 왕국 수호 기사단장 리아나와 북부 성채에서 비밀 방위 맹약을 맺었다. 같은 날 성채 지하 봉인석에서 붉은 균열이 처음 관측되었다.';
  const quote1 =
    '카이렌은 왕국 수호 기사단장 리아나와 북부 성채에서 비밀 방위 맹약을 맺었다.';
  const start1 = rawText.indexOf(quote1);
  const end1 = start1 + quote1.length;

  const quote2 = '같은 날 성채 지하 봉인석에서 붉은 균열이 처음 관측되었다.';
  const start2 = rawText.indexOf(quote2);
  const end2 = start2 + quote2.length;

  const relProposalId = 'prop_rel_v1';
  const evtProposalId = 'prop_evt_v1';
  const fshProposalId = 'prop_fsh_v1';

  const makeProvenance = (q: string, s: number, e: number, revId = 'rev_ep_1') => ({
    sourceType: 'MANUSCRIPT',
    createdBy: 'AI_ENGINE',
    ownerId,
    projectId,
    episodeId: 'ep_1',
    sceneId: 'sc_1',
    revisionId: revId,
    excerpt: q,
    startOffset: s,
    endOffset: e,
  });

  const seed: Record<string, Record<string, unknown>> = {
    [basePath]: {
      id: projectId,
      ownerId,
      title: '심연의 연대기 2.5B',
    },
    [`${basePath}/episodes/ep_1`]: {
      id: 'ep_1',
      ownerId,
      projectId,
      episodeNumber: 1,
      title: '1화. 북부 성채의 맹약',
      content: rawText,
      sourceRevisionId: 'rev_ep_1',
      updatedAt: '2026-06-10T09:00:00.000Z',
    },
    [`${basePath}/scenes/sc_1`]: {
      id: 'sc_1',
      ownerId,
      projectId,
      episodeId: 'ep_1',
      sceneNumber: 1,
      title: '지하 봉인석의 회합',
      content: rawText,
    },
    [`${basePath}/revisions/rev_ep_1`]: {
      id: 'rev_ep_1',
      ownerId,
      projectId,
      episodeId: 'ep_1',
      sceneId: 'sc_1',
      revisionNumber: 1,
      canonStatus: 'CANON',
      content: rawText,
      createdAt: '2026-06-10T09:00:00.000Z',
      updatedAt: '2026-06-10T09:00:00.000Z',
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
    [`${basePath}/changeProposals/${relProposalId}`]: {
      id: relProposalId,
      ownerId,
      projectId,
      targetEntityType: 'RELATIONSHIP',
      targetEntityId: 'rel_kairen_liana',
      proposedAction: 'CREATE',
      title: '카이렌-리아나 비밀 방위 맹약 관계 생성',
      rationale: '1화 원고에서 두 인물의 비밀 방위 맹약이 성립됨',
      beforeSummary: '없음',
      afterSummary: '카이렌 ↔ 리아나: 비밀 방위 맹약 동맹 (신뢰도 +70)',
      canonStatus: 'PROPOSED',
      triggerEpisodeId: 'ep_1',
      triggerSceneId: 'sc_1',
      sourceRevisionId: 'rev_ep_1',
      createdBy: 'AI_ENGINE',
      reviewedAt: '',
      createdAt: '2026-06-10T09:05:00.000Z',
      updatedAt: '2026-06-10T09:05:00.000Z',
      proposedPayloadJson: JSON.stringify({
        schemaVersion: 'PHASE_4_2_1_V1',
        proposalId: relProposalId,
        fingerprint: `fp_${relProposalId}`,
        extractionRunId: `extrun_${relProposalId}`,
        targetEntityType: 'RELATIONSHIP',
        targetEntityId: 'rel_kairen_liana',
        proposedAction: 'CREATE',
        sourceEpisodeId: 'ep_1',
        sourceSceneId: 'sc_1',
        sourceRevisionId: 'rev_ep_1',
        confidenceScore: 0.96,
        temporalContext: 'PRESENT_EVENT',
        uncertaintyFlags: [],
        canonConflicts: [],
        verifiedExcerpt: {
          excerpt: quote1,
          matchedText: quote1,
          startOffset: start1,
          endOffset: end1,
          matchMethod: 'EXACT',
          matchCount: 1,
        },
        provenance: makeProvenance(quote1, start1, end1),
        relationshipDraft: {
          id: 'rel_kairen_liana',
          ownerId,
          projectId,
          sourceCharacterId: 'char_kairen',
          sourceCharacterName: '카이렌',
          targetCharacterId: 'char_liana',
          targetCharacterName: '리아나',
          relationType: '비밀 방위 맹약 동맹',
          affinityScore: 70,
          isDirectional: false,
          description: '북부 성채 방위를 위해 비밀리에 결성한 전략 동맹',
          effectiveEpisodeId: 'ep_1',
          effectiveEventId: '',
          canonStatus: 'PROPOSED',
          sourceRevisionId: 'rev_ep_1',
          createdBy: 'AI_ENGINE',
          provenance: makeProvenance(quote1, start1, end1),
        },
        existingEntitySnapshot: null,
      }),
    },
    [`${basePath}/changeProposals/${evtProposalId}`]: {
      id: evtProposalId,
      ownerId,
      projectId,
      targetEntityType: 'TIMELINE_EVENT',
      targetEntityId: 'evt_northern_pact',
      proposedAction: 'CREATE',
      title: '북부 성채 비밀 맹약 체결 사건 추가',
      rationale: '1화 핵심 사건 기록',
      beforeSummary: '없음',
      afterSummary: '제국력 412년 겨울: 북부 성채 비밀 방위 맹약 체결',
      canonStatus: 'PROPOSED',
      triggerEpisodeId: 'ep_1',
      triggerSceneId: 'sc_1',
      sourceRevisionId: 'rev_ep_1',
      createdBy: 'AI_ENGINE',
      reviewedAt: '',
      createdAt: '2026-06-10T09:06:00.000Z',
      updatedAt: '2026-06-10T09:06:00.000Z',
      proposedPayloadJson: JSON.stringify({
        schemaVersion: 'PHASE_4_2_1_V1',
        proposalId: evtProposalId,
        fingerprint: `fp_${evtProposalId}`,
        extractionRunId: `extrun_${evtProposalId}`,
        targetEntityType: 'TIMELINE_EVENT',
        targetEntityId: 'evt_northern_pact',
        proposedAction: 'CREATE',
        sourceEpisodeId: 'ep_1',
        sourceSceneId: 'sc_1',
        sourceRevisionId: 'rev_ep_1',
        confidenceScore: 0.94,
        temporalContext: 'PRESENT_EVENT',
        uncertaintyFlags: [],
        canonConflicts: [],
        verifiedExcerpt: {
          excerpt: quote1,
          matchedText: quote1,
          startOffset: start1,
          endOffset: end1,
          matchMethod: 'EXACT',
          matchCount: 1,
        },
        provenance: makeProvenance(quote1, start1, end1),
        timelineEventDraft: {
          id: 'evt_northern_pact',
          ownerId,
          projectId,
          title: '북부 성채 비밀 방위 맹약 체결',
          summary:
            '카이렌과 리아나가 북부 성채 지하 회합실에서 비밀 방위 맹약을 체결함',
          inUniverseDate: '제국력 412년 동지',
          chronologicalOrder: 10,
          episodeId: 'ep_1',
          sceneId: 'sc_1',
          participantCharacterIds: ['char_kairen', 'char_liana'],
          linkedForeshadowingIds: [],
          linkedWorldbuildingIds: [],
          canonStatus: 'PROPOSED',
          sourceRevisionId: 'rev_ep_1',
          createdBy: 'AI_ENGINE',
          provenance: makeProvenance(quote1, start1, end1),
        },
        existingEntitySnapshot: null,
      }),
    },
    [`${basePath}/changeProposals/${fshProposalId}`]: {
      id: fshProposalId,
      ownerId,
      projectId,
      targetEntityType: 'FORESHADOWING',
      targetEntityId: 'fsh_crimson_seal_crack',
      proposedAction: 'CREATE',
      title: '지하 봉인석의 붉은 균열 복선 심기',
      rationale: '향후 심연 침식 전개 핵심 복선',
      beforeSummary: '없음',
      afterSummary: '봉인석의 붉은 균열 (PLANTED)',
      canonStatus: 'PROPOSED',
      triggerEpisodeId: 'ep_1',
      triggerSceneId: 'sc_1',
      sourceRevisionId: 'rev_ep_1',
      createdBy: 'AI_ENGINE',
      reviewedAt: '',
      createdAt: '2026-06-10T09:07:00.000Z',
      updatedAt: '2026-06-10T09:07:00.000Z',
      proposedPayloadJson: JSON.stringify({
        schemaVersion: 'PHASE_4_2_1_V1',
        proposalId: fshProposalId,
        fingerprint: `fp_${fshProposalId}`,
        extractionRunId: `extrun_${fshProposalId}`,
        targetEntityType: 'FORESHADOWING',
        targetEntityId: 'fsh_crimson_seal_crack',
        proposedAction: 'CREATE',
        sourceEpisodeId: 'ep_1',
        sourceSceneId: 'sc_1',
        sourceRevisionId: 'rev_ep_1',
        confidenceScore: 0.93,
        temporalContext: 'PRESENT_EVENT',
        uncertaintyFlags: [],
        canonConflicts: [],
        verifiedExcerpt: {
          excerpt: quote2,
          matchedText: quote2,
          startOffset: start2,
          endOffset: end2,
          matchMethod: 'EXACT',
          matchCount: 1,
        },
        provenance: makeProvenance(quote2, start2, end2),
        foreshadowingDraft: {
          id: 'fsh_crimson_seal_crack',
          ownerId,
          projectId,
          title: '지하 봉인석의 붉은 균열',
          description:
            '북부 성채 지하 고대 봉인석 표면에서 미세한 붉은 마력 균열이 관측됨',
          cluePhase: 'PLANTED',
          plantedEpisodeId: 'ep_1',
          plantedSceneId: 'sc_1',
          resolvedEpisodeId: '',
          resolvedSceneId: '',
          relatedEventIds: [],
          relatedCharacterIds: ['char_kairen', 'char_liana'],
          payoffNote: '3부 성채 공방전에서 봉인 붕괴의 전조로 회수 예정',
          canonStatus: 'PROPOSED',
          sourceRevisionId: 'rev_ep_1',
          createdBy: 'AI_ENGINE',
          provenance: makeProvenance(quote2, start2, end2),
        },
        existingEntitySnapshot: null,
      }),
    },
  };

  return {
    basePath,
    relProposalId,
    evtProposalId,
    fshProposalId,
    seed,
  };
}

test('Stage 2.5B Scenario A & Section 10: Normal durable indexing & long-term memory search across RELATIONSHIP, TIMELINE_EVENT, FORESHADOWING, and CANON v1 -> v2 freshness', async () => {
  clearServerRagCachesForTesting();
  const ownerId = 'author_s25b_scen_a';
  const projectId = 'proj_s25b_scen_a';
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  const { basePath, relProposalId, evtProposalId, fshProposalId, seed } =
    buildMultiEntityApprovalSeed({ ownerId, projectId });
  const { db, store } = createAdvancedTransactionalMockFirestore(seed);

  setCustomGeminiEmbedContentForTesting(async ({ contents }) => ({
    embeddings: [{ values: computeDeterministicSemanticEmbedding(contents, 768) }],
  }));

  try {
    // 1. Approve & durably index RELATIONSHIP, TIMELINE_EVENT, FORESHADOWING
    for (const pid of [relProposalId, evtProposalId, fshProposalId]) {
      const appRes = await approveChangeProposalOnServer(
        { projectId, proposalId: pid },
        { db, verifiedOwnerId: ownerId, nowIso: '2026-06-10T10:00:00.000Z' }
      );
      assert.equal(appRes.ok, true);
      assert.equal(appRes.ragSyncStatus, 'PENDING');

      const syncRes = await executeRagSyncForApprovedProposalOnServer(
        { projectId, proposalId: pid },
        { db, verifiedOwnerId: ownerId, nowIso: '2026-06-10T10:00:05.000Z' }
      );
      assert.equal(syncRes.ok, true, `syncRes failed for ${pid}: ${JSON.stringify(syncRes)}`);
      assert.equal(syncRes.ragSyncStatus, 'SYNCED');
      assert.equal(syncRes.taskStatus, 'SYNCED');
      assert.ok((syncRes.documentId || '').startsWith('memdoc_'));
    }

    // 2. Verify Firestore MemoryDocument, MemoryChunk, and ragManifest/control durable state
    const manifestDoc = store.get(`${basePath}/ragManifest/control`);
    assert.ok(manifestDoc, 'ragManifest/control must be durably written');
    const entityStates = manifestDoc.entityStates as Record<
      string,
      EntityIndexLifecycleState
    >;

    const relEntityKey = `${ownerId}:${projectId}:RELATIONSHIP:rel_kairen_liana`;
    assert.equal(entityStates[relEntityKey]?.lifecycleStatus, 'ACTIVE');
    assert.equal(entityStates[relEntityKey]?.activeGeneration, 1);
    assert.equal(entityStates[relEntityKey]?.activeSourceRevisionId, 'rev_ep_1');
    assert.equal(entityStates[relEntityKey]?.activeLeaseGeneration, 1);

    const relMemDocId = `memdoc_${projectId}_RELATIONSHIP_rel_kairen_liana`;
    const relMemDoc = store.get(`${basePath}/memoryDocuments/${relMemDocId}`);
    assert.ok(relMemDoc, 'MemoryDocument for RELATIONSHIP must exist in Firestore');
    assert.equal(relMemDoc.indexStatus, 'INDEXED');
    assert.equal(relMemDoc.isActiveGeneration, true);
    assert.equal(relMemDoc.indexGeneration, 1);

    // 3. Long-Term Memory Search Verification across all 3 entity types (Section 10)
    const relSearch = await searchProjectMemoryOnServer({
      ownerId,
      query: {
        projectId,
        queryText: '카이렌 리아나 비밀 방위 맹약 동맹',
        searchMode: 'HYBRID',
        canonOnly: true,
        sourceEntityTypes: ['RELATIONSHIP'],
      },
      db,
    });
    assert.ok(relSearch.hits.length >= 1, 'RELATIONSHIP must be searchable');
    assert.equal(relSearch.hits[0].document.canonStatus, 'CANON');
    assert.equal(
      relSearch.hits[0].document.sourceEntityType,
      'RELATIONSHIP'
    );
    assert.equal(
      relSearch.hits[0].document.sourceEntityId,
      'rel_kairen_liana'
    );

    const evtSearch = await searchProjectMemoryOnServer({
      ownerId,
      query: {
        projectId,
        queryText: '제국력 412년 동지 북부 성채 비밀 방위 맹약 체결',
        searchMode: 'HYBRID',
        canonOnly: true,
        sourceEntityTypes: ['TIMELINE_EVENT'],
      },
      db,
    });
    assert.ok(evtSearch.hits.length >= 1, 'TIMELINE_EVENT must be searchable');
    assert.equal(evtSearch.hits[0].document.canonStatus, 'CANON');
    assert.equal(
      evtSearch.hits[0].document.sourceEntityId,
      'evt_northern_pact'
    );

    const fshSearch = await searchProjectMemoryOnServer({
      ownerId,
      query: {
        projectId,
        queryText: '지하 봉인석의 붉은 균열',
        searchMode: 'HYBRID',
        canonOnly: true,
        sourceEntityTypes: ['FORESHADOWING'],
      },
      db,
    });
    assert.ok(fshSearch.hits.length >= 1, 'FORESHADOWING must be searchable');
    assert.equal(fshSearch.hits[0].document.canonStatus, 'CANON');
    assert.equal(
      fshSearch.hits[0].document.sourceEntityId,
      'fsh_crimson_seal_crack'
    );

    // 4. Update RELATIONSHIP to CANON v2 and verify search returns ONLY v2 and never stale v1
    const v1SnapshotForParity = {
      id: 'rel_kairen_liana',
      ownerId,
      projectId,
      sourceCharacterId: 'char_kairen',
      targetCharacterId: 'char_liana',
      relationType: '비밀 방위 맹약 동맹',
      affinityScore: 70,
      isDirectional: false,
      description: '북부 성채 방위를 위해 비밀리에 결성한 전략 동맹',
      canonStatus: 'CANON' as const,
      effectiveEpisodeId: 'ep_1',
      effectiveEventId: '',
      sourceRevisionId: 'rev_ep_1',
      createdBy: 'AI_ENGINE' as const,
      createdAt: '2026-06-10T10:00:00.000Z',
      updatedAt: '2026-06-10T10:00:00.000Z',
    };

    const rawTextV2 =
      '카이렌과 리아나는 봉인석 균열 사태 이후 맹약을 파기하고 적대적 감시 관계로 돌아섰다.';
    store.set(`${basePath}/revisions/rev_ep_2`, {
      id: 'rev_ep_2',
      ownerId,
      projectId,
      episodeId: 'ep_1',
      sceneId: 'sc_1',
      revisionNumber: 2,
      canonStatus: 'CANON',
      content: rawTextV2,
      createdAt: '2026-06-10T11:00:00.000Z',
      updatedAt: '2026-06-10T11:00:00.000Z',
    });

    const relProposalV2Id = 'prop_rel_v2';
    store.set(`${basePath}/changeProposals/${relProposalV2Id}`, {
      id: relProposalV2Id,
      ownerId,
      projectId,
      targetEntityType: 'RELATIONSHIP',
      targetEntityId: 'rel_kairen_liana',
      proposedAction: 'UPDATE',
      title: '카이렌-리아나 적대적 감시 관계로 전환',
      rationale: '봉인석 균열 이후 맹약 파기 반영',
      beforeSummary: '비밀 방위 맹약 동맹',
      afterSummary: '적대적 감시 관계 (-45)',
      canonStatus: 'PROPOSED',
      triggerEpisodeId: 'ep_1',
      triggerSceneId: 'sc_1',
      sourceRevisionId: 'rev_ep_2',
      createdBy: 'AI_ENGINE',
      reviewedAt: '',
      createdAt: '2026-06-10T11:01:00.000Z',
      updatedAt: '2026-06-10T11:01:00.000Z',
      proposedPayloadJson: JSON.stringify({
        schemaVersion: 'PHASE_4_2_1_V1',
        proposalId: relProposalV2Id,
        fingerprint: `fp_${relProposalV2Id}`,
        extractionRunId: `extrun_${relProposalV2Id}`,
        targetEntityType: 'RELATIONSHIP',
        proposedAction: 'UPDATE',
        targetEntityId: 'rel_kairen_liana',
        sourceEpisodeId: 'ep_1',
        sourceSceneId: 'sc_1',
        sourceRevisionId: 'rev_ep_2',
        confidenceScore: 0.97,
        temporalContext: 'PRESENT_EVENT',
        uncertaintyFlags: [],
        canonConflicts: [],
        existingEntitySnapshot: v1SnapshotForParity,
        verifiedExcerpt: {
          excerpt: rawTextV2,
          matchedText: rawTextV2,
          startOffset: 0,
          endOffset: rawTextV2.length,
          matchMethod: 'EXACT',
          matchCount: 1,
        },
        provenance: {
          sourceType: 'MANUSCRIPT',
          createdBy: 'AI_ENGINE',
          ownerId,
          projectId,
          episodeId: 'ep_1',
          sceneId: 'sc_1',
          revisionId: 'rev_ep_2',
          excerpt: rawTextV2,
          startOffset: 0,
          endOffset: rawTextV2.length,
        },
        relationshipDraft: {
          id: 'rel_kairen_liana',
          ownerId,
          projectId,
          sourceCharacterId: 'char_kairen',
          sourceCharacterName: '카이렌',
          targetCharacterId: 'char_liana',
          targetCharacterName: '리아나',
          relationType: '적대적 감시 관계',
          affinityScore: -45,
          isDirectional: false,
          description: '봉인석 균열 책임을 두고 맹약을 파기한 적대적 감시 상태',
          effectiveEpisodeId: 'ep_1',
          effectiveEventId: 'evt_northern_pact',
          canonStatus: 'PROPOSED',
          sourceRevisionId: 'rev_ep_2',
          createdBy: 'AI_ENGINE',
          provenance: {
            sourceType: 'MANUSCRIPT',
            createdBy: 'AI_ENGINE',
            ownerId,
            projectId,
            episodeId: 'ep_1',
            sceneId: 'sc_1',
            revisionId: 'rev_ep_2',
            excerpt: rawTextV2,
            startOffset: 0,
            endOffset: rawTextV2.length,
          },
        },
      }),
    });

    await approveChangeProposalOnServer(
      { projectId, proposalId: relProposalV2Id },
      { db, verifiedOwnerId: ownerId, nowIso: '2026-06-10T11:05:00.000Z' }
    );
    const syncV2Res = await executeRagSyncForApprovedProposalOnServer(
      { projectId, proposalId: relProposalV2Id },
      { db, verifiedOwnerId: ownerId, nowIso: '2026-06-10T11:05:05.000Z' }
    );
    assert.equal(syncV2Res.ok, true);
    assert.equal(syncV2Res.ragSyncStatus, 'SYNCED');

    const updatedManifest = store.get(`${basePath}/ragManifest/control`)!;
    const updatedStates = updatedManifest.entityStates as Record<
      string,
      EntityIndexLifecycleState
    >;
    assert.ok(
      updatedStates[relEntityKey].activeGeneration > 1,
      'Relationship activeGeneration must advance after v2 approval'
    );
    assert.equal(
      updatedStates[relEntityKey].activeSourceRevisionId,
      'rev_ep_2'
    );

    const v2Search = await searchProjectMemoryOnServer({
      ownerId,
      query: {
        projectId,
        queryText: '카이렌 리아나 적대적 감시 관계 맹약 파기',
        searchMode: 'HYBRID',
        canonOnly: true,
        sourceEntityTypes: ['RELATIONSHIP'],
      },
      db,
    });
    assert.ok(v2Search.hits.length >= 1);
    assert.equal(
      v2Search.hits[0].document.sourceRevisionId,
      'rev_ep_2',
      'Search must return latest CANON v2 revision'
    );
    assert.ok(
      (v2Search.hits[0].chunk.chunkText || v2Search.hits[0].chunk.content).includes('적대적 감시 관계'),
      'Search chunk text must reflect CANON v2'
    );
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
  }
});

test('Stage 2.5B Scenario B: Post-embedding CANON v2 update right before ragManifest/control transaction blocks v1 activation inside transaction and preserves active v1/v2 index', async () => {
  clearServerRagCachesForTesting();
  const ownerId = 'author_s25b_scen_b';
  const projectId = 'proj_s25b_scen_b';
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  const { basePath, relProposalId, seed } = buildMultiEntityApprovalSeed({
    ownerId,
    projectId,
  });

  let interceptNextManifestTx = false;
  const { db, store } = createAdvancedTransactionalMockFirestore(seed, {
    onBeforeManifestTxRead: () => {
      if (!interceptNextManifestTx) return;
      interceptNextManifestTx = false;
      // Simulate CANON entity being updated to v2 AFTER embedding AND AFTER staged batch write,
      // right as the ragManifest/control activation transaction starts its tx.get() reads!
      const currentRel = store.get(`${basePath}/relationships/rel_kairen_liana`)!;
      store.set(`${basePath}/relationships/rel_kairen_liana`, {
        ...currentRel,
        relationType: '트랜잭션 직전 갱신된 최신 CANON v2 동맹',
        sourceRevisionId: 'rev_ep_2_concurrent',
        updatedAt: '2026-06-10T10:30:00.000Z',
      });
    },
  });

  setCustomGeminiEmbedContentForTesting(async ({ contents }) => ({
    embeddings: [{ values: computeDeterministicSemanticEmbedding(contents, 768) }],
  }));

  try {
    await approveChangeProposalOnServer(
      { projectId, proposalId: relProposalId },
      { db, verifiedOwnerId: ownerId, nowIso: '2026-06-10T10:00:00.000Z' }
    );

    interceptNextManifestTx = true;
    const syncRes = await executeRagSyncForApprovedProposalOnServer(
      { projectId, proposalId: relProposalId },
      { db, verifiedOwnerId: ownerId, nowIso: '2026-06-10T10:00:10.000Z' }
    );

    assert.equal(syncRes.ok, false);
    assert.equal(syncRes.skippedReason, 'SUPERSEDED_BY_NEWER_CANON');
    assert.equal(syncRes.taskStatus, 'SUPERSEDED');
    assert.equal(
      syncRes.ragSyncStatus,
      'SUPERSEDED',
      'Superseded audit/result status must be SUPERSEDED (distinct from NOT_REQUIRED)'
    );

    // Verify Audit record in Firestore is SUPERSEDED
    const auditId = syncRes.results[0].auditId;
    const auditDoc = store.get(
      `${basePath}/changeProposalApprovalAudits/${auditId}`
    )!;
    assert.equal(auditDoc.ragSyncStatus, 'SUPERSEDED');

    // Verify ragManifest/control was NOT activated for stale v1!
    const manifestDoc = store.get(`${basePath}/ragManifest/control`);
    assert.equal(
      manifestDoc,
      undefined,
      'ragManifest/control must not commit stale v1 generation'
    );

    // Verify any staged MemoryDocument in Firestore has isActiveGeneration === false
    const relMemDocId = `memdoc_${projectId}_RELATIONSHIP_rel_kairen_liana`;
    const stagedDoc = store.get(`${basePath}/memoryDocuments/${relMemDocId}`);
    if (stagedDoc) {
      assert.equal(
        stagedDoc.isActiveGeneration,
        false,
        'Staged document must remain inactive when manifest activation is aborted'
      );
    }
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
  }
});

test('Stage 2.5B Scenario C: Late Worker A (old CANON v1) cannot overwrite Worker B (new CANON v2) active index or SYNCED status', async () => {
  clearServerRagCachesForTesting();
  const ownerId = 'author_s25b_scen_c';
  const projectId = 'proj_s25b_scen_c';
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  const { basePath, relProposalId, seed } = buildMultiEntityApprovalSeed({
    ownerId,
    projectId,
  });

  let pauseWorkerABeforeManifestTx = false;
  let resumeWorkerA!: () => void;
  const workerAPausedPromise = new Promise<void>((resolve) => {
    resumeWorkerA = resolve;
  });
  let releaseWorkerA!: () => void;
  const workerAReleasePromise = new Promise<void>((resolve) => {
    releaseWorkerA = resolve;
  });

  const { db, store } = createAdvancedTransactionalMockFirestore(seed, {
    onBeforeManifestTxRead: async () => {
      if (pauseWorkerABeforeManifestTx) {
        pauseWorkerABeforeManifestTx = false;
        resumeWorkerA();
        await workerAReleasePromise;
      }
    },
  });

  setCustomGeminiEmbedContentForTesting(async ({ contents }) => ({
    embeddings: [{ values: computeDeterministicSemanticEmbedding(contents, 768) }],
  }));

  try {
    // 1. Approve Proposal v1
    await approveChangeProposalOnServer(
      { projectId, proposalId: relProposalId },
      { db, verifiedOwnerId: ownerId, nowIso: '2026-06-10T10:00:00.000Z' }
    );

    // 2. Start Worker A on v1, and pause it right after it stages v1 docs and enters ragManifest/control transaction
    pauseWorkerABeforeManifestTx = true;
    const workerAPromise = executeRagSyncForApprovedProposalOnServer(
      {
        projectId,
        proposalId: relProposalId,
        workerId: 'worker_A_slow',
        leaseDurationMs: 5_000,
      },
      { db, verifiedOwnerId: ownerId, nowIso: '2026-06-10T10:00:01.000Z' }
    );

    await workerAPausedPromise;

    // 3. While Worker A is paused before manifest activation, CANON is updated to v2 and Worker B indexes v2!
    const currentRel = store.get(`${basePath}/relationships/rel_kairen_liana`)!;
    const v2Entity = {
      ...currentRel,
      id: 'rel_kairen_liana',
      ownerId,
      projectId,
      sourceCharacterId: 'char_kairen',
      targetCharacterId: 'char_liana',
      relationType: '워커 B가 확정한 최신 CANON v2 혈맹',
      affinityScore: 95,
      isDirectional: false,
      description: '워커 B가 최신 승인한 혈맹 관계',
      canonStatus: 'CANON' as const,
      effectiveEpisodeId: 'ep_1',
      effectiveEventId: '',
      sourceRevisionId: 'rev_ep_2',
      createdBy: 'AI_ENGINE' as const,
      createdAt: '2026-06-10T10:00:00.000Z',
      updatedAt: '2026-06-10T10:02:00.000Z',
    };
    store.set(`${basePath}/relationships/rel_kairen_liana`, v2Entity);

    // Worker B indexes v2 directly via indexMemoryInputOnServer with generation 2
    const workerBIndexRes = await indexMemoryInputOnServer(
      {
        ownerId,
        projectId,
        sourceEntityType: 'RELATIONSHIP',
        sourceEntityId: 'rel_kairen_liana',
        sourceRevisionId: 'rev_ep_2',
        canonStatus: 'CANON',
        title: '카이렌 ↔ 리아나 관계: 워커 B가 확정한 최신 CANON v2 혈맹',
        summary: '워커 B가 최신 승인한 혈맹 관계',
        fullText: '워커 B가 최신 승인한 혈맹 관계 (신뢰도 +95)',
        requestedGeneration: 2,
      },
      {
        db,
        durableCommitPolicy: {
          requireDurableCloudCommit: true,
          requireActiveGenerationVerification: true,
        },
      }
    );
    assert.equal(workerBIndexRes.durableCommitVerified, true);
    assert.equal(workerBIndexRes.activeGenerationVerified, true);

    // 4. Now release Worker A so its ragManifest/control transaction runs against the updated store
    releaseWorkerA();
    const workerARes = await workerAPromise;

    assert.equal(workerARes.ok, false);
    assert.equal(workerARes.skippedReason, 'SUPERSEDED_BY_NEWER_CANON');
    assert.equal(workerARes.ragSyncStatus, 'SUPERSEDED');

    // 5. Verify Worker B's active generation (gen=2, rev_ep_2) in ragManifest/control and memoryDocuments was NEVER overwritten by Worker A!
    const manifestDoc = store.get(`${basePath}/ragManifest/control`)!;
    const entityStates = manifestDoc.entityStates as Record<
      string,
      EntityIndexLifecycleState
    >;
    const relEntityKey = `${ownerId}:${projectId}:RELATIONSHIP:rel_kairen_liana`;
    assert.equal(entityStates[relEntityKey].activeGeneration, 2);
    assert.equal(
      entityStates[relEntityKey].activeSourceRevisionId,
      'rev_ep_2'
    );

    const relMemDocId = `memdoc_${projectId}_RELATIONSHIP_rel_kairen_liana`;
    const activeDoc = store.get(`${basePath}/memoryDocuments/${relMemDocId}`)!;
    assert.equal(activeDoc.indexGeneration, 2);
    assert.equal(activeDoc.sourceRevisionId, 'rev_ep_2');
    assert.equal(activeDoc.isActiveGeneration, true);
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
  }
});

test('Stage 2.5B Scenario D: Firestore batch write failure (both injected db and default Admin/Mock Firestore without options.db) blocks SYNCED and marks FAILED while preserving CANON and previous index', async () => {
  clearServerRagCachesForTesting();
  const ownerId = 'author_s25b_scen_d';
  const projectId = 'proj_s25b_scen_d';
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  const { basePath, relProposalId, seed } = buildMultiEntityApprovalSeed({
    ownerId,
    projectId,
  });

  // Part 1: Injected db batch commit failure after healthy v1 index exists
  const { db, store } = createAdvancedTransactionalMockFirestore(seed, {
    failBatchCommitCount: 1,
  });

  setCustomGeminiEmbedContentForTesting(async ({ contents }) => ({
    embeddings: [{ values: computeDeterministicSemanticEmbedding(contents, 768) }],
  }));

  try {
    await approveChangeProposalOnServer(
      { projectId, proposalId: relProposalId },
      { db, verifiedOwnerId: ownerId, nowIso: '2026-06-10T10:00:00.000Z' }
    );

    const failedSyncRes = await executeRagSyncForApprovedProposalOnServer(
      { projectId, proposalId: relProposalId },
      { db, verifiedOwnerId: ownerId, nowIso: '2026-06-10T10:00:05.000Z' }
    );

    assert.equal(failedSyncRes.ok, false);
    assert.equal(failedSyncRes.ragSyncStatus, 'FAILED');
    assert.equal(failedSyncRes.taskStatus, 'FAILED');
    assert.equal(failedSyncRes.documentId, '');
    assert.match(
      failedSyncRes.results[0].ragSyncError,
      /FIRESTORE_WRITE_FAILED|FIRESTORE_BATCH_COMMIT_FAILED/
    );

    // CANON entity & proposal approval must remain intact!
    const relEntity = store.get(`${basePath}/relationships/rel_kairen_liana`)!;
    assert.equal(relEntity.canonStatus, 'CANON');
    const propDoc = store.get(`${basePath}/changeProposals/${relProposalId}`)!;
    assert.equal(propDoc.canonStatus, 'CANON');

    // Part 2: Default Mock/Admin Firestore path (WITHOUT options.db) must also propagate Firestore write failure!
    const mockBackend = new InMemoryMockFirestoreRagBackend();
    mockBackend.documentsByPath.set(
      `users/${ownerId}/projects/${projectId}`,
      { id: projectId, ownerId }
    );
    mockBackend.simulateBatchFailureAtBatchNumber = 1;
    setMockFirestoreRagBackendForTesting(mockBackend);

    await assert.rejects(
      async () => {
        await indexMemoryInputOnServer(
          {
            ownerId,
            projectId,
            sourceEntityType: 'RELATIONSHIP',
            sourceEntityId: 'rel_kairen_liana',
            sourceRevisionId: 'rev_ep_1',
            canonStatus: 'CANON',
            title: '기본 Firestore 경로 실패 전파 검증',
            summary: 'options.db 미전달 시에도 예외 전파 필수',
            fullText: 'options.db가 없을 때도 Firestore batch 실패는 예외로 전파되어야 합니다.',
          },
          {
            preferDeterministicEmbeddings: true,
          }
        );
      },
      (err: Error) => {
        assert.match(
          err.message,
          /\[FIRESTORE_WRITE_FAILED\]|\[FIRESTORE_BATCH_COMMIT_FAILED\]/
        );
        return true;
      }
    );
  } finally {
    setMockFirestoreRagBackendForTesting(null);
    setCustomGeminiEmbedContentForTesting(null);
  }
});

test('Stage 2.5B Scenario E: Manifest activation transaction failure keeps staged MemoryDocument inactive and preserves previous active generation', async () => {
  clearServerRagCachesForTesting();
  const ownerId = 'author_s25b_scen_e';
  const projectId = 'proj_s25b_scen_e';
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  const { basePath, relProposalId, seed } = buildMultiEntityApprovalSeed({
    ownerId,
    projectId,
  });

  // First succeed on v1, then fail manifest activation on v2!
  const { db, store } = createAdvancedTransactionalMockFirestore(seed);

  setCustomGeminiEmbedContentForTesting(async ({ contents }) => ({
    embeddings: [{ values: computeDeterministicSemanticEmbedding(contents, 768) }],
  }));

  try {
    await approveChangeProposalOnServer(
      { projectId, proposalId: relProposalId },
      { db, verifiedOwnerId: ownerId, nowIso: '2026-06-10T10:00:00.000Z' }
    );
    const v1Sync = await executeRagSyncForApprovedProposalOnServer(
      { projectId, proposalId: relProposalId },
      { db, verifiedOwnerId: ownerId, nowIso: '2026-06-10T10:00:05.000Z' }
    );
    assert.equal(v1Sync.ok, true);
    assert.equal(v1Sync.ragSyncStatus, 'SYNCED');

    const relMemDocId = `memdoc_${projectId}_RELATIONSHIP_rel_kairen_liana`;
    const activeV1Doc = store.get(`${basePath}/memoryDocuments/${relMemDocId}`)!;
    assert.equal(activeV1Doc.indexGeneration, 1);
    assert.equal(activeV1Doc.isActiveGeneration, true);

    // Now test manifest activation failure on v2 using a second db wrapper that fails 1 manifest tx
    const initialDocsObj: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of store.entries()) {
      initialDocsObj[k] = v;
    }
    const { db: dbWithManifestFail, store: store2 } =
      createAdvancedTransactionalMockFirestore(initialDocsObj, {
        failManifestTxCount: 1,
      });

    await assert.rejects(
      async () => {
        await indexMemoryInputOnServer(
          {
            ownerId,
            projectId,
            sourceEntityType: 'RELATIONSHIP',
            sourceEntityId: 'rel_kairen_liana',
            sourceRevisionId: 'rev_ep_2_manifest_fail',
            canonStatus: 'CANON',
            title: '카이렌 ↔ 리아나 v2 (매니페스트 실패 시나리오)',
            summary: '매니페스트 전환 실패 시 기존 v1이 보호되어야 함',
            fullText: '매니페스트 트랜잭션이 실패하면 기존 활성 세대 v1이 그대로 유지되어야 합니다.',
          },
          {
            db: dbWithManifestFail,
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

    // Verify active MemoryDocument in Firestore is STILL v1 (`indexGeneration: 1`, `isActiveGeneration: true`)!
    const preservedActiveDoc = store2.get(
      `${basePath}/memoryDocuments/${relMemDocId}`
    )!;
    assert.equal(
      preservedActiveDoc.indexGeneration,
      1,
      'Active MemoryDocument must remain at generation 1 when v2 manifest activation fails'
    );
    assert.equal(preservedActiveDoc.isActiveGeneration, true);
    assert.equal(preservedActiveDoc.sourceRevisionId, 'rev_ep_1');

    // And the staged v2 document has isActiveGeneration === false
    const stagedV2Doc = store2.get(
      `${basePath}/memoryDocuments/${relMemDocId}__staged`
    );
    if (stagedV2Doc) {
      assert.equal(stagedV2Doc.isActiveGeneration, false);
    }
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
  }
});

test('Stage 2.5B Scenario F & Collision Guard: Server restart lease recovery (leaseGeneration + 1) and same-generation collision rejection (RAG_INDEX_ACTIVATION_CONFLICT)', async () => {
  clearServerRagCachesForTesting();
  const ownerId = 'author_s25b_scen_f';
  const projectId = 'proj_s25b_scen_f';
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  const { basePath, relProposalId, seed } = buildMultiEntityApprovalSeed({
    ownerId,
    projectId,
  });
  const { db, store } = createAdvancedTransactionalMockFirestore(seed);

  setCustomGeminiEmbedContentForTesting(async ({ contents }) => ({
    embeddings: [{ values: computeDeterministicSemanticEmbedding(contents, 768) }],
  }));

  try {
    await approveChangeProposalOnServer(
      { projectId, proposalId: relProposalId },
      { db, verifiedOwnerId: ownerId, nowIso: '2026-06-10T10:00:00.000Z' }
    );

    // Simulate Server Crash during PROCESSING (leaseOwner = worker_crashed, leaseGeneration = 1, leaseExpiresAtMs expired)
    const taskId = computeDeterministicRagSyncTaskId(relProposalId);
    const existingTask = store.get(`${basePath}/ragSyncTasks/${taskId}`)!;
    store.set(`${basePath}/ragSyncTasks/${taskId}`, {
      ...existingTask,
      status: 'PROCESSING',
      attemptCount: 1,
      leaseOwner: 'worker_crashed_before_restart',
      leaseGeneration: 1,
      leaseExpiresAtMs: new Date('2026-06-10T10:00:10.000Z').getTime(),
    });

    // New Worker after server restart recovers expired lease at 10:01:00.000Z -> increments leaseGeneration to 2
    const recoveryRes = await executeRagSyncForApprovedProposalOnServer(
      {
        projectId,
        proposalId: relProposalId,
        workerId: 'worker_restarted_2',
      },
      { db, verifiedOwnerId: ownerId, nowIso: '2026-06-10T10:01:00.000Z' }
    );

    assert.equal(recoveryRes.ok, true);
    assert.equal(recoveryRes.ragSyncStatus, 'SYNCED');
    assert.equal(recoveryRes.leaseGeneration, 2);

    // Now test same-generation collision guard: trying to activate generation 1 with a different contentHash/revision must fail with RAG_INDEX_ACTIVATION_CONFLICT
    await assert.rejects(
      async () => {
        await indexMemoryInputOnServer(
          {
            ownerId,
            projectId,
            sourceEntityType: 'RELATIONSHIP',
            sourceEntityId: 'rel_kairen_liana',
            sourceRevisionId: 'rev_collision_attempt',
            canonStatus: 'CANON',
            title: '동일 세대 번호 충돌 시도',
            summary: '세대 1에 다른 해시로 재활성화 시도',
            fullText: '이미 세대 1이 다른 해시로 활성화된 상태에서 세대 1로 충돌 쓰기를 시도합니다.',
            requestedGeneration: 1,
          },
          {
            db,
            forceRebuild: true,
            durableCommitPolicy: {
              requireDurableCloudCommit: true,
              requireActiveGenerationVerification: true,
            },
          }
        );
      },
      (err: Error) => {
        assert.match(err.message, /\[RAG_INDEX_ACTIVATION_CONFLICT\]/);
        return true;
      }
    );
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
  }
});

test('Stage 2.5B Section 11: Operational Integrity Diagnostics & Safe Recovery (States A through F)', async () => {
  clearServerRagCachesForTesting();
  const ownerId = 'author_s25b_diag';
  const projectId = 'proj_s25b_diag';
  registerProjectOwnerForAdminCheck(projectId, ownerId);

  const { basePath, relProposalId, evtProposalId, fshProposalId, seed } =
    buildMultiEntityApprovalSeed({ ownerId, projectId });
  const { db, store } = createAdvancedTransactionalMockFirestore(seed);

  setCustomGeminiEmbedContentForTesting(async ({ contents }) => ({
    embeddings: [{ values: computeDeterministicSemanticEmbedding(contents, 768) }],
  }));

  try {
    // Approve all 3 proposals
    for (const pid of [relProposalId, evtProposalId, fshProposalId]) {
      await approveChangeProposalOnServer(
        { projectId, proposalId: pid },
        { db, verifiedOwnerId: ownerId, nowIso: '2026-06-10T10:00:00.000Z' }
      );
    }

    // Create artificial anomalies across the project:
    // - State A on relProposalId: task is FAILED
    const relTaskId = computeDeterministicRagSyncTaskId(relProposalId);
    store.set(`${basePath}/ragSyncTasks/${relTaskId}`, {
      ...store.get(`${basePath}/ragSyncTasks/${relTaskId}`)!,
      status: 'FAILED',
      lastError: 'Simulated transient network error',
    });

    // - State B on evtProposalId: task is marked SYNCED, but memoryDocument is missing!
    const evtTaskId = computeDeterministicRagSyncTaskId(evtProposalId);
    store.set(`${basePath}/ragSyncTasks/${evtTaskId}`, {
      ...store.get(`${basePath}/ragSyncTasks/${evtTaskId}`)!,
      status: 'SYNCED',
      memoryDocumentId: `memdoc_${projectId}_TIMELINE_EVENT_evt_northern_pact`,
    });

    // - State D on fshProposalId: task is stuck in PROCESSING with expired lease
    const fshTaskId = computeDeterministicRagSyncTaskId(fshProposalId);
    store.set(`${basePath}/ragSyncTasks/${fshTaskId}`, {
      ...store.get(`${basePath}/ragSyncTasks/${fshTaskId}`)!,
      status: 'PROCESSING',
      leaseOwner: 'dead_worker',
      leaseGeneration: 1,
      leaseExpiresAtMs: new Date('2026-06-10T10:00:10.000Z').getTime(),
    });

    // - State F: An unapproved proposal with canonStatus = 'CANON' and no audit record
    store.set(`${basePath}/changeProposals/prop_rogue_canon`, {
      id: 'prop_rogue_canon',
      ownerId,
      projectId,
      targetEntityType: 'RELATIONSHIP',
      targetEntityId: 'rel_rogue',
      proposedAction: 'CREATE',
      title: '감사 이력 없는 비정상 CANON 제안서',
      rationale: '비정상 상태 F 테스트',
      beforeSummary: '',
      afterSummary: '',
      proposedPayloadJson: '{}',
      canonStatus: 'CANON',
      triggerEpisodeId: 'ep_1',
      sourceRevisionId: 'rev_ep_1',
      createdBy: 'AI_ENGINE',
      createdAt: '2026-06-10T10:00:00.000Z',
      updatedAt: '2026-06-10T10:00:00.000Z',
    });

    // 1. Run diagnostics without autoRecover first
    const diagReport = await diagnoseAndRecoverProjectRagIntegrityOnServer(
      { projectId, autoRecover: false },
      { db, verifiedOwnerId: ownerId, nowIso: '2026-06-10T10:05:00.000Z' }
    );

    assert.equal(diagReport.healthy, false);
    const codes = new Set(diagReport.anomalies.map((a) => a.code));
    assert.ok(codes.has('CANON_WITHOUT_SYNCED_TASK'), 'Must detect State A');
    assert.ok(
      codes.has('SYNCED_TASK_MISSING_MEMORY_DOCUMENT'),
      'Must detect State B'
    );
    assert.ok(codes.has('EXPIRED_PROCESSING_LEASE'), 'Must detect State D');
    assert.ok(
      codes.has('UNAPPROVED_PROPOSAL_CANON_VIOLATION'),
      'Must detect State F'
    );

    // 2. Run diagnostics WITH autoRecover + executeSyncOnRecover
    const recoveryReport = await diagnoseAndRecoverProjectRagIntegrityOnServer(
      {
        projectId,
        autoRecover: true,
        executeSyncOnRecover: true,
      },
      { db, verifiedOwnerId: ownerId, nowIso: '2026-06-10T10:06:00.000Z' }
    );

    assert.equal(
      recoveryReport.recoveredCount,
      3,
      'All 3 recoverable RAG tasks (States A, B, D) must be safely recovered and synced'
    );

    // Verify all 3 legitimate tasks are now SYNCED and their MemoryDocuments exist in Firestore!
    for (const tid of [relTaskId, evtTaskId, fshTaskId]) {
      const tDoc = store.get(`${basePath}/ragSyncTasks/${tid}`)!;
      assert.equal(tDoc.status, 'SYNCED');
      assert.ok(
        store.has(`${basePath}/memoryDocuments/${String(tDoc.memoryDocumentId)}`),
        `Recovered task ${tid} must have durable MemoryDocument in Firestore`
      );
    }

    // Verify State F was flagged as non-recoverable (never forged an approval audit)
    const stateFItem = recoveryReport.anomalies.find(
      (a) => a.code === 'UNAPPROVED_PROPOSAL_CANON_VIOLATION'
    )!;
    assert.equal(stateFItem.recoverable, false);
    assert.equal(stateFItem.recovered, false);
  } finally {
    setCustomGeminiEmbedContentForTesting(null);
  }
});
