import { DurableOrderStore } from '../checkout/durableStore';
import { authorizeAdmin } from '../adminAuth';
import { parseEnvelope, serializeEnvelope } from '../../../web/src/lib/crypto/envelope';
import { envelopeDigest } from '../../../web/src/lib/solana/policy';
import { DirectArweaveFundProvider, publicBalance, publicPrice, type FundedArweaveProvider } from './provider';
import { parseAr, TREASURY_ADDRESS, type FundOrder } from './ledger';
export type FundEnv={FUND_API_ENABLED?:string;ARWEAVE_TREASURY_JWK?:string;PROMO_CODE_SECRET?:string;CHECKOUT_LEDGER?:DurableObjectNamespace;CHECKOUT_ALLOWED_ORIGINS?:string;ADMIN_TOKEN?:string;IDEMPOTENCY?:KVNamespace;MAX_ENVELOPE_BYTES?:string};
const PREFIX='/api/fund';
const orderId=/^[a-f0-9]{32}$/;
const codeFormat=/^[A-Z0-9][A-Z0-9-]{5,63}$/;
const maxArchive=524288;
const publicOrder=(order:FundOrder|null)=>{if(!order)return null;const {signedTransaction,preparedTransaction,...safe}=order;return safe;};
const normalized=(code:string)=>code.trim().toUpperCase();
async function codeHash(secret:string,code:string){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signed=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(normalized(code)));
  return Array.from(new Uint8Array(signed),x=>x.toString(16).padStart(2,'0')).join('');}
