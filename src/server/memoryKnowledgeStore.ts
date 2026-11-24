import { FieldPath, type DocumentReference, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import type {
  MemoryKnowledgeAnnotation, MemoryKnowledgeApprovalEntry, MemoryKnowledgePage, MemoryKnowledgeReceipt, MemoryKnowledgeRow, MemoryKnowledgeSource,
  MemoryKnowledgeTally, MemoryKnowledgeWriteResult, MemoryKnowledgeErrorCode,
} from '../types/memoryKnowledge';
import { KNOWLEDGE_METHODS, MEMORY_KNOWLEDGE_SCOPES } from '../types/memoryKnowledge';
import type { MemoryChunk, MemoryDocument } from '../types/foundation';
import type { SceneMemoryRequirements } from '../types/sceneMemory';
import { computeMemoryContentHash, RAG_ENGINE_DEFAULTS } from '../services/memorySearchProvider';
import { annotationEligibility, hasKnowledgeScopeConflict, proposeMemoryKnowledge } from '../utils/memoryKnowledgeLogic';
import { knowledgeStatus, temporalStatus, verifySceneMemoryProvenance, type SceneMemoryCandidate, type VerifiedMemorySource } from '../utils/sceneMemoryLogic';
import { buildVerifiedSource, episodePosition, generationStatus, isCanon, makeSourceReader } from './memorySourceAuthority';
import { knowledgeHash, resolveKnowledgeAcquisition } from './knowledgeAcquisition';
import type { FirestoreRagManifestDoc } from './ragEngine';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const recordId = z.string().regex(/^mk_[a-f0-9]{64}$/);
const scope = z.enum(MEMORY_KNOWLEDGE_SCOPES);
const classification = z.enum(['PAST_EVENT', 'CURRENT_VALID_STATE', 'SUPERSEDED_HISTORICAL_STATE']);
const sourceSchema = z.object({
  sourceEntityType: id, sourceEntityId: id, sourceRevisionId: id, sourceContentHash: hash,
  sourceStartOffset: z.number().int().nonnegative(), sourceEndOffset: z.number().int().positive(),
}).refine((value) => value.sourceStartOffset < value.sourceEndOffset);
const acquisitionSchema = z.object({
  characterId: id, method: z.enum(KNOWLEDGE_METHODS), episodeId: id, sceneId: id.optional(), eventId: id.optional(),
});
const positionSchema = z.object({
  episodeId: id, episodeNumber: z.number().int().positive(), sceneId: id.optional(),
  sceneNumber: z.number().int().positive().optional(), eventId: id.optional(), order: z.number().optional(),
});
const evidence = acquisitionSchema.and(sourceSchema).and(z.object({
  factId: recordId, position: positionSchema, proofHash: hash, verificationStatus: z.literal('AUTHOR_CONFIRMED'),
  approvedBy: id, approvedAt: z.iso.datetime(),
}));
const annotationSchema = z.object({
  id: recordId, ownerId: id, projectId: id, source: sourceSchema, scope,
  acquisition: z.array(evidence).max(8), classification, verificationStatus: z.enum(['AUTHOR_CONFIRMED', 'REJECTED']),
  version: z.number().int().positive(), operationId: id, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), approvedBy: id,
});
const receiptSchema = z.object({ id, fingerprint: hash, previous: annotationSchema.nullable(), record: annotationSchema });
const commandSchema = z.object({
  chunkId: id, source: sourceSchema, scope, acquisition: z.array(acquisitionSchema).max(8), classification,
  operationId: id, expectedVersion: z.number().int().nonnegative(),
});
export const memoryKnowledgeWriteSchema = z.object({ projectId: id, confirmed: z.literal(true), commands: z.array(commandSchema).min(1).max(16) })
  .refine(({ commands }) => new Set(commands.map((command) => command.operationId)).size === commands.length &&
    new Set(commands.map((command) => memoryAnnotationId(command.source))).size === commands.length);
const optionalEpisode = z.coerce.number().int().positive().optional();
const targetSchema = z.object({
  targetEpisodeId: id.optional(), targetSceneNumber: optionalEpisode, targetEventId: id.optional(), characterId: id.optional(),
});
export const memoryKnowledgeListSchema = targetSchema.extend({
  projectId: id, after: id.optional(), documentId: id.optional(), sourceEntityId: id.optional(),
  minEpisode: optionalEpisode, maxEpisode: optionalEpisode,
  status: z.enum(['ANNOTATED', 'UNANNOTATED', 'PARTIALLY_ANNOTATED', 'SOURCE_UNVERIFIED', 'STALE_ANNOTATION', 'CONFLICTING_ANNOTATION', 'REVIEW_REQUIRED']).optional(),
}).refine(({ minEpisode, maxEpisode }) => !minEpisode || !maxEpisode || minEpisode <= maxEpisode);
export const memoryKnowledgeSummarySchema = z.object({ projectId: id, after: id.optional() });
export const memoryKnowledgeHistorySchema = z.object({ projectId: id, annotationId: recordId, after: id.optional() });

