import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FinishReason, GenerateContentResponse } from '@google/genai';
import { EVALUATION_SCENARIOS, type EvaluationSettings } from '../types/novelWritingEvaluation';
import { buildDynamicWriterSystemInstruction, generateNovelSceneOnServer, isEpisodeLocked } from '../server/geminiWritingEngine';
import { evaluationReviewInput, evaluationRunInput, finalizeEvaluationSession, runWritingEvaluation, startEvaluationSession } from '../server/novelWritingEvaluationRunner';
import { buildEvaluationFixture, EVALUATION_DATASET_VERSION, EVALUATION_OWNER_ID, verifyEvaluationEvidence } from './novelWritingEvaluationBenchmark';
import { assertControlledPrompts, checkEvaluationIntegrity, evaluationFingerprint, isCompleteEvaluationResult, makeEvaluationBlindPair, prepareEvaluationArm, summarizeWritingEvaluation } from './novelWritingEvaluationLogic';
import { computeManuscriptContentHash } from './manuscriptIntegrity';

const fixture = (id: EvaluationSettings['scenarios'][number] = 'NW1') => buildEvaluationFixture(id, 'test-writer');
const settings = (override: Partial<EvaluationSettings> = {}): EvaluationSettings => ({
  operationId: randomUUID(), scenarios: ['NW1'], treatment: 'STYLE_AND_VOICE', repeats: 1, mode: 'DRY_RUN_FIXTURE', optIn: false, ...override,
});
const options = (signal = new AbortController().signal) => ({ authenticated: false, signal, seed: 'fixed_test_seed' });

function writerResponse(manuscript: string, finishReason = FinishReason.STOP, manuscript_state = 'DRAFT_READY') {
  const response = new GenerateContentResponse();
  response.candidates = [{ finishReason, content: { parts: [{ text: JSON.stringify({ manuscript_state, manuscript, issues: [], proposals: [] }) }] } }];
  response.usageMetadata = { promptTokenCount: 120, candidatesTokenCount: 80, totalTokenCount: 200 };
  return response;
}

async function withLiveConfiguration(run: () => Promise<void>) {
  // Tests provide their own in-memory transport. No test calls a live API.
  const env = {
    RUN_LIVE_GEMINI_EVAL: 'true', GEMINI_API_KEY: 'offline-test-placeholder',
    NOVEL_WRITING_EVAL_APPROVED_DATASET: EVALUATION_DATASET_VERSION,
  };
  const saved = Object.keys(env).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, env);
  try { await run(); }
  finally {
    for (const [key, previous] of saved) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
}

test('NE1: same-scene A/B through the existing Writer and Q1–Q8 for all 12 synthetic scenes', async () => {
  const run = await runWritingEvaluation(settings({ scenarios: EVALUATION_SCENARIOS.map(([id]) => id) }), options());
  assert.equal(run.cases.length, 12);
  assert.equal(run.pairs.length, 12);
  for (const item of run.cases) {
    assert.equal(item.comparable, true, item.exclusionReasons.join(', '));
    assert.equal(item.baseline.qualityStatus, 'FIXTURE');
    assert.equal(item.treatment.qualityStatus, 'FIXTURE');
    assert.equal(Object.keys(item.treatment.scores).length, 8);
    assert.deepEqual(item.baseline.style, []);
    assert.deepEqual(item.baseline.voice, []);
    assert.equal(item.treatment.style.length, 1);
    assert.ok(item.treatment.voice.length >= 1);
    assert.notEqual(item.baseline.promptHash, item.treatment.promptHash);
  }
});

test('NE2: only approved Style DNA differs in STYLE_ONLY', () => {
  const sample = fixture();
  const a = prepareEvaluationArm(sample, 'BASELINE');
  const b = prepareEvaluationArm(sample, 'STYLE_ONLY');
  assert.equal(a.controlledPrompt, b.controlledPrompt);
  assert.deepEqual(b.voice, []);
  assert.deepEqual(b.style.map((item) => item.versionId), [sample.style.currentVersionId]);
  assert.ok(b.prompt.includes('모바일 가독성과 자연스러운 한국어를 우선'));
});

