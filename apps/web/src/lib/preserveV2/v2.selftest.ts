import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import 'fake-indexeddb/auto';
import bs58 from 'bs58';
import { ComputeBudgetProgram, PublicKey, SystemProgram } from '@solana/web3.js';
import { PRESERVATION_V2_PILOT_POLICY as P, saveId, sha256 } from './policy';
import { assertArQuote } from './arweave';
import { buildPayment, discoverPayment, isUserRejection, type SolanaReader } from './solana';
import { verifyPayment, verifyRetrievedArchive } from './verify';
import { readSession, updateSession, withSessionLock } from './store';
import type { SaveSession } from './types';

Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
Object.defineProperty(globalThis,'navigator',{value:{locks:{request:async(_name:string,_opts:unknown,fn:()=>Promise<unknown>)=>fn()}},configurable:true});
let passed=0;
async function test(name:string,fn:()=>unknown|Promise<unknown>){await fn();passed++;console.log('PASS V2 '+name);}
const payer = new PublicKey(P.payer), service = new PublicKey(P.service), ref = new PublicKey(new Uint8Array(32).fill(11));
const id=await saveId();
const sample:SaveSession={schema:'sejire/preservation-v2/v1',saveId:id,vaultId:P.vaultId,archiveDigest:P.archiveDigest,
 archiveBytes:P.archiveBytes,archiveText:'synthetic encrypted fixture',payer:P.payer,solanaReference:ref.toBase58(),state:'SOLANA_PENDING',
 solanaBlockhash:'synthetic-blockhash',solanaLastValidBlockHeight:100,solanaPreparedSlot:50,solanaAttempted:true,
 createdAt:1,updatedAt:1,revision:0};
