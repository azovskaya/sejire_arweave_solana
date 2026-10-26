import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { Keypair, Message, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { SolanaWalletAdapter } from '@ardrive/turbo-sdk/web';
import { createPaidOrderFromPolicy, createPaymentPreparation, paidPolicyHash, SOLANA_GENESIS, type ContributionPolicy, type PaidPolicy, type PaidReceipt } from '../../../../../packages/checkout/paid';
import { parseAmount } from '../../../../../packages/checkout/amounts';
import { parseRpcJson, rpcU64 } from '../../../../../packages/checkout/rpcJson';
import { createMnemonic } from '../crypto/bip39';
import { deriveKeysFromMnemonic } from '../crypto/keys';
import { encryptJson } from '../crypto/encrypt';
import { serializeEnvelope } from '../crypto/envelope';
import { emptyVault, openEnvelope, putTree } from '../crypto/vault';
import { createTree } from '../treeEngine';
import { envelopeDigest } from '../solana/policy';
import { parsePortableBackup } from '../crypto/backup';
import { readPaidAccess, writePaidAccess, readPaidOperation, writePaidOperation, findPaidAttempt, findContributionAttempt } from './paidJournal';
import { findPreservationAttempt, reservePaidAttempt, saveGuardedFundAttempt, clearGuardedFundAttempt } from './vaultGuard';
import { beginPaidOperation, readPaidStatus, preparePaidOperation, payPaidOperation, checkPaidOperation,
  readPaidPolicy, validatePaidSnapshot, paidCompletion, cancelPaidOperation, resolveReleasedPaidOperation, PaidApiError } from './paidClient';
import { cancelPaidCreation, retryPaidCreation, contributionReceipt, completeContributionLocally } from './paidClient';
import { retrievePaidReceipt } from './paidReceipt';
import { finalizeStandalonePaid } from './paidFinalize';
import { getLocalVaultVersion } from '../vaultSession/localArchive';
import { getVaultSession } from '../vaultSession/session';
import type { PaidOperation, PaidPolicyResponse, PaidSnapshot } from './paidTypes';

class MemoryStorage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, String(value)); }
  removeItem(key: string) { this.data.delete(key); }
}
function reset(onLockRequest?: (name: string) => void) {
  const queues = new Map<string, Promise<unknown>>();
  Object.defineProperties(globalThis, {
    indexedDB: { configurable: true, value: new IDBFactory() },
    localStorage: { configurable: true, value: new MemoryStorage() },
    sessionStorage: { configurable: true, value: new MemoryStorage() },
    location: { configurable: true, value: { origin: 'https://checkout.example' } },
    navigator: { configurable: true, value: { locks: { request<T>(name: string, _options: unknown, work: () => Promise<T>) {
      onLockRequest?.(name);
      const result = (queues.get(name) ?? Promise.resolve()).then(work);
      queues.set(name, result.catch(() => {})); return result;
    } } } },
  });
}
function barrier() {
  let open!: () => void, fail!: (reason: unknown) => void;
  const wait = new Promise<void>((resolve, reject) => { open = resolve; fail = reject; });
  return { wait, open, fail };
}
async function putRawOperation(value: unknown, name = 'sejire-checkout-journal') {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try { await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('operations', 'readwrite'); transaction.objectStore('operations').put(value);
    transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(transaction.error);
  }); } finally { database.close(); }
}
async function readRawOperations(name = 'sejire-checkout-journal'): Promise<unknown[]> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try { return await new Promise((resolve, reject) => {
    const request = database.transaction('operations').objectStore('operations').getAll();
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  }); } finally { database.close(); }
}
const address = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const signer = Keypair.fromSeed(new Uint8Array(32).fill(17)); // Public software fixture, never a funded wallet.
const arOwner = Buffer.from(new Uint8Array(512).fill(19)).toString('base64url');
const arAddress = createHash('sha256').update(Buffer.from(arOwner, 'base64url')).digest('base64url');
const policy: PaidPolicy = { schema: 'sejire/checkout-policy/v1', version: 'synthetic-v1', network: 'devnet',
  genesisHash: SOLANA_GENESIS.devnet, serviceLamports: '30000000', serviceRecipient: address(2), fundRecipient: address(3),
  storage: { kind: 'arweave-direct', network: 'arweave.N.1', treasuryAddress: arAddress, budgetId: 'synthetic-paid', maxBytes: 524288, maxRewardWinston: '10000000000' } };
