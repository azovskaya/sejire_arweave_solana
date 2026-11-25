/** The SOL/promo release is a separate contract from the independent app. */
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BOUNDARY_FILE, PROFILE_FILE, RECOVERY_FILES, staticFiles } from './static-release-profile.mjs';

export const PORTABLE_FUNDED_PROFILE = 'portable-funded-mainnet';
export const PORTABLE_FUNDED_BRANCH = 'feat/funded-portable-release-20261125';
export const PORTABLE_FUNDED_ARTIFACT = 'permaweb-portable-funded-release';
export const PORTABLE_ROOT_FILES = Object.freeze(['index.html', '404.html', 'favicon.ico', 'favicon.svg', PROFILE_FILE, BOUNDARY_FILE]);
export const FUNDED_REQUIRED_MODULES = Object.freeze([
  'apps/web/src/lib/checkout/paidClient.ts', 'apps/web/src/lib/fund/client.ts',
  'apps/web/src/components/PromoFundedFlow.tsx', 'apps/web/src/components/PaidSolanaFlow.tsx',
  'apps/web/src/components/AdminDesk.tsx', 'apps/web/src/components/FundAdmin.tsx',
  'apps/web/src/components/ServerAdminDesk.tsx', 'apps/web/src/components/RestoreSeed.tsx',
]);
const fail = (ok, code) => { if (!ok) throw Error(code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cloudflareHost = /(?:^|\.)(?:workers\.dev|pages\.dev|cloudflareaccess\.com|cloudflare\.com|cloudflareinsights\.com)$/i;

export function publicApiOrigin(raw) {
  let url;
  try { url = new URL(raw); } catch { throw Error('portable_invalid_api_origin'); }
  fail(typeof raw === 'string' && url.origin === raw && url.protocol === 'https:' && !url.username && !url.password,
    'portable_invalid_api_origin');
  fail(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname) &&
    !/(?:^|\.)(?:localhost|local|invalid|test|example\.com|example\.org|example\.net)$/i.test(url.hostname), 'portable_invalid_api_origin');
  fail(!cloudflareHost.test(url.hostname), 'portable_cloudflare_api_origin');
  return raw;
}

export function portableProfile(apiOrigin) {
  return { schema: 'sejire/deployment-profile/v1', profile: PORTABLE_FUNDED_PROFILE,
    apiOrigin: publicApiOrigin(apiOrigin), fundingMethods: ['solana', 'promo'], paymentNetwork: 'mainnet-beta',
    serviceLamports: '30000000', storageNetwork: 'arweave.N.1', maxArchiveBytes: 512 * 1024,
    mandatorySejireService: true, mandatoryCloudflare: false, mandatoryBundler: false,
    adminAuthorization: 'server', recoveryFormat: 'sejire/envelope/v1' };
}

export function forbiddenPortableModule(id) {
  return /(?:^|\/)node_modules\/(?:@ardrive\/turbo-sdk|@dha-team\/arbundles|@cloudflare\/[^/]+)\//.test(id) ||
    (/(?:^|\/)apps\/sponsor\//.test(id) &&
      !/^apps\/sponsor\/src\/checkout\/(?:paymentValidator|rpcDecoder|rpcErrors|rpcReader)\.ts$/.test(id)) ||
    /\/tests\/|\.selftest\.|devnet\.e2e/.test(id);
}

export function assertPortableCode(code) {
  fail(!/(?:[A-Za-z0-9-]+\.)?(?:workers\.dev|pages\.dev|cloudflareaccess\.com)\b/i.test(code), 'portable_cloudflare_endpoint_in_bundle');
  fail(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|["']d["']\s*:\s*["'][A-Za-z0-9_-]{100,}["']/.test(code), 'portable_private_key_in_bundle');
  fail(!/__SEJIRE_[A-Z0-9_]*TEST_DRIVER__|synthetic-browser-test-only/.test(code), 'portable_fixture_in_bundle');
}

export async function finalizePortableBoundary(directory, capturedChunks) {
  const root = resolve(directory);
  fail(Array.isArray(capturedChunks) && capturedChunks.length > 0 && capturedChunks.length <= 256, 'portable_boundary_missing');
  const chunks = [];
  for (const chunk of capturedChunks) {
    fail(typeof chunk.file === 'string' && /^assets\/[A-Za-z0-9_.-]+\.js$/.test(chunk.file), 'portable_boundary_invalid');
    const path = join(root, chunk.file), info = await lstat(path);
    fail(info.isFile() && !info.isSymbolicLink() && info.size <= 30 * 1024 * 1024, 'portable_unsafe_static_path');
    chunks.push({ file: chunk.file, sha256: hash(await readFile(path)), imports: chunk.imports,
      dynamicImports: chunk.dynamicImports, modules: chunk.modules });
  }
  chunks.sort((a, b) => a.file.localeCompare(b.file));
  await writeFile(join(root, BOUNDARY_FILE), JSON.stringify({ schema: 'sejire/browser-boundary/v1', profile: PORTABLE_FUNDED_PROFILE, chunks }, null, 2) + '\n');
}

async function smallJson(path) {
  const info = await lstat(path);
  fail(info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024, 'portable_invalid_profile');
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function verifyPortableFundedBuild(directory, expectedApiOrigin) {
  const root = resolve(directory), names = await staticFiles(root);
  const profile = await smallJson(join(root, PROFILE_FILE));
  const expected = portableProfile(expectedApiOrigin ?? profile.apiOrigin);
  fail(JSON.stringify(profile) === JSON.stringify(expected), 'portable_profile_mismatch');
  fail(!names.includes('admin-lock.json'), 'portable_legacy_admin_file');
  for (const name of [...PORTABLE_ROOT_FILES, ...RECOVERY_FILES.map(file => `recovery/${file}`)]) {
    fail(names.includes(name), 'portable_required_file_missing');
  }
  const html = await readFile(join(root, 'index.html'), 'utf8');
  fail(html.includes('./assets/') && !/<(?:script|link)[^>]+(?:src|href)=["'](?:https?:|\/\/|\/)/i.test(html), 'portable_nonportable_entry');
  fail(html === await readFile(join(root, '404.html'), 'utf8'), 'portable_fallback_mismatch');
  for (const name of names.filter(name => /\.(?:html|css|svg|m?js)$/.test(name))) assertPortableCode(await readFile(join(root, name), 'utf8'));
  const boundary = await smallJson(join(root, BOUNDARY_FILE));
  fail(boundary.schema === 'sejire/browser-boundary/v1' && boundary.profile === PORTABLE_FUNDED_PROFILE &&
    Array.isArray(boundary.chunks) && boundary.chunks.length > 0 && boundary.chunks.length <= 256, 'portable_boundary_missing');
  const jsFiles = names.filter(name => name.startsWith('assets/') && name.endsWith('.js'));
  fail(JSON.stringify([...boundary.chunks.map(c => c.file)].sort()) === JSON.stringify(jsFiles), 'portable_boundary_chunk_mismatch');
  const modules = new Set(); let apiFound = false;
  for (const chunk of boundary.chunks) {
    fail(typeof chunk.file === 'string' && /^assets\/[A-Za-z0-9_.-]+\.js$/.test(chunk.file) &&
      /^[a-f0-9]{64}$/.test(chunk.sha256) && Array.isArray(chunk.modules) && chunk.modules.length <= 20000 &&
      Array.isArray(chunk.imports) && Array.isArray(chunk.dynamicImports), 'portable_boundary_invalid');
    for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) fail(jsFiles.includes(dependency), 'portable_external_chunk_dependency');
    for (const id of chunk.modules) {
      fail(typeof id === 'string' && id.length < 2048 && !forbiddenPortableModule(id), 'portable_forbidden_module');
      modules.add(id);
    }
    const bytes = await readFile(join(root, chunk.file));
    fail(hash(bytes) === chunk.sha256, 'portable_boundary_digest_mismatch');
    apiFound ||= bytes.toString('utf8').includes(profile.apiOrigin);
  }
  fail(apiFound, 'portable_api_origin_missing');
  for (const id of FUNDED_REQUIRED_MODULES) fail(modules.has(id), 'portable_required_module_missing');
  return { profile: PORTABLE_FUNDED_PROFILE, apiOrigin: profile.apiOrigin, jsAssets: jsFiles.length,
    renderedModules: modules.size, recoveryFiles: RECOVERY_FILES.length, mandatorySejireService: true, mandatoryCloudflare: false };
}
