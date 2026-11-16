import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { buildRecoveryKit, parseIndependentBackup } from './independentBackup';
import { loadIndependentVaultForPublish } from './independentVault';
import { hasLegacyPreservation } from './legacyPreservationGuard';
import { deriveKeysFromMnemonic } from './crypto/keys';
import { encryptJson } from './crypto/encrypt';
import { putTree, type VaultV1 } from './crypto/vault';
import { createTree, setDraftPerson, commitDraft } from './treeEngine';
import { clearVaultSession, getVaultSession, setVaultSession } from './vaultSession/session';
import { finalizeIndependentOperation, reconcileIndependentCompletions } from './independentFinalization';
import { cancelDirectOperation, readDirectOperation, writeDirectOperation } from './directArweave/journal';
import { sha256, directTags } from './directArweave/format';
import type { DirectOperation, DirectRawTransaction } from './directArweave/types';
import { getLocalVaultVersion } from './vaultSession/localArchive';

const storage = (): Storage => {
  const items = new Map<string, string>();
  return { get length() { return items.size; }, key: index => [...items.keys()][index] ?? null,
    getItem: key => items.get(key) ?? null, setItem: (key, value) => { items.set(key, String(value)); },
    removeItem: key => { items.delete(key); }, clear: () => { items.clear(); } };
};
const factory = new IDBFactory();
Object.defineProperties(globalThis, {
  indexedDB: { configurable: true, value: factory }, localStorage: { configurable: true, value: storage() },
  sessionStorage: { configurable: true, value: storage() },
});
const lockTails = new Map<string, Promise<void>>();
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
  request: async (name: string, _options: unknown, action: () => Promise<unknown>) => {
    const previous = lockTails.get(name) ?? Promise.resolve(); let release = () => {};
    const current = new Promise<void>(resolve => { release = resolve; }); lockTails.set(name, previous.then(() => current));
    await previous; try { return await action(); } finally { release(); }
  },
} } });
const words = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const keys = deriveKeysFromMnemonic(words);
const a = createTree('Synthetic A'), b = createTree('Synthetic B'), c = createTree('Synthetic C');
const vault: VaultV1 = { schema: 'sejire/vault/v1', vault_id: keys.vaultId, updated_at: new Date(0).toISOString(),
  trees: { [a.meta.id]: a, [b.meta.id]: b, [c.meta.id]: c }, active_tree_id: a.meta.id };
const envelope = await encryptJson(keys.encKey, keys.vaultId, vault);
const raw = JSON.stringify(envelope, null, 2) + '\n';
const kit = await buildRecoveryKit(raw);
assert.equal(kit.archiveText, raw); assert(!JSON.stringify(kit).includes(words));
const parsed = await parseIndependentBackup(JSON.stringify(kit));
assert.equal(parsed.kind, 'vault');
if (parsed.kind === 'vault') assert.equal(parsed.archiveText, raw);
await assert.rejects(parseIndependentBackup(JSON.stringify({ ...kit, archiveBytes: kit.archiveBytes + 1 })));
await assert.rejects(parseIndependentBackup(JSON.stringify({ ...kit, archiveText: raw + ' ' })));
console.log('PASS recovery kit retains exact bytes and rejects tampering without words');

localStorage.setItem('sejire.envelope.' + keys.vaultId, JSON.stringify(envelope));
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw Error('An older network copy must not replace the explicitly opened offline vault'); };
for (const source of ['file', 'local'] as const) {
  setVaultSession({ vaultId: keys.vaultId, headTxId: null, source }, words);
  const loaded = await loadIndependentVaultForPublish(keys, { freshKey: false });
  const editedA = setDraftPerson(a, { id: 'synthetic-person', name: 'Synthetic edit', parents: [], media: [] });
  const next = putTree(loaded.vault, editedA);
  assert.deepEqual(next.trees[b.meta.id], b); assert.deepEqual(next.trees[c.meta.id], c);
  assert.equal(Object.keys(next.trees).length, 3); assert.equal(loaded.parentTxId, null);
}
assert.equal(networkCalls, 0); globalThis.fetch = originalFetch;
console.log('PASS editing an offline A+B+C snapshot retains B+C and never substitutes older network state');

