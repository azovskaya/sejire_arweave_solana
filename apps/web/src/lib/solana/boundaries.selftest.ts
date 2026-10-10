// Offline regression coverage: synthetic data, fake IndexedDB, injected fetchers; no payments or network requests.
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { solToLamports, formatSol, quoteCap, assertQuote, envelopeDigest, networkConfig } from "./policy";
import { parsePortableBackup } from "../crypto/backup";
import { encryptJson, decryptJson, type EnvelopeV1 } from "../crypto/encrypt";
import { parseEnvelope } from "../crypto/envelope";
import { parsePreservationReceipt, receiptDataUrl, retrieveReceiptEnvelope, type PreservationReceipt } from "./receipt";
import { createUploadJournal, withUploadLock } from "./journal";

const checks: Record<string, number> = {};
let seed = 20260929;
for (let i = 0; i < 10_000; i++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const value = BigInt(seed) * 100_000_000_000n + BigInt(i);
  assert.equal(solToLamports(formatSol(value.toString())), value.toString());
  const raw = BigInt(seed % 9_000_001);
  assert.equal(BigInt(quoteCap(raw.toString())), (raw * 110n + 99n) / 100n);
}
checks.moneyRoundtripAndIntegerRoundingCases = 10_000;
assert.equal(quoteCap("9090909"), "10000000");
assert.throws(() => quoteCap("9090910"), /quote_over_safety_limit/);
for (const invalid of ["", "-1", "+1", "0x01", "1e9", "1,0", "0.0000000001", "NaN", "Infinity", " 1", "1 "]) {
  assert.throws(() => solToLamports(invalid));
}
const quote = { network: "devnet" as const, address: "test", digest: "hash", maxLamports: "10000000", expiresAt: 100 };
assert.doesNotThrow(() => assertQuote(quote, { ...quote, now: 99 }));
assert.throws(() => assertQuote(quote, { ...quote, now: 100 }), /quote_expired/);
assert.throws(() => assertQuote({ ...quote, maxLamports: "10000001" }, { ...quote, now: 99 }), /invalid_quote/);
checks.quoteBoundaryAndInvalidDecimalCases = 16;

const key = crypto.getRandomValues(new Uint8Array(32));
const payload = { synthetic: true, names: ["Әже", "Дедушка", "Synthetic child"], note: "Unicode 👨‍👩‍👧‍👦\n\"<script>not executable</script>\"", value: 0, empty: null };
const ivs = new Set<string>();
let envelope: EnvelopeV1 | undefined;
for (let i = 0; i < 32; i++) {
  envelope = await encryptJson(key, "a".repeat(32), payload);
  assert(!ivs.has(envelope.iv)); ivs.add(envelope.iv);
  assert.deepEqual(await decryptJson(key, parseEnvelope(envelope)), payload);
  assert.equal(parsePortableBackup(JSON.stringify(envelope)).kind, "vault");
}
assert(envelope);
checks.unicodeEncryptionUniqueIvRoundtrips = 32;
for (let i = 0; i < 12; i++) {
  const bytes = Buffer.from(envelope.ciphertext, "base64");
  bytes[Math.floor(i * (bytes.length - 1) / 11)] ^= 1;
  await assert.rejects(() => decryptJson(key, { ...envelope!, ciphertext: bytes.toString("base64") }));
}
const wrongKey = new Uint8Array(key); wrongKey[0] ^= 1;
await assert.rejects(() => decryptJson(wrongKey, envelope!));
checks.authenticatedTamperingAndWrongKeyCases = 13;

