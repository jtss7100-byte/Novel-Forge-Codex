import type { DocumentData, Firestore, Transaction } from 'firebase-admin/firestore';
import type { MemoryChunk, MemoryDocument, CharacterRelationship, Foreshadowing, Scene, TimelineEvent } from '../types/foundation';
import type { Character, Episode, WorldbuildingItem } from '../types/novel';
import type { ScenePlanItem } from '../types/aiEngine';
import type { SceneMemoryKnowledge } from '../types/sceneMemory';
import { buildMemoryIndexInputFromApprovedEntity, extractProjectMemoryIndexInputs, type MemoryIndexInput } from '../services/memorySearchProvider';
import { safeMemoryId, type VerifiedMemorySource } from '../utils/sceneMemoryLogic';
import type { FirestoreRagManifestDoc } from './ragEngine';

const entityCollections = {
  EPISODE: 'episodes', EPISODE_SUMMARY: 'episodes', CHARACTER: 'characters', WORLDBUILDING: 'worldbuilding',
  TIMELINE_EVENT: 'timelineEvents', SCENE: 'scenes', FORESHADOWING: 'foreshadowings', RELATIONSHIP: 'relationships',
} as const;
export const idList = (value: unknown, limit = 12): string[] => Array.isArray(value) ? [...new Set(value.filter(safeMemoryId))].slice(0, limit) : [];
export const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
export const episodePosition = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
export const scopedCollection = (type: string) => Object.hasOwn(entityCollections, type) ? entityCollections[type as keyof typeof entityCollections] : undefined;
export const isCanon = (record: DocumentData | undefined) => record?.canonStatus === 'CANON' || (record?.canonStatus === undefined && record?.status === 'confirmed');

function knowledgeAnnotations(raw: unknown): SceneMemoryKnowledge | undefined {
  if (!raw || typeof raw !== 'object' || !('scope' in raw) ||
      (raw.scope !== 'PUBLIC' && raw.scope !== 'AUTHOR_ONLY' && raw.scope !== 'CHARACTERS')) return undefined;
  return {
    scope: raw.scope, characterIds: 'characterIds' in raw ? idList(raw.characterIds) : [],
    authorImportance: 'authorImportance' in raw ? finite(raw.authorImportance) : undefined,
    effectiveEventId: 'effectiveEventId' in raw && safeMemoryId(raw.effectiveEventId) ? raw.effectiveEventId : undefined,
    timeless: 'timeless' in raw && raw.timeless === true,
  };
}

export function generationStatus(ownerId: string, projectId: string, manifest: FirestoreRagManifestDoc | undefined,
  chunk: MemoryChunk, document: MemoryDocument): 'ACTIVE' | 'RETIRED' | 'DELETED' | 'UNKNOWN' {
  if (!manifest || manifest.ownerId !== ownerId || manifest.projectId !== projectId) return 'UNKNOWN';
  if (manifest.projectLifecycleStatus === 'DELETED' || manifest.projectLifecycleStatus === 'PENDING_DELETE') return 'DELETED';
  const key = `${ownerId}:${projectId}:${chunk.sourceEntityType}:${chunk.sourceEntityId}`;
  const active = manifest.entityStates?.[key];
  const generation = chunk.indexGeneration;
  const scope = `${chunk.sourceEntityType}:${chunk.sourceEntityId}`;
  const deletion = manifest.entityDeletionStates?.[scope] ?? manifest.pendingDeletes?.[`ENTITY:${scope}`];
  if (active?.lifecycleStatus === 'DELETED' || active?.lifecycleStatus === 'PENDING_DELETE' ||
      (deletion && (deletion.status !== 'DELETED' || deletion.tombstoneGeneration >= (generation ?? 0)))) return 'DELETED';
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1 ||
      document.indexGeneration !== generation) return 'UNKNOWN';
  const retired = manifest.retiredGenerationsByEntity?.[key];
  if (generation <= (retired?.retiredThroughGen ?? 0) || retired?.retiredGens.includes(generation) ||
      manifest.cleanupClaims?.[`${key}::g${generation}`] || generation <= manifest.projectTombstoneGeneration) return 'RETIRED';
  if (manifest.projectLifecycleStatus !== 'ACTIVE' || !active?.activeDocumentIds?.length || !active.activeGeneration ||
      (active.lifecycleStatus !== 'ACTIVE' && active.lifecycleStatus !== 'REINDEXING_KEEP_OLD')) return 'UNKNOWN';
  if (active.ownerId !== ownerId || active.projectId !== projectId ||
      active.sourceEntityId !== chunk.sourceEntityId || active.sourceEntityType !== chunk.sourceEntityType) return 'UNKNOWN';
  if (active.activeGeneration !== generation || !active.activeDocumentIds.includes(document.id)) return 'RETIRED';
  if (active.activeRevisionId !== chunk.sourceRevisionId || active.activeContentHash !== document.contentHash) return 'UNKNOWN';
  if (active.activationMode !== 'MANIFEST_POINTER' && (chunk.isActiveGeneration !== true || document.isActiveGeneration !== true)) return 'RETIRED';
  return 'ACTIVE';
}

