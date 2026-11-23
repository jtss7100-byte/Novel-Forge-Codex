import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  type Firestore,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { computeManuscriptContentHash } from '../utils/manuscriptIntegrity';
import type {
  PersistChangeProposalsOptions,
  PersistChangeProposalsResult,
  PersistedProposalItemResult,
  ProposalImmutablePayload,
  ProposalLookupStatus,
  ProposalPersistenceErrorCode,
} from '../types/literaryRewriting';
import type {
  ActorType,
  AdvancedFoundationCollections,
  CanonStatus,
  ChangeProposal,
  Character,
  CharacterRelationship,
  EmergencyDraftBackup,
  Episode,
  Foreshadowing,
  MemoryChunk,
  MemoryDocument,
  Project,
  ProjectBundle,
  PromptProfile,
  PromptProfileCasErrorCode,
  PromptProfileCasResult,
  Revision,
  Scene,
  StyleApprovalConflictDetails,
  StyleApprovalPayload,
  StyleApprovalPersistenceStatus,
  StyleProfile,
  StyleProfileApplicationResult,
  TimelineEvent,
  WorldbuildingItem,
  WritingPlan,
} from '../types/novel';
import {
  buildApprovedStyleProfilesForPersistence,
  buildStyleApplicationResult,
  extractStylePromptMetadata,
} from '../utils/authorStyleLogic';
import type { ChangeProposalApprovalAudit } from '../types/changeProposalApproval';
import {
  calculateCharCounts,
  generateEntityId,
  sanitizeIdArray,
} from '../utils/novelLogic';
import {
  assertCanonProtection,
  isValidCanonStatus,
  normalizeToCanonStatus,
  sanitizeStringTags,
} from '../utils/foundationLogic';
import {
  createInitialPromptProfiles,
  ensureMasterWritingRulesRegistered,
} from '../utils/aiEngineLogic';
import { createInitialSeedBundle } from '../utils/seedData';

export const LOCAL_BUNDLES_KEY = 'novelforge_local_bundles_v1';
const EMERGENCY_PREFIX = 'novelforge_emergency_draft_';

function toIsoString(val: unknown): string {
  if (val instanceof Timestamp) {
    return val.toDate().toISOString();
  }
  if (val && typeof val === 'object' && 'seconds' in val && typeof (val as { seconds: number }).seconds === 'number') {
    return new Date((val as { seconds: number }).seconds * 1000).toISOString();
  }
  if (typeof val === 'string' && val.length > 0) {
    return val;
  }
  return new Date().toISOString();
}

// ============================================================================
// Emergency Crash / Error Draft Recovery (LocalStorage Buffer)
// ============================================================================

export function saveEmergencyDraft(backup: EmergencyDraftBackup): void {
  try {
    const key = `${EMERGENCY_PREFIX}${backup.projectId}_${backup.episodeId}`;
    localStorage.setItem(key, JSON.stringify(backup));
  } catch (err) {
    console.warn('Emergency draft buffer save warning:', err);
  }
}

export function getEmergencyDraft(
  projectId: string,
  episodeId: string
): EmergencyDraftBackup | null {
  try {
    const key = `${EMERGENCY_PREFIX}${projectId}_${episodeId}`;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as EmergencyDraftBackup;
  } catch {
    return null;
  }
}

export function clearEmergencyDraft(projectId: string, episodeId: string): void {
  try {
    const key = `${EMERGENCY_PREFIX}${projectId}_${episodeId}`;
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function listAllEmergencyDrafts(): EmergencyDraftBackup[] {
  const result: EmergencyDraftBackup[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(EMERGENCY_PREFIX)) {
        const raw = localStorage.getItem(k);
        if (raw) {
          result.push(JSON.parse(raw) as EmergencyDraftBackup);
        }
      }
    }
  } catch {
    // ignore
  }
  return result;
}

// ============================================================================
// Local Persistent Store (Browser Persistence + Seed Initialization)
// ============================================================================

export function loadLocalBundles(ownerId = 'local_author'): ProjectBundle[] {
  try {
    const raw = localStorage.getItem(LOCAL_BUNDLES_KEY);
    if (!raw) {
      const initial = [createInitialSeedBundle(ownerId)];
      localStorage.setItem(LOCAL_BUNDLES_KEY, JSON.stringify(initial));
      return initial;
    }
    const parsed = JSON.parse(raw) as ProjectBundle[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      const initial = [createInitialSeedBundle(ownerId)];
      localStorage.setItem(LOCAL_BUNDLES_KEY, JSON.stringify(initial));
      return initial;
    }
    // Non-destructively ensure each existing project bundle has default prompt profiles if none exist yet,
    // and upgrade legacy placeholder content on the Advanced Writing Control Rules slot to Rules 1~10.
    const migrated = parsed.map((b) => {
      const baseProfiles =
        Array.isArray(b.writingPromptProfiles) && b.writingPromptProfiles.length > 0
          ? b.writingPromptProfiles.map((p) => {
              if (
                p.promptType === 'CORE_WRITING_RULES' &&
                p.content.includes('[기본 테스트 지침 — 작가가 전용 프롬프트를 등록하면 즉시 교체됩니다]')
              ) {
                const defaults = createInitialPromptProfiles(
                  b.project.ownerId || ownerId,
                  b.project.id
                );
                const freshCore = defaults.find((d) => d.promptType === 'CORE_WRITING_RULES');
                return freshCore ? { ...p, content: freshCore.content, description: freshCore.description } : p;
              }
              return p;
            })
          : createInitialPromptProfiles(b.project.ownerId || ownerId, b.project.id);

      const seedFallback =
        b.project?.id === 'proj_abyss_chronicle'
          ? createInitialSeedBundle(b.project.ownerId || ownerId)
          : null;

      return {
        ...b,
        writingPromptProfiles: baseProfiles,
        writingPlans: Array.isArray(b.writingPlans) ? b.writingPlans : [],
        changeProposals:
          Array.isArray(b.changeProposals) && b.changeProposals.length > 0
            ? b.changeProposals
            : seedFallback?.changeProposals || [],
        approvalAudits: Array.isArray(b.approvalAudits) ? b.approvalAudits : [],
        scenes: Array.isArray(b.scenes)
          ? b.scenes
          : seedFallback?.scenes || [],
        relationships: Array.isArray(b.relationships)
          ? b.relationships
          : seedFallback?.relationships || [],
        timelineEvents: Array.isArray(b.timelineEvents)
          ? b.timelineEvents
          : seedFallback?.timelineEvents || [],
        foreshadowings: Array.isArray(b.foreshadowings)
          ? b.foreshadowings
          : seedFallback?.foreshadowings || [],
      };
    });
    return migrated;
  } catch {
    return [createInitialSeedBundle(ownerId)];
  }
}

export function saveLocalBundles(bundles: ProjectBundle[]): void {
  localStorage.setItem(LOCAL_BUNDLES_KEY, JSON.stringify(bundles));
}

