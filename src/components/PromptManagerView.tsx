import React, { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  FileText,
  FileUp,
  GitBranch,
  History,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  Sliders,
  Sparkles,
  ToggleLeft,
  ToggleRight,
  Trash2,
} from 'lucide-react';
import type {
  Character,
  Episode,
  PromptProfile,
  PromptProfileCasResult,
  PromptTemplateType,
  Revision,
  StyleApprovalPayload,
  StyleProfile,
  StyleProfileApplicationResult,
} from '../types/novel';
import {
  createNewPromptProfile,
  formatPromptTemplateTypeKorean,
  PROMPT_TEMPLATE_TYPES,
  restorePromptProfileToVersion,
  updatePromptProfileContent,
} from '../utils/aiEngineLogic';
import { AuthorStyleDnaPanel } from './AuthorStyleDnaPanel';
import { ConfirmModal } from './ConfirmModal';

interface PromptManagerViewProps {
  projectId: string;
  projectTitle: string;
  ownerId: string;
  promptProfiles: PromptProfile[];
  characters: Character[];
  episodes?: Episode[];
  revisions?: Revision[];
  styleProfiles?: StyleProfile[];
  getIdToken?: () => Promise<string | null>;
  onApproveSaveStyleDNA?: (
    payload: StyleApprovalPayload
  ) => Promise<StyleProfileApplicationResult>;
  onCreatePromptProfile: (profile: PromptProfile) => Promise<void>;
  onUpdatePromptProfile: (
    profile: PromptProfile,
    options?: {
      expectedVersionId?: string;
      expectedVersionNumber?: number;
    }
  ) => Promise<PromptProfileCasResult | void>;
  onReloadPromptProfile?: (profileId: string) => Promise<PromptProfile | null>;
  onDeletePromptProfile: (profileId: string) => Promise<void>;
}

