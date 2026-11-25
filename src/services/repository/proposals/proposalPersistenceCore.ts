import type {
  ProposalLookupStatus,
  ProposalPersistenceErrorCode,
  PersistChangeProposalsOptions,
  PersistChangeProposalsResult,
  PersistedProposalItemResult,
} from '../../../types/literaryRewriting';
import type { CanonStatus, ChangeProposal, Revision } from '../../../types/novel';
import { computeManuscriptContentHash } from '../../../utils/manuscriptIntegrity';
import {
  areProposalsSemanticallyEquivalent,
  mapErrorCodeToLookupStatus,
  classifyFirestorePersistenceError,
} from './proposalValidation';

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
