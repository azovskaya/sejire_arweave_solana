import assert from 'node:assert/strict';
import {resolveHead} from './head';
import {LegacyLocatorProvider} from './providers/legacyLocatorProvider';
import {GraphqlVaultProvider} from './providers/graphqlVaultProvider';
import {fetchMetadata,fetchRaw,validateMetadata,type TxMetadata} from './retrieve';
import {RecoveryFailure} from './errors';
import {newDiagnostics} from './diagnostics';
import {verifyCandidate} from './verify';
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
async function readFundedArchive(rawText:string,metadata:TxMetadata,openKeys=keys){
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
    if(address===`${gateway}/tx/${id}`)return new Response(JSON.stringify(encodedMetadata));
    if(address===`${gateway}/raw/${id}`)return new Response(rawText);
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
await assert.rejects(async()=>readFundedArchive(changedRaw,await metadataFor(changedRaw)),isFailure('DECRYPT_FAILED'),'matching hash does not bypass AES-GCM');
const wrongEnvelopeVault=JSON.stringify({...envelope,vault_id:'b'.repeat(32)});
await assert.rejects(async()=>readFundedArchive(wrongEnvelopeVault,await metadataFor(wrongEnvelopeVault)),isFailure('VAULT_ID_MISMATCH'),'envelope vault remains enforced');
const wrongEnvelopeProtocol=JSON.stringify({...envelope,protocol:'sejire/v9'});
await assert.rejects(async()=>readFundedArchive(wrongEnvelopeProtocol,await metadataFor(wrongEnvelopeProtocol)),isFailure('RAW_HASH_MISMATCH'),'envelope protocol remains enforced');
const invalidVault=serializeEnvelope(await encryptJson(keys.encKey,keys.vaultId,{...testVault,trees:{invalid:{}}}));
await assert.rejects(async()=>readFundedArchive(invalidVault,await metadataFor(invalidVault)),isFailure('INVALID_VAULT'),'decrypted tree structure remains enforced');
console.log('Recovery provider, strict historical fund metadata, raw/hash/AES/vault checks and HEAD selftests passed');
