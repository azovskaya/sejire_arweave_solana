import type { EnvelopeV1 } from '../crypto/encrypt';
import { serializeEnvelope } from '../crypto/envelope';
import { isStaticPermawebHost } from '../permawebHost';
import { envelopeDigest } from '../solana/policy';
import type { SolanaRecipientAdminView, SolanaRecipients } from '../../../../../packages/checkout/recipients';
export type FundOrderView={preservationId:string;orderId:string;promoRevision:number;archiveSizeBytes:number;archiveDigest:string;vaultId:string;parentTxId?:string|null;estimatedRewardWinston:string;reservedRewardWinston:string;actualRewardWinston:string|null;arweaveTxId:string|null;status:string;createdAt:number;uploadedAt:number|null;verifiedAt:number|null};
export type FundVerification={stage:'awaiting_confirmation'|'checking_archive'|'verified'|'attention';transactionConfirmed:boolean;confirmations:number|null;reason:'network_pending'|'network_unavailable'|'archive_unavailable'|'archive_verification_failed'|'reward_mismatch'|'transaction_mismatch'|null;checkedAt:number};
export type FundOrderResult={order:FundOrderView;verification?:FundVerification};
export class FundApiError extends Error {
  readonly status:number;
  constructor(message:string,status:number){super(message);this.name='FundApiError';this.status=status;}
}
export type FundDashboard={promo:{enabled:boolean;displayHint:string;revision:number;createdAt:number;updatedAt:number};treasuryAddress:string;signerVerified:boolean;limitWinston:string;actualSpentWinston:string;reservedWinston:string;budgetRemainingWinston:string;walletBalanceWinston:string|null;lastBalanceCheck:number|null;currentQuoteWinston:string|null;currentQuoteBytes:number;effectiveAvailableWinston:string|null;estimatedTreesRemaining:string|null;fundStatus:string;successfulTrees:number;today:number;last7Days:number;failedAttempts:number;pending:number;totalEncryptedBytes:number;averageArchiveBytes:number|null;largestArchiveBytes:number|null;smallestArchiveBytes:number|null;averageActualWinston:string|null;minActualWinston:string|null;maxActualWinston:string|null;latestActualWinston:string|null;currentRevisionTrees:number;currentRevisionSpentWinston:string;lastReconciliation:number|null;history:FundOrderView[]};
export function formatAr(value:string|null|undefined,places=6){if(value==null)return '—';const raw=BigInt(value),negative=raw<0n,n=negative?-raw:raw,whole=n/1000000000000n,frac=(n%1000000000000n).toString().padStart(12,'0');return `${negative?'-':''}${whole}.${frac.slice(0,places)}`;}
function configuredApiOrigin():string{
  const env=import.meta.env??{};
  const raw=env.VITE_FUND_API_URL||env.VITE_CHECKOUT_API_URL;
  if(raw)return raw;
  // Static ArNS hosts have no /api/* — never fall back to location.origin there.
  if(typeof location!=='undefined'&&isStaticPermawebHost(location.hostname))throw Error('fund_api_not_configured');
  return location.origin;
}
function endpoint(){const raw=configuredApiOrigin();const url=new URL(raw);
  if(url.origin!==raw||(url.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(url.hostname)))throw Error('invalid_fund_endpoint');return url.origin+'/api/fund';}
