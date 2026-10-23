import { authorizeAdmin } from '../adminAuth';
import { DurableOrderStore } from './durableStore';
import type { PaidEnv } from './paidPolicy';
import type { SolanaRecipientAdminView, SolanaRecipientSettings } from '../../../../packages/checkout/recipients';

export const RECIPIENT_ADMIN_PATH = '/api/fund/admin/solana-recipients';
export type RecipientAdminEnv = PaidEnv & {
  ADMIN_TOKEN?: string; IDEMPOTENCY?: KVNamespace;
  CHECKOUT_LEDGER?: DurableObjectNamespace; CHECKOUT_ALLOWED_ORIGINS?: string;
};
export function recipientAdminView(env: RecipientAdminEnv, settings: SolanaRecipientSettings | null): SolanaRecipientAdminView {
  const serviceRecipient = settings?.serviceRecipient ?? env.CHECKOUT_SERVICE_RECIPIENT ?? '';
  const fundRecipient = settings?.fundRecipient ?? env.CHECKOUT_FUND_RECIPIENT ?? '';
  return { schema: 'sejire/sol-recipients-admin/v1', revision: settings?.revision ?? 0,
    serviceRecipient, fundRecipient, updatedAt: settings?.updatedAt ?? null,
    source: settings ? 'admin' : serviceRecipient || fundRecipient ? 'deployment' : 'not-configured',
    network: env.CHECKOUT_PAID_NETWORK === 'devnet' || env.CHECKOUT_PAID_NETWORK === 'mainnet-beta' ? env.CHECKOUT_PAID_NETWORK : null,
    paymentEnabled: env.CHECKOUT_PAID_ENABLED === 'true', executionEnabled: env.CHECKOUT_PAID_EXECUTION_ENABLED === 'true',
    contributionEnabled: env.CHECKOUT_CONTRIBUTION_ENABLED === 'true' };
}
export function recipientHeaders(request: Request, env: RecipientAdminEnv): Record<string, string> | null {
  const allowed = (env.CHECKOUT_ALLOWED_ORIGINS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const origin = request.headers.get('Origin');
  if (!allowed.length || origin && !allowed.includes(origin)) return null;
  return { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
    ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type' } : {}) };
}
async function readSettingsBody(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get('Content-Type') ?? '') || request.headers.has('Content-Encoding')) throw Error('json_required');
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > 2048)) throw Error('request_too_large');
  if (!request.body) throw Error('invalid_solana_recipient_settings');
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 2048) { await reader.cancel(); throw Error('request_too_large'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw Error('invalid_solana_recipient_settings'); }
}
/** Public-address configuration, protected by the SAME server admin authentication. */
export async function recipientAdminApi(request: Request, env: RecipientAdminEnv): Promise<Response> {
  const headers = recipientHeaders(request, env);
  const reply = (status: number, data: unknown) => new Response(status === 204 ? null : JSON.stringify(data),
    { status, headers: headers ?? { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  if (!headers) return reply(403, { error: 'origin_denied' });
  const url = new URL(request.url);
  if (url.pathname !== RECIPIENT_ADMIN_PATH || url.search || url.hash) return reply(400, { error: 'invalid_request' });
  if (request.method === 'OPTIONS') return reply(204, null);
  if (!['GET', 'POST'].includes(request.method)) return reply(405, { error: 'method_not_allowed' });
  try {
    if (await authorizeAdmin(request, env) !== 'ok') return reply(401, { error: 'admin_unauthorized' });
    if (!env.CHECKOUT_LEDGER) return reply(503, { error: 'checkout_not_configured' });
    const ledger = new DurableOrderStore(env.CHECKOUT_LEDGER);
    const ip = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.headers.get('CF-Connecting-IP') ?? 'missing-ingress-ip')));
    const bucket = Array.from(ip, x => x.toString(16).padStart(2, '0')).join('');
    await ledger.call({ action: 'fundRate', bucket: `sol-recipients-admin:${bucket}`, limit: 40 });
    const settings = request.method === 'GET'
      ? await ledger.call<SolanaRecipientSettings | null>({ action: 'recipientSettingsGet' })
      : await ledger.call<SolanaRecipientSettings>({ action: 'recipientSettingsSave', input: await readSettingsBody(request) });
    return reply(200, recipientAdminView(env, settings));
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const bad = ['invalid_solana_recipient', 'solana_recipient_roles_overlap', 'solana_test_recipient_forbidden', 'invalid_solana_recipient_settings', 'json_required'];
    if (bad.includes(code)) return reply(400, { error: code });
    if (code === 'solana_recipient_revision_conflict') return reply(409, { error: code });
    if (code === 'request_too_large') return reply(413, { error: code });
    if (code === 'rate_limited') return reply(429, { error: code });
    return reply(503, { error: 'solana_recipient_settings_unavailable' });
  }
}
