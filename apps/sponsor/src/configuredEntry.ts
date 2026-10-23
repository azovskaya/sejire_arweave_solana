import worker, { type Env } from './index';
import { DurableOrderStore } from './checkout/durableStore';
import { withRecipientSettings } from './checkout/recipientSettings';
import { recipientAdminApi, recipientHeaders, RECIPIENT_ADMIN_PATH } from './checkout/recipientAdmin';
import type { SolanaRecipientSettings } from '../../../packages/checkout/recipients';
export { CheckoutLedger } from './checkout/durableStore';

/** Configuration adapter around the unchanged payment/fund handlers.
 * Existing order/resume routes use their immutable persisted policy, not today's addresses.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === RECIPIENT_ADMIN_PATH) return recipientAdminApi(request, env);
    const newOffer = request.method === 'GET' && ['/api/checkout/policy', '/api/checkout/policy/contribution'].includes(path);
    const newOrder = request.method === 'POST' && path === '/api/checkout/orders';
    if ((newOffer || newOrder) && env.CHECKOUT_LEDGER &&
        (env.CHECKOUT_PAID_ENABLED === 'true' || env.CHECKOUT_CONTRIBUTION_ENABLED === 'true')) {
      const headers = recipientHeaders(request, env);
      // Let the existing handler return its own origin denial without reading settings.
      if (!headers) return worker.fetch(request, env);
      try {
        const saved = await new DurableOrderStore(env.CHECKOUT_LEDGER).call<SolanaRecipientSettings | null>({ action: 'recipientSettingsGet' });
        return worker.fetch(request, withRecipientSettings(env, saved));
      } catch {
        return new Response(JSON.stringify({ error: 'solana_recipient_settings_unavailable' }), { status: 503, headers });
      }
    }
    return worker.fetch(request, env);
  },
};
