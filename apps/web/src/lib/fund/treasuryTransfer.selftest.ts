import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import type { JWKInterface } from 'arweave/web/lib/wallet';
import { directCrypto } from '../directArweave/transaction';
import type { DirectWallet, DirectRawTransaction } from '../directArweave/types';
import type { TreasuryTopup } from './adminClient';
import { quoteTreasuryTransfer, recoverTreasuryTransfer, signTreasuryTransfer, submitTreasuryTransfer, type TransferAuthority } from './treasuryTransfer';
import { readTransferAttempt, type TransferWire } from './treasuryTransferStore';

// Synthetic ephemeral signer. The private key stays in this test process; every network call is mocked.
const ar = directCrypto(), { privateKey } = generateKeyPairSync('rsa', { modulusLength: 4096 });
const jwk = privateKey.export({ format: 'jwk' }) as JWKInterface, owner = await ar.wallets.jwkToAddress(jwk);
const node = 'https://synthetic-topup.example', originalFetch = globalThis.fetch;
const intent: TreasuryTopup = { id: 'a'.repeat(32), address: 'B'.repeat(43), amountWinston: '10000', status: 'prepared', baselineHeight: 1,
  priorCeilingWinston: '0', preparedRevision: 0, createdAt: 1, txId: null, creditedWinston: null, creditedRevision: null, confirmedAt: null,
  transferTag: { name: 'SEJIRE-Topup-Intent', value: 'b'.repeat(64) } };
