import type { PaidPolicy, CheckoutPolicy } from '../../../../packages/checkout/paid';
import type { TrustedTransactionReader } from './reconciliation';
import { validatePreparedPayment } from './paymentValidator';
import { PaidRpcPool, inspectPaymentRecoveryWithRpc, type PaymentRecoveryInspection } from './rpcPool';
import { DirectArweavePreservation } from './directPreservation';
import { PaidLedger, type PaidWork } from './paidLedger';
import type { PaidEnv } from './paidPolicy';

export function paidProvider(env:PaidEnv,policy:PaidPolicy):DirectArweavePreservation{
  return new DirectArweavePreservation({secret:env.ARWEAVE_TREASURY_JWK,executionEnabled:env.CHECKOUT_PAID_EXECUTION_ENABLED==='true',
    policy:{treasuryAddress:policy.storage.treasuryAddress,network:policy.storage.network,
      maxArchiveBytes:policy.storage.maxBytes,maxRewardWinston:policy.storage.maxRewardWinston}});
}
export type PaidRunnerDependencies={
  reader?:(policy:CheckoutPolicy)=>TrustedTransactionReader;
  provider?:(policy:PaidPolicy)=>Pick<DirectArweavePreservation,'prepare'|'sign'|'submit'|'reconcile'>;
};
export type PaidRecoveryDependencies={inspect?:(work:PaidWork)=>Promise<PaymentRecoveryInspection>};
/** Explicit owner action; no wallet call, new order, AR hold or archive execution.
 * Recovery success is a durable preparation fence, never an inferred "unpaid" bit. */
export async function recoverPaidOrder(ledger:PaidLedger,env:PaidEnv,hash:string,id:string,preparationId:string,deps:PaidRecoveryDependencies={}){
  const lease=crypto.randomUUID().replace(/-/g,''),claimed=await ledger.claimPaymentRecovery(hash,id,preparationId,lease,Date.now());
  if(claimed.reused)return ledger.snapshot(id);
  let reason:string|null=null;
  try{
    const work=claimed.work;
    if(!work.preparation)throw Error('payment_not_prepared');
    const inspection=await(deps.inspect?.(work)??inspectPaymentRecoveryWithRpc(env,work.record.order,work.preparation));
    if(inspection.status==='found'){
      // A genuine lost wallet result remains the original payment, never a renewal.
      await ledger.reserveInternal(id,inspection.signature,preparationId,Date.now());
      await ledger.commit(id,inspection.payment,Date.now());
      return ledger.snapshot(id);
    }
    return await ledger.finishPaymentRecovery(id,lease,preparationId,inspection.preparation,inspection.finalizedBlockHeight,Date.now());
  }catch(error){
    const code=error instanceof Error?error.message:'';
    reason=['payment_not_expired','payment_recovery_busy','previous_payment_unresolved','preparation_changed','order_expired',
      'payment_not_prepared','invalid_payment_preparation','invalid_payment_signature'].includes(code)?code:'payment_recovery_unavailable';
    throw Error(reason);
  }finally{await ledger.releaseLease(id,lease,reason,Date.now());}
}
/** Service-owned continuation. Never depends on the browser bearer token/session.
 * The lease spans verification and signing; persisted signed bytes precede submit.
 * Fixtures can inject ports from a local test entry, never HTTP fields or env URLs. */
export async function runPaidOrder(ledger:PaidLedger,env:PaidEnv,id:string,deps:PaidRunnerDependencies={}):Promise<void>{
  const lease=crypto.randomUUID().replace(/-/g,''),deadline=Date.now()+55000;
  let acquired=false,reason:string|null=null;
  try{
    let work=await ledger.claim(id,lease,Date.now());if(!work)return;acquired=true;
    if(!work.record.payment){
      if(!work.preparation){reason='payment_not_prepared';return;}
      const reader=deps.reader?.(work.policy)??new PaidRpcPool(env,work.record.order.network);
      if(work.record.pendingSignature){
        const evidence=await reader.read(work.record.pendingSignature);
        if(!evidence){reason='not-found';return;}
        const payment=await validatePreparedPayment(work.record.order,evidence,reader.chain,work.preparation);
        await ledger.commit(id,payment,Date.now());
      }else{
        if(!reader.findByReference){reason='reference_lookup_unavailable';return;}
        const found=await reader.findByReference(work.record.order,work.preparation);
        if(found.status!=='found'){reason=found.reason;return;}
        await ledger.reserveInternal(id,found.signature,work.preparation.preparationId,Date.now());
        await ledger.commit(id,found.payment,Date.now());
      }
      work=ledger.work(id);
    }
    if(work.record.order.kind==='contribution')return;
    if(work.policy.schema!=='sejire/checkout-policy/v1'){reason='paid_policy_mismatch';return;}
    if(!work.input||!work.prepared){reason='paid_payload_missing';return;}
    const provider=deps.provider?.(work.policy)??paidProvider(env,work.policy),options={deadline};
    let signed=work.signed,newSignature=false;
    if(!signed){
      if(env.CHECKOUT_PAID_EXECUTION_ENABLED!=='true'){reason='executor_paused';return;}
      // Refresh the anchor only before the FIRST signature, inside the existing
      // max-reward hold. A changed quote never asks for another SOL payment.
      const prepared=await provider.prepare(work.input,options);
      await ledger.refreshPrepared(id,lease,prepared);
      signed=await ledger.signed(id,lease,await provider.sign(work.input,prepared,options));
      newSignature=true;
    }
    let proof=newSignature?null:await provider.reconcile(work.input,signed,options);
    if(proof){
      await ledger.proof(id,lease,proof,Date.now());
      if(proof.onchainConfirmed&&proof.archiveVerified)return;
    }
    const needsUpload=newSignature||!work.submitAcknowledged||proof?.state==='not_found';
    if(needsUpload&&env.CHECKOUT_PAID_EXECUTION_ENABLED==='true'){
      // Header acceptance is not a complete upload. A lost chunk is replayed
      // with the SAME persisted signed TX until every submit is acknowledged.
      try{await provider.submit(work.input,signed,options);await ledger.submitted(id,lease);}
      catch{reason='storage_network_unavailable';}
      proof=null;
    }
    if(!proof){proof=await provider.reconcile(work.input,signed,options);await ledger.proof(id,lease,proof,Date.now());}
    reason=proof.archiveVerified?null:proof.reason??reason;
  }catch{
    // Unknown outcomes retain the exact order, hold, message and signed bytes.
    // Do not expose RPC/provider/secret details or declare the payment unpaid.
    reason='requires-reconciliation';
  }finally{
    if(acquired)await ledger.releaseLease(id,lease,reason,Date.now());
    else await ledger.arm();
  }
}
