import type { Episode, Revision } from '../../../types/novel';
import { calculateCharCounts, sanitizeIdArray } from '../../../utils/novelValidation';
import { computeManuscriptContentHash } from '../../../utils/manuscriptIntegrity';
import { serverTimestamp } from 'firebase/firestore';

export function episodeWriteFields(episode: Episode) {
  const counts = calculateCharCounts(episode.content);
  return {
    episodeNumber: episode.episodeNumber,
    title: episode.title,
    content: episode.content,
    synopsis: episode.synopsis,
    authorNote: episode.authorNote,
    charCountWithSpaces: counts.withSpaces,
    charCountWithoutSpaces: counts.withoutSpaces,
    status: episode.status,
    linkedCharacterIds: sanitizeIdArray(episode.linkedCharacterIds),
    linkedWorldbuildingIds: sanitizeIdArray(episode.linkedWorldbuildingIds),
    contentHash: computeManuscriptContentHash(episode.content),
    updatedAt: serverTimestamp(),
  };
}

export function newEpisodeDocument(uid: string, projectId: string, episode: Episode) {
  return {
    id: episode.id,
    ownerId: uid,
    projectId,
    ...episodeWriteFields(episode),
    latestRevisionId: typeof episode.latestRevisionId === 'string' ? episode.latestRevisionId.trim() : '',
    createdAt: serverTimestamp(),
  };
}

export function revisionDocument(uid: string, projectId: string, revision: Revision) {
  return {
    id: revision.id,
    ownerId: uid,
    projectId,
    episodeId: revision.episodeId,
    episodeTitle: revision.episodeTitle,
    content: revision.content,
    charCountWithSpaces: calculateCharCounts(revision.content).withSpaces,
    label: revision.label,
    createdAt: serverTimestamp(),
  };
}
