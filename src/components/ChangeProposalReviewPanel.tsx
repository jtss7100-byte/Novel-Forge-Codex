import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  FileSearch,
  Filter,
  GitCompare,
  History,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  XCircle,
} from 'lucide-react';
import type {
  ChangeProposal,
  Character,
  CharacterRelationship,
  Episode,
  Foreshadowing,
  NavTab,
  Project,
  TimelineEvent,
} from '../types/novel';
import type {
  ApprovalWorkspaceState,
  ChangeProposalApprovalAudit,
  ChangeProposalPreviewResponse,
} from '../types/changeProposalApproval';
import {
  buildChangeProposalFieldDiff,
  buildPreviewTargetEntityCandidate,
  canEnableCanonApprovalButton,
  isSupportedApprovalEntityType,
} from '../utils/changeProposalApprovalLogic';
import { ChangeProposalDiffView } from './ChangeProposalDiffView';
import { ApprovalAuditHistory } from './ApprovalAuditHistory';

export type ProposalFilterKey =
  | 'ALL'
  | 'PROPOSED'
  | 'CANON'
  | 'REJECTED'
  | 'RELATIONSHIP'
  | 'TIMELINE_EVENT'
  | 'FORESHADOWING';

export interface ApprovalExecutionOutcome {
  ok: boolean;
  canonCommitted: boolean;
  uiRefreshFailed?: boolean;
  ragSyncStatus?:
    | 'PENDING'
    | 'PROCESSING'
    | 'SYNCED'
    | 'FAILED'
    | 'SUPERSEDED'
    | 'NOT_REQUIRED';
  ragSyncError?: string;
  errorCode?: string;
  message: string;
}

export interface RagManualRetryOutcome {
  ok: boolean;
  ragSyncStatus:
    | 'PENDING'
    | 'PROCESSING'
    | 'SYNCED'
    | 'FAILED'
    | 'SUPERSEDED'
    | 'NOT_REQUIRED';
  skippedReason?: string | null;
  retryAfterMs?: number | null;
  documentId?: string | null;
  message: string;
}

interface ChangeProposalReviewPanelProps {
  project: Project;
  proposals: ChangeProposal[];
  characters: Character[];
  episodes: Episode[];
  relationships: CharacterRelationship[];
  timelineEvents: TimelineEvent[];
  foreshadowings: Foreshadowing[];
  approvalAudits: ChangeProposalApprovalAudit[];
  idToken: string | null;
  initialSelectedProposalId?: string | null;
  onApproveProposal: (params: {
    proposal: ChangeProposal;
    reviewNote?: string;
    expectedUpdatedAt?: string | null;
  }) => Promise<ApprovalExecutionOutcome>;
  onRejectProposal: (params: {
    proposal: ChangeProposal;
    reviewNote?: string;
  }) => Promise<ApprovalExecutionOutcome>;
  onRetryRagSync: (
    proposalId: string
  ) => Promise<RagManualRetryOutcome | void>;
  onRefreshWorkspaceData: () => Promise<void>;
  onNavigateToEntity?: (tab: NavTab, entityId?: string) => void;
}

const ENTITY_BADGE_MAP: Record<
  string,
  { label: string; colorClass: string; tab?: NavTab }
> = {
  RELATIONSHIP: {
    label: '인물 관계',
    colorClass: 'bg-pink-500/15 text-pink-300 border-pink-500/30',
    tab: 'relationships',
  },
  TIMELINE_EVENT: {
    label: '사건 연표',
    colorClass: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    tab: 'timeline',
  },
  FORESHADOWING: {
    label: '복선 관리',
    colorClass: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
    tab: 'foreshadowing',
  },
  CHARACTER: {
    label: '등장인물',
    colorClass: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    tab: 'characters',
  },
  WORLDBUILDING: {
    label: '세계관',
    colorClass: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    tab: 'worldbuilding',
  },
};

export const ChangeProposalReviewPanel: React.FC<
  ChangeProposalReviewPanelProps
