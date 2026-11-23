import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { registerIsolatedMockFirestoreForTest } from '../server/authMiddleware';
import {
  approveChangeProposalOnServer,
  rejectChangeProposalOnServer,
} from '../server/changeProposalApprovalEngine';
import { resolveAnalysisTokenHmacSecret } from '../server/manuscriptExtractionEngine';

test('Phase 4.2.2 Security (Section 3.1): resolveAnalysisTokenHmacSecret fails closed in production when NOVEL_FORGE_ANALYSIS_TOKEN_SECRET is unset', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevSecret1 = process.env.NOVEL_FORGE_ANALYSIS_TOKEN_SECRET;
  const prevSecret2 = process.env.ANALYSIS_TOKEN_HMAC_SECRET;

  try {
    delete process.env.NOVEL_FORGE_ANALYSIS_TOKEN_SECRET;
    delete process.env.ANALYSIS_TOKEN_HMAC_SECRET;
    process.env.NODE_ENV = 'production';

    assert.throws(
      () => resolveAnalysisTokenHmacSecret({ allowTestFallback: false }),
      /\[ANALYSIS_TOKEN_SECRET_MISSING\]/
    );

    process.env.NOVEL_FORGE_ANALYSIS_TOKEN_SECRET =
      'prod_configured_hmac_secret_key_01';
    assert.equal(
      resolveAnalysisTokenHmacSecret({ allowTestFallback: false }),
      'prod_configured_hmac_secret_key_01'
    );
  } finally {
    if (prevNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = prevNodeEnv;
    }
    if (prevSecret1 === undefined) {
      delete process.env.NOVEL_FORGE_ANALYSIS_TOKEN_SECRET;
    } else {
      process.env.NOVEL_FORGE_ANALYSIS_TOKEN_SECRET = prevSecret1;
    }
    if (prevSecret2 === undefined) {
      delete process.env.ANALYSIS_TOKEN_HMAC_SECRET;
    } else {
      process.env.ANALYSIS_TOKEN_HMAC_SECRET = prevSecret2;
    }
  }
});

test('Phase 4.2.2 Security (Section 3.2): AiExtractionPanel initializes selectedCandidateIds to [] after analysis completes', () => {
  const panelSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/AiExtractionPanel.tsx'),
    'utf8'
  );

  // Verify handleRunAnalysis sets selectedCandidateIds to [] and does not pre-select initialSavableIds
  assert.equal(panelSource.includes('setSelectedCandidateIds([]);'), true);
  assert.equal(
    panelSource.includes('setSelectedCandidateIds(initialSavableIds)'),
    false
  );
  // Verify explicit select-all button remains available for author convenience
  assert.equal(panelSource.includes('검증 후보 전체 선택'), true);
});

test('Phase 4.2.2 Security: Unverified Firestore instance or missing testMode DB is strictly rejected', async () => {
  const unverifiedDb = {
    doc: () => ({}),
    collection: () => ({}),
    runTransaction: async () => ({}),
  } as unknown as Firestore;

  await assert.rejects(
    async () =>
      approveChangeProposalOnServer(
        {
          projectId: 'proj_01',
          proposalId: 'prop_01',
        },
        {
          db: unverifiedDb,
          verifiedOwnerId: 'user_01',
        }
      ),
    /ISOLATED_TEST_DB_UNVERIFIED/
  );

  await assert.rejects(
    async () =>
      approveChangeProposalOnServer(
        {
          projectId: 'proj_01',
          proposalId: 'prop_01',
        },
        {
          testMode: true,
          verifiedOwnerId: 'user_01',
        }
      ),
    /\[TEST_ISOLATED_DB_REQUIRED\]/
  );
});

