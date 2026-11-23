import type {
  CanonStatus,
  ChangeProposal,
  CharacterRelationship,
  Foreshadowing,
  ProposedActionType,
  ProposalTargetEntityType,
  TimelineEvent,
} from './foundation';
import type {
  ExtractionExecutionMode,
  VerifiedExcerptPayload,
} from './manuscriptExtraction';

export type ApprovalTargetEntityType = Extract<
  ProposalTargetEntityType,
  'RELATIONSHIP' | 'TIMELINE_EVENT' | 'FORESHADOWING'
>;

export type ApprovalActionType = Extract<
  ProposedActionType,
  'CREATE' | 'UPDATE'
>;

export type ChangeProposalApprovalStatus =
  | 'APPROVED_APPLIED'
  | 'ALREADY_APPROVED'
  | 'REJECTED'
  | 'ALREADY_REJECTED';

export type ApprovalWorkspaceState =
  | 'IDLE'
  | 'LOADING_PREVIEW'
  | 'READY_FOR_REVIEW'
  | 'APPROVING'
  | 'APPROVED'
  | 'REJECTING'
  | 'REJECTED'
  | 'CONFLICT'
  | 'FAILED';

export type ApprovalConflictCode =
  | 'STALE_TARGET'
  | 'STALE_OVERRIDE_FORBIDDEN'
  | 'CONFLICT_REQUIRES_REVIEW'
  | 'AUDIT_STATE_INCONSISTENCY'
  | 'TARGET_ALREADY_EXISTS'
  | 'TARGET_NOT_FOUND'
  | 'REVISION_NOT_FOUND'
  | 'EXCERPT_OFFSET_INVALID'
  | 'INVALID_PROPOSAL_STATE'
  | 'UNSUPPORTED_ENTITY_OR_ACTION'
  | 'PAYLOAD_INTEGRITY_ERROR'
  | 'REFERENCE_INTEGRITY_ERROR'
  | 'TRANSACTION_READ_FAILED'
  | 'PROPOSAL_NOT_PENDING'
  | 'CLOUD_AUTH_REQUIRED'
  | 'SERVER_VERIFICATION_FAILED'
  | 'LOCAL_PREVIEW_UNVERIFIED';

export type ApprovalRagSyncStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'SYNCED'
  | 'FAILED'
  | 'SUPERSEDED'
  | 'NOT_REQUIRED';

export type DurableRagErrorCode =
  | 'FIRESTORE_WRITE_FAILED'
  | 'FIRESTORE_BATCH_COMMIT_FAILED'
  | 'FIRESTORE_MANIFEST_ACTIVATION_FAILED'
  | 'FIRESTORE_DURABILITY_NOT_VERIFIED'
  | 'RAG_ACTIVE_GENERATION_MISMATCH'
  | 'RAG_INDEX_DOCUMENT_NOT_FOUND'
  | 'RAG_INDEX_ACTIVATION_CONFLICT';

export interface DurableRagCommitPolicy {
  requireDurableCloudCommit: boolean;
  requireActiveGenerationVerification: boolean;
}

export type RagIntegrityAnomalyCode =
  | 'STATE_A_APPROVED_WITHOUT_RAG_TASK'
  | 'STATE_B_TASK_SYNCED_WITHOUT_ACTIVE_INDEX'
  | 'STATE_C_AUDIT_SYNCED_BUT_TASK_FAILED'
  | 'STATE_D_CANON_UPDATED_INDEX_STALE'
  | 'STATE_E_PROCESSING_LEASE_EXPIRED'
  | 'STATE_F_INACTIVE_STAGED_DOCUMENTS_REMAINING'
  | 'CANON_WITHOUT_SYNCED_TASK'
  | 'SYNCED_TASK_MISSING_MEMORY_DOCUMENT'
  | 'MANIFEST_GENERATION_MISMATCH'
  | 'EXPIRED_PROCESSING_LEASE'
  | 'SUPERSEDED_TASK_NEEDS_LATEST_SYNC'
  | 'UNAPPROVED_PROPOSAL_CANON_VIOLATION';

export interface RagIntegrityDiagnosticItem {
  code: RagIntegrityAnomalyCode;
  proposalId?: string;
  auditId?: string;
  taskId?: string;
  targetEntityType?: ApprovalTargetEntityType;
  targetEntityId?: string;
  documentId?: string;
  message: string;
  recoverable?: boolean;
  recovered: boolean;
  recoveryAction?: string;
}

