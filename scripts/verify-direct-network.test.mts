import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_DIRECT_NODES } from '../apps/web/src/lib/directArweave/network.ts';
import { PROBE_BYTES, PROBE_ORIGIN, REQUIRED_READY_NODES, verifyDirectNetwork } from './verify-direct-network.mts';

function healthy(url: URL, method: string, headers: HeadersInit = { 'access-control-allow-origin': '*' }) {
  if (method === 'OPTIONS') return new Response(null, { status: 204,
    headers: { ...Object.fromEntries(new Headers(headers)), 'access-control-allow-headers': 'Content-Type' } });
  const body = url.pathname === '/info' ? JSON.stringify({ network: 'arweave.N.1' })
    : url.pathname === '/tx_anchor' ? 'A'.repeat(64) : '123456';
  return new Response(body, { headers });
}

test('only one bounded GET/OPTIONS request per configured endpoint is made, with no body or wallet address', async () => {
  const calls: string[] = [];
  const report = await verifyDirectNetwork({ fetcher: (async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? '';
    assert(['GET', 'OPTIONS'].includes(method)); assert.equal(init?.body, undefined);
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error'); assert(init?.signal);
    assert.equal(new Headers(init?.headers).get('Origin'), PROBE_ORIGIN);
    assert(DEFAULT_DIRECT_NODES.includes(url.origin as typeof DEFAULT_DIRECT_NODES[number]));
    if (method === 'OPTIONS') {
      assert.equal(new Headers(init?.headers).get('Access-Control-Request-Method'), 'POST');
      assert.equal(new Headers(init?.headers).get('Access-Control-Request-Headers'), 'content-type');
    }
    assert(['/info', '/tx_anchor', `/price/${PROBE_BYTES}`, '/tx', '/chunk'].includes(url.pathname));
    calls.push(method + ' ' + url.href);
    return healthy(url, method);
  }) as typeof fetch });
  assert.equal(calls.length, DEFAULT_DIRECT_NODES.length * 5); assert.equal(new Set(calls).size, calls.length);
  assert.equal(report.status, 'PASS'); assert.equal(report.readyNodes, DEFAULT_DIRECT_NODES.length);
  assert.equal(report.requiredReadyNodes, REQUIRED_READY_NODES); assert.equal(REQUIRED_READY_NODES, 2);
  assert.equal(report.readOnly, true); assert.equal(report.uploadAttempted, false); assert.equal(report.walletChecked, false);
});

test('checks each node sequentially while keeping the two nodes concurrent', async () => {
  const active = new Set<string>(), calls: string[] = [], overlaps: string[] = [];
  let peakActiveNodes = 0;
  const report = await verifyDirectNetwork({ fetcher: (async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? '';
    calls.push(method + ' ' + url.href);
    if (active.has(url.origin)) {
      overlaps.push(url.origin);
      throw Error('synthetic overlapping TLS connections');
    }
    active.add(url.origin);
    peakActiveNodes = Math.max(peakActiveNodes, active.size);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      return healthy(url, method);
    } finally { active.delete(url.origin); }
  }) as typeof fetch });
  assert.equal(report.status, 'PASS');
  assert.deepEqual(overlaps, []);
  assert.equal(peakActiveNodes, 2, 'different configured nodes must still be checked concurrently');
  assert.equal(calls.length, DEFAULT_DIRECT_NODES.length * 5);
  assert.equal(new Set(calls).size, calls.length, 'every endpoint is requested exactly once');
  for (const node of DEFAULT_DIRECT_NODES) {
    assert.deepEqual(calls.filter(call => call.includes(node + '/')), [
      `GET ${node}/info`, `GET ${node}/tx_anchor`, `GET ${node}/price/${PROBE_BYTES}`,
      `OPTIONS ${node}/tx`, `OPTIONS ${node}/chunk`,
    ]);
  }
  assert(report.nodes.every(node => node.checks.length === 5 && node.checks.every(check => check.ready)));
});

test('one healthy default fails release readiness and does not claim redundant availability', async () => {
  const report = await verifyDirectNetwork({ fetcher: (async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === DEFAULT_DIRECT_NODES[0]) return healthy(url, init?.method ?? '', { 'access-control-allow-origin': PROBE_ORIGIN });
    return new Response('<html>not a native node</html>', { headers: { 'access-control-allow-origin': '*' } });
  }) as typeof fetch });
  assert.equal(report.status, 'FAIL'); assert.equal(report.readyNodes, 1); assert.equal(report.redundancy, 'redundancyNotConfirmed');
  assert(report.nodes.slice(1).every(node => node.readiness === 'unavailable'));
});

test('HTML, wrong networks, invalid price or anchor, and denied CORS/preflight cannot pass', async () => {
  for (const failure of ['network', 'price', 'anchor', 'origin', 'preflight', 'headers', 'oversized', 'timeout']) {
    const report = await verifyDirectNetwork({ fetcher: (async (input, init) => {
      const url = new URL(String(input)), method = init?.method ?? '';
      if (failure === 'timeout') throw Error('synthetic transport error, never print this body');
      if (failure === 'origin') return healthy(url, method, { 'access-control-allow-origin': 'https://unrelated.example' });
      if (method === 'OPTIONS' && failure === 'preflight') return new Response(null, { status: 405, headers: { 'access-control-allow-origin': '*' } });
      if (method === 'OPTIONS' && failure === 'headers') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'x-other' } });
      if (url.pathname === '/info' && failure === 'network') return new Response('{"network":"other"}', { headers: { 'access-control-allow-origin': '*' } });
      if (url.pathname === `/price/${PROBE_BYTES}` && failure === 'price') return new Response('0', { headers: { 'access-control-allow-origin': '*' } });
      if (url.pathname === '/tx_anchor' && failure === 'anchor') return new Response('short', { headers: { 'access-control-allow-origin': '*' } });
      if (url.pathname === '/info' && failure === 'oversized') return new Response('x'.repeat(16_385), { headers: { 'access-control-allow-origin': '*' } });
      return healthy(url, method);
    }) as typeof fetch });
    assert.equal(report.status, 'FAIL', failure); assert.equal(report.readyNodes, 0, failure);
    assert.equal(report.redundancy, 'redundancyNotConfirmed');
    assert(!JSON.stringify(report).includes('never print this body'));
  }
});
