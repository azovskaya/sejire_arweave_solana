/** Read-only production preflight. Never creates an order, signs or uploads. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { paidPolicyHash, validatePaidPolicy } from '../packages/checkout/paid';
import { publicApiOrigin } from './portable-funded-profile.mjs';

const ORIGIN = 'https://sejire.ar.io';
const timeoutMs = 15000;
const MAX_RESPONSE = 65536;
type Json = Record<string, any>;
type Check = { name: string; ok: boolean; code?: string };
type Fetcher = typeof fetch;
const requireValue = (ok: unknown, code: string) => { if (!ok) throw Error(code); };
const uint = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,39})$/.test(value);

async function boundedJson(response: Response): Promise<Json> {
  requireValue(/^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type') ?? ''), 'response_not_json');
  requireValue(Number(response.headers.get('content-length') ?? 0) <= MAX_RESPONSE, 'response_too_large');
  if (!response.body) throw Error('empty_response');
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > MAX_RESPONSE) { await reader.cancel(); throw Error('response_too_large'); } parts.push(part.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  requireValue(result && typeof result === 'object' && !Array.isArray(result), 'response_invalid');
  return result;
}

export async function verifyPortableService({ apiOrigin, sourceCommit, adminToken, fetcher = fetch }:
  { apiOrigin: string; sourceCommit: string; adminToken?: string; fetcher?: Fetcher }) {
  publicApiOrigin(apiOrigin);
  requireValue(/^[a-f0-9]{40}$/.test(sourceCommit), 'full_source_commit_required');
  requireValue(adminToken === undefined || (adminToken.length >= 16 && !/[\r\n]/.test(adminToken)), 'invalid_admin_credential');
  const checks: Check[] = [];
  const check = async (name: string, task: () => Promise<void>) => {
    try { await task(); checks.push({ name, ok: true }); }
    catch (error) {
      // Only fixed local error codes are printed; never arbitrary HTTP bodies or credentials.
      const code = error instanceof Error && /^[a-z][a-z0-9_]{0,79}$/.test(error.message) ? error.message : 'request_failed';
      checks.push({ name, ok: false, code });
    }
  };
  const request = async (path: string, { authenticated = false, method = 'GET', preflightHeaders = '' } = {}) => {
    const headers: Record<string, string> = { Origin: ORIGIN, Accept: 'application/json' };
    if (authenticated) { if (!adminToken) throw Error('admin_credential_required'); headers.Authorization = `Bearer ${adminToken}`; }
    if (method === 'OPTIONS') { headers['Access-Control-Request-Method'] = 'POST'; headers['Access-Control-Request-Headers'] = preflightHeaders; }
    const response = await fetcher(`${apiOrigin}${path}`, { method, headers, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    requireValue(!response.redirected, 'redirect_denied');
    return response;
  };
  const cors = (response: Response) => requireValue(response.headers.get('access-control-allow-origin') === ORIGIN, 'cors_origin_mismatch');
  await check('exact_linux_source', async () => {
    const response = await request('/healthz'); requireValue(response.ok, 'health_http_error');
    const value = await boundedJson(response);
    requireValue(value.schema === 'sejire/service-health/v1' && value.status === 'ok' && value.runtime === 'linux-sqlite', 'health_runtime_mismatch');
    requireValue(value.sourceCommit === sourceCommit, 'service_source_mismatch');
  });
  for (const [name, path, allowed] of [
    ['paid_cors', '/api/checkout/orders', ['authorization', 'content-type', 'idempotency-key']],
    ['promo_cors', '/api/fund/orders', ['authorization', 'content-type']],
  ] as const) await check(name, async () => {
    const response = await request(path, { method: 'OPTIONS', preflightHeaders: allowed.join(', ') });
    requireValue(response.status === 204, 'cors_http_error'); cors(response);
    const methods = (response.headers.get('access-control-allow-methods') ?? '').split(',').map(x => x.trim().toUpperCase());
    const headers = (response.headers.get('access-control-allow-headers') ?? '').split(',').map(x => x.trim().toLowerCase());
    requireValue(methods.includes('POST') && allowed.every(x => headers.includes(x)), 'cors_headers_mismatch');
  });
  await check('admin_requires_server_authentication', async () => {
    const response = await request('/api/fund/admin/service-readiness');
    requireValue(response.status === 401 || response.status === 403, 'admin_not_protected');
  });
  await check('mainnet_paid_offer', async () => {
    const response = await request('/api/checkout/policy'); requireValue(response.ok, 'policy_http_error'); cors(response);
    const value = await boundedJson(response); requireValue(value.ready === true, 'paid_service_not_ready');
    const policy = validatePaidPolicy(value.policy);
    requireValue(policy.network === 'mainnet-beta' && policy.serviceLamports === '30000000' && policy.storage.maxBytes === 524288, 'paid_contract_mismatch');
    requireValue(await paidPolicyHash(policy) === value.policyHash, 'policy_digest_mismatch');
  });
  await check('server_configuration', async () => {
    const response = await request('/api/fund/admin/service-readiness', { authenticated: true });
    requireValue(response.ok, 'admin_readiness_http_error'); cors(response);
    const value = await boundedJson(response);
    requireValue(value.schema === 'sejire/service-readiness/v1' && value.scope === 'configuration', 'readiness_schema_mismatch');
    requireValue(value.ready === true && Array.isArray(value.blockers) && value.blockers.length === 0, 'configuration_not_ready');
    requireValue(value.network === 'mainnet-beta' && value.serviceLamports === '30000000' && value.maxArchiveBytes === 524288, 'configuration_contract_mismatch');
  });
  await check('promo_signer_and_funded_budget', async () => {
    // /readiness derives a public address and reads balance/price. It does not sign.
    const response = await request('/api/fund/admin/readiness', { authenticated: true });
    requireValue(response.ok, 'fund_readiness_http_error'); cors(response);
    const value = await boundedJson(response);
    requireValue(value.signerVerified === true && value.fundApiEnabled === true && value.promo?.enabled === true, 'fund_not_ready');
    requireValue(value.quoteBytes === 524288, 'fund_quote_size_mismatch');
    requireValue(uint(value.walletBalanceWinston) && uint(value.currentQuoteWinston) && uint(value.budgetRemainingWinston) &&
      uint(value.sharedReservedWinston) && uint(value.effectiveAvailableWinston), 'fund_amount_invalid');
    // Effective availability includes the conservative ceiling and ALL shared
    // paid/promo holds. A gross balance can already be fully committed.
    requireValue(BigInt(value.currentQuoteWinston) > 0n && BigInt(value.effectiveAvailableWinston) >= BigInt(value.currentQuoteWinston) &&
      BigInt(value.effectiveAvailableWinston) + BigInt(value.sharedReservedWinston) <= BigInt(value.walletBalanceWinston) &&
      BigInt(value.effectiveAvailableWinston) <= BigInt(value.budgetRemainingWinston), 'fund_budget_insufficient');
  });
  return { schema: 'sejire/portable-service-preflight/v1', checkedAt: new Date().toISOString(), apiOrigin, sourceCommit,
    ready: checks.every(x => x.ok), scope: 'read-only-configuration-and-network',
    createsOrders: false, signsTransactions: false, publishesData: false,
    requiresOwnerAcceptance: ['migrated-ledger-and-obligations', 'always-on-host-and-restore-drill', 'real-mainnet-and-promo-save-and-recovery'], checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await verifyPortableService({ apiOrigin: process.env.SEJIRE_FUNDED_API_ORIGIN ?? '',
    sourceCommit: process.env.SEJIRE_EXPECTED_SERVICE_COMMIT ?? '', adminToken: process.env.SEJIRE_PREFLIGHT_ADMIN_TOKEN });
  const path = resolve('.cache/portable-service/readiness.json'); await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 1;
}
