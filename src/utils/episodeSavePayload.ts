import type { Episode } from '../types/novel';
import { computeManuscriptContentHash } from './manuscriptIntegrity';
import { sanitizeIdArray } from './novelLogic';

export type EpisodeSaveFields = Pick<Episode, 'episodeNumber' | 'title' | 'content' | 'synopsis' |
  'authorNote' | 'status' | 'linkedCharacterIds' | 'linkedWorldbuildingIds'>;

export function episodeSaveSignature(episode: EpisodeSaveFields): string {
  return JSON.stringify([
    episode.episodeNumber, (episode.title || '무제 회차').trim().slice(0, 150) || '무제 회차',
    episode.content, episode.synopsis, episode.authorNote, episode.status,
    sanitizeIdArray(episode.linkedCharacterIds), sanitizeIdArray(episode.linkedWorldbuildingIds),
  ]);
}

export function episodeSavePayloadHash(episode: EpisodeSaveFields): string {
  return computeManuscriptContentHash(episodeSaveSignature(episode));
}

export function storedEpisodeSavePayloadHash(data: Record<string, unknown>): string {
  return episodeSavePayloadHash({
    episodeNumber: Number(data.episodeNumber ?? 1),
    title: String(data.title ?? ''),
    content: String(data.content ?? ''),
    synopsis: String(data.synopsis ?? ''),
    authorNote: String(data.authorNote ?? ''),
    status: data.status === 'confirmed' || data.status === 'review' ? data.status : 'draft',
    linkedCharacterIds: sanitizeIdArray(data.linkedCharacterIds),
    linkedWorldbuildingIds: sanitizeIdArray(data.linkedWorldbuildingIds),
  });
}
