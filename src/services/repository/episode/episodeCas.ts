import type { Episode, Revision } from '../../../types/novel';
import { computeManuscriptContentHash } from '../../../utils/manuscriptIntegrity';
import { episodeSavePayloadHash } from '../../../utils/episodeSavePayload';
import { calculateCharCounts, generateEntityId } from '../../../utils/novelValidation';

export type EpisodeRevisionCasConflictCode =
  | 'STALE_REVISION_CONFLICT'
  | 'CONTENT_HASH_MISMATCH'
  | 'SAVE_PAYLOAD_MISMATCH'
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
  expectedSavePayloadHash?: string;
  deduplicate?: boolean;
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
  unchanged?: boolean;
}

export interface AtomicEpisodeCasTxAdapter {
  getEpisodeSnapshot: () => Promise<{
    exists: boolean;
    content: string;
    latestRevisionId?: string;
    contentHash?: string;
    savePayloadHash?: string;
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

  if (
    input.deduplicate && !input.createRevision && !input.createBackupRevisionFirst &&
    remoteSnap.savePayloadHash === episodeSavePayloadHash(input.updatedEpisode) &&
    remoteContent === input.updatedEpisode.content &&
    (input.updatedEpisode.latestRevisionId || '') === remoteRevisionId
  ) {
    return {
      episode: { ...input.updatedEpisode, title: normalizedTitle, latestRevisionId: remoteRevisionId || undefined, contentHash: remoteContentHash },
      backupRevision: null,
      targetRevision: null,
      unchanged: true,
    };
  }

  if (input.expectedSavePayloadHash !== undefined && input.expectedSavePayloadHash !== remoteSnap.savePayloadHash) {
    throw new EpisodeRevisionCasConflictError(
      'SAVE_PAYLOAD_MISMATCH', '다른 탭 또는 기기가 회차 내용이나 메타데이터를 수정했습니다.'
    );
  }

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
