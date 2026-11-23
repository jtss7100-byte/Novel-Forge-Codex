import type { TokenUsageMetadata } from '../types/aiEngine';
import type {
  LiteraryRewriteRequest,
  LiteraryRewriteResponse,
} from '../types/literaryRewriting';
import {
  buildFailedLiteraryRewriteResponse,
  buildLiteraryRewritePrompt,
  LITERARY_REWRITE_GEMINI_RESPONSE_SCHEMA,
  validateAndVerifyRewriteCandidate,
} from '../utils/literaryRewritingLogic';
import { validateRewriteSelectionTarget } from '../utils/manuscriptIntegrity';
import { generateEntityId } from '../utils/novelLogic';
import {
  type ServerCanonVerificationOptions,
  verifyServerCanonEvidenceForRewrite,
} from './canonEvidenceGate.ts';
import {
  acquireEpisodeLock,
  callWithRetry,
  extractUsageMetadata,
  getConfiguredWritingModel,
  getGenAiClient,
  isGeminiApiKeyReady,
  releaseEpisodeLock,
  translateGeminiErrorKo,
} from './geminiWritingEngine.ts';

export type CustomLiteraryRewriter = (params: {
  systemInstruction: string;
  userPrompt: string;
  modelId: string;
  request: LiteraryRewriteRequest;
}) => Promise<{
  rawAiOutput: unknown;
  usageMetadata?: TokenUsageMetadata;
}>;

let customLiteraryRewriterForTesting: CustomLiteraryRewriter | null = null;

export function setCustomLiteraryRewriterForTesting(
  fn: CustomLiteraryRewriter | null
): void {
  customLiteraryRewriterForTesting = fn;
}

