/** Public native-API readiness only: no wallet, address lookup, POST, upload or signing. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DIRECT_NODES, directNode } from '../apps/web/src/lib/directArweave/network.ts';

export const PROBE_ORIGIN = 'https://sejire.ar.io';
export const PROBE_BYTES = 25_269;
const TIMEOUT_MS = 8_000;
const OUTPUT = '.cache/direct-network/readiness.json';
const endpoints = [
  { name: 'info', method: 'GET', path: '/info', limit: 16_384 },
  { name: 'anchor', method: 'GET', path: '/tx_anchor', limit: 128 },
  { name: 'price', method: 'GET', path: `/price/${PROBE_BYTES}`, limit: 128 },
  { name: 'transactionPreflight', method: 'OPTIONS', path: '/tx', limit: 0 },
  { name: 'chunkPreflight', method: 'OPTIONS', path: '/chunk', limit: 0 },
] as const;
type Endpoint = typeof endpoints[number];
type Check = {
  name: Endpoint['name']; method: Endpoint['method']; path: string;
  status: number | null; ready: boolean; cors: boolean; reason: string | null;
  allowOrigin?: string | null; allowMethods?: string | null; allowHeaders?: string | null;
  network?: string; anchor?: string; rewardWinston?: string;
};

function tokens(value: string | null): string[] {
  const result = value?.split(',').map(token => token.trim()).filter(Boolean) ?? [];
  if (!result.every(token => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(token))) throw Error('invalid_cors_header');
  return result;
}
async function boundedText(response: Response, maximum: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw Error('response_too_large');
  if (!response.body) throw Error('empty_response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > maximum) throw Error('response_too_large');
      chunks.push(next.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)).trim();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function probeEndpoint(node: string, endpoint: Endpoint, fetcher: typeof fetch): Promise<Check> {
  const check: Check = { name: endpoint.name, method: endpoint.method, path: endpoint.path,
    status: null, ready: false, cors: false, reason: null };
  let response: Response | undefined;
  try {
    response = await fetcher(node + endpoint.path, {
      method: endpoint.method, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: endpoint.method === 'OPTIONS'
        ? { Origin: PROBE_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }
        : { Origin: PROBE_ORIGIN },
    });
    check.status = response.status;
    check.allowOrigin = response.headers.get('access-control-allow-origin');
    check.cors = check.allowOrigin === '*' || check.allowOrigin === PROBE_ORIGIN;
    if (!response.ok || endpoint.method === 'GET' && response.status !== 200) throw Error('http_unavailable');
    if (!check.cors) throw Error('cors_origin_denied');
    if (endpoint.method === 'OPTIONS') {
      check.allowMethods = response.headers.get('access-control-allow-methods');
      check.allowHeaders = response.headers.get('access-control-allow-headers');
      tokens(check.allowMethods); // A malformed list fails CORS even for a safelisted POST.
      const headers = tokens(check.allowHeaders).map(value => value.toLowerCase());
      // POST is CORS-safelisted. JSON's Content-Type triggers this preflight;
      // credentials are omitted, so '*' also permits that header (Fetch 4.8).
      if (!headers.includes('content-type') && !headers.includes('*')) throw Error('cors_content_type_denied');
    } else {
      const text = await boundedText(response, endpoint.limit);
      if (endpoint.name === 'info') {
        let info: unknown; try { info = JSON.parse(text); } catch { throw Error('invalid_info'); }
        if (!info || typeof info !== 'object' || !('network' in info) || info.network !== 'arweave.N.1') throw Error('wrong_network');
        check.network = info.network;
      } else if (endpoint.name === 'anchor') {
        if (!/^[A-Za-z0-9_-]{43,64}$/.test(text)) throw Error('invalid_anchor');
        check.anchor = text;
      } else {
        if (!/^[1-9][0-9]{0,29}$/.test(text)) throw Error('invalid_price');
        check.rewardWinston = text;
      }
    }
    check.ready = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    check.reason = /^(?:http_unavailable|cors_origin_denied|cors_content_type_denied|invalid_cors_header|response_too_large|empty_response|invalid_info|wrong_network|invalid_anchor|invalid_price)$/.test(message)
      ? message : 'request_unavailable_or_timed_out';
  } finally { await response?.body?.cancel().catch(() => {}); }
  return check;
}

export async function verifyDirectNetwork({ fetcher = fetch, checkedAt = new Date().toISOString() } = {}) {
  // Always use the application's actual defaults; no URL overrides or peer discovery.
  const nodes = [...new Set(DEFAULT_DIRECT_NODES.map(directNode))];
  if (!nodes.length || nodes.length > 6) throw Error('invalid_default_node_count');
  const results: { node: string; readiness: 'ready' | 'unavailable'; checks: Check[] }[] = new Array(nodes.length);
  let next = 0;
  // Two nodes, five one-shot endpoint checks each: at most ten requests in flight.
  await Promise.all(Array.from({ length: Math.min(2, nodes.length) }, async () => {
    while (next < nodes.length) {
      const index = next++, node = nodes[index];
      const checks = await Promise.all(endpoints.map(endpoint => probeEndpoint(node, endpoint, fetcher)));
      results[index] = { node, readiness: checks.every(check => check.ready) ? 'ready' : 'unavailable', checks };
    }
  }));
  const readyNodes = results.filter(node => node.readiness === 'ready').length;
  return {
    schema: 'sejire/direct-network-readiness/v1', checkedAt, origin: PROBE_ORIGIN, archiveBytes: PROBE_BYTES,
    status: readyNodes >= 1 ? 'PASS' : 'FAIL', readyNodes, configuredNodes: nodes.length,
    redundancy: readyNodes >= 2 ? 'atLeastTwoConfiguredEndpointsReady' : 'redundancyNotConfirmed',
    readOnly: true, walletChecked: false, uploadAttempted: false,
    scope: 'Native API and CORS preflight snapshot; actual upload, archive readback, settlement and distinct operator ownership are not tested.',
    nodes: results,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw Error('direct_network_arguments_not_supported');
    const report = await verifyDirectNetwork();
    await mkdir(resolve(OUTPUT, '..'), { recursive: true });
    await writeFile(OUTPUT, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'PASS') process.exitCode = 1;
  } catch { console.error('direct_network_readiness_failed'); process.exitCode = 1; }
}
