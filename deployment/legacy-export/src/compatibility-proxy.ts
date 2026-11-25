import exportOnly,{CheckoutLedger} from './export-only';
import {checkConfig,PREFIX} from './config';
export {CheckoutLedger}; // Keep the original namespace bound to a frozen class.
export type ProxyConfig={schema:'sejire/legacy-compatibility-proxy/v1';linuxOrigin:string;namespaceId:string;objectId:string;sourceCommit:string;
  sourceSnapshotSha256:string;sourceFreezeSha256:string;cutoverEvidenceSha256:string;acceptedAt:number;attestation:'LINUX_IMPORT_AND_LEGACY_ORIGINS_VERIFIED'};
type Env={CHECKOUT_LEDGER:DurableObjectNamespace;SEJIRE_EXPORT_CONFIG:unknown;SEJIRE_EXPORT_TOKEN?:string;SEJIRE_COMPAT_PROXY_CONFIG:unknown};
export function checkProxyConfig(input:unknown,now=Date.now()):ProxyConfig{
  const c=input as ProxyConfig;
  if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).sort().join(',')!=='acceptedAt,attestation,cutoverEvidenceSha256,linuxOrigin,namespaceId,objectId,schema,sourceCommit,sourceFreezeSha256,sourceSnapshotSha256'||
     c.schema!=='sejire/legacy-compatibility-proxy/v1'||typeof c.linuxOrigin!=='string'||typeof c.namespaceId!=='string'||!/^[a-f0-9]{32}$/.test(c.namespaceId)||
     typeof c.objectId!=='string'||!/^[a-f0-9]{64}$/.test(c.objectId)||typeof c.sourceCommit!=='string'||!/^[a-f0-9]{40}$/.test(c.sourceCommit)||
     [c.sourceSnapshotSha256,c.sourceFreezeSha256,c.cutoverEvidenceSha256].some(value=>typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))||
     !Number.isSafeInteger(c.acceptedAt)||c.acceptedAt<=0||c.acceptedAt>now||c.attestation!=='LINUX_IMPORT_AND_LEGACY_ORIGINS_VERIFIED')throw Error('compatibility_configuration_invalid');
  let origin;try{origin=new URL(c.linuxOrigin);}catch{throw Error('compatibility_configuration_invalid');}
  if(origin.origin!==c.linuxOrigin||origin.protocol!=='https:'||origin.username||origin.password||origin.port)throw Error('compatibility_configuration_invalid');
  return c;
}
const reply=(error:string,status:number)=>Response.json({error},{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const allowedRequestHeaders=['authorization','idempotency-key','content-type','accept','origin','access-control-request-method','access-control-request-headers'];
const hopHeaders=['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','content-length'];
async function guarded<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted)throw Error('compatibility_deadline');let onAbort:()=>void=()=>{};
  try{return await Promise.race([promise,new Promise<T>((_,reject)=>{onAbort=()=>reject(Error('compatibility_deadline'));signal.addEventListener('abort',onAbort,{once:true});})]);}
  finally{signal.removeEventListener('abort',onAbort);}
}
async function bytes(stream:ReadableStream<Uint8Array>|null,max:number,signal:AbortSignal):Promise<Uint8Array>{
  if(!stream)return new Uint8Array();const reader=stream.getReader(),parts:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await guarded(reader.read(),signal);if(part.done)break;size+=part.value.byteLength;if(size>max)throw Error('compatibility_body_limit');parts.push(part.value);}}
  catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  const value=new Uint8Array(size);let offset=0;for(const part of parts){value.set(part,offset);offset+=part.length;}return value;
}
/** One bounded forward only. Unknown POST outcome stays unknown; the same
 * original capability/idempotency journal is still authoritative on Linux. */
