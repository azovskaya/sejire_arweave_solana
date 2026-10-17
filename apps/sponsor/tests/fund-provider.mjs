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
  await assert.rejects(publicNetwork(),/wrong_arweave_network/);
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
  console.log('fund-provider: PASS; bounded global fetch, gateway fallback and strict validation; zero posts');
} finally { globalThis.fetch=originalFetch; }
