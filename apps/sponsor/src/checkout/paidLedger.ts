import { assertOrder, assertBase58, type PaidOrder } from '../../../../packages/checkout/order';
import { validatePaidOrderPolicy, validatePaymentPreparation, validatePaidReceipt, verifyPreparedPaymentSignature,
  type PaidPolicy, type CheckoutPolicy, type DurablePaymentPreparation, type PaidReceipt } from '../../../../packages/checkout/paid';
import { canonical } from '../../../../packages/protocol/wire';
import type { StoredOrder, CommitResult } from './store';
import type { ValidatedPayment } from './paymentValidator';
import type { PreparedDirectPlan, SignedDirectPlan, DirectCheck, DirectInput } from './directPreservation';
import { ApiLedger, type PaidRequestCancellation } from './apiLedger';
import { SqliteAtomicOrderStore } from './sqliteStore';
import { TreasuryGuard, winston } from './treasuryGuard';
import { TREASURY_ADDRESS } from '../fund/ledger';
import { checkedPaidArchive } from './paidPolicy';

type PaidRow = {order_id:string;policy_json:string;preparation_json:string|null;status:string;lease:string|null;lease_until:number;
  next_at:number;attempts:number;proof_json:string|null;receipt_json:string|null;paid:number;released:number;last_error:string|null;submission_ack:number};
export type PaidStoredOrder = StoredOrder & {order:PaidOrder};
export type PaidWork = {record:PaidStoredOrder;policy:CheckoutPolicy;input:DirectInput|null;prepared:PreparedDirectPlan|null;
  signed:SignedDirectPlan|null;preparation:DurablePaymentPreparation|null;status:string;submitAcknowledged:boolean};
