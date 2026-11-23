import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { registerIsolatedMockFirestoreForTest } from '../server/authMiddleware';
import {
  approveChangeProposalOnServer,
  rejectChangeProposalOnServer,
} from '../server/changeProposalApprovalEngine';
import type { ChangeProposalPayloadEnvelope } from '../types/manuscriptExtraction';
import {
  computeDeterministicApprovalAuditId,
  computeLegacyApprovalAuditId,
} from './changeProposalApprovalLogic';

const OWNER_ID = 'user_audit_hardening_01';
const PROJECT_ID = 'proj_audit_hardening_01';
const EPISODE_ID = 'ep_audit_01';
const SCENE_ID = 'scn_audit_01';
const REVISION_ID = 'rev_audit_01';

const MANUSCRIPT_TEXT = [
  '검은 성채의 성벽 위에서 강현우는 이서연에게 차갑게 검을 겨누었다.',
  '"다시 만나면 적이라고 했을 텐데."',
  '그날의 맹세는 부서진 은빛 회중시계 속에 잠들어 있었다.',
].join('\n\n');

const EXCERPT_1 = '강현우는 이서연에게 차갑게 검을 겨누었다.';
const EXCERPT_1_START = MANUSCRIPT_TEXT.indexOf(EXCERPT_1);
const EXCERPT_1_END = EXCERPT_1_START + EXCERPT_1.length;

function createAuditTestMockFirestore(options: {
  runId: string;
  failOnAuditCreate?: boolean;
}): {
  db: Firestore;
  store: Map<string, Record<string, unknown>>;
} {
  const store = new Map<string, Record<string, unknown>>();

  const makeDocSnapshot = (docPath: string) => {
    const raw = store.get(docPath);
    const segments = docPath.split('/');
    const id = segments[segments.length - 1] || '';
    return {
      id,
      exists: raw !== undefined,
      data: () => (raw ? { ...raw } : undefined),
    };
  };

  const makeDocRef = (docPath: string) => {
    const segments = docPath.split('/');
    const id = segments[segments.length - 1] || '';
    return {
      id,
      path: docPath,
      __kind: 'docRef' as const,
      get: async () => makeDocSnapshot(docPath),
      set: async (data: Record<string, unknown>) => {
        store.set(docPath, { ...data });
      },
    };
  };

  const mockDb = {
    doc: (docPath: string) => makeDocRef(docPath),
    runTransaction: async <T>(
      updateFunction: (tx: unknown) => Promise<T>
    ): Promise<T> => {
      const stagedWrites = new Map<string, Record<string, unknown>>();
      let hasStartedWriting = false;

      const tx = {
        get: async (target: { path: string }) => {
          if (hasStartedWriting) {
            throw new Error(
              '[FIRESTORE_TX_READ_AFTER_WRITE] Reads must execute before writes.'
            );
          }
          return makeDocSnapshot(target.path);
        },
        set: (target: { path: string }, data: Record<string, unknown>) => {
          hasStartedWriting = true;
          stagedWrites.set(target.path, { ...data });
        },
        create: (target: { path: string }, data: Record<string, unknown>) => {
          hasStartedWriting = true;
          if (
            options.failOnAuditCreate &&
            target.path.includes('/changeProposalApprovalAudits/')
          ) {
            throw new Error(
              '[SIMULATED_AUDIT_CREATE_FAILURE] Audit create failed mid-transaction.'
            );
          }
          if (store.has(target.path) || stagedWrites.has(target.path)) {
            throw new Error(
              `[FIRESTORE_TX_ALREADY_EXISTS] Document already exists at ${target.path}`
            );
          }
          stagedWrites.set(target.path, { ...data });
        },
      };

      const result = await updateFunction(tx);
      for (const [k, v] of stagedWrites.entries()) {
        store.set(k, v);
      }
      return result;
    },
  } as unknown as Firestore;

  registerIsolatedMockFirestoreForTest(mockDb, {
    projectId: 'test-isolated-phase422-s15-audit',
    databaseId: 'test-db-phase422-s15-audit',
    runId: options.runId,
  });

  return { db: mockDb, store };
}

