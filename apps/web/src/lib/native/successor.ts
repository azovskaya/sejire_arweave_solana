import {cachedJobs,readCache,saveJob,writeCache,writeCacheEntries} from './cache';
import {configForJob,newJob,readyForOrder,validateJob,type NativeJob} from './jobs';
import {parseEnvelope,serializeEnvelope} from '../crypto/envelope';
import {onRpc} from './rpc';
import {canStartDevnetRiskTest} from './presentation';
import {nativeSession,restoreJobSession} from './session';
import {verifySignatures} from './config';
import {orderPayload} from './jobs';
type NativeSession=NonNullable<ReturnType<typeof nativeSession>>;
import type {NativeSolWallet} from './payment';
import type {SavingStage} from './diagnostics';
export function prePaymentOnly(job:NativeJob) {
 return (job.signingStarted===undefined||job.signingStarted===false)&&job.paymentSignature===undefined&&job.reconciledSignature===undefined&&job.signedPayment===undefined&&job.arPlan===undefined&&(job.arSigningStarted===undefined||job.arSigningStarted===false)&&(!job.attempt||['prepared','expired_unexecuted'].includes(job.attempt.phase));
}
export function linkedSuccessor(jobs:NativeJob[],previous:NativeJob) {
 let current=previous;const seen=new Set([current.order.id]);
 for(;;){const children=jobs.filter(j=>j.supersedes===current.order.id);if(children.length>1)throw Error('conflicting_successors');if(!children.length)return current===previous?undefined:current;current=children[0];if(seen.has(current.order.id))throw Error('conflicting_successors');seen.add(current.order.id);}
}
export async function assertReplacement(previous:NativeJob,orphan:NativeJob) {
 if(previous.order.network!=='devnet'||orphan.order.network!=='devnet'||!prePaymentOnly(orphan))throw Error('previous_payment_requires_reconciliation');
 if(orphan.attempt)(await import('./payment')).validateAttempt(orphan);
 verifySignatures(orderPayload(orphan),orphan.signatures,[previous.order.payer],1);
 if(orphan.order.payer!==previous.order.payer||orphan.ciphertext!==previous.ciphertext||orphan.order.archive?.digest!==previous.order.archive?.digest||orphan.order.archive?.bytes!==previous.order.archive?.bytes||orphan.order.servicePayment.amount!=='30000000'||orphan.order.fundContribution.amount!=='0')throw Error('archive_binding');
}
/** Local exclusive retry, not a global/on-chain uniqueness guarantee. No payment signature here. */
export async function devnetSuccessor(session:NativeSession,previous:NativeJob,wallet:NativeSolWallet,stage:(value:SavingStage)=>void,replacement?:NativeJob) {
 if(session.config.environment!=='devnet'||!canStartDevnetRiskTest(previous))throw Error('devnet_risk_test_not_allowed');
 if(!navigator.locks)throw Error('exclusive_browser_lock_unavailable');
 const execute=async()=>{
  const key='successor-intent-'+previous.order.id;
  const leaf=linkedSuccessor(await cachedJobs(),previous),intent=await readCache<NativeJob>(key);
  const existing=intent&&intent.supersedes===leaf?.order.id?intent:leaf??intent;
  let replacing=false;
  if(existing){
   stage('successor_restore');
   try{session=await restoreJobSession(existing);const config=await configForJob(session.chain,existing,session.trusted);await validateJob(existing,config);if(existing.ciphertext!==previous.ciphertext||existing.order.payer!==previous.order.payer)throw Error('archive_binding');stage('successor_persist');await saveJob(existing);return existing;}
   catch(e){if(!(e instanceof Error)||e.message!=='unknown_order_configuration'||replacement?.order.id!==existing.order.id)throw e;await assertReplacement(previous,existing);replacing=true;}
  }
  stage('archive_binding');const oldConfig=await configForJob(session.chain,previous,session.trusted);await validateJob(previous,oldConfig);
  if(!previous.ciphertext||!previous.order.archive)throw Error('archive_binding');
  const envelope=parseEnvelope(JSON.parse(previous.ciphertext));if(serializeEnvelope(envelope)!==previous.ciphertext)throw Error('archive_binding');
  if(session.config.serviceLamports!=='30000000'||previous.order.fundContribution.amount!=='0')throw Error('order_policy_binding');
  stage('readiness_check');await onRpc(session.config,async()=>true);await readyForOrder(session.config,previous.order.archive.bytes,previous.order.archive.digest);
  stage('wallet_connect');await wallet.connect();const payer=wallet.publicKey?.toString();if(payer!==previous.order.payer)throw Error('payer_changed');if(!session.config.managers.includes(payer))throw Error('manager_not_authorized');
  stage('risk_consent_persist');await writeCache('devnet-risk-consent-'+previous.order.id,{schema:'sejire/devnet-risk-consent/v1',previousOrder:previous.order.id,archiveDigest:previous.order.archive.digest,at:Date.now(),manager:payer});
  stage('successor_create');const next=await newJob(session.config,payer,'0',envelope,wallet,replacing?existing!.order.id:previous.order.id,stage);
  stage('successor_persist');await writeCacheEntries([[key,next],...(replacing?[[`retired-prepayment-${existing!.order.id}`,{replacement:next.order.id,at:Date.now()}] as [string,unknown]]:[])]);await saveJob(next);return next;
 };
 return navigator.locks.request('sejire-successor-'+previous.order.id,()=>replacement?navigator.locks.request('sejire-native-payment-'+replacement.order.id,execute):execute());
}
