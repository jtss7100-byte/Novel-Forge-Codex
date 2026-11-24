import assert from 'node:assert/strict';
import test from 'node:test';
import { Bytes, GeoPoint, Timestamp, serverTimestamp, vector } from 'firebase/firestore';
import type { Episode, Revision } from '../types/novel';
import {
  createFirestoreEpisode, createFirestoreRevision, executeAtomicEpisodeCasCommitCore,
  uploadProjectBundleToFirestore,
} from '../services/novelRepository';
import { episodeSavePayloadHash, episodeSaveSignature } from './episodeSavePayload';
import { classifyEpisodeSaveError, EpisodeSaveScheduler, retryEpisodeAutosave, serializeEpisodeSave } from './episodeSaveScheduler';
import { assertFirestoreDocumentFits, estimateFirestoreDocument, FirestoreDocumentTooLargeError } from './firestoreDocumentSize';
import { computeManuscriptContentHash } from './manuscriptIntegrity';
import { createInitialSeedBundle } from './seedData';
import { FoundationMemorySearchStore } from '../services/memorySearchProvider';

const clockTime = '2026-01-01T00:00:00.000Z';
const initial: Episode = {
  ownerId: 'storage_owner', projectId: 'storage_proj', id: 'episode_1', episodeNumber: 1,
  title: '회차', content: '기준 원고', synopsis: '', authorNote: '', status: 'draft',
  charCountWithSpaces: 5, charCountWithoutSpaces: 4, linkedCharacterIds: [],
  linkedWorldbuildingIds: [], latestRevisionId: 'rev_base', createdAt: clockTime, updatedAt: clockTime,
};

function fakeClock() {
  let current = 0;
  const timers = new Map<number, { callback: () => void; at: number }>();
  let nextId = 0;
  async function drain() {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }
  return {
    now: () => current,
    schedule(callback: () => void, delay: number) {
      const id = ++nextId;
      timers.set(id, { callback, at: current + delay });
      return () => { timers.delete(id); };
    },
    async until(time: number) {
      await drain();
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > time) break;
        timers.delete(next[0]);
        current = next[1].at;
        next[1].callback();
        await drain();
      }
      current = time;
      await drain();
    },
  };
}

function casFixture(start = initial) {
  let saved: Episode | undefined = start;
  let reads = 0;
  let writes = 0;
  const revisions: Revision[] = [];
  const adapter = {
    getEpisodeSnapshot: async () => {
      reads++;
      return saved ? {
        exists: true, content: saved.content, latestRevisionId: saved.latestRevisionId,
        contentHash: computeManuscriptContentHash(saved.content), savePayloadHash: episodeSavePayloadHash(saved),
      } : { exists: false, content: '' };
    },
    createRevision: async (rev: Revision) => { revisions.push(rev); },
    updateEpisode: async (episode: Episode) => { saved = episode; writes++; },
  };
  return {
    observe: () => ({ saved, reads, writes, revisions: revisions.length }),
    remove: () => { saved = undefined; },
    commit: (desired: Episode, base = initial, createRevision = false) => executeAtomicEpisodeCasCommitCore({
      uid: desired.ownerId, projectId: desired.projectId, updatedEpisode: desired,
      nowIso: clockTime, expectedRevisionId: base.latestRevisionId,
      expectedContentHash: computeManuscriptContentHash(base.content),
      expectedSavePayloadHash: episodeSavePayloadHash(base), deduplicate: !createRevision, createRevision,
    }, adapter),
  };
}

test('FS1, FS13, FS17: duplicate saves write zero documents while meaningful metadata persists', async () => {
  const mock = casFixture();
  for (let n = 0; n < 100; n++) {
    const duplicate = await mock.commit({ ...initial, updatedAt: '2026-01-02T00:00:00.000Z' });
    assert.equal(duplicate.unchanged, true);
  }
  assert.deepEqual(mock.observe(), { saved: initial, reads: 100, writes: 0, revisions: 0 });
  for (const [key, value] of [
    ['content', '새 원고'], ['title', '새 제목'], ['synopsis', '요약'], ['authorNote', '메모'],
    ['status', 'review'], ['episodeNumber', 2], ['linkedCharacterIds', ['char1']],
    ['linkedWorldbuildingIds', ['location1']],
  ] as const) {
    assert.notEqual(episodeSaveSignature(initial), episodeSaveSignature({ ...initial, [key]: value }), key);
  }
  await mock.commit({ ...initial, authorNote: '새 작가 메모' });
  assert.equal(mock.observe().saved?.authorNote, '새 작가 메모');
  assert.equal(mock.observe().writes, 1);
  assert.equal(mock.observe().revisions, 0);
  console.log('[STORAGE_BENCHMARK_C]', JSON.stringify({ calls: 100, snapshotReads: 100, documentWrites: 0, revisions: 0 }));
});

