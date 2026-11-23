import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  Episode,
  Project,
  PromptProfile,
  StyleProfile,
} from '../types/novel';
import {
  assembleNovelWriterPromptInOrder,
  buildWritingContext,
  createInitialPromptProfiles,
  createNewPromptProfile,
  restorePromptProfileToVersion,
  updatePromptProfileContent,
} from './aiEngineLogic';
import {
  AUTHOR_STYLE_BENCHMARKS,
  buildDefaultSelectedStyleInstructions,
  computeStylePromptSelectionSync,
  evaluateStyleApprovalUiTransition,
} from './authorStyleLogic';
import {
  buildLiteraryRewritePrompt,
  filterEligibleActivePromptsForContext,
} from './literaryRewritingLogic';
import { computeManuscriptContentHash } from './manuscriptIntegrity';
import { analyzeAuthorStyleOnServer } from '../server/authorStyleAnalyzer';
import {
  rewriteLiteraryPassageOnServer,
  setCustomLiteraryRewriterForTesting,
} from '../server/literaryRewritingEngine';
import {
  parseStyleProfileFromFirestoreData,
  persistApprovedStyleDnaAtomicallyCore,
  updatePromptProfileWithCasCore,
} from '../services/novelRepository';

function createBaseFixtures(projectId = 'proj_stage1_1'): {
  project: Project;
  episode: Episode;
  initialPrompts: PromptProfile[];
} {
  const nowIso = '2026-11-22T12:00:00.000Z';
  const project: Project = {
    id: projectId,
    ownerId: 'author_1',
    title: '에테르나 연대기',
    genre: '다크 판타지',
    synopsis: '성좌와 균열의 전쟁',
    status: 'confirmed',
    canonStatus: 'CANON',
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const episode: Episode = {
    id: 'ep_1',
    ownerId: 'author_1',
    projectId,
    episodeNumber: 1,
    title: '제1화. 균열의 성채',
    content:
      '검은 안개가 회랑 바닥을 낮게 기었다. 카엘은 말없이 걸음을 멈추었다. 심장 아래 에테르나 파편이 서늘하게 맥동했다. "봉인이 풀리고 있군요." 세라피나가 나지막이 중얼거렸다. 그는 고개만 살짝 끄덕였다.',
    synopsis: '카엘과 세라피나가 성채 회랑에 진입한다.',
    authorNote: '',
    charCountWithSpaces: 115,
    charCountWithoutSpaces: 89,
    status: 'confirmed',
    canonStatus: 'CANON',
    linkedCharacterIds: [],
    linkedWorldbuildingIds: [],
    latestRevisionId: 'rev_1',
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const initialPrompts = createInitialPromptProfiles('author_1', projectId, nowIso);
  return { project, episode, initialPrompts };
}

// ============================================================================
// 1. P0-A: buildWritingContext & Literary Rewriting Active/Inactive/Empty/Tenant Filtering
// ============================================================================

test('P0-A.1: buildWritingContext handles undefined, explicit empty [], active selected, inactive selected, and cross-project prompt profiles strictly', () => {
  const { project, episode, initialPrompts } = createBaseFixtures('proj_a');

  const activeStyle = createNewPromptProfile({
    ownerId: 'author_1',
    projectId: 'proj_a',
    promptType: 'PROJECT_STYLE_PROFILE',
    title: '활성 문체 프로필 v1',
    description: '활성 문체',
    content: '[문체 지침] 짧은 단문 위주 긴박한 호흡 유지',
    isActive: true,
  });

  const inactiveStyle = createNewPromptProfile({
    ownerId: 'author_1',
    projectId: 'proj_a',
    promptType: 'PROJECT_STYLE_PROFILE',
    title: '비활성 문체 프로필 v1',
    description: '비활성 문체',
    content: '[문체 지침] 절대 주입되면 안 되는 비활성 지침',
    isActive: false,
  });

  const otherProjectStyle = createNewPromptProfile({
    ownerId: 'author_1',
    projectId: 'proj_b_other',
    promptType: 'PROJECT_STYLE_PROFILE',
    title: '타 작품 문체 프로필',
    description: '타 작품',
    content: '[문체 지침] 타 작품 전용 지침',
    isActive: true,
  });

  const allProfiles = [
    ...initialPrompts,
    activeStyle,
    inactiveStyle,
    otherProjectStyle,
  ];

  // Case 1: selectedPromptProfileIds === undefined -> all active profiles of proj_a (or GLOBAL)
  const ctxDefault = buildWritingContext({
    project,
    episode,
    allEpisodes: [episode],
    characters: [],
    worldbuilding: [],
    promptProfiles: allProfiles,
    selectedCharacterIds: [],
    selectedPromptProfileIds: undefined,
    writingMode: 'SINGLE_SCENE',
    plotOutline: '성채 진입',
    requiredEvents: [],
    forbiddenDevelopments: [],
  });
  assert.equal(
    ctxDefault.activePrompts.some((p) => p.profileId === activeStyle.id),
    true,
    'Active project style profile MUST be included when selectedPromptProfileIds is undefined'
  );
  assert.equal(
    ctxDefault.activePrompts.some((p) => p.profileId === inactiveStyle.id),
    false,
    'Inactive project style profile MUST NOT be included when selectedPromptProfileIds is undefined'
  );
  assert.equal(
    ctxDefault.activePrompts.some((p) => p.profileId === otherProjectStyle.id),
    false,
    'Cross-project style profile MUST NOT be included'
  );

  // Case 2: selectedPromptProfileIds === [] -> explicit empty selection (0 activePrompts, Master Writing Rules core safety still intact)
  const ctxEmpty = buildWritingContext({
    project,
    episode,
    allEpisodes: [episode],
    characters: [],
    worldbuilding: [],
    promptProfiles: allProfiles,
    selectedCharacterIds: [],
    selectedPromptProfileIds: [],
    writingMode: 'SINGLE_SCENE',
    plotOutline: '성채 진입',
    requiredEvents: [],
    forbiddenDevelopments: [],
  });
  assert.equal(
    ctxEmpty.activePrompts.length,
    0,
    'Explicit empty array [] MUST result in 0 activePrompts (no fallback to all active)'
  );
  assert.equal(
    ctxEmpty.referencedSources.some((r) => r.entityType === 'PROMPT_PROFILE'),
    false,
    'Explicit empty selection MUST NOT record unselected prompt profiles in referencedSources'
  );
  const assembledEmpty = assembleNovelWriterPromptInOrder({
    context: ctxEmpty,
  });
  assert.ok(
    assembledEmpty.orderedPrompt.includes('<step_4_selected_master_writing_rules>'),
    'Core Master Writing Rules safety fallback in Step 4 MUST remain intact even when activePrompts is []'
  );
  assert.ok(
    !assembledEmpty.orderedPrompt.includes(activeStyle.content),
    'Unselected style profile content MUST NOT appear in Step 5 when activePrompts is []'
  );

  // Case 3: selectedPromptProfileIds contains BOTH active, inactive, and cross-project IDs
  // ONLY active + matching project ID is allowed!
  const ctxMixedSelected = buildWritingContext({
    project,
    episode,
    allEpisodes: [episode],
    characters: [],
    worldbuilding: [],
    promptProfiles: allProfiles,
    selectedCharacterIds: [],
    selectedPromptProfileIds: [
      activeStyle.id,
      inactiveStyle.id,
      otherProjectStyle.id,
    ],
    writingMode: 'SINGLE_SCENE',
    plotOutline: '성채 진입',
    requiredEvents: [],
    forbiddenDevelopments: [],
  });
  assert.deepEqual(
    ctxMixedSelected.activePrompts.map((p) => p.profileId),
    [activeStyle.id],
    'Inactive and cross-project prompt IDs MUST be filtered out even if passed in selectedPromptProfileIds'
  );
});

test('P0-A.2: Literary Rewriting Engine (buildLiteraryRewritePrompt & rewriteLiteraryPassageOnServer) excludes inactive and cross-project PROJECT_STYLE_PROFILE from prompt and appliedPromptVersionIds', async () => {
  const { project, episode } = createBaseFixtures('proj_a');
  const anchor = {
    sourceRevisionId: 'rev_1',
    sourceContentHash: computeManuscriptContentHash(episode.content),
    startOffset: 0,
    endOffset: episode.content.length,
    originalExcerpt: episode.content,
  };

  const activeStyle = createNewPromptProfile({
    ownerId: 'author_1',
    projectId: 'proj_a',
    promptType: 'PROJECT_STYLE_PROFILE',
    title: '활성 문체',
    description: '',
    content: '활성 문체 지침: 단문 호흡',
    isActive: true,
  });

  const inactiveStyle = createNewPromptProfile({
    ownerId: 'author_1',
    projectId: 'proj_a',
    promptType: 'PROJECT_STYLE_PROFILE',
    title: '비활성 문체',
    description: '',
    content: '비활성 문체 지침: 절대 노출 금지',
    isActive: false,
  });

  const ctx = buildWritingContext({
    project,
    episode,
    allEpisodes: [episode],
    characters: [],
    worldbuilding: [],
    promptProfiles: [activeStyle, inactiveStyle],
    selectedCharacterIds: [],
    selectedPromptProfileIds: [activeStyle.id, inactiveStyle.id],
    writingMode: 'REWRITE_SELECTION',
    scenePerspective: 'THIRD_LIMITED',
    plotOutline: '리라이팅',
    requiredEvents: [],
    forbiddenDevelopments: [],
  });

  // Even if a caller manually injects an inactive or cross-project entry into ctx.activePrompts:
  const poisonedCtx = {
    ...ctx,
    activePrompts: [
      ...ctx.activePrompts,
      {
        profileId: inactiveStyle.id,
        promptType: inactiveStyle.promptType,
        title: inactiveStyle.title,
        versionId: inactiveStyle.currentVersionId,
        versionNumber: inactiveStyle.currentVersionNumber,
        content: inactiveStyle.content,
        isActive: false,
        projectId: 'proj_a',
      },
      {
        profileId: 'cross_proj_id',
        promptType: 'PROJECT_STYLE_PROFILE' as const,
        title: '타 작품 문체',
        versionId: 'pver_cross_99',
        versionNumber: 1,
        content: '타 작품 침투 문체',
        isActive: true,
        projectId: 'proj_other',
      },
    ],
  };

  const filtered = filterEligibleActivePromptsForContext(
    poisonedCtx.activePrompts,
    'proj_a'
  );
  assert.deepEqual(
    filtered.map((p) => p.profileId),
    [activeStyle.id]
  );

  const builtPrompt = buildLiteraryRewritePrompt({
    request: {
      projectId: 'proj_a',
      episodeId: episode.id,
      sourceRevisionId: 'rev_1',
      manuscript: episode.content,
      anchor,
      modes: ['R1'],
      context: poisonedCtx,
    },
  });
  assert.equal(
    builtPrompt.appliedPromptVersionIds.includes(activeStyle.currentVersionId),
    true
  );
  assert.equal(
    builtPrompt.appliedPromptVersionIds.includes(inactiveStyle.currentVersionId),
    false,
    'Inactive style versionId MUST NOT appear in appliedPromptVersionIds'
  );
  assert.equal(
    builtPrompt.appliedPromptVersionIds.includes('pver_cross_99'),
    false,
    'Cross-project style versionId MUST NOT appear in appliedPromptVersionIds'
  );
  assert.equal(
    builtPrompt.userPrompt.includes('절대 노출 금지'),
    false,
    'Inactive style content MUST NOT appear in rewrite userPrompt'
  );

  setCustomLiteraryRewriterForTesting(async ({ userPrompt }) => {
    assert.ok(userPrompt.includes(activeStyle.content));
    assert.equal(userPrompt.includes(inactiveStyle.content), false);
    assert.equal(userPrompt.includes('타 작품 침투 문체'), false);
    return {
      rawAiOutput: {
        decision: 'NO_OP_OPTIMAL',
        appliedModes: ['R1'],
        rewrittenExcerpt: episode.content,
        changeRationale: '기존 문체 호흡을 유지합니다.',
        preservedElements: ['기존 본문'],
        noOpReason: '추가 수정이 필요하지 않습니다.',
        canonConflictAlerts: [],
        perspectiveCheck: {
          expectedPerspective: 'THIRD_LIMITED',
          maintained: true,
          note: '기존 시점 유지',
        },
        characterVoiceNotes: [],
        candidateLoreProposals: [],
      },
    };
  });
  try {
    const serverRes = await rewriteLiteraryPassageOnServer(
      {
        ownerId: 'author_1',
        projectId: 'proj_a',
        episodeId: episode.id,
        sourceRevisionId: 'rev_1',
        manuscript: episode.content,
        anchor,
        modes: ['R1'],
        context: poisonedCtx,
      },
      { isIsolatedUnitTestMode: true }
    );
    assert.equal(serverRes.executionStatus, 'NO_OP_OPTIMAL', serverRes.errorMessage);
    assert.ok(serverRes.candidate);
    assert.equal(
      serverRes.candidate.appliedPromptVersionIds.includes(activeStyle.currentVersionId),
      true
    );
    assert.equal(
      serverRes.candidate.appliedPromptVersionIds.includes(inactiveStyle.currentVersionId),
      false
    );
    assert.equal(
      serverRes.candidate.appliedPromptVersionIds.includes('pver_cross_99'),
      false
    );
  } finally {
    setCustomLiteraryRewriterForTesting(null);
  }
});

// ============================================================================
// 2. P0-A2: Novel Writer Prompt Selection Sync State Machine
// ============================================================================

test('P0-A2: computeStylePromptSelectionSync handles project switches, newly approved active/inactive profiles, deleted profiles, and explicit deselection', () => {
  const { initialPrompts } = createBaseFixtures('proj_a');
  const corePrompt = initialPrompts[0];

  // Initial mount for proj_a
  const step1 = computeStylePromptSelectionSync({
    projectId: 'proj_a',
    previousProjectId: null,
    promptProfiles: initialPrompts,
    previousSelectedIds: [],
    previousKnownIds: [],
    hasExplicitEmptySelection: false,
    explicitDeselectedIds: [],
  });
  assert.equal(step1.selectedIds.includes(corePrompt.id), true);

  // Author approves a NEW active style profile -> automatically joins selectedIds
  const approvedActiveStyle = createNewPromptProfile({
    ownerId: 'author_1',
    projectId: 'proj_a',
    promptType: 'PROJECT_STYLE_PROFILE',
    title: '신규 승인 활성 문체',
    description: '',
    content: '규칙 1',
    isActive: true,
  });
  const step2 = computeStylePromptSelectionSync({
    projectId: 'proj_a',
    previousProjectId: step1.projectId,
    promptProfiles: [...initialPrompts, approvedActiveStyle],
    previousSelectedIds: step1.selectedIds,
    previousKnownIds: step1.knownIds,
    hasExplicitEmptySelection: step1.hasExplicitEmptySelection,
    explicitDeselectedIds: step1.explicitDeselectedIds,
  });
  assert.equal(
    step2.selectedIds.includes(approvedActiveStyle.id),
    true,
    'Newly approved active style profile MUST automatically appear in Writer selection'
  );

  // Author approves a NEW inactive style profile -> MUST NOT be selected
  const approvedInactiveStyle = createNewPromptProfile({
    ownerId: 'author_1',
    projectId: 'proj_a',
    promptType: 'PROJECT_STYLE_PROFILE',
    title: '신규 승인 비활성 문체',
    description: '',
    content: '규칙 2',
    isActive: false,
  });
  const step3 = computeStylePromptSelectionSync({
    projectId: 'proj_a',
    previousProjectId: step2.projectId,
    promptProfiles: [
      ...initialPrompts,
      approvedActiveStyle,
      approvedInactiveStyle,
    ],
    previousSelectedIds: step2.selectedIds,
    previousKnownIds: step2.knownIds,
    hasExplicitEmptySelection: step2.hasExplicitEmptySelection,
    explicitDeselectedIds: step2.explicitDeselectedIds,
  });
  assert.equal(
    step3.selectedIds.includes(approvedInactiveStyle.id),
    false,
    'Newly approved inactive style profile MUST NOT be selected'
  );

  // Author toggles approvedActiveStyle to isActive: false in Prompt Manager -> immediately removed from selectedIds
  const deactivatedStyle = { ...approvedActiveStyle, isActive: false };
  const step4 = computeStylePromptSelectionSync({
    projectId: 'proj_a',
    previousProjectId: step3.projectId,
    promptProfiles: [...initialPrompts, deactivatedStyle, approvedInactiveStyle],
    previousSelectedIds: step3.selectedIds,
    previousKnownIds: step3.knownIds,
    hasExplicitEmptySelection: step3.hasExplicitEmptySelection,
    explicitDeselectedIds: step3.explicitDeselectedIds,
  });
  assert.equal(
    step4.selectedIds.includes(approvedActiveStyle.id),
    false,
    'Deactivated style profile MUST be immediately removed from selectedIds'
  );

  // Switching project to proj_b resets selection to proj_b active profiles only
  const projBPrompts = createInitialPromptProfiles(
    'author_1',
    'proj_b',
    '2026-11-22T12:00:00.000Z'
  );
  const step5 = computeStylePromptSelectionSync({
    projectId: 'proj_b',
    previousProjectId: 'proj_a',
    promptProfiles: [...initialPrompts, ...projBPrompts],
    previousSelectedIds: step4.selectedIds,
    previousKnownIds: step4.knownIds,
    hasExplicitEmptySelection: false,
    explicitDeselectedIds: [],
  });
  assert.equal(
    step5.selectedIds.every((id) =>
      projBPrompts.some((p) => p.id === id)
    ),
    true,
    'Project switch MUST isolate selection to the new project'
  );
});

// ============================================================================
// 3. P0-B: PromptProfile Version CAS (Concurrent Updates, Missing Doc, Restore)
// ============================================================================

test('P0-B: updatePromptProfileWithCasCore enforces CAS on concurrent v2 -> v3 updates, preserves full version history, and rejects missing docs or tenant mismatch', async () => {
  const v1 = createNewPromptProfile({
    ownerId: 'author_1',
    projectId: 'proj_a',
    promptType: 'PROJECT_STYLE_PROFILE',
    title: '문체 프로필 v1',
    description: '초기 버전',
    content: 'v1 본문',
    isActive: true,
  });
  const v2 = updatePromptProfileContent(v1, {
    content: 'v2 본문',
    versionLabel: 'v2 업데이트',
  });

  // Simulated atomic single-doc transactional store
  let remoteDoc: PromptProfile | null = v2;
  let txChain = Promise.resolve();
  const runSerializedCas = (
    nextProfile: PromptProfile,
    expectedVersionId: string,
    expectedVersionNumber: number,
    callerUid = 'author_1',
    callerProjectId = 'proj_a'
  ) => {
    const op = txChain.then(async () => {
      try {
        return await updatePromptProfileWithCasCore({
          uid: callerUid,
          projectId: callerProjectId,
          nextProfile,
          expectedVersionId,
          expectedVersionNumber,
          storageMode: 'CLOUD_FIRESTORE',
          getRemoteProfileInTx: async () =>
            remoteDoc ? structuredClone(remoteDoc) : null,
          writeProfileInTx: async (committed) => {
            remoteDoc = structuredClone(committed);
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status =
          err && typeof err === 'object' && 'status' in err
            ? (err as { status: PromptProfileCasResult['status'] }).status
            : 'VERSION_CONFLICT';
        return {
          committed: false,
          status,
          storageMode: 'CLOUD_FIRESTORE' as const,
          profile: remoteDoc || nextProfile,
          remoteProfile: remoteDoc || undefined,
          errorMessage: message,
        };
      }
    });
    txChain = op.then(
      () => undefined,
      () => undefined
    );
    return op;
  };

  type PromptProfileCasResult = Awaited<
    ReturnType<typeof updatePromptProfileWithCasCore>
  >;

  // Two tabs concurrently edit v2 -> v3
  const tabAEdit = updatePromptProfileContent(v2, {
    content: 'Tab A v3 본문',
    versionLabel: 'Tab A 수정',
  });
  const tabBEdit = updatePromptProfileContent(v2, {
    content: 'Tab B v3 본문',
    versionLabel: 'Tab B 수정',
  });

  const [resA, resB] = await Promise.all([
    runSerializedCas(tabAEdit, v2.currentVersionId, v2.currentVersionNumber),
    runSerializedCas(tabBEdit, v2.currentVersionId, v2.currentVersionNumber),
  ]);

  assert.equal(
    (resA.committed ? 1 : 0) + (resB.committed ? 1 : 0),
    1,
    'Exactly one tab MUST succeed in v2 -> v3 CAS race'
  );
  const loser = resA.committed ? resB : resA;
  assert.equal(loser.status, 'VERSION_CONFLICT');
  assert.ok(remoteDoc);
  assert.equal(remoteDoc.currentVersionNumber, 3);
  assert.equal(
    remoteDoc.versions.length,
    3,
    'v1, v2, and winning v3 MUST all be preserved in versions array'
  );

  // Version restore via CAS preserves v1, v2, v3 and creates v4
  const restoredAsV4 = restorePromptProfileToVersion(
    remoteDoc,
    v1.currentVersionId
  );
  const resRestore = await runSerializedCas(
    restoredAsV4,
    remoteDoc.currentVersionId,
    remoteDoc.currentVersionNumber
  );
  assert.equal(resRestore.committed, true);
  assert.equal(remoteDoc.currentVersionNumber, 4);
  assert.equal(remoteDoc.versions.length, 4);

  // Cross-owner and cross-project attempts MUST be rejected
  const crossOwnerRes = await runSerializedCas(
    restoredAsV4,
    remoteDoc.currentVersionId,
    remoteDoc.currentVersionNumber,
    'intruder_uid',
    'proj_a'
  );
  assert.equal(crossOwnerRes.committed, false);
  assert.equal(crossOwnerRes.status, 'PERMISSION_DENIED');

  const crossProjectRes = await runSerializedCas(
    restoredAsV4,
    remoteDoc.currentVersionId,
    remoteDoc.currentVersionNumber,
    'author_1',
    'proj_other'
  );
  assert.equal(crossProjectRes.committed, false);
  assert.equal(crossProjectRes.status, 'TENANT_ISOLATION');

  // Missing document MUST be rejected with NOT_FOUND
  remoteDoc = null;
  const missingRes = await runSerializedCas(
    restoredAsV4,
    'pver_1',
    1
  );
  assert.equal(missingRes.committed, false);
  assert.equal(missingRes.status, 'NOT_FOUND');
});

// ============================================================================
// 4. P0-C & P0-D: Atomic StyleProfile + PromptProfile Transaction Core (E9-A..E9-J)
// ============================================================================

test('StyleProfile Firestore parsing preserves canonical and legacy statuses and defaults malformed values to DRAFT', () => {
  for (const [storedStatus, expectedStatus] of [
    ['CANON', 'CANON'],
    ['PROPOSED', 'PROPOSED'],
    ['REJECTED', 'REJECTED'],
    ['ARCHIVED', 'ARCHIVED'],
    ['DRAFT', 'DRAFT'],
    ['confirmed', 'CANON'],
    ['draft', 'DRAFT'],
    [undefined, 'DRAFT'],
    [null, 'DRAFT'],
    ['invalid', 'DRAFT'],
    [42, 'DRAFT'],
    [{ toString: () => 'CANON' }, 'DRAFT'],
  ] as const) {
    const profile = parseStyleProfileFromFirestoreData(
      'style_1',
      { canonStatus: storedStatus },
      'author_1',
      'proj_a'
    );
    assert.equal(profile.canonStatus, expectedStatus);
  }
});

test('P0-C & P0-D (E9-A..E9-J): persistApprovedStyleDnaAtomicallyCore guarantees all-or-nothing atomic commit, rolls back on 2nd write failure, blocks concurrent overwrite, deduplicates retries, and preserves UI draft on failure', async () => {
  const styleStore = new Map<string, StyleProfile>();
  const promptStore = new Map<string, PromptProfile>();

  const { candidate: candidate1 } = await analyzeAuthorStyleOnServer({
    useGeminiStage2: false,
    projectId: 'proj_a',
    inputMode: 'AUTHOR_SUPPLIED_SAMPLE',
    sampleText: AUTHOR_STYLE_BENCHMARKS[0].sampleText,
    sampleLabel: 'Sample 1',
  });
  const instructions1 = buildDefaultSelectedStyleInstructions(candidate1);

  let txLock = Promise.resolve();
  const runAtomicTx = (
    payload: Parameters<typeof persistApprovedStyleDnaAtomicallyCore>[0]['payload'],
    options?: Parameters<typeof persistApprovedStyleDnaAtomicallyCore>[0]['options'],
    uid = 'author_1',
    projectId = 'proj_a'
  ) => {
    const op = txLock.then(async () => {
      // Snapshot before transaction for atomic rollback if writeDocsInTx throws
      const styleSnapshot = new Map(styleStore);
      const promptSnapshot = new Map(promptStore);
      const res = await persistApprovedStyleDnaAtomicallyCore({
        uid,
        projectId,
        payload,
        storageMode: 'CLOUD_FIRESTORE',
        options,
        readDocsInTx: async ({ styleProfileId, promptProfileId }) => ({
          existingStyleProfile: styleStore.get(styleProfileId)
            ? structuredClone(styleStore.get(styleProfileId)!)
            : null,
          existingPromptProfile: promptStore.get(promptProfileId)
            ? structuredClone(promptStore.get(promptProfileId)!)
            : null,
        }),
        writeDocsInTx: async ({ styleProfile, promptProfile }) => {
          // 1st write: styleProfile
          styleStore.set(styleProfile.id, structuredClone(styleProfile));
          // Simulate 2nd write failure (E9-B)
          if (options?.simulateSecondWriteFailureForTest) {
            styleStore.clear();
            for (const [k, v] of styleSnapshot) styleStore.set(k, v);
            promptStore.clear();
            for (const [k, v] of promptSnapshot) promptStore.set(k, v);
            throw new Error(
              'Simulated 2nd document (PROJECT_STYLE_PROFILE) write failure'
            );
          }
          // 2nd write: promptProfile
          promptStore.set(promptProfile.id, structuredClone(promptProfile));
        },
      });
      if (res.persistenceStatus !== 'COMMITTED') {
        styleStore.clear();
        for (const [k, v] of styleSnapshot) styleStore.set(k, v);
        promptStore.clear();
        for (const [k, v] of promptSnapshot) promptStore.set(k, v);
      }
      return res;
    });
    txLock = op.then(
      () => undefined,
      () => undefined
    );
    return op;
  };

  // E9-A: Both documents created atomically
  const e9a = await runAtomicTx(
    {
      ownerId: 'author_1',
      projectId: 'proj_a',
      candidate: candidate1,
      profileTitle: '카엘 액션 문체 v1',
      selectedInstructions: instructions1,
      createNewProfileInsteadOfOverwrite: true,
      activateOnApprove: true,
    },
    {
      forcedStyleProfileId: 'style_1',
      forcedPromptProfileId: 'prompt_1',
      nowIso: '2026-11-22T12:00:00.000Z',
    }
  );
  assert.equal(e9a.approved, true);
  assert.equal(e9a.persistenceStatus, 'COMMITTED');
  assert.equal(styleStore.has('style_1'), true);
  assert.equal(promptStore.has('prompt_1'), true);
  assert.equal(promptStore.get('prompt_1')?.currentVersionNumber, 1);

  // Idempotent retry of the exact same create request does NOT duplicate version or fail
  const e9aRetry = await runAtomicTx(
    {
      ownerId: 'author_1',
      projectId: 'proj_a',
      candidate: candidate1,
      profileTitle: '카엘 액션 문체 v1',
      selectedInstructions: instructions1,
      createNewProfileInsteadOfOverwrite: true,
      activateOnApprove: true,
    },
    {
      forcedStyleProfileId: 'style_1',
      forcedPromptProfileId: 'prompt_1',
      nowIso: '2026-11-22T12:01:00.000Z',
    }
  );
  assert.equal(e9aRetry.approved, true, e9aRetry.errorMessage);
  assert.equal(e9aRetry.persistenceStatus, 'COMMITTED');
  assert.equal(e9aRetry.deduplicated, true);
  assert.equal(promptStore.get('prompt_1')?.currentVersionNumber, 1);
  assert.equal(
    promptStore.get('prompt_1')?.updatedAt,
    '2026-11-22T12:00:00.000Z',
    'A later retry MUST preserve the original committed timestamp'
  );

  // A changed activation flag is a different create request, even with the same sample.
  const changedCreate = await runAtomicTx(
    {
      ownerId: 'author_1',
      projectId: 'proj_a',
      candidate: candidate1,
      profileTitle: '카엘 액션 문체 v1',
      selectedInstructions: instructions1,
      createNewProfileInsteadOfOverwrite: true,
      activateOnApprove: false,
    },
    {
      forcedStyleProfileId: 'style_1',
      forcedPromptProfileId: 'prompt_1',
      nowIso: '2026-11-22T12:02:00.000Z',
    }
  );
  assert.equal(changedCreate.persistenceStatus, 'VERSION_CONFLICT');
  assert.equal(promptStore.get('prompt_1')?.isActive, true);

  // E9-B: 2nd document failure -> 0 documents created, approved: false, NOT_COMMITTED
  const e9b = await runAtomicTx(
    {
      ownerId: 'author_1',
      projectId: 'proj_a',
      candidate: candidate1,
      profileTitle: '롤백 테스트 문체',
      selectedInstructions: instructions1,
      createNewProfileInsteadOfOverwrite: true,
      activateOnApprove: true,
    },
    {
      forcedStyleProfileId: 'style_fail_rollback',
      forcedPromptProfileId: 'prompt_fail_rollback',
      simulateSecondWriteFailureForTest: true,
    }
  );
  assert.equal(e9b.approved, false);
  assert.equal(e9b.persistenceStatus, 'NOT_COMMITTED');
  assert.equal(e9b.styleProfileSaved, false);
  assert.equal(e9b.promptProfileSaved, false);
  assert.equal(
    styleStore.has('style_fail_rollback'),
    false,
    'E9-B: StyleProfile MUST NOT remain stored when PromptProfile write fails'
  );
  assert.equal(promptStore.has('prompt_fail_rollback'), false);

  // E9-C & E9-D: Concurrent update on existing prompt_1 (v1 -> v2)
  const v1Snap = promptStore.get('prompt_1')!;
  const { candidate: candidate2 } = await analyzeAuthorStyleOnServer({
    useGeminiStage2: false,
    projectId: 'proj_a',
    inputMode: 'AUTHOR_SUPPLIED_SAMPLE',
    sampleText: AUTHOR_STYLE_BENCHMARKS[1].sampleText,
    sampleLabel: 'Sample 2',
  });
  const { candidate: candidate3 } = await analyzeAuthorStyleOnServer({
    useGeminiStage2: false,
    projectId: 'proj_a',
    inputMode: 'AUTHOR_SUPPLIED_SAMPLE',
    sampleText: AUTHOR_STYLE_BENCHMARKS[2].sampleText,
    sampleLabel: 'Sample 3',
  });

  const [race1, race2] = await Promise.all([
    runAtomicTx({
      ownerId: 'author_1',
      projectId: 'proj_a',
      candidate: candidate2,
      profileTitle: '카엘 심리 문체 v2 (Tab 1)',
      selectedInstructions: buildDefaultSelectedStyleInstructions(candidate2),
      existingStyleProfileId: 'style_1',
      targetPromptProfileId: 'prompt_1',
      expectedBaseVersionId: v1Snap.currentVersionId,
      expectedBaseVersionNumber: v1Snap.currentVersionNumber,
      createNewProfileInsteadOfOverwrite: false,
      activateOnApprove: true,
    }),
    runAtomicTx({
      ownerId: 'author_1',
      projectId: 'proj_a',
      candidate: candidate3,
      profileTitle: '카엘 대화 문체 v2 (Tab 2)',
      selectedInstructions: buildDefaultSelectedStyleInstructions(candidate3),
      existingStyleProfileId: 'style_1',
      targetPromptProfileId: 'prompt_1',
      expectedBaseVersionId: v1Snap.currentVersionId,
      expectedBaseVersionNumber: v1Snap.currentVersionNumber,
      createNewProfileInsteadOfOverwrite: false,
      activateOnApprove: true,
    }),
  ]);

  assert.equal(
    (race1.persistenceStatus === 'COMMITTED' ? 1 : 0) +
      (race2.persistenceStatus === 'COMMITTED' ? 1 : 0),
    1
  );
  assert.equal(
    (race1.persistenceStatus === 'VERSION_CONFLICT' ? 1 : 0) +
      (race2.persistenceStatus === 'VERSION_CONFLICT' ? 1 : 0),
    1
  );
  assert.equal(promptStore.get('prompt_1')?.currentVersionNumber, 2);
  assert.equal(promptStore.get('prompt_1')?.versions.length, 2);

  const committedBeforeRetry = structuredClone(promptStore.get('prompt_1')!);
  const updateRetry = await runAtomicTx(
    {
      ownerId: 'author_1',
      projectId: 'proj_a',
      candidate: candidate2,
      profileTitle: '카엘 심리 문체 v2 (Tab 1)',
      selectedInstructions: buildDefaultSelectedStyleInstructions(candidate2),
      existingStyleProfileId: 'style_1',
      targetPromptProfileId: 'prompt_1',
      expectedBaseVersionId: v1Snap.currentVersionId,
      expectedBaseVersionNumber: v1Snap.currentVersionNumber,
      createNewProfileInsteadOfOverwrite: false,
      activateOnApprove: true,
    },
    { nowIso: '2026-11-23T12:00:00.000Z' }
  );
  assert.equal(race1.persistenceStatus, 'COMMITTED');
  assert.equal(updateRetry.persistenceStatus, 'COMMITTED', updateRetry.errorMessage);
  assert.equal(updateRetry.deduplicated, true);
  assert.deepEqual(promptStore.get('prompt_1'), committedBeforeRetry);

  // E9-H: Cross-owner and cross-project rejection
  const crossOwner = await runAtomicTx(
    {
      ownerId: 'author_1',
      projectId: 'proj_a',
      candidate: candidate1,
      profileTitle: '침입 시도',
      selectedInstructions: instructions1,
      existingStyleProfileId: 'style_1',
      targetPromptProfileId: 'prompt_1',
      expectedBaseVersionId: promptStore.get('prompt_1')!.currentVersionId,
      expectedBaseVersionNumber:
        promptStore.get('prompt_1')!.currentVersionNumber,
      createNewProfileInsteadOfOverwrite: false,
      activateOnApprove: true,
    },
    undefined,
    'intruder_99',
    'proj_a'
  );
  assert.equal(crossOwner.approved, false);
  assert.equal(crossOwner.persistenceStatus, 'PERMISSION_DENIED');

  // E9-I: Concurrent create with same ID but different content does NOT overwrite
  const e9i = await runAtomicTx(
    {
      ownerId: 'author_1',
      projectId: 'proj_a',
      candidate: candidate3,
      profileTitle: '동일 ID 덮어쓰기 시도',
      selectedInstructions: buildDefaultSelectedStyleInstructions(candidate3),
      createNewProfileInsteadOfOverwrite: true,
      activateOnApprove: true,
    },
    {
      forcedStyleProfileId: 'style_new_collision',
      forcedPromptProfileId: 'prompt_1',
    }
  );
  assert.equal(e9i.approved, false);
  assert.equal(e9i.persistenceStatus, 'VERSION_CONFLICT');
  assert.equal(
    styleStore.has('style_new_collision'),
    false,
    'E9-I: StyleProfile MUST NOT be created when PromptProfile ID conflicts'
  );

  // E9-J: UI State Transition verification on failure and conflict
  const priorStyles = Array.from(styleStore.values());
  const priorPrompts = Array.from(promptStore.values());
  const uiFailed = evaluateStyleApprovalUiTransition({
    previousStyleProfiles: priorStyles,
    previousPromptProfiles: priorPrompts,
    draftTitle: '보존되어야 할 작가 초안 제목',
    draftInstructions: instructions1,
    previousTargetPromptProfileId: 'prompt_1',
    result: e9b,
  });
  assert.equal(uiFailed.showSuccessBanner, false);
  assert.equal(uiFailed.showErrorBanner, true);
  assert.equal(uiFailed.activatedInWriter, false);
  assert.deepEqual(uiFailed.committedPromptProfiles, priorPrompts);
  assert.equal(uiFailed.preservedDraftTitle, '보존되어야 할 작가 초안 제목');
  assert.equal(uiFailed.preservedDraftInstructions.length, instructions1.length);
});
