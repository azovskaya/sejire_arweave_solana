import { PublicKey, Transaction, TransactionInstruction, Message, ComputeBudgetProgram } from '@solana/web3.js';
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import type { Config, MessageWallet } from './config';
import type { NativeJob } from './jobs';
import { validateJob, readyForOrder } from './jobs';
import { findPaymentByReference, onRpc, rpc } from './rpc';
import { cachedJobs, saveJob } from './cache';
export type NativeSolWallet = MessageWallet & { connect():Promise<unknown>; signTransaction(tx:Transaction):Promise<Transaction> };
const COMPUTE_UNIT_LIMIT=50000;
const PRIORITY_MICROLAMPORTS=1000;
const budgetInstructions=()=>[ComputeBudgetProgram.setComputeUnitLimit({units:COMPUTE_UNIT_LIMIT}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:PRIORITY_MICROLAMPORTS})];
async function walletDeadline<T>(promise:Promise<T>,code:string):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(code)),60000);})]);}finally{if(timer)clearTimeout(timer);}}
function paymentSemantics(tx:Transaction){return JSON.stringify({feePayer:tx.feePayer?.toBase58()??null,recentBlockhash:tx.recentBlockhash??null,instructions:tx.instructions.map(ix=>({programId:ix.programId.toBase58(),data:Buffer.from(ix.data).toString('base64'),keys:ix.keys.map(k=>({pubkey:k.pubkey.toBase58(),isSigner:k.isSigner,isWritable:k.isWritable}))}))});}
function expectedAttemptTransaction(job:NativeJob){if(!job.attempt)throw Error('prepared_attempt_required');return Transaction.populate(Message.from(Buffer.from(job.attempt.message,'base64')));}
function validateWalletSignedResult(signed:Transaction,job:NativeJob){if(signed.signatures.length!==1||signed.signatures[0]?.publicKey.toBase58()!==job.order.payer||!signed.signatures[0]?.signature||!signed.verifySignatures())throw Error('wallet_changed_transaction');if(paymentSemantics(signed)!==paymentSemantics(expectedAttemptTransaction(job)))throw Error('wallet_changed_transaction');validatePaymentTemplate(signed,job);}
export function solWallet():NativeSolWallet {
 type Provider=Omit<NativeSolWallet,'signMessage'> & {signMessage:(bytes:Uint8Array,display?:string)=>Promise<Uint8Array|{signature:Uint8Array;publicKey?:{toString():string}}>};
 const w=window as unknown as {phantom?:{solana?:Provider};solana?:Provider};
 const provider=w.phantom?.solana??w.solana;if(!provider)throw Error('phantom_not_found');if(typeof provider.signTransaction!=='function')throw Error('wallet_transaction_signing_unavailable');
 return {get publicKey(){return provider.publicKey;},connect:()=>walletDeadline(provider.connect(),'wallet_connect_timeout'),
  async signMessage(bytes){if(typeof provider.signMessage!=='function')throw Error('message_signature_not_supported');const address=provider.publicKey?.toString();if(!address)throw Error('wallet_not_connected');const result=await walletDeadline(provider.signMessage(bytes,'utf8'),'wallet_message_timeout');if(!result||typeof result!=='object')throw Error('invalid_message_signature');if(provider.publicKey?.toString()!==address||!(result instanceof Uint8Array)&&result.publicKey&&result.publicKey.toString()!==address)throw Error('wallet_changed');const signature=result instanceof Uint8Array?result:result.signature;if(!(signature instanceof Uint8Array)||signature.length!==64)throw Error('invalid_message_signature');return signature;},
  signTransaction:tx=>provider.signTransaction(tx)};
}
export async function preparePayment(c:Config,job:NativeJob) {
 if(await (await import('./cache')).readCache('retired-prepayment-'+job.order.id))throw Error('saving_replaced');
 await validateJob(job,c);if(job.paymentSignature||job.reconciledSignature||job.signingStarted)throw Error('previous_payment_requires_reconciliation');
 if(job.order.expiresAt<=Date.now())throw Error('order_expired');
 if(job.order.archive)await readyForOrder(c,job.order.archive.bytes,job.order.archive.digest);
 return onRpc(c,async url=>{
 const block=await rpc<{value:{blockhash:string;lastValidBlockHeight:number}}>(url,'getLatestBlockhash',[{commitment:'finalized'}]);
 const tx=new Transaction({feePayer:new PublicKey(job.order.payer),recentBlockhash:block.value.blockhash});
 for(const ix of budgetInstructions())tx.add(ix);
 for(const part of [job.order.servicePayment,job.order.fundContribution])if(part.amount!=='0'){
 const data=Buffer.alloc(12);data.writeUInt32LE(2);data.writeBigUInt64LE(BigInt(part.amount),4);
 tx.add(new TransactionInstruction({programId:new PublicKey('11111111111111111111111111111111'),data,keys:[{pubkey:new PublicKey(job.order.payer),isSigner:true,isWritable:true},{pubkey:new PublicKey(part.recipient),isSigner:false,isWritable:true},{pubkey:new PublicKey(job.order.reference),isSigner:false,isWritable:false}]}));
 }
 const fee=await rpc<{value:number|null}>(url,'getFeeForMessage',[Buffer.from(tx.compileMessage().serialize()).toString('base64'),{commitment:'finalized'}]);
 const balance=await rpc<{value:number}>(url,'getBalance',[job.order.payer,{commitment:'finalized'}]);
 if(fee.value===null||!Number.isSafeInteger(fee.value)||fee.value<=0||fee.value>100000||!Number.isSafeInteger(balance.value)||BigInt(balance.value)<BigInt(job.order.total)+BigInt(fee.value))throw Error('fee_or_balance_not_ready');
 job.attempt={id:crypto.randomUUID(),phase:'prepared',message:tx.serializeMessage().toString('base64'),blockhash:block.value.blockhash,lastValidBlockHeight:block.value.lastValidBlockHeight,at:Date.now()};await saveJob(job);
 return {transaction:tx,rpc:url,feeLamports:String(fee.value),lastValidBlockHeight:block.value.lastValidBlockHeight};
 });
}
export async function signAndBroadcast(c:Config,job:NativeJob,wallet:NativeSolWallet,prepared:Awaited<ReturnType<typeof preparePayment>>,allowMainnet=false) {
 if(c.environment==='mainnet-beta'&&!allowMainnet)throw Error('mainnet_payment_disabled');
 if(!navigator.locks)throw Error('exclusive_browser_lock_unavailable');
 await navigator.locks.request('sejire-native-payment-'+job.order.id,async()=>{
 if(await (await import('./cache')).readCache('retired-prepayment-'+job.order.id))throw Error('saving_replaced');

 const existing=(await cachedJobs()).find(j=>j.order.id===job.order.id);
 if(existing?.paymentSignature||existing?.signingStarted||job.paymentSignature||job.signingStarted)throw Error('previous_payment_requires_reconciliation');
 if(wallet.publicKey?.toString()!==job.order.payer||Date.now()>job.order.expiresAt)throw Error('payer_changed_or_expired');
 if(job.order.archive)await readyForOrder(c,job.order.archive.bytes,job.order.archive.digest);
 const before=prepared.transaction.serializeMessage().toString('base64');
 if(!job.attempt||job.attempt.message!==before||job.attempt.phase!=='prepared')throw Error('prepared_attempt_required');
 const height=await rpc<number>(prepared.rpc,'getBlockHeight',[{commitment:'finalized'}]);if(!Number.isSafeInteger(height)||height>job.attempt.lastValidBlockHeight){job.attempt.phase='expired_unexecuted';await saveJob(job);throw Error('prepared_message_expired');}
 validateAttempt(job);
 job.signingStarted=true;job.attempt.phase='wallet_pending';await saveJob(job);
 let signed:Transaction;
 const signing=wallet.signTransaction(prepared.transaction);let timer:ReturnType<typeof setTimeout>|undefined;
 try{signed=await Promise.race([signing,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('wallet_response_timeout')),60000);})]);}
 catch(e){const rejected=Boolean(e&&typeof e==='object'&&'code'in e&&e.code===4001);job.attempt.phase=rejected?'rejected':'signature_unknown';job.attempt.error=rejected?'wallet_rejected':e instanceof Error?e.message:'wallet_response_unknown';if(rejected)job.signingStarted=false;await saveJob(job,rejected);
 // A late signature is retained, but NEVER broadcast by the timed-out action.
 if(e instanceof Error&&e.message==='wallet_response_timeout')void signing.then(async late=>{if(wallet.publicKey?.toString()!==job.order.payer)return;try{validateWalletSignedResult(late,job);}catch{return;}job.paymentSignature=bs58.encode(late.signatures[0].signature!);job.signedPayment=late.serialize().toString('base64');job.attempt!.phase='signed';if(late.serializeMessage().toString('base64')!==before)job.attempt!.error='wallet_message_reencoded_semantically_equal';validateSignedPayment(job);await saveJob(job);}).catch(()=>{});
 throw e;}finally{if(timer)clearTimeout(timer);}

 try{if(wallet.publicKey?.toString()!==job.order.payer)throw Error('wallet_account_changed');validateWalletSignedResult(signed,job);}catch(e){job.attempt.phase='signature_unknown';job.attempt.error=e instanceof Error?e.message:'wallet_changed_transaction';await saveJob(job);throw e;}
 const reencoded=signed.serializeMessage().toString('base64')!==before;job.paymentSignature=bs58.encode(signed.signatures[0].signature!);job.signedPayment=signed.serialize().toString('base64');job.attempt.phase='signed';job.attempt.error=reencoded?'wallet_message_reencoded_semantically_equal':undefined;validateSignedPayment(job);await saveJob(job);
 if(Date.now()>job.order.expiresAt)throw Error('signed_payment_expired_not_broadcast');
 // One broadcast only. Lost response remains journaled; repeat means reconcile, never a new payment.
 await onRpc(c,async url=>{if(url!==prepared.rpc)throw Error('recheck_original_rpc');return rpc(url,'sendTransaction',[job.signedPayment,{encoding:'base64',skipPreflight:false,maxRetries:2}]);});job.attempt.phase='broadcast';await saveJob(job);
 });
}

