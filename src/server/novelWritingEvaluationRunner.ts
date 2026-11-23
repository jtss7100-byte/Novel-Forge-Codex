import { randomUUID } from 'node:crypto';
import { FinishReason, GenerateContentResponse, type GenerateContentParameters } from '@google/genai';
import { z } from 'zod';
import type { WritingResult } from '../types/aiEngine';
import { EVALUATION_ARMS, EVALUATION_SCENARIOS, REVIEW_DIMENSIONS, type EvaluationCandidate, type EvaluationCase, type EvaluationRating, type EvaluationSettings, type EvaluationTelemetry } from '../types/novelWritingEvaluation';
import { buildLiteraryQualityEvaluationPrompt } from '../utils/literaryQualityLogic';
import { KOREAN_WEB_NOVEL_BENCHMARKS } from '../utils/literaryQualityBenchmark';
import { HARD_CAP_LIVE_EVAL_MAX_CALLS, validateLiveEvalConfig } from '../utils/literaryEvaluationHarness';
import { computeManuscriptContentHash } from '../utils/manuscriptIntegrity';
import { buildEvaluationFixture, EVALUATION_DATASET_VERSION, EVALUATION_OWNER_ID } from '../utils/novelWritingEvaluationBenchmark';
import { assertControlledPrompts, buildEvaluationManifest, checkEvaluationIntegrity, evaluationFingerprint, isCompleteEvaluationResult, makeEvaluationBlindPair, prepareEvaluationArm, summarizeWritingEvaluation, type HiddenEvaluationPair } from '../utils/novelWritingEvaluationLogic';
import { buildDynamicWriterSystemInstruction, generateNovelSceneOnServer, getConfiguredWritingModel, getGenAiClient, isGeminiApiKeyReady } from './geminiWritingEngine';
import { evaluateLiteraryQualityOnServer } from './literaryQualityEngine';

const operationId = z.uuid();
const choice = z.enum(['A', 'B', 'TIE', 'DEFER']);
export const evaluationRunInput = z.strictObject({
  operationId, scenarios: z.array(z.enum(EVALUATION_SCENARIOS.map(([id]) => id))).min(1).max(12)
    .refine((ids) => ids.length === new Set(ids).size),
  treatment: z.enum(EVALUATION_ARMS.filter((arm) => arm !== 'BASELINE')),
  repeats: z.number().int().min(1).max(4), mode: z.enum(['DRY_RUN_FIXTURE', 'LIVE_GEMINI']),
  optIn: z.boolean(), callBudget: z.number().int().min(1).max(HARD_CAP_LIVE_EVAL_MAX_CALLS).optional(),
});
const reviewDimensions = z.partialRecord(z.enum(REVIEW_DIMENSIONS.map(([id]) => id)), choice);
export const evaluationReviewInput = z.strictObject({
  operationId, ratings: z.array(z.strictObject({
    pairId: z.string().regex(/^blind_[a-f0-9]{24}$/), choice, comment: z.string().max(1000).optional(),
    dimensions: reviewDimensions.optional(),
  })).max(48),
});
export const evaluationCancelInput = z.strictObject({ operationId });

export class EvaluationRequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

const modelSettings = { temperature: 0.7, topP: 0.9, maxOutputTokens: 2048 };
const callTimeoutMs = 45_000;
const sessionTtlMs = 60 * 60 * 1000;
const maxSessions = 48;

export const plannedEvaluationCalls = (size: number, repeats: number) => size * repeats * 4;

function readPricing(modelId: string) {
  const raw = process.env.NOVEL_WRITING_EVAL_PRICING;
  if (!raw) return undefined;
  try {
    const pricing = z.strictObject({
      modelId: z.string(), inputUsdPerMillion: z.number().positive(), outputUsdPerMillion: z.number().positive(),
      reference: z.url({ protocol: /^https$/ }),
    }).parse(JSON.parse(raw));
    return pricing.modelId === modelId ? pricing : undefined;
  } catch { return undefined; }
}

export function getEvaluationSettings(authenticated: boolean) {
  const modelId = getConfiguredWritingModel();
  const flag = validateLiveEvalConfig({ runLiveFlag: process.env.RUN_LIVE_GEMINI_EVAL, geminiApiKey: process.env.GEMINI_API_KEY });
  const datasetApproved = process.env.NOVEL_WRITING_EVAL_APPROVED_DATASET === EVALUATION_DATASET_VERSION;
  return {
    modelId, datasetVersion: EVALUATION_DATASET_VERSION,
    liveAvailable: authenticated && flag.enabled && datasetApproved && isGeminiApiKeyReady(),
    maxCalls: HARD_CAP_LIVE_EVAL_MAX_CALLS,
    maxRepeats: 4,
  };
}

