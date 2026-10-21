import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { Keypair, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { SolanaWalletAdapter } from '@ardrive/turbo-sdk/web';
import { createPaidOrderFromPolicy, createPaymentPreparation, paidPolicyHash, SOLANA_GENESIS, type PaidPolicy, type PaidReceipt } from '../../../../../packages/checkout/paid';
import { createMnemonic } from '../crypto/bip39';
import { deriveKeysFromMnemonic } from '../crypto/keys';
import { encryptJson } from '../crypto/encrypt';
import { serializeEnvelope } from '../crypto/envelope';
import { emptyVault, openEnvelope, putTree } from '../crypto/vault';
import { createTree } from '../treeEngine';
import { envelopeDigest } from '../solana/policy';
import { parsePortableBackup } from '../crypto/backup';
import { readPaidOperation, writePaidOperation, findPaidAttempt } from './paidJournal';
import { findPreservationAttempt, reservePaidAttempt, saveGuardedFundAttempt, clearGuardedFundAttempt } from './vaultGuard';
import { beginPaidOperation, readPaidStatus, preparePaidOperation, payPaidOperation, checkPaidOperation,
  readPaidPolicy, validatePaidSnapshot, paidCompletion, cancelPaidOperation, resolveReleasedPaidOperation } from './paidClient';
import { cancelPaidCreation, retryPaidCreation } from './paidClient';
import { retrievePaidReceipt } from './paidReceipt';
import { finalizeStandalonePaid } from './paidFinalize';
import { getLocalVaultVersion } from '../vaultSession/localArchive';
import { getVaultSession } from '../vaultSession/session';
import type { PaidOperation, PaidSnapshot } from './paidTypes';

class MemoryStorage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, String(value)); }
  removeItem(key: string) { this.data.delete(key); }
}
function reset() {
  const queues = new Map<string, Promise<unknown>>();
  Object.defineProperties(globalThis, {
    indexedDB: { configurable: true, value: new IDBFactory() },
    localStorage: { configurable: true, value: new MemoryStorage() },
    sessionStorage: { configurable: true, value: new MemoryStorage() },
    location: { configurable: true, value: { origin: 'https://checkout.example' } },
    navigator: { configurable: true, value: { locks: { request<T>(name: string, _options: unknown, work: () => Promise<T>) {
      const result = (queues.get(name) ?? Promise.resolve()).then(work);
      queues.set(name, result.catch(() => {})); return result;
    } } } },
  });
}
async function putRawOperation(value: unknown) {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('sejire-checkout-journal', 1);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try { await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('operations', 'readwrite'); transaction.objectStore('operations').put(value);
    transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(transaction.error);
  }); } finally { database.close(); }
}
const address = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const signer = Keypair.fromSeed(new Uint8Array(32).fill(17)); // Public software fixture, never a funded wallet.
const arOwner = Buffer.from(new Uint8Array(512).fill(19)).toString('base64url');
const arAddress = createHash('sha256').update(Buffer.from(arOwner, 'base64url')).digest('base64url');
const policy: PaidPolicy = { schema: 'sejire/checkout-policy/v1', version: 'synthetic-v1', network: 'devnet',
  genesisHash: SOLANA_GENESIS.devnet, serviceLamports: '30000000', serviceRecipient: address(2), fundRecipient: address(3),
  storage: { kind: 'arweave-direct', network: 'arweave.N.1', treasuryAddress: arAddress, budgetId: 'synthetic-paid', maxBytes: 524288, maxRewardWinston: '10000000000' } };
