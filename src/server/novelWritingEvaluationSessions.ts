import { randomUUID } from 'node:crypto';
import type { CollectionReference, DocumentReference, DocumentSnapshot, Firestore, Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import { EVALUATION_DIMENSIONS, EVALUATION_INTEGRITY_CODES, EVALUATION_SESSION_STATUSES, type EvaluationCase, type EvaluationSessionHeader, type EvaluationSessionStatus, type EvaluationSettings } from '../types/novelWritingEvaluation';
import { EVALUATION_DATASET_VERSION } from '../utils/novelWritingEvaluationBenchmark';
import { evaluationFingerprint, type HiddenEvaluationPair } from '../utils/novelWritingEvaluationLogic';
import { assertEvaluationLiveBudget, evaluationModelSettings, evaluationOperationId, evaluationReviewInput, evaluationRunInput, EvaluationRequestError, getEvaluationSettings, plannedEvaluationCalls, revealEvaluationReport, runWritingEvaluation, validateEvaluationRatings, type EvaluationModelCall, type EvaluationRunJournal, type EvaluationRunReport } from './novelWritingEvaluationRunner';

const leaseMs = 120_000;
const id = z.string().min(1).max(128).regex(/^[^/]+$/);
const hash = z.string().regex(/^sha256_[a-f0-9]{64}$/);
const date = z.iso.datetime();
const telemetry = z.object({
  plannedCalls: z.number().int().nonnegative(), actualCalls: z.number().int().nonnegative(),
  generationCalls: z.number().int().nonnegative(), qualityCalls: z.number().int().nonnegative(),
  measuredTokens: z.number().nonnegative(), callsWithoutUsage: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative().nullable(), latencyMs: z.number().nonnegative(), pricingReference: z.url().optional(),
});
const sessionSchema = z.strictObject({
  schemaVersion: z.literal(1), ownerId: id, operationId: evaluationOperationId, fingerprint: hash,
  settings: evaluationRunInput, datasetVersion: id, modelId: z.string().min(1).max(120),
  modelSettings: z.object({ temperature: z.number(), topP: z.number(), maxOutputTokens: z.number().int().positive() }),
  status: z.enum(EVALUATION_SESSION_STATUSES), version: z.number().int().positive(), seed: evaluationOperationId,
  claim: z.object({ token: evaluationOperationId, expiresAt: z.number().int() }).nullable(),
  pendingCall: z.number().int().positive().nullable(), uncertain: z.boolean(), cancelRequested: z.boolean(),
  telemetry, createdAt: date, updatedAt: date, completedAt: date.nullable(), reason: z.string().nullable(),
  ratings: evaluationReviewInput.shape.ratings,
});
type Session = z.infer<typeof sessionSchema>;
type ReviewCommand = z.infer<typeof evaluationReviewInput>;

const trace = z.object({
  profileId: id, versionId: id, contentHash: hash, projectId: id, targetCharacterId: id.optional(),
  active: z.literal(true), approval: z.literal('APPROVED_SYNTHETIC_FIXTURE'),
});
const score = z.number().min(0).max(100).nullable();
const adherence = z.object({
  score, confidence: z.enum(['LOW', 'MEDIUM']), status: z.enum(['FIXTURE', 'HEURISTIC', 'INSUFFICIENT_EVIDENCE']),
  rubricVersion: z.string(), targets: z.array(trace), evidence: z.array(z.object({
    criterion: z.string(), matched: z.number().int().nonnegative(), observed: z.number().int().nonnegative(), characterId: id.optional(),
  })),
});
const candidate = z.object({
  status: z.string(), issues: z.array(z.enum(EVALUATION_INTEGRITY_CODES)), chars: z.number().int().nonnegative(),
  scores: z.partialRecord(z.enum(EVALUATION_DIMENSIONS), score), qualityStatus: z.enum(['NOT_EVALUATED', 'FIXTURE', 'AI_AUXILIARY', 'FAILED']),
  style: z.array(trace), voice: z.array(trace), promptHash: hash.optional(), observedModelVersion: z.string().optional(),
  qualityFailure: z.string().optional(), observedQualityModelVersion: z.string().optional(),
  authorStyleAdherence: adherence.optional(), characterVoiceAdherence: adherence.optional(),
});
const scenarioId = evaluationRunInput.shape.scenarios.element;
const maxCandidateLength = 50_000;
const caseId = z.string().regex(/^NW(?:[1-9]|1[0-2])-[1-4]$/);
const caseSchema = z.strictObject({
  caseId, scenarioId, repeat: z.number().int().min(1).max(4),
  manifest: z.object({
    modelId: z.string(), datasetVersion: id,
    writingPlanFingerprint: hash, canonFingerprint: hash, ragFingerprint: hash,
    controlsFingerprint: hash, qualityCriteriaFingerprint: hash, qualityRubricVersion: z.string(),
    perspective: z.enum(['FIRST_PERSON', 'THIRD_LIMITED', 'OMNISCIENT', 'MIXED']), characters: z.array(id),
    targetLength: z.number().int().positive(),
  }),
  baseline: candidate, treatment: candidate, comparable: z.boolean(), exclusionReasons: z.array(z.string()),
  lengthDifferencePercent: z.number().nonnegative().nullable(),
  baselineText: z.string().max(maxCandidateLength).optional(), treatmentText: z.string().max(maxCandidateLength).optional(),
});
const pairSchema = z.strictObject({
  caseId, assignment: z.enum(['A_ORIGINAL_B_REWRITE', 'A_REWRITE_B_ORIGINAL']),
  pair: z.object({
    pairId: z.string().regex(/^blind_[a-f0-9]{24}$/), scenarioId, title: z.string(), goal: z.string(),
    optionA: z.string().max(maxCandidateLength), optionB: z.string().max(maxCandidateLength),
  }),
});
const checkpointSchema = z.strictObject({ entry: caseSchema, pair: pairSchema.nullable() });
const reviewReceipt = z.strictObject({ fingerprint: hash, version: z.number().int().positive() });
const transitions: Record<EvaluationSessionStatus, readonly EvaluationSessionStatus[]> = {
  CREATED: ['RUNNING', 'CANCELLED', 'FAILED'],
  RUNNING: ['AWAITING_HUMAN_REVIEW', 'CANCELLED', 'INTERRUPTED', 'FAILED'],
  AWAITING_HUMAN_REVIEW: ['FINALIZED'], CANCELLED: ['FINALIZED'], INTERRUPTED: ['FINALIZED'],
  FAILED: ['FINALIZED'], FINALIZED: [],
};

export const canTransitionEvaluation = (from: EvaluationSessionStatus, to: EvaluationSessionStatus) => transitions[from].includes(to);

export function recoverEvaluationExecution(session: Pick<Session, 'status' | 'claim' | 'pendingCall' | 'uncertain'>, now: number) {
  if (session.status !== 'RUNNING' || !session.claim || session.claim.expiresAt > now) return undefined;
  return session.pendingCall !== null || session.uncertain ? 'REMOTE_CALL_OUTCOME_UNKNOWN' : 'EXECUTION_INTERRUPTED';
}

export function resolveEvaluationReviewVersion(version: number, state: EvaluationSessionStatus, expected: number) {
  if (version !== expected) throw new EvaluationRequestError(409, 'VERSION_CONFLICT');
  if (!canTransitionEvaluation(state, 'FINALIZED')) {
    throw new EvaluationRequestError(409, state === 'FINALIZED' ? 'EVALUATION_REVIEW_FINALIZED' : 'EVALUATION_NOT_READY');
  }
}

function clean<T extends object>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readSession(snapshot: DocumentSnapshot, ownerId: string): Session {
  if (!snapshot.exists) throw new EvaluationRequestError(404, 'EVALUATION_SESSION_NOT_FOUND');
  const record = sessionSchema.parse(snapshot.data());
  if (record.ownerId !== ownerId || record.operationId !== snapshot.id || record.settings.operationId !== snapshot.id ||
      record.fingerprint !== evaluationFingerprint(record.settings) ||
      (record.status === 'RUNNING') !== Boolean(record.claim) || (record.pendingCall !== null && record.status !== 'RUNNING')) {
    throw new EvaluationRequestError(403, 'EVALUATION_SESSION_SCOPE_MISMATCH');
  }
  return record;
}

function parseCheckpoint(raw: unknown) {
  return checkpointSchema.parse(raw);
}

function header(current: Session): EvaluationSessionHeader {
  return {
    operationId: current.operationId, status: current.status, version: current.version,
    datasetVersion: current.datasetVersion, modelId: current.modelId, mode: current.settings.mode,
    treatment: current.settings.treatment, createdAt: current.createdAt, updatedAt: current.updatedAt,
    completedAt: current.completedAt ?? undefined, reason: current.reason ?? undefined,
    humanRatingStatus: current.ratings.some((rating) => rating.choice !== 'DEFER' ||
      Object.values(rating.dimensions ?? {}).some((choice) => choice !== 'DEFER'))
      ? current.status === 'FINALIZED' ? 'RATED' : 'DRAFT' : 'NOT_RATED',
  };
}

export function projectEvaluationSession(current: Session, records: { entry: EvaluationCase; pair: HiddenEvaluationPair | null }[]) {
  const pairs = records.flatMap((record) => record.pair ? [record.pair] : []);
  const interrupted = current.status === 'INTERRUPTED' || current.status === 'CANCELLED' || Boolean(current.reason);
  const total = current.settings.repeats * current.settings.scenarios.length;
  const reviewable = canTransitionEvaluation(current.status, 'FINALIZED');
  const finalized = current.status === 'FINALIZED';
  const report: EvaluationRunReport = {
    mode: current.settings.mode, treatment: current.settings.treatment, cases: records.map(({ entry }) => entry),
    pairs, telemetry: current.telemetry, interrupted, remoteOutcomeUnknown: current.uncertain,
    draftState: 'EVALUATION_DRAFT', canonState: 'NOT_CANON', persistence: 'NOT_COMMITTED',
  };
  const final = finalized ? revealEvaluationReport(report, current.ratings) : undefined;
  return {
    ...header(current), pairs: reviewable || finalized ? pairs.map(({ pair }) => pair) : [],
    interrupted, total, excluded: reviewable || finalized ? total - pairs.length : 0,
    completedCases: records.filter(({ entry }) => !entry.exclusionReasons.includes('INCOMPLETE_CASE')).length,
    reviewDraft: reviewable ? current.ratings : [],
    report: final ? { ...final, summary: { ...final.summary, total, excluded: total - pairs.length } } : undefined,
  };
}

export type DurableEvaluationDetail = ReturnType<typeof projectEvaluationSession>;
const controllers = new Map<string, AbortController>();

export class NovelWritingEvaluationSessions {
  constructor(private readonly db: Firestore, private readonly now = Date.now, private readonly provider?: EvaluationModelCall) {}

  private collection(ownerId: string): CollectionReference {
    return this.db.collection(`users/${id.parse(ownerId)}/novelWritingEvaluations`);
  }

  private ref(ownerId: string, operationId: string) {
    return this.collection(ownerId).doc(evaluationOperationId.parse(operationId));
  }

  private change(tx: Transaction, ref: DocumentReference, current: Session, patch: Partial<Session>, action: string): Session {
    if (patch.status && !canTransitionEvaluation(current.status, patch.status)) {
      throw new EvaluationRequestError(409, 'INVALID_EVALUATION_TRANSITION');
    }
    const next = sessionSchema.parse({ ...current, ...patch, version: current.version + 1, updatedAt: new Date(this.now()).toISOString() });
    tx.set(ref, clean(next));
    tx.create(ref.collection('events').doc(`version_${next.version}`), {
      version: next.version, ownerId: current.ownerId, from: current.status, to: next.status, action, at: next.updatedAt,
    });
    return next;
  }

  private recover(tx: Transaction, ref: DocumentReference, current: Session) {
    const reason = recoverEvaluationExecution(current, this.now());
    if (!reason) return current;
    const unknown = reason === 'REMOTE_CALL_OUTCOME_UNKNOWN';
    return this.change(tx, ref, current, {
      status: 'INTERRUPTED', reason, claim: null, pendingCall: null,
      completedAt: new Date(this.now()).toISOString(), uncertain: unknown,
      telemetry: current.pendingCall === null ? current.telemetry : {
        ...current.telemetry, callsWithoutUsage: current.telemetry.callsWithoutUsage + 1, estimatedCostUsd: null,
      },
    }, 'RECOVER_EXPIRED_CLAIM');
  }

  private async records(ref: DocumentReference, current: Session, tx?: Transaction) {
    const query = ref.collection('cases').limit(49);
    const snapshot = await (tx ? tx.get(query) : query.get());
    if (snapshot.size > 48) throw new Error('EVALUATION_CASE_LIMIT');
    return snapshot.docs.map((document) => {
      const record = parseCheckpoint(document.data());
      const { entry, pair } = record;
      if (entry.caseId !== document.id || entry.caseId !== `${entry.scenarioId}-${entry.repeat}` ||
          entry.repeat > current.settings.repeats || !current.settings.scenarios.includes(entry.scenarioId) ||
          entry.manifest.modelId !== current.modelId || entry.manifest.datasetVersion !== current.datasetVersion ||
          Boolean(pair) !== entry.comparable ||
          (pair && (pair.caseId !== document.id || pair.pair.scenarioId !== entry.scenarioId))) throw new Error('EVALUATION_CASE_SCOPE_MISMATCH');
      if (pair) {
        const aIsBaseline = pair.assignment === 'A_ORIGINAL_B_REWRITE';
        if (pair.pair.optionA !== (aIsBaseline ? entry.baselineText : entry.treatmentText) ||
            pair.pair.optionB !== (aIsBaseline ? entry.treatmentText : entry.baselineText)) throw new Error('EVALUATION_PAIR_SCOPE_MISMATCH');
      }
      return record;
    }).sort((a, b) => current.settings.scenarios.indexOf(a.entry.scenarioId) - current.settings.scenarios.indexOf(b.entry.scenarioId) ||
      a.entry.repeat - b.entry.repeat);
  }

  async get(ownerId: string, operationId: string): Promise<DurableEvaluationDetail> {
    const ref = this.ref(ownerId, operationId);
    return this.db.runTransaction(async (tx) => {
      const current = readSession(await tx.get(ref), ownerId);
      const records = await this.records(ref, current, tx);
      return projectEvaluationSession(this.recover(tx, ref, current), records);
    });
  }

  async list(ownerId: string, after?: string) {
    let query = this.collection(ownerId).orderBy('createdAt', 'desc');
    if (after) {
      const cursor = await this.ref(ownerId, after).get();
      readSession(cursor, ownerId);
      query = query.startAfter(cursor);
    }
    const snapshot = await query.limit(21).get();
    const entries = await Promise.all(snapshot.docs.slice(0, 20).map(async (document) => {
      const current = readSession(document, ownerId);
      if (!recoverEvaluationExecution(current, this.now())) return header(current);
      return this.db.runTransaction(async (tx) => header(this.recover(tx, document.ref, readSession(await tx.get(document.ref), ownerId))));
    }));
    return { entries, next: snapshot.size > 20 ? snapshot.docs[19].id : undefined };
  }

  async start(ownerId: string, input: EvaluationSettings): Promise<DurableEvaluationDetail> {
    const settings = evaluationRunInput.parse(input);
    const ref = this.ref(ownerId, settings.operationId);
    const fingerprint = evaluationFingerprint(settings);
    const seed = randomUUID();
    await this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.exists) {
        if (readSession(snapshot, ownerId).fingerprint !== fingerprint) throw new EvaluationRequestError(409, 'EVALUATION_OPERATION_CONFLICT');
        return;
      }
      assertEvaluationLiveBudget(settings, true);
      const createdAt = new Date(this.now()).toISOString();
      const plannedCalls = settings.mode === 'LIVE_GEMINI' ? plannedEvaluationCalls(settings.scenarios.length, settings.repeats) : 0;
      const model = getEvaluationSettings(true);
      const current = sessionSchema.parse({
        schemaVersion: 1, ownerId, operationId: settings.operationId, fingerprint, settings, seed, datasetVersion: model.datasetVersion,
        modelId: model.modelId, modelSettings: evaluationModelSettings, status: 'CREATED', version: 1, claim: null,
        uncertain: false, pendingCall: null, cancelRequested: false, ratings: [], reason: null, createdAt, updatedAt: createdAt, completedAt: null,
        telemetry: { plannedCalls, actualCalls: 0, generationCalls: 0, qualityCalls: 0, measuredTokens: 0, callsWithoutUsage: 0,
          estimatedCostUsd: settings.mode === 'LIVE_GEMINI' ? null : 0, latencyMs: 0 },
      });
      tx.create(ref, clean(current));
      tx.create(ref.collection('events').doc('version_1'), { ownerId, version: 1, to: 'CREATED', action: 'CREATE', at: createdAt });
    });

    const token = randomUUID();
    const claimed = await this.db.runTransaction(async (tx) => {
      const current = this.recover(tx, ref, readSession(await tx.get(ref), ownerId));
      if (current.status !== 'CREATED') return undefined;
      if (current.datasetVersion !== EVALUATION_DATASET_VERSION ||
          evaluationFingerprint(current.modelSettings) !== evaluationFingerprint(evaluationModelSettings)) {
        this.change(tx, ref, current, { status: 'FAILED', reason: 'EVALUATION_CONDITIONS_UNAVAILABLE', completedAt: new Date(this.now()).toISOString() }, 'CONDITIONS_UNAVAILABLE');
        return undefined;
      }
      assertEvaluationLiveBudget(current.settings, true);
      return this.change(tx, ref, current, { status: 'RUNNING', claim: { token, expiresAt: this.now() + leaseMs } }, 'CLAIM');
    });
    if (!claimed) return this.get(ownerId, settings.operationId);

    const controller = new AbortController();
    controllers.set(ref.path, controller);
    try {
      const report = await runWritingEvaluation(claimed.settings, {
        authenticated: true, signal: controller.signal, seed: claimed.seed, modelId: claimed.modelId,
        provider: this.provider, journal: this.journal(ref, ownerId, token, controller),
      });
      await this.complete(ref, ownerId, token, report);
    } catch {
      await this.complete(ref, ownerId, token);
    } finally {
      if (controllers.get(ref.path) === controller) controllers.delete(ref.path);
    }
    return this.get(ownerId, settings.operationId);
  }

  private journal(ref: DocumentReference, ownerId: string, token: string, controller: AbortController): EvaluationRunJournal {
    const update = (job: (tx: Transaction, current: Session) => void) => this.db.runTransaction(async (tx) => {
      const current = readSession(await tx.get(ref), ownerId);
      if (current.claim?.token !== token || current.claim.expiresAt <= this.now()) throw new Error('EXECUTION_CLAIM_LOST');
      if (current.cancelRequested) controller.abort();
      job(tx, current);
    });
    const renewed = () => ({ token, expiresAt: this.now() + leaseMs });
    const time = () => new Date(this.now()).toISOString();
    return {
      beforeCall: (kind, number) => update((tx, current) => {
        if (current.cancelRequested) throw new Error('ABORTED_BY_USER');
        assertEvaluationLiveBudget(current.settings, true);
        if (current.settings.mode !== 'LIVE_GEMINI' || !current.settings.optIn || current.uncertain ||
            current.pendingCall !== null || current.telemetry.actualCalls + 1 !== number ||
            number > current.telemetry.plannedCalls || number > (current.settings.callBudget ?? 0)) {
          throw new Error('CALL_BUDGET_EXCEEDED_OR_RESERVED');
        }
        tx.update(ref, { pendingCall: number, claim: renewed(), updatedAt: time(), telemetry: {
          ...current.telemetry, actualCalls: number,
          generationCalls: current.telemetry.generationCalls + Number(kind === 'generation'),
          qualityCalls: current.telemetry.qualityCalls + Number(kind === 'quality'),
        } });
        tx.create(ref.collection('events').doc(`call_${number}_reserved`), { ownerId, number, kind, outcome: 'RESERVED', at: time() });
      }),
      afterCall: (number, outcome, usage) => update((tx, current) => {
        if (current.pendingCall !== number || usage.actualCalls !== number) throw new Error('CALL_RESERVATION_MISMATCH');
        tx.update(ref, { pendingCall: null, uncertain: outcome === 'UNKNOWN', claim: renewed(), updatedAt: time(), telemetry: clean(usage) });
        tx.create(ref.collection('events').doc(`call_${number}_outcome`), { ownerId, number, outcome, at: time(), telemetry: clean(usage) });
      }),
      checkpoint: (entry, pair, usage) => update((tx, current) => {
        const data = parseCheckpoint({ entry, pair: pair ?? null });
        if (current.pendingCall !== null || usage.actualCalls !== current.telemetry.actualCalls) throw new Error('CALL_RESERVATION_UNRESOLVED');
        tx.set(ref.collection('cases').doc(entry.caseId), clean(data));
        tx.update(ref, { claim: renewed(), updatedAt: time(), telemetry: clean(usage) });
      }),
    };
  }

  private async complete(ref: DocumentReference, ownerId: string, token: string, report?: EvaluationRunReport) {
    await this.db.runTransaction(async (tx) => {
      const current = readSession(await tx.get(ref), ownerId);
      if (current.claim?.token !== token) return;
      const uncertain = current.pendingCall !== null || current.uncertain || Boolean(report?.remoteOutcomeUnknown);
      const reason = uncertain ? 'REMOTE_CALL_OUTCOME_UNKNOWN' :
        current.cancelRequested ? 'CANCELLED_BY_AUTHOR' : !report ? 'EXECUTION_FAILED' : report.interrupted ? 'EXECUTION_INTERRUPTED' : null;
      const status = uncertain ? 'INTERRUPTED' : current.cancelRequested ? 'CANCELLED' : !report ? 'FAILED' :
        report.interrupted ? 'INTERRUPTED' : 'AWAITING_HUMAN_REVIEW';
      this.change(tx, ref, current, {
        status, reason, uncertain, claim: null, pendingCall: null, completedAt: new Date(this.now()).toISOString(),
        telemetry: current.pendingCall === null ? current.telemetry : {
          ...current.telemetry, callsWithoutUsage: current.telemetry.callsWithoutUsage + 1, estimatedCostUsd: null,
        },
      }, 'COMPLETE_EXECUTION');
    });
  }

  async cancel(ownerId: string, operationId: string) {
    const ref = this.ref(ownerId, operationId);
    const stopping = await this.db.runTransaction(async (tx) => {
      const current = this.recover(tx, ref, readSession(await tx.get(ref), ownerId));
      if (current.status === 'CREATED') {
        this.change(tx, ref, current, { status: 'CANCELLED', reason: 'CANCELLED_BY_AUTHOR', completedAt: new Date(this.now()).toISOString() }, 'CANCEL');
      }
      if (current.status !== 'RUNNING') return false;
      if (!current.cancelRequested) this.change(tx, ref, current, { cancelRequested: true }, 'REQUEST_CANCEL');
      return true;
    });
    if (stopping) controllers.get(ref.path)?.abort();
    return { stopping };
  }

  async review(ownerId: string, request: ReviewCommand) {
    const { operationId, expectedVersion, reviewOperationId } = request;
    if (expectedVersion === undefined || !reviewOperationId) throw new EvaluationRequestError(400, 'REVIEW_VERSION_AND_OPERATION_REQUIRED');
    const ref = this.ref(ownerId, operationId);
    const receipt = ref.collection('reviews').doc(reviewOperationId);
    const fingerprint = evaluationFingerprint({ ...request, ratings: [...request.ratings].sort((a, b) => a.pairId.localeCompare(b.pairId)) });
    const reviewVersion = await this.db.runTransaction(async (tx) => {
      const [snapshot, previous] = await tx.getAll(ref, receipt);
      const current = readSession(snapshot, ownerId);
      if (previous.exists) {
        const saved = reviewReceipt.parse(previous.data());
        if (saved.fingerprint !== fingerprint) throw new EvaluationRequestError(409, 'EVALUATION_OPERATION_CONFLICT');
        return saved.version;
      }
      resolveEvaluationReviewVersion(current.version, current.status, expectedVersion);
      const records = await this.records(ref, current, tx);
      const ratings = validateEvaluationRatings(records.flatMap(({ pair }) => pair ? [pair] : []), request.ratings);
      const next = this.change(tx, ref, current, { ratings, ...(request.finalize ? { status: 'FINALIZED' as const } : {}) },
        request.finalize ? 'FINALIZE_REVIEW' : 'SAVE_REVIEW_DRAFT');
      tx.create(receipt, { fingerprint, version: next.version });
      tx.create(ref.collection('events').doc(`review_${next.version}`), {
        ownerId, version: next.version, previousRatings: clean(current.ratings), ratings: clean(ratings),
        finalized: request.finalize, updatedAt: next.updatedAt,
      });
      return next.version;
    });
    return { ...await this.get(ownerId, operationId), reviewVersion };
  }
}
