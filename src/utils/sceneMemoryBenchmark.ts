import type { MemoryChunk, MemoryDocument, MemorySourceEntityType } from '../types/foundation';
import type { SceneMemoryRequirements } from '../types/sceneMemory';
import { computeMemoryContentHash } from '../services/memorySearchProvider';
import { sceneMemoryBudget, selectSceneMemory, verifySceneMemoryProvenance, type SceneMemoryCandidate, type VerifiedMemorySource } from './sceneMemoryLogic';

export const memoryBenchRequirements: SceneMemoryRequirements = {
  projectId: 'synthetic-long-memory', episodeId: 'ep_301', episodeNumber: 301, sceneNumber: 1,
  sceneGoal: '서린이 북쪽 관문에서 옛 약속과 은빛 표식의 의미를 확인한다',
  characterIds: ['seorin', 'dohyeon'], pointOfViewCharacterId: 'seorin', perspective: 'THIRD_LIMITED',
  requiredEventIds: ['oath'], relatedForeshadowingIds: ['seal'], relevantLocations: ['북쪽 관문'],
  relevantWorldbuildingIds: [], semanticQueries: ['북쪽 관문 옛 약속 은빛 표식'], keywordQueries: ['약속 표식'],
};

export function benchmarkMemory(id: string, episodeNumber: number, content: string, sourceValues: Partial<VerifiedMemorySource> = {},
  type: MemorySourceEntityType = 'EPISODE', score = 0.32): SceneMemoryCandidate {
  const ownerId = 'synthetic-author';
  const projectId = memoryBenchRequirements.projectId;
  const revisionId = `rev_${id}`;
  const contentHash = computeMemoryContentHash(content);
  const clock = '2026-01-01T00:00:00.000Z';
  const document: MemoryDocument = {
    id: `doc_${id}`, ownerId, projectId, sourceEntityType: type, sourceEntityId: id, sourceRevisionId: revisionId,
    canonStatus: 'CANON', title: id, fullText: content, chunkCount: 1, contentHash, indexGeneration: 1,
    indexStatus: 'INDEXED', createdAt: clock, updatedAt: clock,
  };
  const chunk: MemoryChunk = {
    id: `chunk_${id}`, documentId: document.id, ownerId, projectId, sourceEntityType: type,
    sourceEntityId: id, sourceRevisionId: revisionId, indexGeneration: 1, canonStatus: 'CANON', chunkIndex: 0,
    sourceStartOffset: 0, sourceEndOffset: content.length, content, contentHash, tokenEstimate: content.length,
    keywords: [], episodeId: `ep_${episodeNumber}`, sceneId: '', characterIds: [], foreshadowingIds: [], createdAt: clock,
  };
  return {
    hit: { chunk, document, score, relevanceScore: score, semanticScore: score, keywordScore: score,
      matchedTerms: [], freshnessStatus: 'FRESH', verifiedForWriting: false, retrievalSource: 'KEYWORD_ONLY' },
    source: { id, ownerId, projectId, canonStatus: 'CANON', revisionId, texts: [content], episodeNumber,
      narrativeOrder: episodeNumber, knowledge: { scope: 'CHARACTERS', characterIds: ['seorin'] },
      characterIds: ['seorin'], eventIds: [], foreshadowingIds: [], ...sourceValues },
  };
}

