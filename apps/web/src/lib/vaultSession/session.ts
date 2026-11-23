/**
 * In-session vault context after restore / publish.
 * Mnemonic stays in memory only (never localStorage).
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { EnvelopeV1 } from "../crypto/encrypt";
import { parseEnvelope, serializeEnvelope } from "../crypto/envelope";

export type VaultSessionMeta = {
  vaultId: string;
  /** Last opened or published network TX for this vault (HEAD). */
  headTxId: string | null;
  source: "network" | "local" | "file" | "publish";
  /** Bind a tab's explicit local choice to the shared encrypted cache. */
  cacheDigest?: string;
};

export function vaultEnvelopeDigest(envelope: EnvelopeV1): string {
  return bytesToHex(sha256(utf8ToBytes(serializeEnvelope(envelope))));
}

export const VAULT_SESSION_META_KEY = "sejire.vaultSession.v1";

let memoryMnemonic: string | null = null;

export function setVaultSession(meta: VaultSessionMeta, mnemonic?: string | null) {
  try {
    sessionStorage.setItem(VAULT_SESSION_META_KEY, JSON.stringify(meta));
  } catch {
    /* private mode / quota */
  }
  if (mnemonic !== undefined) {
    memoryMnemonic = mnemonic;
  }
}

/** Independent flows must not claim a restored/prepared vault while retaining
 * an older session after a denied or exhausted sessionStorage write. */
export function setVaultSessionChecked(meta: VaultSessionMeta, mnemonic?: string | null) {
  let previous: string | null;
  try { previous = sessionStorage.getItem(VAULT_SESSION_META_KEY); }
  catch { throw Error('storage_unavailable'); }
  let selected = meta;
  if (meta.source === 'file' || meta.source === 'local') {
    let cached: string | null;
    try { cached = localStorage.getItem('sejire.envelope.' + meta.vaultId); }
    catch { throw Error('storage_unavailable'); }
    if (!cached) throw Error('storage_unavailable');
    const envelope = parseEnvelope(JSON.parse(cached));
    if (envelope.vault_id !== meta.vaultId) throw Error('invalid_backup');
    const cacheDigest = vaultEnvelopeDigest(envelope);
    if (meta.cacheDigest !== cacheDigest) throw Error('vault_selection_changed');
    selected = { ...meta, cacheDigest };
  }
  const serialized = JSON.stringify(selected);
  try {
    sessionStorage.setItem(VAULT_SESSION_META_KEY, serialized);
    if (sessionStorage.getItem(VAULT_SESSION_META_KEY) !== serialized) throw Error('storage_unavailable');
  } catch {
    try {
      if (previous === null) sessionStorage.removeItem(VAULT_SESSION_META_KEY);
      else sessionStorage.setItem(VAULT_SESSION_META_KEY, previous);
    } catch { /* the caller still receives the persistence failure */ }
    throw Error('storage_unavailable');
  }
  if (mnemonic !== undefined) memoryMnemonic = mnemonic;
}

export function getVaultSession(): VaultSessionMeta | null {
  try {
    const raw = sessionStorage.getItem(VAULT_SESSION_META_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as VaultSessionMeta;
    if (!parsed?.vaultId || typeof parsed.vaultId !== "string") return null;
    return {
      vaultId: parsed.vaultId,
      headTxId: parsed.headTxId ?? null,
      source: parsed.source ?? "network",
      ...(Object.hasOwn(parsed, "cacheDigest") ? { cacheDigest: parsed.cacheDigest } : {}),
    };
  } catch {
    return null;
  }
}

export function getSessionMnemonic(): string | null {
  return memoryMnemonic;
}

export function updateVaultHead(txId: string) {
  const cur = getVaultSession();
  if (!cur) return;
  setVaultSession({ ...cur, headTxId: txId, source: "publish" });
}

export function clearVaultSession() {
  memoryMnemonic = null;
  try {
    sessionStorage.removeItem(VAULT_SESSION_META_KEY);
  } catch {
    /* ignore */
  }
}
