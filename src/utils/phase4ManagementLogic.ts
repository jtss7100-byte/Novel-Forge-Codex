import type {
  CanonStatus,
  Character,
  CharacterRelationship,
  Episode,
  Foreshadowing,
  ForeshadowingPhase,
  ProjectBundle,
  Revision,
  Scene,
  TimelineEvent,
  WorldbuildingItem,
} from '../types/novel';
import {
  formatCanonStatusKorean,
  validateCharacterRelationshipInput,
  validateForeshadowingInput,
  validateTimelineEventInput,
} from './foundationLogic';

export interface FieldDiffItem {
  label: string;
  before: string;
  after: string;
}

export type RagSyncStatus =
  | 'IDLE'
  | 'PENDING'
  | 'INDEXED'
  | 'FAILED'
  | 'SKIPPED_UNVERIFIED_SOURCE';

export interface RagSyncSummary {
  status: RagSyncStatus;
  message: string;
  updatedAt: string;
  retryable?: boolean;
}

export const CANON_CONFIRMATION_MESSAGE =
  '이미 확정된 정사 설정을 변경합니다. 이후 집필에 영향을 줄 수 있습니다. 변경 내용을 확인하고 저장하시겠습니까?';

export function formatForeshadowingPhaseKorean(phase: ForeshadowingPhase): string {
  switch (phase) {
    case 'PLANTED':
      return '설치됨 (PLANTED)';
    case 'REINFORCED':
      return '강화됨 (REINFORCED)';
    case 'RESOLVED':
      return '회수 완료 (RESOLVED)';
    case 'ABANDONED':
      return '폐기 보류 (ABANDONED)';
    default:
      return '설치됨 (PLANTED)';
  }
}

export function deduplicateIdList(ids: readonly string[] | undefined | null): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids) {
    const clean = typeof raw === 'string' ? raw.trim() : '';
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      result.push(clean);
    }
  }
  return result;
}

/**
 * Verifies that a candidate `sourceRevisionId` corresponds to an actual manuscript Revision
 * in the current project. Never fabricates synthetic revision IDs like `rev_${id}_${nowIso}`.
 */
export function resolveVerifiedSourceRevisionId(params: {
  candidateRevisionId?: string | null;
  projectRevisions: readonly Revision[];
  projectId: string;
  existingVerifiedRevisionId?: string | null;
}): string {
  const candidate = (params.candidateRevisionId ?? '').trim();
  if (candidate) {
    const existsInProject = params.projectRevisions.some(
      (r) => r.projectId === params.projectId && r.id === candidate
    );
    if (existsInProject) {
      return candidate;
    }
  }

  const existing = (params.existingVerifiedRevisionId ?? '').trim();
  if (existing) {
    const existsInProject = params.projectRevisions.some(
      (r) => r.projectId === params.projectId && r.id === existing
    );
    if (existsInProject) {
      return existing;
    }
  }

  return '';
}

/**
 * Determines whether an entity update is eligible for automatic RAG indexing.
 * Blocks auto-indexing when `canonStatus !== 'CANON'` or when `sourceRevisionId`
 * cannot be verified against actual project revisions.
 */
export function evaluateRagAutoIndexEligibility(params: {
  canonStatus: CanonStatus;
  sourceRevisionId?: string | null;
  projectRevisions: readonly Revision[];
  projectId: string;
  rawText: string;
}): {
  eligible: boolean;
  verifiedRevisionId: string;
  skipReason?: 'NOT_CANON' | 'EMPTY_TEXT' | 'UNVERIFIED_SOURCE_REVISION';
} {
  if (params.canonStatus !== 'CANON') {
    return {
      eligible: false,
      verifiedRevisionId: '',
      skipReason: 'NOT_CANON',
    };
  }

  if (!(params.rawText ?? '').trim()) {
    return {
      eligible: false,
      verifiedRevisionId: '',
      skipReason: 'EMPTY_TEXT',
    };
  }

  const verifiedRevisionId = resolveVerifiedSourceRevisionId({
    candidateRevisionId: params.sourceRevisionId,
    projectRevisions: params.projectRevisions,
    projectId: params.projectId,
  });

  if (!verifiedRevisionId) {
    return {
      eligible: false,
      verifiedRevisionId: '',
      skipReason: 'UNVERIFIED_SOURCE_REVISION',
    };
  }

  return {
    eligible: true,
    verifiedRevisionId,
  };
}

