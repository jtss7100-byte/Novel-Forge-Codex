import type { MemoryDocument, MemoryChunk } from '../../../types/novel';
import { setDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../../firebase';
import { normalizeToCanonStatus, sanitizeStringTags } from '../../../utils/foundationLogic';
import { sanitizeIdArray } from '../../../utils/novelValidation';

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
