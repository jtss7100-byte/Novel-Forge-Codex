import assert from 'node:assert/strict';
import test from 'node:test';
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
import type { Revision } from '../types/novel';
import {
  ALLOWED_APPROVAL_AUDIT_FIRESTORE_KEYS,
  ALLOWED_FORESHADOWING_FIRESTORE_KEYS,
  ALLOWED_RELATIONSHIP_FIRESTORE_KEYS,
  ALLOWED_TIMELINE_EVENT_FIRESTORE_KEYS,
  buildApprovalAuditRecord,
  detectTargetEntityStaleOrConflict,
  mapApprovedForeshadowing,
  mapApprovedRelationship,
  mapApprovedTimelineEvent,
  verifyProposalEnvelopeIntegrity,
  verifyRevisionExcerptAtApproval,
} from './changeProposalApprovalLogic';

const OWNER_ID = 'user_author_01';
const PROJECT_ID = 'proj_novel_01';
const EPISODE_ID = 'ep_001';
const SCENE_ID = 'scn_001';
const REVISION_ID = 'rev_001';
const NOW_ISO = '2026-04-01T12:00:00.000Z';

const SAMPLE_MANUSCRIPT =
  '검은 성채의 성벽 위에서 강현우는 이서연에게 차갑게 검을 겨누었다. "다시 만나면 적이라고 했을 텐데." 그날의 맹세는 부서진 은빛 회중시계 속에 잠들어 있었다.';
const EXCERPT_TEXT = '강현우는 이서연에게 차갑게 검을 겨누었다.';
const EXCERPT_START = SAMPLE_MANUSCRIPT.indexOf(EXCERPT_TEXT);
const EXCERPT_END = EXCERPT_START + EXCERPT_TEXT.length;

function createBaseRevision(content = SAMPLE_MANUSCRIPT): Revision {
  return {
    id: REVISION_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    episodeTitle: '제1화. 검은 성채의 재회',
    content,
    charCountWithSpaces: content.length,
    label: '1차 퇴고본',
    createdAt: '2026-04-01T10:00:00.000Z',
  };
}

function createRelationshipDraft(): ExtractedRelationshipDraftPayload {
  return {
    id: 'rel_char_hyunwoo_char_seoyeon',
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    sourceCharacterId: 'char_hyunwoo',
    sourceCharacterName: '강현우',
    targetCharacterId: 'char_seoyeon',
    targetCharacterName: '이서연',
    relationType: '적대적 대립',
    affinityScore: -65,
    isDirectional: true,
    description: '검은 성채에서 재회한 뒤 서로에게 검을 겨누는 적대 관계.',
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
  };
}

function createTimelineEventDraft(): ExtractedTimelineEventDraftPayload {
  return {
    id: 'evt_ep_001_fortress_duel',
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    title: '검은 성채 성벽 위의 대치',
    summary: '강현우와 이서연이 검은 성채 성벽 위에서 재회하여 검을 겨누다.',
    episodeId: EPISODE_ID,
    sceneId: SCENE_ID,
    inUniverseDate: '제국력 412년 겨울',
    chronologicalOrder: 12,
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
  };
}

function createForeshadowingDraft(): ExtractedForeshadowingDraftPayload {
  return {
    id: 'fsh_silver_pocket_watch',
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    title: '부서진 은빛 회중시계의 맹세',
    description: '과거의 맹세가 담긴 부서진 은빛 회중시계가 언급됨.',
    cluePhase: 'PLANTED',
    canonStatus: 'PROPOSED',
    plantedEpisodeId: EPISODE_ID,
    plantedSceneId: SCENE_ID,
    resolvedEpisodeId: '',
    resolvedSceneId: '',
    relatedCharacterIds: ['char_hyunwoo', 'char_seoyeon'],
    relatedCharacterNames: ['강현우', '이서연'],
    relatedEventIds: ['evt_ep_001_fortress_duel'],
    payoffNote: '후반부 성채 지하 봉인 해제 열쇠로 회수 예정.',
    sourceRevisionId: REVISION_ID,
    provenance: {
      sourceType: 'AI_PROPOSAL',
      createdBy: 'AI_ENGINE',
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      revisionId: REVISION_ID,
    },
  };
}

