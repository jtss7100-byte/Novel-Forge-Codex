import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ApiError, FinishReason, GenerateContentResponse } from '@google/genai';
import { EVALUATION_DIMENSIONS, type EvaluationSessionHeader, type EvaluationSettings } from '../types/novelWritingEvaluation';
import { assertEvaluationPilotScope, getEvaluationPilotPreflight, inspectPilotResponse, verifyEvaluationPilotModel } from '../server/novelWritingEvaluationPilot';
import { revealEvaluationReport, runWritingEvaluation, type EvaluationModelCall, type EvaluationRunJournal } from '../server/novelWritingEvaluationRunner';
import { buildEvaluationFixture, EVALUATION_DATASET_VERSION } from './novelWritingEvaluationBenchmark';
import { exportNovelWritingEvaluation } from './novelWritingEvaluationExport';
import { summarizeWritingEvaluation } from './novelWritingEvaluationLogic';

const fixture = buildEvaluationFixture('NW8', 'gemini-3.8-flash');
const settings = (): EvaluationSettings => ({
  operationId: randomUUID(), scenarios: ['NW8'], treatment: 'STYLE_AND_VOICE', mode: 'LIVE_GEMINI', repeats: 1, optIn: true, callBudget: 4,
});
const modelInfo = { supportedActions: ['generateContent'], version: '3.8', outputTokenLimit: 8192 };
const validEnv = { GEMINI_API_KEY: 'fixture-key-do-not-expose', RUN_LIVE_GEMINI_EVAL: 'true',
  NOVEL_WRITING_EVAL_APPROVED_DATASET: EVALUATION_DATASET_VERSION, GEMINI_WRITING_MODEL: 'gemini-3.8-flash' };

async function withEnv<T>(run: () => Promise<T>, overrides: Partial<Record<keyof typeof validEnv, string>> = {}) {
  const saved = Object.fromEntries(Object.keys(validEnv).map((key) => [key, process.env[key]]));
  Object.assign(process.env, validEnv, overrides);
  try { return await run(); }
  finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function response(value: unknown, reason = FinishReason.STOP, version = 'gemini-3.8-flash-v1') {
  const result = new GenerateContentResponse();
  result.candidates = [{ finishReason: reason, content: { parts: [{ text: typeof value === 'string' ? value : JSON.stringify(value) }] } }];
  result.modelVersion = version;
  result.usageMetadata = { promptTokenCount: 80, candidatesTokenCount: 60, thoughtsTokenCount: 20, totalTokenCount: 160 };
  return result;
}
const prose = (manuscript: string) => ({ manuscript_state: 'DRAFT_READY', manuscript, issues: [], proposals: [] });
const scores = { overallAssessment: '테스트 평가', dimensions: EVALUATION_DIMENSIONS.map((category) =>
  ({ category, score: 70, confidence: 'HIGH', explanation: '테스트' })), findings: [] };
const scripted = () => {
  let calls = 0;
  return async () => response(++calls === 1 ? prose(fixture.scene.baseline) : calls === 2 ? prose(fixture.scene.variant) : scores);
};

async function runMock(provider: EvaluationModelCall, options?: { controller?: AbortController; checkpoint?: EvaluationRunJournal['checkpoint'] }) {
  const reservations: number[] = [];
  const outcomes: Parameters<EvaluationRunJournal['afterCall']>[] = [];
  const journal: EvaluationRunJournal = {
    beforeCall: async (_kind, sequence) => { reservations.push(sequence); },
    afterCall: async (...args) => { outcomes.push(args); },
    checkpoint: options?.checkpoint ?? (async () => {}),
  };
  const run = await withEnv(() => runWritingEvaluation(settings(), { authenticated: true, signal: options?.controller?.signal ?? new AbortController().signal,
    modelId: 'gemini-3.8-flash', seed: 'pilot-fixture', provider, journal }));
  return { run, reservations, outcomes };
}

const forbiddenMetadata = async () => assert.fail('metadata should not be sent');
const preflight = (authenticated = true) => getEvaluationPilotPreflight({ authenticated, readStorage: async () => false, readModel: forbiddenMetadata });

test('LP1 missing API key blocks metadata and generation', async () => {
  const result = await withEnv(() => preflight(), { GEMINI_API_KEY: '' });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.apiKeyPresent, false);
  assert.equal(result.modelCapability, 'NOT_VERIFIED');
});

test('LP2 live switch off blocks metadata even with an otherwise configured key', async () => {
  const result = await withEnv(() => preflight(), { RUN_LIVE_GEMINI_EVAL: 'false' });
  assert.equal(result.liveEnabled, false);
  assert.equal(result.modelMetadata.status, 'NOT_VERIFIED');
});

test('LP3 mismatched dataset approval prevents metadata access', async () => {
  const result = await withEnv(() => preflight(), { NOVEL_WRITING_EVAL_APPROVED_DATASET: 'other' });
  assert.equal(result.datasetApproved, false);
  assert.equal(result.datasetIntegrity, true);
  assert.equal(result.generationCalls, 0);
});

