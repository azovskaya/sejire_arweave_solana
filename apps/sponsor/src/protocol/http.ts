import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { createOrder } from '../../../../packages/checkout/order';
import { parseAmount } from '../../../../packages/checkout/amounts';
import { hash, DOMAIN, type Signed } from './journal';
import { ProtocolExecutor, signingKey } from './executor';
import { RpcPaymentPreparer } from '../checkout/paymentPreparation';
/** OPTIONAL localhost HTTP adapter, no Cloudflare/SQLite. Signed journal is authoritative.
 * A transport token is an ephemeral order capability; never a family recovery secret.
 */
export function protocolHttp(engine:ProtocolExecutor,origin:string,synthetic=false){
 const drafts=new Map<string,ReturnType<typeof createOrder>>();
 const headers={'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'Content-Type,Authorization,Idempotency-Key','Access-Control-Allow-Methods':'GET,POST,OPTIONS','X-Content-Type-Options':'nosniff'};
 return async (request:Request):Promise<Response>=>{
  const reply=(status:number,value:unknown)=>new Response(JSON.stringify(value),{status,headers});
  try{
   const url=new URL(request.url);if(url.search)return reply(400,{error:'query_not_supported'});
   if(request.headers.get('Origin')&&request.headers.get('Origin')!==origin)return reply(403,{error:'origin'});
   if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
   // Public export contains signed ciphertext/metadata only; not an AO storage proof.
   if(url.pathname==='/protocol/journal'&&request.method==='GET')return reply(200,engine.export());
   const prefix='/api/checkout';if(!url.pathname.startsWith(prefix))return reply(404,{error:'not_found'});
   const route=url.pathname.slice(prefix.length);
   let payload:Record<string,unknown>={};
   if(request.method==='POST'){
    if(!/^application\/json/.test(request.headers.get('Content-Type')??''))return reply(415,{error:'json_required'});
    const parts:Uint8Array[]=[];let size=0;const reader=request.body?.getReader();if(reader)for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>600000){await reader.cancel();return reply(413,{error:'too_large'});}parts.push(part.value);}
    payload=JSON.parse(Buffer.concat(parts).toString());if(!payload||typeof payload!=='object'||Array.isArray(payload))return reply(400,{error:'invalid_payload'});
   }else if(request.method!=='GET')return reply(405,{error:'method'});
   if(route==='/session'&&request.method==='POST')return reply(201,{accessToken:randomBytes(32).toString('hex'),expiresAt:Date.now()+30*86400000});
   const token=/^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('Authorization')??'')?.[1];if(!token)return reply(401,{error:'unauthorized'});
   const cap=signingKey(Buffer.from(token,'hex')),accessHash=hash(cap.publicKey);
   if(route==='/orders'&&request.method==='POST'){
    const allowed=['kind','payer','contribution','archive'];if(Object.keys(payload).some(k=>!allowed.includes(k)))return reply(400,{error:'forbidden_field'});
    const idempotency=request.headers.get('Idempotency-Key');if(!idempotency||!/^[A-Za-z0-9_-]{16,128}$/.test(idempotency))return reply(400,{error:'idempotency_key'});
    const id=hash({accessHash,idempotency}).slice(0,32),p=engine.journal.state.policy;
    const archive=payload.archive as {digest:string;bytes:number}|undefined;
    const fund=parseAmount(payload.contribution as string,9);
    const make=(createdAt:number,reference:string)=>createOrder({id,kind:payload.kind as 'preservation'|'contribution',payer:payload.payer as string,network:'devnet',asset:'SOL',reference,createdAt,expiresAt:createdAt+900000,policyVersion:p.version,servicePayment:{amount:payload.kind==='preservation'?p.serviceLamports:'0',recipient:p.serviceRecipient},fundContribution:{amount:fund,recipient:p.fundRecipient},...(archive?{archive}: {})});
    const old=engine.journal.state.orders[id]?.order??drafts.get(id);
    const order=old?make(old.createdAt,old.reference):make(Date.now(),bs58.encode(randomBytes(32)));
    if(old&&hash(old)!==hash(order))return reply(409,{error:'idempotency_conflict'});
    if(!old){if(archive)await engine.uploader.ready(archive.bytes);if(!synthetic)await new RpcPaymentPreparer().prepare(order);drafts.set(id,order);}
    const message={domain:DOMAIN,processId:engine.journal.genesis.processId,epoch:p.epoch,policyVersion:p.version,action:'Order' as const,body:{order,accessHash}};
    return reply(201,{record:{order,states:{payment:'awaiting-order-signature',contribution:'awaiting-payment',preservation:archive?'awaiting-payment':'not-applicable'}},authorization:message,localSimulation:synthetic,creationHash:engine.journal.creationHash});
   }
   const match=/^\/orders\/([a-f0-9]{32})(?:\/(authorize|prepare|reserve|verify|reconcile|execute))?$/.exec(route);if(!match)return reply(404,{error:'not_found'});
   const id=match[1],action=match[2];
   if(action==='authorize'&&request.method==='POST'){
    const event=payload as unknown as Signed;
    if(event.message?.action!=='Order'||(event.message.body.order as {id:string})?.id!==id||event.message.body.accessHash!==accessHash)throw Error('order_access');
    const prepared=drafts.get(id)??engine.journal.state.orders[id]?.order;
    if(!prepared||hash(prepared)!==hash(event.message.body.order))throw Error('unsigned_order_mismatch');
    await engine.submit(event);drafts.delete(id);return reply(200,engine.snapshot(id));
   }
   engine.access(id,token); // BEFORE pending or any external work.
   if(request.method==='GET'&&!action)return reply(200,engine.snapshot(id));
   if(request.method!=='POST')return reply(405,{error:'method'});
   if(action==='prepare'){
    const r=engine.journal.state.orders[id];if(r.pendingSignature||r.payment||r.order.expiresAt<=Date.now())throw Error('previous_operation_or_expired');if(r.order.archive)await engine.uploader.ready(r.order.archive.bytes);
    return reply(200,synthetic?{source:r.order.payer,blockhash:bs58.encode(new Uint8Array(32).fill(8)),lastValidBlockHeight:1000,feeLamports:'5000'}:await new RpcPaymentPreparer().prepare(r.order));
   }
   if(action==='reserve'||action==='verify'){
    if(Object.keys(payload).join(',')!=='signature'||typeof payload.signature!=='string')throw Error('forbidden_field');
    await engine.reserve(id,payload.signature,token);return reply(202,action==='verify'?await engine.reconcile(id,token):engine.snapshot(id));
   }
   if(action==='reconcile'){if(Object.keys(payload).length)throw Error('forbidden_field');return reply(200,await engine.reconcile(id,token));}
   if(action==='execute'){if(Object.keys(payload).join(',')!=='serialized'||typeof payload.serialized!=='string')throw Error('forbidden_field');return reply(200,await engine.execute(id,payload.serialized,token));}
   return reply(404,{error:'not_found'});
  }catch(error){return reply(409,{error:error instanceof Error&&/^[a-z_]{1,80}$/.test(error.message)?error.message:'requires_reconciliation'});}
 };
}
