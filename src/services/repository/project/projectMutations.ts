import type {
  Project,
  Character,
  WorldbuildingItem,
  Episode,
  Revision,
  Scene,
  CharacterRelationship,
  TimelineEvent,
  Foreshadowing,
} from '../../../types/novel';
import { setDoc, doc, serverTimestamp, updateDoc, deleteDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../../firebase';

export async function createFirestoreProject(uid: string, project: Project): Promise<void> {
  const path = `users/${uid}/projects/${project.id}`;
  try {
    await setDoc(doc(db, path), {
      id: project.id,
      ownerId: uid,
      title: project.title,
      genre: project.genre,
      synopsis: project.synopsis,
      status: project.status,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateFirestoreProject(
  uid: string,
  projectId: string,
  updates: Pick<Project, 'title' | 'genre' | 'synopsis' | 'status'>
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}`;
  try {
    await updateDoc(doc(db, path), {
      title: updates.title,
      genre: updates.genre,
      synopsis: updates.synopsis,
      status: updates.status,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteFirestoreProjectCascade(
  uid: string,
  projectId: string,
  details: {
    characters: Character[];
    worldbuilding: WorldbuildingItem[];
    episodes: Episode[];
    revisions: Revision[];
    scenes?: Scene[];
    relationships?: CharacterRelationship[];
    timelineEvents?: TimelineEvent[];
    foreshadowings?: Foreshadowing[];
  }
): Promise<void> {
  const basePath = `users/${uid}/projects/${projectId}`;
  try {
    for (const r of details.revisions) {
      await deleteDoc(doc(db, `${basePath}/revisions/${r.id}`));
    }
    for (const e of details.episodes) {
      await deleteDoc(doc(db, `${basePath}/episodes/${e.id}`));
    }
    for (const c of details.characters) {
      await deleteDoc(doc(db, `${basePath}/characters/${c.id}`));
    }
    for (const w of details.worldbuilding) {
      await deleteDoc(doc(db, `${basePath}/worldbuilding/${w.id}`));
    }
    for (const s of details.scenes || []) {
      await deleteDoc(doc(db, `${basePath}/scenes/${s.id}`));
    }
    for (const rel of details.relationships || []) {
      await deleteDoc(doc(db, `${basePath}/relationships/${rel.id}`));
    }
    for (const evt of details.timelineEvents || []) {
      await deleteDoc(doc(db, `${basePath}/timelineEvents/${evt.id}`));
    }
    for (const fsh of details.foreshadowings || []) {
      await deleteDoc(doc(db, `${basePath}/foreshadowings/${fsh.id}`));
    }
    await deleteDoc(doc(db, basePath));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, basePath);
  }
}
