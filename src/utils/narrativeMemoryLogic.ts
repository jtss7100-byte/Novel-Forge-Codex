import type { GraphPath, GraphRejection, NarrativeEdge, NarrativeGraphDiagnostics, NarrativeNode, NarrativeStateStatus } from '../types/narrativeMemory';

export const GRAPH_LIMITS = {
  seeds: 4, depth: 2, nodes: 12, edgesPerNode: 8, sceneDiscoveryReads: 6, runDiscoveryReads: 8,
  sceneVerificationReads: 24, runVerificationReads: 40, chunksPerNode: 8, stateRows: 8,
} as const;
export const narrativeNodeKey = (node: NarrativeNode) => node.type + ':' + node.id;
export const relationshipPairKey = (source: string, target: string, directional: boolean) =>
  (directional ? 'DIRECT:' + source + ':' + target : 'MUTUAL:' + [source, target].sort().join(':'));

export function classifyStateTimeline<T extends { id: string; point?: number }>(
  rows: readonly T[], cutoff: number, complete: boolean,
): Map<string, NarrativeStateStatus> {
  const statuses = new Map<string, NarrativeStateStatus>();
  const past = rows.filter((row) => row.point !== undefined && row.point < cutoff);
  const latest = Math.max(Number.NEGATIVE_INFINITY, ...past.map((row) => row.point!));
  const uncertain = !complete || rows.some((row) => row.point === undefined);
  for (const row of rows) {
    if (row.point === undefined) statuses.set(row.id, 'UNKNOWN');
    else if (row.point >= cutoff) statuses.set(row.id, 'FUTURE_PLANNED');
    else if (past.filter((other) => other.point === row.point).length > 1) statuses.set(row.id, 'CONFLICTED');
    else if (row.point < latest) statuses.set(row.id, 'HISTORICAL');
    else statuses.set(row.id, uncertain ? 'UNKNOWN' : 'CURRENT');
  }
  return statuses;
}

export function graphDiagnostics(): NarrativeGraphDiagnostics {
  return { status: 'NO_SEEDS', seeds: 0, visitedNodes: 0, visitedEdges: 0, depth: 0,
    discoveryReads: 0, verificationReads: 0, newCandidates: 0, verifiedLinks: 0, causalLinks: 0,
    relationshipLinks: 0, foreshadowingLinks: 0, rejected: {}, runDiscoveryReads: 0, runVerificationReads: 0 };
}

export function rejectGraph(diagnostics: NarrativeGraphDiagnostics, reason: GraphRejection) {
  diagnostics.rejected[reason] = (diagnostics.rejected[reason] ?? 0) + 1;
}

export function adjacentNarrativeNode(edge: NarrativeEdge, key: string) {
  if (narrativeNodeKey(edge.from) === key) return edge.to;
  if (narrativeNodeKey(edge.to) === key) return edge.from;
}

export async function walkNarrativeGraph(input: {
  seeds: NarrativeNode[]; ownerId: string; projectId: string; diagnostics: NarrativeGraphDiagnostics;
  load: (node: NarrativeNode) => Promise<NarrativeEdge[]>;
  admit: (edge: NarrativeEdge, node: NarrativeNode) => Promise<GraphRejection | undefined>;
  canExpand: () => boolean;
}) {
  const { diagnostics, seeds, load, admit } = input;
  const distinct = [...new Map(seeds.map((node) => [narrativeNodeKey(node), node])).values()].slice(0, GRAPH_LIMITS.seeds);
  const visited = new Set(distinct.map(narrativeNodeKey));
  const seenEdges = new Set<string>();
  const paths = new Map<string, GraphPath>();
  const links: NarrativeEdge[] = [];
  const queue = distinct.map((node) => ({ node, depth: 0, via: [] as NarrativeEdge[], ancestors: [narrativeNodeKey(node)] }));
  diagnostics.seeds = distinct.length;
  diagnostics.visitedNodes = visited.size;
  if (!queue.length) return { paths, links };
  diagnostics.status = 'NO_LINKS';
  for (const item of queue) {
    if (!input.canExpand()) { rejectGraph(diagnostics, 'GRAPH_BUDGET_EXCEEDED'); break; }
    if (item.depth === GRAPH_LIMITS.depth) continue;
    const key = narrativeNodeKey(item.node);
    const edges = await load(item.node);
    if (edges.length > GRAPH_LIMITS.edgesPerNode) rejectGraph(diagnostics, 'GRAPH_BUDGET_EXCEEDED');
    for (const edge of edges.slice(0, GRAPH_LIMITS.edgesPerNode)) {
      if (!input.canExpand() || visited.size >= GRAPH_LIMITS.nodes) { rejectGraph(diagnostics, 'GRAPH_BUDGET_EXCEEDED'); break; }
      const neighbor = adjacentNarrativeNode(edge, key);
      if (!neighbor) { rejectGraph(diagnostics, 'UNVERIFIED_LINK'); continue; }
      if (edge.ownerId !== input.ownerId || edge.projectId !== input.projectId) {
        rejectGraph(diagnostics, 'CROSS_PROJECT_LINK');
        continue;
      }
      const next = narrativeNodeKey(neighbor);
      if (item.ancestors.includes(next)) { rejectGraph(diagnostics, 'CYCLIC_PATH'); continue; }
      if (seenEdges.has(edge.id)) { rejectGraph(diagnostics, 'DUPLICATE_NODE'); continue; }
      seenEdges.add(edge.id);
      diagnostics.visitedEdges++;
      if ((edge.status !== 'AUTHOR_CONFIRMED' && edge.status !== 'EXPLICITLY_VERIFIED') || edge.visibility !== 'SOURCE_KNOWLEDGE') {
        rejectGraph(diagnostics, edge.relation === 'CAUSES' ? 'CAUSAL_EVIDENCE_MISSING' : 'UNVERIFIED_LINK');
        continue;
      }
      if (edge.relation === 'CAUSES' && edge.status !== 'AUTHOR_CONFIRMED') {
        rejectGraph(diagnostics, 'CAUSAL_EVIDENCE_MISSING');
        continue;
      }
      const excluded = await admit(edge, neighbor);
      if (excluded) { rejectGraph(diagnostics, excluded); continue; }
      links.push(edge);
      diagnostics.verifiedLinks++;
      if (edge.relation === 'CAUSES') diagnostics.causalLinks++;
      if (edge.relation === 'CHANGES_RELATIONSHIP') diagnostics.relationshipLinks++;
      if (edge.from.type === 'FORESHADOWING' || edge.to.type === 'FORESHADOWING') diagnostics.foreshadowingLinks++;
      if (visited.has(next)) { rejectGraph(diagnostics, 'DUPLICATE_NODE'); continue; }
      const nextPath = { depth: item.depth + 1, via: [...item.via, edge] };
      paths.set(next, nextPath);
      visited.add(next);
      diagnostics.visitedNodes = visited.size;
      diagnostics.depth = Math.max(diagnostics.depth, nextPath.depth);
      if (nextPath.depth < GRAPH_LIMITS.depth) queue.push({ node: neighbor, ...nextPath, ancestors: [...item.ancestors, next] });
      else rejectGraph(diagnostics, 'GRAPH_DEPTH_EXCEEDED');
    }
  }
  diagnostics.status = diagnostics.rejected.GRAPH_BUDGET_EXCEEDED ? 'BUDGET_LIMITED' : links.length ? 'EXPANDED' : 'NO_LINKS';
  return { paths, links };
}
