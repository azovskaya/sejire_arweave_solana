import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import type { JWKInterface } from 'arweave/web/lib/wallet';
import { IDBFactory } from 'fake-indexeddb';
import { loadIndependentVaultForPublish } from './independentVault';
import { retrieveNativeVault } from './recovery/historicalNative';
import { deriveKeysFromMnemonic } from './crypto/keys';
import { encryptJson } from './crypto/encrypt';
import { emptyVault, openEnvelope, putTree } from './crypto/vault';
import { createTree, commitDraft, setDraftPerson } from './treeEngine';
import { clearVaultSession, getVaultSession, setVaultSession } from './vaultSession/session';
import { directCrypto } from './directArweave/transaction';
import { directTags, sha256 } from './directArweave/format';
import { cancelDirectOperation, createDirectOperation, readDirectOperation } from './directArweave/journal';

const memoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); }, clear: () => { values.clear(); } };
};
Object.defineProperties(globalThis, {
  indexedDB: { value: new IDBFactory(), configurable: true },
  localStorage: { value: memoryStorage(), configurable: true },
  sessionStorage: { value: memoryStorage(), configurable: true },
  navigator: { value: { locks: { request: async (_name: string, _options: unknown, action: () => Promise<unknown>) => action() } }, configurable: true },
});
const keys = deriveKeysFromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const originalKeyBytes = { seed: [...keys.seed], master: [...keys.master], encKey: [...keys.encKey] };
const first = commitDraft(setDraftPerson(createTree('Synthetic A'), {
  id: 'synthetic-person', name: 'Synthetic parent', parents: [], media: [],
}), 'Synthetic history');
const second = createTree('Synthetic B');
const vault = putTree(putTree(emptyVault(keys.vaultId), first), second);
const envelope = await encryptJson(keys.encKey, keys.vaultId, vault), archiveText = JSON.stringify(envelope);
const bytes = new TextEncoder().encode(archiveText), digest = await sha256(bytes);
const ar = directCrypto();
// Disposable fixture key only. It never leaves this process or signs a live request.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 4096, publicExponent: 0x10001 });
const key = privateKey.export({ format: 'jwk' }) as JWKInterface;
const transaction = await ar.createTransaction({ data: bytes, owner: key.n, reward: '1000', last_tx: 'A'.repeat(64) });
const parent = 'P'.repeat(43);
for (const tag of directTags({ id: 'f'.repeat(64), vaultId: keys.vaultId, parentTxId: parent,
  archiveDigest: digest, archiveBytes: bytes.length })) transaction.addTag(tag.name, tag.value);