export class MemoryKnowledgeError extends Error {
  constructor(readonly code: MemoryKnowledgeErrorCode) { super(code); }
}

export function memoryAnnotationId(ref: Pick<MemoryKnowledgeSource, 'sourceEntityType' | 'sourceEntityId' | 'sourceStartOffset' | 'sourceEndOffset'>) {
  return `mk_${knowledgeHash(JSON.stringify([ref.sourceEntityType, ref.sourceEntityId, ref.sourceStartOffset, ref.sourceEndOffset]))}`;
}

function scopedAnnotation(data: unknown, docId: string, ownerId: string, projectId: string) {
  const parsed = annotationSchema.safeParse(data);
  if (!parsed.success) throw new MemoryKnowledgeError('SOURCE_UNVERIFIED');
  const row = parsed.data;
  if (row.ownerId !== ownerId || row.projectId !== projectId || row.approvedBy !== ownerId || row.id !== docId ||
      row.id !== memoryAnnotationId(row.source) || (row.scope === 'CHARACTERS') !== Boolean(row.acquisition.length) ||
      (row.scope === 'UNKNOWN') !== (row.verificationStatus === 'REJECTED') ||
      new Set(row.acquisition.map(({ characterId }) => characterId)).size !== row.acquisition.length || row.acquisition.some((grant) =>
        grant.factId !== docId || grant.approvedBy !== ownerId || grant.position.episodeId !== grant.episodeId || !sameSource(row.source, grant))) {
    throw new MemoryKnowledgeError('SOURCE_UNVERIFIED');
  }
  return row;
}

function sameSource(a: MemoryKnowledgeSource, b: MemoryKnowledgeSource) {
  return a.sourceEntityType === b.sourceEntityType && a.sourceEntityId === b.sourceEntityId &&
    a.sourceRevisionId === b.sourceRevisionId && a.sourceContentHash === b.sourceContentHash &&
    a.sourceStartOffset === b.sourceStartOffset && a.sourceEndOffset === b.sourceEndOffset;
}

export function memoryKnowledgeSource(chunk: MemoryChunk, document: MemoryDocument, source: VerifiedMemorySource): MemoryKnowledgeSource | undefined {
  const start = chunk.sourceStartOffset, end = chunk.sourceEndOffset;
  if (start === undefined || end === undefined) return;
  const original = source.texts.find((text) => computeMemoryContentHash(text) === document.contentHash && text.slice(start, end) === chunk.content);
  if (!original) return;
  return {
    sourceEntityType: chunk.sourceEntityType, sourceEntityId: chunk.sourceEntityId, sourceRevisionId: source.revisionId,
    sourceContentHash: knowledgeHash(original), sourceStartOffset: start, sourceEndOffset: end,
  };
}

export async function assertMemoryProjectOwner(db: Firestore, ownerId: string, projectId: string, tx?: Transaction) {
  if (!id.safeParse(ownerId).success || !id.safeParse(projectId).success || ownerId === 'local_author') throw new MemoryKnowledgeError('FORBIDDEN');
  const ref = db.doc(`users/${ownerId}/projects/${projectId}`);
  const row = (await (tx ? tx.get(ref) : ref.get())).data();
  if (row?.ownerId !== ownerId || row.id !== projectId || ['DELETED', 'PENDING_DELETE'].includes(row.lifecycleStatus)) throw new MemoryKnowledgeError('FORBIDDEN');
  return ref;
}

function annotations(db: Firestore, base: string) { return db.collection(`${base}/memoryKnowledgeAnnotations`); }

async function inspectAnnotation(row: MemoryKnowledgeAnnotation, ref: MemoryKnowledgeSource, source: VerifiedMemorySource,
  reader: ReturnType<typeof makeSourceReader>, characterId?: string) {
  if (!sameSource(row.source, ref)) return 'STALE_ANNOTATION';
  if (hasKnowledgeScopeConflict(source.legacyKnowledge, row.scope, row.acquisition.map((grant) => grant.characterId))) return 'KNOWLEDGE_SCOPE_CONFLICT';
  const grants = characterId ? row.acquisition.filter((grant) => grant.characterId === characterId) : row.acquisition;
  for (const grant of grants) {
    if (!isCanon(await reader.entity('characters', grant.characterId))) return 'STALE_ANNOTATION';
    const current = await resolveKnowledgeAcquisition(reader, grant);
    if (!current || current.proofHash !== grant.proofHash) return 'STALE_ANNOTATION';
  }
}

