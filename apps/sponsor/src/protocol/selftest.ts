import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash,webcrypto } from 'node:crypto';
import { pilot } from '../../tests/protocol-pilot';
import { ProtocolExecutor,signingKey,type Export } from './executor';
import { DOMAIN,hash,genesisPayload,replay,initial,type Signed } from './journal';
import { protocolHttp } from './http';
import { createOrder } from '../../../../packages/checkout/order';
import { addr,sig,fixtureTransaction,fixtureChain } from '../checkout/rpcFixtures';
import { decodeTransaction } from '../checkout/rpcDecoder';
import { encryptJson } from '../../../web/src/lib/crypto/encrypt';
Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const payer=signingKey(new Uint8Array(32).fill(17)),cap=signingKey(new Uint8Array(32).fill(18));
const token=Buffer.from(new Uint8Array(32).fill(18)).toString('hex');
const temp=await mkdtemp(join(tmpdir(),'sejire-protocol-'));const file=join(temp,'signed-journal.json');
let last:Export|undefined,fail=false,failAfter=false;
const p=await pilot(async saved=>{if(fail)throw Error('before_commit');await writeFile(file,JSON.stringify(saved));last=saved;if(failAfter)throw Error('lost_commit_response');});
let passed=0;const test=async(name:string,fn:()=>Promise<unknown>|unknown)=>{await fn();passed++;console.log('PASS protocol: '+name);};
const message=(action:Signed['message']['action'],body:Record<string,unknown>,signer=payer)=>p.engine.signed(action,body,signer);
const plaintext={schema:'sejire/vault/v1',vault_id:'a'.repeat(32),trees:{a:{persons:{p:{name:'Synthetic parent'},c:{name:'Synthetic child',parents:['p']}},history:['first','correction']},b:{persons:{q:{name:'Synthetic other'}},history:['first']}},active_tree_id:'a'};
const serialized=JSON.stringify(await encryptJson(new Uint8Array(32).fill(19),'a'.repeat(32),plaintext));
const order=createOrder({id:'1'.repeat(32),kind:'preservation',network:'devnet',asset:'SOL',payer:payer.publicKey,reference:addr(4),createdAt:1000000,expiresAt:1100000,policyVersion:p.genesis.policy.version,servicePayment:{amount:'30000000',recipient:addr(2)},fundContribution:{amount:'5000000',recipient:addr(3)},archive:{digest:createHash('sha256').update(serialized).digest('hex'),bytes:Buffer.byteLength(serialized)}});
const create=message('Order',{order,accessHash:hash(cap.publicKey)});
try{
 await test('authenticated creation, no first caller bootstrap',()=>{
  assert.throws(()=>initial({...p.genesis,creation:[]},p.engine.journal.creationHash));
  assert.throws(()=>initial({...p.genesis,policy:{...p.genesis.policy,managers:[payer.publicKey]}},p.engine.journal.creationHash));
 });
 await test('payer signature authorizes exact order and ephemeral capability',async()=>{await p.engine.submit(create);assert.deepEqual(p.engine.snapshot(order.id).record.order,order);});
 await test('tampering price, From JSON, signature and replay domain rejected',async()=>{
  for(const patch of [{domain:'other'},{processId:'other'},{epoch:1},{body:{order:{...order,servicePayment:{...order.servicePayment,amount:'1'}},accessHash:hash(cap.publicKey)}}])await assert.rejects(p.engine.submit({...create,message:{...create.message,...patch} as Signed['message']}));
  await assert.rejects(p.engine.submit({...create,signatures:[{publicKey:payer.publicKey,signature:sig(90)}]}));
 });
 await test('unauthorized capability cannot reserve or block foreign order',async()=>{await assert.rejects(p.engine.reserve(order.id,sig(6),'00'.repeat(32)));assert.equal(p.engine.journal.state.orders[order.id].pendingSignature,undefined);});
 await test('atomic failure before commit leaves no pending operation',async()=>{fail=true;await assert.rejects(p.engine.reserve(order.id,sig(5),token));fail=false;assert.equal(p.engine.journal.state.orders[order.id].pendingSignature,undefined);await p.engine.restore(last!,last!.checkpoint);});
 await test('unknown RPC keeps one pending signature, cannot replace it',async()=>{await p.engine.reserve(order.id,sig(5),token);p.control.missing=true;await p.engine.reconcile(order.id,token);await assert.rejects(p.engine.reserve(order.id,sig(6),token));assert.equal(p.engine.journal.state.orders[order.id].pendingSignature,sig(5));p.control.missing=false;});
 await test('replacement observer continues pending operation without first observer key',async()=>{
  const saved=p.engine.export();const other=new ProtocolExecutor(p.genesis,p.engine.journal.creationHash,p.managers,async()=>{},p.reader,p.uploader,p.observers[1],p.executors[1]);
  await other.restore(saved,saved.checkpoint);await other.reconcile(order.id,token);assert.equal(other.journal.state.orders[order.id].payment?.signature,sig(5));
 });
 await test('parallel verified attestations produce one service and fund credit',async()=>{await Promise.all(Array.from({length:16},()=>p.engine.reconcile(order.id,token)));assert.deepEqual(p.engine.journal.state.totals,{servicePayment:'30000000',fundContribution:'5000000'});});
 await test('public JSON From is not observer authority',async()=>{const evidence=decodeTransaction(fixtureTransaction(order,sig(5)),sig(5),fixtureChain);await assert.rejects(p.engine.submit(message('Payment',{orderId:order.id,orderHash:hash(order),evidence,From:p.observers[0].publicKey},payer)));});
 await test('no SQLite: saved signed journal replays identical state without RPC',async()=>{
  const saved=JSON.parse(await readFile(file,'utf8')) as Export;
  const fresh=new ProtocolExecutor(p.genesis,p.engine.journal.creationHash,p.managers.slice(0,2),async()=>{}, {chain:p.reader.chain,read:async()=>{throw Error('RPC must not run during replay');}},p.uploader,p.observers[1],p.executors[1]);
  await fresh.restore(saved,saved.checkpoint);assert.deepEqual(fresh.journal.state,p.engine.journal.state);
 });
 await test('missing middle, missing tail and modified evidence fail pinned checkpoint',async()=>{
  for(const entries of [last!.entries.slice(1),last!.entries.slice(0,-1),last!.entries.map((e,i)=>i===0?{...e,hash:'0'.repeat(64)}:e)])await assert.rejects(replay(p.genesis,p.engine.journal.creationHash,entries,last!.checkpoint));
 });
 await test('first uploader stops after signed plan; different executor reuses bytes/id without original key',async()=>{
  p.control.stopBeforeUpload=true;await assert.rejects(p.engine.execute(order.id,serialized,token));const plan=p.engine.journal.state.orders[order.id].plan!;assert(plan?.rawBase64);assert.equal(p.control.posts,0);
  const saved=p.engine.export();const second=new ProtocolExecutor(p.genesis,p.engine.journal.creationHash,p.managers.slice(0,2),async()=>{},p.reader,{...p.uploader,ready:bytes=>p.uploader.ready(bytes),sign:async()=>{throw Error('first uploader private key is NOT available');},upload:plan=>p.uploader.upload(plan),retrieve:(id,d)=>p.uploader.retrieve(id,d)},p.observers[1],p.executors[1]);
  await second.restore(saved,saved.checkpoint);p.control.stopBeforeUpload=false;await second.execute(order.id,serialized,token);assert.equal(second.journal.state.orders[order.id].plan!.id,plan.id);assert.equal(p.control.posts,1);assert.equal(p.control.items.size,1);assert.equal(second.snapshot(order.id).execution?.retrieved,true);
  await second.execute(order.id,serialized,token);assert.equal(p.control.posts,1);
 });
 await test('conflicting signed attestation is retained, never last-wins or credited twice',async()=>{
  const evidence=decodeTransaction(fixtureTransaction(order,sig(5)),sig(5),fixtureChain);const changed={...evidence,feeLamports:'5001'};
  await p.engine.submit(message('Payment',{orderId:order.id,orderHash:hash(order),evidence:changed},p.observers[1]));assert.equal(p.engine.journal.state.orders[order.id].conflicts.length,1);assert.deepEqual(p.engine.journal.state.totals,{servicePayment:'30000000',fundContribution:'5000000'});assert.throws(()=>p.engine.execute(order.id,serialized,token));
 });
 await test('management threshold, explicit new-key acceptance, no Eval or Owner path',async()=>{
  const next={...p.genesis.policy,epoch:1,version:'next',managers:p.managers.slice(1).map(s=>s.publicKey),threshold:2};
  const m:Signed['message']={domain:DOMAIN,processId:p.genesis.processId,epoch:0,policyVersion:p.genesis.policy.version,action:'Policy' as const,body:{policy:next}};
  
  // Acceptance signs the policy proposal WITHOUT embedding its own signature.
  const acceptance=p.managers.slice(1).map(s=>s.sign(m));
  const full={...m,body:{...m.body,acceptance}};
  await assert.rejects(p.engine.submit({message:full,signatures:[p.managers[0].sign(full)]}));
  await p.engine.submit({message:full,signatures:p.managers.slice(0,2).map(s=>s.sign(full))});
  assert.equal(p.engine.journal.state.policy.epoch,1);
  await p.engine.restore(p.engine.export(),p.engine.journal.checkpoint());
  await assert.rejects(p.engine.submit(create));
  for(const action of ['Eval','Owner','SetAuthorities'])await assert.rejects(p.engine.submit({message:{...m,action:action as 'Policy'},signatures:p.managers.slice(0,2).map(s=>s.sign({...m,action}))}));
 });
 await test('large lamports and summed ledger stay exact above u64 without floating point',async()=>{
  const big=await pilot();const max='18446744073709551615';
  for(let i=0;i<2;i++){
   const o=createOrder({id:String(i+3).repeat(32),kind:'contribution',network:'devnet',asset:'SOL',payer:payer.publicKey,reference:addr(40+i),createdAt:1000000,expiresAt:1100000,policyVersion:big.genesis.policy.version,servicePayment:{amount:'0',recipient:addr(2)},fundContribution:{amount:max,recipient:addr(3)}});
   await big.engine.submit(big.engine.signed('Order',{order:o,accessHash:hash(cap.publicKey)},payer));
   await big.engine.reserve(o.id,sig(40+i),token);await big.engine.reconcile(o.id,token);
  }
  assert.equal(big.engine.journal.state.totals.fundContribution,'36893488147419103230');
 });
 await test('lost commit response freezes writes until durable history is reconciled, no second credit',async()=>{
  failAfter=true;await assert.rejects(p.engine.reserve(order.id,sig(5),token));failAfter=false;
  await assert.rejects(p.engine.reserve(order.id,sig(5),token),/journal_publication_requires_reconciliation/);
  const committed=JSON.parse(await readFile(file,'utf8')) as Export;await p.engine.restore(committed,committed.checkpoint);
  assert.equal(p.engine.journal.state.totals.servicePayment,'30000000');assert.equal(p.engine.journal.state.orders[order.id].pendingSignature,sig(5));
 });
 await test('HTTP adapter cannot expose commit, fault or unsigned payment proof',async()=>{
  const handler=protocolHttp(p.engine,'https://local.example',true);
  for(const route of ['/commitPayment','/fault','/admin'])assert.equal((await handler(new Request('https://local.example/api/checkout'+route,{headers:{Authorization:'Bearer '+token}}))).status,404);
  assert.notEqual((await handler(new Request('https://local.example/api/checkout/orders/'+order.id+'/verify',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({paid:true})}))).status,200);
 });
 console.log(`protocol.selftest: ${passed} scenarios PASS; local signed scheduler + synthetic RPC/upload, no Cloudflare/SQLite; NOT live AO/Arweave`);
}finally{await rm(temp,{recursive:true,force:true});}
