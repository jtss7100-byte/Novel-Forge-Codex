import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SceneMemoryReview } from '../components/SceneMemoryReview';
import { generateNovelSceneOnServer } from '../server/geminiWritingEngine';
import { buildEvaluationFixture } from './novelWritingEvaluationBenchmark';
import { assembleNovelWriterPromptInOrder } from './aiEngineLogic';
import { benchmarkMemory as memory, memoryBenchRequirements as requirements, runSceneMemoryBenchmark } from './sceneMemoryBenchmark';
import { buildSceneMemoryRequirements, sceneMemoryBudget, selectSceneMemory, verifySceneMemoryProvenance, type SceneMemoryCandidate } from './sceneMemoryLogic';

const select = (items: SceneMemoryCandidate[], changes: Partial<typeof requirements> = {}, budget = sceneMemoryBudget()) =>
  selectSceneMemory({ ...requirements, ...changes }, items, budget);
const source = memory('source', 10, '북쪽 관문에서 약속한 일이다.');
const provenance = { ownerId: source.source.ownerId, projectId: source.source.projectId, chunk: source.hit.chunk,
  document: source.hit.document, source: source.source, generation: 'ACTIVE' as const };
const fixture = buildEvaluationFixture('NW8', 'test-writer');

test('LM1: an anchored old event survives competition with recent high-ranking events', () => {
  const result = runSceneMemoryBenchmark();
  assert.equal(result.rows[0].ranked[0], 'oath');
  assert.equal(result.rows[0].ranked.includes('recent_distractor'), false);
  assert.ok(result.recallAtK >= 0.85);
  assert.ok(result.precisionAtK >= 0.65);
  assert.ok(result.mrr >= 0.9);
  assert.ok(result.ndcgAtK >= 0.85);
  assert.equal(result.futureLeaks + result.povLeaks + result.crossProjectLeaks, 0);
  assert.ok(result.wrongSelections <= 2);
});

test('LM2: similar names never substitute for character IDs', () => {
  const right = memory('person_known', 30, '서린이 열쇠를 맡았다.', {}, 'CHARACTER');
  const wrong = memory('person_similar', 30, '서린이 열쇠를 맡았다.', { characterIds: ['seoryn'] }, 'CHARACTER', 1);
  const result = select([wrong, right]);
  assert.deepEqual(result.selected.map(({ source }) => source.id), ['person_known']);
  assert.equal(result.rejected[0]?.reason, 'LOW_RELEVANCE');
});

test('LM3: relationship history remains distinct from the current valid state', () => {
  const old = memory('enemy', 50, '서린과 도현은 서로 대적했다.', { historicalState: true }, 'RELATIONSHIP');
  const current = memory('allies', 150, '서린과 도현은 이제 함께 관문을 지킨다.', { currentState: true }, 'RELATIONSHIP');
  assert.deepEqual(select([old, current]).selected.map(({ selection }) => selection.temporal), ['CURRENT_VALID_STATE', 'SUPERSEDED_HISTORICAL_STATE']);
});

test('LM4: a planted clue can be recalled', () => {
  const clue = memory('seal', 80, '은빛 표식은 남았지만 의미는 감춰졌다.', { foreshadowingPhase: 'PLANTED', foreshadowingIds: ['seal'] }, 'FORESHADOWING');
  const result = select([clue]);
  assert.deepEqual(result.missingForeshadowingIds, []);
  assert.ok(result.selected[0]?.selection.signals.includes('FORESHADOWING'));
});

test('LM5: a resolved clue only appears once its resolution is in the past', () => {
  const clue = memory('seal', 80, '은빛 표식의 문이 열려 비밀이 공개됐다.',
    { foreshadowingPhase: 'RESOLVED', resolvedEpisodeNumber: 250, foreshadowingIds: ['seal'] }, 'FORESHADOWING');
  assert.equal(select([clue], { episodeNumber: 249 }).rejected[0]?.reason, 'FUTURE_INFORMATION');
  assert.equal(select([clue]).selected[0]?.selection.temporal, 'PAST_EVENT');
});

test('LM6: an approved narrative cutoff takes precedence over episode publication order', () => {
  const future = memory('later_story', 10, '발설해서는 안 될 사건', { narrativeOrder: 90, eventIds: ['oath'] }, 'TIMELINE_EVENT');
  const earlier = memory('earlier_story', 500, '과거에 이미 알았던 사건', { narrativeOrder: 5 }, 'TIMELINE_EVENT');
  const result = select([future, earlier], { narrativeCutoff: { eventId: 'cutoff', order: 20 } });
  assert.deepEqual(result.selected.map(({ source }) => source.id), ['earlier_story']);
  assert.equal(result.rejected[0]?.reason, 'FUTURE_INFORMATION');
});

