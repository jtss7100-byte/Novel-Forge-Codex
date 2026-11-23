import type {
  CanonStatus,
  ChangeProposal,
  CharacterRelationship,
  Foreshadowing,
  ForeshadowingPhase,
  TimelineEvent,
} from '../types/foundation';
import type {
  ApprovalActionType,
  ApprovalConflictCode,
  ApprovalConflictDetails,
  ApprovalRagSyncStatus,
  ApprovalTargetEntityType,
  ApprovalWorkspaceState,
  AppliedCanonEntity,
  ChangeProposalApprovalAudit,
  ChangeProposalApprovalOverrides,
  ChangeProposalFieldChangeType,
  ChangeProposalFieldDiff,
  ChangeProposalPreviewResponse,
  RagSyncTaskRecord,
} from '../types/changeProposalApproval';
import type {
  ChangeProposalPayloadEnvelope,
  ExtractedForeshadowingDraftPayload,
  ExtractedRelationshipDraftPayload,
  ExtractedTimelineEventDraftPayload,
} from '../types/manuscriptExtraction';
import type { Revision } from '../types/novel';
import {
  validateCharacterRelationshipInput,
  validateForeshadowingInput,
  validateTimelineEventInput,
} from './foundationLogic';
import { isUtf16SurrogateSplit } from './manuscriptExtractionLogic';
import { isValidEntityId } from './novelLogic';

function clampAffinityScore(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(-100, Math.min(100, Math.round(value)));
}

