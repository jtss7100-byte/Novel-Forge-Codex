import type {
  PromptProfile,
  StyleProfile,
  StyleApprovalPersistenceStatus,
  PromptProfileCasErrorCode,
  StyleApprovalConflictDetails,
} from '../../../types/novel';
import { toIsoString } from '../core/firestoreTimestamp';
import { isValidCanonStatus, normalizeToCanonStatus } from '../../../utils/foundationLogic';

const SAFE_ENTITY_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

const VALID_PROMPT_TYPES = new Set([
  'CORE_WRITING_RULES',
  'PROJECT_STYLE_PROFILE',
  'CHARACTER_DIALOGUE_RULES',
  'SCENE_INSTRUCTIONS',
  'REVIEW_RULES',
]);

const VALID_NARRATIVE_PERSPECTIVES = new Set([
  'FIRST_PERSON',
  'THIRD_LIMITED',
  'OMNISCIENT',
  'MIXED',
]);

export function parsePromptProfileFromFirestoreData(
  docId: string,
  data: Record<string, unknown>,
  fallbackOwnerId: string,
  fallbackProjectId: string
): PromptProfile {
  return {
    id: String(data.id ?? docId),
    ownerId: String(data.ownerId ?? fallbackOwnerId),
    projectId: String(data.projectId ?? fallbackProjectId),
    promptType:
      data.promptType === 'PROJECT_STYLE_PROFILE' ||
      data.promptType === 'CHARACTER_DIALOGUE_RULES' ||
      data.promptType === 'SCENE_INSTRUCTIONS' ||
      data.promptType === 'REVIEW_RULES'
        ? data.promptType
        : 'CORE_WRITING_RULES',
    title: String(data.title ?? ''),
    description: String(data.description ?? ''),
    targetCharacterId: data.targetCharacterId
      ? String(data.targetCharacterId)
      : undefined,
    content: String(data.content ?? ''),
    isActive: Boolean(data.isActive),
    currentVersionId: String(data.currentVersionId ?? 'pver_1'),
    currentVersionNumber: Number(data.currentVersionNumber ?? 1),
    versions: Array.isArray(data.versions) ? data.versions : [],
    createdAt: toIsoString(data.createdAt),
    updatedAt: toIsoString(data.updatedAt),
  };
}

export function parseStyleProfileFromFirestoreData(
  docId: string,
  data: Record<string, unknown>,
  fallbackOwnerId: string,
  fallbackProjectId: string
): StyleProfile {
  const canonStatus =
    isValidCanonStatus(data.canonStatus) ||
    data.canonStatus === 'draft' ||
    data.canonStatus === 'confirmed'
      ? data.canonStatus
      : undefined;

  return {
    id: String(data.id ?? docId),
    ownerId: String(data.ownerId ?? fallbackOwnerId),
    projectId: String(data.projectId ?? fallbackProjectId),
    name: String(data.name ?? ''),
    narrativePerspective:
      data.narrativePerspective === 'FIRST_PERSON' ||
      data.narrativePerspective === 'OMNISCIENT' ||
      data.narrativePerspective === 'MIXED'
        ? data.narrativePerspective
        : 'THIRD_LIMITED',
    dialogueRatio: Number(data.dialogueRatio ?? 0),
    avgSentenceLength: Number(data.avgSentenceLength ?? 0),
    toneKeywords: Array.isArray(data.toneKeywords)
      ? data.toneKeywords.map(String)
      : [],
    preferredExpressions: Array.isArray(data.preferredExpressions)
      ? data.preferredExpressions.map(String)
      : [],
    prohibitedExpressions: Array.isArray(data.prohibitedExpressions)
      ? data.prohibitedExpressions.map(String)
      : [],
    sampleExcerpt: String(data.sampleExcerpt ?? ''),
    canonStatus: normalizeToCanonStatus(canonStatus),
    sourceRevisionId: String(data.sourceRevisionId ?? ''),
    createdAt: toIsoString(data.createdAt),
    updatedAt: toIsoString(data.updatedAt),
  };
}

