import crypto from 'node:crypto';
import { GoogleGenAI, Type, type Schema } from '@google/genai';
import { getApps, initializeApp } from 'firebase-admin/app';
import {
  getFirestore,
  Timestamp,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';
import type {
  CanonStatus,
  ChangeProposal,
  Character,
  CharacterRelationship,
  Episode,
  Foreshadowing,
  Revision,
  Scene,
  TimelineEvent,
  TokenUsageMetadata,
  WorldbuildingItem,
} from '../types/novel';
import type {
  ChangeProposalPayloadEnvelope,
  ExtractionExecutionMode,
  ManuscriptExtractionRequest,
  ManuscriptExtractionResponse,
  ProposalSaveDisposition,
  SavedProposalItemResult,
  SaveExtractionProposalsRequest,
  SaveExtractionProposalsResponse,
  VerifiedExtractionCandidate,
} from '../types/manuscriptExtraction';
import {
  applyAuthorSpanDisambiguationToCandidate,
  checkDuplicateProposalStatus,
  computeDeterministicProposalId,
  computeRevisionContentHash,
  isUtf16SurrogateSplit,
  parseAndSanitizeAiExtractionResponse,
  validateSelectedCandidateIdsForSave,
  verifyAndConvertExtractionCandidates,
} from '../utils/manuscriptExtractionLogic';
import { normalizeToCanonStatus, validateChangeProposalInput } from '../utils/foundationLogic';
import { isValidEntityId } from '../utils/novelLogic';
import {
  ensureFirebaseAdminInitialized,
  getFirebaseDatabaseId,
  getIsolatedFirestoreBindingMetadata,
  isServerCloudAuthEnforced,
  PROD_DEFAULT_FIREBASE_PROJECT_ID,
  PROD_DEFAULT_FIRESTORE_DATABASE_ID,
  verifyIsolatedTestFirestoreBinding,
} from './authMiddleware';
import { isEpisodeLocked } from './geminiWritingEngine';

const DEFAULT_EXTRACTION_MODEL = 'gemini-2.5-flash';
const ANALYSIS_TOKEN_TTL_MS = 1000 * 60 * 60 * 2; // 2 hours
const MAX_CACHED_ANALYSIS_RUNS = 250;

const DEV_TEST_FALLBACK_HMAC_SECRET =
  'nf_phase422_dev_test_deterministic_hmac_secret_v1';

/**
 * Phase 4.2.2 Section 3.1: Production HMAC Secret Policy.
 * - Reads `NOVEL_FORGE_ANALYSIS_TOKEN_SECRET` or `ANALYSIS_TOKEN_HMAC_SECRET` from environment.
 * - In production (`NODE_ENV === 'production'`) or when server cloud auth is enforced (outside isolated tests),
 *   missing secret environment variable is a fatal configuration error (`[ANALYSIS_TOKEN_SECRET_MISSING]`).
 * - Random per-process secrets in production are strictly forbidden because multi-instance or restarted
 *   servers would invalidate issued tokens unpredictably.
 * - In local development and `TEST_ISOLATED` tests, falls back to a deterministic dev/test secret.
 */
export function resolveAnalysisTokenHmacSecret(options?: {
  allowTestFallback?: boolean;
}): string {
  const configuredSecret = (
    process.env.NOVEL_FORGE_ANALYSIS_TOKEN_SECRET ||
    process.env.ANALYSIS_TOKEN_HMAC_SECRET ||
    ''
  ).trim();
  if (configuredSecret.length > 0) {
    return configuredSecret;
  }

  const isProdEnv =
    process.env.NODE_ENV === 'production' ||
    (isServerCloudAuthEnforced() && !options?.allowTestFallback);

  if (isProdEnv) {
    throw new Error(
      '[ANALYSIS_TOKEN_SECRET_MISSING] 운영 환경에서는 NOVEL_FORGE_ANALYSIS_TOKEN_SECRET(또는 ANALYSIS_TOKEN_HMAC_SECRET) 환경 변수가 필수입니다. 임의의 프로세스별 임시 비밀키는 허용되지 않습니다.'
    );
  }

  return DEV_TEST_FALLBACK_HMAC_SECRET;
}

interface SignedAnalysisTokenPayload {
  v: 'NF_421_S2';
  analysisRunId: string;
  executionMode: ExtractionExecutionMode;
  ownerId: string;
  projectId: string;
  episodeId: string;
  revisionId: string;
  revisionContentHash: string;
  issuedAtMs: number;
  expiresAtMs: number;
  candidates: VerifiedExtractionCandidate[];
}

// Server-side in-memory cache of verified analysis runs (complements HMAC token)
const verifiedAnalysisRunStore = new Map<string, SignedAnalysisTokenPayload>();

function pruneAnalysisRunStore(): void {
  const now = Date.now();
  for (const [key, entry] of verifiedAnalysisRunStore.entries()) {
    if (entry.expiresAtMs <= now) {
      verifiedAnalysisRunStore.delete(key);
    }
  }
  while (verifiedAnalysisRunStore.size > MAX_CACHED_ANALYSIS_RUNS) {
    const oldestKey = verifiedAnalysisRunStore.keys().next().value;
    if (!oldestKey) break;
    verifiedAnalysisRunStore.delete(oldestKey);
  }
}

export function issueSignedAnalysisToken(
  payload: Omit<SignedAnalysisTokenPayload, 'v' | 'issuedAtMs' | 'expiresAtMs'>,
  ttlMs = ANALYSIS_TOKEN_TTL_MS
): string {
  const hmacSecret = resolveAnalysisTokenHmacSecret({
    allowTestFallback: payload.executionMode === 'TEST_ISOLATED',
  });
  pruneAnalysisRunStore();
  const now = Date.now();
  const fullPayload: SignedAnalysisTokenPayload = {
    v: 'NF_421_S2',
    ...payload,
    issuedAtMs: now,
    expiresAtMs: now + ttlMs,
  };
  verifiedAnalysisRunStore.set(fullPayload.analysisRunId, fullPayload);

  const encodedPayload = Buffer.from(JSON.stringify(fullPayload), 'utf8').toString(
    'base64url'
  );
  const signature = crypto
    .createHmac('sha256', hmacSecret)
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
}

export function verifySignedAnalysisToken(params: {
  analysisRunId: string;
  analysisToken: string;
  expectedOwnerId: string;
  expectedExecutionMode: ExtractionExecutionMode;
  expectedProjectId: string;
  expectedEpisodeId: string;
  expectedRevisionId: string;
}): SignedAnalysisTokenPayload {
  const {
    analysisRunId,
    analysisToken,
    expectedOwnerId,
    expectedExecutionMode,
    expectedProjectId,
    expectedEpisodeId,
    expectedRevisionId,
  } = params;

  const hmacSecret = resolveAnalysisTokenHmacSecret({
    allowTestFallback: expectedExecutionMode === 'TEST_ISOLATED',
  });

  if (!analysisRunId || typeof analysisRunId !== 'string') {
    throw new Error('[INVALID_ANALYSIS_TOKEN] analysisRunId가 누락되었습니다.');
  }
  if (!analysisToken || typeof analysisToken !== 'string') {
    throw new Error('[INVALID_ANALYSIS_TOKEN] analysisToken이 누락되었습니다.');
  }

  const parts = analysisToken.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('[INVALID_ANALYSIS_TOKEN] analysisToken 형식이 올바르지 않습니다.');
  }

  const [encodedPayload, providedSig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', hmacSecret)
    .update(encodedPayload)
    .digest('base64url');

  const providedBuf = Buffer.from(providedSig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (
    providedBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(providedBuf, expectedBuf)
  ) {
    throw new Error(
      '[INVALID_ANALYSIS_TOKEN] analysisToken 서명 검증에 실패했습니다 (위변조 감지).'
    );
  }

  let parsed: SignedAnalysisTokenPayload;
  try {
    parsed = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8')
    ) as SignedAnalysisTokenPayload;
  } catch {
    throw new Error('[INVALID_ANALYSIS_TOKEN] analysisToken 페이로드 복호화에 실패했습니다.');
  }

  if (parsed.v !== 'NF_421_S2' || parsed.analysisRunId !== analysisRunId) {
    throw new Error(
      '[INVALID_ANALYSIS_TOKEN] analysisRunId와 토큰 내 식별자가 일치하지 않습니다.'
    );
  }
  if (Date.now() > parsed.expiresAtMs) {
    throw new Error(
      '[ANALYSIS_TOKEN_EXPIRED] 분석 결과 유효시간이 만료되었습니다. 원고 분석을 다시 실행해 주세요.'
    );
  }
  if (parsed.ownerId !== expectedOwnerId) {
    throw new Error(
      '[OWNERSHIP_MISMATCH] 분석을 실행한 사용자(ownerId)와 저장 요청 사용자가 일치하지 않습니다.'
    );
  }
  if (parsed.executionMode !== expectedExecutionMode) {
    throw new Error(
      `[EXECUTION_MODE_MISMATCH] 분석 실행 모드(${parsed.executionMode})와 저장 실행 모드(${expectedExecutionMode})가 일치하지 않습니다.`
    );
  }
  if (
    parsed.projectId !== expectedProjectId ||
    parsed.episodeId !== expectedEpisodeId ||
    parsed.revisionId !== expectedRevisionId
  ) {
    throw new Error(
      '[TARGET_CONTEXT_MISMATCH] 분석된 프로젝트/회차/리비전 ID가 저장 요청 대상과 일치하지 않습니다.'
    );
  }

  return parsed;
}

// ============================================================================
// Firestore Native Timestamp Conversion & Normalization (Section 3)
// ============================================================================

export function toFirestoreAdminTimestamp(
  value?: string | Date | Timestamp | null
): Timestamp {
  if (value instanceof Timestamp) {
    return value;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? Timestamp.now() : Timestamp.fromDate(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsedDate = new Date(value);
    if (!Number.isNaN(parsedDate.getTime())) {
      return Timestamp.fromDate(parsedDate);
    }
  }
  return Timestamp.now();
}

export function normalizeFirestoreTimestampToIso(
  value: unknown,
  fallbackIso?: string
): string {
  if (!value) {
    return fallbackIso ?? new Date().toISOString();
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? fallbackIso ?? new Date().toISOString()
      : value.toISOString();
  }
  if (typeof value === 'object' && value !== null) {
    const maybeObj = value as {
      toDate?: () => Date;
      _seconds?: number;
      _nanoseconds?: number;
      seconds?: number;
      nanoseconds?: number;
    };
    if (typeof maybeObj.toDate === 'function') {
      const d = maybeObj.toDate();
      if (d instanceof Date && !Number.isNaN(d.getTime())) {
        return d.toISOString();
      }
    }
    const secs =
      typeof maybeObj._seconds === 'number'
        ? maybeObj._seconds
        : typeof maybeObj.seconds === 'number'
        ? maybeObj.seconds
        : null;
    const nanos =
      typeof maybeObj._nanoseconds === 'number'
        ? maybeObj._nanoseconds
        : typeof maybeObj.nanoseconds === 'number'
        ? maybeObj.nanoseconds
        : 0;
    if (secs !== null) {
      return new Timestamp(secs, nanos).toDate().toISOString();
    }
  }
  return fallbackIso ?? new Date().toISOString();
}

/**
 * Firestore document shape for `changeProposals/{proposalId}` matching `firestore.rules`
 * `isValidChangeProposal(data)` (exact 19 allowed keys, with createdAt & updatedAt as Timestamp).
 */
export interface FirestoreChangeProposalDocument {
  id: string;
  ownerId: string;
  projectId: string;
  targetEntityType: ChangeProposal['targetEntityType'];
  targetEntityId: string;
  proposedAction: ChangeProposal['proposedAction'];
  title: string;
  rationale: string;
  beforeSummary: string;
  afterSummary: string;
  proposedPayloadJson: string;
  canonStatus: CanonStatus;
  triggerEpisodeId: string;
  triggerSceneId: string;
  sourceRevisionId: string;
  createdBy: ChangeProposal['createdBy'];
  reviewedAt: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Converts an application ChangeProposal into a Firestore-compliant document with native
 * Admin SDK Timestamp fields (`createdAt`, `updatedAt`) and preserves immutable fields
 * when an existing document is provided.
 */
export function serializeChangeProposalForFirestoreWrite(params: {
  proposal: ChangeProposal;
  ownerId: string;
  projectId: string;
  existingDoc?: Partial<FirestoreChangeProposalDocument> | Partial<ChangeProposal> | null;
  nowTimestamp?: Timestamp;
}): FirestoreChangeProposalDocument {
  const { proposal, ownerId, projectId, existingDoc, nowTimestamp } = params;
  const nowTs = nowTimestamp ?? Timestamp.now();

  const preservedCreatedAt = existingDoc?.createdAt
    ? toFirestoreAdminTimestamp(existingDoc.createdAt as string | Date | Timestamp)
    : toFirestoreAdminTimestamp(proposal.createdAt);

  return {
    id: existingDoc?.id || proposal.id,
    ownerId: existingDoc?.ownerId || ownerId,
    projectId: existingDoc?.projectId || projectId,
    targetEntityType: proposal.targetEntityType,
    targetEntityId: existingDoc?.targetEntityId || proposal.targetEntityId,
    proposedAction: proposal.proposedAction,
    title: proposal.title,
    rationale: proposal.rationale,
    beforeSummary: proposal.beforeSummary,
    afterSummary: proposal.afterSummary,
    proposedPayloadJson: proposal.proposedPayloadJson,
    canonStatus: 'PROPOSED',
    triggerEpisodeId: proposal.triggerEpisodeId,
    triggerSceneId: proposal.triggerSceneId || '',
    sourceRevisionId: existingDoc?.sourceRevisionId || proposal.sourceRevisionId,
    createdBy: existingDoc?.createdBy || 'AI_ENGINE',
    reviewedAt:
      typeof existingDoc?.reviewedAt === 'string'
        ? existingDoc.reviewedAt
        : proposal.reviewedAt || '',
    createdAt: preservedCreatedAt,
    updatedAt: nowTs,
  };
}

/**
 * Normalizes a raw Firestore `changeProposals` document back into the application
 * `ChangeProposal` type with ISO string timestamps.
 */
export function normalizeChangeProposalFromFirestore(
  raw: Record<string, unknown>,
  fallbackId?: string
): ChangeProposal {
  const nowIso = new Date().toISOString();
  const createdAtIso = normalizeFirestoreTimestampToIso(raw.createdAt, nowIso);
  const updatedAtIso = normalizeFirestoreTimestampToIso(
    raw.updatedAt,
    createdAtIso
  );

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId || '',
    ownerId: typeof raw.ownerId === 'string' ? raw.ownerId : '',
    projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
    targetEntityType:
      (raw.targetEntityType as ChangeProposal['targetEntityType']) || 'RELATIONSHIP',
    targetEntityId:
      typeof raw.targetEntityId === 'string' ? raw.targetEntityId : '',
    proposedAction:
      (raw.proposedAction as ChangeProposal['proposedAction']) || 'CREATE',
    title: typeof raw.title === 'string' ? raw.title : '',
    rationale: typeof raw.rationale === 'string' ? raw.rationale : '',
    beforeSummary:
      typeof raw.beforeSummary === 'string' ? raw.beforeSummary : '',
    afterSummary: typeof raw.afterSummary === 'string' ? raw.afterSummary : '',
    proposedPayloadJson:
      typeof raw.proposedPayloadJson === 'string'
        ? raw.proposedPayloadJson
        : '{}',
    canonStatus: normalizeToCanonStatus(raw.canonStatus as CanonStatus),
    triggerEpisodeId:
      typeof raw.triggerEpisodeId === 'string' ? raw.triggerEpisodeId : '',
    triggerSceneId:
      typeof raw.triggerSceneId === 'string' ? raw.triggerSceneId : '',
    sourceRevisionId:
      typeof raw.sourceRevisionId === 'string' ? raw.sourceRevisionId : '',
    createdBy:
      raw.createdBy === 'AUTHOR' || raw.createdBy === 'SYSTEM'
        ? raw.createdBy
        : 'AI_ENGINE',
    reviewedAt:
      typeof raw.reviewedAt === 'string'
        ? raw.reviewedAt
        : raw.reviewedAt
        ? normalizeFirestoreTimestampToIso(raw.reviewedAt, '')
        : '',
    createdAt: createdAtIso,
    updatedAt: updatedAtIso,
  };
}

// Active extraction lock per episode/revision to prevent duplicate concurrent runs
const activeExtractionLocks = new Set<string>();

export function isExtractionRunningForEpisode(episodeId: string): boolean {
  return activeExtractionLocks.has(episodeId);
}

export interface ManuscriptExtractionPromptContext {
  projectId: string;
  episode: Episode;
  revision: Revision;
  scenes: Scene[];
  characters: Character[];
  worldbuilding: WorldbuildingItem[];
  relationships: CharacterRelationship[];
  timelineEvents: TimelineEvent[];
  foreshadowings: Foreshadowing[];
}

export interface ManuscriptExtractionEngineOptions {
  /**
   * Optional isolated Firestore instance for Phase 3.2.1 / 4.2.1 DI testing.
   * When provided (or when testMode is true), default production Firestore fallback is strictly disabled,
   * and verifyIsolatedTestFirestoreBinding() is enforced unconditionally.
   */
  db?: Firestore;
  /**
   * Explicitly marks execution as TEST_ISOLATED.
   */
  testMode?: boolean;
  /**
   * Verified owner UID resolved by authMiddleware (for CLOUD_AUTHENTICATED or TEST_ISOLATED).
   */
  verifiedOwnerId?: string | null;
  /**
   * Optional mock AI extractor function for deterministic unit/integration tests without live Gemini API calls.
   */
  mockExtractorFn?: (
    ctx: ManuscriptExtractionPromptContext
  ) => Promise<{
    rawResponse: unknown;
    tokenUsage?: TokenUsageMetadata | null;
    modelId?: string;
  }>;
}

/**
 * Resolves the Firestore instance to use.
 * Section 9.3 Strict Enforcement:
 * - When `options?.db` is supplied, it MUST have isolated test binding metadata and pass
 *   `verifyIsolatedTestFirestoreBinding()`. Unverified DB objects throw `ISOLATED_TEST_DB_UNVERIFIED`.
 * - When `options?.testMode` is true without `options?.db`, throws `TEST_ISOLATED_DB_REQUIRED`.
 */
export function resolveExtractionFirestoreInstance(
  options?: ManuscriptExtractionEngineOptions
): Firestore {
  if (options?.db) {
    const meta = getIsolatedFirestoreBindingMetadata(options.db);
    if (!meta) {
      throw new Error(
        'ISOLATED_TEST_DB_UNVERIFIED: 전달된 Firestore 인스턴스가 격리된 테스트 전용 앱(createIsolatedTestFirestoreClient 또는 registerIsolatedMockFirestoreForTest)으로 생성되지 않았습니다.'
      );
    }
    verifyIsolatedTestFirestoreBinding(options.db, {
      projectId: meta.projectId,
      databaseId: meta.databaseId,
      runId: meta.runId,
    });
    return options.db;
  }

  if (options?.testMode) {
    throw new Error(
      '[TEST_ISOLATED_DB_REQUIRED] TEST_ISOLATED 모드에서는 격리된 Firestore 인스턴스(options.db)가 필수이며 기본 운영 DB로의 폴백이 금지됩니다.'
    );
  }

  ensureFirebaseAdminInitialized();
  const projectId =
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    PROD_DEFAULT_FIREBASE_PROJECT_ID;
  const databaseId =
    process.env.FIRESTORE_DATABASE_ID ||
    getFirebaseDatabaseId() ||
    PROD_DEFAULT_FIRESTORE_DATABASE_ID;

  const app =
    getApps().length === 0 ? initializeApp({ projectId }) : getApps()[0];
  return databaseId && databaseId !== '(default)'
    ? getFirestore(app, databaseId)
    : getFirestore(app);
}

function getGenAiClient(): GoogleGenAI {
  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.API_KEY ||
    process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      '서버 환경 변수에 GEMINI_API_KEY가 설정되어 있지 않습니다. 원고 자동 분석을 실행할 수 없습니다.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

/**
 * Gemini structured output schema matching src/schemas/manuscript_extraction.schema.json.
 * Notice: startOffset and endOffset are intentionally absent so the LLM never guesses UTF-16 offsets.
 */
const GEMINI_MANUSCRIPT_EXTRACTION_SCHEMA: Schema = {
  type: Type.OBJECT,
  description:
    'NOVEL FORGE Phase 4.2.1 원고 기반 구조화 설정 후보 추출 응답. 원문 오프셋(startOffset, endOffset)은 AI가 생성하지 않으며 서버가 Revision.content 대조를 통해 직접 계산한다.',
  properties: {
    analysis_summary: {
      type: Type.STRING,
      description: '이번 회차 원고에서 발견된 주요 인물 관계 변화, 연표 사건, 복선 단서 요약',
    },
    candidates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          targetEntityType: {
            type: Type.STRING,
            enum: ['RELATIONSHIP', 'TIMELINE_EVENT', 'FORESHADOWING'],
          },
          proposedAction: {
            type: Type.STRING,
            enum: ['CREATE', 'UPDATE'],
          },
          existingTargetEntityId: {
            type: Type.STRING,
            nullable: true,
          },
          title: {
            type: Type.STRING,
          },
          rationale: {
            type: Type.STRING,
          },
          beforeSummary: {
            type: Type.STRING,
          },
          afterSummary: {
            type: Type.STRING,
          },
          excerpt: {
            type: Type.STRING,
            description:
              '제공된 [분석 대상 원고]에 실제로 등장하는 토씨 하나 다르지 않은 원문 그대로의 발췌 문자열',
          },
          precedingContext: {
            type: Type.STRING,
            nullable: true,
            description: '발췌문 직전에 등장하는 원문 문맥 문자열 (중복 발췌 위치 특정용)',
          },
          followingContext: {
            type: Type.STRING,
            nullable: true,
            description: '발췌문 직후에 등장하는 원문 문맥 문자열 (중복 발췌 위치 특정용)',
          },
          sceneId: {
            type: Type.STRING,
            nullable: true,
          },
          confidence: {
            type: Type.NUMBER,
          },
          dialogueClaimOnly: {
            type: Type.BOOLEAN,
          },
          temporalContextType: {
            type: Type.STRING,
            enum: [
              'PRESENT_EVENT',
              'FLASHBACK',
              'PAST_MENTION',
              'PROPHECY_OR_RUMOR',
              'HYPOTHETICAL_OR_DREAM',
            ],
          },
          uncertaintyFlags: {
            type: Type.ARRAY,
            items: {
              type: Type.STRING,
              enum: [
                'AMBIGUOUS_CHARACTER_REFERENCE',
                'HOMONYM_CHARACTER_NAME',
                'NEW_UNREGISTERED_CHARACTER',
                'DIALOGUE_CLAIM_ONLY',
                'FLASHBACK_OR_PAST_MENTION',
                'RUMOR_OR_PROPHECY',
                'CONFLICTS_WITH_CANON',
                'TIMELINE_ORDER_UNCERTAIN',
                'CLUE_PHASE_UNCERTAIN',
              ],
            },
          },
          relationshipPayload: {
            type: Type.OBJECT,
            nullable: true,
            properties: {
              sourceCharacterId: { type: Type.STRING, nullable: true },
              sourceCharacterName: { type: Type.STRING },
              targetCharacterId: { type: Type.STRING, nullable: true },
              targetCharacterName: { type: Type.STRING },
              relationType: { type: Type.STRING },
              affinityScore: { type: Type.INTEGER },
              isDirectional: { type: Type.BOOLEAN },
              description: { type: Type.STRING },
            },
            required: [
              'sourceCharacterId',
              'sourceCharacterName',
              'targetCharacterId',
              'targetCharacterName',
              'relationType',
              'affinityScore',
              'isDirectional',
              'description',
            ],
          },
          timelineEventPayload: {
            type: Type.OBJECT,
            nullable: true,
            properties: {
              title: { type: Type.STRING },
              summary: { type: Type.STRING },
              inUniverseDate: { type: Type.STRING },
              chronologicalOrder: { type: Type.INTEGER, nullable: true },
              involvedCharacterIds: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              involvedCharacterNames: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              locationWorldItemId: { type: Type.STRING, nullable: true },
              locationName: { type: Type.STRING, nullable: true },
            },
            required: [
              'title',
              'summary',
              'inUniverseDate',
              'chronologicalOrder',
              'involvedCharacterIds',
              'involvedCharacterNames',
              'locationWorldItemId',
              'locationName',
            ],
          },
          foreshadowingPayload: {
            type: Type.OBJECT,
            nullable: true,
            properties: {
              title: { type: Type.STRING },
              description: { type: Type.STRING },
              cluePhase: {
                type: Type.STRING,
                enum: ['PLANTED', 'REINFORCED', 'RESOLVED'],
              },
              relatedCharacterIds: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              relatedCharacterNames: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              relatedEventIds: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              payoffNote: { type: Type.STRING },
            },
            required: [
              'title',
              'description',
              'cluePhase',
              'relatedCharacterIds',
              'relatedCharacterNames',
              'relatedEventIds',
              'payoffNote',
            ],
          },
        },
        required: [
          'targetEntityType',
          'proposedAction',
          'existingTargetEntityId',
          'title',
          'rationale',
          'beforeSummary',
          'afterSummary',
          'excerpt',
          'precedingContext',
          'followingContext',
          'sceneId',
          'confidence',
          'dialogueClaimOnly',
          'temporalContextType',
          'uncertaintyFlags',
          'relationshipPayload',
          'timelineEventPayload',
          'foreshadowingPayload',
        ],
      },
    },
  },
  required: ['analysis_summary', 'candidates'],
};

