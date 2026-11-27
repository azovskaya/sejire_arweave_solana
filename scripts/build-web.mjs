/** npm build defaults to the complete verified Arweave-only static package. */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { webProfile } from './web-profile.mjs';

if (webProfile(process.env.VITE_DECENTRALIZED_MODE) === 'decentralized-direct-arweave') {
  await import('./build-arns-independent.mjs');
} else {
  // Existing payment/receipt recovery tests select this historical mode explicitly.
  const web = resolve(import.meta.dirname, '../apps/web');
  const requireWeb = createRequire(resolve(web, 'package.json'));
  execFileSync(process.execPath, [requireWeb.resolve('typescript/bin/tsc'), '-b'], { cwd: web, stdio: 'inherit' });
  const { build } = await import(pathToFileURL(requireWeb.resolve('vite')));
  await build({ root: web, configFile: resolve(web, 'vite.config.ts') });
}
