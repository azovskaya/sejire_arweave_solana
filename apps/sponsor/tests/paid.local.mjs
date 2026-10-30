import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPaidOrderFromPolicy, createPaymentPreparation, paymentMessageBytes, SOLANA_GENESIS,
  validatePaidPolicy, validateContributionPolicy, verifyPreparedPaymentSignature } from '../../../packages/checkout/paid.ts';
import { createOrder } from '../../../packages/checkout/order.ts';
import { SqliteAtomicOrderStore } from '../src/checkout/sqliteStore.ts';
import { ApiLedger } from '../src/checkout/apiLedger.ts';
import { PaidLedger } from '../src/checkout/paidLedger.ts';
import { runPaidOrder, recoverPaidOrder } from '../src/checkout/paidRunner.ts';
import { validatePreparedPayment } from '../src/checkout/paymentValidator.ts';
import { addr, encode58, sig } from '../src/checkout/rpcFixtures.ts';
import { FundLedger, TREASURY_ADDRESS } from '../src/fund/ledger.ts';

// Real SQLite transactions and reopen; all RPC/Arweave ports below are synthetic.
// The only private key is an ephemeral, never-funded Ed25519 test key in memory.
const temp = await mkdtemp(resolve(tmpdir(), 'sejire-paid-sqlite-'));
const originalFetch = globalThis.fetch;
let externalCalls = 0, checks = 0, sequence = 0;
globalThis.fetch = async () => { externalCalls++; throw Error('external_network_forbidden'); };
const owner = 'f'.repeat(64), otherOwner = 'e'.repeat(64), promoHash = 'd'.repeat(64);
const sha = value => createHash('sha256').update(value).digest('hex');
const pair = generateKeyPairSync('ed25519');
const payer = encode58(pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
const executionEnv = { CHECKOUT_PAID_EXECUTION_ENABLED: 'true' };
const contexts = new Set();

function storageFor(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('CREATE TABLE IF NOT EXISTS test_alarm(id INTEGER PRIMARY KEY CHECK(id=1),at INTEGER)');
  const storage = {
    failSql: null,
    sql: { exec(sql, ...args) {
      if (storage.failSql?.(sql, args)) throw Error('synthetic_sql_fault');
      let rows = [];
      if (!args.length && sql.includes(';')) db.exec(sql);
      else {
        const statement = db.prepare(sql);
        if (statement.columns().length) rows = statement.all(...args).map(row => ({ ...row }));
        else statement.run(...args);
      }
      return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    } },
    transactionSync(callback) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    async sync() {}, // DatabaseSync commits synchronously to this real file.
    async setAlarm(at) { db.prepare('INSERT OR REPLACE INTO test_alarm(id,at) VALUES(1,?)').run(at); },
    async deleteAlarm() { db.exec('DELETE FROM test_alarm'); },
    close() { db.close(); },
  };
  return storage;
}

function openContext(file) {
  const storage = storageFor(file), orders = new SqliteAtomicOrderStore(storage), api = new ApiLedger(storage, orders);
  const fund = new FundLedger(storage), paid = new PaidLedger(storage, orders, api);
  return { file, storage, orders, api, fund, paid,
    rows(sql, ...args) { return storage.sql.exec(sql, ...args).toArray(); },
    count(table) { return storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0].n; },
  };
}

async function context() {
  const current = openContext(resolve(temp, `case-${++sequence}.sqlite`)); contexts.add(current);
  await current.api.issue(owner, Date.now() + 86400000);
  await current.api.issue(otherOwner, Date.now() + 86400000);
  await current.fund.promo(promoHash, 'SYNTHETIC', Date.now());
  await current.fund.limit('1000');
  return current;
}

function reopen(current) {
  current.storage.close(); contexts.delete(current);
  const next = openContext(current.file); contexts.add(next); return next;
}

async function fixture(options = {}) {
  const serial = ++sequence, id = serial.toString(16).padStart(32, '0');
  const createdAt = options.createdAt ?? Math.floor(Date.now() / 1000) * 1000 - 2000;
  const envelope = { schema: 'sejire/envelope/v1', vault_id: id, cipher: 'aes-gcm-256', kdf: 'hkdf-sha256',
    iv: 'AAAAAAAAAAAAAAAA', ciphertext: Buffer.alloc(32, serial % 255).toString('base64'), protocol: 'sejire/v0.3' };
  const serialized = JSON.stringify(envelope);
  const archive = { digest: sha(serialized), bytes: Buffer.byteLength(serialized), vaultId: envelope.vault_id,
    parentTxId: options.parentTxId === undefined ? 'P'.repeat(43) : options.parentTxId };
  const storagePolicy = validatePaidPolicy({ schema: 'sejire/checkout-policy/v1', version: 'synthetic-ledger-v1',
    network: 'mainnet-beta', genesisHash: SOLANA_GENESIS['mainnet-beta'], serviceLamports: '30000000',
    serviceRecipient: addr(2), fundRecipient: addr(3), storage: { kind: 'arweave-direct', network: 'arweave.N.1',
      treasuryAddress: TREASURY_ADDRESS, budgetId: options.budgetId ?? 'synthetic-paid-budget',
      maxBytes: 524288, maxRewardWinston: options.cap ?? '30' } });
  const isContribution = options.kind === 'contribution';
  const policy = isContribution ? validateContributionPolicy({ schema: 'sejire/contribution-policy/v1', version: storagePolicy.version,
    network: storagePolicy.network, genesisHash: storagePolicy.genesisHash, serviceLamports: '0',
    serviceRecipient: storagePolicy.serviceRecipient, fundRecipient: storagePolicy.fundRecipient }) : storagePolicy;
  const order = await createPaidOrderFromPolicy(policy, { id, payer, reference: encode58(createHash('sha256').update(id).digest()),
    createdAt, expiresAt: createdAt + 180000, ...(isContribution ? {kind:'contribution'} : {archive}), contribution: options.contribution ?? '0' });
  const preparation = await createPaymentPreparation(order, { blockhash: addr(8), lastValidBlockHeight: 1000,
    feeLamports: '5000', createdAt: createdAt + 100 });
  const signature = encode58(sign(null, paymentMessageBytes(preparation.messageBase64), pair.privateKey));
  await verifyPreparedPaymentSignature(order, preparation, signature);
  const chain = { network: order.network, genesisHash: policy.genesisHash };
  const evidence = { signature, ...chain, commitment: 'finalized', error: null, slot: 1234,
    blockTimeMs: createdAt + 1000, feeLamports: preparation.feeLamports, feePayer: order.payer, signers: [order.payer],
    recentBlockhash: preparation.blockhash, messageBase64: preparation.messageBase64,
    transfers: ['servicePayment', 'fundContribution'].filter(purpose => order[purpose].amount !== '0')
      .map((purpose, index) => ({ instruction: String(index), sender: order.payer, recipient: order[purpose].recipient,
        amount: order[purpose].amount, asset: order.asset, references: [order.reference] })) };
  const payment = await validatePreparedPayment(order, evidence, chain, preparation);
  const input = { orderId: id, serialized, archive };
  const prepared = isContribution ? null : preparedFor(input, policy, options.reward ?? '20', 'initial-anchor');
  return { order, policy, preparation, signature, chain, evidence, payment, serialized, input, prepared,
    key: `synthetic-${id}`, intent: sha(JSON.stringify({ archive, policy, payer })) };
}

