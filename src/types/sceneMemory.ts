import type { RagRetrievedEvidenceItem } from './aiEngine';
import type { NarrativePerspective } from './foundation';

/** Optional annotations on an approved scene plan. Cloud retrieval reads the saved plan. */
export interface SceneMemoryPlan {
  cutoffEventId?: string;
  requiredEventIds?: string[];
  foreshadowingIds?: string[];
  worldbuildingIds?: string[];
  locations?: string[];
  /** Qualified source keys explicitly known to the viewpoint character for this scene. */
  povKnownSources?: string[];
}

/** Optional author annotations on an authoritative CANON entity. */
export interface SceneMemoryKnowledge {
  scope: 'PUBLIC' | 'AUTHOR_ONLY' | 'CHARACTERS';
  characterIds?: string[];
  authorImportance?: number;
  effectiveEventId?: string;
  timeless?: boolean;
}

export interface SceneMemoryRequirements {
  projectId: string;
  episodeId: string;
  episodeNumber: number;
  sceneNumber?: number;
  sceneGoal: string;
  characterIds: string[];
  pointOfViewCharacterId?: string;
  perspective?: NarrativePerspective;
  requiredEventIds: string[];
  relatedForeshadowingIds: string[];
  relevantLocations: string[];
  relevantWorldbuildingIds: string[];
  narrativeCutoff?: { eventId: string; order: number };
  semanticQueries: string[];
  keywordQueries: string[];
}

export interface MemoryRetrievalBudget {
  maxCandidateCount: number;
  maxSelectedChunks: number;
  maxMemoryChars: number;
  maxEstimatedMemoryTokens: number;
  maxRetrievalRequests: number;
  maxEmbeddingRequests: number;
}

export type MemoryRejectionReason =
  | 'STALE_SOURCE' | 'SOURCE_UNVERIFIED' | 'NON_CANON' | 'CROSS_PROJECT' | 'RETIRED_GENERATION'
  | 'DELETED_SOURCE' | 'FUTURE_INFORMATION' | 'POV_KNOWLEDGE_RESTRICTED'
  | 'STALE_ANNOTATION' | 'KNOWLEDGE_SCOPE_CONFLICT' | 'TEMPORAL_EVIDENCE_MISSING'
  | 'DUPLICATE_EVIDENCE' | 'BUDGET_EXCEEDED' | 'LOW_RELEVANCE';
export type MemoryTemporalStatus = 'PAST_EVENT' | 'CURRENT_VALID_STATE' | 'SUPERSEDED_HISTORICAL_STATE';
export type MemoryKnowledgeEligibility = 'PUBLIC' | 'POV_CHARACTER_KNOWLEDGE' | 'AUTHOR_KNOWLEDGE' | 'UNKNOWN_KNOWLEDGE_SCOPE';
export type MemoryRerankingSignal = 'SEMANTIC' | 'KEYWORD' | 'CHARACTER' | 'SCENE_GOAL' | 'FORESHADOWING'
  | 'RELATIONSHIP' | 'TEMPORAL' | 'AUTHOR_IMPORTANCE' | 'SOURCE_DIVERSITY' | 'FRESHNESS';

export interface SceneMemorySelection {
  chunkId: string;
  sourceEntityId: string;
  sourceRevisionId: string;
  episodeNumber?: number;
  title: string;
  temporal: MemoryTemporalStatus;
  knowledge: MemoryKnowledgeEligibility;
  signals: MemoryRerankingSignal[];
  score: number;
  semanticScore: number;
  keywordScore: number;
  retrievalSource?: string;
  annotationVersion?: number;
}

export interface SceneMemoryDiagnostics {
  id: string;
  requirements: SceneMemoryRequirements;
  status: 'SELECTED' | 'NO_MATCHES' | 'FILTERED' | 'SEARCH_FAILED' | 'AUTHORITY_UNAVAILABLE' | 'BUDGET_EXCEEDED';
  searchModes: string[];
  vectorFallback?: boolean;
  candidateCount: number;
  selected: SceneMemorySelection[];
  rejected: { chunkId: string; reason: MemoryRejectionReason }[];
  budget: MemoryRetrievalBudget;
  memoryChars: number;
  estimatedMemoryTokens: number;
  retrievalRequests: number;
  embeddingRequests: number;
  missingRequiredEventIds: string[];
  missingForeshadowingIds: string[];
}

export interface SceneMemoryResult {
  evidence: RagRetrievedEvidenceItem[];
  diagnostics: SceneMemoryDiagnostics;
}
