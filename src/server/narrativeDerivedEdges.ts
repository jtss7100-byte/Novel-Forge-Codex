import type { DocumentData } from 'firebase-admin/firestore';
import { narrativeNodeKey } from '../utils/narrativeMemoryLogic';
import type { NarrativeEdge, NarrativeNode } from '../types/narrativeMemory';
import { safeMemoryId } from '../utils/sceneMemoryLogic';
import { idList, isCanon, type makeSourceReader } from './memorySourceAuthority';

export function derivedNarrativeEdge(ownerId: string, projectId: string, from: NarrativeNode, to: NarrativeNode, relation: NarrativeEdge['relation']): NarrativeEdge {
  return { id: [narrativeNodeKey(from), narrativeNodeKey(to), relation].join('>'), ownerId, projectId, from, to, relation,
    status: 'EXPLICITLY_VERIFIED', visibility: 'SOURCE_KNOWLEDGE' };
}

export function deriveNarrativeEdges(ownerId: string, projectId: string, node: NarrativeNode, record: DocumentData): NarrativeEdge[] {
  const edges: NarrativeEdge[] = [];
  const out = (type: NarrativeNode['type'], value: unknown, relation: NarrativeEdge['relation'] = 'RELATED_TO') => {
    if (safeMemoryId(value)) edges.push(derivedNarrativeEdge(ownerId, projectId, node, { type, id: value }, relation));
  };
  const inward = (type: NarrativeNode['type'], value: unknown, relation: NarrativeEdge['relation'] = 'RELATED_TO') => {
    if (safeMemoryId(value)) edges.push(derivedNarrativeEdge(ownerId, projectId, { type, id: value }, node, relation));
  };
  if (node.type === 'TIMELINE_EVENT') {
    for (const id of idList(record.linkedForeshadowingIds, 3)) out('FORESHADOWING', id);
    for (const id of idList(record.linkedWorldbuildingIds, 2)) out('WORLDBUILDING', id);
    out('SCENE', record.sceneId);
    for (const id of idList(record.participantCharacterIds, 2)) inward('CHARACTER', id, 'PARTICIPATED_IN');
  }
  if (node.type === 'EPISODE' || node.type === 'SCENE') {
    for (const id of idList(node.type === 'EPISODE' ? record.linkedEventIds : record.eventIds, 4)) out('TIMELINE_EVENT', id);
    for (const id of idList(node.type === 'EPISODE' ? record.linkedForeshadowingIds : record.foreshadowingIds, 2)) out('FORESHADOWING', id);
    if (node.type === 'SCENE') for (const id of idList(record.characterIds, 2)) inward('CHARACTER', id, 'PARTICIPATED_IN');
  }
  if (node.type === 'RELATIONSHIP') inward('TIMELINE_EVENT', record.effectiveEventId, 'CHANGES_RELATIONSHIP');
  if (node.type === 'FORESHADOWING') {
    for (const id of idList(record.relatedEventIds, 4)) inward('TIMELINE_EVENT', id);
    out('SCENE', record.plantedSceneId);
    if (record.cluePhase === 'RESOLVED') out('SCENE', record.resolvedSceneId);
  }
  return edges;
}

export async function classifyDerivedClue(edge: NarrativeEdge, reader: ReturnType<typeof makeSourceReader>) {
  if (edge.relation !== 'RELATED_TO' || edge.from.type !== 'TIMELINE_EVENT' || edge.to.type !== 'FORESHADOWING') return;
  const [event, clue] = await Promise.all([reader.entity('timelineEvents', edge.from.id), reader.entity('foreshadowings', edge.to.id)]);
  if (!isCanon(event) || !isCanon(clue) || !safeMemoryId(event?.sceneId)) return;
  const scene = await reader.entity('scenes', event?.sceneId);
  if (!isCanon(scene) || scene?.episodeId !== event?.episodeId || !Array.isArray(scene?.eventIds) || scene.eventIds.length !== 1 || scene.eventIds[0] !== edge.from.id) return;
  if (event?.sceneId === clue?.plantedSceneId && event?.episodeId === clue?.plantedEpisodeId) edge.relation = 'PLANTS_FORESHADOWING';
  else if (clue?.cluePhase === 'RESOLVED' && event?.sceneId === clue?.resolvedSceneId && event?.episodeId === clue?.resolvedEpisodeId) {
    edge.relation = 'RESOLVES_FORESHADOWING';
  }
}