type CloudSource = { record: DocumentData; exists: boolean };
export function makeSourceReader(db: Firestore, ownerId: string, projectId: string, tx?: Transaction) {
  const base = `users/${ownerId}/projects/${projectId}`;
  // Small lookups are shared across scenes. The final chunk, parent and manifest reads remain fresh.
  const records = new Map<string, CloudSource>();
  async function batch(paths: string[]) {
    const missing = [...new Set(paths)].filter((path) => !records.has(path));
    if (!missing.length) return;
    for (let index = 0; index < missing.length; index += 80) {
      const slice = missing.slice(index, index + 80);
      const refs = slice.map((path) => db.doc(`${base}/${path}`));
      const snapshots = await (tx ? tx.getAll(...refs) : db.getAll(...refs));
      snapshots.forEach((snap) => records.set(snap.ref.path.slice(base.length + 1), { exists: snap.exists, record: snap.data() ?? {} }));
    }
  }
  async function entity(collection: string, id: unknown) {
    if (!safeMemoryId(id)) return undefined;
    const path = `${collection}/${id}`;
    await batch([path]);
    const source = records.get(path);
    return source?.exists && source.record.id === id && source.record.ownerId === ownerId && source.record.projectId === projectId
      ? source.record : undefined;
  }
  return { base, batch, entity, records };
}

function deriveText(input: { ownerId: string; projectId: string; type: string; record: DocumentData; episode?: Episode; names: Record<string, string> }) {
  const { ownerId, projectId, type, record, episode, names } = input;
  let inputs: MemoryIndexInput[];
  if (type === 'RELATIONSHIP' || type === 'TIMELINE_EVENT' || type === 'FORESHADOWING') {
    return [
      buildMemoryIndexInputFromApprovedEntity({ ownerId, projectId, targetEntityType: type,
        entity: record as CharacterRelationship | TimelineEvent | Foreshadowing, characterNameMap: names }),
      ...(type === 'RELATIONSHIP' ? [buildMemoryIndexInputFromApprovedEntity({
        ownerId, projectId, targetEntityType: type, entity: record as CharacterRelationship,
      })] : []),
    ].filter((entry): entry is MemoryIndexInput => Boolean(entry));
  }
  inputs = extractProjectMemoryIndexInputs({
    ownerId, projectId, includeDrafts: false,
    characters: type === 'CHARACTER' ? [record as Character] : [],
    worldbuilding: type === 'WORLDBUILDING' ? [record as WorldbuildingItem] : [],
    episodes: episode ? [episode] : [],
    scenes: type === 'SCENE' ? [record as Scene] : [],
  });
  return inputs.filter((entry) => entry.sourceEntityType === type);
}

