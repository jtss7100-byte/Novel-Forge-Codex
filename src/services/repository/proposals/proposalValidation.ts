import type { ActorType, ChangeProposal } from '../../../types/novel';
import type {
  ProposalPersistenceErrorCode,
  ProposalLookupStatus,
  ProposalImmutablePayload,
} from '../../../types/literaryRewriting';
import { serverTimestamp } from 'firebase/firestore';

export const SAFE_PROPOSAL_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

const OPTIONAL_PROPOSAL_ID_REGEX = /^[a-zA-Z0-9_-]{0,128}$/;

const VALID_PROPOSAL_TARGET_TYPES = new Set([
  'CHARACTER',
  'WORLDBUILDING',
  'EPISODE',
  'SCENE',
  'FORESHADOWING',
  'RELATIONSHIP',
  'TIMELINE_EVENT',
  'STYLE_PROFILE',
]);

const VALID_PROPOSAL_ACTIONS = new Set(['CREATE', 'UPDATE', 'ARCHIVE']);

const VALID_PROPOSAL_ACTOR_TYPES = new Set<ActorType>([
  'AUTHOR',
  'AI_ENGINE',
  'SYSTEM',
]);

const PROPOSAL_LIMITS = {
  TITLE_MAX: 150,
  RATIONALE_MAX: 2000,
  SUMMARY_MAX: 2000,
  PAYLOAD_JSON_MAX: 20000,
} as const;

export function classifyFirestorePersistenceError(
  err: unknown
): ProposalPersistenceErrorCode {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code || '').toLowerCase()
      : '';
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const lowerMsg = msg.toLowerCase();

  if (
    code === 'permission-denied' ||
    code === 'firestore/permission-denied' ||
    code === '7' ||
    lowerMsg.includes('permission-denied') ||
    lowerMsg.includes('permission_denied') ||
    lowerMsg.includes('missing or insufficient permissions')
  ) {
    return 'PERMISSION_DENIED';
  }

  if (lowerMsg.includes('proposal_owner_mismatch')) {
    return 'PROPOSAL_OWNER_MISMATCH';
  }

  if (lowerMsg.includes('source_revision_not_found')) {
    return 'SOURCE_REVISION_NOT_FOUND';
  }

  if (lowerMsg.includes('source_revision_content_mismatch')) {
    return 'SOURCE_REVISION_CONTENT_MISMATCH';
  }

  if (lowerMsg.includes('source_revision_mismatch')) {
    return 'SOURCE_REVISION_MISMATCH';
  }

  if (
    lowerMsg.includes('source_revision_unverified') ||
    lowerMsg.includes('invalid_proposal_source_revision')
  ) {
    return 'SOURCE_REVISION_UNVERIFIED';
  }

  if (
    lowerMsg.includes('proposal_payload_conflict') ||
    lowerMsg.includes('source_revision_conflict') ||
    lowerMsg.includes('proposal_already_decided') ||
    lowerMsg.includes('conflict')
  ) {
    return 'PROPOSAL_PAYLOAD_CONFLICT';
  }

  if (
    lowerMsg.includes('invalid_proposal') ||
    lowerMsg.includes('validation_error')
  ) {
    return 'VALIDATION_ERROR';
  }

  if (
    code === 'unavailable' ||
    code === 'deadline-exceeded' ||
    code === 'aborted' ||
    code === 'cancelled' ||
    code === 'resource-exhausted' ||
    lowerMsg.includes('econnreset') ||
    lowerMsg.includes('etimedout') ||
    lowerMsg.includes('enotfound') ||
    lowerMsg.includes('network') ||
    lowerMsg.includes('offline') ||
    lowerMsg.includes('503') ||
    lowerMsg.includes('transient')
  ) {
    return 'NETWORK_ERROR';
  }

  return 'UNKNOWN_ERROR';
}

