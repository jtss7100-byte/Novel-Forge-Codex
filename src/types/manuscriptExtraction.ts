import type {
  CanonStatus,
  ChangeProposal,
  CharacterRelationship,
  DataProvenance,
  Foreshadowing,
  ForeshadowingPhase,
  TimelineEvent,
} from './foundation';
import type { TokenUsageMetadata } from './aiEngine';

export type ExtractionExecutionMode =
  | 'CLOUD_AUTHENTICATED'
  | 'LOCAL_PREVIEW'
  | 'TEST_ISOLATED';

export type ExtractionCandidateType =
  | 'RELATIONSHIP'
  | 'TIMELINE_EVENT'
  | 'FORESHADOWING';

export type ExtractionActionType = 'CREATE' | 'UPDATE';

export type ExcerptVerificationStatus =
  | 'VERIFIED'
  | 'AMBIGUOUS_MULTIPLE_MATCHES'
  | 'UNVERIFIED_EXCERPT';

export type ExcerptMatchMethod = 'EXACT' | 'WHITESPACE_NORMALIZED' | 'NONE';

export type TemporalContextType =
  | 'PRESENT_EVENT'
  | 'FLASHBACK'
  | 'PAST_MENTION'
  | 'PROPHECY_OR_RUMOR'
  | 'HYPOTHETICAL_OR_DREAM';

export type ExtractionUncertaintyFlag =
  | 'AMBIGUOUS_CHARACTER_REFERENCE'
  | 'HOMONYM_CHARACTER_NAME'
  | 'NEW_UNREGISTERED_CHARACTER'
  | 'DIALOGUE_CLAIM_ONLY'
  | 'FLASHBACK_OR_PAST_MENTION'
  | 'RUMOR_OR_PROPHECY'
  | 'CONFLICTS_WITH_CANON'
  | 'TIMELINE_ORDER_UNCERTAIN'
  | 'CLUE_PHASE_UNCERTAIN';

/**
 * UTF-16 code unit offset span verified directly against Revision.content on the server.
 * Invariant: 0 <= startOffset < endOffset <= revisionContent.length
 * and revisionContent.slice(startOffset, endOffset) === matchedText.
 */
export interface ServerVerifiedExcerptSpan {
  startOffset: number;
  endOffset: number;
  matchedText: string;
  matchMethod: 'EXACT' | 'WHITESPACE_NORMALIZED';
}

export type VerifiedExcerptPayload = ServerVerifiedExcerptSpan;

export interface ExcerptVerificationResult {
  status: ExcerptVerificationStatus;
  verifiedSpan: ServerVerifiedExcerptSpan | null;
  candidateSpans: ServerVerifiedExcerptSpan[];
  reason?: string;
}

export interface AiRawRelationshipPayload {
  sourceCharacterId: string | null;
  sourceCharacterName: string;
  targetCharacterId: string | null;
  targetCharacterName: string;
  relationType: string;
  affinityScore: number;
  isDirectional: boolean;
  description: string;
}

export interface AiRawTimelineEventPayload {
  title: string;
  summary: string;
  inUniverseDate: string;
  chronologicalOrder: number | null;
  involvedCharacterIds: string[];
  involvedCharacterNames: string[];
  locationWorldItemId: string | null;
  locationName: string | null;
}

export interface AiRawForeshadowingPayload {
  title: string;
  description: string;
  cluePhase: Extract<ForeshadowingPhase, 'PLANTED' | 'REINFORCED' | 'RESOLVED'>;
  relatedCharacterIds: string[];
  relatedCharacterNames: string[];
  relatedEventIds: string[];
  payoffNote: string;
}

export interface AiRawExtractionCandidate {
  targetEntityType: ExtractionCandidateType;
  proposedAction: ExtractionActionType;
  existingTargetEntityId: string | null;
  title: string;
  rationale: string;
  beforeSummary: string;
  afterSummary: string;
  excerpt: string;
  precedingContext: string | null;
  followingContext: string | null;
  sceneId: string | null;
  confidence: number;
  dialogueClaimOnly: boolean;
  temporalContextType: TemporalContextType;
  uncertaintyFlags: ExtractionUncertaintyFlag[];
  relationshipPayload: AiRawRelationshipPayload | null;
  timelineEventPayload: AiRawTimelineEventPayload | null;
  foreshadowingPayload: AiRawForeshadowingPayload | null;
}

