import type {
  ActorType,
  CanonStatus,
  ChangeProposal,
  Character,
  CharacterRelationship,
  DataProvenance,
  EntityHierarchyLinks,
  Episode,
  Foreshadowing,
  LegacySettingStatus,
  MemoryChunk,
  MemoryDocument,
  Project,
  ProposalTargetEntityType,
  ProposedActionType,
  Scene,
  StyleProfile,
  TimelineEvent,
  UnifiedSettingStatus,
} from '../types/novel';
import {
  ENTITY_CONSTRAINTS,
  generateEntityId,
  isValidEntityId,
  sanitizeIdArray,
  type ValidationResult,
} from './novelLogic';

export const FOUNDATION_CONSTRAINTS = {
  CANON_STATUSES: ['DRAFT', 'PROPOSED', 'CANON', 'REJECTED', 'ARCHIVED'] as const,
  ACTOR_TYPES: ['AUTHOR', 'AI_ENGINE', 'SYSTEM'] as const,
  SCENE: {
    NUMBER_MIN: 1,
    NUMBER_MAX: 1000,
    TITLE_MAX: 150,
    SUMMARY_MAX: 2000,
    LOCATION_MAX: 120,
  },
  FORESHADOWING: {
    TITLE_MAX: 150,
    DESCRIPTION_MAX: 3000,
    PHASES: ['PLANTED', 'REINFORCED', 'RESOLVED', 'ABANDONED'] as const,
  },
  RELATIONSHIP: {
    TYPE_MAX: 80,
    AFFINITY_MIN: -100,
    AFFINITY_MAX: 100,
    DESCRIPTION_MAX: 2000,
  },
  TIMELINE_EVENT: {
    TITLE_MAX: 150,
    SUMMARY_MAX: 3000,
    DATE_MAX: 100,
    ORDER_MIN: -100000,
    ORDER_MAX: 100000,
  },
  MEMORY_DOCUMENT: {
    TITLE_MAX: 150,
    FULL_TEXT_MAX: 200000,
    CHUNK_COUNT_MAX: 500,
    SOURCE_TYPES: [
      'EPISODE',
      'EPISODE_SUMMARY',
      'SCENE',
      'CHARACTER',
      'CHARACTER_STATE_CHANGE',
      'WORLDBUILDING',
      'TIMELINE_EVENT',
      'FORESHADOWING',
      'RELATIONSHIP',
    ] as const,
  },
  MEMORY_CHUNK: {
    CONTENT_MAX: 4000,
    INDEX_MAX: 500,
    TOKEN_MAX: 8000,
  },
  STYLE_PROFILE: {
    NAME_MAX: 120,
    SAMPLE_MAX: 3000,
    PERSPECTIVES: ['FIRST_PERSON', 'THIRD_LIMITED', 'OMNISCIENT', 'MIXED'] as const,
  },
  CHANGE_PROPOSAL: {
    TITLE_MAX: 150,
    RATIONALE_MAX: 2000,
    SUMMARY_MAX: 2000,
    PAYLOAD_JSON_MAX: 20000,
    TARGET_TYPES: [
      'CHARACTER',
      'WORLDBUILDING',
      'EPISODE',
      'SCENE',
      'FORESHADOWING',
      'RELATIONSHIP',
      'TIMELINE_EVENT',
      'STYLE_PROFILE',
    ] as const,
    ACTIONS: ['CREATE', 'UPDATE', 'ARCHIVE'] as const,
  },
} as const;

// ============================================================================
// 1. Canon Status Normalization & Backward Compatibility
// ============================================================================

export function normalizeToCanonStatus(
  status?: UnifiedSettingStatus | null
): CanonStatus {
  if (!status) return 'DRAFT';
  switch (status) {
    case 'confirmed':
    case 'CANON':
      return 'CANON';
    case 'draft':
    case 'DRAFT':
      return 'DRAFT';
    case 'PROPOSED':
      return 'PROPOSED';
    case 'REJECTED':
      return 'REJECTED';
    case 'ARCHIVED':
      return 'ARCHIVED';
    default:
      return 'DRAFT';
  }
}

