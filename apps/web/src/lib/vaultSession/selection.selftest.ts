import assert from 'node:assert/strict';
import { deriveKeysFromMnemonic } from '../crypto/keys';
import { encryptJson } from '../crypto/encrypt';
import { openEnvelope, type VaultV1 } from '../crypto/vault';
import { DRAFT_KEY } from '../draftStorage';
import { createTree, setDraftPerson, commitDraft } from '../treeEngine';
import { coerceTreeStore } from '../treeJson';
import { acceptPreparedVault, captureVaultPreparation, acceptVaultVersion, type VaultVersionSelection } from './selection';
import { canAdvanceVaultHead, clearVaultSession, getSessionMnemonic, getVaultSession, setVaultSession, setVaultSessionChecked, VAULT_SESSION_META_KEY, vaultEnvelopeDigest } from './session';

function storage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); }, clear: () => { values.clear(); } };
}
Object.defineProperties(globalThis, {
  localStorage: { configurable: true, value: storage() }, sessionStorage: { configurable: true, value: storage() },
});
const words = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const keys = deriveKeysFromMnemonic(words);
const a = commitDraft(setDraftPerson(createTree('Synthetic A'), { id: 'public-person', name: 'Synthetic Person', parents: [], media: [] }), 'Original history');
const b = createTree('Synthetic B'), c = createTree('Synthetic C');
const full: VaultV1 = { schema: 'sejire/vault/v1', vault_id: keys.vaultId, updated_at: new Date(0).toISOString(),
  active_tree_id: a.meta.id, trees: { [a.meta.id]: a, [b.meta.id]: b, [c.meta.id]: c } };
const earlier: VaultV1 = { ...full, trees: { [a.meta.id]: a } };
const fullEnvelope = await encryptJson(keys.encKey, keys.vaultId, full);
const earlierEnvelope = await encryptJson(keys.encKey, keys.vaultId, earlier);
const cacheKey = 'sejire.envelope.' + keys.vaultId;
const networkChoice: VaultVersionSelection = { vault: earlier, envelope: earlierEnvelope, mnemonic: words,
  session: { vaultId: keys.vaultId, headTxId: 'V'.repeat(43), source: 'network' } };
const localChoice: VaultVersionSelection = { vault: full, envelope: fullEnvelope, mnemonic: words,
  session: { vaultId: keys.vaultId, headTxId: null, source: 'local' } };

function reset() {
  localStorage.clear(); sessionStorage.clear(); clearVaultSession();
  localStorage.setItem(cacheKey, JSON.stringify(fullEnvelope, null, 2));
  localStorage.setItem(DRAFT_KEY, JSON.stringify(a));
  setVaultSession({ vaultId: keys.vaultId, headTxId: null, source: 'file' }, words);
}
function snapshot() {
  return { cache: localStorage.getItem(cacheKey), draft: localStorage.getItem(DRAFT_KEY),
    metadata: sessionStorage.getItem(VAULT_SESSION_META_KEY), phrase: getSessionMnemonic() };
}
let passed = 0;
async function test(name: string, run: () => void | Promise<void>) { reset(); await run(); passed++; console.log('PASS ' + name); }

