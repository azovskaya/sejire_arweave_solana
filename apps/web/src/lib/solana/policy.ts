import type { EnvelopeV1 } from "../crypto/encrypt";
export { serializeEnvelope } from "../crypto/envelope";

export type SolanaNetwork = "devnet" | "mainnet-beta";
export type UploadQuote = {
  network: SolanaNetwork;
  address: string;
  digest: string;
  maxLamports: string;
  expiresAt: number;
};

export function networkConfig(network: SolanaNetwork) {
  if (network !== "devnet" && network !== "mainnet-beta") throw new Error("invalid_network");
  const live = network === "mainnet-beta";
  return {
    token: "solana" as const,
    gatewayUrl: live ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com",
    paymentServiceConfig: { url: live ? "https://payment.ardrive.io" : "https://payment.services.ar-io.dev" },
    uploadServiceConfig: { url: live ? "https://upload.ardrive.io" : "https://upload.services.ar-io.dev" },
  };
}

export async function envelopeDigest(data: string | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data));
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}

/** Turbo's getTokenPriceForBytes returns whole SOL as a decimal string. */
export function solToLamports(sol: string): string {
  if (!/^\d+(?:\.\d{1,9})?$/.test(sol)) throw new Error("invalid_quote");
  const [whole, fraction = ""] = sol.split(".");
  return (BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"))).toString();
}

export function quoteCap(rawLamports: string): string {
  if (!/^\d+$/.test(rawLamports)) throw new Error("invalid_quote");
  // Explicit upper bound, including a 10% quote movement allowance. No floating point money.
  const cap = (BigInt(rawLamports) * 110n + 99n) / 100n;
  if (cap > 10_000_000n) throw new Error("quote_over_safety_limit"); // 0.01 SOL
  return cap.toString();
}

export function formatSol(lamports: string): string {
  if (!/^\d+$/.test(lamports)) throw new Error("invalid_amount");
  const amount = BigInt(lamports);
  const fraction = (amount % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${amount / 1_000_000_000n}${fraction ? `.${fraction}` : ""}`;
}

export function assertQuote(quote: UploadQuote, input: {
  network: SolanaNetwork; address: string; digest: string; now?: number;
}) {
  if (quote.network !== input.network) throw new Error("network_changed");
  if (quote.address !== input.address) throw new Error("wallet_changed");
  if (quote.digest !== input.digest) throw new Error("envelope_changed");
  if (!Number.isFinite(quote.expiresAt) || quote.expiresAt <= (input.now ?? Date.now())) throw new Error("quote_expired");
  if (!/^\d+$/.test(quote.maxLamports) || BigInt(quote.maxLamports) > 10_000_000n) throw new Error("invalid_quote");
}

export function envelopeTags(envelope: EnvelopeV1, parentTxId?: string | null) {
  if (parentTxId && !/^[A-Za-z0-9_-]{43}$/.test(parentTxId)) throw new Error("invalid_parent");
  return [
    { name: "Content-Type", value: "application/json" },
    { name: "App-Name", value: "SEJIRE" },
    { name: "Protocol", value: "sejire/v0.3" },
    { name: "Type", value: "vault-envelope" },
    { name: "Vault-Id", value: envelope.vault_id },
    { name: "Schema", value: envelope.schema },
    { name: "Updated-At", value: new Date().toISOString() },
    ...(parentTxId ? [{ name: "Parent-Tx", value: parentTxId }] : []),
  ];
}