function createProposalWithEnvelope(params: {
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
}): { proposal: ChangeProposal; envelope: ChangeProposalPayloadEnvelope } {
  const envelope: ChangeProposalPayloadEnvelope = {
    schemaVersion: 'PHASE_4_2_1_V1',
    fingerprint: `fp_${params.targetEntityType}_${params.proposedAction}_${params.targetEntityId}`,
    targetEntityType: params.targetEntityType,
    proposedAction: params.proposedAction,
    targetEntityId: params.targetEntityId,
    sourceEpisodeId: EPISODE_ID,
    sourceRevisionId: REVISION_ID,
    sourceSceneId: SCENE_ID,
    verifiedExcerpt: {
      excerpt: EXCERPT_TEXT,
      matchedText: EXCERPT_TEXT,
      startOffset: EXCERPT_START,
      endOffset: EXCERPT_END,
      matchMethod: 'EXACT',
    },
    precedingContext: '검은 성채의 성벽 위에서 ',
    followingContext: ' "다시 만나면 적이라고 했을 텐데."',
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
    existingEntitySnapshot: params.existingEntitySnapshot ?? null,
  };

  const proposal: ChangeProposal = {
    id: `prop_${params.targetEntityId}`,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    targetEntityType: params.targetEntityType,
    targetEntityId: params.targetEntityId,
    proposedAction: params.proposedAction,
    title: '제안서 테스트 제목',
    rationale: '원문 근거에 따른 설정 반영 제안',
    beforeSummary: '기존 설정 없음',
    afterSummary: '신규 설정 반영',
    proposedPayloadJson: JSON.stringify(envelope),
    triggerEpisodeId: EPISODE_ID,
    triggerSceneId: SCENE_ID,
    sourceRevisionId: REVISION_ID,
    canonStatus: 'PROPOSED',
    reviewedAt: '',
    createdBy: 'AI_ENGINE',
    createdAt: '2026-04-01T10:05:00.000Z',
    updatedAt: '2026-04-01T10:05:00.000Z',
  };

  return { proposal, envelope };
}