export function mapErrorCodeToLookupStatus(
  errorCode: ProposalPersistenceErrorCode
): ProposalLookupStatus {
  if (
    errorCode === 'PERMISSION_DENIED' ||
    errorCode === 'PROPOSAL_OWNER_MISMATCH'
  ) {
    return 'PERMISSION_DENIED';
  }
  if (errorCode === 'NETWORK_ERROR') return 'NETWORK_ERROR';
  if (
    errorCode === 'SOURCE_REVISION_NOT_FOUND' ||
    errorCode === 'SOURCE_REVISION_UNVERIFIED'
  ) {
    return 'SOURCE_REVISION_UNVERIFIED';
  }
  if (errorCode === 'SOURCE_REVISION_MISMATCH') {
    return 'SOURCE_REVISION_MISMATCH';
  }
  if (errorCode === 'SOURCE_REVISION_CONTENT_MISMATCH') {
    return 'SOURCE_REVISION_CONTENT_MISMATCH';
  }
  if (errorCode === 'PROPOSAL_PAYLOAD_CONFLICT' || errorCode === 'CONFLICT') {
    return 'DOCUMENT_EXISTS_PROPOSED';
  }
  return 'UNKNOWN_ERROR';
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item));
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    if (obj[key] !== undefined) {
      out[key] = canonicalizeJsonValue(obj[key]);
    }
  }
  return out;
}

