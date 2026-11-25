import type {
  ProjectBundle,
  Project,
  Character,
  WorldbuildingItem,
  Episode,
  Revision,
  CanonStatus,
  ChangeProposal,
  Scene,
  CharacterRelationship,
  TimelineEvent,
  Foreshadowing,
} from '../../../types/novel';
import { generateEntityId } from '../../../utils/novelValidation';
import { assertFirestoreDocumentFits } from '../../../utils/firestoreDocumentSize';
import { newEpisodeDocument, revisionDocument } from '../episode/episodeDocuments';
import { fetchFirestoreProjects, fetchFirestoreProjectDetails } from '../project/projectQueries';
import { updateFirestoreProject, createFirestoreProject } from '../project/projectMutations';
import {
  updateFirestoreCharacter,
  createFirestoreCharacter,
  updateFirestoreWorldbuilding,
  createFirestoreWorldbuilding,
  updateFirestoreScene,
  createFirestoreScene,
  updateFirestoreRelationship,
  createFirestoreRelationship,
  updateFirestoreTimelineEvent,
  createFirestoreTimelineEvent,
  updateFirestoreForeshadowing,
  createFirestoreForeshadowing,
} from '../lore/loreRepository';
import {
  updateFirestoreEpisode,
  createFirestoreEpisode,
  createFirestoreRevision,
} from '../episode/episodeRepository';
import { fetchFirestoreFoundationCollections } from '../lore/foundationQueries';
import { createFirestoreChangeProposal } from '../proposals/changeProposalRepository';

