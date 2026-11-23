import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContinuityFinding } from '../types/styleContinuity';
import type { VoiceDecisionCommand } from '../types/voiceContinuityDecision';
import { clearVoiceDecisionDraft, commitLocalVoiceDecision, legacyMatchesSources, listLegacyVoiceDecisions, listLocalVoiceAudits, listLocalVoiceDecisions, readVoiceDecisionDraft, writeVoiceDecisionDraft } from '../services/voiceContinuityLocal';
import { computeManuscriptContentHash } from './manuscriptIntegrity';
import { buildVoiceContinuityFingerprint, continuityEvidenceHash, isReviewableContinuityFinding, matchesVoiceDecision, prepareVoiceDecisionWrite, selectVoiceDecisionOperation, type VerifiedContinuitySampleIdentity } from './voiceContinuityDecisionLogic';

const scope = { ownerId: 'owner', projectId: 'project', characterId: 'character' };
const before: VerifiedContinuitySampleIdentity = {
  episodeId: 'ep1', episodeNumber: 1, revisionId: 'rev1', latestRevisionId: 'rev1',
  contentHash: computeManuscriptContentHash('첫 회차'), sceneKind: 'DAILY',
  speakerFingerprint: continuityEvidenceHash([['speaker1', 'character']]),
  relationshipFingerprint: continuityEvidenceHash([]), characterIds: ['character', 'other'],
};
const after = { ...before, episodeId: 'ep2', episodeNumber: 2, revisionId: 'rev2', latestRevisionId: 'rev2', contentHash: computeManuscriptContentHash('둘째 회차') };
const finding = { dimension: 'VOICE', status: 'POTENTIAL_DRIFT', confidence: 'MEDIUM', description: '말투 변화' } satisfies Pick<ContinuityFinding, 'dimension' | 'status' | 'confidence' | 'description'>;
const fingerprint = (next = after, analysisVersion?: string) => buildVoiceContinuityFingerprint(scope, before, next, [before, next], finding, analysisVersion);
const identity = fingerprint();
const time = '2026-11-23T00:00:00.000Z';
const original: VoiceDecisionCommand = {
  decisionId: identity.id, dimension: 'VOICE', operationId: 'initial_operation_01',
  expectedVersion: 0, decision: 'REVIEW_REQUIRED', authorNote: '첫 판단',
};