export async function buildVerifiedSource(chunk: { sourceEntityId: string; sourceEntityType: string }, sourceReader: ReturnType<typeof makeSourceReader>,
  ownerId: string, projectId: string, scene?: ScenePlanItem, pov?: string): Promise<VerifiedMemorySource | undefined> {
  const collection = scopedCollection(chunk.sourceEntityType);
  if (!collection) return undefined;
  const record = await sourceReader.entity(collection, chunk.sourceEntityId);
  if (!record || !isCanon(record)) return undefined;
  const type = chunk.sourceEntityType;
  const isEpisode = type === 'EPISODE' || type === 'EPISODE_SUMMARY';
  const episodeId = isEpisode ? record.id : record.episodeId ?? record.plantedEpisodeId ?? record.effectiveEpisodeId;
  const episode = (isEpisode ? record : await sourceReader.entity('episodes', episodeId)) as Episode | undefined;
  const revisionId = isEpisode ? record.latestRevisionId : record.sourceRevisionId;
  if (!safeMemoryId(revisionId)) return undefined;
  const revision = await sourceReader.entity('revisions', revisionId);
  // Source-associated manuscript must be tied to an actual immutable Revision of its episode.
  if ((episodeId || isEpisode) && (!episode || (!isCanon(episode) && type !== 'SCENE' && type !== 'TIMELINE_EVENT') || !revision || revision.episodeId !== episodeId)) return undefined;
  if (isEpisode && (typeof revision?.content !== 'string' || revision.content !== episode?.content)) return undefined;
  const names: Record<string, string> = {};
  if (type === 'RELATIONSHIP') {
    const pair = idList([record.sourceCharacterId, record.targetCharacterId]);
    await sourceReader.batch(pair.map((id) => `characters/${id}`));
    for (const id of pair) {
      const character = await sourceReader.entity('characters', id);
      if (typeof character?.name === 'string') names[id] = character.name;
    }
  }
  const inputs = deriveText({ ownerId, projectId, type, record, episode, names });
  const [first] = inputs;
  if (!first || first.sourceRevisionId !== revisionId) return undefined;
  const legacyKnowledge = knowledgeAnnotations(record.memoryKnowledge);
  let knowledge = legacyKnowledge;
  const qualifiedId = `${type}:${record.id}`;
  const sceneScoped = Boolean(pov && scene?.memory?.povKnownSources?.slice(0, 12).includes(qualifiedId));
  if (!knowledge && pov && sceneScoped) {
    knowledge = { scope: 'CHARACTERS', characterIds: [pov] };
  }
  const effectiveEvent = await sourceReader.entity('timelineEvents', knowledge?.effectiveEventId ?? record.effectiveEventId);
  const declaredOrder = effectiveEvent && isCanon(effectiveEvent) ? finite(effectiveEvent.chronologicalOrder) : undefined;
  const linkedScene = type === 'SCENE' ? record : await sourceReader.entity('scenes', type === 'FORESHADOWING' ? record.plantedSceneId : record.sceneId);
  const sceneNumber = linkedScene && isCanon(linkedScene) && linkedScene.episodeId === episodeId && linkedScene.sourceRevisionId === revisionId
    ? episodePosition(linkedScene.sceneNumber) : undefined;
  const orderForScene = async (row?: DocumentData) => {
    if (!row || !isCanon(row)) return undefined;
    const events = await Promise.all(idList(row.eventIds, 6).map((eventId) => sourceReader.entity('timelineEvents', eventId)));
    const orders = events.map((item) => item && isCanon(item) && item.sceneId === row.id ? finite(item.chronologicalOrder) : undefined);
    return orders.length && orders.every((order): order is number => order !== undefined) ? Math.max(...orders) : undefined;
  };
  const narrativeOrder = type === 'TIMELINE_EVENT' ? finite(record.chronologicalOrder) : declaredOrder ?? await orderForScene(linkedScene);
  const resolvedEpisode = type === 'FORESHADOWING' ? await sourceReader.entity('episodes', record.resolvedEpisodeId) : undefined;
  const resolvedScene = type === 'FORESHADOWING' ? await sourceReader.entity('scenes', record.resolvedSceneId) : undefined;
  const phase = ['PLANTED', 'REINFORCED', 'RESOLVED', 'ABANDONED'].find((value) => value === record.cluePhase) as Foreshadowing['cluePhase'] | undefined;
  if (type === 'FORESHADOWING' && !phase) return undefined;
  return {
    id: record.id, ownerId, projectId, canonStatus: 'CANON', revisionId,
    episodeId: episode?.id,
    sceneId: (type === 'SCENE' ? record.id : record.sceneId ?? record.plantedSceneId) || undefined,
    texts: inputs.flatMap((entry) => typeof entry.fullText === 'string' ? [entry.fullText] : []),
    episodeNumber: episodePosition(episode?.episodeNumber), narrativeOrder, knowledge, legacyKnowledge,
    sceneNumber, legacySceneScoped: sceneScoped,
    foreshadowingPhase: phase, resolvedEpisodeNumber: isCanon(resolvedEpisode) ? episodePosition(resolvedEpisode?.episodeNumber) : undefined,
    resolvedOrder: await orderForScene(resolvedScene), characterIds: idList(first.characterIds),
    eventIds: idList(first.relatedEventIds), foreshadowingIds: idList(first.foreshadowingIds),
  };
}
