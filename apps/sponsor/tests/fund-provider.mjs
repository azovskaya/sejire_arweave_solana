import assert from 'node:assert/strict';
import * as ArweaveWebModule from 'arweave/web/index.js';
import Arweave from 'arweave';
import { DirectArweaveFundProvider, publicNetwork, publicAnchor } from '../src/fund/provider.ts';

const originalFetch=globalThis.fetch;
const anchor='A'.repeat(64); // realistic recent block independent hash from /tx_anchor

{
  let value=ArweaveWebModule;
  let runtime;
  for(let i=0;i<4;i++){
    const container=value&&(typeof value==='object'||typeof value==='function');
    if(container&&typeof value.init==='function'){runtime=value;break;}
    value=container?value.default:undefined;
  }
  assert.ok(runtime,'Arweave web runtime must expose init');
  try{
    const instance=runtime.init({host:'arweave.net',port:443,protocol:'https',timeout:15000});
    assert.equal(typeof instance.createTransaction,'function');
    console.log('arweave-web-init: PASS');
  }catch(error){
    console.error('arweave-web-init:',error?.name??'Error',error?.message??'unknown');
    throw error;
  }
}

try {
  const calls=[];
  const responseAt=(url,body,init)=>{const r=new Response(body,init);Object.defineProperty(r,'url',{value:url});return r;};
  globalThis.fetch=async (url,options)=>{
    calls.push([url,options]);
    if(url==='https://arweave.net/info')return responseAt(url,'unavailable',{status:503});
    if(url==='https://g8way.io/info')return responseAt(url,JSON.stringify({network:'arweave.N.1'}),{headers:{'content-type':'application/json'}});
    if(url==='https://arweave.net/tx_anchor')return responseAt(url,'invalid anchor');
    if(url==='https://g8way.io/tx_anchor')return responseAt(url,anchor);
    throw Error('unexpected gateway');
  };
  await publicNetwork();assert.equal(await publicAnchor(),anchor);
  assert.deepEqual(calls.map(x=>x[0]),['https://arweave.net/info','https://g8way.io/info','https://arweave.net/tx_anchor','https://g8way.io/tx_anchor']);
  assert.equal(calls.every(([,options])=>options.signal instanceof AbortSignal),true);

  globalThis.fetch=async()=>Response.json({network:'not-mainnet'});
  await assert.rejects(publicNetwork(),/network_unavailable/);
  globalThis.fetch=async()=>new Response('x'.repeat(4097));
  await assert.rejects(publicNetwork(),/network_unavailable/);
  globalThis.fetch=async()=>new Response('bad-anchor');
  await assert.rejects(publicAnchor(),/anchor_unavailable/);
  const client=Arweave.init({host:'arweave.net',port:443,protocol:'https'});
  client.transactions.getTransactionAnchor=async()=>{throw Error('hidden anchor request');};
  client.transactions.getPrice=async()=>{throw Error('hidden price request');};
  const tx=await client.createTransaction({data:new Uint8Array([1,2,3]),owner:'B'.repeat(342),reward:'3000000000',last_tx:anchor});
  assert.equal(tx.last_tx,anchor);assert.equal(tx.reward,'3000000000');
  const provider=new DirectArweaveFundProvider(JSON.stringify({kty:'RSA',n:'B'.repeat(342),d:'synthetic'}));
  provider.assertSigner=async()=>{};provider.getPrice=async()=> '3000000000';
  const preparationCalls=[];
  globalThis.fetch=async url=>{
    preparationCalls.push(url);
    if(url.endsWith('/info'))return responseAt(url,JSON.stringify({network:'arweave.N.1'}),{headers:{'content-type':'application/json'}});
    if(url.endsWith('/tx_anchor'))return responseAt(url,anchor);
    throw Error('unexpected SDK network request');
  };
  const prepared=await provider.prepareTransaction(new Uint8Array([1,2,3]),[{name:'App-Name',value:'SEJIRE'}]);
  const raw=JSON.parse(prepared.raw);
  assert.deepEqual(preparationCalls,['https://arweave.net/info','https://arweave.net/tx_anchor']);
  assert.equal(raw.last_tx,anchor);assert.equal(raw.owner,'B'.repeat(342));assert.equal(prepared.reward,'3000000000');

  const id='A'.repeat(43),reward='3000000000';
  const encoded=new TextEncoder().encode(JSON.stringify({schema:'sejire/envelope/v1',vault_id:'a'.repeat(32),cipher:'aes-gcm-256',kdf:'hkdf-sha256',iv:'AAAAAAAAAAAAAAAA',ciphertext:'A'.repeat(32),protocol:'sejire/v0.3'}));
  const expected={bytes:encoded.length,digest:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoded)),n=>n.toString(16).padStart(2,'0')).join(''),vaultId:'a'.repeat(32)};
  const confirmed={state:'confirmed',confirmed:true,reward,confirmations:284};
  const statusCalls=[];
  globalThis.fetch=async (url,options)=>{statusCalls.push([url,options]);return responseAt(url,'',{status:202});};
  const pending=await provider.getTransaction(id);
  assert.deepEqual(pending,{state:'pending',confirmed:false,reward:null,confirmations:0});
  const pendingCheck=await provider.verify(id,expected,pending);
  assert.equal(pendingCheck.verification.stage,'awaiting_confirmation');
  assert.equal(pendingCheck.verification.reason,'network_pending');
  assert.equal(statusCalls.length,1,'HTTP 202 is normal pending; verification reuses the network observation');

  globalThis.fetch=async url=>responseAt(url,'missing',{status:404});
  assert.equal((await provider.getTransaction(id)).state,'not_found');
  globalThis.fetch=async url=>url.startsWith('https://arweave.net/')?responseAt(url,'missing',{status:404}):responseAt(url,'Site Unavailable');
  await assert.rejects(provider.getTransaction(id),/transaction_unavailable/,'one missing index plus an unavailable gateway cannot establish absence');
  globalThis.fetch=async url=>responseAt(url,url.endsWith('/status')?JSON.stringify({number_of_confirmations:2}):JSON.stringify({id,owner:'B'.repeat(342),reward}));
  await assert.rejects(provider.getTransaction(id),/transaction_mismatch/,'a different transaction owner is never accepted');

  const archiveCalls=[];
  globalThis.fetch=async (url,options)=>{
    archiveCalls.push([url,options]);
    return url.startsWith('https://arweave.net/')?responseAt(url,'<html>Site Unavailable</html>',{headers:{'content-type':'text/html'}}):responseAt(url,encoded);
  };
  const recovered=await provider.verify(id,expected,confirmed);
  assert.equal(recovered.confirmed,true);assert.equal(recovered.verification.stage,'verified');
  assert.equal(recovered.verification.transactionConfirmed,true);assert.equal(recovered.verification.confirmations,284);
  assert.deepEqual(archiveCalls.map(([url])=>url),[`https://arweave.net/raw/${id}`,`https://g8way.io/raw/${id}`]);
  assert.equal(archiveCalls.every(([,options])=>options.signal instanceof AbortSignal&&(options.method??'GET')==='GET'&&!options.headers),true);

  globalThis.fetch=async url=>responseAt(url,'x'.repeat(encoded.length));
  const wrong=await provider.verify(id,expected,confirmed);
  assert.equal(wrong.confirmed,false);assert.equal(wrong.verification.stage,'attention');
  assert.equal(wrong.verification.transactionConfirmed,true);assert.equal(wrong.verification.reason,'archive_verification_failed');
  for(const changed of [{...expected,bytes:expected.bytes+1},{...expected,digest:'f'.repeat(64)},{...expected,vaultId:'b'.repeat(32)}]){
    globalThis.fetch=async url=>responseAt(url,encoded);
    assert.equal((await provider.verify(id,changed,confirmed)).verification.reason,'archive_verification_failed');
  }

  globalThis.fetch=async url=>responseAt(url,'missing',{status:404});
  const unavailable=await provider.verify(id,expected,confirmed);
  assert.equal(unavailable.confirmed,false);assert.equal(unavailable.verification.transactionConfirmed,true);
  assert.equal(unavailable.verification.stage,'checking_archive');assert.equal(unavailable.verification.reason,'archive_unavailable');
  const canonicalCalls=[];
  globalThis.fetch=async url=>{canonicalCalls.push(url);return url.includes('/raw/')?responseAt(url,'missing',{status:404}):responseAt(url,encoded);};
  assert.equal((await provider.verify(id,expected,confirmed)).confirmed,true);
  assert.deepEqual(canonicalCalls,[`https://arweave.net/raw/${id}`,`https://g8way.io/raw/${id}`,`https://arweave.net/${id}`]);

  const sandbox=`https://${'a'.repeat(52)}.arweave.net/${id}`,redirectCalls=[];
  globalThis.fetch=async (url,options)=>{
    redirectCalls.push([url,options]);
    return url===sandbox?responseAt(url,encoded):responseAt(url,'',{status:302,headers:{Location:sandbox}});
  };
  assert.equal((await provider.verify(id,expected,confirmed)).confirmed,true);
  assert.deepEqual(redirectCalls.map(([url])=>url),[`https://arweave.net/raw/${id}`,sandbox]);
  assert.equal(redirectCalls.every(([,options])=>options.redirect==='manual'),true);
  for(const target of [`https://attacker.example/${id}`,`http://${'a'.repeat(52)}.arweave.net/${id}`,`https://${'b'.repeat(52)}.arweave.net/${id}`,`https://${'a'.repeat(52)}.arweave.net/${'B'.repeat(43)}`]){
    const rejectedCalls=[];
    globalThis.fetch=async url=>{rejectedCalls.push(url);return responseAt(url,'',{status:302,headers:{Location:target}});};
    assert.equal((await provider.verify(id,expected,confirmed)).confirmed,false);
    assert.equal(rejectedCalls.includes(target),false,'an untrusted redirect is rejected before any request to its target');
  }

  // Response-body stalls, not only slow headers, share the complete check budget.
  const timeoutCalls=[],started=Date.now();
  globalThis.fetch=async (url,{signal})=>{
    timeoutCalls.push(url);
    return responseAt(url,new ReadableStream({start(controller){signal.addEventListener('abort',()=>controller.error(Error('synthetic timeout')),{once:true});}}));
  };
  // Keep Node alive while its unref'ed AbortSignal timer fires; no live requests.
  const hold=setTimeout(()=>{},1000);
  try{
    const timedOut=await provider.verify(id,expected,confirmed,Date.now()+30);
    assert.equal(timedOut.verification.reason,'archive_unavailable');assert.equal(timedOut.verification.transactionConfirmed,true);
    assert.ok(Date.now()-started<800,'one shared deadline bounds stalled response bodies and fallback attempts');
    assert.ok(timeoutCalls.length<=2);
  }finally{clearTimeout(hold);}
  console.log('fund-provider: PASS; pending/confirmed distinction, verified bounded fallback, trusted redirects and shared check deadline; zero posts');
} finally { globalThis.fetch=originalFetch; }
