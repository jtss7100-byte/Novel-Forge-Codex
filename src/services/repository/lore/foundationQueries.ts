import { firestoreProjectPath } from '../core/projectPath';
import type {
  AdvancedFoundationCollections,
  Scene,
  Foreshadowing,
  CharacterRelationship,
  TimelineEvent,
  MemoryDocument,
  MemoryChunk,
  StyleProfile,
  ChangeProposal,
} from '../../../types/novel';
import { getDocs, query, collection, where } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../../firebase';
import { sanitizeIdArray } from '../../../utils/novelValidation';
import { normalizeToCanonStatus, sanitizeStringTags } from '../../../utils/foundationLogic';
import { toIsoString } from '../core/firestoreTimestamp';

export async function fetchFirestoreFoundationCollections(
  uid: string,
  projectId: string
): Promise<Required<AdvancedFoundationCollections>> {
  const basePath = firestoreProjectPath(uid, projectId);

  const scenes: Scene[] = [];
  const foreshadowings: Foreshadowing[] = [];
  const relationships: CharacterRelationship[] = [];
  const timelineEvents: TimelineEvent[] = [];
  const memoryDocuments: MemoryDocument[] = [];
  const memoryChunks: MemoryChunk[] = [];
  const styleProfiles: StyleProfile[] = [];
  const changeProposals: ChangeProposal[] = [];

  try {
    const snap = await getDocs(
      query(collection(db, `${basePath}/scenes`), where('ownerId', '==', uid))
    );
    for (const d of snap.docs) {
      const data = d.data();
      scenes.push({
        id: String(data.id ?? d.id),
        ownerId: String(data.ownerId ?? uid),
        projectId: String(data.projectId ?? projectId),
        episodeId: String(data.episodeId ?? ''),
        sceneNumber: Number(data.sceneNumber ?? 1),
        title: String(data.title ?? ''),
        summary: String(data.summary ?? ''),
        location: String(data.location ?? ''),
        pointOfViewCharacterId: String(data.pointOfViewCharacterId ?? ''),
        eventIds: sanitizeIdArray(data.eventIds),
        characterIds: sanitizeIdArray(data.characterIds),
        foreshadowingIds: sanitizeIdArray(data.foreshadowingIds),
        canonStatus: normalizeToCanonStatus(data.canonStatus),
        sourceRevisionId: String(data.sourceRevisionId ?? ''),
        createdAt: toIsoString(data.createdAt),
        updatedAt: toIsoString(data.updatedAt),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, `${basePath}/scenes`);
  }

  try {
    const snap = await getDocs(
      query(collection(db, `${basePath}/foreshadowings`), where('ownerId', '==', uid))
    );
    for (const d of snap.docs) {
      const data = d.data();
      foreshadowings.push({
        id: String(data.id ?? d.id),
        ownerId: String(data.ownerId ?? uid),
        projectId: String(data.projectId ?? projectId),
        title: String(data.title ?? ''),
        description: String(data.description ?? ''),
        cluePhase:
          data.cluePhase === 'REINFORCED' ||
          data.cluePhase === 'RESOLVED' ||
          data.cluePhase === 'ABANDONED'
            ? data.cluePhase
            : 'PLANTED',
        canonStatus: normalizeToCanonStatus(data.canonStatus),
        plantedEpisodeId: String(data.plantedEpisodeId ?? ''),
        plantedSceneId: String(data.plantedSceneId ?? ''),
        resolvedEpisodeId: String(data.resolvedEpisodeId ?? ''),
        resolvedSceneId: String(data.resolvedSceneId ?? ''),
        relatedEventIds: sanitizeIdArray(data.relatedEventIds),
        relatedCharacterIds: sanitizeIdArray(data.relatedCharacterIds),
        sourceRevisionId: String(data.sourceRevisionId ?? ''),
        createdBy:
          data.createdBy === 'AI_ENGINE' || data.createdBy === 'SYSTEM'
            ? data.createdBy
            : 'AUTHOR',
        createdAt: toIsoString(data.createdAt),
        updatedAt: toIsoString(data.updatedAt),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, `${basePath}/foreshadowings`);
  }

  try {
    const snap = await getDocs(
      query(collection(db, `${basePath}/relationships`), where('ownerId', '==', uid))
    );
    for (const d of snap.docs) {
      const data = d.data();
      relationships.push({
        id: String(data.id ?? d.id),
        ownerId: String(data.ownerId ?? uid),
        projectId: String(data.projectId ?? projectId),
        sourceCharacterId: String(data.sourceCharacterId ?? ''),
        targetCharacterId: String(data.targetCharacterId ?? ''),
        relationType: String(data.relationType ?? ''),
        affinityScore: Number(data.affinityScore ?? 0),
        isDirectional: Boolean(data.isDirectional),
        description: String(data.description ?? ''),
        canonStatus: normalizeToCanonStatus(data.canonStatus),
        effectiveEpisodeId: String(data.effectiveEpisodeId ?? ''),
        effectiveEventId: String(data.effectiveEventId ?? ''),
        sourceRevisionId: String(data.sourceRevisionId ?? ''),
        createdBy:
          data.createdBy === 'AI_ENGINE' || data.createdBy === 'SYSTEM'
            ? data.createdBy
            : 'AUTHOR',
        createdAt: toIsoString(data.createdAt),
        updatedAt: toIsoString(data.updatedAt),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, `${basePath}/relationships`);
  }

  try {
    const snap = await getDocs(
      query(collection(db, `${basePath}/timelineEvents`), where('ownerId', '==', uid))
    );
    for (const d of snap.docs) {
      const data = d.data();
      timelineEvents.push({
        id: String(data.id ?? d.id),
        ownerId: String(data.ownerId ?? uid),
        projectId: String(data.projectId ?? projectId),
        title: String(data.title ?? ''),
        summary: String(data.summary ?? ''),
        inUniverseDate: String(data.inUniverseDate ?? ''),
        chronologicalOrder: Number(data.chronologicalOrder ?? 0),
        episodeId: String(data.episodeId ?? ''),
        sceneId: String(data.sceneId ?? ''),
        participantCharacterIds: sanitizeIdArray(data.participantCharacterIds),
        linkedForeshadowingIds: sanitizeIdArray(data.linkedForeshadowingIds),
        linkedWorldbuildingIds: sanitizeIdArray(data.linkedWorldbuildingIds),
        canonStatus: normalizeToCanonStatus(data.canonStatus),
        sourceRevisionId: String(data.sourceRevisionId ?? ''),
        createdBy:
          data.createdBy === 'AI_ENGINE' || data.createdBy === 'SYSTEM'
            ? data.createdBy
            : 'AUTHOR',
        createdAt: toIsoString(data.createdAt),
        updatedAt: toIsoString(data.updatedAt),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, `${basePath}/timelineEvents`);
  }

  try {
    const snap = await getDocs(
      query(collection(db, `${basePath}/styleProfiles`), where('ownerId', '==', uid))
    );
    for (const d of snap.docs) {
      const data = d.data();
      styleProfiles.push({
        id: String(data.id ?? d.id),
        ownerId: String(data.ownerId ?? uid),
        projectId: String(data.projectId ?? projectId),
        name: String(data.name ?? ''),
        narrativePerspective:
          data.narrativePerspective === 'FIRST_PERSON' ||
          data.narrativePerspective === 'OMNISCIENT' ||
          data.narrativePerspective === 'MIXED'
            ? data.narrativePerspective
            : 'THIRD_LIMITED',
        dialogueRatio: Number(data.dialogueRatio ?? 0),
        avgSentenceLength: Number(data.avgSentenceLength ?? 0),
        toneKeywords: sanitizeStringTags(data.toneKeywords),
        preferredExpressions: sanitizeStringTags(data.preferredExpressions),
        prohibitedExpressions: sanitizeStringTags(data.prohibitedExpressions),
        sampleExcerpt: String(data.sampleExcerpt ?? ''),
        canonStatus: normalizeToCanonStatus(data.canonStatus),
        sourceRevisionId: String(data.sourceRevisionId ?? ''),
        createdAt: toIsoString(data.createdAt),
        updatedAt: toIsoString(data.updatedAt),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, `${basePath}/styleProfiles`);
  }

  try {
    const snap = await getDocs(
      query(collection(db, `${basePath}/changeProposals`), where('ownerId', '==', uid))
    );
    for (const d of snap.docs) {
      const data = d.data();
      changeProposals.push({
        id: String(data.id ?? d.id),
        ownerId: String(data.ownerId ?? uid),
        projectId: String(data.projectId ?? projectId),
        targetEntityType:
          data.targetEntityType === 'WORLDBUILDING' ||
          data.targetEntityType === 'EPISODE' ||
          data.targetEntityType === 'SCENE' ||
          data.targetEntityType === 'FORESHADOWING' ||
          data.targetEntityType === 'RELATIONSHIP' ||
          data.targetEntityType === 'TIMELINE_EVENT' ||
          data.targetEntityType === 'STYLE_PROFILE'
            ? data.targetEntityType
            : 'CHARACTER',
        targetEntityId: String(data.targetEntityId ?? ''),
        proposedAction:
          data.proposedAction === 'CREATE' || data.proposedAction === 'ARCHIVE'
            ? data.proposedAction
            : 'UPDATE',
        title: String(data.title ?? ''),
        rationale: String(data.rationale ?? ''),
        beforeSummary: String(data.beforeSummary ?? ''),
        afterSummary: String(data.afterSummary ?? ''),
        proposedPayloadJson: String(data.proposedPayloadJson ?? '{}'),
        canonStatus: normalizeToCanonStatus(data.canonStatus),
        triggerEpisodeId: String(data.triggerEpisodeId ?? ''),
        triggerSceneId: String(data.triggerSceneId ?? ''),
        sourceRevisionId: String(data.sourceRevisionId ?? ''),
        createdBy:
          data.createdBy === 'AUTHOR' || data.createdBy === 'SYSTEM'
            ? data.createdBy
            : 'AI_ENGINE',
        reviewedAt: String(data.reviewedAt ?? ''),
        createdAt: toIsoString(data.createdAt),
        updatedAt: toIsoString(data.updatedAt),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, `${basePath}/changeProposals`);
  }

  return {
    scenes,
    foreshadowings,
    relationships,
    timelineEvents,
    memoryDocuments,
    memoryChunks,
    styleProfiles,
    changeProposals,
  };
}
