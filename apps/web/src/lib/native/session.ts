import type { ConfigChain, Config, SignedConfig } from './config';
import { verifyChain, extendChain } from './config';
import { writeCacheEntries, readCache } from './cache';
import { configForJob, type NativeJob } from './jobs';
type Session={chain:ConfigChain;config:Config;trusted:string};
type Record={schema:string;chain:ConfigChain;trusted:string};
let session:Session|undefined;
export const nativeSession=()=>session;
async function persistentSession() {
 const record=await readCache<Record>('trusted-session');if(!record)return undefined;
 if(record.schema!=='sejire/trusted-session/v1')throw Error('untrusted_genesis');
 return {chain:record.chain,config:await verifyChain(record.chain,record.trusted),trusted:record.trusted};
}
/** A stale prefix adopts the newer chain; a fork never replaces it. */
async function latestChain(current:ConfigChain,incoming:ConfigChain,trusted:string) {
 if(incoming.versions.length<current.versions.length){await extendChain(incoming,current,trusted);return current;}
 return extendChain(current,incoming,trusted);
}
export async function restoreNativeSession() {
 const persisted=await persistentSession();
 if(persisted){if(session&&session.trusted!==persisted.trusted)throw Error('different_trust_anchor');const chain=session?await latestChain(session.chain,persisted.chain,persisted.trusted):persisted.chain;session={...persisted,chain,config:await verifyChain(chain,persisted.trusted)};}
 return session;
}
/** Cross-tab lock, fresh persistent read, and atomic commit; importing JSON never pins a root. */
export async function trustChain(chain:ConfigChain,trusted:string) {
 await verifyChain(chain,trusted);if(!navigator.locks)throw Error('exclusive_browser_lock_unavailable');
 return navigator.locks.request('sejire-trusted-session',async()=>{
  const persisted=await persistentSession();let newest=chain;
  for(const old of [persisted,session])if(old){if(old.trusted!==trusted)throw Error('different_trust_anchor');newest=await latestChain(old.chain,newest,trusted);}
  const config=await verifyChain(newest,trusted),record={schema:'sejire/trusted-session/v1',chain:structuredClone(newest),trusted};
  const history=await readCache<Record[]>('trusted-chain-history')??[];
  await writeCacheEntries([['chain',record.chain],['trusted-session',record],['trusted-chain-history',[...history.slice(-19),record]]]);
  session={chain:record.chain,config,trusted};return session;
 });
}
/** Recover only exact signed history with the existing anchor. Never infer configuration from a job. */
export async function restoreJobSession(job:NativeJob) {
 let current=await restoreNativeSession();if(!current)throw Error('signed_configuration_required');
 try{await configForJob(current.chain,job,current.trusted);return current;}catch(e){if(!(e instanceof Error)||e.message!=='unknown_order_configuration')throw e;}
 const cached=await readCache<ConfigChain>('chain'),history=await readCache<Record[]>('trusted-chain-history')??[],draft=await readCache<SignedConfig>('settings-draft');
 const candidates=[...(cached?[cached]:[]),...history.filter(r=>r.trusted===current!.trusted).map(r=>r.chain),...(draft?[{schema:current.chain.schema,versions:[...current.chain.versions,draft]}]:[])];
 for(const candidate of candidates){try{await verifyChain(candidate,current.trusted);await configForJob(candidate,job,current.trusted);const recovered=await trustChain(candidate,current.trusted);current=recovered;return current;}catch(e){if(e instanceof Error&&['cache_commit_failed','cache_unavailable'].includes(e.message))throw e;}}
 throw Error('unknown_order_configuration');
}
