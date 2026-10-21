import { assertBase58, type Network, type PaidOrder } from '../../../../packages/checkout/order';
import { SOLANA_GENESIS, SOLANA_RPCS, validatePaymentPreparation, type DurablePaymentPreparation } from '../../../../packages/checkout/paid';
import { validatePreparedPayment, type ChainPolicy } from './paymentValidator';
import type { TrustedTransactionReader, ReferencePaymentResult } from './reconciliation';
import { decodeTransaction, object } from './rpcDecoder';
import { RpcEvidenceError } from './rpcErrors';

export const DEVNET_GENESIS = SOLANA_GENESIS.devnet;
export const MAINNET_GENESIS = SOLANA_GENESIS['mainnet-beta'];
export type ServerRpcConfig = Readonly<{ network: Network; timeoutMs?: number }>;
/** Construct only from server configuration. No browser URL/network/finality parameters.
 * Supporting a network here never enables API admission, wallet signing or broadcast.
 */
export class SolanaRpcReader implements TrustedTransactionReader {
  readonly chain: ChainPolicy;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private nextId = 0;
  private readonly transport: typeof fetch;
  constructor(config: ServerRpcConfig, transport: typeof fetch = (input, init) => fetch(input, init)) {
    this.transport = transport;
    if ((config.network !== 'devnet' && config.network !== 'mainnet-beta') || Object.keys(config).some(k => k !== 'network' && k !== 'timeoutMs')) throw new Error('invalid_server_rpc_configuration');
    this.endpoint = SOLANA_RPCS[config.network];
    this.chain = Object.freeze({ network: config.network, genesisHash: SOLANA_GENESIS[config.network] });
    this.timeoutMs = config.timeoutMs ?? 10000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30000) throw new Error('invalid_rpc_timeout');
  }
  /** Server-only RPC primitive for pre-payment account checks; never forwarded from browser. */
  async rpc(method: string, params: unknown[] = [], deadline?: number): Promise<unknown> {
    const remaining = deadline === undefined ? this.timeoutMs : Math.min(this.timeoutMs, deadline - Date.now());
    if (remaining <= 0) throw new RpcEvidenceError('rpc-timeout');
    const id = ++this.nextId, controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      // Workerd supports manual/follow only; reject redirects before reading RPC evidence.
      const response = await this.transport(this.endpoint, { method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      if ((response.url && response.url !== new URL(this.endpoint).href) || (response.status >= 300 && response.status < 400)) {
        void response.body?.cancel().catch(() => {});
        throw new RpcEvidenceError('rpc-unavailable', { httpStatus: response.status });
      }
      if (response.status === 429) throw new RpcEvidenceError('rpc-rate-limited',{httpStatus:429,retryAfterMs:retryDelay(response.headers.get('Retry-After'))});
      if (response.status >= 500) throw new RpcEvidenceError('rpc-server-error',{httpStatus:response.status});
      if (!response.ok) throw new RpcEvidenceError('rpc-unavailable',{httpStatus:response.status});
      // Bound bytes before JSON parse; applies to RPC evidence, never to archive size/contribution.
      if (!response.body) throw new RpcEvidenceError('rpc-malformed');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new RpcEvidenceError('rpc-response-too-large'); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
      catch { throw new RpcEvidenceError('rpc-malformed'); }
      const payload = object(parsed);
      if (payload.jsonrpc !== '2.0' || payload.id !== id) throw new RpcEvidenceError('rpc-malformed');
      if (payload.error !== undefined) {
        const error = object(payload.error);
        throw new RpcEvidenceError(error.code === -32015 ? 'unsupported-transaction' : 'rpc-unavailable',{httpStatus:response.status,rpcCode:typeof error.code==='number'?error.code:undefined});
      }
      if (!Object.hasOwn(payload, 'result')) throw new RpcEvidenceError('rpc-malformed');
      return payload.result;
    } catch (error) {
      if (controller.signal.aborted) throw new RpcEvidenceError('rpc-timeout');
      if (error instanceof RpcEvidenceError) throw error;
      throw new RpcEvidenceError('rpc-unavailable');
    } finally { clearTimeout(timer); }
  }
  async read(signature: string, deadline?: number) {
    assertBase58(signature, 64);
    // Recheck genesis for every reconciliation: an endpoint/network change cannot reuse cached trust.
    if (await this.rpc('getGenesisHash', [], deadline) !== this.chain.genesisHash) throw new RpcEvidenceError('wrong-network');
    const statusResult = object(await this.rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }], deadline));
    const values = statusResult.value;
    if (!Array.isArray(values) || values.length !== 1) throw new RpcEvidenceError('rpc-malformed');
    if (values[0] === null) return null;
    const status = object(values[0]);
    const context = object(statusResult.context);
    if (typeof status.slot !== 'number' || !Number.isSafeInteger(status.slot) || status.slot < 0 ||
        typeof context.slot !== 'number' || !Number.isSafeInteger(context.slot) || context.slot < status.slot) throw new RpcEvidenceError('missing-metadata');
    if (!Object.hasOwn(status, 'err')) throw new RpcEvidenceError('missing-metadata');
    if (status.err !== null) throw new RpcEvidenceError('transaction-failed');
    if (status.confirmationStatus !== 'finalized') throw new RpcEvidenceError('not-finalized');
    const result = await this.rpc('getTransaction', [signature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 }], deadline);
    if (result === null) return null;
    const evidence = decodeTransaction(result, signature, this.chain);
    if (status.slot !== evidence.slot || status.confirmations !== null) throw new RpcEvidenceError('missing-metadata');
    return evidence;
  }
  /** Recover a lost wallet result using the SAME reference and saved message, never a new payment.
   * A bounded/incomplete scan is uncertainty, not proof that no payment happened. */
  async findByReference(order: PaidOrder, preparation: DurablePaymentPreparation): Promise<ReferencePaymentResult> {
    try { await validatePaymentPreparation(order, preparation); }
    catch { return { status: 'requires-reconciliation', reason: 'validation-rejected' }; }
    if (this.chain.network !== order.network || this.chain.genesisHash !== preparation.genesisHash) return { status: 'requires-reconciliation', reason: 'wrong-network' };
    const deadline = Date.now() + 22000, limit = 16;
    let rows: unknown;
    try {
      if (await this.rpc('getGenesisHash', [], deadline) !== this.chain.genesisHash) throw new RpcEvidenceError('wrong-network');
      rows = await this.rpc('getSignaturesForAddress', [order.reference, { commitment: 'finalized', limit }], deadline);
    } catch (error) { return { status: 'requires-reconciliation', reason: error instanceof RpcEvidenceError ? error.reason : 'rpc-unavailable' }; }
    if (!Array.isArray(rows) || rows.length > limit) return { status: 'requires-reconciliation', reason: 'rpc-malformed' };
    const candidates: { signature: string; slot: number }[] = [], seen = new Set<string>();
    try {
      for (const value of rows) {
        const row = object(value);
        if (typeof row.signature !== 'string' || typeof row.slot !== 'number' || !Number.isSafeInteger(row.slot) || row.slot < 0 || !Object.hasOwn(row, 'err')) throw new Error('malformed');
        assertBase58(row.signature, 64);
        if (seen.has(row.signature)) throw new Error('duplicate'); seen.add(row.signature);
        if (row.err !== null) continue;
        if (row.blockTime !== null && row.blockTime !== undefined) {
          if (typeof row.blockTime !== 'number' || !Number.isSafeInteger(row.blockTime) || row.blockTime < 0 || !Number.isSafeInteger(row.blockTime * 1000)) throw new Error('malformed');
          if (row.blockTime * 1000 < Math.floor(order.createdAt / 1000) * 1000 || row.blockTime * 1000 > order.expiresAt) continue;
        }
        candidates.push({ signature: row.signature, slot: row.slot });
      }
    } catch { return { status: 'requires-reconciliation', reason: 'rpc-malformed' }; }
    const matches: Extract<ReferencePaymentResult, { status: 'found' }>[] = [];
    let cursor = 0, incomplete = rows.length === limit, failure: ConstructorParameters<typeof RpcEvidenceError>[0] | undefined;
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (cursor < candidates.length) {
        const candidate = candidates[cursor++];
        try {
          const evidence = await this.read(candidate.signature, deadline);
          if (!evidence || evidence.slot !== candidate.slot) { incomplete = true; continue; }
          let payment;
          try { payment = await validatePreparedPayment(order, evidence, this.chain, preparation); }
          catch { continue; } // A different transfer mentioning the reference is not this prepared payment.
          matches.push({ status: 'found', signature: candidate.signature, evidence, payment });
        } catch (error) {
          if (error instanceof RpcEvidenceError && (error.reason === 'unsupported-transaction' || error.reason === 'transaction-failed')) continue;
          incomplete = true; failure ??= error instanceof RpcEvidenceError ? error.reason : 'rpc-unavailable';
        }
      }
    }));
    if (matches.length > 1) return { status: 'requires-reconciliation', reason: 'reference-ambiguous' };
    if (incomplete) return { status: 'requires-reconciliation', reason: failure ?? 'reference-scan-incomplete' };
    if (matches.length === 1) return matches[0];
    return { status: 'requires-reconciliation', reason: candidates.length ? 'validation-rejected' : 'not-found' };
  }
}

function retryDelay(value:string|null):number|undefined {if(value===null)return undefined;const seconds=Number(value);if(Number.isFinite(seconds)&&seconds>=0)return seconds*1000;const date=Date.parse(value);return Number.isFinite(date)?Math.max(0,date-Date.now()):undefined;}