export function assertEvaluationLiveBudget(settings: EvaluationSettings, authenticated: boolean) {
  if (settings.mode !== 'LIVE_GEMINI') return;
  if (!getEvaluationSettings(authenticated).liveAvailable || !settings.optIn || settings.callBudget === undefined) {
    throw new EvaluationRequestError(403, 'LIVE_DISABLED_OR_APPROVAL_REQUIRED');
  }
  const validated = validateLiveEvalConfig({
    runLiveFlag: process.env.RUN_LIVE_GEMINI_EVAL, geminiApiKey: process.env.GEMINI_API_KEY, maxCalls: settings.callBudget,
  });
  if (plannedEvaluationCalls(settings.scenarios.length, settings.repeats) > validated.maxCalls) {
    throw new EvaluationRequestError(400, 'CALL_BUDGET_EXCEEDED');
  }
}

type ModelCall = (params: GenerateContentParameters) => Promise<GenerateContentResponse>;
type CallKind = 'generation' | 'quality';

function createCallLedger(settings: EvaluationSettings, modelId: string, signal: AbortSignal, provider?: ModelCall) {
  const start = Date.now();
  const live = settings.mode === 'LIVE_GEMINI';
  const pricing = readPricing(modelId);
  const ledger: EvaluationTelemetry = {
    plannedCalls: live ? plannedEvaluationCalls(settings.scenarios.length, settings.repeats) : 0,
    actualCalls: 0, generationCalls: 0, qualityCalls: 0, measuredTokens: 0, callsWithoutUsage: 0,
    estimatedCostUsd: live && !pricing ? null : 0, latencyMs: 0, pricingReference: live ? pricing?.reference : undefined,
  };
  let estimateIncomplete = false;
  let estimatedCost = 0;
  const generate = async (kind: CallKind, params: GenerateContentParameters, mock: () => GenerateContentResponse) => {
    if (signal.aborted || params.config?.abortSignal?.aborted) throw new Error('ABORTED_BY_USER');
    if (!live) return mock();
    if (!provider || ledger.actualCalls >= (settings.callBudget ?? 0) || ledger.actualCalls >= ledger.plannedCalls) throw new Error('CALL_BUDGET_EXCEEDED');
    ledger.actualCalls++;
    if (kind === 'generation') ledger.generationCalls++;
    else ledger.qualityCalls++;
    const timeout = new AbortController();
    const callSignal = AbortSignal.any([signal, timeout.signal, ...(params.config?.abortSignal ? [params.config.abortSignal] : [])]);
    const timer = setTimeout(() => timeout.abort(new Error('MODEL_TIMEOUT')), callTimeoutMs);
    let abortCall: (() => void) | undefined;
    try {
      const stopped = new Promise<never>((_, reject) => {
        abortCall = () => reject(new Error(timeout.signal.aborted ? 'MODEL_TIMEOUT' : 'ABORTED_BY_USER'));
        callSignal.addEventListener('abort', abortCall, { once: true });
        if (callSignal.aborted) abortCall();
      });
      const response = await Promise.race([stopped, provider({ ...params, config: {
        ...params.config, ...modelSettings, abortSignal: callSignal, httpOptions: { timeout: callTimeoutMs, retryOptions: { attempts: 1 } },
      } })]);
      const usage = response.usageMetadata;
      if (typeof usage?.totalTokenCount === 'number' && usage.totalTokenCount > 0) ledger.measuredTokens += usage.totalTokenCount;
      else ledger.callsWithoutUsage++;
      if (pricing && typeof usage?.promptTokenCount === 'number' && typeof usage.candidatesTokenCount === 'number' && !usage.cachedContentTokenCount && !usage.toolUsePromptTokenCount) {
        estimatedCost += (usage.promptTokenCount * pricing.inputUsdPerMillion +
          (usage.candidatesTokenCount + (usage.thoughtsTokenCount ?? 0)) * pricing.outputUsdPerMillion) / 1_000_000;
      } else estimateIncomplete = true;
      return response;
    } catch (error) {
      ledger.callsWithoutUsage++;
      estimateIncomplete = true;
      throw error;
    } finally {
      clearTimeout(timer);
      if (abortCall) callSignal.removeEventListener('abort', abortCall);
    }
  };
  const report = (): EvaluationTelemetry => ({
    ...ledger, estimatedCostUsd: estimateIncomplete || (live && !pricing) ? null : Number(estimatedCost.toFixed(8)),
    latencyMs: Date.now() - start,
  });
  return { generate, report };
}

