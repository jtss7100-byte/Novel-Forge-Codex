import type {
  TokenUsageMetadata,
  WritingContextBundle,
  WritingIssue,
} from '../types/aiEngine';
import type {
  LiteraryQualityEvaluationResponse,
  StyleReferenceAnalysis,
} from '../types/literaryQuality';
import {
  buildFailedLiteraryQualityReport,
  buildLiteraryQualityEvaluationPrompt,
  buildVerifiedLiteraryQualityReport,
  createEmptyUsageMetadata,
  LITERARY_QUALITY_GEMINI_RESPONSE_SCHEMA,
  mergeStyleAuditAndQualityFindings,
} from '../utils/literaryQualityLogic';
import { generateEntityId } from '../utils/novelLogic';
import {
  acquireEpisodeLock,
  callWithRetry,
  extractUsageMetadata,
  getConfiguredWritingModel,
  getGenAiClient,
  releaseEpisodeLock,
  reviewManuscriptOnServer,
  translateGeminiErrorKo,
} from './geminiWritingEngine.ts';

export type CustomLiteraryQualityEvaluator = (params: {
  systemInstruction: string;
  promptContent: string;
  modelId: string;
  manuscript: string;
  context: WritingContextBundle;
}) => Promise<{
  rawAiOutput: unknown;
  usageMetadata?: TokenUsageMetadata;
}>;

let customLiteraryQualityEvaluatorForTesting: CustomLiteraryQualityEvaluator | null =
  null;

export function setCustomLiteraryQualityEvaluatorForTesting(
  fn: CustomLiteraryQualityEvaluator | null
): void {
  customLiteraryQualityEvaluatorForTesting = fn;
}

