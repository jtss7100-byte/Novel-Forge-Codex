import { randomUUID } from 'node:crypto';
import type { DocumentData, Firestore, QuerySnapshot } from 'firebase-admin/firestore';
import type { RagRetrievedEvidenceItem, ScenePlanItem, WritingContextBundle, WritingPlan } from '../types/aiEngine';
import type { CharacterRelationship, Foreshadowing, MemoryChunk, MemoryDocument, NarrativePerspective, Scene, TimelineEvent } from '../types/foundation';
import type { Character, Episode, WorldbuildingItem } from '../types/novel';
import type { MemoryRetrievalBudget, SceneMemoryDiagnostics, SceneMemoryKnowledge, SceneMemoryResult } from '../types/sceneMemory';
import { buildMemoryIndexInputFromApprovedEntity, extractProjectMemoryIndexInputs, FoundationMemorySearchStore, tokenizeKoreanSearchTerms, type RagExecutionSearchStatus, type MemoryIndexInput, type MemorySearchHit } from '../services/memorySearchProvider';
import { buildSceneMemoryRequirements, safeMemoryId, sceneMemoryBudget, selectSceneMemory, verifySceneMemoryProvenance, type SceneMemoryCandidate, type VerifiedMemorySource } from '../utils/sceneMemoryLogic';
import { generateServerEmbedding, resolveRagFirestore, tryFirestoreVectorFindNearest, type FirestoreRagManifestDoc } from './ragEngine';

const entityCollections = {
  EPISODE: 'episodes', EPISODE_SUMMARY: 'episodes', CHARACTER: 'characters', WORLDBUILDING: 'worldbuilding',
  TIMELINE_EVENT: 'timelineEvents', SCENE: 'scenes', FORESHADOWING: 'foreshadowings', RELATIONSHIP: 'relationships',
} as const;
const idList = (value: unknown, limit = 12): string[] => Array.isArray(value) ? [...new Set(value.filter(safeMemoryId))].slice(0, limit) : [];
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const episodePosition = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const storedPerspective = (value: unknown): NarrativePerspective | undefined =>
  value === 'FIRST_PERSON' || value === 'THIRD_LIMITED' || value === 'OMNISCIENT' || value === 'MIXED' ? value : undefined;
const scopedCollection = (type: string) => Object.hasOwn(entityCollections, type) ? entityCollections[type as keyof typeof entityCollections] : undefined;
const isCanon = (record: DocumentData | undefined) => record?.canonStatus === 'CANON' || (record?.canonStatus === undefined && record?.status === 'confirmed');

function knowledgeAnnotations(raw: unknown): SceneMemoryKnowledge | undefined {
  if (!raw || typeof raw !== 'object' || !('scope' in raw) ||
      (raw.scope !== 'PUBLIC' && raw.scope !== 'AUTHOR_ONLY' && raw.scope !== 'CHARACTERS')) return undefined;
  return {
    scope: raw.scope, characterIds: 'characterIds' in raw ? idList(raw.characterIds) : [],
    authorImportance: 'authorImportance' in raw ? finite(raw.authorImportance) : undefined,
    effectiveEventId: 'effectiveEventId' in raw && safeMemoryId(raw.effectiveEventId) ? raw.effectiveEventId : undefined,
    timeless: 'timeless' in raw && raw.timeless === true,
  };
}

function generationStatus(ownerId: string, projectId: string, manifest: FirestoreRagManifestDoc | undefined,
  chunk: MemoryChunk, document: MemoryDocument): 'ACTIVE' | 'RETIRED' | 'DELETED' | 'UNKNOWN' {
  if (!manifest || manifest.ownerId !== ownerId || manifest.projectId !== projectId) return 'UNKNOWN';
  if (manifest.projectLifecycleStatus === 'DELETED' || manifest.projectLifecycleStatus === 'PENDING_DELETE') return 'DELETED';
  const key = `${ownerId}:${projectId}:${chunk.sourceEntityType}:${chunk.sourceEntityId}`;
  const active = manifest.entityStates?.[key];
  const generation = chunk.indexGeneration;
  const scope = `${chunk.sourceEntityType}:${chunk.sourceEntityId}`;
  const deletion = manifest.entityDeletionStates?.[scope] ?? manifest.pendingDeletes?.[`ENTITY:${scope}`];
  if (active?.lifecycleStatus === 'DELETED' || active?.lifecycleStatus === 'PENDING_DELETE' ||
      (deletion && (deletion.status !== 'DELETED' || deletion.tombstoneGeneration >= (generation ?? 0)))) return 'DELETED';
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1 ||
      document.indexGeneration !== generation) return 'UNKNOWN';
  const retired = manifest.retiredGenerationsByEntity?.[key];
  if (generation <= (retired?.retiredThroughGen ?? 0) || retired?.retiredGens.includes(generation) ||
      manifest.cleanupClaims?.[`${key}::g${generation}`] || generation <= manifest.projectTombstoneGeneration) return 'RETIRED';
  if (manifest.projectLifecycleStatus !== 'ACTIVE' || !active?.activeDocumentIds?.length || !active.activeGeneration ||
      (active.lifecycleStatus !== 'ACTIVE' && active.lifecycleStatus !== 'REINDEXING_KEEP_OLD')) return 'UNKNOWN';
  if (active.ownerId !== ownerId || active.projectId !== projectId ||
      active.sourceEntityId !== chunk.sourceEntityId || active.sourceEntityType !== chunk.sourceEntityType) return 'UNKNOWN';
  if (active.activeGeneration !== generation || !active.activeDocumentIds.includes(document.id)) return 'RETIRED';
  if (active.activeRevisionId !== chunk.sourceRevisionId || active.activeContentHash !== document.contentHash) return 'UNKNOWN';
  if (active.activationMode !== 'MANIFEST_POINTER' && (chunk.isActiveGeneration !== true || document.isActiveGeneration !== true)) return 'RETIRED';
  return 'ACTIVE';
}

