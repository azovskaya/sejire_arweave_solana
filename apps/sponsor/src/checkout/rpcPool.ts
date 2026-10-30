import { canonical } from '../../../../packages/protocol/wire';
import { createPaidOrder, SYSTEM_PROGRAM, type Network, type PaidOrder } from '../../../../packages/checkout/order';
import { buildPaidPaymentMessage, SOLANA_GENESIS, SOLANA_RPCS, type DurablePaymentPreparation, type PaidPolicy } from '../../../../packages/checkout/paid';
import { rpcU64 } from '../../../../packages/checkout/rpcJson';
import { RpcPaymentPreparer } from './paymentPreparation';
import type { TransactionEvidence, ChainPolicy } from './paymentValidator';
import type { ReferencePaymentResult, TrustedTransactionReader } from './reconciliation';
import { RpcEvidenceError, type RpcFailure } from './rpcErrors';
import { SolanaRpcReader } from './rpcReader';
import { object } from './rpcDecoder';
import bs58 from 'bs58';

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

type Health = { ready: boolean; checkedAt: number; method?: string; reason?: string; httpStatus?: number; rpcCode?: number };
const healthCache = new Map<string, { until: number; result: Health }>();
/** Fixed, read-only probe. No caller-supplied method, URL, payer, archive or order. */
export async function paidRpcHealth(env: RpcEnv, policy: PaidPolicy): Promise<Health> {
  const urls = configuredUrls(env, policy.network);
  const cacheKey = `${policy.network}:${urls.join('|')}:${policy.serviceRecipient}:${policy.fundRecipient}`;
  const cached = healthCache.get(cacheKey);
  if (cached && cached.until > Date.now()) return cached.result;
  const deadline = Date.now() + 25000;
  const payer = bs58.encode(new Uint8Array(32).fill(7));
  const reference = bs58.encode(new Uint8Array(32).fill(8));
  const now = Date.now();
  const synthetic = createPaidOrder({ id: 'a'.repeat(32), kind: 'preservation', network: policy.network,
    asset: 'SOL', payer, reference, createdAt: now, expiresAt: now + 900000,
    policyVersion: policy.version, policyHash: '0'.repeat(64),
    servicePayment: { amount: policy.serviceLamports, recipient: policy.serviceRecipient },
    fundContribution: { amount: '0', recipient: policy.fundRecipient },
    archive: { digest: 'b'.repeat(64), bytes: 1, vaultId: 'c'.repeat(32), parentTxId: null },
    storage: policy.storage });
  let failure: Health = { ready: false, checkedAt: now, reason: 'rpc-unavailable' };
  for (const url of candidates(env, policy.network)) {
    const source = reader(policy.network, url);
    let method = 'getGenesisHash';
    try {
      const call = async (name: string, params: unknown[] = []) => { method = name; return source.rpc(name, params, deadline); };
      if (await call('getGenesisHash') !== SOLANA_GENESIS[policy.network]) throw new RpcEvidenceError('wrong-network');
      for (const recipient of [policy.serviceRecipient, policy.fundRecipient]) {
        const account = object(await call('getAccountInfo', [recipient, { encoding: 'base64', commitment: 'finalized' }]));
        if (account.value !== null) {
          const details = object(account.value);
          if (details.owner !== SYSTEM_PROGRAM || details.executable !== false) throw Error('recipient_not_ready');
        }
      }
      const block = object(object(await call('getLatestBlockhash', [{ commitment: 'finalized' }])).value);
      if (typeof block.blockhash !== 'string') throw new RpcEvidenceError('rpc-malformed');
      const message = buildPaidPaymentMessage(synthetic, block.blockhash);
      const fee = object(await call('getFeeForMessage', [message, { commitment: 'finalized' }]));
      if (typeof fee.value !== 'number' || !Number.isSafeInteger(fee.value) || fee.value <= 0 || fee.value > 100000) throw Error('network_fee_not_ready');
      rpcU64(object(await call('getBalance', [payer, { commitment: 'finalized' }])).value);
      const height = await call('getBlockHeight', [{ commitment: 'finalized' }]);
      if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0) throw new RpcEvidenceError('rpc-malformed');
      const history = await call('getSignaturesForAddress', ['Vote111111111111111111111111111111111111111', { commitment: 'finalized', limit: 1 }]);
      if (!Array.isArray(history) || !history.length || typeof object(history[0]).signature !== 'string') throw new RpcEvidenceError('rpc-malformed');
      const signature = object(history[0]).signature;
      const status = object(await call('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]));
      if (!Array.isArray(status.value) || !status.value[0]) throw new RpcEvidenceError('rpc-malformed');
      const transaction = await call('getTransaction', [signature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 }]);
      if (!transaction || !object(transaction).transaction) throw new RpcEvidenceError('rpc-malformed');
      const result = { ready: true, checkedAt: now };
      healthCache.set(cacheKey, { until: Date.now() + 120000, result });
      return result;
    } catch (error) {
      const evidence = error instanceof RpcEvidenceError ? error : null;
      failure = { ready: false, checkedAt: now, method, reason: evidence?.reason ?? (error instanceof Error &&
        ['recipient_not_ready', 'network_fee_not_ready'].includes(error.message) ? error.message : 'rpc-malformed'),
        ...(evidence?.details?.httpStatus === undefined ? {} : { httpStatus: evidence.details.httpStatus }),
        ...(evidence?.details?.rpcCode === undefined ? {} : { rpcCode: evidence.details.rpcCode }) };
      if (!isUnavailable(error)) break;
      pause(url, error);
    }
  }
  healthCache.set(cacheKey, { until: Date.now() + 30000, result: failure });
  return failure;
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
