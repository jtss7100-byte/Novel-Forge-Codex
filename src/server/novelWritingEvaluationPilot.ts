import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { FinishReason, type GenerateContentResponse, type Model } from '@google/genai';
import { EVALUATION_DIMENSIONS, EVALUATION_MODEL_SETTINGS, LIVE_EVALUATION_CALLS, LIVE_EVALUATION_FIRST_SCENARIO, LIVE_EVALUATION_FOLLOW_UP_SCENARIOS, type EvaluationResponseCode, type EvaluationResponseTrace, type EvaluationSettings } from '../types/novelWritingEvaluation';
import { NovelForgeWriterResponseSchema, NOVELFORGE_WRITER_GEMINI_RESPONSE_SCHEMA } from '../utils/aiEngineLogic';
import { LiteraryQualityAiOutputSchema, LITERARY_QUALITY_GEMINI_RESPONSE_SCHEMA } from '../utils/literaryQualityLogic';
import { buildEvaluationFixture, EVALUATION_DATASET_VERSION } from '../utils/novelWritingEvaluationBenchmark';
import { pinCommonQuality, prepareEvaluationArm } from '../utils/novelWritingEvaluationLogic';
import { getConfiguredWritingModel, getGenAiClient, isGeminiApiKeyReady } from './geminiWritingEngine';

export class EvaluationRequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function assertEvaluationPilotScope(settings: EvaluationSettings, initialCompleted: boolean) {
  if (settings.mode !== 'LIVE_GEMINI') return;
  const [scene] = settings.scenarios;
  const followUp = LIVE_EVALUATION_FOLLOW_UP_SCENARIOS.some((id) => id === scene);
  if (settings.scenarios.length !== 1 || settings.repeats !== 1 || settings.treatment !== 'STYLE_AND_VOICE' ||
      (scene !== LIVE_EVALUATION_FIRST_SCENARIO && !followUp)) throw new EvaluationRequestError(400, 'PILOT_SCOPE_REQUIRED');
  if (settings.callBudget !== LIVE_EVALUATION_CALLS) throw new EvaluationRequestError(400, 'PILOT_BUDGET_MUST_BE_FOUR');
  if (!settings.optIn) throw new EvaluationRequestError(403, 'PILOT_OPT_IN_REQUIRED');
  if (followUp && !initialCompleted) throw new EvaluationRequestError(409, 'PILOT_NW8_REQUIRED');
}

const isRuntimeModel = (model: string) => /^(?:models\/)?gemini-[a-z0-9][a-z0-9.-]{0,100}$/i.test(model);
export function evaluationModelVersion(value: string | undefined) {
  return value && /^[a-z0-9][a-z0-9._-]{0,119}$/i.test(value) &&
    !/AIza[a-z0-9_-]{20,}|eyJ[a-z0-9_-]{20,}/i.test(value) ? value : undefined;
}

export function evaluationRejectionStatus(error: unknown) {
  return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
    ? error.status : undefined;
}

export function classifyEvaluationApiFailure(error: unknown): EvaluationResponseCode {
  const status = evaluationRejectionStatus(error);
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  if (status === 404 || /\bNOT_FOUND\b/.test(message)) return 'MODEL_NOT_AVAILABLE';
  if (status === 401 || status === 403 || /API_KEY_INVALID|UNAUTHENTICATED|PERMISSION_DENIED/.test(message)) return 'API_AUTH_FAILED';
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(message)) return 'RATE_LIMITED';
  if ([408, 504].includes(Number(status)) || name === 'TimeoutError' || /MODEL_TIMEOUT|DEADLINE_EXCEEDED|ETIMEDOUT/.test(message)) return 'TIMEOUT';
  if (name === 'AbortError' || message === 'ABORTED_BY_USER') return 'CANCELLED';
  if (typeof status === 'number' && status >= 400 && status < 500) return 'REQUEST_REJECTED';
  return 'REMOTE_CALL_OUTCOME_UNKNOWN';
}