function seedAuditTestFixtures(
  store: Map<string, Record<string, unknown>>,
  proposalId = 'prop_audit_01',
  canonStatus: 'PROPOSED' | 'CANON' | 'REJECTED' = 'PROPOSED'
) {
  const basePath = `users/${OWNER_ID}/projects/${PROJECT_ID}`;
  const ts = Timestamp.fromDate(new Date('2026-04-01T09:00:00.000Z'));

  store.set(basePath, {
    id: PROJECT_ID,
    ownerId: OWNER_ID,
    title: '감사 무결성 연대기',
    genre: '판타지',
    synopsis: '',
    status: 'confirmed',
    canonStatus: 'CANON',
    createdAt: ts,
    updatedAt: ts,
  });

  store.set(`${basePath}/episodes/${EPISODE_ID}`, {
    id: EPISODE_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    episodeNumber: 1,
    title: '제1화',
    content: MANUSCRIPT_TEXT,
    synopsis: '',
    authorNote: '',
    charCountWithSpaces: MANUSCRIPT_TEXT.length,
    charCountWithoutSpaces: MANUSCRIPT_TEXT.replace(/\s+/g, '').length,
    status: 'confirmed',
    canonStatus: 'CANON',
    linkedCharacterIds: ['char_hyunwoo', 'char_seoyeon'],
    linkedWorldbuildingIds: [],
    createdAt: ts,
    updatedAt: ts,
  });

  store.set(`${basePath}/scenes/${SCENE_ID}`, {
    id: SCENE_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    sceneNumber: 1,
    title: '성벽 위',
    summary: '대치',
    location: '검은 성채',
    pointOfViewCharacterId: 'char_hyunwoo',
    eventIds: [],
    characterIds: ['char_hyunwoo', 'char_seoyeon'],
    foreshadowingIds: [],
    canonStatus: 'CANON',
    sourceRevisionId: REVISION_ID,
    createdAt: ts,
    updatedAt: ts,
  });

  store.set(`${basePath}/revisions/${REVISION_ID}`, {
    id: REVISION_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    episodeTitle: '제1화',
    content: MANUSCRIPT_TEXT,
    charCountWithSpaces: MANUSCRIPT_TEXT.length,
    label: '리비전 1',
    createdAt: ts,
  });

  store.set(`${basePath}/characters/char_hyunwoo`, {
    id: 'char_hyunwoo',
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    name: '강현우',
    role: '주인공',
    affiliation: '기사단',
    appearance: '',
    personality: '',
    background: '',
    abilities: '',
    status: 'confirmed',
    canonStatus: 'CANON',
    linkedEpisodeIds: [EPISODE_ID],
    linkedWorldbuildingIds: [],
    createdAt: ts,
    updatedAt: ts,
  });

  store.set(`${basePath}/characters/char_seoyeon`, {
    id: 'char_seoyeon',
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    name: '이서연',
    role: '주연',
    affiliation: '마탑',
    appearance: '',
    personality: '',
    background: '',
    abilities: '',
    status: 'confirmed',
    canonStatus: 'CANON',
    linkedEpisodeIds: [EPISODE_ID],
    linkedWorldbuildingIds: [],
    createdAt: ts,
    updatedAt: ts,
  });

  const relId = 'rel_char_hyunwoo_char_seoyeon';
  const envelope: ChangeProposalPayloadEnvelope = {
    schemaVersion: 'PHASE_4_2_1_V1',
    fingerprint: `fp_${proposalId}`,
    targetEntityType: 'RELATIONSHIP',
    proposedAction: 'CREATE',
    targetEntityId: relId,
    sourceEpisodeId: EPISODE_ID,
    sourceRevisionId: REVISION_ID,
    sourceSceneId: SCENE_ID,
    verifiedExcerpt: {
      excerpt: EXCERPT_1,
      matchedText: EXCERPT_1,
      startOffset: EXCERPT_1_START,
      endOffset: EXCERPT_1_END,
      matchMethod: 'EXACT',
    },
    precedingContext: '검은 성채의 성벽 위에서 ',
    followingContext: '\n\n"다시 만나면 적이라고 했을 텐데."',
    confidence: 0.95,
    dialogueClaimOnly: false,
    temporalContextType: 'PRESENT_EVENT',
    uncertaintyFlags: [],
    canonConflicts: [],
    provenance: {
      sourceType: 'AI_PROPOSAL',
      createdBy: 'AI_ENGINE',
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      revisionId: REVISION_ID,
    },
    relationshipDraft: {
      id: relId,
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      sourceCharacterId: 'char_hyunwoo',
      sourceCharacterName: '강현우',
      targetCharacterId: 'char_seoyeon',
      targetCharacterName: '이서연',
      relationType: '적대적 대립',
      affinityScore: -60,
      isDirectional: true,
      description: '검을 겨누는 사이',
      canonStatus: 'PROPOSED',
      lastChangedEpisodeId: EPISODE_ID,
      sourceRevisionId: REVISION_ID,
      provenance: {
        sourceType: 'AI_PROPOSAL',
        createdBy: 'AI_ENGINE',
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        revisionId: REVISION_ID,
      },
    },
    existingEntitySnapshot: null,
  };

  store.set(`${basePath}/changeProposals/${proposalId}`, {
    id: proposalId,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: relId,
    proposedAction: 'CREATE',
    title: '관계 제안서',
    rationale: '근거',
    beforeSummary: '없음',
    afterSummary: '생성',
    proposedPayloadJson: JSON.stringify(envelope),
    triggerEpisodeId: EPISODE_ID,
    triggerSceneId: SCENE_ID,
    sourceRevisionId: REVISION_ID,
    canonStatus,
    reviewedAt: canonStatus === 'PROPOSED' ? '' : '2026-04-01T10:00:00.000Z',
    createdBy: 'AI_ENGINE',
    createdAt: ts,
    updatedAt: ts,
  });
}