test('Phase 4.2.2 Security: Tenant isolation blocks cross-owner approval/rejection and state machine blocks REJECTED -> CANON or CANON -> REJECTED transitions', async () => {
  const store = new Map<string, Record<string, unknown>>();
  const mockDb = {
    doc: (docPath: string) => ({
      path: docPath,
      __kind: 'docRef',
      get: async () => ({
        id: docPath.split('/').pop() || '',
        exists: store.has(docPath),
        data: () => store.get(docPath),
      }),
    }),
    collection: (colPath: string) => ({
      path: colPath,
      __kind: 'colRef',
      get: async () => ({ empty: true, size: 0, docs: [] }),
    }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const tx = {
        get: async (target: { path: string }) => ({
          id: target.path.split('/').pop() || '',
          exists: store.has(target.path),
          data: () => store.get(target.path),
        }),
        set: (target: { path: string }, data: Record<string, unknown>) => {
          store.set(target.path, data);
        },
      };
      return fn(tx);
    },
  } as unknown as Firestore;

  registerIsolatedMockFirestoreForTest(mockDb, {
    projectId: 'test-sec-phase422',
    databaseId: 'test-db-phase422-sec',
    runId: 'run_sec_01',
  });

  const ownerA = 'user_owner_A';
  const attackerB = 'user_attacker_B';
  const projectId = 'proj_sec_01';
  const ts = Timestamp.now();

  // Seed under attackerB's path a document whose internal ownerId belongs to ownerA
  store.set(`users/${attackerB}/projects/${projectId}`, {
    id: projectId,
    ownerId: ownerA,
    title: '타인 프로젝트',
  });

  await assert.rejects(
    async () =>
      approveChangeProposalOnServer(
        { projectId, proposalId: 'prop_01' },
        { db: mockDb, verifiedOwnerId: attackerB }
      ),
    /\[TENANT_ISOLATION_VIOLATION\]/
  );

  // Seed a REJECTED proposal under ownerA and verify it cannot be approved to CANON
  const basePath = `users/${ownerA}/projects/${projectId}`;
  store.set(basePath, {
    id: projectId,
    ownerId: ownerA,
    title: '정상 프로젝트',
  });

  const validEnvelope = {
    schemaVersion: 'PHASE_4_2_1_V1',
    fingerprint: 'fp_sec_01',
    targetEntityType: 'RELATIONSHIP',
    proposedAction: 'CREATE',
    targetEntityId: 'rel_01',
    sourceEpisodeId: 'ep_01',
    sourceRevisionId: 'rev_01',
    sourceSceneId: 'scn_01',
    verifiedExcerpt: {
      excerpt: '테스트 발췌',
      matchedText: '테스트 발췌',
      startOffset: 0,
      endOffset: 6,
      matchMethod: 'EXACT',
    },
    precedingContext: null,
    followingContext: null,
    confidence: 0.9,
    dialogueClaimOnly: false,
    temporalContextType: 'PRESENT_EVENT',
    uncertaintyFlags: [],
    canonConflicts: [],
    provenance: { createdBy: 'AI_ENGINE', sourceRevisionId: 'rev_01' },
    relationshipDraft: {
      id: 'rel_01',
      ownerId: ownerA,
      projectId,
      sourceCharacterId: 'char_1',
      sourceCharacterName: '인물1',
      targetCharacterId: 'char_2',
      targetCharacterName: '인물2',
      relationType: '동맹',
      affinityScore: 50,
      isDirectional: false,
      description: '동맹 관계',
      canonStatus: 'PROPOSED',
      lastChangedEpisodeId: 'ep_01',
      sourceRevisionId: 'rev_01',
      provenance: { createdBy: 'AI_ENGINE', sourceRevisionId: 'rev_01' },
    },
  };

  store.set(`${basePath}/changeProposals/prop_rejected_01`, {
    id: 'prop_rejected_01',
    ownerId: ownerA,
    projectId,
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: 'rel_01',
    proposedAction: 'CREATE',
    title: '반려된 제안서',
    rationale: '근거',
    beforeSummary: '전',
    afterSummary: '후',
    proposedPayloadJson: JSON.stringify(validEnvelope),
    triggerEpisodeId: 'ep_01',
    sourceRevisionId: 'rev_01',
    canonStatus: 'REJECTED',
    reviewedAt: '2026-04-01T10:00:00.000Z',
    createdBy: 'AI_ENGINE',
    createdAt: ts,
    updatedAt: ts,
  });

  await assert.rejects(
    async () =>
      approveChangeProposalOnServer(
        { projectId, proposalId: 'prop_rejected_01' },
        { db: mockDb, verifiedOwnerId: ownerA }
      ),
    /\[INVALID_PROPOSAL_STATE\]/
  );

  // Seed a CANON proposal and verify it cannot be rejected
  store.set(`${basePath}/changeProposals/prop_canon_01`, {
    ...store.get(`${basePath}/changeProposals/prop_rejected_01`),
    id: 'prop_canon_01',
    canonStatus: 'CANON',
  });

  await assert.rejects(
    async () =>
      rejectChangeProposalOnServer(
        { projectId, proposalId: 'prop_canon_01' },
        { db: mockDb, verifiedOwnerId: ownerA }
      ),
    /\[INVALID_PROPOSAL_STATE\]/
  );
});

