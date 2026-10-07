import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { PRESERVATION_V2_PILOT_POLICY as P } from './policy';
import { pay, prepareArweave, reconcileSave, saveToArweave, productionServices, type MachineServices } from './machine';
import { sha256 } from './policy';
import { verifyRetrievedArchive } from './verify';
import { withTimeout } from './timeout';
import type { SaveSession } from './types';

const signature='1'.repeat(88), reference=new PublicKey(new Uint8Array(32).fill(7)).toBase58();
const initial=():SaveSession=>({schema:'sejire/preservation-v2/v1',saveId:'synthetic-save',vaultId:P.vaultId,
 archiveDigest:P.archiveDigest,archiveBytes:P.archiveBytes,archiveText:'synthetic encrypted fixture',payer:P.payer,
 solanaReference:reference,state:'READY',createdAt:1,updatedAt:1,revision:0});
type Control={session:SaveSession; phantomCalls:number; wanderCalls:number; uploadCalls:number; sent:boolean;
 rejectPhantom?:boolean; rejectWander?:boolean; lostResponse?:boolean; rpcTimeout?:boolean;
 hangPhantom?:boolean; hangWander?:boolean;
 expired?:boolean; walletChanged?:boolean; uploadTimeout?:boolean; wrongHash?:boolean;
 signedBeforeUpload?:boolean;};
function harness(change:Partial<Control>={}) {
 const c:Control={session:initial(),phantomCalls:0,wanderCalls:0,uploadCalls:0,sent:false,...change};
 let queue=Promise.resolve();
 const wallet={publicKey:new PublicKey(P.payer),async connect(){return {publicKey:new PublicKey(P.payer)};},
  async signAndSendTransaction(){c.phantomCalls++;
   if(c.rejectPhantom)throw {code:4001};
   if(c.walletChanged)wallet.publicKey=new PublicKey(P.service);
   c.sent=true;if(c.hangPhantom)return new Promise<{signature:string}>(()=>{});
   if(c.lostResponse)throw Error('synthetic lost wallet response');
   return {signature};}};
 const arWallet={async connect(){},async getActiveAddress(){return P.arReserve;},async getActivePublicKey(){return 'synthetic-public-key';},async sign(){throw Error('use signAr driver');}};
 const d:MachineServices={...productionServices,
  id:async()=>c.session.saveId, read:async()=>structuredClone(c.session),
  walletTimeoutMs:5,
  update:async(_id,fn)=>{c.session={...fn(structuredClone(c.session)),revision:c.session.revision+1};return structuredClone(c.session);},
  lock:async(_id,fn)=>{const previous=queue;let release!:()=>void;queue=new Promise<void>(resolve=>{release=resolve;});await previous;try{return await fn();}finally{release();}},
  archive:async()=>{}, rpc:()=>({getGenesisHash:async()=>'',getLatestBlockhash:async()=>({blockhash:'new-blockhash',lastValidBlockHeight:100}),
   getSlot:async()=>50,getBlockHeight:async()=>101,getMinimumLedgerSlot:async()=>0,getSignaturesForAddress:async()=>[],getParsedTransaction:async()=>null}),
  readers:()=>[productionServices.rpc(),productionServices.rpc()],devnet:async()=>{},phantom:()=>wallet,
  discover:async()=>{if(c.rpcTimeout)throw Error('synthetic RPC timeout');return {signature:c.sent?signature:undefined,failedSignatures:[],absent:Boolean(!c.sent&&c.expired)};},
  verifySolana:async(_session,sig)=>{assert.equal(sig,signature);},
  wander:()=>arWallet, quoteAr:async()=>({reward:'1000',balance:'2000'}),
  signAr:async(_session,_wallet,_reward,beforeSign,timeoutMs)=>{await beforeSign?.();c.wanderCalls++;
    if(c.hangWander)await withTimeout(new Promise<void>(()=>{}),timeoutMs??60_000,'wander_response_timeout');
    if(c.rejectWander)throw {code:4001};return {id:'A'.repeat(43),reward:'1000',signed:{format:2} as never};},
  validateAr:async()=>{assert(c.session.arSignedTransaction);return {} as never;},
  uploadAr:async(_session,persist)=>{c.uploadCalls++;c.signedBeforeUpload=Boolean(c.session.arSignedTransaction);
    await persist(undefined);if(c.uploadTimeout)throw Error('synthetic upload timeout');},
  verifyAr:async()=>{if(c.wrongHash)throw Error('retrieved_archive_mismatch');},
 };
 return {c,d};
}
let passed=0;
async function test(name:string,fn:()=>unknown|Promise<unknown>){await fn();passed++;console.log('PASS V2 machine '+name);}

