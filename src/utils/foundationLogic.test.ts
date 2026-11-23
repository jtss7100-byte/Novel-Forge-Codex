import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCanonProtection,
  buildProjectHierarchyLinks,
  checkCanonMutationPermission,
  createChangeProposalDraft,
  createDataProvenance,
  formatCanonStatusKorean,
  normalizeToCanonStatus,
  resolveChangeProposalStatus,
  toLegacySettingStatus,
  traceForeshadowingHierarchyChain,
  validateChangeProposalInput,
  validateCharacterRelationshipInput,
  validateForeshadowingInput,
  validateMemoryChunkInput,
  validateMemoryDocumentInput,
  validateSceneInput,
  validateStyleProfileInput,
  validateTimelineEventInput,
} from './foundationLogic';
import {
  FoundationMemorySearchStore,
  splitTextIntoMemoryChunks,
} from '../services/memorySearchProvider';
import { createInitialSeedBundle } from './seedData';
import type {
  CharacterRelationship,
  Foreshadowing,
  Scene,
  StyleProfile,
  TimelineEvent,
} from '../types/novel';

test('Phase 1.5: CanonStatus normalization and legacy status backward compatibility', () => {
  assert.equal(normalizeToCanonStatus('draft'), 'DRAFT');
  assert.equal(normalizeToCanonStatus('confirmed'), 'CANON');
  assert.equal(normalizeToCanonStatus('PROPOSED'), 'PROPOSED');
  assert.equal(normalizeToCanonStatus('REJECTED'), 'REJECTED');
  assert.equal(normalizeToCanonStatus('ARCHIVED'), 'ARCHIVED');
  assert.equal(normalizeToCanonStatus(undefined), 'DRAFT');

  assert.equal(toLegacySettingStatus('CANON'), 'confirmed');
  assert.equal(toLegacySettingStatus('confirmed'), 'confirmed');
  assert.equal(toLegacySettingStatus('DRAFT'), 'draft');
  assert.equal(toLegacySettingStatus('PROPOSED'), 'draft');

  assert.equal(formatCanonStatusKorean('CANON'), '작가 확정 (CANON)');
  assert.equal(formatCanonStatusKorean('PROPOSED'), 'AI 제안 (PROPOSED)');
});

test('Phase 1.5: Canon Setting Protection blocks AI_ENGINE from modifying or deleting CANON settings', () => {
  // 1. AI_ENGINE attempting to UPDATE a CANON ('CANON' or legacy 'confirmed') setting is blocked
  const aiUpdateCanon = checkCanonMutationPermission({
    actor: 'AI_ENGINE',
    operation: 'UPDATE',
    canonStatus: 'CANON',
  });
  assert.equal(aiUpdateCanon.allowed, false);
  assert.equal(aiUpdateCanon.requiresChangeProposal, true);

  const aiUpdateLegacyConfirmed = checkCanonMutationPermission({
    actor: 'AI_ENGINE',
    operation: 'UPDATE',
    currentStatus: 'confirmed',
  });
  assert.equal(aiUpdateLegacyConfirmed.allowed, false);
  assert.equal(aiUpdateLegacyConfirmed.requiresChangeProposal, true);

  // 2. AI_ENGINE attempting to DELETE any setting is blocked
  const aiDeleteDraft = checkCanonMutationPermission({
    actor: 'AI_ENGINE',
    operation: 'DELETE',
    canonStatus: 'DRAFT',
  });
  assert.equal(aiDeleteDraft.allowed, false);
  assert.equal(aiDeleteDraft.requiresChangeProposal, true);

  assert.throws(() => {
    assertCanonProtection({
      actor: 'AI_ENGINE',
      operation: 'UPDATE',
      canonStatus: 'CANON',
    });
  }, /ChangeProposal/);

  // 3. AI_ENGINE can update DRAFT or PROPOSED items
  const aiUpdateDraft = checkCanonMutationPermission({
    actor: 'AI_ENGINE',
    operation: 'UPDATE',
    canonStatus: 'DRAFT',
  });
  assert.equal(aiUpdateDraft.allowed, true);

  // 4. AUTHOR can always modify or delete CANON items
  const authorUpdateCanon = checkCanonMutationPermission({
    actor: 'AUTHOR',
    operation: 'UPDATE',
    canonStatus: 'CANON',
  });
  assert.equal(authorUpdateCanon.allowed, true);
  assert.equal(authorUpdateCanon.requiresChangeProposal, false);
});

