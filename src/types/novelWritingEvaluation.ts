import type { LiteraryQualityDimensionId } from './literaryQuality';
import type { NarrativePerspective } from './foundation';

export type EvaluationMode = 'DRY_RUN_FIXTURE' | 'LIVE_GEMINI' | 'DISABLED';
export const EVALUATION_SESSION_STATUSES = ['CREATED', 'RUNNING', 'AWAITING_HUMAN_REVIEW', 'FINALIZED', 'CANCELLED', 'INTERRUPTED', 'FAILED'] as const;
export type EvaluationSessionStatus = typeof EVALUATION_SESSION_STATUSES[number];
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
export const LIVE_EVALUATION_FIRST_SCENARIO = 'NW8';
export const LIVE_EVALUATION_FOLLOW_UP_SCENARIOS = ['NW6', 'NW10'] as const;
export const LIVE_EVALUATION_CALLS = 4;
export const EVALUATION_MODEL_SETTINGS = { temperature: 0.7, topP: 0.9, maxOutputTokens: 2048 };
export const EVALUATION_RESPONSE_CODES = [
  'SUCCESS', 'MODEL_NOT_AVAILABLE', 'API_AUTH_FAILED', 'RATE_LIMITED', 'TIMEOUT', 'INVALID_JSON',
  'SCHEMA_VALIDATION_FAILED', 'INCOMPLETE_GENERATION', 'BLOCKED_BY_CANON', 'OUTPUT_TRUNCATED',
  'REMOTE_CALL_OUTCOME_UNKNOWN', 'REQUEST_REJECTED', 'MODEL_VERSION_MISMATCH', 'CANCELLED',
] as const;
export type EvaluationResponseCode = typeof EVALUATION_RESPONSE_CODES[number];
export interface EvaluationResponseTrace {
  code: EvaluationResponseCode;
  finishReason?: string;
  json?: 'VALID' | 'INVALID';
  schema?: 'VALID' | 'INVALID';
  manuscriptState?: 'DRAFT_READY' | 'BLOCKED_CONFLICT' | 'BLOCKED_MISSING_INFO';
  usage?: { prompt?: number; output?: number; thinking?: number; total?: number };
}
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
  qualityRubricVersion: string;
  perspective: NarrativePerspective;
  characters: string[];
  targetLength: number;
}

export interface EvaluationAdherence {
  score: number | null;
  confidence: 'LOW' | 'MEDIUM';
  status: 'FIXTURE' | 'HEURISTIC' | 'INSUFFICIENT_EVIDENCE';
  rubricVersion: string;
  targets: EvaluationProfileTrace[];
  evidence: { criterion: string; matched: number; observed: number; characterId?: string }[];
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
  withinTargetLength?: boolean;
  scores: Partial<Record<LiteraryQualityDimensionId, number | null>>;
  qualityStatus: 'NOT_EVALUATED' | 'FIXTURE' | 'AI_AUXILIARY' | 'FAILED';
  style: EvaluationProfileTrace[];
  voice: EvaluationProfileTrace[];
  promptHash?: string;
  observedModelVersion?: string;
  observedQualityModelVersion?: string;
  writerResponse?: EvaluationResponseTrace;
  qualityResponse?: EvaluationResponseTrace;
  qualityFailure?: string;
  authorStyleAdherence?: EvaluationAdherence;
  characterVoiceAdherence?: EvaluationAdherence;
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
  baselineText?: string;
  treatmentText?: string;
}

export interface EvaluationSessionHeader {
  operationId: string;
  status: EvaluationSessionStatus;
  version: number;
  datasetVersion: string;
  modelId: string;
  mode: EvaluationSettings['mode'];
  treatment: EvaluationTreatment;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  humanRatingStatus: 'NOT_RATED' | 'DRAFT' | 'RATED';
  reason?: string;
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
  transport?: 'GEMINI' | 'TEST_TRANSPORT' | 'FIXTURE';
  dispatchedCalls?: number;
  receivedResponses?: number;
}