type CloudSource = { record: DocumentData; exists: boolean };
function makeSourceReader(db: Firestore, ownerId: string, projectId: string) {
  const base = `users/${ownerId}/projects/${projectId}`;
  // Small lookups are shared across scenes. The final chunk, parent and manifest reads remain fresh.
  const records = new Map<string, CloudSource>();
  async function batch(paths: string[]) {
    const missing = [...new Set(paths)].filter((path) => !records.has(path));
    if (!missing.length) return;
    for (let index = 0; index < missing.length; index += 80) {
      const slice = missing.slice(index, index + 80);
      const snapshots = await db.getAll(...slice.map((path) => db.doc(`${base}/${path}`)));
      snapshots.forEach((snap) => records.set(snap.ref.path.slice(base.length + 1), { exists: snap.exists, record: snap.data() ?? {} }));
    }
  }
  async function entity(collection: string, id: unknown) {
    if (!safeMemoryId(id)) return undefined;
    const path = `${collection}/${id}`;
    await batch([path]);
    const source = records.get(path);
    return source?.exists && source.record.id === id && source.record.ownerId === ownerId && source.record.projectId === projectId
      ? source.record : undefined;
  }
  return { base, batch, entity, records };
}

function deriveText(input: { ownerId: string; projectId: string; type: string; record: DocumentData; episode?: Episode; names: Record<string, string> }) {
  const { ownerId, projectId, type, record, episode, names } = input;
  let inputs: MemoryIndexInput[];
  if (type === 'RELATIONSHIP' || type === 'TIMELINE_EVENT' || type === 'FORESHADOWING') {
    return [
      buildMemoryIndexInputFromApprovedEntity({ ownerId, projectId, targetEntityType: type,
        entity: record as CharacterRelationship | TimelineEvent | Foreshadowing, characterNameMap: names }),
      ...(type === 'RELATIONSHIP' ? [buildMemoryIndexInputFromApprovedEntity({
        ownerId, projectId, targetEntityType: type, entity: record as CharacterRelationship,
      })] : []),
    ].filter((entry): entry is MemoryIndexInput => Boolean(entry));
  }
  inputs = extractProjectMemoryIndexInputs({
    ownerId, projectId, includeDrafts: false,
    characters: type === 'CHARACTER' ? [record as Character] : [],
    worldbuilding: type === 'WORLDBUILDING' ? [record as WorldbuildingItem] : [],
    episodes: episode ? [episode] : [],
    scenes: type === 'SCENE' ? [record as Scene] : [],
  });
  return inputs.filter((entry) => entry.sourceEntityType === type);
}

