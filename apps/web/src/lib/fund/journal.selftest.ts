import type { EnvelopeV1 } from '../crypto/encrypt';
import { serializeEnvelope } from '../crypto/envelope';
import { envelopeDigest } from '../solana/policy';
import { clearFundAttempt, findFundAttempt, saveFundAttempt } from './journal';
import { assertFundOrderParent } from './client';

function assert(value: unknown, label: string): asserts value {
  if (!value) throw Error(label);
}

async function rejects(action: () => Promise<unknown>, code: string, label: string) {
  let caught: unknown;
  try { await action(); } catch (error) { caught = error; }
  assert(caught instanceof Error && caught.message === code, `${label}: expected ${code}`);
}

class MemoryStorage implements Storage {
  data = new Map<string, string>();
  failRead = false;
  failWrite = false;
  failRemove = false;
  dropWrite = false;
  dropRemove = false;
  get length() { if (this.failRead) throw Error('blocked'); return this.data.size; }
  key(index: number) { if (this.failRead) throw Error('blocked'); return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { if (this.failRead) throw Error('blocked'); return this.data.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (this.failWrite) throw Error('quota');
    if (!this.dropWrite) this.data.set(key, String(value));
  }
  removeItem(key: string) {
    if (this.failRemove) throw Error('blocked');
    if (!this.dropRemove) this.data.delete(key);
  }
  clear() { this.data.clear(); }
}

const PREFIX = 'sejire.fundAttempt.v1.';
const META = 'sejire.vaultSession.v1';
let ls = new MemoryStorage(), ss = new MemoryStorage(), lockCalls = 0;
function reset(withLocks = true) {
  ls = new MemoryStorage(); ss = new MemoryStorage(); lockCalls = 0;
  let queue = Promise.resolve();
  const locks = { request<T>(name: string, options: { mode: string }, action: () => Promise<T>) {
    assert(name === 'sejire.fund-attempts.v1' && options.mode === 'exclusive', 'shared exclusive journal lock');
    lockCalls++;
    const result = queue.then(action);
    queue = result.then(() => undefined, () => undefined);
    return result;
  } };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: ls });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: ss });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: withLocks ? locks : undefined } });
}

const id = (value: number) => value.toString(16).padStart(32, '0');
const vaultId = 'a'.repeat(32), otherVault = 'b'.repeat(32), parentTxId = 'P'.repeat(43);
const envelope = (vault = vaultId, byte = 1): EnvelopeV1 => ({
  // Deliberately non-default field order: the journal must retain the exact serialized bytes.
  protocol: 'sejire/v0.3', ciphertext: Buffer.from(new Uint8Array(24).fill(byte)).toString('base64'),
  iv: 'AAECAwQFBgcICQoL', kdf: 'hkdf-sha256', cipher: 'aes-gcm-256', vault_id: vault, schema: 'sejire/envelope/v1',
});
const payload = envelope(), serialized = serializeEnvelope(payload), digest = await envelopeDigest(serialized);
const legacyKey = 'sejire-funded:' + digest;
const count = () => [...ls.data.keys()].filter((key) => key.startsWith(PREFIX)).length;
const savedInput = { orderId: id(1), envelope: payload, parentTxId, treeId: 'tree_original' };

assertFundOrderParent({ parentTxId }, parentTxId, true);
assertFundOrderParent({ parentTxId: null }, null, true);
assertFundOrderParent({}, parentTxId); // Historical GET: local parent was never signed by the old server.
await rejects(async () => assertFundOrderParent({}, parentTxId, true), 'invalid_order_response', 'new POST must echo its bound parent');
for (const wrongParent of [null, 'Q'.repeat(43), undefined]) {
  await rejects(async () => assertFundOrderParent({ parentTxId: wrongParent }, parentTxId), 'invalid_order_response', 'present response binding must equal durable parent');
}
await rejects(async () => assertFundOrderParent({ parentTxId }, null), 'invalid_order_response', 'genesis cannot silently acquire a parent');

