import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpenCheck,
  Check,
  Loader2,
  ShieldAlert,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import type {
  LiteraryQualityDecision,
  LiteraryQualityFinding,
  LiteraryQualityReport,
} from '../types/literaryQuality';
import {
  applyApprovedQualityFindingsToManuscript,
  computeManuscriptContentHash,
  LITERARY_QUALITY_DIMENSIONS,
} from '../utils/literaryQualityLogic';

interface LiteraryQualityPanelProps {
  activeManuscript: string;
  currentRevisionId: string;
  isBusy: boolean;
  isEvaluating: boolean;
  report: LiteraryQualityReport | null;
  errorMessage: string | null;
  onRunEvaluation: (options: { includeStyleEditorAudit: boolean }) => Promise<void>;
  onUpdateFindingDecision: (
    findingId: string,
    decision: LiteraryQualityDecision
  ) => void;
  onBulkDecision: (decision: 'ACCEPTED' | 'REJECTED') => void;
  onApplyRevisedManuscript: (
    revisedManuscript: string,
    appliedFindingIds: string[]
  ) => Promise<void>;
  onRequestRewriteForFinding?: (finding: LiteraryQualityFinding) => void;
}

const SEVERITY_STYLES: Record<
  LiteraryQualityFinding['severity'],
  { label: string; borderClass: string; textClass: string }
> = {
  IMPORTANT: {
    label: '중요 개선 (IMPORTANT)',
    borderClass: 'border-rose-500/40 bg-rose-500/10',
    textClass: 'text-rose-300',
  },
  SUGGESTION: {
    label: '제안 (SUGGESTION)',
    borderClass: 'border-amber-500/40 bg-amber-500/10',
    textClass: 'text-amber-300',
  },
  INFO: {
    label: '참고 (INFO)',
    borderClass: 'border-sky-500/40 bg-sky-500/10',
    textClass: 'text-sky-300',
  },
};

