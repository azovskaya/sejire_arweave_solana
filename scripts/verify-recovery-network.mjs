import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const manifest=JSON.parse(await readFile(new URL('../apps/web/src/lib/recovery/legacy-locators.v1.json',import.meta.url),'utf8'));
const fixture=manifest.entries.find(entry=>entry.archiveSha256&&entry.archiveBytes);
if(!fixture)throw Error('no public encrypted fixture');
const id=fixture.txIds[0],origin='https://azovskaya.github.io';
const bases=['https://arweave.net','https://turbo-gateway.com'];
let successes=0;
for(const base of bases){
  try{
    const [metadata,raw]=await Promise.all(['tx/','raw/'].map(path=>fetch(`${base}/${path}${id}`,{headers:{Origin:origin},signal:AbortSignal.timeout(8000)})));
    if(!metadata.ok||!raw.ok||metadata.headers.get('access-control-allow-origin')!=='*'||raw.headers.get('access-control-allow-origin')!=='*')throw Error('HTTP or CORS');
    const transaction=await metadata.json(),bytes=new Uint8Array(await raw.arrayBuffer());
    const digest=createHash('sha256').update(bytes).digest('hex');
    if(transaction.id!==id||bytes.length!==fixture.archiveBytes||digest!==fixture.archiveSha256)throw Error('fixture mismatch');
    successes++;console.log(`${new URL(base).host}: metadata/raw/CORS OK`);
  }catch(error){console.log(`${new URL(base).host}: unavailable (${error instanceof Error?error.message:'unknown'})`);}
}
const peers=await fetch('https://turbo-gateway.com/ar-io/peers',{headers:{Origin:origin},signal:AbortSignal.timeout(8000)});
const body=peers.ok?await peers.json():{};
if(!peers.ok||peers.headers.get('access-control-allow-origin')!=='*'||Object.keys(body.gateways??{}).length<2)throw Error('AR.IO peers/CORS unavailable');
if(successes<2)throw Error('fewer than two independent raw+metadata gateways');
console.log(`AR.IO peers available: ${Object.keys(body.gateways).length}`);
