import type { PromptProfile, PromptProfileCasResult, StyleApprovalConflictDetails } from '../../../types/novel';
import {
  setDoc,
  doc,
  serverTimestamp,
  updateDoc,
  deleteDoc,
  type Firestore,
  getDoc,
  runTransaction,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../../firebase';
import {
  parsePromptProfileFromFirestoreData,
  StyleCasTransactionAbortError,
  mergePromptVersionHistoryPreservingPrior,
  validatePromptProfileForFirestoreSchema,
  classifyStylePersistenceError,
} from './profileValidation';
import { voiceProfileId } from '../../../utils/characterVoiceLogic';
import type { VoiceSourceReference } from '../../../types/characterVoice';
import { computeManuscriptContentHash } from '../../../utils/manuscriptIntegrity';

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

export async function saveCharacterVoicePromptCore(params: {
  next: PromptProfile;
  base: PromptProfile | null;
  remote: PromptProfile | null;
  storageMode: 'CLOUD_FIRESTORE' | 'LOCAL_STORE';
  write: (profile: PromptProfile) => Promise<void>;
}): Promise<PromptProfile> {
  const { next, base, remote, storageMode, write } = params;
  if (next.promptType !== 'CHARACTER_DIALOGUE_RULES' || !next.targetCharacterId ||
      next.id !== voiceProfileId(next.targetCharacterId) ||
      !validatePromptProfileForFirestoreSchema(next.ownerId, next.projectId, next).valid) {
    throw new Error('유효한 인물별 화법 프롬프트가 필요합니다.');
  }
  if (remote && (remote.id !== next.id || remote.promptType !== next.promptType ||
      remote.ownerId !== next.ownerId || remote.projectId !== next.projectId ||
      remote.targetCharacterId !== next.targetCharacterId)) {
    throw new Error('인물 화법 프로필의 소유자나 대상이 일치하지 않습니다.');
  }
  const exactRetry = remote && remote.content === next.content && remote.isActive === next.isActive &&
    remote.title === next.title && remote.description === next.description &&
    (remote.currentVersionId === next.currentVersionId || (!base && remote.currentVersionNumber === 1) ||
      (base && next.currentVersionNumber === base.currentVersionNumber + 1 &&
        remote.currentVersionNumber === next.currentVersionNumber));
  if (exactRetry) return remote;
  if (!base && !remote && next.currentVersionNumber === 1) {
    await write(next);
    return next;
  }
  if (!base || !remote || base.id !== next.id) throw new Error('[VERSION_CONFLICT] 최신 화법 버전을 다시 불러와 주세요.');
  const result = await updatePromptProfileWithCasCore({
    uid: next.ownerId, projectId: next.projectId, nextProfile: next, storageMode,
    expectedVersionId: base.currentVersionId, expectedVersionNumber: base.currentVersionNumber,
    getRemoteProfileInTx: async () => remote, writeProfileInTx: write,
  });
  return result.profile;
}

export async function saveFirestoreCharacterVoicePrompt(
  next: PromptProfile,
  base: PromptProfile | null,
  verifySources: VoiceSourceReference[] = [],
  firestoreDb: Firestore = db
): Promise<PromptProfile> {
  const { ownerId, projectId, targetCharacterId } = next;
  if (![ownerId, projectId, targetCharacterId].every((value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)) ||
      !targetCharacterId || next.id !== voiceProfileId(targetCharacterId)) throw new Error('잘못된 인물 또는 작품 ID입니다.');
  const path = `users/${ownerId}/projects/${projectId}`;
  const ref = doc(firestoreDb, `${path}/writingPromptProfiles/${next.id}`);
  return runTransaction(firestoreDb, async (tx) => {
    const [profile, character] = await Promise.all([
      tx.get(ref), tx.get(doc(firestoreDb, `${path}/characters/${targetCharacterId}`)),
    ]);
    const data = character.data();
    if (data?.ownerId !== ownerId || data?.projectId !== projectId || data?.id !== targetCharacterId) {
      throw new Error('현재 작품에서 승인할 인물을 확인할 수 없습니다.');
    }
    for (const source of verifySources) {
      if (!source.revisionId && !source.episodeId) continue;
      if (!source.episodeId || !source.revisionId || ![source.episodeId, source.revisionId].every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id))) {
        throw new Error('잘못된 분석 출처입니다.');
      }
      const [episodeSnap, revisionSnap] = await Promise.all([
        tx.get(doc(firestoreDb, `${path}/episodes/${source.episodeId}`)),
        tx.get(doc(firestoreDb, `${path}/revisions/${source.revisionId}`)),
      ]);
      const episode = episodeSnap.data();
      const revision = revisionSnap.data();
      if (episode?.ownerId !== ownerId || episode?.projectId !== projectId || episode?.id !== source.episodeId ||
          revision?.ownerId !== ownerId || revision?.projectId !== projectId || revision?.id !== source.revisionId ||
          revision?.episodeId !== source.episodeId || (episode?.latestRevisionId || undefined) !== (source.latestRevisionId || undefined) ||
          typeof revision?.content !== 'string' || computeManuscriptContentHash(revision.content) !== source.contentHash) {
        throw new Error('STALE_SOURCE: 승인 전에 출처 Revision을 다시 분석해 주세요.');
      }
    }
    return saveCharacterVoicePromptCore({
      next, base, storageMode: 'CLOUD_FIRESTORE',
      remote: profile.exists() ? parsePromptProfileFromFirestoreData(profile.id, profile.data(), ownerId, projectId) : null,
      write: async (profileToSave) => {
        const fields = {
          title: profileToSave.title, description: profileToSave.description,
          targetCharacterId, content: profileToSave.content, isActive: profileToSave.isActive,
          currentVersionId: profileToSave.currentVersionId, currentVersionNumber: profileToSave.currentVersionNumber,
          versions: profileToSave.versions, updatedAt: serverTimestamp(),
        };
        if (profile.exists()) tx.update(ref, fields);
        else tx.set(ref, { ...fields, id: next.id, ownerId, projectId, promptType: next.promptType, createdAt: serverTimestamp() });
      },
    });
  });
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
