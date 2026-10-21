import type { Order } from '../../../../packages/checkout/order';
import type { ValidatedPayment } from './paymentValidator';
import type { AtomicOrderStore, StoredOrder, CommitResult } from './store';
import { SqliteAtomicOrderStore } from './sqliteStore';
import { ApiLedger } from './apiLedger';
import type { UploadPlan, UploadAcceptance } from './preservation';
import { FundLedger, TREASURY_ADDRESS } from '../fund/ledger';
import { PaidLedger } from './paidLedger';
import { runPaidOrder } from './paidRunner';
import type { PaidEnv } from './paidPolicy';
import type { DurablePaymentPreparation } from '../../../../packages/checkout/paid';

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
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    if (!ctx.id.equals(env.CHECKOUT_LEDGER.idFromName(LEDGER_OBJECT_NAME))) throw new Error('wrong_ledger_object');
    this.store = new SqliteAtomicOrderStore(ctx.storage);
    this.api = new ApiLedger(ctx.storage, this.store);
    this.fund = new FundLedger(ctx.storage);
    this.paid = new PaidLedger(ctx.storage,this.store,this.api);
    // Re-arm durable obligations after an isolate restart, without a browser token.
    ctx.blockConcurrencyWhile(()=>this.paid.arm());
  }
  async alarm():Promise<void>{
    try{for(const id of this.paid.due(Date.now(),3))await runPaidOrder(this.paid,this.env,id);}
    finally{await this.paid.arm();}
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
    try {
    const data = await request.json() as { action: string; order: Order; id: string; signature: string; payment: ValidatedPayment; hash: string; key: string; intent: string; expiresAt: number; buckets: string[]; limit: number; result: { status: string; reason?: string }; plan?: UploadPlan; accepted?: UploadAcceptance; retrieved: boolean };
    const now = Date.now();
    const f=data as unknown as Record<string,unknown>;
    // Only trusted Worker service code has this binding. No browser input may invoke create/commit.
    switch (data.action) {
      case 'treasuryRevision': return Response.json(this.fund.treasury.revision(String(f.address)));
      case 'treasuryHeld': return Response.json(this.fund.treasury.held(String(f.address),TREASURY_ADDRESS));
      case 'treasuryEffectiveBalance': return Response.json(this.fund.treasury.effectiveBalance(String(f.address),String(f.balance)));
      case 'paidTotals': return Response.json(this.fund.treasury.paidTotals(typeof f.budgetId==='string'?f.budgetId:undefined));
      case 'paidHasOrders': return Response.json(this.paid.hasOrders());
      case 'paidCreate': return Response.json(await this.paid.create(f.input as Parameters<PaidLedger['create']>[0],now));
      case 'paidGet': return Response.json(this.paid.get(data.hash,data.id,now));
      case 'paidByKey': return Response.json(this.paid.byKey(data.hash,data.key,now));
      case 'paidCancelByKey': return Response.json(await this.paid.cancelByKey(data.hash,data.key,now));
      case 'paidPrepare': return Response.json(await this.paid.prepare(data.hash,data.id,f.preparation as DurablePaymentPreparation,now));
      case 'paidReserve': return Response.json(await this.paid.reserve(data.hash,data.id,data.signature,String(f.preparationId),now));
      case 'paidCancel': return Response.json(await this.paid.cancel(data.hash,data.id,f.preparationId===null?null:String(f.preparationId),now));
      case 'paidRun': {
        const snapshot=await this.paid.nudge(data.hash,data.id,now);
        this.ctx.waitUntil(runPaidOrder(this.paid,this.env,data.id));
        return Response.json(snapshot);
      }
      case 'fundSummary': return Response.json(this.fund.summary(now));
      case 'fundSettings': return Response.json(this.fund.settings());
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
      const known = ['order_or_reference_exists', 'order_not_found', 'previous_payment_unresolved', 'order_already_paid',
        'payment_conflict', 'payment_not_reserved', 'credit_allocation_mismatch', 'payment_already_used',
        'paid_budget_exhausted','balance_observation_stale','paid_hold_not_releasable','paid_request_cancelled','invalid_idempotency_key','order_expired','payment_not_prepared','preparation_changed',
        'invalid_payment_signature','invalid_payment_preparation','invalid_paid_archive','archive_mismatch','archive_not_canonical','invalid_envelope','envelope_too_large',
        'promo_invalid','promo_disabled','promo_missing','fund_exhausted','archive_changed','limit_below_spent','limit_below_reserved','fund_ledger_inconsistent','wallet_low','invalid_ar_amount','invalid_winston','invalid_reward','invalid_signed_tx','tx_conflict','invalid_actual_reward','signed_tx_must_reconcile','order_not_found','unauthorized', 'idempotency_conflict', 'rate_limited', 'preservation_not_paid', 'execution_not_reserved', 'upload_receipt_mismatch'];
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
