import type { Order } from '../../../../packages/checkout/order';
import type { ValidatedPayment } from './paymentValidator';
import { SqliteAtomicOrderStore } from './sqliteStore';
import type { UploadPlan, UploadAcceptance } from './preservation';

/** All ownership, idempotency and quotas live in the SAME global ledger SQLite.
 * No browser-controlled action, SQL, timestamp or quota reaches this service. */
export class ApiLedger {
  private readonly sql: SqlStorage;
  constructor(private readonly storage: DurableObjectStorage, private readonly orders: SqliteAtomicOrderStore) {
    this.sql = storage.sql;
    storage.transactionSync(() => this.sql.exec(`
      CREATE TABLE IF NOT EXISTS api_sessions(hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS api_orders(order_id TEXT PRIMARY KEY REFERENCES orders(id), owner TEXT NOT NULL REFERENCES api_sessions(hash),
        idem_key TEXT NOT NULL, intent TEXT NOT NULL, verification_json TEXT, UNIQUE(owner,idem_key));
      CREATE TABLE IF NOT EXISTS api_rates(bucket TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS api_execution(order_id TEXT PRIMARY KEY REFERENCES orders(id), plan_json TEXT NOT NULL,
        lease_until INTEGER NOT NULL, accepted_json TEXT, retrieved INTEGER NOT NULL DEFAULT 0);`));
  }
  private session(hash: string, now: number): void {
    if (!/^[a-f0-9]{64}$/.test(hash) || !this.sql.exec('SELECT hash FROM api_sessions WHERE hash=? AND expires_at>?', hash, now).toArray().length) throw new Error('unauthorized');
  }
  private owner(hash: string, id: string, now: number): void {
    this.session(hash, now);
    if (!this.sql.exec('SELECT order_id FROM api_orders WHERE owner=? AND order_id=?', hash, id).toArray().length) throw new Error('order_not_found');
  }
  /** Fixed window, global and per-principal quotas are updated together, also across restarts. */
  async rate(buckets: string[], limit: number, now: number): Promise<void> {
    this.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM api_rates WHERE start<?', now - 60000);
      for (const bucket of buckets) {
        const row = this.sql.exec<{ start: number; count: number }>('SELECT start,count FROM api_rates WHERE bucket=?', bucket).toArray()[0];
        if (row && now - row.start < 60000 && row.count >= limit) throw new Error('rate_limited');
      }
      for (const bucket of buckets) this.sql.exec(`INSERT INTO api_rates(bucket,start,count) VALUES(?,?,1)
        ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN excluded.start-api_rates.start>=60000 THEN 1 ELSE api_rates.count+1 END,
        start=CASE WHEN excluded.start-api_rates.start>=60000 THEN excluded.start ELSE api_rates.start END`, bucket, now);
    });
    await this.storage.sync();
  }
  async issue(hash: string, expiresAt: number): Promise<void> {
    this.sql.exec('INSERT INTO api_sessions(hash,expires_at) VALUES(?,?)', hash, expiresAt);
    await this.storage.sync();
  }
  authenticate(hash: string, now: number): void { this.session(hash, now); }
  async existing(hash: string, key: string, intent: string, now: number) {
    this.session(hash, now);
    const previous = this.sql.exec<{ order_id: string; intent: string }>('SELECT order_id,intent FROM api_orders WHERE owner=? AND idem_key=?', hash, key).toArray()[0];
    if (!previous) return null;
    if (previous.intent !== intent) throw new Error('idempotency_conflict');
    return { reused: true, record: await this.orders.get(previous.order_id) };
  }
  async create(hash: string, key: string, intent: string, order: Order, now: number) {
    this.session(hash, now);
    const previous = this.sql.exec<{ order_id: string; intent: string }>('SELECT order_id,intent FROM api_orders WHERE owner=? AND idem_key=?', hash, key).toArray()[0];
    if (previous) {
      if (previous.intent !== intent) throw new Error('idempotency_conflict');
      return { reused: true, record: await this.orders.get(previous.order_id) };
    }
    // No await from duplicate check until both INSERTs complete. DO interleaving starts after sync.
    await this.orders.createLinked(order, () => this.sql.exec('INSERT INTO api_orders(order_id,owner,idem_key,intent) VALUES(?,?,?,?)', order.id, hash, key, intent));
    return { reused: false, record: await this.orders.get(order.id) };
  }
  async get(hash: string, id: string, now: number) {
    this.owner(hash, id, now);
    const verification = this.sql.exec<{ verification_json: string | null }>('SELECT verification_json FROM api_orders WHERE order_id=?', id).toArray()[0].verification_json;
    return { record: await this.orders.get(id), verification: verification ? JSON.parse(verification) : null, execution: this.execution(id) };
  }
  private execution(id: string) {
    const row = this.sql.exec<{ plan_json: string; accepted_json: string | null; retrieved: number }>('SELECT plan_json,accepted_json,retrieved FROM api_execution WHERE order_id=?', id).toArray()[0];
    if (!row) return null;
    const plan: UploadPlan = JSON.parse(row.plan_json);
    return { id: plan.id, accepted: row.accepted_json ? JSON.parse(row.accepted_json) : null, retrieved: row.retrieved === 1, vaultId: plan.envelope.vault_id };
  }
  async claim(hash: string, id: string, candidate: UploadPlan | undefined, now: number) {
    this.owner(hash, id, now);
    const record = await this.orders.get(id);
    if (!record?.payment || record.order.kind !== 'preservation') throw new Error('preservation_not_paid');
    const result = this.storage.transactionSync(() => {
      const row = this.sql.exec<{ plan_json: string; lease_until: number; accepted_json: string | null; retrieved: number }>('SELECT * FROM api_execution WHERE order_id=?', id).toArray()[0];
      if (row?.lease_until && row.lease_until > now) return { busy: true };
      if (!row && !candidate) return { needsPlan: true };
      if (row) this.sql.exec('UPDATE api_execution SET lease_until=? WHERE order_id=?', now + 60000, id);
      else this.sql.exec('INSERT INTO api_execution(order_id,plan_json,lease_until) VALUES(?,?,?)', id, JSON.stringify(candidate), now + 60000);
      const states = { ...record.states, preservation: 'running' };
      this.sql.exec('UPDATE orders SET states_json=? WHERE id=?', JSON.stringify(states), id);
      return { plan: row ? JSON.parse(row.plan_json) as UploadPlan : candidate!, accepted: row?.accepted_json ? JSON.parse(row.accepted_json) as UploadAcceptance : null };
    });
    await this.storage.sync(); return result;
  }
  async finish(hash: string, id: string, accepted: UploadAcceptance | undefined, retrieved: boolean, now: number) {
    this.owner(hash, id, now);
    const record = await this.orders.get(id); if (!record?.payment) throw new Error('preservation_not_paid');
    this.storage.transactionSync(() => {
      const row = this.sql.exec<{ plan_json: string; accepted_json: string | null; retrieved: number }>('SELECT * FROM api_execution WHERE order_id=?', id).toArray()[0];
      if (!row) throw new Error('execution_not_reserved');
      const plan: UploadPlan = JSON.parse(row.plan_json);
      if (accepted && (accepted.id !== plan.id || accepted.winc !== plan.maxWinc)) throw new Error('upload_receipt_mismatch');
      const savedAcceptance = row.accepted_json || (accepted ? JSON.stringify({ ...accepted, sejireAcceptedAt: new Date(now).toISOString() }) : null);
      const verified = row.retrieved === 1 || (retrieved && Boolean(savedAcceptance));
      this.sql.exec('UPDATE api_execution SET lease_until=0,accepted_json=?,retrieved=? WHERE order_id=?', savedAcceptance, verified ? 1 : 0, id);
      this.sql.exec('UPDATE orders SET states_json=? WHERE id=?', JSON.stringify({ ...record.states, preservation: verified ? 'completed' : 'requires-reconciliation' }), id);
    });
    await this.storage.sync(); return this.get(hash, id, now);
  }
  async begin(hash: string, id: string, signature: string, now: number) {
    this.owner(hash, id, now); // MUST run before writing pendingSignature.
    return this.orders.beginReconciliation(id, signature);
  }
  async commit(hash: string, payment: ValidatedPayment, now: number) {
    this.owner(hash, payment.orderId, now);
    return this.orders.commitPayment(payment);
  }
  async result(hash: string, id: string, result: { status: string; reason?: string }, now: number): Promise<void> {
    this.owner(hash, id, now);
    // A late uncertain response must never overwrite a verified result from a concurrent request.
    this.storage.transactionSync(() => {
      const paid = this.sql.exec<{ payment_json: string | null }>('SELECT payment_json FROM orders WHERE id=?', id).toArray()[0].payment_json;
      this.sql.exec('UPDATE api_orders SET verification_json=? WHERE order_id=?', JSON.stringify(paid ? { status: 'verified' } : result), id);
    });
    await this.storage.sync();
  }
}