test('Stage 1.5 Audit: computeDeterministicApprovalAuditId preserves canonical IDs and prevents collisions for non-canonical or overlong IDs', () => {
  // 1. Standard canonical IDs remain 100% unchanged
  const canonicalId = computeDeterministicApprovalAuditId(
    'prop_rel_001',
    'APPROVED'
  );
  assert.equal(canonicalId, 'audit_prop_rel_001_APPROVED');
  assert.equal(
    computeLegacyApprovalAuditId('prop_rel_001', 'APPROVED'),
    'audit_prop_rel_001_APPROVED'
  );

  // 2. Non-canonical characters (e.g., ':' vs '/' vs '.') that previously collided via '_' replacement now produce distinct hash-suffixed IDs
  const idWithColon = computeDeterministicApprovalAuditId(
    'prop:rel:001',
    'APPROVED'
  );
  const idWithSlash = computeDeterministicApprovalAuditId(
    'prop/rel/001',
    'APPROVED'
  );
  const idWithUnderscore = computeDeterministicApprovalAuditId(
    'prop_rel_001',
    'APPROVED'
  );

  assert.notEqual(idWithColon, idWithSlash);
  assert.notEqual(idWithColon, idWithUnderscore);
  assert.notEqual(idWithSlash, idWithUnderscore);
  assert.match(idWithColon, /^[A-Za-z0-9_-]{1,120}$/);
  assert.match(idWithSlash, /^[A-Za-z0-9_-]{1,120}$/);

  // 3. Overlong IDs (> 64 chars) with identical 64-char prefix but different suffixes do not collide
  const prefix70 = 'p'.repeat(70);
  const longIdA = `${prefix70}_suffix_A`;
  const longIdB = `${prefix70}_suffix_B`;
  const auditLongA = computeDeterministicApprovalAuditId(longIdA, 'APPROVED');
  const auditLongB = computeDeterministicApprovalAuditId(longIdB, 'APPROVED');

  assert.notEqual(auditLongA, auditLongB);
  assert.ok(auditLongA.length <= 120);
  assert.ok(auditLongB.length <= 120);
});

test('Stage 1.5 Audit: Normal approval creates 1 audit doc, re-approval creates 0 extra audit docs and preserves original audit', async () => {
  const { db, store } = createAuditTestMockFirestore({
    runId: 'run_audit_normal_and_idempotent',
  });
  seedAuditTestFixtures(store, 'prop_audit_ok_01');
  const basePath = `users/${OWNER_ID}/projects/${PROJECT_ID}`;

  const first = await approveChangeProposalOnServer(
    {
      projectId: PROJECT_ID,
      proposalId: 'prop_audit_ok_01',
      reviewNote: '최초 승인 메모',
    },
    { db, verifiedOwnerId: OWNER_ID, nowIso: '2026-04-01T11:00:00.000Z' }
  );
  assert.equal(first.status, 'APPROVED_APPLIED');

  const auditPath = `${basePath}/changeProposalApprovalAudits/audit_prop_audit_ok_01_APPROVED`;
  assert.equal(store.has(auditPath), true);
  assert.equal(store.get(auditPath)?.reviewNote, '최초 승인 메모');

  const second = await approveChangeProposalOnServer(
    {
      projectId: PROJECT_ID,
      proposalId: 'prop_audit_ok_01',
      reviewNote: '두 번째 호출 메모 (덮어쓰기 불가)',
    },
    { db, verifiedOwnerId: OWNER_ID, nowIso: '2026-04-01T12:00:00.000Z' }
  );
  assert.equal(second.status, 'ALREADY_APPROVED');
  // Original reviewNote and reviewedAt are preserved
  assert.equal(store.get(auditPath)?.reviewNote, '최초 승인 메모');
  assert.equal(second.auditRecord.reviewNote, '최초 승인 메모');
});

