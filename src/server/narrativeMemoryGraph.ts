import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import type { ScenePlanItem } from '../types/aiEngine';
import type { MemoryChunk, MemoryDocument } from '../types/foundation';
import type { GraphPath, GraphRejection, NarrativeEdge, NarrativeGraphDiagnostics, NarrativeNode, NarrativeState } from '../types/narrativeMemory';
import type { SceneMemoryRequirements } from '../types/sceneMemory';
import type { MemorySearchHit } from '../services/memorySearchProvider';
import { NARRATIVE_NODES } from '../types/narrativeMemory';
import { classifyStateTimeline, GRAPH_LIMITS, graphDiagnostics, narrativeNodeKey, rejectGraph, walkNarrativeGraph } from '../utils/narrativeMemoryLogic';
import { knowledgeStatus, safeMemoryId, temporalStatus, type SceneMemoryCandidate } from '../utils/sceneMemoryLogic';
import { applyWriterMemoryKnowledge, verifyAuthoritativeIndexedChunk } from './memoryKnowledgeStore';
import { buildVerifiedSource, generationStatus, isCanon, makeSourceReader, scopedCollection } from './memorySourceAuthority';
import { admitStoredLink, narrativeNodeFingerprint, parseNarrativeLink, checkNarrativeLinkSemantics, matchesNarrativeEvidence } from './narrativeMemoryStore';
import { classifyDerivedClue, deriveNarrativeEdges, derivedNarrativeEdge } from './narrativeDerivedEdges';
import type { FirestoreRagManifestDoc } from './ragEngine';

class GraphBudgetExceeded extends Error {}
type ReadKind = 'discovery' | 'verification';
export const newGraphRun = () => ({ discovery: 0, verification: 0 });

function graphMeter(run: ReturnType<typeof newGraphRun>, diagnostics: NarrativeGraphDiagnostics) {
  const reads = newGraphRun();
  const limits = {
    discovery: [GRAPH_LIMITS.sceneDiscoveryReads, GRAPH_LIMITS.runDiscoveryReads],
    verification: [GRAPH_LIMITS.sceneVerificationReads, GRAPH_LIMITS.runVerificationReads],
  };
  const remaining = (kind: ReadKind) => Math.min(limits[kind][0] - reads[kind], limits[kind][1] - run[kind]);
  const available = (kind: ReadKind) => remaining(kind) > 0;
  const read = (kind: ReadKind) => {
    if (!available(kind)) throw new GraphBudgetExceeded();
    reads[kind]++;
    run[kind]++;
    Object.assign(diagnostics, { discoveryReads: reads.discovery, verificationReads: reads.verification,
      runDiscoveryReads: run.discovery, runVerificationReads: run.verification });
  };
  return { available, remaining, read };
}

const typeSet: ReadonlySet<string> = new Set(NARRATIVE_NODES);
export function graphNode(candidate: SceneMemoryCandidate): NarrativeNode | undefined {
  const { sourceEntityType, sourceEntityId } = candidate.hit.chunk;
  if (!typeSet.has(sourceEntityType) || !safeMemoryId(sourceEntityId)) return;
  return { type: sourceEntityType as NarrativeNode['type'], id: sourceEntityId };
}

export function graphEligibility(candidate: SceneMemoryCandidate, target: SceneMemoryRequirements): GraphRejection | undefined {
  const time = temporalStatus(target, candidate.source);
  if (time === 'FUTURE_INFORMATION') return 'FUTURE_EVENT';
  if (time === 'SOURCE_UNVERIFIED' || time === 'TEMPORAL_EVIDENCE_MISSING') return 'UNVERIFIED_LINK';
  const knowledge = knowledgeStatus(target, candidate.source);
  if (knowledge === 'FUTURE_INFORMATION') return 'FUTURE_EVENT';
  if (knowledge !== 'PUBLIC' && knowledge !== 'POV_CHARACTER_KNOWLEDGE') return 'POV_KNOWLEDGE_RESTRICTED';
}

const graphHit = (chunk: MemoryChunk, document: MemoryDocument): MemorySearchHit => ({
  chunk, document, score: 0, relevanceScore: 0, keywordScore: 0, semanticScore: 0, matchedTerms: [],
  freshnessStatus: 'FRESH', verifiedForWriting: true, retrievalSource: 'KEYWORD_ONLY',
});

