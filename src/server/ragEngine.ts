import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { getApps } from 'firebase-admin/app';
import { FieldValue, getFirestore, type Firestore } from 'firebase-admin/firestore';
import {
  createFirestoreProjectLookupFromDb,
  ensureFirebaseAdminInitialized,
  getFirebaseDatabaseId,
  getIsolatedFirestoreBindingMetadata,
  hasCloudFirestoreCredentials,
  isServerCloudAuthEnforced,
  PROD_DEFAULT_FIREBASE_PROJECT_ID,
  PROD_DEFAULT_FIRESTORE_DATABASE_ID,
  registerProjectOwnerForAdminCheck,
  verifyAdminFirestoreProjectOwnership,
  verifyIsolatedTestFirestoreBinding,
  type FirestoreProjectLookupFn,
} from './authMiddleware.ts';
import type {
  CanonStatus,
  Character,
  CharacterRelationship,
  EmbeddingGenerationMode,
  Episode,
  Foreshadowing,
  MemoryChunk,
  MemoryDocument,
  MemoryEntityLifecycleStatus,
  MemoryIndexStatus,
  MemorySearchMode,
  MemorySourceEntityType,
  Project,
  RagActivationMode,
  RagGenerationStagingReceipt,
  RagGenerationStagingStatus,
  RagRetrievedEvidenceItem,
  Scene,
  TimelineEvent,
  WorldbuildingItem,
  WritingContextBundle,
} from '../types/novel.ts';
import {
  areEmbeddingsVectorSpaceCompatible,
  buildGenerationScopedChunkId,
  buildGenerationScopedDocId,
  computeCosineSimilarity,
  computeDeterministicSemanticEmbedding,
  computeMemoryContentHash,
  DETERMINISTIC_TEST_EMBEDDING_MODEL_ID,
  estimateIndexingScaleAndCost,
  extractProjectMemoryIndexInputs,
  FoundationMemorySearchStore,
  isLiveGeminiEmbeddingModelId,
  LARGE_SCALE_RAG_TX_OP_THRESHOLD,
  RAG_ENGINE_DEFAULTS,
  splitTextIntoSemanticChunksWithOffsets,
  type EntityIndexLifecycleState,
  type ExternalFirestoreVectorCandidate,
  type IndexingScaleEstimate,
  type LiveSourceSnapshotMap,
  type MemoryIndexInput,
  type MemoryIndexResult,
  type MemorySearchHit,
  type MemorySearchQuery,
  type MemorySourceReference,
  type PreparedStagedIndexResult,
  type ProjectRagStatusSummary,
  type RagExecutionSearchStatus,
} from '../services/memorySearchProvider.ts';
import type {
  AppliedCanonEntity,
  ApprovalTargetEntityType,
  DurableRagCommitPolicy,
  RagSyncTaskRecord,
  RagSyncTaskStatus,
} from '../types/changeProposalApproval.ts';
import {
  verifyCanonEntityFreshnessForRag,
  verifyRagTaskLeaseFencing,
} from '../utils/changeProposalApprovalLogic.ts';

/**
 * Phase 3 Section 13-4:
 * Store runtime RAG disk cache in OS temp directory by default (`os.tmpdir()`)
 * so runtime cache files never pollute the Git working tree.
 */
// Test workers clear their disk snapshots to simulate cold recovery.
const RAG_CACHE_DIR = process.env.NODE_TEST_CONTEXT
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-rag-test-'))
  : process.env.NOVELFORGE_RAG_CACHE_DIR?.trim() ||
    path.join(os.tmpdir(), 'novelforge_rag_cache');

const FIRESTORE_MAX_BATCH_OPS = 450; // Safely below Firestore's 500 ops/batch hard limit
const FIRESTORE_FENCED_CLEANUP_TX_MAX_DELETE_OPS = 200; // Reads (~202) + Deletes (<=200) <= 402 per atomic Firestore TX (< 500 hard limit)
const BULK_PRODUCTION_WRITE_CHUNK_THRESHOLD = 1200;
const MIN_PRODUCTION_CLEANUP_LEASE_MS = 30_000;
const DEFAULT_CLEANUP_LEASE_MS = 60_000;
const activeInProcessCleanupOps = new Set<string>();

function isPlainFirestoreSerializableObject(
  value: unknown
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value instanceof Date) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Explicitly removes `undefined` fields at every nesting depth before writing
 * to Firestore (Admin SDK rejects `undefined` properties unless omitted).
 * Preserves Firestore `FieldValue` sentinels (`serverTimestamp()`, `vector()`),
 * `Date` instances, primitives, and dense arrays.
 */
export function sanitizeFirestoreWriteData<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== undefined)
      .map((item) => sanitizeFirestoreWriteData(item)) as unknown as T;
  }
  if (isPlainFirestoreSerializableObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (val === undefined) continue;
      out[key] = sanitizeFirestoreWriteData(val);
    }
    return out as T;
  }
  return value;
}

export interface PendingCloudDeleteRecord {
  targetType: 'ENTITY' | 'PROJECT';
  ownerId: string;
  projectId: string;
  sourceEntityId?: string;
  sourceEntityType?: MemorySourceEntityType;
  tombstoneGeneration: number;
  status: 'DELETE_PENDING' | 'DELETED';
  failedBatchNumber?: number;
  remainingDocuments: number;
  remainingChunks: number;
  lastError?: string;
  updatedAt: string;
}

interface DiskProjectRagSnapshot {
  version: number;
  ownerId: string;
  projectId: string;
  updatedAt: string;
  firestoreSynced: boolean;
  firestoreVectorIndexReady: boolean;
  lastFirestoreError?: string;
  generationCounter: number;
  entityStates: EntityIndexLifecycleState[];
  documents: MemoryDocument[];
  chunks: MemoryChunk[];
  failedInputs: {
    input: MemoryIndexInput;
    error: string;
    failedAt: string;
  }[];
  pendingDeletes?: PendingCloudDeleteRecord[];
}

// ============================================================================
// Mock / Emulator Firestore Transaction, Vector Search, Deletion & Recovery Adapter
// ============================================================================

export interface RagManifestCleanupClaim {
  claimKey: string; // `${entityKey}::g${generation}`
  entityKey: string;
  ownerId: string;
  projectId: string;
  sourceEntityType: MemorySourceEntityType;
  sourceEntityId: string;
  generation: number;
  stagingId?: string;
  cleanupOperationId: string;
  cleanupEpoch: number;
  cleanupOwner: string;
  status: 'CLEANUP_PENDING' | 'CLEANUP_COMPLETED';
  targetDocumentIds: string[];
  claimedAt: string;
  cleanupLeaseExpiresAt?: string;
  cleanupLeaseExpiresAtMs?: number;
  completedAt?: string;
}

export interface EntityRetiredGenerationLedger {
  retiredThroughGen: number;
  retiredGens: number[];
  lastCleanupEpoch?: number;
  updatedAt?: string;
}

export interface FirestoreRagManifestDoc {
  ownerId: string;
  projectId: string;
  activeGenerationCounter: number;
  entityStates: Record<string, EntityIndexLifecycleState>;
  projectLifecycleStatus: 'ACTIVE' | 'PENDING_DELETE' | 'DELETED';
  projectTombstoneGeneration: number;
  cleanupEpochCounter?: number;
  cleanupClaims?: Record<string, RagManifestCleanupClaim>;
  retiredGenerationsByEntity?: Record<string, EntityRetiredGenerationLedger>;
  pendingDeletes?: Record<string, PendingCloudDeleteRecord>;
  entityDeletionStates?: Record<string, PendingCloudDeleteRecord>;
  updatedAt: string;
}

function makeCleanupClaimKey(entityKey: string, generation: number): string {
  return `${entityKey}::g${Math.max(0, Math.floor(generation))}`;
}

function recordRetiredGenerationInLedgerMap(
  ledgerMap: Record<string, EntityRetiredGenerationLedger> | undefined,
  entityKey: string,
  generation: number,
  cleanupEpoch?: number,
  nowIso?: string
): Record<string, EntityRetiredGenerationLedger> {
  const next: Record<string, EntityRetiredGenerationLedger> = ledgerMap
    ? { ...ledgerMap }
    : {};
  const gen = Math.floor(generation);
  if (!entityKey || gen <= 0) return next;

  const existing = next[entityKey];
  let retiredThroughGen = Number(existing?.retiredThroughGen || 0);
  const discrete = new Set<number>(
    Array.isArray(existing?.retiredGens)
      ? existing!.retiredGens.filter((n) => typeof n === 'number' && n > retiredThroughGen)
      : []
  );
  if (gen > retiredThroughGen) {
    discrete.add(gen);
  }
  while (discrete.has(retiredThroughGen + 1)) {
    discrete.delete(retiredThroughGen + 1);
    retiredThroughGen += 1;
  }
  const sorted = Array.from(discrete).sort((a, b) => a - b);
  // Bounded compact storage (keep at most 64 sparse retired gens above retiredThroughGen)
  if (sorted.length > 64) {
    const foldTarget = sorted[sorted.length - 65];
    retiredThroughGen = Math.max(retiredThroughGen, foldTarget);
  }
  const keptSparse = sorted.filter((n) => n > retiredThroughGen);
  next[entityKey] = {
    retiredThroughGen,
    retiredGens: keptSparse,
    lastCleanupEpoch: Math.max(
      Number(existing?.lastCleanupEpoch || 0),
      Number(cleanupEpoch || 0)
    ),
    updatedAt: nowIso || existing?.updatedAt || new Date().toISOString(),
  };
  return next;
}

function isGenerationRetiredInManifest(
  manifest: Partial<FirestoreRagManifestDoc> | null | undefined,
  entityKey: string,
  generation: number
): boolean {
  if (!manifest || !entityKey || generation <= 0) return false;
  const ledger = manifest.retiredGenerationsByEntity?.[entityKey];
  if (!ledger) return false;
  if (generation <= Number(ledger.retiredThroughGen || 0)) {
    return true;
  }
  return Array.isArray(ledger.retiredGens) && ledger.retiredGens.includes(generation);
}

function getMaxRetiredGenerationInManifest(
  manifest: Partial<FirestoreRagManifestDoc> | null | undefined,
  entityKey?: string
): number {
  if (!manifest?.retiredGenerationsByEntity) return 0;
  let maxGen = 0;
  const entries = entityKey
    ? ([manifest.retiredGenerationsByEntity[entityKey]].filter(Boolean) as EntityRetiredGenerationLedger[])
    : Object.values(manifest.retiredGenerationsByEntity);
  for (const ledger of entries) {
    if (!ledger) continue;
    maxGen = Math.max(maxGen, Number(ledger.retiredThroughGen || 0));
    if (Array.isArray(ledger.retiredGens)) {
      for (const g of ledger.retiredGens) {
        if (typeof g === 'number') maxGen = Math.max(maxGen, g);
      }
    }
  }
  return maxGen;
}

function pruneManifestCleanupClaims(
  claims: Record<string, RagManifestCleanupClaim> | undefined,
  retiredLedger?: Record<string, EntityRetiredGenerationLedger>
): {
  cleanupClaims: Record<string, RagManifestCleanupClaim>;
  retiredGenerationsByEntity: Record<string, EntityRetiredGenerationLedger>;
} {
  let nextLedger: Record<string, EntityRetiredGenerationLedger> = retiredLedger
    ? { ...retiredLedger }
    : {};
  if (!claims) {
    return { cleanupClaims: {}, retiredGenerationsByEntity: nextLedger };
  }
  for (const v of Object.values(claims)) {
    if (v && v.status === 'CLEANUP_COMPLETED' && v.entityKey && v.generation > 0) {
      nextLedger = recordRetiredGenerationInLedgerMap(
        nextLedger,
        v.entityKey,
        v.generation,
        v.cleanupEpoch,
        v.completedAt || v.claimedAt
      );
    }
  }
  const entries = Object.entries(claims);
  if (entries.length <= 40) {
    return { cleanupClaims: { ...claims }, retiredGenerationsByEntity: nextLedger };
  }
  const pending: [string, RagManifestCleanupClaim][] = [];
  const completed: [string, RagManifestCleanupClaim][] = [];
  for (const [k, v] of entries) {
    if (!v) continue;
    if (v.status === 'CLEANUP_PENDING') {
      pending.push([k, v]);
    } else {
      completed.push([k, v]);
    }
  }
  completed.sort((a, b) =>
    String(b[1].completedAt || b[1].claimedAt || '').localeCompare(
      String(a[1].completedAt || a[1].claimedAt || '')
    )
  );
  const kept = [...pending, ...completed.slice(0, 25)];
  return {
    cleanupClaims: Object.fromEntries(kept),
    retiredGenerationsByEntity: nextLedger,
  };
}

/**
 * In-memory Mock Firestore backend that enforces Firestore's exact 500-operation batch limit,
 * atomic `runTransaction()` semantics, `findNearest()` vector search with snapshot reuse,
 * 10-step cloud deletion with partial batch failure simulation, and server restart recovery.
 */
export class InMemoryMockFirestoreRagBackend {
  public readonly documentsByPath = new Map<string, Record<string, unknown>>();
  public readonly manifestsByProject = new Map<string, FirestoreRagManifestDoc>();
  public readonly stagingReceiptsByPath = new Map<
    string,
    RagGenerationStagingReceipt
  >();
  public committedBatchCount = 0;
  public committedWriteOpsCount = 0;
  public committedDeleteBatchCount = 0;
  public committedDeleteOpsCount = 0;
  public transactionCommitCount = 0;
  public reservationTransactionCount = 0;
  public batchGetDocsCallCount = 0;
  public individualGetDocCallCount = 0;
  public simulateBatchFailureAtBatchNumber: number | null = null;
  public simulateDeleteBatchFailureAtBatchNumber: number | null = null;
  public simulateTransactionFailure = false;
  public simulateStagingVerificationFailure = false;
  public simulateVectorSearchError: string | boolean | null = null;
  public simulateRecoveryFailure: string | null = null;
  public simulateOwnershipLookupFailure: string | null = null;
  public strictCloudOwnershipRequired = false;

  /**
   * Optional custom vector search override for deterministic ranking tests
   * (e.g., Chunk A = 0.95, Chunk B = 0.82, Chunk C = 0.61 or reversed order).
   */
  public customVectorSearchResults:
    | {
        chunkId: string;
        similarity?: number;
        vectorScore?: number;
      }[]
    | null = null;

  private makeManifestKey(ownerId: string, projectId: string): string {
    return `users/${ownerId}/projects/${projectId}/ragManifest/control`;
  }

  seedProjectDoc(params: {
    userPathUid: string;
    projectId: string;
    docOwnerId: string;
  }): void {
    const docPath = `users/${params.userPathUid}/projects/${params.projectId}`;
    this.documentsByPath.set(docPath, {
      id: params.projectId,
      ownerId: params.docOwnerId,
    });
  }

  seedCanonicalEpisodeDoc(params: {
    ownerId?: string;
    userPathUid?: string;
    projectId: string;
    episodeId: string;
    episodeNumber?: number;
    title: string;
    content: string;
    canonStatus: CanonStatus;
    latestRevisionId?: string;
    sourceRevisionId?: string;
  }): void {
    const resolvedOwner = params.ownerId || params.userPathUid || '';
    const resolvedRev =
      params.latestRevisionId || params.sourceRevisionId || 'initial_revision';
    const epPath = `users/${resolvedOwner}/projects/${params.projectId}/episodes/${params.episodeId}`;
    this.documentsByPath.set(epPath, {
      id: params.episodeId,
      ownerId: resolvedOwner,
      projectId: params.projectId,
      episodeNumber: params.episodeNumber ?? 1,
      title: params.title,
      content: params.content,
      canonStatus: params.canonStatus,
      status: params.canonStatus === 'CANON' ? 'confirmed' : 'draft',
      latestRevisionId: resolvedRev,
      sourceRevisionId: resolvedRev,
    });
  }

  createOwnershipLookupFn(): FirestoreProjectLookupFn {
    return async ({ authenticatedUid, projectId }) => {
      if (this.simulateOwnershipLookupFailure) {
        return {
          existsUnderUserPath: false,
          lookupFailed: true,
          lookupError: this.simulateOwnershipLookupFailure,
        };
      }

      const userDocPath = `users/${authenticatedUid}/projects/${projectId}`;
      const directDoc = this.documentsByPath.get(userDocPath);

      let actualOwnerInDatabase: string | null = null;
      for (const [docPath, data] of this.documentsByPath.entries()) {
        if (
          docPath.endsWith(`/projects/${projectId}`) &&
          typeof data.ownerId === 'string'
        ) {
          actualOwnerInDatabase = data.ownerId;
          break;
        }
      }

      if (!actualOwnerInDatabase) {
        for (const manifest of this.manifestsByProject.values()) {
          if (manifest.projectId === projectId && manifest.ownerId) {
            actualOwnerInDatabase = manifest.ownerId;
            break;
          }
        }
      }

      if (directDoc) {
        return {
          existsUnderUserPath: true,
          docOwnerId:
            typeof directDoc.ownerId === 'string'
              ? directDoc.ownerId
              : undefined,
          actualOwnerInDatabase:
            actualOwnerInDatabase ||
            (typeof directDoc.ownerId === 'string'
              ? directDoc.ownerId
              : authenticatedUid),
        };
      }

      return {
        existsUnderUserPath: false,
        actualOwnerInDatabase,
      };
    };
  }

  private readonly previousActiveEntriesByEntityKey = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();

  reserveGenerationForEntity(params: {
    ownerId: string;
    projectId: string;
    sourceEntityType: MemorySourceEntityType;
    sourceEntityId: string;
    minimumFloor?: number;
    stagingId?: string;
    activationMode?: RagActivationMode;
    expectedDocumentCount?: number;
    expectedChunkCount?: number;
    expectedContentHash?: string;
    expectedSourceRevisionId?: string;
    targetTaskId?: string;
    targetLeaseGeneration?: number;
    activationToken?: string;
  }): number {
    const manifestKey = this.makeManifestKey(params.ownerId, params.projectId);
    const nowIso = new Date().toISOString();
    const existing: FirestoreRagManifestDoc = this.manifestsByProject.get(
      manifestKey
    ) || {
      ownerId: params.ownerId,
      projectId: params.projectId,
      activeGenerationCounter: 0,
      entityStates: {},
      projectLifecycleStatus: 'ACTIVE',
      projectTombstoneGeneration: 0,
      pendingDeletes: {},
      updatedAt: nowIso,
    };

    if (
      existing.projectLifecycleStatus === 'PENDING_DELETE' ||
      existing.projectLifecycleStatus === 'DELETED'
    ) {
      throw new Error(
        `[ENTITY_OR_PROJECT_DELETED] 삭제 진행 중이거나 삭제된 프로젝트('${params.projectId}')에는 세대를 예약할 수 없습니다.`
      );
    }

    const eKey = `${params.ownerId}:${params.projectId}:${params.sourceEntityType}:${params.sourceEntityId}`;
    const entitySt = existing.entityStates[eKey];
    let maxClaimedGen = 0;
    for (const claim of Object.values(existing.cleanupClaims || {})) {
      if (claim && typeof claim.generation === 'number') {
        maxClaimedGen = Math.max(maxClaimedGen, claim.generation);
      }
    }
    const maxRetiredGen = getMaxRetiredGenerationInManifest(existing);
    const nextGen =
      Math.max(
        existing.activeGenerationCounter || 0,
        existing.projectTombstoneGeneration || 0,
        entitySt?.activeGeneration || 0,
        entitySt?.deletionTombstoneGeneration || 0,
        maxClaimedGen,
        maxRetiredGen,
        params.minimumFloor || 0
      ) + 1;

    existing.activeGenerationCounter = nextGen;
    existing.updatedAt = nowIso;
    this.manifestsByProject.set(manifestKey, existing);
    this.reservationTransactionCount += 1;

    if (params.stagingId) {
      const stagingPath = `users/${params.ownerId}/projects/${params.projectId}/ragGenerationStaging/${params.stagingId}`;
      const receipt: RagGenerationStagingReceipt = {
        id: params.stagingId,
        ownerId: params.ownerId,
        projectId: params.projectId,
        entityKey: eKey,
        sourceEntityType: params.sourceEntityType,
        sourceEntityId: params.sourceEntityId,
        generation: nextGen,
        activationMode: params.activationMode || 'MANIFEST_POINTER',
        status: 'PREPARING',
        expectedDocumentIds: [],
        expectedDocumentCount: params.expectedDocumentCount ?? 0,
        expectedChunkCount: params.expectedChunkCount ?? 0,
        expectedContentHash: params.expectedContentHash ?? '',
        expectedSourceRevisionId: params.expectedSourceRevisionId ?? '',
        stagedDocumentCount: 0,
        stagedChunkCount: 0,
        verifiedDocumentCount: 0,
        verifiedChunkCount: 0,
        batchesCommitted: 0,
        targetTaskId: params.targetTaskId,
        targetLeaseGeneration: params.targetLeaseGeneration,
        activationToken: params.activationToken,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this.stagingReceiptsByPath.set(stagingPath, receipt);
      this.documentsByPath.set(
        stagingPath,
        receipt as unknown as Record<string, unknown>
      );
    }

    return nextGen;
  }

  async writeStagedDocsAndChunksInBatches(params: {
    ownerId: string;
    projectId: string;
    documents: MemoryDocument[];
    chunks: MemoryChunk[];
    generation: number;
    largeScaleGenerationMode?: boolean;
    stagingId?: string;
    entityState?: EntityIndexLifecycleState;
    onAfterStagingInitReadBeforeWriteHook?: (ctx: {
      generation: number;
      stagingId?: string;
      status?: RagGenerationStagingStatus;
    }) => Promise<void> | void;
    onDuringStagingHook?: (ctx: {
      generation: number;
      stagingId?: string;
      largeScaleGenerationMode: boolean;
    }) => Promise<void> | void;
  }): Promise<{ batchesCommitted: number; totalOpsWritten: number }> {
    const basePath = `users/${params.ownerId}/projects/${params.projectId}`;
    const pendingOps: { path: string; data: Record<string, unknown> }[] = [];
    const nowIso = new Date().toISOString();

    const firstDoc = params.documents[0];
    const entityKey = firstDoc
      ? `${params.ownerId}:${params.projectId}:${firstDoc.sourceEntityType}:${firstDoc.sourceEntityId}`
      : '';
    const isLargeScale = Boolean(params.largeScaleGenerationMode);
    const stagingPath = params.stagingId
      ? `${basePath}/ragGenerationStaging/${params.stagingId}`
      : '';

    const validateStagingEligibility = (
      mDoc: FirestoreRagManifestDoc | undefined,
      rDoc: RagGenerationStagingReceipt | undefined
    ) => {
      if (entityKey) {
        const claimKey = makeCleanupClaimKey(entityKey, params.generation);
        const activeClaim = mDoc?.cleanupClaims?.[claimKey];
        if (
          activeClaim?.status === 'CLEANUP_PENDING' ||
          activeClaim?.status === 'CLEANUP_COMPLETED' ||
          rDoc?.status === 'CLEANUP_PENDING' ||
          rDoc?.status === 'CLEANUP_COMPLETED' ||
          isGenerationRetiredInManifest(mDoc, entityKey, params.generation)
        ) {
          throw new Error(
            `[ACTIVATION_BLOCKED_BY_CLEANUP] [RAG_INDEX_ACTIVATION_CONFLICT] 정리(Cleanup)가 선점 또는 완료한 세대(gen=${params.generation}, claimOp=${String(
              activeClaim?.cleanupOperationId ||
                rDoc?.cleanupOperationId ||
                'retired'
            )})에는 스테이징을 기록하거나 활성화할 수 없습니다.`
          );
        }
        if (rDoc?.status === 'ACTIVATED') {
          throw new Error(
            `[RAG_INDEX_ACTIVATION_CONFLICT] [STAGING_ALREADY_ACTIVATED] 이미 ACTIVATED 상태인 스테이징 영수증(${params.stagingId})은 PREPARING으로 되돌릴 수 없습니다.`
          );
        }
        if (rDoc?.status === 'ABORTED') {
          throw new Error(
            `[RAG_INDEX_ACTIVATION_CONFLICT] [STAGING_ABORTED_CANNOT_REENTER] 이미 ABORTED 상태인 세대(gen=${params.generation})의 스테이징 영수증(${params.stagingId})은 PREPARING으로 재진입할 수 없습니다.`
          );
        }
        if (rDoc?.status === 'VERIFIED') {
          const sameIdempotentWork =
            (!rDoc.activationToken ||
              !params.entityState?.activationToken ||
              rDoc.activationToken === params.entityState.activationToken) &&
            (!rDoc.targetTaskId ||
              !params.entityState?.activeTaskId ||
              rDoc.targetTaskId === params.entityState.activeTaskId) &&
            rDoc.expectedContentHash === (firstDoc?.contentHash || '') &&
            rDoc.expectedDocumentCount === params.documents.length &&
            rDoc.expectedChunkCount === params.chunks.length;
          if (!sameIdempotentWork) {
            throw new Error(
              `[RAG_INDEX_ACTIVATION_CONFLICT] [STAGING_VERIFIED_TOKEN_MISMATCH] 다른 작업/토큰으로 VERIFIED 상태의 스테이징 영수증(${params.stagingId})을 PREPARING으로 덮어쓸 수 없습니다.`
            );
          }
        }
      }
    };

    const manifest = this.getManifest(params.ownerId, params.projectId);
    const currentEntityManifest = entityKey
      ? manifest?.entityStates?.[entityKey]
      : undefined;
    const existingReceiptBeforeHook = stagingPath
      ? this.stagingReceiptsByPath.get(stagingPath)
      : undefined;

    validateStagingEligibility(manifest, existingReceiptBeforeHook);

    if (params.onAfterStagingInitReadBeforeWriteHook) {
      await params.onAfterStagingInitReadBeforeWriteHook({
        generation: params.generation,
        stagingId: params.stagingId,
        status: existingReceiptBeforeHook?.status,
      });
    }

    // Re-read inside simulated atomic PREPARING TX to prevent TOCTOU races
    const txManifest = this.getManifest(params.ownerId, params.projectId);
    const txEntityManifest = entityKey
      ? txManifest?.entityStates?.[entityKey]
      : undefined;
    const existingMockReceipt = stagingPath
      ? this.stagingReceiptsByPath.get(stagingPath)
      : undefined;
    validateStagingEligibility(txManifest, existingMockReceipt);

    if (
      isLargeScale &&
      txEntityManifest &&
      txEntityManifest.activeGeneration !== params.generation
    ) {
      if (txEntityManifest.activeGeneration > params.generation) {
        throw new Error(
          `[RAG_INDEX_ACTIVATION_CONFLICT] 더 최신 활성 세대(gen=${txEntityManifest.activeGeneration})가 존재하므로 구세대(gen=${params.generation}) 스테이징을 기록할 수 없습니다.`
        );
      }
      const activeSet = new Set(txEntityManifest.activeDocumentIds || []);
      for (const docItem of params.documents) {
        if (activeSet.has(docItem.id)) {
          throw new Error(
            `[ACTIVE_GENERATION_OVERWRITE_BLOCKED] 대량 색인 스테이징 중 기존 활성 세대 문서(${docItem.id}) 경로로의 직접 덮어쓰기가 차단되었습니다.`
          );
        }
      }
    }

    if (stagingPath && firstDoc && existingMockReceipt?.status !== 'VERIFIED') {
      const initialReceipt: RagGenerationStagingReceipt =
        sanitizeFirestoreWriteData({
          id: params.stagingId!,
          ownerId: params.ownerId,
          projectId: params.projectId,
          entityKey,
          sourceEntityType: firstDoc.sourceEntityType,
          sourceEntityId: firstDoc.sourceEntityId,
          generation: params.generation,
          activationMode: isLargeScale ? 'MANIFEST_POINTER' : 'INLINE_DOC',
          status: 'PREPARING',
          expectedDocumentIds: params.documents.map((d) => d.id),
          expectedDocumentCount: params.documents.length,
          expectedChunkCount: params.chunks.length,
          expectedContentHash: firstDoc.contentHash || '',
          expectedSourceRevisionId: firstDoc.sourceRevisionId || '',
          stagedDocumentCount: 0,
          stagedChunkCount: 0,
          verifiedDocumentCount: 0,
          verifiedChunkCount: 0,
          batchesCommitted: 0,
          ...(params.entityState?.activeTaskId !== undefined
            ? { targetTaskId: params.entityState.activeTaskId }
            : {}),
          ...(params.entityState?.activeLeaseGeneration !== undefined
            ? { targetLeaseGeneration: params.entityState.activeLeaseGeneration }
            : {}),
          ...(params.entityState?.activationToken !== undefined
            ? { activationToken: params.entityState.activationToken }
            : {}),
          createdAt: existingMockReceipt?.createdAt || nowIso,
          updatedAt: nowIso,
        });
      this.stagingReceiptsByPath.set(stagingPath, initialReceipt);
      this.documentsByPath.set(
        stagingPath,
        initialReceipt as unknown as Record<string, unknown>
      );
    }

    const backupMap = new Map<string, Record<string, unknown>>();
    for (const docItem of params.documents) {
      const dPath = `${basePath}/memoryDocuments/${docItem.id}`;
      const existingDoc = this.documentsByPath.get(dPath);
      if (
        !isLargeScale &&
        existingDoc &&
        existingDoc.isActiveGeneration !== false
      ) {
        backupMap.set(dPath, structuredClone(existingDoc));
      }
      pendingOps.push({
        path: dPath,
        data: sanitizeFirestoreWriteData({
          ...docItem,
          documentId: docItem.id,
          indexGeneration: params.generation,
          isActiveGeneration: false,
          activationMode: isLargeScale ? 'MANIFEST_POINTER' : 'INLINE_DOC',
          ...(params.stagingId !== undefined ? { stagingId: params.stagingId } : {}),
          lifecycleStatus: 'REINDEXING_KEEP_OLD',
        }),
      });
    }

    for (const chk of params.chunks) {
      const cPath = `${basePath}/memoryChunks/${chk.id}`;
      const existingChk = this.documentsByPath.get(cPath);
      if (
        !isLargeScale &&
        existingChk &&
        existingChk.isActiveGeneration !== false
      ) {
        backupMap.set(cPath, structuredClone(existingChk));
      }
      pendingOps.push({
        path: cPath,
        data: sanitizeFirestoreWriteData({
          ...chk,
          chunkId: chk.id,
          originalText: chk.content,
          indexGeneration: params.generation,
          isActiveGeneration: false,
          activationMode: isLargeScale ? 'MANIFEST_POINTER' : 'INLINE_DOC',
          ...(params.stagingId !== undefined ? { stagingId: params.stagingId } : {}),
          lifecycleStatus: 'REINDEXING_KEEP_OLD',
        }),
      });
    }

    if (entityKey && !isLargeScale) {
      if (backupMap.size > 0) {
        this.previousActiveEntriesByEntityKey.set(entityKey, backupMap);
      } else {
        this.previousActiveEntriesByEntityKey.delete(entityKey);
      }
    }

    let batchesCommitted = 0;
    let totalOpsWritten = 0;

    for (let i = 0; i < pendingOps.length; i += FIRESTORE_MAX_BATCH_OPS) {
      const slice = pendingOps.slice(i, i + FIRESTORE_MAX_BATCH_OPS);
      if (slice.length > 500) {
        throw new Error(
          `[FIRESTORE_BATCH_COMMIT_FAILED] FIRESTORE_BATCH_LIMIT_EXCEEDED: 단일 WriteBatch 작업 수(${slice.length})가 Firestore 제한(500개)을 초과했습니다.`
        );
      }
      const nextBatchNum = batchesCommitted + 1;
      if (
        this.simulateBatchFailureAtBatchNumber !== null &&
        nextBatchNum === this.simulateBatchFailureAtBatchNumber
      ) {
        if (entityKey && !isLargeScale && backupMap.size > 0) {
          for (const [bPath, bData] of backupMap.entries()) {
            this.documentsByPath.set(bPath, bData);
          }
          this.previousActiveEntriesByEntityKey.delete(entityKey);
        }
        const errMsg = `[FIRESTORE_BATCH_COMMIT_FAILED] [FIRESTORE_WRITE_FAILED] MOCK_FIRESTORE_BATCH_WRITE_FAILED: 배치 #${nextBatchNum} 쓰기 중 오류 시뮬레이션`;
        if (stagingPath && this.stagingReceiptsByPath.has(stagingPath)) {
          const prevR = this.stagingReceiptsByPath.get(stagingPath)!;
          const abortedR: RagGenerationStagingReceipt = {
            ...prevR,
            status: 'ABORTED',
            batchesCommitted,
            errorMessage: errMsg,
            updatedAt: new Date().toISOString(),
          };
          this.stagingReceiptsByPath.set(stagingPath, abortedR);
          this.documentsByPath.set(
            stagingPath,
            abortedR as unknown as Record<string, unknown>
          );
        }
        throw new Error(errMsg);
      }

      for (const op of slice) {
        this.documentsByPath.set(op.path, op.data);
      }
      batchesCommitted += 1;
      totalOpsWritten += slice.length;
      this.committedBatchCount += 1;
      this.committedWriteOpsCount += slice.length;
    }

    if (params.onDuringStagingHook) {
      await params.onDuringStagingHook({
        generation: params.generation,
        stagingId: params.stagingId,
        largeScaleGenerationMode: isLargeScale,
      });
    }

    if (stagingPath && this.stagingReceiptsByPath.has(stagingPath)) {
      const stagedR: RagGenerationStagingReceipt = {
        ...this.stagingReceiptsByPath.get(stagingPath)!,
        status: 'STAGED',
        stagedDocumentCount: params.documents.length,
        stagedChunkCount: params.chunks.length,
        batchesCommitted,
        updatedAt: new Date().toISOString(),
      };
      this.stagingReceiptsByPath.set(stagingPath, stagedR);
      this.documentsByPath.set(
        stagingPath,
        stagedR as unknown as Record<string, unknown>
      );

      if (this.simulateStagingVerificationFailure) {
        const failR: RagGenerationStagingReceipt = {
          ...stagedR,
          status: 'ABORTED',
          errorMessage:
            '[STAGING_VERIFICATION_INCOMPLETE] MOCK_STAGING_VERIFICATION_FAILED',
          updatedAt: new Date().toISOString(),
        };
        this.stagingReceiptsByPath.set(stagingPath, failR);
        this.documentsByPath.set(
          stagingPath,
          failR as unknown as Record<string, unknown>
        );
        throw new Error(
          '[STAGING_VERIFICATION_INCOMPLETE] MOCK_STAGING_VERIFICATION_FAILED: 스테이징 무결성 검증 실패 시뮬레이션'
        );
      }

      // Completeness check against stored docs & chunks for this generation
      let verifiedDocs = 0;
      for (const docItem of params.documents) {
        const storedD = this.documentsByPath.get(
          `${basePath}/memoryDocuments/${docItem.id}`
        );
        if (
          storedD &&
          storedD.indexGeneration === params.generation &&
          storedD.contentHash === docItem.contentHash &&
          storedD.sourceRevisionId === docItem.sourceRevisionId &&
          storedD.chunkCount === docItem.chunkCount
        ) {
          verifiedDocs += 1;
        }
      }
      let verifiedChunks = 0;
      const verifiedChunkIds = new Set<string>();
      for (const chk of params.chunks) {
        const storedC = this.documentsByPath.get(
          `${basePath}/memoryChunks/${chk.id}`
        );
        if (
          storedC &&
          (storedC.id || chk.id) === chk.id &&
          storedC.indexGeneration === params.generation &&
          storedC.documentId === chk.documentId &&
          storedC.chunkIndex === chk.chunkIndex &&
          storedC.sourceRevisionId === chk.sourceRevisionId &&
          typeof storedC.sourceStartOffset === 'number' &&
          storedC.sourceStartOffset === chk.sourceStartOffset &&
          typeof storedC.sourceEndOffset === 'number' &&
          storedC.sourceEndOffset === chk.sourceEndOffset &&
          typeof storedC.contentHash === 'string' &&
          storedC.contentHash.length > 0 &&
          storedC.contentHash === chk.contentHash &&
          storedC.embeddingDimension === chk.embeddingDimension &&
          storedC.embeddingModelId === chk.embeddingModelId
        ) {
          verifiedChunkIds.add(chk.id);
          verifiedChunks += 1;
        }
      }
      if (
        verifiedDocs !== params.documents.length ||
        verifiedChunks !== params.chunks.length ||
        verifiedChunkIds.size !== params.chunks.length
      ) {
        const failR: RagGenerationStagingReceipt = {
          ...stagedR,
          status: 'ABORTED',
          errorMessage: `[STAGING_VERIFICATION_INCOMPLETE] 스테이징 완료 검증 실패 (docs=${verifiedDocs}/${params.documents.length}, chunks=${verifiedChunks}/${params.chunks.length})`,
          updatedAt: new Date().toISOString(),
        };
        this.stagingReceiptsByPath.set(stagingPath, failR);
        this.documentsByPath.set(
          stagingPath,
          failR as unknown as Record<string, unknown>
        );
        throw new Error(
          `[STAGING_VERIFICATION_INCOMPLETE] 스테이징 완료 검증 실패 (docs=${verifiedDocs}/${params.documents.length}, chunks=${verifiedChunks}/${params.chunks.length}).`
        );
      }

      const verifiedIso = new Date().toISOString();
      const verifiedR: RagGenerationStagingReceipt = {
        ...stagedR,
        status: 'VERIFIED',
        verifiedDocumentCount: verifiedDocs,
        verifiedChunkCount: verifiedChunks,
        verifiedAt: verifiedIso,
        updatedAt: verifiedIso,
      };
      this.stagingReceiptsByPath.set(stagingPath, verifiedR);
      this.documentsByPath.set(
        stagingPath,
        verifiedR as unknown as Record<string, unknown>
      );
    }

    return { batchesCommitted, totalOpsWritten };
  }

  private rollbackStagedEntriesOnMockTxFailure(
    ownerId: string,
    projectId: string,
    entityState: EntityIndexLifecycleState
  ): void {
    const backup = this.previousActiveEntriesByEntityKey.get(
      entityState.entityKey
    );
    if (backup && backup.size > 0) {
      for (const [bPath, bData] of backup.entries()) {
        this.documentsByPath.set(bPath, bData);
      }
    }
    this.previousActiveEntriesByEntityKey.delete(entityState.entityKey);
  }

  async commitActiveGenerationTransaction(params: {
    ownerId: string;
    projectId: string;
    entityState: EntityIndexLifecycleState;
    largeScaleGenerationMode?: boolean;
    stagingId?: string;
    expectedChunkCount?: number;
  }): Promise<void> {
    const isLargeScale = Boolean(params.largeScaleGenerationMode);
    if (this.simulateTransactionFailure) {
      if (!isLargeScale) {
        this.rollbackStagedEntriesOnMockTxFailure(
          params.ownerId,
          params.projectId,
          params.entityState
        );
      }
      throw new Error(
        '[FIRESTORE_MANIFEST_ACTIVATION_FAILED] MOCK_FIRESTORE_TRANSACTION_ABORTED: 활성 색인 버전 전환 트랜잭션 충돌/실패 시뮬레이션'
      );
    }

    const basePath = `users/${params.ownerId}/projects/${params.projectId}`;
    const stagingPath = params.stagingId
      ? `${basePath}/ragGenerationStaging/${params.stagingId}`
      : '';
    const manifestKey = this.makeManifestKey(params.ownerId, params.projectId);
    const existing: FirestoreRagManifestDoc = this.manifestsByProject.get(
      manifestKey
    ) || {
      ownerId: params.ownerId,
      projectId: params.projectId,
      activeGenerationCounter: 0,
      entityStates: {},
      projectLifecycleStatus: 'ACTIVE',
      projectTombstoneGeneration: 0,
      cleanupEpochCounter: 0,
      cleanupClaims: {},
      pendingDeletes: {},
      updatedAt: new Date().toISOString(),
    };

    const claimKey = makeCleanupClaimKey(
      params.entityState.entityKey,
      params.entityState.activeGeneration
    );
    const manifestCleanupClaim = existing.cleanupClaims?.[claimKey];
    const existingReceipt = stagingPath
      ? this.stagingReceiptsByPath.get(stagingPath)
      : undefined;
    if (
      existingReceipt?.status === 'CLEANUP_PENDING' ||
      existingReceipt?.status === 'CLEANUP_COMPLETED' ||
      manifestCleanupClaim?.status === 'CLEANUP_PENDING' ||
      manifestCleanupClaim?.status === 'CLEANUP_COMPLETED' ||
      isGenerationRetiredInManifest(
        existing,
        params.entityState.entityKey,
        params.entityState.activeGeneration
      )
    ) {
      if (!isLargeScale) {
        this.rollbackStagedEntriesOnMockTxFailure(
          params.ownerId,
          params.projectId,
          params.entityState
        );
      }
      throw new Error(
        `[ACTIVATION_BLOCKED_BY_CLEANUP] [RAG_INDEX_ACTIVATION_CONFLICT] [FIRESTORE_MANIFEST_ACTIVATION_FAILED] 정리(Cleanup)가 이미 선점 또는 완료한 세대(gen=${params.entityState.activeGeneration}, claimOp=${String(
          manifestCleanupClaim?.cleanupOperationId ||
            existingReceipt?.cleanupOperationId ||
            'retired'
        )})는 활성화할 수 없습니다.`
      );
    }

    if (isLargeScale && stagingPath) {
      const receipt = existingReceipt;
      if (!receipt || receipt.status !== 'VERIFIED') {
        throw new Error(
          `[FIRESTORE_MANIFEST_ACTIVATION_FAILED] [STAGING_NOT_VERIFIED] 스테이징 영수증(${params.stagingId})이 VERIFIED 상태가 아니므로 활성화할 수 없습니다.`
        );
      }
      if (
        receipt.generation !== params.entityState.activeGeneration ||
        (typeof params.expectedChunkCount === 'number' &&
          receipt.verifiedChunkCount !== params.expectedChunkCount) ||
        receipt.expectedDocumentCount !==
          params.entityState.activeDocumentIds.length
      ) {
        throw new Error(
          `[FIRESTORE_MANIFEST_ACTIVATION_FAILED] [STAGING_NOT_VERIFIED] 스테이징 영수증(${params.stagingId})의 세대 또는 청크/문서 수량이 일치하지 않습니다.`
        );
      }
    }

    if (
      (existing.projectLifecycleStatus === 'PENDING_DELETE' ||
        existing.projectLifecycleStatus === 'DELETED') &&
      params.entityState.activeGeneration <= existing.projectTombstoneGeneration
    ) {
      if (!isLargeScale) {
        this.rollbackStagedEntriesOnMockTxFailure(
          params.ownerId,
          params.projectId,
          params.entityState
        );
      }
      throw new Error(
        `[RAG_INDEX_ACTIVATION_CONFLICT] FIRESTORE_TX_STALE_PROJECT_DELETE: 작품 삭제 트랜잭션(gen=${existing.projectTombstoneGeneration}) 이후 이전 색인(gen=${params.entityState.activeGeneration})을 활성화할 수 없습니다.`
      );
    }

    const currentEntity = existing.entityStates[params.entityState.entityKey];
    if (currentEntity) {
      if (
        (currentEntity.lifecycleStatus === 'PENDING_DELETE' ||
          currentEntity.lifecycleStatus === 'DELETED') &&
        params.entityState.activeGeneration <=
          currentEntity.deletionTombstoneGeneration
      ) {
        if (!isLargeScale) {
          this.rollbackStagedEntriesOnMockTxFailure(
            params.ownerId,
            params.projectId,
            params.entityState
          );
        }
        throw new Error(
          `[RAG_INDEX_ACTIVATION_CONFLICT] FIRESTORE_TX_STALE_ENTITY_DELETE: 삭제된 항목(tombstoneGen=${currentEntity.deletionTombstoneGeneration})에 대해 오래된 색인(gen=${params.entityState.activeGeneration}) 전환이 거부되었습니다.`
        );
      }
      if (
        currentEntity.activeGeneration > params.entityState.activeGeneration
      ) {
        if (!isLargeScale) {
          this.rollbackStagedEntriesOnMockTxFailure(
            params.ownerId,
            params.projectId,
            params.entityState
          );
        }
        throw new Error(
          `[RAG_INDEX_ACTIVATION_CONFLICT] FIRESTORE_TX_OLDER_GENERATION_REJECTED: 더 최신 색인 버전(gen=${currentEntity.activeGeneration})이 이미 활성화되어 있습니다.`
        );
      }
      if (
        currentEntity.activeGeneration === params.entityState.activeGeneration
      ) {
        const revisionMismatch = Boolean(
          currentEntity.activeRevisionId &&
            params.entityState.activeRevisionId &&
            currentEntity.activeRevisionId !==
              params.entityState.activeRevisionId
        );
        const hashMismatch = Boolean(
          currentEntity.activeContentHash &&
            params.entityState.activeContentHash &&
            currentEntity.activeContentHash !==
              params.entityState.activeContentHash
        );
        const taskMismatch = Boolean(
          currentEntity.activeTaskId &&
            params.entityState.activeTaskId &&
            currentEntity.activeTaskId !== params.entityState.activeTaskId
        );
        const leaseGenMismatch = Boolean(
          typeof currentEntity.activeLeaseGeneration === 'number' &&
            typeof params.entityState.activeLeaseGeneration === 'number' &&
            currentEntity.activeLeaseGeneration !==
              params.entityState.activeLeaseGeneration
        );
        const tokenMismatch = Boolean(
          currentEntity.activationToken &&
            params.entityState.activationToken &&
            currentEntity.activationToken !== params.entityState.activationToken
        );

        if (
          revisionMismatch ||
          hashMismatch ||
          taskMismatch ||
          leaseGenMismatch ||
          tokenMismatch
        ) {
          if (!isLargeScale) {
            this.rollbackStagedEntriesOnMockTxFailure(
              params.ownerId,
              params.projectId,
              params.entityState
            );
          }
          throw new Error(
            `[RAG_INDEX_ACTIVATION_CONFLICT] FIRESTORE_TX_GENERATION_COLLISION: 동일 세대 번호(gen=${params.entityState.activeGeneration})로 서로 다른 작업 또는 콘텐츠의 색인을 덮어쓸 수 없습니다.`
          );
        }
      }
    }

    const activeDocIdSet = new Set(params.entityState.activeDocumentIds);
    for (const docId of activeDocIdSet) {
      const dPath = `${basePath}/memoryDocuments/${docId}`;
      const stagedDoc = this.documentsByPath.get(dPath);
      if (stagedDoc) {
        this.documentsByPath.set(dPath, {
          ...stagedDoc,
          indexGeneration: params.entityState.activeGeneration,
          isActiveGeneration: true,
          activationMode: isLargeScale ? 'MANIFEST_POINTER' : 'INLINE_DOC',
          lifecycleStatus: 'ACTIVE',
          indexStatus: 'INDEXED',
        });
      }
    }
    if (!isLargeScale) {
      const chunkPrefix = `${basePath}/memoryChunks/`;
      for (const [cPath, cVal] of this.documentsByPath.entries()) {
        if (
          cPath.startsWith(chunkPrefix) &&
          typeof cVal.documentId === 'string' &&
          activeDocIdSet.has(cVal.documentId) &&
          cVal.indexGeneration === params.entityState.activeGeneration
        ) {
          this.documentsByPath.set(cPath, {
            ...cVal,
            isActiveGeneration: true,
            lifecycleStatus: 'ACTIVE',
          });
        }
      }
      this.previousActiveEntriesByEntityKey.delete(params.entityState.entityKey);
    }

    const activatedIso = new Date().toISOString();
    if (stagingPath && this.stagingReceiptsByPath.has(stagingPath)) {
      const prevR = this.stagingReceiptsByPath.get(stagingPath)!;
      const actR: RagGenerationStagingReceipt = {
        ...prevR,
        status: 'ACTIVATED',
        activatedAt: activatedIso,
        updatedAt: activatedIso,
      };
      this.stagingReceiptsByPath.set(stagingPath, actR);
      this.documentsByPath.set(
        stagingPath,
        actR as unknown as Record<string, unknown>
      );
    }

    existing.entityStates[params.entityState.entityKey] = {
      ...params.entityState,
      activationMode: isLargeScale ? 'MANIFEST_POINTER' : 'INLINE_DOC',
      stagingId: params.stagingId,
    };
    existing.activeGenerationCounter = Math.max(
      existing.activeGenerationCounter,
      params.entityState.activeGeneration
    );
    existing.updatedAt = activatedIso;
    this.manifestsByProject.set(manifestKey, existing);
    this.transactionCommitCount += 1;
  }

  /**
   * Batch-fetches parent MemoryDocument records by ID in a single operation (avoiding N+1 queries).
   */
  batchGetMemoryDocumentsByIds(
    ownerId: string,
    projectId: string,
    docIds: string[]
  ): Map<string, MemoryDocument> {
    this.batchGetDocsCallCount += 1;
    const basePath = `users/${ownerId}/projects/${projectId}/memoryDocuments`;
    const result = new Map<string, MemoryDocument>();
    for (const id of new Set(docIds)) {
      const data = this.documentsByPath.get(`${basePath}/${id}`);
      if (data) {
        result.set(id, data as unknown as MemoryDocument);
      }
    }
    return result;
  }

  /**
   * Executes Mock Firestore `findNearest()` vector search over `users/{ownerId}/projects/{projectId}/memoryChunks`
   * (or returns `customVectorSearchResults` when configured for ranking tests), reusing snapshot data directly
   * and batch-loading parent `MemoryDocument` metadata without N+1 queries.
   */
  async findNearestVectorCandidates(params: {
    ownerId: string;
    projectId: string;
    queryEmbedding: number[];
    queryEmbeddingGenerationMode: EmbeddingGenerationMode;
    queryEmbeddingModelId: string;
    limit: number;
    canonOnly: boolean;
  }): Promise<{
    status: 'OK_WITH_HITS' | 'OK_EMPTY' | 'API_ERROR';
    candidates: ExternalFirestoreVectorCandidate[];
    error?: string;
  }> {
    if (this.simulateVectorSearchError) {
      const errStr =
        typeof this.simulateVectorSearchError === 'string'
          ? this.simulateVectorSearchError
          : 'SIMULATED_FIRESTORE_VECTOR_SEARCH_ERROR: Simulated Firestore findNearest() failure';
      return {
        status: 'API_ERROR',
        candidates: [],
        error: errStr,
      };
    }

    const manifest = this.getManifest(params.ownerId, params.projectId);
    if (
      manifest &&
      (manifest.projectLifecycleStatus === 'PENDING_DELETE' ||
        manifest.projectLifecycleStatus === 'DELETED')
    ) {
      return { status: 'OK_EMPTY', candidates: [] };
    }

    const basePath = `users/${params.ownerId}/projects/${params.projectId}`;
    const chunkPrefix = `${basePath}/memoryChunks/`;
    const rawMatchedChunks: { chunk: MemoryChunk; similarity: number }[] = [];

    const isChunkEligibleByManifest = (chk: MemoryChunk): boolean => {
      if (
        chk.lifecycleStatus === 'PENDING_DELETE' ||
        chk.lifecycleStatus === 'DELETED'
      ) {
        return false;
      }
      if (!manifest) {
        return (
          chk.isActiveGeneration !== false &&
          chk.lifecycleStatus !== 'REINDEXING_KEEP_OLD'
        );
      }
      const entityKey = `${chk.ownerId}:${chk.projectId}:${chk.sourceEntityType}:${chk.sourceEntityId}`;
      if (typeof chk.indexGeneration === 'number' && chk.indexGeneration > 0) {
        const claimKey = makeCleanupClaimKey(entityKey, chk.indexGeneration);
        const claim = manifest.cleanupClaims?.[claimKey];
        if (
          (claim &&
            (claim.status === 'CLEANUP_PENDING' ||
              claim.status === 'CLEANUP_COMPLETED')) ||
          isGenerationRetiredInManifest(manifest, entityKey, chk.indexGeneration)
        ) {
          return false;
        }
      }
      const entityState = manifest.entityStates?.[entityKey];
      if (!entityState) {
        return (
          chk.isActiveGeneration !== false &&
          chk.lifecycleStatus !== 'REINDEXING_KEEP_OLD'
        );
      }
      if (
        entityState.lifecycleStatus === 'PENDING_DELETE' ||
        entityState.lifecycleStatus === 'DELETED'
      ) {
        return false;
      }
      if (
        typeof chk.indexGeneration === 'number' &&
        entityState.activeGeneration > 0 &&
        chk.indexGeneration !== entityState.activeGeneration
      ) {
        return false;
      }
      if (
        Array.isArray(entityState.activeDocumentIds) &&
        entityState.activeDocumentIds.length > 0 &&
        !entityState.activeDocumentIds.includes(chk.documentId)
      ) {
        return false;
      }
      if (
        chk.isActiveGeneration === false &&
        chk.activationMode !== 'MANIFEST_POINTER' &&
        entityState.activationMode !== 'MANIFEST_POINTER'
      ) {
        return false;
      }
      return true;
    };

    if (this.customVectorSearchResults !== null) {
      for (const item of this.customVectorSearchResults) {
        let rawChunk = this.documentsByPath.get(
          `${chunkPrefix}${item.chunkId}`
        ) as unknown as MemoryChunk | undefined;
        if (!rawChunk) {
          for (const [docPath, data] of this.documentsByPath.entries()) {
            if (docPath.endsWith(`/memoryChunks/${item.chunkId}`)) {
              rawChunk = data as unknown as MemoryChunk;
              break;
            }
          }
        }
        if (!rawChunk) continue;
        rawMatchedChunks.push({
          chunk: rawChunk,
          similarity: Number(item.vectorScore ?? item.similarity ?? 0),
        });
      }
    } else {
      for (const [docPath, rawData] of this.documentsByPath.entries()) {
        if (!docPath.startsWith(chunkPrefix)) continue;
        const chk = rawData as unknown as MemoryChunk;
        if (chk.ownerId !== params.ownerId || chk.projectId !== params.projectId) {
          continue;
        }
        if (!isChunkEligibleByManifest(chk)) {
          continue;
        }
        if (params.canonOnly && chk.canonStatus !== 'CANON') {
          continue;
        }
        const compatible = areEmbeddingsVectorSpaceCompatible({
          chunkMode: chk.embeddingGenerationMode,
          chunkModelId: chk.embeddingModelId,
          chunkDimension: chk.embeddingDimension || chk.embedding?.length,
          queryMode: params.queryEmbeddingGenerationMode,
          queryModelId: params.queryEmbeddingModelId,
          queryDimension: params.queryEmbedding.length,
        });
        if (!compatible) continue;

        const sim = computeCosineSimilarity(params.queryEmbedding, chk.embedding);
        if (sim > 0) {
          rawMatchedChunks.push({ chunk: chk, similarity: sim });
        }
      }
      rawMatchedChunks.sort((a, b) => b.similarity - a.similarity);
    }

    const candidateCap = Math.min(100, Math.max(10, params.limit * 3));
    const sliced =
      this.customVectorSearchResults !== null
        ? rawMatchedChunks.slice(0, candidateCap)
        : rawMatchedChunks.slice(0, candidateCap);
    if (sliced.length === 0) {
      return { status: 'OK_EMPTY', candidates: [] };
    }

    const parentDocIds = sliced
      .map((s) => s.chunk.documentId)
      .filter((id): id is string => Boolean(id));
    const docsById = this.batchGetMemoryDocumentsByIds(
      params.ownerId,
      params.projectId,
      parentDocIds
    );

    const candidates: ExternalFirestoreVectorCandidate[] = [];
    for (let i = 0; i < sliced.length; i++) {
      const { chunk, similarity } = sliced[i];
      if (!isChunkEligibleByManifest(chunk)) {
        continue;
      }
      const parentDoc = docsById.get(chunk.documentId);
      if (
        parentDoc &&
        (parentDoc.indexStatus === 'PENDING_DELETE' ||
          parentDoc.indexStatus === 'FAILED' ||
          parentDoc.lifecycleStatus === 'PENDING_DELETE' ||
          parentDoc.lifecycleStatus === 'DELETED')
      ) {
        continue;
      }

      candidates.push({
        chunkId: chunk.id,
        documentId: chunk.documentId,
        ownerId: chunk.ownerId,
        projectId: chunk.projectId,
        vectorScore: Number(similarity.toFixed(4)),
        vectorRank: candidates.length + 1,
        embeddingModelId: chunk.embeddingModelId,
        embeddingGenerationMode: chunk.embeddingGenerationMode,
        embeddingDimension: chunk.embeddingDimension || chunk.embedding?.length,
        indexGeneration: chunk.indexGeneration,
        isActiveGeneration: chunk.isActiveGeneration,
        activationMode: chunk.activationMode,
        lifecycleStatus: chunk.lifecycleStatus,
        canonStatus: chunk.canonStatus,
        chunkSnapshot: chunk,
        documentSnapshot: parentDoc,
      });

      if (candidates.length >= Math.min(50, Math.max(5, params.limit * 2))) {
        break;
      }
    }

    return {
      status: candidates.length > 0 ? 'OK_WITH_HITS' : 'OK_EMPTY',
      candidates,
    };
  }

  getManifest(
    ownerId: string,
    projectId: string
  ): FirestoreRagManifestDoc | undefined {
    return this.manifestsByProject.get(
      this.makeManifestKey(ownerId, projectId)
    );
  }
}

let activeMockFirestoreBackend: InMemoryMockFirestoreRagBackend | null = null;

export function setMockFirestoreRagBackendForTesting(
  backend: InMemoryMockFirestoreRagBackend | null
): void {
  activeMockFirestoreBackend = backend;
}

export function getMockFirestoreRagBackendForTesting(): InMemoryMockFirestoreRagBackend | null {
  return activeMockFirestoreBackend;
}

// ============================================================================
// Server-Side In-Memory Active Store Lock & Concurrency State
// ============================================================================

const activeServerStores = new Map<
  string,
  {
    store: FoundationMemorySearchStore;
    snapshot: DiskProjectRagSnapshot;
  }
>();

// Embedding cache keyed by `${modelId}:${dim}:${contentHash}` (ONLY for LIVE_API vectors)
const serverLiveEmbeddingCache = new Map<string, number[]>();
let resolvedActiveEmbeddingModel: string | null = null;

export function clearEmbeddingCacheForTesting(): void {
  serverLiveEmbeddingCache.clear();
  resolvedActiveEmbeddingModel = null;
}

export interface RagExecutionOptions {
  db?: Firestore;
  cacheNamespace?: string;
}

const anonymousDbNamespaceMap = new WeakMap<Firestore, string>();
let anonymousDbCounter = 0;

export function resolveStoreNamespace(options?: RagExecutionOptions): string {
  if (options?.cacheNamespace && options.cacheNamespace.trim().length > 0) {
    return sanitizeFileSegment(options.cacheNamespace.trim());
  }
  if (options?.db) {
    const meta = getIsolatedFirestoreBindingMetadata(options.db);
    if (meta?.cacheNamespace) {
      return sanitizeFileSegment(meta.cacheNamespace);
    }
    let anonNs = anonymousDbNamespaceMap.get(options.db);
    if (!anonNs) {
      anonymousDbCounter += 1;
      anonNs = `injected_db_${anonymousDbCounter}`;
      anonymousDbNamespaceMap.set(options.db, anonNs);
    }
    return anonNs;
  }
  return '';
}

function getAdminFirestore(): Firestore | null {
  if (activeMockFirestoreBackend || !hasCloudFirestoreCredentials()) {
    // When running in Mock Firestore test mode or without Cloud credentials, never touch live production Cloud Firestore
    return null;
  }
  try {
    ensureFirebaseAdminInitialized();
    const app = getApps().find((a) => a.name === '[DEFAULT]');
    if (!app) return null;
    const dbId = getFirebaseDatabaseId();
    return getFirestore(app, dbId);
  } catch {
    return null;
  }
}

/**
 * Phase 3.2.1 P0 — Optional Firestore Dependency Injection Resolver:
 * - If `options?.db` is provided, strictly returns `options.db` and NEVER falls back to production `getAdminFirestore()`.
 * - If `options?.db` is omitted, uses the default server Firestore connection (`getAdminFirestore()`).
 */
export function resolveRagFirestore(
  options?: RagExecutionOptions
): Firestore | null {
  if (options?.db !== undefined) {
    return options.db;
  }
  return getAdminFirestore();
}

export function getConfiguredEmbeddingModel(): string {
  const envModel = process.env.GEMINI_EMBEDDING_MODEL?.trim();
  if (envModel && envModel.length > 0) {
    return envModel;
  }
  return (
    resolvedActiveEmbeddingModel || RAG_ENGINE_DEFAULTS.DEFAULT_EMBEDDING_MODEL
  );
}

export function getConfiguredEmbeddingDimension(): number {
  const rawStr = process.env.GEMINI_EMBEDDING_DIMENSION;
  if (rawStr !== undefined && rawStr.trim() !== '') {
    const raw = Number(rawStr);
    if (!Number.isInteger(raw) || raw < 1 || raw > 2048) {
      const err = new Error(
        `FIRESTORE_VECTOR_DIMENSION_OUT_OF_RANGE(400): Firestore Vector Search는 1~2048 차원만 지원합니다. 요청/설정된 차원: ${rawStr}`
      );
      (err as unknown as { statusCode: number }).statusCode = 400;
      throw err;
    }
    return raw;
  }
  return RAG_ENGINE_DEFAULTS.DEFAULT_EMBEDDING_DIMENSION;
}

function isGeminiApiKeyConfigured(): boolean {
  const key = process.env.GEMINI_API_KEY?.trim();
  return Boolean(key && key.length > 0 && key !== 'MY_GEMINI_API_KEY');
}

// ============================================================================
// Phase 3.1.1 P0-2: Model-Specific Embedding Adapters (Gemini Embedding 2 vs Legacy)
// ============================================================================

export type GeminiEmbedContentParams = {
  model: string;
  contents: string;
  config: Record<string, unknown>;
};

export type CustomGeminiEmbedContentFn = (
  params: GeminiEmbedContentParams
) => Promise<{
  embeddings?: { values?: number[] }[];
}>;

let customGeminiEmbedContentFn: CustomGeminiEmbedContentFn | null = null;

export function setCustomGeminiEmbedContentForTesting(
  fn: CustomGeminiEmbedContentFn | null
): void {
  customGeminiEmbedContentFn = fn;
  serverLiveEmbeddingCache.clear();
}

const DEPRECATED_EMBEDDING_MODELS = new Set([
  'text-embedding-004',
  'models/text-embedding-004',
  'embedding-001',
  'models/embedding-001',
]);

export function isGeminiEmbedding2Model(modelId: string): boolean {
  const normalized = (modelId || '').trim().toLowerCase();
  return (
    normalized === 'gemini-embedding-2' ||
    normalized.startsWith('gemini-embedding-2-') ||
    normalized === 'models/gemini-embedding-2' ||
    normalized.startsWith('models/gemini-embedding-2-')
  );
}

export function isDeprecatedEmbeddingModel(modelId: string): boolean {
  const normalized = (modelId || '').trim().toLowerCase();
  return DEPRECATED_EMBEDDING_MODELS.has(normalized);
}

/**
 * Phase 3.2 Section 4.2:
 * Blocks clients from injecting test embedding modes (`DETERMINISTIC_TEST`),
 * `preferDeterministicEmbeddings`, `simulateFailureForTesting`, or test model IDs
 * via HTTP API payloads (`/api/rag/index-entity`, `/api/rag/search`, etc.).
 */
export function assertNoClientTestEmbeddingModeInjection(payload: {
  input?: Partial<MemoryIndexInput> | null;
  query?: Partial<MemorySearchQuery> | null;
  options?: Record<string, unknown> | null;
  body?: Record<string, unknown> | null;
}): void {
  const input = payload.input;
  const query = payload.query;
  const options = payload.options;
  const body = payload.body;

  if (
    input?.embeddingGenerationMode === 'DETERMINISTIC_TEST' ||
    input?.embeddingModelId === DETERMINISTIC_TEST_EMBEDDING_MODEL_ID ||
    query?.queryEmbeddingGenerationMode === 'DETERMINISTIC_TEST' ||
    query?.queryEmbeddingModelId === DETERMINISTIC_TEST_EMBEDDING_MODEL_ID ||
    Boolean(options?.preferDeterministicEmbeddings) ||
    Boolean(options?.simulateFailureForTesting) ||
    Boolean(options?.db) ||
    Boolean(options?.cacheNamespace) ||
    Boolean(body?.preferDeterministicEmbeddings) ||
    Boolean(body?.simulateFailureForTesting) ||
    Boolean(body?.db) ||
    Boolean(body?.cacheNamespace) ||
    body?.embeddingGenerationMode === 'DETERMINISTIC_TEST'
  ) {
    throw new Error(
      '권한 거부(403 - CLIENT_TEST_EMBEDDING_INJECTION_BLOCKED): 클라이언트 API 요청을 통해 DETERMINISTIC_TEST 임베딩 모드나 서버 전용 테스트 옵션(db, cacheNamespace 등)을 강제 주입할 수 없습니다.'
    );
  }
}

/**
 * Formats retrieval purpose instructions directly into the input text for `gemini-embedding-2`
 * (since `gemini-embedding-2` does NOT support `taskType` or `title` in `config`).
 */
export function formatGeminiEmbedding2InstructionText(params: {
  text: string;
  purpose: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';
  title?: string;
}): string {
  const cleanText = (params.text || '').trim().slice(0, 8000) || '빈 문서';
  if (params.purpose === 'RETRIEVAL_QUERY') {
    return `[NOVEL_FORGE_RETRIEVAL_QUERY] [검색 목적: 한국어 장편 웹소설 기억 검색 질의]\n${cleanText}`;
  }
  const cleanTitle = (params.title || '').trim();
  return cleanTitle
    ? `[NOVEL_FORGE_RETRIEVAL_DOCUMENT] [검색 목적: 한국어 장편 웹소설 정사 기록 문서 색인 | Title: ${cleanTitle}]\n${cleanText}`
    : `[NOVEL_FORGE_RETRIEVAL_DOCUMENT] [검색 목적: 한국어 장편 웹소설 정사 기록 문서 색인]\n${cleanText}`;
}

/**
 * Builds the model-specific `@google/genai` `embedContent` request payload:
 * - For `gemini-embedding-2`:
 *   - Uses `outputDimensionality` (default 768).
 *   - NEVER includes `taskType` or `title` in `config`!
 *   - Embeds consistent document/query purpose instructions into `contents`.
 * - For legacy `gemini-embedding-001`:
 *   - Separate adapter supporting `taskType` and `title` in `config` with isolated model ID.
 * - Rejects deprecated models (`text-embedding-004`).
 */
export function buildModelSpecificEmbeddingRequest(params: {
  modelId: string;
  text: string;
  dimension: number;
  purpose: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';
  title?: string;
}): GeminiEmbedContentParams {
  const modelId = params.modelId.trim();
  if (isDeprecatedEmbeddingModel(modelId)) {
    throw new Error(
      `DEPRECATED_EMBEDDING_MODEL_REJECTED(400): 지원 종료된 임베딩 모델('${modelId}')은 사용할 수 없습니다. 'gemini-embedding-2'를 사용하세요.`
    );
  }

  if (isGeminiEmbedding2Model(modelId)) {
    const instructedText = formatGeminiEmbedding2InstructionText({
      text: params.text,
      purpose: params.purpose,
      title: params.title,
    });
    return {
      model: modelId,
      contents: instructedText,
      config: {
        outputDimensionality: params.dimension,
      },
    };
  }

  // Legacy adapter (e.g., gemini-embedding-001 only when explicitly configured)
  const cleanText = (params.text || '').trim().slice(0, 8000) || '빈 문서';
  const legacyConfig: Record<string, unknown> = {
    outputDimensionality: params.dimension,
    taskType: params.purpose,
  };
  if (params.purpose === 'RETRIEVAL_DOCUMENT' && params.title) {
    legacyConfig.title = params.title;
  }
  return {
    model: modelId,
    contents: cleanText,
    config: legacyConfig,
  };
}

/**
 * Phase 3.1.1 P0-2 & Section 13-3:
 * - Uses model-specific adapter (`buildModelSpecificEmbeddingRequest`).
 * - Validates the returned vector's exact dimension (`values.length === dimension`).
 * - NEVER silently replaces a failed Gemini API call with a deterministic test vector!
 * - `DETERMINISTIC_TEST` vectors are generated ONLY when `preferDeterministicOnly: true` is explicitly passed.
 */
export async function generateServerEmbedding(
  text: string,
  options?: {
    taskType?: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';
    purpose?: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';
    title?: string;
    preferDeterministicOnly?: boolean;
    modelId?: string;
    modelIdOverride?: string;
    dimension?: number;
    dimensionOverride?: number;
  }
): Promise<{
  embedding: number[];
  modelId: string;
  dimension: number;
  embeddingGenerationMode: EmbeddingGenerationMode;
  usedLiveGeminiApi: boolean;
}> {
  const requestedDim = options?.dimension ?? options?.dimensionOverride;
  const dimension =
    requestedDim && requestedDim >= 64
      ? requestedDim
      : getConfiguredEmbeddingDimension();
  const cleanText = (text ?? '').trim().slice(0, 8000);
  const purpose = options?.purpose || options?.taskType || 'RETRIEVAL_DOCUMENT';

  // Deterministic test mode is ONLY used when explicitly requested via preferDeterministicOnly: true
  if (options?.preferDeterministicOnly) {
    const detVec = computeDeterministicSemanticEmbedding(
      `${options?.title || ''}\n${cleanText}`,
      dimension
    );
    return {
      embedding: detVec,
      modelId: DETERMINISTIC_TEST_EMBEDDING_MODEL_ID,
      dimension,
      embeddingGenerationMode: 'DETERMINISTIC_TEST',
      usedLiveGeminiApi: false,
    };
  }

  const targetModel =
    (options?.modelId || options?.modelIdOverride)?.trim() ||
    getConfiguredEmbeddingModel();

  if (isDeprecatedEmbeddingModel(targetModel)) {
    throw new Error(
      `DEPRECATED_EMBEDDING_MODEL_REJECTED(400): 지원 종료된 임베딩 모델('${targetModel}')은 사용할 수 없습니다.`
    );
  }

  if (!customGeminiEmbedContentFn && !isGeminiApiKeyConfigured()) {
    throw new Error(
      'GEMINI_EMBEDDING_API_KEY_MISSING(503): 실제 Gemini Embedding API 호출을 위한 GEMINI_API_KEY가 설정되지 않았습니다. 테스트 벡터로 임의 대체하지 않습니다.'
    );
  }

  const requestPayload = buildModelSpecificEmbeddingRequest({
    modelId: targetModel,
    text: cleanText,
    dimension,
    purpose,
    title: options?.title,
  });

  const hashKey = computeMemoryContentHash(
    `${targetModel}:${dimension}:${purpose}:${options?.title || ''}:${cleanText}`
  );
  const cacheKey = `${targetModel}:${dimension}:${hashKey}`;
  const cached = serverLiveEmbeddingCache.get(cacheKey);
  if (cached && !customGeminiEmbedContentFn) {
    return {
      embedding: cached,
      modelId: targetModel,
      dimension: cached.length,
      embeddingGenerationMode: 'LIVE_API',
      usedLiveGeminiApi: true,
    };
  }

  let response: { embeddings?: { values?: number[] }[] };
  try {
    if (customGeminiEmbedContentFn) {
      response = await customGeminiEmbedContentFn(requestPayload);
    } else {
      const ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });
      response = await ai.models.embedContent(
        requestPayload as Parameters<typeof ai.models.embedContent>[0]
      );
    }
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const statusMatch =
      rawMsg.includes('400') || rawMsg.includes('INVALID_ARGUMENT')
        ? 400
        : rawMsg.includes('429') || rawMsg.includes('RESOURCE_EXHAUSTED')
        ? 429
        : rawMsg.includes('503') || rawMsg.includes('UNAVAILABLE')
        ? 503
        : 500;
    throw new Error(
      `GEMINI_EMBEDDING_API_ERROR(${statusMatch}): 모델('${targetModel}') 임베딩 생성 실패 — ${rawMsg}`
    );
  }

  const values = response.embeddings?.[0]?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(
      `GEMINI_EMBEDDING_EMPTY_RESPONSE(503): 모델('${targetModel}')이 유효한 임베딩 벡터를 반환하지 않았습니다.`
    );
  }

  // Strictly validate returned vector dimension (do NOT silently truncate or accept mismatched dimensions)
  if (values.length !== dimension) {
    throw new Error(
      `EMBEDDING_DIMENSION_MISMATCH(400): 요청한 임베딩 차원(${dimension})과 모델('${targetModel}') 반환 벡터 차원(${values.length})이 일치하지 않습니다.`
    );
  }

  resolvedActiveEmbeddingModel = targetModel;
  serverLiveEmbeddingCache.set(cacheKey, values);
  return {
    embedding: values,
    modelId: targetModel,
    dimension: values.length,
    embeddingGenerationMode: 'LIVE_API',
    usedLiveGeminiApi: true,
  };
}

// ============================================================================
// Persistent Disk Cache + Cloud Firestore Synchronizer & Recovery
// ============================================================================

function ensureCacheDir(): void {
  if (!fs.existsSync(RAG_CACHE_DIR)) {
    fs.mkdirSync(RAG_CACHE_DIR, { recursive: true });
  }
}

function sanitizeFileSegment(seg: string): string {
  return (seg || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 90);
}

function makeStoreMapKey(
  ownerId: string,
  projectId: string,
  options?: RagExecutionOptions
): string {
  const ns = resolveStoreNamespace(options);
  return ns ? `${ns}::${ownerId}:${projectId}` : `${ownerId}:${projectId}`;
}

function getDiskSnapshotPath(
  ownerId: string,
  projectId: string,
  options?: RagExecutionOptions
): string {
  ensureCacheDir();
  const ns = resolveStoreNamespace(options);
  const fileName = ns
    ? `${ns}__${sanitizeFileSegment(ownerId)}__${sanitizeFileSegment(projectId)}.json`
    : `${sanitizeFileSegment(ownerId)}__${sanitizeFileSegment(projectId)}.json`;
  return path.join(RAG_CACHE_DIR, fileName);
}

function loadDiskSnapshot(
  ownerId: string,
  projectId: string,
  options?: RagExecutionOptions
): DiskProjectRagSnapshot {
  const filePath = getDiskSnapshotPath(ownerId, projectId, options);
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as DiskProjectRagSnapshot;
      if (
        parsed &&
        parsed.ownerId === ownerId &&
        parsed.projectId === projectId &&
        Array.isArray(parsed.documents) &&
        Array.isArray(parsed.chunks)
      ) {
        return {
          ...parsed,
          generationCounter:
            typeof parsed.generationCounter === 'number'
              ? parsed.generationCounter
              : 0,
          entityStates: Array.isArray(parsed.entityStates)
            ? parsed.entityStates
            : [],
          failedInputs: Array.isArray(parsed.failedInputs)
            ? parsed.failedInputs
            : [],
          pendingDeletes: Array.isArray(parsed.pendingDeletes)
            ? parsed.pendingDeletes
            : [],
        };
      }
    }
  } catch {
    // ignore corrupted cache and start clean
  }
  return {
    version: RAG_ENGINE_DEFAULTS.INDEX_VERSION,
    ownerId,
    projectId,
    updatedAt: new Date().toISOString(),
    firestoreSynced: false,
    firestoreVectorIndexReady: false,
    generationCounter: 0,
    entityStates: [],
    documents: [],
    chunks: [],
    failedInputs: [],
    pendingDeletes: [],
  };
}

function saveDiskSnapshot(
  snapshot: DiskProjectRagSnapshot,
  options?: RagExecutionOptions
): void {
  const filePath = getDiskSnapshotPath(
    snapshot.ownerId,
    snapshot.projectId,
    options
  );
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function deleteDiskSnapshot(
  ownerId: string,
  projectId: string,
  options?: RagExecutionOptions
): void {
  const filePath = getDiskSnapshotPath(ownerId, projectId, options);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Simulates a server process restart by clearing the in-memory store map.
 */
export function simulateServerRestartForTesting(): void {
  activeServerStores.clear();
}

/**
 * Clears local disk cache snapshot(s) to test cold cloud recovery from Firestore after local disk loss.
 */
export function clearLocalRagDiskCacheForTesting(
  ownerId?: string,
  projectId?: string,
  options?: RagExecutionOptions
): void {
  activeServerStores.clear();
  if (ownerId && projectId) {
    deleteDiskSnapshot(ownerId, projectId, options);
    deleteDiskSnapshot(ownerId, projectId);
    return;
  }
  if (fs.existsSync(RAG_CACHE_DIR)) {
    for (const f of fs.readdirSync(RAG_CACHE_DIR)) {
      if (f.endsWith('.json')) {
        try {
          fs.unlinkSync(path.join(RAG_CACHE_DIR, f));
        } catch {
          // ignore
        }
      }
    }
  }
}

/**
 * Phase 3.1.1 P0-4:
 * Verifies project ownership against Firestore (Mock or live Admin SDK) FIRST.
 * Never trusts client body `ownerId`, `project.ownerId`, `liveSnapshots`, or local cache as proof of ownership.
 */
async function assertServerRagProjectOwnership(params: {
  ownerId: string;
  projectId: string;
  claimedOwnerId?: unknown;
  projectPayloadOwnerId?: unknown;
  requireStrictFirestoreDocCheck?: boolean;
  db?: Firestore;
  cacheNamespace?: string;
}): Promise<void> {
  const hasInjectedDb = Boolean(params.db);
  const ns = resolveStoreNamespace({
    db: params.db,
    cacheNamespace: params.cacheNamespace,
  });

  // Check if any existing disk snapshot in the SAME namespace for `projectId` belongs to a different owner
  ensureCacheDir();
  const suffix = `__${sanitizeFileSegment(params.projectId)}.json`;
  let diskOwnerForProject: string | null = null;
  if (!hasInjectedDb) {
    try {
      const files = fs.readdirSync(RAG_CACHE_DIR);
      for (const f of files) {
        if (!f.endsWith(suffix)) continue;
        if (ns && !f.startsWith(`${ns}__`)) continue;
        if (!ns && f.split('__').length > 2) continue;
        const snapRaw = fs.readFileSync(path.join(RAG_CACHE_DIR, f), 'utf8');
        const snapParsed = JSON.parse(snapRaw) as { ownerId?: string };
        if (
          snapParsed.ownerId &&
          snapParsed.ownerId !== 'local_author' &&
          snapParsed.ownerId !== params.ownerId
        ) {
          diskOwnerForProject = snapParsed.ownerId;
          break;
        }
      }
    } catch {
      // ignore fs read errors
    }
  }

  const adminDb = resolveRagFirestore({ db: params.db });
  const useMockBackend = !hasInjectedDb && Boolean(activeMockFirestoreBackend);
  const strictCheck =
    hasInjectedDb ||
    Boolean(params.requireStrictFirestoreDocCheck) ||
    isServerCloudAuthEnforced() ||
    Boolean(
      useMockBackend && activeMockFirestoreBackend?.strictCloudOwnershipRequired
    );

  const lookupFn: FirestoreProjectLookupFn | undefined = hasInjectedDb
    ? createFirestoreProjectLookupFromDb(params.db!)
    : useMockBackend
    ? activeMockFirestoreBackend!.createOwnershipLookupFn()
    : adminDb && (strictCheck || params.ownerId !== 'local_author')
    ? async ({ authenticatedUid, projectId }) => {
        try {
          const docSnap = await adminDb
            .doc(`users/${authenticatedUid}/projects/${projectId}`)
            .get();
          if (docSnap.exists) {
            const d = docSnap.data() || {};
            return {
              existsUnderUserPath: true,
              docOwnerId:
                typeof d.ownerId === 'string' ? d.ownerId : authenticatedUid,
              actualOwnerInDatabase:
                typeof d.ownerId === 'string' ? d.ownerId : authenticatedUid,
            };
          }
          return {
            existsUnderUserPath: false,
            actualOwnerInDatabase: diskOwnerForProject,
          };
        } catch (err) {
          if (strictCheck) {
            return {
              existsUnderUserPath: false,
              lookupFailed: true,
              lookupError: err instanceof Error ? err.message : String(err),
            };
          }
          return {
            existsUnderUserPath: false,
            actualOwnerInDatabase: diskOwnerForProject,
          };
        }
      }
    : diskOwnerForProject
    ? async () => ({
        existsUnderUserPath: false,
        actualOwnerInDatabase: diskOwnerForProject,
      })
    : undefined;

  const verification = await verifyAdminFirestoreProjectOwnership({
    authenticatedUid: params.ownerId,
    isAuthenticatedCloud: strictCheck,
    projectId: params.projectId,
    claimedOwnerId: params.claimedOwnerId,
    projectPayloadOwnerId: params.projectPayloadOwnerId,
    requireStrictFirestoreDocCheck: strictCheck,
    firestoreLookupFn: lookupFn,
    db: params.db,
    skipRegistryCache: hasInjectedDb,
  });

  if (!verification.ok) {
    throw new Error(
      verification.error ||
        `권한 거부(${verification.statusCode}): 프로젝트('${params.projectId}') 소유권 검증에 실패했습니다.`
    );
  }
}

/**
 * Phase 3.1.1 P1-5:
 * Recovers active index state from Cloud Firestore (`ragManifest/control`, `memoryDocuments`, `memoryChunks`)
 * when the server restarts or when the local disk cache is missing.
 * - Never restores `PENDING_DELETE` or `DELETED` projects/entities.
 * - Never restores stale index generations (`indexGeneration !== activeGeneration`).
 * - Strictly isolates `ownerId` and `projectId`.
 */
function normalizeFirestoreTimestampField(val: unknown, fallbackIso: string): string {
  if (typeof val === 'string' && val.length > 0) return val;
  if (
    val &&
    typeof val === 'object' &&
    'toDate' in val &&
    typeof (val as { toDate?: () => Date }).toDate === 'function'
  ) {
    try {
      return (val as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return fallbackIso;
    }
  }
  return fallbackIso;
}

function normalizeRecoveredChunkEmbedding(rawChunk: Record<string, unknown>): number[] {
  if (Array.isArray(rawChunk.embedding) && rawChunk.embedding.length > 0) {
    return rawChunk.embedding.map((n) => Number(n));
  }
  const vecVal = rawChunk.embeddingVector as
    | { toArray?: () => number[]; _values?: number[] }
    | undefined;
  if (vecVal && typeof vecVal.toArray === 'function') {
    return vecVal.toArray().map((n) => Number(n));
  }
  if (vecVal && Array.isArray(vecVal._values)) {
    return vecVal._values.map((n) => Number(n));
  }
  return [];
}

export async function recoverStoreFromFirestoreIfNeeded(
  ownerId: string,
  projectId: string,
  currentEntry: {
    store: FoundationMemorySearchStore;
    snapshot: DiskProjectRagSnapshot;
  },
  options?: RagExecutionOptions
): Promise<{
  store: FoundationMemorySearchStore;
  snapshot: DiskProjectRagSnapshot;
  recoveredFromFirestore: boolean;
}> {
  const hasInjectedDb = Boolean(options?.db);

  const filterRecoveredDocsAndChunks = (params: {
    manifest: Partial<FirestoreRagManifestDoc>;
    rawDocs: MemoryDocument[];
    rawChunks: MemoryChunk[];
  }): {
    activeEntityStates: EntityIndexLifecycleState[];
    recoveredDocs: MemoryDocument[];
    recoveredChunks: MemoryChunk[];
  } => {
    const activeEntityStates = Object.values(params.manifest.entityStates || {});
    const entityStateByKey = new Map<string, EntityIndexLifecycleState>();
    const blockedEntityKeys = new Set<string>();

    for (const st of activeEntityStates) {
      if (st.ownerId !== ownerId || st.projectId !== projectId) continue;
      entityStateByKey.set(st.entityKey, st);
      if (
        st.lifecycleStatus === 'PENDING_DELETE' ||
        st.lifecycleStatus === 'DELETED'
      ) {
        blockedEntityKeys.add(st.entityKey);
      }
    }

    const recoveredDocs: MemoryDocument[] = [];
    const recoveredDocIds = new Set<string>();
    const cleanupClaimedGenTags = new Set<string>();
    for (const claim of Object.values(params.manifest.cleanupClaims || {})) {
      if (
        claim &&
        (claim.status === 'CLEANUP_PENDING' ||
          claim.status === 'CLEANUP_COMPLETED')
      ) {
        cleanupClaimedGenTags.add(
          makeCleanupClaimKey(claim.entityKey, claim.generation)
        );
      }
    }

    for (const d of params.rawDocs) {
      if (d.ownerId !== ownerId || d.projectId !== projectId) continue;
      if (
        d.indexStatus === 'PENDING_DELETE' ||
        d.indexStatus === 'FAILED' ||
        d.lifecycleStatus === 'PENDING_DELETE' ||
        d.lifecycleStatus === 'DELETED'
      ) {
        continue;
      }

      const entityKey = `${d.ownerId}:${d.projectId}:${d.sourceEntityType}:${d.sourceEntityId}`;
      if (blockedEntityKeys.has(entityKey)) continue;
      if (
        typeof d.indexGeneration === 'number' &&
        d.indexGeneration > 0 &&
        (cleanupClaimedGenTags.has(
          makeCleanupClaimKey(entityKey, d.indexGeneration)
        ) ||
          isGenerationRetiredInManifest(
            params.manifest,
            entityKey,
            d.indexGeneration
          ))
      ) {
        continue;
      }

      const mState = entityStateByKey.get(entityKey);
      let normalizedDoc = d;

      if (mState) {
        if (
          mState.lifecycleStatus !== 'ACTIVE' &&
          mState.lifecycleStatus !== 'REINDEXING_KEEP_OLD'
        ) {
          continue;
        }
        if (
          typeof mState.activeGeneration === 'number' &&
          mState.activeGeneration > 0 &&
          typeof d.indexGeneration === 'number' &&
          d.indexGeneration !== mState.activeGeneration
        ) {
          continue;
        }
        if (
          Array.isArray(mState.activeDocumentIds) &&
          mState.activeDocumentIds.length > 0 &&
          !mState.activeDocumentIds.includes(d.id)
        ) {
          continue;
        }
        const isPointerMode =
          mState.activationMode === 'MANIFEST_POINTER' ||
          d.activationMode === 'MANIFEST_POINTER';
        if (!isPointerMode && d.isActiveGeneration === false) {
          continue;
        }
        if (isPointerMode) {
          normalizedDoc = {
            ...d,
            isActiveGeneration: true,
            indexStatus: 'INDEXED',
            lifecycleStatus: 'ACTIVE',
            activationMode: 'MANIFEST_POINTER',
          };
        }
      } else {
        if (
          d.isActiveGeneration === false ||
          d.activationMode === 'MANIFEST_POINTER'
        ) {
          continue;
        }
      }

      recoveredDocs.push(normalizedDoc);
      recoveredDocIds.add(normalizedDoc.id);
    }

    const recoveredChunks: MemoryChunk[] = [];
    for (const c of params.rawChunks) {
      if (c.ownerId !== ownerId || c.projectId !== projectId) continue;
      if (!recoveredDocIds.has(c.documentId)) continue;
      if (
        c.lifecycleStatus === 'PENDING_DELETE' ||
        c.lifecycleStatus === 'DELETED'
      ) {
        continue;
      }
      const entityKey = `${c.ownerId}:${c.projectId}:${c.sourceEntityType}:${c.sourceEntityId}`;
      if (blockedEntityKeys.has(entityKey)) continue;
      if (
        typeof c.indexGeneration === 'number' &&
        c.indexGeneration > 0 &&
        (cleanupClaimedGenTags.has(
          makeCleanupClaimKey(entityKey, c.indexGeneration)
        ) ||
          isGenerationRetiredInManifest(
            params.manifest,
            entityKey,
            c.indexGeneration
          ))
      ) {
        continue;
      }

      const mState = entityStateByKey.get(entityKey);
      let normalizedChunk = c;
      if (mState) {
        if (
          typeof mState.activeGeneration === 'number' &&
          mState.activeGeneration > 0 &&
          typeof c.indexGeneration === 'number' &&
          c.indexGeneration !== mState.activeGeneration
        ) {
          continue;
        }
        if (
          Array.isArray(mState.activeDocumentIds) &&
          mState.activeDocumentIds.length > 0 &&
          !mState.activeDocumentIds.includes(c.documentId)
        ) {
          continue;
        }
        const isPointerMode =
          mState.activationMode === 'MANIFEST_POINTER' ||
          c.activationMode === 'MANIFEST_POINTER';
        if (!isPointerMode && c.isActiveGeneration === false) {
          continue;
        }
        if (isPointerMode && c.isActiveGeneration === false) {
          normalizedChunk = {
            ...c,
            isActiveGeneration: true,
            lifecycleStatus: 'ACTIVE',
            activationMode: 'MANIFEST_POINTER',
          };
        }
      } else {
        if (
          c.isActiveGeneration === false ||
          c.activationMode === 'MANIFEST_POINTER'
        ) {
          continue;
        }
      }
      recoveredChunks.push(normalizedChunk);
    }

    return { activeEntityStates, recoveredDocs, recoveredChunks };
  };

  if (!hasInjectedDb && activeMockFirestoreBackend) {
    if (activeMockFirestoreBackend.simulateRecoveryFailure) {
      throw new Error(
        `FIRESTORE_RECOVERY_FAILED(503): Firestore 색인 복구 실패 — ${activeMockFirestoreBackend.simulateRecoveryFailure}`
      );
    }

    const manifest = activeMockFirestoreBackend.getManifest(ownerId, projectId);
    const hasLocalDocs = currentEntry.snapshot.documents.length > 0;

    if (!manifest) {
      return { ...currentEntry, recoveredFromFirestore: false };
    }

    if (
      manifest.projectLifecycleStatus === 'PENDING_DELETE' ||
      manifest.projectLifecycleStatus === 'DELETED'
    ) {
      await currentEntry.store.deleteProjectDocuments({ ownerId, projectId });
      currentEntry.snapshot.documents = [];
      currentEntry.snapshot.chunks = [];
      currentEntry.snapshot.generationCounter = Math.max(
        currentEntry.snapshot.generationCounter,
        manifest.projectTombstoneGeneration
      );
      return { ...currentEntry, recoveredFromFirestore: true };
    }

    const hasEntityDiff = Object.values(manifest.entityStates || {}).some(
      (mSt) => {
        const localSt = currentEntry.store.getEntityLifecycleState({
          ownerId: mSt.ownerId,
          projectId: mSt.projectId,
          sourceEntityType: mSt.sourceEntityType,
          sourceEntityId: mSt.sourceEntityId,
        });
        return !localSt || localSt.activeGeneration !== mSt.activeGeneration;
      }
    );

    const needsHydration =
      !hasLocalDocs ||
      manifest.activeGenerationCounter > currentEntry.snapshot.generationCounter ||
      hasEntityDiff;

    if (!needsHydration) {
      return { ...currentEntry, recoveredFromFirestore: false };
    }

    const basePath = `users/${ownerId}/projects/${projectId}`;
    const docPrefix = `${basePath}/memoryDocuments/`;
    const chunkPrefix = `${basePath}/memoryChunks/`;

    const rawDocs: MemoryDocument[] = [];
    for (const [docPath, rawDoc] of activeMockFirestoreBackend.documentsByPath.entries()) {
      if (!docPath.startsWith(docPrefix)) continue;
      rawDocs.push(rawDoc as unknown as MemoryDocument);
    }

    const rawChunks: MemoryChunk[] = [];
    for (const [chkPath, rawChk] of activeMockFirestoreBackend.documentsByPath.entries()) {
      if (!chkPath.startsWith(chunkPrefix)) continue;
      rawChunks.push(rawChk as unknown as MemoryChunk);
    }

    const { activeEntityStates, recoveredDocs, recoveredChunks } =
      filterRecoveredDocsAndChunks({ manifest, rawDocs, rawChunks });

    currentEntry.store.loadSnapshot(recoveredDocs, recoveredChunks, {
      entityStates: activeEntityStates,
      generationCounter: manifest.activeGenerationCounter,
    });
    currentEntry.snapshot = {
      ...currentEntry.snapshot,
      firestoreSynced: true,
      generationCounter: manifest.activeGenerationCounter,
      entityStates: activeEntityStates,
      documents: recoveredDocs,
      chunks: recoveredChunks,
      pendingDeletes: manifest.pendingDeletes
        ? Object.values(manifest.pendingDeletes)
        : currentEntry.snapshot.pendingDeletes,
    };
    persistStoreToDisk(currentEntry.store, currentEntry.snapshot, options);
    return { ...currentEntry, recoveredFromFirestore: true };
  }

  // Live Cloud Firestore recovery (using injected options.db or default adminDb) when local disk cache is empty
  const adminDb = resolveRagFirestore(options);
  if (
    !adminDb ||
    ownerId === 'local_author' ||
    currentEntry.snapshot.documents.length > 0
  ) {
    return { ...currentEntry, recoveredFromFirestore: false };
  }

  try {
    const nowIso = new Date().toISOString();
    const basePath = `users/${ownerId}/projects/${projectId}`;
    const manifestSnap = await adminDb.doc(`${basePath}/ragManifest/control`).get();
    if (!manifestSnap.exists) {
      return { ...currentEntry, recoveredFromFirestore: false };
    }
    const manifestData = manifestSnap.data() as FirestoreRagManifestDoc;
    if (
      manifestData.projectLifecycleStatus === 'PENDING_DELETE' ||
      manifestData.projectLifecycleStatus === 'DELETED'
    ) {
      await currentEntry.store.deleteProjectDocuments({ ownerId, projectId });
      return { ...currentEntry, recoveredFromFirestore: true };
    }

    const [docsSnap, chunksSnap] = await Promise.all([
      adminDb
        .collection(`${basePath}/memoryDocuments`)
        .where('ownerId', '==', ownerId)
        .where('projectId', '==', projectId)
        .get(),
      adminDb
        .collection(`${basePath}/memoryChunks`)
        .where('ownerId', '==', ownerId)
        .where('projectId', '==', projectId)
        .get(),
    ]);

    const rawDocs: MemoryDocument[] = docsSnap.docs.map((dSnap) => {
      const rawDoc = dSnap.data() as Record<string, unknown>;
      return {
        ...(rawDoc as unknown as MemoryDocument),
        id: String(rawDoc.id || dSnap.id),
        documentId: String(rawDoc.documentId || rawDoc.id || dSnap.id),
        createdAt: normalizeFirestoreTimestampField(rawDoc.createdAt, nowIso),
        updatedAt: normalizeFirestoreTimestampField(rawDoc.updatedAt, nowIso),
        indexedAt: normalizeFirestoreTimestampField(rawDoc.indexedAt, nowIso),
      };
    });

    const rawChunks: MemoryChunk[] = chunksSnap.docs.map((cSnap) => {
      const rawChk = cSnap.data() as Record<string, unknown>;
      const normalizedEmb = normalizeRecoveredChunkEmbedding(rawChk);
      const restChk = { ...rawChk };
      delete restChk.embeddingVector;
      return {
        ...(restChk as unknown as MemoryChunk),
        id: String(rawChk.id || cSnap.id),
        chunkId: String(rawChk.chunkId || rawChk.id || cSnap.id),
        embedding: normalizedEmb,
        createdAt: normalizeFirestoreTimestampField(rawChk.createdAt, nowIso),
      };
    });

    const { activeEntityStates, recoveredDocs, recoveredChunks } =
      filterRecoveredDocsAndChunks({
        manifest: manifestData,
        rawDocs,
        rawChunks,
      });

    currentEntry.store.loadSnapshot(recoveredDocs, recoveredChunks, {
      entityStates: activeEntityStates,
      generationCounter: Number(manifestData.activeGenerationCounter || 0),
    });
    currentEntry.snapshot = {
      ...currentEntry.snapshot,
      firestoreSynced: true,
      generationCounter: Number(manifestData.activeGenerationCounter || 0),
      entityStates: activeEntityStates,
      documents: recoveredDocs,
      chunks: recoveredChunks,
    };
    persistStoreToDisk(currentEntry.store, currentEntry.snapshot, options);
    return { ...currentEntry, recoveredFromFirestore: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!hasInjectedDb && !isServerCloudAuthEnforced()) {
      return { ...currentEntry, recoveredFromFirestore: false };
    }
    throw new Error(`FIRESTORE_RECOVERY_FAILED(503): ${msg}`);
  }
}

export interface AtomicRagActivationGuardContext {
  leasedTask?: RagSyncTaskRecord;
  activationToken?: string;
  verifyInActivationTransaction?: (ctx: {
    tx: {
      get: (ref: any) => Promise<any>;
      set: (
        ref: any,
        data: Record<string, unknown>,
        options?: { merge?: boolean }
      ) => void;
    };
    db: Firestore;
    basePath: string;
    manifestData: Record<string, unknown>;
    currentEntityManifestState?: EntityIndexLifecycleState;
    nextEntityState: EntityIndexLifecycleState;
  }) => Promise<void>;
}

function normalizeIsoTimestampForActivationTx(
  raw: unknown,
  fallbackIso = ''
): string {
  if (!raw) return fallbackIso;
  if (typeof raw === 'string') return raw;
  if (raw instanceof Date) return raw.toISOString();
  if (typeof (raw as { toDate?: () => Date }).toDate === 'function') {
    try {
      return (raw as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return fallbackIso;
    }
  }
  const obj = raw as {
    _seconds?: number;
    _nanoseconds?: number;
    seconds?: number;
    nanoseconds?: number;
  };
  const secs =
    typeof obj._seconds === 'number'
      ? obj._seconds
      : typeof obj.seconds === 'number'
      ? obj.seconds
      : undefined;
  if (typeof secs === 'number' && Number.isFinite(secs)) {
    const nanos =
      typeof obj._nanoseconds === 'number'
        ? obj._nanoseconds
        : typeof obj.nanoseconds === 'number'
        ? obj.nanoseconds
        : 0;
    return new Date(secs * 1000 + Math.floor(nanos / 1e6)).toISOString();
  }
  return fallbackIso;
}

function normalizeRagSyncTaskForActivationTx(
  raw: Record<string, unknown>,
  fallbackId: string
): RagSyncTaskRecord {
  const createdAt = normalizeIsoTimestampForActivationTx(raw.createdAt);
  const updatedAt = normalizeIsoTimestampForActivationTx(
    raw.updatedAt,
    createdAt
  );
  const rawStatus = raw.status as RagSyncTaskStatus;
  const status: RagSyncTaskStatus =
    rawStatus === 'PENDING' ||
    rawStatus === 'PROCESSING' ||
    rawStatus === 'SYNCED' ||
    rawStatus === 'FAILED' ||
    rawStatus === 'SUPERSEDED'
      ? rawStatus
      : 'PENDING';
  const sourceRevisionId =
    typeof raw.sourceRevisionId === 'string' ? raw.sourceRevisionId : '';

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    ownerId: typeof raw.ownerId === 'string' ? raw.ownerId : '',
    projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
    proposalId: typeof raw.proposalId === 'string' ? raw.proposalId : '',
    auditId: typeof raw.auditId === 'string' ? raw.auditId : '',
    targetEntityType:
      (raw.targetEntityType as ApprovalTargetEntityType) || 'RELATIONSHIP',
    targetEntityId:
      typeof raw.targetEntityId === 'string' ? raw.targetEntityId : '',
    sourceRevisionId,
    expectedSourceRevisionId:
      typeof raw.expectedSourceRevisionId === 'string' &&
      raw.expectedSourceRevisionId
        ? raw.expectedSourceRevisionId
        : sourceRevisionId,
    expectedEntityUpdatedAt:
      typeof raw.expectedEntityUpdatedAt === 'string'
        ? raw.expectedEntityUpdatedAt
        : '',
    expectedContentHash:
      typeof raw.expectedContentHash === 'string'
        ? raw.expectedContentHash
        : '',
    status,
    attemptCount:
      typeof raw.attemptCount === 'number' && Number.isFinite(raw.attemptCount)
        ? Math.max(0, Math.floor(raw.attemptCount))
        : 0,
    maxAttempts:
      typeof raw.maxAttempts === 'number' && Number.isFinite(raw.maxAttempts)
        ? Math.max(1, Math.floor(raw.maxAttempts))
        : 5,
    manualRetryCount:
      typeof raw.manualRetryCount === 'number' &&
      Number.isFinite(raw.manualRetryCount)
        ? Math.max(0, Math.floor(raw.manualRetryCount))
        : 0,
    leaseOwner: typeof raw.leaseOwner === 'string' ? raw.leaseOwner : '',
    leaseGeneration:
      typeof raw.leaseGeneration === 'number' &&
      Number.isFinite(raw.leaseGeneration)
        ? Math.max(0, Math.floor(raw.leaseGeneration))
        : 0,
    leaseExpiresAtMs:
      typeof raw.leaseExpiresAtMs === 'number' &&
      Number.isFinite(raw.leaseExpiresAtMs)
        ? raw.leaseExpiresAtMs
        : 0,
    nextRetryAfterMs:
      typeof raw.nextRetryAfterMs === 'number' &&
      Number.isFinite(raw.nextRetryAfterMs)
        ? raw.nextRetryAfterMs
        : 0,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : '',
    memoryDocumentId:
      typeof raw.memoryDocumentId === 'string' ? raw.memoryDocumentId : '',
    createdAt,
    updatedAt,
  };
}

function normalizeCanonEntityForActivationTx(
  targetEntityType: ApprovalTargetEntityType,
  raw: Record<string, unknown>,
  fallbackId: string
): AppliedCanonEntity {
  const createdAt = normalizeIsoTimestampForActivationTx(raw.createdAt);
  const updatedAt = normalizeIsoTimestampForActivationTx(
    raw.updatedAt,
    createdAt
  );
  const toStrArr = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === 'string')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const canonStatus: CanonStatus =
    raw.canonStatus === 'CANON' ||
    raw.canonStatus === 'PROPOSED' ||
    raw.canonStatus === 'REJECTED' ||
    raw.canonStatus === 'ARCHIVED' ||
    raw.canonStatus === 'DRAFT'
      ? raw.canonStatus
      : 'DRAFT';
  const createdBy =
    raw.createdBy === 'AUTHOR' || raw.createdBy === 'SYSTEM'
      ? raw.createdBy
      : 'AI_ENGINE';

  if (targetEntityType === 'RELATIONSHIP') {
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
      ownerId: typeof raw.ownerId === 'string' ? raw.ownerId : '',
      projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
      sourceCharacterId:
        typeof raw.sourceCharacterId === 'string' ? raw.sourceCharacterId : '',
      targetCharacterId:
        typeof raw.targetCharacterId === 'string' ? raw.targetCharacterId : '',
      relationType:
        typeof raw.relationType === 'string' ? raw.relationType : '',
      affinityScore:
        typeof raw.affinityScore === 'number' &&
        Number.isFinite(raw.affinityScore)
          ? Math.round(raw.affinityScore)
          : 0,
      isDirectional:
        typeof raw.isDirectional === 'boolean' ? raw.isDirectional : true,
      description: typeof raw.description === 'string' ? raw.description : '',
      canonStatus,
      effectiveEpisodeId:
        typeof raw.effectiveEpisodeId === 'string'
          ? raw.effectiveEpisodeId
          : '',
      effectiveEventId:
        typeof raw.effectiveEventId === 'string' ? raw.effectiveEventId : '',
      sourceRevisionId:
        typeof raw.sourceRevisionId === 'string' ? raw.sourceRevisionId : '',
      createdBy,
      createdAt,
      updatedAt,
    };
  }

  if (targetEntityType === 'TIMELINE_EVENT') {
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
      ownerId: typeof raw.ownerId === 'string' ? raw.ownerId : '',
      projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
      title: typeof raw.title === 'string' ? raw.title : '',
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      inUniverseDate:
        typeof raw.inUniverseDate === 'string' ? raw.inUniverseDate : '',
      chronologicalOrder:
        typeof raw.chronologicalOrder === 'number' &&
        Number.isFinite(raw.chronologicalOrder)
          ? Math.floor(raw.chronologicalOrder)
          : 1,
      episodeId: typeof raw.episodeId === 'string' ? raw.episodeId : '',
      sceneId: typeof raw.sceneId === 'string' ? raw.sceneId : '',
      participantCharacterIds: toStrArr(raw.participantCharacterIds),
      linkedForeshadowingIds: toStrArr(raw.linkedForeshadowingIds),
      linkedWorldbuildingIds: toStrArr(raw.linkedWorldbuildingIds),
      canonStatus,
      sourceRevisionId:
        typeof raw.sourceRevisionId === 'string' ? raw.sourceRevisionId : '',
      createdBy,
      createdAt,
      updatedAt,
    };
  }

  const rawPhase = raw.cluePhase;
  const cluePhase: Foreshadowing['cluePhase'] =
    rawPhase === 'PLANTED' ||
    rawPhase === 'REINFORCED' ||
    rawPhase === 'RESOLVED' ||
    rawPhase === 'ABANDONED'
      ? rawPhase
      : 'PLANTED';

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    ownerId: typeof raw.ownerId === 'string' ? raw.ownerId : '',
    projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    cluePhase,
    canonStatus,
    plantedEpisodeId:
      typeof raw.plantedEpisodeId === 'string' ? raw.plantedEpisodeId : '',
    plantedSceneId:
      typeof raw.plantedSceneId === 'string' ? raw.plantedSceneId : '',
    resolvedEpisodeId:
      typeof raw.resolvedEpisodeId === 'string' ? raw.resolvedEpisodeId : '',
    resolvedSceneId:
      typeof raw.resolvedSceneId === 'string' ? raw.resolvedSceneId : '',
    relatedEventIds: toStrArr(raw.relatedEventIds),
    relatedCharacterIds: toStrArr(raw.relatedCharacterIds),
    sourceRevisionId:
      typeof raw.sourceRevisionId === 'string' ? raw.sourceRevisionId : '',
    createdBy,
    createdAt,
    updatedAt,
  };
}

export function buildRagStagingReceiptId(params: {
  projectId: string;
  sourceEntityType: MemorySourceEntityType;
  sourceEntityId: string;
  generation: number;
}): string {
  const genNum = Math.max(1, Math.floor(params.generation));
  const raw = `staging_${params.projectId}_${params.sourceEntityType}_${params.sourceEntityId}_g${genNum}`.replace(
    /[^a-zA-Z0-9_-]/g,
    '_'
  );
  if (raw.length <= 120) {
    return raw;
  }
  const hash = computeMemoryContentHash(raw).slice(2, 14);
  return `${raw.slice(0, 96)}_${hash}_g${genNum}`;
}

export async function reserveRagGenerationOnServer(
  params: {
    ownerId: string;
    projectId: string;
    sourceEntityType: MemorySourceEntityType;
    sourceEntityId: string;
    expectedContentHash?: string;
    expectedSourceRevisionId?: string;
    expectedDocumentCount?: number;
    expectedChunkCount?: number;
    targetTaskId?: string;
    targetLeaseGeneration?: number;
    activationToken?: string;
    largeScaleGenerationMode?: boolean;
    minimumFloor?: number;
  },
  options?: RagExecutionOptions
): Promise<{
  generation: number;
  stagingId: string;
  entityKey: string;
  reservedInCloud: boolean;
}> {
  const entityKey = `${params.ownerId}:${params.projectId}:${params.sourceEntityType}:${params.sourceEntityId}`;
  const isLargeScale = Boolean(params.largeScaleGenerationMode);
  const activationMode: RagActivationMode = isLargeScale
    ? 'MANIFEST_POINTER'
    : 'INLINE_DOC';
  const hasInjectedDb = Boolean(options?.db);

  if (!hasInjectedDb && activeMockFirestoreBackend) {
    const reservedGen = activeMockFirestoreBackend.reserveGenerationForEntity({
      ownerId: params.ownerId,
      projectId: params.projectId,
      sourceEntityType: params.sourceEntityType,
      sourceEntityId: params.sourceEntityId,
      minimumFloor: params.minimumFloor,
      activationMode,
      expectedDocumentCount: params.expectedDocumentCount,
      expectedChunkCount: params.expectedChunkCount,
      expectedContentHash: params.expectedContentHash,
      expectedSourceRevisionId: params.expectedSourceRevisionId,
      targetTaskId: params.targetTaskId,
      targetLeaseGeneration: params.targetLeaseGeneration,
      activationToken: params.activationToken,
    });
    const stagingId = buildRagStagingReceiptId({
      projectId: params.projectId,
      sourceEntityType: params.sourceEntityType,
      sourceEntityId: params.sourceEntityId,
      generation: reservedGen,
    });
    if (isLargeScale) {
      const nowIso = new Date().toISOString();
      const stagingPath = `users/${params.ownerId}/projects/${params.projectId}/ragGenerationStaging/${stagingId}`;
      const receipt: RagGenerationStagingReceipt = sanitizeFirestoreWriteData({
        id: stagingId,
        ownerId: params.ownerId,
        projectId: params.projectId,
        entityKey,
        sourceEntityType: params.sourceEntityType,
        sourceEntityId: params.sourceEntityId,
        generation: reservedGen,
        activationMode: 'MANIFEST_POINTER',
        status: 'PREPARING',
        expectedDocumentIds: [],
        expectedDocumentCount: params.expectedDocumentCount ?? 0,
        expectedChunkCount: params.expectedChunkCount ?? 0,
        expectedContentHash: params.expectedContentHash ?? '',
        expectedSourceRevisionId: params.expectedSourceRevisionId ?? '',
        stagedDocumentCount: 0,
        stagedChunkCount: 0,
        verifiedDocumentCount: 0,
        verifiedChunkCount: 0,
        batchesCommitted: 0,
        ...(params.targetTaskId ? { targetTaskId: params.targetTaskId } : {}),
        ...(typeof params.targetLeaseGeneration === 'number'
          ? { targetLeaseGeneration: params.targetLeaseGeneration }
          : {}),
        ...(params.activationToken
          ? { activationToken: params.activationToken }
          : {}),
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      activeMockFirestoreBackend.stagingReceiptsByPath.set(stagingPath, receipt);
      activeMockFirestoreBackend.documentsByPath.set(
        stagingPath,
        receipt as unknown as Record<string, unknown>
      );
    }
    return {
      generation: reservedGen,
      stagingId,
      entityKey,
      reservedInCloud: true,
    };
  }

  const adminDb = resolveRagFirestore({ db: options?.db });
  if (!adminDb || params.ownerId === 'local_author') {
    const gen = Math.max(1, (params.minimumFloor || 0) + 1);
    const stagingId = buildRagStagingReceiptId({
      projectId: params.projectId,
      sourceEntityType: params.sourceEntityType,
      sourceEntityId: params.sourceEntityId,
      generation: gen,
    });
    return {
      generation: gen,
      stagingId,
      entityKey,
      reservedInCloud: false,
    };
  }

  const basePath = `users/${params.ownerId}/projects/${params.projectId}`;
  const manifestRef = adminDb.doc(`${basePath}/ragManifest/control`);
  const projectRef = adminDb.doc(basePath);

  const reservedResult = await adminDb.runTransaction(async (tx) => {
    const mSnap = await tx.get(manifestRef);
    const pSnap = await tx.get(projectRef);

    if (pSnap.exists) {
      const pData = pSnap.data() || {};
      if (pData.ownerId && pData.ownerId !== params.ownerId) {
        throw new Error(
          `권한 거부(403 - FIRESTORE_PROJECT_OWNER_MISMATCH): 프로젝트 소유자가 일치하지 않습니다.`
        );
      }
      if (
        pData.lifecycleStatus === 'PENDING_DELETE' ||
        pData.lifecycleStatus === 'DELETED'
      ) {
        throw new Error(
          `[ENTITY_OR_PROJECT_DELETED] 삭제된 프로젝트('${params.projectId}')에는 세대를 예약할 수 없습니다.`
        );
      }
    }

    const mData = mSnap.exists ? mSnap.data() || {} : {};
    if (
      mData.projectLifecycleStatus === 'PENDING_DELETE' ||
      mData.projectLifecycleStatus === 'DELETED'
    ) {
      throw new Error(
        `[ENTITY_OR_PROJECT_DELETED] 삭제 진행 중인 프로젝트('${params.projectId}')에는 세대를 예약할 수 없습니다.`
      );
    }

    const entityStates =
      (mData.entityStates as Record<string, EntityIndexLifecycleState>) || {};
    const currentEntity = entityStates[entityKey];
    const existingCleanupClaims =
      (mData.cleanupClaims as Record<string, RagManifestCleanupClaim>) || {};
    let maxClaimedGen = 0;
    for (const claim of Object.values(existingCleanupClaims)) {
      if (claim && typeof claim.generation === 'number') {
        maxClaimedGen = Math.max(maxClaimedGen, claim.generation);
      }
    }
    const maxRetiredGen = getMaxRetiredGenerationInManifest(
      mData as Partial<FirestoreRagManifestDoc>
    );
    const nextGen =
      Math.max(
        Number(mData.activeGenerationCounter || 0),
        Number(mData.projectTombstoneGeneration || 0),
        Number(currentEntity?.activeGeneration || 0),
        Number(currentEntity?.deletionTombstoneGeneration || 0),
        maxClaimedGen,
        maxRetiredGen,
        Number(params.minimumFloor || 0)
      ) + 1;

    const stagingId = buildRagStagingReceiptId({
      projectId: params.projectId,
      sourceEntityType: params.sourceEntityType,
      sourceEntityId: params.sourceEntityId,
      generation: nextGen,
    });

    tx.set(
      manifestRef,
      sanitizeFirestoreWriteData({
        ownerId: params.ownerId,
        projectId: params.projectId,
        activeGenerationCounter: nextGen,
        updatedAt: FieldValue.serverTimestamp(),
      }),
      { merge: true }
    );

    if (isLargeScale) {
      const stagingRef = adminDb.doc(
        `${basePath}/ragGenerationStaging/${stagingId}`
      );
      const nowIso = new Date().toISOString();
      const receipt: RagGenerationStagingReceipt = sanitizeFirestoreWriteData({
        id: stagingId,
        ownerId: params.ownerId,
        projectId: params.projectId,
        entityKey,
        sourceEntityType: params.sourceEntityType,
        sourceEntityId: params.sourceEntityId,
        generation: nextGen,
        activationMode: 'MANIFEST_POINTER',
        status: 'PREPARING',
        expectedDocumentIds: [],
        expectedDocumentCount: params.expectedDocumentCount ?? 0,
        expectedChunkCount: params.expectedChunkCount ?? 0,
        expectedContentHash: params.expectedContentHash ?? '',
        expectedSourceRevisionId: params.expectedSourceRevisionId ?? '',
        stagedDocumentCount: 0,
        stagedChunkCount: 0,
        verifiedDocumentCount: 0,
        verifiedChunkCount: 0,
        batchesCommitted: 0,
        ...(params.targetTaskId ? { targetTaskId: params.targetTaskId } : {}),
        ...(typeof params.targetLeaseGeneration === 'number'
          ? { targetLeaseGeneration: params.targetLeaseGeneration }
          : {}),
        ...(params.activationToken
          ? { activationToken: params.activationToken }
          : {}),
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      tx.set(stagingRef, sanitizeFirestoreWriteData(receipt));
    }

    return {
      generation: nextGen,
      stagingId,
      entityKey,
      reservedInCloud: true,
    };
  });

  return reservedResult;
}

export async function cleanupInactiveRagGenerationsOnServer(
  params: {
    ownerId: string;
    projectId: string;
    sourceEntityType?: MemorySourceEntityType;
    sourceEntityId?: string;
    targetGeneration?: number;
    targetStagingId?: string;
    failOnActiveConflict?: boolean;
    retainCompletedReceipts?: boolean;
    maxBatches?: number;
    staleStagingThresholdMs?: number;
    cleanupLeaseDurationMs?: number;
    resumeCleanupOperationId?: string;
    failOnOwnershipConflict?: boolean;
    simulateUncleanCrashLeaveLeaseActive?: boolean;
    nowMs?: number;
    cleanupOwner?: string;
    executionMode?: 'CLOUD_AUTHENTICATED' | 'TEST_ISOLATED';
    testMode?: boolean;
    simulateDeleteFailureAtBatchNumber?: number;
    onAfterCandidateScanBeforeClaimTx?: (ctx: {
      claimKeys: string[];
      candidateGenerations: number[];
    }) => Promise<void> | void;
    onBetweenClaimAndDeleteHook?: (ctx: {
      cleanupOperationId: string;
      cleanupEpoch: number;
      claimKeys: string[];
      targetDocumentIds: string[];
    }) => Promise<void> | void;
    onAfterDeleteBatchHook?: (ctx: {
      batchesCommitted: number;
      deletedDocs: number;
      deletedChunks: number;
      claimKeys: string[];
    }) => Promise<void> | void;
  },
  options?: RagExecutionOptions
): Promise<{
  deletedDocs: number;
  deletedChunks: number;
  deletedStagingReceipts: number;
  batchesCommitted: number;
  skippedActiveCount: number;
  skippedInFlightStagingCount: number;
  skippedOwnershipConflictCount?: number;
  conflictedClaimKeys?: string[];
  cleanupOperationId?: string;
  cleanupEpoch?: number;
  claimedKeys?: string[];
  completedClaimKeys?: string[];
  pendingResumeClaimKeys?: string[];
}> {
  if (!params.ownerId?.trim() || !params.projectId?.trim()) {
    throw new Error('[BAD_REQUEST] ownerId와 projectId가 필요합니다.');
  }

  await assertServerRagProjectOwnership({
    ownerId: params.ownerId,
    projectId: params.projectId,
    claimedOwnerId: params.ownerId,
    db: options?.db,
    cacheNamespace: options?.cacheNamespace,
  });

  const hasInjectedDb = Boolean(options?.db);
  const injectedMeta = hasInjectedDb
    ? getIsolatedFirestoreBindingMetadata(options?.db)
    : undefined;
  const isCloudEnforced =
    params.executionMode === 'CLOUD_AUTHENTICATED' ||
    isServerCloudAuthEnforced();
  const isTestIsolatedMode =
    !isCloudEnforced &&
    (Boolean(params.testMode) ||
      params.executionMode === 'TEST_ISOLATED' ||
      (!hasInjectedDb && Boolean(activeMockFirestoreBackend)) ||
      Boolean(hasInjectedDb && injectedMeta?.isIsolatedTestDb));

  // Authoritative server clock in CLOUD_AUTHENTICATED / production mode (never trust client nowMs!)
  const nowMs = isTestIsolatedMode
    ? typeof params.nowMs === 'number' && Number.isFinite(params.nowMs)
      ? params.nowMs
      : Date.now()
    : Date.now();
  const MIN_PRODUCTION_STALE_STAGING_THRESHOLD_MS = 5 * 60_000;
  const requestedStaleThreshold =
    typeof params.staleStagingThresholdMs === 'number' &&
    Number.isFinite(params.staleStagingThresholdMs) &&
    params.staleStagingThresholdMs >= 0
      ? params.staleStagingThresholdMs
      : 15 * 60_000;
  const staleThresholdMs = isTestIsolatedMode
    ? requestedStaleThreshold
    : Math.max(
        MIN_PRODUCTION_STALE_STAGING_THRESHOLD_MS,
        requestedStaleThreshold
      );

  const requestedLeaseMs =
    typeof params.cleanupLeaseDurationMs === 'number' &&
    Number.isFinite(params.cleanupLeaseDurationMs) &&
    params.cleanupLeaseDurationMs > 0
      ? params.cleanupLeaseDurationMs
      : DEFAULT_CLEANUP_LEASE_MS;
  const cleanupLeaseDurationMs = isTestIsolatedMode
    ? requestedLeaseMs
    : Math.max(MIN_PRODUCTION_CLEANUP_LEASE_MS, requestedLeaseMs);

  const maxBatches =
    typeof params.maxBatches === 'number' && params.maxBatches > 0
      ? Math.floor(params.maxBatches)
      : Number.POSITIVE_INFINITY;
  const cleanupOwner =
    params.cleanupOwner?.trim() || `cleaner_${params.ownerId}`;

  const basePath = `users/${params.ownerId}/projects/${params.projectId}`;
  const docPrefix = `${basePath}/memoryDocuments/`;
  const chunkPrefix = `${basePath}/memoryChunks/`;
  const stagingPrefix = `${basePath}/ragGenerationStaging/`;

  const matchesFilter = (item: {
    sourceEntityType?: unknown;
    sourceEntityId?: unknown;
    indexGeneration?: unknown;
    generation?: unknown;
    id?: unknown;
    stagingId?: unknown;
  }): boolean => {
    if (
      params.sourceEntityType &&
      item.sourceEntityType !== params.sourceEntityType
    ) {
      return false;
    }
    if (params.sourceEntityId && item.sourceEntityId !== params.sourceEntityId) {
      return false;
    }
    if (typeof params.targetGeneration === 'number') {
      const genVal =
        typeof item.generation === 'number'
          ? item.generation
          : typeof item.indexGeneration === 'number'
          ? item.indexGeneration
          : undefined;
      if (genVal !== params.targetGeneration) {
        return false;
      }
    }
    if (params.targetStagingId) {
      const sid =
        typeof item.stagingId === 'string' && item.stagingId
          ? item.stagingId
          : typeof item.id === 'string'
          ? item.id
          : '';
      if (sid && sid !== params.targetStagingId) {
        // For docs/chunks without stagingId field, allow generation match checked later
        if (typeof item.stagingId === 'string') return false;
      }
    }
    return true;
  };

  interface CleanupClaimGroupCandidate {
    claimKey: string;
    entityKey: string;
    sourceEntityType: MemorySourceEntityType;
    sourceEntityId: string;
    generation: number;
    stagingId?: string;
    stagingPath?: string;
    stagingReceipt?: RagGenerationStagingReceipt;
    targetDocumentIds: string[];
    docPaths: string[];
    chunkPaths: string[];
    reason: string;
  }

  const normalizeTaskLeaseInfo = (
    tasks: Array<{ id: string; data: Record<string, unknown> }>
  ) => {
    const liveTaskLeaseGenByEntityKey = new Map<string, number>();
    const taskIdsByEntityKey = new Map<string, string[]>();
    for (const t of tasks) {
      const td = t.data;
      const tOwner = typeof td.ownerId === 'string' ? td.ownerId : params.ownerId;
      const tProj =
        typeof td.projectId === 'string' ? td.projectId : params.projectId;
      const eType = String(td.targetEntityType || '');
      const eId = String(td.targetEntityId || '');
      if (!eType || !eId || tOwner !== params.ownerId || tProj !== params.projectId) {
        continue;
      }
      const entityKey = `${params.ownerId}:${params.projectId}:${eType}:${eId}`;
      const existingList = taskIdsByEntityKey.get(entityKey) || [];
      existingList.push(t.id);
      taskIdsByEntityKey.set(entityKey, existingList);

      const status = td.status;
      const leaseExpiresAtMs =
        typeof td.leaseExpiresAtMs === 'number' &&
        Number.isFinite(td.leaseExpiresAtMs)
          ? td.leaseExpiresAtMs
          : 0;
      const leaseGen =
        typeof td.leaseGeneration === 'number' &&
        Number.isFinite(td.leaseGeneration)
          ? td.leaseGeneration
          : 0;
      const updatedMs = new Date(
        normalizeIsoTimestampForActivationTx(td.updatedAt || td.createdAt) || 0
      ).getTime();
      const hasLiveLease =
        status === 'PROCESSING' &&
        (leaseExpiresAtMs > 0
          ? leaseExpiresAtMs > nowMs
          : Number.isFinite(updatedMs) && nowMs - updatedMs < staleThresholdMs);
      if (hasLiveLease) {
        liveTaskLeaseGenByEntityKey.set(
          entityKey,
          Math.max(liveTaskLeaseGenByEntityKey.get(entityKey) || 0, leaseGen)
        );
      }
    }
    return { liveTaskLeaseGenByEntityKey, taskIdsByEntityKey };
  };

  const evaluateCleanupTargets = (inputData: {
    manifest?: Partial<FirestoreRagManifestDoc>;
    docs: Array<{ path: string; id: string; data: Record<string, unknown> }>;
    chunks: Array<{ path: string; id: string; data: Record<string, unknown> }>;
    receipts: Array<{
      path: string;
      id: string;
      data: RagGenerationStagingReceipt;
    }>;
    tasks: Array<{ id: string; data: Record<string, unknown> }>;
  }) => {
    const entityStates = inputData.manifest?.entityStates || {};
    const existingClaims = inputData.manifest?.cleanupClaims || {};
    const activeDocIds = new Set<string>();
    const activeGenByEntityKey = new Map<string, number>();

    for (const st of Object.values(entityStates)) {
      if (st.ownerId !== params.ownerId || st.projectId !== params.projectId) {
        continue;
      }
      if (st.lifecycleStatus === 'ACTIVE' && st.activeGeneration > 0) {
        activeGenByEntityKey.set(st.entityKey, st.activeGeneration);
        for (const docId of st.activeDocumentIds || []) {
          activeDocIds.add(docId);
        }
      }
    }

    const { liveTaskLeaseGenByEntityKey, taskIdsByEntityKey } =
      normalizeTaskLeaseInfo(inputData.tasks);

    const receiptById = new Map<string, RagGenerationStagingReceipt>();
    const receiptEntryById = new Map<
      string,
      { path: string; id: string; data: RagGenerationStagingReceipt }
    >();
    const groupsByClaimKey = new Map<string, CleanupClaimGroupCandidate>();

    const ensureGroup = (g: {
      claimKey: string;
      entityKey: string;
      sourceEntityType: MemorySourceEntityType;
      sourceEntityId: string;
      generation: number;
      stagingId?: string;
      stagingPath?: string;
      stagingReceipt?: RagGenerationStagingReceipt;
      reason: string;
    }): CleanupClaimGroupCandidate => {
      const existing = groupsByClaimKey.get(g.claimKey);
      if (existing) {
        if (g.stagingId && !existing.stagingId) {
          existing.stagingId = g.stagingId;
          existing.stagingPath = g.stagingPath;
          existing.stagingReceipt = g.stagingReceipt;
        }
        return existing;
      }
      const created: CleanupClaimGroupCandidate = {
        ...g,
        targetDocumentIds: [],
        docPaths: [],
        chunkPaths: [],
      };
      groupsByClaimKey.set(g.claimKey, created);
      return created;
    };

    let skippedInFlightStagingCount = 0;
    let skippedActiveCount = 0;
    let explicitActiveConflictMsg: string | null = null;

    for (const recEntry of inputData.receipts) {
      const r = recEntry.data;
      if (r.ownerId !== params.ownerId || r.projectId !== params.projectId) {
        continue;
      }
      const sid = r.id || recEntry.id;
      receiptById.set(sid, r);
      receiptEntryById.set(sid, recEntry);
    }

    for (const recEntry of inputData.receipts) {
      const r = recEntry.data;
      if (r.ownerId !== params.ownerId || r.projectId !== params.projectId) {
        continue;
      }
      if (!matchesFilter(r)) continue;
      const sid = r.id || recEntry.id;
      if (params.targetStagingId && sid !== params.targetStagingId) {
        continue;
      }
      if (r.status === 'CLEANUP_COMPLETED') {
        continue;
      }

      const entityKey =
        r.entityKey ||
        `${params.ownerId}:${params.projectId}:${r.sourceEntityType}:${r.sourceEntityId}`;
      const activeGen = activeGenByEntityKey.get(entityKey) || 0;
      const isTargeted =
        params.targetGeneration === r.generation ||
        params.targetStagingId === sid;

      if (activeGen > 0 && r.generation === activeGen) {
        skippedActiveCount += 1;
        if (isTargeted || params.failOnActiveConflict) {
          explicitActiveConflictMsg = `[CLEANUP_BLOCKED_ACTIVE_GENERATION] 현재 활성 세대(gen=${activeGen}, entity=${entityKey}, stagingId=${sid})는 정리할 수 없습니다.`;
        }
        continue;
      }

      const liveLeaseGen = liveTaskLeaseGenByEntityKey.get(entityKey) || 0;
      const isSupersededByNewerLease =
        liveLeaseGen > 0 &&
        typeof r.targetLeaseGeneration === 'number' &&
        r.targetLeaseGeneration < liveLeaseGen;
      const isProtectedByLiveLease =
        liveLeaseGen > 0 &&
        !isSupersededByNewerLease &&
        r.status !== 'ABORTED' &&
        r.status !== 'CLEANUP_PENDING' &&
        !(activeGen > 0 && r.generation < activeGen);

      if (isProtectedByLiveLease) {
        skippedInFlightStagingCount += 1;
        continue;
      }

      const updatedMs = new Date(r.updatedAt || r.createdAt || 0).getTime();
      const ageMs = Number.isFinite(updatedMs)
        ? Math.max(0, nowMs - updatedMs)
        : staleThresholdMs;

      const isOlderThanActive = activeGen > 0 && r.generation < activeGen;
      const isExplicitlyAbortedOrCleanup =
        r.status === 'ABORTED' || r.status === 'CLEANUP_PENDING';
      const isStaleAbandoned =
        (r.status === 'PREPARING' ||
          r.status === 'STAGED' ||
          r.status === 'VERIFIED') &&
        ageMs >= staleThresholdMs;
      const existingClaim =
        existingClaims[makeCleanupClaimKey(entityKey, r.generation)];
      const isClaimedPending = existingClaim?.status === 'CLEANUP_PENDING';

      if (
        isOlderThanActive ||
        isExplicitlyAbortedOrCleanup ||
        isSupersededByNewerLease ||
        isStaleAbandoned ||
        isClaimedPending
      ) {
        const claimKey = makeCleanupClaimKey(entityKey, r.generation);
        const grp = ensureGroup({
          claimKey,
          entityKey,
          sourceEntityType: r.sourceEntityType,
          sourceEntityId: r.sourceEntityId,
          generation: r.generation,
          stagingId: sid,
          stagingPath: recEntry.path,
          stagingReceipt: r,
          reason: isExplicitlyAbortedOrCleanup
            ? r.status
            : isSupersededByNewerLease
            ? 'SUPERSEDED_LEASE'
            : isOlderThanActive
            ? 'OLDER_THAN_ACTIVE'
            : 'STALE_ABANDONED',
        });
        for (const eid of r.expectedDocumentIds || []) {
          if (eid && !activeDocIds.has(eid) && !grp.targetDocumentIds.includes(eid)) {
            grp.targetDocumentIds.push(eid);
          }
        }
      } else {
        skippedInFlightStagingCount += 1;
      }
    }

    for (const dEntry of inputData.docs) {
      const d = dEntry.data;
      if (d.ownerId !== params.ownerId || d.projectId !== params.projectId) {
        continue;
      }
      if (!matchesFilter(d)) continue;

      const docId = String(d.id || dEntry.id);
      const isStagedSuffix = dEntry.id.endsWith('__staged');
      if (activeDocIds.has(docId) && !isStagedSuffix) {
        skippedActiveCount += 1;
        if (
          params.failOnActiveConflict &&
          typeof params.targetGeneration === 'number' &&
          d.indexGeneration === params.targetGeneration
        ) {
          explicitActiveConflictMsg = `[CLEANUP_BLOCKED_ACTIVE_GENERATION] 활성 문서(${docId}, gen=${String(
            d.indexGeneration
          )})는 정리할 수 없습니다.`;
        }
        continue;
      }

      const entityType = String(
        d.sourceEntityType || 'EPISODE'
      ) as MemorySourceEntityType;
      const entityId = String(d.sourceEntityId || '');
      const entityKey = `${params.ownerId}:${params.projectId}:${entityType}:${entityId}`;
      const activeGen = activeGenByEntityKey.get(entityKey) || 0;
      const docGen =
        typeof d.indexGeneration === 'number' ? d.indexGeneration : 0;

      if (activeGen > 0 && docGen === activeGen && !isStagedSuffix) {
        skippedActiveCount += 1;
        if (
          params.failOnActiveConflict ||
          params.targetGeneration === docGen
        ) {
          explicitActiveConflictMsg = `[CLEANUP_BLOCKED_ACTIVE_GENERATION] 활성 세대(gen=${activeGen}) 문서(${docId})는 정리할 수 없습니다.`;
        }
        continue;
      }

      if (
        isStagedSuffix &&
        activeGen > 0 &&
        docGen === activeGen &&
        d.isActiveGeneration !== false
      ) {
        skippedActiveCount += 1;
        continue;
      }

      const stagingId = typeof d.stagingId === 'string' ? d.stagingId : '';
      const receipt = stagingId ? receiptById.get(stagingId) : undefined;
      if (params.targetStagingId && stagingId && stagingId !== params.targetStagingId) {
        continue;
      }
      if (params.targetStagingId && !stagingId) {
        // When targeting a specific stagingId, match by receipt generation if doc belongs to same entity
        const targetR = receiptById.get(params.targetStagingId);
        if (!targetR || targetR.generation !== docGen || targetR.sourceEntityId !== entityId) {
          continue;
        }
      }

      const claimKey = makeCleanupClaimKey(entityKey, docGen);
      const existingClaim = existingClaims[claimKey];
      const liveLeaseGen = liveTaskLeaseGenByEntityKey.get(entityKey) || 0;
      const hasLiveLease = liveLeaseGen > 0;
      const isSupersededReceipt =
        Boolean(receipt) &&
        hasLiveLease &&
        typeof receipt!.targetLeaseGeneration === 'number' &&
        receipt!.targetLeaseGeneration < liveLeaseGen;

      const updatedIso =
        normalizeIsoTimestampForActivationTx(d.updatedAt) ||
        normalizeIsoTimestampForActivationTx(d.indexedAt) ||
        normalizeIsoTimestampForActivationTx(d.createdAt);
      const updatedMs = updatedIso ? new Date(updatedIso).getTime() : NaN;
      const docAgeMs = Number.isFinite(updatedMs)
        ? Math.max(0, nowMs - updatedMs)
        : 0;

      const isOlderGen = activeGen > 0 && docGen > 0 && docGen < activeGen;
      const isPurgableStaging =
        groupsByClaimKey.has(claimKey) ||
        receipt?.status === 'ABORTED' ||
        receipt?.status === 'CLEANUP_PENDING' ||
        existingClaim?.status === 'CLEANUP_PENDING' ||
        isSupersededReceipt;

      // Safe replacement of old `endsWith('__staged') && activeGen > 0` heuristic:
      // Active small-scale __staged docs (docGen > activeGen or recent updatedAt or protected by live lease)
      // MUST NOT be treated as orphaned!
      const isSafeStaleStaged =
        isStagedSuffix &&
        !hasLiveLease &&
        (isOlderGen ||
          (activeGen > 0 &&
            docAgeMs >= staleThresholdMs &&
            d.isActiveGeneration === false));

      const isStaleUnreceiptedInFlight =
        !isStagedSuffix &&
        !receipt &&
        !hasLiveLease &&
        d.isActiveGeneration === false &&
        docAgeMs >= staleThresholdMs &&
        docGen > activeGen;

      if (
        isOlderGen ||
        isPurgableStaging ||
        isSafeStaleStaged ||
        isStaleUnreceiptedInFlight
      ) {
        const recEntry = stagingId ? receiptEntryById.get(stagingId) : undefined;
        const grp = ensureGroup({
          claimKey,
          entityKey,
          sourceEntityType: entityType,
          sourceEntityId: entityId,
          generation: docGen,
          stagingId: stagingId || recEntry?.id,
          stagingPath: recEntry?.path,
          stagingReceipt: receipt,
          reason: isPurgableStaging
            ? 'STAGING_OR_CLAIM'
            : isSafeStaleStaged
            ? 'STALE_STAGED_NO_LEASE'
            : 'OLDER_GENERATION',
        });
        grp.docPaths.push(dEntry.path);
        const trackedDocId = isStagedSuffix ? dEntry.id : docId;
        if (!grp.targetDocumentIds.includes(trackedDocId)) {
          grp.targetDocumentIds.push(trackedDocId);
        }
      } else if (
        (docGen > activeGen && d.isActiveGeneration === false) ||
        isStagedSuffix
      ) {
        skippedInFlightStagingCount += 1;
      }
    }

    for (const cEntry of inputData.chunks) {
      const c = cEntry.data;
      if (c.ownerId !== params.ownerId || c.projectId !== params.projectId) {
        continue;
      }
      if (!matchesFilter(c)) continue;

      const parentDocId = String(c.documentId || '');
      const isStagedSuffix = cEntry.id.endsWith('__staged');
      if (activeDocIds.has(parentDocId) && !isStagedSuffix) {
        skippedActiveCount += 1;
        continue;
      }

      const entityType = String(
        c.sourceEntityType || 'EPISODE'
      ) as MemorySourceEntityType;
      const entityId = String(c.sourceEntityId || '');
      const entityKey = `${params.ownerId}:${params.projectId}:${entityType}:${entityId}`;
      const activeGen = activeGenByEntityKey.get(entityKey) || 0;
      const chkGen =
        typeof c.indexGeneration === 'number' ? c.indexGeneration : 0;

      if (activeGen > 0 && chkGen === activeGen && !isStagedSuffix) {
        skippedActiveCount += 1;
        continue;
      }
      if (
        isStagedSuffix &&
        activeGen > 0 &&
        chkGen === activeGen &&
        c.isActiveGeneration !== false
      ) {
        skippedActiveCount += 1;
        continue;
      }

      const stagingId = typeof c.stagingId === 'string' ? c.stagingId : '';
      const receipt = stagingId ? receiptById.get(stagingId) : undefined;
      if (params.targetStagingId && stagingId && stagingId !== params.targetStagingId) {
        continue;
      }
      if (params.targetStagingId && !stagingId) {
        const targetR = receiptById.get(params.targetStagingId);
        if (!targetR || targetR.generation !== chkGen || targetR.sourceEntityId !== entityId) {
          continue;
        }
      }

      const claimKey = makeCleanupClaimKey(entityKey, chkGen);
      const existingClaim = existingClaims[claimKey];
      const liveLeaseGen = liveTaskLeaseGenByEntityKey.get(entityKey) || 0;
      const hasLiveLease = liveLeaseGen > 0;
      const isSupersededReceipt =
        Boolean(receipt) &&
        hasLiveLease &&
        typeof receipt!.targetLeaseGeneration === 'number' &&
        receipt!.targetLeaseGeneration < liveLeaseGen;

      const updatedIso =
        normalizeIsoTimestampForActivationTx(c.updatedAt) ||
        normalizeIsoTimestampForActivationTx(c.createdAt);
      const updatedMs = updatedIso ? new Date(updatedIso).getTime() : NaN;
      const chkAgeMs = Number.isFinite(updatedMs)
        ? Math.max(0, nowMs - updatedMs)
        : 0;

      const isOlderGen = activeGen > 0 && chkGen > 0 && chkGen < activeGen;
      const isPurgableStaging =
        groupsByClaimKey.has(claimKey) ||
        receipt?.status === 'ABORTED' ||
        receipt?.status === 'CLEANUP_PENDING' ||
        existingClaim?.status === 'CLEANUP_PENDING' ||
        isSupersededReceipt;

      const isSafeStaleStaged =
        isStagedSuffix &&
        !hasLiveLease &&
        (isOlderGen ||
          (activeGen > 0 &&
            chkAgeMs >= staleThresholdMs &&
            c.isActiveGeneration === false));

      const isStaleUnreceiptedInFlight =
        !isStagedSuffix &&
        !receipt &&
        !hasLiveLease &&
        c.isActiveGeneration === false &&
        chkAgeMs >= staleThresholdMs &&
        chkGen > activeGen;

      if (
        isOlderGen ||
        isPurgableStaging ||
        isSafeStaleStaged ||
        isStaleUnreceiptedInFlight
      ) {
        const recEntry = stagingId ? receiptEntryById.get(stagingId) : undefined;
        const grp = ensureGroup({
          claimKey,
          entityKey,
          sourceEntityType: entityType,
          sourceEntityId: entityId,
          generation: chkGen,
          stagingId: stagingId || recEntry?.id,
          stagingPath: recEntry?.path,
          stagingReceipt: receipt,
          reason: isPurgableStaging
            ? 'STAGING_OR_CLAIM'
            : isSafeStaleStaged
            ? 'STALE_STAGED_NO_LEASE'
            : 'OLDER_GENERATION',
        });
        grp.chunkPaths.push(cEntry.path);
        const trackedParentId = isStagedSuffix
          ? `${parentDocId}__staged`
          : parentDocId;
        if (parentDocId && !grp.targetDocumentIds.includes(trackedParentId)) {
          grp.targetDocumentIds.push(trackedParentId);
        }
      } else if (
        (chkGen > activeGen && c.isActiveGeneration === false) ||
        isStagedSuffix
      ) {
        skippedInFlightStagingCount += 1;
      }
    }

    return {
      groups: Array.from(groupsByClaimKey.values()),
      taskIdsByEntityKey,
      skippedActiveCount,
      skippedInFlightStagingCount,
      explicitActiveConflictMsg,
    };
  };

  if (!options?.db && activeMockFirestoreBackend) {
    const mockBackend = activeMockFirestoreBackend;
    const manifestKey = `users/${params.ownerId}/projects/${params.projectId}/ragManifest/control`;
    const scanManifest = mockBackend.getManifest(params.ownerId, params.projectId);
    const docs: Array<{ path: string; id: string; data: Record<string, unknown> }> = [];
    const chunks: Array<{ path: string; id: string; data: Record<string, unknown> }> = [];
    const receipts: Array<{
      path: string;
      id: string;
      data: RagGenerationStagingReceipt;
    }> = [];
    const tasks: Array<{ id: string; data: Record<string, unknown> }> = [];
    const taskPrefix = `${basePath}/ragSyncTasks/`;

    for (const [p, val] of mockBackend.documentsByPath.entries()) {
      if (p.startsWith(docPrefix)) {
        docs.push({ path: p, id: p.slice(docPrefix.length), data: val });
      } else if (p.startsWith(chunkPrefix)) {
        chunks.push({ path: p, id: p.slice(chunkPrefix.length), data: val });
      } else if (p.startsWith(stagingPrefix)) {
        receipts.push({
          path: p,
          id: p.slice(stagingPrefix.length),
          data: val as unknown as RagGenerationStagingReceipt,
        });
      } else if (p.startsWith(taskPrefix)) {
        tasks.push({ id: p.slice(taskPrefix.length), data: val });
      }
    }

    const plan = evaluateCleanupTargets({
      manifest: scanManifest,
      docs,
      chunks,
      receipts,
      tasks,
    });

    if (params.onAfterCandidateScanBeforeClaimTx) {
      await params.onAfterCandidateScanBeforeClaimTx({
        claimKeys: plan.groups.map((g) => g.claimKey),
        candidateGenerations: plan.groups.map((g) => g.generation),
      });
    }

    if (plan.explicitActiveConflictMsg) {
      throw new Error(plan.explicitActiveConflictMsg);
    }

    // Re-read live manifest + receipts inside simulated Claim TX to prevent TOCTOU races
    const liveManifest: FirestoreRagManifestDoc = mockBackend.getManifest(
      params.ownerId,
      params.projectId
    ) || {
      ownerId: params.ownerId,
      projectId: params.projectId,
      activeGenerationCounter: 0,
      entityStates: {},
      projectLifecycleStatus: 'ACTIVE',
      projectTombstoneGeneration: 0,
      cleanupEpochCounter: 0,
      cleanupClaims: {},
      retiredGenerationsByEntity: {},
      pendingDeletes: {},
      updatedAt: new Date(nowMs).toISOString(),
    };

    const liveActiveDocIds = new Set<string>();
    const liveActiveGenByEntity = new Map<string, number>();
    for (const st of Object.values(liveManifest.entityStates || {})) {
      if (st.lifecycleStatus === 'ACTIVE' && st.activeGeneration > 0) {
        liveActiveGenByEntity.set(st.entityKey, st.activeGeneration);
        for (const docId of st.activeDocumentIds || []) {
          liveActiveDocIds.add(docId);
        }
      }
    }

    const mockLiveTasks: Array<{ id: string; data: Record<string, unknown> }> = [];
    for (const [tp, tv] of mockBackend.documentsByPath.entries()) {
      if (tp.startsWith(taskPrefix)) {
        mockLiveTasks.push({ id: tp.slice(taskPrefix.length), data: tv });
      }
    }
    const { liveTaskLeaseGenByEntityKey } = normalizeTaskLeaseInfo(mockLiveTasks);

    let skippedActiveCount = plan.skippedActiveCount;
    let skippedInFlightStagingCount = plan.skippedInFlightStagingCount;
    let skippedOwnershipConflictCount = 0;
    const conflictedClaimKeys: string[] = [];
    const approvedGroups: CleanupClaimGroupCandidate[] = [];

    for (const g of plan.groups) {
      const liveGen = liveActiveGenByEntity.get(g.entityKey) || 0;
      const intersectsActiveDoc = g.targetDocumentIds.some(
        (id) => !id.endsWith('__staged') && liveActiveDocIds.has(id)
      );
      const liveReceipt = g.stagingPath
        ? mockBackend.stagingReceiptsByPath.get(g.stagingPath)
        : undefined;
      const existingClaim = liveManifest.cleanupClaims?.[g.claimKey];

      if (
        (liveGen > 0 && liveGen === g.generation) ||
        intersectsActiveDoc ||
        (liveReceipt?.status === 'ACTIVATED' && liveGen === g.generation)
      ) {
        const isExplicitTarget =
          params.failOnActiveConflict ||
          params.targetGeneration === g.generation ||
          (params.targetStagingId && g.stagingId === params.targetStagingId);
        if (isExplicitTarget) {
          throw new Error(
            `[CLEANUP_BLOCKED_ACTIVE_GENERATION] 정리 Claim 트랜잭션 중 대상 세대(gen=${g.generation}, entity=${g.entityKey})가 활성 상태로 전환되어 정리가 차단되었습니다.`
          );
        }
        skippedActiveCount += 1;
        continue;
      }

      if (
        existingClaim?.status === 'CLEANUP_COMPLETED' ||
        liveReceipt?.status === 'CLEANUP_COMPLETED'
      ) {
        continue;
      }

      // Check receipt freshness updated concurrently before Claim TX!
      const liveLeaseGen = liveTaskLeaseGenByEntityKey.get(g.entityKey) || 0;
      const isSupersededLease =
        liveLeaseGen > 0 &&
        typeof liveReceipt?.targetLeaseGeneration === 'number' &&
        liveReceipt.targetLeaseGeneration < liveLeaseGen;
      const isOlderThanActive = liveGen > 0 && g.generation < liveGen;
      const receiptUpdatedMs = liveReceipt
        ? new Date(liveReceipt.updatedAt || liveReceipt.createdAt || 0).getTime()
        : NaN;
      const receiptAgeMs = Number.isFinite(receiptUpdatedMs)
        ? Math.max(0, nowMs - receiptUpdatedMs)
        : staleThresholdMs;
      const isFreshInFlightReceipt =
        Boolean(liveReceipt) &&
        (liveReceipt!.status === 'PREPARING' ||
          liveReceipt!.status === 'STAGED' ||
          liveReceipt!.status === 'VERIFIED') &&
        !isSupersededLease &&
        !isOlderThanActive &&
        existingClaim?.status !== 'CLEANUP_PENDING' &&
        receiptAgeMs < staleThresholdMs;
      const protectedByLiveLease =
        liveLeaseGen > 0 &&
        !isSupersededLease &&
        liveReceipt?.status !== 'ABORTED' &&
        liveReceipt?.status !== 'CLEANUP_PENDING' &&
        existingClaim?.status !== 'CLEANUP_PENDING' &&
        !isOlderThanActive;

      if (isFreshInFlightReceipt || protectedByLiveLease) {
        skippedInFlightStagingCount += 1;
        continue;
      }

      // Ownership / Lease Conflict check
      if (existingClaim?.status === 'CLEANUP_PENDING') {
        const hasFiniteLeaseExpiry =
          typeof existingClaim.cleanupLeaseExpiresAtMs === 'number' &&
          Number.isFinite(existingClaim.cleanupLeaseExpiresAtMs);
        const existingLeaseExpiryMs = hasFiniteLeaseExpiry
          ? (existingClaim.cleanupLeaseExpiresAtMs as number)
          : Number.POSITIVE_INFINITY;
        const isInProcessAlive = activeInProcessCleanupOps.has(
          existingClaim.cleanupOperationId
        );
        const isUnexpiredLease = existingLeaseExpiryMs > nowMs;
        const isExplicitSameOwnerResume =
          Boolean(params.resumeCleanupOperationId) &&
          params.resumeCleanupOperationId === existingClaim.cleanupOperationId &&
          existingClaim.cleanupOwner === cleanupOwner &&
          !isInProcessAlive;

        if (
          (isUnexpiredLease || (isInProcessAlive && !hasFiniteLeaseExpiry)) &&
          !isExplicitSameOwnerResume
        ) {
          skippedOwnershipConflictCount += 1;
          conflictedClaimKeys.push(g.claimKey);
          if (params.failOnOwnershipConflict) {
            throw new Error(
              `[CLEANUP_OWNERSHIP_CONFLICT] 다른 Cleaner(owner=${existingClaim.cleanupOwner}, op=${existingClaim.cleanupOperationId}, epoch=${existingClaim.cleanupEpoch})가 유효한 정리 lease를 보유 중입니다.`
            );
          }
          continue;
        }
      }

      approvedGroups.push(g);
    }

    if (approvedGroups.length === 0) {
      return {
        deletedDocs: 0,
        deletedChunks: 0,
        deletedStagingReceipts: 0,
        batchesCommitted: 0,
        skippedActiveCount,
        skippedInFlightStagingCount,
        skippedOwnershipConflictCount,
        conflictedClaimKeys,
        claimedKeys: [],
        completedClaimKeys: [],
        pendingResumeClaimKeys: [],
      };
    }

    const claimIso = new Date(nowMs).toISOString();
    const leaseExpiresMs = nowMs + cleanupLeaseDurationMs;
    const leaseExpiresIso = new Date(leaseExpiresMs).toISOString();
    const cleanupEpoch = Number(liveManifest.cleanupEpochCounter || 0) + 1;
    const cleanupOperationId = `cleanup_${cleanupEpoch}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const nextClaims: Record<string, RagManifestCleanupClaim> = {
      ...(liveManifest.cleanupClaims || {}),
    };

    const allTargetDocIds: string[] = [];
    for (const g of approvedGroups) {
      for (const did of g.targetDocumentIds) {
        if (!allTargetDocIds.includes(did)) allTargetDocIds.push(did);
      }
      nextClaims[g.claimKey] = {
        claimKey: g.claimKey,
        entityKey: g.entityKey,
        ownerId: params.ownerId,
        projectId: params.projectId,
        sourceEntityType: g.sourceEntityType,
        sourceEntityId: g.sourceEntityId,
        generation: g.generation,
        stagingId: g.stagingId,
        cleanupOperationId,
        cleanupEpoch,
        cleanupOwner,
        status: 'CLEANUP_PENDING',
        targetDocumentIds: [...g.targetDocumentIds],
        claimedAt: claimIso,
        cleanupLeaseExpiresAt: leaseExpiresIso,
        cleanupLeaseExpiresAtMs: leaseExpiresMs,
      };
      if (g.stagingPath) {
        const prevR =
          mockBackend.stagingReceiptsByPath.get(g.stagingPath) ||
          g.stagingReceipt;
        if (prevR) {
          const updatedR: RagGenerationStagingReceipt = {
            ...prevR,
            status: 'CLEANUP_PENDING',
            cleanupOperationId,
            cleanupEpoch,
            cleanupOwner,
            cleanupClaimedAt: claimIso,
            cleanupLeaseExpiresAt: leaseExpiresIso,
            cleanupLeaseExpiresAtMs: leaseExpiresMs,
            cleanupTargetDocumentIds: [...g.targetDocumentIds],
            updatedAt: claimIso,
          };
          mockBackend.stagingReceiptsByPath.set(g.stagingPath, updatedR);
          mockBackend.documentsByPath.set(
            g.stagingPath,
            updatedR as unknown as Record<string, unknown>
          );
        }
      }
    }

    const prunedInit = pruneManifestCleanupClaims(
      nextClaims,
      liveManifest.retiredGenerationsByEntity
    );
    liveManifest.cleanupEpochCounter = cleanupEpoch;
    liveManifest.cleanupClaims = prunedInit.cleanupClaims;
    liveManifest.retiredGenerationsByEntity = prunedInit.retiredGenerationsByEntity;
    liveManifest.updatedAt = claimIso;
    mockBackend.manifestsByProject.set(manifestKey, liveManifest);
    mockBackend.transactionCommitCount += 1;

    activeInProcessCleanupOps.add(cleanupOperationId);
    let deletedDocs = 0;
    let deletedChunks = 0;
    let deletedStagingReceipts = 0;
    let batchesCommitted = 0;
    const completedClaimKeys: string[] = [];
    const pendingResumeClaimKeys: string[] = [];

    const releaseMockLeaseIfStillOwned = () => {
      const m = mockBackend.getManifest(params.ownerId, params.projectId);
      if (!m?.cleanupClaims) return;
      const expiredMs = nowMs - 1;
      const expiredIso = new Date(expiredMs).toISOString();
      let changed = false;
      for (const g of approvedGroups) {
        const c = m.cleanupClaims[g.claimKey];
        if (
          c &&
          c.status === 'CLEANUP_PENDING' &&
          c.cleanupOperationId === cleanupOperationId &&
          c.cleanupEpoch === cleanupEpoch
        ) {
          m.cleanupClaims[g.claimKey] = {
            ...c,
            cleanupLeaseExpiresAt: expiredIso,
            cleanupLeaseExpiresAtMs: expiredMs,
          };
          changed = true;
        }
        if (g.stagingPath) {
          const sr = mockBackend.stagingReceiptsByPath.get(g.stagingPath);
          if (
            sr &&
            sr.status === 'CLEANUP_PENDING' &&
            sr.cleanupOperationId === cleanupOperationId &&
            sr.cleanupEpoch === cleanupEpoch
          ) {
            const relR: RagGenerationStagingReceipt = {
              ...sr,
              cleanupLeaseExpiresAt: expiredIso,
              cleanupLeaseExpiresAtMs: expiredMs,
            };
            mockBackend.stagingReceiptsByPath.set(g.stagingPath, relR);
            mockBackend.documentsByPath.set(
              g.stagingPath,
              relR as unknown as Record<string, unknown>
            );
          }
        }
      }
      if (changed) {
        mockBackend.manifestsByProject.set(manifestKey, m);
      }
    };

    try {
      if (params.onBetweenClaimAndDeleteHook) {
        await params.onBetweenClaimAndDeleteHook({
          cleanupOperationId,
          cleanupEpoch,
          claimKeys: approvedGroups.map((g) => g.claimKey),
          targetDocumentIds: allTargetDocIds,
        });
      }

      const approvedByEntityGenKey = new Map<string, CleanupClaimGroupCandidate>();
      const orderedDeleteEntries: Array<{ path: string; group: CleanupClaimGroupCandidate }> = [];
      const seenPaths = new Set<string>();
      for (const g of approvedGroups) {
        approvedByEntityGenKey.set(g.claimKey, g);
        for (const p of [...g.chunkPaths, ...g.docPaths]) {
          if (!seenPaths.has(p)) {
            seenPaths.add(p);
            orderedDeleteEntries.push({ path: p, group: g });
          }
        }
      }

      for (
        let i = 0;
        i < orderedDeleteEntries.length && batchesCommitted < maxBatches;
        i += FIRESTORE_FENCED_CLEANUP_TX_MAX_DELETE_OPS
      ) {
        const nextBatchNum = batchesCommitted + 1;
        if (
          (typeof params.simulateDeleteFailureAtBatchNumber === 'number' &&
            nextBatchNum === params.simulateDeleteFailureAtBatchNumber) ||
          (mockBackend.simulateDeleteBatchFailureAtBatchNumber !== null &&
            nextBatchNum === mockBackend.simulateDeleteBatchFailureAtBatchNumber)
        ) {
          throw new Error(
            `[CLEANUP_BATCH_DELETE_FAILED] 정리 배치 #${nextBatchNum} 삭제 중 장애 시뮬레이션 (claimOp=${cleanupOperationId})`
          );
        }
        const slice = orderedDeleteEntries.slice(
          i,
          i + FIRESTORE_FENCED_CLEANUP_TX_MAX_DELETE_OPS
        );

        // Simulated Fenced Delete TX: verify manifest claim ownership, epoch & target metadata before deleting
        const txM = mockBackend.getManifest(params.ownerId, params.projectId);
        const txActiveDocIds = new Set<string>();
        const txActiveGenByEntity = new Map<string, number>();
        for (const st of Object.values(txM?.entityStates || {})) {
          if (st.lifecycleStatus === 'ACTIVE' && st.activeGeneration > 0) {
            txActiveGenByEntity.set(st.entityKey, st.activeGeneration);
            for (const did of st.activeDocumentIds || []) {
              txActiveDocIds.add(did);
            }
          }
        }

        const verifiedDeletes: Array<{ path: string }> = [];
        for (const entry of slice) {
          const cClaim = txM?.cleanupClaims?.[entry.group.claimKey];
          if (
            !cClaim ||
            cClaim.status !== 'CLEANUP_PENDING' ||
            cClaim.cleanupOperationId !== cleanupOperationId ||
            cClaim.cleanupEpoch !== cleanupEpoch ||
            cClaim.cleanupOwner !== cleanupOwner
          ) {
            throw new Error(
              `[CLEANUP_OWNERSHIP_LOST] 삭제 트랜잭션 중 소유권 또는 Epoch(expectedOp=${cleanupOperationId}, expectedEpoch=${cleanupEpoch}, actualOp=${String(
                cClaim?.cleanupOperationId
              )}, actualEpoch=${String(cClaim?.cleanupEpoch)})가 상실되어 삭제를 중단했습니다.`
            );
          }

          if (
            (txActiveGenByEntity.get(entry.group.entityKey) || 0) ===
            entry.group.generation
          ) {
            throw new Error(
              `[CLEANUP_BLOCKED_ACTIVE_GENERATION] 삭제 트랜잭션 중 대상 세대(gen=${entry.group.generation})가 활성 세대로 전환되어 삭제를 중단했습니다.`
            );
          }

          const existingTarget = mockBackend.documentsByPath.get(entry.path);
          if (!existingTarget) continue;

          const tGen =
            typeof existingTarget.indexGeneration === 'number'
              ? existingTarget.indexGeneration
              : undefined;
          const isStagedPath = entry.path.endsWith('__staged');
          const isChunkPath = entry.path.startsWith(chunkPrefix);
          const tDocId = isChunkPath
            ? String(existingTarget.documentId || '')
            : String(existingTarget.id || entry.path.slice(docPrefix.length));
          const entityActiveGen =
            txActiveGenByEntity.get(entry.group.entityKey) || 0;
          const isProtectedActiveTarget =
            (!isStagedPath && txActiveDocIds.has(tDocId)) ||
            (entityActiveGen > 0 && tGen === entityActiveGen && !isStagedPath) ||
            (!isStagedPath &&
              entityActiveGen === 0 &&
              existingTarget.isActiveGeneration === true);
          if (
            existingTarget.ownerId === params.ownerId &&
            existingTarget.projectId === params.projectId &&
            existingTarget.sourceEntityType === entry.group.sourceEntityType &&
            existingTarget.sourceEntityId === entry.group.sourceEntityId &&
            tGen === entry.group.generation &&
            !isProtectedActiveTarget
          ) {
            verifiedDeletes.push({ path: entry.path });
          } else {
            throw new Error(
              `[CLEANUP_BLOCKED_ACTIVE_GENERATION] 삭제 대상 문서(${entry.path})의 세대/활성 상태 불일치로 Fenced Delete TX가 중단되었습니다.`
            );
          }
        }

        for (const vd of verifiedDeletes) {
          mockBackend.documentsByPath.delete(vd.path);
          if (vd.path.startsWith(chunkPrefix)) deletedChunks += 1;
          else if (vd.path.startsWith(docPrefix)) deletedDocs += 1;
        }
        // Refresh cleanup lease heartbeat
        if (txM?.cleanupClaims) {
          const hbBaseMs = isTestIsolatedMode ? nowMs : Date.now();
          const hbMs = hbBaseMs + cleanupLeaseDurationMs;
          const hbIso = new Date(hbMs).toISOString();
          for (const g of approvedGroups) {
            const c = txM.cleanupClaims[g.claimKey];
            if (c && c.cleanupOperationId === cleanupOperationId) {
              txM.cleanupClaims[g.claimKey] = {
                ...c,
                cleanupLeaseExpiresAt: hbIso,
                cleanupLeaseExpiresAtMs: hbMs,
              };
            }
          }
          mockBackend.manifestsByProject.set(manifestKey, txM);
        }

        batchesCommitted += 1;
        mockBackend.committedDeleteBatchCount += 1;
        mockBackend.committedDeleteOpsCount += verifiedDeletes.length;
        mockBackend.transactionCommitCount += 1;

        if (params.onAfterDeleteBatchHook) {
          await params.onAfterDeleteBatchHook({
            batchesCommitted,
            deletedDocs,
            deletedChunks,
            claimKeys: approvedGroups.map((g) => g.claimKey),
          });
        }
      }

      const completedAllDeleteBatches =
        orderedDeleteEntries.length === 0 ||
        batchesCommitted * FIRESTORE_FENCED_CLEANUP_TX_MAX_DELETE_OPS >=
          orderedDeleteEntries.length;

      if (!completedAllDeleteBatches) {
        releaseMockLeaseIfStillOwned();
        for (const g of approvedGroups) {
          pendingResumeClaimKeys.push(g.claimKey);
        }
      } else {
        const finalizeManifest = mockBackend.getManifest(
          params.ownerId,
          params.projectId
        );
        const finalizeIso = new Date().toISOString();
        const updatedClaims = { ...(finalizeManifest?.cleanupClaims || {}) };
        let nextLedger = finalizeManifest?.retiredGenerationsByEntity
          ? { ...finalizeManifest.retiredGenerationsByEntity }
          : {};

        for (const g of approvedGroups) {
          const curClaim = updatedClaims[g.claimKey];
          if (
            curClaim &&
            (curClaim.status !== 'CLEANUP_PENDING' ||
              curClaim.cleanupOperationId !== cleanupOperationId ||
              curClaim.cleanupEpoch !== cleanupEpoch ||
              curClaim.cleanupOwner !== cleanupOwner)
          ) {
            throw new Error(
              `[CLEANUP_OWNERSHIP_LOST] Finalize TX에서 Claim(${g.claimKey}) 소유권/Epoch가 상실되었습니다.`
            );
          }

          // Verify 0 remaining docs & chunks for this claimed generation
          let remaining = 0;
          for (const [p, raw] of mockBackend.documentsByPath.entries()) {
            if (!p.startsWith(docPrefix) && !p.startsWith(chunkPrefix)) continue;
            const eType = String(raw.sourceEntityType || '');
            const eId = String(raw.sourceEntityId || '');
            const rGen =
              typeof raw.indexGeneration === 'number' ? raw.indexGeneration : 0;
            const rKey = `${params.ownerId}:${params.projectId}:${eType}:${eId}`;
            if (rKey === g.entityKey && rGen === g.generation) {
              const docId = String(raw.documentId || raw.id || '');
              if (!liveActiveDocIds.has(docId) || p.endsWith('__staged')) {
                remaining += 1;
                break;
              }
            }
          }

          if (remaining > 0) {
            pendingResumeClaimKeys.push(g.claimKey);
            continue;
          }

          completedClaimKeys.push(g.claimKey);
          nextLedger = recordRetiredGenerationInLedgerMap(
            nextLedger,
            g.entityKey,
            g.generation,
            cleanupEpoch,
            finalizeIso
          );
          if (updatedClaims[g.claimKey]) {
            updatedClaims[g.claimKey] = {
              ...updatedClaims[g.claimKey],
              status: 'CLEANUP_COMPLETED',
              completedAt: finalizeIso,
            };
          }
          if (g.stagingPath) {
            if (params.retainCompletedReceipts) {
              const curR =
                mockBackend.stagingReceiptsByPath.get(g.stagingPath) ||
                g.stagingReceipt;
              if (curR) {
                const compR: RagGenerationStagingReceipt = {
                  ...curR,
                  status: 'CLEANUP_COMPLETED',
                  cleanupCompletedAt: finalizeIso,
                  deletedDocumentCount: g.docPaths.length,
                  deletedChunkCount: g.chunkPaths.length,
                  updatedAt: finalizeIso,
                };
                mockBackend.stagingReceiptsByPath.set(g.stagingPath, compR);
                mockBackend.documentsByPath.set(
                  g.stagingPath,
                  compR as unknown as Record<string, unknown>
                );
              }
            } else {
              mockBackend.stagingReceiptsByPath.delete(g.stagingPath);
              mockBackend.documentsByPath.delete(g.stagingPath);
              deletedStagingReceipts += 1;
            }
          }
        }

        if (finalizeManifest) {
          const prunedFin = pruneManifestCleanupClaims(updatedClaims, nextLedger);
          finalizeManifest.cleanupClaims = prunedFin.cleanupClaims;
          finalizeManifest.retiredGenerationsByEntity =
            prunedFin.retiredGenerationsByEntity;
          finalizeManifest.updatedAt = finalizeIso;
          mockBackend.manifestsByProject.set(manifestKey, finalizeManifest);
          mockBackend.transactionCommitCount += 1;
        }
      }
    } catch (mockErr) {
      if (!params.simulateUncleanCrashLeaveLeaseActive) {
        releaseMockLeaseIfStillOwned();
      }
      throw mockErr;
    } finally {
      activeInProcessCleanupOps.delete(cleanupOperationId);
    }

    return {
      deletedDocs,
      deletedChunks,
      deletedStagingReceipts,
      batchesCommitted,
      skippedActiveCount,
      skippedInFlightStagingCount,
      skippedOwnershipConflictCount,
      conflictedClaimKeys,
      cleanupOperationId,
      cleanupEpoch,
      claimedKeys: approvedGroups.map((g) => g.claimKey),
      completedClaimKeys,
      pendingResumeClaimKeys,
    };
  }

  const adminDb = resolveRagFirestore({ db: options?.db });
  if (!adminDb || params.ownerId === 'local_author') {
    return {
      deletedDocs: 0,
      deletedChunks: 0,
      deletedStagingReceipts: 0,
      batchesCommitted: 0,
      skippedActiveCount: 0,
      skippedInFlightStagingCount: 0,
      skippedOwnershipConflictCount: 0,
      conflictedClaimKeys: [],
      claimedKeys: [],
      completedClaimKeys: [],
      pendingResumeClaimKeys: [],
    };
  }

  const [manifestSnap, docsSnap, chunksSnap, stagingSnap, tasksSnap] =
    await Promise.all([
      adminDb.doc(`${basePath}/ragManifest/control`).get(),
      adminDb
        .collection(`${basePath}/memoryDocuments`)
        .where('ownerId', '==', params.ownerId)
        .where('projectId', '==', params.projectId)
        .get(),
      adminDb
        .collection(`${basePath}/memoryChunks`)
        .where('ownerId', '==', params.ownerId)
        .where('projectId', '==', params.projectId)
        .get(),
      adminDb
        .collection(`${basePath}/ragGenerationStaging`)
        .where('ownerId', '==', params.ownerId)
        .where('projectId', '==', params.projectId)
        .get(),
      adminDb.collection(`${basePath}/ragSyncTasks`).get(),
    ]);

  const manifest = manifestSnap.exists
    ? (manifestSnap.data() as FirestoreRagManifestDoc)
    : undefined;

  const plan = evaluateCleanupTargets({
    manifest,
    docs: docsSnap.docs.map((d) => ({
      path: `${docPrefix}${d.id}`,
      id: d.id,
      data: (d.data() || {}) as Record<string, unknown>,
    })),
    chunks: chunksSnap.docs.map((c) => ({
      path: `${chunkPrefix}${c.id}`,
      id: c.id,
      data: (c.data() || {}) as Record<string, unknown>,
    })),
    receipts: stagingSnap.docs.map((r) => ({
      path: `${stagingPrefix}${r.id}`,
      id: r.id,
      data: (r.data() || {}) as RagGenerationStagingReceipt,
    })),
    tasks: tasksSnap.docs.map((t) => ({
      id: t.id,
      data: (t.data() || {}) as Record<string, unknown>,
    })),
  });

  if (params.onAfterCandidateScanBeforeClaimTx) {
    await params.onAfterCandidateScanBeforeClaimTx({
      claimKeys: plan.groups.map((g) => g.claimKey),
      candidateGenerations: plan.groups.map((g) => g.generation),
    });
  }

  if (plan.explicitActiveConflictMsg) {
    throw new Error(plan.explicitActiveConflictMsg);
  }

  const hasExplicitTargetConflictCheck =
    typeof params.targetGeneration === 'number' || Boolean(params.targetStagingId);

  if (plan.groups.length === 0 && !hasExplicitTargetConflictCheck) {
    return {
      deletedDocs: 0,
      deletedChunks: 0,
      deletedStagingReceipts: 0,
      batchesCommitted: 0,
      skippedActiveCount: plan.skippedActiveCount,
      skippedInFlightStagingCount: plan.skippedInFlightStagingCount,
      skippedOwnershipConflictCount: 0,
      conflictedClaimKeys: [],
      claimedKeys: [],
      completedClaimKeys: [],
      pendingResumeClaimKeys: [],
    };
  }

  const manifestRef = adminDb.doc(`${basePath}/ragManifest/control`);
  const projectRef = adminDb.doc(basePath);

  const uniqueStagingPaths = Array.from(
    new Set(
      [
        ...plan.groups
          .map((g) => g.stagingPath)
          .filter((p): p is string => Boolean(p)),
        ...(params.targetStagingId
          ? [`${stagingPrefix}${params.targetStagingId}`]
          : []),
      ].filter(Boolean)
    )
  );
  const candidateEntityTaskIds = Array.from(
    new Set(
      plan.groups.flatMap(
        (g) => plan.taskIdsByEntityKey.get(g.entityKey) || []
      )
    )
  );

  // =========================================================================
  // Phase 1: Atomic Firestore Cleanup Claim Transaction (ALL reads before writes!)
  // =========================================================================
  const claimTxResult = await adminDb.runTransaction(async (tx) => {
    const txManifestSnap = await tx.get(manifestRef);
    const txProjectSnap = await tx.get(projectRef);

    const txStagingSnaps = new Map<string, any>();
    for (const sPath of uniqueStagingPaths) {
      txStagingSnaps.set(sPath, await tx.get(adminDb.doc(sPath)));
    }

    const txTaskEntries: Array<{ id: string; data: Record<string, unknown> }> = [];
    for (const tid of candidateEntityTaskIds) {
      const tSnap = await tx.get(adminDb.doc(`${basePath}/ragSyncTasks/${tid}`));
      if (tSnap.exists) {
        txTaskEntries.push({
          id: tid,
          data: (tSnap.data() || {}) as Record<string, unknown>,
        });
      }
    }

    if (txProjectSnap.exists) {
      const pData = txProjectSnap.data() || {};
      if (pData.ownerId && pData.ownerId !== params.ownerId) {
        throw new Error(
          `권한 거부(403 - FIRESTORE_PROJECT_OWNER_MISMATCH): 프로젝트('${params.projectId}') 소유자가 일치하지 않습니다.`
        );
      }
    }

    const mData = txManifestSnap.exists
      ? ((txManifestSnap.data() || {}) as Partial<FirestoreRagManifestDoc>)
      : {};
    const liveEntityStates = mData.entityStates || {};
    const liveClaims = mData.cleanupClaims || {};
    const liveActiveDocIds = new Set<string>();
    const liveActiveGenByEntityKey = new Map<string, number>();

    for (const st of Object.values(liveEntityStates)) {
      if (st.ownerId !== params.ownerId || st.projectId !== params.projectId) {
        continue;
      }
      if (st.lifecycleStatus === 'ACTIVE' && st.activeGeneration > 0) {
        liveActiveGenByEntityKey.set(st.entityKey, st.activeGeneration);
        for (const docId of st.activeDocumentIds || []) {
          liveActiveDocIds.add(docId);
        }
      }
    }

    if (params.targetStagingId) {
      const targetSPath = `${stagingPrefix}${params.targetStagingId}`;
      const targetSSnap = txStagingSnaps.get(targetSPath);
      if (targetSSnap?.exists) {
        const tsData = targetSSnap.data() as Partial<RagGenerationStagingReceipt>;
        const tEntityKey =
          tsData.entityKey ||
          `${params.ownerId}:${params.projectId}:${tsData.sourceEntityType}:${tsData.sourceEntityId}`;
        const tActiveGen = liveActiveGenByEntityKey.get(tEntityKey) || 0;
        if (
          tsData.status === 'ACTIVATED' &&
          tActiveGen > 0 &&
          tsData.generation === tActiveGen
        ) {
          throw new Error(
            `[CLEANUP_BLOCKED_ACTIVE_GENERATION] 활성화된 스테이징 영수증(${params.targetStagingId}, gen=${tActiveGen})은 정리할 수 없습니다.`
          );
        }
      }
    }

    if (typeof params.targetGeneration === 'number') {
      for (const [eKey, actGen] of liveActiveGenByEntityKey.entries()) {
        if (actGen === params.targetGeneration) {
          const filterMatch =
            (!params.sourceEntityType ||
              eKey.includes(`:${params.sourceEntityType}:`)) &&
            (!params.sourceEntityId || eKey.endsWith(`:${params.sourceEntityId}`));
          if (filterMatch) {
            throw new Error(
              `[CLEANUP_BLOCKED_ACTIVE_GENERATION] 대상 세대(gen=${actGen}, entity=${eKey})가 현재 활성 세대이므로 정리가 차단되었습니다.`
            );
          }
        }
      }
    }

    const { liveTaskLeaseGenByEntityKey } =
      normalizeTaskLeaseInfo(txTaskEntries);

    const approvedGroups: CleanupClaimGroupCandidate[] = [];
    const conflictedClaimKeys: string[] = [];
    let txSkippedActive = 0;
    let txSkippedInFlight = 0;
    let txSkippedOwnershipConflict = 0;

    for (const g of plan.groups) {
      const liveActiveGen = liveActiveGenByEntityKey.get(g.entityKey) || 0;
      const intersectsActiveDoc = g.targetDocumentIds.some(
        (did) => !did.endsWith('__staged') && liveActiveDocIds.has(did)
      );
      const txStagingSnap = g.stagingPath
        ? txStagingSnaps.get(g.stagingPath)
        : undefined;
      const liveReceipt = txStagingSnap?.exists
        ? (txStagingSnap.data() as Partial<RagGenerationStagingReceipt>)
        : undefined;
      const existingClaim = liveClaims[g.claimKey];

      const becameActive =
        (liveActiveGen > 0 && g.generation === liveActiveGen) ||
        intersectsActiveDoc ||
        (liveReceipt?.status === 'ACTIVATED' && liveActiveGen === g.generation);

      if (becameActive) {
        const isExplicitTarget =
          params.failOnActiveConflict ||
          params.targetGeneration === g.generation ||
          (params.targetStagingId && g.stagingId === params.targetStagingId);
        if (isExplicitTarget) {
          throw new Error(
            `[CLEANUP_BLOCKED_ACTIVE_GENERATION] 정리 Claim 트랜잭션 중 세대(gen=${g.generation}, entity=${g.entityKey})가 이미 활성화되어 정리가 차단되었습니다.`
          );
        }
        txSkippedActive += 1;
        continue;
      }

      if (
        existingClaim?.status === 'CLEANUP_COMPLETED' ||
        liveReceipt?.status === 'CLEANUP_COMPLETED'
      ) {
        continue;
      }

      const liveLeaseGen = liveTaskLeaseGenByEntityKey.get(g.entityKey) || 0;
      const isSupersededLease =
        liveLeaseGen > 0 &&
        typeof liveReceipt?.targetLeaseGeneration === 'number' &&
        liveReceipt.targetLeaseGeneration < liveLeaseGen;
      const isOlderThanActive = liveActiveGen > 0 && g.generation < liveActiveGen;
      const receiptUpdatedIso = liveReceipt
        ? normalizeIsoTimestampForActivationTx(
            liveReceipt.updatedAt || liveReceipt.createdAt
          )
        : undefined;
      const receiptUpdatedMs = receiptUpdatedIso
        ? new Date(receiptUpdatedIso).getTime()
        : NaN;
      const receiptAgeMs = Number.isFinite(receiptUpdatedMs)
        ? Math.max(0, nowMs - receiptUpdatedMs)
        : staleThresholdMs;

      const isFreshInFlightReceipt =
        Boolean(liveReceipt) &&
        (liveReceipt!.status === 'PREPARING' ||
          liveReceipt!.status === 'STAGED' ||
          liveReceipt!.status === 'VERIFIED') &&
        !isSupersededLease &&
        !isOlderThanActive &&
        existingClaim?.status !== 'CLEANUP_PENDING' &&
        receiptAgeMs < staleThresholdMs;

      const protectedByLiveLease =
        liveLeaseGen > 0 &&
        !isSupersededLease &&
        liveReceipt?.status !== 'ABORTED' &&
        liveReceipt?.status !== 'CLEANUP_PENDING' &&
        existingClaim?.status !== 'CLEANUP_PENDING' &&
        !isOlderThanActive;

      if (isFreshInFlightReceipt || protectedByLiveLease) {
        txSkippedInFlight += 1;
        continue;
      }

      // Single active owner + Lease expiry / Epoch fencing check
      if (existingClaim?.status === 'CLEANUP_PENDING') {
        const hasFiniteLeaseExpiry =
          typeof existingClaim.cleanupLeaseExpiresAtMs === 'number' &&
          Number.isFinite(existingClaim.cleanupLeaseExpiresAtMs);
        const existingLeaseExpiryMs = hasFiniteLeaseExpiry
          ? (existingClaim.cleanupLeaseExpiresAtMs as number)
          : Number.POSITIVE_INFINITY;
        const isInProcessAlive = activeInProcessCleanupOps.has(
          existingClaim.cleanupOperationId
        );
        const isUnexpiredLease = existingLeaseExpiryMs > nowMs;
        const isExplicitSameOwnerResume =
          Boolean(params.resumeCleanupOperationId) &&
          params.resumeCleanupOperationId === existingClaim.cleanupOperationId &&
          existingClaim.cleanupOwner === cleanupOwner &&
          !isInProcessAlive;

        if (
          (isUnexpiredLease || (isInProcessAlive && !hasFiniteLeaseExpiry)) &&
          !isExplicitSameOwnerResume
        ) {
          txSkippedOwnershipConflict += 1;
          conflictedClaimKeys.push(g.claimKey);
          if (params.failOnOwnershipConflict) {
            throw new Error(
              `[CLEANUP_OWNERSHIP_CONFLICT] 다른 Cleaner(owner=${existingClaim.cleanupOwner}, op=${existingClaim.cleanupOperationId}, epoch=${existingClaim.cleanupEpoch})가 유효한 정리 lease를 보유 중입니다.`
            );
          }
          continue;
        }
      }

      approvedGroups.push(g);
    }

    if (approvedGroups.length === 0) {
      return {
        approvedGroups: [] as CleanupClaimGroupCandidate[],
        cleanupOperationId: undefined,
        cleanupEpoch: Number(mData.cleanupEpochCounter || 0),
        liveActiveDocIds: Array.from(liveActiveDocIds),
        liveActiveGenByEntityEntries: Array.from(
          liveActiveGenByEntityKey.entries()
        ),
        txSkippedActive,
        txSkippedInFlight,
        txSkippedOwnershipConflict,
        conflictedClaimKeys,
      };
    }

    const claimIso = new Date(nowMs).toISOString();
    const leaseExpiresMs = nowMs + cleanupLeaseDurationMs;
    const leaseExpiresIso = new Date(leaseExpiresMs).toISOString();
    const cleanupEpoch = Number(mData.cleanupEpochCounter || 0) + 1;
    const cleanupOperationId = `cleanup_${cleanupEpoch}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    const nextClaims: Record<string, RagManifestCleanupClaim> = {
      ...(mData.cleanupClaims || {}),
    };

    for (const g of approvedGroups) {
      nextClaims[g.claimKey] = sanitizeFirestoreWriteData({
        claimKey: g.claimKey,
        entityKey: g.entityKey,
        ownerId: params.ownerId,
        projectId: params.projectId,
        sourceEntityType: g.sourceEntityType,
        sourceEntityId: g.sourceEntityId,
        generation: g.generation,
        ...(g.stagingId ? { stagingId: g.stagingId } : {}),
        cleanupOperationId,
        cleanupEpoch,
        cleanupOwner,
        status: 'CLEANUP_PENDING',
        targetDocumentIds: [...g.targetDocumentIds],
        claimedAt: claimIso,
        cleanupLeaseExpiresAt: leaseExpiresIso,
        cleanupLeaseExpiresAtMs: leaseExpiresMs,
      });

      if (g.stagingPath) {
        const sSnap = txStagingSnaps.get(g.stagingPath);
        if (sSnap?.exists) {
          tx.set(
            adminDb.doc(g.stagingPath),
            sanitizeFirestoreWriteData({
              status: 'CLEANUP_PENDING',
              cleanupOperationId,
              cleanupEpoch,
              cleanupOwner,
              cleanupClaimedAt: claimIso,
              cleanupLeaseExpiresAt: leaseExpiresIso,
              cleanupLeaseExpiresAtMs: leaseExpiresMs,
              cleanupTargetDocumentIds: [...g.targetDocumentIds],
              updatedAt: claimIso,
            }),
            { merge: true }
          );
        }
      }
    }

    const prunedInit = pruneManifestCleanupClaims(
      nextClaims,
      mData.retiredGenerationsByEntity
    );

    const claimManifestPayload = sanitizeFirestoreWriteData({
      ownerId: params.ownerId,
      projectId: params.projectId,
      cleanupEpochCounter: cleanupEpoch,
      cleanupClaims: prunedInit.cleanupClaims,
      retiredGenerationsByEntity: prunedInit.retiredGenerationsByEntity,
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (txManifestSnap.exists) {
      tx.update(manifestRef, claimManifestPayload);
    } else {
      tx.set(manifestRef, claimManifestPayload, { merge: true });
    }

    return {
      approvedGroups,
      cleanupOperationId,
      cleanupEpoch,
      liveActiveDocIds: Array.from(liveActiveDocIds),
      liveActiveGenByEntityEntries: Array.from(
        liveActiveGenByEntityKey.entries()
      ),
      txSkippedActive,
      txSkippedInFlight,
      txSkippedOwnershipConflict,
      conflictedClaimKeys,
    };
  });

  const approvedGroups = claimTxResult.approvedGroups;
  const skippedActiveCount =
    plan.skippedActiveCount + claimTxResult.txSkippedActive;
  const skippedInFlightStagingCount =
    plan.skippedInFlightStagingCount + claimTxResult.txSkippedInFlight;
  const skippedOwnershipConflictCount = claimTxResult.txSkippedOwnershipConflict;
  const conflictedClaimKeys = claimTxResult.conflictedClaimKeys;

  if (approvedGroups.length === 0 || !claimTxResult.cleanupOperationId) {
    return {
      deletedDocs: 0,
      deletedChunks: 0,
      deletedStagingReceipts: 0,
      batchesCommitted: 0,
      skippedActiveCount,
      skippedInFlightStagingCount,
      skippedOwnershipConflictCount,
      conflictedClaimKeys,
      claimedKeys: [],
      completedClaimKeys: [],
      pendingResumeClaimKeys: [],
    };
  }

  const cleanupOperationId = claimTxResult.cleanupOperationId;
  const cleanupEpoch = claimTxResult.cleanupEpoch;
  const liveActiveDocIdSet = new Set(claimTxResult.liveActiveDocIds);
  const allTargetDocumentIds = Array.from(
    new Set(approvedGroups.flatMap((g) => g.targetDocumentIds))
  );

  activeInProcessCleanupOps.add(cleanupOperationId);
  let deletedDocs = 0;
  let deletedChunks = 0;
  let deletedStagingReceipts = 0;
  let batchesCommitted = 0;
  const completedClaimKeys: string[] = [];
  const pendingResumeClaimKeys: string[] = [];

  const releaseAdminLeaseIfStillOwned = async () => {
    try {
      await adminDb.runTransaction(async (tx) => {
        const txM = await tx.get(manifestRef);
        const txS = new Map<string, boolean>();
        for (const g of approvedGroups) {
          if (g.stagingPath) {
            const s = await tx.get(adminDb.doc(g.stagingPath));
            txS.set(g.stagingPath, s.exists);
          }
        }
        if (!txM.exists) return;
        const mObj = (txM.data() || {}) as Partial<FirestoreRagManifestDoc>;
        const nextClaims: Record<string, RagManifestCleanupClaim> = {
          ...(mObj.cleanupClaims || {}),
        };
        const expiredMs = nowMs - 1;
        const expiredIso = new Date(expiredMs).toISOString();
        let anyUpdated = false;
        for (const g of approvedGroups) {
          const cur = nextClaims[g.claimKey];
          if (
            cur &&
            cur.status === 'CLEANUP_PENDING' &&
            cur.cleanupOperationId === cleanupOperationId &&
            cur.cleanupEpoch === cleanupEpoch
          ) {
            nextClaims[g.claimKey] = {
              ...cur,
              cleanupLeaseExpiresAt: expiredIso,
              cleanupLeaseExpiresAtMs: expiredMs,
            };
            anyUpdated = true;
            if (g.stagingPath && txS.get(g.stagingPath)) {
              tx.set(
                adminDb.doc(g.stagingPath),
                sanitizeFirestoreWriteData({
                  cleanupLeaseExpiresAt: expiredIso,
                  cleanupLeaseExpiresAtMs: expiredMs,
                }),
                { merge: true }
              );
            }
          }
        }
        if (anyUpdated) {
          tx.update(
            manifestRef,
            sanitizeFirestoreWriteData({
              cleanupClaims: nextClaims,
              updatedAt: FieldValue.serverTimestamp(),
            })
          );
        }
      });
    } catch {
      // Never mask original failure on best-effort lease release
    }
  };

  try {
    if (params.onBetweenClaimAndDeleteHook) {
      await params.onBetweenClaimAndDeleteHook({
        cleanupOperationId,
        cleanupEpoch,
        claimKeys: approvedGroups.map((g) => g.claimKey),
        targetDocumentIds: allTargetDocumentIds,
      });
    }

    // =========================================================================
    // Phase 2: Fenced Batch Delete Transactions (<= 200 delete ops/TX,
    // all manifest + staging + target doc/chunk reads INSIDE the SAME TX!)
    // =========================================================================
    const orderedDeleteEntries: Array<{
      path: string;
      group: CleanupClaimGroupCandidate;
    }> = [];
    const seenDeletePaths = new Set<string>();
    for (const g of approvedGroups) {
      for (const p of [...g.chunkPaths, ...g.docPaths]) {
        if (!seenDeletePaths.has(p)) {
          seenDeletePaths.add(p);
          orderedDeleteEntries.push({ path: p, group: g });
        }
      }
    }

    for (
      let i = 0;
      i < orderedDeleteEntries.length && batchesCommitted < maxBatches;
      i += FIRESTORE_FENCED_CLEANUP_TX_MAX_DELETE_OPS
    ) {
      const nextBatchNum = batchesCommitted + 1;
      if (
        typeof params.simulateDeleteFailureAtBatchNumber === 'number' &&
        nextBatchNum === params.simulateDeleteFailureAtBatchNumber
      ) {
        throw new Error(
          `[CLEANUP_BATCH_DELETE_FAILED] 정리 배치 #${nextBatchNum} 삭제 중 장애 시뮬레이션 (claimOp=${cleanupOperationId})`
        );
      }

      const slice = orderedDeleteEntries.slice(
        i,
        i + FIRESTORE_FENCED_CLEANUP_TX_MAX_DELETE_OPS
      );

      const batchDelCounts = await adminDb.runTransaction(async (tx) => {
        const txM = await tx.get(manifestRef);
        const txStagingByPath = new Map<string, Partial<RagGenerationStagingReceipt> | null>();
        const relevantGroups = Array.from(
          new Set(slice.map((entry) => entry.group))
        );
        for (const g of relevantGroups) {
          if (g.stagingPath && !txStagingByPath.has(g.stagingPath)) {
            const sSnap = await tx.get(adminDb.doc(g.stagingPath));
            txStagingByPath.set(
              g.stagingPath,
              sSnap.exists
                ? (sSnap.data() as Partial<RagGenerationStagingReceipt>)
                : null
            );
          }
        }

        const targetSnaps: any[] = [];
        for (const entry of slice) {
          targetSnaps.push(await tx.get(adminDb.doc(entry.path)));
        }

        const mObj = txM.exists
          ? ((txM.data() || {}) as Partial<FirestoreRagManifestDoc>)
          : {};
        const txActiveDocIds = new Set<string>();
        const txActiveGenByEntity = new Map<string, number>();
        for (const st of Object.values(mObj.entityStates || {})) {
          if (st.ownerId !== params.ownerId || st.projectId !== params.projectId) {
            continue;
          }
          if (st.lifecycleStatus === 'ACTIVE' && st.activeGeneration > 0) {
            txActiveGenByEntity.set(st.entityKey, st.activeGeneration);
            for (const docId of st.activeDocumentIds || []) {
              txActiveDocIds.add(docId);
            }
          }
        }

        const txClaims = { ...(mObj.cleanupClaims || {}) };
        for (const g of relevantGroups) {
          const curClaim = txClaims[g.claimKey];
          if (
            !curClaim ||
            curClaim.status !== 'CLEANUP_PENDING' ||
            curClaim.cleanupOperationId !== cleanupOperationId ||
            curClaim.cleanupEpoch !== cleanupEpoch ||
            curClaim.cleanupOwner !== cleanupOwner
          ) {
            throw new Error(
              `[CLEANUP_OWNERSHIP_LOST] Fenced Delete TX 중 소유권 또는 Epoch(expectedOp=${cleanupOperationId}, expectedEpoch=${cleanupEpoch}, actualOp=${String(
                curClaim?.cleanupOperationId
              )}, actualEpoch=${String(curClaim?.cleanupEpoch)})가 상실되어 삭제를 중단했습니다.`
            );
          }
          if (g.stagingPath) {
            const sData = txStagingByPath.get(g.stagingPath);
            if (
              sData &&
              (sData.status !== 'CLEANUP_PENDING' ||
                (sData.cleanupOperationId &&
                  sData.cleanupOperationId !== cleanupOperationId) ||
                (typeof sData.cleanupEpoch === 'number' &&
                  sData.cleanupEpoch !== cleanupEpoch))
            ) {
              throw new Error(
                `[CLEANUP_OWNERSHIP_LOST] Fenced Delete TX 중 Staging 영수증(${g.stagingPath}) 소유권/상태(${String(
                  sData.status
                )})가 변경되어 삭제를 중단했습니다.`
              );
            }
          }
          if ((txActiveGenByEntity.get(g.entityKey) || 0) === g.generation) {
            throw new Error(
              `[CLEANUP_BLOCKED_ACTIVE_GENERATION] Fenced Delete TX 중 대상 세대(gen=${g.generation})가 활성 세대로 전환되어 삭제를 중단했습니다.`
            );
          }
        }

        let batchDocs = 0;
        let batchChunks = 0;
        const verifiedRefsToDelete: string[] = [];

        for (let idx = 0; idx < slice.length; idx++) {
          const entry = slice[idx];
          const snap = targetSnaps[idx];
          if (!snap || !snap.exists) continue;
          const dData = (snap.data() || {}) as Record<string, unknown>;
          const dGen =
            typeof dData.indexGeneration === 'number'
              ? dData.indexGeneration
              : undefined;
          const isStagedPath = entry.path.endsWith('__staged');
          const isChunkPath = entry.path.startsWith(chunkPrefix);
          const dDocId = isChunkPath
            ? String(dData.documentId || '')
            : String(dData.id || entry.path.slice(docPrefix.length));
          const entityActiveGen =
            txActiveGenByEntity.get(entry.group.entityKey) || 0;
          const isProtectedActiveTarget =
            (!isStagedPath && txActiveDocIds.has(dDocId)) ||
            (entityActiveGen > 0 && dGen === entityActiveGen && !isStagedPath) ||
            (!isStagedPath &&
              entityActiveGen === 0 &&
              dData.isActiveGeneration === true);
          if (
            dData.ownerId !== params.ownerId ||
            dData.projectId !== params.projectId ||
            dData.sourceEntityType !== entry.group.sourceEntityType ||
            dData.sourceEntityId !== entry.group.sourceEntityId ||
            dGen !== entry.group.generation ||
            isProtectedActiveTarget
          ) {
            throw new Error(
              `[CLEANUP_BLOCKED_ACTIVE_GENERATION] Fenced Delete TX에서 문서(${entry.path})의 세대/활성 무결성 검증 실패로 삭제를 중단했습니다.`
            );
          }
          verifiedRefsToDelete.push(entry.path);
          if (entry.path.startsWith(chunkPrefix)) batchChunks += 1;
          else if (entry.path.startsWith(docPrefix)) batchDocs += 1;
        }

        for (const p of verifiedRefsToDelete) {
          tx.delete(adminDb.doc(p));
        }

        // Refresh lease heartbeat atomically inside the Fenced Delete TX
        const hbBaseMs = isTestIsolatedMode ? nowMs : Date.now();
        const hbMs = hbBaseMs + cleanupLeaseDurationMs;
        const hbIso = new Date(hbMs).toISOString();
        for (const g of relevantGroups) {
          const c = txClaims[g.claimKey];
          if (c && c.cleanupOperationId === cleanupOperationId) {
            txClaims[g.claimKey] = {
              ...c,
              cleanupLeaseExpiresAt: hbIso,
              cleanupLeaseExpiresAtMs: hbMs,
            };
          }
        }
        const hbManifestPayload = sanitizeFirestoreWriteData({
          cleanupClaims: txClaims,
          updatedAt: FieldValue.serverTimestamp(),
        });
        if (txM.exists) {
          tx.update(manifestRef, hbManifestPayload);
        } else {
          tx.set(manifestRef, hbManifestPayload, { merge: true });
        }

        return { batchDocs, batchChunks };
      });

      batchesCommitted += 1;
      deletedDocs += batchDelCounts.batchDocs;
      deletedChunks += batchDelCounts.batchChunks;

      if (params.onAfterDeleteBatchHook) {
        await params.onAfterDeleteBatchHook({
          batchesCommitted,
          deletedDocs,
          deletedChunks,
          claimKeys: approvedGroups.map((g) => g.claimKey),
        });
      }
    }

    const completedAllDeleteBatches =
      orderedDeleteEntries.length === 0 ||
      batchesCommitted * FIRESTORE_FENCED_CLEANUP_TX_MAX_DELETE_OPS >=
        orderedDeleteEntries.length;

    if (!completedAllDeleteBatches) {
      await releaseAdminLeaseIfStillOwned();
      for (const g of approvedGroups) {
        pendingResumeClaimKeys.push(g.claimKey);
      }
    } else {
      // =======================================================================
      // Phase 3: Re-verify 0 remaining docs/chunks & Finalize CLEANUP_COMPLETED TX
      // =======================================================================
      const [postDocsSnap, postChunksSnap] = await Promise.all([
        adminDb
          .collection(`${basePath}/memoryDocuments`)
          .where('ownerId', '==', params.ownerId)
          .where('projectId', '==', params.projectId)
          .get(),
        adminDb
          .collection(`${basePath}/memoryChunks`)
          .where('ownerId', '==', params.ownerId)
          .where('projectId', '==', params.projectId)
          .get(),
      ]);

      const remainingClaimKeys = new Set<string>();
      for (const d of postDocsSnap.docs) {
        const dd = (d.data() || {}) as Record<string, unknown>;
        const eKey = `${params.ownerId}:${params.projectId}:${String(
          dd.sourceEntityType || ''
        )}:${String(dd.sourceEntityId || '')}`;
        const dGen = typeof dd.indexGeneration === 'number' ? dd.indexGeneration : 0;
        const docId = String(dd.id || d.id);
        if (!liveActiveDocIdSet.has(docId) || d.id.endsWith('__staged')) {
          remainingClaimKeys.add(makeCleanupClaimKey(eKey, dGen));
        }
      }
      for (const c of postChunksSnap.docs) {
        const cd = (c.data() || {}) as Record<string, unknown>;
        const eKey = `${params.ownerId}:${params.projectId}:${String(
          cd.sourceEntityType || ''
        )}:${String(cd.sourceEntityId || '')}`;
        const cGen = typeof cd.indexGeneration === 'number' ? cd.indexGeneration : 0;
        const pDocId = String(cd.documentId || '');
        if (!liveActiveDocIdSet.has(pDocId) || c.id.endsWith('__staged')) {
          remainingClaimKeys.add(makeCleanupClaimKey(eKey, cGen));
        }
      }

      const readyGroups: CleanupClaimGroupCandidate[] = [];
      for (const g of approvedGroups) {
        if (remainingClaimKeys.has(g.claimKey)) {
          pendingResumeClaimKeys.push(g.claimKey);
        } else {
          readyGroups.push(g);
        }
      }

      if (readyGroups.length > 0) {
        const finalizeRes = await adminDb.runTransaction(async (tx) => {
          const txM = await tx.get(manifestRef);
          const txStagings = new Map<string, boolean>();
          for (const g of readyGroups) {
            if (g.stagingPath) {
              const s = await tx.get(adminDb.doc(g.stagingPath));
              txStagings.set(g.stagingPath, s.exists);
            }
          }

          const curM = txM.exists
            ? ((txM.data() || {}) as Partial<FirestoreRagManifestDoc>)
            : {};
          const nextClaims: Record<string, RagManifestCleanupClaim> = {
            ...(curM.cleanupClaims || {}),
          };
          let nextLedger = curM.retiredGenerationsByEntity
            ? { ...curM.retiredGenerationsByEntity }
            : {};
          const finishIso = new Date().toISOString();
          const completedKeys: string[] = [];
          let removedReceipts = 0;

          for (const g of readyGroups) {
            const curClaim = nextClaims[g.claimKey];
            if (
              !curClaim ||
              curClaim.status !== 'CLEANUP_PENDING' ||
              curClaim.cleanupOperationId !== cleanupOperationId ||
              curClaim.cleanupEpoch !== cleanupEpoch ||
              curClaim.cleanupOwner !== cleanupOwner
            ) {
              throw new Error(
                `[CLEANUP_OWNERSHIP_LOST] Finalize TX에서 Claim(${g.claimKey}) 소유권/Epoch(expectedOp=${cleanupOperationId}, expectedEpoch=${cleanupEpoch}, actualOp=${String(
                  curClaim?.cleanupOperationId
                )}, actualEpoch=${String(curClaim?.cleanupEpoch)})가 상실되었습니다.`
              );
            }

            nextClaims[g.claimKey] = {
              ...curClaim,
              status: 'CLEANUP_COMPLETED',
              completedAt: finishIso,
            };
            nextLedger = recordRetiredGenerationInLedgerMap(
              nextLedger,
              g.entityKey,
              g.generation,
              cleanupEpoch,
              finishIso
            );
            completedKeys.push(g.claimKey);
            if (g.stagingPath && txStagings.get(g.stagingPath)) {
              if (params.retainCompletedReceipts) {
                tx.set(
                  adminDb.doc(g.stagingPath),
                  sanitizeFirestoreWriteData({
                    status: 'CLEANUP_COMPLETED',
                    cleanupCompletedAt: finishIso,
                    deletedDocumentCount: g.docPaths.length,
                    deletedChunkCount: g.chunkPaths.length,
                    updatedAt: finishIso,
                  }),
                  { merge: true }
                );
              } else {
                tx.delete(adminDb.doc(g.stagingPath));
                removedReceipts += 1;
              }
            }
          }

          const prunedFin = pruneManifestCleanupClaims(nextClaims, nextLedger);
          const finManifestPayload = sanitizeFirestoreWriteData({
            cleanupClaims: prunedFin.cleanupClaims,
            retiredGenerationsByEntity: prunedFin.retiredGenerationsByEntity,
            updatedAt: FieldValue.serverTimestamp(),
          });
          if (txM.exists) {
            tx.update(manifestRef, finManifestPayload);
          } else {
            tx.set(manifestRef, finManifestPayload, { merge: true });
          }

          return { completedKeys, removedReceipts };
        });

        completedClaimKeys.push(...finalizeRes.completedKeys);
        deletedStagingReceipts += finalizeRes.removedReceipts;
      }
    }
  } catch (err) {
    if (!params.simulateUncleanCrashLeaveLeaseActive) {
      await releaseAdminLeaseIfStillOwned();
    }
    throw err;
  } finally {
    activeInProcessCleanupOps.delete(cleanupOperationId);
  }

  return {
    deletedDocs,
    deletedChunks,
    deletedStagingReceipts,
    batchesCommitted,
    skippedActiveCount,
    skippedInFlightStagingCount,
    skippedOwnershipConflictCount,
    conflictedClaimKeys,
    cleanupOperationId,
    cleanupEpoch,
    claimedKeys: approvedGroups.map((g) => g.claimKey),
    completedClaimKeys,
    pendingResumeClaimKeys,
  };
}

/**
 * Phase 3 Section 13-2 & 13-4 + Phase 4.2.2 Stage 2.5B/2.5C:
 * Persists staged MemoryDocument and MemoryChunk items to Firestore in multi-batches
 * (<= 450 operations per batch) and then atomically switches the active generation
 * inside a Firestore Transaction (`runTransaction`) after verifying:
 * 1. `ragManifest/control` generation monotonicity & collision safety
 * 2. `ragSyncTasks/{taskId}` Lease Fencing (`verifyRagTaskLeaseFencing`)
 * 3. Authoritative CANON Entity Freshness (`verifyCanonEntityFreshnessForRag`)
 * 4. `ragGenerationStaging/{stagingId}` VERIFIED completeness for large-scale (> 200 ops)
 * 5. Project ownership & lifecycle state
 * 6. Post-activation durable persistence verification
 * Never marks `synced: true` when Firestore write or transaction fails!
 */
async function syncDocsAndChunksAtomicallyToFirestore(params: {
  ownerId: string;
  projectId: string;
  documents: MemoryDocument[];
  chunks: MemoryChunk[];
  entityState?: EntityIndexLifecycleState;
  stagingId?: string;
  simulateStagingVerificationFailure?: boolean;
  onAfterStagingInitReadBeforeWriteHook?: (ctx: {
    generation: number;
    stagingId?: string;
    status?: RagGenerationStagingStatus;
  }) => Promise<void> | void;
  onDuringStagingHook?: (ctx: {
    generation: number;
    stagingId?: string;
    largeScaleGenerationMode: boolean;
  }) => Promise<void> | void;
  onBetweenStageAAndBHook?: (ctx: {
    generation: number;
    stagingId?: string;
    largeScaleGenerationMode: boolean;
  }) => Promise<void> | void;
  authorConfirmedProductionBulkWrite?: boolean;
  durableCommitPolicy?: DurableRagCommitPolicy;
  activationGuard?: AtomicRagActivationGuardContext;
  db?: Firestore;
}): Promise<{
  synced: boolean;
  batchesCommitted: number;
  durableCommitVerified: boolean;
  activeGenerationVerified: boolean;
  stagingId?: string;
  error?: string;
}> {
  const hasInjectedDb = Boolean(params.db);
  const requireDurableVerification = Boolean(
    params.durableCommitPolicy?.requireDurableCloudCommit ||
      params.durableCommitPolicy?.requireActiveGenerationVerification ||
      params.activationGuard
  );

  const totalWriteOps = params.documents.length + params.chunks.length;
  const generation =
    params.entityState?.activeGeneration ??
    params.documents[0]?.indexGeneration ??
    1;
  const isLargeScale =
    totalWriteOps > LARGE_SCALE_RAG_TX_OP_THRESHOLD ||
    params.entityState?.activationMode === 'MANIFEST_POINTER' ||
    params.documents.some((d) => d.activationMode === 'MANIFEST_POINTER');
  const resolvedStagingId =
    params.stagingId ||
    params.entityState?.stagingId ||
    params.documents[0]?.stagingId ||
    (isLargeScale && params.entityState
      ? buildRagStagingReceiptId({
          projectId: params.projectId,
          sourceEntityType: params.entityState.sourceEntityType,
          sourceEntityId: params.entityState.sourceEntityId,
          generation,
        })
      : undefined);

  if (!hasInjectedDb && activeMockFirestoreBackend) {
    try {
      const prevSimVerifyFail =
        activeMockFirestoreBackend.simulateStagingVerificationFailure;
      if (params.simulateStagingVerificationFailure) {
        activeMockFirestoreBackend.simulateStagingVerificationFailure = true;
      }
      let batchRes: { batchesCommitted: number; totalOpsWritten: number };
      try {
        batchRes =
          await activeMockFirestoreBackend.writeStagedDocsAndChunksInBatches({
            ownerId: params.ownerId,
            projectId: params.projectId,
            documents: params.documents,
            chunks: params.chunks,
            generation,
            largeScaleGenerationMode: isLargeScale,
            stagingId: resolvedStagingId,
            entityState: params.entityState,
            onAfterStagingInitReadBeforeWriteHook:
              params.onAfterStagingInitReadBeforeWriteHook,
            onDuringStagingHook: params.onDuringStagingHook,
          });
      } finally {
        activeMockFirestoreBackend.simulateStagingVerificationFailure =
          prevSimVerifyFail;
      }

      if (params.onBetweenStageAAndBHook) {
        await params.onBetweenStageAAndBHook({
          generation,
          stagingId: resolvedStagingId,
          largeScaleGenerationMode: isLargeScale,
        });
      }

      if (params.entityState) {
        await activeMockFirestoreBackend.commitActiveGenerationTransaction({
          ownerId: params.ownerId,
          projectId: params.projectId,
          entityState: params.entityState,
          largeScaleGenerationMode: isLargeScale,
          stagingId: resolvedStagingId,
          expectedChunkCount: params.chunks.length,
        });
      }

      if (requireDurableVerification && params.documents[0]) {
        const basePath = `users/${params.ownerId}/projects/${params.projectId}`;
        const primaryDoc = params.documents[0];
        const persistedDoc = activeMockFirestoreBackend.documentsByPath.get(
          `${basePath}/memoryDocuments/${primaryDoc.id}`
        );
        if (!persistedDoc) {
          throw new Error(
            `[RAG_INDEX_DOCUMENT_NOT_FOUND] [FIRESTORE_DURABILITY_NOT_VERIFIED] Mock Firestore에 색인 문서(${primaryDoc.id})가 존재하지 않습니다.`
          );
        }
        if (
          persistedDoc.isActiveGeneration === false ||
          persistedDoc.indexStatus !== 'INDEXED'
        ) {
          throw new Error(
            `[FIRESTORE_DURABILITY_NOT_VERIFIED] 색인 문서(${primaryDoc.id})가 활성 상태로 전환되지 않았습니다.`
          );
        }
        if (params.entityState) {
          const manifest = activeMockFirestoreBackend.getManifest(
            params.ownerId,
            params.projectId
          );
          const mState = manifest?.entityStates?.[params.entityState.entityKey];
          if (
            !mState ||
            mState.activeGeneration !== params.entityState.activeGeneration ||
            persistedDoc.indexGeneration !== params.entityState.activeGeneration ||
            !Array.isArray(mState.activeDocumentIds) ||
            !mState.activeDocumentIds.includes(primaryDoc.id)
          ) {
            throw new Error(
              `[RAG_ACTIVE_GENERATION_MISMATCH] [FIRESTORE_DURABILITY_NOT_VERIFIED] 활성 세대(gen=${params.entityState.activeGeneration})와 저장된 매니페스트/문서 세대가 일치하지 않습니다.`
            );
          }
          if (isLargeScale && resolvedStagingId) {
            const receipt = activeMockFirestoreBackend.stagingReceiptsByPath.get(
              `${basePath}/ragGenerationStaging/${resolvedStagingId}`
            );
            if (!receipt || receipt.status !== 'ACTIVATED') {
              throw new Error(
                `[FIRESTORE_DURABILITY_NOT_VERIFIED] 대량 색인 스테이징 영수증(${resolvedStagingId})이 ACTIVATED 상태가 아닙니다.`
              );
            }
          }
        }
      }

      return {
        synced: true,
        batchesCommitted: batchRes.batchesCommitted,
        durableCommitVerified: true,
        activeGenerationVerified: true,
        stagingId: resolvedStagingId,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(msg);
    }
  }

  const containsTestVectors =
    params.documents.some(
      (d) =>
        d.embeddingGenerationMode === 'DETERMINISTIC_TEST' ||
        d.embeddingModelId === DETERMINISTIC_TEST_EMBEDDING_MODEL_ID
    ) ||
    params.chunks.some(
      (c) =>
        c.embeddingGenerationMode === 'DETERMINISTIC_TEST' ||
        c.embeddingModelId === DETERMINISTIC_TEST_EMBEDDING_MODEL_ID
    );
  if (!hasInjectedDb && containsTestVectors) {
    return {
      synced: false,
      batchesCommitted: 0,
      durableCommitVerified: false,
      activeGenerationVerified: false,
      error:
        'DETERMINISTIC_TEST_VECTOR_BLOCKED: 테스트용 결정적 임베딩 벡터(DETERMINISTIC_TEST)는 실제 클라우드 Firestore에 영구 저장할 수 없습니다.',
    };
  }

  if (
    totalWriteOps >= BULK_PRODUCTION_WRITE_CHUNK_THRESHOLD &&
    !params.authorConfirmedProductionBulkWrite
  ) {
    return {
      synced: false,
      batchesCommitted: 0,
      durableCommitVerified: false,
      activeGenerationVerified: false,
      error: `PRODUCTION_BULK_WRITE_GUARD: ${totalWriteOps}개 대규모 쓰기는 사용자 승인(authorConfirmedProductionBulkWrite) 전까지 클라우드 Firestore 쓰기가 자동 차단됩니다.`,
    };
  }

  const adminDb = resolveRagFirestore({ db: params.db });
  if (!adminDb || params.ownerId === 'local_author') {
    if (requireDurableVerification) {
      return {
        synced: false,
        batchesCommitted: 0,
        durableCommitVerified: false,
        activeGenerationVerified: false,
        error:
          '[FIRESTORE_DURABILITY_NOT_VERIFIED] 영구 Firestore 데이터베이스 연결이 구성되지 않았거나 로컬 전용 계정이어서 RAG 영구 색인을 커밋할 수 없습니다.',
      };
    }
    return {
      synced: false,
      batchesCommitted: 0,
      durableCommitVerified: false,
      activeGenerationVerified: false,
    };
  }

  const basePath = `users/${params.ownerId}/projects/${params.projectId}`;
  const stagingRef =
    isLargeScale && resolvedStagingId
      ? adminDb.doc(`${basePath}/ragGenerationStaging/${resolvedStagingId}`)
      : null;

  const markStagingAbortedBestEffort = async (reason: string) => {
    if (!stagingRef) return;
    try {
      await adminDb.runTransaction(async (tx) => {
        const curSnap = await tx.get(stagingRef);
        const curStatus = curSnap.exists
          ? ((curSnap.data()?.status as RagGenerationStagingStatus | undefined) ??
            undefined)
          : undefined;
        if (
          curStatus === 'ACTIVATED' ||
          curStatus === 'CLEANUP_PENDING' ||
          curStatus === 'CLEANUP_COMPLETED'
        ) {
          return;
        }
        tx.set(
          stagingRef,
          sanitizeFirestoreWriteData({
            status: 'ABORTED',
            errorMessage: reason.slice(0, 800),
            updatedAt: new Date().toISOString(),
          }),
          { merge: true }
        );
      });
    } catch {
      // Best-effort abort tracking must never mask original failure
    }
  };

  try {
    const projectDocSnap = await adminDb.doc(basePath).get();
    if (projectDocSnap.exists) {
      const pData = projectDocSnap.data();
      if (pData?.ownerId && pData.ownerId !== params.ownerId) {
        throw new Error(
          `권한 거부(403 - FIRESTORE_PROJECT_OWNER_MISMATCH): 프로젝트('${params.projectId}')의 Firestore 소유자와 일치하지 않습니다.`
        );
      }
      if (
        pData?.lifecycleStatus === 'PENDING_DELETE' ||
        pData?.lifecycleStatus === 'DELETED'
      ) {
        throw new Error(
          `[ENTITY_OR_PROJECT_DELETED] [FIRESTORE_MANIFEST_ACTIVATION_FAILED] 삭제된 프로젝트('${params.projectId}')에는 색인을 생성할 수 없습니다.`
        );
      }
    } else if (hasInjectedDb || requireDurableVerification) {
      throw new Error(
        `권한 거부(403 - FIRESTORE_PROJECT_NOT_FOUND_IN_INJECTED_DB): 대상 Firestore에 프로젝트 문서('${basePath}')가 존재하지 않습니다.`
      );
    }

    // Active-generation overwrite, Retired-generation replay, & Cleanup Claim collision guard
    const manifestControlRef = adminDb.doc(`${basePath}/ragManifest/control`);
    if (params.entityState) {
      const preManifestSnap = await manifestControlRef.get();
      if (preManifestSnap.exists) {
        const preManifestData = (preManifestSnap.data() ||
          {}) as Partial<FirestoreRagManifestDoc>;
        const preCleanupClaims = preManifestData.cleanupClaims || {};
        const preClaimKey = makeCleanupClaimKey(
          params.entityState.entityKey,
          generation
        );
        const preClaim = preCleanupClaims[preClaimKey];
        if (
          preClaim?.status === 'CLEANUP_PENDING' ||
          preClaim?.status === 'CLEANUP_COMPLETED' ||
          isGenerationRetiredInManifest(
            preManifestData,
            params.entityState.entityKey,
            generation
          )
        ) {
          throw new Error(
            `[ACTIVATION_BLOCKED_BY_CLEANUP] [RAG_INDEX_ACTIVATION_CONFLICT] 정리(Cleanup)가 이미 선점 또는 완료한 세대(gen=${generation}, claimOp=${String(
              preClaim?.cleanupOperationId || 'retired'
            )})에는 스테이징을 시작할 수 없습니다.`
          );
        }
        if (isLargeScale) {
          const preEntityStates = preManifestData.entityStates || {};
          const currentEntityManifest =
            preEntityStates[params.entityState.entityKey];
          if (
            currentEntityManifest &&
            currentEntityManifest.activeGeneration !== generation
          ) {
            if (currentEntityManifest.activeGeneration > generation) {
              throw new Error(
                `[RAG_INDEX_ACTIVATION_CONFLICT] 더 최신 활성 세대(gen=${currentEntityManifest.activeGeneration})가 존재하므로 구세대(gen=${generation}) 스테이징을 시작할 수 없습니다.`
              );
            }
            const activeDocSet = new Set(
              currentEntityManifest.activeDocumentIds || []
            );
            for (const docItem of params.documents) {
              if (activeDocSet.has(docItem.id)) {
                throw new Error(
                  `[RAG_INDEX_ACTIVATION_CONFLICT] [ACTIVE_GENERATION_OVERWRITE_BLOCKED] 대량 색인 스테이징 중 기존 활성 세대 문서(${docItem.id}) 경로로의 직접 덮어쓰기가 차단되었습니다.`
                );
              }
            }
          }
        }
      }
    }

    // P0-A: Create/Update durable PREPARING staging receipt INSIDE an atomic Firestore Transaction
    // (ALL tx.get BEFORE tx.set; zero read-then-set TOCTOU race!)
    if (stagingRef && params.documents[0]) {
      const firstDoc = params.documents[0];
      const entityKeyForStaging =
        params.entityState?.entityKey ||
        `${params.ownerId}:${params.projectId}:${firstDoc.sourceEntityType}:${firstDoc.sourceEntityId}`;

      if (params.onAfterStagingInitReadBeforeWriteHook) {
        const preHookSnap = await stagingRef.get();
        const preHookStatus = preHookSnap.exists
          ? ((preHookSnap.data() as Partial<RagGenerationStagingReceipt>)
              .status as RagGenerationStagingStatus | undefined)
          : undefined;
        await params.onAfterStagingInitReadBeforeWriteHook({
          generation,
          stagingId: resolvedStagingId,
          status: preHookStatus,
        });
      }

      const leasedTaskForStaging = params.activationGuard?.leasedTask;
      const taskRefForStaging = leasedTaskForStaging
        ? adminDb.doc(`${basePath}/ragSyncTasks/${leasedTaskForStaging.id}`)
        : null;

      await adminDb.runTransaction(async (tx) => {
        const [txManifestSnap, txStagingSnap, txTaskSnap] = await Promise.all([
          tx.get(manifestControlRef),
          tx.get(stagingRef),
          taskRefForStaging ? tx.get(taskRefForStaging) : Promise.resolve(null),
        ]);

        const mData = txManifestSnap.exists
          ? ((txManifestSnap.data() || {}) as Partial<FirestoreRagManifestDoc>)
          : {};
        const claimKey = makeCleanupClaimKey(entityKeyForStaging, generation);
        const liveClaim = mData.cleanupClaims?.[claimKey];
        const existingReceipt = txStagingSnap.exists
          ? (txStagingSnap.data() as Partial<RagGenerationStagingReceipt>)
          : undefined;

        if (
          liveClaim?.status === 'CLEANUP_PENDING' ||
          liveClaim?.status === 'CLEANUP_COMPLETED' ||
          existingReceipt?.status === 'CLEANUP_PENDING' ||
          existingReceipt?.status === 'CLEANUP_COMPLETED' ||
          isGenerationRetiredInManifest(mData, entityKeyForStaging, generation)
        ) {
          throw new Error(
            `[ACTIVATION_BLOCKED_BY_CLEANUP] [RAG_INDEX_ACTIVATION_CONFLICT] 정리(Cleanup)가 이미 선점 또는 완료한 세대(${resolvedStagingId}, status=${String(
              existingReceipt?.status || liveClaim?.status || 'RETIRED'
            )})에는 스테이징을 기록할 수 없습니다.`
          );
        }

        if (existingReceipt?.status === 'ACTIVATED') {
          throw new Error(
            `[RAG_INDEX_ACTIVATION_CONFLICT] [STAGING_ALREADY_ACTIVATED] 이미 ACTIVATED 상태인 스테이징 영수증(${resolvedStagingId})을 PREPARING으로 되돌릴 수 없습니다.`
          );
        }

        if (existingReceipt?.status === 'ABORTED') {
          throw new Error(
            `[RAG_INDEX_ACTIVATION_CONFLICT] [STAGING_ABORTED_CANNOT_REENTER] 이미 ABORTED 상태인 세대(gen=${generation})의 스테이징 영수증(${resolvedStagingId})은 PREPARING으로 재진입할 수 없습니다.`
          );
        }

        if (existingReceipt?.status === 'VERIFIED') {
          const sameToken =
            (!existingReceipt.activationToken ||
              !params.entityState?.activationToken ||
              existingReceipt.activationToken ===
                params.entityState.activationToken) &&
            (!existingReceipt.targetTaskId ||
              !params.entityState?.activeTaskId ||
              existingReceipt.targetTaskId ===
                params.entityState.activeTaskId) &&
            existingReceipt.expectedContentHash ===
              (firstDoc.contentHash || '') &&
            existingReceipt.expectedDocumentCount === params.documents.length &&
            existingReceipt.expectedChunkCount === params.chunks.length;
          if (!sameToken) {
            throw new Error(
              `[RAG_INDEX_ACTIVATION_CONFLICT] [STAGING_VERIFIED_TOKEN_MISMATCH] 다른 작업/토큰으로 VERIFIED 상태의 스테이징 영수증(${resolvedStagingId})을 PREPARING으로 덮어쓸 수 없습니다.`
            );
          }
          // Preserve VERIFIED idempotently for the exact same token/hash/counts
          return;
        }

        const currentEntityManifest = mData.entityStates?.[entityKeyForStaging];
        if (currentEntityManifest) {
          if (
            (currentEntityManifest.lifecycleStatus === 'PENDING_DELETE' ||
              currentEntityManifest.lifecycleStatus === 'DELETED') &&
            generation <= currentEntityManifest.deletionTombstoneGeneration
          ) {
            throw new Error(
              `[RAG_INDEX_ACTIVATION_CONFLICT] 삭제된 항목에 대해 이전 색인(gen=${generation}) 스테이징을 시작할 수 없습니다.`
            );
          }
          if (currentEntityManifest.activeGeneration > generation) {
            throw new Error(
              `[RAG_INDEX_ACTIVATION_CONFLICT] 더 최신 활성 세대(gen=${currentEntityManifest.activeGeneration})가 이미 존재하여 구세대(gen=${generation}) 스테이징이 차단되었습니다.`
            );
          }
        }

        if (leasedTaskForStaging && txTaskSnap) {
          const currentTask = txTaskSnap.exists
            ? normalizeRagSyncTaskForActivationTx(
                (txTaskSnap.data() || {}) as Record<string, unknown>,
                leasedTaskForStaging.id
              )
            : null;
          const fencing = verifyRagTaskLeaseFencing({
            currentTask,
            leasedTask: leasedTaskForStaging,
          });
          if (!fencing.ok) {
            throw new Error(
              `[${fencing.reason}] [RAG_INDEX_ACTIVATION_CONFLICT] ${fencing.message}`
            );
          }
        }

        const nowIso = new Date().toISOString();
        const initialReceipt: RagGenerationStagingReceipt = sanitizeFirestoreWriteData({
          id: resolvedStagingId!,
          ownerId: params.ownerId,
          projectId: params.projectId,
          entityKey: entityKeyForStaging,
          sourceEntityType: firstDoc.sourceEntityType,
          sourceEntityId: firstDoc.sourceEntityId,
          generation,
          activationMode: 'MANIFEST_POINTER',
          status: 'PREPARING',
          expectedDocumentIds: params.documents.map((d) => d.id),
          expectedDocumentCount: params.documents.length,
          expectedChunkCount: params.chunks.length,
          expectedContentHash: firstDoc.contentHash || '',
          expectedSourceRevisionId: firstDoc.sourceRevisionId || '',
          stagedDocumentCount: 0,
          stagedChunkCount: 0,
          verifiedDocumentCount: 0,
          verifiedChunkCount: 0,
          batchesCommitted: 0,
          ...(params.entityState?.activeTaskId
            ? { targetTaskId: params.entityState.activeTaskId }
            : {}),
          ...(typeof params.entityState?.activeLeaseGeneration === 'number'
            ? { targetLeaseGeneration: params.entityState.activeLeaseGeneration }
            : {}),
          ...(params.entityState?.activationToken
            ? { activationToken: params.entityState.activationToken }
            : {}),
          createdAt: existingReceipt?.createdAt || nowIso,
          updatedAt: nowIso,
        });
        tx.set(stagingRef, sanitizeFirestoreWriteData(initialReceipt), {
          merge: true,
        });
      });
    }

    // For <= 200 ops Option A hybrid: check whether active doc exists at canonical ID so we stage to __staged
    let hasExistingActiveDoc = false;
    let existingOldChunkCount = 0;
    if (!isLargeScale && params.documents.length > 0) {
      const firstDocSnap = await adminDb
        .doc(`${basePath}/memoryDocuments/${params.documents[0].id}`)
        .get();
      if (firstDocSnap.exists) {
        const firstDocData = firstDocSnap.data() || {};
        if (
          firstDocData.isActiveGeneration !== false &&
          firstDocData.indexStatus === 'INDEXED'
        ) {
          hasExistingActiveDoc = true;
          existingOldChunkCount = Number(firstDocData.chunkCount || 0);
        }
      }
    }

    const canPromoteInsideTransaction =
      !isLargeScale &&
      Boolean(params.entityState) &&
      totalWriteOps <= LARGE_SCALE_RAG_TX_OP_THRESHOLD;

    const allStagingOps: {
      refPath: string;
      payload: Record<string, unknown>;
    }[] = [];

    for (const docItem of params.documents) {
      const stagedDocPath =
        hasExistingActiveDoc && canPromoteInsideTransaction
          ? `${basePath}/memoryDocuments/${docItem.id}__staged`
          : `${basePath}/memoryDocuments/${docItem.id}`;
      const isInactiveStaged = canPromoteInsideTransaction || isLargeScale;
      allStagingOps.push({
        refPath: stagedDocPath,
        payload: sanitizeFirestoreWriteData({
          ...docItem,
          documentId: docItem.id,
          indexGeneration: generation,
          isActiveGeneration: !isInactiveStaged,
          activationMode: isLargeScale ? 'MANIFEST_POINTER' : 'INLINE_DOC',
          ...(resolvedStagingId ? { stagingId: resolvedStagingId } : {}),
          indexStatus: isInactiveStaged ? 'INDEXING' : 'INDEXED',
          lifecycleStatus: isInactiveStaged ? 'REINDEXING_KEEP_OLD' : 'ACTIVE',
          updatedAt: FieldValue.serverTimestamp(),
        }),
      });
    }

    for (const chk of params.chunks) {
      const stagedChkPath =
        hasExistingActiveDoc && canPromoteInsideTransaction
          ? `${basePath}/memoryChunks/${chk.id}__staged`
          : `${basePath}/memoryChunks/${chk.id}`;
      const isInactiveStaged = canPromoteInsideTransaction || isLargeScale;
      const payload: Record<string, unknown> = sanitizeFirestoreWriteData({
        ...chk,
        chunkId: chk.id,
        originalText: chk.content,
        indexGeneration: generation,
        isActiveGeneration: !isInactiveStaged,
        activationMode: isLargeScale ? 'MANIFEST_POINTER' : 'INLINE_DOC',
        ...(resolvedStagingId ? { stagingId: resolvedStagingId } : {}),
        lifecycleStatus: isInactiveStaged ? 'REINDEXING_KEEP_OLD' : 'ACTIVE',
      });
      if (Array.isArray(chk.embedding) && chk.embedding.length > 0) {
        payload.embeddingVector = FieldValue.vector(chk.embedding);
      }
      allStagingOps.push({
        refPath: stagedChkPath,
        payload,
      });
    }

    let batchesCommitted = 0;
    for (let i = 0; i < allStagingOps.length; i += FIRESTORE_MAX_BATCH_OPS) {
      const slice = allStagingOps.slice(i, i + FIRESTORE_MAX_BATCH_OPS);
      if (slice.length > 500) {
        throw new Error(
          `[FIRESTORE_BATCH_COMMIT_FAILED] FIRESTORE_BATCH_LIMIT_EXCEEDED: 단일 WriteBatch 작업 수(${slice.length})가 Firestore 제한(500개)을 초과했습니다.`
        );
      }
      const batch = adminDb.batch();
      for (const op of slice) {
        batch.set(
          adminDb.doc(op.refPath),
          sanitizeFirestoreWriteData(op.payload),
          { merge: true }
        );
      }
      try {
        await batch.commit();
      } catch (batchErr) {
        const batchMsg =
          batchErr instanceof Error ? batchErr.message : String(batchErr);
        await markStagingAbortedBestEffort(batchMsg);
        throw new Error(
          `[FIRESTORE_BATCH_COMMIT_FAILED] [FIRESTORE_WRITE_FAILED] 배치 #${batchesCommitted + 1} 영구 저장 실패: ${batchMsg}`
        );
      }
      batchesCommitted += 1;
    }

    // Allow Stage A concurrent search / mid-flight inspection BEFORE receipt verification or Stage B activation
    if (params.onDuringStagingHook) {
      await params.onDuringStagingHook({
        generation,
        stagingId: resolvedStagingId,
        largeScaleGenerationMode: isLargeScale,
      });
    }

    // Large-Scale Stage A Durability & Completeness Verification before Stage B Activation Transaction
    if (isLargeScale && stagingRef) {
      await adminDb.runTransaction(async (tx) => {
        const [curSnap, curManifestSnap] = await Promise.all([
          tx.get(stagingRef),
          tx.get(manifestControlRef),
        ]);
        const curData = curSnap.exists
          ? (curSnap.data() as Partial<RagGenerationStagingReceipt>)
          : undefined;
        const mObj = curManifestSnap.exists
          ? ((curManifestSnap.data() || {}) as Partial<FirestoreRagManifestDoc>)
          : {};
        const eKey =
          curData?.entityKey ||
          params.entityState?.entityKey ||
          (params.documents[0]
            ? `${params.ownerId}:${params.projectId}:${params.documents[0].sourceEntityType}:${params.documents[0].sourceEntityId}`
            : '');
        const cKey = makeCleanupClaimKey(eKey, generation);
        const cClaim = mObj.cleanupClaims?.[cKey];
        if (
          curData?.status === 'CLEANUP_PENDING' ||
          curData?.status === 'CLEANUP_COMPLETED' ||
          curData?.status === 'ACTIVATED' ||
          curData?.status === 'ABORTED' ||
          cClaim?.status === 'CLEANUP_PENDING' ||
          cClaim?.status === 'CLEANUP_COMPLETED' ||
          isGenerationRetiredInManifest(mObj, eKey, generation)
        ) {
          throw new Error(
            `[ACTIVATION_BLOCKED_BY_CLEANUP] [RAG_INDEX_ACTIVATION_CONFLICT] 정리(Cleanup)가 이미 선점/완료했거나 종료된 세대(gen=${generation}, stagingId=${resolvedStagingId})는 STAGED 상태로 전환할 수 없습니다.`
          );
        }
        tx.set(
          stagingRef,
          sanitizeFirestoreWriteData({
            status: 'STAGED',
            stagedDocumentCount: params.documents.length,
            stagedChunkCount: params.chunks.length,
            batchesCommitted,
            updatedAt: new Date().toISOString(),
          }),
          { merge: true }
        );
      });

      if (params.simulateStagingVerificationFailure) {
        const failErr =
          '[STAGING_VERIFICATION_INCOMPLETE] 대량 색인 스테이징 완료 검증 실패(강제 시뮬레이션)';
        await markStagingAbortedBestEffort(failErr);
        throw new Error(failErr);
      }

      const docRefs = params.documents.map((d) =>
        adminDb.doc(`${basePath}/memoryDocuments/${d.id}`)
      );
      let verifiedDocs = 0;
      const docSnaps =
        docRefs.length > 0 ? await adminDb.getAll(...docRefs) : [];
      for (let idx = 0; idx < params.documents.length; idx++) {
        const expectedDoc = params.documents[idx];
        const dSnap = docSnaps[idx];
        if (!dSnap || !dSnap.exists) continue;
        const dData = dSnap.data() || {};
        if (
          dData.indexGeneration === generation &&
          dData.contentHash === expectedDoc.contentHash &&
          dData.sourceRevisionId === expectedDoc.sourceRevisionId &&
          dData.chunkCount === expectedDoc.chunkCount
        ) {
          verifiedDocs += 1;
        }
      }

      const expectedChunksByDocId = new Map<string, Map<string, MemoryChunk>>();
      for (const chk of params.chunks) {
        let docMap = expectedChunksByDocId.get(chk.documentId);
        if (!docMap) {
          docMap = new Map<string, MemoryChunk>();
          expectedChunksByDocId.set(chk.documentId, docMap);
        }
        docMap.set(chk.id, chk);
      }

      let verifiedChunks = 0;
      const verifiedChunkIds = new Set<string>();
      for (const expectedDoc of params.documents) {
        const expectedMap = expectedChunksByDocId.get(expectedDoc.id);
        const baseChunkQuery = adminDb
          .collection(`${basePath}/memoryChunks`)
          .where('documentId', '==', expectedDoc.id);
        const selectable = baseChunkQuery as unknown as {
          select?: (...fields: string[]) => typeof baseChunkQuery;
        };
        const cSnap =
          typeof selectable.select === 'function'
            ? await selectable
                .select(
                  'id',
                  'chunkId',
                  'chunkIndex',
                  'documentId',
                  'indexGeneration',
                  'sourceRevisionId',
                  'sourceStartOffset',
                  'sourceEndOffset',
                  'contentHash',
                  'embeddingDimension',
                  'embeddingModelId',
                  'stagingId'
                )
                .get()
            : await baseChunkQuery.get();
        let matchingInPart = 0;
        for (const cs of cSnap.docs) {
          const cd = cs.data() || {};
          const cid = String(cd.id || cd.chunkId || cs.id);
          const expChk = expectedMap?.get(cid);
          if (!expChk || verifiedChunkIds.has(cid)) continue;
          if (
            cd.indexGeneration === generation &&
            cd.documentId === expChk.documentId &&
            cd.chunkIndex === expChk.chunkIndex &&
            cd.sourceRevisionId === expChk.sourceRevisionId &&
            typeof cd.sourceStartOffset === 'number' &&
            cd.sourceStartOffset === expChk.sourceStartOffset &&
            typeof cd.sourceEndOffset === 'number' &&
            cd.sourceEndOffset === expChk.sourceEndOffset &&
            typeof cd.contentHash === 'string' &&
            cd.contentHash.length > 0 &&
            cd.contentHash === expChk.contentHash &&
            cd.embeddingDimension === expChk.embeddingDimension &&
            cd.embeddingModelId === expChk.embeddingModelId &&
            (!resolvedStagingId ||
              cd.stagingId === undefined ||
              cd.stagingId === resolvedStagingId)
          ) {
            verifiedChunkIds.add(cid);
            matchingInPart += 1;
          }
        }
        if (matchingInPart === expectedDoc.chunkCount) {
          verifiedChunks += matchingInPart;
        }
      }

      if (
        verifiedDocs !== params.documents.length ||
        verifiedChunks !== params.chunks.length ||
        verifiedChunkIds.size !== params.chunks.length
      ) {
        const failErr = `[STAGING_VERIFICATION_INCOMPLETE] 대량 색인 스테이징 무결성 검증 실패 (docs=${verifiedDocs}/${params.documents.length}, chunks=${verifiedChunks}/${params.chunks.length}, uniqueIds=${verifiedChunkIds.size}/${params.chunks.length}).`;
        await markStagingAbortedBestEffort(failErr);
        throw new Error(failErr);
      }

      await adminDb.runTransaction(async (tx) => {
        const [curSnap, curManifestSnap] = await Promise.all([
          tx.get(stagingRef),
          tx.get(manifestControlRef),
        ]);
        const curData = curSnap.exists
          ? (curSnap.data() as Partial<RagGenerationStagingReceipt>)
          : undefined;
        const mObj = curManifestSnap.exists
          ? ((curManifestSnap.data() || {}) as Partial<FirestoreRagManifestDoc>)
          : {};
        const eKey =
          curData?.entityKey ||
          params.entityState?.entityKey ||
          (params.documents[0]
            ? `${params.ownerId}:${params.projectId}:${params.documents[0].sourceEntityType}:${params.documents[0].sourceEntityId}`
            : '');
        const cKey = makeCleanupClaimKey(eKey, generation);
        const cClaim = mObj.cleanupClaims?.[cKey];
        if (
          curData?.status === 'CLEANUP_PENDING' ||
          curData?.status === 'CLEANUP_COMPLETED' ||
          curData?.status === 'ACTIVATED' ||
          curData?.status === 'ABORTED' ||
          cClaim?.status === 'CLEANUP_PENDING' ||
          cClaim?.status === 'CLEANUP_COMPLETED' ||
          isGenerationRetiredInManifest(mObj, eKey, generation)
        ) {
          throw new Error(
            `[ACTIVATION_BLOCKED_BY_CLEANUP] [RAG_INDEX_ACTIVATION_CONFLICT] 정리(Cleanup)가 이미 선점/완료했거나 종료된 세대(gen=${generation}, stagingId=${resolvedStagingId})는 VERIFIED 상태로 전환할 수 없습니다.`
          );
        }
        tx.set(
          stagingRef,
          sanitizeFirestoreWriteData({
            status: 'VERIFIED',
            verifiedDocumentCount: verifiedDocs,
            verifiedChunkCount: verifiedChunks,
            verifiedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
          { merge: true }
        );
      });
    }

    if (params.onBetweenStageAAndBHook) {
      await params.onBetweenStageAAndBHook({
        generation,
        stagingId: resolvedStagingId,
        largeScaleGenerationMode: isLargeScale,
      });
    }

    if (params.entityState) {
      const manifestRef = adminDb.doc(`${basePath}/ragManifest/control`);
      const projectRef = adminDb.doc(basePath);
      const nextState: EntityIndexLifecycleState = sanitizeFirestoreWriteData({
        ...params.entityState,
        activationMode: isLargeScale ? 'MANIFEST_POINTER' : 'INLINE_DOC',
        ...(resolvedStagingId ? { stagingId: resolvedStagingId } : {}),
      });
      const leasedTask = params.activationGuard?.leasedTask;

      try {
        await adminDb.runTransaction(async (tx) => {
          // ====================================================================
          // Section 4.4 Mandatory Transaction Read Order (ALL tx.get BEFORE tx.set)
          // 1. READ MANIFEST
          // 2. READ RAG TASK & CANON ENTITY (when leasedTask is present)
          // 3. READ PROJECT STATE
          // 4. READ STAGING RECEIPT (when largeScaleGenerationMode is true)
          // ====================================================================
          const snap = await tx.get(manifestRef);

          let taskSnap: any = null;
          let entitySnap: any = null;
          if (leasedTask) {
            const taskRef = adminDb.doc(
              `${basePath}/ragSyncTasks/${leasedTask.id}`
            );
            const targetSubpath =
              leasedTask.targetEntityType === 'RELATIONSHIP'
                ? 'relationships'
                : leasedTask.targetEntityType === 'TIMELINE_EVENT'
                ? 'timelineEvents'
                : 'foreshadowings';
            const entityRef = adminDb.doc(
              `${basePath}/${targetSubpath}/${leasedTask.targetEntityId}`
            );
            taskSnap = await tx.get(taskRef);
            entitySnap = await tx.get(entityRef);
          }

          const txProjectSnap = await tx.get(projectRef);
          const txStagingSnap = stagingRef ? await tx.get(stagingRef) : null;

          if (
            (hasInjectedDb || requireDurableVerification) &&
            !txProjectSnap.exists
          ) {
            throw new Error(
              `[ENTITY_OR_PROJECT_DELETED] [FIRESTORE_MANIFEST_ACTIVATION_FAILED] 프로젝트 문서('${basePath}')가 삭제되었거나 존재하지 않습니다.`
            );
          }
          if (txProjectSnap.exists) {
            const pData = txProjectSnap.data() || {};
            if (pData.ownerId && pData.ownerId !== params.ownerId) {
              throw new Error(
                `권한 거부(403 - FIRESTORE_PROJECT_OWNER_MISMATCH): 프로젝트 소유자가 일치하지 않습니다.`
              );
            }
            if (
              pData.lifecycleStatus === 'PENDING_DELETE' ||
              pData.lifecycleStatus === 'DELETED'
            ) {
              throw new Error(
                `[ENTITY_OR_PROJECT_DELETED] [FIRESTORE_MANIFEST_ACTIVATION_FAILED] 삭제 진행 중이거나 삭제된 프로젝트에는 색인을 활성화할 수 없습니다.`
              );
            }
          }

          const earlyManifestData = (snap.exists
            ? snap.data() || {}
            : {}) as Partial<FirestoreRagManifestDoc>;
          const earlyCleanupClaims = earlyManifestData.cleanupClaims || {};
          const earlyClaimKey = makeCleanupClaimKey(
            nextState.entityKey,
            nextState.activeGeneration
          );
          const earlyClaim = earlyCleanupClaims[earlyClaimKey];
          const txReceiptData =
            txStagingSnap && txStagingSnap.exists
              ? (txStagingSnap.data() as Partial<RagGenerationStagingReceipt>)
              : null;
          if (
            earlyClaim?.status === 'CLEANUP_PENDING' ||
            earlyClaim?.status === 'CLEANUP_COMPLETED' ||
            txReceiptData?.status === 'CLEANUP_PENDING' ||
            txReceiptData?.status === 'CLEANUP_COMPLETED' ||
            isGenerationRetiredInManifest(
              earlyManifestData,
              nextState.entityKey,
              nextState.activeGeneration
            )
          ) {
            throw new Error(
              `[ACTIVATION_BLOCKED_BY_CLEANUP] [RAG_INDEX_ACTIVATION_CONFLICT] [FIRESTORE_MANIFEST_ACTIVATION_FAILED] 정리(Cleanup)가 이미 선점 또는 완료한 세대(gen=${nextState.activeGeneration}, claimOp=${String(
                earlyClaim?.cleanupOperationId ||
                  txReceiptData?.cleanupOperationId ||
                  'retired'
              )})는 활성화할 수 없습니다.`
            );
          }

          if (isLargeScale && stagingRef) {
            const stData = txReceiptData;
            if (!stData || stData.status !== 'VERIFIED') {
              throw new Error(
                `[FIRESTORE_MANIFEST_ACTIVATION_FAILED] [STAGING_NOT_VERIFIED] 스테이징 영수증(${resolvedStagingId})이 VERIFIED 상태가 아니어서 활성 세대 전환이 차단되었습니다.`
              );
            }
            if (
              stData.generation !== nextState.activeGeneration ||
              stData.verifiedDocumentCount !== params.documents.length ||
              stData.verifiedChunkCount !== params.chunks.length
            ) {
              throw new Error(
                `[FIRESTORE_MANIFEST_ACTIVATION_FAILED] [STAGING_NOT_VERIFIED] 스테이징 영수증(${resolvedStagingId})의 세대 또는 문서/청크 수량이 일치하지 않습니다.`
              );
            }
          }

          if (leasedTask) {
            const currentTask =
              taskSnap && taskSnap.exists
                ? normalizeRagSyncTaskForActivationTx(
                    (taskSnap.data() || {}) as Record<string, unknown>,
                    leasedTask.id
                  )
                : null;
            const fencing = verifyRagTaskLeaseFencing({
              currentTask,
              leasedTask,
            });
            if (!fencing.ok) {
              throw new Error(
                `[${fencing.reason}] [FIRESTORE_MANIFEST_ACTIVATION_FAILED] ${fencing.message}`
              );
            }
            if (
              currentTask &&
              (currentTask.ownerId !== params.ownerId ||
                currentTask.projectId !== params.projectId ||
                currentTask.targetEntityType !== leasedTask.targetEntityType ||
                currentTask.targetEntityId !== leasedTask.targetEntityId)
            ) {
              throw new Error(
                `[RAG_INDEX_ACTIVATION_CONFLICT] [FIRESTORE_MANIFEST_ACTIVATION_FAILED] RAG 작업의 대상 엔티티 또는 소유자 정보가 일치하지 않습니다.`
              );
            }

            const rawEntityData =
              entitySnap && entitySnap.exists
                ? ((entitySnap.data() || {}) as Record<string, unknown>)
                : null;
            if (
              rawEntityData &&
              ((typeof rawEntityData.ownerId === 'string' &&
                rawEntityData.ownerId &&
                rawEntityData.ownerId !== params.ownerId) ||
                (typeof rawEntityData.projectId === 'string' &&
                  rawEntityData.projectId &&
                  rawEntityData.projectId !== params.projectId))
            ) {
              throw new Error(
                `[RAG_INDEX_ACTIVATION_CONFLICT] [FIRESTORE_MANIFEST_ACTIVATION_FAILED] CANON 원본 엔티티의 소유자 또는 프로젝트 ID가 일치하지 않습니다.`
              );
            }

            const authoritativeEntity = rawEntityData
              ? normalizeCanonEntityForActivationTx(
                  leasedTask.targetEntityType,
                  rawEntityData,
                  leasedTask.targetEntityId
                )
              : null;
            const freshness = verifyCanonEntityFreshnessForRag({
              task: leasedTask,
              authoritativeEntity,
            });
            if (!freshness.ok) {
              throw new Error(
                `[${freshness.reason}] [FIRESTORE_MANIFEST_ACTIVATION_FAILED] ${freshness.message}`
              );
            }
          }

          const data = snap.exists ? snap.data() || {} : {};
          const entityStates =
            (data.entityStates as Record<string, EntityIndexLifecycleState>) ||
            {};
          const currentEntity = entityStates[nextState.entityKey];

          if (params.activationGuard?.verifyInActivationTransaction) {
            await params.activationGuard.verifyInActivationTransaction({
              tx: tx as any,
              db: adminDb,
              basePath,
              manifestData: data,
              currentEntityManifestState: currentEntity,
              nextEntityState: nextState,
            });
          }

          if (
            (data.projectLifecycleStatus === 'PENDING_DELETE' ||
              data.projectLifecycleStatus === 'DELETED') &&
            nextState.activeGeneration <=
              Number(data.projectTombstoneGeneration || 0)
          ) {
            throw new Error(
              `[RAG_INDEX_ACTIVATION_CONFLICT] FIRESTORE_TX_STALE_PROJECT_DELETE: 삭제된 작품(tombstoneGen=${String(
                data.projectTombstoneGeneration
              )})에 대해 이전 색인(gen=${nextState.activeGeneration})을 활성화할 수 없습니다.`
            );
          }

          if (currentEntity) {
            if (
              (currentEntity.lifecycleStatus === 'PENDING_DELETE' ||
                currentEntity.lifecycleStatus === 'DELETED') &&
              nextState.activeGeneration <=
                currentEntity.deletionTombstoneGeneration
            ) {
              throw new Error(
                `[RAG_INDEX_ACTIVATION_CONFLICT] FIRESTORE_TX_STALE_DELETE: 삭제된 항목에 대해 이전 색인(gen=${nextState.activeGeneration})을 활성화할 수 없습니다.`
              );
            }
            if (currentEntity.activeGeneration > nextState.activeGeneration) {
              throw new Error(
                `[RAG_INDEX_ACTIVATION_CONFLICT] FIRESTORE_TX_STALE_GEN: 더 최신 색인 버전(gen=${currentEntity.activeGeneration})이 이미 활성화되어 있습니다.`
              );
            }
            if (currentEntity.activeGeneration === nextState.activeGeneration) {
              const revisionMismatch = Boolean(
                currentEntity.activeRevisionId &&
                  nextState.activeRevisionId &&
                  currentEntity.activeRevisionId !== nextState.activeRevisionId
              );
              const hashMismatch = Boolean(
                currentEntity.activeContentHash &&
                  nextState.activeContentHash &&
                  currentEntity.activeContentHash !==
                    nextState.activeContentHash
              );
              const taskMismatch = Boolean(
                currentEntity.activeTaskId &&
                  nextState.activeTaskId &&
                  currentEntity.activeTaskId !== nextState.activeTaskId
              );
              const leaseGenMismatch = Boolean(
                typeof currentEntity.activeLeaseGeneration === 'number' &&
                  typeof nextState.activeLeaseGeneration === 'number' &&
                  currentEntity.activeLeaseGeneration !==
                    nextState.activeLeaseGeneration
              );
              const tokenMismatch = Boolean(
                currentEntity.activationToken &&
                  nextState.activationToken &&
                  currentEntity.activationToken !== nextState.activationToken
              );

              if (
                revisionMismatch ||
                hashMismatch ||
                taskMismatch ||
                leaseGenMismatch ||
                tokenMismatch
              ) {
                throw new Error(
                  `[RAG_INDEX_ACTIVATION_CONFLICT] FIRESTORE_TX_GENERATION_COLLISION: 동일 세대 번호(gen=${nextState.activeGeneration})로 서로 다른 작업 또는 콘텐츠의 색인을 덮어쓸 수 없습니다.`
                );
              }
            }
          }

          if (canPromoteInsideTransaction) {
            for (const docItem of params.documents) {
              tx.set(
                adminDb.doc(`${basePath}/memoryDocuments/${docItem.id}`),
                sanitizeFirestoreWriteData({
                  ...docItem,
                  documentId: docItem.id,
                  indexGeneration: nextState.activeGeneration,
                  isActiveGeneration: true,
                  activationMode: 'INLINE_DOC',
                  lifecycleStatus: 'ACTIVE',
                  indexStatus: 'INDEXED',
                  updatedAt: FieldValue.serverTimestamp(),
                }),
                { merge: true }
              );
              if (hasExistingActiveDoc) {
                tx.delete(
                  adminDb.doc(
                    `${basePath}/memoryDocuments/${docItem.id}__staged`
                  )
                );
              }
            }

            for (const chk of params.chunks) {
              const chkPayload: Record<string, unknown> =
                sanitizeFirestoreWriteData({
                  ...chk,
                  chunkId: chk.id,
                  originalText: chk.content,
                  indexGeneration: nextState.activeGeneration,
                  isActiveGeneration: true,
                  activationMode: 'INLINE_DOC',
                  lifecycleStatus: 'ACTIVE',
                });
              if (Array.isArray(chk.embedding) && chk.embedding.length > 0) {
                chkPayload.embeddingVector = FieldValue.vector(chk.embedding);
              }
              tx.set(
                adminDb.doc(`${basePath}/memoryChunks/${chk.id}`),
                sanitizeFirestoreWriteData(chkPayload),
                { merge: true }
              );
              if (hasExistingActiveDoc) {
                tx.delete(
                  adminDb.doc(`${basePath}/memoryChunks/${chk.id}__staged`)
                );
              }
            }

            if (
              hasExistingActiveDoc &&
              params.documents.length === 1 &&
              existingOldChunkCount > params.chunks.length
            ) {
              const primaryDocId = params.documents[0].id;
              for (
                let staleIdx = params.chunks.length;
                staleIdx < existingOldChunkCount;
                staleIdx++
              ) {
                tx.delete(
                  adminDb.doc(
                    `${basePath}/memoryChunks/${primaryDocId}_chk_${staleIdx}`
                  )
                );
              }
            }
          } else if (isLargeScale) {
            // Large-scale Stage B: update Manifest pointer + Staging receipt + bounded doc headers ONLY (never rewrite 200+ chunks)
            if (params.documents.length <= 50) {
              for (const docItem of params.documents) {
                tx.set(
                  adminDb.doc(`${basePath}/memoryDocuments/${docItem.id}`),
                  sanitizeFirestoreWriteData({
                    ...docItem,
                    documentId: docItem.id,
                    indexGeneration: nextState.activeGeneration,
                    isActiveGeneration: true,
                    activationMode: 'MANIFEST_POINTER',
                    ...(resolvedStagingId
                      ? { stagingId: resolvedStagingId }
                      : {}),
                    lifecycleStatus: 'ACTIVE',
                    indexStatus: 'INDEXED',
                    updatedAt: FieldValue.serverTimestamp(),
                  }),
                  { merge: true }
                );
              }
            }
            if (stagingRef) {
              tx.set(
                stagingRef,
                sanitizeFirestoreWriteData({
                  status: 'ACTIVATED',
                  activatedAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                }),
                { merge: true }
              );
            }
          }

          entityStates[nextState.entityKey] = sanitizeFirestoreWriteData(nextState);
          tx.set(
            manifestRef,
            sanitizeFirestoreWriteData({
              ownerId: params.ownerId,
              projectId: params.projectId,
              projectLifecycleStatus: data.projectLifecycleStatus || 'ACTIVE',
              projectTombstoneGeneration: Number(
                data.projectTombstoneGeneration || 0
              ),
              activeGenerationCounter: Math.max(
                Number(data.activeGenerationCounter || 0),
                nextState.activeGeneration
              ),
              entityStates,
              updatedAt: FieldValue.serverTimestamp(),
            }),
            { merge: true }
          );
        });
      } catch (txErr) {
        const txMsg = txErr instanceof Error ? txErr.message : String(txErr);
        await markStagingAbortedBestEffort(txMsg);
        if (txMsg.includes('[FIRESTORE_MANIFEST_ACTIVATION_FAILED]')) {
          throw txErr;
        }
        throw new Error(
          `[FIRESTORE_MANIFEST_ACTIVATION_FAILED] 활성 색인 세대 전환 트랜잭션 실패: ${txMsg}`
        );
      }
    }

    // Section 3.2 & Section 8: Post-Activation Durable Verification in Firestore
    if (requireDurableVerification && params.documents.length > 0) {
      const primaryDoc = params.documents[0];
      const expectedGen =
        params.entityState?.activeGeneration ?? primaryDoc.indexGeneration ?? 1;

      const [remoteDocSnap, remoteManifestSnap] = await Promise.all([
        adminDb.doc(`${basePath}/memoryDocuments/${primaryDoc.id}`).get(),
        adminDb.doc(`${basePath}/ragManifest/control`).get(),
      ]);

      if (!remoteDocSnap.exists) {
        throw new Error(
          `[RAG_INDEX_DOCUMENT_NOT_FOUND] [FIRESTORE_DURABILITY_NOT_VERIFIED] Firestore에 색인 문서(${primaryDoc.id})가 영구 저장되지 않았습니다.`
        );
      }

      const remoteDocData = remoteDocSnap.data() || {};
      if (
        !isLargeScale &&
        (remoteDocData.isActiveGeneration === false ||
          remoteDocData.indexStatus !== 'INDEXED')
      ) {
        throw new Error(
          `[FIRESTORE_DURABILITY_NOT_VERIFIED] Firestore 색인 문서(${primaryDoc.id})가 활성(INDEXED) 상태가 아닙니다.`
        );
      }
      if (
        remoteDocData.indexGeneration !== expectedGen ||
        remoteDocData.contentHash !== primaryDoc.contentHash ||
        remoteDocData.sourceRevisionId !== primaryDoc.sourceRevisionId
      ) {
        throw new Error(
          `[RAG_ACTIVE_GENERATION_MISMATCH] [FIRESTORE_DURABILITY_NOT_VERIFIED] Firestore 색인 문서(${primaryDoc.id})의 활성 세대 또는 콘텐츠 해시가 일치하지 않습니다.`
        );
      }

      if (params.entityState) {
        if (!remoteManifestSnap.exists) {
          throw new Error(
            `[FIRESTORE_MANIFEST_ACTIVATION_FAILED] [FIRESTORE_DURABILITY_NOT_VERIFIED] Firestore ragManifest/control 문서가 존재하지 않습니다.`
          );
        }
        const mData = remoteManifestSnap.data() || {};
        const mStates =
          (mData.entityStates as Record<string, EntityIndexLifecycleState>) ||
          {};
        const mEntity = mStates[params.entityState.entityKey];
        if (
          !mEntity ||
          mEntity.activeGeneration !== expectedGen ||
          mEntity.lifecycleStatus !== 'ACTIVE' ||
          !Array.isArray(mEntity.activeDocumentIds) ||
          !mEntity.activeDocumentIds.includes(primaryDoc.id)
        ) {
          throw new Error(
            `[RAG_ACTIVE_GENERATION_MISMATCH] [FIRESTORE_DURABILITY_NOT_VERIFIED] ragManifest/control의 활성 세대(gen=${String(
              mEntity?.activeGeneration
            )})가 기대 세대(gen=${expectedGen})와 일치하지 않습니다.`
          );
        }
        if (stagingRef) {
          const postStagingSnap = await stagingRef.get();
          const postStagingData = postStagingSnap.data() || {};
          if (!postStagingSnap.exists || postStagingData.status !== 'ACTIVATED') {
            throw new Error(
              `[FIRESTORE_DURABILITY_NOT_VERIFIED] 대량 색인 스테이징 영수증(${resolvedStagingId})이 ACTIVATED 상태로 커밋되지 않았습니다.`
            );
          }
        }
      }

      if (params.chunks.length > 0) {
        const primaryChunkSnap = await adminDb
          .doc(`${basePath}/memoryChunks/${params.chunks[0].id}`)
          .get();
        if (!primaryChunkSnap.exists) {
          throw new Error(
            `[FIRESTORE_DURABILITY_NOT_VERIFIED] Firestore에 색인 청크(${params.chunks[0].id})가 영구 저장되지 않았습니다.`
          );
        }
        const primaryChunkData = primaryChunkSnap.data() || {};
        const pointerAuthorized =
          isLargeScale &&
          primaryChunkData.activationMode === 'MANIFEST_POINTER';
        if (
          (!pointerAuthorized &&
            primaryChunkData.isActiveGeneration === false) ||
          primaryChunkData.indexGeneration !== expectedGen
        ) {
          throw new Error(
            `[RAG_ACTIVE_GENERATION_MISMATCH] [FIRESTORE_DURABILITY_NOT_VERIFIED] Firestore 색인 청크(${params.chunks[0].id})의 활성 세대가 일치하지 않습니다.`
          );
        }
      }
    }

    return {
      synced: true,
      batchesCommitted,
      durableCommitVerified: true,
      activeGenerationVerified: true,
      stagingId: resolvedStagingId,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      synced: false,
      batchesCommitted: 0,
      durableCommitVerified: false,
      activeGenerationVerified: false,
      stagingId: resolvedStagingId,
      error: msg,
    };
  }
}

/**
 * Phase 3.1.1 P0-1:
 * Executes Firestore Vector Search (`findNearest`) and returns full `ExternalFirestoreVectorCandidate[]`
 * with chunk snapshots, batch-loaded parent document snapshots, vector similarity scores, and 1-based ranks,
 * while explicitly distinguishing between:
 * - `'OK_WITH_HITS'`: Firestore vector search returned >= 1 valid candidates
 * - `'OK_EMPTY'`: Firestore vector search succeeded but returned 0 candidates
 * - `'API_ERROR'`: Firestore vector search call failed
 * - `'SKIPPED'`: Not applicable (e.g., deterministic test mode or no cloud store)
 */
export function isFirestoreVectorIndexMissingOrBuildingError(
  err: unknown
): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof (err as { message?: unknown })?.message === 'string'
      ? String((err as { message: string }).message)
      : String(err);
  const code = (err as { code?: unknown })?.code;

  // Never classify authentication, permission, or invalid query/dimension errors as index-missing!
  if (
    code === 7 ||
    code === 16 ||
    code === 3 ||
    /UNAUTHENTICATED|PERMISSION_DENIED|INVALID_ARGUMENT|default credentials|dimension/i.test(
      msg
    )
  ) {
    return false;
  }

  const isFailedPrecondition =
    code === 9 ||
    code === 'FAILED_PRECONDITION' ||
    msg.includes('FAILED_PRECONDITION') ||
    msg.includes('9 FAILED_PRECONDITION');

  const hasExplicitIndexIndicator =
    /requires an index|requires a composite index|index.*currently building|currently building.*cannot be used yet|create_composite|no matching index/i.test(
      msg
    );

  return isFailedPrecondition && hasExplicitIndexIndicator;
}

export async function tryFirestoreVectorFindNearest(
  params: {
    ownerId: string;
    projectId: string;
    queryEmbedding: number[];
    queryEmbeddingGenerationMode: EmbeddingGenerationMode;
    queryEmbeddingModelId: string;
    limit: number;
    canonOnly: boolean;
    db?: Firestore;
  },
  options?: RagExecutionOptions
): Promise<{
  status: 'OK_WITH_HITS' | 'OK_EMPTY' | 'API_ERROR' | 'SKIPPED';
  usedFindNearest: boolean;
  candidates: ExternalFirestoreVectorCandidate[];
  chunkIdsWithScore: Map<string, number>;
  indexMissingOrBuilding?: boolean;
  indexState:
    | 'READY'
    | 'INDEX_NOT_READY'
    | 'QUERY_OR_AUTH_ERROR'
    | 'NOT_CHECKED';
  error?: string;
}> {
  const injectedDb = params.db ?? options?.db;
  const hasInjectedDb = Boolean(injectedDb);

  if (!hasInjectedDb && activeMockFirestoreBackend) {
    const mockRes = await activeMockFirestoreBackend.findNearestVectorCandidates(
      params
    );
    const map = new Map<string, number>();
    for (const c of mockRes.candidates) {
      map.set(c.chunkId, c.vectorScore);
    }
    const isMockIndexNotReady =
      mockRes.status === 'API_ERROR' &&
      isFirestoreVectorIndexMissingOrBuildingError(mockRes.error || '');
    return {
      status: mockRes.status,
      usedFindNearest:
        mockRes.status === 'OK_WITH_HITS' || mockRes.status === 'OK_EMPTY',
      candidates: mockRes.candidates,
      chunkIdsWithScore: map,
      indexMissingOrBuilding: isMockIndexNotReady,
      indexState:
        mockRes.status === 'OK_WITH_HITS' || mockRes.status === 'OK_EMPTY'
          ? 'READY'
          : isMockIndexNotReady
          ? 'INDEX_NOT_READY'
          : 'QUERY_OR_AUTH_ERROR',
      error: mockRes.error,
    };
  }

  if (params.queryEmbeddingGenerationMode !== 'LIVE_API') {
    return {
      status: 'SKIPPED',
      usedFindNearest: false,
      candidates: [],
      chunkIdsWithScore: new Map(),
      indexState: 'NOT_CHECKED',
    };
  }

  const adminDb = resolveRagFirestore({ db: injectedDb });
  if (
    !adminDb ||
    params.ownerId === 'local_author' ||
    params.queryEmbedding.length === 0
  ) {
    return {
      status: 'SKIPPED',
      usedFindNearest: false,
      candidates: [],
      chunkIdsWithScore: new Map(),
      indexState: 'NOT_CHECKED',
    };
  }

  if (
    params.queryEmbedding.length < 1 ||
    params.queryEmbedding.length > 2048
  ) {
    return {
      status: 'API_ERROR',
      usedFindNearest: false,
      candidates: [],
      chunkIdsWithScore: new Map(),
      indexMissingOrBuilding: false,
      indexState: 'QUERY_OR_AUTH_ERROR',
      error: `FIRESTORE_VECTOR_DIMENSION_OUT_OF_RANGE(400): 질의 벡터 차원(${params.queryEmbedding.length})이 Firestore 지원 범위(1~2048)를 벗어났습니다.`,
    };
  }

  try {
    const basePath = `users/${params.ownerId}/projects/${params.projectId}`;
    const chunksPath = `${basePath}/memoryChunks`;
    let baseQuery = adminDb
      .collection(chunksPath)
      .where('ownerId', '==', params.ownerId)
      .where('projectId', '==', params.projectId)
      .where('embeddingGenerationMode', '==', 'LIVE_API')
      .where('embeddingModelId', '==', params.queryEmbeddingModelId);

    if (params.canonOnly) {
      baseQuery = baseQuery.where('canonStatus', '==', 'CANON');
    }

    const vectorQuery = baseQuery.findNearest({
      vectorField: 'embeddingVector',
      queryVector: FieldValue.vector(params.queryEmbedding),
      limit: Math.min(100, Math.max(20, params.limit * 4)),
      distanceMeasure: 'COSINE',
      distanceResultField: 'vectorDistance',
    });

    const [snap, manifestSnap] = await Promise.all([
      vectorQuery.get(),
      adminDb.doc(`${basePath}/ragManifest/control`).get(),
    ]);

    const manifestData = manifestSnap.exists
      ? (manifestSnap.data() as Partial<FirestoreRagManifestDoc>)
      : null;
    if (
      manifestData &&
      (manifestData.projectLifecycleStatus === 'PENDING_DELETE' ||
        manifestData.projectLifecycleStatus === 'DELETED')
    ) {
      return {
        status: 'OK_EMPTY',
        usedFindNearest: true,
        candidates: [],
        chunkIdsWithScore: new Map(),
        indexMissingOrBuilding: false,
        indexState: 'READY',
      };
    }

    const manifestEntityStates = manifestData?.entityStates || {};
    const isAdminChunkEligibleByManifest = (data: Record<string, unknown>): {
      eligible: boolean;
      pointerAuthorized: boolean;
    } => {
      if (
        data.lifecycleStatus === 'PENDING_DELETE' ||
        data.lifecycleStatus === 'DELETED'
      ) {
        return { eligible: false, pointerAuthorized: false };
      }

      if (!manifestData) {
        const legacyOk =
          data.isActiveGeneration !== false &&
          data.activationMode !== 'MANIFEST_POINTER' &&
          data.lifecycleStatus !== 'REINDEXING_KEEP_OLD';
        return { eligible: legacyOk, pointerAuthorized: false };
      }

      const entityKey = `${String(data.ownerId || '')}:${String(
        data.projectId || ''
      )}:${String(data.sourceEntityType || '')}:${String(
        data.sourceEntityId || ''
      )}`;
      const chunkGen =
        typeof data.indexGeneration === 'number'
          ? data.indexGeneration
          : undefined;
      if (typeof chunkGen === 'number' && chunkGen > 0) {
        const claimKey = makeCleanupClaimKey(entityKey, chunkGen);
        const claim = manifestData.cleanupClaims?.[claimKey];
        if (
          (claim &&
            (claim.status === 'CLEANUP_PENDING' ||
              claim.status === 'CLEANUP_COMPLETED')) ||
          isGenerationRetiredInManifest(manifestData, entityKey, chunkGen)
        ) {
          return { eligible: false, pointerAuthorized: false };
        }
      }
      const entityState = manifestEntityStates[entityKey];

      if (!entityState) {
        const legacyOk =
          data.isActiveGeneration !== false &&
          data.activationMode !== 'MANIFEST_POINTER' &&
          data.lifecycleStatus !== 'REINDEXING_KEEP_OLD';
        return { eligible: legacyOk, pointerAuthorized: false };
      }

      if (
        entityState.lifecycleStatus === 'PENDING_DELETE' ||
        entityState.lifecycleStatus === 'DELETED'
      ) {
        return { eligible: false, pointerAuthorized: false };
      }

      if (
        typeof chunkGen === 'number' &&
        entityState.activeGeneration > 0 &&
        chunkGen !== entityState.activeGeneration
      ) {
        return { eligible: false, pointerAuthorized: false };
      }

      const docId = String(data.documentId || '');
      if (
        Array.isArray(entityState.activeDocumentIds) &&
        entityState.activeDocumentIds.length > 0 &&
        !entityState.activeDocumentIds.includes(docId)
      ) {
        return { eligible: false, pointerAuthorized: false };
      }

      const isPointerMode =
        data.activationMode === 'MANIFEST_POINTER' ||
        entityState.activationMode === 'MANIFEST_POINTER';
      if (!isPointerMode && data.isActiveGeneration === false) {
        return { eligible: false, pointerAuthorized: false };
      }

      return { eligible: true, pointerAuthorized: isPointerMode };
    };

    const rawChunks: {
      chunk: MemoryChunk;
      score: number;
      pointerAuthorized: boolean;
    }[] = [];
    for (const docSnap of snap.docs) {
      const data = docSnap.data();
      const eligibility = isAdminChunkEligibleByManifest(data);
      if (!eligibility.eligible) {
        continue;
      }
      const dist =
        typeof data.vectorDistance === 'number' ? data.vectorDistance : 0.5;
      const sim = Math.max(0, Math.min(1, Number((1 - dist).toFixed(4))));
      const normalizedEmb = normalizeRecoveredChunkEmbedding(data);
      const restData = { ...data };
      delete restData.embeddingVector;
      const baseChunk: MemoryChunk = {
        ...(restData as unknown as MemoryChunk),
        id: String(data.id || docSnap.id),
        embedding: normalizedEmb,
      };
      if (eligibility.pointerAuthorized && baseChunk.isActiveGeneration === false) {
        baseChunk.isActiveGeneration = true;
        baseChunk.lifecycleStatus = 'ACTIVE';
        baseChunk.activationMode = 'MANIFEST_POINTER';
      }
      rawChunks.push({
        chunk: baseChunk,
        score: sim,
        pointerAuthorized: eligibility.pointerAuthorized,
      });
    }

    if (rawChunks.length === 0) {
      return {
        status: 'OK_EMPTY',
        usedFindNearest: true,
        candidates: [],
        chunkIdsWithScore: new Map(),
        indexMissingOrBuilding: false,
        indexState: 'READY',
      };
    }

    // Batch-fetch parent MemoryDocuments using adminDb.getAll(...) in slices to avoid N+1 queries
    const uniqueDocIds = Array.from(
      new Set(rawChunks.map((r) => r.chunk.documentId).filter(Boolean))
    );
    const parentDocsById = new Map<string, MemoryDocument>();
    for (let i = 0; i < uniqueDocIds.length; i += 100) {
      const docRefs = uniqueDocIds
        .slice(i, i + 100)
        .map((id) => adminDb.doc(`${basePath}/memoryDocuments/${id}`));
      const docSnaps = await adminDb.getAll(...docRefs);
      for (const dSnap of docSnaps) {
        if (dSnap.exists) {
          const dData = dSnap.data() as MemoryDocument;
          parentDocsById.set(dSnap.id, dData);
        }
      }
    }

    const maxCandidates = Math.min(50, Math.max(5, params.limit * 2));
    const map = new Map<string, number>();
    const candidates: ExternalFirestoreVectorCandidate[] = [];
    for (const item of rawChunks) {
      const parentDocRaw = parentDocsById.get(item.chunk.documentId);
      if (
        parentDocRaw &&
        (parentDocRaw.indexStatus === 'PENDING_DELETE' ||
          parentDocRaw.indexStatus === 'FAILED' ||
          parentDocRaw.lifecycleStatus === 'PENDING_DELETE' ||
          parentDocRaw.lifecycleStatus === 'DELETED')
      ) {
        continue;
      }
      const normalizedParentDoc =
        parentDocRaw && item.pointerAuthorized
          ? {
              ...parentDocRaw,
              isActiveGeneration: true,
              indexStatus: 'INDEXED' as const,
              lifecycleStatus: 'ACTIVE' as const,
              activationMode: 'MANIFEST_POINTER' as const,
            }
          : parentDocRaw;

      const chunkId = item.chunk.id;
      map.set(chunkId, item.score);
      candidates.push({
        chunkId,
        documentId: item.chunk.documentId,
        ownerId: item.chunk.ownerId,
        projectId: item.chunk.projectId,
        vectorScore: item.score,
        vectorRank: candidates.length + 1,
        embeddingModelId: item.chunk.embeddingModelId,
        embeddingGenerationMode: item.chunk.embeddingGenerationMode,
        embeddingDimension:
          item.chunk.embeddingDimension || item.chunk.embedding?.length,
        indexGeneration: item.chunk.indexGeneration,
        isActiveGeneration: item.chunk.isActiveGeneration,
        activationMode: item.chunk.activationMode,
        lifecycleStatus: item.chunk.lifecycleStatus,
        canonStatus: item.chunk.canonStatus,
        chunkSnapshot: item.chunk,
        documentSnapshot: normalizedParentDoc,
      });

      if (candidates.length >= maxCandidates) {
        break;
      }
    }

    return {
      status: candidates.length > 0 ? 'OK_WITH_HITS' : 'OK_EMPTY',
      usedFindNearest: true,
      candidates,
      chunkIdsWithScore: map,
      indexMissingOrBuilding: false,
      indexState: 'READY',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isIndexMissing = isFirestoreVectorIndexMissingOrBuildingError(err);
    return {
      status: 'API_ERROR',
      usedFindNearest: false,
      candidates: [],
      chunkIdsWithScore: new Map(),
      indexMissingOrBuilding: isIndexMissing,
      indexState: isIndexMissing ? 'INDEX_NOT_READY' : 'QUERY_OR_AUTH_ERROR',
      error: msg,
    };
  }
}

// ============================================================================
// High-Level Server RAG Operations
// ============================================================================

function getOrHydrateServerStore(
  ownerId: string,
  projectId: string,
  options?: RagExecutionOptions
): {
  store: FoundationMemorySearchStore;
  snapshot: DiskProjectRagSnapshot;
} {
  const key = makeStoreMapKey(ownerId, projectId, options);
  const existing = activeServerStores.get(key);
  if (existing) {
    return existing;
  }

  const snapshot = loadDiskSnapshot(ownerId, projectId, options);
  const store = new FoundationMemorySearchStore();
  store.loadSnapshot(snapshot.documents, snapshot.chunks, {
    entityStates: snapshot.entityStates,
    generationCounter: snapshot.generationCounter,
  });

  const entry = { store, snapshot };
  activeServerStores.set(key, entry);
  return entry;
}

function persistStoreToDisk(
  store: FoundationMemorySearchStore,
  snapshot: DiskProjectRagSnapshot,
  options?: RagExecutionOptions
): DiskProjectRagSnapshot {
  const exported = store.exportSnapshot(snapshot.projectId, snapshot.ownerId);
  const updated: DiskProjectRagSnapshot = {
    ...snapshot,
    updatedAt: new Date().toISOString(),
    generationCounter: exported.generationCounter,
    entityStates: exported.entityStates,
    documents: exported.documents,
    chunks: exported.chunks,
  };
  saveDiskSnapshot(updated, options);
  activeServerStores.set(
    makeStoreMapKey(snapshot.ownerId, snapshot.projectId, options),
    {
      store,
      snapshot: updated,
    }
  );
  return updated;
}

/**
 * Indexes a single `MemoryIndexInput` on the server:
 * - Verifies Firestore project ownership (`13-1` & `P0-4`).
 * - Generates embeddings with model-specific adapter (`gemini-embedding-2` without `taskType`) and strict separation of `LIVE_API` vs `DETERMINISTIC_TEST` (`P0-2` & `13-3`).
 * - Keeps the existing healthy index version active during indexing and atomically switches
 *   only after all write, provenance, offset, and count checks succeed (`13-2`).
 */
export interface RagIndexingOptions extends RagExecutionOptions {
  preferDeterministicEmbeddings?: boolean;
  simulateFailureForTesting?: boolean;
  simulateStagingVerificationFailure?: boolean;
  onAfterStagingInitReadBeforeWriteHook?: (ctx: {
    generation: number;
    stagingId?: string;
    status?: RagGenerationStagingStatus;
  }) => Promise<void> | void;
  onDuringStagingHook?: (ctx: {
    generation: number;
    stagingId?: string;
    largeScaleGenerationMode: boolean;
  }) => Promise<void> | void;
  onBetweenStageAAndBHook?: (ctx: {
    generation: number;
    stagingId?: string;
    largeScaleGenerationMode: boolean;
  }) => Promise<void> | void;
  requireStrictFirestoreDocCheck?: boolean;
  authorConfirmedProductionBulkWrite?: boolean;
  forceRebuild?: boolean;
  beforeCommitGuard?: () => Promise<void>;
  durableCommitPolicy?: DurableRagCommitPolicy;
  activationGuard?: AtomicRagActivationGuardContext;
}

export async function indexMemoryInputOnServer(
  input: MemoryIndexInput,
  options?: RagIndexingOptions
): Promise<MemoryIndexResult> {
  await assertServerRagProjectOwnership({
    ownerId: input.ownerId,
    projectId: input.projectId,
    claimedOwnerId: input.ownerId,
    requireStrictFirestoreDocCheck: options?.requireStrictFirestoreDocCheck,
    db: options?.db,
    cacheNamespace: options?.cacheNamespace,
  });

  const { store, snapshot } = getOrHydrateServerStore(
    input.ownerId,
    input.projectId,
    options
  );

  // Stage 2.5B: Synchronize generation floor with Firestore ragManifest/control
  // so multi-worker / restarted server instances never reuse or regress activeGenerationCounter.
  if (input.requestedGeneration === undefined) {
    const manifestPath = `users/${input.ownerId}/projects/${input.projectId}/ragManifest/control`;
    const eKey = `${input.ownerId}:${input.projectId}:${input.sourceEntityType}:${input.sourceEntityId}`;
    try {
      const injectedDb = options?.db;
      if (!injectedDb && activeMockFirestoreBackend) {
        const mDoc = activeMockFirestoreBackend.documentsByPath.get(manifestPath);
        if (mDoc) {
          const remoteCounter = Number(mDoc.activeGenerationCounter || 0);
          const eStates =
            (mDoc.entityStates as Record<string, EntityIndexLifecycleState>) ||
            {};
          const remoteEntityGen = Number(eStates[eKey]?.activeGeneration || 0);
          store.setMinimumGenerationCounterFloor(
            Math.max(remoteCounter, remoteEntityGen)
          );
        }
      } else {
        const adminDb = resolveRagFirestore({ db: injectedDb });
        if (adminDb && input.ownerId !== 'local_author') {
          const mSnap = await adminDb.doc(manifestPath).get();
          if (mSnap.exists) {
            const mData = mSnap.data() || {};
            const remoteCounter = Number(mData.activeGenerationCounter || 0);
            const eStates =
              (mData.entityStates as Record<
                string,
                EntityIndexLifecycleState
              >) || {};
            const remoteEntityGen = Number(
              eStates[eKey]?.activeGeneration || 0
            );
            store.setMinimumGenerationCounterFloor(
              Math.max(remoteCounter, remoteEntityGen)
            );
          }
        }
      }
    } catch {
      // Non-fatal floor pre-read; authoritative check happens inside activation transaction
    }
  }

  const prevExport = store.exportSnapshot(input.projectId, input.ownerId);
  const hadPreviousHealthyIndex = prevExport.documents.some(
    (d) =>
      d.sourceEntityType === input.sourceEntityType &&
      d.sourceEntityId === input.sourceEntityId &&
      d.indexStatus === 'INDEXED'
  );

  try {
    if (options?.simulateFailureForTesting) {
      throw new Error('테스트용 강제 색인 오류 시뮬레이션(FAILED)');
    }

    const resolvedFullText = input.fullText ?? input.rawText ?? '';
    const semanticChunks = splitTextIntoSemanticChunksWithOffsets(
      resolvedFullText,
      input.maxChunkLength ?? RAG_ENGINE_DEFAULTS.DEFAULT_MAX_CHUNK_CHARS
    );

    const isExplicitDeterministic =
      Boolean(options?.preferDeterministicEmbeddings) ||
      input.embeddingGenerationMode === 'DETERMINISTIC_TEST';

    if (
      (isServerCloudAuthEnforced() || Boolean(options?.db)) &&
      !activeMockFirestoreBackend &&
      isExplicitDeterministic
    ) {
      throw new Error(
        '권한 거부(403 - TEST_EMBEDDING_FORBIDDEN_IN_PRODUCTION): 클라우드 운영 환경 또는 실제 Firestore 주입 모드에서는 결정적 테스트 임베딩(DETERMINISTIC_TEST) 생성 및 저장이 차단됩니다.'
      );
    }

    const hasLiveEmbeddingCapability =
      Boolean(customGeminiEmbedContentFn) || isGeminiApiKeyConfigured();

    const hasPrecomputedEmbeddings =
      Array.isArray(input.precomputedEmbeddings) &&
      input.precomputedEmbeddings.length > 0;

    if (
      !isExplicitDeterministic &&
      !hasLiveEmbeddingCapability &&
      !hasPrecomputedEmbeddings
    ) {
      throw new Error(
        'GEMINI_API_KEY_MISSING(503): LIVE_API 모드 임베딩 생성을 위한 Gemini API Key가 설정되지 않았습니다. 테스트 환경에서는 embeddingGenerationMode를 DETERMINISTIC_TEST로 지정하거나 preferDeterministicEmbeddings 옵션을 사용하세요.'
      );
    }

    const useDeterministic = isExplicitDeterministic;

    const precomputedEmbeddings: number[][] = [];
    let resolvedMode: EmbeddingGenerationMode = useDeterministic
      ? 'DETERMINISTIC_TEST'
      : 'LIVE_API';
    let activeModelId =
      input.embeddingModelId ||
      (resolvedMode === 'DETERMINISTIC_TEST'
        ? DETERMINISTIC_TEST_EMBEDDING_MODEL_ID
        : getConfiguredEmbeddingModel());
    let activeDim =
      input.embeddingDimension || getConfiguredEmbeddingDimension();

    if (activeDim > 2048 || activeDim < 1) {
      const err = new Error(
        `FIRESTORE_VECTOR_DIMENSION_OUT_OF_RANGE(400): Firestore Vector Search는 최대 2048차원까지 지원합니다. 요청/설정된 차원: ${activeDim}`
      );
      (err as unknown as { statusCode: number }).statusCode = 400;
      throw err;
    }

    const contentHash = computeMemoryContentHash(resolvedFullText);
    const existingEntityState = store.getEntityLifecycleState({
      ownerId: input.ownerId,
      projectId: input.projectId,
      sourceEntityType: input.sourceEntityType,
      sourceEntityId: input.sourceEntityId,
    });
    const existingMatch = !options?.forceRebuild
      ? prevExport.documents.find(
          (d) =>
            d.ownerId === input.ownerId &&
            d.projectId === input.projectId &&
            d.sourceEntityType === input.sourceEntityType &&
            d.sourceEntityId === input.sourceEntityId &&
            d.sourceRevisionId === (input.sourceRevisionId || 'initial_revision') &&
            d.contentHash === contentHash &&
            d.indexStatus === 'INDEXED' &&
            d.embeddingModelId === activeModelId &&
            (useDeterministic
              ? d.embeddingGenerationMode === 'DETERMINISTIC_TEST'
              : d.embeddingGenerationMode === 'LIVE_API')
        )
      : undefined;

    if (!existingMatch) {
      if (
        input.precomputedEmbeddings &&
        input.precomputedEmbeddings.length > 0
      ) {
        for (const vec of input.precomputedEmbeddings) {
          if (vec.length !== activeDim) {
            throw new Error(
              `EMBEDDING_DIMENSION_MISMATCH(400): 문서 임베딩 차원(${vec.length})이 설정된 차원(${activeDim})과 일치하지 않습니다.`
            );
          }
          precomputedEmbeddings.push(vec);
        }
      } else {
        for (const seg of semanticChunks) {
          const embRes = await generateServerEmbedding(seg.text, {
            taskType: 'RETRIEVAL_DOCUMENT',
            title: input.title,
            preferDeterministicOnly: useDeterministic,
            modelIdOverride:
              resolvedMode === 'LIVE_API' ? activeModelId : undefined,
            dimensionOverride: activeDim,
          });
          precomputedEmbeddings.push(embRes.embedding);
          resolvedMode = embRes.embeddingGenerationMode;
          activeModelId = embRes.modelId;
          activeDim = embRes.dimension;
        }
      }
    } else {
      resolvedMode =
        existingMatch.embeddingGenerationMode || 'DETERMINISTIC_TEST';
      activeModelId =
        existingMatch.embeddingModelId || DETERMINISTIC_TEST_EMBEDDING_MODEL_ID;
      activeDim =
        existingMatch.embeddingDimension || getConfiguredEmbeddingDimension();
      const cachedDocChunks = prevExport.chunks
        .filter((c) => c.documentId === existingMatch.id)
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
      for (const c of cachedDocChunks) {
        if (Array.isArray(c.embedding) && c.embedding.length > 0) {
          precomputedEmbeddings.push(c.embedding);
        }
      }
    }

    if (options?.beforeCommitGuard) {
      await options.beforeCommitGuard();
    }

    const totalPlannedParts = Math.max(
      1,
      Math.ceil(
        semanticChunks.length /
          RAG_ENGINE_DEFAULTS.MAX_CHUNKS_PER_DOCUMENT_PART
      )
    );
    const totalPlannedWriteOps = totalPlannedParts + semanticChunks.length;
    const isLargeScale =
      Boolean(input.useGenerationScopedIds) ||
      totalPlannedWriteOps > LARGE_SCALE_RAG_TX_OP_THRESHOLD;

    const requireDurableCommit = Boolean(
      options?.durableCommitPolicy?.requireDurableCloudCommit ||
        options?.durableCommitPolicy?.requireActiveGenerationVerification ||
        options?.activationGuard
    );

    const canReuseUnchangedLocally =
      Boolean(existingMatch) &&
      Boolean(existingEntityState) &&
      existingEntityState?.lifecycleStatus === 'ACTIVE' &&
      !options?.forceRebuild;

    let reservedGeneration = input.requestedGeneration;
    let reservedStagingId = input.stagingId;

    if (
      isLargeScale &&
      reservedGeneration === undefined &&
      !canReuseUnchangedLocally
    ) {
      const reservation = await reserveRagGenerationOnServer(
        {
          ownerId: input.ownerId,
          projectId: input.projectId,
          sourceEntityType: input.sourceEntityType,
          sourceEntityId: input.sourceEntityId,
          expectedContentHash: contentHash,
          expectedSourceRevisionId:
            input.sourceRevisionId || 'initial_revision',
          expectedDocumentCount: totalPlannedParts,
          expectedChunkCount: semanticChunks.length,
          targetTaskId: options?.activationGuard?.leasedTask?.id,
          targetLeaseGeneration:
            options?.activationGuard?.leasedTask?.leaseGeneration,
          activationToken: options?.activationGuard?.activationToken,
          largeScaleGenerationMode: true,
          minimumFloor: store.getActiveGenerationCounter(),
        },
        { db: options?.db, cacheNamespace: options?.cacheNamespace }
      );
      reservedGeneration = reservation.generation;
      reservedStagingId = reservedStagingId ?? reservation.stagingId;
    }

    // Prepare staged MemoryDocuments & MemoryChunks WITHOUT mutating live store before Stage B activation!
    const prepared = await store.prepareStagedIndexing(
      {
        ...input,
        requestedGeneration: reservedGeneration,
        useGenerationScopedIds: input.useGenerationScopedIds ?? isLargeScale,
        stagingId: reservedStagingId,
        embeddingGenerationMode: resolvedMode,
        embeddingModelId: activeModelId,
        embeddingDimension: activeDim,
        precomputedEmbeddings:
          precomputedEmbeddings.length > 0 ? precomputedEmbeddings : undefined,
      },
      { markLiveStateReindexingDuringPrepare: false }
    );

    const allDocsToSync = [
      prepared.result.document,
      ...(prepared.result.additionalParts?.map((p) => p.document) || []),
    ];
    const allChunksToSync = [
      ...prepared.result.chunks,
      ...(prepared.result.additionalParts?.flatMap((p) => p.chunks) || []),
    ];

    const entityState: EntityIndexLifecycleState = sanitizeFirestoreWriteData({
      ...prepared.nextEntityState,
      activeContentHash: prepared.result.document.contentHash,
      activeSourceRevisionId:
        prepared.result.document.sourceRevisionId ||
        prepared.nextEntityState.activeSourceRevisionId,
      ...(options?.activationGuard?.leasedTask?.id
        ? { activeTaskId: options.activationGuard.leasedTask.id }
        : {}),
      ...(typeof options?.activationGuard?.leasedTask?.leaseGeneration ===
      'number'
        ? {
            activeLeaseGeneration:
              options.activationGuard.leasedTask.leaseGeneration,
          }
        : {}),
      ...(options?.activationGuard?.activationToken
        ? { activationToken: options.activationGuard.activationToken }
        : {}),
      ...(reservedStagingId ?? prepared.nextEntityState.stagingId
        ? { stagingId: reservedStagingId ?? prepared.nextEntityState.stagingId }
        : {}),
    });

    const mockMissingDoc =
      !options?.db &&
      Boolean(activeMockFirestoreBackend) &&
      !activeMockFirestoreBackend!.documentsByPath.has(
        `users/${input.ownerId}/projects/${input.projectId}/memoryDocuments/${prepared.result.document.id}`
      );

    let durableCommitVerified = false;
    let activeGenerationVerified = false;
    let firestoreBatchesCommitted = 0;

    if (
      !prepared.skippedAsUnchanged ||
      mockMissingDoc ||
      Boolean(options?.db) ||
      requireDurableCommit
    ) {
      const cloudSync = await syncDocsAndChunksAtomicallyToFirestore({
        ownerId: input.ownerId,
        projectId: input.projectId,
        documents: allDocsToSync,
        chunks: allChunksToSync,
        entityState,
        stagingId: entityState.stagingId,
        simulateStagingVerificationFailure:
          options?.simulateStagingVerificationFailure,
        onAfterStagingInitReadBeforeWriteHook:
          options?.onAfterStagingInitReadBeforeWriteHook,
        onDuringStagingHook: options?.onDuringStagingHook,
        onBetweenStageAAndBHook: options?.onBetweenStageAAndBHook,
        authorConfirmedProductionBulkWrite:
          options?.authorConfirmedProductionBulkWrite,
        db: options?.db,
        durableCommitPolicy: options?.durableCommitPolicy,
        activationGuard: options?.activationGuard,
      });
      snapshot.firestoreSynced = cloudSync.synced;
      if (cloudSync.error) {
        snapshot.lastFirestoreError = cloudSync.error;
      }

      const hasCloudTarget =
        Boolean(options?.db) ||
        Boolean(activeMockFirestoreBackend) ||
        requireDurableCommit ||
        (input.ownerId !== 'local_author' &&
          Boolean(resolveRagFirestore({ db: options?.db })));

      if (hasCloudTarget && (!cloudSync.synced || cloudSync.error)) {
        const rawErr = cloudSync.error || '원격 쓰기가 완료되지 않았습니다.';
        const prefix = options?.db
          ? 'FIRESTORE_INJECTED_DB_SYNC_FAILED(503)'
          : 'FIRESTORE_CLOUD_SYNC_FAILED(503)';
        throw new Error(
          `[FIRESTORE_WRITE_FAILED] ${prefix}: Firestore 영구 동기화 실패 — ${rawErr}`
        );
      }

      durableCommitVerified = Boolean(cloudSync.durableCommitVerified);
      activeGenerationVerified = Boolean(cloudSync.activeGenerationVerified);
      firestoreBatchesCommitted = cloudSync.batchesCommitted;
    }

    // Stage B local commit ONLY AFTER Firestore Stage A & Stage B activation succeed!
    const committedResult = store.commitPreparedIndexing(prepared, entityState);

    snapshot.failedInputs = snapshot.failedInputs.filter(
      (f) =>
        !(
          f.input.sourceEntityType === input.sourceEntityType &&
          f.input.sourceEntityId === input.sourceEntityId
        )
    );

    persistStoreToDisk(store, snapshot, options);
    return {
      ...committedResult,
      durableCommitVerified,
      activeGenerationVerified,
      firestoreBatchesCommitted,
      stagingId: entityState.stagingId ?? committedResult.stagingId,
      activationMode: entityState.activationMode ?? committedResult.activationMode,
      largeScaleGenerationMode:
        isLargeScale || Boolean(committedResult.largeScaleGenerationMode),
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (
      errMsg.includes('[LEASE_LOST]') ||
      errMsg.includes('[STALE_WORKER_RESULT]') ||
      errMsg.includes('[SUPERSEDED_BY_NEWER_CANON]') ||
      errMsg.includes('[RAG_INDEX_ACTIVATION_CONFLICT]') ||
      errMsg.includes('[ACTIVATION_BLOCKED_BY_CLEANUP]') ||
      errMsg.includes('[CLEANUP_BLOCKED_ACTIVE_GENERATION]')
    ) {
      store.loadSnapshot(prevExport.documents, prevExport.chunks, {
        entityStates: prevExport.entityStates,
        generationCounter: Math.max(
          store.getActiveGenerationCounter(),
          prevExport.generationCounter
        ),
      });
      persistStoreToDisk(store, snapshot, options);
      throw err;
    }
    const nowIso = new Date().toISOString();

    if (hadPreviousHealthyIndex) {
      store.loadSnapshot(prevExport.documents, prevExport.chunks, {
        entityStates: prevExport.entityStates,
        generationCounter: Math.max(
          store.getActiveGenerationCounter(),
          prevExport.generationCounter
        ),
      });
    } else {
      const docId =
        input.id ||
        `memdoc_${input.projectId}_${input.sourceEntityType}_${input.sourceEntityId}`.replace(
          /[^a-zA-Z0-9_-]/g,
          '_'
        );
      const resolvedFullText = input.fullText ?? input.rawText ?? '';
      const failedDoc: MemoryDocument = sanitizeFirestoreWriteData({
        id: docId,
        documentId: docId,
        ownerId: input.ownerId,
        projectId: input.projectId,
        sourceEntityType: input.sourceEntityType,
        sourceEntityId: input.sourceEntityId,
        sourceRevisionId: input.sourceRevisionId || 'initial_revision',
        sourceEpisodeId: input.episodeId || input.sourceEpisodeId || '',
        sourceSceneId: input.sceneId || input.sourceSceneId || '',
        ...(typeof input.episodeNumber === 'number'
          ? { episodeNumber: input.episodeNumber }
          : {}),
        title: input.title,
        summary: (input.summary || resolvedFullText).slice(0, 380),
        fullText: resolvedFullText.slice(0, 5000),
        chunkCount: 0,
        canonStatus: input.canonStatus || 'CANON',
        indexVersion: RAG_ENGINE_DEFAULTS.INDEX_VERSION,
        embeddingModelId: DETERMINISTIC_TEST_EMBEDDING_MODEL_ID,
        embeddingDimension: getConfiguredEmbeddingDimension(),
        embeddingGenerationMode: 'DETERMINISTIC_TEST',
        indexedAt: nowIso,
        contentHash: computeMemoryContentHash(resolvedFullText),
        indexStatus: 'FAILED',
        lastIndexError: errMsg,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      const otherDocs = prevExport.documents.filter((d) => d.id !== docId);
      store.loadSnapshot([failedDoc, ...otherDocs], prevExport.chunks, {
        entityStates: prevExport.entityStates,
        generationCounter: Math.max(
          store.getActiveGenerationCounter(),
          prevExport.generationCounter
        ),
      });
    }

    snapshot.failedInputs = [
      ...snapshot.failedInputs.filter(
        (f) =>
          !(
            f.input.sourceEntityType === input.sourceEntityType &&
            f.input.sourceEntityId === input.sourceEntityId
          )
      ),
      { input, error: errMsg, failedAt: nowIso },
    ];
    persistStoreToDisk(store, snapshot, options);
    throw err;
  }
}

/**
 * Phase 3.1.1 P0-3:
 * Executes the 10-step Cloud Firestore deletion pipeline for either a single entity or an entire project's RAG index.
 * Strictly restricted to:
 * - `users/{uid}/projects/{projectId}/memoryDocuments`
 * - `users/{uid}/projects/{projectId}/memoryChunks`
 * - `users/{uid}/projects/{projectId}/ragManifest/control`
 * NEVER touches original manuscripts (`episodes`), `characters`, `worldbuilding`, or the project root document!
 */
async function executeCloudFirestoreRagDeletionPipeline(params: {
  ownerId: string;
  projectId: string;
  targetType: 'ENTITY' | 'PROJECT';
  sourceEntityId?: string;
  sourceEntityType?: MemorySourceEntityType;
  isEpisodeDelete?: boolean;
  tombstoneGeneration: number;
  firestoreSynced?: boolean;
  db?: Firestore;
}): Promise<{
  remoteExecuted: boolean;
  remoteDeletedDocs: number;
  remoteDeletedChunks: number;
  remainingDocs: number;
  remainingChunks: number;
}> {
  const basePath = `users/${params.ownerId}/projects/${params.projectId}`;
  const docPrefix = `${basePath}/memoryDocuments/`;
  const chunkPrefix = `${basePath}/memoryChunks/`;
  const manifestKey = `${basePath}/ragManifest/control`;
  const nowIso = new Date().toISOString();

  // 1. Mock Firestore Backend Execution (with 500-op batch limit & partial failure simulation)
  if (!params.db && activeMockFirestoreBackend) {
    const manifest: FirestoreRagManifestDoc =
      activeMockFirestoreBackend.manifestsByProject.get(manifestKey) || {
        ownerId: params.ownerId,
        projectId: params.projectId,
        activeGenerationCounter: params.tombstoneGeneration,
        entityStates: {},
        projectLifecycleStatus: 'ACTIVE',
        projectTombstoneGeneration: 0,
        pendingDeletes: {},
        updatedAt: nowIso,
      };
    manifest.pendingDeletes = manifest.pendingDeletes || {};
    manifest.entityDeletionStates = manifest.entityDeletionStates || {};

    const pendingKey =
      params.targetType === 'PROJECT'
        ? `PROJECT:${params.projectId}`
        : `ENTITY:${params.sourceEntityType || 'ALL'}:${params.sourceEntityId}`;
    const shortEntityKey =
      params.targetType === 'PROJECT'
        ? `PROJECT:${params.projectId}`
        : `${params.sourceEntityType || 'EPISODE'}:${params.sourceEntityId}`;

    // Step 4: Record DELETE_PENDING (PENDING_DELETE) state in Firestore manifest & matching docs FIRST
    if (params.targetType === 'PROJECT') {
      manifest.projectLifecycleStatus = 'PENDING_DELETE';
      manifest.projectTombstoneGeneration = Math.max(
        manifest.projectTombstoneGeneration,
        params.tombstoneGeneration
      );
      for (const st of Object.values(manifest.entityStates)) {
        st.lifecycleStatus = 'PENDING_DELETE';
        st.deletionTombstoneGeneration = Math.max(
          st.deletionTombstoneGeneration,
          params.tombstoneGeneration
        );
      }
    } else if (params.sourceEntityId) {
      for (const [eKey, st] of Object.entries(manifest.entityStates)) {
        const matchesId = st.sourceEntityId === params.sourceEntityId;
        const matchesType =
          params.isEpisodeDelete ||
          !params.sourceEntityType ||
          st.sourceEntityType === params.sourceEntityType;
        if (matchesId && matchesType) {
          manifest.entityStates[eKey] = {
            ...st,
            lifecycleStatus: 'PENDING_DELETE',
            deletionTombstoneGeneration: Math.max(
              st.deletionTombstoneGeneration,
              params.tombstoneGeneration
            ),
            deletionRequestedAt: nowIso,
            updatedAt: nowIso,
          };
        }
      }
    }

    // Step 6: Query related memoryDocuments and memoryChunks ONLY under `memoryDocuments` and `memoryChunks`
    const targetDocPaths: string[] = [];
    const targetChunkPaths: string[] = [];

    for (const [docPath, rawData] of activeMockFirestoreBackend.documentsByPath.entries()) {
      if (docPath.startsWith(docPrefix)) {
        const d = rawData as unknown as MemoryDocument;
        if (d.ownerId !== params.ownerId || d.projectId !== params.projectId) {
          continue;
        }
        const matches =
          params.targetType === 'PROJECT' ||
          ((d.sourceEntityId === params.sourceEntityId ||
            d.sourceEpisodeId === params.sourceEntityId) &&
            (params.isEpisodeDelete ||
              !params.sourceEntityType ||
              d.sourceEntityType === params.sourceEntityType));
        if (matches) {
          // Mark PENDING_DELETE on the remote document first so even if batch deletion fails midway, it is blocked
          rawData.indexStatus = 'PENDING_DELETE';
          rawData.lifecycleStatus = 'PENDING_DELETE';
          rawData.isActiveGeneration = false;
          targetDocPaths.push(docPath);
        }
      } else if (docPath.startsWith(chunkPrefix)) {
        const c = rawData as unknown as MemoryChunk;
        if (c.ownerId !== params.ownerId || c.projectId !== params.projectId) {
          continue;
        }
        const matches =
          params.targetType === 'PROJECT' ||
          ((c.sourceEntityId === params.sourceEntityId ||
            c.episodeId === params.sourceEntityId) &&
            (params.isEpisodeDelete ||
              !params.sourceEntityType ||
              c.sourceEntityType === params.sourceEntityType));
        if (matches) {
          rawData.lifecycleStatus = 'PENDING_DELETE';
          rawData.isActiveGeneration = false;
          targetChunkPaths.push(docPath);
        }
      }
    }

    const initialDeleteRecord: PendingCloudDeleteRecord = {
      targetType: params.targetType,
      ownerId: params.ownerId,
      projectId: params.projectId,
      sourceEntityId: params.sourceEntityId,
      sourceEntityType: params.sourceEntityType,
      tombstoneGeneration: params.tombstoneGeneration,
      status: 'DELETE_PENDING',
      remainingDocuments: targetDocPaths.length,
      remainingChunks: targetChunkPaths.length,
      updatedAt: nowIso,
    };
    manifest.pendingDeletes[pendingKey] = initialDeleteRecord;
    manifest.entityDeletionStates[shortEntityKey] = initialDeleteRecord;
    activeMockFirestoreBackend.manifestsByProject.set(manifestKey, manifest);

    // Step 7: Safe batch deletion (<= 450 ops per batch)
    const allDeletePaths = [...targetChunkPaths, ...targetDocPaths];
    let deleteBatchesRun = 0;
    let remoteDeletedDocs = 0;
    let remoteDeletedChunks = 0;

    for (let i = 0; i < allDeletePaths.length; i += FIRESTORE_MAX_BATCH_OPS) {
      const slice = allDeletePaths.slice(i, i + FIRESTORE_MAX_BATCH_OPS);
      const nextBatchNum = deleteBatchesRun + 1;
      if (
        activeMockFirestoreBackend.simulateDeleteBatchFailureAtBatchNumber !==
          null &&
        nextBatchNum ===
          activeMockFirestoreBackend.simulateDeleteBatchFailureAtBatchNumber
      ) {
        // Count remaining docs & chunks and persist DELETE_PENDING failure state
        let remDocs = 0;
        let remChunks = 0;
        for (const p of allDeletePaths.slice(i)) {
          if (p.startsWith(docPrefix)) remDocs += 1;
          if (p.startsWith(chunkPrefix)) remChunks += 1;
        }
        const errMsg = `CLOUD_DELETE_BATCH_FAILED(503): 원격 색인 삭제 배치 #${nextBatchNum} 실패 (남은 문서: ${remDocs}개, 남은 청크: ${remChunks}개). DELETE_PENDING 및 검색 차단 상태가 유지됩니다.`;
        const failedRecord: PendingCloudDeleteRecord = {
          ...initialDeleteRecord,
          status: 'DELETE_PENDING',
          failedBatchNumber: nextBatchNum,
          remainingDocuments: remDocs,
          remainingChunks: remChunks,
          lastError: errMsg,
          updatedAt: new Date().toISOString(),
        };
        manifest.pendingDeletes[pendingKey] = failedRecord;
        manifest.entityDeletionStates[shortEntityKey] = failedRecord;
        activeMockFirestoreBackend.manifestsByProject.set(manifestKey, manifest);
        throw new Error(errMsg);
      }

      for (const p of slice) {
        if (activeMockFirestoreBackend.documentsByPath.delete(p)) {
          if (p.startsWith(docPrefix)) remoteDeletedDocs += 1;
          if (p.startsWith(chunkPrefix)) remoteDeletedChunks += 1;
        }
      }
      deleteBatchesRun += 1;
      activeMockFirestoreBackend.committedDeleteBatchCount += 1;
      activeMockFirestoreBackend.committedDeleteOpsCount += slice.length;
    }

    // Step 8: Verify remaining documents and chunks count is 0
    let remainingDocs = 0;
    let remainingChunks = 0;
    for (const [docPath, rawData] of activeMockFirestoreBackend.documentsByPath.entries()) {
      if (docPath.startsWith(docPrefix)) {
        const d = rawData as unknown as MemoryDocument;
        const matches =
          params.targetType === 'PROJECT' ||
          ((d.sourceEntityId === params.sourceEntityId ||
            d.sourceEpisodeId === params.sourceEntityId) &&
            (params.isEpisodeDelete ||
              !params.sourceEntityType ||
              d.sourceEntityType === params.sourceEntityType));
        if (matches) remainingDocs += 1;
      } else if (docPath.startsWith(chunkPrefix)) {
        const c = rawData as unknown as MemoryChunk;
        const matches =
          params.targetType === 'PROJECT' ||
          ((c.sourceEntityId === params.sourceEntityId ||
            c.episodeId === params.sourceEntityId) &&
            (params.isEpisodeDelete ||
              !params.sourceEntityType ||
              c.sourceEntityType === params.sourceEntityType));
        if (matches) remainingChunks += 1;
      }
    }

    if (remainingDocs > 0 || remainingChunks > 0) {
      throw new Error(
        `CLOUD_DELETE_INCOMPLETE(503): 원격 삭제 후에도 남은 문서(${remainingDocs}) 또는 청크(${remainingChunks})가 존재합니다.`
      );
    }

    // Step 9: Record DELETED completion state in Firestore manifest
    if (params.targetType === 'PROJECT') {
      manifest.projectLifecycleStatus = 'DELETED';
      for (const st of Object.values(manifest.entityStates)) {
        st.lifecycleStatus = 'DELETED';
        st.activeDocumentIds = [];
        st.activeChunkCount = 0;
      }
    } else if (params.sourceEntityId) {
      for (const [eKey, st] of Object.entries(manifest.entityStates)) {
        const matchesId = st.sourceEntityId === params.sourceEntityId;
        const matchesType =
          params.isEpisodeDelete ||
          !params.sourceEntityType ||
          st.sourceEntityType === params.sourceEntityType;
        if (matchesId && matchesType) {
          manifest.entityStates[eKey] = {
            ...st,
            lifecycleStatus: 'DELETED',
            activeDocumentIds: [],
            activeChunkCount: 0,
            updatedAt: new Date().toISOString(),
          };
        }
      }
    }
    const completedRecord: PendingCloudDeleteRecord = {
      ...initialDeleteRecord,
      status: 'DELETED',
      remainingDocuments: 0,
      remainingChunks: 0,
      failedBatchNumber: undefined,
      lastError: undefined,
      updatedAt: new Date().toISOString(),
    };
    manifest.pendingDeletes[pendingKey] = completedRecord;
    manifest.entityDeletionStates[shortEntityKey] = completedRecord;
    activeMockFirestoreBackend.manifestsByProject.set(manifestKey, manifest);

    const stagingPrefix = `${basePath}/ragGenerationStaging/`;
    for (const [sPath, rawReceipt] of activeMockFirestoreBackend.documentsByPath.entries()) {
      if (!sPath.startsWith(stagingPrefix)) continue;
      const r = rawReceipt as unknown as RagGenerationStagingReceipt;
      if (r.ownerId !== params.ownerId || r.projectId !== params.projectId) {
        continue;
      }
      const matches =
        params.targetType === 'PROJECT' ||
        (r.sourceEntityId === params.sourceEntityId &&
          (params.isEpisodeDelete ||
            !params.sourceEntityType ||
            r.sourceEntityType === params.sourceEntityType));
      if (matches) {
        activeMockFirestoreBackend.documentsByPath.delete(sPath);
        activeMockFirestoreBackend.stagingReceiptsByPath.delete(sPath);
      }
    }

    return {
      remoteExecuted: true,
      remoteDeletedDocs,
      remoteDeletedChunks,
      remainingDocs: 0,
      remainingChunks: 0,
    };
  }

  // 2. Live Cloud Firestore Execution (or injected test Firestore client)
  const adminDb = resolveRagFirestore({ db: params.db });
  if (
    !adminDb ||
    (!params.db && params.ownerId === 'local_author') ||
    (!params.db && !params.firestoreSynced && !isServerCloudAuthEnforced())
  ) {
    return {
      remoteExecuted: false,
      remoteDeletedDocs: 0,
      remoteDeletedChunks: 0,
      remainingDocs: 0,
      remainingChunks: 0,
    };
  }

  try {
    const manifestRef = adminDb.doc(manifestKey);
    await manifestRef.set(
      sanitizeFirestoreWriteData({
        ownerId: params.ownerId,
        projectId: params.projectId,
        ...(params.targetType === 'PROJECT'
          ? {
              projectLifecycleStatus: 'PENDING_DELETE',
              projectTombstoneGeneration: params.tombstoneGeneration,
            }
          : {}),
        updatedAt: FieldValue.serverTimestamp(),
      }),
      { merge: true }
    );

    const docsCol = adminDb.collection(`${basePath}/memoryDocuments`);
    const chunksCol = adminDb.collection(`${basePath}/memoryChunks`);
    const stagingCol = adminDb.collection(`${basePath}/ragGenerationStaging`);

    const docsSnap =
      params.targetType === 'PROJECT'
        ? await docsCol
            .where('ownerId', '==', params.ownerId)
            .where('projectId', '==', params.projectId)
            .get()
        : await docsCol
            .where('ownerId', '==', params.ownerId)
            .where('projectId', '==', params.projectId)
            .where('sourceEntityId', '==', params.sourceEntityId)
            .get();

    const chunksSnap =
      params.targetType === 'PROJECT'
        ? await chunksCol
            .where('ownerId', '==', params.ownerId)
            .where('projectId', '==', params.projectId)
            .get()
        : await chunksCol
            .where('ownerId', '==', params.ownerId)
            .where('projectId', '==', params.projectId)
            .where('sourceEntityId', '==', params.sourceEntityId)
            .get();

    const stagingSnap =
      params.targetType === 'PROJECT'
        ? await stagingCol
            .where('ownerId', '==', params.ownerId)
            .where('projectId', '==', params.projectId)
            .get()
        : await stagingCol
            .where('ownerId', '==', params.ownerId)
            .where('projectId', '==', params.projectId)
            .where('sourceEntityId', '==', params.sourceEntityId)
            .get();

    const refsToDelete = [
      ...chunksSnap.docs.map((d) => d.ref),
      ...docsSnap.docs.map((d) => d.ref),
      ...stagingSnap.docs.map((s) => s.ref),
    ];

    for (let i = 0; i < refsToDelete.length; i += FIRESTORE_MAX_BATCH_OPS) {
      const slice = refsToDelete.slice(i, i + FIRESTORE_MAX_BATCH_OPS);
      const batch = adminDb.batch();
      for (const r of slice) {
        batch.delete(r);
      }
      await batch.commit();
    }

    // Step 8: Re-query to verify remaining documents and chunks count is 0
    const verifyDocsSnap =
      params.targetType === 'PROJECT'
        ? await docsCol
            .where('ownerId', '==', params.ownerId)
            .where('projectId', '==', params.projectId)
            .get()
        : await docsCol
            .where('ownerId', '==', params.ownerId)
            .where('projectId', '==', params.projectId)
            .where('sourceEntityId', '==', params.sourceEntityId)
            .get();

    const verifyChunksSnap =
      params.targetType === 'PROJECT'
        ? await chunksCol
            .where('ownerId', '==', params.ownerId)
            .where('projectId', '==', params.projectId)
            .get()
        : await chunksCol
            .where('ownerId', '==', params.ownerId)
            .where('projectId', '==', params.projectId)
            .where('sourceEntityId', '==', params.sourceEntityId)
            .get();

    const remainingDocs = verifyDocsSnap.size;
    const remainingChunks = verifyChunksSnap.size;
    if (remainingDocs > 0 || remainingChunks > 0) {
      throw new Error(
        `CLOUD_DELETE_INCOMPLETE(503): 원격 삭제 후에도 남은 문서(${remainingDocs}) 또는 청크(${remainingChunks})가 존재합니다.`
      );
    }

    if (params.targetType === 'PROJECT') {
      await manifestRef.set(
        sanitizeFirestoreWriteData({
          projectLifecycleStatus: 'DELETED',
          projectTombstoneGeneration: params.tombstoneGeneration,
          updatedAt: FieldValue.serverTimestamp(),
        }),
        { merge: true }
      );
    }

    return {
      remoteExecuted: true,
      remoteDeletedDocs: docsSnap.size,
      remoteDeletedChunks: chunksSnap.size,
      remainingDocs: 0,
      remainingChunks: 0,
    };
  } catch (err) {
    if (!params.db && !isServerCloudAuthEnforced()) {
      return {
        remoteExecuted: false,
        remoteDeletedDocs: 0,
        remoteDeletedChunks: 0,
        remainingDocs: 0,
        remainingChunks: 0,
      };
    }
    throw err;
  }
}

/**
 * Deletes all indexed documents & chunks for a specific source entity following the 10-step pipeline:
 * 1. Verify authenticated UID
 * 2. Verify Firestore project ownership
 * 3. Check current active generation
 * 4. Record PENDING_DELETE in Firestore & local store
 * 5. Immediately exclude from search
 * 6. Query related memoryDocuments & memoryChunks
 * 7. Safe batch deletion
 * 8. Verify remaining count === 0
 * 9. Record DELETED state
 * 10. Invalidate/update local cache ONLY after remote deletion succeeds
 */
export async function deleteEntityIndexOnServer(params: {
  ownerId: string;
  projectId: string;
  sourceEntityId: string;
  sourceEntityType?: MemorySourceEntityType;
  isEpisodeDelete?: boolean;
  requireStrictFirestoreDocCheck?: boolean;
  db?: Firestore;
  cacheNamespace?: string;
  onDuringDeleteHook?: (ctx: {
    tombstoneGeneration: number;
  }) => Promise<void> | void;
}): Promise<{
  deleted: boolean;
  deletedDocuments: number;
  remoteDeletedDocuments?: number;
  remoteDeletedChunks?: number;
  remainingRemoteDocs: number;
  remainingRemoteChunks: number;
  status: 'DELETED' | 'DELETE_PENDING';
  cloudDeleteStatus: 'DELETED' | 'DELETE_PENDING';
}> {
  if (!params.ownerId || !params.ownerId.trim()) {
    throw new Error('인증된 사용자 UID가 없습니다(401).');
  }

  await assertServerRagProjectOwnership({
    ownerId: params.ownerId,
    projectId: params.projectId,
    claimedOwnerId: params.ownerId,
    requireStrictFirestoreDocCheck: params.requireStrictFirestoreDocCheck,
    db: params.db,
  });

  const hydrated = getOrHydrateServerStore(params.ownerId, params.projectId, {
    db: params.db,
    cacheNamespace: params.cacheNamespace,
  });
  await recoverStoreFromFirestoreIfNeeded(
    params.ownerId,
    params.projectId,
    hydrated,
    {
      db: params.db,
      cacheNamespace: params.cacheNamespace,
    }
  );
  const { store, snapshot } = hydrated;

  let remoteResult = null as Awaited<
    ReturnType<typeof executeCloudFirestoreRagDeletionPipeline>
  > | null;

  // Execute local PENDING_DELETE + remote Cloud Firestore deletion inside the deletion lifecycle
  const deletedDocuments = await store.deleteBySourceEntity({
    ownerId: params.ownerId,
    projectId: params.projectId,
    sourceEntityId: params.sourceEntityId,
    sourceEntityType: params.isEpisodeDelete
      ? undefined
      : params.sourceEntityType,
    onDuringDeleteHook: async ({ tombstoneGeneration }) => {
      if (params.onDuringDeleteHook) {
        await params.onDuringDeleteHook({ tombstoneGeneration });
      }
      // Execute remote Cloud Firestore deletion before finalizing local deletion
      remoteResult = await executeCloudFirestoreRagDeletionPipeline({
        ownerId: params.ownerId,
        projectId: params.projectId,
        targetType: 'ENTITY',
        sourceEntityId: params.sourceEntityId,
        sourceEntityType: params.sourceEntityType,
        isEpisodeDelete: params.isEpisodeDelete,
        tombstoneGeneration,
        firestoreSynced: snapshot.firestoreSynced || Boolean(params.db),
        db: params.db,
      });
    },
  });

  snapshot.failedInputs = snapshot.failedInputs.filter(
    (f) => f.input.sourceEntityId !== params.sourceEntityId
  );
  persistStoreToDisk(store, snapshot, {
    db: params.db,
    cacheNamespace: params.cacheNamespace,
  });

  return {
    deleted: true,
    deletedDocuments: Math.max(
      deletedDocuments,
      remoteResult?.remoteDeletedDocs ?? 0
    ),
    remoteDeletedDocuments: remoteResult?.remoteDeletedDocs ?? 0,
    remoteDeletedChunks: remoteResult?.remoteDeletedChunks ?? 0,
    remainingRemoteDocs: remoteResult?.remainingDocs ?? 0,
    remainingRemoteChunks: remoteResult?.remainingChunks ?? 0,
    status: 'DELETED',
    cloudDeleteStatus: 'DELETED',
  };
}

/**
 * Deletes all RAG indices (`memoryDocuments` and `memoryChunks`) for a project following the 10-step pipeline.
 * Never deletes the user's original project document, episodes, characters, or worldbuilding collections!
 */
export async function deleteProjectIndexOnServer(params: {
  ownerId: string;
  projectId: string;
  requireStrictFirestoreDocCheck?: boolean;
  db?: Firestore;
  cacheNamespace?: string;
  onDuringDeleteHook?: (ctx: {
    tombstoneGeneration: number;
  }) => Promise<void> | void;
}): Promise<{
  deleted: boolean;
  deletedDocuments: number;
  remoteDeletedDocuments?: number;
  remoteDeletedChunks?: number;
  remainingRemoteDocs: number;
  remainingRemoteChunks: number;
  status: 'DELETED' | 'DELETE_PENDING';
  cloudDeleteStatus: 'DELETED' | 'DELETE_PENDING';
}> {
  if (!params.ownerId || !params.ownerId.trim()) {
    throw new Error('인증된 사용자 UID가 없습니다(401).');
  }

  await assertServerRagProjectOwnership({
    ownerId: params.ownerId,
    projectId: params.projectId,
    claimedOwnerId: params.ownerId,
    requireStrictFirestoreDocCheck: params.requireStrictFirestoreDocCheck,
    db: params.db,
  });

  const hydrated = getOrHydrateServerStore(params.ownerId, params.projectId, {
    db: params.db,
    cacheNamespace: params.cacheNamespace,
  });
  const { store, snapshot } = hydrated;
  const localDocCount = snapshot.documents.length;

  let remoteResult = null as Awaited<
    ReturnType<typeof executeCloudFirestoreRagDeletionPipeline>
  > | null;

  await store.deleteProjectDocuments({
    ownerId: params.ownerId,
    projectId: params.projectId,
    onDuringDeleteHook: async ({ tombstoneGeneration }) => {
      if (params.onDuringDeleteHook) {
        await params.onDuringDeleteHook({ tombstoneGeneration });
      }
      // Execute remote Cloud Firestore batch deletion while project is in PENDING_DELETE state.
      // If a remote batch fails, this throws BEFORE local tombstone state is wiped or reported as success!
      remoteResult = await executeCloudFirestoreRagDeletionPipeline({
        ownerId: params.ownerId,
        projectId: params.projectId,
        targetType: 'PROJECT',
        tombstoneGeneration,
        firestoreSynced: snapshot.firestoreSynced || Boolean(params.db),
        db: params.db,
      });
    },
  });

  // Step 10: Only invalidate local cache after remote deletion succeeded!
  const mapKey = makeStoreMapKey(params.ownerId, params.projectId, {
    db: params.db,
    cacheNamespace: params.cacheNamespace,
  });
  activeServerStores.delete(mapKey);
  deleteDiskSnapshot(params.ownerId, params.projectId, {
    db: params.db,
    cacheNamespace: params.cacheNamespace,
  });
  return {
    deleted: true,
    deletedDocuments: Math.max(
      localDocCount,
      remoteResult?.remoteDeletedDocs ?? 0
    ),
    remoteDeletedDocuments: remoteResult?.remoteDeletedDocs ?? 0,
    remoteDeletedChunks: remoteResult?.remoteDeletedChunks ?? 0,
    remainingRemoteDocs: remoteResult?.remainingDocs ?? 0,
    remainingRemoteChunks: remoteResult?.remainingChunks ?? 0,
    status: 'DELETED',
    cloudDeleteStatus: 'DELETED',
  };
}

/**
 * Synchronizes or rebuilds all 6 indexing targets for a project.
 */
export async function syncOrRebuildProjectIndexOnServer(params: {
  ownerId: string;
  projectId?: string;
  project?: Project;
  characters: Character[];
  worldbuilding: WorldbuildingItem[];
  episodes: Episode[];
  scenes?: Scene[];
  timelineEvents?: TimelineEvent[];
  foreshadowings?: Foreshadowing[];
  relationships?: CharacterRelationship[];
  characterStateChanges?: {
    id?: string;
    episodeId: string;
    episodeNumber?: number;
    characterId?: string;
    characterName: string;
    stateChange: string;
    canonStatus?: CanonStatus;
    sourceRevisionId?: string;
  }[];
  includeDrafts?: boolean;
  forceRebuild?: boolean;
  authorConfirmedBulk?: boolean;
  authorConfirmedProductionBulkWrite?: boolean;
  preferDeterministicEmbeddings?: boolean;
  requireStrictFirestoreDocCheck?: boolean;
  pruneUnreferencedEntities?: boolean;
  db?: Firestore;
  cacheNamespace?: string;
}): Promise<{
  indexedDocuments: number;
  indexedChunks: number;
  skippedUnchanged: number;
  totalChunks: number;
  durationMs: number;
  estimate: IndexingScaleEstimate;
  statusSummary: ProjectRagStatusSummary;
}> {
  const startMs = performance.now();
  const resolvedProjectId =
    params.projectId || params.project?.id || 'default_project';

  await assertServerRagProjectOwnership({
    ownerId: params.ownerId,
    projectId: resolvedProjectId,
    claimedOwnerId: params.ownerId,
    projectPayloadOwnerId: params.project?.ownerId,
    requireStrictFirestoreDocCheck: params.requireStrictFirestoreDocCheck,
    db: params.db,
  });

  if (!params.db && params.project?.id && params.ownerId !== 'local_author') {
    registerProjectOwnerForAdminCheck(params.project.id, params.ownerId);
  }

  const inputs = extractProjectMemoryIndexInputs({
    ownerId: params.ownerId,
    projectId: resolvedProjectId,
    project: params.project,
    characters: params.characters,
    worldbuilding: params.worldbuilding,
    episodes: params.episodes,
    scenes: params.scenes,
    timelineEvents: params.timelineEvents,
    foreshadowings: params.foreshadowings,
    relationships: params.relationships,
    characterStateChanges: params.characterStateChanges,
    includeDrafts: params.includeDrafts ?? true,
  });

  const estimate = estimateIndexingScaleAndCost(resolvedProjectId, inputs);

  if (
    params.forceRebuild &&
    estimate.requiresBulkConfirmation &&
    !params.authorConfirmedBulk
  ) {
    throw new Error(
      `대량 색인 승인 필요(BULK_CONFIRMATION_REQUIRED): 총 ${estimate.targetDocumentCount}개 문서(${estimate.estimatedChunkCount}개 청크, 약 ${estimate.estimatedTokenCount.toLocaleString()} 토큰, 예상 비용 $${estimate.estimatedCostUsd})를 재색인하려면 작가 확인이 필요합니다.`
    );
  }

  let indexedDocuments = 0;
  let skippedUnchanged = 0;

  for (const input of inputs) {
    // Preserve authentic sourceRevisionId across rebuilds (do not mutate with timestamps)
    const res = await indexMemoryInputOnServer(input, {
      preferDeterministicEmbeddings: params.preferDeterministicEmbeddings,
      authorConfirmedProductionBulkWrite:
        params.authorConfirmedProductionBulkWrite,
      forceRebuild: params.forceRebuild,
      db: params.db,
      cacheNamespace: params.cacheNamespace,
    });
    if (res.skippedAsUnchanged) {
      skippedUnchanged += 1;
    } else {
      indexedDocuments += 1 + (res.additionalParts?.length || 0);
    }
  }

  const { store, snapshot } = getOrHydrateServerStore(
    params.ownerId,
    resolvedProjectId,
    {
      db: params.db,
      cacheNamespace: params.cacheNamespace,
    }
  );

  // Guard against unreferenced entity deletion during partial sync:
  // Only prune unreferenced entities when explicitly requested during a full force-rebuild.
  if (params.forceRebuild && params.pruneUnreferencedEntities) {
    const validKeys = new Set(
      inputs.map((inp) => `${inp.sourceEntityType}:${inp.sourceEntityId}`)
    );
    for (const docItem of snapshot.documents) {
      const key = `${docItem.sourceEntityType}:${docItem.sourceEntityId}`;
      if (!validKeys.has(key)) {
        await store.deleteDocument(resolvedProjectId, docItem.id, params.ownerId);
      }
    }
  }
  persistStoreToDisk(store, snapshot, {
    db: params.db,
    cacheNamespace: params.cacheNamespace,
  });

  const statusSummary = getProjectRagStatusOnServer({
    ownerId: params.ownerId,
    projectId: resolvedProjectId,
    liveInputs: inputs,
    db: params.db,
    cacheNamespace: params.cacheNamespace,
  });

  const durationMs = Number((performance.now() - startMs).toFixed(2));
  return {
    indexedDocuments,
    indexedChunks: statusSummary.totalChunks,
    skippedUnchanged,
    totalChunks: statusSummary.totalChunks,
    durationMs,
    estimate,
    statusSummary,
  };
}

/**
 * Retries any failed index items (`FAILED`) for a project.
 */
export async function retryFailedProjectIndicesOnServer(params: {
  ownerId: string;
  projectId?: string;
  project?: Project;
  characters?: Character[];
  worldbuilding?: WorldbuildingItem[];
  episodes?: Episode[];
  scenes?: Scene[];
  timelineEvents?: TimelineEvent[];
  foreshadowings?: Foreshadowing[];
  includeDrafts?: boolean;
  preferDeterministicEmbeddings?: boolean;
  db?: Firestore;
  cacheNamespace?: string;
}): Promise<{
  retriedCount: number;
  succeededCount: number;
  remainingFailedCount: number;
  statusSummary: ProjectRagStatusSummary;
}> {
  const resolvedProjectId =
    params.projectId || params.project?.id || 'default_project';

  await assertServerRagProjectOwnership({
    ownerId: params.ownerId,
    projectId: resolvedProjectId,
    claimedOwnerId: params.ownerId,
    projectPayloadOwnerId: params.project?.ownerId,
    db: params.db,
  });

  const { snapshot } = getOrHydrateServerStore(
    params.ownerId,
    resolvedProjectId,
    {
      db: params.db,
      cacheNamespace: params.cacheNamespace,
    }
  );
  const failedList = [...snapshot.failedInputs];
  let succeededCount = 0;

  for (const item of failedList) {
    try {
      await indexMemoryInputOnServer(item.input, {
        preferDeterministicEmbeddings: params.preferDeterministicEmbeddings,
        db: params.db,
        cacheNamespace: params.cacheNamespace,
      });
      succeededCount += 1;
    } catch {
      // remains in failedInputs
    }
  }

  const statusSummary = getProjectRagStatusOnServer({
    ownerId: params.ownerId,
    projectId: resolvedProjectId,
    db: params.db,
    cacheNamespace: params.cacheNamespace,
  });

  return {
    retriedCount: failedList.length,
    succeededCount,
    remainingFailedCount: statusSummary.statusCounts.FAILED,
    statusSummary,
  };
}

/**
 * Returns the current RAG index status summary for a project.
 */
export function getProjectRagStatusOnServer(params: {
  ownerId: string;
  projectId?: string;
  project?: Project;
  liveInputs?: MemoryIndexInput[];
  expectedEmbeddingModelId?: string;
  db?: Firestore;
  cacheNamespace?: string;
}): ProjectRagStatusSummary {
  const resolvedProjectId =
    params.projectId || params.project?.id || 'default_project';
  const { snapshot } = getOrHydrateServerStore(
    params.ownerId,
    resolvedProjectId,
    {
      db: params.db,
      cacheNamespace: params.cacheNamespace,
    }
  );
  const statusCounts: Record<MemoryIndexStatus, number> = {
    NOT_INDEXED: 0,
    INDEXING: 0,
    INDEXED: 0,
    STALE: 0,
    FAILED: 0,
    PENDING_DELETE: 0,
  };

  let canonDocumentCount = 0;
  let draftDocumentCount = 0;
  let nonCanonExceptionCount = 0;
  let lastIndexedAt: string | null = null;

  const indexedByKey = new Map<string, MemoryDocument>();
  for (const docItem of snapshot.documents) {
    indexedByKey.set(
      `${docItem.sourceEntityType}:${docItem.sourceEntityId}`,
      docItem
    );
    const st = docItem.indexStatus || 'INDEXED';
    statusCounts[st] = (statusCounts[st] || 0) + 1;

    if (docItem.canonFilterType === 'NON_CANON_EXCEPTION') {
      nonCanonExceptionCount += 1;
    } else if (docItem.canonStatus === 'CANON') {
      canonDocumentCount += 1;
    } else {
      draftDocumentCount += 1;
    }

    if (
      docItem.indexedAt &&
      (!lastIndexedAt || docItem.indexedAt > lastIndexedAt)
    ) {
      lastIndexedAt = docItem.indexedAt;
    }
  }

  let liveEmbeddedChunkCount = 0;
  let deterministicTestChunkCount = 0;
  let observedLiveModelId: string | null = null;
  const configuredModelId =
    params.expectedEmbeddingModelId || getConfiguredEmbeddingModel();
  let modelMismatchRequiresReindex = false;

  for (const chk of snapshot.chunks) {
    const mode =
      chk.embeddingGenerationMode ||
      (isLiveGeminiEmbeddingModelId(chk.embeddingModelId)
        ? 'LIVE_API'
        : 'DETERMINISTIC_TEST');
    if (mode === 'LIVE_API') {
      liveEmbeddedChunkCount += 1;
      if (!observedLiveModelId && chk.embeddingModelId) {
        observedLiveModelId = chk.embeddingModelId;
      }
      if (chk.embeddingModelId && chk.embeddingModelId !== configuredModelId) {
        modelMismatchRequiresReindex = true;
      }
    } else {
      deterministicTestChunkCount += 1;
      if (
        params.expectedEmbeddingModelId &&
        chk.embeddingModelId !== params.expectedEmbeddingModelId
      ) {
        modelMismatchRequiresReindex = true;
      }
    }
  }

  const embeddingGenerationMode: EmbeddingGenerationMode | 'MIXED' | 'NONE' =
    liveEmbeddedChunkCount > 0 && deterministicTestChunkCount === 0
      ? 'LIVE_API'
      : deterministicTestChunkCount > 0 && liveEmbeddedChunkCount === 0
      ? 'DETERMINISTIC_TEST'
      : liveEmbeddedChunkCount > 0 && deterministicTestChunkCount > 0
      ? 'MIXED'
      : 'NONE';

  const reportedEmbeddingModelId =
    embeddingGenerationMode === 'LIVE_API'
      ? observedLiveModelId || configuredModelId
      : embeddingGenerationMode === 'DETERMINISTIC_TEST'
      ? DETERMINISTIC_TEST_EMBEDDING_MODEL_ID
      : configuredModelId;

  const cloudSemanticSearchReady =
    embeddingGenerationMode === 'LIVE_API' &&
    liveEmbeddedChunkCount > 0 &&
    !modelMismatchRequiresReindex &&
    snapshot.firestoreSynced;

  if (params.liveInputs) {
    for (const live of params.liveInputs) {
      const key = `${live.sourceEntityType}:${live.sourceEntityId}`;
      const existing = indexedByKey.get(key);
      if (!existing) {
        statusCounts.NOT_INDEXED += 1;
      } else if (existing.indexStatus === 'INDEXED') {
        const liveHash = computeMemoryContentHash(
          live.fullText ?? live.rawText ?? ''
        );
        if (
          existing.contentHash !== liveHash ||
          (live.sourceRevisionId &&
            existing.sourceRevisionId !== live.sourceRevisionId)
        ) {
          statusCounts.STALE += 1;
          statusCounts.INDEXED = Math.max(0, statusCounts.INDEXED - 1);
        }
      }
    }
  }

  return {
    ownerId: params.ownerId,
    projectId: resolvedProjectId,
    totalDocuments: snapshot.documents.length,
    totalChunks: snapshot.chunks.length,
    statusCounts,
    canonDocumentCount,
    draftDocumentCount,
    nonCanonExceptionCount,
    embeddingModelId: reportedEmbeddingModelId,
    embeddingDimension: getConfiguredEmbeddingDimension(),
    embeddingGenerationMode,
    liveEmbeddedChunkCount,
    deterministicTestChunkCount,
    cloudSemanticSearchReady,
    activeGenerationCounter: snapshot.generationCounter,
    vectorSearchMode:
      embeddingGenerationMode === 'DETERMINISTIC_TEST'
        ? 'LOCAL_FALLBACK'
        : snapshot.firestoreVectorIndexReady && cloudSemanticSearchReady
        ? 'FIRESTORE_VECTOR_HYBRID'
        : cloudSemanticSearchReady
        ? 'LOCAL_FALLBACK'
        : 'LOCAL_FALLBACK',
    firestoreVectorIndexReady:
      snapshot.firestoreVectorIndexReady && cloudSemanticSearchReady,
    modelMismatchRequiresReindex,
    lastIndexedAt,
    documents: snapshot.documents,
  };
}

/**
 * Authoritatively cross-checks client-supplied `liveSnapshots` against server/Firestore records
 * so a malicious client cannot spoof `canonStatus: 'CANON'` on a `DRAFT` manuscript or spoof an outdated `sourceRevisionId`.
 */
function buildAuthoritativeLiveSnapshots(params: {
  ownerId: string;
  projectId: string;
  store: FoundationMemorySearchStore;
  snapshot: DiskProjectRagSnapshot;
  clientLiveSnapshots?:
    | LiveSourceSnapshotMap
    | {
        sourceEntityType?: MemorySourceEntityType;
        sourceEntityId: string;
        fullText?: string;
        sourceRevisionId?: string;
        latestRevisionId?: string;
        currentRevisionId?: string;
        canonStatus?: CanonStatus;
      }[];
}): LiveSourceSnapshotMap | undefined {
  const merged: LiveSourceSnapshotMap = {};

  if (Array.isArray(params.clientLiveSnapshots)) {
    for (const item of params.clientLiveSnapshots) {
      if (!item || !item.sourceEntityId) continue;
      const rev =
        item.latestRevisionId ||
        item.currentRevisionId ||
        item.sourceRevisionId;
      const entry = {
        exists: true,
        latestRevisionId: rev,
        currentRevisionId: rev,
        canonStatus: item.canonStatus,
        fullText: item.fullText,
      };
      const compositeKey = `${item.sourceEntityType || 'EPISODE'}:${item.sourceEntityId}`;
      merged[compositeKey] = entry;
      merged[item.sourceEntityId] = entry;
    }
  } else if (params.clientLiveSnapshots) {
    for (const [k, v] of Object.entries(params.clientLiveSnapshots)) {
      const rev =
        v.latestRevisionId ||
        v.currentRevisionId ||
        (v as { sourceRevisionId?: string }).sourceRevisionId;
      merged[k] = {
        ...v,
        latestRevisionId: rev ?? v.latestRevisionId,
        currentRevisionId: rev ?? v.currentRevisionId,
      };
    }
  }

  // Cross-verify against authoritative Firestore episode records if present in Mock/Cloud Firestore
  if (activeMockFirestoreBackend) {
    const epPrefix = `users/${params.ownerId}/projects/${params.projectId}/episodes/`;
    for (const [docPath, rawEp] of activeMockFirestoreBackend.documentsByPath.entries()) {
      if (!docPath.startsWith(epPrefix)) {
        continue;
      }
      const epId = String(rawEp.id || docPath.slice(epPrefix.length));
      const authCanon = (rawEp.canonStatus as CanonStatus) || 'DRAFT';
      const authRev = String(
        rawEp.latestRevisionId || rawEp.sourceRevisionId || ''
      );
      const authText =
        typeof rawEp.content === 'string' ? rawEp.content : undefined;

      const keyA = `EPISODE:${epId}`;
      const clientEntry = merged[keyA] ?? merged[epId];
      if (clientEntry) {
        if (clientEntry.canonStatus && clientEntry.canonStatus !== authCanon) {
          throw new Error(
            `권한 거부(403 - CANON_SPOOF_DETECTED): 클라이언트가 전송한 회차('${epId}')의 CANON 상태('${clientEntry.canonStatus}')가 Firestore 원본 상태('${authCanon}')와 불일치하여 차단되었습니다.`
          );
        }
        const clientRev =
          clientEntry.latestRevisionId || clientEntry.currentRevisionId;
        if (clientRev && authRev && clientRev !== authRev) {
          throw new Error(
            `권한 거부(403 - REVISION_SPOOF_DETECTED): 클라이언트가 전송한 회차('${epId}')의 리비전('${clientRev}')이 Firestore 최신 리비전('${authRev}')과 불일치하여 차단되었습니다.`
          );
        }
      }

      const authoritativeEntry = {
        exists: true,
        latestRevisionId: authRev || undefined,
        currentRevisionId: authRev || undefined,
        canonStatus: authCanon,
        fullText: authText,
        episodeNumber:
          typeof rawEp.episodeNumber === 'number'
            ? rawEp.episodeNumber
            : undefined,
      };
      merged[keyA] = authoritativeEntry;
      merged[epId] = authoritativeEntry;
    }
  }

  // Also prevent client `liveSnapshots` from claiming an older revision or CANON status than the store's active state
  for (const st of params.snapshot.entityStates) {
    if (st.ownerId !== params.ownerId || st.projectId !== params.projectId) {
      continue;
    }
    const compositeKey = `${st.sourceEntityType}:${st.sourceEntityId}`;
    const cEntry = merged[compositeKey] ?? merged[st.sourceEntityId];
    if (cEntry) {
      const activeDoc = params.snapshot.documents.find(
        (d) =>
          d.sourceEntityType === st.sourceEntityType &&
          d.sourceEntityId === st.sourceEntityId &&
          d.indexGeneration === st.activeGeneration
      );
      if (
        activeDoc &&
        activeDoc.canonStatus !== 'CANON' &&
        cEntry.canonStatus === 'CANON'
      ) {
        throw new Error(
          `권한 거부(403 - CANON_SPOOF_DETECTED): 미확정(DRAFT) 자료('${compositeKey}')를 클라이언트 liveSnapshots로 CANON 위조할 수 없습니다.`
        );
      }
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Executes a Hybrid / Semantic / Keyword search across a project's persistent RAG index:
 * - P0-1: Uses Firestore `findNearest()` candidates in actual RRF + score fusion and distinguishes
 *   `FIRESTORE_VECTOR_HYBRID`, `FIRESTORE_VECTOR_ONLY`, `KEYWORD_ONLY`, `LOCAL_FALLBACK`, and `SEARCH_FAILED`.
 * - P0-2: Uses `gemini-embedding-2` adapter without `taskType`, never silently replaces failed live API calls with test vectors,
 *   and gracefully switches to `KEYWORD_ONLY` (or throws on strict semantic failure) when Gemini API fails.
 * - P0-3 & 13-2: Excludes `PENDING_DELETE`, `DELETED`, `STALE`, and non-active index generations.
 * - P0-4 & 13-1: Directly verifies Firestore project ownership and blocks `liveSnapshots` / `canonStatus` / `revisionId` spoofing.
 * - P1-5: Automatically recovers from Firestore if local disk cache was wiped or server restarted.
 */
export async function searchProjectMemoryOnServer(params: {
  ownerId: string;
  query: MemorySearchQuery;
  liveSnapshots?:
    | LiveSourceSnapshotMap
    | {
        sourceEntityType?: MemorySourceEntityType;
        sourceEntityId: string;
        fullText?: string;
        sourceRevisionId?: string;
        latestRevisionId?: string;
        currentRevisionId?: string;
        canonStatus?: CanonStatus;
      }[];
  preferDeterministicEmbeddings?: boolean;
  requireStrictFirestoreDocCheck?: boolean;
  failOnEmbeddingError?: boolean;
  db?: Firestore;
  cacheNamespace?: string;
}): Promise<{
  hits: MemorySearchHit[];
  searchMode: MemorySearchMode;
  vectorSearchMode: RagExecutionSearchStatus;
  searchExecutionStatus: RagExecutionSearchStatus;
  firestoreVectorStatus: 'OK_WITH_HITS' | 'OK_EMPTY' | 'API_ERROR' | 'SKIPPED';
  firestoreVectorIndexState?:
    | 'READY'
    | 'INDEX_NOT_READY'
    | 'QUERY_OR_AUTH_ERROR'
    | 'NOT_CHECKED';
  latencyMs: number;
  searchLatencyMs: number;
  embeddingModelId: string;
  embeddingGenerationMode: EmbeddingGenerationMode;
  embeddingUsed: boolean;
  usedLiveEmbeddingApi: boolean;
  cloudSemanticSearchSucceeded: boolean;
  recoveredFromFirestore?: boolean;
  modelMismatchRequiresReindex?: boolean;
  embeddingError?: string;
  firestoreError?: string;
  fallbackWarning?: string;
}> {
  const startTime = performance.now();
  const { ownerId, query } = params;

  if (!ownerId || !ownerId.trim()) {
    throw new Error('검색 요청에 유효한 사용자 인증 ID(ownerId)가 필요합니다(401).');
  }
  if (!query.projectId || !query.projectId.trim()) {
    throw new Error('검색 요청에 유효한 작품 ID(projectId)가 필요합니다(400).');
  }
  if (query.ownerId && query.ownerId !== ownerId) {
    throw new Error(
      '권한 거부(403): 다른 사용자의 작품 기억 저장소를 검색할 수 없습니다.'
    );
  }

  // P0-4 & 13-1: Direct Firestore project ownership verification
  await assertServerRagProjectOwnership({
    ownerId,
    projectId: query.projectId,
    claimedOwnerId: query.ownerId ?? ownerId,
    requireStrictFirestoreDocCheck: params.requireStrictFirestoreDocCheck,
    db: params.db,
  });

  const hydrated = getOrHydrateServerStore(ownerId, query.projectId, {
    db: params.db,
    cacheNamespace: params.cacheNamespace,
  });
  const recovery = await recoverStoreFromFirestoreIfNeeded(
    ownerId,
    query.projectId,
    hydrated,
    {
      db: params.db,
      cacheNamespace: params.cacheNamespace,
    }
  );
  const { store, snapshot } = recovery;

  // Verify and sanitize liveSnapshots against spoofing (P0-4)
  const authoritativeLiveSnapshots = buildAuthoritativeLiveSnapshots({
    ownerId,
    projectId: query.projectId,
    store,
    snapshot,
    clientLiveSnapshots: query.liveSources ?? params.liveSnapshots,
  });

  const requestedSearchMode: MemorySearchMode = query.searchMode || 'HYBRID';
  let effectiveSearchMode: MemorySearchMode = requestedSearchMode;

  const storeHasOnlyDeterministicChunks =
    snapshot.chunks.length > 0 &&
    snapshot.chunks.every(
      (c) =>
        (c.embeddingGenerationMode ||
          (isLiveGeminiEmbeddingModelId(c.embeddingModelId)
            ? 'LIVE_API'
            : 'DETERMINISTIC_TEST')) === 'DETERMINISTIC_TEST'
    );

  const configuredModelId =
    query.queryEmbeddingModelId || getConfiguredEmbeddingModel();
  const modelMismatchRequiresReindex =
    snapshot.chunks.length > 0 &&
    snapshot.chunks.some(
      (c) =>
        c.embeddingGenerationMode === 'LIVE_API' &&
        c.embeddingModelId &&
        c.embeddingModelId !== configuredModelId
    );

  const useDeterministicQuery =
    Boolean(params.preferDeterministicEmbeddings) ||
    query.queryEmbeddingGenerationMode === 'DETERMINISTIC_TEST' ||
    (storeHasOnlyDeterministicChunks &&
      !customGeminiEmbedContentFn &&
      !isGeminiApiKeyConfigured());

  let queryEmbedding = query.queryEmbedding;
  let queryEmbeddingMode: EmbeddingGenerationMode =
    query.queryEmbeddingGenerationMode ||
    (queryEmbedding && isLiveGeminiEmbeddingModelId(query.queryEmbeddingModelId)
      ? 'LIVE_API'
      : useDeterministicQuery
      ? 'DETERMINISTIC_TEST'
      : 'LIVE_API');
  let queryEmbeddingModelId =
    query.queryEmbeddingModelId ||
    (queryEmbeddingMode === 'LIVE_API'
      ? configuredModelId
      : DETERMINISTIC_TEST_EMBEDDING_MODEL_ID);
  let usedLiveEmbeddingApi = Boolean(
    queryEmbedding && queryEmbeddingMode === 'LIVE_API'
  );
  let embeddingError: string | undefined;

  if (
    !queryEmbedding &&
    query.queryText.trim().length > 0 &&
    (effectiveSearchMode === 'HYBRID' || effectiveSearchMode === 'SEMANTIC')
  ) {
    try {
      const embRes = await generateServerEmbedding(query.queryText, {
        taskType: 'RETRIEVAL_QUERY',
        preferDeterministicOnly: useDeterministicQuery,
        modelIdOverride:
          queryEmbeddingMode === 'LIVE_API' ? configuredModelId : undefined,
      });
      queryEmbedding = embRes.embedding;
      queryEmbeddingMode = embRes.embeddingGenerationMode;
      queryEmbeddingModelId = embRes.modelId;
      usedLiveEmbeddingApi = embRes.usedLiveGeminiApi;
    } catch (err) {
      embeddingError = err instanceof Error ? err.message : String(err);
      usedLiveEmbeddingApi = false;

      // P0-2: Never silently substitute a deterministic test vector when Gemini API fails!
      // In SEMANTIC-only mode or when failOnEmbeddingError is set, report SEARCH_FAILED / throw error.
      // In HYBRID mode, protect the search system by falling back to KEYWORD_ONLY search over verified existing index.
      if (params.failOnEmbeddingError || effectiveSearchMode === 'SEMANTIC') {
        throw new Error(`SEARCH_FAILED: ${embeddingError}`);
      }
      effectiveSearchMode = 'KEYWORD';
    }
  }

  let firestoreVectorStatus:
    | 'OK_WITH_HITS'
    | 'OK_EMPTY'
    | 'API_ERROR'
    | 'SKIPPED' = 'SKIPPED';
  let firestoreVectorIndexState:
    | 'READY'
    | 'INDEX_NOT_READY'
    | 'QUERY_OR_AUTH_ERROR'
    | 'NOT_CHECKED' = 'NOT_CHECKED';
  let firestoreError: string | undefined;
  let externalVectorCandidates: ExternalFirestoreVectorCandidate[] | undefined;

  if (
    effectiveSearchMode !== 'KEYWORD' &&
    queryEmbedding &&
    (snapshot.firestoreSynced ||
      Boolean(params.db) ||
      Boolean(activeMockFirestoreBackend)) &&
    (queryEmbeddingMode === 'LIVE_API' ||
      Boolean(params.db) ||
      Boolean(activeMockFirestoreBackend?.customVectorSearchResults))
  ) {
    const findNearestRes = await tryFirestoreVectorFindNearest({
      ownerId,
      projectId: query.projectId,
      queryEmbedding,
      queryEmbeddingGenerationMode: queryEmbeddingMode,
      queryEmbeddingModelId,
      limit: query.limit ?? query.topK ?? 10,
      canonOnly: !query.includeDrafts && query.onlyCanon !== false,
      db: params.db,
    });

    firestoreVectorStatus = findNearestRes.status;
    firestoreVectorIndexState = findNearestRes.indexState;
    firestoreError = findNearestRes.error;

    if (
      findNearestRes.status === 'OK_WITH_HITS' ||
      findNearestRes.status === 'OK_EMPTY'
    ) {
      externalVectorCandidates = findNearestRes.candidates;
      snapshot.firestoreVectorIndexReady = true;
      saveDiskSnapshot(snapshot, {
        db: params.db,
        cacheNamespace: params.cacheNamespace,
      });
    }
  }

  const hits = await store.search({
    ...query,
    ownerId,
    searchMode: effectiveSearchMode,
    queryEmbedding: effectiveSearchMode === 'KEYWORD' ? undefined : queryEmbedding,
    queryEmbeddingModelId,
    queryEmbeddingGenerationMode: queryEmbeddingMode,
    liveSources: authoritativeLiveSnapshots,
    externalVectorCandidates,
  });

  const usedFirestoreVectorCandidatesInResult =
    firestoreVectorStatus === 'OK_WITH_HITS' &&
    Array.isArray(externalVectorCandidates) &&
    externalVectorCandidates.length > 0 &&
    hits.some(
      (h) =>
        h.retrievalSource === 'FIRESTORE_VECTOR_HYBRID' ||
        h.retrievalSource === 'FIRESTORE_VECTOR_ONLY'
    );

  let vectorSearchMode: RagExecutionSearchStatus;
  if (effectiveSearchMode === 'KEYWORD') {
    vectorSearchMode = 'KEYWORD_ONLY';
  } else if (usedFirestoreVectorCandidatesInResult) {
    vectorSearchMode =
      effectiveSearchMode === 'SEMANTIC'
        ? 'FIRESTORE_VECTOR_ONLY'
        : 'FIRESTORE_VECTOR_HYBRID';
  } else if (
    firestoreVectorStatus === 'OK_EMPTY' &&
    effectiveSearchMode === 'HYBRID' &&
    hits.length > 0
  ) {
    vectorSearchMode = 'KEYWORD_ONLY';
  } else {
    vectorSearchMode = 'LOCAL_FALLBACK';
  }

  const allMatchedChunksAreLiveApi =
    hits.length > 0 &&
    hits.every((h) => h.chunk.embeddingGenerationMode === 'LIVE_API');
  const cloudSemanticSearchSucceeded =
    !embeddingError &&
    usedLiveEmbeddingApi &&
    queryEmbeddingMode === 'LIVE_API' &&
    allMatchedChunksAreLiveApi &&
    (usedFirestoreVectorCandidatesInResult ||
      (snapshot.firestoreSynced &&
        firestoreVectorStatus !== 'API_ERROR' &&
        firestoreVectorStatus !== 'OK_EMPTY'));

  const fallbackWarning = embeddingError
    ? `KEYWORD_ONLY fallback activated due to Gemini Embedding API error: ${embeddingError}`
    : firestoreError
    ? `LOCAL_FALLBACK activated due to Firestore Vector Search error: ${firestoreError}`
    : undefined;

  const latencyMs = Number((performance.now() - startTime).toFixed(2));
  return {
    hits,
    searchMode: effectiveSearchMode,
    vectorSearchMode,
    searchExecutionStatus: vectorSearchMode,
    firestoreVectorStatus,
    firestoreVectorIndexState,
    latencyMs,
    searchLatencyMs: latencyMs,
    embeddingModelId: queryEmbeddingModelId,
    embeddingGenerationMode: queryEmbeddingMode,
    embeddingUsed: effectiveSearchMode !== 'KEYWORD' && Boolean(queryEmbedding),
    usedLiveEmbeddingApi,
    cloudSemanticSearchSucceeded,
    recoveredFromFirestore: recovery.recoveredFromFirestore,
    modelMismatchRequiresReindex,
    embeddingError,
    firestoreError,
    fallbackWarning,
  };
}

/**
 * Retrieves full source document & provenance for a specific `documentId` or `chunkId`,
 * enforcing strict `ownerId` + `projectId` ownership (`13-1` & `P0-4`).
 */
export async function getMemorySourceOnServer(params: {
  ownerId: string;
  projectId: string;
  documentOrChunkId: string;
  requireStrictFirestoreDocCheck?: boolean;
  db?: Firestore;
  cacheNamespace?: string;
}): Promise<MemorySourceReference | null> {
  await assertServerRagProjectOwnership({
    ownerId: params.ownerId,
    projectId: params.projectId,
    claimedOwnerId: params.ownerId,
    requireStrictFirestoreDocCheck: params.requireStrictFirestoreDocCheck,
    db: params.db,
  });

  const hydrated = getOrHydrateServerStore(params.ownerId, params.projectId, {
    db: params.db,
    cacheNamespace: params.cacheNamespace,
  });
  await recoverStoreFromFirestoreIfNeeded(
    params.ownerId,
    params.projectId,
    hydrated,
    {
      db: params.db,
      cacheNamespace: params.cacheNamespace,
    }
  );
  return hydrated.store.getSource(
    params.projectId,
    params.documentOrChunkId,
    params.ownerId
  );
}

// ============================================================================
// Novel Writer 12-Step Automatic RAG Context Retrieval & Verification
// ============================================================================

export async function retrieveVerifiedMemoryForWritingOnServer(params: {
  ownerId: string;
  context: WritingContextBundle;
  sceneQueryHint?: string;
  limit?: number;
  topK?: number;
  preferDeterministicEmbeddings?: boolean;
  db?: Firestore;
  cacheNamespace?: string;
}): Promise<RagRetrievedEvidenceItem[]> {
  const {
    ownerId,
    context,
    sceneQueryHint = '',
    limit = params.topK ?? 8,
  } = params;

  await assertServerRagProjectOwnership({
    ownerId,
    projectId: context.projectId,
    claimedOwnerId: ownerId,
    db: params.db,
  });

  const hydrated = getOrHydrateServerStore(ownerId, context.projectId, {
    db: params.db,
    cacheNamespace: params.cacheNamespace,
  });
  await recoverStoreFromFirestoreIfNeeded(ownerId, context.projectId, hydrated, {
    db: params.db,
    cacheNamespace: params.cacheNamespace,
  });
  const { snapshot } = hydrated;

  // Phase 4.3B Stage 2 (P0-A Security Fix):
  // NEVER promote unverified client `context.canonCharacters` / `context.canonWorldbuilding`
  // into `canonStatus: 'CANON'` RAG documents when the server store is empty.
  // Authoritative CANON indexing must come strictly from server-verified approved records.
  if (snapshot.documents.length === 0) {
    return [];
  }

  const combinedQueryText = [
    context.plotOutline,
    ...(context.requiredEvents || []),
    sceneQueryHint,
    ...(context.canonCharacters || []).map((c) => c.name),
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 1200);

  if (!combinedQueryText.trim()) {
    return [];
  }

  const searchRes = await searchProjectMemoryOnServer({
    ownerId,
    query: {
      ownerId,
      projectId: context.projectId,
      queryText: combinedQueryText,
      limit: limit * 2,
      searchMode: 'HYBRID',
      allowedCanonStatuses: ['CANON'],
      includeNonCanonException: false,
      includeDrafts: false,
      excludeUnverifiedSources: true,
    },
    preferDeterministicEmbeddings: params.preferDeterministicEmbeddings,
    db: params.db,
    cacheNamespace: params.cacheNamespace,
  });

  const verifiedItems: RagRetrievedEvidenceItem[] = [];
  const seenTextHashes = new Set<string>();

  for (const hit of searchRes.hits) {
    if (
      hit.chunk.sourceEntityType === 'EPISODE' &&
      hit.chunk.episodeId === context.episodeId
    ) {
      continue;
    }

    if (
      !hit.verifiedForWriting ||
      hit.freshnessStatus !== 'FRESH' ||
      hit.document.canonStatus !== 'CANON'
    ) {
      continue;
    }

    const textHash = computeMemoryContentHash(hit.chunk.content);
    if (seenTextHashes.has(textHash)) continue;
    seenTextHashes.add(textHash);

    verifiedItems.push({
      chunkId: hit.chunk.id,
      documentId: hit.document.id,
      projectId: hit.chunk.projectId,
      sourceEntityType: hit.chunk.sourceEntityType,
      sourceEntityId: hit.chunk.sourceEntityId,
      sourceRevisionId: hit.chunk.sourceRevisionId,
      episodeId: hit.chunk.episodeId,
      episodeNumber: hit.episodeNumber,
      sceneId: hit.chunk.sceneId,
      title: hit.document.title,
      originalText: hit.chunk.content,
      sourceStartOffset: hit.chunk.sourceStartOffset ?? 0,
      sourceEndOffset:
        hit.chunk.sourceEndOffset ?? hit.chunk.content.length,
      score: hit.score,
      relevanceScore: hit.score,
      keywordScore: hit.keywordScore,
      semanticScore: hit.semanticScore,
      matchedTerms: hit.matchedTerms,
      canonStatus: hit.document.canonStatus,
      freshnessStatus: hit.freshnessStatus,
      verifiedForWriting: true,
    });

    if (verifiedItems.length >= limit) {
      break;
    }
  }

  return verifiedItems;
}

/**
 * Phase 3.2.1 Section 9:
 * Safely deletes all subcollection documents (`memoryChunks`, `memoryDocuments`, `ragManifest`)
 * and the parent test project document (`users/{testOwnerId}/projects/{testProjectId}`)
 * inside the isolated test Firestore database (`db`).
 *
 * Safety guards:
 * 1. Requires `testOwnerId` to start with `test_owner_live_` and `testProjectId` to start with `test_proj_live_`.
 * 2. Verifies the parent project document either does not exist or has `isIsolatedLiveTest === true` and `testRunId === expectedRunId`.
 * 3. Deletes subcollections in batches of <= 450 operations before deleting the parent project document.
 * 4. Re-queries all 4 paths and confirms `0` remaining documents.
 */
export async function purgeIsolatedTestProjectData(params: {
  db: Firestore;
  testOwnerId: string;
  testProjectId: string;
  expectedRunId: string;
  cacheNamespace?: string;
}): Promise<{
  deletedChunks: number;
  deletedDocuments: number;
  deletedManifests: number;
  deletedProjectRoot: boolean;
  remainingChunks: number;
  remainingDocuments: number;
  remainingManifests: number;
  remainingProjectRoot: number;
}> {
  const { db, testOwnerId, testProjectId, expectedRunId } = params;

  if (!testOwnerId.startsWith('test_owner_live_')) {
    throw new Error(
      `ISOLATED_CLEANUP_BLOCKED(403): testOwnerId('${testOwnerId}')가 'test_owner_live_' 접두사로 시작하지 않아 정리 작업이 거부되었습니다.`
    );
  }
  if (!testProjectId.startsWith('test_proj_live_')) {
    throw new Error(
      `ISOLATED_CLEANUP_BLOCKED(403): testProjectId('${testProjectId}')가 'test_proj_live_' 접두사로 시작하지 않아 정리 작업이 거부되었습니다.`
    );
  }

  const basePath = `users/${testOwnerId}/projects/${testProjectId}`;
  const projectRef = db.doc(basePath);
  const projectSnap = await projectRef.get();

  if (projectSnap.exists) {
    const projectData = projectSnap.data() || {};
    if (
      projectData.isIsolatedLiveTest !== true ||
      projectData.testRunId !== expectedRunId
    ) {
      throw new Error(
        `ISOLATED_CLEANUP_OWNERSHIP_MISMATCH(403): 대상 프로젝트('${basePath}')의 격리 테스트 마커(isIsolatedLiveTest=${String(
          projectData.isIsolatedLiveTest
        )}, testRunId=${String(
          projectData.testRunId
        )})가 현재 실행 ID('${expectedRunId}')와 일치하지 않아 삭제가 차단되었습니다.`
      );
    }
  }

  const deleteCollectionInBatches = async (
    collectionPath: string
  ): Promise<number> => {
    const colRef = db.collection(collectionPath);
    const snap = await colRef.get();
    if (snap.empty) {
      return 0;
    }
    const refs = snap.docs.map((d) => d.ref);
    for (let i = 0; i < refs.length; i += FIRESTORE_MAX_BATCH_OPS) {
      const slice = refs.slice(i, i + FIRESTORE_MAX_BATCH_OPS);
      const batch = db.batch();
      for (const r of slice) {
        batch.delete(r);
      }
      await batch.commit();
    }
    return refs.length;
  };

  // Order mandated by Phase 3.2.1 Section 9 + Stage 2.5C:
  // 1. memoryChunks -> 2. memoryDocuments -> 3. ragGenerationStaging -> 4. ragManifest -> 5. parent project doc
  const deletedChunks = await deleteCollectionInBatches(
    `${basePath}/memoryChunks`
  );
  const deletedDocuments = await deleteCollectionInBatches(
    `${basePath}/memoryDocuments`
  );
  const deletedStagingReceipts = await deleteCollectionInBatches(
    `${basePath}/ragGenerationStaging`
  );
  const deletedManifests = await deleteCollectionInBatches(
    `${basePath}/ragManifest`
  );

  let deletedProjectRoot = false;
  if (projectSnap.exists) {
    await projectRef.delete();
    deletedProjectRoot = true;
  }

  // Clear local namespace cache
  const mapKey = makeStoreMapKey(testOwnerId, testProjectId, {
    db,
    cacheNamespace: params.cacheNamespace,
  });
  activeServerStores.delete(mapKey);
  deleteDiskSnapshot(testOwnerId, testProjectId, {
    db,
    cacheNamespace: params.cacheNamespace,
  });

  // Verify 0 remaining documents across all paths
  const [
    remChunksSnap,
    remDocsSnap,
    remStagingSnap,
    remManifestSnap,
    remProjectSnap,
  ] = await Promise.all([
    db.collection(`${basePath}/memoryChunks`).get(),
    db.collection(`${basePath}/memoryDocuments`).get(),
    db.collection(`${basePath}/ragGenerationStaging`).get(),
    db.collection(`${basePath}/ragManifest`).get(),
    projectRef.get(),
  ]);

  const remainingChunks = remChunksSnap.size;
  const remainingDocuments = remDocsSnap.size;
  const remainingStagingReceipts = remStagingSnap.size;
  const remainingManifests = remManifestSnap.size;
  const remainingProjectRoot = remProjectSnap.exists ? 1 : 0;

  if (
    remainingChunks > 0 ||
    remainingDocuments > 0 ||
    remainingStagingReceipts > 0 ||
    remainingManifests > 0 ||
    remainingProjectRoot > 0
  ) {
    throw new Error(
      `ISOLATED_CLEANUP_INCOMPLETE(503): 테스트 데이터 정리 후 잔존 문서가 감지되었습니다 (chunks=${remainingChunks}, docs=${remainingDocuments}, staging=${remainingStagingReceipts}, manifests=${remainingManifests}, projectRoot=${remainingProjectRoot}).`
    );
  }

  return {
    deletedChunks,
    deletedDocuments,
    deletedManifests: deletedManifests + deletedStagingReceipts,
    deletedProjectRoot,
    remainingChunks,
    remainingDocuments,
    remainingManifests: remainingManifests + remainingStagingReceipts,
    remainingProjectRoot,
  };
}

export { areEmbeddingsVectorSpaceCompatible };