/**
 * Evaluates HTTP response from `/api/rag/*` endpoints so HTTP 4xx/5xx responses
 * (which do not reject `fetch()`) are accurately classified as `FAILED` rather than success.
 */
export function interpretRagApiResponse(params: {
  ok: boolean;
  status: number;
  body?: unknown;
}): {
  ragStatus: 'INDEXED' | 'FAILED';
  errorMessage?: string;
  retryable: boolean;
} {
  const bodyObj =
    params.body && typeof params.body === 'object'
      ? (params.body as Record<string, unknown>)
      : null;

  if (!params.ok || params.status < 200 || params.status >= 300) {
    const serverError =
      typeof bodyObj?.error === 'string' && bodyObj.error.trim()
        ? bodyObj.error.trim()
        : typeof bodyObj?.message === 'string' && bodyObj.message.trim()
        ? bodyObj.message.trim()
        : `RAG API 요청 실패 (HTTP ${params.status})`;
    const retryable = params.status === 429 || params.status >= 500;
    return {
      ragStatus: 'FAILED',
      errorMessage: serverError,
      retryable,
    };
  }

  if (bodyObj && (bodyObj.success === false || bodyObj.indexStatus === 'FAILED')) {
    const logicError =
      typeof bodyObj.error === 'string' && bodyObj.error.trim()
        ? bodyObj.error.trim()
        : 'RAG 색인 처리 중 오류가 보고되었습니다.';
    return {
      ragStatus: 'FAILED',
      errorMessage: logicError,
      retryable: Boolean(bodyObj.retryable),
    };
  }

  return {
    ragStatus: 'INDEXED',
    retryable: false,
  };
}

// ============================================================================
// Foreshadowing Validation, Lifecycle & Filtering Logic
// ============================================================================

export interface ProjectEntityContext {
  projectId: string;
  episodes: readonly Episode[];
  scenes: readonly Scene[];
  characters: readonly Character[];
  timelineEvents: readonly TimelineEvent[];
  foreshadowings?: readonly Foreshadowing[];
  worldbuilding?: readonly WorldbuildingItem[];
  revisions: readonly Revision[];
}

export interface ScopedForeshadowingValidationResult {
  valid: boolean;
  error?: string;
  warnings: string[];
  requiresResolutionConfirmation: boolean;
  sanitizedRelatedCharacterIds: string[];
  sanitizedRelatedEventIds: string[];
  verifiedSourceRevisionId: string;
}

