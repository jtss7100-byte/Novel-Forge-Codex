import type { LiteraryQualityDimensionId } from './literaryQuality';
import type { NarrativePerspective } from './foundation';

export type EvaluationMode = 'DRY_RUN_FIXTURE' | 'LIVE_GEMINI' | 'DISABLED';
export const EVALUATION_ARMS = ['BASELINE', 'STYLE_ONLY', 'VOICE_ONLY', 'STYLE_AND_VOICE'] as const;
export type EvaluationArm = typeof EVALUATION_ARMS[number];
export type EvaluationTreatment = Exclude<EvaluationArm, 'BASELINE'>;
export const EVALUATION_SCENARIOS = [
  ['NW1', '성채의 일상'], ['NW2', '긴박한 전투'], ['NW3', '동료 간 갈등'],
  ['NW4', '신뢰가 형성되는 대화'], ['NW5', '배신 직후'], ['NW6', '불안과 트라우마'],
  ['NW7', '감정을 절제하는 인물'], ['NW8', '두 인물의 다른 말투'], ['NW9', '상급자와 하급자'],
  ['NW10', '1인칭 내적 독백'], ['NW11', '3인칭 제한 시점'], ['NW12', '이전 회차의 복선'],
] as const;
export type EvaluationScenarioId = typeof EVALUATION_SCENARIOS[number][0];
export const EVALUATION_DIMENSIONS = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8'] as const;
export const REVIEW_DIMENSIONS = [
  ['naturalness', '문장 자연스러움'], ['dialogue', '대사 개성'], ['psychology', '심리 묘사'],
  ['immersion', '장면 몰입감'], ['intent', '작가 의도 충실도'],
] as const;
export type ReviewDimension = typeof REVIEW_DIMENSIONS[number][0];
export type ReviewChoice = 'A' | 'B' | 'TIE' | 'DEFER';
export interface EvaluationRating {
  pairId: string;
  choice: ReviewChoice;
  comment?: string;
  dimensions?: Partial<Record<ReviewDimension, ReviewChoice>>;
}

export interface EvaluationSettings {
  operationId: string;
  scenarios: EvaluationScenarioId[];
  treatment: EvaluationTreatment;
  repeats: number;
  mode: Exclude<EvaluationMode, 'DISABLED'>;
  optIn: boolean;
  callBudget?: number;
}

export interface EvaluationProfileTrace {
  profileId: string;
  versionId: string;
  contentHash: string;
  projectId: string;
  targetCharacterId?: string;
  active: true;
  approval: 'APPROVED_SYNTHETIC_FIXTURE';
}

export interface EvaluationManifest {
  modelId: string;
  datasetVersion: string;
  writingPlanFingerprint: string;
  canonFingerprint: string;
  ragFingerprint: string;
  controlsFingerprint: string;
  qualityCriteriaFingerprint: string;
  perspective: NarrativePerspective;
  characters: string[];
  targetLength: number;
}

export const EVALUATION_INTEGRITY_CODES = [
  'CANON_VIOLATION', 'POV_VIOLATION', 'CHARACTER_IDENTITY_DRIFT', 'CHARACTER_VOICE_LEAKAGE',
  'UNAPPROVED_NEW_FACT', 'MISSING_REQUIRED_EVENT', 'FORBIDDEN_DEVELOPMENT', 'RAG_PROVENANCE_FAILURE',
] as const;
export type EvaluationIntegrityCode = typeof EVALUATION_INTEGRITY_CODES[number];
export interface EvaluationCandidate {
  status: string;
  issues: EvaluationIntegrityCode[];
  chars: number;
  scores: Partial<Record<LiteraryQualityDimensionId, number | null>>;
  qualityStatus: 'NOT_EVALUATED' | 'FIXTURE' | 'AI_AUXILIARY' | 'FAILED';
  style: EvaluationProfileTrace[];
  voice: EvaluationProfileTrace[];
  promptHash?: string;
  observedModelVersion?: string;
}

export interface EvaluationCase {
  caseId: string;
  scenarioId: EvaluationScenarioId;
  repeat: number;
  manifest: EvaluationManifest;
  baseline: EvaluationCandidate;
  treatment: EvaluationCandidate;
  comparable: boolean;
  exclusionReasons: string[];
  lengthDifferencePercent: number | null;
}

export interface EvaluationBlindPair {
  pairId: string;
  scenarioId: EvaluationScenarioId;
  title: string;
  goal: string;
  optionA: string;
  optionB: string;
}

export interface EvaluationTelemetry {
  plannedCalls: number;
  actualCalls: number;
  generationCalls: number;
  qualityCalls: number;
  measuredTokens: number;
  callsWithoutUsage: number;
  estimatedCostUsd: number | null;
  latencyMs: number;
  pricingReference?: string;
}
