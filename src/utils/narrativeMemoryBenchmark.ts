import { graphEligibility, graphNode } from '../server/narrativeMemoryGraph';
import type { GraphRejection, NarrativeEdge, NarrativeNode } from '../types/narrativeMemory';
import { graphDiagnostics, narrativeNodeKey, walkNarrativeGraph } from './narrativeMemoryLogic';
import { selectSceneMemory, sceneMemoryBudget } from './sceneMemoryLogic';
import { benchmarkMemory, memoryBenchRequirements } from './sceneMemoryBenchmark';

const target = { ...memoryBenchRequirements, episodeId: 'episode300', episodeNumber: 300,
  requiredEventIds: ['meeting'], relatedForeshadowingIds: ['clue'] };
const ownerId = 'synthetic-author';
const projectId = target.projectId;
const event = (id: string): NarrativeNode => ({ type: 'TIMELINE_EVENT', id });
export const benchmarkEdge = (id: string, from: NarrativeNode, to: NarrativeNode, values: Partial<NarrativeEdge> = {}): NarrativeEdge =>
  ({ id, ownerId, projectId, from, to, relation: 'RELATED_TO', status: 'AUTHOR_CONFIRMED', visibility: 'SOURCE_KNOWLEDGE', ...values });

export async function runNarrativeMemoryBenchmark() {
  const meeting = benchmarkMemory('meeting', 10, '북쪽 관문에서 스승과 서약을 맺었다.', { eventIds: ['meeting'] }, 'TIMELINE_EVENT', 0.65);
  const betrayal = benchmarkMemory('betrayal', 35, '새벽에 스승이 제자를 버렸다.', {}, 'TIMELINE_EVENT', 0);
  const clue = benchmarkMemory('clue', 72, '은빛 표식이 배신의 이유를 암시한다.', {
    foreshadowingIds: ['clue'], foreshadowingPhase: 'PLANTED',
  }, 'FORESHADOWING', 0);
  const relation = benchmarkMemory('relation', 150, '제자와 스승이 오해를 일부 풀었다.', { currentState: true }, 'RELATIONSHIP', 0);
  const distractor = benchmarkMemory('ordinary', 299, '북쪽 관문의 깃발이 붙었다.', {}, 'EPISODE', 0.18);
  const future = benchmarkMemory('future', 340, '스승이 다시 배신한다.', {}, 'TIMELINE_EVENT', 1);
  const secret = benchmarkMemory('secret', 80, '서린은 아직 모르는 배신의 동기.', { knowledge: { scope: 'AUTHOR_ONLY' } }, 'TIMELINE_EVENT', 1);
  const foreign = benchmarkMemory('foreign', 30, '다른 작품의 배신.', { projectId: 'another' }, 'TIMELINE_EVENT', 1);
  const corpus = [meeting, betrayal, clue, relation, distractor, future, secret, foreign];
  const cases = [
    {
      name: '300화 재회', base: [meeting, distractor], truth: ['meeting', 'betrayal', 'clue', 'relation'],
      edges: [
        benchmarkEdge('causal', event('meeting'), event('betrayal'), { relation: 'CAUSES' }),
        benchmarkEdge('clue', event('betrayal'), { type: 'FORESHADOWING', id: 'clue' }),
        benchmarkEdge('relationship', event('betrayal'), { type: 'RELATIONSHIP', id: 'relation' }, { relation: 'CHANGES_RELATIONSHIP' }),
        benchmarkEdge('future', event('meeting'), event('future')), benchmarkEdge('secret', event('meeting'), event('secret')),
        benchmarkEdge('cross', event('meeting'), event('foreign'), { projectId: 'another' }),
      ],
    },
    {
      name: '이미 핵심 사건이 검색된 장면', base: [meeting, betrayal, relation], truth: ['meeting', 'betrayal', 'relation'],
      edges: [benchmarkEdge('peripheral', event('meeting'), { type: 'EPISODE', id: 'ordinary' })],
    },
  ];
  const k = 4;
  const results = [];
  for (const fixture of cases) {
    const budget = sceneMemoryBudget(target, { maxSelectedChunks: k });
    const byNode = new Map(corpus.map((candidate) => [narrativeNodeKey(graphNode(candidate)!), candidate]));
    const diagnostics = graphDiagnostics();
    let discoveryReads = 0, exactReads = 0;
    const graph = await walkNarrativeGraph({
      seeds: [event('meeting')], diagnostics, ownerId, projectId, canExpand: () => discoveryReads + exactReads < 8,
      load: async (node) => {
        discoveryReads++;
        const key = narrativeNodeKey(node);
        return fixture.edges.filter((edge) => [edge.from, edge.to].some((point) => narrativeNodeKey(point) === key));
      },
      admit: async (_edge, node): Promise<GraphRejection | undefined> => {
        exactReads++;
        const item = byNode.get(narrativeNodeKey(node));
        if (!item) return 'DELETED_NODE';
        if (item.source.projectId !== projectId) return 'CROSS_PROJECT_LINK';
        return graphEligibility(item, target);
      },
    });
    const added = [...graph.paths].flatMap(([key, graphPath]) => {
      const item = byNode.get(key);
      return item && !fixture.base.includes(item) ? [{ ...item, graphPath }] : [];
    });
    const measure = (items: typeof corpus, reads: number, expanded: number) => {
      const result = selectSceneMemory(target, items, budget);
      const ids = result.selected.map((row) => row.source.id);
      const gains = ids.map((id) => fixture.truth.includes(id) ? 1 : 0);
      const count = gains.reduce<number>((sum, gain) => sum + gain, 0);
      const first = gains.indexOf(1);
      const dcg = (values: number[]) => values.reduce((sum, gain, i) => sum + gain / Math.log2(i + 2), 0);
      const categories = (names: string[]) => {
        const expected = names.filter((id) => fixture.truth.includes(id));
        return expected.length ? expected.filter((id) => ids.includes(id)).length / expected.length : null;
      };
      return {
        ids, recallAtK: count / fixture.truth.length, precisionAtK: count / k,
        mrr: first < 0 ? 0 : 1 / (first + 1),
        ndcgAtK: Number((dcg(gains) / dcg(fixture.truth.slice(0, k).map(() => 1))).toFixed(4)),
        eventRecall: categories(['meeting', 'betrayal']), relationshipRecall: categories(['relation']), clueRecall: categories(['clue']),
        futureLeaks: ids.filter((id) => id === 'future').length, povLeaks: ids.filter((id) => id === 'secret').length,
        crossProjectLeaks: ids.filter((id) => id === 'foreign').length, reads, expanded, memoryChars: result.memoryChars,
        estimatedTokens: result.estimatedMemoryTokens,
      };
    };
    results.push({ name: fixture.name, baseline: measure(fixture.base, 1, 0),
      treatment: measure([...fixture.base, ...added], 1 + discoveryReads + exactReads, added.length) });
  }
  return { k, results };
}