export async function applyWriterMemoryKnowledge(db: Firestore, reader: ReturnType<typeof makeSourceReader>,
  ownerId: string, projectId: string, candidates: SceneMemoryCandidate[], target: SceneMemoryRequirements, beforeRead?: () => void) {
  const slots = candidates.map(({ hit, source }) => {
    const ref = memoryKnowledgeSource(hit.chunk, hit.document, source);
    return ref && { ref, id: memoryAnnotationId(ref) };
  });
  const ids = [...new Set(slots.flatMap((slot) => slot ? [slot.id] : []))];
  if (!ids.length) return;
  const collection = annotations(db, reader.base);
  beforeRead?.();
  const snapshots = await db.getAll(...ids.map((key) => collection.doc(key)));
  const byId = new Map(snapshots.filter((snap) => snap.exists).map((snap) => [snap.id, snap.data()]));
  for (const [i, { source }] of candidates.entries()) {
    const slot = slots[i];
    if (!slot) { source.knowledgeRejection = 'SOURCE_UNVERIFIED'; continue; }
    if (!byId.has(slot.id)) {
      if (!source.knowledge) source.knowledgeRejection = 'POV_KNOWLEDGE_RESTRICTED';
      continue;
    }
    try {
      const row = scopedAnnotation(byId.get(slot.id), slot.id, ownerId, projectId);
      source.knowledgeRejection = await inspectAnnotation(row, slot.ref, source, reader, target.pointOfViewCharacterId);
      if (!source.knowledgeRejection) {
        source.durableKnowledge = row;
        if (!source.historicalState && !source.currentState && row.verificationStatus === 'AUTHOR_CONFIRMED') {
          source.historicalState = row.classification === 'SUPERSEDED_HISTORICAL_STATE';
          source.currentState = row.classification === 'CURRENT_VALID_STATE';
        }
      }
    } catch (error) {
      if (!(error instanceof MemoryKnowledgeError)) throw error;
      source.knowledgeRejection = 'SOURCE_UNVERIFIED';
    }
  }
}

export async function verifyAuthoritativeIndexedChunk(ownerId: string, projectId: string, chunk: MemoryChunk, document: MemoryDocument | undefined,
  manifest: FirestoreRagManifestDoc | undefined, reader: ReturnType<typeof makeSourceReader>, sources: Map<string, Promise<VerifiedMemorySource | undefined>>) {
  const key = `${chunk.sourceEntityType}:${chunk.sourceEntityId}`;
  const pending = sources.get(key) ?? buildVerifiedSource(chunk, reader, ownerId, projectId).catch(() => undefined);
  sources.set(key, pending);
  const source = await pending;
  const generation = document ? generationStatus(ownerId, projectId, manifest, chunk, document) : 'UNKNOWN';
  const failure = verifySceneMemoryProvenance({ ownerId, projectId, chunk, document, source, generation });
  return { source, ref: !failure && document && source ? memoryKnowledgeSource(chunk, document, source) : undefined, failure };
}

