#!/usr/bin/env node
/**
 * Read-only live checks for ArNS cutover readiness.
 * No wallet, no ArNS change, no Fund order POST, no promo plaintext.
 */
import { writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { assessArnsLiveChecks } from './arns-live-policy.mjs';

const FUND = (process.env.VITE_FUND_API_URL || 'https://sejire-sponsor.azovskaya-alissa.workers.dev').replace(/\/$/, '');
const ORIGIN = 'https://sejire.ar.io';
const DENIED = 'https://evil.example';
const DIST = process.argv[2] || 'apps/web/dist';
const OUT = process.argv[3] || '.cache/arns-live-smoke.json';

async function listJs(root, dir = root, out = []) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) await listJs(root, path, out);
    else if (item.isFile() && item.name.endsWith('.js')) out.push(relative(root, path).split('\\').join('/'));
  }
  return out;
}

async function probe(path, method = 'GET', origin = ORIGIN, checkout = false) {
  const init = {
    method,
    headers: {
      Origin: origin,
      ...(method === 'OPTIONS' ? {
        'Access-Control-Request-Method': checkout ? 'POST' : 'GET',
        'Access-Control-Request-Headers': checkout ? 'authorization, content-type, idempotency-key' : 'content-type',
      } : {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  };
  const res = await fetch(`${FUND}${path}`, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
  return {
    path, method, origin,
    status: res.status,
    allowOrigin: res.headers.get('access-control-allow-origin'),
    allowMethods: res.headers.get('access-control-allow-methods'),
    allowHeaders: res.headers.get('access-control-allow-headers'),
    body: json ?? (text.slice(0, 200) || null),
  };
}

const html = await readFile(join(DIST, 'index.html'), 'utf8');
const jsFiles = await listJs(DIST);
let fundHits = 0;
for (const name of jsFiles) {
  const body = await readFile(join(DIST, name), 'utf8');
  if (body.includes(FUND)) fundHits += 1;
}

const checks = [];
checks.push(await probe('/api/fund/balance', 'OPTIONS'));
checks.push(await probe('/api/fund/balance', 'GET'));
checks.push(await probe('/api/checkout/policy', 'OPTIONS'));
checks.push(await probe('/api/checkout/policy', 'GET'));
checks.push(await probe('/api/checkout/orders', 'OPTIONS', ORIGIN, true));
checks.push(await probe('/api/fund/balance', 'OPTIONS', DENIED));
checks.push(await probe('/api/fund/balance', 'GET', DENIED));

const balance = checks.find((c) => c.path === '/api/fund/balance' && c.method === 'GET' && c.origin === ORIGIN);
const failures = assessArnsLiveChecks(checks, ORIGIN);
if (!html.includes('./assets/')) failures.push('index_not_relative');
if (fundHits < 1) failures.push('fund_url_not_baked');

const report = {
  schema: 'sejire/arns-live-smoke/v1',
  checkedAt: new Date().toISOString(),
  fundApi: FUND,
  arnsOrigin: ORIGIN,
  dist: DIST,
  static: {
    relativeAssets: html.includes('./assets/'),
    fundUrlChunks: fundHits,
    jsAssets: jsFiles.length,
  },
  probes: checks,
  failures,
  ok: failures.length === 0,
  note: 'Read-only. No Fund order POST, no Arweave upload, no ArNS Target change.',
};

await mkdir(join(OUT, '..'), { recursive: true }).catch(() => {});
await writeFile(OUT, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ok: report.ok, failures, balanceStatus: balance?.status, treasury: balance?.body?.treasuryAddress, out: OUT }, null, 2));
if (!report.ok) process.exit(1);
