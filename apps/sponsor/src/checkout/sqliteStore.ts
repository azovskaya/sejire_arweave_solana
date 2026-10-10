import { assertBase58, assertOrder, type Order } from '../../../../packages/checkout/order';
import { assertUnits } from '../../../../packages/checkout/amounts';
import type { OrderStates } from '../../../../packages/checkout/states';
import type { ValidatedPayment } from './paymentValidator';
import type { AtomicOrderStore, StoredOrder, CommitResult } from './store';

type Row = { order_json: string; states_json: string; pending_signature: string | null; payment_json: string | null };
/** Actual Cloudflare SQLite API adapter. Constructor's optional checkpoint is ONLY a test fault
 * injection callback, never serialized, configured by a browser or installed by CheckoutLedger.
 * SQL transactions have no network call/await; sync waits for durability before resolving.
 */
export class SqliteAtomicOrderStore implements AtomicOrderStore {
  private readonly sql: SqlStorage;
  constructor(private readonly storage: DurableObjectStorage, private readonly beforeCommit?: () => void) {
    this.sql = storage.sql;
    storage.transactionSync(() => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);
        INSERT OR IGNORE INTO schema_version(version) VALUES(1);
        CREATE TABLE IF NOT EXISTS orders(
          id TEXT PRIMARY KEY, network TEXT NOT NULL, reference TEXT NOT NULL,
          order_json TEXT NOT NULL, states_json TEXT NOT NULL,
          pending_signature TEXT, payment_json TEXT,
          UNIQUE(network, reference));
        CREATE TABLE IF NOT EXISTS used_transactions(
          network TEXT NOT NULL, signature TEXT NOT NULL, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
          PRIMARY KEY(network, signature));
        CREATE TABLE IF NOT EXISTS credits(
          network TEXT NOT NULL, signature TEXT NOT NULL, instruction TEXT NOT NULL,
          order_id TEXT NOT NULL REFERENCES orders(id), purpose TEXT NOT NULL,
          symbol TEXT NOT NULL, mint TEXT NOT NULL, recipient TEXT NOT NULL,
          amount TEXT NOT NULL CHECK(typeof(amount)='text'),
          PRIMARY KEY(network, signature, instruction), UNIQUE(order_id, purpose));`);
      const versions = this.sql.exec<{ version: number }>('SELECT version FROM schema_version').toArray();
      if (versions.length !== 1 || versions[0].version !== 1) throw new Error('unsupported_ledger_schema');
    });
  }
  private read(id: string): StoredOrder | null {
    const row = this.sql.exec<Row>('SELECT order_json,states_json,pending_signature,payment_json FROM orders WHERE id=?', id).toArray()[0];
    if (!row) return null;
    const order: Order = JSON.parse(row.order_json); assertOrder(order);
    return { order, states: JSON.parse(row.states_json),
      ...(row.pending_signature ? { pendingSignature: row.pending_signature } : {}),
      ...(row.payment_json ? { payment: JSON.parse(row.payment_json) } : {}) };
  }
  async get(id: string): Promise<StoredOrder | null> { return this.read(id); }
  async create(order: Order): Promise<void> { await this.createLinked(order); }
  /** Trusted metadata hook shares the order INSERT transaction; never supplied over HTTP. */
  async createLinked(order: Order, link?: () => void): Promise<void> {
    assertOrder(order);
    this.storage.transactionSync(() => {
      if (this.sql.exec('SELECT id FROM orders WHERE id=? OR (network=? AND reference=?)', order.id, order.network, order.reference).toArray().length) throw new Error('order_or_reference_exists');
      const states: OrderStates = { payment: 'awaiting-payment', preservation: order.kind === 'preservation' ? 'awaiting-payment' : 'not-applicable',
        contribution: order.fundContribution.amount === '0' ? 'not-requested' : 'awaiting-payment' };
      this.sql.exec('INSERT INTO orders(id,network,reference,order_json,states_json) VALUES(?,?,?,?,?)', order.id, order.network, order.reference, JSON.stringify(order), JSON.stringify(states));
      link?.();
    });
    await this.storage.sync();
  }
  async beginReconciliation(id: string, signature: string): Promise<StoredOrder> {
    assertBase58(signature, 64);
    const record = this.storage.transactionSync(() => {
      const saved = this.read(id); if (!saved) throw new Error('order_not_found');
      if (saved.pendingSignature && saved.pendingSignature !== signature) throw new Error('previous_payment_unresolved');
      if (saved.payment) {
        if (saved.payment.signature !== signature) throw new Error('order_already_paid');
        return saved;
      }
      const states: OrderStates = { ...saved.states, payment: 'requires-reconciliation',
        contribution: saved.states.contribution === 'not-requested' ? 'not-requested' : 'requires-reconciliation' };
      this.sql.exec('UPDATE orders SET pending_signature=?,states_json=? WHERE id=?', signature, JSON.stringify(states), id);
      return { ...saved, pendingSignature: signature, states };
    });
    await this.storage.sync();
    return record;
  }
  async commitPayment(payment: ValidatedPayment): Promise<CommitResult> {
    const result = this.storage.transactionSync<CommitResult>(() => {
      const saved = this.read(payment.orderId); if (!saved) throw new Error('order_not_found');
      if (saved.payment) {
        if (JSON.stringify(saved.payment) !== JSON.stringify(payment)) throw new Error('payment_conflict');
        return { status: 'already-credited', record: saved };
      }
      assertBase58(payment.signature, 64); assertUnits(payment.feeLamports);
      if (!Number.isSafeInteger(payment.slot) || payment.slot < 0 || payment.network !== saved.order.network || payment.signature !== saved.pendingSignature) throw new Error('payment_not_reserved');
      const expected = (['servicePayment', 'fundContribution'] as const).filter(p => saved.order[p].amount !== '0');
      if (payment.credits.length !== expected.length || expected.some(p => {
        const matches = payment.credits.filter(c => c.purpose === p);
        return matches.length !== 1 || matches[0].amount !== saved.order[p].amount || matches[0].recipient !== saved.order[p].recipient;
      }) || payment.credits.some(c => !/^(0|[1-9]\d{0,5})(?:\/(0|[1-9]\d{0,5}))?$/.test(c.instruction))) throw new Error('credit_allocation_mismatch');
      if (new Set(payment.credits.map(c => c.instruction)).size !== payment.credits.length ||
        this.sql.exec('SELECT order_id FROM used_transactions WHERE network=? AND signature=?', payment.network, payment.signature).toArray().length) throw new Error('payment_already_used');
      this.sql.exec('INSERT INTO used_transactions(network,signature,order_id) VALUES(?,?,?)', payment.network, payment.signature, payment.orderId);
      for (const c of payment.credits) {
        assertUnits(c.amount);
        this.sql.exec('INSERT INTO credits(network,signature,instruction,order_id,purpose,symbol,mint,recipient,amount) VALUES(?,?,?,?,?,?,?,?,?)',
          payment.network, payment.signature, c.instruction, payment.orderId, c.purpose, saved.order.asset.symbol, saved.order.asset.mint ?? '', c.recipient, c.amount);
      }
      this.beforeCommit?.(); // Throw here to prove SQL rollback after inserts, before state update.
      const states: OrderStates = { payment: 'verified', preservation: saved.order.kind === 'preservation' ? 'ready' : 'not-applicable',
        contribution: saved.order.fundContribution.amount === '0' ? 'not-requested' : 'received' };
      this.sql.exec('UPDATE orders SET payment_json=?,states_json=? WHERE id=?', JSON.stringify(payment), JSON.stringify(states), payment.orderId);
      return { status: 'credited', record: { ...saved, payment, states } };
    });
    await this.storage.sync();
    return result;
  }
  /** Internal accounting diagnostic. No SQL SUM or float; cumulative totals may exceed u64. */
  async totals(): Promise<Record<string, string>> {
    const totals: Record<string, bigint> = {};
    for (const row of this.sql.exec<{ network: string; symbol: string; mint: string; purpose: string; amount: string }>('SELECT network,symbol,mint,purpose,amount FROM credits')) {
      const key = `${row.network}:${row.symbol}:${row.mint}:${row.purpose}`;
      totals[key] = (totals[key] ?? 0n) + assertUnits(row.amount);
    }
    return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value.toString()]));
  }
}
