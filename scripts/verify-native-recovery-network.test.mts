import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_DIRECT_NODES } from '../apps/web/src/lib/directArweave/network.ts';
import { digest } from './permaweb-release.mjs';
import { ORIGIN, verifyNativeRecoveryNetwork } from './verify-native-recovery-network.mts';

const bytes = Buffer.from('synthetic encrypted archive bytes, no family or wallet secret');
const id = 'x'.repeat(43), fixture = { txIds: [id], archiveBytes: bytes.length, archiveSha256: digest(bytes) };
function healthy(path: string, override?: { cors?: string; network?: string; raw?: Buffer }) {
  const value = path === '/info' ? JSON.stringify({ network: override?.network ?? 'arweave.N.1' })
    : path === `/tx/${id}` ? JSON.stringify({ id }) : override?.raw ?? bytes;
  return new Response(value, { headers: { 'access-control-allow-origin': override?.cors ?? '*' } });
}
test('native recovery snapshot uses actual app nodes and only read-only metadata/raw requests', async () => {
  const calls: string[] = [];
  const report = await verifyNativeRecoveryNetwork({ fixture, fetcher: async (input, options) => {
    const url = new URL(String(input)); calls.push(url.href);
    assert(DEFAULT_DIRECT_NODES.includes(url.origin as typeof DEFAULT_DIRECT_NODES[number]));
    assert.equal(options?.method, 'GET'); assert.equal(options?.redirect, 'error'); assert.equal(options?.credentials, 'omit');
    assert.equal((options?.headers as Record<string, string>).Origin, ORIGIN);
    assert(!/graphql|peers|solana|goldsky/.test(url.href)); return healthy(url.pathname);
  } });
  assert.equal(report.status, 'PASS'); assert.equal(report.readyNodes, 2); assert.equal(calls.length, 6);
  assert.equal(report.registryRequired, false); assert.equal(report.uploadAttempted, false);
});
test('wrong network, metadata, bytes, CORS and oversized bodies cannot certify recovery readiness', async () => {
  for (const failure of ['network', 'metadata', 'bytes', 'cors', 'size']) {
    const report = await verifyNativeRecoveryNetwork({ fixture, fetcher: async input => {
      const url = new URL(String(input));
      if (failure === 'metadata' && url.pathname === `/tx/${id}`) return healthy('/info');
      return healthy(url.pathname, {
        ...(failure === 'network' ? { network: 'other' } : {}),
        ...(failure === 'cors' ? { cors: 'https://unrelated.example' } : {}),
        ...(failure === 'bytes' ? { raw: Buffer.alloc(bytes.length) } : {}),
        ...(failure === 'size' ? { raw: Buffer.alloc(bytes.length + 2) } : {}),
      });
    } });
    assert.equal(report.status, 'FAIL', failure); assert.equal(report.readyNodes, 0, failure);
  }
});
test('native data fallback follows no redirect and requires two configured nodes', async () => {
  for (const behavior of ['status', 'fetch-throws']) {
    const report = await verifyNativeRecoveryNetwork({ fixture, fetcher: async input => {
      const url = new URL(String(input));
      if (url.pathname === `/raw/${id}`) return new Response(null, { status: 404 });
      if (url.pathname === `/${id}`) {
        if (behavior === 'fetch-throws') throw TypeError('fetch failed: redirect is not allowed');
        return new Response(null, { status: 302, headers: { location: 'https://ignored.example' } });
      }
      if (url.pathname.endsWith('/data')) return new Response(bytes.toString('base64url'), { headers: { 'access-control-allow-origin': '*' } });
      return healthy(url.pathname);
    } });
    assert.equal(report.status, 'PASS'); assert(report.nodes.every(node => node.ready && node.path.endsWith('/data')));
  }
  const partial = await verifyNativeRecoveryNetwork({ fixture, fetcher: async input => {
    const url = new URL(String(input));
    return url.origin === DEFAULT_DIRECT_NODES[0] ? healthy(url.pathname) : new Response(null, { status: 503 });
  } });
  assert.equal(partial.readyNodes, 1); assert.equal(partial.status, 'FAIL');
});
