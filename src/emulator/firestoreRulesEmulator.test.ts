import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteApp as deleteAdminApp,
  getApps as getAdminApps,
  initializeApp as initializeAdminApp,
  type App as AdminApp,
} from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import {
  FirebaseError,
  initializeApp as initializeClientApp,
  deleteApp as deleteClientApp,
  type FirebaseApp,
} from 'firebase/app';
import {
  connectAuthEmulator,
  getAuth as getClientAuth,
  getIdTokenResult,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  collection,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  commitEpisodeRevisionSafelyFirestore,
  EpisodeRevisionCasConflictError,
  executeAtomicEpisodeCasCommitCore,
  fetchFirestorePromptProfileById,
  persistApprovedStyleDnaAtomicallyFirestore,
  persistChangeProposalsIdempotentlyCore,
  persistFirestoreChangeProposalsIdempotently,
  persistSingleFirestoreProposalAtomically,
  updateFirestorePromptProfileWithCas,
  saveFirestoreCharacterVoicePrompt,
} from '../services/novelRepository.ts';
import { computeManuscriptContentHash } from '../utils/manuscriptIntegrity.ts';
import {
  buildLiteraryRewritePrompt,
  rebindProposalsToCommittedRevision,
} from '../utils/literaryRewritingLogic.ts';
import {
  assembleNovelWriterPromptInOrder,
  buildWritingContext,
  createNewPromptProfile,
  restorePromptProfileToVersion,
  updatePromptProfileContent,
} from '../utils/aiEngineLogic.ts';
import {
  AUTHOR_STYLE_BENCHMARKS,
  buildDefaultSelectedStyleInstructions,
  evaluateStyleApprovalUiTransition,
  extractStylePromptMetadata,
} from '../utils/authorStyleLogic.ts';
import { analyzeAuthorStyleOnServer } from '../server/authorStyleAnalyzer.ts';
import { analyzeCharacterVoice } from '../server/characterVoiceAnalyzer.ts';
import { buildApprovedVoiceContent, voiceProfileId } from '../utils/characterVoiceLogic.ts';
import { createInitialSeedBundle } from '../utils/seedData.ts';
import { verifyServerCanonEvidenceForRewrite } from '../server/canonEvidenceGate.ts';
import {
  createIsolatedTestFirestoreClient,
  PROD_DEFAULT_FIREBASE_PROJECT_ID,
  PROD_DEFAULT_FIRESTORE_DATABASE_ID,
} from '../server/authMiddleware.ts';

const EMULATOR_PROJECT_ID = 'demo-novelforge-rag-integrity' as const;
const EXPECTED_AUTH_EMULATOR_HOST = '127.0.0.1:9099' as const;

function assertRulesEmulatorEnv(): {
  firestoreHost: string;
  firestoreHostname: string;
  firestorePort: number;
  authHost: string;
  projectId: string;
  databaseId: string;
} {
  const firestoreHost = (process.env.FIRESTORE_EMULATOR_HOST || '').trim();
  const authHost = (process.env.FIREBASE_AUTH_EMULATOR_HOST || '').trim();
  if (!firestoreHost || !authHost) {
    throw new Error(
      '[EMULATOR_HOST_NOT_CONFIGURED] Both FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST are required.'
    );
  }
  if (/^https?:\/\//i.test(authHost) || /^https?:\/\//i.test(firestoreHost)) {
    throw new Error(
      '[EMULATOR_HOST_INVALID_SCHEME] Emulator host env vars must be host:port without http:// or https://'
    );
  }

  assert.equal(
    process.env.FIREBASE_AUTH_EMULATOR_HOST,
    EXPECTED_AUTH_EMULATOR_HOST,
    'Auth Emulator host mismatch: refusing Admin Auth operation'
  );
  assert.equal(
    process.env.GCLOUD_PROJECT,
    EMULATOR_PROJECT_ID,
    'Firebase project mismatch'
  );

  if (
    process.env.TEST_FIREBASE_PROJECT_ID &&
    process.env.TEST_FIREBASE_PROJECT_ID.trim() !== EMULATOR_PROJECT_ID
  ) {
    throw new Error(
      `Firebase project mismatch: TEST_FIREBASE_PROJECT_ID=${process.env.TEST_FIREBASE_PROJECT_ID} != ${EMULATOR_PROJECT_ID}`
    );
  }
  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_PROJECT_ID.trim() !== EMULATOR_PROJECT_ID
  ) {
    throw new Error(
      `Firebase project mismatch: FIREBASE_PROJECT_ID=${process.env.FIREBASE_PROJECT_ID} != ${EMULATOR_PROJECT_ID}`
    );
  }

  const [firestoreHostname, portStr] = firestoreHost.split(':');
  const firestorePort = Number(portStr || 8080);
  const projectId: string = EMULATOR_PROJECT_ID;
  const databaseId = (
    process.env.TEST_FIRESTORE_DATABASE_ID || '(default)'
  ).trim();

  if (
    projectId === PROD_DEFAULT_FIREBASE_PROJECT_ID ||
    databaseId === PROD_DEFAULT_FIRESTORE_DATABASE_ID ||
    databaseId !== '(default)'
  ) {
    throw new Error(
      `[EMULATOR_PROD_ISOLATION_VIOLATION] Refusing Security Rules Emulator run on project=${projectId}, db=${databaseId}`
    );
  }

  return {
    firestoreHost,
    firestoreHostname: firestoreHostname || '127.0.0.1',
    firestorePort,
    authHost,
    projectId,
    databaseId,
  };
}

function connectClientFirestoreDb(params: {
  app: FirebaseApp;
  databaseId: string;
  firestoreHostname: string;
  firestorePort: number;
}): ReturnType<typeof getFirestore> {
  assert.equal(
    params.app.options.projectId,
    EMULATOR_PROJECT_ID,
    'Client App projectId mismatch before Firestore Emulator connection'
  );
  const clientDb =
    params.databaseId === '(default)'
      ? getFirestore(params.app)
      : getFirestore(params.app, params.databaseId);
  connectFirestoreEmulator(
    clientDb,
    params.firestoreHostname,
    params.firestorePort
  );
  return clientDb;
}

async function createAndSignInEmulatorUser(params: {
  roleLabel: string;
  authHost: string;
  projectId: string;
  firestoreHostname: string;
  firestorePort: number;
  databaseId: string;
  email: string;
  password: string;
  appName: string;
  adminAppName: string;
}): Promise<{
  uid: string;
  app: FirebaseApp;
  db: ReturnType<typeof getFirestore>;
  cleanup: () => Promise<void>;
}> {
  // Pre-flight guard BEFORE any Admin App or getAdminAuth() initialization
  assert.equal(
    process.env.FIREBASE_AUTH_EMULATOR_HOST,
    EXPECTED_AUTH_EMULATOR_HOST,
    'Auth Emulator host mismatch: refusing Admin Auth operation'
  );
  assert.equal(
    process.env.GCLOUD_PROJECT,
    EMULATOR_PROJECT_ID,
    'Firebase project mismatch'
  );
  assert.equal(
    params.authHost,
    EXPECTED_AUTH_EMULATOR_HOST,
    'Auth Emulator parameter host mismatch'
  );
  assert.equal(
    params.projectId,
    EMULATOR_PROJECT_ID,
    'Emulator parameter projectId mismatch'
  );
  assert.notEqual(params.projectId, PROD_DEFAULT_FIREBASE_PROJECT_ID);

  assert.equal(
    getAdminApps().some((a) => a.name === params.adminAppName),
    false,
    `Admin App name "${params.adminAppName}" must be unique`
  );
  const adminApp: AdminApp = initializeAdminApp(
    {
      projectId: EMULATOR_PROJECT_ID,
    },
    params.adminAppName
  );
  assert.equal(
    adminApp.options.projectId,
    EMULATOR_PROJECT_ID,
    'Admin App projectId mismatch'
  );
  assert.notEqual(
    adminApp.name,
    '[DEFAULT]',
    'Must not reuse [DEFAULT] Admin App for isolated Auth Emulator verification'
  );

  // Re-assert immediately before getAdminAuth(adminApp) captures emulator env var
  assert.equal(
    process.env.FIREBASE_AUTH_EMULATOR_HOST,
    EXPECTED_AUTH_EMULATOR_HOST,
    'Auth Emulator host mismatch before getAdminAuth'
  );
  const adminAuth = getAdminAuth(adminApp);

  // STEP 1: Create Emulator User & Acquire UID
  const signUpUrl = `http://${EXPECTED_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-emulator-api-key`;
  const signUpRes = await fetch(signUpUrl, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: params.email,
      password: params.password,
      returnSecureToken: true,
    }),
  });
  const signUpData = (await signUpRes.json()) as {
    localId?: string;
    error?: { message?: string };
  };
  if (!signUpRes.ok || !signUpData.localId) {
    await deleteAdminApp(adminApp).catch(() => undefined);
    throw new Error(
      `Auth Emulator signUp failed (${signUpRes.status}): ${JSON.stringify(
        signUpData
      )}`
    );
  }
  const uid = signUpData.localId;
  assert.ok(uid, 'STEP 1 failed: UID not returned from accounts:signUp');

  // Verify the newly created UID lives in EMULATOR_PROJECT_ID's user pool
  const initialServerUser = await adminAuth.getUser(uid);
  assert.equal(
    initialServerUser.uid,
    uid,
    'STEP 1 failed: created user not found in Admin user pool for EMULATOR_PROJECT_ID'
  );

  // STEP 2: Admin privilege update (emailVerified = true)
  let updatedVia = 'ADMIN_SDK';
  try {
    await adminAuth.updateUser(uid, {
      emailVerified: true,
    });
  } catch (adminUpdErr) {
    // Fallback ONLY to local Auth Emulator admin REST endpoint (never remote GCP)
    updatedVia = 'EMULATOR_ADMIN_REST';
    const adminRestUrl = `http://${EXPECTED_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/projects/${EMULATOR_PROJECT_ID}/accounts:update`;
    const restRes = await fetch(adminRestUrl, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: 'Bearer owner',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        localId: uid,
        emailVerified: true,
      }),
    });
    const restBodyText = await restRes.text();
    if (!restRes.ok) {
      await deleteAdminApp(adminApp).catch(() => undefined);
      const errMsg =
        adminUpdErr instanceof Error ? adminUpdErr.message : String(adminUpdErr);
      throw new Error(
        `STEP 2 failed: Admin updateUser (${errMsg}) and Emulator Admin REST (${restRes.status}: ${restBodyText}) both failed`
      );
    }
  }

  // STEP 3: Admin getUser(uid) Server-Side Verification
  const serverUser = await adminAuth.getUser(uid);
  assert.equal(serverUser.uid, uid, 'STEP 3 failed: server user UID mismatch');
  assert.equal(
    serverUser.emailVerified,
    true,
    'Server user must be email verified'
  );

  // STEP 4: Client SDK Login
  const clientApp = initializeClientApp(
    {
      apiKey: 'fake-emulator-api-key',
      authDomain: `${EMULATOR_PROJECT_ID}.firebaseapp.com`,
      projectId: EMULATOR_PROJECT_ID,
    },
    params.appName
  );
  assert.equal(
    clientApp.options.projectId,
    EMULATOR_PROJECT_ID,
    'Client App projectId mismatch'
  );
  assert.equal(
    adminApp.options.projectId,
    clientApp.options.projectId,
    'Admin App and Client App projectId must match identically'
  );

  const auth = getClientAuth(clientApp);
  connectAuthEmulator(auth, `http://${EXPECTED_AUTH_EMULATOR_HOST}`, {
    disableWarnings: true,
  });

  const credential = await signInWithEmailAndPassword(
    auth,
    params.email,
    params.password
  );
  assert.equal(
    credential.user.uid,
    uid,
    'STEP 4 failed: Client signInWithEmailAndPassword UID mismatch'
  );

  // STEP 5: Client ID Token Forced Refresh
  assert.ok(
    auth.currentUser,
    'STEP 5 failed: Emulator sign-in must populate auth.currentUser'
  );
  const tokenResult = await getIdTokenResult(auth.currentUser, true);

  // STEP 6: ID Token Final Claims Verification
  assert.equal(
    tokenResult.claims.email_verified,
    true,
    'Client token must contain email_verified=true'
  );
  assert.equal(
    tokenResult.claims.user_id,
    uid,
    'Client token user_id claim must match UID'
  );
  assert.equal(
    tokenResult.claims.aud,
    EMULATOR_PROJECT_ID,
    'Client token aud claim must match EMULATOR_PROJECT_ID'
  );
  const tokenIss = String(tokenResult.claims.iss || '');
  assert.ok(
    tokenIss.includes(EMULATOR_PROJECT_ID),
    `Client token iss claim must reference ${EMULATOR_PROJECT_ID}`
  );

  console.info(
    [
      `[RULES_EMULATOR_AUTH] role=${params.roleLabel}`,
      `METHOD=${updatedVia}`,
      `ADMIN_PROJECT_ID=${adminApp.options.projectId === EMULATOR_PROJECT_ID ? 'MATCH' : 'MISMATCH'}`,
      `CLIENT_PROJECT_ID=${clientApp.options.projectId === EMULATOR_PROJECT_ID ? 'MATCH' : 'MISMATCH'}`,
      `AUTH_EMULATOR_HOST=${process.env.FIREBASE_AUTH_EMULATOR_HOST}`,
      `UID_MATCH=${credential.user.uid === uid && tokenResult.claims.user_id === uid}`,
      `ADMIN_USER_EMAIL_VERIFIED=${String(serverUser.emailVerified)}`,
      `CLIENT_TOKEN_EMAIL_VERIFIED=${String(tokenResult.claims.email_verified)}`,
    ].join(' | ')
  );

  const clientDb = connectClientFirestoreDb({
    app: clientApp,
    databaseId: params.databaseId,
    firestoreHostname: params.firestoreHostname,
    firestorePort: params.firestorePort,
  });

  return {
    uid,
    app: clientApp,
    db: clientDb,
    cleanup: async () => {
      await adminAuth.deleteUser(uid).catch(() => undefined);
      await Promise.allSettled([
        deleteClientApp(clientApp),
        deleteAdminApp(adminApp),
      ]);
    },
  };
}

