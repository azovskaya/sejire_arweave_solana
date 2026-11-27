/** Native Arweave static-site publication from an exact accepted CI pack.
 * Owner-operated, persistent local journal. No bundler, service account, hosted
 * executor, automatic top-up or ArNS mutation. Plan and quote need no key.
 */
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireWriter } from '../apps/sponsor/linux-writer.mjs';
import { ACCEPTED_DIR, ARTIFACT_NAME, MAX_RELEASE_BYTES, checkPermawebEvidence,
  digest, requireValue, verifyAcceptedReleaseFromArtifact, verifyRelease } from './permaweb-release.mjs';
import { INDEPENDENT_PROFILE } from './static-release-profile.mjs';
import { verifyPathManifest } from './verify-arns-published.mjs';

const TX = /^[A-Za-z0-9_-]{43}$/;
const SOURCE = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const UINT = /^(0|[1-9][0-9]{0,39})$/;
const JOURNAL = 'journal.json';
const MAX_STATE_BYTES = MAX_RELEASE_BYTES * 4 + 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
const ensure = (ok, code) => requireValue(ok, `native_${code}`);
const timestamp = () => new Date().toISOString();
export function nativeWinston(value) { ensure(typeof value === 'string' && UINT.test(value), 'invalid_winston'); return BigInt(value); }
export function nativeNode(value = 'https://arweave.net') {
  let url; try { url = new URL(value); } catch { throw Error('native_invalid_node'); }
  ensure(url.origin === value && url.protocol === 'https:' && !url.username && !url.password &&
    !url.port && /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/.test(url.hostname), 'invalid_node');
  return value;
}
function contentType(path) { const result = MIME[extname(path).toLowerCase()]; ensure(result, 'unsupported_content_type'); return result; }
function pathManifest(files, ids) {
  const paths = Object.fromEntries(files.map((file, index) => [file.path, { id: ids[index] }]));
  const result = { manifest: 'arweave/paths', version: '0.2.0', index: { path: 'index.html' },
    paths, fallback: { id: paths['404.html'].id } };
  verifyPathManifest(result, files); return result;
}
export function nativePlan(release) {
  ensure(release.manifest.profile === INDEPENDENT_PROFILE && SOURCE.test(release.manifest.sourceCommit), 'release_profile_mismatch');
  const placeholder = pathManifest(release.files, release.files.map(() => 'x'.repeat(43)));
  const files = release.files.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256, contentType: contentType(file.path) }));
  return { schema: 'sejire/native-publication-plan/v1', sourceCommit: release.manifest.sourceCommit,
    releaseManifestSha256: release.manifestSha256, profile: INDEPENDENT_PROFILE, storageNetwork: 'arweave.N.1',
    transport: 'native-arweave-http', funding: 'owner-ar-wallet', files,
    manifestBytes: Buffer.byteLength(JSON.stringify(placeholder)), mandatoryBundler: false,
    mandatorySejireService: false, signingLocation: 'owner-local-persistent-disk', arnsTargetChange: false };
}
async function bounded(response, limit) {
  const declared = response.headers.get('content-length');
  if (!(declared === null || /^\d+$/.test(declared) && Number(declared) <= limit)) {
    await response.body?.cancel().catch(() => {}); throw Error('native_response_too_large');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), parts = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break;
      size += part.value.length; ensure(size <= limit, 'response_too_large'); parts.push(part.value); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(parts, size);
}
export async function nativeRequest(node, path, { fetcher = fetch, body, limit = 16384 } = {}) {
  nativeNode(node); ensure(path.startsWith('/') && !path.startsWith('//'), 'invalid_path');
  let response;
  try { response = await fetcher(node + path, { method: body === undefined ? 'GET' : 'POST',
    redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15000),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body }) }); }
  catch { throw Error('native_network_unavailable'); }
  if (response.redirected || response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {}); throw Error('native_redirect_denied');
  }
  // Write acknowledgements and non-200 error pages are not payloads.
  if (body !== undefined || response.status !== 200) {
    await response.body?.cancel().catch(() => {}); return { status: response.status, bytes: Buffer.alloc(0) };
  }
  return { status: response.status, bytes: await bounded(response, limit) };
}
function json(bytes) { try { return JSON.parse(bytes.toString('utf8')); } catch { throw Error('native_invalid_json'); } }
async function network(node, fetcher) {
  const response = await nativeRequest(node, '/info', { fetcher });
  ensure(response.status === 200 && json(response.bytes).network === 'arweave.N.1', 'wrong_network');
}
async function price(node, bytes, fetcher) {
  const response = await nativeRequest(node, `/price/${bytes}`, { fetcher, limit: 128 });
  ensure(response.status === 200, 'price_unavailable'); const reward = response.bytes.toString('utf8').trim();
  ensure(nativeWinston(reward) > 0n, 'invalid_reward'); return reward;
}
export async function nativeQuote(release, { node = 'https://arweave.net', maximum = '0', fetcher = fetch } = {}) {
  node = nativeNode(node); const limit = nativeWinston(maximum), plan = nativePlan(release);
  await network(node, fetcher);
  const items = [];
  for (const file of [...plan.files, { path: '@manifest', bytes: plan.manifestBytes }]) {
    items.push({ path: file.path, bytes: file.bytes, rewardWinston: await price(node, file.bytes, fetcher) });
  }
  const total = items.reduce((sum, item) => sum + nativeWinston(item.rewardWinston), 0n);
  return { schema: 'sejire/native-publication-quote/v1', sourceCommit: plan.sourceCommit,
    releaseManifestSha256: plan.releaseManifestSha256, quotedAt: timestamp(), node, items,
    totalRewardWinston: total.toString(), maximumRewardWinston: maximum, withinBudget: total <= limit,
    signedRewardCapEnforced: true, autoTopUp: false, writesPerformed: false };
}
async function readJsonFile(path, limit = MAX_STATE_BYTES) {
  const info = await lstat(path); ensure(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= limit, 'unsafe_local_file');
  return json(await readFile(path));
}
async function persist(directory, state) {
  const path = join(directory, `.next-${randomBytes(16).toString('hex')}.json`);
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(state) + '\n'); await file.sync(); } finally { await file.close(); }
  await rename(path, join(directory, JOURNAL));
  const folder = await open(directory, 'r'); try { await folder.sync(); } finally { await folder.close(); }
}
async function journalDirectory(path, resume) {
  ensure(typeof path === 'string' && path.length > 0, 'persistent_journal_required');
  const target = resolve(path);
  if (!resume) await mkdir(target, { mode: 0o700 });
  const info = await lstat(target);
  ensure(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, 'private_journal_directory_required');
  ensure(await realpath(target) === target, 'journal_symlink_denied');
  return target;
}
export async function nativeCrypto() {
  const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
  const module = require('arweave/node'); const Arweave = module.default ?? module;
  return Arweave.init({ host: 'arweave.net', protocol: 'https', port: 443 });
}
export async function localFileSigner(path, crypto, forbiddenDirectories = []) {
  ensure(typeof path === 'string' && path.length > 0, 'owner_key_file_required');
  const before = await lstat(path), actual = await realpath(path);
  ensure(before.isFile() && !before.isSymbolicLink(), 'private_key_file_required');
  for (const directory of forbiddenDirectories) {
    const canonical = await realpath(directory).catch(error => { if (error.code === 'ENOENT') return resolve(directory); throw error; });
    ensure(actual !== canonical && !actual.startsWith(canonical + '/'), 'key_must_be_outside_release_and_journal');
  }
  const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
  let key;
  try {
    const info = await file.stat();
    ensure(info.isFile() && info.nlink === 1 && info.size <= 16384 && (info.mode & 0o077) === 0 &&
      info.ino === before.ino && info.dev === before.dev, 'private_key_file_required');
    const buffer = Buffer.alloc(16385), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    ensure(bytesRead === info.size && bytesRead <= 16384, 'private_key_file_required');
    key = json(buffer.subarray(0, bytesRead));
  } finally { await file.close(); }
  ensure(key?.kty === 'RSA' && key.e === 'AQAB' && typeof key.n === 'string' && Buffer.from(key.n, 'base64url').length === 512 &&
    ['d', 'p', 'q', 'dp', 'dq', 'qi'].every(name => typeof key[name] === 'string' && /^[A-Za-z0-9_-]+$/.test(key[name])), 'invalid_owner_key');
  return { publicKey: key.n, address: await crypto.wallets.ownerToAddress(key.n),
    async sign(transaction) { await crypto.transactions.sign(transaction, key); return transaction.toJSON(); } };
}
function tags(release, item) {
  return [{ name: 'Content-Type', value: item.contentType }, { name: 'App-Name', value: 'SEJIRE' },
    { name: 'App-Feature', value: 'Static-Site' }, { name: 'Source-Commit', value: release.manifest.sourceCommit },
    { name: 'Release-Manifest-SHA256', value: release.manifestSha256 }, { name: 'Path', value: item.path }];
}
function header(raw) { const { data: _data, data_tree: _tree, ...value } = raw; return value; }
async function verifySigned(crypto, release, state, item, bytes) {
  const raw = item.signedTx;
  const fields = ['format', 'id', 'last_tx', 'owner', 'tags', 'target', 'quantity', 'data', 'data_size', 'data_root', 'reward', 'signature'];
  ensure(raw && !Array.isArray(raw) && Object.keys(raw).every(field => fields.includes(field) || field === 'data_tree') &&
    fields.every(field => Object.hasOwn(raw, field)) &&
    (!('data_tree' in raw) || raw.data_tree === undefined || Array.isArray(raw.data_tree) && raw.data_tree.length === 0) &&
    Array.isArray(raw.tags) && raw.tags.length === 6 && raw.tags.every(tag => tag && Object.keys(tag).sort().join(',') === 'name,value' &&
      typeof tag.name === 'string' && typeof tag.value === 'string' && tag.name.length <= 128 && tag.value.length <= 512) &&
    /^[A-Za-z0-9_-]{683}$/.test(raw.owner) && /^[A-Za-z0-9_-]{683}$/.test(raw.signature), 'signed_transaction_invalid');
  ensure(raw && typeof raw === 'object' && raw.format === 2 && TX.test(raw.id) && raw.target === '' && raw.quantity === '0' &&
    raw.data_size === String(bytes.length) && raw.reward === item.intent?.rewardWinston && raw.last_tx === item.intent?.anchor &&
    typeof raw.owner === 'string' && typeof raw.data === 'string' && /^[A-Za-z0-9_-]*$/.test(raw.data), 'signed_transaction_invalid');
  ensure(Buffer.from(raw.data, 'base64url').equals(bytes) && digest(bytes) === item.sha256, 'signed_payload_mismatch');
  const transaction = crypto.transactions.fromRaw(raw);
  ensure(await crypto.wallets.ownerToAddress(raw.owner) === state.ownerAddress && await crypto.transactions.verify(transaction), 'signature_invalid');
  const actualTags = transaction.tags.map(tag => ({ name: tag.get('name', { decode: true, string: true }), value: tag.get('value', { decode: true, string: true }) }));
  ensure(JSON.stringify(actualTags) === JSON.stringify(tags(release, item)), 'signed_tags_mismatch');
  const rebuilt = crypto.transactions.fromRaw({ ...raw, data_root: '' }); await rebuilt.prepareChunks(bytes);
  ensure(raw.data_root === rebuilt.data_root && raw.data_root === item.intent.dataRoot, 'data_root_mismatch');
  await transaction.prepareChunks(bytes);
  ensure(transaction.chunks?.chunks.length > 0 && transaction.data_root === raw.data_root, 'chunks_invalid');
  return transaction;
}
async function payload(release, state, index) {
  if (index === state.files.length) {
    ensure(state.files.every(item => item.signedTx && item.verification?.confirmed === true && item.verification?.bytesVerified === true), 'manifest_files_not_verified');
    return Buffer.from(JSON.stringify(pathManifest(release.files, state.files.map(item => item.signedTx.id))));
  }
  const file = release.files[index], path = join(release.root, file.path), info = await lstat(path);
  ensure(info.isFile() && !info.isSymbolicLink() && info.size === file.bytes, 'release_file_changed');
  const bytes = await readFile(path); ensure(digest(bytes) === file.sha256, 'release_file_changed'); return bytes;
}
function allItems(state) { return [...state.files, state.manifest]; }
function reservedCost(state) { return allItems(state).reduce((sum, item) => sum + (item.intent ? nativeWinston(item.intent.rewardWinston) : 0n), 0n); }
async function ensureSigned({ release, state, item, bytes, reward, signer, crypto, directory, node, fetcher }) {
  if (item.signedTx) return verifySigned(crypto, release, state, item, bytes);
  ensure(!item.intent, 'signature_result_unknown_review_journal');
  ensure(signer && signer.address === state.ownerAddress && typeof signer.sign === 'function', 'owner_signer_required');
  ensure(await crypto.wallets.ownerToAddress(signer.publicKey) === state.ownerAddress, 'owner_changed');
  // Each signature uses a current native price; a delayed owner continuation
  // must not silently sign an old quote or increase the approved aggregate cap.
  reward = await price(node, bytes.length, fetcher);
  ensure(nativeWinston(reward) > 0n && reservedCost(state) + nativeWinston(reward) <= nativeWinston(state.maximumRewardWinston), 'reward_budget_exceeded');
  const response = await nativeRequest(node, '/tx_anchor', { fetcher, limit: 128 });
  const anchor = response.bytes.toString('utf8').trim();
  ensure(response.status === 200 && /^[A-Za-z0-9_-]+$/.test(anchor) && [43, 64].includes(anchor.length), 'anchor_unavailable');
  const transaction = await crypto.createTransaction({ data: bytes, owner: signer.publicKey, reward, last_tx: anchor });
  for (const tag of tags(release, item)) transaction.addTag(tag.name, tag.value);
  await transaction.prepareChunks(bytes);
  item.intent = { createdAt: timestamp(), rewardWinston: reward, anchor, dataRoot: transaction.data_root };
  await persist(directory, state); // Durable sign-intent BEFORE calling the signer.
  let signed;
  try { signed = await signer.sign(transaction); } catch { throw Error('native_signature_result_unknown_review_journal'); }
  item.signedTx = typeof signed?.toJSON === 'function' ? signed.toJSON() : signed;
  const verified = await verifySigned(crypto, release, state, item, bytes);
  await persist(directory, state); // Exact signed bytes durable BEFORE any POST.
  return verified;
}
async function submit({ node, fetcher, transaction, item, directory, state }) {
  // Same ID and signature on every explicit continuation. Never use the SDK's
  // inline-one-chunk shortcut or its automatic upload retry/signing machinery.
  // An ACK is not durable storage evidence. Each explicit continuation replays
  // the same header and ALL chunks if current public bytes remain unavailable.
  item.delivery = { node, headerAccepted: false, nextChunk: 0 };
  const response = await nativeRequest(node, '/tx', { fetcher, body: JSON.stringify({ ...item.signedTx, data: '' }) });
  ensure([200, 202, 208].includes(response.status), 'upload_pending_resume_same_journal');
  item.delivery.headerAccepted = true; await persist(directory, state);
  for (let index = 0; index < transaction.chunks.chunks.length; index++) {
    const response = await nativeRequest(node, '/chunk', { fetcher, body: JSON.stringify(transaction.getChunk(index, transaction.data)) });
    ensure([200, 202, 208].includes(response.status), 'upload_pending_resume_same_journal');
    item.delivery.nextChunk = index + 1; await persist(directory, state);
  }
}
async function deliverAndVerify({ node, fetcher, transaction, item, directory, state, bytes }) {
  // Read current network evidence before deciding whether retransmission is
  // necessary. Cached local success cannot suppress a missing-data recovery.
  item.verification = await readback({ node, fetcher, item, bytes });
  if (!item.verification.confirmed || !item.verification.bytesVerified) {
    await submit({ node, fetcher, transaction, item, directory, state });
    item.verification = await readback({ node, fetcher, item, bytes });
  }
}
async function readback({ node, fetcher, item, bytes }) {
  const id = item.signedTx.id;
  const status = await nativeRequest(node, `/tx/${id}/status`, { fetcher });
  if (status.status !== 200) return { checkedAt: timestamp(), node, confirmed: false, bytesVerified: false };
  const proof = json(status.bytes);
  ensure(Number.isSafeInteger(proof.number_of_confirmations) && proof.number_of_confirmations >= 1 &&
    Number.isSafeInteger(proof.block_height) && proof.block_height >= 0 && typeof proof.block_indep_hash === 'string' &&
    /^[A-Za-z0-9_-]{64}$/.test(proof.block_indep_hash), 'confirmation_proof_invalid');
  const metadata = await nativeRequest(node, `/tx/${id}`, { fetcher, limit: Math.ceil(bytes.length * 4 / 3) + 32768 });
  if (metadata.status !== 200) return { checkedAt: timestamp(), node, confirmed: true, bytesVerified: false };
  const actual = json(metadata.bytes);
  ensure(Object.entries(header(item.signedTx)).every(([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value)), 'public_header_mismatch');
  for (const [route, encoded] of [[`/raw/${id}`, false], [`/${id}`, false], [`/tx/${id}/data`, true]]) {
    let response;
    try { response = await nativeRequest(node, route, { fetcher, limit: encoded ? Math.ceil(bytes.length * 4 / 3) + 4 : bytes.length + 1 }); }
    catch (error) {
      if (['native_network_unavailable', 'native_redirect_denied'].includes(error.message)) continue;
      throw error;
    }
    if (response.status !== 200) continue;
    let received = response.bytes;
    if (encoded) { const text = received.toString('utf8').trim(); ensure(/^[A-Za-z0-9_-]+$/.test(text), 'public_bytes_mismatch'); received = Buffer.from(text, 'base64url'); }
    ensure(received.equals(bytes) && digest(received) === item.sha256, 'public_bytes_mismatch');
    return { checkedAt: timestamp(), node, confirmed: true, confirmations: proof.number_of_confirmations,
      blockHeight: proof.block_height, blockHash: proof.block_indep_hash, bytesVerified: true, sha256: item.sha256 };
  }
  return { checkedAt: timestamp(), node, confirmed: true, bytesVerified: false };
}
function validateState(state, release, maximum) {
  const plan = nativePlan(release);
  ensure(state?.schema === 'sejire/native-publication-journal/v1' && state.sourceCommit === plan.sourceCommit &&
    state.releaseManifestSha256 === plan.releaseManifestSha256 && TX.test(state.ownerAddress) &&
    state.maximumRewardWinston === maximum && Array.isArray(state.files) && state.files.length === plan.files.length, 'journal_mismatch');
  ensure(nativeWinston(maximum) > 0n, 'positive_reward_budget_required');
  for (let index = 0; index < plan.files.length; index++) {
    const actual = state.files[index], expected = plan.files[index];
    ensure(actual && ['path', 'bytes', 'sha256', 'contentType'].every(key => actual[key] === expected[key]), 'journal_file_mismatch');
  }
  ensure(state.manifest?.path === '@manifest' && state.manifest.contentType === 'application/x.arweave-manifest+json', 'journal_manifest_mismatch');
  for (const item of allItems(state)) {
    if (item.intent) ensure(nativeWinston(item.intent.rewardWinston) > 0n &&
      /^[A-Za-z0-9_-]+$/.test(item.intent.anchor) && [43, 64].includes(item.intent.anchor.length) && TX.test(item.intent.dataRoot), 'journal_intent_invalid');
    if (item.delivery) ensure(typeof item.delivery.headerAccepted === 'boolean' && Number.isSafeInteger(item.delivery.nextChunk) &&
      item.delivery.nextChunk >= 0 && item.delivery.nextChunk <= 128, 'journal_delivery_invalid');
  }
  ensure(reservedCost(state) <= nativeWinston(maximum), 'reward_budget_exceeded');
}
function result(state) {
  const items = allItems(state), verified = item => item.signedTx && item.verification?.confirmed === true && item.verification?.bytesVerified === true;
  const complete = items.every(verified);
  return { schema: 'sejire/native-publication-result/v1', status: complete ? 'NATIVE_TRANSACTIONS_VERIFIED' : 'AWAITING_CONFIRMATION_OR_DATA',
    sourceCommit: state.sourceCommit, releaseManifestSha256: state.releaseManifestSha256,
    ownerAddress: state.ownerAddress, manifestId: state.manifest.signedTx?.id ?? null,
    reservedRewardWinston: reservedCost(state).toString(),
    signedRewardWinston: items.reduce((sum, item) => sum + (item.signedTx ? nativeWinston(item.signedTx.reward) : 0n), 0n).toString(),
    maximumRewardWinston: state.maximumRewardWinston,
    confirmedAndVerified: items.filter(verified).length,
    totalTransactions: items.length, arnsTargetChanged: false, browserPathAndMimeVerified: false,
    note: 'Reward totals describe this journal, not actual wallet expenditure. Unknown signing intents reserve budget. HTTP acceptance is not finality; confirmed headers and exact raw bytes are required. Browser path/MIME and ArNS checks remain separate.' };
}
export async function publishNative(release, { mode = 'upload', journal, node = 'https://arweave.net', maximum,
  signer, crypto, fetcher = fetch } = {}) {
  ensure(['upload', 'resume', 'replay', 'check'].includes(mode), 'invalid_mode');
  ensure(nativeWinston(maximum) > 0n, 'positive_reward_budget_required');
  node = nativeNode(node); crypto ??= await nativeCrypto();
  const directory = await journalDirectory(journal, mode !== 'upload');
  const guard = await acquireWriter(join(directory, 'publication'));
  try {
    const plan = nativePlan(release);
    const state = mode === 'upload' ? {
      schema: 'sejire/native-publication-journal/v1', sourceCommit: plan.sourceCommit,
      releaseManifestSha256: plan.releaseManifestSha256, createdAt: timestamp(),
      ownerAddress: signer?.address, maximumRewardWinston: maximum,
      files: plan.files.map(file => ({ ...file })),
      manifest: { path: '@manifest', contentType: 'application/x.arweave-manifest+json' },
    } : await readJsonFile(join(directory, JOURNAL));
    validateState(state, release, maximum);
    if (mode === 'upload') await persist(directory, state);
    await network(node, fetcher);
    let quote;
    if (['upload', 'resume'].includes(mode)) {
      // A pending signing result is never repaired by producing another signature.
      ensure(allItems(state).every(item => !item.intent || item.signedTx), 'signature_result_unknown_review_journal');
      quote = allItems(state).some(item => !item.intent)
        ? await nativeQuote(release, { node, maximum, fetcher }) : { items: [] };
      const reserved = reservedCost(state), future = quote.items.reduce((sum, item, index) =>
        sum + (allItems(state)[index].intent ? 0n : nativeWinston(item.rewardWinston)), 0n);
      ensure(reserved + future <= nativeWinston(maximum), 'reward_budget_exceeded');
      if (future > 0n) {
        ensure(signer && signer.address === state.ownerAddress, 'owner_signer_required');
        const response = await nativeRequest(node, `/wallet/${state.ownerAddress}/balance`, { fetcher, limit: 128 });
        ensure(response.status === 200, 'balance_unavailable');
        const pending = allItems(state).reduce((sum, item) => sum +
          (item.intent && !item.verification?.confirmed ? nativeWinston(item.intent.rewardWinston) : 0n), 0n);
        ensure(nativeWinston(response.bytes.toString('utf8').trim()) >= future + pending, 'insufficient_ar_balance');
      }
    }
    for (let index = 0; index < state.files.length; index++) {
      const item = state.files[index], bytes = await payload(release, state, index);
      if (['upload', 'resume'].includes(mode)) {
        const transaction = await ensureSigned({ release, state, item, bytes, reward: quote.items[index]?.rewardWinston,
          signer, crypto, directory, node, fetcher });
        await deliverAndVerify({ node, fetcher, transaction, item, directory, state, bytes });
      } else if (item.signedTx) {
        const transaction = await verifySigned(crypto, release, state, item, bytes);
        if (mode === 'replay') await deliverAndVerify({ node, fetcher, transaction, item, directory, state, bytes });
        else item.verification = await readback({ node, fetcher, item, bytes });
      }
      await persist(directory, state);
    }
    if (!state.files.every(item => item.verification?.confirmed && item.verification?.bytesVerified)) return result(state);
    const bytes = await payload(release, state, state.files.length), item = state.manifest;
    ensure(!item.sha256 || item.sha256 === digest(bytes), 'manifest_changed');
    item.bytes = bytes.length; item.sha256 = digest(bytes);
    ensure(item.bytes === plan.manifestBytes, 'manifest_size_changed');
    if (['upload', 'resume'].includes(mode)) {
      const transaction = await ensureSigned({ release, state, item, bytes, reward: quote.items.at(-1)?.rewardWinston,
        signer, crypto, directory, node, fetcher });
      await deliverAndVerify({ node, fetcher, transaction, item, directory, state, bytes });
    } else if (item.signedTx) {
      const transaction = await verifySigned(crypto, release, state, item, bytes);
      if (mode === 'replay') await deliverAndVerify({ node, fetcher, transaction, item, directory, state, bytes });
      else item.verification = await readback({ node, fetcher, item, bytes });
    }
    await persist(directory, state);
    return result(state);
  } finally { guard.close(); }
}
export async function loadNativeRelease(directory, { verifyCI = false, fetcher = fetch, githubToken } = {}) {
  const root = resolve(directory), provenance = await readJsonFile(join(root, 'build-provenance.json'), 65536);
  ensure(provenance?.schema === 'sejire/permaweb-provenance/v1' && provenance.profile === INDEPENDENT_PROFILE &&
    provenance.artifact === ARTIFACT_NAME && SOURCE.test(provenance.sourceCommit) &&
    provenance.publishedByCommit === provenance.sourceCommit && HASH.test(provenance.releaseManifestSha256) && HASH.test(provenance.zipSha256), 'accepted_provenance_required');
  const release = await verifyRelease(root, provenance.sourceCommit, { provenance: true, expectedProfile: INDEPENDENT_PROFILE });
  ensure(release.manifestSha256 === provenance.releaseManifestSha256, 'accepted_provenance_mismatch');
  if (verifyCI) {
    const evidence = await checkPermawebEvidence({ sha: provenance.sourceCommit, runId: provenance.run, attempt: provenance.attempt }, { fetcher, token: githubToken });
    await verifyAcceptedReleaseFromArtifact(evidence, root, { fetcher, token: githubToken });
  }
  return release;
}
export function nativeCliArguments(args, env) {
  const mode = args[0]?.replace(/^--/, ''); ensure(['plan', 'quote', 'upload', 'resume', 'replay', 'check'].includes(mode), 'invalid_arguments');
  const options = { mode, directory: ACCEPTED_DIR, journal: undefined };
  const seen = new Set();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    ensure(['--release', '--journal'].includes(name) && typeof value === 'string' && value.length > 0 && !seen.has(name), 'invalid_arguments');
    seen.add(name); options[name === '--release' ? 'directory' : 'journal'] = value;
  }
  options.node = nativeNode(env.NATIVE_ARWEAVE_NODE || 'https://arweave.net');
  options.maximum = env.NATIVE_MAX_REWARD_WINSTON ?? '0'; nativeWinston(options.maximum);
  if (['upload', 'resume', 'replay', 'check'].includes(mode)) ensure(options.journal, 'persistent_journal_required');
  if (['upload', 'resume', 'replay'].includes(mode)) {
    ensure(env.GITHUB_ACTIONS !== 'true', 'ephemeral_actions_upload_forbidden');
    ensure(env.NATIVE_UPLOAD_CONFIRM === 'upload-native-arweave', 'explicit_upload_confirmation_required');
    ensure(nativeWinston(options.maximum) > 0n, 'positive_reward_budget_required');
  }
  return options;
}
export async function nativeMain(args, env) {
  const options = nativeCliArguments(args, env), writing = ['upload', 'resume'].includes(options.mode);
  const release = await loadNativeRelease(options.directory, { verifyCI: writing, ...(writing ? { githubToken: env.GH_TOKEN } : {}) });
  if (options.mode === 'plan') return nativePlan(release);
  if (options.mode === 'quote') return nativeQuote(release, options);
  const crypto = await nativeCrypto();
  const signer = writing && env.NATIVE_ARWEAVE_JWK_FILE ? await localFileSigner(env.NATIVE_ARWEAVE_JWK_FILE, crypto,
    [resolve(import.meta.dirname, '..'), options.directory, options.journal]) : undefined;
  return publishNative(release, { ...options, signer, crypto });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  nativeMain(process.argv.slice(2), process.env).then(report => {
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'AWAITING_CONFIRMATION_OR_DATA') process.exitCode = 3;
  }).catch(error => {
    console.error(error instanceof Error && /^(?:native_|permaweb_|release_|independent_|backend_)[a-z_]+$/.test(error.message)
      ? error.message : 'native_publication_failed_review_same_journal');
    process.exitCode = 1;
  });
}
