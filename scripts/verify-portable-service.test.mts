import test from 'node:test';
import assert from 'node:assert/strict';
import { paidPolicyHash, SOLANA_GENESIS } from '../packages/checkout/paid';
import { verifyPortableService } from './verify-portable-service.mts';
const apiOrigin = 'https://sejire-api.azovskaya.prod.page', sourceCommit = 'a'.repeat(40), adminToken = 'Synthetic-preflight-only-credential';
const policy = { schema: 'sejire/checkout-policy/v1', version: 'synthetic-mainnet', network: 'mainnet-beta',
  genesisHash: SOLANA_GENESIS['mainnet-beta'], serviceLamports: '30000000',
  serviceRecipient: '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM',
  fundRecipient: '8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh',
  storage: { kind: 'arweave-direct', network: 'arweave.N.1', treasuryAddress: 'A'.repeat(43), budgetId: 'synthetic-mainnet', maxBytes: 524288, maxRewardWinston: '1000' } } as const;
async function fixture(overrides: Record<string, any> = {}) {
  const requests: { url: string; method: string; authorization: string | null }[] = [];
  const policyHash = await paidPolicyHash(policy);
  const fetcher = async (input: any, init: any) => {
    const url = new URL(String(input)), headers = new Headers(init.headers), method = init.method;
    requests.push({ url: url.href, method, authorization: headers.get('authorization') });
    assert.equal(url.origin, apiOrigin); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    assert.ok(['GET', 'OPTIONS'].includes(method)); assert.equal(headers.get('origin'), 'https://sejire.ar.io');
    const responseHeaders: Record<string, string> = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': overrides.cors ?? 'https://sejire.ar.io',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key' };
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
    const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: responseHeaders });
    if (url.pathname === '/healthz') return json({ schema: 'sejire/service-health/v1', status: 'ok', runtime: 'linux-sqlite', sourceCommit: overrides.commit ?? sourceCommit });
    if (url.pathname.startsWith('/api/fund/admin/') && !headers.has('authorization')) return json({ error: 'admin_unauthorized' }, overrides.unprotected ? 200 : 401);
    if (headers.has('authorization')) assert.equal(headers.get('authorization'), `Bearer ${adminToken}`);
    if (url.pathname === '/api/checkout/policy') return json({ ready: true, policy: overrides.policy ?? policy, policyHash: overrides.policyHash ?? policyHash });
    if (url.pathname === '/api/fund/admin/service-readiness') return json({ schema: 'sejire/service-readiness/v1', scope: 'configuration', ready: true, blockers: [],
      network: 'mainnet-beta', serviceLamports: '30000000', maxArchiveBytes: 524288 });
    if (url.pathname === '/api/fund/admin/readiness') return json({ signerVerified: true, fundApiEnabled: true, promo: { enabled: true },
      walletBalanceWinston: '10000', currentQuoteWinston: '1000', quoteBytes: overrides.quoteBytes ?? 524288,
      sharedReservedWinston: overrides.held ?? '0', effectiveAvailableWinston: overrides.effective ?? '10000', budgetRemainingWinston: overrides.budget ?? '10000' });
    throw Error('unexpected_route');
  };
  return { requests, fetcher: fetcher as typeof fetch };
}
test('preflight checks exact source, server auth, CORS and real Mainnet contract without signing routes or mutations', async () => {
  const f = await fixture(), report = await verifyPortableService({ apiOrigin, sourceCommit, adminToken, fetcher: f.fetcher });
  assert.equal(report.ready, true); assert.equal(report.checks.length, 7);
  assert.equal(report.requiresOwnerAcceptance.length, 3);
  assert.ok(f.requests.every(r => !/sign|prepare|session|\/orders\//.test(r.url)));
  assert.equal(f.requests.filter(r => r.authorization !== null).length, 2);
  assert.ok(!JSON.stringify(report).includes(adminToken));
});
test('missing private admin proof remains blocked while public diagnostics still run', async () => {
  const f = await fixture(), report = await verifyPortableService({ apiOrigin, sourceCommit, fetcher: f.fetcher });
  assert.equal(report.ready, false); assert.equal(report.checks.filter(x => x.code === 'admin_credential_required').length, 2);
  assert.ok(f.requests.every(r => r.authorization === null));
});
test('stale source, wildcard CORS, open admin, changed payment terms and depleted budget fail closed', async () => {
  for (const overrides of [{ commit: 'b'.repeat(40) }, { cors: '*' }, { unprotected: true },
    { policy: { ...policy, network: 'devnet', genesisHash: SOLANA_GENESIS.devnet } }, { policyHash: 'f'.repeat(64) }, { budget: '999' },
    { held: '10000', effective: '0' }, { held: '10000', effective: '10000' }, { effective: '999' }, { quoteBytes: 6144 }]) {
    const f = await fixture(overrides), report = await verifyPortableService({ apiOrigin, sourceCommit, adminToken, fetcher: f.fetcher });
    assert.equal(report.ready, false); assert.ok(report.checks.some(x => !x.ok));
  }
});
test('oversized, malformed and redirected responses are never accepted or echoed', async () => {
  for (const makeResponse of [
    () => new Response('{bad json', { headers: { 'content-type': 'application/json' } }),
    () => new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } }),
    () => { const r = new Response('{}', { headers: { 'content-type': 'application/json' } }); Object.defineProperty(r, 'redirected', { value: true }); return r; },
  ]) {
    const report = await verifyPortableService({ apiOrigin, sourceCommit, adminToken, fetcher: (async () => makeResponse()) as typeof fetch });
    assert.equal(report.ready, false); assert.ok(!JSON.stringify(report).includes('bad json'));
  }
});
