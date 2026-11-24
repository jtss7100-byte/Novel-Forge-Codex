/**
 * NOVEL FORGE — Phase 1.5: Advanced System Foundation Types
 *
 * Defines the canonical status lifecycle, relational hierarchy links
 * (User -> Project -> Episode -> Scene -> Event -> Character -> Foreshadowing),
 * provenance/revision tracking, and the 6 advanced domain entities:
 * 1. Foreshadowing (복선 추적)
 * 2. CharacterRelationship (인물 관계)
 * 3. TimelineEvent (작품 연표)
 * 4. MemoryDocument / MemoryChunk (AI 장기 기억 검색)
 * 5. StyleProfile (문체 분석)
 * 6. ChangeProposal (AI 설정 변경 승인 요청)
 */

export type CanonStatus = 'DRAFT' | 'PROPOSED' | 'CANON' | 'REJECTED' | 'ARCHIVED';
export type LegacySettingStatus = 'draft' | 'confirmed';
export type UnifiedSettingStatus = LegacySettingStatus | CanonStatus;

export type ActorType = 'AUTHOR' | 'AI_ENGINE' | 'SYSTEM';

export type SourceEntityType =
  | 'PROJECT'
  | 'EPISODE'
  | 'SCENE'
  | 'CHARACTER'
  | 'WORLDBUILDING'
  | 'FORESHADOWING'
  | 'RELATIONSHIP'
  | 'TIMELINE_EVENT'
  | 'STYLE_PROFILE';

/**
 * Tracks the origin and exact manuscript revision snapshot of any entity.
 */
export interface DataProvenance {
  sourceType: 'MANUSCRIPT' | 'AUTHOR_INPUT' | 'AI_PROPOSAL' | 'IMPORT';
  createdBy: ActorType;
  ownerId: string;
  projectId: string;
  episodeId?: string | null;
  sceneId?: string | null;
  eventId?: string | null;
  revisionId?: string | null;
  excerpt?: string;
}

/**
 * ID-based hierarchical link graph:
 * User -> Project -> Episode -> Scene -> Event -> Character -> Foreshadowing
 */
export interface EntityHierarchyLinks {
  userId: string;
  projectId: string;
  episodeIds: string[];
  sceneIds: string[];
  eventIds: string[];
  characterIds: string[];
  foreshadowingIds: string[];
}

/**
 * Scene (회차 내 장면 단위: 회차 -> 장면 -> 사건 연결)
 */
export interface Scene {
  id: string;
  ownerId: string;
  projectId: string;
  episodeId: string;
  sceneNumber: number;
  title: string;
  summary: string;
  location: string;
  pointOfViewCharacterId: string;
  eventIds: string[];
  characterIds: string[];
  foreshadowingIds: string[];
  canonStatus: CanonStatus;
  sourceRevisionId: string;
  memoryKnowledge?: SceneMemoryKnowledge;
  createdAt: string;
  updatedAt: string;
}

/**
 * 1. Foreshadowing — 복선 추적
 */
export type ForeshadowingPhase = 'PLANTED' | 'REINFORCED' | 'RESOLVED' | 'ABANDONED';

export interface Foreshadowing {
  id: string;
  ownerId: string;
  projectId: string;
  title: string;
  description: string;
  cluePhase: ForeshadowingPhase;
  canonStatus: CanonStatus;
  plantedEpisodeId: string;
  plantedSceneId: string;
  resolvedEpisodeId: string;
  resolvedSceneId: string;
  relatedEventIds: string[];
  relatedCharacterIds: string[];
  sourceRevisionId: string;
  memoryKnowledge?: SceneMemoryKnowledge;
  createdBy: ActorType;
  createdAt: string;
  updatedAt: string;
}

/**
 * 2. CharacterRelationship — 인물 관계
 */
export interface CharacterRelationship {
  id: string;
  ownerId: string;
  projectId: string;
  sourceCharacterId: string;
  targetCharacterId: string;
  relationType: string;
  affinityScore: number; // -100 to +100
  isDirectional: boolean;
  description: string;
  canonStatus: CanonStatus;
  effectiveEpisodeId: string;
  effectiveEventId: string;
  sourceRevisionId: string;
  memoryKnowledge?: SceneMemoryKnowledge;
  createdBy: ActorType;
  createdAt: string;
  updatedAt: string;
}

/**
 * 3. TimelineEvent — 작품 연표 (사건 단위)
 */
