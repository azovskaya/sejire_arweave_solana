import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import type { JWKInterface } from 'arweave/web/lib/wallet';
import { IDBFactory } from 'fake-indexeddb';
import { buildRecoveryKit, parseIndependentBackup } from './independentBackup';
import { loadIndependentVaultForPublish } from './independentVault';
import { hasLegacyPreservation } from './legacyPreservationGuard';
import { deriveKeysFromMnemonic } from './crypto/keys';
import { encryptJson } from './crypto/encrypt';
import { putTree, type VaultV1 } from './crypto/vault';
import { createTree, setDraftPerson, commitDraft } from './treeEngine';
import { clearVaultSession, getSessionMnemonic, getVaultSession, setVaultSession, setVaultSessionChecked,
  vaultEnvelopeDigest, VAULT_SESSION_META_KEY } from './vaultSession/session';
import { finalizeIndependentOperation, reconcileIndependentCompletions } from './independentFinalization';
import { cancelDirectOperation, readDirectOperation, writeDirectOperation } from './directArweave/journal';
import { sha256, directTags } from './directArweave/format';
import type { DirectOperation, DirectRawTransaction } from './directArweave/types';
import { getLocalVaultVersion } from './vaultSession/localArchive';
import { acceptVaultVersion } from './vaultSession/selection';
import { DRAFT_KEY } from './draftStorage';
import { directCrypto } from './directArweave/transaction';

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
  setVaultSessionChecked({ vaultId: keys.vaultId, headTxId: null, source, cacheDigest: vaultEnvelopeDigest(envelope) }, words);
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

