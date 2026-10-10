/** SYNTHETIC LOCAL PILOT ONLY. Public software keys, fixture RPC and sandbox transport.
 * Never funded, deployed or presented as a live AO process. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import bs58 from 'bs58';
import { ProtocolExecutor, signingKey, testGenesis, type Export } from '../src/protocol/executor';
import { hash, genesisPayload } from '../src/protocol/journal';
import { SolanaRpcReader, DEVNET_GENESIS } from '../src/checkout/rpcReader';
import { fixtureTransaction, fixtureStatus, addr } from '../src/checkout/rpcFixtures';
import { TestnetPreservationService } from '../src/checkout/preservation';
export async function pilot(persist:(value:Export)=>Promise<void>=async()=>{}){
 const managers=[20,21,22].map(v=>signingKey(new Uint8Array(32).fill(v))),observers=[23,24].map(v=>signingKey(new Uint8Array(32).fill(v))),executors=[25,26].map(v=>signingKey(new Uint8Array(32).fill(v)));
 const codeHash=process.env.SEJIRE_PROTOCOL_CODE_HASH??createHash('sha256').update(readFileSync(new URL('../src/protocol/journal.ts',import.meta.url))).digest('hex');
 const genesis=testGenesis(codeHash,managers,observers,executors,addr(2),addr(3));
 const control={missing:false,stopBeforeUpload:false,retrievable:true,posts:0,items:new Map<string,Buffer>()};
 let engine:ProtocolExecutor;
 const reader=new SolanaRpcReader({network:'devnet'},async(_url,init)=>{
  const p=JSON.parse(init!.body as string);let result:unknown;
  if(p.method==='getGenesisHash')result=DEVNET_GENESIS;
  else if(p.method==='getSignatureStatuses')result=fixtureStatus();
  else if(p.method==='getTransaction'){
   const record=Object.values(engine.journal.state.orders).find(r=>r.pendingSignature===p.params[0]);
   if(!record)throw Error('unknown_fixture_signature');
   result=control.missing?null:fixtureTransaction(record.order,p.params[0]);
   if(result)(result as ReturnType<typeof fixtureTransaction>).blockTime=Math.ceil(record.order.createdAt/1000)+1;
  }else throw Error('unexpected_fixture_rpc');
  return Response.json({jsonrpc:'2.0',id:p.id,result});
 });
 const vector=Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a','hex');
 const uploader=new TestnetPreservationService({CHECKOUT_UPLOAD_ENABLED:'true',CHECKOUT_UPLOAD_SIGNER:bs58.encode(vector),MAX_ENVELOPE_BYTES:'524288'},async(url,init)=>{
  if(String(url).includes('/v1/account/free'))return Response.json({bytesRemaining:1000000});
  if(String(url).includes('/v1/tx')){
   if(control.stopBeforeUpload)throw Error('first_executor_stopped');
   const raw=Buffer.from(init!.body as Uint8Array);const id=createHash('sha256').update(raw.subarray(2,66)).digest('base64url');
   const {DataItem}=await import('@dha-team/arbundles/web');const item=new DataItem(raw);control.posts++;control.items.set(id,item.rawData);return Response.json({id,winc:'0'});
  }
  const bytes=control.items.get(String(url).split('/').at(-1)!);return !control.retrievable||!bytes?new Response('',{status:404}):new Response(bytes);
 });
 engine=new ProtocolExecutor(genesis,hash(genesisPayload(genesis)),managers,persist,reader,uploader,observers[0],executors[0]);
 return {engine,genesis,managers,observers,executors,control,reader,uploader,persist};
}
