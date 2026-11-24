import type { MemoryTemporalStatus } from './sceneMemory';

export const MEMORY_KNOWLEDGE_SCOPES = ['PUBLIC', 'CHARACTERS', 'AUTHOR_ONLY', 'UNKNOWN'] as const;
export const KNOWLEDGE_METHODS = ['WITNESSED', 'EXPERIENCED', 'TOLD', 'DOCUMENT', 'INFERRED', 'UNKNOWN'] as const;
export type MemoryKnowledgeScope = typeof MEMORY_KNOWLEDGE_SCOPES[number];
export type KnowledgeMethod = typeof KNOWLEDGE_METHODS[number];
export type MemoryReviewStatus = 'ANNOTATED' | 'UNANNOTATED' | 'PARTIALLY_ANNOTATED' | 'SOURCE_UNVERIFIED'
  | 'STALE_ANNOTATION' | 'CONFLICTING_ANNOTATION' | 'REVIEW_REQUIRED';

export interface MemoryKnowledgeSource {
  sourceEntityType: string;
  sourceEntityId: string;
  sourceRevisionId: string;
  sourceContentHash: string;
  sourceStartOffset: number;
  sourceEndOffset: number;
}

export interface KnowledgeAcquisitionInput {
  characterId: string;
  method: KnowledgeMethod;
  episodeId: string;
  sceneId?: string;
  eventId?: string;
}

export interface KnowledgePosition {
  episodeId: string;
  episodeNumber: number;
  sceneId?: string;
  sceneNumber?: number;
  eventId?: string;
  order?: number;
}

export interface CharacterKnowledgeEvidence extends MemoryKnowledgeSource, KnowledgeAcquisitionInput {
  factId: string;
  position: KnowledgePosition;
  proofHash: string;
  verificationStatus: 'AUTHOR_CONFIRMED';
  approvedBy: string;
  approvedAt: string;
}

export interface MemoryKnowledgeAnnotation {
  id: string;
  ownerId: string;
  projectId: string;
  source: MemoryKnowledgeSource;
  scope: MemoryKnowledgeScope;
  acquisition: CharacterKnowledgeEvidence[];
  classification: MemoryTemporalStatus;
  verificationStatus: 'AUTHOR_CONFIRMED' | 'REJECTED';
  version: number;
  operationId: string;
  createdAt: string;
  updatedAt: string;
  approvedBy: string;
}

export interface MemoryKnowledgeCommand {
  chunkId: string;
  source: MemoryKnowledgeSource;
  operationId: string;
  expectedVersion: number;
  scope: MemoryKnowledgeScope;
  acquisition: KnowledgeAcquisitionInput[];
  classification: MemoryTemporalStatus;
}

export type MemoryKnowledgeErrorCode = 'BAD_REQUEST' | 'FORBIDDEN' | 'VERSION_CONFLICT' | 'OPERATION_CONFLICT'
  | 'TEMPORARY_FAILURE' | 'STALE_SOURCE' | 'SOURCE_UNVERIFIED' | 'KNOWLEDGE_SCOPE_CONFLICT' | 'INVALID_CHARACTER_SCOPE' | 'TEMPORAL_EVIDENCE_MISSING';

export interface MemoryKnowledgeRow {
  chunkId: string;
  documentId: string;
  annotationId?: string;
  title: string;
  excerpt: string;
  episodeNumber?: number;
  characterIds: string[];
  source?: MemoryKnowledgeSource;
  sourceEntityType: string;
  sourceEntityId: string;
  sourceRevisionId: string;
  candidateScope: MemoryKnowledgeScope;
  candidateReason: 'AUTHOR_METADATA' | 'DIRECT_QUOTE_REVIEW' | 'SOURCE_EXCERPT' | 'UNVERIFIED';
  status: MemoryReviewStatus;
  annotation?: MemoryKnowledgeAnnotation;
  writerEligible: boolean;
  knownAtTarget?: boolean;
  reason?: string;
}

export interface MemoryKnowledgeTally {
  reviewedDocuments: number;
  annotatedDocuments: number;
  unannotatedDocuments: number;
  verifiedDocuments: number;
  staleDocuments: number;
  reviewDocuments: number;
  eligibleDocuments: number;
}

export interface MemoryKnowledgePage {
  rows: MemoryKnowledgeRow[];
  totalDocuments?: number;
  activeDocuments?: number;
  next?: string;
  tally: MemoryKnowledgeTally;
}

export interface MemoryKnowledgeReceipt {
  id: string;
  fingerprint: string;
  previous: MemoryKnowledgeAnnotation | null;
  record: MemoryKnowledgeAnnotation;
}

export type MemoryKnowledgeWriteResult =
  | { operationId: string; ok: true; record: MemoryKnowledgeAnnotation }
  | { operationId: string; ok: false; code: MemoryKnowledgeErrorCode };

export interface MemoryKnowledgeApprovalEntry {
  record: MemoryKnowledgeAnnotation;
  status: MemoryReviewStatus;
}