// ============================================================================
// Firestore Cloud Persistence Operations (users/{uid}/projects/{projectId}/...)
// ============================================================================

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
  projectId: string
): Promise<{
  characters: Character[];
  worldbuilding: WorldbuildingItem[];
  episodes: Episode[];
  revisions: Revision[];
}> {
  const basePath = `users/${uid}/projects/${projectId}`;

  const charPath = `${basePath}/characters`;
  const wbPath = `${basePath}/worldbuilding`;
  const epPath = `${basePath}/episodes`;
  const revPath = `${basePath}/revisions`;

  let characters: Character[] = [];
  let worldbuilding: WorldbuildingItem[] = [];
  let episodes: Episode[] = [];
  let revisions: Revision[] = [];

  try {
    const snap = await getDocs(query(collection(db, charPath), where('ownerId', '==', uid)));
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
    const snap = await getDocs(query(collection(db, wbPath), where('ownerId', '==', uid)));
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

  try {
    const snap = await getDocs(query(collection(db, epPath), where('ownerId', '==', uid)));
    episodes = snap.docs
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
    handleFirestoreError(error, OperationType.LIST, epPath);
  }

  try {
    const snap = await getDocs(query(collection(db, revPath), where('ownerId', '==', uid)));
    revisions = snap.docs
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
    handleFirestoreError(error, OperationType.LIST, revPath);
  }

  return { characters, worldbuilding, episodes, revisions };
}

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

export async function createFirestoreEpisode(
  uid: string,
  projectId: string,
  episode: Episode
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/episodes/${episode.id}`;
  const counts = calculateCharCounts(episode.content);
  const contentHash = computeManuscriptContentHash(episode.content);
  try {
    await setDoc(doc(db, path), {
      id: episode.id,
      ownerId: uid,
      projectId,
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
      latestRevisionId:
        typeof episode.latestRevisionId === 'string' ? episode.latestRevisionId.trim() : '',
      contentHash,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateFirestoreEpisode(
  uid: string,
  projectId: string,
  episode: Episode
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/episodes/${episode.id}`;
  const counts = calculateCharCounts(episode.content);
  const contentHash = computeManuscriptContentHash(episode.content);
  try {
    const payload: Record<string, unknown> = {
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
      contentHash,
      updatedAt: serverTimestamp(),
    };
    if (typeof episode.latestRevisionId === 'string') {
      payload.latestRevisionId = episode.latestRevisionId.trim();
    }
    await updateDoc(doc(db, path), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export type EpisodeRevisionCasConflictCode =
  | 'STALE_REVISION_CONFLICT'
  | 'CONTENT_HASH_MISMATCH'
  | 'EPISODE_NOT_FOUND';

export class EpisodeRevisionCasConflictError extends Error {
  readonly code: EpisodeRevisionCasConflictCode;
  readonly expectedRevisionId?: string;
  readonly actualRevisionId?: string;
  readonly expectedContentHash?: string;
  readonly actualContentHash?: string;

  constructor(
    code: EpisodeRevisionCasConflictCode,
    message: string,
    details?: {
      expectedRevisionId?: string;
      actualRevisionId?: string;
      expectedContentHash?: string;
      actualContentHash?: string;
    }
  ) {
    super(`[${code}] ${message}`);
    this.name = 'EpisodeRevisionCasConflictError';
    this.code = code;
    this.expectedRevisionId = details?.expectedRevisionId;
    this.actualRevisionId = details?.actualRevisionId;
    this.expectedContentHash = details?.expectedContentHash;
    this.actualContentHash = details?.actualContentHash;
  }
}

export interface EpisodeRevisionCommitInput {
  uid: string;
  projectId: string;
  updatedEpisode: Episode;
  expectedRevisionId?: string;
  expectedContentHash?: string;
  createBackupRevisionFirst?: boolean;
  backupRevisionLabel?: string;
  createRevision?: boolean;
  revisionLabel?: string;
  nowIso?: string;
}

export interface EpisodeRevisionCommitResult {
  episode: Episode;
  backupRevision: Revision | null;
  targetRevision: Revision | null;
}

export interface AtomicEpisodeCasTxAdapter {
  getEpisodeSnapshot: () => Promise<{
    exists: boolean;
    content: string;
    latestRevisionId?: string;
    contentHash?: string;
  }>;
  createRevision: (revision: Revision) => Promise<void>;
  updateEpisode: (episode: Episode) => Promise<void>;
}

/**
 * Shared P0-B atomic CAS commit algorithm for both Firestore `runTransaction` and local store:
 * 1. Performs ALL reads before ANY writes (Firestore transaction invariant).
 * 2. Validates `expectedRevisionId` and `expectedContentHash` (migrating missing legacy hashes deterministically).
 * 3. Creates optional non-empty, changed backup Revision BEFORE target Revision & Episode update.
 * 4. Never uses `episode.id` as a Revision ID (`rev_...` only) and updates `latestRevisionId` + `contentHash`.
 */
export async function executeAtomicEpisodeCasCommitCore(
  input: EpisodeRevisionCommitInput,
  adapter: AtomicEpisodeCasTxAdapter
): Promise<EpisodeRevisionCommitResult> {
  const nowIso = input.nowIso || new Date().toISOString();
  const normalizedTitle =
    (input.updatedEpisode.title || '무제 회차').trim().slice(0, 150) || '무제 회차';

  // Phase 1: READ ONLY
  const remoteSnap = await adapter.getEpisodeSnapshot();
  if (!remoteSnap.exists) {
    throw new EpisodeRevisionCasConflictError(
      'EPISODE_NOT_FOUND',
      `회차(${input.updatedEpisode.id})가 저장소에 존재하지 않아 안전 저장을 중단했습니다.`
    );
  }

  const remoteContent = typeof remoteSnap.content === 'string' ? remoteSnap.content : '';
  const remoteRevisionId =
    typeof remoteSnap.latestRevisionId === 'string' ? remoteSnap.latestRevisionId.trim() : '';
  const remoteContentHash =
    typeof remoteSnap.contentHash === 'string' && remoteSnap.contentHash.trim().length > 0
      ? remoteSnap.contentHash.trim()
      : computeManuscriptContentHash(remoteContent);

  if (input.expectedRevisionId !== undefined) {
    const expectedRev = (input.expectedRevisionId || '').trim();
    if (expectedRev !== remoteRevisionId) {
      throw new EpisodeRevisionCasConflictError(
        'STALE_REVISION_CONFLICT',
        `다른 탭 또는 최신 저장으로 회차 리비전이 이미 변경되었습니다(기대: ${
          expectedRev || 'NONE'
        }, 실제: ${remoteRevisionId || 'NONE'}). 덮어쓰기를 차단했습니다.`,
        {
          expectedRevisionId: expectedRev,
          actualRevisionId: remoteRevisionId,
        }
      );
    }
  }

  if (input.expectedContentHash !== undefined && input.expectedContentHash.trim().length > 0) {
    const expectedHash = input.expectedContentHash.trim();
    if (expectedHash !== remoteContentHash) {
      throw new EpisodeRevisionCasConflictError(
        'CONTENT_HASH_MISMATCH',
        '저장 직전 원고 내용 해시가 최신 저장본과 일치하지 않습니다. 최신 원고를 다시 불러온 뒤 반영하세요.',
        {
          expectedContentHash: expectedHash,
          actualContentHash: remoteContentHash,
        }
      );
    }
  }

  // Phase 2: Prepare deterministic entities in memory
  let backupRevision: Revision | null = null;
  if (
    input.createBackupRevisionFirst &&
    remoteContent.trim().length > 0 &&
    remoteContent !== input.updatedEpisode.content
  ) {
    const backupCounts = calculateCharCounts(remoteContent);
    const backupId = generateEntityId('rev');
    if (backupId === input.updatedEpisode.id) {
      throw new Error('[INVALID_REVISION_ID] Revision ID must never match Episode ID.');
    }
    backupRevision = {
      id: backupId,
      ownerId: input.uid,
      projectId: input.projectId,
      episodeId: input.updatedEpisode.id,
      episodeTitle: normalizedTitle,
      content: remoteContent,
      charCountWithSpaces: backupCounts.withSpaces,
      label: (input.backupRevisionLabel || '원고 교체/복원 전 자동 백업').trim().slice(0, 120),
      createdAt: nowIso,
    };
  }

  let targetRevision: Revision | null = null;
  if (input.createRevision) {
    const targetCounts = calculateCharCounts(input.updatedEpisode.content);
    const targetRevId = generateEntityId('rev');
    if (targetRevId === input.updatedEpisode.id) {
      throw new Error('[INVALID_REVISION_ID] Revision ID must never match Episode ID.');
    }
    targetRevision = {
      id: targetRevId,
      ownerId: input.uid,
      projectId: input.projectId,
      episodeId: input.updatedEpisode.id,
      episodeTitle: normalizedTitle,
      content: input.updatedEpisode.content,
      charCountWithSpaces: targetCounts.withSpaces,
      label: (input.revisionLabel || '수동 저장 스냅샷').trim().slice(0, 120),
      createdAt: nowIso,
    };
  }

  const nextCounts = calculateCharCounts(input.updatedEpisode.content);
  const nextContentHash = computeManuscriptContentHash(input.updatedEpisode.content);
  const nextLatestRevisionId =
    targetRevision?.id ||
    (typeof input.updatedEpisode.latestRevisionId === 'string' &&
    input.updatedEpisode.latestRevisionId.trim().length > 0
      ? input.updatedEpisode.latestRevisionId.trim()
      : remoteRevisionId);

  const committedEpisode: Episode = {
    ...input.updatedEpisode,
    ownerId: input.uid,
    projectId: input.projectId,
    title: normalizedTitle,
    charCountWithSpaces: nextCounts.withSpaces,
    charCountWithoutSpaces: nextCounts.withoutSpaces,
    latestRevisionId: nextLatestRevisionId || undefined,
    contentHash: nextContentHash,
    updatedAt: nowIso,
  };

  // Phase 3: WRITES ONLY
  if (backupRevision) {
    await adapter.createRevision(backupRevision);
  }
  if (targetRevision) {
    await adapter.createRevision(targetRevision);
  }
  await adapter.updateEpisode(committedEpisode);

  return {
    episode: committedEpisode,
    backupRevision,
    targetRevision,
  };
}

/**
 * Atomic Cloud Firestore commit using `runTransaction` (read-before-write + CAS + immutable revisions).
 */
export async function commitEpisodeRevisionSafelyFirestore(
  input: EpisodeRevisionCommitInput,
  firestoreDb: Firestore = db
): Promise<EpisodeRevisionCommitResult> {
  const epPath = `users/${input.uid}/projects/${input.projectId}/episodes/${input.updatedEpisode.id}`;
  try {
    return await runTransaction(firestoreDb, async (tx) => {
      const epRef = doc(firestoreDb, epPath);
      return executeAtomicEpisodeCasCommitCore(input, {
        getEpisodeSnapshot: async () => {
          const snap = await tx.get(epRef);
          if (!snap.exists()) {
            return { exists: false, content: '' };
          }
          const data = snap.data() || {};
          return {
            exists: true,
            content: typeof data.content === 'string' ? data.content : '',
            latestRevisionId:
              typeof data.latestRevisionId === 'string' ? data.latestRevisionId : '',
            contentHash:
              typeof data.contentHash === 'string' ? data.contentHash : undefined,
          };
        },
        createRevision: async (revision) => {
          const revPath = `users/${input.uid}/projects/${input.projectId}/revisions/${revision.id}`;
          const counts = calculateCharCounts(revision.content);
          tx.set(doc(firestoreDb, revPath), {
            id: revision.id,
            ownerId: input.uid,
            projectId: input.projectId,
            episodeId: revision.episodeId,
            episodeTitle: revision.episodeTitle,
            content: revision.content,
            charCountWithSpaces: counts.withSpaces,
            label: revision.label,
            createdAt: serverTimestamp(),
          });
        },
        updateEpisode: async (committedEpisode) => {
          const payload: Record<string, unknown> = {
            episodeNumber: committedEpisode.episodeNumber,
            title: committedEpisode.title,
            content: committedEpisode.content,
            synopsis: committedEpisode.synopsis,
            authorNote: committedEpisode.authorNote,
            charCountWithSpaces: committedEpisode.charCountWithSpaces,
            charCountWithoutSpaces: committedEpisode.charCountWithoutSpaces,
            status: committedEpisode.status,
            linkedCharacterIds: sanitizeIdArray(committedEpisode.linkedCharacterIds),
            linkedWorldbuildingIds: sanitizeIdArray(
              committedEpisode.linkedWorldbuildingIds
            ),
            latestRevisionId: committedEpisode.latestRevisionId || '',
            contentHash:
              committedEpisode.contentHash ||
              computeManuscriptContentHash(committedEpisode.content),
            updatedAt: serverTimestamp(),
          };
          tx.update(epRef, payload);
        },
      });
    });
  } catch (error) {
    if (error instanceof EpisodeRevisionCasConflictError) {
      throw error;
    }
    handleFirestoreError(error, OperationType.UPDATE, epPath);
  }
}

export interface LocalStorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/**
 * Atomic local bundle CAS persistence. Reads persisted localStorage snapshot when available
 * (enforcing cross-tab stale detection when two tabs share `localStorage`) and rolls back cleanly
 * if `setItem` throws (e.g., QuotaExceededError).
 */
export async function commitEpisodeRevisionSafelyLocal(params: {
  bundles: ProjectBundle[];
  commitInput: EpisodeRevisionCommitInput;
  storage?: LocalStorageLike | null;
}): Promise<EpisodeRevisionCommitResult & { nextBundles: ProjectBundle[] }> {
  const storage =
    params.storage !== undefined
      ? params.storage
      : typeof window !== 'undefined' && window.localStorage
      ? window.localStorage
      : null;

  // Prefer reading persisted localStorage first to catch concurrent multi-tab local edits
  let workingBundles = params.bundles;
  if (storage) {
    try {
      const persistedRaw = storage.getItem(LOCAL_BUNDLES_KEY);
      if (persistedRaw) {
        const parsed = JSON.parse(persistedRaw) as ProjectBundle[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          workingBundles = parsed;
        }
      }
    } catch {
      workingBundles = params.bundles;
    }
  }

  const targetBundleIdx = workingBundles.findIndex(
    (b) => b.project.id === params.commitInput.projectId
  );
  if (targetBundleIdx === -1) {
    throw new EpisodeRevisionCasConflictError(
      'EPISODE_NOT_FOUND',
      `프로젝트(${params.commitInput.projectId})를 로컬 저장소에서 찾을 수 없습니다.`
    );
  }

  const targetBundle = workingBundles[targetBundleIdx];
  const existingEpisode = targetBundle.episodes.find(
    (ep) => ep.id === params.commitInput.updatedEpisode.id
  );

  const stagedNewRevisions: Revision[] = [];
  let committedEpOut: Episode | null = null;

  const result = await executeAtomicEpisodeCasCommitCore(params.commitInput, {
    getEpisodeSnapshot: async () => {
      if (!existingEpisode) {
        return { exists: false, content: '' };
      }
      return {
        exists: true,
        content: existingEpisode.content,
        latestRevisionId: existingEpisode.latestRevisionId || '',
        contentHash:
          existingEpisode.contentHash ||
          computeManuscriptContentHash(existingEpisode.content),
      };
    },
    createRevision: async (revision) => {
      stagedNewRevisions.push(revision);
    },
    updateEpisode: async (committedEpisode) => {
      committedEpOut = committedEpisode;
    },
  });

  if (!committedEpOut) {
    throw new Error('[LOCAL_COMMIT_FAILED] Episode update payload was not produced.');
  }

  const nowIso = params.commitInput.nowIso || new Date().toISOString();
  const nextBundles = workingBundles.map((b, idx) => {
    if (idx !== targetBundleIdx) return b;
    const nextEpisodes = b.episodes
      .map((ep) => (ep.id === committedEpOut!.id ? committedEpOut! : ep))
      .sort((a, c) => a.episodeNumber - c.episodeNumber);
    const orderedAddedRevisions = [...stagedNewRevisions].reverse();
    return {
      ...b,
      project: { ...b.project, updatedAt: nowIso },
      episodes: nextEpisodes,
      revisions: [...orderedAddedRevisions, ...b.revisions],
    };
  });

  if (storage) {
    storage.setItem(LOCAL_BUNDLES_KEY, JSON.stringify(nextBundles));
  }

  return {
    ...result,
    nextBundles,
  };
}

export async function deleteFirestoreEpisode(
  uid: string,
  projectId: string,
  episodeId: string
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/episodes/${episodeId}`;
  try {
    await deleteDoc(doc(db, path));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function createFirestoreRevision(
  uid: string,
  projectId: string,
  revision: Revision
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/revisions/${revision.id}`;
  const counts = calculateCharCounts(revision.content);
  try {
    await setDoc(doc(db, path), {
      id: revision.id,
      ownerId: uid,
      projectId,
      episodeId: revision.episodeId,
      episodeTitle: revision.episodeTitle,
      content: revision.content,
      charCountWithSpaces: counts.withSpaces,
      label: revision.label,
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function deleteFirestoreRevision(
  uid: string,
  projectId: string,
  revisionId: string
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/revisions/${revisionId}`;
  try {
    await deleteDoc(doc(db, path));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

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

// ============================================================================
// Phase 1.5: Advanced System Foundation Firestore Operations
// (With Canon Setting Protection against arbitrary AI_ENGINE modification/deletion)
// ============================================================================

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

export async function createFirestoreMemoryDocument(
  uid: string,
  projectId: string,
  document: MemoryDocument
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/memoryDocuments/${document.id}`;
  try {
    await setDoc(doc(db, path), {
      id: document.id,
      ownerId: uid,
      projectId,
      sourceEntityType: document.sourceEntityType,
      sourceEntityId: document.sourceEntityId,
      sourceRevisionId: document.sourceRevisionId || '',
      title: document.title,
      fullText: document.fullText,
      chunkCount: document.chunkCount,
      canonStatus: normalizeToCanonStatus(document.canonStatus),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function createFirestoreMemoryChunk(
  uid: string,
  projectId: string,
  chunk: MemoryChunk
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/memoryChunks/${chunk.id}`;
  try {
    await setDoc(doc(db, path), {
      id: chunk.id,
      ownerId: uid,
      projectId,
      documentId: chunk.documentId,
      sourceEntityType: chunk.sourceEntityType,
      sourceEntityId: chunk.sourceEntityId,
      sourceRevisionId: chunk.sourceRevisionId || '',
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      tokenEstimate: chunk.tokenEstimate,
      keywords: sanitizeStringTags(chunk.keywords),
      episodeId: chunk.episodeId || '',
      sceneId: chunk.sceneId || '',
      characterIds: sanitizeIdArray(chunk.characterIds),
      foreshadowingIds: sanitizeIdArray(chunk.foreshadowingIds),
      canonStatus: normalizeToCanonStatus(chunk.canonStatus),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function createFirestoreStyleProfile(
  uid: string,
  projectId: string,
  profile: StyleProfile
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/styleProfiles/${profile.id}`;
  try {
    await setDoc(doc(db, path), {
      id: profile.id,
      ownerId: uid,
      projectId,
      name: profile.name,
      narrativePerspective: profile.narrativePerspective,
      dialogueRatio: Math.round(profile.dialogueRatio),
      avgSentenceLength: Math.round(profile.avgSentenceLength),
      toneKeywords: sanitizeStringTags(profile.toneKeywords),
      preferredExpressions: sanitizeStringTags(profile.preferredExpressions),
      prohibitedExpressions: sanitizeStringTags(profile.prohibitedExpressions),
      sampleExcerpt: profile.sampleExcerpt,
      canonStatus: normalizeToCanonStatus(profile.canonStatus),
      sourceRevisionId: profile.sourceRevisionId || '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateFirestoreStyleProfile(
  uid: string,
  projectId: string,
  profile: StyleProfile,
  actor: ActorType = 'AUTHOR',
  currentCanonStatus = profile.canonStatus
): Promise<void> {
  assertCanonProtection({
    actor,
    operation: 'UPDATE',
    canonStatus: currentCanonStatus,
  });
  const path = `users/${uid}/projects/${projectId}/styleProfiles/${profile.id}`;
  try {
    await updateDoc(doc(db, path), {
      name: profile.name,
      narrativePerspective: profile.narrativePerspective,
      dialogueRatio: Math.round(profile.dialogueRatio),
      avgSentenceLength: Math.round(profile.avgSentenceLength),
      toneKeywords: sanitizeStringTags(profile.toneKeywords),
      preferredExpressions: sanitizeStringTags(profile.preferredExpressions),
      prohibitedExpressions: sanitizeStringTags(profile.prohibitedExpressions),
      sampleExcerpt: profile.sampleExcerpt,
      canonStatus: normalizeToCanonStatus(profile.canonStatus),
      sourceRevisionId: profile.sourceRevisionId || '',
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

const SAFE_PROPOSAL_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const OPTIONAL_PROPOSAL_ID_REGEX = /^[a-zA-Z0-9_-]{0,128}$/;
const VALID_PROPOSAL_TARGET_TYPES = new Set([
  'CHARACTER',
  'WORLDBUILDING',
  'EPISODE',
  'SCENE',
  'FORESHADOWING',
  'RELATIONSHIP',
  'TIMELINE_EVENT',
  'STYLE_PROFILE',
]);
const VALID_PROPOSAL_ACTIONS = new Set(['CREATE', 'UPDATE', 'ARCHIVE']);
const VALID_PROPOSAL_ACTOR_TYPES = new Set<ActorType>([
  'AUTHOR',
  'AI_ENGINE',
  'SYSTEM',
]);

const PROPOSAL_LIMITS = {
  TITLE_MAX: 150,
  RATIONALE_MAX: 2000,
  SUMMARY_MAX: 2000,
  PAYLOAD_JSON_MAX: 20000,
} as const;

export function classifyFirestorePersistenceError(
  err: unknown
): ProposalPersistenceErrorCode {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code || '').toLowerCase()
      : '';
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const lowerMsg = msg.toLowerCase();

  if (
    code === 'permission-denied' ||
    code === 'firestore/permission-denied' ||
    code === '7' ||
    lowerMsg.includes('permission-denied') ||
    lowerMsg.includes('permission_denied') ||
    lowerMsg.includes('missing or insufficient permissions')
  ) {
    return 'PERMISSION_DENIED';
  }

  if (lowerMsg.includes('proposal_owner_mismatch')) {
    return 'PROPOSAL_OWNER_MISMATCH';
  }

  if (lowerMsg.includes('source_revision_not_found')) {
    return 'SOURCE_REVISION_NOT_FOUND';
  }

  if (lowerMsg.includes('source_revision_content_mismatch')) {
    return 'SOURCE_REVISION_CONTENT_MISMATCH';
  }

  if (lowerMsg.includes('source_revision_mismatch')) {
    return 'SOURCE_REVISION_MISMATCH';
  }

  if (
    lowerMsg.includes('source_revision_unverified') ||
    lowerMsg.includes('invalid_proposal_source_revision')
  ) {
    return 'SOURCE_REVISION_UNVERIFIED';
  }

  if (
    lowerMsg.includes('proposal_payload_conflict') ||
    lowerMsg.includes('source_revision_conflict') ||
    lowerMsg.includes('proposal_already_decided') ||
    lowerMsg.includes('conflict')
  ) {
    return 'PROPOSAL_PAYLOAD_CONFLICT';
  }

  if (
    lowerMsg.includes('invalid_proposal') ||
    lowerMsg.includes('validation_error')
  ) {
    return 'VALIDATION_ERROR';
  }

  if (
    code === 'unavailable' ||
    code === 'deadline-exceeded' ||
    code === 'aborted' ||
    code === 'cancelled' ||
    code === 'resource-exhausted' ||
    lowerMsg.includes('econnreset') ||
    lowerMsg.includes('etimedout') ||
    lowerMsg.includes('enotfound') ||
    lowerMsg.includes('network') ||
    lowerMsg.includes('offline') ||
    lowerMsg.includes('503') ||
    lowerMsg.includes('transient')
  ) {
    return 'NETWORK_ERROR';
  }

  return 'UNKNOWN_ERROR';
}

function mapErrorCodeToLookupStatus(
  errorCode: ProposalPersistenceErrorCode
): ProposalLookupStatus {
  if (
    errorCode === 'PERMISSION_DENIED' ||
    errorCode === 'PROPOSAL_OWNER_MISMATCH'
  ) {
    return 'PERMISSION_DENIED';
  }
  if (errorCode === 'NETWORK_ERROR') return 'NETWORK_ERROR';
  if (
    errorCode === 'SOURCE_REVISION_NOT_FOUND' ||
    errorCode === 'SOURCE_REVISION_UNVERIFIED'
  ) {
    return 'SOURCE_REVISION_UNVERIFIED';
  }
  if (errorCode === 'SOURCE_REVISION_MISMATCH') {
    return 'SOURCE_REVISION_MISMATCH';
  }
  if (errorCode === 'SOURCE_REVISION_CONTENT_MISMATCH') {
    return 'SOURCE_REVISION_CONTENT_MISMATCH';
  }
  if (errorCode === 'PROPOSAL_PAYLOAD_CONFLICT' || errorCode === 'CONFLICT') {
    return 'DOCUMENT_EXISTS_PROPOSED';
  }
  return 'UNKNOWN_ERROR';
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item));
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    if (obj[key] !== undefined) {
      out[key] = canonicalizeJsonValue(obj[key]);
    }
  }
  return out;
}

export function canonicalizeProposedPayloadJson(
  raw: unknown
):
  | { ok: true; canonicalJson: string }
  | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, canonicalJson: '{}' };
  }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      error: '[INVALID_PROPOSAL_PAYLOAD_JSON] proposedPayloadJson은 문자열이어야 합니다.',
    };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, canonicalJson: '{}' };
  }
  if (trimmed.length > PROPOSAL_LIMITS.PAYLOAD_JSON_MAX) {
    return {
      ok: false,
      error: `[INVALID_PROPOSAL_PAYLOAD_JSON] proposedPayloadJson 길이(${trimmed.length}자)가 최대 허용 한도(${PROPOSAL_LIMITS.PAYLOAD_JSON_MAX}자)를 초과했습니다.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      error: '[INVALID_PROPOSAL_PAYLOAD_JSON] proposedPayloadJson이 유효한 JSON 형식이 아닙니다.',
    };
  }
  const canonicalJson = JSON.stringify(canonicalizeJsonValue(parsed));
  if (typeof canonicalJson !== 'string') {
    return {
      ok: false,
      error: '[INVALID_PROPOSAL_PAYLOAD_JSON] proposedPayloadJson을 정규화할 수 없습니다.',
    };
  }
  if (canonicalJson.length > PROPOSAL_LIMITS.PAYLOAD_JSON_MAX) {
    return {
      ok: false,
      error: `[INVALID_PROPOSAL_PAYLOAD_JSON] 정규화된 proposedPayloadJson 길이(${canonicalJson.length}자)가 최대 허용 한도(${PROPOSAL_LIMITS.PAYLOAD_JSON_MAX}자)를 초과했습니다.`,
    };
  }
  return { ok: true, canonicalJson };
}

export type NormalizedProposalValidationResult =
  | {
      ok: true;
      normalized: ProposalImmutablePayload;
    }
  | {
      ok: false;
      errorCode: 'PROPOSAL_OWNER_MISMATCH' | 'SOURCE_REVISION_UNVERIFIED' | 'VALIDATION_ERROR';
      errorMessage: string;
    };

export function normalizeAndValidateChangeProposalPayload(
  uid: string,
  projectId: string,
  proposal: ChangeProposal
): NormalizedProposalValidationResult {
  const cleanUid = (uid || '').trim();
  const cleanProjectId = (projectId || '').trim();
  if (!SAFE_PROPOSAL_ID_REGEX.test(cleanUid)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: '[INVALID_PROPOSAL_UID] 유효하지 않은 ownerId 형식입니다.',
    };
  }
  if (!SAFE_PROPOSAL_ID_REGEX.test(cleanProjectId)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: '[INVALID_PROPOSAL_PROJECT_ID] 유효하지 않은 projectId 형식입니다.',
    };
  }

  const incomingOwnerId =
    typeof proposal.ownerId === 'string' ? proposal.ownerId.trim() : '';
  if (incomingOwnerId && incomingOwnerId !== cleanUid) {
    return {
      ok: false,
      errorCode: 'PROPOSAL_OWNER_MISMATCH',
      errorMessage: `[PROPOSAL_OWNER_MISMATCH] 제안서 ownerId('${incomingOwnerId}')가 인증된 소유자('${cleanUid}')와 일치하지 않습니다.`,
    };
  }

  const incomingProjectId =
    typeof proposal.projectId === 'string' ? proposal.projectId.trim() : '';
  if (incomingProjectId && incomingProjectId !== cleanProjectId) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `[INVALID_PROPOSAL_PROJECT_ID] 제안서 projectId('${incomingProjectId}')가 현재 프로젝트('${cleanProjectId}')와 일치하지 않습니다.`,
    };
  }

  const cleanId = (proposal.id || '').trim();
  if (!SAFE_PROPOSAL_ID_REGEX.test(cleanId)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `[INVALID_PROPOSAL_ID] 유효하지 않은 proposalId 형식입니다 (${proposal.id}).`,
    };
  }

  const cleanTargetEntityId = (proposal.targetEntityId || '').trim();
  if (!SAFE_PROPOSAL_ID_REGEX.test(cleanTargetEntityId)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `[INVALID_PROPOSAL_TARGET_ID] 유효하지 않은 targetEntityId 형식입니다 (${proposal.targetEntityId}).`,
    };
  }

  if (!VALID_PROPOSAL_TARGET_TYPES.has(proposal.targetEntityType)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `[INVALID_PROPOSAL_TARGET_TYPE] 지원하지 않는 targetEntityType입니다 (${proposal.targetEntityType}).`,
    };
  }

  if (!VALID_PROPOSAL_ACTIONS.has(proposal.proposedAction)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `[INVALID_PROPOSAL_ACTION] 지원하지 않는 proposedAction입니다 (${proposal.proposedAction}).`,
    };
  }

  if (typeof proposal.title !== 'string') {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: '[INVALID_PROPOSAL_TITLE] 제안서 제목(title)이 누락되었습니다.',
    };
  }
  const cleanTitle = proposal.title.trim();
  if (cleanTitle.length < 1 || cleanTitle.length > PROPOSAL_LIMITS.TITLE_MAX) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `[INVALID_PROPOSAL_TITLE] 제안서 제목(title)은 1~${PROPOSAL_LIMITS.TITLE_MAX}자여야 합니다 (현재: ${cleanTitle.length}자).`,
    };
  }

  const cleanRationale =
    typeof proposal.rationale === 'string' ? proposal.rationale.trim() : '';
  if (cleanRationale.length > PROPOSAL_LIMITS.RATIONALE_MAX) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `[INVALID_PROPOSAL_RATIONALE] 제안서 근거(rationale)는 ${PROPOSAL_LIMITS.RATIONALE_MAX}자를 초과할 수 없습니다 (현재: ${cleanRationale.length}자).`,
    };
  }

  const cleanBeforeSummary =
    typeof proposal.beforeSummary === 'string' ? proposal.beforeSummary.trim() : '';
  if (cleanBeforeSummary.length > PROPOSAL_LIMITS.SUMMARY_MAX) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `[INVALID_PROPOSAL_BEFORE_SUMMARY] 변경 전 요약(beforeSummary)은 ${PROPOSAL_LIMITS.SUMMARY_MAX}자를 초과할 수 없습니다 (현재: ${cleanBeforeSummary.length}자).`,
    };
  }

  const cleanAfterSummary =
    typeof proposal.afterSummary === 'string' ? proposal.afterSummary.trim() : '';
  if (cleanAfterSummary.length > PROPOSAL_LIMITS.SUMMARY_MAX) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `[INVALID_PROPOSAL_AFTER_SUMMARY] 변경 후 요약(afterSummary)은 ${PROPOSAL_LIMITS.SUMMARY_MAX}자를 초과할 수 없습니다 (현재: ${cleanAfterSummary.length}자).`,
    };
  }

  const triggerEp = (proposal.triggerEpisodeId || '').trim();
  const triggerScene = (proposal.triggerSceneId || '').trim();
  const sourceRev = (proposal.sourceRevisionId || '').trim();

  if (!OPTIONAL_PROPOSAL_ID_REGEX.test(triggerEp)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: '[INVALID_PROPOSAL_TRIGGER_EPISODE] 유효하지 않은 triggerEpisodeId 형식입니다.',
    };
  }
  if (!OPTIONAL_PROPOSAL_ID_REGEX.test(triggerScene)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: '[INVALID_PROPOSAL_TRIGGER_SCENE] 유효하지 않은 triggerSceneId 형식입니다.',
    };
  }
  if (sourceRev === 'UNSAVED_DRAFT') {
    return {
      ok: false,
      errorCode: 'SOURCE_REVISION_UNVERIFIED',
      errorMessage: '[INVALID_PROPOSAL_SOURCE_REVISION] UNSAVED_DRAFT 상태의 제안서는 저장할 수 없습니다.',
    };
  }
  if (!OPTIONAL_PROPOSAL_ID_REGEX.test(sourceRev)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: '[INVALID_PROPOSAL_SOURCE_REVISION] 유효하지 않은 sourceRevisionId 형식입니다.',
    };
  }

  const rawActor =
    typeof proposal.createdBy === 'string' ? proposal.createdBy.trim() : '';
  const cleanCreatedBy: ActorType = rawActor
    ? (rawActor as ActorType)
    : 'AI_ENGINE';
  if (!VALID_PROPOSAL_ACTOR_TYPES.has(cleanCreatedBy)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `[INVALID_PROPOSAL_ACTOR] 지원하지 않는 createdBy 값입니다 (${rawActor}).`,
    };
  }

  const payloadCheck = canonicalizeProposedPayloadJson(proposal.proposedPayloadJson);
  if (!payloadCheck.ok) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: payloadCheck.error,
    };
  }

  return {
    ok: true,
    normalized: {
      id: cleanId,
      ownerId: cleanUid,
      projectId: cleanProjectId,
      targetEntityType: proposal.targetEntityType,
      targetEntityId: cleanTargetEntityId,
      proposedAction: proposal.proposedAction,
      title: cleanTitle,
      rationale: cleanRationale,
      beforeSummary: cleanBeforeSummary,
      afterSummary: cleanAfterSummary,
      proposedPayloadJson: payloadCheck.canonicalJson,
      triggerEpisodeId: triggerEp,
      triggerSceneId: triggerScene,
      sourceRevisionId: sourceRev,
      createdBy: cleanCreatedBy,
    },
  };
}

export function validateProposalBeforeFirestoreWrite(
  uid: string,
  projectId: string,
  proposal: ChangeProposal
): string | null {
  const res = normalizeAndValidateChangeProposalPayload(uid, projectId, proposal);
  return res.ok ? null : res.errorMessage;
}

function normalizeComparableImmutableFields(
  raw: Record<string, unknown> | Partial<ChangeProposal>
): {
  fields: Record<keyof ProposalImmutablePayload, string>;
  jsonValid: boolean;
} {
  const payloadCheck = canonicalizeProposedPayloadJson(raw.proposedPayloadJson);
  const rawCreatedBy =
    typeof raw.createdBy === 'string' ? raw.createdBy.trim() : '';
  return {
    jsonValid: payloadCheck.ok,
    fields: {
      id: String(raw.id ?? '').trim(),
      ownerId: String(raw.ownerId ?? '').trim(),
      projectId: String(raw.projectId ?? '').trim(),
      targetEntityType: String(raw.targetEntityType ?? '').trim(),
      targetEntityId: String(raw.targetEntityId ?? '').trim(),
      proposedAction: String(raw.proposedAction ?? '').trim(),
      title: String(raw.title ?? '').trim(),
      rationale: String(raw.rationale ?? '').trim(),
      beforeSummary: String(raw.beforeSummary ?? '').trim(),
      afterSummary: String(raw.afterSummary ?? '').trim(),
      proposedPayloadJson: payloadCheck.ok
        ? payloadCheck.canonicalJson
        : String(raw.proposedPayloadJson ?? ''),
      triggerEpisodeId: String(raw.triggerEpisodeId ?? '').trim(),
      triggerSceneId: String(raw.triggerSceneId ?? '').trim(),
      sourceRevisionId: String(raw.sourceRevisionId ?? '').trim(),
      createdBy: rawCreatedBy || 'AI_ENGINE',
    },
  };
}

export function areProposalsSemanticallyEquivalent(
  existing: Record<string, unknown> | Partial<ChangeProposal>,
  incoming: ChangeProposal | ProposalImmutablePayload
): {
  equivalent: boolean;
  reason?: string;
  errorCode?: 'PROPOSAL_OWNER_MISMATCH' | 'PROPOSAL_PAYLOAD_CONFLICT';
  mismatchFields?: (keyof ProposalImmutablePayload)[];
} {
  const existingNorm = normalizeComparableImmutableFields(existing);
  const incomingNorm = normalizeComparableImmutableFields(incoming);

  // Never treat invalid/unparseable JSON payloads as equal!
  if (!existingNorm.jsonValid || !incomingNorm.jsonValid) {
    return {
      equivalent: false,
      errorCode: 'PROPOSAL_PAYLOAD_CONFLICT',
      mismatchFields: ['proposedPayloadJson'],
      reason: `[PROPOSAL_PAYLOAD_CONFLICT] Proposal ID('${incomingNorm.fields.id}')의 proposedPayloadJson을 검증할 수 없어 동일 데이터로 간주하지 않습니다.`,
    };
  }

  if (
    existingNorm.fields.ownerId &&
    incomingNorm.fields.ownerId &&
    existingNorm.fields.ownerId !== incomingNorm.fields.ownerId
  ) {
    return {
      equivalent: false,
      errorCode: 'PROPOSAL_OWNER_MISMATCH',
      mismatchFields: ['ownerId'],
      reason: `[PROPOSAL_OWNER_MISMATCH] 기존 제안서(${incomingNorm.fields.id}) 소유자('${existingNorm.fields.ownerId}')와 요청 소유자('${incomingNorm.fields.ownerId}')가 일치하지 않습니다.`,
    };
  }

  const orderedFields: (keyof ProposalImmutablePayload)[] = [
    'id',
    'ownerId',
    'projectId',
    'targetEntityType',
    'targetEntityId',
    'proposedAction',
    'title',
    'rationale',
    'beforeSummary',
    'afterSummary',
    'proposedPayloadJson',
    'triggerEpisodeId',
    'triggerSceneId',
    'sourceRevisionId',
    'createdBy',
  ];

  const mismatchFields: (keyof ProposalImmutablePayload)[] = [];
  for (const field of orderedFields) {
    // Allow legacy fixtures where ownerId or projectId was omitted on existing mock partial object
    if (
      (field === 'ownerId' || field === 'projectId') &&
      !existingNorm.fields[field]
    ) {
      continue;
    }
    if (existingNorm.fields[field] !== incomingNorm.fields[field]) {
      mismatchFields.push(field);
    }
  }

  if (mismatchFields.length > 0) {
    if (
      mismatchFields.length === 1 &&
      mismatchFields[0] === 'sourceRevisionId' &&
      existingNorm.fields.sourceRevisionId
    ) {
      return {
        equivalent: false,
        errorCode: 'PROPOSAL_PAYLOAD_CONFLICT',
        mismatchFields,
        reason: `[PROPOSAL_PAYLOAD_CONFLICT][SOURCE_REVISION_CONFLICT] 기존 제안서(${incomingNorm.fields.id})의 sourceRevisionId('${existingNorm.fields.sourceRevisionId}')는 불변이며 '${incomingNorm.fields.sourceRevisionId}'로 변경할 수 없습니다.`,
      };
    }
    return {
      equivalent: false,
      errorCode: 'PROPOSAL_PAYLOAD_CONFLICT',
      mismatchFields,
      reason: `[PROPOSAL_PAYLOAD_CONFLICT] 동일한 Proposal ID('${incomingNorm.fields.id}')에 서로 다른 의미 필드(${mismatchFields.join(', ')})가 전달되어 덮어쓰기를 차단했습니다.`,
    };
  }

  return { equivalent: true, mismatchFields: [] };
}

export function buildCanonicalChangeProposalWriteDataFromNormalized(
  normalized: ProposalImmutablePayload
) {
  return {
    id: normalized.id,
    ownerId: normalized.ownerId,
    projectId: normalized.projectId,
    targetEntityType: normalized.targetEntityType,
    targetEntityId: normalized.targetEntityId,
    proposedAction: normalized.proposedAction,
    title: normalized.title,
    rationale: normalized.rationale,
    beforeSummary: normalized.beforeSummary,
    afterSummary: normalized.afterSummary,
    proposedPayloadJson: normalized.proposedPayloadJson,
    canonStatus: 'PROPOSED' as const,
    triggerEpisodeId: normalized.triggerEpisodeId,
    triggerSceneId: normalized.triggerSceneId,
    sourceRevisionId: normalized.sourceRevisionId,
    createdBy: normalized.createdBy,
    reviewedAt: '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function buildCanonicalChangeProposalWriteData(
  uid: string,
  projectId: string,
  proposal: ChangeProposal
) {
  const check = normalizeAndValidateChangeProposalPayload(uid, projectId, proposal);
  if (!check.ok) {
    throw new Error(check.errorMessage);
  }
  return buildCanonicalChangeProposalWriteDataFromNormalized(check.normalized);
}

export async function createFirestoreChangeProposal(
  uid: string,
  projectId: string,
  proposal: ChangeProposal,
  firestoreDb: Firestore = db
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/changeProposals/${proposal.id}`;
  const normRes = normalizeAndValidateChangeProposalPayload(
    uid,
    projectId,
    proposal
  );
  if (!normRes.ok) {
    handleFirestoreError(new Error(normRes.errorMessage), OperationType.CREATE, path);
  }
  const normalized = (normRes as { ok: true; normalized: ProposalImmutablePayload }).normalized;
  try {
    const ref = doc(firestoreDb, path);
    await runTransaction(firestoreDb, async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists()) {
        const existingData = snap.data() || {};
        if (
          typeof existingData.ownerId === 'string' &&
          existingData.ownerId.trim() !== normalized.ownerId
        ) {
          throw new Error(
            `[PROPOSAL_OWNER_MISMATCH] 기존 제안서 소유자('${existingData.ownerId}')가 인증된 사용자('${normalized.ownerId}')와 일치하지 않습니다.`
          );
        }
        const equiv = areProposalsSemanticallyEquivalent(existingData, normalized);
        if (!equiv.equivalent) {
          throw new Error(equiv.reason || '[PROPOSAL_PAYLOAD_CONFLICT]');
        }
        const existingStatus = normalizeToCanonStatus(existingData.canonStatus);
        if (existingStatus !== 'PROPOSED' && existingStatus !== 'DRAFT') {
          return;
        }
        return;
      }
      tx.set(ref, buildCanonicalChangeProposalWriteDataFromNormalized(normalized));
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export interface AtomicProposalPersistenceOutcome {
  outcome:
    | 'CREATED'
    | 'SKIPPED_ALREADY_EXISTS'
    | 'SKIPPED_ALREADY_DECIDED'
    | 'CONFLICT'
    | 'FAILED';
  lookupStatus?: ProposalLookupStatus;
  canonStatus?: CanonStatus | string;
  errorCode?: ProposalPersistenceErrorCode;
  errorMessage?: string;
}

export interface SourceRevisionVerificationOutcome {
  valid: boolean;
  actualContentHash?: string;
  lookupStatus?: ProposalLookupStatus;
  errorCode?: ProposalPersistenceErrorCode;
  errorMessage?: string;
}

export interface IdempotentProposalPersistenceAdapter {
  /**
   * Preferred single-transaction atomic create-only handler (e.g. Firestore `runTransaction`).
   */
  persistProposalAtomically?: (
    proposal: ChangeProposal,
    options?: PersistChangeProposalsOptions
  ) => Promise<AtomicProposalPersistenceOutcome>;
  getExistingProposalStatus?: (proposalId: string) => Promise<{
    exists: boolean;
    lookupStatus?: ProposalLookupStatus;
    canonStatus?: CanonStatus | string;
    existingProposal?: Partial<ChangeProposal>;
    errorCode?: ProposalPersistenceErrorCode;
    errorMessage?: string;
  }>;
  verifySourceRevision?: (
    proposal: ChangeProposal,
    options?: PersistChangeProposalsOptions
  ) => Promise<SourceRevisionVerificationOutcome>;
  createProposal?: (proposal: ChangeProposal) => Promise<void>;
}

export function verifyPersistedRevisionSnapshot(params: {
  exists: boolean;
  revisionData?: Record<string, unknown> | Partial<Revision> | null;
  revisionDocId: string;
  expectedOwnerId: string;
  expectedProjectId: string;
  expectedEpisodeId: string;
  expectedContentHash?: string;
}): SourceRevisionVerificationOutcome {
  if (!params.exists || !params.revisionData) {
    return {
      valid: false,
      lookupStatus: 'SOURCE_REVISION_UNVERIFIED',
      errorCode: 'SOURCE_REVISION_NOT_FOUND',
      errorMessage: `[SOURCE_REVISION_NOT_FOUND] 참조된 원고 리비전(${params.revisionDocId})이 저장소에 존재하지 않습니다.`,
    };
  }

  const data = params.revisionData;
  const revOwnerId = String(data.ownerId ?? '').trim();
  const revProjectId = String(data.projectId ?? '').trim();
  const revDocInternalId = String(data.id ?? params.revisionDocId).trim();
  const revEpisodeId = String(data.episodeId ?? '').trim();

  if (revOwnerId !== params.expectedOwnerId.trim()) {
    return {
      valid: false,
      lookupStatus: 'PERMISSION_DENIED',
      errorCode: 'PERMISSION_DENIED',
      errorMessage: `[PERMISSION_DENIED] 참조된 리비전(${params.revisionDocId})의 소유자('${revOwnerId}')가 인증된 소유자('${params.expectedOwnerId}')와 일치하지 않습니다.`,
    };
  }

  if (revProjectId !== params.expectedProjectId.trim()) {
    return {
      valid: false,
      lookupStatus: 'SOURCE_REVISION_MISMATCH',
      errorCode: 'SOURCE_REVISION_MISMATCH',
      errorMessage: `[SOURCE_REVISION_MISMATCH] 참조된 리비전(${params.revisionDocId})의 프로젝트('${revProjectId}')가 현재 프로젝트('${params.expectedProjectId}')와 일치하지 않습니다.`,
    };
  }

  if (revDocInternalId !== params.revisionDocId.trim()) {
    return {
      valid: false,
      lookupStatus: 'SOURCE_REVISION_MISMATCH',
      errorCode: 'SOURCE_REVISION_MISMATCH',
      errorMessage: `[SOURCE_REVISION_MISMATCH] 참조된 리비전 ID(${revDocInternalId})가 경로 ID(${params.revisionDocId})와 일치하지 않습니다.`,
    };
  }

  if (params.expectedEpisodeId && revEpisodeId !== params.expectedEpisodeId.trim()) {
    return {
      valid: false,
      lookupStatus: 'SOURCE_REVISION_MISMATCH',
      errorCode: 'SOURCE_REVISION_MISMATCH',
      errorMessage: `[SOURCE_REVISION_MISMATCH] 참조된 리비전(${params.revisionDocId})의 회차('${revEpisodeId}')가 요청 회차('${params.expectedEpisodeId}')와 일치하지 않습니다.`,
    };
  }

  if (typeof data.content !== 'string') {
    return {
      valid: false,
      lookupStatus: 'SOURCE_REVISION_UNVERIFIED',
      errorCode: 'SOURCE_REVISION_UNVERIFIED',
      errorMessage: `[SOURCE_REVISION_UNVERIFIED] 참조된 리비전(${params.revisionDocId})에 본문 스냅샷이 존재하지 않습니다.`,
    };
  }

  const actualContentHash = computeManuscriptContentHash(data.content);
  const expectedHash = (params.expectedContentHash || '').trim();
  if (expectedHash && actualContentHash !== expectedHash) {
    return {
      valid: false,
      lookupStatus: 'SOURCE_REVISION_CONTENT_MISMATCH',
      errorCode: 'SOURCE_REVISION_CONTENT_MISMATCH',
      errorMessage: `[SOURCE_REVISION_CONTENT_MISMATCH] 참조된 리비전(${params.revisionDocId})의 본문 해시(${actualContentHash})가 리라이팅 커밋 해시(${expectedHash})와 일치하지 않습니다.`,
    };
  }

  return {
    valid: true,
    actualContentHash,
  };
}

/**
 * Pure idempotent persistence core for P0-B / Stage 2.1 / Stage 2.2:
 * - Prefers single-transaction `persistProposalAtomically` when provided (race-free)
 * - Compares ALL 15 immutable semantic fields cleanly before allowing idempotent skip
 * - Never treats PERMISSION_DENIED, NETWORK_ERROR, or missing Revision as DOCUMENT_NOT_FOUND
 * - Preserves already-decided proposals (CANON / REJECTED / ARCHIVED) untouched
 * - Isolates per-proposal failures so partial failures can retry ONLY failed items
 */
export async function persistChangeProposalsIdempotentlyCore(
  proposals: ChangeProposal[],
  adapter: IdempotentProposalPersistenceAdapter,
  options?: PersistChangeProposalsOptions
): Promise<PersistChangeProposalsResult> {
  const seenProposals = new Map<string, ChangeProposal>();
  const itemResults: PersistedProposalItemResult[] = [];
  const failedProposals: ChangeProposal[] = [];
  let createdCount = 0;
  let skippedDuplicateCount = 0;

  for (const prop of proposals) {
    const idempotencyKey = prop.id;
    const prevInBatch = seenProposals.get(prop.id);
    if (prevInBatch) {
      const equiv = areProposalsSemanticallyEquivalent(prevInBatch, prop);
      if (!equiv.equivalent) {
        const errCode = equiv.errorCode || 'PROPOSAL_PAYLOAD_CONFLICT';
        failedProposals.push(prop);
        itemResults.push({
          proposalId: prop.id,
          idempotencyKey,
          status: 'FAILED',
          lookupStatus: mapErrorCodeToLookupStatus(errCode),
          errorCode: errCode,
          errorMessage: equiv.reason,
        });
      } else {
        skippedDuplicateCount += 1;
        itemResults.push({
          proposalId: prop.id,
          idempotencyKey,
          status: 'SKIPPED_ALREADY_EXISTS',
          lookupStatus: 'DOCUMENT_EXISTS_PROPOSED',
        });
      }
      continue;
    }
    seenProposals.set(prop.id, prop);

    try {
      if (adapter.persistProposalAtomically) {
        const atomicRes = await adapter.persistProposalAtomically(
          {
            ...prop,
            canonStatus: 'PROPOSED',
          },
          options
        );
        if (atomicRes.outcome === 'CREATED') {
          createdCount += 1;
          itemResults.push({
            proposalId: prop.id,
            idempotencyKey,
            status: 'CREATED',
            lookupStatus: atomicRes.lookupStatus || 'DOCUMENT_NOT_FOUND',
          });
        } else if (atomicRes.outcome === 'SKIPPED_ALREADY_DECIDED') {
          skippedDuplicateCount += 1;
          itemResults.push({
            proposalId: prop.id,
            idempotencyKey,
            status: 'SKIPPED_ALREADY_DECIDED',
            lookupStatus: atomicRes.lookupStatus || 'DOCUMENT_EXISTS_DECIDED',
          });
        } else if (atomicRes.outcome === 'SKIPPED_ALREADY_EXISTS') {
          skippedDuplicateCount += 1;
          itemResults.push({
            proposalId: prop.id,
            idempotencyKey,
            status: 'SKIPPED_ALREADY_EXISTS',
            lookupStatus: atomicRes.lookupStatus || 'DOCUMENT_EXISTS_PROPOSED',
          });
        } else {
          const errCode = atomicRes.errorCode || 'PROPOSAL_PAYLOAD_CONFLICT';
          failedProposals.push(prop);
          itemResults.push({
            proposalId: prop.id,
            idempotencyKey,
            status: 'FAILED',
            lookupStatus:
              atomicRes.lookupStatus || mapErrorCodeToLookupStatus(errCode),
            errorCode: errCode,
            errorMessage:
              atomicRes.errorMessage ||
              `[PROPOSAL_PAYLOAD_CONFLICT] 기존 제안서(${prop.id})와 충돌하여 저장을 거부했습니다.`,
          });
        }
        continue;
      }

      if (!adapter.getExistingProposalStatus || !adapter.createProposal) {
        throw new Error(
          '[INVALID_PERSISTENCE_ADAPTER] persistProposalAtomically 또는 getExistingProposalStatus/createProposal 어댑터가 필요합니다.'
        );
      }

      const existing = await adapter.getExistingProposalStatus(prop.id);
      if (
        existing.lookupStatus === 'PERMISSION_DENIED' ||
        existing.lookupStatus === 'NETWORK_ERROR' ||
        existing.lookupStatus === 'UNKNOWN_ERROR'
      ) {
        const errCode =
          existing.errorCode ||
          (existing.lookupStatus === 'PERMISSION_DENIED'
            ? 'PERMISSION_DENIED'
            : existing.lookupStatus === 'NETWORK_ERROR'
            ? 'NETWORK_ERROR'
            : 'UNKNOWN_ERROR');
        failedProposals.push(prop);
        itemResults.push({
          proposalId: prop.id,
          idempotencyKey,
          status: 'FAILED',
          lookupStatus: existing.lookupStatus,
          errorCode: errCode,
          errorMessage:
            existing.errorMessage ||
            `제안서(${prop.id}) 기존 상태 조회에 실패했습니다 (${existing.lookupStatus}).`,
        });
        continue;
      }

      if (existing.exists) {
        if (existing.existingProposal) {
          const equiv = areProposalsSemanticallyEquivalent(
            existing.existingProposal,
            prop
          );
          if (!equiv.equivalent) {
            const errCode = equiv.errorCode || 'PROPOSAL_PAYLOAD_CONFLICT';
            failedProposals.push(prop);
            itemResults.push({
              proposalId: prop.id,
              idempotencyKey,
              status: 'FAILED',
              lookupStatus: mapErrorCodeToLookupStatus(errCode),
              errorCode: errCode,
              errorMessage: equiv.reason,
            });
            continue;
          }
        }

        const isDecided =
          existing.canonStatus &&
          existing.canonStatus !== 'PROPOSED' &&
          existing.canonStatus !== 'DRAFT';
        if (isDecided) {
          skippedDuplicateCount += 1;
          itemResults.push({
            proposalId: prop.id,
            idempotencyKey,
            status: 'SKIPPED_ALREADY_DECIDED',
            lookupStatus: 'DOCUMENT_EXISTS_DECIDED',
          });
          continue;
        }

        if (options?.requireVerifiedSourceRevision && adapter.verifySourceRevision) {
          const revCheck = await adapter.verifySourceRevision(prop, options);
          if (!revCheck.valid) {
            const revErr = revCheck.errorCode || 'SOURCE_REVISION_UNVERIFIED';
            failedProposals.push(prop);
            itemResults.push({
              proposalId: prop.id,
              idempotencyKey,
              status: 'FAILED',
              lookupStatus:
                revCheck.lookupStatus || mapErrorCodeToLookupStatus(revErr),
              errorCode: revErr,
              errorMessage: revCheck.errorMessage,
            });
            continue;
          }
        }

        skippedDuplicateCount += 1;
        itemResults.push({
          proposalId: prop.id,
          idempotencyKey,
          status: 'SKIPPED_ALREADY_EXISTS',
          lookupStatus: 'DOCUMENT_EXISTS_PROPOSED',
        });
        continue;
      }

      if (options?.requireVerifiedSourceRevision) {
        if (!adapter.verifySourceRevision) {
          failedProposals.push(prop);
          itemResults.push({
            proposalId: prop.id,
            idempotencyKey,
            status: 'FAILED',
            lookupStatus: 'SOURCE_REVISION_UNVERIFIED',
            errorCode: 'SOURCE_REVISION_UNVERIFIED',
            errorMessage:
              '[SOURCE_REVISION_UNVERIFIED] 리비전 출처 검증 어댑터가 제공되지 않아 신규 제안서 생성을 거부했습니다.',
          });
          continue;
        }
        const revCheck = await adapter.verifySourceRevision(prop, options);
        if (!revCheck.valid) {
          const revErr = revCheck.errorCode || 'SOURCE_REVISION_UNVERIFIED';
          failedProposals.push(prop);
          itemResults.push({
            proposalId: prop.id,
            idempotencyKey,
            status: 'FAILED',
            lookupStatus:
              revCheck.lookupStatus || mapErrorCodeToLookupStatus(revErr),
            errorCode: revErr,
            errorMessage: revCheck.errorMessage,
          });
          continue;
        }
      }

      await adapter.createProposal({
        ...prop,
        canonStatus: 'PROPOSED',
      });
      createdCount += 1;
      itemResults.push({
        proposalId: prop.id,
        idempotencyKey,
        status: 'CREATED',
        lookupStatus: 'DOCUMENT_NOT_FOUND',
      });
    } catch (err) {
      const errorCode = classifyFirestorePersistenceError(err);
      failedProposals.push(prop);
      itemResults.push({
        proposalId: prop.id,
        idempotencyKey,
        status: 'FAILED',
        lookupStatus: mapErrorCodeToLookupStatus(errorCode),
        errorCode,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    attemptedCount: proposals.length,
    createdCount,
    skippedDuplicateCount,
    failedCount: failedProposals.length,
    failedProposals,
    itemResults,
  };
}

export async function persistSingleFirestoreProposalAtomically(
  firestoreDb: Firestore,
  uid: string,
  projectId: string,
  proposal: ChangeProposal,
  options?: PersistChangeProposalsOptions
): Promise<AtomicProposalPersistenceOutcome> {
  const normRes = normalizeAndValidateChangeProposalPayload(
    uid,
    projectId,
    proposal
  );
  if (!normRes.ok) {
    const failedRes = normRes as {
      ok: false;
      errorCode: 'PROPOSAL_OWNER_MISMATCH' | 'SOURCE_REVISION_UNVERIFIED' | 'VALIDATION_ERROR';
      errorMessage: string;
    };
    return {
      outcome: 'FAILED',
      lookupStatus: mapErrorCodeToLookupStatus(failedRes.errorCode),
      errorCode: failedRes.errorCode,
      errorMessage: failedRes.errorMessage,
    };
  }
  const normalized = normRes.normalized;

  const requireRev = Boolean(options?.requireVerifiedSourceRevision);
  const expectedEp = (
    options?.expectedEpisodeId ?? normalized.triggerEpisodeId
  ).trim();
  const expectedRevOverride = (options?.expectedSourceRevisionId || '').trim();
  const revOwnerUid = (options?.sourceRevisionOwnerId || normalized.ownerId).trim();
  const revProjectId = (
    options?.sourceRevisionProjectId || normalized.projectId
  ).trim();

  if (requireRev) {
    if (
      !normalized.sourceRevisionId ||
      normalized.sourceRevisionId === 'UNSAVED_DRAFT' ||
      !SAFE_PROPOSAL_ID_REGEX.test(normalized.sourceRevisionId)
    ) {
      return {
        outcome: 'FAILED',
        lookupStatus: 'SOURCE_REVISION_UNVERIFIED',
        errorCode: 'SOURCE_REVISION_UNVERIFIED',
        errorMessage: `[SOURCE_REVISION_UNVERIFIED] 유효한 sourceRevisionId가 없어 제안서(${normalized.id}) 저장을 거부했습니다.`,
      };
    }
    if (!expectedEp) {
      return {
        outcome: 'FAILED',
        lookupStatus: 'SOURCE_REVISION_UNVERIFIED',
        errorCode: 'SOURCE_REVISION_UNVERIFIED',
        errorMessage: `[SOURCE_REVISION_UNVERIFIED] 회차 정보(episodeId)가 누락되어 리비전(${normalized.sourceRevisionId}) 출처를 검증할 수 없습니다.`,
      };
    }
    if (normalized.sourceRevisionId === expectedEp) {
      return {
        outcome: 'FAILED',
        lookupStatus: 'SOURCE_REVISION_UNVERIFIED',
        errorCode: 'SOURCE_REVISION_UNVERIFIED',
        errorMessage: `[SOURCE_REVISION_UNVERIFIED] episodeId(${expectedEp})를 sourceRevisionId로 사용할 수 없습니다.`,
      };
    }
    if (
      normalized.triggerEpisodeId &&
      expectedEp &&
      normalized.triggerEpisodeId !== expectedEp
    ) {
      return {
        outcome: 'FAILED',
        lookupStatus: 'SOURCE_REVISION_MISMATCH',
        errorCode: 'SOURCE_REVISION_MISMATCH',
        errorMessage: `[SOURCE_REVISION_MISMATCH] 제안서의 triggerEpisodeId('${normalized.triggerEpisodeId}')가 요청 회차('${expectedEp}')와 일치하지 않습니다.`,
      };
    }
    if (
      expectedRevOverride &&
      normalized.sourceRevisionId !== expectedRevOverride
    ) {
      return {
        outcome: 'FAILED',
        lookupStatus: 'SOURCE_REVISION_MISMATCH',
        errorCode: 'SOURCE_REVISION_MISMATCH',
        errorMessage: `[SOURCE_REVISION_MISMATCH] 제안서의 sourceRevisionId('${normalized.sourceRevisionId}')가 기대 리비전('${expectedRevOverride}')과 일치하지 않습니다.`,
      };
    }
    if (
      !SAFE_PROPOSAL_ID_REGEX.test(revOwnerUid) ||
      !SAFE_PROPOSAL_ID_REGEX.test(revProjectId)
    ) {
      return {
        outcome: 'FAILED',
        lookupStatus: 'PERMISSION_DENIED',
        errorCode: 'PERMISSION_DENIED',
        errorMessage: '[PERMISSION_DENIED] 유효하지 않은 리비전 경로 소유자 또는 프로젝트 ID입니다.',
      };
    }
  }

  const propRef = doc(
    firestoreDb,
    `users/${normalized.ownerId}/projects/${normalized.projectId}/changeProposals/${normalized.id}`
  );
  const revRef = requireRev
    ? doc(
        firestoreDb,
        `users/${revOwnerUid}/projects/${revProjectId}/revisions/${normalized.sourceRevisionId}`
      )
    : null;

  const expectedHash = (
    options?.expectedContentHashByRevisionId?.[normalized.sourceRevisionId] ||
    options?.expectedSourceContentHash ||
    ''
  ).trim();

  return runTransaction(firestoreDb, async (tx) => {
    // Phase 1: ALL Firestore reads strictly BEFORE any write
    const propSnap = await tx.get(propRef);
    const revSnap = revRef ? await tx.get(revRef) : null;

    if (propSnap.exists()) {
      const existingData = propSnap.data() || {};
      if (
        typeof existingData.ownerId === 'string' &&
        existingData.ownerId.trim() !== normalized.ownerId
      ) {
        return {
          outcome: 'FAILED',
          lookupStatus: 'PERMISSION_DENIED',
          errorCode: 'PROPOSAL_OWNER_MISMATCH',
          errorMessage: `[PROPOSAL_OWNER_MISMATCH] 기존 제안서 소유자('${existingData.ownerId}')가 인증된 소유자('${normalized.ownerId}')와 일치하지 않습니다.`,
        };
      }

      const existingStatus = normalizeToCanonStatus(existingData.canonStatus);
      const isDecided =
        existingStatus !== 'PROPOSED' && existingStatus !== 'DRAFT';

      const equiv = areProposalsSemanticallyEquivalent(existingData, normalized);
      if (!equiv.equivalent) {
        return {
          outcome: equiv.errorCode === 'PROPOSAL_OWNER_MISMATCH' ? 'FAILED' : 'CONFLICT',
          lookupStatus: isDecided
            ? 'DOCUMENT_EXISTS_DECIDED'
            : 'DOCUMENT_EXISTS_PROPOSED',
          errorCode: equiv.errorCode || 'PROPOSAL_PAYLOAD_CONFLICT',
          canonStatus: existingStatus,
          errorMessage: equiv.reason,
        };
      }

      if (isDecided) {
        return {
          outcome: 'SKIPPED_ALREADY_DECIDED',
          lookupStatus: 'DOCUMENT_EXISTS_DECIDED',
          canonStatus: existingStatus,
        };
      }

      if (requireRev && revSnap) {
        const revCheck = verifyPersistedRevisionSnapshot({
          exists: revSnap.exists(),
          revisionData: revSnap.exists() ? revSnap.data() : null,
          revisionDocId: normalized.sourceRevisionId,
          expectedOwnerId: normalized.ownerId,
          expectedProjectId: normalized.projectId,
          expectedEpisodeId: expectedEp,
          expectedContentHash: expectedHash,
        });
        if (!revCheck.valid) {
          return {
            outcome: 'FAILED',
            lookupStatus: revCheck.lookupStatus,
            errorCode: revCheck.errorCode,
            canonStatus: existingStatus,
            errorMessage: revCheck.errorMessage,
          };
        }
      }

      return {
        outcome: 'SKIPPED_ALREADY_EXISTS',
        lookupStatus: 'DOCUMENT_EXISTS_PROPOSED',
        canonStatus: existingStatus,
      };
    }

    // New document creation: verify Revision provenance strictly BEFORE tx.set!
    if (requireRev) {
      const revCheck = verifyPersistedRevisionSnapshot({
        exists: Boolean(revSnap && revSnap.exists()),
        revisionData: revSnap && revSnap.exists() ? revSnap.data() : null,
        revisionDocId: normalized.sourceRevisionId,
        expectedOwnerId: normalized.ownerId,
        expectedProjectId: normalized.projectId,
        expectedEpisodeId: expectedEp,
        expectedContentHash: expectedHash,
      });
      if (!revCheck.valid) {
        return {
          outcome: 'FAILED',
          lookupStatus: revCheck.lookupStatus,
          errorCode: revCheck.errorCode,
          errorMessage: revCheck.errorMessage,
        };
      }
    }

    tx.set(propRef, buildCanonicalChangeProposalWriteDataFromNormalized(normalized));
    return {
      outcome: 'CREATED',
      lookupStatus: 'DOCUMENT_NOT_FOUND',
      canonStatus: 'PROPOSED',
    };
  });
}

export async function persistFirestoreChangeProposalsIdempotently(
  uid: string,
  projectId: string,
  proposals: ChangeProposal[],
  firestoreDb: Firestore = db,
  options?: PersistChangeProposalsOptions
): Promise<PersistChangeProposalsResult> {
  return persistChangeProposalsIdempotentlyCore(
    proposals,
    {
      persistProposalAtomically: (proposal, opts) =>
        persistSingleFirestoreProposalAtomically(
          firestoreDb,
          uid,
          projectId,
          proposal,
          opts
        ),
    },
    options
  );
}

export function formatProposalPersistenceErrorSummaryKo(
  itemResults: PersistedProposalItemResult[]
): string {
  const failed = itemResults.filter((r) => r.status === 'FAILED');
  if (failed.length === 0) return '';
  const codes = Array.from(
    new Set(failed.map((f) => f.errorCode).filter(Boolean))
  ) as ProposalPersistenceErrorCode[];

  const labels = codes.map((c) => {
    switch (c) {
      case 'SOURCE_REVISION_NOT_FOUND':
        return '참조 원고 리비전을 저장소에서 찾을 수 없습니다(SOURCE_REVISION_NOT_FOUND)';
      case 'SOURCE_REVISION_MISMATCH':
        return '참조 원고 리비전의 회차·프로젝트가 일치하지 않습니다(SOURCE_REVISION_MISMATCH)';
      case 'SOURCE_REVISION_UNVERIFIED':
        return '검증된 원고 리비전 출처가 누락되었습니다(SOURCE_REVISION_UNVERIFIED)';
      case 'SOURCE_REVISION_CONTENT_MISMATCH':
        return '원고 리비전 본문 해시가 일치하지 않습니다(SOURCE_REVISION_CONTENT_MISMATCH)';
      case 'PROPOSAL_PAYLOAD_CONFLICT':
      case 'CONFLICT':
        return '동일한 제안서 ID에 서로 다른 내용이 전달되어 덮어쓰기를 차단했습니다(PROPOSAL_PAYLOAD_CONFLICT)';
      case 'PROPOSAL_OWNER_MISMATCH':
        return '제안서 소유자가 인증된 사용자와 일치하지 않습니다(PROPOSAL_OWNER_MISMATCH)';
      case 'PERMISSION_DENIED':
        return 'Firestore 보안 권한이 거부되었습니다(PERMISSION_DENIED)';
      case 'NETWORK_ERROR':
        return '일시적 네트워크 오류로 저장에 실패했습니다(NETWORK_ERROR)';
      case 'VALIDATION_ERROR':
        return '제안서 입력값 규격 검증에 실패했습니다(VALIDATION_ERROR)';
      default:
        return '설정 제안 저장 중 알 수 없는 오류가 발생했습니다';
    }
  });

  return `총 ${failed.length}건 실패 · ${labels.join(' / ')}`;
}

export async function updateFirestoreChangeProposal(
  uid: string,
  projectId: string,
  proposal: ChangeProposal
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/changeProposals/${proposal.id}`;
  try {
    await updateDoc(doc(db, path), {
      title: proposal.title,
      rationale: proposal.rationale,
      beforeSummary: proposal.beforeSummary,
      afterSummary: proposal.afterSummary,
      proposedPayloadJson: proposal.proposedPayloadJson,
      canonStatus: normalizeToCanonStatus(proposal.canonStatus),
      reviewedAt: proposal.reviewedAt || '',
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function fetchFirestoreFoundationCollections(
  uid: string,
  projectId: string
): Promise<Required<AdvancedFoundationCollections>> {
  const basePath = `users/${uid}/projects/${projectId}`;

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

// ============================================================================
// Phase 2: AI Writing Engine Firestore Operations (PromptProfiles & WritingPlans)
// ============================================================================

export async function createFirestorePromptProfile(
  uid: string,
  projectId: string,
  profile: PromptProfile
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/writingPromptProfiles/${profile.id}`;
  try {
    await setDoc(doc(db, path), {
      id: profile.id,
      ownerId: uid,
      projectId,
      promptType: profile.promptType,
      title: profile.title.slice(0, 150),
      description: (profile.description || '').slice(0, 1000),
      targetCharacterId: profile.targetCharacterId || '',
      content: profile.content.slice(0, 100000),
      isActive: Boolean(profile.isActive),
      currentVersionId: profile.currentVersionId,
      currentVersionNumber: Math.max(1, Math.round(profile.currentVersionNumber)),
      versions: (profile.versions || []).slice(0, 30),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateFirestorePromptProfile(
  uid: string,
  projectId: string,
  profile: PromptProfile
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/writingPromptProfiles/${profile.id}`;
  try {
    await updateDoc(doc(db, path), {
      promptType: profile.promptType,
      title: profile.title.slice(0, 150),
      description: (profile.description || '').slice(0, 1000),
      targetCharacterId: profile.targetCharacterId || '',
      content: profile.content.slice(0, 100000),
      isActive: Boolean(profile.isActive),
      currentVersionId: profile.currentVersionId,
      currentVersionNumber: Math.max(1, Math.round(profile.currentVersionNumber)),
      versions: (profile.versions || []).slice(0, 30),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteFirestorePromptProfile(
  uid: string,
  projectId: string,
  profileId: string
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/writingPromptProfiles/${profileId}`;
  try {
    await deleteDoc(doc(db, path));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

// ============================================================================
// Phase 4.3C Stage 1.1: PromptProfile Version CAS & Atomic StyleProfile + PromptProfile Commit
// ============================================================================

const SAFE_ENTITY_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const VALID_PROMPT_TYPES = new Set([
  'CORE_WRITING_RULES',
  'PROJECT_STYLE_PROFILE',
  'CHARACTER_DIALOGUE_RULES',
  'SCENE_INSTRUCTIONS',
  'REVIEW_RULES',
]);
const VALID_NARRATIVE_PERSPECTIVES = new Set([
  'FIRST_PERSON',
  'THIRD_LIMITED',
  'OMNISCIENT',
  'MIXED',
]);

export function parsePromptProfileFromFirestoreData(
  docId: string,
  data: Record<string, unknown>,
  fallbackOwnerId: string,
  fallbackProjectId: string
): PromptProfile {
  return {
    id: String(data.id ?? docId),
    ownerId: String(data.ownerId ?? fallbackOwnerId),
    projectId: String(data.projectId ?? fallbackProjectId),
    promptType:
      data.promptType === 'PROJECT_STYLE_PROFILE' ||
      data.promptType === 'CHARACTER_DIALOGUE_RULES' ||
      data.promptType === 'SCENE_INSTRUCTIONS' ||
      data.promptType === 'REVIEW_RULES'
        ? data.promptType
        : 'CORE_WRITING_RULES',
    title: String(data.title ?? ''),
    description: String(data.description ?? ''),
    targetCharacterId: data.targetCharacterId
      ? String(data.targetCharacterId)
      : undefined,
    content: String(data.content ?? ''),
    isActive: Boolean(data.isActive),
    currentVersionId: String(data.currentVersionId ?? 'pver_1'),
    currentVersionNumber: Number(data.currentVersionNumber ?? 1),
    versions: Array.isArray(data.versions) ? data.versions : [],
    createdAt: toIsoString(data.createdAt),
    updatedAt: toIsoString(data.updatedAt),
  };
}

export function parseStyleProfileFromFirestoreData(
  docId: string,
  data: Record<string, unknown>,
  fallbackOwnerId: string,
  fallbackProjectId: string
): StyleProfile {
  const canonStatus =
    isValidCanonStatus(data.canonStatus) ||
    data.canonStatus === 'draft' ||
    data.canonStatus === 'confirmed'
      ? data.canonStatus
      : undefined;

  return {
    id: String(data.id ?? docId),
    ownerId: String(data.ownerId ?? fallbackOwnerId),
    projectId: String(data.projectId ?? fallbackProjectId),
    name: String(data.name ?? ''),
    narrativePerspective:
      data.narrativePerspective === 'FIRST_PERSON' ||
      data.narrativePerspective === 'OMNISCIENT' ||
      data.narrativePerspective === 'MIXED'
        ? data.narrativePerspective
        : 'THIRD_LIMITED',
    dialogueRatio: Number(data.dialogueRatio ?? 0),
    avgSentenceLength: Number(data.avgSentenceLength ?? 0),
    toneKeywords: Array.isArray(data.toneKeywords)
      ? data.toneKeywords.map(String)
      : [],
    preferredExpressions: Array.isArray(data.preferredExpressions)
      ? data.preferredExpressions.map(String)
      : [],
    prohibitedExpressions: Array.isArray(data.prohibitedExpressions)
      ? data.prohibitedExpressions.map(String)
      : [],
    sampleExcerpt: String(data.sampleExcerpt ?? ''),
    canonStatus: normalizeToCanonStatus(canonStatus),
    sourceRevisionId: String(data.sourceRevisionId ?? ''),
    createdAt: toIsoString(data.createdAt),
    updatedAt: toIsoString(data.updatedAt),
  };
}

export async function fetchFirestorePromptProfileById(
  uid: string,
  projectId: string,
  profileId: string,
  firestoreDb: Firestore = db
): Promise<PromptProfile | null> {
  const path = `users/${uid}/projects/${projectId}/writingPromptProfiles/${profileId}`;
  try {
    const snap = await getDoc(doc(firestoreDb, path));
    if (!snap.exists()) return null;
    return parsePromptProfileFromFirestoreData(
      snap.id,
      snap.data() as Record<string, unknown>,
      uid,
      projectId
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export function validatePromptProfileForFirestoreSchema(
  uid: string,
  projectId: string,
  profile: PromptProfile
): { valid: boolean; reasonKo?: string } {
  if (!SAFE_ENTITY_ID_REGEX.test(profile.id)) {
    return { valid: false, reasonKo: '유효하지 않은 PromptProfile ID 형식입니다.' };
  }
  if (profile.ownerId !== uid) {
    return { valid: false, reasonKo: 'PromptProfile 소유자(ownerId)가 일치하지 않습니다.' };
  }
  if (profile.projectId !== projectId) {
    return { valid: false, reasonKo: 'PromptProfile 프로젝트(projectId)가 일치하지 않습니다.' };
  }
  if (!VALID_PROMPT_TYPES.has(profile.promptType)) {
    return { valid: false, reasonKo: '허용되지 않는 promptType입니다.' };
  }
  const titleLen = (profile.title || '').trim().length;
  if (titleLen < 1 || profile.title.length > 150) {
    return { valid: false, reasonKo: '프롬프트 제목은 1~150자 이내여야 합니다.' };
  }
  if ((profile.description || '').length > 1000) {
    return { valid: false, reasonKo: '프롬프트 설명은 1,000자 이하여야 합니다.' };
  }
  if (typeof profile.content !== 'string' || profile.content.length > 100000) {
    return { valid: false, reasonKo: '프롬프트 본문은 100,000자 이하여야 합니다.' };
  }
  if (!SAFE_ENTITY_ID_REGEX.test(profile.currentVersionId)) {
    return { valid: false, reasonKo: '유효하지 않은 currentVersionId입니다.' };
  }
  if (
    !Number.isInteger(profile.currentVersionNumber) ||
    profile.currentVersionNumber < 1 ||
    profile.currentVersionNumber > 10000
  ) {
    return { valid: false, reasonKo: 'currentVersionNumber는 1~10,000 범위의 정수여야 합니다.' };
  }
  if (
    !Array.isArray(profile.versions) ||
    profile.versions.length < 1 ||
    profile.versions.length > 30 ||
    typeof profile.versions[0] !== 'object' ||
    profile.versions[0] === null
  ) {
    return {
      valid: false,
      reasonKo: '프롬프트 버전 기록(versions)은 1~30개의 유효한 버전 객체 배열이어야 합니다.',
    };
  }
  return { valid: true };
}

export function validateStyleProfileForFirestoreSchema(
  uid: string,
  projectId: string,
  profile: StyleProfile
): { valid: boolean; reasonKo?: string } {
  if (!SAFE_ENTITY_ID_REGEX.test(profile.id)) {
    return { valid: false, reasonKo: '유효하지 않은 StyleProfile ID 형식입니다.' };
  }
  if (profile.ownerId !== uid) {
    return { valid: false, reasonKo: 'StyleProfile 소유자(ownerId)가 일치하지 않습니다.' };
  }
  if (profile.projectId !== projectId) {
    return { valid: false, reasonKo: 'StyleProfile 프로젝트(projectId)가 일치하지 않습니다.' };
  }
  const nameLen = (profile.name || '').trim().length;
  if (nameLen < 1 || profile.name.length > 120) {
    return { valid: false, reasonKo: '문체 프로필 이름은 1~120자 이내여야 합니다.' };
  }
  if (!VALID_NARRATIVE_PERSPECTIVES.has(profile.narrativePerspective)) {
    return { valid: false, reasonKo: '유효하지 않은 narrativePerspective입니다.' };
  }
  if (
    !Number.isInteger(profile.dialogueRatio) ||
    profile.dialogueRatio < 0 ||
    profile.dialogueRatio > 100
  ) {
    return { valid: false, reasonKo: 'dialogueRatio는 0~100 사이의 정수여야 합니다.' };
  }
  if (
    !Number.isInteger(profile.avgSentenceLength) ||
    profile.avgSentenceLength < 0 ||
    profile.avgSentenceLength > 1000
  ) {
    return { valid: false, reasonKo: 'avgSentenceLength는 0~1,000 사이의 정수여야 합니다.' };
  }
  if (
    !Array.isArray(profile.toneKeywords) ||
    profile.toneKeywords.length > 50 ||
    !Array.isArray(profile.preferredExpressions) ||
    profile.preferredExpressions.length > 50 ||
    !Array.isArray(profile.prohibitedExpressions) ||
    profile.prohibitedExpressions.length > 50
  ) {
    return { valid: false, reasonKo: '문체 키워드/표현 배열은 최대 50개까지 허용됩니다.' };
  }
  if (typeof profile.sampleExcerpt !== 'string' || profile.sampleExcerpt.length > 3000) {
    return { valid: false, reasonKo: 'sampleExcerpt는 최대 3,000자까지 허용됩니다.' };
  }
  return { valid: true };
}

class StyleCasTransactionAbortError extends Error {
  public readonly status: StyleApprovalPersistenceStatus | PromptProfileCasErrorCode;
  public readonly conflictDetails?: StyleApprovalConflictDetails;
  public readonly remotePromptProfile?: PromptProfile;

  constructor(params: {
    status: StyleApprovalPersistenceStatus | PromptProfileCasErrorCode;
    message: string;
    conflictDetails?: StyleApprovalConflictDetails;
    remotePromptProfile?: PromptProfile;
  }) {
    super(params.message);
    this.name = 'StyleCasTransactionAbortError';
    this.status = params.status;
    this.conflictDetails = params.conflictDetails;
    this.remotePromptProfile = params.remotePromptProfile;
  }
}

export function classifyStylePersistenceError(error: unknown): {
  persistenceStatus: StyleApprovalPersistenceStatus;
  casErrorCode: PromptProfileCasErrorCode;
  messageKo: string;
  conflictDetails?: StyleApprovalConflictDetails;
  remotePromptProfile?: PromptProfile;
} {
  if (error instanceof StyleCasTransactionAbortError) {
    const persistenceStatus: StyleApprovalPersistenceStatus =
      error.status === 'VERSION_CONFLICT'
        ? 'VERSION_CONFLICT'
        : error.status === 'PERMISSION_DENIED' || error.status === 'TENANT_ISOLATION'
        ? 'PERMISSION_DENIED'
        : error.status === 'VALIDATION_FAILED'
        ? 'VALIDATION_FAILED'
        : error.status === 'NETWORK_FAILED'
        ? 'NETWORK_FAILED'
        : 'NOT_COMMITTED';
    const casErrorCode: PromptProfileCasErrorCode =
      error.status === 'VERSION_CONFLICT'
        ? 'VERSION_CONFLICT'
        : error.status === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : error.status === 'PERMISSION_DENIED'
        ? 'PERMISSION_DENIED'
        : error.status === 'TENANT_ISOLATION'
        ? 'TENANT_ISOLATION'
        : error.status === 'VALIDATION_FAILED'
        ? 'VALIDATION_FAILED'
        : 'NETWORK_FAILED';
    return {
      persistenceStatus,
      casErrorCode,
      messageKo: error.message,
      conflictDetails: error.conflictDetails,
      remotePromptProfile: error.remotePromptProfile,
    };
  }

  const rawMsg = error instanceof Error ? error.message : String(error ?? '');
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  const combined = `${code} ${rawMsg}`.toLowerCase();

  if (
    combined.includes('permission-denied') ||
    combined.includes('permission_denied') ||
    combined.includes('missing or insufficient permissions') ||
    combined.includes('canon_protection') ||
    combined.includes('확정(canon) 상태의 데이터는 ai가 직접')
  ) {
    return {
      persistenceStatus: 'PERMISSION_DENIED',
      casErrorCode: 'PERMISSION_DENIED',
      messageKo: `권한 또는 보안 규칙 거부(PERMISSION_DENIED): ${rawMsg || '문서 접근 권한이 없습니다.'}`,
    };
  }

  if (
    combined.includes('version_conflict') ||
    combined.includes('aborted') ||
    combined.includes('failed-precondition')
  ) {
    return {
      persistenceStatus: 'VERSION_CONFLICT',
      casErrorCode: 'VERSION_CONFLICT',
      messageKo: `동시 수정 버전 충돌(VERSION_CONFLICT): ${rawMsg || '다른 탭에서 먼저 수정되었습니다.'}`,
    };
  }

  if (
    combined.includes('invalid-argument') ||
    combined.includes('validation') ||
    combined.includes('유효하지 않은')
  ) {
    return {
      persistenceStatus: 'VALIDATION_FAILED',
      casErrorCode: 'VALIDATION_FAILED',
      messageKo: `스키마 검증 실패(VALIDATION_FAILED): ${rawMsg}`,
    };
  }

  if (
    combined.includes('unavailable') ||
    combined.includes('network') ||
    combined.includes('deadline-exceeded')
  ) {
    return {
      persistenceStatus: 'NETWORK_FAILED',
      casErrorCode: 'NETWORK_FAILED',
      messageKo: `네트워크 또는 서버 연결 오류(NETWORK_FAILED): ${rawMsg}`,
    };
  }

  return {
    persistenceStatus: 'NOT_COMMITTED',
    casErrorCode: 'VALIDATION_FAILED',
    messageKo: rawMsg || '트랜잭션이 커밋되지 않았습니다(NOT_COMMITTED).',
  };
}

/**
 * Merges remote version history with the incoming PromptProfile's new version
 * so prior versions are never dropped during a CAS update or version restoration.
 */
function mergePromptVersionHistoryPreservingPrior(
  remoteProfile: PromptProfile,
  incomingProfile: PromptProfile
): PromptProfile['versions'] {
  const seen = new Set<string>();
  const merged: PromptProfile['versions'] = [];

  for (const v of incomingProfile.versions || []) {
    if (v && v.versionId && !seen.has(v.versionId)) {
      seen.add(v.versionId);
      merged.push(v);
    }
  }
  for (const v of remoteProfile.versions || []) {
    if (v && v.versionId && !seen.has(v.versionId)) {
      seen.add(v.versionId);
      merged.push(v);
    }
  }

  return merged.slice(0, 30);
}

/**
 * P0-B Pure Testable CAS Core for PromptProfile updates.
 * Can be executed against an in-memory transactional store or wrapped by real Firestore `runTransaction`.
 */
export async function updatePromptProfileWithCasCore(params: {
  uid: string;
  projectId: string;
  nextProfile: PromptProfile;
  expectedVersionId?: string;
  expectedVersionNumber?: number;
  storageMode: 'CLOUD_FIRESTORE' | 'LOCAL_STORE';
  getRemoteProfileInTx: () => Promise<PromptProfile | null>;
  writeProfileInTx: (committedProfile: PromptProfile) => Promise<void>;
}): Promise<PromptProfileCasResult> {
  const {
    uid,
    projectId,
    nextProfile,
    expectedVersionId,
    expectedVersionNumber,
    storageMode,
    getRemoteProfileInTx,
    writeProfileInTx,
  } = params;

  const remoteProfile = await getRemoteProfileInTx();
  if (!remoteProfile) {
    throw new StyleCasTransactionAbortError({
      status: 'NOT_FOUND',
      message: `대상 프롬프트 프로필('${nextProfile.id}')이 존재하지 않습니다. 신규 생성 경로를 사용해 주세요.`,
    });
  }

  if (remoteProfile.ownerId !== uid) {
    throw new StyleCasTransactionAbortError({
      status: 'PERMISSION_DENIED',
      message: '프롬프트 프로필 소유자(ownerId)가 일치하지 않아 수정이 거부되었습니다.',
      remotePromptProfile: remoteProfile,
    });
  }

  if (remoteProfile.projectId !== projectId) {
    throw new StyleCasTransactionAbortError({
      status: 'TENANT_ISOLATION',
      message: '다른 작품(projectId)의 프롬프트 프로필은 수정할 수 없습니다.',
      remotePromptProfile: remoteProfile,
    });
  }

  if (remoteProfile.promptType !== nextProfile.promptType) {
    throw new StyleCasTransactionAbortError({
      status: 'VALIDATION_FAILED',
      message: `프롬프트 유형(promptType: ${remoteProfile.promptType})은 다른 유형(${nextProfile.promptType})으로 변경할 수 없습니다.`,
      remotePromptProfile: remoteProfile,
    });
  }

  const versionIdMismatch =
    expectedVersionId !== undefined &&
    remoteProfile.currentVersionId !== expectedVersionId;
  const versionNumberMismatch =
    expectedVersionNumber !== undefined &&
    remoteProfile.currentVersionNumber !== expectedVersionNumber;

  if (versionIdMismatch || versionNumberMismatch) {
    const conflictDetails: StyleApprovalConflictDetails = {
      expectedVersionId,
      actualVersionId: remoteProfile.currentVersionId,
      expectedVersionNumber,
      actualVersionNumber: remoteProfile.currentVersionNumber,
      remotePromptProfile: remoteProfile,
      reasonKo: `다른 탭에서 '${remoteProfile.title}' 프로필이 이미 v${remoteProfile.currentVersionNumber}(${remoteProfile.currentVersionId}) 버전으로 업데이트되었습니다.`,
    };
    throw new StyleCasTransactionAbortError({
      status: 'VERSION_CONFLICT',
      message: conflictDetails.reasonKo!,
      conflictDetails,
      remotePromptProfile: remoteProfile,
    });
  }

  const mergedVersions = mergePromptVersionHistoryPreservingPrior(
    remoteProfile,
    nextProfile
  );

  const candidateToCommit: PromptProfile = {
    ...nextProfile,
    id: remoteProfile.id,
    ownerId: remoteProfile.ownerId,
    projectId: remoteProfile.projectId,
    promptType: remoteProfile.promptType,
    versions: mergedVersions,
    createdAt: remoteProfile.createdAt,
    updatedAt: nextProfile.updatedAt || new Date().toISOString(),
  };

  const schemaCheck = validatePromptProfileForFirestoreSchema(
    uid,
    projectId,
    candidateToCommit
  );
  if (!schemaCheck.valid) {
    throw new StyleCasTransactionAbortError({
      status: 'VALIDATION_FAILED',
      message: schemaCheck.reasonKo || 'PromptProfile 스키마 검증 실패',
      remotePromptProfile: remoteProfile,
    });
  }

  await writeProfileInTx(candidateToCommit);

  return {
    committed: true,
    status: 'COMMITTED',
    storageMode,
    profile: candidateToCommit,
  };
}

/**
 * P0-B Real Firestore Transaction CAS for PromptProfile updates.
 */
export async function updateFirestorePromptProfileWithCas(
  uid: string,
  projectId: string,
  nextProfile: PromptProfile,
  options?: {
    expectedVersionId?: string;
    expectedVersionNumber?: number;
  },
  firestoreDb: Firestore = db
): Promise<PromptProfileCasResult> {
  const path = `users/${uid}/projects/${projectId}/writingPromptProfiles/${nextProfile.id}`;
  const profileRef = doc(firestoreDb, path);

  try {
    return await runTransaction(firestoreDb, async (tx) => {
      return await updatePromptProfileWithCasCore({
        uid,
        projectId,
        nextProfile,
        expectedVersionId: options?.expectedVersionId,
        expectedVersionNumber: options?.expectedVersionNumber,
        storageMode: 'CLOUD_FIRESTORE',
        getRemoteProfileInTx: async () => {
          const snap = await tx.get(profileRef);
          if (!snap.exists()) return null;
          return parsePromptProfileFromFirestoreData(
            snap.id,
            snap.data() as Record<string, unknown>,
            uid,
            projectId
          );
        },
        writeProfileInTx: async (committed) => {
          tx.update(profileRef, {
            promptType: committed.promptType,
            title: committed.title.slice(0, 150),
            description: (committed.description || '').slice(0, 1000),
            targetCharacterId: committed.targetCharacterId || '',
            content: committed.content.slice(0, 100000),
            isActive: Boolean(committed.isActive),
            currentVersionId: committed.currentVersionId,
            currentVersionNumber: Math.max(
              1,
              Math.round(committed.currentVersionNumber)
            ),
            versions: (committed.versions || []).slice(0, 30),
            updatedAt: serverTimestamp(),
          });
        },
      });
    });
  } catch (error) {
    const classified = classifyStylePersistenceError(error);
    return {
      committed: false,
      status: classified.casErrorCode,
      storageMode: 'CLOUD_FIRESTORE',
      profile: classified.remotePromptProfile || nextProfile,
      remoteProfile: classified.remotePromptProfile,
      errorMessage: classified.messageKo,
      conflictDetails: classified.conflictDetails,
    };
  }
}

export async function updateLocalPromptProfileWithCas(params: {
  uid: string;
  projectId: string;
  nextProfile: PromptProfile;
  existingProfiles: PromptProfile[];
  expectedVersionId?: string;
  expectedVersionNumber?: number;
}): Promise<PromptProfileCasResult> {
  const existing =
    params.existingProfiles.find((p) => p.id === params.nextProfile.id) || null;
  let committedSnapshot: PromptProfile = params.nextProfile;
  try {
    const res = await updatePromptProfileWithCasCore({
      uid: params.uid,
      projectId: params.projectId,
      nextProfile: params.nextProfile,
      expectedVersionId: params.expectedVersionId,
      expectedVersionNumber: params.expectedVersionNumber,
      storageMode: 'LOCAL_STORE',
      getRemoteProfileInTx: async () => existing,
      writeProfileInTx: async (committed) => {
        committedSnapshot = committed;
      },
    });
    return {
      ...res,
      profile: committedSnapshot,
    };
  } catch (error) {
    const classified = classifyStylePersistenceError(error);
    return {
      committed: false,
      status: classified.casErrorCode,
      storageMode: 'LOCAL_STORE',
      profile: classified.remotePromptProfile || params.nextProfile,
      remoteProfile: classified.remotePromptProfile,
      errorMessage: classified.messageKo,
      conflictDetails: classified.conflictDetails,
    };
  }
}

export interface AtomicStylePersistenceOptions {
  actor?: ActorType;
  nowIso?: string;
  forcedStyleProfileId?: string;
  forcedPromptProfileId?: string;
  /** Used ONLY in security rule / failure tests to allow invalid payloads to reach Firestore rules or simulate 2nd-write failure */
  bypassClientSchemaCheckForTest?: boolean;
  simulateSecondWriteFailureForTest?: boolean;
  rawPromptWriteOverrideForTest?: Record<string, unknown>;
  rawStyleWriteOverrideForTest?: Record<string, unknown>;
}

function resolveStyleApprovalTargets(
  payload: StyleApprovalPayload,
  options?: AtomicStylePersistenceOptions
): { isCreateNewPrompt: boolean; styleProfileId: string; promptProfileId: string } {
  const isCreateNewPrompt = Boolean(payload.createNewProfileInsteadOfOverwrite) || !payload.targetPromptProfileId;
  const key = payload.idempotencyKey;
  const operationId = key && /^[A-Za-z0-9_-]{1,120}$/.test(key) ? key : undefined;

  return {
    isCreateNewPrompt,
    styleProfileId: payload.existingStyleProfileId || options?.forcedStyleProfileId ||
      (operationId ? `style_${operationId}` : generateEntityId('style')),
    promptProfileId: isCreateNewPrompt
      ? options?.forcedPromptProfileId || payload.targetPromptProfileId ||
        (operationId ? `prompt_${operationId}` : generateEntityId('prompt'))
      : payload.targetPromptProfileId!,
  };
}

/**
 * P0-C Pure Testable Atomic StyleProfile + PromptProfile Transaction Core.
 * Enforces:
 * 1. All reads (styleRef + promptRef) strictly before any writes.
 * 2. CREATE_NEW vs UPDATE_EXISTING CAS checks (no silent overwrite or silent auto-fork).
 * 3. CANON protection on existing StyleProfile.
 * 4. Strict schema validation matching firestore.rules.
 * 5. Idempotency guard (duplicate retry returns COMMITTED with deduplicated: true without creating duplicate version).
 * 6. Atomic write of both documents (or 0 documents on any error).
 */
export async function persistApprovedStyleDnaAtomicallyCore(params: {
  uid: string;
  projectId: string;
  payload: StyleApprovalPayload;
  storageMode: 'CLOUD_FIRESTORE' | 'LOCAL_STORE';
  options?: AtomicStylePersistenceOptions;
  readDocsInTx: (ids: {
    styleProfileId: string;
    promptProfileId: string;
  }) => Promise<{
    existingStyleProfile: StyleProfile | null;
    existingPromptProfile: PromptProfile | null;
  }>;
  writeDocsInTx: (writes: {
    styleProfile: StyleProfile;
    promptProfile: PromptProfile;
    isNewStyleDoc: boolean;
    isNewPromptDoc: boolean;
  }) => Promise<void>;
}): Promise<StyleProfileApplicationResult> {
  const { uid, projectId, payload, storageMode, options, readDocsInTx, writeDocsInTx } =
    params;
  const nowIso = options?.nowIso || new Date().toISOString();
  const actor: ActorType = options?.actor || 'AUTHOR';

  const {
    isCreateNewPrompt,
    styleProfileId: targetStyleProfileId,
    promptProfileId: targetPromptProfileId,
  } = resolveStyleApprovalTargets(payload, options);

  // Fallback object used only when returning a rejected result before commit
  const fallbackPrepared = buildApprovedStyleProfilesForPersistence({
    payload: {
      ...payload,
      ownerId: uid,
      projectId,
      allowAutoBranchOnConflict: false,
    },
    existingStyleProfile: null,
    existingPromptProfile: null,
    nowIso,
  });

  try {
    if (payload.ownerId && payload.ownerId !== uid) {
      throw new StyleCasTransactionAbortError({
        status: 'PERMISSION_DENIED',
        message: '요청자(ownerId)와 인증된 사용자(uid)가 일치하지 않습니다.',
      });
    }
    if (payload.projectId && payload.projectId !== projectId) {
      throw new StyleCasTransactionAbortError({
        status: 'PERMISSION_DENIED',
        message: '대상 작품(projectId)이 일치하지 않습니다.',
      });
    }

    // 1. ALL READS FIRST
    const { existingStyleProfile, existingPromptProfile } = await readDocsInTx({
      styleProfileId: targetStyleProfileId,
      promptProfileId: targetPromptProfileId,
    });

    // 2. VALIDATE EXISTING STYLE PROFILE OWNERSHIP & CANON PROTECTION
    if (existingStyleProfile) {
      if (
        existingStyleProfile.ownerId !== uid ||
        existingStyleProfile.projectId !== projectId
      ) {
        throw new StyleCasTransactionAbortError({
          status: 'PERMISSION_DENIED',
          message: '기존 StyleProfile 소유권 또는 작품 격리 검증에 실패했습니다.',
        });
      }
      assertCanonProtection({
        actor,
        operation: 'UPDATE',
        canonStatus: existingStyleProfile.canonStatus,
      });
    }

    // 3. VALIDATE PROMPT PROFILE CREATE_NEW vs UPDATE_EXISTING & IDEMPOTENCY
    if (isCreateNewPrompt) {
      if (existingPromptProfile) {
        if (
          existingPromptProfile.ownerId !== uid ||
          existingPromptProfile.projectId !== projectId
        ) {
          throw new StyleCasTransactionAbortError({
            status: 'PERMISSION_DENIED',
            message: '동일 ID의 다른 소유자/작품 프롬프트가 이미 존재합니다.',
          });
        }
        // Reuse the committed approval time only for comparison: retry time is
        // embedded in STYLE_DNA_META and must not make an identical request differ.
        const retryPrepared = buildApprovedStyleProfilesForPersistence({
          payload: {
            ...payload,
            ownerId: uid,
            projectId,
            allowAutoBranchOnConflict: false,
          },
          existingStyleProfile,
          existingPromptProfile,
          nowIso: extractStylePromptMetadata(existingPromptProfile.content).approvedAt || nowIso,
        });
        // Check idempotent retry: same source hash, compiled content, and profile settings.
        const isIdempotentCreateRetry =
          existingPromptProfile.promptType === 'PROJECT_STYLE_PROFILE' &&
          existingPromptProfile.content === retryPrepared.promptProfile.content &&
          existingPromptProfile.title === retryPrepared.promptProfile.title &&
          existingPromptProfile.description === retryPrepared.promptProfile.description &&
          existingPromptProfile.isActive === retryPrepared.promptProfile.isActive &&
          Boolean(existingStyleProfile);

        if (isIdempotentCreateRetry && existingStyleProfile) {
          return buildStyleApplicationResult({
            styleProfile: existingStyleProfile,
            promptProfile: existingPromptProfile,
            styleProfileSaved: true,
            promptProfileSaved: true,
            createdNewProfile: true,
            sourceHash: payload.candidate.sourceReference.contentHash,
            baseVersionConflictResolvedByNewProfile: false,
            persistenceStatus: 'COMMITTED',
            storageMode,
            deduplicated: true,
          });
        }

        // Concurrent create with same ID but different content -> reject overwrite!
        throw new StyleCasTransactionAbortError({
          status: 'VERSION_CONFLICT',
          message: `동일한 ID('${targetPromptProfileId}')의 문체 프롬프트 프로필이 이미 생성되어 덮어쓰기가 차단되었습니다.`,
          conflictDetails: {
            actualVersionId: existingPromptProfile.currentVersionId,
            actualVersionNumber: existingPromptProfile.currentVersionNumber,
            remotePromptProfile: existingPromptProfile,
            reasonKo: `동일 ID('${targetPromptProfileId}')로 이미 생성된 프로필(v${existingPromptProfile.currentVersionNumber})이 존재합니다.`,
          },
          remotePromptProfile: existingPromptProfile,
        });
      }
    } else {
      // UPDATE_EXISTING
      if (!existingPromptProfile) {
        throw new StyleCasTransactionAbortError({
          status: 'NOT_COMMITTED',
          message: `업데이트 대상 문체 프롬프트 프로필('${targetPromptProfileId}')이 존재하지 않습니다.`,
        });
      }

      if (
        existingPromptProfile.ownerId !== uid ||
        existingPromptProfile.projectId !== projectId
      ) {
        throw new StyleCasTransactionAbortError({
          status: 'PERMISSION_DENIED',
          message: '기존 PROJECT_STYLE_PROFILE 소유권 또는 작품 격리 검증에 실패했습니다.',
          remotePromptProfile: existingPromptProfile,
        });
      }

      if (existingPromptProfile.promptType !== 'PROJECT_STYLE_PROFILE') {
        throw new StyleCasTransactionAbortError({
          status: 'VALIDATION_FAILED',
          message: `대상 프롬프트('${existingPromptProfile.id}')의 유형이 PROJECT_STYLE_PROFILE이 아닙니다(${existingPromptProfile.promptType}).`,
          remotePromptProfile: existingPromptProfile,
        });
      }

      // Check idempotent retry on UPDATE_EXISTING:
      // If the latest version on the remote profile already matches the exact compiled content & active flag
      // that this approval payload produces, treat as deduplicated success instead of advancing version again.
      const trialPrepared = buildApprovedStyleProfilesForPersistence({
        payload: {
          ...payload,
          ownerId: uid,
          projectId,
          allowAutoBranchOnConflict: false,
        },
        existingStyleProfile,
        existingPromptProfile,
        nowIso: extractStylePromptMetadata(existingPromptProfile.content).approvedAt || nowIso,
      });

      if (
        existingStyleProfile &&
        existingPromptProfile.content === trialPrepared.promptProfile.content &&
        existingPromptProfile.title === trialPrepared.promptProfile.title &&
        existingPromptProfile.isActive === payload.activateOnApprove
      ) {
        return buildStyleApplicationResult({
          styleProfile: existingStyleProfile,
          promptProfile: existingPromptProfile,
          styleProfileSaved: true,
          promptProfileSaved: true,
          createdNewProfile: false,
          sourceHash: payload.candidate.sourceReference.contentHash,
          baseVersionConflictResolvedByNewProfile: false,
          persistenceStatus: 'COMMITTED',
          storageMode,
          deduplicated: true,
        });
      }

      const versionIdMismatch =
        payload.expectedBaseVersionId !== undefined &&
        existingPromptProfile.currentVersionId !== payload.expectedBaseVersionId;
      const versionNumberMismatch =
        payload.expectedBaseVersionNumber !== undefined &&
        existingPromptProfile.currentVersionNumber !==
          payload.expectedBaseVersionNumber;

      if (versionIdMismatch || versionNumberMismatch) {
        const conflictDetails: StyleApprovalConflictDetails = {
          expectedVersionId: payload.expectedBaseVersionId,
          actualVersionId: existingPromptProfile.currentVersionId,
          expectedVersionNumber: payload.expectedBaseVersionNumber,
          actualVersionNumber: existingPromptProfile.currentVersionNumber,
          remotePromptProfile: existingPromptProfile,
          reasonKo: `문체 프로필 버전 충돌(VERSION_CONFLICT): 검토 기준 버전(v${payload.expectedBaseVersionNumber ?? '?'} · ${payload.expectedBaseVersionId ?? '?'})과 최신 저장 버전(v${existingPromptProfile.currentVersionNumber} · ${existingPromptProfile.currentVersionId})이 일치하지 않습니다.`,
        };
        throw new StyleCasTransactionAbortError({
          status: 'VERSION_CONFLICT',
          message: conflictDetails.reasonKo!,
          conflictDetails,
          remotePromptProfile: existingPromptProfile,
        });
      }
    }

    // 4. BUILD PREPARED DOCUMENTS (no silent auto-branch on conflict)
    const prepared = buildApprovedStyleProfilesForPersistence({
      payload: {
        ...payload,
        ownerId: uid,
        projectId,
        createNewProfileInsteadOfOverwrite: isCreateNewPrompt,
        allowAutoBranchOnConflict: false,
      },
      existingStyleProfile,
      existingPromptProfile: isCreateNewPrompt ? null : existingPromptProfile,
      nowIso,
    });

    const finalStyleProfile: StyleProfile = {
      ...prepared.styleProfile,
      id: targetStyleProfileId,
      ownerId: uid,
      projectId,
      createdAt: existingStyleProfile?.createdAt || nowIso,
      updatedAt: nowIso,
    };

    const mergedVersions =
      !isCreateNewPrompt && existingPromptProfile
        ? mergePromptVersionHistoryPreservingPrior(
            existingPromptProfile,
            prepared.promptProfile
          )
        : prepared.promptProfile.versions.slice(0, 30);

    const finalPromptProfile: PromptProfile = {
      ...prepared.promptProfile,
      id: targetPromptProfileId,
      ownerId: uid,
      projectId,
      versions: mergedVersions,
      createdAt:
        (!isCreateNewPrompt && existingPromptProfile?.createdAt) || nowIso,
      updatedAt: nowIso,
    };

    if (!options?.bypassClientSchemaCheckForTest) {
      const styleCheck = validateStyleProfileForFirestoreSchema(
        uid,
        projectId,
        finalStyleProfile
      );
      if (!styleCheck.valid) {
        throw new StyleCasTransactionAbortError({
          status: 'VALIDATION_FAILED',
          message: styleCheck.reasonKo || 'StyleProfile 스키마 검증 실패',
        });
      }

      const promptCheck = validatePromptProfileForFirestoreSchema(
        uid,
        projectId,
        finalPromptProfile
      );
      if (!promptCheck.valid) {
        throw new StyleCasTransactionAbortError({
          status: 'VALIDATION_FAILED',
          message: promptCheck.reasonKo || 'PROJECT_STYLE_PROFILE 스키마 검증 실패',
        });
      }
    }

    // 5. ATOMIC WRITES (BOTH IN SAME TRANSACTION)
    await writeDocsInTx({
      styleProfile: finalStyleProfile,
      promptProfile: finalPromptProfile,
      isNewStyleDoc: !existingStyleProfile,
      isNewPromptDoc: !existingPromptProfile,
    });

    return buildStyleApplicationResult({
      styleProfile: finalStyleProfile,
      promptProfile: finalPromptProfile,
      styleProfileSaved: true,
      promptProfileSaved: true,
      createdNewProfile: !existingPromptProfile,
      sourceHash: payload.candidate.sourceReference.contentHash,
      baseVersionConflictResolvedByNewProfile: false,
      persistenceStatus: 'COMMITTED',
      storageMode,
    });
  } catch (error) {
    const classified = classifyStylePersistenceError(error);
    return buildStyleApplicationResult({
      styleProfile: fallbackPrepared.styleProfile,
      promptProfile:
        classified.remotePromptProfile || fallbackPrepared.promptProfile,
      styleProfileSaved: false,
      promptProfileSaved: false,
      createdNewProfile: false,
      sourceHash: payload.candidate.sourceReference.contentHash,
      baseVersionConflictResolvedByNewProfile: false,
      errorMessages: [classified.messageKo],
      persistenceStatus: classified.persistenceStatus,
      storageMode,
      errorMessage: classified.messageKo,
      conflictDetails: classified.conflictDetails,
    });
  }
}

/**
 * P0-C Real Firestore Transaction committing BOTH `styleProfiles/{styleId}` and
 * `writingPromptProfiles/{promptId}` atomically in a single `runTransaction`.
 */
export async function persistApprovedStyleDnaAtomicallyFirestore(
  uid: string,
  projectId: string,
  payload: StyleApprovalPayload,
  options?: AtomicStylePersistenceOptions,
  firestoreDb: Firestore = db
): Promise<StyleProfileApplicationResult> {
  const basePath = `users/${uid}/projects/${projectId}`;
  const {
    isCreateNewPrompt,
    styleProfileId: resolvedStyleId,
    promptProfileId: resolvedPromptId,
  } = resolveStyleApprovalTargets(payload, options);

  const fallbackPrepared = buildApprovedStyleProfilesForPersistence({
    payload: {
      ...payload,
      ownerId: uid,
      projectId,
      allowAutoBranchOnConflict: false,
    },
    existingStyleProfile: null,
    existingPromptProfile: null,
  });

  try {
    return await runTransaction(firestoreDb, async (tx) => {
      const styleRef = doc(
        firestoreDb,
        `${basePath}/styleProfiles/${resolvedStyleId}`
      );
      const promptRef = doc(
        firestoreDb,
        `${basePath}/writingPromptProfiles/${resolvedPromptId}`
      );

      const txResult = await persistApprovedStyleDnaAtomicallyCore({
        uid,
        projectId,
        payload: {
          ...payload,
          existingStyleProfileId: payload.existingStyleProfileId,
          targetPromptProfileId: isCreateNewPrompt
            ? undefined
            : resolvedPromptId,
        },
        storageMode: 'CLOUD_FIRESTORE',
        options: {
          ...options,
          forcedStyleProfileId: resolvedStyleId,
          forcedPromptProfileId: resolvedPromptId,
        },
        readDocsInTx: async () => {
          // ALL READS BEFORE ANY WRITES
          const styleSnap = await tx.get(styleRef);
          const promptSnap = await tx.get(promptRef);

          const existingStyleProfile = styleSnap.exists()
            ? parseStyleProfileFromFirestoreData(
                styleSnap.id,
                styleSnap.data() as Record<string, unknown>,
                uid,
                projectId
              )
            : null;
          const existingPromptProfile = promptSnap.exists()
            ? parsePromptProfileFromFirestoreData(
                promptSnap.id,
                promptSnap.data() as Record<string, unknown>,
                uid,
                projectId
              )
            : null;

          return { existingStyleProfile, existingPromptProfile };
        },
        writeDocsInTx: async ({
          styleProfile,
          promptProfile,
          isNewStyleDoc,
          isNewPromptDoc,
        }) => {
          if (isNewStyleDoc) {
            tx.set(
              styleRef,
              options?.rawStyleWriteOverrideForTest ?? {
                id: styleProfile.id,
                ownerId: uid,
                projectId,
                name: styleProfile.name,
                narrativePerspective: styleProfile.narrativePerspective,
                dialogueRatio: Math.round(styleProfile.dialogueRatio),
                avgSentenceLength: Math.round(styleProfile.avgSentenceLength),
                toneKeywords: sanitizeStringTags(styleProfile.toneKeywords),
                preferredExpressions: sanitizeStringTags(
                  styleProfile.preferredExpressions
                ),
                prohibitedExpressions: sanitizeStringTags(
                  styleProfile.prohibitedExpressions
                ),
                sampleExcerpt: styleProfile.sampleExcerpt,
                canonStatus: normalizeToCanonStatus(styleProfile.canonStatus),
                sourceRevisionId: styleProfile.sourceRevisionId || '',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              }
            );
          } else {
            tx.update(
              styleRef,
              options?.rawStyleWriteOverrideForTest ?? {
                name: styleProfile.name,
                narrativePerspective: styleProfile.narrativePerspective,
                dialogueRatio: Math.round(styleProfile.dialogueRatio),
                avgSentenceLength: Math.round(styleProfile.avgSentenceLength),
                toneKeywords: sanitizeStringTags(styleProfile.toneKeywords),
                preferredExpressions: sanitizeStringTags(
                  styleProfile.preferredExpressions
                ),
                prohibitedExpressions: sanitizeStringTags(
                  styleProfile.prohibitedExpressions
                ),
                sampleExcerpt: styleProfile.sampleExcerpt,
                canonStatus: normalizeToCanonStatus(styleProfile.canonStatus),
                sourceRevisionId: styleProfile.sourceRevisionId || '',
                updatedAt: serverTimestamp(),
              }
            );
          }

          if (options?.simulateSecondWriteFailureForTest) {
            throw new StyleCasTransactionAbortError({
              status: 'NOT_COMMITTED',
              message:
                '2번째 문서(PROJECT_STYLE_PROFILE) 저장 중 강제 오류가 발생하여 트랜잭션 전체가 롤백되었습니다.',
            });
          }

          if (isNewPromptDoc) {
            tx.set(
              promptRef,
              options?.rawPromptWriteOverrideForTest ?? {
                id: promptProfile.id,
                ownerId: uid,
                projectId,
                promptType: promptProfile.promptType,
                title: promptProfile.title,
                description: promptProfile.description || '',
                targetCharacterId: promptProfile.targetCharacterId || '',
                content: promptProfile.content,
                isActive: Boolean(promptProfile.isActive),
                currentVersionId: promptProfile.currentVersionId,
                currentVersionNumber: Math.round(
                  promptProfile.currentVersionNumber
                ),
                versions: promptProfile.versions,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              }
            );
          } else {
            tx.update(
              promptRef,
              options?.rawPromptWriteOverrideForTest ?? {
                promptType: promptProfile.promptType,
                title: promptProfile.title,
                description: promptProfile.description || '',
                targetCharacterId: promptProfile.targetCharacterId || '',
                content: promptProfile.content,
                isActive: Boolean(promptProfile.isActive),
                currentVersionId: promptProfile.currentVersionId,
                currentVersionNumber: Math.round(
                  promptProfile.currentVersionNumber
                ),
                versions: promptProfile.versions,
                updatedAt: serverTimestamp(),
              }
            );
          }
        },
      });

      // CRITICAL: If inner core returned a non-committed result (e.g. VERSION_CONFLICT or VALIDATION_FAILED),
      // throw inside runTransaction so Firestore strictly aborts the transaction with 0 writes!
      if (txResult.persistenceStatus !== 'COMMITTED') {
        throw new StyleCasTransactionAbortError({
          status: txResult.persistenceStatus,
          message:
            txResult.errorMessage ||
            '원자적 문체 승인 트랜잭션이 중단되었습니다.',
          conflictDetails: txResult.conflictDetails,
          remotePromptProfile: txResult.conflictDetails?.remotePromptProfile,
        });
      }

      return txResult;
    });
  } catch (error) {
    const classified = classifyStylePersistenceError(error);
    return buildStyleApplicationResult({
      styleProfile: fallbackPrepared.styleProfile,
      promptProfile:
        classified.remotePromptProfile || fallbackPrepared.promptProfile,
      styleProfileSaved: false,
      promptProfileSaved: false,
      createdNewProfile: false,
      sourceHash: payload.candidate.sourceReference.contentHash,
      baseVersionConflictResolvedByNewProfile: false,
      errorMessages: [classified.messageKo],
      persistenceStatus: classified.persistenceStatus,
      storageMode: 'CLOUD_FIRESTORE',
      errorMessage: classified.messageKo,
      conflictDetails: classified.conflictDetails,
    });
  }
}

/**
 * Local store equivalent of atomic StyleProfile + PromptProfile commit
 * (explicitly labeled storageMode: 'LOCAL_STORE').
 */
export async function persistApprovedStyleDnaAtomicallyLocal(params: {
  uid: string;
  projectId: string;
  payload: StyleApprovalPayload;
  existingStyleProfiles: StyleProfile[];
  existingPromptProfiles: PromptProfile[];
  options?: AtomicStylePersistenceOptions;
}): Promise<StyleProfileApplicationResult> {
  return await persistApprovedStyleDnaAtomicallyCore({
    uid: params.uid,
    projectId: params.projectId,
    payload: params.payload,
    storageMode: 'LOCAL_STORE',
    options: params.options,
    readDocsInTx: async ({ styleProfileId, promptProfileId }) => {
      const existingStyleProfile =
        params.existingStyleProfiles.find((s) => s.id === styleProfileId) ||
        null;
      const existingPromptProfile =
        params.existingPromptProfiles.find((p) => p.id === promptProfileId) ||
        null;
      return { existingStyleProfile, existingPromptProfile };
    },
    writeDocsInTx: async () => {
      if (params.options?.simulateSecondWriteFailureForTest) {
        throw new StyleCasTransactionAbortError({
          status: 'NOT_COMMITTED',
          message:
            '2번째 문서(PROJECT_STYLE_PROFILE) 저장 실패로 로컬 원자적 커밋이 전체 취소되었습니다.',
        });
      }
    },
  });
}

export async function createFirestoreWritingPlan(
  uid: string,
  projectId: string,
  plan: WritingPlan
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/writingPlans/${plan.id}`;
  try {
    await setDoc(doc(db, path), {
      id: plan.id,
      ownerId: uid,
      projectId,
      episodeId: plan.episodeId,
      episodeTitle: plan.episodeTitle.slice(0, 200),
      episodeGoal: plan.episodeGoal.slice(0, 2000),
      requiredEvents: sanitizeStringTags(plan.requiredEvents, 30),
      forbiddenDevelopments: sanitizeStringTags(plan.forbiddenDevelopments, 30),
      targetTotalCharCount: Math.max(100, Math.min(100000, Math.round(plan.targetTotalCharCount))),
      narrativePerspective: plan.narrativePerspective,
      scenes: (plan.scenes || []).slice(0, 30),
      plotDeviationWarnings: sanitizeStringTags(plan.plotDeviationWarnings, 20),
      appliedPromptVersionIds: sanitizeIdArray(plan.appliedPromptVersionIds),
      referencedSourceIds: sanitizeIdArray(plan.referencedSourceIds),
      modelId: (plan.modelId || 'gemini-3.8-flash').slice(0, 80),
      status: plan.status,
      approvedAt: plan.approvedAt || '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateFirestoreWritingPlan(
  uid: string,
  projectId: string,
  plan: WritingPlan
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/writingPlans/${plan.id}`;
  try {
    await updateDoc(doc(db, path), {
      episodeTitle: plan.episodeTitle.slice(0, 200),
      episodeGoal: plan.episodeGoal.slice(0, 2000),
      requiredEvents: sanitizeStringTags(plan.requiredEvents, 30),
      forbiddenDevelopments: sanitizeStringTags(plan.forbiddenDevelopments, 30),
      targetTotalCharCount: Math.max(100, Math.min(100000, Math.round(plan.targetTotalCharCount))),
      narrativePerspective: plan.narrativePerspective,
      scenes: (plan.scenes || []).slice(0, 30),
      plotDeviationWarnings: sanitizeStringTags(plan.plotDeviationWarnings, 20),
      appliedPromptVersionIds: sanitizeIdArray(plan.appliedPromptVersionIds),
      referencedSourceIds: sanitizeIdArray(plan.referencedSourceIds),
      status: plan.status,
      approvedAt: plan.approvedAt || '',
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function fetchFirestorePhase2Collections(
  uid: string,
  projectId: string
): Promise<{
  writingPromptProfiles: PromptProfile[];
  writingPlans: WritingPlan[];
  changeProposals: ChangeProposal[];
}> {
  const basePath = `users/${uid}/projects/${projectId}`;
  const writingPromptProfiles: PromptProfile[] = [];
  const writingPlans: WritingPlan[] = [];
  const changeProposals: ChangeProposal[] = [];

  try {
    const snap = await getDocs(
      query(collection(db, `${basePath}/writingPromptProfiles`), where('ownerId', '==', uid))
    );
    for (const d of snap.docs) {
      const data = d.data();
      writingPromptProfiles.push({
        id: String(data.id ?? d.id),
        ownerId: String(data.ownerId ?? uid),
        projectId: String(data.projectId ?? projectId),
        promptType:
          data.promptType === 'PROJECT_STYLE_PROFILE' ||
          data.promptType === 'CHARACTER_DIALOGUE_RULES' ||
          data.promptType === 'SCENE_INSTRUCTIONS' ||
          data.promptType === 'REVIEW_RULES'
            ? data.promptType
            : 'CORE_WRITING_RULES',
        title: String(data.title ?? ''),
        description: String(data.description ?? ''),
        targetCharacterId: data.targetCharacterId ? String(data.targetCharacterId) : undefined,
        content: String(data.content ?? ''),
        isActive: Boolean(data.isActive),
        currentVersionId: String(data.currentVersionId ?? 'pver_1'),
        currentVersionNumber: Number(data.currentVersionNumber ?? 1),
        versions: Array.isArray(data.versions) ? data.versions : [],
        createdAt: toIsoString(data.createdAt),
        updatedAt: toIsoString(data.updatedAt),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, `${basePath}/writingPromptProfiles`);
  }

  try {
    const snap = await getDocs(
      query(collection(db, `${basePath}/writingPlans`), where('ownerId', '==', uid))
    );
    for (const d of snap.docs) {
      const data = d.data();
      writingPlans.push({
        id: String(data.id ?? d.id),
        ownerId: String(data.ownerId ?? uid),
        projectId: String(data.projectId ?? projectId),
        episodeId: String(data.episodeId ?? ''),
        episodeTitle: String(data.episodeTitle ?? ''),
        episodeGoal: String(data.episodeGoal ?? ''),
        requiredEvents: Array.isArray(data.requiredEvents)
          ? data.requiredEvents.map(String)
          : [],
        forbiddenDevelopments: Array.isArray(data.forbiddenDevelopments)
          ? data.forbiddenDevelopments.map(String)
          : [],
        targetTotalCharCount: Number(data.targetTotalCharCount ?? 5000),
        narrativePerspective:
          data.narrativePerspective === 'FIRST_PERSON' ||
          data.narrativePerspective === 'OMNISCIENT' ||
          data.narrativePerspective === 'MIXED'
            ? data.narrativePerspective
            : 'THIRD_LIMITED',
        scenes: Array.isArray(data.scenes) ? data.scenes : [],
        plotDeviationWarnings: Array.isArray(data.plotDeviationWarnings)
          ? data.plotDeviationWarnings.map(String)
          : [],
        appliedPromptVersionIds: sanitizeIdArray(data.appliedPromptVersionIds),
        referencedSourceIds: sanitizeIdArray(data.referencedSourceIds),
        modelId: String(data.modelId ?? 'gemini-3.8-flash'),
        status:
          data.status === 'APPROVED' || data.status === 'SUPERSEDED'
            ? data.status
            : 'DRAFT_PLAN',
        approvedAt: data.approvedAt ? String(data.approvedAt) : undefined,
        createdAt: toIsoString(data.createdAt),
        updatedAt: toIsoString(data.updatedAt),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, `${basePath}/writingPlans`);
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

  const normalizedProfiles =
    writingPromptProfiles.length > 0
      ? ensureMasterWritingRulesRegistered(writingPromptProfiles, uid, projectId)
      : [];

  return {
    writingPromptProfiles: normalizedProfiles,
    writingPlans,
    changeProposals,
  };
}

export async function fetchFirestoreApprovalAudits(
  uid: string,
  projectId: string
): Promise<ChangeProposalApprovalAudit[]> {
  const basePath = `users/${uid}/projects/${projectId}`;
  const audits: ChangeProposalApprovalAudit[] = [];

  try {
    const snap = await getDocs(
      query(
        collection(db, `${basePath}/changeProposalApprovalAudits`),
        where('ownerId', '==', uid)
      )
    );
    for (const d of snap.docs) {
      const data = d.data();
      audits.push({
        id: String(data.id ?? d.id),
        ownerId: String(data.ownerId ?? uid),
        projectId: String(data.projectId ?? projectId),
        proposalId: String(data.proposalId ?? ''),
        targetEntityType:
          data.targetEntityType === 'TIMELINE_EVENT' ||
          data.targetEntityType === 'FORESHADOWING'
            ? data.targetEntityType
            : 'RELATIONSHIP',
        targetEntityId: String(data.targetEntityId ?? ''),
        proposedAction: data.proposedAction === 'UPDATE' ? 'UPDATE' : 'CREATE',
        decision: data.decision === 'REJECTED' ? 'REJECTED' : 'APPROVED',
        reviewerUid: String(data.reviewerUid ?? uid),
        reviewNote: String(data.reviewNote ?? ''),
        triggerEpisodeId: String(data.triggerEpisodeId ?? ''),
        sourceRevisionId: String(data.sourceRevisionId ?? ''),
        sourceSceneId: String(data.sourceSceneId ?? ''),
        proposalFingerprint: String(data.proposalFingerprint ?? ''),
        beforeCanonStatus:
          data.beforeCanonStatus === 'DRAFT' ||
          data.beforeCanonStatus === 'PROPOSED' ||
          data.beforeCanonStatus === 'CANON' ||
          data.beforeCanonStatus === 'REJECTED' ||
          data.beforeCanonStatus === 'ARCHIVED'
            ? data.beforeCanonStatus
            : null,
        afterCanonStatus: normalizeToCanonStatus(data.afterCanonStatus),
        beforeSnapshotJson: String(data.beforeSnapshotJson ?? ''),
        afterSnapshotJson: String(data.afterSnapshotJson ?? ''),
        verifiedExcerptJson: String(data.verifiedExcerptJson ?? ''),
        payoffNote: String(data.payoffNote ?? ''),
        ragSyncStatus:
          data.ragSyncStatus === 'SYNCED' ||
          data.ragSyncStatus === 'FAILED' ||
          data.ragSyncStatus === 'NOT_REQUIRED'
            ? data.ragSyncStatus
            : 'PENDING',
        ragSyncError: String(data.ragSyncError ?? ''),
        createdAt: toIsoString(data.createdAt),
        updatedAt: toIsoString(data.updatedAt),
      });
    }
  } catch (error) {
    handleFirestoreError(
      error,
      OperationType.LIST,
      `${basePath}/changeProposalApprovalAudits`
    );
  }

  return audits.sort((a, b) =>
    String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt))
  );
}
