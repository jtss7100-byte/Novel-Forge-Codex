/**
 * NOVEL FORGE — Phase 2: Professional AI Novel Writing Engine Types
 *
 * Defines data structures for:
 * A. Plot Planner (WritingPlan, ScenePlanItem)
 * B. Novel Writer (WritingRequestPayload, SceneDraftOutput, WritingResult)
 * C. Style Editor & D. Continuity Checker (WritingIssue, ContinuityIssueSeverity)
 * E. Memory Curator (MemoryCuratorReport)
 * F. Prompt Manager (PromptProfile, PromptVersion, PromptTemplateType)
 * G. Execution State & Audit Separation (ManuscriptExecutionState, IndependentAuditState, OneTimeExceptionRecord)
 * WritingContextBuilder (WritingContextBundle, ReferencedSource)
 */

import type {
  CanonStatus,
  ChangeProposal,
  NarrativePerspective,
} from './foundation';

export type PromptTemplateType =
  | 'CORE_WRITING_RULES'
  | 'PROJECT_STYLE_PROFILE'
  | 'CHARACTER_DIALOGUE_RULES'
  | 'SCENE_INSTRUCTIONS'
  | 'REVIEW_RULES';

export interface PromptVersion {
  versionId: string;
  versionNumber: number;
  content: string;
  label: string;
  createdAt: string;
}

export interface AppliedMasterRulesVersionInfo {
  profileId: string;
  title: string;
  versionId: string;
  versionNumber: number;
  versionLabel: string;
  targetModule: string;
  scope: string;
  usedAt: string;
}

export interface PromptProfile {
  id: string;
  ownerId: string;
  projectId: string; // 'GLOBAL' or specific projectId
  promptType: PromptTemplateType;
  title: string;
  description: string;
  targetCharacterId?: string;
  targetModule?: string;
  scope?: string;
  versionLabel?: string;
  content: string;
  isActive: boolean;
  currentVersionId: string;
  currentVersionNumber: number;
  lastUsedVersionId?: string;
  lastUsedVersionNumber?: number;
  lastUsedVersionLabel?: string;
  lastUsedAt?: string;
  versions: PromptVersion[];
  createdAt: string;
  updatedAt: string;
}

export type WritingMode =
  | 'FULL_EPISODE'
  | 'SINGLE_SCENE'
  | 'CONTINUE_MANUSCRIPT'
  | 'REWRITE_SELECTION';

export type ExpansionActionType =
  | 'EXPAND_SCENE'
  | 'BOOST_DIALOGUE'
  | 'BOOST_PSYCHOLOGY'
  | 'BOOST_ACTION';

/**
 * Schema-exact types for `novelforge_writer_response.schema.json` and `novelforge_app_result.schema.json`
 */
export type WriterManuscriptState =
  | 'BLOCKED_CONFLICT'
  | 'BLOCKED_MISSING_INFO'
  | 'DRAFT_READY';

export type AppManuscriptState =
  | 'BLOCKED_CONFLICT'
  | 'BLOCKED_MISSING_INFO'
  | 'DRAFT_READY'
  | 'REVIEW_REQUIRED'
  | 'APPROVED';

export type AppCanonStatus =
  | 'CANON_CANDIDATE'
  | 'NON_CANON_EXCEPTION'
  | 'CANON';

export type AppAuditStatus =
  | 'NOT_RUN'
  | 'PASSED'
  | 'ISSUES_FOUND'
  | 'AUDIT_FAILED';

export interface AppAuditExecutionState {
  continuity_checker: AppAuditStatus;
  style_editor: AppAuditStatus;
}

export type SchemaIssueSource =
  | 'WRITER'
  | 'CONTINUITY_CHECKER'
  | 'STYLE_EDITOR';

export type SchemaIssueSeverity = 'INFO' | 'WARNING' | 'CRITICAL_BLOCK';

export type SchemaProposalResolutionType =
  | 'ONE_TIME_EXCEPTION'
  | 'PERMANENT_LORE_UPDATE'
  | 'CANON_PROMOTION'
  | 'TEXT_REVISION';

export interface NovelForgeWriterIssue {
  severity: SchemaIssueSeverity;
  manuscript_location: string | null;
  reference_lore_id: string | null;
  description: string;
}

