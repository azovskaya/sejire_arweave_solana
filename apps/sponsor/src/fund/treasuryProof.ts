import {createArweaveWebClient} from './provider';
import {winston} from '../checkout/treasuryGuard';
import {canonical} from '../../../../packages/protocol/wire';
export const TOPUP_CONFIRMATIONS=12;
export type TreasuryBaseline={balanceWinston:string;height:number};
export type TreasuryTransferProof={txId:string;address:string;sender:string;amountWinston:string;blockHeight:number;blockHash:string;confirmations:number;intentNonce:string};
export interface TreasuryProofReader{
  baseline(address:string):Promise<TreasuryBaseline>;
  transfer(txId:string):Promise<TreasuryTransferProof>;
}
const gateways=['https://arweave.net','https://g8way.io'];
const txId=/^[A-Za-z0-9_-]{43}$/,blockHash=/^[A-Za-z0-9_-]{64}$/;
type NativeTransfer={raw:Record<string,unknown>;address:string;sender:string;amountWinston:string;intentNonce:string;txId:string|null;core:string;tags:{name:string;value:string}[]};
/** Both unsigned wallet approval and signed commit use the same native
 * contract. This verifies public values only and never signs or broadcasts. */
export async function checkedNativeTransfer(serialized:string,signed:boolean):Promise<NativeTransfer>{
  if(typeof serialized!=='string'||serialized.length>65536)throw Error('topup_transfer_invalid');
  let raw:any;try{raw=JSON.parse(serialized);}catch{throw Error('topup_transfer_invalid');}
  if(raw&&typeof raw==='object'&&raw.data===undefined)raw.data='';
  const allowed=['format','id','last_tx','owner','tags','target','quantity','data','data_size','data_root','reward','signature'];
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!allowed.includes(k))||raw.format!==2||
    !txId.test(raw.target)||typeof raw.owner!=='string'||!/^[A-Za-z0-9_-]{683}$/.test(raw.owner)||
    typeof raw.last_tx!=='string'||!/^(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9_-]{64})$/.test(raw.last_tx)||
    typeof raw.quantity!=='string'||!/^[1-9][0-9]{0,29}$/.test(raw.quantity)||
    typeof raw.reward!=='string'||!/^[1-9][0-9]{0,29}$/.test(raw.reward)||
    raw.data_size!=='0'||raw.data_root!==''||raw.data!==''||!Array.isArray(raw.tags)||raw.tags.length>16||
    (signed?typeof raw.id!=='string'||!txId.test(raw.id)||typeof raw.signature!=='string'||!/^[A-Za-z0-9_-]{683}$/.test(raw.signature):raw.id!==''||raw.signature!==''))throw Error('topup_transaction_mismatch');
  const ar=createArweaveWebClient();
  const tags=raw.tags.map((tag:{name:string;value:string})=>{
    if(!tag||Object.keys(tag).sort().join(',')!=='name,value'||typeof tag.name!=='string'||typeof tag.value!=='string'||tag.name.length>128||tag.value.length>1024)throw Error('topup_transfer_invalid');
    return {name:ar.utils.b64UrlToString(tag.name) as string,value:ar.utils.b64UrlToString(tag.value) as string};
  });
  if(new Set(tags.map((t:{name:string})=>t.name)).size!==tags.length)throw Error('topup_intent_mismatch');
  const intentTags=tags.filter((tag:{name:string})=>tag.name==='SEJIRE-Topup-Intent');
  if(intentTags.length!==1||!/^[a-f0-9]{64}$/.test(intentTags[0].value))throw Error('topup_intent_mismatch');
  if(signed&&!await ar.transactions.verify(ar.transactions.fromRaw(raw)))throw Error('topup_transaction_mismatch');
  const sender=await ar.wallets.ownerToAddress(raw.owner);if(sender===raw.target)throw Error('topup_transaction_mismatch');
  const {id:ignoredId,signature:ignoredSignature,tags:ignoredTags,...core}=raw;
  return {raw,address:raw.target,sender,amountWinston:raw.quantity,intentNonce:intentTags[0].value,txId:signed?raw.id:null,core:canonical(core),tags};
}
export function assertSameNativeTransfer(unsigned:NativeTransfer,signed:NativeTransfer):void{
  if(unsigned.core!==signed.core)throw Error('topup_transfer_conflict');
  const expected=new Map(unsigned.tags.map(tag=>[tag.name,tag.value]));
  for(const tag of signed.tags){
    if(expected.has(tag.name)){if(expected.get(tag.name)!==tag.value)throw Error('topup_transfer_conflict');expected.delete(tag.name);}
    else if(!['Signing-Client','Signing-Client-Version'].includes(tag.name)||tag.value.length>64||!tag.value)throw Error('topup_transfer_conflict');
  }
  if(expected.size)throw Error('topup_transfer_conflict');
}
async function read(host:string,path:string,deadline:number,max:number):Promise<string>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([(async()=>{
    const response=await fetch(host+path,{redirect:'manual',signal:controller.signal});
    if(response.status!==200||response.url&&response.url!==host+path){await response.body?.cancel();throw Error('topup_proof_unavailable');}
    if(!response.body)throw Error('topup_proof_unavailable');
    const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
    try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;
      if(size>max){await reader.cancel();throw Error('topup_proof_unavailable');}chunks.push(part.value);}}
    finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes).trim();
  })(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('topup_proof_unavailable'));},Math.max(1,Math.min(8000,deadline-Date.now())));})]);}
  finally{if(timer)clearTimeout(timer);controller.abort();}
}
/** Read-only native AR proof, independent of the server's signing key. Two
 * configured public nodes must agree. No admin input selects a network URL. */
