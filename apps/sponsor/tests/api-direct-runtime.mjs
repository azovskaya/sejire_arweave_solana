// CI-only wire fixtures. The Worker still uses the production application's
// default RPC reader, payment preparer and TestnetPreservationService.fetch.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import bs58 from 'bs58';

// Public RFC8032 test vector, identical to api-worker.ts. Never a funded key.
const vector = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex');
export const directCheckoutBindings = {
  CHECKOUT_UPLOAD_ENABLED: 'true', CHECKOUT_UPLOAD_SIGNER: bs58.encode(vector),
};
const destination = 'https://redirect.invalid/blocked';
const digest = value => createHash('sha256').update(value).digest('hex');
const serialized = JSON.stringify({ schema: 'sejire/envelope/v1', vault_id: 'd'.repeat(32), cipher: 'aes-gcm-256',
  kdf: 'hkdf-sha256', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'A'.repeat(32), protocol: 'sejire/v0.3' });
const intent = fixtures => ({ kind: 'preservation', contribution: '0', payer: fixtures.addr(1),
  archive: { digest: digest(serialized), bytes: Buffer.byteLength(serialized) } });
const response = (statusCode, data) => ({ statusCode, data: typeof data === 'string' ? data : JSON.stringify(data),
  responseOptions: { headers: { 'Content-Type': 'application/json', ...(statusCode === 302 ? { Location: destination } : {}) } } });

export function installDirectCheckoutMocks(mock, fixtures) {
  const wire = { fixtures, freeStatus: 200, rpcStatus: 200, uploadStatus: 200, retrieveStatus: 200,
    serialized, archiveId: null, rawItems: [], payments: new Map(),
    counts: { free: 0, rpc: {}, upload: 0, retrieve: 0, redirected: 0 } };
  mock.get('https://api.devnet.solana.com').intercept({ method: 'POST', path: '/' }).reply(options => {
    const request = JSON.parse(Buffer.from(options.body).toString('utf8'));
    wire.counts.rpc[request.method] = (wire.counts.rpc[request.method] ?? 0) + 1;
    let result;
    if (request.method === 'getGenesisHash') result = fixtures.fixtureChain.genesisHash;
    else if (request.method === 'getAccountInfo') result = { context: { slot: 100 }, value: {
      owner: '11111111111111111111111111111111', executable: false } };
    else if (request.method === 'getLatestBlockhash') result = { context: { slot: 100 }, value: { blockhash: fixtures.addr(8), lastValidBlockHeight: 1000 } };
    else if (request.method === 'getBalance') result = { context: { slot: 100 }, value: 1_000_000_000 };
    else if (request.method === 'getSignatureStatuses') result = fixtures.fixtureStatus();
    else if (request.method === 'getTransaction') {
      const signature = request.params[0], order = wire.payments.get(signature);
      assert.ok(order, 'only an explicitly registered synthetic payment can be read');
      result = fixtures.fixtureTransaction(order, signature);
      result.blockTime = Math.ceil(order.createdAt / 1000) + 1;
    } else throw Error(`unexpected_wire_rpc_${request.method}`);
    return response(wire.rpcStatus, { jsonrpc: '2.0', id: request.id, result });
  }).persist();
  mock.get('https://payment.services.ar-io.dev')
    .intercept({ method: 'GET', path: `/v1/account/free?address=${bs58.encode(vector.subarray(32))}` }).reply(() => {
      wire.counts.free++; return response(wire.freeStatus, { bytesRemaining: 1_000_000 });
    }).persist();
  mock.get('https://upload.services.ar-io.dev').intercept({ method: 'POST', path: '/v1/tx' }).reply(options => {
    const raw = Buffer.from(options.body);
    assert.equal(raw.readUInt16LE(0), 4, 'the actual SDK produces a Solana ANS-104 item');
    assert.ok(raw.includes(Buffer.from(wire.serialized)), 'the signed item contains the exact encrypted archive');
    const id = createHash('sha256').update(raw.subarray(2, 66)).digest('base64url');
    wire.counts.upload++; wire.rawItems.push(raw.toString('base64')); wire.archiveId = id;
    return response(wire.uploadStatus, { id, winc: '0', synthetic: true });
  }).persist();
  mock.get('https://ar-io.dev').intercept({ method: 'GET', path: /^\/raw\/[A-Za-z0-9_-]{43}$/ }).reply(options => {
    assert.equal(options.path, `/raw/${wire.archiveId}`, 'retrieval uses the persisted signed item ID');
    wire.counts.retrieve++; return response(wire.retrieveStatus, wire.serialized);
  }).persist();
  // A followed redirect is observable and fails the tests; the destination is
  // also entirely mocked. All other destinations remain disableNetConnect.
  for (const method of ['GET', 'POST']) mock.get('https://redirect.invalid')
    .intercept({ method, path: '/blocked' }).reply(() => {
      wire.counts.redirected++; return response(200, { unexpected: 'redirect-followed' });
    }).persist();
  return wire;
}