export interface NovelForgeWriterProposal {
  resolution_type: SchemaProposalResolutionType;
  target_location_or_lore_id: string | null;
  proposed_change: string;
  impact_analysis: string | null;
}

/**
 * Exact runtime contract for `novelforge_writer_response.schema.json`
 */
export interface NovelForgeWriterResponse {
  manuscript_state: WriterManuscriptState;
  manuscript: string;
  issues: NovelForgeWriterIssue[];
  proposals: NovelForgeWriterProposal[];
}

export interface NovelForgeAppIssue extends NovelForgeWriterIssue {
  issue_id: string;
  source: SchemaIssueSource;
}

export interface NovelForgeAppProposal extends NovelForgeWriterProposal {
  proposal_id: string;
}

/**
 * Exact runtime contract for `novelforge_app_result.schema.json`
 * Assembled and validated on the Node.js server (never trusted directly from AI).
 */
export interface NovelForgeAppResult {
  manuscript_state: AppManuscriptState;
  canon_status: AppCanonStatus;
  audit_execution_state: AppAuditExecutionState;
  manuscript: string;
  issues: NovelForgeAppIssue[];
  proposals: NovelForgeAppProposal[];
}

/**
 * Rule 10.1 — Manuscript Execution State (원고 집필 상태)
 * Distinct from individual independent audit execution states.
 */
export type ManuscriptExecutionState =
  | AppManuscriptState
  | 'AUDIT_FAILED'; // 독립 검수 실행 실패 또는 결과 검증 실패

/**
 * Rule 9.5 & Rule 10.1 — Independent Audit Execution Status (개별 독립 검수 실행 상태)
 * Never reported as PASSED/COMPLETED unless an actual separate audit run succeeded.
 */
export type AuditRunStatus =
  | AppAuditStatus
  | 'RUNNING';

export interface IndependentAuditState {
  continuityAuditStatus: AuditRunStatus;
  styleAuditStatus: AuditRunStatus;
  lastContinuityAuditAt?: string;
  lastStyleAuditAt?: string;
  auditErrorMessage?: string;
}

/**
 * Rule 1 & Rule 10.3 — Conflict Resolution & One-Time Exception vs Canon Promotion
 */
export type ConflictResolutionMode =
  | 'ONE_TIME_EXCEPTION' // 현재 생성 작업에만 예외 적용 (비정사 NON_CANON_EXCEPTION 초안으로 분류)
  | 'CANON_CHANGE_APPROVAL' // 변경 대상, 내용, 영향받는 기존 원고 확인 후 설정 변경 이력 기록
  | 'CANON_PROMOTION'; // 비정사 예외 초안을 정식 연재(CANON)로 편입 승인

export type ManuscriptCanonClassification =
  | 'STANDARD_DRAFT' // 기본 정사 범위 내 초안 (CANON_CANDIDATE)
  | 'CANON_CANDIDATE' // 정사 편입 후보 (novelforge_app_result.schema.json)
  | 'NON_CANON_EXCEPTION' // 일회성 예외 적용 비정사/대체 전개 초안
  | 'CANON_PROMOTED' // 작가의 별도 정사 편입 승인을 거친 원고
  | 'CANON'; // 정식 연재 확정본 (novelforge_app_result.schema.json)

export interface OneTimeExceptionRecord {
  id: string;
  targetLoreId: string;
  targetTitle: string;
  scope: 'CURRENT_RUN_ONLY';
  reason: string;
  affectedEpisodeIds: string[];
  resolutionMode: ConflictResolutionMode;
  approvedBy: 'AUTHOR';
  approvedAt: string;
}

export type EngineWorkflowState =
  | 'IDLE'
  | 'PLANNING'
  | 'AWAITING_PLAN_APPROVAL'
  | 'WRITING_SCENE'
  | 'BLOCKED_CONFLICT'
  | 'BLOCKED_MISSING_INFO'
  | 'DRAFT_READY'
  | 'REVIEWING'
  | 'REVIEW_REQUIRED'
  | 'AWAITING_REVISION_APPROVAL'
  | 'AUDIT_FAILED'
  | 'APPROVED'
  | 'ABORTED'
  | 'SAVING'
  | 'SAVED'
  | 'ERROR';

export interface ScenePlanItem {
  sceneNumber: number;
  title: string;
  purpose: string;
  characterIds: string[];
  characterNames: string[];
  emotionalArc: string;
  targetCharCount: number;
  connectionToNext: string;
  mustIncludeEvent: string;
  narrativePerspective?: NarrativePerspective;
  pointOfViewCharacterId?: string;
}

