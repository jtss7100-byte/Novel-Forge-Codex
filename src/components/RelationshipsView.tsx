import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  CheckCircle2,
  Clock,
  Edit3,
  Filter,
  GitCompare,
  Network,
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
  Revision,
  TimelineEvent,
} from '../types/novel';
import {
  formatCanonStatusKorean,
  validateCharacterRelationshipInput,
} from '../utils/foundationLogic';

export interface RelationshipsViewProps {
  projectId: string;
  characters: Character[];
  relationships: CharacterRelationship[];
  episodes: Episode[];
  timelineEvents: TimelineEvent[];
  revisions: Revision[];
  onCreateRelationship: (
    data: Omit<
      CharacterRelationship,
      'id' | 'ownerId' | 'projectId' | 'createdAt' | 'updatedAt'
    >
  ) => Promise<void>;
  onUpdateRelationship: (
    relationship: CharacterRelationship,
    currentCanonStatus: CanonStatus
  ) => Promise<void>;
  onDeleteRelationship: (
    relationshipId: string,
    currentCanonStatus: CanonStatus
  ) => Promise<void>;
  onNavigateToEpisode?: (episodeId: string) => void;
  onNavigateToTimeline?: () => void;
}

const RELATION_TYPE_PRESETS = [
  '동료 / 전우',
  '생사를 맡긴 상관·부관',
  '스승·제자',
  '적대 / 숙적',
  '가족 / 혈연',
  '주군·가신',
  '경쟁자 / 라이벌',
  '연인 / 반려',
  '채무·계약 관계',
  '배신 / 감시자',
];

interface FieldDiffItem {
  label: string;
  before: string;
  after: string;
}

