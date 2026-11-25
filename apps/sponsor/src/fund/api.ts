import { DurableOrderStore } from '../checkout/durableStore';
import {settle,unavailableCheck,runFundOrder,type CheckedFundOrder} from './runner';
import { authorizeAdmin } from '../adminAuth';
import { parseEnvelope, serializeEnvelope } from '../../../web/src/lib/crypto/envelope';
import { envelopeDigest } from '../../../web/src/lib/solana/policy';
import { DirectArweaveFundProvider, FUND_CHECK_TIMEOUT_MS, publicBalance, publicPrice, type FundedArweaveProvider } from './provider';
import { fundParentTxId, parseAr, TREASURY_ADDRESS, type FundOrder } from './ledger';
import {configuredPaidPolicy,type PaidEnv} from '../checkout/paidPolicy';
import {withRecipientSettings} from '../checkout/recipientSettings';
import type {SolanaRecipientSettings} from '../../../../packages/checkout/recipients';
import type {AdminPaidOverview,TreasurySnapshot,TreasuryTopup} from '../checkout/adminTypes';
import {DirectTreasuryProofReader,TOPUP_CONFIRMATIONS,type TreasuryProofReader} from './treasuryProof';
export type FundEnv=PaidEnv&{CHECKOUT_API_ENABLED?:string;FUND_API_ENABLED?:string;ARWEAVE_TREASURY_JWK?:string;PROMO_CODE_SECRET?:string;CHECKOUT_LEDGER?:DurableObjectNamespace;CHECKOUT_ALLOWED_ORIGINS?:string;ADMIN_TOKEN?:string;IDEMPOTENCY?:KVNamespace;MAX_ENVELOPE_BYTES?:string};
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
const publicCheck=(result:CheckedFundOrder)=>({order:publicOrder(result.order),...(result.verification?{verification:result.verification}:{})});
export async function fundApi(request:Request,env:FundEnv,provided?:FundedArweaveProvider,proofReader: TreasuryProofReader=new DirectTreasuryProofReader()):Promise<Response|null>{
  const url=new URL(request.url);if(url.pathname!==PREFIX&&!url.pathname.startsWith(PREFIX+'/'))return null;
  const checkDeadline=Date.now()+FUND_CHECK_TIMEOUT_MS;
  const headers:Record<string,string>={'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Vary':'Origin'};
  const reply=(status:number,data:unknown)=>new Response(status===204?null:JSON.stringify(data),{status,headers});
  const origins=(env.CHECKOUT_ALLOWED_ORIGINS??'').split(',').map(x=>x.trim()).filter(Boolean),origin=request.headers.get('Origin');
  if(!origins.length||origin&&!origins.includes(origin))return reply(403,{error:'origin_denied'});
  if(origin){headers['Access-Control-Allow-Origin']=origin;headers['Access-Control-Allow-Methods']='GET, POST, PUT, OPTIONS';headers['Access-Control-Allow-Headers']='Content-Type, Authorization';}
  if(request.method==='OPTIONS')return reply(204,null);
  if(!env.CHECKOUT_LEDGER)return reply(503,{error:'fund_not_configured'});
  if(!url.pathname.startsWith(PREFIX+'/admin')&&(!env.PROMO_CODE_SECRET||env.PROMO_CODE_SECRET.length<32))return reply(503,{error:'fund_not_configured'});
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
      if(url.pathname===PREFIX+'/admin/paid-orders'&&request.method==='GET'){
        if([...url.searchParams.keys()].some(k=>!['limit','cursor'].includes(k)))throw Error('invalid_admin_query');
        const settings=await ledger.call<SolanaRecipientSettings|null>({action:'recipientSettingsGet'}),selected=withRecipientSettings(env,settings);
        let policy:ReturnType<typeof configuredPaidPolicy>['policy']|null=null;try{policy=configuredPaidPolicy(selected).policy;}catch{/* Configuration is reported, not invented. */}
        const view=await ledger.call<Pick<AdminPaidOverview,'totals'|'orders'|'hasMore'|'cursor'>>({action:'paidAdminOverview',limit:Number(url.searchParams.get('limit')??50),cursor:url.searchParams.get('cursor')});
        const result:AdminPaidOverview={schema:'sejire/admin-paid-orders/v1',checkedAt:Date.now(),
          configuredNetwork:selected.CHECKOUT_PAID_NETWORK==='mainnet-beta'||selected.CHECKOUT_PAID_NETWORK==='devnet'?selected.CHECKOUT_PAID_NETWORK:null,
          policy:{serviceLamports:'30000000',serviceRecipient:selected.CHECKOUT_SERVICE_RECIPIENT??null,fundRecipient:selected.CHECKOUT_FUND_RECIPIENT??null,
            paymentEnabled:env.CHECKOUT_PAID_ENABLED==='true',executionEnabled:env.CHECKOUT_PAID_EXECUTION_ENABLED==='true',maxArchiveBytes:policy?.storage.maxBytes??null},...view};
        return reply(200,result);
      }
      if(url.pathname===PREFIX+'/admin/service-readiness'&&request.method==='GET'){
        const settings=await ledger.call<SolanaRecipientSettings|null>({action:'recipientSettingsGet'}),selected=withRecipientSettings(env,settings);
        const blockers:string[]=[];
        let policy:ReturnType<typeof configuredPaidPolicy>['policy']|null=null;
        try{policy=configuredPaidPolicy(selected).policy;}catch{blockers.push('paid_not_configured');}
        for(const [flag,code] of [[env.CHECKOUT_API_ENABLED,'checkout_api_disabled'],[env.CHECKOUT_PAID_ENABLED,'paid_disabled'],[env.CHECKOUT_PAID_EXECUTION_ENABLED,'executor_paused'],[env.FUND_API_ENABLED,'fund_disabled']])if(flag!=='true')blockers.push(code!);
        if(env.CHECKOUT_PAID_NETWORK!=='mainnet-beta')blockers.push('mainnet_not_configured');
        if(!env.PROMO_CODE_SECRET||env.PROMO_CODE_SECRET.length<32)blockers.push('promo_secret_not_configured');
        let signerAddress:string|null=null;try{signerAddress=await provider?.getSignerAddress()??null;}catch{/* No key details. */}
        if(!signerAddress)blockers.push('signer_unavailable');
        else{if(signerAddress!==TREASURY_ADDRESS)blockers.push('promo_treasury_mismatch');if(policy&&signerAddress!==policy.storage.treasuryAddress)blockers.push('paid_treasury_mismatch');}
        const summary=await ledger.call<{promo:{enabled:boolean;revision:number}}>({action:'fundSummary'});
        if(!summary.promo.enabled)blockers.push('promo_disabled');
        return reply(200,{schema:'sejire/service-readiness/v1',checkedAt:Date.now(),ready:blockers.length===0,scope:'configuration',blockers,
          flags:{checkoutApiEnabled:env.CHECKOUT_API_ENABLED==='true',paidEnabled:env.CHECKOUT_PAID_ENABLED==='true',executionEnabled:env.CHECKOUT_PAID_EXECUTION_ENABLED==='true',fundEnabled:env.FUND_API_ENABLED==='true'},
          network:policy?.network??null,serviceLamports:policy?.serviceLamports??null,maxArchiveBytes:policy?.storage.maxBytes??null,
          recipientRevision:settings?.revision??0,promoRevision:summary.promo.revision,
          treasury:await ledger.call({action:'treasurySnapshot',address:TREASURY_ADDRESS})});
      }
      if(url.pathname.startsWith(PREFIX+'/admin/treasury-topups')){
        const addresses=[...new Set([TREASURY_ADDRESS,...(/^[A-Za-z0-9_-]{43}$/.test(env.CHECKOUT_PAID_TREASURY_ADDRESS??'')?[env.CHECKOUT_PAID_TREASURY_ADDRESS!]:[])])];
        if([...url.searchParams.keys()].some(k=>!['limit','cursor'].includes(k))||url.pathname!==PREFIX+'/admin/treasury-topups'&&url.search)throw Error('invalid_topup_request');
        if(url.pathname===PREFIX+'/admin/treasury-topups'&&request.method==='GET')return reply(200,{schema:'sejire/treasury-topups/v1',checkedAt:Date.now(),minimumConfirmations:TOPUP_CONFIRMATIONS,
          treasuries:await Promise.all(addresses.map(address=>ledger.call({action:'treasurySnapshot',address}))),...await ledger.call<Record<string,unknown>>({action:'treasuryTopups',limit:Number(url.searchParams.get('limit')??100),cursor:url.searchParams.get('cursor')})});
        if(url.pathname===PREFIX+'/admin/treasury-topups/prepare'&&request.method==='POST'){
          const input=await body(request);only(input,['requestId','address','amountWinston','expectedRevision']);
          if(typeof input.requestId!=='string'||!orderId.test(input.requestId)||typeof input.address!=='string'||typeof input.amountWinston!=='string'||!/^[1-9][0-9]{0,29}$/.test(input.amountWinston)||!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<0)throw Error('invalid_topup_request');
          if(!addresses.includes(input.address))throw Error('treasury_not_configured');
          const prior=await ledger.call<TreasuryTopup|null>({action:'treasuryTopupGet',id:input.requestId});
          if(prior){if(prior.address!==input.address||prior.amountWinston!==input.amountWinston)throw Error('topup_idempotency_conflict');return reply(200,{intent:prior,treasury:await ledger.call({action:'treasurySnapshot',address:prior.address})});}
          const current=await ledger.call<TreasurySnapshot>({action:'treasurySnapshot',address:input.address});
          if(current.revision!==input.expectedRevision)throw Error('treasury_revision_conflict');
          let baseline;try{baseline=await proofReader.baseline(input.address);}catch{throw Error('topup_proof_unavailable');}
          return reply(200,await ledger.call({action:'treasuryTopupPrepare',input:{...input,baseline}}));
        }
        const transferMatch=/^\/api\/fund\/admin\/treasury-topups\/([a-f0-9]{32})\/transfer(?:\/(claim|signed))?$/.exec(url.pathname);
        if(transferMatch){
          if(!transferMatch[2]&&request.method==='GET')return reply(200,await ledger.call({action:'treasuryTransferGet',id:transferMatch[1]}));
          if(transferMatch[2]&&request.method==='POST'){
            const input=await body(request,65536),field=transferMatch[2]==='claim'?'unsignedTx':'signedTx';only(input,['claimId',field]);
            if(typeof input.claimId!=='string'||!orderId.test(input.claimId)||typeof input[field]!=='string')throw Error('invalid_topup_request');
            return reply(200,await ledger.call({action:transferMatch[2]==='claim'?'treasuryTransferClaim':'treasuryTransferSigned',input:{id:transferMatch[1],...input}}));
          }
          return reply(405,{error:'method_not_allowed'});
        }
        const match=/^\/api\/fund\/admin\/treasury-topups\/([a-f0-9]{32})\/confirm$/.exec(url.pathname);
        if(match&&request.method==='POST'){
          const input=await body(request);only(input,['txId','expectedRevision']);
          if(typeof input.txId!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.txId)||!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<0)throw Error('invalid_topup_request');
          const intent=await ledger.call<TreasuryTopup|null>({action:'treasuryTopupGet',id:match[1]});if(!intent)throw Error('topup_not_found');
          if(intent.txId){if(intent.txId!==input.txId)throw Error('topup_idempotency_conflict');return reply(200,{intent,treasury:await ledger.call({action:'treasurySnapshot',address:intent.address}),reused:true});}
          if(!intent.transferTag)throw Error('topup_legacy_intent_requires_review');
          if(!addresses.includes(intent.address))throw Error('treasury_not_configured');
          const current=await ledger.call<TreasurySnapshot>({action:'treasurySnapshot',address:intent.address});if(current.revision!==input.expectedRevision)throw Error('treasury_revision_conflict');
          let proof;try{proof=await proofReader.transfer(input.txId);}catch(error){const code=error instanceof Error?error.message:'';throw Error(['topup_not_confirmed','topup_transaction_mismatch','topup_intent_mismatch'].includes(code)?code:'topup_proof_unavailable');}
          return reply(200,await ledger.call({action:'treasuryTopupConfirm',input:{id:intent.id,...input,proof}}));
        }
        return reply(404,{error:'not_found'});
      }
      if(url.pathname===PREFIX+'/admin/readiness'&&request.method==='GET'){
        if(!provider)throw Error('fund_provider_unavailable');
        let signerAddress:string;
        try{signerAddress=await provider.getSignerAddress();}catch{throw Error('signer_address_unavailable');}
        if(signerAddress!==TREASURY_ADDRESS)throw Error('treasury_address_mismatch');
        let walletBalanceWinston:string;
        try{walletBalanceWinston=await provider.getBalance();}catch{throw Error('balance_unavailable');}
        const quoteBytes=Number(env.MAX_ENVELOPE_BYTES??524288);
        if(!Number.isSafeInteger(quoteBytes)||quoteBytes<1||quoteBytes>524288)throw Error('fund_not_configured');
        let currentQuoteWinston:string;
        try{currentQuoteWinston=await provider.getPrice(quoteBytes);}catch{throw Error('price_unavailable');}
        let summary:Record<string,unknown>;
        try{summary=await ledger.call<Record<string,unknown>>({action:'fundAvailable',balance:walletBalanceWinston});}catch{throw Error('fund_ledger_unavailable');}
        return reply(200,{signerAddress,signerVerified:true,walletBalanceWinston,currentQuoteWinston,quoteBytes,
          fundApiEnabled:env.FUND_API_ENABLED==='true',promo:summary.promo,limitWinston:summary.limitWinston,
          actualSpentWinston:summary.actualSpentWinston,reservedWinston:summary.reservedWinston,
          budgetRemainingWinston:summary.budgetRemainingWinston,sharedReservedWinston:summary.sharedReservedWinston,
          guardedBalanceWinston:summary.guardedBalanceWinston,effectiveAvailableWinston:summary.effectiveAvailableWinston});
      }
      if(url.pathname===PREFIX+'/admin/prepare-readiness'&&request.method==='GET'){
        if(!provider)throw Error('fund_provider_unavailable');
        const signerAddress=await provider.getSignerAddress();
        if(signerAddress!==TREASURY_ADDRESS)throw Error('treasury_address_mismatch');
        const probe=new TextEncoder().encode('SEJIRE funded preservation unsigned readiness v1');
        const prepared=await provider.prepareTransaction(probe,[{name:'App-Name',value:'SEJIRE'},{name:'Type',value:'fund-readiness'}]);
        return reply(200,{ok:true,signerVerified:true,prepared:true,rewardWinston:prepared.reward,unsigned:true,submitted:false});
      }
      if(url.pathname===PREFIX+'/admin/sign-readiness'&&request.method==='GET'){
        if(!provider)throw Error('fund_provider_unavailable');
        const signerAddress=await provider.getSignerAddress();
        if(signerAddress!==TREASURY_ADDRESS)throw Error('treasury_address_mismatch');
        const probe=new TextEncoder().encode('SEJIRE funded preservation sign readiness v1');
        let prepared;
        try{prepared=await provider.prepareTransaction(probe,[{name:'App-Name',value:'SEJIRE'},{name:'Type',value:'fund-sign-readiness'}]);}
        catch{throw Error('fund_sign_readiness_prepare_failed');}
        let signed;
        try{signed=await provider.sign(prepared);}catch{throw Error('fund_sign_readiness_failed');}
        if(signed.reward!==prepared.reward)throw Error('fund_sign_readiness_failed');
        return reply(200,{ok:true,signerVerified:true,prepared:true,signed:true,txId:signed.id,rewardWinston:signed.reward,submitted:false,persisted:false});
      }
      if(url.pathname===PREFIX+'/admin/dashboard'&&request.method==='GET'){
        const summary=await ledger.call<Record<string,unknown>>({action:'fundSummary'});
        let walletBalanceWinston:string|null=null,currentQuoteWinston:string|null=null,lastBalanceCheck:number|null=null,signerVerified=false;
        try{signerVerified=Boolean(provider&&await provider.getSignerAddress()===TREASURY_ADDRESS);}catch{ /* unavailable is not verified */ }
        try{walletBalanceWinston=await (provider?provider.getBalance():publicBalance());lastBalanceCheck=Date.now();}catch{ /* unavailable is not zero */ }
        const quoteBytes=Number(summary.averageArchiveBytes??6144);
        try{currentQuoteWinston=await (provider?provider.getPrice(quoteBytes):publicPrice(quoteBytes));}catch{ /* separate price failure */ }
        const budget=BigInt(String(summary.budgetRemainingWinston));
        const sharedReservedWinston=await ledger.call<string>({action:'treasuryHeld',address:TREASURY_ADDRESS});
        const guardedBalance=walletBalanceWinston===null?null:await ledger.call<string>({action:'treasuryEffectiveBalance',address:TREASURY_ADDRESS,balance:walletBalanceWinston});
        const walletFree=guardedBalance===null?null:BigInt(guardedBalance)>BigInt(sharedReservedWinston)?BigInt(guardedBalance)-BigInt(sharedReservedWinston):0n;
        const effective=walletFree===null?null:(budget<walletFree?budget:walletFree).toString();
        const average=summary.averageActualWinston?BigInt(String(summary.averageActualWinston)):null;
        const quote=currentQuoteWinston?BigInt(currentQuoteWinston):null;
        const cost=average===null?null:quote===null?average:average>quote?average:quote;
        return reply(200,{...summary,walletBalanceWinston,sharedReservedWinston,lastBalanceCheck,currentQuoteWinston,currentQuoteBytes:quoteBytes,effectiveAvailableWinston:effective,signerVerified,
          estimatedTreesRemaining:cost&&cost>0n&&effective!==null?(BigInt(effective)/cost).toString():null,
          fundStatus:!signerVerified||walletBalanceWinston===null||currentQuoteWinston===null?'PROVIDER ERROR':budget===0n||cost&&budget<cost?'EXHAUSTED':walletFree===0n||cost&&walletFree!==null&&walletFree<cost?'WALLET LOW':budget*10n<BigInt(String(summary.limitWinston))?'LOW':'HEALTHY'});
      }
      if(url.pathname===PREFIX+'/admin/promo'&&request.method==='POST'){
        if(!env.PROMO_CODE_SECRET||env.PROMO_CODE_SECRET.length<32)throw Error('fund_not_configured');
        const input=await body(request);only(input,['code','confirm']);if(typeof input.code!=='string'||input.code!==input.confirm)throw Error('promo_confirmation_mismatch');
        const code=normalized(input.code);if(!codeFormat.test(code))throw Error('invalid_promo_format');
        const hint=`${code.slice(0,4)}••••${code.slice(-2)}`;return reply(200,await ledger.call({action:'fundPromo',hash:await codeHash(env.PROMO_CODE_SECRET!,code),hint}));
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
          if(Date.now()>=checkDeadline)break;
          const row=await ledger.call<FundOrder|null>({action:'fundOrder',orderId:item.orderId});
          if(!row)throw Error('fund_ledger_inconsistent');
          await runFundOrder(ledger,provider,row.orderId,checkDeadline);
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
      if(!codeFormat.test(code)||await codeHash(env.PROMO_CODE_SECRET!,code)!==s.code_hash)return reply(400,{error:'promo_invalid'});
      return reply(200,{accepted:true,message:'Your preservation will be funded by SEJIRE.'});
    }
    if(url.pathname===PREFIX+'/orders'&&request.method==='POST'){
      await ledger.call({action:'fundRate',bucket:`fund:${ip}`,limit:5});
      const input=await body(request,maxArchive*2+4096);only(input,['orderId','preservationId','code','archive','parentTxId']);
      if(typeof input.orderId!=='string'||!orderId.test(input.orderId)||typeof input.preservationId!=='string'||!orderId.test(input.preservationId)||typeof input.archive!=='string')throw Error('invalid_request');
      const parentTxId=fundParentTxId(input.parentTxId);
      const archive=input.archive,bytes=new TextEncoder().encode(archive),max=Number(env.MAX_ENVELOPE_BYTES??String(maxArchive));
      if(bytes.length>maxArchive||bytes.length>max||bytes.length<100)throw Error('archive_size_invalid');
      const envelope=parseEnvelope(JSON.parse(archive));if(serializeEnvelope(envelope)!==archive)throw Error('archive_not_canonical');
      const digest=await envelopeDigest(bytes),prior=await ledger.call<FundOrder|null>({action:'fundOrder',orderId:input.orderId});
      if(prior){if(prior.archiveDigest!==digest||prior.archiveSizeBytes!==bytes.length||prior.vaultId!==envelope.vault_id||(prior.parentTxId??null)!==parentTxId)throw Error('archive_changed');
        return reply(200,publicCheck(provider?await runFundOrder(ledger,provider,prior.orderId,checkDeadline):unavailableCheck(prior)));}
      const code=typeof input.code==='string'?normalized(input.code):'';if(!codeFormat.test(code))throw Error('promo_invalid');
      const s=await ledger.call<{enabled:number;code_hash:string}>({action:'fundSettings'});if(!s.enabled)throw Error('promo_disabled');
      const hash=await codeHash(env.PROMO_CODE_SECRET!,code);if(hash!==s.code_hash)throw Error('promo_invalid');
      if(!provider)throw Error('fund_provider_unavailable');
      const balanceRevision=await ledger.call<number>({action:'treasuryRevision',address:TREASURY_ADDRESS});
      const balance=BigInt(await provider.getBalance());
      const estimated=await provider.getPrice(bytes.length);
      const prepared=await provider.prepareTransaction(bytes,[{name:'App-Name',value:'SEJIRE'},{name:'Type',value:'vault-envelope'},{name:'Schema',value:'sejire/envelope/v1'},
        {name:'Protocol-Version',value:envelope.protocol},
        {name:'Vault-Id',value:envelope.vault_id},{name:'Archive-SHA256',value:digest},{name:'Archive-Bytes',value:String(bytes.length)},
        {name:'Preservation-Id',value:input.preservationId},{name:'Promo-Funded',value:'true'},
        ...(parentTxId?[{name:'Parent-Tx',value:parentTxId}]:[])]).catch(()=>{throw Error('fund_prepare_failed');});
      const reward=BigInt(prepared.reward);if(reward<=0n||balance<reward)throw Error('wallet_low');
      const saved=await ledger.call<FundOrder>({action:'fundReserve',input:{orderId:input.orderId,preservationId:input.preservationId,hash,archiveSizeBytes:bytes.length,
        archiveDigest:digest,vaultId:envelope.vault_id,...(Object.hasOwn(input,'parentTxId')?{parentTxId}:{}),reward:prepared.reward,estimated,prepared:prepared.raw,balance:balance.toString(),balanceRevision}});
      const checked=await runFundOrder(ledger,provider,saved.orderId,checkDeadline);
      return reply(checked.order.status==='COMPLETED'?200:202,publicCheck(checked));
    }
    const match=/^\/api\/fund\/orders\/([a-f0-9]{32})$/.exec(url.pathname);
    if(match&&request.method==='GET'){
      await ledger.call({action:'fundRate',bucket:`poll:${ip}`,limit:60});const saved=await ledger.call<FundOrder|null>({action:'fundOrder',orderId:match[1]});
      if(!saved)return reply(404,{error:'order_not_found'});const next=provider?await settle(ledger,provider,saved,{deadline:checkDeadline}):unavailableCheck(saved);
      return reply(200,publicCheck(next));
    }
    return reply(404,{error:'not_found'});
  }catch(error){const code=error instanceof SyntaxError?'invalid_request':error instanceof Error?error.message:'fund_error';
    const topupCodes=['invalid_admin_query','invalid_topup_request','treasury_revision_conflict','topup_idempotency_conflict','topup_not_found','topup_transfer_invalid','topup_transfer_conflict','topup_transfer_unresolved','topup_already_credited','topup_transaction_used','topup_intent_mismatch','topup_legacy_intent_requires_review','topup_transaction_mismatch','topup_not_confirmed','topup_precedes_intent','topup_proof_unavailable','treasury_not_configured'];
    if(topupCodes.includes(code))return reply(code==='topup_not_found'?404:code==='topup_proof_unavailable'?503:['invalid_admin_query','invalid_topup_request','topup_transaction_mismatch','topup_intent_mismatch','topup_transfer_invalid'].includes(code)?400:409,{error:code});
    const known=['fund_not_configured','promo_invalid','promo_disabled','promo_missing','fund_exhausted','archive_changed','limit_below_spent','limit_below_reserved','invalid_ar_amount','invalid_promo_format','promo_confirmation_mismatch','wallet_low','fund_provider_unavailable','balance_unavailable','price_unavailable','fund_prepare_failed','fund_prepare_signer_failed','fund_prepare_client_failed','fund_prepare_price_failed','fund_prepare_network_failed','fund_prepare_anchor_failed','fund_prepare_create_failed','fund_prepare_tags_failed','fund_prepare_reward_failed','fund_prepare_serialize_failed','fund_sign_readiness_prepare_failed','fund_sign_readiness_failed','fund_signer_check_failed','fund_price_unavailable','fund_price_invalid','fund_network_unavailable','fund_anchor_unavailable','fund_create_failed','fund_tags_failed','fund_reward_invalid','fund_serialize_failed','invalid_request','invalid_envelope','envelope_too_large','forbidden_field','json_required','encoding_not_supported','request_too_large','archive_size_invalid','archive_not_canonical','rate_limited','order_not_found','fund_sign_failed','signed_tx_not_persisted','treasury_address_mismatch','signer_address_unavailable','fund_ledger_unavailable','fund_ledger_inconsistent'];
    const safe=known.includes(code)||code==='balance_observation_stale'?code:'fund_requires_reconciliation';return reply(code==='rate_limited'?429:code==='order_not_found'?404:code==='request_too_large'?413:code==='json_required'||code==='encoding_not_supported'?415:code==='promo_invalid'||code==='invalid_request'||code==='invalid_envelope'||code==='envelope_too_large'||code==='forbidden_field'||code==='archive_size_invalid'||code==='archive_changed'||code==='archive_not_canonical'||code==='invalid_ar_amount'||code==='invalid_promo_format'||code==='promo_confirmation_mismatch'?400:code==='promo_disabled'||code==='fund_exhausted'||code==='limit_below_spent'||code==='limit_below_reserved'?409:503,{error:safe});
  }
}
