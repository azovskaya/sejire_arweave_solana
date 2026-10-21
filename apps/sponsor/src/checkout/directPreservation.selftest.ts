import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  DirectArweavePreservation, type DirectInput, type DirectPolicy, type PreparedDirectPlan, type SignedDirectPlan,
} from './directPreservation';

// Ephemeral, unfunded RSA key generated only for local software tests. Neither
// key material nor signed ciphertext is printed or written to any fixture file.
const pair = await crypto.subtle.generateKey({ name: 'RSA-PSS', modulusLength: 4096,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
if (!('privateKey' in pair)) throw Error('synthetic_keypair_unavailable');
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
if (jwk instanceof ArrayBuffer) throw Error('synthetic_jwk_unavailable');
const secret = JSON.stringify(jwk);
const treasuryAddress = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(jwk.n!, 'base64url'))).toString('base64url');
const digest = async (value: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');
const parent = Buffer.alloc(32, 9).toString('base64url');
const anchor = Buffer.alloc(48, 7).toString('base64url');
const policy: DirectPolicy = { treasuryAddress, network: 'arweave.N.1', maxArchiveBytes: 524288, maxRewardWinston: '4000000000' };
const fixture = async (count = 32, parentTxId: string | null = parent): Promise<DirectInput> => {
  const serialized = JSON.stringify({ schema: 'sejire/envelope/v1', vault_id: 'c'.repeat(32), cipher: 'aes-gcm-256',
    kdf: 'hkdf-sha256', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'A'.repeat(count), protocol: 'sejire/v0.3' });
  return { orderId: 'a'.repeat(32), serialized, archive: { digest: await digest(serialized), bytes: Buffer.byteLength(serialized),
    vaultId: 'c'.repeat(32), parentTxId } };
};
const input = await fixture();
type Call = { url: string; method: string; body: string | undefined };
const calls: Call[] = [];
let networkMode = 'good', archiveMode = 'good', statusMode = 'confirmed', submitMode = 'good';
let metadataChange: (record: Record<string, unknown>, host: string) => Record<string, unknown> = record => record;
let stored: SignedDirectPlan | undefined;
const response = (url: string, body: BodyInit | null, status = 200, headers?: HeadersInit) => {
  const result = new Response(body, { status, headers }); Object.defineProperty(result, 'url', { value: url }); return result;
};
const transport: typeof fetch = async (request, init) => {
  const url = String(request), parsed = new URL(url), method = init?.method ?? 'GET';
  calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
  assert.ok(['https://arweave.net', 'https://g8way.io'].includes(parsed.origin), 'only pinned mainnet gateways');
  assert.equal(init?.redirect, 'manual', 'workerd-supported redirect mode is mandatory');
  assert.ok(init?.signal instanceof AbortSignal);
  if (method === 'POST') {
    assert.ok(['/tx', '/chunk'].includes(parsed.pathname));
    if (submitMode === 'lost') throw Error('synthetic lost upload response');
    if (submitMode === 'redirect') return response(url, '', 307, { Location: 'https://attacker.example/collect' });
    return response(url, 'OK', 200);
  }
  if (parsed.pathname === '/info') return response(url, JSON.stringify({ network: networkMode === 'wrong' ? 'testnet' : 'arweave.N.1' }));
  if (parsed.pathname === '/tx_anchor') return response(url, anchor);
  if (parsed.pathname.startsWith('/wallet/')) return response(url, networkMode === 'low' ? '1' : '68000000000000');
  if (parsed.pathname.startsWith('/price/')) return response(url, networkMode === 'expensive' ? '5000000000' : '3000000000');
  assert.ok(stored, 'network reconciliation only uses a persisted signed plan');
  if (parsed.pathname === `/tx/${stored.id}/status`) {
    if (statusMode === 'missing') return response(url, '', 404);
    if (statusMode === 'partial') return response(url, '', parsed.hostname === 'arweave.net' ? 404 : 503);
    if (statusMode === 'accepted') return response(url, '', 202);
    return response(url, JSON.stringify({ number_of_confirmations: statusMode === 'pending' ? 0 : 7 }));
  }
  if (parsed.pathname === `/tx/${stored.id}`) {
    if (statusMode === 'missing' || statusMode === 'partial') return response(url, '', 404);
    const metadata = JSON.parse(stored.raw) as Record<string, unknown>; metadata.data = '';
    return response(url, JSON.stringify(metadataChange(metadata, parsed.origin)));
  }
  if (parsed.pathname === `/tx/${stored.id}/data`) {
    if (archiveMode === 'missing') return response(url, '', 404);
    if (archiveMode === 'encoding') return response(url, '!!!!');
    const raw = archiveMode === 'bad' ? input.serialized.replace('"ciphertext":"A', '"ciphertext":"B') : input.serialized;
    return response(url, Buffer.from(raw).toString('base64url'));
  }
  if ([`/raw/${stored.id}`, `/${stored.id}`].includes(parsed.pathname)) {
    return archiveMode === 'bad' ? response(url, input.serialized.replace('"ciphertext":"A', '"ciphertext":"B')) : response(url, '', 404);
  }
  throw Error('unexpected_mock_path');
};
const enabled = (overrides: Partial<ConstructorParameters<typeof DirectArweavePreservation>[0]> = {}) =>
  new DirectArweavePreservation({ secret, policy, executionEnabled: true, transport, ...overrides });
const defaultDisabled = new DirectArweavePreservation({ secret, policy, transport });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
let passed = 0;
const test = async (name: string, run: () => Promise<void> | void) => { await run(); passed++; console.log(`PASS direct-preservation: ${name}`); };
const priorFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error('external_network_forbidden'); };
let prepared: PreparedDirectPlan;

