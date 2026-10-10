import { assertBase58, createOrder, type Order } from '../../../../packages/checkout/order';
import { parseAmount } from '../../../../packages/checkout/amounts';
import { DurableOrderStore } from './durableStore';
import type { AtomicOrderStore, StoredOrder, CommitResult } from './store';
import type { ValidatedPayment } from './paymentValidator';
import { reconcilePayment, type TrustedTransactionReader } from './reconciliation';
import { SolanaRpcReader } from './rpcReader';
import { RpcPaymentPreparer, type PaymentPreparer } from './paymentPreparation';
import { TestnetPreservationService, checkedArchive, type PreservationEnv, type PreservationService, type UploadPlan, type UploadAcceptance } from './preservation';
import { envelopeDigest } from '../../../web/src/lib/solana/policy';

export type CheckoutApiEnv = PreservationEnv & {
  CHECKOUT_API_ENABLED?: string;
  CHECKOUT_LEDGER?: DurableObjectNamespace;
  CHECKOUT_ALLOWED_ORIGINS?: string;
  CHECKOUT_SERVICE_RECIPIENT?: string;
  CHECKOUT_FUND_RECIPIENT?: string;
  CHECKOUT_POLICY_VERSION?: string;
};
const SERVICE_PRICE_LAMPORTS = '30000000'; // Server policy: fixed per new order; old orders stay immutable.
const PREFIX = '/api/checkout';
const SESSION_MS = 30 * 86400000;
const BODY_BYTES = 4096;
class HttpError extends Error { constructor(readonly status: number, code: string) { super(code); } }
const bad = (code = 'invalid_request'): never => { throw new HttpError(400, code); };
function fields(value: unknown, allowed: string[], required: string[] = allowed): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad();
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(obj, k))) return bad('forbidden_or_missing_field');
  return obj;
}
async function body(request: Request, maxBytes = BODY_BYTES): Promise<unknown> {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get('Content-Type') ?? '')) throw new HttpError(415, 'json_required');
  if (request.headers.has('Content-Encoding')) throw new HttpError(415, 'encoding_not_supported');
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new HttpError(413, 'request_too_large');
  if (!request.body) return bad();
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new HttpError(413, 'request_too_large'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buffer)); }
  catch { return bad('invalid_json'); }
}
function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
function reference(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32)), alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n; for (const byte of bytes) n = (n << 8n) + BigInt(byte);
  let out = ''; for (; n > 0n; n /= 58n) out = alphabet[Number(n % 58n)] + out;
  const first = bytes.findIndex(b => b !== 0);
  return '1'.repeat(first < 0 ? bytes.length : first) + out;
}
async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
function intent(value: unknown) {
  const input = fields(value, ['kind', 'contribution', 'payer', 'archive'], ['kind', 'contribution', 'payer']);
  if (input.kind !== 'preservation' && input.kind !== 'contribution') return bad('invalid_kind');
  if (typeof input.payer !== 'string' || typeof input.contribution !== 'string') return bad();
  assertBase58(input.payer, 32);
  const contribution = parseAmount(input.contribution, 9);
  if (input.kind === 'contribution') {
    if (input.archive !== undefined || contribution === '0') return bad('invalid_contribution_order');
    return { kind: input.kind, payer: input.payer, contribution } as const;
  }
  const archive = fields(input.archive, ['digest', 'bytes']);
  if (typeof archive.digest !== 'string' || !/^[a-f0-9]{64}$/.test(archive.digest) || typeof archive.bytes !== 'number' || !Number.isSafeInteger(archive.bytes) || archive.bytes <= 0) return bad('invalid_archive');
  return { kind: input.kind, payer: input.payer, contribution, archive: { digest: archive.digest, bytes: archive.bytes } } as const;
}
/** Scoped server port: even after outer HTTP auth, pending writes re-check ownership in SQLite. */
class OwnedOrders implements AtomicOrderStore {
  constructor(private readonly ledger: DurableOrderStore, private readonly hash: string) {}
  create(): Promise<void> { throw new Error('internal_method_unavailable'); }
  async snapshot(id: string): Promise<{ record: StoredOrder; verification: unknown }> { return this.ledger.call({ action: 'apiGet', hash: this.hash, id }); }
  async get(id: string): Promise<StoredOrder> { return (await this.snapshot(id)).record; }
  beginReconciliation(id: string, signature: string): Promise<StoredOrder> { return this.ledger.call({ action: 'apiBegin', hash: this.hash, id, signature }); }
  commitPayment(payment: ValidatedPayment): Promise<CommitResult> { return this.ledger.call({ action: 'apiCommit', hash: this.hash, payment }); }
}
/** Real public handlers. readerFactory is a server dependency, NEVER selected via browser fields.
 * Fixtures inject it only from the local test entry; production entry uses pinned SolanaRpcReader.
 */