type GraphInput = {
  db: Firestore; ownerId: string; projectId: string; manifest?: FirestoreRagManifestDoc;
  requirements: SceneMemoryRequirements; approvedScene?: ScenePlanItem;
  seedReader: ReturnType<typeof makeSourceReader>;
  base: SceneMemoryCandidate[]; seeds: SceneMemoryCandidate[]; limit: number; run: ReturnType<typeof newGraphRun>;
  claimRetrieval: () => boolean; canRetrieve: () => boolean;
};
type Lookup = { candidates: SceneMemoryCandidate[]; issue?: GraphRejection };
type GraphResult = {
  candidates: SceneMemoryCandidate[];
  paths: Map<string, GraphPath>;
  links: NarrativeEdge[];
  linkProofs: Map<string, [string, string]>;
  authorities: SceneMemoryCandidate[];
  diagnostics: NarrativeGraphDiagnostics;
};

export async function retrieveNarrativeGraph(input: GraphInput): Promise<GraphResult> {
  const { db, ownerId, projectId, manifest, requirements, approvedScene } = input;
  const diagnostics = graphDiagnostics();
  diagnostics.runDiscoveryReads = input.run.discovery;
  diagnostics.runVerificationReads = input.run.verification;
  const empty = () => ({ candidates: [], paths: new Map(), links: [], linkProofs: new Map(), authorities: [], diagnostics });
  const meter = graphMeter(input.run, diagnostics);
  const reader = makeSourceReader(db, ownerId, projectId, undefined, () => meter.read('verification'));
  for (const [key, record] of input.seedReader.records) reader.records.set(key, record);
  const project = db.doc(reader.base);
  const stored = new Map<string, ReturnType<typeof parseNarrativeLink>>();
  const sourceCache = new Map<string, Promise<Awaited<ReturnType<typeof buildVerifiedSource>>>>();
  const lookupCache = new Map<string, Promise<Lookup>>();
  const verifiedRows = new Map<string, Lookup>();

  for (const candidate of input.base) {
    const node = graphNode(candidate);
    if (!node) continue;
    const key = narrativeNodeKey(node);
    const current = verifiedRows.get(key) ?? { candidates: [] };
    const issue = graphEligibility(candidate, requirements);
    if (issue) current.issue ??= issue;
    else current.candidates.push(candidate);
    verifiedRows.set(key, current);
  }
  const seedNodes = input.seeds.flatMap((candidate) => {
    const node = graphNode(candidate);
    return node && !graphEligibility(candidate, requirements) ? [node] : [];
  });
  if (!seedNodes.length) return empty();
  if (!input.canRetrieve() || !meter.available('discovery') || !meter.available('verification')) {
    diagnostics.status = 'BUDGET_LIMITED';
    rejectGraph(diagnostics, 'GRAPH_BUDGET_EXCEEDED');
    return empty();
  }
  const readNode = (node: NarrativeNode) => reader.entity(scopedCollection(node.type)!, node.id);
  const lookup = async (node: NarrativeNode): Promise<Lookup> => {
    const key = narrativeNodeKey(node);
    const existing = verifiedRows.get(key);
    if (existing?.candidates.length) return existing;
    let pending = lookupCache.get(key);
    if (!pending) {
      pending = (async () => {
        const record = await readNode(node);
        if (!record) return { candidates: [], issue: 'DELETED_NODE' };
        if (!isCanon(record)) return { candidates: [], issue: 'UNVERIFIED_LINK' };
        const state = manifest?.entityStates?.[ownerId + ':' + projectId + ':' + key];
        if (!state?.activeDocumentIds?.length || !['ACTIVE', 'REINDEXING_KEEP_OLD'].includes(state.lifecycleStatus)) {
          return { candidates: [], issue: 'STALE_LINK' };
        }
        if (!meter.available('discovery') || !input.claimRetrieval()) throw new GraphBudgetExceeded();
        meter.read('discovery');
        const chunks = await project.collection('memoryChunks').where('sourceEntityId', '==', node.id).limit(GRAPH_LIMITS.chunksPerNode + 1).get();
        const samples = chunks.docs.slice(0, GRAPH_LIMITS.chunksPerNode).flatMap((snap) => {
          const chunk = snap.data() as MemoryChunk;
          return chunk.id === snap.id && chunk.ownerId === ownerId && chunk.projectId === projectId && chunk.sourceEntityType === node.type &&
            safeMemoryId(chunk.documentId) ? [chunk] : [];
        });
        if (!samples.length) return { candidates: [], issue: 'STALE_LINK' };
        // Preserve the existing scene-scoped POV declaration for these exact candidate sources.
        const promise = buildVerifiedSource({ sourceEntityId: node.id, sourceEntityType: node.type }, reader, ownerId, projectId,
          approvedScene, requirements.pointOfViewCharacterId);
        sourceCache.set(key, promise);
        const verified = await promise;
        if (!verified) return { candidates: [], issue: 'STALE_LINK' };
        const docIds = [...new Set(samples.map((chunk) => chunk.documentId))];
        meter.read('verification');
        const parents = await db.getAll(...docIds.map((id) => project.collection('memoryDocuments').doc(id)));
        const byId = new Map(parents.map((snap) => [snap.id, snap.data() as MemoryDocument | undefined]));
        const candidates: SceneMemoryCandidate[] = [];
        for (const chunk of samples) {
          const doc = byId.get(chunk.documentId);
          if (!doc) continue;
          const checked = await verifyAuthoritativeIndexedChunk(ownerId, projectId, chunk, doc, manifest, reader, sourceCache);
          if (!checked.ref || !checked.source) continue;
          candidates.push({ hit: graphHit(chunk, doc), source: { ...checked.source } });
        }
        await applyWriterMemoryKnowledge(db, reader, ownerId, projectId, candidates, requirements, () => meter.read('verification'));
        const viable = candidates.filter((candidate) => !graphEligibility(candidate, requirements));
        return { candidates: viable, issue: viable.length ? undefined : candidates.length ? graphEligibility(candidates[0], requirements) : 'STALE_LINK' };
      })();
      lookupCache.set(key, pending);
    }
    const result = await pending;
    verifiedRows.set(key, result);
    return result;
  };

  const load = async (node: NarrativeNode) => {
    const record = await readNode(node);
    if (!record || !isCanon(record)) return [];
    const key = narrativeNodeKey(node);
    const derived = deriveNarrativeEdges(ownerId, projectId, node, record);
    const value = verifiedRows.get(key);
    for (const { source } of value?.candidates ?? []) {
      const proof = source.durableKnowledge?.acquisition.find((grant) => grant.characterId === requirements.pointOfViewCharacterId);
      if (proof?.eventId && narrativeNodeKey({ type: 'TIMELINE_EVENT', id: proof.eventId }) !== key) {
        derived.push(derivedNarrativeEdge(ownerId, projectId, { type: 'TIMELINE_EVENT', id: proof.eventId }, node,
          proof.method === 'WITNESSED' ? 'WITNESSED' : 'LEARNED_FROM'));
      }
    }
    meter.read('discovery');
    const authored = await project.collection('narrativeMemoryLinks').where('nodeKeys', 'array-contains', key).limit(GRAPH_LIMITS.edgesPerNode + 1).get();
    const links = authored.docs.flatMap((row) => {
      const link = parseNarrativeLink(row.data(), row.id, ownerId, projectId);
      if (!link) { rejectGraph(diagnostics, 'CROSS_PROJECT_LINK'); return []; }
      stored.set(link.id, link);
      return [link];
    });
    // Reverse discovery is used only when there is room for a further exact-node lookup.
    if (node.type === 'TIMELINE_EVENT' && !links.length && meter.available('discovery') && input.canRetrieve()) {
      meter.read('discovery');
      const relations = await project.collection('relationships').where('effectiveEventId', '==', node.id).limit(3).get();
      for (const item of relations.docs) if (item.data().ownerId === ownerId && item.data().projectId === projectId && isCanon(item.data())) {
        derived.push(derivedNarrativeEdge(ownerId, projectId, node, { type: 'RELATIONSHIP', id: item.id }, 'CHANGES_RELATIONSHIP'));
      }
    }
    if (node.type === 'RELATIONSHIP' && !links.length && meter.available('discovery') && input.canRetrieve() &&
        safeMemoryId(record.sourceCharacterId) && safeMemoryId(record.targetCharacterId) && typeof record.isDirectional === 'boolean') {
      meter.read('discovery');
      const history = await project.collection('relationships').where('sourceCharacterId', '==', record.sourceCharacterId)
        .where('targetCharacterId', '==', record.targetCharacterId).where('isDirectional', '==', record.isDirectional).limit(4).get();
      for (const item of history.docs) if (item.id !== node.id && item.data().ownerId === ownerId && item.data().projectId === projectId && isCanon(item.data())) {
        derived.push(derivedNarrativeEdge(ownerId, projectId, node, { type: 'RELATIONSHIP', id: item.id }, 'RELATED_TO'));
      }
    }
    return [...links, ...derived.filter((edge) => narrativeNodeKey(edge.from) !== narrativeNodeKey(edge.to))];
  };

  const admittedAuthorities = new Map<string, SceneMemoryCandidate>();
  const chosen = new Map<string, SceneMemoryCandidate>();
  const linkProofs = new Map<string, [string, string]>();
  let reserveStateRead = false;
  try {
    const result = await walkNarrativeGraph({
      seeds: seedNodes, ownerId, projectId, diagnostics, load,
      canExpand: () => meter.remaining('discovery') > (reserveStateRead ? 1 : 0) && meter.available('verification'),
      admit: async (edge, neighbor) => {
        const a = await lookup(edge.from);
        if (!a.candidates.length) return a.issue ?? 'STALE_LINK';
        const b = await lookup(edge.to);
        if (!b.candidates.length) return b.issue ?? 'STALE_LINK';
        const persisted = stored.get(edge.id);
        const issue = persisted ? await admitStoredLink(persisted, a.candidates, b.candidates, reader)
          : await checkNarrativeLinkSemantics(edge, a.candidates[0].source, b.candidates[0].source, reader);
        if (!issue && !persisted) await classifyDerivedClue(edge, reader);
        if (!issue) {
          if (edge.state) reserveStateRead = true;
          const endpoints = persisted ? [a.candidates.find((item) => matchesNarrativeEvidence(persisted.evidence[0], item)),
            b.candidates.find((item) => matchesNarrativeEvidence(persisted.evidence[1], item))] : [a.candidates[0], b.candidates[0]];
          if (endpoints[0] && endpoints[1]) linkProofs.set(edge.id, [endpoints[0].hit.chunk.id, endpoints[1].hit.chunk.id]);
          for (const candidate of endpoints) if (candidate) admittedAuthorities.set(candidate.hit.chunk.id, candidate);
          const next = endpoints[narrativeNodeKey(neighbor) === narrativeNodeKey(edge.from) ? 0 : 1];
          if (next && !chosen.has(narrativeNodeKey(neighbor))) chosen.set(narrativeNodeKey(neighbor), next);
        }
        return issue;
      },
    });
    const paths = result.paths;
    const links = result.links;
    if (!links.length) return empty();
    const selected = [...paths.keys()].flatMap((key) => chosen.get(key) ? [chosen.get(key)!] : [])
      .filter((candidate) => !input.base.some((row) => row.hit.chunk.id === candidate.hit.chunk.id)).slice(0, input.limit);
    await classifyCharacterStates({ project, links, meter, reader, requirements, verifiedRows, diagnostics });
    const usedNodes = [...new Map(links.flatMap((edge) => [edge.from, edge.to]).map((node) => [narrativeNodeKey(node), node])).values()];
    const latestReader = makeSourceReader(db, ownerId, projectId, undefined, () => meter.read('verification'));
    const authored = links.filter((edge) => edge.status === 'AUTHOR_CONFIRMED');
    await latestReader.batch([...usedNodes.map((node) => scopedCollection(node.type) + '/' + node.id),
      ...authored.map((edge) => 'narrativeMemoryLinks/' + edge.id)]);
    for (const edge of authored) {
      const current = parseNarrativeLink(latestReader.records.get('narrativeMemoryLinks/' + edge.id)?.record, edge.id, ownerId, projectId);
      const prior = stored.get(edge.id);
      if (!current || !prior || current.status !== 'AUTHOR_CONFIRMED' || current.visibility !== 'SOURCE_KNOWLEDGE' ||
          current.version !== prior.version || current.operationId !== prior.operationId) {
        rejectGraph(diagnostics, 'STALE_LINK');
        diagnostics.status = 'SEARCH_FAILED';
        return empty();
      }
    }
    for (const node of usedNodes) {
      const stamp = await narrativeNodeFingerprint(reader, node);
      if (!stamp || stamp !== await narrativeNodeFingerprint(latestReader, node)) {
        rejectGraph(diagnostics, 'STALE_LINK');
        diagnostics.status = 'SEARCH_FAILED';
        return empty();
      }
    }
    diagnostics.newCandidates = selected.length;
    return { candidates: selected, paths, links, linkProofs, diagnostics, authorities: [...admittedAuthorities.values()] };
  } catch (error) {
    diagnostics.status = error instanceof GraphBudgetExceeded ? 'BUDGET_LIMITED' : 'SEARCH_FAILED';
    if (error instanceof GraphBudgetExceeded) rejectGraph(diagnostics, 'GRAPH_BUDGET_EXCEEDED');
    diagnostics.newCandidates = 0;
    return empty();
  }
}

