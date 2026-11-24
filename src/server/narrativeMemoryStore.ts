import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { CHARACTER_STATE_AXES, NARRATIVE_NODES, NARRATIVE_RELATIONS, type NarrativeDecision,
  type NarrativeEdge, type NarrativeDerivedPreview, type NarrativeEvidenceLocator, type NarrativeLinkPage, type NarrativeMemoryLink, type NarrativeNode } from '../types/narrativeMemory';
import { adjacentNarrativeNode, narrativeNodeKey } from '../utils/narrativeMemoryLogic';
import { safeMemoryId, verifySceneMemoryProvenance, type SceneMemoryCandidate } from '../utils/sceneMemoryLogic';
import type { MemoryChunk, MemoryDocument } from '../types/foundation';
import { assertMemoryProjectOwner, memoryKnowledgeSource, verifyAuthoritativeIndexedChunk } from './memoryKnowledgeStore';
import { knowledgeHash } from './knowledgeAcquisition';
import { buildVerifiedSource, generationStatus, makeSourceReader, scopedCollection, isCanon } from './memorySourceAuthority';
import { classifyDerivedClue, deriveNarrativeEdges, derivedNarrativeEdge } from './narrativeDerivedEdges';
import type { FirestoreRagManifestDoc } from './ragEngine';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const linkId = z.string().regex(/^nl_[a-f0-9]{64}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const node = z.object({ type: z.enum(NARRATIVE_NODES), id });
const state = z.object({ characterId: id, axis: z.enum(CHARACTER_STATE_AXES) });
const relation = z.enum(NARRATIVE_RELATIONS);
const visibility = z.enum(['AUTHOR_ONLY', 'SOURCE_KNOWLEDGE']);
const status = z.enum(['CANDIDATE', 'AUTHOR_CONFIRMED', 'REJECTED']);
const source = z.object({
  sourceEntityType: z.enum(NARRATIVE_NODES), sourceEntityId: id, sourceRevisionId: id, sourceContentHash: hash,
  sourceStartOffset: z.number().int().nonnegative(), sourceEndOffset: z.number().int().positive(),
});
const locator = z.object({ chunkId: id, source });
const evidence = locator.extend({ nodeFingerprint: hash });

export const narrativeCommandSchema = z.object({
  projectId: id, from: node, to: node, relation, evidence: z.tuple([locator, locator]), visibility, state: state.optional(),
  expectedVersion: z.number().int().nonnegative(), operationId: id, status, confirmed: z.literal(true),
});
const linkSchema = z.object({
  id: linkId, ownerId: id, projectId: id, from: node, to: node, relation, status, visibility, state: state.optional(),
  evidence: z.tuple([evidence, evidence]), approvedBy: id, version: z.number().int().positive(), operationId: id,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
const receiptSchema = z.object({ id, fingerprint: hash, previous: linkSchema.nullable(), record: linkSchema });
export const narrativeListSchema = z.object({ projectId: id, after: id.optional(), nodeType: z.enum(NARRATIVE_NODES).optional(), nodeId: id.optional() })
  .refine((data) => Boolean(data.nodeType) === Boolean(data.nodeId));
export const narrativePreviewSchema = z.object({ projectId: id, nodeType: z.enum(NARRATIVE_NODES), nodeId: id });
export const narrativeHistorySchema = z.object({ projectId: id, linkId, after: id.optional() });

export class NarrativeMemoryError extends Error {
  constructor(readonly code: 'INVALID_LINK' | 'STALE_LINK' | 'CAUSAL_EVIDENCE_MISSING' | 'VERSION_CONFLICT' | 'OPERATION_CONFLICT' | 'DELETED_NODE') {
    super(code);
  }
}

export function narrativeLinkId(edge: Pick<NarrativeEdge, 'from' | 'to' | 'relation' | 'state'>) {
  return 'nl_' + knowledgeHash(JSON.stringify([narrativeNodeKey(edge.from), narrativeNodeKey(edge.to), edge.relation,
    edge.state?.characterId ?? null, edge.state?.axis ?? null]));
}

function stableJson(value: unknown): string {
  const ordered = (data: unknown): unknown => {
    if (Array.isArray(data)) return data.map(ordered);
    if (data && typeof data === 'object') return Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, ordered(item)]));
    return data;
  };
  return JSON.stringify(ordered(value));
}

