import { FieldPath, type Firestore, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { classifyStateTimeline, relationshipPairKey } from '../utils/narrativeMemoryLogic';
import { safeMemoryId, type SceneMemoryCandidate } from '../utils/sceneMemoryLogic';
import type { SceneMemoryRequirements } from '../types/sceneMemory';
import type { NarrativeStateStatus } from '../types/narrativeMemory';
import { episodePosition, isCanon, type makeSourceReader } from './memorySourceAuthority';
import { graphEligibility } from './narrativeMemoryGraph';

const BATCH = 8;
const MAX_SCENE_QUERIES = 6;
const MAX_RUN_QUERIES = 12;

export function relationshipHistoryReader(db: Firestore, ownerId: string, projectId: string) {
  let runQueries = 0;
  return async (candidates: SceneMemoryCandidate[], reader: ReturnType<typeof makeSourceReader>, target: SceneMemoryRequirements) => {
    let sceneQueries = 0;
    const collection = db.collection(reader.base + '/relationships');
    const rows = candidates.filter(({ hit }) => hit.chunk.sourceEntityType === 'RELATIONSHIP');
    const groups = new Map<string, { pair: [string, string]; directional: boolean; candidates: SceneMemoryCandidate[] }>();
    for (const candidate of rows) {
      const record = await reader.entity('relationships', candidate.source.id);
      if (!record || !safeMemoryId(record.sourceCharacterId) || !safeMemoryId(record.targetCharacterId) || typeof record.isDirectional !== 'boolean') continue;
      const pair: [string, string] = [record.sourceCharacterId, record.targetCharacterId];
      const key = relationshipPairKey(...pair, record.isDirectional);
      const group = groups.get(key) ?? { pair, directional: record.isDirectional, candidates: [] };
      group.candidates.push(candidate);
      groups.set(key, group);
    }
    const result: { nodeId: string; status: NarrativeStateStatus }[] = [];
    for (const group of groups.values()) {
      const readDirection = async (first: string, second: string) => {
        const related: QueryDocumentSnapshot[] = [];
        const query = collection.where('sourceCharacterId', '==', first).where('targetCharacterId', '==', second)
          .where('isDirectional', '==', group.directional).orderBy(FieldPath.documentId());
        let cursor: QueryDocumentSnapshot | undefined;
        for (let pass = 0; pass < 2 && sceneQueries < MAX_SCENE_QUERIES && runQueries < MAX_RUN_QUERIES; pass++) {
          sceneQueries++; runQueries++;
          const request = cursor ? query.startAfter(cursor) : query;
          const page = await request.limit(BATCH + 1).get();
          related.push(...page.docs.slice(0, BATCH));
          if (page.size <= BATCH) return { related, complete: true };
          cursor = page.docs[BATCH - 1];
        }
        return { related, complete: false };
      };
      const [a, b] = group.pair;
      const left = await readDirection(a, b);
      const right = group.directional || a === b ? { related: [], complete: true } : await readDirection(b, a);
      let complete = left.complete && right.complete;
      const known = new Map(group.candidates.filter((candidate) => !graphEligibility(candidate, target))
        .map((candidate) => [candidate.source.id, candidate.source]));
      const timeline = [];
      for (const doc of [...left.related, ...right.related]) {
        const record = doc.data();
        if (record.id !== doc.id || record.ownerId !== ownerId || record.projectId !== projectId || !isCanon(record)) continue;
        const item = known.get(doc.id);
        // Indexed relationships hidden from this POV cannot prove the currently usable state.
        if (!item) { complete = false; continue; }
        const point = target.narrativeCutoff ? item.narrativeOrder :
          episodePosition(item.episodeNumber) !== undefined ? item.episodeNumber! * 10000 + (item.sceneNumber ?? 0) : undefined;
        timeline.push({ id: item.id, point });
      }
      const cutoff = target.narrativeCutoff?.order ?? target.episodeNumber * 10000 + (target.sceneNumber ?? 0);
      const statuses = classifyStateTimeline(timeline, cutoff, complete);
      for (const candidate of group.candidates) {
        const state = statuses.get(candidate.source.id) ?? (graphEligibility(candidate, target) === 'FUTURE_EVENT' ? 'FUTURE_PLANNED' : 'UNKNOWN');
        // The source's Stage 1.1 approval may describe an opinion. Only a complete, unambiguous history establishes a current relationship.
        candidate.source.currentState = state === 'CURRENT';
        candidate.source.historicalState = state === 'HISTORICAL';
        if (!result.some((row) => row.nodeId === candidate.source.id)) result.push({ nodeId: candidate.source.id, status: state });
      }
    }
    return result;
  };
}
