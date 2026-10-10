import { assertBase58 } from '../../../../packages/checkout/order';
import type { ChainPolicy } from './paymentValidator';
import type { TrustedTransactionReader } from './reconciliation';
import { decodeTransaction, object } from './rpcDecoder';
import { RpcEvidenceError } from './rpcErrors';

export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const SERVER_RPCS = Object.freeze({ devnet: 'https://api.devnet.solana.com' });
export type ServerRpcConfig = Readonly<{ network: 'devnet'; timeoutMs?: number }>;
/** Construct only from server configuration. No browser URL/network/finality parameters.
 * This stage intentionally has no mainnet endpoint or configuration switch.
 */
export class SolanaRpcReader implements TrustedTransactionReader {
  readonly chain: ChainPolicy;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private nextId = 0;
  private readonly transport: typeof fetch;
  constructor(config: ServerRpcConfig, transport: typeof fetch = fetch) {
    this.transport = transport;
    if (config.network !== 'devnet' || Object.keys(config).some(k => k !== 'network' && k !== 'timeoutMs')) throw new Error('invalid_server_rpc_configuration');
    this.endpoint = SERVER_RPCS.devnet;
    this.chain = Object.freeze({ network: 'devnet', genesisHash: DEVNET_GENESIS });
    this.timeoutMs = config.timeoutMs ?? 10000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30000) throw new Error('invalid_rpc_timeout');
  }
  /** Server-only RPC primitive for pre-payment account checks; never forwarded from browser. */
  async rpc(method: string, params: unknown[] = []): Promise<unknown> {
    const id = ++this.nextId, controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.transport(this.endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
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
  async read(signature: string) {
    assertBase58(signature, 64);
    // Recheck genesis for every reconciliation: an endpoint/network change cannot reuse cached trust.
    if (await this.rpc('getGenesisHash') !== this.chain.genesisHash) throw new RpcEvidenceError('wrong-network');
    const statusResult = object(await this.rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]));
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
    const result = await this.rpc('getTransaction', [signature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 }]);
    if (result === null) return null;
    const evidence = decodeTransaction(result, signature, this.chain);
    if (status.slot !== evidence.slot || status.confirmations !== null) throw new RpcEvidenceError('missing-metadata');
    return evidence;
  }
}

function retryDelay(value:string|null):number|undefined {if(value===null)return undefined;const seconds=Number(value);if(Number.isFinite(seconds)&&seconds>=0)return seconds*1000;const date=Date.parse(value);return Number.isFinite(date)?Math.max(0,date-Date.now()):undefined;}