export async function narrativeNodeFingerprint(reader: ReturnType<typeof makeSourceReader>, node: NarrativeNode) {
  const collection = scopedCollection(node.type);
  const data = collection ? await reader.entity(collection, node.id) : undefined;
  if (!isCanon(data)) return;
  return knowledgeHash(stableJson(data));
}

export function parseNarrativeLink(data: unknown, key: string, ownerId: string, projectId: string) {
  const parsed = linkSchema.safeParse(data);
  if (!parsed.success) return;
  const link = parsed.data;
  if (link.id !== key || link.id !== narrativeLinkId(link) || link.ownerId !== ownerId || link.projectId !== projectId ||
      link.approvedBy !== ownerId || narrativeNodeKey(link.from) === narrativeNodeKey(link.to) ||
      !matchesNode(link.evidence[0], link.from) || !matchesNode(link.evidence[1], link.to) ||
      (link.relation === 'CHANGES_CHARACTER_STATE') !== Boolean(link.state)) return;
  return link;
}

function matchesNode(locator: NarrativeEvidenceLocator, node: NarrativeNode) {
  return locator.source.sourceEntityId === node.id && locator.source.sourceEntityType === node.type;
}
function equalSource(a: NarrativeEvidenceLocator['source'], b: NarrativeEvidenceLocator['source']) {
  return a.sourceEntityType === b.sourceEntityType && a.sourceEntityId === b.sourceEntityId &&
    a.sourceRevisionId === b.sourceRevisionId && a.sourceContentHash === b.sourceContentHash &&
    a.sourceStartOffset === b.sourceStartOffset && a.sourceEndOffset === b.sourceEndOffset;
}

export function matchesNarrativeEvidence(ref: NarrativeEvidenceLocator, candidate: SceneMemoryCandidate) {
  const current = memoryKnowledgeSource(candidate.hit.chunk, candidate.hit.document, candidate.source);
  return Boolean(current && equalSource(ref.source, current));
}

export async function checkNarrativeLinkSemantics(link: NarrativeEdge,
  from: Awaited<ReturnType<typeof buildVerifiedSource>>, to: Awaited<ReturnType<typeof buildVerifiedSource>>,
  reader: ReturnType<typeof makeSourceReader>) {
  if (!from || !to) return 'STALE_LINK';
  if ((link.relation === 'CAUSES' || link.relation === 'LEADS_TO') && (link.from.type !== 'TIMELINE_EVENT' || link.to.type !== 'TIMELINE_EVENT' ||
    from.narrativeOrder === undefined || to.narrativeOrder === undefined || from.narrativeOrder >= to.narrativeOrder)) {
    return link.relation === 'CAUSES' ? 'CAUSAL_EVIDENCE_MISSING' : 'STALE_LINK';
  }
  if (link.relation === 'CHANGES_CHARACTER_STATE') {
    if (!link.state || link.from.type !== 'TIMELINE_EVENT' || link.to.type !== 'TIMELINE_EVENT' || !isCanon(await reader.entity('characters', link.state.characterId)) ||
        !to.characterIds.includes(link.state.characterId) || from.narrativeOrder === undefined ||
        to.narrativeOrder === undefined || from.narrativeOrder >= to.narrativeOrder) return 'STALE_LINK';
  }
  if (link.relation === 'CHANGES_RELATIONSHIP' && (link.from.type !== 'TIMELINE_EVENT' || link.to.type !== 'RELATIONSHIP' ||
      (await reader.entity('relationships', link.to.id))?.effectiveEventId !== link.from.id)) return 'STALE_LINK';
  if (link.relation === 'PLANTS_FORESHADOWING' || link.relation === 'RESOLVES_FORESHADOWING' || link.relation === 'REINFORCES_FORESHADOWING') {
    if (link.from.type !== 'TIMELINE_EVENT' || link.to.type !== 'FORESHADOWING') return 'STALE_LINK';
    const [event, clue] = await Promise.all([reader.entity('timelineEvents', link.from.id), reader.entity('foreshadowings', link.to.id)]);
    if (!isCanon(event) || !isCanon(clue) || !safeMemoryId(event?.sceneId)) return 'STALE_LINK';
    if (link.relation === 'PLANTS_FORESHADOWING' && (event?.sceneId !== clue?.plantedSceneId || event?.episodeId !== clue?.plantedEpisodeId)) return 'STALE_LINK';
    if (link.relation === 'RESOLVES_FORESHADOWING' && (clue?.cluePhase !== 'RESOLVED' || event?.sceneId !== clue?.resolvedSceneId ||
        event?.episodeId !== clue?.resolvedEpisodeId)) return 'STALE_LINK';
    if (link.relation === 'REINFORCES_FORESHADOWING' && ((clue?.cluePhase !== 'REINFORCED' && clue?.cluePhase !== 'RESOLVED') ||
        !Array.isArray(clue.relatedEventIds) || !clue.relatedEventIds.includes(link.from.id) ||
        event?.sceneId === clue.plantedSceneId || event?.sceneId === clue.resolvedSceneId)) return 'STALE_LINK';
  }
}