const receipt: PreservationReceipt = {
  schema: "sejire/preservation-receipt/v1", status: "accepted-by-turbo", network: "devnet",
  wallet: "11111111111111111111111111111111", vaultId: envelope.vault_id,
  envelopeSha256: "0".repeat(64), acceptedAt: "2026-09-29T00:00:00.000Z",
  receipt: { id: "a".repeat(43), owner: "synthetic", winc: "0", dataCaches: [], fastFinalityIndexes: [] },
};
const envelopeText = JSON.stringify(envelope);
const checkedReceipt = { ...receipt, vaultId: envelope.vault_id, envelopeSha256: await envelopeDigest(envelopeText) };
for (const status of [400, 401, 403, 408, 429, 500, 502, 503, 504]) {
  await assert.rejects(() => retrieveReceiptEnvelope(checkedReceipt, { fetcher: async () => new Response("unavailable", { status }) }), /retrieval_unavailable/);
}
for (const status of [202, 404]) {
  await assert.rejects(() => retrieveReceiptEnvelope(checkedReceipt, { fetcher: async () => new Response(null, { status }) }), /archive_not_available/);
}
let abortedBySignal = false;
await assert.rejects(() => retrieveReceiptEnvelope(checkedReceipt, { signal: AbortSignal.timeout(10), fetcher: async (_url, opts) => new Promise((_resolve, reject) => {
  const guard = setTimeout(() => reject(new Error("guard")), 1000);
  const abort = () => { abortedBySignal = true; clearTimeout(guard); reject(new Error("aborted")); };
  opts!.signal!.addEventListener("abort", abort, { once: true });
  if (opts!.signal!.aborted) abort();
}) }), /retrieval_unavailable/);
assert(abortedBySignal, "the caller abort signal reached the fetcher, not just the test guard");
checks.httpFailureAndAbortCases = 12;

for (const extra of ["https://evil.invalid/archive", "http://localhost/private", "file:///private", "javascript:alert(1)"]) {
  const hostile = { ...checkedReceipt, url: extra, gatewayUrl: extra, receipt: { ...checkedReceipt.receipt, dataCaches: [extra] } };
  assert.equal(receiptDataUrl(hostile), `https://ar-io.dev/raw/${receipt.receipt.id}`);
  let calls = 0;
  const restored = await retrieveReceiptEnvelope(hostile, { fetcher: async (url, opts) => {
    calls++; assert.equal(url, `https://ar-io.dev/raw/${receipt.receipt.id}`);
    assert.equal(opts!.credentials, "omit"); assert.equal(opts!.referrerPolicy, "no-referrer");
    return new Response(envelopeText);
  } });
  assert.equal(calls, 1); assert.deepEqual(restored, envelope);
}
checks.untrustedReceiptUrlIsolationCases = 4;
for (const raw of [null, [], true, 1, "", {}, { ...receipt, network: "testnet" }, { ...receipt, network: "devnet/../mainnet" }, { ...receipt, receipt: { id: "../../etc/passwd" } }]) {
  assert.throws(() => parsePreservationReceipt(raw));
}
for (const net of ["", "testnet", "mainnet", "Devnet", "https://evil.invalid"] ) assert.throws(() => networkConfig(net as never));
checks.invalidReceiptAndNetworkCases = 14;

const journal = createUploadJournal();
await Promise.all(Array.from({ length: 50 }, async (_, i) => {
  const network = i % 2 ? "devnet" as const : "mainnet-beta" as const;
  await journal.put({ key: `${network}:synthetic:${i}`, walletKey: `${network}:synthetic`, address: "synthetic", network,
    digest: `digest-${i}`, envelope: envelope!, dataItemId: `item-${i}`, signedData: new Blob([`signed-ciphertext-${i}`]), createdAt: new Date().toISOString() });
}));
const reloaded = createUploadJournal();
for (const network of ["devnet", "mainnet-beta"]) {
  const entries = await reloaded.forWallet(`${network}:synthetic`);
  assert.equal(entries.length, 25); assert(entries.every(e => e.network === network));
  for (const entry of entries) {
    const i = entry.key.split(":").at(-1);
    assert.equal(await entry.signedData.text(), `signed-ciphertext-${i}`);
    assert.deepEqual((await reloaded.get(entry.key))?.envelope, envelope);
  }
}
checks.parallelDurableJournalRowsAndNetworkIsolation = 50;
await assert.rejects(() => withUploadLock("diagnostic-lock", async () => { throw new Error("simulated failure"); }), /simulated failure/);
assert.equal(await withUploadLock("diagnostic-lock", async () => "released"), "released");
checks.lockReleaseAfterFailure = 1;
console.log(JSON.stringify({ result: "PASS", checkedAt: new Date().toISOString(), checks, externalRequests: 0, solTransfers: 0, note: "Additional local diagnostics. IndexedDB is simulated; not a real-browser cross-tab or extension test." }, null, 2));
