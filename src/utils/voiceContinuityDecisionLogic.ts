import type { ContinuityFinding } from '../types/styleContinuity';
import type { VoiceContinuityDecisionRecord, VoiceContinuityIdentity, VoiceDecisionAudit, VoiceDecisionCommand, VoiceDecisionErrorCode, VoiceDecisionSaveResult, VoiceDecisionScope } from '../types/voiceContinuityDecision';
import { computeManuscriptContentHash } from './manuscriptIntegrity';

export const VOICE_CONTINUITY_ANALYSIS_VERSION = 'voice_continuity_1';
export const VOICE_DECISION_DIMENSIONS = ['SENTENCE', 'PARAGRAPH', 'DIALOGUE', 'PSYCHOLOGY', 'DISTANCE', 'POV', 'VOICE', 'TRANSITION'] as const;
export const VOICE_AUTHOR_DECISIONS = ['INTENDED_VARIATION', 'REVIEW_REQUIRED'] as const;
export const voiceDecisionIdPattern = /^vcd_[a-f0-9]{64}$/;
export const voiceOperationIdPattern = /^[a-zA-Z0-9_-]{16,128}$/;

export interface VerifiedContinuitySampleIdentity {
  episodeId: string;
  revisionId: string;
  contentHash: string;
  latestRevisionId?: string;
  episodeNumber: number;
  sceneKind: string;
  speakerFingerprint: string;
  relationshipFingerprint: string;
  characterIds: string[];
}

// Explicit positional arrays avoid object key-order dependence. String ordering uses
// code units, not locale. Exact Revision text is hashed separately as UTF-16.
const manifest = (source: VerifiedContinuitySampleIdentity) => [
  source.episodeId, source.revisionId, source.contentHash, source.latestRevisionId || '',
  source.episodeNumber, source.sceneKind, source.speakerFingerprint,
  source.relationshipFingerprint, [...new Set(source.characterIds)].sort(),
];
export const continuityEvidenceHash = (tuples: readonly (readonly (string | number | boolean)[])[]) =>
  computeManuscriptContentHash(JSON.stringify(tuples.map((entry) => JSON.stringify(entry)).sort()));

export function buildVoiceContinuityFingerprint(
  scope: VoiceDecisionScope, before: VerifiedContinuitySampleIdentity, after: VerifiedContinuitySampleIdentity,
  cohort: VerifiedContinuitySampleIdentity[], finding: Pick<ContinuityFinding, 'dimension' | 'status' | 'confidence' | 'description'>,
  analysisVersion = VOICE_CONTINUITY_ANALYSIS_VERSION
): VoiceContinuityIdentity {
  const analysisFingerprint = computeManuscriptContentHash(JSON.stringify([
    scope.ownerId, scope.projectId, scope.characterId, analysisVersion,
    manifest(before), manifest(after), cohort.map((sample) => JSON.stringify(manifest(sample))).sort(),
    finding.dimension, finding.status, finding.confidence, finding.description,
  ]));
  return {
    ...scope, analysisFingerprint, analysisVersion, id: `vcd_${analysisFingerprint.slice('sha256_'.length)}`,
    beforeEpisodeId: before.episodeId, beforeRevisionId: before.revisionId, beforeContentHash: before.contentHash,
    afterEpisodeId: after.episodeId, afterRevisionId: after.revisionId, afterContentHash: after.contentHash,
    dimension: finding.dimension,
  };
}

export function sameVoiceScope(one: VoiceDecisionScope, two: VoiceDecisionScope): boolean {
  return one.ownerId === two.ownerId && one.projectId === two.projectId && one.characterId === two.characterId;
}

export function matchesVoiceDecision(record: VoiceContinuityDecisionRecord, identity: VoiceContinuityIdentity): boolean {
  return sameVoiceScope(record, identity) && record.id === identity.id &&
    record.analysisFingerprint === identity.analysisFingerprint && record.analysisVersion === identity.analysisVersion &&
    record.beforeEpisodeId === identity.beforeEpisodeId && record.afterEpisodeId === identity.afterEpisodeId &&
    record.beforeRevisionId === identity.beforeRevisionId && record.afterRevisionId === identity.afterRevisionId &&
    record.beforeContentHash === identity.beforeContentHash && record.afterContentHash === identity.afterContentHash &&
    record.dimension === identity.dimension;
}