function buildExtractionSystemInstruction(): string {
  return [
    '당신은 한국어 장편 웹소설 집필 스튜디오 NOVEL FORGE의 수석 설정 분석 엔진입니다.',
    '주어진 회차 리비전 원고(Revision.content)와 프로젝트의 기존 설정(등장인물, 인물 관계, 연표 사건, 복선, 세계관)을 대조하여,',
    '원고에 명확한 근거가 있는 [인물 관계(RELATIONSHIP)], [연표 사건(TIMELINE_EVENT)], [복선(FORESHADOWING)] 신규 생성(CREATE) 또는 변경(UPDATE) 후보만 구조화하여 추출하세요.',
    '',
    '[절대 규칙]',
    '1. 발췌문(excerpt)은 반드시 제공된 [분석 대상 원고] 본문에 실제로 존재하는 문장을 토씨 하나 바꾸지 말고 원문 그대로 복사해야 합니다. 임의 요약, 말줄임표(...) 삽입, 단어 치환을 절대 하지 마세요.',
    '2. 원문 문자 오프셋(startOffset, endOffset)은 계산하지 마세요. 대신 동일 문구가 반복될 경우를 대비해 발췌문 직전 문맥(precedingContext)과 직후 문맥(followingContext)을 원문 그대로 함께 제공하세요.',
    '3. 등장인물의 일방적인 대사/주장/거짓말/추측에만 의존하는 정보는 dialogueClaimOnly=true 및 uncertaintyFlags에 "DIALOGUE_CLAIM_ONLY"를 부여하세요.',
    '4. 회상(FLASHBACK), 과거 사건 언급(PAST_MENTION), 예언/소문(PROPHECY_OR_RUMOR), 가정/꿈(HYPOTHETICAL_OR_DREAM)은 temporalContextType을 정확히 구분하고 해당 불확실성 플래그를 추가하세요.',
    '5. 기존에 등록된 인물 관계, 연표 사건, 복선과 동일한 대상에 대한 변화라면 proposedAction="UPDATE"와 existingTargetEntityId를 지정하세요.',
    '6. 기존 작가 확정(CANON) 설정과 충돌하는 내용이라면 임의로 덮어쓰지 말고 uncertaintyFlags에 "CONFLICTS_WITH_CANON"을 포함하여 제안 후보로만 제출하세요.',
  ].join('\n');
}