test('LP4 unverified Firebase authentication blocks both storage and Gemini', async () => {
  const result = await withEnv(() => getEvaluationPilotPreflight({ authenticated: false, readModel: forbiddenMetadata,
    readStorage: async () => assert.fail('unauthenticated Firestore access') }));
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.storage, 'NOT_VERIFIED');
});

test('LP5 pilot requires exact quota, opt-in, a single scenario, and prior completion for the follow-ups', () => {
  for (const budget of [3, 5]) assert.throws(() => assertEvaluationPilotScope({ ...settings(), callBudget: budget }, false), /PILOT_BUDGET/);
  assert.throws(() => assertEvaluationPilotScope({ ...settings(), optIn: false }, false), /PILOT_OPT_IN/);
  assert.throws(() => assertEvaluationPilotScope({ ...settings(), scenarios: ['NW8', 'NW6'] }, false), /PILOT_SCOPE/);
  for (const scenario of ['NW6', 'NW10'] as const) {
    assert.throws(() => assertEvaluationPilotScope({ ...settings(), scenarios: [scenario] }, false), /PILOT_NW8_REQUIRED/);
    assert.doesNotThrow(() => assertEvaluationPilotScope({ ...settings(), scenarios: [scenario] }, true));
  }
  assert.doesNotThrow(() => assertEvaluationPilotScope(settings(), false));
});

test('LP6 mock Gemini validates two Writer outputs and two Q1–Q8 responses within four calls', async () => {
  const { run, reservations } = await runMock(scripted());
  assert.deepEqual(reservations, [1, 2, 3, 4]);
  assert.equal(run.telemetry.transport, 'TEST_TRANSPORT');
  assert.equal(run.telemetry.dispatchedCalls, 4);
  assert.equal(run.telemetry.measuredTokens, 640);
  assert.equal(run.pairs.length, 1);
  assert.equal(run.cases[0].baseline.writerResponse?.code, 'SUCCESS');
  assert.equal(run.cases[0].treatment.qualityResponse?.schema, 'VALID');
  assert.equal(Object.keys(run.cases[0].treatment.scores).length, 8);
});

test('LP7 invalid JSON is classified without returning its contents', async () => {
  const { run } = await runMock(async () => response('{"secret fragment"'));
  assert.equal(run.cases[0].baseline.writerResponse?.code, 'INVALID_JSON');
  assert.equal(run.pairs.length, 0);
  assert.ok(!JSON.stringify(run).includes('secret fragment'));
});

test('LP8 parsed JSON with a Writer schema violation cannot become a manuscript', () => {
  const trace = inspectPilotResponse(response({ ...prose(fixture.scene.baseline), extra: true }), 'generation');
  assert.equal(trace.json, 'VALID');
  assert.equal(trace.schema, 'INVALID');
  assert.equal(trace.code, 'SCHEMA_VALIDATION_FAILED');
  const blocked = inspectPilotResponse(response({ ...prose(''), manuscript_state: 'BLOCKED_CONFLICT' }), 'generation');
  assert.equal(blocked.code, 'BLOCKED_BY_CANON');
});

test('LP9 MAX_TOKENS stays truncated even if the body parses, while measured usage survives', async () => {
  const { run } = await runMock(async () => response(prose(fixture.scene.baseline), FinishReason.MAX_TOKENS));
  assert.equal(run.cases[0].baseline.status, 'OUTPUT_TRUNCATED');
  assert.equal(run.cases[0].baseline.writerResponse?.usage?.thinking, 20);
  assert.equal(run.telemetry.qualityCalls, 0);
});

test('LP10 model unavailable and upstream auth errors are typed, terminal and have no fallback', async () => {
  for (const [status, code] of [[404, 'MODEL_NOT_AVAILABLE'], [403, 'API_AUTH_FAILED']] as const) {
    const { run, reservations, outcomes } = await runMock(async () => { throw new ApiError({ status, message: 'private-error-body' }); });
    assert.deepEqual(reservations, [1]);
    assert.equal(outcomes[0][1], 'REJECTED');
    assert.equal(run.cases[0].baseline.status, code);
    assert.equal(run.remoteOutcomeUnknown, false);
    assert.ok(!JSON.stringify(run).includes('private-error-body'));
  }
});

test('LP11 rate limits consume one attempt with no automatic retry', async () => {
  const { run, reservations } = await runMock(async () => { throw new ApiError({ status: 429, message: 'RESOURCE_EXHAUSTED' }); });
  assert.equal(run.cases[0].baseline.status, 'RATE_LIMITED');
  assert.deepEqual(reservations, [1]);
});

