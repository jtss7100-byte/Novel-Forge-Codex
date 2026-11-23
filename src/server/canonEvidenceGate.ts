import crypto from 'node:crypto';
import { getApps } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type {
  RagRetrievedEvidenceItem,
  WritingContextBundle,
} from '../types/aiEngine';
import type {
  CanonEvidenceReport,
  CanonEvidenceStatus,
  CanonVerificationMode,
} from '../types/literaryRewriting';
import {
  ensureFirebaseAdminInitialized,
  getFirebaseDatabaseId,
  getIsolatedFirestoreBindingMetadata,
  hasCloudFirestoreCredentials,
} from './authMiddleware.ts';
import { retrieveVerifiedMemoryForWritingOnServer } from './ragEngine.ts';

export interface AuthoritativeCanonCharacterRecord {
  id: string;
  ownerId: string;
  projectId: string;
  name: string;
  role: string;
  affiliation: string;
  personality: string;
  abilities: string;
  appearance: string;
  status: 'draft' | 'confirmed';
  canonStatus?: string;
  sourceRevisionId?: string;
  updatedAt?: string;
}

export interface AuthoritativeCanonWorldbuildingRecord {
  id: string;
  ownerId: string;
  projectId: string;
  title: string;
  category: string;
  summary: string;
  rules: string;
  status: 'draft' | 'confirmed';
  canonStatus?: string;
  sourceRevisionId?: string;
  updatedAt?: string;
}

export interface AuthoritativeCanonLoreRecord {
  id: string;
  ownerId: string;
  projectId: string;
  title: string;
  canonStatus: string;
  sourceRevisionId?: string;
  updatedAt?: string;
}

export interface AuthoritativeProjectCanonSnapshot {
  projectExists: boolean;
  projectOwnerId: string | null;
  canonCharacters: AuthoritativeCanonCharacterRecord[];
  nonCanonCharacterIds: string[];
  canonWorldbuilding: AuthoritativeCanonWorldbuildingRecord[];
  nonCanonWorldbuildingIds: string[];
  canonRelationships: AuthoritativeCanonLoreRecord[];
  canonTimelineEvents: AuthoritativeCanonLoreRecord[];
  canonForeshadowings: AuthoritativeCanonLoreRecord[];
}

export interface ServerCanonVerificationOptions {
  db?: Firestore;
  cacheNamespace?: string;
  isAuthenticatedCloud?: boolean;
  enforceServerCanonGate?: boolean;
  isIsolatedUnitTestMode?: boolean;
  ragTimeoutMs?: number;
  customRagRetriever?: (params: {
    ownerId: string;
    context: WritingContextBundle;
    sceneQueryHint: string;
    topK: number;
  }) => Promise<RagRetrievedEvidenceItem[]>;
  customFirestoreReader?: (params: {
    ownerId: string;
    projectId: string;
  }) => Promise<AuthoritativeProjectCanonSnapshot | null>;
}

export interface ServerCanonVerificationResult {
  canonEvidence: CanonEvidenceReport;
  verifiedContext: WritingContextBundle;
  extraValidLoreIds: string[];
  shouldFailClosed: boolean;
  blockingFailureReason?: string;
}

