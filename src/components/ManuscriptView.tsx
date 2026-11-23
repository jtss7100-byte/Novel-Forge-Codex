import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Clock,
  FilePlus,
  Globe,
  History,
  RotateCcw,
  Save,
  ShieldAlert,
  Sparkles,
  Trash2,
  Type,
  Users,
} from 'lucide-react';
import type {
  ChangeProposal,
  Character,
  EmergencyDraftBackup,
  Episode,
  EpisodeStatus,
  Project,
  PromptProfile,
  Revision,
  SaveState,
  WorldbuildingItem,
  WritingPlan,
} from '../types/novel';
import {
  calculateCharCounts,
  computeRevisionDiffSummary,
  validateEpisodeInput,
} from '../utils/novelLogic';
import {
  clearEmergencyDraft,
  getEmergencyDraft,
  saveEmergencyDraft,
} from '../services/novelRepository';
import type { EpisodeRevisionCommitResult } from '../services/novelRepository';
import { computeManuscriptContentHash } from '../utils/manuscriptIntegrity';
import { ConfirmModal } from './ConfirmModal';
import { AiWritingPanel } from './AiWritingPanel';
import type { VoiceRewriteSelection } from './CharacterVoicePanel';

interface ManuscriptViewProps {
  voiceRewriteSelection?: VoiceRewriteSelection | null;
  projectId: string;
  project: Project;
  episodes: Episode[];
  characters: Character[];
  worldbuilding: WorldbuildingItem[];
  revisions: Revision[];
  promptProfiles: PromptProfile[];
  writingPlans: WritingPlan[];
  changeProposals: ChangeProposal[];
  selectedEpisodeId: string | null;
  saveState: SaveState;
  lastSavedAt: string | null;
  onSelectEpisode: (episodeId: string) => void;
  onCreateEpisode: (input: {
    episodeNumber: number;
    title: string;
    status: EpisodeStatus;
  }) => Promise<Episode>;
  onSaveEpisode: (
    updated: Episode,
    options?: {
      createRevision?: boolean;
      revisionLabel?: string;
      createBackupRevisionFirst?: boolean;
      backupRevisionLabel?: string;
      expectedRevisionId?: string;
      expectedContentHash?: string;
    }
  ) => Promise<EpisodeRevisionCommitResult | void>;
  onDeleteEpisode: (episodeId: string) => Promise<void>;
  onDeleteRevision: (revisionId: string) => Promise<void>;
  onSaveWritingPlan: (plan: WritingPlan) => Promise<void>;
  onSaveChangeProposals: (
    proposals: ChangeProposal[],
    options?: import('../types/novel').PersistChangeProposalsOptions
  ) => Promise<import('../types/novel').PersistChangeProposalsResult | void>;
  onUpdateChangeProposalStatus: (
    proposal: ChangeProposal,
    nextStatus: 'CANON' | 'REJECTED'
  ) => Promise<void>;
  onUpdatePromptProfile?: (
    profile: PromptProfile,
    options?: {
      expectedVersionId?: string;
      expectedVersionNumber?: number;
    }
  ) => Promise<import('../types/novel').PromptProfileCasResult | void>;
  onOpenPromptManager: () => void;
  onOpenProposalReview?: (proposalId?: string) => void;
  getIdToken: () => Promise<string | null>;
  onSaveStateChange: (state: SaveState, errorMsg?: string) => void;
}

