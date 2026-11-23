import type { StyleConfidenceLevel } from './authorStyle';

export type SpeakerAttributionStatus = 'AUTHOR_CONFIRMED' | 'EXPLICITLY_OBSERVED' | 'INFERRED' | 'AMBIGUOUS' | 'UNKNOWN';
export type VoiceDimensionId = 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' | 'V7' | 'V8' | 'V9' | 'V10';

export interface VoiceSourceReference {
  contentHash: string;
  episodeId?: string;
  revisionId?: string;
  latestRevisionId?: string;
}

export interface VoiceExcerpt {
  id: string;
  text: string;
  startOffset: number;
  endOffset: number;
  characterId?: string;
  attribution: SpeakerAttributionStatus;
}

export interface CharacterVoiceFinding {
  dimensionId: VoiceDimensionId;
  observedTrait: string;
  confidence: StyleConfidenceLevel;
  evidenceReferences: string[];
  suggestedRule: string | null;
}

export interface VoiceMetrics {
  count: number;
  averageLength: number;
  lengths: number[];
  endings: Record<string, number>;
  questions: number;
  commands: number;
  polite: number;
  informal: number;
  brief: number;
  pauses: number;
  repeatedWords: string[];
}

export interface CharacterVoiceAnalysisCandidate {
  candidateId: string;
  ownerId: string;
  projectId: string;
  characterId: string;
  status: 'DRAFT_ANALYSIS' | 'READY_FOR_REVIEW' | 'INSUFFICIENT_EVIDENCE' | 'FAILED';
  sourceReferences: VoiceSourceReference[];
  excerpts: VoiceExcerpt[];
  dimensions: CharacterVoiceFinding[];
  metrics: VoiceMetrics;
  suggestedInstructions: string[];
  warnings: string[];
  geminiExecuted: boolean;
  requiresAuthorApproval: true;
  autoApplied: false;
}
