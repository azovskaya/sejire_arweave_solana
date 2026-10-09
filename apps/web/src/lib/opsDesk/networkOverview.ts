import { PublicKey } from '@solana/web3.js';
import { fingerprintVaultId } from '../crypto/keys';
import { fetchNetworkSaves } from './feed';
import manifest from '../recovery/legacy-locators.v1.json';
import { PRESERVATION_V2_PILOT_POLICY as P, saveId, sha256 } from '../preserveV2/policy';
import { SOLANA_RPC_URLS, solanaReader, type SolanaReader } from '../preserveV2/solana';
import type { SaveSession } from '../preserveV2/types';
import { verifyPayment } from '../preserveV2/verify';

export type AdminArchive = { txId:string; at:string; vaultFp:string; status:string };
export type AdminPayment = { signature:string; at:string; payer:string; lamports:number; status:'finalized' };
export type NetworkOverview = {
  archives:AdminArchive[] | null;
  trees:number | null;
  saves:number | null;
  payments:AdminPayment[] | null;
  paidCount:number | null;
  receivedLamports:number | null;
  solanaError:boolean;
  arweaveError:boolean;
};

/** The original startSession reference formula, read-only and independent of IndexedDB. */
export async function pilotPaymentReference():Promise<string> {
  const id=await saveId();
  const digest=await sha256(new TextEncoder().encode(`reference\0${id}`));
  return new PublicKey(Uint8Array.from(digest.match(/../g)!.map(hex=>parseInt(hex,16)))).toBase58();
}

const readerTimeout=6500;
async function bounded<T>(promise:Promise<T>):Promise<T>{
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('overview_rpc_timeout')),readerTimeout);
    promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
  });
}

export async function fetchPilotPayments(readers:SolanaReader[]=SOLANA_RPC_URLS.map(solanaReader)):
  Promise<AdminPayment[]> {
  const reference=await pilotPaymentReference();
  const results=await Promise.allSettled(readers.map(reader=>bounded((async()=>{
    if(await reader.getGenesisHash()!=='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')throw Error('wrong_network');
    return {reader,history:await reader.getSignaturesForAddress(new PublicKey(reference),{limit:1000},'finalized')};
  })())));
  const valid=results.filter((r):r is PromiseFulfilledResult<{reader:SolanaReader;history:{signature:string;err:unknown}[]}>=>r.status==='fulfilled').map(r=>r.value);
  if(valid.length<2||valid.some(x=>x.history.length>=1000))throw Error('solana_overview_unavailable');
  const signatures=[...new Set(valid.flatMap(x=>x.history).filter(x=>!x.err).map(x=>x.signature))];
  const session={payer:P.payer,archiveDigest:P.archiveDigest,solanaReference:reference} as SaveSession;
  const payments:AdminPayment[]=[];
  for(const signature of signatures){
    let verified=false;
    for(const {reader} of valid){
      try{await bounded(verifyPayment(session,signature,reader));verified=true;break;}catch{/* Other reader may have the finalized transaction. */}
    }
    if(!verified)continue;
    const tx=await bounded(valid[0].reader.getParsedTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0})).catch(()=>null);
    payments.push({signature,at:tx?.blockTime?new Date(tx.blockTime*1000).toISOString():new Date(0).toISOString(),
      payer:P.payer,lamports:P.serviceLamports,status:'finalized'});
  }
  return payments;
}

type LegacyEntry={vaultId:string;txIds:string[]};
function legacyFingerprint(txId:string):string|undefined {
  const entry=(manifest.entries as LegacyEntry[]).find(row=>row.txIds.includes(txId));
  return entry?fingerprintVaultId(entry.vaultId):undefined;
}
function validLegacyMeta(id:string,raw:unknown):boolean {
  if(!raw||typeof raw!=='object')return false;
  const value=raw as {id?:string;tags?:{name:string;value:string}[]};
  if(value.id!==id||!Array.isArray(value.tags))return false;
  const decode=(s:string)=>{try{return atob(s.replace(/-/g,'+').replace(/_/g,'/'));}catch{return '';}};
  const tag=(name:string)=>value.tags?.find(row=>decode(row.name)===name)?.value;
  return decode(tag('App-Name')??'')==='SEJIRE'&&decode(tag('Type')??'')==='vault-envelope';
}
async function fetchLegacyArchive(id:string):Promise<AdminArchive|null>{
  const attempts=['https://arweave.net','https://ar-io.net','https://g8way.io'].map(async base=>{
    try{
      const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),4500);
      const response=await fetch(`${base}/tx/${id}`,{signal:controller.signal,credentials:'omit',cache:'no-store'}).finally(()=>clearTimeout(timer));
      if(response.ok&&validLegacyMeta(id,await response.json()))return {txId:id,at:new Date(0).toISOString(),
        vaultFp:legacyFingerprint(id)??'Legacy archive',status:'Legacy archive'};
    }catch{/* Try another public gateway. */}
    throw Error('legacy_metadata_unavailable');
  });
  return Promise.any(attempts).catch(()=>null);
}

export async function fetchAdminNetworkOverview(deps:{
  archives?:()=>Promise<Awaited<ReturnType<typeof fetchNetworkSaves>>>;
  payments?:()=>Promise<AdminPayment[]>;
  legacy?: (id:string)=>Promise<AdminArchive|null>;
}={}):Promise<NetworkOverview>{
  const [ar,sol]=await Promise.allSettled([
    (async()=>{
      const rows=await bounded((deps.archives??fetchNetworkSaves)()).catch(()=>[]);
      const mapped=rows.map(row=>({txId:row.txId,at:row.at,vaultFp:legacyFingerprint(row.txId)??row.vaultFp,status:'Найдено'}));
      for(const entry of manifest.entries){for(const id of entry.txIds){
        if(mapped.some(row=>row.txId===id))continue;
        const found=await (deps.legacy??fetchLegacyArchive)(id);
        if(found)mapped.push(found);
      }}
      if(mapped.length===0&&manifest.entries.length>0)throw Error('arweave_overview_unavailable');
      return mapped;
    })(),(deps.payments??fetchPilotPayments)(),
  ]);
  const archives=ar.status==='fulfilled'?ar.value:null;
  const payments=sol.status==='fulfilled'?sol.value:null;
  return {archives,trees:archives?new Set(archives.map(row=>row.vaultFp)).size:null,saves:archives?.length??null,
    payments,paidCount:payments?.length??null,receivedLamports:payments?.reduce((sum,row)=>sum+row.lamports,0)??null,
    arweaveError:archives===null,solanaError:payments===null};
}
