import type { Request, Response, NextFunction } from 'express';
import {
  cert,
  deleteApp,
  getApps,
  initializeApp,
  type App,
  type AppOptions,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import fs from 'node:fs';
import path from 'node:path';

export const PROD_DEFAULT_FIREBASE_PROJECT_ID = 'atomic-future-93kqt' as const;
export const PROD_DEFAULT_FIRESTORE_DATABASE_ID =
  'ai-studio-d14675c1-78ff-41b1-8c46-397a79df1749' as const;

export interface IsolatedFirestoreBindingMetadata {
  appName: string;
  projectId: string;
  databaseId: string;
  runId: string;
  cacheNamespace: string;
  isIsolatedTestDb: true;
  createdAt: string;
}

const isolatedFirestoreMetadataRegistry = new WeakMap<
  Firestore,
  IsolatedFirestoreBindingMetadata
>();

export function getIsolatedFirestoreBindingMetadata(
  db?: Firestore | null
): IsolatedFirestoreBindingMetadata | undefined {
  if (!db) return undefined;
  return isolatedFirestoreMetadataRegistry.get(db);
}

export function isIsolatedEmulatorDemoDatabase(params: {
  projectId: string;
  databaseId: string;
}): boolean {
  return (
    Boolean(process.env.FIRESTORE_EMULATOR_HOST?.trim()) &&
    params.projectId.trim().startsWith('demo-') &&
    params.databaseId.trim() === '(default)'
  );
}

export function verifyIsolatedTestFirestoreBinding(
  db: Firestore | null | undefined,
  expected: {
    projectId: string;
    databaseId: string;
    runId?: string;
  }
): IsolatedFirestoreBindingMetadata {
  if (!db) {
    throw new Error(
      'ISOLATED_TEST_DB_MISSING: 주입된 테스트용 Firestore 인스턴스(testDb)가 없습니다.'
    );
  }
  const meta = isolatedFirestoreMetadataRegistry.get(db);
  if (!meta || !meta.isIsolatedTestDb) {
    throw new Error(
      'ISOLATED_TEST_DB_UNVERIFIED: 전달된 Firestore 인스턴스가 격리된 테스트 전용 앱(createIsolatedTestFirestoreClient)으로 생성되지 않았습니다.'
    );
  }
  if (meta.appName === '[DEFAULT]') {
    throw new Error(
      'ISOLATED_TEST_DB_DEFAULT_APP_FORBIDDEN: 테스트용 Firestore는 기본([DEFAULT]) Firebase 앱을 재사용할 수 없습니다.'
    );
  }
  const allowedEmulatorDefault = isIsolatedEmulatorDemoDatabase({
    projectId: meta.projectId,
    databaseId: meta.databaseId,
  });
  if (
    meta.projectId === PROD_DEFAULT_FIREBASE_PROJECT_ID ||
    meta.databaseId === PROD_DEFAULT_FIRESTORE_DATABASE_ID ||
    (meta.databaseId === '(default)' && !allowedEmulatorDefault)
  ) {
    throw new Error(
      `ISOLATED_TEST_DB_PROD_COLLISION: 운영 프로젝트('${PROD_DEFAULT_FIREBASE_PROJECT_ID}') 또는 운영/기본 데이터베이스('${meta.databaseId}')에 연결된 DB는 테스트에 사용할 수 없습니다.`
    );
  }
  if (meta.projectId !== expected.projectId.trim()) {
    throw new Error(
      `ISOLATED_TEST_DB_PROJECT_MISMATCH: 기대한 테스트 projectId('${expected.projectId}')와 실제 바인딩된 projectId('${meta.projectId}')가 다릅니다.`
    );
  }
  if (meta.databaseId !== expected.databaseId.trim()) {
    throw new Error(
      `ISOLATED_TEST_DB_DATABASE_MISMATCH: 기대한 테스트 databaseId('${expected.databaseId}')와 실제 바인딩된 databaseId('${meta.databaseId}')가 다릅니다.`
    );
  }
  if (expected.runId && meta.runId !== expected.runId.trim()) {
    throw new Error(
      `ISOLATED_TEST_DB_RUN_ID_MISMATCH: 기대한 runId('${expected.runId}')와 실제 바인딩된 runId('${meta.runId}')가 다릅니다.`
    );
  }
  return meta;
}

/**
 * Registers an in-memory mock Firestore instance for unit/integration tests with
 * full non-production collision checks so verifyIsolatedTestFirestoreBinding() can
 * validate it identically to a live isolated test Firestore handle.
 */
export function registerIsolatedMockFirestoreForTest(
  db: Firestore,
  params: {
    runId: string;
    projectId: string;
    databaseId: string;
    appName?: string;
  }
): IsolatedFirestoreBindingMetadata {
  const runId = (params.runId || '').trim();
  const projectId = (params.projectId || '').trim();
  const databaseId = (params.databaseId || '').trim();
  const appName = (params.appName || `novelforge-mock-test-${runId}`).trim();

  if (!runId || !/^[a-zA-Z0-9_-]{3,80}$/.test(runId)) {
    throw new Error(
      `INVALID_TEST_RUN_ID: 유효한 격리 테스트 runId가 필요합니다 (received='${runId}').`
    );
  }
  if (!projectId || !databaseId) {
    throw new Error(
      'MISSING_TEST_FIRESTORE_IDENTIFIERS: projectId와 databaseId가 모두 필요합니다.'
    );
  }
  if (appName === '[DEFAULT]') {
    throw new Error(
      'ISOLATED_TEST_DB_DEFAULT_APP_FORBIDDEN: 테스트용 Firestore는 기본([DEFAULT]) Firebase 앱을 재사용할 수 없습니다.'
    );
  }
  const allowedEmulatorDefault = isIsolatedEmulatorDemoDatabase({
    projectId,
    databaseId,
  });
  if (
    projectId === PROD_DEFAULT_FIREBASE_PROJECT_ID ||
    databaseId === PROD_DEFAULT_FIRESTORE_DATABASE_ID ||
    (databaseId === '(default)' && !allowedEmulatorDefault)
  ) {
    throw new Error(
      `ISOLATED_TEST_DB_PROD_COLLISION: 운영 프로젝트('${PROD_DEFAULT_FIREBASE_PROJECT_ID}') 또는 운영/기본 데이터베이스('${databaseId}')에 연결된 DB는 테스트에 사용할 수 없습니다.`
    );
  }

  const metadata: IsolatedFirestoreBindingMetadata = {
    isIsolatedTestDb: true,
    appName,
    projectId,
    databaseId,
    runId,
    cacheNamespace: `test_ns_${runId}`,
    createdAt: new Date().toISOString(),
  };
  isolatedFirestoreMetadataRegistry.set(db, metadata);
  return metadata;
}

export interface CreateIsolatedTestFirestoreParams {
  runId: string;
  projectId: string;
  databaseId: string;
  serviceAccountJson?: string;
  credentialsFilePath?: string;
}

export interface IsolatedTestFirestoreHandle {
  app: App;
  db: Firestore;
  metadata: IsolatedFirestoreBindingMetadata;
  cleanup: () => Promise<void>;
}

function resolveTestServiceAccountCredential(params: {
  serviceAccountJson?: string;
  credentialsFilePath?: string;
}): ServiceAccount | null {
  const rawJson = (
    params.serviceAccountJson ??
    process.env.TEST_FIREBASE_SERVICE_ACCOUNT_KEY ??
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY ??
    ''
  ).trim();

  if (rawJson) {
    const parsed = JSON.parse(rawJson) as ServiceAccount;
    return parsed;
  }

  const credPath = (
    params.credentialsFilePath ??
    process.env.TEST_GOOGLE_APPLICATION_CREDENTIALS ??
    process.env.GOOGLE_APPLICATION_CREDENTIALS ??
    ''
  ).trim();

  if (credPath && fs.existsSync(credPath)) {
    const rawFile = fs.readFileSync(credPath, 'utf8');
    return JSON.parse(rawFile) as ServiceAccount;
  }

  return null;
}

export function createIsolatedTestFirestoreClient(
  params: CreateIsolatedTestFirestoreParams
): IsolatedTestFirestoreHandle {
  const runId = (params.runId || '').trim();
  const projectId = (params.projectId || '').trim();
  const databaseId = (params.databaseId || '').trim();

  if (!runId || !/^[a-zA-Z0-9_-]{3,80}$/.test(runId)) {
    throw new Error(
      `INVALID_TEST_RUN_ID: 유효한 격리 테스트 runId가 필요합니다 (received='${runId}').`
    );
  }
  if (!projectId || !databaseId) {
    throw new Error(
      'MISSING_TEST_FIRESTORE_IDENTIFIERS: TEST_FIREBASE_PROJECT_ID와 TEST_FIRESTORE_DATABASE_ID가 모두 필요합니다.'
    );
  }
  const allowedEmulatorDefault = isIsolatedEmulatorDemoDatabase({
    projectId,
    databaseId,
  });
  if (
    projectId === PROD_DEFAULT_FIREBASE_PROJECT_ID ||
    databaseId === PROD_DEFAULT_FIRESTORE_DATABASE_ID ||
    (databaseId === '(default)' && !allowedEmulatorDefault)
  ) {
    throw new Error(
      `TEST_FIRESTORE_PROD_ISOLATION_VIOLATION: 운영 Firebase 프로젝트('${PROD_DEFAULT_FIREBASE_PROJECT_ID}') 또는 운영/기본 Firestore DB('${databaseId}')와 동일한 식별자로는 테스트 앱을 생성할 수 없습니다.`
    );
  }

  const serviceAccount = resolveTestServiceAccountCredential({
    serviceAccountJson: params.serviceAccountJson,
    credentialsFilePath: params.credentialsFilePath,
  });
  const hasEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST?.trim());

  if (!serviceAccount && !hasEmulator) {
    throw new Error(
      'MISSING_TEST_FIRESTORE_CREDENTIALS: 격리된 테스트용 서비스 계정 자격 증명(TEST_FIREBASE_SERVICE_ACCOUNT_KEY, FIREBASE_SERVICE_ACCOUNT_KEY, GOOGLE_APPLICATION_CREDENTIALS) 또는 FIRESTORE_EMULATOR_HOST가 설정되지 않았습니다.'
    );
  }

  const uniqueAppName = `novelforge-isolated-test-${runId}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const appOptions: AppOptions = serviceAccount
    ? {
        credential: cert(serviceAccount),
        projectId,
      }
    : {
        projectId,
      };

  const testApp = initializeApp(appOptions, uniqueAppName);
  const testDb =
    databaseId === '(default)'
      ? getFirestore(testApp)
      : getFirestore(testApp, databaseId);
  const cacheNamespace = `isolated_${runId}_${projectId}_${databaseId}`.replace(
    /[^a-zA-Z0-9_-]/g,
    '_'
  );

  const metadata: IsolatedFirestoreBindingMetadata = {
    appName: uniqueAppName,
    projectId,
    databaseId,
    runId,
    cacheNamespace,
    isIsolatedTestDb: true,
    createdAt: new Date().toISOString(),
  };

  isolatedFirestoreMetadataRegistry.set(testDb, metadata);

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    isolatedFirestoreMetadataRegistry.delete(testDb);
    await deleteApp(testApp);
  };

  return {
    app: testApp,
    db: testDb,
    metadata,
    cleanup,
  };
}

export interface AuthenticatedRequest extends Request {
  firebaseUser?: DecodedIdToken;
}

export function getFirebaseProjectId(): string {
  const envProjId = process.env.FIREBASE_PROJECT_ID?.trim();
  try {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as { projectId?: string };
    const configProjId = parsed.projectId?.trim();
    if (envProjId && configProjId && envProjId !== configProjId) {
      throw new Error(
        `FIREBASE_PROJECT_ID_MISMATCH(403): 환경변수 FIREBASE_PROJECT_ID('${envProjId}')와 설정 파일 projectId('${configProjId}')가 일치하지 않습니다.`
      );
    }
    return envProjId || configProjId || 'atomic-future-93kqt';
  } catch (err) {
    if (err instanceof Error && err.message.includes('FIREBASE_PROJECT_ID_MISMATCH')) {
      throw err;
    }
    return envProjId || 'atomic-future-93kqt';
  }
}

export function getFirebaseDatabaseId(): string {
  const envDbId = process.env.FIRESTORE_DATABASE_ID?.trim();
  let configDbId: string | undefined;
  try {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as { firestoreDatabaseId?: string };
    if (parsed.firestoreDatabaseId && parsed.firestoreDatabaseId.trim().length > 0) {
      configDbId = parsed.firestoreDatabaseId.trim();
    }
  } catch {
    // ignore missing file
  }

  if (envDbId && configDbId && envDbId !== configDbId) {
    throw new Error(
      `FIRESTORE_DATABASE_ID_MISMATCH(403): 환경변수 FIRESTORE_DATABASE_ID('${envDbId}')와 설정 파일 firestoreDatabaseId('${configDbId}')가 서로 다른 데이터베이스를 가리킵니다.`
    );
  }

  const resolved =
    envDbId || configDbId || 'ai-studio-d14675c1-78ff-41b1-8c46-397a79df1749';
  if (!resolved || resolved === '(default)') {
    throw new Error(
      `FIRESTORE_DATABASE_ID_INVALID(403): NOVEL FORGE는 명명된 Firestore 데이터베이스를 사용해야 합니다 (resolved='${resolved}').`
    );
  }
  return resolved;
}

export function hasCloudFirestoreCredentials(): boolean {
  if (
    Boolean(process.env.NODE_TEST_CONTEXT) &&
    process.env.RUN_LIVE_CLOUD_TESTS !== 'true'
  ) {
    return false;
  }
  return Boolean(
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.FIREBASE_SERVICE_ACCOUNT_KEY ||
      process.env.FIRESTORE_EMULATOR_HOST ||
      process.env.K_SERVICE ||
      Boolean(process.env.GCLOUD_PROJECT && process.env.GOOGLE_CLOUD_PROJECT)
  );
}

function isLoopbackEmulatorHost(host: string | undefined): boolean {
  const port = /^(?:127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})$/i.exec(host ?? '')?.[1];
  return port !== undefined && Number(port) > 0 && Number(port) <= 65535;
}

export function ensureFirebaseAdminInitialized(): string {
  const projectId = getFirebaseProjectId();
  const defaultAppExists = getApps().some((a) => a.name === '[DEFAULT]');
  if (!defaultAppExists) {
    initializeApp({ projectId });
  }
  return projectId;
}

export async function verifyBearerToken(authHeader?: string): Promise<{
  verified: boolean;
  decoded?: DecodedIdToken;
  error?: string;
}> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { verified: false, error: 'Authorization Bearer 토큰이 제공되지 않았습니다.' };
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return { verified: false, error: '빈 인증 토큰입니다.' };
  }

  // The Auth emulator accepts unsigned tokens. Keep those tokens away from cloud Firestore.
  if (
    process.env.FIREBASE_AUTH_EMULATOR_HOST &&
    (process.env.NODE_ENV === 'production' ||
      !isLoopbackEmulatorHost(process.env.FIREBASE_AUTH_EMULATOR_HOST) ||
      !isLoopbackEmulatorHost(process.env.FIRESTORE_EMULATOR_HOST))
  ) {
    return {
      verified: false,
      error: '[AUTH_EMULATOR_ISOLATION_REQUIRED] Firebase Auth 에뮬레이터는 개발 모드에서 로컬 Firestore 에뮬레이터와 함께 사용할 때만 허용됩니다.',
    };
  }

  try {
    ensureFirebaseAdminInitialized();
    const decoded = await getAuth().verifyIdToken(token, false);
    return { verified: true, decoded };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { verified: false, error: `토큰 검증 실패: ${msg}` };
  }
}

export async function requireFirebaseAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const result = await verifyBearerToken(req.headers.authorization);
  if (!result.verified || !result.decoded) {
    res.status(401).json({
      verified: false,
      error: result.error || '인증되지 않은 요청입니다.',
    });
    return;
  }
  req.firebaseUser = result.decoded;
  next();
}

export interface RequestOwnerResolution {
  ok: boolean;
  statusCode: 200 | 401 | 403;
  ownerId: string;
  isAuthenticatedCloud: boolean;
  error?: string;
}

let serverCloudAuthOverrideForTesting: boolean | null = null;

export function setServerCloudAuthEnforcementForTesting(
  enforced: boolean | null
): void {
  serverCloudAuthOverrideForTesting = enforced;
}

export function isServerCloudAuthEnforced(): boolean {
  if (serverCloudAuthOverrideForTesting !== null) {
    return serverCloudAuthOverrideForTesting;
  }
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.NOVELFORGE_ENFORCE_CLOUD_AUTH === 'true' ||
    process.env.NOVEL_FORGE_ENFORCE_CLOUD_AUTH === 'true' ||
    process.env.SERVER_FORCE_CLOUD_AUTH === 'true' ||
    (hasCloudFirestoreCredentials() &&
      !isLoopbackEmulatorHost(process.env.FIRESTORE_EMULATOR_HOST))
  );
}

/**
 * Phase 3.1.1 P0-4 — Hardened Owner Resolution & Anti-Spoofing Guard:
 * 1. Server-side configuration (`isServerCloudAuthEnforced()`) governs whether cloud authentication is mandatory.
 *    Clients cannot omit or alter headers to bypass cloud authentication in production/cloud mode.
 * 2. If `Authorization: Bearer <token>` is present, verifies the Firebase ID Token signature on the server.
 *    - Invalid token -> 401 Unauthorized.
 *    - Valid token + mismatched client `ownerId` -> 403 Forbidden (prevents cross-user spoofing).
 * 3. If no `Authorization` header is present:
 *    - If server cloud auth is enforced or `requireCloudAuth` is true -> 401 Unauthorized.
 *    - If client attempts to supply any `ownerId` other than `'local_author'` -> 401 Unauthorized.
 *    - Otherwise permits `'local_author'` ONLY for isolated local development workspace mode.
 */
export async function resolveSecureRequestOwner(params: {
  authorizationHeader?: string;
  claimedOwnerId?: unknown;
  requireCloudAuth?: boolean;
  preVerifiedUid?: string;
}): Promise<RequestOwnerResolution> {
  const authHeader =
    typeof params.authorizationHeader === 'string'
      ? params.authorizationHeader.trim()
      : '';
  const claimed =
    typeof params.claimedOwnerId === 'string' ? params.claimedOwnerId.trim() : '';
  const enforceCloudAuth =
    isServerCloudAuthEnforced() || Boolean(params.requireCloudAuth);

  if (params.preVerifiedUid) {
    if (
      claimed.length > 0 &&
      claimed !== 'local_author' &&
      claimed !== params.preVerifiedUid
    ) {
      return {
        ok: false,
        statusCode: 403,
        ownerId: '',
        isAuthenticatedCloud: true,
        error:
          '인증된 사용자 UID와 요청된 ownerId가 일치하지 않습니다(403). 다른 사용자의 작품이나 기억 인덱스에 접근할 수 없습니다.',
      };
    }
    return {
      ok: true,
      statusCode: 200,
      ownerId: params.preVerifiedUid,
      isAuthenticatedCloud: true,
    };
  }

  if (authHeader.length > 0) {
    const result = await verifyBearerToken(authHeader);
    if (!result.verified || !result.decoded?.uid) {
      return {
        ok: false,
        statusCode: 401,
        ownerId: '',
        isAuthenticatedCloud: false,
        error: result.error || '유효하지 않은 사용자 인증 토큰입니다(401).',
      };
    }

    if (
      claimed.length > 0 &&
      claimed !== 'local_author' &&
      claimed !== result.decoded.uid
    ) {
      return {
        ok: false,
        statusCode: 403,
        ownerId: '',
        isAuthenticatedCloud: true,
        error:
          '인증된 사용자 UID와 요청된 ownerId가 일치하지 않습니다(403). 다른 사용자의 작품이나 기억 인덱스에 접근할 수 없습니다.',
      };
    }

    return {
      ok: true,
      statusCode: 200,
      ownerId: result.decoded.uid,
      isAuthenticatedCloud: true,
    };
  }

  if (enforceCloudAuth) {
    return {
      ok: false,
      statusCode: 401,
      ownerId: '',
      isAuthenticatedCloud: false,
      error:
        'Cloud 운영 모드 API 요청에는 유효한 Firebase ID 토큰(Authorization: Bearer)이 필수입니다(401).',
    };
  }

  if (claimed.length > 0 && claimed !== 'local_author') {
    return {
      ok: false,
      statusCode: 401,
      ownerId: '',
      isAuthenticatedCloud: false,
      error:
        '미인증 요청에서 다른 사용자의 ownerId를 지정할 수 없습니다(401). Google 로그인 후 유효한 인증 토큰을 전달해 주세요.',
    };
  }

  return {
    ok: true,
    statusCode: 200,
    ownerId: 'local_author',
    isAuthenticatedCloud: false,
  };
}

// ============================================================================
// Phase 3.1.1 P0-4: Firebase Admin SDK Direct Project Ownership Verification
// ============================================================================

const SAFE_FIRESTORE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Secondary cache of verified `(projectId -> actualOwnerUid)` pairs.
 * Used as an auxiliary cache ONLY; direct Firestore verification takes precedence
 * whenever Firestore lookup is available or strict/cloud mode is active.
 */
const verifiedProjectOwnerRegistry = new Map<string, string>();

export type FirestoreProjectLookupFn = (params: {
  authenticatedUid: string;
  projectId: string;
}) => Promise<{
  existsUnderUserPath: boolean;
  docOwnerId?: string;
  actualOwnerInDatabase?: string | null;
  lookupFailed?: boolean;
  lookupError?: string;
}>;

let customFirestoreProjectLookup: FirestoreProjectLookupFn | null = null;

export function registerProjectOwnerForAdminCheck(
  projectId: string,
  actualOwnerUid: string
): void {
  if (projectId && actualOwnerUid) {
    verifiedProjectOwnerRegistry.set(projectId.trim(), actualOwnerUid.trim());
  }
}

export function clearProjectOwnerRegistryForTesting(): void {
  verifiedProjectOwnerRegistry.clear();
  customFirestoreProjectLookup = null;
}

export function setCustomFirestoreProjectLookupForTesting(
  fn: FirestoreProjectLookupFn | null
): void {
  customFirestoreProjectLookup = fn;
}

export function createFirestoreProjectLookupFromDb(
  db: Firestore
): FirestoreProjectLookupFn {
  return async ({ authenticatedUid, projectId }) => {
    try {
      const docSnap = await db
        .doc(`users/${authenticatedUid}/projects/${projectId}`)
        .get();
      if (!docSnap.exists) {
        return { existsUnderUserPath: false };
      }
      const data = docSnap.data() || {};
      const rawOwnerId =
        typeof data.ownerId === 'string' && data.ownerId.trim().length > 0
          ? data.ownerId.trim()
          : '__MISSING_PROJECT_OWNER_ID__';
      return {
        existsUnderUserPath: true,
        docOwnerId: rawOwnerId,
        actualOwnerInDatabase: rawOwnerId,
      };
    } catch (err) {
      return {
        existsUnderUserPath: false,
        lookupFailed: true,
        lookupError: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

async function defaultDirectFirestoreProjectLookup(params: {
  authenticatedUid: string;
  projectId: string;
}): Promise<{
  existsUnderUserPath: boolean;
  docOwnerId?: string;
  actualOwnerInDatabase?: string | null;
  lookupFailed?: boolean;
  lookupError?: string;
}> {
  if (!hasCloudFirestoreCredentials()) {
    return {
      existsUnderUserPath: false,
      lookupFailed: true,
      lookupError:
        'Could not load the default credentials (no Cloud Firestore credentials configured in current runtime)',
    };
  }
  try {
    ensureFirebaseAdminInitialized();
    const app = getApps().find((a) => a.name === '[DEFAULT]');
    const dbId = getFirebaseDatabaseId();
    if (!app) {
      return {
        existsUnderUserPath: false,
        lookupFailed: true,
        lookupError: 'Firebase Admin [DEFAULT] App is not initialized',
      };
    }
    const adminDb = getFirestore(app, dbId);
    const lookup = createFirestoreProjectLookupFromDb(adminDb);
    return await lookup(params);
  } catch (err) {
    return {
      existsUnderUserPath: false,
      lookupFailed: true,
      lookupError: err instanceof Error ? err.message : String(err),
    };
  }
}

export function getRegisteredProjectOwner(projectId: string): string | undefined {
  return verifiedProjectOwnerRegistry.get(projectId.trim());
}

export interface AdminProjectOwnershipVerificationResult {
  ok: boolean;
  statusCode: 200 | 400 | 401 | 403;
  verifiedOwnerId: string;
  verifiedProjectId: string;
  verifiedDatabaseId?: string;
  verifiedVia:
    | 'FIRESTORE_ADMIN_DOC'
    | 'OWNERSHIP_REGISTRY'
    | 'LOCAL_WORKSPACE';
  error?: string;
}

/**
 * Phase 3.1.1 P0-4 & Phase 3.2:
 * Because Firebase Admin SDK bypasses `firestore.rules`, every server-side RAG
 * search, index, status, and delete operation MUST directly verify that the authenticated UID
 * actually owns the target Firestore project (`projectId`).
 * - Never trusts `req.body.ownerId`, `project.ownerId`, `liveSnapshots`, or local cache as proof of ownership.
 * - `verifiedProjectOwnerRegistry` is only a secondary cache.
 * - In cloud/strict mode, if Firestore lookup fails or the project does not exist under `users/{uid}/projects/{projectId}`, access is denied (403).
 */
export async function verifyAdminFirestoreProjectOwnership(params: {
  authenticatedUid: string;
  isAuthenticatedCloud?: boolean;
  projectId: string;
  claimedOwnerId?: unknown;
  projectPayloadOwnerId?: unknown;
  requestedDatabaseId?: string;
  requireStrictFirestoreDocCheck?: boolean;
  firestoreLookupFn?: FirestoreProjectLookupFn | null;
  db?: Firestore;
  skipRegistryCache?: boolean;
}): Promise<AdminProjectOwnershipVerificationResult> {
  const uid = (params.authenticatedUid || '').trim();
  const projectId = (params.projectId || '').trim();
  const hasInjectedDb = Boolean(params.db);
  const skipRegistry = hasInjectedDb || Boolean(params.skipRegistryCache);
  const strictCloudMode =
    hasInjectedDb ||
    isServerCloudAuthEnforced() ||
    Boolean(params.isAuthenticatedCloud) ||
    Boolean(params.requireStrictFirestoreDocCheck);

  const injectedMeta = getIsolatedFirestoreBindingMetadata(params.db);

  let activeDatabaseId: string;
  try {
    activeDatabaseId = injectedMeta
      ? injectedMeta.databaseId
      : getFirebaseDatabaseId();
    if (!injectedMeta) {
      getFirebaseProjectId();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      statusCode: 403,
      verifiedOwnerId: uid,
      verifiedProjectId: projectId,
      verifiedVia: 'FIRESTORE_ADMIN_DOC',
      error: `권한 거부(403 - FIRESTORE_DATABASE_MISMATCH): ${msg}`,
    };
  }

  if (
    params.requestedDatabaseId !== undefined &&
    params.requestedDatabaseId.trim() !== activeDatabaseId
  ) {
    return {
      ok: false,
      statusCode: 403,
      verifiedOwnerId: uid,
      verifiedProjectId: projectId,
      verifiedDatabaseId: activeDatabaseId,
      verifiedVia: 'FIRESTORE_ADMIN_DOC',
      error: `권한 거부(403 - FIRESTORE_DATABASE_MISMATCH): 요청된 데이터베이스('${params.requestedDatabaseId}')가 활성 Firestore 데이터베이스('${activeDatabaseId}')와 일치하지 않습니다.`,
    };
  }

  if (!uid) {
    return {
      ok: false,
      statusCode: 401,
      verifiedOwnerId: '',
      verifiedProjectId: projectId,
      verifiedVia: 'LOCAL_WORKSPACE',
      error: '인증된 사용자 UID가 없습니다(401).',
    };
  }

  if (strictCloudMode && uid === 'local_author') {
    return {
      ok: false,
      statusCode: 401,
      verifiedOwnerId: '',
      verifiedProjectId: projectId,
      verifiedVia: 'LOCAL_WORKSPACE',
      error:
        '권한 거부(401 - CLOUD_AUTH_REQUIRED): 클라우드 운영 환경 또는 주입된 Firestore 환경에서는 로컬 개발 계정(local_author)으로 접근할 수 없습니다.',
    };
  }

  if (!projectId || !SAFE_FIRESTORE_ID_REGEX.test(projectId)) {
    return {
      ok: false,
      statusCode: 400,
      verifiedOwnerId: uid,
      verifiedProjectId: projectId,
      verifiedVia: 'LOCAL_WORKSPACE',
      error:
        '유효하지 않은 projectId 형식입니다. 경로 탐색(Path Traversal) 또는 비정상 식별자가 차단되었습니다.',
    };
  }

  if (!SAFE_FIRESTORE_ID_REGEX.test(uid)) {
    return {
      ok: false,
      statusCode: 403,
      verifiedOwnerId: uid,
      verifiedProjectId: projectId,
      verifiedVia: 'LOCAL_WORKSPACE',
      error: '유효하지 않은 사용자 UID 형식입니다.',
    };
  }

  // 1. Reject any mismatch between authenticated UID and claimedOwnerId / projectPayloadOwnerId
  const claimed =
    typeof params.claimedOwnerId === 'string'
      ? params.claimedOwnerId.trim()
      : '';
  if (claimed && claimed !== 'local_author' && claimed !== uid) {
    return {
      ok: false,
      statusCode: 403,
      verifiedOwnerId: uid,
      verifiedProjectId: projectId,
      verifiedVia: 'OWNERSHIP_REGISTRY',
      error: `권한 거부(403 - CLAIMED_OWNER_MISMATCH): 인증된 UID('${uid}')와 요청된 ownerId('${claimed}')가 일치하지 않습니다.`,
    };
  }

  const payloadOwner =
    typeof params.projectPayloadOwnerId === 'string'
      ? params.projectPayloadOwnerId.trim()
      : '';
  if (payloadOwner && payloadOwner !== 'local_author' && payloadOwner !== uid) {
    return {
      ok: false,
      statusCode: 403,
      verifiedOwnerId: uid,
      verifiedProjectId: projectId,
      verifiedVia: 'OWNERSHIP_REGISTRY',
      error: `권한 거부(403 - PAYLOAD_OWNER_MISMATCH): 작품 데이터 내부의 ownerId('${payloadOwner}')와 인증된 UID('${uid}')가 일치하지 않습니다.`,
    };
  }

  // 2. Direct Firestore document ownership verification FIRST when lookupFn or injected db is available
  const lookupFn: FirestoreProjectLookupFn | null =
    params.firestoreLookupFn ??
    (params.db ? createFirestoreProjectLookupFromDb(params.db) : null) ??
    customFirestoreProjectLookup ??
    (strictCloudMode && uid !== 'local_author'
      ? defaultDirectFirestoreProjectLookup
      : null);

  if (lookupFn) {
    const lookupRes = await lookupFn({ authenticatedUid: uid, projectId });
    if (lookupRes.lookupFailed) {
      return {
        ok: false,
        statusCode: 403,
        verifiedOwnerId: uid,
        verifiedProjectId: projectId,
        verifiedDatabaseId: activeDatabaseId,
        verifiedVia: 'FIRESTORE_ADMIN_DOC',
        error: `권한 거부(403 - FIRESTORE_VERIFICATION_FAILED): Firestore 프로젝트 소유권 원본 검증에 실패하여 접근이 차단되었습니다 (${lookupRes.lookupError || 'lookup error'}).`,
      };
    }

    if (
      lookupRes.actualOwnerInDatabase &&
      lookupRes.actualOwnerInDatabase !== uid
    ) {
      if (!skipRegistry) {
        verifiedProjectOwnerRegistry.set(
          projectId,
          lookupRes.actualOwnerInDatabase
        );
      }
      return {
        ok: false,
        statusCode: 403,
        verifiedOwnerId: uid,
        verifiedProjectId: projectId,
        verifiedDatabaseId: activeDatabaseId,
        verifiedVia: 'FIRESTORE_ADMIN_DOC',
        error: `권한 거부(403 - ADMIN_SDK_OWNERSHIP_MISMATCH / FIRESTORE_PROJECT_OWNER_MISMATCH): Firestore에 저장된 프로젝트('${projectId}')의 실제 소유자('${lookupRes.actualOwnerInDatabase}')가 요청자('${uid}')와 일치하지 않습니다.`,
      };
    }

    if (lookupRes.existsUnderUserPath) {
      if (lookupRes.docOwnerId && lookupRes.docOwnerId !== uid) {
        return {
          ok: false,
          statusCode: 403,
          verifiedOwnerId: uid,
          verifiedProjectId: projectId,
          verifiedDatabaseId: activeDatabaseId,
          verifiedVia: 'FIRESTORE_ADMIN_DOC',
          error: `권한 거부(403 - ADMIN_SDK_OWNERSHIP_MISMATCH / FIRESTORE_DOC_FIELD_MISMATCH): 프로젝트 문서의 ownerId('${lookupRes.docOwnerId}')가 인증된 UID('${uid}')와 일치하지 않습니다.`,
        };
      }
      if (!skipRegistry) {
        verifiedProjectOwnerRegistry.set(projectId, uid);
      }
      return {
        ok: true,
        statusCode: 200,
        verifiedOwnerId: uid,
        verifiedProjectId: projectId,
        verifiedDatabaseId: activeDatabaseId,
        verifiedVia: 'FIRESTORE_ADMIN_DOC',
      };
    }

    if (strictCloudMode) {
      return {
        ok: false,
        statusCode: 403,
        verifiedOwnerId: uid,
        verifiedProjectId: projectId,
        verifiedDatabaseId: activeDatabaseId,
        verifiedVia: 'FIRESTORE_ADMIN_DOC',
        error: `권한 거부(403 - FIRESTORE_PROJECT_NOT_OWNED): Firestore에서 인증된 사용자('${uid}') 소유의 프로젝트('${projectId}') 문서를 찾을 수 없습니다.`,
      };
    }
  } else if (strictCloudMode && params.requireStrictFirestoreDocCheck) {
    return {
      ok: false,
      statusCode: 403,
      verifiedOwnerId: uid,
      verifiedProjectId: projectId,
      verifiedDatabaseId: activeDatabaseId,
      verifiedVia: 'FIRESTORE_ADMIN_DOC',
      error: `권한 거부(403 - FIRESTORE_UNAVAILABLE): 운영 환경에서 Firestore 프로젝트 소유권 원본을 확인할 수 없어 접근을 거부했습니다.`,
    };
  }

  // 3. Secondary project ownership cache (used ONLY when no injected db is active)
  const registeredOwner = skipRegistry
    ? undefined
    : verifiedProjectOwnerRegistry.get(projectId);
  if (registeredOwner && registeredOwner !== uid) {
    return {
      ok: false,
      statusCode: 403,
      verifiedOwnerId: uid,
      verifiedProjectId: projectId,
      verifiedDatabaseId: activeDatabaseId,
      verifiedVia: 'OWNERSHIP_REGISTRY',
      error: `권한 거부(403 - ADMIN_SDK_OWNERSHIP_MISMATCH): 요청된 경로/ownerId가 '${uid}'로 일치하더라도, 프로젝트('${projectId}')의 실제 소유자는 다른 사용자이므로 접근이 차단되었습니다.`,
    };
  }

  if (!skipRegistry && !registeredOwner && uid !== 'local_author') {
    verifiedProjectOwnerRegistry.set(projectId, uid);
  }

  return {
    ok: true,
    statusCode: 200,
    verifiedOwnerId: uid,
    verifiedProjectId: projectId,
    verifiedDatabaseId: activeDatabaseId,
    verifiedVia:
      registeredOwner === uid ? 'OWNERSHIP_REGISTRY' : 'LOCAL_WORKSPACE',
  };
}



