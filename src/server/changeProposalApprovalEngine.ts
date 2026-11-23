import {
  Timestamp,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';
import type {
  CanonStatus,
  ChangeProposal,
  CharacterRelationship,
  Foreshadowing,
  ForeshadowingPhase,
  Revision,
  TimelineEvent,
} from '../types/novel';
import type {
  AppliedCanonEntity,
  ApprovalActionType,
  ApprovalAuditListResponse,
  ApprovalConflictCode,
  ApprovalConflictDetails,
  ApprovalRagSyncStatus,
  ApprovalTargetEntityType,
  ChangeProposalApprovalAudit,
  ChangeProposalApprovalRequest,
  ChangeProposalApprovalResponse,
  ChangeProposalPreviewRequest,
  ChangeProposalPreviewResponse,
  ChangeProposalRejectionRequest,
  ChangeProposalRejectionResponse,
  RagIntegrityAnomalyCode,
  RagIntegrityDiagnosticItem,
  RagIntegrityDiagnosticReport,
  RagSyncExecutionRequest,
  RagSyncExecutionResponse,
  RagSyncTaskRecord,
  RagSyncTaskStatus,
} from '../types/changeProposalApproval';
import type { ExtractionExecutionMode } from '../types/manuscriptExtraction';
import {
  buildApprovalAuditRecord,
  buildChangeProposalFieldDiff,
  buildPreviewTargetEntityCandidate,
  computeDeterministicApprovalAuditId,
  computeDeterministicRagSyncTaskId,
  computeEntityCanonicalContentHash,
  computeLegacyApprovalAuditId,
  detectTargetEntityStaleOrConflict,
  evaluateRagSyncRetryPolicy,
  mapApprovedForeshadowing,
  mapApprovedRelationship,
  mapApprovedTimelineEvent,
  verifyCanonEntityFreshnessForRag,
  verifyExistingAuditRecordMatchesProposal,
  verifyProposalEnvelopeIntegrity,
  verifyRagTaskLeaseFencing,
  verifyRevisionExcerptAtApproval,
} from '../utils/changeProposalApprovalLogic';
import { normalizeToCanonStatus } from '../utils/foundationLogic';
import type { RagGenerationStagingReceipt } from '../types/foundation';
import {
  buildMemoryIndexInputFromApprovedEntity,
  type EntityIndexLifecycleState,
} from '../services/memorySearchProvider';
import {
  cleanupInactiveRagGenerationsOnServer,
  indexMemoryInputOnServer,
  type RagIndexingOptions,
} from './ragEngine';
import {
  normalizeChangeProposalFromFirestore,
  normalizeFirestoreTimestampToIso,
  resolveExtractionFirestoreInstance,
  toFirestoreAdminTimestamp,
} from './manuscriptExtractionEngine';

export type ApprovalTransactionFaultStep =
  | 'AFTER_ENTITY_WRITE'
  | 'AFTER_PROPOSAL_WRITE'
  | 'BEFORE_AUDIT_WRITE';

export interface ApprovalEngineOptions {
  db?: Firestore;
  testMode?: boolean;
  verifiedOwnerId?: string | null;
  nowIso?: string;
  faultInjectionStep?: ApprovalTransactionFaultStep;
}

function resolveExecutionMode(
  options?: ApprovalEngineOptions
): ExtractionExecutionMode {
  if (options?.db || options?.testMode) {
    return 'TEST_ISOLATED';
  }
  return 'CLOUD_AUTHENTICATED';
}

function resolveTargetCollectionSubpath(
  targetEntityType: ApprovalTargetEntityType
): 'relationships' | 'timelineEvents' | 'foreshadowings' {
  switch (targetEntityType) {
    case 'RELATIONSHIP':
      return 'relationships';
    case 'TIMELINE_EVENT':
      return 'timelineEvents';
    case 'FORESHADOWING':
      return 'foreshadowings';
  }
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === 'string')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeCharacterRelationshipFromDoc(
  raw: Record<string, unknown>,
  fallbackId: string
): CharacterRelationship {
  const createdAt = normalizeFirestoreTimestampToIso(raw.createdAt);
  const updatedAt = normalizeFirestoreTimestampToIso(raw.updatedAt, createdAt);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    ownerId: typeof raw.ownerId === 'string' ? raw.ownerId : '',
    projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
    sourceCharacterId:
      typeof raw.sourceCharacterId === 'string' ? raw.sourceCharacterId : '',
    targetCharacterId:
      typeof raw.targetCharacterId === 'string' ? raw.targetCharacterId : '',
    relationType: typeof raw.relationType === 'string' ? raw.relationType : '',
    affinityScore:
      typeof raw.affinityScore === 'number' && Number.isFinite(raw.affinityScore)
        ? Math.round(raw.affinityScore)
        : 0,
    isDirectional:
      typeof raw.isDirectional === 'boolean' ? raw.isDirectional : true,
    description: typeof raw.description === 'string' ? raw.description : '',
    canonStatus: normalizeToCanonStatus(raw.canonStatus as CanonStatus),
    effectiveEpisodeId:
      typeof raw.effectiveEpisodeId === 'string' ? raw.effectiveEpisodeId : '',
    effectiveEventId:
      typeof raw.effectiveEventId === 'string' ? raw.effectiveEventId : '',
    sourceRevisionId:
      typeof raw.sourceRevisionId === 'string' ? raw.sourceRevisionId : '',
    createdBy:
      raw.createdBy === 'AUTHOR' || raw.createdBy === 'SYSTEM'
        ? raw.createdBy
        : 'AI_ENGINE',
    createdAt,
    updatedAt,
  };
}

function normalizeTimelineEventFromDoc(
  raw: Record<string, unknown>,
  fallbackId: string
): TimelineEvent {
  const createdAt = normalizeFirestoreTimestampToIso(raw.createdAt);
  const updatedAt = normalizeFirestoreTimestampToIso(raw.updatedAt, createdAt);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    ownerId: typeof raw.ownerId === 'string' ? raw.ownerId : '',
    projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    inUniverseDate:
      typeof raw.inUniverseDate === 'string' ? raw.inUniverseDate : '',
    chronologicalOrder:
      typeof raw.chronologicalOrder === 'number' &&
      Number.isFinite(raw.chronologicalOrder)
        ? Math.floor(raw.chronologicalOrder)
        : 1,
    episodeId: typeof raw.episodeId === 'string' ? raw.episodeId : '',
    sceneId: typeof raw.sceneId === 'string' ? raw.sceneId : '',
    participantCharacterIds: normalizeStringArray(raw.participantCharacterIds),
    linkedForeshadowingIds: normalizeStringArray(raw.linkedForeshadowingIds),
    linkedWorldbuildingIds: normalizeStringArray(raw.linkedWorldbuildingIds),
    canonStatus: normalizeToCanonStatus(raw.canonStatus as CanonStatus),
    sourceRevisionId:
      typeof raw.sourceRevisionId === 'string' ? raw.sourceRevisionId : '',
    createdBy:
      raw.createdBy === 'AUTHOR' || raw.createdBy === 'SYSTEM'
        ? raw.createdBy
        : 'AI_ENGINE',
    createdAt,
    updatedAt,
  };
}

function normalizeForeshadowingFromDoc(
  raw: Record<string, unknown>,
  fallbackId: string
): Foreshadowing {
  const createdAt = normalizeFirestoreTimestampToIso(raw.createdAt);
  const updatedAt = normalizeFirestoreTimestampToIso(raw.updatedAt, createdAt);
  const rawPhase = raw.cluePhase as ForeshadowingPhase;
  const cluePhase: ForeshadowingPhase =
    rawPhase === 'PLANTED' ||
    rawPhase === 'REINFORCED' ||
    rawPhase === 'RESOLVED' ||
    rawPhase === 'ABANDONED'
      ? rawPhase
      : 'PLANTED';

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    ownerId: typeof raw.ownerId === 'string' ? raw.ownerId : '',
    projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    cluePhase,
    canonStatus: normalizeToCanonStatus(raw.canonStatus as CanonStatus),
    plantedEpisodeId:
      typeof raw.plantedEpisodeId === 'string' ? raw.plantedEpisodeId : '',
    plantedSceneId:
      typeof raw.plantedSceneId === 'string' ? raw.plantedSceneId : '',
    resolvedEpisodeId:
      typeof raw.resolvedEpisodeId === 'string' ? raw.resolvedEpisodeId : '',
    resolvedSceneId:
      typeof raw.resolvedSceneId === 'string' ? raw.resolvedSceneId : '',
    relatedEventIds: normalizeStringArray(raw.relatedEventIds),
    relatedCharacterIds: normalizeStringArray(raw.relatedCharacterIds),
    sourceRevisionId:
      typeof raw.sourceRevisionId === 'string' ? raw.sourceRevisionId : '',
    createdBy:
      raw.createdBy === 'AUTHOR' || raw.createdBy === 'SYSTEM'
        ? raw.createdBy
        : 'AI_ENGINE',
    createdAt,
    updatedAt,
  };
}

function normalizeTargetEntityFromDoc(
  targetEntityType: ApprovalTargetEntityType,
  raw: Record<string, unknown>,
  fallbackId: string
): AppliedCanonEntity {
  switch (targetEntityType) {
    case 'RELATIONSHIP':
      return normalizeCharacterRelationshipFromDoc(raw, fallbackId);
    case 'TIMELINE_EVENT':
      return normalizeTimelineEventFromDoc(raw, fallbackId);
    case 'FORESHADOWING':
      return normalizeForeshadowingFromDoc(raw, fallbackId);
  }
}

function normalizeApprovalAuditFromDoc(
  raw: Record<string, unknown>,
  fallbackId: string
): ChangeProposalApprovalAudit {
  const createdAt = normalizeFirestoreTimestampToIso(raw.createdAt);
  const updatedAt = normalizeFirestoreTimestampToIso(raw.updatedAt, createdAt);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    ownerId: typeof raw.ownerId === 'string' ? raw.ownerId : '',
    projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
    proposalId: typeof raw.proposalId === 'string' ? raw.proposalId : '',
    decision: raw.decision === 'REJECTED' ? 'REJECTED' : 'APPROVED',
    targetEntityType:
      (raw.targetEntityType as ApprovalTargetEntityType) || 'RELATIONSHIP',
    targetEntityId:
      typeof raw.targetEntityId === 'string' ? raw.targetEntityId : '',
    proposedAction:
      (raw.proposedAction as ApprovalActionType) || 'CREATE',
    triggerEpisodeId:
      typeof raw.triggerEpisodeId === 'string' ? raw.triggerEpisodeId : '',
    sourceRevisionId:
      typeof raw.sourceRevisionId === 'string' ? raw.sourceRevisionId : '',
    sourceSceneId:
      typeof raw.sourceSceneId === 'string' ? raw.sourceSceneId : '',
    proposalFingerprint:
      typeof raw.proposalFingerprint === 'string'
        ? raw.proposalFingerprint
        : '',
    reviewerUid: typeof raw.reviewerUid === 'string' ? raw.reviewerUid : '',
    reviewNote: typeof raw.reviewNote === 'string' ? raw.reviewNote : '',
    beforeCanonStatus: normalizeToCanonStatus(
      raw.beforeCanonStatus as CanonStatus
    ),
    afterCanonStatus: normalizeToCanonStatus(
      raw.afterCanonStatus as CanonStatus
    ),
    beforeSnapshotJson:
      typeof raw.beforeSnapshotJson === 'string'
        ? raw.beforeSnapshotJson
        : 'null',
    afterSnapshotJson:
      typeof raw.afterSnapshotJson === 'string'
        ? raw.afterSnapshotJson
        : 'null',
    verifiedExcerptJson:
      typeof raw.verifiedExcerptJson === 'string'
        ? raw.verifiedExcerptJson
        : '{}',
    payoffNote: typeof raw.payoffNote === 'string' ? raw.payoffNote : '',
    ragSyncStatus:
      (raw.ragSyncStatus as ApprovalRagSyncStatus) || 'PENDING',
    ragSyncError: typeof raw.ragSyncError === 'string' ? raw.ragSyncError : '',
    createdAt,
    updatedAt,
  };
}

function serializeRelationshipDocForFirestore(
  entity: CharacterRelationship,
  existingRawCreatedAt: unknown,
  nowTimestamp: Timestamp
): Record<string, unknown> {
  const createdAt = existingRawCreatedAt
    ? toFirestoreAdminTimestamp(
        existingRawCreatedAt as string | Date | Timestamp
      )
    : toFirestoreAdminTimestamp(entity.createdAt);

  return {
    id: entity.id,
    ownerId: entity.ownerId,
    projectId: entity.projectId,
    sourceCharacterId: entity.sourceCharacterId,
    targetCharacterId: entity.targetCharacterId,
    relationType: entity.relationType,
    affinityScore: entity.affinityScore,
    isDirectional: entity.isDirectional,
    description: entity.description,
    canonStatus: 'CANON',
    effectiveEpisodeId: entity.effectiveEpisodeId,
    effectiveEventId: entity.effectiveEventId,
    sourceRevisionId: entity.sourceRevisionId,
    createdBy: entity.createdBy,
    createdAt,
    updatedAt: nowTimestamp,
  };
}

function serializeTimelineEventDocForFirestore(
  entity: TimelineEvent,
  existingRawCreatedAt: unknown,
  nowTimestamp: Timestamp
): Record<string, unknown> {
  const createdAt = existingRawCreatedAt
    ? toFirestoreAdminTimestamp(
        existingRawCreatedAt as string | Date | Timestamp
      )
    : toFirestoreAdminTimestamp(entity.createdAt);

  return {
    id: entity.id,
    ownerId: entity.ownerId,
    projectId: entity.projectId,
    title: entity.title,
    summary: entity.summary,
    inUniverseDate: entity.inUniverseDate,
    chronologicalOrder: entity.chronologicalOrder,
    episodeId: entity.episodeId,
    sceneId: entity.sceneId,
    participantCharacterIds: [...entity.participantCharacterIds],
    linkedForeshadowingIds: [...entity.linkedForeshadowingIds],
    linkedWorldbuildingIds: [...entity.linkedWorldbuildingIds],
    canonStatus: 'CANON',
    sourceRevisionId: entity.sourceRevisionId,
    createdBy: entity.createdBy,
    createdAt,
    updatedAt: nowTimestamp,
  };
}

function serializeForeshadowingDocForFirestore(
  entity: Foreshadowing,
  existingRawCreatedAt: unknown,
  nowTimestamp: Timestamp
): Record<string, unknown> {
  const createdAt = existingRawCreatedAt
    ? toFirestoreAdminTimestamp(
        existingRawCreatedAt as string | Date | Timestamp
      )
    : toFirestoreAdminTimestamp(entity.createdAt);

  return {
    id: entity.id,
    ownerId: entity.ownerId,
    projectId: entity.projectId,
    title: entity.title,
    description: entity.description,
    cluePhase: entity.cluePhase,
    canonStatus: 'CANON',
    plantedEpisodeId: entity.plantedEpisodeId,
    plantedSceneId: entity.plantedSceneId,
    resolvedEpisodeId: entity.resolvedEpisodeId,
    resolvedSceneId: entity.resolvedSceneId,
    relatedEventIds: [...entity.relatedEventIds],
    relatedCharacterIds: [...entity.relatedCharacterIds],
    sourceRevisionId: entity.sourceRevisionId,
    createdBy: entity.createdBy,
    createdAt,
    updatedAt: nowTimestamp,
  };
}

function serializeTargetEntityDocForFirestore(
  targetEntityType: ApprovalTargetEntityType,
  entity: AppliedCanonEntity,
  existingRawCreatedAt: unknown,
  nowTimestamp: Timestamp
): Record<string, unknown> {
  switch (targetEntityType) {
    case 'RELATIONSHIP':
      return serializeRelationshipDocForFirestore(
        entity as CharacterRelationship,
        existingRawCreatedAt,
        nowTimestamp
      );
    case 'TIMELINE_EVENT':
      return serializeTimelineEventDocForFirestore(
        entity as TimelineEvent,
        existingRawCreatedAt,
        nowTimestamp
      );
    case 'FORESHADOWING':
      return serializeForeshadowingDocForFirestore(
        entity as Foreshadowing,
        existingRawCreatedAt,
        nowTimestamp
      );
  }
}

function serializeProposalDecisionUpdateForFirestore(
  existingRawDoc: Record<string, unknown>,
  updatedProposal: ChangeProposal,
  nowTimestamp: Timestamp
): Record<string, unknown> {
  const createdAt = existingRawDoc.createdAt
    ? toFirestoreAdminTimestamp(
        existingRawDoc.createdAt as string | Date | Timestamp
      )
    : toFirestoreAdminTimestamp(updatedProposal.createdAt);

  return {
    id: updatedProposal.id,
    ownerId: updatedProposal.ownerId,
    projectId: updatedProposal.projectId,
    targetEntityType: updatedProposal.targetEntityType,
    targetEntityId: updatedProposal.targetEntityId,
    proposedAction: updatedProposal.proposedAction,
    title: updatedProposal.title,
    rationale: updatedProposal.rationale,
    beforeSummary: updatedProposal.beforeSummary,
    afterSummary: updatedProposal.afterSummary,
    proposedPayloadJson: updatedProposal.proposedPayloadJson,
    canonStatus: updatedProposal.canonStatus,
    triggerEpisodeId: updatedProposal.triggerEpisodeId,
    triggerSceneId: updatedProposal.triggerSceneId || '',
    sourceRevisionId: updatedProposal.sourceRevisionId,
    createdBy: updatedProposal.createdBy,
    reviewedAt: updatedProposal.reviewedAt,
    createdAt,
    updatedAt: nowTimestamp,
  };
}

function serializeApprovalAuditDocForFirestore(
  audit: ChangeProposalApprovalAudit,
  nowTimestamp: Timestamp,
  existingRawCreatedAt?: unknown
): Record<string, unknown> {
  const createdAt = existingRawCreatedAt
    ? toFirestoreAdminTimestamp(
        existingRawCreatedAt as string | Date | Timestamp
      )
    : nowTimestamp;
  return {
    id: audit.id,
    ownerId: audit.ownerId,
    projectId: audit.projectId,
    proposalId: audit.proposalId,
    decision: audit.decision,
    targetEntityType: audit.targetEntityType,
    targetEntityId: audit.targetEntityId,
    proposedAction: audit.proposedAction,
    triggerEpisodeId: audit.triggerEpisodeId,
    sourceRevisionId: audit.sourceRevisionId,
    sourceSceneId: audit.sourceSceneId,
    proposalFingerprint: audit.proposalFingerprint,
    reviewerUid: audit.reviewerUid,
    reviewNote: audit.reviewNote,
    beforeCanonStatus: audit.beforeCanonStatus,
    afterCanonStatus: audit.afterCanonStatus,
    beforeSnapshotJson: audit.beforeSnapshotJson,
    afterSnapshotJson: audit.afterSnapshotJson,
    verifiedExcerptJson: audit.verifiedExcerptJson,
    payoffNote: audit.payoffNote,
    ragSyncStatus: audit.ragSyncStatus,
    ragSyncError: audit.ragSyncError,
    createdAt,
    updatedAt: nowTimestamp,
  };
}