await test('declining an older network version leaves the complete vault, editor, HEAD and phrase unchanged', () => {
  const before = snapshot(); let confirmations = 0;
  assert.equal(acceptVaultVersion(networkChoice, () => { confirmations++; return false; }), null);
  assert.equal(confirmations, 1); assert.deepEqual(snapshot(), before);
});
await test('accepting a local snapshot persists all trees and histories before returning its active tree', async () => {
  localStorage.setItem(cacheKey, JSON.stringify(earlierEnvelope));
  const opened = acceptVaultVersion(localChoice, () => true);
  assert.deepEqual(opened, coerceTreeStore(a)); assert.deepEqual(getVaultSession(), { ...localChoice.session, cacheDigest: vaultEnvelopeDigest(fullEnvelope) });
  assert.deepEqual(await openEnvelope(keys, JSON.parse(localStorage.getItem(cacheKey)!)), full);
  assert.deepEqual(JSON.parse(localStorage.getItem(DRAFT_KEY)!), coerceTreeStore(a));
});
await test('local_/demo_ labels cannot become network parents', () => {
  const before = snapshot(); let confirmations = 0;
  assert.throws(() => acceptVaultVersion({ ...networkChoice, session: { ...networkChoice.session, headTxId: 'local_synthetic' } },
    () => { confirmations++; return true; }), /invalid_backup/);
  assert.equal(confirmations, 0); assert.deepEqual(snapshot(), before);
});
await test('another vault or an invalid inactive tree cannot be adopted', () => {
  const before = snapshot();
  assert.throws(() => acceptVaultVersion({ ...localChoice, session: { ...localChoice.session, vaultId: 'b'.repeat(32) } }, () => true), /invalid_backup/);
  const invalid = { ...full, trees: { ...full.trees, broken: {} } } as unknown as VaultV1;
  assert.throws(() => acceptVaultVersion({ ...localChoice, vault: invalid }, () => true), /invalid_backup/);
  assert.deepEqual(snapshot(), before);
});
await test('failure writing the complete vault does not change the draft or session', () => {
  const before = snapshot(), write = localStorage.setItem;
  localStorage.setItem = (key, value) => {
    if (key === cacheKey && value !== before.cache) throw new DOMException('Synthetic storage failure', 'QuotaExceededError');
    write(key, value);
  };
  try { assert.throws(() => acceptVaultVersion(networkChoice, () => true), /storage_unavailable/); }
  finally { localStorage.setItem = write; }
  assert.deepEqual(snapshot(), before);
});
await test('draft quota failure rolls back the full vault cache and keeps the prior session', () => {
  const before = snapshot(), write = localStorage.setItem;
  let failed = false;
  localStorage.setItem = (key, value) => {
    if (key === DRAFT_KEY && !failed) { failed = true; throw new DOMException('Synthetic quota failure', 'QuotaExceededError'); }
    write(key, value);
  };
  try { assert.throws(() => acceptVaultVersion(networkChoice, () => true), /storage_unavailable/); }
  finally { localStorage.setItem = write; }
  assert.equal(failed, true); assert.deepEqual(snapshot(), before);
});
await test('failed session persistence restores both storage values and the in-memory phrase', () => {
  const before = snapshot(), write = sessionStorage.setItem;
  sessionStorage.setItem = (key, value) => {
    if (key === VAULT_SESSION_META_KEY && value !== before.metadata) throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
    write(key, value);
  };
  try { assert.throws(() => acceptVaultVersion(networkChoice, () => true), /storage_unavailable/); }
  finally { sessionStorage.setItem = write; }
  assert.deepEqual(snapshot(), before);
});
await test('the rollback snapshot includes editor edits flushed by the confirmation callback', () => {
  const edited = setDraftPerson(a, { id: 'new-edit', name: 'Last edit before choosing a version', parents: [], media: [] });
  const write = sessionStorage.setItem;
  sessionStorage.setItem = (key, value) => {
    if (key === VAULT_SESSION_META_KEY && JSON.parse(value).source === 'network') throw Error('Synthetic unavailable session store');
    write(key, value);
  };
  try {
    assert.throws(() => acceptVaultVersion(networkChoice, () => { localStorage.setItem(DRAFT_KEY, JSON.stringify(edited)); return true; }), /storage_unavailable/);
  } finally { sessionStorage.setItem = write; }
  assert.deepEqual(JSON.parse(localStorage.getItem(DRAFT_KEY)!), edited);
  assert.deepEqual(getVaultSession(), { vaultId: keys.vaultId, headTxId: null, source: 'file' });
});

await test('a concurrent cache replacement cannot bind a checked session to the wrong envelope', () => {
  const before = snapshot();
  localStorage.setItem(cacheKey, JSON.stringify(earlierEnvelope));
  assert.throws(() => setVaultSessionChecked({ ...localChoice.session,
    cacheDigest: vaultEnvelopeDigest(fullEnvelope) }, words), /vault_selection_changed/);
  assert.equal(sessionStorage.getItem(VAULT_SESSION_META_KEY), before.metadata);
  assert.equal(getSessionMnemonic(), before.phrase);
  assert.equal(localStorage.getItem(cacheKey), JSON.stringify(earlierEnvelope));
});