async function call<T>(path:string,method:'GET'|'POST'='GET',value?:unknown,adminPassword?:string,signal?:AbortSignal):Promise<T>{
  const controller=new AbortController();
  const cancel=()=>controller.abort();
  if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(cancel,30000);
  try{
    const r=await fetch(endpoint()+path,{method,credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',headers:{...(value===undefined?{}:{'Content-Type':'application/json'}),...(adminPassword?{Authorization:`Bearer ${adminPassword}`}:{})},...(value===undefined?{}:{body:JSON.stringify(value)}),signal:controller.signal,...(path.startsWith('/admin/')?{redirect:'error' as const}:{})});
    const data=await r.json() as {error?:string};
    if(!r.ok)throw new FundApiError(data.error||'fund_unavailable',r.status);
    return data as T;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
export const validatePromo=(code:string)=>call<{accepted:boolean}>('/validate','POST',{code});
export const publicFundBalance=()=>call<{treasuryAddress:string;walletBalanceWinston:string|null;lastBalanceCheck:number|null}>('/balance');
export const readFundOrder=(id:string,signal?:AbortSignal)=>call<FundOrderResult>(`/orders/${id}`,'GET',undefined,undefined,signal);
/** Historical GET responses omit the binding; every new POST must echo it exactly. */
export function assertFundOrderParent(order:Pick<FundOrderView,'parentTxId'>,parentTxId:string|null,required=false){
  if(!Object.hasOwn(order,'parentTxId')){if(required)throw Error('invalid_order_response');return;}
  if(order.parentTxId!==parentTxId)throw Error('invalid_order_response');
}
export async function preserveFunded(envelope:EnvelopeV1,code:string,orderId:string,parentTxId:string|null=null){
  if(parentTxId!==null&&(typeof parentTxId!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(parentTxId)))throw Error('invalid_saved_order');
  const archive=serializeEnvelope(envelope),result=await call<FundOrderResult>('/orders','POST',{orderId,preservationId:orderId,code,archive,parentTxId});
  if(!result.order)throw Error('invalid_order_response');assertFundOrderParent(result.order,parentTxId,true);return result;
}
export async function journalKey(envelope:EnvelopeV1){return `sejire-funded:${await envelopeDigest(serializeEnvelope(envelope))}`;}
export function checkedFundDashboard(value:unknown):FundDashboard{
  const data=value as FundDashboard;
  const money=(v:unknown)=>typeof v==='string'&&/^(0|[1-9][0-9]{0,29})$/.test(v);
  const count=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
  if(!data||typeof data!=='object'||!data.promo||typeof data.promo.enabled!=='boolean'||
    typeof data.promo.displayHint!=='string'||data.promo.displayHint.length>64||!count(data.promo.revision)||
    !count(data.promo.createdAt)||!count(data.promo.updatedAt)||
    typeof data.treasuryAddress!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.treasuryAddress)||
    typeof data.signerVerified!=='boolean'||!Array.isArray(data.history)||typeof data.fundStatus!=='string'||
    !/^[A-Z0-9_ -]{1,64}$/i.test(data.fundStatus)||
    !['limitWinston','actualSpentWinston','reservedWinston','budgetRemainingWinston','currentRevisionSpentWinston']
      .every(key=>money(data[key as keyof FundDashboard]))||
    !['walletBalanceWinston','currentQuoteWinston','effectiveAvailableWinston','averageActualWinston','minActualWinston','maxActualWinston','latestActualWinston']
      .every(key=>data[key as keyof FundDashboard]===null||money(data[key as keyof FundDashboard]))||
    !['successfulTrees','today','last7Days','failedAttempts','pending','totalEncryptedBytes','currentRevisionTrees','currentQuoteBytes']
      .every(key=>count(data[key as keyof FundDashboard]))||
    !['lastBalanceCheck','lastReconciliation','averageArchiveBytes','largestArchiveBytes','smallestArchiveBytes']
      .every(key=>data[key as keyof FundDashboard]===null||count(data[key as keyof FundDashboard]))||
    !(data.estimatedTreesRemaining===null||money(data.estimatedTreesRemaining))||
    !data.history.every(row=>row&&/^[a-f0-9]{32}$/.test(row.orderId)&&typeof row.status==='string'&&
      count(row.archiveSizeBytes)&&count(row.createdAt)&&count(row.promoRevision)&&
      (row.actualRewardWinston===null||money(row.actualRewardWinston))&&
      (row.arweaveTxId===null||typeof row.arweaveTxId==='string'&&/^[A-Za-z0-9_-]{43}$/.test(row.arweaveTxId))))throw Error('admin_response_invalid');
  return data;
}
export const fundDashboard=async(password:string,signal?:AbortSignal)=>checkedFundDashboard(await call<unknown>('/admin/dashboard','GET',undefined,password,signal));
export const fundChangePromo=(password:string,code:string,confirm:string,signal?:AbortSignal)=>call('/admin/promo','POST',{code,confirm},password,signal);
export const fundEnable=(password:string,enabled:boolean,signal?:AbortSignal)=>call('/admin/enabled','POST',{enabled},password,signal);
export const fundLimit=(password:string,limitAr:string,signal?:AbortSignal)=>call('/admin/limit','POST',{limitAr},password,signal);
export const fundReconcile=(password:string,signal?:AbortSignal)=>call('/admin/reconcile','POST',{},password,signal);
/** Protected admin paths only; credentials are sent solely in the Authorization header. */
export function fundAdminCall<T>(path:string,password:string,method:'GET'|'POST'='GET',value?:unknown,signal?:AbortSignal,query?:{limit:number;cursor:string|null}):Promise<T>{
  if(!/^\/admin\/[a-z0-9/-]+$/.test(path)||!password)throw Error('invalid_request');
  if(query){
    if(!['/admin/paid-orders','/admin/treasury-topups'].includes(path)||method!=='GET'||!Number.isSafeInteger(query.limit)||query.limit<1||query.limit>100||
      query.cursor!==null&&!/^[1-9][0-9]{0,14}$/.test(query.cursor))throw Error('invalid_admin_query');
    path+=`?limit=${query.limit}${query.cursor===null?'':`&cursor=${query.cursor}`}`;
  }
  return call<T>(path,method,value,password,signal);
}
export const solanaRecipientSettings=(password:string,signal?:AbortSignal)=>call<SolanaRecipientAdminView>('/admin/solana-recipients','GET',undefined,password,signal);
export const saveSolanaRecipients=(password:string,value:SolanaRecipients&{expectedRevision:number},signal?:AbortSignal)=>call<SolanaRecipientAdminView>('/admin/solana-recipients','POST',value,password,signal);
