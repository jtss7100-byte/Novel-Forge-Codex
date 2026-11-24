import type { GraphPath } from '../types/narrativeMemory';
import { annotationEligibility } from './memoryKnowledgeLogic';
import type { MemoryKnowledgeAnnotation } from '../types/memoryKnowledge';
import type { ScenePlanItem, WritingContextBundle } from '../types/aiEngine';
import type { MemoryChunk, MemoryDocument, NarrativePerspective } from '../types/foundation';
import type { MemoryKnowledgeEligibility, MemoryRejectionReason, MemoryRerankingSignal, MemoryRetrievalBudget, MemoryTemporalStatus, SceneMemoryKnowledge, SceneMemoryRequirements, SceneMemorySelection } from '../types/sceneMemory';
import { computeMemoryContentHash, tokenizeKoreanSearchTerms, verifyChunkAgainstLiveSource, type MemorySearchHit } from '../services/memorySearchProvider';

const stableText = (value: string) => value.replace(/\s+/g, ' ').trim();
const distinct = (values: readonly string[] = [], max = 12) => [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))].slice(0, max);
export const safeMemoryId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const ids = (values: readonly string[] = []) => distinct(values).filter(safeMemoryId);

export function buildSceneMemoryRequirements(context: WritingContextBundle, scene: ScenePlanItem | undefined, trusted: {
  episodeNumber: number; perspective?: NarrativePerspective; pov?: string;
  eventIds?: string[]; foreshadowingIds?: string[]; worldbuildingIds?: string[]; locations?: string[];
  cutoff?: SceneMemoryRequirements['narrativeCutoff'];
}): SceneMemoryRequirements {
  const goal = stableText(scene?.purpose || context.plotOutline || context.episodeTitle).slice(0, 320);
  const characterIds = ids(scene?.characterIds ?? context.sceneCharacterIds ?? []);
  const selectedNames = context.canonCharacters.filter(({ id }) => characterIds.includes(id)).map(({ name }) => name);
  const required = distinct([scene?.mustIncludeEvent ?? '', ...(context.requiredEvents ?? [])], 8);
  const relevantLocations = distinct([...(scene?.memory?.locations ?? []), ...(trusted.locations ?? [])], 6);
  const forbidden = new Set((context.forbiddenDevelopments ?? []).map(stableText));
  const primary = distinct([goal, ...required, ...selectedNames, ...relevantLocations], 18).filter((term) => !forbidden.has(stableText(term)));
  const summary = stableText(context.previousEpisodeSummary ?? '').slice(0, 200);
  return {
    projectId: context.projectId, episodeId: context.episodeId, episodeNumber: trusted.episodeNumber,
    sceneNumber: scene?.sceneNumber, sceneGoal: goal, characterIds,
    perspective: trusted.perspective, pointOfViewCharacterId: trusted.pov,
    requiredEventIds: ids([...(scene?.memory?.requiredEventIds ?? []), ...(trusted.eventIds ?? [])]),
    relatedForeshadowingIds: ids([...(scene?.memory?.foreshadowingIds ?? []), ...(trusted.foreshadowingIds ?? [])]),
    relevantWorldbuildingIds: ids([...(scene?.memory?.worldbuildingIds ?? []), ...(trusted.worldbuildingIds ?? [])]),
    relevantLocations, narrativeCutoff: trusted.cutoff,
    semanticQueries: [stableText([...primary, summary].join(' ')).slice(0, 850)].filter(Boolean),
    keywordQueries: [stableText(primary.join(' ')).slice(0, 660)].filter(Boolean),
  };
}

const bounds: MemoryRetrievalBudget = {
  maxCandidateCount: 48, maxSelectedChunks: 10, maxMemoryChars: 8000,
  maxEstimatedMemoryTokens: 6000, maxRetrievalRequests: 8, maxEmbeddingRequests: 1,
};