export async function checkoutApi(request: Request, env: CheckoutApiEnv,
  readerFactory: () => TrustedTransactionReader = () => new SolanaRpcReader({ network: 'devnet' }),
  preservation: PreservationService = new TestnetPreservationService(env),
  preparer: PaymentPreparer = new RpcPaymentPreparer(),
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return null;
  let origin: string | null = null;
  const reply = (status: number, payload: unknown): Response => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin',
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" };
    if (origin) Object.assign(headers, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key' });
    if (status === 429) headers['Retry-After'] = '60';
    return new Response(status === 204 ? null : JSON.stringify(payload), { status, headers });
  };
  if (env.CHECKOUT_API_ENABLED !== 'true') return reply(404, { error: 'not_found' });
  try {
    if (!env.CHECKOUT_LEDGER || !env.CHECKOUT_SERVICE_RECIPIENT || !env.CHECKOUT_FUND_RECIPIENT || !env.CHECKOUT_POLICY_VERSION || !env.CHECKOUT_ALLOWED_ORIGINS) throw new HttpError(503, 'checkout_not_configured');
    const origins = env.CHECKOUT_ALLOWED_ORIGINS.split(',');
    if (origins.some(o => { try { return new URL(o).origin !== o || (!o.startsWith('https://') && !o.startsWith('http://localhost:') && !o.startsWith('http://127.0.0.1:')); } catch { return true; } })) throw new HttpError(503, 'checkout_not_configured');
    const requestedOrigin = request.headers.get('Origin');
    if (requestedOrigin && !origins.includes(requestedOrigin)) throw new HttpError(403, 'origin_denied');
    origin = requestedOrigin;
    if (url.search || url.hash) return bad('query_not_supported'); // No secrets in URL.
    const match = /^\/api\/checkout\/orders\/([a-f0-9]{32})(?:\/(verify|reconcile|reserve|prepare|execute))?$/.exec(url.pathname);
    const sessionRoute = url.pathname === PREFIX + '/session';
    const createRoute = url.pathname === PREFIX + '/orders';
    if (!match && !sessionRoute && !createRoute) return reply(404, { error: 'not_found' });
    const method = match && !match[2] ? 'GET' : 'POST';
    if (request.method === 'OPTIONS') return reply(204, null);
    if (request.method !== method) return reply(405, { error: 'method_not_allowed' });
    const ledger = new DurableOrderStore(env.CHECKOUT_LEDGER);
    // This header is trusted ONLY behind Cloudflare's ingress. Ignore X-Forwarded-For and client IP fields.
    // Missing header uses a shared bucket (fail closed), not a new arbitrary identity.
    const ip = await digest(request.headers.get('CF-Connecting-IP') ?? 'missing-ingress-ip');
    await ledger.call({ action: 'apiRate', buckets: ['all', `ingress:${ip}`], limit: 600 });
    if (sessionRoute) {
      await ledger.call({ action: 'apiRate', buckets: ['sessions:all'], limit: 100 });
      await ledger.call({ action: 'apiRate', buckets: [`sessions:${ip}`], limit: 10 });
      fields(await body(request), []);
      const token = randomHex(32), hash = await digest(token), expiresAt = Date.now() + SESSION_MS;
      await ledger.call({ action: 'apiIssue', hash, expiresAt });
      return reply(201, { accessToken: token, expiresAt });
    }
    const auth = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('Authorization') ?? '');
    if (!auth) throw new HttpError(401, 'unauthorized');
    const hash = await digest(auth[1]);
    await ledger.call({ action: 'apiAuth', hash });
    const owned = new OwnedOrders(ledger, hash);
    if (createRoute) {
      await ledger.call({ action: 'apiRate', buckets: [`create:${hash}`], limit: 20 });
      await ledger.call({ action: 'apiRate', buckets: [`create-ip:${ip}`], limit: 60 });
      const key = request.headers.get('Idempotency-Key');
      if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) return bad('invalid_idempotency_key');
      const input = intent(await body(request)), now = Date.now();
      const existing = await ledger.call({ action: 'apiExisting', hash, key, intent: JSON.stringify(input) });
      if (existing) return reply(200, existing);
      const order: Order = createOrder({ id: randomHex(16), kind: input.kind, payer: input.payer, reference: reference(), network: 'devnet', asset: 'SOL',
        createdAt: now, expiresAt: now + 15 * 60000, policyVersion: env.CHECKOUT_POLICY_VERSION,
        servicePayment: { amount: input.kind === 'preservation' ? SERVICE_PRICE_LAMPORTS : '0', recipient: env.CHECKOUT_SERVICE_RECIPIENT },
        fundContribution: { amount: input.contribution, recipient: env.CHECKOUT_FUND_RECIPIENT },
        ...('archive' in input ? { archive: input.archive } : {}) });
      if (order.archive) await preservation.ready(order.archive.bytes);
      await preparer.prepare(order); // Required accounts and balances BEFORE proposing payment.
      const result = await ledger.call<{ reused: boolean; record: StoredOrder }>({ action: 'apiCreate', hash, key, intent: JSON.stringify(input), order });
      return reply(result.reused ? 200 : 201, result);
    }
    const id = match![1], snapshot = await owned.snapshot(id); // B cannot change A's pendingSignature or even invoke RPC.
    await ledger.call({ action: 'apiRate', buckets: [`${method === 'GET' ? 'read' : 'verify'}:${hash}`], limit: method === 'GET' ? 120 : 30 });
    if (method === 'GET') return reply(200, snapshot);
    if (match![2] === 'reserve') {
      const input = fields(await body(request), ['signature']);
      if (typeof input.signature !== 'string') return bad('invalid_signature');
      assertBase58(input.signature, 64);
      if (snapshot.record.order.expiresAt <= Date.now() && !snapshot.record.pendingSignature) throw new HttpError(409, 'order_expired');
      await owned.beginReconciliation(id, input.signature);
      return reply(202, { status: 'requires-reconciliation', ...await owned.snapshot(id) });
    }
    if (match![2] === 'prepare') {
      fields(await body(request), []);
      if (snapshot.record.pendingSignature || snapshot.record.payment) throw new HttpError(409, 'previous_payment_unresolved');
      if (snapshot.record.order.expiresAt <= Date.now()) throw new HttpError(409, 'order_expired');
      if (snapshot.record.order.archive) await preservation.ready(snapshot.record.order.archive.bytes);
      return reply(200, await preparer.prepare(snapshot.record.order));
    }
    if (match![2] === 'execute') {
      if (!snapshot.record.payment || snapshot.record.order.kind !== 'preservation') throw new HttpError(409, 'preservation_not_paid');
      const max = Number(env.MAX_ENVELOPE_BYTES);
      if (!Number.isSafeInteger(max) || max <= 0 || max > 10 * 1024 * 1024) throw new HttpError(503, 'checkout_not_configured');
      const input = fields(await body(request, max * 2 + BODY_BYTES), ['serialized']);
      if (typeof input.serialized !== 'string') return bad();
      checkedArchive(input.serialized, snapshot.record.order);
      if (await envelopeDigest(input.serialized) !== snapshot.record.order.archive?.digest) return bad('archive_mismatch');
      const execution = (snapshot as { execution?: { retrieved?: boolean } }).execution;
      if (execution?.retrieved) return reply(200, { status: 'retrieved-and-verified', ...snapshot });
      type Claim = { busy?: boolean; needsPlan?: boolean; plan?: UploadPlan; accepted?: UploadAcceptance | null };
      let claim = await ledger.call<Claim>({ action: 'apiClaim', hash, id });
      if (claim.needsPlan) {
        const plan = await preservation.sign(snapshot.record.order, input.serialized);
        claim = await ledger.call<Claim>({ action: 'apiClaim', hash, id, plan });
      }
      if (claim.busy || !claim.plan) return reply(202, { status: 'execution-pending', ...await owned.snapshot(id) });
      let accepted = claim.accepted ?? undefined;
      let retrieved = false;
      try {
        // Persisted signed item is reused after loss/restart. Never construct a new upload/payment.
        if (!accepted) accepted = await preservation.upload(claim.plan);
        // Save Turbo acceptance BEFORE retrieval; lost retrieval response must not cause re-upload.
        await ledger.call({ action: 'apiFinish', hash, id, accepted, retrieved: false });
        retrieved = await preservation.retrieve(claim.plan.id, snapshot.record.order.archive!.digest);
      } catch { /* External outcome unknown; retain signed item/id and reconcile, not unpaid. */ }
      const saved = await ledger.call({ action: 'apiFinish', hash, id, ...(accepted ? { accepted } : {}), retrieved });
      return reply(retrieved ? 200 : 202, { status: retrieved ? 'retrieved-and-verified' : 'upload-requires-reconciliation', ...saved as object });
    }
    let signature: string;
    if (match![2] === 'verify') {
      const input = fields(await body(request), ['signature']);
      if (typeof input.signature !== 'string') return bad('invalid_signature');
      signature = input.signature; assertBase58(signature, 64);
    } else {
      fields(await body(request), []);
      if (!snapshot.record.pendingSignature) throw new HttpError(409, 'no_pending_payment');
      signature = snapshot.record.pendingSignature;
    }
    const result = await reconcilePayment(owned, readerFactory(), id, signature);
    await ledger.call({ action: 'apiResult', hash, id, result: { status: result.status, ...('reason' in result ? { reason: result.reason } : {}) } });
    return reply(result.status === 'requires-reconciliation' ? 202 : 200, { status: result.status, ...('reason' in result ? { reason: result.reason } : {}), ...await owned.snapshot(id) });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (error instanceof HttpError) return reply(error.status, { error: code });
    if (code === 'unauthorized') return reply(401, { error: code });
    if (code === 'order_not_found') return reply(404, { error: code });
    if (code === 'rate_limited') return reply(429, { error: code });
    if (['idempotency_conflict', 'previous_payment_unresolved', 'order_already_paid', 'preservation_not_paid'].includes(code)) return reply(409, { error: code });
    if (['invalid_base58', 'invalid_amount', 'excess_precision', 'technical_amount_overflow', 'invalid_contribution_order', 'recipient_roles_overlap', 'invalid_order_id_or_policy', 'archive_mismatch', 'invalid_envelope', 'envelope_too_large'].includes(code)) return reply(400, { error: code });
    // Transport/commit failure can mean commit succeeded. No unpaid claim, no fresh-payment instruction.
    return reply(503, { error: 'checkout_requires_reconciliation' });
  }
}
