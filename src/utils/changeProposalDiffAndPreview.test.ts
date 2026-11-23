import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { registerIsolatedMockFirestoreForTest } from '../server/authMiddleware';
import { previewChangeProposalApprovalOnServer } from '../server/changeProposalApprovalEngine';
import {
  buildChangeProposalFieldDiff,
  buildPreviewTargetEntityCandidate,
} from './changeProposalApprovalLogic';
import type {
  ChangeProposal,
  CharacterRelationship,
  Foreshadowing,
  TimelineEvent,
} from '../types/novel';

function buildRelationshipProposal(overrides?: Partial<ChangeProposal>): ChangeProposal {
  const exactText = '카엘과 세라피나는 생사를 함께하는 동맹을 맺었다.';
  const payload = {
    schemaVersion: 'PHASE_4_2_1_V1',
    proposalId: 'prop_rel_diff_01',
    fingerprint: 'fp_prop_rel_diff_01',
    extractionRunId: 'extrun_diff_01',
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: 'rel_kael_sera',
    proposedAction: overrides?.proposedAction || 'UPDATE',
    sourceRevisionId: 'rev_01',
    sourceEpisodeId: 'ep_01',
    sourceSceneId: 'scene_01',
    confidenceScore: 0.92,
    temporalContext: 'PRESENT_EVENT',
    uncertaintyFlags: [],
    canonConflicts: [],
    verifiedExcerpt: {
      excerpt: exactText,
      matchedText: exactText,
      startOffset: 10,
      endOffset: 37,
      matchMethod: 'EXACT',
      matchCount: 1,
    },
    provenance: {
      sourceType: 'MANUSCRIPT',
      createdBy: 'AI_ENGINE',
      ownerId: 'user_diff_01',
      projectId: 'proj_diff_01',
      episodeId: 'ep_01',
      sceneId: 'scene_01',
      revisionId: 'rev_01',
      excerpt: exactText,
      startOffset: 10,
      endOffset: 37,
    },
    relationshipDraft: {
      id: 'rel_kael_sera',
      ownerId: 'user_diff_01',
      projectId: 'proj_diff_01',
      sourceCharacterId: 'char_kael',
      sourceCharacterName: '카엘 반스',
      targetCharacterId: 'char_sera',
      targetCharacterName: '세라피나 룩스',
      relationType: '생사를 함께하는 절대 동맹',
      affinityScore: 95,
      isDirectional: false,
      description: '대균열 강하 작전을 통해 신뢰가 최고조에 달함.',
      lastChangedEpisodeId: 'ep_01',
      canonStatus: 'PROPOSED',
      sourceRevisionId: 'rev_01',
      createdBy: 'AI_ENGINE',
      provenance: {
        sourceType: 'MANUSCRIPT',
        createdBy: 'AI_ENGINE',
        ownerId: 'user_diff_01',
        projectId: 'proj_diff_01',
        episodeId: 'ep_01',
        sceneId: 'scene_01',
        revisionId: 'rev_01',
        excerpt: exactText,
        startOffset: 10,
        endOffset: 37,
      },
    },
    existingEntitySnapshot: {
      id: 'rel_kael_sera',
      ownerId: 'user_diff_01',
      projectId: 'proj_diff_01',
      sourceCharacterId: 'char_kael',
      targetCharacterId: 'char_sera',
      relationType: '상관과 부관',
      affinityScore: 70,
      isDirectional: false,
      description: '기존 상관과 부관 관계.',
      canonStatus: 'CANON',
      effectiveEpisodeId: 'ep_01',
      effectiveEventId: '',
      sourceRevisionId: 'rev_01',
      createdBy: 'AUTHOR',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-05T12:00:00.000Z',
    },
  };

  return {
    id: 'prop_rel_diff_01',
    ownerId: 'user_diff_01',
    projectId: 'proj_diff_01',
    targetEntityType: 'RELATIONSHIP',
    targetEntityId: 'rel_kael_sera',
    proposedAction: 'UPDATE',
    title: '카엘 ↔ 세라피나 관계 격상',
    rationale: '1화 대균열 강하 대사 근거',
    beforeSummary: '상관과 부관 (+70)',
    afterSummary: '생사를 함께하는 절대 동맹 (+95)',
    proposedPayloadJson: JSON.stringify(payload),
    canonStatus: 'PROPOSED',
    triggerEpisodeId: 'ep_01',
    triggerSceneId: 'scene_01',
    sourceRevisionId: 'rev_01',
    createdBy: 'AI_ENGINE',
    reviewedAt: '',
    createdAt: '2026-11-10T10:00:00.000Z',
    updatedAt: '2026-11-10T10:00:00.000Z',
    ...overrides,
  };
}

