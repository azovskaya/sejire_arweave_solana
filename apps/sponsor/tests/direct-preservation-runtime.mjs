import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, createFetchMock, fetch as mockedFetch } from 'miniflare';
import { buildWorker } from './build-worker.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(resolve(tmpdir(), 'sejire-direct-arweave-'));
// Generated in memory, never loaded from a wallet or persisted in a fixture.
const pair = await webcrypto.subtle.generateKey({ name: 'RSA-PSS', modulusLength: 4096,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
const secret = JSON.stringify(jwk);
const treasury = createHash('sha256').update(Buffer.from(jwk.n, 'base64url')).digest('base64url');
const serialized = JSON.stringify({ schema: 'sejire/envelope/v1', vault_id: 'd'.repeat(32), cipher: 'aes-gcm-256',
  kdf: 'hkdf-sha256', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'A'.repeat(32), protocol: 'sejire/v0.3' });
const input = { orderId: 'e'.repeat(32), serialized, archive: { digest: createHash('sha256').update(serialized).digest('hex'),
  bytes: Buffer.byteLength(serialized), vaultId: 'd'.repeat(32), parentTxId: Buffer.alloc(32, 8).toString('base64url') } };
const fetchMock = createFetchMock(); fetchMock.disableNetConnect();
const wire = { mode: 'good', calls: [], uploads: [], signed: null };
const observe = (host, path, method) => wire.calls.push({ url: `${host}${path}`, method });
for (const host of ['https://arweave.net', 'https://g8way.io']) {
  const pool = fetchMock.get(host);
  for (const [path, body] of [
    ['/info', JSON.stringify({ network: 'arweave.N.1' })], ['/tx_anchor', Buffer.alloc(48, 7).toString('base64url')],
    [`/wallet/${treasury}/balance`, '68000000000000'], [`/price/${input.archive.bytes}`, '3000000000'],
  ]) pool.intercept({ path, method: 'GET' }).reply(() => { observe(host, path, 'GET'); return { statusCode: 200, data: body }; }).persist();
  pool.intercept({ path: /^\/tx\/[A-Za-z0-9_-]{43}\/status$/, method: 'GET' }).reply(options => {
    observe(host, options.path, 'GET');
    assert.equal(options.path, `/tx/${wire.signed.id}/status`);
    if (wire.mode === 'redirect') return { statusCode: 307, data: JSON.stringify({ number_of_confirmations: 7 }), responseOptions: { headers: { Location: 'https://attacker.example/collect' } } };
    return { statusCode: 200, data: JSON.stringify({ number_of_confirmations: 7 }) };
  }).persist();
  pool.intercept({ path: /^\/tx\/[A-Za-z0-9_-]{43}$/, method: 'GET' }).reply(options => {
    observe(host, options.path, 'GET'); assert.equal(options.path, `/tx/${wire.signed.id}`);
    const raw = JSON.parse(wire.signed.raw); raw.data = '';
    if (wire.mode === 'wrong-reward') raw.reward = '3000000001';
    return { statusCode: 200, data: JSON.stringify(raw) };
  }).persist();
  pool.intercept({ path: /^\/tx\/[A-Za-z0-9_-]{43}\/data$/, method: 'GET' }).reply(options => {
    observe(host, options.path, 'GET'); assert.equal(options.path, `/tx/${wire.signed.id}/data`);
    if (wire.mode === 'missing-archive') return { statusCode: 404, data: '' };
    const raw = wire.mode === 'wrong-archive' ? serialized.replace('"ciphertext":"A', '"ciphertext":"B') : serialized;
    return { statusCode: 200, data: Buffer.from(raw).toString('base64url') };
  }).persist();
  pool.intercept({ path: /^\/(raw\/)?[A-Za-z0-9_-]{43}$/, method: 'GET' }).reply(options => {
    observe(host, options.path, 'GET'); return { statusCode: 404, data: '' };
  }).persist();
}
fetchMock.get('https://arweave.net').intercept({ path: '/tx', method: 'POST' }).reply(options => {
  observe('https://arweave.net', '/tx', 'POST');
  const body = typeof options.body === 'string' ? options.body : Buffer.from(options.body).toString();
  wire.uploads.push(body); assert.equal(body, wire.signed.raw);
  return { statusCode: wire.mode === 'lost-ack' ? 503 : 200, data: wire.mode === 'lost-ack' ? 'synthetic lost acknowledgement' : 'OK' };
}).persist();

let runtime, passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS direct workerd: ${name}`); };
try {
  const scriptPath = resolve(temp, 'worker.mjs');
  await buildWorker(resolve(here, 'direct-preservation-worker.ts'), scriptPath);
  const start = async (includeSigner) => {
    const worker = new Miniflare({ modules: true, scriptPath, modulesRoot: temp, compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'],
      // No injected provider/transport: production code calls workerd fetch.
      // The bridge delivers one mocked HTTP hop and never follows Location.
      outboundService: async request => mockedFetch(request.url, {
        method: request.method, headers: request.headers, signal: request.signal,
        ...(request.body ? { body: new Uint8Array(await request.arrayBuffer()) } : {}), dispatcher: fetchMock, redirect: 'manual',
      }),
      bindings: { TEST_TREASURY: treasury, ...(includeSigner ? { TEST_RSA_JWK: secret } : {}) } });
    await worker.ready; return worker;
  };
  runtime = await start(true);
  const call = async (action, extra = {}) => {
    const response = await runtime.dispatchFetch('https://offline.example/direct', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Synthetic-Test': 'offline-direct-arweave' }, body: JSON.stringify({ action, input, ...extra }) });
    return { status: response.status, body: await response.json() };
  };
  let prepared;
  await test('default global fetch gets bounded mainnet readiness and unsigned preparation', async () => {
    const ready = await call('ready'); assert.equal(ready.status, 200); assert.equal(ready.body.signerAddress, treasury);
    const plan = await call('prepare'); assert.equal(plan.status, 200); prepared = plan.body;
    assert.equal(JSON.parse(prepared.raw).signature, ''); assert.equal(JSON.parse(prepared.raw).id, '');
    assert.ok(wire.calls.some(call => call.url.endsWith('/info'))); assert.ok(wire.calls.some(call => call.url.endsWith('/tx_anchor')));
    assert.ok(wire.calls.some(call => call.url.includes('/price/'))); assert.ok(wire.calls.some(call => call.url.includes('/wallet/')));
    assert.ok(wire.calls.every(call => call.method === 'GET'));
  });
  await test('actual RSA workerd signature has no network side effects and execution pause rejects signing', async () => {
    const before = wire.calls.length;
    assert.equal((await call('paused-sign', { prepared })).body.error, 'direct_execution_disabled');
    const signed = await call('sign', { prepared }); assert.equal(signed.status, 200); wire.signed = signed.body;
    assert.match(wire.signed.id, /^[A-Za-z0-9_-]{43}$/); assert.equal(wire.calls.length, before);
    assert.equal(JSON.parse(wire.signed.raw).data, Buffer.from(serialized).toString('base64url'));
  });
  await test('lost acknowledgement leaves immutable signed bytes for exact retry; acceptance is not completion', async () => {
    wire.mode = 'lost-ack';
    assert.equal((await call('submit', { signed: wire.signed })).body.error, 'direct_submit_uncertain');
    wire.mode = 'good';
    const accepted = await call('submit', { signed: wire.signed }); assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body, { id: wire.signed.id, accepted: true });
    assert.deepEqual(wire.uploads, [wire.signed.raw, wire.signed.raw]);
  });
  await test('confirmed metadata plus exact node-data produces complete proof', async () => {
    const result = await call('reconcile', { signed: wire.signed }); assert.equal(result.status, 200);
    assert.equal(result.body.onchainConfirmed, true); assert.equal(result.body.archiveVerified, true);
    assert.equal(result.body.rewardWinston, '3000000000'); assert.equal(result.body.confirmations, 7);
    assert.ok(wire.calls.some(call => call.url.endsWith(`/tx/${wire.signed.id}/data`)));
  });
  await test('confirmed spend survives unavailable/corrupted archive; neither case reports archive verified', async () => {
    for (const mode of ['missing-archive', 'wrong-archive']) {
      wire.mode = mode; const result = await call('reconcile', { signed: wire.signed });
      assert.equal(result.body.onchainConfirmed, true); assert.equal(result.body.archiveVerified, false);
      assert.equal(result.body.reason, mode === 'missing-archive' ? 'archive_unavailable' : 'archive_verification_failed');
    }
    wire.mode = 'good';
  });
  await test('wrong reward and redirected status cannot prove an AR debit', async () => {
    for (const mode of ['wrong-reward', 'redirect']) {
      wire.mode = mode; const result = await call('reconcile', { signed: wire.signed });
      assert.equal(result.body.onchainConfirmed, false); assert.equal(result.body.archiveVerified, false);
    }
    wire.mode = 'good';
    assert.ok(wire.calls.every(call => !call.url.startsWith('https://attacker.example/')));
  });
  await runtime.dispose(); runtime = await start(false);
  await test('fresh workerd isolate without secret rechecks the same persisted plan with GET only', async () => {
    const before = wire.calls.length, beforeUploads = wire.uploads.length;
    const result = await call('reconcile', { signed: wire.signed }); assert.equal(result.status, 200);
    assert.equal(result.body.onchainConfirmed, true); assert.equal(result.body.archiveVerified, true);
    assert.equal(wire.uploads.length, beforeUploads);
    assert.ok(wire.calls.slice(before).every(call => call.method === 'GET' && !/\/(price|info|tx_anchor)/.test(new URL(call.url).pathname)));
    assert.equal((await call('ready')).body.error, 'direct_signer_unavailable');
  });
  console.log(`direct-preservation.runtime: PASS (${passed} scenarios); actual default-fetch workerd, in-memory unfunded RSA, fresh isolate, network disabled`);
} finally {
  await runtime?.dispose(); await fetchMock.close(); await rm(temp, { recursive: true, force: true });
}