function buildExtractionUserPrompt(ctx: ManuscriptExtractionPromptContext): string {
  const charList = ctx.characters.map((c) => ({
    id: c.id,
    name: c.name,
    role: c.role,
    canonStatus: c.canonStatus || c.status,
  }));

  const relList = ctx.relationships.map((r) => ({
    id: r.id,
    sourceCharacterId: r.sourceCharacterId,
    targetCharacterId: r.targetCharacterId,
    relationType: r.relationType,
    affinityScore: r.affinityScore,
    isDirectional: r.isDirectional,
    canonStatus: r.canonStatus,
  }));

  const evtList = ctx.timelineEvents.map((e) => ({
    id: e.id,
    title: e.title,
    episodeId: e.episodeId,
    inUniverseDate: e.inUniverseDate,
    chronologicalOrder: e.chronologicalOrder,
    canonStatus: e.canonStatus,
  }));

  const fshList = ctx.foreshadowings.map((f) => ({
    id: f.id,
    title: f.title,
    cluePhase: f.cluePhase,
    plantedEpisodeId: f.plantedEpisodeId,
    resolvedEpisodeId: f.resolvedEpisodeId,
    canonStatus: f.canonStatus,
  }));

  const sceneList = ctx.scenes.map((s) => ({
    id: s.id,
    sceneNumber: s.sceneNumber,
    title: s.title,
    location: s.location,
  }));

  const worldList = ctx.worldbuilding.map((w) => ({
    id: w.id,
    title: w.title,
    category: w.category,
  }));

  return [
    `[회차 정보]`,
    `- 회차 ID: ${ctx.episode.id}`,
    `- 회차 번호: 제${ctx.episode.episodeNumber}화 (${ctx.episode.title})`,
    `- 리비전 ID: ${ctx.revision.id}`,
    '',
    `[등록된 등장인물 목록]`,
    JSON.stringify(charList, null, 2),
    '',
    `[기존 인물 관계 목록]`,
    JSON.stringify(relList, null, 2),
    '',
    `[기존 연표 사건 목록]`,
    JSON.stringify(evtList, null, 2),
    '',
    `[기존 복선(Foreshadowing) 목록]`,
    JSON.stringify(fshList, null, 2),
    '',
    `[현재 회차 장면(Scene) 목록]`,
    JSON.stringify(sceneList, null, 2),
    '',
    `[세계관/장소 항목 목록]`,
    JSON.stringify(worldList, null, 2),
    '',
    `[분석 대상 원고 (Revision.content 시작)]`,
    ctx.revision.content,
    `[분석 대상 원고 (Revision.content 끝)]`,
  ].join('\n');
}

