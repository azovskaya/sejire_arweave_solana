import assert from 'node:assert/strict';
import * as ArweaveWebModule from 'arweave/web/index.js';
import Arweave from 'arweave';
import { DirectArweaveFundProvider, publicNetwork, publicAnchor } from '../src/fund/provider.ts';
import { publicTreasuryOwner } from './fund-public-owner.mjs';

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
  const preparedTags=[{name:'App-Name',value:'SEJIRE'},{name:'Parent-Tx',value:'P'.repeat(43)}];
  const prepared=await provider.prepareTransaction(new Uint8Array([1,2,3]),preparedTags);
  const raw=JSON.parse(prepared.raw);
  assert.deepEqual(preparationCalls,['https://arweave.net/info','https://arweave.net/tx_anchor']);
  assert.equal(raw.last_tx,anchor);assert.equal(raw.owner,'B'.repeat(342));assert.equal(prepared.reward,'3000000000');
  assert.deepEqual(raw.tags.map(tag=>({name:Buffer.from(tag.name,'base64url').toString(),value:Buffer.from(tag.value,'base64url').toString()})),preparedTags,
    'direct provider preserves the exact parent in serialized transaction tags');
  assert.deepEqual(JSON.parse(JSON.stringify(client.transactions.fromRaw(raw).toJSON())).tags,raw.tags,'SDK roundtrip keeps the parent bytes for signing');

  const id='A'.repeat(43),reward='3000000000';
  const encoded=new TextEncoder().encode(JSON.stringify({schema:'sejire/envelope/v1',vault_id:'a'.repeat(32),cipher:'aes-gcm-256',kdf:'hkdf-sha256',iv:'AAAAAAAAAAAAAAAA',ciphertext:'A'.repeat(32),protocol:'sejire/v0.3'}));
  const expected={bytes:encoded.length,digest:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoded)),n=>n.toString(16).padStart(2,'0')).join(''),vaultId:'a'.repeat(32)};
  const confirmed={state:'confirmed',confirmed:true,reward,confirmations:284};
  const treasuryMetadata={id,owner:publicTreasuryOwner,reward};
  for(const staleStatus of [202,404,200]){
    const parallelCalls=[];
    globalThis.fetch=async (url,options)=>{
      parallelCalls.push(url);assert.equal(options.method??'GET','GET');
      if(url.endsWith('/status')){
        if(url.startsWith('https://arweave.net/'))return responseAt(url,staleStatus===200?JSON.stringify({number_of_confirmations:0}):'',{status:staleStatus});
        await new Promise(resolve=>setTimeout(resolve,5));
        return responseAt(url,JSON.stringify({number_of_confirmations:42}));
      }
      return responseAt(url,JSON.stringify(treasuryMetadata));
    };
    const observed=await provider.getTransaction(id);
    assert.equal(observed.confirmed,true,`confirmed gateway must win over stale HTTP ${staleStatus}`);
    assert.equal(observed.reward,reward);assert.equal(observed.confirmations,42);
    assert.ok(parallelCalls.includes(`https://g8way.io/tx/${id}/status`));
  }
  const splitCalls=[];
  globalThis.fetch=async url=>{
    splitCalls.push(url);
    if(url===`https://arweave.net/tx/${id}/status`)return responseAt(url,JSON.stringify({number_of_confirmations:42}));
    if(url===`https://g8way.io/tx/${id}`)return responseAt(url,JSON.stringify(treasuryMetadata));
    return responseAt(url,'temporarily unavailable',{status:503});
  };
  assert.equal((await provider.getTransaction(id)).confirmed,true,'same TX status and validated metadata may come from different trusted gateways');
  assert.ok(splitCalls.includes(`https://g8way.io/tx/${id}`));
  globalThis.fetch=async url=>responseAt(url,url.endsWith('/status')?'missing':JSON.stringify(treasuryMetadata),{status:url.endsWith('/status')?404:200});
  assert.equal((await provider.getTransaction(id)).state,'pending','valid metadata prevents absence/resubmit classification when both status indexes are stale');

  let abortedNetworkBodies=0;
  globalThis.fetch=async (url,{signal})=>{
    if(url===`https://g8way.io/tx/${id}/status`)return responseAt(url,JSON.stringify({number_of_confirmations:42}));
    if(url===`https://arweave.net/tx/${id}`)return responseAt(url,JSON.stringify(treasuryMetadata));
    return responseAt(url,new ReadableStream({start(controller){signal.addEventListener('abort',()=>{abortedNetworkBodies++;controller.error(Error('synthetic losing body cancelled'));},{once:true});}}));
  };
  assert.equal((await provider.getTransaction(id)).confirmed,true);
  assert.equal(abortedNetworkBodies,2,'both losing status/metadata bodies are aborted after a validated confirmation wins');

  for(const bad of [{...treasuryMetadata,id:'B'.repeat(43)},{...treasuryMetadata,owner:'B'.repeat(342)},{...treasuryMetadata,reward:'0'}]){
    globalThis.fetch=async url=>responseAt(url,JSON.stringify(url.endsWith('/status')?{number_of_confirmations:42}:url.startsWith('https://arweave.net/')?bad:treasuryMetadata));
    assert.equal((await provider.getTransaction(id)).reward,reward,'invalid metadata cannot win over a valid same-TX treasury response');
    globalThis.fetch=async url=>responseAt(url,JSON.stringify(url.endsWith('/status')?{number_of_confirmations:42}:bad));
    await assert.rejects(provider.getTransaction(id),/transaction_mismatch/,'all-invalid metadata stays fail closed');
    globalThis.fetch=async url=>responseAt(url,JSON.stringify(url.endsWith('/status')?{number_of_confirmations:0}:bad));
    await assert.rejects(provider.getTransaction(id),/transaction_mismatch/,'HTTP 200 with zero confirmations still requires valid same-TX treasury metadata');
  }

  // Workerd requires manual redirects. Node status/metadata endpoints must
  // reject a redirect even when its body looks valid, without following Location.
  for(const endpoint of ['status','metadata'])for(const status of [301,302,303,307,308]){
    const target=`https://attacker.example/redirected-${endpoint}`,redirectedNodeCalls=[];
    globalThis.fetch=async (url,options)=>{
      redirectedNodeCalls.push([url,options]);
      const isStatus=url.endsWith('/status'),redirected=(endpoint==='status')===isStatus;
      return responseAt(url,JSON.stringify(isStatus?{number_of_confirmations:42}:treasuryMetadata),redirected?{status,headers:{Location:target}}:undefined);
    };
    await assert.rejects(provider.getTransaction(id),/transaction_unavailable/,`${endpoint} HTTP ${status} cannot confirm a transaction`);
    assert.equal(redirectedNodeCalls.length,4);
    assert.ok(redirectedNodeCalls.every(([,options])=>options.redirect==='manual'),`${endpoint} HTTP ${status} uses the workerd-supported manual mode`);
    assert.equal(redirectedNodeCalls.some(([url])=>url===target),false,`${endpoint} HTTP ${status} never requests Location`);
  }

  // Scale the clock and both timer APIs by ten: a 5.5s status/metadata body is
  // inside the new 8s request cap, but would be rejected by the old 4s cap.
  const realNow=Date.now,realTimeout=globalThis.setTimeout,realAbortTimeout=AbortSignal.timeout;
  const clockStart=realNow();
  Date.now=()=>clockStart+(realNow()-clockStart)*10;
  globalThis.setTimeout=(callback,ms,...args)=>realTimeout(callback,ms/10,...args);
  AbortSignal.timeout=ms=>realAbortTimeout(Math.max(0,Math.floor(ms/10)));
  try{
    globalThis.fetch=async (url,{signal})=>{
      if(url.startsWith('https://g8way.io/'))return responseAt(url,'unavailable',{status:503});
      const content=JSON.stringify(url.endsWith('/status')?{number_of_confirmations:42}:treasuryMetadata);
      return responseAt(url,new ReadableStream({start(controller){
        let finished=false;
        const timer=realTimeout(()=>{finished=true;controller.enqueue(new TextEncoder().encode(content));controller.close();},550);
        signal.addEventListener('abort',()=>{clearTimeout(timer);if(!finished){finished=true;controller.error(Error('synthetic delayed body aborted'));}},{once:true});
      }}));
    };
    const slowButHealthy=await provider.getTransaction(id,Date.now()+22000);
    assert.equal(slowButHealthy.confirmed,true,'a healthy body between 4s and 8s must remain within the complete check budget');
  }finally{Date.now=realNow;globalThis.setTimeout=realTimeout;AbortSignal.timeout=realAbortTimeout;}

  const networkTimeoutSignals=[],networkTimeoutStarted=Date.now();
  globalThis.fetch=async (url,{signal})=>{
    networkTimeoutSignals.push(signal);
    return responseAt(url,new ReadableStream({start(controller){signal.addEventListener('abort',()=>controller.error(Error('synthetic stalled network body')),{once:true});}}));
  };
  await assert.rejects(provider.getTransaction(id,Date.now()+30),/transaction_unavailable/);
  assert.equal(networkTimeoutSignals.length,4);assert.ok(networkTimeoutSignals.every(signal=>signal.aborted));
  assert.ok(Date.now()-networkTimeoutStarted<800,'the absolute deadline bounds all parallel status/metadata bodies');

  const statusCalls=[];
  globalThis.fetch=async (url,options)=>{statusCalls.push([url,options]);return responseAt(url,'',{status:202});};
  const pending=await provider.getTransaction(id);
  assert.deepEqual(pending,{state:'pending',confirmed:false,reward:null,confirmations:0});
  const pendingCheck=await provider.verify(id,expected,pending);
  assert.equal(pendingCheck.verification.stage,'awaiting_confirmation');
  assert.equal(pendingCheck.verification.reason,'network_pending');
  assert.equal(statusCalls.length,4,'both indexes are checked before pending; verification reuses the resulting network observation');

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
  for(const host of ['https://arweave.net','https://g8way.io'])assert.ok(archiveCalls.some(([url])=>url===`${host}/raw/${id}`));
  assert.ok(archiveCalls.length<=6,'bounded raw/canonical/node candidates are never repeated');
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
  assert.ok(canonicalCalls.includes(`https://arweave.net/${id}`));
  assert.ok(canonicalCalls.length<=6);

  // Reproduce the larger-archive failure: /raw returns wrong bytes and the
  // canonical URL is unavailable, while the node API has the exact ciphertext.
  const largeEnvelope=JSON.parse(new TextDecoder().decode(encoded));
  const cipherLength=39305-JSON.stringify({...largeEnvelope,ciphertext:''}).length;
  assert.equal(cipherLength%4,0);
  largeEnvelope.ciphertext='A'.repeat(cipherLength);
  const largeBytes=new TextEncoder().encode(JSON.stringify(largeEnvelope));
  const largeExpected={bytes:largeBytes.length,digest:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',largeBytes)),n=>n.toString(16).padStart(2,'0')).join(''),vaultId:largeEnvelope.vault_id};
  assert.equal(largeBytes.length,39305);
  const nodeData=Buffer.from(largeBytes).toString('base64url'),nodeCalls=[];
  globalThis.fetch=async (url,options)=>{
    nodeCalls.push([url,options]);
    assert.equal(options.method??'GET','GET');
    if(url.endsWith(`/tx/${id}/data`))return responseAt(url,nodeData);
    return url.includes('/raw/')?responseAt(url,new Uint8Array(largeBytes.length)):responseAt(url,'missing',{status:404});
  };
  const nodeRecovered=await provider.verify(id,largeExpected,confirmed);
  assert.equal(nodeRecovered.confirmed,true);assert.equal(nodeRecovered.verification.stage,'verified');
  assert.equal(nodeRecovered.verification.transactionConfirmed,true);
  assert.ok(nodeCalls.some(([url])=>url===`https://arweave.net/tx/${id}/data`));
  assert.ok(nodeCalls.length<=6);
  assert.ok(nodeCalls.filter(([url])=>url.endsWith('/data')).every(([,options])=>options.redirect==='manual'));
  assert.equal(nodeCalls.every(([,options])=>options.signal instanceof AbortSignal&&!options.headers),true);

  for(const status of [301,302,303,307,308]){
    const target=`https://attacker.example/tx/${id}/data`,redirectedDataCalls=[];
    globalThis.fetch=async (url,options)=>{
      redirectedDataCalls.push([url,options]);
      return url.endsWith(`/tx/${id}/data`)?responseAt(url,nodeData,{status,headers:{Location:target}}):responseAt(url,'missing',{status:404});
    };
    const rejected=await provider.verify(id,largeExpected,confirmed);
    assert.equal(rejected.confirmed,false,`node-data HTTP ${status} cannot verify an archive despite a valid-looking body`);
    assert.equal(rejected.verification.reason,'archive_unavailable');assert.equal(rejected.verification.transactionConfirmed,true);
    assert.equal(redirectedDataCalls.filter(([url])=>url.endsWith(`/tx/${id}/data`)).length,2);
    assert.ok(redirectedDataCalls.every(([,options])=>options.redirect==='manual'));
    assert.equal(redirectedDataCalls.some(([url])=>url===target),false,`node-data HTTP ${status} never requests Location`);
  }

  // A working node endpoint must win while raw/canonical chains are stalled,
  // without spending the entire pass before it is even attempted.
  let activeArchiveReads=0,maxArchiveReads=0,abortedArchiveBodies=0;const fastNodeCalls=[];
  globalThis.fetch=async (url,{signal})=>{
    fastNodeCalls.push(url);activeArchiveReads++;maxArchiveReads=Math.max(maxArchiveReads,activeArchiveReads);
    signal.addEventListener('abort',()=>{activeArchiveReads--;},{once:true});
    if(url===`https://arweave.net/tx/${id}/data`)return responseAt(url,nodeData);
    return responseAt(url,new ReadableStream({start(controller){signal.addEventListener('abort',()=>{abortedArchiveBodies++;controller.error(Error('synthetic losing archive cancelled'));},{once:true});}}));
  };
  const fastNode=await provider.verify(id,largeExpected,confirmed,Date.now()+500);
  assert.equal(fastNode.confirmed,true,'node-data verification cannot be starved by slow raw candidates');
  assert.equal(fastNodeCalls.length,4);assert.equal(maxArchiveReads,4);assert.equal(activeArchiveReads,0);
  assert.equal(abortedArchiveBodies,3,'all losing archive response bodies are aborted after a verified winner');

  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const noncanonical=nodeData.slice(0,-1)+alphabet[alphabet.indexOf(nodeData.at(-1))|1];
  assert.notEqual(noncanonical,nodeData);
  assert.deepEqual(Buffer.from(noncanonical,'base64url'),Buffer.from(largeBytes),'noncanonical trailing bits must not be accepted even when decoded bytes match');
  const changedBytes=largeBytes.slice();changedBytes[changedBytes.lastIndexOf(65)]=66;
  for(const [name,body] of [
    ['invalid alphabet','*'+nodeData.slice(1)],
    ['noncanonical trailing bits',noncanonical],
    ['invalid encoded length','A'],
    ['unexpected decoded length',Buffer.from(largeBytes.subarray(0,-1)).toString('base64url')],
    ['oversized encoded body','A'.repeat(Math.ceil(largeBytes.length*4/3)+1)],
    ['different archive digest',Buffer.from(changedBytes).toString('base64url')],
    ['unexpected JSON wrapper',JSON.stringify(nodeData)],
  ]){
    globalThis.fetch=async (url,options)=>{
      assert.equal(options.method??'GET','GET');
      return url.endsWith(`/tx/${id}/data`)?responseAt(url,body):responseAt(url,'missing',{status:404});
    };
    const failed=await provider.verify(id,largeExpected,confirmed);
    assert.equal(failed.confirmed,false,name);assert.equal(failed.verification.stage,'attention',name);
    assert.equal(failed.verification.reason,'archive_verification_failed',name);
    assert.equal(failed.verification.transactionConfirmed,true,name);
  }
  globalThis.fetch=async url=>url.endsWith(`/tx/${id}/data`)?responseAt(url,nodeData):responseAt(url,'missing',{status:404});
  const wrongVault=await provider.verify(id,{...largeExpected,vaultId:'b'.repeat(32)},confirmed);
  assert.equal(wrongVault.confirmed,false);assert.equal(wrongVault.verification.reason,'archive_verification_failed');

  let cancelledOversizeBodies=0;
  globalThis.fetch=async url=>{
    if(!url.endsWith(`/tx/${id}/data`))return responseAt(url,'missing',{status:404});
    return responseAt(url,new ReadableStream({
      start(controller){controller.enqueue(new Uint8Array(Math.ceil(largeBytes.length*4/3)+1).fill(65));},
      cancel(){cancelledOversizeBodies++;},
    }));
  };
  const oversized=await provider.verify(id,largeExpected,confirmed);
  assert.equal(oversized.confirmed,false);assert.equal(oversized.verification.reason,'archive_verification_failed');
  assert.equal(cancelledOversizeBodies,2,'both oversized node responses are cancelled at the encoded-byte limit');

  const nodeFallbackCalls=[];
  globalThis.fetch=async (url,options)=>{
    nodeFallbackCalls.push([url,options]);
    return url.endsWith(`/tx/${id}/data`)?responseAt(url,url.startsWith('https://arweave.net/')?'!':nodeData):responseAt(url,'missing',{status:404});
  };
  assert.equal((await provider.verify(id,largeExpected,confirmed)).confirmed,true);
  for(const host of ['https://arweave.net','https://g8way.io'])assert.ok(nodeFallbackCalls.some(([url])=>url===`${host}/tx/${id}/data`));

  for(const target of [`https://attacker.example/tx/${id}/data`,`https://arweave.net/tx/${'B'.repeat(43)}/data`]){
    const nodeRedirectCalls=[];
    globalThis.fetch=async (url,options)=>{
      nodeRedirectCalls.push(url);
      if(!url.endsWith(`/tx/${id}/data`))return responseAt(url,'missing',{status:404});
      assert.equal(options.redirect,'manual');
      return responseAt(target,nodeData);
    };
    const rejected=await provider.verify(id,largeExpected,confirmed);
    assert.equal(rejected.confirmed,false);assert.equal(nodeRedirectCalls.includes(target),false);
  }

  const sandbox=`https://${'a'.repeat(52)}.arweave.net/${id}`,redirectCalls=[];
  globalThis.fetch=async (url,options)=>{
    redirectCalls.push([url,options]);
    return url===sandbox?responseAt(url,encoded):responseAt(url,'',{status:302,headers:{Location:sandbox}});
  };
  assert.equal((await provider.verify(id,expected,confirmed)).confirmed,true);
  assert.ok(redirectCalls.some(([url])=>url===sandbox));
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
    assert.ok(timeoutCalls.length<=4);
  }finally{clearTimeout(hold);}
  // The added node-API body also observes the original shared deadline.
  let nodeTimeoutCalls=0;const nodeStarted=Date.now();
  globalThis.fetch=async (url,{signal})=>{
    if(!url.endsWith(`/tx/${id}/data`))return responseAt(url,'missing',{status:404});
    nodeTimeoutCalls++;
    return responseAt(url,new ReadableStream({start(controller){signal.addEventListener('abort',()=>controller.error(Error('synthetic node timeout')),{once:true});}}));
  };
  const nodeHold=setTimeout(()=>{},1000);
  try{
    const timedOut=await provider.verify(id,largeExpected,confirmed,Date.now()+30);
    assert.equal(timedOut.confirmed,false);assert.equal(timedOut.verification.reason,'archive_unavailable');
    assert.equal(timedOut.verification.transactionConfirmed,true);
    assert.ok(nodeTimeoutCalls>=1&&nodeTimeoutCalls<=2);assert.ok(Date.now()-nodeStarted<800);
  }finally{clearTimeout(nodeHold);}
  console.log('fund-provider: PASS; pending/confirmed distinction, bounded raw/canonical/node-data verification, strict base64url, trusted archive redirects, rejected node API redirects and shared check deadline; zero posts');
} finally { globalThis.fetch=originalFetch; }