function mockResponse(value: unknown) {
  const response = new GenerateContentResponse();
  response.candidates = [{ content: { parts: [{ text: JSON.stringify(value) }] }, finishReason: FinishReason.STOP }];
  return response;
}

function safeFailure(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return 'ABORTED';
  const message = error instanceof Error ? error.message : '';
  if (message.includes('이미 진행 중')) return 'WRITER_LOCKED';
  return ['MODEL_TIMEOUT', 'INCOMPLETE_GENERATION', 'WRITER_PROMPT_TRACE_MISMATCH', 'CALL_BUDGET_EXCEEDED', 'RAG_PROVENANCE_FAILURE']
    .find((code) => message.includes(code)) ?? 'MODEL_OR_OUTPUT_FAILURE';
}

export async function runWritingEvaluation(settings: EvaluationSettings, options: {
  authenticated: boolean; signal: AbortSignal; seed: string; provider?: ModelCall;
}) {
  const { signal, seed } = options;
  assertEvaluationLiveBudget(settings, options.authenticated);
  const modelId = getConfiguredWritingModel();
  const isLive = settings.mode === 'LIVE_GEMINI';
  const provider = isLive ? options.provider ?? ((params) => getGenAiClient().models.generateContent(params)) : undefined;
  const ledger = createCallLedger(settings, modelId, signal, provider);
  const cases: EvaluationCase[] = [];
  const pairs: HiddenEvaluationPair[] = [];
  const seenOutputs = new Set<string>();
  for (const scenarioId of settings.scenarios) {
    const fixture = buildEvaluationFixture(scenarioId, modelId);
    const base = prepareEvaluationArm(fixture, 'BASELINE');
    const treatment = prepareEvaluationArm(fixture, settings.treatment);
    const baseSystem = buildDynamicWriterSystemInstruction(base.context);
    const treatmentSystem = buildDynamicWriterSystemInstruction(treatment.context);
    assertControlledPrompts(base.controlledPrompt, treatment.controlledPrompt, baseSystem, treatmentSystem);
    const qualityContext = settings.treatment === 'STYLE_AND_VOICE' ? treatment.context : prepareEvaluationArm(fixture, 'STYLE_AND_VOICE').context;
    const quality = buildLiteraryQualityEvaluationPrompt({
      ownerId: EVALUATION_OWNER_ID, context: qualityContext, manuscript: '[평가 후보 원고]',
    });
    const manifest = buildEvaluationManifest(fixture, base.controlledPrompt, modelId, base.perspective, baseSystem, modelSettings,
      [quality.systemInstruction, quality.promptContent]);

    async function generateArm(arm: typeof base, mockText: string) {
      const candidate: EvaluationCandidate = {
        status: signal.aborted ? 'ABORTED' : 'NOT_STARTED', issues: [], chars: 0, scores: {},
        qualityStatus: 'NOT_EVALUATED', style: [], voice: [],
      };
      let result: WritingResult | undefined;
      if (signal.aborted) return { candidate, result };
      try {
        result = await generateNovelSceneOnServer({
          ownerId: EVALUATION_OWNER_ID, context: arm.context, plan: fixture.plan, targetSceneNumber: 1,
          evaluation: {
            modelId, signal,
            generate: async (request) => {
              if (request.contents !== arm.prompt || request.model !== modelId ||
                  request.config?.systemInstruction !== baseSystem) throw new Error('WRITER_PROMPT_TRACE_MISMATCH');
              candidate.promptHash = computeManuscriptContentHash(arm.prompt);
              candidate.style = arm.style;
              candidate.voice = arm.voice;
              const response = await ledger.generate('generation', request, () => mockResponse({ manuscript_state: 'DRAFT_READY', manuscript: mockText, issues: [], proposals: [] }));
              candidate.observedModelVersion = response.modelVersion;
              return response;
            },
          },
        });
        candidate.status = isCompleteEvaluationResult(result) ? 'COMPLETED' : (result.status === 'COMPLETED' ? 'INCOMPLETE' : result.executionState.startsWith('BLOCKED') ? result.executionState : result.status);
        candidate.chars = result.manuscript.length;
        candidate.issues = checkEvaluationIntegrity(fixture, result);
        if (result.status === 'COMPLETED' && /STYLE_DNA_META|VOICE_DNA_SOURCES|\[문체 프로필 적용\]|\[비교 조건\]/i.test(result.manuscript)) {
          candidate.status = 'GENERATION_CONDITION_DISCLOSED';
        }
        if (candidate.promptHash && [...arm.style, ...arm.voice].some((profile) => !result?.appliedPromptVersionIds.includes(profile.versionId))) {
          candidate.status = 'PROFILE_TRACE_MISMATCH';
        }
      } catch (error) { candidate.status = safeFailure(error, signal); }
      return { candidate, result };
    }

    async function evaluateCandidate(candidate: EvaluationCandidate, result: WritingResult) {
      if (signal.aborted) return;
      // Both manuscripts use the same evaluator context and prompt template. The generation arm is absent.
      const evaluation = await evaluateLiteraryQualityOnServer({
        ownerId: EVALUATION_OWNER_ID, projectId: base.context.projectId, episodeId: base.context.episodeId,
        context: qualityContext, sourceRevisionId: `synthetic_eval_${computeManuscriptContentHash(result.manuscript)}`,
        manuscript: result.manuscript, evaluation: {
          modelId, signal,
          generate: async (request) => {
            const response = await ledger.generate('quality', request, () => {
              const index = (Number(scenarioId.slice(2)) - 1) % KOREAN_WEB_NOVEL_BENCHMARKS.length;
              const { dimensions } = KOREAN_WEB_NOVEL_BENCHMARKS[index].mockReferenceAiOutput;
              return mockResponse({
                overallAssessment: 'Q1~Q8 처리 경로 검증용 고정 응답',
                dimensions: dimensions.map((item) => ({ ...item, explanation: 'DRY_RUN_FIXTURE' })),
                findings: [],
              });
            });
            if (response.candidates?.some((candidate) => candidate.finishReason && candidate.finishReason !== FinishReason.STOP)) {
              throw new Error('INCOMPLETE_QUALITY_OUTPUT');
            }
            return response;
          },
        },
      });
      candidate.qualityStatus = evaluation.executionStatus === 'COMPLETED' ? isLive ? 'AI_AUXILIARY' : 'FIXTURE' : 'FAILED';
      if (evaluation.executionStatus === 'COMPLETED') {
        candidate.scores = Object.fromEntries(evaluation.report.dimensions.map((item) => [item.category, item.score]));
      }
    }

    for (let repeat = 1; repeat <= settings.repeats; repeat++) {
      const caseId = `${scenarioId}-${repeat}`;
      const a = await generateArm(base, fixture.scene.baseline);
      const b = await generateArm(treatment, fixture.scene.variant);
      const exclusionReasons = [a, b].flatMap(({ candidate }, index) => [
        ...(candidate.status === 'COMPLETED' ? [] : [`${index === 0 ? 'BASELINE' : 'TREATMENT'}:${candidate.status}`]),
        ...candidate.issues.map((issue) => `${index === 0 ? 'BASELINE' : 'TREATMENT'}:${issue}`),
      ]);
      const lengthDifferencePercent = a.candidate.chars && b.candidate.chars
        ? Math.abs(b.candidate.chars - a.candidate.chars) * 100 / Math.max(a.candidate.chars, b.candidate.chars) : null;
      if (a.candidate.observedModelVersion && b.candidate.observedModelVersion &&
          a.candidate.observedModelVersion !== b.candidate.observedModelVersion) exclusionReasons.push('MODEL_VERSION_MISMATCH');
      if (a.result && b.result && !exclusionReasons.length) {
        const outputKey = evaluationFingerprint([scenarioId, [a.result.manuscript, b.result.manuscript].sort()]);
        if (a.result.manuscript === b.result.manuscript || seenOutputs.has(outputKey)) {
          exclusionReasons.push('REPEATED_OUTPUT');
        } else {
          seenOutputs.add(outputKey);
          await evaluateCandidate(a.candidate, a.result);
          await evaluateCandidate(b.candidate, b.result);
          if (signal.aborted) exclusionReasons.push('ABORTED');
          else pairs.push(makeEvaluationBlindPair({
            seed, caseId, scenarioId, title: fixture.title, goal: fixture.scene.goal,
            baseline: a.result.manuscript, treatment: b.result.manuscript, index: cases.length,
          }));
        }
      }
      cases.push({ caseId, scenarioId, repeat, manifest, baseline: a.candidate, treatment: b.candidate,
        comparable: !exclusionReasons.length, exclusionReasons, lengthDifferencePercent });
    }
  }
  return { mode: settings.mode, treatment: settings.treatment, cases, pairs, telemetry: ledger.report(), interrupted: signal.aborted,
    draftState: 'EVALUATION_DRAFT' as const, canonState: 'NOT_CANON' as const, persistence: 'NOT_COMMITTED' as const };
}

