import {readCache,writeCache,cachedJobs} from './cache';
import {configHash,verifyChain,type ConfigChain} from './config';
export type SavingStage='successor_restore'|'reconcile_previous'|'readiness_check'|'wallet_connect'|'archive_binding'|'risk_consent_persist'|'successor_create'|'order_signature'|'successor_persist'|'payment_prepare'|'route_switch'|'payment_signature';
export type BindingDiagnostic={id:string;configHash:string;policyVersion:string;versions:{version:number;hash:string}[];signingStarted:boolean;paymentSignature:string|null;reconciledSignature:string|null;signedPaymentPresent:boolean;attemptPhase:string|null};
export type SavingDiagnostic={stage:SavingStage;code:string;at:number;orderId?:string;context:{project:'SEJIRE';network:'devnet'|'unknown';binding?:BindingDiagnostic}};
export async function recordSavingError(stage:SavingStage,error:unknown,orderId?:string) {
 const message=error instanceof Error?error.message:'unexpected_error';
 const code=error&&typeof error==='object'&&'code'in error&&error.code===4001?'signature_cancelled':/^[a-z][a-z0-9_-]{0,90}$/.test(message)?message:'unexpected_error';
 const entry:SavingDiagnostic={stage,code,at:Date.now(),...(orderId?{orderId}:{}),context:{project:'SEJIRE',network:'unknown'}};
 if(stage==='successor_restore'&&orderId)try{
  const job=(await cachedJobs()).find(j=>j.order.id===orderId),record=await readCache<{chain:ConfigChain;trusted:string}>('trusted-session');
  if(job&&record){await verifyChain(record.chain,record.trusted);entry.context.binding={id:job.order.id,configHash:job.configHash,policyVersion:job.order.policyVersion,versions:await Promise.all(record.chain.versions.map(async v=>({version:v.config.version,hash:await configHash(v.config)}))),signingStarted:job.signingStarted===true,paymentSignature:job.paymentSignature??null,reconciledSignature:job.reconciledSignature??null,signedPaymentPresent:job.signedPayment!==undefined,attemptPhase:job.attempt?.phase??null};}
 }catch{/* Only verified public configuration may enter safe diagnostics. */}
 try {const old=await readCache<SavingDiagnostic[]>('saving-diagnostics')??[];await writeCache('saving-diagnostics',[...old.slice(-99),entry]);}catch{/* A failed cache must not mask the original error. */}
 return entry;
}
