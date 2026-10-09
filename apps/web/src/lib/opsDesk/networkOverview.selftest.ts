import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { ComputeBudgetProgram, PublicKey, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { PRESERVATION_V2_PILOT_POLICY as P, saveId, sha256 } from '../preserveV2/policy';
import type { SolanaReader } from '../preserveV2/solana';
import { fetchAdminNetworkOverview, fetchPilotPayments, pilotPaymentReference } from './networkOverview';

Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const expectedId=await saveId();
const oldDigest=await sha256(new TextEncoder().encode(`reference\0${expectedId}`));
const oldReference=new PublicKey(Uint8Array.from(oldDigest.match(/../g)!.map(x=>parseInt(x,16)))).toBase58();
assert.equal(await pilotPaymentReference(),oldReference,'analytics reference must match unchanged startSession formula');
const ref=new PublicKey(oldReference),payer=new PublicKey(P.payer),service=new PublicKey(P.service);
const transfer=(source:string=P.payer,destination:string=P.service,lamports:number=P.serviceLamports)=>({program:'system',programId:SystemProgram.programId,
  parsed:{type:'transfer',info:{source,destination,lamports}}});
const budget={programId:ComputeBudgetProgram.programId,data:bs58.encode(Uint8Array.from([2,64,13,3,0]))};
const tx=(instructions:unknown[]=[transfer(),budget],payerKey=payer,err:unknown=null)=>({slot:1,blockTime:1_700_000_000,
  transaction:{signatures:['sig'],message:{accountKeys:[{pubkey:payerKey,signer:true},{pubkey:service,signer:false},{pubkey:ref,signer:false}],instructions}},
  meta:{err,fee:5000,innerInstructions:[]}});
const history=[{signature:'sig',err:null}];
function reader(value:unknown=tx(),h=history):SolanaReader{return {
  getGenesisHash:async()=> 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  getLatestBlockhash:async()=>({blockhash:'unused',lastValidBlockHeight:0}),getBlockHeight:async()=>0,
  getSlot:async()=>0,getMinimumLedgerSlot:async()=>0,
  getSignaturesForAddress:async(address)=>{assert.equal(address.toBase58(),oldReference);return h;},
  getParsedTransaction:async()=>value as never,
};}
const valid=await fetchPilotPayments([reader(),reader()]);
assert.equal(valid.length,1);assert.equal(valid[0].lamports,30_000_000);
for(const invalid of [
  tx([transfer(),budget],service),
  tx([transfer(P.payer,P.fund),budget]),
  tx([transfer(P.payer,P.service,1),budget]),
  null,
])assert.deepEqual(await fetchPilotPayments([reader(invalid),reader(invalid)]),[]);
const failedReader={...reader(),getGenesisHash:async()=>{throw Error('RPC down');}};
await assert.rejects(fetchPilotPayments([failedReader,failedReader]));
const row={txId:'T2huxIMLyfYclZH2h89Rf0IecHfFYKKaa0_3HaDP4fo',at:new Date(0).toISOString(),vaultFp:'————',owner:null};
const overview=await fetchAdminNetworkOverview({archives:async()=>[row],payments:async()=>valid,legacy:async()=>null});
assert.equal(overview.trees,1);assert.equal(overview.saves,1);assert.equal(overview.paidCount,1);
assert.equal(overview.receivedLamports,30_000_000);assert.notEqual(overview.archives?.[0].vaultFp,'————');
const unavailable=await fetchAdminNetworkOverview({archives:async()=>[row],payments:async()=>{throw Error('RPC down');}});
assert.equal(unavailable.paidCount,null);assert.equal(unavailable.receivedLamports,null);assert(unavailable.solanaError);
console.log('networkOverview.selftest: reference, valid/invalid finalized payments, RPC unavailable, legacy fingerprint OK');
