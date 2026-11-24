import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { RagRetrievedEvidenceItem, ScenePlanItem, WritingContextBundle, WritingPlan } from '../types/aiEngine';
import type { MemoryChunk, MemoryDocument, NarrativePerspective } from '../types/foundation';
import type { MemoryRetrievalBudget, SceneMemoryDiagnostics, SceneMemoryResult } from '../types/sceneMemory';
import { FoundationMemorySearchStore, tokenizeKoreanSearchTerms, type RagExecutionSearchStatus, type MemorySearchHit } from '../services/memorySearchProvider';
import { buildSceneMemoryRequirements, safeMemoryId, sceneMemoryBudget, selectSceneMemory, verifySceneMemoryProvenance, type SceneMemoryCandidate } from '../utils/sceneMemoryLogic';
import { generateServerEmbedding, resolveRagFirestore, tryFirestoreVectorFindNearest, type FirestoreRagManifestDoc } from './ragEngine';

import { resolveKnowledgeAcquisition } from './knowledgeAcquisition';
import { applyWriterMemoryKnowledge } from './memoryKnowledgeStore';
import { buildVerifiedSource, episodePosition, generationStatus, idList, isCanon, makeSourceReader, scopedCollection } from './memorySourceAuthority';

import { GRAPH_LIMITS, graphDiagnostics, narrativeNodeKey, rejectGraph } from '../utils/narrativeMemoryLogic';
import { graphAuthoritiesStillActive, graphEligibility, graphNode, newGraphRun, retrieveNarrativeGraph } from './narrativeMemoryGraph';
import { relationshipHistoryReader } from './narrativeRelationshipHistory';

const storedPerspective = (value: unknown): NarrativePerspective | undefined =>
  value === 'FIRST_PERSON' || value === 'THIRD_LIMITED' || value === 'OMNISCIENT' || value === 'MIXED' ? value : undefined;

const stableScene = (scene: ScenePlanItem) => JSON.stringify([
  scene.sceneNumber, scene.title, scene.purpose, scene.mustIncludeEvent, scene.characterIds,
  scene.pointOfViewCharacterId ?? '', scene.narrativePerspective ?? '',
]);

type SceneSearch = (input: {
  db: Firestore; ownerId: string; projectId: string; text: string; limit: number; hybrid: boolean;
  focus?: { eventId?: string; foreshadowingId?: string };
}) => Promise<{ hits: MemorySearchHit[]; searchExecutionStatus: RagExecutionSearchStatus; vectorFallback: boolean }>;

