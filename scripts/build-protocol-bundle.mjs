import {build} from '../apps/sponsor/node_modules/esbuild/lib/main.js';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const root=resolve(new URL('..',import.meta.url).pathname);
export async function bundle(entry,outfile){
 const codeHash=createHash('sha256').update(await readFile(resolve(root,'apps/sponsor/src/protocol/journal.ts'))).digest('hex');
 await build({entryPoints:[entry],outfile,bundle:true,platform:'node',format:'esm',target:'node22',define:{'process.env.SEJIRE_PROTOCOL_CODE_HASH':JSON.stringify(codeHash)},banner:{js:"import {createRequire as _sejireRequire} from 'node:module'; const require=_sejireRequire(import.meta.url);"}});
}
