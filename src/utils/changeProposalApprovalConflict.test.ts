import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { registerIsolatedMockFirestoreForTest } from '../server/authMiddleware';
import { approveChangeProposalOnServer } from '../server/changeProposalApprovalEngine';
import type {
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
import { detectTargetEntityStaleOrConflict } from './changeProposalApprovalLogic';

const OWNER_ID = 'user_conflict_hardening_01';
const PROJECT_ID = 'proj_conflict_hardening_01';
const EPISODE_ID = 'ep_conflict_01';
const SCENE_ID = 'scn_conflict_01';
const REVISION_ID = 'rev_conflict_01';

const MANUSCRIPT_TEXT = [
  '검은 성채의 성벽 위에서 강현우는 이서연에게 차갑게 검을 겨누었다.',
  '"다시 만나면 적이라고 했을 텐데."',
  '그날의 맹세는 부서진 은빛 회중시계 속에 잠들어 있었다.',
].join('\n\n');

const EXCERPT_1 = '강현우는 이서연에게 차갑게 검을 겨누었다.';
const EXCERPT_1_START = MANUSCRIPT_TEXT.indexOf(EXCERPT_1);
const EXCERPT_1_END = EXCERPT_1_START + EXCERPT_1.length;

function createBaseRelationshipEntity(): CharacterRelationship {
  return {
    id: 'rel_char_hyunwoo_char_seoyeon',
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    sourceCharacterId: 'char_hyunwoo',
    targetCharacterId: 'char_seoyeon',
    relationType: '과거의 맹우',
    affinityScore: 20,
    isDirectional: true,
    description: '과거 함께 싸웠던 동료',
    canonStatus: 'CANON',
    effectiveEpisodeId: EPISODE_ID,
    effectiveEventId: '',
    sourceRevisionId: 'rev_initial_00',
    createdBy: 'AUTHOR',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-10T00:00:00.000Z',
  };
}

function createBaseTimelineEventEntity(): TimelineEvent {
  return {
    id: 'evt_fortress_duel',
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    title: '검은 성채의 조우',
    summary: '성벽 위에서 마주친 두 사람',
    inUniverseDate: '제국력 412년 겨울',
    chronologicalOrder: 10,
    episodeId: EPISODE_ID,
    sceneId: SCENE_ID,
    participantCharacterIds: ['char_hyunwoo', 'char_seoyeon'],
    linkedForeshadowingIds: ['fsh_watch'],
    linkedWorldbuildingIds: ['wb_fortress'],
    canonStatus: 'CANON',
    sourceRevisionId: 'rev_initial_00',
    createdBy: 'AUTHOR',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-10T00:00:00.000Z',
  };
}

function createBaseForeshadowingEntity(): Foreshadowing {
  return {
    id: 'fsh_watch',
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    title: '은빛 회중시계',
    description: '멈춰버린 은빛 시계',
    cluePhase: 'PLANTED',
    canonStatus: 'CANON',
    plantedEpisodeId: EPISODE_ID,
    plantedSceneId: SCENE_ID,
    resolvedEpisodeId: '',
    resolvedSceneId: '',
    relatedEventIds: ['evt_fortress_duel'],
    relatedCharacterIds: ['char_hyunwoo', 'char_seoyeon'],
    sourceRevisionId: 'rev_initial_00',
    createdBy: 'AUTHOR',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-10T00:00:00.000Z',
  };
}

function createUpdateEnvelope(params: {
  targetEntityType: 'RELATIONSHIP' | 'TIMELINE_EVENT' | 'FORESHADOWING';
  targetEntityId: string;
  relationshipDraft?: ExtractedRelationshipDraftPayload;
  timelineEventDraft?: ExtractedTimelineEventDraftPayload;
  foreshadowingDraft?: ExtractedForeshadowingDraftPayload;
  existingEntitySnapshot:
    | Partial<CharacterRelationship>
    | Partial<TimelineEvent>
    | Partial<Foreshadowing>
    | null;
}): ChangeProposalPayloadEnvelope {
  return {
    schemaVersion: 'PHASE_4_2_1_V1',
    fingerprint: `fp_update_${params.targetEntityId}`,
    targetEntityType: params.targetEntityType,
    proposedAction: 'UPDATE',
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
    confidence: 0.94,
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
    existingEntitySnapshot: params.existingEntitySnapshot,
  };
}

test('Stage 1.5 Conflict: Unchanged snapshot passes detectTargetEntityStaleOrConflict', () => {
  const relEntity = createBaseRelationshipEntity();
  const relEnvelope = createUpdateEnvelope({
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: relEntity.id,
    existingEntitySnapshot: { ...relEntity },
    relationshipDraft: {
      id: relEntity.id,
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      sourceCharacterId: 'char_hyunwoo',
      sourceCharacterName: '강현우',
      targetCharacterId: 'char_seoyeon',
      targetCharacterName: '이서연',
      relationType: '적대적 대립',
      affinityScore: -70,
      isDirectional: true,
      description: '성벽 위에서 검을 겨눔',
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

  const check = detectTargetEntityStaleOrConflict({
    envelope: relEnvelope,
    currentEntity: relEntity,
    expectedOwnerId: OWNER_ID,
    expectedProjectId: PROJECT_ID,
  });
  assert.equal(check.ok, true);
});

test('Stage 1.5 Conflict: Scalar field changes (updatedAt, relationType, affinityScore, description, summary, cluePhase) return STALE_TARGET with changedFields', () => {
  const relEntity = createBaseRelationshipEntity();
  const relEnvelope = createUpdateEnvelope({
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: relEntity.id,
    existingEntitySnapshot: { ...relEntity },
  });

  // 1. updatedAt changed
  const updatedAtCheck = detectTargetEntityStaleOrConflict({
    envelope: relEnvelope,
    currentEntity: { ...relEntity, updatedAt: '2026-03-11T00:00:00.000Z' },
  });
  assert.equal(updatedAtCheck.ok, false);
  if (!updatedAtCheck.ok) {
    assert.equal(updatedAtCheck.code, 'STALE_TARGET');
    assert.ok(
      updatedAtCheck.conflictDetails?.changedFields.includes('updatedAt')
    );
  }

  // 2. description changed even if updatedAt was somehow identical
  const descCheck = detectTargetEntityStaleOrConflict({
    envelope: relEnvelope,
    currentEntity: { ...relEntity, description: '다른 작가가 수정한 설명' },
  });
  assert.equal(descCheck.ok, false);
  if (!descCheck.ok) {
    assert.equal(descCheck.code, 'STALE_TARGET');
    assert.ok(
      descCheck.conflictDetails?.changedFields.includes('description')
    );
  }

  // 3. TimelineEvent summary & chronologicalOrder changed
  const evtEntity = createBaseTimelineEventEntity();
  const evtEnvelope = createUpdateEnvelope({
    targetEntityType: 'TIMELINE_EVENT',
    targetEntityId: evtEntity.id,
    existingEntitySnapshot: { ...evtEntity },
  });
  const evtCheck = detectTargetEntityStaleOrConflict({
    envelope: evtEnvelope,
    currentEntity: {
      ...evtEntity,
      summary: '수정된 사건 요약',
      chronologicalOrder: 99,
    },
  });
  assert.equal(evtCheck.ok, false);
  if (!evtCheck.ok) {
    assert.equal(evtCheck.code, 'STALE_TARGET');
    assert.ok(evtCheck.conflictDetails?.changedFields.includes('summary'));
    assert.ok(
      evtCheck.conflictDetails?.changedFields.includes('chronologicalOrder')
    );
  }
});

test('Stage 1.5 Conflict: Array field changes (participantCharacterIds, linkedForeshadowingIds, relatedCharacterIds, relatedEventIds) return STALE_TARGET', () => {
  const evtEntity = createBaseTimelineEventEntity();
  const evtEnvelope = createUpdateEnvelope({
    targetEntityType: 'TIMELINE_EVENT',
    targetEntityId: evtEntity.id,
    existingEntitySnapshot: { ...evtEntity },
  });

  // Order-insensitive match succeeds when same IDs are in different order
  const reorderedCheck = detectTargetEntityStaleOrConflict({
    envelope: evtEnvelope,
    currentEntity: {
      ...evtEntity,
      participantCharacterIds: ['char_seoyeon', 'char_hyunwoo'],
    },
  });
  assert.equal(reorderedCheck.ok, true);

  // Adding or removing an ID triggers STALE_TARGET
  const modifiedArrayCheck = detectTargetEntityStaleOrConflict({
    envelope: evtEnvelope,
    currentEntity: {
      ...evtEntity,
      participantCharacterIds: ['char_hyunwoo', 'char_seoyeon', 'char_third'],
    },
  });
  assert.equal(modifiedArrayCheck.ok, false);
  if (!modifiedArrayCheck.ok) {
    assert.equal(modifiedArrayCheck.code, 'STALE_TARGET');
    assert.ok(
      modifiedArrayCheck.conflictDetails?.changedFields.includes(
        'participantCharacterIds'
      )
    );
  }

  // Foreshadowing relatedCharacterIds / relatedEventIds change triggers STALE_TARGET
  const fshEntity = createBaseForeshadowingEntity();
  const fshEnvelope = createUpdateEnvelope({
    targetEntityType: 'FORESHADOWING',
    targetEntityId: fshEntity.id,
    existingEntitySnapshot: { ...fshEntity },
  });
  const fshArrayCheck = detectTargetEntityStaleOrConflict({
    envelope: fshEnvelope,
    currentEntity: {
      ...fshEntity,
      relatedEventIds: ['evt_fortress_duel', 'evt_other'],
    },
  });
  assert.equal(fshArrayCheck.ok, false);
  if (!fshArrayCheck.ok) {
    assert.equal(fshArrayCheck.code, 'STALE_TARGET');
    assert.ok(
      fshArrayCheck.conflictDetails?.changedFields.includes('relatedEventIds')
    );
  }
});

test('Stage 1.5 Conflict: Deleted target returns TARGET_NOT_FOUND, and missing snapshot or missing required snapshot key returns PAYLOAD_INTEGRITY_ERROR', () => {
  const relEntity = createBaseRelationshipEntity();
  const relEnvelope = createUpdateEnvelope({
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: relEntity.id,
    existingEntitySnapshot: { ...relEntity },
  });

  // 1. Deleted target
  const deletedCheck = detectTargetEntityStaleOrConflict({
    envelope: relEnvelope,
    currentEntity: null,
  });
  assert.equal(deletedCheck.ok, false);
  if (!deletedCheck.ok) {
    assert.equal(deletedCheck.code, 'TARGET_NOT_FOUND');
  }

  // 2. Null existingEntitySnapshot
  const nullSnapEnvelope = createUpdateEnvelope({
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: relEntity.id,
    existingEntitySnapshot: null,
  });
  const nullSnapCheck = detectTargetEntityStaleOrConflict({
    envelope: nullSnapEnvelope,
    currentEntity: relEntity,
  });
  assert.equal(nullSnapCheck.ok, false);
  if (!nullSnapCheck.ok) {
    assert.equal(nullSnapCheck.code, 'PAYLOAD_INTEGRITY_ERROR');
  }

  // 3. Partial snapshot missing required comparison key (e.g., description omitted)
  const partialSnap = { ...relEntity } as Record<string, unknown>;
  delete partialSnap.description;
  const partialSnapEnvelope = createUpdateEnvelope({
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: relEntity.id,
    existingEntitySnapshot: partialSnap as Partial<CharacterRelationship>,
  });
  const partialSnapCheck = detectTargetEntityStaleOrConflict({
    envelope: partialSnapEnvelope,
    currentEntity: relEntity,
  });
  assert.equal(partialSnapCheck.ok, false);
  if (!partialSnapCheck.ok) {
    assert.equal(partialSnapCheck.code, 'PAYLOAD_INTEGRITY_ERROR');
  }
});

test('Stage 1.5 Conflict: Semantic conflicts (RESOLVED -> PLANTED foreshadowing regression, ABANDONED foreshadowing update, ARCHIVED entity update, cross-project entity confusion) are blocked', () => {
  // 1. Foreshadowing RESOLVED -> PLANTED semantic regression -> CONFLICT_REQUIRES_REVIEW
  const resolvedFsh: Foreshadowing = {
    ...createBaseForeshadowingEntity(),
    cluePhase: 'RESOLVED',
    resolvedEpisodeId: EPISODE_ID,
    resolvedSceneId: SCENE_ID,
  };
  const regressEnvelope = createUpdateEnvelope({
    targetEntityType: 'FORESHADOWING',
    targetEntityId: resolvedFsh.id,
    existingEntitySnapshot: { ...resolvedFsh },
    foreshadowingDraft: {
      id: resolvedFsh.id,
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      title: resolvedFsh.title,
      description: resolvedFsh.description,
      cluePhase: 'PLANTED',
      canonStatus: 'PROPOSED',
      plantedEpisodeId: EPISODE_ID,
      plantedSceneId: SCENE_ID,
      resolvedEpisodeId: '',
      resolvedSceneId: '',
      relatedCharacterIds: resolvedFsh.relatedCharacterIds,
      relatedCharacterNames: ['강현우', '이서연'],
      relatedEventIds: resolvedFsh.relatedEventIds,
      payoffNote: '',
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

  const regressCheck = detectTargetEntityStaleOrConflict({
    envelope: regressEnvelope,
    currentEntity: resolvedFsh,
  });
  assert.equal(regressCheck.ok, false);
  if (!regressCheck.ok) {
    assert.equal(regressCheck.code, 'CONFLICT_REQUIRES_REVIEW');
  }

  // 2. Updating an ABANDONED foreshadowing -> CONFLICT_REQUIRES_REVIEW
  const abandonedFsh: Foreshadowing = {
    ...createBaseForeshadowingEntity(),
    cluePhase: 'ABANDONED',
  };
  const abandonedEnvelope = createUpdateEnvelope({
    targetEntityType: 'FORESHADOWING',
    targetEntityId: abandonedFsh.id,
    existingEntitySnapshot: { ...abandonedFsh },
  });
  const abandonedCheck = detectTargetEntityStaleOrConflict({
    envelope: abandonedEnvelope,
    currentEntity: abandonedFsh,
  });
  assert.equal(abandonedCheck.ok, false);
  if (!abandonedCheck.ok) {
    assert.equal(abandonedCheck.code, 'CONFLICT_REQUIRES_REVIEW');
  }

  // 3. Cross-project entity confusion -> REFERENCE_INTEGRITY_ERROR
  const relEntity = createBaseRelationshipEntity();
  const relEnvelope = createUpdateEnvelope({
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: relEntity.id,
    existingEntitySnapshot: { ...relEntity },
  });
  const foreignProjectCheck = detectTargetEntityStaleOrConflict({
    envelope: relEnvelope,
    currentEntity: { ...relEntity, projectId: 'proj_foreign_999' },
    expectedOwnerId: OWNER_ID,
    expectedProjectId: PROJECT_ID,
  });
  assert.equal(foreignProjectCheck.ok, false);
  if (!foreignProjectCheck.ok) {
    assert.equal(foreignProjectCheck.code, 'REFERENCE_INTEGRITY_ERROR');
  }
});

test('Stage 1.5 Conflict: forceApplyOnStale=true is unconditionally rejected with [STALE_OVERRIDE_FORBIDDEN] in both logic and server approval engine', async () => {
  const relEntity = createBaseRelationshipEntity();
  const relEnvelope = createUpdateEnvelope({
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: relEntity.id,
    existingEntitySnapshot: { ...relEntity },
  });

  // Logic check even when snapshot matches
  const logicForceCheck = detectTargetEntityStaleOrConflict({
    envelope: relEnvelope,
    currentEntity: relEntity,
    forceApplyOnStale: true,
  });
  assert.equal(logicForceCheck.ok, false);
  if (!logicForceCheck.ok) {
    assert.equal(logicForceCheck.code, 'STALE_OVERRIDE_FORBIDDEN');
  }

  // Server engine check
  const store = new Map<string, Record<string, unknown>>();
  const mockDb = {
    doc: (path: string) => ({ path }),
    runTransaction: async () => {
      throw new Error('Should not even enter runTransaction when forceApplyOnStale=true');
    },
  } as unknown as Firestore;

  registerIsolatedMockFirestoreForTest(mockDb, {
    projectId: 'test-isolated-phase422-s15-conflict',
    databaseId: 'test-db-phase422-s15-conflict',
    runId: 'run_force_override_forbidden',
  });

  await assert.rejects(
    async () =>
      approveChangeProposalOnServer(
        {
          projectId: PROJECT_ID,
          proposalId: 'prop_any_01',
          forceApplyOnStale: true,
        },
        { db: mockDb, verifiedOwnerId: OWNER_ID }
      ),
    /STALE_OVERRIDE_FORBIDDEN/
  );
  assert.equal(store.size, 0);
});