test('Phase 4.2.2 Security (Step 7): firestore.rules enforces server-only approval for RELATIONSHIP/TIMELINE_EVENT/FORESHADOWING and read-only client access on changeProposalApprovalAudits', () => {
  const rulesText = fs.readFileSync(
    path.resolve(process.cwd(), 'firestore.rules'),
    'utf8'
  );

  // 1. Client SDK blocked from promoting RELATIONSHIP, TIMELINE_EVENT, FORESHADOWING proposals directly to CANON
  assert.equal(
    rulesText.includes(
      "existing().targetEntityType in ['RELATIONSHIP', 'TIMELINE_EVENT', 'FORESHADOWING']"
    ),
    true
  );
  assert.equal(
    rulesText.includes("incoming().canonStatus == 'CANON'"),
    true
  );

  // 2. Decided proposals cannot be reverted to PROPOSED by client SDK
  assert.equal(
    rulesText.includes(
      "existing().canonStatus in ['CANON', 'REJECTED', 'ARCHIVED']"
    ),
    true
  );

  // 3. Stage 1.5: Client SDK also blocked from transitioning RELATIONSHIP/TIMELINE_EVENT/FORESHADOWING to REJECTED,
  // tampering with proposedPayloadJson, or deleting decided proposals
  assert.equal(
    rulesText.includes("incoming().canonStatus == 'REJECTED'"),
    true
  );
  assert.equal(
    rulesText.includes(
      'incoming().proposedPayloadJson == existing().proposedPayloadJson'
    ),
    true
  );
  assert.equal(
    rulesText.includes("existing().canonStatus == 'PROPOSED'"),
    true
  );

  // 4. changeProposalApprovalAudits subcollection is owner-readable and strictly forbidden for client writes
  const auditRuleStart = rulesText.indexOf(
    'match /changeProposalApprovalAudits/{auditId}'
  );
  assert.ok(auditRuleStart > 0);
  const auditRuleBlock = rulesText.slice(auditRuleStart, auditRuleStart + 600);
  assert.equal(auditRuleBlock.includes('allow get:'), true);
  assert.equal(auditRuleBlock.includes('allow list:'), true);
  assert.equal(auditRuleBlock.includes('allow create: if false;'), true);
  assert.equal(auditRuleBlock.includes('allow update: if false;'), true);
  assert.equal(auditRuleBlock.includes('allow delete: if false;'), true);

  // 5. Stage 2 Section 2: changeProposals allow create enforces incoming().canonStatus == 'PROPOSED'
  const proposalRuleStart = rulesText.indexOf(
    'match /changeProposals/{proposalId}'
  );
  assert.ok(proposalRuleStart > 0);
  const proposalRuleBlock = rulesText.slice(
    proposalRuleStart,
    proposalRuleStart + 700
  );
  assert.equal(
    proposalRuleBlock.includes("incoming().canonStatus == 'PROPOSED'"),
    true
  );

  // 6. Stage 2 Section 11: MemoryDocument and MemoryChunk allow RELATIONSHIP sourceEntityType
  assert.equal(rulesText.includes("'RELATIONSHIP'"), true);

  // 7. Stage 2 Section 12: ragSyncTasks subcollection is owner-readable and strictly forbidden for client writes
  const ragTaskStart = rulesText.indexOf('match /ragSyncTasks/{taskId}');
  assert.ok(ragTaskStart > 0);
  const ragTaskBlock = rulesText.slice(ragTaskStart, ragTaskStart + 600);
  assert.equal(ragTaskBlock.includes('allow get:'), true);
  assert.equal(ragTaskBlock.includes('allow list:'), true);
  assert.equal(ragTaskBlock.includes('allow create: if false;'), true);
  assert.equal(ragTaskBlock.includes('allow update: if false;'), true);
  assert.equal(ragTaskBlock.includes('allow delete: if false;'), true);
});

