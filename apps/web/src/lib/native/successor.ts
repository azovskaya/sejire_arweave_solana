import {cachedJobs,readCache,saveJob,writeCache} from './cache';
import {configForJob,newJob,readyForOrder,validateJob,type NativeJob} from './jobs';
import {parseEnvelope,serializeEnvelope} from '../crypto/envelope';
import {onRpc} from './rpc';
import {canStartDevnetRiskTest} from './presentation';
import {nativeSession} from './session';
type NativeSession=NonNullable<ReturnType<typeof nativeSession>>;
import type {NativeSolWallet} from './payment';
import type {SavingStage} from './diagnostics';
/** Local exclusive retry, not a global/on-chain uniqueness guarantee. No payment signature here. */
export async function devnetSuccessor(session:NativeSession,previous:NativeJob,wallet:NativeSolWallet,stage:(value:SavingStage)=>void) {
 if(session.config.environment!=='devnet'||!canStartDevnetRiskTest(previous))throw Error('devnet_risk_test_not_allowed');
 if(!navigator.locks)throw Error('exclusive_browser_lock_unavailable');
 return navigator.locks.request('sejire-successor-'+previous.order.id,async()=>{
  const key='successor-intent-'+previous.order.id;
  const existing=(await cachedJobs()).find(j=>j.supersedes===previous.order.id)??await readCache<NativeJob>(key);
  if(existing){const config=await configForJob(session.chain,existing,session.trusted);await validateJob(existing,config);if(existing.supersedes!==previous.order.id||existing.ciphertext!==previous.ciphertext||existing.order.payer!==previous.order.payer)throw Error('archive_binding');stage('successor_persist');await saveJob(existing);return existing;}
  stage('archive_binding');const oldConfig=await configForJob(session.chain,previous,session.trusted);await validateJob(previous,oldConfig);
  if(!previous.ciphertext||!previous.order.archive)throw Error('archive_binding');
  const envelope=parseEnvelope(JSON.parse(previous.ciphertext));if(serializeEnvelope(envelope)!==previous.ciphertext)throw Error('archive_binding');
  if(session.config.serviceLamports!=='30000000'||previous.order.fundContribution.amount!=='0')throw Error('order_policy_binding');
  stage('readiness_check');await onRpc(session.config,async()=>true);await readyForOrder(session.config,previous.order.archive.bytes,previous.order.archive.digest);
  stage('wallet_connect');await wallet.connect();const payer=wallet.publicKey?.toString();if(payer!==previous.order.payer)throw Error('payer_changed');if(!session.config.managers.includes(payer))throw Error('manager_not_authorized');
  stage('risk_consent_persist');await writeCache('devnet-risk-consent-'+previous.order.id,{schema:'sejire/devnet-risk-consent/v1',previousOrder:previous.order.id,archiveDigest:previous.order.archive.digest,at:Date.now(),manager:payer});
  stage('successor_create');const next=await newJob(session.config,payer,'0',envelope,wallet,previous.order.id,stage);
  stage('successor_persist');await writeCache(key,next);await saveJob(next);return next;
 });
}
