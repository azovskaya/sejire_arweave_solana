import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { TurboFactory, type SolanaWalletAdapter } from "@ardrive/turbo-sdk/web";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { DataItem } from "@dha-team/arbundles/web";
import { createUploadJournal, withUploadLock, type UploadJournal } from "./journal";
import { uploadWithSolana, type UploadInput } from "./upload";
import { envelopeDigest, serializeEnvelope } from "./policy";
import { disposableWallet, preservationFixture } from "./fixture.selftest";

const { envelope } = await preservationFixture();
const digest = await envelopeDigest(serializeEnvelope(envelope));
const journal = createUploadJournal();
const recipient = Keypair.generate().publicKey;
const denied = () => Object.assign(new Error("Insufficient balance"), { status: 402 });
let passed = 0;
async function test(name: string, run: () => Promise<void>) { await run(); passed++; console.log(`OK ${name}`); }

function scenario(options: { failures?: number; lostResponse?: boolean; pending?: boolean; badRecipient?: boolean; badReceipt?: boolean } = {}) {
  const { wallet, counts } = disposableWallet();
  const input: UploadInput = { envelope, wallet, network: "devnet", signal: new AbortController().signal,
    quote: { network: "devnet", address: wallet.publicKey.toString(), digest, maxLamports: "10000", expiresAt: Date.now() + 120_000 } };
  const calls = { uploads: 0, topups: 0, submits: 0, signedBytes: [] as Buffer[] };
  let captured: SolanaWalletAdapter;
  const factory: Pick<typeof TurboFactory, "authenticated"> = {
    authenticated(config) {
      const client = TurboFactory.authenticated(config);
      if (!("walletAdapter" in config)) throw new Error("adapter missing");
      captured = config.walletAdapter as SolanaWalletAdapter;
      client.uploadSignedDataItem = async (p) => {
        calls.uploads++;
        const bytes = Buffer.from(await new Response(p.dataItemStreamFactory() as ReadableStream<Uint8Array>).arrayBuffer());
        calls.signedBytes.push(bytes);
        const item = new DataItem(bytes);
        assert.equal(await item.isValid(), true);
        if (calls.uploads <= (options.failures ?? 0)) throw denied();
        if (options.lostResponse && calls.uploads === 1) throw new Error("connection lost after server acceptance");
        return { id: options.badReceipt ? "x".repeat(43) : item.id, owner: item.owner, winc: "0", dataCaches: [], fastFinalityIndexes: [] };
      };
      client.getTurboCryptoWallets = async () => ({ solana: recipient.toString() }) as Awaited<ReturnType<typeof client.getTurboCryptoWallets>>;
      client.topUpWithTokens = async () => {
        calls.topups++;
        const tx = new Transaction({ feePayer: new PublicKey(input.wallet.publicKey.toString()), recentBlockhash: Keypair.generate().publicKey.toString() });
        tx.add(SystemProgram.transfer({ fromPubkey: tx.feePayer!, toPubkey: options.badRecipient ? Keypair.generate().publicKey : recipient, lamports: 10000 }));
        await captured.signTransaction(tx);
        const saved = await journal.forWallet(`devnet:${input.wallet.publicKey.toString()}`);
        assert(saved[0].payment?.signature, "signature is durable before broadcast");
        if (options.pending) throw new Error("lost broadcast response");
        return {} as Awaited<ReturnType<typeof client.topUpWithTokens>>;
      };
      client.submitFundTransaction = async () => { calls.submits++; return { status: "confirmed" } as Awaited<ReturnType<typeof client.submitFundTransaction>>; };
      return client;
    },
  };
  return { input, counts, calls, factory, run: (store: UploadJournal = journal) => uploadWithSolana(input, { factory, journal: store }) };
}