export function validateProjectScopedForeshadowing(
  input: {
    title: string;
    description: string;
    cluePhase: ForeshadowingPhase;
    canonStatus: CanonStatus;
    plantedEpisodeId?: string;
    plantedSceneId?: string;
    resolvedEpisodeId?: string;
    resolvedSceneId?: string;
    relatedEventIds?: string[];
    relatedCharacterIds?: string[];
    sourceRevisionId?: string;
  },
  context: ProjectEntityContext,
  options?: {
    previousPhase?: ForeshadowingPhase;
    existingSourceRevisionId?: string;
  }
): ScopedForeshadowingValidationResult {
  const warnings: string[] = [];
  const dedupedCharIds = deduplicateIdList(input.relatedCharacterIds);
  const dedupedEventIds = deduplicateIdList(input.relatedEventIds);

  const baseCheck = validateForeshadowingInput({
    title: input.title,
    description: input.description,
    cluePhase: input.cluePhase,
    canonStatus: input.canonStatus,
    plantedEpisodeId: input.plantedEpisodeId || '',
    plantedSceneId: input.plantedSceneId || '',
    resolvedEpisodeId: input.resolvedEpisodeId || '',
    resolvedSceneId: input.resolvedSceneId || '',
    relatedEventIds: dedupedEventIds,
    relatedCharacterIds: dedupedCharIds,
  });

  if (!baseCheck.valid) {
    return {
      valid: false,
      error: baseCheck.error,
      warnings,
      requiresResolutionConfirmation: false,
      sanitizedRelatedCharacterIds: dedupedCharIds,
      sanitizedRelatedEventIds: dedupedEventIds,
      verifiedSourceRevisionId: '',
    };
  }

  const projectEpisodes = new Map(
    context.episodes
      .filter((e) => e.projectId === context.projectId)
      .map((e) => [e.id, e])
  );
  const projectScenes = new Map(
    context.scenes
      .filter((s) => s.projectId === context.projectId)
      .map((s) => [s.id, s])
  );
  const projectCharacters = new Set(
    context.characters
      .filter((c) => c.projectId === context.projectId)
      .map((c) => c.id)
  );
  const projectEvents = new Set(
    context.timelineEvents
      .filter((ev) => ev.projectId === context.projectId)
      .map((ev) => ev.id)
  );

  if (input.plantedEpisodeId && !projectEpisodes.has(input.plantedEpisodeId)) {
    return {
      valid: false,
      error: '선택한 설치 회차(plantedEpisodeId)가 현재 작품에 존재하지 않습니다.',
      warnings,
      requiresResolutionConfirmation: false,
      sanitizedRelatedCharacterIds: dedupedCharIds,
      sanitizedRelatedEventIds: dedupedEventIds,
      verifiedSourceRevisionId: '',
    };
  }

  if (input.plantedSceneId) {
    const plantedScene = projectScenes.get(input.plantedSceneId);
    if (!plantedScene) {
      return {
        valid: false,
        error: '선택한 설치 장면(plantedSceneId)이 현재 작품에 존재하지 않습니다.',
        warnings,
        requiresResolutionConfirmation: false,
        sanitizedRelatedCharacterIds: dedupedCharIds,
        sanitizedRelatedEventIds: dedupedEventIds,
        verifiedSourceRevisionId: '',
      };
    }
    if (
      input.plantedEpisodeId &&
      plantedScene.episodeId !== input.plantedEpisodeId
    ) {
      return {
        valid: false,
        error: '설치 장면(plantedSceneId)이 선택한 설치 회차에 속하지 않습니다.',
        warnings,
        requiresResolutionConfirmation: false,
        sanitizedRelatedCharacterIds: dedupedCharIds,
        sanitizedRelatedEventIds: dedupedEventIds,
        verifiedSourceRevisionId: '',
      };
    }
  }

  if (input.resolvedEpisodeId && !projectEpisodes.has(input.resolvedEpisodeId)) {
    return {
      valid: false,
      error: '선택한 회수 회차(resolvedEpisodeId)가 현재 작품에 존재하지 않습니다.',
      warnings,
      requiresResolutionConfirmation: false,
      sanitizedRelatedCharacterIds: dedupedCharIds,
      sanitizedRelatedEventIds: dedupedEventIds,
      verifiedSourceRevisionId: '',
    };
  }

  if (input.resolvedSceneId) {
    const resolvedScene = projectScenes.get(input.resolvedSceneId);
    if (!resolvedScene) {
      return {
        valid: false,
        error: '선택한 회수 장면(resolvedSceneId)이 현재 작품에 존재하지 않습니다.',
        warnings,
        requiresResolutionConfirmation: false,
        sanitizedRelatedCharacterIds: dedupedCharIds,
        sanitizedRelatedEventIds: dedupedEventIds,
        verifiedSourceRevisionId: '',
      };
    }
    if (
      input.resolvedEpisodeId &&
      resolvedScene.episodeId !== input.resolvedEpisodeId
    ) {
      return {
        valid: false,
        error: '회수 장면(resolvedSceneId)이 선택한 회수 회차에 속하지 않습니다.',
        warnings,
        requiresResolutionConfirmation: false,
        sanitizedRelatedCharacterIds: dedupedCharIds,
        sanitizedRelatedEventIds: dedupedEventIds,
        verifiedSourceRevisionId: '',
      };
    }
  }

  // Check if resolved episode number is earlier than planted episode number
  if (input.plantedEpisodeId && input.resolvedEpisodeId) {
    const plantedEp = projectEpisodes.get(input.plantedEpisodeId);
    const resolvedEp = projectEpisodes.get(input.resolvedEpisodeId);
    if (
      plantedEp &&
      resolvedEp &&
      resolvedEp.episodeNumber < plantedEp.episodeNumber
    ) {
      warnings.push(
        `회수 회차(제${resolvedEp.episodeNumber}화)가 설치 회차(제${plantedEp.episodeNumber}화)보다 앞선 회차로 지정되어 있습니다.`
      );
    }
  }

  for (const charId of dedupedCharIds) {
    if (!projectCharacters.has(charId)) {
      return {
        valid: false,
        error: `현재 작품에 존재하지 않는 등장인물 ID(${charId})는 연결할 수 없습니다.`,
        warnings,
        requiresResolutionConfirmation: false,
        sanitizedRelatedCharacterIds: dedupedCharIds,
        sanitizedRelatedEventIds: dedupedEventIds,
        verifiedSourceRevisionId: '',
      };
    }
  }

  for (const evtId of dedupedEventIds) {
    if (!projectEvents.has(evtId)) {
      return {
        valid: false,
        error: `현재 작품에 존재하지 않는 연표 사건 ID(${evtId})는 연결할 수 없습니다.`,
        warnings,
        requiresResolutionConfirmation: false,
        sanitizedRelatedCharacterIds: dedupedCharIds,
        sanitizedRelatedEventIds: dedupedEventIds,
        verifiedSourceRevisionId: '',
      };
    }
  }

  const transitioningToResolved =
    input.cluePhase === 'RESOLVED' && options?.previousPhase !== 'RESOLVED';

  if (input.cluePhase === 'RESOLVED' && !input.resolvedEpisodeId) {
    warnings.push(
      '회수 완료(RESOLVED) 단계이나 회수 회차(resolvedEpisodeId)가 아직 지정되지 않았습니다. 회수 회차를 연결하면 추적 정확도가 높아집니다.'
    );
  }

  const verifiedSourceRevisionId = resolveVerifiedSourceRevisionId({
    candidateRevisionId: input.sourceRevisionId,
    projectRevisions: context.revisions,
    projectId: context.projectId,
    existingVerifiedRevisionId: options?.existingSourceRevisionId,
  });

  return {
    valid: true,
    warnings,
    requiresResolutionConfirmation: transitioningToResolved,
    sanitizedRelatedCharacterIds: dedupedCharIds,
    sanitizedRelatedEventIds: dedupedEventIds,
    verifiedSourceRevisionId,
  };
}

