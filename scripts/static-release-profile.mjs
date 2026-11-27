/** Static build contracts. These checks never upload, sign, pay or contact a service. */
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const FUNDED_PROFILE = 'legacy-funded-worker';
export const INDEPENDENT_PROFILE = 'decentralized-direct-arweave';
export const PROFILE_FILE = 'release-profile.json';
export const BOUNDARY_FILE = 'bundle-boundary.json';
export const RECOVERY_FILES = Object.freeze([
  'recover.mjs', 'README.md', 'FORMAT.md', 'envelope-v1.schema.json',
  'english.txt', 'LICENSES.txt', 'public-vectors.json', 'recovery.html',
]);
export const INDEPENDENT_ROOT_FILES = Object.freeze([
  'index.html', '404.html', 'favicon.ico', 'favicon.svg', PROFILE_FILE, BOUNDARY_FILE,
]);
export const INDEPENDENT_PROFILE_DOCUMENT = Object.freeze({
  schema: 'sejire/deployment-profile/v1', profile: INDEPENDENT_PROFILE,
  storageNetwork: 'arweave.N.1', funding: 'owner-ar-wallet',
  archiveTransport: 'native-arweave', execution: 'browser-local',
  mandatorySejireService: false, mandatorySolana: false, mandatoryBundler: false,
  mandatoryCloudflare: false, mandatoryHostedExecutor: false, mandatoryAO: false,
  recoveryFormat: 'sejire/envelope/v1',
});

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (condition, code) => { if (!condition) throw Error(code); };

export function normalizeModuleId(id, root) {
  return id.replaceAll('\\', '/').replaceAll('\0', '').replace(root.replaceAll('\\', '/') + '/', '');
}

/** All rendered modules, including lazy chunks, must remain inside the direct path. */
export function forbiddenIndependentModule(id) {
  return /(?:^|\/)apps\/sponsor\//.test(id) ||
    /(?:^|\/)node_modules\/(?:@ardrive\/turbo-sdk|@dha-team\/arbundles|@cloudflare\/[^/]+|@solana\/[^/]+|@permaweb\/aoconnect)\//.test(id) ||
    /(?:^|\/)apps\/web\/src\/lib\/(?:checkout|fund|sponsor|opsDesk)\//.test(id) ||
    /(?:^|\/)apps\/web\/src\/lib\/ao\/client\./.test(id) ||
    /(?:^|\/)apps\/web\/src\/lib\/solana\/(?:upload|wallet|rpc|quote)\./.test(id) ||
    /(?:^|\/)apps\/web\/src\/lib\/native\/(?:payment|jobs|rpc|audit)\./.test(id) ||
    /(?:^|\/)apps\/web\/src\/lib\/arweave\/(?:publish|wallet)\./.test(id) ||
    /(?:^|\/)apps\/web\/src\/components\/(?:PaidSolanaFlow|PaidSaveHistory|FundedSaveFlow|PromoFundedFlow|FundAdmin|FundAdminDesk|AdminDesk|ServerAdminDesk|NativeAdminDesk|NativeSaveFlow|PreservationV2Flow|SolanaSaveFlow|SolanaSavePanel|SolanaCheckoutPanel)\./.test(id);
}