// Search a bounded candidate pool without hydrating the complete project index on a cold start.
const searchSceneCandidates: SceneSearch = async ({ db, ownerId, projectId, text, limit, hybrid, focus }) => {
  const base = `users/${ownerId}/projects/${projectId}`;
  const collection = db.collection(`${base}/memoryChunks`);
  const terms = tokenizeKoreanSearchTerms(text).normalizedStems.slice(0, 20);
  const keywordQuery = focus?.eventId ? collection.where('relatedEventIds', 'array-contains', focus.eventId) :
    focus?.foreshadowingId ? collection.where('foreshadowingIds', 'array-contains', focus.foreshadowingId) :
    terms.length ? collection.where('keywords', 'array-contains-any', terms) : undefined;
  const keywordReads = keywordQuery ? keywordQuery.limit(limit).get() : Promise.resolve(undefined);
  const recentReads = focus ? Promise.resolve(undefined) : collection.orderBy('episodeNumber', 'desc').limit(Math.min(8, limit)).get();
  const manifestRead = db.doc(`${base}/ragManifest/control`).get();
  const vectorRead = async () => {
    if (!hybrid) return undefined;
    try {
      const embedding = await generateServerEmbedding(text, { taskType: 'RETRIEVAL_QUERY' });
      if (!embedding.usedLiveGeminiApi) return undefined;
      const vector = await tryFirestoreVectorFindNearest({
        db, ownerId, projectId, queryEmbedding: embedding.embedding, queryEmbeddingGenerationMode: embedding.embeddingGenerationMode,
        queryEmbeddingModelId: embedding.modelId, limit: Math.min(12, limit), canonOnly: true,
      });
      return vector.status === 'OK_WITH_HITS' || vector.status === 'OK_EMPTY' ? { embedding, candidates: vector.candidates.slice(0, limit) } : undefined;
    } catch {
      return undefined;
    }
  };
  const [keyword, recent, manifestSnapshot, vector] = await Promise.all([keywordReads, recentReads, manifestRead, vectorRead()]);
  const manifest = manifestSnapshot.data() as FirestoreRagManifestDoc | undefined;
  const indexed = new Map<string, MemoryChunk>();
  for (const doc of [...(keyword?.docs ?? []), ...(recent?.docs ?? [])]) {
    const chunk = doc.data() as MemoryChunk;
    if (chunk.id === doc.id && chunk.ownerId === ownerId && chunk.projectId === projectId) indexed.set(doc.id, chunk);
  }
  for (const candidate of vector?.candidates ?? []) {
    const chunk = candidate.chunkSnapshot;
    if (chunk && chunk.ownerId === ownerId && chunk.projectId === projectId) indexed.set(chunk.id, chunk);
  }
  const ids = [...new Set([...indexed.values()].map((chunk) => chunk.documentId).filter(safeMemoryId))];
  if (!ids.length) return { hits: [], searchExecutionStatus: 'KEYWORD_ONLY', vectorFallback: hybrid };
  const parents = await db.getAll(...ids.map((id) => db.doc(`${base}/memoryDocuments/${id}`)));
  const documents = new Map(parents.flatMap((snap): [string, MemoryDocument][] =>
    snap.exists && snap.data()?.id === snap.id ? [[snap.id, snap.data() as MemoryDocument]] : []));
  const chunks = [...indexed.values()].filter((chunk) => {
    const doc = documents.get(chunk.documentId);
    const key = `${ownerId}:${projectId}:${chunk.sourceEntityType}:${chunk.sourceEntityId}`;
    return doc?.ownerId === ownerId && doc.projectId === projectId && manifest?.entityStates?.[key]?.activeGeneration === chunk.indexGeneration;
  });
  const store = new FoundationMemorySearchStore();
  store.loadSnapshot([...documents.values()], chunks, { entityStates: [...new Set(chunks.flatMap((chunk) => {
    const row = manifest?.entityStates?.[`${ownerId}:${projectId}:${chunk.sourceEntityType}:${chunk.sourceEntityId}`];
    return row ? [row] : [];
  }))] });
  const hits = await store.search({
    ownerId, projectId, queryText: text, searchMode: vector ? 'HYBRID' : 'KEYWORD', limit, ...focus,
    allowedCanonStatuses: ['CANON'], includeDrafts: false, includeNonCanonException: false,
    externalVectorCandidates: vector?.candidates, queryEmbedding: vector?.embedding.embedding,
    queryEmbeddingModelId: vector?.embedding.modelId, queryEmbeddingGenerationMode: vector?.embedding.embeddingGenerationMode,
  });
  if (focus && hits.length < limit) {
    const hitIds = new Set(hits.map(({ chunk }) => chunk.id));
    const anchored = await store.search({
      ownerId, projectId, queryText: '', searchMode: 'KEYWORD', limit, ...focus, allowedCanonStatuses: ['CANON'],
    });
    for (const hit of anchored) {
      if (hits.length >= limit) break;
      if (hitIds.has(hit.chunk.id)) continue;
      // The selected anchor is an exact ID match. It confers no lexical similarity.
      hits.push({ ...hit, score: 0, relevanceScore: 0, keywordScore: 0, semanticScore: 0 });
    }
  }
  const usedVector = hits.some((hit) => hit.retrievalSource === 'FIRESTORE_VECTOR_HYBRID' || hit.retrievalSource === 'FIRESTORE_VECTOR_ONLY');
  return { hits, searchExecutionStatus: usedVector ? 'FIRESTORE_VECTOR_HYBRID' : 'KEYWORD_ONLY', vectorFallback: hybrid && !usedVector };
};