export interface TimelineEvent {
  id: string;
  ownerId: string;
  projectId: string;
  title: string;
  summary: string;
  inUniverseDate: string;
  chronologicalOrder: number;
  episodeId: string;
  sceneId: string;
  participantCharacterIds: string[];
  linkedForeshadowingIds: string[];
  linkedWorldbuildingIds: string[];
  canonStatus: CanonStatus;
  sourceRevisionId: string;
  memoryKnowledge?: SceneMemoryKnowledge;
  createdBy: ActorType;
  createdAt: string;
  updatedAt: string;
}

/**
 * 4. MemoryDocument & MemoryChunk — AI 장기 기억 검색 (Phase 3 Persistent RAG Engine)
 */
export type MemorySourceEntityType =
  | 'EPISODE'
  | 'EPISODE_SUMMARY'
  | 'SCENE'
  | 'CHARACTER'
  | 'CHARACTER_STATE_CHANGE'
  | 'WORLDBUILDING'
  | 'TIMELINE_EVENT'
  | 'FORESHADOWING'
  | 'RELATIONSHIP';

export type MemoryIndexStatus =
  | 'NOT_INDEXED'
  | 'INDEXING'
  | 'INDEXED'
  | 'STALE'
  | 'FAILED'
  | 'PENDING_DELETE';

export type MemoryEntityLifecycleStatus =
  | 'ACTIVE'
  | 'REINDEXING_KEEP_OLD'
  | 'PENDING_DELETE'
  | 'DELETED';

export type EmbeddingGenerationMode = 'LIVE_API' | 'DETERMINISTIC_TEST';

export type MemorySourceFreshness =
  | 'FRESH'
  | 'STALE'
  | 'SOURCE_UNVERIFIED';

export type MemoryCanonFilterType =
  | 'CANON'
  | 'NON_CANON_EXCEPTION'
  | 'DRAFT';

export type MemorySearchMode = 'HYBRID' | 'SEMANTIC' | 'KEYWORD';

export type RagActivationMode = 'INLINE_DOC' | 'MANIFEST_POINTER';

export type RagGenerationStagingStatus =
  | 'PREPARING'
  | 'STAGED'
  | 'VERIFIED'
  | 'ACTIVATED'
  | 'ABORTED'
  | 'CLEANUP_PENDING'
  | 'CLEANUP_COMPLETED';

export interface RagGenerationStagingReceipt {
  id: string;
  ownerId: string;
  projectId: string;
  entityKey: string;
  sourceEntityType: MemorySourceEntityType;
  sourceEntityId: string;
  generation: number;
  activationMode: RagActivationMode;
  status: RagGenerationStagingStatus;
  expectedDocumentIds: string[];
  expectedDocumentCount: number;
  expectedChunkCount: number;
  expectedContentHash: string;
  expectedSourceRevisionId: string;
  stagedDocumentCount: number;
  stagedChunkCount: number;
  verifiedDocumentCount: number;
  verifiedChunkCount: number;
  batchesCommitted: number;
  targetTaskId?: string;
  targetLeaseGeneration?: number;
  activationToken?: string;
  cleanupOperationId?: string;
  cleanupEpoch?: number;
  cleanupOwner?: string;
  cleanupClaimedAt?: string;
  cleanupLeaseExpiresAt?: string;
  cleanupLeaseExpiresAtMs?: number;
  cleanupCompletedAt?: string;
  cleanupTargetDocumentIds?: string[];
  deletedDocumentCount?: number;
  deletedChunkCount?: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string;
  activatedAt?: string;
}

