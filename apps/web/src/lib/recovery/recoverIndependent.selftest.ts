import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import type { JWKInterface } from 'arweave/web/lib/wallet';
import { deriveKeysFromMnemonic } from '../crypto/keys';
import { encryptJson } from '../crypto/encrypt';
import { serializeEnvelope } from '../crypto/envelope';
import { emptyVault, putTree } from '../crypto/vault';
import { createTree, upsertPersonFields, commitDraft } from '../treeEngine';
import { DEFAULT_DIRECT_NODES } from '../directArweave/network';
import { directCrypto } from '../directArweave/transaction';
import { sha256 } from '../directArweave/format';
import { discoverIndependentVaultVersions, listIndependentVaultVersions } from '../independentDiscovery';
import { recoverIndependentVaultFromWords } from './recoverIndependent';

// Public BIP39 vector, synthetic family, ephemeral local signing key; fetch below
// rejects every unexpected URL. This suite never contacts a network or wallet.
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const keys = deriveKeysFromMnemonic(WORDS), ar = directCrypto();
const custom = 'https://arweave-choice.example', originalFetch = globalThis.fetch;
const jwk = generateKeyPairSync('rsa', { modulusLength: 4096 }).privateKey.export({ format: 'jwk' }) as JWKInterface;
let tree = createTree('SYNTHETIC independent restore');
tree = commitDraft(upsertPersonFields(tree, { id: 'p_synthetic', name: 'SYNTHETIC PRIVATE PERSON' }), 'Synthetic commit');
const vault = putTree(emptyVault(keys.vaultId), tree);
const envelope = await encryptJson(keys.encKey, keys.vaultId, vault);
const text = serializeEnvelope(envelope), bytes = new TextEncoder().encode(text);
const tx = await ar.createTransaction({ data: bytes, owner: jwk.n, reward: '1000', last_tx: 'A'.repeat(64) });
for (const [name, value] of [
  ['App-Name', 'SEJIRE'], ['Type', 'vault-envelope'], ['Schema', 'sejire/envelope/v1'], ['Vault-Id', keys.vaultId],
  ['Archive-SHA256', await sha256(bytes)], ['Archive-Bytes', String(bytes.length)],
  ['Preservation-Id', 'd'.repeat(32)], ['Promo-Funded', 'true'],
]) tx.addTag(name, value);
await tx.prepareChunks(bytes); await ar.transactions.sign(tx, jwk);
const header = { ...tx.toJSON(), data: '' };