export function sceneMemoryBudget(requirements?: SceneMemoryRequirements, settings: Partial<MemoryRetrievalBudget> = {}): MemoryRetrievalBudget {
  const expanded = Boolean(requirements && (requirements.characterIds.length > 3 ||
    requirements.requiredEventIds.length + requirements.relatedForeshadowingIds.length >= 2));
  const cap = (key: keyof MemoryRetrievalBudget, defaultValue: number, min = 1) => {
    const supplied = settings[key];
    return typeof supplied === 'number' && Number.isFinite(supplied)
      ? Math.min(bounds[key], Math.max(min, Math.floor(supplied))) : defaultValue;
  };
  return {
    maxCandidateCount: cap('maxCandidateCount', expanded ? 36 : 24),
    maxSelectedChunks: cap('maxSelectedChunks', expanded ? 8 : 6),
    maxMemoryChars: cap('maxMemoryChars', expanded ? 6000 : 4500),
    maxEstimatedMemoryTokens: cap('maxEstimatedMemoryTokens', expanded ? 4500 : 3375),
    maxRetrievalRequests: cap('maxRetrievalRequests', 6, 0),
    maxEmbeddingRequests: cap('maxEmbeddingRequests', 1, 0),
  };
}

export interface VerifiedMemorySource {
  id: string; ownerId: string; projectId: string; canonStatus: string; revisionId: string; texts: string[];
  episodeId?: string;
  sceneId?: string;
  sceneNumber?: number;
  legacyKnowledge?: SceneMemoryKnowledge;
  durableKnowledge?: MemoryKnowledgeAnnotation;
  legacySceneScoped?: boolean;
  knowledgeRejection?: MemoryRejectionReason;
  episodeNumber?: number;
  narrativeOrder?: number;
  knowledge?: SceneMemoryKnowledge;
  currentState?: boolean;
  historicalState?: boolean;
  foreshadowingPhase?: 'PLANTED' | 'REINFORCED' | 'RESOLVED' | 'ABANDONED';
  resolvedEpisodeNumber?: number;
  resolvedOrder?: number;
  characterIds: string[];
  eventIds: string[];
  foreshadowingIds: string[];
}

export function verifySceneMemoryProvenance(params: {
  ownerId: string; projectId: string; chunk: MemoryChunk; document?: MemoryDocument; source?: VerifiedMemorySource;
  generation: 'ACTIVE' | 'RETIRED' | 'DELETED' | 'UNKNOWN';
}): MemoryRejectionReason | undefined {
  const { ownerId, projectId, chunk, document, source, generation } = params;
  if ([chunk, document, source].some((entry) => entry && (entry.ownerId !== ownerId || entry.projectId !== projectId))) return 'CROSS_PROJECT';
  if (generation === 'DELETED' || [chunk.lifecycleStatus, document?.lifecycleStatus, document?.indexStatus].some((status) => status === 'DELETED' || status === 'PENDING_DELETE')) return 'DELETED_SOURCE';
  if (generation === 'RETIRED') return 'RETIRED_GENERATION';
  if ([chunk, document, source].some((entry) => entry && entry.canonStatus !== 'CANON')) return 'NON_CANON';
  if (document?.indexStatus === 'STALE' || (source && chunk.sourceRevisionId && source.revisionId !== chunk.sourceRevisionId)) return 'STALE_SOURCE';
  if (!document || !source || generation !== 'ACTIVE' || !safeMemoryId(chunk.id) || !safeMemoryId(document.id) ||
      !safeMemoryId(chunk.sourceEntityId) || !chunk.sourceRevisionId || !source.revisionId ||
      chunk.documentId !== document.id || (document.documentId && document.documentId !== document.id) ||
      (chunk.chunkId && chunk.chunkId !== chunk.id) || document.sourceEntityId !== chunk.sourceEntityId ||
      document.sourceEntityType !== chunk.sourceEntityType || source.id !== chunk.sourceEntityId ||
      document.sourceRevisionId !== chunk.sourceRevisionId || document.indexStatus !== 'INDEXED' ||
      !chunk.content || !document.fullText || !document.contentHash || !chunk.contentHash ||
      chunk.contentHash !== computeMemoryContentHash(chunk.content)) return 'SOURCE_UNVERIFIED';
  const start = chunk.sourceStartOffset, end = chunk.sourceEndOffset;
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0 ||
      typeof end !== 'number' || !Number.isSafeInteger(end) || end <= start) return 'SOURCE_UNVERIFIED';
  const matchingText = source.texts.find((text) => computeMemoryContentHash(text) === document.contentHash &&
    text.includes(document.fullText) && end <= text.length && text.slice(start, end) === chunk.content &&
    document.fullText.includes(chunk.content));
  if (!matchingText) return 'SOURCE_UNVERIFIED';
  const key = `${chunk.sourceEntityType}:${chunk.sourceEntityId}`;
  return verifyChunkAgainstLiveSource({ chunk, document, liveSources: {
    [key]: { exists: true, latestRevisionId: source.revisionId, canonStatus: 'CANON', fullText: matchingText },
  }, requireVerifiedLiveSource: true }).verifiedForWriting ? undefined : 'SOURCE_UNVERIFIED';
}

