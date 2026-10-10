import { PILOT, assertPilotBinding, assertPilotConfig, assertPilotData, importPilotArchive, nativeMessage, nativeReadMessage } from './pilot';
import { readyForOrder } from './jobs';
/** Synthetic signatures + real arweave-js format-2/chunk uploader against localhost fixtures. No live funds. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { webcrypto } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import Arweave from 'arweave';
import { canonical } from '../../../../../packages/protocol/wire';
import { configHash, CONFIG_DOMAIN, verifyChain, extendChain, splitTotal, acceptancePayload, type Config, type ConfigChain } from './config';
import { arClient, signNative, uploadNative, validateArPlan, retrieveNative, nativeStatus } from './arweave';
import { envelopeDigest } from '../solana/policy';
import { createMnemonic } from '../crypto/bip39';
import { deriveKeysFromMnemonic } from '../crypto/keys';
import { encryptJson } from '../crypto/encrypt';
import { emptyVault, putTree, openEnvelope } from '../crypto/vault';
import { createTree, upsertPersonFields, commitDraft } from '../treeEngine';
import { parsePortableBackup } from '../crypto/backup';
let count=0;
async function test(name:string,action:()=>unknown|Promise<unknown>){await action();count++;console.log('PASS native '+name);}
Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const secret=new Uint8Array(32).fill(19),key=bs58.encode(ed25519.getPublicKey(secret)),key2=bs58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(20)));
const sign=(value:unknown,k=secret)=>({publicKey:bs58.encode(ed25519.getPublicKey(k)),signature:bs58.encode(ed25519.sign(new TextEncoder().encode(canonical(value)),k))});
const c:Config={domain:CONFIG_DOMAIN,project:'SEJIRE',version:1,previous:null,environment:'devnet',createdAt:1,nonce:'a'.repeat(32),serviceLamports:'30000000',wallets:{service:bs58.encode(new Uint8Array(32).fill(2)),fund:bs58.encode(new Uint8Array(32).fill(3)),arReserve:'A'.repeat(43)},managers:[key],threshold:1,solanaRpcs:['https://api.devnet.solana.com'],arweaveNodes:['https://arweave.net'],arweaveNetwork:'arweave.N.1',upload:{maxBytes:1048576,maxRewardWinston:'100000',acceptingUntil:0},identifiers:{protocol:null,release:null}};
const chain:ConfigChain={schema:'sejire/config-chain/v1',versions:[{config:c,signatures:[sign(c)],acceptance:[sign(acceptancePayload(c))]}]},anchor=await configHash(c);
await test('read-only network errors never imply an unknown payment',()=>{
 assert.equal(nativeReadMessage('rpc-timeout'),'Сеть не ответила вовремя. Попробуйте ещё раз.');
 assert.equal(nativeReadMessage('rpc_timeout'),nativeReadMessage('rpc-timeout'));
 assert.notEqual(nativeReadMessage('rpc-rate-limited'),nativeReadMessage('rpc-timeout'));
 assert.match(nativeMessage('wallet_response_timeout'),/новая оплата не запускается/i);
 assert.match(nativeMessage('requires_reconciliation'),/новый платёж не создаётся/);
 assert.doesNotMatch(nativeReadMessage('rpc-unavailable'),/оплат|подпис/i);
});
await test('three distinct wallet roles and signed genesis',async()=>assert.deepEqual(await verifyChain(chain,anchor),c));
await test('fake signature rejected',async()=>{const bad=structuredClone(chain);bad.versions[0].signatures[0].signature=bs58.encode(new Uint8Array(64));await assert.rejects(()=>verifyChain(bad,anchor));});
await test('untrusted initial visitor rejected',()=>assert.rejects(()=>verifyChain(chain,'0'.repeat(64))));
await test('secret/unknown configuration field rejected',async()=>{const bad=structuredClone(chain);Object.assign(bad.versions[0].config,{privateKey:'never-accept'});await assert.rejects(()=>verifyChain(bad,anchor));});
await test('configuration recovery from portable bytes',async()=>assert.deepEqual(await verifyChain(JSON.parse(JSON.stringify(chain)),anchor),c));
const next={...structuredClone(c),version:2,previous:anchor,createdAt:2,nonce:'b'.repeat(32),wallets:{...c.wallets,service:bs58.encode(new Uint8Array(32).fill(4))}};
const newer:ConfigChain={schema:chain.schema,versions:[...chain.versions,{config:next,signatures:[sign(next)],acceptance:[]}]};
await test('address rotation preserves previous terms',async()=>{assert.equal((await verifyChain(newer,anchor)).wallets.service,next.wallets.service);assert.equal(newer.versions[0].config.wallets.service,c.wallets.service);});
await test('fork not last JSON wins',async()=>{const fork=structuredClone(newer);fork.versions[1].config.wallets.fund=bs58.encode(new Uint8Array(32).fill(9));fork.versions[1].signatures=[sign(fork.versions[1].config)];await assert.rejects(()=>extendChain(newer,fork,anchor));});
await test('rollback rejected',()=>assert.rejects(()=>extendChain(newer,chain,anchor)));
await test('old authority must sign new configuration',async()=>{const forged=structuredClone(newer);forged.versions[1].config.managers=[key2];forged.versions[1].signatures=[sign(forged.versions[1].config,new Uint8Array(32).fill(20))];await assert.rejects(()=>verifyChain(forged,anchor));});
await test('new key explicit acceptance',async()=>{const rotated=structuredClone(newer);rotated.versions[1].config.managers=[key2];rotated.versions[1].signatures=[sign(rotated.versions[1].config)];await assert.rejects(()=>verifyChain(rotated,anchor));rotated.versions[1].acceptance=[sign(acceptancePayload(rotated.versions[1].config),new Uint8Array(32).fill(20))];assert.equal((await verifyChain(rotated,anchor)).managers[0],key2);});
for(const [total,fund] of [['30000000','0'],['100000000','70000000'],['1000000000','970000000']])await test('exact split '+total,()=>assert.deepEqual(splitTotal(total,'30000000'),{servicePayment:'30000000',fundContribution:fund,total}));
await test('donation only no archive or service fee',()=>assert.deepEqual(splitTotal('1','30000000',true),{servicePayment:'0',fundContribution:'1',total:'1'}));
await test('below price rejected',()=>assert.throws(()=>splitTotal('29999999','30000000')));
await test('large lamports integer precision',()=>assert.equal(splitTotal('18446744073709551615','30000000').fundContribution,'18446744073679551615'));
await test('technical u64 bound not commercial cap',()=>assert.throws(()=>splitTotal('18446744073709551616','30000000')));
await test('one archive authorization exact payer digest bytes and integer ceiling',()=>{assertPilotBinding(PILOT.address,PILOT.digest,PILOT.bytes,PILOT.maximum);for(const args of [['A'.repeat(43),PILOT.digest,PILOT.bytes,PILOT.maximum],[PILOT.address,'0'.repeat(64),PILOT.bytes,PILOT.maximum],[PILOT.address,PILOT.digest,PILOT.bytes+1,PILOT.maximum],[PILOT.address,PILOT.digest,PILOT.bytes,'4000000001']] as [string,string,number,string][])assert.throws(()=>assertPilotBinding(...args));});
await test('pilot policy binds manager devnet treasury reserve and budget',()=>{const approved:Config={...c,managers:[PILOT.manager],wallets:{service:PILOT.service,fund:PILOT.fund,arReserve:PILOT.address},upload:{...c.upload,maxRewardWinston:PILOT.maximum}};assertPilotConfig(approved);assert.throws(()=>assertPilotConfig({...approved,environment:'mainnet-beta'}));assert.throws(()=>assertPilotConfig({...approved,managers:[key]}));assert.throws(()=>assertPilotConfig({...approved,upload:{...approved.upload,maxRewardWinston:'0'}}));assert.throws(()=>assertPilotConfig({...approved,wallets:{...approved.wallets,fund:PILOT.service}}));});
await test('disabled and expired executor stop before RPC or order signature',async()=>{await assert.rejects(()=>readyForOrder(c,PILOT.bytes,PILOT.digest),/manual_executor_not_accepting_orders/);await assert.rejects(()=>readyForOrder({...c,upload:{...c.upload,acceptingUntil:1}},PILOT.bytes,PILOT.digest),/manual_executor_window_expired/);});
await test('ciphertext or config publication cannot use single archive permission',async()=>{await assert.rejects(()=>assertPilotData(PILOT.address,JSON.stringify(chain),PILOT.maximum),/archive_not_authorized/);await assert.rejects(()=>importPilotArchive({size:PILOT.fileBytes,text:async()=>'{"tampered":true}'} as File),/pilot_file_mismatch/);});
const words=createMnemonic(),keys=deriveKeysFromMnemonic(words);let vault=emptyVault(keys.vaultId);
for(let t=0;t<2;t++){let tree=upsertPersonFields(createTree('Synthetic '+t),{id:'parent',name:'Synthetic parent',parents:[]});tree=upsertPersonFields(tree,{id:'child',name:'Synthetic child',parents:['parent'],notes:'Synthetic note '.repeat(12000)});tree=commitDraft(tree,'Synthetic initial');tree=commitDraft(upsertPersonFields(tree,{id:'child',name:'Synthetic corrected',parents:['parent']}),'Synthetic correction');vault=putTree(vault,tree);}
const envelope=await encryptJson(keys.encKey,keys.vaultId,vault),data=JSON.stringify(envelope),tags=[{name:'Content-Type',value:'application/json'},{name:'App-Name',value:'SEJIRE'}];
const ar=Arweave.init({host:'localhost',port:1,protocol:'http'}),jwk=await ar.wallets.generate(),address=await ar.wallets.jwkToAddress(jwk);
let txPosts=0,chunks=0;const requests:string[]=[];
const server=createServer(async(req,res)=>{
 const url=req.url!;requests.push(url);res.setHeader('Content-Type','application/json');
 if(url==='/info'){res.end(JSON.stringify({network:'arweave.N.1',height:100,version:5,release:1,peers:1,current:'X',blocks:100,queue_length:0,node_state_latency:0}));return;}
 if(url.startsWith('/price/')){res.end('1000');return;}
 if(url.endsWith('/balance')){res.end('100000');return;}
 if(url==='/tx_anchor'){res.end('A'.repeat(64));return;}
 if(url==='/tx'&&req.method==='POST'){txPosts++;res.end('{}');return;}
 if(url==='/chunk'){chunks++;res.end('{}');return;}
 if(url.endsWith('/status')){res.end(JSON.stringify({block_height:100,block_indep_hash:'X',number_of_confirmations:12}));return;}
 res.statusCode=404;res.end('{}');
});
await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));const addressInfo=server.address();assert(addressInfo&&typeof addressInfo!=='string');const url=`http://127.0.0.1:${addressInfo.port}`;
let signatureCalls=0;const wallet={async connect(){},async getActiveAddress(){return address;},async getActivePublicKey(){return jwk.n;},async sign(raw:unknown){signatureCalls++;const tx=ar.transactions.fromRaw(raw as never);await ar.transactions.sign(tx,jwk);return tx.toJSON();}};
try{
 await test('write-ahead failure stops before wallet signature',async()=>{await assert.rejects(()=>signNative([url],wallet,address,data,tags,'1000',async()=>{throw Error('cache_commit_failed');}),/cache_commit_failed/);assert.equal(signatureCalls,0);assert.equal(txPosts,0);});
 let plan=await signNative([url],wallet,address,data,tags,'1000');
 await test('real SDK format-2 preparation with synthetic RSA signer',async()=>{assert.equal(plan.signedTx.format,2);assert.equal(plan.bytes,new TextEncoder().encode(data).length);await validateArPlan(plan,data,tags);});
 await test('insufficient operational budget rejects',()=>assert.rejects(()=>signNative([url],wallet,address,data,tags,'999')));
 await test('wrong signer rejects',()=>assert.rejects(()=>signNative([url],wallet,'A'.repeat(43),data,tags,'1000')));
 await test('damaged ciphertext rejects',()=>assert.rejects(()=>validateArPlan(plan,data+' ',tags)));
 await test('mainnet broadcast is off by default',()=>assert.rejects(()=>uploadNative([url],plan,data,tags,async()=>{},false)));
 let durable=JSON.stringify(plan), injected=false;
 await test('signed bytes saved before first send',async()=>{await uploadNative([url],plan,data,tags,async p=>{durable=JSON.stringify(p);if(!injected&&p.progress?.chunkIndex===1){injected=true;throw Error('synthetic_process_stop_after_durable_save');}},true).catch(()=>{});assert(txPosts>=1);assert.equal(injected,true);assert(JSON.parse(durable).id===plan.id);});
 await test('resume in clean runtime state uses same ID without old private key',async()=>{plan=JSON.parse(durable);await uploadNative([url],plan,data,tags,async p=>{durable=JSON.stringify(p);},true);assert.equal(plan.uploaded,true);assert.equal(txPosts,1);});
 await test('repeat upload no second transaction',async()=>{await uploadNative([url],plan,data,tags,async()=>{},true);assert.equal(txPosts,1);});
 await test('tampered signed transaction rejected',async()=>{const bad=structuredClone(plan);bad.signedTx.reward='2000';await assert.rejects(()=>validateArPlan(bad,data,tags));});
 await test('native status is independent of accepted flag',async()=>assert.equal((await nativeStatus([url],plan.id)).confirmed?.number_of_confirmations,12));
 await test('alternate gateway verifies exact bytes and hash',async()=>{const seen:string[]=[];const digest=await envelopeDigest(data);const result=await retrieveNative(['https://first.invalid','https://second.invalid'],plan.id,digest,plan.bytes,async input=>{seen.push(String(input));return seen.length===1?new Response('',{status:503}):new Response(data);});assert.equal(result.text,data);assert.equal(seen.length,2);});
 await test('corrupted retrieval rejected',()=>assert.rejects(()=>retrieveNative(['https://first.invalid'],plan.id,'0'.repeat(64),plan.bytes,async()=>new Response(data))));
 await test('two trees relationships and history offline restore unchanged',async()=>{const backup=parsePortableBackup(data);assert.equal(backup.kind,'vault');assert.deepEqual(await openEnvelope(keys,envelope),vault);});
 await test('no Turbo or cloud endpoints in direct upload path',()=>assert(requests.every(p=>!p.includes('turbo')&&!p.includes('winc'))));
 await test('custom endpoint supported by real SDK',()=>assert.equal(arClient(url).api.config.host,'127.0.0.1'));
}finally{await new Promise<void>((ok,fail)=>server.close(e=>e?fail(e):ok()));}
console.log(`PASS ${count} native admin / Arweave tests; LOCAL fixtures, no live transaction or permanent settlement`);

// Same stale-memory/persistent-cache split as two browser tabs. No wallet or network.
const {indexedDB}=await import('fake-indexeddb');Object.assign(globalThis,{indexedDB});
Object.defineProperty(globalThis,'navigator',{value:{locks:{request:async(_name:string,action:()=>Promise<unknown>)=>action()}},configurable:true});
const {trustChain,restoreJobSession}=await import('./session');const {writeCache,readCache}=await import('./cache');
const {prePaymentOnly}=await import('./successor');
const four=structuredClone(chain);
for(let version=2;version<=4;version++){const cfg={...structuredClone(c),version,previous:await configHash(four.versions.at(-1)!.config),nonce:String(version).repeat(32),createdAt:version};four.versions.push({config:cfg,signatures:[sign(cfg)],acceptance:[]});}
const three={...four,versions:four.versions.slice(0,3)};
await test('stale tab v3 adopts persistent v4 and cannot roll back',async()=>{
 await trustChain(three,anchor);await writeCache('trusted-session',{schema:'sejire/trusted-session/v1',chain:four,trusted:anchor});
 const adopted=await trustChain(three,anchor);assert.equal(adopted.config.version,4);assert.equal((await readCache<{chain:ConfigChain}>('trusted-session'))!.chain.versions.length,4);
});
await test('trusted fork rejected without changing persistent history',async()=>{const fork=structuredClone(four);fork.versions[3].config.nonce='f'.repeat(32);fork.versions[3].signatures=[sign(fork.versions[3].config)];await assert.rejects(()=>trustChain(fork,anchor),/configuration_conflict_or_rollback/);assert.equal(await configHash((await readCache<{chain:ConfigChain}>('trusted-session'))!.chain.versions[3].config),await configHash(four.versions[3].config));});
await test('exact missing job configuration recovered only from signed historical extension',async()=>{
 const cfg={...structuredClone(c),version:5,previous:await configHash(four.versions[3].config),nonce:'5'.repeat(32),createdAt:5};const five={...four,versions:[...four.versions,{config:cfg,signatures:[sign(cfg)],acceptance:[]}]};await writeCache('chain',five);
 const restored=await restoreJobSession({configHash:await configHash(cfg)} as import('./jobs').NativeJob);assert.equal(restored.config.version,5);assert.equal((await readCache<{chain:ConfigChain}>('trusted-session'))!.chain.versions.length,5);
 await assert.rejects(()=>restoreJobSession({configHash:'0'.repeat(64)} as import('./jobs').NativeJob),/unknown_order_configuration/);
});
await test('every payment-signing marker forbids orphan replacement',()=>{
 const base={} as import('./jobs').NativeJob;assert(prePaymentOnly(base));
 for(const extra of [{signingStarted:true},{paymentSignature:'x'},{reconciledSignature:'x'},{signedPayment:'x'},...['wallet_pending','signature_unknown','signed','broadcast','finalized','rejected','failed'].map(phase=>({attempt:{phase}}))])assert.equal(prePaymentOnly({...base,...extra} as import('./jobs').NativeJob),false);
});
await test('stale authorization preserves a recoverable signed mirror before overwriting cache',async()=>{
 const persisted=(await readCache<{chain:ConfigChain}>('trusted-session'))!.chain,previous=persisted.versions.at(-1)!.config;
 const cfg={...structuredClone(previous),version:previous.version+1,previous:await configHash(previous),nonce:'6'.repeat(32),createdAt:6};
 const mirror={...persisted,versions:[...persisted.versions,{config:cfg,signatures:[sign(cfg)],acceptance:[]}]};await writeCache('chain',mirror);
 const restored=await trustChain(persisted,anchor);assert.equal(restored.config.version,6);assert.equal((await readCache<{chain:ConfigChain}>('trusted-session'))!.chain.versions.length,6);
});
console.log('PASS '+count+' native tests including monotonic configuration / orphan guards; LOCAL fixtures only');
