/** Single-process Linux adapter for the existing checkout/fund ledger contracts.
 * Start with Node 22: node --experimental-sqlite --import tsx bin/linux-checkout.mjs
 * Never point two operators at the same treasury or copy live DO state here.
 */
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {lstat,mkdir,realpath} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {CheckoutLedger,LEDGER_OBJECT_NAME} from './src/checkout/durableStore.ts';
import {checkoutApi} from './src/checkout/api.ts';
import {fundApi} from './src/fund/api.ts';
import {RecipientSettings,withRecipientSettings} from './src/checkout/recipientSettings.ts';
import {recipientAdminApi,RECIPIENT_ADMIN_PATH} from './src/checkout/recipientAdmin.ts';

export function sqliteStorage(db){
  db.exec('PRAGMA foreign_keys=ON');db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE IF NOT EXISTS sejire_alarm(id INTEGER PRIMARY KEY CHECK(id=1),at INTEGER NOT NULL)');
  return {
    sql:{exec(sql,...args){let rows=[];
      if(!args.length&&sql.includes(';'))db.exec(sql);
      else {const statement=db.prepare(sql);if(statement.columns().length)rows=statement.all(...args).map(row=>({...row}));else statement.run(...args);}
      return {toArray:()=>rows,[Symbol.iterator]:()=>rows[Symbol.iterator]()};}},
    transactionSync(callback){db.exec('BEGIN IMMEDIATE');try{const value=callback();db.exec('COMMIT');return value;}
      catch(error){db.exec('ROLLBACK');throw error;}},
    async sync(){},
    async getAlarm(){return db.prepare('SELECT at FROM sejire_alarm WHERE id=1').get()?.at??null;},
    async setAlarm(at){const timestamp=at instanceof Date?at.getTime():at;
      if(!Number.isSafeInteger(timestamp))throw Error('invalid_alarm_time');
      db.prepare('INSERT INTO sejire_alarm(id,at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at').run(timestamp);},
    async deleteAlarm(){db.exec('DELETE FROM sejire_alarm');},
    alarmAt(){return db.prepare('SELECT at FROM sejire_alarm WHERE id=1').get()?.at??null;},
  };
}

async function canonicalDatabasePath(input){
  const requested=resolve(input),parent=await realpath(dirname(requested));
  const named=join(parent,basename(requested));
  let info;
  try{info=await lstat(named);}catch(error){if(error.code==='ENOENT')return named;throw error;}
  const path=info.isSymbolicLink()?await realpath(named):named;
  info=await lstat(path);
  // A hard-linked ledger could have two different sibling guard paths.
  if(!info.isFile()||info.nlink!==1)throw Error('invalid_backend_database_path');
  return path;
}

