import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Eye,
  EyeOff,
  FileCode2,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import type {
  ApprovalConflictCode,
  ApprovalConflictDetails,
  ChangeProposalFieldDiff,
} from '../types/changeProposalApproval';
import type { VerifiedExcerptPayload } from '../types/manuscriptExtraction';

interface ChangeProposalDiffViewProps {
  proposedAction: 'CREATE' | 'UPDATE';
  targetEntityType: 'RELATIONSHIP' | 'TIMELINE_EVENT' | 'FORESHADOWING';
  targetEntityId: string;
  fieldDiffs: ChangeProposalFieldDiff[];
  canApprove: boolean;
  conflictCode?: ApprovalConflictCode | string | null;
  conflictMessage?: string | null;
  conflictDetails?: ApprovalConflictDetails | null;
  verifiedExcerpt?:
    | (VerifiedExcerptPayload & {
        episodeId?: string;
        sceneId?: string;
        text?: string;
        excerpt?: string;
      })
    | null;
  sourceRevisionId?: string;
  sourceEpisodeId?: string;
  sourceSceneId?: string;
  expectedUpdatedAt?: string | null;
  beforeSummary?: string;
  afterSummary?: string;
  rationale?: string;
  episodeTitleMap?: Record<string, string>;
  isCloudVerified?: boolean;
  isLocalReferenceOnly?: boolean;
  onReverifyServer?: () => void;
}

const ENTITY_TYPE_LABELS: Record<
  'RELATIONSHIP' | 'TIMELINE_EVENT' | 'FORESHADOWING',
  string
> = {
  RELATIONSHIP: '인물 관계 (RELATIONSHIP)',
  TIMELINE_EVENT: '사건 연표 (TIMELINE_EVENT)',
  FORESHADOWING: '복선 관리 (FORESHADOWING)',
};

