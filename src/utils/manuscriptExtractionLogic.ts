import { z } from 'zod';
import type {
  CanonStatus,
  ChangeProposal,
  Character,
  CharacterRelationship,
  Episode,
  Foreshadowing,
  ForeshadowingPhase,
  Revision,
  Scene,
  TimelineEvent,
  WorldbuildingItem,
} from '../types/novel';
import type {
  AiRawExtractionCandidate,
  AiRawExtractionResponse,
  CanonConflictNotice,
  ChangeProposalPayloadEnvelope,
  DuplicateProposalStatus,
  ExcerptVerificationResult,
  ExtractedForeshadowingDraftPayload,
  ExtractedRelationshipDraftPayload,
  ExtractedTimelineEventDraftPayload,
  ExtractionActionType,
  ExtractionCandidateType,
  ExtractionUncertaintyFlag,
  ServerVerifiedExcerptSpan,
  TemporalContextType,
  VerifiedExtractionCandidate,
} from '../types/manuscriptExtraction';
import {
  createDataProvenance,
  FOUNDATION_CONSTRAINTS,
  normalizeToCanonStatus,
  validateChangeProposalInput,
} from './foundationLogic';
import { generateEntityId, isValidEntityId } from './novelLogic';

// ============================================================================
// 1. Zod Schemas for AI Extraction Response (Zero Trust on Offsets & Auth)
// ============================================================================

export const EXTRACTION_CANDIDATE_TYPES = [
  'RELATIONSHIP',
  'TIMELINE_EVENT',
  'FORESHADOWING',
] as const;

export const EXTRACTION_ACTION_TYPES = ['CREATE', 'UPDATE'] as const;

export const TEMPORAL_CONTEXT_TYPES = [
  'PRESENT_EVENT',
  'FLASHBACK',
  'PAST_MENTION',
  'PROPHECY_OR_RUMOR',
  'HYPOTHETICAL_OR_DREAM',
] as const;

export const EXTRACTION_UNCERTAINTY_FLAGS = [
  'AMBIGUOUS_CHARACTER_REFERENCE',
  'HOMONYM_CHARACTER_NAME',
  'NEW_UNREGISTERED_CHARACTER',
  'DIALOGUE_CLAIM_ONLY',
  'FLASHBACK_OR_PAST_MENTION',
  'RUMOR_OR_PROPHECY',
  'CONFLICTS_WITH_CANON',
  'TIMELINE_ORDER_UNCERTAIN',
  'CLUE_PHASE_UNCERTAIN',
] as const;

const AiRelationshipPayloadZodSchema = z
  .object({
    sourceCharacterId: z.string().nullable().optional().default(null),
    sourceCharacterName: z.string().min(1).max(120),
    targetCharacterId: z.string().nullable().optional().default(null),
    targetCharacterName: z.string().min(1).max(120),
    relationType: z.string().min(1).max(FOUNDATION_CONSTRAINTS.RELATIONSHIP.TYPE_MAX),
    affinityScore: z.number().int().min(-100).max(100),
    isDirectional: z.boolean().optional().default(true),
    description: z.string().max(FOUNDATION_CONSTRAINTS.RELATIONSHIP.DESCRIPTION_MAX).default(''),
  })
  .strip();

const AiTimelineEventPayloadZodSchema = z
  .object({
    title: z.string().min(1).max(FOUNDATION_CONSTRAINTS.TIMELINE_EVENT.TITLE_MAX),
    summary: z.string().max(FOUNDATION_CONSTRAINTS.TIMELINE_EVENT.SUMMARY_MAX).default(''),
    inUniverseDate: z.string().max(FOUNDATION_CONSTRAINTS.TIMELINE_EVENT.DATE_MAX).default(''),
    chronologicalOrder: z
      .number()
      .int()
      .min(FOUNDATION_CONSTRAINTS.TIMELINE_EVENT.ORDER_MIN)
      .max(FOUNDATION_CONSTRAINTS.TIMELINE_EVENT.ORDER_MAX)
      .nullable()
      .optional()
      .default(null),
    involvedCharacterIds: z.array(z.string()).optional().default([]),
    involvedCharacterNames: z.array(z.string()).optional().default([]),
    locationWorldItemId: z.string().nullable().optional().default(null),
    locationName: z.string().nullable().optional().default(null),
  })
  .strip();

const AiForeshadowingPayloadZodSchema = z
  .object({
    title: z.string().min(1).max(FOUNDATION_CONSTRAINTS.FORESHADOWING.TITLE_MAX),
    description: z.string().max(FOUNDATION_CONSTRAINTS.FORESHADOWING.DESCRIPTION_MAX).default(''),
    cluePhase: z.enum(['PLANTED', 'REINFORCED', 'RESOLVED']).default('PLANTED'),
    relatedCharacterIds: z.array(z.string()).optional().default([]),
    relatedCharacterNames: z.array(z.string()).optional().default([]),
    relatedEventIds: z.array(z.string()).optional().default([]),
    payoffNote: z.string().max(FOUNDATION_CONSTRAINTS.FORESHADOWING.DESCRIPTION_MAX).default(''),
  })
  .strip();

/**
 * Note: .strip() ensures any unexpected fields (such as hallucinated startOffset,
 * endOffset, ownerId, projectId, or canonStatus) are discarded immediately.
 */
export const AiExtractionCandidateZodSchema = z
  .object({
    targetEntityType: z.enum(EXTRACTION_CANDIDATE_TYPES),
    proposedAction: z.enum(EXTRACTION_ACTION_TYPES),
    existingTargetEntityId: z.string().nullable().optional().default(null),
    title: z.string().min(1).max(300),
    rationale: z.string().min(1).max(3000),
    beforeSummary: z.string().max(3000).optional().default(''),
    afterSummary: z.string().max(3000).optional().default(''),
    excerpt: z.string().min(1).max(5000),
    precedingContext: z.string().max(1000).nullable().optional().default(null),
    followingContext: z.string().max(1000).nullable().optional().default(null),
    sceneId: z.string().nullable().optional().default(null),
    confidence: z.number().min(0).max(1).optional().default(0.75),
    dialogueClaimOnly: z.boolean().optional().default(false),
    temporalContextType: z.enum(TEMPORAL_CONTEXT_TYPES).optional().default('PRESENT_EVENT'),
    uncertaintyFlags: z
      .array(z.enum(EXTRACTION_UNCERTAINTY_FLAGS))
      .optional()
      .default([]),
    relationshipPayload: AiRelationshipPayloadZodSchema.nullable().optional().default(null),
    timelineEventPayload: AiTimelineEventPayloadZodSchema.nullable().optional().default(null),
    foreshadowingPayload: AiForeshadowingPayloadZodSchema.nullable().optional().default(null),
  })
  .strip();

export const AiExtractionResponseZodSchema = z
  .object({
    analysis_summary: z.string().max(4000).optional().default(''),
    candidates: z.array(AiExtractionCandidateZodSchema).max(50).default([]),
  })
  .strip();

