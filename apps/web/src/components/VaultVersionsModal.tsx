import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchVaultEnvelope,
  formatVersionWhen,
  isGatewayUnavailable,
  listVaultVersions,
  type VaultVersionMeta,
} from "../lib/arweave/fetch";
import { deriveKeysFromMnemonic, fingerprintVaultId } from "../lib/crypto/keys";
import { openEnvelope, type VaultV1 } from "../lib/crypto/vault";
import type { EnvelopeV1 } from "../lib/crypto/encrypt";
import { parseEnvelope } from "../lib/crypto/envelope";
import { isValidMnemonic, normalizeMnemonic } from "../lib/crypto/bip39";
import {
  getSessionMnemonic,
  getVaultSession,
} from "../lib/vaultSession/session";
import type { VaultVersionSelection } from "../lib/vaultSession/selection";
import { retrieveNativeVault } from "../lib/recovery/historicalNative";
import { DECENTRALIZED_MODE } from "../lib/deploymentMode";
import {
  getLocalVaultVersion,
  listLocalVaultVersions,
  type LocalVaultVersion,
} from "../lib/vaultSession/localArchive";
import { activePersons } from "../lib/treeEngine";
import { useI18n } from "../lib/i18n/I18nProvider";
import { formatUiDateTime } from "../lib/i18n/messages";

type Props = {
  onClose: () => void;
  onOpenVersion: (selection: VaultVersionSelection) => boolean;
};

type ListedVersion =
  | { kind: "network"; meta: VaultVersionMeta }
  | { kind: "archive"; entry: LocalVaultVersion };

function mergeVersionLists(
  network: VaultVersionMeta[],
  archive: LocalVaultVersion[]
): ListedVersion[] {
  const seen = new Set<string>();
  const out: ListedVersion[] = [];
  for (const meta of network) {
    seen.add(meta.txId);
    out.push({ kind: "network", meta });
  }
  for (const entry of archive) {
    // Independent network choices require a fresh native proof. Keep their
    // browser copies separately selectable when that network proof is unavailable.
    if (seen.has(entry.id) && !DECENTRALIZED_MODE) continue;
    seen.add(entry.id);
    out.push({ kind: "archive", entry });
  }
  return out;
}