test('NE3: only approved character Voice DNA differs in VOICE_ONLY', () => {
  const sample = fixture('NW8');
  const a = prepareEvaluationArm(sample, 'BASELINE');
  const b = prepareEvaluationArm(sample, 'VOICE_ONLY');
  assert.equal(a.controlledPrompt, b.controlledPrompt);
  assert.deepEqual(b.style, []);
  assert.deepEqual(b.voice.map((item) => item.targetCharacterId), ['kael', 'sera']);
  assert.ok(b.prompt.includes('존비칭 관계를 일관되게 유지'));
});

test('NE4: choices with modified Master Writing Rules fail the control check', () => {
  const sample = fixture();
  const a = prepareEvaluationArm(sample, 'BASELINE');
  sample.context.activePrompts = sample.context.activePrompts.map((item) =>
    item.promptType === 'CORE_WRITING_RULES' ? { ...item, content: item.content + '\n변조된 추가 규칙' } : item);
  const b = prepareEvaluationArm(sample, 'STYLE_AND_VOICE');
  assert.throws(() => assertControlledPrompts(a.controlledPrompt, b.controlledPrompt,
    buildDynamicWriterSystemInstruction(a.context), buildDynamicWriterSystemInstruction(b.context)), /CONTROLLED_PROMPT_MISMATCH/);
});

test('NE5: Canon is identical in both conditions and any modification changes the common prompt', () => {
  const sample = fixture();
  const a = prepareEvaluationArm(sample, 'BASELINE');
  const b = prepareEvaluationArm(sample, 'STYLE_AND_VOICE');
  assert.deepEqual(a.context.canonWorldbuilding, b.context.canonWorldbuilding);
  assert.equal(a.controlledPrompt, b.controlledPrompt);
  sample.context.canonWorldbuilding = sample.context.canonWorldbuilding.map((item) => ({ ...item, summary: '다른 세계관 규칙' }));
  assert.notEqual(a.controlledPrompt, prepareEvaluationArm(sample, 'STYLE_AND_VOICE').controlledPrompt);
});

test('NE6: both arms receive the same verified RAG snapshot and reject stale, forged, foreign or empty evidence', async () => {
  const sample = fixture('NW12');
  const a = prepareEvaluationArm(sample, 'BASELINE');
  const b = prepareEvaluationArm(sample, 'STYLE_AND_VOICE');
  assert.deepEqual(a.context.retrievedMemoryChunks, b.context.retrievedMemoryChunks);
  assert.ok(a.prompt.includes(sample.source.chunk.content));
  const { chunk, document, source } = sample.source;
  assert.throws(() => verifyEvaluationEvidence(chunk, document, { ...source, latestRevisionId: 'unrelated_revision' }), /RAG_PROVENANCE_FAILURE/);
  assert.throws(() => verifyEvaluationEvidence({ ...chunk, content: 'forged' }, document, source), /RAG_PROVENANCE_FAILURE/);
  assert.throws(() => verifyEvaluationEvidence({ ...chunk, projectId: 'different_project' }, document, source), /RAG_PROVENANCE_FAILURE/);
  await assert.rejects(generateNovelSceneOnServer({ ownerId: EVALUATION_OWNER_ID,
    context: { ...a.context, retrievedMemoryChunks: [] }, plan: sample.plan, targetSceneNumber: 1,
    evaluation: { modelId: 'test', generate: async () => { assert.fail('missing evidence reached the model'); } },
  }), /RAG_PROVENANCE_FAILURE/);
});

test('NE7: dynamic scene POV survives treatment even when the episode uses a different POV', async () => {
  const run = await runWritingEvaluation(settings({ scenarios: ['NW10', 'NW11'] }), options());
  assert.deepEqual(run.cases.map((item) => item.manifest.perspective), ['FIRST_PERSON', 'THIRD_LIMITED']);
  assert.deepEqual(run.cases.map((item) => item.manifest.characters), [['kael'], ['kael', 'sera']]);
});

test('NE8: offstage, inactive and foreign voice profiles are excluded', () => {
  const sample = fixture('NW8');
  sample.voice[1] = { ...sample.voice[1], isActive: false };
  sample.voice.push({ ...sample.voice[0], projectId: 'other_project', title: 'Foreign voice' });
  const arm = prepareEvaluationArm(sample, 'STYLE_AND_VOICE');
  assert.deepEqual(arm.voice.map((item) => item.targetCharacterId), ['kael']);
  assert.ok(!arm.prompt.includes('가렌 승인 화법'));
  assert.ok(!arm.prompt.includes('세라피나 승인 화법'));
  assert.ok(!arm.prompt.includes('Foreign voice'));
});

