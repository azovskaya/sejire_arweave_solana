import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { API_ORIGIN, verifyClosedBootstrap } from './verify-closed-bootstrap.mjs';

const expectedCommit = 'ef0252025c32687dce018368ea94d74af2728c66';
const siteOrigin = 'https://sejire.ar.io';
const allowed = new Set(['/healthz', '/api/checkout/policy', '/api/checkout/orders', '/api/fund/status', '/api/fund/admin/service-readiness', '/api/fund/orders']);
const reply = (status, value, cors = true) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers: {
  'Content-Type': 'application/json', Vary: 'Origin',
  ...(cors ? { 'Access-Control-Allow-Origin': siteOrigin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' } : {}),
} });
function fixture(url, init) {
  const target = new URL(url);
  assert.equal(target.origin, API_ORIGIN); assert.ok(allowed.has(target.pathname)); assert.equal(target.search, '');
  assert.ok(['GET', 'OPTIONS'].includes(init.method)); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
  assert.equal(init.body, undefined); assert.equal(new Headers(init.headers).has('authorization'), false);
  assert.equal(new Headers(init.headers).has('cookie'), false);
  if (target.pathname !== '/healthz' && init.headers.Origin !== siteOrigin) return reply(403, { error: 'origin_denied' }, false);
  switch (target.pathname) {
    case '/healthz': return reply(200, { schema: 'sejire/service-health/v1', status: 'ok', runtime: 'linux-sqlite', sourceCommit: expectedCommit }, false);
    case '/api/checkout/policy': return reply(200, { ready: false, reason: 'paid_disabled', contributionReady: false, contributionReason: 'contribution_disabled' });
    case '/api/checkout/orders': return reply(404, { error: 'not_found' }, false);
    case '/api/fund/status': return reply(503, { error: 'fund_not_configured' });
    case '/api/fund/admin/service-readiness': return reply(401, { error: 'admin_unauthorized' });
    case '/api/fund/orders': return reply(204);
    default: assert.fail('unexpected route');
  }
}
const run = fetcher => verifyClosedBootstrap({ expectedCommit, fetcher });
const mutate = (path, replacement) => async (url, init) => new URL(url).pathname === path && init.headers.Origin === siteOrigin
  ? replacement(url, init) : fixture(url, init);

test('closed bootstrap uses only the fixed GET/OPTIONS boundary with no credentials', async () => {
  const calls = [];
  const result = await run(async (url, init) => { calls.push({ url, method: init.method }); return fixture(url, init); });
  assert.equal(result.passed, true); assert.equal(calls.length, 8); assert.equal(result.checks.length, 8);
  assert.equal(result.scope, 'credential-free-closed-http-boundary');
  assert.ok(result.limitations.includes('not-proof-that-old-obligations-are-stopped'));
});

test('requires a full expected source commit before any request', async () => {
  let calls = 0;
  await assert.rejects(() => verifyClosedBootstrap({ expectedCommit: 'ef025202', fetcher: async () => { calls++; } }), /full_source_commit_required/);
  assert.equal(calls, 0);
});

test('detects wrong build, enabled offers, reachable checkout and open admin', async () => {
  for (const [path, replacement, failed] of [
    ['/healthz', () => reply(200, { schema: 'sejire/service-health/v1', status: 'ok', runtime: 'linux-sqlite', sourceCommit: 'a'.repeat(40) }), 'reported_linux_source'],
    ['/api/checkout/policy', () => reply(200, { ready: true, contributionReady: false }), 'paid_and_contribution_offers_disabled'],
    ['/api/checkout/orders', () => reply(204), 'new_checkout_route_closed'],
    ['/api/fund/admin/service-readiness', () => reply(200, { ready: true }), 'admin_rejects_missing_credential'],
  ]) {
    const result = await run(mutate(path, replacement));
    assert.equal(result.passed, false); assert.equal(result.checks.find(x => x.name === failed).ok, false);
  }
  const calls = [];
  const open = await run(async (url, init) => {
    calls.push(new URL(url).pathname);
    return new URL(url).pathname === '/api/checkout/orders' ? reply(204) : fixture(url, init);
  });
  assert.equal(open.passed, false);
  assert.deepEqual(calls, ['/healthz', '/api/checkout/orders']);
});