async function buildVerifiedSource(hit: MemorySearchHit, sourceReader: ReturnType<typeof makeSourceReader>,
  ownerId: string, projectId: string, scene: ScenePlanItem | undefined, pov?: string): Promise<VerifiedMemorySource | undefined> {
  const { chunk } = hit;
  const collection = scopedCollection(chunk.sourceEntityType);
  if (!collection) return undefined;
  const record = await sourceReader.entity(collection, chunk.sourceEntityId);
  if (!record || !isCanon(record)) return undefined;
  const type = chunk.sourceEntityType;
  const isEpisode = type === 'EPISODE' || type === 'EPISODE_SUMMARY';
  const episodeId = isEpisode ? record.id : record.episodeId ?? record.plantedEpisodeId ?? record.effectiveEpisodeId;
  const episode = (isEpisode ? record : await sourceReader.entity('episodes', episodeId)) as Episode | undefined;
  const revisionId = isEpisode ? record.latestRevisionId : record.sourceRevisionId;
  if (!safeMemoryId(revisionId)) return undefined;
  const revision = await sourceReader.entity('revisions', revisionId);
  // Source-associated manuscript must be tied to an actual immutable Revision of its episode.
  if ((episodeId || isEpisode) && (!episode || !isCanon(episode) || !revision || revision.episodeId !== episodeId)) return undefined;
  if (isEpisode && (typeof revision?.content !== 'string' || revision.content !== episode?.content)) return undefined;
  const names: Record<string, string> = {};
  if (type === 'RELATIONSHIP') {
    const pair = idList([record.sourceCharacterId, record.targetCharacterId]);
    await sourceReader.batch(pair.map((id) => `characters/${id}`));
    for (const id of pair) {
      const character = await sourceReader.entity('characters', id);
      if (typeof character?.name === 'string') names[id] = character.name;
    }
  }
  const inputs = deriveText({ ownerId, projectId, type, record, episode, names });
  const [first] = inputs;
  if (!first || first.sourceRevisionId !== revisionId) return undefined;
  let knowledge = knowledgeAnnotations(record.memoryKnowledge);
  const qualifiedId = `${type}:${record.id}`;
  if (!knowledge && pov && scene?.memory?.povKnownSources?.slice(0, 12).includes(qualifiedId)) {
    knowledge = { scope: 'CHARACTERS', characterIds: [pov] };
  }
  const effectiveEvent = await sourceReader.entity('timelineEvents', knowledge?.effectiveEventId ?? record.effectiveEventId);
  const declaredOrder = effectiveEvent && isCanon(effectiveEvent) ? finite(effectiveEvent.chronologicalOrder) : undefined;
  const linkedScene = type === 'FORESHADOWING' ? await sourceReader.entity('scenes', record.plantedSceneId) : type === 'SCENE' ? record : undefined;
  const orderForScene = async (row?: DocumentData) => {
    if (!row || !isCanon(row)) return undefined;
    const events = await Promise.all(idList(row.eventIds, 6).map((eventId) => sourceReader.entity('timelineEvents', eventId)));
    const orders = events.map((item) => item && isCanon(item) && item.sceneId === row.id ? finite(item.chronologicalOrder) : undefined);
    return orders.length && orders.every((order): order is number => order !== undefined) ? Math.max(...orders) : undefined;
  };
  const narrativeOrder = type === 'TIMELINE_EVENT' ? finite(record.chronologicalOrder) : declaredOrder ?? await orderForScene(linkedScene);
  const resolvedEpisode = type === 'FORESHADOWING' ? await sourceReader.entity('episodes', record.resolvedEpisodeId) : undefined;
  const resolvedScene = type === 'FORESHADOWING' ? await sourceReader.entity('scenes', record.resolvedSceneId) : undefined;
  const phase = ['PLANTED', 'REINFORCED', 'RESOLVED', 'ABANDONED'].find((value) => value === record.cluePhase) as Foreshadowing['cluePhase'] | undefined;
  if (type === 'FORESHADOWING' && !phase) return undefined;
  return {
    id: record.id, ownerId, projectId, canonStatus: 'CANON', revisionId,
    episodeId: episode?.id,
    sceneId: (type === 'SCENE' ? record.id : record.sceneId ?? record.plantedSceneId) || undefined,
    texts: inputs.flatMap((entry) => typeof entry.fullText === 'string' ? [entry.fullText] : []),
    episodeNumber: episodePosition(episode?.episodeNumber), narrativeOrder, knowledge,
    foreshadowingPhase: phase, resolvedEpisodeNumber: isCanon(resolvedEpisode) ? episodePosition(resolvedEpisode?.episodeNumber) : undefined,
    resolvedOrder: await orderForScene(resolvedScene), characterIds: idList(first.characterIds),
    eventIds: idList(first.relatedEventIds), foreshadowingIds: idList(first.foreshadowingIds),
  };
}