const policyHash = await paidPolicyHash(policy), offered = { ready: true, policy, policyHash };
const words = createMnemonic(), keys = deriveKeysFromMnemonic(words);
const first = createTree('Synthetic first'), second = createTree('Synthetic second');
const vault = putTree(putTree(emptyVault(keys.vaultId), first), second);
const envelope = await encryptJson(keys.encKey, keys.vaultId, vault), serialized = serializeEnvelope(envelope);
const binding = { digest: await envelopeDigest(serialized), bytes: new TextEncoder().encode(serialized).length, vaultId: keys.vaultId, parentTxId: 'P'.repeat(43) };
const input = { mode: 'create' as const, envelope, parentTxId: binding.parentTxId, treeId: second.meta.id };
const candidate = (id: string): PaidOperation => ({ version: 2, id, revision: 0, token: 'f'.repeat(64), createdAt: Date.now(), treeId: second.meta.id,
  serialized, archive: binding, policy, policyHash, intent: { kind: 'preservation', payer: signer.publicKey.toBase58(), contribution: '0' },
  createAttempted: false, signingStarted: false, localCompletion: 'pending' });

// Concurrent methods/tabs must adopt the original ciphertext before any HTTP call.
reset();
const [one, two] = await Promise.all([reservePaidAttempt(candidate('1'.repeat(32))), reservePaidAttempt(candidate('2'.repeat(32)))]);
assert.equal(one.id, two.id); assert.equal(two.serialized, serialized);
assert.equal((await findPreservationAttempt({ treeId: second.meta.id }))?.method, 'paid');
await assert.rejects(() => saveGuardedFundAttempt({ orderId: '3'.repeat(32), envelope, parentTxId: binding.parentTxId, treeId: second.meta.id }), /preservation_attempt_in_progress/);
await assert.rejects(() => writePaidOperation({ ...one, token: 'a'.repeat(64) }), /paid_attempt_changed/);
const revised = await writePaidOperation({ ...one, createAttempted: true });
await assert.rejects(() => writePaidOperation(one), /paid_attempt_changed/);
assert.equal(revised.revision, one.revision + 1);
reset();
await saveGuardedFundAttempt({ orderId: '3'.repeat(32), envelope, parentTxId: binding.parentTxId, treeId: second.meta.id });
await assert.rejects(() => reservePaidAttempt(candidate('4'.repeat(32))), /preservation_attempt_in_progress/);
await clearGuardedFundAttempt('3'.repeat(32), keys.vaultId);
assert.equal(await findPreservationAttempt({ vaultId: keys.vaultId }), null);
reset();
sessionStorage.setItem('sejire-funded:' + binding.digest, '3'.repeat(32));
await assert.rejects(() => findPreservationAttempt({ vaultId: keys.vaultId }), /fund_attempt_in_progress/);
assert.equal((await saveGuardedFundAttempt({ orderId: '3'.repeat(32), envelope, treeId: second.meta.id })).orderId, '3'.repeat(32),
  'common guard preserves exact-file recovery of a digest-only old promo attempt');
reset();
await findPaidAttempt({ treeId: second.meta.id }); // Open the same legacy-compatible database.
await putRawOperation({ id: '7'.repeat(32), envelope, snapshot: { record: { states: { preservation: 'awaiting-payment' } } } });
await assert.rejects(() => findPaidAttempt({ treeId: second.meta.id }), /legacy_checkout_pending/,
  'unknown legacy vault after reload cannot bypass the paid guard');
assert.equal(await findPaidAttempt({ vaultId: 'a'.repeat(32) }), null, 'known unrelated vault remains separate');

type NetworkState = { snapshot?: PaidSnapshot; key?: string; creates: number; prepares: number; reserves: number; sends: string[];
  loseCreate?: boolean; loseReserve?: boolean; loseCancel?: boolean; rejectWallet?: boolean; unknownWallet?: boolean;
  signature?: string; wrongGenesis?: boolean; paid: boolean; executed: boolean; onSigned?: () => void;
  dropBeforeAdmission?: boolean; tombstone?: boolean; missingStatus?: number; missingCode?: string };
