import {FUND_CHECK_TIMEOUT_MS,type FundedArweaveProvider,type FundNetworkTx,type FundVerification} from './provider';
import type {FundOrder} from './ledger';
export type FundOperations = {call<T>(payload:unknown):Promise<T>};
/** Lease ownership and durable SIGNED precede every network write. Crashing
 * before SIGNED can only lose a local signature; crashing afterwards replays
 * that one saved transaction, including its original Merkle chunks. */
export async function runFundOrder(ledger:FundOperations,provider:FundedArweaveProvider|null,orderId:string,deadline=Date.now()+FUND_CHECK_TIMEOUT_MS):Promise<CheckedFundOrder>{
  const lease=crypto.randomUUID();
  let order=await ledger.call<FundOrder|null>({action:'fundClaim',orderId,lease});
  if(!order)return checkedOrder((await ledger.call<FundOrder>({action:'fundOrder',orderId})));
  let reason:string|null=null;
  try{
    if(!provider)throw Error('fund_provider_unavailable');
    let newlySigned=false;
    if(!order.arweaveTxId){
      if(!order.preparedTransaction)throw Error('fund_prepared_missing');
      const signed=await beforeDeadline(provider.sign({raw:order.preparedTransaction,reward:order.reservedRewardWinston}),deadline);
      if(signed.reward!==order.reservedRewardWinston)throw Error('signed_reward_mismatch');
      order=await ledger.call<FundOrder>({action:'fundEvent',input:{orderId,lease,status:'SIGNED',txId:signed.id,signed:signed.raw}});
      newlySigned=true;
    }
    if(newlySigned){
      if(!order.signedTransaction)throw Error('signed_tx_not_persisted');
      await provider.submit(order.signedTransaction,deadline);
      order=await ledger.call<FundOrder>({action:'fundEvent',input:{orderId,lease,status:'SUBMITTED'}});
    }
    const result=await settle(ledger,provider,order,{allowResubmit:!newlySigned,deadline,lease});
    reason=result.verification?.reason??null;return result;
  }catch(error){
    reason=error instanceof Error?error.message:'fund_requires_reconciliation';
    const current=await ledger.call<FundOrder>({action:'fundOrder',orderId});
    return unavailableCheck(current.arweaveTxId?await ledger.call<FundOrder>({action:'fundEvent',input:{orderId,lease,status:'NEEDS_RECONCILIATION'}}):current);
  }finally{await ledger.call({action:'fundFinish',orderId,lease,reason});}
}
async function beforeDeadline<T>(work:Promise<T>,deadline:number):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('fund_operation_timeout')),Math.max(1,deadline-Date.now()));})]);}
  finally{if(timer)clearTimeout(timer);}
}
export type CheckedFundOrder={order:FundOrder;verification?:FundVerification};
export function checkedOrder(order:FundOrder,verification?:FundVerification):CheckedFundOrder{
  // A slower concurrent check cannot contradict the immutable completion in the ledger.
  if(order.status==='COMPLETED'&&verification?.stage!=='verified')verification={stage:'verified',transactionConfirmed:true,confirmations:null,reason:null,checkedAt:order.verifiedAt??Date.now()};
  return {order,...(verification?{verification}:{})};
}
export function unavailableCheck(order:FundOrder){
  return checkedOrder(order,order.arweaveTxId?{stage:'attention',transactionConfirmed:false,confirmations:null,reason:'network_unavailable',checkedAt:Date.now()}:undefined);
}
export async function settle(ledger:FundOperations,provider:FundedArweaveProvider,order:FundOrder,options:{allowResubmit?:boolean;deadline?:number;lease?:string}={}):Promise<CheckedFundOrder>{
  if(order.status==='COMPLETED'||order.status==='FAILED'||order.status==='RELEASED'||!order.arweaveTxId)return checkedOrder(order);
  const txId=order.arweaveTxId,deadline=options.deadline??Date.now()+FUND_CHECK_TIMEOUT_MS;
  let transaction:FundNetworkTx|undefined;
  try{
    transaction=await provider.getTransaction(txId,deadline);
    // GET status checks never send bytes, create a reservation, or sign. Only the
    // leased continuation job may replay this persisted TX.
    if(options.allowResubmit&&order.signedTransaction&&transaction.state==='not_found'){
      await provider.submit(order.signedTransaction,deadline);
      order=await ledger.call({action:'fundEvent',input:{orderId:order.orderId,lease:options.lease,status:'SUBMITTED'}});
      transaction=await provider.getTransaction(txId,deadline);
    }
    if(transaction.confirmed&&transaction.reward!==order.reservedRewardWinston)throw Error('network_reward_mismatch');
    const expected={digest:order.archiveDigest,bytes:order.archiveSizeBytes,vaultId:order.vaultId};
    // A repair needs time after a slow/missing gateway read. Split
    // the remaining common budget between discovery, replay and final proof.
    const repairing=Boolean(options.allowResubmit&&order.signedTransaction&&transaction.confirmed);
    const verificationDeadline=repairing?Math.min(deadline,Date.now()+Math.max(1,Math.floor((deadline-Date.now())/3))):deadline;
    let result=await provider.verify(txId,expected,transaction,verificationDeadline);
    if(options.allowResubmit&&order.signedTransaction&&transaction.confirmed&&
      result.verification.transactionConfirmed&&result.verification.reason==='archive_unavailable'){
      // A confirmed header is not proof that its data arrived. Leased retry
      // repairs only the original signed chunks; GET remains strictly read-only.
      const replayDeadline=Math.min(deadline,Date.now()+Math.max(1,Math.floor((deadline-Date.now())*2/3)));
      await provider.replayData(order.signedTransaction,expected,replayDeadline);
      result=await provider.verify(txId,expected,transaction,deadline);
    }
    if(!result.confirmed||!result.reward||result.verification.stage!=='verified'||!result.verification.transactionConfirmed){
      const status=result.verification.stage==='attention'?'NEEDS_RECONCILIATION':'VERIFYING';
      return checkedOrder(await ledger.call({action:'fundEvent',input:{orderId:order.orderId,status}}),result.verification);
    }
    if(result.reward!==order.reservedRewardWinston)throw Error('network_reward_mismatch');
    return checkedOrder(await ledger.call({action:'fundEvent',input:{orderId:order.orderId,lease:options.lease,status:'COMPLETED',actual:result.reward}}),result.verification);
  }catch(error){
    const code=error instanceof Error?error.message:'';
    const reason:FundVerification['reason']=code==='network_reward_mismatch'?'reward_mismatch':code==='transaction_mismatch'?'transaction_mismatch':'network_unavailable';
    return checkedOrder(await ledger.call({action:'fundEvent',input:{orderId:order.orderId,lease:options.lease,status:'NEEDS_RECONCILIATION'}}),{
      stage:'attention',transactionConfirmed:transaction?.confirmed??false,confirmations:transaction?.confirmations??null,reason,checkedAt:Date.now()
    });
  }
}