type RunReport = Awaited<ReturnType<typeof runWritingEvaluation>>;
interface EvaluationSession {
  ownerId: string;
  fingerprint: string;
  expiresAt: number;
  controller: AbortController;
  pending?: Promise<RunReport>;
  report?: RunReport;
  final?: { fingerprint: string; ratings: EvaluationRating[] };
}
const sessions = new Map<string, EvaluationSession>();

function findSession(ownerId: string, id: string) {
  const session = sessions.get(id);
  if (!session || session.ownerId !== ownerId || session.expiresAt <= Date.now()) throw new EvaluationRequestError(404, 'EVALUATION_SESSION_NOT_FOUND');
  return session;
}

export async function startEvaluationSession(ownerId: string, authenticated: boolean, settings: EvaluationSettings) {
  const now = Date.now();
  for (const [id, session] of sessions) if (!session.pending && session.expiresAt < now) sessions.delete(id);
  const fingerprint = evaluationFingerprint(settings);
  let session = sessions.get(settings.operationId);
  if (session) {
    session = findSession(ownerId, settings.operationId);
    if (session.fingerprint !== fingerprint || session.final) throw new EvaluationRequestError(409, 'EVALUATION_OPERATION_CONFLICT');
  } else {
    assertEvaluationLiveBudget(settings, authenticated);
    if (sessions.size >= maxSessions || [...sessions.values()].some((entry) => entry.ownerId === ownerId && entry.pending)) {
      throw new EvaluationRequestError(409, 'EVALUATION_BUSY');
    }
    const controller = new AbortController();
    session = { ownerId, controller, fingerprint, expiresAt: now + sessionTtlMs };
    sessions.set(settings.operationId, session);
    const entry = session;
    session.pending = runWritingEvaluation(settings, { authenticated, signal: controller.signal, seed: randomUUID() })
      .then((report) => { entry.report = report; return report; })
      .finally(() => { entry.pending = undefined; entry.expiresAt = Date.now() + sessionTtlMs; });
  }
  const report = session.report ?? await session.pending;
  if (!report) throw new EvaluationRequestError(409, 'EVALUATION_OPERATION_CONFLICT');
  return { operationId: settings.operationId, pairs: report.pairs.map(({ pair }) => pair), total: report.cases.length,
    excluded: report.cases.length - report.pairs.length, interrupted: report.interrupted };
}