function normalizeRagSyncTaskFromDoc(
  raw: Record<string, unknown>,
  fallbackId: string
): RagSyncTaskRecord {
  const createdAt = normalizeFirestoreTimestampToIso(raw.createdAt);
  const updatedAt = normalizeFirestoreTimestampToIso(raw.updatedAt, createdAt);
  const rawStatus = raw.status as RagSyncTaskStatus;
  const status: RagSyncTaskStatus =
    rawStatus === 'PENDING' ||
    rawStatus === 'PROCESSING' ||
    rawStatus === 'SYNCED' ||
    rawStatus === 'FAILED' ||
    rawStatus === 'SUPERSEDED'
      ? rawStatus
      : 'PENDING';

  const sourceRevisionId =
    typeof raw.sourceRevisionId === 'string' ? raw.sourceRevisionId : '';

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    ownerId: typeof raw.ownerId === 'string' ? raw.ownerId : '',
    projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
    proposalId: typeof raw.proposalId === 'string' ? raw.proposalId : '',
    auditId: typeof raw.auditId === 'string' ? raw.auditId : '',
    targetEntityType:
      (raw.targetEntityType as ApprovalTargetEntityType) || 'RELATIONSHIP',
    targetEntityId:
      typeof raw.targetEntityId === 'string' ? raw.targetEntityId : '',
    sourceRevisionId,
    expectedSourceRevisionId:
      typeof raw.expectedSourceRevisionId === 'string' &&
      raw.expectedSourceRevisionId
        ? raw.expectedSourceRevisionId
        : sourceRevisionId,
    expectedEntityUpdatedAt:
      typeof raw.expectedEntityUpdatedAt === 'string'
        ? raw.expectedEntityUpdatedAt
        : '',
    expectedContentHash:
      typeof raw.expectedContentHash === 'string'
        ? raw.expectedContentHash
        : '',
    status,
    attemptCount:
      typeof raw.attemptCount === 'number' && Number.isFinite(raw.attemptCount)
        ? Math.max(0, Math.floor(raw.attemptCount))
        : 0,
    maxAttempts:
      typeof raw.maxAttempts === 'number' && Number.isFinite(raw.maxAttempts)
        ? Math.max(1, Math.floor(raw.maxAttempts))
        : 5,
    manualRetryCount:
      typeof raw.manualRetryCount === 'number' &&
      Number.isFinite(raw.manualRetryCount)
        ? Math.max(0, Math.floor(raw.manualRetryCount))
        : 0,
    leaseOwner: typeof raw.leaseOwner === 'string' ? raw.leaseOwner : '',
    leaseGeneration:
      typeof raw.leaseGeneration === 'number' &&
      Number.isFinite(raw.leaseGeneration)
        ? Math.max(0, Math.floor(raw.leaseGeneration))
        : 0,
    leaseExpiresAtMs:
      typeof raw.leaseExpiresAtMs === 'number' &&
      Number.isFinite(raw.leaseExpiresAtMs)
        ? raw.leaseExpiresAtMs
        : 0,
    nextRetryAfterMs:
      typeof raw.nextRetryAfterMs === 'number' &&
      Number.isFinite(raw.nextRetryAfterMs)
        ? raw.nextRetryAfterMs
        : 0,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : '',
    memoryDocumentId:
      typeof raw.memoryDocumentId === 'string' ? raw.memoryDocumentId : '',
    createdAt,
    updatedAt,
  };
}

function serializeRagSyncTaskDocForFirestore(
  task: RagSyncTaskRecord,
  nowTimestamp: Timestamp,
  existingRawCreatedAt?: unknown
): Record<string, unknown> {
  const createdAt = existingRawCreatedAt
    ? toFirestoreAdminTimestamp(
        existingRawCreatedAt as string | Date | Timestamp
      )
    : nowTimestamp;
  return {
    id: task.id,
    ownerId: task.ownerId,
    projectId: task.projectId,
    proposalId: task.proposalId,
    auditId: task.auditId,
    targetEntityType: task.targetEntityType,
    targetEntityId: task.targetEntityId,
    sourceRevisionId: task.sourceRevisionId,
    expectedSourceRevisionId:
      task.expectedSourceRevisionId || task.sourceRevisionId || '',
    expectedEntityUpdatedAt: task.expectedEntityUpdatedAt || '',
    expectedContentHash: task.expectedContentHash || '',
    status: task.status,
    attemptCount: task.attemptCount,
    maxAttempts: task.maxAttempts,
    manualRetryCount: task.manualRetryCount ?? 0,
    leaseOwner: task.leaseOwner,
    leaseGeneration: task.leaseGeneration ?? 0,
    leaseExpiresAtMs: task.leaseExpiresAtMs,
    nextRetryAfterMs: task.nextRetryAfterMs,
    lastError: task.lastError,
    memoryDocumentId: task.memoryDocumentId,
    createdAt,
    updatedAt: nowTimestamp,
  };
}

/**
 * Phase 4.2.2 Stage 1.5 Section 2:
 * Strictly reads a DocumentReference inside a Firestore transaction via `tx.get(docRef)`.
 * NEVER falls back to non-transactional `docRef.get()` or `colRef.get()`.
 * Any error during `tx.get` immediately aborts the transaction with `[TRANSACTION_READ_FAILED]`.
 */
