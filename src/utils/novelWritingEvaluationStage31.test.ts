import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FinishReason, GenerateContentResponse } from '@google/genai';
import { canTransitionEvaluation, recoverEvaluationExecution, resolveEvaluationReviewVersion } from '../server/novelWritingEvaluationSessions';
import { runWritingEvaluation, startEvaluationSession } from '../server/novelWritingEvaluationRunner';
import type { EvaluationSettings } from '../types/novelWritingEvaluation';
import { buildEvaluationFixture, EVALUATION_DATASET_VERSION } from './novelWritingEvaluationBenchmark';
import { buildLiteraryQualityEvaluationPrompt } from './literaryQualityLogic';
import { calculateEvaluationAdherence, pinCommonQuality, prepareEvaluationArm, qualityTemplateFingerprint, summarizeWritingEvaluation } from './novelWritingEvaluationLogic';

const model = 'test-writer';
const fixture = buildEvaluationFixture('NW8', model);
const settings = (overrides: Partial<EvaluationSettings> = {}): EvaluationSettings => ({
  operationId: randomUUID(), scenarios: ['NW8'], treatment: 'STYLE_AND_VOICE', repeats: 1, mode: 'DRY_RUN_FIXTURE', optIn: false, ...overrides,
});

test('EV1: common Q1–Q8 retains controls and RAG without the experimental Style or Voice DNA', () => {
  const full = prepareEvaluationArm(fixture, 'STYLE_AND_VOICE');
  const common = pinCommonQuality(full.context, model);
  const prompt = buildLiteraryQualityEvaluationPrompt({ ownerId: fixture.plan.ownerId, context: common.context, manuscript: fixture.scene.baseline });
  for (const record of [fixture.style, ...fixture.voice]) {
    assert.ok(!prompt.promptContent.includes(record.currentVersionId));
    assert.ok(!prompt.promptContent.includes(record.title));
  }
  assert.match(prompt.promptContent, /Master Writing Rules/);
  assert.ok(prompt.promptContent.includes(fixture.source.chunk.content));
  assert.ok(prompt.promptContent.includes(fixture.source.chunk.sourceRevisionId));
  assert.ok(prompt.promptContent.includes(fixture.scene.goal));
  assert.ok(prompt.promptContent.includes('등장인물 대사 및 존비칭'));
  assert.equal(prompt.appliedPerspective, 'THIRD_LIMITED');
});

test('EV2: evaluator fingerprints ignore prose and length while binding model, system instructions, rubric, and RAG', () => {
  const { context, fingerprint } = pinCommonQuality(fixture.context, model);
  for (const manuscript of [fixture.scene.baseline, fixture.scene.variant]) {
    const prompt = buildLiteraryQualityEvaluationPrompt({ ownerId: fixture.plan.ownerId, context, manuscript });
    const { systemInstruction, promptContent } = prompt;
    assert.equal(qualityTemplateFingerprint(context, model, systemInstruction, promptContent), fingerprint);
    assert.notEqual(qualityTemplateFingerprint(context, 'another-model', systemInstruction, promptContent), fingerprint);
    assert.notEqual(qualityTemplateFingerprint(context, model, systemInstruction + ' changed', promptContent), fingerprint);
    assert.notEqual(qualityTemplateFingerprint(context, model, systemInstruction, promptContent.replace('Q3', 'X3')), fingerprint);
    assert.notEqual(qualityTemplateFingerprint({ ...context, retrievedMemoryChunks: [] }, model, systemInstruction, promptContent), fingerprint);
    assert.throws(() => qualityTemplateFingerprint(context, model, systemInstruction, promptContent.replace('manuscript_to_evaluate', 'bad')), /EVALUATOR_CONTEXT_MISMATCH/);
  }
});

test('EV3: author style adherence uses the same approved targets and separate score for both arms', async () => {
  const run = await runWritingEvaluation(settings(), { authenticated: false, signal: new AbortController().signal, seed: 'ev3' });
  const [entry] = run.cases;
  assert.equal(entry.baseline.authorStyleAdherence?.status, 'FIXTURE');
  assert.deepEqual(entry.baseline.authorStyleAdherence?.targets, entry.treatment.authorStyleAdherence?.targets);
  assert.equal(entry.baseline.authorStyleAdherence?.targets[0].versionId, fixture.style.currentVersionId);
  assert.equal(Object.keys(entry.baseline.scores).length, 8);
  const summary = summarizeWritingEvaluation(run.cases, run.pairs, []);
  assert.equal(summary.authorStyle.samples, 1);
  assert.equal(summary.human.status, 'NOT_RATED');
  assert.ok(summary.deltas.every((value) => value.mean === 0));
  const partialReview = summarizeWritingEvaluation(run.cases, run.pairs, [{
    pairId: run.pairs[0].pair.pairId, choice: 'DEFER', dimensions: { naturalness: 'A' },
  }]);
  assert.equal(partialReview.human.status, 'RATED');
  assert.equal(partialReview.human.dimensionRatedCount, 1);
  assert.equal(partialReview.human.rewriteWinRateExcludingTiesPercent, null);
});

