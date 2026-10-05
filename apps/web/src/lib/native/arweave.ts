import { pilotEnabled, assertPilotData } from './pilot';
import type Arweave from 'arweave';
import { resolveArweaveStatic } from '../arweave/client';
import type Transaction from 'arweave/web/lib/transaction';
import type { SerializedUploader } from 'arweave/web/lib/transaction-uploader';
import { endpoint, exactKeys } from './config';
import { canonical } from '../../../../../packages/protocol/wire';
import { envelopeDigest } from '../solana/policy';
import { MAX_BACKUP_BYTES } from '../crypto/envelope';
export type ArWallet = { connect(permissions:string[]):Promise<void>; getActiveAddress():Promise<string>; getActivePublicKey():Promise<string>; sign(tx:unknown,options?:unknown):Promise<unknown> };
export type ArPlan = { schema:'sejire/native-ar-plan/v1'; network:'arweave.N.1'; id:string; address:string; digest:string; bytes:number; rewardWinston:string; signedTx:ReturnType<Transaction['toJSON']>; progress?:SerializedUploader; uploaded:boolean };
export type ArQuote = { node:string; bytes:number; rewardWinston:string; balanceWinston:string; address:string; network:'arweave.N.1' };
export const winston = (s:string) => { if(typeof s!=='string'||!/^(0|[1-9]\d{0,29})$/.test(s))throw Error('invalid_winston');return BigInt(s); };
export function arClient(url:string) { const u=new URL(endpoint(url));return resolveArweaveStatic().init({host:u.hostname,port:u.port?Number(u.port):(u.protocol==='https:'?443:80),protocol:u.protocol.slice(0,-1),timeout:15000}); }
export async function arNode<T>(nodes:string[],action:(ar:Arweave,node:string)=>Promise<T>) {
 let last:unknown=Error('arweave_unavailable');
 for(const node of nodes)try{const ar=arClient(node),info=await ar.network.getInfo();if(info.network!=='arweave.N.1')throw Error('wrong_arweave_network');return await action(ar,node);}catch(e){last=e;}
 throw last;
}
export async function arQuote(nodes:string[],address:string,bytes:number):Promise<ArQuote> {
 if(!/^[A-Za-z0-9_-]{43}$/.test(address)||!Number.isSafeInteger(bytes)||bytes<1||bytes>MAX_BACKUP_BYTES)throw Error('invalid_ar_quote_request');
 return arNode(nodes,async(ar,node)=>{
 const [rewardWinston,balanceWinston]=await Promise.all([ar.transactions.getPrice(bytes),ar.wallets.getBalance(address)]);
 winston(rewardWinston);winston(balanceWinston);return {node,bytes,rewardWinston,balanceWinston,address,network:'arweave.N.1'};
 });
}
export async function validateArPlan(plan:ArPlan,data:string,tags:{name:string;value:string}[]) {
 if(plan.schema!=='sejire/native-ar-plan/v1'||plan.network!=='arweave.N.1'||plan.digest!==await envelopeDigest(data)||plan.bytes!==new TextEncoder().encode(data).length)throw Error('native_plan_binding');
 if(Object.keys(plan).some(k=>!['schema','network','id','address','digest','bytes','rewardWinston','signedTx','progress','uploaded'].includes(k)))throw Error('unexpected_plan_fields');
 const rawKeys=['format','id','last_tx','owner','tags','target','quantity','data','data_size','data_root','reward','signature'];
 exactKeys(plan.signedTx,'data_tree' in plan.signedTx?[...rawKeys,'data_tree']:rawKeys);
 const ar=arClient('https://arweave.net'); // crypto only; no request is made during verification
 const tx=ar.transactions.fromRaw(plan.signedTx);
 if(tx.format!==2||tx.target!==''||tx.quantity!=='0'||tx.id!==plan.id||tx.reward!==plan.rewardWinston||winston(tx.reward)<=0n||tx.data_size!==String(plan.bytes)||new TextDecoder().decode(tx.data)!==data)throw Error('native_transaction_binding');
 if(await ar.wallets.ownerToAddress(tx.owner)!==plan.address||!await ar.transactions.verify(tx))throw Error('native_transaction_signature');
 const expected = ar.transactions.fromRaw({...plan.signedTx,data_root:''});await expected.prepareChunks(tx.data);
 if(expected.data_root!==tx.data_root)throw Error('native_data_root');
 const actual=tx.tags.map(t=>({name:t.get('name',{decode:true,string:true}),value:t.get('value',{decode:true,string:true})}));
 if(canonical(actual)!==canonical(tags))throw Error('native_transaction_tags');
 if(plan.progress){
 const progress=ar.transactions.fromRaw(plan.progress.transaction);
 const {data:_a,...a}=JSON.parse(JSON.stringify(progress.toJSON())),{data:_b,...b}=JSON.parse(JSON.stringify(tx.toJSON()));
 if(canonical(a)!==canonical(b))throw Error('upload_progress_binding');
 }
 return tx;
}
/** Only wallet extension sees its key. This prepares a signature, NEVER submits the transaction. */
export async function signNative(nodes:string[],wallet:ArWallet,address:string,data:string,tags:{name:string;value:string}[],maximum:string,beforeSign?:()=>Promise<void>):Promise<ArPlan> {
 if(pilotEnabled()){await assertPilotData(address,data,maximum);if(tags.find(t=>t.name==='Type')?.value!=='vault-envelope')throw Error('archive_not_authorized_for_pilot');}
 if(await wallet.getActiveAddress()!==address)throw Error('wrong_ar_wallet');
 const bytes=new TextEncoder().encode(data),quote=await arQuote(nodes,address,bytes.length);
 if(winston(quote.rewardWinston)>winston(maximum)||winston(quote.balanceWinston)<winston(quote.rewardWinston))throw Error('insufficient_ar_or_reward_limit');
 return arNode([quote.node],async ar=>{
  const owner=await wallet.getActivePublicKey();if(await ar.wallets.ownerToAddress(owner)!==address)throw Error('wrong_ar_wallet');
  const tx=await ar.createTransaction({data:bytes,owner,reward:quote.rewardWinston});
  for(const tag of tags)tx.addTag(tag.name,tag.value);
  await beforeSign?.();
  const raw=await wallet.sign(tx,{name:'SEJIRE direct encrypted preservation'});
  const signed=ar.transactions.fromRaw(raw as ReturnType<Transaction['toJSON']>);
  if(signed.reward!==quote.rewardWinston)throw Error('wallet_changed_reward');
  const plan:ArPlan={schema:'sejire/native-ar-plan/v1',network:'arweave.N.1',id:signed.id,address,digest:await envelopeDigest(data),bytes:bytes.length,rewardWinston:signed.reward,signedTx:signed.toJSON(),uploaded:false};
  await validateArPlan(plan,data,tags);return plan;
 });
}
/** Caller MUST persist signedTx before this call. Resume sends the same signature/ID, no wallet required. */
export async function uploadNative(nodes:string[],plan:ArPlan,data:string,tags:{name:string;value:string}[],persist:(plan:ArPlan)=>Promise<void>,allowBroadcast:boolean) {
 if(pilotEnabled()){await assertPilotData(plan.address,data,plan.rewardWinston);if(tags.find(t=>t.name==='Type')?.value!=='vault-envelope')throw Error('archive_not_authorized_for_pilot');}
 else if(!allowBroadcast)throw Error('mainnet_broadcast_disabled_pending_owner_approval');
 await validateArPlan(plan,data,tags);
 return arNode(nodes,async ar=>{
  const tx=ar.transactions.fromRaw(plan.signedTx);
  const uploader=await ar.transactions.getUploader(plan.progress??tx,tx.data);
  // Persist intent and exact signed bytes BEFORE the first request. A timeout is not permission to re-sign.
  await persist(plan);
  while(!uploader.isComplete){try{await uploader.uploadChunk();}finally{plan.progress=uploader.toJSON();await persist(plan);}}
  plan.uploaded=true;await persist(plan);return plan;
 });
}
export async function boundedBytes(response:Response,max=MAX_BACKUP_BYTES):Promise<Uint8Array> {
 if(!response.ok||!response.body)throw Error('retrieval_unavailable');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>max){await reader.cancel();throw Error('archive_too_large');}chunks.push(chunk.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let pos=0;for(const chunk of chunks){bytes.set(chunk,pos);pos+=chunk.length;}return bytes;
}
export async function retrieveNative(nodes:string[],id:string,digest:string,bytes:number,transport:typeof fetch=fetch) {
 if(!/^[A-Za-z0-9_-]{43}$/.test(id)||!/^[a-f0-9]{64}$/.test(digest)||!Number.isSafeInteger(bytes)||bytes<1||bytes>MAX_BACKUP_BYTES)throw Error('invalid_archive_identity');
 let last:unknown=Error('retrieval_unavailable');
 for(const node of nodes)try{
  const response=await transport(endpoint(node)+'/'+id,{credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',signal:AbortSignal.timeout(15000)});
  const data=await boundedBytes(response,bytes);
  if(data.length!==bytes||await envelopeDigest(new TextDecoder('utf-8',{fatal:true}).decode(data))!==digest)throw Error('archive_hash_mismatch');
  return {node,bytes:data,text:new TextDecoder().decode(data)};
 }catch(e){last=e;}
 throw last;
}
export async function nativeStatus(nodes:string[],id:string) {
 if(!/^[A-Za-z0-9_-]{43}$/.test(id))throw Error('invalid_transaction_id');
 let best:{node:string;status:number;confirmed:{block_height:number;block_indep_hash:string;number_of_confirmations:number}|null}|undefined;let last:unknown;
 for(const node of nodes)try{const result=await arNode([node],async ar=>({node,...await ar.transactions.getStatus(id)}));if(result.status===200&&result.confirmed)return result;if(!best||result.status===202)best=result;}catch(e){last=e;}
 if(best)return best;throw last??Error('arweave_unavailable');
}
export async function discoverConfig(nodes:string[],id:string) {
 if(!/^[A-Za-z0-9_-]{43}$/.test(id))throw Error('invalid_configuration_id');
 return arNode(nodes,async(ar,node)=>{
 const response=await ar.api.get(id,{responseType:'arraybuffer'});
 if(response.status!==200||response.data.byteLength>MAX_BACKUP_BYTES)throw Error('configuration_unavailable');
 return {node,chain:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(response.data))};
 });
}
