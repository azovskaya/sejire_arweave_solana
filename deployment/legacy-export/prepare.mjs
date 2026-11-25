import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {checkConfig} from './src/config.ts';
const here=dirname(fileURLToPath(import.meta.url));
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const exact=(value,names)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...names].sort().join(',');
const error=()=>{throw Error('export_source_evidence_invalid');};
const string=(value,pattern)=>typeof value==='string'&&pattern.test(value);
export function reviewEvidence(evidence,now=Date.now()){
  if(!exact(evidence,['schema','accountId','scriptName','sourceCommit','sourceVersionId','observedAt','lifecycle','migrationTag','compatibilityDate','compatibilityFlags','namespace','bindings','object','deployment','maintenance','legacyKvDisposition']))error();
  const e=evidence;
  if(e.schema!=='sejire/legacy-export-source-evidence/v1'||!string(e.accountId,/^[a-f0-9]{32}$/)||!string(e.scriptName,/^[a-z0-9][a-z0-9-]{0,62}$/)||
    !string(e.sourceCommit,/^[a-f0-9]{40}$/)||!string(e.sourceVersionId,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)||
    !Number.isSafeInteger(e.observedAt)||e.observedAt<=0||e.observedAt>now||now-e.observedAt>60*60*1000||
    e.lifecycle!=='legacy-migrations'||!string(e.migrationTag,/^[A-Za-z0-9._-]{1,128}$/)||
    !string(e.compatibilityDate,/^\d{4}-\d{2}-\d{2}$/)||!Array.isArray(e.compatibilityFlags)||
    e.compatibilityFlags.some(flag=>!string(flag,/^[a-z0-9_]+$/))||new Set(e.compatibilityFlags).size!==e.compatibilityFlags.length||
    e.legacyKvDisposition!=='SEPARATE_PRIVATE_EXPORT_OR_RECONCILIATION_REQUIRED')error();
  const n=e.namespace,o=e.object,q=e.maintenance,d=e.deployment;
  if(!exact(n,['id','class','script','use_sqlite'])||!string(n.id,/^[a-f0-9]{32}$/)||n.class!=='CheckoutLedger'||n.script!==e.scriptName||n.use_sqlite!==true||
    !exact(o,['id','name','hasStoredData'])||!string(o.id,/^[a-f0-9]{64}$/)||o.name!=='sejire-checkout-ledger-v1'||o.hasStoredData!==true||
    !exact(q,['attestation','requestedAt'])||q.attestation!=='MAINTENANCE_EXPORT_ONLY'||!Number.isSafeInteger(q.requestedAt)||q.requestedAt<=0||q.requestedAt>e.observedAt||
    !exact(d,['versions'])||!Array.isArray(d.versions)||d.versions.length!==1||!exact(d.versions[0],['id','percentage'])||d.versions[0].id!==e.sourceVersionId||d.versions[0].percentage!==100)error();
  if(!Array.isArray(e.bindings)||!e.bindings.length)error();
  const names=new Set();let matched=false;
  for(const binding of e.bindings){
    if(!binding||!string(binding.name,/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)||names.has(binding.name)||binding.name==='SEJIRE_EXPORT_CONFIG'||
       !string(binding.type,/^[a-z_]+$/))error();names.add(binding.name);
    if(binding.type==='durable_object_namespace'){
      if(matched||!exact(binding,['type','name','class_name','namespace_id'])||binding.name!=='CHECKOUT_LEDGER'||binding.class_name!==n.class||binding.namespace_id!==n.id)error();
      matched=true;
    }else if(!exact(binding,['type','name']))error(); // Never accept any secret or plaintext values in evidence.
  }
  if(!matched)error();
  return e;
}
export function preparedValues(evidence,evidenceSha256,now=Date.now()){
  const e=reviewEvidence(evidence,now);
  const config=checkConfig({schema:'sejire/legacy-export-config/v1',accountId:e.accountId,scriptName:e.scriptName,
    bindingName:'CHECKOUT_LEDGER',className:'CheckoutLedger',namespaceId:e.namespace.id,objectName:e.object.name,objectId:e.object.id,
    sourceCommit:e.sourceCommit,sourceVersionId:e.sourceVersionId,sourceEvidenceSha256:evidenceSha256,
    maintenanceRequestedAt:e.maintenance.requestedAt,attestation:e.maintenance.attestation},now);
  const metadata={main_module:'export-only.mjs',compatibility_date:e.compatibilityDate,compatibility_flags:e.compatibilityFlags,
    keep_bindings:[...new Set([...e.bindings.map(b=>b.type),'secret_text'])].sort(),
    bindings:[{type:'durable_object_namespace',name:'CHECKOUT_LEDGER',class_name:'CheckoutLedger',namespace_id:e.namespace.id},
      {type:'json',name:'SEJIRE_EXPORT_CONFIG',json:config}],
    // An unchanged legacy migration tag is a compare-and-swap guard. There are
    // NO lifecycle steps and no new/deleted/renamed/transferred class fields.
    migrations:{old_tag:e.migrationTag,new_tag:e.migrationTag,steps:[]},
    logpush:false,observability:{enabled:false},annotations:{'workers/message':'SEJIRE private export-only maintenance; owner must seal quiescence'}};
  return {config,metadata,acknowledgement:{namespaceId:config.namespaceId,objectId:config.objectId,sourceCommit:config.sourceCommit,attestation:config.attestation},
    uploadTarget:`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/workers/scripts/${config.scriptName}`};
}
async function privateInput(path){const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.size>256*1024)throw Error('export_private_evidence_file_required');return readFile(path);}
export async function prepare(evidencePath,outDirectory){
  const bytes=await privateInput(evidencePath),values=preparedValues(JSON.parse(bytes.toString('utf8')),sha256(bytes));
  const out=resolve(outDirectory);
  // Exact new directory only; a second invocation must never overwrite reviewed
  // metadata, an existing export, a credential or a deployed bundle.
  await mkdir(out,{mode:0o700});
  const bundle=await build({entryPoints:[join(here,'src/export-only.ts')],bundle:true,format:'esm',platform:'browser',target:'es2022',write:false,metafile:true});
  const inputs=Object.keys(bundle.metafile.inputs);
  const allowedInputs=new Set(['src/export-only.ts','src/config.ts','vendor/apps/sponsor/src/checkout/migrationSnapshot.ts','vendor/packages/protocol/wire.ts'].map(name=>join(awaitRealRoot,name)));
  if(inputs.some(name=>!allowedInputs.has(resolve(name))))throw Error('export_bundle_unreviewed_dependency');
  const artifact=bundle.outputFiles[0].contents;
  const json=value=>JSON.stringify(value,null,2)+'\n';
  const review={schema:'sejire/legacy-export-preparation/v1',mode:'offline-only',deployed:false,
    uploadTarget:values.uploadTarget,evidenceSha256:sha256(bytes),moduleSha256:sha256(artifact),
    metadataSha256:sha256(json(values.metadata)),sourceCommit:values.config.sourceCommit,
    namespaceId:values.config.namespaceId,objectId:values.config.objectId,
    requiredSecretName:'SEJIRE_EXPORT_TOKEN',secretValueIncluded:false,lifecycleSteps:[],
    ownerMustVerify:['exact-existing-worker-account-and-namespace','no-gradual-or-old-version-traffic','all-in-flight-work-reconciled',
      'dedicated-export-token-present','all-existing-secret-bindings-retained','exporter-version-adopted-by-the-object','legacy-kv-reviewed-separately']};
  for(const [name,value] of Object.entries({'upload-metadata.json':json(values.metadata),'operator-review.json':json(review),
    'export-acknowledgement.json':json(values.acknowledgement),'export-config.json':json(values.config),'export-only.mjs':artifact})){
    await writeFile(join(out,name),value,{mode:0o600,flag:'wx'});
  }
  return review;
}
const awaitRealRoot=await realpath(here);
