import type { WritingContextBundle } from '../types/aiEngine';
import type {
  LiteraryEvaluationCaseResult,
  LiveEvaluationRunReport,
} from '../types/literaryRewriting';
import {
  buildAnchorForBenchmark,
  LITERARY_REWRITING_BENCHMARKS,
  type LiteraryRewritingBenchmarkFixture,
} from '../utils/literaryRewritingBenchmark';
import { createEmptyUsageMetadata } from '../utils/literaryQualityLogic';
import {
  generateBlindAbPairs,
  validateLiveEvalConfig,
} from '../utils/literaryEvaluationHarness';
import { generateEntityId } from '../utils/novelLogic';
import type { AuthoritativeProjectCanonSnapshot } from './canonEvidenceGate.ts';
import {
  rewriteLiteraryPassageOnServer,
  setCustomLiteraryRewriterForTesting,
} from './literaryRewritingEngine.ts';

export interface RunLiteraryEvaluationOptions {
  dryRunWithFixtures?: boolean;
  maxCalls?: number;
  maxCharsPerExcerpt?: number;
  blindSeed?: string;
  runLiveEnvFlag?: string;
  geminiApiKey?: string;
}

function buildSyntheticBenchmarkContext(
  fixture: LiteraryRewritingBenchmarkFixture
): WritingContextBundle {
  const baseContext: WritingContextBundle = {
    projectId: 'proj_eval_benchmark',
    projectTitle: '에테르 성채 평가 기준선',
    projectGenre: '정통 판타지',
    projectSynopsis: '합성 문학 품질 평가 전용 픽스처 (사용자 실제 작품 데이터 미포함)',
    episodeId: `ep_eval_${fixture.id}`,
    episodeNumber: 1,
    episodeTitle: fixture.titleKo,
    writingMode: 'REWRITE_SELECTION',
    narrativePerspective: fixture.perspective,
    projectDefaultPerspective: fixture.perspective,
    pointOfViewCharacterId: 'char_kael',
    targetEpisodeCharCount: 4000,
    targetSceneCharCount: 1500,
    tolerancePercent: 15,
    plotOutline: fixture.authorInstruction,
    requiredEvents: [],
    forbiddenDevelopments: ['성채 내부 공간 이동 마법 사용 금지'],
    hasGameSystemInWorldbuilding: false,
    canonCharacters: [
      {
        id: 'char_kael',
        name: '카엘',
        role: '수비대장',
        affiliation: '에테르 기사단',
        personality: '과묵하고 냉철하다.',
        abilities: '에테르 검술 (왼팔 중상 상태)',
        appearance: '검은 망토',
      },
      {
        id: 'char_seraphina',
        name: '세라피나',
        role: '부사령관',
        affiliation: '에테르 기사단',
        personality: '원칙적이다.',
        abilities: '성광 결계',
        appearance: '은빛 갑주',
      },
      {
        id: 'char_garen',
        name: '가렌',
        role: '노병',
        affiliation: '성채 수비대',
        personality: '투박하고 직설적인 하오체',
        abilities: '방패술',
        appearance: '백발',
      },
      {
        id: 'char_rion',
        name: '리온',
        role: '정찰도적',
        affiliation: '유격대',
        personality: '가볍고 넉살 좋다.',
        abilities: '은신·단검',
        appearance: '가죽 조끼',
      },
    ],
    canonWorldbuilding: [
      {
        id: 'wb_aether_rule',
        title: '에테르 성채 결계 규율',
        category: '마법 제약',
        summary: '성채 내부 공간 이동 마법 금지',
        rules: '공간 이동 마법 사용 금지',
      },
    ],
    activePrompts: [],
    previousEpisodeSummary: '',
    previousEpisodeTailExcerpt: '',
    currentManuscript: fixture.manuscript,
    approvedExceptions: [],
    referencedSources: [],
    missingEvidenceNotes: [],
    retrievedMemoryChunks: [],
    ...(fixture.contextOverrides || {}),
  };
  return baseContext;
}

function buildIsolatedCanonSnapshotForContext(
  ownerId: string,
  ctx: WritingContextBundle
): AuthoritativeProjectCanonSnapshot {
  return {
    projectExists: true,
    projectOwnerId: ownerId,
    canonCharacters: ctx.canonCharacters.map((c) => ({
      id: c.id,
      ownerId,
      projectId: ctx.projectId,
      name: c.name,
      role: c.role,
      affiliation: c.affiliation,
      personality: c.personality,
      abilities: c.abilities,
      appearance: c.appearance,
      status: 'confirmed',
      canonStatus: 'CANON',
      sourceRevisionId: 'rev_bench_canon_1',
    })),
    nonCanonCharacterIds: [],
    canonWorldbuilding: ctx.canonWorldbuilding.map((w) => ({
      id: w.id,
      ownerId,
      projectId: ctx.projectId,
      title: w.title,
      category: w.category,
      summary: w.summary,
      rules: w.rules,
      status: 'confirmed',
      canonStatus: 'CANON',
      sourceRevisionId: 'rev_bench_canon_1',
    })),
    nonCanonWorldbuildingIds: [],
    canonRelationships: [],
    canonTimelineEvents: [],
    canonForeshadowings: [],
  };
}

/**
 * Runs the Literary Rewrite Quality & Blind A/B Evaluation Harness.
 *
 * Security & Cost Controls:
 * - DISABLED by default in CI and automated tests unless `dryRunWithFixtures: true` OR `RUN_LIVE_GEMINI_EVAL=true` with valid `GEMINI_API_KEY`.
 * - NEVER loads user private manuscripts and NEVER writes to production Firestore.
 */