/**
 * Strictly asserts that a Firebase Client SDK operation failed due to Firestore Security Rules
 * (`FirebaseError` with `code === 'permission-denied'`).
 * Never wraps `assert.fail` inside the `try` block so an allowed operation ALWAYS fails the test.
 */
async function assertPermissionDenied(
  fn: () => Promise<unknown>,
  label: string
): Promise<void> {
  let thrownError: unknown = null;
  let succeeded = false;

  try {
    await fn();
    succeeded = true;
  } catch (err) {
    thrownError = err;
  }

  if (succeeded) {
    assert.fail(
      `[RULES_FALSE_PASS_PREVENTED] Expected Firebase permission-denied for "${label}", but the operation SUCCEEDED.`
    );
  }

  if (thrownError instanceof assert.AssertionError) {
    throw thrownError;
  }

  const isFirebaseErr =
    thrownError instanceof FirebaseError ||
    (typeof thrownError === 'object' &&
      thrownError !== null &&
      (thrownError as { name?: unknown }).name === 'FirebaseError');
  const code =
    typeof thrownError === 'object' && thrownError !== null
      ? String((thrownError as { code?: unknown }).code || '')
      : '';
  const msg =
    thrownError instanceof Error ? thrownError.message : String(thrownError);

  assert.equal(
    isFirebaseErr,
    true,
    `Expected FirebaseError for "${label}", got non-Firebase error: ${msg}`
  );
  assert.equal(
    code,
    'permission-denied',
    `Expected FirebaseError code="permission-denied" for "${label}", got code="${code}", msg="${msg}"`
  );
}

