import assert from 'node:assert/strict';
import {lstat,mkdtemp,open,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fork} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {startLinuxCheckout,sqliteStorage} from '../linux-server.mjs';
import {CheckoutLedger,LEDGER_OBJECT_NAME} from '../src/checkout/durableStore.ts';
import {SOLANA_GENESIS} from '../../../packages/checkout/paid.ts';
import {addr} from '../src/checkout/rpcFixtures.ts';
import {trustedIngress} from '../trusted-ingress.mjs';

const writerDb=process.argv[2]==='--writer-child'?process.argv[3]:null;
const temp=writerDb?null:await mkdtemp(join(tmpdir(),'sejire-linux-backend-'));
const dbPath=writerDb??join(temp,'checkout.sqlite'),origin='https://synthetic.example';
const originalFetch=globalThis.fetch;
let rpcCalls=0,backend;
globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(url.startsWith('http://127.0.0.1:'))return originalFetch(input,init);
  if(!['https://solana.api.pocket.network/','https://api.mainnet-beta.solana.com/'].includes(url))throw Error('unexpected_external_request');
  rpcCalls++;const body=JSON.parse(String(init?.body));let result;
  if(body.method==='getGenesisHash')result=SOLANA_GENESIS['mainnet-beta'];
  else if(body.method==='getAccountInfo')result={context:{slot:100},value:{owner:'11111111111111111111111111111111',executable:false}};
  else if(body.method==='getLatestBlockhash')result={context:{slot:100},value:{blockhash:addr(8),lastValidBlockHeight:1000}};
  else if(body.method==='getFeeForMessage')result={context:{slot:100},value:5000};
  else if(body.method==='getBalance')result={context:{slot:100},value:1000000000};
  else throw Error('unexpected_rpc_method');
  return Response.json({jsonrpc:'2.0',id:body.id,result});
};
const bindings={CHECKOUT_ALLOWED_ORIGINS:origin,CHECKOUT_PAID_NETWORK:'mainnet-beta',
  CHECKOUT_PAID_POLICY_VERSION:'synthetic-linux-v1',CHECKOUT_SERVICE_RECIPIENT:addr(2),CHECKOUT_FUND_RECIPIENT:addr(3),
  CHECKOUT_CONTRIBUTION_ENABLED:'true',MAX_ENVELOPE_BYTES:'524288'};
