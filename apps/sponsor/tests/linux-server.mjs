import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {startLinuxCheckout,sqliteStorage} from '../linux-server.mjs';
import {CheckoutLedger,LEDGER_OBJECT_NAME} from '../src/checkout/durableStore.ts';
import {SOLANA_GENESIS} from '../../../packages/checkout/paid.ts';
import {addr} from '../src/checkout/rpcFixtures.ts';

const temp=await mkdtemp(join(tmpdir(),'sejire-linux-backend-'));
const dbPath=join(temp,'checkout.sqlite'),origin='https://synthetic.example';
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
try{
  await storageContract();
  await startupAlarms();
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
}finally{await backend?.close();globalThis.fetch=originalFetch;await rm(temp,{recursive:true,force:true});}
