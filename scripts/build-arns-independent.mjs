/** Build the direct Arweave application and its exact emitted-module evidence. */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, lstat, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { INDEPENDENT_PROFILE_DOCUMENT, PROFILE_FILE, RECOVERY_FILES,
  finalizeIndependentBoundary, normalizeModuleId, verifyIndependentBuild } from './static-release-profile.mjs';
import { independentPdfPlugin } from './independent-pdf-build.mjs';

const root = resolve(import.meta.dirname, '..'), web = resolve(root, 'apps/web'), dist = resolve(web, 'dist');
// Explicit empty values override local .env files as well as the caller's shell.
// None of the legacy executor or treasury settings belongs to this profile.
Object.assign(process.env, {
  VITE_DECENTRALIZED_MODE: 'true', VITE_FUND_API_URL: '', VITE_CHECKOUT_API_URL: '',
  VITE_SPONSOR_API_URL: '', VITE_SPONSOR_URL: '', VITE_PRESERVATION_V2_ENABLED: '0',
  VITE_PRESERVATION_V2_TEST: '0', VITE_RECOVERY_TEST: '0', VITE_CHECKOUT_ENABLED: '0',
  VITE_NATIVE_AR_ENABLED: '0', VITE_NATIVE_AR_PILOT: '0', VITE_NATIVE_AR_BROADCAST: '0',
  VITE_NATIVE_SOL_MAINNET: '0', VITE_PUBLISH_MODE: 'arweave', VITE_SOLANA_NETWORK: 'devnet',
  VITE_AO_MODE: 'local', VITE_AO_HB_NODE: '', VITE_SEJIRE_FACTORY_ID: '', VITE_QA_TOOLS: '0',
});

const requireWeb = createRequire(resolve(web, 'package.json'));
execFileSync(process.execPath, [requireWeb.resolve('typescript/bin/tsc'), '-b'], { cwd: web, stdio: 'inherit' });
const { build } = await import(pathToFileURL(requireWeb.resolve('vite')));
let capturedChunks;
await build({
  root: web, configFile: resolve(web, 'vite.config.ts'),
  build: { outDir: dist, emptyOutDir: true, sourcemap: false },
  plugins: [independentPdfPlugin(requireWeb('typescript')), {
    name: 'sejire-independent-boundary',
    generateBundle(_options, bundle) {
      capturedChunks = Object.values(bundle).filter(item => item.type === 'chunk').map(chunk => ({
        file: chunk.fileName,
        imports: [...chunk.imports].sort(), dynamicImports: [...chunk.dynamicImports].sort(),
        modules: Object.entries(chunk.modules).filter(([, module]) => module.renderedLength > 0)
          .map(([id]) => normalizeModuleId(id, root)).sort(),
      })).sort((a, b) => a.file.localeCompare(b.file));
      this.emitFile({ type: 'asset', fileName: PROFILE_FILE,
        source: JSON.stringify(INDEPENDENT_PROFILE_DOCUMENT, null, 2) + '\n' });
    },
  }],
});
await finalizeIndependentBoundary(dist, capturedChunks);

// The old admin password verifier is intentionally retained in the old funded
// source/profile. It is not a dependency or published setting of the direct app.
await rm(resolve(dist, 'admin-lock.json'), { force: true });
await mkdir(resolve(dist, 'recovery'), { recursive: true });
for (const name of RECOVERY_FILES) {
  const source = resolve(root, 'tools/recovery', name), info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('independent_unsafe_recovery_file');
  await copyFile(source, resolve(dist, 'recovery', name));
}
console.log(JSON.stringify({ status: 'PASS', ...await verifyIndependentBuild(dist), dist,
  note: 'Local static build only; no network payment, archive upload, deployment or ArNS change.' }, null, 2));
