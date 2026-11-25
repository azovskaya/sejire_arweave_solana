import { createBackup, verifyBackup, restoreBackup, acknowledgeRestore } from './linux-backup.mjs';
try {
  const [action, first, second, third] = process.argv.slice(2); let result;
  if (action === 'create' && first && second) result = await createBackup({ dbPath: first, directory: second });
  else if (action === 'verify' && first && !second) result = await verifyBackup(first);
  else if (action === 'restore' && first && second && !third) result = await restoreBackup(first, second);
  else if (action === 'acknowledge' && first && second && third) result = await acknowledgeRestore(first, second, third);
  else throw Error('backup_usage_create_verify_restore_acknowledge');
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error instanceof Error && /^backup_[a-z_]+$/.test(error.message) ? error.message : 'backup_operation_failed'); process.exitCode = 1; }