export interface WritingPlan {
  id: string;
  ownerId: string;
  projectId: string;
  episodeId: string;
  episodeTitle: string;
  episodeGoal: string;
  requiredEvents: string[];
  forbiddenDevelopments: string[];
  targetTotalCharCount: number;
  narrativePerspective: NarrativePerspective;
  scenes: ScenePlanItem[];
  plotDeviationWarnings: string[];
  appliedPromptVersionIds: string[];
  appliedMasterRulesVersion?: AppliedMasterRulesVersionInfo;
  referencedSourceIds: string[];
  modelId: string;
  status: 'DRAFT_PLAN' | 'APPROVED' | 'SUPERSEDED';
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ContinuityIssueSeverity =
  | 'CONFIRMED_CONFLICT'
  | 'POTENTIAL_CONFLICT'
  | 'INSUFFICIENT_DATA';

export interface WritingIssue {
  id: string;
  issue_id?: string;
  sourceModule: 'NOVEL_WRITER_SELF_CHECK' | 'STYLE_EDITOR' | 'CONTINUITY_CHECKER';
  source?: SchemaIssueSource;
  category: string;
  severity: ContinuityIssueSeverity;
  schemaSeverity?: SchemaIssueSeverity;
  description: string;
  manuscriptExcerpt: string;
  /** Rule 10.5 — 원고 내 위치 정보 (집필 전 보류이거나 위치를 확인할 수 없으면 null) */
  manuscriptLocation?: string | null;
  manuscript_location?: string | null;
  relatedCanonReference: string;
  /** Rule 10.5 — 확정 설정 출처 ID (미존재·무관할 경우 null) */
  referenceLoreId?: string | null;
  reference_lore_id?: string | null;
  suggestedFix: string;
  replacementText?: string;
  decision: 'PENDING' | 'ACCEPTED' | 'REJECTED';
}

export interface ReferencedSource {
  entityType:
    | 'PROJECT'
    | 'CHARACTER'
    | 'CHARACTER_STATE_CHANGE'
    | 'WORLDBUILDING'
    | 'EPISODE'
    | 'EPISODE_SUMMARY'
    | 'SCENE'
    | 'TIMELINE_EVENT'
    | 'FORESHADOWING'
    | 'STYLE_PROFILE'
    | 'PROMPT_PROFILE';
  entityId: string;
  title: string;
  canonStatus: CanonStatus;
  revisionId?: string;
}

/**
 * Phase 3: Verified RAG memory chunk actually injected into Novel Writer context
 * ("이번 집필에서 참조한 기억" — distinguished from general search hits).
 */
export interface RagRetrievedEvidenceItem {
  chunkId: string;
  documentId: string;
  projectId: string;
  sourceEntityType: string;
  sourceEntityId: string;
  sourceRevisionId: string;
  episodeId: string;
  sourceEpisodeId?: string;
  episodeNumber?: number;
  sceneId: string;
  sourceSceneId?: string;
  title: string;
  originalText: string;
  sourceStartOffset: number;
  sourceEndOffset: number;
  score: number;
  relevanceScore: number;
  keywordScore: number;
  semanticScore: number;
  matchedTerms: string[];
  canonStatus: CanonStatus;
  freshnessStatus: 'FRESH' | 'STALE' | 'SOURCE_UNVERIFIED';
  verifiedForWriting: boolean;
}

export interface TokenUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  estimatedCostUsd: number;
  isActualUsage: boolean;
}

export interface SceneDraftOutput {
  sceneId: string;
  sceneNumber: number;
  sceneTitle: string;
  content: string;
  actualCharCountWithSpaces: number;
  actualCharCountWithoutSpaces: number;
  targetCharCount: number;
  tolerancePercent: number;
  withinTolerance: boolean;
  endingStateSummary: string;
  duplicateEventWarning?: string;
}

export interface MemoryCuratorReport {
  episodeSummary: string;
  characterStateChanges: {
    characterId?: string;
    characterName: string;
    stateChange: string;
  }[];
  sceneKeyLogs: {
    sceneNumber: number;
    log: string;
  }[];
  candidateProposals: ChangeProposal[];
  foreshadowingNotes: string[];
}