function browser() {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  const tails = new Map<string, Promise<void>>();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (name: string, _options: unknown, action: () => Promise<unknown>) => {
    const before = tails.get(name) ?? Promise.resolve(); let release = () => {};
    const active = new Promise<void>(resolve => { release = resolve; }); tails.set(name, before.then(() => active));
    await before; try { return await action(); } finally { release(); }
  } } } });
}
function fixture() {
  browser();
  const state = { connects: 0, signatures: 0, postBodies: [] as string[], claimCalls: 0, signedCalls: 0,
    transfer: null as TransferWire | null, reward: '1000', losePost: false, loseClaim: false, mismatchReadback: false,
    alterTarget: false, holdSignature: false, release: null as null | (() => Promise<void>) };
  const authority: TransferAuthority = {
    read: async () => state.transfer ? structuredClone(state.mismatchReadback && state.signedCalls ? { ...state.transfer, signedTx: null, txId: null } : state.transfer) : null,
    claim: async input => {
      state.claimCalls++;
      if (state.transfer) {
        if (state.transfer.claimId !== input.claimId || state.transfer.unsignedTx !== input.unsignedTx) throw Error('topup_transfer_conflict');
        return { transfer: structuredClone(state.transfer), reused: true };
      }
      state.transfer = { ...input, signedTx: null, txId: null };
      if (state.loseClaim) throw Error('synthetic lost claim acknowledgement');
      return { transfer: structuredClone(state.transfer), reused: false };
    },
    signed: async input => {
      state.signedCalls++;
      assert.equal(input.claimId, state.transfer?.claimId);
      const raw = JSON.parse(input.signedTx);
      if (state.transfer!.signedTx && state.transfer!.signedTx !== input.signedTx) throw Error('topup_transfer_conflict');
      const reused = Boolean(state.transfer!.signedTx);
      state.transfer = { ...state.transfer!, signedTx: input.signedTx, txId: raw.id };
      return { transfer: structuredClone(state.transfer), reused };
    },
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)); assert.equal(url.origin, node);
    assert.equal(new Headers(init.headers).get('Authorization'), null);
    assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal(init.redirect, 'error');
    if (url.pathname === '/info') return Response.json({ network: 'arweave.N.1' });
    if (url.pathname.startsWith('/price/')) { assert.equal(url.pathname, `/price/0/${intent.address}`); return new Response(state.reward); }
    if (url.pathname.endsWith('/balance')) return new Response('999999999');
    if (url.pathname === '/tx_anchor') return new Response('C'.repeat(64));
    if (url.pathname === '/tx' && init.method === 'POST') {
      const body = String(init.body);
      assert.equal(body, state.transfer!.signedTx, 'server has exact signed bytes before any network send');
      assert.equal(body, (await readTransferAttempt(intent.id))!.signedTx, 'browser commits bytes before send');
      state.postBodies.push(body);
      if (state.losePost) throw Error('synthetic lost send acknowledgment');
      return new Response('', { status: 200 });
    }
    throw Error('unmocked test request');
  };
  const wallet: DirectWallet = {
    connect: async permissions => { state.connects++; assert.deepEqual(permissions, ['ACCESS_ADDRESS', 'ACCESS_PUBLIC_KEY', 'SIGN_TRANSACTION']); },
    getActiveAddress: async () => owner, getActivePublicKey: async () => jwk.n,
    sign: async value => {
      state.signatures++;
      const local = await readTransferAttempt(intent.id);
      assert(local?.walletInvoked); assert.equal(local.unsignedTx, state.transfer?.unsignedTx, 'durable server and browser claims precede prompt');
      const tx = ar.transactions.fromRaw({ ...(value as { toJSON(): DirectRawTransaction }).toJSON(), ...(state.alterTarget ? { target: 'D'.repeat(43) } : {}) });
      tx.addTag('Signing-Client', 'Synthetic Wander'); tx.addTag('Signing-Client-Version', '1.0.0');
      const finish = async () => { await ar.transactions.sign(tx, jwk); return tx.toJSON(); };
      if (!state.holdSignature) return finish();
      return new Promise(resolve => { state.release = async () => { resolve(await finish()); }; });
    },
  };
  return { state, authority, wallet, options: { nodes: [node] } };
}
let passed = 0;
async function test(name: string, action: () => Promise<void>) { await action(); console.log(`PASS ${name}`); passed++; }
async function eventuallySigned() {
  for (let i = 0; i < 40; i++) { const record = await readTransferAttempt(intent.id); if (record?.signedTx) return record; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw Error('late synthetic signature not recorded');
}
try {
  await test('owner preview is read-only; one signature survives lost send acknowledgment and clean-browser recovery', async () => {
    const f = fixture(), quote = await quoteTreasuryTransfer(intent, f.wallet, f.options);
    assert.equal(quote.rewardWinston, '1000'); assert.equal(f.state.signatures, 0); assert.equal(f.state.postBodies.length, 0);
    const signed = await signTreasuryTransfer(intent, quote, f.wallet, f.authority, f.options);
    assert.equal(f.state.signatures, 1); assert(signed.signedTx); assert.equal(f.state.postBodies.length, 0);
    f.state.losePost = true;
    await assert.rejects(() => submitTreasuryTransfer(intent, f.authority, f.options));
    const afterLoss = await readTransferAttempt(intent.id); assert.equal(afterLoss!.signedTx, signed.signedTx); assert(afterLoss!.submissionStarted);
    f.state.losePost = false;
    await submitTreasuryTransfer(intent, f.authority, f.options);
    assert.equal(f.state.signatures, 1); assert.equal(new Set(f.state.postBodies).size, 1);
    browser(); // A clean browser recovers the same public signature from the authorized operator.
    const recovered = await recoverTreasuryTransfer(intent, f.authority);
    assert.equal(recovered.local!.signedTx, signed.signedTx);
    await submitTreasuryTransfer(intent, f.authority, f.options);
    assert.equal(f.state.signatures, 1); assert.equal(new Set(f.state.postBodies).size, 1);
  });
  await test('unknown wallet response blocks another signature; a late result is stored without sending', async () => {
    const f = fixture(); f.state.holdSignature = true;
    const quote = await quoteTreasuryTransfer(intent, f.wallet, f.options);
    await assert.rejects(() => signTreasuryTransfer(intent, quote, f.wallet, f.authority, { ...f.options, walletTimeoutMs: 5 }), /topup_signature_pending/);
    await assert.rejects(() => signTreasuryTransfer(intent, quote, f.wallet, f.authority, f.options), /topup_signature_pending/);
    assert.equal(f.state.signatures, 1); assert.equal(f.state.postBodies.length, 0);
    await f.state.release!(); await eventuallySigned();
    assert.equal(f.state.signedCalls, 0); assert.equal(f.state.postBodies.length, 0);
  });
  await test('leaving the admin page never broadcasts a late valid wallet signature', async () => {
    const f = fixture(); f.state.holdSignature = true;
    const quote = await quoteTreasuryTransfer(intent, f.wallet, f.options), lifetime = new AbortController();
    const signing = signTreasuryTransfer(intent, quote, f.wallet, f.authority, { ...f.options, signal: lifetime.signal });
    for (let i = 0; i < 50 && !f.state.release; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert(f.state.release); lifetime.abort(); await assert.rejects(signing, /operation_cancelled/);
    await f.state.release!(); await eventuallySigned();
    assert.equal(f.state.signatures, 1); assert.equal(f.state.postBodies.length, 0); assert.equal(f.state.signedCalls, 0);
  });
  await test('lost server claim acknowledgment fences signing in the original and a clean browser', async () => {
    const f = fixture(); f.state.loseClaim = true;
    const quote = await quoteTreasuryTransfer(intent, f.wallet, f.options);
    await assert.rejects(() => signTreasuryTransfer(intent, quote, f.wallet, f.authority, f.options));
    assert.equal(f.state.signatures, 0); assert(f.state.transfer); browser();
    const recovered = await recoverTreasuryTransfer(intent, f.authority); assert(recovered.remote); assert.equal(recovered.local, null);
    await assert.rejects(() => signTreasuryTransfer(intent, quote, f.wallet, f.authority, f.options), /topup_signature_pending/);
    assert.equal(f.state.signatures, 0); assert.equal(f.state.postBodies.length, 0);
  });
  await test('changed recipient and a missing signed readback stop submission', async () => {
    let f = fixture(); f.state.alterTarget = true;
    let quote = await quoteTreasuryTransfer(intent, f.wallet, f.options);
    await assert.rejects(() => signTreasuryTransfer(intent, quote, f.wallet, f.authority, f.options));
    assert.equal((await readTransferAttempt(intent.id))!.signedTx, null); assert.equal(f.state.postBodies.length, 0);
    f = fixture(); quote = await quoteTreasuryTransfer(intent, f.wallet, f.options);
    await signTreasuryTransfer(intent, quote, f.wallet, f.authority, f.options); f.state.mismatchReadback = true;
    await assert.rejects(() => submitTreasuryTransfer(intent, f.authority, f.options), /admin_readback_mismatch/);
    assert.equal(f.state.postBodies.length, 0);
  });
  await test('storage failure and changed fee fail before the wallet signature', async () => {
    let f = fixture(), quote = await quoteTreasuryTransfer(intent, f.wallet, f.options);
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () { throw Error('synthetic disk full'); };
    try { await assert.rejects(() => signTreasuryTransfer(intent, quote, f.wallet, f.authority, f.options)); }
    finally { IDBObjectStore.prototype.put = original; }
    assert.equal(f.state.signatures, 0); assert.equal(f.state.claimCalls, 0);
    f = fixture(); quote = await quoteTreasuryTransfer(intent, f.wallet, f.options); f.state.reward = '1001';
    await assert.rejects(() => signTreasuryTransfer(intent, quote, f.wallet, f.authority, f.options), /quote_changed/);
    assert.equal(f.state.signatures, 0); assert.equal(f.state.claimCalls, 0);
  });
} finally { globalThis.fetch = originalFetch; }
console.log(`PASS ${passed} treasury transfer safety scenarios; synthetic keys and mocked transport only`);
