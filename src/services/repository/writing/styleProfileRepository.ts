import type {
  StyleProfile,
  ActorType,
  StyleApprovalPayload,
  PromptProfile,
  StyleProfileApplicationResult,
  StyleApprovalConflictDetails,
} from '../../../types/novel';
import {
  setDoc,
  doc,
  serverTimestamp,
  updateDoc,
  type Firestore,
  runTransaction,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../../firebase';
import { sanitizeStringTags, normalizeToCanonStatus, assertCanonProtection } from '../../../utils/foundationLogic';
import { generateEntityId } from '../../../utils/novelValidation';
import {
  buildApprovedStyleProfilesForPersistence,
  extractStylePromptMetadata,
  buildStyleApplicationResult,
} from '../../../utils/authorStyleLogic';
import {
  StyleCasTransactionAbortError,
  mergePromptVersionHistoryPreservingPrior,
  validateStyleProfileForFirestoreSchema,
  validatePromptProfileForFirestoreSchema,
  classifyStylePersistenceError,
  parseStyleProfileFromFirestoreData,
  parsePromptProfileFromFirestoreData,
} from './profileValidation';

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
