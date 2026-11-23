import type { ContinuityFinding } from './styleContinuity';

export type AuthorContinuityDecision = 'INTENDED_VARIATION' | 'REVIEW_REQUIRED';
export type ContinuityDecisionDimension = ContinuityFinding['dimension'];

export interface VoiceDecisionScope {
  ownerId: string;
  projectId: string;
  characterId: string;
}

export interface VoiceContinuityIdentity extends VoiceDecisionScope {
  id: string;
  beforeEpisodeId: string;
  beforeRevisionId: string;
  beforeContentHash: string;
  afterEpisodeId: string;
  afterRevisionId: string;
  afterContentHash: string;
  dimension: ContinuityDecisionDimension;
  analysisVersion: string;
  analysisFingerprint: string;
}

export interface VoiceContinuityDecisionRecord extends VoiceContinuityIdentity {
  decision: AuthorContinuityDecision;
  authorNote: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceDecisionCommand {
  decisionId: string;
  dimension: ContinuityDecisionDimension;
  operationId: string;
  expectedVersion: number;
  decision: AuthorContinuityDecision;
  authorNote: string;
  reconfirmLegacy?: boolean;
}

export interface VoiceDecisionAudit extends VoiceDecisionScope {
  id: string;
  decisionId: string;
  analysisFingerprint: string;
  requestFingerprint: string;
  previousDecision: AuthorContinuityDecision | null;
  previousNote: string;
  reconfirmLegacy: boolean;
  record: VoiceContinuityDecisionRecord;
}

export interface VoiceDecisionSaveResult {
  status: 'COMMITTED' | 'ALREADY_APPLIED';
  record: VoiceContinuityDecisionRecord;
}

export type VoiceDecisionErrorCode = 'VERSION_CONFLICT' | 'OPERATION_CONFLICT' | 'STALE_SOURCE' | 'INVALID_DECISION';

export interface VoiceDecisionPage {
  records: VoiceContinuityDecisionRecord[];
  next?: string;
}

export interface VoiceDecisionAuditPage {
  entries: VoiceDecisionAudit[];
  next?: string;
}