/** Validate portable signed payment bytes before importing an untrusted pending signature. */
export function validateSignedPayment(job:NativeJob) {
 if(!job.signedPayment||!job.paymentSignature)throw Error('signed_payment_bytes_required');
 const tx=Transaction.from(Buffer.from(job.signedPayment,'base64'));
 if(tx.signatures.length!==1||!tx.verifySignatures()||tx.signatures[0]?.publicKey.toBase58()!==job.order.payer||!tx.signatures[0]?.signature||bs58.encode(tx.signatures[0].signature)!==job.paymentSignature||tx.feePayer?.toBase58()!==job.order.payer)throw Error('invalid_signed_payment');
 validatePaymentTemplate(tx,job);if(job.attempt){const unsigned=Transaction.populate(Message.from(Buffer.from(job.attempt.message,'base64')));if(paymentSemantics(tx)!==paymentSemantics(unsigned))throw Error('payment_attempt_binding');}
}
function sameInstruction(a:TransactionInstruction,b:TransactionInstruction){return a.programId.equals(b.programId)&&Buffer.from(a.data).equals(Buffer.from(b.data))&&a.keys.length===b.keys.length&&a.keys.every((k,i)=>k.pubkey.equals(b.keys[i].pubkey)&&k.isSigner===b.keys[i].isSigner&&k.isWritable===b.keys[i].isWritable);}
function validatePaymentTemplate(tx:Transaction,job:NativeJob) {
 const transfers=[job.order.servicePayment,job.order.fundContribution].filter(p=>p.amount!=='0'),budget=budgetInstructions();
 if(tx.instructions.length!==budget.length+transfers.length||!sameInstruction(tx.instructions[0],budget[0])||!sameInstruction(tx.instructions[1],budget[1]))throw Error('unexpected_payment_instructions');
 for(let i=0;i<transfers.length;i++){
 const ix=tx.instructions[i+budget.length],part=transfers[i];
 if(ix.programId.toBase58()!=='11111111111111111111111111111111'||ix.data.length!==12||ix.data.readUInt32LE(0)!==2||ix.data.readBigUInt64LE(4).toString()!==part.amount||ix.keys.length!==3||ix.keys[0].pubkey.toBase58()!==job.order.payer||!ix.keys[0].isSigner||!ix.keys[0].isWritable||ix.keys[1].pubkey.toBase58()!==part.recipient||ix.keys[1].isSigner||!ix.keys[1].isWritable||ix.keys[2].pubkey.toBase58()!==job.order.reference||ix.keys[2].isSigner||ix.keys[2].isWritable)throw Error('signed_payment_template_mismatch');
 }
}

