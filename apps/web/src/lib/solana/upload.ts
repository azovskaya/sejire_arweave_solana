import type { SolanaWalletAdapter, TurboAuthenticatedClient, TurboFactory } from "@ardrive/turbo-sdk/web";
import type { EnvelopeV1 } from "../crypto/encrypt";
import { MAX_BACKUP_BYTES } from "../crypto/envelope";
import { assertQuote, envelopeDigest, envelopeTags, networkConfig, serializeEnvelope, type SolanaNetwork, type UploadQuote } from "./policy";
import { uploadJournal, withUploadLock, type UploadJournal } from "./journal";
import type { PreservationReceipt } from "./receipt";

export type UploadPhase = "signing" | "uploading" | "payment" | "checking-payment";
export type UploadInput = {
  envelope: EnvelopeV1; parentTxId?: string | null; wallet: SolanaWalletAdapter;
  quote: UploadQuote; network: SolanaNetwork; signal: AbortSignal;
  allowTopUp?: boolean; onPhase?: (phase: UploadPhase) => void;
};

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  return (error as { status?: number }).status ?? (error as { response?: { status?: number } }).response?.status;
}

/** Sign once, replay the same data item, and reconcile an existing transfer before any further funding. */
export async function uploadWithSolana(input: UploadInput, deps: {
  journal?: UploadJournal;
  factory?: Pick<typeof TurboFactory, "authenticated">;
} = {}): Promise<PreservationReceipt> {
  const data = serializeEnvelope(input.envelope);
  const digest = await envelopeDigest(data);
  const address = input.wallet.publicKey.toString();
  const walletKey = `${input.network}:${address}`;
  const journal = deps.journal ?? uploadJournal;
  function check() {
    input.signal.throwIfAborted();
    assertQuote(input.quote, { network: input.network, address: input.wallet.publicKey.toString(), digest });
  }
  check();
  return withUploadLock(walletKey, async () => {
    const key = `${walletKey}:${digest}:${input.parentTxId ?? "root"}`;
    let operation = await journal.get(key);
    if (operation?.receipt) return operation.receipt;
    const sdk = await import("@ardrive/turbo-sdk/web");
    const { DataItem } = await import("@dha-team/arbundles/web");
    const { PublicKey, SystemInstruction, SystemProgram, Transaction } = await import("@solana/web3.js");
    const { default: bs58 } = await import("bs58");
    let expectedRecipient = "";
    let expectedLamports = "";
    let paymentPromptUsed = false;
    const wallet: SolanaWalletAdapter = {
      get publicKey() { check(); return new PublicKey(address); },
      signMessage: async (message) => {
        check();
        const signature = await input.wallet.signMessage(message);
        check();
        return signature;
      },
      signTransaction: async (tx: unknown) => {
        check();
        if (!input.allowTopUp || paymentPromptUsed || !operation || !expectedRecipient || !expectedLamports) {
          throw new Error("payment_not_authorized");
        }
        if (!(tx instanceof Transaction) || tx.instructions.length !== 1 ||
            tx.feePayer?.toString() !== address || !tx.instructions[0].programId.equals(SystemProgram.programId)) {
          throw new Error("unexpected_payment_transaction");
        }
        const transfer = SystemInstruction.decodeTransfer(tx.instructions[0]);
        if (transfer.fromPubkey.toString() !== address || transfer.toPubkey.toString() !== expectedRecipient ||
            BigInt(transfer.lamports) !== BigInt(expectedLamports) || BigInt(expectedLamports) > BigInt(input.quote.maxLamports)) {
          throw new Error("unexpected_payment_transaction");
        }
        paymentPromptUsed = true;
        const message = tx.serializeMessage();
        operation.payment = { status: "signing", lamports: expectedLamports };
        await journal.put(operation); // Must succeed BEFORE opening the payment prompt.
        let signed: unknown;
        try { signed = await input.wallet.signTransaction(tx); }
        catch (e) {
          // No signed transaction was returned to the SDK, so it cannot broadcast it.
          operation.payment = undefined;
          await journal.put(operation);
          throw e;
        }
        check();
        if (!(signed instanceof Transaction) || !signed.serializeMessage().equals(message) ||
            !signed.signature || !signed.verifySignatures()) throw new Error("unexpected_payment_transaction");
        operation.payment = { status: "signed", lamports: expectedLamports, signature: bs58.encode(signed.signature) };
        await journal.put(operation); // Persist the signature BEFORE the SDK can broadcast it.
        check();
        return signed;
      },
    };
    const config = networkConfig(input.network);
    const retryConfig = { retries: 0, retryDelay: () => 0, onRetry: () => {} };
    const client: TurboAuthenticatedClient = (deps.factory ?? sdk.TurboFactory).authenticated({
      ...config, walletAdapter: wallet,
      uploadServiceConfig: { ...config.uploadServiceConfig, retryConfig },
      paymentServiceConfig: { ...config.paymentServiceConfig, retryConfig },
    });
    const phase = (value: UploadPhase) => { input.onPhase?.(value); };
    if (!operation) {
      phase("signing");
      const blob = new Blob([data], { type: "application/json" });
      const signed = await client.signer.signDataItem({
        fileStreamFactory: () => blob.stream(), fileSizeFactory: () => blob.size,
        dataItemOpts: { tags: envelopeTags(input.envelope, input.parentTxId) },
      });
      check();
      if (signed.dataItemSizeFactory() > MAX_BACKUP_BYTES) throw new Error("envelope_too_large");
      // The browser SDK returns a ReadableStream. Buffer once, then reuse exact bytes on every retry.
      const raw = new Uint8Array(await new Response(signed.dataItemStreamFactory() as ReadableStream<Uint8Array>).arrayBuffer());
      const item = new DataItem(Buffer.from(raw));
      if (!await item.isValid()) throw new Error("invalid_data_signature");
      operation = { key, walletKey, address, network: input.network, digest, envelope: input.envelope,
        parentTxId: input.parentTxId, dataItemId: item.id, signedData: new Blob([raw]), createdAt: new Date().toISOString() };
      await journal.put(operation);
    }
    const current = operation;
    async function send() {
      check(); phase("uploading");
      const receipt = await client.uploadSignedDataItem({
        dataItemStreamFactory: () => current.signedData.stream(), dataItemSizeFactory: () => current.signedData.size,
        signal: input.signal,
      });
      if (receipt.id !== current.dataItemId) throw new Error("invalid_receipt");
      const result: PreservationReceipt = { schema: "sejire/preservation-receipt/v1", network: input.network,
        status: "accepted-by-turbo", wallet: address, vaultId: input.envelope.vault_id,
        envelopeSha256: digest, acceptedAt: new Date().toISOString(), receipt,
        ...(current.payment?.signature ? { topUpSignature: current.payment.signature } : {}) };
      current.receipt = result;
      // A persistence failure after acceptance must not turn into a failed upload.
      try { await journal.put(current); } catch { /* UI also saves/downloads this receipt. */ }
      return result;
    }
    // Free allowance / existing credit is tried first, without opening any payment prompt.
    try { return await send(); }
    catch (e) { if (statusOf(e) !== 402) throw e; }

    if (current.payment?.signature) {
      phase("checking-payment"); check();
      const result = await client.submitFundTransaction({ txId: current.payment.signature });
      if (result.status !== "confirmed") throw new Error("payment_pending");
      current.payment.status = "credited";
      await journal.put(current);
      try { return await send(); }
      catch (e) { if (statusOf(e) === 402) throw new Error("payment_pending"); throw e; }
    }
    if (!input.allowTopUp) throw new Error("funding_required");
    const previous = await journal.forWallet(walletKey);
    if (previous.some((op) => op.key !== key && op.payment?.signature && !op.receipt)) {
      throw new Error("previous_payment_unresolved");
    }
    check();
    expectedRecipient = (await client.getTurboCryptoWallets()).solana;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(expectedRecipient)) throw new Error("invalid_payment_recipient");
    expectedLamports = input.quote.maxLamports;
    if (BigInt(expectedLamports) === 0n) throw new Error("funding_required");
    phase("payment");
    await client.topUpWithTokens({ tokenAmount: expectedLamports });
    if (!current.payment?.signature) throw new Error("payment_pending");
    phase("checking-payment"); check();
    const credited = await client.submitFundTransaction({ txId: current.payment.signature });
    if (credited.status !== "confirmed") throw new Error("payment_pending");
    current.payment.status = "credited";
    await journal.put(current);
    return send();
  });
}