test('rejects redirects, platform HTML errors, invalid JSON and bounded response violations', async () => {
  for (const [replacement, code] of [
    [() => new Response(null, { status: 302, headers: { Location: 'https://example.invalid/' } }), 'redirect_denied'],
    [() => new Response('<html>platform gateway page</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }), 'response_not_json'],
    [() => new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } }), 'response_invalid_json'],
    [() => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Length': '16385' } }), 'response_too_large'],
    [() => new Response(' '.repeat(16385), { status: 200, headers: { 'Content-Type': 'application/json' } }), 'response_too_large'],
  ]) {
    const result = await run(mutate('/healthz', replacement));
    assert.equal(result.passed, false); assert.equal(result.checks[0].code, code);
  }
  const network = await run(async () => { throw Error('transport credentials or response details must never leak'); });
  assert.ok(network.checks.every(x => x.code === 'request_failed'));
});

test('rejects wildcard CORS and exposes no allowed origin for a denied request', async () => {
  const wildcard = await run(mutate('/api/checkout/policy', (url, init) => {
    const response = fixture(url, init); response.headers.set('Access-Control-Allow-Origin', '*'); return response;
  }));
  assert.equal(wildcard.passed, false); assert.equal(wildcard.checks.find(x => x.name === 'paid_and_contribution_offers_disabled').code, 'cors_origin_mismatch');
  const exposed = await run(async (url, init) => {
    const response = fixture(url, init);
    if (init.headers.Origin !== siteOrigin) response.headers.set('Access-Control-Allow-Origin', init.headers.Origin);
    return response;
  });
  assert.equal(exposed.passed, false);
  assert.equal(exposed.checks.filter(x => x.code === 'rejected_origin_cors_exposed').length, 2);
});

test('matches the real compiled service with a synthetic empty ledger and all outbound fetch blocked',
  { skip: process.env.SEJIRE_BOOTSTRAP_TEST_BUNDLE ? false : 'Set SEJIRE_BOOTSTRAP_TEST_BUNDLE to an accepted locally compiled server.mjs', timeout: 20000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sejire-closed-bootstrap-'));
    const reserving = createServer(); reserving.listen(0, '127.0.0.1'); await once(reserving, 'listening');
    const port = reserving.address().port; await new Promise(resolve => reserving.close(resolve));
    const bundle = pathToFileURL(resolve(process.env.SEJIRE_BOOTSTRAP_TEST_BUNDLE)).href;
    const code = 'globalThis.fetch=async()=>{console.error("unexpected_outbound_request");throw Error("test_outbound_disabled");}; await import(' + JSON.stringify(bundle) + ');';
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: {
      PATH: process.env.PATH, SEJIRE_LINUX_DB: join(directory, 'ledger.sqlite'), SEJIRE_LINUX_HOST: '127.0.0.1', SEJIRE_LINUX_PORT: String(port),
      SEJIRE_BUILD_COMMIT: expectedCommit, CHECKOUT_ALLOWED_ORIGINS: siteOrigin,
      CHECKOUT_API_ENABLED: 'false', CHECKOUT_PAID_ENABLED: 'false', CHECKOUT_CONTRIBUTION_ENABLED: 'false',
      CHECKOUT_PAID_EXECUTION_ENABLED: 'false', FUND_API_ENABLED: 'false',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    try {
      const deadline = Date.now() + 8000;
      while (!output.includes('SEJIRE portable service listening') && Date.now() < deadline) {
        assert.equal(child.exitCode, null, output); await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.match(output, /SEJIRE portable service listening/);
      const result = await run((url, init) => {
        const target = new URL(url); assert.equal(target.origin, API_ORIGIN); assert.ok(allowed.has(target.pathname));
        return fetch(`http://127.0.0.1:${port}${target.pathname}`, init);
      });
      assert.equal(result.passed, true, JSON.stringify(result.checks));
      assert.doesNotMatch(output, /unexpected_outbound_request/);
      const exited = once(child, 'exit'); child.kill('SIGTERM'); const [exitCode] = await exited; assert.equal(exitCode, 0);
    } finally {
      if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
      await rm(directory, { recursive: true, force: true });
    }
  });
