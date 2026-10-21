/**
 * Vault load policy: poison tags must not become an empty "new" vault.
 */
import strict from "node:assert/strict";
import { emptyVault, putTree, sealVault, type VaultV1 } from "../crypto/vault";
import { loadVaultForPublish, resolvePublishVault, VAULT_POISONED_RU } from "./loadVault";
import { encryptJson, type EnvelopeV1 } from "../crypto/encrypt";
import { serializeEnvelope } from "../crypto/envelope";
import { envelopeDigest } from "../solana/policy";
import { archiveLocalVaultVersion, getLocalVaultVersion } from "../vaultSession/localArchive";
import { setVaultSession } from "../vaultSession/session";
import { DATA_GATEWAYS, GRAPHQL_ENDPOINTS } from "./gateways";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const empty = emptyVault("vault-test");
const real: VaultV1 = { ...empty, active_tree_id: "tree_1" };
const local: VaultV1 = { ...empty, active_tree_id: "tree_local" };

const opened = resolvePublishVault({
  opened: real,
  remoteListed: 3,
  remoteDecryptFails: 2,
  local,
  empty,
});
assert(opened.ok && opened.vault.active_tree_id === "tree_1", "opened wins");

const poison = resolvePublishVault({
  opened: null,
  remoteListed: 3,
  remoteDecryptFails: 3,
  local: null,
  empty,
});
assert(!poison.ok && poison.error === VAULT_POISONED_RU, "poison without local refuses empty");

const mixedPoison = resolvePublishVault({
  opened: null,
  remoteListed: 3,
  remoteDecryptFails: 1,
  local: null,
  empty,
});
assert(!mixedPoison.ok, "any undecryptable Vault-Id listing refuses empty");

const poisonLocal = resolvePublishVault({
  opened: null,
  remoteListed: 2,
  remoteDecryptFails: 2,
  local,
  empty,
});
assert(poisonLocal.ok && poisonLocal.vault.active_tree_id === "tree_local", "poison with local keeps local");

const fresh = resolvePublishVault({
  opened: null,
  remoteListed: 0,
  remoteDecryptFails: 0,
  local: null,
  empty,
});
assert(fresh.ok && fresh.vault === empty, "no remote → empty ok");

const localOnly = resolvePublishVault({
  opened: null,
  remoteListed: 0,
  remoteDecryptFails: 0,
  local,
  empty,
});
assert(localOnly.ok && localOnly.vault.active_tree_id === "tree_local", "offline local");

console.log("loadVault.selftest: OK");

// Integration regression: a network outage must not silently replace an existing
// multi-tree vault with an empty vault. Freshly generated keys can work offline.
const { deriveKeysFromMnemonic } = await import("../crypto/keys");
const { isGatewayUnavailable } = await import("./gateways");
const { createTree, commitDraft, upsertPersonFields } = await import("../treeEngine");
const keys = deriveKeysFromMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
const savedFetch = globalThis.fetch;
const savedLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const savedSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const storage = new Map<string, string>();
const sessionStorage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() { return storage.size; },
} });
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
  getItem: (key: string) => sessionStorage.get(key) ?? null,
  setItem: (key: string, value: string) => sessionStorage.set(key, value),
  removeItem: (key: string) => sessionStorage.delete(key),
} });

