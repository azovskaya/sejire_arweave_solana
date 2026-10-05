/** Only a recoverable cache: imports MUST verify signatures against a separately trusted anchor. No secrets. */
import { canonical } from '../../../../../packages/protocol/wire';
import type { NativeJob } from './jobs';
import type { ConfigChain } from './config';
async function db() {return new Promise<IDBDatabase>((ok,fail)=>{const r=indexedDB.open('sejire-native-pilot',1);r.onupgradeneeded=()=>r.result.createObjectStore('cache');r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(Error('cache_unavailable'));});}
export async function readCache<T>(key:string):Promise<T|undefined> {const d=await db();try{return await new Promise((ok,fail)=>{const r=d.transaction('cache').objectStore('cache').get(key);r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(Error('cache_unavailable'));});}finally{d.close();}}
export async function writeCache(key:string,value:unknown) {const d=await db();try{await new Promise<void>((ok,fail)=>{const tx=d.transaction('cache','readwrite');tx.objectStore('cache').put(value,key);tx.oncomplete=()=>ok();tx.onerror=tx.onabort=()=>fail(Error('cache_commit_failed'));});}catch{throw Error('cache_commit_failed');}finally{d.close();}}
export const cachedChain=()=>readCache<ConfigChain>('chain');
export const cachedJobs=async()=>await readCache<NativeJob[]>('jobs')??[];
export async function saveJob(job:NativeJob,walletRejected=false) {
 if(!navigator.locks)throw Error('exclusive_browser_lock_unavailable');
 await navigator.locks.request('sejire-native-jobs',async()=>{
 const jobs=await cachedJobs(),old=jobs.find(j=>j.order.id===job.order.id);
 if(old?.signingStarted&&!job.signingStarted&&!walletRejected)throw Error('unknown_attempt_cannot_be_cleared');
 if(old&&(canonical(old.order)!==canonical(job.order)||old.configHash!==job.configHash||old.paymentSignature&&old.paymentSignature!==job.paymentSignature||old.reconciledSignature&&old.reconciledSignature!==job.reconciledSignature||old.arPlan&&old.arPlan.id!==job.arPlan?.id))throw Error('immutable_operation_conflict');
 if((job.paymentSignature||job.reconciledSignature)&&jobs.some(j=>j.order.id!==job.order.id&&(j.paymentSignature??j.reconciledSignature)===(job.paymentSignature??job.reconciledSignature)))throw Error('transaction_reuse');
 await writeCache('jobs',[...jobs.filter(j=>j.order.id!==job.order.id),structuredClone(job)]);
 });
}
