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
const transport: typeof fetch = async (url, init) => {
  if (String(url).startsWith('https://payment.services.ar-io.dev/v1/account/free?')) return Response.json({ bytesRemaining: 1000000 });
  if (String(url) === 'https://upload.services.ar-io.dev/v1/tx') { raw = new Uint8Array(init!.body as Uint8Array); return Response.json({ id: acceptedId, winc: '0', synthetic: true }); }
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
await assert.rejects(service.sign(order, serialized.replace('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')), /archive_mismatch/);
await assert.rejects(service.ready(200000), /uploader_budget_not_ready/);
await assert.rejects(new TestnetPreservationService({ ...env, CHECKOUT_UPLOAD_SIGNER: bs58.encode(Buffer.concat([seed, Buffer.alloc(32)])) }, transport).ready(100), /uploader_not_ready/);
await assert.rejects(new TestnetPreservationService({ ...env, CHECKOUT_UPLOAD_ENABLED: 'false' }, transport).ready(100), /uploader_not_ready/);
await assert.rejects(new TestnetPreservationService(env, async () => Response.json({ bytesRemaining: 0 })).ready(100), /uploader_budget_not_ready/);
console.log('preservation.selftest: PASS (actual ANS-104 library signature with public vector, exact ciphertext, sandbox-only transport, readiness); no live upload/funding');
