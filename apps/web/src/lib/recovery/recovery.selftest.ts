import assert from 'node:assert/strict';
import {resolveHead} from './head';
import {LegacyLocatorProvider} from './providers/legacyLocatorProvider';
import {GraphqlVaultProvider} from './providers/graphqlVaultProvider';
import {fetchMetadata,fetchRaw,validateMetadata,type TxMetadata} from './retrieve';
import {RecoveryFailure} from './errors';
import {newDiagnostics} from './diagnostics';
import {verifyCandidate} from './verify';
import {firstUsable,MAX_GATEWAY_RESPONSE_BYTES,timedFetch,WayfinderGatewayPool} from './gateways';
import {createMnemonic} from '../crypto/bip39';
import {deriveKeysFromMnemonic} from '../crypto/keys';
import {encryptJson} from '../crypto/encrypt';
import {serializeEnvelope} from '../crypto/envelope';
import {emptyVault,putTree} from '../crypto/vault';
import {envelopeDigest} from '../solana/policy';
import {createTree,commitDraft,upsertPersonFields} from '../treeEngine';
import type {GatewayPool,VerifiedVersion,RecoveryContext,RecoveryErrorCode} from './types';
const vaultId='a'.repeat(32),id='A'.repeat(43);
const ctx={vaultId,signal:new AbortController().signal,fetcher:fetch} as RecoveryContext;
const locator=new LegacyLocatorProvider([{vaultId,txIds:[id],reason:'test'}]);
const loc=await locator.discover(ctx);
assert.equal(loc.status,'responded');assert.equal(loc.candidates[0].txId,id);assert.equal(loc.candidates[0].legacy,true);
assert.equal((await locator.discover({...ctx,vaultId:'b'.repeat(32)})).candidates.length,0);
const provider=new GraphqlVaultProvider('https://index.example/graphql');
const query=await provider.discover({...ctx,fetcher:async (_url,init)=>{
  const body=JSON.parse(String(init?.body));assert.equal(body.variables.vaultId,vaultId);
  return new Response(JSON.stringify({data:{transactions:{pageInfo:{hasNextPage:false},edges:[{node:{id,block:{height:42,timestamp:123}}}]}}}),{status:200});
}});
assert.equal(query.status,'responded');assert.equal(query.candidates.length,1);
assert.equal((await provider.discover({...ctx,fetcher:async()=>{throw Error('timeout');}})).status,'unavailable');
const meta:TxMetadata={id,tags:[{name:'App-Name',value:'SEJIRE'},{name:'Type',value:'vault-envelope'},{name:'Vault-Id',value:vaultId},{name:'Archive-SHA256',value:'a'.repeat(64)},{name:'Archive-Bytes',value:'100'},{name:'Schema',value:'sejire/envelope/v1'},{name:'Protocol-Version',value:'sejire/v0.3'}],blockHeight:42,blockTimestamp:123};
assert.doesNotThrow(()=>validateMetadata(meta,{txId:id,source:'test'},vaultId));
assert.throws(()=>validateMetadata({...meta,id:'B'.repeat(43)},{txId:id,source:'test'},vaultId));
assert.throws(()=>validateMetadata(meta,{txId:id,source:'test'},'b'.repeat(32)),(error:unknown)=>error instanceof RecoveryFailure&&error.code==='VAULT_ID_MISMATCH');
assert.throws(()=>validateMetadata({...meta,tags:meta.tags.filter(t=>t.name!=='Vault-Id')},{txId:id,source:'test'},vaultId));
assert.doesNotThrow(()=>validateMetadata({...meta,tags:meta.tags.filter(t=>t.name!=='Vault-Id')},{txId:id,source:'legacy',legacy:true},vaultId));
const version=(txId:string,parentTxId:string|null,blockHeight:number):VerifiedVersion=>({txId,parentTxId,blockHeight,blockTimestamp:blockHeight,vault:{schema:'sejire/vault/v1',vault_id:vaultId,updated_at:'',trees:{},active_tree_id:null},sources:['test']});
const v1=version('A'.repeat(43),null,1),v2=version('B'.repeat(43),v1.txId,2),v3=version('C'.repeat(43),v2.txId,3);
assert.equal(resolveHead([v2,v1,v3]).head.txId,v3.txId);
assert.equal(resolveHead([v1,v2,version('D'.repeat(43),v1.txId,4)]).forks.length,1);