const statusNotCandidate = (link: NarrativeMemoryLink) => link.status === 'AUTHOR_CONFIRMED';
export async function admitStoredLink(link: NarrativeMemoryLink, from: SceneMemoryCandidate[], to: SceneMemoryCandidate[], reader: ReturnType<typeof makeSourceReader>) {
  if (!statusNotCandidate(link)) return 'UNVERIFIED_LINK';
  const a = from.find((candidate) => matchesNarrativeEvidence(link.evidence[0], candidate));
  const b = to.find((candidate) => matchesNarrativeEvidence(link.evidence[1], candidate));
  if (!a || !b) return 'STALE_LINK';
  const stamps = await Promise.all([narrativeNodeFingerprint(reader, link.from), narrativeNodeFingerprint(reader, link.to)]);
  if (stamps.some((stamp, index) => !stamp || stamp !== link.evidence[index].nodeFingerprint)) return 'STALE_LINK';
  return checkNarrativeLinkSemantics(link, a.source, b.source, reader);
}

export async function saveNarrativeLink(db: Firestore, ownerId: string, request: z.infer<typeof narrativeCommandSchema>) {
  const command = narrativeCommandSchema.parse(request);
  const { from, to, projectId, operationId } = command;
  if (narrativeNodeKey(from) === narrativeNodeKey(to) || !matchesNode(command.evidence[0], from) || !matchesNode(command.evidence[1], to) ||
      (command.relation === 'CHANGES_CHARACTER_STATE') !== Boolean(command.state)) throw new NarrativeMemoryError('INVALID_LINK');
  const key = narrativeLinkId(command);
  const fingerprint = knowledgeHash(stableJson(command));
  return db.runTransaction(async (tx) => {
    const project = await assertMemoryProjectOwner(db, ownerId, projectId, tx);
    const receipt = project.collection('narrativeMemoryDecisions').doc(operationId);
    const currentRef = project.collection('narrativeMemoryLinks').doc(key);
    const [receiptSnap, currentSnap, manifestSnap] = await tx.getAll(receipt, currentRef, project.collection('ragManifest').doc('control'));
    if (receiptSnap.exists) {
      const saved = receiptSchema.safeParse(receiptSnap.data());
      if (!saved.success || saved.data.id !== operationId || saved.data.fingerprint !== fingerprint || saved.data.record.operationId !== operationId) {
        throw new NarrativeMemoryError('OPERATION_CONFLICT');
      }
      const replay = parseNarrativeLink(saved.data.record, key, ownerId, projectId);
      if (!replay) throw new NarrativeMemoryError('OPERATION_CONFLICT');
      return replay;
    }
    const current = currentSnap.exists ? parseNarrativeLink(currentSnap.data(), key, ownerId, projectId) : null;
    if ((currentSnap.exists && !current) || (current?.version ?? 0) !== command.expectedVersion) throw new NarrativeMemoryError('VERSION_CONFLICT');
    const reader = makeSourceReader(db, ownerId, projectId, tx);
    const now = new Date().toISOString();
    const value: Omit<NarrativeMemoryLink, 'evidence'> = {
      id: key, ownerId, projectId, from, to, visibility: command.visibility, relation: command.relation,
      ...(command.state ? { state: command.state } : {}), status: command.status, version: (current?.version ?? 0) + 1,
      operationId, createdAt: current?.createdAt ?? now, updatedAt: now, approvedBy: ownerId,
    };
    // Rejection retires the existing decision even when its original endpoints have since changed or been deleted.
    let record: NarrativeMemoryLink;
    if (command.status === 'REJECTED' && current) {
      record = { ...value, evidence: current.evidence };
    } else {
      const endpoints = [];
      for (const [i, p] of command.evidence.entries()) {
        const chunk = (await tx.get(project.collection('memoryChunks').doc(p.chunkId))).data() as MemoryChunk | undefined;
        if (!chunk || chunk.id !== p.chunkId || !safeMemoryId(chunk.documentId)) throw new NarrativeMemoryError('STALE_LINK');
        const document = (await tx.get(project.collection('memoryDocuments').doc(chunk.documentId))).data() as MemoryDocument | undefined;
        const checked = await verifyAuthoritativeIndexedChunk(ownerId, projectId, chunk, document,
          manifestSnap.data() as FirestoreRagManifestDoc | undefined, reader, new Map());
        const stamp = await narrativeNodeFingerprint(reader, i === 0 ? from : to);
        if (!checked.source || !checked.ref || !stamp || !equalSource(p.source, checked.ref)) throw new NarrativeMemoryError('STALE_LINK');
        endpoints.push({ ref: { chunkId: p.chunkId, source: checked.ref, nodeFingerprint: stamp }, source: checked.source });
      }
      if (command.status === 'AUTHOR_CONFIRMED') {
        const issue = await checkNarrativeLinkSemantics(value, endpoints[0].source, endpoints[1].source, reader);
        if (issue) throw new NarrativeMemoryError(issue);
      }
      record = { ...value, evidence: [endpoints[0].ref, endpoints[1].ref] };
    }
    const audit: NarrativeDecision = { id: operationId, fingerprint, previous: current ?? null, record };
    tx.set(currentRef, { ...record, nodeKeys: [narrativeNodeKey(from), narrativeNodeKey(to)],
      ...(record.state ? { stateKey: record.state.characterId + ':' + record.state.axis } : {}) });
    tx.create(receipt, { ...audit, linkId: key });
    return record;
  });
}