async function saveOne(db: Firestore, ownerId: string, projectId: string, command: z.infer<typeof commandSchema>) {
  const annotationId = memoryAnnotationId(command.source);
  const fingerprint = knowledgeHash(JSON.stringify(command));
  return db.runTransaction(async (tx) => {
    const project = await assertMemoryProjectOwner(db, ownerId, projectId, tx);
    const receipt = project.collection('memoryKnowledgeDecisions').doc(command.operationId);
    const receiptSnapshot = await tx.get(receipt);
    if (receiptSnapshot.exists) {
      const stored = receiptSchema.safeParse(receiptSnapshot.data());
      if (!stored.success || stored.data.fingerprint !== fingerprint || stored.data.id !== command.operationId ||
          stored.data.record.operationId !== command.operationId) throw new MemoryKnowledgeError('OPERATION_CONFLICT');
      return scopedAnnotation(stored.data.record, annotationId, ownerId, projectId);
    }

    const chunkSnapshot = await tx.get(project.collection('memoryChunks').doc(command.chunkId));
    const chunk = chunkSnapshot.data() as MemoryChunk | undefined;
    if (!chunk || chunk.id !== command.chunkId || !id.safeParse(chunk.documentId).success) throw new MemoryKnowledgeError('SOURCE_UNVERIFIED');
    const annotationRef = project.collection('memoryKnowledgeAnnotations').doc(annotationId);
    const [currentSnapshot, document, manifest] = await tx.getAll(annotationRef,
      project.collection('memoryDocuments').doc(chunk.documentId), project.collection('ragManifest').doc('control'));
    const current = currentSnapshot.exists ? scopedAnnotation(currentSnapshot.data(), annotationId, ownerId, projectId) : null;
    if ((current?.version ?? 0) !== command.expectedVersion) throw new MemoryKnowledgeError('VERSION_CONFLICT');
    const reader = makeSourceReader(db, ownerId, projectId, tx);
    const verification = await verifyAuthoritativeIndexedChunk(ownerId, projectId, chunk, document.data() as MemoryDocument | undefined,
      manifest.data() as FirestoreRagManifestDoc | undefined, reader, new Map());
    if (!verification.ref || !verification.source) {
      throw new MemoryKnowledgeError(verification.failure === 'STALE_SOURCE' ? 'STALE_SOURCE' : 'SOURCE_UNVERIFIED');
    }
    if (!sameSource(verification.ref, command.source)) throw new MemoryKnowledgeError('STALE_SOURCE');

    const characterIds = command.acquisition.map((grant) => grant.characterId);
    if (new Set(characterIds).size !== characterIds.length || (command.scope === 'CHARACTERS') !== Boolean(characterIds.length)) {
      throw new MemoryKnowledgeError('INVALID_CHARACTER_SCOPE');
    }
    if (hasKnowledgeScopeConflict(verification.source.legacyKnowledge, command.scope, characterIds)) throw new MemoryKnowledgeError('KNOWLEDGE_SCOPE_CONFLICT');
    const now = new Date().toISOString();
    const acquisition: MemoryKnowledgeAnnotation['acquisition'] = [];
    for (const grant of command.acquisition) {
      if (!isCanon(await reader.entity('characters', grant.characterId))) throw new MemoryKnowledgeError('INVALID_CHARACTER_SCOPE');
      const resolved = await resolveKnowledgeAcquisition(reader, grant);
      if (!resolved) throw new MemoryKnowledgeError('TEMPORAL_EVIDENCE_MISSING');
      acquisition.push({ ...verification.ref, ...grant, ...resolved, factId: annotationId, approvedAt: now, approvedBy: ownerId, verificationStatus: 'AUTHOR_CONFIRMED' });
    }
    const record: MemoryKnowledgeAnnotation = {
      id: annotationId, ownerId, projectId, source: verification.ref, scope: command.scope, acquisition, classification: command.classification,
      verificationStatus: command.scope === 'UNKNOWN' ? 'REJECTED' : 'AUTHOR_CONFIRMED',
      version: (current?.version ?? 0) + 1, operationId: command.operationId, createdAt: current?.createdAt ?? now, updatedAt: now, approvedBy: ownerId,
    };
    const audit: MemoryKnowledgeReceipt = { id: command.operationId, fingerprint, previous: current, record };
    tx.set(annotationRef, record);
    tx.create(receipt, { ...audit, annotationId });
    return record;
  });
}

export async function saveMemoryKnowledge(db: Firestore, ownerId: string, input: z.infer<typeof memoryKnowledgeWriteSchema>) {
  const request = memoryKnowledgeWriteSchema.safeParse(input);
  if (!request.success) throw new MemoryKnowledgeError('BAD_REQUEST');
  const { projectId, commands } = request.data;
  await assertMemoryProjectOwner(db, ownerId, projectId);
  const results: MemoryKnowledgeWriteResult[] = [];
  for (const command of commands) {
    try {
      results.push({ operationId: command.operationId, ok: true, record: await saveOne(db, ownerId, projectId, command) });
    } catch (error) {
      // A lost response may have committed. A retry with the same operation ID resolves it.
      results.push({ operationId: command.operationId, ok: false, code: error instanceof MemoryKnowledgeError ? error.code : 'TEMPORARY_FAILURE' });
    }
  }
  return { results };
}

export const emptyMemoryTally = (): MemoryKnowledgeTally => ({
  reviewedDocuments: 0, annotatedDocuments: 0, unannotatedDocuments: 0, verifiedDocuments: 0,
  staleDocuments: 0, reviewDocuments: 0, eligibleDocuments: 0,
});

async function projectCounts(db: Firestore, base: string, manifest?: FirestoreRagManifestDoc) {
  const snapshot = await db.collection(`${base}/memoryDocuments`).count().get();
  const activeIds = manifest?.projectLifecycleStatus === 'ACTIVE' ? Object.values(manifest.entityStates ?? {})
    .filter((state) => state.lifecycleStatus === 'ACTIVE' || state.lifecycleStatus === 'REINDEXING_KEEP_OLD')
    .flatMap((state) => state.activeDocumentIds ?? []) : [];
  return { totalDocuments: snapshot.data().count, activeDocuments: new Set(activeIds).size };
}

