import { canonical } from '../vendor/packages/protocol/wire';
import { readOnlyLedgerSnapshot } from '../vendor/apps/sponsor/src/checkout/migrationSnapshot';
import { checkAcknowledgement, checkConfig, OBJECT_NAME, PREFIX, type ExportConfig } from './config';

type Env = { CHECKOUT_LEDGER: DurableObjectNamespace; SEJIRE_EXPORT_CONFIG: unknown; SEJIRE_EXPORT_TOKEN?: string };
type Freeze = {
  schema: 'sejire/legacy-export-freeze/v1'; configSha256: string;
  originalAlarmAt: number | null; frozenAt: number;
  alarmObservation: 'timestamp-observed' | 'null-unconfirmed'; alarmInvocationObservedAt: number | null;
  alarmReconciliation: {restoredAlarmAt:number|null;evidenceSha256:string;reconciledAt:number;attestation:'ALARM_STATE_RECONCILED'} | null;
  sourceQuiescence: {quiescedAt:number;evidenceSha256:string;sealedAt:number;attestation:'SOURCE_EXECUTION_STOPPED'} | null;
};
const FREEZE_KEY = 'sejire:legacy-export:freeze:v1';
const headers = { 'Cache-Control':'no-store, private, max-age=0', 'Pragma':'no-cache',
  'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer' };
const reply = (value: unknown, status = 200) => Response.json(value, {status, headers});
const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
const hex = (bytes: Uint8Array) => Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
async function authorize(request: Request, env: Env): Promise<boolean> {
  // Dedicated export credential; existing admin/promo/signing keys are never read.
  if (typeof env.SEJIRE_EXPORT_TOKEN !== 'string' || !/^[a-f0-9]{64}$/.test(env.SEJIRE_EXPORT_TOKEN)) return false;
  const header=request.headers.get('Authorization');
  if (!header || !/^Bearer [a-f0-9]{64}$/.test(header)) return false;
  const [expected,actual]=await Promise.all([digest(env.SEJIRE_EXPORT_TOKEN),digest(header.slice(7))]);
  let mismatch=0;for(let i=0;i<expected.length;i++)mismatch|=expected[i]^actual[i];return mismatch===0;
}
async function boundedJson(request: Request): Promise<unknown> {
  if (request.headers.get('Content-Type')?.split(';',1)[0].trim()!=='application/json') throw Error('export_json_required');
  const reader=request.body?.getReader();if(!reader)throw Error('export_target_acknowledgement_required');
  const chunks:Uint8Array[]=[];let size=0;
  try { for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;
    if(size>4096){await reader.cancel();throw Error('export_request_too_large');}chunks.push(value);}}
  finally {reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));}catch{throw Error('export_json_invalid');}
}
function configured(env: Env): ExportConfig {
  const config=checkConfig(env.SEJIRE_EXPORT_CONFIG);
  // namespace_id cannot be read from a runtime binding. A name-derived object ID
  // pins the same namespace independently of the operator's label in the config.
  if (!env.CHECKOUT_LEDGER || env.CHECKOUT_LEDGER.idFromName(OBJECT_NAME).toString()!==config.objectId) throw Error('export_namespace_object_mismatch');
  return config;
}
function publicError(error: unknown): string {
  const message=error instanceof Error?error.message:'';
  // Never include a SQL diagnostic, configuration value, key or snapshot row.
  return /^(export_[a-z_]+|ledger_snapshot_[a-z_]+)$/.test(message)?message:'export_failed';
}

