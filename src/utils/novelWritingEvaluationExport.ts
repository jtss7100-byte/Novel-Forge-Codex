import { EVALUATION_DIMENSIONS, EVALUATION_INTEGRITY_CODES, type EvaluationCase, type EvaluationRating, type EvaluationSessionHeader, type EvaluationTelemetry } from '../types/novelWritingEvaluation';
import type { EvaluationSummary } from './novelWritingEvaluationLogic';

type ExportableReport = {
  mode: 'DRY_RUN_FIXTURE' | 'LIVE_GEMINI';
  cases: EvaluationCase[];
  telemetry: EvaluationTelemetry;
  ratings: EvaluationRating[];
  summary: EvaluationSummary;
};

export function pilotPreference(human: EvaluationSummary['human']) {
  if (!human.ratedCount) return 'NOT_RATED';
  if (human.rewritePreferredCount > human.originalPreferredCount) return 'TREATMENT_PREFERRED';
  if (human.originalPreferredCount > human.rewritePreferredCount) return 'BASELINE_PREFERRED';
  return 'TIE_OR_INCONCLUSIVE';
}

const safe = (value?: string) => value && /^[a-z0-9][a-z0-9:._-]{0,140}$/i.test(value) &&
  !/AIza[a-z0-9_-]{20,}|eyJ[a-z0-9_-]{20,}|(?:^|[-_])(?:api[-_]?key|token|secret)[-_]/i.test(value) ? value : 'UNKNOWN';
const numeric = (value?: number | null) => typeof value === 'number' && Number.isFinite(value) ? String(value) : 'UNKNOWN';

export function exportNovelWritingEvaluation(report: ExportableReport, session: EvaluationSessionHeader) {
  const telemetry = report.telemetry;
  return [
    '# NOVEL FORGE 집필 평가 요약',
    '',
    `- 평가 ID ${safe(session.operationId)}`,
    `- 평가 시각 ${safe((session.completedAt ?? session.createdAt).replace('Z', 'z'))}`,
    `- 데이터셋 ${safe(session.datasetVersion)}`,
    `- 모드 ${safe(report.mode)} · 모델 ${safe(session.modelId.replace(/^models\//, ''))}`,
    `- 전송 경로 ${safe(telemetry.transport)} · 확인된 실제 Gemini 전송 시도 ${telemetry.transport === 'GEMINI' ? numeric(telemetry.dispatchedCalls) : telemetry.transport ? '0' : 'UNKNOWN'} · 예약 ${numeric(telemetry.actualCalls)}/${numeric(telemetry.plannedCalls)}`,
    `- 측정 토큰 ${numeric(telemetry.measuredTokens)} · 추정 비용 USD ${numeric(telemetry.estimatedCostUsd)}`,
    `- 인간 평가 ${pilotPreference(report.summary.human)} · 통계적 유의성 NOT_ESTABLISHED`,
    `- 선호 선택 ${report.ratings.length ? report.ratings.map((rating) => safe(rating.choice)).join(', ') : 'NOT_RATED'}`,
    ...report.cases.flatMap((entry) => [
      '',
      `## 장면 ${safe(entry.scenarioId)}`,
      `- 통제 조건 ${safe(entry.manifest.controlsFingerprint)} · 공통 품질 기준 ${safe(entry.manifest.qualityCriteriaFingerprint)}`,
      ...([['기본', entry.baseline], ['적용', entry.treatment]] as const).flatMap(([label, arm]) => [
        `- ${label} · 집필 ${safe(arm.writerResponse?.code ?? arm.status)} · Q1~Q8 상태 ${safe(arm.qualityFailure ?? arm.qualityStatus)} · 종료 ${safe(arm.writerResponse?.finishReason)}`,
        `  - 응답 모델 ${safe(arm.observedModelVersion)} · 평가 모델 ${safe(arm.observedQualityModelVersion)} · 프롬프트 ${safe(arm.promptHash)}`,
        `  - Q1~Q8 ${EVALUATION_DIMENSIONS.map((id) => `${id} ${numeric(arm.scores[id])}`).join(' · ')}`,
        `  - 문체 준수도 ${numeric(arm.authorStyleAdherence?.score)} · 화법 준수도 ${numeric(arm.characterVoiceAdherence?.score)}`,
        `  - 무결성 ${arm.issues.filter((issue) => EVALUATION_INTEGRITY_CODES.includes(issue)).join(', ') || '탐지 없음'}`,
        `  - 승인 버전 ${[...arm.style, ...arm.voice].map((item) => safe(item.versionId)).join(', ') || '없음'}`,
      ]),
    ]),
    '',
    '공유 요약은 원고 본문과 자유 입력 코멘트를 제외합니다.',
  ].join('\n');
}
