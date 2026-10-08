import type { JWKInterface } from "arweave/web/lib/wallet";
import type { EnvelopeV1 } from "../crypto/encrypt";
import { createArweaveClient, withArweaveHost } from "./client";
import { ARWEAVE_HOSTS } from "./gateways";

const arweave = createArweaveClient();

export type PublishResult =
  | { ok: true; txId: string }
  | { ok: false; error: string; needsFunds?: boolean };

export type PublishEnvelopeOptions = {
  /** Previous vault TX under the same Vault-Id (immutable version chain). */
  parentTxId?: string | null;
  /** ISO timestamp stamped on the TX for version lists. */
  updatedAt?: string;
};

type SignedTx = Awaited<ReturnType<ReturnType<typeof createArweaveClient>["createTransaction"]>>;

async function winstonBalance(address: string): Promise<string> {
  return withArweaveHost((client) => client.wallets.getBalance(address));
}

async function postSignedTx(tx: SignedTx): Promise<{ status: number; statusText: string }> {
  let last = { status: 0, statusText: "no gateway" };
  for (const host of ARWEAVE_HOSTS) {
    try {
      const res = await createArweaveClient(host).transactions.post(tx);
      if (res.status === 200 || res.status === 208) return res;
      last = { status: res.status, statusText: res.statusText };
    } catch {
      /* next host */
    }
  }
  return last;
}

/**
 * Publish encrypted vault envelope to Arweave.
 * Requires wallet with AR for the one-time endowment fee.
 * Each successful publish is a new immutable version (same Vault-Id).
 */
export async function publishEnvelope(
  jwk: JWKInterface,
  envelope: EnvelopeV1,
  opts?: PublishEnvelopeOptions
): Promise<PublishResult> {
  try {
    const data = JSON.stringify(envelope);
    let lastErr: unknown;
    for (const host of ARWEAVE_HOSTS) {
      try {
        const client = createArweaveClient(host);
        const tx = await client.createTransaction({ data }, jwk);
        tx.addTag("Content-Type", "application/json");
        tx.addTag("App-Name", "SEJIRE");
        tx.addTag("Protocol", "sejire/v0.3");
        tx.addTag("Type", "vault-envelope");
        tx.addTag("Vault-Id", envelope.vault_id);
        tx.addTag("Schema", envelope.schema);
        tx.addTag("Protocol-Version", envelope.protocol);
        tx.addTag("Archive-Bytes", String(new TextEncoder().encode(data).length));
        tx.addTag("Archive-SHA256", [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data)))].map(byte=>byte.toString(16).padStart(2,'0')).join(''));
        tx.addTag("Updated-At", opts?.updatedAt ?? new Date().toISOString());
        if (opts?.parentTxId) {
          tx.addTag("Parent-Tx", opts.parentTxId);
        }

        await client.transactions.sign(tx, jwk);
        const address = await client.wallets.jwkToAddress(jwk);
        const balance = await winstonBalance(address);
        const price = tx.reward;
        if (BigInt(balance) < BigInt(price)) {
          return {
            ok: false,
            needsFunds: true,
            error: `Недостаточно AR. Нужно ≈ ${client.ar.winstonToAr(price)} AR на адресе кошелька.`,
          };
        }

        const res = await postSignedTx(tx);
        if (res.status === 200 || res.status === 208) {
          return { ok: true, txId: tx.id };
        }
        lastErr = new Error(`Arweave post failed: ${res.status} ${res.statusText}`);
      } catch (e) {
        lastErr = e;
      }
    }
    return {
      ok: false,
      error: lastErr instanceof Error ? lastErr.message : String(lastErr ?? "Arweave недоступен"),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function getWalletBalanceAr(jwk: JWKInterface): Promise<string> {
  const address = await arweave.wallets.jwkToAddress(jwk);
  const winston = await winstonBalance(address);
  return arweave.ar.winstonToAr(winston);
}

export { arweave };