export type UnknownPaymentResolution={state:'found';signature:string}|{state:'expired_unexecuted'}|{state:'unknown'};
/** DEVNET-only escape hatch for a wallet request that never returned signed bytes.
 * It never assumes absence from one read means no payment: the reference must have no finalized candidate,
 * no confirmed signature may exist, and the original blockhash must already be expired. */
export async function resolveUnknownPaymentAttempt(c:Config,job:NativeJob):Promise<UnknownPaymentResolution> {
 await validateJob(job,c);
 const known=job.paymentSignature??job.reconciledSignature;if(known)return {state:'found',signature:known};
 if(c.environment!=='devnet'||job.order.network!=='devnet'||!job.signingStarted||job.signedPayment||!job.attempt||!['wallet_pending','signature_unknown'].includes(job.attempt.phase))return {state:'unknown'};
 const found=await findPaymentByReference(c,job.order);if(found.signature){job.reconciledSignature=found.signature;await saveJob(job);return {state:'found',signature:found.signature};}
 if(found.pageComplete!==true)return {state:'unknown'};
 const safe=await onRpc(c,async url=>{const confirmed=await rpc<{signature:string}[]>(url,'getSignaturesForAddress',[job.order.reference,{commitment:'confirmed',limit:1}]);if(!Array.isArray(confirmed))throw Error('missing_metadata');if(confirmed.length)return false;const height=await rpc<number>(url,'getBlockHeight',[{commitment:'finalized'}]);if(!Number.isSafeInteger(height))throw Error('missing_metadata');return height>job.attempt!.lastValidBlockHeight;});
 if(!safe)return {state:'unknown'};
 job.attempt.phase='expired_unexecuted';job.attempt.error='wallet_response_missing_blockhash_expired';job.signingStarted=false;await saveJob(job,false,true);return {state:'expired_unexecuted'};
}