const contributionPolicy: ContributionPolicy = { schema: 'sejire/contribution-policy/v1', version: 'synthetic-help-v1',
  network: policy.network, genesisHash: policy.genesisHash, serviceLamports: '0', serviceRecipient: policy.serviceRecipient, fundRecipient: policy.fundRecipient };
const policyHash = await paidPolicyHash(policy), contributionPolicyHash = await paidPolicyHash(contributionPolicy);
const offered: PaidPolicyResponse = { ready: true, policy, policyHash, contributionReady: true, contributionPolicy, contributionPolicyHash };
const helpOffered: PaidPolicyResponse = { ready: false, contributionReady: true, contributionPolicy, contributionPolicyHash };
const words = createMnemonic(), keys = deriveKeysFromMnemonic(words);
const first = createTree('Synthetic first'), second = createTree('Synthetic second');
const vault = putTree(putTree(emptyVault(keys.vaultId), first), second);
const envelope = await encryptJson(keys.encKey, keys.vaultId, vault), serialized = serializeEnvelope(envelope);
const binding = { digest: await envelopeDigest(serialized), bytes: new TextEncoder().encode(serialized).length, vaultId: keys.vaultId, parentTxId: 'P'.repeat(43) };
const input = { mode: 'create' as const, envelope, parentTxId: binding.parentTxId, treeId: second.meta.id };
const candidate = (id: string): PaidOperation => ({ version: 2, id, revision: 0, token: 'f'.repeat(64), createdAt: Date.now(), treeId: second.meta.id,
  serialized, archive: binding, policy, policyHash, intent: { kind: 'preservation', payer: signer.publicKey.toBase58(), contribution: '0' },
  createAttempted: false, signingStarted: false, localCompletion: 'pending' });
const contributionCandidate = (id: string): PaidOperation => ({ ...candidate(id), treeId: null, archive: null, serialized: null,
  policy: contributionPolicy, policyHash: contributionPolicyHash, intent: { kind: 'contribution', payer: signer.publicKey.toBase58(), contribution: '0.1' } });

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

// New help records never enter the rollback preservation reader's database.
reset();
const preservation = await reservePaidAttempt(candidate('5'.repeat(32)));
const beforeHelp = await readRawOperations();
const [helpOne, helpTwo] = await Promise.all([
  reservePaidAttempt(contributionCandidate('6'.repeat(32))), reservePaidAttempt(contributionCandidate('7'.repeat(32))),
]);
assert.equal(helpOne.id, helpTwo.id, 'cross-tab help reservation adopts one immutable intent');
assert.deepEqual(await readRawOperations(), beforeHelp, 'old v2 reader sees exactly the original preservation rows');
assert.equal((await readRawOperations('sejire-contribution-journal')).length, 1);
assert.equal((await findPaidAttempt({ vaultId: keys.vaultId }))?.id, preservation.id);
assert.equal((await findContributionAttempt())?.id, helpOne.id);
await assert.rejects(() => writePaidOperation({ ...helpOne, archive: binding }), /invalid_paid_attempt/);
await assert.rejects(() => writePaidOperation({ ...helpOne, intent: { ...helpOne.intent, contribution: '0' } }), /invalid_paid_attempt/);

reset(); await findPaidAttempt({ vaultId: keys.vaultId });
const earlyHelp = { ...contributionCandidate('8'.repeat(32)), revision: 1, policy, policyHash };
await putRawOperation(earlyHelp);
assert.equal((await findContributionAttempt())?.id, earlyHelp.id, 'an earlier help record remains recoverable in its original namespace');
await writePaidOperation({ ...earlyHelp, createAttempted: true });
assert.equal((await readPaidOperation(earlyHelp.id))?.revision, 2);
assert.equal((await readRawOperations()).length, 1);
assert.deepEqual(await readRawOperations('sejire-contribution-journal'), [], 'recovery does not copy or replace the old operation');