function index(ids: readonly string[], hasNextPage = false, cursor = 'cursor') {
  return new Response(JSON.stringify({ data: { transactions: { pageInfo: { hasNextPage },
    edges: ids.map((id, i) => ({ cursor: `${cursor}-${i}`, node: { id, block: { timestamp: 100 + i }, tags: [] } })),
  } } }));
}
const requestViolations: string[] = [];
function checkRequest(input: RequestInfo | URL, init: RequestInit | undefined, origins: readonly string[]) {
  const url = new URL(String(input));
  if (!origins.includes(url.origin) || !['/graphql', `/tx/${header.id}`, `/raw/${header.id}`, `/${header.id}`, `/tx/${header.id}/data`].includes(url.pathname)) requestViolations.push(url.href);
  if (url.href.includes(WORDS) || String(init?.body ?? '').includes(WORDS) || String(init?.body ?? '').includes('SYNTHETIC PRIVATE PERSON')) requestViolations.push('private data in request');
  assert(origins.includes(url.origin), `unexpected origin ${url.origin}`);
  assert.equal(init?.credentials, 'omit'); assert.equal(init?.referrerPolicy, 'no-referrer'); assert.equal(init?.redirect, 'error');
  assert(!url.href.includes(WORDS)); assert(!String(init?.body ?? '').includes(WORDS));
  assert(!String(init?.body ?? '').includes('SYNTHETIC PRIVATE PERSON'));
  if (url.pathname === '/graphql') {
    assert.equal(init?.method, 'POST');
    const query = JSON.parse(String(init.body));
    assert(query.query.startsWith('query ')); assert(!query.query.includes('mutation'));
    assert.equal(query.variables.vaultId, keys.vaultId);
  } else { assert.equal(init?.method, 'GET'); assert.equal(init?.body, undefined); }
  return url;
}
let passed = 0;
async function test(name: string, action: () => Promise<void>) {
  await action(); assert.deepEqual(requestViolations, [], 'unexpected requests must not hide inside handled network failures');
  passed++; console.log(`PASS ${name}`);
}
try {
  await test('default version search merges native indexes without Goldsky, peer lookup or external service', async () => {
    const seen: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = checkRequest(input, init, DEFAULT_DIRECT_NODES); seen.push(url.href);
      assert.equal(url.pathname, '/graphql');
      return index(url.origin === DEFAULT_DIRECT_NODES[0] ? [] : [header.id]);
    };
    assert.deepEqual((await listIndependentVaultVersions(keys.vaultId)).map(version => version.txId), [header.id]);
    assert.deepEqual(seen.sort(), DEFAULT_DIRECT_NODES.map(node => `${node}/graphql`).sort());
  });
  await test('default native search survives a missing index but fails if every selected index is unavailable', async () => {
    for (const allMissing of [false, true]) {
      const seen: string[] = [];
      globalThis.fetch = async (input, init) => {
        const url = checkRequest(input, init, DEFAULT_DIRECT_NODES); seen.push(url.href);
        assert.equal(url.pathname, '/graphql');
        return allMissing || url.origin === DEFAULT_DIRECT_NODES[0] ? new Response('', { status: 404 }) : index([header.id]);
      };
      if (allMissing) await assert.rejects(() => listIndependentVaultVersions(keys.vaultId), /Arweave/);
      else assert.equal((await listIndependentVaultVersions(keys.vaultId))[0].txId, header.id);
      assert.equal(seen.length, DEFAULT_DIRECT_NODES.length);
    }
  });
  await test('custom search remains exclusive, bounded and paginated on one native origin', async () => {
    const cursors: unknown[] = [];
    globalThis.fetch = async (input, init) => {
      const url = checkRequest(input, init, [custom]); assert.equal(url.pathname, '/graphql');
      const body = JSON.parse(String(init?.body)); cursors.push(body.variables.after);
      const n = cursors.length;
      return index([String(n).repeat(43)], true, `page-${n}`);
    };
    const result = await discoverIndependentVaultVersions(keys.vaultId, { nodes: [custom] });
    assert.deepEqual(cursors, [null, 'page-1-0', 'page-2-0']);
    assert.equal(result.candidates.length, 3); assert.equal(result.incomplete, true); assert.equal(result.responded, false);
    assert.deepEqual(result.providers.map(provider => provider.id), [`graphql:${new URL(custom).host}`]);
  });
  await test('missing or malformed custom index cannot trigger public defaults or certify empty history', async () => {
    for (const malformed of [false, true]) {
      let requests = 0;
      globalThis.fetch = async (input, init) => {
        const url = checkRequest(input, init, [custom]); assert.equal(url.pathname, '/graphql'); requests++;
        return malformed ? new Response(JSON.stringify({ data: { transactions: { edges: [] } } })) : new Response('', { status: 404 });
      };
      const result = await discoverIndependentVaultVersions(keys.vaultId, { nodes: [custom] });
      assert.equal(result.responded, false); assert.equal(result.incomplete, true); assert.equal(requests, 1);
    }
  });
  await test('words-only restore authenticates a historical native archive without an index service or server', async () => {
    const requests: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = checkRequest(input, init, DEFAULT_DIRECT_NODES); requests.push(url.pathname);
      if (url.pathname === '/graphql') return index([header.id]);
      if (url.pathname === `/tx/${header.id}`) return new Response(JSON.stringify(header));
      if (url.pathname === `/raw/${header.id}`) return new Response(text);
      throw Error(`unexpected path ${url.pathname}`);
    };
    const restored = await recoverIndependentVaultFromWords(WORDS);
    assert(restored.ok);
    assert.deepEqual(restored.vault, vault); assert.equal(restored.headTxId, header.id);
    assert.equal(restored.versions.length, 1); assert.equal(restored.incomplete, true);
    assert.equal(restored.versions[0].blockHeight, null, 'search metadata never becomes a consensus proof');
    assert.equal(requests.filter(path => path === '/graphql').length, DEFAULT_DIRECT_NODES.length);
    assert.equal(requests.filter(path => path === `/tx/${header.id}`).length, 1);
  });
  await test('a forged native header is rejected even if an index advertises matching ciphertext', async () => {
    let archiveReads = 0;
    globalThis.fetch = async (input, init) => {
      const url = checkRequest(input, init, [custom]);
      if (url.pathname === '/graphql') return index([header.id]);
      if (url.pathname === `/tx/${header.id}`) return new Response(JSON.stringify({ ...header, reward: '9999' }));
      archiveReads++; return new Response(text);
    };
    const restored = await recoverIndependentVaultFromWords(WORDS, { nodes: [custom] });
    assert.equal(restored.ok, false); assert.equal(archiveReads, 0);
  });
  await test('known transaction recovery works on the selected native node while every index is down', async () => {
    globalThis.fetch = async (input, init) => {
      const url = checkRequest(input, init, [custom]);
      if (url.pathname === '/graphql') return new Response('', { status: 503 });
      if (url.pathname === `/tx/${header.id}`) return new Response(JSON.stringify(header));
      if (url.pathname === `/raw/${header.id}`) return new Response(text);
      throw Error(`unexpected path ${url.pathname}`);
    };
    const restored = await recoverIndependentVaultFromWords(WORDS, { nodes: [custom], txHints: [header.id] });
    assert(restored.ok); assert.deepEqual(restored.vault, vault); assert.equal(restored.incomplete, true);
  });
  await test('invalid words or already cancelled searches make no network requests', async () => {
    let requests = 0;
    globalThis.fetch = async () => { requests++; assert.fail('unexpected network request'); };
    const invalid = await recoverIndependentVaultFromWords('not a valid backup phrase');
    assert(!invalid.ok); assert.equal(invalid.code, 'INVALID_WORDS');
    const cancelled = await recoverIndependentVaultFromWords(WORDS, { signal: AbortSignal.abort() });
    assert(!cancelled.ok); assert.equal(cancelled.code, 'DATA_UNAVAILABLE');
    assert.equal(requests, 0);
  });
  console.log(`independent native recovery: ${passed} local checks passed; no live network, signing request or upload`);
} finally { globalThis.fetch = originalFetch; keys.seed.fill(0); keys.master.fill(0); keys.encKey.fill(0); }
