import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const target=fileURLToPath(new URL('../apps/web/public/admin-lock.json',import.meta.url));
const iterations=600_000;

if(!process.stdin.isTTY||!process.stdout.isTTY){
  process.stderr.write('Run admin:set-password in an interactive terminal.\n');
  process.exitCode=1;
}else{
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try{
    const first=await readHidden('Новый пароль администратора: ');
    const second=await readHidden('Повторите пароль: ');
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
  }finally{
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

function readHidden(prompt){
  process.stdout.write(prompt);
  return new Promise((resolve,reject)=>{
    let value='';
    const decoder=new StringDecoder('utf8');
    const onData=chunk=>{
      for(const char of decoder.write(chunk)){
        if(char==='\r'||char==='\n'){
          process.stdin.off('data',onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if(char==='\u0003'){
          process.stdin.off('data',onData);
          process.stdout.write('\n');
          reject(new Error('Отменено.'));
          return;
        }
        if(char==='\u007f'||char==='\b')value=Array.from(value).slice(0,-1).join('');
        else if(char>=' '&&!char.startsWith('\u001b'))value+=char;
      }
    };
    process.stdin.on('data',onData);
  });
}
