/** Read-only native Arweave recovery snapshot. No external index/peer registry. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DIRECT_NODES, directNode } from '../apps/web/src/lib/directArweave/network.ts';
import { boundedBytes, digest } from './permaweb-release.mjs';

export const ORIGIN = 'https://sejire.ar.io';
type Fixture = { txIds: string[]; archiveBytes: number; archiveSha256: string };
const output = '.cache/native-recovery-network/readiness.json';
async function publicFixture(): Promise<Fixture> {
  const manifest = JSON.parse(await readFile(new URL('../apps/web/src/lib/recovery/legacy-locators.v1.json', import.meta.url), 'utf8'));
  const fixture = manifest.entries.find((entry: Fixture) => entry.archiveBytes && entry.archiveSha256);
  if (!fixture) throw Error('native_recovery_fixture_missing');
  return fixture;
}
async function request(node: string, path: string, maximum: number, fetcher: typeof fetch) {
  let response: Response;
  try {
    response = await fetcher(node + path, { method: 'GET', headers: { Origin: ORIGIN },
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000) });
  } catch { throw Error('native_recovery_request_unavailable'); }
  try {
    if (response.redirected || response.status >= 300 && response.status < 400) throw Error('native_recovery_redirect');
    if (response.status !== 200) return null;
    if (!['*', ORIGIN].includes(response.headers.get('access-control-allow-origin') ?? '')) throw Error('native_recovery_cors');
    return await boundedBytes(response, maximum);
  } finally { await response.body?.cancel().catch(() => {}); }
}
export async function verifyNativeRecoveryNetwork({ fetcher = fetch, fixture, checkedAt = new Date().toISOString() }:
  { fetcher?: typeof fetch; fixture?: Fixture; checkedAt?: string } = {}) {
  fixture ??= await publicFixture();
  const id = fixture.txIds[0];
  if (!/^[A-Za-z0-9_-]{43}$/.test(id) || !Number.isSafeInteger(fixture.archiveBytes) || fixture.archiveBytes < 1 ||
    fixture.archiveBytes > 10 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(fixture.archiveSha256)) throw Error('native_recovery_fixture_invalid');
  const nodes = await Promise.all(DEFAULT_DIRECT_NODES.map(async value => {
    const node = directNode(value);
    try {
      const info = await request(node, '/info', 16384, fetcher);
      if (!info || JSON.parse(info.toString('utf8')).network !== 'arweave.N.1') throw Error('native_recovery_network');
      const metadata = await request(node, `/tx/${id}`, 32768, fetcher);
      if (!metadata || JSON.parse(metadata.toString('utf8')).id !== id) throw Error('native_recovery_metadata');
      for (const [path, encoded] of [[`/raw/${id}`, false], [`/${id}`, false], [`/tx/${id}/data`, true]] as const) {
        let bytes: Buffer | null;
        try { bytes = await request(node, path, encoded ? Math.ceil(fixture!.archiveBytes * 4 / 3) + 4 : fixture!.archiveBytes + 1, fetcher); }
        catch (error) {
          // Deny redirects and try the native data endpoint on the SAME node.
          if (error instanceof Error && ['native_recovery_redirect', 'native_recovery_request_unavailable'].includes(error.message)) continue;
          throw error;
        }
        if (!bytes) continue;
        if (encoded) {
          const text = bytes.toString('utf8').trim(); if (!/^[A-Za-z0-9_-]+$/.test(text)) throw Error('native_recovery_bytes');
          bytes = Buffer.from(text, 'base64url');
        }
        if (bytes.length !== fixture!.archiveBytes || digest(bytes) !== fixture!.archiveSha256) throw Error('native_recovery_bytes');
        return { node, ready: true, path, network: 'arweave.N.1', metadataId: id, bytes: bytes.length,
          sha256: fixture!.archiveSha256, cors: true };
      }
      throw Error('native_recovery_data_unavailable');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return { node, ready: false, reason: /^native_recovery_[a-z_]+$/.test(message) ? message : 'native_recovery_unavailable' };
    }
  }));
  const readyNodes = nodes.filter(node => node.ready).length;
  return { schema: 'sejire/native-recovery-readiness/v1', checkedAt, status: readyNodes >= 2 ? 'PASS' : 'FAIL',
    readyNodes, configuredNodes: nodes.length, requiredReadyNodes: 2, readOnly: true, origin: ORIGIN,
    registryRequired: false, externalIndexerRequired: false, uploadAttempted: false,
    scope: 'Current configured native nodes return the pinned encrypted historical fixture and metadata with CORS. This snapshot is not a new upload, owner decryption, settlement or distinct-operator certification.',
    nodes };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw Error('native_recovery_arguments_not_supported');
    const report = await verifyNativeRecoveryNetwork();
    await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2)); if (report.status !== 'PASS') process.exitCode = 1;
  } catch { console.error('native_recovery_readiness_failed'); process.exitCode = 1; }
}
