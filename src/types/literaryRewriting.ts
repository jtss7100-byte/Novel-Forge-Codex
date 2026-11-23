import type { ChangeProposal, NarrativePerspective } from './foundation';
import type {
  RewriteSelectionAnchor,
  TokenUsageMetadata,
  WritingContextBundle,
} from './aiEngine';
import type { LiteraryQualityDimensionId } from './literaryQuality';

/**
 * 6 Literary Rewriting Modes (Phase 4.3B)
 */
export type LiteraryRewriteMode = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';

export type LiteraryRewriteAiDecision = 'REWRITTEN' | 'NO_OP_OPTIMAL';

export type LiteraryRewriteAuthorDecision =
  | 'PENDING'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'REGENERATE_REQUESTED';

export type LiteraryRewriteExecutionStatus =
  | 'NOT_RUN'
  | 'CANDIDATE_READY'
  | 'NO_OP_OPTIMAL'
  | 'BLOCKED_CONFLICT'
  | 'BLOCKED_MISSING_INFO'
  | 'REWRITE_FAILED';

/**
 * Phase 4.3B Stage 2 (P0-A): Server-Verified CANON Evidence Gate
 */
export type CanonEvidenceStatus =
  | 'VERIFIED'
  | 'VERIFIED_EMPTY'
  | 'UNAVAILABLE'
  | 'STALE'
  | 'UNAUTHORIZED';

export type CanonVerificationMode =
  | 'SERVER_AUTHORITY'
  | 'ISOLATED_TEST'
  | 'UNVERIFIED';

export interface CanonEvidenceReport {
  status: CanonEvidenceStatus;
  verificationMode: CanonVerificationMode;
  verifiedSourceIds: string[];
  staleSourceIds: string[];
  unverifiedClientClaimIds: string[];
  missingEvidenceNotes: string[];
  verifiedCanonCharacterIds: string[];
  verifiedCanonWorldbuildingIds: string[];
  verifiedRagChunkIds: string[];
  verifiedRevisionMap: Record<string, string>;
  canonStateHash: string;
  verifiedAt: string;
  safeForAutomaticAcceptance: false;
  fallbackTypoOnlyApplied?: boolean;
}

/**
 * Phase 4.3B Stage 2 (P0-B): Decoupled Manuscript Commit vs ChangeProposal Persistence Recovery
 */
export type RewritePersistenceStatus =
  | 'IDLE'
  | 'MANUSCRIPT_COMMIT_FAILED'
  | 'MANUSCRIPT_COMMITTED_PROPOSALS_PENDING'
  | 'MANUSCRIPT_AND_PROPOSALS_COMMITTED';

export type ProposalLookupStatus =
  | 'DOCUMENT_NOT_FOUND'
  | 'DOCUMENT_EXISTS_PROPOSED'
  | 'DOCUMENT_EXISTS_DECIDED'
  | 'SOURCE_REVISION_UNVERIFIED'
  | 'SOURCE_REVISION_MISMATCH'
  | 'SOURCE_REVISION_CONTENT_MISMATCH'
  | 'PERMISSION_DENIED'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_ERROR';

export type ProposalPersistenceErrorCode =
  | 'SOURCE_REVISION_NOT_FOUND'
  | 'SOURCE_REVISION_MISMATCH'
  | 'SOURCE_REVISION_UNVERIFIED'
  | 'SOURCE_REVISION_CONTENT_MISMATCH'
  | 'PROPOSAL_PAYLOAD_CONFLICT'
  | 'PROPOSAL_OWNER_MISMATCH'
  | 'PERMISSION_DENIED'
  | 'NETWORK_ERROR'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'UNKNOWN_ERROR';

export type ProposalImmutablePayload = Pick<
  ChangeProposal,
  | 'id'
  | 'ownerId'
  | 'projectId'
  | 'targetEntityType'
  | 'targetEntityId'
  | 'proposedAction'
  | 'title'
  | 'rationale'
  | 'beforeSummary'
  | 'afterSummary'
  | 'proposedPayloadJson'
  | 'triggerEpisodeId'
  | 'triggerSceneId'
  | 'sourceRevisionId'
  | 'createdBy'
>;