await test("free upload signs only once; durable receipt survives a new journal instance", async () => {
  const s = scenario(); const receipt = await s.run();
  assert.equal(receipt.envelopeSha256, digest); assert.equal(s.counts.messages, 1); assert.equal(s.counts.transactions, 0);
  assert.deepEqual(await s.run(createUploadJournal()), receipt); assert.equal(s.calls.uploads, 1);
});
await test("402 cannot trigger an unauthorized payment", async () => {
  const s = scenario({ failures: 10 }); await assert.rejects(s.run, /funding_required/);
  assert.equal(s.calls.topups, 0); assert.equal(s.counts.transactions, 0);
});
await test("authorized top-up signs exactly one verified transfer", async () => {
  const s = scenario({ failures: 1 }); s.input.allowTopUp = true;
  const receipt = await s.run(); assert(receipt.topUpSignature);
  assert.equal(s.counts.transactions, 1); assert.equal(s.calls.topups, 1); assert.equal(s.calls.submits, 1);
  assert.deepEqual(s.calls.signedBytes[0], s.calls.signedBytes[1]);
});
await test("dropped response replays exact data-item bytes, without another signature", async () => {
  const s = scenario({ lostResponse: true }); await assert.rejects(s.run, /connection lost/);
  await s.run(createUploadJournal()); assert.equal(s.counts.messages, 1);
  assert.deepEqual(s.calls.signedBytes[0], s.calls.signedBytes[1]);
});
await test("lost payment response reconciles the stored transfer; never double-pays", async () => {
  const s = scenario({ failures: 2, pending: true }); s.input.allowTopUp = true;
  await assert.rejects(s.run, /lost broadcast/);
  s.input.allowTopUp = false;
  const receipt = await s.run(createUploadJournal()); assert(receipt.topUpSignature);
  assert.equal(s.calls.topups, 1); assert.equal(s.counts.transactions, 1); assert.equal(s.calls.submits, 1);
});
await test("a credited but still insufficient payment is not sent again", async () => {
  const s = scenario({ failures: 20 }); s.input.allowTopUp = true;
  await assert.rejects(s.run); await assert.rejects(s.run, /payment_pending/);
  assert.equal(s.calls.topups, 1); assert.equal(s.counts.transactions, 1);
});
await test("SDK transaction to an unexpected recipient is rejected before wallet prompt", async () => {
  const s = scenario({ failures: 1, badRecipient: true }); s.input.allowTopUp = true;
  await assert.rejects(s.run, /unexpected_payment_transaction/); assert.equal(s.counts.transactions, 0);
});
await test("rejected message signature cannot upload or pay", async () => {
  const s = scenario(); s.input.wallet.signMessage = async () => { throw new Error("User rejected"); };
  await assert.rejects(s.run, /reject/i); assert.equal(s.calls.uploads, 0); assert.equal(s.calls.topups, 0);
});
await test("account change while message prompt is open stops submission", async () => {
  const s = scenario(); const original = s.input.wallet.signMessage;
  s.input.wallet.signMessage = async m => { const sig = await original(m); s.input.wallet.publicKey = Keypair.generate().publicKey; return sig; };
  await assert.rejects(s.run, /wallet_changed/); assert.equal(s.calls.uploads, 0);
});
await test("abort while signature prompt is open stops submission", async () => {
  const s = scenario(); const ctrl = new AbortController(); s.input.signal = ctrl.signal;
  const original = s.input.wallet.signMessage; s.input.wallet.signMessage = async m => { const sig = await original(m); ctrl.abort(); return sig; };
  await assert.rejects(s.run, /abort/i); assert.equal(s.calls.uploads, 0);
});
await test("expired or mismatched quote requests no signature", async () => {
  const s = scenario(); s.input.quote.expiresAt = 0; await assert.rejects(s.run, /quote_expired/);
  s.input.quote.expiresAt = Date.now() + 10000; s.input.quote.digest = "0".repeat(64);
  await assert.rejects(s.run, /envelope_changed/); assert.equal(s.counts.messages, 0);
});
await test("storage failure prevents upload and payment", async () => {
  const s = scenario(); await assert.rejects(() => s.run({ ...journal, put: async () => { throw new Error("journal_unavailable"); } }), /journal_unavailable/);
  assert.equal(s.calls.uploads, 0); assert.equal(s.calls.topups, 0);
});
await test("payment journal failure prevents the transaction prompt", async () => {
  const s = scenario({ failures: 1 }); s.input.allowTopUp = true;
  await assert.rejects(() => s.run({ ...journal, put: async op => {
    if (op.payment) throw new Error("journal_unavailable");
    await journal.put(op);
  } }), /journal_unavailable/);
  assert.equal(s.counts.transactions, 0);
});
await test("rejected payment may be retried because no signed transaction escaped", async () => {
  const s = scenario({ failures: 2 }); s.input.allowTopUp = true;
  const sign = s.input.wallet.signTransaction;
  s.input.wallet.signTransaction = async () => { throw new Error("User rejected"); };
  await assert.rejects(s.run, /User rejected/);
  s.input.wallet.signTransaction = sign;
  await s.run(); assert.equal(s.counts.transactions, 1);
});
await test("changed transaction returned by wallet is rejected before broadcast", async () => {
  const s = scenario({ failures: 1 }); s.input.allowTopUp = true;
  const sign = s.input.wallet.signTransaction;
  s.input.wallet.signTransaction = async tx => {
    (tx as Transaction).instructions.push(SystemProgram.transfer({
      fromPubkey: new PublicKey(s.input.wallet.publicKey.toString()), toPubkey: recipient, lamports: 1,
    }));
    return sign(tx);
  };
  await assert.rejects(s.run, /unexpected_payment_transaction/);
  assert.equal(s.calls.submits, 0);
});
await test("abort during payment signature cannot broadcast", async () => {
  const s = scenario({ failures: 1 }); s.input.allowTopUp = true;
  const ctrl = new AbortController(); s.input.signal = ctrl.signal;
  const sign = s.input.wallet.signTransaction;
  s.input.wallet.signTransaction = async tx => { const signed = await sign(tx); ctrl.abort(); return signed; };
  await assert.rejects(s.run, /abort/i); assert.equal(s.calls.submits, 0);
});
await test("unresolved payment blocks funding a different snapshot", async () => {
  const s = scenario({ failures: 20, pending: true }); s.input.allowTopUp = true;
  await assert.rejects(s.run, /lost broadcast/);
  s.input.envelope = (await preservationFixture()).envelope;
  s.input.quote.digest = await envelopeDigest(serializeEnvelope(s.input.envelope));
  await assert.rejects(s.run, /previous_payment_unresolved/);
  assert.equal(s.calls.topups, 1); assert.equal(s.counts.transactions, 1);
});
await test("persistence failure after acceptance still returns the successful receipt", async () => {
  const s = scenario(); const receipt = await s.run({ ...journal, put: async op => {
    if (op.receipt) throw new Error("journal_unavailable"); await journal.put(op);
  } });
  assert.equal(receipt.status, 'accepted-by-turbo'); assert.equal(s.calls.topups, 0);
});
await test("receipt must identify exactly the signed item", async () => {
  const s = scenario({ badReceipt: true }); await assert.rejects(s.run, /invalid_receipt/);
});
await test("concurrent attempts are excluded and the lock is released", async () => {
  await withUploadLock("test-wallet", async () => { await assert.rejects(() => withUploadLock("test-wallet", async () => {}), /upload_in_progress/); });
  await withUploadLock("test-wallet", async () => {});
});
console.log(`solana.upload.selftest: ${passed} scenarios passed; real SDK signatures, mocked service responses`);
