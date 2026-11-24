export const EPISODE_AUTOSAVE_DEBOUNCE_MS = 1750;
export const EPISODE_AUTOSAVE_MAX_WAIT_MS = 20000;

interface SaveClock {
  now: () => number;
  schedule: (callback: () => void, delay: number) => () => void;
}

const timer: SaveClock = {
  now: Date.now,
  schedule(callback, delay) {
    const timeout = setTimeout(callback, delay);
    return () => clearTimeout(timeout);
  },
};

export class EpisodeSaveScheduler<T> {
  private pending: { value: T; first: number; last: number } | undefined;
  private cancelTimer?: () => void;
  private tail = Promise.resolve();
  private queued = 0;
  private disposed = false;

  constructor(
    private readonly save: (value: T) => Promise<void>,
    private readonly clock: SaveClock = timer,
  ) {}

  schedule(value: T): void {
    if (this.disposed) return;
    const now = this.clock.now();
    this.pending = { value, first: this.pending?.first ?? now, last: now };
    this.arm();
  }

  cancelPending(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.pending = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPending();
  }

  runExclusive<R>(work: () => Promise<R>): Promise<R> {
    this.queued++;
    const operation = this.tail.then(() => {
      if (this.disposed) throw new Error('[SAVE_SCOPE_CHANGED] 편집 중인 회차가 바뀌었습니다.');
      return work();
    });
    this.tail = operation.then(() => {}, () => {}).finally(() => {
      this.queued--;
      this.arm();
    });
    return operation;
  }

  private arm(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (!this.pending || this.queued || this.disposed) return;
    const { first, last } = this.pending;
    const deadline = Math.min(first + EPISODE_AUTOSAVE_MAX_WAIT_MS, last + EPISODE_AUTOSAVE_DEBOUNCE_MS);
    this.cancelTimer = this.clock.schedule(() => {
      const pending = this.pending;
      this.cancelPending();
      if (pending) void this.runExclusive(() => this.save(pending.value)).catch(() => {});
    }, Math.max(0, deadline - this.clock.now()));
  }
}

const activeEpisodeSaves = new Map<string, Promise<void>>();

/** Serialize requests for the same scope across editor remounts in this tab. */
export function serializeEpisodeSave<T>(scope: readonly string[], work: () => Promise<T>): Promise<T> {
  const key = JSON.stringify(scope);
  const prior = activeEpisodeSaves.get(key) ?? Promise.resolve();
  const operation = prior.then(work);
  const settled = operation.then(() => {}, () => {});
  activeEpisodeSaves.set(key, settled);
  void settled.then(() => {
    if (activeEpisodeSaves.get(key) === settled) activeEpisodeSaves.delete(key);
  });
  return operation;
}

export type EpisodeSaveError = 'NETWORK_ERROR' | 'AUTH_ERROR' | 'PERMISSION_DENIED' |
  'REVISION_CONFLICT' | 'DOCUMENT_TOO_LARGE' | 'SAVE_SCOPE_CHANGED' | 'LOCAL_STORAGE_ERROR' | 'SAVE_ERROR';

export function classifyEpisodeSaveError(error: unknown): EpisodeSaveError {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code).replace(/^firestore\//, '') : '';
  const message = error instanceof Error ? error.message : '';
  if (['unavailable', 'deadline-exceeded'].includes(code)) return 'NETWORK_ERROR';
  if (code === 'unauthenticated') return 'AUTH_ERROR';
  if (code === 'permission-denied') return 'PERMISSION_DENIED';
  if (['STALE_REVISION_CONFLICT', 'CONTENT_HASH_MISMATCH', 'SAVE_PAYLOAD_MISMATCH', 'EPISODE_NOT_FOUND'].includes(code)) {
    return 'REVISION_CONFLICT';
  }
  if (code === 'DOCUMENT_TOO_LARGE') return 'DOCUMENT_TOO_LARGE';
  if (message.startsWith('[SAVE_SCOPE_CHANGED]')) return 'SAVE_SCOPE_CHANGED';
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'LOCAL_STORAGE_ERROR';
  return 'SAVE_ERROR';
}

export async function retryEpisodeAutosave<T>(
  work: () => Promise<T>,
  isCurrent: () => boolean,
  delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  jitter = Math.random,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (!isCurrent()) throw new Error('[SAVE_SCOPE_CHANGED] 편집 중인 회차가 바뀌었습니다.');
    try {
      return await work();
    } catch (error) {
      if (attempt === 2 || !isCurrent() || classifyEpisodeSaveError(error) !== 'NETWORK_ERROR') throw error;
      await delay((250 * 2 ** attempt) + Math.floor(jitter() * 125));
    }
  }
}
