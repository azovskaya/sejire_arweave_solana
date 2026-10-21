/**
 * Load a vault before sealing a new version.
 * Never treat an undecryptable "latest" tag as an empty vault — that forks history.
 */
import { type SejireKeys } from "../crypto/keys";
import {
  emptyVault,
  openEnvelope,
  type VaultV1,
} from "../crypto/vault";
import { parseEnvelope } from "../crypto/envelope";
import { coerceTreeStore } from "../treeJson";
import { getLocalVaultVersion } from "../vaultSession/localArchive";
import { getVaultSession } from "../vaultSession/session";
import { newDiagnostics } from "../recovery/diagnostics";
import { RecoveryFailure } from "../recovery/errors";
import { LegacyLocatorProvider } from "../recovery/providers/legacyLocatorProvider";
import { fetchMetadata, fetchRaw, tagValue, type TxMetadata } from "../recovery/retrieve";
import { verifyCandidate } from "../recovery/verify";
import type { GatewayPool, HeadCandidate, RecoveryContext } from "../recovery/types";
import {
  GatewayUnavailableError,
  isGatewayUnavailable,
  listVaultVersions,
} from "./fetch";
import { DATA_GATEWAYS } from "./gateways";

export type { SejireKeys };

export const VAULT_POISONED_RU =
  "В сети есть записи этого сейфа, но они не открываются вашими 12 словами. Не сохраняйте поверх — проверьте фразу.";

export type PublishVaultChoice =
  | { ok: true; vault: VaultV1 }
  | { ok: false; error: string };

/** Pure: decide what to publish against after the network walk. */
export function resolvePublishVault(input: {
  opened: VaultV1 | null;
  remoteListed: number;
  remoteDecryptFails: number;
  local: VaultV1 | null;
  empty: VaultV1;
}): PublishVaultChoice {
  if (input.opened) return { ok: true, vault: input.opened };
  const poisoned = input.remoteListed > 0 && input.remoteDecryptFails > 0;
  if (poisoned && !input.local) return { ok: false, error: VAULT_POISONED_RU };
  if (input.local) return { ok: true, vault: input.local };
  return { ok: true, vault: input.empty };
}

export type LoadedPublishVault = {
  vault: VaultV1;
  parentTxId: string | null;
};

const PUBLISH_LOAD_TIMEOUT_MS = 45_000;
const TX_ID = /^[A-Za-z0-9_-]{43}$/;
// The publisher already knows its previous HEAD. Use the ordinary, independent
// gateways without waiting for dynamic peer discovery before each new version.
const publishPool: GatewayPool = {
  candidates: async () => DATA_GATEWAYS.map(url => ({ url, source: "publish" })),
  markSuccess: () => {},
  markFailure: () => {},
};

async function openStoredVault(keys: SejireKeys, envelope: unknown, allowEmpty = false): Promise<VaultV1 | null> {
  try {
    const vault = await openEnvelope(keys, parseEnvelope(envelope));
    if (!vault || vault.schema !== "sejire/vault/v1" || vault.vault_id !== keys.vaultId ||
        !vault.trees || typeof vault.trees !== "object" || Array.isArray(vault.trees)) return null;
    const trees = Object.entries(vault.trees);
    if (!trees.length && !allowEmpty) return null;
    if (trees.some(([id, tree]) => id === "__proto__" || id === "constructor" || !coerceTreeStore(tree))) return null;
    if (vault.active_tree_id !== null && !Object.hasOwn(vault.trees, vault.active_tree_id)) return null;
    return vault;
  } catch { return null; }
}

type CachedVault = { vault: VaultV1; raw: string };

async function readLocalVault(keys: SejireKeys, allowEmpty: boolean): Promise<CachedVault | null> {
  try {
    const raw = localStorage.getItem("sejire.envelope." + keys.vaultId);
    if (!raw) return null;
    const vault = await openStoredVault(keys, JSON.parse(raw), allowEmpty);
    return vault ? { vault, raw } : null;
  } catch { return null; }
}

async function matchesKnownArchive(cache: CachedVault, metadata: TxMetadata | null, candidate: HeadCandidate): Promise<boolean> {
  const bytesTag = metadata ? tagValue(metadata, "Archive-Bytes") : null;
  const expectedBytes = bytesTag !== null ? Number(bytesTag) : candidate.archiveBytes;
  const expectedHash = (metadata ? tagValue(metadata, "Archive-SHA256") : null) ?? candidate.archiveSha256;
  if (expectedBytes === undefined || !expectedHash) return false;
  const bytes = new TextEncoder().encode(cache.raw);
  if (bytes.byteLength !== expectedBytes) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(part => part.toString(16).padStart(2, "0")).join("") === expectedHash;
}