// The precision boundary is tested with literal JSON, never rounded JS input.
const exactRpc = parseRpcJson('{"id":1,"amount":9007199254740993,"max":18446744073709551615,"quoted":"9007199254740993 \\\" value","array":[0,1.0,1e3,-0]}') as Record<string, unknown>;
assert.equal(exactRpc.id, 1); assert.equal(rpcU64(exactRpc.amount), '9007199254740993');
assert.equal(rpcU64(exactRpc.max), '18446744073709551615');
assert.equal(exactRpc.quoted, '9007199254740993 " value');
for (const value of [...(exactRpc.array as unknown[]).slice(1), '18446744073709551616', 9007199254740992, -1, null]) {
  assert.throws(() => rpcU64(value), /invalid_rpc_integer/);
}
for (const source of ['{9007199254740993:1}', '[01]', '{"x":9007199254740993e}', '{"x":NaN}']) {
  assert.throws(() => parseRpcJson(source), SyntaxError, 'lossless transformation must preserve JSON syntax rejection');
}

type NetworkState = { snapshot?: PaidSnapshot; key?: string; creates: number; prepares: number; reserves: number; sends: string[]; sessions: number;
  loseCreate?: boolean; loseReserve?: boolean; loseCancel?: boolean; rejectWallet?: boolean; unknownWallet?: boolean;
  signature?: string; wrongGenesis?: boolean; paid: boolean; executed: boolean; onSigned?: () => void;
  dropBeforeAdmission?: boolean; tombstone?: boolean; missingStatus?: number; missingCode?: string;
  balance?: string; offer?: PaidPolicyResponse; sessionToken?: string; beforeSessionResponse?: () => Promise<void> };