export function cancelEvaluationSession(ownerId: string, id: string) {
  const session = findSession(ownerId, id);
  if (session.pending) session.controller.abort();
  return { stopping: Boolean(session.pending) };
}

export function finalizeEvaluationSession(ownerId: string, id: string, ratings: EvaluationRating[]) {
  const session = findSession(ownerId, id);
  const report = session.report;
  if (!report) throw new EvaluationRequestError(409, 'EVALUATION_NOT_READY');
  const ids = new Set(ratings.map(({ pairId }) => pairId));
  if (ids.size !== ratings.length || [...ids].some((pairId) => !report.pairs.some(({ pair }) => pair.pairId === pairId))) {
    throw new EvaluationRequestError(400, 'INVALID_BLIND_RATING');
  }
  const saved = [...ratings].sort((a, b) => a.pairId.localeCompare(b.pairId));
  const fingerprint = evaluationFingerprint(saved);
  if (session.final && session.final.fingerprint !== fingerprint) throw new EvaluationRequestError(409, 'EVALUATION_REVIEW_FINALIZED');
  session.final ??= { fingerprint, ratings: saved };
  const { pairs, ...result } = report;
  return {
    ...result, ratings: session.final.ratings,
    reveal: pairs.map(({ pair, caseId, assignment }) => ({
      pairId: pair.pairId, caseId, baselineSide: assignment === 'A_ORIGINAL_B_REWRITE' ? 'A' as const : 'B' as const,
    })),
    summary: summarizeWritingEvaluation(report.cases, pairs, session.final.ratings),
  };
}