// The first fund publisher emitted these eight tags and omitted Protocol-Version.
// Such immutable archives must remain readable without weakening raw/hash/AES validation.
const fundedMeta:TxMetadata={...meta,tags:[
  ...meta.tags.filter(tag=>tag.name!=='Protocol-Version'),
  {name:'Preservation-Id',value:'c'.repeat(32)},{name:'Promo-Funded',value:'true'},
]};
const isFailure=(code:RecoveryErrorCode)=>(error:unknown)=>error instanceof RecoveryFailure&&error.code===code;
const candidate={txId:id,source:'synthetic-fund'};
const withTag=(value:TxMetadata,name:string,tagValue:string):TxMetadata=>({
  ...value,tags:value.tags.map(tag=>tag.name===name?{name,value:tagValue}:tag),
});
const withoutTag=(value:TxMetadata,name:string):TxMetadata=>({...value,tags:value.tags.filter(tag=>tag.name!==name)});
assert.doesNotThrow(()=>validateMetadata(fundedMeta,candidate,vaultId));
assert.doesNotThrow(()=>validateMetadata({...fundedMeta,tags:[...fundedMeta.tags,{name:'Protocol-Version',value:'sejire/v0.3'}]},candidate,vaultId));
for(const tag of fundedMeta.tags){
  assert.throws(()=>validateMetadata(withoutTag(fundedMeta,tag.name),{...candidate,legacy:true},vaultId),isFailure('METADATA_MISMATCH'),`missing fund ${tag.name}`);
  assert.throws(()=>validateMetadata({...fundedMeta,tags:[...fundedMeta.tags,tag]},candidate,vaultId),isFailure('METADATA_MISMATCH'),`duplicate fund ${tag.name}`);
}
for(const [name,value] of [
  ['Promo-Funded','false'],['Promo-Funded','TRUE'],['Preservation-Id','C'.repeat(32)],['Preservation-Id','c'.repeat(31)],
  ['Schema','sejire/envelope/v2'],['Archive-SHA256','A'.repeat(64)],['Archive-SHA256','a'.repeat(63)],
  ['Archive-Bytes','0'],['Archive-Bytes','0100'],['Archive-Bytes','10485761'],
  ['App-Name','SEJIRE-other'],['Type','fund-readiness'],
])assert.throws(()=>validateMetadata(withTag(fundedMeta,name,value),candidate,vaultId),isFailure('METADATA_MISMATCH'),`invalid fund ${name}`);
assert.throws(()=>validateMetadata(withTag(fundedMeta,'Vault-Id','b'.repeat(32)),candidate,vaultId),isFailure('VAULT_ID_MISMATCH'));
assert.throws(()=>validateMetadata({...fundedMeta,tags:[...fundedMeta.tags,{name:'Protocol-Version',value:'sejire/v9'}]},candidate,vaultId),isFailure('METADATA_MISMATCH'));
assert.throws(()=>validateMetadata({...fundedMeta,tags:[...fundedMeta.tags,{name:'Protocol-Version',value:'sejire/v0.3'},{name:'Protocol-Version',value:'sejire/v0.3'}]},candidate,vaultId),isFailure('METADATA_MISMATCH'));
assert.throws(()=>validateMetadata({...fundedMeta,tags:[...fundedMeta.tags,{name:'Unknown-Format',value:'another'}]},candidate,vaultId),isFailure('METADATA_MISMATCH'));
assert.throws(()=>validateMetadata(withoutTag(fundedMeta,'Promo-Funded'),candidate,vaultId),isFailure('METADATA_MISMATCH'),'ordinary modern archives still require protocol');
assert.throws(()=>validateMetadata(fundedMeta,{...candidate,archiveSha256:'d'.repeat(64)},vaultId),isFailure('METADATA_MISMATCH'));
assert.throws(()=>validateMetadata(fundedMeta,{...candidate,archiveBytes:101},vaultId),isFailure('METADATA_MISMATCH'));