export async function runLiteraryEvaluationHarness(
  options: RunLiteraryEvaluationOptions = {}
): Promise<LiveEvaluationRunReport> {
  const runId = generateEntityId('eval_run');
  const executedAt = new Date().toISOString();
  const dryRun = Boolean(options.dryRunWithFixtures);

  const configCheck = validateLiveEvalConfig({
    runLiveFlag: options.runLiveEnvFlag ?? process.env.RUN_LIVE_GEMINI_EVAL,
    geminiApiKey: options.geminiApiKey ?? process.env.GEMINI_API_KEY,
    maxCalls: options.maxCalls,
    maxCharsPerExcerpt: options.maxCharsPerExcerpt,
  });

  if (!dryRun && !configCheck.enabled) {
    return {
      runId,
      executionMode: 'DISABLED',
      modelId: 'NONE',
      calledGeminiCount: 0,
      maxCallsLimit: configCheck.maxCalls,
      totalEstimatedCostUsd: 0,
      totalTokens: 0,
      results: [],
      blindAbPairs: [],
      executedAt,
      disabledReason: configCheck.disabledReason,
    };
  }

  const fixtures = LITERARY_REWRITING_BENCHMARKS.slice(0, configCheck.maxCalls);
  const results: LiteraryEvaluationCaseResult[] = [];
  let calledGeminiCount = 0;
  let totalEstimatedCostUsd = 0;
  let totalTokens = 0;
  let resolvedModelId = dryRun ? 'DRY_RUN_FIXTURE' : 'gemini-3.8-flash';

  const ownerId = 'eval_synthetic_runner';

  for (const fixture of fixtures) {
    if (fixture.targetExcerpt.length > configCheck.maxCharsPerExcerpt) {
      results.push({
        caseId: fixture.id,
        titleKo: fixture.titleKo,
        categoryKo: fixture.modes.join('+'),
        executionStatus: 'REWRITE_FAILED',
        aiDecision: null,
        canonEvidenceStatus: 'UNAVAILABLE',
        hasBlockingViolation: false,
        perspectiveMaintained: true,
        rubricWarnings: [],
        originalExcerpt: fixture.targetExcerpt,
        rewrittenExcerpt: '',
        latencyMs: 0,
        usageMetadata: createEmptyUsageMetadata(),
        errorMessage: `maxCharsPerExcerpt(${configCheck.maxCharsPerExcerpt}) 상한 초과`,
      });
      continue;
    }

    const ctx = buildSyntheticBenchmarkContext(fixture);
    const anchor = buildAnchorForBenchmark(fixture, 'rev_eval_1');
    const startedAt = Date.now();

    if (dryRun) {
      setCustomLiteraryRewriterForTesting(async () => ({
        rawAiOutput: fixture.mockReferenceAiOutput,
      }));
    }

    try {
      const response = await rewriteLiteraryPassageOnServer(
        {
          ownerId,
          projectId: ctx.projectId,
          episodeId: ctx.episodeId,
          sourceRevisionId: 'rev_eval_1',
          manuscript: fixture.manuscript,
          anchor,
          modes: fixture.modes,
          authorInstruction: fixture.authorInstruction,
          context: ctx,
        },
        {
          enforceServerCanonGate: true,
          customFirestoreReader: async () =>
            buildIsolatedCanonSnapshotForContext(ownerId, ctx),
          customRagRetriever: async () => [],
        }
      );

      if (!dryRun) {
        calledGeminiCount += response.candidate?.rewriteApiCallCount ?? 1;
      }

      const usage =
        response.candidate?.usageMetadata || createEmptyUsageMetadata();
      totalTokens += usage.totalTokenCount;
      totalEstimatedCostUsd = Number(
        (totalEstimatedCostUsd + usage.estimatedCostUsd).toFixed(6)
      );
      if (!dryRun && response.candidate?.modelId) {
        resolvedModelId = response.candidate.modelId;
      }

      results.push({
        caseId: fixture.id,
        titleKo: fixture.titleKo,
        categoryKo:
          fixture.expectedDecision === 'NO_OP_OPTIMAL'
            ? 'NO_OP_OPTIMAL'
            : fixture.modes.join('+'),
        executionStatus: response.executionStatus,
        aiDecision: response.candidate?.aiDecision ?? null,
        canonEvidenceStatus:
          response.canonEvidence?.status ||
          response.candidate?.verification?.canonEvidence?.status ||
          'UNAVAILABLE',
        hasBlockingViolation:
          response.candidate?.verification?.hasBlockingViolation ?? false,
        perspectiveMaintained:
          response.candidate?.perspectiveCheck?.maintained ?? false,
        rubricWarnings:
          response.candidate?.verification?.qualityDelta?.rubricChecks
            ?.rubricWarnings || [],
        originalExcerpt: fixture.targetExcerpt,
        rewrittenExcerpt:
          response.candidate?.rewrittenExcerpt || fixture.targetExcerpt,
        latencyMs: Date.now() - startedAt,
        usageMetadata: usage,
        errorMessage: response.errorMessage,
      });
    } finally {
      if (dryRun) {
        setCustomLiteraryRewriterForTesting(null);
      }
    }
  }

  const blindAbPairs = generateBlindAbPairs({
    results,
    seed: options.blindSeed,
  });

  return {
    runId,
    executionMode: dryRun ? 'DRY_RUN_FIXTURE' : 'LIVE_GEMINI',
    modelId: resolvedModelId,
    calledGeminiCount,
    maxCallsLimit: configCheck.maxCalls,
    totalEstimatedCostUsd,
    totalTokens,
    results,
    blindAbPairs,
    executedAt,
  };
}