export function detectForeshadowingBrokenReferences(
  item: Foreshadowing,
  context: ProjectEntityContext
): {
  hasBrokenRef: boolean;
  missingPlantedEpisode: boolean;
  missingPlantedScene: boolean;
  missingResolvedEpisode: boolean;
  missingResolvedScene: boolean;
  missingCharacterIds: string[];
  missingEventIds: string[];
} {
  const epIds = new Set(
    context.episodes
      .filter((e) => e.projectId === context.projectId)
      .map((e) => e.id)
  );
  const scIds = new Set(
    context.scenes
      .filter((s) => s.projectId === context.projectId)
      .map((s) => s.id)
  );
  const charIds = new Set(
    context.characters
      .filter((c) => c.projectId === context.projectId)
      .map((c) => c.id)
  );
  const evtIds = new Set(
    context.timelineEvents
      .filter((ev) => ev.projectId === context.projectId)
      .map((ev) => ev.id)
  );

  const missingPlantedEpisode = Boolean(
    item.plantedEpisodeId && !epIds.has(item.plantedEpisodeId)
  );
  const missingPlantedScene = Boolean(
    item.plantedSceneId && !scIds.has(item.plantedSceneId)
  );
  const missingResolvedEpisode = Boolean(
    item.resolvedEpisodeId && !epIds.has(item.resolvedEpisodeId)
  );
  const missingResolvedScene = Boolean(
    item.resolvedSceneId && !scIds.has(item.resolvedSceneId)
  );
  const missingCharacterIds = (item.relatedCharacterIds || []).filter(
    (id) => !charIds.has(id)
  );
  const missingEventIds = (item.relatedEventIds || []).filter(
    (id) => !evtIds.has(id)
  );

  const hasBrokenRef =
    missingPlantedEpisode ||
    missingPlantedScene ||
    missingResolvedEpisode ||
    missingResolvedScene ||
    missingCharacterIds.length > 0 ||
    missingEventIds.length > 0;

  return {
    hasBrokenRef,
    missingPlantedEpisode,
    missingPlantedScene,
    missingResolvedEpisode,
    missingResolvedScene,
    missingCharacterIds,
    missingEventIds,
  };
}