export function runSceneMemoryBenchmark() {
  const memories = [
    benchmarkMemory('oath', 10, '서린은 북쪽 관문에서 다시 만날 약속을 맺었다.', { eventIds: ['oath'] }, 'TIMELINE_EVENT', 0.06),
    benchmarkMemory('old_injury', 30, '서린의 왼손이 얼음 칼에 다쳤다.', { historicalState: true, eventIds: ['injury'] }),
    benchmarkMemory('old_enemy', 50, '서린과 도현은 예전에 적이었다.', { historicalState: true }, 'RELATIONSHIP'),
    benchmarkMemory('seal', 80, '은빛 표식 아래 숨은 문은 아직 열리지 않았다.',
      { foreshadowingPhase: 'PLANTED', foreshadowingIds: ['seal'] }, 'FORESHADOWING', 0.19),
    benchmarkMemory('current_identity', 150, '서린은 관문의 인장을 지키는 후계자로 인정받았다.',
      { currentState: true, knowledge: { scope: 'PUBLIC', authorImportance: 0.8 } }),
    benchmarkMemory('return', 300, '옛 약속의 증인 도현이 북쪽 관문으로 돌아왔다.', {}, 'EPISODE', 0.56),
    benchmarkMemory('recent_distractor', 300, '남쪽 식탁에 새 접시가 올라왔다.', { characterIds: ['merchant'] }, 'EPISODE', 0.38),
    benchmarkMemory('future', 305, '북쪽 관문의 최후가 드러난다.', { eventIds: ['oath'] }, 'TIMELINE_EVENT', 1),
    benchmarkMemory('private_secret', 22, '서린이 모르는 은빛 표식의 비밀.', { knowledge: { scope: 'AUTHOR_ONLY' } }, 'EPISODE', 1),
    benchmarkMemory('cross_project', 25, '북쪽 관문 약속의 다른 작품 버전.', { projectId: 'other-synthetic-project', eventIds: ['oath'] }, 'TIMELINE_EVENT', 1),
  ];
  const cases = [
    { requirements: memoryBenchRequirements, relevant: ['oath', 'seal', 'current_identity', 'return'], expectedFirst: 'oath' },
    { requirements: { ...memoryBenchRequirements, sceneGoal: '왼손 흉터와 도현의 과거 관계', requiredEventIds: ['injury'],
      relatedForeshadowingIds: [], relevantLocations: [], episodeNumber: 100 }, relevant: ['old_injury', 'old_enemy'], expectedFirst: 'old_injury' },
  ];
  const k = 4;
  const verified = memories.filter(({ hit, source }) => !verifySceneMemoryProvenance({
    ownerId: 'synthetic-author', projectId: memoryBenchRequirements.projectId,
    chunk: hit.chunk, document: hit.document, source, generation: 'ACTIVE',
  }));
  const rows = cases.map(({ requirements, relevant, expectedFirst }) => {
    const result = selectSceneMemory(requirements, verified, sceneMemoryBudget(requirements, { maxSelectedChunks: k }));
    const ranked = [...new Set(result.selected.map(({ source }) => source.id))];
    const gains = ranked.map((id) => relevant.includes(id) ? 1 : 0);
    const hits = gains.reduce<number>((sum, gain) => sum + gain, 0);
    const first = gains.indexOf(1);
    const ideal = relevant.slice(0, k).reduce((sum, _, index) => sum + 1 / Math.log2(index + 2), 0);
    return {
      ranked, expectedFirst, recall: hits / relevant.length, precision: hits / k,
      reciprocalRank: first < 0 ? 0 : 1 / (first + 1),
      ndcg: gains.reduce<number>((sum, gain, index) => sum + gain / Math.log2(index + 2), 0) / ideal,
      futureLeaks: ranked.filter((id) => id === 'future').length,
      povLeaks: ranked.filter((id) => id === 'private_secret').length,
      wrongSelections: ranked.length - hits,
      crossProjectLeaks: result.selected.filter(({ source }) => source.projectId !== requirements.projectId).length,
    };
  });
  const average = (key: 'recall' | 'precision' | 'reciprocalRank' | 'ndcg') =>
    Number((rows.reduce((sum, row) => sum + row[key], 0) / rows.length).toFixed(4));
  return {
    k, rows, recallAtK: average('recall'), precisionAtK: average('precision'), mrr: average('reciprocalRank'), ndcgAtK: average('ndcg'),
    futureLeaks: rows.reduce((sum, row) => sum + row.futureLeaks, 0),
    povLeaks: rows.reduce((sum, row) => sum + row.povLeaks, 0),
    wrongSelections: rows.reduce((sum, row) => sum + row.wrongSelections, 0),
    crossProjectLeaks: rows.reduce((sum, row) => sum + row.crossProjectLeaks, 0),
  };
}
