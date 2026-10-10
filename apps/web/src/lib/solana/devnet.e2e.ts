/** Explicit opt-in network test: disposable signer, synthetic vault, no SOL transfers. */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { disposableWallet, preservationFixture } from "./fixture.selftest";
import { prepareQuote } from "./client";
import { uploadWithSolana } from "./upload";
import { retrieveReceiptEnvelope } from "./receipt";
import { openEnvelope } from "../crypto/vault";
import { parsePortableBackup } from "../crypto/backup";
import { createUploadJournal } from "./journal";

if (process.env.SEJIRE_LIVE_DEVNET !== "1") throw new Error("Set SEJIRE_LIVE_DEVNET=1 to send synthetic encrypted data to the public test service");
// Optional public test vector makes the synthetic archive reproducible in UI QA.
// Never use this vector for personal data or an actual wallet.
const publicWords = process.env.SEJIRE_PUBLIC_FIXTURE === "1"
  ? "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" : undefined;
const { keys, vault, envelope } = await preservationFixture(publicWords);
const { wallet, counts } = disposableWallet();
// Belt and braces: this test may sign a data item but can never sign a transfer.
wallet.signTransaction = async () => { throw new Error("SOL transfers disabled in live smoke test"); };
const quote = await prepareQuote(envelope, "devnet", wallet.publicKey.toString());
const input = { envelope, wallet, quote, network: "devnet" as const, allowTopUp: false, signal: AbortSignal.timeout(60_000) };
const receipt = await uploadWithSolana(input);
const reloadedJournal = createUploadJournal();
const reloaded = await uploadWithSolana(input, { journal: reloadedJournal });
assert.deepEqual(reloaded, receipt); assert.equal(counts.messages, 1); assert.equal(counts.transactions, 0);
// Simulate a lost acceptance response: retain signed bytes but not the receipt.
// This really POSTs the same item again; it must not re-sign or fund a new item.
const replayed = await uploadWithSolana(input, { journal: {
  ...reloadedJournal,
  get: async key => {
    const operation = await reloadedJournal.get(key);
    return operation ? { ...operation, receipt: undefined } : undefined;
  },
} });
assert.equal(replayed.receipt.id, receipt.receipt.id);
assert.equal(counts.messages, 1); assert.equal(counts.transactions, 0);
const imported = parsePortableBackup(JSON.stringify(receipt));
assert.equal(imported.kind, "receipt");
if (imported.kind !== "receipt") throw new Error("receipt expected");
// Retry visibility only. Never re-upload or pay because a gateway is delayed.
let downloaded;
for (let attempt = 0; attempt < 6; attempt++) {
  try { downloaded = await retrieveReceiptEnvelope(imported.receipt, { vaultId: keys.vaultId }); break; }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "archive_not_available" || attempt === 5) throw error;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}
assert(downloaded);
assert.deepEqual(await openEnvelope(keys, downloaded), vault);
console.log(JSON.stringify({
  result: "PASS", checkedAt: new Date().toISOString(), network: "devnet", walletKind: "disposable software signer (NOT Phantom/Solflare extension)",
  checks: ["real SDK signature", "live Turbo acceptance", "receipt import", "durable receipt replay", "live duplicate POST reuses the same item ID without re-signing or payment", "live gateway retrieval", "SHA-256", "AES-GCM decrypt", "full two-tree vault with relationships and history"],
  messageSignatures: counts.messages, solTransfers: counts.transactions, treeCount: Object.keys(vault.trees).length, receipt,
  ...(publicWords ? { publicTestWords: publicWords, warning: "PUBLIC TEST VECTOR — synthetic data only, never reuse for a wallet or personal archive" } : {}),
}, null, 2));
