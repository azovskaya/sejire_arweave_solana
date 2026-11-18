import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { validatePath } from 'arweave/web/lib/merkle';
import type { JWKInterface } from 'arweave/web/lib/wallet';
import type Transaction from 'arweave/web/lib/transaction';
import { encryptJson } from '../crypto/encrypt';
import { serializeEnvelope } from '../crypto/envelope';
import { deriveKeysFromMnemonic } from '../crypto/keys';
import { createDirectOperation, readDirectOperation, listDirectOperations, cancelDirectOperation } from './journal';
import { quoteDirectOperation, signDirectOperation, resumeDirectOperation, checkDirectOperation } from './client';
import { directCrypto, verifyDirectSigned } from './transaction';
import { sha256, MAX_BACKUP_BYTES } from './format';
import { nodeRequest } from './network';
import type { DirectOperation, DirectRawTransaction, DirectWallet } from './types';

// No external transport or persistent fixtures: every key, archive and node is
// synthetic. The seed controls payload data; cryptographic keys/IVs stay ephemeral.
const SEED = 0x18_11_2026;
let randomState = SEED;
function randomText(length: number): string {
  const chars = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5;
    chars[index] = 65 + (randomState >>> 0) % 26;
  }
  return new TextDecoder().decode(chars);
}
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); }, clear: () => values.clear() };
}
const originalFetch = globalThis.fetch, originalDateNow = Date.now;
const originalGlobals = new Map(['indexedDB', 'localStorage', 'sessionStorage', 'navigator'].map(name =>
  [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
function resetBrowser() {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memoryStorage() });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: memoryStorage() });
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
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Error(`local boundary did not settle: ${label}`)), 15_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
const ar = directCrypto();
const jwk = generateKeyPairSync('rsa', { modulusLength: 4096, publicExponent: 0x10001 }).privateKey.export({ format: 'jwk' }) as JWKInterface;
const ownerAddress = await ar.wallets.jwkToAddress(jwk);
const keys = deriveKeysFromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const PRIMARY = 'https://boundary-primary.example', SECONDARY = 'https://boundary-secondary.example';
type RequestLog = { origin: string; path: string; method: string; body: Record<string, unknown> | null };
type LocalNode = { online: boolean; confirmations: number; header: DirectRawTransaction | null; chunks: Map<number, Uint8Array> };