reset();
const first = await saveFundAttempt({ ...savedInput, privateNote: 'never-persist-this-value' } as typeof savedInput);
const raw = ls.getItem(PREFIX + id(1));
assert(raw && !raw.includes('never-persist-this-value'), 'only explicit ciphertext/public metadata fields are stored');
assert(JSON.parse(raw).archiveDigest === digest && serializeEnvelope(JSON.parse(raw).envelope) === serialized, 'exact envelope and SHA256 are durable before save returns');
assert(Object.keys(JSON.parse(raw)).sort().join(',') === 'archiveDigest,createdAt,envelope,orderId,parentTxId,treeId,vaultId,version', 'record field whitelist');
assert(first.parentTxId === parentTxId && first.treeId === 'tree_original' && first.version === 1, 'public recovery metadata');
assert((await findFundAttempt({ treeId: 'tree_original' }))?.orderId === id(1), 'tree lookup works without mnemonic/session');
assert((await findFundAttempt({ vaultId, treeId: 'tree_other_in_same_vault' }))?.orderId === id(1), 'vault lookup precedes a changed editor tree');
assert((await saveFundAttempt(savedInput)).createdAt === first.createdAt && ls.getItem(PREFIX + id(1)) === raw, 'same ID/exact archive is immutable and idempotent');
first.envelope.ciphertext = envelope(vaultId, 9).ciphertext;
assert(serializeEnvelope((await findFundAttempt({ vaultId }))!.envelope) === serialized, 'returned object cannot mutate durable ciphertext');
await rejects(() => saveFundAttempt({ ...savedInput, envelope: envelope(vaultId, 2) }), 'fund_attempt_in_progress', 'same ID cannot overwrite a different ciphertext');
await rejects(() => saveFundAttempt({ ...savedInput, orderId: id(2), envelope: envelope(vaultId, 2) }), 'fund_attempt_in_progress', 'another order cannot replace pending vault');
await rejects(() => saveFundAttempt({ ...savedInput, orderId: id(2), envelope: envelope(otherVault) }), 'fund_attempt_in_progress', 'another vault cannot replace pending tree');
await rejects(() => saveFundAttempt({ ...savedInput, parentTxId: 'Q'.repeat(43) }), 'fund_attempt_in_progress', 'parent link cannot change');
assert(ls.getItem(PREFIX + id(1)) === raw && count() === 1, 'conflicts preserve original record');
await saveFundAttempt({ orderId: id(2), envelope: envelope(otherVault), treeId: 'tree_other' });
await rejects(() => findFundAttempt({ vaultId, treeId: 'tree_other' }), 'fund_attempt_in_progress', 'vault/tree disagreement never selects another vault');
assert(await findFundAttempt({ vaultId: 'c'.repeat(32) }) === null, 'unrelated known vault can be saved');
await clearFundAttempt(id(9), vaultId);
await clearFundAttempt(id(1), otherVault);
assert(ls.getItem(PREFIX + id(1)) === raw, 'clear touches only matching order and vault');
assert(lockCalls > 0, 'writes used the cross-tab lock');

reset();
const race = await Promise.allSettled([
  saveFundAttempt(savedInput),
  saveFundAttempt({ ...savedInput, orderId: id(2), envelope: envelope(vaultId, 2) }),
]);
assert(race.filter((item) => item.status === 'fulfilled').length === 1 && count() === 1, 'concurrent vault saves have only one winner');
reset();
const idRace = await Promise.allSettled([
  saveFundAttempt(savedInput), saveFundAttempt({ ...savedInput, envelope: envelope(vaultId, 3) }),
]);
assert(idRace.filter((item) => item.status === 'fulfilled').length === 1 && count() === 1, 'same-ID competing bytes cannot overwrite');

reset();
const mutable = { ...savedInput, envelope: envelope() };
const capturing = saveFundAttempt(mutable);
mutable.envelope.vault_id = otherVault; mutable.treeId = 'tree_changed';
const captured = await capturing;
assert(captured.vaultId === vaultId && captured.treeId === 'tree_original' && captured.archiveDigest === digest, 'arguments are captured before async digest/lock');

