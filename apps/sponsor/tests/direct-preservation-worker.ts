// TEST ONLY: no production entry imports this route. The harness blocks every
// external connection and supplies an ephemeral, unfunded RSA key in memory.
import { DirectArweavePreservation, type DirectInput, type PreparedDirectPlan, type SignedDirectPlan } from '../src/checkout/directPreservation';

type TestEnv = { TEST_RSA_JWK?: string; TEST_TREASURY: string };
export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    if (request.method !== 'POST' || request.headers.get('X-Synthetic-Test') !== 'offline-direct-arweave') return new Response('not_found', { status: 404 });
    try {
      const data = await request.json() as { action: string; input: DirectInput; prepared?: PreparedDirectPlan; signed?: SignedDirectPlan; timeout?: number };
      const provider = new DirectArweavePreservation({ secret: env.TEST_RSA_JWK,
        policy: { treasuryAddress: env.TEST_TREASURY, network: 'arweave.N.1', maxArchiveBytes: 524288, maxRewardWinston: '4000000000' },
        executionEnabled: data.action !== 'paused-sign' && data.action !== 'paused-submit' });
      const options = data.timeout ? { deadline: Date.now() + data.timeout } : {};
      if (data.action === 'ready') return Response.json(await provider.ready(data.input.archive.bytes, options));
      if (data.action === 'prepare') return Response.json(await provider.prepare(data.input, options));
      if (data.action === 'sign' || data.action === 'paused-sign') return Response.json(await provider.sign(data.input, data.prepared!, options));
      if (data.action === 'submit' || data.action === 'paused-submit') return Response.json(await provider.submit(data.input, data.signed!, options));
      if (data.action === 'reconcile') return Response.json(await provider.reconcile(data.input, data.signed!, options));
      return new Response('not_found', { status: 404 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'synthetic_worker_error' }, { status: 422 });
    }
  },
};
