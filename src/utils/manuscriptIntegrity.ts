import type { RewriteSelectionAnchor } from '../types/aiEngine';

// ============================================================================
// 1. Synchronous Pure-TS SHA-256 Content Hashing (Browser + Node Compatible)
// ============================================================================

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

function sha256HexSync(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  const highBits = Math.floor(bitLen / 0x100000000);
  const lowBits = bitLen >>> 0;
  view.setUint32(paddedLength - 8, highBits, false);
  view.setUint32(paddedLength - 4, lowBits, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((val) => val.toString(16).padStart(8, '0'))
    .join('');
}

/**
 * Computes a deterministic SHA-256 hash over UTF-16 exact manuscript text.
 * Identical across browser UI and Node.js server without requiring Node crypto.
 */
export function computeManuscriptContentHash(manuscript: string): string {
  return `sha256_${sha256HexSync(typeof manuscript === 'string' ? manuscript : '')}`;
}

// ============================================================================
// 2. P0-A Selection Anchor Validation & Byte/UTF-16 Invariant Splice
// ============================================================================

export interface ResolvedRewriteSelectionTarget {
  startOffset: number;
  endOffset: number;
  originalExcerpt: string;
  sourceContentHash: string;
  sourceRevisionId: string;
  resolutionMode: 'ANCHOR' | 'UNIQUE_EXCERPT';
}

export interface SpliceRewriteSelectionResult {
  splicedManuscript: string;
  beforeHash: string;
  afterHash: string;
  prefixLength: number;
  suffixLength: number;
  startOffset: number;
  endOffset: number;
  originalExcerpt: string;
  resolutionMode: 'ANCHOR' | 'UNIQUE_EXCERPT';
}

/**
 * Creates a verified selection anchor bound to exact UTF-16 offsets and content hash.
 */
export function createRewriteSelectionAnchor(params: {
  manuscript: string;
  startOffset: number;
  endOffset: number;
  sourceRevisionId?: string | null;
}): RewriteSelectionAnchor {
  const manuscript = typeof params.manuscript === 'string' ? params.manuscript : '';
  const { startOffset, endOffset } = params;

  if (
    !Number.isInteger(startOffset) ||
    !Number.isInteger(endOffset) ||
    startOffset < 0 ||
    endOffset <= startOffset ||
    endOffset > manuscript.length
  ) {
    throw new Error(
      `[INVALID_SELECTION_OFFSETS] 선택 구간 오프셋(${String(startOffset)}..${String(
        endOffset
      )})이 원고 범위(0..${manuscript.length})를 벗어났습니다.`
    );
  }

  return {
    sourceRevisionId: (params.sourceRevisionId || '').trim(),
    sourceContentHash: computeManuscriptContentHash(manuscript),
    startOffset,
    endOffset,
    originalExcerpt: manuscript.slice(startOffset, endOffset),
  };
}

/**
 * Validates either an explicit `RewriteSelectionAnchor` (exact revision, hash,
 * UTF-16 offsets, and slice match) OR a legacy `selectedTextToRewrite` ONLY when
 * it matches strictly once in the manuscript. Never falls back to whole-manuscript overwrite.
 */
export function validateRewriteSelectionTarget(params: {
  manuscript: string;
  anchor?: RewriteSelectionAnchor | null;
  selectedTextToRewrite?: string | null;
  currentRevisionId?: string | null;
}): ResolvedRewriteSelectionTarget {
  const manuscript = typeof params.manuscript === 'string' ? params.manuscript : '';
  const currentHash = computeManuscriptContentHash(manuscript);
  const currentRevisionId = (params.currentRevisionId || '').trim();
  const anchor = params.anchor;

  if (anchor) {
    const anchorRev = (anchor.sourceRevisionId || '').trim();
    if (currentRevisionId && anchorRev && anchorRev !== currentRevisionId) {
      throw new Error(
        `[STALE_REVISION_CONFLICT] 선택 구간의 기준 리비전(${anchorRev})이 현재 원고 리비전(${currentRevisionId})과 일치하지 않습니다.`
      );
    }

    const anchorHash = (anchor.sourceContentHash || '').trim();
    if (!anchorHash || anchorHash !== currentHash) {
      throw new Error(
        '[CONTENT_HASH_MISMATCH] 구간 선택 이후 원고 내용이 변경되었습니다. 최신 원고에서 수정할 구간을 다시 선택해 주세요.'
      );
    }

    if (
      !Number.isInteger(anchor.startOffset) ||
      !Number.isInteger(anchor.endOffset) ||
      anchor.startOffset < 0 ||
      anchor.endOffset <= anchor.startOffset ||
      anchor.endOffset > manuscript.length
    ) {
      throw new Error(
        `[INVALID_SELECTION_OFFSETS] 선택 구간 오프셋(${String(
          anchor.startOffset
        )}..${String(anchor.endOffset)})이 원고 길이(${manuscript.length})와 호환되지 않습니다.`
      );
    }

    if (typeof anchor.originalExcerpt !== 'string' || anchor.originalExcerpt.length === 0) {
      throw new Error(
        '[INVALID_SELECTION_OFFSETS] 선택 구간의 원문 발췌(originalExcerpt)가 비어 있습니다.'
      );
    }

    const actualSlice = manuscript.slice(anchor.startOffset, anchor.endOffset);
    if (actualSlice !== anchor.originalExcerpt) {
      throw new Error(
        '[SELECTION_EXCERPT_MISMATCH] 선택 구간 오프셋의 실제 원고 텍스트가 요청된 원문 발췌와 일치하지 않습니다.'
      );
    }

    return {
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
      originalExcerpt: anchor.originalExcerpt,
      sourceContentHash: currentHash,
      sourceRevisionId: anchorRev || currentRevisionId,
      resolutionMode: 'ANCHOR',
    };
  }

  const targetText =
    typeof params.selectedTextToRewrite === 'string'
      ? params.selectedTextToRewrite
      : '';
  if (!targetText || targetText.trim().length === 0) {
    throw new Error(
      '[MISSING_REWRITE_TARGET] 부분 재작성을 위한 선택 구간(anchor 또는 selectedTextToRewrite)이 지정되지 않았습니다.'
    );
  }

  const firstIdx = manuscript.indexOf(targetText);
  if (firstIdx === -1) {
    throw new Error(
      '[SELECTION_NOT_FOUND] 선택된 텍스트가 현재 원고에서 정확히 발견되지 않았습니다. 원고 보호를 위해 전체 덮어쓰기를 차단했습니다.'
    );
  }

  const secondIdx = manuscript.indexOf(targetText, firstIdx + 1);
  if (secondIdx !== -1) {
    throw new Error(
      '[AMBIGUOUS_DUPLICATE_SELECTION] 동일한 문구가 원고 내 여러 위치에 존재합니다. 중복 치환을 방지하기 위해 편집기에서 정확한 구간(offset anchor)을 다시 지정해 주세요.'
    );
  }

  return {
    startOffset: firstIdx,
    endOffset: firstIdx + targetText.length,
    originalExcerpt: targetText,
    sourceContentHash: currentHash,
    sourceRevisionId: currentRevisionId,
    resolutionMode: 'UNIQUE_EXCERPT',
  };
}

/**
 * Performs P0-A verified slice replacement and proves non-selected prefix/suffix invariance.
 */
export function validateAndSpliceRewriteSelection(params: {
  manuscript: string;
  replacementText: string;
  anchor?: RewriteSelectionAnchor | null;
  selectedTextToRewrite?: string | null;
  currentRevisionId?: string | null;
}): SpliceRewriteSelectionResult {
  const manuscript = typeof params.manuscript === 'string' ? params.manuscript : '';
  const replacementText = params.replacementText;

  if (typeof replacementText !== 'string' || replacementText.trim().length === 0) {
    throw new Error(
      '[EMPTY_REPLACEMENT_TEXT] 교체할 재작성 본문이 비어 있어 원고를 손상시키지 않고 중단했습니다.'
    );
  }

  const target = validateRewriteSelectionTarget({
    manuscript,
    anchor: params.anchor,
    selectedTextToRewrite: params.selectedTextToRewrite,
    currentRevisionId: params.currentRevisionId,
  });

  const prefix = manuscript.slice(0, target.startOffset);
  const suffix = manuscript.slice(target.endOffset);
  const splicedManuscript = `${prefix}${replacementText}${suffix}`;

  const prefixPreserved = splicedManuscript.slice(0, prefix.length) === prefix;
  const suffixPreserved =
    suffix.length === 0
      ? splicedManuscript.length === prefix.length + replacementText.length
      : splicedManuscript.slice(splicedManuscript.length - suffix.length) === suffix;
  const middleMatches =
    splicedManuscript.slice(prefix.length, prefix.length + replacementText.length) ===
    replacementText;

  if (!prefixPreserved || !suffixPreserved || !middleMatches) {
    throw new Error(
      '[POST_SPLICE_INTEGRITY_FAILED] 부분 치환 후 비선택 영역 보존 검증에 실패하여 원고 반영을 중단했습니다.'
    );
  }

  return {
    splicedManuscript,
    beforeHash: target.sourceContentHash,
    afterHash: computeManuscriptContentHash(splicedManuscript),
    prefixLength: prefix.length,
    suffixLength: suffix.length,
    startOffset: target.startOffset,
    endOffset: target.endOffset,
    originalExcerpt: target.originalExcerpt,
    resolutionMode: target.resolutionMode,
  };
}