export const RelationshipsView: React.FC<RelationshipsViewProps> = ({
  projectId,
  characters,
  relationships,
  episodes,
  timelineEvents,
  revisions,
  onCreateRelationship,
  onUpdateRelationship,
  onDeleteRelationship,
  onNavigateToEpisode,
  onNavigateToTimeline,
}) => {
  const [viewMode, setViewMode] = useState<'both' | 'graph' | 'list'>('both');
  const [searchQuery, setSearchQuery] = useState('');
  const [focusedCharacterId, setFocusedCharacterId] = useState<string>('all');
  const [relationTypeFilter, setRelationTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | CanonStatus>('all');

  // Form states
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingRelationship, setEditingRelationship] =
    useState<CharacterRelationship | null>(null);

  const [sourceCharacterId, setSourceCharacterId] = useState('');
  const [targetCharacterId, setTargetCharacterId] = useState('');
  const [relationType, setRelationType] = useState(RELATION_TYPE_PRESETS[0]);
  const [affinityScore, setAffinityScore] = useState<number>(0);
  const [isDirectional, setIsDirectional] = useState<boolean>(false);
  const [description, setDescription] = useState('');
  const [canonStatus, setCanonStatus] = useState<CanonStatus>('DRAFT');
  const [effectiveEpisodeId, setEffectiveEpisodeId] = useState('');
  const [effectiveEventId, setEffectiveEventId] = useState('');
  const [sourceRevisionId, setSourceRevisionId] = useState('');

  const [formError, setFormError] = useState<string | null>(null);
  const [actionBanner, setActionBanner] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Modals for CANON promotion, CANON modification diff confirmation, and deletion
  const [promoteTarget, setPromoteTarget] = useState<CharacterRelationship | null>(null);
  const [canonConfirmPending, setCanonConfirmPending] = useState<{
    original: CharacterRelationship;
    updated: CharacterRelationship;
    diffs: FieldDiffItem[];
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CharacterRelationship | null>(null);

  const characterMap = useMemo(() => {
    const map = new Map<string, Character>();
    for (const c of characters) {
      if (c.projectId === projectId) {
        map.set(c.id, c);
      }
    }
    return map;
  }, [characters, projectId]);

  const episodeMap = useMemo(() => {
    const map = new Map<string, Episode>();
    for (const ep of episodes) {
      if (ep.projectId === projectId) {
        map.set(ep.id, ep);
      }
    }
    return map;
  }, [episodes, projectId]);

  const eventMap = useMemo(() => {
    const map = new Map<string, TimelineEvent>();
    for (const evt of timelineEvents) {
      if (evt.projectId === projectId) {
        map.set(evt.id, evt);
      }
    }
    return map;
  }, [timelineEvents, projectId]);

  // Strictly isolate relationships belonging to current project
  const projectRelationships = useMemo(
    () => relationships.filter((r) => r.projectId === projectId),
    [relationships, projectId]
  );

  const distinctRelationTypes = useMemo(() => {
    const set = new Set<string>();
    for (const r of projectRelationships) {
      if (r.relationType.trim()) set.add(r.relationType.trim());
    }
    return Array.from(set);
  }, [projectRelationships]);

  const filteredRelationships = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return projectRelationships.filter((rel) => {
      if (statusFilter !== 'all' && rel.canonStatus !== statusFilter) return false;
      if (
        relationTypeFilter !== 'all' &&
        rel.relationType.trim() !== relationTypeFilter
      ) {
        return false;
      }
      if (
        focusedCharacterId !== 'all' &&
        rel.sourceCharacterId !== focusedCharacterId &&
        rel.targetCharacterId !== focusedCharacterId
      ) {
        return false;
      }
      if (!q) return true;
      const srcName = characterMap.get(rel.sourceCharacterId)?.name.toLowerCase() || '';
      const tgtName = characterMap.get(rel.targetCharacterId)?.name.toLowerCase() || '';
      return (
        srcName.includes(q) ||
        tgtName.includes(q) ||
        rel.relationType.toLowerCase().includes(q) ||
        rel.description.toLowerCase().includes(q)
      );
    });
  }, [
    projectRelationships,
    statusFilter,
    relationTypeFilter,
    focusedCharacterId,
    searchQuery,
    characterMap,
  ]);

  const stats = useMemo(() => {
    let canonCount = 0;
    let draftCount = 0;
    let brokenRefCount = 0;
    for (const r of projectRelationships) {
      if (r.canonStatus === 'CANON') canonCount += 1;
      else if (r.canonStatus === 'DRAFT' || r.canonStatus === 'PROPOSED') draftCount += 1;

      const missingSource = !characterMap.has(r.sourceCharacterId);
      const missingTarget = !characterMap.has(r.targetCharacterId);
      const missingEp = Boolean(r.effectiveEpisodeId && !episodeMap.has(r.effectiveEpisodeId));
      const missingEvt = Boolean(r.effectiveEventId && !eventMap.has(r.effectiveEventId));
      if (missingSource || missingTarget || missingEp || missingEvt) {
        brokenRefCount += 1;
      }
    }
    return {
      total: projectRelationships.length,
      canonCount,
      draftCount,
      brokenRefCount,
    };
  }, [projectRelationships, characterMap, episodeMap, eventMap]);

  const openCreateForm = () => {
    setEditingRelationship(null);
    const defaultSource =
      focusedCharacterId !== 'all' && characterMap.has(focusedCharacterId)
        ? focusedCharacterId
        : characters[0]?.id || '';
    const defaultTarget =
      characters.find((c) => c.id !== defaultSource)?.id || '';

    setSourceCharacterId(defaultSource);
    setTargetCharacterId(defaultTarget);
    setRelationType(RELATION_TYPE_PRESETS[0]);
    setAffinityScore(0);
    setIsDirectional(false);
    setDescription('');
    // Rule: New items created by author always start as DRAFT
    setCanonStatus('DRAFT');
    setEffectiveEpisodeId('');
    setEffectiveEventId('');
    setSourceRevisionId('');
    setFormError(null);
    setActionBanner(null);
    setIsFormOpen(true);
  };

  const openEditForm = (rel: CharacterRelationship) => {
    setEditingRelationship(rel);
    setSourceCharacterId(rel.sourceCharacterId);
    setTargetCharacterId(rel.targetCharacterId);
    setRelationType(rel.relationType);
    setAffinityScore(rel.affinityScore);
    setIsDirectional(rel.isDirectional);
    setDescription(rel.description);
    setCanonStatus(rel.canonStatus);
    setEffectiveEpisodeId(rel.effectiveEpisodeId || '');
    setEffectiveEventId(rel.effectiveEventId || '');
    setSourceRevisionId(rel.sourceRevisionId || '');
    setFormError(null);
    setActionBanner(null);
    setIsFormOpen(true);
  };

  const formatCharName = (id: string) =>
    characterMap.get(id)?.name || `삭제된 인물 (${id})`;

  const formatEpName = (id: string) => {
    if (!id) return '지정 안 함';
    const ep = episodeMap.get(id);
    return ep ? `제${ep.episodeNumber}화. ${ep.title}` : `찾을 수 없는 회차 (${id})`;
  };

  const formatEvtName = (id: string) => {
    if (!id) return '지정 안 함';
    const evt = eventMap.get(id);
    return evt ? evt.title : `찾을 수 없는 사건 (${id})`;
  };

  const computeRelationshipDiffs = (
    before: CharacterRelationship,
    after: CharacterRelationship
  ): FieldDiffItem[] => {
    const diffs: FieldDiffItem[] = [];
    if (before.sourceCharacterId !== after.sourceCharacterId) {
      diffs.push({
        label: '출발 인물',
        before: formatCharName(before.sourceCharacterId),
        after: formatCharName(after.sourceCharacterId),
      });
    }
    if (before.targetCharacterId !== after.targetCharacterId) {
      diffs.push({
        label: '대상 인물',
        before: formatCharName(before.targetCharacterId),
        after: formatCharName(after.targetCharacterId),
      });
    }
    if (before.isDirectional !== after.isDirectional) {
      diffs.push({
        label: '관계 방향성',
        before: before.isDirectional ? '단방향 (A → B)' : '양방향 (A ↔ B)',
        after: after.isDirectional ? '단방향 (A → B)' : '양방향 (A ↔ B)',
      });
    }
    if (before.relationType !== after.relationType) {
      diffs.push({
        label: '관계 유형',
        before: before.relationType,
        after: after.relationType,
      });
    }
    if (before.affinityScore !== after.affinityScore) {
      diffs.push({
        label: '우호도 / 신뢰도 점수',
        before: `${before.affinityScore > 0 ? `+${before.affinityScore}` : before.affinityScore}`,
        after: `${after.affinityScore > 0 ? `+${after.affinityScore}` : after.affinityScore}`,
      });
    }
    if (before.description !== after.description) {
      diffs.push({
        label: '관계 상세 설명',
        before: before.description || '(비어 있음)',
        after: after.description || '(비어 있음)',
      });
    }
    if ((before.effectiveEpisodeId || '') !== (after.effectiveEpisodeId || '')) {
      diffs.push({
        label: '관계 발효 회차',
        before: formatEpName(before.effectiveEpisodeId),
        after: formatEpName(after.effectiveEpisodeId),
      });
    }
    if ((before.effectiveEventId || '') !== (after.effectiveEventId || '')) {
      diffs.push({
        label: '관련 연표 사건',
        before: formatEvtName(before.effectiveEventId),
        after: formatEvtName(after.effectiveEventId),
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

    const cleanSourceId = sourceCharacterId.trim();
    const cleanTargetId = targetCharacterId.trim();
    const cleanRelationType = relationType.trim();
    const cleanDescription = description.trim();
    const numericAffinity = Number(affinityScore);

    // 1. Self-relationship guard
    if (cleanSourceId && cleanSourceId === cleanTargetId) {
      setFormError('동일한 인물 간에는 관계를 설정할 수 없습니다 (자기 자신과의 관계 금지).');
      return;
    }

    // 2. Project-scoped character existence guard
    if (!characterMap.has(cleanSourceId)) {
      setFormError('현재 작품에 존재하는 출발 인물을 선택해 주세요.');
      return;
    }
    if (!characterMap.has(cleanTargetId)) {
      setFormError('현재 작품에 존재하는 대상 인물을 선택해 주세요.');
      return;
    }

    // 3. Episode / Event reference existence guard
    if (effectiveEpisodeId && !episodeMap.has(effectiveEpisodeId)) {
      setFormError('선택한 발효 회차가 현재 작품에 존재하지 않습니다.');
      return;
    }
    if (effectiveEventId && !eventMap.has(effectiveEventId)) {
      setFormError('선택한 연표 사건이 현재 작품에 존재하지 않습니다.');
      return;
    }

    // 4. Foundation validator check
    const targetStatus: CanonStatus = editingRelationship ? canonStatus : 'DRAFT';
    const check = validateCharacterRelationshipInput({
      sourceCharacterId: cleanSourceId,
      targetCharacterId: cleanTargetId,
      relationType: cleanRelationType,
      affinityScore: numericAffinity,
      isDirectional,
      description: cleanDescription,
      canonStatus: targetStatus,
    });
    if (!check.valid) {
      setFormError(check.error || '입력값을 확인해 주세요.');
      return;
    }

    // 5. Duplicate relationship guard (respecting directionality & effectiveEpisodeId)
    const normalizedType = cleanRelationType.toLowerCase();
    const duplicate = projectRelationships.find((other) => {
      if (editingRelationship && other.id === editingRelationship.id) return false;
      if (other.canonStatus === 'REJECTED' || other.canonStatus === 'ARCHIVED') return false;
      if (other.relationType.trim().toLowerCase() !== normalizedType) return false;
      if ((other.effectiveEpisodeId || '') !== (effectiveEpisodeId || '')) return false;

      const exactPair =
        other.sourceCharacterId === cleanSourceId &&
        other.targetCharacterId === cleanTargetId;
      const reversePair =
        other.sourceCharacterId === cleanTargetId &&
        other.targetCharacterId === cleanSourceId;

      if (!isDirectional || !other.isDirectional) {
        return exactPair || reversePair;
      }
      return exactPair;
    });

    if (duplicate) {
      setFormError(
        '동일한 두 인물 사이에 같은 유형 및 발효 회차의 관계가 이미 등록되어 있습니다.'
      );
      return;
    }

    if (editingRelationship) {
      const updatedRel: CharacterRelationship = {
        ...editingRelationship,
        sourceCharacterId: cleanSourceId,
        targetCharacterId: cleanTargetId,
        relationType: cleanRelationType,
        affinityScore: Math.round(numericAffinity),
        isDirectional,
        description: cleanDescription,
        canonStatus: targetStatus,
        effectiveEpisodeId: effectiveEpisodeId || '',
        effectiveEventId: effectiveEventId || '',
        sourceRevisionId: sourceRevisionId || editingRelationship.sourceRevisionId || '',
        updatedAt: new Date().toISOString(),
      };

      // Mandatory 6-step CANON protection flow if the stored original item is CANON
      if (editingRelationship.canonStatus === 'CANON') {
        const diffs = computeRelationshipDiffs(editingRelationship, updatedRel);
        if (diffs.length === 0) {
          setIsFormOpen(false);
          return;
        }
        setCanonConfirmPending({
          original: editingRelationship,
          updated: updatedRel,
          diffs,
        });
        return;
      }

      setIsSubmitting(true);
      try {
        await onUpdateRelationship(updatedRel, editingRelationship.canonStatus);
        setIsFormOpen(false);
        setEditingRelationship(null);
      } catch (err) {
        setFormError(
          err instanceof Error ? err.message : '인물 관계 수정 저장 중 오류가 발생했습니다.'
        );
      } finally {
        setIsSubmitting(false);
      }
    } else {
      setIsSubmitting(true);
      try {
        await onCreateRelationship({
          sourceCharacterId: cleanSourceId,
          targetCharacterId: cleanTargetId,
          relationType: cleanRelationType,
          affinityScore: Math.round(numericAffinity),
          isDirectional,
          description: cleanDescription,
          canonStatus: 'DRAFT',
          effectiveEpisodeId: effectiveEpisodeId || '',
          effectiveEventId: effectiveEventId || '',
          sourceRevisionId: sourceRevisionId || '',
          createdBy: 'AUTHOR',
        });
        setIsFormOpen(false);
      } catch (err) {
        setFormError(
          err instanceof Error ? err.message : '새 인물 관계 등록 중 오류가 발생했습니다.'
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
      await onUpdateRelationship(
        canonConfirmPending.updated,
        canonConfirmPending.original.canonStatus
      );
      setCanonConfirmPending(null);
      setIsFormOpen(false);
      setEditingRelationship(null);
      setActionBanner('정사(CANON) 인물 관계 변경 사항이 안전하게 저장되었습니다.');
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : '정사(CANON) 인물 관계 저장에 실패했습니다. 기존 설정이 유지됩니다.'
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
      const promoted: CharacterRelationship = {
        ...promoteTarget,
        canonStatus: 'CANON',
        updatedAt: new Date().toISOString(),
      };
      await onUpdateRelationship(promoted, promoteTarget.canonStatus);
      setPromoteTarget(null);
      setActionBanner(
        `'${formatCharName(promoteTarget.sourceCharacterId)} — ${formatCharName(
          promoteTarget.targetCharacterId
        )}' 관계가 정사(CANON)로 확정되었습니다.`
      );
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : '정사 확정 처리 중 오류가 발생했습니다.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleArchiveInsteadOfDelete = async (rel: CharacterRelationship) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onUpdateRelationship(
        {
          ...rel,
          canonStatus: 'ARCHIVED',
          updatedAt: new Date().toISOString(),
        },
        rel.canonStatus
      );
      setDeleteTarget(null);
      setActionBanner('인물 관계가 삭제 대신 보관(ARCHIVED) 상태로 전환되었습니다.');
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : '보관 상태 전환 중 오류가 발생했습니다.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  // SVG Graph Layout Calculation
  const graphLayout = useMemo(() => {
    const width = 760;
    const height = 420;
    const cx = width / 2;
    const cy = height / 2;

    const projectChars = characters.filter((c) => c.projectId === projectId);
    const nodePositions = new Map<
      string,
      { x: number; y: number; character: Character; degree: number }
    >();

    const degreeMap = new Map<string, number>();
    for (const r of filteredRelationships) {
      degreeMap.set(r.sourceCharacterId, (degreeMap.get(r.sourceCharacterId) || 0) + 1);
      degreeMap.set(r.targetCharacterId, (degreeMap.get(r.targetCharacterId) || 0) + 1);
    }

    if (projectChars.length === 0) {
      return { width, height, nodes: [], edges: [] };
    }

    if (
      focusedCharacterId !== 'all' &&
      projectChars.some((c) => c.id === focusedCharacterId)
    ) {
      const centerChar = projectChars.find((c) => c.id === focusedCharacterId)!;
      nodePositions.set(centerChar.id, {
        x: cx,
        y: cy,
        character: centerChar,
        degree: degreeMap.get(centerChar.id) || 0,
      });

      const others = projectChars.filter((c) => c.id !== focusedCharacterId);
      const radiusX = Math.min(260, Math.max(160, others.length * 42));
      const radiusY = Math.min(155, Math.max(115, others.length * 28));
      others.forEach((ch, idx) => {
        const angle = (2 * Math.PI * idx) / Math.max(1, others.length) - Math.PI / 2;
        nodePositions.set(ch.id, {
          x: cx + radiusX * Math.cos(angle),
          y: cy + radiusY * Math.sin(angle),
          character: ch,
          degree: degreeMap.get(ch.id) || 0,
        });
      });
    } else {
      const radiusX = projectChars.length <= 2 ? 170 : 250;
      const radiusY = projectChars.length <= 2 ? 110 : 145;
      projectChars.forEach((ch, idx) => {
        const angle =
          (2 * Math.PI * idx) / Math.max(1, projectChars.length) - Math.PI / 2;
        nodePositions.set(ch.id, {
          x: projectChars.length === 1 ? cx : cx + radiusX * Math.cos(angle),
          y: projectChars.length === 1 ? cy : cy + radiusY * Math.sin(angle),
          character: ch,
          degree: degreeMap.get(ch.id) || 0,
        });
      });
    }

    // Group edges by unordered pair to offset parallel edges cleanly
    const pairCounts = new Map<string, number>();
    const edges = filteredRelationships
      .map((rel) => {
        const src = nodePositions.get(rel.sourceCharacterId);
        const tgt = nodePositions.get(rel.targetCharacterId);
        if (!src || !tgt) return null;

        const pairKey = [rel.sourceCharacterId, rel.targetCharacterId].sort().join('::');
        const idxInPair = pairCounts.get(pairKey) || 0;
        pairCounts.set(pairKey, idxInPair + 1);

        const dx = tgt.x - src.x;
        const dy = tgt.y - src.y;
        const dist = Math.max(1, Math.hypot(dx, dy));
        const normX = -dy / dist;
        const normY = dx / dist;

        // Shorten endpoints so arrowheads land cleanly at node radius (28px)
        const padStart = 30;
        const padEnd = 32;
        const startX = src.x + (dx / dist) * padStart;
        const startY = src.y + (dy / dist) * padStart;
        const endX = tgt.x - (dx / dist) * padEnd;
        const endY = tgt.y - (dy / dist) * padEnd;

        const curveSign = idxInPair % 2 === 0 ? 1 : -1;
        const curveMagnitude = idxInPair === 0 ? 22 : 46 * Math.ceil(idxInPair / 2);
        const ctrlX = (startX + endX) / 2 + normX * curveMagnitude * curveSign;
        const ctrlY = (startY + endY) / 2 + normY * curveMagnitude * curveSign;

        // Quadratic bezier midpoint at t = 0.5
        const labelX = 0.25 * startX + 0.5 * ctrlX + 0.25 * endX;
        const labelY = 0.25 * startY + 0.5 * ctrlY + 0.25 * endY;

        return {
          relationship: rel,
          pathD: `M ${startX.toFixed(1)} ${startY.toFixed(1)} Q ${ctrlX.toFixed(
            1
          )} ${ctrlY.toFixed(1)} ${endX.toFixed(1)} ${endY.toFixed(1)}`,
          labelX,
          labelY,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    return {
      width,
      height,
      nodes: Array.from(nodePositions.values()),
      edges,
    };
  }, [characters, projectId, filteredRelationships, focusedCharacterId]);

  const getAffinityBadgeStyle = (score: number) => {
    if (score >= 25) {
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300';
    }
    if (score <= -25) {
      return 'border-rose-500/40 bg-rose-500/10 text-rose-300';
    }
    return 'border-amber-500/40 bg-amber-500/10 text-amber-300';
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

  return (
    <div className="space-y-6">
      {/* Header & Summary Bar */}
      <div className="flex flex-col justify-between gap-4 rounded-xl border border-slate-800 bg-slate-900/80 p-5 lg:flex-row lg:items-center">
        <div>
          <div className="flex items-center gap-2">
            <Network className="h-5 w-5 text-amber-400" />
            <h1 className="text-xl font-bold text-slate-100">
              등장인물 관계도 및 진영 구도 관리
            </h1>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            인물 간 방향성(단방향·양방향), 우호도(-100~+100), 발효 회차 및 정사(CANON) 승인 상태를 체계적으로 관리합니다
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-950 px-3.5 py-2 text-xs">
            <div>
              <span className="text-slate-400">전체 관계 </span>
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

          <div className="flex items-center gap-1 rounded-lg bg-slate-950 p-1 border border-slate-800">
            {(
              [
                { key: 'both', label: '통합 보기' },
                { key: 'graph', label: '네트워크 그래프' },
                { key: 'list', label: '관계 목록' },
              ] as const
            ).map((mode) => (
              <button
                key={mode.key}
                type="button"
                onClick={() => setViewMode(mode.key)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  viewMode === mode.key
                    ? 'bg-slate-800 text-amber-400'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {mode.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={openCreateForm}
            disabled={characters.length < 2}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
          >
            <Plus className="h-4 w-4" />
            <span>새 인물 관계 등록</span>
          </button>
        </div>
      </div>

      {characters.length < 2 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
          <span>
            인물 관계를 등록하려면 현재 작품에 최소 2명 이상의 등장인물이 등록되어 있어야 합니다.
          </span>
        </div>
      )}

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

      {/* Search & Multi-Filter Bar */}
      <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4 md:grid-cols-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="인물 이름, 관계 유형, 설명 검색..."
            aria-label="인물 관계 검색"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 pl-9 pr-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
          />
        </div>

        <div>
          <select
            aria-label="중심 인물 필터"
            value={focusedCharacterId}
            onChange={(e) => setFocusedCharacterId(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
          >
            <option value="all">중심 인물: 전체 보기 ({characters.length}명)</option>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                중심 인물: {c.name} ({c.role})
              </option>
            ))}
          </select>
        </div>

        <div>
          <select
            aria-label="관계 유형 필터"
            value={relationTypeFilter}
            onChange={(e) => setRelationTypeFilter(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
          >
            <option value="all">관계 유형: 전체 ({distinctRelationTypes.length}종)</option>
            {distinctRelationTypes.map((rt) => (
              <option key={rt} value={rt}>
                {rt}
              </option>
            ))}
          </select>
        </div>

        <div>
          <select
            aria-label="정사 상태 필터"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'all' | CanonStatus)}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
          >
            <option value="all">정사 상태: 전체 ({projectRelationships.length})</option>
            <option value="CANON">작가 확정 (CANON)</option>
            <option value="DRAFT">초안 (DRAFT)</option>
            <option value="PROPOSED">AI 제안 (PROPOSED)</option>
            <option value="ARCHIVED">보관됨 (ARCHIVED)</option>
          </select>
        </div>
      </div>

      {/* Create / Edit Relationship Form */}
      {isFormOpen && (
        <section
          aria-label={editingRelationship ? '인물 관계 수정' : '새 인물 관계 등록'}
          className="rounded-xl border border-amber-500/40 bg-slate-900 p-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-4">
            <div className="flex items-center gap-2.5">
              <h2 className="text-base font-semibold text-slate-100">
                {editingRelationship
                  ? `'${formatCharName(editingRelationship.sourceCharacterId)} — ${formatCharName(
                      editingRelationship.targetCharacterId
                    )}' 관계 수정`
                  : '새 등장인물 관계 등록'}
              </h2>
              {editingRelationship ? (
                <span
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${getCanonBadgeStyle(
                    editingRelationship.canonStatus
                  )}`}
                >
                  {editingRelationship.canonStatus === 'CANON' ? (
                    <ShieldCheck className="h-3 w-3" />
                  ) : (
                    <Clock className="h-3 w-3" />
                  )}
                  <span>현재 상태: {formatCanonStatusKorean(editingRelationship.canonStatus)}</span>
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

          {editingRelationship?.canonStatus === 'CANON' && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200">
              <ShieldAlert className="h-4 w-4 text-amber-400 shrink-0" />
              <span>
                현재 <strong>작가 확정 정사(CANON)</strong> 상태로 보호 중인 인물 관계입니다. 수정 후 저장을 누르면 변경 전/후 비교 및 정사 변경 최종 확인 절차가 진행됩니다.
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
              <div>
                <label
                  htmlFor="rel-source-char-select"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  출발 인물 (Source Character) *
                </label>
                <select
                  id="rel-source-char-select"
                  value={sourceCharacterId}
                  onChange={(e) => setSourceCharacterId(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                >
                  <option value="">출발 인물 선택</option>
                  {characters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.role})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col justify-end">
                <span className="block text-xs font-medium text-slate-300 mb-1">
                  관계 방향성 설정 *
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsDirectional(false)}
                    className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                      !isDirectional
                        ? 'border-amber-500 bg-amber-500/15 text-amber-300 font-semibold'
                        : 'border-slate-700 bg-slate-950 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <ArrowLeftRight className="h-3.5 w-3.5" />
                    <span>양방향 (A ↔ B)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsDirectional(true)}
                    className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                      isDirectional
                        ? 'border-amber-500 bg-amber-500/15 text-amber-300 font-semibold'
                        : 'border-slate-700 bg-slate-950 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <ArrowRight className="h-3.5 w-3.5" />
                    <span>단방향 (A → B)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const prevSrc = sourceCharacterId;
                      setSourceCharacterId(targetCharacterId);
                      setTargetCharacterId(prevSrc);
                    }}
                    title="출발 인물과 대상 인물 맞바꾸기"
                    className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 text-xs text-slate-300 hover:bg-slate-800"
                  >
                    교체
                  </button>
                </div>
              </div>

              <div>
                <label
                  htmlFor="rel-target-char-select"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  대상 인물 (Target Character) *
                </label>
                <select
                  id="rel-target-char-select"
                  value={targetCharacterId}
                  onChange={(e) => setTargetCharacterId(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                >
                  <option value="">대상 인물 선택</option>
                  {characters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.role})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label
                  htmlFor="rel-type-input"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  관계 유형 (최대 80자) *
                </label>
                <input
                  id="rel-type-input"
                  type="text"
                  value={relationType}
                  onChange={(e) => setRelationType(e.target.value)}
                  placeholder="예: 생사를 함께한 전우이자 감시 대상"
                  maxLength={80}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                />
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {RELATION_TYPE_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setRelationType(preset)}
                      className="rounded border border-slate-800 bg-slate-950 px-2 py-0.5 text-[11px] text-slate-400 hover:text-amber-300"
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label
                    htmlFor="rel-affinity-number"
                    className="block text-xs font-medium text-slate-300"
                  >
                    우호도 / 신뢰도 점수 (-100 ~ +100 정수) *
                  </label>
                  <span className="font-mono-tabular text-xs font-semibold text-amber-400">
                    {affinityScore > 0 ? `+${affinityScore}` : affinityScore}점 (
                    {affinityScore >= 25
                      ? '우호·신뢰'
                      : affinityScore <= -25
                      ? '적대·경계'
                      : '중립·복합'}
                    )
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={-100}
                    max={100}
                    step={1}
                    value={affinityScore}
                    onChange={(e) => setAffinityScore(Number(e.target.value))}
                    aria-label="우호도 슬라이더"
                    className="flex-1 accent-amber-500"
                  />
                  <input
                    id="rel-affinity-number"
                    type="number"
                    min={-100}
                    max={100}
                    step={1}
                    value={affinityScore}
                    onChange={(e) => setAffinityScore(Number(e.target.value))}
                    className="w-24 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-mono-tabular text-right text-slate-100 focus:border-amber-500 focus:outline-none"
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <label
                  htmlFor="rel-episode-select"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  관계 발효·변화 회차 (선택)
                </label>
                <select
                  id="rel-episode-select"
                  value={effectiveEpisodeId}
                  onChange={(e) => setEffectiveEpisodeId(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                >
                  <option value="">특정 회차 지정 안 함 (작품 기본 관계)</option>
                  {episodes.map((ep) => (
                    <option key={ep.id} value={ep.id}>
                      제{ep.episodeNumber}화. {ep.title}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="rel-event-select"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  계기가 된 연표 사건 (선택)
                </label>
                <select
                  id="rel-event-select"
                  value={effectiveEventId}
                  onChange={(e) => setEffectiveEventId(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                >
                  <option value="">연표 사건 지정 안 함</option>
                  {timelineEvents
                    .filter((evt) => evt.projectId === projectId)
                    .sort((a, b) => a.chronologicalOrder - b.chronologicalOrder)
                    .map((evt) => (
                      <option key={evt.id} value={evt.id}>
                        [순서 {evt.chronologicalOrder}] {evt.title}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="rel-status-select"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  정사(CANON) 상태
                </label>
                {editingRelationship ? (
                  <select
                    id="rel-status-select"
                    value={canonStatus}
                    onChange={(e) => setCanonStatus(e.target.value as CanonStatus)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                  >
                    <option value="DRAFT">초안 (DRAFT)</option>
                    <option value="PROPOSED">AI 제안 (PROPOSED)</option>
                    <option value="CANON">작가 확정 (CANON)</option>
                    <option value="ARCHIVED">보관됨 (ARCHIVED)</option>
                  </select>
                ) : (
                  <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-amber-300">
                    초안 (DRAFT) — 등록 후 카드에서 [정사로 확정] 가능
                  </div>
                )}
              </div>
            </div>

            <div>
              <label
                htmlFor="rel-desc-textarea"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                관계 상세 서사 및 변화 맥락 (최대 2,000자)
              </label>
              <textarea
                id="rel-desc-textarea"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
                placeholder="두 인물의 과거 인연, 감정선, 호칭/말투 차이, 혹은 향후 관계 변화 복선을 기록하세요."
                className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs leading-relaxed text-slate-100 focus:border-amber-500 focus:outline-none"
              />
            </div>

            {revisions.length > 0 && (
              <div>
                <label
                  htmlFor="rel-revision-select"
                  className="block text-xs font-medium text-slate-400 mb-1"
                >
                  출처 리비전 스냅샷 연결 (선택 · Provenance 보존)
                </label>
                <select
                  id="rel-revision-select"
                  value={sourceRevisionId}
                  onChange={(e) => setSourceRevisionId(e.target.value)}
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5 text-xs text-slate-300 focus:border-amber-500 focus:outline-none"
                >
                  <option value="">리비전 스냅샷 지정 안 함</option>
                  {revisions.map((rev) => (
                    <option key={rev.id} value={rev.id}>
                      [{rev.episodeTitle}] {rev.label} ({rev.id})
                    </option>
                  ))}
                </select>
              </div>
            )}

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
                  : editingRelationship
                  ? editingRelationship.canonStatus === 'CANON'
                    ? '변경 내용 검토 및 정사 저장'
                    : '인물 관계 수정 저장'
                  : '초안(DRAFT)으로 관계 등록'}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Interactive SVG Relationship Network Graph */}
      {(viewMode === 'both' || viewMode === 'graph') && (
        <section
          aria-label="등장인물 관계도 네트워크 그래프"
          className="rounded-xl border border-slate-800 bg-slate-900/80 p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                인물 관계 네트워크 시각화
              </h2>
              <p className="text-xs text-slate-400">
                인물 노드를 클릭하면 해당 인물 중심 관계만 강조되며, 실선은 확정 정사(CANON), 점선은 초안(DRAFT) 관계를 나타냅니다
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                <span>우호 (+25 이상)</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-amber-400" />
                <span>중립·복합 (-24 ~ +24)</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-rose-400" />
                <span>적대 (-25 이하)</span>
              </span>
              {focusedCharacterId !== 'all' && (
                <button
                  type="button"
                  onClick={() => setFocusedCharacterId('all')}
                  className="rounded border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-amber-300 hover:bg-slate-800"
                >
                  중심 인물 필터 해제
                </button>
              )}
            </div>
          </div>

          {graphLayout.nodes.length === 0 ? (
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-8 text-center text-xs text-slate-400">
              표시할 등장인물 노드가 없습니다.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-800/90 bg-slate-950">
              <svg
                viewBox={`0 0 ${graphLayout.width} ${graphLayout.height}`}
                className="w-full min-w-[600px] max-h-[440px]"
                role="img"
                aria-label="등장인물 관계도 그래프"
              >
                <defs>
                  <marker
                    id="arrow-pos-end"
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                  >
                    <path d="M 0 1 L 10 5 L 0 9 z" fill="#34d399" />
                  </marker>
                  <marker
                    id="arrow-pos-start"
                    viewBox="0 0 10 10"
                    refX="2"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                  >
                    <path d="M 10 1 L 0 5 L 10 9 z" fill="#34d399" />
                  </marker>
                  <marker
                    id="arrow-neu-end"
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                  >
                    <path d="M 0 1 L 10 5 L 0 9 z" fill="#fbbf24" />
                  </marker>
                  <marker
                    id="arrow-neu-start"
                    viewBox="0 0 10 10"
                    refX="2"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                  >
                    <path d="M 10 1 L 0 5 L 10 9 z" fill="#fbbf24" />
                  </marker>
                  <marker
                    id="arrow-neg-end"
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                  >
                    <path d="M 0 1 L 10 5 L 0 9 z" fill="#fb7185" />
                  </marker>
                  <marker
                    id="arrow-neg-start"
                    viewBox="0 0 10 10"
                    refX="2"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                  >
                    <path d="M 10 1 L 0 5 L 10 9 z" fill="#fb7185" />
                  </marker>
                </defs>

                {/* Edges */}
                {graphLayout.edges.map(({ relationship, pathD, labelX, labelY }) => {
                  const score = relationship.affinityScore;
                  const tone =
                    score >= 25 ? 'pos' : score <= -25 ? 'neg' : 'neu';
                  const strokeColor =
                    tone === 'pos'
                      ? '#34d399'
                      : tone === 'neg'
                      ? '#fb7185'
                      : '#fbbf24';
                  const isCanon = relationship.canonStatus === 'CANON';

                  return (
                    <g
                      key={relationship.id}
                      onClick={() => openEditForm(relationship)}
                      className="cursor-pointer group"
                    >
                      <path
                        d={pathD}
                        fill="none"
                        stroke={strokeColor}
                        strokeWidth={isCanon ? 2.4 : 1.8}
                        strokeDasharray={isCanon ? undefined : '6 4'}
                        strokeOpacity={0.85}
                        markerEnd={`url(#arrow-${tone}-end)`}
                        markerStart={
                          relationship.isDirectional
                            ? undefined
                            : `url(#arrow-${tone}-start)`
                        }
                      />
                      <rect
                        x={labelX - 58}
                        y={labelY - 11}
                        width={116}
                        height={22}
                        rx={6}
                        fill="#0f172a"
                        stroke={strokeColor}
                        strokeWidth={1}
                        strokeOpacity={0.6}
                      />
                      <text
                        x={labelX}
                        y={labelY + 4}
                        textAnchor="middle"
                        className="fill-slate-100 text-[10px] font-medium select-none"
                      >
                        {relationship.relationType.slice(0, 10)} (
                        {score > 0 ? `+${score}` : score})
                      </text>
                    </g>
                  );
                })}

                {/* Character Nodes */}
                {graphLayout.nodes.map(({ x, y, character, degree }) => {
                  const isFocused = focusedCharacterId === character.id;
                  return (
                    <g
                      key={character.id}
                      transform={`translate(${x}, ${y})`}
                      onClick={() =>
                        setFocusedCharacterId((prev) =>
                          prev === character.id ? 'all' : character.id
                        )
                      }
                      className="cursor-pointer"
                    >
                      <circle
                        r={26}
                        fill={isFocused ? '#f59e0b' : '#1e293b'}
                        stroke={
                          isFocused
                            ? '#fde68a'
                            : character.status === 'confirmed'
                            ? '#34d399'
                            : '#94a3b8'
                        }
                        strokeWidth={isFocused ? 3 : 2}
                      />
                      <text
                        y={4}
                        textAnchor="middle"
                        className={`text-xs font-bold select-none ${
                          isFocused ? 'fill-slate-950' : 'fill-slate-100'
                        }`}
                      >
                        {character.name.slice(0, 4)}
                      </text>
                      <text
                        y={42}
                        textAnchor="middle"
                        className="fill-slate-200 text-[11px] font-semibold select-none"
                      >
                        {character.name}
                      </text>
                      <text
                        y={56}
                        textAnchor="middle"
                        className="fill-slate-400 text-[10px] select-none"
                      >
                        {character.role} · 연결 {degree}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          )}
        </section>
      )}

      {/* Relationships List View */}
      {(viewMode === 'both' || viewMode === 'list') && (
        <section aria-label="등장인물 관계 목록" className="space-y-3">
          {filteredRelationships.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-12 text-center">
              <Users className="mx-auto h-8 w-8 text-slate-500 mb-2" />
              <p className="text-sm text-slate-300">
                조건에 맞는 등장인물 관계가 없습니다.
              </p>
              {characters.length >= 2 && (
                <button
                  type="button"
                  onClick={openCreateForm}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400"
                >
                  <Plus className="h-4 w-4" />
                  <span>첫 인물 관계 추가하기</span>
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {filteredRelationships.map((rel) => {
                const srcChar = characterMap.get(rel.sourceCharacterId);
                const tgtChar = characterMap.get(rel.targetCharacterId);
                const effEp = rel.effectiveEpisodeId
                  ? episodeMap.get(rel.effectiveEpisodeId)
                  : undefined;
                const effEvt = rel.effectiveEventId
                  ? eventMap.get(rel.effectiveEventId)
                  : undefined;

                const hasBrokenRef =
                  !srcChar ||
                  !tgtChar ||
                  Boolean(rel.effectiveEpisodeId && !effEp) ||
                  Boolean(rel.effectiveEventId && !effEvt);

                return (
                  <article
                    key={rel.id}
                    className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/85 p-5 hover:border-slate-700 transition-colors"
                  >
                    <div className="space-y-3">
                      {/* Top Status & Actions Row */}
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${getCanonBadgeStyle(
                              rel.canonStatus
                            )}`}
                          >
                            {rel.canonStatus === 'CANON' ? (
                              <ShieldCheck className="h-3 w-3" />
                            ) : (
                              <Clock className="h-3 w-3" />
                            )}
                            <span>{formatCanonStatusKorean(rel.canonStatus)}</span>
                          </span>

                          <span
                            className={`inline-flex items-center rounded-md border px-2 py-0.5 font-mono-tabular text-[11px] font-semibold ${getAffinityBadgeStyle(
                              rel.affinityScore
                            )}`}
                          >
                            우호도{' '}
                            {rel.affinityScore > 0
                              ? `+${rel.affinityScore}`
                              : rel.affinityScore}
                          </span>

                          <span className="rounded-md border border-slate-800 bg-slate-950 px-2 py-0.5 text-[11px] text-slate-400">
                            {rel.isDirectional ? '단방향 (A → B)' : '양방향 (A ↔ B)'}
                          </span>

                          {hasBrokenRef && (
                            <span className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-300">
                              <AlertTriangle className="h-3 w-3" />
                              <span>참조 확인 필요</span>
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          {(rel.canonStatus === 'DRAFT' ||
                            rel.canonStatus === 'PROPOSED') && (
                            <button
                              type="button"
                              onClick={() => setPromoteTarget(rel)}
                              disabled={isSubmitting}
                              className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-500/25 transition-colors"
                            >
                              <Sparkles className="h-3 w-3" />
                              <span>정사로 확정</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => openEditForm(rel)}
                            aria-label="관계 수정"
                            className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(rel)}
                            aria-label="관계 삭제"
                            className="rounded p-1.5 text-slate-400 hover:bg-rose-500/15 hover:text-rose-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* Character Pair & Relation Type */}
                      <div className="rounded-lg border border-slate-800/90 bg-slate-950/70 p-3.5">
                        <div className="flex flex-wrap items-center gap-2 text-sm font-bold text-slate-100">
                          <button
                            type="button"
                            onClick={() =>
                              setFocusedCharacterId((prev) =>
                                prev === rel.sourceCharacterId
                                  ? 'all'
                                  : rel.sourceCharacterId
                              )
                            }
                            className="hover:text-amber-400 transition-colors"
                          >
                            {srcChar ? srcChar.name : `삭제된 인물 (${rel.sourceCharacterId})`}
                          </button>
                          <span className="text-amber-400 font-mono">
                            {rel.isDirectional ? '→' : '↔'}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setFocusedCharacterId((prev) =>
                                prev === rel.targetCharacterId
                                  ? 'all'
                                  : rel.targetCharacterId
                              )
                            }
                            className="hover:text-amber-400 transition-colors"
                          >
                            {tgtChar ? tgtChar.name : `삭제된 인물 (${rel.targetCharacterId})`}
                          </button>
                        </div>
                        <div className="mt-1 text-xs font-semibold text-amber-300">
                          {rel.relationType}
                        </div>
                      </div>

                      {rel.description && (
                        <p className="text-xs leading-relaxed text-slate-300 whitespace-pre-line">
                          {rel.description}
                        </p>
                      )}
                    </div>

                    {/* Footer Links: Episode, Event, Provenance */}
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 pt-3 text-[11px] text-slate-400">
                      <div className="flex flex-wrap items-center gap-2">
                        {rel.effectiveEpisodeId ? (
                          effEp ? (
                            <button
                              type="button"
                              onClick={() => onNavigateToEpisode?.(effEp.id)}
                              className="rounded border border-slate-800 bg-slate-950 px-2 py-0.5 text-slate-300 hover:border-amber-500/40 hover:text-amber-300"
                            >
                              발효 회차: 제{effEp.episodeNumber}화
                            </button>
                          ) : (
                            <span className="text-rose-300">
                              발효 회차 참조 유실 ({rel.effectiveEpisodeId})
                            </span>
                          )
                        ) : (
                          <span>발효 회차: 작품 기본</span>
                        )}

                        {rel.effectiveEventId && (
                          <>
                            <span>·</span>
                            {effEvt ? (
                              <button
                                type="button"
                                onClick={() => onNavigateToTimeline?.()}
                                className="rounded border border-slate-800 bg-slate-950 px-2 py-0.5 text-slate-300 hover:border-sky-500/40 hover:text-sky-300"
                              >
                                계기 사건: {effEvt.title}
                              </button>
                            ) : (
                              <span className="text-rose-300">
                                사건 참조 유실 ({rel.effectiveEventId})
                              </span>
                            )}
                          </>
                        )}
                      </div>

                      <div className="font-mono-tabular text-[10px] text-slate-500">
                        작성: {rel.createdBy}
                        {rel.sourceRevisionId ? ` · rev:${rel.sourceRevisionId.slice(0, 10)}` : ''}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Modal 1: Promote DRAFT/PROPOSED -> CANON Confirmation */}
      {promoteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="promote-canon-rel-title"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <ShieldCheck className="h-5 w-5 text-emerald-400" />
                <h2
                  id="promote-canon-rel-title"
                  className="text-base font-bold text-slate-100"
                >
                  인물 관계 정사(CANON) 확정 승인
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
              <div className="font-semibold text-slate-100">
                {formatCharName(promoteTarget.sourceCharacterId)}{' '}
                {promoteTarget.isDirectional ? '→' : '↔'}{' '}
                {formatCharName(promoteTarget.targetCharacterId)}
              </div>
              <div className="text-amber-300">
                유형: {promoteTarget.relationType} (우호도{' '}
                {promoteTarget.affinityScore > 0
                  ? `+${promoteTarget.affinityScore}`
                  : promoteTarget.affinityScore}
                )
              </div>
              {promoteTarget.description && (
                <p className="text-slate-400">{promoteTarget.description}</p>
              )}
            </div>

            <p className="text-xs leading-relaxed text-slate-300">
              이 인물 관계를 <strong>작가 확정 정사(CANON)</strong>로 승격하시겠습니까? 정사로 확정된 관계는 이후 집필 및 정합성 검사의 기준이 되며, 향후 수정 시 정사 보호 확인 절차가 적용됩니다.
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
          aria-labelledby="canon-diff-rel-title"
        >
          <div className="w-full max-w-xl rounded-xl border border-amber-500/40 bg-slate-900 p-6 shadow-2xl space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <GitCompare className="h-5 w-5 text-amber-400 shrink-0" />
                <div>
                  <h2
                    id="canon-diff-rel-title"
                    className="text-base font-bold text-slate-100"
                  >
                    확정 정사(CANON) 인물 관계 변경 확인
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

      {/* Modal 3: Delete / Archive Relationship Confirmation */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-rel-modal-title"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <AlertTriangle className="h-5 w-5 text-rose-400" />
                <h2
                  id="delete-rel-modal-title"
                  className="text-base font-bold text-slate-100"
                >
                  {deleteTarget.canonStatus === 'CANON'
                    ? '확정 정사(CANON) 인물 관계 삭제·보관 확인'
                    : '인물 관계 삭제 확인'}
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
                {formatCharName(deleteTarget.sourceCharacterId)}{' '}
                {deleteTarget.isDirectional ? '→' : '↔'}{' '}
                {formatCharName(deleteTarget.targetCharacterId)} ({deleteTarget.relationType})
              </strong>{' '}
              관계 항목을 삭제하시겠습니까? (연결된 등장인물이나 회차 원본 데이터는 삭제되지 않습니다.)
            </p>

            {deleteTarget.canonStatus === 'CANON' && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                이 관계는 이미 <strong>정사(CANON)</strong>로 확정된 설정입니다. 영구 삭제 대신{' '}
                <strong>보관(ARCHIVED)</strong> 상태로 전환하면 과거 기록을 보존할 수 있습니다.
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
                    await onDeleteRelationship(
                      deleteTarget.id,
                      deleteTarget.canonStatus
                    );
                    setDeleteTarget(null);
                  } catch (err) {
                    setFormError(
                      err instanceof Error
                        ? err.message
                        : '인물 관계 삭제 중 오류가 발생했습니다.'
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