test('Phase 4.2.2 Stage 2 (Section 6): buildChangeProposalFieldDiff computes structured ADDED, MODIFIED, UNCHANGED, and conflict flags for RELATIONSHIP, TIMELINE_EVENT, and FORESHADOWING', () => {
  const displayNames = {
    char_kael: '카엘 반스',
    char_sera: '세라피나 룩스',
    ep_01: '1화. 철문 개방',
    evt_01: '녹턴 출격 사건',
  };

  const beforeRel: CharacterRelationship = {
    id: 'rel_kael_sera',
    ownerId: 'user_diff_01',
    projectId: 'proj_diff_01',
    sourceCharacterId: 'char_kael',
    targetCharacterId: 'char_sera',
    relationType: '상관과 부관',
    affinityScore: 70,
    isDirectional: false,
    description: '기존 상관과 부관 관계.',
    canonStatus: 'CANON',
    effectiveEpisodeId: 'ep_01',
    effectiveEventId: '',
    sourceRevisionId: 'rev_01',
    createdBy: 'AUTHOR',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-05T12:00:00.000Z',
  };

  const proposal = buildRelationshipProposal();
  const candidate = buildPreviewTargetEntityCandidate({
    proposal,
    existingEntity: beforeRel,
    nowIso: '2026-11-12T00:00:00.000Z',
  });
  assert.equal(candidate.ok, true);

  const relDiffs = buildChangeProposalFieldDiff({
    targetEntityType: 'RELATIONSHIP',
    proposedAction: 'UPDATE',
    beforeEntity: beforeRel,
    afterEntity: candidate.afterEntity,
    entityDisplayNameMap: displayNames,
  });

  const relationTypeDiff = relDiffs.find((d) => d.fieldKey === 'relationType');
  assert.ok(relationTypeDiff);
  assert.equal(relationTypeDiff.changeType, 'MODIFIED');
  assert.equal(relationTypeDiff.beforeValue, '상관과 부관');
  assert.equal(relationTypeDiff.afterValue, '생사를 함께하는 절대 동맹');

  const sourceCharDiff = relDiffs.find((d) => d.fieldKey === 'sourceCharacterId');
  assert.ok(sourceCharDiff);
  assert.equal(sourceCharDiff.changeType, 'UNCHANGED');
  assert.equal(sourceCharDiff.afterValue, '카엘 반스 (char_kael)');

  // Verify TimelineEvent CREATE diff marks fields as ADDED
  const afterEvt: TimelineEvent = {
    id: 'evt_new_01',
    ownerId: 'user_diff_01',
    projectId: 'proj_diff_01',
    title: '심연 제1층 진입',
    summary: '망각의 회랑으로 진입함',
    inUniverseDate: '제국력 412년 겨울',
    chronologicalOrder: 15,
    episodeId: 'ep_01',
    sceneId: 'scene_01',
    participantCharacterIds: ['char_kael', 'char_sera'],
    linkedForeshadowingIds: [],
    linkedWorldbuildingIds: [],
    canonStatus: 'CANON',
    sourceRevisionId: 'rev_01',
    createdBy: 'AUTHOR',
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
  };

  const evtDiffs = buildChangeProposalFieldDiff({
    targetEntityType: 'TIMELINE_EVENT',
    proposedAction: 'CREATE',
    beforeEntity: null,
    afterEntity: afterEvt,
    entityDisplayNameMap: displayNames,
  });
  assert.equal(
    evtDiffs.every((d) => d.changeType === 'ADDED' && d.beforeValue === null),
    true
  );

  // Verify Foreshadowing UPDATE with conflictDetails highlights conflicting fields
  const beforeFsh: Foreshadowing = {
    id: 'fsh_01',
    ownerId: 'user_diff_01',
    projectId: 'proj_diff_01',
    title: '잿빛 왕관의 비밀',
    description: '기존 설명',
    cluePhase: 'PLANTED',
    canonStatus: 'CANON',
    plantedEpisodeId: 'ep_01',
    plantedSceneId: 'scene_01',
    resolvedEpisodeId: '',
    resolvedSceneId: '',
    relatedEventIds: [],
    relatedCharacterIds: ['char_kael'],
    sourceRevisionId: 'rev_02_newer',
    createdBy: 'AUTHOR',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
  };
  const afterFsh: Foreshadowing = {
    ...beforeFsh,
    cluePhase: 'REINFORCED',
    description: '강화된 설명',
  };
  const fshDiffs = buildChangeProposalFieldDiff({
    targetEntityType: 'FORESHADOWING',
    proposedAction: 'UPDATE',
    beforeEntity: beforeFsh,
    afterEntity: afterFsh,
    conflictDetails: {
      proposalSourceRevisionId: 'rev_01',
      currentEntitySourceRevisionId: 'rev_02_newer',
      changedFields: ['cluePhase', 'description'],
    },
    entityDisplayNameMap: displayNames,
  });
  const clueDiff = fshDiffs.find((d) => d.fieldKey === 'cluePhase');
  assert.ok(clueDiff);
  assert.equal(clueDiff.conflict, true);
  assert.ok(clueDiff.conflictReason?.includes('rev_02_newer'));
});