async function body(request:Request,max=4096):Promise<Record<string,unknown>>{
  if(!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get('Content-Type')??''))throw Error('json_required');
  if(request.headers.has('Content-Encoding'))throw Error('encoding_not_supported');
  if(Number(request.headers.get('Content-Length')??'0')>max)throw Error('request_too_large');
  if(!request.body)throw Error('invalid_request');
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
    if(size>max){await reader.cancel();throw Error('request_too_large');}chunks.push(part.value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes)) as unknown;
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_request');return value as Record<string,unknown>;
}
function only(input:Record<string,unknown>,keys:string[]){if(Object.keys(input).some(k=>!keys.includes(k)))throw Error('forbidden_field');}
async function issuer(request:Request){const raw=request.headers.get('CF-Connecting-IP')??'missing-ingress-ip';return envelopeDigest(raw);}
async function settle(ledger:DurableOrderStore,provider:FundedArweaveProvider,order:FundOrder):Promise<FundOrder>{
  if(order.status==='COMPLETED'||order.status==='FAILED'||order.status==='RELEASED'||!order.arweaveTxId)return order;
  const txId=order.arweaveTxId;
  try{
    if(order.signedTransaction){
      const existing=await provider.getTransaction(txId);
      if(!existing.confirmed&&existing.reward===null){
        await provider.submit(order.signedTransaction);
        order=await ledger.call({action:'fundEvent',input:{orderId:order.orderId,status:'SUBMITTED'}});
      }
    }
    const result=await provider.verify(txId,{digest:order.archiveDigest,bytes:order.archiveSizeBytes,vaultId:order.vaultId});
    if(!result.confirmed||!result.reward)return await ledger.call({action:'fundEvent',input:{orderId:order.orderId,status:'VERIFYING'}});
    if(result.reward!==order.reservedRewardWinston)throw Error('network_reward_mismatch');
    return await ledger.call({action:'fundEvent',input:{orderId:order.orderId,status:'COMPLETED',actual:result.reward}});
  }catch{return await ledger.call({action:'fundEvent',input:{orderId:order.orderId,status:'NEEDS_RECONCILIATION'}});}
}
export async function fundApi(request:Request,env:FundEnv,provided?:FundedArweaveProvider):Promise<Response|null>{
  const url=new URL(request.url);if(url.pathname!==PREFIX&&!url.pathname.startsWith(PREFIX+'/'))return null;
  const headers:Record<string,string>={'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Vary':'Origin'};
  const reply=(status:number,data:unknown)=>new Response(status===204?null:JSON.stringify(data),{status,headers});
  const origins=(env.CHECKOUT_ALLOWED_ORIGINS??'').split(',').map(x=>x.trim()).filter(Boolean),origin=request.headers.get('Origin');
  if(!origins.length||origin&&!origins.includes(origin))return reply(403,{error:'origin_denied'});
  if(origin){headers['Access-Control-Allow-Origin']=origin;headers['Access-Control-Allow-Methods']='GET, POST, PUT, OPTIONS';headers['Access-Control-Allow-Headers']='Content-Type, Authorization';}
  if(request.method==='OPTIONS')return reply(204,null);
  if(!env.CHECKOUT_LEDGER||!env.PROMO_CODE_SECRET||env.PROMO_CODE_SECRET.length<32)return reply(503,{error:'fund_not_configured'});
  const ledger=new DurableOrderStore(env.CHECKOUT_LEDGER);
  let provider:FundedArweaveProvider|null=provided??null;
  if(!provider&&env.ARWEAVE_TREASURY_JWK)try{provider=new DirectArweaveFundProvider(env.ARWEAVE_TREASURY_JWK);}catch{ /* no secret or key details in response */ }
  try{
    const admin=url.pathname.startsWith(PREFIX+'/admin');
    if(admin&&await authorizeAdmin(request,env)!=='ok')return reply(401,{error:'admin_unauthorized'});
    if(url.pathname===PREFIX+'/balance'&&request.method==='GET'){
      await ledger.call({action:'fundRate',bucket:`balance:${await issuer(request)}`,limit:30});
      try{return reply(200,{treasuryAddress:TREASURY_ADDRESS,walletBalanceWinston:await (provider?provider.getBalance():publicBalance()),lastBalanceCheck:Date.now()});}
      catch{return reply(200,{treasuryAddress:TREASURY_ADDRESS,walletBalanceWinston:null,lastBalanceCheck:null});}
    }
    if(admin){
      await ledger.call({action:'fundRate',bucket:`admin:${await issuer(request)}`,limit:40});
      if(url.pathname===PREFIX+'/admin/readiness'&&request.method==='GET'){
        if(!provider)throw Error('fund_provider_unavailable');
        let signerAddress:string;
        try{signerAddress=await provider.getSignerAddress();}catch{throw Error('signer_address_unavailable');}
        if(signerAddress!==TREASURY_ADDRESS)throw Error('treasury_address_mismatch');
        let walletBalanceWinston:string;
        try{walletBalanceWinston=await provider.getBalance();}catch{throw Error('balance_unavailable');}
        const quoteBytes=6144;
        let currentQuoteWinston:string;
        try{currentQuoteWinston=await provider.getPrice(quoteBytes);}catch{throw Error('price_unavailable');}
        let summary:Record<string,unknown>;
        try{summary=await ledger.call<Record<string,unknown>>({action:'fundSummary'});}catch{throw Error('fund_ledger_unavailable');}
        return reply(200,{signerAddress,signerVerified:true,walletBalanceWinston,currentQuoteWinston,quoteBytes,
          fundApiEnabled:env.FUND_API_ENABLED==='true',promo:summary.promo,limitWinston:summary.limitWinston,
          actualSpentWinston:summary.actualSpentWinston,reservedWinston:summary.reservedWinston,
          budgetRemainingWinston:summary.budgetRemainingWinston});
      }
      if(url.pathname===PREFIX+'/admin/prepare-readiness'&&request.method==='GET'){
        if(!provider)throw Error('fund_provider_unavailable');
        const signerAddress=await provider.getSignerAddress();
        if(signerAddress!==TREASURY_ADDRESS)throw Error('treasury_address_mismatch');
        const probe=new TextEncoder().encode('SEJIRE funded preservation unsigned readiness v1');
        const prepared=await provider.prepareTransaction(probe,[{name:'App-Name',value:'SEJIRE'},{name:'Type',value:'fund-readiness'}]);
        return reply(200,{ok:true,signerVerified:true,prepared:true,rewardWinston:prepared.reward,unsigned:true,submitted:false});
      }
      if(url.pathname===PREFIX+'/admin/dashboard'&&request.method==='GET'){
        const summary=await ledger.call<Record<string,unknown>>({action:'fundSummary'});
        let walletBalanceWinston:string|null=null,currentQuoteWinston:string|null=null,lastBalanceCheck:number|null=null,signerVerified=false;
        try{signerVerified=Boolean(provider&&await provider.getSignerAddress()===TREASURY_ADDRESS);}catch{ /* unavailable is not verified */ }
        try{walletBalanceWinston=await (provider?provider.getBalance():publicBalance());lastBalanceCheck=Date.now();}catch{ /* unavailable is not zero */ }
        const quoteBytes=Number(summary.averageArchiveBytes??6144);
        try{currentQuoteWinston=await (provider?provider.getPrice(quoteBytes):publicPrice(quoteBytes));}catch{ /* separate price failure */ }
        const budget=BigInt(String(summary.budgetRemainingWinston));
        const walletFree=walletBalanceWinston===null?null:BigInt(walletBalanceWinston)>BigInt(String(summary.reservedWinston))?BigInt(walletBalanceWinston)-BigInt(String(summary.reservedWinston)):0n;
        const effective=walletFree===null?null:(budget<walletFree?budget:walletFree).toString();
        const average=summary.averageActualWinston?BigInt(String(summary.averageActualWinston)):null;
        const quote=currentQuoteWinston?BigInt(currentQuoteWinston):null;
        const cost=average===null?null:quote===null?average:average>quote?average:quote;
        return reply(200,{...summary,walletBalanceWinston,lastBalanceCheck,currentQuoteWinston,currentQuoteBytes:quoteBytes,effectiveAvailableWinston:effective,signerVerified,
          estimatedTreesRemaining:cost&&cost>0n&&effective!==null?(BigInt(effective)/cost).toString():null,
          fundStatus:!signerVerified||walletBalanceWinston===null||currentQuoteWinston===null?'PROVIDER ERROR':budget===0n||cost&&budget<cost?'EXHAUSTED':walletFree===0n||cost&&walletFree!==null&&walletFree<cost?'WALLET LOW':budget*10n<BigInt(String(summary.limitWinston))?'LOW':'HEALTHY'});
      }
      if(url.pathname===PREFIX+'/admin/promo'&&request.method==='POST'){
        const input=await body(request);only(input,['code','confirm']);if(typeof input.code!=='string'||input.code!==input.confirm)throw Error('promo_confirmation_mismatch');
        const code=normalized(input.code);if(!codeFormat.test(code))throw Error('invalid_promo_format');
        const hint=`${code.slice(0,4)}••••${code.slice(-2)}`;return reply(200,await ledger.call({action:'fundPromo',hash:await codeHash(env.PROMO_CODE_SECRET,code),hint}));
      }
      if(url.pathname===PREFIX+'/admin/enabled'&&request.method==='POST'){
        const input=await body(request);only(input,['enabled']);if(typeof input.enabled!=='boolean')throw Error('invalid_request');
        return reply(200,await ledger.call({action:'fundEnable',enabled:input.enabled}));
      }
      if(url.pathname===PREFIX+'/admin/limit'&&request.method==='POST'){
        const input=await body(request);only(input,['limitAr']);if(typeof input.limitAr!=='string')throw Error('invalid_request');
        return reply(200,await ledger.call({action:'fundLimit',value:parseAr(input.limitAr)}));
      }
      if(url.pathname===PREFIX+'/admin/reconcile'&&request.method==='POST'){
        only(await body(request),[]);if(!provider)throw Error('fund_provider_unavailable');
        const summary=await ledger.call<{history:FundOrder[]}>({action:'fundSummary'});
        for(const item of summary.history.filter(x=>!['COMPLETED','FAILED','RELEASED'].includes(x.status)).slice(0,10)){
          const row=await ledger.call<FundOrder|null>({action:'fundOrder',orderId:item.orderId});
          if(!row)throw Error('fund_ledger_inconsistent');
          if(row.arweaveTxId)await settle(ledger,provider,row);
          else if(row.status==='RESERVED'&&Date.now()-row.createdAt>10*60_000)
            await ledger.call({action:'fundEvent',input:{orderId:row.orderId,status:'RELEASED'}});
        }
        return reply(200,await ledger.call({action:'fundReconciled'}));
      }
      return reply(404,{error:'not_found'});
    }
    if(url.pathname===PREFIX+'/status'&&request.method==='GET'){
      const s=await ledger.call<{promo:{enabled:boolean};budgetRemainingWinston:string}>({action:'fundSummary'});
      return reply(200,{enabled:env.FUND_API_ENABLED==='true'&&s.promo.enabled,available:env.FUND_API_ENABLED==='true'&&s.promo.enabled&&Boolean(provider)&&BigInt(s.budgetRemainingWinston)>0n});
    }
    if(env.FUND_API_ENABLED!=='true'&&url.pathname===PREFIX+'/validate')return reply(404,{error:'not_found'});
    if(env.FUND_API_ENABLED!=='true'&&url.pathname===PREFIX+'/orders'&&request.method==='POST')return reply(404,{error:'not_found'});
    const ip=await issuer(request);
    if(url.pathname===PREFIX+'/validate'&&request.method==='POST'){
      await ledger.call({action:'fundRate',bucket:`promo:${ip}`,limit:10});const input=await body(request);only(input,['code']);
      const code=typeof input.code==='string'?normalized(input.code):'';
      const s=await ledger.call<{enabled:number;code_hash:string}>({action:'fundSettings'});
      if(!s.enabled)return reply(409,{error:'promo_disabled'});
      if(!codeFormat.test(code)||await codeHash(env.PROMO_CODE_SECRET,code)!==s.code_hash)return reply(400,{error:'promo_invalid'});
      return reply(200,{accepted:true,message:'Your preservation will be funded by SEJIRE.'});
    }
    if(url.pathname===PREFIX+'/orders'&&request.method==='POST'){
      await ledger.call({action:'fundRate',bucket:`fund:${ip}`,limit:5});
      const input=await body(request,maxArchive*2+4096);only(input,['orderId','preservationId','code','archive']);
      if(typeof input.orderId!=='string'||!orderId.test(input.orderId)||typeof input.preservationId!=='string'||!orderId.test(input.preservationId)||typeof input.archive!=='string')throw Error('invalid_request');
      const archive=input.archive,bytes=new TextEncoder().encode(archive),max=Number(env.MAX_ENVELOPE_BYTES??String(maxArchive));
      if(bytes.length>maxArchive||bytes.length>max||bytes.length<100)throw Error('archive_size_invalid');
      const envelope=parseEnvelope(JSON.parse(archive));if(serializeEnvelope(envelope)!==archive)throw Error('archive_not_canonical');
      const digest=await envelopeDigest(bytes),prior=await ledger.call<FundOrder|null>({action:'fundOrder',orderId:input.orderId});
      if(prior){if(prior.archiveDigest!==digest||prior.archiveSizeBytes!==bytes.length||prior.vaultId!==envelope.vault_id)throw Error('archive_changed');
        return reply(200,{order:publicOrder(provider?await settle(ledger,provider,prior):prior)});}
      const code=typeof input.code==='string'?normalized(input.code):'';if(!codeFormat.test(code))throw Error('promo_invalid');
      const s=await ledger.call<{enabled:number;code_hash:string}>({action:'fundSettings'});if(!s.enabled)throw Error('promo_disabled');
      const hash=await codeHash(env.PROMO_CODE_SECRET,code);if(hash!==s.code_hash)throw Error('promo_invalid');
      if(!provider)throw Error('fund_provider_unavailable');const balance=BigInt(await provider.getBalance());
      const estimated=await provider.getPrice(bytes.length);
      const prepared=await provider.prepareTransaction(bytes,[{name:'App-Name',value:'SEJIRE'},{name:'Type',value:'vault-envelope'},{name:'Schema',value:'sejire/envelope/v1'},
        {name:'Vault-Id',value:envelope.vault_id},{name:'Archive-SHA256',value:digest},{name:'Archive-Bytes',value:String(bytes.length)},
        {name:'Preservation-Id',value:input.preservationId},{name:'Promo-Funded',value:'true'}]).catch(()=>{throw Error('fund_prepare_failed');});
      const reward=BigInt(prepared.reward);if(reward<=0n||balance<reward)throw Error('wallet_low');
      let saved=await ledger.call<FundOrder>({action:'fundReserve',input:{orderId:input.orderId,preservationId:input.preservationId,hash,archiveSizeBytes:bytes.length,
        archiveDigest:digest,vaultId:envelope.vault_id,reward:prepared.reward,estimated,prepared:prepared.raw,balance:balance.toString()}});
      if(saved.arweaveTxId)return reply(202,{order:publicOrder(saved)});
      try{const signed=await provider.sign({raw:saved.preparedTransaction!,reward:saved.reservedRewardWinston});
        if(signed.reward!==saved.reservedRewardWinston)throw Error('signed_reward_mismatch');
        saved=await ledger.call({action:'fundEvent',input:{orderId:saved.orderId,status:'SIGNED',txId:signed.id,signed:signed.raw}});
      }catch{const current=await ledger.call<FundOrder>({action:'fundOrder',orderId:input.orderId});if(!current.arweaveTxId)await ledger.call({action:'fundEvent',input:{orderId:input.orderId,status:'RELEASED'}});throw Error('fund_sign_failed');}
      if(!saved.signedTransaction)throw Error('signed_tx_not_persisted');
      try{await provider.submit(saved.signedTransaction);saved=await ledger.call({action:'fundEvent',input:{orderId:saved.orderId,status:'SUBMITTED'}});}
      catch{saved=await ledger.call({action:'fundEvent',input:{orderId:saved.orderId,status:'NEEDS_RECONCILIATION'}});return reply(202,{order:publicOrder(saved)});}
      saved=await settle(ledger,provider,saved);return reply(saved.status==='COMPLETED'?200:202,{order:publicOrder(saved)});
    }
    const match=/^\/api\/fund\/orders\/([a-f0-9]{32})$/.exec(url.pathname);
    if(match&&request.method==='GET'){
      await ledger.call({action:'fundRate',bucket:`poll:${ip}`,limit:60});const saved=await ledger.call<FundOrder|null>({action:'fundOrder',orderId:match[1]});
      if(!saved)return reply(404,{error:'order_not_found'});const next=provider?await settle(ledger,provider,saved):saved;
      return reply(200,{order:publicOrder(next)});
    }
    return reply(404,{error:'not_found'});
  }catch(error){const code=error instanceof SyntaxError?'invalid_request':error instanceof Error?error.message:'fund_error';
    const known=['promo_invalid','promo_disabled','promo_missing','fund_exhausted','archive_changed','limit_below_spent','limit_below_reserved','invalid_ar_amount','invalid_promo_format','promo_confirmation_mismatch','wallet_low','fund_provider_unavailable','balance_unavailable','price_unavailable','fund_prepare_failed','fund_signer_check_failed','fund_price_unavailable','fund_price_invalid','fund_network_unavailable','fund_anchor_unavailable','fund_create_failed','fund_tags_failed','fund_reward_invalid','fund_serialize_failed','invalid_request','invalid_envelope','envelope_too_large','forbidden_field','json_required','encoding_not_supported','request_too_large','archive_size_invalid','archive_not_canonical','rate_limited','order_not_found','fund_sign_failed','signed_tx_not_persisted','treasury_address_mismatch','signer_address_unavailable','fund_ledger_unavailable','fund_ledger_inconsistent'];
    const safe=known.includes(code)?code:'fund_requires_reconciliation';return reply(code==='rate_limited'?429:code==='order_not_found'?404:code==='request_too_large'?413:code==='json_required'||code==='encoding_not_supported'?415:code==='promo_invalid'||code==='invalid_request'||code==='invalid_envelope'||code==='envelope_too_large'||code==='forbidden_field'||code==='archive_size_invalid'||code==='archive_changed'||code==='archive_not_canonical'||code==='invalid_ar_amount'||code==='invalid_promo_format'||code==='promo_confirmation_mismatch'?400:code==='promo_disabled'||code==='fund_exhausted'||code==='limit_below_spent'||code==='limit_below_reserved'?409:503,{error:safe});
  }
}