export function assertIndependentCode(code) {
  // Replaceable native Arweave gateways are allowed for reads and signed L1
  // delivery. Sponsor/executor/payment API origins and routes are not, even in
  // an unvisited dynamic chunk.
  fail(!/(?:[A-Za-z0-9-]+\.)?(?:workers\.dev|pages\.dev|cloudflareaccess\.com)\b/i.test(code), 'independent_worker_endpoint_in_bundle');
  fail(!/\b(?:[A-Za-z0-9-]+\.)*(?:cloudflare\.com|cloudflareinsights\.com)\b/i.test(code), 'independent_cloudflare_endpoint_in_bundle');
  fail(!/\b(?:[A-Za-z0-9-]+\.)*prod\.page\b|\bsejire-api\.[A-Za-z0-9.-]+\b/i.test(code), 'independent_hosted_api_in_bundle');
  fail(!/\b(?:[A-Za-z0-9-]+\.)*goldsky\.com\b/i.test(code), 'independent_indexer_service_in_bundle');
  fail(!/\b(?:push\.forward\.computer|(?:mu|cu|su)\.ao-testnet\.xyz)\b|~process@1\.0\/compute\//i.test(code), 'independent_ao_transport_in_bundle');
  fail(!/\/(?:api\/)?(?:checkout|fund)\/(?:policy|orders|status|admin|quote|contribution|balance|promo)\b|\/api\/(?:checkout|fund)(?:["'`/]|$)/i.test(code), 'independent_service_route_in_bundle');
  fail(!/(?:upload|payment)(?:[.-](?:devnet|testnet))?\.(?:ardrive\.io|ar\.io)|(?:turbo|devnet)\.ardrive\.io|api\.(?:mainnet-beta|devnet|testnet)\.solana\.com|helius-rpc\.com/i.test(code), 'independent_payment_endpoint_in_bundle');
  fail(!/ARWEAVE_TREASURY_JWK|TURBO_JWK|PROMO_CODE_SECRET|__SEJIRE_[A-Z0-9_]*TEST_DRIVER__|synthetic-browser-test-only/.test(code), 'independent_secret_or_fixture_in_bundle');
  fail(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|["']d["']\s*:\s*["'][A-Za-z0-9_-]{100,}["']/.test(code), 'independent_private_key_in_bundle');
}

export async function staticFiles(root, dir = root) {
  const info = await lstat(dir);
  fail(info.isDirectory() && !info.isSymbolicLink(), 'independent_unsafe_static_path');
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) files.push(...await staticFiles(root, path));
    else {
      fail(item.isFile(), 'independent_unsafe_static_path');
      files.push(path.slice(root.length + 1).replaceAll('\\', '/'));
    }
  }
  return files.sort();
}

/** Vite's later generateBundle hooks may still change code after module capture.
 * Bind that captured map to the final files only after build() has completed. */
export async function finalizeIndependentBoundary(directory, capturedChunks) {
  const root = resolve(directory);
  fail(Array.isArray(capturedChunks) && capturedChunks.length > 0 && capturedChunks.length <= 256, 'independent_boundary_missing');
  const chunks = [];
  for (const chunk of capturedChunks) {
    fail(typeof chunk.file === 'string' && /^assets\/[A-Za-z0-9_.-]+\.js$/.test(chunk.file), 'independent_boundary_invalid');
    const path = join(root, chunk.file), info = await lstat(path);
    fail(info.isFile() && !info.isSymbolicLink() && info.size <= 30 * 1024 * 1024, 'independent_unsafe_static_path');
    chunks.push({ file: chunk.file, sha256: hash(await readFile(path)),
      imports: chunk.imports, dynamicImports: chunk.dynamicImports, modules: chunk.modules });
  }
  chunks.sort((a, b) => a.file.localeCompare(b.file));
  await writeFile(join(root, BOUNDARY_FILE), JSON.stringify({ schema: 'sejire/browser-boundary/v1',
    profile: INDEPENDENT_PROFILE, chunks }, null, 2) + '\n');
}

async function smallJson(path) {
  const info = await lstat(path);
  fail(info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024, 'independent_invalid_profile');
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function verifyIndependentBuild(directory) {
  const root = resolve(directory), names = await staticFiles(root);
  const profile = await smallJson(join(root, PROFILE_FILE));
  fail(JSON.stringify(profile) === JSON.stringify(INDEPENDENT_PROFILE_DOCUMENT), 'independent_profile_mismatch');
  fail(!names.includes('admin-lock.json'), 'independent_legacy_admin_file');
  for (const name of [...INDEPENDENT_ROOT_FILES, ...RECOVERY_FILES.map(file => `recovery/${file}`)]) {
    fail(names.includes(name), 'independent_required_file_missing');
  }
  const html = await readFile(join(root, 'index.html'), 'utf8');
  fail(html.includes('./assets/') && !/<(?:script|link)[^>]+(?:src|href)=["'](?:https?:|\/\/|\/)/i.test(html), 'independent_nonportable_entry');
  fail(html === await readFile(join(root, '404.html'), 'utf8'), 'independent_fallback_mismatch');
  // Entry pages, stylesheets, SVG and the standalone recovery program can load
  // services without appearing in Vite's JavaScript module graph.
  for (const name of names.filter(name => /\.(?:html|css|svg|m?js)$/.test(name))) {
    assertIndependentCode(await readFile(join(root, name), 'utf8'));
  }
  const report = await smallJson(join(root, BOUNDARY_FILE));
  fail(report.schema === 'sejire/browser-boundary/v1' && report.profile === INDEPENDENT_PROFILE &&
    Array.isArray(report.chunks) && report.chunks.length > 0 && report.chunks.length <= 256, 'independent_boundary_missing');
  const jsFiles = names.filter(name => name.startsWith('assets/') && name.endsWith('.js'));
  fail(JSON.stringify([...report.chunks.map(chunk => chunk.file)].sort()) === JSON.stringify(jsFiles), 'independent_boundary_chunk_mismatch');
  const modules = new Set();
  for (const chunk of report.chunks) {
    fail(typeof chunk.file === 'string' && /^assets\/[A-Za-z0-9_.-]+\.js$/.test(chunk.file) &&
      /^[a-f0-9]{64}$/.test(chunk.sha256) && Array.isArray(chunk.modules) &&
      chunk.modules.length <= 20000 && Array.isArray(chunk.imports) && Array.isArray(chunk.dynamicImports), 'independent_boundary_invalid');
    for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) {
      fail(jsFiles.includes(dependency), 'independent_external_chunk_dependency');
    }
    for (const module of chunk.modules) {
      fail(typeof module === 'string' && module.length < 2048 && !forbiddenIndependentModule(module), 'independent_backend_module_in_bundle');
      fail(!/\/tests\/|\.selftest\.|devnet\.e2e/.test(module), 'independent_fixture_module_in_bundle');
      modules.add(module);
    }
    const bytes = await readFile(join(root, chunk.file));
    fail(hash(bytes) === chunk.sha256, 'independent_boundary_digest_mismatch');
  }
  fail([...modules].some(module => module.startsWith('apps/web/src/lib/directArweave/')), 'independent_direct_writer_missing');
  return { profile: INDEPENDENT_PROFILE, jsAssets: jsFiles.length, renderedModules: modules.size,
    recoveryFiles: RECOVERY_FILES.length, mandatorySejireService: false };
}
