import * as ArweaveWebModule from 'arweave/web/index.js';
import { parseEnvelope } from '../../../web/src/lib/crypto/envelope';
import { TREASURY_ADDRESS } from './ledger';
export type PreparedFundTx = { raw:string; reward:string };
export type FundNetworkTx = {confirmed:boolean; reward:string|null};
export interface FundedArweaveProvider {
  getSignerAddress():Promise<string>;
  getBalance():Promise<string>;
  getPrice(bytes:number):Promise<string>;
  prepareTransaction(bytes:Uint8Array,tags:{name:string;value:string}[]):Promise<PreparedFundTx>;
  sign(prepared:PreparedFundTx):Promise<{id:string;raw:string;reward:string}>;
  submit(raw:string):Promise<void>;
  getTransaction(id:string):Promise<FundNetworkTx>;
  getRawData(id:string):Promise<Uint8Array|null>;
  verify(id:string,expected:{digest:string;bytes:number;vaultId:string}):Promise<{confirmed:boolean;reward:string|null}>;
}
function arweaveRuntime(){
  let value:unknown=ArweaveWebModule;
  for(let i=0;i<4;i++){
    const container=value&&(typeof value==='object'||typeof value==='function');
    if(container&&typeof (value as {init?:unknown}).init==='function')return value as {init:(config:Record<string,unknown>)=>any};
    const next=container?(value as {default?:unknown}).default:undefined;
    if(next===undefined||next===value)break;value=next;
  }
  throw Error('arweave_web_init_unavailable');
}
const client=()=>arweaveRuntime().init({host:'arweave.net',port:443,protocol:'https',timeout:15000});
const txId=/^[A-Za-z0-9_-]{43}$/;
// /tx_anchor may return either a transaction id (32-byte SHA-256 => 43 chars)
// or a recent block independent hash (48-byte SHA-384 => 64 chars).
const anchorId=/^(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9_-]{64})$/;
const gateways=['https://arweave.net','https://ar-io.dev'] as const;
const amount=(v:string)=>{if(!/^[1-9][0-9]{0,29}$/.test(v))throw Error('invalid_reward');return BigInt(v);};
function b64UrlBytes(value:string){
  if(!/^[A-Za-z0-9_-]+$/.test(value))throw Error('invalid_jwk_modulus');
  const padded=value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4);
  const raw=atob(padded),out=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);
  return out;
}
function b64Url(bytes:Uint8Array){
  let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function addressFromModulus(n:string){
  return b64Url(new Uint8Array(await crypto.subtle.digest('SHA-256',b64UrlBytes(n))));
}
async function boundedText(response:Response,max:number):Promise<string>{
  if(!response.ok||!response.body)throw Error('gateway_unavailable');
  const reader=response.body.getReader();let size=0;const parts:Uint8Array[]=[];
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
    if(size>max){await reader.cancel();throw Error('gateway_response_too_large');}parts.push(part.value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes).trim();
}
export async function publicNetwork():Promise<void>{
  for(const host of gateways)try{
    const response=await fetch(`${host}/info`,{redirect:'error',signal:AbortSignal.timeout(10000)});
    const info=JSON.parse(await boundedText(response,4096)) as {network?:unknown};
    if(info.network!=='arweave.N.1')throw Error('wrong_arweave_network');return;
  }catch(error){if(error instanceof Error&&error.message==='wrong_arweave_network')throw error;}
  throw Error('network_unavailable');
}
export async function publicAnchor():Promise<string>{
  for(const host of gateways)try{
    const response=await fetch(`${host}/tx_anchor`,{redirect:'error',signal:AbortSignal.timeout(10000)});
    const anchor=await boundedText(response,128);if(anchorId.test(anchor))return anchor;
  }catch{ /* try trusted fallback */ }
  throw Error('anchor_unavailable');
}
async function digest(bytes:Uint8Array){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');}
async function boundedRaw(id:string,max:number):Promise<Uint8Array|null>{
  for(const host of ['https://arweave.net','https://ar-io.dev']){
    try{const r=await fetch(`${host}/raw/${id}`,{redirect:'error',signal:AbortSignal.timeout(15000)});if(r.status===404||r.status===202)continue;if(!r.ok||!r.body)continue;
      const reader=r.body.getReader(),parts:Uint8Array[]=[];let length=0;
      try{for(;;){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.length;if(length>max){await reader.cancel();throw Error('retrieved_archive_too_large');}parts.push(chunk.value);}}finally{reader.releaseLock();}
      const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
    }catch(e){if(e instanceof Error&&e.message==='retrieved_archive_too_large')throw e;}
  }return null;
}
export async function publicBalance():Promise<string>{
  for(const host of ['https://arweave.net','https://ar-io.dev'])try{
    const r=await fetch(`${host}/wallet/${TREASURY_ADDRESS}/balance`,{signal:AbortSignal.timeout(10000)});
    if(r.ok){const value=(await r.text()).trim();if(/^(0|[1-9][0-9]*)$/.test(value))return value;}
  }catch{ /* try fallback */ }
  throw Error('balance_unavailable');
}
export async function publicPrice(bytes:number):Promise<string>{
  if(!Number.isSafeInteger(bytes)||bytes<=0||bytes>524288)throw Error('price_unavailable');
  for(const host of ['https://arweave.net','https://ar-io.dev'])try{
    const r=await fetch(`${host}/price/${bytes}`,{signal:AbortSignal.timeout(10000)});
    if(r.ok){const value=(await r.text()).trim();amount(value);return value;}
  }catch{ /* try fallback */ }
  throw Error('price_unavailable');
}
export class DirectArweaveFundProvider implements FundedArweaveProvider {
  private jwk:Record<string,string>;
  constructor(secret:string|undefined){if(!secret)throw Error('fund_provider_unavailable');try{this.jwk=JSON.parse(secret) as Record<string,string>;}catch{throw Error('fund_provider_unavailable');}
    if(this.jwk.kty!=='RSA'||typeof this.jwk.n!=='string'||typeof this.jwk.d!=='string')throw Error('fund_provider_unavailable');}
  async getSignerAddress(){return addressFromModulus(this.jwk.n);}
  async assertSigner(){if(await this.getSignerAddress()!==TREASURY_ADDRESS)throw Error('treasury_address_mismatch');}
  getBalance(){return publicBalance();}
  getPrice(bytes:number){return publicPrice(bytes);}
  async prepareTransaction(bytes:Uint8Array,tags:{name:string;value:string}[]){
    let stage='signer';
    try{
      await this.assertSigner();
      stage='client'; const ar=client();
      stage='price'; const quote=await this.getPrice(bytes.length); amount(quote);
      stage='network'; await publicNetwork();
      stage='anchor'; const anchor=await publicAnchor();
      stage='create'; const tx=await ar.createTransaction({data:bytes,owner:this.jwk.n,reward:quote,last_tx:anchor},this.jwk as never);
      stage='tags'; for(const tag of tags)tx.addTag(tag.name,tag.value);
      stage='reward'; const reward=tx.reward; amount(reward);
      stage='serialize'; const raw=JSON.stringify(tx.toJSON());
      return {raw,reward};
    }catch(error){
      if(error instanceof Error&&error.message==='treasury_address_mismatch')throw error;
      throw Error('fund_prepare_'+stage+'_failed');
    }
  }
  async sign(prepared:PreparedFundTx){await this.assertSigner();const ar=client(),tx=ar.transactions.fromRaw(JSON.parse(prepared.raw));
    if(tx.reward!==prepared.reward||tx.quantity!=='0'||tx.target!==''||await ar.wallets.ownerToAddress(tx.owner)!==TREASURY_ADDRESS)throw Error('prepared_tx_mismatch');
    await ar.transactions.sign(tx,this.jwk as never);if(!tx.id||!txId.test(tx.id)||!await ar.transactions.verify(tx))throw Error('signed_tx_invalid');
    return {id:tx.id,raw:JSON.stringify(tx.toJSON()),reward:tx.reward};}
  async submit(raw:string){const ar=client(),tx=ar.transactions.fromRaw(JSON.parse(raw));if(!tx.id||!await ar.transactions.verify(tx))throw Error('signed_tx_invalid');
    const r=await ar.transactions.post(tx);if(r.status!==200&&r.status!==202&&r.status!==208)throw Error('submit_uncertain');}
  async getTransaction(id:string):Promise<FundNetworkTx>{if(!txId.test(id))throw Error('invalid_tx_id');const ar=client();const status=await ar.transactions.getStatus(id);
    if(status.status===404)return {confirmed:false,reward:null};if(status.status!==200)throw Error('transaction_unavailable');
    const response=await fetch(`https://arweave.net/tx/${id}`,{signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('transaction_unavailable');
    const tx=await response.json() as {id:string;owner:string;reward:string};
    if(tx.id!==id||await ar.wallets.ownerToAddress(tx.owner)!==TREASURY_ADDRESS)throw Error('transaction_mismatch');amount(tx.reward);
    return {confirmed:Boolean(status.confirmed&&status.confirmed.number_of_confirmations>=1),reward:tx.reward};}
  getRawData(id:string){if(!txId.test(id))throw Error('invalid_tx_id');return boundedRaw(id,524288);}
  async verify(id:string,expected:{digest:string;bytes:number;vaultId:string}){const tx=await this.getTransaction(id);if(!tx.confirmed)return tx;
    const bytes=await this.getRawData(id);if(!bytes)return {confirmed:false,reward:tx.reward};
    if(bytes.length!==expected.bytes||await digest(bytes)!==expected.digest)throw Error('archive_integrity_failed');
    const parsed=parseEnvelope(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes)));
    if(parsed.vault_id!==expected.vaultId)throw Error('vault_integrity_failed');return tx;}
}
export class MockFundedArweaveProvider implements FundedArweaveProvider {
  balance='68000000000000';price='3000000000';estimate='3000000000';actual='3000000000';failure='';delay=false; submissions=0;signerAddress=TREASURY_ADDRESS;
  private transactions=new Map<string,{raw:string;data:Uint8Array;accepted:boolean}>();
  async getSignerAddress(){return this.signerAddress;}
  async getBalance(){if(this.failure==='balance')throw Error('balance_unavailable');return this.balance;}
  async getPrice(_bytes:number){if(this.failure==='price')throw Error('price_unavailable');return this.estimate;}
  async prepareTransaction(bytes:Uint8Array,tags:{name:string;value:string}[]){return {raw:JSON.stringify({data:Array.from(bytes),tags}),reward:this.price};}
  async sign(prepared:PreparedFundTx){const raw=prepared.raw;const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)));
    const id=btoa(String.fromCharCode(...hash)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');this.transactions.set(id,{raw,data:new Uint8Array(JSON.parse(raw).data),accepted:false});return {id,raw,reward:prepared.reward};}
  async submit(raw:string){this.submissions++;if(this.failure==='upload')throw Error('submit_uncertain');
    const transaction=[...this.transactions.values()].find(x=>x.raw===raw);if(!transaction)throw Error('signed_tx_missing');transaction.accepted=true;
    if(this.failure==='lost_response')throw Error('submit_uncertain');}
  async getTransaction(id:string){const transaction=this.transactions.get(id);if(!transaction?.accepted)return {confirmed:false,reward:null};return {confirmed:!this.delay,reward:this.actual};}
  async getRawData(id:string){if(this.failure==='verification')throw Error('archive_integrity_failed');return this.delay?null:this.transactions.get(id)?.data??null;}
  async verify(id:string,expected:{digest:string;bytes:number;vaultId:string}){const tx=await this.getTransaction(id);if(!tx.confirmed)return tx;const bytes=await this.getRawData(id);if(!bytes)return {confirmed:false,reward:tx.reward};if(bytes.length!==expected.bytes||await digest(bytes)!==expected.digest)throw Error('archive_integrity_failed');
    if(parseEnvelope(JSON.parse(new TextDecoder().decode(bytes))).vault_id!==expected.vaultId)throw Error('vault_integrity_failed');return tx;}
}