// Intentionally SAME exported class name as the existing source Worker. This
// class never imports or constructs the live executor and never initializes SQL.
export class CheckoutLedger {
  private readonly config: ExportConfig;
  private readonly ready: Promise<Freeze>;
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    this.config=configured(env);
    if(ctx.id.toString()!==this.config.objectId)throw Error('export_wrong_object');
    this.ready=ctx.blockConcurrencyWhile(async()=>{
      const configSha256=hex(await digest(canonical(this.config)));
      return ctx.storage.transaction(async transaction=>{
        const previous=await transaction.get<Freeze>(FREEZE_KEY);
        let record:Freeze;
        if(previous){
          if(previous.schema!=='sejire/legacy-export-freeze/v1'||previous.configSha256!==configSha256||
             !Number.isSafeInteger(previous.frozenAt)||previous.frozenAt<this.config.maintenanceRequestedAt||
             previous.originalAlarmAt!==null&&(!Number.isSafeInteger(previous.originalAlarmAt)||previous.originalAlarmAt<0)||
             previous.alarmObservation!==(previous.originalAlarmAt===null?'null-unconfirmed':'timestamp-observed'))throw Error('export_existing_freeze_mismatch');
          record=previous;
        } else {
          const originalAlarmAt=await transaction.getAlarm();
          record={schema:'sejire/legacy-export-freeze/v1',configSha256,originalAlarmAt,frozenAt:Date.now(),
            alarmObservation:originalAlarmAt===null?'null-unconfirmed':'timestamp-observed',alarmInvocationObservedAt:null,alarmReconciliation:null,sourceQuiescence:null};
          await transaction.put(FREEZE_KEY,record);
        }
        // KV marker and alarm deletion commit atomically. A crash cannot erase
        // the original timestamp before its durable copy has been committed.
        await transaction.deleteAlarm();
        return record;
      });
    });
  }
  async alarm():Promise<void>{
    await this.ready;
    // A queued/retried alarm after the deployment is a no-op. Do not re-arm or
    // invoke any legacy runner, provider, signer, network client or SQL write.
    await this.ctx.storage.transaction(async transaction=>{
      const record=await transaction.get<Freeze>(FREEZE_KEY);
      if(!record)throw Error('export_freeze_missing');
      if(record.alarmInvocationObservedAt===null){record.alarmInvocationObservedAt=Date.now();await transaction.put(FREEZE_KEY,record);}
      await transaction.deleteAlarm();
    });
  }
  async fetch(request:Request):Promise<Response>{
    if(!await authorize(request,this.env))return reply({error:'unauthorized'},401);
    const url=new URL(request.url);
    if(url.search||!['/status','/freeze','/snapshot','/alarm-reconciliation','/seal-quiescence'].some(suffix=>url.pathname===PREFIX+suffix))return reply({error:'export_only'},404);
    if(request.method!==(url.pathname===PREFIX+'/status'?'GET':'POST'))return reply({error:'method_not_allowed'},405);
    try {
      const body=request.method==='POST'?await boundedJson(request):null;
      if(request.method==='POST')checkAcknowledgement(['/alarm-reconciliation','/seal-quiescence'].some(suffix=>url.pathname===PREFIX+suffix)?(body as {target?:unknown})?.target:body,this.config);
      await this.ready;
      if(url.pathname===PREFIX+'/seal-quiescence'){
        const input=body as {target:unknown;quiescedAt:number;evidenceSha256:string;attestation:string};
        if(!input||Object.keys(input).sort().join(',')!=='attestation,evidenceSha256,quiescedAt,target'||
           !Number.isSafeInteger(input.quiescedAt)||input.quiescedAt>Date.now()||typeof input.evidenceSha256!=='string'||
           !/^[a-f0-9]{64}$/.test(input.evidenceSha256)||input.attestation!=='SOURCE_EXECUTION_STOPPED')throw Error('export_quiescence_attestation_invalid');
        await this.ctx.storage.transaction(async transaction=>{
          const record=await transaction.get<Freeze>(FREEZE_KEY);if(!record)throw Error('export_freeze_missing');
          if(input.quiescedAt<record.frozenAt)throw Error('export_quiescence_before_freeze');
          if(record.sourceQuiescence){
            if(record.sourceQuiescence.quiescedAt!==input.quiescedAt||record.sourceQuiescence.evidenceSha256!==input.evidenceSha256)throw Error('export_quiescence_conflict');
          }else{
            record.sourceQuiescence={quiescedAt:input.quiescedAt,evidenceSha256:input.evidenceSha256,sealedAt:Date.now(),attestation:'SOURCE_EXECUTION_STOPPED'};
            await transaction.put(FREEZE_KEY,record);
          }
        });
      }
      if(url.pathname===PREFIX+'/alarm-reconciliation'){
        const input=body as {target:unknown;restoredAlarmAt:number|null;evidenceSha256:string;attestation:string};
        if(!input||Object.keys(input).sort().join(',')!=='attestation,evidenceSha256,restoredAlarmAt,target'||
           input.restoredAlarmAt!==null&&(!Number.isSafeInteger(input.restoredAlarmAt)||input.restoredAlarmAt<0)||
           typeof input.evidenceSha256!=='string'||!/^[a-f0-9]{64}$/.test(input.evidenceSha256)||input.attestation!=='ALARM_STATE_RECONCILED')throw Error('export_alarm_reconciliation_invalid');
        await this.ctx.storage.transaction(async transaction=>{
          const record=await transaction.get<Freeze>(FREEZE_KEY);if(!record)throw Error('export_freeze_missing');
          if(record.originalAlarmAt!==null)throw Error('export_alarm_already_observed');
          if(record.alarmReconciliation){
            if(record.alarmReconciliation.restoredAlarmAt!==input.restoredAlarmAt||record.alarmReconciliation.evidenceSha256!==input.evidenceSha256)throw Error('export_alarm_reconciliation_conflict');
          }else{
            record.alarmReconciliation={restoredAlarmAt:input.restoredAlarmAt,evidenceSha256:input.evidenceSha256,
              reconciledAt:Date.now(),attestation:'ALARM_STATE_RECONCILED'};await transaction.put(FREEZE_KEY,record);
          }
        });
      }
      const frozen=await this.ctx.storage.get<Freeze>(FREEZE_KEY);if(!frozen)throw Error('export_freeze_missing');
      if(await this.ctx.storage.getAlarm()!==null)throw Error('export_alarm_not_frozen');
      if(url.pathname===PREFIX+'/snapshot'){
        if(!frozen.sourceQuiescence)throw Error('export_quiescence_seal_required');
        if(frozen.originalAlarmAt===null&&!frozen.alarmReconciliation)throw Error('export_alarm_reconciliation_required');
        // Use the saved pre-freeze timestamp in the existing snapshot ABI.
        const storage={sql:this.ctx.storage.sql,transactionSync:<T>(fn:()=>T)=>this.ctx.storage.transactionSync(fn),
          getAlarm:async()=>frozen.originalAlarmAt??frozen.alarmReconciliation!.restoredAlarmAt} as DurableObjectStorage;
        const snapshot=await readOnlyLedgerSnapshot(storage,{platform:'cloudflare-durable-object',namespaceId:this.config.namespaceId,
          objectId:this.config.objectId,objectName:OBJECT_NAME,sourceCommit:this.config.sourceCommit,
          quiescedAt:frozen.sourceQuiescence.quiescedAt,exportedAt:Math.max(frozen.sourceQuiescence.sealedAt,frozen.alarmReconciliation?.reconciledAt??0),attestation:'SOURCE_EXECUTION_STOPPED'});
        const response=reply(snapshot);response.headers.set('X-Sejire-Freeze-Sha256',hex(await digest(canonical(frozen))));return response;
      }
      return reply({schema:'sejire/legacy-export-status/v1',mode:'export-only',namespaceId:this.config.namespaceId,
        objectId:this.config.objectId,sourceCommit:this.config.sourceCommit,configSha256:frozen.configSha256,
        frozenAt:frozen.frozenAt,freezeSha256:hex(await digest(canonical(frozen))),originalAlarmAt:frozen.originalAlarmAt,currentAlarmAt:null,
        alarmObservation:frozen.alarmObservation,alarmInvocationObservedAt:frozen.alarmInvocationObservedAt,alarmReconciliation:frozen.alarmReconciliation,
        sourceQuiescence:frozen.sourceQuiescence,quiescence:frozen.sourceQuiescence?'owner-attested':'unsealed',executorAvailable:false});
    }catch(error){return reply({error:publicError(error)},409);}
  }
}
export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const url=new URL(request.url);
    if(url.search||!['/status','/freeze','/snapshot','/alarm-reconciliation','/seal-quiescence'].some(suffix=>url.pathname===PREFIX+suffix))return reply({error:'export_only'},404);
    if(!await authorize(request,env))return reply({error:'unauthorized'},401);
    if(request.headers.has('Origin'))return reply({error:'export_operator_client_required'},403);
    if(request.method!==(url.pathname===PREFIX+'/status'?'GET':'POST'))return reply({error:'method_not_allowed'},405);
    try{
      const config=configured(env);
      let forwarded=request;
      if(request.method==='POST'){
        // Do not tee/clone the untrusted body: cancelling only one tee branch
        // can wait forever for its unread sibling after the size limit.
        const body=await boundedJson(request);checkAcknowledgement(['/alarm-reconciliation','/seal-quiescence'].some(suffix=>url.pathname===PREFIX+suffix)?(body as {target?:unknown})?.target:body,config);
        forwarded=new Request(request.url,{method:'POST',headers:{Authorization:request.headers.get('Authorization')!,'Content-Type':'application/json'},body:JSON.stringify(body)});
      }
      return await env.CHECKOUT_LEDGER.get(env.CHECKOUT_LEDGER.idFromString(config.objectId)).fetch(forwarded);
    }catch(error){return reply({error:publicError(error)},409);}
  },
  // Existing scheduled triggers must be detached by the owner. Until then this
  // entry has no work to execute and makes no requests on scheduled events.
  async scheduled():Promise<void>{},
};
