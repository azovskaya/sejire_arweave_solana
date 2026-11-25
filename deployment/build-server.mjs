/** Compile only the portable Linux service; never copy an environment or wallet. */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const requireSponsor = createRequire(resolve(root, 'apps/sponsor/package.json'));
const { build } = requireSponsor('esbuild');
const output = resolve(root, 'apps/sponsor/build');
await mkdir(output, { recursive: true });
const result = await build({ absWorkingDir: root, entryPoints: { server: 'deployment/server-entry.mjs', backup: 'scripts/linux-backup-cli.mjs',
  'import-ledger': 'apps/sponsor/bin/import-ledger.mjs' },
  outdir: output, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm',
  target: 'node24', packages: 'external', sourcemap: false, metafile: true, logLevel: 'warning' });
const paths = Object.keys(result.metafile.inputs).sort();
if (paths.some(path => /(?:^|\/)(?:\.env(?:\.|$)|.*(?:jwk|private-key)\.json$)|node_modules\/@cloudflare\//i.test(path))) throw Error('portable_server_unexpected_input');
await writeFile(resolve(output, 'source-boundary.json'), JSON.stringify({ schema: 'sejire/linux-bundle/v1',
  inputs: paths, note: 'External production packages come from the committed sponsor lockfile; no Cloudflare runtime.' }, null, 2) + '\n');
console.log(JSON.stringify({ status: 'PASS', files: paths.length, output: 'apps/sponsor/build/server.mjs' }));