function preparedFor(input, policy, rewardWinston, anchor) {
  return { schema: 'sejire/arweave-direct/prepared/v1', orderId: input.orderId, archive: structuredClone(input.archive),
    network: policy.storage.network, treasuryAddress: policy.storage.treasuryAddress, rewardWinston,
    raw: JSON.stringify({ synthetic: true, archive: input.archive, data: input.serialized, anchor, rewardWinston }) };
}

function signedFor(prepared) {
  const raw = JSON.stringify({ synthetic: true, prepared: prepared.raw, signature: 'mock-provider-signature' });
  return { ...structuredClone(prepared), schema: 'sejire/arweave-direct/signed/v1', raw,
    id: createHash('sha256').update(raw).digest('base64url') };
}

async function offer(c, f, options = {}) {
  return c.paid.create({ hash: owner, key: f.key, intent: f.intent, order: f.order, policy: f.policy,
    ...(f.order.kind === 'preservation' ? {serialized: f.serialized, prepared: f.prepared, budgetLimit: options.budgetLimit ?? '1000',
      balance: options.balance ?? '100', balanceRevision: options.revision ?? c.paid.treasury.revision(TREASURY_ADDRESS)} : {}) },
  options.now ?? f.order.createdAt + 200);
}

async function prepare(c, f) { return c.paid.prepare(owner, f.order.id, f.preparation, f.order.createdAt + 300); }
async function reserve(c, f) { return c.paid.reserve(owner, f.order.id, f.signature, f.preparation.preparationId, Date.now()); }
async function pay(c, f) { await prepare(c, f); await reserve(c, f); return c.paid.commit(f.order.id, f.payment, Date.now()); }
async function recoveryFor(f, patch = {}) {
  const createdAt = Date.now();
  return { status: 'renew', finalizedBlockHeight: 1001, preparation: await createPaymentPreparation(f.order, {
    blockhash: addr(9), lastValidBlockHeight: 2000, feeLamports: '5000', createdAt,
    previousPreparationId: f.preparation.preparationId, expiresAt: createdAt + 900000, ...patch,
  }) };
}
const recover = (c, f, inspect) => recoverPaidOrder(c.paid, {}, owner, f.order.id, f.preparation.preparationId, { inspect });

async function promo(c, amount, options = {}) {
  const id = (++sequence).toString(16).padStart(32, '0');
  return c.fund.reserve({ orderId: id, preservationId: id, hash: promoHash, archiveSizeBytes: 256,
    archiveDigest: 'a'.repeat(64), vaultId: 'b'.repeat(32), parentTxId: null,
    reward: amount, estimated: amount, prepared: 'synthetic-promo-prepared', balance: options.balance ?? '100',
    balanceRevision: options.revision ?? c.paid.treasury.revision(TREASURY_ADDRESS) });
}

function mockRunner(c, f, options = {}) {
  const calls = { prepare: 0, sign: 0, submit: [], reconcile: 0, read: 0, lookup: 0 };
  const state = { proof: 'pending', loseSubmit: false, lookup: 'missing', noRead: false, ...options };
  const check = signed => ({ txId: signed.id, state: state.proof === 'missing' ? 'not_found' :
    state.proof === 'offline' ? 'unavailable' : ['confirmed', 'complete'].includes(state.proof) ? 'confirmed' : 'pending',
    onchainConfirmed: ['confirmed', 'complete'].includes(state.proof), archiveVerified: state.proof === 'complete',
    rewardWinston: state.proof === 'offline' || state.proof === 'missing' ? null : signed.rewardWinston,
    confirmations: ['confirmed', 'complete'].includes(state.proof) ? 4 : null,
    reason: state.proof === 'complete' ? null : state.proof === 'confirmed' ? 'archive_unavailable' :
      state.proof === 'offline' ? 'network_unavailable' : 'network_pending', checkedAt: Date.now() });
  const provider = {
    async prepare(input) { calls.prepare++; assert.deepEqual(input, f.input); return preparedFor(input, f.policy, state.reward ?? '20', 'fresh-anchor'); },
    async sign(input, prepared) {
      calls.sign++; assert.deepEqual(input, f.input);
      assert.deepEqual(c.paid.work(f.order.id).prepared, prepared, 'fresh prepared bytes must be durable before signing');
      return signedFor(prepared);
    },
    async submit(input, signed) {
      assert.deepEqual(input, f.input);
      assert.deepEqual(c.paid.work(f.order.id).signed, signed, 'signed bytes/ID must precede every upload');
      assert.equal(c.paid.snapshot(f.order.id).record.payment.signature, f.signature);
      calls.submit.push(structuredClone(signed));
      if (state.loseSubmit) { state.loseSubmit = false; throw Error('synthetic_header_accepted_chunk_response_lost'); }
      return { id: signed.id, accepted: true };
    },
    async reconcile(input, signed) { calls.reconcile++; assert.deepEqual(input, f.input); return check(signed); },
  };
  const reader = { chain: f.chain,
    async read(signature) { calls.read++; assert.equal(signature, f.signature); return state.noRead ? null : f.evidence; },
    async findByReference(order, preparation) {
      calls.lookup++; assert.deepEqual(order, f.order); assert.deepEqual(preparation, f.preparation);
      return state.lookup === 'found' ? { status: 'found', signature: f.signature, evidence: f.evidence, payment: f.payment }
        : { status: 'requires-reconciliation', reason: 'not-found' };
    },
  };
  return { calls, state, check, deps: { reader: () => reader, provider: () => provider } };
}

async function run(c, f, mock, env = executionEnv) { await runPaidOrder(c.paid, env, f.order.id, mock.deps); }
async function test(name, callback) { await callback(); checks++; console.log(`PASS paid SQLite: ${name}`); }

