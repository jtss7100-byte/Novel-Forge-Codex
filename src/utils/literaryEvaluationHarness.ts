import type {
  BlindAbPairItem,
  BlindAbPreference,
  LiteraryEvaluationCaseResult,
} from '../types/literaryRewriting';
import { computeStableIdempotencyHash } from './literaryRewritingLogic';
import { LITERARY_REWRITING_BENCHMARKS } from './literaryRewritingBenchmark';

export interface LiveEvalConfigValidationInput {
  runLiveFlag?: string;
  geminiApiKey?: string;
  maxCalls?: number;
  maxCharsPerExcerpt?: number;
}

export interface LiveEvalConfigValidationResult {
  enabled: boolean;
  maxCalls: number;
  maxCharsPerExcerpt: number;
  disabledReason?: string;
}

export function randomizeBlindSides(seed: string, caseId: string, index: number) {
  const hash = computeStableIdempotencyHash(`${seed}|${caseId}|${index}`);
  return { hash, flip: parseInt(hash.slice(0, 2), 16) % 2 === 1 };
}

export const DEFAULT_LIVE_EVAL_MAX_CALLS = 8;
export const HARD_CAP_LIVE_EVAL_MAX_CALLS = 16;
export const DEFAULT_MAX_CHARS_PER_EXCERPT = 1500;

/**
 * Safeguard ensuring CI & normal tests NEVER invoke live Gemini API calls
 * unless explicitly opted in via `RUN_LIVE_GEMINI_EVAL=true` with a valid key.
 */
export function validateLiveEvalConfig(
  input: LiveEvalConfigValidationInput
): LiveEvalConfigValidationResult {
  const maxCallsRequested =
    typeof input.maxCalls === 'number' && Number.isFinite(input.maxCalls)
      ? Math.max(1, Math.floor(input.maxCalls))
      : DEFAULT_LIVE_EVAL_MAX_CALLS;
  const maxCalls = Math.min(maxCallsRequested, HARD_CAP_LIVE_EVAL_MAX_CALLS);

  const maxCharsRequested =
    typeof input.maxCharsPerExcerpt === 'number' &&
    Number.isFinite(input.maxCharsPerExcerpt)
      ? Math.max(100, Math.floor(input.maxCharsPerExcerpt))
      : DEFAULT_MAX_CHARS_PER_EXCERPT;
  const maxCharsPerExcerpt = Math.min(maxCharsRequested, 4000);

  if ((input.runLiveFlag || '').trim().toLowerCase() !== 'true') {
    return {
      enabled: false,
      maxCalls,
      maxCharsPerExcerpt,
      disabledReason:
        'RUN_LIVE_GEMINI_EVAL=true 환경 변수가 설정되지 않아 라이브 Gemini 평가가 비활성화(DISABLED)되어 있습니다.',
    };
  }

  if (!(input.geminiApiKey || '').trim()) {
    return {
      enabled: false,
      maxCalls,
      maxCharsPerExcerpt,
      disabledReason:
        'GEMINI_API_KEY가 없어 라이브 Gemini 평가를 실행할 수 없습니다.',
    };
  }

  return {
    enabled: true,
    maxCalls,
    maxCharsPerExcerpt,
  };
}

/**
 * Generates randomized Blind A/B comparison pairs from evaluation results.
 * Human ratings ALWAYS default to `'NOT_RATED'` and are NEVER fabricated.
 */
