import { resolve } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { buildWorker } from '../apps/sponsor/tests/build-worker.mjs';
const directory = resolve('.cache/devnet-preview'); await mkdir(directory, { recursive: true });
const outfile = resolve(directory, 'worker.mjs');
const result = await buildWorker(resolve('apps/sponsor/src/preview.ts'), outfile);
await writeFile(resolve(directory, 'worker-metafile.json'), JSON.stringify(result.metafile));
const raw = await readFile(outfile), compressed = gzipSync(raw).length;
if (compressed > 3 * 1024 * 1024) throw new Error('preview_worker_exceeds_free_plan_limit');
await writeFile(resolve(directory, 'build-evidence.json'), JSON.stringify({ entry: 'apps/sponsor/src/preview.ts', compressedBytes: compressed, sourceCommit: process.env.GITHUB_SHA ?? null, publication: false }, null, 2));
console.log(`preview Worker package: ${compressed} gzip bytes; no publication/secrets`);
// Reviewable CI evidence even when downloading the retained artifact is unavailable.
for (const output of Object.values(result.metafile.outputs)) {
  for (const [path, input] of Object.entries(output.inputs)) {
    if (/secp256k1|elliptic|noble\/ed25519|HexSolana|ethers/.test(path))
      console.log(`Worker dependency: ${path} (${input.bytesInOutput} bundled bytes)`);
  }
}