function memoryStorage(values = new Map<string, string>()) {
  return {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test('VD1: first explicit decision binds the sources at version 1 with an audit', () => {
  const { result, audit } = prepareVoiceDecisionWrite(identity, original, null, time);
  assert.equal(result.status, 'COMMITTED');
  assert.deepEqual(result.record, { ...identity, decision: 'REVIEW_REQUIRED', authorNote: '첫 판단', version: 1, createdAt: time, updatedAt: time });
  assert.equal(audit.previousDecision, null);
  assert.deepEqual(audit.record, result.record);
  assert.equal(audit.id, original.operationId);
  assert.equal(audit.ownerId, identity.ownerId);
});

test('VD2: persisted local decisions and audits are restored in a new session without surfacing in other scopes', () => {
  const volume = new Map<string, string>();
  const saved = commitLocalVoiceDecision(memoryStorage(volume), identity, original);
  const restarted = memoryStorage(volume);
  assert.deepEqual(listLocalVoiceDecisions(restarted, scope), [saved.record]);
  assert.deepEqual(listLocalVoiceAudits(restarted, scope, identity.id).map((audit) => audit.record), [saved.record]);
  for (const otherScope of [{ ...scope, ownerId: 'other' }, { ...scope, projectId: 'other' }, { ...scope, characterId: 'other' }]) {
    assert.deepEqual(listLocalVoiceDecisions(restarted, otherScope), []);
  }
});

test('VD7: a new Revision ID with identical text requires a new decision', () => {
  const evolved = fingerprint({ ...after, revisionId: 'rev3' });
  assert.notEqual(evolved.id, identity.id);
  assert.throws(() => prepareVoiceDecisionWrite(evolved, original, null, time), /STALE_SOURCE/);
  assert.notEqual(fingerprint({ ...after, latestRevisionId: 'rev3' }).id, identity.id);
});

test('VD8: a changed manuscript hash on the same Revision cannot inherit a decision', () => {
  const evolved = fingerprint({ ...after, contentHash: computeManuscriptContentHash('변경된 원고') });
  const { result } = prepareVoiceDecisionWrite(identity, original, null, time);
  assert.equal(matchesVoiceDecision(result.record, evolved), false);
  assert.notEqual(evolved.analysisFingerprint, identity.analysisFingerprint);
});

test('VD9: algorithm version and analysis conditions distinguish current and historical records', () => {
  const previous = prepareVoiceDecisionWrite(identity, original, null, time).result.record;
  const variants = [
    fingerprint(after, 'voice_continuity_2'),
    fingerprint({ ...after, sceneKind: 'CRISIS' }),
    fingerprint({ ...after, speakerFingerprint: continuityEvidenceHash([['speaker1', 'other']]) }),
    fingerprint({ ...after, relationshipFingerprint: continuityEvidenceHash([['canon_relation', 'rival']]) }),
    buildVoiceContinuityFingerprint(scope, before, after, [before, after], { ...finding, dimension: 'POV' }),
  ];
  for (const variant of variants) assert.equal(matchesVoiceDecision(previous, variant), false);
  const reordered = { ...after, characterIds: ['other', 'character', 'other'] };
  assert.deepEqual(buildVoiceContinuityFingerprint(scope, before, reordered, [reordered, before], finding), identity);
  const evidence = [['character', 'trust'], ['other', 'rival']];
  assert.equal(continuityEvidenceHash(evidence), continuityEvidenceHash([...evidence].reverse()));
  assert.equal(isReviewableContinuityFinding('INSUFFICIENT_EVIDENCE'), false);
});

test('VD10: a stale expected version cannot overwrite a saved decision or append an audit', () => {
  const storage = memoryStorage();
  const first = commitLocalVoiceDecision(storage, identity, original);
  const next = { ...original, expectedVersion: 1, decision: 'INTENDED_VARIATION' as const, operationId: 'second_operation_01' };
  const winner = commitLocalVoiceDecision(storage, identity, next);
  assert.throws(() => commitLocalVoiceDecision(storage, identity, { ...next, operationId: 'second_operation_02' }), /VERSION_CONFLICT/);
  assert.deepEqual(listLocalVoiceDecisions(storage, scope), [winner.record]);
  const audits = listLocalVoiceAudits(storage, scope, identity.id);
  assert.equal(audits.length, 2);
  assert.equal(audits[1].previousDecision, first.record.decision);
  assert.equal(winner.record.version, 2);
  assert.equal(winner.record.createdAt, first.record.createdAt);
});

test('VD11: retries after later edits return the original receipt and reject conflicting reuse', () => {
  const storage = memoryStorage();
  const first = commitLocalVoiceDecision(storage, identity, original);
  commitLocalVoiceDecision(storage, identity, { ...original, expectedVersion: 1, authorNote: '수정', operationId: 'second_operation_01' });
  assert.deepEqual(commitLocalVoiceDecision(storage, identity, original), { status: 'ALREADY_APPLIED', record: first.record });
  assert.throws(() => commitLocalVoiceDecision(storage, identity, { ...original, authorNote: '다른 요청' }), /OPERATION_CONFLICT/);
  assert.equal(listLocalVoiceAudits(storage, scope, identity.id).length, 2);
  assert.equal(listLocalVoiceDecisions(storage, scope)[0].version, 2);
});

test('VD12: legacy records stay local and require an explicit decision tied to matching sources', () => {
  const storage = memoryStorage();
  const key = ['nf_voice', scope.ownerId, scope.projectId, scope.characterId, before.revisionId, before.contentHash, after.revisionId, after.contentHash, 'VOICE'].join(':');
  storage.setItem(key, 'intent');
  const legacy = listLegacyVoiceDecisions(storage, scope, false);
  assert.equal(legacy.length, 1);
  assert.equal(legacyMatchesSources(legacy[0], identity), true);
  assert.equal(legacyMatchesSources(legacy[0], fingerprint({ ...after, revisionId: 'rev3' })), false);
  assert.deepEqual(listLegacyVoiceDecisions(storage, { ...scope, ownerId: 'other' }, true), []);
  assert.deepEqual(listLocalVoiceDecisions(storage, scope), []);
  commitLocalVoiceDecision(storage, identity, { ...original, decision: 'INTENDED_VARIATION', reconfirmLegacy: true });
  assert.equal(listLocalVoiceAudits(storage, scope, identity.id)[0].reconfirmLegacy, true);
  assert.equal(storage.getItem(key), 'intent');
});

test('VD13: committing a local decision preserves manuscript and CANON data', () => {
  const storage = memoryStorage();
  const data = JSON.stringify({ content: '원본', relationship: { canonStatus: 'CANON', description: '확정 관계' } });
  storage.setItem('manuscript_and_canon', data);
  const saved = commitLocalVoiceDecision(storage, identity, original);
  assert.equal(storage.getItem('manuscript_and_canon'), data);
  assert.equal('content' in saved.record, false);
  assert.equal('canonStatus' in saved.record, false);
});

test('VD14: a lost response after commit retains the same operation across a reload', () => {
  const volume = new Map<string, string>();
  const storage = memoryStorage(volume);
  writeVoiceDecisionDraft(storage, scope, original, true);
  const saved = commitLocalVoiceDecision(storage, identity, original);
  const reopened = memoryStorage(volume);
  assert.equal(readVoiceDecisionDraft(reopened, scope, identity.id, false), undefined);
  const pending = readVoiceDecisionDraft(reopened, scope, identity.id, true);
  assert.deepEqual(pending, original);
  const retry = selectVoiceDecisionOperation({ ...original, expectedVersion: 1 }, pending, () => 'second_operation_01');
  assert.deepEqual(commitLocalVoiceDecision(reopened, identity, retry), { status: 'ALREADY_APPLIED', record: saved.record });
  clearVoiceDecisionDraft(reopened, scope, retry, true);
  assert.equal(readVoiceDecisionDraft(reopened, scope, identity.id, true), undefined);
});
