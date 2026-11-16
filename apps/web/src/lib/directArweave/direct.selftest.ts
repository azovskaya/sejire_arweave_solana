import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import type { JWKInterface } from 'arweave/web/lib/wallet';
import { encryptJson, decryptJson } from '../crypto/encrypt';
import { deriveKeysFromMnemonic } from '../crypto/keys';
import { serializeEnvelope } from '../crypto/envelope';
import { createDirectOperation, readDirectOperation, listDirectOperations, cancelDirectOperation, exportDirectOperation, importDirectOperation } from './journal';
import { quoteDirectOperation, signDirectOperation, resumeDirectOperation, checkDirectOperation } from './client';
import { directReceipt, parseDirectReceipt, retrieveDirectReceipt, retrieveDirectTransaction } from './receipt';
import { directCrypto } from './transaction';
import { directNode, nodeRequest } from './network';
import type { DirectOperation, DirectRawTransaction, DirectWallet } from './types';

let passed = 0;
async function test(name: string, action: () => void | Promise<void>) {
  await action(); passed++; console.log(`PASS ${name}`);
}
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); }, clear: () => values.clear() };
}
function resetBrowser() {
  Object.defineProperty(globalThis, 'indexedDB', { value: new IDBFactory(), configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: memoryStorage(), configurable: true });
  const tails = new Map<string, Promise<void>>();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
    request: async (name: string, options: unknown, callback?: () => Promise<unknown>) => {
      const action = typeof options === 'function' ? options as () => Promise<unknown> : callback!;
      const previous = tails.get(name) ?? Promise.resolve(); let release = () => {};
      const current = new Promise<void>(resolve => { release = resolve; }); tails.set(name, previous.then(() => current));
      await previous; try { return await action(); } finally { release(); }
    },
  } } });
}
const ar = directCrypto();
// Synthetic, ephemeral key: never logged or stored; all network transport is mocked.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 4096, publicExponent: 0x10001 });
const jwk = privateKey.export({ format: 'jwk' }) as JWKInterface;
const ownerAddress = await ar.wallets.jwkToAddress(jwk);
const keys = deriveKeysFromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const node = 'https://native-test.example';
const originalFetch = globalThis.fetch;
type RequestLog = { url: string; method: string; body?: Record<string, unknown> };
async function fixture(size = 32) {
  resetBrowser();
  const payload = { schema: 'synthetic', text: 'x'.repeat(size) };
  const envelope = await encryptJson(keys.encKey, keys.vaultId, payload);
  const archiveText = serializeEnvelope(envelope);
  const calls: RequestLog[] = [], chunks = new Map<number, Uint8Array>();
  const server = {
    reward: '1000', balance: '100000', network: 'arweave.N.1', confirmations: 12,
    header: null as DirectRawTransaction | null, signed: null as DirectRawTransaction | null,
    rawUnavailable: false, failChunkOnce: -1, chunkCalls: 0, loseHeaderAck: false, headerPosts: 0,
    signatures: 0, rejectSignature: false, alterSignature: false, delayed: false,
    releaseSignature: null as null | (() => Promise<void>), metadataKeyOrder: false,
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input), path = new URL(url).pathname, method = init.method ?? 'GET';
    assert.equal(new URL(url).origin, node, 'no hidden wallet, Worker, bundler, payment, or search-index requests');
    assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal(init.redirect, 'error');
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, method, body });
    if (path === '/info') return new Response(JSON.stringify({ network: server.network }));
    if (path.startsWith('/price/')) return new Response(server.reward);
    if (path.endsWith('/balance')) return new Response(server.balance);
    if (path === '/tx_anchor') return new Response('A'.repeat(64));
    if (method === 'POST' && path === '/tx') {
      assert.equal(body!.data, '', 'all sizes must post the header separately');
      assert.equal(body!.id, server.signed!.id); assert.equal(body!.signature, server.signed!.signature);
      server.header = body as DirectRawTransaction; server.headerPosts++;
      if (server.loseHeaderAck) { server.loseHeaderAck = false; throw Error('synthetic accepted header lost ACK'); }
      return new Response('{}');
    }
    if (method === 'POST' && path === '/chunk') {
      const chunkIndex = server.chunkCalls++;
      assert.equal(body!.data_root, server.signed!.data_root);
      if (server.failChunkOnce === chunkIndex) { server.failChunkOnce = -1; throw Error('synthetic interrupted chunk'); }
      chunks.set(Number(body!.offset), Uint8Array.from(Buffer.from(String(body!.chunk), 'base64url')));
      return new Response('{}');
    }
    if (path.endsWith('/status')) return server.header && server.confirmations > 0
      ? new Response(JSON.stringify({ block_height: 123, block_indep_hash: 'B'.repeat(64), number_of_confirmations: server.confirmations }))
      : new Response('pending', { status: 202 });
    if (server.header && path === `/tx/${server.header.id}`) {
      const header = { ...server.header, ...(server.metadataKeyOrder ? { tags: server.header.tags.map(tag => ({ value: tag.value, name: tag.name })) } : {}) };
      return new Response(JSON.stringify(header));
    }
    if (server.header && [`/raw/${server.header.id}`, `/${server.header.id}`, `/tx/${server.header.id}/data`].includes(path)) {
      const bytes = Buffer.concat([...chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => Buffer.from(value)));
      if (server.rawUnavailable || bytes.length !== Buffer.byteLength(archiveText)) {
        return new Response('synthetic HTML missing page'.repeat(1000), { status: 404, headers: { 'Content-Length': '26000' } });
      }
      return new Response(path.endsWith('/data') ? bytes.toString('base64url') : bytes);
    }
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
  const wallet: DirectWallet = {
    connect: async permissions => { assert.deepEqual(permissions, ['ACCESS_ADDRESS', 'ACCESS_PUBLIC_KEY', 'SIGN_TRANSACTION']); },
    getActiveAddress: async () => ownerAddress, getActivePublicKey: async () => jwk.n,
    sign: async value => {
      server.signatures++;
      assert.equal((await listDirectOperations())[0].state, 'signing', 'intent is durable before wallet signature');
      if (server.rejectSignature) throw { code: 4001 };
      const finish = async () => {
        const tx = ar.transactions.fromRaw((value as { toJSON(): DirectRawTransaction }).toJSON());
        tx.addTag('Signing-Client', 'Synthetic compatible wallet'); tx.addTag('Signing-Client-Version', '1.0.0');
        await ar.transactions.sign(tx, jwk); const signed = tx.toJSON();
        if (server.alterSignature) signed.reward = '9999';
        server.signed = signed; return signed;
      };
      if (!server.delayed) return finish();
      return new Promise((resolve, reject) => { server.releaseSignature = async () => { try { resolve(await finish()); } catch (error) { reject(error); } }; });
    },
  };
  const options = { nodes: [node] };
  const create = () => createDirectOperation({ envelope, treeId: 'tree-one' });
  const signed = async () => {
    let operation = await create(); operation = await quoteDirectOperation(operation.id, ownerAddress, options);
    return signDirectOperation(operation.id, wallet, operation.quote!.rewardWinston, options);
  };
  return { payload, envelope, archiveText, server, calls, wallet, options, create, signed, chunks };
}
try {
  await test('journal deduplicates exact ciphertext across tabs and local tree associations', async () => {
    const f = await fixture();
    const [first, second] = await Promise.all([f.create(), createDirectOperation({ envelope: f.envelope, treeId: 'tree-two' })]);
    assert.equal(first.id, second.id); assert.equal((await listDirectOperations()).length, 1);
    const changed = await encryptJson(keys.encKey, keys.vaultId, f.payload);
    await assert.rejects(() => createDirectOperation({ envelope: changed }), /pending_direct_operation/);
    assert.equal(f.calls.length, 0);
  });
  await test('legacy preservation is checked under the shared lock before new creation and signing', async () => {
    const f = await fixture(); localStorage.setItem('sejire.fundAttempt.v1.synthetic', '{}');
    await assert.rejects(f.create, /legacy_preservation_requires_original_app/); localStorage.clear();
    let operation = await f.create(); operation = await quoteDirectOperation(operation.id, ownerAddress, f.options);
    sessionStorage.setItem('sejire-funded:synthetic', '{}');
    await assert.rejects(() => signDirectOperation(operation.id, f.wallet, operation.quote!.rewardWinston, f.options), /legacy_preservation_requires_original_app/);
    assert.equal(f.server.signatures, 0);
  });
  await test('free backup preparation can be cancelled without deleting ciphertext or requiring payment', async () => {
    const f = await fixture(), prepared = await f.create(), cancelled = await cancelDirectOperation(prepared.id);
    assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.archiveText, prepared.archiveText); assert.equal(f.calls.length, 0);
    const reopened = await f.create(); assert.equal(reopened.id, prepared.id); assert.equal(reopened.state, 'prepared');
    await cancelDirectOperation(prepared.id);
    const newEnvelope = await encryptJson(keys.encKey, keys.vaultId, { ...f.payload, changed: true });
    const next = await createDirectOperation({ envelope: newEnvelope }); assert.notEqual(next.id, cancelled.id);
    assert.equal((await readDirectOperation(cancelled.id))!.archiveText, f.archiveText);
    await cancelDirectOperation(next.id);
    const signed = await f.signed(); await assert.rejects(() => cancelDirectOperation(signed.id), /signature_pending/);
    assert.equal(f.server.signatures, 1); assert.equal(f.server.headerPosts, 0);
  });
  await test('price movement, wrong owner, insufficient funds and wrong network stop before signing', async () => {
    const f = await fixture(); let operation = await f.create(); operation = await quoteDirectOperation(operation.id, ownerAddress, f.options);
    await assert.rejects(() => signDirectOperation(operation.id, f.wallet, '999', f.options), /quote_changed/);
    f.server.reward = '1001'; await assert.rejects(() => signDirectOperation(operation.id, f.wallet, '1000', f.options), /quote_changed/);
    f.server.reward = '1000'; f.server.balance = '999';
    await assert.rejects(() => signDirectOperation(operation.id, f.wallet, '1000', f.options), /insufficient_ar/);
    f.server.balance = '100000';
    await assert.rejects(() => signDirectOperation(operation.id, { ...f.wallet, getActiveAddress: async () => 'Z'.repeat(43) }, '1000', f.options), /wallet_changed/);
    f.server.network = 'not-Arweave'; await assert.rejects(() => quoteDirectOperation(operation.id, ownerAddress, f.options), /wrong_network/);
    assert.equal(f.server.signatures, 0); assert(!f.calls.some(call => call.method === 'POST'));
  });
  await test('a small archive sends both header and Merkle chunk, then verifies actual bytes before completion', async () => {
    const f = await fixture(); const signed = await f.signed();
    assert.equal(signed.state, 'signed'); assert.equal(f.server.headerPosts, 0); assert.equal(f.server.chunkCalls, 0);
    assert.equal((await readDirectOperation(signed.id))!.txId, signed.txId);
    const pendingLocator = directReceipt(signed); assert.equal(pendingLocator.transactionId, signed.txId);
    assert(!('confirmed' in pendingLocator));
    f.server.metadataKeyOrder = true;
    const completed = await resumeDirectOperation(signed.id, f.options);
    assert.equal(completed.state, 'complete'); assert.equal(completed.verification?.bytesVerified, true);
    assert.equal(f.server.signatures, 1); assert.equal(f.server.headerPosts, 1); assert.equal(f.server.chunkCalls, 1);
    assert.equal(completed.uploadProgress.totalChunks, 1);
    await resumeDirectOperation(signed.id, f.options); assert.equal(f.server.headerPosts, 1); assert.equal(f.server.chunkCalls, 1);
    const alias = await createDirectOperation({ envelope: f.envelope, treeId: 'different-tree' }); assert.equal(alias.id, completed.id);
    await assert.rejects(() => signDirectOperation(alias.id, f.wallet, '1000', f.options), /signature_pending/);
    const receipt = directReceipt(completed), restored = await retrieveDirectReceipt(receipt, f.options);
    assert.deepEqual(await decryptJson(keys.encKey, restored), f.payload);
    const known = await retrieveDirectTransaction(completed.txId!, f.options); assert.equal(known.receipt.archiveDigest, receipt.archiveDigest);
    assert.deepEqual(known.envelope, f.envelope); assert(!f.calls.some(call => call.url.includes('graphql')));
    assert.deepEqual(parseDirectReceipt(receipt), receipt);
  });
  await test('lost header ACK resumes the exact signed ID and never asks the wallet again', async () => {
    const f = await fixture(), signed = await f.signed(); f.server.loseHeaderAck = true;
    const uncertain = await resumeDirectOperation(signed.id, f.options); assert.equal(uncertain.state, 'uploading');
    assert.equal(uncertain.txId, signed.txId); assert.equal(uncertain.uploadProgress.headerAccepted, false);
    const complete = await resumeDirectOperation(uncertain.id, f.options); assert.equal(complete.state, 'complete');
    assert.equal(f.server.signatures, 1); assert.equal(f.server.headerPosts, 2);
    const posts = f.calls.filter(call => call.url.endsWith('/tx') && call.method === 'POST');
    assert.equal(posts[0].body!.signature, posts[1].body!.signature); assert.equal(posts[0].body!.id, posts[1].body!.id);
  });
  await test('multi-chunk interruption persists progress and reload resumes without a second signature or header', async () => {
    const f = await fixture(250_000), signed = await f.signed(); assert(signed.uploadProgress.totalChunks > 1);
    f.server.failChunkOnce = 1;
    const partial = await resumeDirectOperation(signed.id, f.options); assert.equal(partial.uploadProgress.uploadedChunks, 1);
    assert.equal(partial.state, 'uploading');
    const reloaded = await readDirectOperation(signed.id); assert.equal(reloaded!.txId, signed.txId);
    const completed = await resumeDirectOperation(reloaded!.id, f.options); assert.equal(completed.state, 'complete');
    assert.equal(f.server.signatures, 1); assert.equal(f.server.headerPosts, 1);
  });
  await test('header confirmation without bytes stays pending; explicit resume repairs only the same chunks', async () => {
    const f = await fixture(), signed = await f.signed(); f.server.rawUnavailable = true;
    let pending = await resumeDirectOperation(signed.id, f.options);
    assert.equal(pending.state, 'confirming'); assert.equal(pending.verification?.confirmed, true);
    assert.equal(pending.verification?.bytesVerified, false); assert.equal(pending.lastError, 'archive_unavailable');
    const before = f.server.chunkCalls; await checkDirectOperation(signed.id, f.options); assert.equal(f.server.chunkCalls, before);
    f.server.rawUnavailable = false;
    // Simulate acknowledged chunks subsequently absent from serving storage.
    f.chunks.clear(); pending = await resumeDirectOperation(signed.id, f.options);
    assert.equal(pending.state, 'complete'); assert.equal(f.server.headerPosts, 1);
    assert.equal(f.server.chunkCalls, before + 1); assert.equal(f.server.signatures, 1);
    const onceComplete = pending; f.chunks.clear(); pending = await resumeDirectOperation(signed.id, f.options);
    assert.equal(pending.state, 'complete'); assert.equal(pending.txId, onceComplete.txId); assert.equal(f.server.headerPosts, 1);
  });
  await test('a pending wallet signature cannot be requested twice and a late valid response is journaled', async () => {
    const f = await fixture(); f.server.delayed = true;
    const operation = await f.create(); await quoteDirectOperation(operation.id, ownerAddress, f.options);
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      realSetTimeout(callback, delay === 60_000 ? 20 : delay, ...args)) as typeof setTimeout;
    let pending: DirectOperation;
    try { pending = await signDirectOperation(operation.id, f.wallet, '1000', f.options); }
    finally { globalThis.setTimeout = realSetTimeout; }
    assert.equal(pending!.state, 'signing'); assert.equal(pending!.lastError, 'signature_pending');
    await assert.rejects(() => cancelDirectOperation(operation.id), /signature_pending/);
    await assert.rejects(() => signDirectOperation(operation.id, f.wallet, '1000', f.options), /signature_pending/);
    assert.equal(f.server.signatures, 1); assert.equal(f.server.headerPosts, 0);
    await f.server.releaseSignature!();
    let result = await readDirectOperation(operation.id);
    for (let attempt = 0; attempt < 20 && result?.state !== 'signed'; attempt++) {
      await new Promise(resolve => setImmediate(resolve)); result = await readDirectOperation(operation.id);
    }
    assert.equal(result!.state, 'signed'); assert(result!.signedTx); assert.equal(f.server.headerPosts, 0);
  });
  await test('interrupted repair retains the known missing-data warning until fresh readback succeeds', async () => {
    const f = await fixture(), signed = await f.signed(), completed = await resumeDirectOperation(signed.id, f.options);
    const receipt = directReceipt(completed); f.chunks.clear();
    const controller = new AbortController(), transport = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const response = await transport(input, init);
      if (String(input).endsWith('/chunk') && init.method === 'POST') controller.abort();
      return response;
    }) as typeof fetch;
    await assert.rejects(() => resumeDirectOperation(signed.id, { ...f.options, signal: controller.signal }), /operation_cancelled/);
    const persisted = await readDirectOperation(signed.id);
    assert.equal(persisted!.state, 'complete'); assert.equal(persisted!.lastError, 'archive_unavailable');
    assert.deepEqual(directReceipt(persisted!), receipt); assert.equal(f.server.signatures, 1); assert.equal(f.server.headerPosts, 1);
    globalThis.fetch = transport;
    const checked = await checkDirectOperation(signed.id, f.options); assert.equal(checked.lastError, null);
  });
  await test('explicit wallet rejection permits retry, altered wallet transaction does not', async () => {
    const f = await fixture(); f.server.rejectSignature = true;
    let operation = await f.signed(); assert.equal(operation.state, 'prepared'); assert.equal(operation.signingIntent, null);
    f.server.rejectSignature = false; f.server.alterSignature = true;
    operation = await signDirectOperation(operation.id, f.wallet, '1000', f.options);
    assert.equal(operation.state, 'blocked'); assert.equal(operation.lastError, 'signature_invalid');
    await assert.rejects(() => signDirectOperation(operation.id, f.wallet, '1000', f.options), /signature_pending/);
    assert.equal(f.server.headerPosts, 0);
  });
  await test('a non-responsive wallet connection is bounded before a signing intent or upload exists', async () => {
    const f = await fixture(), operation = await f.create(); await quoteDirectOperation(operation.id, ownerAddress, f.options);
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      realSetTimeout(callback, delay === 45_000 ? 20 : delay, ...args)) as typeof setTimeout;
    try { await assert.rejects(() => signDirectOperation(operation.id, { ...f.wallet, connect: async () => new Promise(() => {}) }, '1000', f.options), /operation_cancelled/); }
    finally { globalThis.setTimeout = realSetTimeout; }
    const current = await readDirectOperation(operation.id); assert.equal(current!.state, 'prepared'); assert.equal(current!.signingIntent, null);
    assert.equal(f.server.signatures, 0); assert.equal(f.server.headerPosts, 0);
  });
  await test('abort at durable intent commit before the wallet call rolls back only the unrequested signature', async () => {
    const f = await fixture(), operation = await f.create(); await quoteDirectOperation(operation.id, ownerAddress, f.options);
    const controller = new AbortController(), originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (value && typeof value === 'object' && 'state' in value && value.state === 'signing') {
        this.transaction.addEventListener('complete', () => controller.abort(), { once: true });
      }
      return originalPut.call(this, value, key);
    };
    try { await assert.rejects(() => signDirectOperation(operation.id, f.wallet, '1000', { ...f.options, signal: controller.signal }), /operation_cancelled/); }
    finally { IDBObjectStore.prototype.put = originalPut; }
    const current = await readDirectOperation(operation.id);
    assert.equal(current!.state, 'prepared'); assert.equal(current!.signingIntent, null); assert.equal(f.server.signatures, 0);
    assert.equal((await cancelDirectOperation(operation.id)).state, 'cancelled');
    assert.equal(f.server.headerPosts, 0);
  });
  await test('signed portable package imports into clean browser without trusting completion or uploading', async () => {
    const f = await fixture(), signed = await f.signed(); const packageValue = exportDirectOperation(signed);
    assert(!JSON.stringify(packageValue).includes('"d":')); assert(!JSON.stringify(packageValue).includes('mnemonic'));
    const tampered = structuredClone(packageValue); tampered.operation.archiveText += ' ';
    await assert.rejects(() => importDirectOperation(tampered), /invalid_operation|archive_integrity_failed/);
    resetBrowser();
    const imported = await importDirectOperation(packageValue); assert.equal(imported.state, 'signed');
    assert.equal(imported.verification, null); assert.equal(imported.uploadProgress.uploadedChunks, 0);
    assert.equal(imported.txId, signed.txId); assert.equal(f.server.headerPosts, 0);
    const same = await importDirectOperation(packageValue); assert.equal(same.revision, imported.revision);
    const complete = await resumeDirectOperation(imported.id, f.options); assert.equal(complete.state, 'complete'); assert.equal(f.server.signatures, 1);
    const fakeProof = exportDirectOperation(complete); resetBrowser();
    const clean = await importDirectOperation(fakeProof); assert.equal(clean.state, 'signed'); assert.equal(clean.verification, null);
  });
  await test('a forged receipt or public header is rejected before decrypting a vault', async () => {
    const f = await fixture(), signed = await f.signed(); const complete = await resumeDirectOperation(signed.id, f.options);
    const receipt = directReceipt(complete);
    await assert.rejects(() => retrieveDirectReceipt({ ...receipt, archiveDigest: '0'.repeat(64) }, f.options), /archive_integrity_failed/);
    f.server.header = { ...f.server.header!, owner: 'A'.repeat(683) };
    await assert.rejects(() => retrieveDirectTransaction(complete.txId!, f.options), /receipt_invalid/);
    assert.equal(f.server.signatures, 1);
  });
  await test('invalid endpoints, rate limiting and prior cancellation never start an unapproved request', async () => {
    for (const value of ['http://node.example', 'https://user:password@node.example', 'https://node.example/path', 'https://node.example/?key=secret']) {
      assert.throws(() => directNode(value), /invalid_node/);
    }
    let calls = 0; globalThis.fetch = (async () => { calls++; return new Response('rate limit', { status: 429 }); }) as typeof fetch;
    await assert.rejects(() => nodeRequest('https://limited-test.example', '/info'), /network_rate_limited/);
    await assert.rejects(() => nodeRequest('https://limited-test.example', '/info'), /network_rate_limited/); assert.equal(calls, 1);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => nodeRequest('https://cancelled-test.example', '/info', { signal: controller.signal }), /operation_cancelled/);
    assert.equal(calls, 1);
  });
  await test('failed durable storage stops before any wallet prompt or upload', async () => {
    const f = await fixture(), operation = await f.create(); await quoteDirectOperation(operation.id, ownerAddress, f.options);
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open() { throw Error('synthetic quota failure'); } } });
    await assert.rejects(() => signDirectOperation(operation.id, f.wallet, '1000', f.options), /legacy_journal_unavailable|storage_unavailable/);
    assert.equal(f.server.signatures, 0); assert(!f.calls.some(call => call.method === 'POST'));
  });
  console.log(`PASS ${passed} direct Arweave tests: synthetic wallet, mocked HTTP, no live signatures, uploads or payments.`);
} finally { globalThis.fetch = originalFetch; }