// Fixture models an already-verified journal checkpoint. Ephemeral native
// signatures also let the publisher re-read that checkpoint through the strict
// native reader. No real wallet, external request or chain is used.
const fixtureAr = directCrypto();
const { privateKey: fixturePrivateKey } = generateKeyPairSync('rsa', { modulusLength: 4096, publicExponent: 0x10001 });
const fixtureKey = fixturePrivateKey.export({ format: 'jwk' }) as JWKInterface;
const fixtureAddress = await fixtureAr.wallets.jwkToAddress(fixtureKey);
let fixtureSequence = 0;
async function completedFixture(contents: VaultV1, _txId: string, parentTxId: string | null, patch: Partial<DirectOperation> = {}) {
  const encrypted = await encryptJson(keys.encKey, keys.vaultId, contents), archiveText = JSON.stringify(encrypted);
  const archiveBytes = new TextEncoder().encode(archiveText).length, archiveDigest = await sha256(new TextEncoder().encode(archiveText));
  const id = await sha256(new TextEncoder().encode(`sejire/direct-arweave/v1\0${keys.vaultId}\0${archiveDigest}`));
  const createdAt = Date.now() + fixtureSequence++, ownerAddress = fixtureAddress;
  const transaction = await fixtureAr.createTransaction({ data: archiveText, owner: fixtureKey.n, reward: '1000', last_tx: 'L'.repeat(64) });
  for (const tag of directTags({ id, vaultId: keys.vaultId, parentTxId, archiveDigest, archiveBytes })) transaction.addTag(tag.name, tag.value);
  await transaction.prepareChunks(transaction.data);
  const unsignedTx = transaction.toJSON();
  await fixtureAr.transactions.sign(transaction, fixtureKey);
  const raw = transaction.toJSON() as DirectRawTransaction, txId = transaction.id;
  return writeDirectOperation(null, { schema: 'sejire/direct-arweave-operation/v1', id, vaultId: keys.vaultId,
    treeId: contents.active_tree_id, parentTxId, archiveText, archiveDigest, archiveBytes, state: 'complete',
    ownerAddress, quote: { ownerAddress, rewardWinston: '1000', balanceWinston: '10000', bytes: archiveBytes,
      node: 'https://synthetic-finalization.example', quotedAt: createdAt },
    signingIntent: { id: 'a'.repeat(64), startedAt: createdAt, unsignedTx },
    signedTx: raw, txId, uploadProgress: { node: 'https://synthetic-finalization.example', headerAccepted: true, uploadedChunks: 1, totalChunks: 1 },
    verification: { checkedAt: createdAt, confirmed: true, confirmations: 5, bytesVerified: true, node: 'https://synthetic-finalization.example' },
    lastError: null, createdAt, updatedAt: createdAt, revision: 0, ...patch });
}
let finalizationChecks = 0;
async function finalizationTest(name: string, action: () => Promise<void>) { await action(); finalizationChecks++; console.log(`PASS ${name}`); }
const v0 = 'V'.repeat(43);
const aNew = commitDraft(setDraftPerson(a, { id: 'history-person', name: 'New A retained after resume', parents: [], media: [] }), 'A new history');
const singleA: VaultV1 = { ...vault, trees: { [a.meta.id]: aNew }, active_tree_id: a.meta.id };
const completed = await completedFixture(singleA, 'X'.repeat(43), v0);
const v1 = completed.txId!;
try {
  await finalizationTest('resumed completed A(new) advances stale HEAD before sealing B and retains all A history', async () => {
    localStorage.setItem('sejire.envelope.' + keys.vaultId, completed.archiveText);
    setVaultSessionChecked({ vaultId: keys.vaultId, headTxId: v0, source: 'local',
      cacheDigest: vaultEnvelopeDigest(JSON.parse(completed.archiveText)) }, words);
    let reads = 0;
    globalThis.fetch = async () => { reads++; throw Error('A completed journal already preserves this native version'); };
    // The supplied parent is a stale render-time prop captured before reconcile.
    const loaded = await loadIndependentVaultForPublish(keys, { parentTxId: v0 });
    const withB = putTree(loaded.vault, b);
    assert.equal(loaded.parentTxId, v1); assert.equal(getVaultSession()?.headTxId, v1);
    assert.deepEqual(withB.trees[a.meta.id], aNew); assert.deepEqual(withB.trees[b.meta.id], b);
    assert.deepEqual(getLocalVaultVersion(keys.vaultId, v1)?.envelope, JSON.parse(completed.archiveText));
    assert.equal(reads, 0, 'the preserved signed native version permits offline backup preparation');
  });
  await finalizationTest('repeat finalization never rewrites a subsequent preparation or changes archive ordering', async () => {
    const later = await encryptJson(keys.encKey, keys.vaultId, putTree(singleA, b)), laterText = JSON.stringify(later);
    const savedAt = getLocalVaultVersion(keys.vaultId, v1)?.savedAt;
    localStorage.setItem('sejire.envelope.' + keys.vaultId, laterText);
    setVaultSessionChecked({ vaultId: keys.vaultId, headTxId: v1, source: 'local', cacheDigest: vaultEnvelopeDigest(later) }, words);
    const result = await finalizeIndependentOperation(completed.id);
    assert.equal(result.advanced, false); assert.equal(localStorage.getItem('sejire.envelope.' + keys.vaultId), laterText);
    assert.equal(getVaultSession()?.source, 'local'); assert.equal(getLocalVaultVersion(keys.vaultId, v1)?.savedAt, savedAt);
  });
  await finalizationTest('an explicitly imported full snapshot with null HEAD survives historical completion', async () => {
    for (const source of ['file', 'local'] as const) {
      const newer = JSON.stringify(envelope); localStorage.setItem('sejire.envelope.' + keys.vaultId, newer);
      setVaultSessionChecked({ vaultId: keys.vaultId, headTxId: null, source, cacheDigest: vaultEnvelopeDigest(envelope) }, words);
      assert.equal((await finalizeIndependentOperation(completed.id)).advanced, false);
      assert.equal(localStorage.getItem('sejire.envelope.' + keys.vaultId), newer);
      assert.equal(getVaultSession()?.headTxId, null); assert.equal(getVaultSession()?.source, source);
    }
  });
  await finalizationTest('divergent local/file cache with parent HEAD is not replaced', async () => {
    for (const source of ['file', 'local'] as const) {
      const newer = JSON.stringify(envelope); localStorage.setItem('sejire.envelope.' + keys.vaultId, newer);
      setVaultSessionChecked({ vaultId: keys.vaultId, headTxId: v0, source, cacheDigest: vaultEnvelopeDigest(envelope) }, words);
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
    setVaultSessionChecked({ vaultId: keys.vaultId, headTxId: v0, source: 'local',
      cacheDigest: vaultEnvelopeDigest(JSON.parse(later.archiveText)) }, words);
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
    setVaultSessionChecked({ vaultId: keys.vaultId, headTxId: v0, source: 'local',
      cacheDigest: vaultEnvelopeDigest(JSON.parse(prepared.archiveText)) }, words);
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
  await finalizationTest('session failure rolls back the full cache and retry finalizes the same immutable operation', async () => {
    for (const failure of ['throw', 'drop'] as const) {
      const operation = await completedFixture(vault, 'R'.repeat(43), v0);
      const cacheKey = 'sejire.envelope.' + keys.vaultId, previous = JSON.stringify(envelope, null, 2);
      localStorage.setItem(cacheKey, previous);
      setVaultSession({ vaultId: keys.vaultId, headTxId: v0, source: 'network' }, words);
      const session = getVaultSession(), journal = await readDirectOperation(operation.id), write = sessionStorage.setItem;
      sessionStorage.setItem = (key, value) => {
        if (key === VAULT_SESSION_META_KEY) {
          if (failure === 'throw') throw new DOMException('Synthetic write failure', 'QuotaExceededError');
          return;
        }
        write(key, value);
      };
      try { await assert.rejects(() => finalizeIndependentOperation(operation.id), /storage_unavailable/); }
      finally { sessionStorage.setItem = write; }
      assert.deepEqual(getVaultSession(), session);
      assert.equal(localStorage.getItem(cacheKey), previous, 'failed HEAD persistence must not replace the selected full cache');
      assert.equal(getSessionMnemonic(), words);
      assert.deepEqual(await readDirectOperation(operation.id), journal);
      assert.equal((await finalizeIndependentOperation(operation.id)).advanced, true);
      assert.equal(getVaultSession()?.headTxId, operation.txId);
      assert.deepEqual(JSON.parse(localStorage.getItem(cacheKey)!), JSON.parse(operation.archiveText));
      assert.equal((await finalizeIndependentOperation(operation.id)).advanced, false);
    }
  });
  await finalizationTest('cache failure or a silently dropped write never advances HEAD or changes the signed journal', async () => {
    for (const failure of ['throw', 'drop'] as const) {
      const operation = await completedFixture(vault, 'W'.repeat(43), v0), cacheKey = 'sejire.envelope.' + keys.vaultId;
      const previous = JSON.stringify(envelope), write = localStorage.setItem;
      localStorage.setItem(cacheKey, previous);
      setVaultSession({ vaultId: keys.vaultId, headTxId: v0, source: 'network' }, words);
      const session = getVaultSession(), journal = await readDirectOperation(operation.id);
      localStorage.setItem = (key, value) => {
        if (key === cacheKey) {
          if (failure === 'throw') throw new DOMException('Synthetic write failure', 'QuotaExceededError');
          return;
        }
        write(key, value);
      };
      try { await assert.rejects(() => finalizeIndependentOperation(operation.id), /storage_unavailable/); }
      finally { localStorage.setItem = write; }
      assert.deepEqual(getVaultSession(), session); assert.equal(localStorage.getItem(cacheKey), previous);
      assert.deepEqual(await readDirectOperation(operation.id), journal);
      assert.equal((await finalizeIndependentOperation(operation.id)).advanced, true);
    }
  });
  await finalizationTest('cache read failure leaves the previous selection and immutable journal intact', async () => {
    const operation = await completedFixture(vault, 'G'.repeat(43), v0), cacheKey = 'sejire.envelope.' + keys.vaultId;
    localStorage.setItem(cacheKey, operation.archiveText);
    setVaultSession({ vaultId: keys.vaultId, headTxId: v0, source: 'network' }, words);
    const before = getVaultSession(), journal = await readDirectOperation(operation.id), read = localStorage.getItem;
    localStorage.getItem = key => { if (key === cacheKey) throw new DOMException('Synthetic access denied', 'SecurityError'); return read(key); };
    try { await assert.rejects(() => finalizeIndependentOperation(operation.id), /storage_unavailable/); }
    finally { localStorage.getItem = read; }
    assert.deepEqual(getVaultSession(), before); assert.equal(localStorage.getItem(cacheKey), operation.archiveText);
    assert.deepEqual(await readDirectOperation(operation.id), journal);
  });
  await finalizationTest('background completion preserves a newer exact journaled cache despite a stale network session', async () => {
    const old = await completedFixture(singleA, 'O'.repeat(43), v0), full = putTree(putTree(singleA, b), c);
    for (const state of ['prepared', 'cancelled', 'signing', 'signed'] as const) {
      const unsigned = state === 'prepared' || state === 'cancelled';
      const pending = await completedFixture(full, 'N'.repeat(43), v0, {
        state, verification: null, ...(unsigned ? { ownerAddress: null, quote: null, signingIntent: null } : {}),
        ...(state !== 'signed' ? { signedTx: null, txId: null } : {}),
        uploadProgress: { node: null, headerAccepted: false, uploadedChunks: 0, totalChunks: 0 },
      });
      localStorage.setItem('sejire.envelope.' + keys.vaultId, pending.archiveText);
      // Another tab, or a failed session update, still points at the old parent.
      setVaultSession({ vaultId: keys.vaultId, headTxId: v0, source: 'network' }, words);
      const before = getVaultSession(), saved = await readDirectOperation(pending.id);
      assert.equal((await finalizeIndependentOperation(old.id)).advanced, false, `must preserve ${state} full cache`);
      assert.equal(localStorage.getItem('sejire.envelope.' + keys.vaultId), pending.archiveText);
      assert.deepEqual(getVaultSession(), before); assert.deepEqual(await readDirectOperation(pending.id), saved);
      assert.deepEqual(await readDirectOperation(old.id), old);
    }
  });
  await finalizationTest('out-of-order concurrent completions replay the parent chain without losing a tree or history', async () => {
    const previousDb = indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
    const beforeFetch = globalThis.fetch; let requests = 0;
    globalThis.fetch = async () => { requests++; throw Error('Synthetic completion replay must remain offline'); };
    try {
      const first = await completedFixture(singleA, '1'.repeat(43), v0);
      const second = await completedFixture(putTree(singleA, b), '2'.repeat(43), first.txId);
      const thirdVault = putTree(putTree(singleA, b), c), third = await completedFixture(thirdVault, '3'.repeat(43), second.txId);
      const originals = await Promise.all([first, second, third].map(operation => readDirectOperation(operation.id)));
      localStorage.setItem('sejire.envelope.' + keys.vaultId, first.archiveText);
      setVaultSession({ vaultId: keys.vaultId, headTxId: v0, source: 'network' }, words);
      await Promise.all([third, first, second].map(operation => finalizeIndependentOperation(operation.id)));
      await reconcileIndependentCompletions(keys.vaultId); await reconcileIndependentCompletions(keys.vaultId);
      const loaded = await loadIndependentVaultForPublish(keys);
      assert.equal(loaded.parentTxId, third.txId); assert.deepEqual(loaded.vault, thirdVault);
      assert.deepEqual(loaded.vault.trees[a.meta.id].commits, aNew.commits);
      assert.deepEqual(await Promise.all([first, second, third].map(operation => readDirectOperation(operation.id))), originals);
      assert.equal(requests, 0);
    } finally {
      globalThis.fetch = beforeFetch;
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: previousDb });
    }
  });
  await finalizationTest('a completed operation in another tab cannot replace an explicit or older unbound full-vault selection', async () => {
    const cacheKey = 'sejire.envelope.' + keys.vaultId;
    let requests = 0;
    globalThis.fetch = async () => { requests++; throw Error('A conflicting local selection must stop without network access'); };
    for (const source of ['file', 'local'] as const) for (const bound of [true, false]) {
      acceptVaultVersion({ vault, envelope, session: { vaultId: keys.vaultId, headTxId: v0, source }, mnemonic: words }, () => true);
      if (!bound) setVaultSession({ vaultId: keys.vaultId, headTxId: v0, source }, words);
      const selected = getVaultSession(), draft = localStorage.getItem(DRAFT_KEY);
      // The completed archive has only A. The chosen file has A+B+C.
      localStorage.setItem(cacheKey, completed.archiveText);
      assert.equal((await finalizeIndependentOperation(completed.id)).advanced, false);
      await assert.rejects(() => loadIndependentVaultForPublish(keys), /vault_selection_changed/);
      assert.deepEqual(getVaultSession(), selected);
      assert.equal(localStorage.getItem(DRAFT_KEY), draft);
      assert.equal(localStorage.getItem(cacheKey), completed.archiveText);
      assert.deepEqual(await readDirectOperation(completed.id), completed);
    }
    assert.equal(requests, 0);
  });
} finally { globalThis.fetch = originalFetch; }
console.log(`independent backup/finalization: ${3 + finalizationChecks} synthetic checks passed; no payments or uploads`);