export async function evaluateLiteraryQualityOnServer(params: {
  ownerId: string;
  projectId: string;
  episodeId: string;
  sourceRunId?: string;
  sourceRevisionId: string;
  manuscript: string;
  context: WritingContextBundle;
  includeStyleEditorAudit?: boolean;
  styleReferences?: StyleReferenceAnalysis[];
  existingStyleIssues?: WritingIssue[];
}): Promise<LiteraryQualityEvaluationResponse> {
  const {
    ownerId,
    projectId,
    episodeId,
    sourceRevisionId,
    manuscript,
    context,
    includeStyleEditorAudit = false,
    styleReferences,
    existingStyleIssues = [],
  } = params;

  if (!projectId.trim() || !episodeId.trim()) {
    throw new Error('[BAD_REQUEST] 품질 진단에는 projectId와 episodeId가 필요합니다.');
  }
  if (context.projectId !== projectId || context.episodeId !== episodeId) {
    throw new Error(
      '[TENANT_ISOLATION] 요청된 projectId/episodeId와 집필 문맥(WritingContextBundle)이 일치하지 않습니다.'
    );
  }
  if (!manuscript || !manuscript.trim()) {
    throw new Error('[BAD_REQUEST] 문학적 품질을 진단할 원고 본문이 비어 있습니다.');
  }
  if (!sourceRevisionId.trim()) {
    throw new Error('[BAD_REQUEST] 원고 무결성 잠금을 위한 sourceRevisionId가 필요합니다.');
  }

  const runId = params.sourceRunId?.trim() || generateEntityId('run_lq');
  const modelId = getConfiguredWritingModel();
  const lockEpisodeKey = `${episodeId}:quality`;

  const promptBuild = buildLiteraryQualityEvaluationPrompt({
    ownerId,
    context,
    manuscript,
    styleReferences,
  });

  if (promptBuild.rejectedStyleReferenceReasons.length > 0) {
    const firstReject = promptBuild.rejectedStyleReferenceReasons[0];
    if (firstReject.includes('TENANT_ISOLATION')) {
      throw new Error(firstReject);
    }
    throw new Error(`[BAD_REQUEST] ${firstReject}`);
  }

  acquireEpisodeLock(projectId, lockEpisodeKey, runId);

  let qualityUsage = createEmptyUsageMetadata();
  let styleUsage = createEmptyUsageMetadata();
  let qualityApiCalls = 0;
  let styleApiCalls = 0;

  try {
    let rawAiOutput: unknown;

    if (customLiteraryQualityEvaluatorForTesting) {
      qualityApiCalls = 1;
      const mocked = await customLiteraryQualityEvaluatorForTesting({
        systemInstruction: promptBuild.systemInstruction,
        promptContent: promptBuild.promptContent,
        modelId,
        manuscript,
        context,
      });
      rawAiOutput = mocked.rawAiOutput;
      qualityUsage = mocked.usageMetadata || {
        promptTokenCount: Math.ceil(promptBuild.promptContent.length / 2.5),
        candidatesTokenCount: 250,
        totalTokenCount: Math.ceil(promptBuild.promptContent.length / 2.5) + 250,
        estimatedCostUsd: 0.0002,
        isActualUsage: false,
      };
    } else {
      const ai = getGenAiClient();
      qualityApiCalls = 1;
      const response = await callWithRetry(() =>
        ai.models.generateContent({
          model: modelId,
          contents: promptBuild.promptContent,
          config: {
            systemInstruction: promptBuild.systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: LITERARY_QUALITY_GEMINI_RESPONSE_SCHEMA,
          },
        })
      );
      const rawText = (response.text ?? '{}').trim();
      rawAiOutput = JSON.parse(rawText);
      qualityUsage = extractUsageMetadata(
        response,
        promptBuild.promptContent,
        rawText
      );
    }

    let styleIssuesToMerge: WritingIssue[] = [...existingStyleIssues];
    if (includeStyleEditorAudit) {
      styleApiCalls = 1;
      const styleAuditRes = await reviewManuscriptOnServer({
        ownerId,
        context,
        manuscriptToReview: manuscript,
        reviewFocus: 'STYLE_ONLY',
      });
      styleUsage = styleAuditRes.usageMetadata;
      styleIssuesToMerge = [
        ...styleIssuesToMerge,
        ...styleAuditRes.issues.filter(
          (i) => i.sourceModule === 'STYLE_EDITOR' || i.source === 'STYLE_EDITOR'
        ),
      ];
    }

    const baseReport = buildVerifiedLiteraryQualityReport({
      projectId,
      episodeId,
      sourceRunId: runId,
      sourceRevisionId,
      manuscript,
      appliedPromptVersionIds: promptBuild.appliedPromptVersionIds,
      appliedPerspective: promptBuild.appliedPerspective,
      modelId,
      rawAiOutput,
      qualityUsageMetadata: qualityUsage,
      styleEditorUsageMetadata: styleUsage,
      qualityApiCallCount: qualityApiCalls,
      styleEditorApiCallCount: styleApiCalls,
    });

    const mergeResult = mergeStyleAuditAndQualityFindings({
      report: baseReport,
      manuscript,
      styleIssues: styleIssuesToMerge,
    });

    return {
      executionStatus: 'COMPLETED',
      report: mergeResult.mergedReport,
      mergedStyleIssuesCount: mergeResult.mergedCount,
    };
  } catch (err) {
    const errKo = translateGeminiErrorKo(err);
    const failedReport = buildFailedLiteraryQualityReport({
      projectId,
      episodeId,
      sourceRunId: runId,
      sourceRevisionId,
      manuscript,
      appliedPromptVersionIds: promptBuild.appliedPromptVersionIds,
      appliedPerspective: promptBuild.appliedPerspective,
      modelId,
      errorMessage: errKo,
      qualityUsageMetadata: qualityUsage,
      styleEditorUsageMetadata: styleUsage,
      qualityApiCallCount: qualityApiCalls,
      styleEditorApiCallCount: styleApiCalls,
    });

    return {
      executionStatus: 'QUALITY_EVALUATION_FAILED',
      report: failedReport,
      mergedStyleIssuesCount: 0,
      errorMessage: errKo,
    };
  } finally {
    releaseEpisodeLock(projectId, lockEpisodeKey, runId);
  }
}
