import {open,lstat,readFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {checkConfig,PREFIX} from './src/config.ts';
import {validateLedgerSnapshot} from './vendor/apps/sponsor/src/checkout/migrationSnapshot.ts';
import {canonical} from './vendor/packages/protocol/wire.ts';
import {sha256} from './prepare.mjs';
const json=value=>JSON.stringify(value,null,2)+'\n';
async function privateRead(path,max){const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.size>max)throw Error('export_private_input_required');return readFile(path,'utf8');}
function checkOrigin(value){let url;try{url=new URL(value);}catch{throw Error('export_https_origin_required');}
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.port)throw Error('export_https_origin_required');return url.origin;}
async function boundedText(response,limit){const reader=response.body?.getReader();if(!reader)throw Error('export_response_empty');let size=0;const chunks=[];
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>limit){void reader.cancel().catch(()=>{});throw Error('export_response_too_large');}chunks.push(part.value);}}
  finally{reader.releaseLock();}
  const buffer=new Uint8Array(size);let offset=0;for(const part of chunks){buffer.set(part,offset);offset+=part.length;}return new TextDecoder('utf-8',{fatal:true}).decode(buffer);
}
function checkedStatus(status,config){
  if(status?.quiescence==='unsealed')throw Error('export_quiescence_seal_required');
  if(status?.schema!=='sejire/legacy-export-status/v1'||status.mode!=='export-only'||status.namespaceId!==config.namespaceId||status.objectId!==config.objectId||status.sourceCommit!==config.sourceCommit||
    status.configSha256!==sha256(canonical(config))||status.currentAlarmAt!==null||status.quiescence!=='owner-attested'||status.executorAvailable!==false||
    !Number.isSafeInteger(status.frozenAt)||status.frozenAt<config.maintenanceRequestedAt)throw Error('export_status_mismatch');
  const freeze={schema:'sejire/legacy-export-freeze/v1',configSha256:status.configSha256,originalAlarmAt:status.originalAlarmAt,frozenAt:status.frozenAt,
    alarmObservation:status.alarmObservation,alarmInvocationObservedAt:status.alarmInvocationObservedAt,alarmReconciliation:status.alarmReconciliation,sourceQuiescence:status.sourceQuiescence};
  if(sha256(canonical(freeze))!==status.freezeSha256)throw Error('export_freeze_hash_mismatch');
  if(!freeze.sourceQuiescence||freeze.sourceQuiescence.attestation!=='SOURCE_EXECUTION_STOPPED')throw Error('export_quiescence_seal_required');
  if(freeze.originalAlarmAt===null&&!freeze.alarmReconciliation)throw Error('export_alarm_reconciliation_required');
  return freeze;
}
async function durableWrite(directory,name,contents){const file=await open(join(directory,name),'wx',0o600);try{await file.writeFile(contents);await file.sync();}finally{await file.close();}}
/** Explicit operator action only. This collector cannot deploy, sign, execute a
 * job, acknowledge an unknown alarm, retry a request, or overwrite a directory. */
export async function collect({origin,configFile,tokenFile,outputDirectory},request=globalThis.fetch){
  origin=checkOrigin(origin);const config=checkConfig(JSON.parse(await privateRead(configFile,16384)));
  const token=(await privateRead(tokenFile,256)).trim();if(!/^[a-f0-9]{64}$/.test(token))throw Error('export_credential_invalid');
  const out=resolve(outputDirectory);await mkdir(out,{mode:0o700});
  const call=async(path,body)=>{
    const signal=AbortSignal.timeout(60000),response=await request(origin+PREFIX+path,{method:body===undefined?'GET':'POST',
      redirect:'error',signal,headers:{Authorization:'Bearer '+token,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(response.status!==200){void response.body?.cancel().catch(()=>{});throw Error('export_request_rejected');}
    const text=await boundedText(response,path==='/snapshot'?80*1024*1024:32768);return {response,text,value:JSON.parse(text)};
  };
  const before=(await call('/status')).value;checkedStatus(before,config);
  const exported=await call('/snapshot',{namespaceId:config.namespaceId,objectId:config.objectId,sourceCommit:config.sourceCommit,attestation:config.attestation});
  const snapshot=await validateLedgerSnapshot(exported.value),after=(await call('/status')).value,freeze=checkedStatus(after,config);
  if(before.freezeSha256!==after.freezeSha256||exported.response.headers.get('X-Sejire-Freeze-Sha256')!==after.freezeSha256)throw Error('export_freeze_changed_during_collection');
  if(snapshot.source.platform!=='cloudflare-durable-object'||snapshot.source.namespaceId!==config.namespaceId||snapshot.source.objectId!==config.objectId||snapshot.source.objectName!==config.objectName||
    snapshot.source.sourceCommit!==config.sourceCommit||snapshot.source.quiescedAt!==freeze.sourceQuiescence.quiescedAt||snapshot.source.attestation!=='SOURCE_EXECUTION_STOPPED'||
    snapshot.source.exportedAt!==Math.max(freeze.sourceQuiescence.sealedAt,freeze.alarmReconciliation?.reconciledAt??0)||
    snapshot.alarmAt!==(freeze.originalAlarmAt??freeze.alarmReconciliation?.restoredAlarmAt))throw Error('export_snapshot_source_mismatch');
  const sidecar={schema:'sejire/legacy-export-sidecar/v1',origin,config,freeze,status:after,snapshotSha256:snapshot.sha256,
    snapshotFileSha256:sha256(exported.text),collectedAt:Date.now(),quiescenceProof:'owner-attestation-only',legacyKvExported:false};
  await durableWrite(out,'ledger-snapshot.json',exported.text);await durableWrite(out,'private-freeze-sidecar.json',json(sidecar));
  await durableWrite(out,'complete.json',json({schema:'sejire/legacy-export-collection/v1',complete:true,snapshotSha256:snapshot.sha256,
    snapshotFileSha256:sidecar.snapshotFileSha256,sidecarFileSha256:sha256(json(sidecar)),namespaceId:config.namespaceId,objectId:config.objectId,
    operatorReconciliationRequired:true,executorStarted:false}));
  const directory=await open(out,'r');try{await directory.sync();}finally{await directory.close();}
  return {complete:true,snapshotSha256:snapshot.sha256,snapshotFileSha256:sidecar.snapshotFileSha256,sidecarFileSha256:sha256(json(sidecar)),executorStarted:false};
}
