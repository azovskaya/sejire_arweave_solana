import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from './permaweb-release.mjs';
import { INDEPENDENT_PROFILE } from './static-release-profile.mjs';
import { nativeCliArguments, nativeCrypto, nativeNode, nativePlan, nativeQuote,
  nativeRequest, nativeWinston, localFileSigner, publishNative } from './native-permaweb.mjs';

// Ephemeral software signer only. No fixture private key, wallet extension,
// real network, upload or mainnet payment is used by these tests.
const key = generateKeyPairSync('rsa', { modulusLength: 4096 }).privateKey.export({ format: 'jwk' });
const crypto = await nativeCrypto();
const address = await crypto.wallets.ownerToAddress(key.n);
const SOURCE = 'a'.repeat(40), NODE = 'https://native.example';
const response = (value, status = 200) => new Response(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value), { status });
async function fixture(t, { large = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sejire-native-publish-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const releaseRoot = join(root, 'release'), journal = join(root, 'persistent-journal');
  await mkdir(join(releaseRoot, 'assets'), { recursive: true });
  const payloads = new Map([
    ['index.html', Buffer.from('<!doctype html><script src="./assets/app.js"></script>')],
    ['404.html', Buffer.from('<!doctype html><script src="./assets/app.js"></script>')],
    ['assets/app.js', Buffer.from(large ? 'x'.repeat(300000) : 'export const app="synthetic";')],
  ]);
  for (const [path, bytes] of payloads) await writeFile(join(releaseRoot, path), bytes);
  const release = { root: releaseRoot, manifest: { profile: INDEPENDENT_PROFILE, sourceCommit: SOURCE },
    manifestSha256: digest('synthetic exact release manifest'),
    files: [...payloads].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: digest(bytes) })) };
  const f = { root, release, journal, signCalls: 0, posts: [], requests: [], stored: new Map(),
    confirmations: 1, price: '10', balance: '100000', failHeaderOnce: false, failChunkOnce: false,
    wrongNetwork: false, corruptBytes: false, corruptHeader: false, rawAvailable: true, onlyNativeData: false, onSign: null, onPost: null };
  f.state = async () => JSON.parse(await readFile(join(journal, 'journal.json'), 'utf8'));
  f.signer = { publicKey: key.n, address, async sign(transaction) {
    f.signCalls++;
    const state = await f.state(), item = [...state.files, state.manifest].find(item => item.intent?.dataRoot === transaction.data_root && !item.signedTx);
    assert(item?.intent, 'durable sign intent exists BEFORE signer invocation');
    assert.equal(item.intent.rewardWinston, transaction.reward);
    if (f.onSign) await f.onSign(transaction);
    await crypto.transactions.sign(transaction, key); return transaction.toJSON();
  } };
  f.fetcher = async (input, options) => {
    const url = new URL(input), path = url.pathname;
    f.requests.push({ path, method: options.method });
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.equal(url.origin, NODE); assert(!options.headers?.Authorization);
    if (options.method === 'POST') {
      const raw = JSON.parse(options.body), state = await f.state();
      const items = [...state.files, state.manifest];
      if (path === '/tx') {
        const item = items.find(item => item.signedTx?.id === raw.id);
        assert(item, 'exact signed transaction is durable BEFORE broadcast');
        assert.deepEqual(raw, { ...item.signedTx, data: '' });
        assert.equal(raw.data, '', 'no unsafe inline-only one-chunk shortcut');
        if (!f.stored.has(raw.id)) f.stored.set(raw.id, { header: raw, chunks: new Map() });
        else assert.deepEqual(f.stored.get(raw.id).header, raw, 'resume reuses identical signed header');
        f.posts.push({ path, id: raw.id });
        if (f.onPost) await f.onPost(path, raw);
        if (f.failHeaderOnce) { f.failHeaderOnce = false; throw Error('lost synthetic header acknowledgement'); }
        return response('', 200);
      }
      if (path === '/chunk') {
        const item = items.find(item => item.signedTx?.data_root === raw.data_root);
        assert(item, 'signed Merkle root is durable before chunk POST');
        const stored = f.stored.get(item.signedTx.id); assert(stored);
        assert.equal(raw.data_size, stored.header.data_size);
        // Native chunks are addressed by data_root, not transaction ID: the
        // index and fallback may intentionally contain the same payload bytes.
        for (const sameRoot of f.stored.values()) if (sameRoot.header.data_root === raw.data_root)
          sameRoot.chunks.set(Number(raw.offset), Buffer.from(raw.chunk, 'base64url'));
        f.posts.push({ path, id: item.signedTx.id, offset: raw.offset });
        if (f.onPost) await f.onPost(path, raw);
        if (f.failChunkOnce) { f.failChunkOnce = false; throw Error('lost synthetic chunk acknowledgement'); }
        return response('', 200);
      }
      throw Error('unexpected synthetic POST');
    }
    if (path === '/info') return response({ network: f.wrongNetwork ? 'other' : 'arweave.N.1' });
    if (path.startsWith('/price/')) return response(f.price);
    if (path === '/tx_anchor') return response('b'.repeat(64));
    if (path === `/wallet/${address}/balance`) return response(f.balance);
    const id = path.split('/').find(part => /^[A-Za-z0-9_-]{43}$/.test(part)), stored = f.stored.get(id);
    if (!stored) return response('', 404);
    if (path.endsWith('/status')) return f.confirmations < 1 ? response('', 202) : response({
      number_of_confirmations: f.confirmations, block_height: 101, block_indep_hash: 'c'.repeat(64),
    });
    if (path === `/tx/${id}`) return response(f.corruptHeader ? { ...stored.header, reward: '999' } : stored.header);
    if (f.onlyNativeData && path === `/raw/${id}`) return response('', 404);
    if (f.onlyNativeData && path === `/${id}`) {
      if (f.onlyNativeData === 'fetch-throws') throw TypeError('fetch failed: redirect is not allowed');
      return response('', 302);
    }
    const bytes = Buffer.concat([...stored.chunks].sort(([a], [b]) => a - b).map(([, value]) => value));
    if (!f.rawAvailable || bytes.length !== Number(stored.header.data_size)) return response('', 404);
    const received = f.corruptBytes ? Buffer.alloc(bytes.length, 7) : bytes;
    if (path.endsWith('/data')) return response(received.toString('base64url'));
    if (path === `/raw/${id}` || path === `/${id}`) return response(received);
    throw Error('unexpected synthetic GET');
  };
  f.run = (mode = 'upload', options = {}) => publishNative(release, { mode, journal, node: NODE,
    maximum: '100', signer: f.signer, crypto, fetcher: f.fetcher, ...options });
  return f;
}