export interface AiRawExtractionResponse {
  analysis_summary: string;
  candidates: AiRawExtractionCandidate[];
}

export type CanonConflictType =
  | 'AFFINITY_DIRECTION_REVERSAL'
  | 'CANON_RELATIONSHIP_OVERWRITE'
  | 'CANON_EVENT_ORDER_CONFLICT'
  | 'CANON_FORESHADOWING_PHASE_REGRESSION'
  | 'MISSING_UPDATE_TARGET';

export interface CanonConflictNotice {
  conflictType: CanonConflictType;
  existingEntityId: string;
  existingCanonStatus: CanonStatus;
  message: string;
}

export type DuplicateProposalStatus =
  | 'NONE'
  | 'EXISTING_PROPOSED'
  | 'EXISTING_CANON_APPLIED'
  | 'EXISTING_REJECTED';

export interface ExtractedRelationshipDraftPayload {
  id: string;
  ownerId: string;
  projectId: string;
  sourceCharacterId: string;
  sourceCharacterName: string;
  targetCharacterId: string;
  targetCharacterName: string;
  relationType: string;
  affinityScore: number;
  isDirectional: boolean;
  description: string;
  canonStatus: 'PROPOSED';
  lastChangedEpisodeId: string;
  sourceRevisionId: string;
  provenance: DataProvenance;
}

export interface ExtractedTimelineEventDraftPayload {
  id: string;
  ownerId: string;
  projectId: string;
  title: string;
  summary: string;
  episodeId: string;
  sceneId: string;
  inUniverseDate: string;
  chronologicalOrder: number;
  involvedCharacterIds: string[];
  involvedCharacterNames: string[];
  locationWorldItemId: string;
  locationName: string;
  canonStatus: 'PROPOSED';
  sourceRevisionId: string;
  provenance: DataProvenance;
}

export interface ExtractedForeshadowingDraftPayload {
  id: string;
  ownerId: string;
  projectId: string;
  title: string;
  description: string;
  cluePhase: ForeshadowingPhase;
  canonStatus: 'PROPOSED';
  plantedEpisodeId: string;
  plantedSceneId: string;
  resolvedEpisodeId: string;
  resolvedSceneId: string;
  relatedCharacterIds: string[];
  relatedCharacterNames: string[];
  relatedEventIds: string[];
  payoffNote: string;
  sourceRevisionId: string;
  provenance: DataProvenance;
}

export interface ChangeProposalPayloadEnvelope {
  schemaVersion: 'PHASE_4_2_1_V1';
  fingerprint: string;
  targetEntityType: ExtractionCandidateType;
  proposedAction: ExtractionActionType;
  targetEntityId: string;
  sourceEpisodeId: string;
  sourceRevisionId: string;
  sourceSceneId: string;
  verifiedExcerpt: {
    excerpt: string;
    matchedText: string;
    startOffset: number;
    endOffset: number;
    matchMethod: 'EXACT' | 'WHITESPACE_NORMALIZED';
  };
  precedingContext: string | null;
  followingContext: string | null;
  confidence: number;
  dialogueClaimOnly: boolean;
  temporalContextType: TemporalContextType;
  uncertaintyFlags: ExtractionUncertaintyFlag[];
  canonConflicts: CanonConflictNotice[];
  provenance: DataProvenance;
  relationshipDraft?: ExtractedRelationshipDraftPayload;
  timelineEventDraft?: ExtractedTimelineEventDraftPayload;
  foreshadowingDraft?: ExtractedForeshadowingDraftPayload;
  existingEntitySnapshot?:
    | Partial<CharacterRelationship>
    | Partial<TimelineEvent>
    | Partial<Foreshadowing>
    | null;
}

export interface VerifiedExtractionCandidate {
  candidateId: string;
  fingerprint: string;
  targetEntityType: ExtractionCandidateType;
  proposedAction: ExtractionActionType;
  targetEntityId: string;
  title: string;
  rationale: string;
  beforeSummary: string;
  afterSummary: string;
  excerpt: string;
  precedingContext: string | null;
  followingContext: string | null;
  sceneId: string;
  confidence: number;
  dialogueClaimOnly: boolean;
  temporalContextType: TemporalContextType;
  uncertaintyFlags: ExtractionUncertaintyFlag[];
  verification: ExcerptVerificationResult;
  canonConflicts: CanonConflictNotice[];
  duplicateStatus: DuplicateProposalStatus;
  existingProposalId: string | null;
  canSaveAsProposal: boolean;
  cannotSaveReason?: string;
  payloadEnvelope: ChangeProposalPayloadEnvelope | null;
  proposalDraft: ChangeProposal | null;
}