test('NE9: used version ID and content hash match the approved stored version and detect tampering', () => {
  const sample = fixture();
  const b = prepareEvaluationArm(sample, 'STYLE_AND_VOICE');
  assert.equal(b.style[0].contentHash, computeManuscriptContentHash(sample.style.versions[0].content));
  assert.equal(b.style[0].versionId, sample.style.currentVersionId);
  sample.style.content += '\n변조';
  assert.throws(() => prepareEvaluationArm(sample, 'STYLE_AND_VOICE'), /INVALID_APPROVED_PROFILE_VERSION/);
});

test('NE10: partial, truncated or unparseable manuscripts do not reach scoring or blindness', async () => {
  assert.equal(isCompleteEvaluationResult({ status: 'PARTIAL', executionState: 'DRAFT_READY', manuscript: fixture().scene.baseline }), false);
  await withLiveConfiguration(async () => {
    let received = 0;
    const run = await runWritingEvaluation(settings({ mode: 'LIVE_GEMINI', optIn: true, callBudget: 4 }), {
      ...options(), authenticated: true,
      provider: async () => { received++; return writerResponse(fixture().scene.baseline, FinishReason.MAX_TOKENS); },
    });
    assert.equal(received, 2);
    assert.equal(run.cases[0].comparable, false);
    assert.equal(run.telemetry.qualityCalls, 0);
    assert.equal(run.telemetry.measuredTokens, 400);
    assert.deepEqual(run.pairs, []);
    assert.match(run.cases[0].exclusionReasons.join(' '), /INCOMPLETE_GENERATION/);
  });
});

test('NE11: actual plan, episode lock and pre-writing conflict gate remain effective, and blocked output stays unscored', async () => {
  const sample = fixture();
  const common = { ownerId: EVALUATION_OWNER_ID, context: sample.context, targetSceneNumber: 1,
    evaluation: { modelId: 'test', generate: async () => { assert.fail('blocked request reached the provider'); } } };
  await assert.rejects(generateNovelSceneOnServer({ ...common, plan: { ...sample.plan, status: 'DRAFT_PLAN' } }), /승인/);
  const blocked = await generateNovelSceneOnServer({ ...common, context: { ...sample.context, plotOutline: '공간 이동 마법 사용' }, plan: sample.plan });
  assert.equal(blocked.executionState, 'BLOCKED_CONFLICT');
  assert.equal(blocked.manuscript, '');
  assert.deepEqual(checkEvaluationIntegrity(sample, blocked), ['CANON_VIOLATION']);
  assert.equal(isEpisodeLocked(sample.context.projectId, sample.context.episodeId), false);
  await withLiveConfiguration(async () => {
    const run = await runWritingEvaluation(settings({ mode: 'LIVE_GEMINI', optIn: true, callBudget: 4 }), {
      ...options(), authenticated: true, provider: async () => writerResponse('', FinishReason.STOP, 'BLOCKED_CONFLICT'),
    });
    assert.deepEqual(run.cases[0].baseline.scores, {});
    assert.equal(run.cases[0].baseline.qualityStatus, 'NOT_EVALUATED');
    assert.equal(run.telemetry.qualityCalls, 0);
    assert.match(run.cases[0].exclusionReasons.join(' '), /BLOCKED_CONFLICT/);
  });
});

test('NE12: blind randomization is deterministic, uses both orders and does not expose the assignment', () => {
  const input = { seed: 'seed', scenarioId: 'NW1' as const, title: 'scene', goal: 'goal', baseline: 'baseline text', treatment: 'treatment text' };
  const first = makeEvaluationBlindPair({ ...input, caseId: 'run1', index: 0 });
  assert.deepEqual(first, makeEvaluationBlindPair({ ...input, caseId: 'run1', index: 0 }));
  const options = new Set(Array.from({ length: 20 }, (_, index) => makeEvaluationBlindPair({ ...input, caseId: 'run1', index }).pair.optionA));
  assert.deepEqual(options, new Set([input.baseline, input.treatment]));
  assert.deepEqual(Object.keys(first.pair).sort(), ['goal', 'optionA', 'optionB', 'pairId', 'scenarioId', 'title']);
});

