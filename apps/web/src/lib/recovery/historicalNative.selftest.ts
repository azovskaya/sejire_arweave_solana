import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import type { JWKInterface } from 'arweave/web/lib/wallet';
import { deriveKeysFromMnemonic } from '../crypto/keys';
import { encryptJson } from '../crypto/encrypt';
import { serializeEnvelope } from '../crypto/envelope';
import { emptyVault, putTree } from '../crypto/vault';
import { createTree, upsertPersonFields, commitDraft } from '../treeEngine';
import { directCrypto } from '../directArweave/transaction';
import { sha256 } from '../directArweave/format';
import type { DirectRawTransaction } from '../directArweave/types';
import manifest from './legacy-locators.v1.json';
import { historicalNativeCandidate, retrieveHistoricalNative } from './historicalNative';

// Public BIP39 test vector and ephemeral signing keys: never real user data or money.
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const keys = deriveKeysFromMnemonic(WORDS), ar = directCrypto();
const jwk = generateKeyPairSync('rsa', { modulusLength: 4096 }).privateKey.export({ format: 'jwk' }) as JWKInterface;
const node = 'https://historical-synthetic.example', alternate = 'https://historical-alternate.example';
const originalFetch = globalThis.fetch;
let passed = 0;
async function test(name: string, action: () => Promise<void> | void) { await action(); passed++; console.log(`PASS ${name}`); }

let tree = createTree('PUBLIC SYNTHETIC primary tree');
tree.meta.id = 'tree_public_primary';
tree = commitDraft(upsertPersonFields(tree, { id: 'person_public', name: 'PUBLIC SYNTHETIC PERSON' }), 'PUBLIC synthetic version one');
tree = commitDraft(upsertPersonFields(tree, { id: 'person_public', name: 'PUBLIC SYNTHETIC PERSON edited' }), 'PUBLIC synthetic version two');
const second = createTree('PUBLIC SYNTHETIC second tree'); second.meta.id = 'tree_public_second';
const vault = putTree(putTree(emptyVault(keys.vaultId), second), tree);
const envelope = await encryptJson(keys.encKey, keys.vaultId, vault);
const archiveText = serializeEnvelope(envelope), bytes = new TextEncoder().encode(archiveText);
const digest = await sha256(bytes), parent = 'P'.repeat(43);
type Tag = { name: string; value: string };
const base: Tag[] = [
  { name: 'App-Name', value: 'SEJIRE' }, { name: 'Type', value: 'vault-envelope' },
  { name: 'Schema', value: 'sejire/envelope/v1' }, { name: 'Vault-Id', value: keys.vaultId },
  { name: 'Archive-SHA256', value: digest }, { name: 'Archive-Bytes', value: String(bytes.length) },
];
const funded: Tag[] = [...base, { name: 'Preservation-Id', value: 'b'.repeat(32) }, { name: 'Promo-Funded', value: 'true' }];
const paid: Tag[] = [...base, { name: 'Protocol-Version', value: 'sejire/v0.3' },
  { name: 'Preservation-Id', value: 'c'.repeat(32) }, { name: 'Parent-Tx', value: parent }];
