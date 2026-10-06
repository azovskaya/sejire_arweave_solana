import {readCache,writeCache} from './cache';
export type SavingStage='reconcile_previous'|'readiness_check'|'wallet_connect'|'archive_binding'|'risk_consent_persist'|'successor_create'|'order_signature'|'successor_persist'|'payment_prepare'|'route_switch'|'payment_signature';
export type SavingDiagnostic={stage:SavingStage;code:string;at:number;orderId?:string;context:{project:'SEJIRE';network:'devnet'|'unknown'}};
export async function recordSavingError(stage:SavingStage,error:unknown,orderId?:string) {
 const message=error instanceof Error?error.message:'unexpected_error';
 const code=error&&typeof error==='object'&&'code'in error&&error.code===4001?'signature_cancelled':/^[a-z][a-z0-9_-]{0,90}$/.test(message)?message:'unexpected_error';
 const entry:SavingDiagnostic={stage,code,at:Date.now(),...(orderId?{orderId}:{}),context:{project:'SEJIRE',network:'unknown'}};
 try {const old=await readCache<SavingDiagnostic[]>('saving-diagnostics')??[];await writeCache('saving-diagnostics',[...old.slice(-99),entry]);}catch{/* A failed cache must not mask the original error. */}
 return entry;
}