export function validateAttempt(job:NativeJob) {
 const a=job.attempt;if(!a)return;
 if(Object.keys(a).some(k=>!['id','phase','message','blockhash','lastValidBlockHeight','at','error'].includes(k))||typeof a.id!=='string'||!['prepared','wallet_pending','rejected','signature_unknown','signed','broadcast','finalized','failed','expired_unexecuted'].includes(a.phase)||!Number.isSafeInteger(a.lastValidBlockHeight)||a.lastValidBlockHeight<1||!Number.isSafeInteger(a.at)||typeof a.message!=='string'||a.message.length>5000)throw Error('invalid_payment_attempt');
 if(['wallet_pending','signature_unknown','signed','broadcast','finalized','failed'].includes(a.phase)&&job.signingStarted!==true)throw Error('invalid_payment_attempt');
 const tx=Transaction.populate(Message.from(Buffer.from(a.message,'base64')));
 if(tx.feePayer?.toBase58()!==job.order.payer||tx.recentBlockhash!==a.blockhash)throw Error('payment_attempt_binding');validatePaymentTemplate(tx,job);
 if(job.signedPayment){const signed=Transaction.from(Buffer.from(job.signedPayment,'base64'));if(paymentSemantics(signed)!==paymentSemantics(tx))throw Error('payment_attempt_binding');}
}
/** Never obtains another signature: optional retry is only the exact journaled bytes. */
export async function resumeSignedPayment(c:Config,job:NativeJob) {
 await validateJob(job,c);if(!job.signedPayment||!job.paymentSignature||!job.attempt)throw Error('legacy_attempt_cannot_be_rebroadcast');if(Date.now()>=job.order.expiresAt)throw Error('signed_payment_expired_not_broadcast');
 return onRpc(c,async url=>{const status=await rpc<{value:({err:unknown}|null)[]}>(url,'getSignatureStatuses',[[job.paymentSignature],{searchTransactionHistory:true}]);if(status.value?.[0]!==null)return;
 const height=await rpc<number>(url,'getBlockHeight',[{commitment:'finalized'}]);if(!Number.isSafeInteger(height)||height>job.attempt!.lastValidBlockHeight)throw Error('signed_message_expired_requires_reconciliation');
 await rpc(url,'sendTransaction',[job.signedPayment,{encoding:'base64',skipPreflight:false,maxRetries:1}]);job.attempt!.phase='broadcast';await saveJob(job);
 });
}
