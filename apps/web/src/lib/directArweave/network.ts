import { DirectError, directErrorCode, requireDirect } from './errors';
import { ID, MAX_BACKUP_BYTES, sha256, winston } from './format';
import type { DirectOptions, DirectQuote } from './types';
import { directNode, readDirectNodePreference } from './nodePreference';
export { directNode } from './nodePreference';

// Both expose the native Arweave API. This is not the optional Turbo bundler API.
// Defaults are replaceable; readiness and independent operators are separate facts.
export const DEFAULT_DIRECT_NODES = ['https://arweave.net', 'https://turbo-gateway.com'] as const;
const RATE_LIMIT = new Map<string, number>();
const REQUEST_TIMEOUT_MS = 8_000;
export function directNodes(options: DirectOptions = {}): string[] {
  const preference = options.nodes === undefined ? readDirectNodePreference() : null;
  const supplied = options.nodes ?? (preference ? [preference] : DEFAULT_DIRECT_NODES);
  requireDirect(Array.isArray(supplied) && supplied.length > 0 && supplied.length <= 6, 'invalid_node');
  return [...new Set(supplied.map(directNode))];
}
export function active(signal?: AbortSignal) { requireDirect(!signal?.aborted, 'operation_cancelled'); }
export async function scoped<T>(options: DirectOptions, action: (options: DirectOptions) => Promise<T>, ms = 45_000): Promise<T> {
  active(options.signal);
  const controller = new AbortController(), abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, ms);
  try { return await action({ ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
export async function nodeRequest(node: string, path: string, options: { signal?: AbortSignal; body?: string; maxBytes?: number; readOnlyQuery?: boolean } = {}) {
  node = directNode(node); active(options.signal);
  requireDirect((RATE_LIMIT.get(node) ?? 0) <= Date.now(), 'network_rate_limited');
  requireDirect(path.startsWith('/') && !path.startsWith('//'), 'invalid_node');
  requireDirect(!options.readOnlyQuery || path === '/graphql' && options.body !== undefined, 'invalid_node');
  const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectAborted: (error: DirectError) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const abort = () => { controller.abort(); void reader?.cancel().catch(() => {}); rejectAborted(new DirectError('operation_cancelled')); };
  const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
  options.signal?.addEventListener('abort', abort, { once: true });
  const read = async () => {
    const response = await fetch(node + path, {
      method: options.body === undefined ? 'GET' : 'POST', credentials: 'omit', referrerPolicy: 'no-referrer',
      redirect: 'error', cache: 'no-store', signal: controller.signal,
      ...(options.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: options.body }),
    });
    active(controller.signal);
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      RATE_LIMIT.set(node, Date.now() + (Number.isFinite(seconds) ? Math.max(30, Math.min(120, seconds)) : 30) * 1000);
      void response.body?.cancel().catch(() => {}); throw new DirectError('network_rate_limited');
    }
    // Error pages and write acknowledgements are not archive bytes. In particular,
    // a large HTML 404 must remain "unavailable", not a false integrity failure.
    if (options.body !== undefined && !options.readOnlyQuery || response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      return { status: response.status, bytes: new Uint8Array(), text: '' };
    }
    const maximum = options.maxBytes ?? 16_384, declared = response.headers.get('content-length');
    if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > maximum)) {
      // Reject before acquiring a reader, but still close the unread body.
      // Otherwise an oversized response can outlive this bounded request.
      void response.body?.cancel().catch(() => {});
      throw new DirectError('archive_integrity_failed');
    }
    const chunks: Uint8Array[] = []; let length = 0;
    if (response.body) {
      reader = response.body.getReader();
      try {
        for (;;) {
          active(controller.signal); const next = await reader.read(); active(controller.signal); if (next.done) break;
          length += next.value.length; requireDirect(length <= maximum, 'archive_integrity_failed'); chunks.push(next.value);
        }
      } catch (error) { void reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { status: response.status, bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  };
  try { return await Promise.race([read(), aborted]); }
  catch (error) { throw error instanceof DirectError ? error : new DirectError('network_unavailable'); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
export async function assertDirectNetwork(node: string, signal?: AbortSignal) {
  const info = await nodeRequest(node, '/info', { signal });
  requireDirect(info.status === 200, 'network_unavailable');
  let parsed: { network?: string };
  try { parsed = JSON.parse(info.text); } catch { throw new DirectError('network_unavailable'); }
  requireDirect(parsed.network === 'arweave.N.1', 'wrong_network');
}
export async function fetchDirectQuote(address: string, bytes: number, options: DirectOptions = {}): Promise<DirectQuote> {
  requireDirect(ID.test(address), 'wallet_changed');
  requireDirect(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= MAX_BACKUP_BYTES, 'invalid_archive');
  let last = new DirectError('network_unavailable');
  for (const node of directNodes(options)) {
    active(options.signal);
    try {
      await assertDirectNetwork(node, options.signal);
      const [price, balance] = await Promise.all([
        nodeRequest(node, `/price/${bytes}`, { signal: options.signal, maxBytes: 128 }),
        nodeRequest(node, `/wallet/${address}/balance`, { signal: options.signal, maxBytes: 128 }),
      ]);
      requireDirect(price.status === 200 && balance.status === 200, 'network_unavailable');
      const rewardWinston = price.text.trim(), balanceWinston = balance.text.trim();
      requireDirect(winston(rewardWinston) > 0n && winston(balanceWinston) >= 0n, 'invalid_reward');
      return { ownerAddress: address, bytes, rewardWinston, balanceWinston, node, quotedAt: Date.now() };
    } catch (error) { last = new DirectError(directErrorCode(error)); }
  }
  active(options.signal); throw last;
}
export async function fetchArchiveBytes(transactionId: string, expected: { bytes: number; sha256: string }, options: DirectOptions = {}) {
  requireDirect(ID.test(transactionId), 'invalid_operation');
  let integrity = false, last = new DirectError('archive_unavailable');
  for (const node of directNodes(options)) {
    const routes: [string, boolean][] = [[`/raw/${transactionId}`, false], [`/${transactionId}`, false], [`/tx/${transactionId}/data`, true]];
    for (const [path, encoded] of routes) {
      active(options.signal);
      try {
        const response = await nodeRequest(node, path, { signal: options.signal,
          maxBytes: encoded ? Math.ceil(expected.bytes * 4 / 3) + 4 : expected.bytes });
        requireDirect(response.status === 200 && response.bytes.length > 0, 'archive_unavailable');
        let bytes = response.bytes;
        if (encoded) {
          const value = response.text.trim(); requireDirect(/^[A-Za-z0-9_-]+$/.test(value), 'archive_integrity_failed');
          try {
            const base = value.replace(/-/g, '+').replace(/_/g, '/');
            bytes = Uint8Array.from(atob(base.padEnd(Math.ceil(base.length / 4) * 4, '=')), char => char.charCodeAt(0));
          } catch { throw new DirectError('archive_integrity_failed'); }
        }
        requireDirect(bytes.length === expected.bytes && await sha256(bytes) === expected.sha256, 'archive_integrity_failed');
        return { bytes, node };
      } catch (error) {
        const code = directErrorCode(error, 'archive_unavailable');
        integrity ||= code === 'archive_integrity_failed'; last = new DirectError(code);
        if (code === 'network_rate_limited') break;
      }
    }
  }
  active(options.signal); throw integrity ? new DirectError('archive_integrity_failed') : last;
}
