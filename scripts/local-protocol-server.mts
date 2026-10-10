/** Explicit synthetic localhost only. No RPC/broadcast/upload to real networks. */
import { createServer } from 'node:http';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pilot } from '../apps/sponsor/tests/protocol-pilot';
import { protocolHttp } from '../apps/sponsor/src/protocol/http';
if(!process.argv.includes('--synthetic'))throw Error('This launcher requires --synthetic; no live AO binding is claimed');
const file=resolve(process.env.SEJIRE_PROTOCOL_JOURNAL??'.cache/protocol/local-signed-journal.json');
await mkdir(dirname(file),{recursive:true,mode:0o700});
const lock=await open(file+'.lock','wx',0o600); // Prevent a second local scheduler from forking this file.
const close=async()=>{await lock.close();await import('node:fs/promises').then(fs=>fs.unlink(file+'.lock'));};
process.once('SIGINT',()=>{void close().then(()=>process.exit(0));});process.once('SIGTERM',()=>{void close().then(()=>process.exit(0));});
const p=await pilot(async value=>{
 const temporary=file+'.next';const f=await open(temporary,'w',0o600);await f.writeFile(JSON.stringify(value));await f.sync();await f.close();await rename(temporary,file);
});
try{const saved=JSON.parse(await readFile(file,'utf8'));await p.engine.restore(saved,saved.checkpoint);}catch(e){if(!(e&&typeof e==='object'&&'code'in e&&e.code==='ENOENT'))throw e;}
const origin='http://127.0.0.1:5173',handler=protocolHttp(p.engine,origin,true);
createServer(async(req,res)=>{
 try{const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>600000){res.writeHead(413);res.end();return;}chunks.push(chunk);}
 const body=chunks.length?Buffer.concat(chunks):undefined;
 const response=await handler(new Request('http://127.0.0.1:8787'+req.url,{method:req.method,headers:req.headers as Record<string,string>,...(body?{body}: {})}));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(503);res.end('Local operation requires reconciliation');}
}).listen(8787,'127.0.0.1',()=>console.log('LOCAL SYNTHETIC signed journal: http://127.0.0.1:8787; no Cloudflare, no SQLite, NOT live AO'));
