import express from 'express';
import {
  ensureFirebaseAdminInitialized,
  isServerCloudAuthEnforced,
  resolveSecureRequestOwner,
  verifyAdminFirestoreProjectOwnership,
  verifyBearerToken,
} from './authMiddleware.ts';
import { getEngineArchitectureStatus } from './geminiEngineStub.ts';
import {
  approveManuscriptResultOnServer,
  cancelGenerationRun,
  curateEpisodeMemoryOnServer,
  generateNovelSceneOnServer,
  generatePlotPlanOnServer,
  reviewManuscriptOnServer,
} from './geminiWritingEngine.ts';
import { evaluateLiteraryQualityOnServer } from './literaryQualityEngine.ts';
import { rewriteLiteraryPassageOnServer } from './literaryRewritingEngine.ts';
import { analyzeAuthorStyleOnServer } from './authorStyleAnalyzer.ts';
import { analyzeCharacterVoice, continuityRequest, getVoiceFirestore, reviewCharacterContinuity, voiceAnalysisRequest, VoiceRequestError } from './characterVoiceAnalyzer.ts';
import { resolveVoicePromptContext } from './voicePromptContext.ts';
import { listVoiceContinuityDecisions, listVoiceDecisionQuery, saveVoiceContinuityDecision, saveVoiceDecisionRequest } from './voiceContinuityDecisions.ts';
import { VoiceDecisionError } from '../utils/voiceContinuityDecisionLogic';
import {
  executeServerManuscriptExtraction,
  saveVerifiedExtractionProposalsOnServer,
} from './manuscriptExtractionEngine.ts';
import {
  approveChangeProposalOnServer,
  executeRagSyncForApprovedProposalOnServer,
  listApprovalAuditsOnServer,
  previewChangeProposalApprovalOnServer,
  rejectChangeProposalOnServer,
} from './changeProposalApprovalEngine.ts';
import {
  assertNoClientTestEmbeddingModeInjection,
  deleteEntityIndexOnServer,
  deleteProjectIndexOnServer,
  getMemorySourceOnServer,
  getProjectRagStatusOnServer,
  indexMemoryInputOnServer,
  retryFailedProjectIndicesOnServer,
  searchProjectMemoryOnServer,
  syncOrRebuildProjectIndexOnServer,
} from './ragEngine.ts';
import {
  estimateIndexingScaleAndCost,
  extractProjectMemoryIndexInputs,
  type MemoryIndexInput,
} from '../services/memorySearchProvider.ts';
import { parseAndValidateProjectBundle } from '../utils/novelLogic.ts';
import type {
  Character,
  CharacterRelationship,
  Episode,
  ExpansionActionType,
  Foreshadowing,
  ManuscriptExtractionRequest,
  MemorySearchQuery,
  NovelForgeAppResult,
  Project,
  SaveExtractionProposalsRequest,
  ChangeProposalApprovalRequest,
  ChangeProposalPreviewRequest,
  ChangeProposalRejectionRequest,
  RagSyncExecutionRequest,
  StyleReferenceAnalysis,
  TimelineEvent,
  WorldbuildingItem,
  WritingContextBundle,
  WritingIssue,
  WritingPlan,
} from '../types/novel.ts';

async function resolveRequestOwner(
  req: express.Request,
  requireCloudAuth = false
): Promise<{
  ok: boolean;
  statusCode: 200 | 401 | 403;
  ownerId: string;
  isAuthenticatedCloud: boolean;
  error?: string;
}> {
  // Phase 3.1.1 P0-4: Authoritative server-side policy governs cloud auth requirement.
  // Clients cannot omit or alter headers to relax cloud auth enforcement.
  const serverEnforced = isServerCloudAuthEnforced() || requireCloudAuth;
  const claimedOwnerId =
    req.body?.ownerId ?? req.query?.ownerId ?? req.headers['x-owner-id'];
  return resolveSecureRequestOwner({
    authorizationHeader: req.headers.authorization,
    claimedOwnerId,
    requireCloudAuth: serverEnforced,
  });
}

function resolveRagErrorStatusCode(msg: string, fallback = 500): number {
  if (
    msg.includes('권한 거부') ||
    msg.includes('403') ||
    msg.includes('OWNERSHIP_MISMATCH') ||
    msg.includes('OWNER_MISMATCH') ||
    msg.includes('NOT_OWNED') ||
    msg.includes('CANON_SPOOF') ||
    msg.includes('REVISION_SPOOF')
  ) {
    return 403;
  }
  if (
    msg.includes('401') ||
    msg.includes('미인증') ||
    msg.includes('CLOUD_AUTH_REQUIRED')
  ) {
    return 401;
  }
  if (msg.includes('429') || msg.includes('RATE_LIMIT')) {
    return 429;
  }
  if (msg.includes('503') || msg.includes('SERVICE_UNAVAILABLE')) {
    return 503;
  }
  if (msg.includes('400') || msg.includes('BAD_REQUEST')) {
    return 400;
  }
  return fallback;
}

