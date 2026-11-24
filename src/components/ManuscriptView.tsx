import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  generateEntityId,
  validateEpisodeInput,
} from '../utils/novelLogic';
import {
  acknowledgeEpisodeDraft, persistEpisodeDraft, readEpisodeDrafts,
  type DraftScope, type DurableEpisodeDraft,
} from '../services/episodeDraftStore';
import { EpisodeSaveScheduler, classifyEpisodeSaveError, retryEpisodeAutosave, serializeEpisodeSave } from '../utils/episodeSaveScheduler';
import { episodeSavePayloadHash, episodeSaveSignature } from '../utils/episodeSavePayload';
import type { EpisodeRevisionCommitResult } from '../services/novelRepository';
import { computeManuscriptContentHash } from '../utils/manuscriptIntegrity';
import { ConfirmModal } from './ConfirmModal';
import { AiWritingPanel } from './AiWritingPanel';
import type { VoiceRewriteSelection } from './CharacterVoicePanel';

interface ManuscriptViewProps {
  ownerId: string;
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
      expectedSavePayloadHash?: string;
      deduplicate?: boolean;
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

type SaveOptions = NonNullable<Parameters<ManuscriptViewProps['onSaveEpisode']>[1]>;

interface EditorSaveSession {
  scope: DraftScope;
  writerId: string;
  sequence: number;
  baseline: Episode;
  latest?: DurableEpisodeDraft;
  retryOnReconnect?: boolean;
  scheduler: EpisodeSaveScheduler<DurableEpisodeDraft>;
}

export const ManuscriptView: React.FC<ManuscriptViewProps> = ({
  ownerId,
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

  const [recoveryDrafts, setRecoveryDrafts] = useState<DurableEpisodeDraft[]>([]);
  const [selectedRecoveryWriter, setSelectedRecoveryWriter] = useState('');
  const emergencyBackup = recoveryDrafts.find((draft) => draft.writerId === selectedRecoveryWriter) ?? recoveryDrafts[0];
  const [localDraftStatus, setLocalDraftStatus] = useState<string | null>(null);
  const [unprotectedInput, setUnprotectedInput] = useState(false);
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

  const saveSessionRef = useRef<EditorSaveSession | null>(null);
  const saveHandlers = useRef({ onSaveEpisode, onSaveStateChange });
  saveHandlers.current = { onSaveEpisode, onSaveStateChange };
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

  useLayoutEffect(() => {
    setRecoveryDrafts([]);
    setLocalDraftStatus(null);
    setUnprotectedInput(false);
    setValidationError(null);
    setEditorSelection(null);
    if (!activeEpisode || project.ownerId !== ownerId) return;

    const scope: DraftScope = [ownerId, projectId, activeEpisode.id];
    const session: EditorSaveSession = {
      scope, writerId: generateEntityId('writer'), sequence: 0, baseline: activeEpisode,
      scheduler: new EpisodeSaveScheduler((draft) => saveQueuedDraft(session, draft)),
    };
    saveSessionRef.current = session;
    setEpisodeNumber(activeEpisode.episodeNumber);
    setTitle(activeEpisode.title);
    setContent(activeEpisode.content);
    setSynopsis(activeEpisode.synopsis);
    setAuthorNote(activeEpisode.authorNote);
    setStatus(activeEpisode.status);
    setLinkedCharacterIds(activeEpisode.linkedCharacterIds);
    setLinkedWorldbuildingIds(activeEpisode.linkedWorldbuildingIds);

    void readEpisodeDrafts(scope).then((drafts) => {
      if (saveSessionRef.current === session) {
        setRecoveryDrafts(drafts.filter((draft) =>
          episodeSaveSignature(draft.episode) !== episodeSaveSignature(session.baseline)));
      }
    }).catch(() => {
      if (saveSessionRef.current === session) setLocalDraftStatus('로컬 복구 저장소를 읽을 수 없습니다.');
    });
    const onReconnect = () => {
      if (session.retryOnReconnect && session.latest && saveSessionRef.current === session) {
        session.retryOnReconnect = false;
        session.scheduler.schedule(session.latest);
      }
    };
    window.addEventListener('online', onReconnect);
    return () => {
      window.removeEventListener('online', onReconnect);
      session.scheduler.dispose();
      if (saveSessionRef.current === session) saveSessionRef.current = null;
    };
  }, [ownerId, projectId, activeEpisode?.id]);

  useEffect(() => {
    if (!unprotectedInput) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [unprotectedInput]);

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

  function saveCandidate(
    session: EditorSaveSession, candidate: Episode, options: SaveOptions, retry = false,
  ): Promise<EpisodeRevisionCommitResult> {
    const base = session.baseline;
    const candidateToSave = { ...candidate, latestRevisionId: base.latestRevisionId };
    const isCurrent = () => saveSessionRef.current === session;
    const send = async () => {
      if (!isCurrent()) throw new Error('[SAVE_SCOPE_CHANGED] 편집 중인 회차가 바뀌었습니다.');
      const result = await saveHandlers.current.onSaveEpisode(candidateToSave, {
        ...options,
        expectedRevisionId: base.latestRevisionId || '',
        expectedContentHash: base.contentHash || computeManuscriptContentHash(base.content),
        expectedSavePayloadHash: episodeSavePayloadHash(base),
      });
      if (!result) throw new Error('[SAVE_SCOPE_CHANGED] 편집 중인 회차가 바뀌었습니다.');
      session.baseline = result.episode;
      return result;
    };
    return serializeEpisodeSave(session.scope, () => retry ? retryEpisodeAutosave(send, isCurrent) : send());
  }

  function reportSaveError(session: EditorSaveSession, sequence: number, error: unknown) {
    if (saveSessionRef.current !== session || session.sequence !== sequence) return;
    const kind = classifyEpisodeSaveError(error);
    const messages = {
      NETWORK_ERROR: '네트워크 오류로 원격 저장이 보류됐습니다.',
      AUTH_ERROR: '로그인이 필요해 원격 저장이 보류됐습니다.',
      PERMISSION_DENIED: '회차가 삭제됐거나 이 회차에 저장할 권한이 없습니다.',
      REVISION_CONFLICT: '다른 저장본과 충돌했습니다. 현재 원고와 로컬 복구본을 확인하세요.',
      DOCUMENT_TOO_LARGE: '원격 문서의 크기 한도를 넘었습니다.',
      LOCAL_STORAGE_ERROR: '저장 공간이 부족합니다.',
      SAVE_SCOPE_CHANGED: '편집 중인 회차가 바뀌었습니다.',
      SAVE_ERROR: '회차를 저장할 수 없습니다.',
    };
    saveHandlers.current.onSaveStateChange('error', messages[kind]);
    void readEpisodeDrafts(session.scope).then((drafts) => {
      if (saveSessionRef.current === session && session.sequence === sequence) setRecoveryDrafts(drafts);
    }).catch(() => {});
  }

  async function acknowledgeDraft(draft: DurableEpisodeDraft) {
    await acknowledgeEpisodeDraft(draft);
    const session = saveSessionRef.current;
    if (session && session.scope.every((id, index) => id === draft.scope[index])) {
      setRecoveryDrafts((current) => current.filter((item) =>
        item.writerId !== draft.writerId || item.sequence !== draft.sequence));
    }
  }

  async function saveQueuedDraft(session: EditorSaveSession, draft: DurableEpisodeDraft) {
    if (saveSessionRef.current !== session || session.sequence !== draft.sequence) return;
    const isLatest = () => saveSessionRef.current === session && session.sequence === draft.sequence;
    saveHandlers.current.onSaveStateChange('saving');
    try {
      if (episodeSaveSignature(draft.episode) !== episodeSaveSignature(session.baseline)) {
        await saveCandidate(session, draft.episode, { createRevision: false, deduplicate: true }, true);
      }
    } catch (error) {
      if (isLatest()) session.retryOnReconnect = classifyEpisodeSaveError(error) === 'NETWORK_ERROR';
      reportSaveError(session, draft.sequence, error);
      return;
    }
    if (isLatest()) {
      session.latest = undefined;
      saveHandlers.current.onSaveStateChange('saved');
      setUnprotectedInput(false);
      setLocalDraftStatus(null);
    }
    try {
      await acknowledgeDraft(draft);
    } catch {
      if (isLatest()) setLocalDraftStatus('저장 완료 · 로컬 복구본을 정리하지 못했습니다.');
    }
  }

  const triggerDebouncedAutoSave = (draftOverrides?: Partial<Episode>) => {
    const session = saveSessionRef.current;
    const candidate = buildUpdatedEpisode(draftOverrides);
    if (!session || !candidate) return;
    const signature = episodeSaveSignature(candidate);
    if (signature === episodeSaveSignature(session.latest?.episode ?? session.baseline)) return;

    const draft: DurableEpisodeDraft = {
      scope: session.scope, writerId: session.writerId, sequence: ++session.sequence, episode: candidate,
      baseRevisionId: session.baseline.latestRevisionId || '',
      baseContentHash: session.baseline.contentHash || computeManuscriptContentHash(session.baseline.content),
      baseSavePayloadHash: episodeSavePayloadHash(session.baseline),
      savedAt: Date.now(),
    };
    session.latest = draft;
    session.retryOnReconnect = false;
    saveHandlers.current.onSaveStateChange('idle');
    setUnprotectedInput(true);
    setLocalDraftStatus('로컬 복구본 저장 중');
    void persistEpisodeDraft(draft).then(() => {
      if (saveSessionRef.current === session && session.latest?.sequence === draft.sequence) {
        setUnprotectedInput(false);
        setLocalDraftStatus(ownerId === 'local_author' ? '로컬 보존 · 작품 저장 대기' : '로컬 보존 · 원격 저장 대기');
      }
    }).catch(() => {
      if (saveSessionRef.current === session && session.latest?.sequence === draft.sequence) {
        setLocalDraftStatus('로컬 복구본 저장 실패 · 이 창의 원고를 보존하세요.');
      }
    });

    const check = validateEpisodeInput(candidate);
    if (!check.valid) {
      session.scheduler.cancelPending();
      setValidationError(check.error || '입력값 검증 오류');
      return;
    }
    setValidationError(null);
    session.scheduler.schedule(draft);
  };

  async function saveExplicit(
    candidate: Episode, options: SaveOptions, onCurrentSuccess: () => void, recovered = false,
  ): Promise<EpisodeRevisionCommitResult> {
    const session = saveSessionRef.current;
    if (!session) throw new Error('[SAVE_SCOPE_CHANGED] 편집 중인 회차가 바뀌었습니다.');
    const { sequence, latest } = session;
    const check = validateEpisodeInput(candidate);
    if (!check.valid) {
      setValidationError(check.error || '입력값을 확인해 주세요.');
      throw new Error(check.error || '회차 입력값이 올바르지 않습니다.');
    }
    setValidationError(null);
    session.scheduler.cancelPending();
    return session.scheduler.runExclusive(async () => {
      if (session.sequence !== sequence) throw new Error('[SAVE_SCOPE_CHANGED] 저장 요청 이후 원고가 수정됐습니다.');
      saveHandlers.current.onSaveStateChange('saving');
      try {
        const result = await saveCandidate(session, candidate, options);
        if (saveSessionRef.current === session && session.sequence === sequence) {
          onCurrentSuccess();
          saveHandlers.current.onSaveStateChange(recovered ? 'recovered' : 'saved');
          if (latest && episodeSaveSignature(latest.episode) === episodeSaveSignature(result.episode)) {
            session.latest = undefined;
            setUnprotectedInput(false);
            setLocalDraftStatus(null);
            void acknowledgeDraft(latest).catch(() =>
              setLocalDraftStatus('저장 완료 · 로컬 복구본을 정리하지 못했습니다.'));
          }
        }
        return result;
      } catch (error) {
        reportSaveError(session, sequence, error);
        throw error;
      }
    });
  }

  const handleManualSave = async (createSnapshot = true) => {
    const candidate = buildUpdatedEpisode();
    if (!candidate) return;
    try {
      await saveExplicit(candidate, {
        createRevision: createSnapshot,
        revisionLabel: revisionLabelInput.trim() ||
          `${candidate.status === 'confirmed' ? '확정' : '수동'} 저장 (${candidate.charCountWithSpaces}자)`,
      }, () => setRevisionLabelInput(''));
    } catch {
      // The scoped save already reported the error and kept the local draft.
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
    const draft = emergencyBackup;
    const session = saveSessionRef.current;
    if (!draft || !session) return;
    if (draft.baseRevisionId !== (session.baseline.latestRevisionId || '') ||
        draft.baseContentHash !== (session.baseline.contentHash || computeManuscriptContentHash(session.baseline.content)) ||
        draft.baseSavePayloadHash !== episodeSavePayloadHash(session.baseline)) {
      setValidationError('원격 회차가 변경됐습니다. 복구본을 내려받아 최신 원고와 비교하세요.');
      return;
    }
    const restored = buildUpdatedEpisode(draft.episode);
    if (!restored) return;
    try {
      await saveExplicit(restored, {
        createBackupRevisionFirst: true, backupRevisionLabel: '비상 복구 전 안전 백업',
        createRevision: true, revisionLabel: '비상 복구본에서 원고 복원',
      }, () => {
        setTitle(restored.title);
        setContent(restored.content);
        setSynopsis(restored.synopsis);
        setAuthorNote(restored.authorNote);
        setEpisodeNumber(restored.episodeNumber);
        setStatus(restored.status);
        setLinkedCharacterIds(restored.linkedCharacterIds);
        setLinkedWorldbuildingIds(restored.linkedWorldbuildingIds);
        void acknowledgeDraft(draft).catch(() => setLocalDraftStatus('복구 완료 · 로컬 사본을 정리하지 못했습니다.'));
      }, true);
    } catch {
      // Keep the recovery copy if the save did not complete.
    }
  };

  const downloadRecoveryDraft = () => {
    const draft = emergencyBackup;
    if (!draft) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(draft.episode, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `recovered-${draft.episode.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const handleConfirmRestoreRevision = async () => {
    if (!restoreTargetRevision || !activeEpisode) return;
    const targetRev = restoreTargetRevision;
    const restoredEpisode = buildUpdatedEpisode({ content: targetRev.content });
    if (!restoredEpisode) return;
    try {
      await saveExplicit(restoredEpisode, {
        createBackupRevisionFirst: true,
        backupRevisionLabel: `버전 복원 전 자동 백업 (${calculateCharCounts(content).withSpaces.toLocaleString()}자)`,
        createRevision: true,
        revisionLabel: `'${targetRev.label}' 버전으로 복원됨`,
      }, () => {
        setRestoreTargetRevision(null);
        setContent(targetRev.content);
      }, true);
    } catch {
      // The server version and recovery copy remain available.
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

    const updatedCandidate = buildUpdatedEpisode({
      content: newContent,
      status: options.markConfirmed ? 'confirmed' : status,
      synopsis: options.updatedSynopsis ?? synopsis,
    });
    if (!updatedCandidate) return;
    return saveExplicit(updatedCandidate, {
      createBackupRevisionFirst: options.createBackupRevisionFirst && content.trim().length > 0 && content !== newContent,
      backupRevisionLabel: `AI 원고 반영 전 안전 백업 (${calculateCharCounts(content).withSpaces.toLocaleString()}자)`,
      createRevision: true,
      revisionLabel: options.revisionLabel,
    }, () => {
      setContent(newContent);
      setStatus(updatedCandidate.status);
      setSynopsis(updatedCandidate.synopsis);
      setEditorSelection(null);
    });
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
                      로컬 원고 복구본 {recoveryDrafts.length}개 ({emergencyBackup.episode.content.length.toLocaleString()}자)
                    </div>
                    <div>
                      오류 또는 새로고침 직전 로컬에 보존된 원고입니다.
                    </div>
                    {recoveryDrafts.length > 1 && (
                      <select
                        aria-label="복구할 원고"
                        className="mt-2 rounded-md bg-slate-900 px-2 py-1"
                        value={emergencyBackup.writerId}
                        onChange={(event) => setSelectedRecoveryWriter(event.target.value)}
                      >
                        {recoveryDrafts.map((draft) => (
                          <option key={draft.writerId} value={draft.writerId}>
                            {new Date(draft.savedAt).toLocaleString()} · {draft.episode.content.length.toLocaleString()}자
                          </option>
                        ))}
                      </select>
                    )}
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
                    onClick={downloadRecoveryDraft}
                    className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 whitespace-nowrap"
                  >
                    복구본 다운로드
                  </button>
                </div>
              </div>
            )}

            {localDraftStatus && <p role="status" className="text-xs text-slate-300">{localDraftStatus}</p>}

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
                currentRevisionId={saveSessionRef.current?.baseline.latestRevisionId ?? activeEpisode.latestRevisionId ?? ''}
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
