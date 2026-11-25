/** Consistent SQLite snapshots. No wallet, network, archive decryption or overwrite. */
import { backup, DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { acquireWriter, canonicalDatabasePath } from '../apps/sponsor/linux-writer.mjs';
const NAME = /^sejire-backup-\d{8}T\d{9}Z-[a-f0-9-]{36}$/;
async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
const fail = (ok, code) => { if (!ok) throw Error(code); };
async function regular(path) { const s = await lstat(path); fail(s.isFile() && !s.isSymbolicLink(), 'backup_unsafe_file'); return s; }
async function privateDirectory(path) {
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path); fail(info.isDirectory() && !info.isSymbolicLink(), 'backup_unsafe_directory');
  // Never chmod an existing shared parent such as /tmp or an operator's home.
  if (created) await chmod(path, 0o700);
  else fail((info.mode & 0o077) === 0, 'backup_directory_not_private');
}
function integrity(path) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try { const rows = db.prepare('PRAGMA quick_check').all(); fail(rows.length === 1 && Object.values(rows[0])[0] === 'ok', 'backup_integrity_failed'); }
  finally { db.close(); }
}
async function syncFile(path) { const f = await open(path, 'r'); try { await f.sync(); } finally { await f.close(); } }
async function syncDirectory(path) { const f = await open(path, 'r'); try { await f.sync(); } finally { await f.close(); } }

export async function createBackup({ dbPath, directory, now = Date.now, timeoutMs = 30000 }) {
  fail(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 300000, 'backup_invalid_timeout');
  const source = await realpath(dbPath); await regular(source);
  const root = resolve(directory); await privateDirectory(root);
  const createdAt = new Date(now()).toISOString();
  const name = 'sejire-backup-' + createdAt.replace(/[-:.]/g, '') + '-' + randomUUID();
  fail(NAME.test(name), 'backup_invalid_timestamp');
  const target = join(root, name); await mkdir(target, { mode: 0o700 });
  const snapshot = join(target, 'ledger.sqlite');
  const db = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
  let completed = false;
  try {
    const deadline = Date.now() + timeoutMs;
    await backup(db, snapshot, { rate: 128, progress() { if (Date.now() > deadline) throw Error('backup_timed_out'); } });
    await chmod(snapshot, 0o600); integrity(snapshot); await syncFile(snapshot);
    const info = await regular(snapshot);
    const manifest = { schema: 'sejire/sqlite-backup/v1', createdAt, file: 'ledger.sqlite', bytes: info.size,
      sha256: await fileHash(snapshot), integrity: 'ok', recoveryReviewRequired: true };
    await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await syncFile(join(target, 'manifest.json'));
    await syncDirectory(target); await syncDirectory(root);
    completed = true;
    return { directory: target, manifest };
  } finally { db.close(); if (!completed) await rm(target, { recursive: true, force: true }); }
}

export async function verifyBackup(directory) {
  const root = resolve(directory), info = await lstat(root);
  fail(info.isDirectory() && !info.isSymbolicLink(), 'backup_unsafe_directory');
  const meta = join(root, 'manifest.json'); const m = await regular(meta);
  fail(m.size <= 4096, 'backup_invalid_manifest');
  const manifest = JSON.parse(await readFile(meta, 'utf8'));
  fail(manifest.schema === 'sejire/sqlite-backup/v1' && manifest.file === 'ledger.sqlite' &&
    Number.isSafeInteger(manifest.bytes) && manifest.bytes > 0 && /^[a-f0-9]{64}$/.test(manifest.sha256) &&
    manifest.integrity === 'ok' && manifest.recoveryReviewRequired === true, 'backup_invalid_manifest');
  const file = join(root, 'ledger.sqlite'); const stat = await regular(file);
  fail(stat.size === manifest.bytes && await fileHash(file) === manifest.sha256, 'backup_digest_mismatch');
  integrity(file);
  return { file, manifest };
}

export async function pruneBackups(directory, retain = 48) {
  fail(Number.isInteger(retain) && retain >= 2 && retain <= 720, 'backup_invalid_retention');
  const root = resolve(directory); await privateDirectory(root);
  const verified = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
    try { const b = await verifyBackup(join(root, entry.name)); verified.push({ path: join(root, entry.name), at: b.manifest.createdAt }); }
    catch { /* Keep damaged/unknown evidence for explicit operator review. */ }
  }
  verified.sort((a, b) => b.at.localeCompare(a.at) || b.path.localeCompare(a.path));
  for (const old of verified.slice(retain)) await rm(old.path, { recursive: true });
  if (verified.length > retain) await syncDirectory(root);
  return { verified: verified.length, removed: Math.max(0, verified.length - retain) };
}