async function txReadDocStrict(
  tx: Transaction,
  docRef: DocumentReference,
  label: string
): Promise<DocumentSnapshot> {
  try {
    return await tx.get(docRef);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[TRANSACTION_READ_FAILED] 트랜잭션 내부 문서 조회(${label}: ${docRef.path})에 실패하여 원자적 승인을 중단했습니다: ${detail}`
    );
  }
}

function addUniqueNonEmptyId(set: Set<string>, raw: unknown): void {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      set.add(trimmed);
    }
  }
}

function addUniqueNonEmptyIds(set: Set<string>, rawList: unknown): void {
  if (!Array.isArray(rawList)) return;
  for (const item of rawList) {
    addUniqueNonEmptyId(set, item);
  }
}

/**
 * Writes a new audit document inside the transaction with create-only semantics (`tx.create`).
 * Ensures an existing audit document can NEVER be overwritten.
 */
function txCreateAuditRecordStrict(
  tx: Transaction,
  auditRef: DocumentReference,
  serializedAuditDoc: Record<string, unknown>,
  existingSnap: DocumentSnapshot
): void {
  if (existingSnap.exists) {
    throw new Error(
      `[AUDIT_STATE_INCONSISTENCY] 감사 이력 문서(${auditRef.id})가 이미 존재하여 덮어쓰기가 차단되었습니다.`
    );
  }
  const maybeTxWithCreate = tx as unknown as {
    create?: (
      ref: DocumentReference,
      data: Record<string, unknown>
    ) => Transaction;
  };
  if (typeof maybeTxWithCreate.create === 'function') {
    maybeTxWithCreate.create(auditRef, serializedAuditDoc);
  } else {
    tx.set(auditRef, serializedAuditDoc);
  }
}

/**
 * Phase 4.2.2 Stage 1.5 Hardened: Server-Side Author Approval Engine (Atomic CANON Application)
 */
export async function approveChangeProposalOnServer(
  request: ChangeProposalApprovalRequest,
  options?: ApprovalEngineOptions
): Promise<ChangeProposalApprovalResponse> {
  const ownerId = options?.verifiedOwnerId?.trim() || '';
  if (!ownerId) {
    throw new Error(
      '[AUTH_REQUIRED] 제안서 승인을 위해서는 검증된 작가 인증(ownerId)이 필요합니다.'
    );
  }

  const projectId = request.projectId?.trim() || '';
  const proposalId = request.proposalId?.trim() || '';
  if (!projectId || !proposalId) {
    throw new Error(
      '[BAD_REQUEST] 제안서 승인에는 projectId와 proposalId가 모두 필요합니다.'
    );
  }

  // Validate DB binding first (enforces ISOLATED_TEST_DB_UNVERIFIED / TEST_ISOLATED_DB_REQUIRED)
  const db = resolveExtractionFirestoreInstance(options);
  const executionMode = resolveExecutionMode(options);

  // Section 4: Unconditionally block forceApplyOnStale bypass in general approval flow
  if (request.forceApplyOnStale === true) {
    throw new Error(
      '[STALE_OVERRIDE_FORBIDDEN] 일반 승인 경로에서는 forceApplyOnStale=true를 통한 UPDATE 충돌 우회가 금지되어 있습니다. 최신 엔티티 기준 재분석 또는 별도 충돌 해결 절차를 사용하세요.'
    );
  }

  const nowIso = options?.nowIso || new Date().toISOString();
  const nowDate = new Date(nowIso);
  const nowTimestamp = Timestamp.fromDate(
    Number.isNaN(nowDate.getTime()) ? new Date() : nowDate
  );

  const basePath = `users/${ownerId}/projects/${projectId}`;
  const projectRef = db.doc(basePath);
  const proposalRef = db.doc(`${basePath}/changeProposals/${proposalId}`);

  const primaryApprovedAuditId = computeDeterministicApprovalAuditId(
    proposalId,
    'APPROVED'
  );
  const legacyApprovedAuditId = computeLegacyApprovalAuditId(
    proposalId,
    'APPROVED'
  );
  const primaryRejectedAuditId = computeDeterministicApprovalAuditId(
    proposalId,
    'REJECTED'
  );
  const legacyRejectedAuditId = computeLegacyApprovalAuditId(
    proposalId,
    'REJECTED'
  );

  const primaryApprovedAuditRef = db.doc(
    `${basePath}/changeProposalApprovalAudits/${primaryApprovedAuditId}`
  );
  const legacyApprovedAuditRef =
    legacyApprovedAuditId !== primaryApprovedAuditId
      ? db.doc(
          `${basePath}/changeProposalApprovalAudits/${legacyApprovedAuditId}`
        )
      : null;
  const primaryRejectedAuditRef = db.doc(
    `${basePath}/changeProposalApprovalAudits/${primaryRejectedAuditId}`
  );
  const legacyRejectedAuditRef =
    legacyRejectedAuditId !== primaryRejectedAuditId
      ? db.doc(
          `${basePath}/changeProposalApprovalAudits/${legacyRejectedAuditId}`
        )
      : null;

  if (typeof db.runTransaction !== 'function') {
    throw new Error(
      '[INTERNAL_ERROR] Firestore 인스턴스가 원자적 트랜잭션(runTransaction)을 지원하지 않습니다.'
    );
  }

  return await db.runTransaction(async (tx: Transaction) => {
    // ------------------------------------------------------------------------
    // PHASE 1: ALL READS FIRST (Strictly via tx.get — 0 non-transactional fallbacks)
    // ------------------------------------------------------------------------
    const projectSnap = await txReadDocStrict(tx, projectRef, 'project');
    if (!projectSnap.exists) {
      throw new Error(
        `[NOT_FOUND] 프로젝트(${projectId})를 찾을 수 없거나 접근 권한이 없습니다.`
      );
    }
    const projectData = (projectSnap.data() || {}) as Record<string, unknown>;
    if (projectData.ownerId && projectData.ownerId !== ownerId) {
      throw new Error(
        '[TENANT_ISOLATION_VIOLATION] 프로젝트 소유자 정보가 인증된 작가와 일치하지 않습니다.'
      );
    }

    const proposalSnap = await txReadDocStrict(
      tx,
      proposalRef,
      `changeProposals/${proposalId}`
    );
    if (!proposalSnap.exists) {
      throw new Error(
        `[PROPOSAL_NOT_FOUND] 승인할 제안서(${proposalId})가 존재하지 않습니다.`
      );
    }

    const rawProposalData = (proposalSnap.data() || {}) as Record<
      string,
      unknown
    >;
    const existingProposal = normalizeChangeProposalFromFirestore(
      rawProposalData,
      proposalId
    );

    if (
      existingProposal.ownerId !== ownerId ||
      existingProposal.projectId !== projectId
    ) {
      throw new Error(
        '[TENANT_ISOLATION_VIOLATION] 제안서의 ownerId 또는 projectId가 요청 컨텍스트와 일치하지 않습니다.'
      );
    }

    const primaryApprovedAuditSnap = await txReadDocStrict(
      tx,
      primaryApprovedAuditRef,
      `changeProposalApprovalAudits/${primaryApprovedAuditId}`
    );
    const legacyApprovedAuditSnap = legacyApprovedAuditRef
      ? await txReadDocStrict(
          tx,
          legacyApprovedAuditRef,
          `changeProposalApprovalAudits/${legacyApprovedAuditId}`
        )
      : null;
    const primaryRejectedAuditSnap = await txReadDocStrict(
      tx,
      primaryRejectedAuditRef,
      `changeProposalApprovalAudits/${primaryRejectedAuditId}`
    );
    const legacyRejectedAuditSnap = legacyRejectedAuditRef
      ? await txReadDocStrict(
          tx,
          legacyRejectedAuditRef,
          `changeProposalApprovalAudits/${legacyRejectedAuditId}`
        )
      : null;

    const existingApprovedAuditSnap = primaryApprovedAuditSnap.exists
      ? primaryApprovedAuditSnap
      : legacyApprovedAuditSnap?.exists
      ? legacyApprovedAuditSnap
      : null;
    const existingRejectedAuditSnap = primaryRejectedAuditSnap.exists
      ? primaryRejectedAuditSnap
      : legacyRejectedAuditSnap?.exists
      ? legacyRejectedAuditSnap
      : null;

    const envelopeCheck = verifyProposalEnvelopeIntegrity(existingProposal);
    if (!envelopeCheck.ok) {
      throw new Error(`[${envelopeCheck.code}] ${envelopeCheck.error}`);
    }
    const { targetEntityType, proposedAction, envelope } = envelopeCheck;

    const targetCollectionSubpath =
      resolveTargetCollectionSubpath(targetEntityType);
    const targetEntityRef = db.doc(
      `${basePath}/${targetCollectionSubpath}/${existingProposal.targetEntityId}`
    );
    const targetEntitySnap = await txReadDocStrict(
      tx,
      targetEntityRef,
      `${targetCollectionSubpath}/${existingProposal.targetEntityId}`
    );

    const currentEntity = targetEntitySnap.exists
      ? normalizeTargetEntityFromDoc(
          targetEntityType,
          (targetEntitySnap.data() || {}) as Record<string, unknown>,
          existingProposal.targetEntityId
        )
      : null;

    // 1.1 Section 3.3: Idempotent ALREADY_APPROVED check with full 9-attribute Audit & Entity verification
    if (existingProposal.canonStatus === 'CANON') {
      if (!currentEntity || currentEntity.canonStatus !== 'CANON') {
        throw new Error(
          `[AUDIT_STATE_INCONSISTENCY] 제안서(${proposalId})는 CANON 상태이나 대상 엔티티(${existingProposal.targetEntityId})가 CANON으로 존재하지 않습니다.`
        );
      }
      if (!existingApprovedAuditSnap) {
        throw new Error(
          `[AUDIT_STATE_INCONSISTENCY] 제안서(${proposalId})는 CANON 상태이나 승인 감사 이력(${primaryApprovedAuditId})이 Firestore에 존재하지 않습니다.`
        );
      }
      const existingAudit = normalizeApprovalAuditFromDoc(
        (existingApprovedAuditSnap.data() || {}) as Record<string, unknown>,
        existingApprovedAuditSnap.id
      );
      const auditIntegrity = verifyExistingAuditRecordMatchesProposal({
        audit: existingAudit,
        proposal: existingProposal,
        envelope,
        expectedDecision: 'APPROVED',
        expectedOwnerId: ownerId,
        expectedProjectId: projectId,
        currentEntity,
      });
      if (!auditIntegrity.ok) {
        throw new Error(`[${auditIntegrity.code}] ${auditIntegrity.error}`);
      }

      return {
        success: true,
        ok: true,
        decision: 'APPROVED',
        executionMode,
        isCloudVerified: executionMode === 'CLOUD_AUTHENTICATED',
        status: 'ALREADY_APPROVED',
        projectId,
        proposalId,
        targetEntityType,
        targetEntityId: existingProposal.targetEntityId,
        proposedAction,
        proposal: existingProposal,
        appliedEntity: currentEntity,
        auditRecord: existingAudit,
        ragSyncStatus: existingAudit.ragSyncStatus || 'PENDING',
        completedAt: existingAudit.updatedAt || nowIso,
      };
    }

    if (existingProposal.canonStatus !== 'PROPOSED') {
      throw new Error(
        `[INVALID_PROPOSAL_STATE] 현재 상태가 '${existingProposal.canonStatus}'인 제안서는 승인할 수 없습니다. ('PROPOSED' 상태만 승인 가능)`
      );
    }

    // 1.2 Section 3.3: Proposal is PROPOSED, so NO prior APPROVED or REJECTED audit may exist!
    if (existingApprovedAuditSnap || existingRejectedAuditSnap) {
      const conflictingAuditId =
        existingApprovedAuditSnap?.id || existingRejectedAuditSnap?.id || '';
      throw new Error(
        `[AUDIT_STATE_INCONSISTENCY] 제안서(${proposalId})는 PROPOSED 상태이나 기존 감사 이력(${conflictingAuditId})이 이미 존재합니다. 기존 감사 이력을 덮어쓸 수 없습니다.`
      );
    }

    if (
      request.expectedUpdatedAt &&
      request.expectedUpdatedAt.trim().length > 0 &&
      existingProposal.updatedAt !== request.expectedUpdatedAt.trim() &&
      currentEntity?.updatedAt !== request.expectedUpdatedAt.trim()
    ) {
      throw new Error(
        `[STALE_TARGET] 제안서(${proposalId})의 수정 시각(${existingProposal.updatedAt})이 요청 기준 시각(${request.expectedUpdatedAt})과 일치하지 않습니다.`
      );
    }

    // 1.3 Read authoritative Revision strictly via tx.get and verify excerpt
    const revisionRef = db.doc(
      `${basePath}/revisions/${existingProposal.sourceRevisionId}`
    );
    const revisionSnap = await txReadDocStrict(
      tx,
      revisionRef,
      `revisions/${existingProposal.sourceRevisionId}`
    );
    if (!revisionSnap.exists) {
      throw new Error(
        `[REVISION_NOT_FOUND] 제안서의 근거 리비전(${existingProposal.sourceRevisionId})이 존재하지 않습니다.`
      );
    }
    const rawRev = (revisionSnap.data() || {}) as Record<string, unknown>;
    if (rawRev.ownerId && rawRev.ownerId !== ownerId) {
      throw new Error(
        '[TENANT_ISOLATION_VIOLATION] 리비전 소유자가 인증된 작가와 일치하지 않습니다.'
      );
    }

    const revisionDoc: Revision = {
      id:
        typeof rawRev.id === 'string' && rawRev.id
          ? rawRev.id
          : existingProposal.sourceRevisionId,
      ownerId: typeof rawRev.ownerId === 'string' ? rawRev.ownerId : ownerId,
      projectId: typeof rawRev.projectId === 'string' ? rawRev.projectId : '',
      episodeId: typeof rawRev.episodeId === 'string' ? rawRev.episodeId : '',
      episodeTitle:
        typeof rawRev.episodeTitle === 'string' ? rawRev.episodeTitle : '',
      content: typeof rawRev.content === 'string' ? rawRev.content : '',
      charCountWithSpaces:
        typeof rawRev.charCountWithSpaces === 'number'
          ? rawRev.charCountWithSpaces
          : 0,
      label: typeof rawRev.label === 'string' ? rawRev.label : '',
      createdAt: normalizeFirestoreTimestampToIso(rawRev.createdAt, nowIso),
    };

    const excerptCheck = verifyRevisionExcerptAtApproval({
      proposal: existingProposal,
      envelope,
      revision: revisionDoc,
    });
    if (!excerptCheck.ok) {
      throw new Error(`[${excerptCheck.code}] ${excerptCheck.error}`);
    }

    // 1.4 Collect and read all referenced documents strictly via tx.get(docRef) before any writes
    const episodeIdsToRead = new Set<string>();
    const sceneIdsToRead = new Set<string>();
    const characterIdsToRead = new Set<string>();
    const worldbuildingIdsToRead = new Set<string>();
    const timelineEventIdsToRead = new Set<string>();
    const foreshadowingIdsToRead = new Set<string>();

    addUniqueNonEmptyId(episodeIdsToRead, existingProposal.triggerEpisodeId);
    addUniqueNonEmptyId(episodeIdsToRead, envelope.sourceEpisodeId);
    addUniqueNonEmptyId(sceneIdsToRead, existingProposal.triggerSceneId);
    addUniqueNonEmptyId(sceneIdsToRead, envelope.sourceSceneId);

    if (targetEntityType === 'RELATIONSHIP' && envelope.relationshipDraft) {
      const draft = envelope.relationshipDraft;
      const ov = request.overrides?.relationshipOverride;
      addUniqueNonEmptyId(characterIdsToRead, draft.sourceCharacterId);
      addUniqueNonEmptyId(characterIdsToRead, draft.targetCharacterId);
      addUniqueNonEmptyId(
        characterIdsToRead,
        (currentEntity as CharacterRelationship | null)?.sourceCharacterId
      );
      addUniqueNonEmptyId(
        characterIdsToRead,
        (currentEntity as CharacterRelationship | null)?.targetCharacterId
      );
      addUniqueNonEmptyId(episodeIdsToRead, draft.lastChangedEpisodeId);
      addUniqueNonEmptyId(
        episodeIdsToRead,
        (currentEntity as CharacterRelationship | null)?.effectiveEpisodeId
      );
      addUniqueNonEmptyId(timelineEventIdsToRead, ov?.effectiveEventId);
      addUniqueNonEmptyId(
        timelineEventIdsToRead,
        (currentEntity as CharacterRelationship | null)?.effectiveEventId
      );
    } else if (
      targetEntityType === 'TIMELINE_EVENT' &&
      envelope.timelineEventDraft
    ) {
      const draft = envelope.timelineEventDraft;
      const ov = request.overrides?.timelineEventOverride;
      const curEvt = currentEntity as TimelineEvent | null;
      addUniqueNonEmptyId(episodeIdsToRead, draft.episodeId);
      addUniqueNonEmptyId(episodeIdsToRead, curEvt?.episodeId);
      addUniqueNonEmptyId(sceneIdsToRead, draft.sceneId);
      addUniqueNonEmptyId(sceneIdsToRead, ov?.sceneId);
      addUniqueNonEmptyId(sceneIdsToRead, curEvt?.sceneId);
      addUniqueNonEmptyIds(characterIdsToRead, draft.involvedCharacterIds);
      addUniqueNonEmptyIds(characterIdsToRead, ov?.participantCharacterIds);
      addUniqueNonEmptyIds(characterIdsToRead, curEvt?.participantCharacterIds);
      addUniqueNonEmptyId(worldbuildingIdsToRead, draft.locationWorldItemId);
      addUniqueNonEmptyIds(
        worldbuildingIdsToRead,
        ov?.linkedWorldbuildingIds
      );
      addUniqueNonEmptyIds(
        worldbuildingIdsToRead,
        curEvt?.linkedWorldbuildingIds
      );
      addUniqueNonEmptyIds(
        foreshadowingIdsToRead,
        ov?.linkedForeshadowingIds
      );
      addUniqueNonEmptyIds(
        foreshadowingIdsToRead,
        curEvt?.linkedForeshadowingIds
      );
    } else if (
      targetEntityType === 'FORESHADOWING' &&
      envelope.foreshadowingDraft
    ) {
      const draft = envelope.foreshadowingDraft;
      const ov = request.overrides?.foreshadowingOverride;
      const curFsh = currentEntity as Foreshadowing | null;
      addUniqueNonEmptyId(episodeIdsToRead, draft.plantedEpisodeId);
      addUniqueNonEmptyId(episodeIdsToRead, ov?.plantedEpisodeId);
      addUniqueNonEmptyId(episodeIdsToRead, curFsh?.plantedEpisodeId);
      addUniqueNonEmptyId(episodeIdsToRead, draft.resolvedEpisodeId);
      addUniqueNonEmptyId(episodeIdsToRead, ov?.resolvedEpisodeId);
      addUniqueNonEmptyId(episodeIdsToRead, curFsh?.resolvedEpisodeId);
      addUniqueNonEmptyId(sceneIdsToRead, draft.plantedSceneId);
      addUniqueNonEmptyId(sceneIdsToRead, ov?.plantedSceneId);
      addUniqueNonEmptyId(sceneIdsToRead, curFsh?.plantedSceneId);
      addUniqueNonEmptyId(sceneIdsToRead, draft.resolvedSceneId);
      addUniqueNonEmptyId(sceneIdsToRead, ov?.resolvedSceneId);
      addUniqueNonEmptyId(sceneIdsToRead, curFsh?.resolvedSceneId);
      addUniqueNonEmptyIds(characterIdsToRead, draft.relatedCharacterIds);
      addUniqueNonEmptyIds(characterIdsToRead, ov?.relatedCharacterIds);
      addUniqueNonEmptyIds(characterIdsToRead, curFsh?.relatedCharacterIds);
      addUniqueNonEmptyIds(timelineEventIdsToRead, draft.relatedEventIds);
      addUniqueNonEmptyIds(timelineEventIdsToRead, ov?.relatedEventIds);
      addUniqueNonEmptyIds(timelineEventIdsToRead, curFsh?.relatedEventIds);
    }

    const readVerifiedIdSet = async (
      subcollection: string,
      ids: Set<string>
    ): Promise<Set<string>> => {
      const validIds = new Set<string>();
      for (const id of ids) {
        const ref = db.doc(`${basePath}/${subcollection}/${id}`);
        const snap = await txReadDocStrict(tx, ref, `${subcollection}/${id}`);
        if (!snap.exists) continue;
        const data = (snap.data() || {}) as Record<string, unknown>;
        if (data.ownerId && data.ownerId !== ownerId) {
          throw new Error(
            `[TENANT_ISOLATION_VIOLATION] 참조 문서(${subcollection}/${id})의 소유자(${String(
              data.ownerId
            )})가 일치하지 않습니다.`
          );
        }
        if (data.projectId && data.projectId !== projectId) {
          throw new Error(
            `[REFERENCE_INTEGRITY_ERROR] 참조 문서(${subcollection}/${id})의 projectId(${String(
              data.projectId
            )})가 현재 프로젝트(${projectId})와 일치하지 않습니다.`
          );
        }
        if (typeof data.id === 'string' && data.id.trim() && data.id !== id) {
          throw new Error(
            `[REFERENCE_INTEGRITY_ERROR] 참조 문서(${subcollection}/${id})의 내부 id(${data.id})가 경로 ID와 일치하지 않습니다.`
          );
        }
        validIds.add(id);
      }
      return validIds;
    };

    const validEpisodeIds = await readVerifiedIdSet(
      'episodes',
      episodeIdsToRead
    );

    const validSceneIdsByEpisode = new Map<string, Set<string>>();
    const allValidSceneIds = new Set<string>();
    for (const sceneId of sceneIdsToRead) {
      const ref = db.doc(`${basePath}/scenes/${sceneId}`);
      const snap = await txReadDocStrict(tx, ref, `scenes/${sceneId}`);
      if (!snap.exists) continue;
      const data = (snap.data() || {}) as Record<string, unknown>;
      if (data.ownerId && data.ownerId !== ownerId) {
        throw new Error(
          `[TENANT_ISOLATION_VIOLATION] 장면 문서(scenes/${sceneId})의 소유자가 일치하지 않습니다.`
        );
      }
      if (data.projectId && data.projectId !== projectId) {
        throw new Error(
          `[REFERENCE_INTEGRITY_ERROR] 장면 문서(scenes/${sceneId})의 projectId가 현재 프로젝트(${projectId})와 일치하지 않습니다.`
        );
      }
      const epId =
        typeof data.episodeId === 'string' ? data.episodeId.trim() : '';
      allValidSceneIds.add(sceneId);
      if (epId) {
        let epSet = validSceneIdsByEpisode.get(epId);
        if (!epSet) {
          epSet = new Set<string>();
          validSceneIdsByEpisode.set(epId, epSet);
        }
        epSet.add(sceneId);
      }
    }

    const validCharacterIds = await readVerifiedIdSet(
      'characters',
      characterIdsToRead
    );
    const validWorldbuildingIds = await readVerifiedIdSet(
      'worldbuilding',
      worldbuildingIdsToRead
    );
    const validTimelineEventIds = await readVerifiedIdSet(
      'timelineEvents',
      timelineEventIdsToRead
    );
    const validForeshadowingIds = await readVerifiedIdSet(
      'foreshadowings',
      foreshadowingIdsToRead
    );

    // Verify sourceSceneId if specified on proposal or envelope
    const sourceSceneIdToCheck = (
      envelope.sourceSceneId ||
      existingProposal.triggerSceneId ||
      ''
    ).trim();
    if (sourceSceneIdToCheck && !allValidSceneIds.has(sourceSceneIdToCheck)) {
      throw new Error(
        `[REFERENCE_INTEGRITY_ERROR] 제안서에 연결된 장면(${sourceSceneIdToCheck})이 프로젝트에 존재하지 않습니다.`
      );
    }

    // 1.5 Detect CREATE/UPDATE conflicts, full snapshot parity, and semantic conflicts
    const conflictCheck = detectTargetEntityStaleOrConflict({
      envelope,
      currentEntity,
      expectedOwnerId: ownerId,
      expectedProjectId: projectId,
      forceApplyOnStale: request.forceApplyOnStale,
    });
    if (!conflictCheck.ok) {
      throw new Error(`[${conflictCheck.code}] ${conflictCheck.error}`);
    }

    // 1.6 Map to canonical entity and validate all references & schema keys
    let appliedEntity: AppliedCanonEntity;
    let payoffNote = '';

    if (targetEntityType === 'RELATIONSHIP') {
      const mappedRes = mapApprovedRelationship({
        proposal: existingProposal,
        draft: envelope.relationshipDraft!,
        existingEntity: (currentEntity as CharacterRelationship) || null,
        validCharacterIds,
        validTimelineEventIds,
        validEpisodeIds,
        nowIso,
        overrides: request.overrides?.relationshipOverride,
      });
      if (!mappedRes.ok) {
        throw new Error(`[${mappedRes.code}] ${mappedRes.error}`);
      }
      appliedEntity = mappedRes.entity;
    } else if (targetEntityType === 'TIMELINE_EVENT') {
      const epId = (
        envelope.timelineEventDraft!.episodeId ||
        existingProposal.triggerEpisodeId ||
        (currentEntity as TimelineEvent | null)?.episodeId ||
        ''
      ).trim();
      const validSceneIdsForEpisode =
        validSceneIdsByEpisode.get(epId) || new Set<string>();

      const mappedRes = mapApprovedTimelineEvent({
        proposal: existingProposal,
        draft: envelope.timelineEventDraft!,
        existingEntity: (currentEntity as TimelineEvent) || null,
        validCharacterIds,
        validWorldbuildingIds,
        validForeshadowingIds,
        validEpisodeIds,
        validSceneIdsForEpisode,
        nowIso,
        overrides: request.overrides?.timelineEventOverride,
      });
      if (!mappedRes.ok) {
        throw new Error(`[${mappedRes.code}] ${mappedRes.error}`);
      }
      appliedEntity = mappedRes.entity;
    } else {
      const mappedRes = mapApprovedForeshadowing({
        proposal: existingProposal,
        draft: envelope.foreshadowingDraft!,
        existingEntity: (currentEntity as Foreshadowing) || null,
        validCharacterIds,
        validTimelineEventIds,
        validEpisodeIds,
        validSceneIdsByEpisode,
        nowIso,
        overrides: request.overrides?.foreshadowingOverride,
      });
      if (!mappedRes.ok) {
        throw new Error(`[${mappedRes.code}] ${mappedRes.error}`);
      }
      appliedEntity = mappedRes.entity;
      payoffNote = mappedRes.payoffNote;
    }

    const updatedProposal: ChangeProposal = {
      ...existingProposal,
      title:
        request.overrides?.title?.trim() || existingProposal.title,
      rationale:
        request.overrides?.rationale?.trim() || existingProposal.rationale,
      canonStatus: 'CANON',
      reviewedAt: nowIso,
      updatedAt: nowIso,
    };

    const auditRecord = buildApprovalAuditRecord({
      proposal: existingProposal,
      envelope,
      decision: 'APPROVED',
      reviewerUid: ownerId,
      reviewNote: request.reviewNote,
      beforeEntity: currentEntity,
      afterEntity: appliedEntity,
      payoffNote,
      ragSyncStatus: 'PENDING',
      nowIso,
    });

    const ragTaskId = computeDeterministicRagSyncTaskId(proposalId);
    const ragSyncTaskRef = db.doc(`${basePath}/ragSyncTasks/${ragTaskId}`);
    const existingRagSyncTaskSnap = await txReadDocStrict(
      tx,
      ragSyncTaskRef,
      `ragSyncTasks/${ragTaskId}`
    );

    const existingRawTargetCreatedAt = targetEntitySnap.exists
      ? ((targetEntitySnap.data() || {}) as Record<string, unknown>).createdAt
      : undefined;

    const serializedEntityDoc = serializeTargetEntityDocForFirestore(
      targetEntityType,
      appliedEntity,
      existingRawTargetCreatedAt,
      nowTimestamp
    );
    const serializedProposalDoc = serializeProposalDecisionUpdateForFirestore(
      rawProposalData,
      updatedProposal,
      nowTimestamp
    );
    const serializedAuditDoc = serializeApprovalAuditDocForFirestore(
      auditRecord,
      nowTimestamp
    );

    const ragTaskRecord: RagSyncTaskRecord = {
      id: ragTaskId,
      ownerId,
      projectId,
      proposalId,
      auditId: auditRecord.id,
      targetEntityType,
      targetEntityId: existingProposal.targetEntityId,
      sourceRevisionId: existingProposal.sourceRevisionId,
      expectedSourceRevisionId: appliedEntity.sourceRevisionId,
      expectedEntityUpdatedAt: appliedEntity.updatedAt,
      expectedContentHash: computeEntityCanonicalContentHash(appliedEntity),
      status: 'PENDING',
      attemptCount: 0,
      maxAttempts: 5,
      manualRetryCount: 0,
      leaseOwner: '',
      leaseGeneration: 0,
      leaseExpiresAtMs: 0,
      nextRetryAfterMs: 0,
      lastError: '',
      memoryDocumentId: '',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const serializedRagTaskDoc = serializeRagSyncTaskDocForFirestore(
      ragTaskRecord,
      nowTimestamp,
      existingRagSyncTaskSnap.exists
        ? ((existingRagSyncTaskSnap.data() || {}) as Record<string, unknown>)
            .createdAt
        : undefined
    );

    // ------------------------------------------------------------------------
    // PHASE 2: ATOMIC WRITES (Entity + Proposal + Create-Only Audit + RAG Outbox Task)
    // ------------------------------------------------------------------------
    tx.set(targetEntityRef, serializedEntityDoc);

    if (options?.faultInjectionStep === 'AFTER_ENTITY_WRITE') {
      throw new Error(
        '[FAULT_INJECTION_ROLLBACK] 엔티티 반영 직후 강제 오류 주입 — 전체 트랜잭션이 원자적으로 롤백되어야 합니다.'
      );
    }

    tx.set(proposalRef, serializedProposalDoc);

    if (
      options?.faultInjectionStep === 'AFTER_PROPOSAL_WRITE' ||
      options?.faultInjectionStep === 'BEFORE_AUDIT_WRITE'
    ) {
      throw new Error(
        '[FAULT_INJECTION_ROLLBACK] 제안서 상태 갱신 직후 / 감사 로그 기록 직전 강제 오류 주입 — 전체 트랜잭션이 원자적으로 롤백되어야 합니다.'
      );
    }

    txCreateAuditRecordStrict(
      tx,
      primaryApprovedAuditRef,
      serializedAuditDoc,
      primaryApprovedAuditSnap
    );

    tx.set(ragSyncTaskRef, serializedRagTaskDoc);

    return {
      success: true,
      ok: true,
      decision: 'APPROVED',
      executionMode,
      isCloudVerified: executionMode === 'CLOUD_AUTHENTICATED',
      status: 'APPROVED_APPLIED',
      projectId,
      proposalId,
      targetEntityType,
      targetEntityId: existingProposal.targetEntityId,
      proposedAction,
      proposal: updatedProposal,
      appliedEntity,
      auditRecord,
      ragSyncStatus: 'PENDING',
      completedAt: nowIso,
    };
  });
}

/**
 * Phase 4.2.2 Stage 1.5 Hardened: Server-Side Author Rejection Engine
 */
export async function rejectChangeProposalOnServer(
  request: ChangeProposalRejectionRequest,
  options?: ApprovalEngineOptions
): Promise<ChangeProposalRejectionResponse> {
  const ownerId = options?.verifiedOwnerId?.trim() || '';
  if (!ownerId) {
    throw new Error(
      '[AUTH_REQUIRED] 제안서 반려를 위해서는 검증된 작가 인증(ownerId)이 필요합니다.'
    );
  }

  const projectId = request.projectId?.trim() || '';
  const proposalId = request.proposalId?.trim() || '';
  if (!projectId || !proposalId) {
    throw new Error(
      '[BAD_REQUEST] 제안서 반려에는 projectId와 proposalId가 모두 필요합니다.'
    );
  }

  const db = resolveExtractionFirestoreInstance(options);
  const executionMode = resolveExecutionMode(options);
  const nowIso = options?.nowIso || new Date().toISOString();
  const nowDate = new Date(nowIso);
  const nowTimestamp = Timestamp.fromDate(
    Number.isNaN(nowDate.getTime()) ? new Date() : nowDate
  );

  const basePath = `users/${ownerId}/projects/${projectId}`;
  const projectRef = db.doc(basePath);
  const proposalRef = db.doc(`${basePath}/changeProposals/${proposalId}`);

  const primaryRejectedAuditId = computeDeterministicApprovalAuditId(
    proposalId,
    'REJECTED'
  );
  const legacyRejectedAuditId = computeLegacyApprovalAuditId(
    proposalId,
    'REJECTED'
  );
  const primaryApprovedAuditId = computeDeterministicApprovalAuditId(
    proposalId,
    'APPROVED'
  );
  const legacyApprovedAuditId = computeLegacyApprovalAuditId(
    proposalId,
    'APPROVED'
  );

  const primaryRejectedAuditRef = db.doc(
    `${basePath}/changeProposalApprovalAudits/${primaryRejectedAuditId}`
  );
  const legacyRejectedAuditRef =
    legacyRejectedAuditId !== primaryRejectedAuditId
      ? db.doc(
          `${basePath}/changeProposalApprovalAudits/${legacyRejectedAuditId}`
        )
      : null;
  const primaryApprovedAuditRef = db.doc(
    `${basePath}/changeProposalApprovalAudits/${primaryApprovedAuditId}`
  );
  const legacyApprovedAuditRef =
    legacyApprovedAuditId !== primaryApprovedAuditId
      ? db.doc(
          `${basePath}/changeProposalApprovalAudits/${legacyApprovedAuditId}`
        )
      : null;

  if (typeof db.runTransaction !== 'function') {
    throw new Error(
      '[INTERNAL_ERROR] Firestore 인스턴스가 원자적 트랜잭션(runTransaction)을 지원하지 않습니다.'
    );
  }

  return await db.runTransaction(async (tx: Transaction) => {
    const projectSnap = await txReadDocStrict(tx, projectRef, 'project');
    if (!projectSnap.exists) {
      throw new Error(
        `[NOT_FOUND] 프로젝트(${projectId})를 찾을 수 없거나 접근 권한이 없습니다.`
      );
    }
    const projectData = (projectSnap.data() || {}) as Record<string, unknown>;
    if (projectData.ownerId && projectData.ownerId !== ownerId) {
      throw new Error(
        '[TENANT_ISOLATION_VIOLATION] 프로젝트 소유자 정보가 인증된 작가와 일치하지 않습니다.'
      );
    }

    const proposalSnap = await txReadDocStrict(
      tx,
      proposalRef,
      `changeProposals/${proposalId}`
    );
    if (!proposalSnap.exists) {
      throw new Error(
        `[PROPOSAL_NOT_FOUND] 반려할 제안서(${proposalId})가 존재하지 않습니다.`
      );
    }

    const rawProposalData = (proposalSnap.data() || {}) as Record<
      string,
      unknown
    >;
    const existingProposal = normalizeChangeProposalFromFirestore(
      rawProposalData,
      proposalId
    );

    if (
      existingProposal.ownerId !== ownerId ||
      existingProposal.projectId !== projectId
    ) {
      throw new Error(
        '[TENANT_ISOLATION_VIOLATION] 제안서의 ownerId 또는 projectId가 요청 컨텍스트와 일치하지 않습니다.'
      );
    }

    const primaryRejectedAuditSnap = await txReadDocStrict(
      tx,
      primaryRejectedAuditRef,
      `changeProposalApprovalAudits/${primaryRejectedAuditId}`
    );
    const legacyRejectedAuditSnap = legacyRejectedAuditRef
      ? await txReadDocStrict(
          tx,
          legacyRejectedAuditRef,
          `changeProposalApprovalAudits/${legacyRejectedAuditId}`
        )
      : null;
    const primaryApprovedAuditSnap = await txReadDocStrict(
      tx,
      primaryApprovedAuditRef,
      `changeProposalApprovalAudits/${primaryApprovedAuditId}`
    );
    const legacyApprovedAuditSnap = legacyApprovedAuditRef
      ? await txReadDocStrict(
          tx,
          legacyApprovedAuditRef,
          `changeProposalApprovalAudits/${legacyApprovedAuditId}`
        )
      : null;

    const existingRejectedAuditSnap = primaryRejectedAuditSnap.exists
      ? primaryRejectedAuditSnap
      : legacyRejectedAuditSnap?.exists
      ? legacyRejectedAuditSnap
      : null;
    const existingApprovedAuditSnap = primaryApprovedAuditSnap.exists
      ? primaryApprovedAuditSnap
      : legacyApprovedAuditSnap?.exists
      ? legacyApprovedAuditSnap
      : null;

    const envelopeCheck = verifyProposalEnvelopeIntegrity(existingProposal);
    if (!envelopeCheck.ok) {
      throw new Error(`[${envelopeCheck.code}] ${envelopeCheck.error}`);
    }
    const { targetEntityType, proposedAction, envelope } = envelopeCheck;

    // 1.1 Section 3.4: If already REJECTED, require the stored audit document in Firestore (no fake fallbackAudit!)
    if (existingProposal.canonStatus === 'REJECTED') {
      if (!existingRejectedAuditSnap) {
        throw new Error(
          `[AUDIT_STATE_INCONSISTENCY] 제안서(${proposalId})는 REJECTED 상태이나 반려 감사 이력(${primaryRejectedAuditId})이 Firestore에 존재하지 않습니다.`
        );
      }
      const existingAudit = normalizeApprovalAuditFromDoc(
        (existingRejectedAuditSnap.data() || {}) as Record<string, unknown>,
        existingRejectedAuditSnap.id
      );
      const auditIntegrity = verifyExistingAuditRecordMatchesProposal({
        audit: existingAudit,
        proposal: existingProposal,
        envelope,
        expectedDecision: 'REJECTED',
        expectedOwnerId: ownerId,
        expectedProjectId: projectId,
      });
      if (!auditIntegrity.ok) {
        throw new Error(`[${auditIntegrity.code}] ${auditIntegrity.error}`);
      }

      return {
        success: true,
        ok: true,
        decision: 'REJECTED',
        executionMode,
        isCloudVerified: executionMode === 'CLOUD_AUTHENTICATED',
        status: 'ALREADY_REJECTED',
        projectId,
        proposalId,
        targetEntityType,
        targetEntityId: existingProposal.targetEntityId,
        proposedAction,
        proposal: existingProposal,
        auditRecord: existingAudit,
        completedAt: existingAudit.updatedAt || nowIso,
      };
    }

    if (existingProposal.canonStatus !== 'PROPOSED') {
      throw new Error(
        `[INVALID_PROPOSAL_STATE] 현재 상태가 '${existingProposal.canonStatus}'인 제안서는 반려할 수 없습니다. ('PROPOSED' 상태만 반려 가능)`
      );
    }

    // 1.2 Section 3.3: Proposal is PROPOSED, so NO prior REJECTED or APPROVED audit may exist!
    if (existingRejectedAuditSnap || existingApprovedAuditSnap) {
      const conflictingAuditId =
        existingRejectedAuditSnap?.id || existingApprovedAuditSnap?.id || '';
      throw new Error(
        `[AUDIT_STATE_INCONSISTENCY] 제안서(${proposalId})는 PROPOSED 상태이나 기존 감사 이력(${conflictingAuditId})이 이미 존재합니다. 기존 감사 이력을 덮어쓸 수 없습니다.`
      );
    }

    if (
      request.expectedUpdatedAt &&
      request.expectedUpdatedAt.trim().length > 0 &&
      existingProposal.updatedAt !== request.expectedUpdatedAt.trim()
    ) {
      throw new Error(
        `[STALE_TARGET] 제안서(${proposalId})의 수정 시각(${existingProposal.updatedAt})이 요청 기준 시각(${request.expectedUpdatedAt})과 일치하지 않습니다.`
      );
    }

    const payoffNote =
      targetEntityType === 'FORESHADOWING' &&
      envelope.foreshadowingDraft?.payoffNote
        ? envelope.foreshadowingDraft.payoffNote.trim().slice(0, 3000)
        : '';

    const updatedProposal: ChangeProposal = {
      ...existingProposal,
      canonStatus: 'REJECTED',
      reviewedAt: nowIso,
      updatedAt: nowIso,
    };

    const auditRecord = buildApprovalAuditRecord({
      proposal: existingProposal,
      envelope,
      decision: 'REJECTED',
      reviewerUid: ownerId,
      reviewNote: request.reviewNote,
      beforeEntity: (envelope.existingEntitySnapshot as AppliedCanonEntity) || null,
      afterEntity: null,
      payoffNote,
      ragSyncStatus: 'NOT_REQUIRED',
      nowIso,
    });

    const serializedProposalDoc = serializeProposalDecisionUpdateForFirestore(
      rawProposalData,
      updatedProposal,
      nowTimestamp
    );
    const serializedAuditDoc = serializeApprovalAuditDocForFirestore(
      auditRecord,
      nowTimestamp
    );

    tx.set(proposalRef, serializedProposalDoc);

    if (
      options?.faultInjectionStep === 'AFTER_PROPOSAL_WRITE' ||
      options?.faultInjectionStep === 'BEFORE_AUDIT_WRITE'
    ) {
      throw new Error(
        '[FAULT_INJECTION_ROLLBACK] 제안서 반려 상태 갱신 직후 / 감사 로그 기록 직전 강제 오류 주입 — 전체 트랜잭션이 원자적으로 롤백되어야 합니다.'
      );
    }

    txCreateAuditRecordStrict(
      tx,
      primaryRejectedAuditRef,
      serializedAuditDoc,
      primaryRejectedAuditSnap
    );

    return {
      success: true,
      ok: true,
      decision: 'REJECTED',
      executionMode,
      isCloudVerified: executionMode === 'CLOUD_AUTHENTICATED',
      status: 'REJECTED',
      projectId,
      proposalId,
      targetEntityType,
      targetEntityId: existingProposal.targetEntityId,
      proposedAction,
      proposal: updatedProposal,
      auditRecord,
      completedAt: nowIso,
    };
  });
}

/**
 * Phase 4.2.2 Stage 2A Section 5:
 * Server-Authoritative Approval Preview & Before/After Diff Engine.
 * Performs 0 Firestore writes. Reads authoritative project, proposal, target entity,
 * revision, and referenced entities directly from Firestore.
 */
export async function previewChangeProposalApprovalOnServer(
  request: ChangeProposalPreviewRequest,
  options?: ApprovalEngineOptions
): Promise<ChangeProposalPreviewResponse> {
  const ownerId = options?.verifiedOwnerId?.trim() || '';
  if (!ownerId) {
    throw new Error(
      '[AUTH_REQUIRED] 제안서 승인 미리보기를 위해서는 검증된 작가 인증(ownerId)이 필요합니다.'
    );
  }

  const projectId = request.projectId?.trim() || '';
  const proposalId = request.proposalId?.trim() || '';
  if (!projectId || !proposalId) {
    throw new Error(
      '[BAD_REQUEST] 제안서 승인 미리보기에는 projectId와 proposalId가 모두 필요합니다.'
    );
  }

  const db = resolveExtractionFirestoreInstance(options);
  const executionMode = resolveExecutionMode(options);
  const nowIso = options?.nowIso || new Date().toISOString();

  const basePath = `users/${ownerId}/projects/${projectId}`;
  const projectSnap = await db.doc(basePath).get();
  if (!projectSnap.exists) {
    throw new Error(
      `[NOT_FOUND] 프로젝트(${projectId})를 찾을 수 없거나 접근 권한이 없습니다.`
    );
  }
  const projectData = (projectSnap.data() || {}) as Record<string, unknown>;
  if (projectData.ownerId && projectData.ownerId !== ownerId) {
    throw new Error(
      '[TENANT_ISOLATION_VIOLATION] 프로젝트 소유자 정보가 인증된 작가와 일치하지 않습니다.'
    );
  }

  const proposalSnap = await db
    .doc(`${basePath}/changeProposals/${proposalId}`)
    .get();
  if (!proposalSnap.exists) {
    throw new Error(
      `[PROPOSAL_NOT_FOUND] 미리보기할 제안서(${proposalId})가 존재하지 않습니다.`
    );
  }

  const rawProposalData = (proposalSnap.data() || {}) as Record<string, unknown>;
  const existingProposal = normalizeChangeProposalFromFirestore(
    rawProposalData,
    proposalId
  );

  if (
    existingProposal.ownerId !== ownerId ||
    existingProposal.projectId !== projectId
  ) {
    throw new Error(
      '[TENANT_ISOLATION_VIOLATION] 제안서의 ownerId 또는 projectId가 요청 컨텍스트와 일치하지 않습니다.'
    );
  }

  const envelopeCheck = verifyProposalEnvelopeIntegrity(existingProposal);
  if (!envelopeCheck.ok) {
    return {
      success: true,
      ok: true,
      executionMode,
      isCloudVerified: executionMode === 'CLOUD_AUTHENTICATED',
      canApprove: false,
      conflictCode: envelopeCheck.code,
      conflictMessage: envelopeCheck.error,
      conflictDetails: null,
      projectId,
      proposalId,
      targetEntityType:
        (existingProposal.targetEntityType as ApprovalTargetEntityType) ||
        'RELATIONSHIP',
      targetEntityId: existingProposal.targetEntityId,
      proposedAction:
        (existingProposal.proposedAction as ApprovalActionType) || 'CREATE',
      proposal: existingProposal,
      beforeEntity: null,
      afterEntityPreview: null,
      fieldDiffs: [],
      verifiedExcerpt: null,
      sourceRevisionId: existingProposal.sourceRevisionId,
      sourceEpisodeId: existingProposal.triggerEpisodeId,
      sourceSceneId: existingProposal.triggerSceneId || '',
      payoffNote: '',
      expectedUpdatedAt: existingProposal.updatedAt,
      entityDisplayNameMap: {},
      previewedAt: nowIso,
    };
  }

  const { targetEntityType, proposedAction, envelope } = envelopeCheck;
  const targetCollectionSubpath =
    resolveTargetCollectionSubpath(targetEntityType);
  const targetEntitySnap = await db
    .doc(
      `${basePath}/${targetCollectionSubpath}/${existingProposal.targetEntityId}`
    )
    .get();

  const currentEntity = targetEntitySnap.exists
    ? normalizeTargetEntityFromDoc(
        targetEntityType,
        (targetEntitySnap.data() || {}) as Record<string, unknown>,
        existingProposal.targetEntityId
      )
    : null;

  // Collect referenced IDs for validation and human-readable display names
  const episodeIdsToRead = new Set<string>();
  const sceneIdsToRead = new Set<string>();
  const characterIdsToRead = new Set<string>();
  const worldbuildingIdsToRead = new Set<string>();
  const timelineEventIdsToRead = new Set<string>();
  const foreshadowingIdsToRead = new Set<string>();

  addUniqueNonEmptyId(episodeIdsToRead, existingProposal.triggerEpisodeId);
  addUniqueNonEmptyId(episodeIdsToRead, envelope.sourceEpisodeId);
  addUniqueNonEmptyId(sceneIdsToRead, existingProposal.triggerSceneId);
  addUniqueNonEmptyId(sceneIdsToRead, envelope.sourceSceneId);

  if (targetEntityType === 'RELATIONSHIP' && envelope.relationshipDraft) {
    const draft = envelope.relationshipDraft;
    const ov = request.overrides?.relationshipOverride;
    addUniqueNonEmptyId(characterIdsToRead, draft.sourceCharacterId);
    addUniqueNonEmptyId(characterIdsToRead, draft.targetCharacterId);
    addUniqueNonEmptyId(
      characterIdsToRead,
      (currentEntity as CharacterRelationship | null)?.sourceCharacterId
    );
    addUniqueNonEmptyId(
      characterIdsToRead,
      (currentEntity as CharacterRelationship | null)?.targetCharacterId
    );
    addUniqueNonEmptyId(episodeIdsToRead, draft.lastChangedEpisodeId);
    addUniqueNonEmptyId(
      episodeIdsToRead,
      (currentEntity as CharacterRelationship | null)?.effectiveEpisodeId
    );
    addUniqueNonEmptyId(timelineEventIdsToRead, ov?.effectiveEventId);
    addUniqueNonEmptyId(
      timelineEventIdsToRead,
      (currentEntity as CharacterRelationship | null)?.effectiveEventId
    );
  } else if (
    targetEntityType === 'TIMELINE_EVENT' &&
    envelope.timelineEventDraft
  ) {
    const draft = envelope.timelineEventDraft;
    const ov = request.overrides?.timelineEventOverride;
    const curEvt = currentEntity as TimelineEvent | null;
    addUniqueNonEmptyId(episodeIdsToRead, draft.episodeId);
    addUniqueNonEmptyId(episodeIdsToRead, curEvt?.episodeId);
    addUniqueNonEmptyId(sceneIdsToRead, draft.sceneId);
    addUniqueNonEmptyId(sceneIdsToRead, ov?.sceneId);
    addUniqueNonEmptyId(sceneIdsToRead, curEvt?.sceneId);
    addUniqueNonEmptyIds(characterIdsToRead, draft.involvedCharacterIds);
    addUniqueNonEmptyIds(characterIdsToRead, ov?.participantCharacterIds);
    addUniqueNonEmptyIds(characterIdsToRead, curEvt?.participantCharacterIds);
    addUniqueNonEmptyId(worldbuildingIdsToRead, draft.locationWorldItemId);
    addUniqueNonEmptyIds(worldbuildingIdsToRead, ov?.linkedWorldbuildingIds);
    addUniqueNonEmptyIds(worldbuildingIdsToRead, curEvt?.linkedWorldbuildingIds);
    addUniqueNonEmptyIds(foreshadowingIdsToRead, ov?.linkedForeshadowingIds);
    addUniqueNonEmptyIds(
      foreshadowingIdsToRead,
      curEvt?.linkedForeshadowingIds
    );
  } else if (
    targetEntityType === 'FORESHADOWING' &&
    envelope.foreshadowingDraft
  ) {
    const draft = envelope.foreshadowingDraft;
    const ov = request.overrides?.foreshadowingOverride;
    const curFsh = currentEntity as Foreshadowing | null;
    addUniqueNonEmptyId(episodeIdsToRead, draft.plantedEpisodeId);
    addUniqueNonEmptyId(episodeIdsToRead, ov?.plantedEpisodeId);
    addUniqueNonEmptyId(episodeIdsToRead, curFsh?.plantedEpisodeId);
    addUniqueNonEmptyId(episodeIdsToRead, draft.resolvedEpisodeId);
    addUniqueNonEmptyId(episodeIdsToRead, ov?.resolvedEpisodeId);
    addUniqueNonEmptyId(episodeIdsToRead, curFsh?.resolvedEpisodeId);
    addUniqueNonEmptyId(sceneIdsToRead, draft.plantedSceneId);
    addUniqueNonEmptyId(sceneIdsToRead, ov?.plantedSceneId);
    addUniqueNonEmptyId(sceneIdsToRead, curFsh?.plantedSceneId);
    addUniqueNonEmptyId(sceneIdsToRead, draft.resolvedSceneId);
    addUniqueNonEmptyId(sceneIdsToRead, ov?.resolvedSceneId);
    addUniqueNonEmptyId(sceneIdsToRead, curFsh?.resolvedSceneId);
    addUniqueNonEmptyIds(characterIdsToRead, draft.relatedCharacterIds);
    addUniqueNonEmptyIds(characterIdsToRead, ov?.relatedCharacterIds);
    addUniqueNonEmptyIds(characterIdsToRead, curFsh?.relatedCharacterIds);
    addUniqueNonEmptyIds(timelineEventIdsToRead, draft.relatedEventIds);
    addUniqueNonEmptyIds(timelineEventIdsToRead, ov?.relatedEventIds);
    addUniqueNonEmptyIds(timelineEventIdsToRead, curFsh?.relatedEventIds);
  }

  const entityDisplayNameMap: Record<string, string> = {};

  const readSubcollectionDocs = async (
    subcollection: string,
    ids: Set<string>,
    extractDisplayName: (id: string, data: Record<string, unknown>) => string
  ): Promise<Set<string>> => {
    const validIds = new Set<string>();
    for (const id of ids) {
      const snap = await db.doc(`${basePath}/${subcollection}/${id}`).get();
      if (!snap.exists) continue;
      const data = (snap.data() || {}) as Record<string, unknown>;
      if (data.ownerId && data.ownerId !== ownerId) continue;
      if (data.projectId && data.projectId !== projectId) continue;
      if (typeof data.id === 'string' && data.id.trim() && data.id !== id) {
        continue;
      }
      validIds.add(id);
      const disp = extractDisplayName(id, data);
      if (disp) {
        entityDisplayNameMap[id] = disp;
      }
    }
    return validIds;
  };

  const validEpisodeIds = await readSubcollectionDocs(
    'episodes',
    episodeIdsToRead,
    (_id, d) => {
      const num =
        typeof d.episodeNumber === 'number' ? `제${d.episodeNumber}화 ` : '';
      const title = typeof d.title === 'string' ? d.title : '';
      return `${num}${title}`.trim();
    }
  );

  const validSceneIdsByEpisode = new Map<string, Set<string>>();
  const allValidSceneIds = new Set<string>();
  for (const sceneId of sceneIdsToRead) {
    const snap = await db.doc(`${basePath}/scenes/${sceneId}`).get();
    if (!snap.exists) continue;
    const data = (snap.data() || {}) as Record<string, unknown>;
    if (data.ownerId && data.ownerId !== ownerId) continue;
    if (data.projectId && data.projectId !== projectId) continue;
    allValidSceneIds.add(sceneId);
    const scNum =
      typeof data.sceneNumber === 'number' ? `제${data.sceneNumber}장면 ` : '';
    const scTitle = typeof data.title === 'string' ? data.title : '';
    entityDisplayNameMap[sceneId] = `${scNum}${scTitle}`.trim() || sceneId;
    const epId =
      typeof data.episodeId === 'string' ? data.episodeId.trim() : '';
    if (epId) {
      let epSet = validSceneIdsByEpisode.get(epId);
      if (!epSet) {
        epSet = new Set<string>();
        validSceneIdsByEpisode.set(epId, epSet);
      }
      epSet.add(sceneId);
    }
  }

  const validCharacterIds = await readSubcollectionDocs(
    'characters',
    characterIdsToRead,
    (_id, d) => (typeof d.name === 'string' ? d.name : '')
  );
  const validWorldbuildingIds = await readSubcollectionDocs(
    'worldbuilding',
    worldbuildingIdsToRead,
    (_id, d) => (typeof d.title === 'string' ? d.title : '')
  );
  const validTimelineEventIds = await readSubcollectionDocs(
    'timelineEvents',
    timelineEventIdsToRead,
    (_id, d) => (typeof d.title === 'string' ? d.title : '')
  );
  const validForeshadowingIds = await readSubcollectionDocs(
    'foreshadowings',
    foreshadowingIdsToRead,
    (_id, d) => (typeof d.title === 'string' ? d.title : '')
  );

  // Evaluate approval eligibility and conflicts in strict priority order
  let canApprove = true;
  let conflictCode: ApprovalConflictCode | null = null;
  let conflictMessage: string | null = null;
  let conflictDetails: ApprovalConflictDetails | null = null;

  if (existingProposal.canonStatus !== 'PROPOSED') {
    canApprove = false;
    conflictCode = 'INVALID_PROPOSAL_STATE';
    conflictMessage = `현재 상태가 '${existingProposal.canonStatus}'인 제안서는 승인할 수 없습니다 ('PROPOSED' 상태만 승인 가능).`;
  } else if (
    request.expectedUpdatedAt &&
    request.expectedUpdatedAt.trim().length > 0 &&
    existingProposal.updatedAt !== request.expectedUpdatedAt.trim()
  ) {
    canApprove = false;
    conflictCode = 'STALE_TARGET';
    conflictMessage = `제안서(${proposalId})의 수정 시각(${existingProposal.updatedAt})이 요청 기준 시각(${request.expectedUpdatedAt})과 일치하지 않습니다.`;
  }

  // Verify revision & excerpt
  const revisionSnap = await db
    .doc(`${basePath}/revisions/${existingProposal.sourceRevisionId}`)
    .get();
  if (!revisionSnap.exists) {
    if (canApprove) {
      canApprove = false;
      conflictCode = 'REVISION_NOT_FOUND';
      conflictMessage = `제안서의 근거 리비전(${existingProposal.sourceRevisionId})이 존재하지 않습니다.`;
    }
  } else {
    const rawRev = (revisionSnap.data() || {}) as Record<string, unknown>;
    const revisionDoc: Revision = {
      id:
        typeof rawRev.id === 'string' && rawRev.id
          ? rawRev.id
          : existingProposal.sourceRevisionId,
      ownerId: typeof rawRev.ownerId === 'string' ? rawRev.ownerId : ownerId,
      projectId: typeof rawRev.projectId === 'string' ? rawRev.projectId : '',
      episodeId: typeof rawRev.episodeId === 'string' ? rawRev.episodeId : '',
      episodeTitle:
        typeof rawRev.episodeTitle === 'string' ? rawRev.episodeTitle : '',
      content: typeof rawRev.content === 'string' ? rawRev.content : '',
      charCountWithSpaces:
        typeof rawRev.charCountWithSpaces === 'number'
          ? rawRev.charCountWithSpaces
          : 0,
      label: typeof rawRev.label === 'string' ? rawRev.label : '',
      createdAt: normalizeFirestoreTimestampToIso(rawRev.createdAt, nowIso),
    };
    const excerptCheck = verifyRevisionExcerptAtApproval({
      proposal: existingProposal,
      envelope,
      revision: revisionDoc,
    });
    if (!excerptCheck.ok && canApprove) {
      canApprove = false;
      conflictCode = excerptCheck.code;
      conflictMessage = excerptCheck.error;
    }
  }

  const sourceSceneIdToCheck = (
    envelope.sourceSceneId ||
    existingProposal.triggerSceneId ||
    ''
  ).trim();
  if (
    sourceSceneIdToCheck &&
    !allValidSceneIds.has(sourceSceneIdToCheck) &&
    canApprove
  ) {
    canApprove = false;
    conflictCode = 'REFERENCE_INTEGRITY_ERROR';
    conflictMessage = `제안서에 연결된 장면(${sourceSceneIdToCheck})이 프로젝트에 존재하지 않습니다.`;
  }

  // Run target entity stale/conflict detection even if proposal is already decided,
  // unless proposal is already CANON (where currentEntity is the applied entity)
  if (existingProposal.canonStatus === 'PROPOSED') {
    const conflictCheck = detectTargetEntityStaleOrConflict({
      envelope,
      currentEntity,
      expectedOwnerId: ownerId,
      expectedProjectId: projectId,
    });
    if (!conflictCheck.ok) {
      canApprove = false;
      if (!conflictCode) {
        conflictCode = conflictCheck.code;
        conflictMessage = conflictCheck.error;
      }
      conflictDetails = conflictCheck.conflictDetails || null;
    }
  }

  // Build candidate entity preview & validate references
  const fallbackPreview = buildPreviewTargetEntityCandidate({
    proposal: existingProposal,
    envelope,
    existingEntity: currentEntity,
    nowIso,
    overrides: request.overrides,
  });

  let afterEntityPreview: AppliedCanonEntity | null =
    fallbackPreview.afterEntityPreview;
  let payoffNote = fallbackPreview.payoffNote;

  if (targetEntityType === 'RELATIONSHIP' && envelope.relationshipDraft) {
    const mappedRes = mapApprovedRelationship({
      proposal: existingProposal,
      draft: envelope.relationshipDraft,
      existingEntity: (currentEntity as CharacterRelationship) || null,
      validCharacterIds,
      validTimelineEventIds,
      validEpisodeIds,
      nowIso,
      overrides: request.overrides?.relationshipOverride,
    });
    if (mappedRes.ok) {
      afterEntityPreview = mappedRes.entity;
    } else if (canApprove) {
      canApprove = false;
      conflictCode = mappedRes.code;
      conflictMessage = mappedRes.error;
    }
  } else if (
    targetEntityType === 'TIMELINE_EVENT' &&
    envelope.timelineEventDraft
  ) {
    const epId = (
      envelope.timelineEventDraft.episodeId ||
      existingProposal.triggerEpisodeId ||
      (currentEntity as TimelineEvent | null)?.episodeId ||
      ''
    ).trim();
    const validSceneIdsForEpisode =
      validSceneIdsByEpisode.get(epId) || new Set<string>();
    const mappedRes = mapApprovedTimelineEvent({
      proposal: existingProposal,
      draft: envelope.timelineEventDraft,
      existingEntity: (currentEntity as TimelineEvent) || null,
      validCharacterIds,
      validWorldbuildingIds,
      validForeshadowingIds,
      validEpisodeIds,
      validSceneIdsForEpisode,
      nowIso,
      overrides: request.overrides?.timelineEventOverride,
    });
    if (mappedRes.ok) {
      afterEntityPreview = mappedRes.entity;
    } else if (canApprove) {
      canApprove = false;
      conflictCode = mappedRes.code;
      conflictMessage = mappedRes.error;
    }
  } else if (
    targetEntityType === 'FORESHADOWING' &&
    envelope.foreshadowingDraft
  ) {
    const mappedRes = mapApprovedForeshadowing({
      proposal: existingProposal,
      draft: envelope.foreshadowingDraft,
      existingEntity: (currentEntity as Foreshadowing) || null,
      validCharacterIds,
      validTimelineEventIds,
      validEpisodeIds,
      validSceneIdsByEpisode,
      nowIso,
      overrides: request.overrides?.foreshadowingOverride,
    });
    if (mappedRes.ok) {
      afterEntityPreview = mappedRes.entity;
      payoffNote = mappedRes.payoffNote;
    } else if (canApprove) {
      canApprove = false;
      conflictCode = mappedRes.code;
      conflictMessage = mappedRes.error;
    }
  }

  // If the proposal is already CANON or REJECTED and has an existingEntitySnapshot in envelope,
  // use existingEntitySnapshot as beforeEntity when proposedAction === 'UPDATE' so historical diff stays accurate.
  let beforeEntityForDiff: AppliedCanonEntity | null = currentEntity;
  if (
    existingProposal.canonStatus === 'CANON' &&
    proposedAction === 'CREATE'
  ) {
    beforeEntityForDiff = null;
  } else if (
    existingProposal.canonStatus === 'CANON' &&
    proposedAction === 'UPDATE' &&
    envelope.existingEntitySnapshot
  ) {
    beforeEntityForDiff = normalizeTargetEntityFromDoc(
      targetEntityType,
      envelope.existingEntitySnapshot,
      existingProposal.targetEntityId
    );
  }

  const fieldDiffs = buildChangeProposalFieldDiff({
    targetEntityType,
    proposedAction,
    beforeEntity: beforeEntityForDiff,
    afterEntity: afterEntityPreview,
    payoffNote,
    conflictDetails,
    conflictCode,
    entityDisplayNameMap,
  });

  return {
    success: true,
    ok: true,
    executionMode,
    isCloudVerified: executionMode === 'CLOUD_AUTHENTICATED',
    canApprove,
    conflictCode,
    conflictMessage,
    conflictDetails,
    projectId,
    proposalId,
    targetEntityType,
    targetEntityId: existingProposal.targetEntityId,
    proposedAction,
    proposal: existingProposal,
    beforeEntity: beforeEntityForDiff,
    afterEntityPreview,
    fieldDiffs,
    verifiedExcerpt: envelope.verifiedExcerpt,
    sourceRevisionId: existingProposal.sourceRevisionId,
    sourceEpisodeId:
      envelope.sourceEpisodeId || existingProposal.triggerEpisodeId,
    sourceSceneId:
      envelope.sourceSceneId || existingProposal.triggerSceneId || '',
    payoffNote,
    expectedUpdatedAt: currentEntity?.updatedAt || existingProposal.updatedAt,
    entityDisplayNameMap,
    previewedAt: nowIso,
  };
}

/**
 * Phase 4.2.2 Stage 2A Section 10:
 * Lists all `ChangeProposalApprovalAudit` records for a project from Firestore.
 */
export async function listApprovalAuditsOnServer(
  params: { projectId: string },
  options?: ApprovalEngineOptions
): Promise<ApprovalAuditListResponse> {
  const ownerId = options?.verifiedOwnerId?.trim() || '';
  if (!ownerId) {
    throw new Error(
      '[AUTH_REQUIRED] 감사 이력 조회를 위해서는 검증된 작가 인증(ownerId)이 필요합니다.'
    );
  }
  const projectId = params.projectId?.trim() || '';
  if (!projectId) {
    throw new Error(
      '[BAD_REQUEST] 감사 이력 조회에는 projectId가 필요합니다.'
    );
  }

  const db = resolveExtractionFirestoreInstance(options);
  const executionMode = resolveExecutionMode(options);
  const nowIso = options?.nowIso || new Date().toISOString();

  const basePath = `users/${ownerId}/projects/${projectId}`;
  const projectSnap = await db.doc(basePath).get();
  if (!projectSnap.exists) {
    throw new Error(
      `[NOT_FOUND] 프로젝트(${projectId})를 찾을 수 없거나 접근 권한이 없습니다.`
    );
  }
  const projectData = (projectSnap.data() || {}) as Record<string, unknown>;
  if (projectData.ownerId && projectData.ownerId !== ownerId) {
    throw new Error(
      '[TENANT_ISOLATION_VIOLATION] 프로젝트 소유자 정보가 인증된 작가와 일치하지 않습니다.'
    );
  }

  const auditsCol = db.collection(`${basePath}/changeProposalApprovalAudits`);
  const snap = await auditsCol.get();
  const audits: ChangeProposalApprovalAudit[] = [];
  for (const docItem of snap.docs) {
    const raw = (docItem.data() || {}) as Record<string, unknown>;
    if (raw.ownerId && raw.ownerId !== ownerId) continue;
    if (raw.projectId && raw.projectId !== projectId) continue;
    audits.push(normalizeApprovalAuditFromDoc(raw, docItem.id));
  }
  audits.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return {
    success: true,
    executionMode,
    isCloudVerified: executionMode === 'CLOUD_AUTHENTICATED',
    projectId,
    audits,
    fetchedAt: nowIso,
  };
}

function buildRecoveredTaskFromAudit(params: {
  taskId: string;
  ownerId: string;
  projectId: string;
  audit: ChangeProposalApprovalAudit;
  nowIso: string;
}): RagSyncTaskRecord {
  const { taskId, ownerId, projectId, audit, nowIso } = params;
  let expectedEntityUpdatedAt = '';
  let expectedContentHash = '';
  let expectedSourceRevisionId = audit.sourceRevisionId || '';

  if (audit.afterSnapshotJson && audit.afterSnapshotJson !== 'null') {
    try {
      const parsed = JSON.parse(audit.afterSnapshotJson) as Record<
        string,
        unknown
      > | null;
      if (parsed && typeof parsed === 'object') {
        const normalizedEntity = normalizeTargetEntityFromDoc(
          audit.targetEntityType,
          parsed,
          audit.targetEntityId
        );
        expectedEntityUpdatedAt = normalizedEntity.updatedAt || '';
        expectedContentHash =
          computeEntityCanonicalContentHash(normalizedEntity);
        if (normalizedEntity.sourceRevisionId) {
          expectedSourceRevisionId = normalizedEntity.sourceRevisionId;
        }
      }
    } catch {
      // ignore malformed snapshot JSON during recovery
    }
  }

  return {
    id: taskId,
    ownerId,
    projectId,
    proposalId: audit.proposalId,
    auditId: audit.id,
    targetEntityType: audit.targetEntityType,
    targetEntityId: audit.targetEntityId,
    sourceRevisionId: audit.sourceRevisionId,
    expectedSourceRevisionId,
    expectedEntityUpdatedAt,
    expectedContentHash,
    status: audit.ragSyncStatus === 'SYNCED' ? 'SYNCED' : 'PENDING',
    attemptCount: 0,
    maxAttempts: 5,
    manualRetryCount: 0,
    leaseOwner: '',
    leaseGeneration: 0,
    leaseExpiresAtMs: 0,
    nextRetryAfterMs: 0,
    lastError: audit.ragSyncError || '',
    memoryDocumentId: '',
    createdAt: audit.createdAt,
    updatedAt: nowIso,
  };
}

/**
 * Phase 4.2.2 Stage 2.5 Section 6.3:
 * Renews an active RAG sync task lease inside a Firestore transaction ONLY if the caller still holds
 * the exact `leaseOwner`, `leaseGeneration`, `attemptCount`, and `PROCESSING` status.
 */
export async function renewRagTaskLeaseOnServer(params: {
  db: Firestore;
  ownerId: string;
  projectId: string;
  leasedTask: RagSyncTaskRecord;
  extendDurationMs?: number;
  nowIso?: string;
}): Promise<{
  renewed: boolean;
  reason?: string;
  task?: RagSyncTaskRecord;
}> {
  const {
    db,
    ownerId,
    projectId,
    leasedTask,
    extendDurationMs = 30_000,
    nowIso = new Date().toISOString(),
  } = params;
  const nowDate = new Date(nowIso);
  const nowMs = Number.isNaN(nowDate.getTime())
    ? Date.now()
    : nowDate.getTime();
  const nowTimestamp = Timestamp.fromDate(new Date(nowMs));
  const taskRef = db.doc(
    `users/${ownerId}/projects/${projectId}/ragSyncTasks/${leasedTask.id}`
  );

  return await db.runTransaction(async (tx: Transaction) => {
    const snap = await txReadDocStrict(
      tx,
      taskRef,
      `ragSyncTasks/${leasedTask.id}`
    );
    if (!snap.exists) {
      return { renewed: false, reason: 'TASK_NOT_FOUND' };
    }
    const raw = (snap.data() || {}) as Record<string, unknown>;
    const currentTask = normalizeRagSyncTaskFromDoc(raw, leasedTask.id);
    const fencing = verifyRagTaskLeaseFencing({ currentTask, leasedTask });
    if (!fencing.ok) {
      return { renewed: false, reason: fencing.reason, task: currentTask };
    }

    const updated: RagSyncTaskRecord = {
      ...currentTask,
      leaseExpiresAtMs: nowMs + Math.max(5_000, extendDurationMs),
      updatedAt: nowIso,
    };
    tx.set(
      taskRef,
      serializeRagSyncTaskDocForFirestore(updated, nowTimestamp, raw.createdAt)
    );
    return { renewed: true, task: updated };
  });
}

/**
 * Phase 4.2.2 Stage 2.5 Sections 6, 7, 8, 9 & 10:
 * Post-Commit RAG Synchronization Engine for Approved `ChangeProposal` Entities.
 *
 * - Runs strictly OUTSIDE the Firestore approval transaction.
 * - Acquires a fenced atomic lease (`leaseGeneration` + `leaseOwner` + `attemptCount`) on `ragSyncTasks/{taskId}`.
 * - Enforces exponential backoff (`nextRetryAfterMs`) and `maxAttempts` without allowing `proposalId`/`auditId` or `forceRetry` to bypass limits.
 * - Verifies authoritative `CANON` entity freshness (`sourceRevisionId`, `updatedAt`, `contentHash`) before AND after indexing so an older approval task can NEVER overwrite a newer `CANON` index.
 * - Verifies lease fencing (`verifyRagTaskLeaseFencing`) inside the final commit transaction so a worker whose lease expired can NEVER overwrite a newer worker's `SYNCED` or `PROCESSING` state.
 */
export async function executeRagSyncForApprovedProposalOnServer(
  request: RagSyncExecutionRequest,
  options?: ApprovalEngineOptions & {
    ragIndexingOptions?: RagIndexingOptions;
    customIndexRunner?: (
      input: NonNullable<
        ReturnType<typeof buildMemoryIndexInputFromApprovedEntity>
      >
    ) => Promise<{
      document: { id: string };
      durableCommitVerified?: boolean;
      activeGenerationVerified?: boolean;
    }>;
    leaseDurationMs?: number;
    workerId?: string;
  }
): Promise<RagSyncExecutionResponse> {
  const ownerId = options?.verifiedOwnerId?.trim() || '';
  if (!ownerId) {
    throw new Error(
      '[AUTH_REQUIRED] RAG 장기 기억 동기화를 위해서는 검증된 작가 인증(ownerId)이 필요합니다.'
    );
  }
  const projectId = request.projectId?.trim() || '';
  if (!projectId) {
    throw new Error(
      '[BAD_REQUEST] RAG 장기 기억 동기화에는 projectId가 필요합니다.'
    );
  }

  const db = resolveExtractionFirestoreInstance(options);
  const executionMode = resolveExecutionMode(options);
  const nowIso = options?.nowIso || new Date().toISOString();
  const nowDate = new Date(nowIso);
  const nowMs = Number.isNaN(nowDate.getTime())
    ? Date.now()
    : nowDate.getTime();
  const nowTimestamp = Timestamp.fromDate(new Date(nowMs));
  const leaseDurationMs = Math.max(
    5_000,
    options?.leaseDurationMs ?? request.leaseDurationMs ?? 30_000
  );
  const workerId =
    options?.workerId?.trim() ||
    request.workerId?.trim() ||
    `worker_${process.pid}_${nowMs}`;

  const basePath = `users/${ownerId}/projects/${projectId}`;
  const projectRef = db.doc(basePath);
  const projectSnap = await projectRef.get();
  if (!projectSnap.exists) {
    throw new Error(
      `[NOT_FOUND] 프로젝트(${projectId})를 찾을 수 없거나 접근 권한이 없습니다.`
    );
  }
  const projectData = (projectSnap.data() || {}) as Record<string, unknown>;
  if (projectData.ownerId && projectData.ownerId !== ownerId) {
    throw new Error(
      '[TENANT_ISOLATION_VIOLATION] 프로젝트 소유자 정보가 인증된 작가와 일치하지 않습니다.'
    );
  }

  // 1. Discover target RAG sync tasks (and recover missing tasks from APPROVED audits with PENDING/FAILED status)
  const candidateTaskIds = new Set<string>();
  const auditsCol = db.collection(`${basePath}/changeProposalApprovalAudits`);
  const tasksCol = db.collection(`${basePath}/ragSyncTasks`);

  if (request.taskId?.trim()) {
    candidateTaskIds.add(request.taskId.trim());
  } else if (request.proposalId?.trim()) {
    const pId = request.proposalId.trim();
    const tId = computeDeterministicRagSyncTaskId(pId);
    candidateTaskIds.add(tId);

    const tRef = db.doc(`${basePath}/ragSyncTasks/${tId}`);
    const tSnap = await tRef.get();
    if (!tSnap.exists) {
      const aId = computeDeterministicApprovalAuditId(pId, 'APPROVED');
      const aSnap = await db
        .doc(`${basePath}/changeProposalApprovalAudits/${aId}`)
        .get();
      if (aSnap.exists) {
        const audit = normalizeApprovalAuditFromDoc(
          (aSnap.data() || {}) as Record<string, unknown>,
          aSnap.id
        );
        if (audit.decision === 'APPROVED') {
          const recoveredTask = buildRecoveredTaskFromAudit({
            taskId: tId,
            ownerId,
            projectId,
            audit,
            nowIso,
          });
          await tRef.set(
            serializeRagSyncTaskDocForFirestore(recoveredTask, nowTimestamp)
          );
        }
      }
    }
  } else if (request.auditId?.trim()) {
    const aSnap = await db
      .doc(`${basePath}/changeProposalApprovalAudits/${request.auditId.trim()}`)
      .get();
    if (aSnap.exists) {
      const audit = normalizeApprovalAuditFromDoc(
        (aSnap.data() || {}) as Record<string, unknown>,
        aSnap.id
      );
      if (audit.decision === 'APPROVED' && audit.proposalId) {
        const tId = computeDeterministicRagSyncTaskId(audit.proposalId);
        candidateTaskIds.add(tId);
        const tRef = db.doc(`${basePath}/ragSyncTasks/${tId}`);
        const tSnap = await tRef.get();
        if (!tSnap.exists) {
          const recoveredTask = buildRecoveredTaskFromAudit({
            taskId: tId,
            ownerId,
            projectId,
            audit,
            nowIso,
          });
          await tRef.set(
            serializeRagSyncTaskDocForFirestore(recoveredTask, nowTimestamp)
          );
        }
      }
    }
  } else {
    const tasksSnap = await tasksCol.get();
    for (const d of tasksSnap.docs) {
      const raw = (d.data() || {}) as Record<string, unknown>;
      const st = raw.status as RagSyncTaskStatus;
      if (st === 'PENDING' || st === 'FAILED' || st === 'PROCESSING') {
        candidateTaskIds.add(d.id);
      }
    }
    const auditsSnap = await auditsCol.get();
    for (const d of auditsSnap.docs) {
      const audit = normalizeApprovalAuditFromDoc(
        (d.data() || {}) as Record<string, unknown>,
        d.id
      );
      if (
        audit.decision === 'APPROVED' &&
        (audit.ragSyncStatus === 'PENDING' ||
          audit.ragSyncStatus === 'FAILED' ||
          audit.ragSyncStatus === 'PROCESSING')
      ) {
        const tId = computeDeterministicRagSyncTaskId(audit.proposalId);
        candidateTaskIds.add(tId);
        const tRef = db.doc(`${basePath}/ragSyncTasks/${tId}`);
        const tSnap = await tRef.get();
        if (!tSnap.exists) {
          const recoveredTask = buildRecoveredTaskFromAudit({
            taskId: tId,
            ownerId,
            projectId,
            audit,
            nowIso,
          });
          await tRef.set(
            serializeRagSyncTaskDocForFirestore(recoveredTask, nowTimestamp)
          );
        }
      }
    }
  }

  // Preload character names and episode numbers from Firestore for rich RAG text
  const characterNameMap: Record<string, string> = {};
  const episodeNumberMap: Record<string, number> = {};
  try {
    const charsSnap = await db.collection(`${basePath}/characters`).get();
    for (const d of charsSnap.docs) {
      const data = (d.data() || {}) as Record<string, unknown>;
      if (typeof data.name === 'string' && data.name.trim()) {
        characterNameMap[d.id] = data.name.trim();
      }
    }
    const epsSnap = await db.collection(`${basePath}/episodes`).get();
    for (const d of epsSnap.docs) {
      const data = (d.data() || {}) as Record<string, unknown>;
      if (typeof data.episodeNumber === 'number') {
        episodeNumberMap[d.id] = data.episodeNumber;
      }
    }
  } catch {
    // non-fatal if character/episode lookup is empty
  }

  const results: RagSyncExecutionResponse['results'] = [];
  let processedCount = 0;
  let syncedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const taskId of candidateTaskIds) {
    const taskRef = db.doc(`${basePath}/ragSyncTasks/${taskId}`);

    // Step A: Atomic Lease Acquisition Transaction with monotonic leaseGeneration & retry policy enforcement
    const leaseOutcome = await db.runTransaction(async (tx: Transaction) => {
      const snap = await txReadDocStrict(tx, taskRef, `ragSyncTasks/${taskId}`);
      if (!snap.exists) {
        return {
          acquired: false as const,
          reason: 'TASK_NOT_FOUND',
          retryAfterMs: undefined as number | undefined,
        };
      }
      const rawTask = (snap.data() || {}) as Record<string, unknown>;
      const task = normalizeRagSyncTaskFromDoc(rawTask, taskId);

      const retryEval = evaluateRagSyncRetryPolicy({
        task,
        nowMs,
        workerId,
        forceRetry: request.forceRetry,
        manualRetry: request.manualRetry,
      });

      if (!retryEval.allowed) {
        return {
          acquired: false as const,
          reason: retryEval.reason,
          retryAfterMs: retryEval.retryAfterMs,
          task,
        };
      }

      const nextLeaseGen = (task.leaseGeneration || 0) + 1;
      const nextManualCount =
        (task.manualRetryCount || 0) +
        (retryEval.incrementManualRetry ? 1 : 0);

      const leasedTask: RagSyncTaskRecord = {
        ...task,
        status: 'PROCESSING',
        attemptCount: task.attemptCount + 1,
        manualRetryCount: nextManualCount,
        leaseOwner: workerId,
        leaseGeneration: nextLeaseGen,
        leaseExpiresAtMs: nowMs + leaseDurationMs,
        updatedAt: nowIso,
      };
      tx.set(
        taskRef,
        serializeRagSyncTaskDocForFirestore(
          leasedTask,
          nowTimestamp,
          rawTask.createdAt
        )
      );
      return { acquired: true as const, task: leasedTask };
    });

    if (!leaseOutcome.acquired) {
      skippedCount += 1;
      if (leaseOutcome.task) {
        const t = leaseOutcome.task;
        results.push({
          taskId: t.id,
          proposalId: t.proposalId,
          auditId: t.auditId,
          targetEntityType: t.targetEntityType,
          targetEntityId: t.targetEntityId,
          ragSyncStatus:
            t.status === 'SYNCED'
              ? 'SYNCED'
              : t.status === 'SUPERSEDED'
              ? 'SUPERSEDED'
              : t.status === 'FAILED'
              ? 'FAILED'
              : t.status === 'PROCESSING'
              ? 'PROCESSING'
              : 'PENDING',
          ragSyncError: t.lastError,
          memoryDocumentId: t.memoryDocumentId,
          leaseGeneration: t.leaseGeneration,
          skippedReason: leaseOutcome.reason,
          retryAfterMs: leaseOutcome.retryAfterMs,
        });
      }
      continue;
    }

    const leasedTask = leaseOutcome.task;
    processedCount += 1;

    // Step B: Re-verify project and authoritative CANON entity directly from Firestore (Section 7)
    const currentProjSnap = await projectRef.get();
    const targetSubpath = resolveTargetCollectionSubpath(
      leasedTask.targetEntityType
    );
    const entityRef = db.doc(
      `${basePath}/${targetSubpath}/${leasedTask.targetEntityId}`
    );
    const entitySnap = await entityRef.get();
    const auditRef = db.doc(
      `${basePath}/changeProposalApprovalAudits/${leasedTask.auditId}`
    );

    const authoritativeEntity =
      currentProjSnap.exists && entitySnap.exists
        ? normalizeTargetEntityFromDoc(
            leasedTask.targetEntityType,
            (entitySnap.data() || {}) as Record<string, unknown>,
            leasedTask.targetEntityId
          )
        : null;

    const preIndexFreshness = verifyCanonEntityFreshnessForRag({
      task: leasedTask,
      authoritativeEntity,
    });

    if (!currentProjSnap.exists || !preIndexFreshness.ok) {
      const skipCode = !currentProjSnap.exists
        ? 'ENTITY_OR_PROJECT_DELETED'
        : !preIndexFreshness.ok
        ? preIndexFreshness.reason === 'ENTITY_NOT_FOUND'
          ? 'ENTITY_OR_PROJECT_DELETED'
          : preIndexFreshness.reason
        : 'ENTITY_NOT_CANON';
      const skipMsg = !currentProjSnap.exists
        ? '대상 프로젝트가 삭제되어 색인이 생략되었습니다.'
        : !preIndexFreshness.ok
        ? preIndexFreshness.message
        : '';

      const nextAuditStatus: ApprovalRagSyncStatus =
        skipCode === 'SUPERSEDED_BY_NEWER_CANON'
          ? 'SUPERSEDED'
          : 'NOT_REQUIRED';

      const supersededCommit = await db.runTransaction(
        async (tx: Transaction) => {
          const tSnap = await txReadDocStrict(
            tx,
            taskRef,
            `ragSyncTasks/${taskId}`
          );
          const aSnap = await txReadDocStrict(
            tx,
            auditRef,
            `changeProposalApprovalAudits/${leasedTask.auditId}`
          );
          if (!tSnap.exists) {
            return { committed: false, reason: 'TASK_NOT_FOUND' };
          }
          const rawT = (tSnap.data() || {}) as Record<string, unknown>;
          const currentT = normalizeRagSyncTaskFromDoc(rawT, taskId);
          const fencing = verifyRagTaskLeaseFencing({
            currentTask: currentT,
            leasedTask,
          });
          if (!fencing.ok) {
            return { committed: false, reason: fencing.reason };
          }

          const supersededTask: RagSyncTaskRecord = {
            ...leasedTask,
            status: 'SUPERSEDED',
            leaseOwner: '',
            leaseExpiresAtMs: 0,
            lastError: skipMsg,
            updatedAt: nowIso,
          };
          tx.set(
            taskRef,
            serializeRagSyncTaskDocForFirestore(
              supersededTask,
              nowTimestamp,
              rawT.createdAt
            )
          );

          if (aSnap.exists) {
            const rawA = (aSnap.data() || {}) as Record<string, unknown>;
            const existingAudit = normalizeApprovalAuditFromDoc(
              rawA,
              leasedTask.auditId
            );
            const updatedAudit: ChangeProposalApprovalAudit = {
              ...existingAudit,
              ragSyncStatus: nextAuditStatus,
              ragSyncError: skipMsg,
              updatedAt: nowIso,
            };
            tx.set(
              auditRef,
              serializeApprovalAuditDocForFirestore(
                updatedAudit,
                nowTimestamp,
                rawA.createdAt
              )
            );
          }
          return { committed: true, reason: skipCode };
        }
      );

      skippedCount += 1;
      results.push({
        taskId: leasedTask.id,
        proposalId: leasedTask.proposalId,
        auditId: leasedTask.auditId,
        targetEntityType: leasedTask.targetEntityType,
        targetEntityId: leasedTask.targetEntityId,
        ragSyncStatus: nextAuditStatus,
        ragSyncError: skipMsg,
        memoryDocumentId: '',
        leaseGeneration: leasedTask.leaseGeneration,
        skippedReason: supersededCommit.reason,
      });
      continue;
    }

    // Step C: Execute RAG Indexing using the verified authoritative CANON entity
    const memoryInput = buildMemoryIndexInputFromApprovedEntity({
      ownerId,
      projectId,
      targetEntityType: leasedTask.targetEntityType,
      entity: authoritativeEntity!,
      characterNameMap,
      episodeNumberMap,
    });

    if (!memoryInput) {
      skippedCount += 1;
      results.push({
        taskId: leasedTask.id,
        proposalId: leasedTask.proposalId,
        auditId: leasedTask.auditId,
        targetEntityType: leasedTask.targetEntityType,
        targetEntityId: leasedTask.targetEntityId,
        ragSyncStatus: 'NOT_REQUIRED',
        ragSyncError: '',
        memoryDocumentId: '',
        leaseGeneration: leasedTask.leaseGeneration,
        skippedReason: 'ENTITY_NOT_CANON',
      });
      continue;
    }

    // Pre-commit guard executed right before ragEngine activates/persists the index
    const verifyLeaseAndFreshnessBeforeIndexCommit = async (): Promise<void> => {
      const [latestTaskSnap, latestEntitySnap] = await Promise.all([
        taskRef.get(),
        entityRef.get(),
      ]);
      const latestTask = latestTaskSnap.exists
        ? normalizeRagSyncTaskFromDoc(
            (latestTaskSnap.data() || {}) as Record<string, unknown>,
            taskId
          )
        : null;
      const fencing = verifyRagTaskLeaseFencing({
        currentTask: latestTask,
        leasedTask,
      });
      if (!fencing.ok) {
        throw new Error(`[${fencing.reason}] ${fencing.message}`);
      }

      const latestEntity = latestEntitySnap.exists
        ? normalizeTargetEntityFromDoc(
            leasedTask.targetEntityType,
            (latestEntitySnap.data() || {}) as Record<string, unknown>,
            leasedTask.targetEntityId
          )
        : null;
      const freshness = verifyCanonEntityFreshnessForRag({
        task: leasedTask,
        authoritativeEntity: latestEntity,
      });
      if (!freshness.ok) {
        throw new Error(`[${freshness.reason}] ${freshness.message}`);
      }
    };

    try {
      const activationToken = `${leasedTask.id}:gen_${leasedTask.leaseGeneration}:att_${leasedTask.attemptCount}`;
      const indexResult = options?.customIndexRunner
        ? await options.customIndexRunner(memoryInput)
        : await indexMemoryInputOnServer(memoryInput, {
            ...options?.ragIndexingOptions,
            db: options?.db,
            beforeCommitGuard: verifyLeaseAndFreshnessBeforeIndexCommit,
            durableCommitPolicy: {
              requireDurableCloudCommit: true,
              requireActiveGenerationVerification: true,
            },
            activationGuard: {
              leasedTask,
              activationToken,
            },
          });

      const memoryDocumentId = indexResult?.document?.id || '';
      if (!memoryDocumentId) {
        throw new Error(
          '[RAG_INDEX_DOCUMENT_ID_MISSING] 색인 결과에 유효한 memoryDocumentId가 반환되지 않았습니다.'
        );
      }

      if (
        !options?.customIndexRunner &&
        (!indexResult?.durableCommitVerified ||
          !indexResult?.activeGenerationVerified)
      ) {
        throw new Error(
          '[FIRESTORE_DURABILITY_NOT_VERIFIED] Firestore 색인 영구 저장 또는 활성 세대 전환(ragManifest/control)이 검증되지 않았습니다.'
        );
      }

      // Step D: Fenced Transaction to verify Firestore durability & mark Task & Audit as SYNCED
      const syncCommitOutcome = await db.runTransaction(
        async (tx: Transaction) => {
          const tSnap = await txReadDocStrict(
            tx,
            taskRef,
            `ragSyncTasks/${taskId}`
          );
          const aSnap = await txReadDocStrict(
            tx,
            auditRef,
            `changeProposalApprovalAudits/${leasedTask.auditId}`
          );
          const eSnap = await txReadDocStrict(
            tx,
            entityRef,
            `${targetSubpath}/${leasedTask.targetEntityId}`
          );

          const memoryDocRef = db.doc(
            `${basePath}/memoryDocuments/${memoryDocumentId}`
          );
          const manifestRef = db.doc(`${basePath}/ragManifest/control`);
          const memoryDocSnap = !options?.customIndexRunner
            ? await txReadDocStrict(
                tx,
                memoryDocRef,
                `memoryDocuments/${memoryDocumentId}`
              )
            : null;
          const manifestSnap = !options?.customIndexRunner
            ? await txReadDocStrict(tx, manifestRef, 'ragManifest/control')
            : null;

          if (!tSnap.exists) {
            return {
              committed: false as const,
              reason: 'TASK_NOT_FOUND',
              currentTask: null,
            };
          }

          const rawT = (tSnap.data() || {}) as Record<string, unknown>;
          const currentTask = normalizeRagSyncTaskFromDoc(rawT, taskId);

          // Section 6.2: Verify leaseOwner, leaseGeneration, attemptCount, and PROCESSING status
          const fencing = verifyRagTaskLeaseFencing({
            currentTask,
            leasedTask,
          });
          if (!fencing.ok) {
            return {
              committed: false as const,
              reason: fencing.reason,
              currentTask,
            };
          }

          // Section 7.2: Verify authoritative entity was not superseded while indexing ran
          const latestEntity = eSnap.exists
            ? normalizeTargetEntityFromDoc(
                leasedTask.targetEntityType,
                (eSnap.data() || {}) as Record<string, unknown>,
                leasedTask.targetEntityId
              )
            : null;
          const freshness = verifyCanonEntityFreshnessForRag({
            task: leasedTask,
            authoritativeEntity: latestEntity,
          });

          if (!freshness.ok) {
            const nextStatus: ApprovalRagSyncStatus =
              freshness.reason === 'SUPERSEDED_BY_NEWER_CANON'
                ? 'SUPERSEDED'
                : 'NOT_REQUIRED';
            const supersededTask: RagSyncTaskRecord = {
              ...leasedTask,
              status: 'SUPERSEDED',
              leaseOwner: '',
              leaseExpiresAtMs: 0,
              lastError: freshness.message,
              updatedAt: nowIso,
            };
            tx.set(
              taskRef,
              serializeRagSyncTaskDocForFirestore(
                supersededTask,
                nowTimestamp,
                rawT.createdAt
              )
            );
            if (aSnap.exists) {
              const rawA = (aSnap.data() || {}) as Record<string, unknown>;
              const existingAudit = normalizeApprovalAuditFromDoc(
                rawA,
                leasedTask.auditId
              );
              const updatedAudit: ChangeProposalApprovalAudit = {
                ...existingAudit,
                ragSyncStatus: nextStatus,
                ragSyncError: freshness.message,
                updatedAt: nowIso,
              };
              tx.set(
                auditRef,
                serializeApprovalAuditDocForFirestore(
                  updatedAudit,
                  nowTimestamp,
                  rawA.createdAt
                )
              );
            }
            return {
              committed: false as const,
              reason: freshness.reason,
              currentTask: supersededTask,
            };
          }

          // Section 8: Strict verification of Firestore MemoryDocument & ragManifest/control inside Step D
          if (!options?.customIndexRunner) {
            if (!memoryDocSnap || !memoryDocSnap.exists) {
              throw new Error(
                `[RAG_INDEX_DOCUMENT_NOT_FOUND] [FIRESTORE_DURABILITY_NOT_VERIFIED] Firestore에 색인 문서(${memoryDocumentId})가 존재하지 않아 SYNCED 전환이 차단되었습니다.`
              );
            }
            if (!manifestSnap || !manifestSnap.exists) {
              throw new Error(
                `[FIRESTORE_MANIFEST_ACTIVATION_FAILED] [FIRESTORE_DURABILITY_NOT_VERIFIED] Firestore ragManifest/control 문서가 존재하지 않아 SYNCED 전환이 차단되었습니다.`
              );
            }
            const memDocData = (memoryDocSnap.data() || {}) as Record<
              string,
              unknown
            >;
            const manifestData = (manifestSnap.data() || {}) as Record<
              string,
              unknown
            >;
            const entityStates =
              (manifestData.entityStates as Record<
                string,
                EntityIndexLifecycleState
              >) || {};
            const entityKey = `${ownerId}:${projectId}:${leasedTask.targetEntityType}:${leasedTask.targetEntityId}`;
            const manifestEntity = entityStates[entityKey];
            if (
              !manifestEntity ||
              manifestEntity.lifecycleStatus !== 'ACTIVE' ||
              !Array.isArray(manifestEntity.activeDocumentIds) ||
              !manifestEntity.activeDocumentIds.includes(memoryDocumentId) ||
              manifestEntity.activeGeneration !== memDocData.indexGeneration
            ) {
              throw new Error(
                `[RAG_ACTIVE_GENERATION_MISMATCH] [FIRESTORE_DURABILITY_NOT_VERIFIED] ragManifest/control의 활성 세대 상태가 색인 문서(${memoryDocumentId})와 일치하지 않아 SYNCED 전환이 차단되었습니다.`
              );
            }

            const isManifestPointerMode =
              memDocData.activationMode === 'MANIFEST_POINTER' ||
              manifestEntity.activationMode === 'MANIFEST_POINTER';
            if (
              memDocData.indexStatus === 'FAILED' ||
              memDocData.lifecycleStatus === 'DELETED' ||
              memDocData.lifecycleStatus === 'PENDING_DELETE'
            ) {
              throw new Error(
                `[FIRESTORE_DURABILITY_NOT_VERIFIED] Firestore 색인 문서(${memoryDocumentId})가 오류 또는 삭제 상태(${String(
                  memDocData.indexStatus || memDocData.lifecycleStatus
                )})이므로 SYNCED 전환이 차단되었습니다.`
              );
            }
            if (
              !isManifestPointerMode &&
              (memDocData.indexStatus !== 'INDEXED' ||
                memDocData.isActiveGeneration === false)
            ) {
              throw new Error(
                `[FIRESTORE_DURABILITY_NOT_VERIFIED] Firestore 색인 문서(${memoryDocumentId})가 활성(INDEXED) 상태가 아니어서 SYNCED 전환이 차단되었습니다.`
              );
            }
          }

          const syncedTask: RagSyncTaskRecord = {
            ...leasedTask,
            status: 'SYNCED',
            leaseOwner: '',
            leaseExpiresAtMs: 0,
            nextRetryAfterMs: 0,
            lastError: '',
            memoryDocumentId,
            updatedAt: nowIso,
          };
          tx.set(
            taskRef,
            serializeRagSyncTaskDocForFirestore(
              syncedTask,
              nowTimestamp,
              rawT.createdAt
            )
          );

          if (aSnap.exists) {
            const rawA = (aSnap.data() || {}) as Record<string, unknown>;
            const existingAudit = normalizeApprovalAuditFromDoc(
              rawA,
              leasedTask.auditId
            );
            const updatedAudit: ChangeProposalApprovalAudit = {
              ...existingAudit,
              ragSyncStatus: 'SYNCED',
              ragSyncError: '',
              updatedAt: nowIso,
            };
            tx.set(
              auditRef,
              serializeApprovalAuditDocForFirestore(
                updatedAudit,
                nowTimestamp,
                rawA.createdAt
              )
            );
          }

          return {
            committed: true as const,
            currentTask: syncedTask,
          };
        }
      );

      if (!syncCommitOutcome.committed) {
        skippedCount += 1;
        const ct = syncCommitOutcome.currentTask;
        results.push({
          taskId: leasedTask.id,
          proposalId: leasedTask.proposalId,
          auditId: leasedTask.auditId,
          targetEntityType: leasedTask.targetEntityType,
          targetEntityId: leasedTask.targetEntityId,
          ragSyncStatus:
            ct?.status === 'SYNCED'
              ? 'SYNCED'
              : ct?.status === 'SUPERSEDED'
              ? syncCommitOutcome.reason === 'SUPERSEDED_BY_NEWER_CANON'
                ? 'SUPERSEDED'
                : 'NOT_REQUIRED'
              : ct?.status === 'FAILED'
              ? 'FAILED'
              : 'PENDING',
          ragSyncError: ct?.lastError || '',
          memoryDocumentId: ct?.memoryDocumentId || '',
          leaseGeneration: leasedTask.leaseGeneration,
          skippedReason: syncCommitOutcome.reason,
        });
        continue;
      }

      syncedCount += 1;
      results.push({
        taskId: leasedTask.id,
        proposalId: leasedTask.proposalId,
        auditId: leasedTask.auditId,
        targetEntityType: leasedTask.targetEntityType,
        targetEntityId: leasedTask.targetEntityId,
        ragSyncStatus: 'SYNCED',
        ragSyncError: '',
        memoryDocumentId,
        leaseGeneration: leasedTask.leaseGeneration,
      });
    } catch (err) {
      const errMsg = (err instanceof Error ? err.message : String(err))
        .trim()
        .slice(0, 1000);

      const isSupersededByNewerCanon = errMsg.includes(
        '[SUPERSEDED_BY_NEWER_CANON]'
      );
      const isDeletedOrNotCanon =
        errMsg.includes('[ENTITY_NOT_FOUND]') ||
        errMsg.includes('[ENTITY_NOT_CANON]');
      const isSupersededErr = isSupersededByNewerCanon || isDeletedOrNotCanon;

      const backoffMs = Math.min(
        300_000,
        2_000 * Math.pow(2, Math.max(0, leasedTask.attemptCount - 1))
      );
      const nextRetryAfterMs = nowMs + backoffMs;

      const failCommitOutcome = await db.runTransaction(
        async (tx: Transaction) => {
          const tSnap = await txReadDocStrict(
            tx,
            taskRef,
            `ragSyncTasks/${taskId}`
          );
          const aSnap = await txReadDocStrict(
            tx,
            auditRef,
            `changeProposalApprovalAudits/${leasedTask.auditId}`
          );
          if (!tSnap.exists) {
            return {
              committed: false as const,
              reason: 'TASK_NOT_FOUND',
              currentTask: null,
            };
          }
          const rawT = (tSnap.data() || {}) as Record<string, unknown>;
          const currentTask = normalizeRagSyncTaskFromDoc(rawT, taskId);

          // Section 6.2 & Test B: Verify lease fencing BEFORE writing FAILED!
          // If Worker A's lease expired and Worker B already acquired a newer leaseGeneration (or succeeded),
          // Worker A's late failure MUST NOT overwrite Worker B's state!
          const fencing = verifyRagTaskLeaseFencing({
            currentTask,
            leasedTask,
          });
          if (!fencing.ok) {
            return {
              committed: false as const,
              reason: fencing.reason,
              currentTask,
            };
          }

          if (isSupersededErr) {
            const nextStatus: ApprovalRagSyncStatus = isSupersededByNewerCanon
              ? 'SUPERSEDED'
              : 'NOT_REQUIRED';
            const supersededTask: RagSyncTaskRecord = {
              ...leasedTask,
              status: 'SUPERSEDED',
              leaseOwner: '',
              leaseExpiresAtMs: 0,
              lastError: errMsg,
              updatedAt: nowIso,
            };
            tx.set(
              taskRef,
              serializeRagSyncTaskDocForFirestore(
                supersededTask,
                nowTimestamp,
                rawT.createdAt
              )
            );
            if (aSnap.exists) {
              const rawA = (aSnap.data() || {}) as Record<string, unknown>;
              const existingAudit = normalizeApprovalAuditFromDoc(
                rawA,
                leasedTask.auditId
              );
              const updatedAudit: ChangeProposalApprovalAudit = {
                ...existingAudit,
                ragSyncStatus: nextStatus,
                ragSyncError: errMsg,
                updatedAt: nowIso,
              };
              tx.set(
                auditRef,
                serializeApprovalAuditDocForFirestore(
                  updatedAudit,
                  nowTimestamp,
                  rawA.createdAt
                )
              );
            }
            return {
              committed: false as const,
              reason: isSupersededByNewerCanon
                ? 'SUPERSEDED_BY_NEWER_CANON'
                : 'ENTITY_OR_PROJECT_DELETED',
              currentTask: supersededTask,
            };
          }

          const failedTask: RagSyncTaskRecord = {
            ...leasedTask,
            status: 'FAILED',
            leaseOwner: '',
            leaseExpiresAtMs: 0,
            nextRetryAfterMs,
            lastError: errMsg,
            updatedAt: nowIso,
          };
          tx.set(
            taskRef,
            serializeRagSyncTaskDocForFirestore(
              failedTask,
              nowTimestamp,
              rawT.createdAt
            )
          );

          if (aSnap.exists) {
            const rawA = (aSnap.data() || {}) as Record<string, unknown>;
            const existingAudit = normalizeApprovalAuditFromDoc(
              rawA,
              leasedTask.auditId
            );
            const updatedAudit: ChangeProposalApprovalAudit = {
              ...existingAudit,
              ragSyncStatus: 'FAILED',
              ragSyncError: errMsg,
              updatedAt: nowIso,
            };
            tx.set(
              auditRef,
              serializeApprovalAuditDocForFirestore(
                updatedAudit,
                nowTimestamp,
                rawA.createdAt
              )
            );
          }

          return {
            committed: true as const,
            currentTask: failedTask,
          };
        }
      );

      if (!failCommitOutcome.committed) {
        skippedCount += 1;
        const ct = failCommitOutcome.currentTask;
        results.push({
          taskId: leasedTask.id,
          proposalId: leasedTask.proposalId,
          auditId: leasedTask.auditId,
          targetEntityType: leasedTask.targetEntityType,
          targetEntityId: leasedTask.targetEntityId,
          ragSyncStatus:
            ct?.status === 'SYNCED'
              ? 'SYNCED'
              : ct?.status === 'SUPERSEDED'
              ? failCommitOutcome.reason === 'SUPERSEDED_BY_NEWER_CANON'
                ? 'SUPERSEDED'
                : 'NOT_REQUIRED'
              : ct?.status === 'FAILED'
              ? 'FAILED'
              : 'PENDING',
          ragSyncError: ct?.lastError || errMsg,
          memoryDocumentId: ct?.memoryDocumentId || '',
          leaseGeneration: leasedTask.leaseGeneration,
          skippedReason: failCommitOutcome.reason,
        });
        continue;
      }

      failedCount += 1;
      results.push({
        taskId: leasedTask.id,
        proposalId: leasedTask.proposalId,
        auditId: leasedTask.auditId,
        targetEntityType: leasedTask.targetEntityType,
        targetEntityId: leasedTask.targetEntityId,
        ragSyncStatus: 'FAILED',
        ragSyncError: errMsg,
        memoryDocumentId: '',
        leaseGeneration: leasedTask.leaseGeneration,
        retryAfterMs: backoffMs,
      });
    }
  }

  const primaryResult = results[0];
  const primarySkippedReason = primaryResult?.skippedReason;
  const primaryRetryAfterMs = primaryResult?.retryAfterMs;

  const primaryRagStatus: ApprovalRagSyncStatus = primaryResult
    ? primaryResult.ragSyncStatus
    : failedCount > 0
    ? 'FAILED'
    : syncedCount > 0
    ? 'SYNCED'
    : 'NOT_REQUIRED';

  const primaryTaskStatus: RagSyncTaskStatus =
    primarySkippedReason === 'LEASE_ACTIVE' ||
    primaryRagStatus === 'PROCESSING'
      ? 'PROCESSING'
      : primaryRagStatus === 'SYNCED'
      ? 'SYNCED'
      : primaryRagStatus === 'FAILED'
      ? 'FAILED'
      : primaryRagStatus === 'SUPERSEDED' ||
        primaryRagStatus === 'NOT_REQUIRED'
      ? 'SUPERSEDED'
      : 'PENDING';

  const isOverallOk =
    failedCount === 0 &&
    primarySkippedReason !== 'BACKOFF_WAITING' &&
    primarySkippedReason !== 'MAX_ATTEMPTS_EXCEEDED' &&
    primarySkippedReason !== 'LEASE_ACTIVE' &&
    primarySkippedReason !== 'LEASE_LOST' &&
    primarySkippedReason !== 'STALE_WORKER_RESULT' &&
    primarySkippedReason !== 'SUPERSEDED_BY_NEWER_CANON';

  return {
    success: true,
    ok: isOverallOk,
    ragSyncStatus: primaryRagStatus,
    taskStatus: primaryTaskStatus,
    documentId: primaryResult?.memoryDocumentId || '',
    skippedReason: primarySkippedReason,
    retryAfterMs: primaryRetryAfterMs,
    leaseGeneration: primaryResult?.leaseGeneration,
    executionMode,
    isCloudVerified: executionMode === 'CLOUD_AUTHENTICATED',
    projectId,
    processedCount,
    syncedCount,
    failedCount,
    skippedCount,
    results,
    completedAt: nowIso,
  };
}

/**
 * Phase 4.2.2 Stage 2.5B Section 11:
 * P1 Operational Integrity Diagnostics & Safe Recovery for Approval -> CANON -> RAG Outbox -> Firestore Index.
 *
 * Detects States A through F:
 * - State A (`CANON_WITHOUT_SYNCED_TASK`): CANON entity exists, but its RagSyncTask is PENDING or FAILED (or missing).
 * - State B (`SYNCED_TASK_MISSING_MEMORY_DOCUMENT`): RagSyncTask is SYNCED, but Firestore MemoryDocument is missing or inactive.
 * - State C (`MANIFEST_GENERATION_MISMATCH`): ragManifest/control active generation or revision/hash mismatches the active MemoryDocument or CANON entity.
 * - State D (`EXPIRED_PROCESSING_LEASE`): RagSyncTask is stuck in PROCESSING with an expired lease.
 * - State E (`SUPERSEDED_TASK_NEEDS_LATEST_SYNC`): An older RagSyncTask is SUPERSEDED, while the latest CANON entity version is not yet SYNCED.
 * - State F (`UNAPPROVED_PROPOSAL_CANON_VIOLATION`): A ChangeProposal has canonStatus === 'CANON', but has no valid APPROVED audit record.
 *
 * When `autoRecover: true`, safely re-queues recoverable RAG sync tasks to `PENDING` (and optionally runs RAG sync if `executeSyncOnRecover: true`)
 * without ever mutating CANON entities or forging approval audits.
 */
export async function diagnoseAndRecoverProjectRagIntegrityOnServer(
  request: {
    projectId: string;
    autoRecover?: boolean;
    executeSyncOnRecover?: boolean;
    workerId?: string;
  },
  options?: ApprovalEngineOptions & {
    ragIndexingOptions?: RagIndexingOptions;
    leaseDurationMs?: number;
    workerId?: string;
  }
): Promise<RagIntegrityDiagnosticReport> {
  const ownerId = options?.verifiedOwnerId?.trim() || '';
  if (!ownerId) {
    throw new Error(
      '[AUTH_REQUIRED] RAG 정합성 점검을 위해서는 검증된 작가 인증(ownerId)이 필요합니다.'
    );
  }
  const projectId = request.projectId?.trim() || '';
  if (!projectId) {
    throw new Error('[BAD_REQUEST] projectId가 필요합니다.');
  }

  const db = resolveExtractionFirestoreInstance(options);
  const nowIso = options?.nowIso || new Date().toISOString();
  const nowDate = new Date(nowIso);
  const nowMs = Number.isNaN(nowDate.getTime())
    ? Date.now()
    : nowDate.getTime();
  const nowTimestamp = Timestamp.fromDate(
    Number.isNaN(nowDate.getTime()) ? new Date() : nowDate
  );

  const basePath = `users/${ownerId}/projects/${projectId}`;
  const projectSnap = await db.doc(basePath).get();
  if (!projectSnap.exists) {
    throw new Error(`[NOT_FOUND] 프로젝트(${projectId})를 찾을 수 없습니다.`);
  }
  const projectData = (projectSnap.data() || {}) as Record<string, unknown>;
  if (projectData.ownerId && projectData.ownerId !== ownerId) {
    throw new Error(
      '[TENANT_ISOLATION_VIOLATION] 프로젝트 소유자가 일치하지 않습니다.'
    );
  }

  const [
    relsSnap,
    evtsSnap,
    fshSnap,
    proposalsSnap,
    auditsSnap,
    tasksSnap,
    memDocsSnap,
    manifestSnap,
    stagingSnap,
  ] = await Promise.all([
    db.collection(`${basePath}/relationships`).get(),
    db.collection(`${basePath}/timelineEvents`).get(),
    db.collection(`${basePath}/foreshadowings`).get(),
    db.collection(`${basePath}/changeProposals`).get(),
    db.collection(`${basePath}/changeProposalApprovalAudits`).get(),
    db.collection(`${basePath}/ragSyncTasks`).get(),
    db.collection(`${basePath}/memoryDocuments`).get(),
    db.doc(`${basePath}/ragManifest/control`).get(),
    db.collection(`${basePath}/ragGenerationStaging`).get(),
  ]);

  const canonEntities = new Map<
    string,
    { type: ApprovalTargetEntityType; entity: AppliedCanonEntity }
  >();
  for (const d of relsSnap.docs) {
    const ent = normalizeCharacterRelationshipFromDoc(
      (d.data() || {}) as Record<string, unknown>,
      d.id
    );
    if (ent.canonStatus === 'CANON') {
      canonEntities.set(`RELATIONSHIP::${ent.id}`, {
        type: 'RELATIONSHIP',
        entity: ent,
      });
    }
  }
  for (const d of evtsSnap.docs) {
    const ent = normalizeTimelineEventFromDoc(
      (d.data() || {}) as Record<string, unknown>,
      d.id
    );
    if (ent.canonStatus === 'CANON') {
      canonEntities.set(`TIMELINE_EVENT::${ent.id}`, {
        type: 'TIMELINE_EVENT',
        entity: ent,
      });
    }
  }
  for (const d of fshSnap.docs) {
    const ent = normalizeForeshadowingFromDoc(
      (d.data() || {}) as Record<string, unknown>,
      d.id
    );
    if (ent.canonStatus === 'CANON') {
      canonEntities.set(`FORESHADOWING::${ent.id}`, {
        type: 'FORESHADOWING',
        entity: ent,
      });
    }
  }

  const auditsById = new Map<string, ChangeProposalApprovalAudit>();
  const approvedAuditsByProposalId = new Map<
    string,
    ChangeProposalApprovalAudit
  >();
  for (const d of auditsSnap.docs) {
    const audit = normalizeApprovalAuditFromDoc(
      (d.data() || {}) as Record<string, unknown>,
      d.id
    );
    auditsById.set(audit.id, audit);
    if (audit.decision === 'APPROVED') {
      approvedAuditsByProposalId.set(audit.proposalId, audit);
    }
  }

  const tasksById = new Map<string, RagSyncTaskRecord>();
  const tasksByEntityKey = new Map<string, RagSyncTaskRecord[]>();
  for (const d of tasksSnap.docs) {
    const task = normalizeRagSyncTaskFromDoc(
      (d.data() || {}) as Record<string, unknown>,
      d.id
    );
    tasksById.set(task.id, task);
    const eKey = `${task.targetEntityType}::${task.targetEntityId}`;
    const list = tasksByEntityKey.get(eKey) || [];
    list.push(task);
    tasksByEntityKey.set(eKey, list);
  }

  const memDocsById = new Map<string, Record<string, unknown>>();
  for (const d of memDocsSnap.docs) {
    memDocsById.set(d.id, (d.data() || {}) as Record<string, unknown>);
  }

  const manifestData = manifestSnap.exists
    ? ((manifestSnap.data() || {}) as Record<string, unknown>)
    : {};
  const manifestEntityStates =
    (manifestData.entityStates as Record<string, EntityIndexLifecycleState>) ||
    {};

  const activeDocIdSet = new Set<string>();
  const activeGenByManifestKey = new Map<string, number>();
  for (const [mKey, st] of Object.entries(manifestEntityStates)) {
    if (st && st.lifecycleStatus === 'ACTIVE' && st.activeGeneration > 0) {
      activeGenByManifestKey.set(mKey, st.activeGeneration);
      for (const docId of st.activeDocumentIds || []) {
        activeDocIdSet.add(docId);
      }
    }
  }

  const anomalies: RagIntegrityDiagnosticItem[] = [];
  const taskIdsToRequeue = new Set<string>();
  let hasStaleOrInactiveStagingToCleanup = false;

  // State F: Proposal has canonStatus === 'CANON', but no valid APPROVED audit record
  for (const d of proposalsSnap.docs) {
    const prop = normalizeChangeProposalFromFirestore(
      (d.data() || {}) as Record<string, unknown>,
      d.id
    );
    if (prop.canonStatus === 'CANON') {
      const approvedAudit = approvedAuditsByProposalId.get(prop.id);
      if (!approvedAudit) {
        anomalies.push({
          code: 'UNAPPROVED_PROPOSAL_CANON_VIOLATION',
          proposalId: prop.id,
          targetEntityType: prop.targetEntityType as ApprovalTargetEntityType,
          targetEntityId: prop.targetEntityId,
          message: `제안서(${prop.id})가 CANON 상태이나 유효한 APPROVED 감사 이력이 존재하지 않습니다.`,
          recoverable: false,
          recovered: false,
        });
      }
    }
  }

  // Check tasks for State B & State D
  for (const task of tasksById.values()) {
    const manifestKey = `${ownerId}:${projectId}:${task.targetEntityType}:${task.targetEntityId}`;
    const manifestEntity = manifestEntityStates[manifestKey];
    const expectedMemDocId =
      task.memoryDocumentId ||
      (manifestEntity?.activeDocumentIds &&
        manifestEntity.activeDocumentIds[0]) ||
      `memdoc_${projectId}_${task.targetEntityType}_${task.targetEntityId}`.replace(
        /[^a-zA-Z0-9_-]/g,
        '_'
      );

    if (task.status === 'SYNCED') {
      const memDoc = memDocsById.get(expectedMemDocId);
      const isPointerMode =
        memDoc?.activationMode === 'MANIFEST_POINTER' ||
        manifestEntity?.activationMode === 'MANIFEST_POINTER';
      const activeDocIds =
        manifestEntity?.activeDocumentIds &&
        manifestEntity.activeDocumentIds.length > 0
          ? manifestEntity.activeDocumentIds
          : [expectedMemDocId];
      const pointerValid =
        Boolean(memDoc) &&
        Boolean(manifestEntity) &&
        manifestEntity?.lifecycleStatus === 'ACTIVE' &&
        activeDocIds.includes(expectedMemDocId) &&
        manifestEntity?.activeGeneration === memDoc?.indexGeneration &&
        activeDocIds.every((id) => {
          const partDoc = memDocsById.get(id);
          return (
            Boolean(partDoc) &&
            partDoc?.indexStatus !== 'FAILED' &&
            partDoc?.lifecycleStatus !== 'DELETED'
          );
        });
      const inlineValid =
        Boolean(memDoc) &&
        memDoc?.indexStatus === 'INDEXED' &&
        memDoc?.isActiveGeneration !== false;

      if (isPointerMode ? !pointerValid : !inlineValid) {
        anomalies.push({
          code: 'SYNCED_TASK_MISSING_MEMORY_DOCUMENT',
          taskId: task.id,
          proposalId: task.proposalId,
          auditId: task.auditId,
          targetEntityType: task.targetEntityType,
          targetEntityId: task.targetEntityId,
          message: `RagSyncTask(${task.id})는 SYNCED 상태이나 활성 MemoryDocument(${expectedMemDocId})가 Firestore에 존재하지 않습니다.`,
          recoverable: true,
          recovered: false,
        });
        taskIdsToRequeue.add(task.id);
      }
    }

    if (
      task.status === 'PROCESSING' &&
      task.leaseExpiresAtMs > 0 &&
      task.leaseExpiresAtMs <= nowMs
    ) {
      anomalies.push({
        code: 'EXPIRED_PROCESSING_LEASE',
        taskId: task.id,
        proposalId: task.proposalId,
        auditId: task.auditId,
        targetEntityType: task.targetEntityType,
        targetEntityId: task.targetEntityId,
        message: `RagSyncTask(${task.id})가 PROCESSING 상태에서 lease(${task.leaseOwner}, gen=${task.leaseGeneration})가 만료되었습니다.`,
        recoverable: true,
        recovered: false,
      });
      taskIdsToRequeue.add(task.id);
    }
  }

  // Check CANON entities for State A, State C, State E
  for (const [eKey, { type, entity }] of canonEntities.entries()) {
    const entityTasks = tasksByEntityKey.get(eKey) || [];
    const currentHash = computeEntityCanonicalContentHash(entity);
    const matchingTask = entityTasks.find(
      (t) =>
        t.expectedContentHash === currentHash &&
        t.expectedSourceRevisionId === entity.sourceRevisionId
    );
    const anySyncedTask = entityTasks.find((t) => t.status === 'SYNCED');
    const anySupersededTask = entityTasks.find(
      (t) => t.status === 'SUPERSEDED'
    );

    const manifestKey = `${ownerId}:${projectId}:${type}:${entity.id}`;
    const manifestEntity = manifestEntityStates[manifestKey];
    const legacyMemDocId = `memdoc_${projectId}_${type}_${entity.id}`.replace(
      /[^a-zA-Z0-9_-]/g,
      '_'
    );
    const activeCandidateDocIds =
      manifestEntity?.activeDocumentIds &&
      manifestEntity.activeDocumentIds.length > 0
        ? manifestEntity.activeDocumentIds
        : anySyncedTask?.memoryDocumentId
        ? [anySyncedTask.memoryDocumentId]
        : [legacyMemDocId];
    const primaryMemDocId = activeCandidateDocIds[0] || legacyMemDocId;
    const memDoc = memDocsById.get(primaryMemDocId);
    const allActiveDocsExist =
      activeCandidateDocIds.length > 0 &&
      activeCandidateDocIds.every((id) => memDocsById.has(id));
    const isPointerMode =
      manifestEntity?.activationMode === 'MANIFEST_POINTER' ||
      memDoc?.activationMode === 'MANIFEST_POINTER';

    // State A: CANON entity exists, matching task is PENDING or FAILED (or no SYNCED task for it)
    if (
      matchingTask &&
      (matchingTask.status === 'PENDING' || matchingTask.status === 'FAILED')
    ) {
      anomalies.push({
        code: 'CANON_WITHOUT_SYNCED_TASK',
        taskId: matchingTask.id,
        proposalId: matchingTask.proposalId,
        auditId: matchingTask.auditId,
        targetEntityType: type,
        targetEntityId: entity.id,
        message: `CANON 엔티티(${type}/${entity.id})의 RagSyncTask(${matchingTask.id})가 아직 ${matchingTask.status} 상태입니다.`,
        recoverable: true,
        recovered: false,
      });
      taskIdsToRequeue.add(matchingTask.id);
    }

    // State E: A task for this entity is SUPERSEDED, and the latest CANON entity is not yet SYNCED
    const isLatestCanonIndexed =
      allActiveDocsExist &&
      Boolean(memDoc) &&
      memDoc?.sourceRevisionId === entity.sourceRevisionId &&
      memDoc?.indexStatus !== 'FAILED' &&
      (isPointerMode
        ? manifestEntity?.lifecycleStatus === 'ACTIVE' &&
          manifestEntity?.activeGeneration === memDoc?.indexGeneration
        : memDoc?.indexStatus === 'INDEXED' &&
          memDoc?.isActiveGeneration !== false);

    if (
      anySupersededTask &&
      (!isLatestCanonIndexed ||
        (matchingTask && matchingTask.status !== 'SYNCED'))
    ) {
      const targetTaskToRecover = matchingTask || anySupersededTask;
      anomalies.push({
        code: 'SUPERSEDED_TASK_NEEDS_LATEST_SYNC',
        taskId: targetTaskToRecover.id,
        proposalId: targetTaskToRecover.proposalId,
        auditId: targetTaskToRecover.auditId,
        targetEntityType: type,
        targetEntityId: entity.id,
        message: `이전 RagSyncTask(${anySupersededTask.id})가 SUPERSEDED 처리되었으며 최신 CANON 엔티티(${type}/${entity.id}, rev=${entity.sourceRevisionId})의 동기화가 필요합니다.`,
        recoverable: Boolean(matchingTask),
        recovered: false,
      });
      if (matchingTask) {
        taskIdsToRequeue.add(matchingTask.id);
      }
    }

    // State C: Manifest active generation mismatch vs MemoryDocument or CANON entity
    if (
      memDoc &&
      (memDoc.indexStatus === 'INDEXED' ||
        (isPointerMode && manifestEntity?.lifecycleStatus === 'ACTIVE'))
    ) {
      const docGen = Number(memDoc.indexGeneration || 0);
      const manifestGen = Number(manifestEntity?.activeGeneration || 0);
      const manifestActiveDocs = Array.isArray(
        manifestEntity?.activeDocumentIds
      )
        ? manifestEntity.activeDocumentIds
        : [];
      const anyPartGenMismatch = activeCandidateDocIds.some((id) => {
        const partDoc = memDocsById.get(id);
        return !partDoc || Number(partDoc.indexGeneration || 0) !== manifestGen;
      });
      const hasGenerationMismatch =
        !manifestEntity ||
        manifestEntity.lifecycleStatus !== 'ACTIVE' ||
        manifestGen !== docGen ||
        anyPartGenMismatch ||
        !manifestActiveDocs.includes(primaryMemDocId) ||
        memDoc.sourceRevisionId !== entity.sourceRevisionId;

      if (hasGenerationMismatch) {
        const candidateTask =
          matchingTask || anySyncedTask || entityTasks[0];
        anomalies.push({
          code: 'MANIFEST_GENERATION_MISMATCH',
          taskId: candidateTask?.id,
          proposalId: candidateTask?.proposalId,
          auditId: candidateTask?.auditId,
          targetEntityType: type,
          targetEntityId: entity.id,
          message: `ragManifest/control 세대(gen=${manifestGen})와 MemoryDocument(${primaryMemDocId}, gen=${docGen}, rev=${String(
            memDoc.sourceRevisionId
          )}) 또는 CANON(rev=${entity.sourceRevisionId})이 일치하지 않습니다.`,
          recoverable: Boolean(candidateTask),
          recovered: false,
        });
        if (candidateTask) {
          taskIdsToRequeue.add(candidateTask.id);
        }
      }
    }
  }

  // Check for orphaned/aborted staging receipts or older inactive generation documents
  const staleThresholdMs = 15 * 60_000;
  const liveLeaseGenByEntityKey = new Map<string, number>();
  for (const task of tasksById.values()) {
    if (
      task.status === 'PROCESSING' &&
      task.leaseExpiresAtMs > 0 &&
      task.leaseExpiresAtMs > nowMs
    ) {
      const mKey = `${ownerId}:${projectId}:${task.targetEntityType}:${task.targetEntityId}`;
      liveLeaseGenByEntityKey.set(
        mKey,
        Math.max(liveLeaseGenByEntityKey.get(mKey) || 0, task.leaseGeneration || 0)
      );
    }
  }

  const receiptsById = new Map<string, RagGenerationStagingReceipt>();
  const staleStagingByEntity = new Map<
    string,
    {
      type?: ApprovalTargetEntityType;
      id?: string;
      receiptIds: string[];
      docIds: string[];
    }
  >();

  for (const sDoc of stagingSnap.docs) {
    const receipt = (sDoc.data() || {}) as RagGenerationStagingReceipt;
    receiptsById.set(receipt.id || sDoc.id, receipt);
    if (receipt.status === 'CLEANUP_COMPLETED') {
      continue;
    }
    const mKey =
      receipt.entityKey ||
      `${ownerId}:${projectId}:${receipt.sourceEntityType}:${receipt.sourceEntityId}`;
    const activeGen = activeGenByManifestKey.get(mKey) || 0;
    if (activeGen > 0 && receipt.generation === activeGen) {
      continue;
    }

    const liveLeaseGen = liveLeaseGenByEntityKey.get(mKey) || 0;
    const isSupersededLease =
      liveLeaseGen > 0 &&
      typeof receipt.targetLeaseGeneration === 'number' &&
      receipt.targetLeaseGeneration < liveLeaseGen;
    const protectedByLiveLease =
      liveLeaseGen > 0 &&
      !isSupersededLease &&
      receipt.status !== 'ABORTED' &&
      receipt.status !== 'CLEANUP_PENDING' &&
      !(activeGen > 0 && receipt.generation < activeGen);
    if (protectedByLiveLease) {
      continue;
    }

    const updatedMs = new Date(
      receipt.updatedAt || receipt.createdAt || 0
    ).getTime();
    const ageMs = Number.isFinite(updatedMs)
      ? Math.max(0, nowMs - updatedMs)
      : staleThresholdMs;
    const isCleanupCandidate =
      (activeGen > 0 && receipt.generation < activeGen) ||
      receipt.status === 'ABORTED' ||
      receipt.status === 'CLEANUP_PENDING' ||
      isSupersededLease ||
      ((receipt.status === 'PREPARING' ||
        receipt.status === 'STAGED' ||
        receipt.status === 'VERIFIED') &&
        ageMs >= staleThresholdMs);

    if (isCleanupCandidate) {
      const entityBucketKey = `${receipt.sourceEntityType || 'UNKNOWN'}::${
        receipt.sourceEntityId || 'UNKNOWN'
      }`;
      const existing = staleStagingByEntity.get(entityBucketKey) || {
        type: receipt.sourceEntityType as ApprovalTargetEntityType,
        id: receipt.sourceEntityId,
        receiptIds: [],
        docIds: [],
      };
      existing.receiptIds.push(receipt.id || sDoc.id);
      staleStagingByEntity.set(entityBucketKey, existing);
    }
  }

  for (const [docId, rawDoc] of memDocsById.entries()) {
    const isStagedSuffix = docId.endsWith('__staged');
    if (activeDocIdSet.has(docId) && !isStagedSuffix) continue;
    const eType = String(rawDoc.sourceEntityType || '');
    const eId = String(rawDoc.sourceEntityId || '');
    const mKey = `${ownerId}:${projectId}:${eType}:${eId}`;
    const activeGen = activeGenByManifestKey.get(mKey) || 0;
    const docGen = Number(rawDoc.indexGeneration || 0);
    if (activeGen > 0 && docGen === activeGen && !isStagedSuffix) continue;
    if (
      isStagedSuffix &&
      activeGen > 0 &&
      docGen === activeGen &&
      rawDoc.isActiveGeneration !== false
    ) {
      continue;
    }

    const stagingId =
      typeof rawDoc.stagingId === 'string' ? rawDoc.stagingId : '';
    const receipt = stagingId ? receiptsById.get(stagingId) : undefined;
    const liveLeaseGen = liveLeaseGenByEntityKey.get(mKey) || 0;
    const hasLiveLease = liveLeaseGen > 0;
    const isSupersededReceipt =
      Boolean(receipt) &&
      hasLiveLease &&
      typeof receipt!.targetLeaseGeneration === 'number' &&
      receipt!.targetLeaseGeneration < liveLeaseGen;

    const extractIso = (val: unknown): string => {
      if (typeof val === 'string' && val.length > 0) return val;
      if (
        val &&
        typeof val === 'object' &&
        typeof (val as { toDate?: () => Date }).toDate === 'function'
      ) {
        try {
          return (val as { toDate: () => Date }).toDate().toISOString();
        } catch {
          return '';
        }
      }
      return '';
    };
    const updatedIso =
      extractIso(rawDoc.updatedAt) ||
      extractIso(rawDoc.indexedAt) ||
      extractIso(rawDoc.createdAt);
    const updatedMs = updatedIso ? new Date(updatedIso).getTime() : NaN;
    const docAgeMs = Number.isFinite(updatedMs)
      ? Math.max(0, nowMs - updatedMs)
      : 0;

    const isOlderInactive = activeGen > 0 && docGen > 0 && docGen < activeGen;
    const isAbortedDoc =
      receipt?.status === 'ABORTED' ||
      receipt?.status === 'CLEANUP_PENDING' ||
      isSupersededReceipt;
    const isSafeStaleStagedDoc =
      isStagedSuffix &&
      !hasLiveLease &&
      activeGen > 0 &&
      (isOlderInactive ||
        (docAgeMs >= staleThresholdMs && rawDoc.isActiveGeneration === false));

    if (isOlderInactive || isAbortedDoc || isSafeStaleStagedDoc) {
      const entityBucketKey = `${eType || 'UNKNOWN'}::${eId || 'UNKNOWN'}`;
      const existing = staleStagingByEntity.get(entityBucketKey) || {
        type: (eType || undefined) as ApprovalTargetEntityType | undefined,
        id: eId || undefined,
        receiptIds: [],
        docIds: [],
      };
      existing.docIds.push(docId);
      staleStagingByEntity.set(entityBucketKey, existing);
    }
  }

  for (const bucket of staleStagingByEntity.values()) {
    hasStaleOrInactiveStagingToCleanup = true;
    anomalies.push({
      code: 'STATE_F_INACTIVE_STAGED_DOCUMENTS_REMAINING',
      targetEntityType: bucket.type,
      targetEntityId: bucket.id,
      message: `비활성·중단(ABORTED) 또는 이전 세대 스테이징 잔여 데이터(receipts=${bucket.receiptIds.length}, docs=${bucket.docIds.length})가 정리 대기 중입니다.`,
      recoverable: true,
      recovered: false,
    });
  }

  let recoveredCount = 0;
  if (request.autoRecover && taskIdsToRequeue.size > 0) {
    for (const taskId of taskIdsToRequeue) {
      const task = tasksById.get(taskId);
      if (!task) continue;
      const eKey = `${task.targetEntityType}::${task.targetEntityId}`;
      const currentCanon = canonEntities.get(eKey)?.entity;
      if (!currentCanon) continue;

      const taskRef = db.doc(`${basePath}/ragSyncTasks/${taskId}`);
      const auditRef = db.doc(
        `${basePath}/changeProposalApprovalAudits/${task.auditId}`
      );

      await db.runTransaction(async (tx: Transaction) => {
        const tSnap = await txReadDocStrict(
          tx,
          taskRef,
          `ragSyncTasks/${taskId}`
        );
        const aSnap = await txReadDocStrict(
          tx,
          auditRef,
          `changeProposalApprovalAudits/${task.auditId}`
        );
        if (!tSnap.exists) return;
        const rawT = (tSnap.data() || {}) as Record<string, unknown>;
        const latestT = normalizeRagSyncTaskFromDoc(rawT, taskId);

        const requeuedTask: RagSyncTaskRecord = {
          ...latestT,
          expectedSourceRevisionId: currentCanon.sourceRevisionId,
          expectedEntityUpdatedAt: currentCanon.updatedAt,
          expectedContentHash: computeEntityCanonicalContentHash(currentCanon),
          status: 'PENDING',
          leaseOwner: '',
          leaseExpiresAtMs: 0,
          nextRetryAfterMs: 0,
          updatedAt: nowIso,
        };
        tx.set(
          taskRef,
          serializeRagSyncTaskDocForFirestore(
            requeuedTask,
            nowTimestamp,
            rawT.createdAt
          )
        );

        if (aSnap.exists) {
          const rawA = (aSnap.data() || {}) as Record<string, unknown>;
          const existingAudit = normalizeApprovalAuditFromDoc(
            rawA,
            task.auditId
          );
          tx.set(
            auditRef,
            serializeApprovalAuditDocForFirestore(
              {
                ...existingAudit,
                ragSyncStatus: 'PENDING',
                updatedAt: nowIso,
              },
              nowTimestamp,
              rawA.createdAt
            )
          );
        }
      });

      if (request.executeSyncOnRecover) {
        await executeRagSyncForApprovedProposalOnServer(
          {
            projectId,
            taskId,
            forceRetry: true,
            workerId: request.workerId || `diag_recovery_${ownerId}`,
          },
          options
        );
      }

      recoveredCount += 1;
      for (const item of anomalies) {
        if (item.taskId === taskId && item.recoverable) {
          item.recovered = true;
        }
      }
    }
  }

  if (request.autoRecover && hasStaleOrInactiveStagingToCleanup) {
    const cleanupResult = await cleanupInactiveRagGenerationsOnServer(
      {
        ownerId,
        projectId,
        nowMs,
      },
      {
        db: options?.db,
        cacheNamespace: options?.ragIndexingOptions?.cacheNamespace,
      }
    );
    if (
      cleanupResult.deletedDocs > 0 ||
      cleanupResult.deletedChunks > 0 ||
      cleanupResult.deletedStagingReceipts > 0
    ) {
      recoveredCount += 1;
      for (const item of anomalies) {
        if (item.code === 'STATE_F_INACTIVE_STAGED_DOCUMENTS_REMAINING') {
          item.recovered = true;
        }
      }
    }
  }

  return {
    projectId,
    ownerId,
    checkedAt: nowIso,
    healthy: anomalies.length === 0,
    anomalies,
    recoveredCount,
  };
}
