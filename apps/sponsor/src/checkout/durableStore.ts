import type { Order } from '../../../../packages/checkout/order';
import type { ValidatedPayment } from './paymentValidator';
import type { AtomicOrderStore, StoredOrder, CommitResult } from './store';
import { SqliteAtomicOrderStore } from './sqliteStore';
import { ApiLedger } from './apiLedger';
import type { UploadPlan, UploadAcceptance } from './preservation';
import { FundLedger, TREASURY_ADDRESS } from '../fund/ledger';
import { PaidLedger } from './paidLedger';
import { runPaidOrder, recoverPaidOrder } from './paidRunner';
import type { PaidEnv } from './paidPolicy';
import {DirectArweaveFundProvider,type FundedArweaveProvider} from '../fund/provider';
import {runFundOrder,type FundOperations} from '../fund/runner';
import type { DurablePaymentPreparation } from '../../../../packages/checkout/paid';
import { RecipientSettings } from './recipientSettings';
import {TreasuryTopupLedger} from './treasuryTopups';

export const LEDGER_OBJECT_NAME = 'sejire-checkout-ledger-v1';
type Env = PaidEnv & { CHECKOUT_LEDGER: DurableObjectNamespace };
/** Binding-only service. NOT a public HTTP checkout route. No create/commit forwarding from web.
 * All orders must share the named object; constructor refuses per-order object identities.
 * Public handlers select explicit operations; request bodies are never forwarded.
 */
