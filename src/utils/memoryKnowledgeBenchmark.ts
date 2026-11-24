import type { MemoryKnowledgeAnnotation } from '../types/memoryKnowledge';
import { memoryAnnotationId, memoryKnowledgeSource } from '../server/memoryKnowledgeStore';
import { benchmarkMemory, memoryBenchRequirements } from './sceneMemoryBenchmark';
import { sceneMemoryBudget, selectSceneMemory, verifySceneMemoryProvenance } from './sceneMemoryLogic';

export function runLegacyKnowledgeBenchmark() {
  const target = { ...memoryBenchRequirements, requiredEventIds: ['oath'], relatedForeshadowingIds: [], episodeNumber: 300, episodeId: 'ep300' };
  const intelligence = [
    benchmarkMemory('oath', 10, '서린이 성문에서 오래된 약속을 맺었다.', { eventIds: ['oath'], knowledge: undefined }),
    benchmarkMemory('injury', 30, '서린의 손이 성문에서 다쳤다.', { knowledge: undefined }),
    benchmarkMemory('secret', 50, '기록에 남은 신분의 비밀이다.', { knowledge: undefined }),
    benchmarkMemory('future', 350, '성문이 무너진다.', { knowledge: undefined }),
    benchmarkMemory('other_project', 10, '다른 작품의 성문 약속.', { projectId: 'foreign', knowledge: undefined }),
    benchmarkMemory('stale', 40, '수정되기 전의 사건.', { knowledge: undefined }),
  ];
  const truth = new Set(['oath', 'injury']);
  const k = 2;
  const run = (approved: boolean) => {
    const verified = intelligence.filter(({ source, hit }) => !verifySceneMemoryProvenance({
      ownerId: 'synthetic-author', projectId: target.projectId, source,
      chunk: hit.chunk, document: hit.document, generation: 'ACTIVE',
    }));
    const candidates = verified.map(({ source, hit }) => {
      if (!approved) return { source, hit };
      const ref = memoryKnowledgeSource(hit.chunk, hit.document, source)!;
      const scope = source.id === 'secret' ? 'AUTHOR_ONLY' : 'PUBLIC';
      const record: MemoryKnowledgeAnnotation = {
        id: memoryAnnotationId(ref), ownerId: source.ownerId, projectId: source.projectId, source: ref, scope,
        classification: 'PAST_EVENT', verificationStatus: 'AUTHOR_CONFIRMED', version: 1,
        operationId: 'synthetic_op', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        approvedBy: source.ownerId, acquisition: [],
      };
      return { source: { ...source, durableKnowledge: record,
        ...(source.id === 'stale' ? { knowledgeRejection: 'STALE_ANNOTATION' as const } : {}) }, hit };
    });
    const eligible = selectSceneMemory(target, candidates, sceneMemoryBudget(target, { maxSelectedChunks: 10 })).selected;
    const ranked = eligible.slice(0, k).map((row) => row.source);
    const matches = ranked.filter((row) => truth.has(row.id)).length;
    return {
      totalMemories: intelligence.length, eligibleMemories: eligible.length,
      unannotatedMemories: approved ? intelligence.length - verified.length : intelligence.length,
      approvedMemories: approved ? verified.length - 1 : 0, staleAnnotations: approved ? 1 : 0,
      recallAtK: matches / truth.size, precisionAtK: matches / k,
      futureLeaks: eligible.filter((row) => row.source.id === 'future').length,
      povLeaks: eligible.filter((row) => row.source.id === 'secret').length,
      crossProjectLeaks: eligible.filter((row) => row.source.projectId !== target.projectId).length,
    };
  };
  return { before: run(false), after: run(true) };
}