export function validatePromptProfileForFirestoreSchema(
  uid: string,
  projectId: string,
  profile: PromptProfile
): { valid: boolean; reasonKo?: string } {
  if (!SAFE_ENTITY_ID_REGEX.test(profile.id)) {
    return { valid: false, reasonKo: '유효하지 않은 PromptProfile ID 형식입니다.' };
  }
  if (profile.ownerId !== uid) {
    return { valid: false, reasonKo: 'PromptProfile 소유자(ownerId)가 일치하지 않습니다.' };
  }
  if (profile.projectId !== projectId) {
    return { valid: false, reasonKo: 'PromptProfile 프로젝트(projectId)가 일치하지 않습니다.' };
  }
  if (!VALID_PROMPT_TYPES.has(profile.promptType)) {
    return { valid: false, reasonKo: '허용되지 않는 promptType입니다.' };
  }
  const titleLen = (profile.title || '').trim().length;
  if (titleLen < 1 || profile.title.length > 150) {
    return { valid: false, reasonKo: '프롬프트 제목은 1~150자 이내여야 합니다.' };
  }
  if ((profile.description || '').length > 1000) {
    return { valid: false, reasonKo: '프롬프트 설명은 1,000자 이하여야 합니다.' };
  }
  if (typeof profile.content !== 'string' || profile.content.length > 100000) {
    return { valid: false, reasonKo: '프롬프트 본문은 100,000자 이하여야 합니다.' };
  }
  if (!SAFE_ENTITY_ID_REGEX.test(profile.currentVersionId)) {
    return { valid: false, reasonKo: '유효하지 않은 currentVersionId입니다.' };
  }
  if (
    !Number.isInteger(profile.currentVersionNumber) ||
    profile.currentVersionNumber < 1 ||
    profile.currentVersionNumber > 10000
  ) {
    return { valid: false, reasonKo: 'currentVersionNumber는 1~10,000 범위의 정수여야 합니다.' };
  }
  if (
    !Array.isArray(profile.versions) ||
    profile.versions.length < 1 ||
    profile.versions.length > 30 ||
    typeof profile.versions[0] !== 'object' ||
    profile.versions[0] === null
  ) {
    return {
      valid: false,
      reasonKo: '프롬프트 버전 기록(versions)은 1~30개의 유효한 버전 객체 배열이어야 합니다.',
    };
  }
  return { valid: true };
}

export function validateStyleProfileForFirestoreSchema(
  uid: string,
  projectId: string,
  profile: StyleProfile
): { valid: boolean; reasonKo?: string } {
  if (!SAFE_ENTITY_ID_REGEX.test(profile.id)) {
    return { valid: false, reasonKo: '유효하지 않은 StyleProfile ID 형식입니다.' };
  }
  if (profile.ownerId !== uid) {
    return { valid: false, reasonKo: 'StyleProfile 소유자(ownerId)가 일치하지 않습니다.' };
  }
  if (profile.projectId !== projectId) {
    return { valid: false, reasonKo: 'StyleProfile 프로젝트(projectId)가 일치하지 않습니다.' };
  }
  const nameLen = (profile.name || '').trim().length;
  if (nameLen < 1 || profile.name.length > 120) {
    return { valid: false, reasonKo: '문체 프로필 이름은 1~120자 이내여야 합니다.' };
  }
  if (!VALID_NARRATIVE_PERSPECTIVES.has(profile.narrativePerspective)) {
    return { valid: false, reasonKo: '유효하지 않은 narrativePerspective입니다.' };
  }
  if (
    !Number.isInteger(profile.dialogueRatio) ||
    profile.dialogueRatio < 0 ||
    profile.dialogueRatio > 100
  ) {
    return { valid: false, reasonKo: 'dialogueRatio는 0~100 사이의 정수여야 합니다.' };
  }
  if (
    !Number.isInteger(profile.avgSentenceLength) ||
    profile.avgSentenceLength < 0 ||
    profile.avgSentenceLength > 1000
  ) {
    return { valid: false, reasonKo: 'avgSentenceLength는 0~1,000 사이의 정수여야 합니다.' };
  }
  if (
    !Array.isArray(profile.toneKeywords) ||
    profile.toneKeywords.length > 50 ||
    !Array.isArray(profile.preferredExpressions) ||
    profile.preferredExpressions.length > 50 ||
    !Array.isArray(profile.prohibitedExpressions) ||
    profile.prohibitedExpressions.length > 50
  ) {
    return { valid: false, reasonKo: '문체 키워드/표현 배열은 최대 50개까지 허용됩니다.' };
  }
  if (typeof profile.sampleExcerpt !== 'string' || profile.sampleExcerpt.length > 3000) {
    return { valid: false, reasonKo: 'sampleExcerpt는 최대 3,000자까지 허용됩니다.' };
  }
  return { valid: true };
}

export class StyleCasTransactionAbortError extends Error {
  public readonly status: StyleApprovalPersistenceStatus | PromptProfileCasErrorCode;
  public readonly conflictDetails?: StyleApprovalConflictDetails;
  public readonly remotePromptProfile?: PromptProfile;

  constructor(params: {
    status: StyleApprovalPersistenceStatus | PromptProfileCasErrorCode;
    message: string;
    conflictDetails?: StyleApprovalConflictDetails;
    remotePromptProfile?: PromptProfile;
  }) {
    super(params.message);
    this.name = 'StyleCasTransactionAbortError';
    this.status = params.status;
    this.conflictDetails = params.conflictDetails;
    this.remotePromptProfile = params.remotePromptProfile;
  }
}