export function inspectPilotResponse(response: GenerateContentResponse, kind: 'generation' | 'quality'): EvaluationResponseTrace {
  const finishReason = response.candidates?.[0]?.finishReason;
  const usage = response.usageMetadata;
  const tokens = (value?: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const trace: EvaluationResponseTrace = {
    code: 'INCOMPLETE_GENERATION', finishReason: evaluationModelVersion(finishReason),
    usage: usage ? { prompt: tokens(usage.promptTokenCount), output: tokens(usage.candidatesTokenCount),
      thinking: tokens(usage.thoughtsTokenCount), total: tokens(usage.totalTokenCount) } : undefined,
  };
  if (finishReason === FinishReason.MAX_TOKENS) return { ...trace, code: 'OUTPUT_TRUNCATED' };
  if (finishReason !== FinishReason.STOP || response.candidates?.length !== 1 || !response.text?.trim()) return trace;
  let value: unknown;
  try { value = JSON.parse(response.text); }
  catch { return { ...trace, code: 'INVALID_JSON', json: 'INVALID' }; }
  trace.json = 'VALID';
  if (kind === 'quality') {
    const checked = LiteraryQualityAiOutputSchema.safeParse(value);
    if (checked.success && checked.data.dimensions.length === EVALUATION_DIMENSIONS.length &&
        EVALUATION_DIMENSIONS.every((dimension) => checked.data.dimensions.some((grade) => grade.category === dimension && grade.score !== null))) {
      return { ...trace, code: 'SUCCESS', schema: 'VALID' };
    }
  } else {
    const checked = NovelForgeWriterResponseSchema.safeParse(value);
    if (checked.success && (checked.data.manuscript_state === 'DRAFT_READY' || !checked.data.manuscript.trim())) {
      const state = checked.data.manuscript_state;
      return { ...trace, code: state === 'BLOCKED_CONFLICT' ? 'BLOCKED_BY_CANON' :
        state === 'BLOCKED_MISSING_INFO' || checked.data.manuscript.trim().length < 50 ? 'INCOMPLETE_GENERATION' : 'SUCCESS',
        manuscriptState: state, schema: 'VALID' };
    }
  }
  return { ...trace, code: 'SCHEMA_VALIDATION_FAILED', schema: 'INVALID' };
}

type ModelInfo = Pick<Model, 'supportedActions' | 'version' | 'outputTokenLimit'>;
type PreflightDeps = {
  authenticated: boolean;
  readStorage?: () => Promise<boolean>;
  readModel?: (modelId: string) => Promise<ModelInfo>;
};

function sdkVersion() {
  try {
    const entry = createRequire(import.meta.url).resolve('@google/genai');
    const manifest: { version?: string } = JSON.parse(readFileSync(resolve(entry, '../../../package.json'), 'utf8'));
    return evaluationModelVersion(manifest.version) ?? 'UNKNOWN';
  } catch { return 'UNKNOWN'; }
}

export async function verifyEvaluationPilotModel(modelId: string, readModel?: PreflightDeps['readModel']) {
  if (!isRuntimeModel(modelId)) return { status: 'MODEL_NOT_AVAILABLE' as const };
  try {
    const model = await (readModel?.(modelId) ?? getGenAiClient().models.get({
      model: modelId,
      config: { httpOptions: { timeout: 8_000, retryOptions: { attempts: 1 } }, abortSignal: AbortSignal.timeout(8000) },
    }));
    const limit = model.outputTokenLimit;
    if (!model.supportedActions?.includes('generateContent') || !limit || !Number.isSafeInteger(limit) ||
        limit < EVALUATION_MODEL_SETTINGS.maxOutputTokens) {
      return { status: 'MODEL_NOT_AVAILABLE' as const, outputTokenLimit: limit };
    }
    return { status: 'VERIFIED' as const, version: evaluationModelVersion(model.version), outputTokenLimit: limit };
  } catch (error) { return { status: classifyEvaluationApiFailure(error) }; }
}

export async function getEvaluationPilotPreflight({ authenticated, readStorage, readModel }: PreflightDeps) {
  const modelId = getConfiguredWritingModel();
  const apiKeyPresent = isGeminiApiKeyReady();
  const liveEnabled = process.env.RUN_LIVE_GEMINI_EVAL?.trim().toLowerCase() === 'true';
  const datasetApproved = process.env.NOVEL_WRITING_EVAL_APPROVED_DATASET === EVALUATION_DATASET_VERSION;
  const structuredOutputConfigured = Boolean(NOVELFORGE_WRITER_GEMINI_RESPONSE_SCHEMA && LITERARY_QUALITY_GEMINI_RESPONSE_SCHEMA);
  let datasetIntegrity = false;
  try {
    const fixture = buildEvaluationFixture(LIVE_EVALUATION_FIRST_SCENARIO, modelId);
    const baseline = prepareEvaluationArm(fixture, 'BASELINE'), treatment = prepareEvaluationArm(fixture, 'STYLE_AND_VOICE');
    pinCommonQuality(baseline.context, modelId);
    datasetIntegrity = baseline.controlledPrompt === treatment.controlledPrompt && treatment.style.length > 0 && treatment.voice.length > 0;
  } catch { /* Show the failed integrity check without exposing internal data. */ }
  let storage: 'VERIFIED' | 'UNAVAILABLE' | 'NOT_VERIFIED' = 'NOT_VERIFIED';
  let initialCompleted = false;
  if (authenticated && readStorage) {
    try { initialCompleted = await readStorage(); storage = 'VERIFIED'; } catch { storage = 'UNAVAILABLE'; }
  }
  const localChecks = authenticated && apiKeyPresent && liveEnabled && datasetApproved && structuredOutputConfigured && datasetIntegrity && storage === 'VERIFIED';
  const modelMetadata = localChecks ? await verifyEvaluationPilotModel(modelId, readModel) : { status: 'NOT_VERIFIED' as const };
  return {
    status: localChecks && modelMetadata.status === 'VERIFIED' ? 'PASS' as const : 'BLOCKED' as const,
    authenticated, storage, apiKeyPresent, liveEnabled, datasetApproved, structuredOutputConfigured, datasetIntegrity,
    sdkVersion: sdkVersion(), modelId: isRuntimeModel(modelId) ? modelId : 'INVALID_MODEL_ID', modelMetadata,
    modelCapability: 'NOT_VERIFIED' as const, generationCalls: 0, requiredBudget: LIVE_EVALUATION_CALLS,
    datasetVersion: EVALUATION_DATASET_VERSION, targetLength: 550, generationSettings: EVALUATION_MODEL_SETTINGS,
    estimatedCost: 'UNKNOWN' as const, optIn: 'REQUIRED' as const,
    eligibleScenarios: [LIVE_EVALUATION_FIRST_SCENARIO, ...(initialCompleted ? LIVE_EVALUATION_FOLLOW_UP_SCENARIOS : [])],
  };
}
