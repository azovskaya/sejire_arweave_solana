import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import type { JWKInterface } from 'arweave/web/lib/wallet';
import { IDBFactory } from 'fake-indexeddb';
import { loadIndependentVaultForPublish } from './independentVault';
import { retrieveNativeVault } from './recovery/historicalNative';
import { deriveKeysFromMnemonic } from './crypto/keys';
import { encryptJson } from './crypto/encrypt';
import { emptyVault, putTree } from './crypto/vault';
import { createTree, commitDraft, setDraftPerson } from './treeEngine';
import { clearVaultSession, getVaultSession, setVaultSession } from './vaultSession/session';
import { directCrypto } from './directArweave/transaction';
import { directTags, sha256 } from './directArweave/format';
import { cancelDirectOperation, createDirectOperation } from './directArweave/journal';

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
  console.log(`independent native vault: ${passed} local fixture checks passed; no live signatures, uploads or payments`);
} finally { globalThis.fetch = originalFetch; }
