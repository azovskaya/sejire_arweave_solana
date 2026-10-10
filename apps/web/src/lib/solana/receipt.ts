import type { TurboUploadDataItemResponse } from "@ardrive/turbo-sdk/web";
import { MAX_BACKUP_BYTES, parseEnvelope } from "../crypto/envelope";
import { envelopeDigest, type SolanaNetwork } from "./policy";

export type PreservationReceipt = {
  schema: "sejire/preservation-receipt/v1";
  network: SolanaNetwork;
  status: "accepted-by-turbo";
  wallet: string;
  vaultId?: string;
  envelopeSha256: string;
  acceptedAt: string;
  topUpSignature?: string;
  receipt: TurboUploadDataItemResponse;
};

export function parsePreservationReceipt(raw: unknown): PreservationReceipt {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_receipt");
  const value = raw as PreservationReceipt;
  if (value.schema !== "sejire/preservation-receipt/v1" || value.status !== "accepted-by-turbo" ||
      !["devnet", "mainnet-beta"].includes(value.network) ||
      typeof value.wallet !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.wallet) ||
      typeof value.envelopeSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.envelopeSha256) ||
      typeof value.acceptedAt !== "string" || !Number.isFinite(Date.parse(value.acceptedAt)) ||
      !value.receipt || typeof value.receipt.id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.receipt.id) ||
      (value.vaultId !== undefined && !/^[a-f0-9]{32}$/.test(value.vaultId))) {
    throw new Error("invalid_receipt");
  }
  return value;
}

/** Never navigate to a URL supplied by an imported receipt. */
export function receiptDataUrl(receipt: PreservationReceipt): string {
  const checked = parsePreservationReceipt(receipt);
  const gateway = checked.network === "devnet" ? "https://ar-io.dev" : "https://arweave.net";
  return `${gateway}/raw/${checked.receipt.id}`;
}

export async function retrieveReceiptEnvelope(receipt: PreservationReceipt, opts: {
  vaultId?: string; signal?: AbortSignal; fetcher?: typeof fetch;
} = {}) {
  parsePreservationReceipt(receipt);
  if (opts.vaultId && receipt.vaultId && opts.vaultId !== receipt.vaultId) throw new Error("Vault-Id mismatch");
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(20_000)])
    : AbortSignal.timeout(20_000);
  let response: Response;
  try {
    response = await (opts.fetcher ?? fetch)(receiptDataUrl(receipt), {
      signal, credentials: "omit", referrerPolicy: "no-referrer",
    });
  } catch {
    throw new Error("retrieval_unavailable");
  }
  if (response.status === 404 || response.status === 202) throw new Error("archive_not_available");
  if (!response.ok || !response.body) throw new Error("retrieval_unavailable");
  if (Number(response.headers.get("content-length")) > MAX_BACKUP_BYTES) {
    await response.body.cancel();
    throw new Error("envelope_too_large");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BACKUP_BYTES) { await reader.cancel(); throw new Error("envelope_too_large"); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "envelope_too_large") throw error;
    throw new Error("retrieval_unavailable");
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (await envelopeDigest(bytes) !== receipt.envelopeSha256) throw new Error("archive_integrity_mismatch");
  const data = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const envelope = parseEnvelope(JSON.parse(data));
  if ((opts.vaultId && envelope.vault_id !== opts.vaultId) ||
      (receipt.vaultId && envelope.vault_id !== receipt.vaultId)) throw new Error("Vault-Id mismatch");
  return envelope;
}