export function classifyStylePersistenceError(error: unknown): {
  persistenceStatus: StyleApprovalPersistenceStatus;
  casErrorCode: PromptProfileCasErrorCode;
  messageKo: string;
  conflictDetails?: StyleApprovalConflictDetails;
  remotePromptProfile?: PromptProfile;
} {
  if (error instanceof StyleCasTransactionAbortError) {
    const persistenceStatus: StyleApprovalPersistenceStatus =
      error.status === 'VERSION_CONFLICT'
        ? 'VERSION_CONFLICT'
        : error.status === 'PERMISSION_DENIED' || error.status === 'TENANT_ISOLATION'
        ? 'PERMISSION_DENIED'
        : error.status === 'VALIDATION_FAILED'
        ? 'VALIDATION_FAILED'
        : error.status === 'NETWORK_FAILED'
        ? 'NETWORK_FAILED'
        : 'NOT_COMMITTED';
    const casErrorCode: PromptProfileCasErrorCode =
      error.status === 'VERSION_CONFLICT'
        ? 'VERSION_CONFLICT'
        : error.status === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : error.status === 'PERMISSION_DENIED'
        ? 'PERMISSION_DENIED'
        : error.status === 'TENANT_ISOLATION'
        ? 'TENANT_ISOLATION'
        : error.status === 'VALIDATION_FAILED'
        ? 'VALIDATION_FAILED'
        : 'NETWORK_FAILED';
    return {
      persistenceStatus,
      casErrorCode,
      messageKo: error.message,
      conflictDetails: error.conflictDetails,
      remotePromptProfile: error.remotePromptProfile,
    };
  }

  const rawMsg = error instanceof Error ? error.message : String(error ?? '');
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  const combined = `${code} ${rawMsg}`.toLowerCase();

  if (
    combined.includes('permission-denied') ||
    combined.includes('permission_denied') ||
    combined.includes('missing or insufficient permissions') ||
    combined.includes('canon_protection') ||
    combined.includes('확정(canon) 상태의 데이터는 ai가 직접')
  ) {
    return {
      persistenceStatus: 'PERMISSION_DENIED',
      casErrorCode: 'PERMISSION_DENIED',
      messageKo: `권한 또는 보안 규칙 거부(PERMISSION_DENIED): ${rawMsg || '문서 접근 권한이 없습니다.'}`,
    };
  }

  if (
    combined.includes('version_conflict') ||
    combined.includes('aborted') ||
    combined.includes('failed-precondition')
  ) {
    return {
      persistenceStatus: 'VERSION_CONFLICT',
      casErrorCode: 'VERSION_CONFLICT',
      messageKo: `동시 수정 버전 충돌(VERSION_CONFLICT): ${rawMsg || '다른 탭에서 먼저 수정되었습니다.'}`,
    };
  }

  if (
    combined.includes('invalid-argument') ||
    combined.includes('validation') ||
    combined.includes('유효하지 않은')
  ) {
    return {
      persistenceStatus: 'VALIDATION_FAILED',
      casErrorCode: 'VALIDATION_FAILED',
      messageKo: `스키마 검증 실패(VALIDATION_FAILED): ${rawMsg}`,
    };
  }

  if (
    combined.includes('unavailable') ||
    combined.includes('network') ||
    combined.includes('deadline-exceeded')
  ) {
    return {
      persistenceStatus: 'NETWORK_FAILED',
      casErrorCode: 'NETWORK_FAILED',
      messageKo: `네트워크 또는 서버 연결 오류(NETWORK_FAILED): ${rawMsg}`,
    };
  }

  return {
    persistenceStatus: 'NOT_COMMITTED',
    casErrorCode: 'VALIDATION_FAILED',
    messageKo: rawMsg || '트랜잭션이 커밋되지 않았습니다(NOT_COMMITTED).',
  };
}

/**
 * Merges remote version history with the incoming PromptProfile's new version
 * so prior versions are never dropped during a CAS update or version restoration.
 */
export function mergePromptVersionHistoryPreservingPrior(
  remoteProfile: PromptProfile,
  incomingProfile: PromptProfile
): PromptProfile['versions'] {
  const seen = new Set<string>();
  const merged: PromptProfile['versions'] = [];

  for (const v of incomingProfile.versions || []) {
    if (v && v.versionId && !seen.has(v.versionId)) {
      seen.add(v.versionId);
      merged.push(v);
    }
  }
  for (const v of remoteProfile.versions || []) {
    if (v && v.versionId && !seen.has(v.versionId)) {
      seen.add(v.versionId);
      merged.push(v);
    }
  }

  return merged.slice(0, 30);
}
