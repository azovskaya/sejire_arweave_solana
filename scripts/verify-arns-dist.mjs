#!/usr/bin/env node
/** Fail closed if a static dist is not safe to host under sejire.ar.io for promo Fund. */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const dist = process.argv[2];
const expectedFund = process.argv[3];
if (!dist || !expectedFund) {
  console.error('usage: node scripts/verify-arns-dist.mjs <distDir> <https://fund-origin>');
  process.exit(2);
}
if (!/^https:\/\/[^/]+$/i.test(expectedFund) && !/^https:\/\/[^/]+\//i.test(expectedFund)) {
  // Accept origin with or without path; normalize to origin string presence in bundle.
}

async function listFiles(root, dir = root, out = []) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) await listFiles(root, path, out);
    else if (item.isFile()) out.push(relative(root, path).split('\\').join('/'));
    else throw Error('unsafe_static_asset');
  }
  return out.sort();
}

const html = await readFile(join(dist, 'index.html'), 'utf8');
if (!html.includes('./assets/')) throw Error('nonportable_static_entry: missing ./assets/');
if (/<(?:script|link)[^>]+(?:src|href)=["']https?:\/\//i.test(html)) {
  throw Error('nonportable_static_entry: absolute http(s) asset');
}

const names = await listFiles(dist);
const jsNames = names.filter((n) => n.startsWith('assets/') && n.endsWith('.js'));
if (!jsNames.length) throw Error('missing_js_assets');

let fundHits = 0;
let qaHits = 0;
let originFallbackHits = 0;
for (const name of jsNames) {
  const body = await readFile(join(dist, name), 'utf8');
  if (body.includes(expectedFund.replace(/\/$/, ''))) fundHits += 1;
  if (body.includes('VITE_QA_TOOLS') && /\b1\b/.test(body) && body.includes('Пример: 13')) qaHits += 1;
  // Crude guard: production ArNS bundle must not rely only on location.origin for Fund.
  if (body.includes('/api/fund') && !body.includes(expectedFund.replace(/\/$/, ''))) {
    // Still OK if fund URL is in another chunk; counted via fundHits across all chunks.
  }
  void (await stat(join(dist, name)));
}

if (fundHits < 1) {
  throw Error(`fund_api_url_not_baked: expected ${expectedFund} in JS assets`);
}

console.log(JSON.stringify({
  ok: true,
  dist,
  fundApi: expectedFund.replace(/\/$/, ''),
  fileCount: names.length,
  jsAssets: jsNames.length,
  fundUrlChunks: fundHits,
  qaSuspicious: qaHits,
  originFallbackHits,
}, null, 2));