async function tryOpenTx(
  ctx: RecoveryContext,
  keys: SejireKeys,
  candidate: HeadCandidate,
): Promise<{ vault: VaultV1 } | { failure: RecoveryFailure; metadata: TxMetadata | null }> {
  let metadata: TxMetadata | null = null;
  try {
    if (!TX_ID.test(candidate.txId)) throw new RecoveryFailure("METADATA_MISMATCH");
    const diagnostics = newDiagnostics();
    metadata = await fetchMetadata(ctx, publishPool, candidate, diagnostics);
    const bytes = await fetchRaw(ctx, publishPool, candidate, metadata, diagnostics);
    const verified = await verifyCandidate(bytes, metadata, candidate, keys);
    return { vault: verified.vault };
  } catch (error) {
    return { failure: error instanceof RecoveryFailure ? error : new RecoveryFailure("DATA_UNAVAILABLE"), metadata };
  }
}

export async function loadVaultForPublish(
  keys: SejireKeys,
  opts?: { parentTxId?: string | null; freshKey?: boolean }
): Promise<LoadedPublishVault> {
  const cached = await readLocalVault(keys, opts?.freshKey === true);
  const local = cached?.vault ?? null;
  // Only the caller that generated a brand-new random mnemonic may bypass lookup.
  if (opts?.freshKey) return { vault: local ?? emptyVault(keys.vaultId), parentTxId: null };
  const suppliedParent = opts?.parentTxId ?? null;
  if (suppliedParent && !TX_ID.test(suppliedParent)) throw new Error(VAULT_POISONED_RU);
  const session = getVaultSession();
  // Entering words for another vault must not carry the previous session's HEAD.
  const knownParent = suppliedParent && session?.headTxId === suppliedParent && session.vaultId !== keys.vaultId
    ? null : suppliedParent;
  const archived = knownParent ? getLocalVaultVersion(keys.vaultId, knownParent) : null;
  const archivedParent = archived && (archived.source === "network" || archived.source === "sponsor")
    ? await openStoredVault(keys, archived.envelope) : null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PUBLISH_LOAD_TIMEOUT_MS);
  const ctx: RecoveryContext = { vaultId: keys.vaultId, signal: controller.signal, fetcher: fetch };
  try {
    // Only the existing, vault-bound legacy manifest may waive a missing Vault-Id
    // tag. Ordinary candidates still require the full recovery metadata contract.
    const legacy = (await new LegacyLocatorProvider().discover(ctx)).candidates;
    const candidate = (txId: string): HeadCandidate => legacy.find(item => item.txId === txId) ?? { txId, source: "publish" };
    if (knownParent) {
      const parentCandidate = candidate(knownParent);
      const result = await tryOpenTx(ctx, keys, parentCandidate);
      if ("vault" in result) return { vault: result.vault, parentTxId: knownParent };
      // An indexed older version is not a substitute for an exact known HEAD:
      // doing so would drop trees saved in the most recent confirmed version.
      // A same-vault session does not prove that the single generic cache belongs
      // to this version. Require its exact hash/size, or the archived HEAD entry.
      const fallback = archivedParent ?? (cached && result.failure.code !== "VAULT_ID_MISMATCH" &&
        await matchesKnownArchive(cached, result.metadata, parentCandidate) ? cached.vault : null);
      if (fallback) return { vault: fallback, parentTxId: knownParent };
      if (result.failure.code === "DATA_UNAVAILABLE") throw new GatewayUnavailableError();
      throw new Error(VAULT_POISONED_RU);
    }

    let versions;
    try { versions = await listVaultVersions(keys.vaultId, { limit: 15, signal: controller.signal }); }
    catch (error) {
      if (isGatewayUnavailable(error) && local) return { vault: local, parentTxId: null };
      throw error;
    }
    const ids = [...new Set([...versions.map(version => version.txId), ...legacy.map(item => item.txId)])];
    let invalid = false;
    for (const txId of ids) {
      if (controller.signal.aborted) break;
      const result = await tryOpenTx(ctx, keys, candidate(txId));
      if ("vault" in result) return { vault: result.vault, parentTxId: txId };
      if (result.failure.code !== "DATA_UNAVAILABLE") invalid = true;
    }
    const decided = resolvePublishVault({
      opened: null,
      remoteListed: ids.length,
      remoteDecryptFails: invalid ? 1 : 0,
      local,
      empty: emptyVault(keys.vaultId),
    });
    if (!decided.ok) throw new Error(decided.error);
    if (!local && (ids.length || controller.signal.aborted)) {
      // A listed archive that could not be downloaded is not an empty vault.
      throw new GatewayUnavailableError();
    }
    return { vault: decided.vault, parentTxId: null };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