export interface LocalPreviewSnapshotInput {
  project: {
    id: string;
    ownerId?: string;
    title: string;
  };
  episode: {
    id: string;
    projectId: string;
    episodeNumber: number;
    title: string;
    currentRevisionId: string;
  };
  revision: {
    id: string;
    episodeId: string;
    projectId: string;
    content: string;
    CanonStatus?: CanonStatus;
    canonStatus?: CanonStatus;
  };
  scenes?: Array<{
    id: string;
    episodeId: string;
    sceneNumber: number;
    title: string;
    summary: string;
    location: string;
  }>;
  characters?: Array<{
    id: string;
    name: string;
    role: string;
    description: string;
    canonStatus?: CanonStatus;
  }>;
  worldbuilding?: Array<{
    id: string;
    title: string;
    category: string;
    content: string;
    canonStatus?: CanonStatus;
  }>;
  relationships?: CharacterRelationship[];
  timelineEvents?: TimelineEvent[];
  foreshadowings?: Foreshadowing[];
  existingProposals?: ChangeProposal[];
}

export interface ManuscriptExtractionRequest {
  projectId: string;
  episodeId: string;
  revisionId: string;
  sceneId?: string;
  persistProposals?: boolean;
  selectedCandidateIds?: string[];
  selectedCandidateSpanOverrides?: Record<
    string,
    { startOffset: number; endOffset: number }
  >;
  allowUpdateRejected?: boolean;
  localPreviewSnapshot?: LocalPreviewSnapshotInput;
}

export interface ManuscriptExtractionAuditMetadata {
  requestId: string;
  executionMode: ExtractionExecutionMode;
  isCloudVerified: boolean;
  ownerId: string;
  projectId: string;
  episodeId: string;
  revisionId: string;
  modelId: string;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  totalRawCandidates: number;
  verifiedCount: number;
  ambiguousCount: number;
  unverifiedCount: number;
  duplicateSkippedCount: number;
  persistedProposalCount: number;
  tokenUsage: TokenUsageMetadata | null;
}

export interface ManuscriptExtractionResponse {
  success: boolean;
  executionMode: ExtractionExecutionMode;
  isCloudVerified: boolean;
  analysisRunId: string;
  analysisToken: string;
  analysisSummary: string;
  episodeId: string;
  revisionId: string;
  revisionContentHash: string;
  revisionLength: number;
  candidates: VerifiedExtractionCandidate[];
  savedProposals: ChangeProposal[];
  audit: ManuscriptExtractionAuditMetadata;
}

export type ProposalSaveDisposition =
  | 'CREATED_NEW'
  | 'SKIPPED_EXISTING_PROPOSED'
  | 'SKIPPED_EXISTING_CANON'
  | 'SKIPPED_EXISTING_REJECTED'
  | 'SKIPPED_EXISTING_ARCHIVED';

export interface SavedProposalItemResult {
  candidateId: string;
  proposalId: string;
  fingerprint: string;
  disposition: ProposalSaveDisposition;
  proposal: ChangeProposal;
}

export interface SaveExtractionProposalsRequest {
  projectId: string;
  episodeId: string;
  revisionId: string;
  analysisRunId: string;
  analysisToken: string;
  selectedCandidateIds: string[];
  selectedCandidateSpanOverrides?: Record<
    string,
    { startOffset: number; endOffset: number }
  >;
  localPreviewSnapshot?: LocalPreviewSnapshotInput;
}

export interface SaveExtractionProposalsResponse {
  success: boolean;
  executionMode: ExtractionExecutionMode;
  isCloudVerified: boolean;
  analysisRunId: string;
  projectId: string;
  episodeId: string;
  revisionId: string;
  selectedCount: number;
  createdCount: number;
  skippedDuplicateCount: number;
  savedProposals: ChangeProposal[];
  itemResults: SavedProposalItemResult[];
  completedAt: string;
}