async function signed(tags: Tag[], data = bytes, signer = jwk, forcedRoot?: string) {
  const tx = await ar.createTransaction({ data, owner: signer.n, reward: '1000', last_tx: 'A'.repeat(64) });
  for (const tag of tags) tx.addTag(tag.name, tag.value);
  await tx.prepareChunks(data);
  if (forcedRoot) tx.data_root = forcedRoot;
  await ar.transactions.sign(tx, signer);
  return { ...tx.toJSON(), data: '' };
}
type Server = { raw: DirectRawTransaction; body?: Uint8Array; nativeOnly?: boolean; unavailable?: boolean };
function serve(primary: Server, other?: Server) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)); calls.push(url.href);
    assert([node, alternate].includes(url.origin), 'no hidden gateway, index, payment, Worker or wallet request');
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal(init.redirect, 'error');
    assert.equal(url.search, ''); assert(!url.href.includes(WORDS)); assert(!url.href.includes(OTHER_WORDS));
    const server = url.origin === alternate ? other : primary;
    if (!server || server.unavailable) return new Response('unavailable', { status: 404 });
    const { raw } = server, body = server.body ?? bytes;
    if (url.pathname === `/tx/${raw.id}`) return new Response(JSON.stringify(raw));
    if (url.pathname === `/tx/${raw.id}/data`) return new Response(ar.utils.bufferTob64Url(body));
    if ([`/raw/${raw.id}`, `/${raw.id}`].includes(url.pathname)) return server.nativeOnly
      ? new Response('missing', { status: 404 }) : new Response(body as BodyInit);
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
  return calls;
}
const options = { nodes: [node] };
try {
  await test('historical eight-tag fund archive retains every tree, commit and parent semantics', async () => {
    const raw = await signed(funded), calls = serve({ raw });
    const result = await retrieveHistoricalNative(raw.id, WORDS, options);
    assert.deepEqual(result.envelope, envelope); assert.deepEqual(result.vault, vault); assert.equal(result.parentTxId, null);
    assert(!('receipt' in result)); assert(!('confirmed' in result)); assert.equal(calls.length, 2);
  });
  await test('old paid native transaction without Save-Id recovers its authenticated Parent-Tx', async () => {
    const raw = await signed(paid); serve({ raw });
    const result = await retrieveHistoricalNative(raw.id, WORDS, options);
    assert.deepEqual(result.vault, vault); assert.equal(result.parentTxId, parent);
  });
  await test('modern native Save-Id is readable without manufacturing a payment receipt', async () => {
    const raw = await signed([...base, { name: 'Protocol-Version', value: 'sejire/v0.3' }, { name: 'Save-Id', value: 'd'.repeat(64) }]);
    serve({ raw }); const result = await retrieveHistoricalNative(raw.id, WORDS, options);
    assert.deepEqual(result.vault, vault); assert.deepEqual(Object.keys(result).sort(), ['envelope', 'parentTxId', 'vault']);
  });
  await test('historical RSA-2048 and untagged hash use native signature and Merkle binding', async () => {
    const signer = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' }) as JWKInterface;
    const raw = await signed(base.filter(tag => !['Archive-SHA256', 'Archive-Bytes'].includes(tag.name)), bytes, signer);
    serve({ raw, nativeOnly: true });
    assert.deepEqual((await retrieveHistoricalNative(raw.id, WORDS, options)).vault, vault);
  });
  await test('a changed signed header or signature is rejected before raw retrieval', async () => {
    for (const mutate of [(raw: DirectRawTransaction) => { raw.reward = '9999'; },
      (raw: DirectRawTransaction) => { raw.signature = (raw.signature[0] === 'A' ? 'B' : 'A') + raw.signature.slice(1); }]) {
      const raw = await signed(paid); mutate(raw); const calls = serve({ raw });
      await assert.rejects(() => retrieveHistoricalNative(raw.id, WORDS, options), /receipt_invalid/);
      assert.equal(calls.length, 1);
    }
  });
  await test('a valid signature over a false data root cannot authenticate ciphertext', async () => {
    const raw = await signed(paid, bytes, jwk, 'Z'.repeat(43)); serve({ raw });
    await assert.rejects(() => retrieveHistoricalNative(raw.id, WORDS, options), /archive_integrity_failed/);
  });
  await test('changed raw bytes cannot bypass signed Merkle binding even without a digest tag', async () => {
    const raw = await signed(base.filter(tag => !['Archive-SHA256', 'Archive-Bytes'].includes(tag.name)));
    const changed = bytes.slice(); changed[changed.length - 2] ^= 1; serve({ raw, body: changed });
    await assert.rejects(() => retrieveHistoricalNative(raw.id, WORDS, options), /archive_integrity_failed/);
  });
  await test('signed byte-count and hash tags remain mandatory and agree with header size', async () => {
    for (const tags of [paid.map(tag => tag.name === 'Archive-Bytes' ? { ...tag, value: String(bytes.length + 1) } : tag),
      paid.filter(tag => tag.name !== 'Archive-SHA256'), [...paid, { name: 'Vault-Id', value: keys.vaultId }]]) {
      const raw = await signed(tags), calls = serve({ raw });
      await assert.rejects(() => retrieveHistoricalNative(raw.id, WORDS, options), /receipt_invalid/);
      assert.equal(calls.length, 1);
    }
  });
  await test('historical missing-protocol exception cannot be broadened with arbitrary tags', async () => {
    const raw = await signed([...funded, { name: 'Unknown-Format', value: 'another' }]); serve({ raw });
    await assert.rejects(() => retrieveHistoricalNative(raw.id, WORDS, options), /receipt_invalid/);
  });
  await test('missing Vault-Id is accepted only for the exact built-in vault and transaction pair', async () => {
    const pinned = manifest.entries[0], locator = historicalNativeCandidate(pinned.txIds[0], pinned.vaultId);
    assert.equal(locator.legacy, true); assert.equal(locator.archiveBytes, pinned.archiveBytes); assert.equal(locator.archiveSha256, pinned.archiveSha256);
    assert.equal(historicalNativeCandidate(pinned.txIds[0], keys.vaultId).legacy, undefined);
    assert.equal(historicalNativeCandidate('Q'.repeat(43), pinned.vaultId).legacy, undefined);
    const raw = await signed(base.filter(tag => !['Vault-Id', 'Archive-SHA256', 'Archive-Bytes'].includes(tag.name))), calls = serve({ raw });
    await assert.rejects(() => retrieveHistoricalNative(raw.id, WORDS, options), /receipt_invalid/); assert.equal(calls.length, 1);
  });
  await test('wrong phrase and valid signed but unauthentic AES payload cannot recover a vault', async () => {
    const raw = await signed(paid); serve({ raw });
    await assert.rejects(() => retrieveHistoricalNative(raw.id, OTHER_WORDS, options), /receipt_invalid/);
    const other = deriveKeysFromMnemonic(OTHER_WORDS);
    const badEnvelope = await encryptJson(other.encKey, keys.vaultId, vault);
    const badBytes = new TextEncoder().encode(serializeEnvelope(badEnvelope));
    const badTags = paid.map(tag => tag.name === 'Archive-Bytes' ? { ...tag, value: String(badBytes.length) } : tag)
      .map(tag => tag.name === 'Archive-SHA256' ? { ...tag, value: '' } : tag);
    badTags.find(tag => tag.name === 'Archive-SHA256')!.value = await sha256(badBytes);
    const badRaw = await signed(badTags, badBytes); serve({ raw: badRaw, body: badBytes });
    await assert.rejects(() => retrieveHistoricalNative(badRaw.id, WORDS, options), /archive_integrity_failed/);
  });
  await test('alternate node and native data endpoint are verified before successful recovery', async () => {
    const raw = await signed(paid), changed = bytes.slice(); changed[0] ^= 1;
    const calls = serve({ raw, body: changed }, { raw, nativeOnly: true });
    assert.deepEqual((await retrieveHistoricalNative(raw.id, WORDS, { nodes: [node, alternate] })).vault, vault);
    assert(calls.includes(`${alternate}/tx/${raw.id}/data`));
  });
  await test('non-native bundled metadata cannot be treated as native transaction proof', async () => {
    const raw = await signed(paid), malformed = { ...raw, format: undefined } as unknown as DirectRawTransaction;
    const calls = serve({ raw: malformed });
    await assert.rejects(() => retrieveHistoricalNative(raw.id, WORDS, options), /receipt_invalid/); assert.equal(calls.length, 1);
  });
  await test('invalid words or an aborted request never reaches the public network', async () => {
    const raw = await signed(paid), calls = serve({ raw });
    await assert.rejects(() => retrieveHistoricalNative(raw.id, 'not a mnemonic', options), /mnemonic/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => retrieveHistoricalNative(raw.id, WORDS, { ...options, signal: controller.signal }), /operation_cancelled/);
    assert.equal(calls.length, 0);
  });
  console.log(`historical native recovery: ${passed} synthetic checks passed; no network writes or real payments`);
} finally { globalThis.fetch = originalFetch; keys.seed.fill(0); keys.master.fill(0); keys.encKey.fill(0); }
