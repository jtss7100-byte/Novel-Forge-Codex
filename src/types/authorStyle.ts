import type { NarrativePerspective, StyleProfile } from './foundation';
import type { PromptProfile, TokenUsageMetadata } from './aiEngine';

// ============================================================================
// NOVEL FORGE — PHASE 4.3C STAGE 1
// Author Style DNA Types · S1–S10 Korean Web-Novel Style Dimensions
// ============================================================================

export type StyleDimensionId =
  | 'S1'
  | 'S2'
  | 'S3'
  | 'S4'
  | 'S5'
  | 'S6'
  | 'S7'
  | 'S8'
  | 'S9'
  | 'S10';

export const STYLE_DIMENSION_ORDER: StyleDimensionId[] = [
  'S1',
  'S2',
  'S3',
  'S4',
  'S5',
  'S6',
  'S7',
  'S8',
  'S9',
  'S10',
];

export type StyleConfidenceLevel =
  | 'HIGH'
  | 'MEDIUM'
  | 'LOW'
  | 'INSUFFICIENT_EVIDENCE';

export type StyleAnalysisStatus =
  | 'DRAFT_ANALYSIS'
  | 'READY_FOR_REVIEW'
  | 'INSUFFICIENT_EVIDENCE'
  | 'FAILED';

export type StyleApplicationStatus =
  | 'ACTIVE'
  | 'INACTIVE'
  | 'DRAFT'
  | 'STALE_SOURCE';

export type StyleScopeType = 'PROJECT';

export type StyleInputMode = 'AUTHOR_SUPPLIED_SAMPLE' | 'SAVED_REVISION';

export type StyleMeasurementMethod =
  | 'DETERMINISTIC'
  | 'INFERRED'
  | 'INSUFFICIENT_EVIDENCE';

export interface StyleDimensionMeta {
  id: StyleDimensionId;
  titleKo: string;
  shortLabelKo: string;
  descriptionKo: string;
  hierarchyGuardKo: string;
}

export interface StyleSourceReference {
  mode: StyleInputMode;
  projectId: string;
  episodeId?: string;
  revisionId?: string;
  sourceTitle?: string;
  contentHash: string;
  charCountWithSpaces: number;
  charCountWithoutSpaces: number;
  selectedRange?: {
    startOffset: number;
    endOffset: number;
  };
  sampledAt: string;
}

export interface StyleEvidenceRef {
  excerpt: string;
  startOffset: number;
  endOffset: number;
  verifiedInSource: boolean;
}

export interface StyleDimensionFinding {
  dimensionId: StyleDimensionId;
  titleKo: string;
  shortLabelKo: string;
  deterministicSignalSummary: string;
  observedTrait: string;
  suggestedWritingRule: string;
  confidence: StyleConfidenceLevel;
  measurementMethod: StyleMeasurementMethod;
  evidenceReferences: StyleEvidenceRef[];
}

export interface DeterministicStyleMetrics {
  charCountWithSpaces: number;
  charCountWithoutSpaces: number;
  paragraphCount: number;
  sentenceCount: number;
  avgSentenceLengthChars: number;
  minSentenceLengthChars: number;
  maxSentenceLengthChars: number;
  sentenceLengthStdDev: number;
  shortSentenceRatio: number; // <= 20 chars (0..1)
  mediumSentenceRatio: number; // 21..55 chars (0..1)
  longSentenceRatio: number; // > 55 chars (0..1)
  shortLongAlternationRatio: number; // 0..1
  avgSentencesPerParagraph: number;
  paragraphSentenceVariance: number;
  singleSentenceParagraphRatio: number; // 0..1
  blankLineBreakRate: number; // 0..1
  dialogueCount: number;
  dialogueRatioPercent: number; // 0..100 integer clamped for StyleProfile
  avgDialogueLengthChars: number;
  shortDialogueRatio: number; // <= 18 chars (0..1)
  silenceOrActionBeatCueCount: number;
  sensoryCategoryCounts: {
    visual: number;
    auditory: number;
    tactile: number;
    olfactory: number;
    temperature: number;
    total: number;
  };
  narrativeEndingVarietyCount: number;
  dominantEndingSuffix: string;
  dominantEndingRatio: number; // 0..1
  transitionCueDensityPerTenSentences: number;
  observedPerspectiveHints: {
    firstPersonCueCount: number;
    thirdPersonCueCount: number;
    suggestedObservedTendency: NarrativePerspective | 'MIXED_OR_UNCERTAIN';
    multiPovDistributionNote: string;
  };
  hasCriticalInsufficientSample: boolean;
  hasLowEvidenceWarning: boolean;
  hasDialogueSample: boolean;
  sanitizedInjectionMarkersCount: number;
}

export interface AuthorStyleAnalysisCandidate {
  candidateId: string;
  projectId: string;
  analysisStatus: StyleAnalysisStatus;
  applicationStatus: 'DRAFT';
  requiresAuthorApproval: true;
  autoApplied: false;
  scope: StyleScopeType;
  sourceReference: StyleSourceReference;
  metrics: DeterministicStyleMetrics;
  suggestedProfileTitle: string;
  overallSummary: string;
  toneKeywords: string[];
  preferredExpressions: string[];
  prohibitedExpressions: string[];
  observedPerspectiveTendency: NarrativePerspective | 'MIXED_OR_UNCERTAIN';
  sampleExcerptPreview: string;
  findings: StyleDimensionFinding[];
  warnings: string[];
  geminiExecuted: boolean;
  executionMode: 'GEMINI_AND_DETERMINISTIC' | 'DETERMINISTIC_ONLY';
  modelId: string;
  usageMetadata: TokenUsageMetadata;
  analyzedAt: string;
}

