import React, { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpenCheck,
  CheckCircle2,
  FileUp,
  GitBranch,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import type {
  AuthorSelectedStyleInstruction,
  AuthorStyleAnalysisCandidate,
  Episode,
  PromptProfile,
  Revision,
  StyleApprovalPayload,
  StyleInputMode,
  StyleProfile,
  StyleProfileApplicationResult,
} from '../types/novel';
import {
  buildDefaultSelectedStyleInstructions,
  computeStyleSourceStaleness,
  resolveStyleApplicationStatus,
  STYLE_INPUT_THRESHOLDS,
} from '../utils/authorStyleLogic';
import { computeManuscriptContentHash } from '../utils/manuscriptIntegrity';
import { calculateCharCounts } from '../utils/novelLogic';

interface AuthorStyleDnaPanelProps {
  projectId: string;
  projectTitle: string;
  ownerId: string;
  episodes: Episode[];
  revisions: Revision[];
  styleProfiles: StyleProfile[];
  stylePromptProfiles: PromptProfile[];
  getIdToken: () => Promise<string | null>;
  onApproveSaveStyleDNA: (
    payload: StyleApprovalPayload
  ) => Promise<StyleProfileApplicationResult>;
  onReloadPromptProfile?: (profileId: string) => Promise<PromptProfile | null>;
  onTogglePromptActive: (profile: PromptProfile) => Promise<void>;
  onOpenPromptInEditor: (profile: PromptProfile) => void;
}

function formatMethodLabelKo(method: string): string {
  switch (method) {
    case 'DETERMINISTIC':
      return '확정 통계 (DETERMINISTIC)';
    case 'INFERRED':
      return 'AI 추론 (INFERRED)';
    case 'INSUFFICIENT_EVIDENCE':
    default:
      return '근거 부족 (INSUFFICIENT_EVIDENCE)';
  }
}

function formatConfidenceLabelKo(confidence: string): string {
  switch (confidence) {
    case 'HIGH':
      return '신뢰도 높음 (HIGH)';
    case 'MEDIUM':
      return '신뢰도 보통 (MEDIUM)';
    case 'LOW':
      return '신뢰도 낮음 (LOW)';
    case 'INSUFFICIENT_EVIDENCE':
    default:
      return '근거 부족';
  }
}

export const AuthorStyleDnaPanel: React.FC<AuthorStyleDnaPanelProps> = ({
  projectId,
  projectTitle,
  ownerId,
  episodes,
  revisions,
  styleProfiles,
  stylePromptProfiles,
  getIdToken,
  onApproveSaveStyleDNA,
  onReloadPromptProfile,
  onTogglePromptActive,
  onOpenPromptInEditor,
}) => {
  const [inputMode, setInputMode] = useState<StyleInputMode>('AUTHOR_SUPPLIED_SAMPLE');
  const [sampleLabel, setSampleLabel] = useState<string>('직접 입력 원고 샘플');
  const [sampleText, setSampleText] = useState<string>('');
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string>(
    () => episodes[0]?.id || ''
  );

  const episodeRevisions = useMemo(() => {
    const filtered = revisions.filter((r) => r.episodeId === selectedEpisodeId);
    return [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [revisions, selectedEpisodeId]);

  const [selectedRevisionId, setSelectedRevisionId] = useState<string>('');

  const resolvedRevision = useMemo(() => {
    if (!episodeRevisions.length) return null;
    if (selectedRevisionId) {
      const found = episodeRevisions.find((r) => r.id === selectedRevisionId);
      if (found) return found;
    }
    return episodeRevisions[0];
  }, [episodeRevisions, selectedRevisionId]);

  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<AuthorStyleAnalysisCandidate | null>(null);

  // Author review & editable instructions state
  const [selectedInstructions, setSelectedInstructions] = useState<
    AuthorSelectedStyleInstruction[]
  >([]);
  const [profileTitle, setProfileTitle] = useState<string>('');
  const [targetPromptProfileId, setTargetPromptProfileId] = useState<string>('__NEW__');
  const [expectedBaseVersionId, setExpectedBaseVersionId] = useState<string | undefined>(
    undefined
  );
  const [expectedBaseVersionNumber, setExpectedBaseVersionNumber] = useState<
    number | undefined
  >(undefined);
  const [activateOnApprove, setActivateOnApprove] = useState<boolean>(true);
  const [customRuleInput, setCustomRuleInput] = useState<string>('');
  const [isSavingApproval, setIsSavingApproval] = useState<boolean>(false);
  const [approvalResult, setApprovalResult] =
    useState<StyleProfileApplicationResult | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const liveCounts = useMemo(() => {
    const txt =
      inputMode === 'AUTHOR_SUPPLIED_SAMPLE'
        ? sampleText
        : resolvedRevision?.content || '';
    return calculateCharCounts(txt);
  }, [inputMode, sampleText, resolvedRevision]);

  const handleSampleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setInputMode('AUTHOR_SUPPLIED_SAMPLE');
      setSampleText(text.slice(0, STYLE_INPUT_THRESHOLDS.MAX_SAMPLE_CHARS));
      setSampleLabel(`업로드 파일: ${file.name}`);
      setAnalysisError(null);
    } catch {
      setAnalysisError('업로드한 샘플 파일을 읽는 중 오류가 발생했습니다.');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSelectTargetProfile = (id: string) => {
    setTargetPromptProfileId(id);
    if (id === '__NEW__') {
      setExpectedBaseVersionId(undefined);
      setExpectedBaseVersionNumber(undefined);
      return;
    }
    const existing = stylePromptProfiles.find((p) => p.id === id);
    if (existing) {
      setExpectedBaseVersionId(existing.currentVersionId);
      setExpectedBaseVersionNumber(existing.currentVersionNumber);
      if (!profileTitle.trim()) {
        setProfileTitle(existing.title);
      }
    }
  };

  const handleRunStyleAnalysis = async () => {
    if (isAnalyzing) return;
    setAnalysisError(null);
    setApprovalResult(null);

    if (inputMode === 'AUTHOR_SUPPLIED_SAMPLE' && !sampleText.trim()) {
      setAnalysisError(
        '분석할 원고 샘플을 입력하거나 .txt/.md 파일을 업로드해 주세요.'
      );
      return;
    }
    if (inputMode === 'SAVED_REVISION' && (!selectedEpisodeId || !resolvedRevision)) {
      setAnalysisError(
        '저장된 회차의 커밋된 리비전이 선택되지 않았습니다. 먼저 회차 원고에서 리비전을 저장하거나 직접 입력 모드를 사용하세요.'
      );
      return;
    }

    setIsAnalyzing(true);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      const token = await getIdToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const selectedEp = episodes.find((ep) => ep.id === selectedEpisodeId);
      const bodyPayload =
        inputMode === 'AUTHOR_SUPPLIED_SAMPLE'
          ? {
              ownerId,
              projectId,
              inputMode,
              sampleText,
              sampleLabel,
              useGeminiStage2: true,
              allowDeterministicFallbackWithoutApiKey: true,
            }
          : {
              ownerId,
              projectId,
              inputMode,
              episodeId: selectedEpisodeId,
              revisionId: resolvedRevision!.id,
              sampleText: resolvedRevision!.content,
              sampleLabel: `${selectedEp?.title || resolvedRevision!.episodeTitle} (${resolvedRevision!.label})`,
              expectedContentHash: computeManuscriptContentHash(resolvedRevision!.content),
              useGeminiStage2: true,
              allowDeterministicFallbackWithoutApiKey: true,
            };

      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => abortController.abort(), 20000);
      let res: Response;
      try {
        res = await fetch('/api/ai/analyze-style', {
          method: 'POST',
          headers,
          body: JSON.stringify(bodyPayload),
          signal: abortController.signal,
        });
      } finally {
        clearTimeout(timeoutHandle);
      }
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        candidate?: AuthorStyleAnalysisCandidate;
        error?: string;
      };

      if (!res.ok || !data.candidate) {
        throw new Error(data.error || '작가 문체 DNA 분석 요청에 실패했습니다.');
      }

      setCandidate(data.candidate);
      setSelectedInstructions(buildDefaultSelectedStyleInstructions(data.candidate));
      setProfileTitle(data.candidate.suggestedProfileTitle);

      // Default to updating the first existing PROJECT_STYLE_PROFILE if one exists, keeping base version locked for conflict safety
      if (stylePromptProfiles.length > 0) {
        const first = stylePromptProfiles[0];
        setTargetPromptProfileId(first.id);
        setExpectedBaseVersionId(first.currentVersionId);
        setExpectedBaseVersionNumber(first.currentVersionNumber);
      } else {
        setTargetPromptProfileId('__NEW__');
        setExpectedBaseVersionId(undefined);
        setExpectedBaseVersionNumber(undefined);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setAnalysisError(
          '문체 DNA 분석 요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.'
        );
      } else {
        setAnalysisError(
          err instanceof Error
            ? err.message
            : '문체 DNA 분석 중 통신 오류가 발생했습니다.'
        );
      }
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleToggleInstruction = (id: string) => {
    setSelectedInstructions((prev) =>
      prev.map((item) => (item.id === id ? { ...item, enabled: !item.enabled } : item))
    );
  };

  const handleEditInstructionText = (id: string, nextText: string) => {
    setSelectedInstructions((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, text: nextText, editedByAuthor: true } : item
      )
    );
  };

  const handleAddCustomInstruction = () => {
    const trimmed = customRuleInput.trim();
    if (!trimmed) return;
    setSelectedInstructions((prev) => [
      ...prev,
      {
        id: `custom_${Date.now()}`,
        dimensionId: 'CUSTOM',
        text: trimmed,
        enabled: true,
        editedByAuthor: true,
      },
    ]);
    setCustomRuleInput('');
  };

  const submitStyleApproval = async (options?: {
    forceCreateNewBranch?: boolean;
  }) => {
    if (!candidate || isSavingApproval) return;
    const enabledCount = selectedInstructions.filter(
      (i) => i.enabled && i.text.trim().length > 0
    ).length;
    if (enabledCount === 0) {
      setAnalysisError(
        '승인할 문체 지침을 최소 1개 이상 선택하거나 입력해 주세요.'
      );
      return;
    }

    const createAsBranch = Boolean(options?.forceCreateNewBranch);
    const resolvedTitle = createAsBranch
      ? `${(profileTitle.trim() || candidate.suggestedProfileTitle).replace(/\s*\(분기\)$/, '')} (분기)`
      : profileTitle.trim() || candidate.suggestedProfileTitle;

    setIsSavingApproval(true);
    setAnalysisError(null);
    try {
      const result = await onApproveSaveStyleDNA({
        ownerId,
        projectId,
        candidate,
        profileTitle: resolvedTitle,
        selectedInstructions,
        existingStyleProfileId: styleProfiles[0]?.id,
        targetPromptProfileId:
          !createAsBranch && targetPromptProfileId !== '__NEW__'
            ? targetPromptProfileId
            : undefined,
        expectedBaseVersionId: createAsBranch ? undefined : expectedBaseVersionId,
        expectedBaseVersionNumber: createAsBranch
          ? undefined
          : expectedBaseVersionNumber,
        createNewProfileInsteadOfOverwrite:
          createAsBranch || targetPromptProfileId === '__NEW__',
        allowAutoBranchOnConflict: false,
        activateOnApprove,
      });
      setApprovalResult(result);

      // P0-C3: ONLY update targetPromptProfileId & base version pointers when BOTH docs committed atomically!
      if (result.approved && result.persistenceStatus === 'COMMITTED') {
        if (createAsBranch) {
          setProfileTitle(resolvedTitle);
        }
        setTargetPromptProfileId(result.promptProfile.id);
        setExpectedBaseVersionId(result.promptProfile.currentVersionId);
        setExpectedBaseVersionNumber(result.promptProfile.currentVersionNumber);
      }
    } catch (err) {
      setApprovalResult(null);
      setAnalysisError(
        err instanceof Error
          ? err.message
          : '승인된 문체 프로필 저장 중 오류가 발생했습니다.'
      );
    } finally {
      setIsSavingApproval(false);
    }
  };

  const handleApproveAndSave = async () => {
    await submitStyleApproval({ forceCreateNewBranch: false });
  };

  const handleReloadLatestProfileOnConflict = async () => {
    const targetId =
      targetPromptProfileId !== '__NEW__'
        ? targetPromptProfileId
        : approvalResult?.conflictDetails?.remotePromptProfile?.id;
    const remote =
      (targetId &&
        onReloadPromptProfile &&
        (await onReloadPromptProfile(targetId))) ||
      approvalResult?.conflictDetails?.remotePromptProfile ||
      (targetId
        ? stylePromptProfiles.find((p) => p.id === targetId) || null
        : null);

    if (remote) {
      setTargetPromptProfileId(remote.id);
      setExpectedBaseVersionId(remote.currentVersionId);
      setExpectedBaseVersionNumber(remote.currentVersionNumber);
      setApprovalResult(null);
      setAnalysisError(null);
    }
  };

  const handleBranchSaveOnConflict = async () => {
    await submitStyleApproval({ forceCreateNewBranch: true });
  };

  const enabledInstructionsCount = selectedInstructions.filter(
    (i) => i.enabled && i.text.trim().length > 0
  ).length;

  return (
    <section
      aria-labelledby="author-style-dna-heading"
      data-testid="author-style-dna-panel"
      className="rounded-xl border border-slate-800 bg-slate-900/90 p-5 space-y-5"
    >
      {/* Panel Header */}
      <div className="flex flex-col gap-3 border-b border-slate-800 pb-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-400" />
            <h2
              id="author-style-dna-heading"
              className="text-base font-bold text-slate-100"
            >
              작가 문체 DNA 분석기 (Author Style DNA)
            </h2>
            <span className="text-xs text-slate-400">
              적용 범위: 현재 작품 ({projectTitle})
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-400 leading-relaxed">
            작가가 제공한 원고 샘플 또는 저장된 리비전에서 10대 문체 차원(S1~S10)을 추출합니다. 분석 결과는{' '}
            <strong className="text-slate-200">절대 자동 적용되지 않으며</strong>, 작가가 항목을 검수·수정한 뒤 승인할 때만{' '}
            <span className="font-mono text-amber-300">PROJECT_STYLE_PROFILE</span> 버전으로 기록됩니다.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0 text-xs text-slate-400 tabular-nums">
          <span>등록된 문체 프로필 {stylePromptProfiles.length}개</span>
          <span aria-hidden="true">·</span>
          <span>
            활성 {stylePromptProfiles.filter((p) => p.isActive).length}개
          </span>
        </div>
      </div>

      {/* Approved Project Style Profiles Status Strip */}
      {stylePromptProfiles.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold text-slate-300">
            작품 문체 적용 상태 (CANON 설정 상태와 별도 관리)
          </div>
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
            {stylePromptProfiles.map((prof) => {
              const matchingEpisode = episodes.find((ep) =>
                prof.content.includes(`episodeId=${ep.id}`)
              );
              const staleness = computeStyleSourceStaleness({
                promptProfile: prof,
                currentSourceContent: matchingEpisode?.content,
                currentRevisionId: matchingEpisode?.latestRevisionId,
              });
              const appStatus = resolveStyleApplicationStatus({
                promptProfile: prof,
                staleness,
              });

              return (
                <div
                  key={prof.id}
                  data-testid={`style-prompt-status-${prof.id}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/90 px-3.5 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-semibold text-slate-100 truncate">
                        {prof.title}
                      </span>
                      <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                        v{prof.currentVersionNumber} ({prof.currentVersionId})
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                      <span
                        className={
                          appStatus === 'ACTIVE'
                            ? 'font-semibold text-emerald-400'
                            : appStatus === 'STALE_SOURCE'
                            ? 'font-semibold text-amber-400'
                            : 'font-semibold text-slate-400'
                        }
                      >
                        상태: {appStatus === 'ACTIVE'
                          ? '적용 중 (ACTIVE)'
                          : appStatus === 'STALE_SOURCE'
                          ? '원본 변경됨 (STALE_SOURCE)'
                          : '비활성 (INACTIVE)'}
                      </span>
                      {staleness.isStale && (
                        <span className="text-amber-300">
                          · 회차 수정 후 재분석 권장
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => onTogglePromptActive(prof)}
                      aria-label={`${prof.title} 문체 적용 ${prof.isActive ? '비활성화' : '활성화'}`}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 hover:bg-slate-800 whitespace-nowrap shrink-0"
                    >
                      {prof.isActive ? (
                        <>
                          <ToggleRight className="h-3.5 w-3.5 text-emerald-400" />
                          <span>활성</span>
                        </>
                      ) : (
                        <>
                          <ToggleLeft className="h-3.5 w-3.5 text-slate-400" />
                          <span>비활성</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenPromptInEditor(prof)}
                      className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-[11px] text-amber-300 hover:bg-slate-800 whitespace-nowrap shrink-0"
                    >
                      편집기
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Input Source Selector + Execution */}
      <div className="rounded-lg border border-slate-800 bg-slate-950/75 p-4 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div
            role="tablist"
            aria-label="문체 분석 입력 소스 선택"
            className="inline-flex rounded-lg border border-slate-800 bg-slate-900 p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={inputMode === 'AUTHOR_SUPPLIED_SAMPLE'}
              onClick={() => setInputMode('AUTHOR_SUPPLIED_SAMPLE')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                inputMode === 'AUTHOR_SUPPLIED_SAMPLE'
                  ? 'bg-amber-500 text-slate-950 font-semibold'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              작가 샘플 직접 입력
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={inputMode === 'SAVED_REVISION'}
              onClick={() => setInputMode('SAVED_REVISION')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                inputMode === 'SAVED_REVISION'
                  ? 'bg-amber-500 text-slate-950 font-semibold'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              저장된 회차/리비전 선택
            </button>
          </div>

          <div className="flex items-center gap-3 text-xs text-slate-400 tabular-nums">
            <span>
              분석 대상: 공백 제외{' '}
              <strong
                className={
                  liveCounts.withoutSpaces > 0 &&
                  liveCounts.withoutSpaces < STYLE_INPUT_THRESHOLDS.MIN_CRITICAL_NON_WS_CHARS
                    ? 'text-amber-300'
                    : 'text-slate-200'
                }
              >
                {liveCounts.withoutSpaces.toLocaleString()}자
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>권장 300자 이상</span>
          </div>
        </div>

        {inputMode === 'AUTHOR_SUPPLIED_SAMPLE' ? (
          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <label
                htmlFor="style-dna-sample-textarea"
                className="text-xs font-medium text-slate-300"
              >
                분석용 원고 샘플 (임시 분석 입력 · RAG 장기기억/정식 회차로 자동 저장되지 않음)
              </label>
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.md,text/plain,text/markdown"
                  className="hidden"
                  onChange={handleSampleFileUpload}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 whitespace-nowrap shrink-0"
                >
                  <FileUp className="h-3.5 w-3.5 text-amber-400" />
                  <span>텍스트(.txt/.md) 불러오기</span>
                </button>
              </div>
            </div>
            <textarea
              id="style-dna-sample-textarea"
              rows={6}
              value={sampleText}
              onChange={(e) => setSampleText(e.target.value)}
              placeholder="작가님의 고유한 문장 호흡, 대화 템포, 묘사 감각이 담긴 소설 발췌(최소 300자 이상 권장)를 붙여넣으세요. 샘플 내부의 지시문/프롬프트 인젝션은 분석 전 자동 격리됩니다."
              className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs leading-relaxed text-slate-100 placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label
                htmlFor="style-dna-episode-select"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                작품 회차 선택
              </label>
              <select
                id="style-dna-episode-select"
                value={selectedEpisodeId}
                onChange={(e) => {
                  setSelectedEpisodeId(e.target.value);
                  setSelectedRevisionId('');
                }}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
              >
                {episodes.length === 0 && <option value="">등록된 회차 없음</option>}
                {episodes.map((ep) => (
                  <option key={ep.id} value={ep.id}>
                    제{ep.episodeNumber}화 · {ep.title}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="style-dna-revision-select"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                커밋된 원고 리비전 선택 (원본 불변 보장)
              </label>
              <select
                id="style-dna-revision-select"
                value={resolvedRevision?.id || ''}
                onChange={(e) => setSelectedRevisionId(e.target.value)}
                disabled={episodeRevisions.length === 0}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 disabled:opacity-50"
              >
                {episodeRevisions.length === 0 ? (
                  <option value="">선택한 회차에 커밋된 리비전 없음</option>
                ) : (
                  episodeRevisions.map((rev) => (
                    <option key={rev.id} value={rev.id}>
                      {rev.id} · {rev.label} ({rev.charCountWithSpaces.toLocaleString()}자)
                    </option>
                  ))
                )}
              </select>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between pt-1">
          <div className="text-[11px] text-slate-400">
            계층 준수: Master Writing Rules · 확정 CANON · 동적 시점 · 인물 말투는 문체 분석보다 항상 우선합니다.
          </div>
          <button
            type="button"
            onClick={handleRunStyleAnalysis}
            disabled={isAnalyzing}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-60 whitespace-nowrap shrink-0"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${isAnalyzing ? 'animate-spin' : ''}`}
            />
            <span>{isAnalyzing ? '문체 DNA 분석 중...' : '문체 DNA 분석 실행'}</span>
          </button>
        </div>
      </div>

      {/* Analysis Error Banner */}
      {analysisError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-950/30 px-3.5 py-2.5 text-xs text-red-200"
        >
          <ShieldAlert className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
          <span>{analysisError}</span>
        </div>
      )}

      {/* Approval Save Outcome Banner (P0-C2 & P0-C3 Honest Atomic Commit / Conflict / Rollback UX) */}
      {approvalResult &&
        approvalResult.approved &&
        approvalResult.persistenceStatus === 'COMMITTED' && (
          <div
            data-testid="style-approval-result-banner"
            className="flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-950/30 px-3.5 py-3 text-xs text-emerald-100"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-emerald-400" />
            <div className="space-y-1">
              <div className="font-semibold">
                작가 승인 완료: '{approvalResult.promptProfile.title}' v
                {approvalResult.promptProfile.currentVersionNumber} (상태:{' '}
                {approvalResult.applicationStatus})
              </div>
              <div className="text-[11px] opacity-90">
                StyleProfile 저장: 완료 · PROJECT_STYLE_PROFILE 저장: 완료 · 저장소:{' '}
                <span className="font-mono">
                  {approvalResult.storageMode || 'CLOUD_FIRESTORE'}
                </span>{' '}
                · 출처 해시:{' '}
                <span className="font-mono">{approvalResult.sourceHash}</span>
                {approvalResult.deduplicated && ' · (중복 요청 멱등 처리됨)'}
              </div>
            </div>
          </div>
        )}

      {approvalResult &&
        approvalResult.persistenceStatus === 'VERSION_CONFLICT' && (
          <div
            role="alert"
            data-testid="style-version-conflict-panel"
            className="rounded-lg border border-amber-500/50 bg-amber-950/30 p-3.5 space-y-2.5 text-xs text-amber-100"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-400" />
              <div className="space-y-1">
                <div className="font-semibold text-amber-200">
                  문체 프로필 버전 충돌 감지 (VERSION_CONFLICT) — 기존 버전 보호를 위해 자동 덮어쓰기가 차단되었습니다
                </div>
                <div className="text-[11px] text-amber-200/90">
                  {approvalResult.errorMessage ||
                    `검토 기준 버전(v${approvalResult.conflictDetails?.expectedVersionNumber ?? '?'} · ${approvalResult.conflictDetails?.expectedVersionId ?? '?'})과 원격 최신 버전(v${approvalResult.conflictDetails?.actualVersionNumber ?? '?'} · ${approvalResult.conflictDetails?.actualVersionId ?? '?'})이 다릅니다. 현재 편집한 문체 지침은 그대로 보존되어 있습니다.`}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 pl-6">
              <button
                type="button"
                onClick={handleReloadLatestProfileOnConflict}
                disabled={isSavingApproval}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/50 bg-slate-950 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-slate-900"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>최신 프로필 다시 불러오기</span>
              </button>
              <button
                type="button"
                onClick={handleBranchSaveOnConflict}
                disabled={isSavingApproval}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400"
              >
                <GitBranch className="h-3.5 w-3.5" />
                <span>현재 수정안을 새 프로필로 분기 저장</span>
              </button>
              <button
                type="button"
                onClick={() => setApprovalResult(null)}
                disabled={isSavingApproval}
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-300 hover:text-white"
              >
                취소
              </button>
            </div>
          </div>
        )}

      {approvalResult &&
        !approvalResult.approved &&
        approvalResult.persistenceStatus !== 'VERSION_CONFLICT' && (
          <div
            role="alert"
            data-testid="style-approval-error-banner"
            className="flex items-start justify-between gap-2 rounded-lg border border-red-500/40 bg-red-950/30 px-3.5 py-3 text-xs text-red-200"
          >
            <div className="flex items-start gap-2">
              <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-red-400" />
              <div className="space-y-1">
                <div className="font-semibold">
                  문체 프로필 원자적 저장 실패 ({approvalResult.persistenceStatus}) — 부분 저장 없이 롤백되었습니다
                </div>
                <div className="text-[11px] opacity-90">
                  {approvalResult.errorMessage ||
                    approvalResult.partialFailureWarning ||
                    'StyleProfile과 PROJECT_STYLE_PROFILE 중 하나 이상이 커밋되지 않아 트랜잭션 전체가 취소되었습니다. 편집 중인 지침은 보존되어 있으므로 다시 시도할 수 있습니다.'}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setApprovalResult(null)}
              className="text-red-300 hover:text-white shrink-0"
            >
              닫기
            </button>
          </div>
        )}

      {/* Candidate Review & Explicit Approval Drawer */}
      {candidate && (
        <div
          data-testid="style-candidate-review-section"
          className="rounded-xl border border-amber-500/40 bg-slate-950/90 p-5 space-y-5"
        >
          {/* Candidate Status & Warnings */}
          <div className="flex flex-col gap-2 border-b border-slate-800 pb-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <BookOpenCheck className="h-4 w-4 text-amber-400" />
                <h3 className="text-sm font-bold text-slate-100">
                  문체 DNA 분석 후보 검토 ({candidate.analysisStatus})
                </h3>
                <span className="font-mono text-[11px] text-amber-300">
                  자동 적용 안 됨 · 작가 승인 대기
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                실행 모드: {candidate.executionMode} ({candidate.modelId}) · 출처 해시:{' '}
                <span className="font-mono text-slate-300">
                  {candidate.sourceReference.contentHash}
                </span>
              </p>
            </div>
            <div className="text-xs text-slate-300 tabular-nums">
              선택된 지침 {enabledInstructionsCount} / {selectedInstructions.length}건
            </div>
          </div>

          {candidate.warnings.length > 0 && (
            <div className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              {candidate.warnings.map((w, idx) => (
                <div key={idx} className="flex items-start gap-2 text-xs text-amber-200">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-400" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          {/* Quantitative Telemetry Strip */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
            <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-2.5">
              <div className="text-[11px] text-slate-400">평균 문장 길이</div>
              <div className="mt-0.5 font-mono text-sm font-bold text-slate-100 tabular-nums">
                {candidate.metrics.avgSentenceLengthChars}자
              </div>
              <div className="text-[11px] text-slate-400 tabular-nums">
                표준편차 {candidate.metrics.sentenceLengthStdDev}
              </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-2.5">
              <div className="text-[11px] text-slate-400">단문 / 중문 / 장문</div>
              <div className="mt-0.5 font-mono text-sm font-bold text-slate-100 tabular-nums">
                {Math.round(candidate.metrics.shortSentenceRatio * 100)}% /{' '}
                {Math.round(candidate.metrics.mediumSentenceRatio * 100)}% /{' '}
                {Math.round(candidate.metrics.longSentenceRatio * 100)}%
              </div>
              <div className="text-[11px] text-slate-400 tabular-nums">
                장단 교차 {Math.round(candidate.metrics.shortLongAlternationRatio * 100)}%
              </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-2.5">
              <div className="text-[11px] text-slate-400">대사 비중</div>
              <div className="mt-0.5 font-mono text-sm font-bold text-slate-100 tabular-nums">
                {candidate.metrics.dialogueRatioPercent}%
              </div>
              <div className="text-[11px] text-slate-400 tabular-nums">
                {candidate.metrics.dialogueCount}줄 · 평균{' '}
                {candidate.metrics.avgDialogueLengthChars}자
              </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-2.5">
              <div className="text-[11px] text-slate-400">문단 호흡</div>
              <div className="mt-0.5 font-mono text-sm font-bold text-slate-100 tabular-nums">
                {candidate.metrics.avgSentencesPerParagraph}문장/문단
              </div>
              <div className="text-[11px] text-slate-400 tabular-nums">
                단일 문장 문단 {Math.round(candidate.metrics.singleSentenceParagraphRatio * 100)}%
              </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-2.5">
              <div className="text-[11px] text-slate-400">감각 단서 분포</div>
              <div className="mt-0.5 font-mono text-sm font-bold text-slate-100 tabular-nums">
                총 {candidate.metrics.sensoryCategoryCounts.total}회
              </div>
              <div className="text-[11px] text-slate-400 tabular-nums">
                시{candidate.metrics.sensoryCategoryCounts.visual}/청
                {candidate.metrics.sensoryCategoryCounts.auditory}/촉온
                {candidate.metrics.sensoryCategoryCounts.tactile +
                  candidate.metrics.sensoryCategoryCounts.temperature}
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-xs text-slate-300 leading-relaxed">
            <strong className="text-amber-300">종합 요약:</strong>{' '}
            {candidate.overallSummary}
          </div>

          {/* S1–S10 Findings Review & Editable Instruction Selection */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-bold text-slate-200">
                10대 문체 차원(S1~S10) 분석 및 반영 지침 선택·편집
              </h4>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setSelectedInstructions((prev) =>
                      prev.map((i) => ({ ...i, enabled: true }))
                    )
                  }
                  className="text-[11px] text-amber-300 hover:underline"
                >
                  전체 선택
                </button>
                <span className="text-slate-600">·</span>
                <button
                  type="button"
                  onClick={() =>
                    setSelectedInstructions((prev) =>
                      prev.map((i) => ({ ...i, enabled: false }))
                    )
                  }
                  className="text-[11px] text-slate-400 hover:underline"
                >
                  전체 해제
                </button>
              </div>
            </div>

            <div className="space-y-2.5 max-h-[520px] overflow-y-auto pr-1">
              {candidate.findings.map((finding) => {
                const inst = selectedInstructions.find(
                  (s) => s.dimensionId === finding.dimensionId
                );
                if (!inst) return null;

                return (
                  <div
                    key={finding.dimensionId}
                    data-testid={`style-finding-${finding.dimensionId}`}
                    className={`rounded-lg border p-3.5 space-y-2 ${
                      inst.enabled
                        ? 'border-amber-500/40 bg-slate-900/90'
                        : 'border-slate-800 bg-slate-900/40 opacity-80'
                    }`}
                  >
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <label className="flex items-center gap-2.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={inst.enabled}
                          onChange={() => handleToggleInstruction(inst.id)}
                          className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-amber-500 focus:ring-amber-500"
                        />
                        <span className="text-xs font-bold text-slate-100">
                          {finding.dimensionId}. {finding.titleKo}
                        </span>
                      </label>
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                        <span>{formatMethodLabelKo(finding.measurementMethod)}</span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={
                            finding.confidence === 'HIGH'
                              ? 'text-emerald-400'
                              : finding.confidence === 'INSUFFICIENT_EVIDENCE'
                              ? 'text-amber-300'
                              : 'text-slate-300'
                          }
                        >
                          {formatConfidenceLabelKo(finding.confidence)}
                        </span>
                      </div>
                    </div>

                    <div className="text-[11px] font-mono text-slate-400 tabular-nums">
                      {finding.deterministicSignalSummary}
                    </div>
                    <p className="text-xs text-slate-300 leading-relaxed">
                      {finding.observedTrait}
                    </p>

                    {finding.evidenceReferences.length > 0 && (
                      <div className="rounded border border-slate-800 bg-slate-950/80 px-2.5 py-2 text-[11px] text-slate-400">
                        <span className="font-semibold text-slate-300">검증된 원문 근거:</span>{' '}
                        {finding.evidenceReferences.map((ev, idx) => (
                          <span key={idx} className="italic text-slate-300">
                            “{ev.excerpt}” ({ev.startOffset}~{ev.endOffset}자)
                            {idx < finding.evidenceReferences.length - 1 ? ' / ' : ''}
                          </span>
                        ))}
                      </div>
                    )}

                    <div>
                      <label
                        htmlFor={`style-rule-input-${finding.dimensionId}`}
                        className="block text-[11px] text-slate-400 mb-1"
                      >
                        작품 프롬프트 반영 규칙 (직접 편집 가능)
                      </label>
                      <input
                        id={`style-rule-input-${finding.dimensionId}`}
                        type="text"
                        value={inst.text}
                        onChange={(e) =>
                          handleEditInstructionText(inst.id, e.target.value)
                        }
                        className="w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                      />
                    </div>
                  </div>
                );
              })}

              {/* Custom Author-Added Style Instructions */}
              {selectedInstructions
                .filter((i) => i.dimensionId === 'CUSTOM')
                .map((customInst) => (
                  <div
                    key={customInst.id}
                    className="rounded-lg border border-amber-500/40 bg-slate-900/90 p-3 space-y-2"
                  >
                    <label className="flex items-center gap-2.5 text-xs font-bold text-amber-300">
                      <input
                        type="checkbox"
                        checked={customInst.enabled}
                        onChange={() => handleToggleInstruction(customInst.id)}
                        className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-amber-500"
                      />
                      <span>작가 추가 규칙</span>
                    </label>
                    <input
                      type="text"
                      value={customInst.text}
                      onChange={(e) =>
                        handleEditInstructionText(customInst.id, e.target.value)
                      }
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100"
                    />
                  </div>
                ))}
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                aria-label="사용자 정의 문체 규칙 추가"
                value={customRuleInput}
                onChange={(e) => setCustomRuleInput(e.target.value)}
                placeholder="추가하고 싶은 작가 고유 문체 지침을 입력하세요..."
                className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
              />
              <button
                type="button"
                onClick={handleAddCustomInstruction}
                className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>규칙 추가</span>
              </button>
            </div>
          </div>

          {/* Approval Target, Conflict Safety & Submit */}
          <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-4 space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label
                  htmlFor="style-approval-title"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  저장할 문체 프로필 이름
                </label>
                <input
                  id="style-approval-title"
                  type="text"
                  value={profileTitle}
                  onChange={(e) => setProfileTitle(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                />
              </div>

              <div>
                <label
                  htmlFor="style-approval-target-select"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  버전 저장 대상 (기존 프로필 덮어쓰기 방지)
                </label>
                <select
                  id="style-approval-target-select"
                  value={targetPromptProfileId}
                  onChange={(e) => handleSelectTargetProfile(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                >
                  <option value="__NEW__">+ 새 작품 문체 프로필(PROJECT_STYLE_PROFILE)로 생성</option>
                  {stylePromptProfiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      기존 프로필 새 버전 추가: {p.title} (현재 v{p.currentVersionNumber})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between pt-1">
              <label className="inline-flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={activateOnApprove}
                  onChange={(e) => setActivateOnApprove(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-amber-500"
                />
                <span>승인 즉시 AI 집필·리라이팅 엔진에 활성화 (ACTIVE)</span>
              </label>

              <button
                type="button"
                onClick={handleApproveAndSave}
                disabled={isSavingApproval}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-60 whitespace-nowrap shrink-0"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>
                  {isSavingApproval
                    ? '프로필 버전 저장 중...'
                    : '작가 승인 및 문체 프로필 버전 생성'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
