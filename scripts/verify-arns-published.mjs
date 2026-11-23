/** Verify an uploaded manifest's public bytes, or the owner-bound ArNS target. Read-only. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACCEPTED_DIR, EVIDENCE_DIR, boundedBytes, digest, requireValue, verifyRelease } from './permaweb-release.mjs';

const TX = /^[A-Za-z0-9_-]{43}$/;
// Modules require a JavaScript MIME type even when their bytes are correct.
// https://mimesniff.spec.whatwg.org/#javascript-mime-type
const JAVASCRIPT_TYPES = new Set([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript', 'application/x-javascript',
  'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript',
  'text/x-ecmascript', 'text/x-javascript',
]);
const BROWSER_TYPES = { '.html': new Set(['text/html']), '.css': new Set(['text/css']),
  '.js': JAVASCRIPT_TYPES, '.mjs': JAVASCRIPT_TYPES };
export function verifyPathManifest(manifest, files) {
  requireValue(manifest?.manifest === 'arweave/paths' && manifest.version === '0.2.0' &&
    manifest.index?.path === 'index.html' && manifest.paths && !Array.isArray(manifest.paths), 'permaweb_path_manifest_invalid');
  requireValue(JSON.stringify(Object.keys(manifest.paths).sort()) === JSON.stringify(files.map(file => file.path).sort()), 'permaweb_path_manifest_incomplete');
  requireValue(Object.values(manifest.paths).every(value => value && TX.test(value.id)) &&
    manifest.fallback?.id === manifest.paths['404.html']?.id, 'permaweb_path_manifest_fallback');
}

export function publicBase(value) {
  const url = new URL(value);
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash,
    'permaweb_public_base_invalid');
  requireValue(url.hostname === 'sejire.ar.io' && url.pathname === '/' ||
    ['turbo-gateway.com', 'arweave.net'].includes(url.hostname) && /^\/[A-Za-z0-9_-]{43}\/$/.test(url.pathname),
  'permaweb_public_base_invalid');
  return url.href;
}

async function publicFile(url, expectedBytes, fetcher, contentTypes) {
  const original = new URL(url), signal = AbortSignal.timeout(20000);
  let current = original;
  for (let redirect = 0; redirect <= 3; redirect++) {
    const response = await fetcher(current.href, { redirect: 'manual', cache: 'no-store', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); requireValue(location, 'permaweb_public_redirect');
      const next = new URL(location, current);
      requireValue(next.protocol === 'https:' && !next.username && !next.password && !next.port &&
        (next.hostname === original.hostname || next.hostname.endsWith('.' + original.hostname)), 'permaweb_public_redirect');
      await response.body?.cancel(); current = next; continue;
    }
    requireValue(response.status === 200, 'permaweb_public_http_failed');
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (contentTypes && !contentTypes.has(contentType)) {
      await response.body?.cancel();
      throw Error('permaweb_public_content_type_mismatch');
    }
    return boundedBytes(response, expectedBytes + 1);
  }
  throw Error('permaweb_public_redirect');
}

export async function verifyPublishedRelease(release, base, { fetcher = fetch } = {}) {
  base = publicBase(base);
  const results = []; let next = 0;
  // Bounded concurrency, one attempt. A failed delivery is retried by the verify command, never by uploading again.
  await Promise.all(Array.from({ length: Math.min(4, release.files.length) }, async () => {
    while (next < release.files.length) {
      const file = release.files[next++];
      const bytes = await publicFile(base + file.path, file.bytes, fetcher, BROWSER_TYPES[extname(file.path).toLowerCase()]);
      requireValue(bytes.length === file.bytes && digest(bytes) === file.sha256, 'permaweb_public_digest_mismatch');
      results.push({ path: file.path, bytes: bytes.length, sha256: file.sha256 });
    }
  }));
  const entrypoint = release.files.find(file => file.path === 'index.html');
  const indexBytes = await publicFile(base, entrypoint.bytes, fetcher, BROWSER_TYPES['.html']);
  requireValue(indexBytes.length === entrypoint.bytes && digest(indexBytes) === entrypoint.sha256, 'permaweb_public_entrypoint_mismatch');
  const fallback = release.files.find(file => file.path === '404.html');
  const bytes = await publicFile(base + '__sejire_fallback_probe__', fallback.bytes, fetcher, BROWSER_TYPES['.html']);
  requireValue(bytes.length === fallback.bytes && digest(bytes) === fallback.sha256, 'permaweb_public_fallback_mismatch');
  return { schema: 'sejire/permaweb-public-verification/v1', status: 'PASS', checkedAt: new Date().toISOString(),
    base, sourceCommit: release.manifest.sourceCommit, files: results.sort((a, b) => a.path.localeCompare(b.path)),
    entrypointVerified: true, fallbackVerified: true, browserContentTypesVerified: true,
    arnsTargetChanged: false, settlementVerified: false };
}

export async function readPublicManifest(id, fetcher = fetch) {
  requireValue(TX.test(id ?? ''), 'permaweb_invalid_manifest_id');
  const bytes = await publicFile(`https://turbo-gateway.com/raw/${id}`, 1024 * 1024, fetcher);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw Error('permaweb_path_manifest_invalid'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const provenance = JSON.parse(await readFile(join(ACCEPTED_DIR, 'build-provenance.json'), 'utf8'));
    const release = await verifyRelease(ACCEPTED_DIR, provenance.sourceCommit, { provenance: true });
    requireValue(provenance.releaseManifestSha256 === release.manifestSha256, 'permaweb_provenance_mismatch');
    const args = process.argv.slice(2), manifestArg = args.indexOf('--manifest'), target = args.includes('--target');
    const explicitId = manifestArg === -1 ? null : args[manifestArg + 1];
    const expectedArgs = (target ? 1 : 0) + (manifestArg === -1 ? 0 : 2);
    requireValue(args.length === expectedArgs && args.every((arg, index) => arg === '--target' ||
      arg === '--manifest' && index === manifestArg || manifestArg !== -1 && index === manifestArg + 1 && TX.test(arg)),
    'permaweb_invalid_verify_arguments');
    let manifestId, manifest;
    if (manifestArg !== -1) {
      manifestId = explicitId; manifest = await readPublicManifest(manifestId);
    } else {
      const uploaded = JSON.parse(await readFile(join(EVIDENCE_DIR, 'upload-result.json'), 'utf8'));
      requireValue(TX.test(uploaded.manifestId) && uploaded.sourceCommit === provenance.sourceCommit, 'permaweb_upload_result_mismatch');
      manifestId = uploaded.manifestId; manifest = uploaded.manifest;
    }
    verifyPathManifest(manifest, release.files);
    const base = target ? 'https://sejire.ar.io/' : `https://turbo-gateway.com/${manifestId}/`;
    const report = await verifyPublishedRelease(release, base);
    await mkdir(EVIDENCE_DIR, { recursive: true });
    await writeFile(join(EVIDENCE_DIR, target ? 'arns-public-result.json' : 'public-result.json'), JSON.stringify({ ...report, manifestId }, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, base, manifestId, sourceCommit: report.sourceCommit, files: report.files.length,
      entrypointVerified: true, fallbackVerified: true, browserContentTypesVerified: true, settlementVerified: false }));
  } catch (error) { console.error(error instanceof Error && /^permaweb_/.test(error.message) ? error.message : 'permaweb_public_verification_failed'); process.exitCode = 1; }
}