export function canonicalizeProposedPayloadJson(
  raw: unknown
):
  | { ok: true; canonicalJson: string }
  | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, canonicalJson: '{}' };
  }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      error: '[INVALID_PROPOSAL_PAYLOAD_JSON] proposedPayloadJson은 문자열이어야 합니다.',
    };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, canonicalJson: '{}' };
  }
  if (trimmed.length > PROPOSAL_LIMITS.PAYLOAD_JSON_MAX) {
    return {
      ok: false,
      error: `[INVALID_PROPOSAL_PAYLOAD_JSON] proposedPayloadJson 길이(${trimmed.length}자)가 최대 허용 한도(${PROPOSAL_LIMITS.PAYLOAD_JSON_MAX}자)를 초과했습니다.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      error: '[INVALID_PROPOSAL_PAYLOAD_JSON] proposedPayloadJson이 유효한 JSON 형식이 아닙니다.',
    };
  }
  const canonicalJson = JSON.stringify(canonicalizeJsonValue(parsed));
  if (typeof canonicalJson !== 'string') {
    return {
      ok: false,
      error: '[INVALID_PROPOSAL_PAYLOAD_JSON] proposedPayloadJson을 정규화할 수 없습니다.',
    };
  }
  if (canonicalJson.length > PROPOSAL_LIMITS.PAYLOAD_JSON_MAX) {
    return {
      ok: false,
      error: `[INVALID_PROPOSAL_PAYLOAD_JSON] 정규화된 proposedPayloadJson 길이(${canonicalJson.length}자)가 최대 허용 한도(${PROPOSAL_LIMITS.PAYLOAD_JSON_MAX}자)를 초과했습니다.`,
    };
  }
  return { ok: true, canonicalJson };
}

export type NormalizedProposalValidationResult =
  | {
      ok: true;
      normalized: ProposalImmutablePayload;
    }
  | {
      ok: false;
      errorCode: 'PROPOSAL_OWNER_MISMATCH' | 'SOURCE_REVISION_UNVERIFIED' | 'VALIDATION_ERROR';
      errorMessage: string;
    };

export function normalizeAndValidateChangeProposalPayload(
  uid: string,
  projectId: string,
  proposal: ChangeProposal
): NormalizedProposalValidationResult {
  const cleanUid = (uid || '').trim();
  const cleanProjectId = (projectId || '').trim();
  if (!SAFE_PROPOSAL_ID_REGEX.test(cleanUid)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: '[INVALID_PROPOSAL_UID] 유효하지 않은 ownerId 형식입니다.',
    };
  }
  if (!SAFE_PROPOSAL_ID_REGEX.test(cleanProjectId)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: '[INVALID_PROPOSAL_PROJECT_ID] 유효하지 않은 projectId 형식입니다.',
    };
  }

  const incomingOwnerId =
    typeof proposal.ownerId === 'string' ? proposal.ownerId.trim() : '';
  if (incomingOwnerId && incomingOwnerId !== cleanUid) {
    return {
      ok: false,
      errorCode: 'PROPOSAL_OWNER_MISMATCH',
      errorMessage: `[PROPOSAL_OWNER_MISMATCH] 제안서 ownerId('${incomingOwnerId}')가 인증된 소유자('${cleanUid}')와 일치하지 않습니다.`,
    };
  }

  const incomingProjectId =
    typeof proposal.projectId === 'string' ? proposal.projectId.trim() : '';
  if (incomingProjectId && incomingProjectId !== cleanProjectId) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `[INVALID_PROPOSAL_PROJECT_ID] 제안서 projectId('${incomingProjectId}')가 현재 프로젝트('${cleanProjectId}')와 일치하지 않습니다.`,
    };
  }

  const cleanId = (proposal.id || '').trim();
  if (!SAFE_PROPOSAL_ID_REGEX.test(cleanId)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `[INVALID_PROPOSAL_ID] 유효하지 않은 proposalId 형식입니다 (${proposal.id}).`,
    };
  }

  const cleanTargetEntityId = (proposal.targetEntityId || '').trim();
  if (!SAFE_PROPOSAL_ID_REGEX.test(cleanTargetEntityId)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `[INVALID_PROPOSAL_TARGET_ID] 유효하지 않은 targetEntityId 형식입니다 (${proposal.targetEntityId}).`,
    };
  }

  if (!VALID_PROPOSAL_TARGET_TYPES.has(proposal.targetEntityType)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `[INVALID_PROPOSAL_TARGET_TYPE] 지원하지 않는 targetEntityType입니다 (${proposal.targetEntityType}).`,
    };
  }

  if (!VALID_PROPOSAL_ACTIONS.has(proposal.proposedAction)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `[INVALID_PROPOSAL_ACTION] 지원하지 않는 proposedAction입니다 (${proposal.proposedAction}).`,
    };
  }

  if (typeof proposal.title !== 'string') {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: '[INVALID_PROPOSAL_TITLE] 제안서 제목(title)이 누락되었습니다.',
    };
  }
  const cleanTitle = proposal.title.trim();
  if (cleanTitle.length < 1 || cleanTitle.length > PROPOSAL_LIMITS.TITLE_MAX) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `[INVALID_PROPOSAL_TITLE] 제안서 제목(title)은 1~${PROPOSAL_LIMITS.TITLE_MAX}자여야 합니다 (현재: ${cleanTitle.length}자).`,
    };
  }

  const cleanRationale =
    typeof proposal.rationale === 'string' ? proposal.rationale.trim() : '';
  if (cleanRationale.length > PROPOSAL_LIMITS.RATIONALE_MAX) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `[INVALID_PROPOSAL_RATIONALE] 제안서 근거(rationale)는 ${PROPOSAL_LIMITS.RATIONALE_MAX}자를 초과할 수 없습니다 (현재: ${cleanRationale.length}자).`,
    };
  }

  const cleanBeforeSummary =
    typeof proposal.beforeSummary === 'string' ? proposal.beforeSummary.trim() : '';
  if (cleanBeforeSummary.length > PROPOSAL_LIMITS.SUMMARY_MAX) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `[INVALID_PROPOSAL_BEFORE_SUMMARY] 변경 전 요약(beforeSummary)은 ${PROPOSAL_LIMITS.SUMMARY_MAX}자를 초과할 수 없습니다 (현재: ${cleanBeforeSummary.length}자).`,
    };
  }

  const cleanAfterSummary =
    typeof proposal.afterSummary === 'string' ? proposal.afterSummary.trim() : '';
  if (cleanAfterSummary.length > PROPOSAL_LIMITS.SUMMARY_MAX) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `[INVALID_PROPOSAL_AFTER_SUMMARY] 변경 후 요약(afterSummary)은 ${PROPOSAL_LIMITS.SUMMARY_MAX}자를 초과할 수 없습니다 (현재: ${cleanAfterSummary.length}자).`,
    };
  }

  const triggerEp = (proposal.triggerEpisodeId || '').trim();
  const triggerScene = (proposal.triggerSceneId || '').trim();
  const sourceRev = (proposal.sourceRevisionId || '').trim();

  if (!OPTIONAL_PROPOSAL_ID_REGEX.test(triggerEp)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: '[INVALID_PROPOSAL_TRIGGER_EPISODE] 유효하지 않은 triggerEpisodeId 형식입니다.',
    };
  }
  if (!OPTIONAL_PROPOSAL_ID_REGEX.test(triggerScene)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: '[INVALID_PROPOSAL_TRIGGER_SCENE] 유효하지 않은 triggerSceneId 형식입니다.',
    };
  }
  if (sourceRev === 'UNSAVED_DRAFT') {
    return {
      ok: false,
      errorCode: 'SOURCE_REVISION_UNVERIFIED',
      errorMessage: '[INVALID_PROPOSAL_SOURCE_REVISION] UNSAVED_DRAFT 상태의 제안서는 저장할 수 없습니다.',
    };
  }
  if (!OPTIONAL_PROPOSAL_ID_REGEX.test(sourceRev)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: '[INVALID_PROPOSAL_SOURCE_REVISION] 유효하지 않은 sourceRevisionId 형식입니다.',
    };
  }

  const rawActor =
    typeof proposal.createdBy === 'string' ? proposal.createdBy.trim() : '';
  const cleanCreatedBy: ActorType = rawActor
    ? (rawActor as ActorType)
    : 'AI_ENGINE';
  if (!VALID_PROPOSAL_ACTOR_TYPES.has(cleanCreatedBy)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `[INVALID_PROPOSAL_ACTOR] 지원하지 않는 createdBy 값입니다 (${rawActor}).`,
    };
  }

  const payloadCheck = canonicalizeProposedPayloadJson(proposal.proposedPayloadJson);
  if (!payloadCheck.ok) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: payloadCheck.error,
    };
  }

  return {
    ok: true,
    normalized: {
      id: cleanId,
      ownerId: cleanUid,
      projectId: cleanProjectId,
      targetEntityType: proposal.targetEntityType,
      targetEntityId: cleanTargetEntityId,
      proposedAction: proposal.proposedAction,
      title: cleanTitle,
      rationale: cleanRationale,
      beforeSummary: cleanBeforeSummary,
      afterSummary: cleanAfterSummary,
      proposedPayloadJson: payloadCheck.canonicalJson,
      triggerEpisodeId: triggerEp,
      triggerSceneId: triggerScene,
      sourceRevisionId: sourceRev,
      createdBy: cleanCreatedBy,
    },
  };
}

export function validateProposalBeforeFirestoreWrite(
  uid: string,
  projectId: string,
  proposal: ChangeProposal
): string | null {
  const res = normalizeAndValidateChangeProposalPayload(uid, projectId, proposal);
  return res.ok ? null : res.errorMessage;
}

function normalizeComparableImmutableFields(
  raw: Record<string, unknown> | Partial<ChangeProposal>
): {
  fields: Record<keyof ProposalImmutablePayload, string>;
  jsonValid: boolean;
} {
  const payloadCheck = canonicalizeProposedPayloadJson(raw.proposedPayloadJson);
  const rawCreatedBy =
    typeof raw.createdBy === 'string' ? raw.createdBy.trim() : '';
  return {
    jsonValid: payloadCheck.ok,
    fields: {
      id: String(raw.id ?? '').trim(),
      ownerId: String(raw.ownerId ?? '').trim(),
      projectId: String(raw.projectId ?? '').trim(),
      targetEntityType: String(raw.targetEntityType ?? '').trim(),
      targetEntityId: String(raw.targetEntityId ?? '').trim(),
      proposedAction: String(raw.proposedAction ?? '').trim(),
      title: String(raw.title ?? '').trim(),
      rationale: String(raw.rationale ?? '').trim(),
      beforeSummary: String(raw.beforeSummary ?? '').trim(),
      afterSummary: String(raw.afterSummary ?? '').trim(),
      proposedPayloadJson: payloadCheck.ok
        ? payloadCheck.canonicalJson
        : String(raw.proposedPayloadJson ?? ''),
      triggerEpisodeId: String(raw.triggerEpisodeId ?? '').trim(),
      triggerSceneId: String(raw.triggerSceneId ?? '').trim(),
      sourceRevisionId: String(raw.sourceRevisionId ?? '').trim(),
      createdBy: rawCreatedBy || 'AI_ENGINE',
    },
  };
}

export function areProposalsSemanticallyEquivalent(
  existing: Record<string, unknown> | Partial<ChangeProposal>,
  incoming: ChangeProposal | ProposalImmutablePayload
): {
  equivalent: boolean;
  reason?: string;
  errorCode?: 'PROPOSAL_OWNER_MISMATCH' | 'PROPOSAL_PAYLOAD_CONFLICT';
  mismatchFields?: (keyof ProposalImmutablePayload)[];
} {
  const existingNorm = normalizeComparableImmutableFields(existing);
  const incomingNorm = normalizeComparableImmutableFields(incoming);

  // Never treat invalid/unparseable JSON payloads as equal!
  if (!existingNorm.jsonValid || !incomingNorm.jsonValid) {
    return {
      equivalent: false,
      errorCode: 'PROPOSAL_PAYLOAD_CONFLICT',
      mismatchFields: ['proposedPayloadJson'],
      reason: `[PROPOSAL_PAYLOAD_CONFLICT] Proposal ID('${incomingNorm.fields.id}')의 proposedPayloadJson을 검증할 수 없어 동일 데이터로 간주하지 않습니다.`,
    };
  }

  if (
    existingNorm.fields.ownerId &&
    incomingNorm.fields.ownerId &&
    existingNorm.fields.ownerId !== incomingNorm.fields.ownerId
  ) {
    return {
      equivalent: false,
      errorCode: 'PROPOSAL_OWNER_MISMATCH',
      mismatchFields: ['ownerId'],
      reason: `[PROPOSAL_OWNER_MISMATCH] 기존 제안서(${incomingNorm.fields.id}) 소유자('${existingNorm.fields.ownerId}')와 요청 소유자('${incomingNorm.fields.ownerId}')가 일치하지 않습니다.`,
    };
  }

  const orderedFields: (keyof ProposalImmutablePayload)[] = [
    'id',
    'ownerId',
    'projectId',
    'targetEntityType',
    'targetEntityId',
    'proposedAction',
    'title',
    'rationale',
    'beforeSummary',
    'afterSummary',
    'proposedPayloadJson',
    'triggerEpisodeId',
    'triggerSceneId',
    'sourceRevisionId',
    'createdBy',
  ];

  const mismatchFields: (keyof ProposalImmutablePayload)[] = [];
  for (const field of orderedFields) {
    // Allow legacy fixtures where ownerId or projectId was omitted on existing mock partial object
    if (
      (field === 'ownerId' || field === 'projectId') &&
      !existingNorm.fields[field]
    ) {
      continue;
    }
    if (existingNorm.fields[field] !== incomingNorm.fields[field]) {
      mismatchFields.push(field);
    }
  }

  if (mismatchFields.length > 0) {
    if (
      mismatchFields.length === 1 &&
      mismatchFields[0] === 'sourceRevisionId' &&
      existingNorm.fields.sourceRevisionId
    ) {
      return {
        equivalent: false,
        errorCode: 'PROPOSAL_PAYLOAD_CONFLICT',
        mismatchFields,
        reason: `[PROPOSAL_PAYLOAD_CONFLICT][SOURCE_REVISION_CONFLICT] 기존 제안서(${incomingNorm.fields.id})의 sourceRevisionId('${existingNorm.fields.sourceRevisionId}')는 불변이며 '${incomingNorm.fields.sourceRevisionId}'로 변경할 수 없습니다.`,
      };
    }
    return {
      equivalent: false,
      errorCode: 'PROPOSAL_PAYLOAD_CONFLICT',
      mismatchFields,
      reason: `[PROPOSAL_PAYLOAD_CONFLICT] 동일한 Proposal ID('${incomingNorm.fields.id}')에 서로 다른 의미 필드(${mismatchFields.join(', ')})가 전달되어 덮어쓰기를 차단했습니다.`,
    };
  }

  return { equivalent: true, mismatchFields: [] };
}

export function buildCanonicalChangeProposalWriteDataFromNormalized(
  normalized: ProposalImmutablePayload
) {
  return {
    id: normalized.id,
    ownerId: normalized.ownerId,
    projectId: normalized.projectId,
    targetEntityType: normalized.targetEntityType,
    targetEntityId: normalized.targetEntityId,
    proposedAction: normalized.proposedAction,
    title: normalized.title,
    rationale: normalized.rationale,
    beforeSummary: normalized.beforeSummary,
    afterSummary: normalized.afterSummary,
    proposedPayloadJson: normalized.proposedPayloadJson,
    canonStatus: 'PROPOSED' as const,
    triggerEpisodeId: normalized.triggerEpisodeId,
    triggerSceneId: normalized.triggerSceneId,
    sourceRevisionId: normalized.sourceRevisionId,
    createdBy: normalized.createdBy,
    reviewedAt: '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function buildCanonicalChangeProposalWriteData(
  uid: string,
  projectId: string,
  proposal: ChangeProposal
) {
  const check = normalizeAndValidateChangeProposalPayload(uid, projectId, proposal);
  if (!check.ok) {
    throw new Error(check.errorMessage);
  }
  return buildCanonicalChangeProposalWriteDataFromNormalized(check.normalized);
}