async function acquireWriter(path){
  const directory=path+'.writer.lock';
  // A permanent directory also blocks the previous adapter's open('wx'). A
  // legacy regular sentinel is never removed or guessed to be stale here.
  try{await mkdir(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const info=await lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink())throw Error('backend_writer_already_active');
  const guardPath=join(directory,'guard.sqlite');
  try{
    const existing=await lstat(guardPath);
    if(!existing.isFile()||existing.isSymbolicLink()||existing.nlink!==1)throw Error('invalid_backend_writer_guard');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  let guard;
  try{
    guard=new DatabaseSync(guardPath);
    guard.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE');
    return guard;
  }catch(error){
    guard?.close();
    if(error.errcode===5||error.errcode===6)throw Error('backend_writer_already_active');
    throw error;
  }
}

// The optional provider is an in-process test port already supported by fundApi.
// The CLI and HTTP requests cannot select it; production uses the normal provider.
export async function startLinuxCheckout({dbPath,host='127.0.0.1',port=0,bindings={},fundProvider}){
  if(typeof dbPath!=='string'||!dbPath||!Number.isSafeInteger(port)||port<0||port>65535)throw Error('invalid_backend_config');
  const path=await canonicalDatabasePath(dbPath),guard=await acquireWriter(path);
  let db,server,interval,tail=Promise.resolve(),closePromise;const background=new Set();
  const close=()=>closePromise??=(async()=>{
    if(interval)clearInterval(interval);
    if(server?.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    // Keep the kernel guard until requests, queued alarms and background work
    // have stopped using the ledger. This also handles a failed listen().
    do{await tail;await Promise.allSettled([...background]);}while(background.size);
    await tail;
    db?.close();
    guard.close();
    // Never unlink the directory or guard DB: another process may already
    // have opened that inode. SQLite releases its lock, including on SIGKILL.
  })();
  try{
    db=new DatabaseSync(path);const storage=sqliteStorage(db);
    const objectId={name:LEDGER_OBJECT_NAME,equals(other){return other?.name===LEDGER_OBJECT_NAME;}};
    let ledger,initial=Promise.resolve();
    const serial=work=>{const result=tail.then(work);tail=result.catch(()=>{});return result;};
    const namespace={idFromName(name){if(name!==LEDGER_OBJECT_NAME)throw Error('wrong_ledger_object');return objectId;},
      get(id){if(!objectId.equals(id))throw Error('wrong_ledger_object');return {fetch:(input,init)=>serial(async()=>{
        await initial;return ledger.fetch(new Request(input,init));})};}};
    const env={CHECKOUT_API_ENABLED:'false',CHECKOUT_PAID_ENABLED:'false',CHECKOUT_CONTRIBUTION_ENABLED:'false',
      FUND_API_ENABLED:'false',...bindings,CHECKOUT_LEDGER:namespace};
    const ctx={id:objectId,storage,blockConcurrencyWhile(work){
      const pending=Promise.resolve().then(work);
      if(!ledger)initial=Promise.all([initial,pending]).then(()=>{});
      return pending;
    },waitUntil(promise){
      const job=Promise.resolve(promise).catch(()=>{});background.add(job);void job.finally(()=>background.delete(job));}};
    ledger=new CheckoutLedger(ctx,env);
    // Honour the constructor's initialization gate before serving any request.
    await initial;
    // Opening a process must not execute or replace an alarm scheduled for later.
    // Recheck inside the queue so an earlier job can move or delete the alarm.
    const runDueAlarm=()=>serial(async()=>{if((storage.alarmAt()??Infinity)<=Date.now())await ledger.alarm();});
    initial=runDueAlarm();
    interval=setInterval(()=>{void runDueAlarm();},1000);
    interval.unref();
    const max=Math.min(20*1024*1024,Math.max(8192,(Number(env.MAX_ENVELOPE_BYTES)||524288)*2+8192));
    server=createServer(async(req,res)=>{
      try{
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>max){res.writeHead(413,{'Content-Type':'application/json'});res.end('{"error":"request_too_large"}');return;}chunks.push(chunk);}
        const url=new URL(req.url??'/','http://127.0.0.1');
        const headers=new Headers(req.headers);headers.set('CF-Connecting-IP',req.socket.remoteAddress??'unknown');
        const request=new Request(url,{method:req.method,headers,
          ...(['GET','HEAD'].includes(req.method??'GET')?{}:{body:Buffer.concat(chunks)})});
        const path=url.pathname;
        const offer=req.method==='GET'&&['/api/checkout/policy','/api/checkout/policy/contribution','/api/checkout/rpc-health'].includes(path);
        const create=req.method==='POST'&&path==='/api/checkout/orders';
        const selected=offer||create?withRecipientSettings(env,new RecipientSettings(storage).get()):env;
        const response=path===RECIPIENT_ADMIN_PATH?await recipientAdminApi(request,env):
          (await checkoutApi(request,selected)??await fundApi(request,selected,fundProvider)??
          new Response('{"error":"not_found"}',{status:404,headers:{'Content-Type':'application/json'}}));
        res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
      }catch{if(!res.headersSent)res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"backend_unavailable"}');}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
    return {address:server.address(),close};
  }catch(error){await close();throw error;}
}