test('keyless native plan and quote include every payload and exact v0.2 manifest size', async t => {
  const f = await fixture(t), plan = nativePlan(f.release);
  assert.equal(plan.transport, 'native-arweave-http'); assert.equal(plan.mandatoryBundler, false);
  assert.equal(plan.signingLocation, 'owner-local-persistent-disk');
  assert.equal(plan.files[0].contentType, 'text/html; charset=utf-8');
  const quote = await nativeQuote(f.release, { node: NODE, maximum: '40', fetcher: f.fetcher });
  assert.equal(quote.items.length, 4); assert.equal(quote.totalRewardWinston, '40'); assert.equal(quote.withinBudget, true);
  assert.equal(quote.items.at(-1).bytes, plan.manifestBytes); assert.equal(f.signCalls, 0); assert.equal(f.posts.length, 0);
  assert(f.requests.every(item => item.method === 'GET'));
  assert.equal((await nativeQuote(f.release, { node: NODE, maximum: '39', fetcher: f.fetcher })).withinBudget, false);
  assert.throws(() => nativePlan({ ...f.release, manifest: { ...f.release.manifest, profile: 'portable-funded-mainnet' } }), /release_profile/);
});

test('native upload durably signs before POST and delivers every single/multiple chunk before verified manifest', async t => {
  const f = await fixture(t, { large: true }), result = await f.run();
  assert.equal(result.status, 'NATIVE_TRANSACTIONS_VERIFIED'); assert.equal(result.confirmedAndVerified, 4);
  assert.equal(result.signedRewardWinston, '40'); assert.equal(result.arnsTargetChanged, false);
  assert.equal(result.browserPathAndMimeVerified, false); assert.equal(f.signCalls, 4);
  const state = await f.state();
  assert.equal(f.posts.filter(post => post.path === '/chunk').length, 5, 'one chunk per small file + two for 300000-byte file + manifest');
  for (const item of [...state.files, state.manifest]) {
    assert(item.verification.confirmed && item.verification.bytesVerified);
    assert.equal(item.signedTx.id, await crypto.utils.bufferTob64Url(await crypto.crypto.hash(Buffer.from(item.signedTx.signature, 'base64url'))));
    assert.equal(await crypto.transactions.verify(crypto.transactions.fromRaw(item.signedTx)), true);
    assert(!JSON.stringify(item).includes(key.d));
  }
  const manifest = JSON.parse(Buffer.from(state.manifest.signedTx.data, 'base64url'));
  for (const item of state.files) assert.equal(manifest.paths[item.path].id, item.signedTx.id);
  assert.equal(manifest.fallback.id, state.files[1].signedTx.id);
  assert.equal(f.posts.at(-2).id, state.manifest.signedTx.id, 'manifest follows payload verification');
  const before = f.posts.length;
  const check = await f.run('check', { signer: undefined });
  assert.equal(check.status, 'NATIVE_TRANSACTIONS_VERIFIED'); assert.equal(f.posts.length, before); assert.equal(f.signCalls, 4);
});

