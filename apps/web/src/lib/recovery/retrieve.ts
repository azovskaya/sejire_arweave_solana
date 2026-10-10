import {MAX_BACKUP_BYTES} from '../crypto/envelope';
import {RecoveryFailure} from './errors';
import {firstUsable,timedFetch} from './gateways';
import {gatewayHost} from './diagnostics';
import type {GatewayPool,HeadCandidate,RecoveryContext,SafeRecoveryDiagnostics} from './types';

export type TxMetadata={id:string;tags:{name:string;value:string}[];blockHeight:number|null;blockTimestamp:number|null};
function decodeBase64Url(value:string):string {
  const base=value.replace(/-/g,'+').replace(/_/g,'/');
  return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(base.padEnd(Math.ceil(base.length/4)*4,'=')),c=>c.charCodeAt(0)));
}
function parseMetadata(raw:unknown):TxMetadata {
  if(!raw||typeof raw!=='object')throw Error('bad_metadata');
  const tx=raw as {id?:string;tags?:{name:string;value:string}[];block?:{height?:number;timestamp?:number};blockHeight?:number;blockTimestamp?:number};
  if(!tx.id||!/^[A-Za-z0-9_-]{43}$/.test(tx.id)||!Array.isArray(tx.tags)||tx.tags.length>40)throw Error('bad_metadata');
  const tags=tx.tags.map(tag=>({name:decodeBase64Url(tag.name),value:decodeBase64Url(tag.value)}));
  return {id:tx.id,tags,blockHeight:tx.block?.height??tx.blockHeight??null,blockTimestamp:tx.block?.timestamp??tx.blockTimestamp??null};
}
export function tagValue(meta:TxMetadata,name:string):string|null {
  const matches=meta.tags.filter(tag=>tag.name===name);if(matches.length>1)throw new RecoveryFailure('METADATA_MISMATCH');
  return matches[0]?.value??null;
}
export function validateMetadata(meta:TxMetadata,candidate:HeadCandidate,vaultId:string):void {
  if(meta.id!==candidate.txId)throw new RecoveryFailure('METADATA_MISMATCH');
  if(tagValue(meta,'App-Name')!=='SEJIRE'||tagValue(meta,'Type')!=='vault-envelope')throw new RecoveryFailure('METADATA_MISMATCH');
  const taggedVault=tagValue(meta,'Vault-Id');
  if(taggedVault!==null&&taggedVault!==vaultId)throw new RecoveryFailure('VAULT_ID_MISMATCH');
  if(taggedVault===null&&!candidate.legacy)throw new RecoveryFailure('METADATA_MISMATCH');
  const schema=tagValue(meta,'Schema');if(schema!==null&&schema!=='sejire/envelope/v1')throw new RecoveryFailure('METADATA_MISMATCH');
  const bytes=tagValue(meta,'Archive-Bytes');if(bytes!==null&&(!/^[1-9]\d*$/.test(bytes)||Number(bytes)>MAX_BACKUP_BYTES))throw new RecoveryFailure('METADATA_MISMATCH');
  const digest=tagValue(meta,'Archive-SHA256');if(digest!==null&&!/^[a-f0-9]{64}$/.test(digest))throw new RecoveryFailure('METADATA_MISMATCH');
  const protocol=tagValue(meta,'Protocol-Version');if(protocol!==null&&protocol!=='sejire/v0.3')throw new RecoveryFailure('METADATA_MISMATCH');
  if((digest!==null||bytes!==null)&&(!digest||!bytes||schema!=='sejire/envelope/v1'||protocol!=='sejire/v0.3'))throw new RecoveryFailure('METADATA_MISMATCH');
  const parent=tagValue(meta,'Parent-Tx');if(parent!==null&&!/^[A-Za-z0-9_-]{43}$/.test(parent))throw new RecoveryFailure('METADATA_MISMATCH');
  if(candidate.archiveBytes!==undefined&&bytes!==null&&Number(bytes)!==candidate.archiveBytes)throw new RecoveryFailure('METADATA_MISMATCH');
  if(candidate.archiveSha256!==undefined&&digest!==null&&digest!==candidate.archiveSha256)throw new RecoveryFailure('METADATA_MISMATCH');
}
export async function fetchMetadata(ctx:RecoveryContext,pool:GatewayPool,candidate:HeadCandidate,diagnostics:SafeRecoveryDiagnostics):Promise<TxMetadata>{
  const targets=await pool.candidates(ctx);let mismatch:RecoveryFailure|undefined;
  try{return await firstUsable(targets,async(target,signal)=>{
    const start=performance.now();let status='unavailable';
    try {
      const response=await timedFetch(ctx.fetcher,`${target.url}/tx/${candidate.txId}`,{},4500,signal);status=String(response.status);
      if(!response.ok)throw Error('metadata_unavailable');
      const meta=parseMetadata(await response.json());validateMetadata(meta,candidate,ctx.vaultId);
      pool.markSuccess(target.url,performance.now()-start);return meta;
    }catch(error){pool.markFailure(target.url);if(error instanceof RecoveryFailure)mismatch??=error;throw error;}
    finally{diagnostics.gateways.push({host:gatewayHost(target.url),operation:'metadata',status});}
  },ctx.signal);}catch{throw mismatch??new RecoveryFailure('DATA_UNAVAILABLE');}
}
export async function fetchRaw(ctx:RecoveryContext,pool:GatewayPool,candidate:HeadCandidate,meta:TxMetadata,diagnostics:SafeRecoveryDiagnostics):Promise<Uint8Array>{
  const targets=await pool.candidates(ctx);let mismatch:RecoveryFailure|undefined;
  const expectedBytes=tagValue(meta,'Archive-Bytes')?Number(tagValue(meta,'Archive-Bytes')):candidate.archiveBytes;
  const expectedHash=tagValue(meta,'Archive-SHA256')??candidate.archiveSha256;
  try{return await firstUsable(targets,async(target,signal)=>{
    const start=performance.now();let status='unavailable';
    try {
      const response=await timedFetch(ctx.fetcher,`${target.url}/raw/${candidate.txId}`,{},5000,signal);status=String(response.status);
      if(!response.ok)throw Error('raw_unavailable');
      const length=response.headers.get('content-length');if(length&&Number(length)>MAX_BACKUP_BYTES)throw new RecoveryFailure('RAW_HASH_MISMATCH');
      if(!response.body)throw Error('raw_body_unavailable');
      const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
      try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;
        if(size>MAX_BACKUP_BYTES){await reader.cancel();throw new RecoveryFailure('RAW_HASH_MISMATCH');}chunks.push(item.value);}}
      finally{reader.releaseLock();}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      if(bytes.length>MAX_BACKUP_BYTES||expectedBytes!==undefined&&bytes.length!==expectedBytes)throw new RecoveryFailure('RAW_HASH_MISMATCH');
      const digest=await crypto.subtle.digest('SHA-256',bytes as BufferSource);const hash=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
      if(expectedHash&&hash!==expectedHash)throw new RecoveryFailure('RAW_HASH_MISMATCH');
      pool.markSuccess(target.url,performance.now()-start);return bytes;
    }catch(error){pool.markFailure(target.url);if(error instanceof RecoveryFailure)mismatch??=error;throw error;}
    finally{diagnostics.gateways.push({host:gatewayHost(target.url),operation:'raw',status});}
  },ctx.signal);}catch{throw mismatch??new RecoveryFailure('DATA_UNAVAILABLE');}
}