const json = <T>(value:string|null):T|null => value===null?null:JSON.parse(value) as T;
/** v2 is additive: no legacy orders, ANS-104 plans or signed bytes are rewritten. */
export class PaidLedger {
  private readonly sql:SqlStorage;
  readonly treasury:TreasuryGuard;
  constructor(private readonly storage:DurableObjectStorage,private readonly orders:SqliteAtomicOrderStore,private readonly api:ApiLedger) {
    this.sql=storage.sql;
    storage.transactionSync(()=>{this.sql.exec(`
      CREATE TABLE IF NOT EXISTS paid_orders(order_id TEXT PRIMARY KEY REFERENCES orders(id),policy_json TEXT NOT NULL,
        preparation_json TEXT,status TEXT NOT NULL,lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,proof_json TEXT,receipt_json TEXT,
        paid INTEGER NOT NULL DEFAULT 0,released INTEGER NOT NULL DEFAULT 0,last_error TEXT,submission_ack INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS paid_payloads(order_id TEXT NOT NULL REFERENCES paid_orders(order_id),kind TEXT NOT NULL,
        payload TEXT NOT NULL,PRIMARY KEY(order_id,kind));
      CREATE TABLE IF NOT EXISTS paid_payment_recoveries(order_id TEXT NOT NULL REFERENCES paid_orders(order_id),
        previous_preparation_id TEXT NOT NULL,previous_preparation_json TEXT NOT NULL,preparation_json TEXT NOT NULL,
        finalized_block_height INTEGER NOT NULL,recovered_at INTEGER NOT NULL,PRIMARY KEY(order_id,previous_preparation_id));`);
      if(!this.sql.exec<{name:string}>('PRAGMA table_info(paid_orders)').toArray().some(c=>c.name==='submission_ack'))
        this.sql.exec('ALTER TABLE paid_orders ADD COLUMN submission_ack INTEGER NOT NULL DEFAULT 0');
    });
    this.treasury=new TreasuryGuard(storage);
  }
  private row(id:string):PaidRow {
    const row=this.sql.exec<PaidRow>('SELECT * FROM paid_orders WHERE order_id=?',id).toArray()[0];
    if(!row)throw Error('order_not_found');return row;
  }
  private record(id:string):PaidStoredOrder {
    const r=this.sql.exec<{order_json:string;states_json:string;pending_signature:string|null;payment_json:string|null}>(
      'SELECT order_json,states_json,pending_signature,payment_json FROM orders WHERE id=?',id).toArray()[0];
    if(!r)throw Error('order_not_found');const order=JSON.parse(r.order_json);assertOrder(order);
    if(order.schema!=='sejire/order/v2')throw Error('not_paid_v2_order');
    return {order,states:JSON.parse(r.states_json),...(r.pending_signature?{pendingSignature:r.pending_signature}:{}),...(r.payment_json?{payment:JSON.parse(r.payment_json)}:{})};
  }
  private payload(id:string,kind:string):string|null {
    return this.sql.exec<{payload:string}>('SELECT payload FROM paid_payloads WHERE order_id=? AND kind=?',id,kind).toArray()[0]?.payload??null;
  }
  private putPayload(id:string,kind:string,value:string):void {
    // Each encrypted/prepared/signed value gets a separate bounded SQLite row.
    if(new TextEncoder().encode(value).length>1500000)throw Error('paid_payload_too_large');
    this.sql.exec('INSERT INTO paid_payloads(order_id,kind,payload) VALUES(?,?,?)',id,kind,value);
  }
  snapshot(id:string) {
    const row=this.row(id),record=this.record(id),signed=json<SignedDirectPlan>(this.payload(id,'signed'));
    const proof=json<DirectCheck>(row.proof_json),receipt=json<PaidReceipt>(row.receipt_json);
    return {record,policy:JSON.parse(row.policy_json) as CheckoutPolicy,preparation:json<DurablePaymentPreparation>(row.preparation_json),
      verification:record.payment?{status:'verified'}:row.preparation_json&&!row.released?{status:'requires-reconciliation',reason:row.last_error??'not-found'}:null,
      expired:row.released===1,cancelled:row.status==='cancelled',
      execution:row.paid&&record.order.kind==='preservation'?{kind:'arweave-direct' as const,txId:signed?.id??null,status:row.status,
        verification:proof?.rewardWinston&&signed&&proof.rewardWinston===signed.rewardWinston?{transactionConfirmed:proof.onchainConfirmed,archiveVerified:proof.archiveVerified,
          owner:record.order.storage.treasuryAddress,rewardWinston:proof.rewardWinston,archive:record.order.archive}:null,
        ...(row.last_error?{reason:row.last_error}:{}),
        ...(receipt?{receipt}:{})}:null};
  }
  get(hash:string,id:string,_now:number){this.api.ownerPaid(hash,id);return this.snapshot(id);}
  byKey(hash:string,key:string,_now:number){
    const cancelled=this.api.requestCancellation(hash,key);
    if(cancelled)return cancelled;
    return this.snapshot(this.api.paidIdByKey(hash,key));
  }
  async cancelByKey(hash:string,key:string,_now:number):Promise<ReturnType<PaidLedger['snapshot']>|PaidRequestCancellation>{
    this.api.authenticateCancellation(hash);
    if(!/^[A-Za-z0-9_-]{16,128}$/.test(key))throw Error('invalid_idempotency_key');
    const result=this.storage.transactionSync(()=>{
      const existing=this.sql.exec<{order_id:string}>('SELECT order_id FROM api_orders WHERE owner=? AND idem_key=?',hash,key).toArray()[0];
      if(existing){
        // A request that was admitted before cancellation keeps its real state.
        // In particular, an unseen preparation must never be silently cancelled.
        if(!this.sql.exec('SELECT order_id FROM paid_orders WHERE order_id=?',existing.order_id).toArray().length)throw Error('idempotency_conflict');
        return this.snapshot(existing.order_id);
      }
      this.sql.exec('INSERT OR IGNORE INTO paid_cancelled_keys(owner,key) VALUES(?,?)',hash,key);
      return {schema:'sejire/paid-request-cancellation/v1' as const,status:'cancelled' as const,key};
    });
    await this.storage.sync();return result;
  }
  hasOrders():boolean{return this.sql.exec('SELECT order_id FROM paid_orders LIMIT 1').toArray().length>0;}
  async create(input:{hash:string;key:string;intent:string;order:PaidOrder;policy:CheckoutPolicy;serialized?:string;
    prepared?:PreparedDirectPlan;budgetLimit?:string;balance?:string;balanceRevision?:number},now:number){
    this.api.authenticate(input.hash,now);
    await validatePaidOrderPolicy(input.order,input.policy);
    const storage=input.policy.schema==='sejire/checkout-policy/v1'?input.policy.storage:undefined;
    if(input.order.kind==='preservation'){
      if(!input.serialized||!input.prepared||!storage)throw Error('paid_payload_missing');
      await checkedPaidArchive(input.serialized,input.order.archive,storage.maxBytes);
    }else if([input.serialized,input.prepared,input.budgetLimit,input.balance,input.balanceRevision].some(value=>value!==undefined)){
      throw Error('invalid_contribution_order');
    }
    // No await between this duplicate check and createLinked's transaction.
    const prior=this.sql.exec<{order_id:string;intent:string}>('SELECT order_id,intent FROM api_orders WHERE owner=? AND idem_key=?',input.hash,input.key).toArray()[0];
    if(prior){if(prior.intent!==input.intent)throw Error('idempotency_conflict');return {reused:true,...this.snapshot(prior.order_id)};}
    const p=input.prepared,o=input.order;
    if(o.expiresAt<=now)throw Error('order_expired');
    if(o.kind==='preservation'&&(!p||p.orderId!==o.id||canonical(p.archive)!==canonical(o.archive)||p.network!==o.storage.network||
      p.treasuryAddress!==o.storage.treasuryAddress||winston(p.rewardWinston)<=0n||!storage||winston(p.rewardWinston)>winston(storage.maxRewardWinston)))throw Error('prepared_archive_mismatch');
    await this.orders.createLinked(o,()=>{
      this.api.assertRequestActive(input.hash,input.key);
      if(o.kind==='preservation')this.treasury.reservePaid({orderId:o.id,budgetId:storage!.budgetId,treasury:o.storage.treasuryAddress,promoTreasury:TREASURY_ADDRESS,
        reward:storage!.maxRewardWinston,budgetLimit:input.budgetLimit!,balance:input.balance!,balanceRevision:input.balanceRevision!});
      this.sql.exec('INSERT INTO api_orders(order_id,owner,idem_key,intent) VALUES(?,?,?,?)',o.id,input.hash,input.key,input.intent);
      this.sql.exec('INSERT INTO paid_orders(order_id,policy_json,status,next_at) VALUES(?,?,?,?)',o.id,JSON.stringify(input.policy),'offered',o.expiresAt);
      if(o.kind==='preservation'){this.putPayload(o.id,'archive',input.serialized!);this.putPayload(o.id,'prepared',JSON.stringify(p));}
    });
    await this.arm();return {reused:false,...this.snapshot(o.id)};
  }
  async prepare(hash:string,id:string,candidate:DurablePaymentPreparation,now:number){
    this.api.ownerPaid(hash,id);const record=this.record(id);await validatePaymentPreparation(record.order,candidate);
    const result=this.storage.transactionSync(()=>{
      const row=this.row(id),current=this.record(id);
      if(row.released)throw Error('order_expired');
      if(row.preparation_json)return JSON.parse(row.preparation_json) as DurablePaymentPreparation;
      if(current.payment||current.pendingSignature)throw Error('previous_payment_unresolved');
      if(current.order.expiresAt<=now)throw Error('order_expired');
      this.sql.exec('UPDATE paid_orders SET preparation_json=?,status=?,next_at=? WHERE order_id=?',JSON.stringify(candidate),'pending-payment',now+15000,id);
      return candidate;
    });await this.storage.sync();await this.arm();return result;
  }
  async reserve(hash:string,id:string,signature:string,preparationId:string,now:number){
    this.api.ownerPaid(hash,id);return this.reserveInternal(id,signature,preparationId,now);
  }
  /** An explicit recovery only fences a preparation that this ledger never
   * authorized for broadcast. Existing V2 clients reserve before sending. */
  async claimPaymentRecovery(hash:string,id:string,preparationId:string,lease:string,now:number):Promise<
    {reused:true;work:null}|{reused:false;work:PaidWork}> {
    this.api.ownerPaid(hash,id);
    if(!/^[a-f0-9]{64}$/.test(preparationId))throw Error('invalid_payment_preparation');
    const reused=this.storage.transactionSync(()=>{
      const row=this.row(id),record=this.record(id),current=json<DurablePaymentPreparation>(row.preparation_json);
      const prior=this.sql.exec<{preparation_json:string}>(
        'SELECT preparation_json FROM paid_payment_recoveries WHERE order_id=? AND previous_preparation_id=?',id,preparationId).toArray()[0];
      if(prior){
        const recovered=JSON.parse(prior.preparation_json) as DurablePaymentPreparation;
        if(current?.preparationId!==recovered.preparationId)throw Error('preparation_changed');
        return true;
      }
      if(!current||current.preparationId!==preparationId)throw Error('preparation_changed');
      if(row.released)throw Error('order_expired');
      if(record.pendingSignature||record.payment||row.paid||this.payload(id,'signed'))throw Error('previous_payment_unresolved');
      if(row.lease_until>now)throw Error('payment_recovery_busy');
      this.sql.exec('UPDATE paid_orders SET lease=?,lease_until=? WHERE order_id=?',lease,now+120000,id);
      return false;
    });
    await this.storage.sync();
    return reused?{reused:true,work:null}:{reused:false,work:this.work(id)};
  }
  async finishPaymentRecovery(id:string,lease:string,previousPreparationId:string,candidate:DurablePaymentPreparation,finalizedBlockHeight:number,now:number){
    const record=this.record(id);
    await validatePaymentPreparation(record.order,candidate);
    if(candidate.schema!=='sejire/payment-preparation/v2'||candidate.previousPreparationId!==previousPreparationId||
        candidate.createdAt>now||candidate.expiresAt<=now)throw Error('invalid_payment_preparation');
    this.storage.transactionSync(()=>{
      const row=this.leased(id,lease),current=this.record(id),previous=json<DurablePaymentPreparation>(row.preparation_json);
      if(row.lease_until<=now)throw Error('payment_recovery_busy');
      if(row.released||current.pendingSignature||current.payment||row.paid||this.payload(id,'signed'))throw Error('previous_payment_unresolved');
      if(!previous||previous.preparationId!==previousPreparationId)throw Error('preparation_changed');
      if(!Number.isSafeInteger(finalizedBlockHeight)||finalizedBlockHeight<=previous.lastValidBlockHeight)throw Error('payment_not_expired');
      if(candidate.lastValidBlockHeight<=finalizedBlockHeight)throw Error('payment_recovery_unavailable');
      if(candidate.createdAt<previous.createdAt)throw Error('invalid_payment_preparation');
      // This transaction and reserveInternal's preparation check share SQLite's
      // writer: either a durable reservation wins, or all late old reserves fail.
      this.sql.exec('INSERT INTO paid_payment_recoveries(order_id,previous_preparation_id,previous_preparation_json,preparation_json,finalized_block_height,recovered_at) VALUES(?,?,?,?,?,?)',
        id,previousPreparationId,JSON.stringify(previous),JSON.stringify(candidate),finalizedBlockHeight,now);
      this.sql.exec('UPDATE paid_orders SET preparation_json=?,status=?,next_at=?,attempts=0,last_error=NULL,lease=NULL,lease_until=0 WHERE order_id=?',
        JSON.stringify(candidate),'pending-payment',now+15000,id);
    });
    await this.storage.sync();await this.arm();return this.snapshot(id);
  }
  async reserveInternal(id:string,signature:string,preparationId:string,now:number){
    assertBase58(signature,64);const row=this.row(id),record=this.record(id),p=json<DurablePaymentPreparation>(row.preparation_json);
    if(!p||p.preparationId!==preparationId||row.released)throw Error('payment_not_prepared');
    await verifyPreparedPaymentSignature(record.order,p,signature);
    // A stored preparation already locked this hold before any wallet interaction.
    // Expiry cannot make an unknown signed payment safe to replace or release.
    const result=await this.orders.beginReconciliationLinked(id,signature,()=>{
      const current=this.row(id),prepared=json<DurablePaymentPreparation>(current.preparation_json);
      if(current.released||!prepared||prepared.preparationId!==preparationId)throw Error('payment_not_prepared');
      if(!current.paid)this.sql.exec('UPDATE paid_orders SET next_at=? WHERE order_id=?',now,id);
    });
    await this.storage.sync();await this.arm();return result;
  }
  async cancel(hash:string,id:string,preparationId:string|null,now:number){
    this.api.ownerPaid(hash,id);
    this.storage.transactionSync(()=>{
      const row=this.row(id),record=this.record(id),prep=json<DurablePaymentPreparation>(row.preparation_json);
      if((prep?.preparationId??null)!==preparationId)throw Error('preparation_changed');
      if(row.status==='cancelled')return;
      if(row.released)throw Error('order_expired');
      if(record.pendingSignature||record.payment||row.paid||this.payload(id,'signed'))throw Error('previous_payment_unresolved');
      // The client calls this only before opening the wallet or after an explicit
      // rejection. It never broadcasts until a durable signature reserve succeeds.
      if(record.order.kind==='preservation')this.treasury.releaseUnpaid(id);
      this.sql.exec('UPDATE paid_orders SET released=1,status=?,lease=NULL,lease_until=0,last_error=NULL WHERE order_id=?','cancelled',id);
    });
    await this.storage.sync();await this.arm();return this.snapshot(id);
  }
  async commit(id:string,payment:ValidatedPayment,now:number):Promise<CommitResult>{
    const row=this.row(id);if(row.released||!row.preparation_json||payment.orderId!==id)throw Error('payment_not_prepared');
    const result=await this.orders.commitPaymentLinked(payment,()=>{
      const current=this.row(id);if(current.released||!current.preparation_json)throw Error('payment_not_prepared');
      this.sql.exec('UPDATE paid_orders SET paid=1,status=?,next_at=?,last_error=NULL WHERE order_id=?',this.record(id).order.kind==='contribution'?'completed':'queued',now,id);
    });
    await this.arm();return result;
  }
  work(id:string):PaidWork{
    const row=this.row(id),record=this.record(id),serialized=this.payload(id,'archive'),prepared=this.payload(id,'prepared');
    if(record.order.kind==='preservation'&&(serialized===null||prepared===null))throw Error('paid_payload_missing');
    return {record,policy:JSON.parse(row.policy_json),input:record.order.kind==='preservation'?{orderId:id,serialized:serialized!,archive:record.order.archive}:null,
      prepared:prepared?JSON.parse(prepared):null,
      signed:json<SignedDirectPlan>(this.payload(id,'signed')),preparation:json<DurablePaymentPreparation>(row.preparation_json),status:row.status,submitAcknowledged:row.submission_ack===1};
  }
  async claim(id:string,lease:string,now:number):Promise<PaidWork|null>{
    const acquired=this.storage.transactionSync(()=>{
      const row=this.row(id),record=this.record(id);
      if(row.released||row.status==='completed'||row.lease_until>now)return false;
      if(!row.preparation_json&&!row.paid){
        if(record.order.expiresAt<=now){if(record.order.kind==='preservation')this.treasury.releaseUnpaid(id);this.sql.exec('UPDATE paid_orders SET released=1,status=? WHERE order_id=?','expired',id);}
        return false;
      }
      this.sql.exec('UPDATE paid_orders SET lease=?,lease_until=? WHERE order_id=?',lease,now+120000,id);return true;
    });await this.storage.sync();return acquired?this.work(id):null;
  }
  private leased(id:string,lease:string):PaidRow{
    const row=this.row(id);if(row.lease!==lease)throw Error('execution_lease_lost');return row;
  }
  async refreshPrepared(id:string,lease:string,candidate:PreparedDirectPlan):Promise<void>{
    this.storage.transactionSync(()=>{
      const row=this.leased(id,lease),record=this.record(id),policy=JSON.parse(row.policy_json) as PaidPolicy;
      if(record.order.kind!=='preservation')throw Error('preservation_not_applicable');
      if(!record.payment||this.payload(id,'signed'))throw Error('signed_tx_must_reconcile');
      if(candidate.orderId!==id||candidate.network!==record.order.storage.network||candidate.treasuryAddress!==record.order.storage.treasuryAddress||
        canonical(candidate.archive)!==canonical(record.order.archive)||winston(candidate.rewardWinston)<=0n||winston(candidate.rewardWinston)>winston(policy.storage.maxRewardWinston))throw Error('prepared_archive_mismatch');
      this.sql.exec('UPDATE paid_payloads SET payload=? WHERE order_id=? AND kind=?',JSON.stringify(candidate),id,'prepared');
    });await this.storage.sync();
  }
  async signed(id:string,lease:string,candidate:SignedDirectPlan):Promise<SignedDirectPlan>{
    const result=this.storage.transactionSync(()=>{
      this.leased(id,lease);const record=this.record(id),existing=this.payload(id,'signed');
      if(record.order.kind!=='preservation')throw Error('preservation_not_applicable');
      if(existing)return JSON.parse(existing) as SignedDirectPlan;
      const prepared=json<PreparedDirectPlan>(this.payload(id,'prepared'));
      if(!record.payment||!prepared||candidate.orderId!==id||candidate.rewardWinston!==prepared.rewardWinston||
        canonical(candidate.archive)!==canonical(record.order.archive)||candidate.treasuryAddress!==record.order.storage.treasuryAddress||candidate.network!==record.order.storage.network||
        !/^[A-Za-z0-9_-]{43}$/.test(candidate.id))throw Error('signed_archive_mismatch');
      this.putPayload(id,'signed',JSON.stringify(candidate));this.sql.exec('UPDATE paid_orders SET status=? WHERE order_id=?','signed',id);return candidate;
    });await this.storage.sync();return result;
  }
  async submitted(id:string,lease:string):Promise<void>{
    this.leased(id,lease);if(!this.payload(id,'signed'))throw Error('signed_tx_not_persisted');
    this.sql.exec('UPDATE paid_orders SET status=?,submission_ack=1 WHERE order_id=?','submitted',id);await this.storage.sync();
  }
  async proof(id:string,lease:string,proof:DirectCheck,now:number):Promise<void>{
    this.storage.transactionSync(()=>{
      const row=this.leased(id,lease),record=this.record(id),signed=json<SignedDirectPlan>(this.payload(id,'signed'));
      if(record.order.kind!=='preservation')throw Error('preservation_not_applicable');
      if(!record.payment||!signed||proof.txId!==signed.id||proof.archiveVerified&&!proof.onchainConfirmed||
        proof.onchainConfirmed&&proof.rewardWinston!==signed.rewardWinston)throw Error('storage_proof_mismatch');
      const old=json<DirectCheck>(row.proof_json);
      // A later unavailable read must not undo an already confirmed chain spend.
      const accepted=old?.onchainConfirmed&&!proof.onchainConfirmed?old:proof;
      if(accepted.onchainConfirmed)this.treasury.confirmPaid(id,signed.rewardWinston);
      let receipt:PaidReceipt|null=null;
      if(accepted.archiveVerified&&accepted.onchainConfirmed)receipt=validatePaidReceipt({schema:'sejire/preservation-receipt/v2',status:'confirmed-and-verified',
        orderId:id,policyHash:record.order.policyHash,paymentNetwork:record.order.network,paymentSignature:record.payment.signature,
        arweaveNetwork:record.order.storage.network,txId:signed.id,archive:record.order.archive,treasuryAddress:record.order.storage.treasuryAddress,
        rewardWinston:signed.rewardWinston,verifiedAt:now},record.order);
      this.sql.exec('UPDATE paid_orders SET proof_json=?,receipt_json=?,status=? WHERE order_id=?',JSON.stringify(accepted),receipt?JSON.stringify(receipt):row.receipt_json,
        receipt?'completed':accepted.onchainConfirmed?'confirming':'requires-reconciliation',id);
      this.sql.exec('UPDATE orders SET states_json=? WHERE id=?',JSON.stringify({...record.states,preservation:receipt?'completed':'requires-reconciliation'}),id);
    });await this.storage.sync();
  }
  async releaseLease(id:string,lease:string,reason:string|null,now:number):Promise<void>{
    this.storage.transactionSync(()=>{
      const row=this.row(id);if(row.lease!==lease)return;
      const delay=Math.min(300000,15000*Math.pow(2,Math.min(row.attempts,5)));
      const safeReason=reason&&/^[a-z][a-z0-9_-]{0,63}$/.test(reason)?reason:reason?'requires-reconciliation':null;
      const status=row.paid&&safeReason&&row.status!=='completed'&&row.status!=='confirming'?'requires-reconciliation':row.status;
      this.sql.exec('UPDATE paid_orders SET lease=NULL,lease_until=0,next_at=?,attempts=attempts+1,last_error=?,status=? WHERE order_id=?',now+delay,safeReason,status,id);
    });await this.storage.sync();await this.arm();
  }
  async nudge(hash:string,id:string,now:number){
    this.api.ownerPaid(hash,id);this.row(id);
    this.sql.exec('UPDATE paid_orders SET next_at=? WHERE order_id=? AND released=0 AND status<>?',now,id,'completed');
    await this.storage.sync();await this.arm();return this.snapshot(id);
  }
  due(now:number,limit=5):string[]{
    return this.sql.exec<{order_id:string}>('SELECT order_id FROM paid_orders WHERE released=0 AND status<>? AND next_at<=? AND lease_until<=? ORDER BY next_at LIMIT ?',
      'completed',now,now,limit).toArray().map(r=>r.order_id);
  }
  async arm():Promise<void>{
    const rows=this.sql.exec<{next_at:number;lease_until:number}>('SELECT next_at,lease_until FROM paid_orders WHERE released=0 AND status<>?','completed').toArray();
    if(!rows.length){if(this.storage.deleteAlarm)await this.storage.deleteAlarm();return;}
    const next=Math.max(Date.now()+1000,Math.min(...rows.map(r=>Math.max(r.next_at,r.lease_until))));
    // No token/session is needed by the alarm; its obligation survives browser close.
    if(this.storage.setAlarm)await this.storage.setAlarm(next);
  }
}