async function fixture(textLength = 48) {
  resetBrowser();
  const envelope = await encryptJson(keys.encKey, keys.vaultId, { schema: 'synthetic-boundary', text: randomText(textLength) });
  const archiveText = serializeEnvelope(envelope), archiveBytes = new TextEncoder().encode(archiveText);
  const requests: RequestLog[] = [];
  const nodes = new Map<string, LocalNode>([PRIMARY, SECONDARY].map(origin =>
    [origin, { online: true, confirmations: 3, header: null, chunks: new Map() }]));
  const walletState = { prompts: 0, connects: 0, signed: null as DirectRawTransaction | null };
  const pricing = { reward: '1000', balance: '100000' };
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)), node = nodes.get(url.origin);
    assert(node, 'the test must never contact an unmodelled origin');
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    const method = init.method ?? 'GET', body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ origin: url.origin, path: url.pathname, method, body });
    if (!node.online) return new Response('synthetic offline node', { status: 503 });
    if (url.pathname === '/info') return Response.json({ network: 'arweave.N.1' });
    if (url.pathname.startsWith('/price/')) return new Response(pricing.reward);
    if (url.pathname.endsWith('/balance')) return new Response(pricing.balance);
    if (url.pathname === '/tx_anchor') return new Response('A'.repeat(64));
    if (method === 'POST' && url.pathname === '/tx') {
      assert.equal(body?.data, ''); assert.equal(body?.id, walletState.signed?.id);
      assert.equal(body?.signature, walletState.signed?.signature);
      node.header = body as DirectRawTransaction;
      return new Response('{}');
    }
    if (method === 'POST' && url.pathname === '/chunk') {
      assert(node.header, 'a replacement node must receive the signed header');
      const bytes = Uint8Array.from(Buffer.from(String(body?.chunk), 'base64url'));
      const proof = Uint8Array.from(Buffer.from(String(body?.data_path), 'base64url'));
      assert.equal(body?.data_root, node.header.data_root); assert.equal(body?.data_size, String(archiveBytes.length));
      const bound = await validatePath(ar.utils.b64UrlToBuffer(node.header.data_root), Number(body?.offset), 0, archiveBytes.length, proof);
      assert(bound); assert.equal(bound.chunkSize, bytes.length); assert.equal(bound.offset, Number(body?.offset));
      assert.equal(await sha256(bytes), Buffer.from(proof.slice(-64, -32)).toString('hex'));
      assert.deepEqual(bytes, archiveBytes.slice(bound.leftBound, bound.rightBound));
      node.chunks.set(Number(body?.offset), bytes);
      return new Response('{}');
    }
    if (url.pathname.endsWith('/status')) return node.header && node.confirmations > 0
      ? Response.json({ number_of_confirmations: node.confirmations, block_height: 123, block_indep_hash: 'B'.repeat(64) })
      : new Response('synthetic pending', { status: node.header ? 202 : 404 });
    if (node.header && url.pathname === `/tx/${node.header.id}`) return Response.json(node.header);
    if (node.header && [`/raw/${node.header.id}`, `/${node.header.id}`, `/tx/${node.header.id}/data`].includes(url.pathname)) {
      const joined = Buffer.concat([...node.chunks].sort((a, b) => a[0] - b[0]).map(([, bytes]) => bytes));
      if (joined.length !== archiveBytes.length) return new Response('synthetic missing bytes', { status: 404 });
      return new Response(url.pathname.endsWith('/data') ? joined.toString('base64url') : joined);
    }
    return new Response('synthetic missing', { status: 404 });
  }) as typeof fetch;
  const wallet: DirectWallet = {
    connect: async () => { walletState.connects++; }, getActiveAddress: async () => ownerAddress,
    getActivePublicKey: async () => jwk.n,
    sign: async value => {
      walletState.prompts++;
      const journal = await listDirectOperations(); assert.equal(journal[0].state, 'signing');
      const tx = ar.transactions.fromRaw((value as Transaction).toJSON()); await ar.transactions.sign(tx, jwk);
      walletState.signed = tx.toJSON(); return walletState.signed;
    },
  };
  const options = { nodes: [PRIMARY] };
  const prepared = async () => {
    const operation = await createDirectOperation({ envelope, treeId: 'synthetic-tree' });
    return quoteDirectOperation(operation.id, ownerAddress, options);
  };
  const signed = async () => { const operation = await prepared(); return signDirectOperation(operation.id, wallet, '1000', options); };
  return { envelope, archiveText, archiveBytes, requests, nodes, walletState, pricing, wallet, options, prepared, signed };
}

function assertSameSigned(before: DirectOperation, after: DirectOperation) {
  for (const key of ['id', 'txId', 'archiveText', 'archiveDigest', 'archiveBytes', 'parentTxId', 'ownerAddress'] as const) {
    assert.equal(after[key], before[key], `${key} must survive a retry exactly`);
  }
  assert.deepEqual(after.signedTx, before.signedTx); assert.deepEqual(after.signingIntent, before.signingIntent);
  assert.equal(after.quote?.rewardWinston, before.quote?.rewardWinston);
}
async function abortCommitOnce(predicate: (operation: DirectOperation) => boolean, action: () => Promise<unknown>) {
  const originalPut = IDBObjectStore.prototype.put; let aborted = 0;
  IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
    const request = originalPut.call(this, value, key), transaction = this.transaction;
    if (!aborted && value && typeof value === 'object' && 'schema' in value &&
      value.schema === 'sejire/direct-arweave-operation/v1' && predicate(value as DirectOperation)) {
      aborted++;
      // The request itself succeeds. The surrounding durable transaction does
      // not commit, modelling the boundary beyond a simple synchronous throw.
      request.addEventListener('success', () => transaction.abort(), { once: true });
    }
    return request;
  };
  try { await assert.rejects(action, /storage_unavailable/); assert.equal(aborted, 1); }
  finally { IDBObjectStore.prototype.put = originalPut; }
}
function observeCommit(predicate: (operation: DirectOperation) => boolean) {
  const originalPut = IDBObjectStore.prototype.put, committed = deferred<DirectOperation>();
  IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
    if (value && typeof value === 'object' && 'schema' in value &&
      value.schema === 'sejire/direct-arweave-operation/v1' && predicate(value as DirectOperation)) {
      this.transaction.addEventListener('complete', () => committed.resolve(structuredClone(value) as DirectOperation), { once: true });
    }
    return originalPut.call(this, value, key);
  };
  return { promise: committed.promise, restore: () => { IDBObjectStore.prototype.put = originalPut; } };
}

