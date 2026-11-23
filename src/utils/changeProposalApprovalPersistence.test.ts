import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { registerIsolatedMockFirestoreForTest } from '../server/authMiddleware';
import {
  approveChangeProposalOnServer,
  rejectChangeProposalOnServer,
} from '../server/changeProposalApprovalEngine';
import {
  executeServerManuscriptExtraction,
  saveVerifiedExtractionProposalsOnServer,
} from '../server/manuscriptExtractionEngine';
import type {
  ChangeProposal,
  CharacterRelationship,
  Foreshadowing,
  TimelineEvent,
} from '../types/foundation';
import type {
  ChangeProposalPayloadEnvelope,
  ExtractedForeshadowingDraftPayload,
  ExtractedRelationshipDraftPayload,
  ExtractedTimelineEventDraftPayload,
} from '../types/manuscriptExtraction';
import {
  ALLOWED_APPROVAL_AUDIT_FIRESTORE_KEYS,
  ALLOWED_FORESHADOWING_FIRESTORE_KEYS,
  ALLOWED_RELATIONSHIP_FIRESTORE_KEYS,
  ALLOWED_TIMELINE_EVENT_FIRESTORE_KEYS,
} from './changeProposalApprovalLogic';

const OWNER_ID = 'user_atomic_approval_01';
const PROJECT_ID = 'proj_atomic_approval_01';
const EPISODE_ID = 'ep_atomic_01';
const SCENE_ID = 'scn_atomic_01';
const REVISION_ID = 'rev_atomic_01';

const MANUSCRIPT_TEXT = [
  '검은 성채의 성벽 위에서 강현우는 이서연에게 차갑게 검을 겨누었다.',
  '"다시 만나면 적이라고 했을 텐데."',
  '그날의 맹세는 부서진 은빛 회중시계 속에 잠들어 있었다.',
].join('\n\n');

const EXCERPT_1 = '강현우는 이서연에게 차갑게 검을 겨누었다.';
const EXCERPT_1_START = MANUSCRIPT_TEXT.indexOf(EXCERPT_1);
const EXCERPT_1_END = EXCERPT_1_START + EXCERPT_1.length;

const EXCERPT_2 = '그날의 맹세는 부서진 은빛 회중시계 속에 잠들어 있었다.';
const EXCERPT_2_START = MANUSCRIPT_TEXT.indexOf(EXCERPT_2);
const EXCERPT_2_END = EXCERPT_2_START + EXCERPT_2.length;

/**
 * Transactional in-memory Firestore mock:
 * Stages all `tx.set` / `tx.update` / `tx.delete` operations in a local transaction buffer
 * and only commits them to the backing `store` if the `runTransaction` callback resolves without error.
 * Also enforces Firestore's "all reads before writes" rule inside transactions!
 */
