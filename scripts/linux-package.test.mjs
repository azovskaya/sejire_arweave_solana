import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { verifyBackup } from './linux-backup.mjs';

test('compiled production service starts with disabled admissions, backs up, stops and reopens the same persistent database', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sejire-package-')), dbPath = join(directory, 'ledger.sqlite'), backupDir = join(directory, 'backups');
  const reserving = createServer(); reserving.listen(0, '127.0.0.1'); await once(reserving, 'listening');
  const port = reserving.address().port; await new Promise(resolve => reserving.close(resolve));
  const sourceCommit = 'a'.repeat(40), processes = [];
  const start = async () => {
    const child = spawn(process.execPath, [resolve('apps/sponsor/build/server.mjs')], { env: { PATH: process.env.PATH,
      SEJIRE_LINUX_DB: dbPath, SEJIRE_LINUX_HOST: '127.0.0.1', SEJIRE_LINUX_PORT: String(port), SEJIRE_BUILD_COMMIT: sourceCommit,
      SEJIRE_BACKUP_DIR: backupDir, CHECKOUT_ALLOWED_ORIGINS: 'https://sejire.ar.io',
      CHECKOUT_API_ENABLED: 'false', CHECKOUT_PAID_ENABLED: 'false', CHECKOUT_PAID_EXECUTION_ENABLED: 'false', FUND_API_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    processes.push(child); let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !output.includes('SEJIRE portable service listening')) {
      if (child.exitCode !== null) assert.fail(`compiled service exited: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.match(output, /SEJIRE portable service listening/);
    return child;
  };
  const stop = async child => { const exited = once(child, 'exit'); child.kill('SIGTERM'); const [code] = await exited; assert.equal(code, 0); };
  try {
    const first = await start();
    const health = await fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.json());
    assert.deepEqual(health, { schema: 'sejire/service-health/v1', status: 'ok', runtime: 'linux-sqlite', sourceCommit });
    const denied = await fetch(`http://127.0.0.1:${port}/api/fund/admin/paid-orders`, { headers: { Origin: 'https://sejire.ar.io' } });
    assert.equal(denied.status, 401);
    const offer = await fetch(`http://127.0.0.1:${port}/api/checkout/policy`, { headers: { Origin: 'https://sejire.ar.io' } });
    assert.ok(offer.status >= 400 || (await offer.json()).ready === false);
    await stop(first);
    const snapshots = await readdir(backupDir); assert.ok(snapshots.length >= 1);
    const verified = await verifyBackup(join(backupDir, snapshots[0])); assert.ok(verified);
    const headerBefore = (await readFile(dbPath)).subarray(0, 16).toString(); assert.equal(headerBefore, 'SQLite format 3\0');
    const second = await start(); assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200); await stop(second);
  } finally { for (const child of processes) if (child.exitCode === null) child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); }
});