export function VaultVersionsModal({ onClose, onOpenVersion }: Props) {
  const { locale, t } = useI18n();
  const session = getVaultSession();
  const [versions, setVersions] = useState<ListedVersion[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [phrase, setPhrase] = useState(getSessionMnemonic() ?? "");
  const [needPhrase, setNeedPhrase] = useState(!getSessionMnemonic());
  const [openingId, setOpeningId] = useState<string | null>(null);
  const alive = useRef(false);
  const opening = useRef<AbortController | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; opening.current?.abort(); };
  }, []);
  const closeModal = useCallback(() => {
    alive.current = false;
    opening.current?.abort();
    onClose();
  }, [onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeModal();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeModal]);

  useEffect(() => {
    if (!session?.vaultId) {
      setBusy(false);
      setError(t.versions.needOpen);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        setStatus(t.publish.vaultFp(fingerprintVaultId(session.vaultId)));
        let network: VaultVersionMeta[] = [];
        let networkError: string | null = null;
        try {
          network = await listVaultVersions(session.vaultId, { signal: controller.signal });
        } catch (e) {
          network = [];
          networkError = isGatewayUnavailable(e)
            ? e instanceof Error
              ? e.message
              : t.restore.arweaveDown
            : t.restore.arweaveFail;
        }
        const archive = listLocalVaultVersions(session.vaultId);
        const merged = mergeVersionLists(network, archive);
        if (!cancelled) {
          setVersions(merged);
          if (merged.length === 0) {
            setError(
              networkError
                ? `${networkError} ${t.versions.noneLocalToo}`
                : t.versions.none
            );
          } else if (networkError) {
            setError(`${networkError} ${t.restore.shownLocal}`);
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) {
          setBusy(false);
          setStatus("");
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [session?.vaultId]);

  async function openListed(item: ListedVersion) {
    if (!session?.vaultId || opening.current) return;
    const raw = normalizeMnemonic(phrase);
    if (!isValidMnemonic(raw)) {
      setNeedPhrase(true);
      setError(t.restore.needWords);
      return;
    }
    const id = item.kind === "network" ? item.meta.txId : item.entry.id;
    const keys = deriveKeysFromMnemonic(raw);
    const controller = new AbortController(); opening.current = controller;
    setOpeningId(id);
    setError(null);
    try {
      if (keys.vaultId !== session.vaultId) {
        throw new Error(t.versions.wrongVault);
      }
      let vault: VaultV1 | null = null;
      let envelope: EnvelopeV1 | null = null;
      let source: "network" | "local" = "network";
      if (item.kind === "network") {
        if (DECENTRALIZED_MODE) {
          const remote = await retrieveNativeVault(id, keys, { signal: controller.signal });
          vault = remote.vault; envelope = remote.envelope;
        } else {
          const remote = await fetchVaultEnvelope(session.vaultId, id);
          if (remote) { envelope = remote.envelope; vault = await openEnvelope(keys, envelope); }
        }
      }
      if (!vault) {
        const archived =
          item.kind === "archive"
            ? item.entry
            : getLocalVaultVersion(session.vaultId, id);
        if (!archived) throw new Error(t.restore.decryptFail);
        envelope = parseEnvelope(archived.envelope);
        vault = await openEnvelope(keys, envelope);
        // A cached local_/demo_ label is not a transaction ID. In the
        // independent profile even a 43-character label is only a local hint
        // until the native reader has verified its binding to these bytes.
        source = DECENTRALIZED_MODE || !/^[A-Za-z0-9_-]{43}$/.test(id) ? "local" : "network";
      }
      if (!envelope) throw Error(t.restore.decryptFail);
      if (!alive.current || controller.signal.aborted) return;
      onOpenVersion({ vault, envelope, mnemonic: raw,
        session: { vaultId: keys.vaultId, headTxId: source === "network" ? id : null, source } });
    } catch (e) {
      if (!alive.current || controller.signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /storage|quota/i.test(msg) ? t.quota : /mismatch|decrypt|JSON|invalid_backup/i.test(msg)
          ? t.versions.decryptFail
          : msg
      );
    } finally {
      keys.seed.fill(0); keys.master.fill(0); keys.encKey.fill(0);
      if (opening.current === controller) opening.current = null;
      if (alive.current) setOpeningId(null);
    }
  }

  async function openLocal() {
    if (opening.current) return;
    const raw = normalizeMnemonic(phrase);
    if (!isValidMnemonic(raw)) {
      setNeedPhrase(true);
      setError(t.versions.needWords);
      return;
    }
    setOpeningId("local");
    setError(null);
    const keys = deriveKeysFromMnemonic(raw);
    const controller = new AbortController(); opening.current = controller;
    try {
      if (keys.vaultId !== session?.vaultId) throw new Error(t.versions.wrongVault);
      const text = localStorage.getItem('sejire.envelope.' + keys.vaultId);
      if (!text) throw new Error(t.versions.noLocal);
      const envelope = parseEnvelope(JSON.parse(text));
      const vault = await openEnvelope(keys, envelope);
      const previousHead = session?.headTxId;
      if (!alive.current || controller.signal.aborted) return;
      onOpenVersion({ vault, envelope, mnemonic: raw, session: {
        vaultId: keys.vaultId, source: "local",
        headTxId: !DECENTRALIZED_MODE && previousHead && /^[A-Za-z0-9_-]{43}$/.test(previousHead) ? previousHead : null,
      } });
    } catch (e) {
      if (!alive.current || controller.signal.aborted) return;
      const message = e instanceof Error ? e.message : String(e);
      setError(/storage|quota/i.test(message) ? t.quota : message);
    } finally {
      keys.seed.fill(0); keys.master.fill(0); keys.encKey.fill(0);
      if (opening.current === controller) opening.current = null;
      if (alive.current) setOpeningId(null);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal panel">
        <h2>{t.versions.title}</h2>
        <p className="sub">{t.versions.hint}</p>
        {session?.vaultId && (
          <p className="sub mono publish-meta">
            {t.versions.vault(fingerprintVaultId(session.vaultId))}
            {session.headTxId ? t.versions.opened(session.headTxId.slice(0, 8)) : ""}
          </p>
        )}

        {(needPhrase || !getSessionMnemonic()) && (
          <label className="full">
            {t.versions.words}
            <textarea
              rows={2}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder="word1 word2 … word12"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
        )}

        {busy && <p className="sub">{status || t.versions.searching}</p>}

        {!busy && versions.length > 0 && (
          <ul className="vault-version-list">
            {versions.map((item, i) => {
              const id = item.kind === "network" ? item.meta.txId : item.entry.id;
              const isHead = DECENTRALIZED_MODE
                ? item.kind === "network" && session?.headTxId === id
                : session?.headTxId === id || (i === 0 && !session?.headTxId);
              const when =
                item.kind === "network"
                  ? formatVersionWhen(item.meta)
                  : formatUiDateTime(item.entry.savedAt, locale, t.restore.unknownTime);
              const where =
                item.kind === "network"
                  ? t.versions.whereArweave
                  : item.entry.source === "demo"
                    ? t.versions.whereDemo
                    : item.entry.source === "sponsor"
                      ? t.versions.whereSponsor
                      : t.versions.whereBrowser;
              return (
                <li key={`${item.kind}-${id}`}>
                  <button
                    type="button"
                    className="vault-version-item"
                    disabled={openingId !== null}
                    onClick={() => void openListed(item)}
                  >
                    <span className="vault-version-title">
                      {i === 0 && !DECENTRALIZED_MODE ? t.versions.latest : t.versions.versionN(versions.length - i)}
                      {isHead ? t.versions.now : ""}
                      {openingId === id ? "…" : ""}
                    </span>
                    <span className="vault-version-meta">
                      {when} · {where} · {id.slice(0, 10)}…
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {!busy && (
          <div className="actions" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <button
              type="button"
              className="btn ghost"
              disabled={openingId !== null}
              onClick={() => void openLocal()}
            >
              {t.versions.localCopy}
            </button>
            <button type="button" className="btn ghost" onClick={closeModal}>
              {t.close}
            </button>
          </div>
        )}

        {error && <p className="form-error">{error}</p>}
      </div>
    </div>
  );
}

/** Count people for display after decrypt — used by RestoreSeed picker. */
export function vaultPersonCount(vault: VaultV1): number {
  const treeId = vault.active_tree_id;
  const store = treeId ? vault.trees[treeId] : Object.values(vault.trees)[0];
  if (!store) return 0;
  return activePersons(store.draft).length;
}