> = ({
  project,
  proposals,
  characters,
  episodes,
  relationships,
  timelineEvents,
  foreshadowings,
  approvalAudits,
  idToken,
  initialSelectedProposalId,
  onApproveProposal,
  onRejectProposal,
  onRetryRagSync,
  onRefreshWorkspaceData,
  onNavigateToEntity,
}) => {
  const [activeSubView, setActiveSubView] = useState<'REVIEW' | 'AUDIT'>(
    'REVIEW'
  );
  const [activeFilter, setActiveFilter] =
    useState<ProposalFilterKey>('PROPOSED');
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(
    initialSelectedProposalId || null
  );
  const [workspaceState, setWorkspaceState] =
    useState<ApprovalWorkspaceState>('IDLE');
  const [previewData, setPreviewData] =
    useState<ChangeProposalPreviewResponse | null>(null);
  const [statusBanner, setStatusBanner] = useState<{
    type: 'SUCCESS' | 'WARNING_REFRESH' | 'ERROR';
    title: string;
    detail: string;
    ragStatus?: string;
  } | null>(null);

  // Monotonic sequence & AbortController for preview race-condition protection (Section 5)
  const previewRequestSeqRef = useRef<number>(0);
  const previewAbortControllerRef = useRef<AbortController | null>(null);
  const [latestRequestId, setLatestRequestId] = useState<number>(0);
  const [resolvedPreviewRequestId, setResolvedPreviewRequestId] =
    useState<number>(0);

  // Confirmation modal state
  const [confirmModalDecision, setConfirmModalDecision] = useState<
    'APPROVE' | 'REJECT' | null
  >(null);
  const [reviewNote, setReviewNote] = useState('');
  const [retryingRagProposalId, setRetryingRagProposalId] = useState<
    string | null
  >(null);
  const [isRefreshingData, setIsRefreshingData] = useState(false);

  // Section 5: Close any open confirmation modal immediately if proposal, project, or auth token changes
  useEffect(() => {
    setConfirmModalDecision(null);
  }, [selectedProposalId, project.id, idToken]);

  // Sync initialSelectedProposalId when navigated from another panel
  useEffect(() => {
    if (initialSelectedProposalId) {
      setSelectedProposalId(initialSelectedProposalId);
      setActiveSubView('REVIEW');
      const target = proposals.find((p) => p.id === initialSelectedProposalId);
      if (target && activeFilter === 'PROPOSED' && target.canonStatus !== 'PROPOSED') {
        setActiveFilter('ALL');
      }
    }
  }, [initialSelectedProposalId, proposals, activeFilter]);

  const entityDisplayNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of characters) {
      map[c.id] = c.name;
    }
    for (const ep of episodes) {
      map[ep.id] = `${ep.episodeNumber}화. ${ep.title}`;
    }
    for (const ev of timelineEvents) {
      map[ev.id] = ev.title;
    }
    for (const fs of foreshadowings) {
      map[fs.id] = fs.title;
    }
    return map;
  }, [characters, episodes, timelineEvents, foreshadowings]);

  const episodeTitleMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const ep of episodes) {
      map[ep.id] = `${ep.episodeNumber}화 (${ep.title})`;
    }
    return map;
  }, [episodes]);

  // Summary counts
  const counts = useMemo(() => {
    const total = proposals.length;
    const proposed = proposals.filter((p) => p.canonStatus === 'PROPOSED').length;
    const canon = proposals.filter((p) => p.canonStatus === 'CANON').length;
    const rejected = proposals.filter((p) => p.canonStatus === 'REJECTED').length;
    const relationship = proposals.filter(
      (p) => p.targetEntityType === 'RELATIONSHIP'
    ).length;
    const timeline = proposals.filter(
      (p) => p.targetEntityType === 'TIMELINE_EVENT'
    ).length;
    const foreshadowing = proposals.filter(
      (p) => p.targetEntityType === 'FORESHADOWING'
    ).length;
    const pendingRag = approvalAudits.filter(
      (a) =>
        a.decision === 'APPROVED' &&
        (a.ragSyncStatus === 'PENDING' ||
          a.ragSyncStatus === 'PROCESSING' ||
          a.ragSyncStatus === 'FAILED')
    ).length;
    return {
      total,
      proposed,
      canon,
      rejected,
      relationship,
      timeline,
      foreshadowing,
      pendingRag,
    };
  }, [proposals, approvalAudits]);

  const filteredProposals = useMemo(() => {
    return proposals
      .filter((p) => {
        if (activeFilter === 'PROPOSED') return p.canonStatus === 'PROPOSED';
        if (activeFilter === 'CANON') return p.canonStatus === 'CANON';
        if (activeFilter === 'REJECTED') return p.canonStatus === 'REJECTED';
        if (activeFilter === 'RELATIONSHIP')
          return p.targetEntityType === 'RELATIONSHIP';
        if (activeFilter === 'TIMELINE_EVENT')
          return p.targetEntityType === 'TIMELINE_EVENT';
        if (activeFilter === 'FORESHADOWING')
          return p.targetEntityType === 'FORESHADOWING';
        return true;
      })
      .sort((a, b) =>
        String(b.updatedAt || b.createdAt).localeCompare(
          String(a.updatedAt || a.createdAt)
        )
      );
  }, [proposals, activeFilter]);

  // Auto-select first proposal in list if current selection is empty
  useEffect(() => {
    if (
      filteredProposals.length > 0 &&
      (!selectedProposalId ||
        !filteredProposals.some((p) => p.id === selectedProposalId))
    ) {
      setSelectedProposalId(filteredProposals[0].id);
    }
  }, [filteredProposals, selectedProposalId]);

  const selectedProposal = useMemo(
    () => proposals.find((p) => p.id === selectedProposalId) || null,
    [proposals, selectedProposalId]
  );

  // Section 5: Build local reference diff ONLY (canApprove MUST be false for supported server-transactional entities)
  const buildLocalFallbackPreview = useCallback(
    (
      proposal: ChangeProposal,
      failureOverride?: {
        conflictCode: 'SERVER_VERIFICATION_FAILED' | 'LOCAL_PREVIEW_UNVERIFIED';
        conflictMessage: string;
      }
    ): ChangeProposalPreviewResponse => {
      const nowIso = new Date().toISOString();
      if (!isSupportedApprovalEntityType(proposal.targetEntityType)) {
        return {
          success: true,
          ok: true,
          executionMode: 'LOCAL_PREVIEW',
          isCloudVerified: false,
          isLocalReferenceOnly: true,
          canApprove: proposal.canonStatus === 'PROPOSED',
          conflictCode: null,
          conflictMessage: null,
          conflictDetails: null,
          projectId: proposal.projectId,
          proposalId: proposal.id,
          proposal,
          targetEntityType: 'RELATIONSHIP',
          targetEntityId: proposal.targetEntityId,
          proposedAction:
            proposal.proposedAction === 'CREATE' ? 'CREATE' : 'UPDATE',
          beforeEntity: null,
          afterEntityPreview: null,
          fieldDiffs: [],
          verifiedExcerpt: null,
          sourceRevisionId: proposal.sourceRevisionId || '',
          sourceEpisodeId: proposal.triggerEpisodeId || '',
          sourceSceneId: proposal.triggerSceneId || '',
          payoffNote: '',
          expectedUpdatedAt: null,
          entityDisplayNameMap,
          previewedAt: nowIso,
        };
      }

      let existingEntity:
        | CharacterRelationship
        | TimelineEvent
        | Foreshadowing
        | null = null;
      if (proposal.targetEntityType === 'RELATIONSHIP') {
        existingEntity =
          relationships.find((r) => r.id === proposal.targetEntityId) || null;
      } else if (proposal.targetEntityType === 'TIMELINE_EVENT') {
        existingEntity =
          timelineEvents.find((e) => e.id === proposal.targetEntityId) || null;
      } else if (proposal.targetEntityType === 'FORESHADOWING') {
        existingEntity =
          foreshadowings.find((f) => f.id === proposal.targetEntityId) || null;
      }

      const candidate = buildPreviewTargetEntityCandidate({
        proposal,
        existingEntity,
        nowIso,
      });

      const fieldDiffs = buildChangeProposalFieldDiff({
        targetEntityType: proposal.targetEntityType,
        proposedAction:
          proposal.proposedAction === 'CREATE' ? 'CREATE' : 'UPDATE',
        beforeEntity: existingEntity,
        afterEntity: candidate.afterEntity,
        payoffNote: candidate.payoffNote,
        conflictDetails: candidate.conflictDetails,
        conflictCode: candidate.errorCode,
        entityDisplayNameMap,
      });

      const isPending = proposal.canonStatus === 'PROPOSED';
      const defaultConflictCode =
        failureOverride?.conflictCode ||
        (idToken ? 'SERVER_VERIFICATION_FAILED' : 'LOCAL_PREVIEW_UNVERIFIED');
      const defaultConflictMessage =
        failureOverride?.conflictMessage ||
        (idToken
          ? '서버 승인 미리보기 검증이 완료되지 않아 원자적 CANON 승인이 차단되었습니다. [서버 재검증] 버튼을 눌러 다시 확인해 주세요.'
          : '클라우드 미로그인(로컬 미리보기) 상태입니다. 로컬 참고용 비교만 제공되며 원자적 CANON 승인은 클라우드 인증 후 가능합니다.');

      // Section 5: Fail-Closed — never allow canApprove=true from unverified local fallback
      return {
        success: false,
        ok: false,
        executionMode: 'LOCAL_PREVIEW',
        isCloudVerified: false,
        isLocalReferenceOnly: true,
        canApprove: false,
        conflictCode: !isPending
          ? 'PROPOSAL_NOT_PENDING'
          : candidate.errorCode || defaultConflictCode,
        conflictMessage: !isPending
          ? `이미 처리된 제안서입니다 (현재 상태: ${proposal.canonStatus}).`
          : candidate.errorMessage || defaultConflictMessage,
        conflictDetails: candidate.conflictDetails,
        projectId: proposal.projectId,
        proposalId: proposal.id,
        proposal,
        targetEntityType: proposal.targetEntityType,
        targetEntityId: candidate.targetEntityId,
        proposedAction:
          proposal.proposedAction === 'CREATE' ? 'CREATE' : 'UPDATE',
        beforeEntity: existingEntity,
        afterEntityPreview: candidate.afterEntity,
        fieldDiffs,
        verifiedExcerpt: candidate.verifiedExcerpt || null,
        sourceRevisionId: proposal.sourceRevisionId || '',
        sourceEpisodeId: proposal.triggerEpisodeId || '',
        sourceSceneId: proposal.triggerSceneId || '',
        payoffNote: candidate.payoffNote || '',
        expectedUpdatedAt: existingEntity?.updatedAt || null,
        entityDisplayNameMap,
        previewedAt: nowIso,
      };
    },
    [
      entityDisplayNameMap,
      relationships,
      timelineEvents,
      foreshadowings,
      idToken,
    ]
  );

  // Load Server-Authoritative Preview whenever selectedProposal changes (Section 5: Fail-Closed + Race Guard)
  const loadProposalPreview = useCallback(
    async (proposal: ChangeProposal) => {
      if (previewAbortControllerRef.current) {
        previewAbortControllerRef.current.abort();
      }
      const controller = new AbortController();
      previewAbortControllerRef.current = controller;

      const requestId = previewRequestSeqRef.current + 1;
      previewRequestSeqRef.current = requestId;
      setLatestRequestId(requestId);

      if (!isSupportedApprovalEntityType(proposal.targetEntityType)) {
        const fallback = buildLocalFallbackPreview(proposal);
        setPreviewData(fallback);
        setResolvedPreviewRequestId(requestId);
        setWorkspaceState(
          proposal.canonStatus === 'CANON'
            ? 'APPROVED'
            : proposal.canonStatus === 'REJECTED'
              ? 'REJECTED'
              : 'READY_FOR_REVIEW'
        );
        return;
      }

      setWorkspaceState('LOADING_PREVIEW');
      if (!idToken) {
        const localPreview = buildLocalFallbackPreview(proposal, {
          conflictCode: 'LOCAL_PREVIEW_UNVERIFIED',
          conflictMessage:
            '클라우드 미로그인(로컬 미리보기) 상태입니다. 로컬 참고용 비교만 제공되며 원자적 CANON 승인은 클라우드 인증 후 가능합니다.',
        });
        setPreviewData(localPreview);
        setResolvedPreviewRequestId(requestId);
        if (proposal.canonStatus === 'CANON') {
          setWorkspaceState('APPROVED');
        } else if (proposal.canonStatus === 'REJECTED') {
          setWorkspaceState('REJECTED');
        } else {
          setWorkspaceState('CONFLICT');
        }
        return;
      }

      try {
        const res = await fetch('/api/ai/change-proposals/preview', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({
            projectId: project.id,
            proposalId: proposal.id,
          }),
          signal: controller.signal,
        });
        const data = (await res
          .json()
          .catch(() => ({}))) as Partial<ChangeProposalPreviewResponse> & {
          error?: string;
        };

        // Ignore stale preview responses if proposal/project/auth changed in the meantime
        if (
          controller.signal.aborted ||
          previewRequestSeqRef.current !== requestId
        ) {
          return;
        }

        if (!res.ok || !data.ok || !data.proposal) {
          // Section 5: Fail-Closed on Server Preview Error (NEVER set READY_FOR_REVIEW or canApprove: true)
          const serverErrMsg =
            data.conflictMessage ||
            data.error ||
            `서버 승인 미리보기 검증에 실패했습니다 (HTTP ${res.status}).`;
          const failedPreview = buildLocalFallbackPreview(proposal, {
            conflictCode: 'SERVER_VERIFICATION_FAILED',
            conflictMessage: serverErrMsg,
          });
          setPreviewData(failedPreview);
          setResolvedPreviewRequestId(requestId);
          setWorkspaceState('FAILED');
          return;
        }

        const verifiedPreview: ChangeProposalPreviewResponse = {
          ...(data as ChangeProposalPreviewResponse),
          isLocalReferenceOnly: false,
        };
        setPreviewData(verifiedPreview);
        setResolvedPreviewRequestId(requestId);
        if (verifiedPreview.proposal.canonStatus === 'CANON') {
          setWorkspaceState('APPROVED');
        } else if (verifiedPreview.proposal.canonStatus === 'REJECTED') {
          setWorkspaceState('REJECTED');
        } else if (
          verifiedPreview.conflictCode ||
          !verifiedPreview.canApprove ||
          !verifiedPreview.isCloudVerified
        ) {
          setWorkspaceState('CONFLICT');
        } else {
          setWorkspaceState('READY_FOR_REVIEW');
        }
      } catch (err) {
        if (
          controller.signal.aborted ||
          previewRequestSeqRef.current !== requestId
        ) {
          return;
        }
        const netErrMsg =
          err instanceof Error
            ? `서버 미리보기 통신 실패: ${err.message}`
            : '서버 미리보기 검증 요청 중 네트워크 오류가 발생했습니다.';
        const failedPreview = buildLocalFallbackPreview(proposal, {
          conflictCode: 'SERVER_VERIFICATION_FAILED',
          conflictMessage: netErrMsg,
        });
        setPreviewData(failedPreview);
        setResolvedPreviewRequestId(requestId);
        setWorkspaceState('FAILED');
      }
    },
    [buildLocalFallbackPreview, idToken, project.id]
  );

  useEffect(() => {
    if (selectedProposal) {
      void loadProposalPreview(selectedProposal);
    } else {
      setPreviewData(null);
      setWorkspaceState('IDLE');
    }
    return () => {
      if (previewAbortControllerRef.current) {
        previewAbortControllerRef.current.abort();
      }
    };
  }, [selectedProposal, loadProposalPreview]);

  const isActionBusy =
    workspaceState === 'LOADING_PREVIEW' ||
    workspaceState === 'APPROVING' ||
    workspaceState === 'REJECTING';

  // Section 5: Enforce all 9 conditions before enabling the CANON Approval button
  const canonApprovalEligibility = useMemo(() => {
    if (
      selectedProposal &&
      !isSupportedApprovalEntityType(selectedProposal.targetEntityType)
    ) {
      return {
        enabled: !isActionBusy && selectedProposal.canonStatus === 'PROPOSED',
        disabledReason: null,
      };
    }
    return canEnableCanonApprovalButton({
      isCloudAuthenticated: Boolean(idToken),
      workspaceState,
      preview: previewData,
      selectedProposal,
      activeProjectId: project.id,
      latestRequestId,
      previewRequestId: resolvedPreviewRequestId,
      isSubmitting: isActionBusy,
    });
  }, [
    idToken,
    workspaceState,
    previewData,
    selectedProposal,
    project.id,
    latestRequestId,
    resolvedPreviewRequestId,
    isActionBusy,
  ]);

  const canRejectSelectedProposal = useMemo(() => {
    if (!selectedProposal || isActionBusy) return false;
    if (selectedProposal.canonStatus !== 'PROPOSED') return false;
    if (
      isSupportedApprovalEntityType(selectedProposal.targetEntityType) &&
      !idToken
    ) {
      return false;
    }
    return true;
  }, [selectedProposal, isActionBusy, idToken]);

  const handleConfirmDecisionExecution = async () => {
    if (!selectedProposal || !confirmModalDecision || isActionBusy) return;
    if (
      confirmModalDecision === 'APPROVE' &&
      !canonApprovalEligibility.enabled
    ) {
      return;
    }
    if (confirmModalDecision === 'REJECT' && !canRejectSelectedProposal) {
      return;
    }
    const decision = confirmModalDecision;
    const trimmedNote = reviewNote.trim().slice(0, 1000) || undefined;
    setConfirmModalDecision(null);
    setStatusBanner(null);

    if (decision === 'APPROVE') {
      setWorkspaceState('APPROVING');
      try {
        const outcome = await onApproveProposal({
          proposal: selectedProposal,
          reviewNote: trimmedNote,
          expectedUpdatedAt: previewData?.expectedUpdatedAt ?? null,
        });
        setReviewNote('');
        if (outcome.ok && outcome.canonCommitted) {
          setWorkspaceState('APPROVED');
          if (outcome.uiRefreshFailed) {
            setStatusBanner({
              type: 'WARNING_REFRESH',
              title:
                'CANON 승인 완료 · UI 최신화 실패 (데이터 다시 불러오기 필요)',
              detail: outcome.message,
              ragStatus: outcome.ragSyncStatus,
            });
          } else if (
            outcome.ragSyncStatus === 'FAILED' ||
            outcome.ragSyncStatus === 'PENDING'
          ) {
            setStatusBanner({
              type: 'WARNING_REFRESH',
              title:
                '원자적 CANON 승인 완료 · RAG 장기 기억 색인 대기/재시도 필요',
              detail: outcome.ragSyncError
                ? `${outcome.message} (${outcome.ragSyncError})`
                : outcome.message,
              ragStatus: outcome.ragSyncStatus,
            });
          } else {
            setStatusBanner({
              type: 'SUCCESS',
              title: '원자적 CANON 승인 및 설정 반영 완료',
              detail: outcome.message,
              ragStatus: outcome.ragSyncStatus,
            });
          }
        } else {
          const isConflictError =
            outcome.errorCode === 'STALE_TARGET' ||
            outcome.errorCode === 'CONFLICT_REQUIRES_REVIEW';
          setWorkspaceState(isConflictError ? 'CONFLICT' : 'FAILED');
          setStatusBanner({
            type: 'ERROR',
            title: isConflictError
              ? `충돌 감지 (${outcome.errorCode}) — 승인 차단됨`
              : outcome.errorCode === 'CLOUD_AUTH_REQUIRED'
                ? '클라우드 인증 필요 (CLOUD_AUTH_REQUIRED) — 로컬 승인 차단됨'
                : '제안서 승인 실패',
            detail: outcome.message,
          });
          await loadProposalPreview(selectedProposal);
        }
      } catch (err) {
        setWorkspaceState('FAILED');
        setStatusBanner({
          type: 'ERROR',
          title: '제안서 승인 중 오류 발생',
          detail: err instanceof Error ? err.message : '알 수 없는 오류',
        });
      }
    } else {
      setWorkspaceState('REJECTING');
      try {
        const outcome = await onRejectProposal({
          proposal: selectedProposal,
          reviewNote: trimmedNote,
        });
        setReviewNote('');
        if (outcome.ok) {
          setWorkspaceState('REJECTED');
          setStatusBanner({
            type: outcome.uiRefreshFailed ? 'WARNING_REFRESH' : 'SUCCESS',
            title: outcome.uiRefreshFailed
              ? '제안 거절 완료 · UI 최신화 실패 (데이터 다시 불러오기 필요)'
              : '제안 거절 및 감사 이력 기록 완료',
            detail: outcome.message,
          });
        } else {
          setWorkspaceState('FAILED');
          setStatusBanner({
            type: 'ERROR',
            title:
              outcome.errorCode === 'CLOUD_AUTH_REQUIRED'
                ? '클라우드 인증 필요 (CLOUD_AUTH_REQUIRED) — 로컬 거절 차단됨'
                : '제안 거절 실패',
            detail: outcome.message,
          });
        }
      } catch (err) {
        setWorkspaceState('FAILED');
        setStatusBanner({
          type: 'ERROR',
          title: '제안 거절 중 오류 발생',
          detail: err instanceof Error ? err.message : '알 수 없는 오류',
        });
      }
    }
  };

  const handleManualRagRetry = async (proposalId: string) => {
    setRetryingRagProposalId(proposalId);
    try {
      const outcome = await onRetryRagSync(proposalId);
      if (outcome) {
        if (outcome.ok && outcome.ragSyncStatus === 'SYNCED') {
          setStatusBanner({
            type: 'SUCCESS',
            title: 'RAG 장기 기억 영구 색인 완료 (SYNCED)',
            detail: outcome.message,
            ragStatus: outcome.ragSyncStatus,
          });
        } else if (
          outcome.skippedReason === 'LEASE_ACTIVE' ||
          outcome.skippedReason === 'BACKOFF_WAITING' ||
          outcome.ragSyncStatus === 'PROCESSING'
        ) {
          setStatusBanner({
            type: 'WARNING_REFRESH',
            title: `RAG 동기화 대기 중 (${outcome.skippedReason || outcome.ragSyncStatus})`,
            detail: outcome.message,
            ragStatus: outcome.ragSyncStatus,
          });
        } else {
          setStatusBanner({
            type: 'ERROR',
            title: `RAG 장기 기억 동기화 실패 (${outcome.skippedReason || outcome.ragSyncStatus})`,
            detail: outcome.message,
            ragStatus: outcome.ragSyncStatus,
          });
        }
      }
    } finally {
      setRetryingRagProposalId(null);
    }
  };

  const handleManualWorkspaceRefresh = async () => {
    setIsRefreshingData(true);
    try {
      await onRefreshWorkspaceData();
      if (selectedProposal) {
        await loadProposalPreview(selectedProposal);
      }
    } finally {
      setIsRefreshingData(false);
    }
  };

  const selectedAudit = useMemo(() => {
    if (!selectedProposal) return null;
    return (
      approvalAudits.find((a) => a.proposalId === selectedProposal.id) || null
    );
  }, [approvalAudits, selectedProposal]);

  return (
    <div
      className="space-y-6"
      data-testid="change-proposal-review-workspace"
    >
      {/* Top Header & Workspace Mode Switcher */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-6 shadow-lg space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-bold text-slate-100">
                  AI 제안 검토 및 원자적 CANON 승인 워크스페이스
                </h2>
                <span className="text-xs px-2.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-semibold">
                  Phase 4.2.2 Author Approval Engine
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                AI가 원고에서 추출한 인물 관계·사건 연표·복선 후보의 원문 근거와 변경 전후(Before/After) 필드를 비교 검증하고, 작가의 최종 승인으로만 CANON 설정 및 RAG 장기 기억에 반영합니다.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800">
              <button
                type="button"
                data-testid="workspace-tab-review"
                onClick={() => setActiveSubView('REVIEW')}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
                  activeSubView === 'REVIEW'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <GitCompare className="w-3.5 h-3.5" />
                제안서 검토 ({counts.proposed}건 대기)
              </button>
              <button
                type="button"
                data-testid="workspace-tab-audit"
                onClick={() => setActiveSubView('AUDIT')}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
                  activeSubView === 'AUDIT'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <History className="w-3.5 h-3.5" />
                승인·거절 감사 이력 ({approvalAudits.length})
              </button>
            </div>

            <button
              type="button"
              data-testid="workspace-refresh-btn"
              onClick={() => void handleManualWorkspaceRefresh()}
              disabled={isRefreshingData}
              className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${
                  isRefreshingData ? 'animate-spin' : ''
                }`}
              />
              최신 상태 동기화
            </button>
          </div>
        </div>

        {/* Summary Counters */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 pt-2 border-t border-slate-800/80">
          <div className="rounded-xl bg-slate-950/70 border border-slate-800/80 p-3">
            <div className="text-[11px] text-slate-400">전체 AI 제안</div>
            <div
              className="text-lg font-bold text-slate-100 mt-0.5"
              data-testid="counter-total-proposals"
            >
              {counts.total}건
            </div>
          </div>
          <div className="rounded-xl bg-amber-950/20 border border-amber-500/30 p-3">
            <div className="text-[11px] text-amber-300 font-medium">
              검토 대기 (PROPOSED)
            </div>
            <div
              className="text-lg font-bold text-amber-300 mt-0.5"
              data-testid="counter-proposed-proposals"
            >
              {counts.proposed}건
            </div>
          </div>
          <div className="rounded-xl bg-emerald-950/20 border border-emerald-500/30 p-3">
            <div className="text-[11px] text-emerald-300 font-medium">
              승인 완료 (CANON)
            </div>
            <div
              className="text-lg font-bold text-emerald-300 mt-0.5"
              data-testid="counter-canon-proposals"
            >
              {counts.canon}건
            </div>
          </div>
          <div className="rounded-xl bg-rose-950/20 border border-rose-500/30 p-3">
            <div className="text-[11px] text-rose-300 font-medium">
              거절됨 (REJECTED)
            </div>
            <div
              className="text-lg font-bold text-rose-300 mt-0.5"
              data-testid="counter-rejected-proposals"
            >
              {counts.rejected}건
            </div>
          </div>
          <div className="rounded-xl bg-indigo-950/20 border border-indigo-500/30 p-3 col-span-2 sm:col-span-1">
            <div className="text-[11px] text-indigo-300 font-medium">
              RAG 색인 대기/실패
            </div>
            <div
              className="text-lg font-bold text-indigo-300 mt-0.5"
              data-testid="counter-pending-rag"
            >
              {counts.pendingRag}건
            </div>
          </div>
        </div>
      </div>

      {/* Execution Status Banner (Separates CANON Commit vs UI Refresh vs RAG Sync) */}
      {statusBanner && (
        <div
          data-testid="approval-status-banner"
          className={`rounded-xl border p-4 flex items-start justify-between gap-3 ${
            statusBanner.type === 'SUCCESS'
              ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-100'
              : statusBanner.type === 'WARNING_REFRESH'
                ? 'bg-amber-950/30 border-amber-500/40 text-amber-100'
                : 'bg-rose-950/30 border-rose-500/40 text-rose-100'
          }`}
        >
          <div className="flex items-start gap-2.5">
            {statusBanner.type === 'SUCCESS' ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
            ) : statusBanner.type === 'WARNING_REFRESH' ? (
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            ) : (
              <ShieldAlert className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            )}
            <div className="space-y-1">
              <div className="text-sm font-bold flex flex-wrap items-center gap-2">
                <span>{statusBanner.title}</span>
                {statusBanner.ragStatus && (
                  <span className="text-[11px] px-2 py-0.5 rounded bg-slate-900/80 border border-slate-700 font-mono">
                    RAG 상태: {statusBanner.ragStatus}
                  </span>
                )}
              </div>
              <p className="text-xs opacity-90">{statusBanner.detail}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setStatusBanner(null)}
            className="text-xs opacity-70 hover:opacity-100 cursor-pointer"
          >
            닫기
          </button>
        </div>
      )}

      {activeSubView === 'AUDIT' ? (
        <ApprovalAuditHistory
          audits={approvalAudits}
          proposals={proposals}
          isLoading={isRefreshingData}
          retryingProposalId={retryingRagProposalId}
          onRetryRagSync={handleManualRagRetry}
          onRefreshAudits={handleManualWorkspaceRefresh}
        />
      ) : (
        <div className="space-y-4">
          {/* Filter Tabs */}
          <div
            className="flex flex-wrap items-center gap-1.5 bg-slate-900/80 border border-slate-800 rounded-xl p-2"
            data-testid="proposal-filter-tabs"
          >
            <div className="flex items-center gap-1.5 px-2 text-xs text-slate-400">
              <Filter className="w-3.5 h-3.5" />
              <span>필터:</span>
            </div>
            {(
              [
                { key: 'ALL', label: `전체 (${counts.total})` },
                { key: 'PROPOSED', label: `검토 대기 (${counts.proposed})` },
                { key: 'CANON', label: `승인 완료 (${counts.canon})` },
                { key: 'REJECTED', label: `거절 (${counts.rejected})` },
                { key: 'RELATIONSHIP', label: `관계 (${counts.relationship})` },
                { key: 'TIMELINE_EVENT', label: `연표 (${counts.timeline})` },
                { key: 'FORESHADOWING', label: `복선 (${counts.foreshadowing})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                type="button"
                data-testid={`filter-tab-${tab.key}`}
                onClick={() => setActiveFilter(tab.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                  activeFilter === tab.key
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Main 2-Column Split: Proposal List + Authoritative Preview & Diff */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left Column: Proposal List */}
            <div className="lg:col-span-4 rounded-xl border border-slate-800 bg-slate-900/80 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800 bg-slate-950/60 flex items-center justify-between">
                <span className="text-xs font-bold text-slate-200">
                  제안서 목록 ({filteredProposals.length}건)
                </span>
                <span className="text-[11px] text-slate-400">
                  최신순 정렬
                </span>
              </div>

              {filteredProposals.length === 0 ? (
                <div className="p-8 text-center space-y-2">
                  <FileSearch className="w-8 h-8 text-slate-600 mx-auto" />
                  <div className="text-xs font-medium text-slate-400">
                    선택한 필터에 해당하는 제안서가 없습니다.
                  </div>
                </div>
              ) : (
                <div className="divide-y divide-slate-800/80 max-h-[680px] overflow-y-auto">
                  {filteredProposals.map((proposal) => {
                    const isSelected = proposal.id === selectedProposalId;
                    const badge = ENTITY_BADGE_MAP[proposal.targetEntityType] || {
                      label: proposal.targetEntityType,
                      colorClass:
                        'bg-slate-800 text-slate-300 border-slate-700',
                    };

                    return (
                      <button
                        key={proposal.id}
                        type="button"
                        data-testid={`proposal-list-item-${proposal.id}`}
                        onClick={() => setSelectedProposalId(proposal.id)}
                        className={`w-full text-left p-4 transition cursor-pointer block ${
                          isSelected
                            ? 'bg-indigo-950/40 border-l-4 border-indigo-500'
                            : 'hover:bg-slate-800/50'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-1.5 mb-1.5">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded border ${badge.colorClass}`}
                            >
                              {badge.label}
                            </span>
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                              {proposal.proposedAction}
                            </span>
                          </div>

                          {proposal.canonStatus === 'PROPOSED' ? (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                              검토 대기
                            </span>
                          ) : proposal.canonStatus === 'CANON' ? (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                              CANON 승인됨
                            </span>
                          ) : (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30">
                              거절됨
                            </span>
                          )}
                        </div>

                        <div className="text-xs font-bold text-slate-100 line-clamp-2 mb-1">
                          {proposal.title}
                        </div>

                        <div className="text-[11px] text-slate-400 line-clamp-2">
                          {proposal.afterSummary || proposal.rationale}
                        </div>

                        <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500 font-mono">
                          <span>ID: {proposal.id.slice(0, 18)}</span>
                          {proposal.sourceRevisionId && (
                            <span>Rev: {proposal.sourceRevisionId.slice(0, 14)}</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Right Column: Selected Proposal Review & Diff Pane */}
            <div className="lg:col-span-8 space-y-4">
              {!selectedProposal ? (
                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-12 text-center space-y-2">
                  <Sparkles className="w-8 h-8 text-indigo-400 mx-auto" />
                  <div className="text-sm font-bold text-slate-200">
                    좌측 목록에서 검토할 AI 제안서를 선택해 주세요
                  </div>
                  <p className="text-xs text-slate-400">
                    제안서를 선택하면 서버 기준 현재 엔티티와 제안 내용의 필드별 비교(Before/After Diff) 및 원고 근거 발췌가 표시됩니다.
                  </p>
                </div>
              ) : (
                <div
                  className="rounded-xl border border-slate-800 bg-slate-900/90 p-5 space-y-5"
                  data-testid="selected-proposal-detail"
                >
                  {/* Selected Proposal Header + Action Bar */}
                  <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 pb-4 border-b border-slate-800">
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          data-testid="workspace-state-badge"
                          className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-800 text-indigo-300 border border-slate-700"
                        >
                          상태: {workspaceState}
                        </span>
                        {selectedProposal.canonStatus === 'PROPOSED' && (
                          <span className="text-xs font-bold px-2.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5" />
                            작가 승인 대기 (PROPOSED)
                          </span>
                        )}
                        {selectedProposal.canonStatus === 'CANON' && (
                          <span className="text-xs font-bold px-2.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            CANON 승인 완료
                          </span>
                        )}
                        {selectedProposal.canonStatus === 'REJECTED' && (
                          <span className="text-xs font-bold px-2.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 flex items-center gap-1">
                            <XCircle className="w-3.5 h-3.5" />
                            거절됨 (REJECTED)
                          </span>
                        )}
                      </div>

                      <h3 className="text-base font-bold text-slate-100">
                        {selectedProposal.title}
                      </h3>

                      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
                        <span>
                          제안 생성 주체:{' '}
                          <code className="text-slate-300">
                            {selectedProposal.createdBy}
                          </code>
                        </span>
                        {selectedProposal.reviewedAt && (
                          <span>
                            검토 일시:{' '}
                            {selectedProposal.reviewedAt
                              .slice(0, 19)
                              .replace('T', ' ')}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {selectedProposal.canonStatus === 'CANON' &&
                        onNavigateToEntity &&
                        ENTITY_BADGE_MAP[selectedProposal.targetEntityType]
                          ?.tab && (
                          <button
                            type="button"
                            onClick={() =>
                              onNavigateToEntity(
                                ENTITY_BADGE_MAP[
                                  selectedProposal.targetEntityType
                                ].tab!,
                                selectedProposal.targetEntityId
                              )
                            }
                            className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold cursor-pointer"
                          >
                            반영된 CANON 설정 화면으로 이동
                          </button>
                        )}

                      {selectedProposal.canonStatus === 'PROPOSED' && (
                        <>
                          {idToken &&
                            (workspaceState === 'FAILED' ||
                              previewData?.conflictCode ===
                                'SERVER_VERIFICATION_FAILED') && (
                              <button
                                type="button"
                                data-testid="reverify-server-preview-btn"
                                disabled={isActionBusy}
                                onClick={() =>
                                  void loadProposalPreview(selectedProposal)
                                }
                                className="px-3.5 py-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-40 text-amber-200 border border-amber-500/40 text-xs font-bold flex items-center gap-1.5 cursor-pointer transition"
                              >
                                <RefreshCw className="w-3.5 h-3.5" />
                                서버 재검증
                              </button>
                            )}

                          <button
                            type="button"
                            data-testid="open-approve-modal-btn"
                            disabled={!canonApprovalEligibility.enabled}
                            title={
                              canonApprovalEligibility.disabledReason ||
                              undefined
                            }
                            onClick={() => setConfirmModalDecision('APPROVE')}
                            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold flex items-center gap-1.5 shadow cursor-pointer transition"
                          >
                            {workspaceState === 'APPROVING' ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <CheckCircle2 className="w-4 h-4" />
                            )}
                            CANON 승인
                          </button>

                          <button
                            type="button"
                            data-testid="open-reject-modal-btn"
                            disabled={!canRejectSelectedProposal}
                            title={
                              !canRejectSelectedProposal && !idToken
                                ? '클라우드 인증(로그인) 상태에서만 제안 거절 및 감사 이력 기록이 가능합니다.'
                                : undefined
                            }
                            onClick={() => setConfirmModalDecision('REJECT')}
                            className="px-4 py-2 rounded-lg bg-rose-600/80 hover:bg-rose-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer transition"
                          >
                            {workspaceState === 'REJECTING' ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <XCircle className="w-4 h-4" />
                            )}
                            제안 거절
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Audit & RAG Status Box for Already Reviewed Proposal */}
                  {selectedAudit && (
                    <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3.5 flex flex-wrap items-center justify-between gap-3">
                      <div className="space-y-0.5 text-xs">
                        <div className="font-semibold text-slate-200 flex items-center gap-2">
                          <Database className="w-3.5 h-3.5 text-indigo-400" />
                          <span>
                            감사 이력 ID: <code>{selectedAudit.id}</code>
                          </span>
                          <span className="text-[11px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">
                            RAG 동기화: {selectedAudit.ragSyncStatus}
                          </span>
                        </div>
                        {selectedAudit.reviewNote && (
                          <div className="text-slate-400">
                            작가 검토 메모: {selectedAudit.reviewNote}
                          </div>
                        )}
                      </div>

                      {selectedAudit.decision === 'APPROVED' &&
                        (selectedAudit.ragSyncStatus === 'PENDING' ||
                          selectedAudit.ragSyncStatus === 'PROCESSING' ||
                          selectedAudit.ragSyncStatus === 'FAILED') && (
                          <button
                            type="button"
                            onClick={() =>
                              void handleManualRagRetry(selectedProposal.id)
                            }
                            disabled={
                              retryingRagProposalId === selectedProposal.id
                            }
                            className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/40 text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                          >
                            <RefreshCw
                              className={`w-3.5 h-3.5 ${
                                retryingRagProposalId === selectedProposal.id
                                  ? 'animate-spin'
                                  : ''
                              }`}
                            />
                            RAG 장기 기억 동기화 재시도
                          </button>
                        )}
                    </div>
                  )}

                  {/* Diff Content */}
                  {workspaceState === 'LOADING_PREVIEW' ? (
                    <div className="p-10 text-center space-y-2 text-slate-400">
                      <Loader2 className="w-6 h-6 animate-spin mx-auto text-indigo-400" />
                      <div className="text-xs">
                        서버에서 현재 CANON 엔티티 및 원고 리비전 정합성을 검증하고 있습니다...
                      </div>
                    </div>
                  ) : isSupportedApprovalEntityType(
                      selectedProposal.targetEntityType
                    ) && previewData ? (
                    <ChangeProposalDiffView
                      proposedAction={previewData.proposedAction}
                      targetEntityType={previewData.targetEntityType}
                      targetEntityId={previewData.targetEntityId}
                      fieldDiffs={previewData.fieldDiffs}
                      canApprove={previewData.canApprove}
                      conflictCode={previewData.conflictCode}
                      conflictMessage={previewData.conflictMessage}
                      conflictDetails={previewData.conflictDetails}
                      verifiedExcerpt={previewData.verifiedExcerpt}
                      sourceRevisionId={previewData.sourceRevisionId}
                      expectedUpdatedAt={previewData.expectedUpdatedAt}
                      beforeSummary={selectedProposal.beforeSummary}
                      afterSummary={selectedProposal.afterSummary}
                      rationale={selectedProposal.rationale}
                      episodeTitleMap={episodeTitleMap}
                      isCloudVerified={previewData.isCloudVerified}
                      isLocalReferenceOnly={Boolean(
                        previewData.isLocalReferenceOnly
                      )}
                      onReverifyServer={
                        idToken
                          ? () => void loadProposalPreview(selectedProposal)
                          : undefined
                      }
                    />
                  ) : (
                    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-3 text-xs text-slate-300">
                      <div className="font-bold text-slate-100">
                        기존 캐릭터/세계관 제안 요약 ({selectedProposal.targetEntityType})
                      </div>
                      <p>변경 전: {selectedProposal.beforeSummary || '(없음)'}</p>
                      <p>변경 후: {selectedProposal.afterSummary || '(없음)'}</p>
                      <p>사유: {selectedProposal.rationale || '(없음)'}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal for Author Approve / Reject */}
      {confirmModalDecision && selectedProposal && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
          data-testid="proposal-confirm-modal"
        >
          <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl space-y-4">
            <div className="flex items-start gap-3">
              {confirmModalDecision === 'APPROVE' ? (
                <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0">
                  <ShieldCheck className="w-5 h-5" />
                </div>
              ) : (
                <div className="w-10 h-10 rounded-xl bg-rose-500/20 border border-rose-500/40 flex items-center justify-center text-rose-400 shrink-0">
                  <XCircle className="w-5 h-5" />
                </div>
              )}
              <div>
                <h4 className="text-base font-bold text-slate-100">
                  {confirmModalDecision === 'APPROVE'
                    ? '작가 최종 CANON 승인 확인'
                    : 'AI 제안 거절 확인'}
                </h4>
                <p className="text-xs text-slate-400 mt-1">
                  {confirmModalDecision === 'APPROVE'
                    ? '승인 즉시 서버 트랜잭션을 통해 대상 엔티티가 CANON 상태로 반영되며, 결정적 감사 이력 기록 후 AI 장기 기억(RAG) 색인이 자동 갱신됩니다.'
                    : '거절 시 실제 CANON 엔티티는 변경되지 않으며, 제안서 상태가 REJECTED로 전환되고 감사 이력에 거절 사유가 기록됩니다.'}
                </p>
              </div>
            </div>

            <div className="rounded-xl bg-slate-950 border border-slate-800 p-3.5 text-xs space-y-1">
              <div className="font-bold text-slate-200">
                {selectedProposal.title}
              </div>
              <div className="text-slate-400">
                대상: {selectedProposal.targetEntityType} (
                {selectedProposal.proposedAction}) · ID:{' '}
                <code>{selectedProposal.targetEntityId}</code>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-300">
                작가 검토 메모 (선택, 최대 1000자 — 감사 이력에 영구 기록)
              </label>
              <textarea
                rows={3}
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value.slice(0, 1000))}
                placeholder={
                  confirmModalDecision === 'APPROVE'
                    ? '예: 3화 검술 대련 장면 원고와 일치하여 정식 CANON 설정으로 승인함'
                    : '예: 아직 확정되지 않은 전개이므로 거절함'
                }
                data-testid="confirm-modal-review-note"
                className="w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setConfirmModalDecision(null);
                  setReviewNote('');
                }}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold cursor-pointer"
              >
                취소
              </button>
              <button
                type="button"
                data-testid="confirm-modal-submit-btn"
                disabled={
                  confirmModalDecision === 'APPROVE'
                    ? !canonApprovalEligibility.enabled
                    : !canRejectSelectedProposal
                }
                onClick={() => void handleConfirmDecisionExecution()}
                className={`px-4 py-2 rounded-xl text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 ${
                  confirmModalDecision === 'APPROVE'
                    ? 'bg-emerald-600 hover:bg-emerald-500'
                    : 'bg-rose-600 hover:bg-rose-500'
                }`}
              >
                {confirmModalDecision === 'APPROVE'
                  ? '최종 CANON 승인 실행'
                  : '제안 거절 확정'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