const children=new Set();
function writerProcess(path){
  const child=fork(fileURLToPath(import.meta.url),['--writer-child',path],{silent:true});
  children.add(child);
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>{children.delete(child);resolve({code,signal});}));
  child.exited=exited;
  let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4096);});
  const first=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('writer_child_timeout: '+stderr));},10_000);
    child.once('message',message=>{clearTimeout(timer);resolve(message);});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    void exited.then(result=>{clearTimeout(timer);reject(Error('writer_child_exited_before_message: '+JSON.stringify(result)+' '+stderr));});
  });
  return {child,first,exited};
}
async function writerRecovery({token,key,payload,orderId}){
  const holder=writerProcess(dbPath),started=await holder.first;
  assert.equal(started.event,'ready');
  const alias=join(temp,'ledger-alias.sqlite'),parentAlias=join(temp,'directory-alias');
  await symlink(dbPath,alias);await symlink(temp,parentAlias,'dir');
  for(const path of [dbPath,alias,join(parentAlias,'checkout.sqlite')]){
    const competitor=writerProcess(path),result=await competitor.first;
    assert.deepEqual(result,{event:'rejected',error:'backend_writer_already_active'});
    assert.equal((await competitor.exited).code,0);
  }
  // The previous runtime uses this exact acquisition primitive. A permanent
  // directory must exclude it even when no new writer currently holds SQLite.
  await assert.rejects(()=>open(dbPath+'.writer.lock','wx'),{code:'EEXIST'});
  holder.child.kill('SIGKILL');
  assert.equal((await holder.exited).signal,'SIGKILL');
  assert((await lstat(dbPath+'.writer.lock')).isDirectory());
  const resumed=writerProcess(dbPath),ready=await resumed.first;
  assert.equal(ready.event,'ready','kernel releases the writer guard after SIGKILL');
  const base=`http://127.0.0.1:${ready.port}/api/checkout`;
  const headers={Origin:origin,Authorization:`Bearer ${token}`};
  const restored=await originalFetch(`${base}/orders/by-key/${key}`,{headers});
  assert.equal(restored.status,200);assert.equal((await restored.json()).record.order.id,orderId);
  const retry=await originalFetch(`${base}/orders`,{method:'POST',headers:{...headers,
    'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(payload)});
  assert.equal(retry.status,200);assert.equal((await retry.json()).record.order.id,orderId);
  const closed=new Promise(resolve=>resumed.child.once('message',resolve));
  resumed.child.send('close');
  assert.deepEqual(await closed,{event:'closed',rpcCalls:0},'resume keeps its original preparation without new RPC');
  assert.equal((await resumed.exited).code,0);
  await assert.rejects(()=>open(dbPath+'.writer.lock','wx'),{code:'EEXIST'});
  console.log('PASS Linux writer processes: live competitor and symlink aliases rejected; SIGKILL releases guard; same order/key/token recovered without RPC; legacy wx remains excluded');
}
async function legacyWriterAndFailedStart(){
  const legacy=join(temp,'legacy.sqlite'),sentinel=legacy+'.writer.lock';
  await writeFile(sentinel,'synthetic old writer sentinel');
  await assert.rejects(()=>startLinuxCheckout({dbPath:legacy,bindings}),/backend_writer_already_active/);
  assert.equal(await readFile(sentinel,'utf8'),'synthetic old writer sentinel','legacy sentinel is never removed or rewritten');
  const occupant=await startLinuxCheckout({dbPath:join(temp,'port-holder.sqlite'),bindings});
  try{
    const failed=join(temp,'failed-listen.sqlite');
    await assert.rejects(()=>startLinuxCheckout({dbPath:failed,bindings,port:occupant.address.port}),{code:'EADDRINUSE'});
    const recovered=await startLinuxCheckout({dbPath:failed,bindings});
    const first=recovered.close(),second=recovered.close();
    assert.equal(first,second,'concurrent close callers await the same completed shutdown');
    await first;
  }finally{await occupant.close();}
  console.log('PASS Linux writer migration/lifecycle: legacy sentinel unchanged; failed listen releases guard; concurrent close awaits shared shutdown');
}
async function restoreGateAndIngress(){
  const path=join(temp,'restored.sqlite'),marker=path+'.restore-review.json';
  await writeFile(marker,'{"synthetic":"awaiting operator review"}');
  await assert.rejects(()=>startLinuxCheckout({dbPath:path,bindings}),/linux_restore_review_required/);
  assert.equal(await readFile(marker,'utf8'),'{"synthetic":"awaiting operator review"}');
  await assert.rejects(()=>lstat(path+'.writer.lock'),{code:'ENOENT'},'restore gate runs before acquiring writer or opening ledger');
  const untrusted=trustedIngress();assert.equal(untrusted('127.0.0.1','198.51.100.7'),'127.0.0.1');
  const trusted=trustedIngress('127.0.0.1/32,10.0.0.0/8,2001:db8:1234::/48');
  assert.equal(trusted('::ffff:127.0.0.1','198.51.100.7, 10.1.2.3'),'198.51.100.7');
  assert.equal(trusted('127.0.0.1','192.0.2.99, 198.51.100.7'),'198.51.100.7','a client-supplied earlier hop cannot bypass the nearest untrusted peer');
  assert.equal(trusted('198.51.100.7','192.0.2.99'),'198.51.100.7','an untrusted socket cannot claim forwarded identity');
  assert.equal(trusted('2001:db8:1234::1','2001:db8:55::1, 2001:db8:1234::2'),'2001:db8:55::1');
  for(const value of ['unknown','198.51.100.7:80','198.51.100.7,','[2001:db8::1]','a'.repeat(4097)])assert.equal(trusted('127.0.0.1',value),'127.0.0.1');
  for(const value of ['*','0.0.0.0/0','127.0.0.1','127.0.0.1/33','::/129','10.0.0.0/8,bad'])assert.throws(()=>trustedIngress(value),/invalid_trusted_proxy_cidrs/);
  const file=join(temp,'ingress.sqlite'),server=await startLinuxCheckout({dbPath:file,bindings:{...bindings,SEJIRE_TRUSTED_PROXY_CIDRS:'127.0.0.1/32'}});
  try{
    const base=`http://127.0.0.1:${server.address.port}`;
    const response=await originalFetch(base+'/api/checkout/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Forwarded-For':'192.0.2.99, 198.51.100.7','CF-Connecting-IP':'203.0.113.5'},body:'{}'});
    assert.equal(response.status,201);
    const db=new DatabaseSync(file,{readOnly:true});try{
      const expected=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('198.51.100.7'))),x=>x.toString(16).padStart(2,'0')).join('');
      const names=db.prepare('SELECT bucket FROM api_rates').all().map(row=>row.bucket);assert(names.includes('sessions:'+expected));
    }finally{db.close();}
  }finally{await server.close();}
  console.log('PASS Linux restore/ingress: restore review fails before writer; explicit CIDRs, right-to-left IPv4/IPv6 chain, spoofed/invalid headers and actual HTTP rate bucket');
}
async function storageContract(){
  const file=join(temp,'alarm-contract.sqlite');
  let db=new DatabaseSync(file),storage=sqliteStorage(db);
  try{
    assert.equal(await storage.getAlarm(),null,'an empty adapter has no alarm');
    const future=Date.now()+3_600_000;
    await storage.setAlarm(new Date(future));
    assert.equal(await storage.getAlarm(),future,'Date alarms use integer milliseconds');
    for(const at of [future,Date.now()-1_000]){
      await storage.setAlarm(at);await storage.sync();db.close();
      db=new DatabaseSync(file);storage=sqliteStorage(db);
      assert.equal(await storage.getAlarm(),at,'the alarm survives closing the SQLite connection');
      const initializations=[],id={equals(other){return other===id;}};
      new CheckoutLedger({id,storage,blockConcurrencyWhile(work){
        const pending=Promise.resolve().then(work);initializations.push(pending);return pending;
      },waitUntil(){throw Error('unexpected_background_work');}},
      {CHECKOUT_LEDGER:{idFromName(name){assert.equal(name,LEDGER_OBJECT_NAME);return id;}}});
      await Promise.all(initializations);
      assert.equal(await storage.getAlarm(),at,'the real ledger constructor preserves an existing future or due alarm');
      assert.equal(storage.alarmAt(),at,'the adapter scheduler observes the same durable timestamp');
    }
    await assert.rejects(()=>storage.setAlarm(new Date(NaN)),/invalid_alarm_time/);
    await storage.deleteAlarm();assert.equal(await storage.getAlarm(),null);
    db.close();db=new DatabaseSync(file);storage=sqliteStorage(db);
    assert.equal(await storage.getAlarm(),null,'alarm deletion survives reopening');
    console.log('PASS Linux storage: async alarm contract, Date input, replacement, durable reopen, cold constructor preserves future/due alarm');
  }finally{db.close();}
}
function storedAlarm(file){
  const db=new DatabaseSync(file,{readOnly:true});
  try{return db.prepare('SELECT at FROM sejire_alarm WHERE id=1').get()?.at??null;}finally{db.close();}
}
async function startupAlarms(){
  const file=join(temp,'alarm-startup.sqlite');
  for(const at of [Date.now()+3_600_000,Date.now()-1_000]){
    const db=new DatabaseSync(file);try{await sqliteStorage(db).setAlarm(at);}finally{db.close();}
    const server=await startLinuxCheckout({dbPath:file});
    try{assert.equal(storedAlarm(file),at>Date.now()?at:null,'startup preserves a future alarm and runs a due one');}
    finally{await server.close();}
  }
  console.log('PASS Linux startup: initialization awaited, future alarm preserved, due alarm processed');
}
if(writerDb){
  try{
    backend=await startLinuxCheckout({dbPath,bindings});
    process.on('message',message=>{if(message==='close')void backend.close().then(()=>{
      process.send({event:'closed',rpcCalls},()=>process.disconnect());
    });});
    process.send({event:'ready',port:backend.address.port});
  }catch(error){process.send({event:'rejected',error:error.message},()=>process.disconnect());}
}else try{
  await storageContract();
  await startupAlarms();
  await restoreGateAndIngress();
  backend=await startLinuxCheckout({dbPath,bindings});
  const base=`http://127.0.0.1:${backend.address.port}/api/checkout`;
  const call=async(path,{method='GET',token,key,body}={})=>{
    const response=await originalFetch(base+path,{method,headers:{Origin:origin,
      ...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{}) ,
      ...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  };
  assert.equal((await call('/policy')).body.ready,false,'paid preservation remains disabled by default');
  const recipients=await originalFetch(`http://127.0.0.1:${backend.address.port}/api/fund/admin/solana-recipients`,
    {headers:{Origin:origin}});
  assert.equal(recipients.status,401,'the same recipient admin route rejects unauthenticated callers');
  const offer=await call('/policy/contribution');assert.equal(offer.body.contributionReady,true);
  const session=await call('/session',{method:'POST',body:{}});assert.equal(session.status,201);
  const token=session.body.accessToken,key='synthetic_linux_key_01';
  const payload={kind:'contribution',payer:addr(7),contribution:'0.001',policyHash:offer.body.contributionPolicyHash};
  const [first,second]=await Promise.all([call('/orders',{method:'POST',token,key,body:payload}),
    call('/orders',{method:'POST',token,key,body:payload})]);
  assert.deepEqual([first.status,second.status].sort(),[200,201],
    `synthetic create errors: ${first.body.error??'none'}, ${second.body.error??'none'}`);
  assert.equal(first.body.record.order.id,second.body.record.order.id);
  assert.equal(first.body.record.order.fundContribution.amount,'1000000');
  assert.equal((await call(`/orders/by-key/${key}`,{token})).body.record.order.id,first.body.record.order.id);
  assert(rpcCalls>0);
  await assert.rejects(()=>startLinuxCheckout({dbPath,bindings}),/backend_writer_already_active/,
    'a second process cannot share the SQLite writer and treasury');
  await backend.close();backend=null;
  const before=rpcCalls;
  backend=await startLinuxCheckout({dbPath,bindings});
  const reopened=`http://127.0.0.1:${backend.address.port}/api/checkout`;
  const restored=await originalFetch(`${reopened}/orders/by-key/${key}`,{headers:{Origin:origin,Authorization:`Bearer ${token}`}});
  assert.equal(restored.status,200);assert.equal((await restored.json()).record.order.id,first.body.record.order.id);
  const retry=await originalFetch(`${reopened}/orders`,{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${token}`,
    'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(payload)});
  assert.equal(retry.status,200);assert.equal((await retry.json()).record.order.id,first.body.record.order.id);
  assert.equal(rpcCalls,before,'same admitted order returns without a new RPC preparation');
  console.log('PASS Linux backend: shared ledger contracts, one writer, same key/token after restart, one synthetic order');
  await backend.close();backend=null;
  await writerRecovery({token,key,payload,orderId:first.body.record.order.id});
  await legacyWriterAndFailedStart();
}finally{
  await backend?.close();
  const pending=[...children];for(const child of pending)child.kill('SIGKILL');
  await Promise.all(pending.map(child=>child.exited));
  globalThis.fetch=originalFetch;await rm(temp,{recursive:true,force:true});
}