async function loadAuthoritativeContextFromFirestore(params: {
  db: Firestore;
  ownerId: string;
  projectId: string;
  episodeId: string;
  revisionId: string;
}): Promise<{
  episode: Episode;
  revision: Revision;
  scenes: Scene[];
  characters: Character[];
  worldbuilding: WorldbuildingItem[];
  relationships: CharacterRelationship[];
  timelineEvents: TimelineEvent[];
  foreshadowings: Foreshadowing[];
  existingProposals: ChangeProposal[];
}> {
  const { db, ownerId, projectId, episodeId, revisionId } = params;
  const projectBasePath = `users/${ownerId}/projects/${projectId}`;

  const projectSnap = await db.doc(projectBasePath).get();
  if (!projectSnap.exists) {
    throw new Error(
      `[PROJECT_NOT_FOUND] 프로젝트(${projectId})가 존재하지 않거나 접근 권한이 없습니다.`
    );
  }
  const projectData = projectSnap.data() as { ownerId?: string } | undefined;
  if (projectData?.ownerId && projectData.ownerId !== ownerId) {
    throw new Error(
      `[PROJECT_OWNERSHIP_MISMATCH] 요청자의 UID(${ownerId})가 프로젝트 소유자와 일치하지 않습니다.`
    );
  }

  const [
    episodeSnap,
    revisionSnap,
    scenesSnap,
    charactersSnap,
    worldSnap,
    relSnap,
    evtSnap,
    fshSnap,
    proposalsSnap,
  ] = await Promise.all([
    db.doc(`${projectBasePath}/episodes/${episodeId}`).get(),
    db.doc(`${projectBasePath}/revisions/${revisionId}`).get(),
    db.collection(`${projectBasePath}/scenes`).get(),
    db.collection(`${projectBasePath}/characters`).get(),
    db.collection(`${projectBasePath}/worldbuilding`).get(),
    db.collection(`${projectBasePath}/relationships`).get(),
    db.collection(`${projectBasePath}/timelineEvents`).get(),
    db.collection(`${projectBasePath}/foreshadowings`).get(),
    db.collection(`${projectBasePath}/changeProposals`).get(),
  ]);

  if (!episodeSnap.exists) {
    throw new Error(
      `[EPISODE_NOT_FOUND] 서버에 저장된 회차(${episodeId})를 찾을 수 없습니다.`
    );
  }
  if (!revisionSnap.exists) {
    throw new Error(
      `[REVISION_NOT_FOUND] 서버에 저장된 리비전(${revisionId})을 찾을 수 없습니다. 원고를 먼저 저장하고 리비전을 생성해 주세요.`
    );
  }

  const episode = episodeSnap.data() as Episode;
  const revision = revisionSnap.data() as Revision;

  if (episode.projectId !== projectId || revision.projectId !== projectId) {
    throw new Error(
      `[TENANT_ISOLATION_ERROR] 회차 또는 리비전의 projectId가 요청된 projectId(${projectId})와 일치하지 않습니다.`
    );
  }
  if (revision.episodeId !== episodeId) {
    throw new Error(
      `[REVISION_EPISODE_MISMATCH] 리비전(${revisionId})이 요청된 회차(${episodeId})에 속하지 않습니다.`
    );
  }
  if (!revision.content || revision.content.trim().length === 0) {
    throw new Error(
      `[EMPTY_REVISION_CONTENT] 선택된 리비전(${revisionId})의 원고 본문이 비어 있어 분석할 수 없습니다.`
    );
  }

  const scenes = scenesSnap.docs
    .map((d) => d.data() as Scene)
    .filter((s) => s.episodeId === episodeId);
  const characters = charactersSnap.docs.map((d) => d.data() as Character);
  const worldbuilding = worldSnap.docs.map((d) => d.data() as WorldbuildingItem);
  const relationships = relSnap.docs.map((d) => d.data() as CharacterRelationship);
  const timelineEvents = evtSnap.docs.map((d) => d.data() as TimelineEvent);
  const foreshadowings = fshSnap.docs.map((d) => d.data() as Foreshadowing);
  const existingProposals = proposalsSnap.docs.map((d) =>
    normalizeChangeProposalFromFirestore(
      (d.data() || {}) as Record<string, unknown>,
      d.id
    )
  );

  return {
    episode,
    revision,
    scenes,
    characters,
    worldbuilding,
    relationships,
    timelineEvents,
    foreshadowings,
    existingProposals,
  };
}