/**
 * Mandatory WritingResult structure unified with `novelforge_app_result.schema.json`.
 * Separates pure novel manuscript text from review issues, proposals, execution state, and independent audit state.
 */
export interface WritingResult {
  runId: string;
  projectId: string;
  episodeId: string;
  sceneId: string;
  /** Rule 9.2 & 10.2 — Pure novel prose only; MUST be "" when executionState is BLOCKED_CONFLICT or BLOCKED_MISSING_INFO */
  manuscript: string;
  /** Rule 10.1 — Explicit manuscript execution state */
  executionState: ManuscriptExecutionState;
  /** Rule 9.5 & 10.1 — Separate independent audit execution tracking */
  auditState: IndependentAuditState;
  /** Rule 10.3 — Tracks whether this draft is CANON_CANDIDATE, NON_CANON_EXCEPTION, or CANON */
  canonClassification: ManuscriptCanonClassification;
  /** Strict `novelforge_app_result.schema.json` object validated on the Node.js server */
  appResult?: NovelForgeAppResult;
  appliedExceptions?: OneTimeExceptionRecord[];
  sceneOutputs?: SceneDraftOutput[];
  issues: WritingIssue[];
  proposals: ChangeProposal[];
  referencedSources: ReferencedSource[];
  /** Phase 3: Verified RAG memory chunks that were actually injected into Novel Writer prompt */
  referencedMemoryChunks?: RagRetrievedEvidenceItem[];
  appliedPromptVersionIds: string[];
  appliedMasterRulesVersion?: AppliedMasterRulesVersionInfo;
  modelId: string;
  usageMetadata: TokenUsageMetadata;
  status: 'COMPLETED' | 'PARTIAL' | 'BLOCKED' | 'ABORTED' | 'FAILED';
  errorMessage?: string;
  createdAt: string;
}

export interface RewriteSelectionAnchor {
  sourceRevisionId: string;
  sourceContentHash: string;
  startOffset: number;
  endOffset: number;
  originalExcerpt: string;
}

export interface WritingContextBundle {
  projectId: string;
  ownerId?: string;
  sceneCharacterIds?: string[];
  projectTitle: string;
  projectGenre: string;
  projectSynopsis: string;
  episodeId: string;
  episodeNumber: number;
  episodeTitle: string;
  writingMode: WritingMode;
  narrativePerspective: NarrativePerspective;
  /** Rule 1.2 — Dynamic POV inheritance hierarchy: scenePerspective -> episodePerspective -> projectDefaultPerspective */
  scenePerspective?: NarrativePerspective;
  episodePerspective?: NarrativePerspective;
  projectDefaultPerspective?: NarrativePerspective;
  pointOfViewCharacterId?: string;
  /** Rule 5 — Conditional Game Fantasy System Flag (only allow status windows/skills if worldbuilding actually has game system) */
  hasGameSystemInWorldbuilding?: boolean;
  targetEpisodeCharCount: number;
  targetSceneCharCount: number;
  tolerancePercent: number;
  plotOutline: string;
  requiredEvents: string[];
  forbiddenDevelopments: string[];
  canonCharacters: {
    id: string;
    name: string;
    role: string;
    affiliation: string;
    personality: string;
    abilities: string;
    appearance: string;
  }[];
  canonWorldbuilding: {
    id: string;
    title: string;
    category: string;
    summary: string;
    rules: string;
  }[];
  previousEpisodeSummary: string;
  previousEpisodeTailExcerpt: string;
  currentManuscript: string;
  selectedTextToRewrite?: string;
  rewriteSelectionAnchor?: RewriteSelectionAnchor;
  /** Rule 1 & 10.3 — Structured one-time conflict exception or canon change approval (never a raw override string) */
  approvedExceptions?: OneTimeExceptionRecord[];
  activePrompts: {
    profileId: string;
    promptType: PromptTemplateType;
    title: string;
    versionId: string;
    versionNumber?: number;
    versionLabel?: string;
    content: string;
    isActive?: boolean;
    projectId?: string;
    ownerId?: string;
    targetCharacterId?: string;
  }[];
  referencedSources: ReferencedSource[];
  /** Phase 3: Verified long-term RAG memory chunks retrieved for this writing session */
  retrievedMemoryChunks?: RagRetrievedEvidenceItem[];
  missingEvidenceNotes: string[];
}