export function toLegacySettingStatus(
  status?: UnifiedSettingStatus | null
): LegacySettingStatus {
  const normalized = normalizeToCanonStatus(status);
  return normalized === 'CANON' ? 'confirmed' : 'draft';
}

export function formatCanonStatusKorean(status?: UnifiedSettingStatus | null): string {
  const normalized = normalizeToCanonStatus(status);
  switch (normalized) {
    case 'CANON':
      return '작가 확정 (CANON)';
    case 'PROPOSED':
      return 'AI 제안 (PROPOSED)';
    case 'REJECTED':
      return '거절됨 (REJECTED)';
    case 'ARCHIVED':
      return '보관됨 (ARCHIVED)';
    case 'DRAFT':
    default:
      return '초안 (DRAFT)';
  }
}

// ============================================================================
// 2. Canon Setting Protection Guard (확정 설정 보호)
// ============================================================================

export interface CanonProtectionDecision {
  allowed: boolean;
  requiresChangeProposal: boolean;
  reason?: string;
}

/**
 * Protects CANON ('CANON' or legacy 'confirmed') settings from arbitrary AI modification or deletion.
 * - AUTHOR can always modify or delete any status.
 * - AI_ENGINE can modify DRAFT or PROPOSED items, but CANNOT directly modify or delete CANON items.
 */
export function checkCanonMutationPermission(params: {
  actor: ActorType;
  operation: 'UPDATE' | 'DELETE';
  currentStatus?: UnifiedSettingStatus | null;
  canonStatus?: CanonStatus | null;
}): CanonProtectionDecision {
  const effectiveStatus = normalizeToCanonStatus(
    params.canonStatus ?? params.currentStatus
  );

  if (params.actor === 'AUTHOR') {
    return { allowed: true, requiresChangeProposal: false };
  }

  if (params.operation === 'DELETE' && params.actor === 'AI_ENGINE') {
    return {
      allowed: false,
      requiresChangeProposal: true,
      reason:
        'AI 엔진은 설정이나 원고를 임의로 삭제할 수 없습니다. 변경 제안(ChangeProposal)을 통해 보관(ARCHIVE)을 요청해야 합니다.',
    };
  }

  if (effectiveStatus === 'CANON' && params.actor === 'AI_ENGINE') {
    return {
      allowed: false,
      requiresChangeProposal: true,
      reason:
        '작가 확정(CANON) 상태의 설정은 AI가 임의로 수정하거나 삭제할 수 없습니다. ChangeProposal 승인 절차를 거쳐야 합니다.',
    };
  }

  return { allowed: true, requiresChangeProposal: false };
}

export function assertCanonProtection(params: {
  actor: ActorType;
  operation: 'UPDATE' | 'DELETE';
  currentStatus?: UnifiedSettingStatus | null;
  canonStatus?: CanonStatus | null;
}): void {
  const decision = checkCanonMutationPermission(params);
  if (!decision.allowed) {
    throw new Error(decision.reason || '확정 설정 보호 규칙에 의해 작업이 거부되었습니다.');
  }
}

/**
 * Helper to create a ChangeProposal when AI wants to propose an update to a CANON entity.
 */
