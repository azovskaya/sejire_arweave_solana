import assert from 'node:assert/strict';
import { DraftOwnership, DRAFT_KEY, GUIDE_KEY, DRAFT_LOCK } from './draftOwnership';
import { replaceDraftTree } from './draftStorage';
import { createTree } from './treeEngine';
import { defaultGuide } from './guide';

class MemoryStorage {
  data = new Map<string, string>();
  reject: string | null = null;
  inaccessible = false;
  getItem(key: string) { if (this.inaccessible) throw Error('denied'); return this.data.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (key === this.reject) throw new DOMException('synthetic quota', 'QuotaExceededError');
    this.data.set(key, value);
  }
  removeItem(key: string) { this.data.delete(key); }
}
class BrowserLocks {
  held: object | null = null;
  request(name: string, options: { ifAvailable: true }, callback: (lock: object | null) => Promise<void>) {
    assert.equal(name, DRAFT_LOCK); assert.deepEqual(options, { ifAvailable: true });
    const lock = this.held ? null : {};
    if (lock) this.held = lock;
    return Promise.resolve().then(() => callback(lock)).finally(() => { if (lock === this.held) this.held = null; });
  }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const storage = new MemoryStorage(), locks = new BrowserLocks();
storage.setItem(DRAFT_KEY, 'original draft'); storage.setItem(GUIDE_KEY, 'original guide');
const a = new DraftOwnership(() => storage, () => locks), b = new DraftOwnership(() => storage, () => locks);
const holderA = {}, holderB = {};
assert.equal(await a.acquire(holderA), true);
const firstToken = a.capture();
assert.equal(await b.acquire(holderB), false);
assert.equal(b.getSnapshot().status, 'blocked');
assert.throws(() => b.write(DRAFT_KEY, 'forbidden'), /draft_read_only/);
assert.equal(storage.getItem(DRAFT_KEY), 'original draft');
assert.equal(a.write(DRAFT_KEY, 'last raw character '), true);
a.assertToken(firstToken);
assert.equal(storage.getItem(DRAFT_KEY), 'last raw character ');

// Voluntary release/BFCache pagehide is immediate. A delayed callback cannot
// revive its old generation, even after the same tab later reacquires access.
a.release(holderA); await tick();
assert.equal(await b.acquire(holderB), true);
assert.equal(b.write(DRAFT_KEY, 'second tab edited'), true);
assert.equal(await a.acquire(holderA), false);
assert.throws(() => a.assertToken(firstToken), /draft_ownership_changed/);
assert.equal(storage.getItem(DRAFT_KEY), 'second tab edited');
b.release(holderB); await tick();
assert.equal(await a.acquire(holderA), true);
assert.throws(() => a.assertToken(firstToken), /draft_ownership_changed/);
assert.equal(a.write(DRAFT_KEY, 'after reacquiring latest'), true);

// StrictMode/unmounted holder cleanup is scoped and cannot release a newer
// holder belonging to the same singleton in this document.
a.release(holderA); await tick();
const newHolder = {};
assert.equal(await a.acquire(newHolder), true);
const newerToken = a.capture();
a.release(holderA);
a.assertToken(newerToken);
assert.equal(a.getSnapshot().status, 'owned');

// An older/uncooperative app can ignore Web Locks. Compare the exact bytes
// before every write and stop, preserving the foreign draft and our own guide.
storage.setItem(DRAFT_KEY, 'older application wrote');
assert.throws(() => a.write(GUIDE_KEY, 'would overwrite guide'), /draft_changed_elsewhere/);
assert.equal(a.getSnapshot().status, 'conflict');
assert.equal(storage.getItem(DRAFT_KEY), 'older application wrote');
assert.equal(storage.getItem(GUIDE_KEY), 'original guide');
await tick();
assert.equal(await b.acquire(holderB), true);
storage.setItem(GUIDE_KEY, 'foreign guide');
b.observeStorageChange();
assert.equal(b.getSnapshot().status, 'conflict');
assert.throws(() => b.capture(), /draft_read_only/);
await tick();

const disabled = new DraftOwnership(() => storage, () => undefined);
assert.equal(await disabled.acquire({}), false);
assert.deepEqual(disabled.getSnapshot(), { status: 'unavailable', epoch: 1, reason: 'locks' });
assert.throws(() => disabled.write(DRAFT_KEY, 'unsafe fallback'), /draft_read_only/);
const deniedApi = new DraftOwnership(() => storage, () => { throw Error('permissions'); });
assert.equal(await deniedApi.acquire({}), false);
assert.equal(deniedApi.getSnapshot().reason, 'locks');
const deniedStorage = new MemoryStorage(); deniedStorage.inaccessible = true;
const unreadable = new DraftOwnership(() => deniedStorage, () => locks);
assert.equal(await unreadable.acquire({}), false);
assert.equal(unreadable.getSnapshot().reason, 'storage');
await tick();

// Cancel a provisional mount before the browser grants its asynchronous lock.
const provisional = new DraftOwnership(() => storage, () => locks), provisionalHolder = {};
const acquiring = provisional.acquire(provisionalHolder);
provisional.release(provisionalHolder);
assert.equal(await acquiring, false);
await tick();
assert.equal(provisional.getSnapshot().status, 'released');
assert.equal(locks.held, null);

// Quota failure is not success and does not invalidate the still-owned draft;
// the caller can retain the input in memory and explicitly retry it.
assert.equal(await a.acquire(newHolder), true);
storage.reject = DRAFT_KEY;
assert.equal(a.write(DRAFT_KEY, 'not yet stored'), false);
assert.equal(storage.getItem(DRAFT_KEY), 'older application wrote');
a.assertWritable();
storage.reject = null;
assert.equal(a.write(DRAFT_KEY, 'explicit retry'), true);
a.release(newHolder); await tick();

// Real replacement helper: never delete the old tree before creating a new
// one, and roll back the tree when its paired guide cannot be written.
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
const previousDraft = storage.getItem(DRAFT_KEY), previousGuide = storage.getItem(GUIDE_KEY);
storage.reject = GUIDE_KEY;
assert.equal(replaceDraftTree(createTree('synthetic replacement'), defaultGuide()), false);
assert.equal(storage.getItem(DRAFT_KEY), previousDraft);
assert.equal(storage.getItem(GUIDE_KEY), previousGuide);
storage.reject = null;
assert.equal(replaceDraftTree(createTree('synthetic accepted replacement'), defaultGuide()), true);
assert.equal(JSON.parse(storage.getItem(DRAFT_KEY)!).meta.title, 'synthetic accepted replacement');
assert.deepEqual(JSON.parse(storage.getItem(GUIDE_KEY)!), defaultGuide());
console.log('draftOwnership selftest: PASS (exclusive tabs, lifecycle tokens, byte conflicts, unavailable APIs, quota and atomic replacement)');
