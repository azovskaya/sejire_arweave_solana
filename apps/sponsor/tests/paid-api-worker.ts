// LOCAL/CI ONLY. Production imports neither this entry nor its inspection actions.
import application, { type Env } from '../src/index';
import { CheckoutLedger as ActualCheckoutLedger } from '../src/checkout/durableStore';

/** The API, ledger and alarm implementation are production code. Only fixture
 * inspection/clock advancement is added to the private test namespace. */
export class CheckoutLedger extends ActualCheckoutLedger {
  constructor(private readonly testContext: DurableObjectState, env: Env & { CHECKOUT_LEDGER: DurableObjectNamespace }) { super(testContext, env); }
  override async fetch(request: Request): Promise<Response> {
    const input = await request.clone().json() as { action?: string; id?: string; hash?: string };
    if (input.action === '__testPaidCounts') {
      const counts: Record<string, number> = {};
      for (const table of ['orders', 'api_orders', 'paid_orders', 'paid_payloads', 'paid_holds', 'credits', 'paid_cancelled_keys']) {
        counts[table] = this.testContext.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).toArray()[0].count;
      }
      return Response.json(counts);
    }
    if (input.action === '__testInspectPaid') {
      const sql = this.testContext.storage.sql;
      const row = sql.exec<{ order_json: string; payment_json: string | null; pending_signature: string | null }>(
        'SELECT order_json,payment_json,pending_signature FROM orders WHERE id=?', input.id!).toArray()[0];
      const paid = sql.exec<{ status: string; receipt_json: string | null; proof_json: string | null; lease_until: number; last_error: string | null }>(
        'SELECT status,receipt_json,proof_json,lease_until,last_error FROM paid_orders WHERE order_id=?', input.id!).toArray()[0];
      return Response.json({ row, paid, credits: sql.exec('SELECT purpose,amount,signature FROM credits WHERE order_id=?', input.id!).toArray(),
        hold: sql.exec('SELECT reward,actual,released FROM paid_holds WHERE order_id=?', input.id!).toArray()[0],
        legacyExecution: sql.exec('SELECT order_id FROM api_execution WHERE order_id=?', input.id!).toArray(),
        payloadKinds: sql.exec('SELECT kind FROM paid_payloads WHERE order_id=?', input.id!).toArray() });
    }
    if (input.action === '__testArmPaidNow') {
      this.testContext.storage.sql.exec('UPDATE paid_orders SET next_at=? WHERE order_id=? AND status<>?', Date.now() - 1, input.id!, 'completed');
      await this.testContext.storage.setAlarm(Date.now() + 1);
      await this.testContext.storage.sync();
      return Response.json(null);
    }
    if (input.action === '__testExpireSession') {
      this.testContext.storage.sql.exec('UPDATE api_sessions SET expires_at=? WHERE hash=?', Date.now() - 1, input.hash!);
      await this.testContext.storage.sync();
      return Response.json(null);
    }
    return super.fetch(request);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> { return application.fetch(request, env); },
};
