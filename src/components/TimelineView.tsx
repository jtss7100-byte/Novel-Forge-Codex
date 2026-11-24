import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpDown,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  Clock,
  Edit3,
  GitCompare,
  Globe,
  History,
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
  Revision,
  Scene,
  TimelineEvent,
  WorldbuildingItem,
} from '../types/novel';
import {
  formatCanonStatusKorean,
  validateTimelineEventInput,
} from '../utils/foundationLogic';

export interface TimelineViewProps {
  projectId: string;
  timelineEvents: TimelineEvent[];
  episodes: Episode[];
  scenes: Scene[];
  characters: Character[];
  foreshadowings: Foreshadowing[];
  worldbuilding: WorldbuildingItem[];
  relationships: CharacterRelationship[];
  revisions: Revision[];
  onCreateTimelineEvent: (
    data: Omit<
      TimelineEvent,
      'id' | 'ownerId' | 'projectId' | 'createdAt' | 'updatedAt'
    >
  ) => Promise<void>;
  onUpdateTimelineEvent: (
    event: TimelineEvent,
    currentCanonStatus: CanonStatus
  ) => Promise<void>;
  onDeleteTimelineEvent: (
    eventId: string,
    currentCanonStatus: CanonStatus
  ) => Promise<void>;
  onOpenNarrative?: (id: string) => void;
  onNavigateToEpisode?: (episodeId: string) => void;
  onNavigateToForeshadowing?: () => void;
}

interface FieldDiffItem {
  label: string;
  before: string;
  after: string;
}