async function hasActiveNarrativeEvidence(db: Firestore, base: string, loc: NarrativeEvidenceLocator, source: NonNullable<Awaited<ReturnType<typeof buildVerifiedSource>>>,
  manifest: FirestoreRagManifestDoc | undefined, ownerId: string, projectId: string) {
  const results = await db.collection(base + '/memoryChunks').where('sourceEntityId', '==', loc.source.sourceEntityId)
    .where('sourceStartOffset', '==', loc.source.sourceStartOffset).limit(17).get();
  const matches = results.docs.flatMap((snap) => {
    const chunk = snap.data() as MemoryChunk;
    return chunk.id === snap.id && chunk.sourceEntityType === loc.source.sourceEntityType &&
      chunk.sourceEndOffset === loc.source.sourceEndOffset && safeMemoryId(chunk.documentId) ? [chunk] : [];
  });
  if (!matches.length) return false;
  const docs = await db.getAll(...[...new Set(matches.map((chunk) => chunk.documentId))].map((id) => db.doc(base + '/memoryDocuments/' + id)));
  const documents = new Map(docs.map((item) => [item.id, item.data() as MemoryDocument | undefined]));
  return matches.some((chunk) => {
    const document = documents.get(chunk.documentId);
    if (!document) return false;
    const generation = generationStatus(ownerId, projectId, manifest, chunk, document);
    if (verifySceneMemoryProvenance({ ownerId, projectId, chunk, document, source, generation })) return false;
    const ref = memoryKnowledgeSource(chunk, document, source);
    return Boolean(ref && equalSource(ref, loc.source));
  });
}

