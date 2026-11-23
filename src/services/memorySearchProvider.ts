import type {
  CanonStatus,
  Character,
  CharacterRelationship,
  DataProvenance,
  EmbeddingGenerationMode,
  Episode,
  Foreshadowing,
  MemoryCanonFilterType,
  MemoryChunk,
  MemoryDocument,
  MemoryEntityLifecycleStatus,
  MemoryIndexStatus,
  MemorySearchMode,
  MemorySourceEntityType,
  MemorySourceFreshness,
  Project,
  RagActivationMode,
  Scene,
  TimelineEvent,
  WorldbuildingItem,
} from '../types/novel';
import { generateEntityId } from '../utils/novelLogic';
import {
  FOUNDATION_CONSTRAINTS,
  normalizeToCanonStatus,
  sanitizeIdArray,
  sanitizeStringTags,
} from '../utils/foundationLogic';

export const DETERMINISTIC_TEST_EMBEDDING_MODEL_ID =
  'deterministic-test-hash-v1' as const;

export const RAG_ENGINE_DEFAULTS = {
  INDEX_VERSION: 3,
  DEFAULT_EMBEDDING_MODEL: 'gemini-embedding-2',
  DETERMINISTIC_TEST_EMBEDDING_MODEL: DETERMINISTIC_TEST_EMBEDDING_MODEL_ID,
  FALLBACK_EMBEDDING_MODELS: [
    'gemini-embedding-2',
    'gemini-embedding-001',
  ] as const,
  DEFAULT_EMBEDDING_DIMENSION: 768,
  DEFAULT_MAX_CHUNK_CHARS: 800,
  MAX_CHUNKS_PER_DOCUMENT_PART: FOUNDATION_CONSTRAINTS.MEMORY_DOCUMENT.CHUNK_COUNT_MAX,
  EMBEDDING_COST_PER_1K_TOKENS_USD: 0.000025,
  DEFAULT_RRF_K: 10,
} as const;

export type RagExecutionSearchStatus =
  | 'FIRESTORE_VECTOR_HYBRID'
  | 'FIRESTORE_VECTOR_ONLY'
  | 'KEYWORD_ONLY'
  | 'LOCAL_FALLBACK'
  | 'SEARCH_FAILED';

export const LARGE_SCALE_RAG_TX_OP_THRESHOLD = 200;

function computeShortIdHash8(raw: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function buildGenerationScopedDocId(
  logicalDocId: string,
  generation: number
): string {
  const safeBase = (logicalDocId || 'memdoc').replace(/[^a-zA-Z0-9_-]/g, '_');
  const genNum = Math.max(1, Math.floor(generation));
  const suffix = `__g${genNum}`;
  if (safeBase.length + suffix.length <= 128) {
    return `${safeBase}${suffix}`;
  }
  const hash = computeShortIdHash8(safeBase);
  const keepLen = Math.max(8, 128 - suffix.length - hash.length - 1);
  return `${safeBase.slice(0, keepLen)}_${hash}${suffix}`;
}

export function buildGenerationScopedChunkId(
  physicalDocId: string,
  chunkIndex: number
): string {
  const safeDoc = (physicalDocId || 'memdoc').replace(/[^a-zA-Z0-9_-]/g, '_');
  const suffix = `_chk_${Math.max(0, Math.floor(chunkIndex))}`;
  if (safeDoc.length + suffix.length <= 128) {
    return `${safeDoc}${suffix}`;
  }
  const hash = computeShortIdHash8(`${safeDoc}${suffix}`);
  const keepLen = Math.max(8, 128 - suffix.length - hash.length - 1);
  return `${safeDoc.slice(0, keepLen)}_${hash}${suffix}`;
}

export interface ExternalFirestoreVectorCandidate {
  chunkId: string;
  documentId?: string;
  ownerId: string;
  projectId: string;
  vectorScore: number;
  vectorRank: number;
  embeddingModelId?: string;
  embeddingGenerationMode?: EmbeddingGenerationMode;
  embeddingDimension?: number;
  indexGeneration?: number;
  isActiveGeneration?: boolean;
  activationMode?: RagActivationMode;
  lifecycleStatus?: MemoryEntityLifecycleStatus;
  canonStatus?: CanonStatus;
  chunkSnapshot?: MemoryChunk;
  documentSnapshot?: MemoryDocument;
}

export interface EntityIndexLifecycleState {
  entityKey: string; // `${ownerId}:${projectId}:${sourceEntityType}:${sourceEntityId}`
  ownerId: string;
  projectId: string;
  sourceEntityType: MemorySourceEntityType;
  sourceEntityId: string;
  activeGeneration: number;
  activeRevisionId: string;
  activeSourceRevisionId?: string;
  activeContentHash?: string;
  activeTaskId?: string;
  activeLeaseGeneration?: number;
  activationToken?: string;
  activationMode?: RagActivationMode;
  stagingId?: string;
  activeDocumentIds: string[];
  activeChunkCount: number;
  lifecycleStatus: MemoryEntityLifecycleStatus;
  deletionTombstoneGeneration: number;
  deletionRequestedAt?: string;
  updatedAt: string;
}

export interface SemanticChunkWithOffset {
  chunkIndex: number;
  text: string;
  sourceStartOffset: number;
  sourceEndOffset: number;
}

export interface MemoryIndexInput {
  id?: string;
  ownerId: string;
  projectId: string;
  sourceEntityType: MemorySourceEntityType;
  sourceEntityId: string;
  sourceRevisionId?: string;
  sourceEpisodeId?: string;
  sourceSceneId?: string;
  episodeNumber?: number;
  title: string;
  fullText?: string;
  rawText?: string;
  summary?: string;
  canonStatus?: CanonStatus;
  canonFilterType?: MemoryCanonFilterType;
  episodeId?: string;
  sceneId?: string;
  characterIds?: string[];
  relatedCharacterIds?: string[];
  relatedEventIds?: string[];
  foreshadowingIds?: string[];
  relatedForeshadowingIds?: string[];
  keywords?: string[];
  keywordTags?: string[];
  maxChunkLength?: number;
  embeddingModelId?: string;
  embeddingDimension?: number;
  embeddingGenerationMode?: EmbeddingGenerationMode;
  precomputedEmbeddings?: number[][];
  partIndex?: number;
  totalParts?: number;
  requestedGeneration?: number;
  useGenerationScopedIds?: boolean;
  stagingId?: string;
  simulateVerificationFailure?: boolean;
  onDuringIndexingHook?: (ctx: {
    targetGeneration: number;
    oldActiveGeneration: number;
  }) => Promise<void> | void;
}

export interface MemoryIndexResult {
  document: MemoryDocument;
  chunks: MemoryChunk[];
  skippedAsUnchanged?: boolean;
  committedGeneration?: number;
  durableCommitVerified?: boolean;
  activeGenerationVerified?: boolean;
  firestoreBatchesCommitted?: number;
  stagingId?: string;
  activationMode?: RagActivationMode;
  largeScaleGenerationMode?: boolean;
  additionalParts?: {
    document: MemoryDocument;
    chunks: MemoryChunk[];
  }[];
}

export interface PreparedStagedIndexResult {
  skippedAsUnchanged: boolean;
  result: MemoryIndexResult;
  stagedParts: {
    document: MemoryDocument;
    chunks: MemoryChunk[];
  }[];
  targetGeneration: number;
  oldActiveGeneration: number;
  entityKey: string;
  projectKey: string;
  sourceRevisionId: string;
  contentHash: string;
  activationMode: RagActivationMode;
  largeScaleGenerationMode: boolean;
  nextEntityState: EntityIndexLifecycleState;
  latestProjectTombstoneGen: number;
  latestEntityDeletionTombstoneGen: number;
  ownerId: string;
  projectId: string;
  sourceEntityType: MemorySourceEntityType;
  sourceEntityId: string;
}

export interface LiveSourceSnapshotMap {
  /** Keyed by `${sourceEntityType}:${sourceEntityId}` or `sourceEntityId` */
  [entityKey: string]: {
    exists: boolean;
    latestRevisionId?: string;
    currentRevisionId?: string;
    canonStatus?: CanonStatus;
    fullText?: string;
    episodeNumber?: number;
  };
}

export interface MemorySearchQuery {
  ownerId?: string;
  projectId: string;
  queryText: string;
  limit?: number;
  topK?: number;
  searchMode?: MemorySearchMode;
  allowedCanonStatuses?: CanonStatus[];
  onlyCanon?: boolean;
  canonOnly?: boolean;
  includeNonCanonException?: boolean;
  includeNonCanonPlaceholder?: boolean;
  includeDrafts?: boolean;
  sourceEntityTypes?: MemorySourceEntityType[];
  episodeId?: string;
  episodeIdFilter?: string;
  minEpisodeNumber?: number;
  maxEpisodeNumber?: number;
  episodeNumberRange?: { min?: number; max?: number };
  characterId?: string;
  characterIds?: string[];
  eventId?: string;
  foreshadowingId?: string;
  queryEmbedding?: number[];
  queryEmbeddingModelId?: string;
  queryEmbeddingGenerationMode?: EmbeddingGenerationMode;
  liveSources?: LiveSourceSnapshotMap;
  excludeUnverifiedSources?: boolean;
  externalVectorCandidates?: ExternalFirestoreVectorCandidate[];
  rrfK?: number;
}

export interface MemorySearchHit {
  chunk: MemoryChunk;
  document: MemoryDocument;
  score: number;
  relevanceScore: number;
  keywordScore: number;
  semanticScore: number;
  vectorScore?: number;
  rrfScore?: number;
  vectorRank?: number;
  keywordRank?: number;
  retrievalSource?:
    | 'FIRESTORE_VECTOR_HYBRID'
    | 'FIRESTORE_VECTOR_ONLY'
    | 'KEYWORD_ONLY'
    | 'LOCAL_HYBRID';
  matchedTerms: string[];
  freshnessStatus: MemorySourceFreshness;
  verifiedForWriting: boolean;
  episodeNumber?: number;
}

export interface MemorySourceReference {
  document: MemoryDocument;
  chunks: MemoryChunk[];
  chunk?: MemoryChunk;
  provenance: DataProvenance;
  freshnessStatus: MemorySourceFreshness;
}

export interface IndexingScaleEstimate {
  projectId: string;
  targetDocumentCount: number;
  totalDocuments: number;
  estimatedChunkCount: number;
  estimatedChunks: number;
  totalCharCount: number;
  totalCharacters: number;
  estimatedTokenCount: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  requiresBulkConfirmation: boolean;
  requiresAuthorConfirmation: boolean;
  breakdownByType: Record<MemorySourceEntityType, number>;
}

export type BulkIndexingCostEstimate = IndexingScaleEstimate;

export interface ProjectRagStatusSummary {
  ownerId: string;
  projectId: string;
  totalDocuments: number;
  totalChunks: number;
  statusCounts: Record<MemoryIndexStatus, number>;
  canonDocumentCount: number;
  draftDocumentCount: number;
  nonCanonExceptionCount: number;
  embeddingModelId: string;
  embeddingDimension: number;
  embeddingGenerationMode: EmbeddingGenerationMode | 'MIXED' | 'NONE';
  liveEmbeddedChunkCount: number;
  deterministicTestChunkCount: number;
  cloudSemanticSearchReady: boolean;
  activeGenerationCounter: number;
  vectorSearchMode:
    | 'FIRESTORE_VECTOR_HYBRID'
    | 'FIRESTORE_VECTOR_ONLY'
    | 'FIRESTORE_FIND_NEAREST'
    | 'FIRESTORE_COSINE_FALLBACK'
    | 'KEYWORD_ONLY'
    | 'LOCAL_FALLBACK'
    | 'LOCAL_PERSISTENT_HYBRID'
    | 'DETERMINISTIC_TEST_FALLBACK'
    | 'SEARCH_FAILED';
  firestoreVectorIndexReady: boolean;
  modelMismatchRequiresReindex?: boolean;
  lastIndexedAt: string | null;
  documents?: MemoryDocument[];
}

/**
 * Mandatory interface for NOVEL FORGE long-term memory & RAG retrieval.
 */
export interface MemorySearchProvider {
  indexDocument(input: MemoryIndexInput): Promise<MemoryIndexResult>;
  deleteDocument(
    projectId: string,
    documentId: string,
    ownerId?: string
  ): Promise<boolean>;
  search(query: MemorySearchQuery): Promise<MemorySearchHit[]>;
  getSource(
    projectId: string,
    documentOrChunkId: string,
    ownerId?: string
  ): Promise<MemorySourceReference | null>;
}

// ============================================================================
// 1. Deterministic Content Hashing (Cross-Platform 64-bit FNV-1a Hex)
// ============================================================================

export function computeMemoryContentHash(text: string): string {
  const normalized = (text ?? '').replace(/\r\n/g, '\n').trim();
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code ^ (i & 0xff);
    h2 = Math.imul(h2, 0x01000193);
  }
  const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `h_${hex1}${hex2}_${normalized.length}`;
}

// ============================================================================
// 2. Scene & Paragraph-Preserving Semantic Chunker with Exact Offsets
//    (Fixes previous `.slice(0, CHUNK_COUNT_MAX)` truncation bug)
// ============================================================================

/**
 * Splits manuscript or lore text into semantic chunks while:
 * 1. Preserving scene separators (`* * *`, `---`, `===`, `# `) and paragraph boundaries (`\n\n`).
 * 2. Recording exact `sourceStartOffset` and `sourceEndOffset` in the original string.
 * 3. NEVER silently truncating trailing text when chunk count exceeds 500.
 */