test('LM7: author-only, unknown, and another character’s knowledge are excluded for a limited POV', () => {
  const candidates = [
    memory('author_only', 30, '작가 비밀', { knowledge: { scope: 'AUTHOR_ONLY' } }),
    memory('another_pov', 30, '도현이 알지만 서린이 모르는 내용', { knowledge: { scope: 'CHARACTERS', characterIds: ['dohyeon'] } }),
    memory('unknown', 30, '지식 범위 미상', { knowledge: undefined }),
    source,
  ];
  assert.deepEqual(select(candidates).selected.map(({ source }) => source.id), ['source']);
  assert.deepEqual(select(candidates).rejected.map(({ reason }) => reason), Array(3).fill('POV_KNOWLEDGE_RESTRICTED'));
});

test('LM8: manuscript revision and exact offsets must match', () => {
  assert.equal(verifySceneMemoryProvenance(provenance), undefined);
  assert.equal(verifySceneMemoryProvenance({ ...provenance, source: { ...source.source, revisionId: 'rev_new' } }), 'STALE_SOURCE');
  assert.equal(verifySceneMemoryProvenance({ ...provenance, chunk: { ...source.hit.chunk, sourceStartOffset: 1 } }), 'SOURCE_UNVERIFIED');
});

test('LM9: deleted and retired generations are rejected', () => {
  assert.equal(verifySceneMemoryProvenance({ ...provenance, generation: 'DELETED' }), 'DELETED_SOURCE');
  assert.equal(verifySceneMemoryProvenance({ ...provenance, generation: 'RETIRED' }), 'RETIRED_GENERATION');
});

test('LM10: scores and CANON cannot admit a source owned by another user or project', () => {
  assert.equal(verifySceneMemoryProvenance({ ...provenance, chunk: { ...source.hit.chunk, ownerId: 'outsider' } }), 'CROSS_PROJECT');
  assert.equal(verifySceneMemoryProvenance({ ...provenance, document: { ...source.hit.document, projectId: 'elsewhere' } }), 'CROSS_PROJECT');
  assert.equal(verifySceneMemoryProvenance({ ...provenance, chunk: { ...source.hit.chunk, canonStatus: 'PROPOSED' } }), 'NON_CANON');
});

test('LM11: overlapping chunks from a revision are removed while distinct sources remain', () => {
  const parallel = memory('parallel', 10, '도현이 관문을 고쳤다.', {}, 'TIMELINE_EVENT');
  const duplicate = { ...source, hit: { ...source.hit, chunk: { ...source.hit.chunk, id: 'chunk_z_duplicate', content: '관문에서 약속한 일이다.', sourceStartOffset: 3 } } };
  const result = select([source, duplicate, parallel]);
  assert.equal(result.selected.length, 2);
  assert.ok(result.rejected.some(({ reason }) => reason === 'DUPLICATE_EVIDENCE'));
});

test('LM12: character, token, and result budgets are bounded', () => {
  const budget = sceneMemoryBudget(undefined, { maxMemoryChars: 280, maxEstimatedMemoryTokens: 200, maxSelectedChunks: 1, maxCandidateCount: 500, maxEmbeddingRequests: 5 });
  const result = select([source, memory('other', 10, '작은 열쇠'), memory('long', 10, '아주 긴 원문 '.repeat(100))], {}, budget);
  assert.equal(budget.maxCandidateCount, 48);
  assert.equal(budget.maxEmbeddingRequests, 1);
  assert.equal(result.selected.length, 1);
  assert.ok(result.memoryChars <= budget.maxMemoryChars && result.estimatedMemoryTokens <= budget.maxEstimatedMemoryTokens);
  assert.ok(result.rejected.every(({ reason }) => reason === 'BUDGET_EXCEEDED'));
});

test('LM13: each scene builds its own query, POV and anchor set', () => {
  const scene = fixture.plan.scenes[0];
  const a = buildSceneMemoryRequirements(fixture.context, { ...scene, purpose: '북쪽 관문', memory: { requiredEventIds: ['one'] } }, { episodeNumber: 30 });
  const b = buildSceneMemoryRequirements(fixture.context, { ...scene, sceneNumber: 2, purpose: '남쪽 선착장', memory: { requiredEventIds: ['two'] } }, { episodeNumber: 30 });
  assert.notDeepEqual(a.keywordQueries, b.keywordQueries);
  assert.deepEqual(a.requiredEventIds, ['one']);
  assert.deepEqual(b.requiredEventIds, ['two']);
});