export const TimelineView: React.FC<TimelineViewProps> = ({
  projectId,
  timelineEvents,
  episodes,
  scenes,
  characters,
  foreshadowings,
  worldbuilding,
  relationships,
  revisions,
  onCreateTimelineEvent,
  onUpdateTimelineEvent,
  onDeleteTimelineEvent,
  onNavigateToEpisode,
  onOpenNarrative,
  onNavigateToForeshadowing,
}) => {
  const [sortMode, setSortMode] = useState<
    'chronological_asc' | 'chronological_desc' | 'episode_order'
  >('chronological_asc');
  const [searchQuery, setSearchQuery] = useState('');
  const [characterFilter, setCharacterFilter] = useState<string>('all');
  const [episodeFilter, setEpisodeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | CanonStatus>('all');

  // Form states
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<TimelineEvent | null>(null);

  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [inUniverseDate, setInUniverseDate] = useState('');
  const [chronologicalOrderInput, setChronologicalOrderInput] = useState<string>('10');
  const [episodeId, setEpisodeId] = useState('');
  const [sceneId, setSceneId] = useState('');
  const [participantCharacterIds, setParticipantCharacterIds] = useState<string[]>([]);
  const [linkedForeshadowingIds, setLinkedForeshadowingIds] = useState<string[]>([]);
  const [linkedWorldbuildingIds, setLinkedWorldbuildingIds] = useState<string[]>([]);
  const [canonStatus, setCanonStatus] = useState<CanonStatus>('DRAFT');
  const [sourceRevisionId, setSourceRevisionId] = useState('');

  const [formError, setFormError] = useState<string | null>(null);
  const [actionBanner, setActionBanner] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Modals
  const [promoteTarget, setPromoteTarget] = useState<TimelineEvent | null>(null);
  const [canonConfirmPending, setCanonConfirmPending] = useState<{
    original: TimelineEvent;
    updated: TimelineEvent;
    diffs: FieldDiffItem[];
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TimelineEvent | null>(null);

  const characterMap = useMemo(() => {
    const map = new Map<string, Character>();
    for (const c of characters) {
      if (c.projectId === projectId) map.set(c.id, c);
    }
    return map;
  }, [characters, projectId]);

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

  const foreshadowingMap = useMemo(() => {
    const map = new Map<string, Foreshadowing>();
    for (const f of foreshadowings) {
      if (f.projectId === projectId) map.set(f.id, f);
    }
    return map;
  }, [foreshadowings, projectId]);

  const worldbuildingMap = useMemo(() => {
    const map = new Map<string, WorldbuildingItem>();
    for (const wb of worldbuilding) {
      if (wb.projectId === projectId) map.set(wb.id, wb);
    }
    return map;
  }, [worldbuilding, projectId]);

  // Project-isolated timeline events
  const projectEvents = useMemo(
    () => timelineEvents.filter((e) => e.projectId === projectId),
    [timelineEvents, projectId]
  );

  // Detect events whose chronological order is nonlinear compared to episode appearance
  const nonlinearEventIds = useMemo(() => {
    const set = new Set<string>();
    const withEpisodes = projectEvents
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
  }, [projectEvents, episodeMap]);

  const filteredAndSortedEvents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = projectEvents.filter((evt) => {
      if (statusFilter !== 'all' && evt.canonStatus !== statusFilter) return false;
      if (episodeFilter !== 'all' && evt.episodeId !== episodeFilter) return false;
      if (
        characterFilter !== 'all' &&
        !evt.participantCharacterIds.includes(characterFilter)
      ) {
        return false;
      }
      if (!q) return true;
      return (
        evt.title.toLowerCase().includes(q) ||
        evt.summary.toLowerCase().includes(q) ||
        evt.inUniverseDate.toLowerCase().includes(q)
      );
    });

    return filtered.sort((a, b) => {
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
      // default: chronological_asc
      if (a.chronologicalOrder !== b.chronologicalOrder) {
        return a.chronologicalOrder - b.chronologicalOrder;
      }
      return a.title.localeCompare(b.title);
    });
  }, [
    projectEvents,
    statusFilter,
    episodeFilter,
    characterFilter,
    searchQuery,
    sortMode,
    episodeMap,
  ]);

  const stats = useMemo(() => {
    let canonCount = 0;
    let draftCount = 0;
    let brokenRefCount = 0;
    for (const evt of projectEvents) {
      if (evt.canonStatus === 'CANON') canonCount += 1;
      else if (evt.canonStatus === 'DRAFT' || evt.canonStatus === 'PROPOSED') draftCount += 1;

      const missingEp = Boolean(evt.episodeId && !episodeMap.has(evt.episodeId));
      const missingSc = Boolean(evt.sceneId && !sceneMap.has(evt.sceneId));
      const missingChar = evt.participantCharacterIds.some((id) => !characterMap.has(id));
      const missingFsh = evt.linkedForeshadowingIds.some((id) => !foreshadowingMap.has(id));
      const missingWb = evt.linkedWorldbuildingIds.some((id) => !worldbuildingMap.has(id));

      if (missingEp || missingSc || missingChar || missingFsh || missingWb) {
        brokenRefCount += 1;
      }
    }
    return {
      total: projectEvents.length,
      canonCount,
      draftCount,
      brokenRefCount,
    };
  }, [
    projectEvents,
    episodeMap,
    sceneMap,
    characterMap,
    foreshadowingMap,
    worldbuildingMap,
  ]);

  const getNextSuggestedChronologicalOrder = () => {
    if (projectEvents.length === 0) return 10;
    const maxOrder = Math.max(...projectEvents.map((e) => e.chronologicalOrder));
    return Math.min(100000, maxOrder + 10);
  };

  const openCreateForm = () => {
    setEditingEvent(null);
    setTitle('');
    setSummary('');
    setInUniverseDate('');
    setChronologicalOrderInput(String(getNextSuggestedChronologicalOrder()));
    setEpisodeId(episodeFilter !== 'all' ? episodeFilter : '');
    setSceneId('');
    setParticipantCharacterIds(
      characterFilter !== 'all' && characterMap.has(characterFilter)
        ? [characterFilter]
        : []
    );
    setLinkedForeshadowingIds([]);
    setLinkedWorldbuildingIds([]);
    // Rule: New items created by author always start as DRAFT
    setCanonStatus('DRAFT');
    setSourceRevisionId('');
    setFormError(null);
    setActionBanner(null);
    setIsFormOpen(true);
  };

  const openEditForm = (evt: TimelineEvent) => {
    setEditingEvent(evt);
    setTitle(evt.title);
    setSummary(evt.summary);
    setInUniverseDate(evt.inUniverseDate);
    setChronologicalOrderInput(String(evt.chronologicalOrder));
    setEpisodeId(evt.episodeId || '');
    setSceneId(evt.sceneId || '');
    setParticipantCharacterIds(
      evt.participantCharacterIds.filter((id) => characterMap.has(id))
    );
    setLinkedForeshadowingIds(
      evt.linkedForeshadowingIds.filter((id) => foreshadowingMap.has(id))
    );
    setLinkedWorldbuildingIds(
      evt.linkedWorldbuildingIds.filter((id) => worldbuildingMap.has(id))
    );
    setCanonStatus(evt.canonStatus);
    setSourceRevisionId(evt.sourceRevisionId || '');
    setFormError(null);
    setActionBanner(null);
    setIsFormOpen(true);
  };

  const toggleIdInList = (
    id: string,
    setter: React.Dispatch<React.SetStateAction<string[]>>
  ) => {
    setter((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const formatEpisodeLabel = (epId: string) => {
    if (!epId) return '지정 안 함';
    const ep = episodeMap.get(epId);
    return ep ? `제${ep.episodeNumber}화. ${ep.title}` : `삭제된 회차 (${epId})`;
  };

  const formatSceneLabel = (scId: string) => {
    if (!scId) return '지정 안 함';
    const sc = sceneMap.get(scId);
    return sc ? `#${sc.sceneNumber} ${sc.title}` : `삭제된 장면 (${scId})`;
  };

  const computeEventDiffs = (
    before: TimelineEvent,
    after: TimelineEvent
  ): FieldDiffItem[] => {
    const diffs: FieldDiffItem[] = [];
    if (before.title !== after.title) {
      diffs.push({ label: '사건 제목', before: before.title, after: after.title });
    }
    if (before.chronologicalOrder !== after.chronologicalOrder) {
      diffs.push({
        label: '작중 시간 순서 (chronologicalOrder)',
        before: String(before.chronologicalOrder),
        after: String(after.chronologicalOrder),
      });
    }
    if (before.inUniverseDate !== after.inUniverseDate) {
      diffs.push({
        label: '작중 연대/날짜 표기 (inUniverseDate)',
        before: before.inUniverseDate || '(미입력)',
        after: after.inUniverseDate || '(미입력)',
      });
    }
    if ((before.episodeId || '') !== (after.episodeId || '')) {
      diffs.push({
        label: '등장 회차 (episodeId)',
        before: formatEpisodeLabel(before.episodeId),
        after: formatEpisodeLabel(after.episodeId),
      });
    }
    if ((before.sceneId || '') !== (after.sceneId || '')) {
      diffs.push({
        label: '연결 장면 (sceneId)',
        before: formatSceneLabel(before.sceneId),
        after: formatSceneLabel(after.sceneId),
      });
    }
    if (before.summary !== after.summary) {
      diffs.push({
        label: '사건 요약 설명',
        before: before.summary || '(비어 있음)',
        after: after.summary || '(비어 있음)',
      });
    }
    const beforeChars = before.participantCharacterIds
      .map((id) => characterMap.get(id)?.name || id)
      .join(', ');
    const afterChars = after.participantCharacterIds
      .map((id) => characterMap.get(id)?.name || id)
      .join(', ');
    if (beforeChars !== afterChars) {
      diffs.push({
        label: '참여 등장인물',
        before: beforeChars || '(없음)',
        after: afterChars || '(없음)',
      });
    }
    const beforeFsh = before.linkedForeshadowingIds
      .map((id) => foreshadowingMap.get(id)?.title || id)
      .join(', ');
    const afterFsh = after.linkedForeshadowingIds
      .map((id) => foreshadowingMap.get(id)?.title || id)
      .join(', ');
    if (beforeFsh !== afterFsh) {
      diffs.push({
        label: '연결된 복선',
        before: beforeFsh || '(없음)',
        after: afterFsh || '(없음)',
      });
    }
    const beforeWb = before.linkedWorldbuildingIds
      .map((id) => worldbuildingMap.get(id)?.title || id)
      .join(', ');
    const afterWb = after.linkedWorldbuildingIds
      .map((id) => worldbuildingMap.get(id)?.title || id)
      .join(', ');
    if (beforeWb !== afterWb) {
      diffs.push({
        label: '연결된 세계관 설정',
        before: beforeWb || '(없음)',
        after: afterWb || '(없음)',
      });
    }
    if (before.canonStatus !== after.canonStatus) {
      diffs.push({
        label: '정사(CANON) 상태',
        before: formatCanonStatusKorean(before.canonStatus),
        after: formatCanonStatusKorean(after.canonStatus),
      });
    }
    return diffs;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setFormError(null);

    const parsedOrder = Number(chronologicalOrderInput);
    if (
      chronologicalOrderInput.trim() === '' ||
      !Number.isInteger(parsedOrder) ||
      parsedOrder < -100000 ||
      parsedOrder > 100000
    ) {
      setFormError(
        '작중 시간 순서(chronologicalOrder)는 -100,000 ~ 100,000 사이의 정수여야 합니다.'
      );
      return;
    }

    if (episodeId && !episodeMap.has(episodeId)) {
      setFormError('선택한 등장 회차가 현재 작품에 존재하지 않습니다.');
      return;
    }

    if (sceneId && !sceneMap.has(sceneId)) {
      setFormError('선택한 장면(Scene)이 현재 작품에 존재하지 않습니다.');
      return;
    }

    const validParticipantIds = participantCharacterIds.filter((id) =>
      characterMap.has(id)
    );
    const validForeshadowingIds = linkedForeshadowingIds.filter((id) =>
      foreshadowingMap.has(id)
    );
    const validWorldbuildingIds = linkedWorldbuildingIds.filter((id) =>
      worldbuildingMap.has(id)
    );

    const targetStatus: CanonStatus = editingEvent ? canonStatus : 'DRAFT';
    const check = validateTimelineEventInput({
      title: title.trim(),
      summary: summary.trim(),
      inUniverseDate: inUniverseDate.trim(),
      chronologicalOrder: parsedOrder,
      episodeId: episodeId || '',
      sceneId: sceneId || '',
      participantCharacterIds: validParticipantIds,
      linkedForeshadowingIds: validForeshadowingIds,
      linkedWorldbuildingIds: validWorldbuildingIds,
      canonStatus: targetStatus,
    });

    if (!check.valid) {
      setFormError(check.error || '입력값을 확인해 주세요.');
      return;
    }

    if (editingEvent) {
      const updatedEvent: TimelineEvent = {
        ...editingEvent,
        title: title.trim(),
        summary: summary.trim(),
        inUniverseDate: inUniverseDate.trim(),
        chronologicalOrder: parsedOrder,
        episodeId: episodeId || '',
        sceneId: sceneId || '',
        participantCharacterIds: validParticipantIds,
        linkedForeshadowingIds: validForeshadowingIds,
        linkedWorldbuildingIds: validWorldbuildingIds,
        canonStatus: targetStatus,
        sourceRevisionId: sourceRevisionId || editingEvent.sourceRevisionId || '',
        updatedAt: new Date().toISOString(),
      };

      // Mandatory 6-step CANON protection flow if stored item is CANON
      if (editingEvent.canonStatus === 'CANON') {
        const diffs = computeEventDiffs(editingEvent, updatedEvent);
        if (diffs.length === 0) {
          setIsFormOpen(false);
          return;
        }
        setCanonConfirmPending({
          original: editingEvent,
          updated: updatedEvent,
          diffs,
        });
        return;
      }

      setIsSubmitting(true);
      try {
        await onUpdateTimelineEvent(updatedEvent, editingEvent.canonStatus);
        setIsFormOpen(false);
        setEditingEvent(null);
      } catch (err) {
        setFormError(
          err instanceof Error ? err.message : '연표 사건 수정 중 오류가 발생했습니다.'
        );
      } finally {
        setIsSubmitting(false);
      }
    } else {
      setIsSubmitting(true);
      try {
        await onCreateTimelineEvent({
          title: title.trim(),
          summary: summary.trim(),
          inUniverseDate: inUniverseDate.trim(),
          chronologicalOrder: parsedOrder,
          episodeId: episodeId || '',
          sceneId: sceneId || '',
          participantCharacterIds: validParticipantIds,
          linkedForeshadowingIds: validForeshadowingIds,
          linkedWorldbuildingIds: validWorldbuildingIds,
          canonStatus: 'DRAFT',
          sourceRevisionId: sourceRevisionId || '',
          createdBy: 'AUTHOR',
        });
        setIsFormOpen(false);
      } catch (err) {
        setFormError(
          err instanceof Error ? err.message : '새 연표 사건 등록 중 오류가 발생했습니다.'
        );
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  const handleConfirmCanonUpdate = async () => {
    if (!canonConfirmPending || isSubmitting) return;
    setIsSubmitting(true);
    setFormError(null);
    try {
      await onUpdateTimelineEvent(
        canonConfirmPending.updated,
        canonConfirmPending.original.canonStatus
      );
      setCanonConfirmPending(null);
      setIsFormOpen(false);
      setEditingEvent(null);
      setActionBanner('정사(CANON) 연표 사건 변경 사항이 안전하게 저장되었습니다.');
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : '정사(CANON) 연표 사건 저장에 실패했습니다. 기존 설정이 유지됩니다.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmPromoteToCanon = async () => {
    if (!promoteTarget || isSubmitting) return;
    setIsSubmitting(true);
    setActionBanner(null);
    try {
      const promoted: TimelineEvent = {
        ...promoteTarget,
        canonStatus: 'CANON',
        updatedAt: new Date().toISOString(),
      };
      await onUpdateTimelineEvent(promoted, promoteTarget.canonStatus);
      setPromoteTarget(null);
      setActionBanner(`'${promoteTarget.title}' 사건이 정사(CANON)로 확정되었습니다.`);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : '정사 확정 처리 중 오류가 발생했습니다.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleArchiveInsteadOfDelete = async (evt: TimelineEvent) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onUpdateTimelineEvent(
        {
          ...evt,
          canonStatus: 'ARCHIVED',
          updatedAt: new Date().toISOString(),
        },
        evt.canonStatus
      );
      setDeleteTarget(null);
      setActionBanner('연표 사건이 삭제 대신 보관(ARCHIVED) 상태로 전환되었습니다.');
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : '보관 상태 전환 중 오류가 발생했습니다.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const getCanonBadgeStyle = (status: CanonStatus) => {
    switch (status) {
      case 'CANON':
        return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300';
      case 'PROPOSED':
        return 'border-sky-500/40 bg-sky-500/15 text-sky-300';
      case 'ARCHIVED':
      case 'REJECTED':
        return 'border-slate-700 bg-slate-800/80 text-slate-400';
      default:
        return 'border-amber-500/40 bg-amber-500/15 text-amber-300';
    }
  };

  const availableScenesForEpisode = useMemo(() => {
    const allProjectScenes = scenes.filter((s) => s.projectId === projectId);
    if (!episodeId) return allProjectScenes;
    return allProjectScenes.filter((s) => s.episodeId === episodeId);
  }, [scenes, projectId, episodeId]);

  const deleteTargetReferences = useMemo(() => {
    if (!deleteTarget) return { relCount: 0, fshCount: 0 };
    const relCount = relationships.filter(
      (r) => r.projectId === projectId && r.effectiveEventId === deleteTarget.id
    ).length;
    const fshCount = foreshadowings.filter(
      (f) => f.projectId === projectId && f.relatedEventIds.includes(deleteTarget.id)
    ).length;
    return { relCount, fshCount };
  }, [deleteTarget, relationships, foreshadowings, projectId]);

  return (
    <div className="space-y-6">
      {/* Header & Summary Metrics */}
      <div className="flex flex-col justify-between gap-4 rounded-xl border border-slate-800 bg-slate-900/80 p-5 lg:flex-row lg:items-center">
        <div>
          <div className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-amber-400" />
            <h1 className="text-xl font-bold text-slate-100">
              작품 연표 및 시간축 사건 기록 (Story Timeline)
            </h1>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            작중 시간 순서(chronologicalOrder), 작중 자유 연대 표기(inUniverseDate), 원고 등장 회차(episodeId)를 분리하여 비선형 회상·회귀·전개 사건을 정밀 추적합니다
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-950 px-3.5 py-2 text-xs">
            <div>
              <span className="text-slate-400">전체 사건 </span>
              <span className="font-mono-tabular font-semibold text-slate-100">
                {stats.total}
              </span>
            </div>
            <span className="text-slate-700">|</span>
            <div>
              <span className="text-slate-400">정사(CANON) </span>
              <span className="font-mono-tabular font-semibold text-emerald-400">
                {stats.canonCount}
              </span>
            </div>
            <span className="text-slate-700">|</span>
            <div>
              <span className="text-slate-400">초안·제안 </span>
              <span className="font-mono-tabular font-semibold text-amber-300">
                {stats.draftCount}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={openCreateForm}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="h-4 w-4" />
            <span>새 연표 사건 등록</span>
          </button>
        </div>
      </div>

      {actionBanner && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-200"
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
            <span>{actionBanner}</span>
          </div>
          <button
            type="button"
            onClick={() => setActionBanner(null)}
            className="text-emerald-300 hover:text-white"
          >
            닫기
          </button>
        </div>
      )}

      {/* Search, Filter & Time Axis Sort Bar */}
      <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4 md:grid-cols-5">
        <div className="relative md:col-span-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="사건 제목, 작중 날짜/연대, 요약 검색..."
            aria-label="연표 사건 검색"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 pl-9 pr-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
          />
        </div>

        <div>
          <select
            aria-label="시간축 정렬 기준"
            value={sortMode}
            onChange={(e) =>
              setSortMode(
                e.target.value as
                  | 'chronological_asc'
                  | 'chronological_desc'
                  | 'episode_order'
              )
            }
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-amber-300 font-medium focus:border-amber-500 focus:outline-none"
          >
            <option value="chronological_asc">
              정렬: 작중 시간 순서 (과거 → 현재)
            </option>
            <option value="chronological_desc">
              정렬: 작중 시간 순서 (최근 → 과거)
            </option>
            <option value="episode_order">
              정렬: 원고 등장 회차(Episode) 순서
            </option>
          </select>
        </div>

        <div>
          <select
            aria-label="참여 인물 필터"
            value={characterFilter}
            onChange={(e) => setCharacterFilter(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
          >
            <option value="all">참여 인물: 전체</option>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                인물: {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex gap-2">
          <select
            aria-label="등장 회차 필터"
            value={episodeFilter}
            onChange={(e) => setEpisodeFilter(e.target.value)}
            className="w-1/2 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
          >
            <option value="all">회차: 전체</option>
            {episodes.map((ep) => (
              <option key={ep.id} value={ep.id}>
                제{ep.episodeNumber}화
              </option>
            ))}
          </select>

          <select
            aria-label="정사 상태 필터"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'all' | CanonStatus)}
            className="w-1/2 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
          >
            <option value="all">상태: 전체</option>
            <option value="CANON">CANON</option>
            <option value="DRAFT">DRAFT</option>
            <option value="PROPOSED">PROPOSED</option>
            <option value="ARCHIVED">ARCHIVED</option>
          </select>
        </div>
      </div>

      {/* Create / Edit Timeline Event Form */}
      {isFormOpen && (
        <section
          aria-label={editingEvent ? '연표 사건 수정' : '새 연표 사건 등록'}
          className="rounded-xl border border-amber-500/40 bg-slate-900 p-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-4">
            <div className="flex items-center gap-2.5">
              <h2 className="text-base font-semibold text-slate-100">
                {editingEvent
                  ? `'${editingEvent.title}' 사건 수정`
                  : '새 작품 연표 사건 등록'}
              </h2>
              {editingEvent ? (
                <span
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${getCanonBadgeStyle(
                    editingEvent.canonStatus
                  )}`}
                >
                  {editingEvent.canonStatus === 'CANON' ? (
                    <ShieldCheck className="h-3 w-3" />
                  ) : (
                    <Clock className="h-3 w-3" />
                  )}
                  <span>현재 상태: {formatCanonStatusKorean(editingEvent.canonStatus)}</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
                  <Clock className="h-3 w-3" />
                  <span>신규 생성 기본값: 초안 (DRAFT) · 작성 주체: AUTHOR</span>
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setIsFormOpen(false)}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              닫기
            </button>
          </div>

          {editingEvent?.canonStatus === 'CANON' && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200">
              <ShieldAlert className="h-4 w-4 text-amber-400 shrink-0" />
              <span>
                현재 <strong>작가 확정 정사(CANON)</strong>로 등록된 연표 사건입니다. 수정 후 저장을 누르면 변경 전/후 비교 및 정사 변경 최종 확인 절차가 진행됩니다.
              </span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            {formError && (
              <div
                role="alert"
                className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-300"
              >
                {formError}
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="md:col-span-2">
                <label
                  htmlFor="evt-title-input"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  사건 제목 (최대 150자) *
                </label>
                <input
                  id="evt-title-input"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={150}
                  placeholder="예: 발할라 대균열 발발 및 성검 에테르나 파열"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="evt-status-select"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  정사(CANON) 상태
                </label>
                {editingEvent ? (
                  <select
                    id="evt-status-select"
                    value={canonStatus}
                    onChange={(e) => setCanonStatus(e.target.value as CanonStatus)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                  >
                    <option value="DRAFT">초안 (DRAFT)</option>
                    <option value="PROPOSED">AI 제안 (PROPOSED)</option>
                    <option value="CANON">작가 확정 (CANON)</option>
                    <option value="ARCHIVED">보관됨 (ARCHIVED)</option>
                  </select>
                ) : (
                  <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-amber-300">
                    초안 (DRAFT) — 등록 후 [정사로 확정] 가능
                  </div>
                )}
              </div>
            </div>

            {/* 3 Time Axes Separation Row */}
            <div className="grid grid-cols-1 gap-4 rounded-lg border border-slate-800 bg-slate-950/70 p-4 md:grid-cols-4">
              <div>
                <label
                  htmlFor="evt-chrono-order-input"
                  className="block text-xs font-semibold text-amber-300 mb-1"
                >
                  1. 작중 시간 순서 (chronologicalOrder) *
                </label>
                <input
                  id="evt-chrono-order-input"
                  type="number"
                  step={1}
                  min={-100000}
                  max={100000}
                  value={chronologicalOrderInput}
                  onChange={(e) => setChronologicalOrderInput(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-mono-tabular text-slate-100 focus:border-amber-500 focus:outline-none"
                />
                <div className="mt-1.5 flex flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={() => setChronologicalOrderInput('-100')}
                    className="rounded border border-slate-800 bg-slate-900 px-2 py-0.5 text-[10px] text-slate-400 hover:text-amber-300"
                  >
                    고대/전사 (-100)
                  </button>
                  <button
                    type="button"
                    onClick={() => setChronologicalOrderInput('-10')}
                    className="rounded border border-slate-800 bg-slate-900 px-2 py-0.5 text-[10px] text-slate-400 hover:text-amber-300"
                  >
                    본편 직전 (-10)
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setChronologicalOrderInput(
                        String(getNextSuggestedChronologicalOrder())
                      )
                    }
                    className="rounded border border-slate-800 bg-slate-900 px-2 py-0.5 text-[10px] text-slate-400 hover:text-amber-300"
                  >
                    다음 순서 (+{getNextSuggestedChronologicalOrder()})
                  </button>
                </div>
              </div>

              <div>
                <label
                  htmlFor="evt-inuniverse-date-input"
                  className="block text-xs font-semibold text-sky-300 mb-1"
                >
                  2. 작중 날짜·연대 표기 (자유 문자열)
                </label>
                <input
                  id="evt-inuniverse-date-input"
                  type="text"
                  value={inUniverseDate}
                  onChange={(e) => setInUniverseDate(e.target.value)}
                  maxLength={100}
                  placeholder="예: 제국력 412년 겨울 첫째 밤 / 회귀 3일 차"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                />
                <p className="mt-1 text-[10px] text-slate-400">
                  달력 형식 강제 없음 (제국력, 계절, 회귀 일차 등 자유 입력)
                </p>
              </div>

              <div>
                <label
                  htmlFor="evt-episode-select"
                  className="block text-xs font-semibold text-emerald-300 mb-1"
                >
                  3. 원고 등장·언급 회차 (episodeId)
                </label>
                <select
                  id="evt-episode-select"
                  value={episodeId}
                  onChange={(e) => {
                    setEpisodeId(e.target.value);
                    setSceneId('');
                  }}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                >
                  <option value="">회차 미지정 (배경 연표 사건)</option>
                  {episodes.map((ep) => (
                    <option key={ep.id} value={ep.id}>
                      제{ep.episodeNumber}화. {ep.title}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[10px] text-slate-400">
                  과거 회상 사건도 실제 서술된 회차를 연결할 수 있습니다
                </p>
              </div>

              <div>
                <label
                  htmlFor="evt-scene-select"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  세부 장면 연결 (sceneId · 선택)
                </label>
                <select
                  id="evt-scene-select"
                  value={sceneId}
                  onChange={(e) => setSceneId(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                >
                  <option value="">장면 지정 안 함</option>
                  {availableScenesForEpisode.map((sc) => (
                    <option key={sc.id} value={sc.id}>
                      장면 #{sc.sceneNumber}. {sc.title}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label
                htmlFor="evt-summary-textarea"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                사건 상세 요약 및 인과관계 (최대 3,000자)
              </label>
              <textarea
                id="evt-summary-textarea"
                rows={3}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                maxLength={3000}
                placeholder="사건의 원인, 전개 결과, 인물들이 입은 부상이나 권력 변화 등 이후 회차에서 기억해야 할 핵심 결과를 기록하세요."
                className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs leading-relaxed text-slate-100 focus:border-amber-500 focus:outline-none"
              />
            </div>

            {/* Relational Links: Characters, Foreshadowings, Worldbuilding */}
            <div className="grid grid-cols-1 gap-4 border-t border-slate-800 pt-4 md:grid-cols-3">
              <div>
                <div className="text-xs font-medium text-slate-300 mb-2">
                  참여 등장인물 ({participantCharacterIds.length}명 선택됨)
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {characters.map((ch) => {
                    const active = participantCharacterIds.includes(ch.id);
                    return (
                      <button
                        key={ch.id}
                        type="button"
                        onClick={() =>
                          toggleIdInList(ch.id, setParticipantCharacterIds)
                        }
                        className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                          active
                            ? 'bg-amber-500 text-slate-950 font-semibold'
                            : 'border border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {ch.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-slate-300 mb-2">
                  연결된 복선 ({linkedForeshadowingIds.length}개 선택됨)
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {foreshadowings
                    .filter((f) => f.projectId === projectId)
                    .map((fsh) => {
                      const active = linkedForeshadowingIds.includes(fsh.id);
                      return (
                        <button
                          key={fsh.id}
                          type="button"
                          onClick={() =>
                            toggleIdInList(fsh.id, setLinkedForeshadowingIds)
                          }
                          className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                            active
                              ? 'bg-purple-500 text-slate-950 font-semibold'
                              : 'border border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {fsh.title.slice(0, 18)}
                        </button>
                      );
                    })}
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-slate-300 mb-2">
                  관련 세계관 항목 ({linkedWorldbuildingIds.length}개 선택됨)
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {worldbuilding.map((wb) => {
                    const active = linkedWorldbuildingIds.includes(wb.id);
                    return (
                      <button
                        key={wb.id}
                        type="button"
                        onClick={() =>
                          toggleIdInList(wb.id, setLinkedWorldbuildingIds)
                        }
                        className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                          active
                            ? 'bg-sky-500 text-slate-950 font-semibold'
                            : 'border border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {wb.title}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setIsFormOpen(false)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-700"
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
                  : editingEvent
                  ? editingEvent.canonStatus === 'CANON'
                    ? '변경 내용 검토 및 정사 저장'
                    : '연표 사건 수정 저장'
                  : '초안(DRAFT)으로 사건 등록'}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Chronological Timeline Stream */}
      {filteredAndSortedEvents.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-12 text-center">
          <CalendarClock className="mx-auto h-8 w-8 text-slate-500 mb-2" />
          <p className="text-sm text-slate-300">
            조건에 맞는 작품 연표 사건이 없습니다.
          </p>
          <button
            type="button"
            onClick={openCreateForm}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400"
          >
            <Plus className="h-4 w-4" />
            <span>첫 연표 사건 등록하기</span>
          </button>
        </div>
      ) : (
        <div className="relative pl-6 md:pl-8 before:absolute before:left-2.5 md:before:left-3.5 before:top-3 before:bottom-3 before:w-0.5 before:bg-slate-800 space-y-4">
          {filteredAndSortedEvents.map((evt) => {
            const ep = evt.episodeId ? episodeMap.get(evt.episodeId) : undefined;
            const sc = evt.sceneId ? sceneMap.get(evt.sceneId) : undefined;
            const isNonlinear = nonlinearEventIds.has(evt.id);

            const missingEp = Boolean(evt.episodeId && !ep);
            const missingSc = Boolean(evt.sceneId && !sc);
            const missingCharCount = evt.participantCharacterIds.filter(
              (id) => !characterMap.has(id)
            ).length;
            const missingFshCount = evt.linkedForeshadowingIds.filter(
              (id) => !foreshadowingMap.has(id)
            ).length;
            const missingWbCount = evt.linkedWorldbuildingIds.filter(
              (id) => !worldbuildingMap.has(id)
            ).length;
            const hasBrokenRef =
              missingEp ||
              missingSc ||
              missingCharCount > 0 ||
              missingFshCount > 0 ||
              missingWbCount > 0;

            return (
              <article
                key={evt.id}
                className="relative rounded-xl border border-slate-800 bg-slate-900/85 p-5 hover:border-slate-700 transition-colors"
              >
                {/* Timeline Axis Node Marker */}
                <span
                  aria-hidden="true"
                  className={`absolute -left-[22px] md:-left-[26px] top-6 h-3.5 w-3.5 rounded-full border-2 ${
                    evt.canonStatus === 'CANON'
                      ? 'border-emerald-400 bg-emerald-500'
                      : 'border-amber-400 bg-slate-950'
                  }`}
                />

                <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-start">
                  <div className="space-y-2.5 flex-1">
                    {/* 3 Time Axes Badges + Canon Status */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 font-mono-tabular text-xs font-bold text-amber-300">
                        작중 순서{' '}
                        {evt.chronologicalOrder > 0
                          ? `+${evt.chronologicalOrder}`
                          : evt.chronologicalOrder}
                      </span>

                      {evt.inUniverseDate ? (
                        <span className="inline-flex items-center gap-1 rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-xs font-medium text-sky-300">
                          {evt.inUniverseDate}
                        </span>
                      ) : (
                        <span className="rounded-md border border-slate-800 bg-slate-950 px-2 py-0.5 text-[11px] text-slate-500">
                          작중 연대 미기재
                        </span>
                      )}

                      {evt.episodeId ? (
                        ep ? (
                          <button
                            type="button"
                            onClick={() => onNavigateToEpisode?.(ep.id)}
                            className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20"
                          >
                            <BookOpen className="h-3 w-3" />
                            <span>등장: 제{ep.episodeNumber}화</span>
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-300">
                            삭제된 회차 ({evt.episodeId})
                          </span>
                        )
                      ) : (
                        <span className="rounded-md border border-slate-800 bg-slate-950 px-2 py-0.5 text-[11px] text-slate-400">
                          원고 외 배경사
                        </span>
                      )}

                      {sc && (
                        <span className="rounded-md border border-slate-800 bg-slate-950 px-2 py-0.5 text-[11px] text-slate-300">
                          장면 #{sc.sceneNumber}: {sc.title}
                        </span>
                      )}

                      {isNonlinear && (
                        <span className="inline-flex items-center gap-1 rounded-md border border-purple-500/40 bg-purple-500/10 px-2 py-0.5 text-[11px] font-medium text-purple-300">
                          <History className="h-3 w-3" />
                          <span>과거사 / 비선형 서술</span>
                        </span>
                      )}

                      <span
                        className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${getCanonBadgeStyle(
                          evt.canonStatus
                        )}`}
                      >
                        {evt.canonStatus === 'CANON' ? (
                          <ShieldCheck className="h-3 w-3" />
                        ) : (
                          <Clock className="h-3 w-3" />
                        )}
                        <span>{formatCanonStatusKorean(evt.canonStatus)}</span>
                      </span>

                      {hasBrokenRef && (
                        <span className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-300">
                          <AlertTriangle className="h-3 w-3" />
                          <span>유실된 참조 포함 (수정 시 정리 가능)</span>
                        </span>
                      )}
                    </div>

                    <h2 className="text-base font-bold text-slate-100">{evt.title}</h2>

                    {evt.summary && (
                      <p className="text-xs leading-relaxed text-slate-300 whitespace-pre-line">
                        {evt.summary}
                      </p>
                    )}

                    {/* Linked Entities Row */}
                    <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px]">
                      {evt.participantCharacterIds.map((cId) => {
                        const ch = characterMap.get(cId);
                        return (
                          <span
                            key={cId}
                            className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 ${
                              ch
                                ? 'border-slate-800 bg-slate-950 text-slate-300'
                                : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                            }`}
                          >
                            <Users className="h-3 w-3 text-amber-400" />
                            <span>{ch ? ch.name : `삭제된 인물 (${cId})`}</span>
                          </span>
                        );
                      })}

                      {evt.linkedForeshadowingIds.map((fId) => {
                        const fsh = foreshadowingMap.get(fId);
                        return (
                          <button
                            key={fId}
                            type="button"
                            onClick={() => onNavigateToForeshadowing?.()}
                            className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 ${
                              fsh
                                ? 'border-purple-500/30 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20'
                                : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                            }`}
                          >
                            <Sparkles className="h-3 w-3" />
                            <span>
                              복선: {fsh ? fsh.title : `삭제된 복선 (${fId})`}
                            </span>
                          </button>
                        );
                      })}

                      {evt.linkedWorldbuildingIds.map((wId) => {
                        const wb = worldbuildingMap.get(wId);
                        return (
                          <span
                            key={wId}
                            className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 ${
                              wb
                                ? 'border-sky-500/30 bg-sky-500/10 text-sky-300'
                                : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                            }`}
                          >
                            <Globe className="h-3 w-3" />
                            <span>{wb ? wb.title : `삭제된 세계관 (${wId})`}</span>
                          </span>
                        );
                      })}
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {(evt.canonStatus === 'DRAFT' ||
                      evt.canonStatus === 'PROPOSED') && (
                      <button
                        type="button"
                        onClick={() => setPromoteTarget(evt)}
                        disabled={isSubmitting}
                        className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-500/25 transition-colors"
                      >
                        <Sparkles className="h-3 w-3" />
                        <span>정사로 확정</span>
                      </button>
                    )}
                    {onOpenNarrative && <button type="button" onClick={() => onOpenNarrative(evt.id)}
                        className="rounded border border-indigo-500/40 px-2 py-1.5 text-xs text-indigo-200">서사 연결</button>}
                    <button
                      type="button"
                      onClick={() => openEditForm(evt)}
                      aria-label={`${evt.title} 수정`}
                      className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(evt)}
                      aria-label={`${evt.title} 삭제`}
                      className="rounded p-1.5 text-slate-400 hover:bg-rose-500/15 hover:text-rose-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Modal 1: Promote DRAFT/PROPOSED -> CANON Confirmation */}
      {promoteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="promote-canon-evt-title"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <ShieldCheck className="h-5 w-5 text-emerald-400" />
                <h2
                  id="promote-canon-evt-title"
                  className="text-base font-bold text-slate-100"
                >
                  연표 사건 정사(CANON) 확정 승인
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setPromoteTarget(null)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-950 p-3.5 text-xs space-y-1.5">
              <div className="font-semibold text-slate-100">{promoteTarget.title}</div>
              <div className="text-amber-300 font-mono-tabular">
                작중 순서: {promoteTarget.chronologicalOrder} · 작중 연대:{' '}
                {promoteTarget.inUniverseDate || '미기재'}
              </div>
              {promoteTarget.summary && (
                <p className="text-slate-400">{promoteTarget.summary}</p>
              )}
            </div>

            <p className="text-xs leading-relaxed text-slate-300">
              이 연표 사건을 <strong>작가 확정 정사(CANON)</strong>로 승격하시겠습니까? 정사로 확정된 사건은 이후 집필 및 연대기 정합성 검증의 기준이 됩니다.
            </p>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setPromoteTarget(null)}
                disabled={isSubmitting}
                className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
              >
                취소
              </button>
              <button
                type="button"
                onClick={handleConfirmPromoteToCanon}
                disabled={isSubmitting}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
              >
                {isSubmitting ? '확정 처리 중...' : '정사(CANON)로 확정'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 2: 6-Step CANON Modification Diff & Confirmation Modal */}
      {canonConfirmPending && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="canon-diff-evt-title"
        >
          <div className="w-full max-w-xl rounded-xl border border-amber-500/40 bg-slate-900 p-6 shadow-2xl space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <GitCompare className="h-5 w-5 text-amber-400 shrink-0" />
                <div>
                  <h2
                    id="canon-diff-evt-title"
                    className="text-base font-bold text-slate-100"
                  >
                    확정 정사(CANON) 연표 사건 변경 확인
                  </h2>
                  <p className="text-xs text-amber-300/90 mt-0.5">
                    이미 확정된 정사 설정을 변경합니다. 이후 집필에 영향을 줄 수 있습니다. 변경 내용을 확인하고 저장하시겠습니까?
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setCanonConfirmPending(null)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 divide-y divide-slate-800 text-xs">
              {canonConfirmPending.diffs.map((d) => (
                <div key={d.label} className="p-3 space-y-1">
                  <div className="font-semibold text-slate-200">{d.label}</div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="rounded border border-rose-500/25 bg-rose-500/5 p-2 text-rose-200">
                      <span className="block text-[10px] text-rose-400 font-semibold mb-0.5">
                        변경 전 (기존 CANON)
                      </span>
                      <span className="break-words">{d.before}</span>
                    </div>
                    <div className="rounded border border-emerald-500/25 bg-emerald-500/5 p-2 text-emerald-200">
                      <span className="block text-[10px] text-emerald-400 font-semibold mb-0.5">
                        변경 후 (저장될 값)
                      </span>
                      <span className="break-words">{d.after}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {formError && (
              <div
                role="alert"
                className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"
              >
                {formError}
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setCanonConfirmPending(null)}
                disabled={isSubmitting}
                className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
              >
                취소 (기존 정사 유지)
              </button>
              <button
                type="button"
                onClick={handleConfirmCanonUpdate}
                disabled={isSubmitting}
                className="rounded-lg bg-amber-500 px-5 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
              >
                {isSubmitting ? '정사 변경 저장 중...' : '변경 내용 확인 및 정사 저장'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 3: Delete / Archive Event Confirmation */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-evt-modal-title"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <AlertTriangle className="h-5 w-5 text-rose-400" />
                <h2
                  id="delete-evt-modal-title"
                  className="text-base font-bold text-slate-100"
                >
                  {deleteTarget.canonStatus === 'CANON'
                    ? '확정 정사(CANON) 연표 사건 삭제·보관 확인'
                    : '연표 사건 삭제 확인'}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-xs leading-relaxed text-slate-300">
              <strong>
                [작중 순서 {deleteTarget.chronologicalOrder}] {deleteTarget.title}
              </strong>{' '}
              사건을 삭제하시겠습니까? (연결된 등장인물, 회차, 복선, 세계관 원본 항목은 삭제되지 않습니다.)
            </p>

            {(deleteTargetReferences.relCount > 0 ||
              deleteTargetReferences.fshCount > 0) && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
                현재 이 사건을 참조 중인 인물 관계({deleteTargetReferences.relCount}건) 또는 복선({deleteTargetReferences.fshCount}건)이 있습니다. 영구 삭제 대신{' '}
                <strong>보관(ARCHIVED)</strong>으로 전환하는 것을 권장합니다.
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={isSubmitting}
                className="rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
              >
                취소
              </button>
              {deleteTarget.canonStatus !== 'ARCHIVED' && (
                <button
                  type="button"
                  onClick={() => handleArchiveInsteadOfDelete(deleteTarget)}
                  disabled={isSubmitting}
                  className="rounded-lg border border-amber-500/40 bg-amber-500/15 px-3.5 py-2 text-xs font-semibold text-amber-300 hover:bg-amber-500/25"
                >
                  보관(ARCHIVED)으로 전환
                </button>
              )}
              <button
                type="button"
                disabled={isSubmitting}
                onClick={async () => {
                  if (!deleteTarget || isSubmitting) return;
                  setIsSubmitting(true);
                  try {
                    await onDeleteTimelineEvent(
                      deleteTarget.id,
                      deleteTarget.canonStatus
                    );
                    setDeleteTarget(null);
                  } catch (err) {
                    setFormError(
                      err instanceof Error
                        ? err.message
                        : '연표 사건 삭제 중 오류가 발생했습니다.'
                    );
                  } finally {
                    setIsSubmitting(false);
                  }
                }}
                className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
              >
                {isSubmitting ? '삭제 중...' : '영구 삭제'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
