import { createHash, createPublicKey, verify } from 'node:crypto';
import bs58 from 'bs58';
import { assertOrder, createOrder, type Order } from '../../../../packages/checkout/order';
import { validatePayment, type TransactionEvidence } from '../checkout/paymentValidator';
import { DEVNET_GENESIS } from '../checkout/rpcReader';
import { DOMAIN, canonical } from '../../../../packages/protocol/wire';
export { DOMAIN, canonical };
export const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
export type Policy={version:string;epoch:number;serviceLamports:string;serviceRecipient:string;fundRecipient:string;managers:string[];threshold:number;observers:string[];executors:string[]};
export type Genesis={domain:typeof DOMAIN;processId:string;codeHash:string;runtime:string;network:'devnet';genesisHash:string;policy:Policy;creation:{publicKey:string;signature:string}[]};
export type Message={domain:typeof DOMAIN;processId:string;epoch:number;policyVersion:string;action:'Order'|'Pending'|'Payment'|'UploadPlan'|'UploadResult'|'Policy';body:Record<string,unknown>};
export type Signed={message:Message;signatures:{publicKey:string;signature:string}[]};
export type Entry={sequence:number;previous:string;event:Signed;hash:string};
export type RecordState={order:Order;accessHash:string;pendingSignature?:string;payment?:ReturnType<typeof validatePayment>;evidenceHash?:string;conflicts:string[];plan?:{id:string;rawBase64:string;ciphertext:string};accepted?:{id:string;winc:string};retrieved?:boolean};
export type State={policy:Policy;orders:Record<string,RecordState>;references:Record<string,string>;used:Record<string,string>;totals:{servicePayment:string;fundContribution:string}};
export function verifiedKeys(payload:unknown,signatures:Signed['signatures']):string[]{
 const bytes=Buffer.from(canonical(payload));const keys=new Set<string>();
 for(const s of signatures){const raw=bs58.decode(s.publicKey),sig=bs58.decode(s.signature);if(raw.length!==32||sig.length!==64)throw Error('bad_signature');
 const publicKey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),raw]),format:'der',type:'spki'});
 if(!verify(null,bytes,publicKey,sig)||keys.has(s.publicKey))throw Error('bad_signature');keys.add(s.publicKey);}
 return [...keys];
}
export function validatePolicy(p:Policy){
 if(!p||!Number.isSafeInteger(p.epoch)||p.epoch<0||!Number.isSafeInteger(p.threshold)||p.threshold<1||p.threshold>p.managers.length||new Set(p.managers).size!==p.managers.length||p.observers.length<1||p.executors.length<1||!/^[1-9]\d*$/.test(p.serviceLamports)||BigInt(p.serviceLamports)>18446744073709551615n||p.serviceRecipient===p.fundRecipient)throw Error('invalid_policy');
 for(const key of [...p.managers,...p.observers,...p.executors,p.serviceRecipient,p.fundRecipient])if(bs58.decode(key).length!==32)throw Error('invalid_key');
}
function threshold(keys:string[],p:Policy){if(keys.filter(k=>p.managers.includes(k)).length<p.threshold)throw Error('management_threshold');}
export function genesisPayload(g:Genesis){const {creation:_,...payload}=g;return payload;}
export function initial(g:Genesis,trustedCreationHash:string):State{
 if(hash(genesisPayload(g))!==trustedCreationHash||g.domain!==DOMAIN||g.network!=='devnet'||g.genesisHash!==DEVNET_GENESIS||!/^[a-f0-9]{64}$/.test(g.codeHash))throw Error('untrusted_creation');
 validatePolicy(g.policy);threshold(verifiedKeys(genesisPayload(g),g.creation),g.policy);
 return {policy:structuredClone(g.policy),orders:{},references:{},used:{},totals:{servicePayment:'0',fundContribution:'0'}};
}
export async function apply(input:State,event:Signed,g:Genesis):Promise<State>{
 const s=structuredClone(input),m=event.message,p=s.policy;
 if(m.domain!==DOMAIN||m.processId!==g.processId||m.epoch!==p.epoch||m.policyVersion!==p.version)throw Error('wrong_domain_or_authority_epoch');
 const fields:Record<string,string[]>= {Order:['order','accessHash'],Pending:['orderId','signature'],Payment:['orderId','orderHash','evidence'],UploadPlan:['orderId','plan'],UploadResult:['orderId','id','accepted','retrieved'],Policy:['policy','acceptance']};
 if(!fields[m.action]||Object.keys(m).some(k=>!['domain','processId','epoch','policyVersion','action','body'].includes(k))||Object.keys(m.body).some(k=>!fields[m.action].includes(k)))throw Error('unsupported_message_field');
 const keys=verifiedKeys(m,event.signatures),b=m.body;
 if(m.action==='Policy'){threshold(keys,p);const next=b.policy as Policy;validatePolicy(next);if(next.epoch!==p.epoch+1)throw Error('policy_epoch');threshold(verifiedKeys({...m,body:{policy:next}},b.acceptance as Signed['signatures']),next);s.policy=structuredClone(next);return s;}
 if(m.action==='Order'){
  const order=b.order as Order;assertOrder(order);if(canonical(order)!==canonical(createOrder({...order,asset:order.asset.symbol})))throw Error('order_extra_fields');if(keys.length!==1||keys[0]!==order.payer)throw Error('order_signature');
  if(order.network!==g.network||order.asset.symbol!=='SOL'||order.policyVersion!==p.version||order.servicePayment.recipient!==p.serviceRecipient||order.fundContribution.recipient!==p.fundRecipient||order.servicePayment.amount!==(order.kind==='preservation'?p.serviceLamports:'0')||Object.keys(order).some(k=>!['schema','total','networkFee','id','kind','network','asset','payer','reference','createdAt','expiresAt','policyVersion','servicePayment','fundContribution','archive'].includes(k))||typeof b.accessHash!=='string'||!/^[a-f0-9]{64}$/.test(b.accessHash))throw Error('order_policy');
  const previous=s.orders[order.id];if(previous){if(hash({order:previous.order,accessHash:previous.accessHash})!==hash(b))throw Error('order_conflict');return s;}
  if(s.references[order.reference])throw Error('reference_reuse');s.references[order.reference]=order.id;s.orders[order.id]={order,accessHash:b.accessHash,conflicts:[]};return s;
 }
 const r=s.orders[b.orderId as string];if(!r)throw Error('unknown_order');
 if(m.action==='Pending'){
  if(keys.length!==1||hash(keys[0])!==r.accessHash)throw Error('order_access');
  if(typeof b.signature!=='string'||bs58.decode(b.signature).length!==64)throw Error('payment_signature');
  if(r.pendingSignature&&r.pendingSignature!==b.signature)throw Error('pending_replacement');r.pendingSignature=b.signature;return s;
 }
 if(m.action==='Payment'){
  if(keys.length!==1||!p.observers.includes(keys[0]))throw Error('observer_not_authorized');
  const evidence=b.evidence as TransactionEvidence;
  if(evidence.signature!==r.pendingSignature||b.orderHash!==hash(r.order))throw Error('evidence_binding');
  const digest=hash(evidence);if(r.evidenceHash&&r.evidenceHash!==digest){if(!r.conflicts.includes(digest))r.conflicts.push(digest);return s;}
  const payment=validatePayment(r.order,evidence,{network:g.network,genesisHash:g.genesisHash});
  if(r.payment)return s;
  if(s.used[payment.signature])throw Error('transaction_reuse');
  for(const c of payment.credits)if(s.used[payment.signature+'/'+c.instruction])throw Error('instruction_reuse');
  s.used[payment.signature]=r.order.id;for(const c of payment.credits){s.used[payment.signature+'/'+c.instruction]=r.order.id;s.totals[c.purpose]=(BigInt(s.totals[c.purpose])+BigInt(c.amount)).toString();}
  r.payment=payment;r.evidenceHash=digest;return s;
 }
 if(keys.length!==1||!p.executors.includes(keys[0])||!r.payment||r.conflicts.length||!r.order.archive)throw Error('executor_not_authorized_or_payment_conflict');
 if(m.action==='UploadPlan'){
  const plan=b.plan as RecordState['plan'];if(!plan||typeof plan.ciphertext!=='string'||createHash('sha256').update(plan.ciphertext).digest('hex')!==r.order.archive.digest||Buffer.byteLength(plan.ciphertext)!==r.order.archive.bytes||!/^[A-Za-z0-9_-]{43}$/.test(plan.id)||typeof plan.rawBase64!=='string')throw Error('upload_binding');
  const { DataItem } = await import('@dha-team/arbundles/web');
  const raw=Buffer.from(plan.rawBase64,'base64');if(raw.readUInt16LE(0)!==4)throw Error('unsupported_upload_signature_type');
  const item=new DataItem(raw);if(!await item.isValid()||item.id!==plan.id||item.rawData.toString()!==plan.ciphertext)throw Error('invalid_signed_upload_bytes');
  if(r.plan&&hash(r.plan)!==hash(plan))throw Error('upload_attempt_replacement');r.plan=plan;return s;
 }
 if(m.action==='UploadResult'){
  if(!r.plan||b.id!==r.plan.id||typeof b.retrieved!=='boolean')throw Error('upload_result_binding');
  if(b.accepted){const accepted=b.accepted as RecordState['accepted'];if(accepted?.id!==r.plan.id||accepted.winc!=='0')throw Error('sandbox_receipt');r.accepted=accepted;}
  if(b.retrieved&&!r.accepted)throw Error('retrieval_without_receipt');r.retrieved=r.retrieved||Boolean(b.retrieved);return s;
 }
 throw Error('unsupported_action');
}
/** Signed checkpoints detect missing prefix/tail against an independently pinned head.
 * They are NOT AO scheduler proofs or proof of Arweave availability. */
