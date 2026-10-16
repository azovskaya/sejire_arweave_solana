import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { FundLedger } from '../src/fund/ledger.ts';
import { fundApi } from '../src/fund/api.ts';
import { MockFundedArweaveProvider } from '../src/fund/provider.ts';
const temp=await mkdtemp(resolve(tmpdir(),'sejire-fund-sqlite-'));
const admin='synthetic-admin-token-32-characters',origin='https://preview.example';
const archive=JSON.stringify({schema:'sejire/envelope/v1',vault_id:'a'.repeat(32),cipher:'aes-gcm-256',kdf:'hkdf-sha256',iv:'AAAAAAAAAAAAAAAA',ciphertext:'A'.repeat(32),protocol:'sejire/v0.3'});
const createStorage=file=>{const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON');return {sql:{exec(sql,...args){if(!args.length&&sql.includes(';')){db.exec(sql);return {toArray:()=>[]};}const stmt=db.prepare(sql);if(stmt.columns().length)return {toArray:()=>stmt.all(...args)};stmt.run(...args);return {toArray:()=>[]};}},transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}},async sync(){},close(){db.close();}};};
let storage=createStorage(resolve(temp,'ledger.sqlite')),ledger=new FundLedger(storage),mock=new MockFundedArweaveProvider();
const namespace={idFromName(){return 'single-ledger';},get(){return {async fetch(_url,init){try{const f=JSON.parse(init.body),now=Date.now();let result;
  switch(f.action){case 'fundSummary':result=ledger.summary(now);break;case 'fundSettings':result=ledger.settings();break;case 'fundOrder':result=ledger.order(f.orderId,true);break;
  case 'fundRate':result=await ledger.rate(f.bucket,f.limit,now);break;case 'fundPromo':result=await ledger.promo(f.hash,f.hint,now);break;
  case 'fundEnable':result=await ledger.enable(f.enabled,now);break;case 'fundLimit':result=await ledger.limit(f.value,now);break;
  case 'fundReserve':result=await ledger.reserve(f.input,now);break;case 'fundEvent':result=await ledger.event(f.input,now);break;
  case 'fundReconciled':result=await ledger.reconciled(now);break;default:throw Error('unknown_action');}
  return Response.json(result??null);
 }catch(e){return Response.json({error:e.message},{status:409});}}};}};
const env={FUND_API_ENABLED:'true',CHECKOUT_ALLOWED_ORIGINS:origin,CHECKOUT_LEDGER:namespace,PROMO_CODE_SECRET:'synthetic-only-test-secret-32-characters',ADMIN_TOKEN:admin,MAX_ENVELOPE_BYTES:'524288'};
const call=async(path,value,options={})=>{mock.failure=options.fault??'';mock.delay=options.delay??false;mock.price=options.price??'3000000000';mock.estimate=options.estimate??mock.price;mock.actual=options.actual??'3000000000';mock.balance=options.balance??'68000000000000';
 const response=await fundApi(new Request('https://api.example/api/fund'+path,{method:value===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',
   'CF-Connecting-IP':options.ip??'192.0.2.1',...(options.admin?{Authorization:`Bearer ${admin}`}:{})},...(value===undefined?{}:{body:JSON.stringify(value)})}),env,mock);
 return {status:response.status,body:await response.json()};};