test('Phase 1.5: ChangeProposal workflow enforces AUTHOR-only approval', () => {
  const proposal = createChangeProposalDraft({
    ownerId: 'user_author_01',
    projectId: 'proj_01',
    targetEntityType: 'CHARACTER',
    targetEntityId: 'char_kael',
    proposedAction: 'UPDATE',
    title: '카엘 3서클 서릿빛 오러 각성 반영 요청',
    rationale: '3화 후반부 전투 장면에서 3서클 오러 해방이 묘사됨',
    beforeSummary: '2서클 상급 오러 사용자',
    afterSummary: '3서클 서릿빛 오러 각성자',
    proposedPayload: { abilities: '3서클 서릿빛 오러 각성' },
    triggerEpisodeId: 'ep_03',
    triggerSceneId: 'scene_03_02',
    sourceRevisionId: 'rev_03_01',
  });

  assert.equal(proposal.canonStatus, 'PROPOSED');
  assert.equal(proposal.createdBy, 'AI_ENGINE');
  assert.equal(validateChangeProposalInput(proposal).valid, true);

  // AI_ENGINE cannot approve its own proposal
  assert.throws(() => {
    resolveChangeProposalStatus(proposal, 'APPROVE', 'AI_ENGINE');
  }, /작가\(AUTHOR\)만 승인/);

  // AUTHOR approves proposal -> transitions to CANON
  const approved = resolveChangeProposalStatus(proposal, 'APPROVE', 'AUTHOR');
  assert.equal(approved.canonStatus, 'CANON');
  assert.ok(approved.reviewedAt.length > 0);
});

