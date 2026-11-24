import type { MemoryKnowledgeSource } from './memoryKnowledge';

export const NARRATIVE_NODES = ['TIMELINE_EVENT', 'EPISODE', 'SCENE', 'CHARACTER', 'RELATIONSHIP', 'FORESHADOWING', 'WORLDBUILDING'] as const;
export const NARRATIVE_RELATIONS = ['CAUSES', 'LEADS_TO', 'PARTICIPATED_IN', 'WITNESSED', 'LEARNED_FROM',
  'CHANGES_RELATIONSHIP', 'CHANGES_CHARACTER_STATE', 'PLANTS_FORESHADOWING', 'REINFORCES_FORESHADOWING',
  'RESOLVES_FORESHADOWING', 'CONTRADICTS', 'SUPPORTS', 'RELATED_TO'] as const;
export const CHARACTER_STATE_AXES = ['HEALTH', 'IDENTITY', 'AFFILIATION', 'ABILITY', 'POSSESSION', 'SURVIVAL', 'GOAL', 'EMOTION'] as const;
export type NarrativeNodeType = typeof NARRATIVE_NODES[number];
export type NarrativeRelation = typeof NARRATIVE_RELATIONS[number];
export type NarrativeNode = { type: NarrativeNodeType; id: string };
export type NarrativeStatus = 'AUTHOR_CONFIRMED' | 'EXPLICITLY_VERIFIED' | 'CANDIDATE' | 'REJECTED' | 'STALE' | 'CONFLICTED';
export type NarrativeVisibility = 'AUTHOR_ONLY' | 'SOURCE_KNOWLEDGE';
export type NarrativeState = { characterId: string; axis: typeof CHARACTER_STATE_AXES[number] };
export type NarrativeStateStatus = 'HISTORICAL' | 'CURRENT' | 'FUTURE_PLANNED' | 'CONFLICTED' | 'UNKNOWN';

export interface NarrativeEvidenceLocator {
  chunkId: string;
  source: MemoryKnowledgeSource;
}
export interface NarrativeEvidenceRef extends NarrativeEvidenceLocator {
  nodeFingerprint: string;
}
export interface NarrativeEdge {
  id: string;
  ownerId: string;
  projectId: string;
  from: NarrativeNode;
  to: NarrativeNode;
  relation: NarrativeRelation;
  status: NarrativeStatus;
  visibility: NarrativeVisibility;
  state?: NarrativeState;
}
export interface NarrativeMemoryLink extends NarrativeEdge {
  evidence: [NarrativeEvidenceRef, NarrativeEvidenceRef];
  version: number;
  operationId: string;
  updatedAt: string;
  createdAt: string;
  approvedBy: string;
}
export interface NarrativeDecision {
  id: string;
  fingerprint: string;
  previous: NarrativeMemoryLink | null;
  record: NarrativeMemoryLink;
}
export interface NarrativeLinkCommand {
  projectId: string;
  from: NarrativeNode;
  to: NarrativeNode;
  relation: NarrativeRelation;
  evidence: [NarrativeEvidenceLocator, NarrativeEvidenceLocator];
  visibility: NarrativeVisibility;
  state?: NarrativeState;
  expectedVersion: number;
  operationId: string;
  status: 'CANDIDATE' | 'AUTHOR_CONFIRMED' | 'REJECTED';
  confirmed: true;
}

export type GraphRejection = 'UNVERIFIED_LINK' | 'STALE_LINK' | 'DELETED_NODE' | 'CROSS_PROJECT_LINK' | 'CAUSAL_EVIDENCE_MISSING'
  | 'FUTURE_EVENT' | 'POV_KNOWLEDGE_RESTRICTED' | 'GRAPH_DEPTH_EXCEEDED' | 'GRAPH_BUDGET_EXCEEDED' | 'DUPLICATE_NODE' | 'CYCLIC_PATH';
export interface GraphPath {
  depth: number;
  via: NarrativeEdge[];
}
export interface NarrativeGraphDiagnostics {
  status: 'DISABLED' | 'NO_SEEDS' | 'NO_LINKS' | 'EXPANDED' | 'BUDGET_LIMITED' | 'SEARCH_FAILED';
  seeds: number;
  visitedNodes: number;
  visitedEdges: number;
  depth: number;
  discoveryReads: number;
  verificationReads: number;
  newCandidates: number;
  verifiedLinks: number;
  causalLinks: number;
  relationshipLinks: number;
  foreshadowingLinks: number;
  rejected: Partial<Record<GraphRejection, number>>;
  runDiscoveryReads: number;
  runVerificationReads: number;
  relationshipStates?: { nodeId: string; status: NarrativeStateStatus }[];
  characterStates?: { nodeId: string; characterId: string; axis: NarrativeState['axis']; status: NarrativeStateStatus }[];
}
export interface NarrativeWriterLink {
  from: NarrativeNode;
  to: NarrativeNode;
  relation: NarrativeRelation;
}
export interface NarrativeLinkPage {
  entries: { link: NarrativeMemoryLink; status: NarrativeStatus; reason?: GraphRejection; titles?: [string, string]; orders?: [number | null, number | null] }[];
  next?: string;
}

export interface NarrativeDerivedPreview {
  entries: { edge: NarrativeEdge; titles: [string, string]; orders: [number | null, number | null]; clueStatus?: string }[];
}