export const LiteraryQualityPanel: React.FC<LiteraryQualityPanelProps> = ({
  activeManuscript,
  currentRevisionId,
  isBusy,
  isEvaluating,
  report,
  errorMessage,
  onRunEvaluation,
  onUpdateFindingDecision,
  onBulkDecision,
  onApplyRevisedManuscript,
  onRequestRewriteForFinding,
}) => {
  const [includeStyleEditorAudit, setIncludeStyleEditorAudit] =
    useState<boolean>(false);
  const [applyFeedback, setApplyFeedback] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState<boolean>(false);

  const liveContentHash = useMemo(
    () => computeManuscriptContentHash(activeManuscript),
    [activeManuscript]
  );

  const isStaleAgainstCurrentManuscript = useMemo(() => {
    if (!report || report.executionStatus !== 'COMPLETED') return false;
    return (
      report.sourceContentHash !== liveContentHash ||
      report.sourceRevisionId !== currentRevisionId
    );
  }, [report, liveContentHash, currentRevisionId]);

  const acceptedCount = useMemo(() => {
    if (!report) return 0;
    return report.findings.filter(
      (f) =>
        f.decision === 'ACCEPTED' &&
        f.offsetVerified &&
        typeof f.suggestedRevision === 'string' &&
        f.suggestedRevision.trim().length > 0
    ).length;
  }, [report]);

  const previewPatchResult = useMemo(() => {
    if (!report || report.executionStatus !== 'COMPLETED') return null;
    return applyApprovedQualityFindingsToManuscript({
      originalManuscript: activeManuscript,
      currentRevisionId,
      currentContentHash: liveContentHash,
      report,
    });
  }, [report, activeManuscript, currentRevisionId, liveContentHash]);

  const handleApplyClick = async () => {
    if (!report || isApplying || isStaleAgainstCurrentManuscript) return;
    const patch = applyApprovedQualityFindingsToManuscript({
      originalManuscript: activeManuscript,
      currentRevisionId,
      currentContentHash: liveContentHash,
      report,
    });
    if (!patch.applied) {
      setApplyFeedback(
        patch.errorMessage || '적용할 수 있는 수락된 수정 제안이 없습니다.'
      );
      return;
    }

    setIsApplying(true);
    setApplyFeedback(null);
    try {
      await onApplyRevisedManuscript(
        patch.revisedManuscript,
        patch.appliedFindingIds
      );
      setApplyFeedback(
        `작가 승인 수정안 ${patch.appliedFindingIds.length}건을 안전 백업 후 원고에 반영했습니다.`
      );
    } catch (err) {
      setApplyFeedback(
        err instanceof Error
          ? err.message
          : '수정안 반영 중 오류가 발생했습니다.'
      );
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <section
      aria-label="문학적 품질 진단 패널"
      data-testid="literary-quality-panel"
      className="rounded-xl border border-indigo-500/30 bg-slate-950/90 p-4 space-y-4"
    >
      {/* Header & Execution Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-start gap-2">
            <BookOpenCheck className="h-4 w-4 text-indigo-400 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <h3 className="text-xs font-bold uppercase tracking-wider text-indigo-300 break-words">
                문학적 품질 진단 (Q1~Q8 편집 분석 · 작가 승인 후 반영)
              </h3>
              <span
                data-testid="quality-execution-status"
                className="font-mono-tabular text-[11px] text-slate-400 break-all"
              >
                상태: {report ? report.executionStatus : 'NOT_RUN'}
              </span>
            </div>
          </div>
          <p className="text-[11px] text-slate-400 break-words">
            문장 자연스러움·리듬·대사 개성·심리 설득력·인과·묘사 밀도·정보 균형·반복을 진단합니다. 원본 원고와 CANON 설정은 자동 변경되지 않습니다.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={includeStyleEditorAudit}
              onChange={(e) => setIncludeStyleEditorAudit(e.target.checked)}
              disabled={isBusy || isEvaluating}
              className="accent-indigo-400"
            />
            <span>문체 검수(Style Editor) 병합</span>
          </label>

          <button
            type="button"
            data-testid="run-literary-quality-btn"
            disabled={isBusy || isEvaluating}
            onClick={() => onRunEvaluation({ includeStyleEditorAudit })}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-500 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-400 disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            {isEvaluating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            <span>{isEvaluating ? '품질 진단 중...' : '원고 품질 진단'}</span>
          </button>
        </div>
      </div>

      {/* Evaluation Failure Banner (Draft Preserved) */}
      {(errorMessage ||
        report?.executionStatus === 'QUALITY_EVALUATION_FAILED') && (
        <div
          role="alert"
          data-testid="quality-error-banner"
          className="flex items-start gap-2.5 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200"
        >
          <ShieldAlert className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="font-semibold text-rose-300 break-words">
              문학적 품질 진단 실패 (QUALITY_EVALUATION_FAILED · 기존 원고 초안 보존됨)
            </div>
            <div className="break-all sm:break-words">
              {errorMessage ||
                report?.errorMessage ||
                '품질 진단 실행 중 오류가 발생했으나 기존 원고 본문과 설정은 변경 없이 그대로 유지됩니다.'}
            </div>
          </div>
        </div>
      )}

      {/* Stale Hash / Revision Warning */}
      {isStaleAgainstCurrentManuscript && (
        <div
          role="alert"
          data-testid="quality-stale-warning"
          className="flex items-start gap-2.5 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-amber-200"
        >
          <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1 break-words">
            <strong className="text-amber-300">원고 해시/버전 변경 감지:</strong>{' '}
            품질 진단 실행 이후 원고 본문이 편집되었습니다. 오프셋 어긋남 방지를 위해 이전 수정안 일괄 적용이 잠겼습니다. <strong>[원고 품질 진단]</strong>을 다시 실행해 주세요.
          </div>
        </div>
      )}

      {applyFeedback && (
        <div
          role="status"
          data-testid="quality-apply-feedback"
          className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200"
        >
          {applyFeedback}
        </div>
      )}

      {/* Empty Initial State */}
      {!report && !errorMessage && (
        <div className="rounded-lg border border-slate-800/80 bg-slate-900/50 p-3.5 text-xs text-slate-400">
          아직 문학적 품질 진단을 실행하지 않았습니다. 현재 에디터 또는 임시 초안 원고를 기준으로{' '}
          <strong className="text-indigo-300">[원고 품질 진단]</strong>을 눌러 Q1~Q8 평가 리포트와 선택 적용 가능한 수정 제안을 받아보세요.
        </div>
      )}

      {/* Completed Report View */}
      {report && report.executionStatus === 'COMPLETED' && (
        <div className="space-y-4">
          {/* Overall Assessment & Provenance Metadata */}
          <div className="rounded-lg border border-slate-800 bg-slate-900/90 p-3.5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-indigo-300">
                편집 총평
              </span>
              <div className="font-mono-tabular text-[11px] text-slate-400">
                <span>시점: {report.appliedPerspective}</span>
                <span aria-hidden="true"> · </span>
                <span>해시: {report.sourceContentHash.slice(0, 14)}</span>
                <span aria-hidden="true"> · </span>
                <span>
                  API 호출: 품질 {report.usageTelemetry.qualityApiCallCount}회 / 문체{' '}
                  {report.usageTelemetry.styleEditorApiCallCount}회
                </span>
                <span aria-hidden="true"> · </span>
                <span>
                  토큰: {report.usageTelemetry.combinedUsageMetadata.totalTokenCount.toLocaleString()}
                </span>
              </div>
            </div>
            <p className="text-xs leading-relaxed text-slate-200">
              {report.overallAssessment}
            </p>
            {report.rejectedFindingCount > 0 && (
              <div className="text-[11px] text-amber-300">
                ※ 원고 근거/오프셋 검증을 통과하지 못한 모호하거나 존재하지 않는 발췌 {report.rejectedFindingCount}건은 자동 필터링되었습니다.
              </div>
            )}
          </div>

          {/* 8 Dimension Summary Grid (Q1~Q8) */}
          <div
            data-testid="quality-dimensions-grid"
            className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4"
          >
            {report.dimensions.map((dim) => {
              const meta = LITERARY_QUALITY_DIMENSIONS[dim.category];
              const scoreColor =
                dim.score === null
                  ? 'text-slate-400'
                  : dim.score >= 80
                  ? 'text-emerald-300'
                  : dim.score >= 60
                  ? 'text-amber-300'
                  : 'text-rose-300';
              return (
                <div
                  key={dim.category}
                  className="rounded-lg border border-slate-800 bg-slate-900/70 p-3 space-y-1"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-200">
                      {dim.category} · {meta.shortLabelKo}
                    </span>
                    <span className={`font-mono-tabular text-xs font-bold ${scoreColor}`}>
                      {dim.score !== null ? `${dim.score}점` : '보류'}
                    </span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-slate-400">
                    {dim.explanation}
                  </p>
                  <div className="font-mono-tabular text-[10px] text-slate-500">
                    신뢰도: {dim.confidence}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Per-Finding Editorial Cards & Action Controls */}
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900 p-2.5 text-xs">
              <div className="text-slate-300">
                검증된 수정 제안 총{' '}
                <strong className="font-mono-tabular text-slate-100">
                  {report.findings.length}
                </strong>
                건 (수락됨:{' '}
                <strong className="font-mono-tabular text-emerald-300">
                  {acceptedCount}
                </strong>
                건)
              </div>

              {report.findings.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onBulkDecision('ACCEPTED')}
                    disabled={isStaleAgainstCurrentManuscript || isApplying}
                    className="rounded bg-emerald-500/20 px-2.5 py-1 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-40"
                  >
                    전체 수락
                  </button>
                  <button
                    type="button"
                    onClick={() => onBulkDecision('REJECTED')}
                    disabled={isApplying}
                    className="rounded bg-slate-800 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-700 disabled:opacity-40"
                  >
                    원본 유지 (전체 거절)
                  </button>
                  <button
                    type="button"
                    data-testid="apply-quality-revisions-btn"
                    onClick={handleApplyClick}
                    disabled={
                      isApplying ||
                      isStaleAgainstCurrentManuscript ||
                      acceptedCount === 0 ||
                      (previewPatchResult !== null && !previewPatchResult.applied)
                    }
                    className="rounded bg-amber-500 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40"
                  >
                    {isApplying
                      ? '반영 중...'
                      : `수락한 수정안 원고에 적용 (${acceptedCount}건 · 백업 포함)`}
                  </button>
                </div>
              )}
            </div>

            {previewPatchResult &&
              !previewPatchResult.applied &&
              previewPatchResult.blockedReason === 'OVERLAPPING_REVISIONS' && (
                <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2.5 text-xs text-rose-200">
                  {previewPatchResult.errorMessage}
                </div>
              )}

            {report.findings.length === 0 ? (
              <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3.5 text-xs text-emerald-300">
                현재 원고에서 즉시 수정을 권장할 중대한 문학적 결함이 발견되지 않았습니다.
              </div>
            ) : (
              <div className="space-y-2.5 max-h-[460px] overflow-y-auto pr-1">
                {report.findings.map((finding) => {
                  const sev = SEVERITY_STYLES[finding.severity];
                  const meta = LITERARY_QUALITY_DIMENSIONS[finding.category];
                  return (
                    <div
                      key={finding.findingId}
                      data-testid={`quality-finding-${finding.findingId}`}
                      className="rounded-lg border border-slate-800 bg-slate-900 p-3.5 text-xs space-y-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-indigo-300">
                            {finding.category} · {meta.titleKo}
                          </span>
                          <span aria-hidden="true" className="text-slate-600">
                            ·
                          </span>
                          <span
                            className={`rounded border px-2 py-0.5 text-[10px] font-semibold ${sev.borderClass} ${sev.textClass}`}
                          >
                            {sev.label}
                          </span>
                          {finding.startOffset !== null &&
                            finding.endOffset !== null && (
                              <span className="font-mono-tabular text-[11px] text-slate-400">
                                위치 {finding.startOffset}~{finding.endOffset}자
                              </span>
                            )}
                          {finding.sourceModule === 'STYLE_EDITOR_MERGED' && (
                            <span className="font-mono-tabular text-[10px] text-purple-300">
                              · Style Editor 통합
                            </span>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          {onRequestRewriteForFinding &&
                            finding.startOffset !== null &&
                            finding.endOffset !== null &&
                            finding.endOffset > finding.startOffset && (
                              <button
                                type="button"
                                data-testid={`quality-rewrite-btn-${finding.findingId}`}
                                disabled={isBusy || isStaleAgainstCurrentManuscript}
                                onClick={() => onRequestRewriteForFinding(finding)}
                                className="inline-flex items-center gap-1 rounded border border-indigo-500/50 bg-indigo-500/15 px-2 py-1 text-[11px] font-semibold text-indigo-200 hover:bg-indigo-500/25 disabled:opacity-40"
                              >
                                <Wand2 className="h-3 w-3" />
                                <span>정밀 리라이팅</span>
                              </button>
                            )}
                          <button
                            type="button"
                            onClick={() =>
                              onUpdateFindingDecision(
                                finding.findingId,
                                'ACCEPTED'
                              )
                            }
                            disabled={isStaleAgainstCurrentManuscript}
                            className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold disabled:opacity-40 ${
                              finding.decision === 'ACCEPTED'
                                ? 'bg-emerald-500 text-slate-950'
                                : 'border border-slate-700 text-slate-300 hover:bg-slate-800'
                            }`}
                          >
                            <Check className="h-3 w-3" />
                            <span>수락</span>
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              onUpdateFindingDecision(
                                finding.findingId,
                                'REJECTED'
                              )
                            }
                            className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold ${
                              finding.decision === 'REJECTED'
                                ? 'bg-rose-500 text-white'
                                : 'border border-slate-700 text-slate-300 hover:bg-slate-800'
                            }`}
                          >
                            <X className="h-3 w-3" />
                            <span>거절</span>
                          </button>
                        </div>
                      </div>

                      <div className="space-y-1 text-slate-300">
                        <div>
                          <strong className="text-slate-100">진단:</strong>{' '}
                          {finding.problem}
                        </div>
                        <div className="text-[11px] text-slate-400">
                          <strong>편집 이유:</strong> {finding.reason} ·{' '}
                          <strong className="text-emerald-300/90">기대 효과:</strong>{' '}
                          {finding.expectedBenefit}
                        </div>
                        {finding.canonRuleWarning && (
                          <div className="text-[11px] text-amber-300">
                            ※ 설정/시점 참고: {finding.canonRuleWarning}
                          </div>
                        )}
                      </div>

                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 pt-1">
                        <div className="min-w-0 rounded border border-rose-500/30 bg-rose-500/5 p-2.5">
                          <div className="text-[10px] font-semibold text-rose-300 mb-1">
                            원문 발췌
                          </div>
                          <div className="text-slate-200 whitespace-pre-wrap break-words">
                            {finding.originalExcerpt}
                          </div>
                        </div>
                        <div className="min-w-0 rounded border border-emerald-500/30 bg-emerald-500/5 p-2.5">
                          <div className="text-[10px] font-semibold text-emerald-300 mb-1">
                            수정 제안 (작가 승인 필요)
                          </div>
                          <div className="text-slate-100 whitespace-pre-wrap break-words">
                            {finding.suggestedRevision ||
                              '(직접 수정안 없음 — 편집 참고 전용)'}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
