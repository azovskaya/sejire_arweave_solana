import { startLinuxCheckout } from '../apps/sponsor/linux-server.mjs';
import { startBackupSchedule } from '../scripts/linux-backup.mjs';

const dbPath = process.env.SEJIRE_LINUX_DB;
if (!dbPath) throw Error('linux_database_path_required');
const host = process.env.SEJIRE_LINUX_HOST ?? '127.0.0.1';
const port = Number(process.env.SEJIRE_LINUX_PORT ?? process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('linux_invalid_port');
const backend = await startLinuxCheckout({ dbPath, host, port, bindings: process.env });
const backups = process.env.SEJIRE_BACKUP_DIR
  ? await startBackupSchedule({ dbPath, directory: process.env.SEJIRE_BACKUP_DIR,
    intervalMs: Number(process.env.SEJIRE_BACKUP_INTERVAL_MS ?? 3600000), retain: Number(process.env.SEJIRE_BACKUP_RETAIN ?? 48),
    onError: () => console.error('linux_backup_failed; previous verified backups are retained') })
  : null;
console.log(`SEJIRE portable service listening on ${host}:${backend.address.port}; SQLite writer protected; backups ${backups ? 'enabled' : 'not configured'}.`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  void Promise.all([backups?.close(), backend.close()]).then(() => process.exit(0), () => { console.error('linux_shutdown_failed'); process.exit(1); });
});