test('Stage 1.5 Audit: When Proposal === PROPOSED but an Audit doc already exists, approval/rejection is blocked with [AUDIT_STATE_INCONSISTENCY] and existing audit is NEVER overwritten', async () => {
  const { db, store } = createAuditTestMockFirestore({
    runId: 'run_audit_proposed_with_existing_audit_blocked',
  });
  seedAuditTestFixtures(store, 'prop_inconsistent_01', 'PROPOSED');
  const basePath = `users/${OWNER_ID}/projects/${PROJECT_ID}`;
  const ts = Timestamp.fromDate(new Date('2026-04-01T09:30:00.000Z'));

  const auditPath = `${basePath}/changeProposalApprovalAudits/audit_prop_inconsistent_01_APPROVED`;
  store.set(auditPath, {
    id: 'audit_prop_inconsistent_01_APPROVED',
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    proposalId: 'prop_inconsistent_01',
    decision: 'APPROVED',
    reviewerUid: OWNER_ID,
    reviewedBy: 'AUTHOR',
    reviewNote: '보존되어야 하는 기존 감사 기록',
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: 'rel_char_hyunwoo_char_seoyeon',
    proposedAction: 'CREATE',
    sourceEpisodeId: EPISODE_ID,
    sourceSceneId: SCENE_ID,
    sourceRevisionId: REVISION_ID,
    proposalFingerprint: 'fp_prop_inconsistent_01',
    beforeEntityJson: '',
    afterEntityJson: '{"id":"rel_char_hyunwoo_char_seoyeon"}',
    payoffNote: '',
    reviewedAt: '2026-04-01T09:30:00.000Z',
    createdAt: ts,
  });

  await assert.rejects(
    async () =>
      approveChangeProposalOnServer(
        {
          projectId: PROJECT_ID,
          proposalId: 'prop_inconsistent_01',
          reviewNote: '덮어쓰기 시도',
        },
        { db, verifiedOwnerId: OWNER_ID }
      ),
    /AUDIT_STATE_INCONSISTENCY/
  );

  // Existing audit record must NOT be overwritten
  assert.equal(
    store.get(auditPath)?.reviewNote,
    '보존되어야 하는 기존 감사 기록'
  );
  // Target entity must NOT be written
  assert.equal(
    store.has(`${basePath}/relationships/rel_char_hyunwoo_char_seoyeon`),
    false
  );

  // Also test rejectChangeProposalOnServer when PROPOSED has an existing audit
  await assert.rejects(
    async () =>
      rejectChangeProposalOnServer(
        {
          projectId: PROJECT_ID,
          proposalId: 'prop_inconsistent_01',
          reviewNote: '반려 시도',
        },
        { db, verifiedOwnerId: OWNER_ID }
      ),
    /AUDIT_STATE_INCONSISTENCY/
  );
});

test('Stage 1.5 Audit: When Proposal === CANON (or REJECTED) but Audit doc is missing in Firestore, throws [AUDIT_STATE_INCONSISTENCY] and NEVER returns a fake fallback audit', async () => {
  const { db, store } = createAuditTestMockFirestore({
    runId: 'run_audit_missing_on_decided_proposal',
  });
  const basePath = `users/${OWNER_ID}/projects/${PROJECT_ID}`;
  const ts = Timestamp.fromDate(new Date('2026-04-01T09:30:00.000Z'));

  // 1. Proposal === CANON + Target Entity exists as CANON, but Audit(APPROVED) is missing
  seedAuditTestFixtures(store, 'prop_canon_no_audit', 'CANON');
  store.set(`${basePath}/relationships/rel_char_hyunwoo_char_seoyeon`, {
    id: 'rel_char_hyunwoo_char_seoyeon',
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    sourceCharacterId: 'char_hyunwoo',
    targetCharacterId: 'char_seoyeon',
    relationType: '적대적 대립',
    affinityScore: -60,
    isDirectional: true,
    description: '검을 겨누는 사이',
    canonStatus: 'CANON',
    effectiveEpisodeId: EPISODE_ID,
    effectiveEventId: '',
    sourceRevisionId: REVISION_ID,
    createdBy: 'AI_ENGINE',
    createdAt: ts,
    updatedAt: ts,
  });

  await assert.rejects(
    async () =>
      approveChangeProposalOnServer(
        {
          projectId: PROJECT_ID,
          proposalId: 'prop_canon_no_audit',
        },
        { db, verifiedOwnerId: OWNER_ID }
      ),
    /AUDIT_STATE_INCONSISTENCY/
  );

  // 2. Proposal === REJECTED, but Audit(REJECTED) is missing in Firestore (must NOT return fake fallbackAudit)
  seedAuditTestFixtures(store, 'prop_rejected_no_audit', 'REJECTED');

  await assert.rejects(
    async () =>
      rejectChangeProposalOnServer(
        {
          projectId: PROJECT_ID,
          proposalId: 'prop_rejected_no_audit',
        },
        { db, verifiedOwnerId: OWNER_ID }
      ),
    /AUDIT_STATE_INCONSISTENCY/
  );
});

