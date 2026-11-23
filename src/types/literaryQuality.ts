import type { NarrativePerspective } from './foundation';
import type { TokenUsageMetadata } from './aiEngine';

/**
 * 8 Literary Quality Dimensions (Phase 4.3A)
 */
export type LiteraryQualityDimensionId =
  | 'Q1'
  | 'Q2'
  | 'Q3'
  | 'Q4'
  | 'Q5'
  | 'Q6'
  | 'Q7'
  | 'Q8';

export type LiteraryQualityConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type LiteraryQualitySeverity = 'INFO' | 'SUGGESTION' | 'IMPORTANT';
export type LiteraryQualityDecision = 'PENDING' | 'ACCEPTED' | 'REJECTED';
export type LiteraryQualityExecutionStatus =
  | 'NOT_RUN'
  | 'COMPLETED'
  | 'FAILED'
  | 'QUALITY_EVALUATION_FAILED';

export interface LiteraryQualityDimensionMeta {
  id: LiteraryQualityDimensionId;
  titleKo: string;
  shortLabelKo: string;
  descriptionKo: string;
  falsePositiveGuardKo: string;
}

export interface LiteraryQualityDimension {
  category: LiteraryQualityDimensionId;
  label: string;
  score: number | null;
  confidence: LiteraryQualityConfidence;
  explanation: string;
}

export interface LiteraryQualityFinding {
  findingId: string;
  category: LiteraryQualityDimensionId;
  severity: LiteraryQualitySeverity;
  originalExcerpt: string;
  startOffset: number | null;
  endOffset: number | null;
  problem: string;
  reason: string;
  suggestedRevision: string | null;
  expectedBenefit: string;
  requiresAuthorApproval: true;
  decision: LiteraryQualityDecision;
  sourceModule: 'LITERARY_QUALITY' | 'STYLE_EDITOR_MERGED';
  mergedStyleIssueIds?: string[];
  canonRuleWarning?: string | null;
  offsetVerified: boolean;
  anchorRejectionReason?: string | null;
}

export interface LiteraryQualityUsageTelemetry {
  qualityApiCallCount: number;
  styleEditorApiCallCount: number;
  qualityUsageMetadata: TokenUsageMetadata;
  styleEditorUsageMetadata: TokenUsageMetadata;
  combinedUsageMetadata: TokenUsageMetadata;
}

export interface LiteraryQualityReport {
  reportId: string;
  projectId: string;
  episodeId: string;
  sourceRunId: string;
  sourceRevisionId: string;
  sourceContentHash: string;
  appliedPromptVersionIds: string[];
  appliedPerspective: NarrativePerspective;
  modelId: string;
  executionStatus: LiteraryQualityExecutionStatus;
  overallAssessment: string;
  dimensions: LiteraryQualityDimension[];
  findings: LiteraryQualityFinding[];
  rejectedFindingCount: number;
  rejectedFindingNotices: string[];
  usageTelemetry: LiteraryQualityUsageTelemetry;
  evaluatedAt: string;
  errorMessage?: string;
}

/**
 * Section 13 Extensible Hook: Reference-work structural style telemetry.
 * Strictly isolated per ownerId/projectId: measures rhythm/ratio only, never copies text or imports CANON.
 */
export interface StyleReferenceAnalysis {
  referenceId: string;
  ownerId: string;
  projectId: string;
  titleLabel: string;
  sentenceLengthDistribution: {
    shortRatio: number;
    mediumRatio: number;
    longRatio: number;
    averageLength: number;
  };
  dialogueToNarrationRatio: number;
  paragraphAverageSentences: number;
  sensoryDensityScore: number;
  structuralStyleNotes: string[];
  prohibitDirectCopying: true;
  prohibitCanonImport: true;
  createdAt: string;
}

export interface LiteraryQualityEvaluationRequest {
  ownerId?: string;
  projectId: string;
  episodeId: string;
  sourceRunId?: string;
  sourceRevisionId: string;
  manuscript: string;
  context: import('./aiEngine').WritingContextBundle;
  includeStyleEditorAudit?: boolean;
  styleReferences?: StyleReferenceAnalysis[];
  existingStyleIssues?: import('./aiEngine').WritingIssue[];
}

export interface LiteraryQualityEvaluationResponse {
  executionStatus: LiteraryQualityExecutionStatus;
  report: LiteraryQualityReport;
  mergedStyleIssuesCount: number;
  errorMessage?: string;
}
