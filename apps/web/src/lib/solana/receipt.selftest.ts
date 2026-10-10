import assert from "node:assert/strict";
import { preservationFixture, disposableWallet } from "./fixture.selftest";
import { parsePreservationReceipt, receiptDataUrl, retrieveReceiptEnvelope, type PreservationReceipt } from "./receipt";
import { envelopeDigest, serializeEnvelope } from "./policy";
import { MAX_BACKUP_BYTES } from "../crypto/envelope";
import { parsePortableBackup } from "../crypto/backup";
import { openEnvelope } from "../crypto/vault";

const { keys, vault, envelope } = await preservationFixture();
const data = serializeEnvelope(envelope);
const receipt: PreservationReceipt = {
  schema: "sejire/preservation-receipt/v1", network: "devnet", status: "accepted-by-turbo",
  acceptedAt: new Date().toISOString(), wallet: disposableWallet().wallet.publicKey.toString(),
  vaultId: keys.vaultId, envelopeSha256: await envelopeDigest(data),
  receipt: { id: "a".repeat(43), winc: "0", owner: "test", dataCaches: ["https://evil.invalid"], fastFinalityIndexes: [] },
};
const response = (body: BodyInit | null, init?: ResponseInit): typeof fetch => async (url, options) => {
  assert.equal(url, `https://ar-io.dev/raw/${receipt.receipt.id}`);
  assert.equal(options?.credentials, "omit"); assert.equal(options?.referrerPolicy, "no-referrer");
  return new Response(body, init);
};
assert.equal(parsePortableBackup(JSON.stringify(receipt)).kind, "receipt");
assert.equal(receiptDataUrl({ ...receipt, network: "mainnet-beta" }), `https://arweave.net/raw/${receipt.receipt.id}`);
const downloaded = await retrieveReceiptEnvelope(receipt, { vaultId: keys.vaultId, fetcher: response(data) });
assert.deepEqual(await openEnvelope(keys, downloaded), vault, "receipt roundtrip retains both trees, history and relationships");
await assert.rejects(() => retrieveReceiptEnvelope(receipt, { fetcher: response(data + " ") }), /archive_integrity_mismatch/);
await assert.rejects(() => retrieveReceiptEnvelope(receipt, { fetcher: response(new Blob([new Uint8Array([0xef, 0xbb, 0xbf]), data])) }), /archive_integrity_mismatch/, "hash exact bytes, including BOM");
await assert.rejects(() => retrieveReceiptEnvelope(receipt, { fetcher: response(null, { status: 404 }) }), /archive_not_available/);
await assert.rejects(() => retrieveReceiptEnvelope(receipt, { fetcher: response(null, { status: 202 }) }), /archive_not_available/);
await assert.rejects(() => retrieveReceiptEnvelope(receipt, { fetcher: response(null, { status: 503 }) }), /retrieval_unavailable/);
await assert.rejects(() => retrieveReceiptEnvelope(receipt, { fetcher: async () => { throw new TypeError("Failed to fetch"); } }), /retrieval_unavailable/);
const interrupted = new ReadableStream({ start(c) { c.error(new TypeError("network stream lost")); } });
await assert.rejects(() => retrieveReceiptEnvelope(receipt, { fetcher: response(interrupted) }), /retrieval_unavailable/);
await assert.rejects(() => retrieveReceiptEnvelope(receipt, { fetcher: response(data, { headers: { "content-length": String(MAX_BACKUP_BYTES + 1) } }) }), /envelope_too_large/);
const oversized = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_BACKUP_BYTES)); c.enqueue(new Uint8Array(1)); c.close(); } });
await assert.rejects(() => retrieveReceiptEnvelope(receipt, { fetcher: response(oversized) }), /envelope_too_large/);
await assert.rejects(() => retrieveReceiptEnvelope(receipt, { vaultId: "0".repeat(32), fetcher: async () => { throw new Error("must not reach network"); } }), /Vault-Id mismatch/);
await assert.rejects(() => retrieveReceiptEnvelope({ ...receipt, vaultId: undefined }, { vaultId: "0".repeat(32), fetcher: response(data) }), /Vault-Id mismatch/);
for (const raw of [null, [], {}, { ...receipt, network: "http://evil.invalid" },
  { ...receipt, receipt: { id: "../secrets" } }, { ...receipt, envelopeSha256: "none" }, { ...receipt, wallet: "bad" },
  { ...receipt, acceptedAt: "invalid" }, { ...receipt, status: "settled" }]) {
  assert.throws(() => parsePreservationReceipt(raw), /invalid_receipt/);
}
console.log("solana.receipt.selftest: OK — recovery, exact-byte hash, network isolation, hostile receipts, unavailable/oversized data");
