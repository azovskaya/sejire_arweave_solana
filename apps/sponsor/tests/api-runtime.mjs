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
const contribution = { kind: 'contribution', contribution: '1000000.000001', payer: b58(32, 1) };
const preservation = { kind: 'preservation', contribution: '0', payer: b58(32, 1), archive: { digest: 'b'.repeat(64), bytes: 800000 } };
const origin = 'https://preview.example';
if (!process.argv[2]) {
  const temp = await mkdtemp(resolve(tmpdir(), 'sejire-api-'));
  try {
    const bundle = resolve(temp, 'worker.mjs');
    await buildWorker(resolve(here, 'api-worker.ts'), bundle);
    for (const phase of ['write', 'restart-read', 'disabled']) {
      await new Promise((done, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), phase, temp, bundle], { stdio: 'inherit' });
        child.on('error', reject); child.on('exit', code => code === 0 ? done() : reject(new Error(`API phase ${phase}: exit ${code}`)));
      });
    }
    console.log('api.runtime: PASS; real HTTP handlers + on-disk DO SQLite, independent process restart, SYNTHETIC RPC, no payments/deployment');
  } finally { await rm(temp, { recursive: true, force: true }); }
} else {
  const [phase, persist, scriptPath] = process.argv.slice(2);
  const runtime = new Miniflare({ modules: true, scriptPath, modulesRoot: dirname(scriptPath), compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { CHECKOUT_LEDGER: { className: 'CheckoutLedger', useSQLite: true } }, durableObjectsPersist: resolve(persist, 'db'),
    bindings: { CHECKOUT_API_ENABLED: phase === 'disabled' ? 'false' : 'true', CHECKOUT_ALLOWED_ORIGINS: origin,
      CHECKOUT_SERVICE_RECIPIENT: b58(32, 2), CHECKOUT_FUND_RECIPIENT: b58(32, 3), CHECKOUT_POLICY_VERSION: 'a2-2-test-v1', MAX_ENVELOPE_BYTES: '524288' } });
  let passed = 0;
  const test = async (name, fn) => { await fn(); passed++; console.log(`PASS API ${phase}: ${name}`); };
  const call = async (path, token, payload, extras = {}, method = payload === undefined ? 'GET' : 'POST') => {
    const response = await runtime.dispatchFetch(`https://api.example/api/checkout${path}`, { method,
      headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extras },
      ...(payload === undefined ? {} : { body: typeof payload === 'string' ? payload : JSON.stringify(payload) }) });
    const data = response.status === 204 ? null : await response.json();
    return { status: response.status, body: data, headers: response.headers };
  };
  const session = async (ip = '192.0.2.1') => {
    const r = await call('/session', null, {}, { 'CF-Connecting-IP': ip }); assert.equal(r.status, 201); return r.body.accessToken;
  };
  const create = (token, key, payload = preservation, extras = {}) => call('/orders', token, payload, { 'Idempotency-Key': key, ...extras });
  const verify = (token, id, fill = 5, mode = 'success', extra = {}) => call(`/orders/${id}/verify`, token, { signature: b58(64, fill), ...extra }, { 'X-Test-Rpc': mode });
  const namespace = await runtime.getDurableObjectNamespace('CHECKOUT_LEDGER');
  const stub = namespace.get(namespace.idFromName('sejire-checkout-ledger-v1'));
  const internal = async payload => { const r = await stub.fetch('https://ledger.internal/', { method: 'POST', body: JSON.stringify(payload) }); assert.equal(r.status, 200); return r.json(); };
  const totals = () => internal({ action: 'totals' });
  try {
    if (phase === 'write') {
      const a = await session(), b = await session(); let first, donation, pending, limited, uploadOrder, uploadSerialized;
      await test('server-issued access token; cross-origin no-store and no secret echo', async () => {
        assert.match(a, /^[a-f0-9]{64}$/); assert.notEqual(a, b);
        const r = await create(a, 'preservation_key_01'); assert.equal(r.status, 201); first = r.body.record.order;
        assert.equal(r.headers.get('Cache-Control'), 'no-store'); assert.equal(r.headers.get('Access-Control-Allow-Origin'), origin);
        assert.equal(JSON.stringify(r.body).includes(a), false);
        assert.equal(first.servicePayment.amount, '30000000'); assert.equal(first.fundContribution.amount, '0');
        assert.equal(first.network, 'devnet'); assert.equal(first.asset.symbol, 'SOL'); assert.equal(first.policyVersion, 'a2-2-test-v1');
        assert.equal(first.archive.bytes, 800000); assert.equal(r.body.record.states.preservation, 'awaiting-payment');
      });
      await test('A reads own order; B/unknown token/id do not reveal order', async () => {
        assert.equal((await call(`/orders/${first.id}`, a)).status, 200);
        assert.equal((await call(`/orders/${first.id}`, b)).status, 404);
        assert.equal((await call(`/orders/${first.id}`, '0'.repeat(64))).status, 401);
        assert.equal((await call(`/orders/${'0'.repeat(32)}`, a)).status, 404);
      });
      await test('unauthorized submission and reconcile cannot write pendingSignature', async () => {
        assert.equal((await verify(b, first.id)).status, 404);
        assert.equal((await verify(null, first.id)).status, 401);
        assert.equal((await call(`/orders/${first.id}/reserve`, b, { signature: b58(64, 5) })).status, 404);
        assert.equal((await call(`/orders/${first.id}/reconcile`, b, {})).status, 404);
        assert.equal((await internal({ action: 'get', id: first.id })).pendingSignature, undefined);
      });
      await test('same key normalized intent returns same order; changed intent conflicts', async () => {
        const repeat = await create(a, 'preservation_key_01', { ...preservation, contribution: '0.000000' });
        assert.equal(repeat.status, 200); assert.deepEqual(repeat.body.record.order, first);
        assert.equal((await create(a, 'preservation_key_01', { ...preservation, contribution: '1' })).status, 409);
        const other = await create(b, 'preservation_key_01'); assert.equal(other.status, 201); assert.notEqual(other.body.record.order.id, first.id);
      });
      await test('parallel create gives one order and one reference', async () => {
        const results = await Promise.all(Array.from({ length: 6 }, () => create(b, 'parallel_create_key')));
        assert.equal(results.filter(r => r.status === 201).length, 1);
        assert.equal(new Set(results.map(r => r.body.record.order.id)).size, 1);
      });
      await test('client price/recipient/network/evidence and paid claims rejected', async () => {
        for (const injection of [{ servicePayment: { amount: '1' } }, { recipient: b58(32, 91) }, { network: 'mainnet-beta' }, { paid: true }, { TransactionEvidence: {} }]) {
          assert.equal((await create(a, 'tamper_input_key01', { ...preservation, ...injection })).status, 400);
        }
        assert.equal((await verify(a, first.id, 5, 'success', { finalized: true })).status, 400);
        assert.equal((await verify(a, first.id, 5, 'success', { evidence: {} })).status, 400);
        assert.equal((await internal({ action: 'get', id: first.id })).pendingSignature, undefined);
      });
      await test('donation without archive/service; million SOL exact and maximum native amount accepted', async () => {
        const r = await create(a, 'contribution_key01', contribution); assert.equal(r.status, 201); donation = r.body.record.order;
        assert.equal(donation.servicePayment.amount, '0'); assert.equal(donation.fundContribution.amount, '1000000000001000'); assert.equal(donation.archive, undefined);
        const max = await create(a, 'maximum_native_key', { ...contribution, contribution: '18446744073.709551615' }); assert.equal(max.status, 201);
        assert.equal(max.body.record.order.total, '18446744073709551615');
        assert.equal((await create(a, 'maximum_native_key', { ...contribution, contribution: '18446744073.709551616' })).status, 400);
        assert.equal((await create(a, 'invalid_archive_key', { ...contribution, archive: preservation.archive })).status, 400);
      });
      await test('16 parallel verifications credit once; retries preserve verified/ready semantics', async () => {
        const results = await Promise.all(Array.from({ length: 16 }, () => verify(a, first.id)));
        assert.equal(results.filter(r => r.body.status === 'credited').length, 1); assert.equal(results.filter(r => r.body.status === 'already-credited').length, 15);
        assert.equal(results.every(r => r.status === 200), true);
        const r = await verify(a, first.id); assert.equal(r.body.status, 'already-credited');
        assert.equal(r.body.record.states.payment, 'verified'); assert.equal(r.body.record.states.preservation, 'ready');
        assert.equal(r.body.record.states.contribution, 'not-requested'); assert.deepEqual(r.body.verification, { status: 'verified' });
        assert.equal((await verify(a, donation.id, 6)).body.record.states.contribution, 'received');
        assert.equal(Object.values(await totals()).includes('30000000'), true); assert.equal(Object.values(await totals()).includes('1000000000001000'), true);
      });
      await test('RPC uncertainty and bad recipient do not create credits; pending cannot be replaced', async () => {
        const r = await create(b, 'pending_order_key1'); pending = r.body.record.order;
        for (const mode of ['null', '429', '500', 'malformed', 'timeout', 'confirmed', 'wrong-network', 'wrong-recipient', 'failed']) {
          const result = await verify(b, pending.id, 7, mode); assert.equal(result.status, 202, mode);
          assert.equal(result.body.record.pendingSignature, b58(64, 7)); assert.equal(result.body.record.states.payment, 'requires-reconciliation');
          assert.equal(result.body.record.payment, undefined);
        }
        assert.equal((await verify(b, pending.id, 8)).status, 409);
        assert.equal((await call(`/orders/${pending.id}/reconcile`, b, { signature: b58(64, 8) })).status, 400);
      });
      await test('body bound works without Content-Length; malformed JSON/precision refused', async () => {
        assert.equal((await call('/orders', a, ' '.repeat(4097), { 'Idempotency-Key': 'oversize_request01' })).status, 413);
        assert.equal((await call('/orders', b, '{', { 'Idempotency-Key': 'malformed_json_01' })).status, 400);
        assert.equal((await create(b, 'precision_input01', { ...contribution, contribution: '1.0000000001' })).status, 400);
      });
      await test('origin allowlist and preflight do not replace bearer authorization', async () => {
        assert.equal((await call(`/orders/${first.id}`, a, undefined, { Origin: 'https://evil.example' })).status, 403);
        const r = await call('/orders', null, undefined, {}, 'OPTIONS'); assert.equal(r.status, 204);
        assert.equal((await call(`/orders/${first.id}`, null)).status, 401);
        assert.equal((await call(`/orders/${first.id}?accessToken=fake`, a)).status, 400);
      });
      await test('production entry exposes no commit/ledger/fault endpoint or client action', async () => {
        for (const path of ['/commit', '/totals', '/begin', '/fault', '/apiCommit', '/orders/commit']) {
          assert.equal((await call(path, a, { action: 'commit', payment: {} }, { 'X-Test-Production-Entry': 'true' })).status, 404);
        }
        assert.equal((await call('/orders', a, { action: 'apiCommit', payment: {} }, { 'Idempotency-Key': 'internal_action01', 'X-Test-Production-Entry': 'true' })).status, 400);
      });
      await test('uploader/account readiness rejects BEFORE order is offered', async () => {
        assert.equal((await create(b, 'unready_uploader01', preservation, { 'X-Test-Upload': 'not-ready' })).status, 503);
        assert.equal((await create(b, 'unready_accounts01', contribution, { 'X-Test-Accounts': 'missing' })).status, 503);
      });
      await test('paid preservation binds exact ciphertext; B cannot upload A archive', async () => {
        const envelope = { schema: 'sejire/envelope/v1', vault_id: 'c'.repeat(32), cipher: 'aes-gcm-256', kdf: 'hkdf-sha256', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', protocol: 'sejire/v0.3' };
        uploadSerialized = JSON.stringify(envelope);
        const hash = (await import('node:crypto')).createHash('sha256').update(uploadSerialized).digest('hex');
        const r = await create(b, 'execution_order01', { ...preservation, contribution: '10', archive: { digest: hash, bytes: Buffer.byteLength(uploadSerialized) } });
        assert.equal(r.status, 201); uploadOrder = r.body.record.order;
        assert.equal((await call(`/orders/${uploadOrder.id}/execute`, b, { serialized: uploadSerialized })).status, 409);
        assert.equal((await verify(b, uploadOrder.id, 15)).status, 200);
        assert.equal((await call(`/orders/${uploadOrder.id}/execute`, a, { serialized: uploadSerialized })).status, 404);
        const altered = uploadSerialized.replace('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
        assert.equal((await call(`/orders/${uploadOrder.id}/execute`, b, { serialized: altered })).status, 400);
      });
      await test('Turbo acceptance is distinct from retrieval; signed item and receipt are persistent', async () => {
        const r = await call(`/orders/${uploadOrder.id}/execute`, b, { serialized: uploadSerialized }, { 'X-Test-Upload': 'not-retrieved' });
        assert.equal(r.status, 202); assert.equal(r.body.record.states.preservation, 'requires-reconciliation');
        assert.equal(r.body.execution.accepted.winc, '0'); assert.equal(r.body.execution.retrieved, false);
      });
      await test('persistent verification quota works and unauthorized does not reserve signature', async () => {
        limited = await session('192.0.2.2'); const r = await create(limited, 'rate_limited_order', contribution, { 'CF-Connecting-IP': '192.0.2.2' });
        const id = r.body.record.order.id;
        for (let i = 0; i < 30; i++) assert.equal((await verify(limited, id, 10, 'null')).status, 202);
        assert.equal((await verify(limited, id, 10, 'null')).status, 429);
      });
      await test('persistent create quota and anonymous bootstrap quota work', async () => {
        const token = await session('192.0.2.3');
        for (let i = 0; i < 20; i++) assert.equal((await create(token, `quota_order_${String(i).padStart(5, '0')}`, contribution, { 'CF-Connecting-IP': '192.0.2.3' })).status, 201);
        assert.equal((await create(token, 'quota_over_limit01', contribution, { 'CF-Connecting-IP': '192.0.2.3' })).status, 429);
        for (let i = 0; i < 10; i++) await session('192.0.2.4');
        assert.equal((await call('/session', null, {}, { 'CF-Connecting-IP': '192.0.2.4' })).status, 429);
      });
      await writeFile(resolve(persist, 'state.json'), JSON.stringify({ a, b, limited, first, donation, pending, uploadOrder, uploadSerialized, totals: await totals() }));
    } else if (phase === 'restart-read') {
      const s = JSON.parse(await readFile(resolve(persist, 'state.json'), 'utf8'));
      await test('fresh process recovers access ownership immutable conditions and separate credits', async () => {
        assert.deepEqual((await call(`/orders/${s.first.id}`, s.a)).body.record.order, s.first);
        assert.equal((await call(`/orders/${s.first.id}`, s.b)).status, 404);
        assert.deepEqual(await totals(), s.totals);
        assert.equal((await call(`/orders/${s.donation.id}`, s.a)).body.record.payment.credits[0].amount, '1000000000001000');
      });
      await test('idempotency survives restart/lost response without creating a second order', async () => {
        const r = await create(s.a, 'preservation_key_01'); assert.equal(r.status, 200); assert.equal(r.body.record.order.id, s.first.id);
        assert.equal((await create(s.a, 'preservation_key_01', { ...preservation, contribution: '1' })).status, 409);
      });
      await test('lost verification response after commit resumes without duplicate credit', async () => {
        const before = await totals(); const r = await call(`/orders/${s.first.id}/reconcile`, s.a, {});
        assert.equal(r.body.status, 'already-credited'); assert.deepEqual(await totals(), before);
      });
      await test('pending signature and last uncertainty survive restart; resume credits once', async () => {
        const saved = (await call(`/orders/${s.pending.id}`, s.b)).body;
        assert.equal(saved.record.pendingSignature, b58(64, 7)); assert.equal(saved.record.states.payment, 'requires-reconciliation');
        assert.equal(saved.verification.status, 'requires-reconciliation');
        const r = await call(`/orders/${s.pending.id}/reconcile`, s.b, {}); assert.equal(r.body.status, 'credited');
        const totalsAfter = await totals(); assert.equal((await call(`/orders/${s.pending.id}/reconcile`, s.b, {})).body.status, 'already-credited'); assert.deepEqual(await totals(), totalsAfter);
      });
      await test('upload receipt survives restart; concurrent execution reuses one item then retrieval completes', async () => {
        const before = await call(`/orders/${s.uploadOrder.id}`, s.b);
        assert.equal(before.body.execution.retrieved, false); const id = before.body.execution.id;
        const results = await Promise.all(Array.from({ length: 8 }, () => call(`/orders/${s.uploadOrder.id}/execute`, s.b, { serialized: s.uploadSerialized })));
        assert.equal(results.every(r => r.status === 200 || r.status === 202), true);
        const after = await call(`/orders/${s.uploadOrder.id}`, s.b);
        assert.equal(after.body.execution.id, id); assert.equal(after.body.execution.retrieved, true); assert.equal(after.body.record.states.preservation, 'completed');
        const again = await call(`/orders/${s.uploadOrder.id}/execute`, s.b, { serialized: s.uploadSerialized });
        assert.equal(again.status, 200); assert.equal(again.body.execution.id, id);
      });
      await test('rate limit persists across process restart', async () => {
        const r = await call(`/orders/${s.first.id}/verify`, s.limited, { signature: b58(64, 99) }); assert.equal(r.status, 404);
        const fresh = await create(s.limited, 'new_order_after_restart', contribution, { 'CF-Connecting-IP': '192.0.2.2' });
        assert.equal(fresh.status, 201);
        assert.equal((await verify(s.limited, fresh.body.record.order.id, 10, 'null')).status, 429);
        assert.equal((await internal({ action: 'get', id: fresh.body.record.order.id })).pendingSignature, undefined);
      });
    } else if (phase === 'disabled') {
      await test('disabled API opens no routes including OPTIONS through production entry', async () => {
        for (const path of ['/session', '/orders', `/orders/${'a'.repeat(32)}`, `/orders/${'a'.repeat(32)}/verify`, `/orders/${'a'.repeat(32)}/reconcile`]) {
          for (const method of ['GET', 'POST', 'OPTIONS']) assert.equal((await call(path, null, method === 'POST' ? {} : undefined, { 'X-Test-Production-Entry': 'true' }, method)).status, 404);
        }
      });
    } else throw new Error('unknown_phase');
    console.log(`api ${phase}: ${passed} scenarios PASS`);
  } finally { await runtime.dispose(); }
}