export async function forwardLegacyRequest(request:Request,env:Env,upstream:typeof fetch=(input,init)=>fetch(input,init)):Promise<Response>{
  const url=new URL(request.url);
  if(url.pathname===PREFIX||url.pathname.startsWith(PREFIX+'/'))return exportOnly.fetch(request,env);
  if(!['/api/checkout','/api/fund'].some(prefix=>url.pathname===prefix||url.pathname.startsWith(prefix+'/')))return reply('legacy_route_requires_separate_migration',410);
  if(!['GET','POST','OPTIONS'].includes(request.method))return reply('method_not_allowed',405);
  if(request.url.length>8192||request.headers.has('Content-Encoding'))return reply('compatibility_request_unsupported',415);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),55000);let sent=false;
  try{
    const config=checkProxyConfig(env.SEJIRE_COMPAT_PROXY_CONFIG),source=checkConfig(env.SEJIRE_EXPORT_CONFIG);
    if(config.namespaceId!==source.namespaceId||config.objectId!==source.objectId||config.sourceCommit!==source.sourceCommit||config.linuxOrigin===url.origin)throw Error('compatibility_source_mismatch');
    const statusResponse=await guarded(exportOnly.fetch(new Request('https://operator.invalid'+PREFIX+'/status',{
      headers:{Authorization:'Bearer '+(env.SEJIRE_EXPORT_TOKEN??'')}}),env),controller.signal);
    if(statusResponse.status!==200)throw Error('compatibility_source_not_frozen');
    const status=await guarded(statusResponse.json() as Promise<Record<string,unknown>>,controller.signal);
    if(status.namespaceId!==config.namespaceId||status.objectId!==config.objectId||status.sourceCommit!==config.sourceCommit||
       status.freezeSha256!==config.sourceFreezeSha256||status.currentAlarmAt!==null||status.quiescence!=='owner-attested'||status.executorAvailable!==false||
       Number((status.sourceQuiescence as {sealedAt?:number}|null)?.sealedAt)>config.acceptedAt)throw Error('compatibility_source_not_frozen');
    const payload=await bytes(request.body,2*1024*1024,controller.signal);
    const headers=new Headers();for(const name of allowedRequestHeaders){const value=request.headers.get(name);if(value!==null)headers.set(name,value);}
    // Host, Connection and caller-supplied Forwarded/X-Forwarded-For/CF IP are
    // deliberately not forwarded. Linux ingress trust is a separate owner gate.
    sent=true;
    const response=await guarded(upstream(config.linuxOrigin+url.pathname+url.search,{method:request.method,headers,
      // workerd supports follow/manual, not Fetch's browser/Node error mode.
      // manual + the explicit 3xx rejection below prevents every redirect.
      body:request.method==='POST'?payload.buffer as ArrayBuffer:undefined,redirect:'manual',signal:controller.signal}),controller.signal);
    if(response.status>=300&&response.status<400){void response.body?.cancel().catch(()=>{});throw Error('compatibility_redirect_refused');}
    const result=await bytes(response.body,4*1024*1024,controller.signal),responseHeaders=new Headers(response.headers);
    for(const name of (responseHeaders.get('Connection')??'').split(',').map(value=>value.trim()).filter(Boolean))responseHeaders.delete(name);
    for(const header of hopHeaders)responseHeaders.delete(header);responseHeaders.set('Cache-Control','no-store');
    return new Response([204,205,304].includes(response.status)?null:result.buffer as ArrayBuffer,{status:response.status,headers:responseHeaders});
  }catch(error){
    // After a POST is sent, a transport failure is explicitly uncertain. Do not
    // sign, create a replacement order, retry or redirect on the caller's behalf.
    if(sent)return reply('compatibility_upstream_outcome_unknown',502);
    return reply(error instanceof Error&&error.message==='compatibility_body_limit'?'compatibility_request_too_large':'compatibility_not_ready',503);
  }finally{clearTimeout(timer);}
}
export default {fetch(request:Request,env:Env){return forwardLegacyRequest(request,env);},async scheduled():Promise<void>{}};
