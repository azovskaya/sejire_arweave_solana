// TEST ONLY: bundled only by fund-runtime.mjs, never by production Wrangler entries.
import { fundApi, type FundEnv } from '../src/fund/api';
import { MockFundedArweaveProvider } from '../src/fund/provider';
export { CheckoutLedger } from '../src/checkout/durableStore';

const provider = new MockFundedArweaveProvider();
const testHeader = 'synthetic-workerd-only';
export default {
  async fetch(request: Request, env: FundEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/__test/')) {
      if (request.headers.get('X-Synthetic-Test') !== testHeader) return new Response('not_found', { status: 404 });
      if (path === '/__test/health' && request.method === 'GET') return Response.json({ healthy: true, runtime: 'workerd' });
      if (path === '/__test/stats' && request.method === 'GET') return Response.json({ submissions: provider.submissions });
      if (path === '/__test/mock' && request.method === 'POST') {
        const input = await request.json() as Record<string, unknown>;
        for (const key of Object.keys(input)) if (!['failure', 'delay', 'balance', 'price', 'estimate', 'actual', 'signerAddress'].includes(key)) return Response.json({ error: 'invalid_mock_control' }, { status: 400 });
        if (typeof input.failure === 'string') provider.failure = input.failure;
        if (typeof input.delay === 'boolean') provider.delay = input.delay;
        for (const key of ['balance', 'price', 'estimate', 'actual', 'signerAddress'] as const) if (typeof input[key] === 'string') provider[key] = input[key];
        return Response.json({ ok: true });
      }
      return new Response('not_found', { status: 404 });
    }
    return await fundApi(request, env, provider) ?? new Response('not_found', { status: 404 });
  },
};
