import { pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readHidden } from './admin-hidden-input.mjs';

const target = fileURLToPath(new URL('../apps/web/public/admin-lock.json', import.meta.url));

function parseVerifier() {
  const lock = JSON.parse(readFileSync(target, 'utf8'));
  if (lock?.schema !== 'sejire/admin-lock/v1' || lock.algorithm !== 'PBKDF2-SHA256' ||
      lock.configured !== true || lock.iterations !== 600_000 ||
      typeof lock.salt !== 'string' || typeof lock.digest !== 'string' ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(lock.salt) || !/^[A-Za-z0-9+/]+={0,2}$/.test(lock.digest)) {
    throw new Error('Некорректный verifier.');
  }
  const salt = Buffer.from(lock.salt, 'base64');
  const digest = Buffer.from(lock.digest, 'base64');
  if (salt.length !== 32 || digest.length !== 32) throw new Error('Некорректный verifier.');
  return { salt, digest, iterations: lock.iterations };
}

try {
  const { salt, digest, iterations } = parseVerifier();
  const password = (await readHidden('Пароль администратора: ')).normalize('NFC');
  const actual = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  if (timingSafeEqual(actual, digest)) process.stdout.write('Пароль совпадает с verifier.\n');
  else {
    process.stdout.write('Пароль НЕ совпадает с verifier.\n');
    process.exitCode = 1;
  }
} catch {
  process.stderr.write('Не удалось проверить пароль.\n');
  process.exitCode = 1;
}