export class DirectTreasuryProofReader implements TreasuryProofReader{
  async baseline(address:string):Promise<TreasuryBaseline>{
    if(!txId.test(address))throw Error('invalid_topup_request');
    const deadline=Date.now()+22000;
    const results=await Promise.all(gateways.map(async host=>{
      // These remain conservative observations, not a coherent block snapshot.
      // A nonce generated AFTER pinning this baseline binds a future incoming
      // transfer even if both nodes' /info caches lag their wallet balances.
      const balance=await read(host,`/wallet/${address}/balance`,deadline,64);winston(balance);
      const info=JSON.parse(await read(host,'/info',deadline,16384));
      if(info.network!=='arweave.N.1'||!Number.isSafeInteger(info.height)||info.height<0)throw Error('topup_proof_unavailable');
      return {balanceWinston:balance,height:info.height as number};
    }));
    return {balanceWinston:results.reduce((a,b)=>winston(a.balanceWinston)<winston(b.balanceWinston)?a:b).balanceWinston,
      height:Math.max(...results.map(r=>r.height))};
  }
  async transfer(id:string):Promise<TreasuryTransferProof>{
    if(!txId.test(id))throw Error('invalid_topup_request');
    const deadline=Date.now()+22000;
    const results=await Promise.all(gateways.map(async host=>{
      const [rawText,statusText]=await Promise.all([read(host,`/tx/${id}`,deadline,65536),read(host,`/tx/${id}/status`,deadline,4096)]);
      const status=JSON.parse(statusText);
      if(!Number.isSafeInteger(status.block_height)||!blockHash.test(status.block_indep_hash)||
        !Number.isSafeInteger(status.number_of_confirmations)||status.number_of_confirmations<TOPUP_CONFIRMATIONS)throw Error('topup_not_confirmed');
      const value=await checkedNativeTransfer(rawText,true);if(value.txId!==id)throw Error('topup_transaction_mismatch');
      return {txId:id,address:value.address,sender:value.sender,amountWinston:value.amountWinston,blockHeight:status.block_height,
        blockHash:status.block_indep_hash,confirmations:status.number_of_confirmations,intentNonce:value.intentNonce} as TreasuryTransferProof;
    }));
    const [a,b]=results;
    if(['address','sender','amountWinston','blockHeight','blockHash','intentNonce'].some(k=>a[k as keyof TreasuryTransferProof]!==b[k as keyof TreasuryTransferProof]))throw Error('topup_proof_unavailable');
    return {...a,confirmations:Math.min(a.confirmations,b.confirmations)};
  }
}