export interface SceneMemoryCandidate { hit: MemorySearchHit; source: VerifiedMemorySource; graphPath?: GraphPath; graphLinked?: boolean }

export function temporalStatus(requirements: SceneMemoryRequirements, source: VerifiedMemorySource): MemoryTemporalStatus | 'SOURCE_UNVERIFIED' | 'FUTURE_INFORMATION' | 'TEMPORAL_EVIDENCE_MISSING' {
  if (source.knowledge?.timeless && source.episodeNumber === undefined && source.narrativeOrder === undefined &&
      !source.foreshadowingPhase && !source.historicalState && !source.eventIds.length) return 'CURRENT_VALID_STATE';
  const cutoff = requirements.narrativeCutoff;
  const latest = cutoff?.order ?? requirements.episodeNumber;
  const candidateOrder = cutoff ? source.narrativeOrder : source.episodeNumber;
  if (candidateOrder === undefined || !Number.isFinite(candidateOrder)) return 'SOURCE_UNVERIFIED';
  if (!cutoff && source.episodeId && source.episodeId === requirements.episodeId) {
    if (source.sceneNumber === undefined || requirements.sceneNumber === undefined) return 'TEMPORAL_EVIDENCE_MISSING';
    if (source.sceneNumber >= requirements.sceneNumber) return 'FUTURE_INFORMATION';
  } else if (candidateOrder >= latest) return 'FUTURE_INFORMATION';
  if (source.foreshadowingPhase === 'RESOLVED' || source.foreshadowingPhase === 'ABANDONED') {
    const resolution = cutoff ? source.resolvedOrder : source.resolvedEpisodeNumber;
    if (resolution === undefined) return 'SOURCE_UNVERIFIED';
    if (resolution >= latest) return 'FUTURE_INFORMATION';
  }
  return source.historicalState ? 'SUPERSEDED_HISTORICAL_STATE' : source.currentState ? 'CURRENT_VALID_STATE' : 'PAST_EVENT';
}

export function knowledgeStatus(requirements: SceneMemoryRequirements, source: VerifiedMemorySource): Exclude<MemoryKnowledgeEligibility, 'AUTHOR_KNOWLEDGE'> | MemoryRejectionReason {
  if (source.knowledgeRejection) return source.knowledgeRejection;
  if (source.durableKnowledge) return annotationEligibility(source.durableKnowledge, requirements);
  // The date a fact takes effect does not prove when a character learned it.
  if (source.legacyKnowledge?.scope === 'CHARACTERS' && !source.legacySceneScoped) return 'TEMPORAL_EVIDENCE_MISSING';
  const knowledge = source.knowledge;
  if (knowledge?.scope === 'AUTHOR_ONLY') return 'POV_KNOWLEDGE_RESTRICTED';
  if (knowledge?.scope === 'PUBLIC') return 'PUBLIC';
  if (knowledge?.scope === 'CHARACTERS') return requirements.pointOfViewCharacterId && knowledge.characterIds?.includes(requirements.pointOfViewCharacterId)
    ? 'POV_CHARACTER_KNOWLEDGE' : 'POV_KNOWLEDGE_RESTRICTED';
  // Omniscient narration is allowed to cite contextual facts, but unknown scope never grants a character knowledge.
  return requirements.perspective === 'OMNISCIENT' && !requirements.pointOfViewCharacterId
    ? 'UNKNOWN_KNOWLEDGE_SCOPE' : 'POV_KNOWLEDGE_RESTRICTED';
}