await ar.transactions.sign(transaction, key);
const txId = transaction.id, header = { ...transaction.toJSON(), data: '' };
const originalFetch = globalThis.fetch;
let calls: { path: string; method: string }[] = [];
let metadataAvailable = true, discovered = true;
globalThis.fetch = async (input, init = {}) => {
  const path = new URL(String(input)).pathname, method = init.method ?? 'GET';
  calls.push({ path, method });
  if (path === '/graphql') {
    assert.equal(method, 'POST');
    return new Response(JSON.stringify({ data: { transactions: { edges: discovered ? [
      { node: { id: txId, block: { timestamp: 1, height: 1 }, tags: [] } },
    ] : [] } } }));
  }
  assert.equal(method, 'GET', 'native fixture reads never submit a transaction');
  if (path === `/tx/${txId}`) return metadataAvailable
    ? new Response(JSON.stringify(header)) : new Response('not available', { status: 404 });
  if (path === `/raw/${txId}`) return new Response(archiveText);
  return new Response('not available', { status: 404 });
};
let passed = 0;
async function test(name: string, action: () => Promise<void>) {
  calls = []; await action(); passed++; console.log(`PASS ${name}`);
}
try {
  await test('shared native reader retains all trees and history and leaves caller-owned keys unchanged', async () => {
    const read = await retrieveNativeVault(txId, keys);
    assert.deepEqual(read.vault, vault); assert.deepEqual(read.envelope, envelope); assert.equal(read.parentTxId, parent);
    assert.deepEqual({ seed: [...keys.seed], master: [...keys.master], encKey: [...keys.encKey] }, originalKeyBytes);
    assert(calls.some(call => call.path === `/tx/${txId}`));
  });
  await test('save preparation reads the exact known native HEAD without changing the selected cache', async () => {
    localStorage.setItem('sejire.envelope.' + keys.vaultId, archiveText);
    setVaultSession({ vaultId: keys.vaultId, headTxId: txId, source: 'network' });
    const before = getVaultSession();
    const loaded = await loadIndependentVaultForPublish(keys, { parentTxId: txId });
    assert.deepEqual(loaded.vault, vault); assert.equal(loaded.parentTxId, txId);
    assert.deepEqual(getVaultSession(), before); assert.equal(localStorage.getItem('sejire.envelope.' + keys.vaultId), archiveText);
    assert(!calls.some(call => call.path === '/graphql'));
  });
  await test('a stale parent prop cannot replace the selected HEAD, while matching and omitted parents use it', async () => {
    const before = getVaultSession(), cache = localStorage.getItem('sejire.envelope.' + keys.vaultId);
    await assert.rejects(() => loadIndependentVaultForPublish(keys, { parentTxId: 'S'.repeat(43) }), /storage_conflict/);
    assert.deepEqual(getVaultSession(), before); assert.equal(localStorage.getItem('sejire.envelope.' + keys.vaultId), cache);
    assert.equal(calls.length, 0);
    const matching = await loadIndependentVaultForPublish(keys, { parentTxId: txId });
    assert.equal(matching.parentTxId, txId); assert.deepEqual(matching.vault, vault);
    const implicit = await loadIndependentVaultForPublish(keys);
    assert.equal(implicit.parentTxId, txId); assert.deepEqual(implicit.vault, vault);
    assert(!calls.some(call => call.path === '/graphql'));
  });
  await test('missing known-HEAD metadata stops preparation and preserves the full local vault', async () => {
    metadataAvailable = false;
    const before = getVaultSession();
    await assert.rejects(() => loadIndependentVaultForPublish(keys, { parentTxId: txId }), /archive_unavailable/);
    assert.deepEqual(getVaultSession(), before); assert.equal(localStorage.getItem('sejire.envelope.' + keys.vaultId), archiveText);
    assert(calls.every(call => call.path === `/tx/${txId}`));
    metadataAvailable = true;
  });
  await test('discovered IDs use the same native reader before becoming a save parent', async () => {
    clearVaultSession(); localStorage.clear();
    const loaded = await loadIndependentVaultForPublish(keys);
    assert.deepEqual(loaded.vault, vault); assert.equal(loaded.parentTxId, txId);
    assert(calls.some(call => call.path === '/graphql')); assert(calls.some(call => call.path === `/tx/${txId}`));
  });
  await test('an unavailable discovered archive never becomes an empty new vault', async () => {
    metadataAvailable = false;
    await assert.rejects(() => loadIndependentVaultForPublish(keys), /archive_unavailable/);
    assert.equal(getVaultSession(), null); assert.equal(localStorage.getItem('sejire.envelope.' + keys.vaultId), null);
    metadataAvailable = true;
  });
  await test('explicit file and local snapshots remain authoritative even when metadata is unavailable', async () => {
    metadataAvailable = false; localStorage.setItem('sejire.envelope.' + keys.vaultId, archiveText);
    for (const source of ['file', 'local'] as const) {
      setVaultSession({ vaultId: keys.vaultId, headTxId: txId, source });
      const loaded = await loadIndependentVaultForPublish(keys, { parentTxId: txId });
      assert.deepEqual(loaded.vault, vault); assert.equal(loaded.parentTxId, txId);
    }
    assert.equal(calls.length, 0); metadataAvailable = true;
  });
  await test('a newer free preparation retains every tree when the local session update was unavailable', async () => {
    const third = createTree('Synthetic C'), preparedVault = putTree(vault, third);
    const preparedEnvelope = await encryptJson(keys.encKey, keys.vaultId, preparedVault);
    setVaultSession({ vaultId: keys.vaultId, headTxId: txId, source: 'network' });
    const preparation = await createDirectOperation({ envelope: preparedEnvelope, parentTxId: txId });
    localStorage.setItem('sejire.envelope.' + keys.vaultId, preparation.archiveText);
    const writeSession = sessionStorage.setItem;
    sessionStorage.setItem = () => { throw new DOMException('Synthetic session storage unavailable', 'QuotaExceededError'); };
    try { setVaultSession({ vaultId: keys.vaultId, headTxId: txId, source: 'local' }); }
    finally { sessionStorage.setItem = writeSession; }
    assert.equal(getVaultSession()?.source, 'network');
    await cancelDirectOperation(preparation.id);
    const loaded = await loadIndependentVaultForPublish(keys, { parentTxId: txId });
    assert.deepEqual(loaded.vault, preparedVault); assert.equal(Object.keys(loaded.vault.trees).length, 3);
    assert.equal(loaded.parentTxId, txId); assert.equal(calls.length, 0);
    assert.equal(localStorage.getItem('sejire.envelope.' + keys.vaultId), preparation.archiveText);
  });
  await test('a shared local preparation from another parent stops a stale tab without discarding its full vault', async () => {
    const preparedEnvelope = await encryptJson(keys.encKey, keys.vaultId, putTree(vault, createTree('Another local tree')));
    const preparation = await createDirectOperation({ envelope: preparedEnvelope, parentTxId: parent });
    await cancelDirectOperation(preparation.id);
    localStorage.setItem('sejire.envelope.' + keys.vaultId, preparation.archiveText);
    setVaultSession({ vaultId: keys.vaultId, headTxId: txId, source: 'network' });
    const before = getVaultSession();
    await assert.rejects(() => loadIndependentVaultForPublish(keys, { parentTxId: txId }), /storage_conflict/);
    assert.deepEqual(getVaultSession(), before);
    assert.equal(localStorage.getItem('sejire.envelope.' + keys.vaultId), preparation.archiveText); assert.equal(calls.length, 0);
  });
  await test('fresh words can prepare offline while an empty discovery preserves an existing local vault', async () => {
    clearVaultSession(); localStorage.setItem('sejire.envelope.' + keys.vaultId, archiveText);
    const fresh = await loadIndependentVaultForPublish(keys, { freshKey: true });
    assert.deepEqual(fresh.vault, vault); assert.equal(fresh.parentTxId, null); assert.equal(calls.length, 0);
    discovered = false;
    const local = await loadIndependentVaultForPublish(keys);
    assert.deepEqual(local.vault, vault); assert.equal(local.parentTxId, null);
  });
  await test('unreadable journal fails closed without replacing a selected complete local vault', async () => {
    localStorage.setItem('sejire.envelope.' + keys.vaultId, archiveText);
    setVaultSession({ vaultId: keys.vaultId, headTxId: txId, source: 'file' });
    const before = getVaultSession(), factory = indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
      open: () => { throw new DOMException('Synthetic journal denied', 'SecurityError'); },
    } });
    try { await assert.rejects(() => loadIndependentVaultForPublish(keys), /storage_unavailable/); }
    finally { Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory }); }
    assert.deepEqual(getVaultSession(), before);
    assert.equal(localStorage.getItem('sejire.envelope.' + keys.vaultId), archiveText);
    assert.equal(calls.length, 0);
  });
  await test('a corrupted exact cached journal digest cannot silently fall back to an older native HEAD', async () => {
    const newer = await encryptJson(keys.encKey, keys.vaultId, putTree(vault, createTree('Synthetic integrity boundary')));
    const original = await createDirectOperation({ envelope: newer, parentTxId: txId });
    const preparation = await cancelDirectOperation(original.id);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('sejire-direct-arweave-v1', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    // Deliberate persisted-bit corruption bypasses the writer; the reader must
    // detect it before using the cache, choosing a parent, or making a request.
    const replace = (value: unknown) => new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('operations', 'readwrite'); transaction.objectStore('operations').put(value);
      transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
    localStorage.setItem('sejire.envelope.' + keys.vaultId, preparation.archiveText);
    setVaultSession({ vaultId: keys.vaultId, headTxId: txId, source: 'network' });
    const before = getVaultSession();
    try {
      await replace({ ...preparation, archiveDigest: '0'.repeat(64) });
      await assert.rejects(() => loadIndependentVaultForPublish(keys), /archive_integrity_failed/);
      assert.deepEqual(getVaultSession(), before);
      assert.equal(localStorage.getItem('sejire.envelope.' + keys.vaultId), preparation.archiveText);
      assert.equal(calls.length, 0);
    } finally { await replace(preparation); db.close(); }
    assert.deepEqual(await readDirectOperation(preparation.id), preparation);
    assert.deepEqual((await loadIndependentVaultForPublish(keys)).vault, await openEnvelope(keys, newer));
    assert.equal(calls.length, 0);
  });
  await test('malformed selected local vaults never become empty new archives or network replacements', async () => {
    setVaultSession({ vaultId: keys.vaultId, headTxId: null, source: 'file' });
    const before = getVaultSession();
    const unsafeTrees = JSON.parse('{"__proto__":' + JSON.stringify(first) + '}');
    const invalidPayloads = [null, [], {}, { ...vault, schema: 'sejire/vault/future' },
      { ...vault, vault_id: '0'.repeat(32) }, { ...vault, trees: [] }, { ...vault, trees: {} },
      { ...vault, trees: { invalid: {} }, active_tree_id: 'invalid' },
      { ...vault, trees: unsafeTrees, active_tree_id: null }, { ...vault, active_tree_id: 'missing-tree' }];
    for (const value of invalidPayloads) {
      const encrypted = await encryptJson(keys.encKey, keys.vaultId, value), cached = JSON.stringify(encrypted);
      localStorage.setItem('sejire.envelope.' + keys.vaultId, cached);
      await assert.rejects(() => loadIndependentVaultForPublish(keys), /invalid_archive/);
      assert.deepEqual(getVaultSession(), before); assert.equal(localStorage.getItem('sejire.envelope.' + keys.vaultId), cached);
    }
    localStorage.setItem('sejire.envelope.' + keys.vaultId, '{truncated');
    await assert.rejects(() => loadIndependentVaultForPublish(keys), /invalid_archive/);
    assert.equal(localStorage.getItem('sejire.envelope.' + keys.vaultId), '{truncated');
    assert.equal(calls.length, 0);
  });
  await test('seeded multi-generation local vaults reach the next preparation with every tree and snapshot intact', async () => {
    const { productionFixture } = await import('../../../../tools/recovery/fixtures.test-helper.mts');
    for (const index of [3, 10, 15]) {
      const fixture = await productionFixture(index), fixtureKeys = deriveKeysFromMnemonic(fixture.words);
      try {
        localStorage.setItem('sejire.envelope.' + fixtureKeys.vaultId, fixture.archiveText);
        setVaultSession({ vaultId: fixtureKeys.vaultId, headTxId: null, source: 'local' });
        const before = getVaultSession(), loaded = await loadIndependentVaultForPublish(fixtureKeys);
        assert.deepEqual(loaded.vault, fixture.vault); assert.equal(loaded.parentTxId, null);
        assert.deepEqual(getVaultSession(), before);
        assert.equal(localStorage.getItem('sejire.envelope.' + fixtureKeys.vaultId), fixture.archiveText);
      } finally { fixtureKeys.seed.fill(0); fixtureKeys.master.fill(0); fixtureKeys.encKey.fill(0); }
    }
    assert.equal(calls.length, 0);
  });
  console.log(`independent native vault: ${passed} local fixture checks passed; no live signatures, uploads or payments`);
} finally { globalThis.fetch = originalFetch; }