test('Stage 1.5 Audit: When Proposal === CANON but stored Audit doc has mismatched proposalId, fingerprint, or decision, throws [AUDIT_STATE_INCONSISTENCY]', async () => {
  const { db, store } = createAuditTestMockFirestore({
    runId: 'run_audit_attribute_mismatch',
  });
  seedAuditTestFixtures(store, 'prop_canon_mismatch', 'CANON');
  const basePath = `users/${OWNER_ID}/projects/${PROJECT_ID}`;
  const ts = Timestamp.fromDate(new Date('2026-04-01T09:30:00.000Z'));

  store.set(`${basePath}/relationships/rel_char_hyunwoo_char_seoyeon`, {
    id: 'rel_char_hyunwoo_char_seoyeon',
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    sourceCharacterId: 'char_hyunwoo',
    targetCharacterId: 'char_seoyeon',
    relationType: '적대적 대립',
    affinityScore: -60,
    isDirectional: true,
    description: '검을 겨누는 사이',
    canonStatus: 'CANON',
    effectiveEpisodeId: EPISODE_ID,
    effectiveEventId: '',
    sourceRevisionId: REVISION_ID,
    createdBy: 'AI_ENGINE',
    createdAt: ts,
    updatedAt: ts,
  });

  const auditPath = `${basePath}/changeProposalApprovalAudits/audit_prop_canon_mismatch_APPROVED`;
  store.set(auditPath, {
    id: 'audit_prop_canon_mismatch_APPROVED',
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    proposalId: 'prop_canon_mismatch',
    decision: 'APPROVED',
    reviewerUid: OWNER_ID,
    reviewedBy: 'AUTHOR',
    reviewNote: '변조된 지문 테스트',
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: 'rel_char_hyunwoo_char_seoyeon',
    proposedAction: 'CREATE',
    sourceEpisodeId: EPISODE_ID,
    sourceSceneId: SCENE_ID,
    sourceRevisionId: REVISION_ID,
    proposalFingerprint: 'fp_TAMPERED_DIFFERENT_FINGERPRINT',
    beforeEntityJson: '',
    afterEntityJson: '{"id":"rel_char_hyunwoo_char_seoyeon"}',
    payoffNote: '',
    reviewedAt: '2026-04-01T09:30:00.000Z',
    createdAt: ts,
  });

  await assert.rejects(
    async () =>
      approveChangeProposalOnServer(
        {
          projectId: PROJECT_ID,
          proposalId: 'prop_canon_mismatch',
        },
        { db, verifiedOwnerId: OWNER_ID }
      ),
    /AUDIT_STATE_INCONSISTENCY/
  );
});

test('Stage 1.5 Audit: When tx.create(auditRef) fails mid-transaction, Entity and Proposal writes are completely rolled back', async () => {
  const { db, store } = createAuditTestMockFirestore({
    runId: 'run_audit_create_failure_rollback',
    failOnAuditCreate: true,
  });
  seedAuditTestFixtures(store, 'prop_audit_fail_rb', 'PROPOSED');
  const basePath = `users/${OWNER_ID}/projects/${PROJECT_ID}`;

  await assert.rejects(
    async () =>
      approveChangeProposalOnServer(
        {
          projectId: PROJECT_ID,
          proposalId: 'prop_audit_fail_rb',
        },
        { db, verifiedOwnerId: OWNER_ID }
      ),
    /SIMULATED_AUDIT_CREATE_FAILURE/
  );

  assert.equal(
    store.has(`${basePath}/relationships/rel_char_hyunwoo_char_seoyeon`),
    false
  );
  assert.equal(
    store.get(`${basePath}/changeProposals/prop_audit_fail_rb`)?.canonStatus,
    'PROPOSED'
  );
  assert.equal(
    store.has(
      `${basePath}/changeProposalApprovalAudits/audit_prop_audit_fail_rb_APPROVED`
    ),
    false
  );
});