await test('preparing twice retains all trees/history and updates the local selection digest without changing the editor', async () => {
  const beforeDraft = localStorage.getItem(DRAFT_KEY);
  const parent = 'P'.repeat(43);
  acceptPreparedVault(fullEnvelope, parent, words, captureVaultPreparation(keys.vaultId));
  assert.deepEqual(getVaultSession(), { vaultId: keys.vaultId, headTxId: parent, source: 'local', cacheDigest: vaultEnvelopeDigest(fullEnvelope) });
  const again = await encryptJson(keys.encKey, keys.vaultId, full);
  assert.notEqual(vaultEnvelopeDigest(again), vaultEnvelopeDigest(fullEnvelope));
  acceptPreparedVault(again, parent, words, captureVaultPreparation(keys.vaultId));
  assert.deepEqual(await openEnvelope(keys, JSON.parse(localStorage.getItem(cacheKey)!)), full);
  assert.equal(getVaultSession()?.cacheDigest, vaultEnvelopeDigest(again));
  assert.equal(localStorage.getItem(DRAFT_KEY), beforeDraft);
  assert.equal(getSessionMnemonic(), words);
});

await test('encryption alone has no selection side effect when the preparation is cancelled', async () => {
  const before = snapshot();
  await encryptJson(keys.encKey, keys.vaultId, full);
  assert.deepEqual(snapshot(), before);
});

await test('a delayed preparation cannot replace a newer file choice or another tab cache', () => {
  const before = captureVaultPreparation(keys.vaultId);
  acceptVaultVersion(networkChoice, () => true);
  const selected = snapshot();
  assert.throws(() => acceptPreparedVault(fullEnvelope, null, words, before), /vault_selection_changed/);
  assert.deepEqual(snapshot(), selected);
  const after = captureVaultPreparation(keys.vaultId);
  localStorage.setItem(cacheKey, JSON.stringify(fullEnvelope));
  const otherTab = snapshot();
  assert.throws(() => acceptPreparedVault(earlierEnvelope, null, words, after), /vault_selection_changed/);
  assert.deepEqual(snapshot(), otherTab);
});

await test('preparation cache quota failure preserves the previous selection and draft', () => {
  const before = snapshot(), context = captureVaultPreparation(keys.vaultId), write = localStorage.setItem;
  localStorage.setItem = (key, value) => {
    if (key === cacheKey) throw new DOMException('Synthetic cache failure', 'QuotaExceededError');
    write(key, value);
  };
  try { assert.throws(() => acceptPreparedVault(earlierEnvelope, null, words, context), /storage_unavailable/); }
  finally { localStorage.setItem = write; }
  assert.deepEqual(snapshot(), before);
});

await test('preparation session failure rolls back ciphertext before returning a failure', () => {
  const before = snapshot(), context = captureVaultPreparation(keys.vaultId), write = sessionStorage.setItem;
  sessionStorage.setItem = (key, value) => {
    if (key === VAULT_SESSION_META_KEY && value !== before.metadata) throw Error('Synthetic denied session write');
    write(key, value);
  };
  try { assert.throws(() => acceptPreparedVault(earlierEnvelope, null, words, context), /storage_unavailable/); }
  finally { sessionStorage.setItem = write; }
  assert.deepEqual(snapshot(), before);
});

await test('completion advances only the exact selected local ciphertext', () => {
  acceptPreparedVault(fullEnvelope, 'P'.repeat(43), words, captureVaultPreparation(keys.vaultId));
  const selected = getVaultSession();
  assert.equal(canAdvanceVaultHead(selected, fullEnvelope, 'P'.repeat(43), 'V'.repeat(43)), true);
  assert.equal(canAdvanceVaultHead(selected, earlierEnvelope, 'P'.repeat(43), 'V'.repeat(43)), false);
  localStorage.setItem(cacheKey, JSON.stringify(earlierEnvelope));
  assert.equal(canAdvanceVaultHead(selected, fullEnvelope, 'P'.repeat(43), 'V'.repeat(43)), false);
  assert.deepEqual(getVaultSession(), selected);
});

keys.seed.fill(0); keys.master.fill(0); keys.encKey.fill(0);
console.log(`vault version selection: ${passed} synthetic checks passed; no wallets, uploads, or network`);