export function parseAndSanitizeAiExtractionResponse(
  rawInput: unknown
): {
  valid: boolean;
  data?: AiRawExtractionResponse;
  error?: string;
} {
  try {
    const parsedObj =
      typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
    const result = AiExtractionResponseZodSchema.safeParse(parsedObj);
    if (!result.success) {
      const issueSummary = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return {
        valid: false,
        error: `AI 추출 응답 스키마 검증 실패: ${issueSummary}`,
      };
    }

    const sanitizedCandidates: AiRawExtractionCandidate[] = [];
    for (const candidate of result.data.candidates) {
      if (
        candidate.targetEntityType === 'RELATIONSHIP' &&
        !candidate.relationshipPayload
      ) {
        continue;
      }
      if (
        candidate.targetEntityType === 'TIMELINE_EVENT' &&
        !candidate.timelineEventPayload
      ) {
        continue;
      }
      if (
        candidate.targetEntityType === 'FORESHADOWING' &&
        !candidate.foreshadowingPayload
      ) {
        continue;
      }
      sanitizedCandidates.push({
        targetEntityType: candidate.targetEntityType,
        proposedAction: candidate.proposedAction,
        existingTargetEntityId: candidate.existingTargetEntityId ?? null,
        title: candidate.title.trim().slice(0, FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.TITLE_MAX),
        rationale: candidate.rationale
          .trim()
          .slice(0, FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.RATIONALE_MAX),
        beforeSummary: (candidate.beforeSummary || '기존 설정 없음')
          .trim()
          .slice(0, FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.SUMMARY_MAX),
        afterSummary: (candidate.afterSummary || candidate.title)
          .trim()
          .slice(0, FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.SUMMARY_MAX),
        excerpt: candidate.excerpt,
        precedingContext: candidate.precedingContext ?? null,
        followingContext: candidate.followingContext ?? null,
        sceneId: candidate.sceneId ?? null,
        confidence: Math.max(0, Math.min(1, Number(candidate.confidence ?? 0.75))),
        dialogueClaimOnly: Boolean(candidate.dialogueClaimOnly),
        temporalContextType: candidate.temporalContextType,
        uncertaintyFlags: Array.from(new Set(candidate.uncertaintyFlags)),
        relationshipPayload: candidate.relationshipPayload ?? null,
        timelineEventPayload: candidate.timelineEventPayload ?? null,
        foreshadowingPayload: candidate.foreshadowingPayload ?? null,
      });
    }

    return {
      valid: true,
      data: {
        analysis_summary: result.data.analysis_summary.trim(),
        candidates: sanitizedCandidates,
      },
    };
  } catch (err) {
    return {
      valid: false,
      error: `AI 추출 응답 JSON 파싱 오류: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

// ============================================================================
// 2. Server-Side Excerpt Verification & UTF-16 Offset Calculation
// ============================================================================

function isWhitespaceCodeUnit(charCode: number): boolean {
  return (
    charCode === 0x20 || // space
    charCode === 0x09 || // tab
    charCode === 0x0a || // LF
    charCode === 0x0d || // CR
    charCode === 0x00a0 || // NBSP
    charCode === 0x3000 // Ideographic space
  );
}

/**
 * Checks whether a UTF-16 code unit offset splits a high-surrogate and low-surrogate pair.
 */
export function isUtf16SurrogateSplit(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const prevCode = text.charCodeAt(offset - 1);
  const currCode = text.charCodeAt(offset);
  const isPrevHighSurrogate = prevCode >= 0xd800 && prevCode <= 0xdbff;
  const isCurrLowSurrogate = currCode >= 0xdc00 && currCode <= 0xdfff;
  return isPrevHighSurrogate && isCurrLowSurrogate;
}

/**
 * Normalizes ONLY whitespace sequences (CRLF, LF, tabs, multiple spaces) into single spaces,
 * trimming leading and trailing whitespace. Non-whitespace characters are never altered.
 */
export function normalizeWhitespaceOnly(text: string): string {
  let out = '';
  let inWhitespace = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isWhitespaceCodeUnit(code)) {
      if (out.length > 0) {
        inWhitespace = true;
      }
    } else {
      if (inWhitespace) {
        out += ' ';
        inWhitespace = false;
      }
      out += text[i];
    }
  }
  return out;
}

interface NormalizedIndexMap {
  normalizedText: string;
  normToOrigStart: number[];
  normToOrigEnd: number[];
}

/**
 * Builds a whitespace-normalized string along with exact UTF-16 index mapping arrays
 * back to the original text.
 */
function buildWhitespaceNormalizedIndexMap(originalText: string): NormalizedIndexMap {
  let normalizedText = '';
  const normToOrigStart: number[] = [];
  const normToOrigEnd: number[] = [];

  let i = 0;
  const len = originalText.length;

  // Skip leading whitespace
  while (i < len && isWhitespaceCodeUnit(originalText.charCodeAt(i))) {
    i++;
  }

  while (i < len) {
    const code = originalText.charCodeAt(i);
    if (isWhitespaceCodeUnit(code)) {
      const wsStart = i;
      while (i < len && isWhitespaceCodeUnit(originalText.charCodeAt(i))) {
        i++;
      }
      const wsEnd = i;
      // Only emit single space if there are remaining non-whitespace characters
      if (i < len) {
        normalizedText += ' ';
        normToOrigStart.push(wsStart);
        normToOrigEnd.push(wsEnd);
      }
    } else {
      normalizedText += originalText[i];
      normToOrigStart.push(i);
      normToOrigEnd.push(i + 1);
      i++;
    }
  }

  return { normalizedText, normToOrigStart, normToOrigEnd };
}

function findAllExactSubstringSpans(
  revisionContent: string,
  needle: string
): ServerVerifiedExcerptSpan[] {
  const spans: ServerVerifiedExcerptSpan[] = [];
  if (!needle || needle.length === 0 || !revisionContent) return spans;

  let searchFrom = 0;
  while (searchFrom <= revisionContent.length - needle.length) {
    const idx = revisionContent.indexOf(needle, searchFrom);
    if (idx === -1) break;
    const endIdx = idx + needle.length;
    if (
      !isUtf16SurrogateSplit(revisionContent, idx) &&
      !isUtf16SurrogateSplit(revisionContent, endIdx)
    ) {
      spans.push({
        startOffset: idx,
        endOffset: endIdx,
        matchedText: revisionContent.slice(idx, endIdx),
        matchMethod: 'EXACT',
      });
    }
    searchFrom = idx + 1;
  }
  return spans;
}

function findAllWhitespaceNormalizedSpans(
  revisionContent: string,
  rawExcerpt: string
): ServerVerifiedExcerptSpan[] {
  const spans: ServerVerifiedExcerptSpan[] = [];
  const normNeedle = normalizeWhitespaceOnly(rawExcerpt);
  if (!normNeedle || normNeedle.length === 0 || !revisionContent) return spans;

  const { normalizedText, normToOrigStart, normToOrigEnd } =
    buildWhitespaceNormalizedIndexMap(revisionContent);

  if (normalizedText.length < normNeedle.length) return spans;

  const seenRanges = new Set<string>();
  let searchFrom = 0;
  while (searchFrom <= normalizedText.length - normNeedle.length) {
    const normIdx = normalizedText.indexOf(normNeedle, searchFrom);
    if (normIdx === -1) break;

    const normEndIdx = normIdx + normNeedle.length - 1;
    const origStart = normToOrigStart[normIdx];
    const origEnd = normToOrigEnd[normEndIdx];

    if (
      typeof origStart === 'number' &&
      typeof origEnd === 'number' &&
      origStart >= 0 &&
      origStart < origEnd &&
      origEnd <= revisionContent.length &&
      !isUtf16SurrogateSplit(revisionContent, origStart) &&
      !isUtf16SurrogateSplit(revisionContent, origEnd)
    ) {
      const matchedSlice = revisionContent.slice(origStart, origEnd);
      // Verify strictly that only whitespace differed between matchedSlice and rawExcerpt
      if (normalizeWhitespaceOnly(matchedSlice) === normNeedle) {
        const rangeKey = `${origStart}:${origEnd}`;
        if (!seenRanges.has(rangeKey)) {
          seenRanges.add(rangeKey);
          spans.push({
            startOffset: origStart,
            endOffset: origEnd,
            matchedText: matchedSlice,
            matchMethod: 'WHITESPACE_NORMALIZED',
          });
        }
      }
    }

    searchFrom = normIdx + 1;
  }

  return spans;
}

function scoreCandidateSpanByContext(params: {
  revisionContent: string;
  span: ServerVerifiedExcerptSpan;
  precedingContext?: string | null;
  followingContext?: string | null;
  hintCharacterNames?: string[];
}): number {
  const { revisionContent, span, precedingContext, followingContext, hintCharacterNames } =
    params;
  let score = 0;

  if (precedingContext && precedingContext.trim().length > 0) {
    const cleanPre = precedingContext.trim();
    const windowLen = Math.max(300, cleanPre.length * 2);
    const beforeSlice = revisionContent.slice(
      Math.max(0, span.startOffset - windowLen),
      span.startOffset
    );
    if (beforeSlice.includes(cleanPre)) {
      score += 100;
    } else if (
      normalizeWhitespaceOnly(beforeSlice).includes(normalizeWhitespaceOnly(cleanPre))
    ) {
      score += 80;
    }
  }

  if (followingContext && followingContext.trim().length > 0) {
    const cleanFol = followingContext.trim();
    const windowLen = Math.max(300, cleanFol.length * 2);
    const afterSlice = revisionContent.slice(
      span.endOffset,
      Math.min(revisionContent.length, span.endOffset + windowLen)
    );
    if (afterSlice.includes(cleanFol)) {
      score += 100;
    } else if (
      normalizeWhitespaceOnly(afterSlice).includes(normalizeWhitespaceOnly(cleanFol))
    ) {
      score += 80;
    }
  }

  if (hintCharacterNames && hintCharacterNames.length > 0) {
    const nearbySlice = revisionContent.slice(
      Math.max(0, span.startOffset - 250),
      Math.min(revisionContent.length, span.endOffset + 250)
    );
    for (const rawName of hintCharacterNames) {
      const trimmed = rawName.trim();
      if (trimmed.length > 0 && nearbySlice.includes(trimmed)) {
        score += 10;
      }
    }
  }

  return score;
}

/**
 * Locates and verifies an AI-extracted excerpt in the authoritative Revision.content.
 * Computes UTF-16 code unit [startOffset, endOffset) strictly on the server:
 * 1. Exact substring match
 * 2. Restricted whitespace-normalized match (only when Step 1 finds 0 matches)
 * 3. Multi-match disambiguation or AMBIGUOUS_MULTIPLE_MATCHES / UNVERIFIED_EXCERPT classification
 */
export function locateAndVerifyExcerptInRevision(params: {
  revisionContent: string;
  excerpt: string;
  precedingContext?: string | null;
  followingContext?: string | null;
  hintCharacterNames?: string[];
  authorSelectedSpanOverride?: { startOffset: number; endOffset: number } | null;
}): ExcerptVerificationResult {
  const {
    revisionContent,
    excerpt,
    precedingContext,
    followingContext,
    hintCharacterNames,
    authorSelectedSpanOverride,
  } = params;

  if (!revisionContent || revisionContent.length === 0) {
    return {
      status: 'UNVERIFIED_EXCERPT',
      verifiedSpan: null,
      candidateSpans: [],
      reason: '원고 본문(Revision.content)이 비어 있어 발췌문을 검증할 수 없습니다.',
    };
  }

  if (!excerpt || excerpt.trim().length === 0) {
    return {
      status: 'UNVERIFIED_EXCERPT',
      verifiedSpan: null,
      candidateSpans: [],
      reason: '발췌문(excerpt)이 비어 있습니다.',
    };
  }

  // Step 1: Exact substring match (try raw excerpt first, then trimmed outer whitespace)
  let candidateSpans = findAllExactSubstringSpans(revisionContent, excerpt);
  if (candidateSpans.length === 0 && excerpt.trim() !== excerpt) {
    candidateSpans = findAllExactSubstringSpans(revisionContent, excerpt.trim());
  }

  // Step 2: Restricted whitespace-normalized match ONLY when Step 1 failed
  if (candidateSpans.length === 0) {
    candidateSpans = findAllWhitespaceNormalizedSpans(revisionContent, excerpt);
  }

  // Step 3: No match found -> UNVERIFIED_EXCERPT
  if (candidateSpans.length === 0) {
    return {
      status: 'UNVERIFIED_EXCERPT',
      verifiedSpan: null,
      candidateSpans: [],
      reason:
        '해당 발췌문이 저장된 리비전 원문(Revision.content)에서 발견되지 않았습니다 (임의 요약/변형 또는 원문 불일치).',
    };
  }

  // Single match -> VERIFIED
  if (candidateSpans.length === 1) {
    return {
      status: 'VERIFIED',
      verifiedSpan: candidateSpans[0],
      candidateSpans,
    };
  }

  // Multiple matches: check if author explicitly disambiguated a valid candidate span
  if (authorSelectedSpanOverride) {
    const matchedOverride = candidateSpans.find(
      (s) =>
        s.startOffset === authorSelectedSpanOverride.startOffset &&
        s.endOffset === authorSelectedSpanOverride.endOffset
    );
    if (matchedOverride) {
      return {
        status: 'VERIFIED',
        verifiedSpan: matchedOverride,
        candidateSpans,
      };
    }
  }

  // Multiple matches: attempt context disambiguation
  const scored = candidateSpans.map((span) => ({
    span,
    score: scoreCandidateSpanByContext({
      revisionContent,
      span,
      precedingContext,
      followingContext,
      hintCharacterNames,
    }),
  }));

  const maxScore = Math.max(...scored.map((s) => s.score));
  const topMatches = scored.filter((s) => s.score === maxScore);

  if (maxScore > 0 && topMatches.length === 1) {
    return {
      status: 'VERIFIED',
      verifiedSpan: topMatches[0].span,
      candidateSpans,
    };
  }

  // Still ambiguous -> AMBIGUOUS_MULTIPLE_MATCHES (do NOT pick first match blindly)
  return {
    status: 'AMBIGUOUS_MULTIPLE_MATCHES',
    verifiedSpan: null,
    candidateSpans,
    reason: `원고 내 동일한 발췌문이 ${candidateSpans.length}회 등장하며 주변 문맥만으로 단일 위치를 확정할 수 없습니다. 작가가 위치를 선택해야 합니다.`,
  };
}

// ============================================================================
// 3. Character & Entity Resolution + Canon Conflict Detection
// ============================================================================

export interface CharacterResolutionResult {
  resolvedId: string | null;
  resolvedName: string;
  flags: ExtractionUncertaintyFlag[];
}

export function resolveCharacterReference(params: {
  rawId: string | null | undefined;
  rawName: string;
  characters: Character[];
}): CharacterResolutionResult {
  const { rawId, rawName, characters } = params;
  const trimmedName = (rawName || '').trim();
  const flags: ExtractionUncertaintyFlag[] = [];

  if (rawId && isValidEntityId(rawId)) {
    const byId = characters.find((c) => c.id === rawId);
    if (byId) {
      const sameNameCount = characters.filter(
        (c) => c.name.trim() === byId.name.trim()
      ).length;
      if (sameNameCount > 1) {
        flags.push('HOMONYM_CHARACTER_NAME');
      }
      return {
        resolvedId: byId.id,
        resolvedName: byId.name,
        flags,
      };
    }
  }

  if (!trimmedName) {
    flags.push('AMBIGUOUS_CHARACTER_REFERENCE');
    return { resolvedId: null, resolvedName: '', flags };
  }

  const exactMatches = characters.filter((c) => c.name.trim() === trimmedName);
  if (exactMatches.length === 1) {
    return {
      resolvedId: exactMatches[0].id,
      resolvedName: exactMatches[0].name,
      flags,
    };
  }

  if (exactMatches.length > 1) {
    flags.push('HOMONYM_CHARACTER_NAME', 'AMBIGUOUS_CHARACTER_REFERENCE');
    return {
      resolvedId: null,
      resolvedName: trimmedName,
      flags,
    };
  }

  // Check partial / alias inclusion if unambiguous
  const partialMatches = characters.filter(
    (c) =>
      c.name.trim().includes(trimmedName) || trimmedName.includes(c.name.trim())
  );
  if (partialMatches.length === 1) {
    return {
      resolvedId: partialMatches[0].id,
      resolvedName: partialMatches[0].name,
      flags,
    };
  }

  if (partialMatches.length > 1) {
    flags.push('AMBIGUOUS_CHARACTER_REFERENCE');
    return {
      resolvedId: null,
      resolvedName: trimmedName,
      flags,
    };
  }

  flags.push('NEW_UNREGISTERED_CHARACTER');
  return {
    resolvedId: null,
    resolvedName: trimmedName,
    flags,
  };
}

const CLUE_PHASE_RANK: Record<ForeshadowingPhase, number> = {
  PLANTED: 1,
  REINFORCED: 2,
  RESOLVED: 3,
  ABANDONED: 0,
};

export function computeExtractionCandidateFingerprint(params: {
  projectId: string;
  sourceRevisionId: string;
  targetEntityType: ExtractionCandidateType;
  proposedAction: ExtractionActionType;
  semanticKey: string;
  startOffset?: number | null;
  endOffset?: number | null;
}): string {
  const offsetPart =
    typeof params.startOffset === 'number' && typeof params.endOffset === 'number'
      ? `${params.startOffset}:${params.endOffset}`
      : 'unverified_offset';
  const normalizedSemantic = params.semanticKey
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return [
    'nf421',
    params.projectId,
    params.sourceRevisionId,
    params.targetEntityType,
    params.proposedAction,
    normalizedSemantic,
    offsetPart,
  ].join('|');
}

/**
 * Pure TypeScript 128-bit (4 x 32-bit) deterministic hash for browser + Node compatibility.
 * Produces a 32-character lowercase hex digest without requiring node:crypto in client bundles.
 */
function hashStringTo128BitHex(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  let h3 = 0x9e3779b9 ^ input.length;
  let h4 = 0x85ebca6b ^ input.length;

  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
    h3 = Math.imul(h3 ^ (ch + i), 2246822507);
    h4 = Math.imul(h4 ^ (ch ^ (i << 3)), 3266489909);
  }

  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  h3 =
    Math.imul(h3 ^ (h3 >>> 16), 2246822507) ^
    Math.imul(h4 ^ (h4 >>> 13), 3266489909);
  h4 =
    Math.imul(h4 ^ (h4 >>> 16), 2246822507) ^
    Math.imul(h3 ^ (h3 >>> 13), 3266489909);

  const toHex8 = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return `${toHex8(h1)}${toHex8(h2)}${toHex8(h3)}${toHex8(h4)}`;
}

/**
 * Computes a deterministic ChangeProposal document ID from the candidate fingerprint.
 * Guarantees idempotent atomic transactions per unique candidate fingerprint.
 */
export function computeDeterministicProposalId(fingerprint: string): string {
  const normalized = (fingerprint || '').trim();
  return `prop_${hashStringTo128BitHex(normalized)}`;
}

/**
 * Computes a deterministic hash of Revision.content to detect if the manuscript revision
 * was modified between the analysis step and the proposal save step.
 */
export function computeRevisionContentHash(revisionContent: string): string {
  const text = revisionContent ?? '';
  return `revhash_${text.length}_${hashStringTo128BitHex(text)}`;
}

function spansOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

export function checkDuplicateProposalStatus(params: {
  fingerprint: string;
  sourceRevisionId: string;
  targetEntityType: ExtractionCandidateType;
  proposedAction: ExtractionActionType;
  targetEntityId: string;
  verifiedSpan: ServerVerifiedExcerptSpan | null;
  existingProposals: ChangeProposal[];
}): {
  duplicateStatus: DuplicateProposalStatus;
  existingProposalId: string | null;
} {
  const {
    fingerprint,
    sourceRevisionId,
    targetEntityType,
    proposedAction,
    targetEntityId,
    verifiedSpan,
    existingProposals,
  } = params;

  const deterministicId = computeDeterministicProposalId(fingerprint);

  for (const existing of existingProposals) {
    if (existing.targetEntityType !== targetEntityType) continue;

    let parsedPayload: Partial<ChangeProposalPayloadEnvelope> | null = null;
    try {
      parsedPayload = JSON.parse(existing.proposedPayloadJson);
    } catch {
      parsedPayload = null;
    }

    const sameDeterministicId = existing.id === deterministicId;
    const sameFingerprint =
      Boolean(parsedPayload?.fingerprint && parsedPayload.fingerprint === fingerprint);

    const sameEntityAndOverlappingSpan =
      existing.sourceRevisionId === sourceRevisionId &&
      existing.proposedAction === proposedAction &&
      (existing.targetEntityId === targetEntityId ||
        (parsedPayload?.fingerprint &&
          parsedPayload.fingerprint.split('|').slice(0, 6).join('|') ===
            fingerprint.split('|').slice(0, 6).join('|'))) &&
      verifiedSpan &&
      parsedPayload?.verifiedExcerpt &&
      spansOverlap(
        verifiedSpan.startOffset,
        verifiedSpan.endOffset,
        parsedPayload.verifiedExcerpt.startOffset,
        parsedPayload.verifiedExcerpt.endOffset
      );

    if (sameDeterministicId || sameFingerprint || sameEntityAndOverlappingSpan) {
      const status = normalizeToCanonStatus(existing.canonStatus);
      if (status === 'PROPOSED') {
        return {
          duplicateStatus: 'EXISTING_PROPOSED',
          existingProposalId: existing.id,
        };
      }
      if (status === 'CANON') {
        return {
          duplicateStatus: 'EXISTING_CANON_APPLIED',
          existingProposalId: existing.id,
        };
      }
      if (status === 'REJECTED') {
        return {
          duplicateStatus: 'EXISTING_REJECTED',
          existingProposalId: existing.id,
        };
      }
    }
  }

  return {
    duplicateStatus: 'NONE',
    existingProposalId: null,
  };
}

// ============================================================================
// 4. Candidate Processing & ChangeProposal Conversion Pipeline
// ============================================================================

export interface ExtractionVerificationContext {
  ownerId: string;
  projectId: string;
  episode: Episode;
  revision: Revision;
  scenes: Scene[];
  characters: Character[];
  worldbuilding: WorldbuildingItem[];
  relationships: CharacterRelationship[];
  timelineEvents: TimelineEvent[];
  foreshadowings: Foreshadowing[];
  existingProposals: ChangeProposal[];
  selectedCandidateSpanOverrides?: Record<
    string,
    { startOffset: number; endOffset: number }
  >;
  allowUpdateRejected?: boolean;
}

function serializePayloadEnvelopeSafely(
  envelope: ChangeProposalPayloadEnvelope
): {
  valid: boolean;
  jsonString: string;
  compactedEnvelope: ChangeProposalPayloadEnvelope;
  error?: string;
} {
  const maxLen = FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.PAYLOAD_JSON_MAX;
  let candidateEnvelope: ChangeProposalPayloadEnvelope = { ...envelope };
  let jsonString = JSON.stringify(candidateEnvelope);

  if (jsonString.length > maxLen) {
    // Step 1 compaction: drop optional context and snapshot fields instead of slicing JSON
    candidateEnvelope = {
      ...candidateEnvelope,
      precedingContext: null,
      followingContext: null,
      existingEntitySnapshot: null,
    };
    jsonString = JSON.stringify(candidateEnvelope);
  }

  if (jsonString.length > maxLen) {
    return {
      valid: false,
      jsonString: '',
      compactedEnvelope: candidateEnvelope,
      error: `제안서 직렬화 JSON 크기(${jsonString.length}자)가 최대 허용 한도(${maxLen}자)를 초과하여 저장할 수 없습니다.`,
    };
  }

  // Verify round-trip parse integrity
  try {
    JSON.parse(jsonString);
  } catch {
    return {
      valid: false,
      jsonString: '',
      compactedEnvelope: candidateEnvelope,
      error: '제안서 페이로드 JSON 직렬화 무결성 검증에 실패했습니다.',
    };
  }

  return {
    valid: true,
    jsonString,
    compactedEnvelope: candidateEnvelope,
  };
}

export function verifyAndConvertExtractionCandidates(
  rawCandidates: AiRawExtractionCandidate[],
  ctx: ExtractionVerificationContext
): VerifiedExtractionCandidate[] {
  const results: VerifiedExtractionCandidate[] = [];
  const seenFingerprintsInBatch = new Set<string>();

  rawCandidates.forEach((raw, idx) => {
    const candidateId = `cand_${ctx.revision.id}_${idx + 1}`;
    const flags = new Set<ExtractionUncertaintyFlag>(raw.uncertaintyFlags || []);

    if (raw.dialogueClaimOnly) {
      flags.add('DIALOGUE_CLAIM_ONLY');
    }
    if (
      raw.temporalContextType === 'FLASHBACK' ||
      raw.temporalContextType === 'PAST_MENTION'
    ) {
      flags.add('FLASHBACK_OR_PAST_MENTION');
    }
    if (
      raw.temporalContextType === 'PROPHECY_OR_RUMOR' ||
      raw.temporalContextType === 'HYPOTHETICAL_OR_DREAM'
    ) {
      flags.add('RUMOR_OR_PROPHECY');
    }

    // Collect hint character names for excerpt disambiguation
    const hintCharacterNames: string[] = [];
    if (raw.relationshipPayload) {
      hintCharacterNames.push(
        raw.relationshipPayload.sourceCharacterName,
        raw.relationshipPayload.targetCharacterName
      );
    }
    if (raw.timelineEventPayload) {
      hintCharacterNames.push(...(raw.timelineEventPayload.involvedCharacterNames || []));
    }
    if (raw.foreshadowingPayload) {
      hintCharacterNames.push(...(raw.foreshadowingPayload.relatedCharacterNames || []));
    }

    const overrideSpan =
      ctx.selectedCandidateSpanOverrides?.[candidateId] ?? null;

    // 1. Server-side UTF-16 excerpt verification
    const verification = locateAndVerifyExcerptInRevision({
      revisionContent: ctx.revision.content,
      excerpt: raw.excerpt,
      precedingContext: raw.precedingContext,
      followingContext: raw.followingContext,
      hintCharacterNames,
      authorSelectedSpanOverride: overrideSpan,
    });

    // Resolve sceneId if valid in current episode, else empty string
    const resolvedSceneId =
      raw.sceneId &&
      ctx.scenes.some((s) => s.id === raw.sceneId && s.episodeId === ctx.episode.id)
        ? raw.sceneId
        : '';

    const canonConflicts: CanonConflictNotice[] = [];
    let proposedAction: ExtractionActionType = raw.proposedAction;
    let targetEntityId = '';
    let semanticKey = '';
    let canSaveEntity = true;
    let entityBlockReason = '';

    let relationshipDraft: ExtractedRelationshipDraftPayload | undefined;
    let timelineEventDraft: ExtractedTimelineEventDraftPayload | undefined;
    let foreshadowingDraft: ExtractedForeshadowingDraftPayload | undefined;
    let existingEntitySnapshot:
      | Partial<CharacterRelationship>
      | Partial<TimelineEvent>
      | Partial<Foreshadowing>
      | null = null;

    const provenance = createDataProvenance({
      sourceType: 'AI_PROPOSAL',
      createdBy: 'AI_ENGINE',
      ownerId: ctx.ownerId,
      projectId: ctx.projectId,
      episodeId: ctx.episode.id,
      sceneId: resolvedSceneId || null,
      revisionId: ctx.revision.id,
      excerpt: verification.verifiedSpan?.matchedText || raw.excerpt,
    });

    // 2. Entity-specific resolution & conflict checks
    if (raw.targetEntityType === 'RELATIONSHIP' && raw.relationshipPayload) {
      const relRaw = raw.relationshipPayload;
      const sourceRes = resolveCharacterReference({
        rawId: relRaw.sourceCharacterId,
        rawName: relRaw.sourceCharacterName,
        characters: ctx.characters,
      });
      const targetRes = resolveCharacterReference({
        rawId: relRaw.targetCharacterId,
        rawName: relRaw.targetCharacterName,
        characters: ctx.characters,
      });

      sourceRes.flags.forEach((f) => flags.add(f));
      targetRes.flags.forEach((f) => flags.add(f));

      const sourceCharId = sourceRes.resolvedId || '';
      const targetCharId = targetRes.resolvedId || '';

      if (!sourceCharId || !targetCharId) {
        canSaveEntity = false;
        entityBlockReason =
          '인물 관계 제안은 프로젝트에 등록된 두 등장인물이 명확히 특정되어야 ChangeProposal로 저장할 수 있습니다.';
      } else if (sourceCharId === targetCharId) {
        canSaveEntity = false;
        entityBlockReason = '동일 인물 간의 관계는 생성할 수 없습니다.';
      }

      // Check existing relationship between the pair
      const existingRel = ctx.relationships.find((r) => {
        if (raw.existingTargetEntityId && r.id === raw.existingTargetEntityId) {
          return true;
        }
        if (sourceCharId && targetCharId) {
          const directMatch =
            r.sourceCharacterId === sourceCharId &&
            r.targetCharacterId === targetCharId;
          const reverseMatch =
            !r.isDirectional &&
            r.sourceCharacterId === targetCharId &&
            r.targetCharacterId === sourceCharId;
          return directMatch || reverseMatch;
        }
        return false;
      });

      if (proposedAction === 'UPDATE') {
        if (!existingRel) {
          canonConflicts.push({
            conflictType: 'MISSING_UPDATE_TARGET',
            existingEntityId: raw.existingTargetEntityId || 'unknown',
            existingCanonStatus: 'DRAFT',
            message:
              'UPDATE 대상인 기존 인물 관계를 찾을 수 없어 승인 제안을 저장할 수 없습니다.',
          });
          canSaveEntity = false;
          entityBlockReason = 'UPDATE 대상 인물 관계 엔티티가 존재하지 않습니다.';
          targetEntityId = raw.existingTargetEntityId || generateEntityId('rel');
        } else {
          targetEntityId = existingRel.id;
          existingEntitySnapshot = existingRel;
        }
      } else {
        if (existingRel) {
          // Automatically switch to UPDATE or flag existing relationship conflict
          proposedAction = 'UPDATE';
          targetEntityId = existingRel.id;
          existingEntitySnapshot = existingRel;
        } else {
          targetEntityId = generateEntityId('rel');
        }
      }

      if (existingRel) {
        const existingStatus = normalizeToCanonStatus(existingRel.canonStatus);
        const signReversed =
          (existingRel.affinityScore >= 25 && relRaw.affinityScore <= -25) ||
          (existingRel.affinityScore <= -25 && relRaw.affinityScore >= 25);

        if (signReversed) {
          flags.add('CONFLICTS_WITH_CANON');
          canonConflicts.push({
            conflictType: 'AFFINITY_DIRECTION_REVERSAL',
            existingEntityId: existingRel.id,
            existingCanonStatus: existingStatus,
            message: `기존 관계(${existingRel.relationType}, 우호도 ${existingRel.affinityScore})와 반대 방향의 우호도(${relRaw.affinityScore})가 감지되었습니다.`,
          });
        } else if (existingStatus === 'CANON') {
          flags.add('CONFLICTS_WITH_CANON');
          canonConflicts.push({
            conflictType: 'CANON_RELATIONSHIP_OVERWRITE',
            existingEntityId: existingRel.id,
            existingCanonStatus: 'CANON',
            message: `작가 확정(CANON) 인물 관계(${existingRel.relationType})에 대한 변경 제안입니다.`,
          });
        }
      }

      semanticKey = `${sourceCharId || sourceRes.resolvedName}->${
        targetCharId || targetRes.resolvedName
      }:${relRaw.relationType.trim()}`;

      relationshipDraft = {
        id: targetEntityId,
        ownerId: ctx.ownerId,
        projectId: ctx.projectId,
        sourceCharacterId: sourceCharId,
        sourceCharacterName: sourceRes.resolvedName,
        targetCharacterId: targetCharId,
        targetCharacterName: targetRes.resolvedName,
        relationType: relRaw.relationType
          .trim()
          .slice(0, FOUNDATION_CONSTRAINTS.RELATIONSHIP.TYPE_MAX),
        affinityScore: Math.max(
          FOUNDATION_CONSTRAINTS.RELATIONSHIP.AFFINITY_MIN,
          Math.min(
            FOUNDATION_CONSTRAINTS.RELATIONSHIP.AFFINITY_MAX,
            Math.round(relRaw.affinityScore)
          )
        ),
        isDirectional: Boolean(relRaw.isDirectional),
        description: relRaw.description
          .trim()
          .slice(0, FOUNDATION_CONSTRAINTS.RELATIONSHIP.DESCRIPTION_MAX),
        canonStatus: 'PROPOSED',
        lastChangedEpisodeId: ctx.episode.id,
        sourceRevisionId: ctx.revision.id,
        provenance,
      };
    } else if (raw.targetEntityType === 'TIMELINE_EVENT' && raw.timelineEventPayload) {
      const evtRaw = raw.timelineEventPayload;
      const resolvedCharIds: string[] = [];
      const resolvedCharNames: string[] = [];

      const rawNames = evtRaw.involvedCharacterNames || [];
      const rawIds = evtRaw.involvedCharacterIds || [];
      const maxLen = Math.max(rawNames.length, rawIds.length);
      for (let i = 0; i < maxLen; i++) {
        const res = resolveCharacterReference({
          rawId: rawIds[i] ?? null,
          rawName: rawNames[i] ?? '',
          characters: ctx.characters,
        });
        res.flags.forEach((f) => flags.add(f));
        if (res.resolvedId && !resolvedCharIds.includes(res.resolvedId)) {
          resolvedCharIds.push(res.resolvedId);
        }
        if (res.resolvedName && !resolvedCharNames.includes(res.resolvedName)) {
          resolvedCharNames.push(res.resolvedName);
        }
      }

      // Resolve locationWorldItemId if matched in worldbuilding
      let resolvedWorldItemId = '';
      if (
        evtRaw.locationWorldItemId &&
        ctx.worldbuilding.some((w) => w.id === evtRaw.locationWorldItemId)
      ) {
        resolvedWorldItemId = evtRaw.locationWorldItemId;
      } else if (evtRaw.locationName) {
        const matchedWorld = ctx.worldbuilding.find(
          (w) => w.title.trim() === evtRaw.locationName?.trim()
        );
        if (matchedWorld) {
          resolvedWorldItemId = matchedWorld.id;
        }
      }

      const existingEvt = ctx.timelineEvents.find((ev) => {
        if (raw.existingTargetEntityId && ev.id === raw.existingTargetEntityId) {
          return true;
        }
        return (
          ev.episodeId === ctx.episode.id &&
          ev.title.trim().toLowerCase() === evtRaw.title.trim().toLowerCase()
        );
      });

      if (proposedAction === 'UPDATE') {
        if (!existingEvt) {
          canonConflicts.push({
            conflictType: 'MISSING_UPDATE_TARGET',
            existingEntityId: raw.existingTargetEntityId || 'unknown',
            existingCanonStatus: 'DRAFT',
            message: 'UPDATE 대상인 기존 연표 사건을 찾을 수 없습니다.',
          });
          canSaveEntity = false;
          entityBlockReason = 'UPDATE 대상 연표 사건 엔티티가 존재하지 않습니다.';
          targetEntityId = raw.existingTargetEntityId || generateEntityId('evt');
        } else {
          targetEntityId = existingEvt.id;
          existingEntitySnapshot = existingEvt;
        }
      } else {
        if (existingEvt) {
          proposedAction = 'UPDATE';
          targetEntityId = existingEvt.id;
          existingEntitySnapshot = existingEvt;
        } else {
          targetEntityId = generateEntityId('evt');
        }
      }

      // Compute default chronologicalOrder if null
      let chronologicalOrder: number;
      if (typeof evtRaw.chronologicalOrder === 'number') {
        chronologicalOrder = evtRaw.chronologicalOrder;
      } else if (existingEvt) {
        chronologicalOrder = existingEvt.chronologicalOrder;
      } else {
        flags.add('TIMELINE_ORDER_UNCERTAIN');
        const maxOrder = ctx.timelineEvents.reduce(
          (acc, ev) => Math.max(acc, ev.chronologicalOrder),
          0
        );
        chronologicalOrder = Math.min(
          FOUNDATION_CONSTRAINTS.TIMELINE_EVENT.ORDER_MAX,
          maxOrder + 10
        );
      }

      if (existingEvt && normalizeToCanonStatus(existingEvt.canonStatus) === 'CANON') {
        flags.add('CONFLICTS_WITH_CANON');
        canonConflicts.push({
          conflictType: 'CANON_EVENT_ORDER_CONFLICT',
          existingEntityId: existingEvt.id,
          existingCanonStatus: 'CANON',
          message: `작가 확정(CANON) 연표 사건('${existingEvt.title}')에 대한 수정 제안입니다.`,
        });
      }

      semanticKey = `evt:${evtRaw.title.trim()}:${ctx.episode.id}`;

      timelineEventDraft = {
        id: targetEntityId,
        ownerId: ctx.ownerId,
        projectId: ctx.projectId,
        title: evtRaw.title
          .trim()
          .slice(0, FOUNDATION_CONSTRAINTS.TIMELINE_EVENT.TITLE_MAX),
        summary: evtRaw.summary
          .trim()
          .slice(0, FOUNDATION_CONSTRAINTS.TIMELINE_EVENT.SUMMARY_MAX),
        episodeId: ctx.episode.id,
        sceneId: resolvedSceneId,
        inUniverseDate: (evtRaw.inUniverseDate || '')
          .trim()
          .slice(0, FOUNDATION_CONSTRAINTS.TIMELINE_EVENT.DATE_MAX),
        chronologicalOrder,
        involvedCharacterIds: resolvedCharIds,
        involvedCharacterNames: resolvedCharNames,
        locationWorldItemId: resolvedWorldItemId,
        locationName: (evtRaw.locationName || '').trim(),
        canonStatus: 'PROPOSED',
        sourceRevisionId: ctx.revision.id,
        provenance,
      };
    } else if (raw.targetEntityType === 'FORESHADOWING' && raw.foreshadowingPayload) {
      const fshRaw = raw.foreshadowingPayload;
      const resolvedCharIds: string[] = [];
      const resolvedCharNames: string[] = [];

      const rawNames = fshRaw.relatedCharacterNames || [];
      const rawIds = fshRaw.relatedCharacterIds || [];
      const maxLen = Math.max(rawNames.length, rawIds.length);
      for (let i = 0; i < maxLen; i++) {
        const res = resolveCharacterReference({
          rawId: rawIds[i] ?? null,
          rawName: rawNames[i] ?? '',
          characters: ctx.characters,
        });
        res.flags.forEach((f) => flags.add(f));
        if (res.resolvedId && !resolvedCharIds.includes(res.resolvedId)) {
          resolvedCharIds.push(res.resolvedId);
        }
        if (res.resolvedName && !resolvedCharNames.includes(res.resolvedName)) {
          resolvedCharNames.push(res.resolvedName);
        }
      }

      const validEventIds = (fshRaw.relatedEventIds || []).filter((id) =>
        ctx.timelineEvents.some((ev) => ev.id === id)
      );

      const existingFsh = ctx.foreshadowings.find((f) => {
        if (raw.existingTargetEntityId && f.id === raw.existingTargetEntityId) {
          return true;
        }
        return f.title.trim().toLowerCase() === fshRaw.title.trim().toLowerCase();
      });

      if (proposedAction === 'UPDATE') {
        if (!existingFsh) {
          canonConflicts.push({
            conflictType: 'MISSING_UPDATE_TARGET',
            existingEntityId: raw.existingTargetEntityId || 'unknown',
            existingCanonStatus: 'DRAFT',
            message: 'UPDATE 대상인 기존 복선(Foreshadowing)을 찾을 수 없습니다.',
          });
          canSaveEntity = false;
          entityBlockReason = 'UPDATE 대상 복선 엔티티가 존재하지 않습니다.';
          targetEntityId = raw.existingTargetEntityId || generateEntityId('fsh');
        } else {
          targetEntityId = existingFsh.id;
          existingEntitySnapshot = existingFsh;
        }
      } else {
        if (existingFsh) {
          proposedAction = 'UPDATE';
          targetEntityId = existingFsh.id;
          existingEntitySnapshot = existingFsh;
        } else {
          targetEntityId = generateEntityId('fsh');
        }
      }

      if (existingFsh) {
        const currentRank = CLUE_PHASE_RANK[existingFsh.cluePhase] ?? 1;
        const nextRank = CLUE_PHASE_RANK[fshRaw.cluePhase] ?? 1;
        const existingStatus = normalizeToCanonStatus(existingFsh.canonStatus);

        if (nextRank < currentRank) {
          flags.add('CONFLICTS_WITH_CANON');
          flags.add('CLUE_PHASE_UNCERTAIN');
          canonConflicts.push({
            conflictType: 'CANON_FORESHADOWING_PHASE_REGRESSION',
            existingEntityId: existingFsh.id,
            existingCanonStatus: existingStatus,
            message: `기존 복선 단계(${existingFsh.cluePhase})보다 이전 단계(${fshRaw.cluePhase})로의 역행이 감지되었습니다.`,
          });
        } else if (existingStatus === 'CANON') {
          flags.add('CONFLICTS_WITH_CANON');
          canonConflicts.push({
            conflictType: 'CANON_FORESHADOWING_PHASE_REGRESSION',
            existingEntityId: existingFsh.id,
            existingCanonStatus: 'CANON',
            message: `작가 확정(CANON) 복선('${existingFsh.title}')의 단계(${existingFsh.cluePhase} → ${fshRaw.cluePhase}) 변경 제안입니다.`,
          });
        }
      }

      const plantedEpisodeId =
        existingFsh?.plantedEpisodeId ||
        (fshRaw.cluePhase === 'PLANTED' ? ctx.episode.id : ctx.episode.id);
      const plantedSceneId = existingFsh?.plantedSceneId || resolvedSceneId;
      const resolvedEpisodeId =
        fshRaw.cluePhase === 'RESOLVED'
          ? ctx.episode.id
          : existingFsh?.resolvedEpisodeId || '';
      const resolvedSceneIdForFsh =
        fshRaw.cluePhase === 'RESOLVED'
          ? resolvedSceneId
          : existingFsh?.resolvedSceneId || '';

      semanticKey = `fsh:${fshRaw.title.trim()}:${fshRaw.cluePhase}`;

      foreshadowingDraft = {
        id: targetEntityId,
        ownerId: ctx.ownerId,
        projectId: ctx.projectId,
        title: fshRaw.title
          .trim()
          .slice(0, FOUNDATION_CONSTRAINTS.FORESHADOWING.TITLE_MAX),
        description: fshRaw.description
          .trim()
          .slice(0, FOUNDATION_CONSTRAINTS.FORESHADOWING.DESCRIPTION_MAX),
        cluePhase: fshRaw.cluePhase,
        canonStatus: 'PROPOSED',
        plantedEpisodeId,
        plantedSceneId,
        resolvedEpisodeId,
        resolvedSceneId: resolvedSceneIdForFsh,
        relatedCharacterIds: resolvedCharIds,
        relatedCharacterNames: resolvedCharNames,
        relatedEventIds: validEventIds,
        payoffNote: (fshRaw.payoffNote || '')
          .trim()
          .slice(0, FOUNDATION_CONSTRAINTS.FORESHADOWING.DESCRIPTION_MAX),
        sourceRevisionId: ctx.revision.id,
        provenance,
      };
    }

    const fingerprint = computeExtractionCandidateFingerprint({
      projectId: ctx.projectId,
      sourceRevisionId: ctx.revision.id,
      targetEntityType: raw.targetEntityType,
      proposedAction,
      semanticKey: semanticKey || raw.title,
      startOffset: verification.verifiedSpan?.startOffset ?? null,
      endOffset: verification.verifiedSpan?.endOffset ?? null,
    });

    const { duplicateStatus, existingProposalId } = checkDuplicateProposalStatus({
      fingerprint,
      sourceRevisionId: ctx.revision.id,
      targetEntityType: raw.targetEntityType,
      proposedAction,
      targetEntityId,
      verifiedSpan: verification.verifiedSpan,
      existingProposals: ctx.existingProposals,
    });

    const isBatchDuplicate = seenFingerprintsInBatch.has(fingerprint);
    if (verification.status === 'VERIFIED') {
      seenFingerprintsInBatch.add(fingerprint);
    }

    const uncertaintyFlags = Array.from(flags);

    // Determine whether this candidate can be saved as a ChangeProposal
    let canSaveAsProposal =
      verification.status === 'VERIFIED' &&
      verification.verifiedSpan !== null &&
      canSaveEntity &&
      !isBatchDuplicate;

    let cannotSaveReason: string | undefined;

    if (verification.status !== 'VERIFIED' || !verification.verifiedSpan) {
      canSaveAsProposal = false;
      cannotSaveReason =
        verification.reason ||
        '원문 오프셋이 검증되지 않은 후보는 ChangeProposal로 저장할 수 없습니다.';
    } else if (!canSaveEntity) {
      canSaveAsProposal = false;
      cannotSaveReason = entityBlockReason;
    } else if (isBatchDuplicate) {
      canSaveAsProposal = false;
      cannotSaveReason = '동일 분석 요청 내 중복된 후보입니다.';
    } else if (duplicateStatus === 'EXISTING_PROPOSED') {
      canSaveAsProposal = false;
      cannotSaveReason = `이미 동일한 검토 대기 제안서(${existingProposalId})가 존재합니다.`;
    } else if (duplicateStatus === 'EXISTING_CANON_APPLIED') {
      canSaveAsProposal = false;
      cannotSaveReason = `이미 작가 확정(CANON)으로 승인 완료된 제안서(${existingProposalId})입니다.`;
    } else if (duplicateStatus === 'EXISTING_REJECTED') {
      // Strictly protect author's REJECTED decision even if client passes allowUpdateRejected
      canSaveAsProposal = false;
      cannotSaveReason = `이전에 작가가 거절(REJECTED)한 제안서(${existingProposalId})와 동일하여 자동 재생성하지 않습니다.`;
    }

    let payloadEnvelope: ChangeProposalPayloadEnvelope | null = null;
    let proposalDraft: ChangeProposal | null = null;

    const spanForEnvelope =
      verification.verifiedSpan ??
      (verification.status === 'AMBIGUOUS_MULTIPLE_MATCHES' &&
      verification.candidateSpans.length > 0 &&
      canSaveEntity
        ? verification.candidateSpans[0]
        : null);

    if (spanForEnvelope) {
      const rawEnvelope: ChangeProposalPayloadEnvelope = {
        schemaVersion: 'PHASE_4_2_1_V1',
        fingerprint,
        targetEntityType: raw.targetEntityType,
        proposedAction,
        targetEntityId,
        sourceEpisodeId: ctx.episode.id,
        sourceRevisionId: ctx.revision.id,
        sourceSceneId: resolvedSceneId,
        verifiedExcerpt: {
          excerpt: raw.excerpt,
          matchedText: spanForEnvelope.matchedText,
          startOffset: spanForEnvelope.startOffset,
          endOffset: spanForEnvelope.endOffset,
          matchMethod: spanForEnvelope.matchMethod,
        },
        precedingContext: raw.precedingContext,
        followingContext: raw.followingContext,
        confidence: raw.confidence,
        dialogueClaimOnly: raw.dialogueClaimOnly,
        temporalContextType: raw.temporalContextType,
        uncertaintyFlags,
        canonConflicts,
        provenance,
        relationshipDraft,
        timelineEventDraft,
        foreshadowingDraft,
        existingEntitySnapshot,
      };

      const serialized = serializePayloadEnvelopeSafely(rawEnvelope);
      if (!serialized.valid) {
        canSaveAsProposal = false;
        cannotSaveReason = serialized.error;
      } else {
        payloadEnvelope = serialized.compactedEnvelope;
        if (canSaveAsProposal && verification.status === 'VERIFIED') {
          const nowIso = new Date().toISOString();
          const deterministicProposalId = computeDeterministicProposalId(fingerprint);
          const candidateProposal: ChangeProposal = {
            id: deterministicProposalId,
            ownerId: ctx.ownerId,
            projectId: ctx.projectId,
            targetEntityType: raw.targetEntityType,
            targetEntityId,
            proposedAction,
            title: raw.title
              .trim()
              .slice(0, FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.TITLE_MAX),
            rationale: raw.rationale
              .trim()
              .slice(0, FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.RATIONALE_MAX),
            beforeSummary: (raw.beforeSummary || '기존 설정 없음')
              .trim()
              .slice(0, FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.SUMMARY_MAX),
            afterSummary: (raw.afterSummary || raw.title)
              .trim()
              .slice(0, FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.SUMMARY_MAX),
            proposedPayloadJson: serialized.jsonString,
            canonStatus: 'PROPOSED',
            triggerEpisodeId: ctx.episode.id,
            triggerSceneId: resolvedSceneId,
            sourceRevisionId: ctx.revision.id,
            createdBy: 'AI_ENGINE',
            reviewedAt: '',
            createdAt: nowIso,
            updatedAt: nowIso,
          };

          const validation = validateChangeProposalInput(candidateProposal);
          if (!validation.valid) {
            canSaveAsProposal = false;
            cannotSaveReason = validation.error;
          } else {
            proposalDraft = candidateProposal;
          }
        }
      }
    }

    results.push({
      candidateId,
      fingerprint,
      targetEntityType: raw.targetEntityType,
      proposedAction,
      targetEntityId,
      title: raw.title,
      rationale: raw.rationale,
      beforeSummary: raw.beforeSummary,
      afterSummary: raw.afterSummary,
      excerpt: raw.excerpt,
      precedingContext: raw.precedingContext,
      followingContext: raw.followingContext,
      sceneId: resolvedSceneId,
      confidence: raw.confidence,
      dialogueClaimOnly: raw.dialogueClaimOnly,
      temporalContextType: raw.temporalContextType,
      uncertaintyFlags,
      verification,
      canonConflicts,
      duplicateStatus,
      existingProposalId,
      canSaveAsProposal,
      cannotSaveReason,
      payloadEnvelope,
      proposalDraft,
    });
  });

  return results;
}

/**
 * Applies an author-selected UTF-16 span override to a candidate (typically AMBIGUOUS_MULTIPLE_MATCHES),
 * verifying that the chosen span is one of the server-verified candidateSpans and matches Revision.content,
 * then recomputes the deterministic fingerprint, duplicate status, and ChangeProposal draft.
 */
export function applyAuthorSpanDisambiguationToCandidate(params: {
  candidate: VerifiedExtractionCandidate;
  selectedSpan: { startOffset: number; endOffset: number };
  revisionContent: string;
  ownerId: string;
  projectId: string;
  existingProposals: ChangeProposal[];
}): VerifiedExtractionCandidate {
  const {
    candidate,
    selectedSpan,
    revisionContent,
    ownerId,
    projectId,
    existingProposals,
  } = params;

  const matchedCandidateSpan = candidate.verification.candidateSpans.find(
    (s) =>
      s.startOffset === selectedSpan.startOffset &&
      s.endOffset === selectedSpan.endOffset
  );

  if (!matchedCandidateSpan) {
    return {
      ...candidate,
      canSaveAsProposal: false,
      cannotSaveReason:
        '선택된 발췌 위치가 서버에서 검증된 후보 위치 목록(candidateSpans)에 존재하지 않습니다.',
    };
  }

  // Re-verify against authoritative Revision.content
  if (
    matchedCandidateSpan.startOffset < 0 ||
    matchedCandidateSpan.endOffset <= matchedCandidateSpan.startOffset ||
    matchedCandidateSpan.endOffset > revisionContent.length ||
    isUtf16SurrogateSplit(revisionContent, matchedCandidateSpan.startOffset) ||
    isUtf16SurrogateSplit(revisionContent, matchedCandidateSpan.endOffset) ||
    revisionContent.slice(
      matchedCandidateSpan.startOffset,
      matchedCandidateSpan.endOffset
    ) !== matchedCandidateSpan.matchedText
  ) {
    return {
      ...candidate,
      canSaveAsProposal: false,
      cannotSaveReason:
        '선택된 발췌 오프셋이 현재 리비전 원문(Revision.content)과 일치하지 않습니다.',
    };
  }

  if (!candidate.payloadEnvelope) {
    return {
      ...candidate,
      canSaveAsProposal: false,
      cannotSaveReason:
        candidate.cannotSaveReason ||
        '엔티티 필수 조건이 충족되지 않아 제안서로 변환할 수 없습니다.',
    };
  }

  // Recompute fingerprint with the newly selected verified span
  const baseParts = candidate.fingerprint.split('|');
  const semanticKey = baseParts.length >= 6 ? baseParts[5] : candidate.title;
  const updatedFingerprint = computeExtractionCandidateFingerprint({
    projectId,
    sourceRevisionId: candidate.payloadEnvelope.sourceRevisionId,
    targetEntityType: candidate.targetEntityType,
    proposedAction: candidate.proposedAction,
    semanticKey,
    startOffset: matchedCandidateSpan.startOffset,
    endOffset: matchedCandidateSpan.endOffset,
  });

  const { duplicateStatus, existingProposalId } = checkDuplicateProposalStatus({
    fingerprint: updatedFingerprint,
    sourceRevisionId: candidate.payloadEnvelope.sourceRevisionId,
    targetEntityType: candidate.targetEntityType,
    proposedAction: candidate.proposedAction,
    targetEntityId: candidate.targetEntityId,
    verifiedSpan: matchedCandidateSpan,
    existingProposals,
  });

  if (duplicateStatus === 'EXISTING_PROPOSED') {
    return {
      ...candidate,
      fingerprint: updatedFingerprint,
      verification: {
        status: 'VERIFIED',
        verifiedSpan: matchedCandidateSpan,
        candidateSpans: candidate.verification.candidateSpans,
      },
      duplicateStatus,
      existingProposalId,
      canSaveAsProposal: false,
      cannotSaveReason: `이미 동일한 검토 대기 제안서(${existingProposalId})가 존재합니다.`,
      proposalDraft: null,
    };
  }
  if (duplicateStatus === 'EXISTING_CANON_APPLIED') {
    return {
      ...candidate,
      fingerprint: updatedFingerprint,
      verification: {
        status: 'VERIFIED',
        verifiedSpan: matchedCandidateSpan,
        candidateSpans: candidate.verification.candidateSpans,
      },
      duplicateStatus,
      existingProposalId,
      canSaveAsProposal: false,
      cannotSaveReason: `이미 작가 확정(CANON)으로 승인 완료된 제안서(${existingProposalId})입니다.`,
      proposalDraft: null,
    };
  }
  if (duplicateStatus === 'EXISTING_REJECTED') {
    return {
      ...candidate,
      fingerprint: updatedFingerprint,
      verification: {
        status: 'VERIFIED',
        verifiedSpan: matchedCandidateSpan,
        candidateSpans: candidate.verification.candidateSpans,
      },
      duplicateStatus,
      existingProposalId,
      canSaveAsProposal: false,
      cannotSaveReason: `이전에 작가가 거절(REJECTED)한 제안서(${existingProposalId})와 동일하여 자동 재생성하지 않습니다.`,
      proposalDraft: null,
    };
  }

  const updatedProvenance = {
    ...candidate.payloadEnvelope.provenance,
    startOffset: matchedCandidateSpan.startOffset,
    endOffset: matchedCandidateSpan.endOffset,
    excerpt: matchedCandidateSpan.matchedText,
  };

  const updatedEnvelope: ChangeProposalPayloadEnvelope = {
    ...candidate.payloadEnvelope,
    fingerprint: updatedFingerprint,
    verifiedExcerpt: {
      excerpt: candidate.excerpt,
      matchedText: matchedCandidateSpan.matchedText,
      startOffset: matchedCandidateSpan.startOffset,
      endOffset: matchedCandidateSpan.endOffset,
      matchMethod: matchedCandidateSpan.matchMethod,
    },
    provenance: updatedProvenance,
    relationshipDraft: candidate.payloadEnvelope.relationshipDraft
      ? {
          ...candidate.payloadEnvelope.relationshipDraft,
          provenance: updatedProvenance,
        }
      : undefined,
    timelineEventDraft: candidate.payloadEnvelope.timelineEventDraft
      ? {
          ...candidate.payloadEnvelope.timelineEventDraft,
          provenance: updatedProvenance,
        }
      : undefined,
    foreshadowingDraft: candidate.payloadEnvelope.foreshadowingDraft
      ? {
          ...candidate.payloadEnvelope.foreshadowingDraft,
          provenance: updatedProvenance,
        }
      : undefined,
  };

  const serialized = serializePayloadEnvelopeSafely(updatedEnvelope);
  if (!serialized.valid) {
    return {
      ...candidate,
      canSaveAsProposal: false,
      cannotSaveReason: serialized.error,
      proposalDraft: null,
    };
  }

  const nowIso = new Date().toISOString();
  const deterministicProposalId =
    computeDeterministicProposalId(updatedFingerprint);
  const candidateProposal: ChangeProposal = {
    id: deterministicProposalId,
    ownerId,
    projectId,
    targetEntityType: candidate.targetEntityType,
    targetEntityId: candidate.targetEntityId,
    proposedAction: candidate.proposedAction,
    title: candidate.title
      .trim()
      .slice(0, FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.TITLE_MAX),
    rationale: candidate.rationale
      .trim()
      .slice(0, FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.RATIONALE_MAX),
    beforeSummary: (candidate.beforeSummary || '기존 설정 없음')
      .trim()
      .slice(0, FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.SUMMARY_MAX),
    afterSummary: (candidate.afterSummary || candidate.title)
      .trim()
      .slice(0, FOUNDATION_CONSTRAINTS.CHANGE_PROPOSAL.SUMMARY_MAX),
    proposedPayloadJson: serialized.jsonString,
    canonStatus: 'PROPOSED',
    triggerEpisodeId: updatedEnvelope.sourceEpisodeId,
    triggerSceneId: updatedEnvelope.sourceSceneId,
    sourceRevisionId: updatedEnvelope.sourceRevisionId,
    createdBy: 'AI_ENGINE',
    reviewedAt: '',
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const validation = validateChangeProposalInput(candidateProposal);
  if (!validation.valid) {
    return {
      ...candidate,
      canSaveAsProposal: false,
      cannotSaveReason: validation.error,
      proposalDraft: null,
    };
  }

  return {
    ...candidate,
    fingerprint: updatedFingerprint,
    verification: {
      status: 'VERIFIED',
      verifiedSpan: matchedCandidateSpan,
      candidateSpans: candidate.verification.candidateSpans,
    },
    duplicateStatus: 'NONE',
    existingProposalId: null,
    canSaveAsProposal: true,
    cannotSaveReason: undefined,
    payloadEnvelope: serialized.compactedEnvelope,
    proposalDraft: candidateProposal,
  };
}

/**
 * Validates the explicit selectedCandidateIds array for saving ChangeProposals.
 * Enforces Section 4.2 rules:
 * 1. Non-empty array required (never saves all candidates when empty/omitted).
 * 2. Deduplicates repeated IDs.
 * 3. Every selected candidateId must exist in the current analysis run's candidates.
 * 4. Every selected candidate must have verification.status === 'VERIFIED',
 *    canSaveAsProposal === true, and proposalDraft.canonStatus === 'PROPOSED'.
 */
export function validateSelectedCandidateIdsForSave(params: {
  selectedCandidateIds: unknown;
  candidates: VerifiedExtractionCandidate[];
}): {
  valid: boolean;
  deduplicatedIds: string[];
  selectedCandidates: VerifiedExtractionCandidate[];
  error?: string;
} {
  const { selectedCandidateIds, candidates } = params;

  if (!Array.isArray(selectedCandidateIds) || selectedCandidateIds.length === 0) {
    return {
      valid: false,
      deduplicatedIds: [],
      selectedCandidates: [],
      error:
        '[EMPTY_SELECTION_FORBIDDEN] 저장할 후보를 1개 이상 명시적으로 선택해야 합니다(selectedCandidateIds 필수). 빈 선택으로 전체 후보를 자동 저장할 수 없습니다.',
    };
  }

  const deduplicatedIds: string[] = [];
  const seen = new Set<string>();

  for (const rawId of selectedCandidateIds) {
    if (typeof rawId !== 'string') {
      return {
        valid: false,
        deduplicatedIds: [],
        selectedCandidates: [],
        error: '[INVALID_CANDIDATE_ID] selectedCandidateIds에는 문자열 ID만 포함되어야 합니다.',
      };
    }
    const trimmed = rawId.trim();
    if (!trimmed || !/^cand_[a-zA-Z0-9_-]{2,80}_\d+$/.test(trimmed)) {
      return {
        valid: false,
        deduplicatedIds: [],
        selectedCandidates: [],
        error: `[INVALID_CANDIDATE_ID] 유효하지 않은 candidateId 형식입니다: '${trimmed}'.`,
      };
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      deduplicatedIds.push(trimmed);
    }
  }

  const candidateMap = new Map<string, VerifiedExtractionCandidate>();
  for (const c of candidates) {
    candidateMap.set(c.candidateId, c);
  }

  const selectedCandidates: VerifiedExtractionCandidate[] = [];
  for (const id of deduplicatedIds) {
    const matched = candidateMap.get(id);
    if (!matched) {
      return {
        valid: false,
        deduplicatedIds: [],
        selectedCandidates: [],
        error: `[CANDIDATE_NOT_IN_ANALYSIS_RUN] 선택한 후보(${id})가 현재 분석 결과에 존재하지 않습니다.`,
      };
    }
    if (matched.verification.status !== 'VERIFIED' || !matched.verification.verifiedSpan) {
      return {
        valid: false,
        deduplicatedIds: [],
        selectedCandidates: [],
        error: `[UNVERIFIED_CANDIDATE_SAVE_FORBIDDEN] 선택한 후보(${id})의 원문 오프셋이 검증되지 않았습니다(상태: ${matched.verification.status}).`,
      };
    }
    if (!matched.canSaveAsProposal || !matched.proposalDraft) {
      return {
        valid: false,
        deduplicatedIds: [],
        selectedCandidates: [],
        error: `[CANDIDATE_NOT_SAVABLE] 선택한 후보(${id})는 제안서로 저장할 수 없는 상태입니다: ${
          matched.cannotSaveReason || '저장 불가 조건'
        }`,
      };
    }
    if (matched.proposalDraft.canonStatus !== 'PROPOSED') {
      return {
        valid: false,
        deduplicatedIds: [],
        selectedCandidates: [],
        error: `[CANON_BYPASS_FORBIDDEN] 제안서는 반드시 PROPOSED 상태로만 저장되어야 합니다(${id}).`,
      };
    }
    selectedCandidates.push(matched);
  }

  return {
    valid: true,
    deduplicatedIds,
    selectedCandidates,
  };
}