export async function restoreBackup(directory, targetPath) {
  const checked = await verifyBackup(directory);
  await privateDirectory(dirname(resolve(targetPath)));
  const target = await canonicalDatabasePath(targetPath);
  for (const suffix of ['', '-wal', '-shm', '.writer.lock', '.restore-review.json']) {
    try { await lstat(target + suffix); throw Error('backup_restore_destination_exists'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  const temp = join(dirname(target), '.' + basename(target) + '.restore-' + randomUUID());
  const marker = target + '.restore-review.json';
  // Startup and restore hold the SAME kernel lock. The marker alone is not a
  // mutex: it can appear while another process is awaiting guard acquisition.
  const guard = await acquireWriter(target);
  let markerCreated = false, linked = false;
  try {
    for (const suffix of ['', '-wal', '-shm', '.restore-review.json']) {
      try { await lstat(target + suffix); throw Error('backup_restore_destination_exists'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    await copyFile(checked.file, temp, constants.COPYFILE_EXCL); await chmod(temp, 0o600); await syncFile(temp);
    await writeFile(marker, JSON.stringify({ schema: 'sejire/restore-review/v1', sha256: checked.manifest.sha256,
      backupCreatedAt: checked.manifest.createdAt, restoredAt: new Date().toISOString(),
      reason: 'External payments after this snapshot must be reconciled before startup.' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    markerCreated = true; await syncFile(marker); await syncDirectory(dirname(target));
    // Atomic no-replace publication: a concurrent target creator cannot be overwritten.
    await link(temp, target); linked = true; await syncDirectory(dirname(target));
    return { target, sha256: checked.manifest.sha256, startupBlockedUntilReview: true };
  } finally {
    try {
      await rm(temp, { force: true });
      if (markerCreated && !linked) await rm(marker, { force: true });
      await syncDirectory(dirname(target));
    } finally { guard.close(); }
  }
}

export async function acknowledgeRestore(dbPath, expectedSha256, confirmation) {
  fail(confirmation === 'RECONCILIATION_REVIEWED' && /^[a-f0-9]{64}$/.test(expectedSha256), 'backup_restore_review_required');
  const target = await realpath(dbPath), marker = target + '.restore-review.json';
  const guard = await acquireWriter(target);
  try {
  await regular(marker); const review = JSON.parse(await readFile(marker, 'utf8'));
  fail(review.schema === 'sejire/restore-review/v1' && review.sha256 === expectedSha256 &&
    await fileHash(target) === expectedSha256, 'backup_restore_review_mismatch');
  integrity(target);
  const accepted = { ...review, reviewedAt: new Date().toISOString(), confirmation };
  const acceptedPath = target + '.restore-review-accepted-' + randomUUID() + '.json';
  await writeFile(acceptedPath, JSON.stringify(accepted, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await syncFile(acceptedPath); await syncDirectory(dirname(target));
  await unlink(marker); await syncDirectory(dirname(target));
  return { acknowledged: true, sha256: expectedSha256, note: 'Operator acknowledgement, not proof that external payments were reconciled by this tool.' };
  } finally { guard.close(); }
}

export async function startBackupSchedule({ dbPath, directory, intervalMs = 3600000, retain = 48, onError = () => {} }) {
  fail(Number.isSafeInteger(intervalMs) && intervalMs >= 60000 && intervalMs <= 86400000, 'backup_invalid_interval');
  fail(Number.isInteger(retain) && retain >= 2 && retain <= 720, 'backup_invalid_retention');
  await privateDirectory(resolve(directory));
  let active = null, stopped = false;
  const run = () => {
    if (active || stopped) return active;
    active = createBackup({ dbPath, directory }).then(() => pruneBackups(directory, retain))
      .catch(() => { onError(); }).finally(() => { active = null; });
    return active;
  };
  const timer = setInterval(run, intervalMs); timer.unref(); void run();
  return { run, async close() { stopped = true; clearInterval(timer); await active; } };
}
