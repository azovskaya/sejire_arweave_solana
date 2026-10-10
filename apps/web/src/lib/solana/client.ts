import type { SolanaWalletAdapter } from "@ardrive/turbo-sdk/web";
import type { EnvelopeV1 } from "../crypto/encrypt";
import { downloadJson } from "../download";
import { envelopeDigest, networkConfig, quoteCap, serializeEnvelope, solToLamports, type SolanaNetwork, type UploadQuote } from "./policy";
import type { PreservationReceipt } from "./receipt";
export type { PreservationReceipt } from "./receipt";
export { uploadWithSolana } from "./upload";

type Provider = SolanaWalletAdapter & { connect(): Promise<unknown>; isPhantom?: boolean };
type WalletWindow = Window & { phantom?: { solana?: Provider }; solflare?: Provider };
export type WalletName = "Phantom" | "Solflare";

export function configuredNetwork(): SolanaNetwork {
  const value = import.meta.env.VITE_SOLANA_NETWORK;
  if (value === "mainnet-beta") return value;
  if (value && value !== "devnet") throw new Error("invalid_network");
  return "devnet";
}

export async function connectWallet(name: WalletName): Promise<SolanaWalletAdapter> {
  const w = window as WalletWindow;
  const provider = name === "Phantom" ? w.phantom?.solana : w.solflare;
  if (!provider) throw new Error("wallet_not_found");
  await provider.connect();
  const address = provider.publicKey?.toString();
  if (!address || !provider.signMessage || !provider.signTransaction) throw new Error("unsupported_wallet");
  const { PublicKey } = await import("@solana/web3.js");
  const publicKey = new PublicKey(address);
  function checkAccount() {
    if (provider!.publicKey?.toString() !== address) throw new Error("wallet_changed");
  }
  // Clone the adapter: the SDK wraps signMessage; never mutate the wallet extension object.
  return {
    get publicKey() { checkAccount(); return publicKey; },
    signMessage: async (message) => { checkAccount(); const result = await provider.signMessage(message); checkAccount(); return result; },
    signTransaction: async (tx) => { checkAccount(); const result = await provider.signTransaction(tx); checkAccount(); return result; },
  };
}

export async function prepareQuote(envelope: EnvelopeV1, network: SolanaNetwork, address: string): Promise<UploadQuote> {
  const data = serializeEnvelope(envelope);
  const { TurboFactory } = await import("@ardrive/turbo-sdk/web");
  const client = TurboFactory.unauthenticated(networkConfig(network));
  // Include bounded ANS-104 signature/tag overhead; the actual charge can be smaller or free.
  const result = await client.getTokenPriceForBytes({ byteCount: new TextEncoder().encode(data).length + 4096 });
  if (result.token !== "solana") throw new Error("invalid_quote");
  return { network, address, digest: await envelopeDigest(data), maxLamports: quoteCap(solToLamports(result.tokenPrice)), expiresAt: Date.now() + 120_000 };
}

export function downloadReceipt(receipt: PreservationReceipt) {
  downloadJson(receipt, `sejire-receipt-${receipt.receipt.id.slice(0, 8)}.json`);
}
