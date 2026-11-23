import { randomUUID } from 'node:crypto';
import { FinishReason, GenerateContentResponse, type GenerateContentParameters } from '@google/genai';
import { z } from 'zod';
import type { WritingResult } from '../types/aiEngine';
import { EVALUATION_ARMS, EVALUATION_SCENARIOS, REVIEW_DIMENSIONS, type EvaluationCandidate, type EvaluationCase, type EvaluationRating, type EvaluationSettings, type EvaluationTelemetry } from '../types/novelWritingEvaluation';
import { KOREAN_WEB_NOVEL_BENCHMARKS } from '../utils/literaryQualityBenchmark';
import { HARD_CAP_LIVE_EVAL_MAX_CALLS, validateLiveEvalConfig } from '../utils/literaryEvaluationHarness';
import { computeManuscriptContentHash } from '../utils/manuscriptIntegrity';
import { buildEvaluationFixture, EVALUATION_DATASET_VERSION, EVALUATION_OWNER_ID } from '../utils/novelWritingEvaluationBenchmark';
import { assertControlledPrompts, buildEvaluationManifest, calculateEvaluationAdherence, checkEvaluationIntegrity, evaluationFingerprint, isCompleteEvaluationResult, makeEvaluationBlindPair, pinCommonQuality, prepareEvaluationArm, qualityTemplateFingerprint, summarizeWritingEvaluation, type HiddenEvaluationPair } from '../utils/novelWritingEvaluationLogic';
import { buildDynamicWriterSystemInstruction, generateNovelSceneOnServer, getConfiguredWritingModel, getGenAiClient, isGeminiApiKeyReady } from './geminiWritingEngine';
import { evaluateLiteraryQualityOnServer } from './literaryQualityEngine';

export const evaluationOperationId = z.uuid();
const operationId = evaluationOperationId;
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
  operationId, expectedVersion: z.number().int().positive().optional(), reviewOperationId: operationId.optional(),
  finalize: z.boolean().default(true), ratings: z.array(z.strictObject({
    pairId: z.string().regex(/^blind_[a-f0-9]{24}$/), choice, comment: z.string().max(1000).optional(),
    dimensions: reviewDimensions.optional(),
  })).max(48),
});
export const evaluationCancelInput = z.strictObject({ operationId });

export class EvaluationRequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export const evaluationModelSettings = { temperature: 0.7, topP: 0.9, maxOutputTokens: 2048 };
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
    durable: authenticated,
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

export type EvaluationModelCall = (params: GenerateContentParameters) => Promise<GenerateContentResponse>;
export type EvaluationCallKind = 'generation' | 'quality';
export interface EvaluationRunJournal {
  beforeCall: (kind: EvaluationCallKind, callNumber: number) => Promise<void>;
  afterCall: (callNumber: number, outcome: 'SUCCEEDED' | 'UNKNOWN', telemetry: EvaluationTelemetry) => Promise<void>;
  checkpoint: (entry: EvaluationCase, pair: HiddenEvaluationPair | undefined, telemetry: EvaluationTelemetry) => Promise<void>;
}

function createCallLedger(settings: EvaluationSettings, modelId: string, signal: AbortSignal, provider?: EvaluationModelCall, journal?: EvaluationRunJournal) {
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
  let outcomeUnknown = false;
  const report = (): EvaluationTelemetry => ({
    ...ledger, estimatedCostUsd: estimateIncomplete || (live && !pricing) ? null : Number(estimatedCost.toFixed(8)),
    latencyMs: Date.now() - start,
  });
  const generate = async (kind: EvaluationCallKind, params: GenerateContentParameters, mock: () => GenerateContentResponse) => {
    if (signal.aborted || params.config?.abortSignal?.aborted) throw new Error('ABORTED_BY_USER');
    if (!live) return mock();
    if (outcomeUnknown) throw new Error('REMOTE_CALL_OUTCOME_UNKNOWN');
    if (!provider || ledger.actualCalls >= (settings.callBudget ?? 0) || ledger.actualCalls >= ledger.plannedCalls) throw new Error('CALL_BUDGET_EXCEEDED');
    const callNumber = ledger.actualCalls + 1;
    await journal?.beforeCall(kind, callNumber);
    ledger.actualCalls++;
    if (kind === 'generation') ledger.generationCalls++;
    else ledger.qualityCalls++;
    const timeout = new AbortController();
    const callSignal = AbortSignal.any([signal, timeout.signal, ...(params.config?.abortSignal ? [params.config.abortSignal] : [])]);
    const timer = setTimeout(() => timeout.abort(new Error('MODEL_TIMEOUT')), callTimeoutMs);
    let abortCall: (() => void) | undefined;
    let outcome: 'SUCCEEDED' | 'UNKNOWN' = 'UNKNOWN';
    try {
      const stopped = new Promise<never>((_, reject) => {
        abortCall = () => reject(new Error(timeout.signal.aborted ? 'MODEL_TIMEOUT' : 'ABORTED_BY_USER'));
        callSignal.addEventListener('abort', abortCall, { once: true });
        if (callSignal.aborted) abortCall();
      });
      const response = await Promise.race([stopped, Promise.resolve().then(() => {
        if (callSignal.aborted) throw new Error('ABORTED_BY_USER');
        return provider({ ...params, config: {
          ...params.config, ...evaluationModelSettings, abortSignal: callSignal, httpOptions: { timeout: callTimeoutMs, retryOptions: { attempts: 1 } },
        } });
      })]);
      outcome = 'SUCCEEDED';
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
      if (journal) {
        outcomeUnknown = true;
        await journal.afterCall(callNumber, outcome, report());
        outcomeUnknown = outcome === 'UNKNOWN';
      }
    }
  };
  return { generate, report, hasUnknownOutcome: () => outcomeUnknown };
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
  return ['REMOTE_CALL_OUTCOME_UNKNOWN', 'MODEL_TIMEOUT', 'INCOMPLETE_GENERATION', 'INCOMPLETE_QUALITY_OUTPUT', 'WRITER_PROMPT_TRACE_MISMATCH', 'CALL_BUDGET_EXCEEDED', 'RAG_PROVENANCE_FAILURE']
    .find((code) => message.includes(code)) ?? 'MODEL_OR_OUTPUT_FAILURE';
}