reset();
await saveFundAttempt(savedInput);
const damaged = JSON.parse(ls.getItem(PREFIX + id(1))!); damaged.archiveDigest = '0'.repeat(64);
ls.setItem(PREFIX + id(1), JSON.stringify(damaged));
await rejects(() => findFundAttempt({ vaultId }), 'invalid_saved_order', 'tampered digest fails closed');
await rejects(() => saveFundAttempt({ ...savedInput, orderId: id(2) }), 'invalid_saved_order', 'corrupt recovery cannot be overwritten');
assert(count() === 1, 'corrupt record is retained for recovery');

reset();
ls.failWrite = true;
await rejects(() => saveFundAttempt(savedInput), 'storage_unavailable', 'quota failure blocks save');
assert(count() === 0, 'quota failure creates no replacement');
ls.failWrite = false; ls.dropWrite = true;
await rejects(() => saveFundAttempt(savedInput), 'storage_unavailable', 'silent storage failure detected by readback');
ls.dropWrite = false; ls.failRead = true;
await rejects(() => findFundAttempt({ vaultId }), 'storage_unavailable', 'unreadable journal blocks reseal');

reset(false);
await rejects(() => saveFundAttempt(savedInput), 'storage_unavailable', 'new save without cross-tab locking fails closed');
assert(count() === 0, 'unsupported writes leave storage untouched');
reset();
await saveFundAttempt(savedInput);
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
ss.failRead = true;
assert((await findFundAttempt({ treeId: savedInput.treeId }))?.orderId === id(1), 'durable read-only resume needs neither Web Locks nor session storage');
ss.failRead = false;
await clearFundAttempt(id(1), vaultId);
assert(count() === 0, 'exact completed cleanup works without Web Locks');

reset();
ss.setItem(legacyKey, id(1)); ls.setItem('sejire.envelope.' + vaultId, serialized);
ss.setItem(META, JSON.stringify({ vaultId, headTxId: parentTxId, source: 'network' }));
await rejects(() => findFundAttempt({ treeId: 'tree_unproven' }), 'fund_attempt_in_progress', 'legacy ciphertext does not prove a tree association');
const migrated = await findFundAttempt({ vaultId, treeId: 'tree_unproven' });
assert(migrated?.orderId === id(1) && migrated.parentTxId === parentTxId && migrated.treeId === null, 'legacy migration retains ID and matching parent without guessing tree');
assert(serializeEnvelope(migrated.envelope) === serialized && migrated.archiveDigest === digest && count() === 1, 'legacy migration keeps exact bytes');
await rejects(() => findFundAttempt({ treeId: 'tree_unproven' }), 'fund_attempt_in_progress', 'unknown tree remains blocked after legacy migration');
assert((await findFundAttempt({ vaultId }))?.orderId === id(1), 'legacy migration is idempotent');
ss.setItem(legacyKey + ':rejected', JSON.stringify({ version: 1, orderId: id(1), code: 'promo_invalid' }));
ss.dropRemove = true;
await rejects(() => clearFundAttempt(id(1), vaultId), 'storage_unavailable', 'legacy cleanup readback must succeed first');
assert(count() === 1, 'durable record remains when legacy cleanup fails');
ss.dropRemove = false; ss.failRead = true;
await rejects(() => clearFundAttempt(id(1), vaultId), 'storage_unavailable', 'blocked session storage cannot release pending record');
assert(count() === 1, 'blocked legacy cleanup preserves durability');
ss.failRead = false; ls.dropRemove = true;
await rejects(() => clearFundAttempt(id(1), vaultId), 'storage_unavailable', 'durable deletion readback');
assert(count() === 1 && ss.getItem(legacyKey) === null, 'partial cleanup keeps remaining durable recovery');
ls.dropRemove = false;
await clearFundAttempt(id(1), vaultId);
assert(count() === 0 && ss.getItem(legacyKey) === null && ss.getItem(legacyKey + ':rejected') === null, 'matching legacy marker/hint and durable record cleared');
assert(await findFundAttempt({ vaultId }) === null, 'completed attempt cannot migrate again');