test('FS2: debounce combines input and explicit work waits for prior saves', async () => {
  const clock = fakeClock();
  const received: number[] = [];
  const scheduler = new EpisodeSaveScheduler(async (value: number) => { received.push(value); }, clock);
  scheduler.schedule(1);
  await clock.until(1000);
  scheduler.schedule(2);
  await clock.until(2749);
  assert.deepEqual(received, []);
  await clock.until(2750);
  assert.deepEqual(received, [2]);

  const order: string[] = [];
  let finish: () => void = () => {};
  const first = scheduler.runExclusive(async () => {
    order.push('first');
    await new Promise<void>((resolve) => { finish = resolve; });
  });
  const second = scheduler.runExclusive(async () => { order.push('second'); });
  await clock.until(2750);
  assert.deepEqual(order, ['first']);
  finish();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'second']);
});

test('FS3: 1,000 input events reach a 20-second max wait and match the final manuscript', async () => {
  const clock = fakeClock();
  const mock = casFixture();
  let base = initial;
  let latest = initial.content;
  let previousCommit = 0;
  let longestGap = 0;
  const scheduler = new EpisodeSaveScheduler(async (episode: Episode) => {
    longestGap = Math.max(longestGap, clock.now() - previousCommit);
    previousCommit = clock.now();
    base = (await mock.commit(episode, base)).episode;
  }, clock);
  for (let i = 0; i < 1000; i++) {
    await clock.until(i * 150);
    latest = '합성 원고 입력 ' + i;
    scheduler.schedule({ ...base, content: latest });
  }
  await clock.until(clock.now() + 1750);
  assert.equal(mock.observe().saved?.content, latest);
  assert.equal(mock.observe().writes, 8);
  assert.ok(longestGap <= 20150);
  console.log('[STORAGE_BENCHMARK_A]', JSON.stringify({
    events: 1000, intervalMs: 150, longestGap, documentWrites: mock.observe().writes, revisions: mock.observe().revisions,
  }));
});

test('FS8, FS9, FS34, FS36: slow saves keep the latest pending input and disposed scope drops scheduled work', async () => {
  const clock = fakeClock();
  const received: string[] = [];
  let finish: () => void = () => {};
  const scheduler = new EpisodeSaveScheduler(async (value: string) => {
    received.push(value);
    if (value === 'first') await new Promise<void>((resolve) => { finish = resolve; });
  }, clock);
  scheduler.schedule('first');
  await clock.until(1750);
  scheduler.schedule('middle');
  scheduler.schedule('latest');
  await clock.until(4000);
  assert.deepEqual(received, ['first']);
  finish();
  await clock.until(4000);
  assert.deepEqual(received, ['first', 'latest']);
  scheduler.schedule('old-scope');
  scheduler.dispose();
  await clock.until(6000);
  assert.deepEqual(received, ['first', 'latest']);
  await assert.rejects(scheduler.runExclusive(async () => {}), /SAVE_SCOPE_CHANGED/);
});

test('FS9, FS36: editor remounts share the in-flight request for an episode, with account isolation', async () => {
  let finish: () => void = () => {};
  const scope = ['owner', 'project', 'episode'];
  const calls: string[] = [];
  const first = serializeEpisodeSave(scope, async () => {
    calls.push('first');
    await new Promise<void>((resolve) => { finish = resolve; });
  });
  const second = serializeEpisodeSave(scope, async () => { calls.push('remount'); });
  await serializeEpisodeSave(['another', 'project', 'episode'], async () => { calls.push('other account'); });
  assert.deepEqual(calls, ['first', 'other account']);
  finish();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['first', 'other account', 'remount']);
});

test('FS22, FS23: only bounded transient retries use backoff and the same captured operation', async () => {
  for (const code of ['unauthenticated', 'permission-denied', 'invalid-argument', 'DOCUMENT_TOO_LARGE', 'SAVE_PAYLOAD_MISMATCH']) {
    let calls = 0;
    await assert.rejects(retryEpisodeAutosave(async () => {
      calls++;
      throw Object.assign(new Error(code), { code });
    }, () => true, async () => {}));
    assert.equal(calls, 1, code);
  }
  const delays: number[] = [];
  let calls = 0;
  const retry = retryEpisodeAutosave(async () => {
    calls++;
    throw Object.assign(new Error('network down'), { code: 'unavailable' });
  }, () => true, async (ms) => { delays.push(ms); }, () => 0.4);
  await assert.rejects(retry, /network down/);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [300, 550]);
  assert.equal(classifyEpisodeSaveError(new DOMException('', 'QuotaExceededError')), 'LOCAL_STORAGE_ERROR');
});