function createTransactionalIsolatedMockFirestore(runId: string): {
  db: Firestore;
  store: Map<string, Record<string, unknown>>;
} {
  const store = new Map<string, Record<string, unknown>>();

  const makeDocSnapshot = (docPath: string, sourceMap = store) => {
    const raw = sourceMap.get(docPath);
    const segments = docPath.split('/');
    const id = segments[segments.length - 1] || '';
    return {
      id,
      exists: raw !== undefined,
      data: () => (raw ? { ...raw } : undefined),
    };
  };

  const makeCollectionSnapshot = (colPath: string, sourceMap = store) => {
    const prefix = `${colPath}/`;
    const docs: Array<{
      id: string;
      exists: boolean;
      data: () => Record<string, unknown>;
    }> = [];
    for (const [key, val] of sourceMap.entries()) {
      if (key.startsWith(prefix)) {
        const remainder = key.slice(prefix.length);
        if (!remainder.includes('/')) {
          docs.push({
            id: remainder,
            exists: true,
            data: () => ({ ...val }),
          });
        }
      }
    }
    return {
      empty: docs.length === 0,
      size: docs.length,
      docs,
    };
  };

  const makeDocRef = (docPath: string) => {
    const segments = docPath.split('/');
    const id = segments[segments.length - 1] || '';
    return {
      id,
      path: docPath,
      __kind: 'docRef' as const,
      get: async () => makeDocSnapshot(docPath, store),
      set: async (data: Record<string, unknown>) => {
        store.set(docPath, { ...data });
      },
    };
  };

  const makeColRef = (colPath: string) => ({
    path: colPath,
    __kind: 'colRef' as const,
    doc: (docId: string) => makeDocRef(`${colPath}/${docId}`),
    get: async () => makeCollectionSnapshot(colPath, store),
  });

  const mockDb = {
    doc: (docPath: string) => makeDocRef(docPath),
    collection: (colPath: string) => makeColRef(colPath),
    runTransaction: async <T>(
      updateFunction: (tx: unknown) => Promise<T>
    ): Promise<T> => {
      const stagedWrites = new Map<string, Record<string, unknown>>();
      let hasStartedWriting = false;

      const tx = {
        get: async (target: { __kind?: string; path: string }) => {
          if (hasStartedWriting) {
            throw new Error(
              '[FIRESTORE_TX_READ_AFTER_WRITE] Firestore transactions require all reads to be executed before any writes.'
            );
          }
          if (target.__kind === 'colRef') {
            return makeCollectionSnapshot(target.path, store);
          }
          return makeDocSnapshot(target.path, store);
        },
        set: (target: { path: string }, data: Record<string, unknown>) => {
          hasStartedWriting = true;
          stagedWrites.set(target.path, { ...data });
        },
        create: (target: { path: string }, data: Record<string, unknown>) => {
          hasStartedWriting = true;
          if (store.has(target.path) || stagedWrites.has(target.path)) {
            throw new Error(
              `[FIRESTORE_TX_ALREADY_EXISTS] Document already exists at ${target.path}`
            );
          }
          stagedWrites.set(target.path, { ...data });
        },
      };

      const result = await updateFunction(tx);
      // Commit staged writes only if updateFunction succeeded without throwing
      for (const [k, v] of stagedWrites.entries()) {
        store.set(k, v);
      }
      return result;
    },
  } as unknown as Firestore;

  registerIsolatedMockFirestoreForTest(mockDb, {
    projectId: 'test-isolated-phase422',
    databaseId: 'test-db-phase422-isolated',
    runId,
  });

  return { db: mockDb, store };
}

function seedProjectBaseFixtures(store: Map<string, Record<string, unknown>>) {
  const basePath = `users/${OWNER_ID}/projects/${PROJECT_ID}`;
  const ts = Timestamp.fromDate(new Date('2026-04-01T09:00:00.000Z'));

  store.set(basePath, {
    id: PROJECT_ID,
    ownerId: OWNER_ID,
    title: '검은 성채의 연대기',
    genre: '다크 판타지',
    synopsis: '성채를 둘러싼 복수극',
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
    title: '제1화. 검은 성채의 재회',
    content: MANUSCRIPT_TEXT,
    synopsis: '성벽 위의 재회',
    authorNote: '',
    charCountWithSpaces: MANUSCRIPT_TEXT.length,
    charCountWithoutSpaces: MANUSCRIPT_TEXT.replace(/\s+/g, '').length,
    status: 'confirmed',
    canonStatus: 'CANON',
    linkedCharacterIds: ['char_hyunwoo', 'char_seoyeon'],
    linkedWorldbuildingIds: ['wb_black_fortress'],
    latestRevisionId: REVISION_ID,
    createdAt: ts,
    updatedAt: ts,
  });

  store.set(`${basePath}/scenes/${SCENE_ID}`, {
    id: SCENE_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    sceneNumber: 1,
    title: '성벽 위의 대치',
    summary: '검을 겨누는 두 사람',
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
    episodeTitle: '제1화. 검은 성채의 재회',
    content: MANUSCRIPT_TEXT,
    charCountWithSpaces: MANUSCRIPT_TEXT.length,
    label: '1차 퇴고본',
    createdAt: ts,
  });

  store.set(`${basePath}/characters/char_hyunwoo`, {
    id: 'char_hyunwoo',
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    name: '강현우',
    role: '주인공',
    affiliation: '잿빛 기사단',
    appearance: '검은 망토',
    personality: '냉철함',
    background: '몰락 가문 출신',
    abilities: '검술',
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
    affiliation: '제국 마탑',
    appearance: '은발',
    personality: '침착함',
    background: '마탑 후계자',
    abilities: '빙결 마법',
    status: 'confirmed',
    canonStatus: 'CANON',
    linkedEpisodeIds: [EPISODE_ID],
    linkedWorldbuildingIds: [],
    createdAt: ts,
    updatedAt: ts,
  });

  store.set(`${basePath}/worldbuilding/wb_black_fortress`, {
    id: 'wb_black_fortress',
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    title: '검은 성채',
    category: '지리/장소',
    summary: '북부 국경의 요새',
    content: '고대 봉인이 잠든 성채',
    rules: '외부 마력 차단',
    status: 'confirmed',
    canonStatus: 'CANON',
    linkedCharacterIds: [],
    linkedEpisodeIds: [EPISODE_ID],
    createdAt: ts,
    updatedAt: ts,
  });
}