export interface RagIntegrityDiagnosticReport {
  projectId: string;
  ownerId?: string;
  checkedAt: string;
  healthy: boolean;
  anomalies: RagIntegrityDiagnosticItem[];
  recoveredCount: number;
}

export type ChangeProposalFieldChangeType =
  | 'ADDED'
  | 'MODIFIED'
  | 'UNCHANGED';

export interface ChangeProposalFieldDiff {
  fieldName: string;
  fieldKey?: string;
  fieldLabel: string;
  label?: string;
  beforeValue: string | number | boolean | string[] | null;
  afterValue: string | number | boolean | string[] | null;
  beforeDisplayText?: string;
  afterDisplayText?: string;
  changeType: ChangeProposalFieldChangeType;
  isConflict: boolean;
  conflict?: boolean;
  conflictReason?: string;
}

export interface ApprovalConflictDetails {
  conflictCode?: ApprovalConflictCode;
  targetEntityId?: string;
  changedFields: string[];
  snapshotSummary?: Record<string, unknown> | null;
  currentEntitySummary?: Record<string, unknown> | null;
  requiresReview?: boolean;
  proposalSourceRevisionId?: string;
  currentEntitySourceRevisionId?: string;
}

export interface ChangeProposalApprovalOverrides {
  title?: string;
  rationale?: string;
  relationshipOverride?: Partial<{
    relationType: string;
    affinityScore: number;
    isDirectional: boolean;
    description: string;
    effectiveEventId: string;
  }>;
  timelineEventOverride?: Partial<{
    title: string;
    summary: string;
    inUniverseDate: string;
    chronologicalOrder: number;
    sceneId: string;
    participantCharacterIds: string[];
    linkedWorldbuildingIds: string[];
    linkedForeshadowingIds: string[];
  }>;
  foreshadowingOverride?: Partial<{
    title: string;
    description: string;
    cluePhase: Foreshadowing['cluePhase'];
    plantedEpisodeId: string;
    plantedSceneId: string;
    resolvedEpisodeId: string;
    resolvedSceneId: string;
    relatedCharacterIds: string[];
    relatedEventIds: string[];
    payoffNote: string;
  }>;
}

export interface ChangeProposalPreviewRequest {
  projectId: string;
  proposalId: string;
  expectedUpdatedAt?: string;
  overrides?: ChangeProposalApprovalOverrides;
}

export interface ChangeProposalApprovalRequest {
  projectId: string;
  proposalId: string;
  expectedUpdatedAt?: string;
  reviewNote?: string;
  /**
   * @deprecated Phase 4.2.2 Stage 1.5 strictly blocks `forceApplyOnStale` in general approval requests
   * with `STALE_OVERRIDE_FORBIDDEN`. Kept as optional field only so server can detect and reject bypass attempts.
   */
  forceApplyOnStale?: boolean;
  overrides?: ChangeProposalApprovalOverrides;
}

export interface ChangeProposalRejectionRequest {
  projectId: string;
  proposalId: string;
  expectedUpdatedAt?: string;
  reviewNote?: string;
}

/**
  * Audit document stored in:
  * users/{uid}/projects/{projectId}/changeProposalApprovalAudits/{auditId}
  *
  * Strictly written only by the server Admin SDK inside the atomic approval/rejection transaction
  * (with ragSyncStatus updated post-commit by the server RAG sync service).
  * Client SDK has read-only access (get/list) for the verified owner and 0 write permissions.
  */
export interface ChangeProposalApprovalAudit {
  id: string;
  ownerId: string;
  projectId: string;
  proposalId: string;
  decision: 'APPROVED' | 'REJECTED';
  targetEntityType: ApprovalTargetEntityType;
  targetEntityId: string;
  proposedAction: ApprovalActionType;
  triggerEpisodeId?: string;
  sourceRevisionId: string;
  sourceSceneId?: string;
  proposalFingerprint?: string;
  reviewerUid: string;
  reviewNote: string;
  beforeCanonStatus: CanonStatus | null;
  afterCanonStatus: CanonStatus;
  beforeSnapshotJson: string;
  afterSnapshotJson: string;
  verifiedExcerptJson: string;
  payoffNote?: string;
  ragSyncStatus: ApprovalRagSyncStatus;
  ragSyncError?: string;
  createdAt: string;
  updatedAt: string;
}

export type AppliedCanonEntity =
  | CharacterRelationship
  | TimelineEvent
  | Foreshadowing;

