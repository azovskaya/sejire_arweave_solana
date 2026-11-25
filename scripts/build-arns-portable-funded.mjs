/** Build SOL Mainnet + promo + server admin and offline recovery, without a Worker. */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, lstat, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROFILE_FILE, RECOVERY_FILES, normalizeModuleId } from './static-release-profile.mjs';
import { portableProfile, finalizePortableBoundary, verifyPortableFundedBuild } from './portable-funded-profile.mjs';

const root = resolve(import.meta.dirname, '..'), web = resolve(root, 'apps/web'), dist = resolve(web, 'dist');
const profile = portableProfile(process.env.SEJIRE_FUNDED_API_ORIGIN);
// Explicit values override local environment files. Historical attempt recovery
// stays in source; only new production offers require Mainnet.
Object.assign(process.env, {
  VITE_DECENTRALIZED_MODE: 'false', VITE_PORTABLE_FUNDED: '1',
  VITE_FUND_API_URL: profile.apiOrigin, VITE_CHECKOUT_API_URL: profile.apiOrigin,
  VITE_SPONSOR_API_URL: '', VITE_SPONSOR_URL: '', VITE_PRESERVATION_V2_ENABLED: '1',
  VITE_PRESERVATION_V2_TEST: '0', VITE_RECOVERY_TEST: '0', VITE_CHECKOUT_ENABLED: '0',
  VITE_NATIVE_AR_ENABLED: '1', VITE_NATIVE_AR_PILOT: '1', VITE_NATIVE_AR_BROADCAST: '0',
  VITE_NATIVE_SOL_MAINNET: '0', VITE_PUBLISH_MODE: 'solana', VITE_SOLANA_NETWORK: 'mainnet-beta',
  VITE_AO_MODE: 'local', VITE_SEJIRE_FACTORY_ID: '', VITE_QA_TOOLS: '0',
});
const requireWeb = createRequire(resolve(web, 'package.json'));
execFileSync(process.execPath, [requireWeb.resolve('typescript/bin/tsc'), '-b'], { cwd: web, stdio: 'inherit' });
const { build } = await import(pathToFileURL(requireWeb.resolve('vite')));
let capturedChunks;
await build({ root: web, configFile: resolve(web, 'vite.config.ts'),
  build: { outDir: dist, emptyOutDir: true, sourcemap: false },
  plugins: [{ name: 'sejire-portable-funded-boundary', generateBundle(_options, bundle) {
    capturedChunks = Object.values(bundle).filter(item => item.type === 'chunk').map(chunk => ({
      file: chunk.fileName, imports: [...chunk.imports].sort(), dynamicImports: [...chunk.dynamicImports].sort(),
      modules: Object.entries(chunk.modules).filter(([, module]) => module.renderedLength > 0)
        .map(([id]) => normalizeModuleId(id, root)).sort(),
    })).sort((a, b) => a.file.localeCompare(b.file));
    this.emitFile({ type: 'asset', fileName: PROFILE_FILE, source: JSON.stringify(profile, null, 2) + '\n' });
  } }],
});
await finalizePortableBoundary(dist, capturedChunks);
await rm(resolve(dist, 'admin-lock.json'), { force: true });
await mkdir(resolve(dist, 'recovery'), { recursive: true });
for (const name of RECOVERY_FILES) {
  const source = resolve(root, 'tools/recovery', name), info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('portable_unsafe_recovery_file');
  await copyFile(source, resolve(dist, 'recovery', name));
}
console.log(JSON.stringify({ status: 'PASS', ...await verifyPortableFundedBuild(dist, profile.apiOrigin), dist,
  note: 'Static build only. Service readiness and owner wallet acceptance are separate release requirements.' }, null, 2));