await test('A happy path uses one payment, one signing, upload, retrieval verification',async()=>{
 const {c,d}=harness();assert.equal((await pay(d)).state,'SOLANA_PAID');assert.equal((await prepareArweave(d)).session.state,'AR_READY');
 assert.equal((await saveToArweave('1000',d)).state,'AR_PENDING_CONFIRMATION');assert.equal((await reconcileSave(d))?.state,'COMPLETE');
 assert.equal(c.phantomCalls,1);assert.equal(c.wanderCalls,1);assert.equal(c.uploadCalls,1);assert(c.signedBeforeUpload);
});
await test('B double click serializes to one Phantom invocation',async()=>{const {c,d}=harness();await Promise.all([pay(d),pay(d)]);assert.equal(c.phantomCalls,1);});
await test('C explicit Phantom rejection retains same session/reference for retry',async()=>{const {c,d}=harness({rejectPhantom:true});const id=c.session.saveId,ref=c.session.solanaReference;
 assert.equal((await pay(d)).state,'READY');c.rejectPhantom=false;assert.equal((await pay(d)).state,'SOLANA_PAID');assert.equal(c.session.saveId,id);assert.equal(c.session.solanaReference,ref);});
await test('G account switch after broadcast still accepts correct finalized payment',async()=>{const {c,d}=harness({walletChanged:true});assert.equal((await pay(d)).state,'SOLANA_PAID');await pay(d);assert.equal(c.phantomCalls,1);});
await test('H lost wallet response discovered after reload by reference',async()=>{const {c,d}=harness({lostResponse:true});assert.equal((await pay(d)).state,'SOLANA_PENDING');assert.equal((await reconcileSave(d))?.state,'SOLANA_PAID');assert.equal(c.phantomCalls,1);});
await test('Phantom timeout stays pending and reference finds the sent payment',async()=>{const {c,d}=harness({hangPhantom:true});
 assert.equal((await pay(d)).state,'SOLANA_PENDING');assert.equal(c.session.lastError,'phantom_response_timeout');
 assert.equal((await reconcileSave(d))?.state,'SOLANA_PAID');assert.equal(c.phantomCalls,1);});
await test('I RPC timeout keeps pending payment and prevents another Phantom call',async()=>{const {c,d}=harness({lostResponse:true,rpcTimeout:true});assert.equal((await pay(d)).state,'SOLANA_PENDING');await assert.rejects(()=>reconcileSave(d));assert.equal(c.phantomCalls,1);});
await test('J expired absent payment retries same session and reference',async()=>{const {c,d}=harness({lostResponse:true,expired:true});c.session.state='SOLANA_PENDING';c.session.solanaAttempted=true;
 const id=c.session.saveId,ref=c.session.solanaReference;assert.equal((await reconcileSave(d))?.state,'SOLANA_PREPARED');
 c.lostResponse=false;assert.equal((await pay(d)).state,'SOLANA_PAID');assert.equal(c.session.saveId,id);assert.equal(c.session.solanaReference,ref);});