export interface PersistChangeProposalsOptions {
  /**
   * When true, enforces that each ChangeProposal's `sourceRevisionId` points
   * to an actually persisted Revision owned by the same user, project, and episode
   * (and matching content hash when provided).
   */
  requireVerifiedSourceRevision?: boolean;
  /** Expected episodeId constraint for revision verification (defaults to proposal.triggerEpisodeId). */
  expectedEpisodeId?: string;
  /** Optional explicit expected revisionId when all proposals bind to one commit. */
  expectedSourceRevisionId?: string;
  /** Expected SHA-256 content hash for the committed manuscript revision. */
  expectedSourceContentHash?: string;
  /** Optional per-revision expected SHA-256 content hash map (useful for multi-revision retries). */
  expectedContentHashByRevisionId?: Record<string, string>;
  /** Optional override to test cross-tenant revision path references directly against Firestore Rules. */
  sourceRevisionOwnerId?: string;
  /** Optional override to test cross-project revision path references directly against Firestore Rules. */
  sourceRevisionProjectId?: string;
}

export interface PersistedProposalItemResult {
  proposalId: string;
  idempotencyKey: string;
  status:
    | 'CREATED'
    | 'SKIPPED_ALREADY_EXISTS'
    | 'SKIPPED_ALREADY_DECIDED'
    | 'FAILED';
  lookupStatus?: ProposalLookupStatus;
  errorCode?: ProposalPersistenceErrorCode;
  errorMessage?: string;
}

export interface PersistChangeProposalsResult {
  attemptedCount: number;
  createdCount: number;
  skippedDuplicateCount: number;
  failedCount: number;
  failedProposals: ChangeProposal[];
  itemResults: PersistedProposalItemResult[];
}

export interface RewriteAcceptPersistenceState {
  candidateId: string;
  status: RewritePersistenceStatus;
  committedRevisionId: string | null;
  committedContentHash: string | null;
  manuscriptErrorMessage: string | null;
  pendingProposals: ChangeProposal[];
  savedProposalIds: string[];
  skippedDuplicateProposalIds: string[];
  proposalErrorMessage: string | null;
  updatedAt: string;
}

export interface LiteraryRewriteModeMeta {
  id: LiteraryRewriteMode;
  titleKo: string;
  shortLabelKo: string;
  descriptionKo: string;
  preserveFocusKo: string;
}

export interface LiteraryRewriteSelectionTarget {
  anchor: RewriteSelectionAnchor;
  recommendedModes: LiteraryRewriteMode[];
  linkedQualityFindingId?: string;
  linkedQualityDimension?: LiteraryQualityDimensionId;
  qualityProblemSummary?: string;
}

export interface LiteraryRewriteCanonAlert {
  severity: 'INFO' | 'WARNING' | 'CRITICAL_BLOCK';
  referenceLoreId: string | null;
  source: 'AI_MODEL' | 'SERVER_VERIFIER';
  description: string;
}

export interface LiteraryRewriteLengthDelta {
  originalChars: number;
  rewrittenChars: number;
  deltaChars: number;
  deltaRatioPercent: number;
  significantLengthShiftWarning: boolean;
}

/**
 * Deeper Korean Web Novel Literary Rubric Checks (separated from regex counters)
 */
export interface LiteraryRewriteRubricChecks {
  suddenEmotionalShiftRisk: boolean;
  dialogueCharacterFitPreserved: boolean;
  povKnowledgeLeakDetected: boolean;
  overExplanationCreepDetected: boolean;
  foreshadowingDeletionRisk: boolean;
  voiceHomogenizationRisk: boolean;
  emotionalSubtextPreserved: boolean;
  keyActionPreserved: boolean;
  rubricWarnings: string[];
  heuristicSignalNote: string;
}

export interface LiteraryRewriteQualityDelta {
  addressedQualityDimensions: LiteraryQualityDimensionId[];
  beforeClicheCount: number;
  afterClicheCount: number;
  beforeRepeatedStarterCount: number;
  afterRepeatedStarterCount: number;
  beforeDialogueRatioPercent: number;
  afterDialogueRatioPercent: number;
  perspectiveMaintained: boolean;
  characterVoicePreserved: boolean;
  canonConflictFree: boolean;
  rubricChecks?: LiteraryRewriteRubricChecks;
  summaryKo: string;
}

