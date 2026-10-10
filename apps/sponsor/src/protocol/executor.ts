import { createPrivateKey, createPublicKey, sign, createHash } from 'node:crypto';
import bs58 from 'bs58';
import { Journal, hash, canonical, DOMAIN, replay, genesisPayload, verifiedKeys, type Genesis, type Signed, type Message, type Entry, type Checkpoint } from './journal';
import type { TrustedTransactionReader } from '../checkout/reconciliation';
import type { PreservationService } from '../checkout/preservation';
export function signingKey(seed:Uint8Array){
 if(seed.length!==32)throw Error('invalid_signing_seed');
 const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'});
 const publicKey=bs58.encode(createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32));
 return {publicKey,sign:(value:unknown)=>({publicKey,signature:bs58.encode(sign(null,Buffer.from(canonical(value)),key))})};
}
export type Signer=ReturnType<typeof signingKey>;
export type Export={format:'sejire/local-signed-journal/v1';genesis:Genesis;entries:Entry[];checkpoint:Checkpoint;signatures:Signed['signatures'];storageProof:'NOT_AO_OR_ARWEAVE_PROOF'};
/** One ordered local scheduler. AO transport must authenticate its scheduled history separately.
 * The serialized queue prevents interleaved awaits; callers supply atomic durable publication.
 */