assert.equal(await hasLegacyPreservation(), false);
assert(!(await factory.databases()).some(database => database.name === 'sejire-checkout-journal'));
const prior = { id: 'synthetic-previous', version: 2, intent: { kind: 'preservation' }, localCompletion: 'pending', immutableCiphertext: 'synthetic' };
const db = await new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('sejire-checkout-journal', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('operations', { keyPath: 'id' });
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
await new Promise<void>((resolve, reject) => {
  const tx = db.transaction('operations', 'readwrite'); tx.objectStore('operations').put(prior);
  tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
});
assert.equal(await hasLegacyPreservation(), true);
const after = await new Promise<unknown>((resolve, reject) => {
  const request = db.transaction('operations').objectStore('operations').get(prior.id);
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
assert.deepEqual(after, prior); db.close();
console.log('PASS migration guard blocks existing orders and never creates, upgrades or rewrites legacy journals');

// Fixture models an already-verified journal checkpoint. Actual encryption and
// immutable byte/hash validation run here; native signature/confirmation checks
// are covered separately by direct.selftest.ts. No wallet or real chain is used.
let fixtureSequence = 0;
async function completedFixture(contents: VaultV1, txId: string, parentTxId: string | null, patch: Partial<DirectOperation> = {}) {
  const encrypted = await encryptJson(keys.encKey, keys.vaultId, contents), archiveText = JSON.stringify(encrypted);
  const archiveBytes = new TextEncoder().encode(archiveText).length, archiveDigest = await sha256(new TextEncoder().encode(archiveText));
  const id = await sha256(new TextEncoder().encode(`sejire/direct-arweave/v1\0${keys.vaultId}\0${archiveDigest}`));
  const createdAt = Date.now() + fixtureSequence++, ownerAddress = 'W'.repeat(43);
  const raw = { format: 2, id: txId, last_tx: 'L'.repeat(64), owner: 'O'.repeat(683),
    tags: directTags({ id, vaultId: keys.vaultId, parentTxId, archiveDigest, archiveBytes }).map(tag =>
      ({ name: Buffer.from(tag.name).toString('base64url'), value: Buffer.from(tag.value).toString('base64url') })),
    target: '', quantity: '0', data: Buffer.from(archiveText).toString('base64url'), data_size: String(archiveBytes),
    data_root: 'D'.repeat(43), reward: '1000', signature: 'S'.repeat(683) } as DirectRawTransaction;
  return writeDirectOperation(null, { schema: 'sejire/direct-arweave-operation/v1', id, vaultId: keys.vaultId,
    treeId: contents.active_tree_id, parentTxId, archiveText, archiveDigest, archiveBytes, state: 'complete',
    ownerAddress, quote: { ownerAddress, rewardWinston: '1000', balanceWinston: '10000', bytes: archiveBytes,
      node: 'https://synthetic-finalization.example', quotedAt: createdAt },
    signingIntent: { id: 'a'.repeat(64), startedAt: createdAt, unsignedTx: { ...raw, id: '', signature: '' } },
    signedTx: raw, txId, uploadProgress: { node: 'https://synthetic-finalization.example', headerAccepted: true, uploadedChunks: 1, totalChunks: 1 },
    verification: { checkedAt: createdAt, confirmed: true, confirmations: 5, bytesVerified: true, node: 'https://synthetic-finalization.example' },
    lastError: null, createdAt, updatedAt: createdAt, revision: 0, ...patch });
}
let finalizationChecks = 0;
async function finalizationTest(name: string, action: () => Promise<void>) { await action(); finalizationChecks++; console.log(`PASS ${name}`); }
const v0 = 'V'.repeat(43), v1 = 'X'.repeat(43);
const aNew = commitDraft(setDraftPerson(a, { id: 'history-person', name: 'New A retained after resume', parents: [], media: [] }), 'A new history');
const singleA: VaultV1 = { ...vault, trees: { [a.meta.id]: aNew }, active_tree_id: a.meta.id };
const completed = await completedFixture(singleA, v1, v0);
try {
  await finalizationTest('resumed completed A(new) advances stale HEAD before sealing B and retains all A history', async () => {
    localStorage.setItem('sejire.envelope.' + keys.vaultId, completed.archiveText);
    setVaultSession({ vaultId: keys.vaultId, headTxId: v0, source: 'local' }, words);
    globalThis.fetch = async input => {
      const path = new URL(String(input)).pathname;
      if (path === `/tx/${v1}`) return new Response(JSON.stringify(completed.signedTx));
      if ([`/raw/${v1}`, `/${v1}`].includes(path)) return new Response(completed.archiveText);
      return new Response('[]');
    };
    // The supplied parent is a stale render-time prop captured before reconcile.
    const loaded = await loadIndependentVaultForPublish(keys, { parentTxId: v0 });
    const withB = putTree(loaded.vault, b);
    assert.equal(loaded.parentTxId, v1); assert.equal(getVaultSession()?.headTxId, v1);
    assert.deepEqual(withB.trees[a.meta.id], aNew); assert.deepEqual(withB.trees[b.meta.id], b);
    assert.deepEqual(getLocalVaultVersion(keys.vaultId, v1)?.envelope, JSON.parse(completed.archiveText));
  });
  await finalizationTest('repeat finalization never rewrites a subsequent preparation or changes archive ordering', async () => {
    const later = await encryptJson(keys.encKey, keys.vaultId, putTree(singleA, b)), laterText = JSON.stringify(later);
    const savedAt = getLocalVaultVersion(keys.vaultId, v1)?.savedAt;
    localStorage.setItem('sejire.envelope.' + keys.vaultId, laterText);
    setVaultSession({ vaultId: keys.vaultId, headTxId: v1, source: 'local' }, words);
    const result = await finalizeIndependentOperation(completed.id);
    assert.equal(result.advanced, false); assert.equal(localStorage.getItem('sejire.envelope.' + keys.vaultId), laterText);
    assert.equal(getVaultSession()?.source, 'local'); assert.equal(getLocalVaultVersion(keys.vaultId, v1)?.savedAt, savedAt);
  });
  await finalizationTest('an explicitly imported full snapshot with null HEAD survives historical completion', async () => {
    for (const source of ['file', 'local'] as const) {
      const newer = JSON.stringify(envelope); localStorage.setItem('sejire.envelope.' + keys.vaultId, newer);
      setVaultSession({ vaultId: keys.vaultId, headTxId: null, source }, words);
      assert.equal((await finalizeIndependentOperation(completed.id)).advanced, false);
      assert.equal(localStorage.getItem('sejire.envelope.' + keys.vaultId), newer);
      assert.equal(getVaultSession()?.headTxId, null); assert.equal(getVaultSession()?.source, source);
    }
  });
  await finalizationTest('divergent local/file cache with parent HEAD is not replaced', async () => {
    for (const source of ['file', 'local'] as const) {
      const newer = JSON.stringify(envelope); localStorage.setItem('sejire.envelope.' + keys.vaultId, newer);
      setVaultSession({ vaultId: keys.vaultId, headTxId: v0, source }, words);
      assert.equal((await finalizeIndependentOperation(completed.id)).advanced, false);
      assert.equal(localStorage.getItem('sejire.envelope.' + keys.vaultId), newer); assert.equal(getVaultSession()?.headTxId, v0);
    }
  });
  await finalizationTest('another vault, newer HEAD and absent session remain selected exactly as before', async () => {
    for (const session of [null, { vaultId: 'e'.repeat(32), headTxId: v0, source: 'network' as const },
      { vaultId: keys.vaultId, headTxId: 'N'.repeat(43), source: 'publish' as const }]) {
      if (session) setVaultSession(session); else clearVaultSession();
      const cache = localStorage.getItem('sejire.envelope.' + keys.vaultId);
      assert.equal((await finalizeIndependentOperation(completed.id)).advanced, false);
      assert.deepEqual(getVaultSession(), session); assert.equal(localStorage.getItem('sejire.envelope.' + keys.vaultId), cache);
    }
  });
  await finalizationTest('confirmation-only or subsequently unavailable archives cannot finalize', async () => {
    const pending = await completedFixture(singleA, 'C'.repeat(43), v0, { state: 'confirming',
      verification: { checkedAt: Date.now(), confirmed: true, confirmations: 2, bytesVerified: false, node: null } });
    const unavailable = await completedFixture(singleA, 'U'.repeat(43), v0, { lastError: 'archive_unavailable' });
    await assert.rejects(() => finalizeIndependentOperation(pending.id), /not_complete/);
    await assert.rejects(() => finalizeIndependentOperation(unavailable.id), /not_complete/);
    assert.equal(getLocalVaultVersion(keys.vaultId, pending.txId!), null); assert.equal(getLocalVaultVersion(keys.vaultId, unavailable.txId!), null);
  });
  await finalizationTest('unwritten local archive is not reported as finalized and HEAD stays unchanged', async () => {
    const later = await completedFixture(singleA, 'Q'.repeat(43), v0);
    localStorage.setItem('sejire.envelope.' + keys.vaultId, later.archiveText);
    setVaultSession({ vaultId: keys.vaultId, headTxId: v0, source: 'local' }, words);
    const write = localStorage.setItem;
    localStorage.setItem = (key, value) => {
      if (key.startsWith('sejire.vaultArchive.')) throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
      write(key, value);
    };
    try { await assert.rejects(() => finalizeIndependentOperation(later.id), /storage_unavailable/); }
    finally { localStorage.setItem = write; }
    assert.equal(getVaultSession()?.headTxId, v0); assert.equal(localStorage.getItem('sejire.envelope.' + keys.vaultId), later.archiveText);
  });
  await finalizationTest('reconcile is idempotent and never selects an archive in a closed session', async () => {
    clearVaultSession(); const cache = localStorage.getItem('sejire.envelope.' + keys.vaultId);
    await reconcileIndependentCompletions(keys.vaultId); await reconcileIndependentCompletions(keys.vaultId);
    assert.equal(getVaultSession(), null); assert.equal(localStorage.getItem('sejire.envelope.' + keys.vaultId), cache);
  });
  await finalizationTest('cancelled free backup retains A(new) and its history when B is added above an existing ancestor', async () => {
    const prepared = await completedFixture(singleA, 'F'.repeat(43), v0, { state: 'prepared', ownerAddress: null,
      quote: null, signingIntent: null, signedTx: null, txId: null, verification: null,
      uploadProgress: { node: null, headerAccepted: false, uploadedChunks: 0, totalChunks: 0 } });
    localStorage.setItem('sejire.envelope.' + keys.vaultId, prepared.archiveText);
    setVaultSession({ vaultId: keys.vaultId, headTxId: v0, source: 'local' }, words);
    const cancelled = await cancelDirectOperation(prepared.id);
    assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.archiveText, prepared.archiveText);
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw Error('The selected local snapshot must not be replaced by the older remote ancestor'); };
    const loaded = await loadIndependentVaultForPublish(keys, { parentTxId: v0 });
    const withB = putTree(loaded.vault, b);
    assert.equal(calls, 0); assert.equal(loaded.parentTxId, v0);
    assert.deepEqual(withB.trees[a.meta.id], aNew); assert.deepEqual(withB.trees[b.meta.id], b);
    assert.equal((await readDirectOperation(prepared.id))?.archiveText, prepared.archiveText);
  });
} finally { globalThis.fetch = originalFetch; }
console.log(`independent backup/finalization: ${3 + finalizationChecks} synthetic checks passed; no payments or uploads`);