try {
  await test('standalone contribution creates no archive/AR hold/job and credits its single purpose once after restart', async () => {
    let c=await context();const f=await fixture({kind:'contribution',contribution:'9007199254740993'});
    const offerResult=await offer(c,f);assert.equal(offerResult.record.order.servicePayment.amount,'0');
    assert(!('archive' in offerResult.record.order));assert(!('storage' in offerResult.record.order));
    for(const table of ['paid_payloads','paid_holds','api_execution','credits'])assert.equal(c.count(table),0,table);
    assert.equal(c.paid.work(f.order.id).input,null);assert.equal(c.paid.work(f.order.id).prepared,null);
    assert.equal((await offer(c,f)).reused,true);assert.equal(c.count('orders'),1);
    await prepare(c,f);await reserve(c,f);const mock=mockRunner(c,f);
    await run(c,f,mock,{});
    const done=c.paid.snapshot(f.order.id);
    assert.deepEqual(done.record.states,{payment:'verified',preservation:'not-applicable',contribution:'received'});
    assert.equal(done.execution,null);assert.equal(done.record.payment.signature,f.signature);
    assert.deepEqual(c.rows('SELECT purpose,amount FROM credits'),[{purpose:'fundContribution',amount:'9007199254740993'}]);
    assert.equal(c.count('used_transactions'),1);assert.equal(c.paid.due(Date.now()+86400000).length,0);
    assert.equal(c.rows('SELECT at FROM test_alarm').length,0);
    assert.deepEqual([mock.calls.prepare,mock.calls.sign,mock.calls.submit.length,mock.calls.reconcile],[0,0,0,0]);
    c=reopen(c);const again=mockRunner(c,f);await run(c,f,again,{});
    assert.deepEqual(c.paid.snapshot(f.order.id),done);assert.equal(c.count('credits'),1);
    for(const table of ['paid_payloads','paid_holds','api_execution'])assert.equal(c.count(table),0,table);
    assert.deepEqual(c.paid.treasury.paidTotals(),{reservedWinston:'0',actualSpentWinston:'0'});
  });
  await test('standalone payment and terminal state commit atomically; storage-bearing inputs are rejected', async () => {
    const c=await context(),f=await fixture({kind:'contribution',contribution:'5000000'});
    const input={hash:owner,key:f.key,intent:f.intent,order:f.order,policy:f.policy};
    for(const extra of [{serialized:f.serialized},{prepared:{}},{budgetLimit:'1'},{balance:'1'},{balanceRevision:0}])
      await assert.rejects(c.paid.create({...input,...extra},Date.now()),/invalid_contribution_order/);
    assert.equal(c.count('orders'),0);await offer(c,f);await prepare(c,f);await reserve(c,f);
    c.storage.failSql=sql=>sql.startsWith('UPDATE paid_orders SET paid=1');
    await assert.rejects(c.paid.commit(f.order.id,f.payment,Date.now()),/synthetic_sql_fault/);
    assert.equal(c.count('credits'),0);assert.equal(c.count('used_transactions'),0);assert.equal(c.paid.snapshot(f.order.id).record.payment,undefined);
    c.storage.failSql=null;
    assert.equal((await c.paid.commit(f.order.id,f.payment,Date.now())).status,'credited');
    assert.equal((await c.paid.commit(f.order.id,f.payment,Date.now())).status,'already-credited');
    assert.equal(c.count('credits'),1);assert.equal(c.count('paid_holds'),0);assert.equal(c.count('paid_payloads'),0);
    assert.equal(c.paid.snapshot(f.order.id).record.states.preservation,'not-applicable');
  });
  await test('unknown standalone signature/reference never completes or expires; same preparation recovers while gates are off', async () => {
    let c=await context();const f=await fixture({kind:'contribution',contribution:'7'});
    await offer(c,f);await prepare(c,f);
    const missing=mockRunner(c,f,{lookup:'missing'});await run(c,f,missing,{});
    assert.equal(c.count('credits'),0);assert.equal(c.paid.snapshot(f.order.id).record.states.payment,'awaiting-payment');
    await c.paid.claim(f.order.id,'expired-but-unknown',f.order.expiresAt+86400000);
    assert.equal(c.paid.snapshot(f.order.id).expired,false);
    await c.paid.releaseLease(f.order.id,'expired-but-unknown',null,Date.now());
    c=reopen(c);await reserve(c,f);
    const invalid=mockRunner(c,{...f,evidence:{...f.evidence,commitment:'confirmed'}});
    await run(c,f,invalid,{});assert.equal(c.count('credits'),0);
    const recovered=mockRunner(c,f);await run(c,f,recovered,{});
    assert.equal(c.paid.snapshot(f.order.id).record.payment.signature,f.signature);
    assert.equal(c.paid.snapshot(f.order.id).record.states.contribution,'received');assert.equal(c.count('credits'),1);
    await assert.rejects(c.paid.cancel(owner,f.order.id,f.preparation.preparationId,Date.now()),/previous_payment_unresolved/);
    for(const table of ['paid_payloads','paid_holds','api_execution'])assert.equal(c.count(table),0,table);
    assert.equal(recovered.calls.sign,0);assert.equal(recovered.calls.submit.length,0);
  });
  await test('creation binds exact ciphertext and parent; all order/hold/job rows roll back together', async () => {
    let c = await context(); const f = await fixture();
    c.storage.failSql = sql => sql.startsWith('INSERT INTO paid_payloads');
    await assert.rejects(offer(c, f), /synthetic_sql_fault/);
    for (const table of ['orders', 'api_orders', 'paid_orders', 'paid_payloads', 'paid_holds']) assert.equal(c.count(table), 0, table);
    c.storage.failSql = null;
    const offered = await offer(c, f); assert.equal(offered.reused, false);
    assert.equal(c.paid.work(f.order.id).input.serialized, f.serialized);
    assert.equal(c.paid.work(f.order.id).input.archive.parentTxId, f.order.archive.parentTxId);
    assert.deepEqual(c.paid.treasury.paidTotals(), { reservedWinston: '30', actualSpentWinston: '0' });
    assert.equal((await offer(c, f)).reused, true); assert.equal(c.count('paid_holds'), 1);
    await assert.rejects(c.paid.create({ hash: owner, key: f.key, intent: 'changed', order: f.order, policy: f.policy,
      serialized: f.serialized, prepared: f.prepared, budgetLimit: '1000', balance: '100', balanceRevision: 0 }, Date.now()), /idempotency_conflict/);
    assert.throws(() => c.paid.get(otherOwner, f.order.id, Date.now()), /order_not_found/);
    assert.equal(c.rows('SELECT at FROM test_alarm').length, 1);
    c = reopen(c); assert.deepEqual(c.paid.work(f.order.id).input, f.input);
    assert.equal(c.paid.byKey(owner, f.key, Date.now()).record.order.id, f.order.id);
  });

  await test('cancel before admission wins the race, survives a lost reply/restart and rejects every late create', async () => {
    let c = await context(); const f = await fixture();
    const creating = offer(c, f); // Exact policy/archive validation yields before linked SQL admission.
    const cancelling = c.paid.cancelByKey(owner, f.key, Date.now());
    const outcomes = await Promise.allSettled([creating, cancelling]);
    assert.equal(outcomes[0].status, 'rejected');
    assert.match(outcomes[0].reason.message, /paid_request_cancelled/);
    assert.equal(outcomes[1].status, 'fulfilled');
    const receipt = { schema: 'sejire/paid-request-cancellation/v1', status: 'cancelled', key: f.key };
    assert.deepEqual(outcomes[1].value, receipt);
    for (const table of ['orders', 'api_orders', 'paid_orders', 'paid_payloads', 'paid_holds']) assert.equal(c.count(table), 0, table);
    assert.equal(c.count('paid_cancelled_keys'), 1);
    // The caller discards the successful cancellation reply and restarts with only its old key.
    c = reopen(c);
    assert.deepEqual(c.paid.byKey(owner, f.key, Date.now()), receipt);
    assert.deepEqual(await c.paid.cancelByKey(owner, f.key, Date.now()), receipt);
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(offer(c, f), /paid_request_cancelled/);
    assert.equal(c.count('paid_cancelled_keys'), 1);
    for (const table of ['orders', 'api_orders', 'paid_orders', 'paid_payloads', 'paid_holds', 'credits']) assert.equal(c.count(table), 0, table);
    assert.equal(c.paid.treasury.held(TREASURY_ADDRESS, TREASURY_ADDRESS), '0');
  });

  await test('admission committed before its response wins cancellation-by-key and returns the unchanged original order', async () => {
    const c = await context(), f = await fixture();
    let admitted, release;
    const reachedCommit = new Promise(resolve => { admitted = resolve; });
    const responseGate = new Promise(resolve => { release = resolve; });
    const originalSync = c.storage.sync;
    let intercepted = false;
    c.storage.sync = async () => {
      if (!intercepted) { intercepted = true; admitted(); await responseGate; }
    };
    const creating = offer(c, f);
    try {
      await Promise.race([reachedCommit, creating.then(() => { throw Error('missing_sql_commit_gate'); })]);
      // Real SQLite order/hold transaction committed; its network-equivalent reply has not returned.
      const before = c.paid.snapshot(f.order.id);
      assert.deepEqual(await c.paid.cancelByKey(owner, f.key, Date.now()), before);
      assert.deepEqual(c.paid.snapshot(f.order.id), before);
      assert.equal(before.cancelled, false); assert.equal(before.expired, false);
      assert.equal(c.count('paid_cancelled_keys'), 0);
      assert.equal(c.paid.treasury.paidTotals().reservedWinston, '30');
    } finally { release(); c.storage.sync = originalSync; }
    assert.equal((await creating).record.order.id, f.order.id);
    await pay(c, f);
    const paid = c.paid.snapshot(f.order.id);
    assert.deepEqual(await c.paid.cancelByKey(owner, f.key, Date.now()), paid, 'by-key cancellation cannot cancel an already admitted or paid order');
    assert.equal(c.paid.snapshot(f.order.id).record.payment.signature, f.signature);
    assert.equal(c.count('orders'), 1); assert.equal(c.count('paid_holds'), 1); assert.equal(c.count('paid_cancelled_keys'), 0);
  });

  await test('pre-admission cancellation is owner/key scoped, admits known expired owners and rejects legacy/unknown sessions', async () => {
    const c = await context(), f = await fixture();
    const foreignReceipt = { schema: 'sejire/paid-request-cancellation/v1', status: 'cancelled', key: f.key };
    assert.deepEqual(await c.paid.cancelByKey(otherOwner, f.key, Date.now()), foreignReceipt);
    await offer(c, f); // Another owner's identical key cannot poison this owner's admission.
    const victim = c.paid.snapshot(f.order.id);
    assert.deepEqual(await c.paid.cancelByKey(otherOwner, f.key, Date.now()), foreignReceipt);
    assert.deepEqual(c.paid.byKey(otherOwner, f.key, Date.now()), foreignReceipt);
    assert.deepEqual(c.paid.snapshot(f.order.id), victim);
    assert.throws(() => c.paid.get(otherOwner, f.order.id, Date.now()), /order_not_found/);
    await assert.rejects(c.paid.cancelByKey('b'.repeat(64), 'synthetic-unowned-request', Date.now()), /unauthorized/);
    const legacy = createOrder({ ...f.order, id: 'b'.repeat(32), reference: addr(45), asset: 'SOL' });
    await c.api.create(owner, 'synthetic-legacy-request', 'synthetic-legacy-request-intent', legacy, Date.now());
    await assert.rejects(c.paid.cancelByKey(owner, 'synthetic-legacy-request', Date.now()), /idempotency_conflict/);
    assert.equal(c.rows('SELECT * FROM paid_cancelled_keys WHERE owner=? AND key=?', owner, 'synthetic-legacy-request').length, 0);
    const expiresAt = Date.now() - 1, absentKey = 'synthetic-expired-request';
    c.storage.sql.exec('UPDATE api_sessions SET expires_at=? WHERE hash=?', expiresAt, owner);
    const expiredReceipt = { schema: 'sejire/paid-request-cancellation/v1', status: 'cancelled', key: absentKey };
    assert.deepEqual(await c.paid.cancelByKey(owner, absentKey, Date.now()), expiredReceipt);
    assert.deepEqual(c.paid.byKey(owner, absentKey, Date.now()), expiredReceipt);
    assert.equal(c.rows('SELECT expires_at FROM api_sessions WHERE hash=?', owner)[0].expires_at, expiresAt);
    assert.throws(() => c.api.authenticate(owner, Date.now()), /unauthorized/);
    assert.equal(c.count('orders'), 2); assert.equal(c.count('paid_holds'), 1);
    assert.equal(c.paid.treasury.paidTotals().reservedWinston, '30');
  });

  await test('SOL credit and durable storage job commit atomically; injected job failure rolls back credit', async () => {
    let c = await context(); const f = await fixture({ contribution: '5000000' });
    await offer(c, f); await prepare(c, f);
    await assert.rejects(c.orders.beginReconciliation(f.order.id, f.signature), /paid_order_requires_linked_reserve/);
    await assert.rejects(c.paid.reserve(owner, f.order.id, sig(7), f.preparation.preparationId, Date.now()), /invalid_payment_signature/);
    assert.equal((await c.orders.get(f.order.id)).pendingSignature, undefined);
    await reserve(c, f);
    await assert.rejects(c.orders.commitPayment(f.payment), /paid_order_requires_linked_commit/);
    c.storage.failSql = sql => sql.startsWith('UPDATE paid_orders SET paid=1');
    await assert.rejects(c.paid.commit(f.order.id, f.payment, Date.now()), /synthetic_sql_fault/);
    assert.equal(c.count('credits'), 0); assert.equal(c.count('used_transactions'), 0);
    assert.equal((await c.orders.get(f.order.id)).payment, undefined);
    assert.equal(c.rows('SELECT paid FROM paid_orders')[0].paid, 0);
    c.storage.failSql = null;
    assert.equal((await c.paid.commit(f.order.id, f.payment, Date.now())).status, 'credited');
    assert.equal(c.paid.work(f.order.id).status, 'queued');
    assert.equal(c.rows('SELECT paid FROM paid_orders')[0].paid, 1);
    c = reopen(c);
    assert.equal((await c.paid.commit(f.order.id, f.payment, Date.now())).status, 'already-credited');
    assert.equal(c.count('credits'), 2); assert.equal(c.count('used_transactions'), 1);
    assert.deepEqual(await c.orders.totals(), { 'mainnet-beta:SOL::servicePayment': '30000000', 'mainnet-beta:SOL::fundContribution': '5000000' });
  });

  await test('explicit cancellation wins an in-flight reserve CAS and exact preparation remains mandatory', async () => {
    const c = await context(), f = await fixture(); await offer(c, f); await prepare(c, f);
    await assert.rejects(c.paid.cancel(owner, f.order.id, null, Date.now()), /preparation_changed/);
    const pending = reserve(c, f); // Signature validation yields; cancellation must still win atomically.
    const outcomes = await Promise.allSettled([pending, c.paid.cancel(owner, f.order.id, f.preparation.preparationId, Date.now())]);
    assert.equal(outcomes[0].status, 'rejected'); assert.equal(outcomes[1].status, 'fulfilled');
    assert.equal(c.paid.snapshot(f.order.id).cancelled, true);
    assert.equal((await c.orders.get(f.order.id)).pendingSignature, undefined);
    assert.equal(c.paid.treasury.paidTotals().reservedWinston, '0');
    await assert.rejects(reserve(c, f), /payment_not_prepared/);
    await assert.rejects(c.paid.commit(f.order.id, f.payment, Date.now()), /payment_not_prepared/);
    await assert.rejects(prepare(c, f), /order_expired/);
    assert.equal((await c.paid.cancel(owner, f.order.id, f.preparation.preparationId, Date.now())).cancelled, true);
    assert.equal(c.count('credits'), 0); assert.equal(c.rows('SELECT at FROM test_alarm').length, 0);
  });

  await test('durably reserved signature wins cancellation; null-preparation cancellation cannot erase a newer preparation', async () => {
    const c = await context(), f = await fixture(); await offer(c, f); await prepare(c, f); await reserve(c, f);
    await assert.rejects(c.paid.cancel(owner, f.order.id, f.preparation.preparationId, Date.now()), /previous_payment_unresolved/);
    assert.equal(c.paid.treasury.paidTotals().reservedWinston, '30');
    const g = await fixture(); await offer(c, g);
    const preparing = prepare(c, g);
    const cancelled = await c.paid.cancel(owner, g.order.id, null, Date.now());
    assert.equal(cancelled.cancelled, true); await assert.rejects(preparing, /order_expired/);
    const h = await fixture(); await offer(c, h); await prepare(c, h);
    await assert.rejects(c.paid.cancel(owner, h.order.id, null, Date.now()), /preparation_changed/);
    assert.equal(c.paid.work(h.order.id).preparation.preparationId, h.preparation.preparationId);
  });

  await test('only an untouched offer expires; unknown wallet/prepared payment retains its hold across time and restart', async () => {
    let c = await context(); const untouched = await fixture(), unknown = await fixture();
    await offer(c, untouched); await offer(c, unknown); await prepare(c, unknown);
    assert.equal(await c.paid.claim(untouched.order.id, 'untouched', untouched.order.expiresAt + 1), null);
    assert.equal(c.paid.snapshot(untouched.order.id).expired, true);
    assert(c.paid.treasury.paidTotals().reservedWinston === '30');
    assert(await c.paid.claim(unknown.order.id, 'unknown', unknown.order.expiresAt + 86400000));
    await c.paid.releaseLease(unknown.order.id, 'unknown', 'not-found', unknown.order.expiresAt + 86400000);
    c = reopen(c); const mock = mockRunner(c, unknown);
    await run(c, unknown, mock); await run(c, unknown, mock);
    assert.equal(c.paid.snapshot(unknown.order.id).expired, false);
    assert.equal(c.paid.work(unknown.order.id).preparation.preparationId, unknown.preparation.preparationId);
    assert.equal(c.paid.treasury.paidTotals().reservedWinston, '30');
    assert.equal(mock.calls.lookup, 2); assert.equal(mock.calls.sign, 0); assert.equal(mock.calls.submit.length, 0);
  });

  await test('explicit recovery renews only the payment window of an expired immutable order; a lost reply survives restart', async () => {
    let c = await context(); const f = await fixture({ createdAt: Date.now() - 3600000 });
    await offer(c, f); await prepare(c, f);
    const before = c.paid.work(f.order.id), holdBefore = c.rows('SELECT * FROM paid_holds');
    const renewal = await recoveryFor(f); let reads = 0;
    const recovered = await recover(c, f, async work => { reads++; assert.deepEqual(work, before); return renewal; });
    assert.deepEqual(recovered.record.order, f.order); assert.equal(recovered.record.order.expiresAt, f.order.expiresAt);
    assert.deepEqual(recovered.preparation, renewal.preparation); assert.equal(recovered.record.pendingSignature, undefined);
    assert.deepEqual(c.paid.work(f.order.id).input, before.input); assert.deepEqual(c.paid.work(f.order.id).prepared, before.prepared);
    assert.deepEqual(c.rows('SELECT * FROM paid_holds'), holdBefore);
    assert.equal(c.count('orders'), 1); assert.equal(c.count('paid_payloads'), 2); assert.equal(c.count('credits'), 0);
    const history = c.rows('SELECT * FROM paid_payment_recoveries'); assert.equal(history.length, 1);
    assert.deepEqual(JSON.parse(history[0].previous_preparation_json), f.preparation);
    assert.deepEqual(JSON.parse(history[0].preparation_json), renewal.preparation);
    // Pretend the POST acknowledgement was lost: restart with the original preparation ID.
    c = reopen(c);
    assert.deepEqual(await recover(c, f, async () => { reads++; throw Error('must_not_repeat_rpc'); }), recovered);
    assert.equal(reads, 1); assert.equal(c.count('paid_payment_recoveries'), 1);
    assert.deepEqual(await c.paid.prepare(owner, f.order.id, f.preparation, Date.now()), renewal.preparation);
    await assert.rejects(reserve(c, f), /payment_not_prepared/);
    const next = renewal.preparation;
    const signature = encode58(sign(null, paymentMessageBytes(next.messageBase64), pair.privateKey));
    const evidence = { ...f.evidence, signature, blockTimeMs: Math.floor(next.createdAt / 1000) * 1000,
      recentBlockhash: next.blockhash, messageBase64: next.messageBase64 };
    const payment = await validatePreparedPayment(f.order, evidence, f.chain, next);
    assert(evidence.blockTimeMs > f.order.expiresAt);
    await c.paid.reserve(owner, f.order.id, signature, next.preparationId, Date.now());
    assert.equal((await c.paid.commit(f.order.id, payment, Date.now())).status, 'credited');
    assert.equal((await c.paid.commit(f.order.id, payment, Date.now())).status, 'already-credited');
    assert.equal(c.count('used_transactions'), 1); assert.equal(c.count('credits'), 1);
    assert.equal(c.paid.treasury.paidTotals().reservedWinston, '30');
    assert.equal(c.paid.work(f.order.id).signed, null);
  });

  await test('a durable reserve, lost reserve acknowledgement, payment, or active runner lease forbids recovery', async () => {
    let c = await context(); const f = await fixture(); await offer(c, f); await prepare(c, f); await reserve(c, f);
    c = reopen(c); let reads = 0; const inspect = async () => { reads++; return recoveryFor(f); };
    await assert.rejects(recover(c, f, inspect), /previous_payment_unresolved/);
    await c.paid.commit(f.order.id, f.payment, Date.now());
    await assert.rejects(recover(c, f, inspect), /previous_payment_unresolved/);
    assert.equal(reads, 0); assert.equal(c.count('paid_payment_recoveries'), 0);
    const g = await fixture(); await offer(c, g); await prepare(c, g);
    assert(await c.paid.claim(g.order.id, 'running-existing-check', Date.now()));
    await assert.rejects(recover(c, g, inspect), /payment_recovery_busy/);
    await assert.rejects(recoverPaidOrder(c.paid, {}, otherOwner, g.order.id, g.preparation.preparationId, { inspect }), /order_not_found/);
    assert.equal(reads, 0); assert.equal(c.paid.work(g.order.id).preparation.preparationId, g.preparation.preparationId);
  });

  await test('recovery and reserve share an atomic preparation fence in both asynchronous race directions', async () => {
    const c = await context(), f = await fixture(); await offer(c, f); await prepare(c, f);
    const renewal = await recoveryFor(f);
    let entered, resume; const reached = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    const begin = c.orders.beginReconciliationLinked.bind(c.orders);
    c.orders.beginReconciliationLinked = async (...args) => { entered(); await gate; return begin(...args); };
    const lateReserve = reserve(c, f); await reached;
    await recover(c, f, async () => renewal);
    resume(); await assert.rejects(lateReserve, /payment_not_prepared/);
    c.orders.beginReconciliationLinked = begin;
    assert.equal(c.paid.snapshot(f.order.id).record.pendingSignature, undefined);
    const g = await fixture(); await offer(c, g); await prepare(c, g); const gRenewal = await recoveryFor(g);
    let inspectEntered, releaseInspect;
    const inspecting = new Promise(resolve => { inspectEntered = resolve; });
    const inspectGate = new Promise(resolve => { releaseInspect = resolve; });
    const recovery = recover(c, g, async () => { inspectEntered(); await inspectGate; return gRenewal; });
    await inspecting; await reserve(c, g); releaseInspect();
    await assert.rejects(recovery, /previous_payment_unresolved/);
    assert.equal(c.paid.snapshot(g.order.id).record.pendingSignature, g.signature);
    assert.deepEqual(c.paid.work(g.order.id).preparation, g.preparation);
    assert.equal(c.rows('SELECT * FROM paid_payment_recoveries WHERE order_id=?', g.order.id).length, 0);
  });

  await test('concurrent recovery requests serialize; duplicate predecessor never makes another preparation', async () => {
    const c = await context(), f = await fixture(); await offer(c, f); await prepare(c, f); const renewal = await recoveryFor(f);
    let entered, resume, reads = 0;
    const reached = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { resume = resolve; });
    const inspect = async () => { reads++; entered(); await gate; return renewal; };
    const first = recover(c, f, inspect); await reached;
    await assert.rejects(recover(c, f, inspect), /payment_recovery_busy/);
    resume(); const recovered = await first;
    assert.deepEqual(await recover(c, f, inspect), recovered);
    assert.equal(reads, 1); assert.equal(c.count('paid_payment_recoveries'), 1);
  });

  await test('recovery preserves a real original reference payment and never executes the archive', async () => {
    const c = await context(), f = await fixture(); await offer(c, f); await prepare(c, f);
    const snapshot = await recover(c, f, async () => ({ status: 'found', signature: f.signature, evidence: f.evidence, payment: f.payment }));
    assert.equal(snapshot.record.payment.signature, f.signature); assert.deepEqual(snapshot.preparation, f.preparation);
    assert.equal(c.count('paid_payment_recoveries'), 0); assert.equal(c.count('used_transactions'), 1);
    assert.equal(c.paid.work(f.order.id).signed, null); assert.equal(c.count('paid_payloads'), 2);
    assert.equal(c.paid.treasury.paidTotals().reservedWinston, '30');
  });

  await test('uncertainty, stale candidate height, and SQL failure cannot rotate or release the existing attempt', async () => {
    const c = await context(), f = await fixture(); await offer(c, f); await prepare(c, f);
    await assert.rejects(recover(c, f, async () => { throw Error('rpc-timeout'); }), /payment_recovery_unavailable/);
    await assert.rejects(recover(c, f, async () => ({ ...await recoveryFor(f), finalizedBlockHeight: 1000 })), /payment_not_expired/);
    await assert.rejects(recover(c, f, async () => recoveryFor(f, { lastValidBlockHeight: 1001 })), /payment_recovery_unavailable/);
    const renewal = await recoveryFor(f);
    c.storage.failSql = sql => sql.startsWith('UPDATE paid_orders SET preparation_json=?,status=?,next_at=?,attempts=0');
    await assert.rejects(recover(c, f, async () => renewal), /payment_recovery_unavailable/);
    c.storage.failSql = null;
    assert.deepEqual(c.paid.work(f.order.id).preparation, f.preparation);
    assert.equal(c.count('paid_payment_recoveries'), 0); assert.equal(c.count('credits'), 0);
    assert.equal(c.paid.treasury.paidTotals().reservedWinston, '30');
    assert.equal(c.rows('SELECT lease_until FROM paid_orders WHERE order_id=?', f.order.id)[0].lease_until, 0);
    assert.deepEqual((await recover(c, f, async () => renewal)).preparation, renewal.preparation);
    assert.equal(c.count('paid_payment_recoveries'), 1);
  });

  await test('shared physical balance includes paid and promo holds in both admission directions', async () => {
    const a = await context(), paidFirst = await fixture({ cap: '60' }); await offer(a, paidFirst);
    await assert.rejects(promo(a, '50'), /wallet_low/); assert.equal(a.count('fund_orders'), 0);
    assert.equal(a.fund.summary().actualSpentWinston, '0'); assert.equal(a.fund.summary().reservedWinston, '0');
    const b = await context(); await promo(b, '60'); const promoFirst = await fixture({ cap: '50' });
    await assert.rejects(offer(b, promoFirst), /wallet_low/); assert.equal(b.count('paid_orders'), 0);
    assert.equal(b.paid.treasury.paidTotals().reservedWinston, '0');
    assert.equal(b.fund.summary().reservedWinston, '60');
    const c = await context(), racing = await fixture({ cap: '60' });
    const results = await Promise.allSettled([offer(c, racing), promo(c, '60')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(c.paid.treasury.held(TREASURY_ADDRESS, TREASURY_ADDRESS), '60');
  });

  await test('paid budget has its own cap and does not consume promo allowance', async () => {
    const c = await context(), first = await fixture({ cap: '30' }); await offer(c, first, { budgetLimit: '50' });
    const second = await fixture({ cap: '30' }); await assert.rejects(offer(c, second, { budgetLimit: '50' }), /paid_budget_exhausted/);
    await promo(c, '60'); assert.equal(c.fund.summary().reservedWinston, '60');
    assert.equal(c.paid.treasury.paidTotals().reservedWinston, '30');
    assert.equal(c.fund.summary().budgetRemainingWinston, '940');
  });

  await test('revision rejects an in-flight stale balance; persisted ceiling rejects later stale high snapshots', async () => {
    let c = await context(); const f = await fixture(); await offer(c, f); await pay(c, f);
    const mock = mockRunner(c, f, { proof: 'confirmed' }); await run(c, f, mock);
    assert.deepEqual(c.paid.treasury.paidTotals(), { reservedWinston: '0', actualSpentWinston: '20' });
    assert.equal(c.paid.treasury.revision(TREASURY_ADDRESS), 1);
    const staleDuringRead = await fixture({ cap: '10', reward: '10' });
    await assert.rejects(offer(c, staleDuringRead, { revision: 0 }), /balance_observation_stale/);
    const staleAfterRead = await fixture({ cap: '85' });
    await assert.rejects(offer(c, staleAfterRead, { revision: 1, balance: '100' }), /wallet_low/);
    await assert.rejects(promo(c, '85', { revision: 1, balance: '100' }), /wallet_low/);
    assert.equal(c.paid.treasury.effectiveBalance(TREASURY_ADDRESS, '100'), '80');
    c = reopen(c);
    await assert.rejects(offer(c, staleAfterRead, { revision: 1, balance: '1000' }), /wallet_low/);
    assert.equal(c.paid.treasury.effectiveBalance(TREASURY_ADDRESS, '1000'), '80');
    assert.equal(c.fund.summary().actualSpentWinston, '0');
    await promo(c, '80'); assert.equal(c.fund.summary().reservedWinston, '80');
  });

  await test('promo confirmed debits constrain paid admissions; an unobserved debit survives restart conservatively', async () => {
    let c = await context(); const p = await promo(c, '30');
    await c.fund.event({ orderId: p.orderId, status: 'SIGNED', txId: 'S'.repeat(43), signed: 'synthetic-signed-promo' });
    await c.fund.event({ orderId: p.orderId, status: 'COMPLETED', actual: '20' });
    await c.fund.event({ orderId: p.orderId, status: 'COMPLETED', actual: '20' });
    assert.equal(c.paid.treasury.revision(TREASURY_ADDRESS), 1);
    assert.equal(c.fund.summary().actualSpentWinston, '20'); assert.equal(c.paid.treasury.paidTotals().actualSpentWinston, '0');
    await assert.rejects(offer(c, await fixture({ cap: '85' })), /wallet_low/);
    const legacy = await context();
    legacy.storage.transactionSync(() => legacy.paid.treasury.debit(TREASURY_ADDRESS, '20'));
    c = reopen(legacy);
    assert.equal(c.paid.treasury.effectiveBalance(TREASURY_ADDRESS, '100'), '80');
    await assert.rejects(offer(c, await fixture({ cap: '85' })), /wallet_low/);
    await offer(c, await fixture({ cap: '80' }));
    assert.equal(c.paid.treasury.held(TREASURY_ADDRESS, TREASURY_ADDRESS), '80');
  });

  await test('lost header/chunk acknowledgement retries exactly one signed TX across restart, then becomes read-only', async () => {
    let c = await context(); const f = await fixture(); await offer(c, f); await pay(c, f);
    const first = mockRunner(c, f, { loseSubmit: true }); await run(c, f, first);
    const saved = c.paid.work(f.order.id).signed;
    assert(saved); assert.equal(first.calls.prepare, 1); assert.equal(first.calls.sign, 1); assert.equal(first.calls.submit.length, 1);
    assert.equal(c.paid.work(f.order.id).submitAcknowledged, false);
    assert.equal(c.paid.treasury.paidTotals().reservedWinston, '30');
    c = reopen(c); const retry = mockRunner(c, f); await run(c, f, retry);
    assert.equal(retry.calls.prepare, 0); assert.equal(retry.calls.sign, 0); assert.equal(retry.calls.submit.length, 1);
    assert.deepEqual(retry.calls.submit[0], saved); assert.equal(c.paid.work(f.order.id).submitAcknowledged, true);
    assert.deepEqual(first.calls.submit[0], retry.calls.submit[0]);
    await run(c, f, retry); assert.equal(retry.calls.submit.length, 1, 'acknowledged pending TX is not uploaded again');
    c = reopen(c); const confirmed = mockRunner(c, f, { proof: 'complete' }); await run(c, f, confirmed); await run(c, f, confirmed);
    assert.equal(confirmed.calls.submit.length, 0); assert.equal(confirmed.calls.sign, 0); assert.equal(confirmed.calls.reconcile, 1);
    assert.equal(c.paid.snapshot(f.order.id).execution.receipt.txId, saved.id);
    assert.equal(c.count('credits'), 1); assert.equal(c.count('used_transactions'), 1); assert.equal(c.count('paid_holds'), 1);
    assert.deepEqual(c.paid.treasury.paidTotals(), { reservedWinston: '0', actualSpentWinston: '20' });
  });

  await test('confirmed spend is counted once while unavailable archive never completes; later outage cannot undo proof', async () => {
    let c = await context(); const f = await fixture(); await offer(c, f); await pay(c, f);
    const mock = mockRunner(c, f, { proof: 'confirmed' }); await run(c, f, mock);
    const saved = c.paid.work(f.order.id).signed;
    let snapshot = c.paid.snapshot(f.order.id);
    assert.equal(snapshot.execution.status, 'confirming'); assert.equal(snapshot.execution.receipt, undefined);
    assert.equal(snapshot.record.states.preservation, 'requires-reconciliation');
    assert.deepEqual(snapshot.execution.verification, { transactionConfirmed: true, archiveVerified: false,
      owner: TREASURY_ADDRESS, rewardWinston: '20', archive: f.order.archive });
    assert.equal(c.paid.treasury.revision(TREASURY_ADDRESS), 1);
    mock.state.proof = 'offline'; await run(c, f, mock);
    assert.equal(c.paid.snapshot(f.order.id).execution.verification.transactionConfirmed, true);
    assert.equal(c.paid.treasury.revision(TREASURY_ADDRESS), 1);
    c = reopen(c); const finish = mockRunner(c, f, { proof: 'complete' }); await run(c, f, finish); await run(c, f, finish);
    snapshot = c.paid.snapshot(f.order.id);
    assert.equal(snapshot.execution.status, 'completed'); assert.equal(snapshot.record.states.preservation, 'completed');
    assert.equal(snapshot.execution.receipt.txId, saved.id); assert.equal(snapshot.execution.receipt.paymentSignature, f.signature);
    assert.deepEqual(snapshot.execution.receipt.archive, f.order.archive); assert.equal(finish.calls.submit.length, 0);
    assert.equal(c.paid.treasury.revision(TREASURY_ADDRESS), 1); assert.equal(c.paid.treasury.paidTotals().actualSpentWinston, '20');
    assert.equal(c.rows('SELECT at FROM test_alarm').length, 0);
  });

  await test('wrong TX/reward or archive-without-chain proof cannot spend or complete', async () => {
    const c = await context(), f = await fixture(); await offer(c, f); await pay(c, f);
    const mock = mockRunner(c, f); await run(c, f, mock);
    const work = await c.paid.claim(f.order.id, 'proof-check', Date.now()); assert(work);
    const proof = { ...mock.check(work.signed), state: 'confirmed', onchainConfirmed: true, archiveVerified: true,
      rewardWinston: '20', confirmations: 1, reason: null };
    for (const patch of [{ txId: 'X'.repeat(43) }, { rewardWinston: '21' }, { onchainConfirmed: false }])
      await assert.rejects(c.paid.proof(f.order.id, 'proof-check', { ...proof, ...patch }, Date.now()), /storage_proof_mismatch/);
    assert.deepEqual(c.paid.treasury.paidTotals(), { reservedWinston: '30', actualSpentWinston: '0' });
    assert.equal(c.paid.snapshot(f.order.id).execution.receipt, undefined);
    await c.paid.releaseLease(f.order.id, 'proof-check', null, Date.now());
  });

  await test('expired original bearer can read its exact v2 result while service continuation remains token-free', async () => {
    let c = await context(); const f = await fixture(); await offer(c, f); await prepare(c, f);
    const expiresAt = Date.now() - 1;
    c.storage.sql.exec('UPDATE api_sessions SET expires_at=? WHERE hash=?', expiresAt, owner);
    c = reopen(c);
    assert.deepEqual(c.paid.get(owner, f.order.id, Date.now()).record.order, f.order);
    assert.equal(c.paid.byKey(owner, f.key, Date.now()).record.order.id, f.order.id);
    assert.doesNotThrow(() => c.api.authenticateResume(owner, f.order.id, undefined, Date.now()));
    assert.doesNotThrow(() => c.api.authenticateResume(owner, undefined, f.key, Date.now()));
    const mock = mockRunner(c, f, { lookup: 'found', proof: 'complete' }); await run(c, f, mock); await run(c, f, mock);
    assert.equal(mock.calls.lookup, 1); assert.equal(mock.calls.read, 0); assert.equal(mock.calls.sign, 1); assert.equal(mock.calls.submit.length, 1);
    assert.equal(c.paid.snapshot(f.order.id).record.pendingSignature, f.signature);
    assert.equal(c.paid.snapshot(f.order.id).execution.status, 'completed'); assert.equal(c.count('credits'), 1);
    const receipt = c.paid.get(owner, f.order.id, Date.now()).execution.receipt;
    assert.equal(receipt.paymentSignature, f.signature);
    assert.deepEqual(c.paid.byKey(owner, f.key, Date.now()).execution.receipt, receipt);
    assert.equal(c.rows('SELECT expires_at FROM api_sessions WHERE hash=?', owner)[0].expires_at, expiresAt);
  });

  await test('expired v2 capability cannot create, renew, reach v1 or reach another owner/key', async () => {
    const c = await context(), f = await fixture(); await offer(c, f);
    const legacy = createOrder({ ...f.order, id: 'c'.repeat(32), reference: addr(44), asset: 'SOL' });
    await c.api.create(owner, 'synthetic-legacy-key', 'synthetic-legacy-intent', legacy, Date.now());
    const expiresAt = Date.now() - 1;
    c.storage.sql.exec('UPDATE api_sessions SET expires_at=? WHERE hash=?', expiresAt, owner);
    assert.throws(() => c.api.authenticate(owner, Date.now()), /unauthorized/);
    assert.throws(() => c.api.owner(owner, legacy.id, Date.now()), /unauthorized/);
    assert.throws(() => c.api.ownerPaid(owner, legacy.id), /order_not_found/);
    assert.throws(() => c.api.authenticateResume(owner, legacy.id, undefined, Date.now()), /unauthorized/);
    assert.throws(() => c.api.authenticateResume(owner, undefined, 'synthetic-legacy-key', Date.now()), /unauthorized/);
    assert.throws(() => c.api.authenticateResume(owner, undefined, 'synthetic-wrong-key', Date.now()), /unauthorized/);
    assert.throws(() => c.api.authenticateResume(owner, undefined, undefined, Date.now()), /unauthorized/);
    assert.throws(() => c.api.authenticateResume(owner, f.order.id, f.key, Date.now()), /unauthorized/);
    assert.throws(() => c.paid.byKey(owner, 'synthetic-wrong-key', Date.now()), /order_not_found/);
    const next = await fixture(), before = c.count('orders');
    await assert.rejects(offer(c, next, { now: Date.now() }), /unauthorized/);
    await assert.rejects(c.api.create(owner, 'synthetic-next-key', 'synthetic-next-intent', legacy, Date.now()), /unauthorized/);
    assert.equal(c.count('orders'), before); assert.equal(c.count('paid_holds'), 1);
    assert.throws(() => c.paid.get(otherOwner, f.order.id, Date.now()), /order_not_found/);
    assert.throws(() => c.paid.byKey(otherOwner, f.key, Date.now()), /order_not_found/);
    c.storage.sql.exec('UPDATE api_sessions SET expires_at=? WHERE hash=?', expiresAt, otherOwner);
    assert.throws(() => c.api.authenticateResume(otherOwner, f.order.id, undefined, Date.now()), /unauthorized/);
    assert.throws(() => c.api.authenticateResume(otherOwner, undefined, f.key, Date.now()), /unauthorized/);
    const freshOwner = 'a'.repeat(64); await c.api.issue(freshOwner, Date.now() + 86400000);
    assert.doesNotThrow(() => c.api.authenticate(freshOwner, Date.now()));
    assert.throws(() => c.paid.get(freshOwner, f.order.id, Date.now()), /order_not_found/);
    assert.throws(() => c.paid.byKey(freshOwner, f.key, Date.now()), /order_not_found/);
    await assert.rejects(c.api.issue(owner, Date.now() + 86400000), /UNIQUE constraint failed/);
    assert.equal(c.rows('SELECT expires_at FROM api_sessions WHERE hash=?', owner)[0].expires_at, expiresAt);
  });

  await test('known reserved signature reconciles without another payment; paused executor retains obligation', async () => {
    const c = await context(), f = await fixture(); await offer(c, f); await prepare(c, f); await reserve(c, f);
    const mock = mockRunner(c, f, { noRead: true }); await run(c, f, mock);
    assert.equal(c.count('credits'), 0); assert.equal(mock.calls.sign, 0); assert.equal(c.paid.treasury.paidTotals().reservedWinston, '30');
    mock.state.noRead = false; await run(c, f, mock, { CHECKOUT_PAID_EXECUTION_ENABLED: 'false' });
    assert.equal(c.count('credits'), 1); assert.equal(mock.calls.read, 2); assert.equal(mock.calls.lookup, 0);
    assert.equal(mock.calls.sign, 0); assert.equal(c.paid.snapshot(f.order.id).execution.reason, 'executor_paused');
    mock.state.proof = 'complete'; await run(c, f, mock);
    assert.equal(c.count('credits'), 1); assert.equal(mock.calls.sign, 1); assert.equal(c.paid.snapshot(f.order.id).execution.status, 'completed');
  });

  await test('lease excludes simultaneous runners; a persisted signed job resumes without new preparation or signature', async () => {
    let c = await context(); const f = await fixture(); await offer(c, f); await pay(c, f);
    const work = await c.paid.claim(f.order.id, 'before-crash', Date.now()); assert(work);
    const signed = await c.paid.signed(f.order.id, 'before-crash', signedFor(work.prepared));
    const blocked = mockRunner(c, f); await run(c, f, blocked);
    assert.equal(blocked.calls.submit.length, 0); assert.equal(blocked.calls.reconcile, 0);
    c = reopen(c); c.storage.sql.exec('UPDATE paid_orders SET lease_until=0 WHERE order_id=?', f.order.id);
    const resumed = mockRunner(c, f); await run(c, f, resumed);
    assert.equal(resumed.calls.prepare, 0); assert.equal(resumed.calls.sign, 0); assert.equal(resumed.calls.submit.length, 1);
    assert.deepEqual(resumed.calls.submit[0], signed); assert.equal(c.paid.work(f.order.id).submitAcknowledged, true);
  });

  assert.equal(externalCalls, 0, 'no outbound network is permitted in this suite');
  console.log(`Paid SQLite integration: ${checks} scenarios passed; external requests: ${externalCalls}.`);
} finally {
  globalThis.fetch = originalFetch;
  for (const c of contexts) c.storage.close();
  await rm(temp, { recursive: true, force: true });
}