export function splitTextIntoSemanticChunksWithOffsets(
  fullText: string,
  maxChunkChars: number = RAG_ENGINE_DEFAULTS.DEFAULT_MAX_CHUNK_CHARS,
  options?: {
    strictMaxChunks?: number;
  }
): SemanticChunkWithOffset[] {
  const raw = fullText ?? '';
  if (!raw.trim()) return [];

  const safeMaxChars = Math.max(
    20,
    Math.min(FOUNDATION_CONSTRAINTS.MEMORY_CHUNK.CONTENT_MAX, maxChunkChars)
  );

  // Split by paragraph breaks (\n\n+) while tracking exact character offsets in `raw`
  const paragraphSpans: { text: string; start: number; end: number; isSceneBreak: boolean }[] = [];
  const paraRegex = /[^\n]+(?:\n(?!\n)[^\n]+)*/g;
  let match: RegExpExecArray | null;

  while ((match = paraRegex.exec(raw)) !== null) {
    const segment = match[0];
    const startOffset = match.index;
    const endOffset = startOffset + segment.length;

    // Trim leading/trailing whitespace on the span while adjusting exact offsets
    const leadingWsMatch = segment.match(/^\s*/);
    const trailingWsMatch = segment.match(/\s*$/);
    const leadLen = leadingWsMatch ? leadingWsMatch[0].length : 0;
    const trailLen = trailingWsMatch ? trailingWsMatch[0].length : 0;
    const trimmedStart = startOffset + leadLen;
    const trimmedEnd = Math.max(trimmedStart, endOffset - trailLen);
    const trimmedText = raw.slice(trimmedStart, trimmedEnd);

    if (!trimmedText) continue;

    const isSceneBreak =
      /^(\*\s*\*\s*\*|-{3,}|={3,}|#{1,3}\s+|\[제?\d+장면)/.test(trimmedText);

    paragraphSpans.push({
      text: trimmedText,
      start: trimmedStart,
      end: trimmedEnd,
      isSceneBreak,
    });
  }

  const results: SemanticChunkWithOffset[] = [];
  let bufferStart = -1;
  let bufferEnd = -1;

  const flushBuffer = () => {
    if (bufferStart >= 0 && bufferEnd > bufferStart) {
      const sliceText = raw.slice(bufferStart, bufferEnd);
      if (sliceText.trim().length > 0) {
        results.push({
          chunkIndex: results.length,
          text: sliceText,
          sourceStartOffset: bufferStart,
          sourceEndOffset: bufferEnd,
        });
      }
    }
    bufferStart = -1;
    bufferEnd = -1;
  };

  for (const span of paragraphSpans) {
    // If this paragraph starts a new scene, flush existing buffer first to preserve scene boundary
    if (span.isSceneBreak && bufferStart >= 0) {
      flushBuffer();
    }

    if (bufferStart >= 0) {
      const candidateLength = span.end - bufferStart;
      if (candidateLength <= safeMaxChars) {
        bufferEnd = span.end;
        continue;
      } else {
        flushBuffer();
      }
    }

    // Now buffer is empty; check if `span` itself fits within `safeMaxChars`
    const spanLen = span.end - span.start;
    if (spanLen <= safeMaxChars) {
      bufferStart = span.start;
      bufferEnd = span.end;
    } else {
      // Split an oversized single paragraph on sentence boundaries (or character window as last resort)
      let cursor = span.start;
      while (cursor < span.end) {
        let sliceEnd = Math.min(span.end, cursor + safeMaxChars);
        if (sliceEnd < span.end) {
          // Try to find a natural sentence break (. ! ? 다. 요. 죠. \n) in the last 35% of the window
          const windowText = raw.slice(cursor, sliceEnd);
          const minBreakPos = Math.floor(windowText.length * 0.65);
          let bestBreakOffset = -1;
          for (let idx = windowText.length - 1; idx >= minBreakPos; idx--) {
            const ch = windowText[idx];
            if (ch === '\n' || ch === '.' || ch === '!' || ch === '?' || ch === '”' || ch === '"') {
              bestBreakOffset = idx + 1;
              break;
            }
          }
          if (bestBreakOffset > 0) {
            sliceEnd = cursor + bestBreakOffset;
          }
        }

        // Advance past leading whitespace
        while (cursor < sliceEnd && /\s/.test(raw[cursor])) {
          cursor++;
        }
        let cleanEnd = sliceEnd;
        while (cleanEnd > cursor && /\s/.test(raw[cleanEnd - 1])) {
          cleanEnd--;
        }

        if (cleanEnd > cursor) {
          results.push({
            chunkIndex: results.length,
            text: raw.slice(cursor, cleanEnd),
            sourceStartOffset: cursor,
            sourceEndOffset: cleanEnd,
          });
        }
        cursor = sliceEnd;
      }
    }
  }

  flushBuffer();

  if (
    options?.strictMaxChunks &&
    results.length > options.strictMaxChunks
  ) {
    throw new Error(
      `원고 청크 개수(${results.length}개)가 단일 문서 최대 허용치(${options.strictMaxChunks}개)를 초과했습니다. 자동 분할 색인(Multi-part Document Indexing)을 사용하세요.`
    );
  }

  return results;
}

/**
 * Backward-compatible helper that returns chunk strings without silently truncating trailing text.
 */
export function splitTextIntoMemoryChunks(
  fullText: string,
  maxChunkChars: number = RAG_ENGINE_DEFAULTS.DEFAULT_MAX_CHUNK_CHARS
): string[] {
  return splitTextIntoSemanticChunksWithOffsets(fullText, maxChunkChars).map(
    (c) => c.text
  );
}

/**
 * Partitions a large array of semantic chunks into bounded multi-part document groups
 * (each <= 500 chunks) so no trailing manuscript text is ever dropped.
 */
export function partitionChunksIntoDocumentParts(
  chunks: SemanticChunkWithOffset[],
  maxChunksPerDoc: number = RAG_ENGINE_DEFAULTS.MAX_CHUNKS_PER_DOCUMENT_PART
): SemanticChunkWithOffset[][] {
  if (chunks.length === 0) return [];
  const safeLimit = Math.max(1, maxChunksPerDoc);
  const parts: SemanticChunkWithOffset[][] = [];
  for (let i = 0; i < chunks.length; i += safeLimit) {
    const slice = chunks.slice(i, i + safeLimit).map((chk, localIdx) => ({
      ...chk,
      chunkIndex: localIdx,
    }));
    parts.push(slice);
  }
  return parts;
}

// ============================================================================
// 3. Korean-Aware Search Tokenizer, Stemmer & Semantic Concept Synonyms
// ============================================================================

const KOREAN_PARTICLES_SUFFIXES = [
  '에서부터',
  '으로부터',
  '에게서',
  '한테서',
  '이라도',
  '라고는',
  '이라는',
  '에서는',
  '으로는',
  '에게로',
  '처럼은',
  '까지의',
  '부터의',
  '에서',
  '에게',
  '한테',
  '으로',
  '로써',
  '로서',
  '보다',
  '처럼',
  '만큼',
  '까지',
  '부터',
  '조차',
  '마저',
  '이나',
  '이란',
  '이라',
  '라고',
  '하고',
  '이며',
  '이고',
  '이나',
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '의',
  '에',
  '로',
  '와',
  '과',
  '도',
  '만',
];

const KOREAN_VERB_ENDINGS = [
  '하였습니다',
  '되었습니다',
  '했습니다',
  '됐습니다',
  '있었습니다',
  '없었습니다',
  '입었습니다',
  '당했습니다',
  '하였다',
  '되었다',
  '있었다',
  '없었다',
  '입었다',
  '당했다',
  '했다',
  '됐다',
  '한다',
  '된다',
  '하는',
  '되는',
  '하고',
  '되고',
  '하여',
  '해서',
  '되어',
  '돼서',
  '했던',
  '됐던',
  '입은',
  '당한',
];

/**
 * Domain-specific semantic synonym groups for Korean fantasy web novels.
 * Enables both keyword expansion and deterministic semantic concept matching
 * when exact words differ (e.g., "다쳤던" <-> "부상/골절/상처", "맹세" <-> "서약/약속").
 */
export const KOREAN_NOVEL_SEMANTIC_CLUSTERS: {
  conceptId: string;
  terms: string[];
}[] = [
  {
    conceptId: 'concept_injury',
    terms: [
      '부상',
      '상처',
      '골절',
      '출혈',
      '마비',
      '중상',
      '치명상',
      '흉터',
      '다쳤',
      '다친',
      '부러진',
      '부러졌',
      '오른팔',
      '왼팔',
      '어깨',
      '내상',
      '통증',
      '피흘',
    ],
  },
  {
    conceptId: 'concept_oath_promise',
    terms: [
      '맹세',
      '서약',
      '약속',
      '다짐',
      '계약',
      '혈서',
      '서원',
      '맹약',
      '지키기로',
    ],
  },
  {
    conceptId: 'concept_betrayal',
    terms: [
      '배신',
      '변절',
      '반역',
      '밀고',
      '함정',
      '배반',
      '기만',
      '속였',
      '속인',
      '등을돌',
    ],
  },
  {
    conceptId: 'concept_relic_item',
    terms: [
      '유물',
      '성물',
      '보구',
      '아티팩트',
      '검',
      '성검',
      '마검',
      '반지',
      '목걸이',
      '갑주',
      '열쇠',
      '비전서',
      '마도서',
    ],
  },
  {
    conceptId: 'concept_seal_barrier',
    terms: [
      '봉인',
      '결계',
      '구속',
      '차단',
      '금제',
      '해제',
      '파쇄',
      '균열',
      '개방',
      '잠금',
    ],
  },
  {
    conceptId: 'concept_magic_mana',
    terms: [
      '마법',
      '마나',
      '에테르',
      '공명',
      '위계',
      '술식',
      '주문',
      '공간이동',
      '전이',
      '텔레포트',
      '성광',
      '정화',
    ],
  },
  {
    conceptId: 'concept_death_survival',
    terms: [
      '사망',
      '죽음',
      '전사',
      '생존',
      '살아남',
      '목숨',
      '숨졌',
      '고인',
      '부활',
      '소생',
    ],
  },
  {
    conceptId: 'concept_dialogue_speech',
    terms: [
      '대사',
      '말투',
      '외쳤',
      '말했',
      '속삭',
      '대답',
      '선언',
      '경고',
      '물었',
    ],
  },
];

export function normalizeKoreanToken(rawWord: string): string {
  let clean = rawWord
    .toLowerCase()
    .replace(/[^가-힣a-z0-9]/g, '')
    .trim();
  if (clean.length <= 1) return clean;

  for (const suffix of KOREAN_PARTICLES_SUFFIXES) {
    if (clean.length > suffix.length + 1 && clean.endsWith(suffix)) {
      clean = clean.slice(0, -suffix.length);
      break;
    }
  }

  for (const ending of KOREAN_VERB_ENDINGS) {
    if (clean.length > ending.length + 1 && clean.endsWith(ending)) {
      clean = clean.slice(0, -ending.length);
      break;
    }
  }

  return clean;
}

/**
 * Extracts normalized Korean/ASCII search terms, stems, and semantic concept IDs.
 */
export function tokenizeKoreanSearchTerms(text: string): {
  rawTokens: string[];
  normalizedStems: string[];
  expandedTerms: string[];
  conceptIds: string[];
} {
  const cleaned = (text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim();
  if (!cleaned) {
    return {
      rawTokens: [],
      normalizedStems: [],
      expandedTerms: [],
      conceptIds: [],
    };
  }

  const rawWords = cleaned.split(/\s+/).filter((w) => w.length >= 2);
  const stemSet = new Set<string>();
  const expandedSet = new Set<string>();
  const conceptSet = new Set<string>();

  for (const word of rawWords) {
    expandedSet.add(word);
    const stem = normalizeKoreanToken(word);
    if (stem.length >= 2) {
      stemSet.add(stem);
      expandedSet.add(stem);
    }
  }

  const joinedClean = cleaned.replace(/\s+/g, '');
  for (const cluster of KOREAN_NOVEL_SEMANTIC_CLUSTERS) {
    const matchedCluster = cluster.terms.some(
      (term) =>
        joinedClean.includes(term) ||
        Array.from(stemSet).some((s) => s.includes(term) || term.includes(s))
    );
    if (matchedCluster) {
      conceptSet.add(cluster.conceptId);
      for (const syn of cluster.terms) {
        expandedSet.add(syn);
      }
    }
  }

  return {
    rawTokens: rawWords,
    normalizedStems: Array.from(stemSet),
    expandedTerms: Array.from(expandedSet),
    conceptIds: Array.from(conceptSet),
  };
}

// ============================================================================
// 4. Deterministic Semantic Vector Embedding & Cosine Similarity
// ============================================================================

/**
 * Generates a normalized `dimension`-length semantic vector using character n-gram hashing
 * + Korean novel semantic concept cluster projections.
 * Used as a deterministic zero-latency fallback when Gemini Embedding API is not called
 * (e.g., in local offline mode or 1,000-episode synthetic benchmarks) and ensures
 * synonym queries (like "다쳤던 사건" -> "골절 부상") have high cosine similarity.
 */
export function computeDeterministicSemanticEmbedding(
  text: string,
  dimension: number = RAG_ENGINE_DEFAULTS.DEFAULT_EMBEDDING_DIMENSION
): number[] {
  const safeDim = Math.max(64, Math.min(3072, dimension));
  const vec = new Float64Array(safeDim);
  const tokenized = tokenizeKoreanSearchTerms(text);

  // 1. Project semantic concept clusters strongly into dedicated dimensions (0..31)
  KOREAN_NOVEL_SEMANTIC_CLUSTERS.forEach((cluster, clusterIdx) => {
    if (tokenized.conceptIds.includes(cluster.conceptId)) {
      const slotA = (clusterIdx * 3) % safeDim;
      const slotB = (clusterIdx * 3 + 1) % safeDim;
      const slotC = (clusterIdx * 3 + 2) % safeDim;
      vec[slotA] += 3.5;
      vec[slotB] += 2.8;
      vec[slotC] += 2.2;
    }
  });

  // 2. Project normalized stems with high weight
  for (const stem of tokenized.normalizedStems) {
    let h = 2166136261;
    for (let i = 0; i < stem.length; i++) {
      h ^= stem.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx1 = Math.abs(h) % safeDim;
    const idx2 = Math.abs(Math.imul(h, 31)) % safeDim;
    const sign = (h & 1) === 0 ? 1 : -1;
    vec[idx1] += 2.5 * sign;
    vec[idx2] += 1.75;

    // Character 2-grams of stem for morphological resilience
    for (let i = 0; i < stem.length - 1; i++) {
      const bg = stem.charCodeAt(i) * 313 + stem.charCodeAt(i + 1);
      const bgIdx = Math.abs(bg) % safeDim;
      vec[bgIdx] += 1.1;
    }
  }

  // 3. L2 normalize the vector so cosine similarity is a simple dot product
  let normSq = 0;
  for (let i = 0; i < safeDim; i++) {
    normSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(normSq);
  if (norm === 0) {
    return Array.from(vec);
  }
  const normalized: number[] = new Array(safeDim);
  for (let i = 0; i < safeDim; i++) {
    normalized[i] = Number((vec[i] / norm).toFixed(6));
  }
  return normalized;
}

export function computeCosineSimilarity(
  vecA?: number[] | null,
  vecB?: number[] | null
): number {
  if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0) return 0;
  const len = Math.min(vecA.length, vecB.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA === 0 || normB === 0) return 0;
  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.max(0, Math.min(1, Number(sim.toFixed(6))));
}

/**
 * Checks whether a model ID represents a live Gemini embedding model (as opposed to deterministic test hash).
 */
export function isLiveGeminiEmbeddingModelId(modelId?: string | null): boolean {
  if (!modelId) return false;
  const normalized = modelId.trim().toLowerCase();
  return (
    normalized.startsWith('gemini-embedding') ||
    normalized.startsWith('text-embedding') ||
    normalized.startsWith('models/gemini-embedding') ||
    normalized.startsWith('models/text-embedding')
  );
}

/**
 * Phase 3 Section 13-3: Strict Separation of Live API vs Deterministic Test Embeddings.
 * - Never allows a `DETERMINISTIC_TEST` vector to be labeled with `gemini-embedding-2` or any live Gemini model ID.
 * - Never allows a `LIVE_API` vector to be created without actual precomputed live API vectors or with `deterministic-test-hash-v1`.
 */
export function validateAndResolveEmbeddingMetadata(params: {
  requestedMode?: EmbeddingGenerationMode;
  requestedModelId?: string;
  requestedDimension?: number;
  hasPrecomputedVectors: boolean;
}): {
  embeddingGenerationMode: EmbeddingGenerationMode;
  embeddingModelId: string;
  embeddingDimension: number;
} {
  const dimension =
    params.requestedDimension && params.requestedDimension >= 64
      ? params.requestedDimension
      : RAG_ENGINE_DEFAULTS.DEFAULT_EMBEDDING_DIMENSION;

  if (params.requestedMode === 'DETERMINISTIC_TEST') {
    if (
      params.requestedModelId &&
      isLiveGeminiEmbeddingModelId(params.requestedModelId)
    ) {
      throw new Error(
        `EMBEDDING_MODE_MODEL_CONFLICT: 테스트용 결정적 벡터(DETERMINISTIC_TEST)에 실제 Gemini 임베딩 모델 ID('${params.requestedModelId}')를 부여할 수 없습니다.`
      );
    }
    return {
      embeddingGenerationMode: 'DETERMINISTIC_TEST',
      embeddingModelId:
        params.requestedModelId?.trim() || DETERMINISTIC_TEST_EMBEDDING_MODEL_ID,
      embeddingDimension: dimension,
    };
  }

  if (params.requestedMode === 'LIVE_API') {
    if (!params.hasPrecomputedVectors) {
      throw new Error(
        'EMBEDDING_MODE_LIVE_VECTOR_MISSING: 실제 Gemini API 임베딩 벡터 없이 LIVE_API 생성 방식을 기록할 수 없습니다.'
      );
    }
    const modelId =
      params.requestedModelId?.trim() ||
      RAG_ENGINE_DEFAULTS.DEFAULT_EMBEDDING_MODEL;
    if (modelId === DETERMINISTIC_TEST_EMBEDDING_MODEL_ID) {
      throw new Error(
        `EMBEDDING_MODE_MODEL_CONFLICT: LIVE_API 임베딩에 테스트 모델 ID('${DETERMINISTIC_TEST_EMBEDDING_MODEL_ID}')를 사용할 수 없습니다.`
      );
    }
    return {
      embeddingGenerationMode: 'LIVE_API',
      embeddingModelId: modelId,
      embeddingDimension: dimension,
    };
  }

  // If mode was not explicitly specified:
  if (
    params.hasPrecomputedVectors &&
    params.requestedModelId &&
    params.requestedModelId !== DETERMINISTIC_TEST_EMBEDDING_MODEL_ID
  ) {
    return {
      embeddingGenerationMode: 'LIVE_API',
      embeddingModelId: params.requestedModelId.trim(),
      embeddingDimension: dimension,
    };
  }

  // Default fallback when using deterministic semantic embedding in local/test store:
  if (
    params.requestedModelId &&
    isLiveGeminiEmbeddingModelId(params.requestedModelId) &&
    !params.hasPrecomputedVectors
  ) {
    throw new Error(
      `EMBEDDING_MODE_MODEL_CONFLICT: 실제 임베딩 벡터 없이 결정적 테스트 벡터에 '${params.requestedModelId}' 모델 ID를 부여할 수 없습니다.`
    );
  }

  return {
    embeddingGenerationMode: 'DETERMINISTIC_TEST',
    embeddingModelId: DETERMINISTIC_TEST_EMBEDDING_MODEL_ID,
    embeddingDimension: dimension,
  };
}

/**
 * Verifies that a query vector and a chunk vector belong to the exact same embedding space
 * (`embeddingGenerationMode`, `embeddingModelId`, and `embeddingDimension`).
 * Prevents mixing `LIVE_API` Gemini vectors with `DETERMINISTIC_TEST` vectors.
 */
export function areEmbeddingsVectorSpaceCompatible(params: {
  chunkMode?: EmbeddingGenerationMode;
  chunkModelId?: string;
  chunkDimension?: number;
  queryMode?: EmbeddingGenerationMode;
  queryModelId?: string;
  queryDimension?: number;
}): boolean {
  const cMode: EmbeddingGenerationMode =
    params.chunkMode ||
    (isLiveGeminiEmbeddingModelId(params.chunkModelId)
      ? 'LIVE_API'
      : 'DETERMINISTIC_TEST');
  const qMode: EmbeddingGenerationMode =
    params.queryMode ||
    (isLiveGeminiEmbeddingModelId(params.queryModelId)
      ? 'LIVE_API'
      : 'DETERMINISTIC_TEST');

  if (cMode !== qMode) {
    return false;
  }

  const cModel =
    params.chunkModelId ||
    (cMode === 'LIVE_API'
      ? RAG_ENGINE_DEFAULTS.DEFAULT_EMBEDDING_MODEL
      : DETERMINISTIC_TEST_EMBEDDING_MODEL_ID);
  const qModel =
    params.queryModelId ||
    (qMode === 'LIVE_API'
      ? RAG_ENGINE_DEFAULTS.DEFAULT_EMBEDDING_MODEL
      : DETERMINISTIC_TEST_EMBEDDING_MODEL_ID);

  if (cModel !== qModel) {
    return false;
  }

  if (
    params.chunkDimension &&
    params.queryDimension &&
    params.chunkDimension !== params.queryDimension
  ) {
    return false;
  }

  return true;
}

// ============================================================================
// 5. Source & Revision Freshness Verifier (`FRESH` | `STALE` | `SOURCE_UNVERIFIED`)
// ============================================================================

/**
 * Verifies a MemoryChunk and its parent MemoryDocument against live project state (if provided).
 * - If `liveSources` is provided and the source entity is missing (`exists === false`),
 *   returns `'SOURCE_UNVERIFIED'`.
 * - If `liveSources` has a newer `latestRevisionId` that differs from `chunk.sourceRevisionId`,
 *   returns `'STALE'`.
 * - If `document.indexStatus === 'STALE'` or `'FAILED'` or `'PENDING_DELETE'`, returns `'STALE'` / `'SOURCE_UNVERIFIED'`.
 * - Otherwise returns `'FRESH'`.
 */
export function verifyChunkAgainstLiveSource(params: {
  chunk: MemoryChunk;
  document: MemoryDocument;
  liveSources?: LiveSourceSnapshotMap;
}): {
  freshnessStatus: MemorySourceFreshness;
  verifiedForWriting: boolean;
} {
  const { chunk, document, liveSources } = params;

  if (
    !chunk.documentId ||
    !chunk.sourceEntityId ||
    !chunk.sourceRevisionId ||
    document.indexStatus === 'FAILED' ||
    document.indexStatus === 'PENDING_DELETE' ||
    document.lifecycleStatus === 'PENDING_DELETE' ||
    document.lifecycleStatus === 'DELETED'
  ) {
    return {
      freshnessStatus: 'SOURCE_UNVERIFIED',
      verifiedForWriting: false,
    };
  }

  if (document.indexStatus === 'STALE') {
    return {
      freshnessStatus: 'STALE',
      verifiedForWriting: false,
    };
  }

  if (liveSources) {
    const compositeKey = `${chunk.sourceEntityType}:${chunk.sourceEntityId}`;
    const liveEntry =
      liveSources[compositeKey] ?? liveSources[chunk.sourceEntityId];

    if (liveEntry) {
      if (!liveEntry.exists) {
        return {
          freshnessStatus: 'SOURCE_UNVERIFIED',
          verifiedForWriting: false,
        };
      }
      const latestRev =
        liveEntry.latestRevisionId || liveEntry.currentRevisionId;
      if (
        latestRev &&
        chunk.sourceRevisionId &&
        latestRev !== chunk.sourceRevisionId
      ) {
        return {
          freshnessStatus: 'STALE',
          verifiedForWriting: false,
        };
      }
      if (
        liveEntry.canonStatus &&
        liveEntry.canonStatus !== document.canonStatus
      ) {
        return {
          freshnessStatus: 'STALE',
          verifiedForWriting: false,
        };
      }
      if (
        liveEntry.fullText &&
        typeof chunk.sourceStartOffset === 'number' &&
        typeof chunk.sourceEndOffset === 'number'
      ) {
        const liveSlice = liveEntry.fullText.slice(
          chunk.sourceStartOffset,
          chunk.sourceEndOffset
        );
        if (liveSlice !== chunk.content) {
          return {
            freshnessStatus: 'STALE',
            verifiedForWriting: false,
          };
        }
      }
    }
  }

  // Verify that the chunk's offset slice still matches document.fullText when fullText is present
  if (
    typeof chunk.sourceStartOffset === 'number' &&
    typeof chunk.sourceEndOffset === 'number' &&
    document.fullText &&
    chunk.sourceEndOffset <= document.fullText.length
  ) {
    const expectedSlice = document.fullText.slice(
      chunk.sourceStartOffset,
      chunk.sourceEndOffset
    );
    if (expectedSlice && expectedSlice !== chunk.content) {
      return {
        freshnessStatus: 'SOURCE_UNVERIFIED',
        verifiedForWriting: false,
      };
    }
  }

  return {
    freshnessStatus: 'FRESH',
    verifiedForWriting:
      document.canonStatus === 'CANON' &&
      chunk.canonStatus !== 'DRAFT' &&
      chunk.canonStatus !== 'PROPOSED',
  };
}

// ============================================================================
// 6. Hybrid Search Scoring & Reciprocal Rank Fusion (Keyword + Vector + Filters)
// ============================================================================

export function evaluateChunkHybridMatch(params: {
  chunk: MemoryChunk;
  document: MemoryDocument;
  tokenizedQuery: ReturnType<typeof tokenizeKoreanSearchTerms>;
  queryEmbedding?: number[];
  queryEmbeddingModelId?: string;
  queryEmbeddingGenerationMode?: EmbeddingGenerationMode;
  searchMode: MemorySearchMode;
}): {
  matched: boolean;
  score: number;
  keywordScore: number;
  semanticScore: number;
  matchedTerms: string[];
  vectorSpaceCompatible: boolean;
} {
  const {
    chunk,
    document,
    tokenizedQuery,
    queryEmbedding,
    queryEmbeddingModelId,
    queryEmbeddingGenerationMode,
    searchMode,
  } = params;
  const haystack = `${document.title} ${chunk.content} ${(chunk.keywords || []).join(' ')}`.toLowerCase();

  // 1. Keyword & Korean Stem Match Score
  const matchedTermsSet = new Set<string>();
  let directHits = 0;

  for (const stem of tokenizedQuery.normalizedStems) {
    if (haystack.includes(stem)) {
      directHits += 1;
      matchedTermsSet.add(stem);
    }
  }
  for (const raw of tokenizedQuery.rawTokens) {
    if (haystack.includes(raw)) {
      matchedTermsSet.add(raw);
    }
  }

  let synonymHits = 0;
  for (const expanded of tokenizedQuery.expandedTerms) {
    if (!matchedTermsSet.has(expanded) && haystack.includes(expanded)) {
      synonymHits += 1;
      matchedTermsSet.add(expanded);
    }
  }

  const stemCount = Math.max(1, tokenizedQuery.normalizedStems.length);
  const directRatio = Math.min(1, directHits / stemCount);
  const synonymBoost = Math.min(0.45, synonymHits * 0.15);
  const titleBoost = tokenizedQuery.normalizedStems.some((s) =>
    document.title.toLowerCase().includes(s)
  )
    ? 0.15
    : 0;

  const keywordScore =
    tokenizedQuery.rawTokens.length === 0
      ? 1
      : Number(Math.min(1, directRatio * 0.85 + synonymBoost + titleBoost).toFixed(4));

  // 2. Semantic Vector Similarity Score (Strict separation between LIVE_API and DETERMINISTIC_TEST)
  const chunkMode: EmbeddingGenerationMode =
    chunk.embeddingGenerationMode ||
    document.embeddingGenerationMode ||
    (isLiveGeminiEmbeddingModelId(chunk.embeddingModelId || document.embeddingModelId)
      ? 'LIVE_API'
      : 'DETERMINISTIC_TEST');
  const chunkModelId =
    chunk.embeddingModelId ||
    document.embeddingModelId ||
    (chunkMode === 'LIVE_API'
      ? RAG_ENGINE_DEFAULTS.DEFAULT_EMBEDDING_MODEL
      : DETERMINISTIC_TEST_EMBEDDING_MODEL_ID);

  const resolvedQueryMode: EmbeddingGenerationMode =
    queryEmbeddingGenerationMode ||
    (isLiveGeminiEmbeddingModelId(queryEmbeddingModelId)
      ? 'LIVE_API'
      : 'DETERMINISTIC_TEST');
  const resolvedQueryModelId =
    queryEmbeddingModelId ||
    (resolvedQueryMode === 'LIVE_API'
      ? RAG_ENGINE_DEFAULTS.DEFAULT_EMBEDDING_MODEL
      : DETERMINISTIC_TEST_EMBEDDING_MODEL_ID);

  const vectorSpaceCompatible = areEmbeddingsVectorSpaceCompatible({
    chunkMode,
    chunkModelId,
    chunkDimension: chunk.embeddingDimension || chunk.embedding?.length,
    queryMode: resolvedQueryMode,
    queryModelId: resolvedQueryModelId,
    queryDimension: queryEmbedding?.length,
  });

  let semanticScore = 0;
  if (vectorSpaceCompatible && queryEmbedding && queryEmbedding.length > 0) {
    const chunkVec =
      chunk.embedding && chunk.embedding.length > 0
        ? chunk.embedding
        : chunkMode === 'DETERMINISTIC_TEST'
        ? computeDeterministicSemanticEmbedding(
            `${document.title} ${chunk.content}`,
            queryEmbedding.length
          )
        : null;
    if (chunkVec) {
      semanticScore = Number(
        computeCosineSimilarity(queryEmbedding, chunkVec).toFixed(4)
      );
    }
  }

  // 3. Combine based on searchMode
  if (tokenizedQuery.rawTokens.length === 0) {
    return {
      matched: true,
      score: 1,
      keywordScore: 1,
      semanticScore: vectorSpaceCompatible ? 1 : 0,
      matchedTerms: [],
      vectorSpaceCompatible,
    };
  }

  const matchedTerms = Array.from(matchedTermsSet);

  if (searchMode === 'KEYWORD') {
    const matched = directHits > 0 || synonymHits > 0;
    return {
      matched,
      score: keywordScore,
      keywordScore,
      semanticScore,
      matchedTerms,
      vectorSpaceCompatible,
    };
  }

  if (searchMode === 'SEMANTIC') {
    if (!vectorSpaceCompatible) {
      return {
        matched: false,
        score: 0,
        keywordScore,
        semanticScore: 0,
        matchedTerms,
        vectorSpaceCompatible: false,
      };
    }
    const matched = semanticScore >= 0.22 || directHits > 0 || synonymHits > 0;
    const score = Number(
      Math.min(1, semanticScore * 0.8 + keywordScore * 0.2).toFixed(4)
    );
    return {
      matched,
      score,
      keywordScore,
      semanticScore,
      matchedTerms,
      vectorSpaceCompatible: true,
    };
  }

  // Default: HYBRID mode (Keyword + Semantic Vector + Concept expansion)
  const hasLexicalOrConceptMatch = directHits > 0 || synonymHits > 0;
  const hasStrongVectorMatch = vectorSpaceCompatible && semanticScore >= 0.28;
  const matched = hasLexicalOrConceptMatch || hasStrongVectorMatch;

  const hybridScore = Number(
    Math.min(
      1,
      keywordScore * 0.55 +
        semanticScore * 0.45 +
        (directHits > 0 && semanticScore >= 0.25 ? 0.12 : 0)
    ).toFixed(4)
  );

  return {
    matched,
    score: hybridScore,
    keywordScore,
    semanticScore,
    matchedTerms,
    vectorSpaceCompatible,
  };
}

// ============================================================================
// 7. 6 Indexing Targets Extractor & Scale/Cost Estimator
// ============================================================================

export function extractProjectMemoryIndexInputs(params: {
  ownerId: string;
  projectId?: string;
  project?: Project;
  characters: Character[];
  worldbuilding: WorldbuildingItem[];
  episodes: Episode[];
  scenes?: Scene[];
  timelineEvents?: TimelineEvent[];
  foreshadowings?: Foreshadowing[];
  relationships?: CharacterRelationship[];
  characterStateChanges?: {
    id?: string;
    episodeId: string;
    episodeNumber?: number;
    characterId?: string;
    characterName: string;
    stateChange: string;
    canonStatus?: CanonStatus;
    sourceRevisionId?: string;
  }[];
  includeDrafts?: boolean;
}): MemoryIndexInput[] {
  const {
    ownerId,
    characters,
    worldbuilding,
    episodes,
    scenes = [],
    timelineEvents = [],
    foreshadowings = [],
    relationships = [],
    characterStateChanges = [],
    includeDrafts = true,
  } = params;
  const projectId = params.projectId || params.project?.id || 'default_project';

  const inputs: MemoryIndexInput[] = [];

  // Target 1: 확정된 등장인물 설정 (CHARACTER)
  for (const ch of characters) {
    const canonStatus = normalizeToCanonStatus(ch.canonStatus ?? ch.status);
    if (!includeDrafts && canonStatus !== 'CANON') continue;
    const fullText = [
      `[등장인물] 이름: ${ch.name}`,
      `역할: ${ch.role} | 소속: ${ch.affiliation}`,
      ch.appearance ? `외형: ${ch.appearance}` : '',
      ch.personality ? `성격 및 말투: ${ch.personality}` : '',
      ch.background ? `배경 서사: ${ch.background}` : '',
      ch.abilities ? `능력 및 신체 상태: ${ch.abilities}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    if (!fullText.trim()) continue;

    inputs.push({
      id: `memdoc_${projectId}_CHARACTER_${ch.id}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
      ownerId,
      projectId,
      sourceEntityType: 'CHARACTER',
      sourceEntityId: ch.id,
      sourceRevisionId: ch.sourceRevisionId || `rev_char_${ch.updatedAt || 'v1'}`,
      title: `등장인물 설정: ${ch.name}`,
      fullText,
      canonStatus,
      canonFilterType: canonStatus === 'CANON' ? 'CANON' : 'DRAFT',
      characterIds: [ch.id],
      foreshadowingIds: ch.linkedForeshadowingIds || [],
      keywords: [ch.name, ch.role, ch.affiliation].filter(Boolean),
    });
  }

  // Target 2: 확정된 세계관 설정 (WORLDBUILDING)
  for (const wb of worldbuilding) {
    const canonStatus = normalizeToCanonStatus(wb.canonStatus ?? wb.status);
    if (!includeDrafts && canonStatus !== 'CANON') continue;
    const fullText = [
      `[세계관 설정] 제목: ${wb.title} (분류: ${wb.category})`,
      wb.summary ? `핵심 요약: ${wb.summary}` : '',
      wb.rules ? `절대 법칙 및 제약: ${wb.rules}` : '',
      wb.content ? `상세 설명:\n${wb.content}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    if (!fullText.trim()) continue;

    inputs.push({
      id: `memdoc_${projectId}_WORLDBUILDING_${wb.id}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
      ownerId,
      projectId,
      sourceEntityType: 'WORLDBUILDING',
      sourceEntityId: wb.id,
      sourceRevisionId: wb.sourceRevisionId || `rev_wb_${wb.updatedAt || 'v1'}`,
      title: `세계관 설정: ${wb.title}`,
      fullText,
      canonStatus,
      canonFilterType: canonStatus === 'CANON' ? 'CANON' : 'DRAFT',
      characterIds: wb.linkedCharacterIds || [],
      foreshadowingIds: wb.linkedForeshadowingIds || [],
      keywords: [wb.title, wb.category].filter(Boolean),
    });
  }

  // Target 3 & 4: 확정된 회차 원고 (EPISODE) & 회차별 사건 요약 (EPISODE_SUMMARY)
  for (const ep of episodes) {
    const canonStatus: CanonStatus =
      ep.canonStatus ?? (ep.status === 'confirmed' ? 'CANON' : 'DRAFT');
    if (!includeDrafts && canonStatus !== 'CANON') continue;
    const revId = ep.latestRevisionId || `rev_ep_${ep.id}_${ep.updatedAt || 'v1'}`;

    if (ep.content && ep.content.trim().length > 0) {
      const cleanEpTitle = ep.title.startsWith(`제${ep.episodeNumber}화`)
        ? ep.title
        : `제${ep.episodeNumber}화. ${ep.title}`;
      inputs.push({
        id: `memdoc_${projectId}_EPISODE_${ep.id}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
        ownerId,
        projectId,
        sourceEntityType: 'EPISODE',
        sourceEntityId: ep.id,
        sourceRevisionId: revId,
        sourceEpisodeId: ep.id,
        episodeId: ep.id,
        episodeNumber: ep.episodeNumber,
        title: cleanEpTitle,
        fullText: ep.content,
        canonStatus,
        canonFilterType: canonStatus === 'CANON' ? 'CANON' : 'DRAFT',
        characterIds: ep.linkedCharacterIds || [],
        relatedEventIds: ep.linkedEventIds || [],
        foreshadowingIds: ep.linkedForeshadowingIds || [],
        keywords: [`제${ep.episodeNumber}화`, ep.title].filter(Boolean),
      });
    }

    if (ep.synopsis && ep.synopsis.trim().length > 0) {
      inputs.push({
        id: `memdoc_${projectId}_EPISODE_SUMMARY_${ep.id}`.replace(
          /[^a-zA-Z0-9_-]/g,
          '_'
        ),
        ownerId,
        projectId,
        sourceEntityType: 'EPISODE_SUMMARY',
        sourceEntityId: ep.id,
        sourceRevisionId: revId,
        sourceEpisodeId: ep.id,
        episodeId: ep.id,
        episodeNumber: ep.episodeNumber,
        title: `제${ep.episodeNumber}화 사건 요약: ${ep.title}`,
        fullText: `[제${ep.episodeNumber}화 사건 요약 - ${ep.title}]\n${ep.synopsis}`,
        canonStatus,
        canonFilterType: canonStatus === 'CANON' ? 'CANON' : 'DRAFT',
        characterIds: ep.linkedCharacterIds || [],
        relatedEventIds: ep.linkedEventIds || [],
        foreshadowingIds: ep.linkedForeshadowingIds || [],
        keywords: [`제${ep.episodeNumber}화`, '사건요약', ep.title].filter(Boolean),
      });
    }
  }

  // Target 4B: 작품 연표 사건 (TIMELINE_EVENT)
  for (const ev of timelineEvents) {
    const canonStatus = normalizeToCanonStatus(ev.canonStatus);
    if (!includeDrafts && canonStatus !== 'CANON') continue;
    const ep = episodes.find((e) => e.id === ev.episodeId);
    const fullText = `[사건 기록] ${ev.title} (${ev.inUniverseDate || `순서 ${ev.chronologicalOrder}`})\n${ev.summary}`;
    inputs.push({
      id: `memdoc_${projectId}_TIMELINE_EVENT_${ev.id}`.replace(
        /[^a-zA-Z0-9_-]/g,
        '_'
      ),
      ownerId,
      projectId,
      sourceEntityType: 'TIMELINE_EVENT',
      sourceEntityId: ev.id,
      sourceRevisionId: ev.sourceRevisionId || `rev_ev_${ev.updatedAt || 'v1'}`,
      sourceEpisodeId: ev.episodeId,
      sourceSceneId: ev.sceneId,
      episodeId: ev.episodeId,
      episodeNumber: ep?.episodeNumber,
      sceneId: ev.sceneId,
      title: `사건 기록: ${ev.title}`,
      fullText,
      canonStatus,
      canonFilterType: canonStatus === 'CANON' ? 'CANON' : 'DRAFT',
      characterIds: ev.participantCharacterIds || [],
      relatedEventIds: [ev.id],
      foreshadowingIds: ev.linkedForeshadowingIds || [],
      keywords: [ev.title, ev.inUniverseDate].filter(Boolean),
    });
  }

  // Target 5: 장면별 핵심 내용 (SCENE)
  for (const sc of scenes) {
    const canonStatus = normalizeToCanonStatus(sc.canonStatus);
    if (!includeDrafts && canonStatus !== 'CANON') continue;
    const ep = episodes.find((e) => e.id === sc.episodeId);
    const fullText = `[제${ep?.episodeNumber || '?'}화 제${sc.sceneNumber}장면 - ${sc.title}]\n장소: ${sc.location || '미정'}\n핵심 내용: ${sc.summary}`;
    inputs.push({
      id: `memdoc_${projectId}_SCENE_${sc.id}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
      ownerId,
      projectId,
      sourceEntityType: 'SCENE',
      sourceEntityId: sc.id,
      sourceRevisionId: sc.sourceRevisionId || `rev_sc_${sc.updatedAt || 'v1'}`,
      sourceEpisodeId: sc.episodeId,
      sourceSceneId: sc.id,
      episodeId: sc.episodeId,
      episodeNumber: ep?.episodeNumber,
      sceneId: sc.id,
      title: `제${sc.sceneNumber}장면 핵심 내용: ${sc.title}`,
      fullText,
      canonStatus,
      canonFilterType: canonStatus === 'CANON' ? 'CANON' : 'DRAFT',
      characterIds: sc.characterIds || [],
      relatedEventIds: sc.eventIds || [],
      foreshadowingIds: sc.foreshadowingIds || [],
      keywords: [sc.title, sc.location].filter(Boolean),
    });
  }

  // Target 6: 이전 회차에서 확정된 인물 상태 변화 (CHARACTER_STATE_CHANGE) & 복선 (FORESHADOWING)
  for (let i = 0; i < characterStateChanges.length; i++) {
    const csc = characterStateChanges[i];
    const canonStatus = normalizeToCanonStatus(csc.canonStatus ?? 'CANON');
    if (!includeDrafts && canonStatus !== 'CANON') continue;
    const cscId = csc.id || `csc_${csc.episodeId}_${i + 1}`;
    const fullText = `[인물 상태 변화 - ${csc.characterName}] ${csc.stateChange}`;
    inputs.push({
      id: `memdoc_${projectId}_CHARACTER_STATE_CHANGE_${cscId}`.replace(
        /[^a-zA-Z0-9_-]/g,
        '_'
      ),
      ownerId,
      projectId,
      sourceEntityType: 'CHARACTER_STATE_CHANGE',
      sourceEntityId: cscId,
      sourceRevisionId: csc.sourceRevisionId || `rev_csc_${csc.episodeId}`,
      sourceEpisodeId: csc.episodeId,
      episodeId: csc.episodeId,
      episodeNumber: csc.episodeNumber,
      title: `인물 상태 변화: ${csc.characterName}`,
      fullText,
      canonStatus,
      canonFilterType: canonStatus === 'CANON' ? 'CANON' : 'DRAFT',
      characterIds: csc.characterId ? [csc.characterId] : [],
      keywords: [csc.characterName, '상태변화'].filter(Boolean),
    });
  }

  for (const fs of foreshadowings) {
    const canonStatus = normalizeToCanonStatus(fs.canonStatus);
    if (!includeDrafts && canonStatus !== 'CANON') continue;
    const ep = episodes.find((e) => e.id === fs.plantedEpisodeId);
    const fullText = `[복선 단서 - ${fs.title} (${fs.cluePhase})]\n${fs.description}`;
    inputs.push({
      id: `memdoc_${projectId}_FORESHADOWING_${fs.id}`.replace(
        /[^a-zA-Z0-9_-]/g,
        '_'
      ),
      ownerId,
      projectId,
      sourceEntityType: 'FORESHADOWING',
      sourceEntityId: fs.id,
      sourceRevisionId: fs.sourceRevisionId || `rev_fs_${fs.updatedAt || 'v1'}`,
      sourceEpisodeId: fs.plantedEpisodeId,
      sourceSceneId: fs.plantedSceneId,
      episodeId: fs.plantedEpisodeId,
      episodeNumber: ep?.episodeNumber,
      sceneId: fs.plantedSceneId,
      title: `복선 단서: ${fs.title}`,
      fullText,
      canonStatus,
      canonFilterType: canonStatus === 'CANON' ? 'CANON' : 'DRAFT',
      characterIds: fs.relatedCharacterIds || [],
      relatedEventIds: fs.relatedEventIds || [],
      foreshadowingIds: [fs.id],
      keywords: [fs.title, fs.cluePhase].filter(Boolean),
    });
  }

  // Target 7: 인물 관계 (RELATIONSHIP)
  for (const rel of relationships) {
    const canonStatus = normalizeToCanonStatus(rel.canonStatus);
    if (!includeDrafts && canonStatus !== 'CANON') continue;
    const srcChar = characters.find((c) => c.id === rel.sourceCharacterId);
    const tgtChar = characters.find((c) => c.id === rel.targetCharacterId);
    const srcName = srcChar?.name || rel.sourceCharacterId;
    const tgtName = tgtChar?.name || rel.targetCharacterId;
    const arrow = rel.isDirectional ? '→' : '↔';
    const ep = episodes.find((e) => e.id === rel.effectiveEpisodeId);
    const fullText = `[인물 관계] ${srcName} ${arrow} ${tgtName} | 관계 유형: ${rel.relationType} | 친밀도: ${rel.affinityScore}\n${rel.description}`;
    inputs.push({
      id: `memdoc_${projectId}_RELATIONSHIP_${rel.id}`.replace(
        /[^a-zA-Z0-9_-]/g,
        '_'
      ),
      ownerId,
      projectId,
      sourceEntityType: 'RELATIONSHIP',
      sourceEntityId: rel.id,
      sourceRevisionId:
        rel.sourceRevisionId || `rev_rel_${rel.updatedAt || 'v1'}`,
      sourceEpisodeId: rel.effectiveEpisodeId,
      episodeId: rel.effectiveEpisodeId,
      episodeNumber: ep?.episodeNumber,
      title: `인물 관계: ${srcName} ${arrow} ${tgtName} (${rel.relationType})`.slice(
        0,
        150
      ),
      fullText,
      canonStatus,
      canonFilterType: canonStatus === 'CANON' ? 'CANON' : 'DRAFT',
      characterIds: [rel.sourceCharacterId, rel.targetCharacterId].filter(
        Boolean
      ),
      relatedEventIds: rel.effectiveEventId ? [rel.effectiveEventId] : [],
      foreshadowingIds: [],
      keywords: [srcName, tgtName, rel.relationType].filter(Boolean),
    });
  }

  return inputs;
}

/**
 * Builds an authoritative `MemoryIndexInput` directly from a server-verified `CANON`
 * entity (`CharacterRelationship | TimelineEvent | Foreshadowing`) read from Firestore.
 * Returns `null` if the entity is not in `CANON` status.
 */
export function buildMemoryIndexInputFromApprovedEntity(params: {
  ownerId?: string;
  projectId?: string;
  targetEntityType: 'RELATIONSHIP' | 'TIMELINE_EVENT' | 'FORESHADOWING';
  entity: CharacterRelationship | TimelineEvent | Foreshadowing;
  characterNameMap?: Readonly<Record<string, string>>;
  episodeNumberMap?: Readonly<Record<string, number>>;
}): MemoryIndexInput | null {
  const {
    targetEntityType,
    entity,
    characterNameMap = {},
    episodeNumberMap = {},
  } = params;
  const ownerId = (params.ownerId || entity.ownerId || '').trim();
  const projectId = (params.projectId || entity.projectId || '').trim();
  const canonStatus = normalizeToCanonStatus(entity.canonStatus);

  if (canonStatus !== 'CANON') {
    return null;
  }

  if (targetEntityType === 'RELATIONSHIP') {
    const rel = entity as CharacterRelationship;
    const srcName =
      characterNameMap[rel.sourceCharacterId] || rel.sourceCharacterId;
    const tgtName =
      characterNameMap[rel.targetCharacterId] || rel.targetCharacterId;
    const arrow = rel.isDirectional ? '→' : '↔';
    const epNum = rel.effectiveEpisodeId
      ? episodeNumberMap[rel.effectiveEpisodeId]
      : undefined;
    const fullText = `[인물 관계] ${srcName} ${arrow} ${tgtName} | 관계 유형: ${rel.relationType} | 친밀도: ${rel.affinityScore}\n${rel.description}`;
    const charIds = [rel.sourceCharacterId, rel.targetCharacterId].filter(
      Boolean
    );
    return {
      id: `memdoc_${projectId}_RELATIONSHIP_${rel.id}`.replace(
        /[^a-zA-Z0-9_-]/g,
        '_'
      ),
      ownerId,
      projectId,
      sourceEntityType: 'RELATIONSHIP',
      sourceEntityId: rel.id,
      sourceRevisionId:
        rel.sourceRevisionId || `rev_rel_${rel.updatedAt || 'v1'}`,
      sourceEpisodeId: rel.effectiveEpisodeId,
      episodeId: rel.effectiveEpisodeId,
      episodeNumber: epNum,
      title: `인물 관계: ${srcName} ${arrow} ${tgtName} (${rel.relationType})`.slice(
        0,
        150
      ),
      fullText,
      rawText: fullText,
      summary: rel.description.slice(0, 380),
      canonStatus,
      canonFilterType: 'CANON',
      characterIds: charIds,
      relatedCharacterIds: charIds,
      relatedEventIds: rel.effectiveEventId ? [rel.effectiveEventId] : [],
      foreshadowingIds: [],
      keywords: [srcName, tgtName, rel.relationType].filter(Boolean),
      keywordTags: [srcName, tgtName, rel.relationType].filter(Boolean),
    };
  }

  if (targetEntityType === 'TIMELINE_EVENT') {
    const ev = entity as TimelineEvent;
    const epNum = ev.episodeId ? episodeNumberMap[ev.episodeId] : undefined;
    const fullText = `[사건 기록] ${ev.title} (${ev.inUniverseDate || `순서 ${ev.chronologicalOrder}`})\n${ev.summary}`;
    const charIds = ev.participantCharacterIds || [];
    return {
      id: `memdoc_${projectId}_TIMELINE_EVENT_${ev.id}`.replace(
        /[^a-zA-Z0-9_-]/g,
        '_'
      ),
      ownerId,
      projectId,
      sourceEntityType: 'TIMELINE_EVENT',
      sourceEntityId: ev.id,
      sourceRevisionId: ev.sourceRevisionId || `rev_ev_${ev.updatedAt || 'v1'}`,
      sourceEpisodeId: ev.episodeId,
      sourceSceneId: ev.sceneId,
      episodeId: ev.episodeId,
      episodeNumber: epNum,
      sceneId: ev.sceneId,
      title: `사건 기록: ${ev.title}`.slice(0, 150),
      fullText,
      rawText: fullText,
      summary: ev.summary.slice(0, 380),
      canonStatus,
      canonFilterType: 'CANON',
      characterIds: charIds,
      relatedCharacterIds: charIds,
      relatedEventIds: [ev.id],
      foreshadowingIds: ev.linkedForeshadowingIds || [],
      relatedForeshadowingIds: ev.linkedForeshadowingIds || [],
      keywords: [ev.title, ev.inUniverseDate].filter(Boolean),
      keywordTags: [ev.title, ev.inUniverseDate].filter(Boolean),
    };
  }

  const fs = entity as Foreshadowing;
  const epNum = fs.plantedEpisodeId
    ? episodeNumberMap[fs.plantedEpisodeId]
    : undefined;
  const fullText = `[복선 단서 - ${fs.title} (${fs.cluePhase})]\n${fs.description}`;
  const charIds = fs.relatedCharacterIds || [];
  return {
    id: `memdoc_${projectId}_FORESHADOWING_${fs.id}`.replace(
      /[^a-zA-Z0-9_-]/g,
      '_'
    ),
    ownerId,
    projectId,
    sourceEntityType: 'FORESHADOWING',
    sourceEntityId: fs.id,
    sourceRevisionId: fs.sourceRevisionId || `rev_fs_${fs.updatedAt || 'v1'}`,
    sourceEpisodeId: fs.plantedEpisodeId,
    sourceSceneId: fs.plantedSceneId,
    episodeId: fs.plantedEpisodeId,
    episodeNumber: epNum,
    sceneId: fs.plantedSceneId,
    title: `복선 단서: ${fs.title}`.slice(0, 150),
    fullText,
    rawText: fullText,
    summary: fs.description.slice(0, 380),
    canonStatus,
    canonFilterType: 'CANON',
    characterIds: charIds,
    relatedCharacterIds: charIds,
    relatedEventIds: fs.relatedEventIds || [],
    foreshadowingIds: [fs.id],
    relatedForeshadowingIds: [fs.id],
    keywords: [fs.title, fs.cluePhase].filter(Boolean),
    keywordTags: [fs.title, fs.cluePhase].filter(Boolean),
  };
}

export function estimateIndexingScaleAndCost(
  projectIdOrInputs: string | MemoryIndexInput[],
  maybeInputs?: MemoryIndexInput[]
): IndexingScaleEstimate {
  const inputs: MemoryIndexInput[] = Array.isArray(projectIdOrInputs)
    ? projectIdOrInputs
    : maybeInputs || [];
  const projectId: string =
    typeof projectIdOrInputs === 'string'
      ? projectIdOrInputs
      : inputs[0]?.projectId || 'default_project';

  const breakdownByType: Record<MemorySourceEntityType, number> = {
    EPISODE: 0,
    EPISODE_SUMMARY: 0,
    SCENE: 0,
    CHARACTER: 0,
    CHARACTER_STATE_CHANGE: 0,
    WORLDBUILDING: 0,
    TIMELINE_EVENT: 0,
    FORESHADOWING: 0,
    RELATIONSHIP: 0,
  };

  let totalCharCount = 0;
  let estimatedChunkCount = 0;

  for (const item of inputs) {
    breakdownByType[item.sourceEntityType] =
      (breakdownByType[item.sourceEntityType] || 0) + 1;
    const text = item.fullText ?? item.rawText ?? '';
    const len = text.length;
    totalCharCount += len;
    const chunks = splitTextIntoSemanticChunksWithOffsets(
      text,
      item.maxChunkLength ?? RAG_ENGINE_DEFAULTS.DEFAULT_MAX_CHUNK_CHARS
    );
    estimatedChunkCount += Math.max(1, chunks.length);
  }

  const estimatedTokenCount = Math.ceil(totalCharCount * 0.75);
  const estimatedCostUsd = Number(
    (
      (estimatedTokenCount / 1000) *
      RAG_ENGINE_DEFAULTS.EMBEDDING_COST_PER_1K_TOKENS_USD
    ).toFixed(6)
  );
  const requiresBulkConfirmation =
    inputs.length >= 10 || estimatedChunkCount >= 25;

  return {
    projectId,
    targetDocumentCount: inputs.length,
    totalDocuments: inputs.length,
    estimatedChunkCount,
    estimatedChunks: estimatedChunkCount,
    totalCharCount,
    totalCharacters: totalCharCount,
    estimatedTokenCount,
    estimatedTokens: estimatedTokenCount,
    estimatedCostUsd,
    requiresBulkConfirmation,
    requiresAuthorConfirmation: requiresBulkConfirmation,
    breakdownByType,
  };
}

// ============================================================================
// 8. Hardened FoundationMemorySearchStore (Atomic Generation Switching,
//    Pending-Delete Tombstones, Strict Embedding Separation & Ownership Isolation)
// ============================================================================

export class FoundationMemorySearchStore implements MemorySearchProvider {
  protected documents = new Map<string, MemoryDocument>();
  protected chunksByDocId = new Map<string, MemoryChunk[]>();
  protected entityStates = new Map<string, EntityIndexLifecycleState>();
  protected projectTombstones = new Map<
    string,
    { status: 'ACTIVE' | 'PENDING_DELETE' | 'DELETED'; tombstoneGen: number }
  >();
  protected generationCounter = 0;

  protected makeEntityKey(
    ownerId: string,
    projectId: string,
    sourceEntityType: MemorySourceEntityType,
    sourceEntityId: string
  ): string {
    return `${ownerId}:${projectId}:${sourceEntityType}:${sourceEntityId}`;
  }

  protected makeProjectKey(ownerId: string, projectId: string): string {
    return `${ownerId}:${projectId}`;
  }

  getActiveGenerationCounter(): number {
    return this.generationCounter;
  }

  setMinimumGenerationCounterFloor(minGen: number): void {
    if (typeof minGen === 'number' && Number.isFinite(minGen) && minGen > this.generationCounter) {
      this.generationCounter = Math.floor(minGen);
    }
  }

  getEntityLifecycleState(params: {
    ownerId: string;
    projectId: string;
    sourceEntityType: MemorySourceEntityType;
    sourceEntityId: string;
  }): EntityIndexLifecycleState | undefined {
    return this.entityStates.get(
      this.makeEntityKey(
        params.ownerId,
        params.projectId,
        params.sourceEntityType,
        params.sourceEntityId
      )
    );
  }

  /**
   * Loads pre-existing documents, chunks, and lifecycle manifest into the store
   * (used when hydrating from Firestore or persistent disk snapshot after server restart).
   */
  loadSnapshot(
    documents: MemoryDocument[],
    chunks: MemoryChunk[],
    options?: {
      entityStates?: EntityIndexLifecycleState[];
      generationCounter?: number;
    }
  ): void {
    this.documents.clear();
    this.chunksByDocId.clear();
    this.entityStates.clear();
    this.generationCounter = options?.generationCounter || 0;

    if (options?.entityStates) {
      for (const st of options.entityStates) {
        this.entityStates.set(st.entityKey, { ...st });
        if (st.activeGeneration > this.generationCounter) {
          this.generationCounter = st.activeGeneration;
        }
        if (st.deletionTombstoneGeneration > this.generationCounter) {
          this.generationCounter = st.deletionTombstoneGeneration;
        }
      }
    }

    for (const doc of documents) {
      const id = doc.id || doc.documentId || '';
      if (!id) continue;
      const gen = doc.indexGeneration ?? 1;
      if (gen > this.generationCounter) {
        this.generationCounter = gen;
      }

      const entityKey = this.makeEntityKey(
        doc.ownerId,
        doc.projectId,
        doc.sourceEntityType,
        doc.sourceEntityId
      );
      const existingEntityState = this.entityStates.get(entityKey);

      // On server restart hydration: never re-activate a document whose generation is older
      // than the recorded activeGeneration or deletionTombstoneGeneration!
      if (existingEntityState) {
        if (
          existingEntityState.lifecycleStatus === 'PENDING_DELETE' ||
          existingEntityState.lifecycleStatus === 'DELETED' ||
          gen <= existingEntityState.deletionTombstoneGeneration
        ) {
          continue;
        }
        if (
          existingEntityState.activeGeneration > 0 &&
          gen !== existingEntityState.activeGeneration
        ) {
          continue;
        }
      }

      const isManifestPointerActive = Boolean(
        existingEntityState &&
          existingEntityState.lifecycleStatus === 'ACTIVE' &&
          existingEntityState.activeGeneration > 0 &&
          gen === existingEntityState.activeGeneration &&
          Array.isArray(existingEntityState.activeDocumentIds) &&
          existingEntityState.activeDocumentIds.includes(id)
      );

      this.documents.set(id, {
        ...doc,
        id,
        documentId: id,
        indexGeneration: gen,
        isActiveGeneration: isManifestPointerActive
          ? true
          : doc.isActiveGeneration ?? true,
        lifecycleStatus: isManifestPointerActive
          ? 'ACTIVE'
          : doc.lifecycleStatus ?? 'ACTIVE',
      });

      if (!existingEntityState && doc.indexStatus === 'INDEXED') {
        this.entityStates.set(entityKey, {
          entityKey,
          ownerId: doc.ownerId,
          projectId: doc.projectId,
          sourceEntityType: doc.sourceEntityType,
          sourceEntityId: doc.sourceEntityId,
          activeGeneration: gen,
          activeRevisionId: doc.sourceRevisionId,
          activeContentHash: doc.contentHash,
          activationMode: doc.activationMode || 'INLINE_DOC',
          stagingId: doc.stagingId,
          activeDocumentIds: [id],
          activeChunkCount: doc.chunkCount,
          lifecycleStatus: 'ACTIVE',
          deletionTombstoneGeneration: 0,
          updatedAt: doc.updatedAt,
        });
      } else if (
        existingEntityState &&
        !options?.entityStates &&
        doc.indexStatus === 'INDEXED' &&
        gen === existingEntityState.activeGeneration &&
        !existingEntityState.activeDocumentIds.includes(id)
      ) {
        existingEntityState.activeDocumentIds.push(id);
        existingEntityState.activeChunkCount += doc.chunkCount;
      }
    }

    for (const chk of chunks) {
      const docId = chk.documentId;
      if (!docId || !this.documents.has(docId)) continue;
      const parentDoc = this.documents.get(docId)!;
      const entityKey = this.makeEntityKey(
        parentDoc.ownerId,
        parentDoc.projectId,
        parentDoc.sourceEntityType,
        parentDoc.sourceEntityId
      );
      const existingEntityState = this.entityStates.get(entityKey);
      const isManifestPointerActive = Boolean(
        existingEntityState &&
          existingEntityState.lifecycleStatus === 'ACTIVE' &&
          existingEntityState.activeGeneration > 0 &&
          (chk.indexGeneration ?? parentDoc.indexGeneration ?? 1) ===
            existingEntityState.activeGeneration &&
          Array.isArray(existingEntityState.activeDocumentIds) &&
          existingEntityState.activeDocumentIds.includes(docId)
      );

      const list = this.chunksByDocId.get(docId) || [];
      list.push({
        ...chk,
        id: chk.id || chk.chunkId || `${docId}_chk_${chk.chunkIndex}`,
        chunkId: chk.chunkId || chk.id || `${docId}_chk_${chk.chunkIndex}`,
        originalText: chk.originalText ?? chk.content,
        indexGeneration: chk.indexGeneration ?? parentDoc.indexGeneration ?? 1,
        isActiveGeneration: isManifestPointerActive
          ? true
          : chk.isActiveGeneration ?? true,
        lifecycleStatus: isManifestPointerActive
          ? 'ACTIVE'
          : chk.lifecycleStatus ?? 'ACTIVE',
        embeddingGenerationMode:
          chk.embeddingGenerationMode ??
          parentDoc.embeddingGenerationMode ??
          (isLiveGeminiEmbeddingModelId(chk.embeddingModelId)
            ? 'LIVE_API'
            : 'DETERMINISTIC_TEST'),
        relatedCharacterIds: chk.relatedCharacterIds ?? chk.characterIds,
        relatedForeshadowingIds:
          chk.relatedForeshadowingIds ?? chk.foreshadowingIds,
      });
      this.chunksByDocId.set(docId, list);
    }

    for (const [docId, list] of this.chunksByDocId.entries()) {
      list.sort((a, b) => a.chunkIndex - b.chunkIndex);
      this.chunksByDocId.set(docId, list);
    }
  }

  exportSnapshot(projectId?: string, ownerId?: string): {
    documents: MemoryDocument[];
    chunks: MemoryChunk[];
    entityStates: EntityIndexLifecycleState[];
    generationCounter: number;
  } {
    const documents: MemoryDocument[] = [];
    const chunks: MemoryChunk[] = [];
    const entityStates: EntityIndexLifecycleState[] = [];

    for (const st of this.entityStates.values()) {
      if (projectId && st.projectId !== projectId) continue;
      if (ownerId && st.ownerId !== ownerId) continue;
      entityStates.push({ ...st });
    }

    for (const [docId, doc] of this.documents.entries()) {
      if (projectId && doc.projectId !== projectId) continue;
      if (ownerId && doc.ownerId !== ownerId) continue;
      const entityKey = this.makeEntityKey(
        doc.ownerId,
        doc.projectId,
        doc.sourceEntityType,
        doc.sourceEntityId
      );
      const st = this.entityStates.get(entityKey);
      const isManifestPointerActive = Boolean(
        st &&
          st.lifecycleStatus === 'ACTIVE' &&
          st.activeGeneration === doc.indexGeneration &&
          Array.isArray(st.activeDocumentIds) &&
          st.activeDocumentIds.includes(doc.id) &&
          doc.activationMode === 'MANIFEST_POINTER'
      );
      if (
        doc.lifecycleStatus === 'PENDING_DELETE' ||
        doc.lifecycleStatus === 'DELETED' ||
        (doc.isActiveGeneration === false && !isManifestPointerActive)
      ) {
        continue;
      }
      documents.push(doc);
      const docChunks = this.chunksByDocId.get(docId) || [];
      chunks.push(...docChunks);
    }
    return {
      documents,
      chunks,
      entityStates,
      generationCounter: this.generationCounter,
    };
  }

  /**
   * Stage A helper: Prepares and validates staged MemoryDocuments & MemoryChunks without
   * mutating `this.documents`, `this.chunksByDocId`, or promoting `activeGeneration`.
   * For large-scale (> 200 total ops), generates immutable generation-scoped IDs and
   * marks `activationMode = 'MANIFEST_POINTER'`.
   */
  async prepareStagedIndexing(
    input: MemoryIndexInput,
    options?: {
      markLiveStateReindexingDuringPrepare?: boolean;
    }
  ): Promise<PreparedStagedIndexResult> {
    if (!input.ownerId || !input.ownerId.trim()) {
      throw new Error('색인 요청에 유효한 사용자 ID(ownerId)가 필요합니다.');
    }
    if (!input.projectId || !input.projectId.trim()) {
      throw new Error('색인 요청에 유효한 작품 ID(projectId)가 필요합니다.');
    }

    const nowIso = new Date().toISOString();
    const resolvedFullText = input.fullText ?? input.rawText ?? '';
    const canonStatus = normalizeToCanonStatus(input.canonStatus ?? 'CANON');
    const canonFilterType: MemoryCanonFilterType =
      input.canonFilterType ??
      (canonStatus === 'CANON' ? 'CANON' : 'DRAFT');
    const sourceRevisionId = input.sourceRevisionId || 'initial_revision';
    const hasPrecomputedVectors = Boolean(
      input.precomputedEmbeddings && input.precomputedEmbeddings.length > 0
    );

    const resolvedEmbeddingMeta = validateAndResolveEmbeddingMetadata({
      requestedMode: input.embeddingGenerationMode,
      requestedModelId: input.embeddingModelId,
      requestedDimension: input.embeddingDimension,
      hasPrecomputedVectors,
    });
    const {
      embeddingGenerationMode,
      embeddingModelId,
      embeddingDimension,
    } = resolvedEmbeddingMeta;

    const contentHash = computeMemoryContentHash(resolvedFullText);
    const entityKey = this.makeEntityKey(
      input.ownerId,
      input.projectId,
      input.sourceEntityType,
      input.sourceEntityId
    );
    const projectKey = this.makeProjectKey(input.ownerId, input.projectId);

    const baseDocId =
      input.id ||
      `memdoc_${input.projectId}_${input.sourceEntityType}_${input.sourceEntityId}`.replace(
        /[^a-zA-Z0-9_-]/g,
        '_'
      );

    const existingEntityState = this.entityStates.get(entityKey);
    const primaryActiveDocId = existingEntityState?.activeDocumentIds?.[0];
    const existingDoc =
      (primaryActiveDocId ? this.documents.get(primaryActiveDocId) : undefined) ||
      this.documents.get(baseDocId);

    if (
      existingDoc &&
      existingEntityState &&
      existingEntityState.lifecycleStatus === 'ACTIVE' &&
      existingDoc.ownerId === input.ownerId &&
      existingDoc.projectId === input.projectId &&
      existingDoc.sourceRevisionId === sourceRevisionId &&
      existingDoc.contentHash === contentHash &&
      existingDoc.embeddingModelId === embeddingModelId &&
      existingDoc.embeddingGenerationMode === embeddingGenerationMode &&
      existingDoc.canonStatus === canonStatus &&
      existingDoc.indexStatus === 'INDEXED'
    ) {
      const existingChunks = this.chunksByDocId.get(existingDoc.id) || [];
      const additionalParts: { document: MemoryDocument; chunks: MemoryChunk[] }[] = [];
      for (const extraDocId of existingEntityState.activeDocumentIds.slice(1)) {
        const extraDoc = this.documents.get(extraDocId);
        if (extraDoc) {
          additionalParts.push({
            document: extraDoc,
            chunks: this.chunksByDocId.get(extraDocId) || [],
          });
        }
      }
      const res: MemoryIndexResult = {
        document: existingDoc,
        chunks: existingChunks,
        skippedAsUnchanged: true,
        committedGeneration: existingEntityState.activeGeneration,
        activationMode: existingEntityState.activationMode || existingDoc.activationMode || 'INLINE_DOC',
        stagingId: existingEntityState.stagingId || existingDoc.stagingId,
        largeScaleGenerationMode:
          (existingEntityState.activationMode || existingDoc.activationMode) ===
          'MANIFEST_POINTER',
        additionalParts: additionalParts.length > 0 ? additionalParts : undefined,
      };
      return {
        skippedAsUnchanged: true,
        result: res,
        stagedParts: [
          { document: existingDoc, chunks: existingChunks },
          ...additionalParts,
        ],
        targetGeneration: existingEntityState.activeGeneration,
        oldActiveGeneration: existingEntityState.activeGeneration,
        entityKey,
        projectKey,
        sourceRevisionId,
        contentHash,
        activationMode: res.activationMode || 'INLINE_DOC',
        largeScaleGenerationMode: Boolean(res.largeScaleGenerationMode),
        nextEntityState: existingEntityState,
        latestProjectTombstoneGen: this.projectTombstones.get(projectKey)?.tombstoneGen ?? 0,
        latestEntityDeletionTombstoneGen:
          existingEntityState.deletionTombstoneGeneration ?? 0,
        ownerId: input.ownerId,
        projectId: input.projectId,
        sourceEntityType: input.sourceEntityType,
        sourceEntityId: input.sourceEntityId,
      };
    }

    const targetGeneration =
      typeof input.requestedGeneration === 'number'
        ? input.requestedGeneration
        : ++this.generationCounter;
    if (targetGeneration > this.generationCounter) {
      this.generationCounter = targetGeneration;
    }

    const oldActiveGeneration = existingEntityState?.activeGeneration ?? 0;
    const markReindexing =
      options?.markLiveStateReindexingDuringPrepare !== false;
    if (
      markReindexing &&
      existingEntityState &&
      existingEntityState.lifecycleStatus === 'ACTIVE'
    ) {
      existingEntityState.lifecycleStatus = 'REINDEXING_KEEP_OLD';
    }

    try {
      const allSemanticChunks = splitTextIntoSemanticChunksWithOffsets(
        resolvedFullText,
        input.maxChunkLength ?? RAG_ENGINE_DEFAULTS.DEFAULT_MAX_CHUNK_CHARS
      );

      const partitioned = partitionChunksIntoDocumentParts(
        allSemanticChunks,
        RAG_ENGINE_DEFAULTS.MAX_CHUNKS_PER_DOCUMENT_PART
      );
      const totalParts = Math.max(1, partitioned.length);
      const totalPlannedWriteOps = totalParts + allSemanticChunks.length;
      const largeScaleGenerationMode =
        Boolean(input.useGenerationScopedIds) ||
        totalPlannedWriteOps > LARGE_SCALE_RAG_TX_OP_THRESHOLD;
      const activationMode: RagActivationMode = largeScaleGenerationMode
        ? 'MANIFEST_POINTER'
        : 'INLINE_DOC';

      const stagedParts: {
        document: MemoryDocument;
        chunks: MemoryChunk[];
      }[] = [];

      const buildStagedPartRecord = (
        partChunks: SemanticChunkWithOffset[],
        partIndex: number
      ): { document: MemoryDocument; chunks: MemoryChunk[] } => {
        const logicalDocId =
          totalParts === 1 ? baseDocId : `${baseDocId}_part_${partIndex + 1}`;
        const docId = largeScaleGenerationMode
          ? buildGenerationScopedDocId(logicalDocId, targetGeneration)
          : logicalDocId;
        const sanitizedChars = sanitizeIdArray(
          input.characterIds ?? input.relatedCharacterIds
        );
        const sanitizedEvents = sanitizeIdArray(input.relatedEventIds);
        const sanitizedFs = sanitizeIdArray(
          input.foreshadowingIds ?? input.relatedForeshadowingIds
        );
        const baseKeywords = sanitizeStringTags(
          input.keywords ?? input.keywordTags
        );
        const episodeId = input.episodeId || input.sourceEpisodeId || '';
        const sceneId = input.sceneId || input.sourceSceneId || '';

        const chunks: MemoryChunk[] = partChunks.map((seg, idx) => {
          const chunkId = largeScaleGenerationMode
            ? buildGenerationScopedChunkId(docId, idx)
            : `${docId}_chk_${idx}`;
          const chunkText = seg.text.slice(
            0,
            FOUNDATION_CONSTRAINTS.MEMORY_CHUNK.CONTENT_MAX
          );
          const autoTokens = tokenizeKoreanSearchTerms(
            `${input.title} ${chunkText}`
          ).normalizedStems.slice(0, 15);
          const mergedKeywords = sanitizeStringTags([
            ...baseKeywords,
            ...autoTokens,
          ]);
          const globalChunkIdx =
            partIndex * RAG_ENGINE_DEFAULTS.MAX_CHUNKS_PER_DOCUMENT_PART + idx;
          const embedding =
            input.precomputedEmbeddings &&
            input.precomputedEmbeddings[globalChunkIdx]
              ? input.precomputedEmbeddings[globalChunkIdx]
              : computeDeterministicSemanticEmbedding(
                  `${input.title}\n${chunkText}`,
                  embeddingDimension
                );

          return {
            id: chunkId,
            chunkId,
            logicalDocumentId: logicalDocId,
            ownerId: input.ownerId,
            projectId: input.projectId,
            documentId: docId,
            sourceEntityType: input.sourceEntityType,
            sourceEntityId: input.sourceEntityId,
            sourceRevisionId,
            chunkIndex: idx,
            content: chunkText,
            chunkText,
            originalText: chunkText,
            embedding,
            embeddingModelId,
            embeddingDimension,
            embeddingGenerationMode,
            indexGeneration: targetGeneration,
            isActiveGeneration: true,
            activationMode,
            stagingId: input.stagingId,
            lifecycleStatus: 'ACTIVE',
            sourceStartOffset: seg.sourceStartOffset,
            sourceEndOffset: seg.sourceEndOffset,
            tokenEstimate: Math.ceil(chunkText.length * 0.75),
            keywords: mergedKeywords,
            episodeId,
            episodeNumber: input.episodeNumber,
            sceneId,
            characterIds: sanitizedChars,
            relatedCharacterIds: sanitizedChars,
            relatedEventIds: sanitizedEvents,
            foreshadowingIds: sanitizedFs,
            relatedForeshadowingIds: sanitizedFs,
            canonStatus,
            canonFilterType,
            contentHash: computeMemoryContentHash(chunkText),
            createdAt: nowIso,
          };
        });

        const partStartOffset = partChunks[0]?.sourceStartOffset ?? 0;
        const partEndOffset =
          partChunks[partChunks.length - 1]?.sourceEndOffset ??
          resolvedFullText.length;
        const partFullText = resolvedFullText
          .slice(partStartOffset, partEndOffset)
          .slice(0, FOUNDATION_CONSTRAINTS.MEMORY_DOCUMENT.FULL_TEXT_MAX);

        const document: MemoryDocument = {
          id: docId,
          documentId: docId,
          logicalDocumentId: logicalDocId,
          ownerId: input.ownerId,
          projectId: input.projectId,
          sourceEntityType: input.sourceEntityType,
          sourceEntityId: input.sourceEntityId,
          sourceRevisionId,
          sourceEpisodeId: episodeId,
          sourceSceneId: sceneId,
          episodeNumber: input.episodeNumber,
          title: (totalParts > 1
            ? `${input.title.trim()} (${partIndex + 1}/${totalParts})`
            : input.title.trim()
          ).slice(0, FOUNDATION_CONSTRAINTS.MEMORY_DOCUMENT.TITLE_MAX),
          summary: (input.summary || partFullText).slice(0, 380),
          keywordTags: baseKeywords,
          fullText: partFullText,
          chunkCount: chunks.length,
          canonStatus,
          canonFilterType,
          indexVersion: RAG_ENGINE_DEFAULTS.INDEX_VERSION,
          indexGeneration: targetGeneration,
          isActiveGeneration: true,
          activationMode,
          stagingId: input.stagingId,
          lifecycleStatus: 'ACTIVE',
          embeddingModelId,
          embeddingDimension,
          embeddingGenerationMode,
          indexedAt: nowIso,
          contentHash,
          indexStatus: 'INDEXED',
          partIndex: partIndex + 1,
          totalParts,
          createdAt: existingDoc?.createdAt || nowIso,
          updatedAt: nowIso,
        };

        return { document, chunks };
      };

      if (partitioned.length === 0) {
        stagedParts.push(buildStagedPartRecord([], 0));
      } else {
        for (let p = 0; p < partitioned.length; p++) {
          stagedParts.push(buildStagedPartRecord(partitioned[p], p));
        }
      }

      if (input.onDuringIndexingHook) {
        await input.onDuringIndexingHook({
          targetGeneration,
          oldActiveGeneration,
        });
      }

      if (input.simulateVerificationFailure) {
        throw new Error(
          'INDEX_VERIFICATION_FAILED: 신규 색인 검증 단계 실패(강제 시뮬레이션)로 기존 정상 색인 버전을 유지합니다.'
        );
      }

      const totalStagedChunks = stagedParts.reduce(
        (acc, p) => acc + p.chunks.length,
        0
      );
      if (totalStagedChunks !== allSemanticChunks.length) {
        throw new Error(
          `INDEX_COUNT_MISMATCH: 예상 청크 개수(${allSemanticChunks.length})와 생성된 청크 개수(${totalStagedChunks})가 일치하지 않습니다.`
        );
      }

      for (const part of stagedParts) {
        for (const chk of part.chunks) {
          if (!chk.documentId || !chk.sourceEntityId || !chk.sourceRevisionId) {
            throw new Error(
              `INDEX_PROVENANCE_INVALID: 청크(${chk.id})의 출처 식별자가 누락되었습니다.`
            );
          }
          if (
            typeof chk.sourceStartOffset !== 'number' ||
            typeof chk.sourceEndOffset !== 'number' ||
            resolvedFullText.slice(chk.sourceStartOffset, chk.sourceEndOffset) !==
              chk.content
          ) {
            throw new Error(
              `INDEX_OFFSET_MISMATCH: 청크(${chk.id})의 원문 오프셋 슬라이스가 일치하지 않습니다.`
            );
          }
          if (
            !chk.embedding ||
            chk.embedding.length !== embeddingDimension ||
            chk.embeddingGenerationMode !== embeddingGenerationMode ||
            chk.embeddingModelId !== embeddingModelId
          ) {
            throw new Error(
              `INDEX_EMBEDDING_INVALID: 청크(${chk.id})의 임베딩 차원 또는 생성 방식 메타데이터가 유효하지 않습니다.`
            );
          }
        }
      }

      const latestEntityState = this.entityStates.get(entityKey);
      const latestProjectTombstone = this.projectTombstones.get(projectKey);

      if (
        latestProjectTombstone &&
        (latestProjectTombstone.status === 'PENDING_DELETE' ||
          latestProjectTombstone.status === 'DELETED') &&
        targetGeneration <= latestProjectTombstone.tombstoneGen
      ) {
        throw new Error(
          `[RAG_INDEX_ACTIVATION_CONFLICT] STALE_INDEX_BLOCKED_BY_PROJECT_DELETE: 작품 삭제 요청(tombstoneGen=${latestProjectTombstone.tombstoneGen}) 이전 또는 동시에 시작된 색인(gen=${targetGeneration})은 활성화될 수 없습니다.`
        );
      }

      if (latestEntityState) {
        if (
          (latestEntityState.lifecycleStatus === 'PENDING_DELETE' ||
            latestEntityState.lifecycleStatus === 'DELETED') &&
          targetGeneration <= latestEntityState.deletionTombstoneGeneration
        ) {
          throw new Error(
            `[RAG_INDEX_ACTIVATION_CONFLICT] STALE_INDEX_BLOCKED_BY_DELETE: 삭제 대기 또는 삭제된 항목(tombstoneGen=${latestEntityState.deletionTombstoneGeneration})에 대해 이전/동시 색인 버전(gen=${targetGeneration})을 다시 활성화할 수 없습니다.`
          );
        }
        if (latestEntityState.activeGeneration >= targetGeneration) {
          throw new Error(
            `[RAG_INDEX_ACTIVATION_CONFLICT] STALE_INDEX_GENERATION_REJECTED: 이미 더 최신의 색인 버전(activeGen=${latestEntityState.activeGeneration})이 활성화되어 오래된 색인 버전(gen=${targetGeneration}) 전환을 차단했습니다.`
          );
        }
      }

      const newActiveDocIds = stagedParts.map((p) => p.document.id);
      const primary = stagedParts[0];
      const additionalParts = stagedParts.slice(1);
      const nextEntityState: EntityIndexLifecycleState = {
        entityKey,
        ownerId: input.ownerId,
        projectId: input.projectId,
        sourceEntityType: input.sourceEntityType,
        sourceEntityId: input.sourceEntityId,
        activeGeneration: targetGeneration,
        activeRevisionId: sourceRevisionId,
        activeSourceRevisionId: sourceRevisionId,
        activeContentHash: contentHash,
        activationMode,
        stagingId: input.stagingId,
        activeDocumentIds: newActiveDocIds,
        activeChunkCount: totalStagedChunks,
        lifecycleStatus: 'ACTIVE',
        deletionTombstoneGeneration:
          latestEntityState?.deletionTombstoneGeneration ?? 0,
        updatedAt: nowIso,
      };

      return {
        skippedAsUnchanged: false,
        result: {
          document: primary.document,
          chunks: primary.chunks,
          committedGeneration: targetGeneration,
          stagingId: input.stagingId,
          activationMode,
          largeScaleGenerationMode,
          additionalParts:
            additionalParts.length > 0 ? additionalParts : undefined,
        },
        stagedParts,
        targetGeneration,
        oldActiveGeneration,
        entityKey,
        projectKey,
        sourceRevisionId,
        contentHash,
        activationMode,
        largeScaleGenerationMode,
        nextEntityState,
        latestProjectTombstoneGen: latestProjectTombstone?.tombstoneGen ?? 0,
        latestEntityDeletionTombstoneGen:
          latestEntityState?.deletionTombstoneGeneration ?? 0,
        ownerId: input.ownerId,
        projectId: input.projectId,
        sourceEntityType: input.sourceEntityType,
        sourceEntityId: input.sourceEntityId,
      };
    } catch (err) {
      const currentState = this.entityStates.get(entityKey);
      if (
        currentState &&
        currentState.lifecycleStatus === 'REINDEXING_KEEP_OLD' &&
        currentState.activeGeneration === oldActiveGeneration &&
        oldActiveGeneration > 0
      ) {
        currentState.lifecycleStatus = 'ACTIVE';
      }
      throw err;
    }
  }

  /**
   * Stage B local store commit: Atomically switches active entity documents/chunks & manifest pointer
   * ONLY AFTER Stage A staging and Stage B Firestore activation succeed.
   */
  commitPreparedIndexing(
    prepared: PreparedStagedIndexResult,
    overrideEntityState?: EntityIndexLifecycleState
  ): MemoryIndexResult {
    if (prepared.skippedAsUnchanged) {
      return prepared.result;
    }

    const latestEntityState = this.entityStates.get(prepared.entityKey);
    const latestProjectTombstone = this.projectTombstones.get(
      prepared.projectKey
    );

    if (
      latestProjectTombstone &&
      (latestProjectTombstone.status === 'PENDING_DELETE' ||
        latestProjectTombstone.status === 'DELETED') &&
      prepared.targetGeneration <= latestProjectTombstone.tombstoneGen
    ) {
      throw new Error(
        `[RAG_INDEX_ACTIVATION_CONFLICT] STALE_INDEX_BLOCKED_BY_PROJECT_DELETE: 작품 삭제 요청(tombstoneGen=${latestProjectTombstone.tombstoneGen}) 이후 이전 색인(gen=${prepared.targetGeneration})을 활성화할 수 없습니다.`
      );
    }

    if (latestEntityState) {
      if (
        (latestEntityState.lifecycleStatus === 'PENDING_DELETE' ||
          latestEntityState.lifecycleStatus === 'DELETED') &&
        prepared.targetGeneration <=
          latestEntityState.deletionTombstoneGeneration
      ) {
        throw new Error(
          `[RAG_INDEX_ACTIVATION_CONFLICT] STALE_INDEX_BLOCKED_BY_DELETE: 삭제된 항목(tombstoneGen=${latestEntityState.deletionTombstoneGeneration})에 대해 이전/동시 색인 버전(gen=${prepared.targetGeneration})을 활성화할 수 없습니다.`
        );
      }
      if (latestEntityState.activeGeneration >= prepared.targetGeneration) {
        throw new Error(
          `[RAG_INDEX_ACTIVATION_CONFLICT] STALE_INDEX_GENERATION_REJECTED: 이미 더 최신의 색인 버전(activeGen=${latestEntityState.activeGeneration})이 활성화되어 오래된 색인 버전(gen=${prepared.targetGeneration}) 전환을 차단했습니다.`
        );
      }
    }

    const newActiveDocIds = new Set(
      prepared.stagedParts.map((p) => p.document.id)
    );

    for (const [docKey, docVal] of Array.from(this.documents.entries())) {
      if (
        docVal.ownerId === prepared.ownerId &&
        docVal.projectId === prepared.projectId &&
        docVal.sourceEntityType === prepared.sourceEntityType &&
        docVal.sourceEntityId === prepared.sourceEntityId &&
        !newActiveDocIds.has(docKey)
      ) {
        this.documents.delete(docKey);
        this.chunksByDocId.delete(docKey);
      }
    }

    for (const part of prepared.stagedParts) {
      this.documents.set(part.document.id, {
        ...part.document,
        isActiveGeneration: true,
        lifecycleStatus: 'ACTIVE',
      });
      this.chunksByDocId.set(
        part.document.id,
        part.chunks.map((c) => ({
          ...c,
          isActiveGeneration: true,
          lifecycleStatus: 'ACTIVE',
        }))
      );
    }

    if (prepared.targetGeneration > this.generationCounter) {
      this.generationCounter = prepared.targetGeneration;
    }

    this.projectTombstones.set(prepared.projectKey, {
      status: 'ACTIVE',
      tombstoneGen: latestProjectTombstone?.tombstoneGen ?? 0,
    });

    this.entityStates.set(
      prepared.entityKey,
      overrideEntityState || prepared.nextEntityState
    );

    return prepared.result;
  }

  /**
   * Phase 3 Section 13-2 & 13-3:
   * - Maintains existing healthy active index version during re-indexing (`REINDEXING_KEEP_OLD`).
   * - Strictly separates `LIVE_API` and `DETERMINISTIC_TEST` embedding metadata.
   * - Verifies chunk count, exact provenance offsets, and concurrency/deletion tombstones before atomically switching `activeGeneration`.
   */
  async indexDocument(input: MemoryIndexInput): Promise<MemoryIndexResult> {
    const prepared = await this.prepareStagedIndexing(input, {
      markLiveStateReindexingDuringPrepare: true,
    });
    if (prepared.skippedAsUnchanged) {
      return prepared.result;
    }
    try {
      return this.commitPreparedIndexing(prepared);
    } catch (err) {
      const currentState = this.entityStates.get(prepared.entityKey);
      if (
        currentState &&
        currentState.lifecycleStatus === 'REINDEXING_KEEP_OLD' &&
        currentState.activeGeneration === prepared.oldActiveGeneration &&
        prepared.oldActiveGeneration > 0
      ) {
        currentState.lifecycleStatus = 'ACTIVE';
      }
      throw err;
    }
  }

  async deleteDocument(
    projectId: string,
    documentId: string,
    ownerId?: string
  ): Promise<boolean> {
    const existing = this.documents.get(documentId);
    if (!existing || existing.projectId !== projectId) {
      return false;
    }
    if (ownerId && existing.ownerId !== ownerId) {
      return false;
    }

    const entityKey = this.makeEntityKey(
      existing.ownerId,
      existing.projectId,
      existing.sourceEntityType,
      existing.sourceEntityId
    );
    const tombstoneGen = ++this.generationCounter;
    const nowIso = new Date().toISOString();

    // 1. Mark PENDING_DELETE and block search immediately before removing data
    existing.indexStatus = 'PENDING_DELETE';
    existing.lifecycleStatus = 'PENDING_DELETE';
    existing.isActiveGeneration = false;

    const entityState = this.entityStates.get(entityKey);
    if (entityState) {
      entityState.lifecycleStatus = 'PENDING_DELETE';
      entityState.deletionTombstoneGeneration = tombstoneGen;
      entityState.deletionRequestedAt = nowIso;
      entityState.updatedAt = nowIso;
    }

    // 2. Delete physical data
    this.documents.delete(documentId);
    this.chunksByDocId.delete(documentId);

    if (entityState) {
      entityState.activeDocumentIds = entityState.activeDocumentIds.filter(
        (id) => id !== documentId
      );
      if (entityState.activeDocumentIds.length === 0) {
        entityState.lifecycleStatus = 'DELETED';
        entityState.activeChunkCount = 0;
      }
    }
    return true;
  }

  /**
   * Phase 3 Section 13-2:
   * 1. Immediately applies `PENDING_DELETE` status and search block (`deletionTombstoneGeneration`) BEFORE deleting chunks.
   * 2. Excludes the entity from all concurrent searches while deletion is in progress.
   * 3. Finalizes state as `DELETED` with tombstone generation so concurrent/stale indexing cannot resurrect it.
   */
  async deleteBySourceEntity(params: {
    ownerId: string;
    projectId: string;
    sourceEntityId: string;
    sourceEntityType?: MemorySourceEntityType;
    onDuringDeleteHook?: (ctx: {
      tombstoneGeneration: number;
    }) => Promise<void> | void;
  }): Promise<number> {
    const tombstoneGen = ++this.generationCounter;
    const nowIso = new Date().toISOString();

    const targetDocs: [string, MemoryDocument][] = [];
    for (const [docId, doc] of Array.from(this.documents.entries())) {
      if (doc.ownerId !== params.ownerId || doc.projectId !== params.projectId) {
        continue;
      }
      const matchesEntity =
        doc.sourceEntityId === params.sourceEntityId ||
        doc.sourceEpisodeId === params.sourceEntityId;
      const matchesType =
        !params.sourceEntityType ||
        doc.sourceEntityType === params.sourceEntityType;
      if (matchesEntity && matchesType) {
        targetDocs.push([docId, doc]);
      }
    }

    // Also record tombstone even if entity is currently being indexed for the first time!
    const candidateTypes: MemorySourceEntityType[] = params.sourceEntityType
      ? [params.sourceEntityType]
      : [
          'EPISODE',
          'EPISODE_SUMMARY',
          'SCENE',
          'CHARACTER',
          'CHARACTER_STATE_CHANGE',
          'WORLDBUILDING',
          'TIMELINE_EVENT',
          'FORESHADOWING',
          'RELATIONSHIP',
        ];

    const affectedEntityKeys = new Set<string>();
    for (const [, doc] of targetDocs) {
      affectedEntityKeys.add(
        this.makeEntityKey(
          doc.ownerId,
          doc.projectId,
          doc.sourceEntityType,
          doc.sourceEntityId
        )
      );
    }
    for (const t of candidateTypes) {
      const k = this.makeEntityKey(
        params.ownerId,
        params.projectId,
        t,
        params.sourceEntityId
      );
      if (this.entityStates.has(k) || params.sourceEntityType === t) {
        affectedEntityKeys.add(k);
      }
    }

    // Step 1: Mark PENDING_DELETE and block search FIRST
    for (const [, doc] of targetDocs) {
      doc.indexStatus = 'PENDING_DELETE';
      doc.lifecycleStatus = 'PENDING_DELETE';
      doc.isActiveGeneration = false;
      const chunks = this.chunksByDocId.get(doc.id) || [];
      for (const chk of chunks) {
        chk.lifecycleStatus = 'PENDING_DELETE';
        chk.isActiveGeneration = false;
      }
    }

    for (const entityKey of affectedEntityKeys) {
      const prev = this.entityStates.get(entityKey);
      const parts = entityKey.split(':');
      const sType = (prev?.sourceEntityType ||
        parts[2] ||
        params.sourceEntityType ||
        'EPISODE') as MemorySourceEntityType;
      const sId = prev?.sourceEntityId || parts[3] || params.sourceEntityId;
      this.entityStates.set(entityKey, {
        entityKey,
        ownerId: params.ownerId,
        projectId: params.projectId,
        sourceEntityType: sType,
        sourceEntityId: sId,
        activeGeneration: prev?.activeGeneration ?? 0,
        activeRevisionId: prev?.activeRevisionId ?? '',
        activeDocumentIds: prev?.activeDocumentIds ?? [],
        activeChunkCount: prev?.activeChunkCount ?? 0,
        lifecycleStatus: 'PENDING_DELETE',
        deletionTombstoneGeneration: tombstoneGen,
        deletionRequestedAt: nowIso,
        updatedAt: nowIso,
      });
    }

    // Optional hook to verify that during deletion (before physical purge), search already excludes the entity
    if (params.onDuringDeleteHook) {
      await params.onDuringDeleteHook({ tombstoneGeneration: tombstoneGen });
    }

    // Step 2: Physical deletion of documents & chunks
    let deletedCount = 0;
    for (const [docId] of targetDocs) {
      if (this.documents.delete(docId)) {
        deletedCount += 1;
      }
      this.chunksByDocId.delete(docId);
    }

    // Step 3: Transition entity state from PENDING_DELETE -> DELETED while retaining tombstone generation
    for (const entityKey of affectedEntityKeys) {
      const st = this.entityStates.get(entityKey);
      if (st && st.deletionTombstoneGeneration === tombstoneGen) {
        st.lifecycleStatus = 'DELETED';
        st.activeDocumentIds = [];
        st.activeChunkCount = 0;
        st.updatedAt = new Date().toISOString();
      }
    }

    return deletedCount;
  }

  async deleteProjectDocuments(params: {
    ownerId: string;
    projectId: string;
    onDuringDeleteHook?: (ctx: {
      tombstoneGeneration: number;
    }) => Promise<void> | void;
  }): Promise<number> {
    const tombstoneGen = ++this.generationCounter;
    const projectKey = this.makeProjectKey(params.ownerId, params.projectId);
    const nowIso = new Date().toISOString();

    // Step 1: Mark project & all its entities as PENDING_DELETE first (immediate search block)
    this.projectTombstones.set(projectKey, {
      status: 'PENDING_DELETE',
      tombstoneGen,
    });

    const targetDocIds: string[] = [];
    for (const [docId, doc] of Array.from(this.documents.entries())) {
      if (doc.ownerId === params.ownerId && doc.projectId === params.projectId) {
        doc.indexStatus = 'PENDING_DELETE';
        doc.lifecycleStatus = 'PENDING_DELETE';
        doc.isActiveGeneration = false;
        targetDocIds.push(docId);
      }
    }

    for (const st of this.entityStates.values()) {
      if (st.ownerId === params.ownerId && st.projectId === params.projectId) {
        st.lifecycleStatus = 'PENDING_DELETE';
        st.deletionTombstoneGeneration = tombstoneGen;
        st.deletionRequestedAt = nowIso;
        st.updatedAt = nowIso;
      }
    }

    if (params.onDuringDeleteHook) {
      await params.onDuringDeleteHook({ tombstoneGeneration: tombstoneGen });
    }

    // Step 2: Physical deletion
    let deletedCount = 0;
    for (const docId of targetDocIds) {
      if (this.documents.delete(docId)) {
        deletedCount += 1;
      }
      this.chunksByDocId.delete(docId);
    }

    // Step 3: Mark DELETED
    for (const st of this.entityStates.values()) {
      if (
        st.ownerId === params.ownerId &&
        st.projectId === params.projectId &&
        st.deletionTombstoneGeneration === tombstoneGen
      ) {
        st.lifecycleStatus = 'DELETED';
        st.activeDocumentIds = [];
        st.activeChunkCount = 0;
      }
    }
    this.projectTombstones.set(projectKey, {
      status: 'DELETED',
      tombstoneGen,
    });

    return deletedCount;
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchHit[]> {
    if (query.ownerId) {
      const pTomb = this.projectTombstones.get(
        this.makeProjectKey(query.ownerId, query.projectId)
      );
      if (
        pTomb &&
        (pTomb.status === 'PENDING_DELETE' || pTomb.status === 'DELETED')
      ) {
        return [];
      }
    }

    const includeDrafts =
      typeof query.includeDrafts === 'boolean'
        ? query.includeDrafts
        : query.onlyCanon === false;
    const includeNonCanon =
      query.includeNonCanonException ??
      query.includeNonCanonPlaceholder ??
      false;
    const allowedStatuses =
      query.allowedCanonStatuses && query.allowedCanonStatuses.length > 0
        ? query.allowedCanonStatuses
        : includeDrafts
        ? (['CANON', 'DRAFT', 'PROPOSED'] as CanonStatus[])
        : (['CANON'] as CanonStatus[]);

    const searchMode: MemorySearchMode = query.searchMode || 'HYBRID';
    const tokenizedQuery = tokenizeKoreanSearchTerms(query.queryText);
    const hasCallerEmbedding = Boolean(
      query.queryEmbedding && query.queryEmbedding.length > 0
    );
    const queryEmbedding =
      query.queryEmbedding ||
      (tokenizedQuery.rawTokens.length > 0
        ? computeDeterministicSemanticEmbedding(query.queryText)
        : undefined);
    const queryEmbeddingGenerationMode: EmbeddingGenerationMode =
      query.queryEmbeddingGenerationMode ||
      (hasCallerEmbedding &&
      isLiveGeminiEmbeddingModelId(query.queryEmbeddingModelId)
        ? 'LIVE_API'
        : 'DETERMINISTIC_TEST');
    const queryEmbeddingModelId =
      query.queryEmbeddingModelId ||
      (queryEmbeddingGenerationMode === 'LIVE_API'
        ? RAG_ENGINE_DEFAULTS.DEFAULT_EMBEDDING_MODEL
        : DETERMINISTIC_TEST_EMBEDDING_MODEL_ID);

    const effectiveEpisodeId = query.episodeId || query.episodeIdFilter;
    const minEpNum =
      query.minEpisodeNumber ?? query.episodeNumberRange?.min;
    const maxEpNum =
      query.maxEpisodeNumber ?? query.episodeNumberRange?.max;
    const finalLimit = query.limit ?? query.topK ?? 10;

    // Helper to validate whether a (doc, chunk) pair passes ownership, active generation,
    // lifecycle status, canon status, and metadata filters
    const validateDocAndChunkEligible = (
      doc: MemoryDocument,
      chunk: MemoryChunk
    ): {
      eligible: boolean;
      freshness: {
        freshnessStatus: MemorySourceFreshness;
        verifiedForWriting: boolean;
      };
    } => {
      if (doc.projectId !== query.projectId || chunk.projectId !== query.projectId) {
        return {
          eligible: false,
          freshness: { freshnessStatus: 'SOURCE_UNVERIFIED', verifiedForWriting: false },
        };
      }
      if (
        query.ownerId &&
        (doc.ownerId !== query.ownerId || chunk.ownerId !== query.ownerId)
      ) {
        return {
          eligible: false,
          freshness: { freshnessStatus: 'SOURCE_UNVERIFIED', verifiedForWriting: false },
        };
      }
      const entityKey = this.makeEntityKey(
        doc.ownerId,
        doc.projectId,
        doc.sourceEntityType,
        doc.sourceEntityId
      );
      const entityState = this.entityStates.get(entityKey);
      const isManifestPointerActive = Boolean(
        entityState &&
          entityState.lifecycleStatus === 'ACTIVE' &&
          entityState.activeGeneration > 0 &&
          doc.indexGeneration === entityState.activeGeneration &&
          chunk.indexGeneration === entityState.activeGeneration &&
          Array.isArray(entityState.activeDocumentIds) &&
          entityState.activeDocumentIds.includes(doc.id) &&
          (doc.activationMode === 'MANIFEST_POINTER' ||
            chunk.activationMode === 'MANIFEST_POINTER' ||
            entityState.activationMode === 'MANIFEST_POINTER')
      );

      if (
        doc.indexStatus === 'PENDING_DELETE' ||
        doc.indexStatus === 'STALE' ||
        doc.indexStatus === 'FAILED' ||
        doc.lifecycleStatus === 'PENDING_DELETE' ||
        doc.lifecycleStatus === 'DELETED' ||
        (doc.isActiveGeneration === false && !isManifestPointerActive) ||
        chunk.lifecycleStatus === 'PENDING_DELETE' ||
        chunk.lifecycleStatus === 'DELETED' ||
        (chunk.isActiveGeneration === false && !isManifestPointerActive)
      ) {
        return {
          eligible: false,
          freshness: { freshnessStatus: 'SOURCE_UNVERIFIED', verifiedForWriting: false },
        };
      }

      if (entityState) {
        if (
          entityState.lifecycleStatus === 'PENDING_DELETE' ||
          entityState.lifecycleStatus === 'DELETED'
        ) {
          return {
            eligible: false,
            freshness: { freshnessStatus: 'SOURCE_UNVERIFIED', verifiedForWriting: false },
          };
        }
        if (
          typeof doc.indexGeneration === 'number' &&
          entityState.activeGeneration > 0 &&
          doc.indexGeneration !== entityState.activeGeneration
        ) {
          return {
            eligible: false,
            freshness: { freshnessStatus: 'STALE', verifiedForWriting: false },
          };
        }
        if (
          typeof chunk.indexGeneration === 'number' &&
          entityState.activeGeneration > 0 &&
          chunk.indexGeneration !== entityState.activeGeneration
        ) {
          return {
            eligible: false,
            freshness: { freshnessStatus: 'STALE', verifiedForWriting: false },
          };
        }
        if (
          Array.isArray(entityState.activeDocumentIds) &&
          entityState.activeDocumentIds.length > 0 &&
          !entityState.activeDocumentIds.includes(doc.id)
        ) {
          return {
            eligible: false,
            freshness: { freshnessStatus: 'STALE', verifiedForWriting: false },
          };
        }
      }

      if (!allowedStatuses.includes(doc.canonStatus)) {
        return {
          eligible: false,
          freshness: { freshnessStatus: 'SOURCE_UNVERIFIED', verifiedForWriting: false },
        };
      }
      if (
        !includeNonCanon &&
        doc.canonFilterType === 'NON_CANON_EXCEPTION'
      ) {
        return {
          eligible: false,
          freshness: { freshnessStatus: 'SOURCE_UNVERIFIED', verifiedForWriting: false },
        };
      }
      if (
        query.sourceEntityTypes &&
        query.sourceEntityTypes.length > 0 &&
        !query.sourceEntityTypes.includes(doc.sourceEntityType)
      ) {
        return {
          eligible: false,
          freshness: { freshnessStatus: 'SOURCE_UNVERIFIED', verifiedForWriting: false },
        };
      }

      if (effectiveEpisodeId && chunk.episodeId !== effectiveEpisodeId) {
        return {
          eligible: false,
          freshness: { freshnessStatus: 'SOURCE_UNVERIFIED', verifiedForWriting: false },
        };
      }
      if (
        typeof minEpNum === 'number' &&
        typeof chunk.episodeNumber === 'number' &&
        chunk.episodeNumber < minEpNum
      ) {
        return {
          eligible: false,
          freshness: { freshnessStatus: 'SOURCE_UNVERIFIED', verifiedForWriting: false },
        };
      }
      if (
        typeof maxEpNum === 'number' &&
        typeof chunk.episodeNumber === 'number' &&
        chunk.episodeNumber > maxEpNum
      ) {
        return {
          eligible: false,
          freshness: { freshnessStatus: 'SOURCE_UNVERIFIED', verifiedForWriting: false },
        };
      }
      if (
        query.characterId &&
        !chunk.characterIds.includes(query.characterId)
      ) {
        return {
          eligible: false,
          freshness: { freshnessStatus: 'SOURCE_UNVERIFIED', verifiedForWriting: false },
        };
      }
      if (
        query.characterIds &&
        query.characterIds.length > 0 &&
        !query.characterIds.some((cid) => chunk.characterIds.includes(cid))
      ) {
        return {
          eligible: false,
          freshness: { freshnessStatus: 'SOURCE_UNVERIFIED', verifiedForWriting: false },
        };
      }
      if (
        query.eventId &&
        !(chunk.relatedEventIds || []).includes(query.eventId)
      ) {
        return {
          eligible: false,
          freshness: { freshnessStatus: 'SOURCE_UNVERIFIED', verifiedForWriting: false },
        };
      }
      if (
        query.foreshadowingId &&
        !chunk.foreshadowingIds.includes(query.foreshadowingId)
      ) {
        return {
          eligible: false,
          freshness: { freshnessStatus: 'SOURCE_UNVERIFIED', verifiedForWriting: false },
        };
      }

      const freshness = verifyChunkAgainstLiveSource({
        chunk,
        document: doc,
        liveSources: query.liveSources,
      });

      if (
        query.excludeUnverifiedSources &&
        (freshness.freshnessStatus === 'SOURCE_UNVERIFIED' ||
          freshness.freshnessStatus === 'STALE')
      ) {
        return { eligible: false, freshness };
      }

      return { eligible: true, freshness };
    };

    // ========================================================================
    // Phase 3.1.1 P0-1: Explicit Firestore Vector Candidate + Keyword RRF Fusion
    // ========================================================================
    if (Array.isArray(query.externalVectorCandidates)) {
      const rrfK = query.rrfK ?? RAG_ENGINE_DEFAULTS.DEFAULT_RRF_K;

      // 1. Validate & rank Firestore findNearest() vector candidates
      const validVectorCandidates: {
        chunk: MemoryChunk;
        document: MemoryDocument;
        vectorScore: number;
        vectorRank: number;
        freshness: {
          freshnessStatus: MemorySourceFreshness;
          verifiedForWriting: boolean;
        };
      }[] = [];
      const seenVectorChunkIds = new Set<string>();

      const sortedExternal = [...query.externalVectorCandidates].sort(
        (a, b) => {
          if (a.vectorRank !== b.vectorRank) return a.vectorRank - b.vectorRank;
          return b.vectorScore - a.vectorScore;
        }
      );

      for (const ext of sortedExternal) {
        // Rule 8: Never merge results from another user or another project
        if (ext.projectId !== query.projectId) continue;
        if (query.ownerId && ext.ownerId !== query.ownerId) continue;
        if (!ext.chunkId || seenVectorChunkIds.has(ext.chunkId)) continue;

        // Resolve chunk & document from snapshot first (avoiding N+1), then fallback to store
        let resolvedChunk: MemoryChunk | undefined = ext.chunkSnapshot;
        let resolvedDoc: MemoryDocument | undefined = ext.documentSnapshot;

        if (!resolvedChunk || !resolvedDoc) {
          if (ext.documentId && this.documents.has(ext.documentId)) {
            resolvedDoc = resolvedDoc || this.documents.get(ext.documentId);
            const docChunks = this.chunksByDocId.get(ext.documentId) || [];
            resolvedChunk =
              resolvedChunk ||
              docChunks.find(
                (c) => c.id === ext.chunkId || c.chunkId === ext.chunkId
              );
          }
          if (!resolvedChunk || !resolvedDoc) {
            for (const [dId, cList] of this.chunksByDocId.entries()) {
              const found = cList.find(
                (c) => c.id === ext.chunkId || c.chunkId === ext.chunkId
              );
              if (found) {
                resolvedChunk = resolvedChunk || found;
                resolvedDoc = resolvedDoc || this.documents.get(dId);
                break;
              }
            }
          }
        }

        if (!resolvedChunk || !resolvedDoc) continue;

        // Rule 9: Exclude vectors incompatible with current query embedding model/mode/dimension
        const cMode: EmbeddingGenerationMode =
          ext.embeddingGenerationMode ||
          resolvedChunk.embeddingGenerationMode ||
          resolvedDoc.embeddingGenerationMode ||
          (isLiveGeminiEmbeddingModelId(
            ext.embeddingModelId ||
              resolvedChunk.embeddingModelId ||
              resolvedDoc.embeddingModelId
          )
            ? 'LIVE_API'
            : 'DETERMINISTIC_TEST');
        const cModelId =
          ext.embeddingModelId ||
          resolvedChunk.embeddingModelId ||
          resolvedDoc.embeddingModelId ||
          RAG_ENGINE_DEFAULTS.DEFAULT_EMBEDDING_MODEL;
        const cDim =
          ext.embeddingDimension ||
          resolvedChunk.embeddingDimension ||
          resolvedChunk.embedding?.length ||
          resolvedDoc.embeddingDimension;

        const isCompatible = areEmbeddingsVectorSpaceCompatible({
          chunkMode: cMode,
          chunkModelId: cModelId,
          chunkDimension: cDim,
          queryMode: queryEmbeddingGenerationMode,
          queryModelId: queryEmbeddingModelId,
          queryDimension: queryEmbedding?.length,
        });
        if (!isCompatible) continue;

        const eligibility = validateDocAndChunkEligible(
          resolvedDoc,
          resolvedChunk
        );
        if (!eligibility.eligible) continue;

        seenVectorChunkIds.add(ext.chunkId);
        validVectorCandidates.push({
          chunk: resolvedChunk,
          document: resolvedDoc,
          vectorScore: Math.max(0, Math.min(1, Number(ext.vectorScore.toFixed(4)))),
          vectorRank: validVectorCandidates.length + 1,
          freshness: eligibility.freshness,
        });
      }

      // 2. Collect keyword candidates (when searchMode is HYBRID or KEYWORD)
      const keywordCandidatesMap = new Map<
        string,
        {
          chunk: MemoryChunk;
          document: MemoryDocument;
          keywordScore: number;
          matchedTerms: string[];
          freshness: {
            freshnessStatus: MemorySourceFreshness;
            verifiedForWriting: boolean;
          };
        }
      >();

      if (searchMode !== 'SEMANTIC') {
        const candidatePool = new Map<
          string,
          { chunk: MemoryChunk; document: MemoryDocument }
        >();
        for (const [docId, doc] of this.documents.entries()) {
          const chunks = this.chunksByDocId.get(docId) || [];
          for (const chk of chunks) {
            candidatePool.set(chk.id, { chunk: chk, document: doc });
          }
        }
        for (const vc of validVectorCandidates) {
          if (!candidatePool.has(vc.chunk.id)) {
            candidatePool.set(vc.chunk.id, {
              chunk: vc.chunk,
              document: vc.document,
            });
          }
        }

        for (const [chunkId, { chunk, document }] of candidatePool.entries()) {
          const eligibility = validateDocAndChunkEligible(document, chunk);
          if (!eligibility.eligible) continue;

          const kwEval = evaluateChunkHybridMatch({
            chunk,
            document,
            tokenizedQuery,
            searchMode: 'KEYWORD',
          });
          if (kwEval.matched && kwEval.keywordScore > 0) {
            keywordCandidatesMap.set(chunkId, {
              chunk,
              document,
              keywordScore: kwEval.keywordScore,
              matchedTerms: kwEval.matchedTerms,
              freshness: eligibility.freshness,
            });
          }
        }
      }

      const sortedKeywordCandidates = Array.from(
        keywordCandidatesMap.values()
      ).sort((a, b) => b.keywordScore - a.keywordScore);

      const keywordRankByChunkId = new Map<string, number>();
      sortedKeywordCandidates.forEach((item, idx) => {
        keywordRankByChunkId.set(item.chunk.id, idx + 1);
      });

      const vectorByChunkId = new Map<
        string,
        (typeof validVectorCandidates)[number]
      >();
      for (const vc of validVectorCandidates) {
        vectorByChunkId.set(vc.chunk.id, vc);
      }

      // 3. Union of all candidate chunkIds (Deduplicated by chunk.id & entity offset key)
      const allCandidateChunkIds = new Set<string>();
      if (searchMode === 'SEMANTIC') {
        for (const vc of validVectorCandidates) {
          allCandidateChunkIds.add(vc.chunk.id);
        }
      } else if (searchMode === 'KEYWORD') {
        for (const kc of sortedKeywordCandidates) {
          allCandidateChunkIds.add(kc.chunk.id);
        }
      } else {
        // HYBRID: union of Firestore vector candidates and keyword candidates
        for (const vc of validVectorCandidates) {
          allCandidateChunkIds.add(vc.chunk.id);
        }
        for (const kc of sortedKeywordCandidates) {
          allCandidateChunkIds.add(kc.chunk.id);
        }
      }

      const fusedHits: MemorySearchHit[] = [];
      const seenDedupKeys = new Set<string>();

      for (const chunkId of allCandidateChunkIds) {
        const vEntry = vectorByChunkId.get(chunkId);
        const kEntry = keywordCandidatesMap.get(chunkId);
        const chunk = vEntry?.chunk || kEntry?.chunk;
        const doc = vEntry?.document || kEntry?.document;
        const freshness = vEntry?.freshness || kEntry?.freshness;
        if (!chunk || !doc || !freshness) continue;

        const dedupKey = `${chunk.sourceEntityType}:${chunk.sourceEntityId}:${chunk.sourceStartOffset ?? chunk.chunkIndex}`;
        if (seenDedupKeys.has(dedupKey)) continue;
        seenDedupKeys.add(dedupKey);

        const vectorRank = vEntry?.vectorRank;
        const vectorScore = vEntry?.vectorScore ?? 0;
        const keywordRank = keywordRankByChunkId.get(chunkId);
        let keywordScore = kEntry?.keywordScore ?? 0;
        let matchedTerms = kEntry?.matchedTerms ?? [];

        if (!kEntry && tokenizedQuery.rawTokens.length > 0) {
          const kwEval = evaluateChunkHybridMatch({
            chunk,
            document: doc,
            tokenizedQuery,
            searchMode: 'KEYWORD',
          });
          keywordScore = kwEval.keywordScore;
          matchedTerms = kwEval.matchedTerms;
        }

        const rrfVectorComponent = vectorRank ? 1 / (rrfK + vectorRank) : 0;
        const rrfKeywordComponent = keywordRank ? 1 / (rrfK + keywordRank) : 0;
        const rrfScore = Number(
          (rrfVectorComponent + rrfKeywordComponent).toFixed(6)
        );

        const normRrfVector = vectorRank
          ? (rrfK + 1) / (rrfK + vectorRank)
          : 0;
        const normRrfKeyword = keywordRank
          ? (rrfK + 1) / (rrfK + keywordRank)
          : 0;

        let finalScore = 0;
        if (searchMode === 'SEMANTIC') {
          finalScore = Number(
            (vectorScore * 0.75 + normRrfVector * 0.25).toFixed(4)
          );
        } else if (searchMode === 'KEYWORD') {
          finalScore = Number(
            (keywordScore * 0.75 + normRrfKeyword * 0.25).toFixed(4)
          );
        } else {
          // Explicit RRF + Vector Score + Keyword Score fusion
          finalScore = Number(
            Math.min(
              1,
              normRrfVector * 0.35 +
                vectorScore * 0.35 +
                normRrfKeyword * 0.15 +
                keywordScore * 0.15
            ).toFixed(4)
          );
        }

        const freshnessMultiplier =
          freshness.freshnessStatus === 'FRESH'
            ? 1
            : freshness.freshnessStatus === 'STALE'
            ? 0.75
            : 0.35;
        const adjustedScore = Number(
          (finalScore * freshnessMultiplier).toFixed(4)
        );

        fusedHits.push({
          chunk: {
            ...chunk,
            chunkText: chunk.chunkText ?? chunk.content,
            originalText: chunk.originalText ?? chunk.content,
          },
          document: doc,
          score: adjustedScore,
          relevanceScore: adjustedScore,
          keywordScore,
          semanticScore: vectorScore,
          vectorScore,
          rrfScore,
          vectorRank,
          keywordRank,
          retrievalSource:
            searchMode === 'SEMANTIC'
              ? 'FIRESTORE_VECTOR_ONLY'
              : searchMode === 'KEYWORD'
              ? 'KEYWORD_ONLY'
              : vEntry
              ? 'FIRESTORE_VECTOR_HYBRID'
              : 'KEYWORD_ONLY',
          matchedTerms,
          freshnessStatus: freshness.freshnessStatus,
          verifiedForWriting: freshness.verifiedForWriting,
          episodeNumber: chunk.episodeNumber ?? doc.episodeNumber,
        });
      }

      fusedHits.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if ((b.rrfScore ?? 0) !== (a.rrfScore ?? 0)) {
          return (b.rrfScore ?? 0) - (a.rrfScore ?? 0);
        }
        if (b.semanticScore !== a.semanticScore) {
          return b.semanticScore - a.semanticScore;
        }
        return b.keywordScore - a.keywordScore;
      });

      return fusedHits.slice(0, finalLimit);
    }

    // ========================================================================
    // Standard Local Store Search (when externalVectorCandidates is undefined)
    // ========================================================================
    const hits: MemorySearchHit[] = [];
    const seenChunkDedupKeys = new Set<string>();

    for (const [docId, doc] of this.documents.entries()) {
      const chunks = this.chunksByDocId.get(docId) || [];
      for (const chunk of chunks) {
        const eligibility = validateDocAndChunkEligible(doc, chunk);
        if (!eligibility.eligible) continue;
        const { freshness } = eligibility;

        const evalMatch = evaluateChunkHybridMatch({
          chunk,
          document: doc,
          tokenizedQuery,
          queryEmbedding,
          queryEmbeddingModelId,
          queryEmbeddingGenerationMode,
          searchMode,
        });

        if (!evalMatch.matched) continue;

        const dedupKey = `${chunk.sourceEntityType}:${chunk.sourceEntityId}:${chunk.sourceStartOffset ?? chunk.chunkIndex}`;
        if (seenChunkDedupKeys.has(dedupKey)) continue;
        seenChunkDedupKeys.add(dedupKey);

        const freshnessMultiplier =
          freshness.freshnessStatus === 'FRESH'
            ? 1
            : freshness.freshnessStatus === 'STALE'
            ? 0.75
            : 0.35;
        const computedScore = Number(
          (evalMatch.score * freshnessMultiplier).toFixed(4)
        );

        hits.push({
          chunk: {
            ...chunk,
            chunkText: chunk.chunkText ?? chunk.content,
            originalText: chunk.originalText ?? chunk.content,
          },
          document: doc,
          score: computedScore,
          relevanceScore: computedScore,
          keywordScore: evalMatch.keywordScore,
          semanticScore: evalMatch.semanticScore,
          retrievalSource:
            searchMode === 'KEYWORD' ? 'KEYWORD_ONLY' : 'LOCAL_HYBRID',
          matchedTerms: evalMatch.matchedTerms,
          freshnessStatus: freshness.freshnessStatus,
          verifiedForWriting: freshness.verifiedForWriting,
          episodeNumber: chunk.episodeNumber ?? doc.episodeNumber,
        });
      }
    }

    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.keywordScore - a.keywordScore;
    });
    return hits.slice(0, finalLimit);
  }

  async getSource(
    projectId: string,
    documentOrChunkId: string,
    ownerId?: string
  ): Promise<MemorySourceReference | null> {
    let targetDoc = this.documents.get(documentOrChunkId) || null;
    let matchedChunk: MemoryChunk | null = null;

    if (!targetDoc) {
      for (const [docId, chunks] of this.chunksByDocId.entries()) {
        const found = chunks.find(
          (c) => c.id === documentOrChunkId || c.chunkId === documentOrChunkId
        );
        if (found) {
          targetDoc = this.documents.get(docId) || null;
          matchedChunk = found;
          break;
        }
      }
    }

    if (!targetDoc || targetDoc.projectId !== projectId) {
      return null;
    }
    if (ownerId && targetDoc.ownerId !== ownerId) {
      return null;
    }
    const entityKey = this.makeEntityKey(
      targetDoc.ownerId,
      targetDoc.projectId,
      targetDoc.sourceEntityType,
      targetDoc.sourceEntityId
    );
    const entityState = this.entityStates.get(entityKey);
    const isManifestPointerActive = Boolean(
      entityState &&
        entityState.lifecycleStatus === 'ACTIVE' &&
        entityState.activeGeneration > 0 &&
        targetDoc.indexGeneration === entityState.activeGeneration &&
        Array.isArray(entityState.activeDocumentIds) &&
        entityState.activeDocumentIds.includes(targetDoc.id) &&
        (targetDoc.activationMode === 'MANIFEST_POINTER' ||
          entityState.activationMode === 'MANIFEST_POINTER')
    );

    if (
      targetDoc.indexStatus === 'PENDING_DELETE' ||
      targetDoc.lifecycleStatus === 'PENDING_DELETE' ||
      targetDoc.lifecycleStatus === 'DELETED' ||
      (targetDoc.isActiveGeneration === false && !isManifestPointerActive)
    ) {
      return null;
    }

    if (
      entityState &&
      (entityState.lifecycleStatus === 'PENDING_DELETE' ||
        entityState.lifecycleStatus === 'DELETED')
    ) {
      return null;
    }

    const chunks = this.chunksByDocId.get(targetDoc.id) || [];
    const primaryChunk = matchedChunk || chunks[0];
    const freshness = primaryChunk
      ? verifyChunkAgainstLiveSource({
          chunk: primaryChunk,
          document: targetDoc,
        })
      : { freshnessStatus: 'FRESH' as MemorySourceFreshness };

    return {
      document: targetDoc,
      chunks,
      chunk: primaryChunk,
      freshnessStatus: freshness.freshnessStatus,
      provenance: {
        sourceType: 'MANUSCRIPT',
        createdBy: 'SYSTEM',
        ownerId: targetDoc.ownerId,
        projectId: targetDoc.projectId,
        episodeId: primaryChunk?.episodeId || targetDoc.sourceEpisodeId || null,
        sceneId: primaryChunk?.sceneId || targetDoc.sourceSceneId || null,
        revisionId: targetDoc.sourceRevisionId,
        excerpt: primaryChunk?.content.slice(0, 240),
      },
    };
  }
}