export function generateBlindAbPairs(params: {
  results: LiteraryEvaluationCaseResult[];
  seed?: string;
}): BlindAbPairItem[] {
  const baseSeed = params.seed || 'novelforge_blind_ab_seed_v2';
  const benchmarkMap = new Map(
    LITERARY_REWRITING_BENCHMARKS.map((b) => [b.id, b])
  );

  return params.results
    .filter(
      (r) =>
        r.executionStatus === 'CANDIDATE_READY' ||
        r.executionStatus === 'NO_OP_OPTIMAL'
    )
    .map((res, idx) => {
      const bench = benchmarkMap.get(
        res.caseId as (typeof LITERARY_REWRITING_BENCHMARKS)[number]['id']
      );
      const manuscript = bench?.manuscript || '';
      const excerptOffset = manuscript.indexOf(res.originalExcerpt);
      const precedingContext =
        excerptOffset > 0
          ? manuscript.slice(Math.max(0, excerptOffset - 180), excerptOffset)
          : '';
      const followingContext =
        excerptOffset >= 0
          ? manuscript.slice(
              excerptOffset + res.originalExcerpt.length,
              excerptOffset + res.originalExcerpt.length + 180
            )
          : '';

      const { hash: hashHex, flip } = randomizeBlindSides(baseSeed, res.caseId, idx);

      const hiddenSideAssignment: BlindAbPairItem['hiddenSideAssignment'] = flip
        ? 'A_REWRITE_B_ORIGINAL'
        : 'A_ORIGINAL_B_REWRITE';

      return {
        pairId: `ab_${res.caseId}_${hashHex.slice(0, 8)}`,
        caseId: res.caseId,
        titleKo: res.titleKo,
        categoryKo: res.categoryKo,
        precedingContext,
        followingContext,
        optionA: flip ? res.rewrittenExcerpt : res.originalExcerpt,
        optionB: flip ? res.originalExcerpt : res.rewrittenExcerpt,
        hiddenSideAssignment,
        preference: 'NOT_RATED' as BlindAbPreference,
        reviewerComment: '',
      };
    });
}

export interface BlindAbSummaryStats {
  totalPairs: number;
  ratedCount: number;
  notRatedCount: number;
  originalPreferredCount: number;
  rewritePreferredCount: number;
  tieCount: number;
  rewriteWinRateExcludingTiesPercent: number | null;
}

/**
 * Resolves a human blind selection (`'A'` or `'B'` choice mapped onto `BlindAbPreference`)
 * back to the hidden original/rewrite ground truth cleanly.
 */
export function resolveBlindChoiceToPreference(params: {
  choice: 'A' | 'B' | 'TIE' | 'NOT_RATED';
  hiddenSideAssignment: BlindAbPairItem['hiddenSideAssignment'];
}): BlindAbPreference {
  if (params.choice === 'NOT_RATED' || params.choice === 'TIE') {
    return params.choice;
  }
  if (params.hiddenSideAssignment === 'A_ORIGINAL_B_REWRITE') {
    return params.choice === 'A' ? 'ORIGINAL_PREFERRED' : 'REWRITE_PREFERRED';
  }
  return params.choice === 'A' ? 'REWRITE_PREFERRED' : 'ORIGINAL_PREFERRED';
}

export function summarizeBlindAbRatings(
  pairs: Pick<BlindAbPairItem, 'preference'>[]
): BlindAbSummaryStats {
  let originalPreferredCount = 0;
  let rewritePreferredCount = 0;
  let tieCount = 0;
  let notRatedCount = 0;

  for (const pair of pairs) {
    switch (pair.preference) {
      case 'ORIGINAL_PREFERRED':
        originalPreferredCount += 1;
        break;
      case 'REWRITE_PREFERRED':
        rewritePreferredCount += 1;
        break;
      case 'TIE':
        tieCount += 1;
        break;
      case 'NOT_RATED':
      default:
        notRatedCount += 1;
        break;
    }
  }

  const ratedCount = originalPreferredCount + rewritePreferredCount + tieCount;
  const decisiveCount = originalPreferredCount + rewritePreferredCount;
  const rewriteWinRateExcludingTiesPercent =
    decisiveCount > 0
      ? Math.round((rewritePreferredCount / decisiveCount) * 100)
      : null;

  return {
    totalPairs: pairs.length,
    ratedCount,
    notRatedCount,
    originalPreferredCount,
    rewritePreferredCount,
    tieCount,
    rewriteWinRateExcludingTiesPercent,
  };
}