function syntheticNetwork(): NetworkState {
  const state: NetworkState = { creates: 0, prepares: 0, reserves: 0, sends: [], paid: false, executed: false };
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url, init) => {
    const target = String(url), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined;
    assert.ok(!target.includes(words) && !String(init?.body ?? '').includes(words));
    if (target === 'https://api.devnet.solana.com') {
      assert.equal(method, 'POST'); let result: unknown;
      if (body.method === 'getGenesisHash') result = state.wrongGenesis ? SOLANA_GENESIS['mainnet-beta'] : SOLANA_GENESIS.devnet;
      else if (body.method === 'getFeeForMessage') result = { value: 5000 };
      else if (body.method === 'getBlockHeight') result = 50;
      else if (body.method === 'sendTransaction') {
        assert.ok(state.reserves > 0, 'reserve precedes broadcast');
        const signed = Transaction.from(Buffer.from(body.params[0], 'base64'));
        assert.ok(signed.verifySignatures());
        const signature = bs58.encode(signed.signatures[0].signature!);
        assert.equal(signature, state.snapshot?.record.pendingSignature);
        assert.equal(signed.serializeMessage().toString('base64'), state.snapshot?.preparation?.messageBase64);
        const stored = await readPaidOperation(state.key!);
        assert.equal(stored?.signedTransaction, body.params[0], 'exact signed bytes durable before send');
        state.sends.push(body.params[0]); state.paid = true; result = signature;
      } else throw Error('Unmocked RPC method');
      return json({ jsonrpc: '2.0', id: body.id, result });
    }
    assert.ok(target.startsWith('https://checkout.example/api/checkout/'), 'all other network is forbidden');
    const path = target.slice('https://checkout.example/api/checkout'.length);
    if (path === '/policy') { assert.equal(method, 'GET'); return json(offered); }
    if (path === '/session') { assert.equal(method, 'POST'); return json({ accessToken: 'f'.repeat(64), expiresAt: Date.now() + 3600000 }); }
    if (path === '/orders' && method === 'POST') {
      state.creates++; state.key = new Headers(init?.headers).get('Idempotency-Key')!;
      const stored = await readPaidOperation(state.key);
      assert.ok(stored?.createAttempted); assert.equal(stored.serialized, body.serialized); assert.equal(body.serialized, serialized);
      assert.deepEqual(stored.archive, body.archive); assert.equal(stored.token, 'f'.repeat(64));
      if (state.tombstone) return json({ error: 'paid_request_cancelled' }, 409);
      if (state.dropBeforeAdmission) { state.dropBeforeAdmission = false; throw TypeError('synthetic dropped before admission'); }
      const order = await createPaidOrderFromPolicy(policy, { id: 'e'.repeat(32), payer: body.payer, reference: address(4), createdAt: Date.now() - 1,
        expiresAt: Date.now() + 120000, archive: body.archive, contribution: '0' });
      state.snapshot = { record: { order, states: { payment: 'awaiting-payment', preservation: 'awaiting-payment', contribution: 'not-requested' } }, policy, execution: null, preparation: null, expired: false };
      if (state.loseCreate) { state.loseCreate = false; throw TypeError('synthetic lost create response'); }
      return json(state.snapshot);
    }
    if (path === `/orders/by-key/${state.key}/cancel` && method === 'POST') {
      if (state.snapshot) return json(state.snapshot);
      state.tombstone = true;
      if (state.loseCancel) { state.loseCancel = false; throw TypeError('synthetic lost cancel response'); }
      return json({ schema: 'sejire/paid-request-cancellation/v1', status: 'cancelled', key: state.key });
    }
    if (path === `/orders/by-key/${state.key}` && method === 'GET' && !state.snapshot) {
      return state.tombstone ? json({ schema: 'sejire/paid-request-cancellation/v1', status: 'cancelled', key: state.key }) : json({ error: state.missingCode ?? 'order_not_found' }, state.missingStatus ?? 404);
    }
    const snapshot = state.snapshot; assert.ok(snapshot, 'existing order required');
    if (method === 'GET') {
      assert.ok(path === `/orders/${snapshot.record.order.id}` || path === `/orders/by-key/${state.key}`);
      return json(snapshot);
    }
    if (path.endsWith('/prepare')) {
      state.prepares++;
      snapshot.preparation ??= await createPaymentPreparation(snapshot.record.order, { blockhash: address(8), lastValidBlockHeight: 100, feeLamports: '5000', createdAt: Date.now() });
      return json(snapshot.preparation);
    }
    if (path.endsWith('/reserve')) {
      assert.equal(snapshot.expired, false); assert.equal(body.preparationId, snapshot.preparation?.preparationId);
      const stored = await readPaidOperation(state.key!); assert.ok(stored); assert.equal(stored.signature, body.signature); assert.ok(stored.signedTransaction);
      state.reserves++; snapshot.record.pendingSignature = body.signature;
      snapshot.record.states.payment = 'requires-reconciliation';
      if (state.loseReserve) { state.loseReserve = false; throw TypeError('synthetic lost reserve response'); }
      return json(snapshot);
    }
    if (path.endsWith('/cancel')) {
      assert.equal(snapshot.record.pendingSignature, undefined); assert.equal(snapshot.record.payment, undefined);
      assert.equal(body.preparationId, snapshot.preparation?.preparationId ?? null);
      snapshot.expired = true; snapshot.cancelled = true;
      if (state.loseCancel) { state.loseCancel = false; throw TypeError('synthetic lost cancel response'); }
      return json(snapshot);
    }
    if (path.endsWith('/reconcile') || path.endsWith('/verify')) {
      if (state.paid) {
        const signature = snapshot.record.pendingSignature ?? state.signature!;
        snapshot.record.pendingSignature = signature; snapshot.record.payment = { signature, feeLamports: '5000' };
        snapshot.record.states.payment = 'verified'; snapshot.record.states.preservation = 'ready';
        snapshot.execution = { kind: 'arweave-direct', txId: null, status: 'queued', verification: null };
        snapshot.verification = { status: 'verified' };
      } else snapshot.verification = { status: 'requires-reconciliation', reason: 'not-found' };
      return json(snapshot);
    }
    if (path.endsWith('/execute')) {
      state.executed = true; assert.ok(snapshot.record.payment);
      const receipt: PaidReceipt = { schema: 'sejire/preservation-receipt/v2', status: 'confirmed-and-verified', orderId: snapshot.record.order.id,
        policyHash, paymentNetwork: 'devnet', paymentSignature: snapshot.record.payment.signature, arweaveNetwork: 'arweave.N.1', txId: 'A'.repeat(43), archive: binding,
        treasuryAddress: policy.storage.treasuryAddress, rewardWinston: '100', verifiedAt: Date.now() };
      snapshot.record.states.preservation = 'completed';
      snapshot.execution = { kind: 'arweave-direct', txId: receipt.txId, status: 'completed', receipt,
        verification: { transactionConfirmed: true, archiveVerified: true, owner: receipt.treasuryAddress, rewardWinston: '100', archive: binding } };
      return json(snapshot);
    }
    throw Error('Unmocked checkout request');
  };
  return state;
}
let walletCalls = 0;
function wallet(state: NetworkState): SolanaWalletAdapter {
  return { publicKey: signer.publicKey, signMessage: async () => { throw Error('No message signing'); },
    signTransaction: async transaction => {
      walletCalls++;
      assert.equal((await readPaidOperation(state.key!))?.signingStarted, true, 'unknown outcome durable before wallet opens');
      if (state.rejectWallet) throw Object.assign(Error('synthetic rejection'), { code: 4001 });
      const signed = transaction as Transaction; signed.partialSign(signer);
      state.signature = bs58.encode(signed.signatures[0].signature!);
      state.onSigned?.();
      if (state.unknownWallet) throw Error('synthetic lost wallet response');
      return signed;
    } };
}