export async function rewriteLiteraryPassageOnServer(
  request: LiteraryRewriteRequest,
  serverOptions?: ServerCanonVerificationOptions
): Promise<LiteraryRewriteResponse> {
  const projectId = (request.projectId || '').trim();
  const episodeId = (request.episodeId || '').trim();
  const sourceRevisionId = (request.sourceRevisionId || '').trim();

  if (!projectId || !episodeId) {
    throw new Error(
      '[BAD_REQUEST] 정밀 리라이팅에는 projectId와 episodeId가 필요합니다.'
    );
  }
  if (!request.context || request.context.projectId !== projectId || request.context.episodeId !== episodeId) {
    throw new Error(
      '[TENANT_ISOLATION] 요청된 projectId/episodeId와 집필 문맥(WritingContextBundle)이 일치하지 않습니다.'
    );
  }
  if (sourceRevisionId && sourceRevisionId === episodeId) {
    throw new Error(
      '[INVALID_REVISION_ID] episodeId를 sourceRevisionId로 사용할 수 없습니다.'
    );
  }
  if (
    request.anchor?.sourceRevisionId &&
    request.anchor.sourceRevisionId.trim() === episodeId
  ) {
    throw new Error(
      '[INVALID_REVISION_ID] episodeId를 anchor.sourceRevisionId로 사용할 수 없습니다.'
    );
  }
  if (!request.modes || request.modes.length === 0) {
    throw new Error(
      '[BAD_REQUEST] 하나 이상의 리라이팅 모드(R1~R6)를 선택해 주세요.'
    );
  }

  // Pre-validate anchor hash, offsets, revision & slice BEFORE CANON gate/lock/API call
  validateRewriteSelectionTarget({
    manuscript: request.manuscript,
    anchor: request.anchor,
    currentRevisionId: sourceRevisionId === 'UNSAVED_DRAFT' ? '' : sourceRevisionId,
  });

  // P0-A: Server-Verified CANON Evidence Gate (never trust client retrievedMemoryChunks or unverified lore)
  const isIsolatedUnitTestMode =
    serverOptions?.isIsolatedUnitTestMode ??
    Boolean(
      customLiteraryRewriterForTesting &&
        !serverOptions?.enforceServerCanonGate &&
        !serverOptions?.db &&
        !serverOptions?.customFirestoreReader &&
        !serverOptions?.customRagRetriever
    );

  const sceneQueryHint = `${request.anchor.originalExcerpt} ${request.authorInstruction || ''}`.slice(
    0,
    600
  );

  const canonCheck = await verifyServerCanonEvidenceForRewrite({
    ownerId: request.ownerId || 'local_author',
    projectId,
    episodeId,
    context: request.context,
    sceneQueryHint,
    allowUnverifiedTypoOnlyPreview: request.allowUnverifiedTypoOnlyPreview,
    serverOptions: {
      ...serverOptions,
      isIsolatedUnitTestMode,
    },
  });

  if (canonCheck.shouldFailClosed) {
    const isAuthOrStale =
      canonCheck.canonEvidence.status === 'UNAUTHORIZED' ||
      canonCheck.canonEvidence.status === 'STALE';
    return buildFailedLiteraryRewriteResponse({
      errorMessage:
        canonCheck.blockingFailureReason ||
        '서버 CANON 근거 검증에 실패하여 정밀 리라이팅을 안전하게 차단했습니다.',
      isConflict: isAuthOrStale,
      isMissingInfo: !isAuthOrStale,
      canonEvidence: canonCheck.canonEvidence,
    });
  }

  // Fail fast when running live mode without GEMINI_API_KEY after CANON gate
  if (!customLiteraryRewriterForTesting && !isGeminiApiKeyReady()) {
    try {
      getGenAiClient();
    } catch (err) {
      return buildFailedLiteraryRewriteResponse({
        errorMessage: translateGeminiErrorKo(err),
        canonEvidence: canonCheck.canonEvidence,
      });
    }
  }

  const normalizedRequest: LiteraryRewriteRequest = {
    ...request,
    sourceRevisionId: sourceRevisionId === 'UNSAVED_DRAFT' ? '' : sourceRevisionId,
    context: canonCheck.verifiedContext,
  };

  const runId = request.sourceRunId?.trim() || generateEntityId('rw_run');
  const modelId = getConfiguredWritingModel();
  const lockEpisodeKey = `${episodeId}:rewrite`;

  const promptBuild = buildLiteraryRewritePrompt({
    request: normalizedRequest,
  });

  const effectiveSystemInstruction = canonCheck.canonEvidence.fallbackTypoOnlyApplied
    ? `${promptBuild.systemInstruction}\n7. [UNVERIFIED TYPO-ONLY MODE] 현재 서버 CANON/RAG 검증이 오프라인 상태이므로 오탈자·조사·가독성 다듬기만 수행하고, 새로운 고유명사·사건·능력·세계관 설정이나 candidateLoreProposals는 절대 생성하지 마십시오.`
    : promptBuild.systemInstruction;

  acquireEpisodeLock(projectId, lockEpisodeKey, runId);

  const timeoutController = new AbortController();
  let didTimeout = false;
  let apiTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    let rawAiOutput: unknown;
    let usageMetadata: TokenUsageMetadata;

    if (customLiteraryRewriterForTesting) {
      const mocked = await customLiteraryRewriterForTesting({
        systemInstruction: effectiveSystemInstruction,
        userPrompt: promptBuild.userPrompt,
        modelId,
        request: normalizedRequest,
      });
      rawAiOutput = mocked.rawAiOutput;
      usageMetadata = mocked.usageMetadata || {
        promptTokenCount: Math.ceil(promptBuild.userPrompt.length / 2.5),
        candidatesTokenCount: 220,
        totalTokenCount: Math.ceil(promptBuild.userPrompt.length / 2.5) + 220,
        estimatedCostUsd: 0.00018,
        isActualUsage: false,
      };
    } else {
      const ai = getGenAiClient();
      const responsePromise = callWithRetry(
        () =>
          ai.models.generateContent({
            model: modelId,
            contents: promptBuild.userPrompt,
            config: {
              systemInstruction: effectiveSystemInstruction,
              responseMimeType: 'application/json',
              responseSchema: LITERARY_REWRITE_GEMINI_RESPONSE_SCHEMA,
              abortSignal: timeoutController.signal,
            },
          }),
        timeoutController.signal
      );
      const timeoutPromise = new Promise<never>((_, reject) => {
        apiTimer = setTimeout(() => {
          didTimeout = true;
          timeoutController.abort();
          reject(new Error('[REWRITE_TIMEOUT] Gemini 리라이팅 응답 시간 초과'));
        }, 20000);
      });
      const response = await Promise.race([responsePromise, timeoutPromise]);
      const rawText = (response.text ?? '{}').trim();
      rawAiOutput = JSON.parse(rawText);
      usageMetadata = extractUsageMetadata(
        response,
        promptBuild.userPrompt,
        rawText
      );
    }

    const candidate = validateAndVerifyRewriteCandidate({
      rawAiOutput,
      request: normalizedRequest,
      perspectiveInfo: promptBuild.resolvedPerspective,
      canonEvidence: canonCheck.canonEvidence,
      extraValidLoreIds: canonCheck.extraValidLoreIds,
      modelId,
      usageMetadata,
      rewriteApiCallCount: 1,
    });

    if (candidate.verification.hasBlockingViolation) {
      return {
        executionStatus: 'BLOCKED_CONFLICT',
        candidate,
        canonEvidence: canonCheck.canonEvidence,
        errorMessage:
          candidate.verification.alerts.find((a) => a.severity === 'CRITICAL_BLOCK')
            ?.description ||
          '수정안이 확정 설정(CANON) 또는 시점 규칙과 충돌하여 반영을 보류했습니다.',
      };
    }

    return {
      executionStatus:
        candidate.aiDecision === 'NO_OP_OPTIMAL'
          ? 'NO_OP_OPTIMAL'
          : 'CANDIDATE_READY',
      candidate,
      canonEvidence: canonCheck.canonEvidence,
    };
  } catch (err) {
    const errKo = didTimeout
      ? 'AI 리라이팅 응답 시간이 초과되었습니다(20초). 모델 응답 지연 또는 네트워크 상태를 확인한 뒤 다시 시도해 주세요. 기존 원고는 변경 없이 보존되었습니다.'
      : translateGeminiErrorKo(err);
    return buildFailedLiteraryRewriteResponse({
      errorMessage: errKo,
      isConflict: errKo.includes('BLOCKED_CONFLICT'),
      isMissingInfo: errKo.includes('BLOCKED_MISSING_INFO'),
      canonEvidence: canonCheck.canonEvidence,
    });
  } finally {
    if (apiTimer) clearTimeout(apiTimer);
    releaseEpisodeLock(projectId, lockEpisodeKey, runId);
  }
}
