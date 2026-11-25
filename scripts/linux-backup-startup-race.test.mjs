import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackup, restoreBackup } from './linux-backup.mjs';
import { startLinuxCheckout } from '../apps/sponsor/linux-server.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('a restore published after startup saw no review marker cannot start old obligations', { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'sejire-startup-restore-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const live = join(root, 'source.sqlite'), db = new DatabaseSync(live);
  db.exec('CREATE TABLE synthetic_obligations(id TEXT PRIMARY KEY, signed_bytes BLOB);');
  db.prepare('INSERT INTO synthetic_obligations VALUES(?,?)').run('already-accepted-obligation', Buffer.from('synthetic-exact-signed-bytes'));
  db.close();
  const backup = await createBackup({ dbPath: live, directory: join(root, 'backups') });
  const target = join(root, 'restored.sqlite'), marker = target + '.restore-review.json';
  const reached = deferred(), resume = deferred();
  const originalStat = fs.lstat;
  let intercepted = false, running;
  // Real filesystem and SQLite operations; only their ordering is controlled.
  // Capture ENOENT first, then suspend returning that stale observation to the
  // real server. This is the exact startup/restore interleaving under review.
  fs.lstat = async (path, ...args) => {
    let result, failure;
    try { result = await originalStat(path, ...args); } catch (error) { failure = error; }
    if (path === marker && !intercepted) {
      intercepted = true;
      assert.equal(failure?.code, 'ENOENT');
      reached.resolve();
      await resume.promise;
    }
    if (failure) throw failure;
    return result;
  };
  syncBuiltinESMExports();
  const startup = startLinuxCheckout({ dbPath: target, bindings: {
    CHECKOUT_API_ENABLED: 'false', CHECKOUT_PAID_ENABLED: 'false', CHECKOUT_CONTRIBUTION_ENABLED: 'false', FUND_API_ENABLED: 'false',
  } }).then(value => { running = value; return { value }; }, error => ({ error }));
  try {
    await reached.promise;
    const restored = await restoreBackup(backup.directory, target);
    assert.equal(restored.startupBlockedUntilReview, true);
    assert.equal(JSON.parse(await fs.readFile(marker, 'utf8')).sha256, backup.manifest.sha256);
    resume.resolve();
    const outcome = await startup;
    assert.equal(outcome.error?.message, 'linux_restore_review_required');
    assert.equal(running, undefined);
    // No schema initialization, alarm or request handled this restored ledger.
    const actual = createHash('sha256').update(await fs.readFile(target)).digest('hex');
    assert.equal(actual, backup.manifest.sha256);
    await fs.stat(marker);
    const read = new DatabaseSync(target, { readOnly: true });
    try {
      const row = read.prepare('SELECT * FROM synthetic_obligations').get();
      assert.equal(row.id, 'already-accepted-obligation');
      assert.equal(Buffer.from(row.signed_bytes).toString(), 'synthetic-exact-signed-bytes');
      assert.deepEqual(read.prepare("SELECT name FROM sqlite_master WHERE name='fund_jobs'").all(), []);
    } finally { read.close(); }
  } finally {
    resume.resolve();
    fs.lstat = originalStat;
    syncBuiltinESMExports();
    await startup;
    await running?.close();
  }
});
