// Real Linux HTTP + SQLite, synthetic native AR signatures and no external
// network. The child crash fixture never carries or prints a real signing key.
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {fork} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {startLinuxCheckout} from '../linux-server.mjs';
import {MockFundedArweaveProvider,createArweaveWebClient} from '../src/fund/provider.ts';
import {TREASURY_ADDRESS} from '../src/fund/ledger.ts';
const origin='https://funded-operations.example',admin='synthetic-fund-operations-admin-token';
const bindings={CHECKOUT_ALLOWED_ORIGINS:origin,ADMIN_TOKEN:admin,PROMO_CODE_SECRET:'synthetic-fund-operations-promo-hmac-secret',FUND_API_ENABLED:'true',MAX_ENVELOPE_BYTES:'524288'};
const originalFetch=globalThis.fetch,sha=value=>createHash('sha256').update(value).digest('hex');
const archive=JSON.stringify({schema:'sejire/envelope/v1',vault_id:'a'.repeat(32),cipher:'aes-gcm-256',kdf:'hkdf-sha256',iv:'AAAAAAAAAAAAAAAA',ciphertext:'A'.repeat(256),protocol:'sejire/v0.3'});
const orderId='a'.repeat(32),request={orderId,preservationId:'b'.repeat(32),archive,code:'SYNTHETIC-PROMO'};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label,ms=15000){const end=Date.now()+ms;for(;;){if(await check())return;if(Date.now()>end)throw Error('test_timeout:'+label);await wait(40);}}
function sql(path,query,...args){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare(query).all(...args).map(r=>({...r}));}finally{db.close();}}
async function call(base,path,payload,credential=admin){const response=await originalFetch(base+path,{method:payload===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',...(credential?{Authorization:'Bearer '+credential}:{})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});return {status:response.status,body:await response.json()};}

if(process.argv[2]==='--crash-child'){
  const [dbPath,remotePath,mode]=process.argv.slice(3);
  // Simulates the durable two-minute lease expiring while the process is down;
  // no production clock/config port is added, and wall-clock waits stay short.
  if(mode==='resume'){const now=Date.now;Date.now=()=>now()+121000;}
  globalThis.fetch=async()=>{throw Error('external_network_forbidden');};
  class CrashProvider extends MockFundedArweaveProvider{
    async state(){try{return JSON.parse(await readFile(remotePath,'utf8'));}catch{return {signings:0,submissions:0,replays:0};}}
    async save(value){await writeFile(remotePath,JSON.stringify(value));}
    async sign(prepared){const signed=await super.sign(prepared),state=await this.state();state.signings++;state.raw=signed.raw;state.id=signed.id;await this.save(state);return signed;}
    async submit(raw){const state=await this.state();assert.equal(raw,state.raw);state.submissions++;state.accepted=true;await this.save(state);
      // The header reached the synthetic network, but the process dies before
      // it can observe a response or release its durable execution lease.
      if(mode==='first')return new Promise(()=>{});
    }
    async getTransaction(id){const state=await this.state();return state.accepted&&state.id===id?{state:'confirmed',confirmed:true,reward:this.actual,confirmations:12}:{state:'not_found',confirmed:false,reward:null,confirmations:null};}
    async getRawData(id){const state=await this.state();return state.data&&state.id===id?new Uint8Array(JSON.parse(state.raw).data):null;}
    async replayData(raw){const state=await this.state();assert.equal(raw,state.raw);state.replays++;state.data=true;await this.save(state);}
  }
  const backend=await startLinuxCheckout({dbPath,bindings:{...bindings,...(mode==='resume'?{FUND_API_ENABLED:'false'}:{})},fundProvider:new CrashProvider()});
  process.on('message',message=>{if(message==='close')void backend.close().then(()=>process.send({event:'closed'},()=>process.disconnect()));});
  process.send({event:'ready',port:backend.address.port});
}else{
  const temp=await mkdtemp(join(tmpdir(),'sejire-funded-operations-')),dbPath=join(temp,'admin.sqlite');
  const passed=[],children=new Set();let backend,base;
  async function test(name,fn){await fn();passed.push(name);console.log('PASS funded operations: '+name);}
  function child(path,remote,mode){const p=fork(fileURLToPath(import.meta.url),['--crash-child',path,remote,mode],{silent:true});children.add(p);
    let error='';p.stderr.on('data',data=>error=(error+data).slice(-2048));
    p.exited=new Promise(resolve=>p.once('exit',(code,signal)=>{children.delete(p);resolve({code,signal});}));
    p.ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('child_start_timeout:'+error)),15000);p.once('message',value=>{clearTimeout(timer);resolve(value);});p.once('error',reject);});return p;}
  const mock=new MockFundedArweaveProvider(),ar=createArweaveWebClient();
  let quotedBytes=null;const mockPrice=mock.getPrice.bind(mock);mock.getPrice=async bytes=>{quotedBytes=bytes;return mockPrice(bytes);};
  const pair=await webcrypto.subtle.generateKey({name:'RSA-PSS',modulusLength:4096,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const key=await webcrypto.subtle.exportKey('jwk',pair.privateKey);
  const wire={height:100,balance:'10000000000000',transactions:new Map(),calls:0,writes:0,baselineHook:null,failHost:null};
  const blockHash=Buffer.alloc(48,4).toString('base64url');
  async function transfer(amount,{target=TREASURY_ADDRESS,height=101,confirmations=12,tag}={}){
    const tx=await ar.createTransaction({owner:key.n,target,quantity:amount,reward:'100',last_tx:Buffer.alloc(48,3).toString('base64url')});
    if(tag)tx.addTag(tag.name,tag.value);
    await ar.transactions.sign(tx,key);const raw=JSON.parse(JSON.stringify(tx.toJSON()));
    wire.transactions.set(tx.id,{raw,height,confirmations,hash:blockHash});return tx.id;
  }
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(input instanceof Request?input.url:String(input));
    if(url.protocol==='http:'&&url.hostname==='127.0.0.1')return originalFetch(input,init);
    if(!['https://arweave.net','https://g8way.io'].includes(url.origin))throw Error('external_network_forbidden');
    if(init.method&&init.method!=='GET'){wire.writes++;throw Error('unexpected_network_write');}
    wire.calls++;if(wire.failHost===url.hostname)return new Response('synthetic-unavailable',{status:503});
    if(url.pathname===`/wallet/${TREASURY_ADDRESS}/balance`)return new Response(wire.balance);
    if(url.pathname==='/info'){if(wire.baselineHook){const hook=wire.baselineHook;wire.baselineHook=null;await hook();}return Response.json({network:'arweave.N.1',height:wire.height});}
    const match=/^\/tx\/([A-Za-z0-9_-]{43})(\/status)?$/.exec(url.pathname),t=match&&wire.transactions.get(match[1]);
    if(t)return Response.json(match[2]?{block_height:t.height,block_indep_hash:t.hash,number_of_confirmations:t.confirmations}:t.raw);
    return new Response('not_found',{status:404});
  };
  const root='/api/fund/admin',topups=root+'/treasury-topups';
  const get=path=>call(base,path),post=(path,data)=>call(base,path,data);
  const prepare=(requestId,amountWinston,expectedRevision=0)=>post(topups+'/prepare',{requestId,address:TREASURY_ADDRESS,amountWinston,expectedRevision});
  const confirm=(id,txId,expectedRevision)=>post(topups+'/'+id+'/confirm',{txId,expectedRevision});
  const start=async()=>{await backend?.close();backend=await startLinuxCheckout({dbPath,bindings,fundProvider:mock});base='http://127.0.0.1:'+backend.address.port;};
  try{
    await start();
    await test('public health and admin status expose no secrets and perform no signing or upload',async()=>{
      assert.deepEqual((await get('/healthz')).body,{schema:'sejire/service-health/v1',status:'ok',runtime:'linux-sqlite',sourceCommit:null});
      const calls=wire.calls;
      for(const path of [root+'/paid-orders',root+'/service-readiness',topups]){
        assert.equal((await call(base,path,undefined,null)).status,401);assert.equal((await call(base,path,undefined,'wrong')).status,401);
      }
      const ready=await get(root+'/service-readiness');assert.equal(ready.status,200);assert.equal(ready.body.scope,'configuration');assert.equal(ready.body.ready,false);
      assert(ready.body.blockers.includes('paid_not_configured'));assert.equal(wire.calls,calls);assert.equal(mock.signings,0);
      assert.equal(JSON.stringify(ready.body).includes(bindings.PROMO_CODE_SECRET),false);
      assert.equal((await get(root+'/paid-orders')).body.orders.length,0);
    });
    let first;
    await test('prepare pins a conservative baseline before deposit; refresh/restart and lost response reuse exact intent',async()=>{
      assert.equal((await get(topups)).body.treasuries[0].ceilingWinston,null);
      first=await prepare('1'.repeat(32),'2000000000');assert.equal(first.status,200);assert.equal(first.body.intent.baselineHeight,100);
      assert.match(first.body.intent.transferTag.value,/^[a-f0-9]{64}$/);assert.equal(first.body.intent.transferTag.name,'SEJIRE-Topup-Intent');
      assert.equal(first.body.treasury.ceilingWinston,wire.balance);const before=wire.calls;
      const retry=await prepare('1'.repeat(32),'2000000000',999);assert.deepEqual(retry.body,first.body);assert.equal(wire.calls,before);
      assert.equal((await prepare('1'.repeat(32),'3000000000')).body.error,'topup_idempotency_conflict');
      await start();assert.deepEqual((await get(topups)).body.intents[0],first.body.intent);
      assert.equal(sql(dbPath,'SELECT COUNT(*) n FROM treasury_topup_audit')[0].n,1);
    });
    await test('only a matching new native AR transfer with two-node proof and 12 confirmations can raise ceiling',async()=>{
      const tag=first.body.intent.transferTag;
      const old=await transfer('2000000000',{height:100,tag}),wrong=await transfer('3000000000',{tag}),pending=await transfer('2000000000',{confirmations:11,tag});
      assert.equal((await confirm(first.body.intent.id,old,0)).body.error,'topup_precedes_intent');
      assert.equal((await confirm(first.body.intent.id,wrong,0)).body.error,'topup_transaction_mismatch');
      assert.equal((await confirm(first.body.intent.id,pending,0)).body.error,'topup_not_confirmed');
      const proof=wire.transactions.get(pending);proof.confirmations=12;proof.raw.quantity='4000000000';
      assert.equal((await confirm(first.body.intent.id,pending,0)).body.error,'topup_transaction_mismatch');
      proof.raw.quantity='2000000000';wire.failHost='g8way.io';
      assert.equal((await confirm(first.body.intent.id,pending,0)).body.error,'topup_proof_unavailable');wire.failHost=null;
      const credited=await confirm(first.body.intent.id,pending,0);assert.equal(credited.status,200);assert.equal(credited.body.reused,false);
      assert.equal(credited.body.treasury.ceilingWinston,'10002000000000');assert.equal(credited.body.treasury.revision,1);
      assert.equal(credited.body.intent.txId,pending);const calls=wire.calls;
      const replay=await confirm(first.body.intent.id,pending,0);assert.equal(replay.body.reused,true);assert.equal(wire.calls,calls);
      assert.equal(sql(dbPath,"SELECT COUNT(*) n FROM treasury_topup_audit WHERE action='CREDITED'")[0].n,1);
    });
    await test('a transfer cannot credit two intents and concurrent revision changes fail closed without losing obligations',async()=>{
      wire.balance='10002000000000';
      const second=(await prepare('2'.repeat(32),'2000000000',1)).body;
      const already=(await get(topups)).body.intents.find(i=>i.id===first.body.intent.id).txId;
      assert.equal((await confirm(second.intent.id,already,1)).body.error,'topup_transaction_used');
      const fresh=await transfer('2000000000',{height:102,tag:second.intent.transferTag});
      assert.equal((await confirm(second.intent.id,fresh,0)).body.error,'treasury_revision_conflict');
      const credited=await confirm(second.intent.id,fresh,1);assert.equal(credited.body.treasury.revision,2);
      const before=(await get(topups)).body.treasuries[0];
      const db=new DatabaseSync(dbPath);try{db.prepare('INSERT INTO paid_holds(order_id,budget_id,treasury,reward) VALUES(?,?,?,?)').run('synthetic-held','synthetic-budget',TREASURY_ADDRESS,'700');}finally{db.close();}
      wire.baselineHook=async()=>{const db=new DatabaseSync(dbPath);try{db.prepare('UPDATE treasury_revision SET revision=revision+1 WHERE address=?').run(TREASURY_ADDRESS);}finally{db.close();}};
      assert.equal((await prepare('3'.repeat(32),'500',2)).body.error,'treasury_revision_conflict');
      const after=(await get(topups)).body.treasuries[0];assert.equal(after.ceilingWinston,before.ceilingWinston);assert.equal(after.heldWinston,'700');
      assert.equal(sql(dbPath,'SELECT COUNT(*) n FROM treasury_topups WHERE id=?','3'.repeat(32))[0].n,0);
      const page=await get(topups+'?limit=1');assert.equal(page.body.hasMore,true);assert(page.body.cursor);
      assert.equal((await get(topups+'?limit=1&cursor='+page.body.cursor)).body.intents[0].id,first.body.intent.id);
      const ready=await get(root+'/readiness');assert.equal(ready.status,200);assert.equal(ready.body.quoteBytes,524288);assert.equal(quotedBytes,524288);
      assert.equal(ready.body.sharedReservedWinston,'700');assert.equal(ready.body.guardedBalanceWinston,after.ceilingWinston);
      assert.equal(ready.body.effectiveAvailableWinston,(BigInt(after.ceilingWinston)-700n).toString(),'readiness uses physical ceiling minus shared holds, not gross wallet balance');
      assert.equal(wire.writes,0);
    });
    await test('stale head cache cannot credit an already observed deposit; only the future server nonce is accepted',async()=>{
      const path=join(temp,'stale-baseline.sqlite'),server=await startLinuxCheckout({dbPath:path,bindings,fundProvider:mock});
      const base='http://127.0.0.1:'+server.address.port;
      try{
        wire.balance='9000';wire.height=100;
        // Reproduces the review counterexample: balance already contains this
        // height101 deposit while BOTH /info responses are stale at height100.
        const old=await transfer('1000',{height:101});
        const prepared=await call(base,topups+'/prepare',{requestId:'4'.repeat(32),address:TREASURY_ADDRESS,amountWinston:'1000',expectedRevision:0});
        assert.equal(prepared.status,200);assert.equal(prepared.body.treasury.ceilingWinston,'9000');
        const intent=prepared.body.intent;
        const stale=await call(base,topups+'/'+intent.id+'/confirm',{txId:old,expectedRevision:0});assert.equal(stale.body.error,'topup_intent_mismatch');
        assert.equal((await call(base,topups)).body.treasuries[0].ceilingWinston,'9000');
        const wrong=await transfer('1000',{tag:{name:'SEJIRE-Topup-Intent',value:'f'.repeat(64)}});
        assert.equal((await call(base,topups+'/'+intent.id+'/confirm',{txId:wrong,expectedRevision:0})).body.error,'topup_intent_mismatch');
        const future=await transfer('1000',{tag:intent.transferTag});
        assert.equal((await call(base,topups+'/'+intent.id+'/confirm',{txId:future,expectedRevision:0})).body.treasury.ceilingWinston,'10000');
        const db=new DatabaseSync(path);try{db.prepare('INSERT INTO treasury_topups(id,address,amount,baseline_height,prior_ceiling,prepared_revision,created_at) VALUES(?,?,?,?,?,?,?)').run('5'.repeat(32),TREASURY_ADDRESS,'1000',100,'10000',1,Date.now());}finally{db.close();}
        const legacy=await call(base,topups+'/'+'5'.repeat(32)+'/confirm',{txId:future,expectedRevision:1});assert.equal(legacy.body.error,'topup_legacy_intent_requires_review');
      }finally{await server.close();}
    });
    await test('server transfer journal fences another browser and preserves exact Wander-signed payment before any broadcast',async()=>{
      const path=join(temp,'transfer-journal.sqlite');let server=await startLinuxCheckout({dbPath:path,bindings,fundProvider:mock});
      let base='http://127.0.0.1:'+server.address.port;
      try{
        const prepared=await call(base,topups+'/prepare',{requestId:'6'.repeat(32),address:TREASURY_ADDRESS,amountWinston:'1000',expectedRevision:0});
        const intent=prepared.body.intent,prefix=topups+'/'+intent.id+'/transfer',claimId='7'.repeat(32);
        const tx=await ar.createTransaction({owner:key.n,target:TREASURY_ADDRESS,quantity:'1000',reward:'100',last_tx:Buffer.alloc(48,3).toString('base64url')});
        tx.addTag(intent.transferTag.name,intent.transferTag.value);
        const unsignedTx=JSON.stringify(tx.toJSON());assert.deepEqual((await call(base,prefix)).body,{transfer:null});
        assert.equal((await call(base,prefix+'/claim',{claimId,unsignedTx})).body.reused,false);
        assert.equal((await call(base,prefix+'/claim',{claimId,unsignedTx})).body.reused,true,'retry must not grant another sign permission');
        assert.equal((await call(base,prefix+'/claim',{claimId:'8'.repeat(32),unsignedTx})).body.error,'topup_transfer_conflict');
        await server.close();server=await startLinuxCheckout({dbPath:path,bindings,fundProvider:mock});base='http://127.0.0.1:'+server.address.port;
        assert.deepEqual((await call(base,prefix)).body.transfer,{claimId,unsignedTx,signedTx:null,txId:null});
        const unknown=await transfer('1000',{tag:intent.transferTag});
        assert.equal((await call(base,topups+'/'+intent.id+'/confirm',{txId:unknown,expectedRevision:0})).body.error,'topup_transfer_unresolved');
        tx.addTag('Signing-Client','Wander');tx.addTag('Signing-Client-Version','synthetic-test');await ar.transactions.sign(tx,key);
        const signedTx=JSON.stringify(tx.toJSON()),bad=JSON.stringify({...JSON.parse(signedTx),quantity:'2000'});
        assert.equal((await call(base,prefix+'/signed',{claimId,signedTx:bad})).body.error,'topup_transaction_mismatch');
        assert.equal((await call(base,prefix)).body.transfer.signedTx,null);
        const saved=await call(base,prefix+'/signed',{claimId,signedTx});assert.equal(saved.status,200);assert.equal(saved.body.reused,false);
        assert.equal(saved.body.transfer.txId,tx.id);assert.equal((await call(base,prefix)).body.transfer.signedTx,signedTx);
        assert.equal((await call(base,prefix+'/signed',{claimId,signedTx})).body.reused,true);
        const replacement=ar.transactions.fromRaw(JSON.parse(unsignedTx));await ar.transactions.sign(replacement,key);assert.notEqual(replacement.id,tx.id);
        assert.equal((await call(base,prefix+'/signed',{claimId,signedTx:JSON.stringify(replacement.toJSON())})).body.error,'topup_transfer_conflict');
        assert.equal((await call(base,topups+'/'+intent.id+'/confirm',{txId:unknown,expectedRevision:0})).body.error,'topup_transfer_conflict');
        wire.transactions.set(tx.id,{raw:JSON.parse(signedTx),height:101,confirmations:12,hash:blockHash});
        assert.equal((await call(base,topups+'/'+intent.id+'/confirm',{txId:tx.id,expectedRevision:0})).status,200);
        assert.equal((await call(base,prefix+'/signed',{claimId,signedTx})).body.reused,true);
        assert.equal(sql(path,'SELECT COUNT(*) n FROM treasury_topup_transfers')[0].n,1);
        assert.equal(sql(path,"SELECT COUNT(*) n FROM treasury_topup_audit WHERE action='TRANSFER_SIGNED'")[0].n,1);
        assert.equal(wire.writes,0,'the backend signs/sends no owner payment');
      }finally{await server.close();}
    });
    await backend.close();backend=null;
    await test('SIGKILL after durable SIGNED resumes from real SQLite alarm without browser, code or another signature/payment',async()=>{
      const path=join(temp,'crash.sqlite'),remote=join(temp,'synthetic-remote.json'),first=child(path,remote,'first'),ready=await first.ready;
      const base='http://127.0.0.1:'+ready.port;
      assert.equal((await call(base,root+'/promo',{code:request.code,confirm:request.code})).status,200);
      // Concurrent duplicate request will see the lease and cannot sign again.
      const pending=call(base,'/api/fund/orders',request,null).catch(()=>null);
      await until(async()=>{try{return JSON.parse(await readFile(remote,'utf8')).accepted;}catch{return false;}},'synthetic header accepted');
      const duplicate=await call(base,'/api/fund/orders',request,null);assert.equal(duplicate.status,200);assert.equal(duplicate.body.order.status,'SIGNED');
      assert.equal((await call(base,root+'/enabled',{enabled:false})).status,200);
      const signed=sql(path,"SELECT signed_json,tx_id FROM fund_events WHERE status='SIGNED'")[0];assert(signed.signed_json);
      first.kill('SIGKILL');assert.equal((await first.exited).signal,'SIGKILL');await pending;
      const resumed=child(path,remote,'resume');await resumed.ready;
      await until(()=>sql(path,"SELECT COUNT(*) n FROM fund_events WHERE status='COMPLETED'")[0].n===1,'autonomous promo completion');
      const state=JSON.parse(await readFile(remote,'utf8'));
      assert.equal(state.signings,1);assert.equal(state.submissions,1);assert.equal(state.replays,1);assert.equal(state.id,signed.tx_id);assert.equal(sha(state.raw),sha(signed.signed_json));
      assert.equal(sql(path,'SELECT enabled FROM fund_settings')[0].enabled,0);
      assert.equal(sql(path,'SELECT COUNT(*) n FROM fund_orders')[0].n,1);
      assert.equal(sql(path,"SELECT COUNT(*) n FROM fund_events WHERE status='SIGNED'")[0].n,1);
      assert.equal(sql(path,'SELECT next_at,lease FROM fund_jobs')[0].next_at,null);
      const closed=new Promise(resolve=>resumed.once('message',resolve));resumed.send('close');assert.deepEqual(await closed,{event:'closed'});assert.equal((await resumed.exited).code,0);
    });
    const summary={result:'PASS',node:process.version,groups:passed.length,passed,externalNetworkRequests:0,
      nativeTopupProof:'ephemeral RSA-PSS native transfers; both gateway responses intercepted; ledger/revision/idempotence verified',
      crashRecovery:'real child SIGKILL; SQLite persisted SIGNED and lease; restart advances only test clock by121s; real timer alarm repairs original data without HTTP continuation',
      limitations:['No real wallet, funds, Arweave confirmation, production keys or deployment.','Promo child provider is synthetic; native top-up proof uses the production verifier.']};
    if(process.argv[2]){const dest=resolve(process.argv[2]);await mkdir(dest,{recursive:true});await writeFile(join(dest,'funded-operations-summary.json'),JSON.stringify(summary,null,2)+'\n');}
    console.log(`funded-operations: PASS (${passed.length} groups); real Linux/SQLite, synthetic keys and zero external requests`);
  }finally{await backend?.close();for(const c of children)c.kill('SIGKILL');await Promise.allSettled([...children].map(c=>c.exited));globalThis.fetch=originalFetch;await rm(temp,{recursive:true,force:true});}
}
