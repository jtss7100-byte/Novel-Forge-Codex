import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookCheck,
  Check,
  CheckCircle2,
  FileCheck2,
  Flame,
  Layers,
  ListChecks,
  Loader2,
  MessageSquarePlus,
  Play,
  RefreshCw,
  ShieldAlert,
  Sliders,
  Sparkles,
  Square,
  Wand2,
  X,
} from 'lucide-react';
import type {
  ChangeProposal,
  Character,
  EngineWorkflowState,
  Episode,
  ExpansionActionType,
  IndependentAuditState,
  LiteraryQualityDecision,
  LiteraryQualityEvaluationResponse,
  LiteraryQualityReport,
  ManuscriptCanonClassification,
  ManuscriptExecutionState,
  MemoryCuratorReport,
  NarrativePerspective,
  NovelForgeAppResult,
  OneTimeExceptionRecord,
  Project,
  PromptProfile,
  ScenePlanItem,
  TokenUsageMetadata,
  WorldbuildingItem,
  WritingIssue,
  WritingMode,
  WritingPlan,
  WritingResult,
} from '../types/novel';
import type {
  CanonEvidenceReport,
  LiteraryQualityFinding,
  LiteraryQualityDimensionId,
  PersistChangeProposalsOptions,
  PersistChangeProposalsResult,
  RewriteAcceptPersistenceState,
  RewriteSelectionAnchor,
  LiteraryRewriteCandidate,
  LiteraryRewriteMode,
  LiteraryRewriteResponse,
  PromptProfileCasResult,
} from '../types/novel';
import { computeStylePromptSelectionSync } from '../utils/authorStyleLogic';
import {
  formatProposalPersistenceErrorSummaryKo,
  type EpisodeRevisionCommitResult,
} from '../services/novelRepository';
import {
  AI_ENGINE_DEFAULTS,
  applyApprovedIssuesToManuscript,
  assembleNovelForgeAppResult,
  buildWritingContext,
  createInitialAuditState,
  evaluateManuscriptLength,
  markMasterRulesVersionUsed,
  validateConflictResolutionApproval,
} from '../utils/aiEngineLogic';
import {
  computeManuscriptContentHash,
  createRewriteSelectionAnchor,
  validateAndSpliceRewriteSelection,
  validateRewriteSelectionTarget,
} from '../utils/manuscriptIntegrity';
import {
  computeStableIdempotencyHash,
  LITERARY_REWRITE_MODE_ORDER,
  LITERARY_REWRITE_MODES,
  rebindProposalsToCommittedRevision,
  recommendRewriteModesForQualityDimension,
  validateRewriteCandidateBeforeApply,
} from '../utils/literaryRewritingLogic';
import { generateEntityId } from '../utils/novelLogic';
import { LiteraryQualityPanel } from './LiteraryQualityPanel';
import { NovelWritingEvaluationPanel } from './NovelWritingEvaluationPanel';
import type { VoiceRewriteSelection } from './CharacterVoicePanel';

interface AiWritingPanelProps {
  voiceRewriteSelection?: VoiceRewriteSelection | null;
  project: Project;
  episode: Episode;
  allEpisodes: Episode[];
  characters: Character[];
  worldbuilding: WorldbuildingItem[];
  promptProfiles: PromptProfile[];
  existingPlans: WritingPlan[];
  changeProposals: ChangeProposal[];
  currentEditorContent: string;
  currentRevisionId?: string;
  editorSelection?: {
    startOffset: number;
    endOffset: number;
    excerpt: string;
  } | null;
  onApplyManuscriptToEditor: (
    newContent: string,
    options: {
      createBackupRevisionFirst: boolean;
      revisionLabel: string;
      markConfirmed?: boolean;
      updatedSynopsis?: string;
    }
  ) => Promise<EpisodeRevisionCommitResult | void>;
  onSaveWritingPlan: (plan: WritingPlan) => Promise<void>;
  onSaveChangeProposals: (
    proposals: ChangeProposal[],
    options?: PersistChangeProposalsOptions
  ) => Promise<PersistChangeProposalsResult | void>;
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
  ) => Promise<PromptProfileCasResult | void>;
  onOpenPromptManager: () => void;
  onOpenProposalReview?: (proposalId?: string) => void;
  getIdToken: () => Promise<string | null>;
}

const WORKFLOW_STATE_LABELS: Record<
  EngineWorkflowState,
  { label: string; badgeClass: string }
> = {
  IDLE: {
    label: '대기',
    badgeClass: 'border-slate-700 bg-slate-900 text-slate-300',
  },
  PLANNING: {
    label: '장면 기획 중...',
    badgeClass: 'border-amber-500/50 bg-amber-500/15 text-amber-300',
  },
  AWAITING_PLAN_APPROVAL: {
    label: '기획 승인 대기',
    badgeClass: 'border-amber-500/60 bg-amber-500/20 text-amber-200',
  },
  WRITING_SCENE: {
    label: '장면 집필 중...',
    badgeClass: 'border-sky-500/50 bg-sky-500/15 text-sky-300',
  },
  BLOCKED_CONFLICT: {
    label: '보류: 확정 설정 충돌 (BLOCKED_CONFLICT)',
    badgeClass: 'border-rose-500/70 bg-rose-500/20 text-rose-200',
  },
  BLOCKED_MISSING_INFO: {
    label: '보류: 핵심 정보 누락 (BLOCKED_MISSING_INFO)',
    badgeClass: 'border-amber-500/70 bg-amber-500/20 text-amber-200',
  },
  DRAFT_READY: {
    label: '초안 생성 완료 (DRAFT_READY)',
    badgeClass: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300',
  },
  ABORTED: {
    label: '생성 중단됨',
    badgeClass: 'border-rose-500/50 bg-rose-500/15 text-rose-300',
  },
  REVIEWING: {
    label: '독립 검수 실행 중...',
    badgeClass: 'border-purple-500/50 bg-purple-500/15 text-purple-300',
  },
  REVIEW_REQUIRED: {
    label: '검수 수정 필요 (REVIEW_REQUIRED)',
    badgeClass: 'border-amber-500/60 bg-amber-500/20 text-amber-200',
  },
  AWAITING_REVISION_APPROVAL: {
    label: '수정안 승인 대기',
    badgeClass: 'border-amber-500/50 bg-amber-500/15 text-amber-300',
  },
  AUDIT_FAILED: {
    label: '독립 검수 실패 (AUDIT_FAILED · 초안 보존됨)',
    badgeClass: 'border-rose-500/60 bg-rose-500/20 text-rose-200',
  },
  APPROVED: {
    label: '최종 승인됨 (APPROVED)',
    badgeClass: 'border-emerald-500/60 bg-emerald-500/20 text-emerald-200',
  },
  SAVING: {
    label: '저장 중...',
    badgeClass: 'border-amber-500/50 bg-amber-500/15 text-amber-300',
  },
  SAVED: {
    label: '저장 완료',
    badgeClass: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300',
  },
  ERROR: {
    label: '오류 발생',
    badgeClass: 'border-rose-500/60 bg-rose-500/20 text-rose-200',
  },
};

