import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  Clock,
  Edit3,
  Eye,
  GitBranch,
  GitCompare,
  Plus,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type {
  CanonStatus,
  Character,
  CharacterRelationship,
  Episode,
  Foreshadowing,
  ForeshadowingPhase,
  Project,
  Revision,
  Scene,
  TimelineEvent,
  WorldbuildingItem,
} from '../types/novel';
import {
  formatCanonStatusKorean,
  traceForeshadowingHierarchyChain,
} from '../utils/foundationLogic';
import {
  CANON_CONFIRMATION_MESSAGE,
  computeForeshadowingDiffs,
  detectForeshadowingBrokenReferences,
  filterForeshadowings,
  formatForeshadowingPhaseKorean,
  resolveVerifiedSourceRevisionId,
  validateProjectScopedForeshadowing,
  type FieldDiffItem,
} from '../utils/phase4ManagementLogic';

export interface ForeshadowingViewProps {
  project: Project;
  foreshadowings: Foreshadowing[];
  episodes: Episode[];
  scenes: Scene[];
  characters: Character[];
  timelineEvents: TimelineEvent[];
  worldbuilding: WorldbuildingItem[];
  relationships: CharacterRelationship[];
  revisions: Revision[];
  onCreateForeshadowing: (
    data: Omit<
      Foreshadowing,
      'id' | 'ownerId' | 'projectId' | 'createdAt' | 'updatedAt'
    >
  ) => Promise<void>;
  onUpdateForeshadowing: (
    foreshadowing: Foreshadowing,
    currentCanonStatus: CanonStatus
  ) => Promise<void>;
  onDeleteForeshadowing: (
    foreshadowingId: string,
    currentCanonStatus: CanonStatus
  ) => Promise<void>;
  onNavigateToEpisode?: (episodeId: string) => void;
  onNavigateToTimeline?: () => void;
  onNavigateToCharacters?: () => void;
}

const PHASE_OPTIONS: { value: ForeshadowingPhase; label: string; desc: string }[] = [
  {
    value: 'PLANTED',
    label: '설치됨 (PLANTED)',
    desc: '작품에 단서나 암시가 처음 심어진 단계',
  },
  {
    value: 'REINFORCED',
    label: '강화됨 (REINFORCED)',
    desc: '후속 회차나 사건을 통해 단서가 재언급·심화된 단계',
  },
  {
    value: 'RESOLVED',
    label: '회수 완료 (RESOLVED)',
    desc: '진실이 밝혀지거나 사건으로 복선이 회수된 단계',
  },
  {
    value: 'ABANDONED',
    label: '폐기 보류 (ABANDONED)',
    desc: '플롯 변경 등으로 회수하지 않기로 보류한 단계 (기록 보존)',
  },
];