// Exercise discovery, metadata decoding, exact raw bytes, decryption, all trees/history and HEAD using real modules.
// Generated SEJIRE test words and plaintext never leave this process; the fetcher below has no network access.
const testWords=createMnemonic();
const keys=deriveKeysFromMnemonic(testWords);
let tree=createTree('Synthetic funded recovery');
tree={...tree,meta:{...tree.meta,id:'tree_fund_fixture'}};
tree=commitDraft(upsertPersonFields(tree,{id:'p_fixture',name:'Synthetic person',parents:[]}), 'Synthetic version');
const otherTree=createTree('Other synthetic tree');
otherTree.meta.id='tree_second_fixture';
const testVault=putTree(putTree(emptyVault(keys.vaultId),otherTree),tree);
const envelope=await encryptJson(keys.encKey,keys.vaultId,testVault);
const raw=serializeEnvelope(envelope);
async function metadataFor(rawText:string):Promise<TxMetadata>{
  return withTag(withTag(withTag(fundedMeta,'Vault-Id',keys.vaultId),'Archive-SHA256',await envelopeDigest(rawText)),
    'Archive-Bytes',String(new TextEncoder().encode(rawText).length));
}
const validFundMetadata=await metadataFor(raw);
const requests:{url:string;method:string}[]=[];
async function readFundedArchive(rawText:string,metadata:TxMetadata,openKeys=keys,options:{rawStatus?:number;nativeData?:string|(()=>Response)}={}){
  const gateway='https://synthetic-gateway.example';
  const encodedMetadata={...metadata,tags:metadata.tags.map(tag=>({
    name:Buffer.from(tag.name).toString('base64url'),value:Buffer.from(tag.value).toString('base64url'),
  }))};
  const fetcher:typeof fetch=async(url,init)=>{
    const address=String(url),method=init?.method??'GET';
    requests.push({url:address,method});
    assert.equal(address.includes(testWords)||String(init?.body??'').includes(testWords),false,'words stay in memory');
    if(address==='https://index.example/graphql'){
      assert.equal(method,'POST');
      const query=JSON.parse(String(init?.body));
      assert.equal(query.variables.vaultId,openKeys.vaultId);
      assert.equal(query.query.startsWith('query '),true,'discovery is a read-only GraphQL query');
      return new Response(JSON.stringify({data:{transactions:{pageInfo:{hasNextPage:false},edges:[{node:{id,block:{height:42,timestamp:123}}}]}}}));
    }
    assert.equal(method,'GET','archive retrieval never submits a transaction');
    assert.equal(init?.credentials,'omit','gateway reads carry no browser credentials');
    assert.equal(init?.referrerPolicy,'no-referrer','gateway reads carry no page referrer');
    if(address===`${gateway}/tx/${id}`)return new Response(JSON.stringify(encodedMetadata));
    if(address===`${gateway}/raw/${id}`)return new Response(rawText,{status:options.rawStatus??200});
    if(address===`${gateway}/tx/${id}/data`&&options.nativeData!==undefined){
      assert.equal(init?.redirect,'error','native data remains on the selected gateway');
      return typeof options.nativeData==='string'?new Response(options.nativeData):options.nativeData();
    }
    throw Error('Unexpected synthetic request');
  };
  const context:RecoveryContext={vaultId:openKeys.vaultId,fetcher,signal:new AbortController().signal};
  const pool:GatewayPool={candidates:async()=>[{url:gateway,source:'synthetic'}],markSuccess:()=>{},markFailure:()=>{}};
  const discovery=await provider.discover(context);
  assert.equal(discovery.status,'responded');assert.equal(discovery.candidates.length,1);
  const discovered=discovery.candidates[0];
  const diagnostics=newDiagnostics();
  const downloadedMetadata=await fetchMetadata(context,pool,discovered,diagnostics);
  const downloadedBytes=await fetchRaw(context,pool,discovered,downloadedMetadata,diagnostics);
  const verified=await verifyCandidate(downloadedBytes,downloadedMetadata,discovered,openKeys);
  return resolveHead([verified]);
}
const recovered=await readFundedArchive(raw,validFundMetadata);
assert.equal(recovered.head.txId,id);assert.equal(recovered.forks.length,0);
assert.deepEqual(recovered.head.vault,testVault,'both trees, version history and active tree survive historical fund recovery');
assert.deepEqual(requests.map(request=>request.method),['POST','GET','GET'],'only discovery and archive reads');
assert.equal((await readFundedArchive(raw,{...validFundMetadata,tags:[...validFundMetadata.tags,{name:'Protocol-Version',value:'sejire/v0.3'}]})).head.txId,id,'future fund format also opens');

const beforeMismatch=requests.length;
await assert.rejects(()=>readFundedArchive(raw,{...validFundMetadata,tags:[...validFundMetadata.tags,{name:'Protocol-Version',value:'sejire/v9'}]}),isFailure('METADATA_MISMATCH'));
assert.equal(requests.slice(beforeMismatch).some(request=>request.url.includes('/raw/')),false,'wrong explicit metadata fails before raw/decryption');
await assert.rejects(()=>readFundedArchive(raw.slice(0,-1),validFundMetadata),isFailure('RAW_HASH_MISMATCH'),'raw size remains enforced');
const changedCipher=envelope.ciphertext.startsWith('A')?'B':'A';
const changedRaw=JSON.stringify({...envelope,ciphertext:changedCipher+envelope.ciphertext.slice(1)});
assert.equal(changedRaw.length,raw.length);
await assert.rejects(()=>readFundedArchive(changedRaw,validFundMetadata),isFailure('RAW_HASH_MISMATCH'),'exact published hash remains enforced');