export function isReviewableContinuityFinding(status: ContinuityFinding['status']): boolean {
  return status === 'POTENTIAL_DRIFT' || status === 'INTENTIONAL_VARIATION';
}

export class VoiceDecisionError extends Error {
  constructor(public code: VoiceDecisionErrorCode) { super(code); }
}

export function normalizeDecisionCommand(command: VoiceDecisionCommand): VoiceDecisionCommand {
  const note = command.authorNote.trim().normalize('NFC').replace(/\r\n?/g, '\n');
  if (!voiceDecisionIdPattern.test(command.decisionId) || !voiceOperationIdPattern.test(command.operationId) ||
      !VOICE_DECISION_DIMENSIONS.includes(command.dimension) || !VOICE_AUTHOR_DECISIONS.includes(command.decision) ||
      !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0 || note.length > 1000) {
    throw new VoiceDecisionError('INVALID_DECISION');
  }
  return { ...command, authorNote: note };
}

export function voiceDecisionRequestFingerprint(scope: VoiceDecisionScope, command: VoiceDecisionCommand, contextFingerprint = ''): string {
  return computeManuscriptContentHash(JSON.stringify([
    scope.ownerId, scope.projectId, scope.characterId, command.decisionId, command.dimension,
    command.expectedVersion, command.decision, command.authorNote, command.reconfirmLegacy === true, contextFingerprint,
  ]));
}

export function replayVoiceDecision(
  scope: VoiceDecisionScope, command: VoiceDecisionCommand, receipt: VoiceDecisionAudit | null, contextFingerprint?: string
): VoiceDecisionSaveResult | null {
  if (!receipt) return null;
  if (!sameVoiceScope(scope, receipt) || receipt.id !== command.operationId ||
      receipt.requestFingerprint !== voiceDecisionRequestFingerprint(scope, command, contextFingerprint)) {
    throw new VoiceDecisionError('OPERATION_CONFLICT');
  }
  return { status: 'ALREADY_APPLIED', record: receipt.record };
}

export function prepareVoiceDecisionWrite(
  identity: VoiceContinuityIdentity, command: VoiceDecisionCommand, current: VoiceContinuityDecisionRecord | null, time: string,
  contextFingerprint?: string
): { result: VoiceDecisionSaveResult; audit: VoiceDecisionAudit } {
  if (identity.id !== command.decisionId || identity.dimension !== command.dimension) throw new VoiceDecisionError('STALE_SOURCE');
  if (current && !matchesVoiceDecision(current, identity)) throw new VoiceDecisionError('STALE_SOURCE');
  if ((current?.version ?? 0) !== command.expectedVersion) throw new VoiceDecisionError('VERSION_CONFLICT');
  const record: VoiceContinuityDecisionRecord = {
    ...identity, decision: command.decision, authorNote: command.authorNote,
    version: (current?.version ?? 0) + 1, createdAt: current?.createdAt ?? time, updatedAt: time,
  };
  return {
    result: { status: 'COMMITTED', record },
    audit: {
      id: command.operationId, ownerId: identity.ownerId, projectId: identity.projectId, characterId: identity.characterId,
      decisionId: identity.id, analysisFingerprint: identity.analysisFingerprint,
      requestFingerprint: voiceDecisionRequestFingerprint(identity, command, contextFingerprint), previousDecision: current?.decision ?? null,
      previousNote: current?.authorNote ?? '', reconfirmLegacy: command.reconfirmLegacy === true, record,
    },
  };
}

export type VoiceDecisionDraft = Omit<VoiceDecisionCommand, 'operationId'>;
export function selectVoiceDecisionOperation(
  draft: VoiceDecisionDraft, pending: VoiceDecisionCommand | undefined, createId: () => string
): VoiceDecisionCommand {
  // After an ambiguous failure, an unchanged draft keeps the operation even
  // if the displayed committed version advanced when the author refreshed.
  return pending?.decisionId === draft.decisionId && pending.dimension === draft.dimension &&
    pending.decision === draft.decision && pending.authorNote === draft.authorNote &&
    Boolean(pending.reconfirmLegacy) === Boolean(draft.reconfirmLegacy)
    ? pending : { ...draft, operationId: createId() };
}