test('Phase 1.5: Hierarchy chain (User -> Project -> Episode -> Scene -> Event -> Character -> Foreshadowing) & Revision Provenance', () => {
  const seed = createInitialSeedBundle('author_uid_777');
  const ep1 = seed.episodes[0];
  const ep3 = seed.episodes[2];
  const kael = seed.characters[0];
  const rev1 = seed.revisions[0];

  const scene1: Scene = {
    id: 'scene_ep1_01',
    ownerId: seed.project.ownerId,
    projectId: seed.project.id,
    episodeId: ep1.id,
    sceneNumber: 1,
    title: '검은 성채 지하 봉인실 조우',
    summary: '카엘이 부서진 성검의 파편에서 푸른 불꽃의 징조를 목격한다.',
    location: '북부 검은 성채 지하 3층',
    pointOfViewCharacterId: kael.id,
    eventIds: ['event_seal_crack'],
    characterIds: [kael.id],
    foreshadowingIds: ['fsh_blue_flame'],
    canonStatus: 'CANON',
    sourceRevisionId: rev1.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const event1: TimelineEvent = {
    id: 'event_seal_crack',
    ownerId: seed.project.ownerId,
    projectId: seed.project.id,
    title: '성검 아스트라 봉인 균열 사건',
    summary: '제국력 412년 겨울, 성검의 첫 번째 봉인이 해체되며 심연의 파동이 감지됨.',
    inUniverseDate: '제국력 412년 동지',
    chronologicalOrder: 10,
    episodeId: ep1.id,
    sceneId: scene1.id,
    participantCharacterIds: [kael.id],
    linkedForeshadowingIds: ['fsh_blue_flame'],
    linkedWorldbuildingIds: [seed.worldbuilding[0].id],
    canonStatus: 'CANON',
    sourceRevisionId: rev1.id,
    createdBy: 'AUTHOR',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const foreshadowing1: Foreshadowing = {
    id: 'fsh_blue_flame',
    ownerId: seed.project.ownerId,
    projectId: seed.project.id,
    title: '잿빛 성검에 깃든 푸른 심연 불꽃의 정체',
    description: '1화에서 검신에 스친 푸른 불꽃이 사실 초대 황제의 잔류 사념이라는 복선.',
    cluePhase: 'PLANTED',
    canonStatus: 'CANON',
    plantedEpisodeId: ep1.id,
    plantedSceneId: scene1.id,
    resolvedEpisodeId: ep3.id,
    resolvedSceneId: '',
    relatedEventIds: [event1.id],
    relatedCharacterIds: [kael.id],
    sourceRevisionId: rev1.id,
    createdBy: 'AUTHOR',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  assert.equal(validateSceneInput(scene1).valid, true);
  assert.equal(validateTimelineEventInput(event1).valid, true);
  assert.equal(validateForeshadowingInput(foreshadowing1).valid, true);

  const hierarchy = buildProjectHierarchyLinks({
    project: seed.project,
    episodes: seed.episodes,
    scenes: [scene1],
    events: [event1],
    characters: seed.characters,
    foreshadowings: [foreshadowing1],
  });

  assert.equal(hierarchy.userId, 'author_uid_777');
  assert.equal(hierarchy.projectId, seed.project.id);
  assert.ok(hierarchy.episodeIds.includes(ep1.id));
  assert.ok(hierarchy.sceneIds.includes(scene1.id));
  assert.ok(hierarchy.eventIds.includes(event1.id));
  assert.ok(hierarchy.characterIds.includes(kael.id));
  assert.ok(hierarchy.foreshadowingIds.includes(foreshadowing1.id));

  const traced = traceForeshadowingHierarchyChain({
    foreshadowing: foreshadowing1,
    project: seed.project,
    episodes: seed.episodes,
    scenes: [scene1],
    events: [event1],
    characters: seed.characters,
  });

  assert.equal(traced.userId, 'author_uid_777');
  assert.equal(traced.plantedEpisode?.id, ep1.id);
  assert.equal(traced.plantedScene?.id, scene1.id);
  assert.equal(traced.resolvedEpisode?.id, ep3.id);
  assert.equal(traced.relatedEvents[0]?.id, event1.id);
  assert.equal(traced.relatedCharacters[0]?.id, kael.id);
  assert.equal(traced.sourceRevisionId, rev1.id);

  const provenance = createDataProvenance({
    sourceType: 'MANUSCRIPT',
    createdBy: 'AUTHOR',
    ownerId: seed.project.ownerId,
    projectId: seed.project.id,
    episodeId: ep1.id,
    sceneId: scene1.id,
    eventId: event1.id,
    revisionId: rev1.id,
    excerpt: ep1.content.slice(0, 120),
  });
  assert.equal(provenance.revisionId, rev1.id);
  assert.equal(provenance.episodeId, ep1.id);
});

test('Phase 1.5: Validators for CharacterRelationship, StyleProfile, MemoryDocument, and MemoryChunk', () => {
  const rel: Partial<CharacterRelationship> = {
    sourceCharacterId: 'char_kael',
    targetCharacterId: 'char_elena',
    relationType: '맹약의 동료 및 상호 경계',
    affinityScore: 65,
    isDirectional: true,
    description: '북부 전선에서 생사를 함께했으나 황실의 비밀을 두고 긴장 관계를 유지함.',
    canonStatus: 'CANON',
  };
  assert.equal(validateCharacterRelationshipInput(rel).valid, true);

  // Self-relationship should fail validation
  assert.equal(
    validateCharacterRelationshipInput({
      ...rel,
      targetCharacterId: 'char_kael',
    }).valid,
    false
  );

  const style: Partial<StyleProfile> = {
    name: '정통 다크 판타지 3인칭 제한 시점 문체',
    narrativePerspective: 'THIRD_LIMITED',
    dialogueRatio: 35,
    avgSentenceLength: 48,
    toneKeywords: ['중후함', '냉소적', '감각적 전투 묘사'],
    preferredExpressions: ['서릿빛 오러', '침묵이 내려앉았다'],
    prohibitedExpressions: ['현대 인터넷 은어'],
    sampleExcerpt: '차가운 철 냄새가 폐부 깊숙이 스며들었다.',
    canonStatus: 'CANON',
  };
  assert.equal(validateStyleProfileInput(style).valid, true);

  assert.equal(
    validateMemoryDocumentInput({
      title: '1화 원고 기억 인덱스',
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_01',
      fullText: '성검 아스트라의 파편이 공명했다.',
      canonStatus: 'CANON',
    }).valid,
    true
  );

  assert.equal(
    validateMemoryChunkInput({
      documentId: 'memdoc_01',
      sourceEntityType: 'EPISODE',
      sourceEntityId: 'ep_01',
      chunkIndex: 0,
      content: '성검 아스트라의 파편이 공명했다.',
      canonStatus: 'CANON',
    }).valid,
    true
  );
});

test('Phase 1.5: MemorySearchProvider (indexDocument, search, getSource, deleteDocument)', async () => {
  const store = new FoundationMemorySearchStore();

  const textParagraphs = [
    '제1장. 북부 검은 성채의 지하 봉인실에서 카엘은 부서진 성검 아스트라를 발견했다.',
    '제2장. 엘레나는 고대 마탑의 금서에서 서릿빛 오러와 심연의 균열에 관한 예언을 해독했다.',
  ].join('\n\n');

  const split = splitTextIntoMemoryChunks(textParagraphs, 60);
  assert.ok(split.length >= 2);

  // Index a CANON document
  const indexedCanon = await store.indexDocument({
    ownerId: 'user_01',
    projectId: 'proj_01',
    sourceEntityType: 'EPISODE',
    sourceEntityId: 'ep_01',
    sourceRevisionId: 'rev_ep1_v2',
    title: '1화. 잿빛 성검의 귀환',
    fullText: textParagraphs,
    canonStatus: 'CANON',
    episodeId: 'ep_01',
    sceneId: 'scene_01',
    characterIds: ['char_kael', 'char_elena'],
    foreshadowingIds: ['fsh_astra'],
    keywords: ['성검', '아스트라', '서릿빛 오러'],
    maxChunkLength: 60,
  });

  assert.equal(indexedCanon.document.canonStatus, 'CANON');
  assert.ok(indexedCanon.chunks.length >= 2);
  assert.equal(indexedCanon.document.sourceRevisionId, 'rev_ep1_v2');

  // Index a DRAFT document (should be excluded by default CANON-only search)
  await store.indexDocument({
    ownerId: 'user_01',
    projectId: 'proj_01',
    sourceEntityType: 'WORLDBUILDING',
    sourceEntityId: 'wb_draft_99',
    sourceRevisionId: 'rev_draft',
    title: '미확정 드래곤 설정 초안',
    fullText: '아스트라 성검이 사실 드래곤의 이빨이라는 미확정 가설.',
    canonStatus: 'DRAFT',
  });

  // Search (default allowedCanonStatuses = ['CANON'])
  const hits = await store.search({
    projectId: 'proj_01',
    queryText: '아스트라 성검',
  });
  assert.ok(hits.length >= 1);
  assert.ok(hits.every((h) => h.document.id === indexedCanon.document.id));
  assert.ok(hits.every((h) => h.document.canonStatus === 'CANON'));

  // getSource by chunkId traces back to document + revision provenance
  const sourceRef = await store.getSource('proj_01', indexedCanon.chunks[0].id);
  assert.ok(sourceRef !== null);
  assert.equal(sourceRef?.document.id, indexedCanon.document.id);
  assert.equal(sourceRef?.provenance.revisionId, 'rev_ep1_v2');
  assert.equal(sourceRef?.provenance.episodeId, 'ep_01');

  // deleteDocument removes both document and chunks
  const deleted = await store.deleteDocument('proj_01', indexedCanon.document.id);
  assert.equal(deleted, true);

  const hitsAfterDelete = await store.search({
    projectId: 'proj_01',
    queryText: '아스트라',
  });
  assert.equal(hitsAfterDelete.length, 0);
});
