import { Buffer } from 'node:buffer';
// The SDK's web entry references the Node Buffer global without importing it.
// workerd nodejs_compat exposes node:buffer, but does not install this global.
const bufferRuntime = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
bufferRuntime.Buffer ??= Buffer;
import bs58 from 'bs58';
import type { Order } from '../../../../packages/checkout/order';
import { parseEnvelope, serializeEnvelope } from '../../../web/src/lib/crypto/envelope';
import { envelopeDigest } from '../../../web/src/lib/solana/policy';
import type { EnvelopeV1 } from '../../../web/src/lib/crypto/encrypt';

export type UploadPlan = { id: string; rawBase64: string; envelope: EnvelopeV1; maxWinc: string };
export type UploadAcceptance = { id: string; winc: string; [key: string]: unknown };
export interface PreservationService {
  ready(bytes: number): Promise<void>;
  sign(order: Order, serialized: string): Promise<UploadPlan>;
  upload(plan: UploadPlan): Promise<UploadAcceptance>;
  retrieve(id: string, expectedDigest: string): Promise<boolean>;
}
export type PreservationEnv = { CHECKOUT_UPLOAD_ENABLED?: string; CHECKOUT_UPLOAD_SIGNER?: string; MAX_ENVELOPE_BYTES?: string };
const UPLOAD = 'https://upload.services.ar-io.dev';
const PAYMENT = 'https://payment.services.ar-io.dev';
/** Separate sandbox signer, no top-up, transfer, real funds or production fallback.
 * Initial pilot uses only free sandbox allowance; depletion blocks payment readiness.
 * Lifetime IP allowance is advisory; 402 remains a pending paid service, never a second bill.
 */
export class TestnetPreservationService implements PreservationService {
  constructor(private readonly env: PreservationEnv, private readonly transport: typeof fetch = fetch) {}
  private key(): string {
    if (this.env.CHECKOUT_UPLOAD_ENABLED !== 'true' || !this.env.CHECKOUT_UPLOAD_SIGNER) throw new Error('uploader_not_ready');
    const key = this.env.CHECKOUT_UPLOAD_SIGNER;
    if (bs58.decode(key).length !== 64) throw new Error('uploader_not_ready');
    return key;
  }
  async ready(bytes: number): Promise<void> {
    const key = this.key(), max = Number(this.env.MAX_ENVELOPE_BYTES);
    const { HexSolanaSigner } = await import('@dha-team/arbundles/web');
    const signer = new HexSolanaSigner(key), challenge = new TextEncoder().encode('SEJIRE isolated sandbox uploader readiness');
    if (!await HexSolanaSigner.verify(signer.publicKey, challenge, await signer.sign(challenge))) throw new Error('uploader_not_ready');
    if (!Number.isSafeInteger(max) || max <= 0 || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > max) throw new Error('archive_not_supported');
    // Existing sandbox free eligibility is a technical service condition, not a new commercial cap.
    const itemBytes = bytes + 4096;
    if (itemBytes > 105 * 1024) throw new Error('uploader_budget_not_ready');
    const address = bs58.encode(bs58.decode(key).subarray(32));
    const free = await this.transport(`${PAYMENT}/v1/account/free?address=${encodeURIComponent(address)}`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!free.ok) throw new Error('uploader_not_ready');
    const data = await free.json() as { bytesRemaining?: unknown };
    if (data.bytesRemaining !== null && (typeof data.bytesRemaining !== 'number' || data.bytesRemaining < itemBytes)) throw new Error('uploader_budget_not_ready');
  }
  async sign(order: Order, serialized: string): Promise<UploadPlan> {
    const envelope = parseEnvelope(JSON.parse(serialized));
    if (!order.archive || new TextEncoder().encode(serialized).length !== order.archive.bytes || await envelopeDigest(serialized) !== order.archive.digest) throw new Error('archive_mismatch');
    await this.ready(order.archive.bytes);
    const { createData, HexSolanaSigner } = await import('@dha-team/arbundles/web');
    const signer = new HexSolanaSigner(this.key());
    const item = createData(Buffer.from(serialized), signer, { tags: [{ name: 'Content-Type', value: 'application/json' }, { name: 'App-Name', value: 'SEJIRE' }, { name: 'Protocol', value: 'sejire/v0.3' }, { name: 'Type', value: 'vault-envelope' }] });
    await item.sign(signer);
    // Detect malformed/mismatched configured test key before any network upload.
    if (!await item.isValid()) throw new Error('uploader_not_ready');
    return { id: item.id, rawBase64: item.getRaw().toString('base64'), envelope, maxWinc: '0' };
  }
  async upload(plan: UploadPlan): Promise<UploadAcceptance> {
    const response = await this.transport(`${UPLOAD}/v1/tx`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(plan.rawBase64, 'base64'), redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('upload_requires_reconciliation');
    const receipt = await response.json() as UploadAcceptance;
    if (receipt.id !== plan.id || receipt.winc !== '0') throw new Error('upload_requires_reconciliation');
    return receipt;
  }
  async retrieve(id: string, expectedDigest: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) throw new Error('invalid_upload_id');
    const r = await this.transport(`https://ar-io.dev/raw/${id}`, { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!r.ok || !r.body) return false;
    const chunks: Uint8Array[] = []; let size = 0; const reader = r.body.getReader();
    try { for (;;) { const c = await reader.read(); if (c.done) break; size += c.value.length; if (size > Number(this.env.MAX_ENVELOPE_BYTES)) { await reader.cancel(); throw new Error('retrieval_integrity_failed'); } chunks.push(c.value); } } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
    if (await envelopeDigest(bytes) !== expectedDigest) throw new Error('retrieval_integrity_failed');
    return true;
  }
}
export function checkedArchive(serialized: string, order: Order) {
  const envelope = parseEnvelope(JSON.parse(serialized));
  // Serialize with existing strict whitelist; exact supplied bytes are checked independently.
  serializeEnvelope(envelope);
  if (!order.archive || new TextEncoder().encode(serialized).length !== order.archive.bytes) throw new Error('archive_mismatch');
  return envelope;
}
