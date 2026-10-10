import { assertBase58, assertOrder, type Order } from '../../../../packages/checkout/order';
import type { OrderStates } from '../../../../packages/checkout/states';
import type { ValidatedPayment } from './paymentValidator';
export type StoredOrder = Readonly<{ order: Order; states: OrderStates; pendingSignature?: string; payment?: ValidatedPayment }>;
export type CommitResult = Readonly<{ status: 'credited' | 'already-credited'; record: StoredOrder }>;
/** Every method below is one ATOMIC durable transaction in a future persistent adapter.
 * beginReconciliation persists a signature BEFORE any RPC request. commitPayment must atomically
 * enforce unique order, chain/signature/instruction and append credits + states.
 * No implementation may copy the old KV get/upload/put pattern.
 */
export interface AtomicOrderStore {
  create(order: Order): Promise<void>;
  get(id: string): Promise<StoredOrder | null>;
  beginReconciliation(id: string, signature: string): Promise<StoredOrder>;
  commitPayment(payment: ValidatedPayment): Promise<CommitResult>;
}
function detached<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
/** TEST ONLY: operations have no await between read/check/write in a single JS isolate.
 * No disk, restart recovery, multi-isolate locking, WAL or production guarantees.
 */
export class MemoryAtomicOrderStore implements AtomicOrderStore {
  private records = new Map<string, StoredOrder>();
  private references = new Set<string>();
  private creditedInstructions = new Set<string>();
  private creditedTransactions = new Map<string, string>();
  async create(order: Order): Promise<void> {
    assertOrder(order);
    const referenceKey = `${order.network}:${order.reference}`;
    if (this.records.has(order.id) || this.references.has(referenceKey)) throw new Error('order_or_reference_exists');
    const copy = detached(order);
    this.records.set(order.id, { order: copy, states: { payment: 'awaiting-payment',
      preservation: order.kind === 'preservation' ? 'awaiting-payment' : 'not-applicable',
      contribution: order.fundContribution.amount !== '0' ? 'awaiting-payment' : 'not-requested' } });
    this.references.add(referenceKey);
  }
  async get(id: string): Promise<StoredOrder | null> { return detached(this.records.get(id) ?? null); }
  async beginReconciliation(id: string, signature: string): Promise<StoredOrder> {
    assertBase58(signature, 64);
    const record = this.records.get(id);
    if (!record) throw new Error('order_not_found');
    if (record.pendingSignature && record.pendingSignature !== signature) throw new Error('previous_payment_unresolved');
    if (record.payment) {
      if (record.payment.signature !== signature) throw new Error('order_already_paid');
      return detached(record);
    }
    const next: StoredOrder = { ...record, pendingSignature: signature, states: { ...record.states,
      payment: 'requires-reconciliation', contribution: record.states.contribution === 'not-requested' ? 'not-requested' : 'requires-reconciliation' } };
    this.records.set(id, next);
    return detached(next);
  }
  async commitPayment(payment: ValidatedPayment): Promise<CommitResult> {
    const record = this.records.get(payment.orderId);
    if (!record) throw new Error('order_not_found');
    if (record.payment) {
      if (JSON.stringify(record.payment) !== JSON.stringify(payment)) throw new Error('payment_conflict');
      return { status: 'already-credited', record: detached(record) };
    }
    if (payment.network !== record.order.network || payment.signature !== record.pendingSignature) throw new Error('payment_not_reserved');
    const transactionKey = `${payment.network}:${payment.signature}`;
    const keys = payment.credits.map(c => `${transactionKey}:${c.instruction}`);
    const expected = (['servicePayment', 'fundContribution'] as const).filter(p => record.order[p].amount !== '0');
    if (payment.credits.length !== expected.length || expected.some(p => {
      const matches = payment.credits.filter(c => c.purpose === p);
      return matches.length !== 1 || matches[0].amount !== record.order[p].amount || matches[0].recipient !== record.order[p].recipient;
    })) throw new Error('credit_allocation_mismatch');
    if (new Set(keys).size !== keys.length || keys.some(k => this.creditedInstructions.has(k)) || this.creditedTransactions.has(transactionKey)) throw new Error('payment_already_used');
    const next: StoredOrder = { ...record, payment: detached(payment), states: { payment: 'verified',
      preservation: record.order.kind === 'preservation' ? 'ready' : 'not-applicable',
      contribution: record.order.fundContribution.amount !== '0' ? 'received' : 'not-requested' } };
    // Atomic single-isolate section. No callback/RPC/upload/await inside.
    for (const key of keys) this.creditedInstructions.add(key);
    this.creditedTransactions.set(transactionKey, record.order.id);
    this.records.set(record.order.id, next);
    return { status: 'credited', record: detached(next) };
  }
}
