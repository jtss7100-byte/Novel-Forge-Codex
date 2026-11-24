import test from 'node:test';
import assert from 'node:assert/strict';
import type { NarrativeEdge, NarrativeNode } from '../types/narrativeMemory';
import { classifyStateTimeline, GRAPH_LIMITS, graphDiagnostics, relationshipPairKey, walkNarrativeGraph, narrativeNodeKey } from './narrativeMemoryLogic';
import { graphEligibility } from '../server/narrativeMemoryGraph';
import { deriveNarrativeEdges } from '../server/narrativeDerivedEdges';
import { narrativeLinkId } from '../server/narrativeMemoryStore';
import { benchmarkEdge, runNarrativeMemoryBenchmark } from './narrativeMemoryBenchmark';
import { benchmarkMemory, memoryBenchRequirements } from './sceneMemoryBenchmark';
import { buildEvaluationFixture } from './novelWritingEvaluationBenchmark';
import { assembleNovelWriterPromptInOrder } from './aiEngineLogic';

const events = Array.from({ length: 20 }, (_, i): NarrativeNode => ({ type: 'TIMELINE_EVENT', id: 'e' + i }));
const scope = { ownerId: 'synthetic-author', projectId: memoryBenchRequirements.projectId };
async function traverse(edges: NarrativeEdge[], options?: { canExpand?: () => boolean; fail?: boolean }) {
  const diagnostics = graphDiagnostics();
  const result = await walkNarrativeGraph({
    ...scope, diagnostics, seeds: [events[0]], canExpand: options?.canExpand ?? (() => true),
    load: async (node) => {
      if (options?.fail) throw new Error('GRAPH_OFFLINE');
      return edges.filter(({ from, to }) => [from, to].some((point) => narrativeNodeKey(point) === narrativeNodeKey(node)));
    },
    admit: async () => undefined,
  });
  return { ...result, diagnostics };
}

test('NM1–NM3: approved paths can recover old successors; mere scene order or participation cannot imply causality', async () => {
  const edges = [
    benchmarkEdge('a', events[0], events[1], { relation: 'CAUSES' }),
    benchmarkEdge('b', events[1], events[2], { relation: 'LEADS_TO' }),
  ];
  const result = await traverse(edges);
  assert.deepEqual([...result.paths.keys()], [narrativeNodeKey(events[1]), narrativeNodeKey(events[2])]);
  assert.equal(result.paths.get(narrativeNodeKey(events[2]))?.depth, 2);
  const derived = deriveNarrativeEdges(scope.ownerId, scope.projectId, events[0], {
    participantCharacterIds: ['char'], sceneId: 'scene', linkedForeshadowingIds: ['clue'], chronologicalOrder: 1,
  });
  assert.ok(derived.some(({ relation }) => relation === 'PARTICIPATED_IN'));
  assert.ok(derived.every(({ relation }) => relation !== 'CAUSES' && relation !== 'LEARNED_FROM'));
});

test('NM4–NM6: direction, history, conflict, and truncated histories retain distinct meanings', () => {
  assert.notEqual(relationshipPairKey('a', 'b', true), relationshipPairKey('b', 'a', true));
  assert.equal(relationshipPairKey('a', 'b', false), relationshipPairKey('b', 'a', false));
  const rows = [{ id: 'mentor', point: 10 }, { id: 'betrayal', point: 35 }, { id: 'trust', point: 150 }, { id: 'future', point: 320 }];
  assert.deepEqual([...classifyStateTimeline(rows, 300, true).values()], ['HISTORICAL', 'HISTORICAL', 'CURRENT', 'FUTURE_PLANNED']);
  assert.equal(classifyStateTimeline(rows, 300, false).get('trust'), 'UNKNOWN');
  assert.equal(classifyStateTimeline([...rows, { id: 'duplicate', point: 150 }], 300, true).get('trust'), 'CONFLICTED');
});

test('NM7–NM8: an established later recovery makes the old injury historical', () => {
  const health = [{ id: 'wound', point: 30 }, { id: 'treatment', point: 60 }, { id: 'partial', point: 80 }, { id: 'recovery', point: 120 }];
  const current = classifyStateTimeline(health, 300, true);
  assert.equal(current.get('wound'), 'HISTORICAL');
  assert.equal(current.get('recovery'), 'CURRENT');
  assert.equal(classifyStateTimeline(health, 40, true).get('wound'), 'CURRENT');
  assert.equal(classifyStateTimeline(health, 40, true).get('recovery'), 'FUTURE_PLANNED');
});

test('NM9–NM11: clue references survive closure, and a planned resolution never becomes verified by association', async () => {
  const clue: NarrativeNode = { type: 'FORESHADOWING', id: 'seal' };
  const authored = { relatedEventIds: ['e0'], plantedSceneId: 'p', resolvedSceneId: 'r' };
  const unresolved = deriveNarrativeEdges(scope.ownerId, scope.projectId, clue, { ...authored, cluePhase: 'PLANTED' });
  const resolved = deriveNarrativeEdges(scope.ownerId, scope.projectId, clue, { ...authored, cluePhase: 'RESOLVED' });
  assert.ok(unresolved.some((edge) => edge.from.id === 'e0'));
  assert.ok(!unresolved.some((edge) => edge.to.id === 'r'));
  assert.ok(resolved.some((edge) => edge.to.id === 'r'));
  const edge = benchmarkEdge('plan', events[0], clue, { relation: 'RESOLVES_FORESHADOWING', status: 'CANDIDATE' });
  assert.equal((await traverse([edge])).paths.size, 0);
});

