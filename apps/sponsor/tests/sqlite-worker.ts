// LOCAL TEST ENTRY ONLY. Never referenced by wrangler.toml or application HTTP routes.
export { CheckoutLedger } from '../src/checkout/durableStore';
import { SqliteAtomicOrderStore } from '../src/checkout/sqliteStore';
import { reconcilePayment } from '../src/checkout/reconciliation';
import { validatePayment } from '../src/checkout/paymentValidator';
import { decodeTransaction } from '../src/checkout/rpcDecoder';
import { fixtureOrder, fixtureTransaction, fixtureChain, sig, addr } from '../src/checkout/rpcFixtures';

/** Fault probes run the actual SQLite adapter against workerd's disk-backed SQL storage. */
export class FaultLedger {
  private fail = false;
  private readonly store: SqliteAtomicOrderStore;
  constructor(ctx: DurableObjectState) {
    this.store = new SqliteAtomicOrderStore(ctx.storage, () => { if (this.fail) throw new Error('simulated_before_commit'); });
  }
  async fetch(request: Request) {
    const { action } = await request.json() as { action: string };
    const order = fixtureOrder({ id: 'f'.repeat(32), reference: addr(16) });
    const tx = decodeTransaction(fixtureTransaction(order, sig(16)), sig(16), fixtureChain);
    const reader = { chain: fixtureChain, read: async () => tx };
    if (action === 'prepare') { await this.store.create(order); await this.store.beginReconciliation(order.id, sig(16)); return Response.json(null); }
    if (action === 'fail-before-commit') {
      this.fail = true;
      try { await this.store.commitPayment(validatePayment(order, tx, fixtureChain)); return new Response('unexpected_success', { status: 500 }); }
      catch (error) { if (!(error instanceof Error) || error.message !== 'simulated_before_commit') throw error; return Response.json({ simulated: true }, { status: 503 }); }
      finally { this.fail = false; }
    }
    if (action === 'snapshot') return Response.json({ record: await this.store.get(order.id), totals: await this.store.totals() });
    if (action === 'commit-response-lost') {
      await reconcilePayment(this.store, reader, order.id, sig(16));
      return new Response('simulated_response_loss_AFTER_durable_commit', { status: 503 });
    }
    if (action === 'retry') return Response.json(await reconcilePayment(this.store, reader, order.id, sig(16)));
    return new Response('unsupported_test_action', { status: 400 });
  }
}
// No public gateway, backend deploy, Internet RPC or HTTP order creation in this entry.
export default { fetch: () => new Response('local_test_only', { status: 404 }) };