/**
 * Atomically persists verified ChangeProposals to Firestore using deterministic proposal IDs
 * (`prop_${hash(fingerprint)}`) and Firestore transactions (`db.runTransaction`) to guarantee:
 * 1. Native Admin SDK `Timestamp` objects for `createdAt` and `updatedAt`.
 * 2. No duplicate proposals created across concurrent or repeated requests.
 * 3. Existing `PROPOSED`, `CANON`, `REJECTED`, or `ARCHIVED` proposals are never overwritten,
 *    and their original `createdAt` and immutable fields are strictly preserved.
 */
export async function persistVerifiedProposalsAtomicallyToFirestore(params: {
  db: Firestore;
  ownerId: string;
  projectId: string;
  selectedCandidates: VerifiedExtractionCandidate[];
}): Promise<{
  savedProposals: ChangeProposal[];
  itemResults: SavedProposalItemResult[];
  createdCount: number;
  skippedDuplicateCount: number;
}> {
  const { db, ownerId, projectId, selectedCandidates } = params;
  if (selectedCandidates.length === 0) {
    return {
      savedProposals: [],
      itemResults: [],
      createdCount: 0,
      skippedDuplicateCount: 0,
    };
  }

  const basePath = `users/${ownerId}/projects/${projectId}/changeProposals`;
  const collectionRef = db.collection(basePath);

  const savedProposals: ChangeProposal[] = [];
  const itemResults: SavedProposalItemResult[] = [];
  let createdCount = 0;
  let skippedDuplicateCount = 0;

  const mapCanonStatusToSkipDisposition = (
    status: CanonStatus
  ): ProposalSaveDisposition => {
    if (status === 'CANON') return 'SKIPPED_EXISTING_CANON';
    if (status === 'REJECTED') return 'SKIPPED_EXISTING_REJECTED';
    if (status === 'ARCHIVED') return 'SKIPPED_EXISTING_ARCHIVED';
    return 'SKIPPED_EXISTING_PROPOSED';
  };

  for (const candidate of selectedCandidates) {
    if (!candidate.proposalDraft || !candidate.verification.verifiedSpan) {
      continue;
    }

    const deterministicId = computeDeterministicProposalId(candidate.fingerprint);
    const proposalToWrite: ChangeProposal = {
      ...candidate.proposalDraft,
      id: deterministicId,
      ownerId,
      projectId,
      canonStatus: 'PROPOSED',
      createdBy: 'AI_ENGINE',
    };

    const validation = validateChangeProposalInput(proposalToWrite);
    if (!validation.valid) {
      throw new Error(
        `[INVALID_PROPOSAL_SCHEMA] 제안서(${deterministicId}) 스키마 검증 실패: ${validation.error}`
      );
    }

    const docRef = db.doc(`${basePath}/${deterministicId}`);

    if (typeof db.runTransaction === 'function') {
      const txResult = await db.runTransaction(async (tx: Transaction) => {
        let existingSnap;
        try {
          existingSnap = await tx.get(docRef);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(
            `[TRANSACTION_READ_FAILED] 트랜잭션 내부 제안서 문서 조회(${docRef.path})에 실패하여 원자적 저장을 중단했습니다: ${detail}`
          );
        }
        if (existingSnap.exists) {
          const existingNormalized = normalizeChangeProposalFromFirestore(
            (existingSnap.data() || {}) as Record<string, unknown>,
            deterministicId
          );
          return {
            disposition: mapCanonStatusToSkipDisposition(
              existingNormalized.canonStatus
            ),
            proposal: existingNormalized,
          };
        }

        // Phase 4.2.2 Stage 1.5: Strict transactional protection for legacy random-ID proposals
        // Read collection strictly via tx.get(collectionRef) inside the transaction (never fall back to non-transactional collectionRef.get()).
        let allProposalsSnap: { docs: Array<{ id: string; data: () => unknown }> };
        try {
          const maybeQuerySnap = await (
            tx.get as unknown as (q: unknown) => Promise<{
              docs?: Array<{ id: string; data: () => unknown }>;
            }>
          )(collectionRef);
          if (!maybeQuerySnap || !Array.isArray(maybeQuerySnap.docs)) {
            throw new Error(
              'tx.get(collectionRef) did not return a valid QuerySnapshot'
            );
          }
          allProposalsSnap = { docs: maybeQuerySnap.docs };
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(
            `[TRANSACTION_READ_FAILED] 트랜잭션 내부 제안서 컬렉션 조회에 실패하여 원자적 저장을 중단했습니다: ${detail}`
          );
        }

        const existingProposals = allProposalsSnap.docs.map((d) =>
          normalizeChangeProposalFromFirestore(
            (d.data() || {}) as Record<string, unknown>,
            d.id
          )
        );

        const dupCheck = checkDuplicateProposalStatus({
          fingerprint: candidate.fingerprint,
          sourceRevisionId: proposalToWrite.sourceRevisionId,
          targetEntityType: candidate.targetEntityType,
          proposedAction: candidate.proposedAction,
          targetEntityId: proposalToWrite.targetEntityId,
          verifiedSpan: candidate.verification.verifiedSpan,
          existingProposals,
        });

        if (dupCheck.duplicateStatus !== 'NONE' && dupCheck.existingProposalId) {
          const legacyDocRef = db.doc(`${basePath}/${dupCheck.existingProposalId}`);
          let lockedLegacySnap;
          try {
            lockedLegacySnap = await tx.get(legacyDocRef);
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(
              `[TRANSACTION_READ_FAILED] 트랜잭션 내부 레거시 제안서 조회(${legacyDocRef.path})에 실패하여 원자적 저장을 중단했습니다: ${detail}`
            );
          }
          const matchedExisting = lockedLegacySnap.exists
            ? normalizeChangeProposalFromFirestore(
                (lockedLegacySnap.data() || {}) as Record<string, unknown>,
                dupCheck.existingProposalId
              )
            : existingProposals.find((p) => p.id === dupCheck.existingProposalId) ||
              proposalToWrite;

          return {
            disposition: mapCanonStatusToSkipDisposition(
              matchedExisting.canonStatus
            ),
            proposal: matchedExisting,
          };
        }

        const firestoreDoc = serializeChangeProposalForFirestoreWrite({
          proposal: proposalToWrite,
          ownerId,
          projectId,
          existingDoc: null,
        });
        tx.set(docRef, firestoreDoc);

        const normalizedSaved = normalizeChangeProposalFromFirestore(
          firestoreDoc as unknown as Record<string, unknown>,
          deterministicId
        );
        return {
          disposition: 'CREATED_NEW' as ProposalSaveDisposition,
          proposal: normalizedSaved,
        };
      });

      if (txResult.disposition === 'CREATED_NEW') {
        createdCount++;
        savedProposals.push(txResult.proposal);
      } else {
        skippedDuplicateCount++;
      }
      itemResults.push({
        candidateId: candidate.candidateId,
        proposalId: txResult.proposal.id,
        fingerprint: candidate.fingerprint,
        disposition: txResult.disposition,
        proposal: txResult.proposal,
      });
    } else {
      // Fallback if mock DB does not implement runTransaction
      const existingSnap = await docRef.get();
      if (existingSnap.exists) {
        const existingNormalized = normalizeChangeProposalFromFirestore(
          (existingSnap.data() || {}) as Record<string, unknown>,
          deterministicId
        );
        skippedDuplicateCount++;
        itemResults.push({
          candidateId: candidate.candidateId,
          proposalId: existingNormalized.id,
          fingerprint: candidate.fingerprint,
          disposition: mapCanonStatusToSkipDisposition(
            existingNormalized.canonStatus
          ),
          proposal: existingNormalized,
        });
        continue;
      }

      const firestoreDoc = serializeChangeProposalForFirestoreWrite({
        proposal: proposalToWrite,
        ownerId,
        projectId,
        existingDoc: null,
      });
      await docRef.set(firestoreDoc);
      const normalizedSaved = normalizeChangeProposalFromFirestore(
        firestoreDoc as unknown as Record<string, unknown>,
        deterministicId
      );
      createdCount++;
      savedProposals.push(normalizedSaved);
      itemResults.push({
        candidateId: candidate.candidateId,
        proposalId: normalizedSaved.id,
        fingerprint: candidate.fingerprint,
        disposition: 'CREATED_NEW',
        proposal: normalizedSaved,
      });
    }
  }

  return {
    savedProposals,
    itemResults,
    createdCount,
    skippedDuplicateCount,
  };
}