function seedProposalInStore(params: {
  store: Map<string, Record<string, unknown>>;
  proposalId: string;
  targetEntityType: 'RELATIONSHIP' | 'TIMELINE_EVENT' | 'FORESHADOWING';
  proposedAction: 'CREATE' | 'UPDATE';
  targetEntityId: string;
  relationshipDraft?: ExtractedRelationshipDraftPayload;
  timelineEventDraft?: ExtractedTimelineEventDraftPayload;
  foreshadowingDraft?: ExtractedForeshadowingDraftPayload;
  existingEntitySnapshot?:
    | Partial<CharacterRelationship>
    | Partial<TimelineEvent>
    | Partial<Foreshadowing>
    | null;
  canonStatus?: 'PROPOSED' | 'CANON' | 'REJECTED' | 'ARCHIVED';
}) {
  const basePath = `users/${OWNER_ID}/projects/${PROJECT_ID}`;
  const ts = Timestamp.fromDate(new Date('2026-04-01T10:00:00.000Z'));

  const envelope: ChangeProposalPayloadEnvelope = {
    schemaVersion: 'PHASE_4_2_1_V1',
    fingerprint: `fp_${params.proposalId}`,
    targetEntityType: params.targetEntityType,
    proposedAction: params.proposedAction,
    targetEntityId: params.targetEntityId,
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
    relationshipDraft: params.relationshipDraft,
    timelineEventDraft: params.timelineEventDraft,
    foreshadowingDraft: params.foreshadowingDraft,
    existingEntitySnapshot: params.existingEntitySnapshot ?? null,
  };

  params.store.set(`${basePath}/changeProposals/${params.proposalId}`, {
    id: params.proposalId,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    targetEntityType: params.targetEntityType,
    targetEntityId: params.targetEntityId,
    proposedAction: params.proposedAction,
    title: `${params.targetEntityType} 제안서`,
    rationale: '원고 발췌 근거',
    beforeSummary: '이전 요약',
    afterSummary: '이후 요약',
    proposedPayloadJson: JSON.stringify(envelope),
    triggerEpisodeId: EPISODE_ID,
    sourceRevisionId: REVISION_ID,
    canonStatus: params.canonStatus ?? 'PROPOSED',
    reviewedAt: '',
    createdBy: 'AI_ENGINE',
    createdAt: ts,
    updatedAt: ts,
  });
}

