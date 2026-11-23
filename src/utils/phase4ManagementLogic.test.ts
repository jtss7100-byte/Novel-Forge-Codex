import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Character,
  CharacterRelationship,
  Episode,
  Foreshadowing,
  Project,
  ProjectBundle,
  Revision,
  Scene,
  TimelineEvent,
} from '../types/novel';
import {
  assertCanonProtection,
  traceForeshadowingHierarchyChain,
} from './foundationLogic';
import {
  CANON_CONFIRMATION_MESSAGE,
  computeForeshadowingDiffs,
  detectForeshadowingBrokenReferences,
  detectNonlinearTimelineEventIds,
  evaluateRagAutoIndexEligibility,
  filterForeshadowings,
  interpretRagApiResponse,
  isolateProjectBundleEntities,
  resolveVerifiedSourceRevisionId,
  sortTimelineEvents,
  validateProjectScopedForeshadowing,
  validateProjectScopedRelationship,
} from './phase4ManagementLogic';

const NOW_ISO = '2026-04-19T12:00:00.000Z';

function buildFixtureContext() {
  const projectA: Project = {
    id: 'proj_a',
    ownerId: 'author_1',
    title: '검은 탑의 연대기',
    genre: '다크 판타지',
    synopsis: '검은 탑을 오르는 기사들의 이야기',
    status: 'confirmed',
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };

  const episodes: Episode[] = [
    {
      id: 'ep_1',
      ownerId: 'author_1',
      projectId: 'proj_a',
      episodeNumber: 1,
      title: '잿빛 성문',
      content: '카시안은 부러진 은빛 회중시계를 주웠다.',
      synopsis: '성문 앞의 조우',
      authorNote: '',
      charCountWithSpaces: 24,
      charCountWithoutSpaces: 19,
      status: 'confirmed',
      linkedCharacterIds: ['char_1'],
      linkedWorldbuildingIds: [],
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
    {
      id: 'ep_2',
      ownerId: 'author_1',
      projectId: 'proj_a',
      episodeNumber: 2,
      title: '심연의 계단',
      content: '엘레나가 회중시계 내부의 문양을 알아보았다.',
      synopsis: '회중시계 단서 심화',
      authorNote: '',
      charCountWithSpaces: 26,
      charCountWithoutSpaces: 21,
      status: 'confirmed',
      linkedCharacterIds: ['char_1', 'char_2'],
      linkedWorldbuildingIds: [],
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
    {
      id: 'ep_3',
      ownerId: 'author_1',
      projectId: 'proj_a',
      episodeNumber: 3,
      title: '시계탑의 진실',
      content: '회중시계의 진짜 주인이 성주였음이 밝혀졌다.',
      synopsis: '복선 회수 회차',
      authorNote: '',
      charCountWithSpaces: 25,
      charCountWithoutSpaces: 20,
      status: 'confirmed',
      linkedCharacterIds: ['char_1', 'char_2'],
      linkedWorldbuildingIds: [],
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
  ];

  const scenes: Scene[] = [
    {
      id: 'sc_1_1',
      ownerId: 'author_1',
      projectId: 'proj_a',
      episodeId: 'ep_1',
      sceneNumber: 1,
      title: '성문 앞 잿더미',
      summary: '카시안이 시계를 발견함',
      location: '북부 성문',
      pointOfViewCharacterId: 'char_1',
      eventIds: ['evt_1'],
      characterIds: ['char_1'],
      foreshadowingIds: [],
      canonStatus: 'CANON',
      sourceRevisionId: 'rev_real_ep1',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
    {
      id: 'sc_3_1',
      ownerId: 'author_1',
      projectId: 'proj_a',
      episodeId: 'ep_3',
      sceneNumber: 1,
      title: '첨탑 밀실',
      summary: '시계의 주인이 밝혀짐',
      location: '첨탑 밀실',
      pointOfViewCharacterId: 'char_2',
      eventIds: ['evt_past'],
      characterIds: ['char_1', 'char_2'],
      foreshadowingIds: [],
      canonStatus: 'CANON',
      sourceRevisionId: 'rev_real_ep3',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
  ];

  const characters: Character[] = [
    {
      id: 'char_1',
      ownerId: 'author_1',
      projectId: 'proj_a',
      name: '카시안',
      role: '주인공',
      affiliation: '북부 기사단',
      appearance: '검은 망토',
      personality: '침착함',
      background: '몰락 가문 출신',
      abilities: '검술',
      status: 'confirmed',
      linkedEpisodeIds: ['ep_1', 'ep_2', 'ep_3'],
      linkedWorldbuildingIds: [],
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
    {
      id: 'char_2',
      ownerId: 'author_1',
      projectId: 'proj_a',
      name: '엘레나',
      role: '조력자',
      affiliation: '고대 학회',
      appearance: '은발',
      personality: '냉철함',
      background: '고대 문장 해독가',
      abilities: '고대어 해독',
      status: 'confirmed',
      linkedEpisodeIds: ['ep_2', 'ep_3'],
      linkedWorldbuildingIds: [],
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
  ];

  const timelineEvents: TimelineEvent[] = [
    {
      id: 'evt_past',
      ownerId: 'author_1',
      projectId: 'proj_a',
      title: '15년 전 시계탑 화재',
      summary: '과거 회상 사건',
      inUniverseDate: '제국력 485년 겨울',
      chronologicalOrder: -50,
      episodeId: 'ep_3',
      sceneId: 'sc_3_1',
      participantCharacterIds: ['char_1'],
      linkedForeshadowingIds: [],
      linkedWorldbuildingIds: [],
      canonStatus: 'CANON',
      createdBy: 'AUTHOR',
      sourceRevisionId: 'rev_real_ep3',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
    {
      id: 'evt_1',
      ownerId: 'author_1',
      projectId: 'proj_a',
      title: '잿빛 성문 돌파',
      summary: '카시안이 성문에 진입하고 시계를 입수함',
      inUniverseDate: '제국력 500년 3월 1일',
      chronologicalOrder: 10,
      episodeId: 'ep_1',
      sceneId: 'sc_1_1',
      participantCharacterIds: ['char_1'],
      linkedForeshadowingIds: [],
      linkedWorldbuildingIds: [],
      canonStatus: 'CANON',
      createdBy: 'AUTHOR',
      sourceRevisionId: 'rev_real_ep1',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
    {
      id: 'evt_2',
      ownerId: 'author_1',
      projectId: 'proj_a',
      title: '첨탑 밀실 개방',
      summary: '시계의 비밀을 확인함',
      inUniverseDate: '제국력 500년 3월 5일',
      chronologicalOrder: 20,
      episodeId: 'ep_2',
      sceneId: '',
      participantCharacterIds: ['char_1', 'char_2'],
      linkedForeshadowingIds: [],
      linkedWorldbuildingIds: [],
      canonStatus: 'DRAFT',
      createdBy: 'AUTHOR',
      sourceRevisionId: '',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
  ];

  const revisions: Revision[] = [
    {
      id: 'rev_real_ep1',
      ownerId: 'author_1',
      projectId: 'proj_a',
      episodeId: 'ep_1',
      episodeTitle: '잿빛 성문',
      content: '카시안은 부러진 은빛 회중시계를 주웠다.',
      charCountWithSpaces: 24,
      label: '1화 초고 확정본',
      createdAt: NOW_ISO,
    },
    {
      id: 'rev_real_ep3',
      ownerId: 'author_1',
      projectId: 'proj_a',
      episodeId: 'ep_3',
      episodeTitle: '시계탑의 진실',
      content: '회중시계의 진짜 주인이 성주였음이 밝혀졌다.',
      charCountWithSpaces: 25,
      label: '3화 확정 스냅샷',
      createdAt: NOW_ISO,
    },
  ];

  return {
    projectA,
    episodes,
    scenes,
    characters,
    timelineEvents,
    revisions,
    context: {
      projectId: 'proj_a',
      episodes,
      scenes,
      characters,
      timelineEvents,
      revisions,
    },
  };
}

describe('Phase 4.1 Stage 2 — 9.1 Foreshadowing Management & Lifecycle Tests', () => {
  it('validates PLANTED foreshadowing creation and deduplicates related IDs', () => {
    const { context } = buildFixtureContext();
    const res = validateProjectScopedForeshadowing(
      {
        title: '부러진 은빛 회중시계',
        description: '성문 앞에서 주운 시계의 주인을 암시하는 복선',
        cluePhase: 'PLANTED',
        canonStatus: 'DRAFT',
        plantedEpisodeId: 'ep_1',
        plantedSceneId: 'sc_1_1',
        relatedCharacterIds: ['char_1', 'char_1'],
        relatedEventIds: ['evt_1', 'evt_1'],
        sourceRevisionId: 'rev_real_ep1',
      },
      context
    );

    assert.equal(res.valid, true);
    assert.equal(res.requiresResolutionConfirmation, false);
    assert.deepEqual(res.sanitizedRelatedCharacterIds, ['char_1']);
    assert.deepEqual(res.sanitizedRelatedEventIds, ['evt_1']);
    assert.equal(res.verifiedSourceRevisionId, 'rev_real_ep1');
  });

  it('supports PLANTED -> REINFORCED -> RESOLVED lifecycle and requires explicit confirmation on RESOLVED transition without auto-promoting canonStatus', () => {
    const { context } = buildFixtureContext();

    // Step 1: PLANTED -> REINFORCED (remains DRAFT)
    const reinforced = validateProjectScopedForeshadowing(
      {
        title: '부러진 은빛 회중시계',
        description: '엘레나가 문양을 해독하며 단서가 강화됨',
        cluePhase: 'REINFORCED',
        canonStatus: 'DRAFT',
        plantedEpisodeId: 'ep_1',
        plantedSceneId: 'sc_1_1',
        relatedCharacterIds: ['char_1', 'char_2'],
        relatedEventIds: ['evt_1'],
      },
      context,
      { previousPhase: 'PLANTED' }
    );
    assert.equal(reinforced.valid, true);
    assert.equal(reinforced.requiresResolutionConfirmation, false);

    // Step 2: REINFORCED -> RESOLVED triggers requiresResolutionConfirmation and preserves DRAFT
    const resolved = validateProjectScopedForeshadowing(
      {
        title: '부러진 은빛 회중시계',
        description: '3화에서 시계의 진짜 주인이 밝혀지며 회수 완료',
        cluePhase: 'RESOLVED',
        canonStatus: 'DRAFT',
        plantedEpisodeId: 'ep_1',
        plantedSceneId: 'sc_1_1',
        resolvedEpisodeId: 'ep_3',
        resolvedSceneId: 'sc_3_1',
        relatedCharacterIds: ['char_1', 'char_2'],
        relatedEventIds: ['evt_1', 'evt_2'],
      },
      context,
      { previousPhase: 'REINFORCED' }
    );
    assert.equal(resolved.valid, true);
    assert.equal(resolved.requiresResolutionConfirmation, true);
    assert.equal(resolved.warnings.length, 0);
  });

  it('supports PLANTED -> ABANDONED transition while preserving planted episode/scene provenance', () => {
    const { context } = buildFixtureContext();
    const abandoned = validateProjectScopedForeshadowing(
      {
        title: '폐기된 서브플롯 단서',
        description: '후반부 플롯 변경으로 회수하지 않기로 결정한 복선',
        cluePhase: 'ABANDONED',
        canonStatus: 'DRAFT',
        plantedEpisodeId: 'ep_1',
        plantedSceneId: 'sc_1_1',
        relatedCharacterIds: ['char_1'],
      },
      context,
      { previousPhase: 'PLANTED' }
    );
    assert.equal(abandoned.valid, true);
    assert.equal(abandoned.requiresResolutionConfirmation, false);
  });

  it('warns when RESOLVED has no resolvedEpisodeId or when resolvedEpisode precedes plantedEpisode', () => {
    const { context } = buildFixtureContext();

    const noResolvedEp = validateProjectScopedForeshadowing(
      {
        title: '회수 회차 미지정 복선',
        description: '회수 완료로 전환했으나 회수 회차를 비워둔 경우',
        cluePhase: 'RESOLVED',
        canonStatus: 'DRAFT',
        plantedEpisodeId: 'ep_2',
      },
      context,
      { previousPhase: 'PLANTED' }
    );
    assert.equal(noResolvedEp.valid, true);
    assert.equal(noResolvedEp.requiresResolutionConfirmation, true);
    assert.equal(noResolvedEp.warnings.length, 1);

    const reversedEp = validateProjectScopedForeshadowing(
      {
        title: '역순 회차 복선',
        description: '설치 3화, 회수 1화로 지정된 경우 경고 발생',
        cluePhase: 'RESOLVED',
        canonStatus: 'DRAFT',
        plantedEpisodeId: 'ep_3',
        resolvedEpisodeId: 'ep_1',
      },
      context,
      { previousPhase: 'PLANTED' }
    );
    assert.equal(reversedEp.valid, true);
    assert.ok(
      reversedEp.warnings.some((w) => w.includes('앞선 회차로 지정'))
    );
  });

  it('enforces CANON protection and computes accurate diffs when modifying a CANON foreshadowing', () => {
    assert.throws(() => {
      assertCanonProtection({
        actor: 'AI_ENGINE',
        operation: 'UPDATE',
        canonStatus: 'CANON',
      });
    });

    assert.doesNotThrow(() => {
      assertCanonProtection({
        actor: 'AUTHOR',
        operation: 'UPDATE',
        canonStatus: 'CANON',
      });
    });

    const beforeFsh: Foreshadowing = {
      id: 'fsh_1',
      ownerId: 'author_1',
      projectId: 'proj_a',
      title: '은빛 회중시계',
      description: '초기 설명',
      cluePhase: 'PLANTED',
      canonStatus: 'CANON',
      plantedEpisodeId: 'ep_1',
      plantedSceneId: 'sc_1_1',
      resolvedEpisodeId: '',
      resolvedSceneId: '',
      relatedEventIds: ['evt_1'],
      relatedCharacterIds: ['char_1'],
      createdBy: 'AUTHOR',
      sourceRevisionId: 'rev_real_ep1',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };

    const afterFsh: Foreshadowing = {
      ...beforeFsh,
      cluePhase: 'RESOLVED',
      resolvedEpisodeId: 'ep_3',
      description: '3화에서 성주의 유품으로 밝혀짐',
    };

    const diffs = computeForeshadowingDiffs(beforeFsh, afterFsh, {
      formatEpisode: (id) => id || '(미지정)',
      formatScene: (id) => id || '(미지정)',
      formatCharacter: (id) => id,
      formatEvent: (id) => id,
    });

    assert.equal(diffs.length, 3);
    assert.ok(CANON_CONFIRMATION_MESSAGE.includes('이미 확정된 정사 설정을 변경합니다'));
  });

  it('blocks references to non-existent episodes, scenes, characters, or timeline events and detects broken references', () => {
    const { context, projectA, episodes, scenes, characters, timelineEvents } =
      buildFixtureContext();

    const badChar = validateProjectScopedForeshadowing(
      {
        title: '잘못된 인물 참조',
        description: '존재하지 않는 인물 ID 포함',
        cluePhase: 'PLANTED',
        canonStatus: 'DRAFT',
        relatedCharacterIds: ['char_non_existent'],
      },
      context
    );
    assert.equal(badChar.valid, false);

    const mismatchedScene = validateProjectScopedForeshadowing(
      {
        title: '회차-장면 불일치',
        description: '1화 회차에 3화 장면을 연결한 경우 차단',
        cluePhase: 'PLANTED',
        canonStatus: 'DRAFT',
        plantedEpisodeId: 'ep_1',
        plantedSceneId: 'sc_3_1',
      },
      context
    );
    assert.equal(mismatchedScene.valid, false);

    const brokenFsh: Foreshadowing = {
      id: 'fsh_broken',
      ownerId: 'author_1',
      projectId: 'proj_a',
      title: '삭제된 참조 복선',
      description: '설명',
      cluePhase: 'PLANTED',
      canonStatus: 'DRAFT',
      plantedEpisodeId: 'ep_deleted',
      plantedSceneId: '',
      resolvedEpisodeId: '',
      resolvedSceneId: '',
      relatedEventIds: ['evt_deleted'],
      relatedCharacterIds: ['char_deleted'],
      createdBy: 'AUTHOR',
      sourceRevisionId: '',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };

    const brokenCheck = detectForeshadowingBrokenReferences(brokenFsh, context);
    assert.equal(brokenCheck.hasBrokenRef, true);
    assert.equal(brokenCheck.missingPlantedEpisode, true);
    assert.deepEqual(brokenCheck.missingCharacterIds, ['char_deleted']);
    assert.deepEqual(brokenCheck.missingEventIds, ['evt_deleted']);

    // Verify hierarchy trace for valid foreshadowing
    const validFsh: Foreshadowing = {
      ...brokenFsh,
      id: 'fsh_valid',
      plantedEpisodeId: 'ep_1',
      plantedSceneId: 'sc_1_1',
      resolvedEpisodeId: 'ep_3',
      resolvedSceneId: 'sc_3_1',
      relatedCharacterIds: ['char_1'],
      relatedEventIds: ['evt_1'],
    };
    const trace = traceForeshadowingHierarchyChain({
      project: projectA,
      foreshadowing: validFsh,
      episodes,
      scenes,
      characters,
      events: timelineEvents,
    });
    assert.equal(trace.plantedEpisode?.id, 'ep_1');
    assert.equal(trace.resolvedEpisode?.id, 'ep_3');
    assert.equal(trace.relatedCharacters.length, 1);
  });
});

describe('Phase 4.1 Stage 2 — 9.2 Character Relationships Validation Tests', () => {
  it('blocks self-relationships (sourceCharacterId === targetCharacterId)', () => {
    const { characters, episodes, timelineEvents, revisions } =
      buildFixtureContext();
    const res = validateProjectScopedRelationship(
      {
        sourceCharacterId: 'char_1',
        targetCharacterId: 'char_1',
        relationType: '동료',
        affinityScore: 50,
        isDirectional: false,
        description: '자기 자신과의 관계 시도',
        canonStatus: 'DRAFT',
      },
      {
        projectId: 'proj_a',
        characters,
        episodes,
        timelineEvents,
        existingRelationships: [],
        revisions,
      }
    );
    assert.equal(res.valid, false);
    assert.ok(res.error?.includes('동일한 인물 간에는 관계를 설정할 수 없습니다'));
  });

  it('distinguishes directional vs bidirectional relationships and blocks duplicates', () => {
    const { characters, episodes, timelineEvents, revisions } =
      buildFixtureContext();
    const existing: CharacterRelationship[] = [
      {
        id: 'rel_1',
        ownerId: 'author_1',
        projectId: 'proj_a',
        sourceCharacterId: 'char_1',
        targetCharacterId: 'char_2',
        relationType: '동료 / 전우',
        affinityScore: 70,
        isDirectional: true,
        description: '카시안이 엘레나를 신뢰함',
        effectiveEpisodeId: 'ep_1',
        effectiveEventId: '',
        canonStatus: 'CANON',
        createdBy: 'AUTHOR',
        sourceRevisionId: 'rev_real_ep1',
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    ];

    // Exact directional duplicate A -> B with same type and effectiveEpisodeId is blocked
    const dupExact = validateProjectScopedRelationship(
      {
        sourceCharacterId: 'char_1',
        targetCharacterId: 'char_2',
        relationType: '동료 / 전우',
        affinityScore: 80,
        isDirectional: true,
        description: '중복 등록 시도',
        canonStatus: 'DRAFT',
        effectiveEpisodeId: 'ep_1',
      },
      {
        projectId: 'proj_a',
        characters,
        episodes,
        timelineEvents,
        existingRelationships: existing,
        revisions,
      }
    );
    assert.equal(dupExact.valid, false);

    // Reverse directional B -> A when both are directional is allowed
    const reverseDirectional = validateProjectScopedRelationship(
      {
        sourceCharacterId: 'char_2',
        targetCharacterId: 'char_1',
        relationType: '동료 / 전우',
        affinityScore: 60,
        isDirectional: true,
        description: '엘레나가 카시안을 평가함',
        canonStatus: 'DRAFT',
        effectiveEpisodeId: 'ep_1',
      },
      {
        projectId: 'proj_a',
        characters,
        episodes,
        timelineEvents,
        existingRelationships: existing,
        revisions,
      }
    );
    assert.equal(reverseDirectional.valid, true);
  });

  it('enforces affinityScore range (-100 to +100)', () => {
    const { characters, episodes, timelineEvents, revisions } =
      buildFixtureContext();
    const outOfBounds = validateProjectScopedRelationship(
      {
        sourceCharacterId: 'char_1',
        targetCharacterId: 'char_2',
        relationType: '숙적',
        affinityScore: -150,
        isDirectional: false,
        description: '범위 초과 호감도',
        canonStatus: 'DRAFT',
      },
      {
        projectId: 'proj_a',
        characters,
        episodes,
        timelineEvents,
        existingRelationships: [],
        revisions,
      }
    );
    assert.equal(outOfBounds.valid, false);
  });
});

describe('Phase 4.1 Stage 2 — 9.3 Timeline Sorting & Verified sourceRevisionId Tests', () => {
  it('distinguishes chronologicalOrder sorting from episode appearance sorting and detects nonlinear flashbacks', () => {
    const { timelineEvents, episodes } = buildFixtureContext();
    const episodeMap = new Map(episodes.map((e) => [e.id, e]));

    const byChronoAsc = sortTimelineEvents(
      timelineEvents,
      'chronological_asc',
      episodeMap
    );
    assert.deepEqual(
      byChronoAsc.map((e) => e.id),
      ['evt_past', 'evt_1', 'evt_2']
    );

    const byEpisodeOrder = sortTimelineEvents(
      timelineEvents,
      'episode_order',
      episodeMap
    );
    assert.deepEqual(
      byEpisodeOrder.map((e) => e.id),
      ['evt_1', 'evt_2', 'evt_past']
    );

    const nonlinearIds = detectNonlinearTimelineEventIds(
      timelineEvents,
      episodeMap
    );
    assert.equal(nonlinearIds.has('evt_past'), true);
    assert.equal(nonlinearIds.has('evt_1'), false);
  });

  it('rejects fabricated sourceRevisionId values and skips RAG auto-indexing when revision is unverified', () => {
    const { revisions } = buildFixtureContext();

    // Fake ID like rev_${id}_${nowIso} must NOT be accepted
    const fakeRevCheck = resolveVerifiedSourceRevisionId({
      candidateRevisionId: 'rev_evt_1_2026-04-19T12:00:00.000Z',
      projectRevisions: revisions,
      projectId: 'proj_a',
    });
    assert.equal(fakeRevCheck, '');

    // Verified revision ID in project is accepted
    const realRevCheck = resolveVerifiedSourceRevisionId({
      candidateRevisionId: 'rev_real_ep1',
      projectRevisions: revisions,
      projectId: 'proj_a',
    });
    assert.equal(realRevCheck, 'rev_real_ep1');

    // Eligibility check blocks unverified sourceRevisionId even if entity is CANON
    const unverifiedEligibility = evaluateRagAutoIndexEligibility({
      canonStatus: 'CANON',
      sourceRevisionId: 'rev_fake_id_12345',
      projectRevisions: revisions,
      projectId: 'proj_a',
      rawText: '연표 사건 본문',
    });
    assert.equal(unverifiedEligibility.eligible, false);
    assert.equal(
      unverifiedEligibility.skipReason,
      'UNVERIFIED_SOURCE_REVISION'
    );

    // Eligibility check succeeds when CANON + verified revision ID
    const verifiedEligibility = evaluateRagAutoIndexEligibility({
      canonStatus: 'CANON',
      sourceRevisionId: 'rev_real_ep1',
      projectRevisions: revisions,
      projectId: 'proj_a',
      rawText: '연표 사건 본문',
    });
    assert.equal(verifiedEligibility.eligible, true);
    assert.equal(verifiedEligibility.verifiedRevisionId, 'rev_real_ep1');
  });
});

describe('Phase 4.1 Stage 2 — 9.4 Project Isolation & RAG HTTP Failure Separation Tests', () => {
  it('isolates ProjectBundle entities by activeProjectId and prevents cross-project contamination', () => {
    const {
      projectA,
      episodes,
      scenes,
      characters,
      timelineEvents,
      revisions,
    } = buildFixtureContext();

    const mixedForeshadowings: Foreshadowing[] = [
      {
        id: 'fsh_proj_a',
        ownerId: 'author_1',
        projectId: 'proj_a',
        title: '작품 A의 복선',
        description: '설명 A',
        cluePhase: 'PLANTED',
        canonStatus: 'DRAFT',
        plantedEpisodeId: 'ep_1',
        plantedSceneId: '',
        resolvedEpisodeId: '',
        resolvedSceneId: '',
        relatedEventIds: [],
        relatedCharacterIds: [],
        createdBy: 'AUTHOR',
        sourceRevisionId: '',
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
      {
        id: 'fsh_proj_b',
        ownerId: 'author_1',
        projectId: 'proj_b',
        title: '작품 B의 복선 (혼입 금지)',
        description: '설명 B',
        cluePhase: 'PLANTED',
        canonStatus: 'CANON',
        plantedEpisodeId: '',
        plantedSceneId: '',
        resolvedEpisodeId: '',
        resolvedSceneId: '',
        relatedEventIds: [],
        relatedCharacterIds: [],
        createdBy: 'AUTHOR',
        sourceRevisionId: '',
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    ];

    const filteredForA = filterForeshadowings(mixedForeshadowings, {
      projectId: 'proj_a',
      phaseFilter: 'UNRESOLVED',
    });
    assert.equal(filteredForA.length, 1);
    assert.equal(filteredForA[0]?.id, 'fsh_proj_a');

    const bundle: ProjectBundle = {
      formatVersion: '1.0',
      exportedAt: NOW_ISO,
      project: projectA,
      characters,
      worldbuilding: [],
      episodes,
      revisions,
      scenes,
      relationships: [],
      timelineEvents,
      foreshadowings: mixedForeshadowings,
    };

    const isolated = isolateProjectBundleEntities(bundle, 'proj_a');
    assert.equal(isolated.foreshadowings.length, 1);
    assert.equal(isolated.foreshadowings[0]?.id, 'fsh_proj_a');
    assert.equal(isolated.scenes.length, 2);
  });

  it('classifies HTTP 4xx/5xx or indexStatus=FAILED responses from /api/rag/* as FAILED separately from save success', () => {
    const http500 = interpretRagApiResponse({
      ok: false,
      status: 500,
      body: { error: 'Embedding service unavailable' },
    });
    assert.equal(http500.ragStatus, 'FAILED');
    assert.equal(http500.retryable, true);
    assert.equal(http500.errorMessage, 'Embedding service unavailable');

    const logicFail = interpretRagApiResponse({
      ok: true,
      status: 200,
      body: {
        success: false,
        indexStatus: 'FAILED',
        error: 'Dimension mismatch',
        retryable: false,
      },
    });
    assert.equal(logicFail.ragStatus, 'FAILED');
    assert.equal(logicFail.retryable, false);

    const okRes = interpretRagApiResponse({
      ok: true,
      status: 200,
      body: { success: true, indexStatus: 'INDEXED' },
    });
    assert.equal(okRes.ragStatus, 'INDEXED');
  });
});
