/** Replaceable PUBLIC RPC observer. This is RPC trust, not a trustless cross-chain proof. */
import { SolanaRpcReader } from '../../../../../apps/sponsor/src/checkout/rpcReader';
import { decodeTransaction, object } from '../../../../../apps/sponsor/src/checkout/rpcDecoder';
import { validatePayment } from '../../../../../apps/sponsor/src/checkout/paymentValidator';
import type { Order } from '../../../../../packages/checkout/order';
import { assertBase58 } from '../../../../../packages/checkout/order';
import { endpoint, GENESIS, type Config } from './config';
export async function rpc<T>(url:string,method:string,params:unknown[]=[],transport:typeof fetch=fetch,onResponse?:(status:number)=>void):Promise<T> {
 // Reuse existing bounded JSON/timeout/status validation; only routing differs in this optional public adapter.
 const reader = new SolanaRpcReader({network:'devnet'},async(_ignored,init)=>{const response=await transport(endpoint(url),init);onResponse?.(response.status);return response;});
 return await reader.rpc(method,params) as T;
}
export async function onRpc<T>(c:Config,action:(url:string)=>Promise<T>):Promise<T> {
 let last:unknown = Error('rpc_unavailable');
 for(const url of c.solanaRpcs) try { if(await rpc(url,'getGenesisHash') !== GENESIS[c.environment]) throw Error('wrong_network'); return await action(url); } catch(e){last=e;}
 throw last;
}
export async function verifyPaymentRpc(c:Config,order:Order,signature:string) {
 assertBase58(signature,64);
 if(order.network !== c.environment) throw Error('order_network');
 return onRpc(c,async url=>{
  const statusResult=object(await rpc(url,'getSignatureStatuses',[[signature],{searchTransactionHistory:true}]));
  if(!Array.isArray(statusResult.value)||statusResult.value.length!==1) throw Error('missing_metadata');
  if(statusResult.value[0]===null)throw Error('requires_reconciliation');
  const status=object(statusResult.value[0]),context=object(statusResult.context);
  if(status.confirmationStatus!=='finalized')throw Error('requires_reconciliation');
  if(status.err!==null)throw Error('transaction_failed');
  if(status.confirmations!==null||!Number.isSafeInteger(status.slot)||typeof context.slot!=='number'||context.slot<(status.slot as number))throw Error('missing_metadata');
  const result=await rpc(url,'getTransaction',[signature,{commitment:'finalized',encoding:'json',maxSupportedTransactionVersion:0}]);
  if(result===null)throw Error('requires_reconciliation');
  const chain={network:c.environment,genesisHash:GENESIS[c.environment]};
  const evidence=decodeTransaction(result,signature,chain);
  if(evidence.slot!==status.slot)throw Error('missing_metadata');
  return {evidence,payment:validatePayment(order,evidence,chain),rpc:url,checkedAt:new Date().toISOString()};
 });
}
const balanceGenesisInFlight=new Map<string,Promise<{value:unknown;httpStatus?:number}>>();
export async function walletBalance(c:Config,address:string,diagnostics:(entry:BalanceDiagnostic)=>void=()=>{}) {
 assertBase58(address,32);
 let last:unknown=Error('rpc_unavailable');
 for(const url of c.solanaRpcs){
  for(let attempt=0;attempt<2;attempt++){
   const call=async <T>(method:string,params:unknown[]=[])=>{const start=Date.now();let httpStatus:number|undefined;const request=async()=>({value:await rpc(url,method,params,fetch,status=>{httpStatus=status;}),httpStatus});try{let pending:Promise<{value:unknown;httpStatus?:number}>;if(method==='getGenesisHash'){const existing=balanceGenesisInFlight.get(url);pending=existing??request();if(!existing){balanceGenesisInFlight.set(url,pending);void pending.finally(()=>balanceGenesisInFlight.delete(url)).catch(()=>{});}}else pending=request();const response=await pending;httpStatus=response.httpStatus;const value=response.value as T;diagnostics({endpoint:url,method,durationMs:Date.now()-start,status:'ok',httpStatus,at:Date.now()});return value;}catch(error){const e=error as Error & {details?:{httpStatus?:number;rpcCode?:number;retryAfterMs?:number}};diagnostics({endpoint:url,method,durationMs:Date.now()-start,status:e.message??'rpc-unavailable',httpStatus,...e.details,at:Date.now()});throw error;}};
   try{if(await call('getGenesisHash')!==GENESIS[c.environment]){diagnostics({endpoint:url,method:'getGenesisHash',durationMs:0,status:'wrong-network',at:Date.now()});throw Error('wrong-network');}
    const balance=await call<{value:number}>('getBalance',[address,{commitment:'finalized'}]);if(!Number.isSafeInteger(balance.value)||balance.value<0)throw Error('unsafe_rpc_balance');return {lamports:String(balance.value),checkedAt:Date.now(),endpoint:url};
   }catch(error){last=error;const e=error as Error & {details?:{retryAfterMs?:number}};const delay=e.details?.retryAfterMs??500;
    if(attempt!==0||!['rpc-rate-limited','rpc-timeout','rpc-unavailable','rpc-server-error'].includes(e.message)||delay>2000)break;
    await new Promise(resolve=>setTimeout(resolve,Math.max(500,delay)));
   }
  }
 }
 throw last;
}
export type BalanceDiagnostic={endpoint:string;method:string;durationMs:number;status:string;at:number;httpStatus?:number;rpcCode?:number;retryAfterMs?:number};
export async function walletHistory(c:Config,address:string) {
 assertBase58(address,32);
 return onRpc(c,async url=>{
 const balance=await rpc<{value:number}>(url,'getBalance',[address,{commitment:'finalized'}]);
 if(!Number.isSafeInteger(balance.value))throw Error('unsafe_rpc_balance');
 const signatures=await rpc<{signature:string;err:unknown}[]>(url,'getSignaturesForAddress',[address,{limit:10,commitment:'finalized'}]);
 if(!Array.isArray(signatures)||signatures.length>10)throw Error('invalid_history');
 const movements=await Promise.all(signatures.map(async item=>{
 try{assertBase58(item.signature,64);const tx=object(await rpc(url,'getTransaction',[item.signature,{commitment:'finalized',encoding:'json',maxSupportedTransactionVersion:0}]));
 const meta=object(tx.meta),message=object(object(tx.transaction).message);
 if(!Array.isArray(message.accountKeys)||!Array.isArray(meta.preBalances)||!Array.isArray(meta.postBalances))throw Error('missing_balance_metadata');
 const keys=[...message.accountKeys,...((meta.loadedAddresses as {writable?:unknown[]})?.writable??[]),...((meta.loadedAddresses as {readonly?:unknown[]})?.readonly??[])];
 const index=keys.indexOf(address),before=meta.preBalances[index],after=meta.postBalances[index];
 if(index<0||!Number.isSafeInteger(before)||!Number.isSafeInteger(after)||!Number.isSafeInteger(meta.fee))throw Error('unsafe_balance_metadata');
 return {signature:item.signature,at:typeof tx.blockTime==='number'&&Number.isSafeInteger(tx.blockTime)?tx.blockTime*1000:undefined,success:meta.err===null,balanceDeltaLamports:(BigInt(after)-BigInt(before)).toString(),networkFeeLamports:String(meta.fee),note:'Изменение баланса включает комиссию плательщика; это не service/fund credit.'};
 }catch{return {signature:item.signature,status:'requires_reconciliation'};}
 }));
 return {balance,signatures,movements,rpc:url};
 });
}
/** Bounded discovery. Empty/partial RPC history never clears an unknown signing attempt. */
export async function findPaymentByReference(c:Config,order:Order) {
 return onRpc(c,async url=>{
  const rows=await rpc<{signature:string;err:unknown}[]>(url,'getSignaturesForAddress',[order.reference,{commitment:'finalized',limit:20}]);
  if(!Array.isArray(rows))throw Error('missing_metadata');const rejected:string[]=[];
  for(const row of rows.slice(0,3)){try{const result=await verifyPaymentRpc(c,order,row.signature);return {signature:row.signature,result,pageComplete:false,checkedAt:Date.now(),endpoint:url};}catch(e){rejected.push(e instanceof Error?e.message:'invalid_candidate');}}
  return {signature:undefined,rejected,pageComplete:rows.length<20&&rows.length<=3,checkedAt:Date.now(),endpoint:url};
 });
}