export const PromptManagerView: React.FC<PromptManagerViewProps> = ({
  projectId,
  projectTitle,
  ownerId,
  promptProfiles,
  characters,
  episodes = [],
  revisions = [],
  styleProfiles = [],
  getIdToken,
  onApproveSaveStyleDNA,
  onCreatePromptProfile,
  onUpdatePromptProfile,
  onReloadPromptProfile,
  onDeletePromptProfile,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<'ALL' | PromptTemplateType>('ALL');
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    () => promptProfiles[0]?.id || null
  );
  const [showPreviewModal, setShowPreviewModal] = useState<boolean>(false);
  const [isCreatingNew, setIsCreatingNew] = useState<boolean>(false);
  const [deleteTarget, setDeleteTarget] = useState<PromptProfile | null>(null);
  const [feedbackBanner, setFeedbackBanner] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [casConflictState, setCasConflictState] = useState<PromptProfileCasResult | null>(
    null
  );

  // Editor state for selected profile
  const activeProfile = useMemo(() => {
    if (!promptProfiles.length) return null;
    if (selectedProfileId) {
      const found = promptProfiles.find((p) => p.id === selectedProfileId);
      if (found) return found;
    }
    return promptProfiles[0];
  }, [promptProfiles, selectedProfileId]);

  const [editTitle, setEditTitle] = useState<string>(activeProfile?.title || '');
  const [editDescription, setEditDescription] = useState<string>(
    activeProfile?.description || ''
  );
  const [editContent, setEditContent] = useState<string>(activeProfile?.content || '');
  const [editVersionLabel, setEditVersionLabel] = useState<string>('');
  const [editTargetCharacterId, setEditTargetCharacterId] = useState<string>(
    activeProfile?.targetCharacterId || ''
  );

  const [editBaseVersionId, setEditBaseVersionId] = useState<string | undefined>(
    activeProfile?.currentVersionId
  );
  const [editBaseVersionNumber, setEditBaseVersionNumber] = useState<
    number | undefined
  >(activeProfile?.currentVersionNumber);

  // New prompt creation modal state
  const [newType, setNewType] = useState<PromptTemplateType>('CORE_WRITING_RULES');
  const [newTitle, setNewTitle] = useState<string>('');
  const [newDescription, setNewDescription] = useState<string>('');
  const [newContent, setNewContent] = useState<string>('');
  const [newTargetCharId, setNewTargetCharId] = useState<string>('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const syncEditorToProfile = (profile: PromptProfile) => {
    setSelectedProfileId(profile.id);
    setEditTitle(profile.title);
    setEditDescription(profile.description);
    setEditContent(profile.content);
    setEditTargetCharacterId(profile.targetCharacterId || '');
    setEditVersionLabel('');
    setEditBaseVersionId(profile.currentVersionId);
    setEditBaseVersionNumber(profile.currentVersionNumber);
    setCasConflictState(null);
  };

  const filteredProfiles = useMemo(() => {
    if (selectedCategory === 'ALL') return promptProfiles;
    return promptProfiles.filter((p) => p.promptType === selectedCategory);
  }, [promptProfiles, selectedCategory]);

  const activePromptsSummary = useMemo(
    () => promptProfiles.filter((p) => p.isActive),
    [promptProfiles]
  );

  const stylePromptProfiles = useMemo(
    () => promptProfiles.filter((p) => p.promptType === 'PROJECT_STYLE_PROFILE'),
    [promptProfiles]
  );

  const resolvedGetIdToken = getIdToken || (async () => null);

  const masterRulesProfile = useMemo(() => {
    return (
      promptProfiles.find(
        (p) =>
          p.promptType === 'CORE_WRITING_RULES' &&
          (p.title === 'NOVEL FORGE Master Writing Rules' ||
            p.title.includes('Master Writing Rules') ||
            p.title.includes('Writing Control Rules'))
      ) ||
      promptProfiles.find((p) => p.promptType === 'CORE_WRITING_RULES') ||
      null
    );
  }, [promptProfiles]);

  const handleSaveCurrentProfile = async () => {
    if (!activeProfile) return;
    setErrorBanner(null);
    setCasConflictState(null);
    const updated = updatePromptProfileContent(activeProfile, {
      title: editTitle,
      description: editDescription,
      content: editContent,
      versionLabel: editVersionLabel,
      isActive: activeProfile.isActive,
    });
    const withChar: PromptProfile = {
      ...updated,
      targetCharacterId: editTargetCharacterId || undefined,
    };
    const res = await onUpdatePromptProfile(withChar, {
      expectedVersionId: editBaseVersionId ?? activeProfile.currentVersionId,
      expectedVersionNumber:
        editBaseVersionNumber ?? activeProfile.currentVersionNumber,
    });
    if (res && !res.committed) {
      setFeedbackBanner(null);
      if (res.status === 'VERSION_CONFLICT') {
        setCasConflictState(res);
      } else {
        setErrorBanner(
          res.errorMessage || '프롬프트 저장이 완료되지 않았습니다.'
        );
      }
      return;
    }
    const committedProfile = res?.profile || withChar;
    syncEditorToProfile(committedProfile);
    setFeedbackBanner(
      `'${committedProfile.title}' 프롬프트가 v${committedProfile.currentVersionNumber} 버전으로 저장되었습니다.`
    );
  };

  const handleToggleActive = async (profile: PromptProfile) => {
    setErrorBanner(null);
    setCasConflictState(null);
    const updated: PromptProfile = {
      ...profile,
      isActive: !profile.isActive,
      updatedAt: new Date().toISOString(),
    };
    const res = await onUpdatePromptProfile(updated, {
      expectedVersionId: profile.currentVersionId,
      expectedVersionNumber: profile.currentVersionNumber,
    });
    if (res && !res.committed) {
      setFeedbackBanner(null);
      if (res.status === 'VERSION_CONFLICT') {
        setCasConflictState(res);
      } else {
        setErrorBanner(
          res.errorMessage || '프롬프트 활성 상태 변경이 완료되지 않았습니다.'
        );
      }
      return;
    }
    const committedProfile = res?.profile || updated;
    if (activeProfile?.id === committedProfile.id) {
      setEditBaseVersionId(committedProfile.currentVersionId);
      setEditBaseVersionNumber(committedProfile.currentVersionNumber);
    }
    setFeedbackBanner(
      `'${committedProfile.title}' 프롬프트가 ${committedProfile.isActive ? '활성화' : '비활성화'}되었습니다.`
    );
  };

  const handleRestoreVersion = async (versionId: string) => {
    if (!activeProfile) return;
    setErrorBanner(null);
    setCasConflictState(null);
    const restored = restorePromptProfileToVersion(activeProfile, versionId);
    const res = await onUpdatePromptProfile(restored, {
      expectedVersionId: editBaseVersionId ?? activeProfile.currentVersionId,
      expectedVersionNumber:
        editBaseVersionNumber ?? activeProfile.currentVersionNumber,
    });
    if (res && !res.committed) {
      setFeedbackBanner(null);
      if (res.status === 'VERSION_CONFLICT') {
        setCasConflictState(res);
      } else {
        setErrorBanner(
          res.errorMessage || '이전 버전 복원이 완료되지 않았습니다.'
        );
      }
      return;
    }
    const committedProfile = res?.profile || restored;
    syncEditorToProfile(committedProfile);
    setFeedbackBanner(
      `이전 버전이 복원되어 새 버전(v${committedProfile.currentVersionNumber})으로 적용되었습니다.`
    );
  };

  const handleReloadConflictedProfile = async () => {
    if (!activeProfile) return;
    const remote =
      (onReloadPromptProfile && (await onReloadPromptProfile(activeProfile.id))) ||
      casConflictState?.remoteProfile ||
      promptProfiles.find((p) => p.id === activeProfile.id) ||
      null;
    if (remote) {
      syncEditorToProfile(remote);
      setCasConflictState(null);
      setErrorBanner(null);
      setFeedbackBanner(
        `'${remote.title}'의 최신 버전(v${remote.currentVersionNumber} · ${remote.currentVersionId})을 다시 불러왔습니다.`
      );
    }
  };

  const handleBranchConflictedProfile = async () => {
    if (!activeProfile) return;
    const branchedTitle = `${(editTitle || activeProfile.title).trim()} (분기)`.slice(
      0,
      150
    );
    const branched = createNewPromptProfile({
      ownerId,
      projectId,
      promptType: activeProfile.promptType,
      title: branchedTitle,
      description: editDescription || activeProfile.description,
      content: editContent || activeProfile.content,
      targetCharacterId: editTargetCharacterId || undefined,
      isActive: activeProfile.isActive,
    });
    await onCreatePromptProfile(branched);
    setCasConflictState(null);
    setErrorBanner(null);
    syncEditorToProfile(branched);
    setFeedbackBanner(
      `현재 수정안이 새 분기 프롬프트 '${branched.title}' (v1)으로 안전하게 저장되었습니다.`
    );
  };

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setEditContent(text);
      setEditVersionLabel(`파일 가져오기: ${file.name}`);
      setFeedbackBanner(
        `'${file.name}' 파일(${text.length.toLocaleString()}자)을 편집기에 불러왔습니다. [프롬프트 저장 및 새 버전 기록] 버튼을 눌러 확정하세요.`
      );
    } catch {
      setFeedbackBanner('파일을 읽는 중 오류가 발생했습니다.');
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newContent.trim()) return;
    const created = createNewPromptProfile({
      ownerId,
      projectId,
      promptType: newType,
      title: newTitle,
      description: newDescription,
      content: newContent,
      targetCharacterId: newTargetCharId || undefined,
      isActive: true,
    });
    await onCreatePromptProfile(created);
    setIsCreatingNew(false);
    setNewTitle('');
    setNewDescription('');
    setNewContent('');
    setNewTargetCharId('');
    syncEditorToProfile(created);
    setFeedbackBanner(`새 프롬프트 '${created.title}'이(가) 등록되었습니다.`);
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-5">
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
          <div>
            <div className="flex items-center gap-2">
              <Sliders className="h-5 w-5 text-amber-400" />
              <h1 className="text-lg font-bold text-slate-100">
                프롬프트 관리기 (Prompt Manager)
              </h1>
              <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono-tabular text-xs font-semibold text-amber-300">
                활성 {activePromptsSummary.length} / 전체 {promptProfiles.length}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-400">
              현재 작품({projectTitle})의 AI 집필·검수 엔진에 주입되는 5대 프롬프트 템플릿과 버전을 관리합니다.{' '}
              <strong className="text-amber-300">
                NOVEL FORGE Master Writing Rules (Version 1.0)
              </strong>{' '}
              전문이 Core Writing Rules에 정식 등록되어 있으며, 수정 및 버전 복원이 즉시 Novel Writer에 반영됩니다.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowPreviewModal(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 transition-colors"
            >
              <Eye className="h-3.5 w-3.5 text-amber-400" />
              <span>통합 프롬프트 적용 미리보기</span>
            </button>
            <button
              type="button"
              onClick={() => setIsCreatingNew(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>새 프롬프트 등록</span>
            </button>
          </div>
        </div>

        {/* Requirement 7: Master Writing Rules Status Display Card */}
        {masterRulesProfile && (
          <div
            data-testid="master-writing-rules-status-card"
            className="mt-4 rounded-xl border border-amber-500/40 bg-slate-950/90 p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-2.5">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-amber-400" />
                <span className="text-xs font-bold text-amber-300">
                  Core Writing Rules · Master Writing Rules 상태 모니터
                </span>
                <span className="rounded bg-amber-500/20 px-2 py-0.5 font-mono-tabular text-[11px] font-semibold text-amber-200">
                  적용 대상: {masterRulesProfile.targetModule || 'Novel Writer'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => syncEditorToProfile(masterRulesProfile)}
                className="text-xs font-semibold text-amber-400 hover:text-amber-300"
              >
                편집기에서 열기 →
              </button>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6 text-xs">
              <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-2.5">
                <div className="text-[11px] text-slate-400">등록된 규칙 이름</div>
                <div
                  data-testid="master-rules-title"
                  className="mt-1 font-semibold text-slate-100 break-words"
                >
                  {masterRulesProfile.title}
                </div>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-2.5">
                <div className="text-[11px] text-slate-400">적용 작품 / 범위</div>
                <div
                  data-testid="master-rules-project"
                  className="mt-1 font-semibold text-slate-100"
                >
                  {projectTitle}{' '}
                  <span className="text-[11px] font-normal text-amber-300">
                    ({masterRulesProfile.scope || '작품별 선택 가능'})
                  </span>
                </div>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-2.5">
                <div className="text-[11px] text-slate-400">활성화 여부</div>
                <div
                  data-testid="master-rules-active"
                  className="mt-1 flex items-center gap-1.5 font-semibold"
                >
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      masterRulesProfile.isActive ? 'bg-emerald-400' : 'bg-slate-500'
                    }`}
                  />
                  <span
                    className={
                      masterRulesProfile.isActive ? 'text-emerald-300' : 'text-slate-400'
                    }
                  >
                    {masterRulesProfile.isActive ? '활성 (Novel Writer 적용 중)' : '비활성'}
                  </span>
                </div>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-2.5">
                <div className="text-[11px] text-slate-400">현재 버전 번호</div>
                <div
                  data-testid="master-rules-version"
                  className="mt-1 font-mono-tabular font-semibold text-amber-300"
                >
                  버전 {masterRulesProfile.versionLabel || '1.0'} (v
                  {masterRulesProfile.currentVersionNumber} ·{' '}
                  {masterRulesProfile.currentVersionId})
                </div>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-2.5">
                <div className="text-[11px] text-slate-400">마지막 수정일</div>
                <div
                  data-testid="master-rules-updated-at"
                  className="mt-1 font-mono-tabular text-slate-200"
                >
                  {new Date(masterRulesProfile.updatedAt).toLocaleString('ko-KR', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-2.5">
                <div className="text-[11px] text-slate-400">
                  마지막 집필에 실제 사용된 규칙 버전
                </div>
                <div
                  data-testid="master-rules-last-used"
                  className="mt-1 font-mono-tabular font-semibold text-sky-300"
                >
                  {masterRulesProfile.lastUsedVersionId ? (
                    <>
                      버전 {masterRulesProfile.lastUsedVersionLabel || '1.0'} (v
                      {masterRulesProfile.lastUsedVersionNumber || 1} ·{' '}
                      {masterRulesProfile.lastUsedVersionId})
                    </>
                  ) : (
                    <span className="text-slate-400 font-normal">
                      집필 대기 중 (선택됨: 버전{' '}
                      {masterRulesProfile.versionLabel || '1.0'} ·{' '}
                      {masterRulesProfile.currentVersionId})
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {feedbackBanner && (
          <div
            role="status"
            className="mt-4 flex items-center justify-between gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3.5 py-2 text-xs text-emerald-200"
          >
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
              <span>{feedbackBanner}</span>
            </div>
            <button
              type="button"
              onClick={() => setFeedbackBanner(null)}
              className="text-emerald-300 hover:text-white"
            >
              닫기
            </button>
          </div>
        )}

        {errorBanner && (
          <div
            role="alert"
            data-testid="prompt-manager-error-banner"
            className="mt-4 flex items-center justify-between gap-2 rounded-lg border border-red-500/40 bg-red-950/30 px-3.5 py-2.5 text-xs text-red-200"
          >
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-red-400 shrink-0" />
              <span>{errorBanner}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              className="text-red-300 hover:text-white"
            >
              닫기
            </button>
          </div>
        )}

        {casConflictState && (
          <div
            role="alert"
            data-testid="prompt-cas-conflict-banner"
            className="mt-4 rounded-lg border border-amber-500/50 bg-amber-950/30 p-3.5 space-y-2.5 text-xs text-amber-100"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-semibold text-amber-200">
                  프롬프트 버전 충돌 감지 (VERSION_CONFLICT) — 덮어쓰기가 차단되었습니다
                </div>
                <p className="text-[11px] text-amber-200/90">
                  {casConflictState.errorMessage ||
                    '다른 탭 또는 세션에서 먼저 새 버전이 저장되어 기존 버전을 보호했습니다. 작성 중인 수정안은 편집기에 안전하게 보존되어 있습니다.'}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 pl-6">
              <button
                type="button"
                onClick={handleReloadConflictedProfile}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/50 bg-slate-950 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-slate-900"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>최신 프로필 다시 불러오기</span>
              </button>
              <button
                type="button"
                onClick={handleBranchConflictedProfile}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400"
              >
                <GitBranch className="h-3.5 w-3.5" />
                <span>현재 수정안을 새 프로필로 분기 저장</span>
              </button>
              <button
                type="button"
                onClick={() => setCasConflictState(null)}
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-300 hover:text-white"
              >
                취소
              </button>
            </div>
          </div>
        )}

      {/* Phase 4.3C Stage 1 & 1.1: Author Style DNA Analyzer & Atomic Author Approval Panel */}
      {onApproveSaveStyleDNA && (
        <AuthorStyleDnaPanel
          projectId={projectId}
          projectTitle={projectTitle}
          ownerId={ownerId}
          episodes={episodes}
          revisions={revisions}
          styleProfiles={styleProfiles}
          stylePromptProfiles={stylePromptProfiles}
          getIdToken={resolvedGetIdToken}
          onApproveSaveStyleDNA={async (payload) => {
            setErrorBanner(null);
            const res = await onApproveSaveStyleDNA(payload);
            // P0-C3: ONLY update editor selection & show green success banner when BOTH documents committed atomically
            if (res.approved && res.persistenceStatus === 'COMMITTED') {
              syncEditorToProfile(res.promptProfile);
              setSelectedCategory('PROJECT_STYLE_PROFILE');
              setFeedbackBanner(
                `작가 승인 완료: '${res.promptProfile.title}' v${res.promptProfile.currentVersionNumber} 버전이 원자적으로 저장되었습니다 (${res.applicationStatus}).`
              );
            } else {
              setFeedbackBanner(null);
            }
            return res;
          }}
          onReloadPromptProfile={onReloadPromptProfile}
          onTogglePromptActive={handleToggleActive}
          onOpenPromptInEditor={(prof) => {
            setSelectedCategory('PROJECT_STYLE_PROFILE');
            syncEditorToProfile(prof);
          }}
        />
      )}

        {/* 5 Prompt Category Filter Tabs */}
        <div className="mt-4 flex flex-wrap gap-1.5 border-t border-slate-800 pt-4">
          <button
            type="button"
            onClick={() => setSelectedCategory('ALL')}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              selectedCategory === 'ALL'
                ? 'bg-amber-500 text-slate-950 font-semibold'
                : 'border border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200'
            }`}
          >
            전체 ({promptProfiles.length})
          </button>
          {PROMPT_TEMPLATE_TYPES.map((cat) => {
            const count = promptProfiles.filter((p) => p.promptType === cat.key).length;
            return (
              <button
                key={cat.key}
                type="button"
                onClick={() => setSelectedCategory(cat.key)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  selectedCategory === cat.key
                    ? 'bg-amber-500 text-slate-950 font-semibold'
                    : 'border border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200'
                }`}
              >
                {cat.koreanLabel.split(' (')[0]} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {/* Main 12-Col Grid: Left List (4 cols) + Center Editor (5 cols) + Right Version History (3 cols) */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        {/* Left Column: Prompt Profile List */}
        <aside className="space-y-3 xl:col-span-4">
          {filteredProfiles.map((prof) => {
            const isSelected = activeProfile?.id === prof.id;
            const isCoreControlSlot =
              prof.title === 'NOVEL FORGE Master Writing Rules' ||
              prof.title === 'NOVEL FORGE — Advanced Writing Control Rules';
            return (
              <div
                key={prof.id}
                className={`rounded-xl border p-4 transition-colors ${
                  isSelected
                    ? 'border-amber-500/70 bg-slate-900'
                    : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => syncEditorToProfile(prof)}
                    className="flex-1 text-left min-w-0"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-amber-300">
                        {formatPromptTemplateTypeKorean(prof.promptType).split(' (')[0]}
                      </span>
                      <span className="font-mono-tabular text-[11px] text-slate-400">
                        {prof.versionLabel ? `v${prof.versionLabel}` : `v${prof.currentVersionNumber}`} ({prof.currentVersionId})
                      </span>
                      {isCoreControlSlot && (
                        <span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
                          <Sparkles className="h-2.5 w-2.5" />
                          Master Writing Rules
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 text-sm font-semibold text-slate-100 break-words">
                      {prof.title}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-slate-400">
                      {prof.description}
                    </p>
                  </button>

                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleToggleActive(prof)}
                      aria-label={`${prof.title} 활성화 전환`}
                      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                        prof.isActive
                          ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40'
                          : 'bg-slate-950 text-slate-500 border border-slate-800'
                      }`}
                    >
                      {prof.isActive ? (
                        <>
                          <ToggleRight className="h-3.5 w-3.5 text-emerald-400" />
                          <span>활성</span>
                        </>
                      ) : (
                        <>
                          <ToggleLeft className="h-3.5 w-3.5" />
                          <span>비활성</span>
                        </>
                      )}
                    </button>

                    {!isCoreControlSlot && (
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(prof)}
                        aria-label={`${prof.title} 프롬프트 삭제`}
                        className="rounded p-1 text-slate-500 hover:bg-rose-500/15 hover:text-rose-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </aside>

        {/* Center Column: Prompt Content Editor & File Import */}
        <section className="xl:col-span-5">
          {activeProfile ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                <div>
                  <span className="text-xs font-semibold text-amber-400">
                    {formatPromptTemplateTypeKorean(activeProfile.promptType)}
                  </span>
                  <h2 className="text-base font-bold text-slate-100">
                    {activeProfile.title}
                  </h2>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".txt,.md,.markdown"
                    onChange={handleFileImport}
                    className="hidden"
                    id="prompt-file-import-input"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 transition-colors"
                  >
                    <FileUp className="h-3.5 w-3.5 text-amber-400" />
                    <span>TXT / Markdown 파일 가져오기</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="prompt-edit-title"
                    className="block text-xs font-medium text-slate-400 mb-1"
                  >
                    프롬프트 제목
                  </label>
                  <input
                    id="prompt-edit-title"
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label
                    htmlFor="prompt-edit-char"
                    className="block text-xs font-medium text-slate-400 mb-1"
                  >
                    연결 등장인물 (선택)
                  </label>
                  <select
                    id="prompt-edit-char"
                    value={editTargetCharacterId}
                    onChange={(e) => setEditTargetCharacterId(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                  >
                    <option value="">작품 전체 공통 적용</option>
                    {characters.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.role})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label
                  htmlFor="prompt-edit-desc"
                  className="block text-xs font-medium text-slate-400 mb-1"
                >
                  프롬프트 설명 및 용도
                </label>
                <input
                  id="prompt-edit-desc"
                  type="text"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label
                    htmlFor="prompt-edit-content"
                    className="block text-xs font-medium text-slate-300"
                  >
                    프롬프트 본문 지침 (장문 텍스트 붙여넣기 지원)
                  </label>
                  <span className="font-mono-tabular text-[11px] text-slate-400">
                    {editContent.length.toLocaleString()}자
                  </span>
                </div>
                <textarea
                  id="prompt-edit-content"
                  rows={14}
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  placeholder="이곳에 집필 통제 규칙이나 문체 지침을 입력하거나 붙여넣으세요."
                  className="w-full rounded-xl border border-slate-800 bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-t border-slate-800 pt-3">
                <input
                  type="text"
                  value={editVersionLabel}
                  onChange={(e) => setEditVersionLabel(e.target.value)}
                  placeholder="버전 메모 (예: 전투 묘사 규칙 강화)"
                  className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleSaveCurrentProfile}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors whitespace-nowrap"
                >
                  <Save className="h-3.5 w-3.5" />
                  <span>프롬프트 저장 및 새 버전 기록</span>
                </button>
              </div>
            </div>
          ) : null}
        </section>

        {/* Right Column: Prompt Version History & Restoration */}
        <aside className="xl:col-span-3">
          <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-4 space-y-3">
            <div className="flex items-center gap-2 border-b border-slate-800 pb-2.5">
              <History className="h-4 w-4 text-amber-400" />
              <h3 className="text-xs font-semibold text-slate-100">
                프롬프트 버전 기록 ({activeProfile?.versions.length || 0})
              </h3>
            </div>

            {!activeProfile || activeProfile.versions.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-500">
                버전 기록이 없습니다.
              </p>
            ) : (
              <div className="max-h-[520px] space-y-2.5 overflow-y-auto pr-1">
                {activeProfile.versions.map((ver) => {
                  const isCurrent = ver.versionId === activeProfile.currentVersionId;
                  return (
                    <div
                      key={ver.versionId}
                      className={`rounded-lg border p-3 text-xs space-y-2 ${
                        isCurrent
                          ? 'border-amber-500/50 bg-amber-500/10'
                          : 'border-slate-800 bg-slate-950/70'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono-tabular font-semibold text-amber-300">
                          v{ver.versionNumber} · {ver.versionId}
                        </span>
                        {isCurrent && (
                          <span className="rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-slate-950">
                            현재 적용 버전
                          </span>
                        )}
                      </div>
                      <div className="font-medium text-slate-200">{ver.label}</div>
                      <p className="line-clamp-3 font-mono text-[11px] text-slate-400">
                        {ver.content}
                      </p>
                      <div className="flex items-center justify-between pt-1">
                        <span className="font-mono-tabular text-[10px] text-slate-500">
                          {new Date(ver.createdAt).toLocaleString('ko-KR', {
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                        {!isCurrent && (
                          <button
                            type="button"
                            onClick={() => handleRestoreVersion(ver.versionId)}
                            className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-300 hover:bg-amber-500/20"
                          >
                            <RotateCcw className="h-3 w-3" />
                            <span>이 버전으로 복원</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Create New Prompt Modal */}
      {isCreatingNew && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-prompt-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
        >
          <form
            onSubmit={handleCreateSubmit}
            className="w-full max-w-xl rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h2
                id="new-prompt-modal-title"
                className="text-base font-bold text-slate-100"
              >
                새 집필/검수 프롬프트 등록
              </h2>
              <button
                type="button"
                onClick={() => setIsCreatingNew(false)}
                className="text-xs text-slate-400 hover:text-white"
              >
                닫기
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="new-prompt-type"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  프롬프트 분류
                </label>
                <select
                  id="new-prompt-type"
                  value={newType}
                  onChange={(e) => setNewType(e.target.value as PromptTemplateType)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                >
                  {PROMPT_TEMPLATE_TYPES.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.koreanLabel}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="new-prompt-char"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  대상 등장인물 (인물 말투용 선택)
                </label>
                <select
                  id="new-prompt-char"
                  value={newTargetCharId}
                  onChange={(e) => setNewTargetCharId(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                >
                  <option value="">전체 공통</option>
                  {characters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label
                htmlFor="new-prompt-title"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                프롬프트 이름
              </label>
              <input
                id="new-prompt-title"
                type="text"
                required
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="예: 카엘 반스 전용 냉소적 단문 말투 규칙"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
              />
            </div>

            <div>
              <label
                htmlFor="new-prompt-desc"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                설명
              </label>
              <input
                id="new-prompt-desc"
                type="text"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="프롬프트 적용 목적을 간략히 적어주세요"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
              />
            </div>

            <div>
              <label
                htmlFor="new-prompt-content"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                프롬프트 지침 내용
              </label>
              <textarea
                id="new-prompt-content"
                rows={7}
                required
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder="AI 집필기 및 검수기가 준수해야 할 규칙을 입력하세요."
                className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-slate-100"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIsCreatingNew(false)}
                className="rounded-lg border border-slate-700 px-4 py-2 text-xs text-slate-300 hover:bg-slate-800"
              >
                취소
              </button>
              <button
                type="submit"
                className="rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400"
              >
                등록 완료
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Combined Active Prompts Preview Modal */}
      {showPreviewModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="preview-prompt-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
        >
          <div className="w-full max-w-3xl rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-amber-400" />
                <h2
                  id="preview-prompt-modal-title"
                  className="text-base font-bold text-slate-100"
                >
                  AI 집필 엔진 주입 프롬프트 통합 미리보기
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowPreviewModal(false)}
                className="text-xs text-slate-400 hover:text-white"
              >
                닫기
              </button>
            </div>

            <div className="max-h-[65vh] space-y-3 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-4 font-mono text-xs text-slate-200">
              {activePromptsSummary.length === 0 ? (
                <div className="text-slate-500">
                  현재 활성화된 프롬프트가 없습니다.
                </div>
              ) : (
                activePromptsSummary.map((p) => (
                  <div key={p.id} className="space-y-1 border-b border-slate-800/80 pb-3 last:border-none">
                    <div className="font-bold text-amber-400">
                      [{p.promptType}] {p.title} (적용 버전 ID: {p.currentVersionId})
                    </div>
                    <pre className="whitespace-pre-wrap text-slate-300">{p.content}</pre>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title="프롬프트 삭제 확인"
        description={
          deleteTarget
            ? `'${deleteTarget.title}' 프롬프트와 모든 버전 기록을 삭제하시겠습니까?`
            : ''
        }
        confirmLabel="영구 삭제"
        onConfirm={async () => {
          if (deleteTarget) {
            const id = deleteTarget.id;
            setDeleteTarget(null);
            await onDeletePromptProfile(id);
          }
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};