test('NM12–NM14: future nodes, author knowledge and other projects cannot bridge a graph path', async () => {
  const future = benchmarkMemory('future', 320, '이후 사건.', {}, 'TIMELINE_EVENT');
  const privateFact = benchmarkMemory('secret', 90, '작가만 알던 말.', { knowledge: { scope: 'AUTHOR_ONLY' } }, 'TIMELINE_EVENT');
  const accepted = benchmarkMemory('past', 80, '주인공이 아는 말.', {}, 'TIMELINE_EVENT');
  assert.equal(graphEligibility(future, memoryBenchRequirements), 'FUTURE_EVENT');
  assert.equal(graphEligibility(privateFact, memoryBenchRequirements), 'POV_KNOWLEDGE_RESTRICTED');
  assert.equal(graphEligibility(accepted, memoryBenchRequirements), undefined);
  const diagnostics = graphDiagnostics();
  const a = benchmarkEdge('secret', events[0], events[1]);
  const b = benchmarkEdge('accessible', events[1], events[2]);
  const cross = benchmarkEdge('cross', events[0], events[3], { ownerId: 'unauthorized' });
  const result = await walkNarrativeGraph({ ...scope, diagnostics, seeds: [events[0]], canExpand: () => true,
    load: async () => [a, b, cross], admit: async (edge) => edge.id === 'secret' ? 'POV_KNOWLEDGE_RESTRICTED' : undefined });
  assert.equal(result.paths.size, 0);
  assert.equal(diagnostics.rejected.CROSS_PROJECT_LINK, 1);
});

test('NM17–NM20: duplicate and cyclic identities terminate within depth, fanout, and read guards', async () => {
  const chain = events.slice(0, 6).map((node, i) => benchmarkEdge('c' + i, node, events[i + 1]));
  const cycle = benchmarkEdge('reverse', events[1], events[0]);
  const result = await traverse([chain[0], chain[0], cycle, ...chain.slice(1)]);
  assert.equal(result.diagnostics.depth, GRAPH_LIMITS.depth);
  assert.equal(result.paths.size, 2);
  assert.ok(result.diagnostics.rejected.DUPLICATE_NODE);
  assert.ok(result.diagnostics.rejected.CYCLIC_PATH);
  assert.ok(result.diagnostics.rejected.GRAPH_DEPTH_EXCEEDED);
  const fanOut = await traverse(events.slice(1).map((point, i) => benchmarkEdge('f' + i, events[0], point)));
  assert.ok(fanOut.diagnostics.visitedNodes <= GRAPH_LIMITS.nodes);
  assert.ok(fanOut.diagnostics.rejected.GRAPH_BUDGET_EXCEEDED);
  let step = 0;
  const stopped = await traverse(chain, { canExpand: () => ++step < 3 });
  assert.ok(stopped.diagnostics.rejected.GRAPH_BUDGET_EXCEEDED);
  assert.notEqual(narrativeLinkId({ from: events[0], to: events[1], relation: 'CAUSES' }),
    narrativeLinkId({ from: events[1], to: events[0], relation: 'CAUSES' }));
});

test('NM23–NM24: candidates, author-only edges and graph-reader failures cannot become evidence', async () => {
  const result = await traverse([
    benchmarkEdge('guess', events[0], events[1], { status: 'CANDIDATE', relation: 'CAUSES' }),
    benchmarkEdge('private', events[0], events[2], { visibility: 'AUTHOR_ONLY' }),
  ]);
  assert.equal(result.paths.size, 0);
  assert.ok(result.diagnostics.rejected.CAUSAL_EVIDENCE_MISSING);
  await assert.rejects(traverse([], { fail: true }), /GRAPH_OFFLINE/);
});

test('NM26: controlled A/B snapshots do not include graph relationships', () => {
  const fixture = buildEvaluationFixture('NW8', 'offline-writer');
  const prompt = assembleNovelWriterPromptInOrder({ context: fixture.context, scenePlan: fixture.plan.scenes[0], totalScenesInPlan: 1 });
  assert.ok(prompt.orderedPrompt.includes(fixture.source.chunk.content));
  assert.doesNotMatch(prompt.orderedPrompt, /작가 승인 서사 연결/);
});

test('fixed-ground-truth graph benchmark reports both arms including unchanged or worse outcomes', async () => {
  const benchmark = await runNarrativeMemoryBenchmark();
  const [longRange, alreadyStrong] = benchmark.results;
  assert.ok(longRange.treatment.recallAtK > longRange.baseline.recallAtK);
  assert.ok(longRange.treatment.clueRecall === 1 && longRange.treatment.relationshipRecall === 1);
  assert.equal(alreadyStrong.treatment.recallAtK, alreadyStrong.baseline.recallAtK);
  assert.ok(alreadyStrong.treatment.ndcgAtK < alreadyStrong.baseline.ndcgAtK);
  for (const row of benchmark.results) assert.equal(row.treatment.crossProjectLeaks + row.treatment.futureLeaks + row.treatment.povLeaks, 0);
  console.info('Narrative memory benchmark', JSON.stringify(benchmark));
});