reset();
ss.setItem(legacyKey, id(1)); ls.setItem('sejire.envelope.' + vaultId, serialized);
ss.setItem(META, JSON.stringify({ vaultId: otherVault, headTxId: parentTxId }));
assert((await findFundAttempt({ vaultId }))?.parentTxId === null, 'unrelated session parent is never inherited');
ss.setItem(legacyKey, id(2));
ss.setItem(legacyKey + ':rejected', JSON.stringify({ version: 1, orderId: id(2), code: 'promo_invalid' }));
await clearFundAttempt(id(1), vaultId);
assert(ss.getItem(legacyKey) === id(2) && ss.getItem(legacyKey + ':rejected')?.includes(id(2)), 'cleanup does not erase another legacy ID or hint');

reset();
ss.setItem(legacyKey, id(1));
await rejects(() => findFundAttempt({ vaultId }), 'fund_attempt_in_progress', 'lost ciphertext blocks a fresh attempt');
await rejects(() => saveFundAttempt({ ...savedInput, orderId: id(2) }), 'fund_attempt_in_progress', 'same bytes with new ID do not replace legacy');
ls.setItem('sejire.envelope.' + vaultId, serializeEnvelope(envelope(vaultId, 2)));
await rejects(() => findFundAttempt({ vaultId }), 'fund_attempt_in_progress', 'resealed cache cannot match legacy digest');
ls.clear();
const recoveredFile = await saveFundAttempt({ orderId: id(1), envelope: payload, treeId: 'tree_unproven' });
assert(recoveredFile.orderId === id(1) && recoveredFile.archiveDigest === digest && recoveredFile.treeId === null, 'exact imported file recovers only the matching legacy ID');

reset();
ss.setItem(legacyKey, id(1));
ss.setItem('sejire-funded:' + 'e'.repeat(64), id(2));
await rejects(() => saveFundAttempt({ orderId: id(1), envelope: payload }), 'fund_attempt_in_progress', 'another unresolved legacy still blocks imported-file write');
assert(count() === 0 && ss.getItem(legacyKey) === id(1), 'unresolved legacy is never replaced');

reset();
ss.setItem(legacyKey, id(1));
for (const hint of [
  { version: 1, orderId: id(2), code: 'promo_invalid' },
  { version: 2, orderId: id(1), code: 'promo_invalid' },
  { version: 1, orderId: id(1), code: 'network_error' },
]) {
  ss.setItem(legacyKey + ':rejected', JSON.stringify(hint));
  await rejects(() => findFundAttempt({ vaultId }), 'fund_attempt_in_progress', 'unproven rejection hint cannot release old ID');
}
ss.setItem(legacyKey + ':rejected', JSON.stringify({ version: 1, orderId: id(1), code: 'promo_invalid' }));
assert(await findFundAttempt({ vaultId }) === null && count() === 0, 'known same-ID pre-reservation refusal does not migrate or start GET404 polling');
assert((await saveFundAttempt(savedInput)).orderId === id(1), 'explicit same-ID retry after proven refusal can persist');
assert((await findFundAttempt({ vaultId }))?.orderId === id(1), 'new durable pending overrides any old rejection hint');

reset();
for (let i = 1; i <= 12; i++) {
  const oldKey = 'sejire-funded:' + i.toString(16).padStart(64, '0');
  ss.setItem(oldKey, id(i));
  ss.setItem(oldKey + ':rejected', JSON.stringify({ version: 1, orderId: id(i), code: 'promo_invalid' }));
}
assert(await findFundAttempt({ vaultId }) === null, 'known refusals do not consume pending record capacity');

reset();
for (let i = 1; i <= 8; i++) await saveFundAttempt({ orderId: id(i), envelope: envelope(id(100 + i)), treeId: 'tree_' + i });
await rejects(() => saveFundAttempt({ orderId: id(9), envelope: envelope(id(109)), treeId: 'tree_9' }), 'fund_attempt_in_progress', 'bounded journal never evicts pending records');
assert(count() === 8, 'all bounded pending records remain');
reset();
await rejects(() => saveFundAttempt({ orderId: id(1), envelope: { ...payload, ciphertext: 'A'.repeat(524288) } }), 'envelope_too_large', 'fund archive size cap applies before storage');
assert(count() === 0, 'oversized archive leaves no journal entry');

console.log('fund journal.selftest: OK (exact ciphertext, parent response binding, conflicts, locking, legacy recovery/refusals, cleanup, storage failures, bounds)');
