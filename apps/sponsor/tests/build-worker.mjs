import { build } from 'esbuild';
import { builtinModules } from 'node:module';
/** Same Workers Node compatibility used by the dedicated preview; no source rewriting. */
export async function buildWorker(entry, outfile) {
  const alias = Object.fromEntries(builtinModules.filter(name => !name.startsWith('_') && !name.startsWith('node:')).map(name => [name, `node:${name}`]));
  return build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile, metafile: true, alias, external: ['node:*'],
    // Bundled CommonJS dependencies still require built-in Node modules. Workers'
    // node:module resolves built-ins only; application packages remain bundled.
    banner: { js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire('/sejire-worker.mjs');" },
  });
}