export interface MemoryDocument {
  id: string;
  /** Alias for id required by Phase 3 schema */
  documentId?: string;
  /** Logical pre-generation document ID (preserved alongside generation-scoped physical id) */
  logicalDocumentId?: string;
  ownerId: string;
  projectId: string;
  sourceEntityType: MemorySourceEntityType;
  sourceEntityId: string;
  sourceRevisionId: string;
  sourceEpisodeId?: string;
  sourceSceneId?: string;
  episodeNumber?: number;
  title: string;
  summary?: string;
  fullText: string;
  keywordTags?: string[];
  chunkCount: number;
  canonStatus: CanonStatus;
  canonFilterType?: MemoryCanonFilterType;
  indexVersion?: number;
  indexGeneration?: number;
  isActiveGeneration?: boolean;
  activationMode?: RagActivationMode;
  stagingId?: string;
  lifecycleStatus?: MemoryEntityLifecycleStatus;
  embeddingModelId?: string;
  embeddingDimension?: number;
  embeddingGenerationMode?: EmbeddingGenerationMode;
  indexedAt?: string;
  contentHash?: string;
  indexStatus?: MemoryIndexStatus;
  lastIndexError?: string;
  partIndex?: number;
  totalParts?: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryChunk {
  id: string;
  /** Alias for id required by Phase 3 schema */
  chunkId?: string;
  /** Logical pre-generation document ID for provenance across generations */
  logicalDocumentId?: string;
  ownerId: string;
  projectId: string;
  documentId: string;
  sourceEntityType: MemorySourceEntityType;
  sourceEntityId: string;
  sourceRevisionId: string;
  sourceEpisodeId?: string;
  sourceSceneId?: string;
  chunkIndex: number;
  content: string;
  /** Alias for content required by Phase 3 schema */
  originalText?: string;
  /** Alias for content used in UI */
  chunkText?: string;
  embedding?: number[];
  embeddingModelId?: string;
  embeddingDimension?: number;
  embeddingGenerationMode?: EmbeddingGenerationMode;
  indexGeneration?: number;
  isActiveGeneration?: boolean;
  activationMode?: RagActivationMode;
  stagingId?: string;
  lifecycleStatus?: MemoryEntityLifecycleStatus;
  sourceStartOffset?: number;
  sourceEndOffset?: number;
  tokenEstimate: number;
  keywords: string[];
  episodeId: string;
  episodeNumber?: number;
  sceneId: string;
  characterIds: string[];
  /** Alias for characterIds required by Phase 3 schema */
  relatedCharacterIds?: string[];
  relatedEventIds?: string[];
  foreshadowingIds: string[];
  /** Alias for foreshadowingIds required by Phase 3 schema */
  relatedForeshadowingIds?: string[];
  canonStatus: CanonStatus;
  canonFilterType?: MemoryCanonFilterType;
  contentHash?: string;
  createdAt: string;
}

/**
 * 5. StyleProfile — 문체 분석 프로필
 */
export type NarrativePerspective =
  | 'FIRST_PERSON'
  | 'THIRD_LIMITED'
  | 'OMNISCIENT'
  | 'MIXED';

export interface StyleProfile {
  id: string;
  ownerId: string;
  projectId: string;
  name: string;
  narrativePerspective: NarrativePerspective;
  dialogueRatio: number; // 0 to 100
  avgSentenceLength: number; // 0 to 1000
  toneKeywords: string[];
  preferredExpressions: string[];
  prohibitedExpressions: string[];
  sampleExcerpt: string;
  canonStatus: CanonStatus;
  sourceRevisionId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 6. ChangeProposal — AI 설정 변경 승인 요청
 */
export type ProposalTargetEntityType =
  | 'CHARACTER'
  | 'WORLDBUILDING'
  | 'EPISODE'
  | 'SCENE'
  | 'FORESHADOWING'
  | 'RELATIONSHIP'
  | 'TIMELINE_EVENT'
  | 'STYLE_PROFILE';

export type ProposedActionType = 'CREATE' | 'UPDATE' | 'ARCHIVE';

export interface ChangeProposal {
  id: string;
  ownerId: string;
  projectId: string;
  targetEntityType: ProposalTargetEntityType;
  targetEntityId: string;
  proposedAction: ProposedActionType;
  title: string;
  rationale: string;
  beforeSummary: string;
  afterSummary: string;
  proposedPayloadJson: string;
  canonStatus: CanonStatus; // 'PROPOSED' | 'CANON' | 'REJECTED' | 'ARCHIVED'
  triggerEpisodeId: string;
  triggerSceneId: string;
  sourceRevisionId: string;
  createdBy: ActorType;
  reviewedAt: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Extended Foundation Bundle (backward-compatible optional fields on ProjectBundle)
 */
export interface AdvancedFoundationCollections {
  scenes?: Scene[];
  foreshadowings?: Foreshadowing[];
  relationships?: CharacterRelationship[];
  timelineEvents?: TimelineEvent[];
  memoryDocuments?: MemoryDocument[];
  memoryChunks?: MemoryChunk[];
  styleProfiles?: StyleProfile[];
  changeProposals?: ChangeProposal[];
}
import type { SceneMemoryKnowledge } from './sceneMemory';