test('LM15: ordinary Writer generation works with missing authority and ignores forged input evidence', async (t) => {
  const fake = 'FORGED_CLIENT_RAG_MARKER';
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'synthetic-test-key';
  t.after(() => { if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey; });
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.ok(typeof init?.body === 'string');
    assert.ok(!init.body.includes(fake));
    const manuscript = '그 날에는 낮은 바람만 복도를 지나갔다. 서린은 다시 문을 열었다.';
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      manuscript_state: 'DRAFT_READY', manuscript, issues: [], proposals: [],
    }) }] }, finishReason: 'STOP' }] });
  });
  const result = await generateNovelSceneOnServer({
    ownerId: 'local_author', plan: fixture.plan, targetSceneNumber: 1,
    context: { ...fixture.context, retrievedMemoryChunks: fixture.context.retrievedMemoryChunks?.map((item) => ({ ...item, originalText: fake })) },
  });
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.referencedMemoryChunks?.length, 0);
  assert.equal(result.sceneMemoryDiagnostics?.[0].status, 'AUTHORITY_UNAVAILABLE');
});

test('LM16: evaluation Snapshot retains its original Prompt evidence without a live retrieval diagnostic', () => {
  const prompt = assembleNovelWriterPromptInOrder({
    context: fixture.context, scenePlan: fixture.plan.scenes[0], totalScenesInPlan: 1, episodeGoal: fixture.plan.episodeGoal,
  });
  assert.ok(prompt.orderedPrompt.includes(fixture.source.chunk.content));
  assert.ok(prompt.orderedPrompt.includes(fixture.source.chunk.sourceRevisionId));
  assert.doesNotMatch(prompt.orderedPrompt, /시간 상태:/);
});

test('LM17: selection retains authoritative revision, episode, search source and signals', () => {
  const selected = select([source]).selected[0]?.selection;
  assert.equal(selected?.sourceRevisionId, 'rev_source');
  assert.equal(selected?.episodeNumber, 10);
  assert.equal(selected?.retrievalSource, 'KEYWORD_ONLY');
  assert.ok(selected?.signals.includes('FRESHNESS'));
  assert.ok(selected);
  const markup = renderToStaticMarkup(createElement(SceneMemoryReview, { records: [{
    id: 'test-retrieval', requirements, status: 'SELECTED', candidateCount: 2, searchModes: ['KEYWORD_ONLY'], vectorFallback: true,
    selected: [selected], rejected: [{ chunkId: 'old', reason: 'STALE_SOURCE' }], budget: sceneMemoryBudget(),
    memoryChars: 20, estimatedMemoryTokens: 25, retrievalRequests: 2, embeddingRequests: 1,
    missingRequiredEventIds: ['oath'], missingForeshadowingIds: [],
  }] }));
  for (const label of ['제10화', 'rev_source', '원본 검증', '이전 리비전', '키워드 사용', '회수하지 못한 중요 출처']) {
    assert.ok(markup.includes(label));
  }
});

test('LM18: reversing input order preserves deterministic ties', () => {
  const a = memory('a', 30, '푸른 구슬');
  const b = memory('b', 30, '붉은 리본');
  assert.deepEqual(select([a, b]).selected.map(({ source }) => source.id), select([b, a]).selected.map(({ source }) => source.id));
});

test('LM19: missing authority and tampered content fail closed and required anchors remain missing', () => {
  assert.equal(verifySceneMemoryProvenance({ ...provenance, source: undefined }), 'SOURCE_UNVERIFIED');
  assert.equal(verifySceneMemoryProvenance({ ...provenance, document: { ...source.hit.document, contentHash: 'fake' } }), 'SOURCE_UNVERIFIED');
  assert.deepEqual(select([source]).missingRequiredEventIds, ['oath']);
});

test('LM20: a selected set retains both a long-range promise and current identity', () => {
  const { rows, ...metrics } = runSceneMemoryBenchmark();
  assert.ok(rows[0].ranked.includes('oath'));
  assert.ok(rows[0].ranked.includes('current_identity'));
  console.info('Synthetic scene-memory metrics', JSON.stringify(metrics));
});
