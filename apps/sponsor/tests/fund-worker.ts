// TEST ONLY: bundled only by fund-runtime.mjs, never by production Wrangler entries.
import { fundApi, type FundEnv } from '../src/fund/api';
import { DirectArweaveFundProvider, MockFundedArweaveProvider } from '../src/fund/provider';
import { publicTreasuryOwner } from './fund-public-owner.mjs';
export { CheckoutLedger } from '../src/checkout/durableStore';

const provider = new MockFundedArweaveProvider();
const testHeader = 'synthetic-workerd-only';
export default {
  async fetch(request: Request, env: FundEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/__test/')) {
      if (request.headers.get('X-Synthetic-Test') !== testHeader) return new Response('not_found', { status: 404 });
      if (path === '/__test/health' && request.method === 'GET') return Response.json({ healthy: true, runtime: 'workerd' });
      if (path === '/__test/direct-provider' && request.method === 'GET') {
        // Only the local runtime harness bundles this route. All gateway reads
        // are intercepted there; this synthetic object cannot sign anything.
        const archive = JSON.stringify({ schema: 'sejire/envelope/v1', vault_id: 'a'.repeat(32), cipher: 'aes-gcm-256',
          kdf: 'hkdf-sha256', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'A'.repeat(32), protocol: 'sejire/v0.3' });
        const bytes = new TextEncoder().encode(archive);
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
        const reader = new DirectArweaveFundProvider(JSON.stringify({ kty: 'RSA', n: publicTreasuryOwner, d: 'synthetic-only-not-a-key' }));
        const transaction = await reader.getTransaction('A'.repeat(43));
        const result = await reader.verify('A'.repeat(43), { digest, bytes: bytes.length, vaultId: 'a'.repeat(32) }, transaction);
        return Response.json({ transaction, result });
      }
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