export class ProtocolExecutor{
 private publicationUnknown=false;readonly journal:Journal;private queue:Promise<unknown>=Promise.resolve();
 constructor(g:Genesis,creationHash:string,private checkpointSigners:Signer[],private persist:(value:Export)=>Promise<void>,readonly reader:TrustedTransactionReader,readonly uploader:PreservationService,readonly observer:Signer,readonly executor:Signer){this.journal=new Journal(g,creationHash);}
 export():Export{const checkpoint=this.journal.checkpoint();return {format:'sejire/local-signed-journal/v1',genesis:this.journal.genesis,entries:structuredClone(this.journal.entries),checkpoint,signatures:this.checkpointSigners.map(s=>s.sign(checkpoint)),storageProof:'NOT_AO_OR_ARWEAVE_PROOF'};}
 async restore(saved:Export,expected:Checkpoint){
  if(hash(saved.genesis)!==hash(this.journal.genesis)||hash(saved.checkpoint)!==hash(expected))throw Error('untrusted_checkpoint');
  const state=await replay(saved.genesis,this.journal.creationHash,saved.entries,expected);
  const keys=verifiedKeys(expected,saved.signatures);if(keys.filter(k=>state.policy.managers.includes(k)).length<state.policy.threshold)throw Error('checkpoint_threshold');
  this.journal.state=state;this.journal.entries=structuredClone(saved.entries);this.publicationUnknown=false;
 }
 private async atomic(event:Signed){
  if(this.publicationUnknown)throw Error('journal_publication_requires_reconciliation');
  const backup=this.export();await this.journal.append(event);try{await this.persist(this.export());}
  catch(error){this.journal.state=await replay(backup.genesis,this.journal.creationHash,backup.entries,backup.checkpoint);this.journal.entries=backup.entries;this.publicationUnknown=true;throw error;}
 }
 submit(event:Signed):Promise<void>{const result=this.queue.then(()=>this.atomic(event));this.queue=result.catch(()=>{});return result;}
 signed(action:Message['action'],body:Message['body'],signer:Signer):Signed{const policy=this.journal.state.policy;const message:Message={domain:DOMAIN,processId:this.journal.genesis.processId,epoch:policy.epoch,policyVersion:policy.version,action,body};return {message,signatures:[signer.sign(message)]};}
 access(id:string,token:string){const r=this.journal.state.orders[id];if(!r||!/^[a-f0-9]{64}$/.test(token))throw Error('unauthorized');const s=signingKey(Buffer.from(token,'hex'));if(hash(s.publicKey)!==r.accessHash)throw Error('unauthorized');return s;}
 snapshot(id:string){const r=this.journal.state.orders[id];if(!r)throw Error('unknown_order');return {record:{order:r.order,...(r.pendingSignature?{pendingSignature:r.pendingSignature}:{}),...(r.payment?{payment:r.payment}:{}),states:{payment:r.conflicts.length?'conflict':r.payment?'verified':r.pendingSignature?'requires-reconciliation':'awaiting-payment',contribution:r.order.fundContribution.amount==='0'?'not-requested':r.payment?'received':'awaiting-payment',preservation:r.order.kind==='contribution'?'not-applicable':r.retrieved?'completed':r.plan?'requires-reconciliation':r.payment?'ready':'awaiting-payment'}},execution:r.plan?{id:r.plan.id,accepted:r.accepted??null,retrieved:Boolean(r.retrieved),vaultId:JSON.parse(r.plan.ciphertext).vault_id}:null};}
 async reserve(id:string,signature:string,token:string){const signer=this.access(id,token);await this.submit(this.signed('Pending',{orderId:id,signature},signer));return this.snapshot(id);}
 async reconcile(id:string,token:string){this.access(id,token);const r=this.journal.state.orders[id];if(!r.pendingSignature)throw Error('no_pending_payment');if(r.payment)return this.snapshot(id);
  // RPC OUTSIDE atomic journal publication; replay reads stored evidence, never RPC.
  const evidence=await this.reader.read(r.pendingSignature);if(!evidence)return {reason:'not-found',...this.snapshot(id)};
  await this.submit(this.signed('Payment',{orderId:id,orderHash:hash(r.order),evidence},this.observer));return this.snapshot(id);
 }
 private uploads=new Map<string,Promise<ReturnType<ProtocolExecutor['snapshot']>>>();
 execute(id:string,ciphertext:string,token:string){this.access(id,token);const r=this.journal.state.orders[id];if(!r.payment||r.conflicts.length||!r.order.archive)throw Error('payment_not_verified');if(Buffer.byteLength(ciphertext)!==r.order.archive.bytes||createHash('sha256').update(ciphertext).digest('hex')!==r.order.archive.digest)throw Error('archive_mismatch');
  const old=this.uploads.get(id);if(old)return old;
  const result=this.executeOne(id,ciphertext);this.uploads.set(id,result);void result.finally(()=>this.uploads.delete(id)).catch(()=>{});return result;
 }
 private async executeOne(id:string,ciphertext:string){let r=this.journal.state.orders[id];if(r.retrieved)return this.snapshot(id);
  if(!r.plan){const plan=await this.uploader.sign(r.order,ciphertext);await this.submit(this.signed('UploadPlan',{orderId:id,plan:{id:plan.id,rawBase64:plan.rawBase64,ciphertext}},this.executor));r=this.journal.state.orders[id];}
  // Second executor reuses signed bytes and ID; never receives first executor's key.
  const plan={id:r.plan!.id,rawBase64:r.plan!.rawBase64,envelope:JSON.parse(ciphertext),maxWinc:'0'};
  if(!r.accepted){const accepted=await this.uploader.upload(plan);await this.submit(this.signed('UploadResult',{orderId:id,id:plan.id,accepted:{id:accepted.id,winc:accepted.winc},retrieved:false},this.executor));}
  if(await this.uploader.retrieve(plan.id,r.order.archive!.digest))await this.submit(this.signed('UploadResult',{orderId:id,id:plan.id,retrieved:true},this.executor));
  return this.snapshot(id);
 }
}
export function testGenesis(codeHash:string,managers:Signer[],observers:Signer[],executors:Signer[],service:string,fund:string):Genesis{
 const payload:Omit<Genesis,'creation'>={domain:DOMAIN,processId:'LOCAL-SIGNED-PILOT-NOT-AO',codeHash,runtime:'Node22/Ed25519/canonical-json-v1',network:'devnet' as const,genesisHash:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',policy:{epoch:0,version:'sol-003-journal-v1',serviceLamports:'30000000',serviceRecipient:service,fundRecipient:fund,managers:managers.map(s=>s.publicKey),threshold:2,observers:observers.map(s=>s.publicKey),executors:executors.map(s=>s.publicKey)}};
 return {...payload,creation:managers.slice(0,2).map(s=>s.sign(payload))};
}