test('lost header or chunk acknowledgement resumes original signed ID and bytes without replacement spend', async t => {
  for (const failure of ['failHeaderOnce', 'failChunkOnce']) {
    const f = await fixture(t); f[failure] = true;
    await assert.rejects(f.run(), /native_network_unavailable/);
    const first = (await f.state()).files[0].signedTx;
    assert.equal(f.signCalls, 1);
    const result = await f.run('resume');
    assert.equal(result.status, 'NATIVE_TRANSACTIONS_VERIFIED'); assert.equal(f.signCalls, 4);
    assert.deepEqual((await f.state()).files[0].signedTx, first);
    assert.equal(new Set(f.posts.filter(post => post.path === '/tx').map(post => post.id)).size, 4);
    assert.equal(result.signedRewardWinston, '40');
  }
});

test('confirmation and exact raw data gate the manifest; no manifest is signed on acceptance alone', async t => {
  for (const missing of ['confirmations', 'rawAvailable']) {
    const f = await fixture(t); f[missing] = missing === 'confirmations' ? 0 : false;
    const pending = await f.run();
    assert.equal(pending.status, 'AWAITING_CONFIRMATION_OR_DATA'); assert.equal(pending.manifestId, null);
    assert.equal(f.signCalls, 3); assert(!(await f.state()).manifest.intent);
    f[missing] = missing === 'confirmations' ? 1 : true;
    const complete = await f.run('resume'); assert.equal(complete.status, 'NATIVE_TRANSACTIONS_VERIFIED'); assert.equal(f.signCalls, 4);
  }
});

test('explicit same-node continuation replays all signed chunks when an ACKed node lost bytes', async t => {
  const f = await fixture(t, { large: true });
  assert.equal((await f.run()).status, 'NATIVE_TRANSACTIONS_VERIFIED');
  const before = await f.state(), original = before.files.map(item => item.signedTx.id), posts = f.posts.length;
  for (const stored of f.stored.values()) stored.chunks.clear();
  const complete = await f.run('replay', { signer: undefined });
  assert.equal(complete.status, 'NATIVE_TRANSACTIONS_VERIFIED'); assert.equal(f.signCalls, 4);
  assert.deepEqual((await f.state()).files.map(item => item.signedTx.id), original);
  assert.equal(f.posts.slice(posts).filter(post => post.path === '/tx').length, 3, 'shared index/fallback data root needs one exact replay');
  assert.equal(f.posts.slice(posts).filter(post => post.path === '/chunk').length, 4, 'every chunk of each missing data root is replayed');
});