test('NE13: unrated and deferred cases produce NOT_RATED and no win rate', async () => {
  const run = await runWritingEvaluation(settings(), options());
  const empty = summarizeWritingEvaluation(run.cases, run.pairs, []);
  assert.equal(empty.human.status, 'NOT_RATED');
  assert.equal(empty.human.rewriteWinRateExcludingTiesPercent, null);
  const defer = summarizeWritingEvaluation(run.cases, run.pairs, [{ pairId: run.pairs[0].pair.pairId, choice: 'DEFER' }]);
  assert.equal(defer.human.notRatedCount, 1);
  assert.equal(defer.human.rewriteWinRateExcludingTiesPercent, null);
  const decisive = summarizeWritingEvaluation(run.cases, run.pairs, [{
    pairId: run.pairs[0].pair.pairId, choice: run.pairs[0].assignment === 'A_ORIGINAL_B_REWRITE' ? 'B' : 'A',
  }]);
  assert.equal(decisive.human.rewriteWinRateExcludingTiesPercent, 100);
  assert.equal(decisive.deltas.every((item) => item.mean === 0 && item.samples === 1), true);
});

test('NE14: live budget counts both Writer and quality calls before any model access', async () => {
  await withLiveConfiguration(async () => {
    await assert.rejects(runWritingEvaluation(settings({ mode: 'LIVE_GEMINI', optIn: true, callBudget: 3 }), {
      ...options(), authenticated: true, provider: async () => { assert.fail('over-budget model call'); },
    }), /CALL_BUDGET_EXCEEDED/);
    const replies = [fixture().scene.baseline, fixture().scene.variant];
    const requests: string[] = [];
    const run = await runWritingEvaluation(settings({ mode: 'LIVE_GEMINI', optIn: true, callBudget: 4 }), {
      ...options(), authenticated: true, provider: async (request) => {
        assert.equal(request.config?.temperature, 0.7);
        assert.equal(request.config?.httpOptions?.retryOptions?.attempts, 1);
        requests.push(String(request.contents));
        if (requests.length <= 2) return writerResponse(replies[requests.length - 1]);
        const response = new GenerateContentResponse();
        response.candidates = [{ finishReason: FinishReason.STOP, content: { parts: [{ text: JSON.stringify({
          overallAssessment: '가상 테스트', dimensions: [{ category: 'Q1', score: 50, confidence: 'MEDIUM', explanation: '가상' }], findings: [],
        }) }] } }];
        return response;
      },
    });
    assert.equal(requests.length, 4);
    assert.equal(run.cases[0].comparable, true);
    assert.equal(run.telemetry.generationCalls, 2);
    assert.equal(run.telemetry.qualityCalls, 2);
    assert.equal(run.telemetry.actualCalls, 4);
    assert.equal(run.telemetry.callsWithoutUsage, 2);
    assert.equal(run.telemetry.estimatedCostUsd, null);
    const candidateBlock = /<reference_data type="manuscript_to_evaluate"[^>]*>[\s\S]*?<\/reference_data>/;
    assert.ok(candidateBlock.test(requests[2]) && candidateBlock.test(requests[3]));
    assert.equal(evaluationFingerprint(requests[2].replace(candidateBlock, 'CANDIDATE')),
      evaluationFingerprint(requests[3].replace(candidateBlock, 'CANDIDATE')));
  });
});

test('NE15: disabled live and dry run cannot invoke an external transport', async () => {
  const provider = async () => { assert.fail('external provider must never be called'); };
  const run = await runWritingEvaluation(settings(), { ...options(), provider });
  assert.equal(run.telemetry.actualCalls, 0);
  assert.equal(run.telemetry.measuredTokens, 0);
  assert.equal(run.telemetry.estimatedCostUsd, 0);
  await assert.rejects(runWritingEvaluation(settings({ mode: 'LIVE_GEMINI', optIn: true, callBudget: 4 }),
    { ...options(), provider }), /LIVE_DISABLED_OR_APPROVAL_REQUIRED/);
});