export function filterForeshadowings(
  foreshadowings: readonly Foreshadowing[],
  filters: {
    projectId: string;
    phaseFilter?: 'all' | 'UNRESOLVED' | ForeshadowingPhase;
    statusFilter?: 'all' | CanonStatus;
    characterId?: string;
    episodeId?: string;
    searchQuery?: string;
  }
): Foreshadowing[] {
  const q = (filters.searchQuery ?? '').trim().toLowerCase();
  const phaseFilter = filters.phaseFilter ?? 'all';
  const statusFilter = filters.statusFilter ?? 'all';
  const characterId = filters.characterId ?? 'all';
  const episodeId = filters.episodeId ?? 'all';

  return foreshadowings.filter((item) => {
    if (item.projectId !== filters.projectId) return false;
    if (statusFilter !== 'all' && item.canonStatus !== statusFilter) return false;

    if (phaseFilter === 'UNRESOLVED') {
      if (item.cluePhase !== 'PLANTED' && item.cluePhase !== 'REINFORCED') {
        return false;
      }
    } else if (phaseFilter !== 'all' && item.cluePhase !== phaseFilter) {
      return false;
    }

    if (
      characterId !== 'all' &&
      !(item.relatedCharacterIds || []).includes(characterId)
    ) {
      return false;
    }

    if (
      episodeId !== 'all' &&
      item.plantedEpisodeId !== episodeId &&
      item.resolvedEpisodeId !== episodeId
    ) {
      return false;
    }

    if (!q) return true;
    return (
      item.title.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q)
    );
  });
}

export function computeForeshadowingDiffs(
  before: Foreshadowing,
  after: Foreshadowing,
  lookups: {
    formatEpisode: (id: string) => string;
    formatScene: (id: string) => string;
    formatCharacter: (id: string) => string;
    formatEvent: (id: string) => string;
  }
): FieldDiffItem[] {
  const diffs: FieldDiffItem[] = [];

  if (before.title !== after.title) {
    diffs.push({
      label: '복선 제목',
      before: before.title,
      after: after.title,
    });
  }
  if (before.cluePhase !== after.cluePhase) {
    diffs.push({
      label: '복선 진행 단계 (cluePhase)',
      before: formatForeshadowingPhaseKorean(before.cluePhase),
      after: formatForeshadowingPhaseKorean(after.cluePhase),
    });
  }
  if (before.canonStatus !== after.canonStatus) {
    diffs.push({
      label: '정사(CANON) 상태',
      before: formatCanonStatusKorean(before.canonStatus),
      after: formatCanonStatusKorean(after.canonStatus),
    });
  }
  if (before.description !== after.description) {
    diffs.push({
      label: '복선 상세 설명 및 회수 조건',
      before: before.description || '(비어 있음)',
      after: after.description || '(비어 있음)',
    });
  }
  if ((before.plantedEpisodeId || '') !== (after.plantedEpisodeId || '')) {
    diffs.push({
      label: '설치 회차 (plantedEpisodeId)',
      before: lookups.formatEpisode(before.plantedEpisodeId),
      after: lookups.formatEpisode(after.plantedEpisodeId),
    });
  }
  if ((before.plantedSceneId || '') !== (after.plantedSceneId || '')) {
    diffs.push({
      label: '설치 장면 (plantedSceneId)',
      before: lookups.formatScene(before.plantedSceneId),
      after: lookups.formatScene(after.plantedSceneId),
    });
  }
  if ((before.resolvedEpisodeId || '') !== (after.resolvedEpisodeId || '')) {
    diffs.push({
      label: '회수 회차 (resolvedEpisodeId)',
      before: lookups.formatEpisode(before.resolvedEpisodeId),
      after: lookups.formatEpisode(after.resolvedEpisodeId),
    });
  }
  if ((before.resolvedSceneId || '') !== (after.resolvedSceneId || '')) {
    diffs.push({
      label: '회수 장면 (resolvedSceneId)',
      before: lookups.formatScene(before.resolvedSceneId),
      after: lookups.formatScene(after.resolvedSceneId),
    });
  }

  const beforeChars = (before.relatedCharacterIds || [])
    .map(lookups.formatCharacter)
    .join(', ');
  const afterChars = (after.relatedCharacterIds || [])
    .map(lookups.formatCharacter)
    .join(', ');
  if (beforeChars !== afterChars) {
    diffs.push({
      label: '관련 등장인물',
      before: beforeChars || '(없음)',
      after: afterChars || '(없음)',
    });
  }

  const beforeEvents = (before.relatedEventIds || [])
    .map(lookups.formatEvent)
    .join(', ');
  const afterEvents = (after.relatedEventIds || [])
    .map(lookups.formatEvent)
    .join(', ');
  if (beforeEvents !== afterEvents) {
    diffs.push({
      label: '관련 연표 사건',
      before: beforeEvents || '(없음)',
      after: afterEvents || '(없음)',
    });
  }

  return diffs;
}