reset(); let network = syntheticNetwork(); network.loseCreate = true;
await assert.rejects(() => beginPaidOperation(input, signer.publicKey.toBase58(), '0', offered), /lost create/);
let op = (await findPaidAttempt({ vaultId: keys.vaultId }))!;
assert.equal(op.order, undefined); assert.equal(op.serialized, serialized);
op = await readPaidStatus(op.id); assert.ok(op.order);
assert.equal((await beginPaidOperation(input, signer.publicKey.toBase58(), '0', offered)).id, op.id);
assert.equal(network.creates, 1, 'lost create and later explicit click issue no duplicate POST');
for (const mutate of [
  (s: PaidSnapshot) => { s.record.order = { ...s.record.order, archive: { ...s.record.order.archive, parentTxId: 'Q'.repeat(43) } }; },
  (s: PaidSnapshot) => { s.record.order = { ...s.record.order, archive: { ...s.record.order.archive, digest: '0'.repeat(64) } }; },
  (s: PaidSnapshot) => { s.record.order = { ...s.record.order, payer: address(5) }; },
  (s: PaidSnapshot) => { s.record.order = { ...s.record.order, policyHash: 'a'.repeat(64) }; },
]) {
  const changed = structuredClone(network.snapshot!); mutate(changed);
  await assert.rejects(() => validatePaidSnapshot(op, changed));
}
op = await preparePaidOperation(op.id, wallet(network));
network.wrongGenesis = true;
await assert.rejects(() => payPaidOperation(op.id, op.preparation!.preparationId, wallet(network)), /wrong_solana_network/);
assert.equal(walletCalls, 0, 'wrong network stops before wallet'); network.wrongGenesis = false;
network.loseReserve = true;
await assert.rejects(() => payPaidOperation(op.id, op.preparation!.preparationId, wallet(network)), /lost reserve/);
assert.equal(network.sends.length, 0, 'lost reserve response does not broadcast');
const originalSigned = (await readPaidOperation(op.id))!.signedTransaction!;
const substituted = Transaction.from(Buffer.from(originalSigned, 'base64'));
substituted.recentBlockhash = address(9); substituted.partialSign(signer);
await putRawOperation({ ...(await readPaidOperation(op.id)), signedTransaction: substituted.serialize().toString('base64') });
await assert.rejects(() => checkPaidOperation(op.id), /checkout_signed_transaction_mismatch/);
assert.equal(network.sends.length, 0, 'validly signed bytes from another message never reach broadcast');
await putRawOperation({ ...(await readPaidOperation(op.id)), signedTransaction: originalSigned });
op = await checkPaidOperation(op.id); assert.equal(network.sends.length, 1);
op = await checkPaidOperation(op.id); assert.equal(network.executed, true); assert.equal(walletCalls, 1);
const completed = await paidCompletion(op); assert.ok(completed);
assert.deepEqual(await openEnvelope(keys, completed.envelope), vault, 'all trees survive paid completion');
assert.equal(parsePortableBackup(JSON.stringify(completed.receipt)).kind, 'paidReceipt');
const wrongProof = structuredClone(op.snapshot!); wrongProof.execution!.verification!.archiveVerified = false;
await assert.rejects(() => validatePaidSnapshot(op, wrongProof), /checkout_completion_mismatch/);
await assert.rejects(() => finalizeStandalonePaid(completed, () => false), /checkout_context_changed/);
assert.equal((await readPaidOperation(op.id))?.localCompletion, 'pending');
await finalizeStandalonePaid(completed, () => true);
assert.equal((await readPaidOperation(op.id))?.localCompletion, 'done', 'standalone completion releases the guard only after exact local history');
assert.equal(serializeEnvelope(getLocalVaultVersion(keys.vaultId, completed.txId)!.envelope), serialized);
assert.equal(getLocalVaultVersion(keys.vaultId, completed.txId)?.parentId, binding.parentTxId);
assert.equal(getVaultSession()?.headTxId, completed.txId);
assert.equal(await findPaidAttempt({ vaultId: keys.vaultId }), null);

