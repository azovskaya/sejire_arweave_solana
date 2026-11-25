// Focused Linux HTTP/SQLite acceptance. External fetches are intercepted below;
// only loopback HTTP may reach a socket. Keys are ephemeral and never printed.
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign,webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {startLinuxCheckout} from '../linux-server.mjs';
import {MockFundedArweaveProvider} from '../src/fund/provider.ts';

const here=dirname(fileURLToPath(import.meta.url));
const {Message}=createRequire(resolve(here,'../../web/package.json'))('@solana/web3.js');
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes){
  let n=0n;for(const byte of bytes)n=(n<<8n)+BigInt(byte);
  let result='';for(;n>0n;n/=58n)result=alphabet[Number(n%58n)]+result;
  const first=bytes.findIndex(byte=>byte!==0);
  return '1'.repeat(first<0?bytes.length:first)+result;
}
const addr=fill=>b58(Buffer.alloc(32,fill));
const sha=value=>createHash('sha256').update(value).digest('hex');
const origin='https://linux-lifecycle.example',admin='synthetic-linux-admin-token-32-chars';
const genesis='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const reward='3000000000',hold='4000000000';
const temp=await mkdtemp(join(tmpdir(),'sejire-linux-paid-promo-'));
const dbPath=join(temp,'ledger.sqlite');
const payerKey=generateKeyPairSync('ed25519');
const payer=b58(payerKey.publicKey.export({format:'der',type:'spki'}).subarray(-32));
const pair=await webcrypto.subtle.generateKey({name:'RSA-PSS',modulusLength:4096,
  publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const arKey=await webcrypto.subtle.exportKey('jwk',pair.privateKey);
const treasury=createHash('sha256').update(Buffer.from(arKey.n,'base64url')).digest('base64url');
const bindings={CHECKOUT_ALLOWED_ORIGINS:origin,CHECKOUT_PAID_ENABLED:'true',CHECKOUT_PAID_EXECUTION_ENABLED:'true',
  CHECKOUT_PAID_NETWORK:'mainnet-beta',CHECKOUT_PAID_POLICY_VERSION:'synthetic-linux-lifecycle-v1',
  CHECKOUT_SERVICE_RECIPIENT:addr(2),CHECKOUT_FUND_RECIPIENT:addr(3),CHECKOUT_PAID_TREASURY_ADDRESS:treasury,
  CHECKOUT_PAID_AR_BUDGET_ID:'synthetic-linux-paid',CHECKOUT_PAID_AR_BUDGET_WINSTON:'400000000000',
  CHECKOUT_PAID_MAX_REWARD_WINSTON:hold,MAX_ENVELOPE_BYTES:'524288',ARWEAVE_TREASURY_JWK:JSON.stringify(arKey),
  FUND_API_ENABLED:'true',ADMIN_TOKEN:admin,PROMO_CODE_SECRET:'synthetic-linux-promo-hmac-secret-at-least-32-chars'};

function readSql(sql,...args){const db=new DatabaseSync(dbPath,{readOnly:true});
  try{return db.prepare(sql).all(...args).map(row=>({...row}));}finally{db.close();}}
const paidRow=id=>readSql('SELECT status,paid,released,lease_until,last_error FROM paid_orders WHERE order_id=?',id)[0];
const payload=(id,kind)=>readSql('SELECT payload FROM paid_payloads WHERE order_id=? AND kind=?',id,kind)[0]?.payload;
const counts=()=>({orders:readSql('SELECT COUNT(*) AS n FROM orders')[0].n,
  paidOrders:readSql('SELECT COUNT(*) AS n FROM paid_orders')[0].n,
  paidHolds:readSql('SELECT COUNT(*) AS n FROM paid_holds')[0].n,
  credits:readSql('SELECT COUNT(*) AS n FROM credits')[0].n,
  fundOrders:readSql('SELECT COUNT(*) AS n FROM fund_orders')[0].n});

class ObservedFundProvider extends MockFundedArweaveProvider{
  async submit(raw){
    const stored=readSql('SELECT signed_json FROM fund_events WHERE status=? ORDER BY seq DESC','SIGNED');
    assert(stored.some(row=>row.signed_json===raw),'promo signed bytes must be durable before submit');
    return super.submit(raw);
  }
  async replayData(raw,expected,deadline){
    const stored=readSql('SELECT signed_json FROM fund_events WHERE status=? ORDER BY seq DESC','SIGNED');
    assert(stored.some(row=>row.signed_json===raw),'promo repair must use original durable signed bytes');
    if(this.slowMissingRead)assert(deadline-Date.now()>1000,'slow initial read must leave an actual replay budget');
    await super.replayData(raw,expected,deadline);this.slowMissingRead=false;
  }
  async getRawData(id,expected,deadline){
    if(this.slowMissingRead){await new Promise(resolve=>setTimeout(resolve,Math.max(0,deadline-Date.now())));return null;}
    return super.getRawData(id,expected,deadline);
  }
}
const fundProvider=new ObservedFundProvider();
const wire={calls:[],payments:new Map(),expectedPayments:new Map(),archives:new Map(),submissions:new Map(),
  paymentSends:0,headerPosts:0,chunkPosts:0,lostPaymentAck:true,lostHeaderAck:true};
const originalFetch=globalThis.fetch;
function reply(url,status,body){const response=new Response(body,{status});Object.defineProperty(response,'url',{value:url});return response;}
function rpc(request){
  let result;
  if(request.method==='getGenesisHash')result=genesis;
  else if(request.method==='getAccountInfo')result={context:{slot:100},value:{owner:'11111111111111111111111111111111',executable:false}};
  else if(request.method==='getLatestBlockhash')result={context:{slot:100},value:{blockhash:addr(8),lastValidBlockHeight:1000}};
  else if(request.method==='getFeeForMessage'){
    const message=Message.from(Buffer.from(request.params[0],'base64'));
    assert.equal(message.header.numRequiredSignatures,1);
    result={context:{slot:100},value:5000};
  }else if(request.method==='getBalance')result={context:{slot:100},value:1000000000};
  else if(request.method==='getBlockHeight')result=100;
  else if(request.method==='getSignaturesForAddress')result=request.params[0]==='Vote111111111111111111111111111111111111111'
    ?[{signature:addr(9),slot:100,err:null,blockTime:100,confirmationStatus:'finalized'}]
    :[...wire.payments.values()].filter(payment=>payment.order.reference===request.params[0]).map(payment=>({
      signature:payment.signature,slot:100,err:null,blockTime:payment.raw.blockTime,confirmationStatus:'finalized'}));
  else if(request.method==='getSignatureStatuses'){
    const payment=wire.payments.get(request.params[0][0]);
    result={context:{slot:200},value:[payment||request.params[0][0]===addr(9)?{
      slot:100,confirmations:null,err:null,confirmationStatus:'finalized'}:null]};
  }else if(request.method==='getTransaction')result=wire.payments.get(request.params[0])?.raw??
    (request.params[0]===addr(9)?{transaction:{signatures:[addr(9)],version:1}}:null);
  else if(request.method==='sendTransaction'){
    const payment=wire.expectedPayments.get(request.params[0]);assert(payment,'only the expected synthetic signed transaction may be relayed');
    assert.equal(payload(payment.order.id,'signed-payment'),request.params[0],'SOL signed bytes must be durable before relay');
    assert.equal(JSON.parse(readSql('SELECT order_json FROM orders WHERE id=?',payment.order.id)[0].order_json).id,payment.order.id);
    wire.paymentSends++;wire.payments.set(payment.signature,payment);result=payment.signature;
    if(wire.lostPaymentAck){wire.lostPaymentAck=false;return {status:503,body:'synthetic acknowledgement lost'};}
  }else throw Error(`unexpected_synthetic_rpc_method:${request.method}`);
  return {status:200,body:JSON.stringify({jsonrpc:'2.0',id:request.id,result})};
}
globalThis.fetch=async(input,init={})=>{
  const url=input instanceof Request?input.url:String(input),parsed=new URL(url);
  if(parsed.protocol==='http:'&&parsed.hostname==='127.0.0.1')return originalFetch(input,init);
  const method=init.method??(input instanceof Request?input.method:'GET');
  const body=init.body??(input instanceof Request?await input.text():undefined);
  wire.calls.push({host:parsed.host,path:parsed.pathname,method});
  if(['https://solana.api.pocket.network','https://api.mainnet-beta.solana.com'].includes(parsed.origin)&&method==='POST'){
    const response=rpc(JSON.parse(String(body)));return reply(url,response.status,response.body);
  }
  if(!['https://arweave.net','https://g8way.io'].includes(parsed.origin))throw Error('unexpected_external_request_blocked');
  const path=parsed.pathname;
  if(method==='GET'){
    if(path==='/info')return reply(url,200,JSON.stringify({network:'arweave.N.1'}));
    if(path==='/tx_anchor')return reply(url,200,Buffer.alloc(48,7).toString('base64url'));
    if(path===`/wallet/${treasury}/balance`)return reply(url,200,'68000000000000');
    if(/^\/price\/\d+$/.test(path))return reply(url,200,reward);
    const match=/^\/tx\/([A-Za-z0-9_-]{43})(?:\/(status|data))?$/.exec(path);
    if(match){
      const stored=wire.submissions.get(match[1]);if(!stored)return reply(url,404,'');
      if(match[2]==='status')return reply(url,200,JSON.stringify({number_of_confirmations:8}));
      if(match[2]==='data')return reply(url,stored.complete?200:404,stored.complete?Buffer.from(stored.serialized).toString('base64url'):'');
      return reply(url,200,JSON.stringify({...stored.raw,data:''}));
    }
    if(/^\/(raw\/)?[A-Za-z0-9_-]{43}$/.test(path))return reply(url,404,'');
  }
  if(parsed.origin==='https://arweave.net'&&method==='POST'&&path==='/tx'){
    const raw=JSON.parse(String(body)),tags=Object.fromEntries(raw.tags.map(tag=>[
      Buffer.from(tag.name,'base64url').toString(),Buffer.from(tag.value,'base64url').toString()]));
    const orderId=tags['Preservation-Id'],serialized=wire.archives.get(orderId);
    assert.equal(typeof serialized,'string');assert.equal(tags['Archive-SHA256'],sha(serialized));
    assert.equal(tags['Archive-Bytes'],String(Buffer.byteLength(serialized)));assert.equal(tags['Promo-Funded'],undefined);
    assert.equal(tags['Parent-Tx'],archiveInput.archive.parentTxId);assert.equal(raw.data,'');
    const saved=JSON.parse(payload(orderId,'signed'));
    assert.equal(saved.id,raw.id);assert.deepEqual(JSON.parse(saved.raw),{...raw,data:JSON.parse(saved.raw).data});
    assert.equal(paidRow(orderId).paid,1,'payment must be committed before AR submit');
    const prior=wire.submissions.get(raw.id);
    if(prior)assert.deepEqual(raw,prior.raw);
    else wire.submissions.set(raw.id,{raw,serialized,chunks:new Map(),complete:false});
    wire.headerPosts++;
    if(wire.lostHeaderAck){wire.lostHeaderAck=false;return reply(url,503,'synthetic acknowledgement lost');}
    return reply(url,200,'OK');
  }
  if(parsed.origin==='https://arweave.net'&&method==='POST'&&path==='/chunk'){
    const chunk=JSON.parse(String(body)),stored=[...wire.submissions.values()].find(item=>item.raw.data_root===chunk.data_root);
    assert(stored);const bytes=Buffer.from(chunk.chunk,'base64url'),end=Number(chunk.offset)+1;
    assert.deepEqual(bytes,Buffer.from(stored.serialized).subarray(end-bytes.length,end));
    assert.equal(chunk.data_size,String(Buffer.byteLength(stored.serialized)));
    wire.chunkPosts++;stored.chunks.set(chunk.offset,bytes.length);
    stored.complete=[...stored.chunks.values()].reduce((sum,size)=>sum+size,0)===Buffer.byteLength(stored.serialized);
    return reply(url,200,'OK');
  }
  throw Error('unexpected_external_request_blocked');
};

function archive(fill,size=32,parentTxId=null){
  const serialized=JSON.stringify({schema:'sejire/envelope/v1',vault_id:fill.repeat(32),cipher:'aes-gcm-256',
    kdf:'hkdf-sha256',iv:'AAAAAAAAAAAAAAAA',ciphertext:'A'.repeat(size),protocol:'sejire/v0.3'});
  return {serialized,archive:{digest:sha(serialized),bytes:Buffer.byteLength(serialized),vaultId:fill.repeat(32),parentTxId}};
}
const archiveInput=archive('a',360000,Buffer.alloc(32,6).toString('base64url'));
function paymentFor(order,preparation){
  const messageBytes=Buffer.from(preparation.messageBase64,'base64'),message=Message.from(messageBytes);
  const signatureBytes=sign(null,messageBytes,payerKey.privateKey),signature=b58(signatureBytes);
  const signedTransaction=Buffer.concat([Buffer.from([1]),signatureBytes,messageBytes]).toString('base64');
  const keys=message.accountKeys.map(key=>key.toBase58());
  const payment={order,signature,signedTransaction,raw:{slot:100,blockTime:Math.ceil(preparation.createdAt/1000)+1,version:'legacy',
    transaction:{signatures:[signature],message:{header:message.header,accountKeys:keys,recentBlockhash:message.recentBlockhash,instructions:message.instructions}},
    meta:{err:null,fee:5000,innerInstructions:[],preBalances:keys.map(()=>1000000000),postBalances:keys.map(()=>1000000000)}}};
  wire.expectedPayments.set(signedTransaction,payment);return payment;
}
let backend,base,token,otherToken,policy,order,preparation,payment,signedDigest,receipt;
const passed=[];
async function test(name,run){await run();passed.push(name);console.log(`PASS Linux paid/promo: ${name}`);}
async function start(overrides={},off=false){
  await backend?.close();
  backend=await startLinuxCheckout({dbPath,bindings:off?{CHECKOUT_ALLOWED_ORIGINS:origin}:{...bindings,...overrides},fundProvider});
  base=`http://127.0.0.1:${backend.address.port}`;
}
async function call(path,payload,credential,headers={}){
  const response=await fetch(base+path,{method:payload===undefined?'GET':'POST',
    headers:{Origin:origin,'Content-Type':'application/json',...(credential?{Authorization:`Bearer ${credential}`}:{ }),...headers},
    ...(payload===undefined?{}:{body:JSON.stringify(payload)})});
  return {status:response.status,body:await response.json()};
}
const checkout=(path,payload,credential=token,headers)=>call('/api/checkout'+path,payload,credential,headers);
const fund=(path,payload,credential,headers)=>call('/api/fund'+path,payload,credential,headers);
const create=(key,input=archiveInput,policyHash=policy.policyHash)=>checkout('/orders',{
  kind:'preservation',payer,contribution:'0',policyHash,...input},token,{'Idempotency-Key':key});
async function waitPaid(predicate,label){
  const deadline=Date.now()+15000;
  for(;;){const row=paidRow(order.id);if(predicate(row))return row;
    if(Date.now()>=deadline)throw Error(`synthetic_paid_timeout:${label}:${row.status}:${row.last_error}`);
    await new Promise(resolve=>setTimeout(resolve,40));}
}
const promoInput=code=>({orderId:'b'.repeat(32),preservationId:'c'.repeat(32),code,archive:archive('b').serialized,parentTxId:'P'.repeat(43)});

try{
  await start({},true);
  await test('default-off HTTP has no payment offer, session or outbound request',async()=>{
    assert.equal((await checkout('/policy',undefined,null)).body.ready,false);
    assert.equal((await checkout('/session',{},null)).status,404);
    assert.deepEqual(await fund('/status'),{status:503,body:{error:'fund_not_configured'}});
    assert.equal(wire.calls.length,0);
  });
  await start();
  await test('origin and server admin authentication guard management; readiness uses actual synthetic signer',async()=>{
    for(const [path,body] of [['/admin/promo',{code:'LINUX-PROMO-A',confirm:'LINUX-PROMO-A'}],
      ['/admin/enabled',{enabled:true}],['/admin/limit',{limitAr:'26'}],['/admin/solana-recipients',undefined]]){
      for(const credential of [undefined,'wrong-synthetic-token'])assert.equal((await fund(path,body,credential)).status,401);
    }
    assert.equal((await fund('/admin/dashboard',undefined,admin,{Origin:'https://untrusted.example'})).status,403);
    const ready=await checkout('/policy',undefined,null);assert.equal(ready.status,200);assert.equal(ready.body.ready,true);policy=ready.body;
    assert.equal(policy.policy.network,'mainnet-beta');assert.equal(policy.policy.serviceLamports,'30000000');
    assert.equal(policy.policy.storage.treasuryAddress,treasury);
    token=(await checkout('/session',{},null)).body.accessToken;otherToken=(await checkout('/session',{},null)).body.accessToken;
    assert.match(token,/^[a-f0-9]{64}$/);
  });
  await test('512 KiB boundary and tampered archive are rejected before any order or hold',async()=>{
    const tooLarge=archive('d',524288);
    assert.equal((await create('linux_oversized_order_01',tooLarge)).status,400);
    assert.equal((await create('linux_tampered_order_01',{...archiveInput,serialized:archiveInput.serialized+' '})).status,400);
    assert.deepEqual(counts(),{orders:0,paidOrders:0,paidHolds:0,credits:0,fundOrders:0});
  });
  await test('paid HTTP admission is idempotent and immutable across recipient rotation',async()=>{
    const created=await create('linux_paid_first_order_01');assert.equal(created.status,201);order=created.body.record.order;
    wire.archives.set(order.id,archiveInput.serialized);
    assert.equal(order.servicePayment.recipient,addr(2));
    const before=wire.calls.length;
    const retried=await create('linux_paid_first_order_01');assert.equal(retried.status,200);assert.equal(retried.body.record.order.id,order.id);
    assert.equal(wire.calls.length,before);
    const input={expectedRevision:0,serviceRecipient:addr(4),fundRecipient:addr(5)};
    const changed=await fund('/admin/solana-recipients',input,admin);assert.equal(changed.status,200);assert.equal(changed.body.revision,1);
    assert.equal((await fund('/admin/solana-recipients',input,admin)).body.revision,1,'lost admin reply must not increment revision twice');
    assert.equal((await fund('/admin/solana-recipients',{...input,serviceRecipient:addr(6)},admin)).status,409);
    assert.equal((await create('linux_stale_policy_order_01')).status,409);
    assert.equal((await create('linux_paid_first_order_01')).body.record.order.servicePayment.recipient,addr(2));
    assert.equal((await checkout('/policy',undefined,null)).body.policy.serviceRecipient,addr(4));
    assert.equal((await checkout(`/orders/${order.id}`,undefined,otherToken)).status,404);
    assert.equal((await checkout('/orders/by-key/linux_paid_first_order_01',undefined,otherToken)).status,404);
    assert.deepEqual(counts(),{orders:1,paidOrders:1,paidHolds:1,credits:0,fundOrders:0});
  });
  await test('prepared bytes and valid signature are required before durable reserve or relay',async()=>{
    preparation=(await checkout(`/orders/${order.id}/prepare`,{})).body;
    assert.equal(preparation.schema,'sejire/payment-preparation/v1');
    payment=paymentFor(order,preparation);
    const before=wire.paymentSends;
    for(const [patch,reason] of [[{signature:b58(Buffer.alloc(64,1))},'invalid_payment_signature'],
      [{signedMessage:Buffer.from('wrong synthetic message').toString('base64')},'payment_preparation_mismatch'],
      [{signedTransaction:Buffer.from('wrong synthetic signed transaction').toString('base64')},'invalid_signed_payment']]){
      const result=await checkout(`/orders/${order.id}/reserve`,{signature:payment.signature,
        preparationId:preparation.preparationId,signedMessage:preparation.messageBase64,signedTransaction:payment.signedTransaction,...patch});
      assert.equal(result.status,400);
      assert.equal(result.body.error,reason);
    }
    assert.equal(wire.paymentSends,before);assert.equal(payload(order.id,'signed-payment'),undefined);
    assert.equal((await checkout(`/orders/${order.id}/reserve`,{signature:payment.signature,
      preparationId:preparation.preparationId,signedMessage:preparation.messageBase64,signedTransaction:payment.signedTransaction})).status,202);
    assert.equal(payload(order.id,'signed-payment'),payment.signedTransaction);
    assert.equal((await checkout(`/orders/${order.id}/cancel`,{preparationId:preparation.preparationId})).body.error,'previous_payment_unresolved');
  });
  await test('durable Linux alarm continues reserved payment, lost SOL/header replies retain exact obligation',async()=>{
    // No execute/verify call: the actual Linux timer must run the durable job.
    await waitPaid(row=>row.paid===1&&row.status==='confirming'&&row.lease_until===0,'lost replies');
    assert.equal(wire.paymentSends,1);assert.equal(wire.headerPosts,1);assert.equal(wire.chunkPosts,0);
    assert.equal(counts().credits,1);
    const state=(await checkout(`/orders/${order.id}`)).body;
    assert.equal(state.execution.verification.transactionConfirmed,true);assert.equal(state.execution.verification.archiveVerified,false);
    assert.equal(state.execution.receipt,undefined);
    assert.equal(readSql('SELECT actual,released FROM paid_holds WHERE order_id=?',order.id)[0].actual,reward);
    signedDigest=sha(payload(order.id,'signed'));
  });
  await test('cold SQLite reopen resumes same owner/key/payment and uploads only missing original chunks',async()=>{
    const txId=JSON.parse(payload(order.id,'signed')).id;
    await start({CHECKOUT_PAID_ENABLED:'false'});
    assert.equal((await checkout('/policy',undefined,null)).body.ready,false);
    const retried=await checkout('/orders/by-key/linux_paid_first_order_01');assert.equal(retried.status,200);assert.equal(retried.body.record.order.id,order.id);
    assert.equal((await create('linux_paused_new_order_01')).status,404,'paused admission cannot create another obligation');
    assert.equal(retried.body.record.order.servicePayment.recipient,addr(2));
    assert.equal((await fund('/admin/solana-recipients',undefined,admin)).body.revision,1);
    assert.equal((await checkout(`/orders/${order.id}/reconcile`,{})).status,202);
    await waitPaid(row=>row.status==='completed'&&row.lease_until===0,'restarted data replay');
    const state=(await checkout(`/orders/${order.id}`)).body;receipt=state.execution.receipt;
    assert.equal(receipt.status,'confirmed-and-verified');assert.equal(receipt.txId,txId);assert.equal(receipt.paymentSignature,payment.signature);
    assert.deepEqual(receipt.archive,archiveInput.archive);assert.equal(sha(payload(order.id,'signed')),signedDigest);
    assert.equal(wire.paymentSends,1);assert.equal(wire.headerPosts,1);assert(wire.chunkPosts>=2);
    assert.equal(wire.submissions.size,1);assert.equal(counts().credits,1);
    assert.equal(sha(wire.submissions.get(txId).serialized),archiveInput.archive.digest);
  });
  await test('explicit post-completion repair restores original bytes without changing receipt or spend',async()=>{
    const stored=wire.submissions.get(receipt.txId);stored.complete=false;stored.chunks.clear();
    const beforeChunks=wire.chunkPosts,beforeHold=readSql('SELECT * FROM paid_holds WHERE order_id=?',order.id)[0];
    assert.equal((await checkout(`/orders/${order.id}/repair`,{})).status,202);
    const deadline=Date.now()+15000;
    while(readSql('SELECT status FROM paid_archive_repairs WHERE order_id=?',order.id)[0]?.status!=='verified'){
      if(Date.now()>deadline)throw Error('synthetic_repair_timeout');await new Promise(resolve=>setTimeout(resolve,40));
    }
    await waitPaid(row=>row.lease_until===0,'repair drain');
    assert(wire.chunkPosts>beforeChunks);assert.equal(wire.headerPosts,1);assert.equal(wire.paymentSends,1);
    assert.deepEqual((await checkout(`/orders/${order.id}`)).body.execution.receipt,receipt);
    assert.deepEqual(readSql('SELECT * FROM paid_holds WHERE order_id=?',order.id)[0],beforeHold);
  });
  await test('authorized Mainnet admin overview reflects committed payment and storage, with no payload or bearer capability',async()=>{
    const before={sends:wire.paymentSends,headers:wire.headerPosts,chunks:wire.chunkPosts,signs:fundProvider.signings};
    assert.equal((await fund('/admin/paid-orders')).status,401);
    const view=await fund('/admin/paid-orders?limit=1',undefined,admin);assert.equal(view.status,200);
    assert.equal(view.body.schema,'sejire/admin-paid-orders/v1');assert.equal(view.body.configuredNetwork,'mainnet-beta');
    assert.equal(view.body.policy.serviceLamports,'30000000');assert.equal(view.body.policy.maxArchiveBytes,524288);
    assert.equal(view.body.policy.paymentEnabled,false);assert.equal(view.body.policy.serviceRecipient,addr(4));
    const entry=view.body.orders.find(row=>row.id===order.id);assert(entry);
    assert.equal(entry.network,'mainnet-beta');assert.equal(entry.paymentStatus,'verified');assert.equal(entry.storageStatus,'completed');
    assert.equal(entry.signature,payment.signature);assert.equal(entry.arweaveTxId,receipt.txId);assert.equal(entry.rewardWinston,reward);
    assert.deepEqual(view.body.totals,[{network:'mainnet-beta',totalOrders:1,paymentConfirmed:1,storageCompleted:1,pending:0,failed:0,serviceLamports:'30000000',contributionLamports:'0'}]);
    const serialized=JSON.stringify(view.body);
    for(const forbidden of [token,otherToken,sha(token),archiveInput.serialized,preparation.messageBase64,payment.signedTransaction,payload(order.id,'signed'),arKey.d])assert.equal(serialized.includes(forbidden),false);
    assert.deepEqual({sends:wire.paymentSends,headers:wire.headerPosts,chunks:wire.chunkPosts,signs:fundProvider.signings},before);
  });
  await test('promo admin rotation and lost submission acknowledgement persist real HTTP/SQLite state',async()=>{
    assert.equal((await fund('/admin/promo',{code:'LINUX-PROMO-A',confirm:'LINUX-PROMO-A'},admin)).status,200);
    assert.equal((await fund('/validate',{code:' linux-promo-a '})).status,200);
    fundProvider.failure='lost_response';
    const created=await fund('/orders',promoInput('LINUX-PROMO-A'));assert.equal(created.status,202);
    assert.equal(created.body.order.status,'NEEDS_RECONCILIATION');assert.equal(fundProvider.signings,1);assert.equal(fundProvider.submissions,1);
    assert.equal('signedTransaction' in created.body.order,false);assert.equal('preparedTransaction' in created.body.order,false);
    assert.equal((await fund('/admin/promo',{code:'LINUX-PROMO-B',confirm:'LINUX-PROMO-B'},admin)).body.promo.revision,2);
    assert.equal((await fund('/validate',{code:'LINUX-PROMO-A'})).body.error,'promo_invalid');
    assert.equal((await fund('/validate',{code:'LINUX-PROMO-B'})).status,200);
    assert.equal((await fund('/admin/enabled',{enabled:false},admin)).status,200);
    fundProvider.failure='';fundProvider.delay=true;
    await start({CHECKOUT_PAID_ENABLED:'false'});
    const pending=(await fund(`/orders/${'b'.repeat(32)}`)).body.order;
    assert.equal(pending.arweaveTxId,created.body.order.arweaveTxId);assert.notEqual(pending.status,'COMPLETED');
    fundProvider.delay=false;fundProvider.failure='archive_unavailable';
    const missing=await fund(`/orders/${'b'.repeat(32)}`);
    assert.equal(missing.body.verification.transactionConfirmed,true);
    assert.equal(missing.body.verification.reason,'archive_unavailable');
    fundProvider.slowMissingRead=true;
    const recovered=await fund('/orders',promoInput('LINUX-PROMO-A'));
    assert.equal(recovered.status,200);assert.equal(recovered.body.order.status,'COMPLETED');
    assert.equal(recovered.body.order.promoRevision,1);assert.equal(recovered.body.order.arweaveTxId,created.body.order.arweaveTxId);
    assert.equal(fundProvider.signings,1);assert.equal(fundProvider.submissions,1);
    assert.equal(fundProvider.replays,1,'confirmed header with missing data must replay exact chunks on explicit retry');
    assert.equal((await fund('/orders',{...promoInput('LINUX-PROMO-A'),parentTxId:'Q'.repeat(43)})).body.error,'archive_changed');
    const dashboard=(await fund('/admin/dashboard',undefined,admin)).body;
    assert.equal(dashboard.promo.revision,2);assert.equal(dashboard.promo.enabled,false);
    assert.equal(dashboard.actualSpentWinston,reward);assert.equal(dashboard.reservedWinston,'0');assert.equal(dashboard.successfulTrees,1);
    const settings=readSql('SELECT code_hash,display_hint FROM fund_settings')[0];
    assert.match(settings.code_hash,/^[a-f0-9]{64}$/);assert(!JSON.stringify(settings).includes('LINUX-PROMO-B'));
  });
  await test('new promo use obeys rotated code and cumulative budget without changing historical receipt',async()=>{
    assert.equal((await fund('/admin/enabled',{enabled:true},admin)).status,200);
    assert.equal((await fund('/admin/limit',{limitAr:'0.005'},admin)).status,200);
    const next={...promoInput('LINUX-PROMO-B'),orderId:'d'.repeat(32),preservationId:'e'.repeat(32)};
    assert.equal((await fund('/orders',next)).body.error,'fund_exhausted');
    assert.equal(fundProvider.signings,1);assert.equal(fundProvider.submissions,1);
    assert.equal((await fund('/admin/limit',{limitAr:'0.006'},admin)).status,200);
    assert.equal((await fund('/orders',next)).body.order.status,'COMPLETED');
    assert.equal(fundProvider.signings,2);assert.equal(fundProvider.submissions,2);
    const dashboard=(await fund('/admin/dashboard',undefined,admin)).body;
    assert.equal(dashboard.actualSpentWinston,'6000000000');assert.equal(dashboard.budgetRemainingWinston,'0');
    assert.equal(dashboard.successfulTrees,2);assert.equal(dashboard.currentRevisionTrees,1);
    await start({CHECKOUT_PAID_ENABLED:'false'});
    assert.deepEqual((await checkout(`/orders/${order.id}`)).body.execution.receipt,receipt);
    assert.equal((await fund(`/orders/${'b'.repeat(32)}`)).body.order.promoRevision,1);
    assert.equal((await fund('/admin/dashboard',undefined,admin)).body.actualSpentWinston,'6000000000');
  });
  const summary={result:'PASS',node:process.version,groups:passed.length,passed,
    runtime:'real Linux HTTP adapter + real SQLite/WAL; same database reopened across server lifetimes',
    paidProvider:'production DirectArweavePreservation; ephemeral Ed25519 and RSA-PSS signing; synthetic finalized RPC/Arweave responses',
    promoProvider:'in-process MockFundedArweaveProvider; production HTTP/admin/ledger logic; no claim of production-treasury RSA signing',
    externalNetworkRequests:0,syntheticPaymentRelays:wire.paymentSends,syntheticArweaveHeaders:wire.headerPosts,
    syntheticArweaveChunks:wire.chunkPosts,syntheticPromoSignings:fundProvider.signings,syntheticPromoSubmissions:fundProvider.submissions,
    persistedCounts:counts(),limitations:['No real wallet extension, chain, funds, production keys or deployment.',
      'Cold reopen covers ledger persistence; OS SIGKILL exclusion is covered separately by linux-server.mjs tests.',
      'Promo continuation is exercised by explicit HTTP reconciliation; no autonomous promo alarm is claimed.',
      'Mock promo signer does not prove a live fixed-treasury signing binding.']};
  if(process.argv[2]){const destination=resolve(process.argv[2]);await mkdir(destination,{recursive:true});
    await writeFile(join(destination,'linux-paid-promo-summary.json'),JSON.stringify(summary,null,2)+'\n');}
  console.log(`linux-paid-promo: PASS (${passed.length} groups); real HTTP/SQLite, intercepted external network, synthetic keys only`);
}finally{
  await backend?.close();globalThis.fetch=originalFetch;await rm(temp,{recursive:true,force:true});
}