export function createChangeProposalDraft(params: {
  ownerId: string;
  projectId: string;
  targetEntityType: ProposalTargetEntityType;
  targetEntityId: string;
  proposedAction: ProposedActionType;
  title: string;
  rationale: string;
  beforeSummary: string;
  afterSummary: string;
  proposedPayload: Record<string, unknown>;
  triggerEpisodeId?: string;
  triggerSceneId?: string;
  sourceRevisionId?: string;
  createdBy?: ActorType;
}): ChangeProposal {
  const nowIso = new Date().toISOString();
  return {
    id: generateEntityId('prop'),
    ownerId: params.ownerId,
    projectId: params.projectId,
    targetEntityType: params.targetEntityType,
    targetEntityId: params.targetEntityId,
    proposedAction: params.proposedAction,
    title: params.title.trim().slice(0, FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.TITLE_MAX),
    rationale: params.rationale.trim().slice(0, FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.RATIONALE_MAX),
    beforeSummary: params.beforeSummary.slice(0, FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.SUMMARY_MAX),
    afterSummary: params.afterSummary.slice(0, FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.SUMMARY_MAX),
    proposedPayloadJson: JSON.stringify(params.proposedPayload).slice(
      0,
      FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.PAYLOAD_JSON_MAX
    ),
    canonStatus: 'PROPOSED',
    triggerEpisodeId: params.triggerEpisodeId || '',
    triggerSceneId: params.triggerSceneId || '',
    sourceRevisionId: params.sourceRevisionId || '',
    createdBy: params.createdBy || 'AI_ENGINE',
    reviewedAt: '',
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export function resolveChangeProposalStatus(
  proposal: ChangeProposal,
  decision: 'APPROVE' | 'REJECT' | 'ARCHIVE',
  actor: ActorType
): ChangeProposal {
  if (actor !== 'AUTHOR') {
    throw new Error('AI 설정 변경 승인 요청(ChangeProposal)은 작가(AUTHOR)만 승인하거나 거절할 수 있습니다.');
  }
  const nowIso = new Date().toISOString();
  const nextStatus: CanonStatus =
    decision === 'APPROVE'
      ? 'CANON'
      : decision === 'REJECT'
      ? 'REJECTED'
      : 'ARCHIVED';

  return {
    ...proposal,
    canonStatus: nextStatus,
    reviewedAt: nowIso,
    updatedAt: nowIso,
  };
}

// ============================================================================
// 3. Relational Hierarchy & Provenance Builder
// (User -> Project -> Episode -> Scene -> Event -> Character -> Foreshadowing)
// ============================================================================

export function createDataProvenance(input: {
  sourceType?: DataProvenance['sourceType'];
  createdBy?: ActorType;
  ownerId: string;
  projectId: string;
  episodeId?: string | null;
  sceneId?: string | null;
  eventId?: string | null;
  revisionId?: string | null;
  excerpt?: string;
}): DataProvenance {
  return {
    sourceType: input.sourceType || 'AUTHOR_INPUT',
    createdBy: input.createdBy || 'AUTHOR',
    ownerId: input.ownerId,
    projectId: input.projectId,
    episodeId: input.episodeId ?? null,
    sceneId: input.sceneId ?? null,
    eventId: input.eventId ?? null,
    revisionId: input.revisionId ?? null,
    excerpt: input.excerpt ? input.excerpt.slice(0, 1000) : undefined,
  };
}

export function buildProjectHierarchyLinks(params: {
  project: Project;
  episodes: Episode[];
  scenes?: Scene[];
  events?: TimelineEvent[];
  characters: Character[];
  foreshadowings?: Foreshadowing[];
}): EntityHierarchyLinks {
  return {
    userId: params.project.ownerId,
    projectId: params.project.id,
    episodeIds: params.episodes.map((e) => e.id),
    sceneIds: (params.scenes || []).map((s) => s.id),
    eventIds: (params.events || []).map((ev) => ev.id),
    characterIds: params.characters.map((c) => c.id),
    foreshadowingIds: (params.foreshadowings || []).map((f) => f.id),
  };
}

/**
 * Traces the full chain for a given Foreshadowing clue:
 * User -> Project -> Episode -> Scene -> Event -> Character -> Foreshadowing
 */
export function traceForeshadowingHierarchyChain(params: {
  foreshadowing: Foreshadowing;
  project: Project;
  episodes: Episode[];
  scenes: Scene[];
  events: TimelineEvent[];
  characters: Character[];
}) {
  const { foreshadowing, project, episodes, scenes, events, characters } = params;
  const plantedEpisode = episodes.find((e) => e.id === foreshadowing.plantedEpisodeId) || null;
  const plantedScene = scenes.find((s) => s.id === foreshadowing.plantedSceneId) || null;
  const resolvedEpisode = episodes.find((e) => e.id === foreshadowing.resolvedEpisodeId) || null;
  const resolvedScene = scenes.find((s) => s.id === foreshadowing.resolvedSceneId) || null;
  const relatedEvents = events.filter((ev) => foreshadowing.relatedEventIds.includes(ev.id));
  const relatedCharacters = characters.filter((ch) =>
    foreshadowing.relatedCharacterIds.includes(ch.id)
  );

  return {
    userId: project.ownerId,
    projectId: project.id,
    plantedEpisode,
    plantedScene,
    resolvedEpisode,
    resolvedScene,
    relatedEvents,
    relatedCharacters,
    foreshadowing,
    sourceRevisionId: foreshadowing.sourceRevisionId,
  };
}

// ============================================================================
// 4. Validation Helpers for Phase 1.5 Foundation Entities
// ============================================================================

export function isValidCanonStatus(val: unknown): val is CanonStatus {
  return (
    typeof val === 'string' &&
    (FOUNDATION_CONSTRAINTS.CANON_STATUSES as readonly string[]).includes(val)
  );
}

export function isValidOptionalId(id: unknown): boolean {
  if (id === '' || id === undefined || id === null) return true;
  return isValidEntityId(id);
}

export function validateSceneInput(input: Partial<Scene>): ValidationResult {
  const title = (input.title ?? '').trim();
  const num = Number(input.sceneNumber ?? 1);
  if (!isValidEntityId(input.episodeId)) {
    return { valid: false, error: '장면(Scene)은 유효한 회차(episodeId)와 연결되어야 합니다.' };
  }
  if (
    !Number.isInteger(num) ||
    num < FOUNDATION_CONSTRAINTS.SCENE.NUMBER_MIN ||
    num > FOUNDATION_CONSTRAINTS.SCENE.NUMBER_MAX
  ) {
    return { valid: false, error: '장면 번호는 1 이상 1,000 이하의 정수여야 합니다.' };
  }
  if (title.length < 1 || title.length > FOUNDATION_CONSTRAINTS.SCENE.TITLE_MAX) {
    return { valid: false, error: '장면 제목은 1~150자 이내여야 합니다.' };
  }
  if ((input.summary ?? '').length > FOUNDATION_CONSTRAINTS.SCENE.SUMMARY_MAX) {
    return { valid: false, error: '장면 요약은 최대 2,000자까지 입력할 수 있습니다.' };
  }
  if ((input.location ?? '').length > FOUNDATION_CONSTRAINTS.SCENE.LOCATION_MAX) {
    return { valid: false, error: '장면 장소명은 최대 120자까지 입력할 수 있습니다.' };
  }
  if (input.canonStatus && !isValidCanonStatus(input.canonStatus)) {
    return { valid: false, error: '유효하지 않은 설정 상태(canonStatus)입니다.' };
  }
  return { valid: true };
}

export function validateForeshadowingInput(
  input: Partial<Foreshadowing>
): ValidationResult {
  const title = (input.title ?? '').trim();
  if (title.length < 1 || title.length > FOUNDATION_CONSTRAINTS.FORESHADOWING.TITLE_MAX) {
    return { valid: false, error: '복선 제목은 1~150자 이내여야 합니다.' };
  }
  if ((input.description ?? '').length > FOUNDATION_CONSTRAINTS.FORESHADOWING.DESCRIPTION_MAX) {
    return { valid: false, error: '복선 설명은 최대 3,000자까지 입력할 수 있습니다.' };
  }
  if (
    !input.cluePhase ||
    !(FOUNDATION_CONSTRAINTS.FORESHADOWING.PHASES as readonly string[]).includes(
      input.cluePhase
    )
  ) {
    return { valid: false, error: '유효하지 않은 복선 진행 단계(cluePhase)입니다.' };
  }
  if (!isValidCanonStatus(input.canonStatus)) {
    return { valid: false, error: '유효하지 않은 복선 확정 상태(canonStatus)입니다.' };
  }
  if (!isValidOptionalId(input.plantedEpisodeId) || !isValidOptionalId(input.resolvedEpisodeId)) {
    return { valid: false, error: '연결된 회차 ID 형식이 올바르지 않습니다.' };
  }
  return { valid: true };
}

export function validateCharacterRelationshipInput(
  input: Partial<CharacterRelationship>
): ValidationResult {
  if (!isValidEntityId(input.sourceCharacterId) || !isValidEntityId(input.targetCharacterId)) {
    return { valid: false, error: '인물 관계는 유효한 두 등장인물 ID가 필요합니다.' };
  }
  if (input.sourceCharacterId === input.targetCharacterId) {
    return { valid: false, error: '동일 인물을 대상으로 관계를 설정할 수 없습니다.' };
  }
  const relType = (input.relationType ?? '').trim();
  if (relType.length < 1 || relType.length > FOUNDATION_CONSTRAINTS.RELATIONSHIP.TYPE_MAX) {
    return { valid: false, error: '관계 유형은 1~80자 이내로 입력해 주세요.' };
  }
  const affinity = Number(input.affinityScore ?? 0);
  if (
    !Number.isInteger(affinity) ||
    affinity < FOUNDATION_CONSTRAINTS.RELATIONSHIP.AFFINITY_MIN ||
    affinity > FOUNDATION_CONSTRAINTS.RELATIONSHIP.AFFINITY_MAX
  ) {
    return { valid: false, error: '우호/적대 지수는 -100에서 100 사이의 정수여야 합니다.' };
  }
  if ((input.description ?? '').length > FOUNDATION_CONSTRAINTS.RELATIONSHIP.DESCRIPTION_MAX) {
    return { valid: false, error: '관계 설명은 최대 2,000자까지 입력할 수 있습니다.' };
  }
  if (!isValidCanonStatus(input.canonStatus)) {
    return { valid: false, error: '유효하지 않은 설정 상태(canonStatus)입니다.' };
  }
  return { valid: true };
}

export function validateTimelineEventInput(
  input: Partial<TimelineEvent>
): ValidationResult {
  const title = (input.title ?? '').trim();
  if (title.length < 1 || title.length > FOUNDATION_CONSTRAINTS.TIMELINE_EVENT.TITLE_MAX) {
    return { valid: false, error: '연표 사건 제목은 1~150자 이내여야 합니다.' };
  }
  if ((input.summary ?? '').length > FOUNDATION_CONSTRAINTS.TIMELINE_EVENT.SUMMARY_MAX) {
    return { valid: false, error: '사건 요약은 최대 3,000자까지 입력할 수 있습니다.' };
  }
  if ((input.inUniverseDate ?? '').length > FOUNDATION_CONSTRAINTS.TIMELINE_EVENT.DATE_MAX) {
    return { valid: false, error: '작중 연대기 표기는 최대 100자까지 입력할 수 있습니다.' };
  }
  const order = Number(input.chronologicalOrder ?? 0);
  if (
    !Number.isInteger(order) ||
    order < FOUNDATION_CONSTRAINTS.TIMELINE_EVENT.ORDER_MIN ||
    order > FOUNDATION_CONSTRAINTS.TIMELINE_EVENT.ORDER_MAX
  ) {
    return { valid: false, error: '연표 정렬 순서는 -100,000 ~ 100,000 사이의 정수여야 합니다.' };
  }
  if (!isValidCanonStatus(input.canonStatus)) {
    return { valid: false, error: '유효하지 않은 설정 상태(canonStatus)입니다.' };
  }
  return { valid: true };
}

export function validateStyleProfileInput(
  input: Partial<StyleProfile>
): ValidationResult {
  const name = (input.name ?? '').trim();
  if (name.length < 1 || name.length > FOUNDATION_CONSTRAINTS.STYLE_PROFILE.NAME_MAX) {
    return { valid: false, error: '문체 프로필 이름은 1~120자 이내여야 합니다.' };
  }
  if (
    !input.narrativePerspective ||
    !(FOUNDATION_CONSTRAINTS.STYLE_PROFILE.PERSPECTIVES as readonly string[]).includes(
      input.narrativePerspective
    )
  ) {
    return { valid: false, error: '유효하지 않은 서술 시점(narrativePerspective)입니다.' };
  }
  const dialogueRatio = Number(input.dialogueRatio ?? 0);
  if (dialogueRatio < 0 || dialogueRatio > 100) {
    return { valid: false, error: '대사 비중(dialogueRatio)은 0~100 사이여야 합니다.' };
  }
  if ((input.sampleExcerpt ?? '').length > FOUNDATION_CONSTRAINTS.STYLE_PROFILE.SAMPLE_MAX) {
    return { valid: false, error: '문체 샘플 발췌문은 최대 3,000자까지 입력할 수 있습니다.' };
  }
  if (!isValidCanonStatus(input.canonStatus)) {
    return { valid: false, error: '유효하지 않은 설정 상태(canonStatus)입니다.' };
  }
  return { valid: true };
}

export function validateChangeProposalInput(
  input: Partial<ChangeProposal>
): ValidationResult {
  const title = (input.title ?? '').trim();
  if (title.length < 1 || title.length > FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.TITLE_MAX) {
    return { valid: false, error: '변경 승인 요청 제목은 1~150자 이내여야 합니다.' };
  }
  if (!isValidEntityId(input.targetEntityId)) {
    return { valid: false, error: '유효한 대상 엔티티 ID(targetEntityId)가 필요합니다.' };
  }
  if (
    !input.targetEntityType ||
    !(FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.TARGET_TYPES as readonly string[]).includes(
      input.targetEntityType
    )
  ) {
    return { valid: false, error: '유효하지 않은 대상 엔티티 유형입니다.' };
  }
  if (
    !input.proposedAction ||
    !(FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.ACTIONS as readonly string[]).includes(
      input.proposedAction
    )
  ) {
    return {
      valid: false,
      error: 'AI 변경 요청 액션은 CREATE, UPDATE, ARCHIVE 중 하나여야 합니다 (임의 DELETE 금지).',
    };
  }
  if (!isValidCanonStatus(input.canonStatus)) {
    return { valid: false, error: '유효하지 않은 승인 상태(canonStatus)입니다.' };
  }
  return { valid: true };
}

export function validateMemoryDocumentInput(
  input: Partial<MemoryDocument>
): ValidationResult {
  const title = (input.title ?? '').trim();
  if (title.length < 1 || title.length > FOUNDATION_CONSTRAINTS.MEMORY_DOCUMENT.TITLE_MAX) {
    return { valid: false, error: '기억 문서 제목은 1~150자 이내여야 합니다.' };
  }
  if (!isValidEntityId(input.sourceEntityId)) {
    return { valid: false, error: '유효한 원본 엔티티 ID(sourceEntityId)가 필요합니다.' };
  }
  if ((input.fullText ?? '').length > FOUNDATION_CONSTRAINTS.MEMORY_DOCUMENT.FULL_TEXT_MAX) {
    return { valid: false, error: '기억 문서 본문이 최대 허용 길이를 초과했습니다.' };
  }
  if (!isValidCanonStatus(input.canonStatus)) {
    return { valid: false, error: '유효하지 않은 설정 상태(canonStatus)입니다.' };
  }
  return { valid: true };
}

export function validateMemoryChunkInput(
  input: Partial<MemoryChunk>
): ValidationResult {
  if (!isValidEntityId(input.documentId) || !isValidEntityId(input.sourceEntityId)) {
    return { valid: false, error: '유효한 상위 문서 ID 및 원본 엔티티 ID가 필요합니다.' };
  }
  if ((input.content ?? '').length < 1 || (input.content ?? '').length > FOUNDATION_CONSTRAINTS.MEMORY_CHUNK.CONTENT_MAX) {
    return { valid: false, error: '기억 청크 본문은 1~4,000자 이내여야 합니다.' };
  }
  const idx = Number(input.chunkIndex ?? 0);
  if (!Number.isInteger(idx) || idx < 0 || idx > FOUNDATION_CONSTRAINTS.MEMORY_CHUNK.INDEX_MAX) {
    return { valid: false, error: '청크 인덱스가 유효 범위를 벗어났습니다.' };
  }
  if (!isValidCanonStatus(input.canonStatus)) {
    return { valid: false, error: '유효하지 않은 설정 상태(canonStatus)입니다.' };
  }
  return { valid: true };
}

export function sanitizeStringTags(arr: unknown, maxLength = 80): string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, maxLength))
    .slice(0, ENTITY_CONSTRAINTS.LIST_MAX_ITEMS);
}

export { sanitizeIdArray };