// A bounded pair query prevents a retrieved historical relationship from being labeled current
// merely because its replacement was absent from the search results.
async function classifyRelationship(db: Firestore, reader: ReturnType<typeof makeSourceReader>, ownerId: string, projectId: string,
  source: VerifiedMemorySource, record: DocumentData, cutoff: number, nonlinear: boolean,
  queryBySource: Map<string, Promise<QuerySnapshot>>) {
  if (!safeMemoryId(record.sourceCharacterId) || !safeMemoryId(record.targetCharacterId)) return;
  const first = record.sourceCharacterId, second = record.targetCharacterId;
  const list = db.collection(`${reader.base}/relationships`);
  const query = (id: string) => {
    const cached = queryBySource.get(id) ?? list.where('sourceCharacterId', '==', id).limit(26).get();
    queryBySource.set(id, cached);
    return cached;
  };
  const [left, right] = await Promise.all([query(first), record.isDirectional || first === second ? undefined : query(second)]);
  if (left.size > 25 || (right?.size ?? 0) > 25) return;
  const order = nonlinear ? source.narrativeOrder : source.episodeNumber;
  if (order === undefined) return;
  let uncertain = false;
  for (const snapshot of [...left.docs, ...(right?.docs ?? [])]) {
    const item = snapshot.data();
    if (item.ownerId !== ownerId || item.projectId !== projectId || item.id !== snapshot.id || snapshot.id === source.id ||
        item.isDirectional !== record.isDirectional || !isCanon(item)) continue;
    const samePair = item.sourceCharacterId === first && item.targetCharacterId === second ||
      (!record.isDirectional && item.sourceCharacterId === second && item.targetCharacterId === first);
    if (!samePair) continue;
    const episode = await reader.entity('episodes', item.effectiveEpisodeId);
    const event = nonlinear ? await reader.entity('timelineEvents', item.effectiveEventId) : undefined;
    const position = nonlinear ? isCanon(event) ? finite(event?.chronologicalOrder) : undefined :
      isCanon(episode) ? finite(episode?.episodeNumber) : undefined;
    if (position === undefined || position === order) uncertain = true;
    else if (position > order && position < cutoff) {
      source.historicalState = true;
      return;
    }
  }
  // A future replacement does not invalidate the latest state known at this cutoff.
  if (!uncertain && order < cutoff) source.currentState = true;
}

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
  db?: Firestore;
}) {
  const { ownerId, context, plan } = params;
  const db = safeMemoryId(ownerId) && safeMemoryId(context.projectId) && ownerId !== 'local_author' ? resolveRagFirestore({ db: params.db }) : null;
  const runBudget = sceneMemoryBudget(undefined, params.budget);
  const reader = db ? makeSourceReader(db, ownerId, context.projectId) : undefined;
  const searchCache = new Map<string, Awaited<ReturnType<SceneSearch>>>();
  let retrievalRequests = 0;
  let embeddingRequests = 0;
  let authority: Promise<{ episode?: DocumentData; plan?: WritingPlan }> | undefined;
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
      selected: [], rejected: [], budget: runBudget, memoryChars: 0, estimatedMemoryTokens: 0, retrievalRequests, embeddingRequests,
      missingRequiredEventIds: basic.requiredEventIds, missingForeshadowingIds: basic.relatedForeshadowingIds,
    };
    const empty = () => ({ evidence: [], diagnostics });
    try {
      if (!db || !reader) return empty();
      reader.records.clear();
      authority ??= loadAuthority();
      const trusted = await authority;
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
      const order = isCanon(cutoff) ? finite(cutoff?.chronologicalOrder) : undefined;
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
      const relationshipQueries = new Map<string, Promise<QuerySnapshot>>();
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
            const source = await buildVerifiedSource(hit, reader, ownerId, context.projectId, approved, pov).catch(() => undefined);
            reason = verifySceneMemoryProvenance({ ownerId, projectId: context.projectId, chunk, document, source, generation });
            if (!reason && source) {
              if (chunk.sourceEntityType === 'RELATIONSHIP' && sourceRef) {
                await classifyRelationship(db, reader, ownerId, context.projectId, source, sourceRef.record,
                  requirements.narrativeCutoff?.order ?? episodeNumber, Boolean(requirements.narrativeCutoff), relationshipQueries);
              }
              verified.push({ hit: { ...hit, chunk, document }, source });
            }
          }
        }
        if (reason) diagnostics.rejected.push({ chunkId: cached.id, reason });
      }
      // Re-check the active pointer immediately before admitting evidence to the Writer.
      const latestManifest = (await manifestRef.get()).data() as FirestoreRagManifestDoc | undefined;
      const active = verified.filter(({ hit }) => {
        const status = generationStatus(ownerId, context.projectId, latestManifest, hit.chunk, hit.document);
        if (status === 'ACTIVE') return true;
        diagnostics.rejected.push({ chunkId: hit.chunk.id, reason: status === 'DELETED' ? 'DELETED_SOURCE' :
          status === 'RETIRED' ? 'RETIRED_GENERATION' : 'SOURCE_UNVERIFIED' });
        return false;
      });
      const selection = selectSceneMemory(requirements, active, budget);
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