export interface StyleAnalysisRequest {
  ownerId?: string;
  projectId: string;
  inputMode: StyleInputMode;
  sampleText?: string;
  sampleLabel?: string;
  episodeId?: string;
  revisionId?: string;
  expectedContentHash?: string;
  selectedRange?: {
    startOffset: number;
    endOffset: number;
  };
  useGeminiStage2?: boolean;
  allowDeterministicFallbackWithoutApiKey?: boolean;
}

export interface AuthorSelectedStyleInstruction {
  id: string;
  dimensionId: StyleDimensionId | 'CUSTOM';
  text: string;
  enabled: boolean;
  editedByAuthor: boolean;
}

export type StyleApprovalPersistenceStatus =
  | 'COMMITTED'
  | 'VERSION_CONFLICT'
  | 'VALIDATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'NETWORK_FAILED'
  | 'NOT_COMMITTED';

export type PromptProfileCasErrorCode =
  | 'COMMITTED'
  | 'VERSION_CONFLICT'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'TENANT_ISOLATION'
  | 'NETWORK_FAILED';

export interface StyleApprovalConflictDetails {
  expectedVersionId?: string;
  actualVersionId?: string;
  expectedVersionNumber?: number;
  actualVersionNumber?: number;
  remotePromptProfile?: PromptProfile;
  reasonKo?: string;
}

export interface PromptProfileCasResult {
  committed: boolean;
  status: PromptProfileCasErrorCode;
  storageMode: 'CLOUD_FIRESTORE' | 'LOCAL_STORE';
  profile: PromptProfile;
  remoteProfile?: PromptProfile;
  errorMessage?: string;
  conflictDetails?: StyleApprovalConflictDetails;
}

export interface StyleApprovalPayload {
  ownerId: string;
  projectId: string;
  candidate: AuthorStyleAnalysisCandidate;
  profileTitle: string;
  profileDescription?: string;
  selectedInstructions: AuthorSelectedStyleInstruction[];
  toneKeywords?: string[];
  preferredExpressions?: string[];
  prohibitedExpressions?: string[];
  existingStyleProfileId?: string;
  targetPromptProfileId?: string;
  expectedBaseVersionId?: string;
  expectedBaseVersionNumber?: number;
  createNewProfileInsteadOfOverwrite?: boolean;
  allowAutoBranchOnConflict?: boolean;
  idempotencyKey?: string;
  activateOnApprove: boolean;
  versionLabel?: string;
}

export interface StyleBaseVersionConflictCheck {
  hasConflict: boolean;
  expectedVersionId?: string;
  actualVersionId?: string;
  expectedVersionNumber?: number;
  actualVersionNumber?: number;
  recommendedAction: 'PROCEED' | 'CREATE_NEW_BRANCH_OR_REFRESH';
  messageKo?: string;
}

export interface StyleProfileApplicationResult {
  approved: boolean;
  persistenceStatus: StyleApprovalPersistenceStatus;
  storageMode?: 'CLOUD_FIRESTORE' | 'LOCAL_STORE';
  styleProfile: StyleProfile;
  promptProfile: PromptProfile;
  applicationStatus: StyleApplicationStatus;
  styleProfileSaved: boolean;
  promptProfileSaved: boolean;
  partialFailureWarning?: string;
  errorMessage?: string;
  conflictDetails?: StyleApprovalConflictDetails;
  deduplicated?: boolean;
  createdNewProfile: boolean;
  sourceHash: string;
  baseVersionConflictResolvedByNewProfile: boolean;
}

export interface StylePromptSelectionSyncInput {
  projectId: string;
  previousProjectId: string | null;
  promptProfiles: PromptProfile[];
  previousSelectedIds: string[];
  previousKnownIds: string[];
  hasExplicitEmptySelection: boolean;
  explicitDeselectedIds: string[];
}

export interface StylePromptSelectionSyncResult {
  projectId: string;
  selectedIds: string[];
  knownIds: string[];
  hasExplicitEmptySelection: boolean;
  explicitDeselectedIds: string[];
  effectiveActiveProfiles: PromptProfile[];
}

export interface StyleApprovalUiTransitionState {
  showSuccessBanner: boolean;
  showConflictPanel: boolean;
  showErrorBanner: boolean;
  statusMessage: string;
  committedStyleProfiles: StyleProfile[];
  committedPromptProfiles: PromptProfile[];
  preservedDraftTitle: string;
  preservedDraftInstructions: AuthorSelectedStyleInstruction[];
  preservedTargetPromptProfileId: string;
  activatedInWriter: boolean;
}

export interface StyleSourceStalenessStatus {
  isStale: boolean;
  approvedSourceHash: string | null;
  currentSourceHash: string | null;
  sourceRevisionId: string | null;
  reasonKo?: string;
}

export interface StyleConsistencyEvaluationSummary {
  baselineRubricWarningsCount: number;
  styledRubricWarningsCount: number;
  adheresToStyleRules: boolean;
  preservesMasterWritingRules: boolean;
  preservesDynamicPov: boolean;
  preservesCharacterVoices: boolean;
  honestExecutionNote: string;
  liveGeminiStyleEvaluationStatus: 'NOT_EXECUTED' | 'EXECUTED';
  humanBlindReviewStatus: 'NOT_EXECUTED';
  realQualityImprovementStatus: 'NOT_VERIFIED';
}

export interface StyleBenchmarkScenario {
  id:
    | 'ST1'
    | 'ST2'
    | 'ST3'
    | 'ST4'
    | 'ST5'
    | 'ST6'
    | 'ST7'
    | 'ST8'
    | 'ST9'
    | 'ST10'
    | 'ST11'
    | 'ST12';
  titleKo: string;
  sampleText: string;
  expectedRuleCountMin: number;
  expectedExpectations: string[];
}