export const ForeshadowingView: React.FC<ForeshadowingViewProps> = ({
  project,
  foreshadowings,
  episodes,
  scenes,
  characters,
  timelineEvents,
  worldbuilding,
  relationships,
  revisions,
  onCreateForeshadowing,
  onUpdateForeshadowing,
  onDeleteForeshadowing,
  onNavigateToEpisode,
  onNavigateToTimeline,
  onNavigateToCharacters,
}) => {
  const projectId = project.id;

  // Filter states
  const [phaseFilter, setPhaseFilter] = useState<
    'all' | 'UNRESOLVED' | ForeshadowingPhase
  >('all');
  const [statusFilter, setStatusFilter] = useState<'all' | CanonStatus>('all');
  const [characterFilter, setCharacterFilter] = useState<string>('all');
  const [episodeFilter, setEpisodeFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Selected item for hierarchy chain trace preview
  const [inspectedForeshadowingId, setInspectedForeshadowingId] = useState<
    string | null
  >(null);

  // Form states
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingForeshadowing, setEditingForeshadowing] =
    useState<Foreshadowing | null>(null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [cluePhase, setCluePhase] = useState<ForeshadowingPhase>('PLANTED');
  const [canonStatus, setCanonStatus] = useState<CanonStatus>('DRAFT');
  const [plantedEpisodeId, setPlantedEpisodeId] = useState('');
  const [plantedSceneId, setPlantedSceneId] = useState('');
  const [resolvedEpisodeId, setResolvedEpisodeId] = useState('');
  const [resolvedSceneId, setResolvedSceneId] = useState('');
  const [relatedCharacterIds, setRelatedCharacterIds] = useState<string[]>([]);
  const [relatedEventIds, setRelatedEventIds] = useState<string[]>([]);
  const [sourceRevisionId, setSourceRevisionId] = useState('');

  const [formError, setFormError] = useState<string | null>(null);
  const [formWarnings, setFormWarnings] = useState<string[]>([]);
  const [actionBanner, setActionBanner] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Confirmation modals
  const [promoteTarget, setPromoteTarget] = useState<Foreshadowing | null>(null);
  const [canonConfirmPending, setCanonConfirmPending] = useState<{
    original: Foreshadowing;
    updated: Foreshadowing;
    diffs: FieldDiffItem[];
  } | null>(null);
  const [resolutionConfirmPending, setResolutionConfirmPending] = useState<{
    mode: 'create' | 'update';
    original?: Foreshadowing;
    candidate: Omit<
      Foreshadowing,
      'id' | 'ownerId' | 'projectId' | 'createdAt' | 'updatedAt'
    >;
    warnings: string[];
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Foreshadowing | null>(null);

  // Scoped lookup maps
  const episodeMap = useMemo(() => {
    const map = new Map<string, Episode>();
    for (const ep of episodes) {
      if (ep.projectId === projectId) map.set(ep.id, ep);
    }
    return map;
  }, [episodes, projectId]);

  const sceneMap = useMemo(() => {
    const map = new Map<string, Scene>();
    for (const sc of scenes) {
      if (sc.projectId === projectId) map.set(sc.id, sc);
    }
    return map;
  }, [scenes, projectId]);

  const characterMap = useMemo(() => {
    const map = new Map<string, Character>();
    for (const c of characters) {
      if (c.projectId === projectId) map.set(c.id, c);
    }
    return map;
  }, [characters, projectId]);

  const eventMap = useMemo(() => {
    const map = new Map<string, TimelineEvent>();
    for (const evt of timelineEvents) {
      if (evt.projectId === projectId) map.set(evt.id, evt);
    }
    return map;
  }, [timelineEvents, projectId]);

  const projectEpisodes = useMemo(
    () =>
      episodes
        .filter((e) => e.projectId === projectId)
        .sort((a, b) => a.episodeNumber - b.episodeNumber),
    [episodes, projectId]
  );

  const projectScenes = useMemo(
    () =>
      scenes
        .filter((s) => s.projectId === projectId)
        .sort((a, b) => a.sceneNumber - b.sceneNumber),
    [scenes, projectId]
  );

  const projectCharacters = useMemo(
    () => characters.filter((c) => c.projectId === projectId),
    [characters, projectId]
  );

  const projectEvents = useMemo(
    () =>
      timelineEvents
        .filter((e) => e.projectId === projectId)
        .sort((a, b) => a.chronologicalOrder - b.chronologicalOrder),
    [timelineEvents, projectId]
  );

  const projectRevisions = useMemo(
    () => revisions.filter((r) => r.projectId === projectId),
    [revisions, projectId]
  );

  const projectForeshadowings = useMemo(
    () => foreshadowings.filter((f) => f.projectId === projectId),
    [foreshadowings, projectId]
  );

  const entityContext = useMemo(
    () => ({
      projectId,
      episodes: projectEpisodes,
      scenes: projectScenes,
      characters: projectCharacters,
      timelineEvents: projectEvents,
      foreshadowings: projectForeshadowings,
      worldbuilding: worldbuilding.filter((w) => w.projectId === projectId),
      revisions: projectRevisions,
    }),
    [
      projectId,
      projectEpisodes,
      projectScenes,
      projectCharacters,
      projectEvents,
      projectForeshadowings,
      worldbuilding,
      projectRevisions,
    ]
  );

  const filteredForeshadowings = useMemo(
    () =>
      filterForeshadowings(projectForeshadowings, {
        projectId,
        phaseFilter,
        statusFilter,
        characterId: characterFilter,
        episodeId: episodeFilter,
        searchQuery,
      }),
    [
      projectForeshadowings,
      projectId,
      phaseFilter,
      statusFilter,
      characterFilter,
      episodeFilter,
      searchQuery,
    ]
  );

  const stats = useMemo(() => {
    let unresolvedCount = 0;
    let resolvedCount = 0;
    let canonCount = 0;
    let brokenRefCount = 0;

    for (const item of projectForeshadowings) {
      if (item.cluePhase === 'PLANTED' || item.cluePhase === 'REINFORCED') {
        unresolvedCount += 1;
      } else if (item.cluePhase === 'RESOLVED') {
        resolvedCount += 1;
      }
      if (item.canonStatus === 'CANON') {
        canonCount += 1;
      }
      const broken = detectForeshadowingBrokenReferences(item, entityContext);
      if (broken.hasBrokenRef) {
        brokenRefCount += 1;
      }
    }

    return {
      total: projectForeshadowings.length,
      unresolvedCount,
      resolvedCount,
      canonCount,
      brokenRefCount,
    };
  }, [projectForeshadowings, entityContext]);

  const inspectedItem = useMemo(() => {
    if (!inspectedForeshadowingId) return null;
    return (
      projectForeshadowings.find((f) => f.id === inspectedForeshadowingId) || null
    );
  }, [projectForeshadowings, inspectedForeshadowingId]);

  const inspectedTrace = useMemo(() => {
    if (!inspectedItem) return null;
    return traceForeshadowingHierarchyChain({
      project,
      foreshadowing: inspectedItem,
      episodes: projectEpisodes,
      scenes: projectScenes,
      characters: projectCharacters,
      events: projectEvents,
    });
  }, [
    inspectedItem,
    project,
    projectEpisodes,
    projectScenes,
    projectCharacters,
    projectEvents,
  ]);

  const formatEpisodeLabel = (epId: string) => {
    if (!epId) return '(미지정)';
    const ep = episodeMap.get(epId);
    return ep ? `제${ep.episodeNumber}화: ${ep.title}` : `[삭제된 회차: ${epId}]`;
  };

  const formatSceneLabel = (scId: string) => {
    if (!scId) return '(미지정)';
    const sc = sceneMap.get(scId);
    return sc ? `장면 #${sc.sceneNumber}: ${sc.title}` : `[삭제된 장면: ${scId}]`;
  };

  const formatCharacterLabel = (cId: string) => {
    const c = characterMap.get(cId);
    return c ? c.name : `[삭제된 인물: ${cId}]`;
  };

  const formatEventLabel = (eId: string) => {
    const ev = eventMap.get(eId);
    return ev ? `${ev.title} (${ev.inUniverseDate})` : `[삭제된 사건: ${eId}]`;
  };

  const openCreateForm = () => {
    setEditingForeshadowing(null);
    setTitle('');
    setDescription('');
    setCluePhase('PLANTED');
    // Rule: Author-created items always begin as DRAFT
    setCanonStatus('DRAFT');
    setPlantedEpisodeId(projectEpisodes[0]?.id || '');
    setPlantedSceneId('');
    setResolvedEpisodeId('');
    setResolvedSceneId('');
    setRelatedCharacterIds([]);
    setRelatedEventIds([]);
    setSourceRevisionId('');
    setFormError(null);
    setFormWarnings([]);
    setIsFormOpen(true);
  };

  const openEditForm = (item: Foreshadowing) => {
    const storedOriginal =
      projectForeshadowings.find((f) => f.id === item.id) || item;
    setEditingForeshadowing(storedOriginal);
    setTitle(storedOriginal.title);
    setDescription(storedOriginal.description);
    setCluePhase(storedOriginal.cluePhase);
    setCanonStatus(storedOriginal.canonStatus);
    setPlantedEpisodeId(storedOriginal.plantedEpisodeId || '');
    setPlantedSceneId(storedOriginal.plantedSceneId || '');
    setResolvedEpisodeId(storedOriginal.resolvedEpisodeId || '');
    setResolvedSceneId(storedOriginal.resolvedSceneId || '');
    setRelatedCharacterIds([...(storedOriginal.relatedCharacterIds || [])]);
    setRelatedEventIds([...(storedOriginal.relatedEventIds || [])]);
    setSourceRevisionId(storedOriginal.sourceRevisionId || '');
    setFormError(null);
    setFormWarnings([]);
    setIsFormOpen(true);
  };

  const closeForm = () => {
    setIsFormOpen(false);
    setEditingForeshadowing(null);
    setFormError(null);
    setFormWarnings([]);
  };

  const toggleCharacterSelection = (charId: string) => {
    setRelatedCharacterIds((prev) =>
      prev.includes(charId)
        ? prev.filter((id) => id !== charId)
        : [...prev, charId]
    );
  };

  const toggleEventSelection = (evtId: string) => {
    setRelatedEventIds((prev) =>
      prev.includes(evtId)
        ? prev.filter((id) => id !== evtId)
        : [...prev, evtId]
    );
  };

  const finalizeSave = async (
    mode: 'create' | 'update',
    candidate: Omit<
      Foreshadowing,
      'id' | 'ownerId' | 'projectId' | 'createdAt' | 'updatedAt'
    >,
    originalItem?: Foreshadowing
  ) => {
    if (mode === 'create') {
      setIsSubmitting(true);
      try {
        await onCreateForeshadowing({
          ...candidate,
          canonStatus: 'DRAFT',
          createdBy: 'AUTHOR',
        });
        setActionBanner(
          `신규 복선 "${candidate.title}" 항목이 초안(DRAFT) 상태로 등록되었습니다.`
        );
        closeForm();
      } catch (err) {
        setFormError(
          err instanceof Error
            ? err.message
            : '복선 등록 중 오류가 발생했습니다.'
        );
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (!originalItem) return;
    const storedOriginal =
      projectForeshadowings.find((f) => f.id === originalItem.id) ||
      originalItem;
    const priorCanonStatus = storedOriginal.canonStatus;

    const updatedItem: Foreshadowing = {
      ...storedOriginal,
      ...candidate,
    };

    // 6-step CANON modification flow when stored original is CANON
    if (priorCanonStatus === 'CANON') {
      const diffs = computeForeshadowingDiffs(storedOriginal, updatedItem, {
        formatEpisode: formatEpisodeLabel,
        formatScene: formatSceneLabel,
        formatCharacter: formatCharacterLabel,
        formatEvent: formatEventLabel,
      });

      if (diffs.length === 0) {
        closeForm();
        return;
      }

      setCanonConfirmPending({
        original: storedOriginal,
        updated: updatedItem,
        diffs,
      });
      return;
    }

    // If promoting from non-CANON to CANON inside the edit form, require explicit confirmation
    if (updatedItem.canonStatus === 'CANON') {
      const diffs = computeForeshadowingDiffs(storedOriginal, updatedItem, {
        formatEpisode: formatEpisodeLabel,
        formatScene: formatSceneLabel,
        formatCharacter: formatCharacterLabel,
        formatEvent: formatEventLabel,
      });
      setCanonConfirmPending({
        original: storedOriginal,
        updated: updatedItem,
        diffs,
      });
      return;
    }

    setIsSubmitting(true);
    try {
      await onUpdateForeshadowing(updatedItem, priorCanonStatus);
      setActionBanner(`복선 "${updatedItem.title}" 변경 사항이 저장되었습니다.`);
      closeForm();
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : '복선 수정 중 오류가 발생했습니다.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setFormWarnings([]);

    const storedOriginal = editingForeshadowing
      ? projectForeshadowings.find((f) => f.id === editingForeshadowing.id) ||
        editingForeshadowing
      : undefined;

    // Rule: cluePhase transition never auto-promotes canonStatus
    const effectiveCanonStatus: CanonStatus = storedOriginal
      ? canonStatus
      : 'DRAFT';

    const validation = validateProjectScopedForeshadowing(
      {
        title,
        description,
        cluePhase,
        canonStatus: effectiveCanonStatus,
        plantedEpisodeId,
        plantedSceneId,
        resolvedEpisodeId,
        resolvedSceneId,
        relatedCharacterIds,
        relatedEventIds,
        sourceRevisionId,
      },
      entityContext,
      {
        previousPhase: storedOriginal?.cluePhase,
        existingSourceRevisionId: storedOriginal?.sourceRevisionId,
      }
    );

    if (!validation.valid) {
      setFormError(validation.error || '복선 입력값을 확인해 주세요.');
      return;
    }

    setFormWarnings(validation.warnings);

    const candidatePayload: Omit<
      Foreshadowing,
      'id' | 'ownerId' | 'projectId' | 'createdAt' | 'updatedAt'
    > = {
      title: title.trim(),
      description: description.trim(),
      cluePhase,
      canonStatus: effectiveCanonStatus,
      plantedEpisodeId: plantedEpisodeId.trim(),
      plantedSceneId: plantedSceneId.trim(),
      resolvedEpisodeId: resolvedEpisodeId.trim(),
      resolvedSceneId: resolvedSceneId.trim(),
      relatedCharacterIds: validation.sanitizedRelatedCharacterIds,
      relatedEventIds: validation.sanitizedRelatedEventIds,
      createdBy: storedOriginal?.createdBy || 'AUTHOR',
      sourceRevisionId: validation.verifiedSourceRevisionId,
    };

    // If transitioning to RESOLVED, ask explicit resolution confirmation first
    if (validation.requiresResolutionConfirmation) {
      setResolutionConfirmPending({
        mode: storedOriginal ? 'update' : 'create',
        original: storedOriginal,
        candidate: candidatePayload,
        warnings: validation.warnings,
      });
      return;
    }

    await finalizeSave(
      storedOriginal ? 'update' : 'create',
      candidatePayload,
      storedOriginal
    );
  };

  const handleConfirmResolutionTransition = async () => {
    if (!resolutionConfirmPending) return;
    const { mode, original, candidate } = resolutionConfirmPending;
    setResolutionConfirmPending(null);
    await finalizeSave(mode, candidate, original);
  };

  const handleConfirmCanonUpdate = async () => {
    if (!canonConfirmPending) return;
    setIsSubmitting(true);
    try {
      await onUpdateForeshadowing(
        canonConfirmPending.updated,
        canonConfirmPending.original.canonStatus
      );
      setActionBanner(
        `정사(CANON) 복선 "${canonConfirmPending.updated.title}" 변경 사항이 작가 승인을 거쳐 저장되었습니다.`
      );
      setCanonConfirmPending(null);
      closeForm();
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : '정사 복선 저장 중 오류가 발생했습니다.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmPromoteToCanon = async () => {
    if (!promoteTarget) return;
    const storedOriginal =
      projectForeshadowings.find((f) => f.id === promoteTarget.id) ||
      promoteTarget;
    setIsSubmitting(true);
    try {
      const verifiedRevId = resolveVerifiedSourceRevisionId({
        candidateRevisionId: storedOriginal.sourceRevisionId,
        projectRevisions,
        projectId,
      });
      await onUpdateForeshadowing(
        {
          ...storedOriginal,
          canonStatus: 'CANON',
          sourceRevisionId: verifiedRevId,
        },
        storedOriginal.canonStatus
      );
      setActionBanner(
        `복선 "${storedOriginal.title}" 항목이 정사(CANON)로 확정되었습니다.`
      );
      setPromoteTarget(null);
    } catch (err) {
      setActionBanner(
        err instanceof Error
          ? `정사 승격 실패: ${err.message}`
          : '정사 승격 중 오류가 발생했습니다.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleQuickPhaseTransition = async (
    item: Foreshadowing,
    nextPhase: ForeshadowingPhase
  ) => {
    const storedOriginal =
      projectForeshadowings.find((f) => f.id === item.id) || item;
    if (storedOriginal.cluePhase === nextPhase) return;

    const validation = validateProjectScopedForeshadowing(
      {
        title: storedOriginal.title,
        description: storedOriginal.description,
        cluePhase: nextPhase,
        // Strictly preserve existing canonStatus — never auto-promote to CANON
        canonStatus: storedOriginal.canonStatus,
        plantedEpisodeId: storedOriginal.plantedEpisodeId,
        plantedSceneId: storedOriginal.plantedSceneId,
        resolvedEpisodeId: storedOriginal.resolvedEpisodeId,
        resolvedSceneId: storedOriginal.resolvedSceneId,
        relatedCharacterIds: storedOriginal.relatedCharacterIds,
        relatedEventIds: storedOriginal.relatedEventIds,
        sourceRevisionId: storedOriginal.sourceRevisionId,
      },
      entityContext,
      {
        previousPhase: storedOriginal.cluePhase,
        existingSourceRevisionId: storedOriginal.sourceRevisionId,
      }
    );

    if (!validation.valid) {
      setActionBanner(
        validation.error || '복선 단계 전환 중 검증 오류가 발생했습니다.'
      );
      return;
    }

    const candidatePayload: Omit<
      Foreshadowing,
      'id' | 'ownerId' | 'projectId' | 'createdAt' | 'updatedAt'
    > = {
      title: storedOriginal.title,
      description: storedOriginal.description,
      cluePhase: nextPhase,
      canonStatus: storedOriginal.canonStatus,
      plantedEpisodeId: storedOriginal.plantedEpisodeId,
      plantedSceneId: storedOriginal.plantedSceneId,
      resolvedEpisodeId: storedOriginal.resolvedEpisodeId,
      resolvedSceneId: storedOriginal.resolvedSceneId,
      relatedCharacterIds: validation.sanitizedRelatedCharacterIds,
      relatedEventIds: validation.sanitizedRelatedEventIds,
      createdBy: storedOriginal.createdBy,
      sourceRevisionId: validation.verifiedSourceRevisionId,
    };

    if (nextPhase === 'RESOLVED') {
      setResolutionConfirmPending({
        mode: 'update',
        original: storedOriginal,
        candidate: candidatePayload,
        warnings: validation.warnings,
      });
      return;
    }

    await finalizeSave('update', candidatePayload, storedOriginal);
  };

  const handleArchiveInsteadOfDelete = async (target: Foreshadowing) => {
    const storedOriginal =
      projectForeshadowings.find((f) => f.id === target.id) || target;
    setIsSubmitting(true);
    try {
      await onUpdateForeshadowing(
        {
          ...storedOriginal,
          canonStatus: 'ARCHIVED',
        },
        storedOriginal.canonStatus
      );
      setActionBanner(
        `복선 "${storedOriginal.title}" 항목이 삭제 대신 보관(ARCHIVED) 상태로 전환되었습니다.`
      );
      setDeleteTarget(null);
    } catch (err) {
      setActionBanner(
        err instanceof Error
          ? err.message
          : '보관(ARCHIVED) 전환 중 오류가 발생했습니다.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    const storedOriginal =
      projectForeshadowings.find((f) => f.id === deleteTarget.id) ||
      deleteTarget;
    setIsSubmitting(true);
    try {
      await onDeleteForeshadowing(storedOriginal.id, storedOriginal.canonStatus);
      if (inspectedForeshadowingId === storedOriginal.id) {
        setInspectedForeshadowingId(null);
      }
      setActionBanner(
        `복선 "${storedOriginal.title}" 항목이 삭제되었습니다. (연결된 회차·인물·연표 사건은 보존됨)`
      );
      setDeleteTarget(null);
    } catch (err) {
      setActionBanner(
        err instanceof Error ? err.message : '복선 삭제 중 오류가 발생했습니다.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const plantedScenesForSelectedEpisode = useMemo(() => {
    if (!plantedEpisodeId) return projectScenes;
    return projectScenes.filter((s) => s.episodeId === plantedEpisodeId);
  }, [projectScenes, plantedEpisodeId]);

  const resolvedScenesForSelectedEpisode = useMemo(() => {
    if (!resolvedEpisodeId) return projectScenes;
    return projectScenes.filter((s) => s.episodeId === resolvedEpisodeId);
  }, [projectScenes, resolvedEpisodeId]);

  const getPhaseBadgeStyle = (phase: ForeshadowingPhase) => {
    switch (phase) {
      case 'PLANTED':
        return 'border-amber-500/40 bg-amber-500/15 text-amber-300';
      case 'REINFORCED':
        return 'border-sky-500/40 bg-sky-500/15 text-sky-300';
      case 'RESOLVED':
        return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300';
      case 'ABANDONED':
        return 'border-slate-600 bg-slate-800 text-slate-400';
      default:
        return 'border-amber-500/40 bg-amber-500/15 text-amber-300';
    }
  };

  const getCanonBadgeStyle = (status: CanonStatus) => {
    switch (status) {
      case 'CANON':
        return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300';
      case 'PROPOSED':
        return 'border-purple-500/40 bg-purple-500/15 text-purple-300';
      case 'ARCHIVED':
        return 'border-slate-600 bg-slate-800 text-slate-400';
      case 'REJECTED':
        return 'border-rose-500/40 bg-rose-500/15 text-rose-300';
      default:
        return 'border-slate-700 bg-slate-800/90 text-slate-300';
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <Sparkles className="h-5 w-5 text-amber-400" />
            <h1 className="text-xl font-bold text-slate-100">
              복선 관리 (Foreshadowing Lifecycle)
            </h1>
          </div>
          <p className="text-xs text-slate-400">
            장편 웹소설의 복선 설치(PLANTED) · 강화(REINFORCED) · 회수 완료(RESOLVED) · 폐기 보류(ABANDONED) 생애주기와 정사(CANON) 승인을 독립적으로 관리합니다.
          </p>
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={openCreateForm}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors"
          >
            <Plus className="h-4 w-4" />
            <span>새 복선 등록</span>
          </button>
        </div>
      </div>

      {/* Action feedback banner */}
      {actionBanner && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-amber-400 shrink-0" />
            <span>{actionBanner}</span>
          </div>
          <button
            type="button"
            onClick={() => setActionBanner(null)}
            className="text-amber-300 hover:text-white whitespace-nowrap"
          >
            닫기
          </button>
        </div>
      )}

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="text-[11px] text-slate-400">전체 복선</div>
          <div className="mt-1 font-mono-tabular text-2xl font-bold text-slate-100">
            {stats.total}
          </div>
        </div>
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="text-[11px] text-amber-300">
            미회수 복선 (PLANTED + REINFORCED)
          </div>
          <div className="mt-1 font-mono-tabular text-2xl font-bold text-amber-300">
            {stats.unresolvedCount}
          </div>
        </div>
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
          <div className="text-[11px] text-emerald-300">
            회수 완료 (RESOLVED)
          </div>
          <div className="mt-1 font-mono-tabular text-2xl font-bold text-emerald-300">
            {stats.resolvedCount}
          </div>
        </div>
        <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-4">
          <div className="text-[11px] text-sky-300">정사 확정 (CANON)</div>
          <div className="mt-1 font-mono-tabular text-2xl font-bold text-sky-300">
            {stats.canonCount}
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 col-span-2 lg:col-span-1">
          <div className="text-[11px] text-slate-400">참조 누락 경고</div>
          <div
            className={`mt-1 font-mono-tabular text-2xl font-bold ${
              stats.brokenRefCount > 0 ? 'text-rose-400' : 'text-slate-300'
            }`}
          >
            {stats.brokenRefCount}
          </div>
        </div>
      </div>

      {/* Phase Quick Tabs & Search/Filter Bar */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              { key: 'all', label: `전체 (${projectForeshadowings.length})` },
              {
                key: 'UNRESOLVED',
                label: `미회수 단서 (${stats.unresolvedCount})`,
              },
              { key: 'PLANTED', label: '설치됨 (PLANTED)' },
              { key: 'REINFORCED', label: '강화됨 (REINFORCED)' },
              { key: 'RESOLVED', label: '회수 완료 (RESOLVED)' },
              { key: 'ABANDONED', label: '폐기 보류 (ABANDONED)' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setPhaseFilter(tab.key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                phaseFilter === tab.key
                  ? 'bg-amber-500 text-slate-950 font-semibold'
                  : 'border border-slate-800 bg-slate-950 text-slate-300 hover:bg-slate-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="복선 제목 또는 설명 검색..."
              className="w-full rounded-lg border border-slate-800 bg-slate-950 pl-9 pr-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
            />
          </div>

          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as 'all' | CanonStatus)
            }
            aria-label="정사 상태 필터"
            className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-200 focus:border-amber-500 focus:outline-none"
          >
            <option value="all">모든 정사 상태 (DRAFT / CANON / 보관)</option>
            <option value="CANON">정사 확정 (CANON)</option>
            <option value="DRAFT">초안 (DRAFT)</option>
            <option value="PROPOSED">제안됨 (PROPOSED)</option>
            <option value="ARCHIVED">보관됨 (ARCHIVED)</option>
          </select>

          <select
            value={characterFilter}
            onChange={(e) => setCharacterFilter(e.target.value)}
            aria-label="관련 인물 필터"
            className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-200 focus:border-amber-500 focus:outline-none"
          >
            <option value="all">모든 관련 인물</option>
            {projectCharacters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.role})
              </option>
            ))}
          </select>

          <select
            value={episodeFilter}
            onChange={(e) => setEpisodeFilter(e.target.value)}
            aria-label="설치 및 회수 회차 필터"
            className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-200 focus:border-amber-500 focus:outline-none"
          >
            <option value="all">모든 설치·회수 회차</option>
            {projectEpisodes.map((ep) => (
              <option key={ep.id} value={ep.id}>
                제{ep.episodeNumber}화: {ep.title}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Create / Edit Form Panel */}
      {isFormOpen && (
        <form
          onSubmit={handleFormSubmit}
          className="rounded-2xl border border-amber-500/40 bg-slate-900/95 p-6 space-y-5"
        >
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-amber-400" />
              <h2 className="text-base font-bold text-slate-100">
                {editingForeshadowing
                  ? `복선 수정: ${editingForeshadowing.title}`
                  : '새 복선 등록 (기본 상태: 초안 DRAFT)'}
              </h2>
            </div>
            <button
              type="button"
              onClick={closeForm}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {formError && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-200"
            >
              <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          {formWarnings.length > 0 && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-1 text-xs text-amber-200">
              {formWarnings.map((w, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                복선 제목 *
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="예: 부러진 은빛 회중시계의 두 번째 주인"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                복선 진행 단계 (cluePhase) *
              </label>
              <select
                value={cluePhase}
                onChange={(e) =>
                  setCluePhase(e.target.value as ForeshadowingPhase)
                }
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
              >
                {PHASE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-slate-400">
                단계 변경은 정사(CANON) 상태를 자동 변경하지 않습니다.
              </p>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              복선 상세 내용 및 회수 계획 / 조건 *
            </label>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="단서가 어떤 맥락에서 제시되었으며 향후 어떤 진실이나 사건으로 회수될지 기록하세요."
              className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
              required
            />
          </div>

          {/* Planted & Resolved Episode / Scene Selectors */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="space-y-3">
              <div className="text-xs font-semibold text-amber-300">
                1. 복선 설치 위치 (Planted Location)
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  설치 회차 (plantedEpisodeId)
                </label>
                <select
                  value={plantedEpisodeId}
                  onChange={(e) => {
                    setPlantedEpisodeId(e.target.value);
                    setPlantedSceneId('');
                  }}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                >
                  <option value="">(설치 회차 미지정)</option>
                  {projectEpisodes.map((ep) => (
                    <option key={ep.id} value={ep.id}>
                      제{ep.episodeNumber}화: {ep.title}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  설치 장면 (plantedSceneId · 선택)
                </label>
                <select
                  value={plantedSceneId}
                  onChange={(e) => setPlantedSceneId(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                >
                  <option value="">(설치 장면 미지정)</option>
                  {plantedScenesForSelectedEpisode.map((sc) => (
                    <option key={sc.id} value={sc.id}>
                      장면 #{sc.sceneNumber}: {sc.title}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-3">
              <div className="text-xs font-semibold text-emerald-300">
                2. 복선 회수 위치 (Resolved Location)
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  회수 회차 (resolvedEpisodeId)
                </label>
                <select
                  value={resolvedEpisodeId}
                  onChange={(e) => {
                    setResolvedEpisodeId(e.target.value);
                    setResolvedSceneId('');
                  }}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                >
                  <option value="">(회수 회차 미지정)</option>
                  {projectEpisodes.map((ep) => (
                    <option key={ep.id} value={ep.id}>
                      제{ep.episodeNumber}화: {ep.title}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  회수 장면 (resolvedSceneId · 선택)
                </label>
                <select
                  value={resolvedSceneId}
                  onChange={(e) => setResolvedSceneId(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                >
                  <option value="">(회수 장면 미지정)</option>
                  {resolvedScenesForSelectedEpisode.map((sc) => (
                    <option key={sc.id} value={sc.id}>
                      장면 #{sc.sceneNumber}: {sc.title}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Related Characters & Timeline Events */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-2">
              <div className="text-xs font-semibold text-slate-200">
                관련 등장인물 ({relatedCharacterIds.length}명 선택)
              </div>
              <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                {projectCharacters.map((c) => {
                  const selected = relatedCharacterIds.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleCharacterSelection(c.id)}
                      className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${
                        selected
                          ? 'bg-amber-500 text-slate-950 font-semibold'
                          : 'border border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      {c.name}
                    </button>
                  );
                })}
                {projectCharacters.length === 0 && (
                  <span className="text-xs text-slate-500">
                    등록된 인물이 없습니다.
                  </span>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-2">
              <div className="text-xs font-semibold text-slate-200">
                관련 연표 사건 ({relatedEventIds.length}건 선택)
              </div>
              <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                {projectEvents.map((ev) => {
                  const selected = relatedEventIds.includes(ev.id);
                  return (
                    <button
                      key={ev.id}
                      type="button"
                      onClick={() => toggleEventSelection(ev.id)}
                      className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${
                        selected
                          ? 'bg-amber-500 text-slate-950 font-semibold'
                          : 'border border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      {ev.title} ({ev.inUniverseDate})
                    </button>
                  );
                })}
                {projectEvents.length === 0 && (
                  <span className="text-xs text-slate-500">
                    등록된 연표 사건이 없습니다.
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Canon Status & Verified Source Revision */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-slate-800">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                정사(CANON) 상태
              </label>
              {editingForeshadowing ? (
                <select
                  value={canonStatus}
                  onChange={(e) => setCanonStatus(e.target.value as CanonStatus)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                >
                  <option value="DRAFT">초안 (DRAFT)</option>
                  <option value="PROPOSED">승인 대기 (PROPOSED)</option>
                  <option value="CANON">정사 확정 (CANON)</option>
                  <option value="ARCHIVED">보관됨 (ARCHIVED)</option>
                </select>
              ) : (
                <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-400">
                  초안 (DRAFT) — 신규 복선은 항상 초안으로 생성되며 생성 후 정사(CANON)로 확정할 수 있습니다.
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                검증된 원고 리비전 출처 (sourceRevisionId · 선택)
              </label>
              <select
                value={sourceRevisionId}
                onChange={(e) => setSourceRevisionId(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
              >
                <option value="">
                  (연결된 원고 리비전 없음 — 설정 저장은 정상 수행, RAG 자동 색인은 건너뜀)
                </option>
                {projectRevisions.map((rev) => (
                  <option key={rev.id} value={rev.id}>
                    [{rev.label}] {rev.episodeTitle} ({new Date(rev.createdAt).toLocaleDateString('ko-KR')})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={closeForm}
              className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-lg bg-amber-500 px-5 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
            >
              {isSubmitting
                ? '저장 중...'
                : editingForeshadowing
                ? '복선 변경 사항 저장'
                : '초안(DRAFT)으로 복선 등록'}
            </button>
          </div>
        </form>
      )}

      {/* Main Content: Foreshadowing Cards + Hierarchy Trace Inspector */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 space-y-4">
          {filteredForeshadowings.length === 0 ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-10 text-center space-y-3">
              <Sparkles className="mx-auto h-8 w-8 text-slate-600" />
              <div className="text-sm font-semibold text-slate-300">
                조건에 해당하는 복선이 없습니다.
              </div>
              <p className="text-xs text-slate-500">
                새 복선을 등록하거나 필터 조건을 변경해 보세요.
              </p>
            </div>
          ) : (
            filteredForeshadowings.map((item) => {
              const broken = detectForeshadowingBrokenReferences(
                item,
                entityContext
              );
              const plantedEp = item.plantedEpisodeId
                ? episodeMap.get(item.plantedEpisodeId)
                : undefined;
              const resolvedEp = item.resolvedEpisodeId
                ? episodeMap.get(item.resolvedEpisodeId)
                : undefined;
              const isInspected = inspectedForeshadowingId === item.id;

              return (
                <div
                  key={item.id}
                  className={`rounded-2xl border p-5 transition-colors space-y-4 ${
                    isInspected
                      ? 'border-amber-500/60 bg-slate-900'
                      : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${getPhaseBadgeStyle(
                            item.cluePhase
                          )}`}
                        >
                          {formatForeshadowingPhaseKorean(item.cluePhase)}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${getCanonBadgeStyle(
                            item.canonStatus
                          )}`}
                        >
                          {item.canonStatus === 'CANON' ? (
                            <ShieldCheck className="h-3 w-3" />
                          ) : (
                            <Clock className="h-3 w-3" />
                          )}
                          <span>{formatCanonStatusKorean(item.canonStatus)}</span>
                        </span>
                        {broken.hasBrokenRef && (
                          <span className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/15 px-2 py-0.5 text-[11px] font-semibold text-rose-300">
                            <AlertTriangle className="h-3 w-3" />
                            <span>참조 누락 감지</span>
                          </span>
                        )}
                      </div>
                      <h3 className="text-base font-bold text-slate-100">
                        {item.title}
                      </h3>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {item.canonStatus !== 'CANON' &&
                        item.canonStatus !== 'ARCHIVED' && (
                          <button
                            type="button"
                            onClick={() => setPromoteTarget(item)}
                            className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20"
                          >
                            <ShieldCheck className="h-3.5 w-3.5" />
                            <span>CANON 확정</span>
                          </button>
                        )}
                      <button
                        type="button"
                        onClick={() =>
                          setInspectedForeshadowingId(
                            isInspected ? null : item.id
                          )
                        }
                        className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
                          isInspected
                            ? 'border-amber-500 bg-amber-500/20 text-amber-200'
                            : 'border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700'
                        }`}
                      >
                        <GitBranch className="h-3.5 w-3.5" />
                        <span>계층 추적</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => openEditForm(item)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                        <span>수정</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(item)}
                        className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span>삭제</span>
                      </button>
                    </div>
                  </div>

                  <p className="text-xs leading-relaxed text-slate-300 whitespace-pre-line">
                    {item.description}
                  </p>

                  {/* Planted & Resolved Episode Links */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 rounded-xl border border-slate-800/90 bg-slate-950/60 p-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-[11px] text-slate-400">
                          설치 회차 / 장면
                        </div>
                        <div className="font-medium text-amber-300">
                          {formatEpisodeLabel(item.plantedEpisodeId)}
                          {item.plantedSceneId
                            ? ` · ${formatSceneLabel(item.plantedSceneId)}`
                            : ''}
                        </div>
                      </div>
                      {plantedEp && onNavigateToEpisode && (
                        <button
                          type="button"
                          onClick={() => onNavigateToEpisode(plantedEp.id)}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 hover:border-amber-500/50 hover:text-amber-300"
                        >
                          <BookOpen className="h-3 w-3" />
                          <span>원고 이동</span>
                        </button>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-[11px] text-slate-400">
                          회수 회차 / 장면
                        </div>
                        <div className="font-medium text-emerald-300">
                          {formatEpisodeLabel(item.resolvedEpisodeId)}
                          {item.resolvedSceneId
                            ? ` · ${formatSceneLabel(item.resolvedSceneId)}`
                            : ''}
                        </div>
                      </div>
                      {resolvedEp && onNavigateToEpisode && (
                        <button
                          type="button"
                          onClick={() => onNavigateToEpisode(resolvedEp.id)}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 hover:border-emerald-500/50 hover:text-emerald-300"
                        >
                          <BookOpen className="h-3 w-3" />
                          <span>원고 이동</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Linked Characters & Events Chips */}
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {(item.relatedCharacterIds || []).map((cId) => (
                      <button
                        key={cId}
                        type="button"
                        onClick={() => onNavigateToCharacters?.()}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-300 hover:border-amber-500/40 hover:text-amber-200"
                      >
                        <Users className="h-3 w-3 text-amber-400" />
                        <span>{formatCharacterLabel(cId)}</span>
                      </button>
                    ))}
                    {(item.relatedEventIds || []).map((eId) => (
                      <button
                        key={eId}
                        type="button"
                        onClick={() => onNavigateToTimeline?.()}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-300 hover:border-sky-500/40 hover:text-sky-200"
                      >
                        <CalendarClock className="h-3 w-3 text-sky-400" />
                        <span>{formatEventLabel(eId)}</span>
                      </button>
                    ))}
                  </div>

                  {/* Quick Phase Switcher Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/80 text-[11px]">
                    <span className="text-slate-400">
                      단계 빠른 전환 (정사 상태 유지):
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {PHASE_OPTIONS.map((p) => {
                        const active = item.cluePhase === p.value;
                        return (
                          <button
                            key={p.value}
                            type="button"
                            disabled={active}
                            onClick={() =>
                              handleQuickPhaseTransition(item, p.value)
                            }
                            className={`rounded-md px-2 py-1 font-medium transition-colors ${
                              active
                                ? 'bg-amber-500 text-slate-950 font-semibold cursor-default'
                                : 'border border-slate-800 bg-slate-950 text-slate-300 hover:bg-slate-800'
                            }`}
                          >
                            {p.value}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Right Column: Hierarchy Chain Inspector */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-4 h-fit sticky top-20">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-amber-400" />
              <h2 className="text-sm font-bold text-slate-100">
                복선 계층 연결 추적 (Hierarchy Chain)
              </h2>
            </div>
            {inspectedItem && (
              <button
                type="button"
                onClick={() => setInspectedForeshadowingId(null)}
                className="text-xs text-slate-400 hover:text-slate-200"
              >
                닫기
              </button>
            )}
          </div>

          {!inspectedItem || !inspectedTrace ? (
            <div className="py-8 text-center space-y-2 text-xs text-slate-400">
              <Eye className="mx-auto h-6 w-6 text-slate-600" />
              <p>
                복선 카드에서 <strong>[계층 추적]</strong> 버튼을 누르면
                <br />
                작품 → 설치 회차/장면 → 회수 회차/장면 → 인물 → 연표 사건으로 이어지는 전체 서사 연결망을 확인할 수 있습니다.
              </p>
            </div>
          ) : (
            <div className="space-y-3 text-xs">
              <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                <div className="text-[11px] text-slate-400">선택된 복선</div>
                <div className="mt-0.5 font-bold text-amber-300">
                  {inspectedItem.title}
                </div>
                <div className="mt-1 text-[11px] text-slate-400">
                  단계: {formatForeshadowingPhaseKorean(inspectedItem.cluePhase)} · 상태:{' '}
                  {formatCanonStatusKorean(inspectedItem.canonStatus)}
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950 p-3 space-y-1">
                <div className="text-[11px] text-slate-400">
                  1. 설치 위치 (Planted Episode / Scene)
                </div>
                <div className="text-slate-200 font-medium">
                  {inspectedTrace.plantedEpisode
                    ? `제${inspectedTrace.plantedEpisode.episodeNumber}화: ${inspectedTrace.plantedEpisode.title}`
                    : '(설치 회차 미지정)'}
                </div>
                {inspectedTrace.plantedScene && (
                  <div className="text-[11px] text-amber-300">
                    장면 #{inspectedTrace.plantedScene.sceneNumber}:{' '}
                    {inspectedTrace.plantedScene.title}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950 p-3 space-y-1">
                <div className="text-[11px] text-slate-400">
                  2. 회수 위치 (Resolved Episode / Scene)
                </div>
                <div className="text-slate-200 font-medium">
                  {inspectedTrace.resolvedEpisode
                    ? `제${inspectedTrace.resolvedEpisode.episodeNumber}화: ${inspectedTrace.resolvedEpisode.title}`
                    : '(회수 회차 미지정)'}
                </div>
                {inspectedTrace.resolvedScene && (
                  <div className="text-[11px] text-emerald-300">
                    장면 #{inspectedTrace.resolvedScene.sceneNumber}:{' '}
                    {inspectedTrace.resolvedScene.title}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950 p-3 space-y-1.5">
                <div className="text-[11px] text-slate-400">
                  3. 연결된 등장인물 ({inspectedTrace.relatedCharacters.length}명)
                </div>
                {inspectedTrace.relatedCharacters.length === 0 ? (
                  <div className="text-slate-500">(없음)</div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {inspectedTrace.relatedCharacters.map((c) => (
                      <span
                        key={c.id}
                        className="rounded-md border border-slate-800 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-200"
                      >
                        {c.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950 p-3 space-y-1.5">
                <div className="text-[11px] text-slate-400">
                  4. 연결된 연표 사건 ({inspectedTrace.relatedEvents.length}건)
                </div>
                {inspectedTrace.relatedEvents.length === 0 ? (
                  <div className="text-slate-500">(없음)</div>
                ) : (
                  <div className="space-y-1">
                    {inspectedTrace.relatedEvents.map((ev) => (
                      <div
                        key={ev.id}
                        className="rounded-md border border-slate-800 bg-slate-900 px-2.5 py-1 text-[11px] text-sky-300"
                      >
                        {ev.title} ({ev.inUniverseDate})
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Modal 1: Explicit Resolution Confirmation (RESOLVED transition) */}
      {resolutionConfirmPending && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
        >
          <div className="w-full max-w-lg rounded-2xl border border-emerald-500/40 bg-slate-900 p-6 space-y-4">
            <div className="flex items-center gap-2.5 text-emerald-300">
              <CheckCircle2 className="h-5 w-5 shrink-0" />
              <h3 className="text-base font-bold">
                복선 회수 완료(RESOLVED) 전환 확인
              </h3>
            </div>
            <p className="text-xs leading-relaxed text-slate-300">
              복선 <strong>"{resolutionConfirmPending.candidate.title}"</strong>의 진행 단계를{' '}
              <strong>회수 완료(RESOLVED)</strong>로 전환합니다.
              <br />
              복선 회수 완료는 진행 단계(cluePhase)만 변경하며, 정사(CANON) 여부는 별도의 작가 승인으로 관리됩니다.
            </p>

            <div className="rounded-xl border border-slate-800 bg-slate-950 p-3 space-y-1.5 text-xs">
              <div>
                <span className="text-slate-400">설치 회차: </span>
                <span className="text-amber-300 font-medium">
                  {formatEpisodeLabel(
                    resolutionConfirmPending.candidate.plantedEpisodeId
                  )}
                </span>
              </div>
              <div>
                <span className="text-slate-400">회수 회차: </span>
                <span className="text-emerald-300 font-medium">
                  {formatEpisodeLabel(
                    resolutionConfirmPending.candidate.resolvedEpisodeId
                  )}
                </span>
              </div>
              <div>
                <span className="text-slate-400">유지되는 정사 상태: </span>
                <span className="text-slate-200 font-semibold">
                  {formatCanonStatusKorean(
                    resolutionConfirmPending.candidate.canonStatus
                  )}
                </span>
              </div>
            </div>

            {resolutionConfirmPending.warnings.length > 0 && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-1 text-xs text-amber-200">
                {resolutionConfirmPending.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setResolutionConfirmPending(null)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
              >
                취소
              </button>
              <button
                type="button"
                onClick={handleConfirmResolutionTransition}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400"
              >
                회수 완료(RESOLVED) 확인 및 계속
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 2: Promote DRAFT -> CANON Confirmation */}
      {promoteTarget && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-emerald-500/40 bg-slate-900 p-6 space-y-4">
            <div className="flex items-center gap-2.5 text-emerald-300">
              <ShieldCheck className="h-5 w-5 shrink-0" />
              <h3 className="text-base font-bold">
                복선 정사(CANON) 확정 승인
              </h3>
            </div>
            <p className="text-xs leading-relaxed text-slate-300">
              복선 <strong>"{promoteTarget.title}"</strong> 항목을 작가 승인 정사(CANON)로 확정하시겠습니까?
              <br />
              정사로 확정된 복선은 이후 집필 및 기억 검색의 공식 기준으로 보호됩니다.
            </p>
            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setPromoteTarget(null)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
              >
                취소
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={handleConfirmPromoteToCanon}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400"
              >
                정사(CANON)로 확정
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 3: 6-Step CANON Modification Diff & Author Confirmation */}
      {canonConfirmPending && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
        >
          <div className="w-full max-w-xl rounded-2xl border border-amber-500/50 bg-slate-900 p-6 space-y-4">
            <div className="flex items-center gap-2.5 text-amber-300">
              <ShieldAlert className="h-5 w-5 shrink-0" />
              <h3 className="text-base font-bold">
                정사(CANON) 복선 변경 확인
              </h3>
            </div>
            <p className="text-xs leading-relaxed text-amber-100 font-medium">
              {CANON_CONFIRMATION_MESSAGE}
            </p>

            <div className="max-h-64 overflow-y-auto space-y-2 rounded-xl border border-slate-800 bg-slate-950 p-3">
              {canonConfirmPending.diffs.map((diff, idx) => (
                <div
                  key={idx}
                  className="rounded-lg border border-slate-800/90 bg-slate-900/90 p-2.5 text-xs space-y-1"
                >
                  <div className="flex items-center gap-1.5 font-semibold text-slate-200">
                    <GitCompare className="h-3.5 w-3.5 text-amber-400" />
                    <span>{diff.label}</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                    <div className="rounded bg-rose-500/10 border border-rose-500/20 p-1.5 text-rose-200">
                      <span className="font-semibold">변경 전: </span>
                      {diff.before}
                    </div>
                    <div className="rounded bg-emerald-500/10 border border-emerald-500/20 p-1.5 text-emerald-200">
                      <span className="font-semibold">변경 후: </span>
                      {diff.after}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setCanonConfirmPending(null)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
              >
                취소 (기존 CANON 유지)
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={handleConfirmCanonUpdate}
                className="rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400"
              >
                변경 내용 승인 및 저장
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 4: Delete / Archive Confirmation */}
      {deleteTarget && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-rose-500/40 bg-slate-900 p-6 space-y-4">
            <div className="flex items-center gap-2.5 text-rose-300">
              <AlertTriangle className="h-5 w-5 shrink-0" />
              <h3 className="text-base font-bold">
                {deleteTarget.canonStatus === 'CANON'
                  ? '정사(CANON) 복선 삭제 또는 보관 확인'
                  : '복선 삭제 확인'}
              </h3>
            </div>
            <p className="text-xs leading-relaxed text-slate-300">
              복선 <strong>"{deleteTarget.title}"</strong> 항목을 삭제하시겠습니까?
              <br />
              복선을 삭제하더라도 연결된 회차 원고, 등장인물, 연표 사건 데이터는 삭제되지 않고 안전하게 유지됩니다.
              {deleteTarget.canonStatus === 'CANON' && (
                <>
                  <br />
                  <span className="text-amber-300 font-medium">
                    정사(CANON) 기록을 보존하려면 완전 삭제 대신 보관(ARCHIVED) 또는 폐기 보류(ABANDONED) 전환을 권장합니다.
                  </span>
                </>
              )}
            </p>
            <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
              >
                취소
              </button>
              {deleteTarget.canonStatus !== 'ARCHIVED' && (
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => handleArchiveInsteadOfDelete(deleteTarget)}
                  className="inline-flex items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3.5 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-500/25"
                >
                  <Archive className="h-3.5 w-3.5" />
                  <span>삭제 대신 보관(ARCHIVED)</span>
                </button>
              )}
              <button
                type="button"
                disabled={isSubmitting}
                onClick={handleConfirmDelete}
                className="rounded-lg bg-rose-500 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-400"
              >
                영구 삭제
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