async function getTarget(reader: ReturnType<typeof makeSourceReader>, query: z.infer<typeof targetSchema>): Promise<SceneMemoryRequirements | undefined> {
  if (!query.targetEpisodeId) return;
  const episode = await reader.entity('episodes', query.targetEpisodeId);
  const episodeNumber = episodePosition(episode?.episodeNumber);
  if (!episode || episodeNumber === undefined) throw new MemoryKnowledgeError('TEMPORAL_EVIDENCE_MISSING');
  const cutoff = query.targetEventId ? await reader.entity('timelineEvents', query.targetEventId) : undefined;
  const order = query.targetEventId && isCanon(cutoff) && typeof cutoff?.episodeId === 'string' ? (await resolveKnowledgeAcquisition(reader, {
    episodeId: cutoff.episodeId, eventId: query.targetEventId, characterId: '', method: 'UNKNOWN',
  }))?.position.order : undefined;
  if (query.targetEventId && order === undefined) {
    throw new MemoryKnowledgeError('TEMPORAL_EVIDENCE_MISSING');
  }
  return {
    projectId: episode.projectId, episodeId: episode.id, episodeNumber, sceneNumber: query.targetSceneNumber,
    perspective: 'THIRD_LIMITED', pointOfViewCharacterId: query.characterId, sceneGoal: '', characterIds: [],
    narrativeCutoff: query.targetEventId && order !== undefined ? { eventId: query.targetEventId, order } : undefined,
    requiredEventIds: [], relatedForeshadowingIds: [], relevantLocations: [], relevantWorldbuildingIds: [], semanticQueries: [], keywordQueries: [],
  };
}

function potentialWriterIssue(source: VerifiedMemorySource, record?: MemoryKnowledgeAnnotation) {
  const resolved = source.foreshadowingPhase === 'RESOLVED' || source.foreshadowingPhase === 'ABANDONED';
  const episodeBased = source.episodeNumber !== undefined && (!resolved || source.resolvedEpisodeNumber !== undefined);
  const narrativeBased = source.narrativeOrder !== undefined && (!resolved || source.resolvedOrder !== undefined);
  const timeless = source.knowledge?.timeless === true && source.episodeNumber === undefined && source.narrativeOrder === undefined &&
    !source.foreshadowingPhase && !source.historicalState && !source.eventIds.length;
  if (!episodeBased && !narrativeBased && !timeless) return 'TEMPORAL_EVIDENCE_MISSING';
  if (record && record.verificationStatus !== 'AUTHOR_CONFIRMED') return 'POV_KNOWLEDGE_RESTRICTED';
  const scope = record?.scope ?? source.legacyKnowledge?.scope;
  if (scope === 'PUBLIC') return;
  if (scope === 'CHARACTERS') {
    const grants = record?.acquisition.filter((grant) => grant.method !== 'INFERRED' && grant.method !== 'UNKNOWN').map((grant) => grant.position) ?? [];
    if (grants.some((position) => episodeBased || timeless || position.order !== undefined)) return;
    return grants.length || !record ? 'TEMPORAL_EVIDENCE_MISSING' : 'POV_KNOWLEDGE_RESTRICTED';
  }
  return 'POV_KNOWLEDGE_RESTRICTED';
}

