import type { KnowledgePosition, MemoryKnowledgeAnnotation, MemoryKnowledgeRow, MemoryKnowledgeScope } from '../types/memoryKnowledge';
import type { SceneMemoryKnowledge, SceneMemoryRequirements } from '../types/sceneMemory';

export function compareKnowledgePosition(
  source: KnowledgePosition, target: Pick<SceneMemoryRequirements, 'episodeId' | 'episodeNumber' | 'sceneNumber' | 'narrativeCutoff'>
): 'BEFORE' | 'FUTURE' | 'UNKNOWN' {
  if (target.narrativeCutoff) {
    if (source.order === undefined) return 'UNKNOWN';
    return source.order < target.narrativeCutoff.order ? 'BEFORE' : 'FUTURE';
  }
  if (source.episodeId !== target.episodeId) {
    if (source.episodeNumber === target.episodeNumber) return 'UNKNOWN';
    return source.episodeNumber < target.episodeNumber ? 'BEFORE' : 'FUTURE';
  }
  if (source.episodeNumber !== target.episodeNumber || source.sceneNumber === undefined || target.sceneNumber === undefined) return 'UNKNOWN';
  return source.sceneNumber < target.sceneNumber ? 'BEFORE' : 'FUTURE';
}

export function proposeMemoryKnowledge(verified: boolean, legacy?: SceneMemoryKnowledge, exactExcerpt = ''): {
  candidateScope: MemoryKnowledgeScope; candidateReason: MemoryKnowledgeRow['candidateReason'];
} {
  if (!verified) return { candidateScope: 'UNKNOWN', candidateReason: 'UNVERIFIED' };
  if (legacy) return { candidateScope: legacy.scope, candidateReason: 'AUTHOR_METADATA' };
  const quotation = exactExcerpt.match(/[「“"]([^」”"\n]{4,160})[」”"]/u);
  return { candidateScope: 'UNKNOWN', candidateReason: quotation ? 'DIRECT_QUOTE_REVIEW' : 'SOURCE_EXCERPT' };
}

export function hasKnowledgeScopeConflict(legacy: SceneMemoryKnowledge | undefined, scope: MemoryKnowledgeScope, characterIds: string[]) {
  if (!legacy || scope === 'UNKNOWN') return false;
  if (legacy.scope !== scope) return true;
  return scope === 'CHARACTERS' &&
    [...new Set(legacy.characterIds ?? [])].sort().join(',') !== [...new Set(characterIds)].sort().join(',');
}

export function annotationEligibility(annotation: MemoryKnowledgeAnnotation, target: SceneMemoryRequirements) {
  if (annotation.verificationStatus !== 'AUTHOR_CONFIRMED' || annotation.scope === 'UNKNOWN') return 'POV_KNOWLEDGE_RESTRICTED';
  if (annotation.scope === 'AUTHOR_ONLY') return 'POV_KNOWLEDGE_RESTRICTED';
  if (annotation.scope === 'PUBLIC') return 'PUBLIC';
  const proof = annotation.acquisition.find(({ characterId }) => characterId === target.pointOfViewCharacterId);
  if (!proof || proof.method === 'UNKNOWN' || proof.method === 'INFERRED') return 'POV_KNOWLEDGE_RESTRICTED';
  const timing = compareKnowledgePosition(proof.position, target);
  if (timing === 'UNKNOWN') return 'TEMPORAL_EVIDENCE_MISSING';
  return timing === 'BEFORE' ? 'POV_CHARACTER_KNOWLEDGE' : 'FUTURE_INFORMATION';
}
