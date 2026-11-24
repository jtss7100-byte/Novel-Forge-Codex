import type { Episode } from '../types/novel';

export type DraftScope = [ownerId: string, projectId: string, episodeId: string];

export interface DurableEpisodeDraft {
  scope: DraftScope;
  writerId: string;
  sequence: number;
  episode: Episode;
  baseRevisionId: string;
  baseContentHash: string;
  baseSavePayloadHash: string;
  savedAt: number;
}

type DraftKey = [string, string, string, string];
type DraftRow = DurableEpisodeDraft & { key: DraftKey };
// Leave a sequence fence without manuscript contents after acknowledging a save.
type StoredRow = DraftRow | { key: DraftKey; sequence: number };

const storeName = 'episodeDrafts';
let database: Promise<IDBDatabase> | undefined;

function openDraftDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('novelforge-draft-buffer', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(storeName, { keyPath: 'key' });
      store.createIndex('scope', 'scope');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        database = undefined;
      };
      resolve(db);
    };
  });
  database = opening;
  void opening.catch(() => { if (database === opening) database = undefined; });
  return opening;
}

async function transaction<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, result: (value: T) => void) => void,
): Promise<T> {
  const db = await openDraftDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    let value: T;
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    work(tx.objectStore(storeName), (result) => { value = result; });
  });
}

const rowKey = (draft: DurableEpisodeDraft): DraftRow['key'] => [...draft.scope, draft.writerId];

export function persistEpisodeDraft(draft: DurableEpisodeDraft): Promise<void> {
  return transaction('readwrite', (store) => {
    const key = rowKey(draft);
    const lookup = store.get(key);
    lookup.onsuccess = () => {
      const current: StoredRow | undefined = lookup.result;
      if (!current || current.sequence < draft.sequence) store.put({ ...draft, key });
    };
  });
}

export function readEpisodeDrafts(scope: DraftScope): Promise<DurableEpisodeDraft[]> {
  return transaction('readonly', (store, done) => {
    const lookup = store.index('scope').getAll(scope);
    lookup.onsuccess = () => done((lookup.result as DraftRow[]).sort((a, b) => b.savedAt - a.savedAt));
  });
}

/** A response for an older save can only acknowledge the exact stored sequence. */
export function acknowledgeEpisodeDraft(draft: DurableEpisodeDraft): Promise<void> {
  return transaction('readwrite', (store) => {
    const key = rowKey(draft);
    const lookup = store.get(key);
    lookup.onsuccess = () => {
      const current: StoredRow | undefined = lookup.result;
      if (!current || current.sequence === draft.sequence) {
        store.put({ key, sequence: draft.sequence });
      }
    };
  });
}
