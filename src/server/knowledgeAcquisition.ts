import { createHash } from 'node:crypto';
import type { KnowledgeAcquisitionInput, KnowledgePosition } from '../types/memoryKnowledge';
import { episodePosition, finite, idList, isCanon, type makeSourceReader } from './memorySourceAuthority';

export const knowledgeHash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export async function resolveKnowledgeAcquisition(
  reader: ReturnType<typeof makeSourceReader>, input: KnowledgeAcquisitionInput,
): Promise<{ position: KnowledgePosition; proofHash: string } | undefined> {
  const [episode, event] = await Promise.all([
    reader.entity('episodes', input.episodeId), reader.entity('timelineEvents', input.eventId),
  ]);
  const sceneId = input.sceneId || (typeof event?.sceneId === 'string' && event.sceneId ? event.sceneId : undefined);
  const scene = await reader.entity('scenes', sceneId);
  const episodeNumber = episodePosition(episode?.episodeNumber);
  if (episodeNumber === undefined || (sceneId && (!isCanon(scene) || scene?.episodeId !== input.episodeId)) ||
      (input.eventId && (!isCanon(event) || event?.episodeId !== input.episodeId || (sceneId && event.sceneId !== sceneId)))) return;
  const ids = [scene?.sourceRevisionId, event?.sourceRevisionId].filter(Boolean);
  if (!scene && !event) {
    if (!isCanon(episode) || !episode?.latestRevisionId) return;
    ids.push(episode.latestRevisionId);
  }
  if ((scene && !scene.sourceRevisionId) || (event && !event.sourceRevisionId)) return;
  const revisions = await Promise.all([...new Set(ids)].map((id) => reader.entity('revisions', id)));
  if (!revisions.length || revisions.some((revision) => !revision || revision.episodeId !== input.episodeId)) return;
  if (!scene && !event && revisions[0]?.content !== episode?.content) return;

  const linkedEventProofs: [string, string, number][] = [];
  const position: KnowledgePosition = { episodeId: input.episodeId, episodeNumber };
  if (sceneId) {
    const sceneNumber = episodePosition(scene?.sceneNumber);
    if (sceneNumber === undefined) return;
    Object.assign(position, { sceneId, sceneNumber });
  }
  if (input.eventId) {
    const order = finite(event?.chronologicalOrder);
    if (order === undefined) return;
    Object.assign(position, { eventId: input.eventId, order });
  } else if (scene && Array.isArray(scene.eventIds) && scene.eventIds.length && scene.eventIds.length <= 12) {
    const eventIds = idList(scene.eventIds);
    const events = await Promise.all(eventIds.map((id) => reader.entity('timelineEvents', id)));
    for (const row of events) {
      if (!row || !isCanon(row) || row.sceneId !== sceneId || row.episodeId !== input.episodeId) break;
      const order = finite(row.chronologicalOrder);
      const revision = await reader.entity('revisions', row.sourceRevisionId);
      if (order === undefined || revision?.episodeId !== input.episodeId) break;
      linkedEventProofs.push([row.id, revision.id, order]);
    }
    if (linkedEventProofs.length === scene.eventIds.length) position.order = Math.max(...linkedEventProofs.map(([, , order]) => order));
  }
  const proofHash = knowledgeHash(JSON.stringify([
    input.characterId, input.method, position, scene?.sourceRevisionId, event?.sourceRevisionId,
    ...(position.order !== undefined && !input.eventId ? [linkedEventProofs] : []),
    revisions.map((revision) => [revision?.id, typeof revision?.content === 'string' ? knowledgeHash(revision.content) : null]),
  ]));
  return { position, proofHash };
}
