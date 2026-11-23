import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  CheckSquare,
  Clock,
  Cpu,
  Database,
  Eye,
  FileSearch,
  Filter,
  GitBranch,
  HardDrive,
  HelpCircle,
  Info,
  Layers,
  Loader2,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Users,
  XCircle,
} from 'lucide-react';
import type {
  ChangeProposal,
  Character,
  CharacterRelationship,
  Episode,
  ExtractionCandidateType,
  ExtractionUncertaintyFlag,
  Foreshadowing,
  LocalPreviewSnapshotInput,
  ManuscriptExtractionResponse,
  NavTab,
  Project,
  Revision,
  SavedProposalItemResult,
  SaveExtractionProposalsResponse,
  Scene,
  TimelineEvent,
  VerifiedExtractionCandidate,
  WorldbuildingItem,
} from '../types/novel';
import { applyAuthorSpanDisambiguationToCandidate } from '../utils/manuscriptExtractionLogic';

export type ExtractionUiState =
  | 'IDLE'
  | 'ANALYZING'
  | 'READY_FOR_REVIEW'
  | 'SAVING_PROPOSALS'
  | 'COMPLETED'
  | 'FAILED';

export interface AiExtractionPanelProps {
  project: Project;
  episodes: Episode[];
  revisions: Revision[];
  scenes: Scene[];
  characters: Character[];
  worldbuilding: WorldbuildingItem[];
  relationships: CharacterRelationship[];
  timelineEvents: TimelineEvent[];
  foreshadowings: Foreshadowing[];
  changeProposals: ChangeProposal[];
  selectedEpisodeId: string | null;
  onSelectEpisodeId: (episodeId: string) => void;
  isCloudAuthenticated: boolean;
  getIdToken: () => Promise<string | null>;
  onProposalsSaved: (newProposals: ChangeProposal[]) => void;
  onNavigateTab: (tab: NavTab) => void;
  onOpenProposalReview?: (proposalId?: string) => void;
}

const CANDIDATE_TYPE_LABELS: Record<ExtractionCandidateType, string> = {
  RELATIONSHIP: '인물 관계',
  TIMELINE_EVENT: '연표 사건',
  FORESHADOWING: '복선 단서',
};

const TEMPORAL_CONTEXT_LABELS: Record<string, string> = {
  PRESENT_EVENT: '현재 진행 사건',
  FLASHBACK: '과거 회상 (Flashback)',
  PAST_MENTION: '과거 사건 언급',
  PROPHECY_OR_RUMOR: '예언 / 소문',
  HYPOTHETICAL_OR_DREAM: '가정 / 꿈 / 환상',
};

const UNCERTAINTY_FLAG_LABELS: Record<ExtractionUncertaintyFlag, string> = {
  AMBIGUOUS_CHARACTER_REFERENCE: '인물 지칭 모호',
  HOMONYM_CHARACTER_NAME: '동명이인 주의',
  NEW_UNREGISTERED_CHARACTER: '미등록 신규 인물',
  DIALOGUE_CLAIM_ONLY: '대사/발화자 주장 단독 근거',
  FLASHBACK_OR_PAST_MENTION: '회상/과거 언급',
  RUMOR_OR_PROPHECY: '소문/예언 맥락',
  CONFLICTS_WITH_CANON: '기존 CANON 설정 충돌 주의',
  TIMELINE_ORDER_UNCERTAIN: '연표 순서 추정치',
  CLUE_PHASE_UNCERTAIN: '복선 단계 불확실',
};