export async function listNarrativeLinks(db: Firestore, ownerId: string, request: z.infer<typeof narrativeListSchema>): Promise<NarrativeLinkPage> {
  const project = await assertMemoryProjectOwner(db, ownerId, request.projectId);
  const reader = makeSourceReader(db, ownerId, request.projectId);
  let query = project.collection('narrativeMemoryLinks').orderBy(FieldPath.documentId());
  if (request.nodeType && request.nodeId) query = query.where('nodeKeys', 'array-contains', narrativeNodeKey({ type: request.nodeType, id: request.nodeId }));
  if (request.after) query = query.startAfter(request.after);
  const [page, manifestSnapshot] = await Promise.all([query.limit(13).get(), project.collection('ragManifest').doc('control').get()]);
  const manifest = manifestSnapshot.data() as FirestoreRagManifestDoc | undefined;
  const entries: NarrativeLinkPage['entries'] = [];
  for (const row of page.docs.slice(0, 12)) {
    const link = parseNarrativeLink(row.data(), row.id, ownerId, request.projectId);
    if (!link) continue;
    if (link.status === 'REJECTED') { entries.push({ link, status: 'REJECTED' }); continue; }
    const collection = (target: NarrativeNode) => scopedCollection(target.type)!;
    const [fromNode, toNode, a, b, fromSource, toSource] = await Promise.all([
      reader.entity(collection(link.from), link.from.id), reader.entity(collection(link.to), link.to.id),
      narrativeNodeFingerprint(reader, link.from), narrativeNodeFingerprint(reader, link.to),
      buildVerifiedSource({ sourceEntityType: link.from.type, sourceEntityId: link.from.id }, reader, ownerId, request.projectId).catch(() => undefined),
      buildVerifiedSource({ sourceEntityType: link.to.type, sourceEntityId: link.to.id }, reader, ownerId, request.projectId).catch(() => undefined),
    ]);
    const stamped = a === link.evidence[0].nodeFingerprint && b === link.evidence[1].nodeFingerprint && [fromSource, toSource].every((item, i) =>
      item?.revisionId === link.evidence[i].source.sourceRevisionId && item.texts.some((text) => knowledgeHash(text) === link.evidence[i].source.sourceContentHash));
    const current = stamped && fromSource && toSource && (await Promise.all([
      hasActiveNarrativeEvidence(db, project.path, link.evidence[0], fromSource, manifest, ownerId, request.projectId),
      hasActiveNarrativeEvidence(db, project.path, link.evidence[1], toSource, manifest, ownerId, request.projectId),
    ])).every(Boolean);
    const semantics = current && link.status === 'AUTHOR_CONFIRMED' ? await checkNarrativeLinkSemantics(link, fromSource, toSource, reader) : undefined;
    entries.push({ link, status: !fromNode || !toNode || !current ? 'STALE' : semantics ? 'CONFLICTED' : link.status,
      ...(!fromNode || !toNode ? { reason: 'DELETED_NODE' as const } : !current ? { reason: 'STALE_LINK' as const } : semantics ? { reason: semantics } : {}),
      titles: [String(fromNode?.title ?? fromNode?.name ?? link.from.id), String(toNode?.title ?? toNode?.name ?? link.to.id)],
      orders: [fromSource?.narrativeOrder ?? null, toSource?.narrativeOrder ?? null],
    });
  }
  return { entries, next: page.size > 12 ? page.docs[11].id : undefined };
}

