import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import bs58 from 'bs58';
import { TestnetPreservationService } from './preservation';
import { fixtureOrder } from './rpcFixtures';
import { envelopeDigest } from '../../../web/src/lib/solana/policy';
// PUBLIC RFC 8032 vector. Deliberately unsafe for any actual wallet; offline library test ONLY.
const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
const pub = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex');
const env = { CHECKOUT_UPLOAD_ENABLED: 'true', CHECKOUT_UPLOAD_SIGNER: bs58.encode(Buffer.concat([seed, pub])), MAX_ENVELOPE_BYTES: '524288' };
let acceptedId = '', raw: Uint8Array | undefined;
const calls: { url: string; redirect: RequestInit['redirect'] }[] = [];
const transport: typeof fetch = async (url, init) => {
  calls.push({ url: String(url), redirect: init?.redirect });
  if (String(url).startsWith('https://payment.services.ar-io.dev/v1/account/free?')) return Response.json({ bytesRemaining: 1000000 });
  if (String(url) === 'https://upload.services.ar-io.dev/v1/tx') { raw = new Uint8Array(init!.body as Uint8Array); return Response.json({ id: acceptedId, winc: '0', synthetic: true }); }
  if (String(url) === `https://ar-io.dev/raw/${acceptedId}`) return new Response(serialized);
  throw new Error('unexpected_network_endpoint');
};
const service = new TestnetPreservationService(env, transport);
const serialized = JSON.stringify({ schema: 'sejire/envelope/v1', vault_id: 'c'.repeat(32), cipher: 'aes-gcm-256', kdf: 'hkdf-sha256', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', protocol: 'sejire/v0.3' });
const order = fixtureOrder({ archive: { digest: await envelopeDigest(serialized), bytes: Buffer.byteLength(serialized) } });
const plan = await service.sign(order, serialized); acceptedId = plan.id;
assert.match(plan.id, /^[A-Za-z0-9_-]{43}$/); assert.equal(plan.maxWinc, '0');
const item = Buffer.from(plan.rawBase64, 'base64');
assert.equal(item.readUInt16LE(0), 4, 'Solana hex ANS-104 signature type');
assert.ok(item.includes(Buffer.from(serialized)), 'exact ciphertext bytes in signed item');
assert.equal((await service.upload(plan)).id, plan.id); assert.ok(raw); assert.deepEqual(Buffer.from(raw), item);
assert.equal(await service.retrieve(plan.id, order.archive!.digest), true);
assert.equal(calls.length, 3);
assert.ok(calls.every(call => call.redirect === 'manual'), 'all actual preservation adapter requests use the workerd-supported manual mode');
const expectedUrls = {
  ready: `https://payment.services.ar-io.dev/v1/account/free?address=${bs58.encode(pub)}`,
  upload: 'https://upload.services.ar-io.dev/v1/tx',
  retrieve: `https://ar-io.dev/raw/${plan.id}`,
};
for (const step of ['ready', 'upload', 'retrieve'] as const) for (const status of [301, 302, 303, 307, 308]) {
  const target = `https://attacker.example/${step}`, redirectedCalls: { url: string; redirect: RequestInit['redirect'] }[] = [];
  const redirecting = new TestnetPreservationService(env, async (url, init) => {
    redirectedCalls.push({ url: String(url), redirect: init?.redirect });
    const body = step === 'ready' ? JSON.stringify({ bytesRemaining: 1000000 }) : step === 'upload' ? JSON.stringify({ id: plan.id, winc: '0' }) : serialized;
    return new Response(body, { status, headers: { Location: target } });
  });
  if (step === 'ready') await assert.rejects(redirecting.ready(order.archive!.bytes), /uploader_not_ready/);
  else if (step === 'upload') await assert.rejects(redirecting.upload(plan), /upload_requires_reconciliation/);
  else assert.equal(await redirecting.retrieve(plan.id, order.archive!.digest), false, `HTTP ${status} cannot verify an archive`);
  assert.deepEqual(redirectedCalls, [{ url: expectedUrls[step], redirect: 'manual' }]);
  assert.equal(redirectedCalls.some(call => call.url === target), false, `${step} HTTP ${status} never requests Location`);
}
for (const step of ['ready', 'upload', 'retrieve'] as const) {
  const redirected = new TestnetPreservationService(env, async () => {
    const body = step === 'ready' ? JSON.stringify({ bytesRemaining: 1000000 }) : step === 'upload' ? JSON.stringify({ id: plan.id, winc: '0' }) : serialized;
    const response = new Response(body);
    Object.defineProperty(response, 'url', { value: `https://attacker.example/${step}` });
    return response;
  });
  if (step === 'ready') await assert.rejects(redirected.ready(order.archive!.bytes), /uploader_not_ready/);
  else if (step === 'upload') await assert.rejects(redirected.upload(plan), /upload_requires_reconciliation/);
  else assert.equal(await redirected.retrieve(plan.id, order.archive!.digest), false);
}
await assert.rejects(service.sign(order, serialized.replace('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')), /archive_mismatch/);
await assert.rejects(service.ready(200000), /uploader_budget_not_ready/);
await assert.rejects(new TestnetPreservationService({ ...env, CHECKOUT_UPLOAD_SIGNER: bs58.encode(Buffer.concat([seed, Buffer.alloc(32)])) }, transport).ready(100), /uploader_not_ready/);
await assert.rejects(new TestnetPreservationService({ ...env, CHECKOUT_UPLOAD_ENABLED: 'false' }, transport).ready(100), /uploader_not_ready/);
await assert.rejects(new TestnetPreservationService(env, async () => Response.json({ bytesRemaining: 0 })).ready(100), /uploader_budget_not_ready/);
console.log('preservation.selftest: PASS (actual ANS-104 library signature with public vector, exact ciphertext, sandbox-only transport, readiness); no live upload/funding');