test('Section 7 Security Rules Emulator: Verifies active firestore.rules loading, blocks client writes to server-only collections, blocks direct CANON transitions, enforces cross-tenant isolation, and proves denied writes do not mutate Firestore', async () => {
  const env = assertRulesEmulatorEnv();
  const runTag = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const adminHandle = createIsolatedTestFirestoreClient({
    runId: `rules_admin_${runTag}`,
    projectId: EMULATOR_PROJECT_ID,
    databaseId: env.databaseId,
  });
  assert.equal(
    adminHandle.app.options.projectId,
    EMULATOR_PROJECT_ID,
    'Admin Firestore handle projectId mismatch'
  );

  const unauthApp = initializeClientApp(
    {
      apiKey: 'fake-emulator-api-key',
      authDomain: `${EMULATOR_PROJECT_ID}.firebaseapp.com`,
      projectId: EMULATOR_PROJECT_ID,
    },
    `rules_unauth_${runTag}`
  );
  assert.equal(unauthApp.options.projectId, EMULATOR_PROJECT_ID);
  const unauthDb = connectClientFirestoreDb({
    app: unauthApp,
    databaseId: env.databaseId,
    firestoreHostname: env.firestoreHostname,
    firestorePort: env.firestorePort,
  });

  const ownerA = await createAndSignInEmulatorUser({
    roleLabel: 'ownerA',
    authHost: env.authHost,
    projectId: EMULATOR_PROJECT_ID,
    firestoreHostname: env.firestoreHostname,
    firestorePort: env.firestorePort,
    databaseId: env.databaseId,
    email: `owner_a_${runTag}@example.com`,
    password: 'StrongPassword!123',
    appName: `rules_client_a_${runTag}`,
    adminAppName: `rules_auth_admin_a_${runTag}`,
  });

  const ownerB = await createAndSignInEmulatorUser({
    roleLabel: 'ownerB',
    authHost: env.authHost,
    projectId: EMULATOR_PROJECT_ID,
    firestoreHostname: env.firestoreHostname,
    firestorePort: env.firestorePort,
    databaseId: env.databaseId,
    email: `owner_b_${runTag}@example.com`,
    password: 'StrongPassword!123',
    appName: `rules_client_b_${runTag}`,
    adminAppName: `rules_auth_admin_b_${runTag}`,
  });

  const sentinelPath = `rulesSentinel/probe_${runTag}`;

  try {
    // 0. Active Security Rules Sentinel Check (fails fast if firestore.rules was NOT loaded / emulator fell back to allow all)
    await assertPermissionDenied(
      () =>
        setDoc(doc(unauthDb, sentinelPath), {
          probe: true,
        }),
      'Unauthenticated sentinel write (verifies firestore.rules is loaded)'
    );
    await assertPermissionDenied(
      () => getDoc(doc(unauthDb, sentinelPath)),
      'Unauthenticated sentinel read (verifies firestore.rules is loaded)'
    );
    await assertPermissionDenied(
      () =>
        setDoc(doc(ownerA.db, sentinelPath), {
          probe: true,
        }),
      'Authenticated default-deny sentinel write (verifies firestore.rules is loaded)'
    );
    const sentinelSnap = await adminHandle.db.doc(sentinelPath).get();
    assert.equal(
      sentinelSnap.exists,
      false,
      'Sentinel doc must NEVER exist when firestore.rules is active'
    );

    const projId = `proj_rules_sec_${runTag}`;
    const baseA = `users/${ownerA.uid}/projects/${projId}`;

    // Seed parent user/project and Admin-only docs using Admin SDK (bypasses rules, just like production server)
    await adminHandle.db.doc(`users/${ownerA.uid}`).set({
      uid: ownerA.uid,
      email: 'owner_a@example.com',
      displayName: 'Author A',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await adminHandle.db.doc(baseA).set({
      id: projId,
      ownerId: ownerA.uid,
      title: 'Security Rules Project',
      genre: 'Fantasy',
      logline: 'Rules verification',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await adminHandle.db.doc(`${baseA}/ragManifest/control`).set({
      ownerId: ownerA.uid,
      projectId: projId,
      activeGenerationCounter: 1,
      cleanupClaims: {},
    });
    await adminHandle.db.doc(`${baseA}/ragGenerationStaging/stg_1`).set({
      id: 'stg_1',
      ownerId: ownerA.uid,
      projectId: projId,
      generation: 1,
      status: 'VERIFIED',
    });
    await adminHandle.db.doc(`${baseA}/ragSyncTasks/task_1`).set({
      id: 'task_1',
      ownerId: ownerA.uid,
      projectId: projId,
      status: 'PENDING',
    });
    await adminHandle.db.doc(`${baseA}/changeProposalApprovalAudits/audit_1`).set({
      id: 'audit_1',
      ownerId: ownerA.uid,
      projectId: projId,
      proposalId: 'prop_1',
      action: 'APPROVE',
    });

    const seededProjectSnap = await adminHandle.db.doc(baseA).get();
    assert.equal(
      seededProjectSnap.exists,
      true,
      'Seeded parent project document must exist before Client SDK changeProposal create'
    );
    assert.equal(seededProjectSnap.data()?.ownerId, ownerA.uid);

    // Owner A CAN read own project document via real Client SDK
    const ownProjectClientSnap = await getDoc(doc(ownerA.db, baseA));
    assert.equal(
      ownProjectClientSnap.exists(),
      true,
      'Verified Owner A must be able to read own project document'
    );

    // Owner creates a PROPOSED ChangeProposal via real Client SDK (allowed!)
    await setDoc(doc(ownerA.db, `${baseA}/changeProposals/prop_1`), {
      id: 'prop_1',
      ownerId: ownerA.uid,
      projectId: projId,
      targetEntityType: 'RELATIONSHIP',
      targetEntityId: 'rel_1',
      proposedAction: 'CREATE',
      title: 'Add rival bond',
      rationale: 'Direct conflict in ch 1',
      beforeSummary: '',
      afterSummary: 'Rivals',
      proposedPayloadJson: '{"relationType":"RIVAL"}',
      canonStatus: 'PROPOSED',
      triggerEpisodeId: 'ep_1',
      triggerSceneId: '',
      sourceRevisionId: 'rev_1',
      createdBy: 'AI_ENGINE',
      reviewedAt: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    const createdPropSnap = await adminHandle.db
      .doc(`${baseA}/changeProposals/prop_1`)
      .get();
    assert.equal(
      createdPropSnap.exists,
      true,
      'Client SDK PROPOSED ChangeProposal create must persist in Firestore'
    );

    // 1. Client SDK direct write/delete to ragManifest/control -> PERMISSION_DENIED + DB unchanged
    await assertPermissionDenied(
      () =>
        setDoc(doc(ownerA.db, `${baseA}/ragManifest/control`), {
          ownerId: ownerA.uid,
          activeGenerationCounter: 999,
        }),
      'Client write to ragManifest/control'
    );
    await assertPermissionDenied(
      () => deleteDoc(doc(ownerA.db, `${baseA}/ragManifest/control`)),
      'Client delete of ragManifest/control'
    );
    const manifestSnap = await adminHandle.db
      .doc(`${baseA}/ragManifest/control`)
      .get();
    assert.equal(manifestSnap.exists, true);
    assert.equal(manifestSnap.data()?.activeGenerationCounter, 1);

    // 2. Client SDK direct write/update/delete to ragGenerationStaging/* -> PERMISSION_DENIED + DB unchanged
    await assertPermissionDenied(
      () =>
        setDoc(doc(ownerA.db, `${baseA}/ragGenerationStaging/stg_client`), {
          id: 'stg_client',
          ownerId: ownerA.uid,
          projectId: projId,
          status: 'VERIFIED',
        }),
      'Client create ragGenerationStaging'
    );
    assert.equal(
      (
        await adminHandle.db
          .doc(`${baseA}/ragGenerationStaging/stg_client`)
          .get()
      ).exists,
      false
    );

    await assertPermissionDenied(
      () =>
        updateDoc(doc(ownerA.db, `${baseA}/ragGenerationStaging/stg_1`), {
          status: 'PREPARING',
        }),
      'Client update ragGenerationStaging'
    );
    await assertPermissionDenied(
      () => deleteDoc(doc(ownerA.db, `${baseA}/ragGenerationStaging/stg_1`)),
      'Client delete ragGenerationStaging'
    );
    const stg1Snap = await adminHandle.db
      .doc(`${baseA}/ragGenerationStaging/stg_1`)
      .get();
    assert.equal(stg1Snap.exists, true);
    assert.equal(stg1Snap.data()?.status, 'VERIFIED');

    // 3. Client SDK direct write/update/delete to ragSyncTasks/* -> PERMISSION_DENIED + DB unchanged
    await assertPermissionDenied(
      () =>
        updateDoc(doc(ownerA.db, `${baseA}/ragSyncTasks/task_1`), {
          status: 'COMPLETED',
        }),
      'Client update ragSyncTasks'
    );
    await assertPermissionDenied(
      () => deleteDoc(doc(ownerA.db, `${baseA}/ragSyncTasks/task_1`)),
      'Client delete ragSyncTasks'
    );
    const task1Snap = await adminHandle.db
      .doc(`${baseA}/ragSyncTasks/task_1`)
      .get();
    assert.equal(task1Snap.exists, true);
    assert.equal(task1Snap.data()?.status, 'PENDING');

    // 4. Client SDK direct write/update/delete to changeProposalApprovalAudits/* -> PERMISSION_DENIED + DB unchanged
    await assertPermissionDenied(
      () =>
        setDoc(
          doc(ownerA.db, `${baseA}/changeProposalApprovalAudits/audit_fake`),
          { id: 'audit_fake', ownerId: ownerA.uid, projectId: projId }
        ),
      'Client create changeProposalApprovalAudits'
    );
    assert.equal(
      (
        await adminHandle.db
          .doc(`${baseA}/changeProposalApprovalAudits/audit_fake`)
          .get()
      ).exists,
      false
    );

    // 5. Client SDK direct transition of RELATIONSHIP ChangeProposal to CANON/REJECTED/ARCHIVED -> PERMISSION_DENIED + DB unchanged
    await assertPermissionDenied(
      () =>
        updateDoc(doc(ownerA.db, `${baseA}/changeProposals/prop_1`), {
          canonStatus: 'CANON',
          updatedAt: serverTimestamp(),
        }),
      'Client direct transition of changeProposal to CANON'
    );
    await assertPermissionDenied(
      () =>
        updateDoc(doc(ownerA.db, `${baseA}/changeProposals/prop_1`), {
          canonStatus: 'REJECTED',
          updatedAt: serverTimestamp(),
        }),
      'Client direct transition of changeProposal to REJECTED'
    );
    await assertPermissionDenied(
      () =>
        updateDoc(doc(ownerA.db, `${baseA}/changeProposals/prop_1`), {
          canonStatus: 'ARCHIVED',
          updatedAt: serverTimestamp(),
        }),
      'Client direct transition of changeProposal to ARCHIVED'
    );
    const propSnap = await adminHandle.db
      .doc(`${baseA}/changeProposals/prop_1`)
      .get();
    assert.equal(propSnap.exists, true);
    assert.equal(propSnap.data()?.canonStatus, 'PROPOSED');

    // 6. Cross-tenant Client SDK access (ownerB reading/writing ownerA) -> PERMISSION_DENIED
    await assertPermissionDenied(
      () => getDoc(doc(ownerB.db, baseA)),
      'Cross-tenant get project'
    );
    await assertPermissionDenied(
      () => getDoc(doc(ownerB.db, `${baseA}/changeProposals/prop_1`)),
      'Cross-tenant get changeProposal'
    );
    await assertPermissionDenied(
      () =>
        setDoc(doc(ownerB.db, `${baseA}/changeProposals/prop_intruder`), {
          id: 'prop_intruder',
          ownerId: ownerB.uid,
          projectId: projId,
          canonStatus: 'PROPOSED',
        }),
      'Cross-tenant write changeProposal'
    );
    assert.equal(
      (
        await adminHandle.db
          .doc(`${baseA}/changeProposals/prop_intruder`)
          .get()
      ).exists,
      false
    );
    await assertPermissionDenied(
      () =>
        getDocs(
          query(
            collection(ownerB.db, `${baseA}/changeProposalApprovalAudits`),
            where('ownerId', '==', ownerB.uid)
          )
        ),
      'Cross-tenant list approval audits'
    );

    // 7. Authorized Owner A CAN list (ownerId-scoped) & read own staging/tasks/audits and edit allowed metadata on PROPOSED proposal
    const auditsList = await getDocs(
      query(
        collection(ownerA.db, `${baseA}/changeProposalApprovalAudits`),
        where('ownerId', '==', ownerA.uid)
      )
    );
    assert.equal(auditsList.size, 1);

    const stagingGet = await getDoc(
      doc(ownerA.db, `${baseA}/ragGenerationStaging/stg_1`)
    );
    assert.equal(stagingGet.exists(), true);

    await updateDoc(doc(ownerA.db, `${baseA}/changeProposals/prop_1`), {
      title: 'Refined rival bond title',
      updatedAt: serverTimestamp(),
    });
    const updatedPropSnap = await adminHandle.db
      .doc(`${baseA}/changeProposals/prop_1`)
      .get();
    assert.equal(updatedPropSnap.data()?.title, 'Refined rival bond title');
    assert.equal(updatedPropSnap.data()?.canonStatus, 'PROPOSED');
  } finally {
    await adminHandle.db
      .recursiveDelete(adminHandle.db.doc(`users/${ownerA.uid}`))
      .catch(() => undefined);
    await Promise.all([
      deleteClientApp(unauthApp),
      ownerA.cleanup(),
      ownerB.cleanup(),
      adminHandle.cleanup(),
    ]);
  }
});

// ============================================================================
// Test 6: Phase 4.3B P0-B — Episode CAS runTransaction & Security Rules Integrity
// ============================================================================

test('Emulator Test 6 (P0-B): Firestore runTransaction enforces atomic backup+target revisions, rejects stale tab CAS & invalid contentHash/revisionId', async () => {
  const env = assertRulesEmulatorEnv();
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const owner = await createAndSignInEmulatorUser({
    roleLabel: 'OwnerCas',
    authHost: env.authHost,
    projectId: env.projectId,
    firestoreHostname: env.firestoreHostname,
    firestorePort: env.firestorePort,
    databaseId: env.databaseId,
    email: `cas_owner_${suffix}@novelforge.local`,
    password: 'StrongPassword#1234',
    appName: `client_cas_${suffix}`,
    adminAppName: `admin_cas_${suffix}`,
  });
  const adminHandle = createIsolatedTestFirestoreClient({
    runId: `admin_cas_db_${suffix}`,
    projectId: env.projectId,
    databaseId: env.databaseId,
  });

  const projId = `proj_cas_${suffix}`;
  const epId = `ep_cas_${suffix}`;
  const base = `users/${owner.uid}/projects/${projId}`;
  const v1Content = '초기 확정 원고입니다. 카엘이 성벽에 섰다.';
  const v1Hash = computeManuscriptContentHash(v1Content);

  try {
    // Seed project & episode via Admin SDK
    await adminHandle.db.doc(base).set({
      id: projId,
      ownerId: owner.uid,
      title: 'CAS Test Novel',
      genre: 'Fantasy',
      synopsis: '',
      settings: '',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await adminHandle.db.doc(`${base}/episodes/${epId}`).set({
      id: epId,
      ownerId: owner.uid,
      projectId: projId,
      episodeNumber: 1,
      title: '제1화',
      content: v1Content,
      synopsis: '',
      authorNote: '',
      charCountWithSpaces: v1Content.length,
      charCountWithoutSpaces: v1Content.replace(/\s+/g, '').length,
      status: 'confirmed',
      linkedCharacterIds: [],
      linkedWorldbuildingIds: [],
      latestRevisionId: 'rev_seed_1',
      contentHash: v1Hash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 1. Rules reject overly long contentHash (>128 chars) or revision update
    await assertPermissionDenied(
      () =>
        updateDoc(doc(owner.db, `${base}/episodes/${epId}`), {
          contentHash: 'x'.repeat(129),
          updatedAt: serverTimestamp(),
        }),
      'Episode contentHash exceeding 128 chars'
    );

    // 2. Authorized atomic Client runTransaction succeeds (creates backup + target rev, updates episode)
    const v2Content = '리라이팅 반영 원고입니다. 카엘이 찬 바람 속에 섰다.';
    const commit1 = await runTransaction(owner.db, async (tx) => {
      const epRef = doc(owner.db, `${base}/episodes/${epId}`);
      return executeAtomicEpisodeCasCommitCore(
        {
          uid: owner.uid,
          projectId: projId,
          updatedEpisode: {
            id: epId,
            ownerId: owner.uid,
            projectId: projId,
            episodeNumber: 1,
            title: '제1화',
            content: v2Content,
            synopsis: '',
            authorNote: '',
            charCountWithSpaces: v2Content.length,
            charCountWithoutSpaces: v2Content.replace(/\s+/g, '').length,
            status: 'confirmed',
            linkedCharacterIds: [],
            linkedWorldbuildingIds: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          expectedRevisionId: 'rev_seed_1',
          expectedContentHash: v1Hash,
          createBackupRevisionFirst: true,
          backupRevisionLabel: '리라이팅 전 백업',
          createRevision: true,
          revisionLabel: '정밀 리라이팅 (R1)',
        },
        {
          getEpisodeSnapshot: async () => {
            const snap = await tx.get(epRef);
            if (!snap.exists()) return { exists: false, content: '' };
            const d = snap.data() || {};
            return {
              exists: true,
              content: String(d.content ?? ''),
              latestRevisionId: String(d.latestRevisionId ?? ''),
              contentHash: typeof d.contentHash === 'string' ? d.contentHash : undefined,
            };
          },
          createRevision: async (rev) => {
            tx.set(doc(owner.db, `${base}/revisions/${rev.id}`), {
              id: rev.id,
              ownerId: owner.uid,
              projectId: projId,
              episodeId: rev.episodeId,
              episodeTitle: rev.episodeTitle,
              content: rev.content,
              charCountWithSpaces: rev.charCountWithSpaces,
              label: rev.label,
              createdAt: serverTimestamp(),
            });
          },
          updateEpisode: async (committed) => {
            tx.update(epRef, {
              episodeNumber: committed.episodeNumber,
              title: committed.title,
              content: committed.content,
              synopsis: committed.synopsis,
              authorNote: committed.authorNote,
              charCountWithSpaces: committed.charCountWithSpaces,
              charCountWithoutSpaces: committed.charCountWithoutSpaces,
              status: committed.status,
              linkedCharacterIds: committed.linkedCharacterIds,
              linkedWorldbuildingIds: committed.linkedWorldbuildingIds,
              latestRevisionId: committed.latestRevisionId || '',
              contentHash: committed.contentHash || '',
              updatedAt: serverTimestamp(),
            });
          },
        }
      );
    });

    assert.ok(commit1.backupRevision);
    assert.ok(commit1.targetRevision);
    assert.notEqual(commit1.backupRevision.id, epId);
    assert.notEqual(commit1.targetRevision.id, epId);

    // 3. Stale tab CAS attempt MUST reject cleanly and leave v2Content untouched in Emulator
    await assert.rejects(
      () =>
        runTransaction(owner.db, async (tx) => {
          const epRef = doc(owner.db, `${base}/episodes/${epId}`);
          return executeAtomicEpisodeCasCommitCore(
            {
              uid: owner.uid,
              projectId: projId,
              updatedEpisode: {
                id: epId,
                ownerId: owner.uid,
                projectId: projId,
                episodeNumber: 1,
                title: '제1화',
                content: '지연 탭 덮어쓰기 시도',
                synopsis: '',
                authorNote: '',
                charCountWithSpaces: 12,
                charCountWithoutSpaces: 10,
                status: 'confirmed',
                linkedCharacterIds: [],
                linkedWorldbuildingIds: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              expectedRevisionId: 'rev_seed_1',
              expectedContentHash: v1Hash,
              createBackupRevisionFirst: true,
              createRevision: true,
            },
            {
              getEpisodeSnapshot: async () => {
                const snap = await tx.get(epRef);
                const d = snap.data() || {};
                return {
                  exists: snap.exists(),
                  content: String(d.content ?? ''),
                  latestRevisionId: String(d.latestRevisionId ?? ''),
                  contentHash: typeof d.contentHash === 'string' ? d.contentHash : undefined,
                };
              },
              createRevision: async () => {},
              updateEpisode: async () => {},
            }
          );
        }),
      (err: unknown) =>
        err instanceof EpisodeRevisionCasConflictError &&
        err.code === 'STALE_REVISION_CONFLICT'
    );

    const epReadback = await adminHandle.db.doc(`${base}/episodes/${epId}`).get();
    assert.equal(epReadback.data()?.content, v2Content);
    assert.equal(epReadback.data()?.latestRevisionId, commit1.targetRevision.id);
  } finally {
    await adminHandle.db
      .recursiveDelete(adminHandle.db.doc(`users/${owner.uid}`))
      .catch(() => undefined);
    await Promise.all([owner.cleanup(), adminHandle.cleanup()]);
  }
});

// ============================================================================
// Test 7: Phase 4.3B Stage 2 P0-A — Server CANON Verification Against Emulator
// ============================================================================

test('Emulator Test 7 (P0-A Stage 2): verifyServerCanonEvidenceForRewrite verifies CANON from real Firestore, blocks DRAFT/cross-tenant/tampered claims', async () => {
  const env = assertRulesEmulatorEnv();
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const adminHandle = createIsolatedTestFirestoreClient({
    runId: `admin_canon_gate_${suffix}`,
    projectId: env.projectId,
    databaseId: env.databaseId,
  });

  const ownerUid = `owner_canon_${suffix}`;
  const otherUid = `other_canon_${suffix}`;
  const projId = `proj_canon_${suffix}`;
  const base = `users/${ownerUid}/projects/${projId}`;

  try {
    await adminHandle.db.doc(base).set({
      id: projId,
      ownerId: ownerUid,
      title: 'CANON Gate Test Novel',
      genre: 'Fantasy',
      synopsis: '',
      status: 'confirmed',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await adminHandle.db.doc(`${base}/characters/char_canon_1`).set({
      id: 'char_canon_1',
      ownerId: ownerUid,
      projectId: projId,
      name: '카엘',
      role: '주인공',
      affiliation: '성기사단',
      personality: '과묵함',
      abilities: '왼팔 중상',
      appearance: '검은 망토',
      status: 'confirmed',
      canonStatus: 'CANON',
      sourceRevisionId: 'rev_char_auth_1',
    });
    await adminHandle.db.doc(`${base}/characters/char_draft_only`).set({
      id: 'char_draft_only',
      ownerId: ownerUid,
      projectId: projId,
      name: '미확정인물',
      role: '후보',
      affiliation: '미정',
      personality: '미정',
      abilities: '미승인 능력',
      appearance: '미정',
      status: 'draft',
      canonStatus: 'DRAFT',
    });

    const baseCtx = {
      projectId: projId,
      projectTitle: 'CANON Gate Test Novel',
      projectGenre: 'Fantasy',
      projectSynopsis: '',
      episodeId: 'ep_1',
      episodeNumber: 1,
      episodeTitle: '1화',
      writingMode: 'REWRITE_SELECTION' as const,
      narrativePerspective: 'THIRD_LIMITED' as const,
      projectDefaultPerspective: 'THIRD_LIMITED' as const,
      targetEpisodeCharCount: 4000,
      targetSceneCharCount: 1500,
      tolerancePercent: 15,
      plotOutline: '테스트',
      requiredEvents: [],
      forbiddenDevelopments: [],
      hasGameSystemInWorldbuilding: false,
      canonCharacters: [
        {
          id: 'char_canon_1',
          name: '카엘',
          role: '주인공',
          affiliation: '성기사단',
          personality: '과묵함',
          abilities: '왼팔 중상',
          appearance: '검은 망토',
        },
      ],
      canonWorldbuilding: [],
      activePrompts: [],
      previousEpisodeSummary: '',
      previousEpisodeTailExcerpt: '',
      currentManuscript: '카엘이 성벽에 섰다.',
      approvedExceptions: [],
      referencedSources: [],
      missingEvidenceNotes: [],
      retrievedMemoryChunks: [],
    };

    // 1. Valid owner + matching CANON character passes with SERVER_AUTHORITY
    const validRes = await verifyServerCanonEvidenceForRewrite({
      ownerId: ownerUid,
      projectId: projId,
      episodeId: 'ep_1',
      context: baseCtx,
      sceneQueryHint: '카엘 성벽',
      serverOptions: { db: adminHandle.db },
    });
    assert.equal(validRes.shouldFailClosed, false);
    assert.equal(validRes.canonEvidence.verificationMode, 'SERVER_AUTHORITY');
    assert.equal(validRes.canonEvidence.status, 'VERIFIED');

    // 2. Client attempting to include DRAFT character fails closed as UNAUTHORIZED
    const draftRes = await verifyServerCanonEvidenceForRewrite({
      ownerId: ownerUid,
      projectId: projId,
      episodeId: 'ep_1',
      context: {
        ...baseCtx,
        canonCharacters: [
          ...baseCtx.canonCharacters,
          {
            id: 'char_draft_only',
            name: '미확정인물',
            role: '후보',
            affiliation: '미정',
            personality: '미정',
            abilities: '미승인 능력',
            appearance: '미정',
          },
        ],
      },
      sceneQueryHint: '미확정인물',
      serverOptions: { db: adminHandle.db },
    });
    assert.equal(draftRes.shouldFailClosed, true);
    assert.equal(draftRes.canonEvidence.status, 'UNAUTHORIZED');

    // 3. Cross-tenant caller blocked as UNAUTHORIZED
    const crossTenantRes = await verifyServerCanonEvidenceForRewrite({
      ownerId: otherUid,
      projectId: projId,
      episodeId: 'ep_1',
      context: baseCtx,
      sceneQueryHint: '카엘',
      serverOptions: { db: adminHandle.db },
    });
    assert.equal(crossTenantRes.shouldFailClosed, true);
    assert.equal(crossTenantRes.canonEvidence.status, 'UNAUTHORIZED');

    // 4. Tampered character abilities blocked as STALE
    const staleRes = await verifyServerCanonEvidenceForRewrite({
      ownerId: ownerUid,
      projectId: projId,
      episodeId: 'ep_1',
      context: {
        ...baseCtx,
        canonCharacters: [
          {
            ...baseCtx.canonCharacters[0],
            abilities: '변조된 무한 마력',
          },
        ],
      },
      sceneQueryHint: '카엘',
      serverOptions: { db: adminHandle.db },
    });
    assert.equal(staleRes.shouldFailClosed, true);
    assert.equal(staleRes.canonEvidence.status, 'STALE');
  } finally {
    await adminHandle.db
      .recursiveDelete(adminHandle.db.doc(`users/${ownerUid}`))
      .catch(() => undefined);
    await adminHandle.cleanup();
  }
});

// ============================================================================
// Test 8: Phase 4.3B Stage 2.2 — Full Semantic Integrity & Verified Revision Provenance
// ============================================================================

test('Emulator Test 8 (P0 Stage 2.1 + 2.2): Real Revision provenance verification (E8-A..E8-G), 14-field semantic conflict protection across PROPOSED/CANON, concurrent CAS, and cross-tenant PERMISSION_DENIED', async () => {
  const env = assertRulesEmulatorEnv();
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const owner = await createAndSignInEmulatorUser({
    roleLabel: 'OwnerPropRecover',
    authHost: env.authHost,
    projectId: env.projectId,
    firestoreHostname: env.firestoreHostname,
    firestorePort: env.firestorePort,
    databaseId: env.databaseId,
    email: `prop_recover_${suffix}@novelforge.local`,
    password: 'StrongPassword#1234',
    appName: `client_prop_${suffix}`,
    adminAppName: `admin_prop_${suffix}`,
  });
  const otherUser = await createAndSignInEmulatorUser({
    roleLabel: 'OtherTenantProp',
    authHost: env.authHost,
    projectId: env.projectId,
    firestoreHostname: env.firestoreHostname,
    firestorePort: env.firestorePort,
    databaseId: env.databaseId,
    email: `other_tenant_${suffix}@novelforge.local`,
    password: 'StrongPassword#1234',
    appName: `client_other_prop_${suffix}`,
    adminAppName: `admin_other_prop_${suffix}`,
  });
  const adminHandle = createIsolatedTestFirestoreClient({
    runId: `admin_prop_db_${suffix}`,
    projectId: env.projectId,
    databaseId: env.databaseId,
  });

  const projId = `proj_prop_${suffix}`;
  const base = `users/${owner.uid}/projects/${projId}`;
  const otherProjId = `proj_other_${suffix}`;
  const otherBase = `users/${otherUser.uid}/projects/${otherProjId}`;

  try {
    await adminHandle.db.doc(base).set({
      id: projId,
      ownerId: owner.uid,
      title: 'Proposal Recovery Test Novel',
      genre: 'Fantasy',
      synopsis: '',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await adminHandle.db.doc(otherBase).set({
      id: otherProjId,
      ownerId: otherUser.uid,
      title: 'Other Tenant Novel',
      genre: 'Fantasy',
      synopsis: '',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const ep1InitialContent = '제1화 초기 본문: 카엘은 성벽 위에서 어둠을 바라보았다.';
    const ep1InitialHash = computeManuscriptContentHash(ep1InitialContent);
    await adminHandle.db.doc(`${base}/episodes/ep_1`).set({
      id: 'ep_1',
      ownerId: owner.uid,
      projectId: projId,
      episodeNumber: 1,
      title: '제1화 성벽의 감시자',
      content: ep1InitialContent,
      synopsis: '',
      authorNote: '',
      charCountWithSpaces: ep1InitialContent.length,
      charCountWithoutSpaces: ep1InitialContent.replace(/\s+/g, '').length,
      status: 'review',
      linkedCharacterIds: [],
      linkedWorldbuildingIds: [],
      latestRevisionId: '',
      contentHash: ep1InitialHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const epOtherContent = '제2화 다른 회차 본문';
    await adminHandle.db.doc(`${base}/episodes/ep_other`).set({
      id: 'ep_other',
      ownerId: owner.uid,
      projectId: projId,
      episodeNumber: 2,
      title: '제2화 다른 회차',
      content: epOtherContent,
      synopsis: '',
      authorNote: '',
      charCountWithSpaces: epOtherContent.length,
      charCountWithoutSpaces: epOtherContent.replace(/\s+/g, '').length,
      status: 'draft',
      linkedCharacterIds: [],
      linkedWorldbuildingIds: [],
      latestRevisionId: '',
      contentHash: computeManuscriptContentHash(epOtherContent),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await adminHandle.db.doc(`${otherBase}/episodes/ep_foreign`).set({
      id: 'ep_foreign',
      ownerId: otherUser.uid,
      projectId: otherProjId,
      episodeNumber: 1,
      title: '타인 회차',
      content: '타인 원고 본문',
      synopsis: '',
      authorNote: '',
      charCountWithSpaces: 8,
      charCountWithoutSpaces: 6,
      status: 'draft',
      linkedCharacterIds: [],
      linkedWorldbuildingIds: [],
      latestRevisionId: '',
      contentHash: computeManuscriptContentHash('타인 원고 본문'),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // E8-A: Commit real Revision A via production commitEpisodeRevisionSafelyFirestore(..., owner.db)
    const ep1RewrittenA = '제1화 리라이팅 A: 카엘은 차가운 돌난간에 기대어 북문 밖 안개를 훑었다.';
    const commitResA = await commitEpisodeRevisionSafelyFirestore(
      {
        uid: owner.uid,
        projectId: projId,
        updatedEpisode: {
          id: 'ep_1',
          ownerId: owner.uid,
          projectId: projId,
          episodeNumber: 1,
          title: '제1화 성벽의 감시자',
          content: ep1RewrittenA,
          synopsis: '',
          authorNote: '',
          charCountWithSpaces: ep1RewrittenA.length,
          charCountWithoutSpaces: ep1RewrittenA.replace(/\s+/g, '').length,
          status: 'confirmed',
          linkedCharacterIds: [],
          linkedWorldbuildingIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        expectedRevisionId: '',
        expectedContentHash: ep1InitialHash,
        createBackupRevisionFirst: true,
        createRevision: true,
        revisionLabel: '정밀 리라이팅 A 반영',
      },
      owner.db
    );
    assert.ok(commitResA.targetRevision);
    const revAId = commitResA.targetRevision.id;
    const revAHash = computeManuscriptContentHash(commitResA.targetRevision.content);

    const revASnap = await adminHandle.db.doc(`${base}/revisions/${revAId}`).get();
    assert.equal(revASnap.exists, true);
    assert.equal(revASnap.data()?.episodeId, 'ep_1');
    assert.equal(revASnap.data()?.ownerId, owner.uid);
    assert.equal(
      computeManuscriptContentHash(String(revASnap.data()?.content || '')),
      revAHash
    );

    const rebound = rebindProposalsToCommittedRevision({
      candidateId: `rw_cand_${suffix}`,
      proposals: [
        {
          id: 'temp_1',
          ownerId: owner.uid,
          projectId: projId,
          targetEntityType: 'WORLDBUILDING',
          targetEntityId: 'wb_1',
          proposedAction: 'UPDATE',
          title: '성벽 규율 1',
          rationale: '근거 1',
          beforeSummary: '이전 1',
          afterSummary: '이후 1',
          proposedPayloadJson: '{"note":"1","meta":{"b":2,"a":1}}',
          canonStatus: 'PROPOSED',
          triggerEpisodeId: 'ep_1',
          triggerSceneId: 'scene_1',
          sourceRevisionId: 'UNSAVED_DRAFT',
          createdBy: 'AI_ENGINE',
          reviewedAt: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'temp_2',
          ownerId: owner.uid,
          projectId: projId,
          targetEntityType: 'CHARACTER',
          targetEntityId: 'char_1',
          proposedAction: 'UPDATE',
          title: '인물 메모 2',
          rationale: '근거 2',
          beforeSummary: '이전 2',
          afterSummary: '이후 2',
          proposedPayloadJson: '{"note":"2","meta":{"z":9,"a":1}}',
          canonStatus: 'PROPOSED',
          triggerEpisodeId: 'ep_1',
          triggerSceneId: 'scene_2',
          sourceRevisionId: 'UNSAVED_DRAFT',
          createdBy: 'AI_ENGINE',
          reviewedAt: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      projectId: projId,
      episodeId: 'ep_1',
      committedRevisionId: revAId,
    });

    // E8-B: Missing Revision MUST fail with SOURCE_REVISION_NOT_FOUND
    const [missingRevProp] = rebindProposalsToCommittedRevision({
      candidateId: `rw_missing_${suffix}`,
      proposals: [rebound[0]],
      projectId: projId,
      episodeId: 'ep_1',
      committedRevisionId: `rev_nonexistent_${suffix}`,
    });
    const missingRevRes = await persistFirestoreChangeProposalsIdempotently(
      owner.uid,
      projId,
      [missingRevProp],
      owner.db,
      {
        requireVerifiedSourceRevision: true,
        expectedEpisodeId: 'ep_1',
        expectedSourceContentHash: revAHash,
      }
    );
    assert.equal(missingRevRes.createdCount, 0);
    assert.equal(missingRevRes.failedCount, 1);
    assert.equal(
      missingRevRes.itemResults[0].errorCode,
      'SOURCE_REVISION_NOT_FOUND'
    );
    const missingPropSnap = await adminHandle.db
      .doc(`${base}/changeProposals/${missingRevProp.id}`)
      .get();
    assert.equal(missingPropSnap.exists, false);

    // E8-C: Revision belonging to ep_other in the SAME project MUST fail with SOURCE_REVISION_MISMATCH
    const commitOtherEp = await commitEpisodeRevisionSafelyFirestore(
      {
        uid: owner.uid,
        projectId: projId,
        updatedEpisode: {
          id: 'ep_other',
          ownerId: owner.uid,
          projectId: projId,
          episodeNumber: 2,
          title: '제2화 다른 회차',
          content: '제2화 수정본',
          synopsis: '',
          authorNote: '',
          charCountWithSpaces: 8,
          charCountWithoutSpaces: 6,
          status: 'draft',
          linkedCharacterIds: [],
          linkedWorldbuildingIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        expectedRevisionId: '',
        expectedContentHash: computeManuscriptContentHash(epOtherContent),
        createRevision: true,
        revisionLabel: '다른 회차 리비전',
      },
      owner.db
    );
    const revOtherEpId = commitOtherEp.targetRevision!.id;
    const [wrongEpRevProp] = rebindProposalsToCommittedRevision({
      candidateId: `rw_wrongep_${suffix}`,
      proposals: [rebound[0]],
      projectId: projId,
      episodeId: 'ep_1',
      committedRevisionId: revOtherEpId,
    });
    const wrongEpRevRes = await persistFirestoreChangeProposalsIdempotently(
      owner.uid,
      projId,
      [wrongEpRevProp],
      owner.db,
      {
        requireVerifiedSourceRevision: true,
        expectedEpisodeId: 'ep_1',
      }
    );
    assert.equal(wrongEpRevRes.createdCount, 0);
    assert.equal(wrongEpRevRes.failedCount, 1);
    assert.equal(wrongEpRevRes.itemResults[0].errorCode, 'SOURCE_REVISION_MISMATCH');

    // E8-D: Cross-tenant Revision reference MUST fail closed with PERMISSION_DENIED (never NOT_FOUND)
    const otherRevId = `rev_other_user_${suffix}`;
    await adminHandle.db.doc(`${otherBase}/revisions/${otherRevId}`).set({
      id: otherRevId,
      ownerId: otherUser.uid,
      projectId: otherProjId,
      episodeId: 'ep_foreign',
      episodeTitle: '타인 회차',
      content: '타인 원고 본문',
      charCountWithSpaces: 8,
      label: '타인 리비전',
      createdAt: new Date(),
    });
    const [foreignRevProp] = rebindProposalsToCommittedRevision({
      candidateId: `rw_foreign_${suffix}`,
      proposals: [rebound[0]],
      projectId: projId,
      episodeId: 'ep_1',
      committedRevisionId: otherRevId,
    });
    const foreignRevRes = await persistFirestoreChangeProposalsIdempotently(
      owner.uid,
      projId,
      [foreignRevProp],
      owner.db,
      {
        requireVerifiedSourceRevision: true,
        expectedEpisodeId: 'ep_1',
        sourceRevisionOwnerId: otherUser.uid,
        sourceRevisionProjectId: otherProjId,
      }
    );
    assert.equal(foreignRevRes.createdCount, 0);
    assert.equal(foreignRevRes.failedCount, 1);
    assert.equal(foreignRevRes.itemResults[0].errorCode, 'PERMISSION_DENIED');
    assert.equal(foreignRevRes.itemResults[0].lookupStatus, 'PERMISSION_DENIED');

    // E8-E: Valid Revision A with mismatched contentHash MUST fail with SOURCE_REVISION_CONTENT_MISMATCH
    const badHashRes = await persistFirestoreChangeProposalsIdempotently(
      owner.uid,
      projId,
      [rebound[0]],
      owner.db,
      {
        requireVerifiedSourceRevision: true,
        expectedEpisodeId: 'ep_1',
        expectedSourceContentHash: computeManuscriptContentHash('변조된 본문 스냅샷'),
      }
    );
    assert.equal(badHashRes.createdCount, 0);
    assert.equal(badHashRes.failedCount, 1);
    assert.equal(
      badHashRes.itemResults[0].errorCode,
      'SOURCE_REVISION_CONTENT_MISMATCH'
    );

    // E8-F (Stage 2.1 + 2.2): Partial failure using real atomic Firestore transaction + Revision A check
    let failSecond = true;
    const partialRes = await persistChangeProposalsIdempotentlyCore(
      rebound,
      {
        persistProposalAtomically: async (prop, opts) => {
          if (failSecond && prop.id === rebound[1].id) {
            throw new Error('503 Transient network drop before commit');
          }
          return persistSingleFirestoreProposalAtomically(
            owner.db,
            owner.uid,
            projId,
            prop,
            opts
          );
        },
      },
      {
        requireVerifiedSourceRevision: true,
        expectedEpisodeId: 'ep_1',
        expectedSourceContentHash: revAHash,
      }
    );
    assert.equal(partialRes.createdCount, 1);
    assert.equal(partialRes.failedCount, 1);
    assert.equal(partialRes.itemResults[0].status, 'CREATED');
    assert.equal(partialRes.itemResults[0].lookupStatus, 'DOCUMENT_NOT_FOUND');
    assert.equal(partialRes.itemResults[1].status, 'FAILED');
    assert.equal(partialRes.itemResults[1].errorCode, 'NETWORK_ERROR');

    // Rules allow client getDoc on non-existent Proposal 2 cleanly (exists === false)
    const missingSnap = await getDoc(
      doc(owner.db, `${base}/changeProposals/${rebound[1].id}`)
    );
    assert.equal(missingSnap.exists(), false);

    // Promote Proposal 1 to CANON via Admin SDK before retry
    await adminHandle.db
      .doc(`${base}/changeProposals/${rebound[0].id}`)
      .update({ canonStatus: 'CANON', reviewedAt: new Date().toISOString() });

    // Retry via production persistFirestoreChangeProposalsIdempotently -> skips CANON 1st, creates 2nd
    failSecond = false;
    const retryRes = await persistFirestoreChangeProposalsIdempotently(
      owner.uid,
      projId,
      rebound,
      owner.db,
      {
        requireVerifiedSourceRevision: true,
        expectedEpisodeId: 'ep_1',
        expectedSourceContentHash: revAHash,
      }
    );
    assert.equal(retryRes.createdCount, 1);
    assert.equal(retryRes.skippedDuplicateCount, 1);
    assert.equal(retryRes.failedCount, 0);
    assert.equal(retryRes.itemResults[0].status, 'SKIPPED_ALREADY_DECIDED');
    assert.equal(
      retryRes.itemResults[0].lookupStatus,
      'DOCUMENT_EXISTS_DECIDED'
    );
    assert.equal(retryRes.itemResults[1].status, 'CREATED');

    // Equivalent re-ordered JSON on re-submission skips cleanly
    const reorderedIdenticalRes = await persistFirestoreChangeProposalsIdempotently(
      owner.uid,
      projId,
      [
        {
          ...rebound[0],
          proposedPayloadJson: '{"meta":{"a":1,"b":2},"note":"1"}',
        },
        {
          ...rebound[1],
          proposedPayloadJson: '{"meta":{"a":1,"z":9},"note":"2"}',
        },
      ],
      owner.db,
      {
        requireVerifiedSourceRevision: true,
        expectedEpisodeId: 'ep_1',
        expectedSourceContentHash: revAHash,
      }
    );
    assert.equal(reorderedIdenticalRes.createdCount, 0);
    assert.equal(reorderedIdenticalRes.skippedDuplicateCount, 2);
    assert.equal(reorderedIdenticalRes.failedCount, 0);
    assert.equal(
      reorderedIdenticalRes.itemResults[0].status,
      'SKIPPED_ALREADY_DECIDED'
    );
    assert.equal(
      reorderedIdenticalRes.itemResults[1].status,
      'SKIPPED_ALREADY_EXISTS'
    );

    // Goal A in Real Emulator: Mutate EVERY immutable field across BOTH CANON (rebound[0]) and PROPOSED (rebound[1]) -> ALL must fail with PROPOSAL_PAYLOAD_CONFLICT / PROPOSAL_OWNER_MISMATCH, NEVER silent skip or overwrite!
    const fieldMutations: Array<{
      name: string;
      patch: Partial<(typeof rebound)[0]>;
      expectedCode: 'PROPOSAL_OWNER_MISMATCH' | 'PROPOSAL_PAYLOAD_CONFLICT' | 'VALIDATION_ERROR';
    }> = [
      {
        name: 'rationale',
        patch: { rationale: '변조된 근거' },
        expectedCode: 'PROPOSAL_PAYLOAD_CONFLICT',
      },
      {
        name: 'beforeSummary',
        patch: { beforeSummary: '변조된 이전' },
        expectedCode: 'PROPOSAL_PAYLOAD_CONFLICT',
      },
      {
        name: 'afterSummary',
        patch: { afterSummary: '변조된 이후' },
        expectedCode: 'PROPOSAL_PAYLOAD_CONFLICT',
      },
      {
        name: 'title',
        patch: { title: '변조된 제목' },
        expectedCode: 'PROPOSAL_PAYLOAD_CONFLICT',
      },
      {
        name: 'proposedAction',
        patch: { proposedAction: 'ARCHIVE' },
        expectedCode: 'PROPOSAL_PAYLOAD_CONFLICT',
      },
      {
        name: 'targetEntityType',
        patch: { targetEntityType: 'EPISODE' },
        expectedCode: 'PROPOSAL_PAYLOAD_CONFLICT',
      },
      {
        name: 'targetEntityId',
        patch: { targetEntityId: 'char_tampered' },
        expectedCode: 'PROPOSAL_PAYLOAD_CONFLICT',
      },
      {
        name: 'triggerEpisodeId',
        patch: { triggerEpisodeId: 'ep_tampered' },
        expectedCode: 'PROPOSAL_PAYLOAD_CONFLICT',
      },
      {
        name: 'triggerSceneId',
        patch: { triggerSceneId: 'scene_tampered' },
        expectedCode: 'PROPOSAL_PAYLOAD_CONFLICT',
      },
      {
        name: 'sourceRevisionId',
        patch: { sourceRevisionId: revOtherEpId },
        expectedCode: 'PROPOSAL_PAYLOAD_CONFLICT',
      },
      {
        name: 'proposedPayloadJson',
        patch: { proposedPayloadJson: '{"note":"tampered"}' },
        expectedCode: 'PROPOSAL_PAYLOAD_CONFLICT',
      },
      {
        name: 'createdBy',
        patch: { createdBy: 'AUTHOR' },
        expectedCode: 'PROPOSAL_PAYLOAD_CONFLICT',
      },
      {
        name: 'ownerId',
        patch: { ownerId: otherUser.uid },
        expectedCode: 'PROPOSAL_OWNER_MISMATCH',
      },
      {
        name: 'projectId',
        patch: { projectId: otherProjId },
        expectedCode: 'VALIDATION_ERROR',
      },
    ];

    for (const targetProp of [rebound[0], rebound[1]]) {
      for (const m of fieldMutations) {
        const res = await persistFirestoreChangeProposalsIdempotently(
          owner.uid,
          projId,
          [{ ...targetProp, ...m.patch }],
          owner.db
        );
        assert.equal(res.createdCount, 0, `${targetProp.id}/${m.name} no create`);
        assert.equal(
          res.skippedDuplicateCount,
          0,
          `${targetProp.id}/${m.name} NEVER skip`
        );
        assert.equal(res.failedCount, 1, `${targetProp.id}/${m.name} fail`);
        assert.equal(res.itemResults[0].errorCode, m.expectedCode);
      }
    }

    // Confirm CANON doc 1 & PROPOSED doc 2 remained completely unmutated
    const p1SnapAfterMutations = await adminHandle.db
      .doc(`${base}/changeProposals/${rebound[0].id}`)
      .get();
    assert.equal(p1SnapAfterMutations.data()?.canonStatus, 'CANON');
    assert.equal(p1SnapAfterMutations.data()?.afterSummary, '이후 1');
    const p2SnapAfterMutations = await adminHandle.db
      .doc(`${base}/changeProposals/${rebound[1].id}`)
      .get();
    assert.equal(p2SnapAfterMutations.data()?.canonStatus, 'PROPOSED');
    assert.equal(p2SnapAfterMutations.data()?.afterSummary, '이후 2');
    assert.equal(p2SnapAfterMutations.data()?.sourceRevisionId, revAId);

    // E8-G: Commit a NEWER Revision B on the SAME ep_1 (advancing latestRevisionId -> revBId),
    // then persist a NEW proposal bound to historical Revision A (revAId + revAHash) -> SUCCEEDS!
    const ep1RewrittenB = '제1화 리라이팅 B: 날카로운 새벽 바람이 북문 성벽을 스쳤다.';
    const commitResB = await commitEpisodeRevisionSafelyFirestore(
      {
        uid: owner.uid,
        projectId: projId,
        updatedEpisode: {
          id: 'ep_1',
          ownerId: owner.uid,
          projectId: projId,
          episodeNumber: 1,
          title: '제1화 성벽의 감시자',
          content: ep1RewrittenB,
          synopsis: '',
          authorNote: '',
          charCountWithSpaces: ep1RewrittenB.length,
          charCountWithoutSpaces: ep1RewrittenB.replace(/\s+/g, '').length,
          status: 'confirmed',
          linkedCharacterIds: [],
          linkedWorldbuildingIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        expectedRevisionId: revAId,
        expectedContentHash: revAHash,
        createBackupRevisionFirst: true,
        createRevision: true,
        revisionLabel: '정밀 리라이팅 B 반영',
      },
      owner.db
    );
    assert.ok(commitResB.targetRevision);
    assert.notEqual(commitResB.targetRevision.id, revAId);

    const [historicalProp] = rebindProposalsToCommittedRevision({
      candidateId: `rw_hist_a_${suffix}`,
      proposals: [
        {
          ...rebound[0],
          id: 'temp_hist_a',
          title: '과거 리비전 A 기반 설정 제안',
          afterSummary: 'Revision B 이후에도 Revision A provenance 보존',
          proposedPayloadJson: '{"historical":true}',
          canonStatus: 'PROPOSED',
        },
      ],
      projectId: projId,
      episodeId: 'ep_1',
      committedRevisionId: revAId,
    });

    const historicalRes = await persistFirestoreChangeProposalsIdempotently(
      owner.uid,
      projId,
      [historicalProp],
      owner.db,
      {
        requireVerifiedSourceRevision: true,
        expectedEpisodeId: 'ep_1',
        expectedSourceContentHash: revAHash,
      }
    );
    assert.equal(historicalRes.createdCount, 1);
    assert.equal(historicalRes.failedCount, 0);
    const histSnap = await adminHandle.db
      .doc(`${base}/changeProposals/${historicalProp.id}`)
      .get();
    assert.equal(histSnap.data()?.sourceRevisionId, revAId);

    // Concurrent CAS create race under identical proposal ID + real Revision -> 1 CREATED + 1 SKIPPED_ALREADY_EXISTS
    const [concurrentProp] = rebindProposalsToCommittedRevision({
      candidateId: `rw_concurrent_${suffix}`,
      proposals: [
        {
          ...rebound[0],
          id: 'temp_concurrent',
          title: '동시 생성 경합 검증',
          afterSummary: '동시 생성 단일 문서 보장',
          proposedPayloadJson: '{"concurrent":true}',
          canonStatus: 'PROPOSED',
        },
      ],
      projectId: projId,
      episodeId: 'ep_1',
      committedRevisionId: commitResB.targetRevision.id,
    });
    const revBHash = computeManuscriptContentHash(commitResB.targetRevision.content);

    const [raceA, raceB] = await Promise.all([
      persistFirestoreChangeProposalsIdempotently(
        owner.uid,
        projId,
        [concurrentProp],
        owner.db,
        {
          requireVerifiedSourceRevision: true,
          expectedEpisodeId: 'ep_1',
          expectedSourceContentHash: revBHash,
        }
      ),
      persistFirestoreChangeProposalsIdempotently(
        owner.uid,
        projId,
        [concurrentProp],
        owner.db,
        {
          requireVerifiedSourceRevision: true,
          expectedEpisodeId: 'ep_1',
          expectedSourceContentHash: revBHash,
        }
      ),
    ]);
    assert.equal(raceA.createdCount + raceB.createdCount, 1);
    assert.equal(
      raceA.skippedDuplicateCount + raceB.skippedDuplicateCount,
      1
    );
    assert.equal(raceA.failedCount + raceB.failedCount, 0);

    const collectionAfterRace = await adminHandle.db
      .collection(`${base}/changeProposals`)
      .get();
    assert.equal(collectionAfterRace.size, 4);

    // Cross-tenant attacker MUST fail closed with PERMISSION_DENIED
    const [crossTenantProp] = rebindProposalsToCommittedRevision({
      candidateId: `rw_intruder_${suffix}`,
      proposals: [
        {
          ...rebound[0],
          id: 'temp_intruder',
          title: '타인 프로젝트 침입 제안',
          afterSummary: '권한 차단 검증',
          proposedPayloadJson: '{"intruder":true}',
          canonStatus: 'PROPOSED',
        },
      ],
      projectId: projId,
      episodeId: 'ep_1',
      committedRevisionId: revAId,
    });

    const crossTenantRes = await persistFirestoreChangeProposalsIdempotently(
      owner.uid,
      projId,
      [crossTenantProp],
      otherUser.db
    );
    assert.equal(crossTenantRes.createdCount, 0);
    assert.equal(crossTenantRes.failedCount, 1);
    assert.equal(crossTenantRes.itemResults[0].status, 'FAILED');
    assert.equal(crossTenantRes.itemResults[0].errorCode, 'PERMISSION_DENIED');
    assert.equal(
      crossTenantRes.itemResults[0].lookupStatus,
      'PERMISSION_DENIED'
    );

    await assertPermissionDenied(
      () =>
        getDoc(
          doc(otherUser.db, `${base}/changeProposals/${rebound[1].id}`)
        ),
      'Cross-tenant user reading owner changeProposal'
    );

    const intruderDocSnap = await adminHandle.db
      .doc(`${base}/changeProposals/${crossTenantProp.id}`)
      .get();
    assert.equal(intruderDocSnap.exists, false);
  } finally {
    await adminHandle.db
      .recursiveDelete(adminHandle.db.doc(`users/${owner.uid}`))
      .catch(() => undefined);
    await adminHandle.db
      .recursiveDelete(adminHandle.db.doc(`users/${otherUser.uid}`))
      .catch(() => undefined);
    await Promise.all([
      owner.cleanup(),
      otherUser.cleanup(),
      adminHandle.cleanup(),
    ]);
  }
});

test('Emulator Test 10: Character Voice DNA tenant isolation, source Revision, CAS and approved scope', async () => {
  const env = assertRulesEmulatorEnv();
  const run = `voice_${Date.now()}`;
  const makeUser = (label: string) => createAndSignInEmulatorUser({
    ...env, roleLabel: label, email: `${label}-${run}@novelforge.local`, password: 'VoiceTest#1881',
    appName: `client_${label}_${run}`, adminAppName: `admin_${label}_${run}`,
  });
  const owner = await makeUser('voice-owner');
  const other = await makeUser('voice-other');
  const handle = createIsolatedTestFirestoreClient({ runId: run, projectId: env.projectId, databaseId: env.databaseId });
  const projectId = 'voice_project';
  const base = `users/${owner.uid}/projects/${projectId}`;
  const characterId = 'voice_character';
  const foreignId = 'foreign_character';
  const episodeId = 'voice_episode';
  const revisionId = 'voice_revision';
  const content = '“북문을 먼저 살피겠습니다.” 카엘이 말했다.\n“경비를 다시 배치하겠습니다.” 카엘이 말했다.\n“확인해 주시겠습니까?” 카엘이 물었다.';
  const seed = createInitialSeedBundle(owner.uid);
  const project = { ...seed.project, ownerId: owner.uid, id: projectId };
  const character = { ...seed.characters[0], id: characterId, name: '카엘', ownerId: owner.uid, projectId };
  const episode = { ...seed.episodes[0], id: episodeId, ownerId: owner.uid, projectId, latestRevisionId: revisionId, content, linkedCharacterIds: [characterId] };
  const revision = { id: revisionId, ownerId: owner.uid, projectId, episodeId, content };
  const firestore = handle.db;
  try {
    const characterRef = firestore.doc(`${base}/characters/${characterId}`);
    const revisionRef = firestore.doc(`${base}/revisions/${revisionId}`);
    await Promise.all([
      firestore.doc(base).set(project),
      characterRef.set(character),
      revisionRef.set(revision),
      firestore.doc(`${base}/episodes/${episodeId}`).set(episode),
      firestore.doc(`users/${owner.uid}/projects/other_voice_project/characters/${foreignId}`)
        .set({ ...character, id: foreignId, projectId: 'other_voice_project' }),
    ]);
    const input = { mode: 'SAVED' as const, episodeId, revisionId, contentHash: computeManuscriptContentHash(content), sceneKind: 'UNKNOWN' as const };
    const request = { projectId, characterId, input, useGemini: false };
    const candidate = await analyzeCharacterVoice(request, owner.uid, firestore);
    assert.equal(candidate.status, 'READY_FOR_REVIEW');
    assert.equal(candidate.sourceReferences[0].revisionId, revisionId);
    assert.equal(candidate.sourceReferences[0].contentHash, input.contentHash);
    await assert.rejects(analyzeCharacterVoice(request, other.uid, firestore), /소유권/);
    await assert.rejects(analyzeCharacterVoice({ ...request, characterId: foreignId }, owner.uid, firestore), /인물을 확인/);
    await assert.rejects(analyzeCharacterVoice({ ...request, input: { ...input, contentHash: computeManuscriptContentHash('different') } }, owner.uid, firestore), /STALE_SOURCE/);
    const initial = {
      ...createNewPromptProfile({ ownerId: owner.uid, projectId, targetCharacterId: characterId, promptType: 'CHARACTER_DIALOGUE_RULES',
        title: '승인 화법', description: '검증', content: buildApprovedVoiceContent(candidate, candidate.suggestedInstructions) }),
      id: voiceProfileId(characterId),
    };
    const created = await saveFirestoreCharacterVoicePrompt(initial, null, candidate.sourceReferences, owner.db);
    assert.equal(created.targetCharacterId, characterId);
    const stored = await getDoc(doc(owner.db, `${base}/writingPromptProfiles/${initial.id}`));
    assert.equal(stored.data()?.targetCharacterId, characterId);
    const retried = await saveFirestoreCharacterVoicePrompt(initial, null, candidate.sourceReferences, owner.db);
    assert.equal(retried.currentVersionId, created.currentVersionId);
    assert.equal((await firestore.collection(`${base}/writingPromptProfiles`).get()).size, 1);
    const rawForeign = { ...stored.data(), id: voiceProfileId(foreignId), targetCharacterId: foreignId, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    await assertPermissionDenied(() => setDoc(doc(owner.db, `${base}/writingPromptProfiles/${rawForeign.id}`), rawForeign), 'foreign project voice target');
    await assertPermissionDenied(() => getDoc(doc(other.db, `${base}/writingPromptProfiles/${initial.id}`)), 'other user profile');
    await assertPermissionDenied(() => getDoc(doc(other.db, `${base}/revisions/${revisionId}`)), 'other user revision');
    const updates = [true, false].map((isActive) => updatePromptProfileContent(created, { content: `승인된 후보 ${isActive}`, isActive }));
    const raced = await Promise.allSettled(updates.map((next) => saveFirestoreCharacterVoicePrompt(next, created, [], owner.db)));
    const winners = raced.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    assert.equal(winners.length, 1);
    const winner = winners[0];
    assert.equal(winner.currentVersionNumber, 2);
    assert.ok(winner.versions.some((version) => version.versionId === created.currentVersionId));
    const inactive = await saveFirestoreCharacterVoicePrompt(updatePromptProfileContent(winner, { content: '비활성 검증', isActive: false }), winner, [], owner.db);
    const ctx = buildWritingContext({
      project, episode, allEpisodes: [episode], characters: [character], worldbuilding: [], promptProfiles: [inactive],
      selectedCharacterIds: [characterId], writingMode: 'SINGLE_SCENE', plotOutline: '', requiredEvents: [], forbiddenDevelopments: [],
    });
    assert.ok(!ctx.activePrompts.some((profile) => profile.profileId === initial.id));
    assert.deepEqual((await characterRef.get()).data(), character);
    assert.equal((await revisionRef.get()).data()?.content, content);
  } finally {
    await firestore.recursiveDelete(firestore.doc(`users/${owner.uid}`));
    await Promise.all([owner.cleanup(), other.cleanup(), handle.cleanup()]);
  }
});

// ============================================================================
// TEST 9: Phase 4.3C Stage 1.1 — Author Style DNA Atomic Persistence, PromptProfile CAS,
//         Active/Inactive Filtering, Cross-Tenant Guard & UI State Transition Integrity (E9-A..E9-J)
// ============================================================================

test('Emulator Test 9 (Phase 4.3C Stage 1.1): Atomic StyleProfile + PromptProfile persistence, PromptProfile CAS, active/inactive filtering, and UI state transition integrity (E9-A..E9-J)', async () => {
  const env = assertRulesEmulatorEnv();
  const suffix = `${Date.now()}_stage1_1_style_cas`;
  const owner = await createAndSignInEmulatorUser({
    roleLabel: 'OwnerStyle',
    authHost: env.authHost,
    projectId: env.projectId,
    firestoreHostname: env.firestoreHostname,
    firestorePort: env.firestorePort,
    databaseId: env.databaseId,
    email: `owner_style_${suffix}@novelforge.local`,
    password: 'StrongPassword#1234',
    appName: `client_owner_style_${suffix}`,
    adminAppName: `admin_owner_style_${suffix}`,
  });
  const otherUser = await createAndSignInEmulatorUser({
    roleLabel: 'IntruderStyle',
    authHost: env.authHost,
    projectId: env.projectId,
    firestoreHostname: env.firestoreHostname,
    firestorePort: env.firestorePort,
    databaseId: env.databaseId,
    email: `intruder_style_${suffix}@novelforge.local`,
    password: 'StrongPassword#1234',
    appName: `client_intruder_style_${suffix}`,
    adminAppName: `admin_intruder_style_${suffix}`,
  });
  const adminHandle = createIsolatedTestFirestoreClient({
    runId: `admin_style_db_${suffix}`,
    projectId: env.projectId,
    databaseId: env.databaseId,
  });
  const projA = `proj_style_a_${suffix}`;
  const projB = `proj_style_b_${suffix}`;
  const baseA = `users/${owner.uid}/projects/${projA}`;
  const baseB = `users/${owner.uid}/projects/${projB}`;

  try {
    for (const projectId of [projA, projB]) {
      await setDoc(doc(owner.db, `users/${owner.uid}/projects/${projectId}`), {
        id: projectId,
        ownerId: owner.uid,
        title: 'Style CAS Test Novel',
        genre: 'Fantasy',
        synopsis: '',
        status: 'draft',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    const episodeId = 'ep_style_source';
    const revisionId = 'rev_style_source';
    const revisionContent = AUTHOR_STYLE_BENCHMARKS[0].sampleText;
    const sourceHash = computeManuscriptContentHash(revisionContent);
    await adminHandle.db.doc(`${baseA}/episodes/${episodeId}`).set({
      ownerId: owner.uid,
      projectId: projA,
      title: 'Stage 1.1 source episode',
      latestRevisionId: revisionId,
    });
    const revisionRef = adminHandle.db.doc(`${baseA}/revisions/${revisionId}`);
    await revisionRef.set({
      ownerId: owner.uid,
      projectId: projA,
      episodeId,
      content: revisionContent,
    });
    const { candidate: candidateA } = await analyzeAuthorStyleOnServer(
      {
        ownerId: owner.uid,
        projectId: projA,
        inputMode: 'SAVED_REVISION',
        episodeId,
        revisionId,
        expectedContentHash: sourceHash,
        useGeminiStage2: false,
      },
      { db: adminHandle.db }
    );
    const instructionsA = buildDefaultSelectedStyleInstructions(candidateA);

    // ------------------------------------------------------------------------
    // E9-A: StyleProfile + PROJECT_STYLE_PROFILE Atomic Initial Creation
    // ------------------------------------------------------------------------
    const idempotencyKey = `e9a_${suffix}`;
    const styleIdA = `style_${idempotencyKey}`;
    const promptIdA = `prompt_${idempotencyKey}`;
    const createPayload = {
      ownerId: owner.uid,
      projectId: projA,
      candidate: candidateA,
      profileTitle: '카엘 단문 액션 문체 v1',
      selectedInstructions: instructionsA,
      createNewProfileInsteadOfOverwrite: true,
      activateOnApprove: true,
      idempotencyKey,
    };
    const createRes = await persistApprovedStyleDnaAtomicallyFirestore(
      owner.uid,
      projA,
      createPayload,
      { nowIso: '2026-11-23T00:00:00.000Z' },
      owner.db
    );

    assert.equal(createRes.approved, true);
    assert.equal(createRes.persistenceStatus, 'COMMITTED');
    assert.equal(createRes.styleProfileSaved, true);
    assert.equal(createRes.promptProfileSaved, true);
    assert.equal(createRes.promptProfile.currentVersionNumber, 1);

    const retry = await persistApprovedStyleDnaAtomicallyFirestore(
      owner.uid,
      projA,
      createPayload,
      { nowIso: '2026-11-23T00:01:00.000Z' },
      owner.db
    );
    assert.equal(retry.persistenceStatus, 'COMMITTED', retry.errorMessage);
    assert.equal(retry.deduplicated, true);
    assert.equal(retry.styleProfile.id, styleIdA);
    assert.equal(retry.promptProfile.id, promptIdA);
    assert.equal((await adminHandle.db.collection(`${baseA}/styleProfiles`).get()).size, 1);
    assert.equal((await adminHandle.db.collection(`${baseA}/writingPromptProfiles`).get()).size, 1);

    const styleSnapA = await getDoc(
      doc(owner.db, `${baseA}/styleProfiles/${styleIdA}`)
    );
    const promptSnapA = await getDoc(
      doc(owner.db, `${baseA}/writingPromptProfiles/${promptIdA}`)
    );
    assert.equal(styleSnapA.exists(), true);
    assert.equal(promptSnapA.exists(), true);
    assert.equal(styleSnapA.data()?.sourceRevisionId, revisionId);
    const metadata = extractStylePromptMetadata(promptSnapA.data()?.content);
    assert.equal(metadata.sourceHash, sourceHash);
    assert.equal(metadata.sourceRevisionId, revisionId);
    assert.equal(metadata.episodeId, episodeId);
    assert.equal((await revisionRef.get()).data()?.content, revisionContent);
    assert.equal(promptSnapA.data()?.currentVersionNumber, 1);
    assert.equal((promptSnapA.data()?.versions || []).length, 1);

    // ------------------------------------------------------------------------
    // E9-B: 2nd Document Failure -> Entire Transaction Rollback (0 Docs Written)
    // ------------------------------------------------------------------------
    const styleIdB = `style_e9b_fail_${suffix}`;
    const promptIdB = `prompt_e9b_fail_${suffix}`;
    const rollbackRes = await persistApprovedStyleDnaAtomicallyFirestore(
      owner.uid,
      projA,
      {
        ownerId: owner.uid,
        projectId: projA,
        candidate: candidateA,
        profileTitle: '롤백 검증용 실패 프로필',
        selectedInstructions: instructionsA,
        createNewProfileInsteadOfOverwrite: true,
        activateOnApprove: true,
      },
      {
        forcedStyleProfileId: styleIdB,
        forcedPromptProfileId: promptIdB,
        simulateSecondWriteFailureForTest: true,
      },
      owner.db
    );

    assert.equal(rollbackRes.approved, false);
    assert.equal(rollbackRes.persistenceStatus, 'NOT_COMMITTED');
    assert.equal(rollbackRes.styleProfileSaved, false);
    assert.equal(rollbackRes.promptProfileSaved, false);

    const rolledBackStyleSnap = await getDoc(
      doc(owner.db, `${baseA}/styleProfiles/${styleIdB}`)
    );
    const rolledBackPromptSnap = await getDoc(
      doc(owner.db, `${baseA}/writingPromptProfiles/${promptIdB}`)
    );
    assert.equal(
      rolledBackStyleSnap.exists(),
      false,
      '1st document (styleProfiles) MUST be rolled back when 2nd write fails'
    );
    assert.equal(
      rolledBackPromptSnap.exists(),
      false,
      '2nd document (writingPromptProfiles) MUST NOT exist on transaction failure'
    );

    // ------------------------------------------------------------------------
    // E9-C: Concurrent PromptProfile v1 -> v2 Update CAS (1 COMMITTED, 1 VERSION_CONFLICT)
    // ------------------------------------------------------------------------
    const baseProfileV1 = createRes.promptProfile;
    const { candidate: candidateTabA } = await analyzeAuthorStyleOnServer({
      useGeminiStage2: false,
      projectId: projA,
      inputMode: 'AUTHOR_SUPPLIED_SAMPLE',
      sampleText: AUTHOR_STYLE_BENCHMARKS[1].sampleText,
      sampleLabel: 'Tab A Update Sample',
    });
    const { candidate: candidateTabB } = await analyzeAuthorStyleOnServer({
      useGeminiStage2: false,
      projectId: projA,
      inputMode: 'AUTHOR_SUPPLIED_SAMPLE',
      sampleText: AUTHOR_STYLE_BENCHMARKS[2].sampleText,
      sampleLabel: 'Tab B Update Sample',
    });

    const [tabARes, tabBRes] = await Promise.all([
      persistApprovedStyleDnaAtomicallyFirestore(
        owner.uid,
        projA,
        {
          ownerId: owner.uid,
          projectId: projA,
          candidate: candidateTabA,
          profileTitle: '카엘 문체 Tab A 수정안',
          selectedInstructions:
            buildDefaultSelectedStyleInstructions(candidateTabA),
          existingStyleProfileId: styleIdA,
          targetPromptProfileId: promptIdA,
          expectedBaseVersionId: baseProfileV1.currentVersionId,
          expectedBaseVersionNumber: baseProfileV1.currentVersionNumber,
          createNewProfileInsteadOfOverwrite: false,
          activateOnApprove: true,
        },
        undefined,
        owner.db
      ),
      persistApprovedStyleDnaAtomicallyFirestore(
        owner.uid,
        projA,
        {
          ownerId: owner.uid,
          projectId: projA,
          candidate: candidateTabB,
          profileTitle: '카엘 문체 Tab B 수정안',
          selectedInstructions:
            buildDefaultSelectedStyleInstructions(candidateTabB),
          existingStyleProfileId: styleIdA,
          targetPromptProfileId: promptIdA,
          expectedBaseVersionId: baseProfileV1.currentVersionId,
          expectedBaseVersionNumber: baseProfileV1.currentVersionNumber,
          createNewProfileInsteadOfOverwrite: false,
          activateOnApprove: true,
        },
        undefined,
        owner.db
      ),
    ]);

    const committedCount =
      (tabARes.persistenceStatus === 'COMMITTED' ? 1 : 0) +
      (tabBRes.persistenceStatus === 'COMMITTED' ? 1 : 0);
    const conflictCount =
      (tabARes.persistenceStatus === 'VERSION_CONFLICT' ? 1 : 0) +
      (tabBRes.persistenceStatus === 'VERSION_CONFLICT' ? 1 : 0);
    assert.equal(committedCount, 1, 'Exactly 1 concurrent update MUST commit');
    assert.equal(
      conflictCount,
      1,
      'The losing concurrent update MUST return VERSION_CONFLICT'
    );

    const winningRes =
      tabARes.persistenceStatus === 'COMMITTED' ? tabARes : tabBRes;
    const losingRes =
      tabARes.persistenceStatus === 'VERSION_CONFLICT' ? tabARes : tabBRes;
    assert.equal(winningRes.promptProfile.currentVersionNumber, 2);
    assert.equal(losingRes.approved, false);

    // ------------------------------------------------------------------------
    // E9-D: Existing Version History Preserved on Update & Failed Update
    // ------------------------------------------------------------------------
    const afterRaceProfile = await fetchFirestorePromptProfileById(
      owner.uid,
      projA,
      promptIdA,
      owner.db
    );
    assert.ok(afterRaceProfile);
    assert.equal(afterRaceProfile.currentVersionNumber, 2);
    assert.equal(afterRaceProfile.versions.length, 2);
    assert.ok(
      afterRaceProfile.versions.some(
        (v) => v.versionId === baseProfileV1.currentVersionId
      ),
      'v1 MUST still be preserved in versions history after v2 commit'
    );

    // Also test PromptProfile CAS restore version (v1 restored as v3 preserving v1 & v2)
    const restoredToV1AsV3 = restorePromptProfileToVersion(
      afterRaceProfile,
      baseProfileV1.currentVersionId
    );
    const restoreCasRes = await updateFirestorePromptProfileWithCas(
      owner.uid,
      projA,
      restoredToV1AsV3,
      {
        expectedVersionId: afterRaceProfile.currentVersionId,
        expectedVersionNumber: afterRaceProfile.currentVersionNumber,
      },
      owner.db
    );
    assert.equal(restoreCasRes.committed, true);
    assert.equal(restoreCasRes.profile.currentVersionNumber, 3);
    assert.equal(restoreCasRes.profile.versions.length, 3);

    // ------------------------------------------------------------------------
    // E9-E, E9-F, E9-G: Inactive Exclusion, Selected+Inactive Exclusion, Active Inclusion
    // ------------------------------------------------------------------------
    const projectStub = {
      id: projA,
      ownerId: owner.uid,
      title: '에테르나 연대기',
      genre: '다크 판타지',
      synopsis: '시놉시스',
      status: 'confirmed' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const episodeStub = {
      id: 'ep_1',
      ownerId: owner.uid,
      projectId: projA,
      episodeNumber: 1,
      title: '1화',
      content: '카엘은 검을 뽑았다. 어둠이 내렸다.',
      synopsis: '1화 요약',
      authorNote: '',
      charCountWithSpaces: 18,
      charCountWithoutSpaces: 14,
      status: 'draft' as const,
      linkedCharacterIds: [],
      linkedWorldbuildingIds: [],
      latestRevisionId: 'rev_1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // E9-G: Active style profile IS included in Novel Writer Step 5 and Rewriting Engine
    const activeStyleProfile = restoreCasRes.profile;
    const ctxActive = buildWritingContext({
      project: projectStub,
      episode: episodeStub,
      allEpisodes: [episodeStub],
      characters: [],
      worldbuilding: [],
      promptProfiles: [activeStyleProfile],
      selectedCharacterIds: [],
      selectedPromptProfileIds: [activeStyleProfile.id],
      writingMode: 'SINGLE_SCENE',
      plotOutline: '전투 장면',
      requiredEvents: [],
      forbiddenDevelopments: [],
    });
    assert.ok(
      ctxActive.activePrompts.some((p) => p.profileId === activeStyleProfile.id),
      'E9-G: Active PROJECT_STYLE_PROFILE MUST be included in activePrompts'
    );
    const assembledActive = assembleNovelWriterPromptInOrder({
      context: ctxActive,
    });
    assert.ok(
      assembledActive.orderedPrompt.includes(activeStyleProfile.currentVersionId),
      'E9-G: Novel Writer Step 5 prompt MUST include active PROJECT_STYLE_PROFILE version'
    );

    const rewriteActive = buildLiteraryRewritePrompt({
      request: {
        projectId: projA,
        episodeId: 'ep_1',
        sourceRevisionId: 'rev_1',
        manuscript: episodeStub.content,
        anchor: {
          sourceRevisionId: 'rev_1',
          sourceContentHash: computeManuscriptContentHash(episodeStub.content),
          startOffset: 0,
          endOffset: episodeStub.content.length,
          originalExcerpt: episodeStub.content,
        },
        modes: ['R1'],
        context: ctxActive,
      },
    });
    assert.ok(
      rewriteActive.appliedPromptVersionIds.includes(
        activeStyleProfile.currentVersionId
      ),
      'E9-G: Literary Rewriting prompt MUST include active PROJECT_STYLE_PROFILE version'
    );

    // Deactivate style profile in Firestore via CAS
    const deactivatedCandidate: typeof activeStyleProfile = {
      ...activeStyleProfile,
      isActive: false,
      updatedAt: new Date().toISOString(),
    };
    const deactivateCasRes = await updateFirestorePromptProfileWithCas(
      owner.uid,
      projA,
      deactivatedCandidate,
      {
        expectedVersionId: activeStyleProfile.currentVersionId,
        expectedVersionNumber: activeStyleProfile.currentVersionNumber,
      },
      owner.db
    );
    assert.equal(deactivateCasRes.committed, true);
    assert.equal(deactivateCasRes.profile.isActive, false);

    // E9-E (selectedPromptProfileIds === undefined) & E9-F (selectedPromptProfileIds includes inactive ID):
    // Inactive PROJECT_STYLE_PROFILE MUST NEVER be included!
    const ctxInactiveDefault = buildWritingContext({
      project: projectStub,
      episode: episodeStub,
      allEpisodes: [episodeStub],
      characters: [],
      worldbuilding: [],
      promptProfiles: [deactivateCasRes.profile],
      selectedCharacterIds: [],
      selectedPromptProfileIds: undefined,
      writingMode: 'SINGLE_SCENE',
      plotOutline: '전투 장면',
      requiredEvents: [],
      forbiddenDevelopments: [],
    });
    assert.equal(
      ctxInactiveDefault.activePrompts.some(
        (p) => p.profileId === deactivateCasRes.profile.id
      ),
      false,
      'E9-E: Inactive PROJECT_STYLE_PROFILE MUST be excluded when selectedPromptProfileIds is undefined'
    );

    const ctxInactiveSelected = buildWritingContext({
      project: projectStub,
      episode: episodeStub,
      allEpisodes: [episodeStub],
      characters: [],
      worldbuilding: [],
      promptProfiles: [deactivateCasRes.profile],
      selectedCharacterIds: [],
      selectedPromptProfileIds: [deactivateCasRes.profile.id],
      writingMode: 'SINGLE_SCENE',
      plotOutline: '전투 장면',
      requiredEvents: [],
      forbiddenDevelopments: [],
    });
    assert.equal(
      ctxInactiveSelected.activePrompts.some(
        (p) => p.profileId === deactivateCasRes.profile.id
      ),
      false,
      'E9-F: Inactive PROJECT_STYLE_PROFILE MUST be excluded even if its ID is in selectedPromptProfileIds'
    );

    // ------------------------------------------------------------------------
    // E9-H: Cross-Project / Cross-Owner StyleProfile & PromptProfile Rejection
    // ------------------------------------------------------------------------
    const intruderRes = await persistApprovedStyleDnaAtomicallyFirestore(
      owner.uid,
      projA,
      {
        ownerId: owner.uid,
        projectId: projA,
        candidate: candidateA,
        profileTitle: '침입자 문체 변조 시도',
        selectedInstructions: instructionsA,
        existingStyleProfileId: styleIdA,
        targetPromptProfileId: promptIdA,
        expectedBaseVersionId: deactivateCasRes.profile.currentVersionId,
        expectedBaseVersionNumber: deactivateCasRes.profile.currentVersionNumber,
        createNewProfileInsteadOfOverwrite: false,
        activateOnApprove: true,
      },
      undefined,
      otherUser.db
    );
    assert.equal(intruderRes.approved, false);
    assert.equal(intruderRes.persistenceStatus, 'PERMISSION_DENIED');

    // Cross-project prompt profile ID passed to Project A writing context MUST be rejected
    const crossProjectPrompt = {
      ...activeStyleProfile,
      id: `prompt_proj_b_${suffix}`,
      projectId: projB,
      isActive: true,
    };
    const ctxCrossProject = buildWritingContext({
      project: projectStub,
      episode: episodeStub,
      allEpisodes: [episodeStub],
      characters: [],
      worldbuilding: [],
      promptProfiles: [crossProjectPrompt],
      selectedCharacterIds: [],
      selectedPromptProfileIds: [crossProjectPrompt.id],
      writingMode: 'SINGLE_SCENE',
      plotOutline: '전투 장면',
      requiredEvents: [],
      forbiddenDevelopments: [],
    });
    assert.equal(
      ctxCrossProject.activePrompts.some(
        (p) => p.profileId === crossProjectPrompt.id
      ),
      false,
      'E9-H: Cross-project PromptProfile ID MUST be excluded from Project A writing context'
    );

    // ------------------------------------------------------------------------
    // E9-I: Concurrent Create with Same ID Does Not Overwrite Earlier Commit
    // ------------------------------------------------------------------------
    const collisionPromptId = `prompt_e9i_collision_${suffix}`;
    const collisionStyleId = `style_e9i_collision_${suffix}`;
    const secondCreateAttempt = await persistApprovedStyleDnaAtomicallyFirestore(
      owner.uid,
      projA,
      {
        ownerId: owner.uid,
        projectId: projA,
        candidate: candidateTabB,
        profileTitle: '동일 ID 덮어쓰기 시도 프로필',
        selectedInstructions:
          buildDefaultSelectedStyleInstructions(candidateTabB),
        createNewProfileInsteadOfOverwrite: true,
        activateOnApprove: true,
      },
      {
        forcedStyleProfileId: collisionStyleId,
        forcedPromptProfileId: promptIdA, // Already exists in Firestore!
      },
      owner.db
    );
    assert.equal(secondCreateAttempt.approved, false);
    assert.equal(secondCreateAttempt.persistenceStatus, 'VERSION_CONFLICT');
    void collisionPromptId;

    // ------------------------------------------------------------------------
    // E9-J: UI State Transition Integrity on Save Failure / Version Conflict
    // ------------------------------------------------------------------------
    const uiAfterFailure = evaluateStyleApprovalUiTransition({
      previousStyleProfiles: [createRes.styleProfile],
      previousPromptProfiles: [deactivateCasRes.profile],
      draftTitle: '작가 편집 중 제목',
      draftInstructions: instructionsA,
      previousTargetPromptProfileId: promptIdA,
      result: rollbackRes,
    });
    assert.equal(uiAfterFailure.showSuccessBanner, false);
    assert.equal(uiAfterFailure.showErrorBanner, true);
    assert.equal(uiAfterFailure.activatedInWriter, false);
    assert.equal(
      uiAfterFailure.committedPromptProfiles[0].currentVersionId,
      deactivateCasRes.profile.currentVersionId
    );
    assert.equal(uiAfterFailure.preservedDraftTitle, '작가 편집 중 제목');
    assert.equal(
      uiAfterFailure.preservedDraftInstructions.length,
      instructionsA.length
    );

    const uiAfterConflict = evaluateStyleApprovalUiTransition({
      previousStyleProfiles: [createRes.styleProfile],
      previousPromptProfiles: [winningRes.promptProfile],
      draftTitle: '작가 충돌 시 편집 중 제목',
      draftInstructions: instructionsA,
      previousTargetPromptProfileId: promptIdA,
      result: losingRes,
    });
    assert.equal(uiAfterConflict.showSuccessBanner, false);
    assert.equal(uiAfterConflict.showConflictPanel, true);
    assert.equal(uiAfterConflict.activatedInWriter, false);
    assert.equal(
      uiAfterConflict.committedPromptProfiles[0].versions.length,
      winningRes.promptProfile.versions.length
    );
    assert.equal(
      uiAfterConflict.preservedDraftTitle,
      '작가 충돌 시 편집 중 제목'
    );
  } finally {
    await adminHandle.db
      .recursiveDelete(adminHandle.db.doc(`users/${owner.uid}`))
      .catch(() => undefined);
    await adminHandle.db
      .recursiveDelete(adminHandle.db.doc(`users/${otherUser.uid}`))
      .catch(() => undefined);
    await Promise.all([
      owner.cleanup(),
      otherUser.cleanup(),
      adminHandle.cleanup(),
    ]);
  }
});

