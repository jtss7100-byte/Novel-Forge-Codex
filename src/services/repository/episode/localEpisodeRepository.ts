import type { ProjectBundle, Revision, Episode } from '../../../types/novel';
import {
  type EpisodeRevisionCommitInput,
  type EpisodeRevisionCommitResult,
  EpisodeRevisionCasConflictError,
  executeAtomicEpisodeCasCommitCore,
} from './episodeCas';
import {
  type LocalStorageLike,
  localBundleKey,
  readOwnedLocalBundles,
  LOCAL_BUNDLES_KEY,
} from '../local/localProjectStore';
import { computeManuscriptContentHash } from '../../../utils/manuscriptIntegrity';
import { episodeSavePayloadHash } from '../../../utils/episodeSavePayload';

/**
 * Atomic local bundle CAS persistence. Reads persisted localStorage snapshot when available
 * (enforcing cross-tab stale detection when two tabs share `localStorage`) and rolls back cleanly
 * if `setItem` throws (e.g., QuotaExceededError).
 */
interface LocalEpisodeCommitInput {
  bundles: ProjectBundle[];
  commitInput: EpisodeRevisionCommitInput;
  storage?: LocalStorageLike | null;
}

export async function commitEpisodeRevisionSafelyLocal(
  params: LocalEpisodeCommitInput,
): Promise<EpisodeRevisionCommitResult & { nextBundles: ProjectBundle[] }> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks && params.storage === undefined) {
    return locks.request(localBundleKey(params.commitInput.uid), () => commitLocalEpisode(params));
  }
  return commitLocalEpisode(params);
}

async function commitLocalEpisode(
  params: LocalEpisodeCommitInput,
): Promise<EpisodeRevisionCommitResult & { nextBundles: ProjectBundle[] }> {
  const storage =
    params.storage !== undefined
      ? params.storage
      : typeof window !== 'undefined' && window.localStorage
      ? window.localStorage
      : null;

  // Prefer reading persisted localStorage first to catch concurrent multi-tab local edits
  const ownerId = params.commitInput.uid;
  const persisted = storage ? readOwnedLocalBundles(storage, ownerId) : null;
  const workingBundles = persisted?.length
    ? persisted
    : params.bundles.filter((bundle) => bundle.project.ownerId === ownerId);

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
        savePayloadHash: episodeSavePayloadHash(existingEpisode),
      };
    },
    createRevision: async (revision) => {
      stagedNewRevisions.push(revision);
    },
    updateEpisode: async (committedEpisode) => {
      committedEpOut = committedEpisode;
    },
  });

  if (result.unchanged) return { ...result, nextBundles: workingBundles };

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
    const key = params.storage === undefined ? localBundleKey(ownerId) : LOCAL_BUNDLES_KEY;
    storage.setItem(key, JSON.stringify(nextBundles));
  }

  return {
    ...result,
    nextBundles,
  };
}
