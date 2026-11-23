import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Database,
  History,
  RefreshCw,
  ShieldCheck,
  UserCheck,
  XCircle,
} from 'lucide-react';
import type { ChangeProposalApprovalAudit } from '../types/changeProposalApproval';
import type { ChangeProposal } from '../types/novel';

interface ApprovalAuditHistoryProps {
  audits: ChangeProposalApprovalAudit[];
  proposals: ChangeProposal[];
  isLoading?: boolean;
  retryingProposalId?: string | null;
  onRetryRagSync?: (proposalId: string) => Promise<void>;
  onRefreshAudits?: () => Promise<void>;
}

const ENTITY_TYPE_LABELS: Record<string, string> = {
  RELATIONSHIP: '인물 관계 (RELATIONSHIP)',
  TIMELINE_EVENT: '사건 연표 (TIMELINE_EVENT)',
  FORESHADOWING: '복선 관리 (FORESHADOWING)',
};

export const ApprovalAuditHistory: React.FC<ApprovalAuditHistoryProps> = ({
  audits,
  proposals,
  isLoading = false,
  retryingProposalId = null,
  onRetryRagSync,
  onRefreshAudits,
}) => {
  const [filterDecision, setFilterDecision] = useState<
    'ALL' | 'APPROVED' | 'REJECTED' | 'RAG_NEEDS_SYNC'
  >('ALL');
  const [expandedAuditId, setExpandedAuditId] = useState<string | null>(null);

  const proposalTitleMap = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of proposals) {
      map[p.id] = p.title;
    }
    return map;
  }, [proposals]);

  const filteredAudits = audits.filter((audit) => {
    if (filterDecision === 'APPROVED') return audit.decision === 'APPROVED';
    if (filterDecision === 'REJECTED') return audit.decision === 'REJECTED';
    if (filterDecision === 'RAG_NEEDS_SYNC') {
      return (
        audit.decision === 'APPROVED' &&
        (audit.ragSyncStatus === 'PENDING' ||
          audit.ragSyncStatus === 'PROCESSING' ||
          audit.ragSyncStatus === 'FAILED')
      );
    }
    return true;
  });

  const renderRagBadge = (audit: ChangeProposalApprovalAudit) => {
    if (audit.decision === 'REJECTED' || audit.ragSyncStatus === 'NOT_REQUIRED') {
      return (
        <span className="text-[11px] px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
          RAG 색인 불필요 (NOT_REQUIRED)
        </span>
      );
    }
    if (audit.ragSyncStatus === 'SUPERSEDED') {
      return (
        <span className="text-[11px] px-2 py-0.5 rounded bg-violet-500/15 text-violet-300 border border-violet-500/30 flex items-center gap-1">
          <History className="w-3 h-3" />
          최신 CANON 대체됨 (SUPERSEDED)
        </span>
      );
    }
    if (audit.ragSyncStatus === 'SYNCED') {
      return (
        <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
          <Database className="w-3 h-3" />
          RAG 색인 완료 (SYNCED)
        </span>
      );
    }
    if (audit.ragSyncStatus === 'PROCESSING') {
      return (
        <span className="text-[11px] px-2 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/30 flex items-center gap-1">
          <RefreshCw className="w-3 h-3 animate-spin" />
          RAG 색인 진행 중 (PROCESSING)
        </span>
      );
    }
    if (audit.ragSyncStatus === 'FAILED') {
      return (
        <span className="text-[11px] px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" />
          RAG 동기화 실패 (재시도 가능)
        </span>
      );
    }
    return (
      <span className="text-[11px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center gap-1">
        <Clock className="w-3 h-3" />
        RAG 색인 대기 (PENDING)
      </span>
    );
  };

  return (
    <div className="space-y-4" data-testid="approval-audit-history">
      {/* Header & Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900/80 border border-slate-800 rounded-xl p-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
            <History className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100">
              작가 승인·거절 감사 이력 (ChangeProposalApprovalAudit)
            </h3>
            <p className="text-xs text-slate-400">
              원자적 CANON 반영 전후 스냅샷, 원고 근거 리비전, RAG 장기 기억 동기화 상태를 추적합니다.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
            {(
              [
                { key: 'ALL', label: `전체 (${audits.length})` },
                {
                  key: 'APPROVED',
                  label: `승인 (${audits.filter((a) => a.decision === 'APPROVED').length})`,
                },
                {
                  key: 'REJECTED',
                  label: `거절 (${audits.filter((a) => a.decision === 'REJECTED').length})`,
                },
                {
                  key: 'RAG_NEEDS_SYNC',
                  label: `RAG 미동기화 (${
                    audits.filter(
                      (a) =>
                        a.decision === 'APPROVED' &&
                        (a.ragSyncStatus === 'PENDING' ||
                          a.ragSyncStatus === 'FAILED')
                    ).length
                  })`,
                },
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setFilterDecision(tab.key)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition cursor-pointer ${
                  filterDecision === tab.key
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {onRefreshAudits && (
            <button
              type="button"
              onClick={() => void onRefreshAudits()}
              disabled={isLoading}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`}
              />
              새로고침
            </button>
          )}
        </div>
      </div>

      {/* Audit List */}
      {filteredAudits.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-8 text-center text-xs text-slate-400">
          기록된 감사 이력이 없습니다. 제안서를 승인하거나 거절하면 결정적 감사 이력(`audit_&#123;proposalId&#125;`)이 자동 생성됩니다.
        </div>
      ) : (
        <div className="space-y-3">
          {filteredAudits.map((audit) => {
            const isExpanded = expandedAuditId === audit.id;
            const proposalTitle =
              proposalTitleMap[audit.proposalId] || `제안서 #${audit.proposalId}`;
            const needsRagRetry =
              audit.decision === 'APPROVED' &&
              (audit.ragSyncStatus === 'PENDING' ||
                audit.ragSyncStatus === 'FAILED');
            const isRetrying = retryingProposalId === audit.proposalId;

            return (
              <div
                key={audit.id}
                data-testid={`audit-item-${audit.id}`}
                className="rounded-xl border border-slate-800 bg-slate-900/80 overflow-hidden"
              >
                <div className="p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      {audit.decision === 'APPROVED' ? (
                        <span className="text-xs font-bold px-2.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          CANON 승인 완료
                        </span>
                      ) : (
                        <span className="text-xs font-bold px-2.5 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30 flex items-center gap-1">
                          <XCircle className="w-3.5 h-3.5" />
                          제안 거절됨
                        </span>
                      )}

                      <span className="text-xs px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 font-medium">
                        {ENTITY_TYPE_LABELS[audit.targetEntityType] ||
                          audit.targetEntityType}
                      </span>

                      <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">
                        {audit.proposedAction}
                      </span>

                      {renderRagBadge(audit)}
                    </div>

                    <div className="text-sm font-bold text-slate-100">
                      {proposalTitle}
                    </div>

                    <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                      <span className="flex items-center gap-1">
                        <UserCheck className="w-3.5 h-3.5 text-slate-500" />
                        승인자: <code className="text-slate-300">{audit.reviewerUid}</code>
                      </span>
                      <span>
                        상태 전이:{' '}
                        <code className="text-slate-300">
                          {audit.beforeCanonStatus || 'NONE'} → {audit.afterCanonStatus}
                        </code>
                      </span>
                      {audit.sourceRevisionId && (
                        <span>
                          원고 리비전:{' '}
                          <code className="text-slate-300">
                            {audit.sourceRevisionId}
                          </code>
                        </span>
                      )}
                      <span>
                        기록 시각:{' '}
                        {(audit.updatedAt || audit.createdAt)
                          .slice(0, 19)
                          .replace('T', ' ')}
                      </span>
                    </div>

                    {audit.reviewNote && (
                      <div className="text-xs text-amber-200/90 bg-amber-950/20 border border-amber-500/20 rounded-lg px-3 py-1.5 mt-1">
                        작가 메모: {audit.reviewNote}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {needsRagRetry && onRetryRagSync && (
                      <button
                        type="button"
                        data-testid={`retry-rag-sync-${audit.proposalId}`}
                        onClick={() => void onRetryRagSync(audit.proposalId)}
                        disabled={isRetrying}
                        className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/40 text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 ${isRetrying ? 'animate-spin' : ''}`}
                        />
                        {isRetrying
                          ? 'RAG 동기화 중...'
                          : 'RAG 장기 기억 동기화 재시도'}
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() =>
                        setExpandedAuditId(isExpanded ? null : audit.id)
                      }
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs font-medium flex items-center gap-1 cursor-pointer"
                    >
                      {isExpanded ? (
                        <>
                          스냅샷 접기
                          <ChevronUp className="w-3.5 h-3.5" />
                        </>
                      ) : (
                        <>
                          전후 스냅샷 상세
                          <ChevronDown className="w-3.5 h-3.5" />
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-slate-800 bg-slate-950/80 p-4 space-y-3 text-xs">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                      <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
                        <div className="text-[11px] font-semibold text-slate-400 mb-1.5">
                          반영 전 스냅샷 (beforeSnapshotJson)
                        </div>
                        <pre className="text-[11px] text-slate-300 font-mono whitespace-pre-wrap break-all max-h-52 overflow-y-auto">
                          {audit.beforeSnapshotJson || '(신규 생성 — 이전 스냅샷 없음)'}
                        </pre>
                      </div>
                      <div className="rounded-lg border border-indigo-500/30 bg-indigo-950/15 p-3">
                        <div className="text-[11px] font-semibold text-indigo-300 mb-1.5 flex items-center gap-1">
                          <ShieldCheck className="w-3.5 h-3.5" />
                          반영 후 스냅샷 (afterSnapshotJson)
                        </div>
                        <pre className="text-[11px] text-slate-200 font-mono whitespace-pre-wrap break-all max-h-52 overflow-y-auto">
                          {audit.afterSnapshotJson || '(거절됨 — 엔티티 변경 없음)'}
                        </pre>
                      </div>
                    </div>

                    {audit.verifiedExcerptJson && (
                      <div className="rounded-lg border border-amber-500/20 bg-amber-950/10 p-3">
                        <div className="text-[11px] font-semibold text-amber-300 mb-1">
                          검증된 원고 근거 발췌 (verifiedExcerptJson)
                        </div>
                        <pre className="text-[11px] text-amber-100/90 font-mono whitespace-pre-wrap break-all">
                          {audit.verifiedExcerptJson}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