await test('J finalized failed payment retries same session and reference after expiry',async()=>{const {c,d}=harness();c.session.state='SOLANA_PENDING';
 c.session.solanaSignature=signature;c.session.solanaAttempted=true;c.session.solanaBlockhash='old';c.session.solanaLastValidBlockHeight=100;
 d.verifySolana=async()=>{throw Error('payment_transaction_failed');};
 d.discover=async()=>({failedSignatures:[signature],absent:true});
 const ref=c.session.solanaReference,id=c.session.saveId;
 assert.equal((await reconcileSave(d))?.state,'SOLANA_PREPARED');assert.deepEqual(c.session.solanaFailedSignatures,[signature]);
 d.verifySolana=async()=>{};d.discover=async()=>({signature,failedSignatures:[signature],absent:false});
 assert.equal((await pay(d)).state,'SOLANA_PAID');assert.equal(c.session.solanaReference,ref);assert.equal(c.session.saveId,id);});
await test('K uncertain previous payment remains pending',async()=>{const {c,d}=harness();c.session.state='SOLANA_PENDING';c.session.solanaAttempted=true;
 assert.equal((await reconcileSave(d))?.state,'SOLANA_PENDING');await pay(d);assert.equal(c.phantomCalls,0);});
await test('L reload READY does not open wallets',async()=>{const {c,d}=harness();assert.equal((await reconcileSave(d))?.state,'READY');assert.equal(c.phantomCalls,0);assert.equal(c.wanderCalls,0);});
await test('L reload SOLANA_PREPARED preserves same reference',async()=>{const {c,d}=harness();c.session.state='SOLANA_PREPARED';const ref=c.session.solanaReference;
 assert.equal((await reconcileSave(d))?.state,'SOLANA_PREPARED');assert.equal(c.session.solanaReference,ref);});
await test('L reload AR_READY with lost signature response permits safe retry',async()=>{const {c,d}=harness();c.session.state='AR_READY';c.session.arSigningStarted=true;
 assert.equal((await reconcileSave(d))?.state,'AR_READY');assert.equal(c.session.arSigningStarted,false);assert.equal(c.wanderCalls,0);});
await test('L reload SOLANA_PAID and AR_READY preserves the next action',async()=>{for(const state of ['SOLANA_PAID','AR_READY'] as const){
 const {c,d}=harness();c.session.state=state;assert.equal((await reconcileSave(d))?.state,state);assert.equal(c.phantomCalls,0);assert.equal(c.wanderCalls,0);}});
await test('L reload AR_SIGNED resumes same signed ID without Wander',async()=>{const {c,d}=harness();c.session.state='AR_SIGNED';c.session.arTransactionId='A'.repeat(43);c.session.arSignedTransaction={format:2} as never;
 assert.equal((await reconcileSave(d))?.state,'COMPLETE');assert.equal(c.wanderCalls,0);assert.equal(c.session.arTransactionId,'A'.repeat(43));});
await test('L reload COMPLETE and BLOCKED cannot start a new payment',async()=>{for(const state of ['COMPLETE','BLOCKED'] as const){
 const {c,d}=harness();c.session.state=state;assert.equal((await reconcileSave(d))?.state,state);await pay(d);assert.equal(c.phantomCalls,0);}});
await test('M Wander rejection leaves no signed plan and permits retry',async()=>{const {c,d}=harness({rejectWander:true});c.session.state='AR_READY';
 assert.equal((await saveToArweave('1000',d)).state,'AR_READY');assert.equal(c.session.arTransactionId,undefined);
 c.rejectWander=false;assert.equal((await saveToArweave('1000',d)).state,'AR_PENDING_CONFIRMATION');assert.equal(c.wanderCalls,2);});
await test('Wander timeout without signed bytes resets flag and retries without duplicate upload',async()=>{const {c,d}=harness({hangWander:true});c.session.state='AR_READY';
 assert.equal((await saveToArweave('1000',d)).state,'AR_READY');assert.equal(c.session.lastError,'wander_response_timeout');
 assert.equal(c.session.arSigningStarted,false);assert.equal(c.session.arSignedTransaction,undefined);assert.equal(c.uploadCalls,0);
 c.hangWander=false;assert.equal((await saveToArweave('1000',d)).state,'AR_PENDING_CONFIRMATION');
 assert.equal(c.wanderCalls,2);assert.equal(c.uploadCalls,1);});
