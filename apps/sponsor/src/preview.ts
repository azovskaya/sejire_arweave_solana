import { fundApi } from './fund/api';
/** Dedicated preview entry: no legacy admin, treasury generation, Kaspi or production uploads. */
import { checkoutApi, type CheckoutApiEnv } from './checkout/api';
export { CheckoutLedger } from './checkout/durableStore';
export type PreviewEnv = CheckoutApiEnv & { ASSETS: Fetcher; FUND_API_ENABLED?:string; ARWEAVE_TREASURY_JWK?:string; PROMO_CODE_SECRET?:string; ADMIN_TOKEN?:string; IDEMPOTENCY?:KVNamespace };
export default {
  async fetch(request: Request, env: PreviewEnv): Promise<Response> {
    const funded = await fundApi(request, env);
    if (funded) return funded;
    const response = await checkoutApi(request, env);
    if (response) return response;
    if (new URL(request.url).pathname.startsWith('/api/')) return new Response('not_found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
};