export const AiWritingPanel: React.FC<AiWritingPanelProps> = ({
  voiceRewriteSelection,
  project,
  episode,
  allEpisodes,
  characters,
  worldbuilding,
  promptProfiles,
  existingPlans,
  changeProposals,
  currentEditorContent,
  currentRevisionId,
  editorSelection,
  onApplyManuscriptToEditor,
  onSaveWritingPlan,
  onSaveChangeProposals,
  onUpdateChangeProposalStatus,
  onUpdatePromptProfile,
  onOpenPromptManager,
  onOpenProposalReview,
  getIdToken,
}) => {
  // Step 1: Writing Request State (Rule 1: Default POV is FIRST_PERSON, configurable per project)
  const [writingMode, setWritingMode] = useState<WritingMode>('FULL_EPISODE');
  const [narrativePerspective, setNarrativePerspective] =
    useState<NarrativePerspective>(AI_ENGINE_DEFAULTS.DEFAULT_NARRATIVE_PERSPECTIVE);
  const [targetEpisodeCharCount, setTargetEpisodeCharCount] = useState<number>(
    AI_ENGINE_DEFAULTS.EPISODE_TARGET_CHARS
  );
  const [targetSceneCharCount, setTargetSceneCharCount] = useState<number>(
    AI_ENGINE_DEFAULTS.SCENE_DEFAULT_TARGET_CHARS
  );
  const [tolerancePercent, setTolerancePercent] = useState<number>(
    AI_ENGINE_DEFAULTS.DEFAULT_TOLERANCE_PERCENT
  );
  const [plotOutline, setPlotOutline] = useState<string>(
    () =>
      episode.synopsis ||
      '말라코르와의 정면 대결 중 카엘이 에테르 제3위계 공명식을 개방하고 첫 번째 갑주 봉인을 파쇄한다.'
  );
  const [requiredEventsText, setRequiredEventsText] = useState<string>(
    '카엘의 제3위계 공명 개방\n세라피나의 성광 정화 결계 지원\n말라코르 투구 봉인 균열'
  );
  const [forbiddenDevelopmentsText, setForbiddenDevelopmentsText] = useState<string>(
    '말라코르가 이번 회차에서 완전히 사망하는 전개 금지\n성채 내부 공간 이동 마법 사용 금지'
  );
  const [selectedTextToRewrite, setSelectedTextToRewrite] = useState<string>('');
  const [selectedCharIds, setSelectedCharIds] = useState<string[]>(
    () => episode.linkedCharacterIds
  );
  const [sceneCastConfirmed, setSceneCastConfirmed] = useState(false);
  useEffect(() => {
    setSelectedCharIds(episode.linkedCharacterIds);
    setSceneCastConfirmed(false);
  }, [project.id, episode.id]);
  const [promptSelectionState, setPromptSelectionState] = useState<{
    projectId: string;
    selectedIds: string[];
    knownIds: string[];
    hasExplicitEmptySelection: boolean;
    explicitDeselectedIds: string[];
  }>(() => {
    const synced = computeStylePromptSelectionSync({
      projectId: project.id,
      previousProjectId: null,
      promptProfiles,
      previousSelectedIds: [],
      previousKnownIds: [],
      hasExplicitEmptySelection: false,
      explicitDeselectedIds: [],
    });
    return {
      projectId: synced.projectId,
      selectedIds: synced.selectedIds,
      knownIds: synced.knownIds,
      hasExplicitEmptySelection: synced.hasExplicitEmptySelection,
      explicitDeselectedIds: synced.explicitDeselectedIds,
    };
  });

  // P0-A2: Keep prompt selection reactive to project switches, newly approved active profiles,
  // deactivated profiles, and deleted profiles while preserving explicit author deselections.
  useEffect(() => {
    setPromptSelectionState((prev) => {
      const synced = computeStylePromptSelectionSync({
        projectId: project.id,
        previousProjectId: prev.projectId,
        promptProfiles,
        previousSelectedIds: prev.selectedIds,
        previousKnownIds: prev.knownIds,
        hasExplicitEmptySelection: prev.hasExplicitEmptySelection,
        explicitDeselectedIds: prev.explicitDeselectedIds,
      });
      const sameProject = prev.projectId === synced.projectId;
      const sameSelected =
        prev.selectedIds.length === synced.selectedIds.length &&
        prev.selectedIds.every((id, i) => id === synced.selectedIds[i]);
      const sameKnown =
        prev.knownIds.length === synced.knownIds.length &&
        prev.knownIds.every((id, i) => id === synced.knownIds[i]);
      const sameEmpty =
        prev.hasExplicitEmptySelection === synced.hasExplicitEmptySelection;
      if (sameProject && sameSelected && sameKnown && sameEmpty) {
        return prev;
      }
      return {
        projectId: synced.projectId,
        selectedIds: synced.selectedIds,
        knownIds: synced.knownIds,
        hasExplicitEmptySelection: synced.hasExplicitEmptySelection,
        explicitDeselectedIds: synced.explicitDeselectedIds,
      };
    });
  }, [project.id, promptProfiles]);

  const syncedPromptSelection = useMemo(
    () =>
      computeStylePromptSelectionSync({
        projectId: project.id,
        previousProjectId: promptSelectionState.projectId,
        promptProfiles,
        previousSelectedIds: promptSelectionState.selectedIds,
        previousKnownIds: promptSelectionState.knownIds,
        hasExplicitEmptySelection: promptSelectionState.hasExplicitEmptySelection,
        explicitDeselectedIds: promptSelectionState.explicitDeselectedIds,
      }),
    [project.id, promptProfiles, promptSelectionState]
  );

  const selectedPromptIds = syncedPromptSelection.selectedIds;

  const projectStylePromptProfiles = useMemo(
    () =>
      promptProfiles.filter(
        (p) =>
          p.promptType === 'PROJECT_STYLE_PROFILE' &&
          (p.projectId === project.id || p.projectId === 'GLOBAL')
      ),
    [promptProfiles, project.id]
  );

  const primaryStylePromptProfile = useMemo(() => {
    return (
      projectStylePromptProfiles.find(
        (p) => p.isActive && selectedPromptIds.includes(p.id)
      ) ||
      projectStylePromptProfiles.find((p) => p.isActive) ||
      projectStylePromptProfiles[0] ||
      null
    );
  }, [projectStylePromptProfiles, selectedPromptIds]);

  // Workflow, ExecutionState, AuditState & Exception Records (Rules 1, 9.5, 10)
  const [workflowState, setWorkflowState] = useState<EngineWorkflowState>('IDLE');
  const [executionState, setExecutionState] =
    useState<ManuscriptExecutionState>('DRAFT_READY');
  const [auditState, setAuditState] = useState<IndependentAuditState>(() =>
    createInitialAuditState()
  );
  const [canonClassification, setCanonClassification] =
    useState<ManuscriptCanonClassification>('STANDARD_DRAFT');
  const [approvedExceptions, setApprovedExceptions] = useState<
    OneTimeExceptionRecord[]
  >([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  // Module A: Writing Plan State
  const episodeLatestPlan = useMemo(() => {
    return (
      existingPlans.find((p) => p.episodeId === episode.id) || null
    );
  }, [existingPlans, episode.id]);

  const [currentPlan, setCurrentPlan] = useState<WritingPlan | null>(
    episodeLatestPlan
  );
  const [selectedSceneNumToWrite, setSelectedSceneNumToWrite] =
    useState<number>(1);

  // Module B: Generated Manuscript Staging State & Integrated AppResult (`novelforge_app_result.schema.json`)
  const [lastWritingResult, setLastWritingResult] =
    useState<WritingResult | null>(null);
  const [currentAppResult, setCurrentAppResult] =
    useState<NovelForgeAppResult | null>(null);
  const [stagedManuscript, setStagedManuscript] = useState<string>('');

  // Module C & D: Review Issues & Side-by-Side Diff State
  const [reviewIssues, setReviewIssues] = useState<WritingIssue[]>([]);
  const [showDiffPreview, setShowDiffPreview] = useState<boolean>(false);

  // Phase 4.3A: Literary Quality Evaluation State
  const [qualityReport, setQualityReport] =
    useState<LiteraryQualityReport | null>(null);
  const [isEvaluatingQuality, setIsEvaluatingQuality] = useState<boolean>(false);
  const [qualityErrorMessage, setQualityErrorMessage] = useState<string | null>(
    null
  );

  // Phase 4.3B: Advanced Literary Rewriting State
  const [rewriteModes, setRewriteModes] = useState<LiteraryRewriteMode[]>(['R1']);
  const [rewriteInstruction, setRewriteInstruction] = useState<string>('');
  const [rewriteTargetAnchor, setRewriteTargetAnchor] =
    useState<RewriteSelectionAnchor | null>(null);
  useEffect(() => {
    if (!voiceRewriteSelection) return;
    setRewriteTargetAnchor(voiceRewriteSelection.anchor);
    setRewriteModes(['R3']);
    setSelectedCharIds(voiceRewriteSelection.characterIds);
    setSceneCastConfirmed(true);
  }, [voiceRewriteSelection]);
  const [linkedQualityFindingMeta, setLinkedQualityFindingMeta] = useState<{
    findingId: string;
    dimension: LiteraryQualityDimensionId;
    summary: string;
  } | null>(null);
  const [allowUnverifiedTypoOnlyPreview, setAllowUnverifiedTypoOnlyPreview] =
    useState<boolean>(false);
  const [rewriteCanonEvidence, setRewriteCanonEvidence] =
    useState<CanonEvidenceReport | null>(null);
  const [rewriteClientLoreHash, setRewriteClientLoreHash] = useState<string>('');
  const [rewritePersistenceState, setRewritePersistenceState] =
    useState<RewriteAcceptPersistenceState | null>(null);
  const [isRetryingProposals, setIsRetryingProposals] = useState<boolean>(false);
  const [rewriteCandidate, setRewriteCandidate] =
    useState<LiteraryRewriteCandidate | null>(null);
  const [isRewritingLiterary, setIsRewritingLiterary] = useState<boolean>(false);
  const [rewriteErrorMessage, setRewriteErrorMessage] = useState<string | null>(
    null
  );

  // Module E: Memory Curator Report State
  const [curatorReport, setCuratorReport] =
    useState<MemoryCuratorReport | null>(null);

  // Token Usage Telemetry
  const [lastUsage, setLastUsage] = useState<TokenUsageMetadata | null>(null);
  const [lastModelId, setLastModelId] = useState<string>(
    AI_ENGINE_DEFAULTS.DEFAULT_MODEL_ID
  );

  const isBusy =
    workflowState === 'PLANNING' ||
    workflowState === 'WRITING_SCENE' ||
    workflowState === 'REVIEWING' ||
    workflowState === 'SAVING' ||
    isEvaluatingQuality ||
    isRewritingLiterary;

  // Build live WritingContextBundle (Section 8)
  const writingContext = useMemo(() => {
    const reqEvents = requiredEventsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const forbEvents = forbiddenDevelopmentsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    return buildWritingContext({
      project,
      episode: {
        ...episode,
        content: currentEditorContent,
      },
      allEpisodes,
      characters,
      worldbuilding,
      promptProfiles,
      selectedCharacterIds: selectedCharIds,
      sceneCharacterIds: sceneCastConfirmed ? selectedCharIds : [],
      selectedPromptProfileIds: selectedPromptIds,
      writingMode,
      narrativePerspective,
      targetEpisodeCharCount,
      targetSceneCharCount,
      tolerancePercent,
      plotOutline,
      requiredEvents: reqEvents,
      forbiddenDevelopments: forbEvents,
      selectedTextToRewrite,
      rewriteSelectionAnchor:
        writingMode === 'REWRITE_SELECTION'
          ? rewriteTargetAnchor ?? undefined
          : undefined,
      approvedExceptions,
    });
  }, [
    project,
    episode,
    currentEditorContent,
    allEpisodes,
    characters,
    worldbuilding,
    promptProfiles,
    selectedCharIds,
    sceneCastConfirmed,
    selectedPromptIds,
    writingMode,
    narrativePerspective,
    targetEpisodeCharCount,
    targetSceneCharCount,
    tolerancePercent,
    plotOutline,
    requiredEventsText,
    forbiddenDevelopmentsText,
    selectedTextToRewrite,
    rewriteTargetAnchor,
    approvedExceptions,
  ]);

  const activeManuscriptForEval =
    stagedManuscript.trim().length > 0 ? stagedManuscript : currentEditorContent;

  const lengthEvaluation = useMemo(
    () =>
      evaluateManuscriptLength(
        activeManuscriptForEval,
        writingMode === 'SINGLE_SCENE' ? targetSceneCharCount : targetEpisodeCharCount,
        tolerancePercent
      ),
    [
      activeManuscriptForEval,
      writingMode,
      targetSceneCharCount,
      targetEpisodeCharCount,
      tolerancePercent,
    ]
  );

  const diffPreviewResult = useMemo(
    () =>
      applyApprovedIssuesToManuscript(activeManuscriptForEval, reviewIssues),
    [activeManuscriptForEval, reviewIssues]
  );

  const buildAuthHeaders = async (): Promise<Record<string, string>> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const token = await getIdToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  };

  // ============================================================================
  // Step 3 Handler: [AI 기획안 작성] & [기획안 승인]
  // ============================================================================

  const handleGeneratePlotPlan = async () => {
    if (isBusy) return;
    setErrorMessage(null);
    setStatusNotice(null);
    setWorkflowState('PLANNING');
    const tempRunId = generateEntityId('run_plan');
    setActiveRunId(tempRunId);

    try {
      const headers = await buildAuthHeaders();
      const res = await fetch('/api/ai/plot-plan', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ownerId: project.ownerId,
          context: writingContext,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'AI 장면 기획안 생성에 실패했습니다.');
      }

      const plan = data.plan as WritingPlan;
      setCurrentPlan(plan);
      setLastUsage(data.usageMetadata as TokenUsageMetadata);
      setLastModelId(plan.modelId);
      await onSaveWritingPlan(plan);
      setWorkflowState('AWAITING_PLAN_APPROVAL');
      setStatusNotice(
        '장면 기획안이 생성되었습니다. 장면 구성을 검토·수정한 뒤 반드시 [기획안 승인] 버튼을 눌러야 본문 집필이 활성화됩니다.'
      );
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : '기획안 작성 중 오류가 발생했습니다.';
      setErrorMessage(msg);
      setWorkflowState('ERROR');
    } finally {
      setActiveRunId(null);
    }
  };

  const handleApprovePlan = async () => {
    if (!currentPlan) return;
    const nowIso = new Date().toISOString();
    const approved: WritingPlan = {
      ...currentPlan,
      status: 'APPROVED',
      approvedAt: nowIso,
      updatedAt: nowIso,
    };
    setCurrentPlan(approved);
    await onSaveWritingPlan(approved);
    setWorkflowState('IDLE');
    setStatusNotice(
      '기획안이 작가에 의해 최종 승인되었습니다! 이제 [장면별 원고 생성] 또는 [회차 전체 집필]을 실행할 수 있습니다.'
    );
  };

  const handleUpdateSceneInPlan = (
    sceneNumber: number,
    updates: Partial<ScenePlanItem>
  ) => {
    if (!currentPlan) return;
    const updatedScenes = currentPlan.scenes.map((sc) =>
      sc.sceneNumber === sceneNumber ? { ...sc, ...updates } : sc
    );
    setCurrentPlan({
      ...currentPlan,
      scenes: updatedScenes,
      updatedAt: new Date().toISOString(),
    });
  };

  // ============================================================================
  // Step 4 Handler: [장면별 원고 생성] / [회차 전체 집필] / [이어쓰기] / [재작성] / [분량 보강] / [생성 중단]
  // ============================================================================

  const handleExecuteWriting = async (options?: {
    overrideMode?: WritingMode;
    targetSceneNumber?: number;
    expansionAction?: ExpansionActionType;
  }) => {
    if (isBusy) return;
    const effectiveMode = options?.overrideMode ?? writingMode;

    if (
      !options?.expansionAction &&
      (effectiveMode === 'FULL_EPISODE' || effectiveMode === 'SINGLE_SCENE')
    ) {
      if (!currentPlan || currentPlan.status !== 'APPROVED') {
        setErrorMessage(
          '작가가 기획안을 승인하기 전에는 본문 집필을 시작할 수 없습니다. 먼저 3단계에서 [기획안 승인]을 완료해 주세요.'
        );
        setWorkflowState('AWAITING_PLAN_APPROVAL');
        return;
      }
    }

    setErrorMessage(null);
    setStatusNotice(null);
    setWorkflowState('WRITING_SCENE');
    const runId = generateEntityId('run_write');
    setActiveRunId(runId);

    try {
      const headers = await buildAuthHeaders();
      const contextPayload = {
        ...writingContext,
        writingMode: effectiveMode,
        currentManuscript: activeManuscriptForEval,
      };

      const res = await fetch('/api/ai/write-scene', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ownerId: project.ownerId,
          runId,
          context: contextPayload,
          plan: currentPlan,
          targetSceneNumber: options?.targetSceneNumber,
          expansionAction: options?.expansionAction,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'AI 원고 생성에 실패했습니다.');
      }

      const result = data as WritingResult;
      setLastWritingResult(result);
      if (result.appResult) {
        setCurrentAppResult(result.appResult);
      }
      setExecutionState(result.executionState || 'DRAFT_READY');
      setAuditState(result.auditState || createInitialAuditState());
      setCanonClassification(result.canonClassification || 'CANON_CANDIDATE');
      setLastUsage(result.usageMetadata);
      setLastModelId(result.modelId);

      // Requirement 7: Record the exact Master Writing Rules version used for this writing request
      if (onUpdatePromptProfile) {
        const activeCoreProfile = promptProfiles.find(
          (p) =>
            p.promptType === 'CORE_WRITING_RULES' &&
            p.isActive &&
            selectedPromptIds.includes(p.id)
        );
        if (activeCoreProfile) {
          const marked = markMasterRulesVersionUsed(
            activeCoreProfile,
            result.createdAt || new Date().toISOString()
          );
          await onUpdatePromptProfile(marked, {
            expectedVersionId: activeCoreProfile.currentVersionId,
            expectedVersionNumber: activeCoreProfile.currentVersionNumber,
          });
        }
      }

      if (result.issues && result.issues.length > 0) {
        setReviewIssues(result.issues);
        setShowDiffPreview(true);
      }
      if (result.proposals && result.proposals.length > 0) {
        await onSaveChangeProposals(result.proposals);
      }

      if (
        result.executionState === 'BLOCKED_CONFLICT' ||
        result.executionState === 'BLOCKED_MISSING_INFO'
      ) {
        // Rule 10.2: When pre-writing conflict or missing core info blocks generation,
        // server returns manuscript === "". We do NOT overwrite existing draft; we surface issues in the review panel.
        setWorkflowState(result.executionState);
        setStatusNotice(
          result.executionState === 'BLOCKED_CONFLICT'
            ? '집필 보류(BLOCKED_CONFLICT): 작가의 요청이 확정 설정(CANON)과 충돌하여 원고 생성을 보류했습니다. 아래 검수 패널에서 [일회성 예외 승인] 또는 [확정 설정 변경 승인]을 선택한 뒤 다시 실행하세요.'
            : '집필 보류(BLOCKED_MISSING_INFO): 인물의 생존, 주요 부상, 직접적 인과관계 등 핵심 필수 정보가 누락되어 원고 생성을 보류했습니다. 플롯 또는 설정을 보완해 주세요.'
        );
      } else if (result.status === 'PARTIAL' || result.status === 'ABORTED') {
        if (result.manuscript) {
          setStagedManuscript(result.manuscript);
        }
        setWorkflowState('ABORTED');
        setStatusNotice(
          result.errorMessage ||
            '생성이 중단되었으나 중단 직전까지 완료된 장면 초안은 안전하게 보존되었습니다.'
        );
      } else {
        setStagedManuscript(result.manuscript);
        setWorkflowState('DRAFT_READY');
        setStatusNotice(
          `원고 생성이 완료되었습니다 (${result.manuscript.length.toLocaleString()}자 · 상태: ${
            result.executionState
          }${
            result.canonClassification === 'NON_CANON_EXCEPTION'
              ? ' · 비정사 예외 초안'
              : ''
          }). 독립 검수(문체/설정)는 별도로 실행해야 완료 처리됩니다.`
        );
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : '원고 생성 중 오류가 발생했습니다.';
      setErrorMessage(msg);
      setWorkflowState(msg.includes('중단') ? 'ABORTED' : 'ERROR');
    } finally {
      setActiveRunId(null);
    }
  };

  const handleCancelActiveGeneration = async () => {
    if (!activeRunId) return;
    try {
      const headers = await buildAuthHeaders();
      await fetch('/api/ai/cancel', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ownerId: project.ownerId,
          runId: activeRunId,
        }),
      });
      setWorkflowState('ABORTED');
      setStatusNotice('작가의 요청으로 AI 생성 중단 신호를 전송했습니다.');
    } catch {
      setWorkflowState('ABORTED');
    }
  };

  // ============================================================================
  // Rule 1 & Rule 10.3 Handler: One-Time Conflict Exception & Canon Promotion
  // ============================================================================

  const handleGrantOneTimeException = (issue: WritingIssue) => {
    const check = validateConflictResolutionApproval({
      id: generateEntityId('exc'),
      targetLoreId: issue.referenceLoreId || issue.reference_lore_id || issue.category,
      targetTitle: issue.relatedCanonReference || issue.category,
      scope: 'CURRENT_RUN_ONLY',
      reason: `작가 일회성 예외 승인: ${issue.description.slice(0, 120)}`,
      affectedEpisodeIds: [episode.id],
      resolutionMode: 'ONE_TIME_EXCEPTION',
      approvedBy: 'AUTHOR',
      approvedAt: new Date().toISOString(),
    });
    if (!check.valid || !check.record) {
      setErrorMessage(check.error || '일회성 예외 승인 처리에 실패했습니다.');
      return;
    }
    setApprovedExceptions((prev) => [...prev, check.record!]);
    setCanonClassification('NON_CANON_EXCEPTION');
    setReviewIssues((prev) =>
      prev.map((iss) =>
        iss.id === issue.id ? { ...iss, decision: 'ACCEPTED' } : iss
      )
    );
    setWorkflowState('IDLE');
    setStatusNotice(
      `일회성 예외 승인 완료(${check.record.targetTitle}): 현재 집필 작업에만 예외가 적용되며, 생성 원고는 비정사 예외 초안(NON_CANON_EXCEPTION)으로 분류됩니다.`
    );
  };

  const handlePromoteExceptionDraftToCanon = () => {
    setApprovedExceptions((prev) =>
      prev.map((ex) => ({
        ...ex,
        resolutionMode: 'CANON_PROMOTION',
      }))
    );
    setCanonClassification('CANON_PROMOTED');
    setStatusNotice(
      '작가의 별도 정사 편입 승인(CANON_PROMOTION)이 기록되었습니다. 이제 이 원고를 정식 연재(CANON)로 최종 확정할 수 있습니다.'
    );
  };

  // ============================================================================
  // Step 5 & 6 Handler: [문체 검수] & [설정 검수] & [수정안 비교] (Rule 9.5 & Rule 10.2)
  // ============================================================================

  const handleRunReview = async (
    focus: 'BOTH' | 'STYLE_ONLY' | 'CONTINUITY_ONLY'
  ) => {
    if (isBusy) return;
    const textToReview = activeManuscriptForEval.trim();
    if (!textToReview) {
      setErrorMessage('검수할 원고 본문이 없습니다. 먼저 원고를 작성하거나 생성해 주세요.');
      return;
    }

    setErrorMessage(null);
    setStatusNotice(null);
    setWorkflowState('REVIEWING');

    try {
      const headers = await buildAuthHeaders();
      const res = await fetch('/api/ai/review', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ownerId: project.ownerId,
          context: writingContext,
          manuscriptToReview: textToReview,
          reviewFocus: focus,
          currentAppResult,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '원고 검수 요청에 실패했습니다.');
      }

      if (data.appResult) {
        setCurrentAppResult(data.appResult as NovelForgeAppResult);
      }
      if (data.proposals && data.proposals.length > 0) {
        await onSaveChangeProposals(data.proposals as ChangeProposal[]);
      }

      if (data.auditState) {
        const incomingAudit = data.auditState as IndependentAuditState;
        setAuditState((prev) => ({
          continuityAuditStatus:
            focus === 'BOTH' || focus === 'CONTINUITY_ONLY'
              ? incomingAudit.continuityAuditStatus
              : prev.continuityAuditStatus,
          styleAuditStatus:
            focus === 'BOTH' || focus === 'STYLE_ONLY'
              ? incomingAudit.styleAuditStatus
              : prev.styleAuditStatus,
          lastContinuityAuditAt:
            incomingAudit.lastContinuityAuditAt || prev.lastContinuityAuditAt,
          lastStyleAuditAt:
            incomingAudit.lastStyleAuditAt || prev.lastStyleAuditAt,
          auditErrorMessage: incomingAudit.auditErrorMessage,
        }));
      }

      if (data.executionState === 'AUDIT_FAILED') {
        // Rule 9.5 & Rule 10.2: Preserve existing draft manuscript, do NOT mark audit complete
        setExecutionState('AUDIT_FAILED');
        setWorkflowState('AUDIT_FAILED');
        setErrorMessage(
          data.auditState?.auditErrorMessage ||
            '독립 검수 실행 중 오류가 발생했습니다(AUDIT_FAILED). 생성된 원고 초안은 삭제되지 않고 안전하게 유지됩니다.'
        );
        return;
      }

      const issues = (data.issues || []) as WritingIssue[];
      setReviewIssues(issues);
      setLastUsage(data.usageMetadata as TokenUsageMetadata);
      setLastModelId(data.modelId || lastModelId);
      setShowDiffPreview(true);
      const nextExecState: ManuscriptExecutionState =
        data.executionState || (issues.length > 0 ? 'REVIEW_REQUIRED' : 'DRAFT_READY');
      setExecutionState(nextExecState);
      setWorkflowState(
        issues.length > 0 ? 'REVIEW_REQUIRED' : 'DRAFT_READY'
      );
      setStatusNotice(
        issues.length > 0
          ? `독립 검수 결과 총 ${issues.length}건의 검토 항목이 발견되었습니다(상태: ${nextExecState}). 기존 원고 초안은 그대로 보존되며, 수정안 비교 패널에서 개별 수락/거절 또는 일회성 예외 승인을 선택할 수 있습니다.`
          : '독립 검수 완료: 확정 설정 충돌이나 중대한 문체 오류가 발견되지 않았습니다.'
      );
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : '검수 중 오류가 발생했습니다.';
      setExecutionState('AUDIT_FAILED');
      setAuditState((prev) => ({
        ...prev,
        continuityAuditStatus:
          focus === 'BOTH' || focus === 'CONTINUITY_ONLY'
            ? 'AUDIT_FAILED'
            : prev.continuityAuditStatus,
        styleAuditStatus:
          focus === 'BOTH' || focus === 'STYLE_ONLY'
            ? 'AUDIT_FAILED'
            : prev.styleAuditStatus,
        auditErrorMessage: msg,
      }));
      setErrorMessage(`독립 검수 실패(AUDIT_FAILED · 기존 초안 보존됨): ${msg}`);
      setWorkflowState('AUDIT_FAILED');
    }
  };

  const handleIssueDecision = (
    issueId: string,
    decision: 'ACCEPTED' | 'REJECTED'
  ) => {
    setReviewIssues((prev) =>
      prev.map((iss) => (iss.id === issueId ? { ...iss, decision } : iss))
    );
  };

  const handleAcceptAllIssues = () => {
    setReviewIssues((prev) =>
      prev.map((iss) => ({ ...iss, decision: 'ACCEPTED' }))
    );
  };

  const handleRejectAllIssues = () => {
    setReviewIssues((prev) =>
      prev.map((iss) => ({ ...iss, decision: 'REJECTED' }))
    );
  };

  const handleCommitAcceptedIssuesToStage = () => {
    const { revisedManuscript, appliedCount } =
      applyApprovedIssuesToManuscript(activeManuscriptForEval, reviewIssues);
    setStagedManuscript(revisedManuscript);
    setExecutionState('DRAFT_READY');
    setWorkflowState('DRAFT_READY');
    setStatusNotice(
      `수락한 수정안 ${appliedCount}건이 임시 원고에 반영되었습니다. [에디터 본문에 반영] 또는 [최종 원고 확정]을 눌러 저장하세요.`
    );
  };

  // ============================================================================
  // Phase 4.3A Handler: [원고 품질 진단] & 작가 승인 기반 수정안 적용
  // ============================================================================

  const resolvedSavedRevisionId = (
    currentRevisionId ||
    episode.latestRevisionId ||
    ''
  ).trim();
  const activeQualityRevisionId = resolvedSavedRevisionId || 'UNSAVED_DRAFT';

  const handleRunLiteraryQualityEvaluation = async (options: {
    includeStyleEditorAudit: boolean;
  }) => {
    if (isBusy) return;
    const textToEvaluate = activeManuscriptForEval;
    if (!textToEvaluate.trim()) {
      setQualityErrorMessage(
        '품질을 진단할 원고 본문이 비어 있습니다. 먼저 원고를 작성하거나 생성해 주세요.'
      );
      return;
    }

    setQualityErrorMessage(null);
    setStatusNotice(null);
    setIsEvaluatingQuality(true);

    try {
      const headers = await buildAuthHeaders();
      const existingStyleIssues = reviewIssues.filter(
        (iss) =>
          iss.sourceModule === 'STYLE_EDITOR' || iss.source === 'STYLE_EDITOR'
      );
      const res = await fetch('/api/ai/evaluate-quality', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ownerId: project.ownerId,
          projectId: project.id,
          episodeId: episode.id,
          sourceRevisionId: activeQualityRevisionId,
          manuscript: textToEvaluate,
          context: writingContext,
          includeStyleEditorAudit: options.includeStyleEditorAudit,
          existingStyleIssues,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<
        LiteraryQualityEvaluationResponse
      > & { error?: string };

      if (!res.ok) {
        throw new Error(
          data.error || '문학적 품질 진단 서버 요청에 실패했습니다.'
        );
      }

      if (data.report) {
        setQualityReport(data.report);
      }

      if (data.executionStatus === 'QUALITY_EVALUATION_FAILED') {
        setQualityErrorMessage(
          data.errorMessage ||
            data.report?.errorMessage ||
            '문학적 품질 진단 실행에 실패했습니다. 기존 원고 초안은 그대로 보존되었습니다.'
        );
        return;
      }

      if (data.report) {
        setStatusNotice(
          `문학적 품질 진단 완료: 총 ${data.report.findings.length}건의 개선 제안이 도출되었습니다. 각 항목을 비교한 뒤 수락한 제안만 원고에 반영할 수 있습니다.`
        );
      }
    } catch (err) {
      setQualityErrorMessage(
        err instanceof Error
          ? err.message
          : '문학적 품질 진단 중 통신 오류가 발생했습니다. 기존 원고 초안은 보존됩니다.'
      );
    } finally {
      setIsEvaluatingQuality(false);
    }
  };

  const handleUpdateQualityFindingDecision = (
    findingId: string,
    decision: LiteraryQualityDecision
  ) => {
    setQualityReport((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        findings: prev.findings.map((f) =>
          f.findingId === findingId ? { ...f, decision } : f
        ),
      };
    });
  };

  const handleBulkQualityDecision = (decision: 'ACCEPTED' | 'REJECTED') => {
    setQualityReport((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        findings: prev.findings.map((f) => ({ ...f, decision })),
      };
    });
  };

  const handleApplyQualityRevisions = async (
    revisedManuscript: string,
    appliedFindingIds: string[]
  ) => {
    try {
      await onApplyManuscriptToEditor(revisedManuscript, {
        createBackupRevisionFirst: true,
        revisionLabel: `문학적 품질 진단 수정안 반영 (${appliedFindingIds.length}건)`,
      });
      if (stagedManuscript.trim().length > 0) {
        setStagedManuscript(revisedManuscript);
      }
      setStatusNotice(
        `기존 원고를 버전 기록에 백업한 뒤, 작가가 수락한 품질 수정안 ${appliedFindingIds.length}건을 원고 본문에 반영했습니다.`
      );
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : '품질 진단 수정안 저장 중 오류가 발생하여 기존 원고와 임시 초안을 보존했습니다.';
      setErrorMessage(msg);
      throw err;
    }
  };

  // ============================================================================
  // Phase 4.3B Handler: 정밀 문학 리라이팅 (R1~R6 · 원고 보호 · 작가 승인)
  // ============================================================================

  const activeManuscriptHash = useMemo(
    () => computeManuscriptContentHash(activeManuscriptForEval),
    [activeManuscriptForEval]
  );

  const isRewriteCandidateStale = useMemo(() => {
    if (!rewriteCandidate) return false;
    return rewriteCandidate.sourceContentHash !== activeManuscriptHash;
  }, [rewriteCandidate, activeManuscriptHash]);

  const handleToggleRewriteMode = (mode: LiteraryRewriteMode) => {
    setRewriteModes((prev) => {
      if (prev.includes(mode)) {
        return prev.length > 1 ? prev.filter((m) => m !== mode) : prev;
      }
      return [...prev, mode];
    });
  };

  const handleCaptureSelectionForRewrite = () => {
    setRewriteErrorMessage(null);
    if (!activeManuscriptForEval.trim()) {
      setRewriteErrorMessage('선택 구간을 지정할 원고 본문이 비어 있습니다.');
      return;
    }

    try {
      if (
        editorSelection &&
        editorSelection.endOffset > editorSelection.startOffset &&
        stagedManuscript.trim().length === 0
      ) {
        const anchor = createRewriteSelectionAnchor({
          manuscript: activeManuscriptForEval,
          startOffset: editorSelection.startOffset,
          endOffset: editorSelection.endOffset,
          sourceRevisionId: resolvedSavedRevisionId,
        });
        setRewriteTargetAnchor(anchor);
        setSelectedTextToRewrite(anchor.originalExcerpt);
        setLinkedQualityFindingMeta(null);
        setRewriteCandidate(null);
        return;
      }

      if (selectedTextToRewrite.trim()) {
        const resolved = validateRewriteSelectionTarget({
          manuscript: activeManuscriptForEval,
          selectedTextToRewrite: selectedTextToRewrite.trim(),
          currentRevisionId: resolvedSavedRevisionId,
        });
        const anchor = createRewriteSelectionAnchor({
          manuscript: activeManuscriptForEval,
          startOffset: resolved.startOffset,
          endOffset: resolved.endOffset,
          sourceRevisionId: resolvedSavedRevisionId,
        });
        setRewriteTargetAnchor(anchor);
        setLinkedQualityFindingMeta(null);
        setRewriteCandidate(null);
        return;
      }

      setRewriteErrorMessage(
        '본문 에디터에서 수정할 문장을 드래그하여 선택하거나, 위 선택 영역 입력란에 유일한 원고 문단을 입력해 주세요.'
      );
    } catch (err) {
      setRewriteErrorMessage(
        err instanceof Error ? err.message : '선택 구간 검증에 실패했습니다.'
      );
    }
  };

  const handleRequestRewriteFromQualityFinding = (
    finding: LiteraryQualityFinding
  ) => {
    setRewriteErrorMessage(null);
    if (
      finding.startOffset === null ||
      finding.endOffset === null ||
      finding.endOffset <= finding.startOffset
    ) {
      setRewriteErrorMessage(
        '선택된 품질 진단 항목에 유효한 원고 오프셋 정보가 없습니다.'
      );
      return;
    }

    try {
      const anchor = createRewriteSelectionAnchor({
        manuscript: activeManuscriptForEval,
        startOffset: finding.startOffset,
        endOffset: finding.endOffset,
        sourceRevisionId: resolvedSavedRevisionId,
      });
      setRewriteTargetAnchor(anchor);
      setSelectedTextToRewrite(anchor.originalExcerpt);
      setRewriteModes(recommendRewriteModesForQualityDimension(finding.category));
      setRewriteInstruction(
        `[${finding.category}] ${finding.problem} — ${finding.reason}`
      );
      setLinkedQualityFindingMeta({
        findingId: finding.findingId,
        dimension: finding.category,
        summary: finding.problem,
      });
      setRewriteCandidate(null);
      setStatusNotice(
        `품질 진단 항목(${finding.category}, ${finding.startOffset}~${finding.endOffset}자)이 정밀 리라이팅 작업대에 연결되었습니다.`
      );
      if (typeof document !== 'undefined') {
        document
          .getElementById('literary-rewrite-panel')
          ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    } catch (err) {
      setRewriteErrorMessage(
        err instanceof Error
          ? err.message
          : '품질 진단 구간이 현재 원고와 일치하지 않아 리라이팅을 연결할 수 없습니다.'
      );
    }
  };

  const currentClientLoreFingerprint = useMemo(() => {
    const canonSummary = [
      project.id,
      writingContext.narrativePerspective,
      ...(writingContext.canonCharacters || []).map(
        (c) => `${c.id}:${c.name}:${c.abilities}:${c.personality}`
      ),
      ...(writingContext.canonWorldbuilding || []).map(
        (w) => `${w.id}:${w.title}:${w.rules}`
      ),
    ].join('|');
    return computeStableIdempotencyHash(canonSummary);
  }, [
    project.id,
    writingContext.narrativePerspective,
    writingContext.canonCharacters,
    writingContext.canonWorldbuilding,
  ]);

  const isRewriteLoreDrifted = useMemo(() => {
    if (!rewriteCandidate || !rewriteClientLoreHash) return false;
    return rewriteClientLoreHash !== currentClientLoreFingerprint;
  }, [rewriteCandidate, rewriteClientLoreHash, currentClientLoreFingerprint]);

  const handleRunLiteraryRewrite = async () => {
    if (isBusy) return;
    if (!rewriteTargetAnchor) {
      setRewriteErrorMessage(
        '먼저 원고에서 리라이팅할 선택 구간을 지정하거나 [선택 구간 가져오기]를 눌러 주세요.'
      );
      return;
    }

    setRewriteErrorMessage(null);
    setStatusNotice(null);
    setRewritePersistenceState(null);
    setIsRewritingLiterary(true);

    try {
      const verifiedTarget = validateRewriteSelectionTarget({
        manuscript: activeManuscriptForEval,
        anchor: rewriteTargetAnchor,
        currentRevisionId: resolvedSavedRevisionId,
      });
      const verifiedAnchor = createRewriteSelectionAnchor({
        manuscript: activeManuscriptForEval,
        startOffset: verifiedTarget.startOffset,
        endOffset: verifiedTarget.endOffset,
        sourceRevisionId: resolvedSavedRevisionId,
      });

      const headers = await buildAuthHeaders();
      const res = await fetch('/api/ai/rewrite-literary', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ownerId: project.ownerId,
          projectId: project.id,
          episodeId: episode.id,
          sourceRevisionId: activeQualityRevisionId,
          manuscript: activeManuscriptForEval,
          anchor: verifiedAnchor,
          modes: rewriteModes,
          confirmedVoiceCharacterId: voiceRewriteSelection &&
            voiceRewriteSelection.anchor.sourceContentHash === verifiedAnchor.sourceContentHash &&
            voiceRewriteSelection.anchor.startOffset === verifiedAnchor.startOffset &&
            voiceRewriteSelection.anchor.endOffset === verifiedAnchor.endOffset
              ? voiceRewriteSelection.characterIds[0] : undefined,
          authorInstruction: rewriteInstruction.trim(),
          linkedQualityFindingId: linkedQualityFindingMeta?.findingId,
          linkedQualityDimension: linkedQualityFindingMeta?.dimension,
          allowUnverifiedTypoOnlyPreview,
          context: writingContext,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<
        LiteraryRewriteResponse
      > & { error?: string };

      if (!res.ok) {
        throw new Error(
          data.error || '정밀 문학 리라이팅 서버 요청에 실패했습니다.'
        );
      }

      if (data.canonEvidence) {
        setRewriteCanonEvidence(data.canonEvidence);
      } else if (data.candidate?.verification?.canonEvidence) {
        setRewriteCanonEvidence(data.candidate.verification.canonEvidence);
      }

      if (data.candidate) {
        setRewriteCandidate(data.candidate);
        setRewriteClientLoreHash(currentClientLoreFingerprint);
      }

      if (data.executionStatus === 'REWRITE_FAILED') {
        setRewriteErrorMessage(
          data.errorMessage ||
            '정밀 리라이팅 생성에 실패했습니다. 기존 원고는 변경 없이 보존되었습니다.'
        );
        return;
      }

      if (
        data.executionStatus === 'BLOCKED_CONFLICT' ||
        data.executionStatus === 'BLOCKED_MISSING_INFO'
      ) {
        setRewriteErrorMessage(
          data.errorMessage ||
            'CANON 근거 검증 실패 또는 설정·시점 규칙 위반으로 리라이팅이 보류되었습니다.'
        );
        return;
      }

      if (data.candidate?.aiDecision === 'NO_OP_OPTIMAL') {
        setStatusNotice(
          'AI 편집자가 현 원문이 이미 최적이라고 판단했습니다(NO_OP_OPTIMAL). 수정을 건너뛰어 원문 개성을 유지합니다.'
        );
      } else if (data.candidate) {
        setStatusNotice(
          '정밀 리라이팅 수정안이 준비되었습니다. 원문과 수정안, CANON 근거 검증, 변경 이유를 비교한 뒤 [수락] 또는 [거절]을 선택하세요.'
        );
      }
    } catch (err) {
      setRewriteErrorMessage(
        err instanceof Error
          ? err.message
          : '정밀 리라이팅 실행 중 오류가 발생했습니다. 기존 원고는 보존됩니다.'
      );
    } finally {
      setIsRewritingLiterary(false);
    }
  };

  const handleRetryPendingRewriteProposals = async () => {
    if (
      !rewritePersistenceState ||
      rewritePersistenceState.status !== 'MANUSCRIPT_COMMITTED_PROPOSALS_PENDING' ||
      rewritePersistenceState.pendingProposals.length === 0 ||
      isRetryingProposals
    ) {
      return;
    }

    setIsRetryingProposals(true);
    setRewriteErrorMessage(null);
    const nowIso = new Date().toISOString();

    try {
      const propRes = await onSaveChangeProposals(
        rewritePersistenceState.pendingProposals,
        {
          requireVerifiedSourceRevision: true,
          expectedEpisodeId: episode.id,
          expectedSourceRevisionId:
            rewritePersistenceState.committedRevisionId || undefined,
          expectedSourceContentHash:
            rewritePersistenceState.committedContentHash || undefined,
        }
      );
      if (!propRes) {
        setRewritePersistenceState((prev) =>
          prev
            ? {
                ...prev,
                status: 'MANUSCRIPT_AND_PROPOSALS_COMMITTED',
                pendingProposals: [],
                proposalErrorMessage: null,
                updatedAt: nowIso,
              }
            : null
        );
        setStatusNotice(
          `보류 중이던 설정 변경 제안 재저장이 완료되었습니다(원고 리비전 ${rewritePersistenceState.committedRevisionId} 유지).`
        );
        return;
      }

      const newlySaved = propRes.itemResults
        .filter((r) => r.status === 'CREATED')
        .map((r) => r.proposalId);
      const skippedIds = propRes.itemResults
        .filter(
          (r) =>
            r.status === 'SKIPPED_ALREADY_EXISTS' ||
            r.status === 'SKIPPED_ALREADY_DECIDED'
        )
        .map((r) => r.proposalId);

      if (propRes.failedCount > 0) {
        const errDetail = formatProposalPersistenceErrorSummaryKo(propRes.itemResults);
        setRewritePersistenceState((prev) =>
          prev
            ? {
                ...prev,
                status: 'MANUSCRIPT_COMMITTED_PROPOSALS_PENDING',
                pendingProposals: propRes.failedProposals,
                savedProposalIds: [
                  ...new Set([...prev.savedProposalIds, ...newlySaved]),
                ],
                skippedDuplicateProposalIds: [
                  ...new Set([
                    ...prev.skippedDuplicateProposalIds,
                    ...skippedIds,
                  ]),
                ],
                proposalErrorMessage:
                  errDetail ||
                  `재시도 결과 ${propRes.failedCount}건의 설정 제안이 여전히 실패했습니다. 원고는 중복 저장되지 않았습니다.`,
                updatedAt: nowIso,
              }
            : null
        );
        return;
      }

      setRewritePersistenceState((prev) =>
        prev
          ? {
              ...prev,
              status: 'MANUSCRIPT_AND_PROPOSALS_COMMITTED',
              pendingProposals: [],
              savedProposalIds: [
                ...new Set([...prev.savedProposalIds, ...newlySaved]),
              ],
              skippedDuplicateProposalIds: [
                ...new Set([
                  ...prev.skippedDuplicateProposalIds,
                  ...skippedIds,
                ]),
              ],
              proposalErrorMessage: null,
              updatedAt: nowIso,
            }
          : null
      );
      setStatusNotice(
        `원고 리비전(${rewritePersistenceState.committedRevisionId})은 재저장 없이 보존한 채, 실패했던 설정 변경 제안 ${newlySaved.length}건 저장(중복 건너뜀 ${skippedIds.length}건)을 완료했습니다.`
      );
    } catch (err) {
      setRewritePersistenceState((prev) =>
        prev
          ? {
              ...prev,
              proposalErrorMessage:
                err instanceof Error
                  ? err.message
                  : '설정 제안 재시도 중 오류가 발생했습니다.',
              updatedAt: new Date().toISOString(),
            }
          : null
      );
    } finally {
      setIsRetryingProposals(false);
    }
  };

  const handleAcceptRewriteCandidate = async () => {
    if (!rewriteCandidate || isBusy || isRetryingProposals) return;

    // P0-B Guard: If manuscript already committed and only proposals are pending, retry proposals ONLY!
    if (
      rewritePersistenceState?.candidateId === rewriteCandidate.candidateId &&
      rewritePersistenceState.status === 'MANUSCRIPT_COMMITTED_PROPOSALS_PENDING'
    ) {
      await handleRetryPendingRewriteProposals();
      return;
    }

    if (isRewriteLoreDrifted) {
      setRewriteErrorMessage(
        '[CANON_DRIFT_AFTER_GENERATION] 리라이팅 생성 이후 확정 설정(CANON)이 변경되어 반영을 차단했습니다. 최신 설정 기준으로 [다시 생성]해 주세요.'
      );
      return;
    }

    const preApplyCheck = validateRewriteCandidateBeforeApply({
      candidate: rewriteCandidate,
      currentManuscript: activeManuscriptForEval,
      currentRevisionId: resolvedSavedRevisionId,
      allowUnverifiedTypoOnlyPreview,
    });
    if (!preApplyCheck.valid) {
      setRewriteErrorMessage(
        preApplyCheck.errorMessage ||
          '리라이팅 후보의 사전 검증에 실패하여 원고에 반영할 수 없습니다.'
      );
      return;
    }

    setRewriteErrorMessage(null);
    const nowIso = new Date().toISOString();

    if (rewriteCandidate.aiDecision === 'NO_OP_OPTIMAL') {
      setRewriteCandidate((prev) =>
        prev ? { ...prev, authorDecision: 'ACCEPTED' } : prev
      );
      setStatusNotice(
        'NO_OP_OPTIMAL(수정 불필요) 판단을 수락하여 원문을 그대로 유지했습니다.'
      );
      return;
    }

    // Step 1: Atomic Manuscript CAS Commit ONLY
    let spliceRes;
    try {
      spliceRes = validateAndSpliceRewriteSelection({
        manuscript: activeManuscriptForEval,
        replacementText: rewriteCandidate.rewrittenExcerpt,
        anchor: rewriteCandidate.anchor,
        currentRevisionId: resolvedSavedRevisionId,
      });
    } catch (err) {
      setRewriteErrorMessage(
        err instanceof Error
          ? err.message
          : '선택 구간 정합성 검증에 실패해 원고를 변경하지 않았습니다.'
      );
      return;
    }

    let commitResult: EpisodeRevisionCommitResult | void;
    try {
      commitResult = await onApplyManuscriptToEditor(
        spliceRes.splicedManuscript,
        {
          createBackupRevisionFirst: true,
          revisionLabel: `정밀 리라이팅 반영 (${rewriteCandidate.appliedModes.join(
            '+'
          )})`,
        }
      );
    } catch (err) {
      const manuscriptErr =
        err instanceof Error
          ? err.message
          : '원고 저장 중 오류가 발생하여 기존 원고와 대기 수정안을 그대로 유지했습니다.';
      setRewritePersistenceState({
        candidateId: rewriteCandidate.candidateId,
        status: 'MANUSCRIPT_COMMIT_FAILED',
        committedRevisionId: null,
        committedContentHash: null,
        manuscriptErrorMessage: manuscriptErr,
        pendingProposals: rewriteCandidate.candidateProposals,
        savedProposalIds: [],
        skippedDuplicateProposalIds: [],
        proposalErrorMessage: null,
        updatedAt: nowIso,
      });
      setRewriteErrorMessage(manuscriptErr);
      return;
    }

    // Manuscript succeeded! Immediately update local UI/editor confirmation state
    if (stagedManuscript.trim().length > 0) {
      setStagedManuscript(spliceRes.splicedManuscript);
    }
    if (linkedQualityFindingMeta) {
      handleUpdateQualityFindingDecision(
        linkedQualityFindingMeta.findingId,
        'ACCEPTED'
      );
    }
    setRewriteCandidate((prev) =>
      prev ? { ...prev, authorDecision: 'ACCEPTED' } : prev
    );
    setRewriteTargetAnchor(null);

    const committedRevisionId = commitResult?.targetRevision?.id || '';
    const committedContentHash = commitResult?.targetRevision
      ? computeManuscriptContentHash(commitResult.targetRevision.content)
      : commitResult?.episode?.contentHash ||
        computeManuscriptContentHash(spliceRes.splicedManuscript);

    // Step 2: Re-bind proposals to REAL committedRevisionId & persist idempotently (decoupled from manuscript)
    if (rewriteCandidate.candidateProposals.length === 0) {
      setRewritePersistenceState({
        candidateId: rewriteCandidate.candidateId,
        status: 'MANUSCRIPT_AND_PROPOSALS_COMMITTED',
        committedRevisionId: committedRevisionId || null,
        committedContentHash,
        manuscriptErrorMessage: null,
        pendingProposals: [],
        savedProposalIds: [],
        skippedDuplicateProposalIds: [],
        proposalErrorMessage: null,
        updatedAt: nowIso,
      });
      setStatusNotice(
        `기존 원고를 안전 백업(Revision)으로 보존한 뒤, 선택한 구간(${rewriteCandidate.appliedModes.join(
          '+'
        )})만 원고에 반영했습니다.`
      );
      return;
    }

    let reboundProposals: ChangeProposal[] = [];
    try {
      reboundProposals = rebindProposalsToCommittedRevision({
        candidateId: rewriteCandidate.candidateId,
        proposals: rewriteCandidate.candidateProposals,
        projectId: project.id,
        episodeId: episode.id,
        committedRevisionId,
      });
    } catch (err) {
      const bindErr =
        err instanceof Error
          ? err.message
          : '유효한 저장 리비전 ID가 없어 설정 제안 저장을 보류했습니다.';
      setRewritePersistenceState({
        candidateId: rewriteCandidate.candidateId,
        status: 'MANUSCRIPT_COMMITTED_PROPOSALS_PENDING',
        committedRevisionId: committedRevisionId || null,
        committedContentHash,
        manuscriptErrorMessage: null,
        pendingProposals: rewriteCandidate.candidateProposals,
        savedProposalIds: [],
        skippedDuplicateProposalIds: [],
        proposalErrorMessage: bindErr,
        updatedAt: nowIso,
      });
      setStatusNotice(
        `원고는 정상적으로 저장되었습니다. 다만 설정 변경 제안은 대기 상태입니다.`
      );
      return;
    }

    try {
      const propRes = await onSaveChangeProposals(reboundProposals, {
        requireVerifiedSourceRevision: true,
        expectedEpisodeId: episode.id,
        expectedSourceRevisionId: committedRevisionId,
        expectedSourceContentHash: committedContentHash,
      });
      if (propRes && propRes.failedCount > 0) {
        const savedIds = propRes.itemResults
          .filter((r) => r.status === 'CREATED')
          .map((r) => r.proposalId);
        const skippedIds = propRes.itemResults
          .filter(
            (r) =>
              r.status === 'SKIPPED_ALREADY_EXISTS' ||
              r.status === 'SKIPPED_ALREADY_DECIDED'
          )
          .map((r) => r.proposalId);
        const errDetail = formatProposalPersistenceErrorSummaryKo(propRes.itemResults);
        setRewritePersistenceState({
          candidateId: rewriteCandidate.candidateId,
          status: 'MANUSCRIPT_COMMITTED_PROPOSALS_PENDING',
          committedRevisionId,
          committedContentHash,
          manuscriptErrorMessage: null,
          pendingProposals: propRes.failedProposals,
          savedProposalIds: savedIds,
          skippedDuplicateProposalIds: skippedIds,
          proposalErrorMessage:
            errDetail ||
            `총 ${reboundProposals.length}건 중 ${propRes.failedCount}건의 설정 제안 저장에 실패했습니다.`,
          updatedAt: nowIso,
        });
        setStatusNotice(
          `원고는 리비전(${committedRevisionId})으로 정상 저장되었습니다. 실패한 설정 제안 ${propRes.failedCount}건만 아래에서 재시도하세요.`
        );
        return;
      }

      setRewritePersistenceState({
        candidateId: rewriteCandidate.candidateId,
        status: 'MANUSCRIPT_AND_PROPOSALS_COMMITTED',
        committedRevisionId,
        committedContentHash,
        manuscriptErrorMessage: null,
        pendingProposals: [],
        savedProposalIds: reboundProposals.map((p) => p.id),
        skippedDuplicateProposalIds: [],
        proposalErrorMessage: null,
        updatedAt: nowIso,
      });
      setStatusNotice(
        `원고(리비전 ${committedRevisionId})와 설정 변경 제안 ${reboundProposals.length}건(PROPOSED)을 안전하게 반영했습니다.`
      );
    } catch (err) {
      const propErr =
        err instanceof Error
          ? err.message
          : '후속 설정 변경 제안 저장에 실패했습니다.';
      setRewritePersistenceState({
        candidateId: rewriteCandidate.candidateId,
        status: 'MANUSCRIPT_COMMITTED_PROPOSALS_PENDING',
        committedRevisionId,
        committedContentHash,
        manuscriptErrorMessage: null,
        pendingProposals: reboundProposals,
        savedProposalIds: [],
        skippedDuplicateProposalIds: [],
        proposalErrorMessage: propErr,
        updatedAt: nowIso,
      });
      setStatusNotice(
        `원고는 리비전(${committedRevisionId})으로 정상 저장되었습니다. 실패한 설정 변경 제안만 다시 시도할 수 있습니다.`
      );
    }
  };

  const handleRejectRewriteCandidate = () => {
    if (!rewriteCandidate) return;
    setRewriteCandidate((prev) =>
      prev ? { ...prev, authorDecision: 'REJECTED' } : prev
    );
    if (linkedQualityFindingMeta) {
      handleUpdateQualityFindingDecision(
        linkedQualityFindingMeta.findingId,
        'REJECTED'
      );
    }
    setStatusNotice(
      '리라이팅 제안을 거절하고 기존 원고를 수정 없이 그대로 유지했습니다.'
    );
  };

  // ============================================================================
  // Step 7 Handler: [최종 원고 확정] & Memory Curator (Rule 10.2 & Rule 10.3)
  // ============================================================================

  const handleFinalConfirmEpisode = async () => {
    if (isBusy) return;
    const finalManuscript = activeManuscriptForEval.trim();
    if (!finalManuscript) {
      setErrorMessage('확정할 원고 본문이 비어 있습니다.');
      return;
    }

    // Rule 10.2: Block automatic confirmation if AUDIT_FAILED or unresolved CONFIRMED_CONFLICT exists
    if (
      executionState === 'BLOCKED_CONFLICT' ||
      executionState === 'BLOCKED_MISSING_INFO' ||
      executionState === 'AUDIT_FAILED'
    ) {
      setErrorMessage(
        `현재 집필/검수 상태(${executionState})에서는 원고를 확정할 수 없습니다. 검수 오류나 설정 충돌을 먼저 해결해 주세요.`
      );
      return;
    }

    const unresolvedConfirmedConflicts = reviewIssues.filter(
      (i) => i.severity === 'CONFIRMED_CONFLICT' && i.decision === 'PENDING'
    );
    if (unresolvedConfirmedConflicts.length > 0) {
      setErrorMessage(
        `미해결된 확정 설정 충돌(CONFIRMED_CONFLICT)이 ${unresolvedConfirmedConflicts.length}건 남아 있습니다. 검수 패널에서 수정안을 수락하거나 일회성 예외/설정 변경 승인을 먼저 진행해 주세요.`
      );
      return;
    }

    // Rule 10.3: Non-canon one-time exception draft requires explicit CANON_PROMOTION before becoming CANON
    if (canonClassification === 'NON_CANON_EXCEPTION') {
      setErrorMessage(
        '일회성 예외가 적용된 비정사 초안(NON_CANON_EXCEPTION)입니다. 정식 연재(CANON)로 확정하려면 상단 또는 검수 패널의 [정사 편입 승인 (CANON_PROMOTION)]을 먼저 승인해 주세요.'
      );
      return;
    }

    setErrorMessage(null);
    setWorkflowState('SAVING');

    try {
      const headers = await buildAuthHeaders();

      // 0. Server-side Author Approval (`novelforge_app_result.schema.json` -> manuscript_state: "APPROVED", canon_status: "CANON")
      const baseAppResultToApprove: NovelForgeAppResult =
        currentAppResult ??
        assembleNovelForgeAppResult({
          writerResponse: {
            manuscript_state: 'DRAFT_READY',
            manuscript: finalManuscript,
            issues: [],
            proposals: [],
          },
          context: writingContext,
        });

      const resolvedIssueIds = reviewIssues
        .filter((i) => i.decision === 'ACCEPTED' || i.decision === 'REJECTED')
        .map((i) => i.issue_id || i.id);

      const approveRes = await fetch('/api/ai/approve-result', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ownerId: project.ownerId,
          currentAppResult: baseAppResultToApprove,
          promoteToCanon: canonClassification === 'CANON_PROMOTED',
          resolvedIssueIds,
          revisedManuscript: finalManuscript,
        }),
      });
      if (approveRes.ok) {
        const approveData = await approveRes.json();
        if (approveData.appResult) {
          setCurrentAppResult(approveData.appResult as NovelForgeAppResult);
        }
      }

      // 1. Save manuscript (automatically creates backup revision first if episode was already confirmed)
      await onApplyManuscriptToEditor(finalManuscript, {
        createBackupRevisionFirst: true,
        revisionLabel: `Phase 2 최종 확정 원고 (${finalManuscript.length.toLocaleString()}자)`,
        markConfirmed: true,
      });

      // 2. Run Module E: Memory Curator to summarize episode & extract PROPOSED ChangeProposals
      const res = await fetch('/api/ai/curate-memory', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ownerId: project.ownerId,
          context: writingContext,
          confirmedManuscript: finalManuscript,
          sourceRevisionId: `rev_confirmed_${Date.now()}`,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const report = data.report as MemoryCuratorReport;
        setCuratorReport(report);
        setLastUsage(data.usageMetadata as TokenUsageMetadata);
        if (report.candidateProposals && report.candidateProposals.length > 0) {
          await onSaveChangeProposals(report.candidateProposals);
        }
        // Update episode synopsis with curated summary if synopsis was empty
        if (report.episodeSummary && !episode.synopsis.trim()) {
          await onApplyManuscriptToEditor(finalManuscript, {
            createBackupRevisionFirst: false,
            revisionLabel: '기억 관리자 회차 요약 반영',
            markConfirmed: true,
            updatedSynopsis: report.episodeSummary,
          });
        }
      }

      setExecutionState('APPROVED');
      setCanonClassification('CANON');
      setWorkflowState('APPROVED');
      setStatusNotice(
        '최종 원고가 작가 승인(manuscript_state: APPROVED · canon_status: CANON)으로 안전하게 확정 저장되었으며, 장기 기억 요약 및 신규 설정 제안(PROPOSED) 추출이 완료되었습니다.'
      );
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : '최종 원고 확정 중 오류가 발생했습니다.';
      setErrorMessage(msg);
      setWorkflowState('ERROR');
    }
  };

  const toggleCharacterSelection = (charId: string) => {
    if (!sceneCastConfirmed) {
      setSelectedCharIds([charId]);
      setSceneCastConfirmed(true);
      return;
    }
    setSceneCastConfirmed(true);
    setSelectedCharIds((prev) =>
      prev.includes(charId)
        ? prev.filter((id) => id !== charId)
        : [...prev, charId]
    );
  };

  const togglePromptSelection = (promptId: string) => {
    const target = promptProfiles.find((p) => p.id === promptId);
    if (!target || !target.isActive) {
      return;
    }
    setPromptSelectionState((prev) => {
      const currentlySelected = syncedPromptSelection.selectedIds.includes(promptId);
      const nextSelectedIds = currentlySelected
        ? syncedPromptSelection.selectedIds.filter((id) => id !== promptId)
        : [...syncedPromptSelection.selectedIds, promptId];
      const nextDeselected = currentlySelected
        ? Array.from(new Set([...prev.explicitDeselectedIds, promptId]))
        : prev.explicitDeselectedIds.filter((id) => id !== promptId);
      return {
        projectId: project.id,
        selectedIds: nextSelectedIds,
        knownIds: syncedPromptSelection.knownIds,
        hasExplicitEmptySelection: nextSelectedIds.length === 0,
        explicitDeselectedIds: nextDeselected,
      };
    });
  };

  const stateBadge = WORKFLOW_STATE_LABELS[workflowState];

  return (
    <div
      data-testid="ai-writing-studio-panel"
      className="@container rounded-xl border border-amber-500/30 bg-slate-900/95 p-5 space-y-6"
    >
      {/* Top Studio Header & Engine State Indicator */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/20 text-amber-400 border border-amber-500/40">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-slate-100">
                AI 전문 집필 스튜디오 (Phase 2 Writing Engine)
              </h2>
              <span
                data-testid="ai-workflow-state-badge"
                className={`rounded-md border px-2.5 py-0.5 text-xs font-semibold ${stateBadge.badgeClass}`}
              >
                {stateBadge.label}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              기획 승인 게이트 → 장면별 분량 통제 집필 → 문체·설정 근거 검수 → 수정안 비교 승인 → 기억 큐레이션
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isBusy && (
            <button
              type="button"
              onClick={handleCancelActiveGeneration}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/60 bg-rose-500/20 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/30 transition-colors"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
              <span>생성 중단</span>
            </button>
          )}
          <button
            type="button"
            onClick={onOpenPromptManager}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-slate-800 transition-colors"
          >
            <Sliders className="h-3.5 w-3.5" />
            <span>프롬프트 관리 ({selectedPromptIds.length}개 적용 중)</span>
          </button>
        </div>
      </div>

      {/* Status & Error Banners */}
      {errorMessage && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-lg border border-rose-500/50 bg-rose-500/10 p-3.5 text-xs text-rose-200"
        >
          <div className="flex items-start gap-2">
            <ShieldAlert className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="text-rose-300 hover:text-white shrink-0"
          >
            닫기
          </button>
        </div>
      )}

      {statusNotice && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3.5 text-xs text-emerald-200"
        >
          <div className="flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
            <span>{statusNotice}</span>
          </div>
          <button
            type="button"
            onClick={() => setStatusNotice(null)}
            className="text-emerald-300 hover:text-white shrink-0"
          >
            닫기
          </button>
        </div>
      )}

      {/* ==================================================================== */}
      {/* STEP 1 & 2: 집필 요청 입력 + 확정(CANON) 설정 및 문맥 확인 */}
      {/* ==================================================================== */}
      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-12">
        {/* Step 1: Writing Request Form (7 cols on wide panels) */}
        <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-3.5 @3xl:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-amber-400">
              1단계 · 집필 요청 및 분량·규칙 설정
            </span>
            <span className="font-mono-tabular text-[11px] text-slate-400">
              모델: {lastModelId}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 @md:grid-cols-2">
            <div className="min-w-0">
              <label
                htmlFor="ai-writing-mode-select"
                className="block text-[11px] font-medium text-slate-400 mb-1"
              >
                집필 모드
              </label>
              <select
                id="ai-writing-mode-select"
                value={writingMode}
                onChange={(e) => setWritingMode(e.target.value as WritingMode)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
              >
                <option value="FULL_EPISODE">회차 전체 집필 (장면 분할)</option>
                <option value="SINGLE_SCENE">단일 장면 집필</option>
                <option value="CONTINUE_MANUSCRIPT">현재 원고 이어쓰기</option>
                <option value="REWRITE_SELECTION">선택 영역 재작성</option>
              </select>
            </div>

            <div className="min-w-0">
              <label
                htmlFor="ai-pov-select"
                className="block text-[11px] font-medium text-slate-400 mb-1"
              >
                서술 시점
              </label>
              <select
                id="ai-pov-select"
                value={narrativePerspective}
                onChange={(e) =>
                  setNarrativePerspective(e.target.value as NarrativePerspective)
                }
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
              >
                <option value="THIRD_LIMITED">3인칭 제한 시점</option>
                <option value="FIRST_PERSON">1인칭 주인공 시점</option>
                <option value="OMNISCIENT">3인칭 전지적 시점</option>
                <option value="MIXED">복합 시점</option>
              </select>
            </div>

            <div className="min-w-0 @md:col-span-2">
              <label
                htmlFor="ai-target-ep-chars"
                className="block text-[11px] font-medium text-slate-400 mb-1"
              >
                목표 글자 수 (회차 / 장면)
              </label>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[11px] text-slate-400 shrink-0">회차</span>
                  <input
                    id="ai-target-ep-chars"
                    type="number"
                    min={500}
                    max={20000}
                    step={250}
                    value={targetEpisodeCharCount}
                    onChange={(e) =>
                      setTargetEpisodeCharCount(
                        Math.max(500, parseInt(e.target.value || '5000', 10))
                      )
                    }
                    aria-label="회차 목표 글자 수"
                    className="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-mono-tabular text-xs text-slate-100"
                  />
                </div>
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[11px] text-slate-400 shrink-0">장면</span>
                  <input
                    id="ai-target-scene-chars"
                    type="number"
                    min={300}
                    max={6000}
                    step={100}
                    value={targetSceneCharCount}
                    onChange={(e) =>
                      setTargetSceneCharCount(
                        Math.max(300, parseInt(e.target.value || '1750', 10))
                      )
                    }
                    aria-label="장면 목표 글자 수"
                    className="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-mono-tabular text-xs text-slate-100"
                  />
                </div>
              </div>
            </div>
          </div>

          <div>
            <label
              htmlFor="ai-plot-outline-input"
              className="block text-[11px] font-medium text-slate-300 mb-1"
            >
              이번 회차 줄거리 및 목표 전개
            </label>
            <textarea
              id="ai-plot-outline-input"
              rows={2}
              value={plotOutline}
              onChange={(e) => setPlotOutline(e.target.value)}
              placeholder="이번 회차에서 반드시 일어나야 할 중심 줄거리를 입력하세요."
              className="w-full rounded-lg border border-slate-800 bg-slate-900 p-2.5 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="ai-required-events-input"
                className="block text-[11px] font-medium text-slate-300 mb-1"
              >
                필수 포함 사건 (줄바꿈 구분)
              </label>
              <textarea
                id="ai-required-events-input"
                rows={3}
                value={requiredEventsText}
                onChange={(e) => setRequiredEventsText(e.target.value)}
                className="w-full rounded-lg border border-slate-800 bg-slate-900 p-2 text-xs text-slate-200 focus:border-amber-500 focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="ai-forbidden-events-input"
                className="block text-[11px] font-medium text-rose-300 mb-1"
              >
                금지 전개 / 설정 제약 (줄바꿈 구분)
              </label>
              <textarea
                id="ai-forbidden-events-input"
                rows={3}
                value={forbiddenDevelopmentsText}
                onChange={(e) => setForbiddenDevelopmentsText(e.target.value)}
                className="w-full rounded-lg border border-slate-800 bg-slate-900 p-2 text-xs text-slate-200 focus:border-amber-500 focus:outline-none"
              />
            </div>
          </div>

          {writingMode === 'REWRITE_SELECTION' && (
            <div>
              <label
                htmlFor="ai-rewrite-selection-input"
                className="block text-[11px] font-medium text-amber-300 mb-1"
              >
                재작성할 원고 구간 (복사하여 붙여넣기)
              </label>
              <textarea
                id="ai-rewrite-selection-input"
                rows={3}
                value={selectedTextToRewrite}
                onChange={(e) => setSelectedTextToRewrite(e.target.value)}
                placeholder="원고에서 재작성할 문단을 붙여넣으세요."
                className="w-full rounded-lg border border-amber-500/40 bg-slate-900 p-2 text-xs text-slate-100"
              />
            </div>
          )}
        </div>

        {/* Step 2: Context & Canon Setting Check (5 cols on wide panels) */}
        <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-3 @3xl:col-span-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-amber-400">
              2단계 · 확정 설정(CANON) 및 문맥 점검
            </span>
            <span className="font-mono-tabular text-[11px] text-emerald-400">
              출처 {writingContext.referencedSources.length}건 연결됨
            </span>
          </div>

          {/* Character Selection with CANON badge */}
          <div>
            <div className="text-[11px] font-medium text-slate-300 mb-1.5">
              집필 투입 등장인물 선택 (확정 CANON 설정만 근거로 반영됨)
            </div>
            <label className="mb-2 block text-xs text-slate-400">
              <input type="checkbox" checked={sceneCastConfirmed} onChange={(event) => setSceneCastConfirmed(event.target.checked)} /> 선택한 인물을 현재 장면의 화법 적용 범위로 확인
            </label>
            <div className="flex flex-wrap gap-1.5">
              {characters.map((ch) => {
                const selected = selectedCharIds.includes(ch.id);
                const isCanon = ch.status === 'confirmed';
                return (
                  <button
                    key={ch.id}
                    type="button"
                    onClick={() => toggleCharacterSelection(ch.id)}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                      selected
                        ? 'border-amber-500/60 bg-amber-500/15 text-slate-100'
                        : 'border-slate-800 bg-slate-900 text-slate-400'
                    }`}
                  >
                    <span>{ch.name.split(' (')[0]}</span>
                    <span
                      className={`rounded px-1 py-0.2 text-[10px] font-semibold ${
                        isCanon
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {isCanon ? 'CANON' : 'DRAFT'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* P0-A2: Project Style Profile Active Application Status Strip */}
          <div
            data-testid="writer-style-profile-status-strip"
            className="rounded-lg border border-slate-800 bg-slate-900/80 p-3 space-y-1.5 text-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-slate-200">
                작품 문체 프로필 적용 상태
              </span>
              {primaryStylePromptProfile ? (
                <span
                  data-testid="writer-style-profile-applied-indicator"
                  className={`font-mono text-[11px] font-semibold tabular-nums ${
                    primaryStylePromptProfile.isActive &&
                    selectedPromptIds.includes(primaryStylePromptProfile.id) &&
                    writingContext.activePrompts.some(
                      (ap) => ap.profileId === primaryStylePromptProfile.id
                    )
                      ? 'text-emerald-400'
                      : 'text-amber-300'
                  }`}
                >
                  이번 집필에 적용:{' '}
                  {primaryStylePromptProfile.isActive &&
                  selectedPromptIds.includes(primaryStylePromptProfile.id) &&
                  writingContext.activePrompts.some(
                    (ap) => ap.profileId === primaryStylePromptProfile.id
                  )
                    ? 'YES'
                    : 'NO'}
                </span>
              ) : (
                <span
                  data-testid="writer-style-profile-applied-indicator"
                  className="font-mono text-[11px] text-slate-400 tabular-nums"
                >
                  이번 집필에 적용: NO
                </span>
              )}
            </div>

            {primaryStylePromptProfile ? (
              <div className="space-y-1 text-[11px]">
                <div className="flex flex-wrap items-center justify-between gap-2 text-slate-300">
                  <span className="truncate font-medium text-slate-100">
                    {primaryStylePromptProfile.title}
                  </span>
                  <span className="font-mono text-slate-300 tabular-nums">
                    상태:{' '}
                    <strong
                      className={
                        primaryStylePromptProfile.isActive
                          ? 'text-emerald-400'
                          : 'text-slate-400'
                      }
                    >
                      {primaryStylePromptProfile.isActive ? 'ACTIVE' : 'INACTIVE'}
                    </strong>{' '}
                    · 버전: v{primaryStylePromptProfile.currentVersionNumber} (
                    {primaryStylePromptProfile.currentVersionId})
                  </span>
                </div>
                {!primaryStylePromptProfile.isActive && (
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-amber-300">
                    <span>
                      현재 문체 프로필이 비활성(INACTIVE) 상태여서 집필·리라이팅 프롬프트에 주입되지 않습니다.
                    </span>
                    <button
                      type="button"
                      onClick={onOpenPromptManager}
                      className="underline font-semibold text-amber-200 hover:text-white whitespace-nowrap"
                    >
                      프롬프트 관리기에서 활성화하기 →
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
                <span>승인된 작품 문체 프로필(PROJECT_STYLE_PROFILE)이 없습니다.</span>
                <button
                  type="button"
                  onClick={onOpenPromptManager}
                  className="underline text-amber-300 hover:text-amber-200 whitespace-nowrap"
                >
                  문체 DNA 분석기 열기 →
                </button>
              </div>
            )}
          </div>

          {/* Active Prompt Profiles Selector */}
          <div>
            <div className="flex items-center justify-between text-[11px] font-medium text-slate-300 mb-1.5">
              <span>적용할 프롬프트 템플릿 선택 (활성 프롬프트만 적용 가능)</span>
              <span className="font-mono text-[10px] text-slate-400 tabular-nums">
                적용 {writingContext.activePrompts.length}건
              </span>
            </div>
            <div className="max-h-32 space-y-1 overflow-y-auto pr-1">
              {promptProfiles
                .filter(
                  (p) => p.projectId === project.id || p.projectId === 'GLOBAL'
                )
                .map((p) => {
                  const checked =
                    p.isActive && selectedPromptIds.includes(p.id);
                  return (
                    <label
                      key={p.id}
                      className={`flex items-center justify-between gap-2 rounded border px-2.5 py-1 text-[11px] ${
                        p.isActive
                          ? 'border-slate-800/90 bg-slate-900/70 text-slate-200 cursor-pointer'
                          : 'border-slate-800/50 bg-slate-950/50 text-slate-500 cursor-not-allowed'
                      }`}
                    >
                      <span className="truncate">
                        <strong
                          className={
                            p.isActive ? 'text-amber-300' : 'text-slate-500'
                          }
                        >
                          [{p.promptType}]
                        </strong>{' '}
                        {p.title}{' '}
                        <span className="font-mono text-[10px] text-slate-400 tabular-nums">
                          (v{p.currentVersionNumber} ·{' '}
                          {p.isActive ? 'ACTIVE' : 'INACTIVE'})
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!p.isActive}
                        onChange={() => togglePromptSelection(p.id)}
                        className="accent-amber-500 disabled:opacity-40"
                      />
                    </label>
                  );
                })}
            </div>
          </div>

          {/* Previous Episode Continuity & Missing Evidence Notes */}
          <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2.5 text-[11px] space-y-1.5">
            <div className="text-slate-300">
              <strong className="text-sky-300">직전 회차 문맥:</strong>{' '}
              {writingContext.previousEpisodeSummary}
            </div>
            <div className="text-slate-400">
              확정 세계관 법칙:{' '}
              {writingContext.canonWorldbuilding.map((w) => w.title).join(', ') ||
                '없음'}
            </div>
            {writingContext.missingEvidenceNotes.length > 0 && (
              <div className="text-amber-300/90">
                ※ 참고: {writingContext.missingEvidenceNotes[0]}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ==================================================================== */}
      {/* STEP 3: [AI 기획안 작성] 및 [기획안 승인] 게이트 */}
      {/* ==================================================================== */}
      <div className="rounded-xl border border-slate-800 bg-slate-950/90 p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-amber-400" />
            <span className="text-xs font-bold uppercase tracking-wider text-amber-400">
              3단계 · 장면 기획기 (Plot Planner) 및 작가 승인 게이트
            </span>
            {currentPlan && (
              <span
                data-testid="plan-approval-status"
                className={`rounded px-2 py-0.5 text-[11px] font-bold ${
                  currentPlan.status === 'APPROVED'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                }`}
              >
                {currentPlan.status === 'APPROVED'
                  ? '작가 승인 완료 (집필 가능)'
                  : '승인 대기 중 (집필 잠금)'}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleGeneratePlotPlan}
              disabled={isBusy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50 transition-colors"
            >
              {workflowState === 'PLANNING' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wand2 className="h-3.5 w-3.5" />
              )}
              <span>AI 기획안 작성</span>
            </button>

            {currentPlan && currentPlan.status !== 'APPROVED' && (
              <button
                type="button"
                onClick={handleApprovePlan}
                disabled={isBusy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50 transition-colors"
              >
                <Check className="h-3.5 w-3.5" />
                <span>기획안 승인</span>
              </button>
            )}
          </div>
        </div>

        {!currentPlan ? (
          <div className="rounded-lg border border-slate-800/80 bg-slate-900/50 p-4 text-xs text-slate-400">
            작가가 기획안을 승인하기 전에는 회차/장면 본문 집필을 시작하지 않습니다.{' '}
            <strong className="text-amber-300">[AI 기획안 작성]</strong>을 눌러 장면 구성을 생성하거나, 기존 원고의{' '}
            <strong className="text-sky-300">[이어쓰기]</strong>를 사용할 수 있습니다.
          </div>
        ) : (
          <div className="space-y-3">
            {currentPlan.plotDeviationWarnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200 space-y-1">
                <div className="font-semibold text-amber-300 flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span>플롯 및 확정 설정 주의사항</span>
                </div>
                <ul className="list-disc pl-4 space-y-0.5">
                  {currentPlan.plotDeviationWarnings.map((w, idx) => (
                    <li key={idx}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {currentPlan.scenes.map((sc) => (
                <div
                  key={sc.sceneNumber}
                  className="rounded-lg border border-slate-800 bg-slate-900/90 p-3 text-xs space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono-tabular font-bold text-amber-400">
                      제{sc.sceneNumber}장면
                    </span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-slate-400">목표 글자 수:</span>
                      <input
                        type="number"
                        min={300}
                        max={8000}
                        step={100}
                        value={sc.targetCharCount}
                        onChange={(e) =>
                          handleUpdateSceneInPlan(sc.sceneNumber, {
                            targetCharCount: Math.max(
                              300,
                              parseInt(e.target.value || '1500', 10)
                            ),
                          })
                        }
                        aria-label={`제${sc.sceneNumber}장면 목표 글자 수`}
                        className="w-20 rounded border border-slate-700 bg-slate-950 px-2 py-0.5 font-mono-tabular text-xs text-slate-100"
                      />
                      <span className="text-[11px] text-slate-400">자</span>
                    </div>
                  </div>

                  <input
                    type="text"
                    value={sc.title}
                    onChange={(e) =>
                      handleUpdateSceneInPlan(sc.sceneNumber, {
                        title: e.target.value,
                      })
                    }
                    aria-label={`제${sc.sceneNumber}장면 제목`}
                    className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs font-semibold text-slate-100"
                  />

                  <textarea
                    rows={2}
                    value={sc.purpose}
                    onChange={(e) =>
                      handleUpdateSceneInPlan(sc.sceneNumber, {
                        purpose: e.target.value,
                      })
                    }
                    aria-label={`제${sc.sceneNumber}장면 목적`}
                    className="w-full rounded border border-slate-800 bg-slate-950 p-2 text-[11px] text-slate-300"
                  />

                  <div className="flex flex-wrap items-center justify-between gap-1 text-[11px] text-slate-400">
                    <span>등장: {sc.characterNames.join(', ') || '주요 인물'}</span>
                    <span>감정선: {sc.emotionalArc}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ==================================================================== */}
      {/* STEP 4: 본문 집필기 (Novel Writer) & 실시간 글자 수 목표 제어 */}
      {/* ==================================================================== */}
      <div className="rounded-xl border border-slate-800 bg-slate-950/90 p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Play className="h-4 w-4 text-sky-400" />
            <span className="text-xs font-bold uppercase tracking-wider text-sky-400">
              4단계 · 본문 집필 (Novel Writer) 및 목표 글자 수 제어
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {currentPlan && currentPlan.scenes.length > 0 && (
              <select
                value={selectedSceneNumToWrite}
                onChange={(e) =>
                  setSelectedSceneNumToWrite(parseInt(e.target.value, 10))
                }
                aria-label="생성할 장면 번호 선택"
                className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200"
              >
                {currentPlan.scenes.map((s) => (
                  <option key={s.sceneNumber} value={s.sceneNumber}>
                    제{s.sceneNumber}장면: {s.title}
                  </option>
                ))}
              </select>
            )}

            <button
              type="button"
              onClick={() =>
                handleExecuteWriting({
                  overrideMode: 'SINGLE_SCENE',
                  targetSceneNumber: selectedSceneNumToWrite,
                })
              }
              disabled={isBusy || !currentPlan || currentPlan.status !== 'APPROVED'}
              className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-40 transition-colors"
            >
              <Play className="h-3.5 w-3.5" />
              <span>장면별 원고 생성</span>
            </button>

            <button
              type="button"
              onClick={() =>
                handleExecuteWriting({ overrideMode: 'FULL_EPISODE' })
              }
              disabled={isBusy || !currentPlan || currentPlan.status !== 'APPROVED'}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40 transition-colors"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>회차 전체 집필</span>
            </button>

            <button
              type="button"
              onClick={() =>
                handleExecuteWriting({ overrideMode: 'CONTINUE_MANUSCRIPT' })
              }
              disabled={isBusy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40 transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5 text-sky-400" />
              <span>이어쓰기</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setWritingMode('REWRITE_SELECTION');
                if (selectedTextToRewrite.trim()) {
                  handleExecuteWriting({ overrideMode: 'REWRITE_SELECTION' });
                }
              }}
              disabled={isBusy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40 transition-colors"
            >
              <Wand2 className="h-3.5 w-3.5 text-amber-400" />
              <span>선택 영역 재작성</span>
            </button>
          </div>
        </div>

        {/* Programmatic Character Count Evaluation & Expansion Controls */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/90 p-3.5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-slate-200">
                프로그래밍 실측 분량:
              </span>
              <span className="font-mono-tabular font-bold text-amber-400">
                공백 포함 {lengthEvaluation.charCountWithSpaces.toLocaleString()}자
              </span>
              <span className="text-slate-500">·</span>
              <span className="font-mono-tabular text-slate-300">
                공백 제외 {lengthEvaluation.charCountWithoutSpaces.toLocaleString()}자
              </span>
            </div>

            <span
              data-testid="length-eval-status"
              className={`rounded px-2 py-0.5 font-mono-tabular text-[11px] font-semibold ${
                lengthEvaluation.withinTolerance
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : lengthEvaluation.status === 'SHORT'
                  ? 'bg-amber-500/20 text-amber-300'
                  : 'bg-sky-500/20 text-sky-300'
              }`}
            >
              {lengthEvaluation.statusMessageKo}
            </span>
          </div>

          {/* 4 Scene Expansion Buttons (Always available so author can expand scene/dialogue/psychology/action) */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-[11px] text-slate-400">분량 보강 도구:</span>
            <button
              type="button"
              disabled={isBusy}
              onClick={() =>
                handleExecuteWriting({ expansionAction: 'EXPAND_SCENE' })
              }
              className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-slate-200 hover:border-amber-500/50 hover:text-amber-300 disabled:opacity-40"
            >
              <Sparkles className="h-3 w-3 text-amber-400" />
              <span>현재 장면 확장</span>
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() =>
                handleExecuteWriting({ expansionAction: 'BOOST_DIALOGUE' })
              }
              className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-slate-200 hover:border-amber-500/50 hover:text-amber-300 disabled:opacity-40"
            >
              <MessageSquarePlus className="h-3 w-3 text-sky-400" />
              <span>대화 보강</span>
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() =>
                handleExecuteWriting({ expansionAction: 'BOOST_PSYCHOLOGY' })
              }
              className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-slate-200 hover:border-amber-500/50 hover:text-amber-300 disabled:opacity-40"
            >
              <BookCheck className="h-3 w-3 text-purple-400" />
              <span>심리 묘사 보강</span>
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() =>
                handleExecuteWriting({ expansionAction: 'BOOST_ACTION' })
              }
              className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-slate-200 hover:border-amber-500/50 hover:text-amber-300 disabled:opacity-40"
            >
              <Flame className="h-3 w-3 text-rose-400" />
              <span>행동 묘사 보강</span>
            </button>
          </div>
        </div>

        {/* Staged Generated Manuscript Preview (Non-destructive staging area) */}
        {stagedManuscript && (
          <div className="rounded-lg border border-amber-500/40 bg-slate-900 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-semibold text-amber-300">
                AI 생성 초안 미리보기 (기존 확정 원고를 즉시 덮어쓰지 않고 임시 보관 중)
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await onApplyManuscriptToEditor(stagedManuscript, {
                        createBackupRevisionFirst: true,
                        revisionLabel: `AI 초안 반영 전 자동 백업`,
                      });
                      setStatusNotice(
                        '기존 원고를 버전 기록에 백업한 뒤, 생성된 초안을 에디터에 반영했습니다.'
                      );
                    } catch (err) {
                      setErrorMessage(
                        err instanceof Error
                          ? err.message
                          : 'AI 초안 저장 중 오류가 발생하여 기존 원고와 임시 초안을 보존했습니다.'
                      );
                    }
                  }}
                  className="rounded-md bg-amber-500 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-amber-400"
                >
                  에디터 본문에 반영 (안전 백업 포함)
                </button>
                <button
                  type="button"
                  onClick={() => setStagedManuscript('')}
                  className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800"
                >
                  초안 비우기
                </button>
              </div>
            </div>
            <textarea
              rows={8}
              value={stagedManuscript}
              onChange={(e) => setStagedManuscript(e.target.value)}
              aria-label="AI 생성 초안 임시 편집기"
              className="w-full rounded-lg border border-slate-800 bg-slate-950 p-3 font-serif-kr text-sm leading-relaxed text-slate-100"
            />
          </div>
        )}
      </div>

      {/* ==================================================================== */}
      {/* STEP 5 & 6: [문체 검수], [설정 검수] 및 [수정안 비교] */}
      {/* ==================================================================== */}
      <div className="rounded-xl border border-slate-800 bg-slate-950/90 p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <ListChecks className="h-4 w-4 text-purple-400" />
            <span className="text-xs font-bold uppercase tracking-wider text-purple-400">
              5·6단계 · 독립 검수 (Style Editor / Continuity Checker) · 상태 분리 및 수정안 비교
            </span>
            <span
              data-testid="audit-continuity-badge"
              className="rounded border border-slate-700 bg-slate-900 px-2 py-0.5 font-mono-tabular text-[10px] text-slate-300"
            >
              설정검수: {auditState.continuityAuditStatus}
            </span>
            <span
              data-testid="audit-style-badge"
              className="rounded border border-slate-700 bg-slate-900 px-2 py-0.5 font-mono-tabular text-[10px] text-slate-300"
            >
              문체검수: {auditState.styleAuditStatus}
            </span>
            {canonClassification === 'NON_CANON_EXCEPTION' && (
              <span className="rounded border border-amber-500/50 bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-200">
                비정사 예외 초안 (NON_CANON_EXCEPTION)
              </span>
            )}
            {canonClassification === 'CANON_PROMOTED' && (
              <span className="rounded border border-emerald-500/50 bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-200">
                정사 편입 승인됨 (CANON_PROMOTED)
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canonClassification === 'NON_CANON_EXCEPTION' && (
              <button
                type="button"
                onClick={handlePromoteExceptionDraftToCanon}
                className="rounded-lg border border-amber-500/60 bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/30"
              >
                정사 편입 승인 (CANON_PROMOTION)
              </button>
            )}
            <button
              type="button"
              disabled={isBusy}
              onClick={() => handleRunReview('STYLE_ONLY')}
              className="rounded-lg border border-purple-500/40 bg-purple-500/15 px-3 py-1.5 text-xs font-semibold text-purple-200 hover:bg-purple-500/25 disabled:opacity-40"
            >
              문체 검수
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => handleRunReview('CONTINUITY_ONLY')}
              className="rounded-lg border border-sky-500/40 bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-500/25 disabled:opacity-40"
            >
              설정 검수
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => setShowDiffPreview((prev) => !prev)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              수정안 비교 ({reviewIssues.length})
            </button>
          </div>
        </div>

        {showDiffPreview && (
          <div className="space-y-3">
            {reviewIssues.length === 0 ? (
              <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 text-xs text-slate-400">
                현재 표시할 검수 리포트가 없습니다. [문체 검수] 또는 [설정 검수]를 실행하세요.
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900 p-2.5 text-xs">
                  <span className="text-slate-300">
                    검출된 이슈 총 {reviewIssues.length}건 (수락됨:{' '}
                    {
                      reviewIssues.filter((i) => i.decision === 'ACCEPTED')
                        .length
                    }
                    건)
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleAcceptAllIssues}
                      className="rounded bg-emerald-500/20 px-2.5 py-1 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/30"
                    >
                      전체 수락
                    </button>
                    <button
                      type="button"
                      onClick={handleRejectAllIssues}
                      className="rounded bg-slate-800 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-700"
                    >
                      원본 유지 (전체 거절)
                    </button>
                    <button
                      type="button"
                      onClick={handleCommitAcceptedIssuesToStage}
                      className="rounded bg-amber-500 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-amber-400"
                    >
                      수락한 수정안 원고에 적용 ({diffPreviewResult.appliedCount}건)
                    </button>
                  </div>
                </div>

                <div className="space-y-2.5 max-h-96 overflow-y-auto pr-1">
                  {reviewIssues.map((iss) => {
                    const sevBadge =
                      iss.severity === 'CONFIRMED_CONFLICT'
                        ? {
                            label: '확정 설정 충돌 (CONFIRMED_CONFLICT)',
                            cls: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
                          }
                        : iss.severity === 'POTENTIAL_CONFLICT'
                        ? {
                            label: '충돌 가능성 (POTENTIAL_CONFLICT)',
                            cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
                          }
                        : {
                            label: '판단 정보 부족 (INSUFFICIENT_DATA)',
                            cls: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
                          };

                    return (
                      <div
                        key={iss.id}
                        className="rounded-lg border border-slate-800 bg-slate-900 p-3.5 text-xs space-y-2"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-bold text-slate-200">
                              {iss.sourceModule === 'STYLE_EDITOR'
                                ? '독립 문체 교정'
                                : iss.sourceModule === 'NOVEL_WRITER_SELF_CHECK'
                                ? '집필 자체 점검'
                                : '독립 설정 검수'}
                            </span>
                            <span
                              className={`rounded border px-2 py-0.5 text-[10px] font-semibold ${sevBadge.cls}`}
                            >
                              {sevBadge.label}
                            </span>
                            <span className="font-semibold text-slate-200">
                              {iss.category}
                            </span>
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5">
                            {iss.severity === 'CONFIRMED_CONFLICT' && (
                              <button
                                type="button"
                                onClick={() => handleGrantOneTimeException(iss)}
                                className="inline-flex items-center gap-1 rounded border border-amber-500/50 bg-amber-500/15 px-2 py-1 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/25"
                              >
                                <span>일회성 예외 승인</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                handleIssueDecision(iss.id, 'ACCEPTED')
                              }
                              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold ${
                                iss.decision === 'ACCEPTED'
                                  ? 'bg-emerald-500 text-slate-950'
                                  : 'border border-slate-700 text-slate-300 hover:bg-slate-800'
                              }`}
                            >
                              <Check className="h-3 w-3" />
                              <span>개별 수락</span>
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                handleIssueDecision(iss.id, 'REJECTED')
                              }
                              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold ${
                                iss.decision === 'REJECTED'
                                  ? 'bg-rose-500 text-white'
                                  : 'border border-slate-700 text-slate-300 hover:bg-slate-800'
                              }`}
                            >
                              <X className="h-3 w-3" />
                              <span>개별 거절</span>
                            </button>
                          </div>
                        </div>

                        <p className="text-slate-300">{iss.description}</p>
                        <div className="flex flex-wrap items-center gap-3 text-[11px] text-amber-300/90">
                          <span>관련 설정 근거: {iss.relatedCanonReference}</span>
                          {(iss.referenceLoreId || iss.reference_lore_id) && (
                            <span className="font-mono-tabular text-sky-300">
                              reference_lore_id: {iss.referenceLoreId || iss.reference_lore_id}
                            </span>
                          )}
                          {(iss.manuscriptLocation || iss.manuscript_location) && (
                            <span className="font-mono-tabular text-slate-400">
                              manuscript_location: {iss.manuscriptLocation || iss.manuscript_location}
                            </span>
                          )}
                        </div>

                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 pt-1">
                          <div className="rounded border border-rose-500/30 bg-rose-500/5 p-2">
                            <div className="text-[10px] font-semibold text-rose-300 mb-1">
                              원문 발췌
                            </div>
                            <div className="text-slate-200">
                              {iss.manuscriptExcerpt || '(원문 전체 대상)'}
                            </div>
                          </div>
                          <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-2">
                            <div className="text-[10px] font-semibold text-emerald-300 mb-1">
                              교정 제안 문장
                            </div>
                            <div className="text-slate-100">
                              {iss.replacementText || iss.suggestedFix}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ==================================================================== */}
      {/* PHASE 4.3A: [원고 품질 진단] (Literary Quality Engine Q1~Q8)           */}
      {/* ==================================================================== */}
      <LiteraryQualityPanel
        activeManuscript={activeManuscriptForEval}
        currentRevisionId={activeQualityRevisionId}
        isBusy={isBusy}
        isEvaluating={isEvaluatingQuality}
        report={qualityReport}
        errorMessage={qualityErrorMessage}
        onRunEvaluation={handleRunLiteraryQualityEvaluation}
        onUpdateFindingDecision={handleUpdateQualityFindingDecision}
        onBulkDecision={handleBulkQualityDecision}
        onApplyRevisedManuscript={handleApplyQualityRevisions}
        onRequestRewriteForFinding={handleRequestRewriteFromQualityFinding}
      />
      <NovelWritingEvaluationPanel key={project.ownerId} getIdToken={getIdToken} />

      {/* ==================================================================== */}
      {/* PHASE 4.3B: [정밀 문학 리라이팅] (R1~R6 · 원고 보호 · 작가 승인)      */}
      {/* ==================================================================== */}
      <section
        id="literary-rewrite-panel"
        data-testid="literary-rewrite-panel"
        className="rounded-xl border border-indigo-500/30 bg-slate-950/90 p-4 space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Wand2 className="h-4 w-4 text-indigo-400" />
              <span className="text-xs font-bold uppercase tracking-wider text-indigo-300">
                4.3B · 정밀 문학 리라이팅 (R1~R6 · 선택 구간 앵커 보호)
              </span>
              <span className="font-mono-tabular text-[11px] text-slate-400">
                기준 리비전: {resolvedSavedRevisionId || 'UNSAVED_DRAFT'}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-slate-400">
              선택된 구간만 UTF-16 오프셋·해시로 잠금 수정하며, 비선택 영역과 확정 설정·시점·캐릭터 말투를 보존합니다.
            </p>
          </div>

          <button
            type="button"
            onClick={handleCaptureSelectionForRewrite}
            disabled={isBusy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/15 px-3 py-1.5 text-xs font-semibold text-indigo-200 hover:bg-indigo-500/25 disabled:opacity-40"
          >
            <Wand2 className="h-3.5 w-3.5" />
            <span>에디터 선택 구간 가져오기</span>
          </button>
        </div>

        {linkedQualityFindingMeta && (
          <div className="rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-200 flex flex-wrap items-center justify-between gap-2">
            <span>
              품질 진단 연계: <strong>{linkedQualityFindingMeta.dimension}</strong> ·{' '}
              {linkedQualityFindingMeta.summary}
            </span>
            <button
              type="button"
              onClick={() => setLinkedQualityFindingMeta(null)}
              className="text-[11px] text-indigo-300 hover:text-white underline"
            >
              연계 해제
            </button>
          </div>
        )}

        {/* Selected Target Excerpt Box */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-slate-200">
              대상 선택 구간 {rewriteTargetAnchor ? `(${rewriteTargetAnchor.startOffset}~${rewriteTargetAnchor.endOffset}자)` : '(미지정)'}
            </span>
            {editorSelection && (
              <span className="font-mono-tabular text-[11px] text-amber-300">
                현재 에디터 커서 선택: {editorSelection.startOffset}~{editorSelection.endOffset}자 ({editorSelection.excerpt.length}자)
              </span>
            )}
          </div>
          {rewriteTargetAnchor ? (
            <div
              data-testid="rewrite-anchor-excerpt"
              className="rounded border border-slate-800 bg-slate-950 p-2.5 text-xs text-slate-200 whitespace-pre-wrap break-words max-h-32 overflow-y-auto"
            >
              {rewriteTargetAnchor.originalExcerpt}
            </div>
          ) : (
            <div className="text-xs text-slate-500">
              원고 본문에서 수정할 구간을 드래그한 뒤 [에디터 선택 구간 가져오기]를 누르거나, 위 품질 진단 카드에서 [정밀 리라이팅]을 클릭하세요.
            </div>
          )}
        </div>

        {/* R1-R6 Mode Selector Grid */}
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-slate-300">
            리라이팅 모드 선택 (단일 또는 다중 조합)
          </div>
          <div className="grid grid-cols-1 gap-2 @md:grid-cols-2 @2xl:grid-cols-3">
            {LITERARY_REWRITE_MODE_ORDER.map((modeId) => {
              const meta = LITERARY_REWRITE_MODES[modeId];
              const active = rewriteModes.includes(modeId);
              return (
                <button
                  key={modeId}
                  type="button"
                  data-testid={`rewrite-mode-btn-${modeId}`}
                  onClick={() => handleToggleRewriteMode(modeId)}
                  className={`rounded-lg border p-2.5 text-left text-xs transition-colors ${
                    active
                      ? 'border-indigo-400 bg-indigo-500/20 text-indigo-100'
                      : 'border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700'
                  }`}
                >
                  <div className="font-semibold flex items-start justify-between gap-2">
                    <span className="leading-snug">
                      {modeId} · {meta.shortLabelKo}
                    </span>
                    {active && <Check className="h-3.5 w-3.5 text-indigo-300 shrink-0 mt-0.5" />}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-400 leading-snug">
                    {meta.descriptionKo}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Author Rewrite Instruction & Trigger */}
        <div className="space-y-2.5">
          <label className="inline-flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              data-testid="rewrite-allow-unverified-typo-checkbox"
              checked={allowUnverifiedTypoOnlyPreview}
              onChange={(e) =>
                setAllowUnverifiedTypoOnlyPreview(e.target.checked)
              }
              disabled={isBusy}
              className="accent-indigo-400"
            />
            <span>
              서버 CANON 미연결(UNAVAILABLE) 시 오탈자·문장 다듬기 전용(UNVERIFIED) 미리보기 허용
            </span>
          </label>

          <div className="flex flex-col gap-2.5 @xl:flex-row @xl:items-end">
            <div className="flex-1 min-w-0">
              <label
                htmlFor="literary-rewrite-instruction"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                작가 세부 지시사항 (선택)
              </label>
              <input
                id="literary-rewrite-instruction"
                type="text"
                value={rewriteInstruction}
                onChange={(e) => setRewriteInstruction(e.target.value)}
                placeholder="예: 카엘의 경계심과 냉소적 말투를 살리면서 감각 묘사를 보강해 주세요."
                className="w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600 focus:border-indigo-400 focus:outline-none"
              />
            </div>
            <button
              type="button"
              data-testid="run-literary-rewrite-btn"
              disabled={isBusy || !rewriteTargetAnchor}
              onClick={handleRunLiteraryRewrite}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-500 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-400 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              {isRewritingLiterary ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              <span>
                {isRewritingLiterary ? '정밀 리라이팅 생성 중...' : '선택 구간 리라이팅 생성'}
              </span>
            </button>
          </div>
        </div>

        {/* P0-A: Server-Verified CANON Evidence Report Badge */}
        {rewriteCanonEvidence && (
          <div
            data-testid="rewrite-canon-evidence-badge"
            className={`rounded-lg border p-2.5 text-xs space-y-1 ${
              rewriteCanonEvidence.status === 'UNAUTHORIZED' ||
              rewriteCanonEvidence.status === 'STALE'
                ? 'border-rose-500/50 bg-rose-500/10 text-rose-200'
                : rewriteCanonEvidence.status === 'UNAVAILABLE'
                ? 'border-amber-500/50 bg-amber-500/10 text-amber-200'
                : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">
                CANON 근거 검증: {rewriteCanonEvidence.status} ({rewriteCanonEvidence.verificationMode})
              </span>
              <span className="font-mono-tabular text-[11px] opacity-85">
                검증 출처 {rewriteCanonEvidence.verifiedSourceIds.length}건 · 해시 {rewriteCanonEvidence.canonStateHash.slice(0, 12)}
              </span>
            </div>
            {rewriteCanonEvidence.missingEvidenceNotes.length > 0 && (
              <div className="text-[11px] opacity-90">
                {rewriteCanonEvidence.missingEvidenceNotes[0]}
              </div>
            )}
          </div>
        )}

        {/* P0-B: Manuscript Committed, Proposals Pending Recovery Banner */}
        {rewritePersistenceState?.status === 'MANUSCRIPT_COMMITTED_PROPOSALS_PENDING' && (
          <div
            data-testid="rewrite-partial-proposal-banner"
            className="rounded-lg border border-amber-500/60 bg-amber-500/15 p-3 text-xs text-amber-100 space-y-2"
          >
            <div className="font-semibold text-amber-300">
              원고 저장 완료(리비전 {rewritePersistenceState.committedRevisionId}) · 후속 설정 변경 제안 {rewritePersistenceState.pendingProposals.length}건만 대기 중
            </div>
            <div className="text-[11px] text-amber-200/90">
              {rewritePersistenceState.proposalErrorMessage ||
                '원고 본문은 안전하게 반영되었으므로 다시 저장하지 않고 실패한 설정 제안만 재시도할 수 있습니다.'}
            </div>
            <button
              type="button"
              data-testid="retry-pending-proposals-btn"
              disabled={isRetryingProposals}
              onClick={handleRetryPendingRewriteProposals}
              className="inline-flex items-center gap-1.5 rounded bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40"
            >
              {isRetryingProposals ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              <span>
                실패한 설정 제안만 재시도 ({rewritePersistenceState.pendingProposals.length}건)
              </span>
            </button>
          </div>
        )}

        {rewriteErrorMessage && (
          <div
            data-testid="rewrite-error-banner"
            className="rounded-lg border border-rose-500/50 bg-rose-500/10 p-3 text-xs text-rose-200 flex items-start gap-2"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-rose-400" />
            <span>{rewriteErrorMessage}</span>
          </div>
        )}

        {/* Candidate Comparison Card (Author Acceptance Required) */}
        {rewriteCandidate && (
          <div
            data-testid="rewrite-candidate-card"
            className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-bold text-indigo-300">
                  리라이팅 제안 비교 ({rewriteCandidate.appliedModes.join(' + ')})
                </span>
                <span
                  className={`rounded border px-2 py-0.5 text-[10px] font-semibold ${
                    rewriteCandidate.aiDecision === 'NO_OP_OPTIMAL'
                      ? 'border-sky-500/50 bg-sky-500/15 text-sky-200'
                      : 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200'
                  }`}
                >
                  {rewriteCandidate.aiDecision === 'NO_OP_OPTIMAL'
                    ? 'NO_OP_OPTIMAL (현 원문 유지 권장)'
                    : 'REWRITTEN (수정안 준비)'}
                </span>
                <span className="font-mono-tabular text-[11px] text-slate-400">
                  작가 결정: {rewriteCandidate.authorDecision}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  data-testid="rewrite-accept-btn"
                  disabled={
                    isBusy ||
                    isRetryingProposals ||
                    isRewriteCandidateStale ||
                    isRewriteLoreDrifted ||
                    rewriteCandidate.verification.hasBlockingViolation ||
                    rewriteCandidate.authorDecision === 'ACCEPTED'
                  }
                  onClick={handleAcceptRewriteCandidate}
                  className="inline-flex items-center gap-1 rounded bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-40"
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>수락 (백업 후 원고 반영)</span>
                </button>
                <button
                  type="button"
                  data-testid="rewrite-reject-btn"
                  disabled={isBusy}
                  onClick={handleRejectRewriteCandidate}
                  className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                >
                  <X className="h-3.5 w-3.5" />
                  <span>거절 (원문 유지)</span>
                </button>
                <button
                  type="button"
                  data-testid="rewrite-regenerate-btn"
                  disabled={isBusy}
                  onClick={handleRunLiteraryRewrite}
                  className="inline-flex items-center gap-1 rounded border border-indigo-500/40 bg-indigo-500/15 px-3 py-1.5 text-xs font-semibold text-indigo-200 hover:bg-indigo-500/25 disabled:opacity-40"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>다시 생성</span>
                </button>
              </div>
            </div>

            {isRewriteCandidateStale && (
              <div className="rounded border border-amber-500/50 bg-amber-500/10 p-2.5 text-xs text-amber-200">
                ※ 수정안 생성 이후 원고가 변경되어 기존 앵커가 만료되었습니다. 반영 전에 [다시 생성]을 실행하세요.
              </div>
            )}

            {isRewriteLoreDrifted && (
              <div className="rounded border border-rose-500/50 bg-rose-500/10 p-2.5 text-xs text-rose-200">
                ※ 수정안 생성 이후 확정 설정(CANON)이 변경되어 반영이 차단되었습니다. 최신 설정을 반영하려면 [다시 생성]을 실행하세요.
              </div>
            )}

            {rewriteCandidate.verification.alerts.length > 0 && (
              <div className="space-y-1">
                {rewriteCandidate.verification.alerts.map((al, i) => (
                  <div
                    key={i}
                    className={`rounded border p-2 text-xs ${
                      al.severity === 'CRITICAL_BLOCK'
                        ? 'border-rose-500/50 bg-rose-500/10 text-rose-200'
                        : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                    }`}
                  >
                    [{al.severity} · {al.source}] {al.description}
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="min-w-0 rounded border border-rose-500/30 bg-rose-500/5 p-3 text-xs">
                <div className="text-[10px] font-semibold text-rose-300 mb-1">
                  원문 ({rewriteCandidate.verification.lengthDelta.originalChars}자)
                </div>
                <div className="text-slate-200 whitespace-pre-wrap break-words">
                  {rewriteCandidate.originalExcerpt}
                </div>
              </div>
              <div className="min-w-0 rounded border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
                <div className="text-[10px] font-semibold text-emerald-300 mb-1">
                  수정안 ({rewriteCandidate.verification.lengthDelta.rewrittenChars}자 ·{' '}
                  {rewriteCandidate.verification.lengthDelta.deltaChars >= 0
                    ? `+${rewriteCandidate.verification.lengthDelta.deltaChars}`
                    : rewriteCandidate.verification.lengthDelta.deltaChars}
                  자)
                </div>
                <div className="text-slate-100 whitespace-pre-wrap break-words">
                  {rewriteCandidate.rewrittenExcerpt}
                </div>
              </div>
            </div>

            <div className="rounded border border-slate-800 bg-slate-950/70 p-3 text-xs space-y-1.5 text-slate-300">
              <div>
                <strong className="text-slate-100">변경 이유:</strong>{' '}
                {rewriteCandidate.changeRationale}
              </div>
              {rewriteCandidate.preservedElements.length > 0 && (
                <div>
                  <strong className="text-slate-100">유지한 요소:</strong>{' '}
                  {rewriteCandidate.preservedElements.join(' · ')}
                </div>
              )}
              <div>
                <strong className="text-slate-100">시점·품질 비교:</strong>{' '}
                {rewriteCandidate.perspectiveCheck.expectedPerspective} (
                {rewriteCandidate.perspectiveCheck.maintained ? '시점 유지됨' : '시점 위반'}) ·{' '}
                {rewriteCandidate.verification.qualityDelta.summaryKo}
              </div>
              {rewriteCandidate.verification.qualityDelta.rubricChecks && (
                <div className="pt-1 border-t border-slate-800/80 text-[11px] text-slate-400 space-y-1">
                  <div>
                    <strong className="text-slate-200">한국어 문학 루브릭:</strong>{' '}
                    감정선 유지({rewriteCandidate.verification.qualityDelta.rubricChecks.emotionalSubtextPreserved ? '양호' : '주의'}) ·{' '}
                    대사 개성({rewriteCandidate.verification.qualityDelta.rubricChecks.dialogueCharacterFitPreserved ? '양호' : '동질화 주의'}) ·{' '}
                    핵심 행동({rewriteCandidate.verification.qualityDelta.rubricChecks.keyActionPreserved ? '보존' : '누락 주의'}) ·{' '}
                    {rewriteCandidate.verification.qualityDelta.rubricChecks.heuristicSignalNote}
                  </div>
                  {rewriteCandidate.verification.qualityDelta.rubricChecks.rubricWarnings.length > 0 && (
                    <div className="text-amber-300">
                      ※ 루브릭 경고: {rewriteCandidate.verification.qualityDelta.rubricChecks.rubricWarnings.join(' / ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ==================================================================== */}
      {/* STEP 7: [최종 원고 확정], 기억 관리자(Memory Curator) & 토큰 사용량 */}
      {/* ==================================================================== */}
      <div className="rounded-xl border border-emerald-500/30 bg-slate-950/90 p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <FileCheck2 className="h-4 w-4 text-emerald-400" />
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
                7단계 · 최종 원고 확정 및 장기 기억 큐레이션 (Memory Curator)
              </span>
            </div>
            <p className="mt-0.5 text-xs text-slate-400">
              원고 확정 시 기존 원고 백업본(Revision)을 먼저 보존한 뒤 확정 저장하며, 신규 설정 후보를 PROPOSED 상태로 추출합니다.
            </p>
          </div>

          <button
            type="button"
            disabled={isBusy}
            onClick={handleFinalConfirmEpisode}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-emerald-400 disabled:opacity-40 transition-colors"
          >
            <CheckCircle2 className="h-4 w-4" />
            <span>최종 원고 확정</span>
          </button>
        </div>

        {/* Memory Curator Report & PROPOSED ChangeProposals */}
        {(curatorReport || changeProposals.length > 0) && (
          <div className="space-y-3 border-t border-slate-800 pt-3 text-xs">
            {curatorReport && (
              <div className="rounded-lg border border-slate-800 bg-slate-900 p-3 space-y-1.5">
                <div className="font-semibold text-emerald-300">
                  기억 관리자(Memory Curator) 회차 요약:
                </div>
                <p className="text-slate-200">{curatorReport.episodeSummary}</p>
              </div>
            )}

            {changeProposals.length > 0 && (
              <div className="space-y-2">
                <div className="font-semibold text-amber-300">
                  AI 설정 변경 승인 요청 목록 (ChangeProposal — 작가 승인 전까지 PROPOSED 상태 유지)
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  {changeProposals.map((prop) => (
                    <div
                      key={prop.id}
                      className="rounded-lg border border-slate-800 bg-slate-900 p-3 space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-slate-100">
                          [{prop.targetEntityType}] {prop.title}
                        </span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            prop.canonStatus === 'CANON'
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : prop.canonStatus === 'REJECTED'
                              ? 'bg-rose-500/20 text-rose-300'
                              : 'bg-amber-500/20 text-amber-300'
                          }`}
                        >
                          {prop.canonStatus}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-300">
                        {prop.afterSummary}
                      </p>
                      <div className="text-[10px] text-slate-400">
                        근거: {prop.rationale}
                      </div>
                      {prop.canonStatus === 'PROPOSED' && (
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          {(prop.targetEntityType === 'RELATIONSHIP' ||
                            prop.targetEntityType === 'TIMELINE_EVENT' ||
                            prop.targetEntityType === 'FORESHADOWING') &&
                          onOpenProposalReview ? (
                            <button
                              type="button"
                              onClick={() => onOpenProposalReview(prop.id)}
                              className="rounded bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-indigo-500 cursor-pointer"
                            >
                              AI 제안 검토 워크스페이스에서 전후 비교 · 승인 →
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() =>
                                  onUpdateChangeProposalStatus(prop, 'CANON')
                                }
                                className="rounded bg-emerald-500 px-2.5 py-1 text-[11px] font-semibold text-slate-950 hover:bg-emerald-400 cursor-pointer"
                              >
                                확정 설정(CANON)으로 승인
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  onUpdateChangeProposalStatus(prop, 'REJECTED')
                                }
                                className="rounded border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800 cursor-pointer"
                              >
                                거절
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Phase 3 Section 7 & 8: 이번 집필에서 참조한 기억 (RAG 검증 근거) */}
        <div
          className="space-y-2 border-t border-slate-800 pt-3 text-xs"
          data-testid="ai-panel-referenced-rag-memories"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="font-semibold text-indigo-300 flex items-center gap-1.5">
              <span>이번 집필에서 참조한 기억 (RAG 검증 근거 · 확정 설정/원고 발췌)</span>
              <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-bold text-indigo-300">
                {(
                  lastWritingResult?.referencedMemoryChunks ||
                  writingContext.retrievedMemoryChunks ||
                  []
                ).length}
                건
              </span>
            </div>
            <span className="text-[11px] text-slate-400">
              FRESH 검증 통과 청크만 Novel Writer 2단계 문맥에 주입됨
            </span>
          </div>

          {(
            lastWritingResult?.referencedMemoryChunks ||
            writingContext.retrievedMemoryChunks ||
            []
          ).length === 0 ? (
            <div className="rounded-lg border border-slate-800/80 bg-slate-900/60 p-2.5 text-[11px] text-slate-400">
              아직 본문 생성이 실행되지 않았거나 추가 참조된 장기 기억 청크가 없습니다. (본문 집필 실행 시 서버 RAG 엔진이 관련 확정 원고·설정을 자동 검색하여 2단계 프롬프트에 주입하고 이곳에 출처와 오프셋을 기록합니다.)
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {(
                lastWritingResult?.referencedMemoryChunks ||
                writingContext.retrievedMemoryChunks ||
                []
              ).map((mem, idx) => (
                <div
                  key={mem.chunkId || idx}
                  className="rounded-lg border border-indigo-500/30 bg-slate-900/90 p-2.5 space-y-1"
                >
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <span className="font-semibold text-slate-100 text-[11px]">
                      #{idx + 1} [{mem.sourceEntityType}] {mem.title}
                    </span>
                    <div className="flex items-center gap-1">
                      <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">
                        {mem.freshnessStatus}
                      </span>
                      <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-mono text-indigo-300">
                        {(mem.relevanceScore * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-300 line-clamp-2 whitespace-pre-wrap">
                    {mem.originalText}
                  </p>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-400 font-mono">
                    <span>출처ID: {mem.sourceEntityId}</span>
                    <span>버전: {mem.sourceRevisionId}</span>
                    <span>
                      오프셋: {mem.sourceStartOffset}~{mem.sourceEndOffset}자
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Token Usage & Provenance Bar */}
        {lastUsage && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-2.5 font-mono-tabular text-[11px] text-slate-400">
            <div>
              토큰 사용량 ({lastUsage.isActualUsage ? '실측' : '추정'}): 입력{' '}
              {lastUsage.promptTokenCount.toLocaleString()} · 출력{' '}
              {lastUsage.candidatesTokenCount.toLocaleString()} · 합계{' '}
              {lastUsage.totalTokenCount.toLocaleString()} tokens (약 $
              {lastUsage.estimatedCostUsd})
            </div>
            <div>
              적용 프롬프트 버전:{' '}
              {lastWritingResult?.appliedPromptVersionIds.join(', ') ||
                writingContext.activePrompts.map((p) => p.versionId).join(', ') ||
                '기본'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
