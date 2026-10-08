import {isValidMnemonic,normalizeMnemonic} from '../crypto/bip39';
import {deriveKeysFromMnemonic} from '../crypto/keys';
import {discoverCandidates} from './discovery';
import {newDiagnostics} from './diagnostics';
import {RecoveryFailure} from './errors';
import {WayfinderGatewayPool} from './gateways';
import {resolveHead} from './head';
import {fetchMetadata,fetchRaw} from './retrieve';
import {verifyCandidate} from './verify';
import type {GatewayPool,HeadDiscoveryProvider,RecoveryContext,RecoveryErrorCode,RecoveryResult,RecoveryStage,VerifiedVersion} from './types';

export type RecoveryOptions={fetcher?:typeof fetch;pool?:GatewayPool;providers?:HeadDiscoveryProvider[];txHints?:string[];signal?:AbortSignal;onStage?:(stage:RecoveryStage)=>void};

/** Read-only: all requests are GET except GraphQL queries, and no wallet module is imported. */
export async function recoverVaultFromWords(words:string,options:RecoveryOptions={}):Promise<RecoveryResult>{
  const diagnostics=newDiagnostics();
  const stage=(value:RecoveryStage)=>{diagnostics.stage=value;options.onStage?.(value);};
  if(!isValidMnemonic(words))return {ok:false,code:'INVALID_WORDS',diagnostics:{...diagnostics,code:'INVALID_WORDS'}};
  const keys=deriveKeysFromMnemonic(normalizeMnemonic(words));
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),45_000);
  const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});
  const ctx:RecoveryContext={vaultId:keys.vaultId,signal:controller.signal,fetcher:options.fetcher??fetch};
  const pool=options.pool??new WayfinderGatewayPool();
  try {
    stage('discover');
    const discovery=await discoverCandidates(ctx,pool,diagnostics,options.txHints,options.providers);
    if(!discovery.candidates.length)throw new RecoveryFailure(discovery.responded?'NO_CANDIDATES':'DISCOVERY_UNAVAILABLE');
    stage('found');
    const versions:VerifiedVersion[]=[];const failures:RecoveryErrorCode[]=[];
    // Three candidate pipelines at a time. Every candidate is independently verified.
    let next=0;
    await Promise.all(Array.from({length:Math.min(3,discovery.candidates.length)},async()=>{
      while(next<discovery.candidates.length&&!ctx.signal.aborted){
        const candidate=discovery.candidates[next++];
        try {
          stage('download');const meta=await fetchMetadata(ctx,pool,candidate,diagnostics);
          const bytes=await fetchRaw(ctx,pool,candidate,meta,diagnostics);
          stage('verify');const version=await verifyCandidate(bytes,meta,candidate,keys);
          versions.push(version);diagnostics.verifiedCount=versions.length;
        } catch(error){failures.push(error instanceof RecoveryFailure?error.code:'UNKNOWN_ERROR');}
      }
    }));
    if(!versions.length){
      const priority:RecoveryErrorCode[]=['RAW_HASH_MISMATCH','VAULT_ID_MISMATCH','DECRYPT_FAILED','INVALID_VAULT','METADATA_MISMATCH','DATA_UNAVAILABLE','UNKNOWN_ERROR'];
      throw new RecoveryFailure(priority.find(code=>failures.includes(code))??'DATA_UNAVAILABLE');
    }
    stage('open');const {head,forks}=resolveHead(versions);
    return {ok:true,vault:head.vault,headTxId:head.txId,versions,forks,code:forks.length?'MULTIPLE_VERIFIED_HEADS':undefined,diagnostics};
  } catch(error){const code=error instanceof RecoveryFailure?error.code:controller.signal.aborted?'DATA_UNAVAILABLE':'UNKNOWN_ERROR';diagnostics.code=code;return {ok:false,code,diagnostics};}
  finally{clearTimeout(timeout);options.signal?.removeEventListener('abort',abort);}
}