const dash=()=>call('/admin/dashboard',undefined,{admin:true}),change=code=>call('/admin/promo',{code,confirm:code},{admin:true}),make=(id,code='TEST-PENSIONER')=>({orderId:id.repeat(32),preservationId:id.repeat(32),code,archive});
const test=async(name,fn)=>{await fn();console.log('PASS fund:',name);};
try{
 await test('initial limit 13 AR; disabled; server admin auth',async()=>{assert.equal((await dash()).body.limitWinston,'13000000000000');assert.equal((await call('/admin/dashboard')).status,401);assert.equal((await call('/validate',{code:'TEST-PENSIONER'})).body.error,'promo_disabled');});
 await test('public balance needs no admin credential but cannot change settings',async()=>{const value=await call('/balance');assert.equal(value.body.walletBalanceWinston,'68000000000000');assert.equal((await call('/admin/limit',{limitAr:'26'})).status,401);});
 await test('every admin operation rejects missing and invalid credentials server-side',async()=>{
  const routes=[['/admin/dashboard',undefined],['/admin/promo',{code:'UNAUTHORIZED-CODE',confirm:'UNAUTHORIZED-CODE'}],
    ['/admin/enabled',{enabled:false}],['/admin/enabled',{enabled:true}],['/admin/limit',{limitAr:'26'}],['/admin/reconcile',{}]];
  const before=ledger.summary();
  for(const [path,payload] of routes){
    assert.equal((await call(path,payload,{ip:'192.0.2.110'})).status,401,path);
    const response=await fundApi(new Request('https://api.example/api/fund'+path,{method:payload===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json','Authorization':'Bearer incorrect-admin-credential','CF-Connecting-IP':'192.0.2.111'},...(payload===undefined?{}:{body:JSON.stringify(payload)})}),env,mock);
    assert.equal(response.status,401,path);
  }
  const after=ledger.summary();assert.deepEqual(after.promo,before.promo);assert.equal(after.limitWinston,before.limitWinston);
  assert.equal(after.lastReconciliation,before.lastReconciliation);
 });
 await test('promo normalization, change, old invalid, disable and enable',async()=>{assert.equal((await change('test-pensioner')).body.promo.revision,1);assert.equal((await call('/validate',{code:'  TEST-pensioner  '})).status,200);
  assert.equal((await call('/validate',{code:'WRONG-PENSIONER'})).body.error,'promo_invalid');assert.equal((await change('TEST-PENSIONER-2')).body.promo.revision,2);
  assert.equal((await call('/validate',{code:'TEST-PENSIONER'})).body.error,'promo_invalid');assert.equal((await call('/validate',{code:'TEST-PENSIONER-2'})).status,200);
  await call('/admin/enabled',{enabled:false},{admin:true});assert.equal((await call('/validate',{code:'TEST-PENSIONER-2'})).body.error,'promo_disabled');await call('/admin/enabled',{enabled:true},{admin:true});});
 await test('success uses confirmed transaction reward and no plaintext promo',async()=>{const r=await call('/orders',make('a','TEST-PENSIONER-2'),{estimate:'2800000000'});assert.equal(r.status,200);assert.equal(r.body.order.estimatedRewardWinston,'2800000000');assert.equal(r.body.order.actualRewardWinston,'3000000000');assert.equal(r.body.order.status,'COMPLETED');
  const d=(await dash()).body;assert.equal(d.successfulTrees,1);assert.equal(d.actualSpentWinston,'3000000000');assert.equal(d.currentRevisionTrees,1);
  assert.equal(JSON.stringify(d).includes('TEST-PENSIONER-2'),false);assert.equal(JSON.stringify(r.body).includes('ciphertext'),false);});
 await test('duplicate POST and polling preserve same tx and accounting',async()=>{const prior=(await call('/orders',make('a','TEST-PENSIONER-2'))).body.order;
  const polled=(await call('/orders/'+'a'.repeat(32))).body.order;assert.equal(polled.arweaveTxId,prior.arweaveTxId);
  assert.equal((await dash()).body.actualSpentWinston,'3000000000');assert.equal((await call('/orders',{...make('a','TEST-PENSIONER-2'),archive:archive+' '})).body.error,'archive_not_canonical');});
 await test('13 to 26 limit is cumulative and lower than spent rejected',async()=>{assert.equal((await call('/admin/limit',{limitAr:'0'},{admin:true})).body.error,'limit_below_spent');
  const d=(await call('/admin/limit',{limitAr:'26.000000'},{admin:true})).body;assert.equal(d.limitWinston,'26000000000000');assert.equal(d.actualSpentWinston,'3000000000');assert.equal(d.successfulTrees,1);assert.equal(d.budgetRemainingWinston,'25997000000000');});
 await test('lost response retains signed ID and reservation; reconcile once',async()=>{const r=await call('/orders',make('b','TEST-PENSIONER-2'),{fault:'lost_response',price:'2900000000'});
  assert.equal(r.status,202);assert.equal(r.body.order.status,'NEEDS_RECONCILIATION');assert.equal(r.body.order.estimatedRewardWinston,'2900000000');
  assert.equal((await dash()).body.actualSpentWinston,'3000000000');assert.equal((await dash()).body.reservedWinston,'2900000000');
  const recovered=await call('/admin/reconcile',{}, {admin:true,actual:'2900000000'});assert.equal(recovered.status,200);
  const d=(await dash()).body;assert.equal(d.successfulTrees,2);assert.equal(d.actualSpentWinston,'5900000000');assert.equal(d.reservedWinston,'0');assert.equal(mock.submissions,2);});
 await test('wallet lower than budget stops reservation',async()=>{assert.equal((await call('/orders',make('c','TEST-PENSIONER-2'),{balance:'1'})).body.error,'wallet_low');});
 await test('recovery words and plaintext tree fields cannot enter Fund API',async()=>{
  assert.equal((await call('/orders',{...make('6','TEST-PENSIONER-2'),recoveryWords:'synthetic only'},{ip:'192.0.2.60'})).body.error,'forbidden_field');
  assert.equal((await call('/orders',{...make('7','TEST-PENSIONER-2'),plaintextTree:{name:'Synthetic'}},{ip:'192.0.2.61'})).body.error,'forbidden_field');
  assert.equal((await dash()).body.history.some(x=>x.orderId==='6'.repeat(32)||x.orderId==='7'.repeat(32)),false);
 });
 await test('parallel reservations cannot exceed cap and count active reserves',async()=>{await call('/admin/limit',{limitAr:'0.008'},{admin:true});mock.delay=true;
  const results=await Promise.all([call('/orders',make('d','TEST-PENSIONER-2'),{delay:true,ip:'192.0.2.20'}),call('/orders',make('e','TEST-PENSIONER-2'),{delay:true,ip:'192.0.2.21'})]);
  assert.equal(results.filter(x=>x.body.order).length,0);assert.equal(results.every(x=>x.body.error==='fund_exhausted'),true);
  await call('/admin/limit',{limitAr:'0.009'},{admin:true});const pending=await call('/orders',make('f','TEST-PENSIONER-2'),{delay:true,ip:'192.0.2.22'});assert.equal(pending.body.order.status,'VERIFYING');
  assert.equal((await dash()).body.reservedWinston,'3000000000');
  const blocked=await call('/orders',make('0','TEST-PENSIONER-2'),{delay:true,ip:'192.0.2.23'});assert.equal(blocked.body.error,'fund_exhausted');
  await call('/admin/limit',{limitAr:'0.0119'},{admin:true});
  const race=await Promise.all([call('/orders',make('1','TEST-PENSIONER-2'),{delay:true,ip:'192.0.2.31'}),call('/orders',make('2','TEST-PENSIONER-2'),{delay:true,ip:'192.0.2.32'})]);
  assert.equal(race.filter(x=>x.body.order?.status==='VERIFYING').length,1);assert.equal(race.filter(x=>x.body.error==='fund_exhausted').length,1);
  assert.equal((await dash()).body.budgetRemainingWinston,'0');});
 await test('rate limit and persistence after restart',async()=>{let limited=false;for(let i=0;i<15;i++){const r=await call('/validate',{code:'WRONG-CODE'},{ip:'192.0.2.72'});if(r.status===429){limited=true;break;}}assert.equal(limited,true);
  storage.close();storage=createStorage(resolve(temp,'ledger.sqlite'));ledger=new FundLedger(storage);const d=(await dash()).body;assert.equal(d.actualSpentWinston,'5900000000');assert.equal(d.promo.revision,2);assert.equal(d.pending,2);});
 await test('verification failure holds reservation, retry completes once; provider errors fail closed',async()=>{
  await call('/admin/limit',{limitAr:'26'},{admin:true});const before=(await dash()).body.actualSpentWinston;
  const failed=await call('/orders',make('3','TEST-PENSIONER-2'),{fault:'verification',ip:'192.0.2.43'});
  assert.equal(failed.body.order.status,'NEEDS_RECONCILIATION');assert.equal((await dash()).body.actualSpentWinston,before);
  const resolved=await call('/orders/'+'3'.repeat(32));assert.equal(resolved.body.order.status,'COMPLETED');
  assert.equal((await call('/orders/'+'3'.repeat(32))).body.order.arweaveTxId,resolved.body.order.arweaveTxId);
  assert.equal((await dash()).body.actualSpentWinston,(BigInt(before)+3000000000n).toString());
  assert.equal((await call('/orders',make('4','TEST-PENSIONER-2'),{fault:'balance',ip:'192.0.2.44'})).body.error,'balance_unavailable');
  assert.equal((await call('/orders',make('5','TEST-PENSIONER-2'),{fault:'price',ip:'192.0.2.45'})).body.error,'price_unavailable');
 });
 await test('reconcile resubmits stored signed transaction after upload was not accepted',async()=>{
  const before=(await dash()).body;
  const failed=await call('/orders',make('8','TEST-PENSIONER-2'),{fault:'upload',price:'3000000000',ip:'192.0.2.81'});
  assert.equal(failed.body.order.status,'NEEDS_RECONCILIATION');const id=failed.body.order.arweaveTxId;
  assert.equal((await dash()).body.actualSpentWinston,before.actualSpentWinston);
  const recovered=await call('/admin/reconcile',{}, {admin:true});assert.equal(recovered.status,200);
  const order=(await call('/orders/'+'8'.repeat(32))).body.order;assert.equal(order.arweaveTxId,id);assert.equal(order.status,'COMPLETED');
  const after=(await dash()).body;assert.equal(after.actualSpentWinston,ledger.summary().actualSpentWinston);
  assert.equal(after.successfulTrees,before.successfulTrees+3);
  assert.equal((await call('/admin/reconcile',{}, {admin:true})).body.actualSpentWinston,after.actualSpentWinston);
 });
 await test('audit records contain revision and limits, never promo plaintext',async()=>{
  const rows=storage.sql.exec('SELECT action,details FROM fund_audit').toArray();
  assert.equal(rows.some(x=>x.action==='PROMO_CHANGED'),true);assert.equal(rows.some(x=>x.action==='FUND_LIMIT_CHANGED'),true);
  assert.equal(rows.some(x=>x.action==='FUND_RECONCILED'),true);assert.equal(JSON.stringify(rows).includes('TEST-PENSIONER'),false);
 });
 console.log('fund.local: PASS; real SQLite, mock provider, zero network calls or AR transactions');
}finally{storage.close();await rm(temp,{recursive:true,force:true});}