// ============================================================================
// Relationship & Timeline Pure Validation Helpers for UI & Automated Tests
// ============================================================================

export function validateProjectScopedRelationship(
  input: {
    sourceCharacterId: string;
    targetCharacterId: string;
    relationType: string;
    affinityScore: number;
    isDirectional: boolean;
    description: string;
    canonStatus: CanonStatus;
    effectiveEpisodeId?: string;
    effectiveEventId?: string;
    sourceRevisionId?: string;
  },
  context: {
    projectId: string;
    characters: readonly Character[];
    episodes: readonly Episode[];
    timelineEvents: readonly TimelineEvent[];
    existingRelationships: readonly CharacterRelationship[];
    revisions: readonly Revision[];
    editingRelationshipId?: string;
    existingSourceRevisionId?: string;
  }
): {
  valid: boolean;
  error?: string;
  verifiedSourceRevisionId: string;
} {
  const cleanSourceId = (input.sourceCharacterId ?? '').trim();
  const cleanTargetId = (input.targetCharacterId ?? '').trim();
  const cleanRelationType = (input.relationType ?? '').trim();

  if (cleanSourceId && cleanSourceId === cleanTargetId) {
    return {
      valid: false,
      error: '동일한 인물 간에는 관계를 설정할 수 없습니다 (자기 자신과의 관계 금지).',
      verifiedSourceRevisionId: '',
    };
  }

  const charIds = new Set(
    context.characters
      .filter((c) => c.projectId === context.projectId)
      .map((c) => c.id)
  );
  if (!charIds.has(cleanSourceId)) {
    return {
      valid: false,
      error: '현재 작품에 존재하는 출발 인물을 선택해 주세요.',
      verifiedSourceRevisionId: '',
    };
  }
  if (!charIds.has(cleanTargetId)) {
    return {
      valid: false,
      error: '현재 작품에 존재하는 대상 인물을 선택해 주세요.',
      verifiedSourceRevisionId: '',
    };
  }

  if (input.effectiveEpisodeId) {
    const epExists = context.episodes.some(
      (e) => e.projectId === context.projectId && e.id === input.effectiveEpisodeId
    );
    if (!epExists) {
      return {
        valid: false,
        error: '선택한 발효 회차가 현재 작품에 존재하지 않습니다.',
        verifiedSourceRevisionId: '',
      };
    }
  }

  if (input.effectiveEventId) {
    const evtExists = context.timelineEvents.some(
      (ev) => ev.projectId === context.projectId && ev.id === input.effectiveEventId
    );
    if (!evtExists) {
      return {
        valid: false,
        error: '선택한 연표 사건이 현재 작품에 존재하지 않습니다.',
        verifiedSourceRevisionId: '',
      };
    }
  }

  const baseCheck = validateCharacterRelationshipInput({
    sourceCharacterId: cleanSourceId,
    targetCharacterId: cleanTargetId,
    relationType: cleanRelationType,
    affinityScore: input.affinityScore,
    isDirectional: input.isDirectional,
    description: input.description,
    canonStatus: input.canonStatus,
  });

  if (!baseCheck.valid) {
    return {
      valid: false,
      error: baseCheck.error,
      verifiedSourceRevisionId: '',
    };
  }

  const normalizedType = cleanRelationType.toLowerCase();
  const duplicate = context.existingRelationships.find((other) => {
    if (other.projectId !== context.projectId) return false;
    if (context.editingRelationshipId && other.id === context.editingRelationshipId) {
      return false;
    }
    if (other.canonStatus === 'REJECTED' || other.canonStatus === 'ARCHIVED') {
      return false;
    }
    if (other.relationType.trim().toLowerCase() !== normalizedType) return false;
    if ((other.effectiveEpisodeId || '') !== (input.effectiveEpisodeId || '')) {
      return false;
    }

    const exactPair =
      other.sourceCharacterId === cleanSourceId &&
      other.targetCharacterId === cleanTargetId;
    const reversePair =
      other.sourceCharacterId === cleanTargetId &&
      other.targetCharacterId === cleanSourceId;

    if (!input.isDirectional || !other.isDirectional) {
      return exactPair || reversePair;
    }
    return exactPair;
  });

  if (duplicate) {
    return {
      valid: false,
      error: '동일한 두 인물 사이에 같은 유형 및 발효 회차의 관계가 이미 등록되어 있습니다.',
      verifiedSourceRevisionId: '',
    };
  }

  const verifiedSourceRevisionId = resolveVerifiedSourceRevisionId({
    candidateRevisionId: input.sourceRevisionId,
    projectRevisions: context.revisions,
    projectId: context.projectId,
    existingVerifiedRevisionId: context.existingSourceRevisionId,
  });

  return {
    valid: true,
    verifiedSourceRevisionId,
  };
}