async function reviewRows(db: Firestore, ownerId: string, projectId: string, chunks: MemoryChunk[],
  documents: Map<string, MemoryDocument>, manifest: FirestoreRagManifestDoc | undefined, reader: ReturnType<typeof makeSourceReader>,
  target?: SceneMemoryRequirements, summary = false): Promise<MemoryKnowledgeRow[]> {
  const sources = new Map<string, Promise<VerifiedMemorySource | undefined>>();
  const checked = await Promise.all(chunks.map((chunk) => verifyAuthoritativeIndexedChunk(ownerId, projectId, chunk, documents.get(chunk.documentId), manifest, reader, sources)));
  const keys = chunks.map((chunk) => chunk.sourceStartOffset === undefined || chunk.sourceEndOffset === undefined ? undefined : memoryAnnotationId({
    sourceEntityType: chunk.sourceEntityType, sourceEntityId: chunk.sourceEntityId,
    sourceStartOffset: chunk.sourceStartOffset, sourceEndOffset: chunk.sourceEndOffset,
  }));
  const byId = new Map<string, unknown>();
  const unique = [...new Set(keys.filter((value): value is string => Boolean(value)))];
  for (let i = 0; i < unique.length; i += 80) {
    const snapshots = await db.getAll(...unique.slice(i, i + 80).map((key) => annotations(db, reader.base).doc(key)));
    for (const snap of snapshots) if (snap.exists) byId.set(snap.id, snap.data());
  }
  return Promise.all(chunks.map(async (chunk, index) => {
    const { source, ref, failure } = checked[index];
    const key = keys[index];
    const candidate = proposeMemoryKnowledge(Boolean(ref), source?.legacyKnowledge, chunk.content);
    const row: MemoryKnowledgeRow = {
      chunkId: chunk.id, documentId: chunk.documentId, annotationId: key,
      title: documents.get(chunk.documentId)?.title ?? chunk.sourceEntityId,
      excerpt: summary || !ref ? '' : chunk.content,
      episodeNumber: source?.episodeNumber ?? chunk.episodeNumber, characterIds: source?.characterIds ?? [],
      sourceEntityType: chunk.sourceEntityType, sourceEntityId: chunk.sourceEntityId, sourceRevisionId: chunk.sourceRevisionId,
      source: ref, ...candidate, status: 'SOURCE_UNVERIFIED', writerEligible: false, reason: failure,
    };
    if (key && byId.has(key)) {
      try {
        row.annotation = scopedAnnotation(byId.get(key), key, ownerId, projectId);
      } catch (error) {
        if (!(error instanceof MemoryKnowledgeError)) throw error;
        return { ...row, status: 'CONFLICTING_ANNOTATION', reason: error.code };
      }
      if (!source || !ref) return { ...row, status: 'STALE_ANNOTATION' };
      const issue = await inspectAnnotation(row.annotation, ref, source, reader);
      if (issue) return { ...row, status: issue === 'STALE_ANNOTATION' ? 'STALE_ANNOTATION' : 'CONFLICTING_ANNOTATION', reason: issue };
      row.status = row.annotation.verificationStatus === 'REJECTED' ? 'REVIEW_REQUIRED' : 'ANNOTATED';
      row.characterIds = [...new Set([...row.characterIds, ...row.annotation.acquisition.map((grant) => grant.characterId)])];
      if (target) {
        const timing = temporalStatus(target, source);
        const eligibility = annotationEligibility(row.annotation, target);
        row.knownAtTarget = (eligibility === 'PUBLIC' || eligibility === 'POV_CHARACTER_KNOWLEDGE') &&
          (timing === 'CURRENT_VALID_STATE' || timing === 'PAST_EVENT' || timing === 'SUPERSEDED_HISTORICAL_STATE');
        row.reason = row.knownAtTarget ? undefined : timing === 'FUTURE_INFORMATION' || timing === 'TEMPORAL_EVIDENCE_MISSING' || timing === 'SOURCE_UNVERIFIED' ? timing : eligibility;
      }
      if (!target) row.reason = potentialWriterIssue(source, row.annotation);
      row.writerEligible = target ? Boolean(row.knownAtTarget) : !row.reason;
      return row;
    }
    if (source && ref) {
      row.status = source.legacyKnowledge ? source.legacyKnowledge.scope === 'CHARACTERS' ? 'PARTIALLY_ANNOTATED' : 'ANNOTATED' : 'UNANNOTATED';
      row.reason = potentialWriterIssue(source);
      row.writerEligible = !row.reason;
      if (target) {
        const timing = temporalStatus(target, source);
        const known = knowledgeStatus(target, source);
        row.writerEligible = Boolean(source.legacyKnowledge) && (known === 'PUBLIC' || known === 'POV_CHARACTER_KNOWLEDGE') &&
          timing !== 'FUTURE_INFORMATION' && timing !== 'SOURCE_UNVERIFIED' && timing !== 'TEMPORAL_EVIDENCE_MISSING';
        row.knownAtTarget = row.writerEligible;
        if (!row.writerEligible) row.reason = timing === 'FUTURE_INFORMATION' || timing === 'TEMPORAL_EVIDENCE_MISSING' || timing === 'SOURCE_UNVERIFIED' ? timing : known;
      }
    }
    return row;
  }));
}