test('keyless replay repairs an interrupted signed payload without price, GitHub, key or new manifest signature', async t => {
  const f = await fixture(t); f.failChunkOnce = true;
  await assert.rejects(f.run(), /native_network_unavailable/);
  const original = (await f.state()).files[0].signedTx.id, fetcher = f.fetcher;
  f.fetcher = async (url, options) => {
    assert(!url.includes('github') && !url.includes('/price/') && !url.includes('/wallet/') && !url.includes('/tx_anchor'));
    return fetcher(url, options);
  };
  const pending = await f.run('replay', { signer: undefined });
  assert.equal(pending.status, 'AWAITING_CONFIRMATION_OR_DATA'); assert.equal(f.signCalls, 1);
  const state = await f.state(); assert.equal(state.files[0].signedTx.id, original); assert(state.files[0].verification.bytesVerified);
  assert.equal(state.files[1].signedTx, undefined); assert.equal(state.manifest.signedTx, undefined);
});

test('native encoded-data fallback works after a missing raw route and denied root redirect', async t => {
  for (const behavior of [true, 'fetch-throws']) {
    const f = await fixture(t); f.onlyNativeData = behavior;
    assert.equal((await f.run()).status, 'NATIVE_TRANSACTIONS_VERIFIED');
    assert(f.requests.some(request => request.path.endsWith('/data')));
  }
});

test('unknown signing result persists intent and permanently blocks automatic re-sign or upload', async t => {
  const f = await fixture(t);
  f.onSign = async transaction => { await crypto.transactions.sign(transaction, key); throw Error('synthetic signer disconnected after signing'); };
  await assert.rejects(f.run(), /signature_result_unknown/);
  const state = await f.state(); assert(state.files[0].intent); assert.equal(state.files[0].signedTx, undefined);
  assert.equal(f.posts.length, 0); assert.equal(f.signCalls, 1);
  f.onSign = null;
  await assert.rejects(f.run('resume'), /signature_result_unknown/);
  assert.equal(f.signCalls, 1); assert.equal(f.posts.length, 0);
  const check = await f.run('check', { signer: undefined }); assert.equal(check.status, 'AWAITING_CONFIRMATION_OR_DATA');
  assert.equal(check.reservedRewardWinston, '10'); assert.equal(check.signedRewardWinston, '0');
});

test('aggregate AR cap, balance and network fail before signing, with no automatic top-up', async t => {
  for (const failure of ['budget', 'balance', 'network']) {
    const f = await fixture(t);
    if (failure === 'balance') f.balance = '39';
    if (failure === 'network') f.wrongNetwork = true;
    await assert.rejects(f.run('upload', failure === 'budget' ? { maximum: '39' } : {}), /reward_budget_exceeded|insufficient_ar_balance|wrong_network/);
    assert.equal(f.signCalls, 0); assert.equal(f.posts.length, 0);
  }
  const f = await fixture(t); f.price = '900719925474099312345'; f.balance = '999999999999999999999999';
  const quote = await nativeQuote(f.release, { node: NODE, maximum: '3602879701896397249380', fetcher: f.fetcher });
  assert.equal(quote.totalRewardWinston, '3602879701896397249380'); assert.equal(quote.withinBudget, true);
});

test('price changes before an unsigned transaction cannot exceed the original owner cap', async t => {
  const f = await fixture(t);
  f.onPost = async () => { f.price = '1000'; };
  await assert.rejects(f.run(), /reward_budget_exceeded/);
  assert.equal(f.signCalls, 1); assert.equal((await f.state()).files[1].intent, undefined);
  await assert.rejects(f.run('resume', { maximum: '10000' }), /journal_mismatch/);
});

test('corrupt public bytes or header and changed local payloads cannot complete or sign a manifest', async t => {
  for (const failure of ['corruptBytes', 'corruptHeader', 'localPayload']) {
    const f = await fixture(t);
    if (failure === 'localPayload') await writeFile(join(f.release.root, f.release.files[0].path), 'changed');
    else f[failure] = true;
    await assert.rejects(f.run(), /public_bytes_mismatch|public_header_mismatch|release_file_changed/);
    assert(!(await f.state()).manifest.intent);
  }
});