function resolveExecutionModeAndOwner(
  options?: ManuscriptExtractionEngineOptions,
  hasLocalPreviewSnapshot?: boolean
): {
  executionMode: ExtractionExecutionMode;
  ownerId: string;
  isCloudVerified: boolean;
} {
  if (options?.db || options?.testMode) {
    return {
      executionMode: 'TEST_ISOLATED',
      ownerId: options.verifiedOwnerId || 'test_isolated_owner',
      isCloudVerified: Boolean(options?.db),
    };
  }
  if (options?.verifiedOwnerId) {
    return {
      executionMode: 'CLOUD_AUTHENTICATED',
      ownerId: options.verifiedOwnerId,
      isCloudVerified: true,
    };
  }
  if (isServerCloudAuthEnforced()) {
    throw new Error(
      '[AUTH_REQUIRED] 클라우드 운영 환경에서는 유효한 Firebase ID 토큰 인증이 필수이며 LOCAL_PREVIEW 모드가 허용되지 않습니다.'
    );
  }
  if (!hasLocalPreviewSnapshot) {
    throw new Error(
      '[LOCAL_PREVIEW_SNAPSHOT_REQUIRED] 비로그인 로컬 미리보기 모드에서는 저장된 리비전 스냅샷(localPreviewSnapshot)이 필요합니다.'
    );
  }
  return {
    executionMode: 'LOCAL_PREVIEW',
    ownerId: 'local_preview_owner',
    isCloudVerified: false,
  };
}

/**
 * Executes Phase 4.2.1 AI manuscript extraction and server-side UTF-16 offset verification.
 * Default behavior (`persistProposals = false`): analyzes the manuscript, verifies candidates,
 * issues a tamper-proof `analysisRunId` + `analysisToken`, and writes 0 proposals to Firestore.
 * If `persistProposals === true` is passed, `selectedCandidateIds` MUST be a non-empty array.
 */
