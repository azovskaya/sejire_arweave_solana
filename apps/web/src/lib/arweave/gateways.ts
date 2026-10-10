/**
 * Public Arweave gateways. Kazakhstan and some office networks block a single
 * host; restore/publish must walk the list instead of dying on arweave.net.
 */

export const GRAPHQL_ENDPOINTS = [
  "https://arweave.net/graphql",
  "https://arweave-search.goldsky.com/graphql",
  "https://ar-io.dev/graphql",
] as const;

export const DATA_GATEWAYS = [
  "https://arweave.net",
  "https://ar-io.net",
  "https://g8way.io",
] as const;

/** Hosts for the official `arweave` JS client (create / sign / post / balance). */
export const ARWEAVE_HOSTS = ["arweave.net", "ar-io.net", "g8way.io"] as const;

export const GATEWAY_TIMEOUT_MS = 12_000;

export const GATEWAY_DOWN_RU =
  "Сеть Arweave недоступна (шлюзы не ответили). Проверьте интернет и попробуйте снова.";

export class GatewayUnavailableError extends Error {
  readonly lastStatus: number | null;
  constructor(message = GATEWAY_DOWN_RU, lastStatus: number | null = null) {
    super(message);
    this.name = "GatewayUnavailableError";
    this.lastStatus = lastStatus;
  }
}

export class RawEnvelopeMismatchError extends Error {
  constructor() {
    super("Архив в Arweave повреждён или не соответствует формату SEJIRE.");
    this.name = "RawEnvelopeMismatchError";
  }
}

export function isGatewayUnavailable(e: unknown): boolean {
  return e instanceof GatewayUnavailableError;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  ms = GATEWAY_TIMEOUT_MS
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

type GqlBody<T> = { data?: T; errors?: unknown };

/**
 * POST GraphQL to the first gateway that returns `data` without `errors`.
 * Empty `edges` is success (vault simply has no versions).
 */
export async function graphqlQuery<T>(
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  let lastStatus: number | null = null;
  for (const url of GRAPHQL_ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      lastStatus = res.status;
      if (!res.ok) continue;
      const body = (await res.json()) as GqlBody<T>;
      if (body.errors || body.data == null) continue;
      return body.data;
    } catch {
      /* timeout, DNS, CORS — try the next host */
    }
  }
  throw new GatewayUnavailableError(GATEWAY_DOWN_RU, lastStatus);
}

/** Only unanimous 404 means absent. Raw payloads are bounded and parsed as envelopes. */
export async function fetchTxJson(
  txId: string,
  expected?: { bytes: number; sha256: string },
): Promise<EnvelopeV1 | null> {
  const id = encodeURIComponent(txId);
  let failed = false;
  let malformed = false;
  let lastStatus: number | null = null;
  for (const base of DATA_GATEWAYS) {
    try {
      const res = await fetch(`${base}/raw/${id}`, {
        credentials: "omit", referrerPolicy: "no-referrer", redirect: "follow",
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
      lastStatus = res.status;
      if (res.status === 404) continue;
      if (res.status === 202) { failed = true; continue; }
      if (!res.ok) { failed = true; continue; }
      if (!res.body) { malformed = true; continue; }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.length;
          if (length > MAX_BACKUP_BYTES) { await reader.cancel(); throw new RawEnvelopeMismatchError(); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      if (expected) {
        if (length !== expected.bytes) { malformed = true; continue; }
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
        const digest = [...hash].map((part) => part.toString(16).padStart(2, "0")).join("");
        if (digest !== expected.sha256) { malformed = true; continue; }
      }
      try { return parseEnvelope(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
      catch { malformed = true; }
    } catch (error) {
      if (error instanceof RawEnvelopeMismatchError) malformed = true;
      else failed = true;
    }
  }
  if (malformed) throw new RawEnvelopeMismatchError();
  if (failed) throw new GatewayUnavailableError(GATEWAY_DOWN_RU, lastStatus);
  return null;
}
import { MAX_BACKUP_BYTES, parseEnvelope } from "../crypto/envelope";
import type { EnvelopeV1 } from "../crypto/encrypt";
