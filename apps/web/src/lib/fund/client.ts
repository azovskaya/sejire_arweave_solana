import type { EnvelopeV1 } from '../crypto/encrypt';
import { serializeEnvelope } from '../crypto/envelope';
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
function endpoint(){const raw=import.meta.env.VITE_FUND_API_URL||import.meta.env.VITE_CHECKOUT_API_URL||location.origin;const url=new URL(raw);
  if(url.origin!==raw||(url.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(url.hostname)))throw Error('invalid_fund_endpoint');return url.origin+'/api/fund';}
async function call<T>(path:string,method:'GET'|'POST'='GET',value?:unknown,adminPassword?:string,signal?:AbortSignal):Promise<T>{
  const controller=new AbortController();
  const cancel=()=>controller.abort();
  if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(cancel,30000);
  try{
    const r=await fetch(endpoint()+path,{method,credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',headers:{...(value===undefined?{}:{'Content-Type':'application/json'}),...(adminPassword?{Authorization:`Bearer ${adminPassword}`}:{})},...(value===undefined?{}:{body:JSON.stringify(value)}),signal:controller.signal,...(path==='/admin/solana-recipients'?{redirect:'error' as const}:{})});
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
export const fundDashboard=(password:string)=>call<FundDashboard>('/admin/dashboard','GET',undefined,password);
export const fundChangePromo=(password:string,code:string,confirm:string)=>call('/admin/promo','POST',{code,confirm},password);
export const fundEnable=(password:string,enabled:boolean)=>call('/admin/enabled','POST',{enabled},password);
export const fundLimit=(password:string,limitAr:string)=>call('/admin/limit','POST',{limitAr},password);
export const fundReconcile=(password:string)=>call('/admin/reconcile','POST',{},password);
export const solanaRecipientSettings=(password:string)=>call<SolanaRecipientAdminView>('/admin/solana-recipients','GET',undefined,password);
export const saveSolanaRecipients=(password:string,value:SolanaRecipients&{expectedRevision:number})=>call<SolanaRecipientAdminView>('/admin/solana-recipients','POST',value,password);
