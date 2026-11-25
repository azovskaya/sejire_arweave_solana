import {readFile,lstat,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {sha256} from './prepare.mjs';
import {checkProxyConfig} from './src/compatibility-proxy.ts';
import {checkConfig} from './src/config.ts';
import {canonical} from './vendor/packages/protocol/wire.ts';
const root=dirname(fileURLToPath(import.meta.url));
async function privateFile(path,max=512*1024){const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.size>max)throw Error('compatibility_private_file_required');return readFile(path,'utf8');}
/** Prepare only. Actual Linux import, review-barrier ACK, old-origin CORS and
 * capability/resume checks must be evidenced by the operator before this call. */
export async function prepareProxy(preparedDirectory,sidecarFile,cutoverFile,outputDirectory){
  const rawMetadata=await privateFile(join(preparedDirectory,'upload-metadata.json')),review=JSON.parse(await privateFile(join(preparedDirectory,'operator-review.json'))),metadata=JSON.parse(rawMetadata);
  const sidecar=JSON.parse(await privateFile(sidecarFile)),cutoverBytes=await privateFile(cutoverFile),cutover=JSON.parse(cutoverBytes);
  const source=checkConfig(sidecar.config),uploadTarget=`https://api.cloudflare.com/client/v4/accounts/${source.accountId}/workers/scripts/${source.scriptName}`;
  if(review.schema!=='sejire/legacy-export-preparation/v1'||review.metadataSha256!==sha256(rawMetadata)||sidecar.schema!=='sejire/legacy-export-sidecar/v1'||
     review.uploadTarget!==uploadTarget||sidecar.freeze.configSha256!==sha256(canonical(source))||
     metadata.main_module!=='export-only.mjs'||metadata.bindings?.length!==2||metadata.bindings[0].namespace_id!==sidecar.config.namespaceId||
     metadata.bindings[0].type!=='durable_object_namespace'||metadata.bindings[0].name!=='CHECKOUT_LEDGER'||metadata.bindings[0].class_name!=='CheckoutLedger'||
     Object.keys(metadata.bindings[0]).sort().join(',')!=='class_name,name,namespace_id,type'||metadata.bindings[1].type!=='json'||metadata.bindings[1].name!=='SEJIRE_EXPORT_CONFIG'||
     canonical(metadata.bindings[1].json)!==canonical(sidecar.config)||!sidecar.freeze.sourceQuiescence||
     sidecar.freeze.sourceQuiescence.attestation!=='SOURCE_EXECUTION_STOPPED'||sha256(canonical(sidecar.freeze))!==sidecar.status.freezeSha256||
     !Array.isArray(metadata.migrations?.steps)||metadata.migrations.steps.length||metadata.migrations.old_tag!==metadata.migrations.new_tag||
     Object.keys(metadata.migrations).sort().join(',')!=='new_tag,old_tag,steps'||'exports'in metadata)throw Error('compatibility_source_evidence_invalid');
  const config=checkProxyConfig(cutover);
  if(config.namespaceId!==sidecar.config.namespaceId||config.objectId!==sidecar.config.objectId||config.sourceCommit!==sidecar.config.sourceCommit||
     config.sourceSnapshotSha256!==sidecar.snapshotSha256||config.sourceFreezeSha256!==sidecar.status.freezeSha256||config.acceptedAt<sidecar.freeze.sourceQuiescence.sealedAt)throw Error('compatibility_cutover_mismatch');
  const out=resolve(outputDirectory);await mkdir(out,{mode:0o700});
  const bundled=await build({entryPoints:[join(root,'src/compatibility-proxy.ts')],bundle:true,platform:'browser',format:'esm',target:'es2022',write:false,metafile:true});
  const allowed=new Set(['src/compatibility-proxy.ts','src/export-only.ts','src/config.ts','vendor/apps/sponsor/src/checkout/migrationSnapshot.ts','vendor/packages/protocol/wire.ts'].map(name=>join(root,name)));
  if(Object.keys(bundled.metafile.inputs).some(name=>!allowed.has(resolve(name))))throw Error('compatibility_bundle_unreviewed_dependency');
  const proxyMetadata={...metadata,main_module:'compatibility-proxy.mjs',keep_bindings:[...new Set([...metadata.keep_bindings,'json'])].sort(),
    bindings:[...metadata.bindings,{type:'json',name:'SEJIRE_COMPAT_PROXY_CONFIG',json:config}],
    annotations:{'workers/message':'SEJIRE legacy API compatibility proxy; all execution on owner-verified Linux'}};
  const summary={schema:'sejire/legacy-proxy-preparation/v1',prepared:true,deployed:false,sourceSnapshotSha256:config.sourceSnapshotSha256,
    sourceFreezeSha256:config.sourceFreezeSha256,cutoverInputSha256:sha256(cutoverBytes),linuxOrigin:config.linuxOrigin,
    moduleSha256:sha256(bundled.outputFiles[0].contents),uploadTarget,
    verifiedByTool:'local-artifacts-and-frozen-source-identity-only',linuxImportAndOrigins:'owner-attested'};
  for(const [name,value] of Object.entries({'compatibility-proxy.mjs':bundled.outputFiles[0].contents,
    'upload-metadata.json':JSON.stringify(proxyMetadata,null,2)+'\n','operator-review.json':JSON.stringify(summary,null,2)+'\n'}))await writeFile(join(out,name),value,{mode:0o600,flag:'wx'});
  return summary;
}