// A confirmed transaction can have a broken raw gateway route while the node API
// returns its correct, committed archive as base64url. This never creates a write.
const base64Archive=Buffer.from(raw).toString('base64url');
const beforeFallback=requests.length;
const rescued=await readFundedArchive(changedRaw,validFundMetadata,keys,{nativeData:base64Archive});
assert.deepEqual(rescued.head.vault,testVault,'native data fallback preserves both trees, history and active tree');
assert.deepEqual(requests.slice(beforeFallback).map(request=>request.method),['POST','GET','GET','GET']);
assert.equal(requests.at(-1)?.url,`https://synthetic-gateway.example/tx/${id}/data`);
assert.deepEqual((await readFundedArchive('',validFundMetadata,keys,{rawStatus:503,nativeData:base64Archive})).head.vault,testVault,'fallback also handles raw HTTP failure');
for(const invalidBase64 of [base64Archive+'=',base64Archive+'\n','!'+base64Archive.slice(1),'A',Buffer.from(raw.slice(0,-1)).toString('base64url'),Buffer.from(changedRaw).toString('base64url')]){
  await assert.rejects(()=>readFundedArchive(changedRaw,validFundMetadata,keys,{nativeData:invalidBase64}),isFailure('RAW_HASH_MISMATCH'),'invalid base64, size or hash cannot restore');
}
const canonicalRaw=raw.length%3===0?raw+' ':raw;
const canonicalEncoded=Buffer.from(canonicalRaw).toString('base64url');
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const noncanonicalEncoded=canonicalEncoded.slice(0,-1)+alphabet[alphabet.indexOf(canonicalEncoded.at(-1)!)|1];
assert.notEqual(noncanonicalEncoded,canonicalEncoded);
assert.deepEqual(Buffer.from(noncanonicalEncoded,'base64url'),Buffer.from(canonicalRaw),'noncanonical fixture has identical decoded bytes');
await assert.rejects(async()=>readFundedArchive('x'.repeat(canonicalRaw.length),await metadataFor(canonicalRaw),keys,{nativeData:noncanonicalEncoded}),isFailure('RAW_HASH_MISMATCH'),'nonzero unused base64 bits are rejected');
let oversizedBodyCancelled=false;
const encodedLimit=Math.ceil(raw.length*4/3);
await assert.rejects(()=>readFundedArchive(changedRaw,validFundMetadata,keys,{nativeData:()=>new Response(new ReadableStream({
  start(controller){controller.enqueue(new Uint8Array(encodedLimit+1).fill(65));},
  cancel(){oversizedBodyCancelled=true;},
}))}),isFailure('RAW_HASH_MISMATCH'),'encoded stream is bounded before decoding');
assert.equal(oversizedBodyCancelled,true);
await assert.rejects(()=>readFundedArchive(changedRaw,validFundMetadata,keys,{nativeData:()=>new Response(base64Archive,{headers:{'Content-Length':String(encodedLimit+1)}})}),isFailure('RAW_HASH_MISMATCH'),'oversized declared body is rejected');
await assert.rejects(async()=>readFundedArchive('',await metadataFor(changedRaw),keys,{rawStatus:503,nativeData:Buffer.from(changedRaw).toString('base64url')}),isFailure('DECRYPT_FAILED'),'native fallback still enforces AES-GCM after a matching hash');
await assert.rejects(async()=>readFundedArchive(changedRaw,await metadataFor(changedRaw)),isFailure('DECRYPT_FAILED'),'matching hash does not bypass AES-GCM');
const wrongEnvelopeVault=JSON.stringify({...envelope,vault_id:'b'.repeat(32)});
await assert.rejects(async()=>readFundedArchive(wrongEnvelopeVault,await metadataFor(wrongEnvelopeVault)),isFailure('VAULT_ID_MISMATCH'),'envelope vault remains enforced');
const wrongEnvelopeProtocol=JSON.stringify({...envelope,protocol:'sejire/v9'});
await assert.rejects(async()=>readFundedArchive(wrongEnvelopeProtocol,await metadataFor(wrongEnvelopeProtocol)),isFailure('RAW_HASH_MISMATCH'),'envelope protocol remains enforced');
const invalidVault=serializeEnvelope(await encryptJson(keys.encKey,keys.vaultId,{...testVault,trees:{invalid:{}}}));
await assert.rejects(async()=>readFundedArchive(invalidVault,await metadataFor(invalidVault)),isFailure('INVALID_VAULT'),'decrypted tree structure remains enforced');