// Unknown wallet outcome has no local signature. Reference reconciliation is the
// only path; no new create, wallet invocation, reserve or blind broadcast occurs.
reset(); network = syntheticNetwork(); network.unknownWallet = true; walletCalls = 0;
op = await beginPaidOperation(input, signer.publicKey.toBase58(), '0', offered);
op = await preparePaidOperation(op.id, wallet(network));
await assert.rejects(() => payPaidOperation(op.id, op.preparation!.preparationId, wallet(network)), /lost wallet/);
await assert.rejects(() => cancelPaidOperation(op.id), /previous_payment_unresolved/);
await assert.rejects(() => payPaidOperation(op.id, op.preparation!.preparationId, wallet(network)), /previous_payment_unresolved/);
network.paid = true; op = await checkPaidOperation(op.id);
assert.ok(await paidCompletion(op)); assert.equal(walletCalls, 1); assert.equal(network.creates, 1); assert.equal(network.sends.length, 0);

// A proved 4001 allows cancellation, even when its response is lost. Only an
// explicit later acknowledgement resolves the local guard; it creates nothing.
reset(); network = syntheticNetwork(); network.rejectWallet = true;
op = await beginPaidOperation(input, signer.publicKey.toBase58(), '0', offered);
op = await preparePaidOperation(op.id, wallet(network));
await assert.rejects(() => payPaidOperation(op.id, op.preparation!.preparationId, wallet(network)), /synthetic rejection/);
network.loseCancel = true; await assert.rejects(() => cancelPaidOperation(op.id), /lost cancel/);
op = await readPaidStatus(op.id); assert.equal(op.snapshot?.cancelled, true);
assert.ok(await findPaidAttempt({ vaultId: keys.vaultId }));
await resolveReleasedPaidOperation(op.id); assert.equal(await findPaidAttempt({ vaultId: keys.vaultId }), null);
assert.equal(network.creates, 1); assert.equal(network.sends.length, 0);