export const AiExtractionPanel: React.FC<AiExtractionPanelProps> = ({
  project,
  episodes,
  revisions,
  scenes,
  characters,
  worldbuilding,
  relationships,
  timelineEvents,
  foreshadowings,
  changeProposals,
  selectedEpisodeId,
  onSelectEpisodeId,
  isCloudAuthenticated,
  getIdToken,
  onProposalsSaved,
  onNavigateTab,
  onOpenProposalReview,
}) => {
  const sortedEpisodes = useMemo(
    () => [...episodes].sort((a, b) => a.episodeNumber - b.episodeNumber),
    [episodes]
  );

  const activeEpisodeId = useMemo(() => {
    if (selectedEpisodeId && sortedEpisodes.some((e) => e.id === selectedEpisodeId)) {
      return selectedEpisodeId;
    }
    return sortedEpisodes[0]?.id || '';
  }, [selectedEpisodeId, sortedEpisodes]);

  const activeEpisode = useMemo(
    () => sortedEpisodes.find((e) => e.id === activeEpisodeId) || null,
    [sortedEpisodes, activeEpisodeId]
  );

  const episodeRevisions = useMemo(() => {
    if (!activeEpisodeId) return [];
    return revisions
      .filter((r) => r.episodeId === activeEpisodeId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [revisions, activeEpisodeId]);

  const [selectedRevisionId, setSelectedRevisionId] = useState<string>('');

  useEffect(() => {
    if (!activeEpisode) {
      setSelectedRevisionId('');
      return;
    }
    if (
      selectedRevisionId &&
      episodeRevisions.some((r) => r.id === selectedRevisionId)
    ) {
      return;
    }
    if (
      activeEpisode.latestRevisionId &&
      episodeRevisions.some((r) => r.id === activeEpisode.latestRevisionId)
    ) {
      setSelectedRevisionId(activeEpisode.latestRevisionId);
    } else if (episodeRevisions.length > 0) {
      setSelectedRevisionId(episodeRevisions[0].id);
    } else {
      setSelectedRevisionId('');
    }
  }, [activeEpisode, episodeRevisions, selectedRevisionId]);

  const activeRevision = useMemo(
    () => episodeRevisions.find((r) => r.id === selectedRevisionId) || null,
    [episodeRevisions, selectedRevisionId]
  );

  // State machine & extraction results
  const [uiState, setUiState] = useState<ExtractionUiState>('IDLE');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [extractionResult, setExtractionResult] =
    useState<ManuscriptExtractionResponse | null>(null);
  const [spanOverrides, setSpanOverrides] = useState<
    Record<string, { startOffset: number; endOffset: number }>
  >({});
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [activeCandidateForViewerId, setActiveCandidateForViewerId] = useState<
    string | null
  >(null);
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState<boolean>(false);
  const [lastSaveResponse, setLastSaveResponse] =
    useState<SaveExtractionProposalsResponse | null>(null);

  // Filters
  const [typeFilter, setTypeFilter] = useState<'ALL' | ExtractionCandidateType>('ALL');
  const [statusFilter, setStatusFilter] = useState<
    'ALL' | 'VERIFIED' | 'AMBIGUOUS_MULTIPLE_MATCHES' | 'UNVERIFIED_EXCERPT'
  >('ALL');

  // Recompute candidates locally when author selects a multi-match span override
  const resolvedCandidates = useMemo<VerifiedExtractionCandidate[]>(() => {
    if (!extractionResult || !activeRevision) return [];
    return extractionResult.candidates.map((cand) => {
      const override = spanOverrides[cand.candidateId];
      if (!override) return cand;
      return applyAuthorSpanDisambiguationToCandidate({
        candidate: cand,
        selectedSpan: override,
        revisionContent: activeRevision.content,
        ownerId: project.ownerId,
        projectId: project.id,
        existingProposals: changeProposals,
      });
    });
  }, [
    extractionResult,
    activeRevision,
    spanOverrides,
    project.ownerId,
    project.id,
    changeProposals,
  ]);

  const filteredCandidates = useMemo(() => {
    return resolvedCandidates.filter((cand) => {
      if (typeFilter !== 'ALL' && cand.targetEntityType !== typeFilter) {
        return false;
      }
      if (statusFilter !== 'ALL' && cand.verification.status !== statusFilter) {
        return false;
      }
      return true;
    });
  }, [resolvedCandidates, typeFilter, statusFilter]);

  const savableCandidates = useMemo(
    () =>
      resolvedCandidates.filter(
        (c) =>
          c.verification.status === 'VERIFIED' &&
          c.canSaveAsProposal &&
          c.proposalDraft !== null
      ),
    [resolvedCandidates]
  );

  const selectedCandidatesList = useMemo(() => {
    const idSet = new Set(selectedCandidateIds);
    return savableCandidates.filter((c) => idSet.has(c.candidateId));
  }, [savableCandidates, selectedCandidateIds]);

  const activeCandidateForViewer = useMemo(() => {
    if (!activeCandidateForViewerId) {
      return filteredCandidates[0] || resolvedCandidates[0] || null;
    }
    return (
      resolvedCandidates.find((c) => c.candidateId === activeCandidateForViewerId) ||
      filteredCandidates[0] ||
      null
    );
  }, [activeCandidateForViewerId, filteredCandidates, resolvedCandidates]);

  const buildLocalPreviewSnapshot = (): LocalPreviewSnapshotInput | undefined => {
    if (isCloudAuthenticated || !activeEpisode || !activeRevision) {
      return undefined;
    }
    return {
      project: {
        id: project.id,
        ownerId: project.ownerId,
        title: project.title,
      },
      episode: {
        id: activeEpisode.id,
        projectId: project.id,
        episodeNumber: activeEpisode.episodeNumber,
        title: activeEpisode.title,
        currentRevisionId: activeEpisode.latestRevisionId || activeRevision.id,
      },
      revision: {
        id: activeRevision.id,
        episodeId: activeEpisode.id,
        projectId: project.id,
        content: activeRevision.content,
        canonStatus: 'DRAFT',
      },
      scenes: scenes
        .filter((s) => s.episodeId === activeEpisode.id)
        .map((s) => ({
          id: s.id,
          episodeId: s.episodeId,
          sceneNumber: s.sceneNumber,
          title: s.title,
          summary: s.summary,
          location: s.location,
        })),
      characters: characters.map((c) => ({
        id: c.id,
        name: c.name,
        role: c.role,
        description: `${c.personality || ''} ${c.background || ''}`.trim(),
        canonStatus: c.canonStatus,
      })),
      worldbuilding: worldbuilding.map((w) => ({
        id: w.id,
        title: w.title,
        category: w.category,
        content: w.content,
        canonStatus: w.canonStatus,
      })),
      relationships,
      timelineEvents,
      foreshadowings,
      existingProposals: changeProposals,
    };
  };

  const handleRunAnalysis = async () => {
    if (!activeEpisode || !activeRevision) {
      setErrorMessage(
        '분석할 회차와 저장된 리비전을 먼저 선택해 주세요. 리비전이 없다면 원고 집필 탭에서 리비전을 저장해 주세요.'
      );
      setUiState('FAILED');
      return;
    }
    if (!activeRevision.content || activeRevision.content.trim().length === 0) {
      setErrorMessage('선택된 리비전의 원고 본문이 비어 있어 분석할 수 없습니다.');
      setUiState('FAILED');
      return;
    }
    if (uiState === 'ANALYZING' || uiState === 'SAVING_PROPOSALS') {
      return;
    }

    setUiState('ANALYZING');
    setErrorMessage(null);
    setLastSaveResponse(null);
    setSpanOverrides({});
    setSelectedCandidateIds([]);
    setIsConfirmModalOpen(false);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (isCloudAuthenticated) {
        const token = await getIdToken();
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }
      }

      const response = await fetch('/api/ai/extract-manuscript', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          projectId: project.id,
          episodeId: activeEpisode.id,
          revisionId: activeRevision.id,
          persistProposals: false,
          localPreviewSnapshot: buildLocalPreviewSnapshot(),
        }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || `원고 분석 요청 실패 (HTTP ${response.status})`);
      }

      const result = data as ManuscriptExtractionResponse;
      setExtractionResult(result);

      // Phase 4.2.2 Section 3.2: Default all candidates to unselected ([]).
      // The author must explicitly check candidates or click "검증 후보 전체 선택" before saving.
      setSelectedCandidateIds([]);
      if (result.candidates.length > 0) {
        setActiveCandidateForViewerId(result.candidates[0].candidateId);
      }
      setUiState('READY_FOR_REVIEW');
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'AI 원고 설정 추출 중 알 수 없는 오류가 발생했습니다.';
      setErrorMessage(msg);
      setUiState('FAILED');
    }
  };

  const handleToggleCandidateSelection = (candidateId: string) => {
    setSelectedCandidateIds((prev) =>
      prev.includes(candidateId)
        ? prev.filter((id) => id !== candidateId)
        : [...prev, candidateId]
    );
  };

  const handleSelectAllSavable = () => {
    setSelectedCandidateIds(savableCandidates.map((c) => c.candidateId));
  };

  const handleClearSelection = () => {
    setSelectedCandidateIds([]);
  };

  const handleSelectAmbiguousSpan = (
    candidateId: string,
    startOffset: number,
    endOffset: number
  ) => {
    setSpanOverrides((prev) => ({
      ...prev,
      [candidateId]: { startOffset, endOffset },
    }));
    setActiveCandidateForViewerId(candidateId);
    // Automatically add to selected if it becomes savable
    setSelectedCandidateIds((prev) =>
      prev.includes(candidateId) ? prev : [...prev, candidateId]
    );
  };

  const handleConfirmSaveProposals = async () => {
    if (!extractionResult || !activeEpisode || !activeRevision) return;
    if (selectedCandidatesList.length === 0) {
      setErrorMessage('저장할 후보를 1개 이상 선택해 주세요.');
      return;
    }
    if (uiState === 'SAVING_PROPOSALS' || uiState === 'ANALYZING') {
      return;
    }

    setUiState('SAVING_PROPOSALS');
    setErrorMessage(null);
    setIsConfirmModalOpen(false);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (isCloudAuthenticated) {
        const token = await getIdToken();
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }
      }

      const response = await fetch('/api/ai/save-extraction-proposals', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          projectId: project.id,
          episodeId: activeEpisode.id,
          revisionId: activeRevision.id,
          analysisRunId: extractionResult.analysisRunId,
          analysisToken: extractionResult.analysisToken,
          selectedCandidateIds: selectedCandidatesList.map((c) => c.candidateId),
          selectedCandidateSpanOverrides: spanOverrides,
          localPreviewSnapshot: buildLocalPreviewSnapshot(),
        }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(
          data.error || `선택 후보 제안서 저장 실패 (HTTP ${response.status})`
        );
      }

      const saveRes = data as SaveExtractionProposalsResponse;
      setLastSaveResponse(saveRes);
      if (saveRes.savedProposals.length > 0) {
        onProposalsSaved(saveRes.savedProposals);
      }
      setSelectedCandidateIds([]);
      setUiState('COMPLETED');
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : '선택 후보 제안서 저장 중 오류가 발생했습니다.';
      setErrorMessage(msg);
      setUiState('FAILED');
    }
  };

  // Render helper for highlighted manuscript excerpt viewer
  const renderManuscriptExcerptContext = () => {
    if (!activeRevision || !activeRevision.content) {
      return (
        <div className="p-4 text-xs text-zinc-500">
          선택된 리비전 원문이 없습니다.
        </div>
      );
    }

    const content = activeRevision.content;
    const activeSpan = activeCandidateForViewer?.verification.verifiedSpan;

    if (!activeSpan) {
      return (
        <div className="space-y-3 p-4">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>리비전 전체 본문 미리보기 ({content.length.toLocaleString()}자)</span>
            {activeCandidateForViewer && (
              <span className="text-amber-400">
                현재 선택된 후보는 확정된 단일 오프셋이 없습니다 (
                {activeCandidateForViewer.verification.status})
              </span>
            )}
          </div>
          <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded border border-zinc-800 bg-zinc-950/90 p-3 font-serif text-xs leading-relaxed text-zinc-300">
            {content}
          </div>
        </div>
      );
    }

    const { startOffset, endOffset } = activeSpan;
    const contextRadius = 280;
    const sliceStart = Math.max(0, startOffset - contextRadius);
    const sliceEnd = Math.min(content.length, endOffset + contextRadius);

    const beforeText = content.slice(sliceStart, startOffset);
    const highlightedText = content.slice(startOffset, endOffset);
    const afterText = content.slice(endOffset, sliceEnd);

    return (
      <div className="space-y-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-mono text-emerald-400">
              UTF-16 [{startOffset}, {endOffset})
            </span>
            <span className="text-zinc-500">|</span>
            <span className="text-zinc-300">
              매칭 방식:{' '}
              <strong className="text-indigo-300">
                {activeSpan.matchMethod === 'EXACT'
                  ? '원문 완전 일치 (EXACT)'
                  : '공백 정규화 일치 (WHITESPACE_NORMALIZED)'}
              </strong>
            </span>
          </div>
          <span className="font-mono text-[11px] text-zinc-400">
            발췌 길이: {endOffset - startOffset} code units
          </span>
        </div>

        <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded border border-zinc-800 bg-zinc-950 p-3.5 font-serif text-xs leading-relaxed text-zinc-300">
          {sliceStart > 0 && <span className="text-zinc-600">…</span>}
          <span>{beforeText}</span>
          <mark className="rounded bg-amber-500/25 px-1 py-0.5 font-medium text-amber-200 ring-1 ring-amber-400/50">
            {highlightedText}
          </mark>
          <span>{afterText}</span>
          {sliceEnd < content.length && <span className="text-zinc-600">…</span>}
        </div>
      </div>
    );
  };

  const episodeProposals = useMemo(
    () =>
      changeProposals.filter(
        (p) => !activeEpisodeId || p.triggerEpisodeId === activeEpisodeId
      ),
    [changeProposals, activeEpisodeId]
  );

  return (
    <div className="space-y-6">
      {/* Header & Execution Mode Banner */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Sparkles className="h-5 w-5 text-indigo-400" />
              <h2 className="text-lg font-bold text-zinc-100">
                AI 원고 설정 추출 및 제안서(ChangeProposal) 검토
              </h2>
              {isCloudAuthenticated ? (
                <span className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-950/50 px-2 py-0.5 font-mono text-[11px] text-emerald-300">
                  <Database className="h-3 w-3" />
                  CLOUD_AUTHENTICATED (서버 권위 리비전 검증)
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-950/50 px-2 py-0.5 font-mono text-[11px] text-amber-300">
                  <HardDrive className="h-3 w-3" />
                  LOCAL_PREVIEW (로컬 미리보기 전용 · 클라우드 DB 미기록)
                </span>
              )}
            </div>
            <p className="text-xs text-zinc-400">
              저장된 리비전 원고(Revision.content)를 AI가 분석하여 인물 관계·연표 사건·복선 후보를 추출하고, 서버가 UTF-16 원문 오프셋{' '}
              <code className="font-mono text-zinc-300">[startOffset, endOffset)</code>을 직접 검증합니다. 검증된 후보 중 작가가 선택한 항목만{' '}
              <strong className="text-amber-300">승인 대기(PROPOSED)</strong> 제안서로 저장됩니다.
            </p>
          </div>

          {/* State Machine Status Pill */}
          <div className="flex shrink-0 items-center gap-2 self-start whitespace-nowrap lg:self-center">
            <span className="text-xs text-zinc-400">진행 상태:</span>
            <span
              data-testid="extraction-ui-state-badge"
              className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 font-mono text-xs font-medium ${
                uiState === 'ANALYZING' || uiState === 'SAVING_PROPOSALS'
                  ? 'border-indigo-500/50 bg-indigo-950/60 text-indigo-300'
                  : uiState === 'READY_FOR_REVIEW'
                  ? 'border-amber-500/50 bg-amber-950/60 text-amber-300'
                  : uiState === 'COMPLETED'
                  ? 'border-emerald-500/50 bg-emerald-950/60 text-emerald-300'
                  : uiState === 'FAILED'
                  ? 'border-rose-500/50 bg-rose-950/60 text-rose-300'
                  : 'border-zinc-700 bg-zinc-800/80 text-zinc-300'
              }`}
            >
              {(uiState === 'ANALYZING' || uiState === 'SAVING_PROPOSALS') && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              {uiState}
            </span>
          </div>
        </div>

        {/* Episode & Revision Controls */}
        <div className="mt-5 grid grid-cols-1 gap-4 border-t border-zinc-800/80 pt-4 md:grid-cols-12">
          <div className="md:col-span-4">
            <label className="mb-1.5 block text-xs font-medium text-zinc-300">
              1. 분석 대상 회차 (Episode)
            </label>
            <select
              data-testid="extraction-episode-select"
              value={activeEpisodeId}
              onChange={(e) => {
                onSelectEpisodeId(e.target.value);
                setExtractionResult(null);
                setLastSaveResponse(null);
                setUiState('IDLE');
              }}
              disabled={uiState === 'ANALYZING' || uiState === 'SAVING_PROPOSALS'}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 focus:border-indigo-500 focus:outline-none"
            >
              {sortedEpisodes.length === 0 ? (
                <option value="">등록된 회차가 없습니다</option>
              ) : (
                sortedEpisodes.map((ep) => (
                  <option key={ep.id} value={ep.id}>
                    제{ep.episodeNumber}화 — {ep.title} ({ep.charCountWithSpaces.toLocaleString()}자)
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="md:col-span-5">
            <label className="mb-1.5 block text-xs font-medium text-zinc-300">
              2. 저장된 리비전 스냅샷 (Saved Revision)
            </label>
            <select
              data-testid="extraction-revision-select"
              value={selectedRevisionId}
              onChange={(e) => {
                setSelectedRevisionId(e.target.value);
                setExtractionResult(null);
                setLastSaveResponse(null);
                setUiState('IDLE');
              }}
              disabled={
                episodeRevisions.length === 0 ||
                uiState === 'ANALYZING' ||
                uiState === 'SAVING_PROPOSALS'
              }
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
            >
              {episodeRevisions.length === 0 ? (
                <option value="">저장된 리비전이 없습니다 (먼저 리비전을 생성하세요)</option>
              ) : (
                episodeRevisions.map((rev) => (
                  <option key={rev.id} value={rev.id}>
                    [{rev.label}] {rev.id} ({rev.charCountWithSpaces.toLocaleString()}자 ·{' '}
                    {new Date(rev.createdAt).toLocaleString('ko-KR')})
                    {activeEpisode?.latestRevisionId === rev.id ? ' ★최신' : ''}
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="flex items-end md:col-span-3">
            <button
              type="button"
              data-testid="run-manuscript-extraction-btn"
              onClick={handleRunAnalysis}
              disabled={
                !activeEpisode ||
                !activeRevision ||
                uiState === 'ANALYZING' ||
                uiState === 'SAVING_PROPOSALS'
              }
              className="flex w-full items-center justify-center gap-2 rounded bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              {uiState === 'ANALYZING' ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  AI 원고 분석 및 오프셋 검증 중...
                </>
              ) : (
                <>
                  <FileSearch className="h-4 w-4" />
                  AI 설정 후보 분석 실행
                </>
              )}
            </button>
          </div>
        </div>

        {/* Missing Revision Warning */}
        {activeEpisode && episodeRevisions.length === 0 && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded border border-amber-500/40 bg-amber-950/30 px-4 py-3 text-xs text-amber-200">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
              <span>
                현재 선택된 <strong>제{activeEpisode.episodeNumber}화 ({activeEpisode.title})</strong>에 저장된 리비전이 없습니다. AI 설정 추출은 불변 근거 추적을 위해 반드시 저장된 리비전(Revision)을 기준으로 실행됩니다.
              </span>
            </div>
            <button
              type="button"
              onClick={() => onNavigateTab('manuscript')}
              className="inline-flex items-center gap-1 rounded border border-amber-400/50 bg-amber-900/40 px-3 py-1 text-xs font-medium text-amber-100 hover:bg-amber-800/50"
            >
              원고 집필 화면에서 리비전 저장하기
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Error Banner */}
        {errorMessage && (
          <div
            data-testid="extraction-error-banner"
            className="mt-4 flex items-start justify-between gap-3 rounded border border-rose-500/40 bg-rose-950/40 px-4 py-3 text-xs text-rose-200"
          >
            <div className="flex items-start gap-2">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
              <div>
                <p className="font-semibold text-rose-300">원고 분석 / 제안서 저장 오류</p>
                <p className="mt-0.5 text-rose-200/90">{errorMessage}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setErrorMessage(null)}
              className="text-rose-300 hover:text-white"
            >
              닫기
            </button>
          </div>
        )}

        {/* Save Completion Feedback Banner */}
        {lastSaveResponse && (
          <div
            data-testid="extraction-save-success-banner"
            className="mt-4 rounded border border-emerald-500/40 bg-emerald-950/30 p-4 text-xs text-emerald-100"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                <span className="font-semibold">
                  선택한 후보 제안서(PROPOSED) 저장 처리가 완료되었습니다! (Gemini 재호출 없음)
                </span>
              </div>
              <div className="flex items-center gap-3 font-mono text-[11px]">
                <span>선택: {lastSaveResponse.selectedCount}건</span>
                <span className="text-emerald-300">
                  신규 생성: {lastSaveResponse.createdCount}건
                </span>
                <span className="text-amber-300">
                  중복 건너뜀: {lastSaveResponse.skippedDuplicateCount}건
                </span>
              </div>
            </div>

            {lastSaveResponse.itemResults.length > 0 && (
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {lastSaveResponse.itemResults.map((item: SavedProposalItemResult) => (
                  <div
                    key={item.candidateId}
                    className="flex items-center justify-between rounded border border-emerald-800/50 bg-zinc-950/70 px-3 py-1.5 text-[11px]"
                  >
                    <span className="truncate font-medium text-zinc-200">
                      {item.proposal.title}
                    </span>
                    <span
                      className={`ml-2 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${
                        item.disposition === 'CREATED_NEW'
                          ? 'bg-emerald-900/60 text-emerald-300'
                          : 'bg-amber-900/60 text-amber-300'
                      }`}
                    >
                      {item.disposition}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Analysis Results Section */}
      {extractionResult && (
        <div className="space-y-6">
          {/* KPI Summary Bar & Audit Info */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
              <div className="text-[11px] text-zinc-400">전체 추출 후보</div>
              <div className="mt-1 font-mono text-xl font-bold text-zinc-100">
                {resolvedCandidates.length}건
              </div>
            </div>
            <div className="rounded border border-emerald-900/60 bg-emerald-950/20 p-3">
              <div className="text-[11px] text-emerald-300">원문 검증 (VERIFIED)</div>
              <div className="mt-1 font-mono text-xl font-bold text-emerald-400">
                {
                  resolvedCandidates.filter(
                    (c) => c.verification.status === 'VERIFIED'
                  ).length
                }
                건
              </div>
            </div>
            <div className="rounded border border-amber-900/60 bg-amber-950/20 p-3">
              <div className="text-[11px] text-amber-300">
                복수 위치 (AMBIGUOUS)
              </div>
              <div className="mt-1 font-mono text-xl font-bold text-amber-400">
                {
                  resolvedCandidates.filter(
                    (c) =>
                      c.verification.status === 'AMBIGUOUS_MULTIPLE_MATCHES'
                  ).length
                }
                건
              </div>
            </div>
            <div className="rounded border border-rose-900/60 bg-rose-950/20 p-3">
              <div className="text-[11px] text-rose-300">
                미검증 차단 (UNVERIFIED)
              </div>
              <div className="mt-1 font-mono text-xl font-bold text-rose-400">
                {
                  resolvedCandidates.filter(
                    (c) => c.verification.status === 'UNVERIFIED_EXCERPT'
                  ).length
                }
                건
              </div>
            </div>
            <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
              <div className="text-[11px] text-zinc-400">기존 중복 제외</div>
              <div className="mt-1 font-mono text-xl font-bold text-zinc-300">
                {
                  resolvedCandidates.filter((c) => c.duplicateStatus !== 'NONE')
                    .length
                }
                건
              </div>
            </div>
            <div className="rounded border border-indigo-500/40 bg-indigo-950/30 p-3">
              <div className="text-[11px] text-indigo-300">저장 선택됨</div>
              <div className="mt-1 font-mono text-xl font-bold text-indigo-300">
                {selectedCandidatesList.length} / {savableCandidates.length}건
              </div>
            </div>
          </div>

          {/* AI Analysis Summary & Audit Metadata */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2.5 text-xs">
              <div className="flex items-center gap-2 font-semibold text-zinc-200">
                <Cpu className="h-4 w-4 text-indigo-400" />
                <span>AI 회차 분석 요약</span>
              </div>
              <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-zinc-400">
                <span>Run ID: {extractionResult.analysisRunId}</span>
                <span>Model: {extractionResult.audit.modelId}</span>
                <span>지연시간: {extractionResult.audit.latencyMs}ms</span>
                {extractionResult.audit.tokenUsage && (
                  <span>
                    토큰: {extractionResult.audit.tokenUsage.totalTokenCount.toLocaleString()}
                  </span>
                )}
              </div>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-zinc-300">
              {extractionResult.analysisSummary ||
                '이번 회차 리비전에 대한 구조화 분석이 완료되었습니다.'}
            </p>
          </div>

          {/* Main 2-Column Workspace: Left Candidate List, Right Excerpt Viewer + Selection Action */}
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
            {/* Left Column: Filters & Candidate Cards */}
            <div className="space-y-4 xl:col-span-7">
              {/* Filter & Bulk Selection Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Filter className="mr-1 h-3.5 w-3.5 text-zinc-400" />
                  {(
                    [
                      ['ALL', '전체 유형'],
                      ['RELATIONSHIP', '인물 관계'],
                      ['TIMELINE_EVENT', '연표 사건'],
                      ['FORESHADOWING', '복선 단서'],
                    ] as const
                  ).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setTypeFilter(val)}
                      className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                        typeFilter === val
                          ? 'bg-indigo-600 text-white'
                          : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={statusFilter}
                    onChange={(e) =>
                      setStatusFilter(e.target.value as typeof statusFilter)
                    }
                    className="rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-xs text-zinc-200"
                  >
                    <option value="ALL">모든 검증 상태</option>
                    <option value="VERIFIED">VERIFIED (원문 검증 완료)</option>
                    <option value="AMBIGUOUS_MULTIPLE_MATCHES">
                      AMBIGUOUS (복수 위치 선택 필요)
                    </option>
                    <option value="UNVERIFIED_EXCERPT">
                      UNVERIFIED (원문 불일치 차단)
                    </option>
                  </select>

                  <button
                    type="button"
                    onClick={handleSelectAllSavable}
                    disabled={savableCandidates.length === 0}
                    className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
                  >
                    검증 후보 전체 선택 ({savableCandidates.length})
                  </button>
                  <button
                    type="button"
                    onClick={handleClearSelection}
                    disabled={selectedCandidateIds.length === 0}
                    className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
                  >
                    선택 해제
                  </button>
                </div>
              </div>

              {/* Candidate Cards */}
              {filteredCandidates.length === 0 ? (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-8 text-center text-xs text-zinc-400">
                  조건에 해당하는 추출 후보가 없습니다.
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredCandidates.map((cand) => {
                    const isSelected = selectedCandidateIds.includes(
                      cand.candidateId
                    );
                    const isActiveInViewer =
                      activeCandidateForViewer?.candidateId === cand.candidateId;
                    const isVerified = cand.verification.status === 'VERIFIED';
                    const isAmbiguous =
                      cand.verification.status === 'AMBIGUOUS_MULTIPLE_MATCHES';

                    return (
                      <div
                        key={cand.candidateId}
                        data-testid={`extraction-candidate-card-${cand.candidateId}`}
                        onClick={() =>
                          setActiveCandidateForViewerId(cand.candidateId)
                        }
                        className={`cursor-pointer rounded-lg border p-4 transition ${
                          isActiveInViewer
                            ? 'border-indigo-500/70 bg-zinc-900/90 ring-1 ring-indigo-500/30'
                            : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                        }`}
                      >
                        {/* Card Top Row */}
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-2.5">
                            <button
                              type="button"
                              data-testid={`candidate-checkbox-${cand.candidateId}`}
                              disabled={!cand.canSaveAsProposal}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (cand.canSaveAsProposal) {
                                  handleToggleCandidateSelection(cand.candidateId);
                                }
                              }}
                              className="mt-0.5 text-zinc-300 disabled:cursor-not-allowed disabled:opacity-30"
                              title={
                                cand.canSaveAsProposal
                                  ? 'ChangeProposal 저장 대상 선택'
                                  : cand.cannotSaveReason || '저장 불가'
                              }
                            >
                              {isSelected ? (
                                <CheckSquare className="h-4 w-4 text-indigo-400" />
                              ) : (
                                <Square className="h-4 w-4 text-zinc-500" />
                              )}
                            </button>

                            <div>
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span
                                  className={`rounded px-2 py-0.5 text-[11px] font-semibold ${
                                    cand.targetEntityType === 'RELATIONSHIP'
                                      ? 'bg-pink-950/70 text-pink-300 border border-pink-700/40'
                                      : cand.targetEntityType === 'TIMELINE_EVENT'
                                      ? 'bg-sky-950/70 text-sky-300 border border-sky-700/40'
                                      : 'bg-purple-950/70 text-purple-300 border border-purple-700/40'
                                  }`}
                                >
                                  {CANDIDATE_TYPE_LABELS[cand.targetEntityType]}
                                </span>

                                <span
                                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                                    cand.proposedAction === 'CREATE'
                                      ? 'bg-emerald-950/70 text-emerald-300 border border-emerald-700/40'
                                      : 'bg-amber-950/70 text-amber-300 border border-amber-700/40'
                                  }`}
                                >
                                  {cand.proposedAction}
                                </span>

                                <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                                  신뢰도 {Math.round(cand.confidence * 100)}%
                                </span>

                                <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] text-zinc-400">
                                  {TEMPORAL_CONTEXT_LABELS[cand.temporalContextType] ||
                                    cand.temporalContextType}
                                </span>

                                {cand.dialogueClaimOnly && (
                                  <span className="rounded border border-amber-500/40 bg-amber-950/60 px-1.5 py-0.5 text-[10px] text-amber-300">
                                    대사 단독 근거
                                  </span>
                                )}
                              </div>

                              <h4 className="mt-1.5 text-sm font-bold text-zinc-100">
                                {cand.title}
                              </h4>
                            </div>
                          </div>

                          {/* Verification Status Badge */}
                          <div className="shrink-0 text-right">
                            <span
                              className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono text-[11px] font-medium ${
                                isVerified
                                  ? 'border-emerald-500/40 bg-emerald-950/60 text-emerald-300'
                                  : isAmbiguous
                                  ? 'border-amber-500/40 bg-amber-950/60 text-amber-300'
                                  : 'border-rose-500/40 bg-rose-950/60 text-rose-300'
                              }`}
                            >
                              {isVerified ? (
                                <ShieldCheck className="h-3 w-3" />
                              ) : (
                                <ShieldAlert className="h-3 w-3" />
                              )}
                              {cand.verification.status}
                            </span>

                            {cand.verification.verifiedSpan && (
                              <div className="mt-1 font-mono text-[10px] text-zinc-400">
                                [{cand.verification.verifiedSpan.startOffset},{' '}
                                {cand.verification.verifiedSpan.endOffset})
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Rationale & Before/After Summary */}
                        <p className="mt-2.5 text-xs leading-relaxed text-zinc-300">
                          {cand.rationale}
                        </p>

                        <div className="mt-2.5 grid grid-cols-1 gap-2 rounded border border-zinc-800/90 bg-zinc-950/60 p-2.5 text-xs sm:grid-cols-2">
                          <div>
                            <span className="text-[10px] font-semibold text-zinc-500">
                              변경 전 (Before)
                            </span>
                            <p className="mt-0.5 text-zinc-400">
                              {cand.beforeSummary || '기존 설정 없음'}
                            </p>
                          </div>
                          <div>
                            <span className="text-[10px] font-semibold text-indigo-400">
                              제안 내용 (After — PROPOSED)
                            </span>
                            <p className="mt-0.5 text-zinc-200">
                              {cand.afterSummary}
                            </p>
                          </div>
                        </div>

                        {/* Entity Specific Payload Summary */}
                        {cand.payloadEnvelope?.relationshipDraft && (
                          <div className="mt-2 flex flex-wrap items-center gap-2 rounded bg-zinc-950/80 px-3 py-1.5 text-xs text-zinc-300">
                            <Users className="h-3.5 w-3.5 text-pink-400" />
                            <span className="font-semibold">
                              {cand.payloadEnvelope.relationshipDraft.sourceCharacterName}
                            </span>
                            <span className="text-zinc-500">→</span>
                            <span className="font-semibold">
                              {cand.payloadEnvelope.relationshipDraft.targetCharacterName}
                            </span>
                            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px]">
                              {cand.payloadEnvelope.relationshipDraft.relationType}
                            </span>
                            <span className="font-mono text-[11px] text-indigo-300">
                              우호도: {cand.payloadEnvelope.relationshipDraft.affinityScore}
                            </span>
                          </div>
                        )}

                        {cand.payloadEnvelope?.timelineEventDraft && (
                          <div className="mt-2 flex flex-wrap items-center gap-3 rounded bg-zinc-950/80 px-3 py-1.5 text-xs text-zinc-300">
                            <Clock className="h-3.5 w-3.5 text-sky-400" />
                            <span>
                              작중 시점:{' '}
                              <strong>
                                {cand.payloadEnvelope.timelineEventDraft.inUniverseDate ||
                                  '미상'}
                              </strong>
                            </span>
                            <span className="font-mono text-[11px] text-sky-300">
                              순서 #{cand.payloadEnvelope.timelineEventDraft.chronologicalOrder}
                            </span>
                            {cand.payloadEnvelope.timelineEventDraft.involvedCharacterNames
                              .length > 0 && (
                              <span>
                                관련 인물:{' '}
                                {cand.payloadEnvelope.timelineEventDraft.involvedCharacterNames.join(
                                  ', '
                                )}
                              </span>
                            )}
                          </div>
                        )}

                        {cand.payloadEnvelope?.foreshadowingDraft && (
                          <div className="mt-2 flex flex-wrap items-center gap-3 rounded bg-zinc-950/80 px-3 py-1.5 text-xs text-zinc-300">
                            <GitBranch className="h-3.5 w-3.5 text-purple-400" />
                            <span className="font-mono text-[11px] text-purple-300">
                              단계: {cand.payloadEnvelope.foreshadowingDraft.cluePhase}
                            </span>
                            {cand.payloadEnvelope.foreshadowingDraft.payoffNote && (
                              <span className="text-zinc-400">
                                회수 메모: {cand.payloadEnvelope.foreshadowingDraft.payoffNote}
                              </span>
                            )}
                          </div>
                        )}

                        {/* Excerpt Box */}
                        <div className="mt-2.5 rounded border border-zinc-800 bg-zinc-950 px-3 py-2 font-serif text-xs text-zinc-300">
                          <span className="mr-1.5 font-sans text-[10px] font-semibold uppercase text-zinc-500">
                            원문 발췌:
                          </span>
                          “{cand.excerpt}”
                        </div>

                        {/* Multi-Match Span Disambiguation Selector */}
                        {cand.verification.candidateSpans.length > 1 && (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            className="mt-3 rounded border border-amber-500/40 bg-amber-950/20 p-3 text-xs"
                          >
                            <div className="flex items-center gap-1.5 font-semibold text-amber-300">
                              <HelpCircle className="h-3.5 w-3.5" />
                              <span>
                                원고 내 동일 발췌문이{' '}
                                {cand.verification.candidateSpans.length}회 등장합니다. 정확한 원문 위치를 선택하세요:
                              </span>
                            </div>
                            <div className="mt-2 space-y-1.5">
                              {cand.verification.candidateSpans.map((span, sIdx) => {
                                const isChosen =
                                  cand.verification.verifiedSpan?.startOffset ===
                                    span.startOffset &&
                                  cand.verification.verifiedSpan?.endOffset ===
                                    span.endOffset;
                                const previewBefore = activeRevision
                                  ? activeRevision.content.slice(
                                      Math.max(0, span.startOffset - 35),
                                      span.startOffset
                                    )
                                  : '';
                                const previewAfter = activeRevision
                                  ? activeRevision.content.slice(
                                      span.endOffset,
                                      Math.min(
                                        activeRevision.content.length,
                                        span.endOffset + 35
                                      )
                                    )
                                  : '';

                                return (
                                  <button
                                    key={`${span.startOffset}:${span.endOffset}`}
                                    type="button"
                                    data-testid={`disambiguate-span-${cand.candidateId}-${sIdx}`}
                                    onClick={() =>
                                      handleSelectAmbiguousSpan(
                                        cand.candidateId,
                                        span.startOffset,
                                        span.endOffset
                                      )
                                    }
                                    className={`flex w-full items-center justify-between gap-2 rounded border px-2.5 py-1.5 text-left text-[11px] transition ${
                                      isChosen
                                        ? 'border-emerald-500/60 bg-emerald-950/50 text-emerald-200'
                                        : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-amber-400/50'
                                    }`}
                                  >
                                    <span className="truncate font-serif">
                                      …{previewBefore}
                                      <strong className="text-amber-300">
                                        [{span.matchedText}]
                                      </strong>
                                      {previewAfter}…
                                    </span>
                                    <span className="shrink-0 font-mono text-[10px]">
                                      [{span.startOffset}, {span.endOffset}){' '}
                                      {isChosen ? '✓ 선택됨' : '선택'}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Canon Conflicts & Uncertainty Flags */}
                        {(cand.canonConflicts.length > 0 ||
                          cand.uncertaintyFlags.length > 0) && (
                          <div className="mt-2.5 space-y-1.5">
                            {cand.canonConflicts.map((conf, cIdx) => (
                              <div
                                key={cIdx}
                                className="flex items-center gap-1.5 rounded border border-amber-500/40 bg-amber-950/40 px-2.5 py-1 text-[11px] text-amber-200"
                              >
                                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                                <span>
                                  <strong>[{conf.conflictType}]</strong> {conf.message}
                                </span>
                              </div>
                            ))}

                            {cand.uncertaintyFlags.length > 0 && (
                              <div className="flex flex-wrap gap-1.5">
                                {cand.uncertaintyFlags.map((flag) => (
                                  <span
                                    key={flag}
                                    className="rounded border border-zinc-700 bg-zinc-800/80 px-2 py-0.5 text-[10px] text-zinc-300"
                                  >
                                    ⚠ {UNCERTAINTY_FLAG_LABELS[flag] || flag}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Cannot Save / Duplicate Reason */}
                        {!cand.canSaveAsProposal && cand.cannotSaveReason && (
                          <div className="mt-2.5 flex items-center gap-1.5 rounded border border-rose-500/30 bg-rose-950/30 px-2.5 py-1.5 text-[11px] text-rose-300">
                            <Lock className="h-3.5 w-3.5 shrink-0" />
                            <span>저장 차단 사유: {cand.cannotSaveReason}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Right Column: Manuscript UTF-16 Highlight Viewer & Save Action Box */}
            <div className="space-y-4 xl:col-span-5">
              {/* Manuscript Excerpt Context Viewer */}
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/70">
                <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200">
                    <BookOpen className="h-4 w-4 text-indigo-400" />
                    <span>원고 근거 위치 검증 뷰어 (Revision.content)</span>
                  </div>
                  {activeCandidateForViewer && (
                    <span className="font-mono text-[11px] text-zinc-400">
                      {activeCandidateForViewer.candidateId}
                    </span>
                  )}
                </div>
                {renderManuscriptExcerptContext()}
              </div>

              {/* Save Selected Proposals Action Box */}
              <div className="rounded-lg border border-indigo-500/40 bg-zinc-900/80 p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-zinc-100">
                    선택 후보 ChangeProposal 저장 (PROPOSED)
                  </h3>
                  <span className="rounded bg-indigo-950 px-2 py-0.5 font-mono text-xs font-semibold text-indigo-300">
                    선택됨: {selectedCandidatesList.length}건
                  </span>
                </div>

                <p className="mt-1.5 text-xs text-zinc-400">
                  선택된 후보만 <code className="text-amber-300">canonStatus: 'PROPOSED'</code>로 저장됩니다. 어떠한 경우에도 작가의 별도 승인 없이 CANON으로 자동 반영되지 않으며, 저장 시 Gemini API를 재호출하지 않습니다.
                </p>

                {selectedCandidatesList.length > 0 && (
                  <div className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded border border-zinc-800 bg-zinc-950 p-2 text-xs">
                    {selectedCandidatesList.map((c) => (
                      <div
                        key={c.candidateId}
                        className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-zinc-900"
                      >
                        <span className="truncate text-zinc-200">
                          [{CANDIDATE_TYPE_LABELS[c.targetEntityType]}] {c.title}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-emerald-400">
                          [{c.verification.verifiedSpan?.startOffset},{' '}
                          {c.verification.verifiedSpan?.endOffset})
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="mt-4">
                  <button
                    type="button"
                    data-testid="open-save-proposals-confirm-btn"
                    disabled={
                      selectedCandidatesList.length === 0 ||
                      uiState === 'SAVING_PROPOSALS' ||
                      uiState === 'ANALYZING'
                    }
                    onClick={() => setIsConfirmModalOpen(true)}
                    className="flex w-full items-center justify-center gap-2 rounded bg-emerald-600 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
                  >
                    {uiState === 'SAVING_PROPOSALS' ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        선택 제안서 원자적 저장 중...
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="h-4 w-4" />
                        선택한 {selectedCandidatesList.length}개 후보를 제안서(PROPOSED)로 저장 검토
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Pre-Save Confirmation Summary Panel */}
              {isConfirmModalOpen && selectedCandidatesList.length > 0 && (
                <div
                  data-testid="save-proposals-confirm-modal"
                  className="rounded-lg border border-amber-500/60 bg-zinc-950 p-4 shadow-xl"
                >
                  <div className="flex items-center gap-2 text-sm font-bold text-amber-300">
                    <Info className="h-4 w-4" />
                    <span>제안서(ChangeProposal) 저장 최종 확인</span>
                  </div>
                  <p className="mt-1.5 text-xs text-zinc-300">
                    총 <strong>{selectedCandidatesList.length}건</strong>의 검증된 후보를{' '}
                    <strong>검토 대기(PROPOSED)</strong> 상태로 저장하시겠습니까?
                  </p>
                  <ul className="mt-2.5 space-y-1 text-xs text-zinc-400">
                    <li>
                      • 대상 리비전: <code className="text-zinc-200">{activeRevision?.id}</code>
                    </li>
                    <li>
                      • 실행 모드:{' '}
                      <code className="text-zinc-200">
                        {extractionResult.executionMode}
                      </code>
                    </li>
                    <li>
                      • 중복 방지: 결정적 ID(SHA/Fingerprint) 기반 원자적 트랜잭션 검사
                    </li>
                  </ul>
                  <div className="mt-4 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setIsConfirmModalOpen(false)}
                      className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
                    >
                      취소
                    </button>
                    <button
                      type="button"
                      data-testid="confirm-save-proposals-submit-btn"
                      onClick={handleConfirmSaveProposals}
                      className="rounded bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
                    >
                      확정 저장 실행 ({selectedCandidatesList.length}건)
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Existing ChangeProposals Queue for Current Episode */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-indigo-400" />
            <h3 className="text-sm font-bold text-zinc-200">
              현재 회차 저장된 ChangeProposal 목록 ({episodeProposals.length}건)
            </h3>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              data-testid="open-proposal-review-workspace-btn"
              onClick={() =>
                onOpenProposalReview
                  ? onOpenProposalReview()
                  : onNavigateTab('proposal_review')
              }
              className="rounded border border-indigo-500/50 bg-indigo-600/20 px-3 py-1 font-semibold text-indigo-200 hover:bg-indigo-600/30 cursor-pointer"
            >
              AI 제안 검토 · CANON 승인 워크스페이스 열기 →
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('relationships')}
              className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-zinc-300 hover:bg-zinc-700 cursor-pointer"
            >
              인물 관계도 화면으로 이동 →
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('timeline')}
              className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-zinc-300 hover:bg-zinc-700 cursor-pointer"
            >
              사건 연표 화면으로 이동 →
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('foreshadowing')}
              className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-zinc-300 hover:bg-zinc-700 cursor-pointer"
            >
              복선 관리 화면으로 이동 →
            </button>
          </div>
        </div>

        {episodeProposals.length === 0 ? (
          <p className="mt-3 text-xs text-zinc-500">
            이 회차에서 생성된 ChangeProposal이 아직 없습니다. 위에서 AI 설정 후보 분석을 실행한 뒤 원하는 후보를 선택하여 저장해 보세요.
          </p>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-2.5 md:grid-cols-2 lg:grid-cols-3">
            {episodeProposals.map((prop) => (
              <div
                key={prop.id}
                className="rounded border border-zinc-800 bg-zinc-950/70 p-3 text-xs flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] text-zinc-400">
                      {prop.targetEntityType} · {prop.proposedAction}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                        prop.canonStatus === 'PROPOSED'
                          ? 'bg-amber-950/80 text-amber-300'
                          : prop.canonStatus === 'CANON'
                          ? 'bg-emerald-950/80 text-emerald-300'
                          : 'bg-rose-950/80 text-rose-300'
                      }`}
                    >
                      {prop.canonStatus}
                    </span>
                  </div>
                  <div className="mt-1 font-semibold text-zinc-200">{prop.title}</div>
                  <p className="mt-1 line-clamp-2 text-[11px] text-zinc-400">
                    {prop.afterSummary}
                  </p>
                </div>
                <div className="mt-3 pt-2 border-t border-zinc-800/80 flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] text-zinc-500 truncate">
                    ID: {prop.id.slice(0, 14)}…
                  </span>
                  <button
                    type="button"
                    data-testid={`review-proposal-btn-${prop.id}`}
                    onClick={() =>
                      onOpenProposalReview
                        ? onOpenProposalReview(prop.id)
                        : onNavigateTab('proposal_review')
                    }
                    className="shrink-0 rounded bg-indigo-600/25 border border-indigo-500/40 px-2.5 py-1 text-[11px] font-semibold text-indigo-200 hover:bg-indigo-600/40 cursor-pointer"
                  >
                    {prop.canonStatus === 'PROPOSED'
                      ? '전후 비교 및 승인 검토 →'
                      : '검토 상세 보기 →'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
