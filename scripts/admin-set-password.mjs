import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHidden } from './admin-hidden-input.mjs';

const target=fileURLToPath(new URL('../apps/web/public/admin-lock.json',import.meta.url));
const iterations=600_000;

try{
  const first=(await readHidden('Новый пароль администратора: ')).normalize('NFC');
  const second=(await readHidden('Повторите пароль: ')).normalize('NFC');
  if(first.length<16)throw new Error('Пароль должен содержать минимум 16 символов.');
  if(first!==second)throw new Error('Пароли не совпали.');
  const salt=randomBytes(32);
  const digest=pbkdf2Sync(first,salt,iterations,32,'sha256');
  const lock={schema:'sejire/admin-lock/v1',algorithm:'PBKDF2-SHA256',configured:true,
    iterations,salt:salt.toString('base64'),digest:digest.toString('base64')};
  const temporary=join(fileURLToPath(new URL('../apps/web/public/',import.meta.url)),`.admin-lock-${process.pid}.tmp`);
  writeFileSync(temporary,JSON.stringify(lock,null,2)+'\n',{mode:0o600});
  renameSync(temporary,target);
  process.stdout.write(`Verifier записан: ${target}\n`);
}catch(error){
  process.stderr.write(`${error instanceof Error?error.message:'Не удалось установить пароль.'}\n`);
  process.exitCode=1;
}