export const ManuscriptView: React.FC<ManuscriptViewProps> = ({
  voiceRewriteSelection,
  projectId,
  project,
  episodes,
  characters,
  worldbuilding,
  revisions,
  promptProfiles,
  writingPlans,
  changeProposals,
  selectedEpisodeId,
  saveState,
  lastSavedAt,
  onSelectEpisode,
  onCreateEpisode,
  onSaveEpisode,
  onDeleteEpisode,
  onDeleteRevision,
  onSaveWritingPlan,
  onSaveChangeProposals,
  onUpdateChangeProposalStatus,
  onUpdatePromptProfile,
  onOpenPromptManager,
  onOpenProposalReview,
  getIdToken,
  onSaveStateChange,
}) => {
  const [statusFilter, setStatusFilter] = useState<'all' | EpisodeStatus>('all');
  const [useSerifFont, setUseSerifFont] = useState<boolean>(true);
  const [showAiStudio, setShowAiStudio] = useState<boolean>(true);
  const [sidePanelTab, setSidePanelTab] = useState<'lore' | 'revisions'>('revisions');

  const activeEpisode = useMemo(() => {
    if (!episodes.length) return null;
    if (selectedEpisodeId) {
      const found = episodes.find((ep) => ep.id === selectedEpisodeId);
      if (found) return found;
    }
    return episodes[0];
  }, [episodes, selectedEpisodeId]);

  // Local editor state synchronized with activeEpisode
  const [episodeNumber, setEpisodeNumber] = useState<number>(1);
  const [title, setTitle] = useState<string>('');
  const [content, setContent] = useState<string>('');
  const [synopsis, setSynopsis] = useState<string>('');
  const [authorNote, setAuthorNote] = useState<string>('');
  const [status, setStatus] = useState<EpisodeStatus>('draft');
  const [linkedCharacterIds, setLinkedCharacterIds] = useState<string[]>([]);
  const [linkedWorldbuildingIds, setLinkedWorldbuildingIds] = useState<string[]>([]);

  const [emergencyBackup, setEmergencyBackup] = useState<EmergencyDraftBackup | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [revisionLabelInput, setRevisionLabelInput] = useState<string>('');
  const [isCreatingEpisode, setIsCreatingEpisode] = useState<boolean>(false);
  const [deleteTargetEpisode, setDeleteTargetEpisode] = useState<Episode | null>(null);
  const [restoreTargetRevision, setRestoreTargetRevision] = useState<Revision | null>(null);
  const [editorSelection, setEditorSelection] = useState<{
    startOffset: number;
    endOffset: number;
    excerpt: string;
  } | null>(null);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeEpisodeIdRef = useRef<string | null>(null);
  const expectedRevisionIdRef = useRef<string>('');
  const expectedContentHashRef = useRef<string>('');
  const manuscriptTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const captureTextareaSelection = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (end > start && start >= 0 && end <= el.value.length) {
      setEditorSelection({
        startOffset: start,
        endOffset: end,
        excerpt: el.value.slice(start, end),
      });
    } else {
      setEditorSelection(null);
    }
  };

  // Sync editor fields when switching active episode
  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    if (!activeEpisode) {
      activeEpisodeIdRef.current = null;
      expectedRevisionIdRef.current = '';
      expectedContentHashRef.current = '';
      setEditorSelection(null);
      return;
    }

    if (activeEpisodeIdRef.current !== activeEpisode.id) {
      activeEpisodeIdRef.current = activeEpisode.id;
      expectedRevisionIdRef.current = activeEpisode.latestRevisionId || '';
      expectedContentHashRef.current =
        activeEpisode.contentHash || computeManuscriptContentHash(activeEpisode.content);
      setEpisodeNumber(activeEpisode.episodeNumber);
      setTitle(activeEpisode.title);
      setContent(activeEpisode.content);
      setSynopsis(activeEpisode.synopsis);
      setAuthorNote(activeEpisode.authorNote);
      setStatus(activeEpisode.status);
      setLinkedCharacterIds(activeEpisode.linkedCharacterIds);
      setLinkedWorldbuildingIds(activeEpisode.linkedWorldbuildingIds);
      setValidationError(null);
      setEditorSelection(null);

      // Check if an unsaved emergency draft exists for this episode
      const existingEmergency = getEmergencyDraft(projectId, activeEpisode.id);
      if (
        existingEmergency &&
        (existingEmergency.content !== activeEpisode.content ||
          existingEmergency.title !== activeEpisode.title)
      ) {
        setEmergencyBackup(existingEmergency);
      } else {
        setEmergencyBackup(null);
      }
    }
  }, [activeEpisode, projectId]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const charMetrics = useMemo(() => calculateCharCounts(content), [content]);

  const filteredEpisodes = useMemo(() => {
    if (statusFilter === 'all') return episodes;
    return episodes.filter((ep) => ep.status === statusFilter);
  }, [episodes, statusFilter]);

  const episodeRevisions = useMemo(() => {
    if (!activeEpisode) return [];
    return revisions.filter((rev) => rev.episodeId === activeEpisode.id);
  }, [revisions, activeEpisode]);

  const buildUpdatedEpisode = (overrides?: Partial<Episode>): Episode | null => {
    if (!activeEpisode) return null;
    const nextContent = overrides?.content ?? content;
    const metrics = calculateCharCounts(nextContent);
    return {
      ...activeEpisode,
      episodeNumber: overrides?.episodeNumber ?? episodeNumber,
      title: (overrides?.title ?? title).trim() || '제목 없는 회차',
      content: nextContent,
      synopsis: overrides?.synopsis ?? synopsis,
      authorNote: overrides?.authorNote ?? authorNote,
      charCountWithSpaces: metrics.withSpaces,
      charCountWithoutSpaces: metrics.withoutSpaces,
      status: overrides?.status ?? status,
      linkedCharacterIds: overrides?.linkedCharacterIds ?? linkedCharacterIds,
      linkedWorldbuildingIds: overrides?.linkedWorldbuildingIds ?? linkedWorldbuildingIds,
      updatedAt: new Date().toISOString(),
    };
  };

  const triggerDebouncedAutoSave = (draftOverrides?: Partial<Episode>) => {
    if (!activeEpisode) return;
    const candidate = buildUpdatedEpisode(draftOverrides);
    if (!candidate) return;

    // 1. Always write immediately to local crash/error recovery buffer
    saveEmergencyDraft({
      projectId,
      episodeId: candidate.id,
      title: candidate.title,
      content: candidate.content,
      synopsis: candidate.synopsis,
      authorNote: candidate.authorNote,
      status: candidate.status,
      savedAt: new Date().toISOString(),
      reason: 'typing_buffer',
    });

    const check = validateEpisodeInput(candidate);
    if (!check.valid) {
      setValidationError(check.error || '입력값 검증 오류');
      onSaveStateChange('error', check.error);
      return;
    }
    setValidationError(null);
    onSaveStateChange('saving');

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    const syncCasRefsFromCommit = (
      commitResult: EpisodeRevisionCommitResult | void,
      fallbackContent: string
    ) => {
      if (commitResult?.episode) {
        expectedRevisionIdRef.current = commitResult.episode.latestRevisionId || '';
        expectedContentHashRef.current =
          commitResult.episode.contentHash ||
          computeManuscriptContentHash(commitResult.episode.content);
      } else {
        expectedContentHashRef.current = computeManuscriptContentHash(fallbackContent);
      }
    };

    debounceTimerRef.current = setTimeout(async () => {
      try {
        const res = await onSaveEpisode(candidate, {
          createRevision: false,
          expectedRevisionId: expectedRevisionIdRef.current,
          expectedContentHash: expectedContentHashRef.current,
        });
        syncCasRefsFromCommit(res, candidate.content);
        clearEmergencyDraft(projectId, candidate.id);
        setEmergencyBackup(null);
        onSaveStateChange('saved');
      } catch (err) {
        const msg = err instanceof Error ? err.message : '자동 저장 중 오류 발생';
        saveEmergencyDraft({
          projectId,
          episodeId: candidate.id,
          title: candidate.title,
          content: candidate.content,
          synopsis: candidate.synopsis,
          authorNote: candidate.authorNote,
          status: candidate.status,
          savedAt: new Date().toISOString(),
          reason: 'save_error',
          errorMessage: msg,
        });
        setEmergencyBackup(getEmergencyDraft(projectId, candidate.id));
        onSaveStateChange('error', msg);
      }
    }, 1000);
  };

  const handleManualSave = async (createSnapshot = true) => {
    if (!activeEpisode) return;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    const candidate = buildUpdatedEpisode();
    if (!candidate) return;

    const check = validateEpisodeInput(candidate);
    if (!check.valid) {
      setValidationError(check.error || '입력값을 확인해 주세요.');
      onSaveStateChange('error', check.error);
      return;
    }

    setValidationError(null);
    onSaveStateChange('saving');

    try {
      const label =
        revisionLabelInput.trim() ||
        `${candidate.status === 'confirmed' ? '확정' : '수동'} 저장 (${
          candidate.charCountWithSpaces
        }자)`;
      const res = await onSaveEpisode(candidate, {
        createRevision: createSnapshot,
        revisionLabel: label,
        expectedRevisionId: expectedRevisionIdRef.current,
        expectedContentHash: expectedContentHashRef.current,
      });
      if (res?.episode) {
        expectedRevisionIdRef.current = res.episode.latestRevisionId || '';
        expectedContentHashRef.current =
          res.episode.contentHash || computeManuscriptContentHash(res.episode.content);
      } else {
        expectedContentHashRef.current = computeManuscriptContentHash(candidate.content);
      }
      setRevisionLabelInput('');
      clearEmergencyDraft(projectId, candidate.id);
      setEmergencyBackup(null);
      onSaveStateChange('saved');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '수동 저장 실패';
      saveEmergencyDraft({
        projectId,
        episodeId: candidate.id,
        title: candidate.title,
        content: candidate.content,
        synopsis: candidate.synopsis,
        authorNote: candidate.authorNote,
        status: candidate.status,
        savedAt: new Date().toISOString(),
        reason: 'save_error',
        errorMessage: msg,
      });
      setEmergencyBackup(getEmergencyDraft(projectId, candidate.id));
      onSaveStateChange('error', msg);
    }
  };

  const handleCreateNewEpisode = async () => {
    setIsCreatingEpisode(true);
    try {
      const nextNum =
        episodes.length > 0
          ? Math.max(...episodes.map((e) => e.episodeNumber)) + 1
          : 1;
      const created = await onCreateEpisode({
        episodeNumber: nextNum,
        title: `제${nextNum}화. 새로운 장의 시작`,
        status: 'draft',
      });
      onSelectEpisode(created.id);
    } finally {
      setIsCreatingEpisode(false);
    }
  };

  const handleRecoverFromEmergency = async () => {
    if (!emergencyBackup || !activeEpisode) return;
    const restored = buildUpdatedEpisode({
      title: emergencyBackup.title,
      content: emergencyBackup.content,
      synopsis: emergencyBackup.synopsis,
      authorNote: emergencyBackup.authorNote,
      status: emergencyBackup.status,
    });
    if (!restored) return;

    onSaveStateChange('saving');
    try {
      const res = await onSaveEpisode(restored, {
        createBackupRevisionFirst: true,
        backupRevisionLabel: `비상 복구 전 안전 백업 (${calculateCharCounts(content).withSpaces.toLocaleString()}자)`,
        createRevision: true,
        revisionLabel: '비상 복구본에서 원고 복원',
        expectedRevisionId: expectedRevisionIdRef.current,
        expectedContentHash: expectedContentHashRef.current,
      });
      if (res?.episode) {
        expectedRevisionIdRef.current = res.episode.latestRevisionId || '';
        expectedContentHashRef.current =
          res.episode.contentHash || computeManuscriptContentHash(res.episode.content);
      } else {
        expectedContentHashRef.current = computeManuscriptContentHash(restored.content);
      }
      setTitle(restored.title);
      setContent(restored.content);
      setSynopsis(restored.synopsis);
      setAuthorNote(restored.authorNote);
      setStatus(restored.status);
      clearEmergencyDraft(projectId, activeEpisode.id);
      setEmergencyBackup(null);
      onSaveStateChange('recovered');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '비상 복구 저장 실패';
      onSaveStateChange('error', msg);
    }
  };

  const handleConfirmRestoreRevision = async () => {
    if (!restoreTargetRevision || !activeEpisode) return;
    const targetRev = restoreTargetRevision;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    const restoredEpisode = buildUpdatedEpisode({
      content: targetRev.content,
    });
    if (!restoredEpisode) return;

    onSaveStateChange('saving');
    try {
      const res = await onSaveEpisode(restoredEpisode, {
        createBackupRevisionFirst: true,
        backupRevisionLabel: `버전 복원 전 자동 백업 (${calculateCharCounts(content).withSpaces.toLocaleString()}자)`,
        createRevision: true,
        revisionLabel: `'${targetRev.label}' 버전으로 복원됨`,
        expectedRevisionId: expectedRevisionIdRef.current,
        expectedContentHash: expectedContentHashRef.current,
      });
      if (res?.episode) {
        expectedRevisionIdRef.current = res.episode.latestRevisionId || '';
        expectedContentHashRef.current =
          res.episode.contentHash || computeManuscriptContentHash(res.episode.content);
      } else {
        expectedContentHashRef.current = computeManuscriptContentHash(restoredEpisode.content);
      }
      setRestoreTargetRevision(null);
      setContent(targetRev.content);
      clearEmergencyDraft(projectId, activeEpisode.id);
      setEmergencyBackup(null);
      onSaveStateChange('recovered');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '리비전 복원 저장 중 오류가 발생해 기존 원고를 유지합니다.';
      onSaveStateChange('error', msg);
    }
  };

  const toggleLinkedCharacter = (charId: string) => {
    const next = linkedCharacterIds.includes(charId)
      ? linkedCharacterIds.filter((id) => id !== charId)
      : [...linkedCharacterIds, charId];
    setLinkedCharacterIds(next);
    triggerDebouncedAutoSave({ linkedCharacterIds: next });
  };

  const toggleLinkedWorldbuilding = (wbId: string) => {
    const next = linkedWorldbuildingIds.includes(wbId)
      ? linkedWorldbuildingIds.filter((id) => id !== wbId)
      : [...linkedWorldbuildingIds, wbId];
    setLinkedWorldbuildingIds(next);
    triggerDebouncedAutoSave({ linkedWorldbuildingIds: next });
  };

  const handleApplyAiManuscriptToEditor = async (
    newContent: string,
    options: {
      createBackupRevisionFirst: boolean;
      revisionLabel: string;
      markConfirmed?: boolean;
      updatedSynopsis?: string;
    }
  ): Promise<EpisodeRevisionCommitResult | void> => {
    if (!activeEpisode) return;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    const nextStatus: EpisodeStatus = options.markConfirmed ? 'confirmed' : status;
    const nextSynopsis = options.updatedSynopsis ?? synopsis;

    const updatedCandidate = buildUpdatedEpisode({
      content: newContent,
      status: nextStatus,
      synopsis: nextSynopsis,
    });
    if (!updatedCandidate) return;

    onSaveStateChange('saving');

    try {
      const res = await onSaveEpisode(updatedCandidate, {
        createBackupRevisionFirst:
          options.createBackupRevisionFirst &&
          content.trim().length > 0 &&
          content !== newContent,
        backupRevisionLabel: `AI 원고 반영 전 안전 백업 (${calculateCharCounts(
          content
        ).withSpaces.toLocaleString()}자)`,
        createRevision: true,
        revisionLabel: options.revisionLabel,
        expectedRevisionId: expectedRevisionIdRef.current,
        expectedContentHash: expectedContentHashRef.current,
      });

      // Strictly mutate editor UI state ONLY after atomic persistence succeeds
      if (res?.episode) {
        expectedRevisionIdRef.current = res.episode.latestRevisionId || '';
        expectedContentHashRef.current =
          res.episode.contentHash || computeManuscriptContentHash(res.episode.content);
      } else {
        expectedContentHashRef.current = computeManuscriptContentHash(newContent);
      }

      setContent(newContent);
      if (options.markConfirmed) {
        setStatus('confirmed');
      }
      if (options.updatedSynopsis !== undefined) {
        setSynopsis(nextSynopsis);
      }
      setEditorSelection(null);
      clearEmergencyDraft(projectId, updatedCandidate.id);
      setEmergencyBackup(null);
      onSaveStateChange('saved');
      return res;
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'AI 원고 반영 저장 중 오류가 발생하여 기존 원고와 대기 초안을 보존했습니다.';
      saveEmergencyDraft({
        projectId,
        episodeId: activeEpisode.id,
        title,
        content,
        synopsis,
        authorNote,
        status,
        savedAt: new Date().toISOString(),
        reason: 'save_error',
        errorMessage: msg,
      });
      setEmergencyBackup(getEmergencyDraft(projectId, activeEpisode.id));
      onSaveStateChange('error', msg);
      throw err;
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
      {/* Left Column (3 cols): Episode List & Status Filter */}
      <aside className="space-y-4 xl:col-span-3">
        <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">회차 목록</h2>
              <p className="text-xs text-slate-400">총 {episodes.length}화 등록됨</p>
            </div>
            <button
              type="button"
              onClick={handleCreateNewEpisode}
              disabled={isCreatingEpisode}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <FilePlus className="h-3.5 w-3.5" />
              <span>새 회차 추가</span>
            </button>
          </div>

          {/* Interactive Status Filter Tabs */}
          <div className="mt-3 grid grid-cols-4 gap-1 rounded-lg bg-slate-950 p-1">
            {(
              [
                { key: 'all', label: '전체' },
                { key: 'draft', label: '초안' },
                { key: 'review', label: '검토 중' },
                { key: 'confirmed', label: '확정' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setStatusFilter(tab.key)}
                className={`rounded-md py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  statusFilter === tab.key
                    ? 'bg-slate-800 text-amber-400 shadow-xs'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Episode List Items */}
          <div className="mt-3 max-h-[560px] space-y-2 overflow-y-auto pr-1">
            {filteredEpisodes.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500">
                해당 상태의 회차가 없습니다.
              </div>
            ) : (
              filteredEpisodes.map((ep) => {
                const isSelected = activeEpisode?.id === ep.id;
                return (
                  <div
                    key={ep.id}
                    className={`group flex items-start justify-between gap-2 rounded-lg border p-3 transition-colors ${
                      isSelected
                        ? 'border-amber-500/60 bg-slate-800/90'
                        : 'border-slate-800/80 bg-slate-950/60 hover:border-slate-700'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectEpisode(ep.id)}
                      className="flex-1 text-left min-w-0"
                    >
                      <div className="flex items-center gap-1.5 text-xs text-slate-400">
                        <span className="font-mono-tabular font-semibold text-amber-400">
                          제{ep.episodeNumber}화
                        </span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={
                            ep.status === 'confirmed'
                              ? 'text-emerald-400'
                              : ep.status === 'review'
                              ? 'text-amber-300'
                              : 'text-slate-400'
                          }
                        >
                          {ep.status === 'confirmed'
                            ? '확정'
                            : ep.status === 'review'
                            ? '검토 중'
                            : '초안'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono-tabular">
                          {ep.charCountWithSpaces.toLocaleString()}자
                        </span>
                      </div>
                      <div className="mt-1 truncate text-sm font-medium text-slate-100">
                        {ep.title}
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setDeleteTargetEpisode(ep)}
                      aria-label={`${ep.title} 회차 삭제`}
                      className="rounded p-1 text-slate-500 opacity-70 hover:bg-rose-500/15 hover:text-rose-400 group-hover:opacity-100 transition-colors shrink-0"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </aside>

      {/* Center Column (6 cols): Manuscript Editor */}
      <section className="space-y-4 xl:col-span-6">
        {!activeEpisode ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-slate-800 bg-slate-900/70 p-12 text-center">
            <BookOpen className="h-10 w-10 text-amber-400 mb-3" />
            <h2 className="text-lg font-semibold text-slate-100">
              선택된 회차 원고가 없습니다
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              새 회차를 추가하여 장편 판타지 웹소설 집필을 시작하세요.
            </p>
            <button
              type="button"
              onClick={handleCreateNewEpisode}
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400"
            >
              <FilePlus className="h-4 w-4" />
              <span>첫 회차 생성하기</span>
            </button>
          </div>
        ) : (
          <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-5 space-y-5">
            {/* Emergency Recovery Banner (shown when unsaved local draft or save error recovery exists) */}
            {emergencyBackup && (
              <div
                role="alert"
                className="flex flex-col justify-between gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 sm:flex-row sm:items-center"
              >
                <div className="flex items-start gap-3">
                  <ShieldAlert className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
                  <div className="text-xs leading-relaxed text-amber-200">
                    <div className="font-semibold text-amber-300">
                      미저장 원고 복구본이 감지되었습니다 ({emergencyBackup.content.length.toLocaleString()}자)
                    </div>
                    <div>
                      오류 또는 새로고침 직전 로컬 복구 버퍼에 보존된 원고입니다. 복구본을 불러와 안전하게 저장할 수 있습니다.
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={handleRecoverFromEmergency}
                    className="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 whitespace-nowrap"
                  >
                    복구본 불러오기
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      clearEmergencyDraft(projectId, activeEpisode.id);
                      setEmergencyBackup(null);
                    }}
                    className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 whitespace-nowrap"
                  >
                    복구본 폐기
                  </button>
                </div>
              </div>
            )}

            {validationError && (
              <div
                role="alert"
                className="flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-300"
              >
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{validationError}</span>
              </div>
            )}

            {/* Episode Header Controls: Number, Title, Status, Font Toggle */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
              <div className="sm:col-span-2">
                <label
                  htmlFor="episode-number-input"
                  className="block text-xs font-medium text-slate-400 mb-1"
                >
                  회차 번호
                </label>
                <input
                  id="episode-number-input"
                  type="number"
                  min={1}
                  max={10000}
                  value={episodeNumber}
                  onChange={(e) => {
                    const num = Math.max(1, parseInt(e.target.value || '1', 10));
                    setEpisodeNumber(num);
                    triggerDebouncedAutoSave({ episodeNumber: num });
                  }}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono-tabular text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div className="sm:col-span-7">
                <label
                  htmlFor="episode-title-input"
                  className="block text-xs font-medium text-slate-400 mb-1"
                >
                  회차 제목
                </label>
                <input
                  id="episode-title-input"
                  type="text"
                  value={title}
                  maxLength={150}
                  onChange={(e) => {
                    const nextTitle = e.target.value;
                    setTitle(nextTitle);
                    triggerDebouncedAutoSave({ title: nextTitle });
                  }}
                  placeholder="회차 제목을 입력하세요"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm font-medium text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div className="sm:col-span-3">
                <label
                  htmlFor="episode-status-select"
                  className="block text-xs font-medium text-slate-400 mb-1"
                >
                  회차 상태
                </label>
                <select
                  id="episode-status-select"
                  value={status}
                  onChange={(e) => {
                    const nextStatus = e.target.value as EpisodeStatus;
                    setStatus(nextStatus);
                    triggerDebouncedAutoSave({ status: nextStatus });
                  }}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                >
                  <option value="draft">초안</option>
                  <option value="review">검토 중</option>
                  <option value="confirmed">확정 원고</option>
                </select>
              </div>
            </div>

            {/* Editor Toolbar: Character Count Metrics & Save Controls */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-y border-slate-800 py-3">
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <div className="font-mono-tabular font-semibold text-amber-400">
                  공백 포함{' '}
                  <span data-testid="editor-char-with-spaces" className="text-sm text-slate-100">
                    {charMetrics.withSpaces.toLocaleString()}
                  </span>
                  자
                </div>
                <span aria-hidden="true" className="text-slate-600">
                  ·
                </span>
                <div className="font-mono-tabular text-slate-300">
                  공백 제외{' '}
                  <span data-testid="editor-char-without-spaces">
                    {charMetrics.withoutSpaces.toLocaleString()}
                  </span>
                  자
                </div>
                <span aria-hidden="true" className="text-slate-600">
                  ·
                </span>
                <div className="font-mono-tabular text-slate-400">
                  200자 원고지 {charMetrics.manuscriptPages200.toLocaleString()}매
                </div>
                <span aria-hidden="true" className="text-slate-600">
                  ·
                </span>
                <div className="font-mono-tabular text-slate-400">
                  단락 {charMetrics.paragraphCount}개
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="toggle-ai-studio-btn"
                  onClick={() => setShowAiStudio((prev) => !prev)}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                    showAiStudio
                      ? 'border-amber-500/60 bg-amber-500/15 text-amber-300'
                      : 'border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  <span>{showAiStudio ? 'AI 집필 스튜디오 닫기' : 'AI 집필 스튜디오 열기'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setUseSerifFont((prev) => !prev)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 transition-colors whitespace-nowrap"
                >
                  <Type className="h-3.5 w-3.5" />
                  <span>{useSerifFont ? '명조체(소설용)' : '고딕체(작업용)'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleManualSave(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors whitespace-nowrap"
                >
                  <Save className="h-3.5 w-3.5" />
                  <span>수동 저장 및 버전 생성</span>
                </button>
              </div>
            </div>

            {/* Phase 2: AI Writing Engine Studio Panel */}
            {showAiStudio && (
              <AiWritingPanel
                voiceRewriteSelection={voiceRewriteSelection?.episodeId === activeEpisode.id ? voiceRewriteSelection : null}
                project={project}
                episode={activeEpisode}
                allEpisodes={episodes}
                characters={characters}
                worldbuilding={worldbuilding}
                promptProfiles={promptProfiles}
                existingPlans={writingPlans}
                changeProposals={changeProposals}
                currentEditorContent={content}
                currentRevisionId={expectedRevisionIdRef.current}
                editorSelection={editorSelection}
                onApplyManuscriptToEditor={handleApplyAiManuscriptToEditor}
                onSaveWritingPlan={onSaveWritingPlan}
                onSaveChangeProposals={onSaveChangeProposals}
                onUpdateChangeProposalStatus={onUpdateChangeProposalStatus}
                onUpdatePromptProfile={onUpdatePromptProfile}
                onOpenPromptManager={onOpenPromptManager}
                onOpenProposalReview={onOpenProposalReview}
                getIdToken={getIdToken}
              />
            )}

            {/* Main Manuscript Textarea */}
            <div>
              <label htmlFor="manuscript-content-textarea" className="sr-only">
                회차 원고 본문
              </label>
              <textarea
                ref={manuscriptTextareaRef}
                id="manuscript-content-textarea"
                rows={18}
                value={content}
                onChange={(e) => {
                  const nextContent = e.target.value;
                  setContent(nextContent);
                  setEditorSelection(null);
                  triggerDebouncedAutoSave({ content: nextContent });
                }}
                onSelect={(e) => captureTextareaSelection(e.currentTarget)}
                onKeyUp={(e) => captureTextareaSelection(e.currentTarget)}
                onMouseUp={(e) => captureTextareaSelection(e.currentTarget)}
                placeholder="이곳에 판타지 웹소설 본문을 집필하세요. 입력 즉시 로컬 복구 버퍼에 보호되며, 1초 디바운스로 자동 저장됩니다."
                className={`w-full rounded-xl border border-slate-800 bg-slate-950/90 p-5 text-base leading-[1.85] text-slate-100 placeholder:text-slate-600 focus:border-amber-500/70 focus:outline-none ${
                  useSerifFont ? 'font-serif-kr' : ''
                }`}
              />
            </div>

            {/* Episode Synopsis & Author Note (Foreshadowing / Plot memo) */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label
                  htmlFor="episode-synopsis-textarea"
                  className="block text-xs font-medium text-slate-400 mb-1.5"
                >
                  회차 사건 요약 (플롯 로그)
                </label>
                <textarea
                  id="episode-synopsis-textarea"
                  rows={3}
                  value={synopsis}
                  onChange={(e) => {
                    const nextSyn = e.target.value;
                    setSynopsis(nextSyn);
                    triggerDebouncedAutoSave({ synopsis: nextSyn });
                  }}
                  placeholder="이번 회차의 핵심 사건 전개와 장면 전환을 요약하세요."
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs leading-relaxed text-slate-200 placeholder:text-slate-600 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="episode-author-note-textarea"
                  className="block text-xs font-medium text-slate-400 mb-1.5"
                >
                  작가 노트 및 복선 메모
                </label>
                <textarea
                  id="episode-author-note-textarea"
                  rows={3}
                  value={authorNote}
                  onChange={(e) => {
                    const nextNote = e.target.value;
                    setAuthorNote(nextNote);
                    triggerDebouncedAutoSave({ authorNote: nextNote });
                  }}
                  placeholder="회수해야 할 복선이나 세계관 제약 확인 사항을 기록하세요."
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs leading-relaxed text-slate-200 placeholder:text-slate-600 focus:border-amber-500 focus:outline-none"
                />
              </div>
            </div>

            {/* Bottom Save Status Bar inside Editor */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-slate-400">
              <div className="flex items-center gap-2">
                {saveState === 'saving' && (
                  <span className="inline-flex items-center gap-1.5 text-amber-400">
                    <Clock className="h-3.5 w-3.5" />
                    <span>변경 사항 자동 저장 중...</span>
                  </span>
                )}
                {saveState === 'saved' && (
                  <span className="inline-flex items-center gap-1.5 text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    <span>
                      모든 원고가 안전하게 저장되었습니다
                      {lastSavedAt ? ` (${new Date(lastSavedAt).toLocaleTimeString('ko-KR')})` : ''}
                    </span>
                  </span>
                )}
                {saveState === 'recovered' && (
                  <span className="inline-flex items-center gap-1.5 text-sky-400">
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>선택한 버전/복구본으로 원고가 복원 및 저장되었습니다</span>
                  </span>
                )}
                {saveState === 'error' && (
                  <span className="inline-flex items-center gap-1.5 text-rose-400">
                    <AlertCircle className="h-3.5 w-3.5" />
                    <span>저장 오류 발생 — 로컬 비상 복구 버퍼에 원고가 안전하게 보존되었습니다</span>
                  </span>
                )}
                {saveState === 'idle' && (
                  <span>원고 입력 시 1초 디바운스 자동 저장 및 로컬 복구 버퍼가 작동합니다</span>
                )}
              </div>

              <div className="font-mono-tabular text-slate-500">
                ID: {activeEpisode.id}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Right Column (3 cols): Revisions History & Linked Characters/Worldbuilding */}
      <aside className="space-y-4 xl:col-span-3">
        <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-950 p-1">
            <button
              type="button"
              onClick={() => setSidePanelTab('revisions')}
              className={`inline-flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors ${
                sidePanelTab === 'revisions'
                  ? 'bg-slate-800 text-amber-400'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <History className="h-3.5 w-3.5" />
              <span>버전 기록 ({episodeRevisions.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setSidePanelTab('lore')}
              className={`inline-flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors ${
                sidePanelTab === 'lore'
                  ? 'bg-slate-800 text-amber-400'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Globe className="h-3.5 w-3.5" />
              <span>연결 설정 ({linkedCharacterIds.length + linkedWorldbuildingIds.length})</span>
            </button>
          </div>

          {sidePanelTab === 'revisions' ? (
            <div className="mt-4 space-y-4">
              <div>
                <label
                  htmlFor="revision-label-input"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  새 버전 스냅샷 생성
                </label>
                <div className="space-y-2">
                  <input
                    id="revision-label-input"
                    type="text"
                    value={revisionLabelInput}
                    onChange={(e) => setRevisionLabelInput(e.target.value)}
                    placeholder="예: 전투 씬 수정 전 백업"
                    maxLength={120}
                    className="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => handleManualSave(true)}
                    disabled={!activeEpisode}
                    className="w-full rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50 whitespace-nowrap transition-colors"
                  >
                    현재 원고 스냅샷 저장
                  </button>
                </div>
              </div>

              <div className="max-h-[480px] space-y-2.5 overflow-y-auto pr-1">
                {episodeRevisions.length === 0 ? (
                  <div className="rounded-lg border border-slate-800/80 bg-slate-950/50 p-6 text-center text-xs text-slate-500">
                    저장된 버전 스냅샷이 없습니다. 수동 저장 버튼을 누르면 현재 회차의 스냅샷이 기록됩니다.
                  </div>
                ) : (
                  episodeRevisions.map((rev) => {
                    const diff = computeRevisionDiffSummary(content, rev.content);
                    return (
                      <div
                        key={rev.id}
                        className="rounded-lg border border-slate-800 bg-slate-950/70 p-3 space-y-2"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-slate-200 truncate">
                              {rev.label}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5 font-mono-tabular text-[11px] text-slate-400">
                              <span>{rev.charCountWithSpaces.toLocaleString()}자</span>
                              <span aria-hidden="true">·</span>
                              <span>{diff.formattedDelta}</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => onDeleteRevision(rev.id)}
                            aria-label={`${rev.label} 버전 삭제`}
                            className="rounded p-1 text-slate-500 hover:bg-rose-500/15 hover:text-rose-400 shrink-0"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>

                        <p className="line-clamp-2 text-xs leading-relaxed text-slate-400">
                          {diff.previewSnippet}
                        </p>

                        <div className="flex items-center justify-between gap-2 pt-1">
                          <span className="font-mono-tabular text-[11px] text-slate-500 whitespace-nowrap">
                            {new Date(rev.createdAt).toLocaleString('ko-KR', {
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                          <button
                            type="button"
                            onClick={() => setRestoreTargetRevision(rev)}
                            aria-label={`${rev.label} 버전으로 복원`}
                            className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300 hover:bg-amber-500/20 transition-colors whitespace-nowrap shrink-0"
                          >
                            <RotateCcw className="h-3 w-3" />
                            <span>버전 복원</span>
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ) : (
            <div className="mt-4 max-h-[540px] space-y-5 overflow-y-auto pr-1">
              {/* Linked Characters Selector & Reference */}
              <div>
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200 mb-2">
                  <Users className="h-3.5 w-3.5 text-sky-400" />
                  <span>회차 등장인물 연결 ({linkedCharacterIds.length}명)</span>
                </div>
                <div className="space-y-1.5">
                  {characters.map((ch) => {
                    const linked = linkedCharacterIds.includes(ch.id);
                    return (
                      <div
                        key={ch.id}
                        className={`rounded-lg border p-2.5 text-xs transition-colors ${
                          linked
                            ? 'border-sky-500/40 bg-sky-500/10'
                            : 'border-slate-800 bg-slate-950/60'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-medium text-slate-100 truncate">{ch.name}</div>
                          <button
                            type="button"
                            onClick={() => toggleLinkedCharacter(ch.id)}
                            className={`rounded px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${
                              linked
                                ? 'bg-sky-500 text-slate-950'
                                : 'border border-slate-700 text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {linked ? '연결됨' : '연결'}
                          </button>
                        </div>
                        <div className="mt-1 text-[11px] text-slate-400">
                          {ch.role} · {ch.status === 'confirmed' ? '확정 설정' : '초안 설정'}
                        </div>
                        {linked && ch.abilities && (
                          <div className="mt-1.5 text-[11px] text-slate-300 border-t border-slate-800/80 pt-1.5">
                            능력: {ch.abilities}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Linked Worldbuilding Selector & Reference */}
              <div>
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200 mb-2">
                  <Globe className="h-3.5 w-3.5 text-purple-400" />
                  <span>회차 세계관 설정 연결 ({linkedWorldbuildingIds.length}개)</span>
                </div>
                <div className="space-y-1.5">
                  {worldbuilding.map((wb) => {
                    const linked = linkedWorldbuildingIds.includes(wb.id);
                    return (
                      <div
                        key={wb.id}
                        className={`rounded-lg border p-2.5 text-xs transition-colors ${
                          linked
                            ? 'border-purple-500/40 bg-purple-500/10'
                            : 'border-slate-800 bg-slate-950/60'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-medium text-slate-100 truncate">{wb.title}</div>
                          <button
                            type="button"
                            onClick={() => toggleLinkedWorldbuilding(wb.id)}
                            className={`rounded px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${
                              linked
                                ? 'bg-purple-400 text-slate-950'
                                : 'border border-slate-700 text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {linked ? '연결됨' : '연결'}
                          </button>
                        </div>
                        <div className="mt-1 text-[11px] text-slate-400">
                          {wb.category} · {wb.status === 'confirmed' ? '확정 설정' : '초안 설정'}
                        </div>
                        {linked && wb.rules && (
                          <div className="mt-1.5 text-[11px] text-amber-200/90 border-t border-slate-800/80 pt-1.5">
                            제약 법칙: {wb.rules}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* Delete Episode Confirmation Modal */}
      <ConfirmModal
        open={Boolean(deleteTargetEpisode)}
        title="회차 원고 삭제 확인"
        description={
          deleteTargetEpisode
            ? `'${deleteTargetEpisode.title}' (${deleteTargetEpisode.charCountWithSpaces.toLocaleString()}자) 원고를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.`
            : ''
        }
        confirmLabel="회차 삭제"
        onConfirm={async () => {
          if (!deleteTargetEpisode) return;
          const targetId = deleteTargetEpisode.id;
          setDeleteTargetEpisode(null);
          await onDeleteEpisode(targetId);
        }}
        onCancel={() => setDeleteTargetEpisode(null)}
      />

      {/* Restore Revision Confirmation Modal */}
      <ConfirmModal
        open={Boolean(restoreTargetRevision)}
        title="원고 버전 복원 확인"
        variant="primary"
        description={
          restoreTargetRevision
            ? `'${restoreTargetRevision.label}' (${restoreTargetRevision.charCountWithSpaces.toLocaleString()}자) 버전으로 원고를 복원하시겠습니까? 현재 작성 중인 원고는 복원 직전 자동 백업 버전으로 먼저 안전하게 기록됩니다.`
            : ''
        }
        confirmLabel="안전 백업 후 버전 복원"
        onConfirm={handleConfirmRestoreRevision}
        onCancel={() => setRestoreTargetRevision(null)}
      />
    </div>
  );
};