test('tampered persisted signed transaction is rejected before retransmission', async t => {
  for (const field of ['reward', 'unexpectedPrivateField', 'tagExtra']) {
    const f = await fixture(t); f.failHeaderOnce = true;
    await assert.rejects(f.run(), /native_network_unavailable/);
    const state = await f.state();
    if (field === 'tagExtra') state.files[0].signedTx.tags[0].unexpected = 'must-never-broadcast';
    else state.files[0].signedTx[field] = '11';
    await writeFile(join(f.journal, 'journal.json'), JSON.stringify(state));
    const before = f.posts.length;
    await assert.rejects(f.run('replay'), /signed_transaction_invalid/);
    assert.equal(f.posts.length, before); assert.equal(f.signCalls, 1);
  }
});

test('one kernel-held writer excludes a competing publisher while owner signing is pending', async t => {
  const f = await fixture(t); let releaseSigner, started;
  const entered = new Promise(resolve => { started = resolve; }), paused = new Promise(resolve => { releaseSigner = resolve; });
  f.onSign = async () => { started(); await paused; };
  const first = f.run(); await entered;
  try { await assert.rejects(f.run('replay'), /backend_writer_already_active/); }
  finally { releaseSigner(); }
  assert.equal((await first).status, 'NATIVE_TRANSACTIONS_VERIFIED'); assert.equal(f.signCalls, 4);
});

test('private owner file stays outside release and journal and is never logged or serialized', async t => {
  const f = await fixture(t), path = join(f.root, 'synthetic-owner.json');
  await writeFile(path, JSON.stringify(key), { mode: 0o600 });
  const signer = await localFileSigner(path, crypto, [f.release.root, f.journal]);
  assert.equal(signer.address, address); assert(!JSON.stringify(signer).includes(key.d));
  await chmod(path, 0o644);
  await assert.rejects(localFileSigner(path, crypto), /private_key_file_required/);
  await chmod(path, 0o600);
  const link = join(f.root, 'owner-link'); await symlink(path, link);
  await assert.rejects(localFileSigner(link, crypto), /private_key_file_required/);
  await assert.rejects(localFileSigner(path, crypto, [f.root]), /key_must_be_outside/);
});

test('CLI requires explicit local budget and journal and forbids native upload on ephemeral Actions', () => {
  assert.equal(nativeCliArguments(['--plan'], {}).mode, 'plan');
  const args = ['--upload', '--journal', '/owner/persistent-journal'];
  assert.throws(() => nativeCliArguments(args, {}), /explicit_upload_confirmation/);
  const env = { NATIVE_UPLOAD_CONFIRM: 'upload-native-arweave', NATIVE_MAX_REWARD_WINSTON: '100' };
  assert.equal(nativeCliArguments(args, env).maximum, '100');
  assert.throws(() => nativeCliArguments(args, { ...env, GITHUB_ACTIONS: 'true' }), /ephemeral_actions_upload_forbidden/);
  assert.throws(() => nativeCliArguments(['--resume'], env), /persistent_journal_required/);
  assert.throws(() => nativeCliArguments(['--quote', '--release', 'x', '--release', 'y'], {}), /invalid_arguments/);
  for (const value of ['-1', '1.5', '01', '', '1e12', 10]) assert.throws(() => nativeWinston(value), /invalid_winston/);
  for (const node of ['http://native.example', 'https://native.example/', 'https://user:pass@native.example', 'https://native.example:8443']) assert.throws(() => nativeNode(node), /invalid_node/);
});

test('native network reads reject redirects and oversized bodies and never follow alternate hosts', async () => {
  await assert.rejects(nativeRequest(NODE, '/info', { fetcher: async () => response('', 302) }), /redirect_denied/);
  await assert.rejects(nativeRequest(NODE, '/info', { limit: 16, fetcher: async () => response('x'.repeat(17)) }), /response_too_large/);
  await assert.rejects(nativeRequest(NODE, '//attacker.example', {}), /invalid_path/);
});