test('Phase 4.2.2 Persistence: Atomic approval of RELATIONSHIP, TIMELINE_EVENT, and FORESHADOWING CREATE & UPDATE proposals writes native Timestamp and exact schema keys', async () => {
  const { db, store } = createTransactionalIsolatedMockFirestore(
    'run_atomic_create_update'
  );
  seedProjectBaseFixtures(store);
  const basePath = `users/${OWNER_ID}/projects/${PROJECT_ID}`;

  // 1. Approve TIMELINE_EVENT CREATE
  const evtId = 'evt_ep_001_fortress_duel';
  seedProposalInStore({
    store,
    proposalId: 'prop_evt_01',
    targetEntityType: 'TIMELINE_EVENT',
    proposedAction: 'CREATE',
    targetEntityId: evtId,
    timelineEventDraft: {
      id: evtId,
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      title: '검은 성채 성벽 위의 대치',
      summary: '강현우와 이서연이 성벽 위에서 검을 겨누다.',
      episodeId: EPISODE_ID,
      sceneId: SCENE_ID,
      inUniverseDate: '제국력 412년 겨울',
      chronologicalOrder: 1,
      involvedCharacterIds: ['char_hyunwoo', 'char_seoyeon'],
      involvedCharacterNames: ['강현우', '이서연'],
      locationWorldItemId: 'wb_black_fortress',
      locationName: '검은 성채',
      canonStatus: 'PROPOSED',
      sourceRevisionId: REVISION_ID,
      provenance: {
        sourceType: 'AI_PROPOSAL',
        createdBy: 'AI_ENGINE',
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        revisionId: REVISION_ID,
      },
    },
  });

  const evtApproval = await approveChangeProposalOnServer(
    {
      projectId: PROJECT_ID,
      proposalId: 'prop_evt_01',
      reviewNote: '연표 사건 승인',
    },
    { db, verifiedOwnerId: OWNER_ID }
  );

  assert.equal(evtApproval.status, 'APPROVED_APPLIED');
  assert.equal(evtApproval.proposal.canonStatus, 'CANON');
  assert.equal(evtApproval.appliedEntity?.canonStatus, 'CANON');

  const rawEvtDoc = store.get(`${basePath}/timelineEvents/${evtId}`)!;
  assert.ok(rawEvtDoc);
  assert.equal(rawEvtDoc.canonStatus, 'CANON');
  assert.ok(rawEvtDoc.createdAt instanceof Timestamp);
  assert.ok(rawEvtDoc.updatedAt instanceof Timestamp);
  assert.deepEqual(
    Object.keys(rawEvtDoc).sort(),
    [...ALLOWED_TIMELINE_EVENT_FIRESTORE_KEYS].sort()
  );

  // 2. Approve RELATIONSHIP CREATE
  const relId = 'rel_char_hyunwoo_char_seoyeon';
  seedProposalInStore({
    store,
    proposalId: 'prop_rel_01',
    targetEntityType: 'RELATIONSHIP',
    proposedAction: 'CREATE',
    targetEntityId: relId,
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
  });

  const relApproval = await approveChangeProposalOnServer(
    {
      projectId: PROJECT_ID,
      proposalId: 'prop_rel_01',
      reviewNote: '관계 신규 생성 승인',
    },
    { db, verifiedOwnerId: OWNER_ID }
  );

  assert.equal(relApproval.status, 'APPROVED_APPLIED');
  const rawRelDoc = store.get(`${basePath}/relationships/${relId}`)!;
  assert.ok(rawRelDoc);
  assert.equal(rawRelDoc.canonStatus, 'CANON');
  assert.equal(rawRelDoc.effectiveEpisodeId, EPISODE_ID);
  assert.ok(rawRelDoc.createdAt instanceof Timestamp);
  assert.deepEqual(
    Object.keys(rawRelDoc).sort(),
    [...ALLOWED_RELATIONSHIP_FIRESTORE_KEYS].sort()
  );

  // 3. Approve RELATIONSHIP UPDATE on the newly created CANON relationship
  const createdRelSnapshot = relApproval.appliedEntity as CharacterRelationship;
  seedProposalInStore({
    store,
    proposalId: 'prop_rel_02_update',
    targetEntityType: 'RELATIONSHIP',
    proposedAction: 'UPDATE',
    targetEntityId: relId,
    relationshipDraft: {
      id: relId,
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      sourceCharacterId: 'char_hyunwoo',
      sourceCharacterName: '강현우',
      targetCharacterId: 'char_seoyeon',
      targetCharacterName: '이서연',
      relationType: '숙적 및 애증',
      affinityScore: -80,
      isDirectional: true,
      description: '성벽 대치 이후 적대감이 심화됨.',
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
    existingEntitySnapshot: createdRelSnapshot,
  });

  const relUpdateApproval = await approveChangeProposalOnServer(
    {
      projectId: PROJECT_ID,
      proposalId: 'prop_rel_02_update',
      reviewNote: '관계 변화 업데이트 승인',
    },
    { db, verifiedOwnerId: OWNER_ID }
  );

  assert.equal(relUpdateApproval.status, 'APPROVED_APPLIED');
  assert.equal(
    (relUpdateApproval.appliedEntity as CharacterRelationship).affinityScore,
    -80
  );
  assert.equal(
    (relUpdateApproval.appliedEntity as CharacterRelationship).relationType,
    '숙적 및 애증'
  );

  // 4. Approve FORESHADOWING CREATE (and verify payoffNote is in Audit, not in Foreshadowing doc)
  const fshId = 'fsh_silver_pocket_watch';
  seedProposalInStore({
    store,
    proposalId: 'prop_fsh_01',
    targetEntityType: 'FORESHADOWING',
    proposedAction: 'CREATE',
    targetEntityId: fshId,
    foreshadowingDraft: {
      id: fshId,
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      title: '부서진 은빛 회중시계',
      description: '과거의 맹세가 담긴 시계',
      cluePhase: 'PLANTED',
      canonStatus: 'PROPOSED',
      plantedEpisodeId: EPISODE_ID,
      plantedSceneId: SCENE_ID,
      resolvedEpisodeId: '',
      resolvedSceneId: '',
      relatedCharacterIds: ['char_hyunwoo', 'char_seoyeon'],
      relatedCharacterNames: ['강현우', '이서연'],
      relatedEventIds: [evtId],
      payoffNote: '성채 지하 봉인 해제 열쇠',
      sourceRevisionId: REVISION_ID,
      provenance: {
        sourceType: 'AI_PROPOSAL',
        createdBy: 'AI_ENGINE',
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        revisionId: REVISION_ID,
      },
    },
  });

  const fshApproval = await approveChangeProposalOnServer(
    {
      projectId: PROJECT_ID,
      proposalId: 'prop_fsh_01',
      reviewNote: '복선 심기 승인',
    },
    { db, verifiedOwnerId: OWNER_ID }
  );

  assert.equal(fshApproval.status, 'APPROVED_APPLIED');
  const rawFshDoc = store.get(`${basePath}/foreshadowings/${fshId}`)!;
  assert.ok(rawFshDoc);
  assert.equal('payoffNote' in rawFshDoc, false);
  assert.deepEqual(
    Object.keys(rawFshDoc).sort(),
    [...ALLOWED_FORESHADOWING_FIRESTORE_KEYS].sort()
  );

  const rawAuditDoc = store.get(
    `${basePath}/changeProposalApprovalAudits/${fshApproval.auditRecord.id}`
  )!;
  assert.ok(rawAuditDoc);
  assert.equal(rawAuditDoc.payoffNote, '성채 지하 봉인 해제 열쇠');
  assert.ok(rawAuditDoc.createdAt instanceof Timestamp);
  assert.deepEqual(
    Object.keys(rawAuditDoc).sort(),
    [...ALLOWED_APPROVAL_AUDIT_FIRESTORE_KEYS].sort()
  );
});

test('Phase 4.2.2 Persistence: Atomic rollback guarantees 0 partial writes if entity write or audit write fails mid-transaction', async () => {
  const { db, store } = createTransactionalIsolatedMockFirestore(
    'run_atomic_rollback'
  );
  seedProjectBaseFixtures(store);
  const basePath = `users/${OWNER_ID}/projects/${PROJECT_ID}`;

  const relId = 'rel_char_hyunwoo_char_seoyeon';
  seedProposalInStore({
    store,
    proposalId: 'prop_rollback_test',
    targetEntityType: 'RELATIONSHIP',
    proposedAction: 'CREATE',
    targetEntityId: relId,
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
      description: '롤백 테스트 관계',
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
  });

  // 1. Fault injection AFTER entity write
  await assert.rejects(
    async () =>
      approveChangeProposalOnServer(
        {
          projectId: PROJECT_ID,
          proposalId: 'prop_rollback_test',
        },
        {
          db,
          verifiedOwnerId: OWNER_ID,
          faultInjectionStep: 'AFTER_ENTITY_WRITE',
        }
      ),
    /FAULT_INJECTION_ROLLBACK/
  );

  // Verify nothing was committed: entity does not exist, proposal is still PROPOSED, audit does not exist
  assert.equal(store.has(`${basePath}/relationships/${relId}`), false);
  assert.equal(
    store.get(`${basePath}/changeProposals/prop_rollback_test`)?.canonStatus,
    'PROPOSED'
  );
  assert.equal(
    store.has(
      `${basePath}/changeProposalApprovalAudits/audit_prop_rollback_test_APPROVED`
    ),
    false
  );

  // 2. Fault injection BEFORE audit write (after both entity and proposal writes were staged)
  await assert.rejects(
    async () =>
      approveChangeProposalOnServer(
        {
          projectId: PROJECT_ID,
          proposalId: 'prop_rollback_test',
        },
        {
          db,
          verifiedOwnerId: OWNER_ID,
          faultInjectionStep: 'BEFORE_AUDIT_WRITE',
        }
      ),
    /FAULT_INJECTION_ROLLBACK/
  );

  assert.equal(store.has(`${basePath}/relationships/${relId}`), false);
  assert.equal(
    store.get(`${basePath}/changeProposals/prop_rollback_test`)?.canonStatus,
    'PROPOSED'
  );
  assert.equal(
    store.has(
      `${basePath}/changeProposalApprovalAudits/audit_prop_rollback_test_APPROVED`
    ),
    false
  );
});

test('Phase 4.2.2 Persistence: Idempotent ALREADY_APPROVED and ALREADY_REJECTED handling on repeated calls', async () => {
  const { db, store } = createTransactionalIsolatedMockFirestore(
    'run_idempotency'
  );
  seedProjectBaseFixtures(store);

  const relId = 'rel_char_hyunwoo_char_seoyeon';
  seedProposalInStore({
    store,
    proposalId: 'prop_idem_approve',
    targetEntityType: 'RELATIONSHIP',
    proposedAction: 'CREATE',
    targetEntityId: relId,
    relationshipDraft: {
      id: relId,
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      sourceCharacterId: 'char_hyunwoo',
      sourceCharacterName: '강현우',
      targetCharacterId: 'char_seoyeon',
      targetCharacterName: '이서연',
      relationType: '적대적 대립',
      affinityScore: -50,
      isDirectional: true,
      description: '멱등성 테스트',
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
  });

  const firstApproval = await approveChangeProposalOnServer(
    { projectId: PROJECT_ID, proposalId: 'prop_idem_approve' },
    { db, verifiedOwnerId: OWNER_ID }
  );
  assert.equal(firstApproval.status, 'APPROVED_APPLIED');

  const secondApproval = await approveChangeProposalOnServer(
    { projectId: PROJECT_ID, proposalId: 'prop_idem_approve' },
    { db, verifiedOwnerId: OWNER_ID }
  );
  assert.equal(secondApproval.status, 'ALREADY_APPROVED');
  assert.equal(secondApproval.appliedEntity?.id, relId);

  // Reject another proposal twice
  seedProposalInStore({
    store,
    proposalId: 'prop_idem_reject',
    targetEntityType: 'RELATIONSHIP',
    proposedAction: 'CREATE',
    targetEntityId: 'rel_other',
    relationshipDraft: {
      id: 'rel_other',
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      sourceCharacterId: 'char_hyunwoo',
      sourceCharacterName: '강현우',
      targetCharacterId: 'char_seoyeon',
      targetCharacterName: '이서연',
      relationType: '친우',
      affinityScore: 50,
      isDirectional: false,
      description: '반려 멱등성 테스트',
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
  });

  const firstReject = await rejectChangeProposalOnServer(
    {
      projectId: PROJECT_ID,
      proposalId: 'prop_idem_reject',
      reviewNote: '맥락 불일치 반려',
    },
    { db, verifiedOwnerId: OWNER_ID }
  );
  assert.equal(firstReject.status, 'REJECTED');
  assert.equal(firstReject.proposal.canonStatus, 'REJECTED');

  const secondReject = await rejectChangeProposalOnServer(
    { projectId: PROJECT_ID, proposalId: 'prop_idem_reject' },
    { db, verifiedOwnerId: OWNER_ID }
  );
  assert.equal(secondReject.status, 'ALREADY_REJECTED');
});

test('Phase 4.2.2 Section 3.3: Legacy random-ID proposals (PROPOSED, CANON, REJECTED) are transactionally protected from duplicate creation or status reset', async () => {
  const { db, store } = createTransactionalIsolatedMockFirestore(
    'run_legacy_random_id_protection'
  );
  seedProjectBaseFixtures(store);
  const basePath = `users/${OWNER_ID}/projects/${PROJECT_ID}`;

  // Seed a legacy random-ID REJECTED proposal for the same relationship & span
  const relId = 'rel_char_hyunwoo_char_seoyeon';
  seedProposalInStore({
    store,
    proposalId: 'prop_legacy_random_998877',
    targetEntityType: 'RELATIONSHIP',
    proposedAction: 'CREATE',
    targetEntityId: relId,
    canonStatus: 'REJECTED',
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
      description: '레거시 랜덤 ID 반려 제안서',
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
  });

  // Extract a new candidate and also a duplicate of the legacy rejected proposal
  const extractionResult = await executeServerManuscriptExtraction(
    {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      revisionId: REVISION_ID,
      persistProposals: false,
    },
    {
      db,
      verifiedOwnerId: OWNER_ID,
      mockExtractorFn: async () => ({
        rawResponse: {
          analysis_summary: '레거시 중복 검증',
          candidates: [
            {
              targetEntityType: 'FORESHADOWING',
              proposedAction: 'CREATE',
              existingTargetEntityId: null,
              title: '부서진 은빛 회중시계',
              rationale: '신규 복선',
              beforeSummary: '없음',
              afterSummary: '회중시계 단서 추가',
              excerpt: EXCERPT_2,
              precedingContext: null,
              followingContext: null,
              sceneId: SCENE_ID,
              confidence: 0.92,
              dialogueClaimOnly: false,
              temporalContextType: 'PRESENT_EVENT',
              uncertaintyFlags: [],
              relationshipPayload: null,
              timelineEventPayload: null,
              foreshadowingPayload: {
                title: '부서진 은빛 회중시계',
                description: '과거 맹세가 담긴 회중시계',
                cluePhase: 'PLANTED',
                relatedCharacterIds: ['char_hyunwoo', 'char_seoyeon'],
                relatedCharacterNames: ['강현우', '이서연'],
                relatedEventIds: [],
                payoffNote: '봉인 열쇠',
              },
            },
          ],
        },
      }),
    }
  );

  // Now simulate saving when a legacy random-ID proposal with matching span/target is added to the store right before save
  const fshCandidate = extractionResult.candidates[0]!;
  assert.ok(fshCandidate);

  // Insert a legacy random-ID CANON proposal for the same target & span AFTER analysis but BEFORE save
  const legacyFshEnvelope: ChangeProposalPayloadEnvelope = {
    ...(JSON.parse(
      fshCandidate.proposalDraft!.proposedPayloadJson
    ) as ChangeProposalPayloadEnvelope),
  };
  store.set(`${basePath}/changeProposals/prop_legacy_random_fsh_canon`, {
    ...fshCandidate.proposalDraft!,
    id: 'prop_legacy_random_fsh_canon',
    canonStatus: 'CANON',
    proposedPayloadJson: JSON.stringify(legacyFshEnvelope),
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });

  const saveResult = await saveVerifiedExtractionProposalsOnServer(
    {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      revisionId: REVISION_ID,
      analysisRunId: extractionResult.analysisRunId,
      analysisToken: extractionResult.analysisToken,
      selectedCandidateIds: [fshCandidate.candidateId],
    },
    { db, verifiedOwnerId: OWNER_ID }
  );

  assert.equal(saveResult.createdCount, 0);
  assert.equal(saveResult.skippedDuplicateCount, 1);
  assert.equal(
    saveResult.itemResults[0]?.disposition,
    'SKIPPED_EXISTING_CANON'
  );
  assert.equal(
    saveResult.itemResults[0]?.proposalId,
    'prop_legacy_random_fsh_canon'
  );
  // Ensure the legacy CANON proposal was NOT overwritten or reset to PROPOSED
  assert.equal(
    store.get(`${basePath}/changeProposals/prop_legacy_random_fsh_canon`)
      ?.canonStatus,
    'CANON'
  );
});
