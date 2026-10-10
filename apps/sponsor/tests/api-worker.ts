// LOCAL/CI ONLY. No test selectors or fixture transport are imported by sponsor/src/index.ts.
export { CheckoutLedger } from '../src/checkout/durableStore';
import application, { type Env } from '../src/index';
import { checkoutApi, type CheckoutApiEnv } from '../src/checkout/api';
import { DurableOrderStore } from '../src/checkout/durableStore';
import { SolanaRpcReader, DEVNET_GENESIS } from '../src/checkout/rpcReader';
import { fixtureStatus, fixtureTransaction, addr } from '../src/checkout/rpcFixtures';
import { Buffer } from 'node:buffer';
import { envelopeDigest } from '../../web/src/lib/solana/policy';
import { TestnetPreservationService, type PreservationService } from '../src/checkout/preservation';
import bs58 from 'bs58';
import type { PaymentPreparer } from '../src/checkout/paymentPreparation';
import type { StoredOrder } from '../src/checkout/store';
export default {
  async fetch(request: Request, env: CheckoutApiEnv): Promise<Response> {
    // Proves actual application entry gates the API, and does not expose DO internal actions.
    if (request.headers.get('X-Test-Production-Entry') === 'true') return application.fetch(request, env as Env);
    const reader = () => new SolanaRpcReader({ network: 'devnet', timeoutMs: 1000 }, async (_url, init) => {
      const input = JSON.parse(init!.body as string) as { id: number; method: string; params: unknown[] };
      const mode = request.headers.get('X-Test-Rpc') ?? 'success';
      if (mode === '429') return new Response('', { status: 429 });
      if (mode === '500') return new Response('', { status: 500 });
      if (mode === 'malformed') return new Response('{');
      if (mode === 'timeout') return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('synthetic_timeout'))));
      let result: unknown;
      if (input.method === 'getGenesisHash') result = mode === 'wrong-network' ? addr(90) : DEVNET_GENESIS;
      else if (input.method === 'getSignatureStatuses') {
        result = fixtureStatus();
        if (mode === 'confirmed') (result as ReturnType<typeof fixtureStatus>).value[0].confirmationStatus = 'confirmed';
      } else if (input.method === 'getTransaction') {
        if (mode === 'null') result = null;
        else {
          const id = /\/orders\/([a-f0-9]{32})\//.exec(new URL(request.url).pathname)![1];
          const record = await new DurableOrderStore(env.CHECKOUT_LEDGER!).get(id) as StoredOrder;
          const transaction = fixtureTransaction(record.order, input.params[0] as string);
          transaction.blockTime = Math.ceil(record.order.createdAt / 1000) + 1;
          if (mode === 'wrong-recipient') transaction.transaction.message.accountKeys[1] = addr(91);
          if (mode === 'failed') transaction.meta.err = { InstructionError: [0, 'Custom'] };
          result = transaction;
        }
      } else throw new Error('unexpected_rpc_method');
      return Response.json({ jsonrpc: '2.0', id: input.id, result });
    });
    const archiveInput = request.clone();
    // PUBLIC RFC8032 software fixture ONLY. Tests exercise the actual uploader in workerd;
    // the transport is synthetic and NEVER sends signatures/uploads to a real network.
    const vector = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex');
    const actual = new TestnetPreservationService({ ...env, CHECKOUT_UPLOAD_ENABLED: 'true', CHECKOUT_UPLOAD_SIGNER: bs58.encode(vector) }, async (url, init) => {
      if (String(url).startsWith('https://payment.services.ar-io.dev/v1/account/free?')) return Response.json({ bytesRemaining: 1000000 });
      if (String(url) === 'https://upload.services.ar-io.dev/v1/tx') {
        const raw = new Uint8Array(init!.body as Uint8Array);
        const id = Buffer.from(await envelopeDigest(raw.subarray(2, 66)), 'hex').toString('base64url');
        return Response.json({ id, winc: '0', synthetic: true });
      }
      if (String(url).startsWith('https://ar-io.dev/raw/')) {
        if (request.headers.get('X-Test-Upload') === 'not-retrieved') return new Response('', { status: 404 });
        const payload = await archiveInput.clone().json() as { serialized: string };
        return new Response(payload.serialized);
      }
      throw new Error('unexpected_synthetic_upload_endpoint');
    });
    const preservation: PreservationService = {
      ready: async () => { if (request.headers.get('X-Test-Upload') === 'not-ready') throw new Error('uploader_not_ready'); },
      sign: async (order, serialized) => {
        try { return await actual.sign(order, serialized); }
        catch (error) { console.error('Synthetic uploader runtime failure:', error instanceof Error ? error.message : 'unknown'); throw error; }
      },
      upload: plan => actual.upload(plan),
      retrieve: (id, digest) => actual.retrieve(id, digest),
    };
    const preparer: PaymentPreparer = { prepare: async () => {
      if (request.headers.get('X-Test-Accounts') === 'missing') throw new Error('token_accounts_not_ready');
      return { source: addr(11), serviceDestination: addr(12), fundDestination: addr(13), blockhash: addr(8), lastValidBlockHeight: 1000, feeLamports: '5000' };
    } };
    return await checkoutApi(request, env, reader, preservation, preparer) ?? new Response('not_found', { status: 404 });
  },
};
