import assert from "node:assert/strict";
import { parsePortableBackup } from "./backup";
import { MAX_BACKUP_BYTES, serializeEnvelope } from "./envelope";
import { buildSeedBackup } from "./seedBackup";
import { deriveKeysFromMnemonic } from "./keys";
import { encryptJson } from "./encrypt";
import { emptyVault, openEnvelope, openLocalVault, putTree, sealVault } from "./vault";
import { commitDraft, createTree, upsertPersonFields } from "../treeEngine";

// Public test vector only; never use these words for a real archive or wallet.
const words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const keys = deriveKeysFromMnemonic(words);
let first = upsertPersonFields(createTree("Synthetic family A"), { id: "parent", name: "Parent", parents: [] });
first = upsertPersonFields(first, { id: "child", name: "Child", parents: ["parent"] });
first = commitDraft(first, "Synthetic recovery fixture");
const second = createTree("Synthetic family B");
const vault = putTree(putTree(emptyVault(keys.vaultId), second), first);
const envelope = await encryptJson(keys.encKey, keys.vaultId, vault);
const backup = parsePortableBackup(JSON.stringify(envelope, null, 2));
assert.equal(backup.kind, "vault");
if (backup.kind !== "vault") throw new Error("Expected encrypted archive");

const opened = await openEnvelope(keys, backup.envelope);
assert.deepEqual(opened, vault, "portable file retains every tree, relationship and revision");
assert.deepEqual(opened.trees[first.meta.id].draft.persons.child.parents, ["parent"]);
assert.equal(serializeEnvelope(backup.envelope), JSON.stringify(envelope));
assert.deepEqual(parsePortableBackup(JSON.stringify(buildSeedBackup(words))), { kind: "words", mnemonic: words });

for (const raw of [null, [], 42, "archive", {}, { schema: "sejire/seed/v1", words: [] },
  { ...envelope, iv: null }, { ...envelope, ciphertext: 123 },
  { ...envelope, cipher: "unknown" }, { ...envelope, family: "plaintext must not be forwarded" }]) {
  assert.throws(() => parsePortableBackup(JSON.stringify(raw)), /invalid_envelope/);
}
assert.throws(() => parsePortableBackup("{broken"), /invalid_backup/);
assert.throws(() => parsePortableBackup(" ".repeat(MAX_BACKUP_BYTES + 1)), /envelope_too_large/);
await assert.rejects(openEnvelope({ ...keys, vaultId: "f".repeat(32) }, envelope), /mismatch/);
await assert.rejects(openEnvelope(keys, { ...envelope, ciphertext: "AAAA" + envelope.ciphertext.slice(4) }));

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });
assert.equal(await openLocalVault(keys), null, "fresh device has no cached vault");
await sealVault(keys, opened);
assert.deepEqual(await openLocalVault(keys), vault, "restored cache retains the full multi-tree archive");
console.log("backup.selftest: OK (portable recovery, relationships, history, validation, tampering, full-vault cache)");