reset(); network = syntheticNetwork(); walletCalls = 0;
op = await beginPaidOperation(input, signer.publicKey.toBase58(), '0', offered);
op = await preparePaidOperation(op.id, wallet(network));
let active = true; network.onSigned = () => { active = false; };
await assert.rejects(() => payPaidOperation(op.id, op.preparation!.preparationId, wallet(network), () => active), /checkout_context_changed/);
assert.ok((await readPaidOperation(op.id))?.signedTransaction, 'late wallet response retains exact recovery bytes');
assert.equal(walletCalls, 1); assert.equal(network.reserves, 0); assert.equal(network.sends.length, 0, 'closed context cannot reserve or broadcast');

reset(); network = syntheticNetwork(); network.dropBeforeAdmission = true;
await assert.rejects(() => beginPaidOperation(input, signer.publicKey.toBase58(), '0', offered), /before admission/);
op = (await findPaidAttempt({ treeId: second.meta.id }))!;
await assert.rejects(() => readPaidStatus(op.id), /order_not_found/); assert.equal(network.creates, 1, 'polling never creates an order');
network.missingStatus = 503;
await assert.rejects(() => retryPaidCreation(op.id), /order_not_found/); assert.equal(network.creates, 1, 'uncertain GET cannot authorize a POST');
network.missingStatus = 404;
network.missingCode = 'not_found';
await assert.rejects(() => retryPaidCreation(op.id), /not_found/);
assert.equal(network.creates, 1, 'a generic gateway 404 cannot authorize a POST');
network.missingCode = 'order_not_found';
const originalId = op.id;
op = await retryPaidCreation(op.id); assert.equal(op.id, originalId); assert.equal(op.serialized, serialized); assert.equal(network.creates, 2);
op = await retryPaidCreation(op.id); assert.equal(network.creates, 2, 'found order is adopted without another POST');
assert.equal((await cancelPaidCreation(op.id)).snapshot?.cancelled, undefined, 'existing order is adopted, never silently cancelled by key');