let passed = 0;
async function test(name: string, action: () => Promise<void>) {
  await bounded(action(), name); passed++; console.log(`PASS ${name}`);
}
try {
  await test('an acknowledged but unconfirmed archive can explicitly resume the same transaction at a replacement node', async () => {
    const f = await fixture(), signed = await f.signed();
    f.nodes.get(PRIMARY)!.confirmations = 0;
    const pending = await resumeDirectOperation(signed.id, f.options);
    assert.equal(pending.state, 'confirming'); assert.equal(pending.lastError, 'confirmation_pending');
    f.nodes.get(PRIMARY)!.online = false;
    const beforeRead = f.requests.filter(request => request.method === 'POST').length;
    await checkDirectOperation(signed.id, { nodes: [SECONDARY] });
    assert.equal(f.requests.filter(request => request.method === 'POST').length, beforeRead, 'a status check must remain read-only');
    const resumed = await resumeDirectOperation(signed.id, { nodes: [SECONDARY] });
    assert.equal(resumed.state, 'complete'); assert.equal(resumed.txId, signed.txId);
    assertSameSigned(signed, resumed);
    assert.equal(f.walletState.prompts, 1);
    const newWrites = f.requests.filter(request => request.method === 'POST' && request.origin === SECONDARY);
    assert.equal(newWrites[0]?.path, '/tx'); assert.equal(newWrites[0]?.body?.id, signed.txId);
    assert.equal(newWrites[0]?.body?.signature, signed.signedTx?.signature);
    assert.equal(newWrites.filter(request => request.path === '/chunk').length, signed.uploadProgress.totalChunks);
  });
  await test('unconfirmed retry stops on a conflicting header even when a later node is unavailable', async () => {
    for (const confirmations of [0, 3]) {
      const f = await fixture(), signed = await f.signed(); f.nodes.get(PRIMARY)!.confirmations = 0;
      await resumeDirectOperation(signed.id, f.options);
      f.nodes.get(PRIMARY)!.confirmations = confirmations;
      f.nodes.get(PRIMARY)!.header = { ...f.nodes.get(PRIMARY)!.header!, reward: '1001' };
      f.nodes.get(SECONDARY)!.online = false;
      const writes = f.requests.filter(request => request.method === 'POST').length;
      const stopped = await resumeDirectOperation(signed.id, { nodes: [PRIMARY, SECONDARY] });
      assert.equal(stopped.state, 'confirming'); assert.equal(stopped.lastError, 'archive_integrity_failed');
      assert.equal(f.requests.filter(request => request.method === 'POST').length, writes);
      assertSameSigned(signed, stopped); assert.equal(f.walletState.prompts, 1);
    }
  });
  await test('an intent transaction aborts before any wallet call; a signed-result commit failure cannot authorize another prompt', async () => {
    for (const stage of ['signing', 'signed'] as const) {
      const f = await fixture(), prepared = await f.prepared();
      await abortCommitOnce(operation => operation.state === stage,
        () => signDirectOperation(prepared.id, f.wallet, '1000', f.options));
      const stored = (await readDirectOperation(prepared.id))!;
      assert.equal(stored.archiveText, prepared.archiveText); assert.equal(stored.signedTx, null);
      assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
      assert.equal(f.walletState.prompts, stage === 'signing' ? 0 : 1);
      if (stage === 'signing') {
        assert.equal(stored.state, 'prepared'); assert.equal(stored.signingIntent, null);
        const retried = await signDirectOperation(prepared.id, f.wallet, '1000', f.options);
        assert.equal(retried.state, 'signed'); assert.equal(f.walletState.prompts, 1);
      } else {
        assert.equal(stored.state, 'signing'); assert(stored.signingIntent);
        await assert.rejects(() => cancelDirectOperation(prepared.id), /signature_pending/);
        await assert.rejects(() => signDirectOperation(prepared.id, f.wallet, '1000', f.options), /signature_pending/);
        assert.equal(f.walletState.prompts, 1);
      }
    }
  });
  await test('five upload commit boundaries replay only already signed bytes after reloading the journal', async () => {
    const stages = [
      { name: 'selected-node', match: (op: DirectOperation) => op.state === 'uploading' && !op.uploadProgress.headerAccepted,
        state: 'signed', headers: 1, chunks: 1 },
      { name: 'header-ack', match: (op: DirectOperation) => op.state === 'uploading' && op.uploadProgress.headerAccepted && op.uploadProgress.uploadedChunks === 0,
        state: 'uploading', headers: 2, chunks: 1 },
      { name: 'chunk-ack', match: (op: DirectOperation) => op.state === 'uploading' && op.uploadProgress.uploadedChunks === 1,
        state: 'uploading', headers: 1, chunks: 2 },
      { name: 'confirming', match: (op: DirectOperation) => op.state === 'confirming',
        state: 'uploading', headers: 1, chunks: 1 },
      { name: 'complete', match: (op: DirectOperation) => op.state === 'complete',
        state: 'confirming', headers: 1, chunks: 1 },
    ];
    for (const stage of stages) {
      const f = await fixture(), signed = await f.signed();
      await abortCommitOnce(stage.match, () => resumeDirectOperation(signed.id, f.options));
      const reloaded = (await readDirectOperation(signed.id))!;
      assert.equal(reloaded.state, stage.state, stage.name); assertSameSigned(signed, reloaded);
      const complete = await resumeDirectOperation(reloaded.id, f.options);
      assert.equal(complete.state, 'complete', stage.name); assertSameSigned(signed, complete);
      assert.equal(f.walletState.prompts, 1, stage.name);
      assert.equal(f.requests.filter(request => request.method === 'POST' && request.path === '/tx').length, stage.headers, stage.name);
      assert.equal(f.requests.filter(request => request.method === 'POST' && request.path === '/chunk').length, stage.chunks, stage.name);
    }
  });
  await test('overlapping client instances produce one signature and one upload before read-only completion checks', async () => {
    const f = await fixture(), prepared = await f.prepared();
    const reloadedClient = await import(new URL('./client.ts?boundary-instance=2', import.meta.url).href) as typeof import('./client');
    const results = await Promise.allSettled([
      signDirectOperation(prepared.id, f.wallet, '1000', f.options),
      reloadedClient.signDirectOperation(prepared.id, f.wallet, '1000', f.options),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const refused = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.match(String(refused.reason), /signature_pending/); assert.equal(f.walletState.prompts, 1);
    const signed = (await readDirectOperation(prepared.id))!;
    const completed = await Promise.all([resumeDirectOperation(prepared.id, f.options), reloadedClient.resumeDirectOperation(prepared.id, f.options)]);
    assert(completed.every(operation => operation.state === 'complete'));
    completed.forEach(operation => assertSameSigned(signed, operation));
    assert.equal(f.requests.filter(request => request.method === 'POST' && request.path === '/tx').length, 1);
    assert.equal(f.requests.filter(request => request.method === 'POST' && request.path === '/chunk').length, 1);
  });
  await test('a late definitive decline clears only its original intent; a late transport failure remains unresolved', async () => {
    for (const definitive of [true, false]) {
      const f = await fixture(), prepared = await f.prepared(), answer = deferred<unknown>(), armed = deferred<() => void>();
      let prompts = 0;
      const wallet = { ...f.wallet, sign: () => { prompts++; return answer.promise; } };
      const originalTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        if (delay === 60_000) {
          armed.resolve(() => callback(...args));
          return originalTimeout(() => {}, 0);
        }
        return originalTimeout(callback, delay, ...args);
      }) as typeof setTimeout;
      let pending: DirectOperation;
      try {
        const signing = signDirectOperation(prepared.id, wallet, '1000', f.options);
        const fire = await bounded(armed.promise, 'wallet timeout armed'); fire(); pending = await signing;
      } finally { globalThis.setTimeout = originalTimeout; }
      assert.equal(pending!.state, 'signing'); assert.equal(prompts, 1);
      const expectedState = definitive ? 'prepared' : 'signing';
      const commit = observeCommit(operation => operation.id === prepared.id && operation.state === expectedState);
      try {
        answer.reject(definitive ? 'User failed to sign the transaction manually' : Error('Synthetic transport disconnected'));
        const settled = await bounded(commit.promise, 'late wallet result journalled');
        assert.equal(settled.lastError, definitive ? 'wallet_rejected' : 'signature_pending');
        assert.equal(settled.archiveText, prepared.archiveText); assert.equal(prompts, 1);
        if (definitive) {
          assert.equal(settled.signingIntent, null);
          const signed = await signDirectOperation(prepared.id, f.wallet, '1000', f.options);
          assert.equal(signed.state, 'signed'); assert.equal(f.walletState.prompts, 1);
        } else {
          assert.deepEqual(settled.signingIntent, pending!.signingIntent);
          await assert.rejects(() => signDirectOperation(prepared.id, f.wallet, '1000', f.options), /signature_pending/);
          await assert.rejects(() => cancelDirectOperation(prepared.id), /signature_pending/);
          assert.equal(f.walletState.prompts, 0);
        }
        assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
      } finally { commit.restore(); }
    }
  });
  await test('quote expiry and backwards clock changes stop before wallet access; exact large integer fees remain unchanged', async () => {
    for (const age of [-1, 60_001]) {
      const f = await fixture(); Date.now = () => 1_800_000_000_000;
      try {
        const prepared = await f.prepared(), before = structuredClone(prepared);
        Date.now = () => 1_800_000_000_000 + age;
        await assert.rejects(() => signDirectOperation(prepared.id, f.wallet, '1000', f.options), /quote_expired/);
        assert.deepEqual(await readDirectOperation(prepared.id), before);
        assert.equal(f.walletState.connects, 0); assert.equal(f.walletState.prompts, 0);
      } finally { Date.now = originalDateNow; }
    }
    const f = await fixture(); f.pricing.reward = '900719925474099312345'; f.pricing.balance = f.pricing.reward;
    const prepared = await f.prepared(), signed = await signDirectOperation(prepared.id, f.wallet, f.pricing.reward, f.options);
    assert.equal(signed.signedTx?.reward, f.pricing.reward); assert.equal(signed.quote?.rewardWinston, f.pricing.reward);
    assert.equal(f.walletState.prompts, 1); assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
  });
  await test('nine independently valid signatures cannot replace the transaction authorized by the saved intent', async () => {
    const f = await fixture(), signed = await f.signed();
    const expected: DirectOperation = { ...signed, state: 'signing', signedTx: null, txId: null,
      uploadProgress: { node: null, headerAccepted: false, uploadedChunks: 0, totalChunks: 0 } };
    const mutations: { name: string; apply: (tx: Transaction) => void | Promise<void> }[] = [
      { name: 'fee', apply: tx => { tx.reward = '1001'; } },
      { name: 'anchor', apply: tx => { Object.assign(tx, { last_tx: 'C'.repeat(64) }); } },
      { name: 'recipient', apply: tx => { Object.assign(tx, { target: ownerAddress }); } },
      { name: 'value-transfer', apply: tx => { Object.assign(tx, { quantity: '1' }); } },
      { name: 'byte-count', apply: tx => { Object.assign(tx, { data_size: String(signed.archiveBytes + 1) }); } },
      { name: 'merkle-root', apply: tx => { tx.data_root = 'D'.repeat(43); } },
      { name: 'ciphertext', apply: async tx => {
        const envelope = structuredClone(f.envelope);
        envelope.ciphertext = (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1);
        tx.data = new TextEncoder().encode(serializeEnvelope(envelope)); tx.data_root = '';
        await tx.prepareChunks(tx.data);
      } },
      { name: 'duplicate-save-id', apply: tx => { tx.addTag('Save-Id', signed.id); } },
      { name: 'unexpected-parent', apply: tx => { tx.addTag('Parent-Tx', 'P'.repeat(43)); } },
    ];
    for (const mutation of mutations) {
      const tx = ar.transactions.fromRaw(expected.signingIntent!.unsignedTx);
      await mutation.apply(tx); await ar.transactions.sign(tx, jwk);
      assert(await ar.transactions.verify(tx), `the ${mutation.name} fixture must have a valid native signature`);
      await assert.rejects(() => verifyDirectSigned(expected, tx.toJSON()), /signature_invalid|invalid_operation/, mutation.name);
    }
    assert.deepEqual(await readDirectOperation(signed.id), signed);
    assert.equal(f.walletState.prompts, 1); assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
  });
  await test('Merkle proofs and byte offsets cover native chunk split boundaries and an archive near the size limit', async () => {
    const baseline = (await fixture(0)).archiveBytes.length;
    const boundary = 256 * 1024, minimum = 32 * 1024;
    const targets = [boundary - 8, boundary + 8, boundary + minimum - 8, boundary + minimum + 8,
      2 * boundary - 8, 2 * boundary + 8, MAX_BACKUP_BYTES - 8];
    const measured: { bytes: number; chunks: number }[] = [];
    for (const target of targets) {
      const textLength = Math.max(0, Math.floor((target - baseline) * 3 / 4));
      const f = await fixture(textLength);
      assert(Math.abs(f.archiveBytes.length - target) <= 4, `fixture should straddle requested byte boundary ${target}`);
      const signed = await f.signed(), tx = await verifyDirectSigned(signed);
      const count = tx.chunks!.chunks.length;
      assert(count > 0 && count <= 40);
      if (target === MAX_BACKUP_BYTES - 8) assert.equal(count, 40);
      measured.push({ bytes: f.archiveBytes.length, chunks: count });
      let nextOffset = 0;
      for (let index = 0; index < count; index++) {
        const chunk = tx.getChunk(index, tx.data), bytes = ar.utils.b64UrlToBuffer(chunk.chunk);
        const path = ar.utils.b64UrlToBuffer(chunk.data_path);
        const verified = await validatePath(ar.utils.b64UrlToBuffer(chunk.data_root), Number(chunk.offset), 0, f.archiveBytes.length, path);
        assert(verified); assert.equal(verified.leftBound, nextOffset);
        assert.equal(verified.chunkSize, bytes.length); assert(bytes.length > 0 && bytes.length <= boundary);
        assert.equal(await sha256(bytes), Buffer.from(path.slice(-64, -32)).toString('hex'));
        assert.deepEqual(bytes, f.archiveBytes.slice(verified.leftBound, verified.rightBound));
        nextOffset = verified.rightBound;
      }
      assert.equal(nextOffset, f.archiveBytes.length, 'no byte may be skipped, repeated, or replaced by an empty trailing chunk');
      // Exercise actual client POST construction around the six split boundaries.
      // The upper-limit case validates all 40 proofs without retaining another
      // full 10 MiB copy in the mock serving node.
      if (target !== MAX_BACKUP_BYTES - 8) {
        const complete = await resumeDirectOperation(signed.id, f.options);
        assert.equal(complete.state, 'complete'); assertSameSigned(signed, complete);
        assert.equal(f.requests.filter(request => request.method === 'POST' && request.path === '/chunk').length, count);
      }
      assert.equal(f.walletState.prompts, 1);
    }
    console.log(`INFO verified native byte/chunk matrix ${JSON.stringify(measured)}`);
  });
  await test('rejected response lengths and active-read cancellation close the response stream', async () => {
    for (const declared of ['33', 'invalid']) {
      let cancelled = 0;
      globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(8)); }, cancel() { cancelled++; },
      }), { headers: { 'content-length': declared } });
      await assert.rejects(() => nodeRequest(PRIMARY, '/raw/synthetic', { maxBytes: 32 }), /archive_integrity_failed/);
      assert.equal(cancelled, 1, `invalid declared length ${declared} must cancel the unread body`);
    }
    let overflowCancelled = 0;
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(40)); }, cancel() { overflowCancelled++; },
    }));
    await assert.rejects(() => nodeRequest(PRIMARY, '/raw/synthetic', { maxBytes: 32 }), /archive_integrity_failed/);
    assert.equal(overflowCancelled, 1);
    const stalled = deferred<void>(), controller = new AbortController(); let pulls = 0, abortCancelled = 0;
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(stream) {
        if (++pulls === 1) { stream.enqueue(new Uint8Array(8)); return; }
        stalled.resolve(); return new Promise(() => {});
      },
      cancel() { abortCancelled++; },
    }));
    const rejected = assert.rejects(() => nodeRequest(PRIMARY, '/raw/synthetic', { maxBytes: 32, signal: controller.signal }), /operation_cancelled/);
    await bounded(stalled.promise, 'stream reader stalled'); controller.abort(); await rejected;
    assert.equal(abortCancelled, 1);
  });
  console.log(`PASS ${passed} direct protocol boundary groups (36 fixed cases); payload seed 0x${SEED.toString(16)}; synthetic keys and transport only.`);
} finally {
  globalThis.fetch = originalFetch; Date.now = originalDateNow;
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
  keys.seed.fill(0); keys.master.fill(0); keys.encKey.fill(0);
}
