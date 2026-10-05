import type { ConfigChain, Config } from './config';
import { verifyChain, extendChain } from './config';
import { writeCache, readCache } from './cache';
let session:{chain:ConfigChain;config:Config;trusted:string}|undefined;
let restoring:Promise<typeof session>|undefined;
export const nativeSession=()=>session;
/** Only pins an anchor already independently accepted by the owner; importing JSON never creates a pin. */
export async function restoreNativeSession() {
 if(session)return session;
 if(!restoring)restoring=(async()=>{const record=await readCache<{schema:string;chain:ConfigChain;trusted:string}>('trusted-session');if(!record)return undefined;if(record.schema!=='sejire/trusted-session/v1')throw Error('untrusted_genesis');const config=await verifyChain(record.chain,record.trusted);session={chain:record.chain,config,trusted:record.trusted};return session;})().finally(()=>{restoring=undefined;});
 return restoring;
}
export async function trustChain(chain:ConfigChain,trusted:string) {
 const config=await verifyChain(chain,trusted),old=session??await restoreNativeSession();
 if(old){if(old.trusted!==trusted)throw Error('different_trust_anchor');await extendChain(old.chain,chain,trusted);}
 await writeCache('chain',chain);await writeCache('trusted-session',{schema:'sejire/trusted-session/v1',chain:structuredClone(chain),trusted});
 session={chain:structuredClone(chain),config,trusted};return session;
}
