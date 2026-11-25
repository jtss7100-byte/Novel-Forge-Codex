import type { Project, Character, WorldbuildingItem, Episode, Revision } from '../../../types/novel';
import { query, collection, where, getDocs, type Firestore } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../../firebase';
import { toIsoString } from '../core/firestoreTimestamp';
import { sanitizeIdArray } from '../../../utils/novelValidation';
import { firestoreProjectPath } from '../core/projectPath';
import { readProjectEpisodes, readProjectRevisions } from '../episode/episodeQueries';

export async function fetchFirestoreProjects(uid: string): Promise<Project[]> {
  const path = `users/${uid}/projects`;
  try {
    const q = query(collection(db, path), where('ownerId', '==', uid));
    const snap = await getDocs(q);
    const items: Project[] = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: String(data.id ?? d.id),
        ownerId: String(data.ownerId ?? uid),
        title: String(data.title ?? ''),
        genre: String(data.genre ?? ''),
        synopsis: String(data.synopsis ?? ''),
        status: data.status === 'confirmed' ? 'confirmed' : 'draft',
        createdAt: toIsoString(data.createdAt),
        updatedAt: toIsoString(data.updatedAt),
      };
    });
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function fetchFirestoreProjectDetails(
  uid: string,
  projectId: string,
  firestoreDb: Firestore = db,
  onRead?: (counts: { requests: number; returnedDocuments: number }) => void,
): Promise<{
  characters: Character[];
  worldbuilding: WorldbuildingItem[];
  episodes: Episode[];
  revisions: Revision[];
}> {
  const basePath = firestoreProjectPath(uid, projectId);

  const charPath = `${basePath}/characters`;
  const wbPath = `${basePath}/worldbuilding`;
  const counts = { requests: 0, returnedDocuments: 0 };
  const readCollection = async (path: string) => {
    counts.requests++;
    const snapshot = await getDocs(query(collection(firestoreDb, path), where('ownerId', '==', uid)));
    counts.returnedDocuments += snapshot.size;
    return snapshot;
  };

  let characters: Character[] = [];
  let worldbuilding: WorldbuildingItem[] = [];

  try {
    const snap = await readCollection(charPath);
    characters = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: String(data.id ?? d.id),
        ownerId: String(data.ownerId ?? uid),
        projectId: String(data.projectId ?? projectId),
        name: String(data.name ?? ''),
        role: String(data.role ?? ''),
        affiliation: String(data.affiliation ?? ''),
        appearance: String(data.appearance ?? ''),
        personality: String(data.personality ?? ''),
        background: String(data.background ?? ''),
        abilities: String(data.abilities ?? ''),
        status: data.status === 'confirmed' ? 'confirmed' : 'draft',
        linkedEpisodeIds: sanitizeIdArray(data.linkedEpisodeIds),
        linkedWorldbuildingIds: sanitizeIdArray(data.linkedWorldbuildingIds),
        createdAt: toIsoString(data.createdAt),
        updatedAt: toIsoString(data.updatedAt),
      };
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, charPath);
  }

  try {
    const snap = await readCollection(wbPath);
    worldbuilding = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: String(data.id ?? d.id),
        ownerId: String(data.ownerId ?? uid),
        projectId: String(data.projectId ?? projectId),
        title: String(data.title ?? ''),
        category: String(data.category ?? ''),
        summary: String(data.summary ?? ''),
        content: String(data.content ?? ''),
        rules: String(data.rules ?? ''),
        status: data.status === 'confirmed' ? 'confirmed' : 'draft',
        linkedCharacterIds: sanitizeIdArray(data.linkedCharacterIds),
        linkedEpisodeIds: sanitizeIdArray(data.linkedEpisodeIds),
        createdAt: toIsoString(data.createdAt),
        updatedAt: toIsoString(data.updatedAt),
      };
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, wbPath);
  }

  const episodes = await readProjectEpisodes(uid, projectId, readCollection);
  const revisions = await readProjectRevisions(uid, projectId, readCollection);

  onRead?.(counts);
  return { characters, worldbuilding, episodes, revisions };
}