export function createApiRouter(): express.Router {
  const app = express.Router();

  ensureFirebaseAdminInitialized();

  // 1. Server-side Firebase Auth ID Token Verification endpoint
  app.get('/api/auth/verify', async (req, res) => {
    const result = await verifyBearerToken(req.headers.authorization);
    if (!result.verified || !result.decoded) {
      res.status(200).json({
        verified: false,
        mode: 'unauthenticated',
        message: result.error || '미인증 상태 (로컬 작업 공간 또는 Google 로그인 대기 중)',
      });
      return;
    }

    res.status(200).json({
      verified: true,
      uid: result.decoded.uid,
      email: result.decoded.email || '',
      emailVerified: Boolean(result.decoded.email_verified),
      mode: 'firebase_id_token',
      verifiedAt: new Date().toISOString(),
      message: 'Node.js 서버에서 Firebase ID 토큰 서명 및 권한 검증 완료',
    });
  });

  // 2. Server-side Gemini Engine Architecture & Secret Isolation status endpoint
  app.get('/api/engine/architecture', async (req, res) => {
    const authResult = await verifyBearerToken(req.headers.authorization);
    const engineStatus = getEngineArchitectureStatus();
    res.status(200).json({
      ...engineStatus,
      authenticatedUserUid: authResult.verified ? authResult.decoded?.uid : null,
    });
  });

  // 3. Server-side Project JSON Bundle Validation endpoint
  app.post('/api/projects/validate-bundle', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ valid: false, error: ownerCheck.error });
      return;
    }
    const rawJson = typeof req.body?.rawJson === 'string' ? req.body.rawJson : '';
    const validation = parseAndValidateProjectBundle(rawJson, ownerCheck.ownerId);
    if (!validation.valid) {
      res.status(400).json({ valid: false, error: validation.error });
      return;
    }

    res.status(200).json({
      valid: true,
      bundle: validation.bundle,
      verifiedByServer: true,
      ownerUid: ownerCheck.ownerId,
    });
  });

  // ==========================================================================
  // Phase 2: Professional AI Novel Writing Engine Endpoints (Server-Side Only)
  // ==========================================================================

  // Module A: Plot Planner (장면 기획안 생성)
  app.post('/api/ai/plot-plan', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }


    const context = req.body?.context as WritingContextBundle | undefined;
    if (!context || !context.projectId || !context.episodeId) {
      res.status(400).json({
        error: '집필 문맥(WritingContextBundle) 데이터가 올바르지 않습니다.',
      });
      return;
    }

    try {
      const result = await generatePlotPlanOnServer({
        ownerId: ownerCheck.ownerId,
        context,
      });
      res.status(200).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI 장면 기획안 생성 중 오류가 발생했습니다.';
      res.status(500).json({ error: msg });
    }
  });

  // Module B: Novel Writer (장면/회차 본문 생성, 이어쓰기, 선택 구간 재작성, 분량 보강)
  app.post('/api/ai/write-scene', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const context = req.body?.context as WritingContextBundle | undefined;
    const plan = (req.body?.plan as WritingPlan | null | undefined) ?? null;
    const targetSceneNumber =
      typeof req.body?.targetSceneNumber === 'number'
        ? req.body.targetSceneNumber
        : undefined;
    const expansionAction = req.body?.expansionAction as
      | ExpansionActionType
      | undefined;
    const runId = typeof req.body?.runId === 'string' ? req.body.runId : undefined;

    if (!context || !context.projectId || !context.episodeId) {
      res.status(400).json({
        error: '집필 문맥(WritingContextBundle) 데이터가 올바르지 않습니다.',
      });
      return;
    }

    try {
      const result = await generateNovelSceneOnServer({
        runId,
        ownerId: ownerCheck.ownerId,
        context: await resolveVoicePromptContext(context, ownerCheck.ownerId, ownerCheck.isAuthenticatedCloud),
        plan,
        targetSceneNumber,
        expansionAction,
      });
      res.status(200).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI 본문 생성 중 오류가 발생했습니다.';
      res.status(err instanceof VoiceRequestError ? err.status : 500).json({ error: msg });
    }
  });

  // Module C & D: Style Editor + Continuity Checker (문체 및 설정 충돌 검수)
  app.post('/api/ai/review', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const context = req.body?.context as WritingContextBundle | undefined;
    const manuscriptToReview =
      typeof req.body?.manuscriptToReview === 'string'
        ? req.body.manuscriptToReview
        : '';
    const reviewFocus =
      req.body?.reviewFocus === 'STYLE_ONLY' ||
      req.body?.reviewFocus === 'CONTINUITY_ONLY'
        ? req.body.reviewFocus
        : 'BOTH';
    const currentAppResult =
      (req.body?.currentAppResult as NovelForgeAppResult | null | undefined) ??
      null;

    if (!context || !manuscriptToReview.trim()) {
      res.status(400).json({
        error: '검수할 원고 본문이 비어 있습니다. 먼저 원고를 작성하거나 생성해 주세요.',
      });
      return;
    }

    try {
      const result = await reviewManuscriptOnServer({
        ownerId: ownerCheck.ownerId,
        context,
        manuscriptToReview,
        reviewFocus,
        currentAppResult,
      });
      res.status(200).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI 원고 검수 중 오류가 발생했습니다.';
      res.status(500).json({ error: msg });
    }
  });

  // Phase 4.3A: Literary Quality Evaluation & Editorial Intelligence Engine
  app.post('/api/ai/evaluate-quality', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const projectId =
      typeof req.body?.projectId === 'string'
        ? req.body.projectId.trim()
        : typeof req.body?.context?.projectId === 'string'
        ? req.body.context.projectId.trim()
        : '';
    const episodeId =
      typeof req.body?.episodeId === 'string'
        ? req.body.episodeId.trim()
        : typeof req.body?.context?.episodeId === 'string'
        ? req.body.context.episodeId.trim()
        : '';
    const sourceRevisionId =
      typeof req.body?.sourceRevisionId === 'string'
        ? req.body.sourceRevisionId.trim()
        : '';
    const manuscript =
      typeof req.body?.manuscript === 'string' ? req.body.manuscript : '';
    const context = req.body?.context as WritingContextBundle | undefined;

    if (!projectId || !episodeId || !context || !manuscript.trim() || !sourceRevisionId) {
      res.status(400).json({
        error:
          '[BAD_REQUEST] 문학적 품질 진단을 위해 projectId, episodeId, sourceRevisionId, context, manuscript가 모두 필요합니다.',
      });
      return;
    }

    if (ownerCheck.isAuthenticatedCloud) {
      const projectOwnership = await verifyAdminFirestoreProjectOwnership({
        authenticatedUid: ownerCheck.ownerId,
        isAuthenticatedCloud: true,
        projectId,
        claimedOwnerId: req.body?.ownerId,
      });
      if (!projectOwnership.ok) {
        res
          .status(projectOwnership.statusCode)
          .json({ error: projectOwnership.error });
        return;
      }
    }

    try {
      const result = await evaluateLiteraryQualityOnServer({
        ownerId: ownerCheck.ownerId,
        projectId,
        episodeId,
        sourceRunId:
          typeof req.body?.sourceRunId === 'string'
            ? req.body.sourceRunId.trim()
            : undefined,
        sourceRevisionId,
        manuscript,
        context,
        includeStyleEditorAudit: Boolean(req.body?.includeStyleEditorAudit),
        styleReferences: Array.isArray(req.body?.styleReferences)
          ? (req.body.styleReferences as StyleReferenceAnalysis[])
          : undefined,
        existingStyleIssues: Array.isArray(req.body?.existingStyleIssues)
          ? (req.body.existingStyleIssues as WritingIssue[])
          : undefined,
      });
      res.status(200).json(result);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : '문학적 품질 진단 처리 중 오류가 발생했습니다.';
      const statusCode =
        msg.includes('TENANT_ISOLATION') ||
        msg.includes('OWNERSHIP_MISMATCH') ||
        msg.includes('권한')
          ? 403
          : msg.includes('BAD_REQUEST')
          ? 400
          : msg.includes('이미 진행 중')
          ? 409
          : 500;
      res.status(statusCode).json({ error: msg });
    }
  });

  // Phase 4.3B: Advanced Literary Rewriting Engine
  app.post('/api/ai/rewrite-literary', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const projectId =
      typeof req.body?.projectId === 'string'
        ? req.body.projectId.trim()
        : typeof req.body?.context?.projectId === 'string'
        ? req.body.context.projectId.trim()
        : '';
    const episodeId =
      typeof req.body?.episodeId === 'string'
        ? req.body.episodeId.trim()
        : typeof req.body?.context?.episodeId === 'string'
        ? req.body.context.episodeId.trim()
        : '';
    const manuscript =
      typeof req.body?.manuscript === 'string' ? req.body.manuscript : '';
    const anchor = req.body?.anchor;
    const modes = Array.isArray(req.body?.modes) ? req.body.modes : [];
    const context = req.body?.context as WritingContextBundle | undefined;

    if (!projectId || !episodeId || !context || !manuscript.trim() || !anchor || modes.length === 0) {
      res.status(400).json({
        error:
          '[BAD_REQUEST] 정밀 리라이팅을 위해 projectId, episodeId, anchor, modes, context, manuscript가 모두 필요합니다.',
      });
      return;
    }

    if (ownerCheck.isAuthenticatedCloud) {
      const projectOwnership = await verifyAdminFirestoreProjectOwnership({
        authenticatedUid: ownerCheck.ownerId,
        isAuthenticatedCloud: true,
        projectId,
        claimedOwnerId: req.body?.ownerId,
      });
      if (!projectOwnership.ok) {
        res
          .status(projectOwnership.statusCode)
          .json({ error: projectOwnership.error });
        return;
      }
    }

    try {
      const result = await rewriteLiteraryPassageOnServer(
        {
          ownerId: ownerCheck.ownerId,
          projectId,
          episodeId,
          sourceRunId:
            typeof req.body?.sourceRunId === 'string'
              ? req.body.sourceRunId.trim()
              : undefined,
          sourceRevisionId:
            typeof req.body?.sourceRevisionId === 'string'
              ? req.body.sourceRevisionId.trim()
              : '',
          manuscript,
          anchor,
          modes,
          confirmedVoiceCharacterId: typeof req.body?.confirmedVoiceCharacterId === 'string'
            ? req.body.confirmedVoiceCharacterId : undefined,
          authorInstruction:
            typeof req.body?.authorInstruction === 'string'
              ? req.body.authorInstruction
              : undefined,
          linkedQualityFindingId:
            typeof req.body?.linkedQualityFindingId === 'string'
              ? req.body.linkedQualityFindingId
              : undefined,
          linkedQualityDimension: req.body?.linkedQualityDimension,
          allowUnverifiedTypoOnlyPreview: Boolean(
            req.body?.allowUnverifiedTypoOnlyPreview
          ),
          context: await resolveVoicePromptContext(context, ownerCheck.ownerId, ownerCheck.isAuthenticatedCloud),
        },
        {
          isAuthenticatedCloud: ownerCheck.isAuthenticatedCloud,
        }
      );
      res.status(200).json(result);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : '정밀 문학 리라이팅 처리 중 오류가 발생했습니다.';
      const statusCode =
        msg.includes('TENANT_ISOLATION') ||
        msg.includes('OWNERSHIP_MISMATCH') ||
        msg.includes('권한')
          ? 403
          : msg.includes('BAD_REQUEST') ||
            msg.includes('INVALID_') ||
            msg.includes('SELECTION_') ||
            msg.includes('AMBIGUOUS_')
          ? 400
          : msg.includes('STALE_') ||
            msg.includes('CONTENT_HASH_MISMATCH') ||
            msg.includes('이미 진행 중')
          ? 409
          : 500;
      res.status(statusCode).json({ error: msg });
    }
  });

  const voiceDecisions: express.RequestHandler = async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const owner = await resolveRequestOwner(req, true);
    if (!owner.ok || !owner.isAuthenticatedCloud) {
      const status = owner.ok ? 401 : owner.statusCode;
      res.status(status).json({ error: status === 403 ? '요청한 소유자가 로그인한 계정과 일치하지 않습니다.' : 'Firebase 로그인을 확인해 주세요.' });
      return;
    }
    try {
      const firestore = getVoiceFirestore();
      if (req.method === 'GET') {
        const parsed = listVoiceDecisionQuery.safeParse(req.query);
        if (!parsed.success) throw new VoiceRequestError(400, '유효한 판단 기록 조회 조건이 필요합니다.');
        res.json(await listVoiceContinuityDecisions(firestore, owner.ownerId, parsed.data));
      } else {
        const parsed = saveVoiceDecisionRequest.safeParse(req.body);
        if (!parsed.success) throw new VoiceRequestError(400, '유효한 판단 기록 저장 조건이 필요합니다.');
        res.json(await saveVoiceContinuityDecision(firestore, owner.ownerId, parsed.data));
      }
    } catch (error) {
      if (error instanceof VoiceDecisionError) {
        res.status(error.code === 'INVALID_DECISION' ? 400 : 409).json({ error: error.code, code: error.code });
      } else if (error instanceof VoiceRequestError) {
        res.status(error.status).json({ error: error.message, ...(error.message.startsWith('STALE_SOURCE') ? { code: 'STALE_SOURCE' } : {}) });
      } else {
        res.status(500).json({ error: '화법 판단 기록을 처리하지 못했습니다.' });
      }
    }
  };
  app.get('/api/voice-continuity/decisions', voiceDecisions);
  app.post('/api/voice-continuity/decisions', voiceDecisions);

  app.post(['/api/ai/analyze-character-voice', '/api/ai/review-style-continuity'], async (req, res) => {
    const owner = await resolveRequestOwner(req);
    if (!owner.ok) {
      res.status(owner.statusCode).json({ error: owner.error });
      return;
    }
    try {
      const db = owner.isAuthenticatedCloud ? getVoiceFirestore() : undefined;
      if (req.path === '/api/ai/analyze-character-voice') {
        const parsed = voiceAnalysisRequest.safeParse(req.body);
        if (!parsed.success) throw new VoiceRequestError(400, '인물과 유효한 분석 표본을 선택해 주세요.');
        res.json(await analyzeCharacterVoice(parsed.data, owner.ownerId, db));
      } else {
        const parsed = continuityRequest.safeParse(req.body);
        if (!parsed.success) throw new VoiceRequestError(400, '저장된 Revision을 2개 이상 선택해 주세요.');
        res.json(await reviewCharacterContinuity(parsed.data, owner.ownerId, db));
      }
    } catch (error) {
      res.status(error instanceof VoiceRequestError ? error.status : 500)
        .json({ error: error instanceof VoiceRequestError ? error.message : '화법 분석 중 서버 오류가 발생했습니다.' });
    }
  });

  // Phase 4.3C Stage 1: Author Style DNA Analysis Endpoint
  app.post('/api/ai/analyze-style', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const projectId =
      typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const inputMode = req.body?.inputMode;

    if (!projectId || !inputMode) {
      res.status(400).json({
        error: '[BAD_REQUEST] 문체 DNA 분석에는 projectId와 inputMode가 필요합니다.',
      });
      return;
    }

    if (ownerCheck.isAuthenticatedCloud) {
      const projectOwnership = await verifyAdminFirestoreProjectOwnership({
        authenticatedUid: ownerCheck.ownerId,
        isAuthenticatedCloud: true,
        projectId,
        claimedOwnerId: req.body?.ownerId,
      });
      if (!projectOwnership.ok) {
        res
          .status(projectOwnership.statusCode)
          .json({ error: projectOwnership.error });
        return;
      }
    }

    try {
      const result = await analyzeAuthorStyleOnServer(
        {
          ownerId: ownerCheck.ownerId,
          projectId,
          inputMode,
          sampleText:
            typeof req.body?.sampleText === 'string'
              ? req.body.sampleText
              : undefined,
          sampleLabel:
            typeof req.body?.sampleLabel === 'string'
              ? req.body.sampleLabel
              : undefined,
          episodeId:
            typeof req.body?.episodeId === 'string'
              ? req.body.episodeId.trim()
              : undefined,
          revisionId:
            typeof req.body?.revisionId === 'string'
              ? req.body.revisionId.trim()
              : undefined,
          expectedContentHash:
            typeof req.body?.expectedContentHash === 'string'
              ? req.body.expectedContentHash.trim()
              : undefined,
          selectedRange: req.body?.selectedRange,
          useGeminiStage2:
            typeof req.body?.useGeminiStage2 === 'boolean'
              ? req.body.useGeminiStage2
              : true,
          allowDeterministicFallbackWithoutApiKey:
            typeof req.body?.allowDeterministicFallbackWithoutApiKey === 'boolean'
              ? req.body.allowDeterministicFallbackWithoutApiKey
              : true,
        },
        {
          isAuthenticatedCloud: ownerCheck.isAuthenticatedCloud,
        }
      );
      res.status(200).json(result);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : '작가 문체 DNA 분석 처리 중 오류가 발생했습니다.';
      const statusCode =
        msg.includes('TENANT_ISOLATION') ||
        msg.includes('OWNERSHIP_MISMATCH') ||
        msg.includes('권한')
          ? 403
          : msg.includes('NOT_FOUND')
          ? 404
          : msg.includes('STALE_REVISION_CONFLICT')
          ? 409
          : msg.includes('BAD_REQUEST') ||
            msg.includes('INVALID_') ||
            msg.includes('API_KEY_MISSING')
          ? 400
          : 500;
      res.status(statusCode).json({ error: msg });
    }
  });

  // Author Approval Endpoint (`novelforge_app_result.schema.json` -> APPROVED / CANON)
  app.post('/api/ai/approve-result', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const currentAppResult = req.body?.currentAppResult as
      | NovelForgeAppResult
      | undefined;
    if (!currentAppResult) {
      res.status(400).json({
        error: '승인할 통합 결과(NovelForgeAppResult) 데이터가 없습니다.',
      });
      return;
    }

    try {
      const approvedResult = approveManuscriptResultOnServer({
        ownerId: ownerCheck.ownerId,
        currentAppResult,
        promoteToCanon: Boolean(req.body?.promoteToCanon),
        resolvedIssueIds: Array.isArray(req.body?.resolvedIssueIds)
          ? req.body.resolvedIssueIds
          : [],
        revisedManuscript:
          typeof req.body?.revisedManuscript === 'string'
            ? req.body.revisedManuscript
            : undefined,
      });
      res.status(200).json({ appResult: approvedResult });
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : '작가 승인 처리 중 오류가 발생했습니다.';
      res.status(400).json({ error: msg });
    }
  });

  // Module E: Memory Curator (원고 확정 후 장기 기억 요약 및 PROPOSED 설정 제안 추출)
  app.post('/api/ai/curate-memory', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const context = req.body?.context as WritingContextBundle | undefined;
    const confirmedManuscript =
      typeof req.body?.confirmedManuscript === 'string'
        ? req.body.confirmedManuscript
        : '';
    const sourceRevisionId =
      typeof req.body?.sourceRevisionId === 'string'
        ? req.body.sourceRevisionId
        : '';

    if (!context || !confirmedManuscript.trim()) {
      res.status(400).json({
        error: '기억 정리를 수행할 확정 원고 본문이 없습니다.',
      });
      return;
    }

    try {
      const result = await curateEpisodeMemoryOnServer({
        ownerId: ownerCheck.ownerId,
        context,
        confirmedManuscript,
        sourceRevisionId,
      });
      res.status(200).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '장기 기억 정리 중 오류가 발생했습니다.';
      res.status(500).json({ error: msg });
    }
  });

    // Generation Cancellation Endpoint ([생성 중단])
  app.post('/api/ai/cancel', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const runId = typeof req.body?.runId === 'string' ? req.body.runId : '';
    const cancelled = runId ? cancelGenerationRun(runId) : false;
    res.status(200).json({
      cancelled,
      message: cancelled
        ? '진행 중인 AI 생성 작업을 즉시 중단했습니다.'
        : '중단할 진행 중 작업이 없거나 이미 완료되었습니다.',
    });
  });

  // ==========================================================================
  // Phase 4.2.1: AI Manuscript Analysis & Structured ChangeProposal Extraction
  // ==========================================================================
  app.post('/api/ai/extract-manuscript', async (req, res) => {
    const hasAuthHeader =
      typeof req.headers.authorization === 'string' &&
      req.headers.authorization.trim().length > 0;
    const requireCloudAuth = isServerCloudAuthEnforced() || hasAuthHeader;

    const ownerCheck = await resolveRequestOwner(req, requireCloudAuth);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const projectId =
      typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const episodeId =
      typeof req.body?.episodeId === 'string' ? req.body.episodeId.trim() : '';
    const revisionId =
      typeof req.body?.revisionId === 'string' ? req.body.revisionId.trim() : '';

    if (!projectId || !episodeId || !revisionId) {
      res.status(400).json({
        error: '원고 분석에는 projectId, episodeId, revisionId가 모두 필요합니다.',
      });
      return;
    }

    if (ownerCheck.isAuthenticatedCloud) {
      const projectOwnership = await verifyAdminFirestoreProjectOwnership({
        authenticatedUid: ownerCheck.ownerId,
        isAuthenticatedCloud: true,
        projectId,
        claimedOwnerId: req.body?.ownerId,
      });
      if (!projectOwnership.ok) {
        res
          .status(projectOwnership.statusCode)
          .json({ error: projectOwnership.error });
        return;
      }
    }

    const persistProposals = Boolean(req.body?.persistProposals);
    const selectedCandidateIds = Array.isArray(req.body?.selectedCandidateIds)
      ? req.body.selectedCandidateIds.filter(
          (id: unknown): id is string => typeof id === 'string'
        )
      : undefined;

    if (persistProposals && (!selectedCandidateIds || selectedCandidateIds.length === 0)) {
      res.status(400).json({
        error:
          '[EMPTY_SELECTION_FORBIDDEN] 제안서 저장(persistProposals=true) 요청에는 최소 1개 이상의 selectedCandidateIds가 필요합니다.',
      });
      return;
    }

    const extractionRequest: ManuscriptExtractionRequest = {
      projectId,
      episodeId,
      revisionId,
      sceneId:
        typeof req.body?.sceneId === 'string' ? req.body.sceneId.trim() : undefined,
      persistProposals,
      selectedCandidateIds,
      selectedCandidateSpanOverrides:
        req.body?.selectedCandidateSpanOverrides &&
        typeof req.body.selectedCandidateSpanOverrides === 'object'
          ? req.body.selectedCandidateSpanOverrides
          : undefined,
      allowUpdateRejected: false,
      // Ignore client localPreviewSnapshot when authenticated in cloud mode
      localPreviewSnapshot: ownerCheck.isAuthenticatedCloud
        ? undefined
        : req.body?.localPreviewSnapshot,
    };

    try {
      const result = await executeServerManuscriptExtraction(extractionRequest, {
        verifiedOwnerId: ownerCheck.isAuthenticatedCloud
          ? ownerCheck.ownerId
          : null,
      });
      res.status(200).json(result);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'AI 원고 설정 추출 중 오류가 발생했습니다.';
      const statusCode =
        msg.includes('AUTH_REQUIRED') || msg.includes('미인증')
          ? 401
          : msg.includes('OWNERSHIP_MISMATCH') ||
            msg.includes('TENANT_ISOLATION') ||
            msg.includes('권한')
          ? 403
          : msg.includes('NOT_FOUND') ||
            msg.includes('EMPTY_REVISION') ||
            msg.includes('EMPTY_SELECTION') ||
            msg.includes('INVALID_CANDIDATE') ||
            msg.includes('CANDIDATE_NOT') ||
            msg.includes('UNVERIFIED_CANDIDATE') ||
            msg.includes('MISMATCH') ||
            msg.includes('SNAPSHOT_REQUIRED')
          ? 400
          : msg.includes('LOCKED') || msg.includes('ALREADY_RUNNING')
          ? 409
          : 500;
      res.status(statusCode).json({ error: msg });
    }
  });

  // Phase 4.2.1 Stage 2: Save Author-Selected Verified Extraction Proposals (Without Re-Calling Gemini)
  app.post('/api/ai/save-extraction-proposals', async (req, res) => {
    const hasAuthHeader =
      typeof req.headers.authorization === 'string' &&
      req.headers.authorization.trim().length > 0;
    const requireCloudAuth = isServerCloudAuthEnforced() || hasAuthHeader;

    const ownerCheck = await resolveRequestOwner(req, requireCloudAuth);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const projectId =
      typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const episodeId =
      typeof req.body?.episodeId === 'string' ? req.body.episodeId.trim() : '';
    const revisionId =
      typeof req.body?.revisionId === 'string' ? req.body.revisionId.trim() : '';
    const analysisRunId =
      typeof req.body?.analysisRunId === 'string'
        ? req.body.analysisRunId.trim()
        : '';
    const analysisToken =
      typeof req.body?.analysisToken === 'string'
        ? req.body.analysisToken.trim()
        : '';
    const selectedCandidateIds = Array.isArray(req.body?.selectedCandidateIds)
      ? req.body.selectedCandidateIds.filter(
          (id: unknown): id is string => typeof id === 'string'
        )
      : [];

    if (!projectId || !episodeId || !revisionId) {
      res.status(400).json({
        error: '제안서 저장에는 projectId, episodeId, revisionId가 모두 필요합니다.',
      });
      return;
    }

    if (!analysisRunId || !analysisToken) {
      res.status(400).json({
        error:
          '[INVALID_ANALYSIS_TOKEN] 서버 분석 검증 토큰(analysisRunId, analysisToken)이 필요합니다.',
      });
      return;
    }

    if (selectedCandidateIds.length === 0) {
      res.status(400).json({
        error:
          '[EMPTY_SELECTION_FORBIDDEN] 저장할 후보를 1개 이상 명시적으로 선택해야 합니다(selectedCandidateIds 필수).',
      });
      return;
    }

    if (ownerCheck.isAuthenticatedCloud) {
      const projectOwnership = await verifyAdminFirestoreProjectOwnership({
        authenticatedUid: ownerCheck.ownerId,
        isAuthenticatedCloud: true,
        projectId,
        claimedOwnerId: req.body?.ownerId,
      });
      if (!projectOwnership.ok) {
        res
          .status(projectOwnership.statusCode)
          .json({ error: projectOwnership.error });
        return;
      }
    }

    const saveRequest: SaveExtractionProposalsRequest = {
      projectId,
      episodeId,
      revisionId,
      analysisRunId,
      analysisToken,
      selectedCandidateIds,
      selectedCandidateSpanOverrides:
        req.body?.selectedCandidateSpanOverrides &&
        typeof req.body.selectedCandidateSpanOverrides === 'object'
          ? req.body.selectedCandidateSpanOverrides
          : undefined,
      localPreviewSnapshot: ownerCheck.isAuthenticatedCloud
        ? undefined
        : req.body?.localPreviewSnapshot,
    };

    try {
      const result = await saveVerifiedExtractionProposalsOnServer(saveRequest, {
        verifiedOwnerId: ownerCheck.isAuthenticatedCloud
          ? ownerCheck.ownerId
          : null,
      });
      res.status(200).json(result);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : '선택한 제안서 저장 중 오류가 발생했습니다.';
      const statusCode =
        msg.includes('AUTH_REQUIRED') || msg.includes('미인증')
          ? 401
          : msg.includes('OWNERSHIP_MISMATCH') ||
            msg.includes('TENANT_ISOLATION') ||
            msg.includes('CANON_BYPASS_FORBIDDEN') ||
            msg.includes('권한')
          ? 403
          : msg.includes('REVISION_CHANGED_SINCE_ANALYSIS')
          ? 409
          : msg.includes('EMPTY_SELECTION') ||
            msg.includes('INVALID_CANDIDATE') ||
            msg.includes('CANDIDATE_NOT') ||
            msg.includes('UNVERIFIED_CANDIDATE') ||
            msg.includes('INVALID_ANALYSIS_TOKEN') ||
            msg.includes('ANALYSIS_TOKEN_EXPIRED') ||
            msg.includes('NOT_FOUND') ||
            msg.includes('MISMATCH') ||
            msg.includes('SNAPSHOT_REQUIRED') ||
            msg.includes('BAD_REQUEST')
          ? 400
          : 500;
      res.status(statusCode).json({ error: msg });
    }
  });

  // ==========================================================================
  // Phase 4.2.2: Server-Side Author Approval & Rejection Engine (Atomic CANON)
  // ==========================================================================
  app.post('/api/ai/change-proposals/approve', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req, true);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const projectId =
      typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const proposalId =
      typeof req.body?.proposalId === 'string'
        ? req.body.proposalId.trim()
        : '';

    if (!projectId || !proposalId) {
      res.status(400).json({
        error:
          '[BAD_REQUEST] 제안서 승인에는 projectId와 proposalId가 모두 필요합니다.',
      });
      return;
    }

    const projectOwnership = await verifyAdminFirestoreProjectOwnership({
      authenticatedUid: ownerCheck.ownerId,
      isAuthenticatedCloud: ownerCheck.isAuthenticatedCloud,
      projectId,
      claimedOwnerId: req.body?.ownerId,
    });
    if (!projectOwnership.ok) {
      res
        .status(projectOwnership.statusCode)
        .json({ error: projectOwnership.error });
      return;
    }

    if (req.body?.forceApplyOnStale === true) {
      res.status(409).json({
        error:
          '[STALE_OVERRIDE_FORBIDDEN] 일반 승인 경로에서는 forceApplyOnStale=true를 통한 UPDATE 충돌 우회가 금지되어 있습니다.',
      });
      return;
    }

    const approvalRequest: ChangeProposalApprovalRequest = {
      projectId,
      proposalId,
      expectedUpdatedAt:
        typeof req.body?.expectedUpdatedAt === 'string'
          ? req.body.expectedUpdatedAt.trim()
          : undefined,
      reviewNote:
        typeof req.body?.reviewNote === 'string'
          ? req.body.reviewNote
          : undefined,
      forceApplyOnStale: false,
      overrides:
        req.body?.overrides && typeof req.body.overrides === 'object'
          ? req.body.overrides
          : undefined,
    };

    try {
      const result = await approveChangeProposalOnServer(approvalRequest, {
        verifiedOwnerId: ownerCheck.ownerId,
      });
      res.status(200).json(result);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : '제안서 승인 및 CANON 반영 중 오류가 발생했습니다.';
      const statusCode =
        msg.includes('AUTH_REQUIRED') || msg.includes('미인증')
          ? 401
          : msg.includes('TENANT_ISOLATION') ||
            msg.includes('OWNERSHIP_MISMATCH') ||
            msg.includes('권한')
          ? 403
          : msg.includes('NOT_FOUND')
          ? 404
          : msg.includes('STALE_TARGET') ||
            msg.includes('STALE_OVERRIDE_FORBIDDEN') ||
            msg.includes('CONFLICT') ||
            msg.includes('TARGET_ALREADY_EXISTS') ||
            msg.includes('INVALID_PROPOSAL_STATE') ||
            msg.includes('AUDIT_STATE_INCONSISTENCY')
          ? 409
          : msg.includes('BAD_REQUEST') ||
            msg.includes('UNSUPPORTED_ENTITY_OR_ACTION') ||
            msg.includes('PAYLOAD_INTEGRITY_ERROR') ||
            msg.includes('REFERENCE_INTEGRITY_ERROR') ||
            msg.includes('EXCERPT_OFFSET_INVALID')
          ? 400
          : 500;
      res.status(statusCode).json({ error: msg });
    }
  });

  app.post('/api/ai/change-proposals/reject', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req, true);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const projectId =
      typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const proposalId =
      typeof req.body?.proposalId === 'string'
        ? req.body.proposalId.trim()
        : '';

    if (!projectId || !proposalId) {
      res.status(400).json({
        error:
          '[BAD_REQUEST] 제안서 반려에는 projectId와 proposalId가 모두 필요합니다.',
      });
      return;
    }

    const projectOwnership = await verifyAdminFirestoreProjectOwnership({
      authenticatedUid: ownerCheck.ownerId,
      isAuthenticatedCloud: ownerCheck.isAuthenticatedCloud,
      projectId,
      claimedOwnerId: req.body?.ownerId,
    });
    if (!projectOwnership.ok) {
      res
        .status(projectOwnership.statusCode)
        .json({ error: projectOwnership.error });
      return;
    }

    const rejectionRequest: ChangeProposalRejectionRequest = {
      projectId,
      proposalId,
      expectedUpdatedAt:
        typeof req.body?.expectedUpdatedAt === 'string'
          ? req.body.expectedUpdatedAt.trim()
          : undefined,
      reviewNote:
        typeof req.body?.reviewNote === 'string'
          ? req.body.reviewNote
          : undefined,
    };

    try {
      const result = await rejectChangeProposalOnServer(rejectionRequest, {
        verifiedOwnerId: ownerCheck.ownerId,
      });
      res.status(200).json(result);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : '제안서 반려 처리 중 오류가 발생했습니다.';
      const statusCode =
        msg.includes('AUTH_REQUIRED') || msg.includes('미인증')
          ? 401
          : msg.includes('TENANT_ISOLATION') ||
            msg.includes('OWNERSHIP_MISMATCH') ||
            msg.includes('권한')
          ? 403
          : msg.includes('NOT_FOUND')
          ? 404
          : msg.includes('STALE_TARGET') ||
            msg.includes('INVALID_PROPOSAL_STATE') ||
            msg.includes('AUDIT_STATE_INCONSISTENCY')
          ? 409
          : msg.includes('BAD_REQUEST') ||
            msg.includes('UNSUPPORTED_ENTITY_OR_ACTION') ||
            msg.includes('PAYLOAD_INTEGRITY_ERROR')
          ? 400
          : 500;
      res.status(statusCode).json({ error: msg });
    }
  });

  app.post('/api/ai/change-proposals/preview', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req, true);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const projectId =
      typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const proposalId =
      typeof req.body?.proposalId === 'string'
        ? req.body.proposalId.trim()
        : '';

    if (!projectId || !proposalId) {
      res.status(400).json({
        error:
          '[BAD_REQUEST] 제안서 미리보기에는 projectId와 proposalId가 모두 필요합니다.',
      });
      return;
    }

    const projectOwnership = await verifyAdminFirestoreProjectOwnership({
      authenticatedUid: ownerCheck.ownerId,
      isAuthenticatedCloud: ownerCheck.isAuthenticatedCloud,
      projectId,
      claimedOwnerId: req.body?.ownerId,
    });
    if (!projectOwnership.ok) {
      res
        .status(projectOwnership.statusCode)
        .json({ error: projectOwnership.error });
      return;
    }

    const previewRequest: ChangeProposalPreviewRequest = {
      projectId,
      proposalId,
      expectedUpdatedAt:
        typeof req.body?.expectedUpdatedAt === 'string'
          ? req.body.expectedUpdatedAt.trim()
          : undefined,
      overrides:
        req.body?.overrides && typeof req.body.overrides === 'object'
          ? req.body.overrides
          : undefined,
    };

    try {
      const result = await previewChangeProposalApprovalOnServer(
        previewRequest,
        {
          verifiedOwnerId: ownerCheck.ownerId,
        }
      );
      res.status(200).json(result);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : '제안서 승인 미리보기 조회 중 오류가 발생했습니다.';
      const statusCode =
        msg.includes('AUTH_REQUIRED') || msg.includes('미인증')
          ? 401
          : msg.includes('TENANT_ISOLATION') ||
            msg.includes('OWNERSHIP_MISMATCH') ||
            msg.includes('권한')
          ? 403
          : msg.includes('NOT_FOUND')
          ? 404
          : msg.includes('BAD_REQUEST')
          ? 400
          : 500;
      res.status(statusCode).json({ error: msg });
    }
  });

  app.post('/api/ai/change-proposals/audits', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req, true);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const projectId =
      typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    if (!projectId) {
      res.status(400).json({
        error: '[BAD_REQUEST] 감사 이력 조회에는 projectId가 필요합니다.',
      });
      return;
    }

    const projectOwnership = await verifyAdminFirestoreProjectOwnership({
      authenticatedUid: ownerCheck.ownerId,
      isAuthenticatedCloud: ownerCheck.isAuthenticatedCloud,
      projectId,
      claimedOwnerId: req.body?.ownerId,
    });
    if (!projectOwnership.ok) {
      res
        .status(projectOwnership.statusCode)
        .json({ error: projectOwnership.error });
      return;
    }

    try {
      const result = await listApprovalAuditsOnServer(
        { projectId },
        { verifiedOwnerId: ownerCheck.ownerId }
      );
      res.status(200).json(result);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : '감사 이력 조회 중 오류가 발생했습니다.';
      const statusCode =
        msg.includes('AUTH_REQUIRED') || msg.includes('미인증')
          ? 401
          : msg.includes('TENANT_ISOLATION') ||
            msg.includes('OWNERSHIP_MISMATCH') ||
            msg.includes('권한')
          ? 403
          : msg.includes('NOT_FOUND')
          ? 404
          : msg.includes('BAD_REQUEST')
          ? 400
          : 500;
      res.status(statusCode).json({ error: msg });
    }
  });

  app.post('/api/ai/change-proposals/sync-rag', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req, true);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const projectId =
      typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    if (!projectId) {
      res.status(400).json({
        error:
          '[BAD_REQUEST] 승인된 설정의 RAG 동기화에는 projectId가 필요합니다.',
      });
      return;
    }

    const projectOwnership = await verifyAdminFirestoreProjectOwnership({
      authenticatedUid: ownerCheck.ownerId,
      isAuthenticatedCloud: ownerCheck.isAuthenticatedCloud,
      projectId,
      claimedOwnerId: req.body?.ownerId,
    });
    if (!projectOwnership.ok) {
      res
        .status(projectOwnership.statusCode)
        .json({ error: projectOwnership.error });
      return;
    }

    try {
      assertNoClientTestEmbeddingModeInjection({
        body: req.body as Record<string, unknown>,
      });
      const syncRequest: RagSyncExecutionRequest = {
        projectId,
        proposalId:
          typeof req.body?.proposalId === 'string'
            ? req.body.proposalId.trim()
            : undefined,
        auditId:
          typeof req.body?.auditId === 'string'
            ? req.body.auditId.trim()
            : undefined,
        forceRetry: Boolean(req.body?.forceRetry),
        manualRetry: Boolean(req.body?.manualRetry),
      };
      const result = await executeRagSyncForApprovedProposalOnServer(
        syncRequest,
        {
          verifiedOwnerId: ownerCheck.ownerId,
        }
      );
      res.status(200).json(result);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : '승인 설정 RAG 동기화 중 오류가 발생했습니다.';
      res.status(resolveRagErrorStatusCode(msg)).json({ error: msg });
    }
  });

  // ==========================================================================
  // Phase 3: Persistent Long-Term Memory & Hybrid RAG Engine Endpoints
  // ==========================================================================

  // 1. RAG Index Status & Health Check
  app.post('/api/rag/status', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    if (!projectId) {
      res.status(400).json({ error: 'projectId가 필요합니다.' });
      return;
    }

    const projectOwnership = await verifyAdminFirestoreProjectOwnership({
      authenticatedUid: ownerCheck.ownerId,
      isAuthenticatedCloud: ownerCheck.isAuthenticatedCloud,
      projectId,
      claimedOwnerId: req.body?.ownerId,
    });
    if (!projectOwnership.ok) {
      res.status(projectOwnership.statusCode).json({ error: projectOwnership.error });
      return;
    }

    try {
      const status = getProjectRagStatusOnServer({
        ownerId: ownerCheck.ownerId,
        projectId,
      });
      res.status(200).json(status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'RAG 색인 상태 조회 실패';
      res.status(resolveRagErrorStatusCode(msg)).json({ error: msg });
    }
  });

  // 2. Bulk Indexing Scale & Cost Estimate (Required before full rebuild / bulk sync)
  app.post('/api/rag/estimate', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const project = req.body?.project as Project | undefined;
    if (!project || !project.id) {
      res.status(400).json({ error: '작품(project) 정보가 필요합니다.' });
      return;
    }

    const projectOwnership = await verifyAdminFirestoreProjectOwnership({
      authenticatedUid: ownerCheck.ownerId,
      isAuthenticatedCloud: ownerCheck.isAuthenticatedCloud,
      projectId: project.id,
      claimedOwnerId: req.body?.ownerId,
      projectPayloadOwnerId: project.ownerId,
    });
    if (!projectOwnership.ok) {
      res.status(projectOwnership.statusCode).json({ error: projectOwnership.error });
      return;
    }

    try {
      const inputs = extractProjectMemoryIndexInputs({
        ownerId: ownerCheck.ownerId,
        project,
        characters: (req.body?.characters as Character[]) || [],
        worldbuilding: (req.body?.worldbuilding as WorldbuildingItem[]) || [],
        episodes: (req.body?.episodes as Episode[]) || [],
        timelineEvents: (req.body?.timelineEvents as TimelineEvent[]) || [],
        foreshadowings: (req.body?.foreshadowings as Foreshadowing[]) || [],
        relationships: (req.body?.relationships as CharacterRelationship[]) || [],
        includeDrafts: Boolean(req.body?.includeDrafts),
      });
      const estimate = estimateIndexingScaleAndCost(inputs);
      res.status(200).json({
        projectId: project.id,
        ownerId: ownerCheck.ownerId,
        estimate,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '색인 규모 및 비용 산정 실패';
      res.status(resolveRagErrorStatusCode(msg)).json({ error: msg });
    }
  });

  // 3. Single Entity Index / Re-index (Episode save, Revision restore, Character/Worldbuilding save)
  app.post('/api/rag/index-entity', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const rawInput = req.body?.input as MemoryIndexInput | undefined;
    if (!rawInput || !rawInput.projectId || !rawInput.sourceEntityId) {
      res.status(400).json({ error: '색인할 항목(input) 정보가 올바르지 않습니다.' });
      return;
    }

    const projectOwnership = await verifyAdminFirestoreProjectOwnership({
      authenticatedUid: ownerCheck.ownerId,
      isAuthenticatedCloud: ownerCheck.isAuthenticatedCloud,
      projectId: rawInput.projectId,
      claimedOwnerId: rawInput.ownerId ?? req.body?.ownerId,
    });
    if (!projectOwnership.ok) {
      res.status(projectOwnership.statusCode).json({ error: projectOwnership.error });
      return;
    }

    try {
      assertNoClientTestEmbeddingModeInjection({
        input: rawInput,
        body: req.body as Record<string, unknown>,
      });
      const result = await indexMemoryInputOnServer({
        ...rawInput,
        ownerId: ownerCheck.ownerId,
      });
      res.status(200).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '단일 항목 색인 실패';
      res.status(resolveRagErrorStatusCode(msg)).json({ error: msg });
    }
  });

  // 4. Incremental Project Sync (Skips unchanged hashes, re-indexes edited/restored items, purges deleted items)
  app.post('/api/rag/sync-project', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const project = req.body?.project as Project | undefined;
    if (!project || !project.id) {
      res.status(400).json({ error: '동기화할 작품(project) 정보가 필요합니다.' });
      return;
    }

    const projectOwnership = await verifyAdminFirestoreProjectOwnership({
      authenticatedUid: ownerCheck.ownerId,
      isAuthenticatedCloud: ownerCheck.isAuthenticatedCloud,
      projectId: project.id,
      claimedOwnerId: req.body?.ownerId,
      projectPayloadOwnerId: project.ownerId,
    });
    if (!projectOwnership.ok) {
      res.status(projectOwnership.statusCode).json({ error: projectOwnership.error });
      return;
    }

    try {
      const summary = await syncOrRebuildProjectIndexOnServer({
        ownerId: ownerCheck.ownerId,
        project,
        characters: (req.body?.characters as Character[]) || [],
        worldbuilding: (req.body?.worldbuilding as WorldbuildingItem[]) || [],
        episodes: (req.body?.episodes as Episode[]) || [],
        timelineEvents: (req.body?.timelineEvents as TimelineEvent[]) || [],
        foreshadowings: (req.body?.foreshadowings as Foreshadowing[]) || [],
        relationships: (req.body?.relationships as CharacterRelationship[]) || [],
        includeDrafts: Boolean(req.body?.includeDrafts),
        forceRebuild: false,
      });
      res.status(200).json(summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '작품 색인 동기화 실패';
      res.status(resolveRagErrorStatusCode(msg)).json({ error: msg });
    }
  });

  // 5. Full Project Index Rebuild (Requires explicit author confirmation for bulk operations)
  app.post('/api/rag/rebuild-project', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const project = req.body?.project as Project | undefined;
    const authorConfirmedBulk = Boolean(req.body?.authorConfirmedBulk);
    if (!project || !project.id) {
      res.status(400).json({ error: '재구축할 작품(project) 정보가 필요합니다.' });
      return;
    }

    const projectOwnership = await verifyAdminFirestoreProjectOwnership({
      authenticatedUid: ownerCheck.ownerId,
      isAuthenticatedCloud: ownerCheck.isAuthenticatedCloud,
      projectId: project.id,
      claimedOwnerId: req.body?.ownerId,
      projectPayloadOwnerId: project.ownerId,
    });
    if (!projectOwnership.ok) {
      res.status(projectOwnership.statusCode).json({ error: projectOwnership.error });
      return;
    }

    const inputs = extractProjectMemoryIndexInputs({
      ownerId: ownerCheck.ownerId,
      project,
      characters: (req.body?.characters as Character[]) || [],
      worldbuilding: (req.body?.worldbuilding as WorldbuildingItem[]) || [],
      episodes: (req.body?.episodes as Episode[]) || [],
      timelineEvents: (req.body?.timelineEvents as TimelineEvent[]) || [],
      foreshadowings: (req.body?.foreshadowings as Foreshadowing[]) || [],
      relationships: (req.body?.relationships as CharacterRelationship[]) || [],
      includeDrafts: Boolean(req.body?.includeDrafts),
    });
    const estimate = estimateIndexingScaleAndCost(inputs);

    if (estimate.requiresAuthorConfirmation && !authorConfirmedBulk) {
      res.status(400).json({
        requiresConfirmation: true,
        estimate,
        error:
          '대량 색인 재구축 작업입니다. 작업 규모와 예상 비용을 확인한 뒤 승인(authorConfirmedBulk: true)해 주세요.',
      });
      return;
    }

    try {
      const summary = await syncOrRebuildProjectIndexOnServer({
        ownerId: ownerCheck.ownerId,
        project,
        characters: (req.body?.characters as Character[]) || [],
        worldbuilding: (req.body?.worldbuilding as WorldbuildingItem[]) || [],
        episodes: (req.body?.episodes as Episode[]) || [],
        timelineEvents: (req.body?.timelineEvents as TimelineEvent[]) || [],
        foreshadowings: (req.body?.foreshadowings as Foreshadowing[]) || [],
        relationships: (req.body?.relationships as CharacterRelationship[]) || [],
        includeDrafts: Boolean(req.body?.includeDrafts),
        forceRebuild: true,
        authorConfirmedBulk: true,
      });
      res.status(200).json(summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '전체 색인 재구축 실패';
      res.status(resolveRagErrorStatusCode(msg)).json({ error: msg });
    }
  });

  // 6. Retry Failed or Stale Indices
  app.post('/api/rag/retry-failed', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const project = req.body?.project as Project | undefined;
    if (!project || !project.id) {
      res.status(400).json({ error: '작품(project) 정보가 필요합니다.' });
      return;
    }

    const projectOwnership = await verifyAdminFirestoreProjectOwnership({
      authenticatedUid: ownerCheck.ownerId,
      isAuthenticatedCloud: ownerCheck.isAuthenticatedCloud,
      projectId: project.id,
      claimedOwnerId: req.body?.ownerId,
      projectPayloadOwnerId: project.ownerId,
    });
    if (!projectOwnership.ok) {
      res.status(projectOwnership.statusCode).json({ error: projectOwnership.error });
      return;
    }

    try {
      const result = await retryFailedProjectIndicesOnServer({
        ownerId: ownerCheck.ownerId,
        project,
        characters: (req.body?.characters as Character[]) || [],
        worldbuilding: (req.body?.worldbuilding as WorldbuildingItem[]) || [],
        episodes: (req.body?.episodes as Episode[]) || [],
        timelineEvents: (req.body?.timelineEvents as TimelineEvent[]) || [],
        foreshadowings: (req.body?.foreshadowings as Foreshadowing[]) || [],
      });
      res.status(200).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '실패한 색인 재시도 중 오류 발생';
      res.status(resolveRagErrorStatusCode(msg)).json({ error: msg });
    }
  });

  // 7. Delete Entity Index (Triggered when an Episode, Character, or Worldbuilding item is deleted)
  app.post('/api/rag/delete-entity', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const sourceEntityId =
      typeof req.body?.sourceEntityId === 'string' ? req.body.sourceEntityId.trim() : '';
    const isEpisodeDelete = Boolean(req.body?.isEpisodeDelete);

    if (!projectId || !sourceEntityId) {
      res.status(400).json({ error: 'projectId 및 sourceEntityId가 필요합니다.' });
      return;
    }

    const projectOwnership = await verifyAdminFirestoreProjectOwnership({
      authenticatedUid: ownerCheck.ownerId,
      isAuthenticatedCloud: ownerCheck.isAuthenticatedCloud,
      projectId,
      claimedOwnerId: req.body?.ownerId,
    });
    if (!projectOwnership.ok) {
      res.status(projectOwnership.statusCode).json({ error: projectOwnership.error });
      return;
    }

    try {
      const result = await deleteEntityIndexOnServer({
        ownerId: ownerCheck.ownerId,
        projectId,
        sourceEntityId,
        isEpisodeDelete,
      });
      res.status(200).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '항목 색인 삭제 실패';
      res.status(resolveRagErrorStatusCode(msg)).json({ error: msg });
    }
  });

  // 8. Delete Entire Project Index (Triggered when a Project is deleted)
  app.post('/api/rag/delete-project', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    if (!projectId) {
      res.status(400).json({ error: 'projectId가 필요합니다.' });
      return;
    }

    const projectOwnership = await verifyAdminFirestoreProjectOwnership({
      authenticatedUid: ownerCheck.ownerId,
      isAuthenticatedCloud: ownerCheck.isAuthenticatedCloud,
      projectId,
      claimedOwnerId: req.body?.ownerId,
    });
    if (!projectOwnership.ok) {
      res.status(projectOwnership.statusCode).json({ error: projectOwnership.error });
      return;
    }

    try {
      const result = await deleteProjectIndexOnServer({
        ownerId: ownerCheck.ownerId,
        projectId,
      });
      res.status(200).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '작품 전체 색인 삭제 실패';
      res.status(resolveRagErrorStatusCode(msg)).json({ error: msg });
    }
  });

  // 9. Hybrid Memory Search (Keyword + Vector Cosine + Filter + RRF + Provenance Verification)
  app.post('/api/rag/search', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const rawQuery = req.body?.query as Partial<MemorySearchQuery> | undefined;
    if (!rawQuery || !rawQuery.projectId || typeof rawQuery.queryText !== 'string') {
      res.status(400).json({ error: '검색 질의(query.projectId, query.queryText)가 필요합니다.' });
      return;
    }

    // Security check: Direct Admin SDK Project Ownership Verification (Section 13-1)
    const projectOwnership = await verifyAdminFirestoreProjectOwnership({
      authenticatedUid: ownerCheck.ownerId,
      isAuthenticatedCloud: ownerCheck.isAuthenticatedCloud,
      projectId: rawQuery.projectId,
      claimedOwnerId: rawQuery.ownerId ?? req.body?.ownerId,
    });
    if (!projectOwnership.ok) {
      res.status(projectOwnership.statusCode).json({
        error: projectOwnership.error,
      });
      return;
    }

    try {
      assertNoClientTestEmbeddingModeInjection({
        query: rawQuery,
        body: req.body as Record<string, unknown>,
      });
      const searchResult = await searchProjectMemoryOnServer({
        ownerId: ownerCheck.ownerId,
        query: {
          ...rawQuery,
          ownerId: ownerCheck.ownerId,
          projectId: rawQuery.projectId,
          queryText: rawQuery.queryText,
        },
        liveSnapshots: req.body?.liveSnapshots,
      });
      res.status(200).json(searchResult);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '장기 기억 검색 중 오류가 발생했습니다.';
      res.status(resolveRagErrorStatusCode(msg)).json({ error: msg });
    }
  });

  // 10. Source Document & Chunk Provenance Lookup
  app.post('/api/rag/source', async (req, res) => {
    const ownerCheck = await resolveRequestOwner(req);
    if (!ownerCheck.ok) {
      res.status(ownerCheck.statusCode).json({ error: ownerCheck.error });
      return;
    }

    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const documentOrChunkId =
      typeof req.body?.documentOrChunkId === 'string'
        ? req.body.documentOrChunkId.trim()
        : '';

    if (!projectId || !documentOrChunkId) {
      res.status(400).json({ error: 'projectId 및 documentOrChunkId가 필요합니다.' });
      return;
    }

    const projectOwnership = await verifyAdminFirestoreProjectOwnership({
      authenticatedUid: ownerCheck.ownerId,
      isAuthenticatedCloud: ownerCheck.isAuthenticatedCloud,
      projectId,
      claimedOwnerId: req.body?.ownerId,
    });
    if (!projectOwnership.ok) {
      res.status(projectOwnership.statusCode).json({ error: projectOwnership.error });
      return;
    }

    try {
      const source = await getMemorySourceOnServer({
        ownerId: ownerCheck.ownerId,
        projectId,
        documentOrChunkId,
      });
      if (!source) {
        res.status(404).json({ error: '해당 출처 문서 또는 청크를 찾을 수 없습니다.' });
        return;
      }
      res.status(200).json(source);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '출처 문서 조회 실패';
      res.status(resolveRagErrorStatusCode(msg, 403)).json({ error: msg });
    }
  });

  return app;
}
