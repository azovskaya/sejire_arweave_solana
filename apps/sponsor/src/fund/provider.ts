import * as ArweaveWebModule from 'arweave/web/index.js';
import { parseEnvelope } from '../../../web/src/lib/crypto/envelope';
import { TREASURY_ADDRESS } from './ledger';
export type PreparedFundTx = { raw:string; reward:string };
export type FundNetworkTx = {state:'not_found'|'pending'|'confirmed';confirmed:boolean;reward:string|null;confirmations:number|null};
export type FundArchiveExpected = {digest:string;bytes:number;vaultId:string};
export type FundVerification = {
  stage:'awaiting_confirmation'|'checking_archive'|'verified'|'attention';
  transactionConfirmed:boolean;
  confirmations:number|null;
  reason:'network_pending'|'network_unavailable'|'archive_unavailable'|'archive_verification_failed'|'reward_mismatch'|'transaction_mismatch'|null;
  checkedAt:number;
};
export type FundCheckResult = {confirmed:boolean;reward:string|null;verification:FundVerification};
// One verification pass, including all fallback requests and response bodies,
// must leave room for the ledger response inside the browser's 30 second wait.
export const FUND_CHECK_TIMEOUT_MS = 22_000;
const CHECK_REQUEST_TIMEOUT_MS = 4_000;
export interface FundedArweaveProvider {
  getSignerAddress():Promise<string>;
  getBalance():Promise<string>;
  getPrice(bytes:number):Promise<string>;
  prepareTransaction(bytes:Uint8Array,tags:{name:string;value:string}[]):Promise<PreparedFundTx>;
  sign(prepared:PreparedFundTx):Promise<{id:string;raw:string;reward:string}>;
  submit(raw:string):Promise<void>;
  getTransaction(id:string,deadline?:number):Promise<FundNetworkTx>;
  getRawData(id:string,expected?:FundArchiveExpected,deadline?:number):Promise<Uint8Array|null>;
  verify(id:string,expected:FundArchiveExpected,transaction?:FundNetworkTx,deadline?:number):Promise<FundCheckResult>;
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
const gateways=['https://arweave.net','https://g8way.io'] as const;
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
    const response=await fetch(`${host}/info`,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000)});
    if(new URL(response.url).origin!==host)throw Error('gateway_redirected');
    const info=JSON.parse(await boundedText(response,16384)) as {network?:unknown};
    if(info.network==='arweave.N.1')return;
  }catch{ /* try trusted mainnet fallback */ }
  throw Error('network_unavailable');
}
export async function publicAnchor():Promise<string>{
  for(const host of gateways)try{
    const response=await fetch(`${host}/tx_anchor`,{signal:AbortSignal.timeout(10000)});
    if(new URL(response.url).origin!==host)throw Error('gateway_redirected');
    const anchor=await boundedText(response,128);if(anchorId.test(anchor))return anchor;
  }catch{ /* try trusted mainnet fallback */ }
  throw Error('anchor_unavailable');
}
async function digest(bytes:Uint8Array){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');}
function checkSignal(deadline:number){
  const remaining=deadline-Date.now();
  if(remaining<=0)throw Error('transaction_unavailable');
  return AbortSignal.timeout(Math.min(CHECK_REQUEST_TIMEOUT_MS,remaining));
}
async function discard(response:Response){try{await response.body?.cancel();}catch{ /* response already closed */ }}
async function boundedBytes(response:Response,max:number){
  if(!response.ok||!response.body)throw Error('gateway_unavailable');
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let length=0;
  try{for(;;){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.length;
    if(length>max){await reader.cancel();throw Error('retrieved_archive_too_large');}parts.push(chunk.value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
}
async function archiveMatches(bytes:Uint8Array,expected?:FundArchiveExpected){
  if(expected&&(bytes.length!==expected.bytes||await digest(bytes)!==expected.digest))return false;
  try{const envelope=parseEnvelope(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes)));
    return !expected||envelope.vault_id===expected.vaultId;
  }catch{return false;}
}
// Arweave's isolated data host is the lower-case base32 encoding of this TX ID.
// A gateway may redirect only to the exact TX's host/path, never an arbitrary URL.
function sandboxLabel(id:string){
  const alphabet='abcdefghijklmnopqrstuvwxyz234567';let value=0,bits=0,label='';
  for(const byte of b64UrlBytes(id)){value=(value<<8)|byte;bits+=8;
    while(bits>=5){bits-=5;label+=alphabet[(value>>>bits)&31];}value&=(1<<bits)-1;}
  if(bits)label+=alphabet[(value<<(5-bits))&31];return label;
}
function trustedArchiveUrl(url:URL,host:string,id:string){
  const base=new URL(host),isolated=`${sandboxLabel(id)}.${base.hostname}`;
  return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&
    (url.hostname===base.hostname||url.hostname===isolated)&&
    (url.pathname===`/raw/${id}`||url.pathname===`/${id}`);
}
async function archiveResponse(host:string,path:string,id:string,deadline:number){
  const signal=checkSignal(deadline);let url=new URL(path,host);
  const visited=new Set<string>();
  for(let redirects=0;redirects<=2;redirects++){
    if(!trustedArchiveUrl(url,host,id)||visited.has(url.href))throw Error('gateway_redirected');
    visited.add(url.href);
    // Fresh Worker requests carry no browser cookies or incoming Admin headers.
    const response=await fetch(url.href,{redirect:'manual',signal});
    if(response.url&&!trustedArchiveUrl(new URL(response.url),host,id)){await discard(response);throw Error('gateway_redirected');}
    if(![301,302,303,307,308].includes(response.status))return response;
    const location=response.headers.get('Location');await discard(response);
    if(!location||location.length>2048)throw Error('gateway_redirected');
    url=new URL(location,url);
  }
  throw Error('gateway_redirected');
}
async function boundedRaw(id:string,max:number,expected:FundArchiveExpected|undefined,deadline:number):Promise<Uint8Array|null>{
  let mismatch=false;
  // Keep /raw as the preferred exact-byte path. Canonical data URLs are fallback
  // candidates and receive the very same size, digest and envelope checks.
  for(const path of [`/raw/${id}`,`/${id}`])for(const host of gateways){
    if(Date.now()>=deadline)break;
    try{
      const response=await archiveResponse(host,path,id,deadline);
      if(response.status===202||!response.ok||!response.body){await discard(response);continue;}
      const bytes=await boundedBytes(response,Math.min(max,expected?.bytes??max));
      if(await archiveMatches(bytes,expected))return bytes;
      mismatch=true;
    }catch(error){if(error instanceof Error&&error.message==='retrieved_archive_too_large')mismatch=true;}
  }
  if(mismatch)throw Error('archive_integrity_failed');
  return null;
}
function observation(transaction:FundNetworkTx,stage:FundVerification['stage'],reason:FundVerification['reason']):FundVerification{
  return {stage,transactionConfirmed:transaction.confirmed,confirmations:transaction.confirmations,reason,checkedAt:Date.now()};
}
async function verifyArchive(provider:FundedArweaveProvider,id:string,expected:FundArchiveExpected,transaction:FundNetworkTx,deadline:number):Promise<FundCheckResult>{
  if(!transaction.confirmed)return {confirmed:false,reward:transaction.reward,verification:observation(transaction,'awaiting_confirmation','network_pending')};
  try{
    const bytes=await provider.getRawData(id,expected,deadline);
    if(!bytes)return {confirmed:false,reward:transaction.reward,verification:observation(transaction,'checking_archive','archive_unavailable')};
    if(!await archiveMatches(bytes,expected))throw Error('archive_integrity_failed');
    return {confirmed:true,reward:transaction.reward,verification:observation(transaction,'verified',null)};
  }catch(error){
    const mismatch=error instanceof Error&&['archive_integrity_failed','vault_integrity_failed'].includes(error.message);
    return {confirmed:false,reward:transaction.reward,verification:observation(transaction,mismatch?'attention':'checking_archive',mismatch?'archive_verification_failed':'archive_unavailable')};
  }
}
export async function publicBalance():Promise<string>{
  for(const host of gateways)try{
    const r=await fetch(`${host}/wallet/${TREASURY_ADDRESS}/balance`,{signal:AbortSignal.timeout(10000)});
    if(r.ok){const value=(await r.text()).trim();if(/^(0|[1-9][0-9]*)$/.test(value))return value;}
  }catch{ /* try fallback */ }
  throw Error('balance_unavailable');
}
export async function publicPrice(bytes:number):Promise<string>{
  if(!Number.isSafeInteger(bytes)||bytes<=0||bytes>524288)throw Error('price_unavailable');
  for(const host of gateways)try{
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
  async getTransaction(id:string,deadline=Date.now()+FUND_CHECK_TIMEOUT_MS):Promise<FundNetworkTx>{
    if(!txId.test(id))throw Error('invalid_tx_id');
    let missing=0,mismatch=false;
    for(const host of gateways){
      if(Date.now()>=deadline)break;
      try{
        const statusUrl=`${host}/tx/${id}/status`;
        const response=await fetch(statusUrl,{redirect:'error',signal:checkSignal(deadline)});
        if(response.url&&response.url!==statusUrl){await discard(response);throw Error('transaction_unavailable');}
        if(response.status===404){missing++;await discard(response);continue;}
        if(response.status===202){await discard(response);return {state:'pending',confirmed:false,reward:null,confirmations:0};}
        if(response.status!==200){await discard(response);continue;}
        const status=JSON.parse(await boundedText(response,16384)) as {number_of_confirmations?:unknown}|null;
        const confirmations=status?.number_of_confirmations;
        if(typeof confirmations!=='number'||!Number.isSafeInteger(confirmations)||confirmations<0)continue;
        const metadataUrl=`${host}/tx/${id}`;
        const metadata=await fetch(metadataUrl,{redirect:'error',signal:checkSignal(deadline)});
        if(metadata.url&&metadata.url!==metadataUrl){await discard(metadata);throw Error('transaction_unavailable');}
        const tx=JSON.parse(await boundedText(metadata,65536)) as {id?:unknown;owner?:unknown;reward?:unknown}|null;
        if(!tx||tx.id!==id||typeof tx.owner!=='string'||typeof tx.reward!=='string')throw Error('transaction_mismatch');
        try{amount(tx.reward);if(await addressFromModulus(tx.owner)!==TREASURY_ADDRESS)throw Error('transaction_mismatch');}
        catch{throw Error('transaction_mismatch');}
        return {state:confirmations>=1?'confirmed':'pending',confirmed:confirmations>=1,reward:tx.reward,confirmations};
      }catch(error){if(error instanceof Error&&error.message==='transaction_mismatch')mismatch=true;}
    }
    // One missing index and one broken gateway do not establish absence.
    if(missing===gateways.length)return {state:'not_found',confirmed:false,reward:null,confirmations:null};
    throw Error(mismatch?'transaction_mismatch':'transaction_unavailable');
  }
  getRawData(id:string,expected?:FundArchiveExpected,deadline=Date.now()+FUND_CHECK_TIMEOUT_MS){
    if(!txId.test(id))throw Error('invalid_tx_id');
    return boundedRaw(id,524288,expected,deadline);
  }
  async verify(id:string,expected:FundArchiveExpected,transaction?:FundNetworkTx,deadline=Date.now()+FUND_CHECK_TIMEOUT_MS){
    return verifyArchive(this,id,expected,transaction??await this.getTransaction(id,deadline),deadline);
  }
}
export class MockFundedArweaveProvider implements FundedArweaveProvider {
  balance='68000000000000';price='3000000000';estimate='3000000000';actual='3000000000';failure='';delay=false;submissions=0;signings=0;signerAddress=TREASURY_ADDRESS;
  private transactions=new Map<string,{raw:string;data:Uint8Array;accepted:boolean}>();
  async getSignerAddress(){return this.signerAddress;}
  async getBalance(){if(this.failure==='balance')throw Error('balance_unavailable');return this.balance;}
  async getPrice(_bytes:number){if(this.failure==='price')throw Error('price_unavailable');return this.estimate;}
  async prepareTransaction(bytes:Uint8Array,tags:{name:string;value:string}[]){return {raw:JSON.stringify({data:Array.from(bytes),tags}),reward:this.price};}
  async sign(prepared:PreparedFundTx){this.signings++;const raw=prepared.raw;const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)));
    const id=btoa(String.fromCharCode(...hash)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');this.transactions.set(id,{raw,data:new Uint8Array(JSON.parse(raw).data),accepted:false});return {id,raw,reward:prepared.reward};}
  async submit(raw:string){this.submissions++;if(this.failure==='upload')throw Error('submit_uncertain');
    const transaction=[...this.transactions.values()].find(x=>x.raw===raw);if(!transaction)throw Error('signed_tx_missing');transaction.accepted=true;
    if(this.failure==='lost_response')throw Error('submit_uncertain');}
  async getTransaction(id:string):Promise<FundNetworkTx>{
    if(this.failure==='network')throw Error('synthetic gateway failure');
    const transaction=this.transactions.get(id);
    if(!transaction?.accepted)return {state:'not_found',confirmed:false,reward:null,confirmations:null};
    return {state:this.delay?'pending':'confirmed',confirmed:!this.delay,reward:this.actual,confirmations:this.delay?0:1};
  }
  async getRawData(id:string,expected?:FundArchiveExpected){
    if(this.failure==='verification')throw Error('archive_integrity_failed');
    if(this.failure==='archive_unavailable'||this.delay)return null;
    const bytes=this.transactions.get(id)?.data??null;
    if(bytes&&!await archiveMatches(bytes,expected))throw Error('archive_integrity_failed');return bytes;
  }
  async verify(id:string,expected:FundArchiveExpected,transaction?:FundNetworkTx,deadline=Date.now()+FUND_CHECK_TIMEOUT_MS){
    return verifyArchive(this,id,expected,transaction??await this.getTransaction(id),deadline);
  }
}