function syntheticNetwork(): NetworkState {
  const state: NetworkState = { creates: 0, prepares: 0, reserves: 0, sends: [], sessions: 0, paid: false, executed: false };
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url, init) => {
    const target = String(url), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined;
    assert.ok(!target.includes(words) && !String(init?.body ?? '').includes(words));
    if (target === 'https://api.devnet.solana.com') {
      assert.equal(method, 'POST'); let result: unknown;
      if (body.method === 'getGenesisHash') result = state.wrongGenesis ? SOLANA_GENESIS['mainnet-beta'] : SOLANA_GENESIS.devnet;
      else if (body.method === 'getFeeForMessage') result = { value: 5000 };
      else if (body.method === 'getBalance') return new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(body.id)},"result":{"value":${state.balance ?? '18446744073709551615'}}}`, { headers: { 'Content-Type': 'application/json' } });
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
    if (path === '/policy' || path === '/policy/contribution') { assert.equal(method, 'GET'); return json(state.offer ?? (path === '/policy/contribution' ? helpOffered : offered)); }
    if (path === '/session') {
      assert.equal(method, 'POST'); state.sessions++;
      await state.beforeSessionResponse?.();
      return json({ accessToken: state.sessionToken ?? 'f'.repeat(64), expiresAt: Date.now() + 3600000 });
    }
    if (path === '/orders' && method === 'POST') {
      state.creates++; state.key = new Headers(init?.headers).get('Idempotency-Key')!;
      const stored = await readPaidOperation(state.key);
      assert.ok(stored?.createAttempted); assert.equal(stored.token, state.sessionToken ?? 'f'.repeat(64));
      if (body.kind === 'contribution') {
        assert.equal(Object.hasOwn(body, 'serialized'), false); assert.equal(Object.hasOwn(body, 'archive'), false);
        assert.equal(stored.serialized, null); assert.equal(stored.archive, null); assert.equal(stored.treeId, null);
      } else {
        assert.equal(stored.serialized, body.serialized); assert.equal(body.serialized, serialized);
        assert.deepEqual(stored.archive, body.archive);
      }
      if (state.tombstone) return json({ error: 'paid_request_cancelled' }, 409);
      if (state.dropBeforeAdmission) { state.dropBeforeAdmission = false; throw TypeError('synthetic dropped before admission'); }
      const chosenPolicy = body.kind === 'contribution' ? contributionPolicy : policy;
      const contribution = parseAmount(body.contribution, 9);
      const order = await createPaidOrderFromPolicy(chosenPolicy, { id: state.key, payer: body.payer, reference: address(4), createdAt: Date.now() - 1,
        expiresAt: Date.now() + 120000, kind: body.kind, ...(body.archive ? { archive: body.archive } : {}), contribution });
      state.snapshot = { record: { order, states: { payment: 'awaiting-payment', preservation: body.kind === 'contribution' ? 'not-applicable' : 'awaiting-payment',
        contribution: contribution === '0' ? 'not-requested' : 'awaiting-payment' } }, policy: chosenPolicy, execution: null, preparation: null, expired: false };
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
      if (snapshot.record.order.fundContribution.amount !== '0') snapshot.record.states.contribution = 'requires-reconciliation';
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
        snapshot.record.states.payment = 'verified';
        snapshot.record.states.contribution = snapshot.record.order.fundContribution.amount === '0' ? 'not-requested' : 'received';
        if (snapshot.record.order.kind === 'preservation') {
          snapshot.record.states.preservation = 'ready';
          snapshot.execution = { kind: 'arweave-direct', txId: null, status: 'queued', verification: null };
        }
        snapshot.verification = { status: 'verified' };
      } else snapshot.verification = { status: 'requires-reconciliation', reason: 'not-found' };
      return json(snapshot);
    }
    if (path.endsWith('/execute')) {
      assert.equal(snapshot.record.order.kind, 'preservation', 'standalone help must never execute storage');
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
await assert.rejects(() => beginPaidOperation(input, signer.publicKey.toBase58(), '0', offered),
  error => error instanceof PaidApiError && error.stage === 'create' && error.status === 0 && error.message === 'checkout_transport_failed');
let op = (await findPaidAttempt({ vaultId: keys.vaultId }))!;
assert.equal(op.order, undefined); assert.equal(op.serialized, serialized);
op = await readPaidStatus(op.id); assert.ok(op.order);
assert.equal((await beginPaidOperation(input, signer.publicKey.toBase58(), '0', offered)).id, op.id);
assert.equal(network.creates, 1, 'lost create and later explicit click issue no duplicate POST');
for (const mutate of [
  (s: PaidSnapshot) => { if(s.record.order.kind!=='preservation')throw Error();s.record.order = { ...s.record.order, archive: { ...s.record.order.archive, parentTxId: 'Q'.repeat(43) } }; },
  (s: PaidSnapshot) => { if(s.record.order.kind!=='preservation')throw Error();s.record.order = { ...s.record.order, archive: { ...s.record.order.archive, digest: '0'.repeat(64) } }; },
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
await assert.rejects(() => beginPaidOperation(input, signer.publicKey.toBase58(), '0', offered), /checkout_transport_failed/);
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
await assert.rejects(() => beginPaidOperation(input, signer.publicKey.toBase58(), '0', offered), /checkout_transport_failed/);
op = (await findPaidAttempt({ treeId: second.meta.id }))!;
assert.equal(op.order, undefined);
op = await cancelPaidCreation(op.id);
assert.ok(op.order, 'an already admitted request wins the create/cancel-by-key race');
assert.equal(op.creationCancelled, undefined);
assert.equal(op.snapshot?.cancelled, undefined);
await assert.rejects(() => resolveReleasedPaidOperation(op.id), /previous_payment_unresolved/);
assert.equal(network.creates, 1); assert.equal(network.sends.length, 0);

reset(); network = syntheticNetwork(); network.dropBeforeAdmission = true;
await assert.rejects(() => beginPaidOperation(input, signer.publicKey.toBase58(), '0', offered), /checkout_transport_failed/);
op = (await findPaidAttempt({ treeId: second.meta.id }))!; network.loseCancel = true;
await assert.rejects(() => cancelPaidCreation(op.id), /lost cancel/);
op = await readPaidStatus(op.id); assert.equal(op.creationCancelled, true);
await assert.rejects(() => retryPaidCreation(op.id), /previous_payment_unresolved/);
await resolveReleasedPaidOperation(op.id); assert.equal(await findPaidAttempt({ treeId: second.meta.id }), null);
assert.equal(network.creates, 1); assert.equal(network.sends.length, 0);

// Hold the first /session response until a second tab has requested the same
// bootstrap lock. This forces overlap without depending on timers or IDB luck.
// Without the full read/create/write lock the second HTTP request wins instead.
const sessionStarted = barrier(), releaseSession = barrier(), queuedAccess = barrier(), duplicateSession = barrier();
let accessRequests = 0;
reset(name => { if (name === 'sejire.paid-access.v1' && ++accessRequests === 2) queuedAccess.open(); });
network = syntheticNetwork(); network.sessionToken = 'a'.repeat(64);
const previousOwner = await reservePaidAttempt(candidate('9'.repeat(32)));
await writePaidAccess(previousOwner.token, Date.now() + 30000); // Valid cache entry due for renewal.
network.beforeSessionResponse = async () => {
  if (network.sessions === 1) { sessionStarted.open(); await releaseSession.wait; }
  else duplicateSession.open();
};
const firstBootstrap = beginPaidOperation({ mode: 'contribution' }, signer.publicKey.toBase58(), '0.1', helpOffered);
void firstBootstrap.catch(sessionStarted.fail);
await sessionStarted.wait;
const secondBootstrap = beginPaidOperation({ mode: 'contribution' }, signer.publicKey.toBase58(), '0.2', helpOffered);
const bootstraps = Promise.allSettled([firstBootstrap, secondBootstrap]);
try {
  const blockedAtLock = await Promise.race([queuedAccess.wait.then(() => true), duplicateSession.wait.then(() => false)]);
  assert.equal(blockedAtLock, true, 'second tab queues before creating another checkout session');
  assert.equal(network.sessions, 1);
  assert.equal((await readPaidAccess())?.token, previousOwner.token, 'old cache remains intact while renewal is in flight');
} finally { releaseSession.open(); }
const bootstrapResults = await bootstraps;
for (const result of bootstrapResults) if (result.status === 'rejected') throw result.reason;
assert.ok(bootstrapResults[0].status === 'fulfilled' && bootstrapResults[1].status === 'fulfilled');
assert.equal(bootstrapResults[0].value.id, bootstrapResults[1].value.id);
assert.equal(network.sessions, 1); assert.equal(network.creates, 1);
assert.equal(bootstrapResults[0].value.token, network.sessionToken);
assert.equal((await readPaidAccess())?.token, network.sessionToken);
assert.deepEqual(await readPaidOperation(previousOwner.id), previousOwner, 'session renewal never changes an existing operation or its owner token');

reset(); network = syntheticNetwork();
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
await assert.rejects(() => beginPaidOperation({ mode: 'contribution' }, signer.publicKey.toBase58(), '0.1', helpOffered), /storage_unavailable/);
assert.equal(network.sessions, 0); assert.equal(network.creates, 0, 'missing cross-tab locks stops before session creation');

// A standalone offer needs no preservation policy, encrypted tree, AR proof or
// storage execution. Concurrent tabs preserve one intent and one wallet call.
reset(); network = syntheticNetwork(); walletCalls = 0;
assert.deepEqual(await readPaidPolicy(undefined, 'contribution'), helpOffered);
await assert.rejects(() => beginPaidOperation({ mode: 'contribution' }, signer.publicKey.toBase58(), '0', helpOffered), /invalid_contribution_order/);
assert.equal(network.creates, 0);
const [startedHelp, adoptedHelp] = await Promise.all([
  beginPaidOperation({ mode: 'contribution' }, signer.publicKey.toBase58(), '9007199.254740993', helpOffered),
  beginPaidOperation({ mode: 'contribution' }, signer.publicKey.toBase58(), '0.5', helpOffered),
]);
assert.equal(startedHelp.id, adoptedHelp.id); assert.equal(network.creates, 1);
op = await preparePaidOperation(startedHelp.id, wallet(network));
assert.equal(op.order?.fundContribution.amount, '9007199254740993');
assert.equal(op.order?.servicePayment.amount, '0');
assert.equal(op.serialized, null); assert.equal(op.archive, null); assert.equal(op.treeId, null);
assert.equal(Transaction.populate(Message.from(Buffer.from(op.preparation!.messageBase64, 'base64'))).instructions.length, 1);
await assert.rejects(() => completeContributionLocally(op.id), /checkout_completion_mismatch/);
network.balance = '9007199254745992'; // Exactly one lamport below amount + fee, above safe Number.
await assert.rejects(() => payPaidOperation(op.id, op.preparation!.preparationId, wallet(network)), /insufficient_wallet_balance/);
assert.equal(walletCalls, 0); assert.equal(network.reserves, 0); assert.equal(network.sends.length, 0);
for (const invalidBalance of ['1e19', '18446744073709551615.0', '18446744073709551616', '-0']) {
  network.balance = invalidBalance;
  await assert.rejects(() => payPaidOperation(op.id, op.preparation!.preparationId, wallet(network)), /invalid_rpc_integer/);
  assert.equal(walletCalls, 0, 'invalid or non-integer RPC amount is rejected before a wallet opens');
}
network.balance = '9007199254745993';
const paidHelp = await Promise.allSettled([
  payPaidOperation(op.id, op.preparation!.preparationId, wallet(network)),
  payPaidOperation(op.id, op.preparation!.preparationId, wallet(network)),
]);
assert.equal(paidHelp.filter(result => result.status === 'fulfilled').length, 1);
assert.equal(walletCalls, 1); assert.equal(network.reserves, 1); assert.equal(network.sends.length, 1);
op = await checkPaidOperation(op.id);
assert.equal(network.executed, false); assert.equal(op.snapshot?.execution, null);
assert.equal(await paidCompletion(op), null, 'help never produces a tree completion');
const helpReceipt = await contributionReceipt(op);
assert.equal(helpReceipt.contributionLamports, '9007199254740993');
assert.equal(helpReceipt.paymentSignature, op.signature); assert.equal(helpReceipt.serviceLamports, '0');
assert.equal(Object.hasOwn(helpReceipt, 'archive'), false); assert.equal(Object.hasOwn(helpReceipt, 'txId'), false);
const invalidHelpSnapshot = structuredClone(op.snapshot!);
invalidHelpSnapshot.record.states.contribution = 'awaiting-payment';
await assert.rejects(() => validatePaidSnapshot(op, invalidHelpSnapshot), /checkout_state_mismatch/);
const invalidExecution = structuredClone(op.snapshot!);
invalidExecution.execution = { kind: 'arweave-direct', txId: null, status: 'queued', verification: null };
await assert.rejects(() => validatePaidSnapshot(op, invalidExecution), /checkout_execution_mismatch/);
await assert.rejects(() => contributionReceipt({ ...op, snapshot: invalidHelpSnapshot }), /checkout_state_mismatch/);
const intactHelp = op;
await putRawOperation({ ...op, snapshot: invalidHelpSnapshot }, 'sejire-contribution-journal');
await assert.rejects(() => completeContributionLocally(op.id), /checkout_state_mismatch/);
assert.equal((await readPaidOperation(op.id))?.localCompletion, 'pending', 'corrupt local snapshot cannot release a help payment');
await putRawOperation(intactHelp, 'sejire-contribution-journal');
localStorage.setItem('synthetic-tree-before-help', JSON.stringify(vault));
sessionStorage.setItem('synthetic-head-before-help', binding.parentTxId!);
const storageImage = (storage: Storage) => Array.from({ length: storage.length }, (_, index) => storage.key(index)!)
  .sort().map(key => [key, storage.getItem(key)]);
const localBefore = storageImage(localStorage), sessionBefore = storageImage(sessionStorage);
await completeContributionLocally(op.id);
await completeContributionLocally(op.id);
assert.equal((await readPaidOperation(op.id))?.localCompletion, 'done');
assert.equal(await findContributionAttempt(), null);
assert.deepEqual(storageImage(localStorage), localBefore, 'help completion does not write a local archive/tree');
assert.deepEqual(storageImage(sessionStorage), sessionBefore, 'help completion does not move a vault head/session');
assert.deepEqual(await readRawOperations(), [], 'old rollback clients see no new standalone rows');
const oldHelpId = op.id;
op = await beginPaidOperation({ mode: 'contribution' }, signer.publicKey.toBase58(), '0.000000001', helpOffered);
assert.notEqual(op.id, oldHelpId); assert.equal(op.order?.fundContribution.amount, '1');
assert.equal((await readPaidOperation(oldHelpId))?.localCompletion, 'done', 'explicit next help retains the completed record');
assert.equal(network.creates, 2); assert.equal(walletCalls, 1, 'new intent does not automatically sign or pay');

// Help recovery uses the original amount/key after lost creation, reserve, or
// unknown wallet responses; opening/polling never asks for another signature.
reset(); network = syntheticNetwork(); network.loseCreate = true; walletCalls = 0;
await assert.rejects(() => beginPaidOperation({ mode: 'contribution' }, signer.publicKey.toBase58(), '0.1', helpOffered),
  error => error instanceof PaidApiError && error.stage === 'create' && error.status === 0 && error.message === 'checkout_transport_failed');
op = (await findContributionAttempt())!;
op = await readPaidStatus(op.id); assert.equal(op.order?.fundContribution.amount, '100000000');
assert.equal((await beginPaidOperation({ mode: 'contribution' }, signer.publicKey.toBase58(), '0.2', helpOffered)).id, op.id);
assert.equal(network.creates, 1);
op = await preparePaidOperation(op.id, wallet(network));
network.loseReserve = true;
await assert.rejects(() => payPaidOperation(op.id, op.preparation!.preparationId, wallet(network)), /lost reserve/);
assert.equal(network.sends.length, 0);
const helpBytes = (await readPaidOperation(op.id))!.signedTransaction;
op = await checkPaidOperation(op.id);
op = await checkPaidOperation(op.id);
assert.deepEqual(network.sends, [helpBytes]); assert.equal(walletCalls, 1); assert.equal(network.executed, false);
await completeContributionLocally(op.id);

reset(); network = syntheticNetwork(); network.unknownWallet = true; walletCalls = 0;
op = await beginPaidOperation({ mode: 'contribution' }, signer.publicKey.toBase58(), '0.1', helpOffered);
op = await preparePaidOperation(op.id, wallet(network));
await assert.rejects(() => payPaidOperation(op.id, op.preparation!.preparationId, wallet(network)), /lost wallet/);
await assert.rejects(() => cancelPaidOperation(op.id), /previous_payment_unresolved/);
await assert.rejects(() => payPaidOperation(op.id, op.preparation!.preparationId, wallet(network)), /previous_payment_unresolved/);
network.paid = true; op = await checkPaidOperation(op.id);
await completeContributionLocally(op.id);
assert.equal(walletCalls, 1); assert.equal(network.creates, 1); assert.equal(network.sends.length, 0); assert.equal(network.executed, false);

reset(); network = syntheticNetwork(); network.rejectWallet = true; walletCalls = 0;
op = await beginPaidOperation({ mode: 'contribution' }, signer.publicKey.toBase58(), '0.1', helpOffered);
op = await preparePaidOperation(op.id, wallet(network));
await assert.rejects(() => payPaidOperation(op.id, op.preparation!.preparationId, wallet(network)), /synthetic rejection/);
network.loseCancel = true;
await assert.rejects(() => cancelPaidOperation(op.id), /lost cancel/);
op = await readPaidStatus(op.id); assert.equal(op.snapshot?.cancelled, true);
await resolveReleasedPaidOperation(op.id);
assert.equal(await findContributionAttempt(), null); assert.equal(network.creates, 1); assert.equal(network.sends.length, 0);

// Optional help is one extra transfer in the same preservation transaction.
reset(); network = syntheticNetwork(); walletCalls = 0;
op = await beginPaidOperation(input, signer.publicKey.toBase58(), '0.000000001', offered);
op = await preparePaidOperation(op.id, wallet(network));
op = await payPaidOperation(op.id, op.preparation!.preparationId, wallet(network));
op = await checkPaidOperation(op.id);
assert.equal(network.sends.length, 1); assert.equal(walletCalls, 1);
assert.equal(Transaction.from(Buffer.from(network.sends[0], 'base64')).instructions.length, 2);
assert.equal(op.order?.servicePayment.amount, '30000000'); assert.equal(op.order?.fundContribution.amount, '1');
assert.ok(await paidCompletion(op)); assert.equal(network.executed, true);

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
console.log('paidClient.selftest: PASS (preserved legacy journal, serialized session bootstrap, independent help policy/receipt, u64 RPC precision, cross-tab single payment, lost create/reserve/wallet, cancellation, exact full-vault receipt, no help archive/head change, bounded body)');
