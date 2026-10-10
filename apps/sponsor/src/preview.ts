/** Dedicated preview entry: no legacy admin, treasury generation, Kaspi or production uploads. */
import { checkoutApi, type CheckoutApiEnv } from './checkout/api';
export { CheckoutLedger } from './checkout/durableStore';
export type PreviewEnv = CheckoutApiEnv & { ASSETS: Fetcher };
export default {
  async fetch(request: Request, env: PreviewEnv): Promise<Response> {
    const response = await checkoutApi(request, env);
    if (response) return response;
    if (new URL(request.url).pathname.startsWith('/api/')) return new Response('not_found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
};
