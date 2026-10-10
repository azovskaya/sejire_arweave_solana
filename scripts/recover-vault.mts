/** Offline tool: recovery words arrive on stdin, never in argv/logs. */
import {readFile,open} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {parseEnvelope} from '../apps/web/src/lib/crypto/envelope';
import {deriveKeysFromMnemonic} from '../apps/web/src/lib/crypto/keys';
import {decryptJson} from '../apps/web/src/lib/crypto/encrypt';
Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
try{
 const [input,output]=process.argv.slice(2);if(!input||!output||process.stdin.isTTY)throw Error('usage');
 let words='';for await(const chunk of process.stdin){words+=chunk.toString();if(words.length>2048)throw Error('input');}
 const envelope=parseEnvelope(JSON.parse(await readFile(input,'utf8')));
 const keys=deriveKeysFromMnemonic(words.trim());if(keys.vaultId!==envelope.vault_id)throw Error('key');
 const vault=await decryptJson(keys.encKey,envelope);
 const f=await open(output,'wx',0o600);try{await f.writeFile(JSON.stringify(vault));}finally{await f.close();}
 console.log('Recovered locally; output contains private family data, mode 600.');
}catch{console.error('Recovery failed. Supply archive path, new output path and SEJIRE words on stdin.');process.exitCode=1;}