await test('quote movement before Wander signature permits safe re-quote',async()=>{const {c,d}=harness();c.session.state='AR_READY';
 d.signAr=async()=>{throw Error('ar_quote_changed');};assert.equal((await saveToArweave('1000',d)).state,'AR_READY');
 assert.equal(c.session.arSigningStarted,false);assert.equal(c.wanderCalls,0);});
await test('lost Wander response before persistence permits same-session retry',async()=>{const {c,d}=harness();c.session.state='AR_READY';
 d.signAr=async(_s,_w,_r,beforeSign)=>{await beforeSign?.();c.wanderCalls++;throw Error('synthetic lost response');};
 assert.equal((await saveToArweave('1000',d)).state,'AR_READY');assert.equal(c.session.arSignedTransaction,undefined);
 assert.equal(c.session.arSigningStarted,false);const ref=c.session.solanaReference;await reconcileSave(d);
 assert.equal(c.session.solanaReference,ref);});
await test('N signed transaction survives reload before upload',async()=>{const {c,d}=harness({uploadTimeout:true});c.session.state='AR_READY';
 assert.equal((await saveToArweave('1000',d)).state,'AR_UPLOADING');const arId=c.session.arTransactionId;c.uploadTimeout=false;
 assert.equal((await reconcileSave(d))?.state,'COMPLETE');assert.equal(c.session.arTransactionId,arId);assert.equal(c.wanderCalls,1);});
await test('O upload timeout resumes same signed transaction and progress',async()=>{const {c,d}=harness({uploadTimeout:true});c.session.state='AR_READY';
 await saveToArweave('1000',d);assert.equal(c.session.state,'AR_UPLOADING');assert(c.signedBeforeUpload);
 c.uploadTimeout=false;await reconcileSave(d);assert.equal(c.uploadCalls,2);assert.equal(c.wanderCalls,1);});
await test('P wrong archive blocks payment before Phantom',async()=>{const {c,d}=harness();d.archive=async()=>{throw Error('archive_not_authorized');};
 await assert.rejects(()=>pay(d));assert.equal(c.phantomCalls,0);});
await test('P wrong archive blocks Wander before signing',async()=>{const {c,d}=harness();c.session.state='AR_READY';d.archive=async()=>{throw Error('archive_not_authorized');};
 await assert.rejects(()=>saveToArweave('1000',d));assert.equal(c.wanderCalls,0);});
await test('R wrong Wander address blocks signature',async()=>{const {c,d}=harness();c.session.state='AR_READY';d.wander=()=>({connect:async()=>{},getActiveAddress:async()=> 'wrong',getActivePublicKey:async()=>'',sign:async()=>({})});
 await assert.rejects(()=>saveToArweave('1000',d));assert.equal(c.wanderCalls,0);});
await test('S retrieval hash mismatch never reaches COMPLETE',async()=>{const {c,d}=harness({wrongHash:true});c.session.state='AR_PENDING_CONFIRMATION';
 assert.equal((await reconcileSave(d))?.state,'AR_PENDING_CONFIRMATION');});
await test('T successful confirmed retrieval with exact SHA reaches COMPLETE',async()=>{const {c,d}=harness();c.session.state='AR_PENDING_CONFIRMATION';
 const bytes=new TextEncoder().encode(JSON.stringify({schema:'sejire/envelope/v1',vault_id:P.vaultId,cipher:'aes-gcm-256',kdf:'hkdf-sha256',iv:'AAAAAAAAAAAAAAAA',ciphertext:'AAAAAAAAAAAAAAAAAAAAAAAA',protocol:'sejire/v0.3'}));
 d.verifyAr=async()=>verifyRetrievedArchive(bytes,{archiveBytes:bytes.length,archiveDigest:await sha256(bytes),vaultId:P.vaultId});
 assert.equal((await reconcileSave(d))?.state,'COMPLETE');});
console.log(`V2 machine assertions: ${passed}`);