reset(); network = syntheticNetwork(); network.loseCreate = true;
await assert.rejects(() => beginPaidOperation(input, signer.publicKey.toBase58(), '0', offered), /lost create/);
op = (await findPaidAttempt({ treeId: second.meta.id }))!;
assert.equal(op.order, undefined);
op = await cancelPaidCreation(op.id);
assert.ok(op.order, 'an already admitted request wins the create/cancel-by-key race');
assert.equal(op.creationCancelled, undefined);
assert.equal(op.snapshot?.cancelled, undefined);
await assert.rejects(() => resolveReleasedPaidOperation(op.id), /previous_payment_unresolved/);
assert.equal(network.creates, 1); assert.equal(network.sends.length, 0);

reset(); network = syntheticNetwork(); network.dropBeforeAdmission = true;
await assert.rejects(() => beginPaidOperation(input, signer.publicKey.toBase58(), '0', offered), /before admission/);
op = (await findPaidAttempt({ treeId: second.meta.id }))!; network.loseCancel = true;
await assert.rejects(() => cancelPaidCreation(op.id), /lost cancel/);
op = await readPaidStatus(op.id); assert.equal(op.creationCancelled, true);
await assert.rejects(() => retryPaidCreation(op.id), /previous_payment_unresolved/);
await resolveReleasedPaidOperation(op.id); assert.equal(await findPaidAttempt({ treeId: second.meta.id }), null);
assert.equal(network.creates, 1); assert.equal(network.sends.length, 0);

// A portable receipt binds Mainnet storage even for a Devnet payment. Exact
// parent/order/hash and native node-data fallback are verified before decryption.
const receipt = completed.receipt, gateway = 'https://archive.example';
const pool = { candidates: async () => [{ url: gateway, source: 'synthetic' }], markSuccess() {}, markFailure() {} };
const tag = (name: string, value: string) => ({ name: Buffer.from(name).toString('base64url'), value: Buffer.from(value).toString('base64url') });
const metadata = { id: receipt.txId, owner: arOwner, reward: '100', tags: [tag('App-Name', 'SEJIRE'), tag('Type', 'vault-envelope'), tag('Schema', envelope.schema), tag('Protocol-Version', envelope.protocol),
  tag('Vault-Id', keys.vaultId), tag('Archive-SHA256', binding.digest), tag('Archive-Bytes', String(binding.bytes)), tag('Parent-Tx', binding.parentTxId), tag('Preservation-Id', receipt.orderId)] };
const receiptFetch: typeof fetch = async url => {
  const value = String(url); assert.ok(value.startsWith(gateway + '/'));
  if (value.endsWith('/data')) return new Response(Buffer.from(serialized).toString('base64url'));
  if (value.includes('/raw/')) return new Response('unavailable', { status: 404 });
  return new Response(JSON.stringify(metadata));
};
const restored = await retrievePaidReceipt(receipt, { vaultId: keys.vaultId, pool, fetcher: receiptFetch });
assert.equal(serializeEnvelope(restored), serialized); assert.deepEqual(await openEnvelope(keys, restored), vault);
await assert.rejects(() => retrievePaidReceipt({ ...receipt, archive: { ...receipt.archive, parentTxId: null } }, { vaultId: keys.vaultId, pool, fetcher: receiptFetch }), /metadata_mismatch/);

// Timeout covers headers plus a stalled body. The custom fetcher cannot access
// a network, and abort cancellation must finish the read without waiting 30 s.
let bodyCancelled = false;
globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { bodyCancelled = true; } }));
const abort = new AbortController(), read = readPaidPolicy(abort.signal);
await new Promise(resolve => setTimeout(resolve, 5)); abort.abort();
await assert.rejects(read, /timed_out/); assert.equal(bodyCancelled, true);
bodyCancelled = false;
globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { bodyCancelled = true; } }), { headers: { 'Content-Length': '999999999' } });
await assert.rejects(() => readPaidPolicy(), /response_too_large/); assert.equal(bodyCancelled, true, 'rejected headers also cancel the unread body');
console.log('paidClient.selftest: PASS (shared guard/CAS, lost create/reserve, exact payment, unknown wallet, cancellation, full vault/receipt, bounded body)');
