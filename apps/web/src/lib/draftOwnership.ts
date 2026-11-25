/** One browser tab may write the shared editor draft at a time. The lock is
 * owned by the browser, not a timestamp lease, and is never stolen. */
import { isQuotaExceeded } from './storageQuota';
export const DRAFT_KEY = 'sejire.draft.tree.v1';
export const GUIDE_KEY = 'sejire.guide.v1';
export const DRAFT_LOCK = 'sejire.draft-writer.v1';
const KEYS = [DRAFT_KEY, GUIDE_KEY] as const;
type DraftKey = typeof KEYS[number];
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type LockPort = { request(name: string, options: { ifAvailable: true },
  callback: (lock: object | null) => Promise<void>): Promise<unknown> };

export type DraftAccessState = {
  status: 'checking' | 'owned' | 'blocked' | 'released' | 'unavailable' | 'conflict';
  epoch: number;
  reason?: 'locks' | 'storage';
};
export type DraftWriteToken = Readonly<{ owner: object; epoch: number }> | null;

export class DraftOwnership {
  private state: DraftAccessState = { status: 'checking', epoch: 0 };
  private listeners = new Set<() => void>();
  private sequence = 0;
  private owner: object | null = null;
  private token: DraftWriteToken = null;
  private expected: Map<DraftKey, string | null> | null = null;
  private releaseLock: (() => void) | null = null;
  private pending: { owner: object; promise: Promise<boolean>; settle: (owned: boolean) => void } | null = null;

  private storage: () => StoragePort;
  private locks: () => LockPort | undefined;
  constructor(storage: () => StoragePort, locks: () => LockPort | undefined) {
    this.storage = storage;
    this.locks = locks;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(status: DraftAccessState['status'], reason?: DraftAccessState['reason']) {
    this.state = { status, epoch: this.state.epoch + 1, ...(reason ? { reason } : {}) };
    for (const listener of this.listeners) listener();
  }

  async acquire(owner: object): Promise<boolean> {
    if (this.owner === owner && this.state.status === 'owned') {
      try { this.assertWritable(); return true; } catch { return false; }
    }
    if (this.pending?.owner === owner) return this.pending.promise;
    // A stale effect/holder cannot cancel a later holder. The caller must first
    // release its own session; this is not a cross-tab takeover mechanism.
    if (this.owner && this.owner !== owner) return false;
    let locks: LockPort | undefined;
    try { locks = this.locks(); } catch { this.update('unavailable', 'locks'); return false; }
    if (!locks) { this.update('unavailable', 'locks'); return false; }
    const sequence = ++this.sequence;
    this.update('checking');
    let settle!: (owned: boolean) => void;
    const ready = new Promise<boolean>(resolve => { settle = resolve; });
    const pending = { owner, promise: ready, settle };
    this.pending = pending;
    void ready.then(() => { if (this.pending === pending) this.pending = null; });
    try {
      void locks.request(DRAFT_LOCK, { ifAvailable: true }, async lock => {
        if (sequence !== this.sequence) { settle(false); return; }
        if (!lock) { this.update('blocked'); settle(false); return; }
        try {
          const storage = this.storage();
          this.expected = new Map(KEYS.map(key => [key, storage.getItem(key)]));
        } catch { this.update('unavailable', 'storage'); settle(false); return; }
        this.owner = owner;
        const held = new Promise<void>(resolve => { this.releaseLock = resolve; });
        // Set the token before notifying React subscribers.
        this.token = { owner, epoch: this.state.epoch + 1 };
        this.update('owned');
        settle(true);
        await held;
      }).catch(() => {
        if (sequence === this.sequence) {
          this.owner = null; this.token = null; this.expected = null; this.releaseLock = null;
          this.update('unavailable', 'locks');
        }
        settle(false);
      });
    } catch {
      if (sequence === this.sequence) this.update('unavailable', 'locks');
      settle(false);
    }
    return ready;
  }

  release(owner: object, status: 'released' | 'conflict' = 'released') {
    if (this.owner !== owner && this.pending?.owner !== owner) return;
    ++this.sequence;
    if (this.pending?.owner === owner) { this.pending.settle(false); this.pending = null; }
    const release = this.releaseLock;
    this.releaseLock = null; this.owner = null; this.token = null; this.expected = null;
    this.update(status);
    release?.();
  }

  capture(): DraftWriteToken { this.assertWritable(); return this.token; }
  currentToken(): DraftWriteToken { return this.token; }
  isCurrent(token: DraftWriteToken): boolean {
    return Boolean(token && token === this.token && this.state.status === 'owned');
  }
  assertToken(token: DraftWriteToken) {
    if (!this.isCurrent(token)) throw Error('draft_ownership_changed');
    this.assertWritable();
  }
  assertWritable() {
    if (this.state.status !== 'owned' || !this.owner || !this.expected) throw Error('draft_read_only');
    let changed = false;
    try { const storage = this.storage(); changed = KEYS.some(key => storage.getItem(key) !== this.expected!.get(key)); }
    catch { throw Error('storage_unavailable'); }
    if (changed) {
      const owner = this.owner;
      this.release(owner, 'conflict');
      throw Error('draft_changed_elsewhere');
    }
  }
  observeStorageChange() {
    if (this.state.status !== 'owned') return;
    try { this.assertWritable(); } catch { /* the state or next explicit write explains the refusal */ }
  }
  write(key: DraftKey, value: string | null): boolean {
    this.assertWritable();
    const storage = this.storage();
    if (this.expected!.get(key) === value) return true;
    try {
      if (value === null) storage.removeItem(key); else storage.setItem(key, value);
      if (storage.getItem(key) !== value) throw Error('storage_unavailable');
      this.expected!.set(key, value);
      return true;
    } catch (error) {
      // A browser shim may write and then throw. Remember only our exact value
      // so the caller can roll it back without overwriting an unrelated value.
      try { if (storage.getItem(key) === value) this.expected!.set(key, value); } catch { /* retain the prior baseline */ }
      if (isQuotaExceeded(error)) return false;
      throw error;
    }
  }
}

let browserOwnership: DraftOwnership | undefined;
/** Non-DOM consumers (CLI/selftests) keep the existing plain storage contract.
 * Every browser writer uses the coordinator, including before React is ready. */
export function getDraftOwnership(): DraftOwnership | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  return browserOwnership ??= new DraftOwnership(() => localStorage, () => navigator.locks);
}
export function captureDraftWriteToken(): DraftWriteToken { return getDraftOwnership()?.capture() ?? null; }
/** Safe render-time snapshot; actions must assert it before any mutation. */
export function currentDraftWriteToken(): DraftWriteToken { return getDraftOwnership()?.currentToken() ?? null; }
export function assertDraftWriteToken(token: DraftWriteToken) { getDraftOwnership()?.assertToken(token); }
export function assertDraftWritable() { getDraftOwnership()?.assertWritable(); }
export function writeDraftValue(key: DraftKey, value: string | null): boolean {
  const ownership = getDraftOwnership();
  if (ownership) return ownership.write(key, value);
  try {
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    if (localStorage.getItem(key) !== value) throw Error('storage_unavailable');
    return true;
  } catch (error) {
    if (isQuotaExceeded(error)) return false;
    throw error;
  }
}

/** Roll back only bytes written by the current synchronous transaction. */
export function rollbackDraftValue(key: DraftKey, before: string | null, written: string | null, token: DraftWriteToken) {
  if (localStorage.getItem(key) !== written) return;
  assertDraftWriteToken(token);
  if (!writeDraftValue(key, before)) throw Error('storage_unavailable');
}
