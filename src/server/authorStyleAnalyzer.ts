import { getApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { TokenUsageMetadata } from '../types/aiEngine';
import type {
  AuthorStyleAnalysisCandidate,
  StyleAnalysisRequest,
  StyleSourceReference,
} from '../types/authorStyle';
import {
  AUTHOR_STYLE_ANALYSIS_GEMINI_RESPONSE_SCHEMA,
  buildAuthorStyleAnalysisPrompt,
  buildDeterministicStyleFindings,
  buildEmptyUsageMetadata,
  computeDeterministicStyleMetrics,
  STYLE_INPUT_THRESHOLDS,
  verifyAndMergeAiStyleCandidate,
} from '../utils/authorStyleLogic';
import { computeManuscriptContentHash } from '../utils/manuscriptIntegrity';
import {
  ensureFirebaseAdminInitialized,
  getFirebaseDatabaseId,
  hasCloudFirestoreCredentials,
} from './authMiddleware.ts';
import {
  callWithRetry,
  extractUsageMetadata,
  getConfiguredWritingModel,
  getGenAiClient,
  isGeminiApiKeyReady,
  translateGeminiErrorKo,
} from './geminiWritingEngine.ts';

export interface ServerStyleRevisionRecord {
  id: string;
  ownerId: string;
  projectId: string;
  episodeId: string;
  episodeTitle?: string;
  content: string;
}

export interface ServerStyleEpisodeRecord {
  id: string;
  ownerId: string;
  projectId: string;
  title?: string;
  latestRevisionId?: string;
}

export interface ServerStyleAnalysisOptions {
  isAuthenticatedCloud?: boolean;
  db?: Firestore | null;
  geminiTimeoutMs?: number;
  customRevisionReader?: (params: {
    ownerId: string;
    projectId: string;
    episodeId: string;
    revisionId: string;
  }) => Promise<{
    episode: ServerStyleEpisodeRecord | null;
    revision: ServerStyleRevisionRecord | null;
    projectTitle?: string;
  }>;
}

export type CustomGeminiStyleAnalyzer = (params: {
  systemInstruction: string;
  userPrompt: string;
  modelId: string;
  request: StyleAnalysisRequest;
}) => Promise<{
  rawAiOutput: unknown;
  usageMetadata?: TokenUsageMetadata;
}>;

let customGeminiStyleAnalyzerForTesting: CustomGeminiStyleAnalyzer | null = null;

export function setCustomGeminiStyleAnalyzerForTesting(
  fn: CustomGeminiStyleAnalyzer | null
): void {
  customGeminiStyleAnalyzerForTesting = fn;
}

async function readVerifiedRevisionFromAdminFirestore(params: {
  db: Firestore;
  ownerId: string;
  projectId: string;
  episodeId: string;
  revisionId: string;
}): Promise<{
  episode: ServerStyleEpisodeRecord | null;
  revision: ServerStyleRevisionRecord | null;
  projectTitle?: string;
}> {
  const { db, ownerId, projectId, episodeId, revisionId } = params;
  const projSnap = await db.doc(`users/${ownerId}/projects/${projectId}`).get();
  const projectTitle = projSnap.exists
    ? (projSnap.data()?.title as string | undefined)
    : undefined;

  const epSnap = await db
    .doc(`users/${ownerId}/projects/${projectId}/episodes/${episodeId}`)
    .get();
  const revSnap = await db
    .doc(`users/${ownerId}/projects/${projectId}/revisions/${revisionId}`)
    .get();

  const episode: ServerStyleEpisodeRecord | null = epSnap.exists
    ? {
        id: epSnap.id,
        ownerId: String(epSnap.data()?.ownerId || ownerId),
        projectId: String(epSnap.data()?.projectId || projectId),
        title: typeof epSnap.data()?.title === 'string' ? epSnap.data()?.title : undefined,
        latestRevisionId:
          typeof epSnap.data()?.latestRevisionId === 'string'
            ? epSnap.data()?.latestRevisionId
            : undefined,
      }
    : null;

  const revision: ServerStyleRevisionRecord | null = revSnap.exists
    ? {
        id: revSnap.id,
        ownerId: String(revSnap.data()?.ownerId || ''),
        projectId: String(revSnap.data()?.projectId || ''),
        episodeId: String(revSnap.data()?.episodeId || ''),
        episodeTitle:
          typeof revSnap.data()?.episodeTitle === 'string'
            ? revSnap.data()?.episodeTitle
            : undefined,
        content:
          typeof revSnap.data()?.content === 'string' ? revSnap.data()?.content : '',
      }
    : null;

  return { episode, revision, projectTitle };
}

export async function analyzeAuthorStyleOnServer(
  request: StyleAnalysisRequest,
  serverOptions?: ServerStyleAnalysisOptions
): Promise<{ ok: true; candidate: AuthorStyleAnalysisCandidate }> {
  const ownerId = (request.ownerId || 'local_author').trim() || 'local_author';
  const projectId = (request.projectId || '').trim();
  const inputMode = request.inputMode;

  if (!projectId) {
    throw new Error('[BAD_REQUEST] 문체 DNA 분석에는 projectId가 필요합니다.');
  }
  if (inputMode !== 'AUTHOR_SUPPLIED_SAMPLE' && inputMode !== 'SAVED_REVISION') {
    throw new Error(
      '[BAD_REQUEST] inputMode는 AUTHOR_SUPPLIED_SAMPLE 또는 SAVED_REVISION이어야 합니다.'
    );
  }

  let resolvedSourceText = '';
  let sourceTitle = request.sampleLabel?.trim() || '작가 제공 샘플';
  let resolvedEpisodeId = request.episodeId?.trim() || undefined;
  let resolvedRevisionId = request.revisionId?.trim() || undefined;
  let projectTitle: string | undefined;

  if (inputMode === 'AUTHOR_SUPPLIED_SAMPLE') {
    const raw = typeof request.sampleText === 'string' ? request.sampleText : '';
    if (!raw.trim()) {
      throw new Error(
        '[BAD_REQUEST] 분석할 작가 샘플 텍스트가 비어 있습니다. 본문을 입력하거나 파일을 선택해 주세요.'
      );
    }
    if (raw.length > STYLE_INPUT_THRESHOLDS.MAX_SAMPLE_CHARS) {
      throw new Error(
        `[BAD_REQUEST] 샘플 길이가 최대 허용치(${STYLE_INPUT_THRESHOLDS.MAX_SAMPLE_CHARS.toLocaleString()}자)를 초과했습니다.`
      );
    }
    resolvedSourceText = raw;
    resolvedEpisodeId = undefined;
    resolvedRevisionId = undefined;
  } else {
    // SAVED_REVISION mode
    const episodeId = (request.episodeId || '').trim();
    const revisionId = (request.revisionId || '').trim();
    if (!episodeId || !revisionId) {
      throw new Error(
        '[BAD_REQUEST] 저장된 원고 분석(SAVED_REVISION)에는 episodeId와 revisionId가 모두 필요합니다.'
      );
    }
    if (revisionId === 'UNSAVED_DRAFT' || revisionId === episodeId) {
      throw new Error(
        '[INVALID_REVISION_ID] 임시 초안이나 episodeId를 revisionId로 사용할 수 없습니다. 커밋된 리비전을 선택하세요.'
      );
    }

    const shouldVerifyViaServerStore =
      Boolean(serverOptions?.customRevisionReader) ||
      Boolean(serverOptions?.db) ||
      (Boolean(serverOptions?.isAuthenticatedCloud) && hasCloudFirestoreCredentials());

    if (shouldVerifyViaServerStore) {
      let readResult: {
        episode: ServerStyleEpisodeRecord | null;
        revision: ServerStyleRevisionRecord | null;
        projectTitle?: string;
      };

      if (serverOptions?.customRevisionReader) {
        readResult = await serverOptions.customRevisionReader({
          ownerId,
          projectId,
          episodeId,
          revisionId,
        });
      } else {
        let resolvedDb = serverOptions?.db ?? null;
        if (!resolvedDb) {
          ensureFirebaseAdminInitialized();
          resolvedDb = getFirestore(getApp(), getFirebaseDatabaseId());
        }
        readResult = await readVerifiedRevisionFromAdminFirestore({
          db: resolvedDb,
          ownerId,
          projectId,
          episodeId,
          revisionId,
        });
      }

      if (!readResult.episode) {
        throw new Error(
          `[NOT_FOUND] 회차(${episodeId})를 찾을 수 없거나 접근 권한이 없습니다.`
        );
      }
      if (
        readResult.episode.ownerId !== ownerId ||
        readResult.episode.projectId !== projectId
      ) {
        throw new Error(
          '[TENANT_ISOLATION] 요청한 회차의 소유자 또는 작품이 일치하지 않습니다.'
        );
      }
      if (!readResult.revision) {
        throw new Error(
          `[NOT_FOUND] 리비전(${revisionId})을 찾을 수 없습니다.`
        );
      }
      if (
        readResult.revision.ownerId !== ownerId ||
        readResult.revision.projectId !== projectId
      ) {
        throw new Error(
          '[TENANT_ISOLATION] 요청한 리비전의 소유자 또는 작품이 일치하지 않습니다.'
        );
      }
      if (readResult.revision.episodeId !== episodeId) {
        throw new Error(
          `[BAD_REQUEST] 리비전(${revisionId})이 지정된 회차(${episodeId})에 속하지 않습니다.`
        );
      }

      resolvedSourceText = readResult.revision.content;
      sourceTitle =
        readResult.revision.episodeTitle ||
        readResult.episode.title ||
        `회차 ${episodeId} (${revisionId})`;
      projectTitle = readResult.projectTitle;
    } else {
      const localText = typeof request.sampleText === 'string' ? request.sampleText : '';
      if (!localText.trim()) {
        throw new Error(
          '[BAD_REQUEST] 로컬 모드에서 저장된 리비전을 분석하려면 해당 리비전 본문이 전달되어야 합니다.'
        );
      }
      resolvedSourceText = localText;
      sourceTitle = request.sampleLabel?.trim() || `리비전 ${revisionId}`;
    }

    if (!resolvedSourceText.trim()) {
      throw new Error('[BAD_REQUEST] 선택한 리비전 본문이 비어 있습니다.');
    }

    const actualRevisionHash = computeManuscriptContentHash(resolvedSourceText);
    if (
      request.expectedContentHash &&
      request.expectedContentHash.trim() !== actualRevisionHash
    ) {
      throw new Error(
        `[STALE_REVISION_CONFLICT] 선택한 리비전(${revisionId})의 내용 해시가 일치하지 않습니다. 최신 상태로 새로고침 후 다시 분석하세요.`
      );
    }
  }

  // Apply optional selectedRange slice cleanly
  let analysisSlice = resolvedSourceText;
  let validatedRange: StyleSourceReference['selectedRange'] | undefined;
  if (request.selectedRange) {
    const { startOffset, endOffset } = request.selectedRange;
    if (
      !Number.isInteger(startOffset) ||
      !Number.isInteger(endOffset) ||
      startOffset < 0 ||
      endOffset <= startOffset ||
      endOffset > resolvedSourceText.length
    ) {
      throw new Error(
        '[BAD_REQUEST] selectedRange(startOffset, endOffset) 범위가 원본 글자 수 범위를 벗어났습니다.'
      );
    }
    analysisSlice = resolvedSourceText.slice(startOffset, endOffset);
    validatedRange = { startOffset, endOffset };
  }

  const metrics = computeDeterministicStyleMetrics(analysisSlice);
  const baselineFindings = buildDeterministicStyleFindings(analysisSlice, metrics);
  const contentHash = computeManuscriptContentHash(analysisSlice);

  const sourceReference: StyleSourceReference = {
    mode: inputMode,
    projectId,
    episodeId: resolvedEpisodeId,
    revisionId: resolvedRevisionId,
    sourceTitle,
    contentHash,
    charCountWithSpaces: metrics.charCountWithSpaces,
    charCountWithoutSpaces: metrics.charCountWithoutSpaces,
    selectedRange: validatedRange,
    sampledAt: new Date().toISOString(),
  };

  const allowFallback = request.allowDeterministicFallbackWithoutApiKey ?? true;
  const wantGemini = request.useGeminiStage2 ?? true;

  let rawAiOutput: unknown = null;
  let geminiExecuted = false;
  let modelId = 'DETERMINISTIC_ONLY';
  let usageMetadata = buildEmptyUsageMetadata();

  let stage2FailureReason: string | null = null;
  const timeoutMs =
    typeof serverOptions?.geminiTimeoutMs === 'number' &&
    serverOptions.geminiTimeoutMs > 0
      ? serverOptions.geminiTimeoutMs
      : allowFallback
      ? 8000
      : 20000;

  if (wantGemini && customGeminiStyleAnalyzerForTesting) {
    const prompt = buildAuthorStyleAnalysisPrompt({
      rawSampleText: analysisSlice,
      metrics,
      projectTitle,
    });
    const configuredModel = getConfiguredWritingModel();
    const mocked = await customGeminiStyleAnalyzerForTesting({
      systemInstruction: prompt.systemInstruction,
      userPrompt: prompt.userPrompt,
      modelId: configuredModel,
      request,
    });
    rawAiOutput = mocked.rawAiOutput;
    usageMetadata = mocked.usageMetadata || buildEmptyUsageMetadata();
    geminiExecuted = true;
    modelId = configuredModel;
  } else if (wantGemini && isGeminiApiKeyReady()) {
    const prompt = buildAuthorStyleAnalysisPrompt({
      rawSampleText: analysisSlice,
      metrics,
      projectTitle,
    });
    const configuredModel = getConfiguredWritingModel();
    const timeoutController = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const ai = getGenAiClient();
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          timeoutController.abort();
          reject(new Error(`GEMINI_STAGE2_TIMEOUT (${timeoutMs}ms)`));
        }, timeoutMs);
      });
      const response = await Promise.race([
        callWithRetry(
          () =>
            ai.models.generateContent({
              model: configuredModel,
              contents: prompt.userPrompt,
              config: {
                systemInstruction: prompt.systemInstruction,
                responseMimeType: 'application/json',
                responseSchema: AUTHOR_STYLE_ANALYSIS_GEMINI_RESPONSE_SCHEMA,
                abortSignal: timeoutController.signal,
              },
            }),
          timeoutController.signal,
          allowFallback ? 0 : 1
        ),
        timeoutPromise,
      ]);
      const jsonText = (response.text ?? '{}').trim();
      rawAiOutput = JSON.parse(jsonText);
      usageMetadata = extractUsageMetadata(response, prompt.userPrompt, jsonText);
      geminiExecuted = true;
      modelId = configuredModel;
    } catch (err) {
      if (!allowFallback) {
        throw new Error(translateGeminiErrorKo(err));
      }
      stage2FailureReason =
        err instanceof Error ? err.message : '알 수 없는 Gemini 호출 실패';
      // Graceful fallback to deterministic-only candidate while marking geminiExecuted=false honestly
      geminiExecuted = false;
      modelId = 'DETERMINISTIC_ONLY';
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  } else if (wantGemini && !isGeminiApiKeyReady() && !allowFallback) {
    throw new Error(
      '[API_KEY_MISSING] GEMINI_API_KEY가 설정되지 않아 AI 2차 문체 분석을 실행할 수 없습니다.'
    );
  }

  const candidate = verifyAndMergeAiStyleCandidate({
    projectId,
    rawSampleText: analysisSlice,
    sourceReference,
    metrics,
    baselineFindings,
    rawAiOutput,
    geminiExecuted,
    modelId,
    usageMetadata,
  });

  if (!geminiExecuted && wantGemini) {
    candidate.warnings.unshift(
      stage2FailureReason
        ? `[AI 2차 심층 분석 미실행] Gemini 2차 호출이 완료되지 않아(${stage2FailureReason}) 결정론적 통계 기반 후보(DETERMINISTIC_ONLY)로 대체 생성되었습니다.`
        : '[AI 2차 심층 분석 미실행] 서버에 GEMINI_API_KEY가 없거나 호출이 비활성화되어 결정론적 통계 기반 후보(DETERMINISTIC_ONLY)만 생성되었습니다.'
    );
  }

  return { ok: true, candidate };
}