export type Checkpoint={domain:typeof DOMAIN;processId:string;sequence:number;head:string;stateHash:string};
export async function replay(g:Genesis,creationHash:string,entries:Entry[],expected:Checkpoint){
 let state=initial(g,creationHash),previous=hash(g),sequence=0;
 for(const entry of entries){sequence++;if(entry.sequence!==sequence||entry.previous!==previous||hash({sequence,previous,event:entry.event})!==entry.hash)throw Error('incomplete_or_modified_history');state=await apply(state,entry.event,g);previous=entry.hash;}
 if(expected.domain!==DOMAIN||expected.processId!==g.processId||expected.sequence!==sequence||expected.head!==previous||expected.stateHash!==hash(state))throw Error('checkpoint_mismatch');return state;
}
export class Journal{
 state:State;entries:Entry[]=[];
 constructor(readonly genesis:Genesis,readonly creationHash:string){this.state=initial(genesis,creationHash);}
 async append(event:Signed){const next=await apply(this.state,event,this.genesis);const previous=this.entries.at(-1)?.hash??hash(this.genesis),sequence=this.entries.length+1;const entry={sequence,previous,event,hash:hash({sequence,previous,event})};this.entries.push(entry);this.state=next;return entry;}
 checkpoint():Checkpoint{return {domain:DOMAIN,processId:this.genesis.processId,sequence:this.entries.length,head:this.entries.at(-1)?.hash??hash(this.genesis),stateHash:hash(this.state)};}
}