export function createSceneMemoryRetriever(params: {
  ownerId: string; context: WritingContextBundle; plan?: WritingPlan | null; budget?: Partial<MemoryRetrievalBudget>;
  db?: Firestore; graph?: boolean;
}) {
  const { ownerId, context, plan } = params;
  const db = safeMemoryId(ownerId) && safeMemoryId(context.projectId) && ownerId !== 'local_author' ? resolveRagFirestore({ db: params.db }) : null;
  const runBudget = sceneMemoryBudget(undefined, params.budget);
  const reader = db ? makeSourceReader(db, ownerId, context.projectId) : undefined;
  const graphRun = newGraphRun();
  const classifyRelationships = db ? relationshipHistoryReader(db, ownerId, context.projectId) : undefined;
  const searchCache = new Map<string, Awaited<ReturnType<SceneSearch>>>();
  let retrievalRequests = 0;
  let embeddingRequests = 0;
  const loadAuthority = async () => {
    if (!reader || !db || !safeMemoryId(context.episodeId)) return {};
    const project = (await db.doc(reader.base).get()).data();
    if (project?.id !== context.projectId || project.ownerId !== ownerId) return {};
    const episode = await reader.entity('episodes', context.episodeId);
    const stored = plan ? await reader.entity('writingPlans', plan.id) : undefined;
    return { episode, plan: stored?.status === 'APPROVED' && stored.episodeId === context.episodeId && Array.isArray(stored.scenes)
      ? stored as WritingPlan : undefined };
  };

  return async (scene?: ScenePlanItem): Promise<SceneMemoryResult> => {
    const basic = buildSceneMemoryRequirements(context, scene, { episodeNumber: 0 });
    const diagnostics: SceneMemoryDiagnostics = {
      id: randomUUID(), requirements: basic, status: 'AUTHORITY_UNAVAILABLE', searchModes: [], candidateCount: 0,
      graph: { ...graphDiagnostics(), status: params.graph === false ? 'DISABLED' : 'NO_SEEDS' },
      selected: [], rejected: [], budget: runBudget, memoryChars: 0, estimatedMemoryTokens: 0, retrievalRequests, embeddingRequests,
      missingRequiredEventIds: basic.requiredEventIds, missingForeshadowingIds: basic.relatedForeshadowingIds,
    };
    const empty = () => ({ evidence: [], diagnostics });
    try {
      if (!db || !reader) return empty();
      reader.records.clear();
      const trusted = await loadAuthority();
      const episodeNumber = episodePosition(trusted.episode?.episodeNumber);
      const approved = scene ? trusted.plan?.scenes.find((entry) => entry.sceneNumber === scene.sceneNumber) : undefined;
      if (episodeNumber === undefined || episodeNumber < 1 || (scene && (!approved || stableScene(scene) !== stableScene(approved)))) return empty();
      const characterIds = idList(approved?.characterIds ?? context.sceneCharacterIds);
      const scopedCharacters = await Promise.all(characterIds.map((id) => reader.entity('characters', id)));
      const names = new Map(scopedCharacters.flatMap((character) =>
        isCanon(character) && typeof character?.name === 'string' ? [[character.id, character.name] as const] : []));
      const sceneContext = {
        ...context,
        sceneCharacterIds: characterIds,
        canonCharacters: context.canonCharacters.filter(({ id }) => names.has(id)).map((character) => ({ ...character, name: names.get(character.id)! })),
        requiredEvents: trusted.plan?.requiredEvents ?? context.requiredEvents,
        forbiddenDevelopments: trusted.plan?.forbiddenDevelopments ?? context.forbiddenDevelopments,
      };
      // An unsigned request POV cannot grant access to character-scoped knowledge.
      const perspective = storedPerspective(approved?.narrativePerspective) ?? storedPerspective(trusted.plan?.narrativePerspective);
      const pov = approved?.pointOfViewCharacterId;
      if (pov && (!isCanon(await reader.entity('characters', pov)) || !approved?.characterIds.includes(pov))) return empty();
      const cutoffId = approved?.memory?.cutoffEventId;
      const cutoff = cutoffId ? await reader.entity('timelineEvents', cutoffId) : undefined;
      const order = cutoffId && isCanon(cutoff) && typeof cutoff?.episodeId === 'string' ? (await resolveKnowledgeAcquisition(reader, {
        episodeId: cutoff.episodeId, eventId: cutoffId, characterId: '', method: 'UNKNOWN',
      }))?.position.order : undefined;
      if (cutoffId && order === undefined) return empty();
      const requirements = buildSceneMemoryRequirements(sceneContext, approved, {
        episodeNumber, perspective, pov,
        eventIds: idList(trusted.episode?.linkedEventIds), foreshadowingIds: idList(trusted.episode?.linkedForeshadowingIds),
        cutoff: cutoffId && order !== undefined ? { eventId: cutoffId, order } : undefined,
      });
      const budget = sceneMemoryBudget(requirements, params.budget);
      diagnostics.requirements = requirements;
      diagnostics.budget = budget;
      diagnostics.missingRequiredEventIds = requirements.requiredEventIds;
      diagnostics.missingForeshadowingIds = requirements.relatedForeshadowingIds;
      const maxSearches = budget.maxRetrievalRequests;
      const hits = new Map<string, MemorySearchHit>();
      const runSearch = async (queryText: string, focus?: { eventId?: string; foreshadowingId?: string }) => {
        if (!queryText) return;
        const key = JSON.stringify([queryText, focus, budget.maxCandidateCount]);
        let result = searchCache.get(key);
        if (!result) {
          if (retrievalRequests >= maxSearches) return;
          const hybrid = !focus && embeddingRequests < budget.maxEmbeddingRequests;
          retrievalRequests++;
          if (hybrid) embeddingRequests++;
          result = await searchSceneCandidates({ ownerId, db, projectId: context.projectId, text: queryText, hybrid,
            limit: focus ? Math.min(8, budget.maxCandidateCount) : budget.maxCandidateCount, focus });
          searchCache.set(key, result);
        }
        if (result.vectorFallback) diagnostics.vectorFallback = true;
        if (!diagnostics.searchModes.includes(result.searchExecutionStatus)) diagnostics.searchModes.push(result.searchExecutionStatus);
        for (const hit of result.hits) if (!hits.has(hit.chunk.id)) hits.set(hit.chunk.id, hit);
      };
      const firstEvent = requirements.requiredEventIds[0], firstClue = requirements.relatedForeshadowingIds[0];
      // Focus results get room in the bounded pool before the broad ranking fills it.
      if (firstEvent) await runSearch(requirements.keywordQueries[0], { eventId: firstEvent });
      if (firstClue && (!firstEvent || retrievalRequests + 1 < maxSearches)) await runSearch(requirements.keywordQueries[0], { foreshadowingId: firstClue });
      await runSearch(requirements.semanticQueries[0] ?? requirements.keywordQueries[0]);
      diagnostics.retrievalRequests = retrievalRequests;
      diagnostics.embeddingRequests = embeddingRequests;
      if (!hits.size) {
        diagnostics.status = diagnostics.searchModes.includes('SEARCH_FAILED') ? 'SEARCH_FAILED' :
          diagnostics.searchModes.length ? 'NO_MATCHES' : retrievalRequests >= maxSearches ? 'BUDGET_EXCEEDED' : 'NO_MATCHES';
        return empty();
      }
      const candidates = [...hits.values()].slice(0, budget.maxCandidateCount);
      diagnostics.candidateCount = candidates.length;
      const manifestRef = db.doc(`${reader.base}/ragManifest/control`);
      const indexPaths = candidates.flatMap(({ chunk }) => [
        ...(safeMemoryId(chunk.id) ? [`memoryChunks/${chunk.id}`] : []),
        ...(safeMemoryId(chunk.documentId) ? [`memoryDocuments/${chunk.documentId}`] : []),
      ]);
      const snapshots = await db.getAll(manifestRef, ...[...new Set(indexPaths)].map((path) => db.doc(`${reader.base}/${path}`)));
      const index = new Map(snapshots.map((snapshot) => [snapshot.ref.path, snapshot.data()]));
      const manifest = index.get(manifestRef.path) as FirestoreRagManifestDoc | undefined;
      // Renew authoritative source snapshots for candidates each scene. Only bounded IDs are loaded.
      const sourcePaths = candidates.flatMap(({ chunk }) => {
        const collection = scopedCollection(chunk.sourceEntityType);
        return collection && safeMemoryId(chunk.sourceEntityId) ? [`${collection}/${chunk.sourceEntityId}`] : [];
      });
      await reader.batch(sourcePaths);
      const verified: SceneMemoryCandidate[] = [];
      for (const hit of candidates) {
        const cached = hit.chunk;
        const chunk = index.get(`${reader.base}/memoryChunks/${cached.id}`) as MemoryChunk | undefined;
        const document = index.get(`${reader.base}/memoryDocuments/${cached.documentId}`) as MemoryDocument | undefined;
        let reason: SceneMemoryDiagnostics['rejected'][number]['reason'] | undefined;
        if (cached.ownerId !== ownerId || cached.projectId !== context.projectId) reason = 'CROSS_PROJECT';
        else if (!chunk || !document || chunk.id !== cached.id || document.id !== cached.documentId ||
            chunk.documentId !== cached.documentId || chunk.sourceEntityId !== cached.sourceEntityId ||
            chunk.sourceEntityType !== cached.sourceEntityType || chunk.sourceRevisionId !== cached.sourceRevisionId ||
            chunk.indexGeneration !== cached.indexGeneration || chunk.content !== cached.content) reason = 'SOURCE_UNVERIFIED';
        else {
          const collection = scopedCollection(chunk.sourceEntityType);
          const sourceRef = collection ? reader.records.get(`${collection}/${chunk.sourceEntityId}`) : undefined;
          const generation = generationStatus(ownerId, context.projectId, manifest, chunk, document);
          if (sourceRef?.exists === false) reason = 'DELETED_SOURCE';
          else if (sourceRef?.exists && !isCanon(sourceRef.record)) reason = 'NON_CANON';
          else {
            const source = await buildVerifiedSource(chunk, reader, ownerId, context.projectId, approved, pov).catch(() => undefined);
            reason = verifySceneMemoryProvenance({ ownerId, projectId: context.projectId, chunk, document, source, generation });
            if (!reason && source) {
              verified.push({ hit: { ...hit, chunk, document }, source });
            }
          }
        }
        if (reason) diagnostics.rejected.push({ chunkId: cached.id, reason });
      }
      await applyWriterMemoryKnowledge(db, reader, ownerId, context.projectId, verified, requirements);
      const seeds = selectSceneMemory(requirements, verified, { ...budget, maxSelectedChunks: GRAPH_LIMITS.seeds }).selected;
      const alreadyEligible = verified.filter((item) => !graphEligibility(item, requirements)).length;
      const graph = params.graph === false ? undefined : await retrieveNarrativeGraph({
        db, ownerId, projectId: context.projectId, manifest, requirements, approvedScene: approved, seedReader: reader,
        base: verified, seeds, limit: Math.min(6, Math.max(0, budget.maxCandidateCount - alreadyEligible)), run: graphRun,
        canRetrieve: () => retrievalRequests < maxSearches,
        claimRetrieval: () => {
          if (retrievalRequests >= maxSearches) return false;
          retrievalRequests++;
          return true;
        },
      });
      diagnostics.retrievalRequests = retrievalRequests;
      diagnostics.graph = graph?.diagnostics ?? { ...graphDiagnostics(), status: 'DISABLED' };

      // Re-check the active pointer for all graph path nodes, including intermediates.
      const latestManifest = (await manifestRef.get()).data() as FirestoreRagManifestDoc | undefined;
      const graphFresh = Boolean(graph && graphAuthoritiesStillActive(graph, ownerId, context.projectId, latestManifest));
      if (graph && !graphFresh) {
        rejectGraph(graph.diagnostics, 'STALE_LINK');
        graph.diagnostics.status = 'SEARCH_FAILED';
        graph.diagnostics.newCandidates = 0;
        graph.diagnostics.characterStates = [];
      }
      const fresh = (item: SceneMemoryCandidate) => {
        const { hit } = item;
        const status = generationStatus(ownerId, context.projectId, latestManifest, hit.chunk, hit.document);
        if (status === 'ACTIVE') return true;
        diagnostics.rejected.push({ chunkId: hit.chunk.id, reason: status === 'DELETED' ? 'DELETED_SOURCE' :
          status === 'RETIRED' ? 'RETIRED_GENERATION' : 'SOURCE_UNVERIFIED' });
        return false;
      };
      const annotated = (candidate: SceneMemoryCandidate) => {
        if (!graphFresh || !graph) return candidate;
        const node = graphNode(candidate);
        if (!node) return candidate;
        const path = graph.paths.get(narrativeNodeKey(node));
        const linked = graph.links.some((edge) => graph.linkProofs.get(edge.id)?.includes(candidate.hit.chunk.id));
        const states = graph.diagnostics.characterStates?.filter((state) => state.nodeId === node.id && node.type === 'TIMELINE_EVENT');
        const state = states?.length === 1 ? states[0].status : undefined;
        return { ...candidate, graphPath: path, graphLinked: linked, source: state ? { ...candidate.source, currentState: state === 'CURRENT', historicalState: state === 'HISTORICAL' } : candidate.source };
      };
      const activeBase = verified.filter(fresh);
      const expanded = graphFresh && graph ? graph.candidates.filter(fresh) : [];
      const active = [...activeBase, ...expanded].map(annotated);
      if (active.length > budget.maxCandidateCount) {
        const overflow = active.length - budget.maxCandidateCount;
        const dropped = new Set(active.filter((item) => graphEligibility(item, requirements)).slice(0, overflow).map((item) => item.hit.chunk.id));
        for (let i = active.length - 1; i >= 0; i--) if (dropped.has(active[i].hit.chunk.id)) {
          diagnostics.rejected.push({ chunkId: active[i].hit.chunk.id, reason: 'BUDGET_EXCEEDED' });
          active.splice(i, 1);
        }
      }
      diagnostics.candidateCount = Math.min(budget.maxCandidateCount, Math.max(diagnostics.candidateCount, active.length));
      try {
        diagnostics.graph.relationshipStates = await classifyRelationships?.(active, reader, requirements);
      } catch {
        // A failed history query cannot establish a current relationship.
        for (const candidate of active) if (candidate.hit.chunk.sourceEntityType === 'RELATIONSHIP') {
          candidate.source = { ...candidate.source, currentState: false, historicalState: false };
        }
      }
      const selection = selectSceneMemory(requirements, active.slice(0, budget.maxCandidateCount), budget);
      const selectedIds = new Set(selection.selected.map(({ hit }) => hit.chunk.id));
      const visibleLink = (chunkId: string) => {
        if (!graphFresh || !graph) return undefined;
        const edge = graph.links.find((row) => {
          const proof = graph.linkProofs.get(row.id);
          return row.status === 'AUTHOR_CONFIRMED' && proof?.[1] === chunkId && proof.every((id) => selectedIds.has(id));
        });
        return edge && { from: edge.from, to: edge.to, relation: edge.relation };
      };
      diagnostics.selected = selection.selected.map((item) => item.selection);
      diagnostics.rejected.push(...selection.rejected);
      diagnostics.status = selection.selected.length ? 'SELECTED' : 'FILTERED';
      diagnostics.memoryChars = selection.memoryChars;
      diagnostics.estimatedMemoryTokens = selection.estimatedMemoryTokens;
      diagnostics.missingRequiredEventIds = selection.missingRequiredEventIds;
      diagnostics.missingForeshadowingIds = selection.missingForeshadowingIds;
      const evidence: RagRetrievedEvidenceItem[] = selection.selected.map(({ hit, selection, source }) => ({
        chunkId: hit.chunk.id, documentId: hit.document.id, projectId: context.projectId, sourceEntityType: hit.chunk.sourceEntityType,
        sourceEntityId: hit.chunk.sourceEntityId, sourceRevisionId: hit.chunk.sourceRevisionId,
        episodeId: source.episodeId ?? '', episodeNumber: selection.episodeNumber, sceneId: source.sceneId ?? '',
        title: hit.document.title, originalText: hit.chunk.content, sourceStartOffset: hit.chunk.sourceStartOffset!,
        sourceEndOffset: hit.chunk.sourceEndOffset!, score: hit.score, relevanceScore: selection.score,
        keywordScore: hit.keywordScore, semanticScore: hit.semanticScore, matchedTerms: hit.matchedTerms,
        canonStatus: 'CANON', freshnessStatus: 'FRESH', verifiedForWriting: true, temporalStatus: selection.temporal, knowledgeEligibility: selection.knowledge,
        narrativeLink: visibleLink(hit.chunk.id),
        temporalBasis: requirements.narrativeCutoff ? 'NARRATIVE_CUTOFF' : 'EPISODE_ORDER',
      }));
      return { evidence, diagnostics };
    } catch {
      diagnostics.status = 'SEARCH_FAILED';
      diagnostics.retrievalRequests = retrievalRequests;
      diagnostics.embeddingRequests = embeddingRequests;
      return empty();
    }
  };
}