export interface ChangeProposalPreviewResponse {
  success: boolean;
  ok?: boolean;
  executionMode: ExtractionExecutionMode;
  isCloudVerified: boolean;
  isLocalReferenceOnly?: boolean;
  canApprove: boolean;
  conflictCode: ApprovalConflictCode | null;
  conflictMessage: string | null;
  conflictDetails: ApprovalConflictDetails | null;
  projectId: string;
  proposalId: string;
  targetEntityType: ApprovalTargetEntityType;
  targetEntityId: string;
  proposedAction: ApprovalActionType;
  proposal: ChangeProposal;
  beforeEntity: AppliedCanonEntity | null;
  afterEntityPreview: AppliedCanonEntity | null;
  fieldDiffs: ChangeProposalFieldDiff[];
  verifiedExcerpt: VerifiedExcerptPayload | null;
  sourceRevisionId: string;
  sourceEpisodeId: string;
  sourceSceneId: string;
  payoffNote: string;
  expectedUpdatedAt: string | null;
  entityDisplayNameMap: Record<string, string>;
  previewedAt: string;
}

export interface ChangeProposalApprovalResponse {
  success: boolean;
  ok?: boolean;
  decision?: 'APPROVED';
  executionMode: ExtractionExecutionMode;
  isCloudVerified: boolean;
  status: ChangeProposalApprovalStatus;
  projectId: string;
  proposalId: string;
  targetEntityType: ApprovalTargetEntityType;
  targetEntityId: string;
  proposedAction: ApprovalActionType;
  proposal: ChangeProposal;
  appliedEntity: AppliedCanonEntity | null;
  auditRecord: ChangeProposalApprovalAudit;
  ragSyncStatus: ApprovalRagSyncStatus;
  completedAt: string;
}

export interface ChangeProposalRejectionResponse {
  success: boolean;
  ok?: boolean;
  decision?: 'REJECTED';
  executionMode: ExtractionExecutionMode;
  isCloudVerified: boolean;
  status: 'REJECTED' | 'ALREADY_REJECTED';
  projectId: string;
  proposalId: string;
  targetEntityType: ApprovalTargetEntityType;
  targetEntityId: string;
  proposedAction: ApprovalActionType;
  proposal: ChangeProposal;
  auditRecord: ChangeProposalApprovalAudit;
  completedAt: string;
}

export type RagSyncTaskStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'SYNCED'
  | 'FAILED'
  | 'SUPERSEDED';

export interface RagSyncTaskRecord {
  id: string;
  ownerId: string;
  projectId: string;
  proposalId: string;
  auditId: string;
  targetEntityType: ApprovalTargetEntityType;
  targetEntityId: string;
  sourceRevisionId: string;
  expectedSourceRevisionId?: string;
  expectedEntityUpdatedAt?: string;
  expectedContentHash?: string;
  status: RagSyncTaskStatus;
  attemptCount: number;
  maxAttempts: number;
  manualRetryCount?: number;
  leaseOwner: string;
  leaseGeneration: number;
  leaseExpiresAtMs: number;
  nextRetryAfterMs: number;
  lastError: string;
  memoryDocumentId: string;
  createdAt: string;
  updatedAt: string;
}

export interface RagSyncExecutionRequest {
  projectId: string;
  proposalId?: string;
  auditId?: string;
  taskId?: string;
  workerId?: string;
  leaseDurationMs?: number;
  forceRetry?: boolean;
  manualRetry?: boolean;
}

export interface RagSyncExecutionResponse {
  success: boolean;
  ok?: boolean;
  ragSyncStatus?: ApprovalRagSyncStatus;
  taskStatus?: RagSyncTaskStatus;
  documentId?: string;
  skippedReason?: string;
  retryAfterMs?: number;
  leaseGeneration?: number;
  executionMode: ExtractionExecutionMode;
  isCloudVerified: boolean;
  projectId: string;
  processedCount: number;
  syncedCount: number;
  failedCount: number;
  skippedCount: number;
  results: {
    taskId: string;
    proposalId: string;
    auditId: string;
    targetEntityType: ApprovalTargetEntityType;
    targetEntityId: string;
    ragSyncStatus: ApprovalRagSyncStatus;
    ragSyncError: string;
    memoryDocumentId: string;
    leaseGeneration?: number;
    skippedReason?: string;
    retryAfterMs?: number;
  }[];
  completedAt: string;
}

export interface ApprovalAuditListResponse {
  success: boolean;
  ok?: boolean;
  executionMode: ExtractionExecutionMode;
  isCloudVerified: boolean;
  projectId: string;
  audits: ChangeProposalApprovalAudit[];
  fetchedAt: string;
}

