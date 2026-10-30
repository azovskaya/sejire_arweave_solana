import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startLinuxCheckout} from '../linux-server.mjs';
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
try{
  backend=await startLinuxCheckout({dbPath,bindings});
  const base=`http://127.0.0.1:${backend.address.port}/api/checkout`;
  const call=async(path,{method='GET',token,key,body}={})=>{
    const response=await originalFetch(base+path,{method,headers:{Origin:origin,
      ...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{}) ,
      ...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  };
  assert.equal((await call('/policy')).body.ready,false,'paid preservation remains disabled by default');
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
