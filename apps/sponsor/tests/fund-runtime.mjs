import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { buildWorker } from './build-worker.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const origin = 'https://preview.example';
const admin = 'synthetic-admin-token-32-characters';
const archive = JSON.stringify({ schema: 'sejire/envelope/v1', vault_id: 'a'.repeat(32), cipher: 'aes-gcm-256',
  kdf: 'hkdf-sha256', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'A'.repeat(32), protocol: 'sejire/v0.3' });
const order = (letter, code = 'TEST-PENSIONER-2') => ({ orderId: letter.repeat(32), preservationId: letter.repeat(32), code, archive });
const winston = 1_000_000_000_000n;

if (!process.argv[2]) {
  const temp = await mkdtemp(resolve(tmpdir(), 'sejire-fund-workerd-'));
  try {
    const bundle = resolve(temp, 'fund-worker.mjs');
    await buildWorker(resolve(here, 'fund-worker.ts'), bundle);
    for (const phase of ['disabled', 'write', 'restart-read']) {
      await new Promise((done, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), phase, temp, bundle], { stdio: 'inherit' });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? done() : reject(new Error(`fund workerd ${phase}: exit ${code}`)));
      });
    }
    console.log('fund.runtime: PASS; real workerd HTTP handlers and persisted SQLite Durable Object, mock only, no AR network calls');
  } finally { await rm(temp, { recursive: true, force: true }); }
} else {
  const [phase, persist, scriptPath] = process.argv.slice(2);
  const runtime = new Miniflare({ modules: true, scriptPath, modulesRoot: dirname(scriptPath),
    compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { CHECKOUT_LEDGER: { className: 'CheckoutLedger', useSQLite: true } },
    durableObjectsPersist: resolve(persist, 'db'),
    bindings: { FUND_API_ENABLED: phase === 'disabled' ? 'false' : 'true', CHECKOUT_ALLOWED_ORIGINS: origin,
      PROMO_CODE_SECRET: 'synthetic-hmac-secret-for-worker-runtime-tests-only', ADMIN_TOKEN: admin,
      MAX_ENVELOPE_BYTES: '524288' } });
  let passed = 0;
  const test = async (name, fn) => { await fn(); passed++; console.log(`PASS fund workerd ${phase}: ${name}`); };
  const call = async (path, payload, credential, ip = '192.0.2.1') => {
    const response = await runtime.dispatchFetch(`https://worker.example/api/fund${path}`, {
      method: payload === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json',
        'CF-Connecting-IP': ip, ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const control = async (path, payload) => {
    const response = await runtime.dispatchFetch(`https://worker.example/__test/${path}`, {
      method: payload === undefined ? 'GET' : 'POST', headers: { 'X-Synthetic-Test': 'synthetic-workerd-only', 'Content-Type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    assert.equal(response.status, 200); return response.json();
  };
  const dashboard = async () => { const result = await call('/admin/dashboard', undefined, admin); assert.equal(result.status, 200); return result.body; };
  const promo = code => call('/admin/promo', { code, confirm: code }, admin);
  try {
    await test('Worker health responds through workerd HTTP', async () => {
      assert.deepEqual(await control('health'), { healthy: true, runtime: 'workerd' });
    });
    if (phase === 'disabled') {
      await test('fund routes fail closed by default', async () => {
        assert.deepEqual((await call('/status')).body, { enabled: false, available: false });
        assert.equal((await call('/orders', order('0', 'TEST-PENSIONER'))).status, 404);
        assert.equal((await call('/validate', { code: 'TEST-PENSIONER' })).status, 404);
      });
      await test('read-only signed treasury readiness and admin dashboard work before fund activation', async () => {
        assert.equal((await call('/admin/readiness')).status, 401);
        const ready = await call('/admin/readiness', undefined, admin);
        assert.equal(ready.status, 200); assert.equal(ready.body.signerVerified, true);
        assert.equal(ready.body.signerAddress, 'qgoIFw9WsusMRapWzcFg4jNW08HSWvQkpAKOz86BUuI');
        assert.equal(ready.body.fundApiEnabled, false); assert.equal(ready.body.limitWinston, (13n * winston).toString());
        assert.equal(ready.body.walletBalanceWinston, '68000000000000');
        assert.equal(ready.body.currentQuoteWinston, '3000000000');
        assert.equal((await dashboard()).fundStatus, 'HEALTHY');
        await control('mock', { signerAddress: 'wrong-public-address' });
        assert.equal((await call('/admin/readiness', undefined, admin)).body.error, 'treasury_address_mismatch');
        assert.equal((await dashboard()).fundStatus, 'PROVIDER ERROR');
      });
    } else if (phase === 'write') {
      await test('every management route rejects missing and wrong server credential', async () => {
        const routes = [['/admin/dashboard', undefined], ['/admin/promo', { code: 'UNAUTHORIZED', confirm: 'UNAUTHORIZED' }],
          ['/admin/enabled', { enabled: true }], ['/admin/enabled', { enabled: false }],
          ['/admin/limit', { limitAr: '26' }], ['/admin/reconcile', {}]];
        for (const [path, payload] of routes) for (const credential of [undefined, 'incorrect-credential'])
          assert.equal((await call(path, payload, credential)).status, 401, `${path}: ${credential ?? 'missing'}`);
        assert.equal((await dashboard()).limitWinston, (13n * winston).toString());
      });
      await test('one promo validates, rotates immediately, and persists only hash/hint', async () => {
        assert.equal((await promo('TEST-PENSIONER')).status, 200);
        assert.equal((await call('/validate', { code: ' test-pensioner ' })).status, 200);
        assert.equal((await call('/validate', { code: 'WRONG-PENSIONER' })).body.error, 'promo_invalid');
        assert.equal((await promo('TEST-PENSIONER-2')).status, 200);
        assert.equal((await call('/validate', { code: 'TEST-PENSIONER' })).body.error, 'promo_invalid');
        assert.equal((await call('/validate', { code: 'TEST-PENSIONER-2' })).status, 200);
        assert.equal((await call('/admin/enabled', { enabled: false }, admin)).status, 200);
        assert.equal((await call('/validate', { code: 'TEST-PENSIONER-2' })).body.error, 'promo_disabled');
        assert.equal((await call('/admin/enabled', { enabled: true }, admin)).status, 200);
        const d = await dashboard(); assert.equal(d.promo.revision, 2); assert.equal(d.promo.enabled, true);
        assert.equal(JSON.stringify(d).includes('TEST-PENSIONER-2'), false);
      });
      await test('mock funded HTTP order completes with confirmed reward, not estimate', async () => {
        await control('mock', { estimate: '2800000000', price: '3000000000', actual: '3000000000' });
        const response = await call('/orders', order('a')); assert.equal(response.status, 200);
        assert.equal(response.body.order.status, 'COMPLETED');
        assert.equal(response.body.order.estimatedRewardWinston, '2800000000');
        assert.equal(response.body.order.actualRewardWinston, '3000000000');
        const d = await dashboard(); assert.equal(d.successfulTrees, 1); assert.equal(d.actualSpentWinston, '3000000000');
        assert.equal(d.treasuryAddress, 'qgoIFw9WsusMRapWzcFg4jNW08HSWvQkpAKOz86BUuI');
        assert.equal(d.walletBalanceWinston, '68000000000000');
        assert.equal(d.totalEncryptedBytes, new TextEncoder().encode(archive).length);
        assert.equal(d.averageArchiveBytes, d.totalEncryptedBytes);
        for (const key of ['today', 'last7Days', 'averageActualWinston', 'minActualWinston', 'maxActualWinston', 'history', 'budgetRemainingWinston', 'reservedWinston']) assert.ok(key in d, key);
        assert.equal(d.today, 1); assert.equal(d.last7Days, 1); assert.equal(d.history.length, 1);
      });
      await test('duplicate HTTP POST keeps one transaction and one charge', async () => {
        const before = await control('stats'); const first = (await call('/orders', order('a'))).body.order;
        const second = (await call('/orders', order('a'))).body.order;
        assert.equal(first.arweaveTxId, second.arweaveTxId);
        assert.equal((await control('stats')).submissions, before.submissions);
        assert.equal((await dashboard()).actualSpentWinston, '3000000000');
      });
      await test('13 to 26 AR changes cumulative cap without resetting ledger', async () => {
        const before = await dashboard();
        assert.equal((await call('/admin/limit', { limitAr: '0' }, admin)).body.error, 'limit_below_spent');
        const after = (await call('/admin/limit', { limitAr: '26' }, admin)).body;
        assert.equal(after.limitWinston, (26n * winston).toString());
        assert.equal(after.actualSpentWinston, before.actualSpentWinston);
        assert.equal(after.successfulTrees, before.successfulTrees);
        assert.equal(BigInt(after.budgetRemainingWinston) - BigInt(before.budgetRemainingWinston), 13n * winston);
      });
      await test('concurrent HTTP reservations respect exact SQLite limit', async () => {
        assert.equal((await call('/admin/limit', { limitAr: '0.0075' }, admin)).status, 200);
        await control('mock', { delay: true });
        const results = await Promise.all([call('/orders', order('b'), undefined, '192.0.2.21'), call('/orders', order('c'), undefined, '192.0.2.22')]);
        assert.equal(results.filter(x => x.body.order?.status === 'VERIFYING').length, 1);
        assert.equal(results.filter(x => x.body.error === 'fund_exhausted').length, 1);
        assert.equal((await dashboard()).reservedWinston, '3000000000');
        await control('mock', { delay: false });
        assert.equal((await call('/admin/reconcile', {}, admin)).status, 200);
        assert.equal((await dashboard()).successfulTrees, 2);
        assert.equal((await call('/admin/limit', { limitAr: '26' }, admin)).status, 200);
      });
      await test('lost response reconciles same signed txId without second signing', async () => {
        await control('mock', { failure: 'lost_response' });
        const first = await call('/orders', order('d'), undefined, '192.0.2.23');
        assert.equal(first.body.order.status, 'NEEDS_RECONCILIATION');
        const id = first.body.order.arweaveTxId, before = (await control('stats')).submissions;
        assert.equal((await dashboard()).reservedWinston, '3000000000');
        await control('mock', { failure: '' });
        assert.equal((await call('/admin/reconcile', {}, admin)).status, 200);
        const completed = (await call(`/orders/${'d'.repeat(32)}`)).body.order;
        assert.equal(completed.status, 'COMPLETED'); assert.equal(completed.arweaveTxId, id);
        assert.equal((await control('stats')).submissions, before);
      });
      await test('unaccepted upload reconciles by resubmitting saved signed bytes', async () => {
        await control('mock', { failure: 'upload' });
        const first = await call('/orders', order('e'), undefined, '192.0.2.24');
        assert.equal(first.body.order.status, 'NEEDS_RECONCILIATION');
        const id = first.body.order.arweaveTxId, before = (await control('stats')).submissions;
        await control('mock', { failure: '' });
        assert.equal((await call('/admin/reconcile', {}, admin)).status, 200);
        const completed = (await call(`/orders/${'e'.repeat(32)}`)).body.order;
        assert.equal(completed.status, 'COMPLETED'); assert.equal(completed.arweaveTxId, id);
        assert.equal((await control('stats')).submissions, before + 1);
      });
      await test('pending reservation and private data boundaries survive runtime', async () => {
        await control('mock', { delay: true });
        const pending = await call('/orders', order('f'), undefined, '192.0.2.25');
        assert.equal(pending.body.order.status, 'VERIFYING');
        const d = await dashboard(); assert.equal(d.reservedWinston, '3000000000');
        assert.equal(d.successfulTrees, 4); assert.equal(d.actualSpentWinston, '12000000000');
        assert.equal((await call('/orders', { ...order('9'), recoveryWords: 'synthetic only' }, undefined, '192.0.2.26')).body.error, 'forbidden_field');
        assert.equal((await call('/orders', { ...order('8'), plaintextTree: { name: 'Synthetic' } }, undefined, '192.0.2.27')).body.error, 'forbidden_field');
        const stub = (await runtime.getDurableObjectNamespace('CHECKOUT_LEDGER')).get(
          (await runtime.getDurableObjectNamespace('CHECKOUT_LEDGER')).idFromName('sejire-checkout-ledger-v1'));
        const response = await stub.fetch('https://ledger.internal/', { method: 'POST', body: JSON.stringify({ action: 'fundSettings' }) });
        const settings = await response.json(); assert.equal(response.status, 200);
        assert.equal(JSON.stringify(settings).includes('TEST-PENSIONER'), false);
        assert.equal(JSON.stringify(d).includes('TEST-PENSIONER-2'), false);
      });
    } else {
      await test('SQLite DO persists promo, limit, completed ledger and active reservation across process restart', async () => {
        const d = await dashboard();
        assert.equal(d.promo.enabled, true); assert.equal(d.promo.revision, 2);
        assert.equal(d.limitWinston, (26n * winston).toString());
        assert.equal(d.actualSpentWinston, '12000000000'); assert.equal(d.successfulTrees, 4);
        assert.equal(d.reservedWinston, '3000000000'); assert.equal(d.pending, 1);
        assert.equal(d.history.length, 5); assert.equal(d.history.filter(x => x.status === 'COMPLETED').length, 4);
        assert.equal((await call('/validate', { code: 'TEST-PENSIONER-2' })).status, 200);
        assert.equal((await call('/validate', { code: 'TEST-PENSIONER' })).body.error, 'promo_invalid');
      });
    }
    console.log(`fund workerd ${phase}: ${passed} acceptance checks PASS`);
  } finally { await runtime.dispose(); }
}