const transfer={program:'system',programId:SystemProgram.programId,parsed:{type:'transfer',info:{source:P.payer,destination:P.service,lamports:P.serviceLamports}}};
const budget={programId:ComputeBudgetProgram.programId,data:bs58.encode(Uint8Array.from([2,64,13,3,0]))};
const tx=(instructions:unknown[]=[transfer,budget],keys:unknown[]=[{pubkey:payer,signer:true,writable:true},{pubkey:service,signer:false,writable:true},{pubkey:ref,signer:false,writable:false}])=>({
 slot:101,transaction:{signatures:['sig'],message:{accountKeys:keys,instructions}},meta:{err:null,fee:5000,innerInstructions:[]}
});
function reader(value:unknown=tx(),history:{signature:string;err:unknown}[]=[],height=101,oldest=0):SolanaReader {
 return {getGenesisHash:async()=> 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  getLatestBlockhash:async()=>({blockhash:'synthetic',lastValidBlockHeight:100}),getBlockHeight:async()=>height,
  getSlot:async()=>101,getMinimumLedgerSlot:async()=>oldest,
  getSignaturesForAddress:async()=>history,getParsedTransaction:async()=>value as never};
}
await test('stable deterministic save ID',async()=>assert.equal(await saveId(),id));
await test('one prepared service transfer and one reference',()=>{const built=buildPayment(sample,'11111111111111111111111111111111');assert.equal(built.instructions.length,2);assert(built.instructions[1].keys.some(k=>k.pubkey.equals(ref)));});
await test('finalized economic payment accepts ComputeBudget',()=>verifyPayment(sample,'sig',reader()));
await test('changed recipient rejected',()=>assert.rejects(()=>verifyPayment(sample,'sig',reader(tx([{...transfer,parsed:{type:'transfer',info:{source:P.payer,destination:P.fund,lamports:P.serviceLamports}}}])))));
await test('changed amount rejected',()=>assert.rejects(()=>verifyPayment(sample,'sig',reader(tx([{...transfer,parsed:{type:'transfer',info:{source:P.payer,destination:P.service,lamports:1}}}])))));
await test('additional value transfer rejected',()=>assert.rejects(()=>verifyPayment(sample,'sig',reader(tx([transfer,transfer])))));
await test('changed payer rejected',()=>assert.rejects(()=>verifyPayment(sample,'sig',reader(tx([transfer],[{pubkey:service,signer:true},{pubkey:ref,signer:false}])))));
await test('missing reference rejected',()=>assert.rejects(()=>verifyPayment(sample,'sig',reader(tx([transfer],[{pubkey:payer,signer:true},{pubkey:service,signer:false}])))));
await test('missing payer signature rejected',()=>assert.rejects(()=>verifyPayment(sample,'sig',reader(tx([transfer],[{pubkey:payer,signer:false},{pubkey:service,signer:false},{pubkey:ref,signer:false}])))));
await test('unknown instruction rejected',()=>assert.rejects(()=>verifyPayment(sample,'sig',reader(tx([transfer,{programId:service,data:'1'}])))));
await test('unsafe compute budget rejected',()=>assert.rejects(()=>verifyPayment(sample,'sig',reader(tx([transfer,{...budget,data:bs58.encode(Uint8Array.from([3,255,255,255,255,255,255,255,255]))}])))));
await test('inner value effects rejected',()=>assert.rejects(()=>verifyPayment(sample,'sig',reader({...tx(),meta:{...tx().meta,innerInstructions:[{instructions:[transfer]}]}}))));
await test('failed finalized transaction rejected',()=>assert.rejects(()=>verifyPayment(sample,'sig',reader({...tx(),meta:{...tx().meta,err:{InstructionError:[0,'Custom']}}}))));
await test('wrong Solana network rejected',()=>assert.rejects(()=>verifyPayment(sample,'sig',{...reader(),getGenesisHash:async()=> 'wrong'})));
await test('lost wallet response discovered by reference',async()=>assert.deepEqual(await discoverPayment(sample,[reader(tx(),[{signature:'sig',err:null}]),reader(tx(),[{signature:'sig',err:null}])]),{signature:'sig',absent:false}));
await test('RPC timeout never proves absence',()=>assert.rejects(()=>discoverPayment(sample,[reader(),{...reader(),getBlockHeight:async()=>{throw Error('timeout');}}])));
await test('expired blockhash with complete empty history allows same-reference preparation',async()=>assert.deepEqual(await discoverPayment(sample,[reader(),reader()]),{signature:undefined,absent:true}));
await test('live blockhash blocks a second payment',async()=>assert.equal((await discoverPayment(sample,[reader(tx(),[],100),reader()])).absent,false));
await test('pruned history blocks a second payment',()=>assert.rejects(()=>discoverPayment(sample,[reader(tx(),[],101,51),reader()])));
await test('conflicting reference signatures block a second payment',()=>assert.rejects(()=>discoverPayment(sample,[reader(tx(),[{signature:'one',err:null}]),reader(tx(),[{signature:'two',err:null}])])));
await test('only explicit wallet rejection enables safe retry',()=>{assert(isUserRejection({code:4001}));assert(!isUserRejection(Error('timeout')));});
await test('Arweave exact quote and balance accepted',()=>assertArQuote(P.arReserve,P.archiveBytes,'4000000000','4000000000'));
await test('Arweave quote above cap rejected',()=>assert.throws(()=>assertArQuote(P.arReserve,P.archiveBytes,'4000000001','5000000000')));
await test('wrong Wander address rejected before signing',()=>assert.throws(()=>assertArQuote('A'.repeat(43),P.archiveBytes,'1','1')));
await test('wrong archive size rejected before signing',()=>assert.throws(()=>assertArQuote(P.arReserve,P.archiveBytes+1,'1','1')));
await test('insufficient AR balance rejected',()=>assert.throws(()=>assertArQuote(P.arReserve,P.archiveBytes,'2','1')));
await test('retrieved wrong SHA is never complete',()=>assert.rejects(()=>verifyRetrievedArchive(new Uint8Array(P.archiveBytes))));
await test('synthetic retrieved envelope with exact SHA and vault ID verifies',async()=>{
 const bytes=new TextEncoder().encode(JSON.stringify({schema:'sejire/envelope/v1',vault_id:P.vaultId,cipher:'aes-gcm-256',kdf:'hkdf-sha256',iv:'AAAAAAAAAAAAAAAA',ciphertext:'AAAAAAAAAAAAAAAAAAAAAAAA',protocol:'sejire/v0.3'}));
 const expected={archiveBytes:bytes.length,archiveDigest:await sha256(bytes),vaultId:P.vaultId};
 await verifyRetrievedArchive(bytes,expected);
 await assert.rejects(()=>verifyRetrievedArchive(bytes,{...expected,vaultId:'0'.repeat(32)}));
});
await test('atomic session transition persists after reload',async()=>{
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('sejire-preservation-v2',1);r.onupgradeneeded=()=>r.result.createObjectStore('sessions',{keyPath:'saveId'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 await new Promise<void>((resolve,reject)=>{const t=db.transaction('sessions','readwrite');t.objectStore('sessions').put(sample);t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);});db.close();
 const next=await updateSession(id,s=>({...s,state:'SOLANA_PAID',solanaSignature:'sig'}));
 assert.equal(next.revision,1);assert.equal((await readSession(id))?.solanaSignature,'sig');
});
await test('immutable reference and archive cannot be replaced',()=>assert.rejects(()=>updateSession(id,s=>({...s,solanaReference:service.toBase58()}))));
await test('completed session cannot return to payment',async()=>{await updateSession(id,s=>({...s,state:'AR_READY'}));await updateSession(id,s=>({...s,state:'AR_SIGNED'}));await updateSession(id,s=>({...s,state:'AR_UPLOADING'}));await updateSession(id,s=>({...s,state:'AR_PENDING_CONFIRMATION'}));await updateSession(id,s=>({...s,state:'COMPLETE'}));await assert.rejects(()=>updateSession(id,s=>({...s,state:'READY'})));});
await test('one session lock name serializes actions',async()=>{let count=0;await withSessionLock(id,async()=>{count++;});assert.equal(count,1);});
console.log(`V2 unit assertions: ${passed}`);
