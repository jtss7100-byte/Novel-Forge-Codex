import { FieldPath, Timestamp, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import type { VoiceDecisionAudit, VoiceDecisionAuditPage, VoiceDecisionPage, VoiceDecisionSaveResult, VoiceDecisionScope } from '../types/voiceContinuityDecision';
import { isReviewableContinuityFinding, matchesVoiceDecision, normalizeDecisionCommand, prepareVoiceDecisionWrite, replayVoiceDecision, sameVoiceScope, VOICE_AUTHOR_DECISIONS, VOICE_DECISION_DIMENSIONS, VoiceDecisionError, voiceDecisionIdPattern, voiceOperationIdPattern } from '../utils/voiceContinuityDecisionLogic';
import { computeManuscriptContentHash } from '../utils/manuscriptIntegrity';
import { continuityRequest, reviewCharacterContinuity, VoiceRequestError } from './characterVoiceAnalyzer';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const hash = z.string().regex(/^sha256_[a-f0-9]{64}$/);
const recordId = z.string().regex(voiceDecisionIdPattern);
const operationId = z.string().regex(voiceOperationIdPattern);
const dimension = z.enum(VOICE_DECISION_DIMENSIONS);
const decision = z.enum(VOICE_AUTHOR_DECISIONS);
const date = z.preprocess((value) => value instanceof Timestamp ? value.toDate().toISOString() : value, z.iso.datetime());
const scopeSchema = z.object({ ownerId: id, projectId: id, characterId: id });
const recordSchema = scopeSchema.extend({
  id: recordId, beforeEpisodeId: id, beforeRevisionId: id, beforeContentHash: hash,
  afterEpisodeId: id, afterRevisionId: id, afterContentHash: hash,
  dimension, analysisVersion: id, analysisFingerprint: hash, decision, authorNote: z.string().max(1000),
  version: z.number().int().positive(), createdAt: date, updatedAt: date,
});
const auditSchema = scopeSchema.extend({
  id: operationId, decisionId: recordId, analysisFingerprint: hash, requestFingerprint: hash,
  previousDecision: decision.nullable(), previousNote: z.string().max(1000), reconfirmLegacy: z.boolean(), record: recordSchema,
});
const saveAnalysis = continuityRequest.shape.inputs.element.omit({ local: true });
export const saveVoiceDecisionRequest = z.object({
  projectId: id, characterId: id, inputs: z.array(saveAnalysis).min(2).max(12),
  command: z.object({
    decisionId: recordId, operationId, dimension, decision, expectedVersion: z.number().int().nonnegative(),
    authorNote: z.string().max(1000).default(''), reconfirmLegacy: z.boolean().optional(),
  }),
});
const exactIds = z.string().transform((value) => value.split(',')).pipe(z.array(recordId).min(1).max(20));
export const listVoiceDecisionQuery = z.object({
  projectId: id, characterId: id, after: z.union([recordId, operationId]).optional(),
  ids: exactIds.optional(), historyFor: recordId.optional(),
}).refine((query) => !(query.ids && (query.after || query.historyFor)) &&
  (!query.after || (query.historyFor ? voiceOperationIdPattern.test(query.after) : voiceDecisionIdPattern.test(query.after))));

const pageSize = 40;

function decisionPath(scope: VoiceDecisionScope) {
  return `users/${scope.ownerId}/projects/${scope.projectId}`;
}

async function assertScope(db: Firestore, scope: VoiceDecisionScope, tx?: Transaction) {
  if (!scopeSchema.safeParse(scope).success) throw new VoiceRequestError(400, '유효한 작품 및 인물 ID가 필요합니다.');
  const projectRef = db.doc(decisionPath(scope));
  const characterRef = projectRef.collection('characters').doc(scope.characterId);
  const [project, character] = await (tx ? tx.getAll(projectRef, characterRef) : db.getAll(projectRef, characterRef));
  const data = character.data();
  if (project.data()?.id !== scope.projectId || project.data()?.ownerId !== scope.ownerId ||
      data?.id !== scope.characterId || data?.ownerId !== scope.ownerId || data?.projectId !== scope.projectId) {
    throw new VoiceRequestError(403, '이 작품의 인물 판단 기록에 접근할 수 없습니다.');
  }
}

function parseRecord(data: unknown, scope: VoiceDecisionScope, docId: string) {
  const record = recordSchema.parse(data);
  if (!sameVoiceScope(scope, record) || record.id !== docId ||
      record.id !== `vcd_${record.analysisFingerprint.slice('sha256_'.length)}`) {
    throw new VoiceRequestError(403, '판단 기록의 소유자 또는 출처가 일치하지 않습니다.');
  }
  return record;
}

function parseAudit(data: unknown, scope: VoiceDecisionScope, docId: string): VoiceDecisionAudit {
  const audit = auditSchema.parse(data);
  if (!sameVoiceScope(scope, audit) || audit.id !== docId || audit.analysisFingerprint !== audit.record.analysisFingerprint) {
    throw new VoiceRequestError(403, '판단 이력의 소유자 또는 출처가 일치하지 않습니다.');
  }
  parseRecord(audit.record, scope, audit.decisionId);
  return audit;
}

export async function saveVoiceContinuityDecision(
  db: Firestore, ownerId: string, request: z.infer<typeof saveVoiceDecisionRequest>
): Promise<VoiceDecisionSaveResult> {
  const scope = { ownerId, projectId: request.projectId, characterId: request.characterId };
  if (!scopeSchema.safeParse(scope).success) throw new VoiceRequestError(400, '유효한 작품 및 인물 ID가 필요합니다.');
  const command = normalizeDecisionCommand(request.command);
  // The receipt binds the ordered request. For two Revisions of one
  // episode, selection order determines the direction of the comparison.
  const contextFingerprint = computeManuscriptContentHash(JSON.stringify(request.inputs.map((input) => [
    input.episodeId, input.revisionId, input.contentHash, input.sceneKind,
    Object.entries(input.assignments || {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  ])));
  const base = decisionPath(scope);
  const ref = db.collection(`${base}/voiceContinuityDecisions`).doc(command.decisionId);
  const receiptRef = db.collection(`${base}/voiceContinuityDecisionAudits`).doc(command.operationId);

  return db.runTransaction(async (tx) => {
    await assertScope(db, scope, tx);
    const receipt = await tx.get(receiptRef);
    if (receipt.exists) {
      const data = receipt.data();
      if (data?.characterId !== scope.characterId) throw new VoiceDecisionError('OPERATION_CONFLICT');
      const replay = replayVoiceDecision(scope, command, parseAudit(data, scope, receipt.id), contextFingerprint);
      if (replay) return replay;
    }

    const report = await reviewCharacterContinuity({
      projectId: scope.projectId, characterId: scope.characterId, inputs: request.inputs,
    }, ownerId, db, tx).catch((error: unknown) => {
      if (error instanceof VoiceRequestError && error.status === 404) throw new VoiceDecisionError('STALE_SOURCE');
      throw error;
    });
    const finding = report.findings.find((item) => item.decisionIdentity?.id === command.decisionId && item.dimension === command.dimension);
    if (!finding?.decisionIdentity || !isReviewableContinuityFinding(finding.status)) throw new VoiceDecisionError('STALE_SOURCE');

    const snapshot = await tx.get(ref);
    const current = snapshot.exists ? parseRecord(snapshot.data(), scope, snapshot.id) : null;
    const now = Timestamp.now();
    const { result, audit } = prepareVoiceDecisionWrite(finding.decisionIdentity, command, current, now.toDate().toISOString(), contextFingerprint);
    const writeRecord = {
      ...result.record, createdAt: current ? Timestamp.fromDate(new Date(current.createdAt)) : now, updatedAt: now,
    };
    tx.set(ref, writeRecord);
    tx.create(receiptRef, { ...audit, record: writeRecord });
    return result;
  });
}

export async function listVoiceContinuityDecisions(
  db: Firestore, ownerId: string, query: z.infer<typeof listVoiceDecisionQuery>
): Promise<VoiceDecisionPage | VoiceDecisionAuditPage> {
  const scope = { ownerId, projectId: query.projectId, characterId: query.characterId };
  await assertScope(db, scope);
  const base = decisionPath(scope);
  const decisions = db.collection(`${base}/voiceContinuityDecisions`);
  if (query.historyFor) {
    const selected = await decisions.doc(query.historyFor).get();
    if (!selected.exists) throw new VoiceRequestError(404, '판단 기록을 찾을 수 없습니다.');
    const current = parseRecord(selected.data(), scope, selected.id);
    let cursor = db.collection(`${base}/voiceContinuityDecisionAudits`).where('decisionId', '==', current.id).orderBy(FieldPath.documentId());
    if (query.after) cursor = cursor.startAfter(query.after);
    const result = await cursor.limit(pageSize + 1).get();
    const entries = result.docs.slice(0, pageSize).map((doc) => {
      const audit = parseAudit(doc.data(), scope, doc.id);
      if (!matchesVoiceDecision(audit.record, current)) throw new VoiceRequestError(403, '판단 이력이 현재 기록과 일치하지 않습니다.');
      return audit;
    });
    return { entries, next: result.size > pageSize ? result.docs[pageSize - 1].id : undefined };
  }
  if (query.ids) {
    const docs = await db.getAll(...[...new Set(query.ids)].map((value) => decisions.doc(value)));
    return { records: docs.filter((doc) => doc.exists).map((doc) => parseRecord(doc.data(), scope, doc.id)) };
  }
  let cursor = decisions.where('characterId', '==', scope.characterId).orderBy(FieldPath.documentId());
  if (query.after) cursor = cursor.startAfter(query.after);
  const result = await cursor.limit(pageSize + 1).get();
  return {
    records: result.docs.slice(0, pageSize).map((doc) => parseRecord(doc.data(), scope, doc.id)),
    next: result.size > pageSize ? result.docs[pageSize - 1].id : undefined,
  };
}