export async function listNarrativeDecisions(db: Firestore, ownerId: string, request: z.infer<typeof narrativeHistorySchema>) {
  const project = await assertMemoryProjectOwner(db, ownerId, request.projectId);
  let query = project.collection('narrativeMemoryDecisions').where('linkId', '==', request.linkId).orderBy(FieldPath.documentId());
  if (request.after) query = query.startAfter(request.after);
  const page = await query.limit(13).get();
  const entries = page.docs.slice(0, 12).flatMap((row) => {
    const parsed = receiptSchema.safeParse(row.data());
    if (!parsed.success || parsed.data.id !== row.id || parsed.data.record.operationId !== row.id ||
        !parseNarrativeLink(parsed.data.record, request.linkId, ownerId, request.projectId) ||
        (parsed.data.previous && !parseNarrativeLink(parsed.data.previous, request.linkId, ownerId, request.projectId))) return [];
    return [parsed.data];
  });
  return { entries, next: page.size > 12 ? page.docs[11].id : undefined };
}

export async function previewNarrativeLinks(db: Firestore, ownerId: string, request: z.infer<typeof narrativePreviewSchema>) {
  const project = await assertMemoryProjectOwner(db, ownerId, request.projectId);
  const reader = makeSourceReader(db, ownerId, request.projectId);
  const focus = { type: request.nodeType, id: request.nodeId };
  const current = await reader.entity(scopedCollection(focus.type)!, focus.id);
  if (!current) throw new NarrativeMemoryError('DELETED_NODE');
  const planned = !isCanon(current);
  const derived = deriveNarrativeEdges(ownerId, request.projectId, focus, current);
  if (focus.type === 'TIMELINE_EVENT') {
    const related = await project.collection('relationships').where('effectiveEventId', '==', focus.id).limit(5).get();
    for (const row of related.docs) if (row.data().id === row.id && row.data().ownerId === ownerId && row.data().projectId === request.projectId) {
      derived.push(derivedNarrativeEdge(ownerId, request.projectId, focus, { type: 'RELATIONSHIP', id: row.id }, 'CHANGES_RELATIONSHIP'));
    }
  }
  const entries: NarrativeDerivedPreview['entries'] = [];
  for (const edge of derived.slice(0, 8)) {
    const next = adjacentNarrativeNode(edge, narrativeNodeKey(focus));
    if (!next) continue;
    const other = await reader.entity(scopedCollection(next.type)!, next.id);
    const a = await reader.entity(scopedCollection(edge.from.type)!, edge.from.id);
    const b = await reader.entity(scopedCollection(edge.to.type)!, edge.to.id);
    const narrativeState = (row: typeof other) => row?.cluePhase === 'PLANTED' ? 'UNRESOLVED' : row?.cluePhase;
    if (!other) edge.status = 'STALE';
    else if (planned || !isCanon(other)) edge.status = 'CANDIDATE';
    else {
      await classifyDerivedClue(edge, reader);
      const [from, to] = await Promise.all([
        buildVerifiedSource({ sourceEntityType: edge.from.type, sourceEntityId: edge.from.id }, reader, ownerId, request.projectId).catch(() => undefined),
        buildVerifiedSource({ sourceEntityType: edge.to.type, sourceEntityId: edge.to.id }, reader, ownerId, request.projectId).catch(() => undefined),
      ]);
      if (await checkNarrativeLinkSemantics(edge, from, to, reader)) edge.status = 'STALE';
    }
    entries.push({ edge, titles: [String(a?.title ?? a?.name ?? edge.from.id), String(b?.title ?? b?.name ?? edge.to.id)],
      orders: [typeof a?.chronologicalOrder === 'number' ? a.chronologicalOrder : null, typeof b?.chronologicalOrder === 'number' ? b.chronologicalOrder : null],
      ...((focus.type === 'FORESHADOWING' || next.type === 'FORESHADOWING') ? { clueStatus: planned || !isCanon(other) ? 'FUTURE_PLOT_PLAN' :
        narrativeState(focus.type === 'FORESHADOWING' ? current : other) } : {}),
    });
  }
  return { entries } satisfies NarrativeDerivedPreview;
}