export function sortTimelineEvents(
  events: readonly TimelineEvent[],
  sortMode: 'chronological_asc' | 'chronological_desc' | 'episode_order',
  episodeMap: ReadonlyMap<string, Episode>
): TimelineEvent[] {
  return [...events].sort((a, b) => {
    if (sortMode === 'chronological_desc') {
      if (b.chronologicalOrder !== a.chronologicalOrder) {
        return b.chronologicalOrder - a.chronologicalOrder;
      }
      return a.title.localeCompare(b.title);
    }
    if (sortMode === 'episode_order') {
      const epA = a.episodeId ? episodeMap.get(a.episodeId)?.episodeNumber ?? 99999 : 99999;
      const epB = b.episodeId ? episodeMap.get(b.episodeId)?.episodeNumber ?? 99999 : 99999;
      if (epA !== epB) return epA - epB;
      return a.chronologicalOrder - b.chronologicalOrder;
    }
    if (a.chronologicalOrder !== b.chronologicalOrder) {
      return a.chronologicalOrder - b.chronologicalOrder;
    }
    return a.title.localeCompare(b.title);
  });
}

export function detectNonlinearTimelineEventIds(
  events: readonly TimelineEvent[],
  episodeMap: ReadonlyMap<string, Episode>
): Set<string> {
  const set = new Set<string>();
  const withEpisodes = events
    .map((evt) => ({
      evt,
      epNum: evt.episodeId ? episodeMap.get(evt.episodeId)?.episodeNumber : undefined,
    }))
    .sort((a, b) => {
      const epA = a.epNum ?? 999999;
      const epB = b.epNum ?? 999999;
      if (epA !== epB) return epA - epB;
      return a.evt.chronologicalOrder - b.evt.chronologicalOrder;
    });

  let maxChronoSeen = -Infinity;
  for (const { evt, epNum } of withEpisodes) {
    if (evt.chronologicalOrder < 0) {
      set.add(evt.id);
    }
    if (epNum !== undefined) {
      if (evt.chronologicalOrder < maxChronoSeen) {
        set.add(evt.id);
      }
      if (evt.chronologicalOrder > maxChronoSeen) {
        maxChronoSeen = evt.chronologicalOrder;
      }
    }
  }
  return set;
}

export function isolateProjectBundleEntities(
  bundle: ProjectBundle | null | undefined,
  activeProjectId: string
): {
  characters: Character[];
  worldbuilding: WorldbuildingItem[];
  episodes: Episode[];
  revisions: Revision[];
  scenes: Scene[];
  relationships: CharacterRelationship[];
  timelineEvents: TimelineEvent[];
  foreshadowings: Foreshadowing[];
} {
  if (!bundle || !activeProjectId || bundle.project.id !== activeProjectId) {
    return {
      characters: [],
      worldbuilding: [],
      episodes: [],
      revisions: [],
      scenes: [],
      relationships: [],
      timelineEvents: [],
      foreshadowings: [],
    };
  }

  return {
    characters: (bundle.characters || []).filter((c) => c.projectId === activeProjectId),
    worldbuilding: (bundle.worldbuilding || []).filter(
      (w) => w.projectId === activeProjectId
    ),
    episodes: (bundle.episodes || []).filter((e) => e.projectId === activeProjectId),
    revisions: (bundle.revisions || []).filter((r) => r.projectId === activeProjectId),
    scenes: (bundle.scenes || []).filter((s) => s.projectId === activeProjectId),
    relationships: (bundle.relationships || []).filter(
      (r) => r.projectId === activeProjectId
    ),
    timelineEvents: (bundle.timelineEvents || []).filter(
      (ev) => ev.projectId === activeProjectId
    ),
    foreshadowings: (bundle.foreshadowings || []).filter(
      (f) => f.projectId === activeProjectId
    ),
  };
}
