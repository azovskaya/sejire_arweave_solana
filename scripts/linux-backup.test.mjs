import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackup, verifyBackup, restoreBackup, acknowledgeRestore, pruneBackups } from './linux-backup.mjs';

test('online WAL snapshot retains exact committed obligations; restoring cannot overwrite a live database', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sejire-backup-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'live.sqlite'), db = new DatabaseSync(path); t.after(() => db.close());
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE obligations(id TEXT PRIMARY KEY, signed BLOB, amount TEXT);');
  const insert = db.prepare('INSERT INTO obligations VALUES(?,?,?)');
  insert.run('original-paid-order', Buffer.from('synthetic-exact-signed-bytes'), '30000000');
  const b = await createBackup({ dbPath: path, directory: join(root, 'backups') });
  assert.equal((await stat(b.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(b.directory, 'ledger.sqlite'))).mode & 0o777, 0o600);
  insert.run('after-snapshot', Buffer.from('later'), '30000000');
  const copy = new DatabaseSync((await verifyBackup(b.directory)).file, { readOnly: true });
  try {
    const rows = copy.prepare('SELECT * FROM obligations').all(); assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'original-paid-order'); assert.equal(Buffer.from(rows[0].signed).toString(), 'synthetic-exact-signed-bytes');
  } finally { copy.close(); }
  await assert.rejects(restoreBackup(b.directory, path), /destination_exists/);
  const restored = join(root, 'restored.sqlite'); await restoreBackup(b.directory, restored);
  const marker = JSON.parse(await readFile(restored + '.restore-review.json', 'utf8'));
  assert.equal(marker.sha256, b.manifest.sha256);
  await assert.rejects(acknowledgeRestore(restored, b.manifest.sha256, 'yes'), /review_required/);
  await assert.rejects(acknowledgeRestore(restored, '0'.repeat(64), 'RECONCILIATION_REVIEWED'), /review_mismatch/);
  await acknowledgeRestore(restored, b.manifest.sha256, 'RECONCILIATION_REVIEWED');
  await assert.rejects(stat(restored + '.restore-review.json'), { code: 'ENOENT' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM obligations').get().n, 2);
});

test('damaged snapshots and links are refused; retention only removes verified owned snapshots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sejire-backup-retain-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'live.sqlite'), db = new DatabaseSync(path); db.exec('CREATE TABLE x(n); INSERT INTO x VALUES(1)'); db.close();
  const directory = join(root, 'backups'); const snapshots = [];
  for (let i = 0; i < 3; i++) snapshots.push(await createBackup({ dbPath: path, directory, now: () => Date.UTC(2026,10,25,0,0,i) }));
  const unknown = join(directory, 'operator-note.txt'); await writeFile(unknown, 'keep');
  assert.equal((await pruneBackups(directory, 2)).removed, 1);
  assert.equal(await readFile(unknown, 'utf8'), 'keep');
  await assert.rejects(stat(snapshots[0].directory), { code: 'ENOENT' });
  const broken = join(snapshots[1].directory, 'ledger.sqlite'); await writeFile(broken, 'broken');
  await assert.rejects(verifyBackup(snapshots[1].directory), /digest_mismatch/);
  await assert.rejects(restoreBackup(snapshots[1].directory, join(root, 'new.sqlite')), /digest_mismatch/);
  await rm(broken); await symlink(path, broken);
  await assert.rejects(verifyBackup(snapshots[1].directory), /unsafe_file/);
  assert.equal((await pruneBackups(directory, 2)).removed, 0);
  await stat(snapshots[1].directory);
});