test('Phase 4.2.2 Logic: mapApprovedRelationship maps lastChangedEpisodeId -> effectiveEpisodeId and outputs exact 16 Firestore keys', () => {
  const relDraft = createRelationshipDraft();
  const { proposal } = createProposalWithEnvelope({
    targetEntityType: 'RELATIONSHIP',
    proposedAction: 'CREATE',
    targetEntityId: relDraft.id,
    relationshipDraft: relDraft,
  });

  const validCharacterIds = new Set(['char_hyunwoo', 'char_seoyeon']);
  const validTimelineEventIds = new Set(['evt_ep_001_fortress_duel']);
  const validEpisodeIds = new Set([EPISODE_ID]);

  const result = mapApprovedRelationship({
    proposal,
    draft: relDraft,
    existingEntity: null,
    validCharacterIds,
    validTimelineEventIds,
    validEpisodeIds,
    nowIso: NOW_ISO,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.entity.canonStatus, 'CANON');
  assert.equal(result.entity.effectiveEpisodeId, EPISODE_ID);
  assert.equal(result.entity.effectiveEventId, '');
  assert.equal(result.entity.sourceCharacterId, 'char_hyunwoo');
  assert.equal(result.entity.targetCharacterId, 'char_seoyeon');
  assert.equal(result.entity.affinityScore, -65);
  assert.equal(result.entity.createdBy, 'AI_ENGINE');

  // Ensure non-schema fields are stripped and exact 16 keys match firestore.rules
  const entityKeys = Object.keys(result.entity).sort();
  assert.deepEqual(
    entityKeys,
    [...ALLOWED_RELATIONSHIP_FIRESTORE_KEYS].sort()
  );
  assert.equal('lastChangedEpisodeId' in result.entity, false);
  assert.equal('sourceCharacterName' in result.entity, false);
});

test('Phase 4.2.2 Logic: mapApprovedRelationship rejects missing characters or self-relationship', () => {
  const relDraft = createRelationshipDraft();
  const { proposal } = createProposalWithEnvelope({
    targetEntityType: 'RELATIONSHIP',
    proposedAction: 'CREATE',
    targetEntityId: relDraft.id,
    relationshipDraft: relDraft,
  });

  const missingTargetResult = mapApprovedRelationship({
    proposal,
    draft: relDraft,
    existingEntity: null,
    validCharacterIds: new Set(['char_hyunwoo']),
    validTimelineEventIds: new Set(),
    validEpisodeIds: new Set([EPISODE_ID]),
    nowIso: NOW_ISO,
  });
  assert.equal(missingTargetResult.ok, false);
  if (!missingTargetResult.ok) {
    assert.equal(missingTargetResult.code, 'REFERENCE_INTEGRITY_ERROR');
  }

  const selfRelResult = mapApprovedRelationship({
    proposal,
    draft: { ...relDraft, targetCharacterId: 'char_hyunwoo' },
    existingEntity: null,
    validCharacterIds: new Set(['char_hyunwoo']),
    validTimelineEventIds: new Set(),
    validEpisodeIds: new Set([EPISODE_ID]),
    nowIso: NOW_ISO,
  });
  assert.equal(selfRelResult.ok, false);
  if (!selfRelResult.ok) {
    assert.equal(selfRelResult.code, 'REFERENCE_INTEGRITY_ERROR');
  }
});

test('Phase 4.2.2 Logic: mapApprovedTimelineEvent maps involvedCharacterIds -> participantCharacterIds and locationWorldItemId -> linkedWorldbuildingIds with exact 16 keys', () => {
  const evtDraft = createTimelineEventDraft();
  const existingEvent: TimelineEvent = {
    id: evtDraft.id,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    title: '이전 제목',
    summary: '이전 요약',
    inUniverseDate: '제국력 412년 초겨울',
    chronologicalOrder: 10,
    episodeId: EPISODE_ID,
    sceneId: SCENE_ID,
    participantCharacterIds: ['char_hyunwoo'],
    linkedForeshadowingIds: ['fsh_silver_pocket_watch'],
    linkedWorldbuildingIds: ['wb_ancient_empire'],
    canonStatus: 'CANON',
    sourceRevisionId: 'rev_000',
    createdBy: 'AUTHOR',
    createdAt: '2026-03-20T00:00:00.000Z',
    updatedAt: '2026-03-20T00:00:00.000Z',
  };

  const { proposal } = createProposalWithEnvelope({
    targetEntityType: 'TIMELINE_EVENT',
    proposedAction: 'UPDATE',
    targetEntityId: evtDraft.id,
    timelineEventDraft: evtDraft,
    existingEntitySnapshot: existingEvent,
  });

  const result = mapApprovedTimelineEvent({
    proposal,
    draft: evtDraft,
    existingEntity: existingEvent,
    validCharacterIds: new Set(['char_hyunwoo', 'char_seoyeon']),
    validWorldbuildingIds: new Set(['wb_ancient_empire', 'wb_black_fortress']),
    validForeshadowingIds: new Set(['fsh_silver_pocket_watch']),
    validEpisodeIds: new Set([EPISODE_ID]),
    validSceneIdsForEpisode: new Set([SCENE_ID]),
    nowIso: NOW_ISO,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.entity.canonStatus, 'CANON');
  assert.deepEqual(result.entity.participantCharacterIds, [
    'char_hyunwoo',
    'char_seoyeon',
  ]);
  // Preserves existing wb_ancient_empire AND merges verified locationWorldItemId wb_black_fortress
  assert.deepEqual(result.entity.linkedWorldbuildingIds, [
    'wb_ancient_empire',
    'wb_black_fortress',
  ]);
  // Preserves existing linkedForeshadowingIds
  assert.deepEqual(result.entity.linkedForeshadowingIds, [
    'fsh_silver_pocket_watch',
  ]);
  assert.equal(result.entity.createdAt, '2026-03-20T00:00:00.000Z');
  assert.equal(result.entity.updatedAt, NOW_ISO);

  const entityKeys = Object.keys(result.entity).sort();
  assert.deepEqual(
    entityKeys,
    [...ALLOWED_TIMELINE_EVENT_FIRESTORE_KEYS].sort()
  );
  assert.equal('involvedCharacterIds' in result.entity, false);
  assert.equal('locationWorldItemId' in result.entity, false);
});

test('Phase 4.2.2 Logic: mapApprovedForeshadowing strips payoffNote from Foreshadowing entity while returning payoffNote for Audit with exact 17 keys', () => {
  const fshDraft = createForeshadowingDraft();
  const { proposal, envelope } = createProposalWithEnvelope({
    targetEntityType: 'FORESHADOWING',
    proposedAction: 'CREATE',
    targetEntityId: fshDraft.id,
    foreshadowingDraft: fshDraft,
  });

  const validSceneIdsByEpisode = new Map<string, Set<string>>([
    [EPISODE_ID, new Set([SCENE_ID])],
  ]);

  const result = mapApprovedForeshadowing({
    proposal,
    draft: fshDraft,
    existingEntity: null,
    validCharacterIds: new Set(['char_hyunwoo', 'char_seoyeon']),
    validTimelineEventIds: new Set(['evt_ep_001_fortress_duel']),
    validEpisodeIds: new Set([EPISODE_ID]),
    validSceneIdsByEpisode,
    nowIso: NOW_ISO,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.entity.canonStatus, 'CANON');
  assert.equal(result.entity.cluePhase, 'PLANTED');
  assert.equal(result.entity.plantedEpisodeId, EPISODE_ID);
  assert.equal(result.entity.plantedSceneId, SCENE_ID);
  assert.equal(
    result.payoffNote,
    '후반부 성채 지하 봉인 해제 열쇠로 회수 예정.'
  );
  assert.equal('payoffNote' in result.entity, false);

  const entityKeys = Object.keys(result.entity).sort();
  assert.deepEqual(
    entityKeys,
    [...ALLOWED_FORESHADOWING_FIRESTORE_KEYS].sort()
  );

  const auditRecord = buildApprovalAuditRecord({
    proposal,
    envelope,
    decision: 'APPROVED',
    reviewerUid: OWNER_ID,
    reviewNote: '복선 승인 완료',
    beforeEntity: null,
    afterEntity: result.entity,
    payoffNote: result.payoffNote,
    ragSyncStatus: 'PENDING',
    nowIso: NOW_ISO,
  });

  assert.equal(
    auditRecord.payoffNote,
    '후반부 성채 지하 봉인 해제 열쇠로 회수 예정.'
  );
  assert.deepEqual(
    Object.keys(auditRecord).sort(),
    [...ALLOWED_APPROVAL_AUDIT_FIRESTORE_KEYS].sort()
  );
});

test('Phase 4.2.2 Logic: verifyRevisionExcerptAtApproval detects modified revision text and surrogate splits', () => {
  const relDraft = createRelationshipDraft();
  const { proposal, envelope } = createProposalWithEnvelope({
    targetEntityType: 'RELATIONSHIP',
    proposedAction: 'CREATE',
    targetEntityId: relDraft.id,
    relationshipDraft: relDraft,
  });

  const validRevision = createBaseRevision(SAMPLE_MANUSCRIPT);
  const okCheck = verifyRevisionExcerptAtApproval({
    proposal,
    envelope,
    revision: validRevision,
  });
  assert.equal(okCheck.ok, true);

  const editedRevision = createBaseRevision(
    SAMPLE_MANUSCRIPT.replace('차갑게 검을 겨누었다', '따뜻하게 손을 내밀었다')
  );
  const failCheck = verifyRevisionExcerptAtApproval({
    proposal,
    envelope,
    revision: editedRevision,
  });
  assert.equal(failCheck.ok, false);
  if (!failCheck.ok) {
    assert.equal(failCheck.code, 'EXCERPT_OFFSET_INVALID');
  }
});

test('Phase 4.2.2 Logic: detectTargetEntityStaleOrConflict prevents overwriting newer CANON edits unless forceApplyOnStale is true', () => {
  const relDraft = createRelationshipDraft();
  const snapshotEntity: CharacterRelationship = {
    id: relDraft.id,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    sourceCharacterId: 'char_hyunwoo',
    targetCharacterId: 'char_seoyeon',
    relationType: '과거 동료',
    affinityScore: 20,
    isDirectional: true,
    description: '초기 설정',
    canonStatus: 'CANON',
    effectiveEpisodeId: EPISODE_ID,
    effectiveEventId: '',
    sourceRevisionId: 'rev_000',
    createdBy: 'AUTHOR',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
  };

  const { envelope: createEnvelope } = createProposalWithEnvelope({
    targetEntityType: 'RELATIONSHIP',
    proposedAction: 'CREATE',
    targetEntityId: relDraft.id,
    relationshipDraft: relDraft,
  });

  // CREATE fails when target already exists
  const createConflict = detectTargetEntityStaleOrConflict({
    envelope: createEnvelope,
    currentEntity: snapshotEntity,
  });
  assert.equal(createConflict.ok, false);
  if (!createConflict.ok) {
    assert.equal(createConflict.code, 'TARGET_ALREADY_EXISTS');
  }

  // UPDATE fails when target entity was modified after snapshot
  const { envelope: updateEnvelope } = createProposalWithEnvelope({
    targetEntityType: 'RELATIONSHIP',
    proposedAction: 'UPDATE',
    targetEntityId: relDraft.id,
    relationshipDraft: relDraft,
    existingEntitySnapshot: snapshotEntity,
  });

  const modifiedCurrentEntity: CharacterRelationship = {
    ...snapshotEntity,
    affinityScore: -90,
    updatedAt: '2026-03-15T00:00:00.000Z',
  };

  const staleCheck = detectTargetEntityStaleOrConflict({
    envelope: updateEnvelope,
    currentEntity: modifiedCurrentEntity,
    forceApplyOnStale: false,
  });
  assert.equal(staleCheck.ok, false);
  if (!staleCheck.ok) {
    assert.equal(staleCheck.code, 'STALE_TARGET');
  }

  const forcedCheck = detectTargetEntityStaleOrConflict({
    envelope: updateEnvelope,
    currentEntity: modifiedCurrentEntity,
    forceApplyOnStale: true,
  });
  assert.equal(forcedCheck.ok, false);
  if (!forcedCheck.ok) {
    assert.equal(forcedCheck.code, 'STALE_OVERRIDE_FORBIDDEN');
  }
});

test('Phase 4.2.2 Logic: verifyProposalEnvelopeIntegrity rejects unsupported entity types or ARCHIVE/DELETE actions', () => {
  const relDraft = createRelationshipDraft();
  const { proposal } = createProposalWithEnvelope({
    targetEntityType: 'RELATIONSHIP',
    proposedAction: 'CREATE',
    targetEntityId: relDraft.id,
    relationshipDraft: relDraft,
  });

  const unsupportedEntity = verifyProposalEnvelopeIntegrity({
    ...proposal,
    targetEntityType: 'CHARACTER',
  });
  assert.equal(unsupportedEntity.ok, false);
  if (!unsupportedEntity.ok) {
    assert.equal(unsupportedEntity.code, 'UNSUPPORTED_ENTITY_OR_ACTION');
  }

  const unsupportedAction = verifyProposalEnvelopeIntegrity({
    ...proposal,
    proposedAction: 'ARCHIVE',
  });
  assert.equal(unsupportedAction.ok, false);
  if (!unsupportedAction.ok) {
    assert.equal(unsupportedAction.code, 'UNSUPPORTED_ENTITY_OR_ACTION');
  }
});