/**
 * Browser- and Node-compatible synchronous SHA-256 hex digest (RFC 6234).
 * Ensures `changeProposalApprovalLogic.ts` can be imported safely in both Vite browser bundles and Node server/tests.
 */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256HexSync(input: string): string {
  const utf8 = new TextEncoder().encode(input);
  const bitLen = utf8.length * 8;
  const totalBytes = (((utf8.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(totalBytes);
  padded.set(utf8, 0);
  padded[utf8.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(totalBytes - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(totalBytes - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < totalBytes; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 =
        rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 =
        rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, '0'))
    .join('');
}

/**
 * Type guard verifying whether an entity type is supported by the Phase 4.2.2 Author Approval Engine.
 */
export function isSupportedApprovalEntityType(
  entityType: unknown
): entityType is ApprovalTargetEntityType {
  return (
    entityType === 'RELATIONSHIP' ||
    entityType === 'TIMELINE_EVENT' ||
    entityType === 'FORESHADOWING'
  );
}

export const ALLOWED_RELATIONSHIP_FIRESTORE_KEYS = [
  'id',
  'ownerId',
  'projectId',
  'sourceCharacterId',
  'targetCharacterId',
  'relationType',
  'affinityScore',
  'isDirectional',
  'description',
  'canonStatus',
  'effectiveEpisodeId',
  'effectiveEventId',
  'sourceRevisionId',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

export const ALLOWED_TIMELINE_EVENT_FIRESTORE_KEYS = [
  'id',
  'ownerId',
  'projectId',
  'title',
  'summary',
  'inUniverseDate',
  'chronologicalOrder',
  'episodeId',
  'sceneId',
  'participantCharacterIds',
  'linkedForeshadowingIds',
  'linkedWorldbuildingIds',
  'canonStatus',
  'sourceRevisionId',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

export const ALLOWED_FORESHADOWING_FIRESTORE_KEYS = [
  'id',
  'ownerId',
  'projectId',
  'title',
  'description',
  'cluePhase',
  'canonStatus',
  'plantedEpisodeId',
  'plantedSceneId',
  'resolvedEpisodeId',
  'resolvedSceneId',
  'relatedEventIds',
  'relatedCharacterIds',
  'sourceRevisionId',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

export const ALLOWED_APPROVAL_AUDIT_FIRESTORE_KEYS = [
  'id',
  'ownerId',
  'projectId',
  'proposalId',
  'decision',
  'targetEntityType',
  'targetEntityId',
  'proposedAction',
  'triggerEpisodeId',
  'sourceRevisionId',
  'sourceSceneId',
  'proposalFingerprint',
  'reviewerUid',
  'reviewNote',
  'beforeCanonStatus',
  'afterCanonStatus',
  'beforeSnapshotJson',
  'afterSnapshotJson',
  'verifiedExcerptJson',
  'payoffNote',
  'ragSyncStatus',
  'ragSyncError',
  'createdAt',
  'updatedAt',
] as const;

export const REQUIRED_RELATIONSHIP_SNAPSHOT_KEYS = [
  'sourceCharacterId',
  'targetCharacterId',
  'relationType',
  'affinityScore',
  'isDirectional',
  'description',
  'effectiveEpisodeId',
  'effectiveEventId',
  'canonStatus',
  'sourceRevisionId',
] as const;

export const REQUIRED_TIMELINE_EVENT_SNAPSHOT_KEYS = [
  'title',
  'summary',
  'inUniverseDate',
  'chronologicalOrder',
  'episodeId',
  'sceneId',
  'participantCharacterIds',
  'linkedForeshadowingIds',
  'linkedWorldbuildingIds',
  'canonStatus',
  'sourceRevisionId',
] as const;

export const REQUIRED_FORESHADOWING_SNAPSHOT_KEYS = [
  'title',
  'description',
  'cluePhase',
  'plantedEpisodeId',
  'plantedSceneId',
  'resolvedEpisodeId',
  'resolvedSceneId',
  'relatedEventIds',
  'relatedCharacterIds',
  'canonStatus',
  'sourceRevisionId',
] as const;

export interface ApprovalValidationFailure {
  ok: false;
  code: ApprovalConflictCode;
  error: string;
  conflictDetails?: ApprovalConflictDetails;
}

export interface EnvelopeVerificationSuccess {
  ok: true;
  targetEntityType: ApprovalTargetEntityType;
  proposedAction: ApprovalActionType;
  envelope: ChangeProposalPayloadEnvelope;
}

export type EnvelopeVerificationResult =
  | EnvelopeVerificationSuccess
  | ApprovalValidationFailure;

const SAFE_AUDIT_ID_PROPOSAL_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Legacy Stage 1 audit ID computation (kept for backward-compatible lookup of already-stored audits).
 */
export function computeLegacyApprovalAuditId(
  proposalId: string,
  decision: 'APPROVED' | 'REJECTED'
): string {
  const safeProposalId = proposalId
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 90);
  return `audit_${safeProposalId}_${decision}`;
}

/**
 * Phase 4.2.2 Stage 1.5 Section 3.4: Collision-resistant deterministic audit ID.
 * - For canonical proposalIds matching `/^[A-Za-z0-9_-]{1,64}$/`, returns `audit_${proposalId}_${decision}`
 *   (100% backward-compatible with Stage 1 deterministic IDs and zero normalization loss).
 * - If `proposalId` contains characters outside `[A-Za-z0-9_-]` or exceeds 64 chars (where character replacement
 *   or truncation could otherwise cause two distinct proposalIds to collide), appends a 16-hex-char SHA-256
 *   digest computed over the full raw `proposalId` and `decision`.
 */
export function computeDeterministicApprovalAuditId(
  proposalId: string,
  decision: 'APPROVED' | 'REJECTED'
): string {
  if (SAFE_AUDIT_ID_PROPOSAL_REGEX.test(proposalId)) {
    return `audit_${proposalId}_${decision}`;
  }
  const safePrefix = proposalId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48);
  const hash16 = sha256HexSync(`${proposalId}:${decision}`).slice(0, 16);
  return `audit_${safePrefix}_${hash16}_${decision}`;
}

/**
 * Phase 4.2.2 Stage 1.5 Section 3.2: Verifies that an existing `ChangeProposalApprovalAudit` document
 * is genuinely linked to the given `ChangeProposal` and matches all 9 integrity attributes.
 */
export function verifyExistingAuditRecordMatchesProposal(params: {
  audit: ChangeProposalApprovalAudit;
  proposal: ChangeProposal;
  envelope: ChangeProposalPayloadEnvelope;
  expectedDecision: 'APPROVED' | 'REJECTED';
  expectedOwnerId: string;
  expectedProjectId: string;
  currentEntity?: AppliedCanonEntity | null;
}): { ok: true } | ApprovalValidationFailure {
  const {
    audit,
    proposal,
    envelope,
    expectedDecision,
    expectedOwnerId,
    expectedProjectId,
    currentEntity,
  } = params;

  const expectedAfterStatus: CanonStatus =
    expectedDecision === 'APPROVED' ? 'CANON' : 'REJECTED';

  if (
    !audit ||
    audit.proposalId !== proposal.id ||
    audit.ownerId !== expectedOwnerId ||
    audit.projectId !== expectedProjectId ||
    audit.decision !== expectedDecision ||
    audit.targetEntityType !== proposal.targetEntityType ||
    audit.targetEntityId !== proposal.targetEntityId ||
    !audit.reviewerUid ||
    audit.reviewerUid !== expectedOwnerId ||
    audit.sourceRevisionId !== proposal.sourceRevisionId ||
    audit.proposalFingerprint !== envelope.fingerprint ||
    audit.afterCanonStatus !== expectedAfterStatus
  ) {
    return {
      ok: false,
      code: 'AUDIT_STATE_INCONSISTENCY',
      error: `[AUDIT_STATE_INCONSISTENCY] 기존 감사 이력(${
        audit?.id || 'unknown'
      })의 핵심 필드(proposalId/ownerId/projectId/decision/targetEntityType/targetEntityId/reviewerUid/sourceRevisionId/proposalFingerprint)가 제안서(${
        proposal.id
      })와 일치하지 않습니다.`,
    };
  }

  if (expectedDecision === 'APPROVED') {
    if (
      !currentEntity ||
      currentEntity.id !== proposal.targetEntityId ||
      currentEntity.ownerId !== expectedOwnerId ||
      currentEntity.projectId !== expectedProjectId ||
      currentEntity.canonStatus !== 'CANON'
    ) {
      return {
        ok: false,
        code: 'AUDIT_STATE_INCONSISTENCY',
        error: `[AUDIT_STATE_INCONSISTENCY] 승인 감사 이력(${audit.id})은 존재하나 실제 대상 엔티티(${proposal.targetEntityId})가 유효한 CANON 상태가 아닙니다.`,
      };
    }
  }

  return { ok: true };
}

/**
 * Step 4.1: Verifies that a ChangeProposal's envelope (`proposedPayloadJson`) is intact,
 * adheres to `PHASE_4_2_1_V1`, targets a supported entity type (`RELATIONSHIP`, `TIMELINE_EVENT`, `FORESHADOWING`),
 * and uses a supported action (`CREATE` or `UPDATE`).
 */
export function verifyProposalEnvelopeIntegrity(
  proposal: ChangeProposal
): EnvelopeVerificationResult {
  if (!proposal || typeof proposal !== 'object') {
    return {
      ok: false,
      code: 'PAYLOAD_INTEGRITY_ERROR',
      error: '[PAYLOAD_INTEGRITY_ERROR] 제안서 객체가 유효하지 않습니다.',
    };
  }

  if (
    !isValidEntityId(proposal.id) ||
    !isValidEntityId(proposal.ownerId) ||
    !isValidEntityId(proposal.projectId) ||
    !isValidEntityId(proposal.targetEntityId) ||
    !isValidEntityId(proposal.triggerEpisodeId) ||
    !isValidEntityId(proposal.sourceRevisionId)
  ) {
    return {
      ok: false,
      code: 'PAYLOAD_INTEGRITY_ERROR',
      error:
        '[PAYLOAD_INTEGRITY_ERROR] 제안서 필수 식별자(id, ownerId, projectId, targetEntityId, triggerEpisodeId, sourceRevisionId) 형식이 유효하지 않습니다.',
    };
  }

  if (
    proposal.targetEntityType !== 'RELATIONSHIP' &&
    proposal.targetEntityType !== 'TIMELINE_EVENT' &&
    proposal.targetEntityType !== 'FORESHADOWING'
  ) {
    return {
      ok: false,
      code: 'UNSUPPORTED_ENTITY_OR_ACTION',
      error: `[UNSUPPORTED_ENTITY_OR_ACTION] Phase 4.2.2 승인 엔진은 RELATIONSHIP, TIMELINE_EVENT, FORESHADOWING 엔티티만 지원합니다 (요청: ${String(
        proposal.targetEntityType
      )}).`,
    };
  }

  if (
    proposal.proposedAction !== 'CREATE' &&
    proposal.proposedAction !== 'UPDATE'
  ) {
    return {
      ok: false,
      code: 'UNSUPPORTED_ENTITY_OR_ACTION',
      error: `[UNSUPPORTED_ENTITY_OR_ACTION] Phase 4.2.2 Stage 1.5 승인 엔진은 CREATE 및 UPDATE 작업만 지원합니다 (요청: ${String(
        proposal.proposedAction
      )}).`,
    };
  }

  if (
    typeof proposal.proposedPayloadJson !== 'string' ||
    proposal.proposedPayloadJson.trim().length === 0
  ) {
    return {
      ok: false,
      code: 'PAYLOAD_INTEGRITY_ERROR',
      error:
        '[PAYLOAD_INTEGRITY_ERROR] 제안서의 proposedPayloadJson이 비어 있습니다.',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(proposal.proposedPayloadJson);
  } catch {
    return {
      ok: false,
      code: 'PAYLOAD_INTEGRITY_ERROR',
      error:
        '[PAYLOAD_INTEGRITY_ERROR] 제안서의 proposedPayloadJson이 유효한 JSON 형식이 아닙니다.',
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      code: 'PAYLOAD_INTEGRITY_ERROR',
      error:
        '[PAYLOAD_INTEGRITY_ERROR] 제안서 페이로드 엔벨로프가 객체가 아닙니다.',
    };
  }

  const envelope = parsed as ChangeProposalPayloadEnvelope;

  if (envelope.schemaVersion !== 'PHASE_4_2_1_V1') {
    return {
      ok: false,
      code: 'PAYLOAD_INTEGRITY_ERROR',
      error: `[PAYLOAD_INTEGRITY_ERROR] 지원되지 않는 페이로드 schemaVersion(${String(
        envelope.schemaVersion
      )})입니다. PHASE_4_2_1_V1이 필요합니다.`,
    };
  }

  if (
    typeof envelope.fingerprint !== 'string' ||
    envelope.fingerprint.trim().length === 0
  ) {
    return {
      ok: false,
      code: 'PAYLOAD_INTEGRITY_ERROR',
      error:
        '[PAYLOAD_INTEGRITY_ERROR] 제안서 페이로드에 유효한 fingerprint가 없습니다.',
    };
  }

  if (
    envelope.targetEntityType !== proposal.targetEntityType ||
    envelope.proposedAction !== proposal.proposedAction ||
    envelope.targetEntityId !== proposal.targetEntityId ||
    envelope.sourceEpisodeId !== proposal.triggerEpisodeId ||
    envelope.sourceRevisionId !== proposal.sourceRevisionId
  ) {
    return {
      ok: false,
      code: 'PAYLOAD_INTEGRITY_ERROR',
      error:
        '[PAYLOAD_INTEGRITY_ERROR] 제안서 상위 메타데이터와 proposedPayloadJson 내부의 엔티티 타입/액션/ID/회차/리비전 정보가 일치하지 않습니다.',
    };
  }

  const excerpt = envelope.verifiedExcerpt;
  if (
    !excerpt ||
    typeof excerpt !== 'object' ||
    typeof excerpt.matchedText !== 'string' ||
    excerpt.matchedText.trim().length === 0 ||
    typeof excerpt.startOffset !== 'number' ||
    typeof excerpt.endOffset !== 'number' ||
    !Number.isInteger(excerpt.startOffset) ||
    !Number.isInteger(excerpt.endOffset) ||
    excerpt.startOffset < 0 ||
    excerpt.endOffset <= excerpt.startOffset ||
    (excerpt.matchMethod !== 'EXACT' &&
      excerpt.matchMethod !== 'WHITESPACE_NORMALIZED')
  ) {
    return {
      ok: false,
      code: 'EXCERPT_OFFSET_INVALID',
      error:
        '[EXCERPT_OFFSET_INVALID] 제안서 페이로드 내 verifiedExcerpt 오프셋 또는 발췌 문자열 정보가 손상되었습니다.',
    };
  }

  if (proposal.targetEntityType === 'RELATIONSHIP') {
    const draft = envelope.relationshipDraft;
    if (
      !draft ||
      draft.id !== proposal.targetEntityId ||
      draft.ownerId !== proposal.ownerId ||
      draft.projectId !== proposal.projectId ||
      draft.sourceRevisionId !== proposal.sourceRevisionId
    ) {
      return {
        ok: false,
        code: 'PAYLOAD_INTEGRITY_ERROR',
        error:
          '[PAYLOAD_INTEGRITY_ERROR] RELATIONSHIP 제안서의 relationshipDraft가 누락되었거나 식별자(id/ownerId/projectId/sourceRevisionId)가 불일치합니다.',
      };
    }
  } else if (proposal.targetEntityType === 'TIMELINE_EVENT') {
    const draft = envelope.timelineEventDraft;
    if (
      !draft ||
      draft.id !== proposal.targetEntityId ||
      draft.ownerId !== proposal.ownerId ||
      draft.projectId !== proposal.projectId ||
      draft.sourceRevisionId !== proposal.sourceRevisionId
    ) {
      return {
        ok: false,
        code: 'PAYLOAD_INTEGRITY_ERROR',
        error:
          '[PAYLOAD_INTEGRITY_ERROR] TIMELINE_EVENT 제안서의 timelineEventDraft가 누락되었거나 식별자(id/ownerId/projectId/sourceRevisionId)가 불일치합니다.',
      };
    }
  } else if (proposal.targetEntityType === 'FORESHADOWING') {
    const draft = envelope.foreshadowingDraft;
    if (
      !draft ||
      draft.id !== proposal.targetEntityId ||
      draft.ownerId !== proposal.ownerId ||
      draft.projectId !== proposal.projectId ||
      draft.sourceRevisionId !== proposal.sourceRevisionId
    ) {
      return {
        ok: false,
        code: 'PAYLOAD_INTEGRITY_ERROR',
        error:
          '[PAYLOAD_INTEGRITY_ERROR] FORESHADOWING 제안서의 foreshadowingDraft가 누락되었거나 식별자(id/ownerId/projectId/sourceRevisionId)가 불일치합니다.',
      };
    }
  }

  return {
    ok: true,
    targetEntityType: proposal.targetEntityType,
    proposedAction: proposal.proposedAction,
    envelope,
  };
}

/**
 * Step 4.2: Re-verifies at approval time that the authoritative `Revision` exists,
 * belongs to the same project and episode, and that `revision.content.slice(startOffset, endOffset)`
 * still equals `envelope.verifiedExcerpt.matchedText` without splitting a UTF-16 surrogate pair.
 */
export function verifyRevisionExcerptAtApproval(params: {
  proposal: ChangeProposal;
  envelope: ChangeProposalPayloadEnvelope;
  revision: Revision | null | undefined;
}): { ok: true } | ApprovalValidationFailure {
  const { proposal, envelope, revision } = params;

  if (!revision || typeof revision.content !== 'string') {
    return {
      ok: false,
      code: 'REVISION_NOT_FOUND',
      error: `[REVISION_NOT_FOUND] 제안서 근거 리비전(${proposal.sourceRevisionId})을 찾을 수 없거나 본문이 비어 있습니다.`,
    };
  }

  if (
    revision.id !== proposal.sourceRevisionId ||
    revision.projectId !== proposal.projectId ||
    revision.episodeId !== proposal.triggerEpisodeId
  ) {
    return {
      ok: false,
      code: 'REFERENCE_INTEGRITY_ERROR',
      error: `[REFERENCE_INTEGRITY_ERROR] 근거 리비전(${revision.id})의 projectId 또는 episodeId가 제안서 메타데이터와 일치하지 않습니다.`,
    };
  }

  const { startOffset, endOffset, matchedText } = envelope.verifiedExcerpt;
  if (
    startOffset < 0 ||
    endOffset <= startOffset ||
    endOffset > revision.content.length ||
    isUtf16SurrogateSplit(revision.content, startOffset) ||
    isUtf16SurrogateSplit(revision.content, endOffset)
  ) {
    return {
      ok: false,
      code: 'EXCERPT_OFFSET_INVALID',
      error: `[EXCERPT_OFFSET_INVALID] 근거 리비전(${revision.id}) 원문 길이(${revision.content.length}) 대비 발췌 오프셋([${startOffset}, ${endOffset}))이 유효하지 않거나 UTF-16 서로게이트 쌍을 분할합니다.`,
    };
  }

  const actualSlice = revision.content.slice(startOffset, endOffset);
  if (actualSlice !== matchedText) {
    return {
      ok: false,
      code: 'EXCERPT_OFFSET_INVALID',
      error: `[EXCERPT_OFFSET_INVALID] 근거 리비전(${revision.id})의 [${startOffset}, ${endOffset}) 구간 원문이 제안서 생성 시점의 발췌문과 일치하지 않습니다.`,
    };
  }

  return { ok: true };
}

function areIdSetsEqual(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const normA = Array.from(
    new Set(
      a
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.trim())
        .filter(Boolean)
    )
  ).sort();
  const normB = Array.from(
    new Set(
      b
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.trim())
        .filter(Boolean)
    )
  ).sort();
  if (normA.length !== normB.length) return false;
  return normA.every((val, i) => val === normB[i]);
}

function summarizeEntityForConflict(
  entity: Record<string, unknown> | null | undefined,
  allowedKeys: readonly string[]
): Record<string, unknown> | null {
  if (!entity || typeof entity !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (key in entity) {
      out[key] = entity[key];
    }
  }
  if ('updatedAt' in entity) {
    out.updatedAt = entity.updatedAt;
  }
  return out;
}

const FORESHADOWING_PHASE_RANK: Record<ForeshadowingPhase, number> = {
  PLANTED: 1,
  REINFORCED: 2,
  RESOLVED: 3,
  ABANDONED: 4,
};

/**
 * Step 4.3 (Stage 1.5 Hardened — Sections 4 & 5):
 * Detects whether the target entity in Firestore has been created, deleted, modified, or has a semantic conflict
 * since the proposal was generated:
 * - Blocks `forceApplyOnStale === true` unconditionally with `STALE_OVERRIDE_FORBIDDEN`.
 * - Verifies target entity belongs to the same `ownerId` and `projectId` (`REFERENCE_INTEGRITY_ERROR` on mismatch).
 * - Requires all approval-relevant fields to be present in `existingEntitySnapshot` (`PAYLOAD_INTEGRITY_ERROR` if missing).
 * - Compares all scalar and ID-set fields for `RELATIONSHIP`, `TIMELINE_EVENT`, and `FORESHADOWING` (`STALE_TARGET` on any change).
 * - Detects semantic conflicts (`CONFLICT_REQUIRES_REVIEW`), such as regressing a `RESOLVED` foreshadowing back to `PLANTED`/`REINFORCED`
 *   or updating an `ARCHIVED`/`ABANDONED` entity.
 */
export function detectTargetEntityStaleOrConflict(params: {
  envelope: ChangeProposalPayloadEnvelope;
  currentEntity: AppliedCanonEntity | null;
  expectedOwnerId?: string;
  expectedProjectId?: string;
  forceApplyOnStale?: boolean;
}): { ok: true } | ApprovalValidationFailure {
  const {
    envelope,
    currentEntity,
    expectedOwnerId,
    expectedProjectId,
    forceApplyOnStale = false,
  } = params;

  // Section 4.1: Block forceApplyOnStale bypass unconditionally in general approval flow
  if (forceApplyOnStale) {
    return {
      ok: false,
      code: 'STALE_OVERRIDE_FORBIDDEN',
      error: `[STALE_OVERRIDE_FORBIDDEN] 일반 승인 요청에서는 forceApplyOnStale 플래그를 통한 기존 CANON 설정 충돌 우회가 금지됩니다.`,
      conflictDetails: {
        conflictCode: 'STALE_OVERRIDE_FORBIDDEN',
        targetEntityId: envelope.targetEntityId,
        changedFields: ['forceApplyOnStale'],
        snapshotSummary: null,
        currentEntitySummary: null,
        requiresReview: true,
      },
    };
  }

  const draftOwnerId =
    expectedOwnerId ||
    envelope.relationshipDraft?.ownerId ||
    envelope.timelineEventDraft?.ownerId ||
    envelope.foreshadowingDraft?.ownerId ||
    envelope.provenance?.ownerId ||
    '';
  const draftProjectId =
    expectedProjectId ||
    envelope.relationshipDraft?.projectId ||
    envelope.timelineEventDraft?.projectId ||
    envelope.foreshadowingDraft?.projectId ||
    envelope.provenance?.projectId ||
    '';

  if (
    currentEntity &&
    ((draftOwnerId && currentEntity.ownerId !== draftOwnerId) ||
      (draftProjectId && currentEntity.projectId !== draftProjectId) ||
      currentEntity.id !== envelope.targetEntityId)
  ) {
    return {
      ok: false,
      code: 'REFERENCE_INTEGRITY_ERROR',
      error: `[REFERENCE_INTEGRITY_ERROR] 대상 엔티티(${envelope.targetEntityId})의 소유자(ownerId) 또는 프로젝트(projectId)가 제안서 컨텍스트와 일치하지 않습니다.`,
      conflictDetails: {
        conflictCode: 'REFERENCE_INTEGRITY_ERROR',
        targetEntityId: envelope.targetEntityId,
        changedFields: ['ownerId', 'projectId', 'id'],
        snapshotSummary: null,
        currentEntitySummary: null,
        requiresReview: true,
      },
    };
  }

  if (envelope.proposedAction === 'CREATE') {
    if (currentEntity !== null) {
      return {
        ok: false,
        code: 'TARGET_ALREADY_EXISTS',
        error: `[TARGET_ALREADY_EXISTS] CREATE 제안서의 대상 엔티티(${envelope.targetEntityId})가 이미 존재합니다. 기존 설정을 덮어쓰지 않도록 승인이 거부되었습니다.`,
        conflictDetails: {
          conflictCode: 'TARGET_ALREADY_EXISTS',
          targetEntityId: envelope.targetEntityId,
          changedFields: ['id'],
          snapshotSummary: null,
          currentEntitySummary: {
            id: currentEntity.id,
            canonStatus: currentEntity.canonStatus,
            updatedAt: currentEntity.updatedAt,
          },
          requiresReview: true,
        },
      };
    }
    return { ok: true };
  }

  // UPDATE action
  if (currentEntity === null) {
    return {
      ok: false,
      code: 'TARGET_NOT_FOUND',
      error: `[TARGET_NOT_FOUND] UPDATE 제안서의 대상 엔티티(${envelope.targetEntityId})가 존재하지 않거나 삭제되었습니다.`,
      conflictDetails: {
        conflictCode: 'TARGET_NOT_FOUND',
        targetEntityId: envelope.targetEntityId,
        changedFields: [],
        snapshotSummary: null,
        currentEntitySummary: null,
        requiresReview: true,
      },
    };
  }

  const snap = envelope.existingEntitySnapshot as
    | Record<string, unknown>
    | null
    | undefined;
  if (!snap || typeof snap !== 'object') {
    return {
      ok: false,
      code: 'PAYLOAD_INTEGRITY_ERROR',
      error: `[PAYLOAD_INTEGRITY_ERROR] UPDATE 제안서(${envelope.targetEntityId})에 비교 기준 스냅샷(existingEntitySnapshot)이 누락되어 있습니다.`,
      conflictDetails: {
        conflictCode: 'PAYLOAD_INTEGRITY_ERROR',
        targetEntityId: envelope.targetEntityId,
        changedFields: [],
        snapshotSummary: null,
        currentEntitySummary: null,
        requiresReview: true,
      },
    };
  }

  const requiredKeys: readonly string[] =
    envelope.targetEntityType === 'RELATIONSHIP'
      ? REQUIRED_RELATIONSHIP_SNAPSHOT_KEYS
      : envelope.targetEntityType === 'TIMELINE_EVENT'
      ? REQUIRED_TIMELINE_EVENT_SNAPSHOT_KEYS
      : REQUIRED_FORESHADOWING_SNAPSHOT_KEYS;

  // Section 5.4: Do not assume equality if a required comparison field is missing from existingEntitySnapshot
  const missingSnapshotKeys = requiredKeys.filter(
    (k) => snap[k] === undefined || snap[k] === null
  );
  if (missingSnapshotKeys.length > 0) {
    return {
      ok: false,
      code: 'PAYLOAD_INTEGRITY_ERROR',
      error: `[PAYLOAD_INTEGRITY_ERROR] UPDATE 제안서(${
        envelope.targetEntityId
      })의 existingEntitySnapshot에 안전 비교를 위한 필수 필드(${missingSnapshotKeys.join(
        ', '
      )})가 누락되어 있습니다.`,
      conflictDetails: {
        conflictCode: 'PAYLOAD_INTEGRITY_ERROR',
        targetEntityId: envelope.targetEntityId,
        changedFields: missingSnapshotKeys as string[],
        snapshotSummary: summarizeEntityForConflict(snap, requiredKeys),
        currentEntitySummary: summarizeEntityForConflict(
          currentEntity as unknown as Record<string, unknown>,
          requiredKeys
        ),
        requiresReview: true,
      },
    };
  }

  const changedFields: string[] = [];

  if (envelope.targetEntityType === 'RELATIONSHIP') {
    const relCurrent = currentEntity as CharacterRelationship;
    const relSnap = snap as unknown as CharacterRelationship;

    if (relSnap.sourceCharacterId !== relCurrent.sourceCharacterId) {
      changedFields.push('sourceCharacterId');
    }
    if (relSnap.targetCharacterId !== relCurrent.targetCharacterId) {
      changedFields.push('targetCharacterId');
    }
    if (relSnap.relationType !== relCurrent.relationType) {
      changedFields.push('relationType');
    }
    if (relSnap.affinityScore !== relCurrent.affinityScore) {
      changedFields.push('affinityScore');
    }
    if (relSnap.isDirectional !== relCurrent.isDirectional) {
      changedFields.push('isDirectional');
    }
    if (relSnap.description !== relCurrent.description) {
      changedFields.push('description');
    }
    if (relSnap.effectiveEpisodeId !== relCurrent.effectiveEpisodeId) {
      changedFields.push('effectiveEpisodeId');
    }
    if (relSnap.effectiveEventId !== relCurrent.effectiveEventId) {
      changedFields.push('effectiveEventId');
    }
    if (relSnap.canonStatus !== relCurrent.canonStatus) {
      changedFields.push('canonStatus');
    }
    if (relSnap.sourceRevisionId !== relCurrent.sourceRevisionId) {
      changedFields.push('sourceRevisionId');
    }
  } else if (envelope.targetEntityType === 'TIMELINE_EVENT') {
    const evtCurrent = currentEntity as TimelineEvent;
    const evtSnap = snap as unknown as TimelineEvent;

    if (evtSnap.title !== evtCurrent.title) {
      changedFields.push('title');
    }
    if (evtSnap.summary !== evtCurrent.summary) {
      changedFields.push('summary');
    }
    if (evtSnap.inUniverseDate !== evtCurrent.inUniverseDate) {
      changedFields.push('inUniverseDate');
    }
    if (evtSnap.chronologicalOrder !== evtCurrent.chronologicalOrder) {
      changedFields.push('chronologicalOrder');
    }
    if (evtSnap.episodeId !== evtCurrent.episodeId) {
      changedFields.push('episodeId');
    }
    if (evtSnap.sceneId !== evtCurrent.sceneId) {
      changedFields.push('sceneId');
    }
    if (
      !areIdSetsEqual(
        evtSnap.participantCharacterIds,
        evtCurrent.participantCharacterIds
      )
    ) {
      changedFields.push('participantCharacterIds');
    }
    if (
      !areIdSetsEqual(
        evtSnap.linkedForeshadowingIds,
        evtCurrent.linkedForeshadowingIds
      )
    ) {
      changedFields.push('linkedForeshadowingIds');
    }
    if (
      !areIdSetsEqual(
        evtSnap.linkedWorldbuildingIds,
        evtCurrent.linkedWorldbuildingIds
      )
    ) {
      changedFields.push('linkedWorldbuildingIds');
    }
    if (evtSnap.canonStatus !== evtCurrent.canonStatus) {
      changedFields.push('canonStatus');
    }
    if (evtSnap.sourceRevisionId !== evtCurrent.sourceRevisionId) {
      changedFields.push('sourceRevisionId');
    }
  } else if (envelope.targetEntityType === 'FORESHADOWING') {
    const fshCurrent = currentEntity as Foreshadowing;
    const fshSnap = snap as unknown as Foreshadowing;

    if (fshSnap.title !== fshCurrent.title) {
      changedFields.push('title');
    }
    if (fshSnap.description !== fshCurrent.description) {
      changedFields.push('description');
    }
    if (fshSnap.cluePhase !== fshCurrent.cluePhase) {
      changedFields.push('cluePhase');
    }
    if (fshSnap.plantedEpisodeId !== fshCurrent.plantedEpisodeId) {
      changedFields.push('plantedEpisodeId');
    }
    if (fshSnap.plantedSceneId !== fshCurrent.plantedSceneId) {
      changedFields.push('plantedSceneId');
    }
    if (fshSnap.resolvedEpisodeId !== fshCurrent.resolvedEpisodeId) {
      changedFields.push('resolvedEpisodeId');
    }
    if (fshSnap.resolvedSceneId !== fshCurrent.resolvedSceneId) {
      changedFields.push('resolvedSceneId');
    }
    if (!areIdSetsEqual(fshSnap.relatedEventIds, fshCurrent.relatedEventIds)) {
      changedFields.push('relatedEventIds');
    }
    if (
      !areIdSetsEqual(
        fshSnap.relatedCharacterIds,
        fshCurrent.relatedCharacterIds
      )
    ) {
      changedFields.push('relatedCharacterIds');
    }
    if (fshSnap.canonStatus !== fshCurrent.canonStatus) {
      changedFields.push('canonStatus');
    }
    if (fshSnap.sourceRevisionId !== fshCurrent.sourceRevisionId) {
      changedFields.push('sourceRevisionId');
    }
  }

  if (
    typeof snap.updatedAt === 'string' &&
    snap.updatedAt.trim().length > 0 &&
    typeof currentEntity.updatedAt === 'string' &&
    currentEntity.updatedAt.trim().length > 0 &&
    snap.updatedAt !== currentEntity.updatedAt &&
    !changedFields.includes('updatedAt')
  ) {
    changedFields.push('updatedAt');
  }

  // Section 4.2 C: Semantic Conflict Detection (CONFLICT_REQUIRES_REVIEW)
  if (
    currentEntity.canonStatus === 'ARCHIVED' ||
    currentEntity.canonStatus === 'REJECTED'
  ) {
    return {
      ok: false,
      code: 'CONFLICT_REQUIRES_REVIEW',
      error: `[CONFLICT_REQUIRES_REVIEW] 대상 엔티티(${envelope.targetEntityId})의 현재 상태가 '${currentEntity.canonStatus}'이므로 자동 UPDATE 승인이 차단되었습니다. 작가의 재검토가 필요합니다.`,
      conflictDetails: {
        conflictCode: 'CONFLICT_REQUIRES_REVIEW',
        targetEntityId: envelope.targetEntityId,
        changedFields:
          changedFields.length > 0 ? changedFields : ['canonStatus'],
        snapshotSummary: summarizeEntityForConflict(snap, requiredKeys),
        currentEntitySummary: summarizeEntityForConflict(
          currentEntity as unknown as Record<string, unknown>,
          requiredKeys
        ),
        requiresReview: true,
      },
    };
  }

  if (envelope.targetEntityType === 'FORESHADOWING') {
    const fshCurrent = currentEntity as Foreshadowing;
    if (fshCurrent.cluePhase === 'ABANDONED') {
      return {
        ok: false,
        code: 'CONFLICT_REQUIRES_REVIEW',
        error: `[CONFLICT_REQUIRES_REVIEW] 이미 폐기(ABANDONED)된 복선(${envelope.targetEntityId})은 자동 UPDATE 승인이 차단되었습니다.`,
        conflictDetails: {
          conflictCode: 'CONFLICT_REQUIRES_REVIEW',
          targetEntityId: envelope.targetEntityId,
          changedFields: Array.from(new Set([...changedFields, 'cluePhase'])),
          snapshotSummary: summarizeEntityForConflict(snap, requiredKeys),
          currentEntitySummary: summarizeEntityForConflict(
            currentEntity as unknown as Record<string, unknown>,
            requiredKeys
          ),
          requiresReview: true,
        },
      };
    }

    const fshDraft = envelope.foreshadowingDraft;
    if (fshDraft) {
      const currentRank = FORESHADOWING_PHASE_RANK[fshCurrent.cluePhase] ?? 1;
      const proposedRank = FORESHADOWING_PHASE_RANK[fshDraft.cluePhase] ?? 1;

      if (proposedRank < currentRank) {
        return {
          ok: false,
          code: 'CONFLICT_REQUIRES_REVIEW',
          error: `[CONFLICT_REQUIRES_REVIEW] 이미 '${fshCurrent.cluePhase}' 단계로 확정된 복선(${envelope.targetEntityId})을 이전 단계('${fshDraft.cluePhase}')로 역행시키는 의미적 충돌이 감지되었습니다.`,
          conflictDetails: {
            conflictCode: 'CONFLICT_REQUIRES_REVIEW',
            targetEntityId: envelope.targetEntityId,
            changedFields: Array.from(new Set([...changedFields, 'cluePhase'])),
            snapshotSummary: summarizeEntityForConflict(snap, requiredKeys),
            currentEntitySummary: summarizeEntityForConflict(
              currentEntity as unknown as Record<string, unknown>,
              requiredKeys
            ),
            requiresReview: true,
          },
        };
      }
    }
  } else if (envelope.targetEntityType === 'RELATIONSHIP') {
    const relCurrent = currentEntity as CharacterRelationship;
    const relDraft = envelope.relationshipDraft;
    if (relDraft) {
      const pairMatchesDirect =
        relCurrent.sourceCharacterId === relDraft.sourceCharacterId &&
        relCurrent.targetCharacterId === relDraft.targetCharacterId;
      const pairMatchesReverse =
        !relCurrent.isDirectional &&
        relCurrent.sourceCharacterId === relDraft.targetCharacterId &&
        relCurrent.targetCharacterId === relDraft.sourceCharacterId;
      if (!pairMatchesDirect && !pairMatchesReverse) {
        return {
          ok: false,
          code: 'CONFLICT_REQUIRES_REVIEW',
          error: `[CONFLICT_REQUIRES_REVIEW] 기존 인물 관계(${relCurrent.sourceCharacterId} -> ${relCurrent.targetCharacterId})와 제안서의 인물 쌍(${relDraft.sourceCharacterId} -> ${relDraft.targetCharacterId})이 일치하지 않는 의미적 충돌이 감지되었습니다.`,
          conflictDetails: {
            conflictCode: 'CONFLICT_REQUIRES_REVIEW',
            targetEntityId: envelope.targetEntityId,
            changedFields: Array.from(
              new Set([
                ...changedFields,
                'sourceCharacterId',
                'targetCharacterId',
              ])
            ),
            snapshotSummary: summarizeEntityForConflict(snap, requiredKeys),
            currentEntitySummary: summarizeEntityForConflict(
              currentEntity as unknown as Record<string, unknown>,
              requiredKeys
            ),
            requiresReview: true,
          },
        };
      }
    }
  }

  if (changedFields.length > 0) {
    return {
      ok: false,
      code: 'STALE_TARGET',
      error: `[STALE_TARGET] 대상 엔티티(${
        envelope.targetEntityId
      })가 제안서 추출 시점 이후 수정되었습니다 (변경 필드: ${changedFields.join(
        ', '
      )}). 최신 CANON 설정 보호를 위해 자동 덮어쓰기가 차단되었습니다.`,
      conflictDetails: {
        conflictCode: 'STALE_TARGET',
        targetEntityId: envelope.targetEntityId,
        changedFields,
        snapshotSummary: summarizeEntityForConflict(snap, requiredKeys),
        currentEntitySummary: summarizeEntityForConflict(
          currentEntity as unknown as Record<string, unknown>,
          requiredKeys
        ),
        requiresReview: true,
      },
    };
  }

  return { ok: true };
}

/**
 * Step 4.4: Explicit mapping from `ExtractedRelationshipDraftPayload` -> `CharacterRelationship`.
 * - Maps `lastChangedEpisodeId` -> `effectiveEpisodeId`
 * - Validates `sourceCharacterId` and `targetCharacterId` against project `characters`
 * - Validates `effectiveEpisodeId` against project `episodes`
 * - Validates `effectiveEventId` against project `timelineEvents` (if non-empty)
 * - Strips non-schema fields (`sourceCharacterName`, `targetCharacterName`, `lastChangedEpisodeId`, `provenance`)
 * - Enforces `canonStatus: 'CANON'` and exact 16 keys required by `isValidCharacterRelationship` in `firestore.rules`.
 */
export function mapApprovedRelationship(params: {
  proposal: ChangeProposal;
  draft: ExtractedRelationshipDraftPayload;
  existingEntity: CharacterRelationship | null;
  validCharacterIds: ReadonlySet<string>;
  validTimelineEventIds: ReadonlySet<string>;
  validEpisodeIds: ReadonlySet<string>;
  nowIso: string;
  overrides?: ChangeProposalApprovalOverrides['relationshipOverride'];
}):
  | { ok: true; entity: CharacterRelationship }
  | ApprovalValidationFailure {
  const {
    proposal,
    draft,
    existingEntity,
    validCharacterIds,
    validTimelineEventIds,
    validEpisodeIds,
    nowIso,
    overrides,
  } = params;

  const sourceCharacterId = (
    existingEntity?.sourceCharacterId ||
    draft.sourceCharacterId ||
    ''
  ).trim();
  const targetCharacterId = (
    existingEntity?.targetCharacterId ||
    draft.targetCharacterId ||
    ''
  ).trim();

  if (!sourceCharacterId || !targetCharacterId) {
    return {
      ok: false,
      code: 'REFERENCE_INTEGRITY_ERROR',
      error:
        '[REFERENCE_INTEGRITY_ERROR] 인물 관계 승인에는 sourceCharacterId와 targetCharacterId가 모두 필요합니다.',
    };
  }

  if (sourceCharacterId === targetCharacterId) {
    return {
      ok: false,
      code: 'REFERENCE_INTEGRITY_ERROR',
      error:
        '[REFERENCE_INTEGRITY_ERROR] 동일 인물 간의 자기 참조 관계(sourceCharacterId === targetCharacterId)는 생성할 수 없습니다.',
    };
  }

  if (
    !validCharacterIds.has(sourceCharacterId) ||
    !validCharacterIds.has(targetCharacterId)
  ) {
    return {
      ok: false,
      code: 'REFERENCE_INTEGRITY_ERROR',
      error: `[REFERENCE_INTEGRITY_ERROR] 관계 대상 인물(${sourceCharacterId}, ${targetCharacterId}) 중 프로젝트에 존재하지 않는 인물이 포함되어 있습니다.`,
    };
  }

  const effectiveEpisodeId = (
    draft.lastChangedEpisodeId ||
    proposal.triggerEpisodeId ||
    existingEntity?.effectiveEpisodeId ||
    ''
  ).trim();

  if (!effectiveEpisodeId || !validEpisodeIds.has(effectiveEpisodeId)) {
    return {
      ok: false,
      code: 'REFERENCE_INTEGRITY_ERROR',
      error: `[REFERENCE_INTEGRITY_ERROR] 관계 변경 기준 회차(${effectiveEpisodeId})가 프로젝트에 존재하지 않습니다.`,
    };
  }

  const rawEffectiveEventId = (
    overrides?.effectiveEventId !== undefined
      ? overrides.effectiveEventId
      : existingEntity?.effectiveEventId || ''
  ).trim();

  if (rawEffectiveEventId && !validTimelineEventIds.has(rawEffectiveEventId)) {
    return {
      ok: false,
      code: 'REFERENCE_INTEGRITY_ERROR',
      error: `[REFERENCE_INTEGRITY_ERROR] 참조된 연표 사건(${rawEffectiveEventId})이 프로젝트에 존재하지 않습니다.`,
    };
  }

  const relationType = (
    overrides?.relationType ??
    draft.relationType ??
    existingEntity?.relationType ??
    ''
  )
    .trim()
    .slice(0, 120);

  const affinityScore = clampAffinityScore(
    overrides?.affinityScore ??
      draft.affinityScore ??
      existingEntity?.affinityScore ??
      0
  );

  const isDirectional =
    overrides?.isDirectional ??
    draft.isDirectional ??
    existingEntity?.isDirectional ??
    true;

  const description = (
    overrides?.description ??
    draft.description ??
    existingEntity?.description ??
    ''
  )
    .trim()
    .slice(0, 5000);

  const mapped: CharacterRelationship = {
    id: proposal.targetEntityId,
    ownerId: proposal.ownerId,
    projectId: proposal.projectId,
    sourceCharacterId,
    targetCharacterId,
    relationType,
    affinityScore,
    isDirectional,
    description,
    canonStatus: 'CANON',
    effectiveEpisodeId,
    effectiveEventId: rawEffectiveEventId,
    sourceRevisionId: proposal.sourceRevisionId,
    createdBy: existingEntity?.createdBy || 'AI_ENGINE',
    createdAt: existingEntity?.createdAt || nowIso,
    updatedAt: nowIso,
  };

  const validation = validateCharacterRelationshipInput(mapped);
  if (!validation.valid) {
    return {
      ok: false,
      code: 'PAYLOAD_INTEGRITY_ERROR',
      error: `[PAYLOAD_INTEGRITY_ERROR] 인물 관계 스키마 검증 실패: ${validation.error}`,
    };
  }

  return { ok: true, entity: mapped };
}

/**
 * Step 4.5: Explicit mapping from `ExtractedTimelineEventDraftPayload` -> `TimelineEvent`.
 * - Maps `involvedCharacterIds` -> `participantCharacterIds` (verified against `validCharacterIds`)
 * - Maps `locationWorldItemId` -> `linkedWorldbuildingIds` (verified against `validWorldbuildingIds`, preserving existing linked worldbuilding items on `UPDATE`)
 * - Preserves `linkedForeshadowingIds` on `UPDATE` (verified against `validForeshadowingIds`)
 * - Validates `episodeId` and `sceneId` against project `episodes` and `scenes`
 * - Strips non-schema fields (`involvedCharacterIds`, `involvedCharacterNames`, `locationWorldItemId`, `locationName`, `provenance`)
 * - Enforces `canonStatus: 'CANON'` and exact 16 keys required by `isValidTimelineEvent` in `firestore.rules`.
 */
export function mapApprovedTimelineEvent(params: {
  proposal: ChangeProposal;
  draft: ExtractedTimelineEventDraftPayload;
  existingEntity: TimelineEvent | null;
  validCharacterIds: ReadonlySet<string>;
  validWorldbuildingIds: ReadonlySet<string>;
  validForeshadowingIds: ReadonlySet<string>;
  validEpisodeIds: ReadonlySet<string>;
  validSceneIdsForEpisode: ReadonlySet<string>;
  nowIso: string;
  overrides?: ChangeProposalApprovalOverrides['timelineEventOverride'];
}):
  | { ok: true; entity: TimelineEvent }
  | ApprovalValidationFailure {
  const {
    proposal,
    draft,
    existingEntity,
    validCharacterIds,
    validWorldbuildingIds,
    validForeshadowingIds,
    validEpisodeIds,
    validSceneIdsForEpisode,
    nowIso,
    overrides,
  } = params;

  const episodeId = (
    draft.episodeId ||
    proposal.triggerEpisodeId ||
    existingEntity?.episodeId ||
    ''
  ).trim();

  if (!episodeId || !validEpisodeIds.has(episodeId)) {
    return {
      ok: false,
      code: 'REFERENCE_INTEGRITY_ERROR',
      error: `[REFERENCE_INTEGRITY_ERROR] 연표 사건의 기준 회차(${episodeId})가 프로젝트에 존재하지 않습니다.`,
    };
  }

  const sceneId = (
    overrides?.sceneId !== undefined
      ? overrides.sceneId
      : draft.sceneId || existingEntity?.sceneId || ''
  ).trim();

  if (sceneId && !validSceneIdsForEpisode.has(sceneId)) {
    return {
      ok: false,
      code: 'REFERENCE_INTEGRITY_ERROR',
      error: `[REFERENCE_INTEGRITY_ERROR] 연표 사건의 장면 ID(${sceneId})가 해당 회차(${episodeId})에 존재하지 않습니다.`,
    };
  }

  const rawParticipantIds =
    overrides?.participantCharacterIds ??
    draft.involvedCharacterIds ??
    existingEntity?.participantCharacterIds ??
    [];

  const participantCharacterIds: string[] = [];
  for (const charId of rawParticipantIds) {
    const trimmed = typeof charId === 'string' ? charId.trim() : '';
    if (!trimmed) continue;
    if (!validCharacterIds.has(trimmed)) {
      return {
        ok: false,
        code: 'REFERENCE_INTEGRITY_ERROR',
        error: `[REFERENCE_INTEGRITY_ERROR] 연표 사건 참여 인물(${trimmed})이 프로젝트에 존재하지 않습니다.`,
      };
    }
    if (!participantCharacterIds.includes(trimmed)) {
      participantCharacterIds.push(trimmed);
    }
  }

  // Merge & verify linkedWorldbuildingIds from locationWorldItemId + existingEntity
  const linkedWorldbuildingIds: string[] = [];
  if (overrides?.linkedWorldbuildingIds !== undefined) {
    for (const wbId of overrides.linkedWorldbuildingIds) {
      const trimmed = typeof wbId === 'string' ? wbId.trim() : '';
      if (!trimmed) continue;
      if (!validWorldbuildingIds.has(trimmed)) {
        return {
          ok: false,
          code: 'REFERENCE_INTEGRITY_ERROR',
          error: `[REFERENCE_INTEGRITY_ERROR] 연표 사건에 연결된 세계관 항목(${trimmed})이 프로젝트에 존재하지 않습니다.`,
        };
      }
      if (!linkedWorldbuildingIds.includes(trimmed)) {
        linkedWorldbuildingIds.push(trimmed);
      }
    }
  } else {
    for (const existingWbId of existingEntity?.linkedWorldbuildingIds || []) {
      const trimmed = typeof existingWbId === 'string' ? existingWbId.trim() : '';
      if (!trimmed) continue;
      if (!validWorldbuildingIds.has(trimmed)) {
        return {
          ok: false,
          code: 'REFERENCE_INTEGRITY_ERROR',
          error: `[REFERENCE_INTEGRITY_ERROR] 기존 연표 사건에 연결된 세계관 항목(${trimmed})이 프로젝트에 존재하지 않습니다.`,
        };
      }
      if (!linkedWorldbuildingIds.includes(trimmed)) {
        linkedWorldbuildingIds.push(trimmed);
      }
    }
    const locWbId = (draft.locationWorldItemId || '').trim();
    if (locWbId) {
      if (!validWorldbuildingIds.has(locWbId)) {
        return {
          ok: false,
          code: 'REFERENCE_INTEGRITY_ERROR',
          error: `[REFERENCE_INTEGRITY_ERROR] 연표 사건의 장소 세계관 ID(${locWbId})가 프로젝트에 존재하지 않습니다.`,
        };
      }
      if (!linkedWorldbuildingIds.includes(locWbId)) {
        linkedWorldbuildingIds.push(locWbId);
      }
    }
  }

  const linkedForeshadowingIds: string[] = [];
  const rawForeshadowingIds =
    overrides?.linkedForeshadowingIds ??
    existingEntity?.linkedForeshadowingIds ??
    [];
  for (const fshId of rawForeshadowingIds) {
    const trimmed = typeof fshId === 'string' ? fshId.trim() : '';
    if (!trimmed) continue;
    if (!validForeshadowingIds.has(trimmed)) {
      return {
        ok: false,
        code: 'REFERENCE_INTEGRITY_ERROR',
        error: `[REFERENCE_INTEGRITY_ERROR] 연표 사건에 연결된 복선 ID(${trimmed})가 프로젝트에 존재하지 않습니다.`,
      };
    }
    if (!linkedForeshadowingIds.includes(trimmed)) {
      linkedForeshadowingIds.push(trimmed);
    }
  }

  const title = (
    overrides?.title ??
    draft.title ??
    existingEntity?.title ??
    ''
  )
    .trim()
    .slice(0, 200);

  const summary = (
    overrides?.summary ??
    draft.summary ??
    existingEntity?.summary ??
    ''
  )
    .trim()
    .slice(0, 5000);

  const inUniverseDate = (
    overrides?.inUniverseDate ??
    draft.inUniverseDate ??
    existingEntity?.inUniverseDate ??
    '작중 시점 미상'
  )
    .trim()
    .slice(0, 200);

  const rawChrono =
    overrides?.chronologicalOrder ??
    draft.chronologicalOrder ??
    existingEntity?.chronologicalOrder ??
    1;
  const chronologicalOrder =
    typeof rawChrono === 'number' && Number.isFinite(rawChrono) && rawChrono >= 0
      ? Math.floor(rawChrono)
      : 1;

  const mapped: TimelineEvent = {
    id: proposal.targetEntityId,
    ownerId: proposal.ownerId,
    projectId: proposal.projectId,
    title,
    summary,
    inUniverseDate,
    chronologicalOrder,
    episodeId,
    sceneId,
    participantCharacterIds,
    linkedForeshadowingIds,
    linkedWorldbuildingIds,
    canonStatus: 'CANON',
    sourceRevisionId: proposal.sourceRevisionId,
    createdBy: existingEntity?.createdBy || 'AI_ENGINE',
    createdAt: existingEntity?.createdAt || nowIso,
    updatedAt: nowIso,
  };

  const validation = validateTimelineEventInput(mapped);
  if (!validation.valid) {
    return {
      ok: false,
      code: 'PAYLOAD_INTEGRITY_ERROR',
      error: `[PAYLOAD_INTEGRITY_ERROR] 연표 사건 스키마 검증 실패: ${validation.error}`,
    };
  }

  return { ok: true, entity: mapped };
}

/**
 * Step 4.6: Explicit mapping from `ExtractedForeshadowingDraftPayload` -> `Foreshadowing`.
 * - Preserves planting metadata (`plantedEpisodeId`, `plantedSceneId`) on `UPDATE` if already present
 * - Validates `plantedEpisodeId`, `resolvedEpisodeId`, `plantedSceneId`, `resolvedSceneId`, `relatedCharacterIds`, `relatedEventIds`
 * - Strips `payoffNote`, `relatedCharacterNames`, and `provenance` from the Firestore `Foreshadowing` entity
 *   while returning `payoffNote` so it is preserved in `ChangeProposalApprovalAudit`
 * - Enforces `canonStatus: 'CANON'` and exact 17 keys required by `isValidForeshadowing` in `firestore.rules`.
 */
export function mapApprovedForeshadowing(params: {
  proposal: ChangeProposal;
  draft: ExtractedForeshadowingDraftPayload;
  existingEntity: Foreshadowing | null;
  validCharacterIds: ReadonlySet<string>;
  validTimelineEventIds: ReadonlySet<string>;
  validEpisodeIds: ReadonlySet<string>;
  validSceneIdsByEpisode: ReadonlyMap<string, ReadonlySet<string>>;
  nowIso: string;
  overrides?: ChangeProposalApprovalOverrides['foreshadowingOverride'];
}):
  | { ok: true; entity: Foreshadowing; payoffNote: string }
  | ApprovalValidationFailure {
  const {
    proposal,
    draft,
    existingEntity,
    validCharacterIds,
    validTimelineEventIds,
    validEpisodeIds,
    validSceneIdsByEpisode,
    nowIso,
    overrides,
  } = params;

  const cluePhase: ForeshadowingPhase =
    overrides?.cluePhase ??
    draft.cluePhase ??
    existingEntity?.cluePhase ??
    'PLANTED';

  const plantedEpisodeId = (
    overrides?.plantedEpisodeId !== undefined
      ? overrides.plantedEpisodeId
      : existingEntity?.plantedEpisodeId ||
        draft.plantedEpisodeId ||
        proposal.triggerEpisodeId ||
        ''
  ).trim();

  if (!plantedEpisodeId || !validEpisodeIds.has(plantedEpisodeId)) {
    return {
      ok: false,
      code: 'REFERENCE_INTEGRITY_ERROR',
      error: `[REFERENCE_INTEGRITY_ERROR] 복선 심기 회차(${plantedEpisodeId})가 프로젝트에 존재하지 않습니다.`,
    };
  }

  const plantedSceneId = (
    overrides?.plantedSceneId !== undefined
      ? overrides.plantedSceneId
      : existingEntity?.plantedSceneId || draft.plantedSceneId || ''
  ).trim();

  if (plantedSceneId) {
    const scenesForPlantedEp = validSceneIdsByEpisode.get(plantedEpisodeId);
    if (!scenesForPlantedEp || !scenesForPlantedEp.has(plantedSceneId)) {
      return {
        ok: false,
        code: 'REFERENCE_INTEGRITY_ERROR',
        error: `[REFERENCE_INTEGRITY_ERROR] 복선 심기 장면(${plantedSceneId})이 회차(${plantedEpisodeId})에 존재하지 않습니다.`,
      };
    }
  }

  let resolvedEpisodeId = (
    overrides?.resolvedEpisodeId !== undefined
      ? overrides.resolvedEpisodeId
      : cluePhase === 'RESOLVED'
      ? draft.resolvedEpisodeId ||
        proposal.triggerEpisodeId ||
        existingEntity?.resolvedEpisodeId ||
        ''
      : existingEntity?.resolvedEpisodeId || draft.resolvedEpisodeId || ''
  ).trim();

  let resolvedSceneId = (
    overrides?.resolvedSceneId !== undefined
      ? overrides.resolvedSceneId
      : cluePhase === 'RESOLVED'
      ? draft.resolvedSceneId || existingEntity?.resolvedSceneId || ''
      : existingEntity?.resolvedSceneId || draft.resolvedSceneId || ''
  ).trim();

  if (cluePhase === 'RESOLVED' && !resolvedEpisodeId) {
    resolvedEpisodeId = proposal.triggerEpisodeId;
  }

  if (resolvedEpisodeId) {
    if (!validEpisodeIds.has(resolvedEpisodeId)) {
      return {
        ok: false,
        code: 'REFERENCE_INTEGRITY_ERROR',
        error: `[REFERENCE_INTEGRITY_ERROR] 복선 회수 회차(${resolvedEpisodeId})가 프로젝트에 존재하지 않습니다.`,
      };
    }
    if (resolvedSceneId) {
      const scenesForResolvedEp = validSceneIdsByEpisode.get(resolvedEpisodeId);
      if (!scenesForResolvedEp || !scenesForResolvedEp.has(resolvedSceneId)) {
        return {
          ok: false,
          code: 'REFERENCE_INTEGRITY_ERROR',
          error: `[REFERENCE_INTEGRITY_ERROR] 복선 회수 장면(${resolvedSceneId})이 회차(${resolvedEpisodeId})에 존재하지 않습니다.`,
        };
      }
    }
  } else {
    resolvedSceneId = '';
  }

  const rawRelatedCharacterIds =
    overrides?.relatedCharacterIds ??
    draft.relatedCharacterIds ??
    existingEntity?.relatedCharacterIds ??
    [];
  const relatedCharacterIds: string[] = [];
  for (const charId of rawRelatedCharacterIds) {
    const trimmed = typeof charId === 'string' ? charId.trim() : '';
    if (!trimmed) continue;
    if (!validCharacterIds.has(trimmed)) {
      return {
        ok: false,
        code: 'REFERENCE_INTEGRITY_ERROR',
        error: `[REFERENCE_INTEGRITY_ERROR] 복선 연관 인물(${trimmed})이 프로젝트에 존재하지 않습니다.`,
      };
    }
    if (!relatedCharacterIds.includes(trimmed)) {
      relatedCharacterIds.push(trimmed);
    }
  }

  const rawRelatedEventIds =
    overrides?.relatedEventIds ??
    draft.relatedEventIds ??
    existingEntity?.relatedEventIds ??
    [];
  const relatedEventIds: string[] = [];
  for (const evtId of rawRelatedEventIds) {
    const trimmed = typeof evtId === 'string' ? evtId.trim() : '';
    if (!trimmed) continue;
    if (!validTimelineEventIds.has(trimmed)) {
      return {
        ok: false,
        code: 'REFERENCE_INTEGRITY_ERROR',
        error: `[REFERENCE_INTEGRITY_ERROR] 복선 연관 연표 사건(${trimmed})이 프로젝트에 존재하지 않습니다.`,
      };
    }
    if (!relatedEventIds.includes(trimmed)) {
      relatedEventIds.push(trimmed);
    }
  }

  const title = (
    overrides?.title ??
    draft.title ??
    existingEntity?.title ??
    ''
  )
    .trim()
    .slice(0, 200);

  const description = (
    overrides?.description ??
    draft.description ??
    existingEntity?.description ??
    ''
  )
    .trim()
    .slice(0, 5000);

  const payoffNote = (
    overrides?.payoffNote ??
    draft.payoffNote ??
    ''
  )
    .trim()
    .slice(0, 3000);

  const mapped: Foreshadowing = {
    id: proposal.targetEntityId,
    ownerId: proposal.ownerId,
    projectId: proposal.projectId,
    title,
    description,
    cluePhase,
    canonStatus: 'CANON',
    plantedEpisodeId,
    plantedSceneId,
    resolvedEpisodeId,
    resolvedSceneId,
    relatedEventIds,
    relatedCharacterIds,
    sourceRevisionId: proposal.sourceRevisionId,
    createdBy: existingEntity?.createdBy || 'AI_ENGINE',
    createdAt: existingEntity?.createdAt || nowIso,
    updatedAt: nowIso,
  };

  const validation = validateForeshadowingInput(mapped);
  if (!validation.valid) {
    return {
      ok: false,
      code: 'PAYLOAD_INTEGRITY_ERROR',
      error: `[PAYLOAD_INTEGRITY_ERROR] 복선 스키마 검증 실패: ${validation.error}`,
    };
  }

  return { ok: true, entity: mapped, payoffNote };
}

/**
 * Step 4.7: Builds the deterministic `ChangeProposalApprovalAudit` record.
 */
export function buildApprovalAuditRecord(params: {
  proposal: ChangeProposal;
  envelope: ChangeProposalPayloadEnvelope;
  decision: 'APPROVED' | 'REJECTED';
  reviewerUid: string;
  reviewNote?: string;
  beforeEntity: AppliedCanonEntity | null;
  afterEntity: AppliedCanonEntity | null;
  payoffNote?: string;
  ragSyncStatus: ApprovalRagSyncStatus;
  ragSyncError?: string;
  nowIso: string;
}): ChangeProposalApprovalAudit {
  const {
    proposal,
    envelope,
    decision,
    reviewerUid,
    reviewNote = '',
    beforeEntity,
    afterEntity,
    payoffNote = '',
    ragSyncStatus,
    ragSyncError = '',
    nowIso,
  } = params;

  const auditId = computeDeterministicApprovalAuditId(proposal.id, decision);
  const afterCanonStatus: CanonStatus =
    decision === 'APPROVED' ? 'CANON' : 'REJECTED';

  return {
    id: auditId,
    ownerId: proposal.ownerId,
    projectId: proposal.projectId,
    proposalId: proposal.id,
    decision,
    targetEntityType: proposal.targetEntityType as ApprovalTargetEntityType,
    targetEntityId: proposal.targetEntityId,
    proposedAction: proposal.proposedAction as ApprovalActionType,
    triggerEpisodeId: proposal.triggerEpisodeId,
    sourceRevisionId: proposal.sourceRevisionId,
    sourceSceneId: envelope.sourceSceneId || '',
    proposalFingerprint: envelope.fingerprint,
    reviewerUid,
    reviewNote: reviewNote.trim().slice(0, 2000),
    beforeCanonStatus: proposal.canonStatus,
    afterCanonStatus,
    beforeSnapshotJson: JSON.stringify(beforeEntity ?? null),
    afterSnapshotJson: JSON.stringify(afterEntity ?? null),
    verifiedExcerptJson: JSON.stringify(envelope.verifiedExcerpt),
    payoffNote: payoffNote.trim().slice(0, 3000),
    ragSyncStatus,
    ragSyncError: ragSyncError.trim().slice(0, 1000),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Deterministic RAG Sync Task ID for an approved ChangeProposal.
 */
export function computeDeterministicRagSyncTaskId(proposalId: string): string {
  const clean = (proposalId || '').trim();
  const safeSlug = clean
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/^_+/, '')
    .slice(0, 56);
  const hash16 = sha256HexSync(`PHASE_4_2_2_RAG_TASK_V1:${clean}`).slice(
    0,
    16
  );
  return `rag_task_${safeSlug || 'prop'}_${hash16}`;
}

/**
 * Builds a preview candidate of the target entity (`CharacterRelationship | TimelineEvent | Foreshadowing`)
 * even when reference checks or conflict checks fail, so the Author Approval Workspace can render a full
 * before/after field diff alongside any `STALE_TARGET` or `CONFLICT_REQUIRES_REVIEW` banner.
 */
export function buildPreviewTargetEntityCandidate(params: {
  proposal: ChangeProposal;
  envelope?: ChangeProposalPayloadEnvelope;
  existingEntity: AppliedCanonEntity | null;
  nowIso: string;
  overrides?: ChangeProposalApprovalOverrides;
}): {
  ok: boolean;
  targetEntityId: string;
  afterEntity: AppliedCanonEntity | null;
  afterEntityPreview: AppliedCanonEntity | null;
  payoffNote: string;
  verifiedExcerpt: ChangeProposalPayloadEnvelope['verifiedExcerpt'] | null;
  errorCode: ApprovalConflictCode | null;
  errorMessage: string | null;
  conflictDetails: ApprovalConflictDetails | null;
} {
  const { proposal, existingEntity, nowIso, overrides } = params;

  let resolvedEnvelope = params.envelope;
  let errorCode: ApprovalConflictCode | null = null;
  let errorMessage: string | null = null;
  let conflictDetails: ApprovalConflictDetails | null = null;

  if (!resolvedEnvelope) {
    const envCheck = verifyProposalEnvelopeIntegrity(proposal);
    if (!envCheck.ok) {
      return {
        ok: false,
        targetEntityId: proposal.targetEntityId || '',
        afterEntity: null,
        afterEntityPreview: null,
        payoffNote: '',
        verifiedExcerpt: null,
        errorCode: envCheck.code,
        errorMessage: envCheck.error,
        conflictDetails: envCheck.conflictDetails || null,
      };
    }
    resolvedEnvelope = envCheck.envelope;
  }

  const conflictCheck = detectTargetEntityStaleOrConflict({
    envelope: resolvedEnvelope,
    currentEntity: existingEntity,
    expectedOwnerId: proposal.ownerId,
    expectedProjectId: proposal.projectId,
  });
  if (!conflictCheck.ok) {
    errorCode = conflictCheck.code;
    errorMessage = conflictCheck.error;
    conflictDetails = conflictCheck.conflictDetails || null;
  }

  const envelope = resolvedEnvelope;
  const targetEntityId =
    envelope.targetEntityId || proposal.targetEntityId || '';

  if (
    envelope.targetEntityType === 'RELATIONSHIP' &&
    envelope.relationshipDraft
  ) {
    const draft = envelope.relationshipDraft;
    const cur = (existingEntity as CharacterRelationship) || null;
    const ov = overrides?.relationshipOverride;
    const preview: CharacterRelationship = {
      id: targetEntityId,
      ownerId: proposal.ownerId,
      projectId: proposal.projectId,
      sourceCharacterId: (
        cur?.sourceCharacterId ||
        draft.sourceCharacterId ||
        ''
      ).trim(),
      targetCharacterId: (
        cur?.targetCharacterId ||
        draft.targetCharacterId ||
        ''
      ).trim(),
      relationType: (
        ov?.relationType ??
        draft.relationType ??
        cur?.relationType ??
        ''
      )
        .trim()
        .slice(0, 120),
      affinityScore: clampAffinityScore(
        ov?.affinityScore ?? draft.affinityScore ?? cur?.affinityScore ?? 0
      ),
      isDirectional:
        ov?.isDirectional ?? draft.isDirectional ?? cur?.isDirectional ?? true,
      description: (
        ov?.description ??
        draft.description ??
        cur?.description ??
        ''
      )
        .trim()
        .slice(0, 5000),
      canonStatus: 'CANON',
      effectiveEpisodeId: (
        draft.lastChangedEpisodeId ||
        proposal.triggerEpisodeId ||
        cur?.effectiveEpisodeId ||
        ''
      ).trim(),
      effectiveEventId: (
        ov?.effectiveEventId !== undefined
          ? ov.effectiveEventId
          : cur?.effectiveEventId || ''
      ).trim(),
      sourceRevisionId: proposal.sourceRevisionId,
      createdBy: cur?.createdBy || 'AI_ENGINE',
      createdAt: cur?.createdAt || nowIso,
      updatedAt: nowIso,
    };
    return {
      ok: errorCode === null,
      targetEntityId,
      afterEntity: preview,
      afterEntityPreview: preview,
      payoffNote: '',
      verifiedExcerpt: envelope.verifiedExcerpt || null,
      errorCode,
      errorMessage,
      conflictDetails,
    };
  }

  if (
    envelope.targetEntityType === 'TIMELINE_EVENT' &&
    envelope.timelineEventDraft
  ) {
    const draft = envelope.timelineEventDraft;
    const cur = (existingEntity as TimelineEvent) || null;
    const ov = overrides?.timelineEventOverride;
    const mergedWb = new Set<string>(cur?.linkedWorldbuildingIds || []);
    if (draft.locationWorldItemId?.trim()) {
      mergedWb.add(draft.locationWorldItemId.trim());
    }
    const preview: TimelineEvent = {
      id: targetEntityId,
      ownerId: proposal.ownerId,
      projectId: proposal.projectId,
      title: (ov?.title ?? draft.title ?? cur?.title ?? '').trim().slice(0, 200),
      summary: (ov?.summary ?? draft.summary ?? cur?.summary ?? '')
        .trim()
        .slice(0, 5000),
      inUniverseDate: (
        ov?.inUniverseDate ??
        draft.inUniverseDate ??
        cur?.inUniverseDate ??
        '작중 시점 미상'
      )
        .trim()
        .slice(0, 200),
      chronologicalOrder: Math.max(
        0,
        Math.floor(
          ov?.chronologicalOrder ??
            draft.chronologicalOrder ??
            cur?.chronologicalOrder ??
            1
        )
      ),
      episodeId: (
        draft.episodeId ||
        proposal.triggerEpisodeId ||
        cur?.episodeId ||
        ''
      ).trim(),
      sceneId: (
        ov?.sceneId !== undefined
          ? ov.sceneId
          : draft.sceneId || cur?.sceneId || ''
      ).trim(),
      participantCharacterIds: Array.from(
        new Set(
          (
            ov?.participantCharacterIds ??
            draft.involvedCharacterIds ??
            cur?.participantCharacterIds ??
            []
          )
            .map((s) => (typeof s === 'string' ? s.trim() : ''))
            .filter(Boolean)
        )
      ),
      linkedForeshadowingIds: Array.from(
        new Set(
          (
            ov?.linkedForeshadowingIds ??
            cur?.linkedForeshadowingIds ??
            []
          )
            .map((s) => (typeof s === 'string' ? s.trim() : ''))
            .filter(Boolean)
        )
      ),
      linkedWorldbuildingIds:
        ov?.linkedWorldbuildingIds !== undefined
          ? Array.from(
              new Set(
                ov.linkedWorldbuildingIds
                  .map((s) => (typeof s === 'string' ? s.trim() : ''))
                  .filter(Boolean)
              )
            )
          : Array.from(mergedWb),
      canonStatus: 'CANON',
      sourceRevisionId: proposal.sourceRevisionId,
      createdBy: cur?.createdBy || 'AI_ENGINE',
      createdAt: cur?.createdAt || nowIso,
      updatedAt: nowIso,
    };
    return {
      ok: errorCode === null,
      targetEntityId,
      afterEntity: preview,
      afterEntityPreview: preview,
      payoffNote: '',
      verifiedExcerpt: envelope.verifiedExcerpt || null,
      errorCode,
      errorMessage,
      conflictDetails,
    };
  }

  if (
    envelope.targetEntityType === 'FORESHADOWING' &&
    envelope.foreshadowingDraft
  ) {
    const draft = envelope.foreshadowingDraft;
    const cur = (existingEntity as Foreshadowing) || null;
    const ov = overrides?.foreshadowingOverride;
    const cluePhase: ForeshadowingPhase =
      ov?.cluePhase ?? draft.cluePhase ?? cur?.cluePhase ?? 'PLANTED';
    const plantedEpisodeId = (
      ov?.plantedEpisodeId !== undefined
        ? ov.plantedEpisodeId
        : cur?.plantedEpisodeId ||
          draft.plantedEpisodeId ||
          proposal.triggerEpisodeId ||
          ''
    ).trim();
    const plantedSceneId = (
      ov?.plantedSceneId !== undefined
        ? ov.plantedSceneId
        : cur?.plantedSceneId || draft.plantedSceneId || ''
    ).trim();
    let resolvedEpisodeId = (
      ov?.resolvedEpisodeId !== undefined
        ? ov.resolvedEpisodeId
        : cluePhase === 'RESOLVED'
        ? draft.resolvedEpisodeId ||
          proposal.triggerEpisodeId ||
          cur?.resolvedEpisodeId ||
          ''
        : cur?.resolvedEpisodeId || draft.resolvedEpisodeId || ''
    ).trim();
    if (cluePhase === 'RESOLVED' && !resolvedEpisodeId) {
      resolvedEpisodeId = proposal.triggerEpisodeId;
    }
    const resolvedSceneId = resolvedEpisodeId
      ? (
          ov?.resolvedSceneId !== undefined
            ? ov.resolvedSceneId
            : cluePhase === 'RESOLVED'
            ? draft.resolvedSceneId || cur?.resolvedSceneId || ''
            : cur?.resolvedSceneId || draft.resolvedSceneId || ''
        ).trim()
      : '';
    const payoffNote = (ov?.payoffNote ?? draft.payoffNote ?? '')
      .trim()
      .slice(0, 3000);

    const preview: Foreshadowing = {
      id: targetEntityId,
      ownerId: proposal.ownerId,
      projectId: proposal.projectId,
      title: (ov?.title ?? draft.title ?? cur?.title ?? '').trim().slice(0, 200),
      description: (
        ov?.description ??
        draft.description ??
        cur?.description ??
        ''
      )
        .trim()
        .slice(0, 5000),
      cluePhase,
      canonStatus: 'CANON',
      plantedEpisodeId,
      plantedSceneId,
      resolvedEpisodeId,
      resolvedSceneId,
      relatedEventIds: Array.from(
        new Set(
          (ov?.relatedEventIds ?? draft.relatedEventIds ?? cur?.relatedEventIds ?? [])
            .map((s) => (typeof s === 'string' ? s.trim() : ''))
            .filter(Boolean)
        )
      ),
      relatedCharacterIds: Array.from(
        new Set(
          (
            ov?.relatedCharacterIds ??
            draft.relatedCharacterIds ??
            cur?.relatedCharacterIds ??
            []
          )
            .map((s) => (typeof s === 'string' ? s.trim() : ''))
            .filter(Boolean)
        )
      ),
      sourceRevisionId: proposal.sourceRevisionId,
      createdBy: cur?.createdBy || 'AI_ENGINE',
      createdAt: cur?.createdAt || nowIso,
      updatedAt: nowIso,
    };
    return {
      ok: errorCode === null,
      targetEntityId,
      afterEntity: preview,
      afterEntityPreview: preview,
      payoffNote,
      verifiedExcerpt: envelope.verifiedExcerpt || null,
      errorCode,
      errorMessage,
      conflictDetails,
    };
  }

  return {
    ok: false,
    targetEntityId,
    afterEntity: null,
    afterEntityPreview: null,
    payoffNote: '',
    verifiedExcerpt: envelope.verifiedExcerpt || null,
    errorCode: errorCode || 'PAYLOAD_INTEGRITY_ERROR',
    errorMessage:
      errorMessage || '제안서 페이로드 초안 데이터가 누락되었습니다.',
    conflictDetails,
  };
}

function formatDiffScalarOrListDisplay(
  value: string | number | boolean | string[] | null,
  fieldName: string,
  entityDisplayNameMap?: Readonly<Record<string, string>>
): string {
  if (value === null || value === undefined) {
    return '(없음 / 신규 생성)';
  }
  if (typeof value === 'boolean') {
    if (fieldName === 'isDirectional') {
      return value ? '단방향 (A → B)' : '양방향 (A ↔ B)';
    }
    return value ? '예 (true)' : '아니오 (false)';
  }
  if (typeof value === 'number') {
    if (fieldName === 'affinityScore') {
      return value > 0 ? `+${value}` : `${value}`;
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '(연결 없음)';
    return value
      .map((id) => {
        const label = entityDisplayNameMap?.[id];
        return label ? `${label} (${id})` : id;
      })
      .join(', ');
  }
  const str = String(value).trim();
  if (!str) return '(비어 있음)';
  const mappedLabel = entityDisplayNameMap?.[str];
  if (
    mappedLabel &&
    (fieldName.endsWith('Id') ||
      fieldName === 'sourceCharacterId' ||
      fieldName === 'targetCharacterId')
  ) {
    return `${mappedLabel} (${str})`;
  }
  return str;
}

function areDiffValuesEqual(
  beforeVal: string | number | boolean | string[] | null,
  afterVal: string | number | boolean | string[] | null
): boolean {
  if (beforeVal === null && afterVal === null) return true;
  if (beforeVal === null || afterVal === null) return false;
  if (Array.isArray(beforeVal) && Array.isArray(afterVal)) {
    return areIdSetsEqual(beforeVal, afterVal);
  }
  return beforeVal === afterVal;
}

/**
 * Phase 4.2.2 Stage 2 Section 6:
 * Pure function that computes structured field-by-field Before/After Diff items
 * for `RELATIONSHIP`, `TIMELINE_EVENT`, and `FORESHADOWING` (`CREATE` and `UPDATE`).
 */
export function buildChangeProposalFieldDiff(params: {
  targetEntityType: ApprovalTargetEntityType;
  proposedAction: ApprovalActionType;
  beforeEntity: AppliedCanonEntity | null;
  afterEntity: AppliedCanonEntity | null;
  payoffNote?: string;
  conflictDetails?: ApprovalConflictDetails | null;
  conflictCode?: ApprovalConflictCode | null;
  entityDisplayNameMap?: Readonly<Record<string, string>>;
}): ChangeProposalFieldDiff[] {
  const {
    targetEntityType,
    proposedAction,
    beforeEntity,
    afterEntity,
    payoffNote = '',
    conflictDetails,
    conflictCode,
    entityDisplayNameMap,
  } = params;

  if (!afterEntity) return [];

  const isCreate = proposedAction === 'CREATE' || beforeEntity === null;
  const conflictFieldsSet = new Set<string>(
    conflictDetails?.changedFields || []
  );

  const makeItem = (
    fieldName: string,
    fieldLabel: string,
    beforeValue: string | number | boolean | string[] | null,
    afterValue: string | number | boolean | string[] | null,
    customConflictReason?: string
  ): ChangeProposalFieldDiff => {
    const resolvedBefore = isCreate ? null : beforeValue;
    const changeType: ChangeProposalFieldChangeType = isCreate
      ? 'ADDED'
      : areDiffValuesEqual(resolvedBefore, afterValue)
      ? 'UNCHANGED'
      : 'MODIFIED';
    const isFieldConflict =
      Boolean(customConflictReason) || conflictFieldsSet.has(fieldName);
    const revSuffix = conflictDetails?.currentEntitySourceRevisionId
      ? ` (현재 리비전: ${conflictDetails.currentEntitySourceRevisionId})`
      : '';
    const conflictReason =
      customConflictReason ||
      (conflictFieldsSet.has(fieldName)
        ? conflictCode === 'STALE_TARGET' ||
          conflictDetails?.currentEntitySourceRevisionId
          ? `추출 시점 이후 원본 엔티티의 해당 필드가 변경되었습니다 (STALE_TARGET)${revSuffix}.`
          : `기존 CANON 설정과 충돌이 감지되었습니다 (CONFLICT_REQUIRES_REVIEW)${revSuffix}.`
        : undefined);

    const beforeDisplayText = formatDiffScalarOrListDisplay(
      resolvedBefore,
      fieldName,
      entityDisplayNameMap
    );
    const afterDisplayText = formatDiffScalarOrListDisplay(
      afterValue,
      fieldName,
      entityDisplayNameMap
    );

    return {
      fieldName,
      fieldKey: fieldName,
      fieldLabel,
      label: fieldLabel,
      beforeValue: resolvedBefore === null ? null : beforeDisplayText,
      afterValue: afterValue === null ? null : afterDisplayText,
      beforeDisplayText,
      afterDisplayText,
      changeType,
      isConflict: isFieldConflict,
      conflict: isFieldConflict,
      conflictReason,
    };
  };

  if (targetEntityType === 'RELATIONSHIP') {
    const beforeRel = (beforeEntity as CharacterRelationship | null) ?? null;
    const afterRel = afterEntity as CharacterRelationship;

    return [
      makeItem(
        'sourceCharacterId',
        '인물 A (주체)',
        beforeRel ? beforeRel.sourceCharacterId : null,
        afterRel.sourceCharacterId
      ),
      makeItem(
        'targetCharacterId',
        '인물 B (대상)',
        beforeRel ? beforeRel.targetCharacterId : null,
        afterRel.targetCharacterId
      ),
      makeItem(
        'relationType',
        '관계 유형',
        beforeRel ? beforeRel.relationType : null,
        afterRel.relationType
      ),
      makeItem(
        'affinityScore',
        '친밀도 (-100 ~ +100)',
        beforeRel ? beforeRel.affinityScore : null,
        afterRel.affinityScore
      ),
      makeItem(
        'isDirectional',
        '방향성 (단방향/양방향)',
        beforeRel ? beforeRel.isDirectional : null,
        afterRel.isDirectional
      ),
      makeItem(
        'description',
        '관계 설명',
        beforeRel ? beforeRel.description : null,
        afterRel.description
      ),
      makeItem(
        'effectiveEpisodeId',
        '변경 기준 회차',
        beforeRel ? beforeRel.effectiveEpisodeId : null,
        afterRel.effectiveEpisodeId
      ),
      makeItem(
        'effectiveEventId',
        '연결 연표 사건',
        beforeRel ? beforeRel.effectiveEventId : null,
        afterRel.effectiveEventId
      ),
      makeItem(
        'canonStatus',
        'CANON 상태',
        beforeRel ? beforeRel.canonStatus : null,
        afterRel.canonStatus
      ),
      makeItem(
        'sourceRevisionId',
        '근거 리비전 ID',
        beforeRel ? beforeRel.sourceRevisionId : null,
        afterRel.sourceRevisionId
      ),
    ];
  }

  if (targetEntityType === 'TIMELINE_EVENT') {
    const beforeEvt = (beforeEntity as TimelineEvent | null) ?? null;
    const afterEvt = afterEntity as TimelineEvent;

    return [
      makeItem(
        'title',
        '사건 제목',
        beforeEvt ? beforeEvt.title : null,
        afterEvt.title
      ),
      makeItem(
        'summary',
        '사건 요약',
        beforeEvt ? beforeEvt.summary : null,
        afterEvt.summary
      ),
      makeItem(
        'inUniverseDate',
        '작중 시점',
        beforeEvt ? beforeEvt.inUniverseDate : null,
        afterEvt.inUniverseDate
      ),
      makeItem(
        'chronologicalOrder',
        '연표 순서',
        beforeEvt ? beforeEvt.chronologicalOrder : null,
        afterEvt.chronologicalOrder
      ),
      makeItem(
        'episodeId',
        '발생 회차',
        beforeEvt ? beforeEvt.episodeId : null,
        afterEvt.episodeId
      ),
      makeItem(
        'sceneId',
        '발생 장면',
        beforeEvt ? beforeEvt.sceneId : null,
        afterEvt.sceneId
      ),
      makeItem(
        'participantCharacterIds',
        '참여 인물 목록',
        beforeEvt ? beforeEvt.participantCharacterIds : null,
        afterEvt.participantCharacterIds
      ),
      makeItem(
        'linkedWorldbuildingIds',
        '연결 세계관 항목',
        beforeEvt ? beforeEvt.linkedWorldbuildingIds : null,
        afterEvt.linkedWorldbuildingIds
      ),
      makeItem(
        'linkedForeshadowingIds',
        '연결 복선 항목',
        beforeEvt ? beforeEvt.linkedForeshadowingIds : null,
        afterEvt.linkedForeshadowingIds
      ),
      makeItem(
        'canonStatus',
        'CANON 상태',
        beforeEvt ? beforeEvt.canonStatus : null,
        afterEvt.canonStatus
      ),
      makeItem(
        'sourceRevisionId',
        '근거 리비전 ID',
        beforeEvt ? beforeEvt.sourceRevisionId : null,
        afterEvt.sourceRevisionId
      ),
    ];
  }

  // FORESHADOWING
  const beforeFsh = (beforeEntity as Foreshadowing | null) ?? null;
  const afterFsh = afterEntity as Foreshadowing;

  let cluePhaseConflictReason: string | undefined;
  if (beforeFsh) {
    if (beforeFsh.cluePhase === 'ABANDONED') {
      cluePhaseConflictReason =
        '이미 폐기(ABANDONED)된 복선은 자동 UPDATE 승인이 차단됩니다.';
    } else {
      const curRank = FORESHADOWING_PHASE_RANK[beforeFsh.cluePhase] ?? 1;
      const nextRank = FORESHADOWING_PHASE_RANK[afterFsh.cluePhase] ?? 1;
      if (nextRank < curRank) {
        cluePhaseConflictReason = `복선 단계 역행 충돌(${beforeFsh.cluePhase} → ${afterFsh.cluePhase})이 감지되었습니다.`;
      }
    }
  }

  const items: ChangeProposalFieldDiff[] = [
    makeItem(
      'title',
      '복선 제목',
      beforeFsh ? beforeFsh.title : null,
      afterFsh.title
    ),
    makeItem(
      'description',
      '복선 설명',
      beforeFsh ? beforeFsh.description : null,
      afterFsh.description
    ),
    makeItem(
      'cluePhase',
      '복선 단계 (PLANTED/REINFORCED/RESOLVED/ABANDONED)',
      beforeFsh ? beforeFsh.cluePhase : null,
      afterFsh.cluePhase,
      cluePhaseConflictReason
    ),
    makeItem(
      'plantedEpisodeId',
      '심기 회차',
      beforeFsh ? beforeFsh.plantedEpisodeId : null,
      afterFsh.plantedEpisodeId
    ),
    makeItem(
      'plantedSceneId',
      '심기 장면',
      beforeFsh ? beforeFsh.plantedSceneId : null,
      afterFsh.plantedSceneId
    ),
    makeItem(
      'resolvedEpisodeId',
      '회수 회차',
      beforeFsh ? beforeFsh.resolvedEpisodeId : null,
      afterFsh.resolvedEpisodeId
    ),
    makeItem(
      'resolvedSceneId',
      '회수 장면',
      beforeFsh ? beforeFsh.resolvedSceneId : null,
      afterFsh.resolvedSceneId
    ),
    makeItem(
      'relatedCharacterIds',
      '연관 인물 목록',
      beforeFsh ? beforeFsh.relatedCharacterIds : null,
      afterFsh.relatedCharacterIds
    ),
    makeItem(
      'relatedEventIds',
      '연관 연표 사건 목록',
      beforeFsh ? beforeFsh.relatedEventIds : null,
      afterFsh.relatedEventIds
    ),
    makeItem(
      'payoffNote',
      '회수 설명 (감사 이력 기록용 · 엔티티 본문 미포함)',
      isCreate ? null : '',
      payoffNote || '(없음)'
    ),
    makeItem(
      'canonStatus',
      'CANON 상태',
      beforeFsh ? beforeFsh.canonStatus : null,
      afterFsh.canonStatus
    ),
    makeItem(
      'sourceRevisionId',
      '근거 리비전 ID',
      beforeFsh ? beforeFsh.sourceRevisionId : null,
      afterFsh.sourceRevisionId
    ),
  ];

  return items;
}

/**
 * Phase 4.2.2 Stage 2.5 Section 7:
 * Computes a deterministic content hash over an approved CANON entity's authoritative fields
 * (excluding transient timestamps when comparing content, while also capturing sourceRevisionId).
 */
export function computeEntityCanonicalContentHash(
  entity: AppliedCanonEntity
): string {
  const rec = entity as unknown as Record<string, unknown>;
  const sortedKeys = Object.keys(rec)
    .filter((k) => k !== 'createdAt' && k !== 'updatedAt')
    .sort();
  const normalized: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const val = rec[key];
    if (Array.isArray(val)) {
      normalized[key] = [...val].map((x) => String(x).trim()).sort();
    } else {
      normalized[key] = val;
    }
  }
  return sha256HexSync(
    `PHASE_4_2_2_ENTITY_HASH_V1:${JSON.stringify(normalized)}`
  ).slice(0, 32);
}

/**
 * Phase 4.2.2 Stage 2.5 Section 6:
 * Verifies inside a Firestore transaction that the worker attempting to commit `SYNCED`, `FAILED`,
 * `SUPERSEDED`, or a lease renewal still holds the exact active lease generation and ownership.
 */
export function verifyRagTaskLeaseFencing(params: {
  currentTask: RagSyncTaskRecord | null | undefined;
  leasedTask: RagSyncTaskRecord;
}):
  | { ok: true }
  | {
      ok: false;
      reason: 'TASK_NOT_FOUND' | 'LEASE_LOST' | 'STALE_WORKER_RESULT';
      message: string;
    } {
  const { currentTask, leasedTask } = params;
  if (!currentTask) {
    return {
      ok: false,
      reason: 'TASK_NOT_FOUND',
      message: `RAG 작업 문서(${leasedTask.id})가 존재하지 않습니다.`,
    };
  }

  if (
    currentTask.leaseOwner !== leasedTask.leaseOwner ||
    currentTask.leaseGeneration !== leasedTask.leaseGeneration ||
    currentTask.attemptCount !== leasedTask.attemptCount
  ) {
    return {
      ok: false,
      reason: 'LEASE_LOST',
      message: `작업(${leasedTask.id})의 lease 소유권 또는 세대 번호가 변경되었습니다 (예상: owner=${leasedTask.leaseOwner}, gen=${leasedTask.leaseGeneration}, attempt=${leasedTask.attemptCount} / 현재: owner=${currentTask.leaseOwner}, gen=${currentTask.leaseGeneration}, attempt=${currentTask.attemptCount}). 지연 워커의 상태 덮어쓰기가 차단되었습니다.`,
    };
  }

  if (currentTask.status !== 'PROCESSING') {
    return {
      ok: false,
      reason: 'STALE_WORKER_RESULT',
      message: `작업(${leasedTask.id})의 현재 상태가 PROCESSING이 아닙니다 (현재: ${currentTask.status}). 이전 워커(${leasedTask.leaseOwner})의 지연 결과 반영이 차단되었습니다.`,
    };
  }

  if (
    currentTask.targetEntityId !== leasedTask.targetEntityId ||
    currentTask.targetEntityType !== leasedTask.targetEntityType
  ) {
    return {
      ok: false,
      reason: 'STALE_WORKER_RESULT',
      message: `작업(${leasedTask.id})의 대상 엔티티 식별자가 일치하지 않아 상태 반영이 차단되었습니다.`,
    };
  }

  return { ok: true };
}

/**
 * Phase 4.2.2 Stage 2.5 Section 7:
 * Verifies before indexing and before activating/committing `SYNCED` that the authoritative Firestore
 * entity still exists, is `CANON`, and has NOT been superseded by a newer `CANON` approval or manual edit.
 */
export function verifyCanonEntityFreshnessForRag(params: {
  task: RagSyncTaskRecord;
  authoritativeEntity: AppliedCanonEntity | null | undefined;
}):
  | { ok: true; currentContentHash: string }
  | {
      ok: false;
      reason:
        | 'ENTITY_NOT_FOUND'
        | 'ENTITY_NOT_CANON'
        | 'SUPERSEDED_BY_NEWER_CANON';
      message: string;
    } {
  const { task, authoritativeEntity } = params;
  if (!authoritativeEntity) {
    return {
      ok: false,
      reason: 'ENTITY_NOT_FOUND',
      message: `대상 엔티티(${task.targetEntityId})가 존재하지 않거나 삭제되었습니다.`,
    };
  }

  if (authoritativeEntity.canonStatus !== 'CANON') {
    return {
      ok: false,
      reason: 'ENTITY_NOT_CANON',
      message: `대상 엔티티(${task.targetEntityId})의 현재 상태가 CANON이 아닙니다 (현재: ${authoritativeEntity.canonStatus}).`,
    };
  }

  const currentContentHash =
    computeEntityCanonicalContentHash(authoritativeEntity);

  const expectedRev = (
    task.expectedSourceRevisionId ||
    task.sourceRevisionId ||
    ''
  ).trim();
  if (
    expectedRev &&
    authoritativeEntity.sourceRevisionId &&
    authoritativeEntity.sourceRevisionId !== expectedRev
  ) {
    return {
      ok: false,
      reason: 'SUPERSEDED_BY_NEWER_CANON',
      message: `대상 엔티티(${task.targetEntityId})가 더 최신 리비전(${authoritativeEntity.sourceRevisionId} !== 작업 기준 ${expectedRev})으로 갱신되어 이전 RAG 작업(${task.id})은 SUPERSEDED 처리되었습니다.`,
    };
  }

  if (
    task.expectedEntityUpdatedAt &&
    authoritativeEntity.updatedAt &&
    authoritativeEntity.updatedAt > task.expectedEntityUpdatedAt
  ) {
    return {
      ok: false,
      reason: 'SUPERSEDED_BY_NEWER_CANON',
      message: `대상 엔티티(${task.targetEntityId})의 수정 시각(${authoritativeEntity.updatedAt})이 작업 생성 기준 시각(${task.expectedEntityUpdatedAt})보다 최신이어서 구버전 색인 덮어쓰기가 차단되었습니다.`,
    };
  }

  if (
    task.expectedContentHash &&
    task.expectedContentHash !== currentContentHash
  ) {
    return {
      ok: false,
      reason: 'SUPERSEDED_BY_NEWER_CANON',
      message: `대상 엔티티(${task.targetEntityId})의 본문 해시(${currentContentHash})가 승인 시점 해시(${task.expectedContentHash})와 달라 구버전 색인 덮어쓰기가 차단되었습니다.`,
    };
  }

  return { ok: true, currentContentHash };
}

/**
 * Phase 4.2.2 Stage 2.5 Section 8:
 * Evaluates whether a `RagSyncTaskRecord` can acquire a lease right now, strictly enforcing:
 * - Active unexpired lease protection (`LEASE_ACTIVE`)
 * - Terminal state protection (`ALREADY_SYNCED`, `SUPERSEDED`)
 * - Exponential backoff cooldown (`BACKOFF_WAITING` when `nowMs < task.nextRetryAfterMs`)
 *   Note: Passing `proposalId` or `auditId` NEVER bypasses `nextRetryAfterMs` or `maxAttempts`!
 * - Attempt count ceiling (`MAX_ATTEMPTS_EXCEEDED` when `attemptCount >= maxAttempts`)
 *   Even with `forceRetry` or `manualRetry`, enforces backoff cooldown and a hard safety ceiling
 *   so `forceRetry` can never be used as an unbounded cost/attempt bypass.
 */
export function evaluateRagSyncRetryPolicy(params: {
  task: RagSyncTaskRecord;
  nowMs: number;
  workerId: string;
  forceRetry?: boolean;
  manualRetry?: boolean;
}):
  | { allowed: true; incrementManualRetry: boolean }
  | {
      allowed: false;
      reason:
        | 'ALREADY_SYNCED'
        | 'SUPERSEDED'
        | 'LEASE_ACTIVE'
        | 'BACKOFF_WAITING'
        | 'MAX_ATTEMPTS_EXCEEDED';
      retryAfterMs?: number;
      message: string;
    } {
  const { task, nowMs, workerId, forceRetry = false, manualRetry = false } =
    params;

  // 1. Active unexpired lease owned by another worker can NEVER be bypassed
  if (
    task.status === 'PROCESSING' &&
    task.leaseExpiresAtMs > nowMs &&
    task.leaseOwner !== workerId
  ) {
    const retryAfterMs = Math.max(1, task.leaseExpiresAtMs - nowMs);
    return {
      allowed: false,
      reason: 'LEASE_ACTIVE',
      retryAfterMs,
      message: `다른 워커(${task.leaseOwner})가 색인 작업 임대(lease gen=${task.leaseGeneration})를 보유 중입니다 (${Math.ceil(
        retryAfterMs / 1000
      )}초 후 만료).`,
    };
  }

  // 2. Superseded tasks are permanently retired to protect newer CANON indices
  if (task.status === 'SUPERSEDED') {
    return {
      allowed: false,
      reason: 'SUPERSEDED',
      message: `작업(${task.id})은 더 최신 CANON 설정에 의해 대체(SUPERSEDED)되어 실행할 수 없습니다.`,
    };
  }

  // 3. Already synced tasks are idempotent no-ops unless explicitly re-verified after cooldown
  if (task.status === 'SYNCED' && !forceRetry) {
    return {
      allowed: false,
      reason: 'ALREADY_SYNCED',
      message: `작업(${task.id})은 이미 RAG 장기 기억 색인이 완료(SYNCED)되었습니다.`,
    };
  }

  // 4. Backoff cooldown check (`nextRetryAfterMs`)
  // Passing proposalId, auditId, manualRetry, or forceRetry does NOT bypass an active backoff cooldown window.
  if (task.nextRetryAfterMs > nowMs) {
    const retryAfterMs = Math.max(1, task.nextRetryAfterMs - nowMs);
    return {
      allowed: false,
      reason: 'BACKOFF_WAITING',
      retryAfterMs,
      message: `재시도 대기 시간(backoff)이 아직 경과하지 않았습니다 (${Math.ceil(
        retryAfterMs / 1000
      )}초 후 재시도 가능).`,
    };
  }

  // 5. Maximum attempts check (`maxAttempts`)
  // Neither proposalId, auditId, nor forceRetry can bypass maxAttempts once exhausted.
  const effectiveMaxAttempts = Math.max(1, task.maxAttempts || 5);
  if (task.attemptCount >= effectiveMaxAttempts) {
    return {
      allowed: false,
      reason: 'MAX_ATTEMPTS_EXCEEDED',
      message: `최대 재시도 횟수(${effectiveMaxAttempts}회)를 초과하여 자동/강제 색인 호출이 차단되었습니다 (현재 시도: ${task.attemptCount}회).`,
    };
  }

  return {
    allowed: true,
    incrementManualRetry: Boolean(manualRetry || forceRetry),
  };
}

/**
 * Phase 4.2.2 Stage 2.5 Section 5.3:
 * Pure validator enforcing all 9 mandatory conditions required before enabling the `CANON 승인` button
 * for `RELATIONSHIP`, `TIMELINE_EVENT`, and `FORESHADOWING` proposals.
 */
export function canEnableCanonApprovalButton(params: {
  isCloudAuthenticated: boolean;
  workspaceState: ApprovalWorkspaceState;
  preview: ChangeProposalPreviewResponse | null | undefined;
  selectedProposal: ChangeProposal | null | undefined;
  activeProjectId: string;
  latestRequestId: number;
  previewRequestId: number;
  isSubmitting: boolean;
}): {
  enabled: boolean;
  disabledReason: string | null;
} {
  const {
    isCloudAuthenticated,
    workspaceState,
    preview,
    selectedProposal,
    activeProjectId,
    latestRequestId,
    previewRequestId,
    isSubmitting,
  } = params;

  if (!selectedProposal) {
    return { enabled: false, disabledReason: '선택된 제안서가 없습니다.' };
  }

  // Condition 9: No approval/rejection/preview request currently in flight
  if (isSubmitting) {
    return {
      enabled: false,
      disabledReason: '현재 서버 요청을 처리 중입니다.',
    };
  }

  if (!isSupportedApprovalEntityType(selectedProposal.targetEntityType)) {
    const enabled = selectedProposal.canonStatus === 'PROPOSED';
    return {
      enabled,
      disabledReason: enabled ? null : '이미 처리된 제안서입니다.',
    };
  }

  // Condition 8: Authenticated cloud user
  if (!isCloudAuthenticated) {
    return {
      enabled: false,
      disabledReason:
        '클라우드 인증(로그인) 상태에서만 원자적 CANON 승인을 실행할 수 있습니다.',
    };
  }

  // Condition 1: Server preview succeeded (workspaceState === 'READY_FOR_REVIEW' and preview exists without local-only fallback flag)
  if (
    workspaceState !== 'READY_FOR_REVIEW' ||
    !preview ||
    preview.isLocalReferenceOnly === true ||
    preview.ok !== true
  ) {
    return {
      enabled: false,
      disabledReason:
        '서버 승인 미리보기 검증이 완료되지 않았습니다. [서버 재검증]을 실행해 주세요.',
    };
  }

  // Condition 2: isCloudVerified === true
  if (preview.isCloudVerified !== true) {
    return {
      enabled: false,
      disabledReason: '클라우드 서버 검증이 확인되지 않았습니다.',
    };
  }

  // Condition 3: canApprove === true
  if (preview.canApprove !== true) {
    return {
      enabled: false,
      disabledReason:
        preview.conflictMessage || '서버 검증 결과 승인 가능 상태가 아닙니다.',
    };
  }

  // Condition 4: proposal.canonStatus === 'PROPOSED'
  if (
    selectedProposal.canonStatus !== 'PROPOSED' ||
    preview.proposal?.canonStatus !== 'PROPOSED'
  ) {
    return {
      enabled: false,
      disabledReason: '검토 대기(PROPOSED) 상태인 제안서만 승인할 수 있습니다.',
    };
  }

  // Condition 5: !conflictCode
  if (Boolean(preview.conflictCode)) {
    return {
      enabled: false,
      disabledReason:
        preview.conflictMessage ||
        `충돌 코드(${preview.conflictCode})로 인해 승인이 차단되었습니다.`,
    };
  }

  // Condition 6: preview matches currently selected projectId and proposalId
  if (
    !activeProjectId ||
    preview.projectId !== activeProjectId ||
    preview.proposalId !== selectedProposal.id
  ) {
    return {
      enabled: false,
      disabledReason:
        '미리보기 응답의 프로젝트/제안서 ID가 현재 선택 항목과 일치하지 않습니다.',
    };
  }

  // Condition 7: Preview response belongs to the latest request ID (not a stale race response)
  if (previewRequestId !== latestRequestId || latestRequestId <= 0) {
    return {
      enabled: false,
      disabledReason:
        '최신 미리보기 응답을 기다리는 중입니다 (이전 요청 응답 무시).',
    };
  }

  return { enabled: true, disabledReason: null };
}