export async function listMemoryKnowledge(db: Firestore, ownerId: string, query: z.infer<typeof memoryKnowledgeListSchema>): Promise<MemoryKnowledgePage> {
  const project = await assertMemoryProjectOwner(db, ownerId, query.projectId);
  const reader = makeSourceReader(db, ownerId, query.projectId);
  const chunkCollection = project.collection('memoryChunks');
  let cursor = query.documentId ? chunkCollection.where('documentId', '==', query.documentId) :
    query.sourceEntityId ? chunkCollection.where('sourceEntityId', '==', query.sourceEntityId) : chunkCollection;
  const range = !query.documentId && !query.sourceEntityId && (query.minEpisode || query.maxEpisode);
  if (range) {
    if (query.minEpisode) cursor = cursor.where('episodeNumber', '>=', query.minEpisode);
    if (query.maxEpisode) cursor = cursor.where('episodeNumber', '<=', query.maxEpisode);
    cursor = cursor.orderBy('episodeNumber');
  }
  cursor = cursor.orderBy(FieldPath.documentId());
  if (query.after) {
    if (range) {
      const marker = await chunkCollection.doc(query.after).get();
      if (!marker.exists) throw new MemoryKnowledgeError('BAD_REQUEST');
      cursor = cursor.startAfter(marker);
    } else cursor = cursor.startAfter(query.after);
  }
  const [page, manifestSnapshot, target] = await Promise.all([
    cursor.limit(21).get(), project.collection('ragManifest').doc('control').get(), getTarget(reader, query),
  ]);
  const chunks = page.docs.slice(0, 20).map((snap) => snap.data() as MemoryChunk)
    .filter((chunk) => id.safeParse(chunk.documentId).success && chunk.ownerId === ownerId && chunk.projectId === query.projectId);
  const docRefs = [...new Set(chunks.map((chunk) => chunk.documentId))].map((key) => project.collection('memoryDocuments').doc(key));
  const parents = docRefs.length ? await db.getAll(...docRefs) : [];
  const docs = new Map(parents.filter((snap) => snap.exists).map((snap) => [snap.id, snap.data() as MemoryDocument]));
  const manifest = manifestSnapshot.data() as FirestoreRagManifestDoc | undefined;
  const rows = await reviewRows(db, ownerId, query.projectId, chunks, docs, manifest, reader, target);
  return {
    ...(!query.after ? await projectCounts(db, project.path, manifest) : {}), tally: emptyMemoryTally(),
    rows: rows.filter((row) => (!query.characterId || row.characterIds.includes(query.characterId) || (target && row.status !== 'SOURCE_UNVERIFIED')) &&
      (!query.status || row.status === query.status) && (!query.minEpisode || (row.episodeNumber ?? 0) >= query.minEpisode) &&
      (!query.maxEpisode || (row.episodeNumber ?? Number.POSITIVE_INFINITY) <= query.maxEpisode)),
    next: page.size > 20 ? page.docs[19].id : undefined,
  };
}

export async function summarizeMemoryKnowledge(db: Firestore, ownerId: string, query: z.infer<typeof memoryKnowledgeSummarySchema>): Promise<MemoryKnowledgePage> {
  const project = await assertMemoryProjectOwner(db, ownerId, query.projectId);
  const reader = makeSourceReader(db, ownerId, query.projectId);
  let cursor = project.collection('memoryDocuments').orderBy(FieldPath.documentId());
  if (query.after) cursor = cursor.startAfter(query.after);
  const [page, snapshot] = await Promise.all([cursor.limit(3).get(), project.collection('ragManifest').doc('control').get()]);
  const manifest = snapshot.data() as FirestoreRagManifestDoc | undefined;
  const tally = emptyMemoryTally();
  for (const doc of page.docs.slice(0, 2)) {
    const document = doc.data() as MemoryDocument;
    const chunks = await project.collection('memoryChunks').where('documentId', '==', doc.id).limit(RAG_ENGINE_DEFAULTS.MAX_CHUNKS_PER_DOCUMENT_PART + 1).get();
    const rows = await reviewRows(db, ownerId, query.projectId,
      chunks.docs.slice(0, RAG_ENGINE_DEFAULTS.MAX_CHUNKS_PER_DOCUMENT_PART).map((snap) => snap.data() as MemoryChunk), new Map([[doc.id, document]]),
      manifest, reader, undefined, true);
    tally.reviewedDocuments++;
    if (rows.some((row) => row.status === 'ANNOTATED' || row.status === 'PARTIALLY_ANNOTATED')) tally.annotatedDocuments++;
    if (rows.some((row) => row.status === 'UNANNOTATED')) tally.unannotatedDocuments++;
    if (rows.some((row) => row.source)) tally.verifiedDocuments++;
    if (rows.some((row) => row.status === 'STALE_ANNOTATION')) tally.staleDocuments++;
    if (!rows.length || rows.some((row) => row.status !== 'ANNOTATED')) tally.reviewDocuments++;
    if (rows.some((row) => row.writerEligible)) tally.eligibleDocuments++;
  }
  return { ...(!query.after ? await projectCounts(db, project.path, manifest) : {}), rows: [], tally, next: page.size > 2 ? page.docs[1].id : undefined };
}