async function classifyCharacterStates(context: {
  project: DocumentReference; links: NarrativeEdge[]; meter: ReturnType<typeof graphMeter>;
  reader: ReturnType<typeof makeSourceReader>; requirements: SceneMemoryRequirements; verifiedRows: Map<string, Lookup>;
  diagnostics: NarrativeGraphDiagnostics;
}) {
  const { project, links, meter, reader, requirements, verifiedRows, diagnostics } = context;
  const groups = new Map<string, NarrativeState>();
  for (const link of links) if (link.state) groups.set(link.state.characterId + ':' + link.state.axis, link.state);
  for (const [key, state] of [...groups].slice(0, 1)) {
    if (!meter.available('discovery')) return;
    meter.read('discovery');
    const recent = await project.collection('narrativeMemoryLinks').where('stateKey', '==', key).limit(GRAPH_LIMITS.stateRows + 1).get();
    const stories: { id: string; point?: number }[] = [];
    let complete = recent.size <= GRAPH_LIMITS.stateRows;
    for (const snap of recent.docs.slice(0, GRAPH_LIMITS.stateRows)) {
      const ownerId = links[0].ownerId, projectId = links[0].projectId;
      const row = parseNarrativeLink(snap.data(), snap.id, ownerId, projectId);
      if (!row) { complete = false; continue; }
      if (row.status !== 'AUTHOR_CONFIRMED') continue;
      const a = verifiedRows.get(narrativeNodeKey(row.from))?.candidates ?? [];
      const b = verifiedRows.get(narrativeNodeKey(row.to))?.candidates ?? [];
      if (row.visibility !== 'SOURCE_KNOWLEDGE' || !a.length || !b.length || await admitStoredLink(row, a, b, reader)) {
        complete = false;
        continue;
      }
      const source = b[0].source;
      const point = requirements.narrativeCutoff ? source.narrativeOrder :
        source.episodeNumber !== undefined ? source.episodeNumber * 10000 + (source.sceneNumber ?? 0) : undefined;
      stories.push({ id: row.to.id, point });
    }
    const cutoff = requirements.narrativeCutoff?.order ?? requirements.episodeNumber * 10000 + (requirements.sceneNumber ?? 0);
    const statuses = classifyStateTimeline([...new Map(stories.map((item) => [item.id, item])).values()], cutoff, complete);
    for (const [nodeId, status] of statuses) {
      (diagnostics.characterStates ??= []).push({ nodeId, ...state, status });
    }
  }
}

export function graphAuthoritiesStillActive(result: GraphResult, ownerId: string, projectId: string, manifest?: FirestoreRagManifestDoc) {
  return result.authorities.every(({ hit }) => generationStatus(ownerId, projectId, manifest, hit.chunk, hit.document) === 'ACTIVE');
}
