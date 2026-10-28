import { canonical } from '../../../../packages/protocol/wire';
import type { Network, PaidOrder } from '../../../../packages/checkout/order';
import { SOLANA_RPCS, type DurablePaymentPreparation } from '../../../../packages/checkout/paid';
import { RpcPaymentPreparer } from './paymentPreparation';
import type { TransactionEvidence, ChainPolicy } from './paymentValidator';
import type { ReferencePaymentResult, TrustedTransactionReader } from './reconciliation';
import { RpcEvidenceError, type RpcFailure } from './rpcErrors';
import { SolanaRpcReader } from './rpcReader';

type RpcEnv = { CHECKOUT_PAID_NETWORK?: string; CHECKOUT_SOLANA_RPC_URL?: string; CHECKOUT_SOLANA_RPC_URLS?: string };
const POCKET_MAINNET = 'https://solana.api.pocket.network';
const COOLDOWN_MS = 60000;
const MAX_COOLDOWN_MS = 300000;
const cooled = new Map<string, { until: number; error: RpcEvidenceError }>();
const unavailable = new Set<RpcFailure>(['rpc-timeout', 'rpc-rate-limited', 'rpc-server-error', 'rpc-unavailable']);

function isUnavailable(error: unknown): error is RpcEvidenceError {
  return error instanceof RpcEvidenceError && unavailable.has(error.reason);
}
function pause(url: string, error?: RpcEvidenceError): void {
  const retry = error?.details?.retryAfterMs;
  const duration = error?.details?.httpStatus === 403 ? MAX_COOLDOWN_MS :
    retry === undefined ? COOLDOWN_MS : Math.min(MAX_COOLDOWN_MS, Math.max(COOLDOWN_MS, retry));
  cooled.set(url, { until: Date.now() + duration, error: error ?? new RpcEvidenceError('rpc-unavailable') });
}
function configuredUrls(env: RpcEnv, network: Network): string[] {
  if (network !== env.CHECKOUT_PAID_NETWORK) return [SOLANA_RPCS[network]];
  let custom: string[] = [];
  if (env.CHECKOUT_SOLANA_RPC_URLS !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(env.CHECKOUT_SOLANA_RPC_URLS); } catch { throw Error('invalid_server_rpc_configuration'); }
    if (!Array.isArray(parsed) || parsed.length > 4 || parsed.some(value => typeof value !== 'string')) throw Error('invalid_server_rpc_configuration');
    custom = parsed;
  }
  if (env.CHECKOUT_SOLANA_RPC_URL) custom.unshift(env.CHECKOUT_SOLANA_RPC_URL);
  const urls = [...new Set([...custom, ...(network === 'mainnet-beta' ? [POCKET_MAINNET] : []), SOLANA_RPCS[network]])];
  // Validate every server-configured endpoint before making any external call.
  for (const url of urls) new SolanaRpcReader({ network, endpointUrl: url });
  return urls;
}
function candidates(env: RpcEnv, network: Network): string[] {
  const now = Date.now();
  return configuredUrls(env, network).filter(url => (cooled.get(url)?.until ?? 0) <= now);
}
function reader(network: Network, url: string): SolanaRpcReader {
  return new SolanaRpcReader({ network, endpointUrl: url });
}

/** Each preparation is entirely sourced from one RPC; failed candidates never leave a stored message. */
export async function preparePaidWithRpc(env: RpcEnv, order: PaidOrder): Promise<DurablePaymentPreparation> {
  const deadline = Date.now() + 22000;
  let last: RpcEvidenceError | null = null;
  for (const url of candidates(env, order.network)) {
    try { return await new RpcPaymentPreparer(reader(order.network, url)).preparePaid(order, deadline); }
    catch (error) {
      if (!isUnavailable(error)) throw error;
      pause(url, error); last = error;
    }
  }
  throw last ?? configuredUrls(env, order.network).map(url => cooled.get(url)?.error).find(Boolean) ?? new RpcEvidenceError('rpc-unavailable');
}

/** Independent complete observations; no method-level stitching between nodes. */
export class PaidRpcPool implements TrustedTransactionReader {
  readonly chain: ChainPolicy;
  constructor(private readonly env: RpcEnv, network: Network) {
    this.chain = new SolanaRpcReader({ network }).chain;
    configuredUrls(env, network);
  }
  async read(signature: string): Promise<TransactionEvidence | null> {
    const deadline = Date.now() + 22000;
    let found: TransactionEvidence | null = null, observed = false, last: RpcEvidenceError | null = null;
    for (const url of candidates(this.env, this.chain.network)) {
      try {
        const value = await reader(this.chain.network, url).read(signature, deadline);
        observed = true;
        if (value) {
          if (found && canonical(found) !== canonical(value)) throw new RpcEvidenceError('rpc-conflicting-evidence');
          found = value;
        }
      } catch (error) {
        if (!isUnavailable(error)) throw error;
        pause(url, error); last = error;
      }
    }
    if (found) return found;
    if (observed) return null;
    throw last ?? new RpcEvidenceError('rpc-unavailable');
  }
  async findByReference(order: PaidOrder, preparation: DurablePaymentPreparation): Promise<ReferencePaymentResult> {
    const deadline = Date.now() + 22000;
    let found: Extract<ReferencePaymentResult, { status: 'found' }> | null = null;
    let uncertain: Extract<ReferencePaymentResult, { status: 'requires-reconciliation' }> | null = null, observed = false;
    for (const url of candidates(this.env, this.chain.network)) {
      const result = await reader(this.chain.network, url).findByReference(order, preparation, deadline);
      if (result.status === 'found') {
        if (found && (found.signature !== result.signature || canonical(found.payment) !== canonical(result.payment)))
          return { status: 'requires-reconciliation', reason: 'reference-ambiguous' };
        found = result; observed = true;
      } else if (unavailable.has(result.reason as RpcFailure)) {
        pause(url); uncertain ??= result;
      } else if (result.reason === 'not-found') observed = true;
      else uncertain ??= result;
    }
    if (uncertain && !unavailable.has(uncertain.reason as RpcFailure)) return uncertain;
    if (found) return found;
    if (observed) return { status: 'requires-reconciliation', reason: 'not-found' };
    return uncertain ?? { status: 'requires-reconciliation', reason: 'rpc-unavailable' };
  }
}