export async function listMemoryKnowledgeHistory(db: Firestore, ownerId: string, query: z.infer<typeof memoryKnowledgeHistorySchema>) {
  const project = await assertMemoryProjectOwner(db, ownerId, query.projectId);
  let cursor = project.collection('memoryKnowledgeDecisions').where('annotationId', '==', query.annotationId).orderBy(FieldPath.documentId());
  if (query.after) cursor = cursor.startAfter(query.after);
  const page = await cursor.limit(21).get();
  const entries = page.docs.slice(0, 20).map((snap) => {
    const receipt = receiptSchema.parse(snap.data());
    if (receipt.id !== snap.id || receipt.record.operationId !== snap.id) throw new MemoryKnowledgeError('SOURCE_UNVERIFIED');
    scopedAnnotation(receipt.record, query.annotationId, ownerId, query.projectId);
    if (receipt.previous) scopedAnnotation(receipt.previous, query.annotationId, ownerId, query.projectId);
    return receipt;
  });
  return { entries, next: page.size > 20 ? page.docs[19].id : undefined };
}

async function hasActiveApprovalRange(project: DocumentReference, row: MemoryKnowledgeAnnotation, source: VerifiedMemorySource,
  manifest: FirestoreRagManifestDoc | undefined) {
  const range = await project.collection('memoryChunks').where('sourceEntityId', '==', row.source.sourceEntityId)
    .where('sourceStartOffset', '==', row.source.sourceStartOffset).limit(25).get();
  const chunks = range.docs.map((snap) => snap.data() as MemoryChunk).filter((chunk) =>
    chunk.sourceEntityType === row.source.sourceEntityType && chunk.sourceRevisionId === row.source.sourceRevisionId &&
    chunk.sourceEndOffset === row.source.sourceEndOffset && id.safeParse(chunk.documentId).success);
  const refs = [...new Set(chunks.map((chunk) => chunk.documentId))].map((key) => project.collection('memoryDocuments').doc(key));
  if (!refs.length) return false;
  const documents = new Map((await project.firestore.getAll(...refs)).map((snap) => [snap.id, snap.data() as MemoryDocument | undefined]));
  return chunks.some((chunk) => {
    const document = documents.get(chunk.documentId);
    return document && !verifySceneMemoryProvenance({
      ownerId: row.ownerId, projectId: row.projectId, chunk, document, source,
      generation: generationStatus(row.ownerId, row.projectId, manifest, chunk, document),
    }) && memoryKnowledgeSource(chunk, document, source)?.sourceContentHash === row.source.sourceContentHash;
  });
}

export async function listMemoryKnowledgeApprovals(db: Firestore, ownerId: string, query: z.infer<typeof memoryKnowledgeSummarySchema>) {
  const project = await assertMemoryProjectOwner(db, ownerId, query.projectId);
  const reader = makeSourceReader(db, ownerId, query.projectId);
  let cursor = annotations(db, project.path).orderBy(FieldPath.documentId());
  if (query.after) cursor = cursor.startAfter(query.after);
  const [page, snapshot] = await Promise.all([cursor.limit(21).get(), project.collection('ragManifest').doc('control').get()]);
  const manifest = snapshot.data() as FirestoreRagManifestDoc | undefined;
  const entries: MemoryKnowledgeApprovalEntry[] = [];
  for (const snap of page.docs.slice(0, 20)) {
    const row = scopedAnnotation(snap.data(), snap.id, ownerId, query.projectId);
    const key = [ownerId, query.projectId, row.source.sourceEntityType, row.source.sourceEntityId].join(':');
    const state = manifest?.entityStates?.[key];
    const source = await buildVerifiedSource(row.source, reader, ownerId, query.projectId).catch(() => undefined);
    const matching = source?.texts.some((text) => knowledgeHash(text) === row.source.sourceContentHash && row.source.sourceEndOffset <= text.length);
    const active = manifest?.projectLifecycleStatus === 'ACTIVE' && state?.activeRevisionId === row.source.sourceRevisionId &&
      (state.lifecycleStatus === 'ACTIVE' || state.lifecycleStatus === 'REINDEXING_KEEP_OLD') && state.activeDocumentIds?.length;
    const issue = source && matching && active && source.revisionId === row.source.sourceRevisionId
      ? await inspectAnnotation(row, row.source, source, reader) : 'STALE_ANNOTATION';
    const validRange = !issue && source && await hasActiveApprovalRange(project, row, source, manifest);
    entries.push({ record: row, status: issue === 'KNOWLEDGE_SCOPE_CONFLICT' ? 'CONFLICTING_ANNOTATION' :
      issue ? 'STALE_ANNOTATION' : validRange && row.verificationStatus === 'AUTHOR_CONFIRMED' ? 'ANNOTATED' : 'REVIEW_REQUIRED' });
  }
  return { entries, next: page.size > 20 ? page.docs[19].id : undefined };
}
