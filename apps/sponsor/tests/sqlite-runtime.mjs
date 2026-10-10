import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildWorker } from './build-worker.mjs';
import { Miniflare } from 'miniflare';

const here = dirname(fileURLToPath(import.meta.url));
function b58(size, fill) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = 0n;
  for (let i = 0; i < size; i++) n = (n << 8n) + BigInt(fill);
  let out = ''; for (; n > 0n; n /= 58n) out = alphabet[Number(n % 58n)] + out; return out;
}
function order(id = 'a', reference = 4, amount = '97000000', contributionOnly = false) {
  const service = contributionOnly ? '0' : '3000000';
  return { schema: 'sejire/order/v1', id: id.repeat(32), kind: contributionOnly ? 'contribution' : 'preservation', network: 'devnet',
    asset: { symbol: 'USDC', decimals: 6, mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
    payer: b58(32, 1), reference: b58(32, reference), createdAt: 1000000, expiresAt: 1100000, policyVersion: 'synthetic-v1',
    servicePayment: { amount: service, recipient: b58(32, 2) }, fundContribution: { amount, recipient: b58(32, 3) }, total: (BigInt(service) + BigInt(amount)).toString(),
    networkFee: { asset: 'SOL', includedInTotal: false }, ...(contributionOnly ? {} : { archive: { digest: 'b'.repeat(64), bytes: 800000 } }) };
}
function payment(o, fill = 5) {
  return { orderId: o.id, network: o.network, signature: b58(64, fill), slot: 100, feeLamports: '5000',
    credits: ['servicePayment', 'fundContribution'].filter(p => o[p].amount !== '0').map((purpose, index) => ({ purpose, ...o[purpose], instruction: String(index) })) };
}
if (!process.argv[2]) {
  const temp = await mkdtemp(resolve(tmpdir(), 'sejire-sqlite-'));
  try {
    const bundle = resolve(temp, 'worker.mjs');
    await buildWorker(resolve(here, 'sqlite-worker.ts'), bundle);
    for (const phase of ['write', 'restart-read']) {
      await new Promise((done, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), phase, temp, bundle], { stdio: 'inherit' });
        child.on('error', reject); child.on('exit', code => code === 0 ? done() : reject(new Error(`runtime phase ${phase}: exit ${code}`)));
      });
    }
    console.log('sqlite.runtime: PASS; separate Node/workerd processes reopened persisted SQLite; no in-memory adapter, no cloud resources');
  } finally { await rm(temp, { recursive: true, force: true }); }
} else {
  const [phase, persist, scriptPath] = process.argv.slice(2);
  const runtime = new Miniflare({ modules: true, scriptPath, modulesRoot: dirname(scriptPath), compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { CHECKOUT_LEDGER: { className: 'CheckoutLedger', useSQLite: true }, FAULT_LEDGER: { className: 'FaultLedger', useSQLite: true } },
    durableObjectsPersist: resolve(persist, 'db') });
  let passed = 0;
  const test = async (name, fn) => { await fn(); passed++; console.log(`PASS SQLite ${phase}: ${name}`); };
  try {
    const namespace = await runtime.getDurableObjectNamespace('CHECKOUT_LEDGER');
    const stub = namespace.get(namespace.idFromName('sejire-checkout-ledger-v1'));
    const call = async payload => {
      const response = await stub.fetch('https://ledger.internal/', { method: 'POST', body: JSON.stringify(payload) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error); return body;
    };
    const faults = await runtime.getDurableObjectNamespace('FAULT_LEDGER'), faultStub = faults.get(faults.idFromName('faults'));
    const fault = async action => {
      const response = await faultStub.fetch('https://test.internal/', { method: 'POST', body: JSON.stringify({ action }) });
      return { status: response.status, body: response.ok ? await response.json() : await response.text() };
    };
    const a = order(), pay = payment(a);
    if (phase === 'write') {
      await test('immutable order and pending signature saved', async () => {
        await call({ action: 'create', order: a }); await call({ action: 'begin', id: a.id, signature: pay.signature });
        assert.deepEqual((await call({ action: 'get', id: a.id })).order, a);
        await assert.rejects(call({ action: 'create', order: { ...a, fundContribution: { ...a.fundContribution, amount: '1' } } }));
      });
      await test('global reference uniqueness across orders', async () => {
        await assert.rejects(call({ action: 'create', order: order('b') }), /order_or_reference_exists/);
      });
      await test('32 concurrent confirmations yield one credit', async () => {
        const results = await Promise.all(Array.from({ length: 32 }, () => call({ action: 'commit', payment: pay })));
        assert.equal(results.filter(r => r.status === 'credited').length, 1); assert.equal(results.filter(r => r.status === 'already-credited').length, 31);
      });
      await test('transaction replay across different orders blocked', async () => {
        const b = order('b', 6); await call({ action: 'create', order: b }); await call({ action: 'begin', id: b.id, signature: pay.signature });
        await assert.rejects(call({ action: 'commit', payment: payment(b) }), /payment_already_used/);
        assert.equal((await call({ action: 'get', id: b.id })).payment, undefined);
      });
      await test('unresolved signature is retained and cannot be replaced', async () => {
        const pending = order('c', 7); await call({ action: 'create', order: pending }); await call({ action: 'begin', id: pending.id, signature: b58(64, 7) });
        await assert.rejects(call({ action: 'begin', id: pending.id, signature: b58(64, 8) }), /previous_payment_unresolved/);
      });
      await test('large values and cumulative totals beyond u64 stay exact', async () => {
        for (const [id, fill] of [['d', 8], ['e', 9]]) {
          const huge = order(id, fill, '18446744073709551615', true), p = payment(huge, fill);
          await call({ action: 'create', order: huge }); await call({ action: 'begin', id: huge.id, signature: p.signature }); await call({ action: 'commit', payment: p });
        }
        const totals = await call({ action: 'totals' });
        assert.equal(Object.entries(totals).find(([k]) => k.endsWith(':fundContribution'))[1], '36893488147516103230');
        assert.equal(Object.entries(totals).find(([k]) => k.endsWith(':servicePayment'))[1], '3000000');
      });
      await test('fault before commit rolls back inserts and preserves pending operation', async () => {
        await fault('prepare'); assert.equal((await fault('fail-before-commit')).status, 503);
        const snapshot = (await fault('snapshot')).body; assert.deepEqual(snapshot.totals, {});
        assert.equal(snapshot.record.payment, undefined); assert.equal(snapshot.record.pendingSignature, b58(64, 16));
        assert.equal(snapshot.record.states.payment, 'requires-reconciliation');
      });
      await test('lost response AFTER durable commit does not erase credit', async () => {
        assert.equal((await fault('commit-response-lost')).status, 503);
        const snapshot = (await fault('snapshot')).body;
        assert.equal(snapshot.record.states.payment, 'verified'); assert.equal(Object.keys(snapshot.totals).length, 2);
      });
    } else if (phase === 'restart-read') {
      await test('new process reopens complete order/payment/credits/states', async () => {
        const saved = await call({ action: 'get', id: a.id }); assert.deepEqual(saved.order, a); assert.deepEqual(saved.payment, pay);
        assert.equal(saved.states.payment, 'verified'); assert.equal(saved.states.preservation, 'ready'); assert.equal(saved.states.contribution, 'received');
      });
      await test('repeat confirmation after restart never credits again', async () => {
        assert.equal((await call({ action: 'commit', payment: pay })).status, 'already-credited');
        await assert.rejects(call({ action: 'commit', payment: payment(order('b', 6)) }), /payment_already_used/);
      });
      await test('unfinished reconciliation survives restart then completes once', async () => {
        const c = order('c', 7), p = payment(c, 7), saved = await call({ action: 'get', id: c.id });
        assert.equal(saved.pendingSignature, p.signature); assert.equal(saved.states.payment, 'requires-reconciliation');
        await assert.rejects(call({ action: 'begin', id: c.id, signature: b58(64, 8) }), /previous_payment_unresolved/);
        assert.equal((await call({ action: 'commit', payment: p })).status, 'credited');
        assert.equal((await call({ action: 'commit', payment: p })).status, 'already-credited');
      });
      await test('exact large amounts remain TEXT after reopen', async () => {
        const saved = await call({ action: 'get', id: 'd'.repeat(32) });
        assert.equal(saved.order.fundContribution.amount, '18446744073709551615'); assert.equal(saved.payment.credits[0].amount, saved.order.fundContribution.amount);
        const totals = await call({ action: 'totals' });
        assert.equal(Object.entries(totals).find(([k]) => k.endsWith(':fundContribution'))[1], '36893488147613103230');
      });
      await test('lost commit response followed by process restart returns already-credited', async () => {
        assert.equal((await fault('retry')).body.status, 'already-credited');
      });
      await test('wrong object identity cannot create separate uniqueness island', async () => {
        const wrong = namespace.get(namespace.idFromName('per-order-is-forbidden'));
        await assert.rejects(async () => { const r = await wrong.fetch('https://ledger.internal/', { method: 'POST', body: JSON.stringify({ action: 'create', order: order('9', 19) }) }); if (!r.ok) throw new Error('wrong_ledger_object'); });
      });
    } else throw new Error('unknown_phase');
    // Frozen public evidence from actual devnet; CI reuses it OFFLINE, not a live payment.
    const liveCases = JSON.parse(await readFile(resolve(here, '../../../docs/verification/2026-10-02-native-devnet-public.json'), 'utf8')).transactions;
    await test('saved real devnet payments: disk commit/reopen/repeat yields one credit per purpose', async () => {
      for (const item of liveCases) {
        if (phase === 'write') {
          await call({action:'create', order:item.order});
          await call({action:'begin', id:item.order.id, signature:item.signature});
          const results = await Promise.all(Array.from({length:8},()=>call({action:'commit',payment:item.payment})));
          assert.equal(results.filter(r=>r.status==='credited').length,1);
          assert.equal(results.filter(r=>r.status==='already-credited').length,7);
        } else {
          const saved = await call({action:'get',id:item.order.id});
          assert.deepEqual(saved.order,item.order);assert.deepEqual(saved.payment,item.payment);
          assert.equal((await call({action:'commit',payment:item.payment})).status,'already-credited');
        }
      }
      const totals=await call({action:'totals'});
      const solTotals=Object.fromEntries(Object.entries(totals).filter(([k])=>k.includes(':SOL:')));
      assert.deepEqual(Object.values(solTotals).sort(),['10000000','60000000']);
    });
    await writeFile(resolve(persist, `${phase}.json`), JSON.stringify({ phase, passed, runtime: 'Miniflare/workerd SQLite on disk', synthetic: true }));
    console.log(`sqlite ${phase}: ${passed} scenarios PASS`);
  } finally { await runtime.dispose(); }
}
