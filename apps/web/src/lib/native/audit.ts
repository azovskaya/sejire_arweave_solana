/** Signed manual-pilot observations; authentic bounded history, NOT a global AO ledger. */
import { canonical } from '../../../../../packages/protocol/wire';
import { envelopeDigest } from '../solana/policy';
import { configHash, exactKeys, verifyChain, verifySignatures, walletSignature, type ConfigChain, type Signature, type MessageWallet } from './config';
import type { NativeJob } from './jobs';
import type { TransactionEvidence } from '../../../../../apps/sponsor/src/checkout/paymentValidator';
import { validatePayment } from '../../../../../apps/sponsor/src/checkout/paymentValidator';
import { GENESIS } from './config';
export type AuditEvent={domain:'sejire/admin-observation/v1';sequence:number;previous:string|null;configurationHash:string;orderId:string;orderHash:string;action:'PaymentObserved';evidence:TransactionEvidence;at:number};
export type SignedAudit={event:AuditEvent;signature:Signature};
export const auditHash=(a:SignedAudit)=>envelopeDigest(canonical(a));
export async function verifyAudit(chain:ConfigChain,trusted:string,jobs:NativeJob[],audit:SignedAudit[]) {
 await verifyChain(chain,trusted);
 const evidenceHashes=new Map<string,string>(),conflicts:string[]=[];
 const used=new Map<string,string>(),totals={servicePayment:0n,fundContribution:0n};let previous:string|null=null;
 if(!Array.isArray(audit)||audit.length>10000)throw Error('audit_too_large');
 for(let i=0;i<audit.length;i++){
  const a=audit[i],e=a.event;exactKeys(a,['event','signature']);exactKeys(e,['domain','sequence','previous','configurationHash','orderId','orderHash','action','evidence','at']);
  if(e.domain!=='sejire/admin-observation/v1'||e.sequence!==i+1||e.previous!==previous||e.action!=='PaymentObserved'||!Number.isSafeInteger(e.at))throw Error('audit_gap_or_wrong_domain');
  let policy;for(const v of chain.versions)if(await configHash(v.config)===e.configurationHash)policy=v.config;
  if(!policy)throw Error('audit_unknown_policy');verifySignatures(e,[a.signature],policy.managers,1);
  const job=jobs.find(j=>j.order.id===e.orderId);if(!job||await envelopeDigest(canonical(job.order))!==e.orderHash||job.paymentSignature!==e.evidence.signature)throw Error('audit_order_binding');
  const payment=validatePayment(job.order,e.evidence,{network:job.order.network,genesisHash:GENESIS[job.order.network]});
  const evidenceHash=await envelopeDigest(canonical(e.evidence)),priorEvidence=evidenceHashes.get(payment.signature);
  if(priorEvidence&&priorEvidence!==evidenceHash&&!conflicts.includes(job.order.id))conflicts.push(job.order.id);
  if(!priorEvidence)evidenceHashes.set(payment.signature,evidenceHash);
  const old=used.get(payment.signature);if(old&&old!==job.order.id)throw Error('transaction_reuse');
  if(!old){used.set(payment.signature,job.order.id);for(const credit of payment.credits)totals[credit.purpose]+=BigInt(credit.amount);}
  previous=await auditHash(a);
 }
 return {conflicts,head:previous,entries:audit.length,servicePayment:totals.servicePayment.toString(),fundContribution:totals.fundContribution.toString(),uniquePayments:used.size};
}
export async function observePayment(chain:ConfigChain,trusted:string,jobs:NativeJob[],audit:SignedAudit[],job:NativeJob,evidence:TransactionEvidence,wallet:MessageWallet):Promise<SignedAudit[]> {
 const config=await verifyChain(chain,trusted);await verifyAudit(chain,trusted,jobs,audit);
 if(audit.some(a=>a.event.orderId===job.order.id&&canonical(a.event.evidence)===canonical(evidence)))return audit;
 if(!wallet.publicKey||!config.managers.includes(wallet.publicKey.toString()))throw Error('manager_not_authorized');
 const event:AuditEvent={domain:'sejire/admin-observation/v1',sequence:audit.length+1,previous:audit.length?await auditHash(audit[audit.length-1]):null,configurationHash:await configHash(config),orderId:job.order.id,orderHash:await envelopeDigest(canonical(job.order)),action:'PaymentObserved',evidence,at:Date.now()};
 const next=[...audit,{event,signature:await walletSignature(event,wallet)}];await verifyAudit(chain,trusted,jobs,next);return next;
}
