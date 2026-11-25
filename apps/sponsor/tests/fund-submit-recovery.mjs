// Production promo submission/data replay with an ephemeral RSA-signed native
// transaction. This does NOT exercise the fixed production treasury's signer.
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {DirectArweaveFundProvider,createArweaveWebClient} from '../src/fund/provider.ts';

const originalFetch=globalThis.fetch,originalTimeout=globalThis.setTimeout;
const longTimers=new Set();
// A failing pre-fix SDK retry must not keep this regression process alive for
// its ~40-second sleep. The timer is still scheduled normally and never sped up.
globalThis.setTimeout=(fn,delay,...args)=>{const timer=originalTimeout(fn,delay,...args);
  if(delay>=20000){longTimers.add(timer);timer.unref?.();}return timer;};
let mode='fail-chunk',calls=[],passed=0;
const pair=await webcrypto.subtle.generateKey({name:'RSA-PSS',modulusLength:4096,
  publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const key=await webcrypto.subtle.exportKey('jwk',pair.privateKey);
const serialized=JSON.stringify({schema:'sejire/envelope/v1',vault_id:'a'.repeat(32),cipher:'aes-gcm-256',
  kdf:'hkdf-sha256',iv:'AAAAAAAAAAAAAAAA',ciphertext:'A'.repeat(360000),protocol:'sejire/v0.3'});
const bytes=Buffer.from(serialized),expected={digest:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,vaultId:'a'.repeat(32)};
globalThis.fetch=async(input,init={})=>{
  const url=new URL(String(input)).href;assert(['https://arweave.net/tx','https://arweave.net/chunk'].includes(url),'external network blocked');
  assert.equal(init.method,'POST');const body=JSON.parse(init.body);calls.push({url,body});
  if(mode==='hang-header'&&url.endsWith('/tx')||mode==='hang-chunk'&&url.endsWith('/chunk'))return new Promise(()=>{});
  if(mode==='fail-header'&&url.endsWith('/tx'))return new Response('synthetic unavailable',{status:503});
  if(mode==='fail-chunk'&&url.endsWith('/chunk'))return new Response('synthetic unavailable',{status:503});
  if(url.endsWith('/tx')){
    assert.equal(body.id,tx.id);assert.equal(body.signature,tx.signature);assert.equal(body.data,'');
  }else{
    assert.equal(body.data_root,tx.data_root);assert.equal(body.data_size,String(bytes.length));
    const chunk=Buffer.from(body.chunk,'base64url'),end=Number(body.offset)+1;
    assert.deepEqual(chunk,bytes.subarray(end-chunk.length,end));
  }
  return new Response('OK',{status:200});
};
const ar=createArweaveWebClient();
const tx=await ar.createTransaction({data:bytes,owner:key.n,reward:'3000000000',last_tx:Buffer.alloc(48,7).toString('base64url')});
await ar.transactions.sign(tx,key);
const raw=JSON.stringify(tx.toJSON()),provider=new DirectArweaveFundProvider(JSON.stringify(key));
async function boundedResult(work,timeout=2500){
  let timer;try{return await Promise.race([work.then(()=> 'fulfilled',()=> 'rejected'),
    new Promise(resolve=>{timer=originalTimeout(()=>resolve('still-pending'),timeout);})]);}finally{clearTimeout(timer);}
}
async function test(name,run){calls=[];await run();passed++;console.log(`PASS promo submission: ${name}`);}
try{
  await test('failed chunk returns once, without the SDK retry/sleep loop',async()=>{
    assert.equal(await boundedResult(provider.submit(raw,Date.now()+1000)),'rejected');
    assert.equal(calls.filter(call=>call.url.endsWith('/tx')).length,1);assert(calls.some(call=>call.url.endsWith('/chunk')));
  });
  await test('failed header returns once without beginning any chunk writes',async()=>{
    mode='fail-header';
    assert.equal(await boundedResult(provider.submit(raw,Date.now()+1000)),'rejected');
    assert.equal(calls.length,1);assert.equal(calls[0].url,'https://arweave.net/tx');
  });
  await test('one absolute deadline bounds a hanging header response',async()=>{
    mode='hang-header';assert.equal(await boundedResult(provider.submit(raw,Date.now()+1000)),'rejected');assert.equal(calls.length,1);
  });
  await test('the same deadline also bounds missing chunk acknowledgements',async()=>{
    mode='hang-chunk';assert.equal(await boundedResult(provider.submit(raw,Date.now()+1000)),'rejected');
    assert.equal(calls.filter(call=>call.url.endsWith('/tx')).length,1);assert(calls.some(call=>call.url.endsWith('/chunk')));
  });
  await test('native signed header and all exact Merkle chunks are sent once on success',async()=>{
    mode='success';await provider.submit(raw,Date.now()+2000);
    assert.equal(calls.filter(call=>call.url.endsWith('/tx')).length,1);assert.equal(calls.filter(call=>call.url.endsWith('/chunk')).length,2);
  });
  await test('confirmed-data repair sends only existing signed chunks and rejects altered ciphertext',async()=>{
    await provider.replayData(raw,expected,Date.now()+2000);
    assert.equal(calls.length,2);assert(calls.every(call=>call.url.endsWith('/chunk')));
    calls=[];
    const altered=JSON.parse(raw);altered.data=Buffer.from(serialized.replace(/A(?=A)/,'B')).toString('base64url');
    await assert.rejects(()=>provider.replayData(JSON.stringify(altered),expected,Date.now()+2000));
    await assert.rejects(()=>provider.submit(JSON.stringify(altered),Date.now()+2000));
    const injected={...altered,chunks:tx.chunks,data_tree:[]};
    await assert.rejects(()=>provider.submit(JSON.stringify(injected),Date.now()+2000));
    assert.equal(calls.length,0,'signature/data-root/archive binding is checked before any write');
    await assert.rejects(()=>provider.replayData(raw,{...expected,digest:'0'.repeat(64)},Date.now()+2000));
    assert.equal(calls.length,0);
  });
  console.log(`fund-submit-recovery: PASS (${passed} groups); ephemeral RSA, synthetic gateway only`);
}finally{
  globalThis.fetch=originalFetch;globalThis.setTimeout=originalTimeout;
  for(const timer of longTimers)clearTimeout(timer);
}
