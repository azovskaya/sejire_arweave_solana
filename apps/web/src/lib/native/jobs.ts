import { pilotEnabled, assertPilotConfig, assertPilotBinding } from './pilot';
import { canonical } from '../../../../../packages/protocol/wire';
import { createOrder, assertOrder, type Order } from '../../../../../packages/checkout/order';
import { parseAmount } from '../../../../../packages/checkout/amounts';
import { parseEnvelope, serializeEnvelope, MAX_BACKUP_BYTES } from '../crypto/envelope';
import type { EnvelopeV1 } from '../crypto/encrypt';
import { envelopeDigest } from '../solana/policy';
import { configHash, verifyChain, verifySignatures, walletSignature, exactKeys, type ConfigChain, type Config, type Signature, type MessageWallet } from './config';
import { arQuote, winston, type ArPlan } from './arweave';
import { verifyPaymentRpc } from './rpc';
export type PaymentAttempt={id:string;phase:'prepared'|'wallet_pending'|'rejected'|'signature_unknown'|'signed'|'broadcast'|'finalized'|'failed'|'expired_unexecuted';message:string;blockhash:string;lastValidBlockHeight:number;at:number;error?:string};
export type NativeJob = {
 schema:'sejire/native-job/v1'; configHash:string; order:Order; signatures:Signature[]; ciphertext?:string;
 paymentSignature?:string; signedPayment?:string; signingStarted?:boolean;
 supersedes?:string;
 attempt?:PaymentAttempt; reconciledSignature?:string;
 arSigningStarted?:boolean;
 arPlan?:ArPlan; // untrusted on import until signature + byte binding verified
};
export const orderPayload=(job:NativeJob)=>({domain:'sejire/native-order/v1',configHash:job.configHash,order:job.order,...(job.supersedes?{supersedes:job.supersedes}:{})});
export async function configForJob(chain:ConfigChain,job:NativeJob,trusted:string) {
 await verifyChain(chain,trusted);
 for(const v of chain.versions)if(await configHash(v.config)===job.configHash)return v.config;
 throw Error('unknown_order_configuration');
}
export async function validateJob(job:NativeJob,c:Config) {
 const fields=['schema','configHash','order','signatures','ciphertext','paymentSignature','signedPayment','signingStarted','arPlan','arSigningStarted','attempt','reconciledSignature','supersedes'];
 if(!job||typeof job!=='object'||Object.keys(job).some(k=>!fields.includes(k))||job.schema!=='sejire/native-job/v1'||job.configHash!==await configHash(c))throw Error('invalid_native_job');
 if(job.supersedes!==undefined&&(!/^[a-f0-9]{32}$/.test(job.supersedes)||job.supersedes===job.order.id))throw Error('invalid_predecessor');
 if(job.signingStarted!==undefined&&typeof job.signingStarted!=='boolean')throw Error('invalid_native_job');
 if(job.arSigningStarted!==undefined&&typeof job.arSigningStarted!=='boolean')throw Error('invalid_native_job');
 assertOrder(job.order);const o=job.order;
 if(canonical(o)!==canonical(createOrder({...o,asset:o.asset.symbol}))||o.network!==c.environment||o.asset.symbol!=='SOL'||o.policyVersion!==`config-${c.version}`||o.servicePayment.recipient!==c.wallets.service||o.fundContribution.recipient!==c.wallets.fund||o.servicePayment.amount!==(o.kind==='preservation'?c.serviceLamports:'0'))throw Error('order_policy_binding');
 verifySignatures(orderPayload(job),job.signatures,[o.payer],1);
 if(o.kind==='preservation') {
  if(typeof job.ciphertext!=='string'||new TextEncoder().encode(job.ciphertext).length!==o.archive!.bytes||o.archive!.bytes>c.upload.maxBytes||o.archive!.bytes>MAX_BACKUP_BYTES||await envelopeDigest(job.ciphertext)!==o.archive!.digest)throw Error('archive_binding');
  parseEnvelope(JSON.parse(job.ciphertext));
 } else if(job.ciphertext!==undefined||job.arPlan!==undefined)throw Error('donation_archive_forbidden');
 if(job.attempt){const {validateAttempt}=await import('./payment');validateAttempt(job);}
 if(job.reconciledSignature!==undefined){const {assertBase58}=await import('../../../../../packages/checkout/order');assertBase58(job.reconciledSignature,64);}
 if(job.paymentSignature!==undefined){const {assertBase58}=await import('../../../../../packages/checkout/order');assertBase58(job.paymentSignature,64);const {validateSignedPayment}=await import('./payment');validateSignedPayment(job);}
 if(job.arPlan&&(job.arPlan.address!==c.wallets.arReserve||BigInt(job.arPlan.rewardWinston)>BigInt(c.upload.maxRewardWinston)))throw Error('upload_executor_or_budget');
}
export async function newJob(c:Config,payer:string,contribution:string,envelope:EnvelopeV1|undefined,wallet:MessageWallet,supersedes?:string,onStage?:(stage:'readiness_check'|'order_signature')=>void):Promise<NativeJob> {
 const ciphertext=envelope?serializeEnvelope(envelope):undefined,now=Date.now();
 const job:NativeJob={schema:'sejire/native-job/v1',configHash:await configHash(c),...(supersedes?{supersedes}:{}),signatures:[],order:createOrder({id:crypto.randomUUID().replace(/-/g,''),kind:envelope?'preservation':'contribution',network:c.environment,asset:'SOL',payer,reference:(await import('bs58')).default.encode(crypto.getRandomValues(new Uint8Array(32))),createdAt:now,expiresAt:now+30*60*1000,policyVersion:`config-${c.version}`,servicePayment:{recipient:c.wallets.service,amount:envelope?c.serviceLamports:'0'},fundContribution:{recipient:c.wallets.fund,amount:parseAmount(contribution,9)},...(ciphertext?{archive:{digest:await envelopeDigest(ciphertext),bytes:new TextEncoder().encode(ciphertext).length}}:{})}),...(ciphertext?{ciphertext}:{})};
 if(payer!==wallet.publicKey?.toString())throw Error('payer_changed');
 if(envelope){onStage?.('readiness_check');await readyForOrder(c,job.order.archive!.bytes,job.order.archive!.digest);}
 onStage?.('order_signature');job.signatures=[await walletSignature(orderPayload(job),wallet)];await validateJob(job,c);return job;
}
export async function readyForOrder(c:Config,bytes:number,digest?:string) {
 if(!c.upload.acceptingUntil)throw Error('manual_executor_not_accepting_orders');
 if(c.upload.acceptingUntil<=Date.now())throw Error('manual_executor_window_expired');
 if(pilotEnabled()){assertPilotConfig(c);assertPilotBinding(c.wallets.arReserve,digest??'',bytes,c.upload.maxRewardWinston);}
 if(bytes>c.upload.maxBytes)throw Error('archive_size_not_supported');
 const quote=await arQuote(c.arweaveNodes,c.wallets.arReserve,bytes);
 if(winston(quote.balanceWinston)<winston(quote.rewardWinston)||winston(quote.rewardWinston)>winston(c.upload.maxRewardWinston))throw Error('ar_budget_unavailable');
 return quote;
}
export function archiveTags(job:NativeJob) {
 if(!job.order.archive)throw Error('no_archive');
 return [{name:'Content-Type',value:'application/json'},{name:'App-Name',value:'SEJIRE'},{name:'Protocol',value:'sejire/v0.3'},{name:'Type',value:'vault-envelope'},{name:'Envelope-SHA256',value:job.order.archive.digest}];
}
export async function reconcileJob(job:NativeJob,c:Config,otherJobs:NativeJob[]) {
 await validateJob(job,c);
 const signature=job.paymentSignature??job.reconciledSignature;if(!signature)throw Error('no_pending_payment');
 if(otherJobs.some(j=>j.order.id!==job.order.id&&(j.paymentSignature??j.reconciledSignature)===signature))throw Error('transaction_reuse');
 return verifyPaymentRpc(c,job.order,signature);
}
export type JobPackage={schema:'sejire/native-job-package/v1';chain:ConfigChain;job:NativeJob};
export function parsePackage(text:string):JobPackage {
 if(new TextEncoder().encode(text).length>MAX_BACKUP_BYTES*3)throw Error('package_too_large');
 const p=JSON.parse(text);exactKeys(p,['schema','chain','job']);if(p.schema!=='sejire/native-job-package/v1')throw Error('invalid_job_package');return p;
}