test('Phase 4.2.2 Stage 2 (Section 5): previewChangeProposalApprovalOnServer performs 0 Firestore writes and detects STALE_TARGET conflicts accurately', async () => {
  const store = new Map<string, Record<string, unknown>>();
  let writeCount = 0;

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
      get: async () => {
        const prefix = `${colPath}/`;
        const docs = Array.from(store.entries())
          .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
          .map(([k, v]) => ({
            id: k.split('/').pop() || '',
            exists: true,
            data: () => v,
          }));
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    }),
    runTransaction: async () => {
      writeCount += 1;
      throw new Error('Preview must never invoke runTransaction');
    },
  } as unknown as Firestore;

  registerIsolatedMockFirestoreForTest(mockDb, {
    projectId: 'test-preview-phase422',
    databaseId: 'test-db-preview',
    runId: 'run_preview_01',
  });

  const ownerId = 'user_diff_01';
  const projectId = 'proj_diff_01';
  const basePath = `users/${ownerId}/projects/${projectId}`;

  store.set(basePath, { id: projectId, ownerId, title: '테스트 프로젝트' });
  store.set(`${basePath}/episodes/ep_01`, {
    id: 'ep_01',
    ownerId,
    projectId,
    episodeNumber: 1,
    title: '첫 번째 회차',
    content: '앞부분 텍스트. 카엘과 세라피나는 생사를 함께하는 동맹을 맺었다. 뒷부분 텍스트.',
  });
  store.set(`${basePath}/scenes/scene_01`, {
    id: 'scene_01',
    ownerId,
    projectId,
    episodeId: 'ep_01',
    sceneNumber: 1,
    title: '첫 번째 장면',
  });
  store.set(`${basePath}/revisions/rev_01`, {
    id: 'rev_01',
    ownerId,
    projectId,
    episodeId: 'ep_01',
    content: '앞부분 텍스트. 카엘과 세라피나는 생사를 함께하는 동맹을 맺었다. 뒷부분 텍스트.',
  });
  store.set(`${basePath}/characters/char_kael`, {
    id: 'char_kael',
    ownerId,
    projectId,
    name: '카엘 반스',
  });
  store.set(`${basePath}/characters/char_sera`, {
    id: 'char_sera',
    ownerId,
    projectId,
    name: '세라피나 룩스',
  });

  const relUpdatedAt = Timestamp.fromDate(new Date('2026-11-05T12:00:00.000Z'));
  store.set(`${basePath}/relationships/rel_kael_sera`, {
    id: 'rel_kael_sera',
    ownerId,
    projectId,
    sourceCharacterId: 'char_kael',
    targetCharacterId: 'char_sera',
    relationType: '상관과 부관',
    affinityScore: 70,
    isDirectional: false,
    description: '기존 상관과 부관 관계.',
    canonStatus: 'CANON',
    effectiveEpisodeId: 'ep_01',
    effectiveEventId: '',
    sourceRevisionId: 'rev_01',
    createdBy: 'AUTHOR',
    createdAt: relUpdatedAt,
    updatedAt: relUpdatedAt,
  });

  const exactText = '카엘과 세라피나는 생사를 함께하는 동맹을 맺었다.';
  const fullContent =
    '앞부분 텍스트. 카엘과 세라피나는 생사를 함께하는 동맹을 맺었다. 뒷부분 텍스트.';
  const startOffset = fullContent.indexOf(exactText);
  const endOffset = startOffset + exactText.length;

  const proposal = buildRelationshipProposal();
  const parsedJson = JSON.parse(proposal.proposedPayloadJson);
  parsedJson.verifiedExcerpt.startOffset = startOffset;
  parsedJson.verifiedExcerpt.endOffset = endOffset;
  parsedJson.verifiedExcerpt.excerpt = exactText;
  parsedJson.verifiedExcerpt.matchedText = exactText;
  proposal.proposedPayloadJson = JSON.stringify(parsedJson);

  store.set(`${basePath}/changeProposals/${proposal.id}`, {
    ...proposal,
  });

  const snapshotCountBefore = store.size;
  const previewOk = await previewChangeProposalApprovalOnServer(
    {
      projectId,
      proposalId: proposal.id,
    },
    {
      db: mockDb,
      verifiedOwnerId: ownerId,
    }
  );

  // Verify 0 writes occurred during preview
  assert.equal(writeCount, 0);
  assert.equal(store.size, snapshotCountBefore);
  assert.equal(previewOk.ok, true);
  assert.equal(previewOk.canApprove, true);
  assert.equal(previewOk.expectedUpdatedAt, '2026-11-05T12:00:00.000Z');
  assert.equal(previewOk.entityDisplayNameMap?.char_kael, '카엘 반스');
  assert.ok(previewOk.fieldDiffs.some((d) => d.changeType === 'MODIFIED'));

  // Now simulate a concurrent update on the target relationship (new revision rev_02)
  store.set(`${basePath}/relationships/rel_kael_sera`, {
    ...store.get(`${basePath}/relationships/rel_kael_sera`),
    relationType: '작가가 직접 수정한 관계',
    sourceRevisionId: 'rev_02_newer',
  });

  const previewStale = await previewChangeProposalApprovalOnServer(
    {
      projectId,
      proposalId: proposal.id,
    },
    {
      db: mockDb,
      verifiedOwnerId: ownerId,
    }
  );

  assert.equal(previewStale.ok, true);
  assert.equal(previewStale.canApprove, false);
  assert.equal(previewStale.conflictCode, 'STALE_TARGET');
  assert.ok(
    previewStale.conflictDetails?.changedFields.includes('relationType')
  );
});