try {
  await test('invalid storage policy is rejected before any transport or signing', () => {
    for (const changed of [{ network: 'testnet' }, { treasuryAddress: 'not-an-address' }, { maxArchiveBytes: 0 }, { maxRewardWinston: '0' }]) {
      assert.throws(() => enabled({ policy: { ...policy, ...changed } as DirectPolicy }));
    }
    assert.equal(calls.length, 0);
  });

  await test('readiness and unsigned exact preparation work while execution is disabled', async () => {
    const ready = await defaultDisabled.ready(input.archive.bytes);
    assert.equal(ready.signerAddress, treasuryAddress); assert.equal(ready.rewardWinston, '3000000000');
    assert.equal(ready.balanceWinston, '68000000000000');
    prepared = await defaultDisabled.prepare(input);
    const raw = JSON.parse(prepared.raw);
    assert.equal(raw.id, ''); assert.equal(raw.signature, '');
    assert.equal(Buffer.from(raw.data, 'base64url').toString(), input.serialized);
    const tags = raw.tags.map((tag: { name: string; value: string }) => [Buffer.from(tag.name, 'base64url').toString(), Buffer.from(tag.value, 'base64url').toString()]);
    assert.deepEqual(tags, [['App-Name', 'SEJIRE'], ['Type', 'vault-envelope'], ['Schema', 'sejire/envelope/v1'],
      ['Protocol-Version', 'sejire/v0.3'], ['Vault-Id', input.archive.vaultId], ['Archive-SHA256', input.archive.digest],
      ['Archive-Bytes', String(input.archive.bytes)], ['Preservation-Id', input.orderId], ['Parent-Tx', parent]]);
    assert.ok(calls.every(call => call.method === 'GET')); assert.ok(!JSON.stringify(defaultDisabled).includes(jwk.d!));
    await assert.rejects(defaultDisabled.sign(input, prepared), /direct_execution_disabled/);
  });

  await test('no signer, wrong signer, network, low balance or excess reward cannot offer ready', async () => {
    const before = calls.length;
    await assert.rejects(enabled({ secret: undefined }).ready(input.archive.bytes), /direct_signer_unavailable/);
    await assert.rejects(enabled({ secret: 'invalid synthetic binding' }).ready(input.archive.bytes), /direct_signer_unavailable/);
    await assert.rejects(enabled({ policy: { ...policy, treasuryAddress: parent } }).ready(input.archive.bytes), /direct_signer_unavailable/);
    assert.equal(calls.length, before);
    for (const mode of ['wrong', 'low', 'expensive']) {
      networkMode = mode; await assert.rejects(enabled().ready(input.archive.bytes));
    }
    networkMode = 'good';
  });

  await test('changed archive, missing parent binding and noncanonical serialization fail before network', async () => {
    const before = calls.length;
    const changed: DirectInput[] = [
      { ...input, archive: { ...input.archive, digest: '0'.repeat(64) } },
      { ...input, archive: { ...input.archive, bytes: input.archive.bytes + 1 } },
      { ...input, archive: { ...input.archive, vaultId: 'd'.repeat(32) } },
      { ...input, archive: { ...input.archive, parentTxId: undefined as unknown as null } },
    ];
    for (const value of changed) await assert.rejects(enabled().prepare(value));
    const serialized = input.serialized + '\n';
    await assert.rejects(enabled().prepare({ ...input, serialized, archive: { ...input.archive, bytes: Buffer.byteLength(serialized), digest: await digest(serialized) } }), /direct_archive_mismatch/);
    assert.equal(calls.length, before);
  });

  await test('all prepared transaction fields are bound before signing, including Merkle data root', async () => {
    const before = calls.length;
    const mutations: ((raw: Record<string, any>) => void)[] = [
      raw => { raw.data = Buffer.from(input.serialized.replace('ciphertext', 'plaintext!')).toString('base64url'); },
      raw => { raw.data_root = parent; }, raw => { raw.reward = '3000000001'; },
      raw => { raw.quantity = '1'; }, raw => { raw.target = parent; }, raw => { raw.data_size = '1'; },
      raw => { raw.tags.push(raw.tags[0]); }, raw => { raw.tags[8].value = Buffer.from('B'.repeat(43)).toString('base64url'); },
      raw => { raw.tags.push({ name: Buffer.from('Promo-Funded').toString('base64url'), value: Buffer.from('true').toString('base64url') }); },
      raw => { raw.signature = 'injected'; }, raw => { raw.untrusted = true; },
    ];
    for (const mutate of mutations) {
      const plan = copy(prepared), raw = JSON.parse(plan.raw); mutate(raw); plan.raw = JSON.stringify(raw);
      await assert.rejects(enabled().sign(input, plan), /direct_plan_mismatch/);
    }
    await assert.rejects(enabled().sign({ ...input, archive: { ...input.archive, parentTxId: null } }, prepared), /direct_plan_mismatch/);
    await assert.rejects(enabled().sign(input, { ...prepared, rewardWinston: '3000000001' }), /direct_plan_mismatch/);
    assert.equal(calls.length, before);
  });

  await test('real software RSA signature uses stored quote and exact recovery metadata without network', async () => {
    const before = calls.length, immutable = prepared.raw;
    stored = await enabled().sign(input, copy(prepared));
    assert.equal(prepared.raw, immutable); assert.equal(calls.length, before);
    const raw = JSON.parse(stored.raw);
    assert.equal(stored.rewardWinston, prepared.rewardWinston);
    assert.equal(stored.id, Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(raw.signature, 'base64url'))).toString('base64url'));
    assert.equal(raw.data, JSON.parse(prepared.raw).data); assert.deepEqual(raw.tags, JSON.parse(prepared.raw).tags);
    await assert.rejects(defaultDisabled.submit(input, stored), /direct_execution_disabled/);
  });

  await test('lost submit response replays identical signed bytes after fresh provider construction', async () => {
    submitMode = 'lost'; const before = calls.length;
    await assert.rejects(enabled().submit(input, copy(stored!)), /direct_submit_uncertain/);
    submitMode = 'good';
    const accepted = await enabled({ secret: undefined }).submit(input, copy(stored!));
    assert.deepEqual(accepted, { id: stored!.id, accepted: true });
    const replay = calls.slice(before);
    assert.equal(replay.length, 2); assert.ok(replay.every(call => call.url === 'https://arweave.net/tx' && call.method === 'POST'));
    assert.equal(replay[0].body, stored!.raw); assert.equal(replay[1].body, stored!.raw);
  });

  await test('altered signed data or parent never reaches POST, even with a valid signature over old root', async () => {
    const before = calls.length;
    const raw = JSON.parse(stored!.raw); raw.data = Buffer.from(input.serialized.replace('"ciphertext":"A', '"ciphertext":"B')).toString('base64url');
    await assert.rejects(enabled().submit(input, { ...stored!, raw: JSON.stringify(raw) }), /direct_plan_mismatch/);
    await assert.rejects(enabled().submit({ ...input, archive: { ...input.archive, parentTxId: null } }, stored!), /direct_plan_mismatch/);
    assert.equal(calls.length, before);
  });

  await test('read-only reconciliation survives restart without signer and verifies node-data fallback', async () => {
    const before = calls.length;
    const result = await enabled({ secret: undefined, executionEnabled: false }).reconcile(input, copy(stored!));
    assert.equal(result.onchainConfirmed, true); assert.equal(result.archiveVerified, true);
    assert.equal(result.confirmations, 7); assert.equal(result.rewardWinston, '3000000000'); assert.equal(result.reason, null);
    assert.ok(calls.slice(before).every(call => call.method === 'GET' && !/\/(price|tx_anchor|info)/.test(new URL(call.url).pathname)));
    assert.ok(calls.slice(before).some(call => call.url.endsWith(`/tx/${stored!.id}/data`)));
    const brokenSigner = await enabled({ secret: 'invalid synthetic binding', executionEnabled: false }).reconcile(input, stored!);
    assert.equal(brokenSigner.onchainConfirmed, true); assert.equal(brokenSigner.archiveVerified, true);
  });

  await test('on-chain spend stays proved when the archive is missing or fails integrity', async () => {
    for (const mode of ['missing', 'bad', 'encoding']) {
      archiveMode = mode;
      const result = await enabled({ secret: undefined }).reconcile(input, stored!);
      assert.equal(result.onchainConfirmed, true); assert.equal(result.archiveVerified, false);
      assert.equal(result.rewardWinston, stored!.rewardWinston);
      assert.equal(result.reason, mode === 'missing' ? 'archive_unavailable' : 'archive_verification_failed');
    }
    archiveMode = 'good';
  });

  await test('wrong owner, reward, ID, Parent or duplicate signed metadata cannot prove spend/completion', async () => {
    const changes: ((record: Record<string, any>) => Record<string, unknown>)[] = [
      record => ({ ...record, owner: Buffer.alloc(512, 1).toString('base64url') }),
      record => ({ ...record, reward: '3000000001' }), record => ({ ...record, id: parent }),
      record => ({ ...record, tags: record.tags.slice(0, -1) }),
      record => ({ ...record, tags: [...record.tags, record.tags[0]] }),
      record => ({ ...record, data_root: parent }),
    ];
    for (const change of changes) {
      metadataChange = change;
      const result = await enabled({ secret: undefined }).reconcile(input, stored!);
      assert.equal(result.onchainConfirmed, false); assert.equal(result.archiveVerified, false);
      assert.equal(result.reason, 'transaction_mismatch');
    }
    metadataChange = record => record;
  });

  await test('valid same-ID metadata wins another host mismatch; object-key order is immaterial', async () => {
    metadataChange = (record, host) => host === 'https://arweave.net' ? { ...record, reward: '3000000001' } : {
      ...record, tags: (record.tags as { name: string; value: string }[]).map(tag => ({ value: tag.value, name: tag.name })),
    };
    const result = await enabled({ secret: undefined }).reconcile(input, stored!);
    assert.equal(result.onchainConfirmed, true); assert.equal(result.archiveVerified, true);
    metadataChange = record => record;
  });

  await test('pending, absent and partially unavailable indexes never become a false completion', async () => {
    for (const mode of ['accepted', 'pending', 'missing', 'partial']) {
      statusMode = mode;
      const result = await enabled({ secret: undefined }).reconcile(input, stored!);
      assert.equal(result.onchainConfirmed, false); assert.equal(result.archiveVerified, false);
      assert.equal(result.state, mode === 'missing' ? 'not_found' : mode === 'partial' ? 'unavailable' : 'pending');
    }
    statusMode = 'confirmed';
  });

  await test('redirects cannot escape the pinned transport or produce readiness, acceptance or proof', async () => {
    const visited: string[] = [];
    const redirected: typeof fetch = async (url, init) => {
      visited.push(String(url)); assert.equal(init?.redirect, 'manual');
      return response(String(url), '{}', 307, { Location: 'https://attacker.example/collect' });
    };
    await assert.rejects(enabled({ transport: redirected }).ready(input.archive.bytes), /direct_network_unavailable/);
    await assert.rejects(enabled({ transport: redirected }).submit(input, stored!), /direct_submit_uncertain/);
    const result = await enabled({ transport: redirected }).reconcile(input, stored!);
    assert.equal(result.onchainConfirmed, false); assert.equal(result.archiveVerified, false);
    assert.ok(visited.every(url => !url.startsWith('https://attacker.example/')));
  });

  await test('bounded full response bodies and an explicit abort cannot outlive the deadline', async () => {
    let cancelled = 0;
    const stalled: typeof fetch = async url => response(String(url), new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }));
    const started = Date.now();
    await assert.rejects(enabled({ transport: stalled }).ready(input.archive.bytes, { deadline: Date.now() + 70 }), /direct_network_unavailable|direct_operation_cancelled/);
    assert.ok(Date.now() - started < 1000); assert.ok(cancelled > 0);
    const oversized: typeof fetch = async url => response(String(url), 'x'.repeat(20000));
    await assert.rejects(enabled({ transport: oversized }).ready(input.archive.bytes), /direct_network_unavailable/);
    const controller = new AbortController(); controller.abort(); const before = calls.length;
    await assert.rejects(enabled().prepare(input, { signal: controller.signal }), /direct_operation_cancelled/);
    await assert.rejects(enabled().submit(input, stored!, { signal: controller.signal }), /direct_operation_cancelled/);
    assert.equal(calls.length, before);
  });

  await test('arbitrary larger ciphertext uses immutable signed header and all deterministic Merkle chunks', async () => {
    const large = await fixture(400000, null);
    const plan = await enabled().prepare(large);
    const signed = await enabled().sign(large, plan);
    const before = calls.length;
    assert.deepEqual(await enabled().submit(large, signed), { id: signed.id, accepted: true });
    const uploads = calls.slice(before);
    assert.equal(uploads[0].url, 'https://arweave.net/tx');
    const header = JSON.parse(uploads[0].body!); assert.equal(header.data, '');
    const complete = JSON.parse(signed.raw); delete header.data; delete complete.data; assert.deepEqual(header, complete);
    const chunks = uploads.slice(1).map(call => { assert.equal(call.url, 'https://arweave.net/chunk'); return JSON.parse(call.body!); });
    assert.equal(chunks.length, 2);
    assert.equal(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.chunk, 'base64url'))).toString(), large.serialized);
    assert.ok(chunks.every(chunk => chunk.data_root === header.data_root && chunk.data_size === String(large.archive.bytes)));
    const tags = JSON.parse(signed.raw).tags.map((tag: { name: string }) => Buffer.from(tag.name, 'base64url').toString());
    assert.equal(tags.includes('Parent-Tx'), false); assert.equal(tags.includes('Promo-Funded'), false);
  });

  console.log(`directPreservation.selftest: PASS (${passed} scenarios); software-only unfunded RSA, mocked mainnet wire, no external connections or funds`);
} finally { globalThis.fetch = priorFetch; }