export const ChangeProposalDiffView: React.FC<ChangeProposalDiffViewProps> = ({
  proposedAction,
  targetEntityType,
  targetEntityId,
  fieldDiffs,
  canApprove,
  conflictCode,
  conflictMessage,
  conflictDetails,
  verifiedExcerpt,
  sourceRevisionId,
  sourceEpisodeId,
  sourceSceneId,
  expectedUpdatedAt,
  beforeSummary,
  afterSummary,
  rationale,
  episodeTitleMap = {},
  isCloudVerified = false,
  isLocalReferenceOnly = false,
  onReverifyServer,
}) => {
  const [showUnchanged, setShowUnchanged] = useState(true);

  const visibleDiffs = showUnchanged
    ? fieldDiffs
    : fieldDiffs.filter(
        (d) => d.changeType !== 'UNCHANGED' || Boolean(d.conflict)
      );

  const modifiedCount = fieldDiffs.filter(
    (d) => d.changeType === 'ADDED' || d.changeType === 'MODIFIED'
  ).length;
  const conflictFieldCount = fieldDiffs.filter((d) => d.conflict).length;

  return (
    <div className="space-y-4" data-testid="change-proposal-diff-view">
      {/* Section 5: Unverified Local Reference Comparison Warning Banner */}
      {(isLocalReferenceOnly || !isCloudVerified) && (
        <div
          className="rounded-xl border border-amber-500/40 bg-amber-950/30 p-3.5 text-amber-200 flex flex-wrap items-center justify-between gap-3"
          data-testid="local-reference-diff-banner"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="text-xs leading-relaxed">
              <span className="font-bold text-amber-100">
                로컬 참고용 비교 — 서버 검증이 완료되지 않았습니다.
              </span>{' '}
              <span className="text-amber-200/90">
                서버 검증(`POST /api/ai/change-proposals/preview`)이 성공적으로 완료되어야만 원자적 CANON 승인을 실행할 수 있습니다.
              </span>
            </div>
          </div>
          {onReverifyServer && (
            <button
              type="button"
              data-testid="diff-reverify-server-btn"
              onClick={onReverifyServer}
              className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 border border-amber-500/40 text-xs font-bold shrink-0 cursor-pointer"
            >
              서버 재검증
            </button>
          )}
        </div>
      )}

      {/* Conflict / Stale Warning Banner (Zero Force-Override) */}
      {(conflictCode || !canApprove) && (
        <div
          className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-4 text-rose-200 space-y-2"
          data-testid="proposal-conflict-banner"
        >
          <div className="flex items-start gap-2.5">
            <ShieldAlert className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            <div className="space-y-1 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30">
                  {conflictCode || 'APPROVAL_BLOCKED'}
                </span>
                <span className="text-sm font-bold text-rose-100">
                  원자적 CANON 반영 차단됨 (안전 보호 발동)
                </span>
              </div>
              <p className="text-xs text-rose-200/90 leading-relaxed">
                {conflictMessage ||
                  '현재 제안서는 대상 엔티티의 버전 불일치 또는 상태 조건 미충족으로 인해 승인할 수 없습니다.'}
              </p>
              {conflictDetails && (
                <div className="mt-2 pt-2 border-t border-rose-500/20 text-[11px] text-rose-300 space-y-1">
                  {conflictDetails.proposalSourceRevisionId && (
                    <div>
                      • 제안서 추출 당시 리비전:{' '}
                      <code className="text-rose-100 font-mono">
                        {conflictDetails.proposalSourceRevisionId}
                      </code>{' '}
                      → 현재 엔티티 리비전:{' '}
                      <code className="text-rose-100 font-mono">
                        {conflictDetails.currentEntitySourceRevisionId || '없음'}
                      </code>
                    </div>
                  )}
                  {conflictDetails.changedFields &&
                    conflictDetails.changedFields.length > 0 && (
                      <div>
                        • 충돌/변경 감지 필드:{' '}
                        <span className="font-semibold text-rose-100">
                          {conflictDetails.changedFields.join(', ')}
                        </span>
                      </div>
                    )}
                </div>
              )}
              <div className="pt-1 text-[11px] text-amber-300/90 font-medium">
                ※ NOVEL FORGE 보안 정책상 구버전 제안의 강제 덮어쓰기(forceApplyOnStale)는 엄격히 금지됩니다. 이 제안을 거절한 뒤 최신 원고에서 다시 추출하거나 설정 화면에서 직접 편집해 주세요.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Summary & Rationale Bar */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`text-xs font-bold px-2.5 py-0.5 rounded border ${
                proposedAction === 'CREATE'
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                  : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
              }`}
            >
              {proposedAction === 'CREATE' ? '신규 생성 (CREATE)' : '기존 CANON 수정 (UPDATE)'}
            </span>
            <span className="text-xs px-2.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 font-medium">
              {ENTITY_TYPE_LABELS[targetEntityType]}
            </span>
            <span className="text-xs text-slate-400 font-mono">
              대상 ID: {targetEntityId}
            </span>
          </div>

          <div className="flex items-center gap-2 text-[11px] text-slate-400">
            {sourceRevisionId && (
              <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">
                근거 리비전: {sourceRevisionId}
              </span>
            )}
            {expectedUpdatedAt && (
              <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">
                대상 기준시각: {expectedUpdatedAt.slice(0, 19).replace('T', ' ')}
              </span>
            )}
          </div>
        </div>

        {(beforeSummary || afterSummary) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
            <div className="rounded-lg bg-slate-950/70 border border-slate-800/80 p-3">
              <div className="text-[11px] font-semibold text-slate-400 mb-1">
                변경 전 요약 (Before Summary)
              </div>
              <div className="text-xs text-slate-300 leading-relaxed">
                {beforeSummary ||
                  (proposedAction === 'CREATE'
                    ? '(신규 생성 제안 — 기존 엔티티 없음)'
                    : '(변경 전 요약 없음)')}
              </div>
            </div>
            <div className="rounded-lg bg-indigo-950/25 border border-indigo-500/30 p-3">
              <div className="text-[11px] font-semibold text-indigo-300 mb-1 flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5" />
                승인 후 CANON 반영 요약 (After Summary)
              </div>
              <div className="text-xs text-slate-100 leading-relaxed">
                {afterSummary || '(승인 후 요약 없음)'}
              </div>
            </div>
          </div>
        )}

        {rationale && (
          <div className="rounded-lg bg-slate-950/60 border border-slate-800/80 p-3">
            <div className="text-[11px] font-semibold text-slate-400 mb-1">
              AI 추출 근거 및 편집 코멘트 (Rationale)
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">{rationale}</p>
          </div>
        )}
      </div>

      {/* Verified Manuscript Excerpt Card */}
      {verifiedExcerpt && (
        <div
          className="rounded-xl border border-amber-500/30 bg-amber-950/15 p-4 space-y-2"
          data-testid="proposal-verified-excerpt"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-bold text-amber-300">
              <BookOpen className="w-4 h-4" />
              서버 검증 원고 근거 발췌 (Verified Manuscript Span)
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-amber-200/80 font-mono">
              {(verifiedExcerpt.episodeId || sourceEpisodeId) && (
                <span className="px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/30">
                  회차:{' '}
                  {episodeTitleMap[
                    verifiedExcerpt.episodeId || sourceEpisodeId || ''
                  ] ||
                    verifiedExcerpt.episodeId ||
                    sourceEpisodeId}
                </span>
              )}
              {(verifiedExcerpt.sceneId || sourceSceneId) && (
                <span className="px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/30">
                  장면: {verifiedExcerpt.sceneId || sourceSceneId}
                </span>
              )}
              <span className="px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/30">
                UTF-16 Offset: [{verifiedExcerpt.startOffset}..
                {verifiedExcerpt.endOffset}]
              </span>
            </div>
          </div>
          <blockquote className="rounded-lg bg-slate-950/80 border-l-4 border-amber-400 p-3 text-xs text-slate-100 leading-relaxed whitespace-pre-wrap font-serif">
            “
            {verifiedExcerpt.excerpt ||
              verifiedExcerpt.matchedText ||
              verifiedExcerpt.text ||
              ''}
            ”
          </blockquote>
        </div>
      )}

      {/* Structured Field-by-Field Diff Table */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/80 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2 bg-slate-950/60">
          <div className="flex items-center gap-2">
            <FileCode2 className="w-4 h-4 text-indigo-400" />
            <span className="text-xs font-bold text-slate-100">
              필드별 CANON 반영 전후 비교 (Structured Field Diff)
            </span>
            <span className="text-[11px] px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-medium">
              변경 {modifiedCount}건
            </span>
            {conflictFieldCount > 0 && (
              <span className="text-[11px] px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 font-medium">
                충돌 {conflictFieldCount}건
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={() => setShowUnchanged((prev) => !prev)}
            className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-800/80 border border-slate-700 cursor-pointer"
          >
            {showUnchanged ? (
              <>
                <EyeOff className="w-3.5 h-3.5" />
                동일 필드 숨기기
              </>
            ) : (
              <>
                <Eye className="w-3.5 h-3.5" />
                전체 필드 보기 ({fieldDiffs.length})
              </>
            )}
          </button>
        </div>

        <div className="divide-y divide-slate-800/80">
          {visibleDiffs.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-400">
              표시할 변경 필드가 없습니다.
            </div>
          ) : (
            visibleDiffs.map((diff) => {
              const isAdded = diff.changeType === 'ADDED';
              const isModified = diff.changeType === 'MODIFIED';
              const isConflict = Boolean(diff.conflict || diff.isConflict);
              const rowKey = diff.fieldKey || diff.fieldName;

              return (
                <div
                  key={rowKey}
                  data-testid={`diff-row-${rowKey}`}
                  className={`p-3.5 transition ${
                    isConflict
                      ? 'bg-rose-950/25'
                      : isAdded
                        ? 'bg-emerald-950/15'
                        : isModified
                          ? 'bg-amber-950/15'
                          : 'bg-slate-900/40'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-slate-200">
                        {diff.label || diff.fieldLabel}
                      </span>
                      <span className="text-[11px] text-slate-500 font-mono">
                        ({rowKey})
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      {isConflict && (
                        <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40 flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" />
                          버전 충돌
                        </span>
                      )}
                      <span
                        className={`text-[11px] font-semibold px-2 py-0.5 rounded border ${
                          isAdded
                            ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                            : isModified
                              ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                              : 'bg-slate-800 text-slate-400 border-slate-700'
                        }`}
                      >
                        {isAdded
                          ? '신규 추가 (ADDED)'
                          : isModified
                            ? '값 변경 (MODIFIED)'
                            : '변경 없음 (UNCHANGED)'}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-11 gap-2 items-stretch">
                    <div className="md:col-span-5 rounded-lg bg-slate-950/70 border border-slate-800 p-2.5 text-xs text-slate-300 break-words">
                      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                        현재 CANON / 기존 값 (Before)
                      </div>
                      <div className="font-mono text-xs text-slate-300">
                        {diff.beforeValue === null || diff.beforeValue === '' ? (
                          <span className="text-slate-500 italic">(없음)</span>
                        ) : (
                          diff.beforeValue
                        )}
                      </div>
                    </div>

                    <div className="md:col-span-1 flex items-center justify-center text-slate-500 py-1">
                      <ArrowRight className="w-4 h-4" />
                    </div>

                    <div
                      className={`md:col-span-5 rounded-lg border p-2.5 text-xs break-words ${
                        isConflict
                          ? 'bg-rose-950/40 border-rose-500/40 text-rose-100'
                          : isAdded
                            ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-100'
                            : isModified
                              ? 'bg-amber-950/30 border-amber-500/30 text-amber-100'
                              : 'bg-slate-950/70 border-slate-800 text-slate-200'
                      }`}
                    >
                      <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1 flex items-center justify-between">
                        <span>승인 시 반영될 CANON 값 (After)</span>
                        {(isAdded || isModified) && !isConflict && (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        )}
                      </div>
                      <div className="font-mono text-xs">
                        {diff.afterValue === null || diff.afterValue === '' ? (
                          <span className="text-slate-500 italic">(없음)</span>
                        ) : (
                          diff.afterValue
                        )}
                      </div>
                    </div>
                  </div>

                  {diff.conflictReason && (
                    <div className="mt-2 text-[11px] text-rose-300 flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                      <span>{diff.conflictReason}</span>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