export function computeCanonStateHash(input: {
  projectId: string;
  characters: Array<{ id: string; rev?: string; name?: string; rulesOrAbilities?: string }>;
  worldbuilding: Array<{ id: string; rev?: string; title?: string; rules?: string }>;
  loreIds: string[];
  ragChunks: Array<{ chunkId: string; sourceEntityId: string; sourceRevisionId: string }>;
}): string {
  const canonical = {
    projectId: input.projectId,
    characters: [...input.characters]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => ({
        id: c.id,
        rev: c.rev || '',
        name: c.name || '',
        rulesOrAbilities: c.rulesOrAbilities || '',
      })),
    worldbuilding: [...input.worldbuilding]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((w) => ({
        id: w.id,
        rev: w.rev || '',
        title: w.title || '',
        rules: w.rules || '',
      })),
    loreIds: [...new Set(input.loreIds)].sort(),
    ragChunks: [...input.ragChunks]
      .sort((a, b) => a.chunkId.localeCompare(b.chunkId))
      .map((r) => ({
        chunkId: r.chunkId,
        sourceEntityId: r.sourceEntityId,
        sourceRevisionId: r.sourceRevisionId,
      })),
  };
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function resolveAuthoritativeFirestoreDb(db?: Firestore): Firestore | null {
  if (db) return db;
  if (!hasCloudFirestoreCredentials()) return null;
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

async function readAuthoritativeProjectCanonFromFirestore(params: {
  db: Firestore;
  ownerId: string;
  projectId: string;
}): Promise<AuthoritativeProjectCanonSnapshot> {
  const { db, ownerId, projectId } = params;
  const basePath = `users/${ownerId}/projects/${projectId}`;

  const projectSnap = await db.doc(basePath).get();
  if (!projectSnap.exists) {
    return {
      projectExists: false,
      projectOwnerId: null,
      canonCharacters: [],
      nonCanonCharacterIds: [],
      canonWorldbuilding: [],
      nonCanonWorldbuildingIds: [],
      canonRelationships: [],
      canonTimelineEvents: [],
      canonForeshadowings: [],
    };
  }

  const projectData = projectSnap.data() || {};
  const projectOwnerId =
    typeof projectData.ownerId === 'string' ? projectData.ownerId.trim() : null;

  const [charSnap, wbSnap, relSnap, evtSnap, fshSnap] = await Promise.all([
    db.collection(`${basePath}/characters`).get(),
    db.collection(`${basePath}/worldbuilding`).get(),
    db.collection(`${basePath}/relationships`).get(),
    db.collection(`${basePath}/timelineEvents`).get(),
    db.collection(`${basePath}/foreshadowings`).get(),
  ]);

  const canonCharacters: AuthoritativeCanonCharacterRecord[] = [];
  const nonCanonCharacterIds: string[] = [];
  for (const d of charSnap.docs) {
    const data = d.data() || {};
    const id = String(data.id ?? d.id);
    const docOwner = String(data.ownerId ?? '');
    const docProj = String(data.projectId ?? '');
    const isCanon =
      docOwner === ownerId &&
      docProj === projectId &&
      (data.status === 'confirmed' || data.canonStatus === 'CANON');
    if (isCanon) {
      canonCharacters.push({
        id,
        ownerId: docOwner,
        projectId: docProj,
        name: String(data.name ?? ''),
        role: String(data.role ?? ''),
        affiliation: String(data.affiliation ?? ''),
        personality: String(data.personality ?? ''),
        abilities: String(data.abilities ?? ''),
        appearance: String(data.appearance ?? ''),
        status: 'confirmed',
        canonStatus:
          typeof data.canonStatus === 'string' ? data.canonStatus : 'CANON',
        sourceRevisionId:
          typeof data.sourceRevisionId === 'string'
            ? data.sourceRevisionId
            : '',
        updatedAt:
          typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
      });
    } else {
      nonCanonCharacterIds.push(id);
    }
  }

  const canonWorldbuilding: AuthoritativeCanonWorldbuildingRecord[] = [];
  const nonCanonWorldbuildingIds: string[] = [];
  for (const d of wbSnap.docs) {
    const data = d.data() || {};
    const id = String(data.id ?? d.id);
    const docOwner = String(data.ownerId ?? '');
    const docProj = String(data.projectId ?? '');
    const isCanon =
      docOwner === ownerId &&
      docProj === projectId &&
      (data.status === 'confirmed' || data.canonStatus === 'CANON');
    if (isCanon) {
      canonWorldbuilding.push({
        id,
        ownerId: docOwner,
        projectId: docProj,
        title: String(data.title ?? ''),
        category: String(data.category ?? ''),
        summary: String(data.summary ?? ''),
        rules: String(data.rules ?? ''),
        status: 'confirmed',
        canonStatus:
          typeof data.canonStatus === 'string' ? data.canonStatus : 'CANON',
        sourceRevisionId:
          typeof data.sourceRevisionId === 'string'
            ? data.sourceRevisionId
            : '',
        updatedAt:
          typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
      });
    } else {
      nonCanonWorldbuildingIds.push(id);
    }
  }

  const extractLore = (
    snap: FirebaseFirestore.QuerySnapshot
  ): AuthoritativeCanonLoreRecord[] => {
    const out: AuthoritativeCanonLoreRecord[] = [];
    for (const d of snap.docs) {
      const data = d.data() || {};
      if (
        String(data.ownerId ?? '') === ownerId &&
        String(data.projectId ?? '') === projectId &&
        data.canonStatus === 'CANON'
      ) {
        out.push({
          id: String(data.id ?? d.id),
          ownerId: String(data.ownerId ?? ''),
          projectId: String(data.projectId ?? ''),
          title: String(data.title ?? data.relationType ?? d.id),
          canonStatus: 'CANON',
          sourceRevisionId:
            typeof data.sourceRevisionId === 'string'
              ? data.sourceRevisionId
              : '',
          updatedAt:
            typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
        });
      }
    }
    return out;
  };

  return {
    projectExists: true,
    projectOwnerId,
    canonCharacters,
    nonCanonCharacterIds,
    canonWorldbuilding,
    nonCanonWorldbuildingIds,
    canonRelationships: extractLore(relSnap),
    canonTimelineEvents: extractLore(evtSnap),
    canonForeshadowings: extractLore(fshSnap),
  };
}

/**
 * Server-Verified CANON Evidence Gate for Literary Rewriting (Phase 4.3B Stage 2 P0-A).
 *
 * Security & Correctness Guarantees:
 * 1. NEVER trusts client-supplied `context.retrievedMemoryChunks`, `verifiedForWriting`, or `freshnessStatus`.
 * 2. When authoritative Firestore (Emulator / Cloud / Test DB) or custom reader is active, queries
 *    real CANON records by `(ownerId, projectId)` and discards/blocks unverified, draft, or cross-tenant claims.
 * 3. Distinguishes `VERIFIED` / `VERIFIED_EMPTY` / `UNAVAILABLE` / `STALE` / `UNAUTHORIZED` explicitly.
 * 4. Fails closed when CANON verification is UNAVAILABLE, STALE, or UNAUTHORIZED (except narrow explicit
 *    unverified typo-only preview flagged `verificationMode: 'UNVERIFIED'`, `canonConflictFree: false`).
 */
export async function verifyServerCanonEvidenceForRewrite(params: {
  ownerId: string;
  projectId: string;
  episodeId: string;
  context: WritingContextBundle;
  sceneQueryHint: string;
  allowUnverifiedTypoOnlyPreview?: boolean;
  serverOptions?: ServerCanonVerificationOptions;
}): Promise<ServerCanonVerificationResult> {
  const { ownerId, projectId, context, sceneQueryHint, serverOptions } = params;
  const verifiedAt = new Date().toISOString();
  const ragTimeoutMs = Math.max(100, serverOptions?.ragTimeoutMs ?? 2500);

  const authoritativeDb = resolveAuthoritativeFirestoreDb(serverOptions?.db);
  const isolatedMeta = getIsolatedFirestoreBindingMetadata(serverOptions?.db);
  const cacheNamespace =
    serverOptions?.cacheNamespace ?? isolatedMeta?.cacheNamespace;

  const hasFirestoreAuthority = Boolean(
    authoritativeDb || serverOptions?.customFirestoreReader
  );
  const mustEnforceGate = Boolean(
    hasFirestoreAuthority ||
      serverOptions?.isAuthenticatedCloud ||
      serverOptions?.enforceServerCanonGate ||
      serverOptions?.customRagRetriever
  );

  // Step 1: NEVER trust client-supplied retrievedMemoryChunks directly.
  const clientSuppliedChunks = Array.isArray(context.retrievedMemoryChunks)
    ? context.retrievedMemoryChunks
    : [];
  const unverifiedClientClaimIds: string[] = [];
  const staleSourceIds: string[] = [];
  const missingEvidenceNotes: string[] = [];

  for (const ch of clientSuppliedChunks) {
    unverifiedClientClaimIds.push(
      `client_chunk:${ch.chunkId || ch.sourceEntityId || 'unknown'}`
    );
  }

  // Always strip untrusted client chunks before building server context
  let workingContext: WritingContextBundle = {
    ...context,
    retrievedMemoryChunks: [],
  };

  // Step 2: Query authoritative Firestore CANON entities when available
  let snapshot: AuthoritativeProjectCanonSnapshot | null = null;
  let firestoreReadFailed = false;

  if (serverOptions?.customFirestoreReader) {
    try {
      snapshot = await serverOptions.customFirestoreReader({
        ownerId,
        projectId,
      });
      if (!snapshot) {
        firestoreReadFailed = true;
        missingEvidenceNotes.push(
          '서버 CANON 저장소 조회 결과가 비어 있거나 접근할 수 없습니다.'
        );
      }
    } catch (err) {
      firestoreReadFailed = true;
      missingEvidenceNotes.push(
        `서버 CANON 저장소 조회 실패: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  } else if (authoritativeDb) {
    try {
      snapshot = await readAuthoritativeProjectCanonFromFirestore({
        db: authoritativeDb,
        ownerId,
        projectId,
      });
    } catch (err) {
      firestoreReadFailed = true;
      missingEvidenceNotes.push(
        `Firestore CANON 원본 검증 오류: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  } else if (serverOptions?.enforceServerCanonGate || serverOptions?.isAuthenticatedCloud) {
    firestoreReadFailed = true;
    missingEvidenceNotes.push(
      '서버 CANON 권한 검증용 Firestore/저장소 연결을 사용할 수 없습니다.'
    );
  }

  let unauthorizedDetected = false;

  if (snapshot) {
    if (!snapshot.projectExists || snapshot.projectOwnerId !== ownerId) {
      unauthorizedDetected = true;
      missingEvidenceNotes.push(
        `[UNAUTHORIZED] 요청자(${ownerId})가 프로젝트(${projectId})의 CANON 원본 소유자가 아닙니다.`
      );
    } else {
      const authCharMap = new Map(snapshot.canonCharacters.map((c) => [c.id, c]));
      const nonCanonCharSet = new Set(snapshot.nonCanonCharacterIds);
      for (const clientChar of context.canonCharacters || []) {
        const authChar = authCharMap.get(clientChar.id);
        if (!authChar) {
          unauthorizedDetected = true;
          unverifiedClientClaimIds.push(`character:${clientChar.id}`);
          missingEvidenceNotes.push(
            nonCanonCharSet.has(clientChar.id)
              ? `[UNAUTHORIZED] 등장인물(${clientChar.id})은 서버에서 CANON(확정) 상태가 아닌 미승인/초안 데이터입니다.`
              : `[UNAUTHORIZED] 클라이언트 등장인물(${clientChar.id})을 서버 CANON 저장소에서 확인할 수 없습니다.`
          );
          continue;
        }
        // Detect tampering of CANON traits or name against server record
        if (
          (clientChar.abilities && clientChar.abilities !== authChar.abilities) ||
          (clientChar.personality && clientChar.personality !== authChar.personality) ||
          (clientChar.name && clientChar.name !== authChar.name)
        ) {
          staleSourceIds.push(`character:${authChar.id}`);
          missingEvidenceNotes.push(
            `[STALE] 클라이언트 등장인물(${authChar.name}) 내용이 서버 최신 CANON 설정과 다릅니다.`
          );
        }
      }

      const authWbMap = new Map(snapshot.canonWorldbuilding.map((w) => [w.id, w]));
      const nonCanonWbSet = new Set(snapshot.nonCanonWorldbuildingIds);
      for (const clientWb of context.canonWorldbuilding || []) {
        const authWb = authWbMap.get(clientWb.id);
        if (!authWb) {
          unauthorizedDetected = true;
          unverifiedClientClaimIds.push(`worldbuilding:${clientWb.id}`);
          missingEvidenceNotes.push(
            nonCanonWbSet.has(clientWb.id)
              ? `[UNAUTHORIZED] 세계관(${clientWb.id})은 서버에서 CANON(확정) 상태가 아닌 미승인/초안 데이터입니다.`
              : `[UNAUTHORIZED] 클라이언트 세계관(${clientWb.id})을 서버 CANON 저장소에서 확인할 수 없습니다.`
          );
          continue;
        }
        if (
          (clientWb.rules && clientWb.rules !== authWb.rules) ||
          (clientWb.title && clientWb.title !== authWb.title)
        ) {
          staleSourceIds.push(`worldbuilding:${authWb.id}`);
          missingEvidenceNotes.push(
            `[STALE] 클라이언트 세계관(${authWb.title}) 규칙이 서버 최신 CANON 설정과 다릅니다.`
          );
        }
      }

      // Overwrite client canonCharacters / canonWorldbuilding strictly with server-authoritative CANON
      workingContext = {
        ...workingContext,
        canonCharacters: snapshot.canonCharacters.map((c) => ({
          id: c.id,
          name: c.name,
          role: c.role,
          affiliation: c.affiliation,
          personality: c.personality,
          abilities: c.abilities,
          appearance: c.appearance,
        })),
        canonWorldbuilding: snapshot.canonWorldbuilding.map((w) => ({
          id: w.id,
          title: w.title,
          category: w.category,
          summary: w.summary,
          rules: w.rules,
        })),
      };
    }
  } else if (!serverOptions?.isIsolatedUnitTestMode && clientSuppliedChunks.length > 0) {
    unauthorizedDetected = true;
    missingEvidenceNotes.push(
      '[UNAUTHORIZED] 서버 RAG 조회 없이 클라이언트가 임의로 전달한 retrievedMemoryChunks는 CANON 근거로 수락되지 않습니다.'
    );
  }

  // Step 3: Run bounded server RAG retrieval (never treating timeout/failure as clean VERIFIED)
  let ragTimedOut = false;
  let ragErrored = false;
  let retrievedRagChunks: RagRetrievedEvidenceItem[] = [];

  const shouldQueryRag = Boolean(
    hasFirestoreAuthority ||
      serverOptions?.customRagRetriever ||
      serverOptions?.enforceServerCanonGate ||
      !serverOptions?.isIsolatedUnitTestMode
  );

  if (shouldQueryRag && !unauthorizedDetected && !firestoreReadFailed) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const ragCall = serverOptions?.customRagRetriever
        ? serverOptions.customRagRetriever({
            ownerId,
            context: workingContext,
            sceneQueryHint,
            topK: 6,
          })
        : retrieveVerifiedMemoryForWritingOnServer({
            ownerId,
            context: workingContext,
            sceneQueryHint,
            topK: 6,
            db: authoritativeDb ?? undefined,
            cacheNamespace,
          });

      const ragResult = await Promise.race([
        ragCall,
        new Promise<'__RAG_TIMEOUT__'>((resolve) => {
          timer = setTimeout(() => resolve('__RAG_TIMEOUT__'), ragTimeoutMs);
        }),
      ]);

      if (ragResult === '__RAG_TIMEOUT__') {
        ragTimedOut = true;
        missingEvidenceNotes.push(
          `[UNAVAILABLE] RAG 장기 기억 조회 시간 초과(${ragTimeoutMs}ms)로 CANON 검증을 완료하지 못했습니다.`
        );
      } else if (Array.isArray(ragResult)) {
        for (const chunk of ragResult) {
          if (chunk.projectId !== projectId) {
            unauthorizedDetected = true;
            unverifiedClientClaimIds.push(`rag_cross_tenant:${chunk.chunkId}`);
            continue;
          }
          if (chunk.canonStatus !== 'CANON' || chunk.freshnessStatus !== 'FRESH' || !chunk.verifiedForWriting) {
            if (chunk.freshnessStatus && chunk.freshnessStatus.startsWith('STALE')) {
              staleSourceIds.push(`rag_chunk:${chunk.chunkId}`);
            }
            continue;
          }
          // Check revision freshness against authoritative entity when available
          if (snapshot) {
            const authRev =
              chunk.sourceEntityType === 'CHARACTER'
                ? snapshot.canonCharacters.find((c) => c.id === chunk.sourceEntityId)
                    ?.sourceRevisionId
                : chunk.sourceEntityType === 'WORLDBUILDING'
                ? snapshot.canonWorldbuilding.find((w) => w.id === chunk.sourceEntityId)
                    ?.sourceRevisionId
                : undefined;
            if (
              authRev &&
              chunk.sourceRevisionId &&
              authRev !== chunk.sourceRevisionId
            ) {
              staleSourceIds.push(`rag_chunk_rev:${chunk.chunkId}`);
              missingEvidenceNotes.push(
                `[STALE] RAG 청크(${chunk.chunkId}) 버전(${chunk.sourceRevisionId})이 최신 서버 CANON 버전(${authRev})과 불일치합니다.`
              );
              continue;
            }
          }
          retrievedRagChunks.push(chunk);
        }
      } else {
        ragErrored = true;
        missingEvidenceNotes.push(
          '[UNAVAILABLE] 서버 RAG 엔진이 유효한 응답을 반환하지 않았습니다.'
        );
      }
    } catch (err) {
      ragErrored = true;
      missingEvidenceNotes.push(
        `[UNAVAILABLE] 서버 RAG 조회 실패: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // NEVER accept client-supplied retrievedMemoryChunks as verified CANON claims under any mode.
  if (clientSuppliedChunks.length > 0) {
    unauthorizedDetected = true;
    missingEvidenceNotes.push(
      '[UNAUTHORIZED] 클라이언트가 전달한 미검증 retrievedMemoryChunks 페이로드가 차단되었습니다.'
    );
  }

  workingContext = {
    ...workingContext,
    retrievedMemoryChunks: retrievedRagChunks,
  };

  // Build verified provenance IDs & state hash
  const verifiedRevisionMap: Record<string, string> = {};
  const verifiedCanonCharacterIds = workingContext.canonCharacters.map((c) => {
    const rev =
      snapshot?.canonCharacters.find((ac) => ac.id === c.id)?.sourceRevisionId ||
      'CANON_ACTIVE';
    verifiedRevisionMap[`CHARACTER:${c.id}`] = rev;
    return c.id;
  });
  const verifiedCanonWorldbuildingIds = workingContext.canonWorldbuilding.map(
    (w) => {
      const rev =
        snapshot?.canonWorldbuilding.find((aw) => aw.id === w.id)
          ?.sourceRevisionId || 'CANON_ACTIVE';
      verifiedRevisionMap[`WORLDBUILDING:${w.id}`] = rev;
      return w.id;
    }
  );
  const extraLoreIds: string[] = [];
  if (snapshot) {
    for (const rel of snapshot.canonRelationships) {
      extraLoreIds.push(rel.id);
      verifiedRevisionMap[`RELATIONSHIP:${rel.id}`] =
        rel.sourceRevisionId || 'CANON_ACTIVE';
    }
    for (const evt of snapshot.canonTimelineEvents) {
      extraLoreIds.push(evt.id);
      verifiedRevisionMap[`TIMELINE_EVENT:${evt.id}`] =
        evt.sourceRevisionId || 'CANON_ACTIVE';
    }
    for (const fsh of snapshot.canonForeshadowings) {
      extraLoreIds.push(fsh.id);
      verifiedRevisionMap[`FORESHADOWING:${fsh.id}`] =
        fsh.sourceRevisionId || 'CANON_ACTIVE';
    }
  }
  const verifiedRagChunkIds = retrievedRagChunks.map((c) => {
    verifiedRevisionMap[`RAG_CHUNK:${c.chunkId}`] = c.sourceRevisionId || 'FRESH';
    return c.chunkId;
  });

  const verifiedSourceIds = [
    ...verifiedCanonCharacterIds,
    ...verifiedCanonWorldbuildingIds,
    ...extraLoreIds,
    ...verifiedRagChunkIds,
  ];

  // Determine final CanonEvidenceStatus & CanonVerificationMode
  let status: CanonEvidenceStatus;
  let verificationMode: CanonVerificationMode;
  let shouldFailClosed = false;
  let blockingFailureReason: string | undefined;

  if (unauthorizedDetected || (unverifiedClientClaimIds.length > 0 && mustEnforceGate)) {
    status = 'UNAUTHORIZED';
    verificationMode = hasFirestoreAuthority ? 'SERVER_AUTHORITY' : 'UNVERIFIED';
    shouldFailClosed = true;
    blockingFailureReason =
      missingEvidenceNotes[0] ||
      '[UNAUTHORIZED] CANON 출처 권한 또는 승인 상태 검증에 실패하여 리라이팅을 차단했습니다.';
  } else if (staleSourceIds.length > 0) {
    status = 'STALE';
    verificationMode = hasFirestoreAuthority ? 'SERVER_AUTHORITY' : 'UNVERIFIED';
    shouldFailClosed = true;
    blockingFailureReason =
      missingEvidenceNotes[0] ||
      '[STALE] CANON 설정 또는 RAG 색인이 최신 상태가 아니어 리라이팅을 차단했습니다. 최신 설정을 다시 불러오세요.';
  } else if (firestoreReadFailed || ragTimedOut || ragErrored) {
    status = 'UNAVAILABLE';
    verificationMode = 'UNVERIFIED';
    shouldFailClosed = !params.allowUnverifiedTypoOnlyPreview;
    blockingFailureReason =
      missingEvidenceNotes[0] ||
      '[UNAVAILABLE] 서버 CANON 또는 RAG 저장소 조회에 실패하여 설정 무결성을 확인할 수 없습니다.';
  } else if (hasFirestoreAuthority) {
    verificationMode = 'SERVER_AUTHORITY';
    status = verifiedSourceIds.length > 0 ? 'VERIFIED' : 'VERIFIED_EMPTY';
    shouldFailClosed = false;
  } else if (serverOptions?.isIsolatedUnitTestMode) {
    verificationMode = 'ISOLATED_TEST';
    status = verifiedSourceIds.length > 0 ? 'VERIFIED' : 'VERIFIED_EMPTY';
    shouldFailClosed = false;
  } else {
    // Non-cloud local development fallback without server Firestore: never claim SERVER_AUTHORITY
    verificationMode = 'UNVERIFIED';
    status = 'UNAVAILABLE';
    shouldFailClosed = !params.allowUnverifiedTypoOnlyPreview;
    missingEvidenceNotes.push(
      '[UNAVAILABLE] 서버 Firestore CANON 원본과 연결되지 않아 미검증 상태로 분류되었습니다.'
    );
    blockingFailureReason = missingEvidenceNotes[0];
  }

  const canonStateHash = computeCanonStateHash({
    projectId,
    characters: workingContext.canonCharacters.map((c) => ({
      id: c.id,
      rev: verifiedRevisionMap[`CHARACTER:${c.id}`],
      name: c.name,
      rulesOrAbilities: `${c.abilities}|${c.personality}`,
    })),
    worldbuilding: workingContext.canonWorldbuilding.map((w) => ({
      id: w.id,
      rev: verifiedRevisionMap[`WORLDBUILDING:${w.id}`],
      title: w.title,
      rules: w.rules,
    })),
    loreIds: extraLoreIds,
    ragChunks: retrievedRagChunks.map((r) => ({
      chunkId: r.chunkId,
      sourceEntityId: r.sourceEntityId,
      sourceRevisionId: r.sourceRevisionId,
    })),
  });

  const isActuallyVerified =
    (status === 'VERIFIED' || status === 'VERIFIED_EMPTY') &&
    verificationMode !== 'UNVERIFIED';

  const canonEvidence: CanonEvidenceReport = {
    status,
    verificationMode,
    verifiedSourceIds: isActuallyVerified ? verifiedSourceIds : [],
    staleSourceIds,
    unverifiedClientClaimIds,
    missingEvidenceNotes,
    verifiedCanonCharacterIds: isActuallyVerified ? verifiedCanonCharacterIds : [],
    verifiedCanonWorldbuildingIds: isActuallyVerified
      ? verifiedCanonWorldbuildingIds
      : [],
    verifiedRagChunkIds: isActuallyVerified ? verifiedRagChunkIds : [],
    verifiedRevisionMap: isActuallyVerified ? verifiedRevisionMap : {},
    canonStateHash,
    verifiedAt,
    safeForAutomaticAcceptance: false,
    fallbackTypoOnlyApplied:
      status === 'UNAVAILABLE' && Boolean(params.allowUnverifiedTypoOnlyPreview),
  };

  return {
    canonEvidence,
    verifiedContext: workingContext,
    extraValidLoreIds: extraLoreIds,
    shouldFailClosed,
    blockingFailureReason,
  };
}
