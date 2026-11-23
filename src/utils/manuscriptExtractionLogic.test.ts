import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAuthorSpanDisambiguationToCandidate,
  computeDeterministicProposalId,
  computeExtractionCandidateFingerprint,
  computeRevisionContentHash,
  isUtf16SurrogateSplit,
  locateAndVerifyExcerptInRevision,
  normalizeWhitespaceOnly,
  parseAndSanitizeAiExtractionResponse,
  resolveCharacterReference,
  validateSelectedCandidateIdsForSave,
  verifyAndConvertExtractionCandidates,
  type ExtractionVerificationContext,
} from './manuscriptExtractionLogic';
import type {
  Character,
  CharacterRelationship,
  Episode,
  Foreshadowing,
  Revision,
  Scene,
  TimelineEvent,
  WorldbuildingItem,
} from '../types/novel';

function createSampleVerificationContext(
  revisionContent: string
): ExtractionVerificationContext {
  const nowIso = '2026-03-30T10:00:00.000Z';
  const episode: Episode = {
    id: 'ep_001',
    ownerId: 'owner_test_1',
    projectId: 'proj_test_1',
    episodeNumber: 1,
    title: '제1화 검붉은 성채의 맹세',
    content: revisionContent,
    synopsis: '성채에서 마주친 카시안과 엘레나.',
    authorNote: '',
    charCountWithSpaces: revisionContent.length,
    charCountWithoutSpaces: revisionContent.replace(/\s+/g, '').length,
    status: 'draft',
    linkedCharacterIds: ['char_cassian', 'char_elena'],
    linkedWorldbuildingIds: ['wb_fortress'],
    latestRevisionId: 'rev_001',
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const revision: Revision = {
    id: 'rev_001',
    ownerId: 'owner_test_1',
    projectId: 'proj_test_1',
    episodeId: 'ep_001',
    episodeTitle: episode.title,
    content: revisionContent,
    charCountWithSpaces: revisionContent.length,
    label: '1차 퇴고본',
    createdAt: nowIso,
  };

  const scenes: Scene[] = [
    {
      id: 'scn_001',
      ownerId: 'owner_test_1',
      projectId: 'proj_test_1',
      episodeId: 'ep_001',
      sceneNumber: 1,
      title: '첨탑의 대치',
      summary: '카시안과 엘레나가 첨탑에서 마주한다.',
      location: '검붉은 성채 첨탑',
      pointOfViewCharacterId: 'char_cassian',
      eventIds: [],
      characterIds: ['char_cassian', 'char_elena'],
      foreshadowingIds: [],
      canonStatus: 'CANON',
      sourceRevisionId: 'rev_001',
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ];

  const characters: Character[] = [
    {
      id: 'char_cassian',
      ownerId: 'owner_test_1',
      projectId: 'proj_test_1',
      name: '카시안',
      role: '주인공',
      affiliation: '북부 기사단',
      appearance: '흑발',
      personality: '냉철함',
      background: '몰락 가문 출신',
      abilities: '검술',
      status: 'confirmed',
      canonStatus: 'CANON',
      linkedEpisodeIds: ['ep_001'],
      linkedWorldbuildingIds: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    {
      id: 'char_elena',
      ownerId: 'owner_test_1',
      projectId: 'proj_test_1',
      name: '엘레나',
      role: '주연',
      affiliation: '황실 마탑',
      appearance: '은발',
      personality: '신중함',
      background: '마탑 수석',
      abilities: '고대 마법',
      status: 'confirmed',
      canonStatus: 'CANON',
      linkedEpisodeIds: ['ep_001'],
      linkedWorldbuildingIds: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ];

  const worldbuilding: WorldbuildingItem[] = [
    {
      id: 'wb_fortress',
      ownerId: 'owner_test_1',
      projectId: 'proj_test_1',
      title: '검붉은 성채',
      category: '지리/장소',
      summary: '북부 변경의 요새',
      content: '고대 결계가 새겨진 성채.',
      rules: '외부 마력 차단',
      status: 'confirmed',
      canonStatus: 'CANON',
      linkedCharacterIds: [],
      linkedEpisodeIds: ['ep_001'],
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ];

  const relationships: CharacterRelationship[] = [
    {
      id: 'rel_existing_1',
      ownerId: 'owner_test_1',
      projectId: 'proj_test_1',
      sourceCharacterId: 'char_cassian',
      targetCharacterId: 'char_elena',
      relationType: '생명의 은인 및 동맹',
      affinityScore: 75,
      isDirectional: true,
      description: '과거 전장에서 서로를 구한 동맹 관계.',
      canonStatus: 'CANON',
      effectiveEpisodeId: 'ep_001',
      effectiveEventId: 'evt_existing_1',
      sourceRevisionId: 'rev_001',
      createdBy: 'AUTHOR',
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ];

  const timelineEvents: TimelineEvent[] = [
    {
      id: 'evt_existing_1',
      ownerId: 'owner_test_1',
      projectId: 'proj_test_1',
      title: '북부 성채 결계 붕괴',
      summary: '검붉은 성채의 외곽 결계가 무너졌다.',
      episodeId: 'ep_001',
      sceneId: 'scn_001',
      inUniverseDate: '제국력 412년 겨울',
      chronologicalOrder: 10,
      participantCharacterIds: ['char_cassian'],
      linkedForeshadowingIds: ['fsh_existing_1'],
      linkedWorldbuildingIds: ['wb_fortress'],
      canonStatus: 'CANON',
      sourceRevisionId: 'rev_001',
      createdBy: 'AUTHOR',
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ];

  const foreshadowings: Foreshadowing[] = [
    {
      id: 'fsh_existing_1',
      ownerId: 'owner_test_1',
      projectId: 'proj_test_1',
      title: '부서진 은빛 회중시계',
      description: '시침이 거꾸로 도는 은빛 회중시계.',
      cluePhase: 'RESOLVED',
      canonStatus: 'CANON',
      plantedEpisodeId: 'ep_001',
      plantedSceneId: 'scn_001',
      resolvedEpisodeId: 'ep_001',
      resolvedSceneId: 'scn_001',
      relatedCharacterIds: ['char_elena'],
      relatedEventIds: ['evt_existing_1'],
      sourceRevisionId: 'rev_001',
      createdBy: 'AUTHOR',
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ];

  return {
    ownerId: 'owner_test_1',
    projectId: 'proj_test_1',
    episode,
    revision,
    scenes,
    characters,
    worldbuilding,
    relationships,
    timelineEvents,
    foreshadowings,
    existingProposals: [],
  };
}

test('Phase 4.2.1 Logic 1: Exact substring match and UTF-16 offset invariant with Korean + English + Emoji', () => {
  const manuscript =
    '🔥폭풍우가 몰아치는 밤이었다. "Target Alpha-01 확인." 카시안은 검자루(🗡️)를 움켜쥐며 엘레나를 노려보았다. 두 사람 사이의 옛 맹세는 산산조각이 났다.';
  const excerpt = '카시안은 검자루(🗡️)를 움켜쥐며 엘레나를 노려보았다.';

  const res = locateAndVerifyExcerptInRevision({
    revisionContent: manuscript,
    excerpt,
  });

  assert.equal(res.status, 'VERIFIED');
  assert.ok(res.verifiedSpan);
  assert.equal(res.verifiedSpan.matchMethod, 'EXACT');
  assert.equal(
    manuscript.slice(res.verifiedSpan.startOffset, res.verifiedSpan.endOffset),
    excerpt
  );
  assert.equal(
    isUtf16SurrogateSplit(manuscript, res.verifiedSpan.startOffset),
    false
  );
  assert.equal(
    isUtf16SurrogateSplit(manuscript, res.verifiedSpan.endOffset),
    false
  );
});

test('Phase 4.2.1 Logic 2: Surrogate pair split detection on Astral plane emoji', () => {
  const textWithEmoji = '검🔥불'; // '검' (index 0), '🔥' (indices 1, 2 surrogate pair), '불' (index 3)
  assert.equal(isUtf16SurrogateSplit(textWithEmoji, 0), false);
  assert.equal(isUtf16SurrogateSplit(textWithEmoji, 1), false);
  assert.equal(isUtf16SurrogateSplit(textWithEmoji, 2), true); // Mid-emoji split!
  assert.equal(isUtf16SurrogateSplit(textWithEmoji, 3), false);
});

test('Phase 4.2.1 Logic 3: Restricted whitespace-normalized matching preserves original UTF-16 slice', () => {
  const manuscript =
    '성채의 문이 열렸다.\r\n\r\n   엘레나는   조용히   부서진 은빛 회중시계를\n주머니에 넣었다.\t그리고 뒤를 돌아보았다.';
  const aiExcerptWithCollapsedSpaces =
    '엘레나는 조용히 부서진 은빛 회중시계를 주머니에 넣었다.';

  const res = locateAndVerifyExcerptInRevision({
    revisionContent: manuscript,
    excerpt: aiExcerptWithCollapsedSpaces,
  });

  assert.equal(res.status, 'VERIFIED');
  assert.ok(res.verifiedSpan);
  assert.equal(res.verifiedSpan.matchMethod, 'WHITESPACE_NORMALIZED');

  const actualSlice = manuscript.slice(
    res.verifiedSpan.startOffset,
    res.verifiedSpan.endOffset
  );
  assert.equal(actualSlice, res.verifiedSpan.matchedText);
  assert.equal(
    normalizeWhitespaceOnly(actualSlice),
    normalizeWhitespaceOnly(aiExcerptWithCollapsedSpaces)
  );
});

test('Phase 4.2.1 Logic 4: Paraphrased or summarized excerpt is strictly rejected as UNVERIFIED_EXCERPT', () => {
  const manuscript =
    '카시안은 북부 성채의 차가운 돌바닥 위에서 피 묻은 장검을 거두었다.';
  const hallucinatedSummary = '카시안이 성채에서 검을 집어넣었다.';

  const res = locateAndVerifyExcerptInRevision({
    revisionContent: manuscript,
    excerpt: hallucinatedSummary,
  });

  assert.equal(res.status, 'UNVERIFIED_EXCERPT');
  assert.equal(res.verifiedSpan, null);
});

test('Phase 4.2.1 Logic 5: Multi-match excerpt handling (AMBIGUOUS_MULTIPLE_MATCHES vs context/author disambiguation)', () => {
  const manuscript = [
    '제1장. 카시안은 차갑게 말했다. "나는 너를 믿지 않는다." 바람이 불었다.',
    '제2장. 엘레나가 눈물을 삼키며 중얼거렸다. "나는 너를 믿지 않는다." 성탑의 종이 울렸다.',
  ].join('\n\n');
  const repeatedExcerpt = '"나는 너를 믿지 않는다."';

  // 1) Without disambiguating context -> AMBIGUOUS_MULTIPLE_MATCHES
  const ambiguousRes = locateAndVerifyExcerptInRevision({
    revisionContent: manuscript,
    excerpt: repeatedExcerpt,
  });
  assert.equal(ambiguousRes.status, 'AMBIGUOUS_MULTIPLE_MATCHES');
  assert.equal(ambiguousRes.verifiedSpan, null);
  assert.equal(ambiguousRes.candidateSpans.length, 2);

  // 2) With precedingContext / followingContext -> VERIFIED (2nd occurrence)
  const contextDisambiguated = locateAndVerifyExcerptInRevision({
    revisionContent: manuscript,
    excerpt: repeatedExcerpt,
    precedingContext: '엘레나가 눈물을 삼키며 중얼거렸다.',
    followingContext: '성탑의 종이 울렸다.',
  });
  assert.equal(contextDisambiguated.status, 'VERIFIED');
  assert.ok(contextDisambiguated.verifiedSpan);
  assert.equal(
    contextDisambiguated.verifiedSpan.startOffset,
    ambiguousRes.candidateSpans[1].startOffset
  );

  // 3) Author manual disambiguation override -> VERIFIED (1st occurrence)
  const authorOverridden = locateAndVerifyExcerptInRevision({
    revisionContent: manuscript,
    excerpt: repeatedExcerpt,
    authorSelectedSpanOverride: {
      startOffset: ambiguousRes.candidateSpans[0].startOffset,
      endOffset: ambiguousRes.candidateSpans[0].endOffset,
    },
  });
  assert.equal(authorOverridden.status, 'VERIFIED');
  assert.equal(
    authorOverridden.verifiedSpan?.startOffset,
    ambiguousRes.candidateSpans[0].startOffset
  );
});

test('Phase 4.2.1 Logic 6: Character resolution handles homonyms and unregistered characters', () => {
  const baseCtx = createSampleVerificationContext('샘플 본문');
  const homonymChar: Character = {
    ...baseCtx.characters[0],
    id: 'char_cassian_clone',
    name: '카시안',
  };

  // Homonym by name without ID -> flags HOMONYM_CHARACTER_NAME + AMBIGUOUS_CHARACTER_REFERENCE
  const homonymRes = resolveCharacterReference({
    rawId: null,
    rawName: '카시안',
    characters: [...baseCtx.characters, homonymChar],
  });
  assert.equal(homonymRes.resolvedId, null);
  assert.ok(homonymRes.flags.includes('HOMONYM_CHARACTER_NAME'));
  assert.ok(homonymRes.flags.includes('AMBIGUOUS_CHARACTER_REFERENCE'));

  // Unregistered character -> flags NEW_UNREGISTERED_CHARACTER
  const unregRes = resolveCharacterReference({
    rawId: null,
    rawName: '발타자르',
    characters: baseCtx.characters,
  });
  assert.equal(unregRes.resolvedId, null);
  assert.ok(unregRes.flags.includes('NEW_UNREGISTERED_CHARACTER'));
});

test('Phase 4.2.1 Logic 7: Canon conflict detection (affinity reversal, cluePhase regression) and uncertainty tagging', () => {
  const manuscript = [
    '카시안은 엘레나의 배신을 확신하며 검을 겨누었다. "오늘부로 너는 내 철천지원수다!"',
    '한편 회상 속에서 누군가 부서진 은빛 회중시계를 처음 발견했던 과거의 기억이 스쳐 지나갔다.',
  ].join('\n');

  const ctx = createSampleVerificationContext(manuscript);
  const rawResponse = {
    analysis_summary: '관계 적대 반전 및 복선 회상 감지',
    candidates: [
      {
        targetEntityType: 'RELATIONSHIP',
        proposedAction: 'UPDATE',
        existingTargetEntityId: 'rel_existing_1',
        title: '카시안과 엘레나의 적대 반전',
        rationale: '배신을 확신하며 철천지원수로 선언함',
        beforeSummary: '생명의 은인 및 동맹 (+75)',
        afterSummary: '철천지원수 (-80)',
        excerpt: '카시안은 엘레나의 배신을 확신하며 검을 겨누었다. "오늘부로 너는 내 철천지원수다!"',
        precedingContext: null,
        followingContext: null,
        sceneId: 'scn_001',
        confidence: 0.91,
        dialogueClaimOnly: true,
        temporalContextType: 'PRESENT_EVENT',
        uncertaintyFlags: [],
        relationshipPayload: {
          sourceCharacterId: 'char_cassian',
          sourceCharacterName: '카시안',
          targetCharacterId: 'char_elena',
          targetCharacterName: '엘레나',
          relationType: '철천지원수',
          affinityScore: -80,
          isDirectional: true,
          description: '검을 겨누며 적대 선언',
        },
        timelineEventPayload: null,
        foreshadowingPayload: null,
      },
      {
        targetEntityType: 'FORESHADOWING',
        proposedAction: 'UPDATE',
        existingTargetEntityId: 'fsh_existing_1',
        title: '부서진 은빛 회중시계 과거 회상',
        rationale: '회상 장면에서 처음 발견된 시점 언급',
        beforeSummary: 'RESOLVED (CANON)',
        afterSummary: 'PLANTED 단계로 역행 제안',
        excerpt:
          '한편 회상 속에서 누군가 부서진 은빛 회중시계를 처음 발견했던 과거의 기억이 스쳐 지나갔다.',
        precedingContext: null,
        followingContext: null,
        sceneId: 'scn_001',
        confidence: 0.72,
        dialogueClaimOnly: false,
        temporalContextType: 'FLASHBACK',
        uncertaintyFlags: [],
        relationshipPayload: null,
        timelineEventPayload: null,
        foreshadowingPayload: {
          title: '부서진 은빛 회중시계',
          description: '과거 발견 시점',
          cluePhase: 'PLANTED',
          relatedCharacterIds: ['char_elena'],
          relatedCharacterNames: ['엘레나'],
          relatedEventIds: [],
          payoffNote: '',
        },
      },
    ],
  };

  const parsed = parseAndSanitizeAiExtractionResponse(rawResponse);
  assert.equal(parsed.valid, true);
  assert.ok(parsed.data);

  const verified = verifyAndConvertExtractionCandidates(
    parsed.data.candidates,
    ctx
  );
  assert.equal(verified.length, 2);

  // Candidate 1: Relationship affinity reversal (+75 -> -80) + dialogueClaimOnly
  const relCand = verified[0];
  assert.equal(relCand.verification.status, 'VERIFIED');
  assert.equal(relCand.canSaveAsProposal, true);
  assert.ok(relCand.uncertaintyFlags.includes('DIALOGUE_CLAIM_ONLY'));
  assert.ok(relCand.uncertaintyFlags.includes('CONFLICTS_WITH_CANON'));
  assert.ok(
    relCand.canonConflicts.some(
      (c) => c.conflictType === 'AFFINITY_DIRECTION_REVERSAL'
    )
  );
  assert.equal(relCand.proposalDraft?.canonStatus, 'PROPOSED');

  // Candidate 2: Foreshadowing phase regression (RESOLVED -> PLANTED) + FLASHBACK
  const fshCand = verified[1];
  assert.equal(fshCand.verification.status, 'VERIFIED');
  assert.ok(fshCand.uncertaintyFlags.includes('FLASHBACK_OR_PAST_MENTION'));
  assert.ok(fshCand.uncertaintyFlags.includes('CONFLICTS_WITH_CANON'));
  assert.ok(fshCand.uncertaintyFlags.includes('CLUE_PHASE_UNCERTAIN'));
  assert.ok(
    fshCand.canonConflicts.some(
      (c) => c.conflictType === 'CANON_FORESHADOWING_PHASE_REGRESSION'
    )
  );
});

test('Phase 4.2.1 Logic 8: Author span disambiguation promotes AMBIGUOUS_MULTIPLE_MATCHES candidate to VERIFIED', () => {
  const manuscript =
    '첫 번째 문단: 카시안과 엘레나는 손을 맞잡았다.\n두 번째 문단: 카시안과 엘레나는 손을 맞잡았다.';
  const ctx = createSampleVerificationContext(manuscript);

  const parsed = parseAndSanitizeAiExtractionResponse({
    analysis_summary: '중복 문장 테스트',
    candidates: [
      {
        targetEntityType: 'TIMELINE_EVENT',
        proposedAction: 'CREATE',
        existingTargetEntityId: null,
        title: '성채의 화해',
        rationale: '두 인물이 손을 맞잡음',
        beforeSummary: '없음',
        afterSummary: '성채의 화해 사건 추가',
        excerpt: '카시안과 엘레나는 손을 맞잡았다.',
        precedingContext: null,
        followingContext: null,
        sceneId: 'scn_001',
        confidence: 0.85,
        dialogueClaimOnly: false,
        temporalContextType: 'PRESENT_EVENT',
        uncertaintyFlags: [],
        relationshipPayload: null,
        timelineEventPayload: {
          title: '성채의 화해',
          summary: '두 인물이 화해함',
          inUniverseDate: '제국력 412년 겨울',
          chronologicalOrder: 20,
          involvedCharacterIds: ['char_cassian', 'char_elena'],
          involvedCharacterNames: ['카시안', '엘레나'],
          locationWorldItemId: 'wb_fortress',
          locationName: '검붉은 성채',
        },
        foreshadowingPayload: null,
      },
    ],
  });

  assert.ok(parsed.data);
  const initialCandidates = verifyAndConvertExtractionCandidates(
    parsed.data.candidates,
    ctx
  );
  assert.equal(initialCandidates.length, 1);
  assert.equal(
    initialCandidates[0].verification.status,
    'AMBIGUOUS_MULTIPLE_MATCHES'
  );
  assert.equal(initialCandidates[0].canSaveAsProposal, false);
  assert.equal(initialCandidates[0].proposalDraft, null);
  assert.equal(initialCandidates[0].verification.candidateSpans.length, 2);

  // Disambiguate using 2nd candidate span
  const secondSpan = initialCandidates[0].verification.candidateSpans[1];
  const disambiguated = applyAuthorSpanDisambiguationToCandidate({
    candidate: initialCandidates[0],
    selectedSpan: {
      startOffset: secondSpan.startOffset,
      endOffset: secondSpan.endOffset,
    },
    revisionContent: manuscript,
    ownerId: ctx.ownerId,
    projectId: ctx.projectId,
    existingProposals: [],
  });

  assert.equal(disambiguated.verification.status, 'VERIFIED');
  assert.equal(disambiguated.canSaveAsProposal, true);
  assert.ok(disambiguated.proposalDraft);
  assert.equal(disambiguated.proposalDraft.canonStatus, 'PROPOSED');
  assert.equal(
    disambiguated.verification.verifiedSpan?.startOffset,
    secondSpan.startOffset
  );

  // Validate selectedCandidateIdsForSave succeeds once disambiguated
  const selValid = validateSelectedCandidateIdsForSave({
    selectedCandidateIds: [disambiguated.candidateId],
    candidates: [disambiguated],
  });
  assert.equal(selValid.valid, true);
  assert.equal(selValid.selectedCandidates.length, 1);
});

test('Phase 4.2.1 Logic 9: Deterministic proposal ID and revision content hash stability', () => {
  const fp1 = computeExtractionCandidateFingerprint({
    projectId: 'proj_1',
    sourceRevisionId: 'rev_1',
    targetEntityType: 'RELATIONSHIP',
    proposedAction: 'CREATE',
    semanticKey: 'char_a->char_b:동맹',
    startOffset: 10,
    endOffset: 42,
  });
  const fp2 = computeExtractionCandidateFingerprint({
    projectId: 'proj_1',
    sourceRevisionId: 'rev_1',
    targetEntityType: 'RELATIONSHIP',
    proposedAction: 'CREATE',
    semanticKey: '  char_a->char_b:동맹  ',
    startOffset: 10,
    endOffset: 42,
  });

  assert.equal(fp1, fp2);
  const propId1 = computeDeterministicProposalId(fp1);
  const propId2 = computeDeterministicProposalId(fp2);
  assert.equal(propId1, propId2);
  assert.match(propId1, /^prop_[0-9a-f]{32}$/);

  const hashA = computeRevisionContentHash('원고 본문 A');
  const hashB = computeRevisionContentHash('원고 본문 A');
  const hashC = computeRevisionContentHash('원고 본문 B');
  assert.equal(hashA, hashB);
  assert.notEqual(hashA, hashC);
});