type Fixture = {
  id: string;
  envelope: EnvelopeV1;
  raw: string;
  metadata: { id: string; tags: { name: string; value: string }[] };
  native: string;
};
async function fixture(vault: VaultV1, id: string, parentTxId: string | null = null, historicalFund = false): Promise<Fixture> {
  const envelope = await encryptJson(keys.encKey, keys.vaultId, vault);
  const raw = serializeEnvelope(envelope);
  const tags = [
    { name: "App-Name", value: "SEJIRE" }, { name: "Type", value: "vault-envelope" },
    { name: "Vault-Id", value: keys.vaultId }, { name: "Schema", value: "sejire/envelope/v1" },
    { name: "Archive-SHA256", value: await envelopeDigest(raw) },
    { name: "Archive-Bytes", value: String(new TextEncoder().encode(raw).byteLength) },
    { name: "Preservation-Id", value: "c".repeat(32) }, { name: "Promo-Funded", value: "true" },
    ...(!historicalFund ? [{ name: "Protocol-Version", value: "sejire/v0.3" }] : []),
    ...(parentTxId ? [{ name: "Parent-Tx", value: parentTxId }] : []),
  ];
  return { id, envelope, raw, native: Buffer.from(raw).toString("base64url"), metadata: {
    id, tags: tags.map(tag => ({ name: Buffer.from(tag.name).toString("base64url"), value: Buffer.from(tag.value).toString("base64url") })),
  } };
}
const requests: { url: string; method: string }[] = [];
function network(options: {
  records?: Fixture[];
  listed?: string[];
  rawStatus?: number;
  nativeStatus?: number;
  metadataStatus?: number;
  unavailable?: string[];
} = {}) {
  requests.length = 0;
  const records = new Map((options.records ?? []).map(record => [record.id, record]));
  globalThis.fetch = async (input, init) => {
    const url = String(input), parsed = new URL(url), method = init?.method ?? "GET";
    requests.push({ url, method });
    if ((GRAPHQL_ENDPOINTS as readonly string[]).includes(url)) {
      assert(method === "POST", "only read-only GraphQL may use POST");
      const body = JSON.parse(String(init?.body));
      assert(body.variables.vaultId === keys.vaultId && body.query.trimStart().startsWith("query "), "discovery stays scoped to the current vault");
      return new Response(JSON.stringify({ data: { transactions: { edges: (options.listed ?? []).map(id => ({ node: { id, block: null } })) } } }));
    }
    assert((DATA_GATEWAYS as readonly string[]).includes(parsed.origin), "test must never contact an unexpected host");
    assert(method === "GET", "vault preparation performs no writes or signing");
    assert(init?.credentials === "omit" && init?.referrerPolicy === "no-referrer", "archive reads carry no credentials or referrer");
    const match = /^\/(?:tx|raw)\/([A-Za-z0-9_-]{43})(?:\/data)?$/.exec(parsed.pathname);
    assert(match, "test must never contact an unexpected endpoint");
    const record = records.get(match[1]);
    if (options.unavailable?.includes(match[1])) return new Response("unavailable", { status: 503 });
    if (!record) return new Response("missing", { status: 404 });
    if (parsed.pathname === `/tx/${record.id}`) return new Response(JSON.stringify(record.metadata), { status: options.metadataStatus ?? 200 });
    if (parsed.pathname === `/raw/${record.id}`) return new Response(record.raw, { status: options.rawStatus ?? 200 });
    assert(init?.redirect === "error", "native data fallback must stay on the selected gateway");
    return new Response(record.native, { status: options.nativeStatus ?? 200 });
  };
}
function clearCaches() { storage.clear(); sessionStorage.clear(); }
function rememberConfirmed(record: Fixture, parentId: string | null) {
  archiveLocalVaultVersion({ id: record.id, vaultId: keys.vaultId, parentId, source: "network", envelope: record.envelope });
  setVaultSession({ vaultId: keys.vaultId, headTxId: record.id, source: "publish" });
  storage.set("sejire.envelope." + keys.vaultId, JSON.stringify(record.envelope));
}
globalThis.fetch = async () => new Response("unavailable", { status: 503 });
try {
  let refused = false;
  try { await loadVaultForPublish(keys); } catch (e) { refused = isGatewayUnavailable(e); }
  assert(refused, "existing key + offline + no local backup must refuse to overwrite");
  const freshOffline = await loadVaultForPublish(keys, { freshKey: true });
  assert(Object.keys(freshOffline.vault.trees).length === 0, "new random key can create offline");
  const firstTree = createTree("Synthetic family A");
  const otherTree = createTree("Synthetic family B");
  const preserved = { ...emptyVault(keys.vaultId), active_tree_id: firstTree.meta.id,
    trees: { [firstTree.meta.id]: firstTree, [otherTree.meta.id]: otherTree } };
  await sealVault(keys, preserved);
  const offlineLocal = await loadVaultForPublish(keys);
  assert(offlineLocal.vault.active_tree_id === firstTree.meta.id, "existing local vault preserved offline");
  assert(offlineLocal.vault.trees[otherTree.meta.id].meta.title === "Synthetic family B", "second tree survives offline save");

  let treeA = createTree("Synthetic family A");treeA.meta.id = "tree_synthetic_A";
  treeA = commitDraft(upsertPersonFields(treeA, { id: "p_synthetic_A", name: "Synthetic ancestor", parents: [] }), "Synthetic first version");
  const treeB = createTree("Synthetic family B");treeB.meta.id = "tree_synthetic_B";
  const treeC = createTree("Synthetic family C");treeC.meta.id = "tree_synthetic_C";
  const vaultA = putTree(emptyVault(keys.vaultId), treeA);
  const vaultAB = putTree(vaultA, treeB);
  const first = await fixture(vaultA, "A".repeat(43), null, true);
  const second = await fixture(vaultAB, "B".repeat(43), first.id);

  // Use the same strict metadata/size/hash/envelope/AES/tree pipeline as restore,
  // including node data fallback when every raw gateway route misses the archive.
  clearCaches();network({ records: [second], rawStatus: 404 });
  const nativeRead = await loadVaultForPublish(keys, { parentTxId: second.id });
  strict.deepEqual(nativeRead.vault, vaultAB);strict.equal(nativeRead.parentTxId, second.id);
  assert(requests.some(request => request.url.endsWith(`/tx/${second.id}/data`)), "publish reads the native node data endpoint after raw misses");
  assert(requests.every(request => request.method === "GET"), "known HEAD does not need discovery or create an order");
  clearCaches();network({ records: [first], listed: [first.id], rawStatus: 404 });
  const historicalRead = await loadVaultForPublish(keys);
  strict.deepEqual(historicalRead.vault, vaultA);strict.equal(historicalRead.parentTxId, first.id);

  // A metadata id mismatch, a wrong digest, undecryptable ciphertext and an
  // invalid full-vault payload must never be treated as a new, empty archive.
  const changedRaw = second.raw.slice(0, -1) + (second.raw.endsWith("}") ? " " : "}");
  for (const invalid of [
    { ...second, metadata: { ...second.metadata, id: first.id } },
    { ...second, raw: changedRaw, native: Buffer.from(changedRaw).toString("base64url") },
    await fixture({ ...vaultAB, trees: { broken: {} } } as unknown as VaultV1, second.id),
    await fixture({ ...vaultAB, vault_id: "e".repeat(32) }, second.id),
  ]) {
    clearCaches();network({ records: [invalid], listed: [second.id] });
    await strict.rejects(() => loadVaultForPublish(keys, { parentTxId: second.id }), error => error instanceof Error && error.message === VAULT_POISONED_RU);
  }
  const changedEnvelope = { ...second.envelope, ciphertext: (second.envelope.ciphertext[0] === "A" ? "B" : "A") + second.envelope.ciphertext.slice(1) };
  const unauthenticatedRaw = serializeEnvelope(changedEnvelope);
  const shaName = Buffer.from("Archive-SHA256").toString("base64url");
  const unauthenticatedDigest = Buffer.from(await envelopeDigest(unauthenticatedRaw)).toString("base64url");
  const invalidCipher = { ...second, raw: unauthenticatedRaw, native: Buffer.from(unauthenticatedRaw).toString("base64url"), metadata: {
    ...second.metadata, tags: second.metadata.tags.map(tag => tag.name === shaName ? { ...tag, value: unauthenticatedDigest } : tag),
  } };
  clearCaches();network({ records: [invalidCipher] });
  await strict.rejects(() => loadVaultForPublish(keys, { parentTxId: second.id }), error => error instanceof Error && error.message === VAULT_POISONED_RU, "matching public hash does not bypass AES-GCM");

  clearCaches();network({ records: [second], listed: [second.id], rawStatus: 404, nativeStatus: 404 });
  await strict.rejects(() => loadVaultForPublish(keys), isGatewayUnavailable, "an indexed but unreadable vault is not empty");

  // Sequential saves: A -> A+B -> A+B+C. A stale index still advertises A when
  // the exact second HEAD is temporarily unavailable; its verified local archive
  // retains every prior tree, history and the known parent, with no identity reset.
  clearCaches();rememberConfirmed(first, null);network({ records: [first], rawStatus: 404 });
  const baseForSecond = await loadVaultForPublish(keys, { parentTxId: first.id });
  strict.equal(baseForSecond.parentTxId, first.id);
  const nextVault = putTree(baseForSecond.vault, treeB);
  const nextEnvelope = await sealVault(keys, nextVault);
  const confirmedSecond = { ...second, envelope: nextEnvelope };
  rememberConfirmed(confirmedSecond, first.id);
  // Deliberately replace the generic cache with older A. The exact B archive wins.
  storage.set("sejire.envelope." + keys.vaultId, JSON.stringify(first.envelope));
  network({ records: [first, second], listed: [first.id], unavailable: [second.id] });
  const baseForThird = await loadVaultForPublish(keys, { parentTxId: second.id });
  strict.deepEqual(baseForThird.vault, nextVault);strict.equal(baseForThird.parentTxId, second.id);
  assert(requests.every(request => !request.url.endsWith("/graphql") && !request.url.includes(first.id)), "older indexed HEAD cannot replace the exact known parent");
  const third = putTree(baseForThird.vault, treeC);
  await sealVault(keys, third);
  strict.deepEqual(Object.keys(third.trees), [treeA.meta.id, treeB.meta.id, treeC.meta.id]);
  strict.deepEqual(third.trees[treeA.meta.id], treeA, "first tree history survives two subsequent saves");
  strict.deepEqual(third.trees[treeB.meta.id], treeB);
  strict.equal(third.active_tree_id, treeC.meta.id, "new third tree keeps its own identity");
  strict.equal(getLocalVaultVersion(keys.vaultId, second.id)?.parentId, first.id);

  // An older client may have only the general encrypted cache. Exact metadata
  // bytes/hash may bind it to HEAD; the session or vault id alone is insufficient.
  clearCaches();storage.set("sejire.envelope." + keys.vaultId, JSON.stringify(second.envelope));
  setVaultSession({ vaultId: keys.vaultId, headTxId: second.id, source: "network" });
  network({ unavailable: [second.id] });
  await strict.rejects(() => loadVaultForPublish(keys, { parentTxId: second.id }), isGatewayUnavailable, "a session alone does not bind an unindexed cache to HEAD");
  sessionStorage.clear();network({ records: [second], rawStatus: 404, nativeStatus: 404 });
  const boundByMetadata = await loadVaultForPublish(keys, { parentTxId: second.id });
  strict.deepEqual(boundByMetadata.vault, vaultAB);strict.equal(boundByMetadata.parentTxId, second.id);
  network({ unavailable: [second.id] });
  await strict.rejects(() => loadVaultForPublish(keys, { parentTxId: second.id }), isGatewayUnavailable, "an unbound local copy cannot silently discard or invent a known parent");

  // Counterexample: HEAD B contains A+B, but the one generic cache contains A.
  // Neither valid B metadata nor a remembered B session may publish A+C as B's child.
  storage.set("sejire.envelope." + keys.vaultId, JSON.stringify(first.envelope));
  setVaultSession({ vaultId: keys.vaultId, headTxId: second.id, source: "network" });
  network({ records: [second], listed: [first.id], rawStatus: 404, nativeStatus: 404 });
  await strict.rejects(() => loadVaultForPublish(keys, { parentTxId: second.id }), isGatewayUnavailable, "stale generic cache must not discard the second tree under a newer parent");
  network({ unavailable: [second.id], listed: [first.id] });
  await strict.rejects(() => loadVaultForPublish(keys, { parentTxId: second.id }), isGatewayUnavailable, "remembered session must not silently authorize stale cached bytes");
  await sealVault(keys, vaultAB);
  network({ records: [second], rawStatus: 404, nativeStatus: 404 });
  await strict.rejects(() => loadVaultForPublish(keys, { parentTxId: second.id }), isGatewayUnavailable, "a restored and resealed cache is not falsely treated as exact network bytes");

  // Switching words must not attach a different vault's remembered parent.
  storage.set("sejire.envelope." + keys.vaultId, JSON.stringify(second.envelope));
  setVaultSession({ vaultId: "f".repeat(32), headTxId: first.id, source: "network" });
  network();
  const anotherSession = await loadVaultForPublish(keys, { parentTxId: first.id });
  strict.deepEqual(anotherSession.vault, vaultAB);strict.equal(anotherSession.parentTxId, null);
  assert(requests.every(request => !request.url.includes(first.id)), "different vault session HEAD is not carried over");
  await strict.rejects(() => loadVaultForPublish(keys, { parentTxId: "../not-a-transaction" }), error => error instanceof Error && error.message === VAULT_POISONED_RU);
} finally {
  globalThis.fetch = savedFetch;
  if (savedLocalStorage) Object.defineProperty(globalThis, "localStorage", savedLocalStorage);else Reflect.deleteProperty(globalThis, "localStorage");
  if (savedSessionStorage) Object.defineProperty(globalThis, "sessionStorage", savedSessionStorage);else Reflect.deleteProperty(globalThis, "sessionStorage");
}
console.log("loadVault verified retrieval, local parent and sequential multi-tree selftests: OK");