test('EV4: voice adherence scores attributed lines by the in-scene character and leaves weak evidence unscored', () => {
  const prose = '“대장님, 먼저 가겠습니다.” 카엘이 말했다.\n“북문을 살피겠습니다.” 카엘이 말했다.\n“쇠종의 그림자 같군.” 가렌이 말했다.';
  const score = calculateEvaluationAdherence(fixture, prose, false).characterVoiceAdherence;
  assert.deepEqual(score.targets.map((item) => item.targetCharacterId), ['kael', 'sera']);
  assert.equal(score.evidence.find((entry) => entry.characterId === 'kael')?.observed, 2);
  assert.equal(score.score, 100);
  assert.equal(calculateEvaluationAdherence(fixture, '카엘이 문턱을 살폈다.', false).characterVoiceAdherence.score, null);
});

test('EV5: experimental assignments and arm identifiers do not occur in common quality prompts', () => {
  const common = pinCommonQuality(fixture.context, model);
  const prompt = buildLiteraryQualityEvaluationPrompt({ ownerId: fixture.plan.ownerId, context: common.context, manuscript: '장면 본문' });
  assert.doesNotMatch(prompt.promptContent + prompt.systemInstruction, /\b(BASELINE|TREATMENT|STYLE_ONLY|VOICE_ONLY|STYLE_AND_VOICE)\b|hiddenSideAssignment|promptVersionAssignment/i);
});

test('EV15: dry runs bypass the transport and reserving a live request through local mode is refused', async () => {
  const run = await runWritingEvaluation(settings(), { authenticated: true, signal: new AbortController().signal, seed: 'ev15',
    provider: async () => assert.fail('dry run invoked the provider') });
  assert.equal(run.telemetry.actualCalls, 0);
  assert.equal(run.telemetry.estimatedCostUsd, 0);
  await assert.rejects(startEvaluationSession('local_author', true, settings({ mode: 'LIVE_GEMINI', optIn: true, callBudget: 4 })),
    /LIVE_REQUIRES_DURABLE_SESSION/);
});

test('recovery and review state guards reject invalid transitions and stale versions', () => {
  assert.equal(canTransitionEvaluation('CREATED', 'RUNNING'), true);
  assert.equal(canTransitionEvaluation('CREATED', 'FINALIZED'), false);
  assert.equal(canTransitionEvaluation('FINALIZED', 'RUNNING'), false);
  assert.equal(recoverEvaluationExecution({ status: 'RUNNING', claim: { token: randomUUID(), expiresAt: 1 }, pendingCall: 2, uncertain: false }, 2), 'REMOTE_CALL_OUTCOME_UNKNOWN');
  assert.equal(recoverEvaluationExecution({ status: 'RUNNING', claim: { token: randomUUID(), expiresAt: 2 }, pendingCall: null, uncertain: false }, 2), 'EXECUTION_INTERRUPTED');
  assert.throws(() => resolveEvaluationReviewVersion(4, 'FINALIZED', 3), /VERSION_CONFLICT/);
  assert.throws(() => resolveEvaluationReviewVersion(4, 'FINALIZED', 4), /EVALUATION_REVIEW_FINALIZED/);
});

test('a missing or truncated Q response is excluded from paired statistics while blind review survives', async () => {
  const config = { RUN_LIVE_GEMINI_EVAL: 'true', GEMINI_API_KEY: 'fake-offline-transport', NOVEL_WRITING_EVAL_APPROVED_DATASET: EVALUATION_DATASET_VERSION };
  const prior = Object.fromEntries(Object.keys(config).map((key) => [key, process.env[key]]));
  Object.assign(process.env, config);
  let calls = 0;
  try {
    const run = await runWritingEvaluation(settings({ mode: 'LIVE_GEMINI', optIn: true, callBudget: 4 }), {
      authenticated: true, signal: new AbortController().signal, seed: 'partial-quality',
      provider: async (request) => {
        const output = new GenerateContentResponse();
        calls++;
        if (calls >= 3) {
          assert.match(String(request.contents), /검증된 장기 기억 근거/);
          assert.doesNotMatch(String(request.contents), /STYLE_DNA_META|VOICE_DNA_SOURCES/);
        }
        const payload = calls <= 2
          ? { manuscript_state: 'DRAFT_READY', manuscript: calls === 1 ? fixture.scene.baseline : fixture.scene.variant, issues: [], proposals: [] }
          : { overallAssessment: '오프라인 고정 응답', dimensions: [{ category: 'Q1', score: 60, confidence: 'HIGH', explanation: '테스트' }], findings: [] };
        output.candidates = [{ finishReason: calls === 4 ? FinishReason.MAX_TOKENS : FinishReason.STOP,
          content: { parts: [{ text: JSON.stringify(payload) }] } }];
        return output;
      },
    });
    assert.equal(calls, 4);
    assert.equal(run.cases[0].baseline.scores.Q1, 60);
    assert.equal(run.cases[0].treatment.qualityStatus, 'FAILED');
    assert.deepEqual(run.cases[0].treatment.scores, {});
    assert.equal(run.pairs.length, 1);
    const summary = summarizeWritingEvaluation(run.cases, run.pairs, []);
    assert.ok(summary.deltas.every((item) => item.samples === 0 && item.mean === null));
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
