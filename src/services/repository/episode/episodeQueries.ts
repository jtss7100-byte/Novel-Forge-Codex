import type { QuerySnapshot } from 'firebase/firestore';
import { handleFirestoreError, OperationType } from '../../../firebase';
import type { Episode, Revision } from '../../../types/novel';
import { computeManuscriptContentHash } from '../../../utils/manuscriptIntegrity';
import { calculateCharCounts, sanitizeIdArray } from '../../../utils/novelValidation';
import { firestoreProjectPath } from '../core/projectPath';
import { toIsoString } from '../core/firestoreTimestamp';

type ReadCollection = (path: string) => Promise<QuerySnapshot>;

export async function readProjectEpisodes(
  uid: string,
  projectId: string,
  readCollection: ReadCollection,
): Promise<Episode[]> {
  const path = `${firestoreProjectPath(uid, projectId)}/episodes`;
  try {
    const snap = await readCollection(path);
    return snap.docs
      .map((d) => {
        const data = d.data();
        const content = String(data.content ?? '');
        const counts = calculateCharCounts(content);
        return {
          id: String(data.id ?? d.id),
          ownerId: String(data.ownerId ?? uid),
          projectId: String(data.projectId ?? projectId),
          episodeNumber: Number(data.episodeNumber ?? 1),
          title: String(data.title ?? ''),
          content,
          synopsis: String(data.synopsis ?? ''),
          authorNote: String(data.authorNote ?? ''),
          charCountWithSpaces: Number(data.charCountWithSpaces ?? counts.withSpaces),
          charCountWithoutSpaces: Number(data.charCountWithoutSpaces ?? counts.withoutSpaces),
          status:
            data.status === 'confirmed' || data.status === 'review' ? data.status : 'draft',
          linkedCharacterIds: sanitizeIdArray(data.linkedCharacterIds),
          linkedWorldbuildingIds: sanitizeIdArray(data.linkedWorldbuildingIds),
          latestRevisionId:
            typeof data.latestRevisionId === 'string' && data.latestRevisionId.trim().length > 0
              ? data.latestRevisionId
              : undefined,
          contentHash:
            typeof data.contentHash === 'string' && data.contentHash.trim().length > 0
              ? data.contentHash
              : computeManuscriptContentHash(content),
          createdAt: toIsoString(data.createdAt),
          updatedAt: toIsoString(data.updatedAt),
        };
      })
      .sort((a, b) => a.episodeNumber - b.episodeNumber);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function readProjectRevisions(
  uid: string,
  projectId: string,
  readCollection: ReadCollection,
): Promise<Revision[]> {
  const path = `${firestoreProjectPath(uid, projectId)}/revisions`;
  try {
    const snap = await readCollection(path);
    return snap.docs
      .map((d) => {
        const data = d.data();
        return {
          id: String(data.id ?? d.id),
          ownerId: String(data.ownerId ?? uid),
          projectId: String(data.projectId ?? projectId),
          episodeId: String(data.episodeId ?? ''),
          episodeTitle: String(data.episodeTitle ?? ''),
          content: String(data.content ?? ''),
          charCountWithSpaces: Number(data.charCountWithSpaces ?? 0),
          label: String(data.label ?? ''),
          createdAt: toIsoString(data.createdAt),
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}
