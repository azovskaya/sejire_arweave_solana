/** Operator-only, credential-free HTTP check for a NEW, EMPTY bootstrap.
 * This is not the authenticated production preflight or a ledger inspection.
 * Even disabled admission flags do not stop previously accepted obligations.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const API_ORIGIN = 'https://sejire-api.azovskaya.prod.page';
const SITE_ORIGIN = 'https://sejire.ar.io';
const DENIED_ORIGIN = 'https://sejire-bootstrap-probe.invalid';
const MAX_RESPONSE = 16384;
const failUnless = (ok, code) => { if (!ok) throw Error(code); };

async function json(response) {
  failUnless(/^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type') ?? ''), 'response_not_json');
  const length = response.headers.get('content-length');
  failUnless(length === null || /^\d+$/.test(length) && Number(length) <= MAX_RESPONSE, 'response_too_large');
  failUnless(response.body, 'empty_response');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE) { await reader.cancel(); throw Error('response_too_large'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw Error('response_invalid_json'); }
  failUnless(value && typeof value === 'object' && !Array.isArray(value), 'response_invalid_json');
  return value;
}

export async function verifyClosedBootstrap({ expectedCommit, fetcher = fetch }) {
  failUnless(typeof expectedCommit === 'string' && /^[a-f0-9]{40}$/.test(expectedCommit), 'full_source_commit_required');
  const checks = [];
  const report = () => ({
    schema: 'sejire/closed-bootstrap-probe/v1', checkedAt: new Date().toISOString(), apiOrigin: API_ORIGIN, expectedCommit,
    passed: checks.length === 8 && checks.every(x => x.ok), scope: 'credential-free-closed-http-boundary',
    methods: ['GET', 'OPTIONS'], credentialsSupplied: false, createsOrders: false, signsTransactions: false, publishesData: false,
    limitations: ['not-proof-of-empty-ledger-or-absent-secrets', 'not-proof-that-old-obligations-are-stopped', 'reported-commit-requires-build-history-match', 'not-production-acceptance'],
    checks,
  });
  const request = async (path, { method = 'GET', denied = false, requestedHeaders = '' } = {}) => {
    const headers = { Origin: denied ? DENIED_ORIGIN : SITE_ORIGIN, Accept: 'application/json' };
    if (method === 'OPTIONS') {
      headers['Access-Control-Request-Method'] = 'POST';
      headers['Access-Control-Request-Headers'] = requestedHeaders;
    }
    let response;
    try { response = await fetcher(API_ORIGIN + path, { method, headers, redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(8000) }); }
    catch { throw Error('request_failed'); }
    failUnless(!response.redirected && !(response.status >= 300 && response.status < 400), 'redirect_denied');
    return response;
  };
  const check = async (name, task) => {
    try { await task(); checks.push({ name, ok: true }); }
    catch (error) {
      const code = error instanceof Error && /^[a-z][a-z0-9_]{0,79}$/.test(error.message) ? error.message : 'request_failed';
      checks.push({ name, ok: false, code });
    }
  };
  const cors = response => {
    failUnless(response.headers.get('access-control-allow-origin') === SITE_ORIGIN, 'cors_origin_mismatch');
    failUnless((response.headers.get('vary') ?? '').split(',').some(x => x.trim().toLowerCase() === 'origin'), 'cors_vary_missing');
  };
  await check('reported_linux_source', async () => {
    const response = await request('/healthz'); failUnless(response.status === 200, 'health_http_error');
    const value = await json(response);
    failUnless(value.schema === 'sejire/service-health/v1' && value.status === 'ok' && value.runtime === 'linux-sqlite', 'health_runtime_mismatch');
    failUnless(value.sourceCommit === expectedCommit, 'service_source_mismatch');
  });
  if (!checks.at(-1).ok) return report();
  // The accepted runtime closes this OPTIONS route BEFORE all provider work
  // only when checkout, paid and contribution admissions are disabled. Stop
  // here if it is open; do not call a possibly enabled offer's network checks.
  await check('new_checkout_route_closed', async () => {
    const response = await request('/api/checkout/orders', { method: 'OPTIONS', requestedHeaders: 'authorization, content-type, idempotency-key' });
    failUnless(response.status === 404 && (await json(response)).error === 'not_found', 'checkout_route_not_closed');
  });
  if (!checks.at(-1).ok) return report();
  await check('paid_and_contribution_offers_disabled', async () => {
    const response = await request('/api/checkout/policy'); failUnless(response.status === 200, 'policy_http_error'); cors(response);
    const value = await json(response);
    failUnless(value.ready === false && value.reason === 'paid_disabled' && value.contributionReady === false && value.contributionReason === 'contribution_disabled', 'offers_not_disabled');
  });
  await check('fund_reports_unconfigured', async () => {
    const response = await request('/api/fund/status'); failUnless(response.status === 503, 'fund_not_unconfigured'); cors(response);
    failUnless((await json(response)).error === 'fund_not_configured', 'fund_not_unconfigured');
  });
  await check('admin_rejects_missing_credential', async () => {
    const response = await request('/api/fund/admin/service-readiness'); failUnless(response.status === 401, 'admin_not_protected'); cors(response);
    failUnless((await json(response)).error === 'admin_unauthorized', 'admin_not_protected');
  });
  await check('fund_preflight_preserves_cors', async () => {
    const response = await request('/api/fund/orders', { method: 'OPTIONS', requestedHeaders: 'authorization, content-type' });
    failUnless(response.status === 204, 'cors_http_error'); cors(response);
    const methods = (response.headers.get('access-control-allow-methods') ?? '').split(',').map(x => x.trim().toUpperCase());
    const headers = (response.headers.get('access-control-allow-headers') ?? '').split(',').map(x => x.trim().toLowerCase());
    failUnless(methods.includes('POST') && ['authorization', 'content-type'].every(x => headers.includes(x)), 'cors_headers_mismatch');
  });
  for (const [name, path, method] of [
    ['checkout_rejects_other_origin', '/api/checkout/policy', 'GET'],
    ['fund_rejects_other_origin', '/api/fund/orders', 'OPTIONS'],
  ]) await check(name, async () => {
    const response = await request(path, { method, denied: true, requestedHeaders: 'authorization, content-type' });
    failUnless(response.status === 403 && (await json(response)).error === 'origin_denied', 'unexpected_origin_accepted');
    failUnless(!response.headers.has('access-control-allow-origin'), 'rejected_origin_cors_exposed');
  });
  return report();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--expected-commit' || !/^[a-f0-9]{40}$/.test(args[1])) {
    console.error('usage: node verify-closed-bootstrap.mjs --expected-commit FULL_SOURCE_SHA'); process.exitCode = 2;
  } else {
    const report = await verifyClosedBootstrap({ expectedCommit: args[1] });
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
}