export async function executeServerManuscriptExtraction(
  request: ManuscriptExtractionRequest,
  options?: ManuscriptExtractionEngineOptions
): Promise<ManuscriptExtractionResponse> {
  const startedAtIso = new Date().toISOString();
  const startTimeMs = Date.now();
  const requestId = `ext_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (!isValidEntityId(request.projectId)) {
    throw new Error('유효하지 않은 projectId 형식입니다.');
  }
  if (!isValidEntityId(request.episodeId)) {
    throw new Error('유효하지 않은 episodeId 형식입니다.');
  }
  if (!isValidEntityId(request.revisionId)) {
    throw new Error('유효하지 않은 revisionId 형식입니다.');
  }

  // Enforce Section 4.2 Rule 4: if persistProposals is true, empty/omitted selectedCandidateIds is rejected immediately
  if (request.persistProposals) {
    if (
      !Array.isArray(request.selectedCandidateIds) ||
      request.selectedCandidateIds.length === 0
    ) {
      throw new Error(
        '[EMPTY_SELECTION_FORBIDDEN] persistProposals=true 요청에는 비어 있지 않은 selectedCandidateIds 배열이 필수입니다. 빈 선택으로 전체 후보를 자동 저장할 수 없습니다.'
      );
    }
  }

  // Concurrency check against AI writing pipeline and duplicate extraction runs
  if (isEpisodeLocked(request.projectId, request.episodeId)) {
    throw new Error(
      `[EPISODE_LOCKED] 현재 회차(${request.episodeId})에서 AI 집필 파이프라인이 실행 중입니다. 완료 후 분석을 실행해 주세요.`
    );
  }
  const lockKey = `${request.projectId}:${request.episodeId}:${request.revisionId}`;
  if (activeExtractionLocks.has(lockKey)) {
    throw new Error(
      `[EXTRACTION_ALREADY_RUNNING] 동일한 리비전(${request.revisionId})에 대한 AI 추출 분석이 이미 진행 중입니다.`
    );
  }

  activeExtractionLocks.add(lockKey);

  try {
    const { executionMode, ownerId, isCloudVerified } =
      resolveExecutionModeAndOwner(options, Boolean(request.localPreviewSnapshot));

    let episode: Episode;
    let revision: Revision;
    let scenes: Scene[];
    let characters: Character[];
    let worldbuilding: WorldbuildingItem[];
    let relationships: CharacterRelationship[];
    let timelineEvents: TimelineEvent[];
    let foreshadowings: Foreshadowing[];
    let existingProposals: ChangeProposal[];
    let activeDb: Firestore | null = null;

    if (
      executionMode === 'CLOUD_AUTHENTICATED' ||
      executionMode === 'TEST_ISOLATED'
    ) {
      activeDb = resolveExtractionFirestoreInstance(options);
      const loaded = await loadAuthoritativeContextFromFirestore({
        db: activeDb,
        ownerId,
        projectId: request.projectId,
        episodeId: request.episodeId,
        revisionId: request.revisionId,
      });
      episode = loaded.episode;
      revision = loaded.revision;
      scenes = loaded.scenes;
      characters = loaded.characters;
      worldbuilding = loaded.worldbuilding;
      relationships = loaded.relationships;
      timelineEvents = loaded.timelineEvents;
      foreshadowings = loaded.foreshadowings;
      existingProposals = loaded.existingProposals;
    } else {
      // LOCAL_PREVIEW mode (strictly isolated from Cloud Firestore)
      const snap = request.localPreviewSnapshot!;
      if (
        snap.episode.id !== request.episodeId ||
        snap.revision.id !== request.revisionId ||
        snap.revision.episodeId !== request.episodeId
      ) {
        throw new Error(
          '[LOCAL_PREVIEW_MISMATCH] 요청된 회차/리비전 ID가 로컬 스냅샷 데이터와 일치하지 않습니다.'
        );
      }
      if (!snap.revision.content || snap.revision.content.trim().length === 0) {
        throw new Error(
          '[EMPTY_REVISION_CONTENT] 로컬 리비전 원고 본문이 비어 있어 분석할 수 없습니다.'
        );
      }

      episode = {
        id: snap.episode.id,
        ownerId,
        projectId: request.projectId,
        episodeNumber: snap.episode.episodeNumber,
        title: snap.episode.title,
        content: snap.revision.content,
        synopsis: '',
        authorNote: '',
        charCountWithSpaces: snap.revision.content.length,
        charCountWithoutSpaces: snap.revision.content.replace(/\s+/g, '').length,
        status: 'draft',
        linkedCharacterIds: [],
        linkedWorldbuildingIds: [],
        latestRevisionId: snap.revision.id,
        createdAt: startedAtIso,
        updatedAt: startedAtIso,
      };
      revision = {
        id: snap.revision.id,
        ownerId,
        projectId: request.projectId,
        episodeId: snap.episode.id,
        episodeTitle: snap.episode.title,
        content: snap.revision.content,
        charCountWithSpaces: snap.revision.content.length,
        label: 'Local Revision',
        createdAt: startedAtIso,
      };
      scenes = (snap.scenes || []).map((s) => ({
        id: s.id,
        ownerId,
        projectId: request.projectId,
        episodeId: s.episodeId,
        sceneNumber: s.sceneNumber,
        title: s.title,
        summary: s.summary,
        location: s.location,
        pointOfViewCharacterId: '',
        eventIds: [],
        characterIds: [],
        foreshadowingIds: [],
        canonStatus: 'DRAFT',
        sourceRevisionId: snap.revision.id,
        createdAt: startedAtIso,
        updatedAt: startedAtIso,
      }));
      characters = (snap.characters || []).map((c) => ({
        id: c.id,
        ownerId,
        projectId: request.projectId,
        name: c.name,
        role: c.role,
        affiliation: '',
        appearance: '',
        personality: '',
        background: c.description || '',
        abilities: '',
        status: c.canonStatus === 'CANON' ? 'confirmed' : 'draft',
        canonStatus: c.canonStatus || 'DRAFT',
        linkedEpisodeIds: [],
        linkedWorldbuildingIds: [],
        createdAt: startedAtIso,
        updatedAt: startedAtIso,
      }));
      worldbuilding = (snap.worldbuilding || []).map((w) => ({
        id: w.id,
        ownerId,
        projectId: request.projectId,
        title: w.title,
        category: w.category,
        summary: '',
        content: w.content,
        rules: '',
        status: w.canonStatus === 'CANON' ? 'confirmed' : 'draft',
        canonStatus: w.canonStatus || 'DRAFT',
        linkedCharacterIds: [],
        linkedEpisodeIds: [],
        createdAt: startedAtIso,
        updatedAt: startedAtIso,
      }));
      relationships = snap.relationships || [];
      timelineEvents = snap.timelineEvents || [];
      foreshadowings = snap.foreshadowings || [];
      existingProposals = snap.existingProposals || [];
    }

    const promptContext: ManuscriptExtractionPromptContext = {
      projectId: request.projectId,
      episode,
      revision,
      scenes,
      characters,
      worldbuilding,
      relationships,
      timelineEvents,
      foreshadowings,
    };

    let rawAiOutput: unknown;
    let tokenUsage: TokenUsageMetadata | null = null;
    let modelId =
      process.env.GEMINI_EXTRACTION_MODEL || DEFAULT_EXTRACTION_MODEL;

    if (options?.mockExtractorFn) {
      const mockResult = await options.mockExtractorFn(promptContext);
      rawAiOutput = mockResult.rawResponse;
      tokenUsage = mockResult.tokenUsage ?? null;
      if (mockResult.modelId) {
        modelId = mockResult.modelId;
      }
    } else {
      const ai = getGenAiClient();
      const response = await ai.models.generateContent({
        model: modelId,
        contents: buildExtractionUserPrompt(promptContext),
        config: {
          systemInstruction: buildExtractionSystemInstruction(),
          responseMimeType: 'application/json',
          responseSchema: GEMINI_MANUSCRIPT_EXTRACTION_SCHEMA,
          temperature: 0.1,
        },
      });

      rawAiOutput = response.text || '{}';
      if (response.usageMetadata) {
        const promptTok = response.usageMetadata.promptTokenCount ?? 0;
        const candTok = response.usageMetadata.candidatesTokenCount ?? 0;
        const totalTok =
          response.usageMetadata.totalTokenCount ?? promptTok + candTok;
        tokenUsage = {
          promptTokenCount: promptTok,
          candidatesTokenCount: candTok,
          totalTokenCount: totalTok,
          estimatedCostUsd: Number(
            (promptTok * 0.00000015 + candTok * 0.0000006).toFixed(6)
          ),
          isActualUsage: true,
        };
      }
    }

    const sanitized = parseAndSanitizeAiExtractionResponse(rawAiOutput);
    if (!sanitized.valid || !sanitized.data) {
      throw new Error(
        sanitized.error || 'AI 추출 응답을 구조화된 스키마로 검증하는 데 실패했습니다.'
      );
    }

    const verifiedCandidates: VerifiedExtractionCandidate[] =
      verifyAndConvertExtractionCandidates(sanitized.data.candidates, {
        ownerId,
        projectId: request.projectId,
        episode,
        revision,
        scenes,
        characters,
        worldbuilding,
        relationships,
        timelineEvents,
        foreshadowings,
        existingProposals,
        selectedCandidateSpanOverrides: request.selectedCandidateSpanOverrides,
        allowUpdateRejected: false,
      });

    const revisionContentHash = computeRevisionContentHash(revision.content);
    const analysisRunId = `run_${revision.id}_${Date.now()}_${crypto
      .randomBytes(4)
      .toString('hex')}`;
    const analysisToken = issueSignedAnalysisToken({
      analysisRunId,
      executionMode,
      ownerId,
      projectId: request.projectId,
      episodeId: episode.id,
      revisionId: revision.id,
      revisionContentHash,
      candidates: verifiedCandidates,
    });

    // Optional explicit persistence when persistProposals === true AND non-empty selectedCandidateIds is provided
    let savedProposals: ChangeProposal[] = [];
    if (request.persistProposals) {
      const selectionCheck = validateSelectedCandidateIdsForSave({
        selectedCandidateIds: request.selectedCandidateIds,
        candidates: verifiedCandidates,
      });
      if (!selectionCheck.valid) {
        throw new Error(selectionCheck.error);
      }

      if (
        (executionMode === 'CLOUD_AUTHENTICATED' ||
          executionMode === 'TEST_ISOLATED') &&
        activeDb
      ) {
        const persisted = await persistVerifiedProposalsAtomicallyToFirestore({
          db: activeDb,
          ownerId,
          projectId: request.projectId,
          selectedCandidates: selectionCheck.selectedCandidates,
        });
        savedProposals = persisted.savedProposals;
      } else if (executionMode === 'LOCAL_PREVIEW') {
        savedProposals = selectionCheck.selectedCandidates.map(
          (c) => c.proposalDraft!
        );
      }
    }

    const completedAtIso = new Date().toISOString();
    const verifiedCount = verifiedCandidates.filter(
      (c) => c.verification.status === 'VERIFIED'
    ).length;
    const ambiguousCount = verifiedCandidates.filter(
      (c) => c.verification.status === 'AMBIGUOUS_MULTIPLE_MATCHES'
    ).length;
    const unverifiedCount = verifiedCandidates.filter(
      (c) => c.verification.status === 'UNVERIFIED_EXCERPT'
    ).length;
    const duplicateSkippedCount = verifiedCandidates.filter(
      (c) => c.duplicateStatus !== 'NONE'
    ).length;

    return {
      success: true,
      executionMode,
      isCloudVerified,
      analysisRunId,
      analysisToken,
      analysisSummary: sanitized.data.analysis_summary,
      episodeId: episode.id,
      revisionId: revision.id,
      revisionContentHash,
      revisionLength: revision.content.length,
      candidates: verifiedCandidates,
      savedProposals,
      audit: {
        requestId,
        executionMode,
        isCloudVerified,
        ownerId,
        projectId: request.projectId,
        episodeId: episode.id,
        revisionId: revision.id,
        modelId,
        startedAt: startedAtIso,
        completedAt: completedAtIso,
        latencyMs: Math.max(1, Date.now() - startTimeMs),
        totalRawCandidates: sanitized.data.candidates.length,
        verifiedCount,
        ambiguousCount,
        unverifiedCount,
        duplicateSkippedCount,
        persistedProposalCount: savedProposals.length,
        tokenUsage,
      },
    };
  } finally {
    activeExtractionLocks.delete(lockKey);
  }
}

/**
 * Step 5A: Saves author-selected verified extraction candidates as `PROPOSED` ChangeProposals
 * WITHOUT re-calling the Gemini API.
 * Enforces:
 * - Tamper-proof `analysisRunId` + `analysisToken` verification
 * - Explicit non-empty `selectedCandidateIds` validation (0 saved on empty/omitted)
 * - Authoritative `Revision.content` SHA/fingerprint unchanged check
 * - Server-side UTF-16 `[startOffset, endOffset)` re-verification (including multi-match span disambiguation)
 * - Atomic Firestore transaction persistence with native `Timestamp` (`createdAt`, `updatedAt`)
 */
export async function saveVerifiedExtractionProposalsOnServer(
  request: SaveExtractionProposalsRequest,
  options?: ManuscriptExtractionEngineOptions
): Promise<SaveExtractionProposalsResponse> {
  if (!isValidEntityId(request.projectId)) {
    throw new Error('[BAD_REQUEST] 유효하지 않은 projectId 형식입니다.');
  }
  if (!isValidEntityId(request.episodeId)) {
    throw new Error('[BAD_REQUEST] 유효하지 않은 episodeId 형식입니다.');
  }
  if (!isValidEntityId(request.revisionId)) {
    throw new Error('[BAD_REQUEST] 유효하지 않은 revisionId 형식입니다.');
  }

  // Enforce non-empty selectedCandidateIds before any DB write
  if (
    !Array.isArray(request.selectedCandidateIds) ||
    request.selectedCandidateIds.length === 0
  ) {
    throw new Error(
      '[EMPTY_SELECTION_FORBIDDEN] 저장할 후보를 1개 이상 명시적으로 선택해야 합니다(selectedCandidateIds 필수). 빈 선택으로 전체 후보를 자동 저장할 수 없습니다.'
    );
  }

  const { executionMode, ownerId, isCloudVerified } =
    resolveExecutionModeAndOwner(options, Boolean(request.localPreviewSnapshot));

  // Verify signed analysis token (ensures candidates came from server analysis, not client fabrication)
  const tokenPayload = verifySignedAnalysisToken({
    analysisRunId: request.analysisRunId,
    analysisToken: request.analysisToken,
    expectedOwnerId: ownerId,
    expectedExecutionMode: executionMode,
    expectedProjectId: request.projectId,
    expectedEpisodeId: request.episodeId,
    expectedRevisionId: request.revisionId,
  });

  let authoritativeRevisionContent: string;
  let existingProposals: ChangeProposal[] = [];
  let activeDb: Firestore | null = null;

  if (
    executionMode === 'CLOUD_AUTHENTICATED' ||
    executionMode === 'TEST_ISOLATED'
  ) {
    activeDb = resolveExtractionFirestoreInstance(options);
    const loaded = await loadAuthoritativeContextFromFirestore({
      db: activeDb,
      ownerId,
      projectId: request.projectId,
      episodeId: request.episodeId,
      revisionId: request.revisionId,
    });
    authoritativeRevisionContent = loaded.revision.content;
    existingProposals = loaded.existingProposals;
  } else {
    const snap = request.localPreviewSnapshot!;
    if (
      snap.episode.id !== request.episodeId ||
      snap.revision.id !== request.revisionId ||
      snap.revision.episodeId !== request.episodeId
    ) {
      throw new Error(
        '[LOCAL_PREVIEW_MISMATCH] 요청된 회차/리비전 ID가 로컬 스냅샷 데이터와 일치하지 않습니다.'
      );
    }
    authoritativeRevisionContent = snap.revision.content || '';
    existingProposals = snap.existingProposals || [];
  }

  // Verify Revision.content has not changed since analysis
  const currentRevisionHash = computeRevisionContentHash(
    authoritativeRevisionContent
  );
  if (currentRevisionHash !== tokenPayload.revisionContentHash) {
    throw new Error(
      '[REVISION_CHANGED_SINCE_ANALYSIS] 분석 이후 리비전 원고(Revision.content)가 수정되었습니다. 최신 리비전에 대해 AI 분석을 다시 실행해 주세요.'
    );
  }

  // Apply author span overrides (for AMBIGUOUS_MULTIPLE_MATCHES) and re-verify UTF-16 spans against authoritative Revision.content
  const candidatesForSave = tokenPayload.candidates.map((cand) => {
    const override = request.selectedCandidateSpanOverrides?.[cand.candidateId];
    const resolvedCand = override
      ? applyAuthorSpanDisambiguationToCandidate({
          candidate: cand,
          selectedSpan: override,
          revisionContent: authoritativeRevisionContent,
          ownerId,
          projectId: request.projectId,
          existingProposals,
        })
      : cand;

    // Re-verify UTF-16 [startOffset, endOffset) against authoritative Revision.content
    if (
      resolvedCand.verification.status === 'VERIFIED' &&
      resolvedCand.verification.verifiedSpan
    ) {
      const span = resolvedCand.verification.verifiedSpan;
      const validSlice =
        span.startOffset >= 0 &&
        span.endOffset > span.startOffset &&
        span.endOffset <= authoritativeRevisionContent.length &&
        !isUtf16SurrogateSplit(authoritativeRevisionContent, span.startOffset) &&
        !isUtf16SurrogateSplit(authoritativeRevisionContent, span.endOffset) &&
        authoritativeRevisionContent.slice(span.startOffset, span.endOffset) ===
          span.matchedText;

      if (!validSlice) {
        return {
          ...resolvedCand,
          verification: {
            ...resolvedCand.verification,
            status: 'UNVERIFIED_EXCERPT' as const,
            verifiedSpan: null,
            reason:
              '저장 시점 서버 재검증에서 발췌문 UTF-16 오프셋이 리비전 원문과 일치하지 않습니다.',
          },
          canSaveAsProposal: false,
          cannotSaveReason:
            '저장 시점 서버 재검증에서 발췌문 UTF-16 오프셋이 리비전 원문과 일치하지 않습니다.',
          proposalDraft: null,
        };
      }
    }

    return resolvedCand;
  });

  // Validate selectedCandidateIds against the re-verified candidates
  const selectionCheck = validateSelectedCandidateIdsForSave({
    selectedCandidateIds: request.selectedCandidateIds,
    candidates: candidatesForSave,
  });

  if (!selectionCheck.valid) {
    throw new Error(selectionCheck.error);
  }

  let savedProposals: ChangeProposal[] = [];
  let itemResults: SavedProposalItemResult[] = [];
  let createdCount = 0;
  let skippedDuplicateCount = 0;

  if (
    (executionMode === 'CLOUD_AUTHENTICATED' ||
      executionMode === 'TEST_ISOLATED') &&
    activeDb
  ) {
    const persisted = await persistVerifiedProposalsAtomicallyToFirestore({
      db: activeDb,
      ownerId,
      projectId: request.projectId,
      selectedCandidates: selectionCheck.selectedCandidates,
    });
    savedProposals = persisted.savedProposals;
    itemResults = persisted.itemResults;
    createdCount = persisted.createdCount;
    skippedDuplicateCount = persisted.skippedDuplicateCount;
  } else {
    // LOCAL_PREVIEW mode: never writes to Cloud Firestore; returns verified PROPOSED drafts for local storage
    for (const candidate of selectionCheck.selectedCandidates) {
      const deterministicId = computeDeterministicProposalId(candidate.fingerprint);
      const dupCheck = checkDuplicateProposalStatus({
        fingerprint: candidate.fingerprint,
        sourceRevisionId: request.revisionId,
        targetEntityType: candidate.targetEntityType,
        proposedAction: candidate.proposedAction,
        targetEntityId: candidate.targetEntityId,
        verifiedSpan: candidate.verification.verifiedSpan,
        existingProposals,
      });

      if (dupCheck.duplicateStatus !== 'NONE' && dupCheck.existingProposalId) {
        const matchedExisting =
          existingProposals.find((p) => p.id === dupCheck.existingProposalId) ||
          candidate.proposalDraft!;
        skippedDuplicateCount++;
        itemResults.push({
          candidateId: candidate.candidateId,
          proposalId: matchedExisting.id,
          fingerprint: candidate.fingerprint,
          disposition:
            dupCheck.duplicateStatus === 'EXISTING_CANON_APPLIED'
              ? 'SKIPPED_EXISTING_CANON'
              : dupCheck.duplicateStatus === 'EXISTING_REJECTED'
              ? 'SKIPPED_EXISTING_REJECTED'
              : 'SKIPPED_EXISTING_PROPOSED',
          proposal: matchedExisting,
        });
      } else {
        const localProposal: ChangeProposal = {
          ...candidate.proposalDraft!,
          id: deterministicId,
          ownerId,
          projectId: request.projectId,
          canonStatus: 'PROPOSED',
          createdBy: 'AI_ENGINE',
        };
        createdCount++;
        savedProposals.push(localProposal);
        itemResults.push({
          candidateId: candidate.candidateId,
          proposalId: localProposal.id,
          fingerprint: candidate.fingerprint,
          disposition: 'CREATED_NEW',
          proposal: localProposal,
        });
      }
    }
  }

  return {
    success: true,
    executionMode,
    isCloudVerified,
    analysisRunId: request.analysisRunId,
    projectId: request.projectId,
    episodeId: request.episodeId,
    revisionId: request.revisionId,
    selectedCount: selectionCheck.deduplicatedIds.length,
    createdCount,
    skippedDuplicateCount,
    savedProposals,
    itemResults,
    completedAt: new Date().toISOString(),
  };
}