export async function runWritingEvaluation(settings: EvaluationSettings, options: {
  authenticated: boolean; signal: AbortSignal; seed: string; provider?: EvaluationModelCall;
  modelId?: string; journal?: EvaluationRunJournal;
}) {
  const { signal, seed, journal } = options;
  assertEvaluationLiveBudget(settings, options.authenticated);
  const modelId = options.modelId ?? getConfiguredWritingModel();
  const isLive = settings.mode === 'LIVE_GEMINI';
  if (isLive && !options.provider && !journal) throw new EvaluationRequestError(403, 'LIVE_REQUIRES_DURABLE_SESSION');
  const provider = isLive ? options.provider ?? ((params) => getGenAiClient().models.generateContent(params)) : undefined;
  const ledger = createCallLedger(settings, modelId, signal, provider, journal);
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
    const quality = pinCommonQuality(base.context, modelId);
    const manifest = buildEvaluationManifest(fixture, base.controlledPrompt, modelId, base.perspective, baseSystem, evaluationModelSettings, quality.fingerprint);

    async function generateArm(arm: typeof base, mockText: string) {
      const candidate: EvaluationCandidate = {
        status: signal.aborted ? 'ABORTED' : 'NOT_STARTED', issues: [], chars: 0, scores: {},
        qualityStatus: 'NOT_EVALUATED', style: [], voice: [],
      };
      let result: WritingResult | undefined;
      if (signal.aborted || ledger.hasUnknownOutcome()) {
        if (ledger.hasUnknownOutcome()) candidate.status = 'REMOTE_CALL_OUTCOME_UNKNOWN';
        return { candidate, result };
      }
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
        if (result.status === 'COMPLETED' && (/STYLE_DNA_META|VOICE_DNA_SOURCES|hiddenSideAssignment|baselineSide|promptVersionAssignment|\b(?:BASELINE|TREATMENT|STYLE_ONLY|VOICE_ONLY|STYLE_AND_VOICE)\b|\[문체 프로필 적용\]|\[비교 조건\]|\[숨겨진 배정\]/i.test(result.manuscript) ||
            [fixture.style, ...fixture.voice].some((profile) => result?.manuscript.includes(profile.currentVersionId)))) {
          candidate.status = 'GENERATION_CONDITION_DISCLOSED';
        }
        if (result.manuscript && candidate.status === 'COMPLETED') {
          Object.assign(candidate, calculateEvaluationAdherence(fixture, result.manuscript, !isLive));
        }
        if (candidate.promptHash && [...arm.style, ...arm.voice].some((profile) => !result?.appliedPromptVersionIds.includes(profile.versionId))) {
          candidate.status = 'PROFILE_TRACE_MISMATCH';
        }
      } catch (error) { candidate.status = safeFailure(error, signal); }
      return { candidate, result };
    }

    async function evaluateCandidate(candidate: EvaluationCandidate, result: WritingResult) {
      if (signal.aborted) return;
      let contextMismatch = false;
      // Both manuscripts use the same evaluator context and prompt template. The generation arm is absent.
      const evaluation = await evaluateLiteraryQualityOnServer({
        ownerId: EVALUATION_OWNER_ID, projectId: base.context.projectId, episodeId: base.context.episodeId,
        context: quality.context, sourceRevisionId: `synthetic_eval_${computeManuscriptContentHash(result.manuscript)}`,
        manuscript: result.manuscript, evaluation: {
          modelId, signal,
          generate: async (request) => {
            contextMismatch = request.model !== modelId || typeof request.contents !== 'string' ||
              typeof request.config?.systemInstruction !== 'string';
            try {
              contextMismatch ||= qualityTemplateFingerprint(quality.context, modelId,
                String(request.config?.systemInstruction), String(request.contents)) !== manifest.qualityCriteriaFingerprint;
            } catch { contextMismatch = true; }
            if (contextMismatch) throw new Error('EVALUATOR_CONTEXT_MISMATCH');
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
            candidate.observedQualityModelVersion = response.modelVersion;
            return response;
          },
        },
      });
      candidate.qualityStatus = evaluation.executionStatus === 'COMPLETED' ? isLive ? 'AI_AUXILIARY' : 'FIXTURE' : 'FAILED';
      if (candidate.qualityStatus === 'FAILED') {
        candidate.qualityFailure = contextMismatch ? 'EVALUATOR_CONTEXT_MISMATCH' : safeFailure(evaluation.errorMessage ? new Error(evaluation.errorMessage) : undefined, signal);
      }
      if (evaluation.executionStatus === 'COMPLETED') {
        candidate.scores = Object.fromEntries(evaluation.report.dimensions.map((item) => [item.category, item.score]));
      }
    }

    for (let repeat = 1; repeat <= settings.repeats; repeat++) {
      const caseId = `${scenarioId}-${repeat}`;
      const a = await generateArm(base, fixture.scene.baseline);
      const initial: EvaluationCase = {
        caseId, scenarioId, repeat, manifest, baseline: a.candidate, baselineText: a.result?.manuscript,
        treatment: { status: 'NOT_STARTED', issues: [], chars: 0, scores: {}, qualityStatus: 'NOT_EVALUATED', style: [], voice: [] },
        comparable: false, exclusionReasons: ['INCOMPLETE_CASE'], lengthDifferencePercent: null,
      };
      if (journal) await journal.checkpoint(initial, undefined, ledger.report());
      const b = await generateArm(treatment, fixture.scene.variant);
      const checkpoint = { ...initial, treatment: b.candidate, treatmentText: b.result?.manuscript };
      if (journal) await journal.checkpoint(checkpoint, undefined, ledger.report());
      let pair: HiddenEvaluationPair | undefined;
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
          if (journal) await journal.checkpoint(checkpoint, undefined, ledger.report());
          await evaluateCandidate(b.candidate, b.result);
          if (signal.aborted) exclusionReasons.push('ABORTED');
          else if ([a.candidate, b.candidate].some((entry) => entry.qualityFailure === 'EVALUATOR_CONTEXT_MISMATCH') ||
              (a.candidate.observedQualityModelVersion && b.candidate.observedQualityModelVersion &&
               a.candidate.observedQualityModelVersion !== b.candidate.observedQualityModelVersion)) exclusionReasons.push('EVALUATOR_CONTEXT_MISMATCH');
          else pair = makeEvaluationBlindPair({
            seed, caseId, scenarioId, title: fixture.title, goal: fixture.scene.goal,
            baseline: a.result.manuscript, treatment: b.result.manuscript, index: cases.length,
          });
        }
      }
      const entry = { ...checkpoint, comparable: !exclusionReasons.length, exclusionReasons, lengthDifferencePercent };
      cases.push(entry);
      if (pair) pairs.push(pair);
      if (journal) await journal.checkpoint(entry, pair, ledger.report());
      if (journal && (signal.aborted || ledger.hasUnknownOutcome())) return result();
    }
  }
  return result();
  function result() {
    return { mode: settings.mode, treatment: settings.treatment, cases, pairs, telemetry: ledger.report(), interrupted: signal.aborted || ledger.hasUnknownOutcome(),
      remoteOutcomeUnknown: ledger.hasUnknownOutcome(), draftState: 'EVALUATION_DRAFT' as const, canonState: 'NOT_CANON' as const, persistence: 'NOT_COMMITTED' as const };
  }
}

