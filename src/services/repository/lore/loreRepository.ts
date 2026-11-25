import type {
  Character,
  WorldbuildingItem,
  Scene,
  ActorType,
  Foreshadowing,
  CharacterRelationship,
  TimelineEvent,
} from '../../../types/novel';
import { setDoc, doc, serverTimestamp, updateDoc, deleteDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../../firebase';
import { sanitizeIdArray } from '../../../utils/novelValidation';
import { normalizeToCanonStatus, assertCanonProtection } from '../../../utils/foundationLogic';

export async function createFirestoreCharacter(
  uid: string,
  projectId: string,
  character: Character
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/characters/${character.id}`;
  try {
    await setDoc(doc(db, path), {
      id: character.id,
      ownerId: uid,
      projectId,
      name: character.name,
      role: character.role,
      affiliation: character.affiliation,
      appearance: character.appearance,
      personality: character.personality,
      background: character.background,
      abilities: character.abilities,
      status: character.status,
      linkedEpisodeIds: sanitizeIdArray(character.linkedEpisodeIds),
      linkedWorldbuildingIds: sanitizeIdArray(character.linkedWorldbuildingIds),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateFirestoreCharacter(
  uid: string,
  projectId: string,
  character: Character
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/characters/${character.id}`;
  try {
    await updateDoc(doc(db, path), {
      name: character.name,
      role: character.role,
      affiliation: character.affiliation,
      appearance: character.appearance,
      personality: character.personality,
      background: character.background,
      abilities: character.abilities,
      status: character.status,
      linkedEpisodeIds: sanitizeIdArray(character.linkedEpisodeIds),
      linkedWorldbuildingIds: sanitizeIdArray(character.linkedWorldbuildingIds),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteFirestoreCharacter(
  uid: string,
  projectId: string,
  characterId: string
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/characters/${characterId}`;
  try {
    await deleteDoc(doc(db, path));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function createFirestoreWorldbuilding(
  uid: string,
  projectId: string,
  item: WorldbuildingItem
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/worldbuilding/${item.id}`;
  try {
    await setDoc(doc(db, path), {
      id: item.id,
      ownerId: uid,
      projectId,
      title: item.title,
      category: item.category,
      summary: item.summary,
      content: item.content,
      rules: item.rules,
      status: item.status,
      linkedCharacterIds: sanitizeIdArray(item.linkedCharacterIds),
      linkedEpisodeIds: sanitizeIdArray(item.linkedEpisodeIds),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateFirestoreWorldbuilding(
  uid: string,
  projectId: string,
  item: WorldbuildingItem
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/worldbuilding/${item.id}`;
  try {
    await updateDoc(doc(db, path), {
      title: item.title,
      category: item.category,
      summary: item.summary,
      content: item.content,
      rules: item.rules,
      status: item.status,
      linkedCharacterIds: sanitizeIdArray(item.linkedCharacterIds),
      linkedEpisodeIds: sanitizeIdArray(item.linkedEpisodeIds),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteFirestoreWorldbuilding(
  uid: string,
  projectId: string,
  itemId: string
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/worldbuilding/${itemId}`;
  try {
    await deleteDoc(doc(db, path));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function createFirestoreScene(
  uid: string,
  projectId: string,
  scene: Scene
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/scenes/${scene.id}`;
  try {
    await setDoc(doc(db, path), {
      id: scene.id,
      ownerId: uid,
      projectId,
      episodeId: scene.episodeId,
      sceneNumber: scene.sceneNumber,
      title: scene.title,
      summary: scene.summary,
      location: scene.location,
      pointOfViewCharacterId: scene.pointOfViewCharacterId || '',
      eventIds: sanitizeIdArray(scene.eventIds),
      characterIds: sanitizeIdArray(scene.characterIds),
      foreshadowingIds: sanitizeIdArray(scene.foreshadowingIds),
      canonStatus: normalizeToCanonStatus(scene.canonStatus),
      sourceRevisionId: scene.sourceRevisionId || '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateFirestoreScene(
  uid: string,
  projectId: string,
  scene: Scene,
  actor: ActorType = 'AUTHOR',
  currentCanonStatus = scene.canonStatus
): Promise<void> {
  assertCanonProtection({
    actor,
    operation: 'UPDATE',
    canonStatus: currentCanonStatus,
  });
  const path = `users/${uid}/projects/${projectId}/scenes/${scene.id}`;
  try {
    await updateDoc(doc(db, path), {
      episodeId: scene.episodeId,
      sceneNumber: scene.sceneNumber,
      title: scene.title,
      summary: scene.summary,
      location: scene.location,
      pointOfViewCharacterId: scene.pointOfViewCharacterId || '',
      eventIds: sanitizeIdArray(scene.eventIds),
      characterIds: sanitizeIdArray(scene.characterIds),
      foreshadowingIds: sanitizeIdArray(scene.foreshadowingIds),
      canonStatus: normalizeToCanonStatus(scene.canonStatus),
      sourceRevisionId: scene.sourceRevisionId || '',
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteFirestoreScene(
  uid: string,
  projectId: string,
  sceneId: string,
  actor: ActorType = 'AUTHOR',
  currentCanonStatus?: Scene['canonStatus']
): Promise<void> {
  assertCanonProtection({
    actor,
    operation: 'DELETE',
    canonStatus: currentCanonStatus,
  });
  const path = `users/${uid}/projects/${projectId}/scenes/${sceneId}`;
  try {
    await deleteDoc(doc(db, path));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function createFirestoreForeshadowing(
  uid: string,
  projectId: string,
  foreshadowing: Foreshadowing
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/foreshadowings/${foreshadowing.id}`;
  try {
    await setDoc(doc(db, path), {
      id: foreshadowing.id,
      ownerId: uid,
      projectId,
      title: foreshadowing.title,
      description: foreshadowing.description,
      cluePhase: foreshadowing.cluePhase,
      canonStatus: normalizeToCanonStatus(foreshadowing.canonStatus),
      plantedEpisodeId: foreshadowing.plantedEpisodeId || '',
      plantedSceneId: foreshadowing.plantedSceneId || '',
      resolvedEpisodeId: foreshadowing.resolvedEpisodeId || '',
      resolvedSceneId: foreshadowing.resolvedSceneId || '',
      relatedEventIds: sanitizeIdArray(foreshadowing.relatedEventIds),
      relatedCharacterIds: sanitizeIdArray(foreshadowing.relatedCharacterIds),
      sourceRevisionId: foreshadowing.sourceRevisionId || '',
      createdBy: foreshadowing.createdBy || 'AUTHOR',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateFirestoreForeshadowing(
  uid: string,
  projectId: string,
  foreshadowing: Foreshadowing,
  actor: ActorType = 'AUTHOR',
  currentCanonStatus = foreshadowing.canonStatus
): Promise<void> {
  assertCanonProtection({
    actor,
    operation: 'UPDATE',
    canonStatus: currentCanonStatus,
  });
  const path = `users/${uid}/projects/${projectId}/foreshadowings/${foreshadowing.id}`;
  try {
    await updateDoc(doc(db, path), {
      title: foreshadowing.title,
      description: foreshadowing.description,
      cluePhase: foreshadowing.cluePhase,
      canonStatus: normalizeToCanonStatus(foreshadowing.canonStatus),
      plantedEpisodeId: foreshadowing.plantedEpisodeId || '',
      plantedSceneId: foreshadowing.plantedSceneId || '',
      resolvedEpisodeId: foreshadowing.resolvedEpisodeId || '',
      resolvedSceneId: foreshadowing.resolvedSceneId || '',
      relatedEventIds: sanitizeIdArray(foreshadowing.relatedEventIds),
      relatedCharacterIds: sanitizeIdArray(foreshadowing.relatedCharacterIds),
      sourceRevisionId: foreshadowing.sourceRevisionId || '',
      createdBy: foreshadowing.createdBy || 'AUTHOR',
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteFirestoreForeshadowing(
  uid: string,
  projectId: string,
  foreshadowingId: string,
  actor: ActorType = 'AUTHOR',
  currentCanonStatus?: Foreshadowing['canonStatus']
): Promise<void> {
  assertCanonProtection({
    actor,
    operation: 'DELETE',
    canonStatus: currentCanonStatus,
  });
  const path = `users/${uid}/projects/${projectId}/foreshadowings/${foreshadowingId}`;
  try {
    await deleteDoc(doc(db, path));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function createFirestoreRelationship(
  uid: string,
  projectId: string,
  rel: CharacterRelationship
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/relationships/${rel.id}`;
  try {
    await setDoc(doc(db, path), {
      id: rel.id,
      ownerId: uid,
      projectId,
      sourceCharacterId: rel.sourceCharacterId,
      targetCharacterId: rel.targetCharacterId,
      relationType: rel.relationType,
      affinityScore: rel.affinityScore,
      isDirectional: Boolean(rel.isDirectional),
      description: rel.description,
      canonStatus: normalizeToCanonStatus(rel.canonStatus),
      effectiveEpisodeId: rel.effectiveEpisodeId || '',
      effectiveEventId: rel.effectiveEventId || '',
      sourceRevisionId: rel.sourceRevisionId || '',
      createdBy: rel.createdBy || 'AUTHOR',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateFirestoreRelationship(
  uid: string,
  projectId: string,
  rel: CharacterRelationship,
  actor: ActorType = 'AUTHOR',
  currentCanonStatus = rel.canonStatus
): Promise<void> {
  assertCanonProtection({
    actor,
    operation: 'UPDATE',
    canonStatus: currentCanonStatus,
  });
  const path = `users/${uid}/projects/${projectId}/relationships/${rel.id}`;
  try {
    await updateDoc(doc(db, path), {
      sourceCharacterId: rel.sourceCharacterId,
      targetCharacterId: rel.targetCharacterId,
      relationType: rel.relationType,
      affinityScore: rel.affinityScore,
      isDirectional: Boolean(rel.isDirectional),
      description: rel.description,
      canonStatus: normalizeToCanonStatus(rel.canonStatus),
      effectiveEpisodeId: rel.effectiveEpisodeId || '',
      effectiveEventId: rel.effectiveEventId || '',
      sourceRevisionId: rel.sourceRevisionId || '',
      createdBy: rel.createdBy || 'AUTHOR',
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteFirestoreRelationship(
  uid: string,
  projectId: string,
  relationshipId: string,
  actor: ActorType = 'AUTHOR',
  currentCanonStatus?: CharacterRelationship['canonStatus']
): Promise<void> {
  assertCanonProtection({
    actor,
    operation: 'DELETE',
    canonStatus: currentCanonStatus,
  });
  const path = `users/${uid}/projects/${projectId}/relationships/${relationshipId}`;
  try {
    await deleteDoc(doc(db, path));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function createFirestoreTimelineEvent(
  uid: string,
  projectId: string,
  event: TimelineEvent
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/timelineEvents/${event.id}`;
  try {
    await setDoc(doc(db, path), {
      id: event.id,
      ownerId: uid,
      projectId,
      title: event.title,
      summary: event.summary,
      inUniverseDate: event.inUniverseDate || '',
      chronologicalOrder: event.chronologicalOrder,
      episodeId: event.episodeId || '',
      sceneId: event.sceneId || '',
      participantCharacterIds: sanitizeIdArray(event.participantCharacterIds),
      linkedForeshadowingIds: sanitizeIdArray(event.linkedForeshadowingIds),
      linkedWorldbuildingIds: sanitizeIdArray(event.linkedWorldbuildingIds),
      canonStatus: normalizeToCanonStatus(event.canonStatus),
      sourceRevisionId: event.sourceRevisionId || '',
      createdBy: event.createdBy || 'AUTHOR',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateFirestoreTimelineEvent(
  uid: string,
  projectId: string,
  event: TimelineEvent,
  actor: ActorType = 'AUTHOR',
  currentCanonStatus = event.canonStatus
): Promise<void> {
  assertCanonProtection({
    actor,
    operation: 'UPDATE',
    canonStatus: currentCanonStatus,
  });
  const path = `users/${uid}/projects/${projectId}/timelineEvents/${event.id}`;
  try {
    await updateDoc(doc(db, path), {
      title: event.title,
      summary: event.summary,
      inUniverseDate: event.inUniverseDate || '',
      chronologicalOrder: event.chronologicalOrder,
      episodeId: event.episodeId || '',
      sceneId: event.sceneId || '',
      participantCharacterIds: sanitizeIdArray(event.participantCharacterIds),
      linkedForeshadowingIds: sanitizeIdArray(event.linkedForeshadowingIds),
      linkedWorldbuildingIds: sanitizeIdArray(event.linkedWorldbuildingIds),
      canonStatus: normalizeToCanonStatus(event.canonStatus),
      sourceRevisionId: event.sourceRevisionId || '',
      createdBy: event.createdBy || 'AUTHOR',
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteFirestoreTimelineEvent(
  uid: string,
  projectId: string,
  eventId: string,
  actor: ActorType = 'AUTHOR',
  currentCanonStatus?: TimelineEvent['canonStatus']
): Promise<void> {
  assertCanonProtection({
    actor,
    operation: 'DELETE',
    canonStatus: currentCanonStatus,
  });
  const path = `users/${uid}/projects/${projectId}/timelineEvents/${eventId}`;
  try {
    await deleteDoc(doc(db, path));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}
