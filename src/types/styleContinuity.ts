import type { VoiceMetrics, VoiceSourceReference, VoiceExcerpt } from './characterVoice';
import type { DeterministicStyleMetrics } from './authorStyle';

export type StyleContinuityFindingStatus = 'CONSISTENT' | 'INTENTIONAL_VARIATION' | 'POTENTIAL_DRIFT' | 'INSUFFICIENT_EVIDENCE';
export type ContinuitySceneKind = 'UNKNOWN' | 'DAILY' | 'COMBAT' | 'CRISIS' | 'REFLECTION';
export interface ContinuitySample {
  source: VoiceSourceReference;
  episodeNumber: number;
  episodeTitle: string;
  sceneKind: ContinuitySceneKind;
  characterIds: string[];
  style: DeterministicStyleMetrics;
  voice: VoiceMetrics;
  voiceExcerpts: VoiceExcerpt[];
  canonRelationshipChange: boolean;
}
export interface ContinuityFinding {
  id: string;
  dimension: 'SENTENCE' | 'PARAGRAPH' | 'DIALOGUE' | 'PSYCHOLOGY' | 'DISTANCE' | 'POV' | 'VOICE' | 'TRANSITION';
  status: StyleContinuityFindingStatus;
  description: string;
  confidence: 'LOW' | 'MEDIUM';
  before: number;
  after: number;
}
export interface StyleContinuityReport {
  samples: ContinuitySample[];
  findings: ContinuityFinding[];
}