const intersects = (left: readonly string[], right: readonly string[]) => left.some((value) => right.includes(value));
const coefficient = (score: number) => Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
const relatedCharacterTypes = new Set(['CHARACTER', 'CHARACTER_STATE_CHANGE', 'RELATIONSHIP']);
const lexical = (text: string) => new Set(tokenizeKoreanSearchTerms(text.slice(0, 1400)).normalizedStems.filter((term) => term.length > 1));

export function selectSceneMemory(requirements: SceneMemoryRequirements, candidates: SceneMemoryCandidate[], budget: MemoryRetrievalBudget) {
  const rejected: { chunkId: string; reason: MemoryRejectionReason }[] = [];
  const reject = (chunkId: string, reason: MemoryRejectionReason) => rejected.push({ chunkId, reason });
  const goal = lexical(requirements.sceneGoal);
  const evaluated: { hit: MemorySearchHit; selection: SceneMemorySelection; source: VerifiedMemorySource; graphLinked?: boolean }[] = [];
  for (const { hit, source, graphPath, graphLinked } of candidates) {
    const { chunk } = hit;
    const time = temporalStatus(requirements, source);
    if (time === 'SOURCE_UNVERIFIED' || time === 'FUTURE_INFORMATION' || time === 'TEMPORAL_EVIDENCE_MISSING') { reject(chunk.id, time); continue; }
    const knowledge = knowledgeStatus(requirements, source);
    if (knowledge !== 'PUBLIC' && knowledge !== 'POV_CHARACTER_KNOWLEDGE' && knowledge !== 'UNKNOWN_KNOWLEDGE_SCOPE') { reject(chunk.id, knowledge); continue; }
    const castMatch = intersects(requirements.characterIds, source.characterIds);
    if (!castMatch && relatedCharacterTypes.has(chunk.sourceEntityType)) { reject(chunk.id, 'LOW_RELEVANCE'); continue; }
    const exact = intersects(requirements.requiredEventIds, source.eventIds) || requirements.relevantWorldbuildingIds.includes(source.id);
    const clues = intersects(requirements.relatedForeshadowingIds, source.foreshadowingIds);
    const open = source.foreshadowingPhase === 'PLANTED' || source.foreshadowingPhase === 'REINFORCED';
    const terms = lexical(`${hit.document.title} ${chunk.content}`);
    const goalMatch = [...goal].some((token) => terms.has(token));
    const location = requirements.relevantLocations.some((name) => chunk.content.includes(name));
    const semantic = coefficient(hit.semanticScore), keyword = coefficient(hit.keywordScore), rank = coefficient(hit.score);
    const importance = coefficient(source.knowledge?.authorImportance ?? 0);
    if (!castMatch && !exact && !clues && !goalMatch && !location && keyword === 0 && semantic < 0.2 && !importance && !graphPath) {
      reject(chunk.id, 'LOW_RELEVANCE'); continue;
    }
    if (chunk.sourceEntityType === 'FORESHADOWING' && !open && !clues && !exact && !goalMatch && !graphPath) {
      reject(chunk.id, 'LOW_RELEVANCE'); continue;
    }
    const signals: MemoryRerankingSignal[] = ['FRESHNESS'];
    if (graphPath) signals.push('GRAPH');
    if (semantic) signals.push('SEMANTIC');
    if (keyword) signals.push('KEYWORD');
    if (castMatch) signals.push('CHARACTER');
    if (exact || goalMatch || location) signals.push('SCENE_GOAL');
    if (open || clues) signals.push('FORESHADOWING');
    if (chunk.sourceEntityType === 'RELATIONSHIP') signals.push('RELATIONSHIP');
    if (time !== 'PAST_EVENT') signals.push('TEMPORAL');
    if (importance) signals.push('AUTHOR_IMPORTANCE');
    const score = 0.25 * rank + 0.17 * semantic + 0.17 * keyword + (castMatch ? 0.16 : 0) +
      (goalMatch || location ? 0.12 : 0) + (exact ? 0.75 : 0) + (clues ? 0.38 : 0) + (open && (clues || goalMatch) ? 0.20 : 0) +
      (graphPath ? (graphPath.depth === 1 ? 0.34 : 0.24) : 0) + (time === 'CURRENT_VALID_STATE' ? 0.12 : 0) + 0.31 * importance;
    evaluated.push({ hit, source, graphLinked, selection: {
      chunkId: chunk.id, sourceEntityId: chunk.sourceEntityId, sourceRevisionId: chunk.sourceRevisionId,
      episodeNumber: source.episodeNumber, title: hit.document.title, temporal: time, knowledge, signals,
      annotationVersion: source.durableKnowledge?.version,
      ...(graphPath ? { graphDepth: graphPath.depth, graphRelation: graphPath.via.at(-1)?.relation } : {}),
      score: Number(score.toFixed(5)), semanticScore: semantic, keywordScore: keyword, retrievalSource: hit.retrievalSource,
    } });
  }
  const selected: typeof evaluated = [];
  let memoryChars = 0;
  let estimatedContextChars = 0;
  const estimate = (length: number) => Math.ceil(length * 0.75);
  while (evaluated.length) {
    const utility = (entry: typeof evaluated[number]) => entry.selection.score - selected.reduce((penalty, previous) =>
      penalty + (previous.source.id === entry.source.id && previous.hit.chunk.sourceEntityType === entry.hit.chunk.sourceEntityType ? 0.22 :
        previous.hit.chunk.sourceEntityType === entry.hit.chunk.sourceEntityType ? 0.035 : 0), 0);
    evaluated.sort((a, b) => utility(b) - utility(a) || (a.hit.chunk.id < b.hit.chunk.id ? -1 : 1));
    const next = evaluated.shift()!;
    const chunk = next.hit.chunk;
    const duplicate = selected.some(({ hit: { chunk: prior } }) => {
      if (stableText(prior.content) === stableText(chunk.content)) return true;
      if (prior.sourceEntityType !== chunk.sourceEntityType || prior.sourceEntityId !== chunk.sourceEntityId ||
          prior.sourceRevisionId !== chunk.sourceRevisionId) return false;
      return Math.min(prior.sourceEndOffset ?? 0, chunk.sourceEndOffset ?? 0) > Math.max(prior.sourceStartOffset ?? 0, chunk.sourceStartOffset ?? 0);
    });
    if (duplicate) { reject(chunk.id, 'DUPLICATE_EVIDENCE'); continue; }
    const size = chunk.content.length + next.hit.document.title.length + 192 + (next.graphLinked ? 300 : 0);
    if (selected.length >= budget.maxSelectedChunks || memoryChars + chunk.content.length > budget.maxMemoryChars ||
        estimate(estimatedContextChars + size) > budget.maxEstimatedMemoryTokens) { reject(chunk.id, 'BUDGET_EXCEEDED'); continue; }
    if (selected.length && !selected.some(({ hit }) => hit.chunk.sourceEntityType === chunk.sourceEntityType)) next.selection.signals.push('SOURCE_DIVERSITY');
    selected.push(next);
    memoryChars += chunk.content.length;
    estimatedContextChars += size;
  }
  const missingRequiredEventIds = requirements.requiredEventIds.filter((id) => !selected.some(({ source }) => source.eventIds.includes(id)));
  const missingForeshadowingIds = requirements.relatedForeshadowingIds.filter((id) => !selected.some(({ source }) => source.foreshadowingIds.includes(id)));
  return { selected, rejected, memoryChars, estimatedMemoryTokens: estimate(estimatedContextChars), missingRequiredEventIds, missingForeshadowingIds };
}