export type EvaluationRunReport = Awaited<ReturnType<typeof runWritingEvaluation>>;
type RunReport = EvaluationRunReport;
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
  if (settings.mode === 'LIVE_GEMINI') throw new EvaluationRequestError(403, 'LIVE_REQUIRES_DURABLE_SESSION');
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
  const saved = validateEvaluationRatings(report.pairs, ratings);
  const fingerprint = evaluationFingerprint(saved);
  if (session.final && session.final.fingerprint !== fingerprint) throw new EvaluationRequestError(409, 'EVALUATION_REVIEW_FINALIZED');
  session.final ??= { fingerprint, ratings: saved };
  return revealEvaluationReport(report, session.final.ratings);
}

export function validateEvaluationRatings(pairs: HiddenEvaluationPair[], ratings: EvaluationRating[]) {
  const ids = new Set(ratings.map(({ pairId }) => pairId));
  if (ids.size !== ratings.length || [...ids].some((pairId) => !pairs.some(({ pair }) => pair.pairId === pairId))) {
    throw new EvaluationRequestError(400, 'INVALID_BLIND_RATING');
  }
  return [...ratings].sort((a, b) => a.pairId.localeCompare(b.pairId));
}

export function revealEvaluationReport(report: RunReport, ratings: EvaluationRating[]) {
  const { pairs, ...result } = report;
  return {
    ...result, ratings,
    reveal: pairs.map(({ pair, caseId, assignment }) => ({
      pairId: pair.pairId, caseId, baselineSide: assignment === 'A_ORIGINAL_B_REWRITE' ? 'A' as const : 'B' as const,
    })),
    summary: summarizeWritingEvaluation(report.cases, pairs, ratings),
  };
}