export class CheckoutLedger {
  private readonly store: SqliteAtomicOrderStore;
  private readonly api: ApiLedger;
  private readonly fund: FundLedger;
  private readonly paid: PaidLedger;
  private readonly recipients: RecipientSettings;
  private readonly topups: TreasuryTopupLedger;
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env, private readonly dependencies: {fundProvider?:FundedArweaveProvider}={}) {
    if (!ctx.id.equals(env.CHECKOUT_LEDGER.idFromName(LEDGER_OBJECT_NAME))) throw new Error('wrong_ledger_object');
    this.store = new SqliteAtomicOrderStore(ctx.storage);
    this.api = new ApiLedger(ctx.storage, this.store);
    this.fund = new FundLedger(ctx.storage);
    this.paid = new PaidLedger(ctx.storage,this.store,this.api);
    this.recipients = new RecipientSettings(ctx.storage);
    this.topups = new TreasuryTopupLedger(ctx.storage,this.fund.treasury);
    // Re-arm durable obligations after an isolate restart, without a browser token.
    ctx.blockConcurrencyWhile(async()=>{
      // A cold alarm invokes the constructor first. Replacing an already due
      // alarm here cancels that invocation in workerd; preserve it verbatim.
      if(await ctx.storage.getAlarm()===null)await this.paid.arm();
    });
  }
  async alarm():Promise<void>{
    const fundStore:FundOperations={call:async<T>(input:unknown):Promise<T>=>{
      const f=input as {action:string;orderId:string;lease:string;reason:string|null;input:Parameters<FundLedger['event']>[0]};
      if(f.action==='fundOrder')return this.fund.order(f.orderId,true) as T;
      if(f.action==='fundClaim')return await this.fund.claim(f.orderId,f.lease) as T;
      if(f.action==='fundFinish'){await this.fund.finish(f.orderId,f.lease,f.reason);return null as T;}
      if(f.action==='fundEvent')return await this.fund.event(f.input) as T;
      throw Error('unknown_fund_action');
    }};
    let provider=this.dependencies.fundProvider??null;
    if(!provider&&this.env.ARWEAVE_TREASURY_JWK)try{provider=new DirectArweaveFundProvider(this.env.ARWEAVE_TREASURY_JWK);}catch{/* Hold obligations until a valid signer is restored. */}
    try{
      // Independent queues progress together; leases prevent overlap with HTTP.
      await Promise.allSettled([
        ...this.paid.due(Date.now(),3).map(id=>runPaidOrder(this.paid,this.env,id)),
        ...this.fund.due(Date.now(),3).map(id=>runFundOrder(fundStore,provider,id))
      ]);
    }finally{await this.paid.arm();}
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
    try {
    const data = await request.json() as { action: string; order: Order; id: string; signature: string; payment: ValidatedPayment; hash: string; key: string; intent: string; expiresAt: number; buckets: string[]; limit: number; result: { status: string; reason?: string }; plan?: UploadPlan; accepted?: UploadAcceptance; retrieved: boolean };
    const now = Date.now();
    const f=data as unknown as Record<string,unknown>;
    // Only trusted Worker service code has this binding. No browser input may invoke create/commit.
    switch (data.action) {
      case 'recipientSettingsGet': return Response.json(this.recipients.get());
      case 'recipientSettingsSave': return Response.json(await this.recipients.save(f.input, now));
      case 'paidAdminOverview': return Response.json(this.paid.adminOverview(Number(f.limit),typeof f.cursor==='string'?f.cursor:null));
      case 'treasurySnapshot': return Response.json(this.topups.snapshot(String(f.address)));
      case 'treasuryTopups': return Response.json(this.topups.list(f.limit===undefined?100:Number(f.limit),typeof f.cursor==='string'?f.cursor:null));
      case 'treasuryTopupGet': return Response.json(this.topups.get(String(f.id)));
      case 'treasuryTransferGet': return Response.json({transfer:this.topups.transfer(String(f.id))});
      case 'treasuryTransferClaim': return Response.json(await this.topups.claimTransfer(f.input as Parameters<TreasuryTopupLedger['claimTransfer']>[0],now));
      case 'treasuryTransferSigned': return Response.json(await this.topups.signTransfer(f.input as Parameters<TreasuryTopupLedger['signTransfer']>[0],now));
      case 'treasuryTopupPrepare': return Response.json(await this.topups.prepare(f.input as Parameters<TreasuryTopupLedger['prepare']>[0],now));
      case 'treasuryTopupConfirm': return Response.json(await this.topups.confirm(f.input as Parameters<TreasuryTopupLedger['confirm']>[0],now));
      case 'treasuryRevision': return Response.json(this.fund.treasury.revision(String(f.address)));
      case 'treasuryHeld': return Response.json(this.fund.treasury.held(String(f.address),TREASURY_ADDRESS));
      case 'treasuryEffectiveBalance': return Response.json(this.fund.treasury.effectiveBalance(String(f.address),String(f.balance)));
      case 'paidTotals': return Response.json(this.fund.treasury.paidTotals(typeof f.budgetId==='string'?f.budgetId:undefined));
      case 'paidHasOrders': return Response.json(this.paid.hasOrders());
      case 'paidCreate': {
        const input = f.input as Parameters<PaidLedger['create']>[0];
        // Serialize only admission (no network I/O) with recipient updates. An
        // already admitted owner/key continues its immutable original policy.
        const result = await this.ctx.blockConcurrencyWhile(async () => {
          // Expected validation failures must not escape blockConcurrencyWhile:
          // Cloudflare would reset the isolate on a callback exception.
          try {
            const existing = this.ctx.storage.sql.exec('SELECT order_id FROM api_orders WHERE owner=? AND idem_key=?', input.hash, input.key).toArray().length > 0;
            if (!existing) this.recipients.assertPolicy(input.policy);
            return { ok: true as const, value: await this.paid.create(input, now) };
          } catch (error) { return { ok: false as const, error }; }
        });
        if (!result.ok) throw result.error;
        return Response.json(result.value);
      }
      case 'paidGet': return Response.json(this.paid.get(data.hash,data.id,now));
      case 'paidByKey': return Response.json(this.paid.byKey(data.hash,data.key,now));
      case 'paidCancelByKey': return Response.json(await this.paid.cancelByKey(data.hash,data.key,now));
      case 'paidPrepare': return Response.json(await this.paid.prepare(data.hash,data.id,f.preparation as DurablePaymentPreparation,now));
      case 'paidReserve': return Response.json(await this.paid.reserve(data.hash,data.id,data.signature,String(f.preparationId),now,
        f.signedMessage === undefined ? undefined : String(f.signedMessage),f.signedTransaction === undefined ? undefined : String(f.signedTransaction)));
      case 'paidCancel': return Response.json(await this.paid.cancel(data.hash,data.id,f.preparationId===null?null:String(f.preparationId),now));
      case 'paidRecover': return Response.json(await recoverPaidOrder(this.paid,this.env,data.hash,data.id,String(f.preparationId)));
      case 'paidRepair': {
        const result=await this.paid.requestArchiveRepair(data.hash,data.id,now);
        if(result.queued)this.ctx.waitUntil(runPaidOrder(this.paid,this.env,data.id));
        return Response.json(result.snapshot);
      }
      case 'paidRun': {
        const snapshot=await this.paid.nudge(data.hash,data.id,now);
        this.ctx.waitUntil(runPaidOrder(this.paid,this.env,data.id));
        return Response.json(snapshot);
      }
      case 'fundSummary': return Response.json(this.fund.summary(now));
      case 'fundAvailable': return Response.json(this.fund.available(String(f.balance)));
      case 'fundSettings': return Response.json(this.fund.settings());
      case 'fundClaim': return Response.json(await this.fund.claim(String(f.orderId),String(f.lease),now));
      case 'fundFinish': await this.fund.finish(String(f.orderId),String(f.lease),typeof f.reason==='string'?f.reason:null,now); return Response.json(null);
      case 'fundOrder': return Response.json(this.fund.order(String(f.orderId),true));
      case 'fundRate': await this.fund.rate(String(f.bucket),Number(f.limit),now); return Response.json(null);
      case 'fundPromo': return Response.json(await this.fund.promo(String(f.hash),String(f.hint),now));
      case 'fundEnable': return Response.json(await this.fund.enable(f.enabled===true,now));
      case 'fundLimit': return Response.json(await this.fund.limit(String(f.value),now));
      case 'fundReserve': return Response.json(await this.fund.reserve(f.input as Parameters<FundLedger['reserve']>[0],now));
      case 'fundEvent': return Response.json(await this.fund.event(f.input as Parameters<FundLedger['event']>[0],now));
      case 'fundReconciled': return Response.json(await this.fund.reconciled(now));
      case 'apiClaim': return Response.json(await this.api.claim(data.hash, data.id, data.plan, now));
      case 'apiFinish': return Response.json(await this.api.finish(data.hash, data.id, data.accepted, data.retrieved, now));
      case 'apiRate': await this.api.rate(data.buckets, data.limit, now); return Response.json(null);
      case 'apiIssue': await this.api.issue(data.hash, data.expiresAt); return Response.json(null);
      case 'apiAuth': this.api.authenticate(data.hash, now); return Response.json(null);
      case 'apiResumeAuth': this.api.authenticateResume(data.hash,typeof f.id==='string'?f.id:undefined,typeof f.key==='string'?f.key:undefined,now);return Response.json(null);
      case 'apiCancelAuth': this.api.authenticateCancellation(data.hash);return Response.json(null);
      case 'apiExisting': return Response.json(await this.api.existing(data.hash, data.key, data.intent, now));
      case 'apiCreate': return Response.json(await this.api.create(data.hash, data.key, data.intent, data.order, now));
      case 'apiGet': {
        const record=await this.store.get(data.id);
        return Response.json(record?.order.schema==='sejire/order/v2'?this.paid.get(data.hash,data.id,now):await this.api.get(data.hash,data.id,now));
      }
      case 'apiBegin': return Response.json(await this.api.begin(data.hash, data.id, data.signature, now));
      case 'apiCommit': return Response.json(await this.api.commit(data.hash, data.payment, now));
      case 'apiResult': await this.api.result(data.hash, data.id, data.result, now); return Response.json(null);
      case 'create': await this.store.create(data.order); return Response.json(null);
      case 'get': return Response.json(await this.store.get(data.id));
      case 'begin': return Response.json(await this.store.beginReconciliation(data.id, data.signature));
      case 'commit': return Response.json(await this.store.commitPayment(data.payment));
      case 'totals': return Response.json(await this.store.totals());
      default: return new Response('unknown_ledger_action', { status: 400 });
    }
    } catch (error) {
      const known = ['invalid_admin_query','invalid_topup_request','treasury_revision_conflict','topup_idempotency_conflict','topup_not_found','topup_transfer_invalid','topup_transfer_conflict','topup_transfer_unresolved','topup_already_credited','topup_transaction_used','topup_intent_mismatch','topup_legacy_intent_requires_review','topup_transaction_mismatch','topup_not_confirmed','topup_precedes_intent','topup_proof_unavailable','order_or_reference_exists', 'order_not_found', 'previous_payment_unresolved', 'order_already_paid',
        'invalid_solana_recipient','solana_recipient_roles_overlap','solana_test_recipient_forbidden','invalid_solana_recipient_settings','solana_recipient_revision_conflict','payment_settings_changed',
        'payment_conflict', 'payment_not_reserved', 'credit_allocation_mismatch', 'payment_already_used',
        'paid_budget_exhausted','balance_observation_stale','paid_hold_not_releasable','paid_request_cancelled','repair_not_available','invalid_idempotency_key','order_expired','payment_not_prepared','preparation_changed',
        'invalid_payment_signature','invalid_payment_preparation','payment_preparation_mismatch','invalid_signed_payment','payment_not_expired','payment_recovery_busy','payment_recovery_unavailable','invalid_paid_archive','archive_mismatch','archive_not_canonical','invalid_envelope','envelope_too_large',
        'fund_lease_lost','promo_invalid','promo_disabled','promo_missing','fund_exhausted','archive_changed','limit_below_spent','limit_below_reserved','fund_ledger_inconsistent','wallet_low','invalid_ar_amount','invalid_winston','invalid_reward','invalid_signed_tx','tx_conflict','invalid_actual_reward','signed_tx_must_reconcile','order_not_found','unauthorized', 'idempotency_conflict', 'rate_limited', 'preservation_not_paid', 'execution_not_reserved', 'upload_receipt_mismatch'];
      const code = error instanceof Error && known.includes(error.message) ? error.message : 'ledger_operation_failed';
      return Response.json({ error: code }, { status: 409 });
    }
  }
}
/** Server adapter fixes the object name globally, never chooses it from order/request input. */
export class DurableOrderStore implements AtomicOrderStore {
  private readonly stub: DurableObjectStub;
  constructor(namespace: DurableObjectNamespace) { this.stub = namespace.get(namespace.idFromName(LEDGER_OBJECT_NAME)); }
  async call<T>(payload: unknown): Promise<T> {
    const response = await this.stub.fetch('https://checkout-ledger.internal/', { method: 'POST', body: JSON.stringify(payload) });
    if (!response.ok) {
      const error = await response.json() as { error?: string };
      throw new Error(error.error ?? 'ledger_service_unavailable');
    }
    return await response.json() as T;
  }
  async create(order: Order): Promise<void> { await this.call({ action: 'create', order }); }
  get(id: string): Promise<StoredOrder | null> { return this.call({ action: 'get', id }); }
  beginReconciliation(id: string, signature: string): Promise<StoredOrder> { return this.call({ action: 'begin', id, signature }); }
  commitPayment(payment: ValidatedPayment): Promise<CommitResult> { return this.call({ action: 'commit', payment }); }
}