test('NE16: actual Writer evaluation does not mutate manuscript, plan, CANON or synthetic source Revision', async () => {
  const sample = fixture('NW12');
  const before = structuredClone(sample);
  const arm = prepareEvaluationArm(sample, 'STYLE_AND_VOICE');
  const result = await generateNovelSceneOnServer({
    ownerId: EVALUATION_OWNER_ID, context: arm.context, plan: sample.plan, targetSceneNumber: 1,
    evaluation: { modelId: 'test', generate: async () => writerResponse(sample.scene.variant) },
  });
  assert.equal(result.executionState, 'DRAFT_READY');
  assert.deepEqual(sample, before);
  assert.deepEqual(checkEvaluationIntegrity(sample, result), []);
  const safety = checkEvaluationIntegrity(sample, { ...result, manuscript: '푸른 실. 세라피나의 속마음은 비밀이었다. 카엘은 경비대장이었다. “쇠종의 그림자.” 카엘이 말했다. 세라피나는 순간이동했다.' });
  assert.ok(safety.includes('POV_VIOLATION'));
  assert.ok(safety.includes('FORBIDDEN_DEVELOPMENT'));
  assert.ok(safety.includes('CHARACTER_IDENTITY_DRIFT'));
  assert.ok(safety.includes('CHARACTER_VOICE_LEAKAGE'));
});

test('NE17: a transport error is counted once, and cancellation stops remaining Writer and Q calls', async () => {
  await withLiveConfiguration(async () => {
    const controller = new AbortController();
    const run = await runWritingEvaluation(settings({ mode: 'LIVE_GEMINI', optIn: true, callBudget: 4 }), {
      ...options(controller.signal), authenticated: true, provider: async () => {
        controller.abort();
        throw new Error('NO_CREDENTIALS_IN_REPORT');
      },
    });
    assert.equal(run.interrupted, true);
    assert.equal(run.telemetry.actualCalls, 1);
    assert.equal(run.telemetry.callsWithoutUsage, 1);
    assert.equal(run.cases[0].treatment.status, 'ABORTED');
    assert.ok(!JSON.stringify(run).includes('NO_CREDENTIALS_IN_REPORT'));
  });
});

test('NE18: replaying a session returns identical results and duplicate fixed outputs do not add samples', async () => {
  const setup = settings({ repeats: 2 });
  const [first, replay] = await Promise.all([startEvaluationSession('replay-author', false, setup), startEvaluationSession('replay-author', false, setup)]);
  assert.deepEqual(first, replay);
  assert.equal(first.pairs.length, 1);
  assert.equal(first.excluded, 1);
  await assert.rejects(startEvaluationSession('replay-author', false, { ...setup, repeats: 1 }), /EVALUATION_OPERATION_CONFLICT/);
});

test('NE19: another owner cannot reuse or finalize an evaluation, and real data fields are rejected', async () => {
  const setup = settings();
  assert.equal(evaluationRunInput.safeParse({ ...setup, projectId: 'user_project', manuscript: 'private' }).success, false);
  await startEvaluationSession('private-owner', false, setup);
  await assert.rejects(startEvaluationSession('other-owner', false, setup), /EVALUATION_SESSION_NOT_FOUND/);
  assert.throws(() => finalizeEvaluationSession('other-owner', setup.operationId, []), /EVALUATION_SESSION_NOT_FOUND/);
});

test('NE20: only finalized review reveals identities and a later rating cannot replace the saved review', async () => {
  const setup = settings();
  const blind = await startEvaluationSession('review-owner', false, setup);
  assert.ok(!JSON.stringify(blind).includes('baseline'));
  const ratings = [{ pairId: blind.pairs[0].pairId, choice: 'TIE' as const, comment: '고정 테스트' }];
  assert.equal(evaluationReviewInput.safeParse({ operationId: setup.operationId, ratings }).success, true);
  const final = finalizeEvaluationSession('review-owner', setup.operationId, ratings);
  assert.equal(final.reveal.length, 1);
  assert.equal(final.summary.human.tieCount, 1);
  assert.equal(final.summary.human.rewriteWinRateExcludingTiesPercent, null);
  assert.equal(evaluationFingerprint(final), evaluationFingerprint(finalizeEvaluationSession('review-owner', setup.operationId, ratings)));
  assert.throws(() => finalizeEvaluationSession('review-owner', setup.operationId, []), /EVALUATION_REVIEW_FINALIZED/);
});
