import type { Episode, Revision } from '../../../types/novel';
import { newEpisodeDocument, episodeWriteFields, revisionDocument } from './episodeDocuments';
import { assertFirestoreDocumentFits, FirestoreDocumentTooLargeError } from '../../../utils/firestoreDocumentSize';
import { setDoc, doc, runTransaction, type Firestore, deleteDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../../firebase';
import {
  type EpisodeRevisionCommitInput,
  type EpisodeRevisionCommitResult,
  executeAtomicEpisodeCasCommitCore,
} from './episodeCas';
import { storedEpisodeSavePayloadHash } from '../../../utils/episodeSavePayload';

export async function createFirestoreEpisode(
  uid: string,
  projectId: string,
  episode: Episode
): Promise<void> {
  const path = `users/${uid}/projects/${projectId}/episodes/${episode.id}`;
  const payload = newEpisodeDocument(uid, projectId, episode);
  assertFirestoreDocumentFits(path, payload);
  try {
    await setDoc(doc(db, path), payload);
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
  try {
    const payload: Record<string, unknown> = episodeWriteFields(episode);
    if (typeof episode.latestRevisionId === 'string') {
      payload.latestRevisionId = episode.latestRevisionId.trim();
    }
    await runTransaction(db, async (tx) => {
      const ref = doc(db, path);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists()) throw new Error('[EPISODE_NOT_FOUND] 회차가 삭제되었습니다.');
      assertFirestoreDocumentFits(path, { ...snapshot.data(), ...payload });
      tx.update(ref, payload);
    });
  } catch (error) {
    if (error instanceof FirestoreDocumentTooLargeError) throw error;
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

/**
 * Atomic Cloud Firestore commit using `runTransaction` (read-before-write + CAS + immutable revisions).
 */
export async function commitEpisodeRevisionSafelyFirestore(
  input: EpisodeRevisionCommitInput,
  firestoreDb: Firestore = db
): Promise<EpisodeRevisionCommitResult> {
  const epPath = `users/${input.uid}/projects/${input.projectId}/episodes/${input.updatedEpisode.id}`;
  return runTransaction(firestoreDb, async (tx) => {
    const epRef = doc(firestoreDb, epPath);
    const snap = await tx.get(epRef);
    return executeAtomicEpisodeCasCommitCore(input, {
      getEpisodeSnapshot: async () => {
        if (!snap.exists()) return { exists: false, content: '' };
        const data = snap.data();
        return {
          exists: true,
          content: typeof data.content === 'string' ? data.content : '',
          latestRevisionId: typeof data.latestRevisionId === 'string' ? data.latestRevisionId : '',
          contentHash: typeof data.contentHash === 'string' ? data.contentHash : undefined,
          savePayloadHash: input.deduplicate || input.expectedSavePayloadHash !== undefined
            ? storedEpisodeSavePayloadHash(data) : undefined,
        };
      },
      createRevision: async (revision) => {
        const revPath = `users/${input.uid}/projects/${input.projectId}/revisions/${revision.id}`;
        const payload = revisionDocument(input.uid, input.projectId, revision);
        assertFirestoreDocumentFits(revPath, payload);
        tx.set(doc(firestoreDb, revPath), payload);
      },
      updateEpisode: async (committedEpisode) => {
        const payload = {
          ...episodeWriteFields(committedEpisode),
          latestRevisionId: committedEpisode.latestRevisionId || '',
        };
        assertFirestoreDocumentFits(epPath, { ...snap.data(), ...payload });
        tx.update(epRef, payload);
      },
    });
  });
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
  const payload = revisionDocument(uid, projectId, revision);
  assertFirestoreDocumentFits(path, payload);
  try {
    await setDoc(doc(db, path), payload);
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