export async function uploadProjectBundleToFirestore(
  uid: string,
  bundle: ProjectBundle
): Promise<ProjectBundle> {
  const projectId = bundle.project.id || generateEntityId('proj');
  const nowIso = new Date().toISOString();
  const project: Project = {
    ...bundle.project,
    id: projectId,
    ownerId: uid,
    createdAt: bundle.project.createdAt || nowIso,
    updatedAt: nowIso,
  };

  const basePath = `users/${uid}/projects/${projectId}`;
  for (const episode of bundle.episodes) {
    assertFirestoreDocumentFits(`${basePath}/episodes/${episode.id}`, newEpisodeDocument(uid, projectId, episode));
  }
  for (const revision of bundle.revisions) {
    assertFirestoreDocumentFits(`${basePath}/revisions/${revision.id}`, revisionDocument(uid, projectId, revision));
  }

  const existingProjects = await fetchFirestoreProjects(uid);
  const projectExists = existingProjects.some((p) => p.id === projectId);

  let existingCharIds = new Set<string>();
  let existingWbIds = new Set<string>();
  let existingEpIds = new Set<string>();
  let existingRevIds = new Set<string>();

  if (projectExists) {
    await updateFirestoreProject(uid, projectId, {
      title: project.title,
      genre: project.genre,
      synopsis: project.synopsis,
      status: project.status,
    });
    const details = await fetchFirestoreProjectDetails(uid, projectId);
    existingCharIds = new Set(details.characters.map((c) => c.id));
    existingWbIds = new Set(details.worldbuilding.map((w) => w.id));
    existingEpIds = new Set(details.episodes.map((e) => e.id));
    existingRevIds = new Set(details.revisions.map((r) => r.id));
  } else {
    await createFirestoreProject(uid, project);
  }

  const characters: Character[] = [];
  for (const ch of bundle.characters) {
    const nextChar: Character = {
      ...ch,
      ownerId: uid,
      projectId,
      createdAt: ch.createdAt || nowIso,
      updatedAt: nowIso,
    };
    if (existingCharIds.has(nextChar.id)) {
      await updateFirestoreCharacter(uid, projectId, nextChar);
    } else {
      await createFirestoreCharacter(uid, projectId, nextChar);
    }
    characters.push(nextChar);
  }

  const worldbuilding: WorldbuildingItem[] = [];
  for (const wb of bundle.worldbuilding) {
    const nextWb: WorldbuildingItem = {
      ...wb,
      ownerId: uid,
      projectId,
      createdAt: wb.createdAt || nowIso,
      updatedAt: nowIso,
    };
    if (existingWbIds.has(nextWb.id)) {
      await updateFirestoreWorldbuilding(uid, projectId, nextWb);
    } else {
      await createFirestoreWorldbuilding(uid, projectId, nextWb);
    }
    worldbuilding.push(nextWb);
  }

  const episodes: Episode[] = [];
  for (const ep of bundle.episodes) {
    const nextEp: Episode = {
      ...ep,
      ownerId: uid,
      projectId,
      createdAt: ep.createdAt || nowIso,
      updatedAt: nowIso,
    };
    if (existingEpIds.has(nextEp.id)) {
      await updateFirestoreEpisode(uid, projectId, nextEp);
    } else {
      await createFirestoreEpisode(uid, projectId, nextEp);
    }
    episodes.push(nextEp);
  }

  const revisions: Revision[] = [];
  for (const rev of bundle.revisions) {
    const nextRev: Revision = {
      ...rev,
      ownerId: uid,
      projectId,
      createdAt: rev.createdAt || nowIso,
    };
    if (!existingRevIds.has(nextRev.id)) {
      await createFirestoreRevision(uid, projectId, nextRev);
    }
    revisions.push(nextRev);
  }

  let existingSceneIds = new Set<string>();
  let existingRelMap = new Map<string, CanonStatus>();
  let existingEvtMap = new Map<string, CanonStatus>();
  let existingFshMap = new Map<string, CanonStatus>();
  let existingProposalMap = new Map<string, ChangeProposal>();

  if (projectExists) {
    const existingFoundation = await fetchFirestoreFoundationCollections(uid, projectId);
    existingSceneIds = new Set(existingFoundation.scenes.map((s) => s.id));
    existingRelMap = new Map(existingFoundation.relationships.map((r) => [r.id, r.canonStatus]));
    existingEvtMap = new Map(existingFoundation.timelineEvents.map((e) => [e.id, e.canonStatus]));
    existingFshMap = new Map(existingFoundation.foreshadowings.map((f) => [f.id, f.canonStatus]));
    existingProposalMap = new Map(existingFoundation.changeProposals.map((p) => [p.id, p]));
  }

  const scenes: Scene[] = [];
  for (const sc of bundle.scenes || []) {
    const nextScene: Scene = {
      ...sc,
      ownerId: uid,
      projectId,
      createdAt: sc.createdAt || nowIso,
      updatedAt: nowIso,
    };
    if (existingSceneIds.has(nextScene.id)) {
      await updateFirestoreScene(uid, projectId, nextScene, 'AUTHOR');
    } else {
      await createFirestoreScene(uid, projectId, nextScene);
    }
    scenes.push(nextScene);
  }

  const relationships: CharacterRelationship[] = [];
  for (const rel of bundle.relationships || []) {
    const nextRel: CharacterRelationship = {
      ...rel,
      ownerId: uid,
      projectId,
      createdAt: rel.createdAt || nowIso,
      updatedAt: nowIso,
    };
    if (existingRelMap.has(nextRel.id)) {
      await updateFirestoreRelationship(
        uid,
        projectId,
        nextRel,
        'AUTHOR',
        existingRelMap.get(nextRel.id)
      );
    } else {
      await createFirestoreRelationship(uid, projectId, nextRel);
    }
    relationships.push(nextRel);
  }

  const timelineEvents: TimelineEvent[] = [];
  for (const evt of bundle.timelineEvents || []) {
    const nextEvt: TimelineEvent = {
      ...evt,
      ownerId: uid,
      projectId,
      createdAt: evt.createdAt || nowIso,
      updatedAt: nowIso,
    };
    if (existingEvtMap.has(nextEvt.id)) {
      await updateFirestoreTimelineEvent(
        uid,
        projectId,
        nextEvt,
        'AUTHOR',
        existingEvtMap.get(nextEvt.id)
      );
    } else {
      await createFirestoreTimelineEvent(uid, projectId, nextEvt);
    }
    timelineEvents.push(nextEvt);
  }

  const foreshadowings: Foreshadowing[] = [];
  for (const fsh of bundle.foreshadowings || []) {
    const nextFsh: Foreshadowing = {
      ...fsh,
      ownerId: uid,
      projectId,
      createdAt: fsh.createdAt || nowIso,
      updatedAt: nowIso,
    };
    if (existingFshMap.has(nextFsh.id)) {
      await updateFirestoreForeshadowing(
        uid,
        projectId,
        nextFsh,
        'AUTHOR',
        existingFshMap.get(nextFsh.id)
      );
    } else {
      await createFirestoreForeshadowing(uid, projectId, nextFsh);
    }
    foreshadowings.push(nextFsh);
  }

  const changeProposals: ChangeProposal[] = [];
  for (const prop of bundle.changeProposals || []) {
    const existingProp = existingProposalMap.get(prop.id);
    if (existingProp) {
      // Preserve existing proposal's immutable createdAt, ownerId, projectId, sourceRevisionId, and createdBy
      changeProposals.push(existingProp);
    } else {
      const nextProp: ChangeProposal = {
        ...prop,
        ownerId: uid,
        projectId,
        createdAt: prop.createdAt || nowIso,
        updatedAt: prop.updatedAt || nowIso,
      };
      await createFirestoreChangeProposal(uid, projectId, nextProp);
      changeProposals.push(nextProp);
    }
  }

  return {
    formatVersion: bundle.formatVersion === '1.5' ? '1.5' : '1.0',
    exportedAt: nowIso,
    project,
    characters,
    worldbuilding,
    episodes,
    revisions,
    scenes,
    foreshadowings,
    relationships,
    timelineEvents,
    memoryDocuments: bundle.memoryDocuments,
    memoryChunks: bundle.memoryChunks,
    styleProfiles: bundle.styleProfiles,
    changeProposals,
    writingPromptProfiles: bundle.writingPromptProfiles,
    writingPlans: bundle.writingPlans,
  };
}
