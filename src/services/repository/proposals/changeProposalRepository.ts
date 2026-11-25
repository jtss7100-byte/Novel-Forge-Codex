import type { ChangeProposal } from '../../../types/novel';
import {
  type Firestore,
  doc,
  runTransaction,
  updateDoc,
  serverTimestamp,
  getDocs,
  query,
  collection,
  where,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../../firebase';
import {
  normalizeAndValidateChangeProposalPayload,
  areProposalsSemanticallyEquivalent,
  buildCanonicalChangeProposalWriteDataFromNormalized,
  mapErrorCodeToLookupStatus,
  SAFE_PROPOSAL_ID_REGEX,
} from './proposalValidation';
import type {
  ProposalImmutablePayload,
  PersistChangeProposalsOptions,
  PersistChangeProposalsResult,
} from '../../../types/literaryRewriting';
import { normalizeToCanonStatus } from '../../../utils/foundationLogic';
import {
  type AtomicProposalPersistenceOutcome,
  verifyPersistedRevisionSnapshot,
  persistChangeProposalsIdempotentlyCore,
} from './proposalPersistenceCore';
import type { ChangeProposalApprovalAudit } from '../../../types/changeProposalApproval';
import { toIsoString } from '../core/firestoreTimestamp';

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