// Headers alone must not release the deadline or parent abort listener. A gateway
// that returns 200 and then never completes JSON must not trap restore/publish.
async function bounded<T>(task:Promise<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([task,new Promise<never>((_resolve,reject)=>{
    timer=setTimeout(()=>reject(Error('selftest: response body escaped its deadline')),1000);
  })]);}finally{clearTimeout(timer);}
}
let deadlineCancelled=false,deadlineSignal:AbortSignal|undefined;
const stalledFetch:typeof fetch=async(_url,init)=>{
  deadlineSignal=init?.signal??undefined;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller){controller.enqueue(new TextEncoder().encode('{'));},
    cancel(){deadlineCancelled=true;},
  }));
};
await assert.rejects(()=>bounded(timedFetch(stalledFetch,'https://synthetic-gateway.example/metadata',{},15)),/gateway_read_aborted/);
assert.equal(deadlineCancelled,true,'deadline cancels a stalled response body');
assert.equal(deadlineSignal?.aborted,true,'deadline also cancels the underlying request');
const cancelledBeforeStart=new AbortController();cancelledBeforeStart.abort();let cancelledFetches=0;
await assert.rejects(()=>timedFetch(async()=>{cancelledFetches++;throw Error('must not fetch');},'https://synthetic-gateway.example/metadata',{},15,cancelledBeforeStart.signal));
assert.equal(cancelledFetches,0,'already cancelled work never starts another request');
let oversizedJsonCancelled=false;
await assert.rejects(()=>bounded(timedFetch(async()=>new Response(new ReadableStream<Uint8Array>({
  start(controller){controller.enqueue(new Uint8Array(MAX_GATEWAY_RESPONSE_BYTES+1));},
  cancel(){oversizedJsonCancelled=true;},
})),'https://synthetic-gateway.example/metadata')),/gateway_response_too_large/);
assert.equal(oversizedJsonCancelled,true,'unbounded JSON cannot accumulate in memory');

async function cancelledJsonConsumer(run:(context:RecoveryContext)=>Promise<unknown>,expectedBodies:number){
  const abort=new AbortController();let cancelled=0,started=0;
  const context:RecoveryContext={...ctx,signal:abort.signal,fetcher:async()=>{
    started++;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller){controller.enqueue(new TextEncoder().encode('{'));},
      cancel(){cancelled++;},
    }));
  }};
  const timer=setTimeout(()=>abort.abort(),15);
  try{await bounded(run(context));}finally{clearTimeout(timer);}
  assert.equal(started,expectedBodies);assert.equal(cancelled,expectedBodies,'parent cancellation remains linked through body completion');
}
await cancelledJsonConsumer(async context=>{
  assert.equal((await provider.discover(context)).status,'unavailable');
},1);
await cancelledJsonConsumer(async context=>{
  const pool:GatewayPool={candidates:async()=>[{url:'https://synthetic-gateway.example',source:'synthetic'}],markSuccess:()=>{},markFailure:()=>{}};
  await assert.rejects(()=>fetchMetadata(context,pool,candidate,newDiagnostics()),isFailure('DATA_UNAVAILABLE'));
},1);
await cancelledJsonConsumer(async context=>{
  assert.ok((await new WayfinderGatewayPool().candidates(context)).length>0,'failed peer reads retain fixed emergency gateways');
},2);

// Aborted parallel reads must not launch the next queued gateway afterward.
const cancelGateways=new AbortController();let launched=0;
const targets=Array.from({length:5},(_unused,index)=>({url:`https://gateway-${index}.example`,source:'synthetic'}));
const pendingGateways=firstUsable(targets,async(_target,signal)=>{
  launched++;
  return new Promise<never>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));
},cancelGateways.signal);
await Promise.resolve();assert.equal(launched,3);
cancelGateways.abort();await assert.rejects(()=>bounded(pendingGateways));
await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(launched,3,'no fourth or fifth gateway launches after parent cancellation');
await assert.rejects(()=>firstUsable(targets,async()=>{launched++;return true;},cancelGateways.signal));
assert.equal(launched,3,'already aborted parallel work does not run');
const immediateAbort=new AbortController();
const neverLaunched=firstUsable(targets,async()=>{launched++;return true;},immediateAbort.signal);
immediateAbort.abort();await assert.rejects(()=>neverLaunched);
assert.equal(launched,3,'cancellation before scheduled work starts does not issue a request');
console.log('Recovery provider, strict historical fund metadata, bounded native data/JSON reads, raw/hash/AES/vault checks and HEAD selftests passed');