export interface LiteraryRewriteVerificationReport {
  anchorVerified: boolean;
  sourceContentHashMatched: boolean;
  sourceRevisionMatched: boolean;
  canonConflictChecked: boolean;
  forbiddenExpressionsChecked: boolean;
  perspectiveVerified: boolean;
  characterVoiceChecked: boolean;
  canonEvidence: CanonEvidenceReport;
  lengthDelta: LiteraryRewriteLengthDelta;
  qualityDelta: LiteraryRewriteQualityDelta;
  alerts: LiteraryRewriteCanonAlert[];
  hasBlockingViolation: boolean;
}

export interface LiteraryRewriteCandidate {
  candidateId: string;
  projectId: string;
  episodeId: string;
  sourceRunId: string;
  sourceRevisionId: string;
  sourceContentHash: string;
  anchor: RewriteSelectionAnchor;
  requestedModes: LiteraryRewriteMode[];
  appliedModes: LiteraryRewriteMode[];
  aiDecision: LiteraryRewriteAiDecision;
  noOpReason: string | null;
  originalExcerpt: string;
  rewrittenExcerpt: string;
  splicedPreviewManuscript: string;
  changeRationale: string;
  preservedElements: string[];
  perspectiveCheck: {
    expectedPerspective: NarrativePerspective;
    maintained: boolean;
    note: string;
  };
  characterVoiceNotes: string[];
  candidateProposals: ChangeProposal[];
  verification: LiteraryRewriteVerificationReport;
  authorDecision: LiteraryRewriteAuthorDecision;
  requiresAuthorApproval: true;
  appliedPromptVersionIds: string[];
  modelId: string;
  usageMetadata: TokenUsageMetadata;
  rewriteApiCallCount: number;
  createdAt: string;
}

export interface LiteraryRewriteRequest {
  ownerId?: string;
  projectId: string;
  episodeId: string;
  sourceRunId?: string;
  sourceRevisionId: string;
  manuscript: string;
  anchor: RewriteSelectionAnchor;
  modes: LiteraryRewriteMode[];
  authorInstruction?: string;
  linkedQualityFindingId?: string;
  linkedQualityDimension?: LiteraryQualityDimensionId;
  allowUnverifiedTypoOnlyPreview?: boolean;
  context: WritingContextBundle;
}

export interface LiteraryRewriteResponse {
  executionStatus: LiteraryRewriteExecutionStatus;
  candidate: LiteraryRewriteCandidate | null;
  canonEvidence?: CanonEvidenceReport;
  errorMessage?: string;
}

/**
 * Phase 4.3B Stage 2: Literary Quality & Blind A/B Evaluation Harness Types
 */
export type BlindAbPreference =
  | 'ORIGINAL_PREFERRED'
  | 'REWRITE_PREFERRED'
  | 'TIE'
  | 'NOT_RATED';

export interface LiteraryEvaluationCaseResult {
  caseId: string;
  titleKo: string;
  categoryKo: string;
  executionStatus: LiteraryRewriteExecutionStatus;
  aiDecision: LiteraryRewriteAiDecision | null;
  canonEvidenceStatus: CanonEvidenceStatus;
  hasBlockingViolation: boolean;
  perspectiveMaintained: boolean;
  rubricWarnings: string[];
  originalExcerpt: string;
  rewrittenExcerpt: string;
  latencyMs: number;
  usageMetadata: TokenUsageMetadata;
  errorMessage?: string;
}

export interface BlindAbPairItem {
  pairId: string;
  caseId: string;
  titleKo: string;
  categoryKo: string;
  precedingContext: string;
  followingContext: string;
  optionA: string;
  optionB: string;
  /** Stored hidden key for offline scoring aggregation (revealed only when unlocked by reviewer). */
  hiddenSideAssignment: 'A_ORIGINAL_B_REWRITE' | 'A_REWRITE_B_ORIGINAL';
  preference: BlindAbPreference;
  reviewerComment: string;
}

export interface LiveEvaluationRunReport {
  runId: string;
  executionMode: 'DISABLED' | 'DRY_RUN_FIXTURE' | 'LIVE_GEMINI';
  modelId: string;
  calledGeminiCount: number;
  maxCallsLimit: number;
  totalEstimatedCostUsd: number;
  totalTokens: number;
  results: LiteraryEvaluationCaseResult[];
  blindAbPairs: BlindAbPairItem[];
  executedAt: string;
  disabledReason?: string;
}