test('FS7, FS29, FS31: metadata CAS fences conflicts and identical replay cannot resurrect deleted documents', async () => {
  const mock = casFixture();
  const desired = { ...initial, authorNote: '첫 탭의 작가 메모' };
  await mock.commit(desired);
  const lostResponseReplay = await mock.commit(desired);
  assert.equal(lostResponseReplay.unchanged, true);
  await assert.rejects(mock.commit({ ...initial, authorNote: '두 번째 탭' }), { code: 'SAVE_PAYLOAD_MISMATCH' });
  assert.equal(mock.observe().saved?.authorNote, desired.authorNote);
  assert.equal(mock.observe().writes, 1);
  mock.remove();
  await assert.rejects(mock.commit(desired), { code: 'EPISODE_NOT_FOUND' });
  assert.equal(mock.observe().saved, undefined);
  assert.equal(mock.observe().writes, 1);
});

test('FS11: Firestore estimator counts UTF-8 fields, nested data, and supported SDK types', () => {
  const path = 'users/a/projects/b/episodes/e';
  const base = estimateFirestoreDocument(path, { content: '' }).estimatedBytes;
  assert.equal(estimateFirestoreDocument(path, { content: '가😀' }).estimatedBytes - base, 7);
  const sizes = estimateFirestoreDocument(path, {
    content: '가😀', createdAt: Timestamp.now(), updatedAt: serverTimestamp(),
    nested: { active: true, points: [new GeoPoint(0, 0)], bytes: Bytes.fromUint8Array(new Uint8Array([1, 2])),
      vector: vector([1, 2, 3]) },
  });
  assert.equal(sizes.level, 'OK');
  assert.ok(sizes.estimatedBytes > base + 7 + 16 + 24);
  assert.throws(() => estimateFirestoreDocument(path, { broken: new Set() }), /FIRESTORE_UNSUPPORTED_FIELD/);
  assert.equal(estimateFirestoreDocument(path, { content: '한'.repeat(240000) }).level, 'WARNING');
  assert.throws(() => assertFirestoreDocumentFits(path, { content: '😀'.repeat(240000) }), FirestoreDocumentTooLargeError);
});

test('FS12: direct episode, revision and project import reject oversized payloads before I/O', async () => {
  const content = '😀'.repeat(250000);
  const oversize = { ...initial, content };
  const revision: Revision = {
    id: 'rev_big', ownerId: initial.ownerId, projectId: initial.projectId, episodeId: initial.id,
    episodeTitle: initial.title, content, charCountWithSpaces: 250000, label: '검증', createdAt: clockTime,
  };
  await assert.rejects(createFirestoreEpisode(initial.ownerId, initial.projectId, oversize), FirestoreDocumentTooLargeError);
  await assert.rejects(createFirestoreRevision(initial.ownerId, initial.projectId, revision), FirestoreDocumentTooLargeError);
  const bundle = createInitialSeedBundle(initial.ownerId);
  await assert.rejects(uploadProjectBundleToFirestore(initial.ownerId, { ...bundle, revisions: [revision] }), FirestoreDocumentTooLargeError);
});


test('FS18, FS32: a new approved revision is indexed even with identical prose', async () => {
  const store = new FoundationMemorySearchStore();
  const input = {
    ownerId: initial.ownerId, projectId: initial.projectId, sourceEntityType: 'EPISODE',
    sourceEntityId: initial.id, sourceRevisionId: 'rev_1', title: initial.title,
    fullText: '승인된 회차의 본문 근거입니다.', canonStatus: 'CANON',
  } as const;
  const first = await store.indexDocument(input);
  assert.equal(first.document.sourceRevisionId, 'rev_1');
  assert.equal((await store.indexDocument(input)).skippedAsUnchanged, true);
  const second = await store.indexDocument({ ...input, sourceRevisionId: 'rev_2' });
  assert.equal(Boolean(second.skippedAsUnchanged), false);
  assert.equal(second.document.sourceRevisionId, 'rev_2');
  assert.notEqual(second.document.indexGeneration, first.document.indexGeneration);
});
