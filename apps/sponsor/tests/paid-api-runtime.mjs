import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, createFetchMock, fetch as mockedFetch } from 'miniflare';
import { buildWorker } from './build-worker.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { Message } = createRequire(resolve(here, '../../web/package.json'))('@solana/web3.js');
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) {
  let n = 0n; for (const byte of bytes) n = (n << 8n) + BigInt(byte);
  let out = ''; for (; n > 0n; n /= 58n) out = alphabet[Number(n % 58n)] + out;
  const first = bytes.findIndex(byte => byte !== 0);
  return '1'.repeat(first < 0 ? bytes.length : first) + out;
}
const addr = fill => b58(Buffer.alloc(32, fill));
const sha = value => createHash('sha256').update(value).digest('hex');
const system = '11111111111111111111111111111111';
const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const origin = 'https://paid-preview.example';
const reward = '3000000000', hold = '4000000000';
const temp = await mkdtemp(resolve(tmpdir(), 'sejire-paid-api-'));
// Ephemeral, unfunded software keys. No wallet, deployment binding or live secret
// is read; private values stay in memory and never enter assertion output.
const payerKey = generateKeyPairSync('ed25519');
const payer = b58(payerKey.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
const arPair = await webcrypto.subtle.generateKey({ name: 'RSA-PSS', modulusLength: 4096,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const arKey = await webcrypto.subtle.exportKey('jwk', arPair.privateKey);
const treasury = createHash('sha256').update(Buffer.from(arKey.n, 'base64url')).digest('base64url');
const fetchMock = createFetchMock(); fetchMock.disableNetConnect();
const wire = { calls: [], payments: new Map(), archives: new Map(), submissions: new Map(),
  lostSingleAck: true, failChunkOnce: true, droppedChunks: 0, chunkPosts: 0, rpcRateLimited: false,
  rpcForbiddenDefault: false, rpcForbiddenPocket: false };
const observe = (url, method) => wire.calls.push({ url, method });
const parsedBody = options => JSON.parse(typeof options.body === 'string' ? options.body : Buffer.from(options.body).toString());

const rpcReply = (options, endpoint) => {
  observe(endpoint, 'POST');
  const request = parsedBody(options); let result;
  if (wire.rpcForbiddenDefault && endpoint === 'https://api.mainnet-beta.solana.com/' && request.method === 'getGenesisHash')
    return { statusCode: 403, data: 'synthetic provider denial' };
  if (wire.rpcForbiddenPocket && endpoint === 'https://solana.api.pocket.network/' && request.method === 'getGenesisHash')
    return { statusCode: 403, data: 'synthetic provider denial' };
  if (wire.rpcRateLimited && request.method === 'getGenesisHash') return { statusCode: 429, data: 'synthetic rate limit' };
  if (request.method === 'getGenesisHash') result = genesis;
  else if (request.method === 'getAccountInfo') result = { context: { slot: 100 }, value: { owner: system, executable: false } };
  else if (request.method === 'getLatestBlockhash') result = { context: { slot: 100 }, value: { blockhash: addr(8), lastValidBlockHeight: 1000 } };
  else if (request.method === 'getFeeForMessage') {
    const message = Message.from(Buffer.from(request.params[0], 'base64'));
    assert.equal(message.header.numRequiredSignatures, 1); assert.equal(message.instructions.length, 1);
    result = { context: { slot: 100 }, value: 5000 };
  } else if (request.method === 'getBalance') result = { context: { slot: 100 }, value: 1000000000 };
  else if (request.method === 'getSignaturesForAddress') {
    result = [...wire.payments.values()].filter(payment => payment.order.reference === request.params[0])
      .map(payment => ({ signature: payment.signature, slot: payment.raw.slot, err: null, blockTime: payment.raw.blockTime, confirmationStatus: 'finalized' }));
  } else if (request.method === 'getSignatureStatuses') {
    const payment = wire.payments.get(request.params[0][0]);
    result = { context: { slot: 200 }, value: [payment ? { slot: payment.raw.slot, confirmations: null, err: null, confirmationStatus: payment.confirmationStatus ?? 'finalized' } : null] };
  } else if (request.method === 'getTransaction') result = wire.payments.get(request.params[0])?.raw ?? null;
  else throw Error(`Unexpected synthetic RPC method: ${request.method}`);
  return { statusCode: 200, data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) };
};
for (const [host, path] of [['https://api.mainnet-beta.solana.com', '/'], ['https://solana.api.pocket.network', '/'],
  ['https://paid-rpc.example', '/v1/test-access']]) {
  fetchMock.get(host).intercept({ path, method: 'POST' }).reply(options => rpcReply(options, host + path)).persist();
}

for (const host of ['https://arweave.net', 'https://g8way.io']) {
  const pool = fetchMock.get(host);
  for (const [path, value] of [['/info', JSON.stringify({ network: 'arweave.N.1' })],
    ['/tx_anchor', Buffer.alloc(48, 7).toString('base64url')], [`/wallet/${treasury}/balance`, '68000000000000']]) {
    pool.intercept({ path, method: 'GET' }).reply(() => { observe(host + path, 'GET');
      return wire.storageUnavailable ? { statusCode: 503, data: 'synthetic storage outage' } : { statusCode: 200, data: value }; }).persist();
  }
  pool.intercept({ path: /^\/price\/\d+$/, method: 'GET' }).reply(options => { observe(host + options.path, 'GET'); return { statusCode: 200, data: reward }; }).persist();
  pool.intercept({ path: /^\/tx\/[A-Za-z0-9_-]{43}\/status$/, method: 'GET' }).reply(options => {
    observe(host + options.path, 'GET'); const stored = wire.submissions.get(options.path.split('/')[2]);
    return stored?.complete ? { statusCode: 200, data: JSON.stringify({ number_of_confirmations: 8 }) } : { statusCode: stored ? 202 : 404, data: '' };
  }).persist();
  pool.intercept({ path: /^\/tx\/[A-Za-z0-9_-]{43}$/, method: 'GET' }).reply(options => {
    observe(host + options.path, 'GET'); const stored = wire.submissions.get(options.path.split('/')[2]);
    return stored ? { statusCode: 200, data: JSON.stringify({ ...stored.raw, data: '' }) } : { statusCode: 404, data: '' };
  }).persist();
  pool.intercept({ path: /^\/tx\/[A-Za-z0-9_-]{43}\/data$/, method: 'GET' }).reply(options => {
    observe(host + options.path, 'GET'); const stored = wire.submissions.get(options.path.split('/')[2]);
    return stored?.complete ? { statusCode: 200, data: Buffer.from(stored.serialized).toString('base64url') } : { statusCode: 404, data: '' };
  }).persist();
  pool.intercept({ path: /^\/(raw\/)?[A-Za-z0-9_-]{43}$/, method: 'GET' }).reply(options => { observe(host + options.path, 'GET'); return { statusCode: 404, data: '' }; }).persist();
}
fetchMock.get('https://arweave.net').intercept({ path: '/tx', method: 'POST' }).reply(options => {
  observe('https://arweave.net/tx', 'POST'); const raw = parsedBody(options);
  const tags = Object.fromEntries(raw.tags.map(tag => [Buffer.from(tag.name, 'base64url').toString(), Buffer.from(tag.value, 'base64url').toString()]));
  assert.equal(tags['Promo-Funded'], undefined); assert.equal(tags['App-Name'], 'SEJIRE'); assert.equal(tags['Protocol-Version'], 'sejire/v0.3');
  const serialized = wire.archives.get(tags['Preservation-Id']); assert.equal(typeof serialized, 'string');
  assert.equal(tags['Archive-SHA256'], sha(serialized)); assert.equal(tags['Archive-Bytes'], String(Buffer.byteLength(serialized)));
  const old = wire.submissions.get(raw.id);
  if (old) { assert.deepEqual(raw, old.raw); old.posts++; }
  else wire.submissions.set(raw.id, { raw, serialized, posts: 1, chunks: new Map(), complete: Boolean(raw.data) });
  if (raw.data) {
    assert.equal(Buffer.from(raw.data, 'base64url').toString(), serialized);
    if (wire.lostSingleAck) { wire.lostSingleAck = false; return { statusCode: 503, data: 'synthetic lost acknowledgement' }; }
  }
  return { statusCode: 200, data: 'OK' };
}).persist();
fetchMock.get('https://arweave.net').intercept({ path: '/chunk', method: 'POST' }).reply(options => {
  observe('https://arweave.net/chunk', 'POST'); wire.chunkPosts++;
  const chunk = parsedBody(options), stored = [...wire.submissions.values()].find(item => item.raw.data_root === chunk.data_root);
  assert(stored); assert.equal(chunk.data_size, String(Buffer.byteLength(stored.serialized)));
  const bytes = Buffer.from(chunk.chunk, 'base64url'), end = Number(chunk.offset) + 1;
  assert.deepEqual(bytes, Buffer.from(stored.serialized).subarray(end - bytes.length, end));
  if (wire.failChunkOnce) { wire.failChunkOnce = false; wire.droppedChunks++; return { statusCode: 503, data: 'synthetic interrupted chunk' }; }
  stored.chunks.set(chunk.offset, bytes.length);
  stored.complete = [...stored.chunks.values()].reduce((total, size) => total + size, 0) === Buffer.byteLength(stored.serialized);
  return { statusCode: 200, data: 'OK' };
}).persist();

let runtime, stub, passed = 0;
const test = async (name, run) => { await run(); passed++; console.log(`PASS paid API workerd: ${name}`); };
const scriptPath = resolve(temp, 'worker.mjs');
const start = async (enabled, execute, secret = true, options = {}) => {
  await runtime?.dispose();
  runtime = new Miniflare({ modules: true, scriptPath, modulesRoot: temp, compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { CHECKOUT_LEDGER: { className: 'CheckoutLedger', useSQLite: true } }, durableObjectsPersist: resolve(temp, options.db ?? 'db'),
    outboundService: async request => mockedFetch(request.url, { method: request.method, headers: request.headers, signal: request.signal,
      ...(request.body ? { body: new Uint8Array(await request.arrayBuffer()) } : {}), dispatcher: fetchMock, redirect: 'manual' }),
    bindings: { CHECKOUT_API_ENABLED: 'false', CHECKOUT_PAID_ENABLED: String(enabled), CHECKOUT_PAID_EXECUTION_ENABLED: String(execute),
      CHECKOUT_ALLOWED_ORIGINS: origin, CHECKOUT_PAID_NETWORK: 'mainnet-beta', CHECKOUT_PAID_POLICY_VERSION: 'synthetic-paid-api-v1',
      CHECKOUT_SERVICE_RECIPIENT: addr(2), CHECKOUT_FUND_RECIPIENT: addr(3),
      ...(options.storage === false ? {} : {CHECKOUT_PAID_TREASURY_ADDRESS: treasury,
        CHECKOUT_PAID_AR_BUDGET_ID: 'synthetic-paid', CHECKOUT_PAID_AR_BUDGET_WINSTON: '400000000000',
        CHECKOUT_PAID_MAX_REWARD_WINSTON: hold, MAX_ENVELOPE_BYTES: '524288'}),
      ...(options.contribution === undefined ? {} : {CHECKOUT_CONTRIBUTION_ENABLED: String(options.contribution)}),
      ...(secret ? { ARWEAVE_TREASURY_JWK: JSON.stringify(arKey) } : {}), ...options.bindings } });
  await runtime.ready;
  const namespace = await runtime.getDurableObjectNamespace('CHECKOUT_LEDGER');
  stub = namespace.get(namespace.idFromName('sejire-checkout-ledger-v1'));
};
const call = async (path, token, payload, headers = {}, method = payload === undefined ? 'GET' : 'POST') => {
  const response = await runtime.dispatchFetch(`https://paid-api.example/api/checkout${path}`, { method,
    headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.60',
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(payload === undefined ? {} : { body: typeof payload === 'string' ? payload : JSON.stringify(payload) }) });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};
const internal = async payload => {
  const response = await stub.fetch('https://fixture-ledger.internal/', { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(response.status, 200); return response.json();
};
const inspect = id => internal({ action: '__testInspectPaid', id });
const arm = id => internal({ action: '__testArmPaidNow', id });
const waitFor = async (id, predicate, label) => {
  const deadline = Date.now() + 25000;
  for (;;) {
    const state = await inspect(id); if (predicate(state)) return state;
    if (Date.now() >= deadline) throw Error(`Timed out: ${label}; state=${state.paid?.status}; reason=${state.paid?.last_error}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
};
function archive(fill, size = 32, parentTxId = null) {
  const serialized = JSON.stringify({ schema: 'sejire/envelope/v1', vault_id: fill.repeat(32), cipher: 'aes-gcm-256',
    kdf: 'hkdf-sha256', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'A'.repeat(size), protocol: 'sejire/v0.3' });
  return { serialized, archive: { digest: sha(serialized), bytes: Buffer.byteLength(serialized), vaultId: fill.repeat(32), parentTxId } };
}
function signPayment(order, preparation) {
  const bytes = Buffer.from(preparation.messageBase64, 'base64'), message = Message.from(bytes);
  const signature = b58(sign(null, bytes, payerKey.privateKey));
  const keys = message.accountKeys.map(key => key.toBase58());
  return { order, signature, raw: { slot: 100, blockTime: Math.ceil(preparation.createdAt / 1000) + 1, version: 'legacy',
    transaction: { signatures: [signature], message: { header: message.header, accountKeys: keys,
      recentBlockhash: message.recentBlockhash, instructions: message.instructions } },
    meta: { err: null, fee: 5000, innerInstructions: [], preBalances: keys.map(() => 1000000000), postBalances: keys.map(() => 1000000000) } } };
}
try {
  await buildWorker(resolve(here, 'paid-api-worker.ts'), scriptPath);
  await start(false, false, false);
  await test('default off exposes no payment offer or session and makes no outbound request', async () => {
    assert.deepEqual(await call('/policy'), { status: 200, body: { ready: false, reason: 'paid_disabled',
      contributionReady: false, contributionReason: 'contribution_disabled' } });
    assert.deepEqual(await call('/policy/contribution'), {status:200,body:{ready:false,contributionReady:false,contributionReason:'contribution_disabled'}});
    assert.equal((await call('/session', null, {})).status, 404); assert.equal((await call('/orders', null, {})).status, 404);
    assert.equal(wire.calls.length, 0);
  });
  await start(true, true);
  let publicPolicy, a, b, expiredUnadmitted, first, prepared, payment, second, secondPrep;
  const tiny = archive('c'), large = archive('d', 360000, Buffer.alloc(32, 9).toString('base64url'));
  const cancelledKey = 'dropped_create_key_01', expiredKey = 'expired_no_order_key_01';
  const cancellation = key => ({ schema: 'sejire/paid-request-cancellation/v1', status: 'cancelled', key });
  const noAdmitted = async cancelled => assert.deepEqual(await internal({ action: '__testPaidCounts' }), {
    orders: 0, api_orders: 0, paid_orders: 0, paid_payloads: 0, paid_holds: 0, credits: 0, paid_cancelled_keys: cancelled,
  });
  const create = (token, key, input = tiny) => call('/orders', token, { kind: 'preservation', payer, contribution: '0', policyHash: publicPolicy.policyHash, ...input }, { 'Idempotency-Key': key });
  await test('actual readiness pins SOL mainnet, separate AR network, configured roles and 0.03 SOL', async () => {
    const result = await call('/policy'); assert.equal(result.status, 200); assert.equal(result.body.ready, true); publicPolicy = result.body;
    assert.equal(publicPolicy.policy.serviceLamports, '30000000'); assert.equal(publicPolicy.policy.network, 'mainnet-beta');
    assert.equal(publicPolicy.policy.storage.network, 'arweave.N.1');
    assert.equal(publicPolicy.contributionReady,false);assert.equal(publicPolicy.contributionPolicy,undefined);
    a = (await call('/session', null, {})).body.accessToken; b = (await call('/session', null, {})).body.accessToken;
    assert.match(a, /^[a-f0-9]{64}$/); assert.notEqual(a, b);
    expiredUnadmitted = (await call('/session', null, {})).body.accessToken;
    await internal({ action: '__testExpireSession', hash: sha(expiredUnadmitted) });
    const before=wire.calls.length;
    assert.deepEqual(await call('/orders',a,{kind:'contribution',payer,contribution:'0.005',policyHash:publicPolicy.policyHash},
      {'Idempotency-Key':'default_off_help_01'}),{status:503,body:{error:'contribution_not_ready'}});
    assert.equal(wire.calls.length,before);
  });
  await start(false, false, false);
  await test('cancel before any admission works while paused with known or expired owner and never creates a hold', async () => {
    const before = wire.calls.length;
    await noAdmitted(0);
    const path = `/orders/by-key/${cancelledKey}/cancel`;
    assert.equal((await call(path, null, {})).status, 401);
    assert.equal((await call(path, 'f'.repeat(64), {})).status, 401);
    assert.equal((await call(path, a, { orderId: 'a'.repeat(32) })).status, 400);
    assert.equal((await call(path, a, {}, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await call(path, a)).status, 405);
    assert.deepEqual(await call(path, a, {}), { status: 200, body: cancellation(cancelledKey) });
    assert.deepEqual(await call(path, a, {}), { status: 200, body: cancellation(cancelledKey) });
    assert.deepEqual(await call(`/orders/by-key/${cancelledKey}`, a), { status: 200, body: cancellation(cancelledKey) });
    assert.equal((await call(`/orders/by-key/${cancelledKey}`, b)).status, 404);
    assert.deepEqual(await call(`/orders/by-key/${expiredKey}/cancel`, expiredUnadmitted, {}), { status: 200, body: cancellation(expiredKey) });
    assert.deepEqual(await call(`/orders/by-key/${expiredKey}`, expiredUnadmitted), { status: 200, body: cancellation(expiredKey) });
    assert.equal((await call('/orders/by-key/unknown_expired_key_00', expiredUnadmitted)).status, 401);
    await noAdmitted(2); assert.equal(wire.calls.length, before);
  });
  await start(false, false, false);
  await test('pre-admission tombstone survives a lost reply and fresh paused isolate without a paid order', async () => {
    const before = wire.calls.length;
    assert.deepEqual(await call(`/orders/by-key/${cancelledKey}`, a), { status: 200, body: cancellation(cancelledKey) });
    assert.deepEqual(await call(`/orders/by-key/${expiredKey}`, expiredUnadmitted), { status: 200, body: cancellation(expiredKey) });
    assert.deepEqual(await call(`/orders/by-key/${cancelledKey}/cancel`, a, {}), { status: 200, body: cancellation(cancelledKey) });
    assert.equal((await call(`/orders/by-key/${cancelledKey}`, null)).status, 401);
    await noAdmitted(2); assert.equal(wire.calls.length, before);
  });
  await start(true, true);
  await test('every late create with a cancelled key is rejected before readiness or AR reservation', async () => {
    const before = wire.calls.length;
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(await create(a, cancelledKey), { status: 409, body: { error: 'paid_request_cancelled' } });
    }
    assert.equal((await create(expiredUnadmitted, 'expired_cannot_admit_00')).status, 401);
    await noAdmitted(2); assert.equal(wire.calls.length, before);
  });
  await test('malformed modern input and oversized bodies fail before payment or storage admission', async () => {
    const input = { kind: 'preservation', payer, contribution: '0', policyHash: publicPolicy.policyHash, ...tiny };
    for (const patch of [{ paid: true }, { network: 'devnet' }, { archive: { ...tiny.archive, digest: 'wrong' } },
      { archive: { ...tiny.archive, parentTxId: 'bad' } }, { serialized: tiny.serialized + ' ' }]) {
      const result = await call('/orders', a, { ...input, ...patch }, { 'Idempotency-Key': 'invalid_paid_body_01' }); assert.equal(result.status, 400);
    }
    assert.equal((await call('/orders', a, ' '.repeat(524288 * 2 + 4097), { 'Idempotency-Key': 'large_paid_body_01' })).status, 413);
  });
  await test('a rejected create reports the mainnet RPC cause while the same key remains unadmitted', async () => {
    const key = 'paid_rpc_failure_01'; wire.rpcRateLimited = true;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.deepEqual(await create(a, key), { status: 503, body: { error: 'rpc-rate-limited' } });
        assert.deepEqual(await call(`/orders/by-key/${key}`, a), { status: 404, body: { error: 'order_not_found' } });
      }
      await noAdmitted(2);
    } finally { wire.rpcRateLimited = false; }
  });
  await test('provider HTTP 403 leaves the same attempt unadmitted; server-only RPC access admits it once', async () => {
    const db = 'rpc-retry-db', key = 'paid_rpc_denied_retry_01';
    await start(true, true, true, { db });
    const token = (await call('/session', null, {})).body.accessToken;
    wire.rpcForbiddenDefault = true; wire.rpcForbiddenPocket = true;
    assert.deepEqual(await create(token, key), { status: 503, body: { error: 'rpc-unavailable' } });
    assert.deepEqual(await call(`/orders/by-key/${key}`, token), { status: 404, body: { error: 'order_not_found' } });
    await start(true, true, true, { db, bindings: { CHECKOUT_SOLANA_RPC_URL: 'https://paid-rpc.example/v1/test-access' } });
    const first = await create(token, key);
    assert.equal(first.status, 201);
    assert.deepEqual(first.body.record.order.archive, tiny.archive);
    const second = await create(token, key);
    assert.equal(second.status, 200);
    assert.equal(second.body.record.order.id, first.body.record.order.id);
    assert.equal((await call(`/orders/by-key/${key}`, token)).body.record.order.id, first.body.record.order.id);
    assert.equal((await internal({ action: '__testPaidCounts' })).paid_orders, 1);
    wire.rpcForbiddenDefault = false; wire.rpcForbiddenPocket = false;
    await start(true, true);
  });
  await test('one denied RPC falls through to another complete Mainnet preparation without another order', async () => {
    await start(true, true, true, { db: 'rpc-fallback-db', bindings: { CHECKOUT_SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com' } });
    const token = (await call('/session', null, {})).body.accessToken;
    wire.rpcForbiddenDefault = true;
    const before = wire.calls.length;
    const made = await create(token, 'paid_rpc_fallback_01');
    assert.equal(made.status, 201);
    const rpcCalls = wire.calls.slice(before).filter(item => item.method === 'POST');
    assert.equal(rpcCalls[0].url, 'https://api.mainnet-beta.solana.com/');
    assert(rpcCalls.some(item => item.url === 'https://solana.api.pocket.network/'));
    assert.equal((await create(token, 'paid_rpc_fallback_01')).body.record.order.id, made.body.record.order.id);
    assert.equal((await internal({ action: '__testPaidCounts' })).paid_orders, 1);
    wire.rpcForbiddenDefault = false;
    await start(true, true);
  });
  await test('v2 admission persists exact ciphertext/parent/policy and one idempotent order', async () => {
    const made = await create(a, 'paid_first_order_01'); assert.equal(made.status, 201); first = made.body.record.order;
    wire.archives.set(first.id, tiny.serialized);
    assert.equal(first.schema, 'sejire/order/v2'); assert.deepEqual(first.archive, tiny.archive);
    assert.equal(first.servicePayment.amount, '30000000'); assert.equal(first.fundContribution.amount, '0');
    const before = wire.calls.length, reused = await create(a, 'paid_first_order_01');
    assert.equal(reused.status, 200); assert.equal(reused.body.record.order.id, first.id); assert.equal(wire.calls.length, before);
    assert.equal((await create(a, 'paid_first_order_01', { ...tiny, archive: { ...tiny.archive, parentTxId: large.archive.parentTxId } })).status, 409);
    assert.equal((await call('/orders/by-key/paid_first_order_01', a)).body.record.order.id, first.id);
    assert.equal((await call('/orders/by-key/paid_first_order_01', b)).status, 404);
  });
  await test('ownership/origin/auth guard every resume and mutation before network evidence', async () => {
    const before = wire.calls.length;
    assert.equal((await call(`/orders/${first.id}`, b)).status, 404);
    assert.equal((await call(`/orders/${first.id}`, null)).status, 401);
    for (const action of ['prepare', 'reserve', 'verify', 'reconcile', 'execute', 'cancel']) assert.equal((await call(`/orders/${first.id}/${action}`, b, {})).status, 404);
    assert.equal((await call(`/orders/${first.id}`, a, undefined, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal(wire.calls.length, before); assert.equal((await inspect(first.id)).row.pending_signature, null);
    assert.equal((await call(`/orders/${first.id}/execute`, a, {})).status, 409);
  });
  await test('preparation is durable and reused; invalid signature or different saved message cannot reserve', async () => {
    const result = await call(`/orders/${first.id}/prepare`, a, {}); assert.equal(result.status, 200); prepared = result.body;
    assert.equal(prepared.orderId, first.id); assert.equal(prepared.preparationId, prepared.messageSha256);
    const before = wire.calls.length, again = await call(`/orders/${first.id}/prepare`, a, {});
    assert.deepEqual(again.body, prepared); assert.equal(wire.calls.length, before);
    const invalid = await call(`/orders/${first.id}/reserve`, a, { signature: b58(Buffer.alloc(64, 5)), preparationId: prepared.preparationId });
    assert.equal(invalid.status, 400);
    const modified = Message.from(Buffer.from(prepared.messageBase64, 'base64')); modified.recentBlockhash = addr(9);
    const otherSignature = b58(sign(null, modified.serialize(), payerKey.privateKey));
    assert.equal((await call(`/orders/${first.id}/reserve`, a, { signature: otherSignature, preparationId: prepared.preparationId })).status, 400);
    assert.equal((await inspect(first.id)).row.pending_signature, null);
    payment = signPayment(first, prepared); wire.payments.set(payment.signature, payment);
  });
  await test('cancel-by-key returns an admitted preparation unchanged and foreign same-key cancellation is isolated', async () => {
    const before = wire.calls.length, snapshot = (await call(`/orders/${first.id}`, a)).body;
    assert.deepEqual(await call('/orders/by-key/paid_first_order_01/cancel', a, {}), { status: 200, body: snapshot });
    assert.deepEqual(snapshot.preparation, prepared); assert.equal(snapshot.cancelled, false);
    assert.deepEqual(await call('/orders/by-key/paid_first_order_01/cancel', b, {}), { status: 200, body: cancellation('paid_first_order_01') });
    assert.deepEqual(await call('/orders/by-key/paid_first_order_01', b), { status: 200, body: cancellation('paid_first_order_01') });
    assert.equal((await call(`/orders/${first.id}`, b)).status, 404);
    assert.deepEqual((await call(`/orders/${first.id}`, a)).body, snapshot);
    assert.equal((await inspect(first.id)).hold.released, 0); assert.equal(wire.calls.length, before);
  });
  await start(false, false, false);
  await test('admission/execution pause still recovers unknown wallet result from old reference without signing AR', async () => {
    const read = await call(`/orders/${first.id}`, a); assert.equal(read.status, 200); assert.deepEqual(read.body.preparation, prepared);
    assert.equal((await call(`/orders/${first.id}/reconcile`, a, {})).status, 202);
    const state = await waitFor(first.id, value => Boolean(value.row.payment_json) && value.paid.lease_until === 0, 'reference recovery while paused');
    assert.equal(JSON.parse(state.row.payment_json).signature, payment.signature); assert.equal(state.credits.length, 1);
    assert.deepEqual(state.credits.map(row => [row.purpose, row.amount]), [['servicePayment', '30000000']]);
    assert.equal(state.payloadKinds.some(row => row.kind === 'signed'), false); assert.equal(wire.submissions.size, 0);
    assert.equal(state.hold.reward, hold); assert.equal(state.hold.actual, null);
  });
  await internal({ action: '__testExpireSession', hash: sha(a) });
  await start(false, true);
  await test('alarm fulfils paid obligation after restart/session expiry; lost AR acknowledgement preserves one TX', async () => {
    const owned = await call(`/orders/${first.id}`, a);
    assert.equal(owned.status, 200); assert.equal(owned.body.record.order.id, first.id);
    assert.equal((await call('/orders/by-key/paid_first_order_01', a)).body.record.order.id, first.id);
    assert([401, 404].includes((await call(`/orders/${'f'.repeat(32)}`, a)).status));
    assert([401, 404].includes((await call('/orders/by-key/unknown_expired_key_01', a)).status));
    assert.equal((await call(`/orders/${first.id}`, null)).status, 401);
    assert.equal((await call(`/orders/${first.id}`, b)).status, 404);
    await arm(first.id);
    const done = await waitFor(first.id, value => value.paid.status === 'completed', 'alarm completion after session expiry');
    const receipt = JSON.parse(done.paid.receipt_json);
    assert.equal(receipt.paymentSignature, payment.signature); assert.deepEqual(receipt.archive, tiny.archive);
    assert.equal(receipt.paymentNetwork, 'mainnet-beta'); assert.equal(receipt.arweaveNetwork, 'arweave.N.1');
    assert.equal(done.hold.actual, reward); assert.equal(done.credits.length, 1);
    assert.equal(wire.submissions.size, 1); assert.equal(wire.submissions.get(receipt.txId).posts, 1);
    const recovered = await call(`/orders/${first.id}`, a);
    assert.equal(recovered.status, 200); assert.deepEqual(recovered.body.execution.receipt, receipt);
  });
  await start(true, true);
  await test('valid public Ed25519 signature reserves exact preparation once and rejects replacement', async () => {
    assert.equal((await create(a, 'expired_cannot_create_01')).status, 401);
    const stranger = (await call('/session', null, {})).body.accessToken;
    assert.equal((await call(`/orders/${first.id}`, stranger)).status, 404);
    assert.equal((await call('/orders/by-key/paid_first_order_01', stranger)).status, 404);
    const made = await create(b, 'paid_large_order_02', large); assert.equal(made.status, 201); second = made.body.record.order;
    wire.archives.set(second.id, large.serialized);
    const ready = await call(`/orders/${second.id}/prepare`, b, {}); assert.equal(ready.status, 200); secondPrep = ready.body;
    const paid = signPayment(second, secondPrep); wire.payments.set(paid.signature, paid);
    const reserved = await call(`/orders/${second.id}/reserve`, b, { signature: paid.signature, preparationId: secondPrep.preparationId }); assert.equal(reserved.status, 202);
    assert.equal(reserved.body.record.pendingSignature, paid.signature);
    const repeat = await call(`/orders/${second.id}/reserve`, b, { signature: paid.signature, preparationId: secondPrep.preparationId }); assert.equal(repeat.status, 202);
    const changed = await call(`/orders/${second.id}/reserve`, b, { signature: paid.signature, preparationId: 'e'.repeat(64) }); assert.equal(changed.status, 409);
  });
  await test('accepted header with interrupted chunk resumes exact signed TX and completes without a second SOL payment', async () => {
    await arm(second.id);
    await waitFor(second.id, state => wire.droppedChunks === 1 && state.paid.lease_until === 0, 'partial chunk upload');
    const initial = [...wire.submissions.values()].find(row => row.serialized === large.serialized); assert(initial); const id = initial.raw.id;
    await arm(second.id);
    const done = await waitFor(second.id, state => state.paid.status === 'completed', 'resumed chunk upload');
    assert.equal(JSON.parse(done.paid.receipt_json).txId, id); assert.equal(done.credits.length, 1); assert.equal(done.hold.actual, reward);
    assert.equal(wire.submissions.size, 2); assert.equal(wire.submissions.get(id).posts, 2);
    assert(wire.chunkPosts >= 4); assert.deepEqual(JSON.parse(done.paid.receipt_json).archive, large.archive);
  });
  await start(false, false, false);
  await test('fresh secretless paused isolate retains completed receipt and GET never broadcasts', async () => {
    const before = wire.calls.length, result = await call(`/orders/${second.id}`, b);
    assert.equal(result.status, 200); assert.equal(result.body.execution.status, 'completed');
    assert.equal(result.body.execution.receipt.paymentSignature, result.body.record.payment.signature);
    assert.equal(wire.calls.length, before); assert.equal((await inspect(second.id)).credits.length, 1);
    for (const path of ['/commit', '/paidRun', '/__testInspectPaid', '/__testPaidCounts']) assert.equal((await call(path, b, {})).status, 404);
  });
  const contributionOptions={db:'contributions',contribution:true,storage:false};
  wire.storageUnavailable=true;
  await start(true,true,true,{...contributionOptions,storage:true});
  await test('help-only policy never invokes storage with both gates enabled and an Arweave outage',async()=>{
    const before=wire.calls.length,result=await call('/policy/contribution');
    assert.equal(result.status,200);assert.equal(result.body.contributionReady,true);assert.equal(result.body.policy,undefined);
    assert.equal(result.body.contributionPolicy.serviceLamports,'0');assert.equal(wire.calls.length,before);
  });
  await start(false,false,false,contributionOptions);
  let helpPolicy,helper,helpOrder,helpPreparation,helpPayment;
  const helpCreate=(payload={},key='standalone_help_key_01')=>call('/orders',helper,{kind:'contribution',payer,contribution:'0.005',
    policyHash:helpPolicy.contributionPolicyHash,...payload},{'Idempotency-Key':key});
  const onlySolSince=index=>assert(wire.calls.slice(index).every(row=>row.url==='https://api.mainnet-beta.solana.com/'));
  await test('standalone readiness has its own explicit gate and works without AR settings, signer or preservation admission',async()=>{
    const before=wire.calls.length,result=await call('/policy/contribution');assert.equal(result.status,200);helpPolicy=result.body;
    assert.equal(helpPolicy.ready,false);assert.equal(helpPolicy.contributionReady,true);assert.equal(helpPolicy.policy,undefined);
    assert.equal(helpPolicy.contributionPolicy.schema,'sejire/contribution-policy/v1');
    assert.equal(helpPolicy.contributionPolicy.serviceLamports,'0');assert(!('storage' in helpPolicy.contributionPolicy));
    assert.match(helpPolicy.contributionPolicyHash,/^[a-f0-9]{64}$/);assert.equal(wire.calls.length,before);
    const issued=await call('/session',null,{});assert.equal(issued.status,201);helper=issued.body.accessToken;
    for(const payload of [{contribution:'0'},{archive:tiny.archive},{serialized:tiny.serialized},{servicePayment:{amount:'1'}},{contribution:'18446744073.709551616'}])
      assert.equal((await helpCreate(payload,'invalid_help_body_01')).status,400);
    assert.equal((await helpCreate({policyHash:publicPolicy.policyHash},'wrong_help_policy_01')).status,409);
    assert.equal((await call('/orders',helper,{kind:'preservation',payer,contribution:'0',policyHash:publicPolicy.policyHash,...tiny},
      {'Idempotency-Key':'preservation_stays_off_01'})).status,503);
    assert.equal(wire.calls.length,before);await noAdmitted(0);
  });
  await test('standalone admission saves only immutable SOL terms; idempotent reuse adds no AR hold, payload or upload job',async()=>{
    const before=wire.calls.length,made=await helpCreate();assert.equal(made.status,201);helpOrder=made.body.record.order;
    assert.equal(helpOrder.servicePayment.amount,'0');assert.equal(helpOrder.fundContribution.amount,'5000000');
    assert(!('archive' in helpOrder));assert(!('storage' in helpOrder));assert.equal(made.body.execution,null);
    assert.equal(made.body.record.states.preservation,'not-applicable');onlySolSince(before);
    const calls=wire.calls.length,reused=await helpCreate();assert.equal(reused.status,200);
    assert.deepEqual(reused.body.record.order,helpOrder);assert.equal(wire.calls.length,calls);
    const state=await inspect(helpOrder.id);assert.equal(state.hold,undefined);assert.deepEqual(state.payloadKinds,[]);
    assert.deepEqual(state.legacyExecution,[]);assert.deepEqual(state.credits,[]);
    const prepared=await call(`/orders/${helpOrder.id}/prepare`,helper,{});assert.equal(prepared.status,200);helpPreparation=prepared.body;
    helpPayment=signPayment(helpOrder,helpPreparation);helpPayment.confirmationStatus='confirmed';
    wire.payments.set(helpPayment.signature,helpPayment);onlySolSince(before);
  });
  await test('standalone reserve verifies exact signature; nonfinalized payment remains unresolved with no credit or AR side effect',async()=>{
    const before=wire.calls.length;
    assert.equal((await call(`/orders/${helpOrder.id}/reserve`,helper,{signature:b58(Buffer.alloc(64,5)),preparationId:helpPreparation.preparationId})).status,400);
    assert.equal((await call(`/orders/${helpOrder.id}/reserve`,helper,{signature:helpPayment.signature,preparationId:helpPreparation.preparationId})).status,202);
    assert.equal((await call(`/orders/${helpOrder.id}/verify`,helper,{signature:helpPayment.signature})).status,202);
    const state=await waitFor(helpOrder.id,value=>Boolean(value.paid.last_error)&&value.paid.lease_until===0,'standalone waits for finality');
    assert.equal(state.row.payment_json,null);assert.deepEqual(state.credits,[]);assert.equal(state.hold,undefined);
    assert.deepEqual(state.payloadKinds,[]);assert.deepEqual(state.legacyExecution,[]);onlySolSince(before);
  });
  helpPayment.confirmationStatus='finalized';
  await start(false,false,false,{...contributionOptions,contribution:false});
  await test('disabled standalone admission still reconciles the original finalized payment after restart exactly once',async()=>{
    const before=wire.calls.length;
    assert.equal((await call('/policy')).body.contributionReady,false);assert.equal((await call('/session',null,{})).status,404);
    const saved=await call(`/orders/${helpOrder.id}`,helper);assert.equal(saved.status,200);assert.deepEqual(saved.body.preparation,helpPreparation);
    await call(`/orders/${helpOrder.id}/reconcile`,helper,{});
    const done=await waitFor(helpOrder.id,value=>value.paid.status==='completed','standalone finalized credit');
    assert.deepEqual(done.credits.map(row=>[row.purpose,row.amount,row.signature]),[['fundContribution','5000000',helpPayment.signature]]);
    const read=(await call(`/orders/${helpOrder.id}`,helper)).body;
    assert.deepEqual(read.record.states,{payment:'verified',preservation:'not-applicable',contribution:'received'});
    assert.equal(read.execution,null);assert.equal(done.hold,undefined);assert.deepEqual(done.payloadKinds,[]);assert.deepEqual(done.legacyExecution,[]);
    onlySolSince(before);
    const calls=wire.calls.length;
    for(let repeat=0;repeat<2;repeat++)assert.equal((await call(`/orders/${helpOrder.id}/reconcile`,helper,{})).status,200);
    assert.equal((await inspect(helpOrder.id)).credits.length,1);assert.equal(wire.calls.length,calls);
    assert.equal((await call('/orders/by-key/standalone_help_key_01',helper)).body.record.order.id,helpOrder.id);
  });
  assert(wire.calls.every(call => ['https://arweave.net', 'https://g8way.io', 'https://api.mainnet-beta.solana.com',
    'https://solana.api.pocket.network',
    'https://paid-rpc.example'].includes(new URL(call.url).origin)));
  console.log(`paid-api.runtime: PASS (${passed} scenarios); actual API/DO/SQLite/global fetch/alarm, fresh workerd isolates, unmatched outbound denied, no real payments or deployment`);
} finally {
  await runtime?.dispose(); await fetchMock.close(); await rm(temp, { recursive: true, force: true });
}
