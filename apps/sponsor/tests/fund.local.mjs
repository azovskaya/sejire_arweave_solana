import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { FundLedger } from '../src/fund/ledger.ts';
import { fundApi } from '../src/fund/api.ts';
import { DirectArweaveFundProvider, MockFundedArweaveProvider } from '../src/fund/provider.ts';
import { publicTreasuryOwner } from './fund-public-owner.mjs';
import { validateMetadata } from '../../web/src/lib/recovery/retrieve.ts';
import { assertFundOrderParent } from '../../web/src/lib/fund/client.ts';
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
 await test('success uses confirmed transaction reward and words-recoverable metadata, with no plaintext promo',async()=>{
  const prepare=mock.prepareTransaction;let preparedTags;
  mock.prepareTransaction=async function(bytes,tags){preparedTags=structuredClone(tags);return prepare.call(this,bytes,tags);};
  let r;try{r=await call('/orders',{...make('a','TEST-PENSIONER-2'),parentTxId:null},{estimate:'2800000000'});}finally{mock.prepareTransaction=prepare;}
  assert.equal(r.status,200);assert.equal(r.body.order.estimatedRewardWinston,'2800000000');assert.equal(r.body.order.actualRewardWinston,'3000000000');assert.equal(r.body.order.status,'COMPLETED');
  assert.equal(Object.hasOwn(r.body.order,'parentTxId'),true);assert.equal(r.body.order.parentTxId,null);
  assert.equal(preparedTags.some(tag=>tag.name==='Parent-Tx'),false,'genesis emits no invented parent');
  assert.equal(preparedTags.filter(tag=>tag.name==='Protocol-Version').length,1);
  assert.equal(preparedTags.find(tag=>tag.name==='Protocol-Version').value,JSON.parse(archive).protocol);
  assert.doesNotThrow(()=>validateMetadata({id:r.body.order.arweaveTxId,tags:preparedTags,blockHeight:1,blockTimestamp:1},
    {txId:r.body.order.arweaveTxId,source:'fund-contract',archiveBytes:new TextEncoder().encode(archive).length,archiveSha256:r.body.order.archiveDigest},JSON.parse(archive).vault_id));
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
 await test('prepare failure returns safe code before reservation',async()=>{
  const before=ledger.summary();const original=mock.prepareTransaction;
  mock.prepareTransaction=async()=>{throw Error('synthetic private key detail');};
  try{const result=await call('/orders',make('9','TEST-PENSIONER-2'),{ip:'192.0.2.99'});
    assert.equal(result.status,503);assert.deepEqual(result.body,{error:'fund_prepare_failed'});
    assert.equal(ledger.order('9'.repeat(32),true),null);
    assert.equal(ledger.summary().reservedWinston,before.reservedWinston);
  }finally{mock.prepareTransaction=original;}
 });
 await test('GET never signs, reserves or resubmits a missing signed transaction; explicit POST recovers the same order',async()=>{
  const before=ledger.summary();
  const initial=await call('/orders',make('c','TEST-PENSIONER-2'),{fault:'upload',ip:'192.0.2.101'});
  assert.equal(initial.body.order.status,'NEEDS_RECONCILIATION');
  const id=initial.body.order.arweaveTxId,submitted=mock.submissions,signed=mock.signings;
  for(let check=0;check<3;check++){
    const current=await call('/orders/'+'c'.repeat(32),undefined,{ip:'192.0.2.102'});
    assert.equal(current.body.order.arweaveTxId,id);assert.equal(current.body.order.orderId,'c'.repeat(32));
    assert.equal(current.body.verification.stage,'awaiting_confirmation');assert.equal(current.body.verification.reason,'network_pending');
    assert.equal(current.body.verification.transactionConfirmed,false);
    assert.equal(mock.submissions,submitted);assert.equal(mock.signings,signed);
  }
  assert.equal(ledger.summary().history.length,before.history.length+1);
  assert.equal(ledger.summary().actualSpentWinston,before.actualSpentWinston);
  assert.equal(ledger.summary().reservedWinston,(BigInt(before.reservedWinston)+3000000000n).toString());
  const completed=await call('/orders',make('c','TEST-PENSIONER-2'),{ip:'192.0.2.103'});
  assert.equal(completed.body.order.status,'COMPLETED');assert.equal(completed.body.order.arweaveTxId,id);
  assert.equal(completed.body.verification.stage,'verified');assert.equal(mock.submissions,submitted+1);assert.equal(mock.signings,signed);
  const cached=await call('/orders/'+'c'.repeat(32));
  assert.equal(cached.body.verification.stage,'verified');assert.equal(cached.body.verification.confirmations,null);
  assert.equal(ledger.summary().actualSpentWinston,(BigInt(before.actualSpentWinston)+3000000000n).toString());
  assert.equal(ledger.summary().reservedWinston,before.reservedWinston);
 });
 await test('confirmed network with unavailable archive remains reserved, then the same order completes exactly once',async()=>{
  const before=ledger.summary(),original=mock.getTransaction;let lookups=0;
  mock.getTransaction=async(...args)=>{lookups++;return original.apply(mock,args);};
  try{
    const initial=await call('/orders',make('d','TEST-PENSIONER-2'),{fault:'archive_unavailable',ip:'192.0.2.104'});
    assert.equal(initial.body.order.status,'VERIFYING');assert.equal(initial.body.verification.stage,'checking_archive');
    assert.equal(initial.body.verification.transactionConfirmed,true);assert.equal(initial.body.verification.confirmations,1);
    assert.equal(initial.body.verification.reason,'archive_unavailable');assert.equal(lookups,1,'one network lookup per check');
    const id=initial.body.order.arweaveTxId,submitted=mock.submissions,signed=mock.signings;
    assert.equal(ledger.summary().actualSpentWinston,before.actualSpentWinston);
    assert.equal(ledger.summary().reservedWinston,(BigInt(before.reservedWinston)+3000000000n).toString());
    const pending=await call('/orders/'+'d'.repeat(32),undefined,{fault:'archive_unavailable'});
    assert.equal(pending.body.verification.transactionConfirmed,true);assert.equal(lookups,2);
    const completed=await call('/orders/'+'d'.repeat(32));
    assert.equal(completed.body.order.status,'COMPLETED');assert.equal(completed.body.order.arweaveTxId,id);
    assert.equal(completed.body.verification.stage,'verified');assert.equal(lookups,3);
    for(let i=0;i<2;i++)assert.equal((await call('/orders/'+'d'.repeat(32))).body.order.status,'COMPLETED');
    assert.equal(lookups,3,'completed ledger entries do not re-query the network');
    assert.equal(mock.submissions,submitted);assert.equal(mock.signings,signed);
    assert.equal(ledger.summary().actualSpentWinston,(BigInt(before.actualSpentWinston)+3000000000n).toString());
    assert.equal(ledger.summary().reservedWinston,before.reservedWinston);
    assert.equal(storage.sql.exec('SELECT COUNT(*) AS n FROM fund_events WHERE order_id=? AND status=?','d'.repeat(32),'COMPLETED').toArray()[0].n,1);
  }finally{mock.getTransaction=original;}
 });
 await test('public attention reasons remain safe and cannot release or complete an unverified archive',async()=>{
  const before=ledger.summary();
  const initial=await call('/orders',make('e','TEST-PENSIONER-2'),{fault:'verification',ip:'192.0.2.105'});
  const id=initial.body.order.arweaveTxId,submitted=mock.submissions,signed=mock.signings;
  assert.equal(initial.body.verification.stage,'attention');assert.equal(initial.body.verification.transactionConfirmed,true);
  assert.equal(initial.body.verification.reason,'archive_verification_failed');
  const network=await call('/orders/'+'e'.repeat(32),undefined,{fault:'network'});
  assert.equal(network.body.verification.reason,'network_unavailable');assert.equal(network.body.verification.transactionConfirmed,false);
  assert.equal(JSON.stringify(network.body).includes('synthetic gateway failure'),false);
  const mismatch=await call('/orders/'+'e'.repeat(32),undefined,{actual:'1'});
  assert.equal(mismatch.body.verification.reason,'reward_mismatch');assert.equal(mismatch.body.verification.transactionConfirmed,true);
  assert.equal(mismatch.body.order.status,'NEEDS_RECONCILIATION');assert.equal(mismatch.body.order.arweaveTxId,id);
  assert.equal(ledger.summary().actualSpentWinston,before.actualSpentWinston);
  assert.equal(ledger.summary().reservedWinston,(BigInt(before.reservedWinston)+3000000000n).toString());
  for(const response of [initial,network,mismatch]){
    assert.deepEqual(Object.keys(response.body.verification).sort(),['checkedAt','confirmations','reason','stage','transactionConfirmed']);
    assert.equal(typeof response.body.verification.checkedAt,'number');
    for(const privateField of ['signedTransaction','preparedTransaction','ciphertext','code_hash'])assert.equal(JSON.stringify(response.body).includes(privateField),false);
  }
  assert.equal((await call('/orders/'+'e'.repeat(32))).body.order.status,'COMPLETED');
  assert.equal(mock.submissions,submitted);assert.equal(mock.signings,signed);
 });
 await test('existing order completes through direct-provider GET despite stale and split gateway evidence, with exactly-once spend',async()=>{
  const before=ledger.summary(),orderId='fedcba9876543210'.repeat(2);
  const initial=await call('/orders',{...make('f','TEST-PENSIONER-2'),orderId,preservationId:orderId},{fault:'network',ip:'192.0.2.106'});
  assert.equal(initial.body.order.status,'NEEDS_RECONCILIATION');
  const id=initial.body.order.arweaveTxId,submitted=mock.submissions,signed=mock.signings;
  assert.equal(ledger.summary().actualSpentWinston,before.actualSpentWinston);
  assert.equal(ledger.summary().reservedWinston,(BigInt(before.reservedWinston)+3000000000n).toString());
  const provider=new DirectArweaveFundProvider(JSON.stringify({kty:'RSA',n:publicTreasuryOwner,d:'synthetic-only-not-a-key'}));
  let writes=0;
  for(const method of ['prepareTransaction','sign','submit'])provider[method]=async()=>{writes++;throw Error('read_only_test');};
  const originalFetch=globalThis.fetch,requests=[];let inconsistentReward=true;
  const responseAt=(url,body,init)=>{const response=new Response(body,init);Object.defineProperty(response,'url',{value:url});return response;};
  globalThis.fetch=async(url,options)=>{
   const parsed=new URL(url);requests.push(parsed.href);
   assert.equal(options.method??'GET','GET');
   assert.ok(['https://arweave.net','https://g8way.io'].includes(parsed.origin));
   if(parsed.pathname===`/tx/${id}/status`)return parsed.origin==='https://arweave.net'
    ?responseAt(url,'',{status:202})
    :responseAt(url,JSON.stringify({number_of_confirmations:4}));
   if(parsed.pathname===`/tx/${id}`)return parsed.origin==='https://arweave.net'
    ?responseAt(url,JSON.stringify({id,owner:publicTreasuryOwner,reward:inconsistentReward?'1':'3000000000'}))
    :responseAt(url,'unavailable',{status:503});
   if(parsed.pathname===`/tx/${id}/data`)return parsed.origin==='https://arweave.net'
    ?responseAt(url,Buffer.from(archive).toString('base64url'))
    :responseAt(url,'<html>Site unavailable</html>');
   if(parsed.pathname===`/raw/${id}`||parsed.pathname===`/${id}`)return responseAt(url,new ReadableStream({
    start(controller){
     const cancel=()=>controller.error(Error('synthetic slow gateway'));
     if(options.signal.aborted)cancel();else options.signal.addEventListener('abort',cancel,{once:true});
    },
   }));
   throw Error('unexpected gateway request');
  };
  const read=()=>fundApi(new Request('https://api.example/api/fund/orders/'+orderId,{
   headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.107'},
  }),env,provider);
  try{
   const mismatch=await (await read()).json();
   assert.equal(mismatch.order.status,'NEEDS_RECONCILIATION');assert.equal(mismatch.verification.reason,'reward_mismatch');
   assert.equal(mismatch.order.arweaveTxId,id);assert.equal(mismatch.order.actualRewardWinston,null);
   assert.equal(ledger.summary().actualSpentWinston,before.actualSpentWinston);
   assert.equal(ledger.summary().reservedWinston,(BigInt(before.reservedWinston)+3000000000n).toString());
   assert.equal(writes,0);assert.equal(mock.submissions,submitted);assert.equal(mock.signings,signed);
   inconsistentReward=false;
   const response=await read(),completed=await response.json();
   assert.equal(response.status,200);assert.equal(completed.order.status,'COMPLETED');
   assert.equal(completed.order.orderId,orderId);assert.equal(completed.order.arweaveTxId,id);
   assert.equal(completed.verification.stage,'verified');assert.equal(completed.verification.transactionConfirmed,true);
   assert.ok(requests.includes(`https://arweave.net/tx/${id}/data`));
   const requestCount=requests.length;
   for(let i=0;i<2;i++)assert.equal((await (await read()).json()).order.status,'COMPLETED');
   assert.equal(requests.length,requestCount,'terminal reads do not re-query gateways');
   assert.equal(writes,0);assert.equal(mock.submissions,submitted);assert.equal(mock.signings,signed);
   const after=ledger.summary();
   assert.equal(after.history.length,before.history.length+1);assert.equal(after.successfulTrees,before.successfulTrees+1);
   assert.equal(after.actualSpentWinston,(BigInt(before.actualSpentWinston)+3000000000n).toString());
   assert.equal(after.reservedWinston,before.reservedWinston);assert.equal(after.pending,before.pending);
   assert.equal(storage.sql.exec('SELECT COUNT(*) AS n FROM fund_events WHERE order_id=? AND status=?',orderId,'COMPLETED').toArray()[0].n,1);
   for(const privateField of ['signedTransaction','preparedTransaction','ciphertext','code_hash'])assert.equal(JSON.stringify(completed).includes(privateField),false);
  }finally{globalThis.fetch=originalFetch;}
 });
 await test('new parent is signed, immutable on replay and ledger reserve, and survives GET completion and restart',async()=>{
  const parentTxId='P'.repeat(43),orderId='abc01234'.repeat(4);
  const payload={orderId,preservationId:orderId,code:'TEST-PENSIONER-2',archive,parentTxId};
  const before=ledger.summary(),prepare=mock.prepareTransaction;let preparations=0;
  mock.prepareTransaction=async function(...args){preparations++;return prepare.apply(this,args);};
  try{
   const initial=await call('/orders',payload,{delay:true,ip:'192.0.2.120'});
   assert.equal(initial.status,202);assert.equal(initial.body.order.status,'VERIFYING');assert.equal(initial.body.order.parentTxId,parentTxId);
   const saved=ledger.order(orderId,true),txId=saved.arweaveTxId,submissions=mock.submissions,signings=mock.signings;
   const tags=JSON.parse(saved.preparedTransaction).tags;
   assert.deepEqual(tags.filter(tag=>tag.name==='Parent-Tx'),[{name:'Parent-Tx',value:parentTxId}]);
   assert.deepEqual(JSON.parse(saved.signedTransaction).tags,tags,'signed bytes bind the prepared parent');
   assert.doesNotThrow(()=>validateMetadata({id:txId,tags,blockHeight:1,blockTimestamp:1},
    {txId,source:'fund-contract',archiveBytes:saved.archiveSizeBytes,archiveSha256:saved.archiveDigest},saved.vaultId));
   const replay=await call('/orders',payload,{delay:true,ip:'192.0.2.121'});
   assert.equal(replay.body.order.arweaveTxId,txId);assert.equal(replay.body.order.parentTxId,parentTxId);
   assert.equal(preparations,1);assert.equal(mock.submissions,submissions);assert.equal(mock.signings,signings);
   const eventCount=storage.sql.exec('SELECT COUNT(*) AS n FROM fund_events WHERE order_id=?',orderId).toArray()[0].n;
   for(const [index,conflicting] of [{...payload,parentTxId:'Q'.repeat(43)},{...payload,parentTxId:null},
    {orderId,preservationId:orderId,code:payload.code,archive}].entries()){
    const rejected=await call('/orders',conflicting,{delay:true,ip:`192.0.2.${122+index}`});
    assert.equal(rejected.status,400);assert.equal(rejected.body.error,'archive_changed');
   }
   const reserveInput={orderId,preservationId:orderId,hash:ledger.settings().code_hash,archiveSizeBytes:saved.archiveSizeBytes,
    archiveDigest:saved.archiveDigest,vaultId:saved.vaultId,reward:saved.reservedRewardWinston,
    estimated:saved.estimatedRewardWinston,prepared:saved.preparedTransaction,balance:'68000000000000',parentTxId};
   assert.equal((await ledger.reserve(reserveInput)).arweaveTxId,txId);
   await assert.rejects(()=>ledger.reserve({...reserveInput,parentTxId:'Q'.repeat(43)}),/archive_changed/);
   assert.equal(preparations,1);assert.equal(mock.submissions,submissions);assert.equal(mock.signings,signings);
   assert.equal(storage.sql.exec('SELECT COUNT(*) AS n FROM fund_events WHERE order_id=?',orderId).toArray()[0].n,eventCount);
   assert.equal(ledger.order(orderId,true).preparedTransaction,saved.preparedTransaction);
   assert.equal(ledger.order(orderId,true).signedTransaction,saved.signedTransaction);
   assert.equal(ledger.summary().reservedWinston,(BigInt(before.reservedWinston)+3000000000n).toString());
   for(let i=0;i<2;i++){
    const completed=await call('/orders/'+orderId);
    assert.equal(completed.body.order.status,'COMPLETED');assert.equal(completed.body.order.arweaveTxId,txId);
    assert.equal(completed.body.order.parentTxId,parentTxId);
   }
   assert.equal(mock.submissions,submissions);assert.equal(mock.signings,signings);
   assert.equal(ledger.summary().actualSpentWinston,(BigInt(before.actualSpentWinston)+3000000000n).toString());
   assert.equal(ledger.summary().reservedWinston,before.reservedWinston);
   assert.equal(storage.sql.exec('SELECT COUNT(*) AS n FROM fund_events WHERE order_id=? AND status=?',orderId,'COMPLETED').toArray()[0].n,1);
   storage.close();storage=createStorage(resolve(temp,'ledger.sqlite'));ledger=new FundLedger(storage);
   assert.equal(ledger.order(orderId).parentTxId,parentTxId);assert.equal(ledger.order(orderId,true).signedTransaction,saved.signedTransaction);
   assert.equal((await call('/orders/'+orderId)).body.order.parentTxId,parentTxId);
   assert.equal(ledger.summary().actualSpentWinston,(BigInt(before.actualSpentWinston)+3000000000n).toString());
  }finally{mock.prepareTransaction=prepare;}
 });
 await test('invalid parents are rejected before reservation or signing; explicit null and omitted genesis replay identically',async()=>{
  const before=ledger.summary(),submissions=mock.submissions,signings=mock.signings,prepare=mock.prepareTransaction;let preparations=0;
  mock.prepareTransaction=async function(...args){preparations++;return prepare.apply(this,args);};
  try{
   for(const [index,parentTxId] of ['', 'P'.repeat(42), 'P'.repeat(44), 'https://arweave.net/'+'P'.repeat(43), ' '.repeat(43), 7, false, {}, []].entries()){
    const orderId=(800+index).toString(16).padStart(32,'0');
    const rejected=await call('/orders',{orderId,preservationId:orderId,code:'TEST-PENSIONER-2',archive,parentTxId},{ip:`192.0.2.${130+index}`});
    assert.equal(rejected.status,400);assert.equal(rejected.body.error,'invalid_request');assert.equal(ledger.order(orderId),null);
   }
   const genesis=ledger.order('a'.repeat(32));
   for(const payload of [make('a','TEST-PENSIONER-2'),{...make('a','TEST-PENSIONER-2'),parentTxId:null}]){
    const replay=await call('/orders',payload,{ip:'192.0.2.140'});
    assert.equal(replay.body.order.arweaveTxId,genesis.arweaveTxId);assert.equal(replay.body.order.parentTxId,null);
   }
   assert.equal(preparations,0);assert.equal(mock.submissions,submissions);assert.equal(mock.signings,signings);
   assert.equal(ledger.summary().history.length,before.history.length);
   assert.equal(ledger.summary().reservedWinston,before.reservedWinston);assert.equal(ledger.summary().actualSpentWinston,before.actualSpentWinston);
  }finally{mock.prepareTransaction=prepare;}
 });
 await test('old-client omitted POST remains unbound across new-client GET resume with an existing local parent',async()=>{
  const orderId='abc01235'.repeat(4),localParent='R'.repeat(43),before=ledger.summary();
  const payload={orderId,preservationId:orderId,code:'TEST-PENSIONER-2',archive};
  const first=await call('/orders',payload,{delay:true,ip:'192.0.2.145'});
  assert.equal(first.body.order.status,'VERIFYING');assert.equal(Object.hasOwn(first.body.order,'parentTxId'),false);
  const saved=ledger.order(orderId,true),submissions=mock.submissions,signings=mock.signings;
  assert.equal(JSON.parse(saved.preparedTransaction).tags.some(tag=>tag.name==='Parent-Tx'),false);
  const resumed=await call('/orders/'+orderId);
  assert.equal(resumed.body.order.status,'COMPLETED');assert.equal(resumed.body.order.arweaveTxId,saved.arweaveTxId);
  assert.doesNotThrow(()=>assertFundOrderParent(resumed.body.order,localParent),'legacy local parent must not trap an accepted old-client request');
  assert.equal((await call('/orders',{...payload,parentTxId:localParent},{ip:'192.0.2.146'})).body.error,'archive_changed');
  assert.equal(storage.sql.exec('SELECT COUNT(*) AS n FROM fund_order_links WHERE order_id=?',orderId).toArray()[0].n,0);
  assert.equal(ledger.order(orderId,true).preparedTransaction,saved.preparedTransaction);
  assert.equal(ledger.order(orderId,true).signedTransaction,saved.signedTransaction);
  assert.equal(mock.submissions,submissions);assert.equal(mock.signings,signings);
  assert.equal(ledger.summary().actualSpentWinston,(BigInt(before.actualSpentWinston)+3000000000n).toString());
  assert.equal(ledger.summary().reservedWinston,before.reservedWinston);
 });
 await test('additive schema preserves historical prepared/signed bytes and GET settles the original parent-less order',async()=>{
  const originalLedger=ledger,legacy=createStorage(resolve(temp,'legacy.sqlite')),old=ledger.order('a'.repeat(32),true);
  const submissions=mock.submissions,signings=mock.signings;
  legacy.sql.exec(`CREATE TABLE fund_orders(order_id TEXT PRIMARY KEY,preservation_id TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,archive_bytes INTEGER NOT NULL,digest TEXT NOT NULL,vault_id TEXT NOT NULL,estimate TEXT NOT NULL,reserved TEXT NOT NULL,created_at INTEGER NOT NULL,prepared_json TEXT NOT NULL);
   CREATE TABLE fund_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,order_id TEXT NOT NULL,status TEXT NOT NULL,tx_id TEXT,actual TEXT,signed_json TEXT,at INTEGER NOT NULL);`);
  legacy.sql.exec('INSERT INTO fund_orders VALUES(?,?,?,?,?,?,?,?,?,?)',old.orderId,old.preservationId,old.promoRevision,old.archiveSizeBytes,old.archiveDigest,old.vaultId,old.estimatedRewardWinston,old.reservedRewardWinston,old.createdAt,old.preparedTransaction);
  legacy.sql.exec('INSERT INTO fund_events(order_id,status,tx_id,signed_json,at) VALUES(?,?,?,?,?)',old.orderId,'NEEDS_RECONCILIATION',old.arweaveTxId,old.signedTransaction,old.createdAt);
  try{
   ledger=new FundLedger(legacy);
   assert.equal(Object.hasOwn(ledger.order(old.orderId),'parentTxId'),false);
   assert.equal(legacy.sql.exec('PRAGMA table_info(fund_orders)').toArray().length,10,'old writer column count remains compatible');
   assert.equal(ledger.summary().reservedWinston,'3000000000');
   const current=await call('/orders/'+old.orderId);
   assert.equal(current.body.order.status,'COMPLETED');assert.equal(current.body.order.arweaveTxId,old.arweaveTxId);
   assert.equal(Object.hasOwn(current.body.order,'parentTxId'),false,'legacy response does not invent a signed binding');
   for(const payload of [make('a','TEST-PENSIONER-2'),{...make('a','TEST-PENSIONER-2'),parentTxId:null}]){
    assert.equal((await call('/orders',payload,{ip:'192.0.2.150'})).body.order.arweaveTxId,old.arweaveTxId);
   }
   const rejected=await call('/orders',{...make('a','TEST-PENSIONER-2'),parentTxId:'P'.repeat(43)},{ip:'192.0.2.151'});
   assert.equal(rejected.status,400);assert.equal(rejected.body.error,'archive_changed');
   assert.equal(ledger.order(old.orderId,true).preparedTransaction,old.preparedTransaction);
   assert.equal(ledger.order(old.orderId,true).signedTransaction,old.signedTransaction);
   assert.equal(legacy.sql.exec('SELECT COUNT(*) AS n FROM fund_order_links').toArray()[0].n,0,'never retrofit a link onto historical signed bytes');
   assert.equal(ledger.summary().actualSpentWinston,'3000000000');assert.equal(ledger.summary().reservedWinston,'0');
   assert.equal(legacy.sql.exec('SELECT COUNT(*) AS n FROM fund_events WHERE order_id=? AND status=?',old.orderId,'COMPLETED').toArray()[0].n,1);
   assert.equal(mock.submissions,submissions);assert.equal(mock.signings,signings);
  }finally{ledger=originalLedger;legacy.close();}
 });
 console.log('fund.local: PASS; real SQLite, mocked gateway/provider responses, zero network calls or AR transactions');
}finally{storage.close();await rm(temp,{recursive:true,force:true});}
