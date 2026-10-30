/** Single-process Linux adapter for the existing checkout/fund ledger contracts.
 * Start with Node 22: node --experimental-sqlite --import tsx bin/linux-checkout.mjs
 * Never point two operators at the same treasury or copy live DO state here.
 */
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {open,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {CheckoutLedger,LEDGER_OBJECT_NAME} from './src/checkout/durableStore.ts';
import {checkoutApi} from './src/checkout/api.ts';
import {fundApi} from './src/fund/api.ts';
import {RecipientSettings,withRecipientSettings} from './src/checkout/recipientSettings.ts';
import {recipientAdminApi,RECIPIENT_ADMIN_PATH} from './src/checkout/recipientAdmin.ts';

function sqliteStorage(db){
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
    async setAlarm(at){db.prepare('INSERT INTO sejire_alarm(id,at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at').run(at);},
    async deleteAlarm(){db.exec('DELETE FROM sejire_alarm');},
    alarmAt(){return db.prepare('SELECT at FROM sejire_alarm WHERE id=1').get()?.at??null;},
  };
}

export async function startLinuxCheckout({dbPath,host='127.0.0.1',port=0,bindings={}}){
  if(typeof dbPath!=='string'||!dbPath||!Number.isSafeInteger(port)||port<0||port>65535)throw Error('invalid_backend_config');
  const path=resolve(dbPath),lockPath=path+'.writer.lock';
  let lock;
  try{lock=await open(lockPath,'wx',0o600);}catch{throw Error('backend_writer_already_active');}
  let db,server,interval;const background=new Set();
  try{
    db=new DatabaseSync(path);const storage=sqliteStorage(db);
    const objectId={name:LEDGER_OBJECT_NAME,equals(other){return other?.name===LEDGER_OBJECT_NAME;}};
    let ledger,initial=Promise.resolve(),tail=Promise.resolve();
    const serial=work=>{const result=tail.then(work);tail=result.catch(()=>{});return result;};
    const namespace={idFromName(name){if(name!==LEDGER_OBJECT_NAME)throw Error('wrong_ledger_object');return objectId;},
      get(id){if(!objectId.equals(id))throw Error('wrong_ledger_object');return {fetch:(input,init)=>serial(async()=>{
        await initial;return ledger.fetch(new Request(input,init));})};}};
    const env={CHECKOUT_API_ENABLED:'false',CHECKOUT_PAID_ENABLED:'false',CHECKOUT_CONTRIBUTION_ENABLED:'false',
      FUND_API_ENABLED:'false',...bindings,CHECKOUT_LEDGER:namespace};
    const ctx={id:objectId,storage,blockConcurrencyWhile(work){return work();},waitUntil(promise){
      const job=Promise.resolve(promise).catch(()=>{});background.add(job);void job.finally(()=>background.delete(job));}};
    ledger=new CheckoutLedger(ctx,env);
    initial=serial(()=>ledger.alarm());
    interval=setInterval(()=>{if((storage.alarmAt()??Infinity)<=Date.now())void serial(()=>ledger.alarm());},1000);
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
          (await checkoutApi(request,selected)??await fundApi(request,selected)??
          new Response('{"error":"not_found"}',{status:404,headers:{'Content-Type':'application/json'}}));
        res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
      }catch{if(!res.headersSent)res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"backend_unavailable"}');}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
    let closed=false;
    return {address:server.address(),async close(){if(closed)return;closed=true;clearInterval(interval);
      await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
      await tail;await Promise.allSettled([...background]);db.close();await lock.close();await unlink(lockPath);}};
  }catch(error){if(interval)clearInterval(interval);if(server?.listening)await new Promise(resolve=>server.close(resolve));
    db?.close();await lock.close();await unlink(lockPath);throw error;}
}