export async function runDirectCheckoutPhase({ phase, persist, wire, test, call, session, create, totals }) {
  const statePath = resolve(persist, 'direct-state.json');
  const payload = intent(wire.fixtures), key = 'direct_adapters_order';
  if (phase === 'direct-write') {
    const token = await session(); let order;
    await test('production readiness reaches the real fetch adapter and refuses a free-allowance redirect', async () => {
      wire.freeStatus = 302;
      const blocked = await create(token, key, payload);
      assert.equal(blocked.status, 503); assert.equal(wire.counts.free, 1);
      assert.deepEqual(wire.counts.rpc, {}); assert.deepEqual(await totals(), {});
      assert.equal(wire.counts.redirected, 0); wire.freeStatus = 200;
    });
    await test('default uploader readiness and RPC preparation create the actual production order', async () => {
      // Fixture selectors are ignored by application.fetch; no adapter override is passed.
      const created = await create(token, key, payload, { 'X-Test-Rpc': 'wrong-network', 'X-Test-Upload': 'not-ready', 'X-Test-Accounts': 'missing' });
      assert.equal(created.status, 201, JSON.stringify({ response: created.body, outbound: wire.counts })); order = created.body.record.order;
      assert.equal(order.network, 'devnet'); assert.equal(order.servicePayment.amount, '30000000');
      assert.deepEqual(order.archive, payload.archive); assert.equal(wire.counts.free, 2);
      assert.deepEqual(wire.counts.rpc, { getGenesisHash: 1, getAccountInfo: 1, getLatestBlockhash: 1, getBalance: 1 });
      const prepared = await call(`/orders/${order.id}/prepare`, token, {});
      assert.equal(prepared.status, 200); assert.equal(prepared.body.source, order.payer);
      assert.equal(prepared.body.blockhash, wire.fixtures.addr(8)); assert.equal(wire.counts.free, 3);
    });
    const signature = wire.fixtures.sig(51); wire.payments.set(signature, order);
    await test('a redirected real RPC response cannot credit a reserved payment', async () => {
      const before = structuredClone(wire.counts.rpc);
      assert.equal((await call(`/orders/${order.id}/reserve`, token, { signature })).status, 202);
      assert.deepEqual(wire.counts.rpc, before, 'reserve is journal-only');
      wire.rpcStatus = 302;
      const blocked = await call(`/orders/${order.id}/verify`, token, { signature });
      assert.equal(blocked.status, 202); assert.equal(blocked.body.reason, 'rpc-unavailable');
      assert.equal(blocked.body.record.pendingSignature, signature); assert.equal(blocked.body.record.payment, undefined);
      assert.deepEqual(await totals(), {}); assert.equal(wire.counts.redirected, 0); wire.rpcStatus = 200;
    });
    await test('same signature is finalized by default RPC reader and credited exactly once', async () => {
      const checked = await call(`/orders/${order.id}/verify`, token, { signature });
      assert.equal(checked.status, 200); assert.equal(checked.body.status, 'credited');
      assert.equal(checked.body.record.payment.signature, signature); assert.equal(checked.body.record.states.preservation, 'ready');
      assert.equal(wire.counts.rpc.getTransaction, 1); assert.equal(wire.counts.rpc.getSignatureStatuses, 1);
      const credited = await totals(), reads = structuredClone(wire.counts.rpc);
      assert.deepEqual(Object.values(credited), ['30000000']);
      assert.equal((await call(`/orders/${order.id}/reconcile`, token, {})).body.status, 'already-credited');
      assert.deepEqual(await totals(), credited); assert.deepEqual(wire.counts.rpc, reads);
    });
    await test('real SDK signing is persisted, and an upload redirect cannot complete preservation', async () => {
      wire.uploadStatus = 302;
      const blocked = await call(`/orders/${order.id}/execute`, token, { serialized });
      assert.equal(blocked.status, 202); assert.equal(blocked.body.record.states.preservation, 'requires-reconciliation');
      assert.equal(blocked.body.execution.id, wire.archiveId); assert.equal(blocked.body.execution.accepted, null);
      assert.equal(blocked.body.execution.retrieved, false); assert.equal(wire.counts.upload, 1);
      assert.equal(wire.counts.retrieve, 0); assert.equal(wire.counts.free, 4); assert.equal(wire.counts.redirected, 0);
    });
    await test('retry reuses signed bytes; receipt persists while a raw redirect remains unverified', async () => {
      wire.uploadStatus = 200; wire.retrieveStatus = 302;
      const id = wire.archiveId;
      const accepted = await call(`/orders/${order.id}/execute`, token, { serialized });
      assert.equal(accepted.status, 202); assert.equal(accepted.body.execution.id, id);
      assert.equal(accepted.body.execution.accepted.id, id); assert.equal(accepted.body.execution.accepted.winc, '0');
      assert.equal(accepted.body.execution.retrieved, false); assert.equal(accepted.body.record.states.preservation, 'requires-reconciliation');
      assert.equal(wire.counts.upload, 2); assert.equal(wire.counts.retrieve, 1); assert.equal(wire.counts.free, 4);
      assert.equal(wire.rawItems[0], wire.rawItems[1]); assert.equal(wire.counts.redirected, 0);
    });
    await writeFile(statePath, JSON.stringify({ token, order, id: wire.archiveId, signature, totals: await totals() }));
  } else if (phase === 'direct-restart') {
    const saved = JSON.parse(await readFile(statePath, 'utf8')); wire.archiveId = saved.id;
    await test('fresh workerd process reads the same production order, payment and accepted item', async () => {
      const current = await call(`/orders/${saved.order.id}`, saved.token);
      assert.equal(current.status, 200); assert.deepEqual(current.body.record.order, saved.order);
      assert.equal(current.body.record.payment.signature, saved.signature);
      assert.equal(current.body.execution.id, saved.id); assert.equal(current.body.execution.accepted.id, saved.id);
      assert.equal(current.body.execution.retrieved, false); assert.deepEqual(await totals(), saved.totals);
      const replay = await create(saved.token, key, payload);
      assert.equal(replay.status, 200); assert.equal(replay.body.record.order.id, saved.order.id);
      assert.deepEqual(wire.counts, { free: 0, rpc: {}, upload: 0, retrieve: 0, redirected: 0 });
    });
    await test('accepted item resumes with one exact-hash read and no signing, upload or payment after restart', async () => {
      const completed = await call(`/orders/${saved.order.id}/execute`, saved.token, { serialized });
      assert.equal(completed.status, 200); assert.equal(completed.body.status, 'retrieved-and-verified');
      assert.equal(completed.body.execution.id, saved.id); assert.equal(completed.body.execution.retrieved, true);
      assert.equal(completed.body.record.states.preservation, 'completed');
      assert.deepEqual(wire.counts, { free: 0, rpc: {}, upload: 0, retrieve: 1, redirected: 0 });
      const repeated = await Promise.all(Array.from({ length: 4 }, () => call(`/orders/${saved.order.id}/execute`, saved.token, { serialized })));
      assert.ok(repeated.every(result => result.status === 200 && result.body.execution.id === saved.id));
      assert.deepEqual(wire.counts, { free: 0, rpc: {}, upload: 0, retrieve: 1, redirected: 0 });
      assert.deepEqual(await totals(), saved.totals);
    });
  } else throw Error('unknown_direct_phase');
}
