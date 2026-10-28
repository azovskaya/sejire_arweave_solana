import bs58 from 'bs58';
import { assertBase58, createPaidOrder, SYSTEM_PROGRAM } from '../../../packages/checkout/order';
import { buildPaidPaymentMessage, SOLANA_GENESIS, type PaidPolicy } from '../../../packages/checkout/paid';
import { rpcU64 } from '../../../packages/checkout/rpcJson';
import { SolanaRpcReader } from '../src/checkout/rpcReader';
import { RpcEvidenceError } from '../src/checkout/rpcErrors';

type ProbeEnv = { RPC_PROBE_TOKEN?: string };
type Step = { method: string; outcome: 'ok' | 'error'; reason?: string; httpStatus?: number;
  rpcCode?: number; fetchException?: string; responseUrlMismatch?: boolean };
const POLICY_URL = 'https://sejire-sponsor.azovskaya-alissa.workers.dev/api/checkout/policy';
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const response = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers });
const asObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_rpc_shape');
  return value as Record<string, unknown>;
};

/** Disposable, token-gated Cloudflare probe. No ledger, AR signer, order creation, or broadcast. */
export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    if (request.method !== 'GET' || new URL(request.url).pathname !== '/probe') return response(404, { error: 'not_found' });
    if (!env.RPC_PROBE_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.RPC_PROBE_TOKEN}`)
      return response(403, { error: 'forbidden' });
    const steps: Step[] = [];
    try {
      const policyResponse = await fetch(POLICY_URL, { method: 'GET', redirect: 'manual' });
      if (!policyResponse.ok) throw Error('policy_unavailable');
      const offered = asObject(await policyResponse.json());
      const policy = offered.policy as PaidPolicy;
      if (!policy || policy.network !== 'mainnet-beta' || policy.genesisHash !== SOLANA_GENESIS['mainnet-beta'] ||
          policy.serviceLamports !== '30000000') throw Error('policy_mismatch');
      const payer = bs58.encode(new Uint8Array(32).fill(7));
      const reference = bs58.encode(new Uint8Array(32).fill(8));
      const now = Date.now();
      const order = createPaidOrder({ id: 'a'.repeat(32), kind: 'preservation', network: policy.network,
        asset: 'SOL', payer, reference, createdAt: now, expiresAt: now + 15 * 60000,
        policyVersion: policy.version, policyHash: String(offered.policyHash),
        servicePayment: { amount: policy.serviceLamports, recipient: policy.serviceRecipient },
        fundContribution: { amount: '0', recipient: policy.fundRecipient },
        archive: { digest: 'b'.repeat(64), bytes: 1, vaultId: 'c'.repeat(32), parentTxId: null },
        storage: { kind: 'arweave-direct', network: 'arweave.N.1', treasuryAddress: policy.storage.treasuryAddress } });
      let observed: { httpStatus?: number; fetchException?: string; responseUrlMismatch?: boolean } = {};
      const reader = new SolanaRpcReader({ network: policy.network }, async (url, init) => {
        try {
          const result = await fetch(url, init);
          observed.httpStatus = result.status;
          observed.responseUrlMismatch = Boolean(result.url && result.url !== new URL(String(url)).href);
          return result;
        } catch (error) {
          const name = error instanceof Error ? error.name : '';
          observed.fetchException = name === 'TypeError' || name === 'AbortError' ? name : 'other';
          throw error;
        }
      });
      const deadline = Date.now() + 22000;
      async function check(method: string, params: unknown[], validate: (value: unknown) => void): Promise<unknown> {
        observed = {};
        try {
          const value = await reader.rpc(method, params, deadline);
          validate(value);
          steps.push({ method, outcome: 'ok', ...observed });
          return value;
        } catch (error) {
          const evidence = error instanceof RpcEvidenceError ? error : null;
          steps.push({ method, outcome: 'error', reason: evidence?.reason ??
            (error instanceof Error && ['wrong-network','recipient_not_ready','invalid_rpc_shape','network_fee_not_ready'].includes(error.message)
              ? error.message : 'validation_error'),
            ...observed, ...(evidence?.details?.httpStatus === undefined ? {} : { httpStatus: evidence.details.httpStatus }),
            ...(evidence?.details?.rpcCode === undefined ? {} : { rpcCode: evidence.details.rpcCode }) });
          throw error;
        }
      }
      await check('getGenesisHash', [], value => { if (value !== SOLANA_GENESIS[policy.network]) throw Error('wrong-network'); });
      for (const recipient of [policy.serviceRecipient, policy.fundRecipient]) {
        await check('getAccountInfo', [recipient, { encoding: 'base64', commitment: 'finalized' }], value => {
          const account = asObject(value).value;
          if (account !== null) {
            const details = asObject(account);
            if (details.owner !== SYSTEM_PROGRAM || details.executable !== false) throw Error('recipient_not_ready');
          }
        });
      }
      const latest = asObject(await check('getLatestBlockhash', [{ commitment: 'finalized' }], value => {
        const detail = asObject(asObject(value).value);
        assertBase58(String(detail.blockhash), 32);
        if (!Number.isSafeInteger(detail.lastValidBlockHeight)) throw Error('invalid_rpc_shape');
      })).value;
      const blockhash = String(asObject(latest).blockhash);
      const message = buildPaidPaymentMessage(order, blockhash); // Synthetic and unsigned; never sent to the chain.
      await check('getFeeForMessage', [message, { commitment: 'finalized' }], value => {
        const fee = asObject(value).value;
        if (typeof fee !== 'number' || !Number.isSafeInteger(fee) || fee <= 0 || fee > 100000) throw Error('network_fee_not_ready');
      });
      await check('getBalance', [payer, { commitment: 'finalized' }], value => { rpcU64(asObject(value).value); });
      return response(200, { schema: 'sejire/rpc-probe/v1', network: policy.network, steps });
    } catch {
      return response(200, { schema: 'sejire/rpc-probe/v1', steps,
        ...(steps.length ? {} : { error: 'probe_setup_failed' }) });
    }
  },
};