test('LP12 Time-out is distinct from the durable unknown outcome and stops further dispatch', async () => {
  const { run, reservations, outcomes } = await runMock(async () => { throw new Error('DEADLINE_EXCEEDED'); });
  assert.equal(run.cases[0].baseline.status, 'TIMEOUT');
  assert.equal(outcomes[0][1], 'UNKNOWN');
  assert.equal(run.remoteOutcomeUnknown, true);
  assert.deepEqual(reservations, [1]);
});

test('LP13 different observed versions cannot enter comparison', async () => {
  let index = 0;
  const { run } = await runMock(async () => response(prose(++index === 1 ? fixture.scene.baseline : fixture.scene.variant), FinishReason.STOP, `gemini-v${index}`));
  assert.ok(run.cases[0].exclusionReasons.includes('MODEL_VERSION_MISMATCH'));
  assert.equal(run.pairs.length, 0);
  assert.equal(run.telemetry.qualityCalls, 0);
});

test('LP14 cancellation before the second dispatch preserves the first completed manuscript', async () => {
  const controller = new AbortController();
  const { run, reservations } = await runMock(scripted(), { controller, checkpoint: async () => { controller.abort(); } });
  assert.equal(run.cases[0].baselineText, fixture.scene.baseline);
  assert.equal(run.cases[0].treatment.status, 'ABORTED');
  assert.equal(run.interrupted, true);
  assert.deepEqual(reservations, [1]);
});

test('LP16 an incomplete quality response is excluded without manufacturing Q scores', async () => {
  let calls = 0;
  const { run } = await runMock(async () => response(++calls === 1 ? prose(fixture.scene.baseline) : calls === 2 ? prose(fixture.scene.variant) :
    calls === 3 ? scores : { ...scores, dimensions: scores.dimensions.slice(1) }));
  assert.equal(run.cases[0].treatment.qualityFailure, 'SCHEMA_VALIDATION_FAILED');
  assert.deepEqual(run.cases[0].treatment.scores, {});
  assert.ok(summarizeWritingEvaluation(run.cases, run.pairs, []).deltas.every((row) => row.samples === 0));
});

test('LP17 blind pair projection omits response traces, applied profiles and answer keys', async () => {
  const { run } = await runMock(scripted());
  const { pair } = run.pairs[0];
  assert.deepEqual(Object.keys(pair).sort(), ['goal', 'optionA', 'optionB', 'pairId', 'scenarioId', 'title']);
  assert.doesNotMatch(JSON.stringify(pair), /observedModel|promptHash|baselineSide|STYLE_AND_VOICE/);
});

test('LP19 disabled CI mode cannot call Gemini, and passing mocked metadata never verifies actual structured output', async () => {
  const setup = { ...settings(), mode: 'DRY_RUN_FIXTURE' as const, optIn: false };
  const run = await withEnv(() => runWritingEvaluation(setup, { authenticated: false, signal: new AbortController().signal, seed: 'ci',
    provider: async () => assert.fail('fixture called the model') }), { RUN_LIVE_GEMINI_EVAL: 'false' });
  assert.equal(run.telemetry.dispatchedCalls, 0);
  const good = await withEnv(() => getEvaluationPilotPreflight({ authenticated: true, readStorage: async () => false, readModel: async () => modelInfo }));
  assert.equal(good.status, 'PASS');
  assert.equal(good.modelCapability, 'NOT_VERIFIED');
  assert.equal(good.generationCalls, 0);
  assert.equal(good.estimatedCost, 'UNKNOWN');
  assert.ok(!JSON.stringify(good).includes(validEnv.GEMINI_API_KEY));
  assert.equal((await verifyEvaluationPilotModel('gemini-3.8-flash', async () => ({ ...modelInfo, outputTokenLimit: 20 }))).status, 'MODEL_NOT_AVAILABLE');
});

test('shared Markdown excludes free text and secret-shaped metadata', async () => {
  const { run } = await runMock(scripted());
  const privateText = 'private bearer token and unpublished manuscript';
  const entry = run.cases[0];
  entry.baselineText = privateText;
  entry.baseline.observedModelVersion = 'AIza0123456789abcdefghijklmnopq';
  const report = revealEvaluationReport(run, [{ pairId: run.pairs[0].pair.pairId, choice: 'TIE', comment: privateText }]);
  const session: EvaluationSessionHeader = { ...settings(), status: 'FINALIZED', version: 4, datasetVersion: EVALUATION_DATASET_VERSION,
    modelId: 'gemini-3.8-flash', createdAt: '2026-11-24T00:00:00.000Z', updatedAt: '2026-11-24T00:00:00.000Z', humanRatingStatus: 'RATED' };
  const markdown = exportNovelWritingEvaluation(report, session);
  assert.ok(markdown.includes(session.operationId));
  assert.ok(markdown.includes('통계적 유의성 NOT_ESTABLISHED'));
  assert.ok(!markdown.includes(privateText) && !markdown.includes('AIza') && !markdown.includes(run.pairs[0].pair.optionA));
});
