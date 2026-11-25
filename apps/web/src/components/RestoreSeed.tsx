import { useState, useEffect, useRef } from "react";
import type { FormEvent } from "react";
import { isValidMnemonic, normalizeMnemonic } from "../lib/crypto/bip39";
import { deriveKeysFromMnemonic } from "../lib/crypto/keys";
import { parsePortableBackup, type PortableBackup } from "../lib/crypto/backup";
import { readCache } from "../lib/native/cache";
import { retrieveNativeReceipt } from "../lib/native/receipt";
import { DATA_GATEWAYS } from "../lib/arweave/gateways";
import { retrieveReceiptEnvelope } from "../lib/solana/receipt";
import { retrievePaidReceipt } from "../lib/checkout/paidReceipt";
import { preservationError, solanaMessages } from "../lib/solana/messages";
import { MAX_BACKUP_BYTES, parseEnvelope, serializeEnvelope } from "../lib/crypto/envelope";
import type { EnvelopeV1 } from "../lib/crypto/encrypt";
import { openEnvelope, openLocalVault, type VaultV1 } from "../lib/crypto/vault";
import {recoverVaultFromWords} from "../lib/recovery/recover";
import type {VerifiedVersion,SafeRecoveryDiagnostics,RecoveryErrorCode,RecoveryStage} from "../lib/recovery/types";
import { loadDraftTree } from "../lib/draftStorage";
import type { TreeStore } from "../lib/types";
import { assertDraftWriteToken, currentDraftWriteToken } from "../lib/draftOwnership";
import { activePersons } from "../lib/treeEngine";
import { acceptVaultVersion } from "../lib/vaultSession/selection";
import {archiveLocalVaultVersion,getLocalVaultVersion,listLocalVaultVersions,type LocalVaultVersion} from "../lib/vaultSession/localArchive";

import { useI18n } from "../lib/i18n/I18nProvider";
import { formatUiDateTime } from "../lib/i18n/messages";

type Props = {
  onRestored: (store?: TreeStore) => void;
  onBack: () => void;
};

type PickerItem =
  | { kind: "network"; version: VerifiedVersion; index: number }
  | { kind: "archive"; entry: LocalVaultVersion }
  | { kind: "local" };

export function RestoreSeed({ onRestored, onBack }: Props) {
  const { locale, t } = useI18n();
  const [draftToken] = useState(currentDraftWriteToken);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [showFile, setShowFile] = useState(false);
  const [backup, setBackup] = useState<({ name: string } & Exclude<PortableBackup, { kind: "words" }>) | null>(null);
  const [nativeGateway, setNativeGateway] = useState("");
  const [phrase, setPhrase] = useState<string | null>(null);
  const [vaultId, setVaultId] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerItem[] | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [diagnostics,setDiagnostics]=useState<SafeRecoveryDiagnostics|null>(null);
  const showDiagnostics=location.hash.includes('diagnostics=1');
  const alive = useRef(false);
  const activeRequest = useRef<AbortController | null>(null);
  const requestRevision = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, []);

  function isActive(request: AbortController) {
    return alive.current && activeRequest.current === request && !request.signal.aborted;
  }
  function ensureActive(request: AbortController) {
    if (!isActive(request)) throw Error('restore_cancelled');
    assertDraftWriteToken(draftToken);
  }
  function beginRequest() {
    if (!alive.current || activeRequest.current) return null;
    const request = new AbortController();
    activeRequest.current = request;
    requestRevision.current++;
    setBusy(true);
    return request;
  }
  function endRequest(request: AbortController) {
    if (!isActive(request)) return;
    activeRequest.current = null;
    setBusy(false);
    setOpeningId(null);
    setStatus('');
  }
  function cancelRequest() {
    activeRequest.current?.abort();
    activeRequest.current = null;
    requestRevision.current++;
    setBusy(false);
    setOpeningId(null);
    setStatus('');
  }
  function leave() { cancelRequest(); onBack(); }
  function failureMessage(error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return msg === 'storage_unavailable' ? t.quota : msg === 'invalid_backup' ? t.restore.badFile :
      preservationError(locale, msg) ?? (/mismatch|decrypt|JSON/i.test(msg) ? t.restore.decryptFail : msg);
  }

  function recoveryMessage(code:RecoveryErrorCode):string {
    const messages:Record<RecoveryErrorCode,string>={
      INVALID_WORDS:t.restore.needWords,NO_CANDIDATES:'Сохранение для этих слов не найдено.',
      DISCOVERY_UNAVAILABLE:'Сеть поиска сейчас недоступна. Проверьте соединение и повторите попытку.',
      DATA_UNAVAILABLE:'Архив найден, но пока не удалось загрузить его данные. Попробуйте позже.',
      METADATA_MISMATCH:'Найденная запись не прошла проверку.',RAW_HASH_MISMATCH:'Архив повреждён или не совпадает с опубликованной записью.',
      VAULT_ID_MISMATCH:'Найденная запись относится к другому сейфу.',DECRYPT_FAILED:'Не удалось расшифровать найденный архив этими словами.',
      INVALID_VAULT:'Данные семейного дерева не прошли проверку.',MULTIPLE_VERIFIED_HEADS:'Найдено несколько веток сохранения.',
      UNKNOWN_ERROR:'Не удалось завершить восстановление. Повторите попытку.'};
    return messages[code];
  }
  function stageMessage(stage:RecoveryStage):string {
    return {discover:'Ищем сохранение…',found:'Нашли семейный архив…',download:'Загружаем…',verify:'Проверяем…',decrypt:'Открываем дерево…',open:'Открываем дерево…'}[stage];
  }

  useEffect(()=>{if(!location.hash.startsWith('#/restore?saved=1'))return;let live=true;const revision=requestRevision.current;void readCache<{id:string;serialized:string}>('retrieved-saving').then(value=>{if(!value||!live||revision!==requestRevision.current)return;const parsed=parsePortableBackup(value.serialized);if(parsed.kind==='words')throw Error('invalid_envelope');setBackup({name:'Arweave '+value.id,...parsed});setShowFile(true);setStatus('Архив получен и проверен. Введите свои слова SEJIRE для расшифровки.');}).catch(()=>{if(live&&revision===requestRevision.current)setError(t.restore.badFile);});return()=>{live=false;};},[]);

  function finishWithVault(
    vault: VaultV1,
    opts: { vaultId: string; headTxId: string | null; parentTxId?: string | null; envelope: EnvelopeV1; mnemonic: string; source: "network" | "local" | "file" },
    request: AbortController,
  ) {
    // A fetch or WebCrypto operation can finish after navigation or cancellation.
    // Check before prompting, then commit cache/draft/session together only once.
    ensureActive(request);
    const envelope = parseEnvelope(opts.envelope);
    const store = acceptVaultVersion({ vault, envelope, mnemonic: opts.mnemonic,
      session: { vaultId: opts.vaultId, headTxId: opts.headTxId, source: opts.source } }, () => {
      ensureActive(request);
      const existing = loadDraftTree();
      if (existing && activePersons(existing.draft).length > 0 && !window.confirm(t.restore.replaceDraft)) return false;
      ensureActive(request);
      if (opts.headTxId && /^[A-Za-z0-9_-]{43}$/.test(opts.headTxId)) {
        archiveLocalVaultVersion({ id: opts.headTxId, vaultId: opts.vaultId, parentId: opts.parentTxId ?? null, source: 'network', envelope });
        const saved = getLocalVaultVersion(opts.vaultId, opts.headTxId);
        if (!saved || saved.parentId !== (opts.parentTxId ?? null) || serializeEnvelope(saved.envelope) !== serializeEnvelope(envelope)) {
          throw Error('storage_unavailable');
        }
      }
      return true;
    }, draftToken);
    if (!store) return;
    onRestored(store);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (activeRequest.current) return;
    const normalized = normalizeMnemonic(input);
    if (!isValidMnemonic(normalized)) {
      setError(t.restore.needWords);
      return;
    }
    const request = beginRequest();
    if (!request) return;
    setError(null);
    try {
      const keys = deriveKeysFromMnemonic(normalized);
      if (backup) {
        const envelope = backup.kind === "receipt"
          ? await retrieveReceiptEnvelope(backup.receipt, { vaultId: keys.vaultId, signal: request.signal })
          : backup.kind === "paidReceipt" ? await retrievePaidReceipt(backup.receipt, { vaultId: keys.vaultId, signal: request.signal })
          : backup.kind === "nativeReceipt" ? await retrieveNativeReceipt(backup.receipt, nativeGateway ? [nativeGateway, ...DATA_GATEWAYS] : [...DATA_GATEWAYS]) : backup.envelope;
        ensureActive(request);
        let vault: VaultV1;
        try {
          vault = await openEnvelope(keys, envelope);
        } catch {
          throw new Error(t.restore.decryptFail);
        }
        await finishWithVault(vault, {
          vaultId: keys.vaultId,
          headTxId: backup.kind === "paidReceipt" ? backup.receipt.txId : backup.kind === "nativeReceipt" ? backup.receipt.transactionId : backup.kind === "receipt" && backup.receipt.network === "mainnet-beta" ? backup.receipt.receipt.id : null,
          parentTxId: backup.kind === "paidReceipt" ? backup.receipt.archive.parentTxId : null,
          envelope,
          mnemonic: normalized, source: backup.kind !== "vault" ? "network" : "file",
        }, request);
        return;
      }
      setPhrase(normalized);
      setVaultId(keys.vaultId);
      setStatus('Ищем сохранение…');
      const result=await recoverVaultFromWords(normalized,{signal:request.signal,onStage:stage=>{if(isActive(request))setStatus(stageMessage(stage));}});
      ensureActive(request);
      setDiagnostics(result.diagnostics);
      let networkError: string | null = null;
      if(!result.ok)networkError=recoveryMessage(result.code);
      if(result.ok&&!result.forks.length&&!result.incomplete){
        const head=result.versions.find(version=>version.txId===result.headTxId);
        if(!head)throw Error(t.restore.badFile);
        finishWithVault(result.vault,{vaultId:keys.vaultId,headTxId:result.headTxId,parentTxId:head.parentTxId,envelope:head.envelope,mnemonic:normalized,source:'network'},request);return;
      }
      const versions=result.ok?[...result.versions].sort((a,b)=>(b.blockHeight??-1)-(a.blockHeight??-1)):[];
      const archive = listLocalVaultVersions(keys.vaultId);
      const networkIds = new Set(versions.map(v=>v.txId));
      const archiveOnly = archive.filter((a) => !networkIds.has(a.id));
      const local = await openLocalVault(keys);
      ensureActive(request);
      const items: PickerItem[] = [
        ...versions.map((version, index) => ({ kind: "network" as const, version, index })),
        ...archiveOnly.map((entry) => ({ kind: "archive" as const, entry })),
        ...(local ? [{ kind: "local" as const }] : []),
      ];

      if (items.length === 0) {
        throw new Error(
          networkError
            ? `${networkError} ${t.restore.noneLocal}`
            : t.restore.noneAnywhere
        );
      }

      if (networkError) {
        setError(`${networkError} ${t.restore.shownLocal}`);
      } else if(result.ok&&result.forks.length){setError(recoveryMessage('MULTIPLE_VERIFIED_HEADS'));}
      else if(result.ok&&result.incomplete){setError('Часть найденных версий недоступна или не прошла проверку. Показаны только проверенные архивы; история может быть неполной.');}

      if (items.length === 1 && !networkError && !(result.ok&&result.incomplete)) {
        await openPickerItem(items[0], normalized, keys.vaultId, request);
        return;
      }

      setPicker(items);
      setStatus("");
    } catch (err) {
      if (isActive(request)) setError(failureMessage(err));
    } finally {
      endRequest(request);
    }
  }

  async function openPickerItem(
    item: PickerItem,
    phraseOverride?: string,
    vaultOverride?: string,
    inheritedRequest?: AbortController,
  ) {
    const usePhrase = phraseOverride ?? phrase;
    const useVaultId = vaultOverride ?? vaultId;
    if (!usePhrase || !useVaultId) return;
    const request = inheritedRequest ?? beginRequest();
    if (!request || !isActive(request)) return;
    const id =
      item.kind === "local" ? "local" : item.kind === "network" ? item.version.txId : item.entry.id;
    setOpeningId(id);
    setError(null);
    try {
      const keys = deriveKeysFromMnemonic(usePhrase);
      if (item.kind === "local") {
        const raw = localStorage.getItem('sejire.envelope.' + useVaultId);
        if (!raw) throw new Error(t.restore.noLocal);
        const envelope = parseEnvelope(JSON.parse(raw));
        const local = await openEnvelope(keys, envelope);
        await finishWithVault(local, {
          vaultId: useVaultId,
          headTxId: null,
          envelope,
          mnemonic: usePhrase,
          source: "local",
        }, request);
        return;
      }
      if (item.kind === "archive") {
        const vault = await openEnvelope(keys, item.entry.envelope);
        await finishWithVault(vault, {
          vaultId: useVaultId,
          headTxId: (item.entry.source === 'network' || item.entry.source === 'sponsor') && /^[A-Za-z0-9_-]{43}$/.test(item.entry.id) ? item.entry.id : null,
          parentTxId: item.entry.parentId,
          envelope: item.entry.envelope,
          mnemonic: usePhrase,
          source: "local",
        }, request);
        return;
      }
      await finishWithVault(item.version.vault, {
        vaultId: useVaultId,
        headTxId: item.version.txId,
        parentTxId: item.version.parentTxId,
        envelope: item.version.envelope,
        mnemonic: usePhrase,
        source: "network",
      }, request);
    } catch (err) {
      if (isActive(request)) setError(failureMessage(err));
    } finally {
      if (!inheritedRequest) endRequest(request);
    }
  }

  async function onFile(file: File) {
    const request = beginRequest();
    if (!request) return;
    setError(null);
    setStatus("");
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new Error("envelope_too_large");
      const parsed = parsePortableBackup(await file.text());
      ensureActive(request);
      if (parsed.kind === "words") {
        setInput(parsed.mnemonic);
        setStatus(t.restore.fileReady);
        return;
      }
      setBackup({ name: file.name, ...parsed });
    } catch (err) {
      if (isActive(request)) setError(err instanceof Error && err.message === "envelope_too_large"
        ? t.restore.fileTooLarge : t.restore.badFile);
    } finally {
      // Preserve the successful file-read status until the owner acts again.
      if (isActive(request)) { activeRequest.current = null; setBusy(false); }
    }
  }

  if (picker && phrase && vaultId) {
    const networkCount = picker.filter((p) => p.kind === "network").length;
    return (
      <section className="hero-create" style={{ maxWidth: 480, margin: "0 auto" }}>
        <button type="button" className="welcome-menu-brand" onClick={leave}>
          SEJIRE
        </button>
        <div className="panel" style={{ textAlign: "left", width: "100%" }}>
          <h2>{picker.length === 1 && networkCount === 0 ? t.restore.singleLocalTitle : t.restore.pickTitle}</h2>
          <p className="sub">{networkCount === 0 ? t.restore.localPickHint : t.restore.availablePickHint}</p>
          <ul className="vault-version-list">
            {picker.map((item) => {
              if (item.kind === "local") {
                return (
                  <li key="local">
                    <button
                      type="button"
                      className="vault-version-item"
                      disabled={openingId !== null}
                      onClick={() => void openPickerItem(item)}
                    >
                      <span className="vault-version-title">
                        {t.restore.localCopy}
                        {openingId === "local" ? "…" : ""}
                      </span>
                      <span className="vault-version-meta">{t.restore.inBrowser}</span>
                    </button>
                  </li>
                );
              }
              if (item.kind === "archive") {
                return (
                  <li key={item.entry.id}>
                    <button
                      type="button"
                      className="vault-version-item"
                      disabled={openingId !== null}
                      onClick={() => void openPickerItem(item)}
                    >
                      <span className="vault-version-title">
                        {item.entry.source === "demo" ? t.restore.demoVersion : t.restore.browserVersion}
                        {openingId === item.entry.id ? "…" : ""}
                      </span>
                      <span className="vault-version-meta">
                        {formatUiDateTime(item.entry.savedAt, locale, t.restore.unknownTime)} ·{" "}
                        {item.entry.id.slice(0, 10)}…
                      </span>
                    </button>
                  </li>
                );
              }
              const n = networkCount - item.index;
              return (
                  <li key={item.version.txId}>
                  <button
                    type="button"
                    className="vault-version-item"
                    disabled={openingId !== null}
                    onClick={() => void openPickerItem(item)}
                  >
                    <span className="vault-version-title">
                        {item.index === 0 ? t.restore.latestNetwork : t.restore.networkVersion(n)}
                        {openingId === item.version.txId ? "…" : ""}
                    </span>
                    <span className="vault-version-meta">
                        {item.version.blockHeight!=null?`Блок ${item.version.blockHeight}`:t.restore.unknownTime}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="actions">
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                cancelRequest();
                setPicker(null);
                setPhrase(null);
                setVaultId(null);
              }}
            >
              {t.back}
            </button>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          {error && diagnostics && <details><summary>Диагностика восстановления</summary><pre>{JSON.stringify(diagnostics,null,2)}</pre></details>}
        </div>
      </section>
    );
  }

  return (
    <section className="hero-create" style={{ maxWidth: 480, margin: "0 auto" }}>
      <button type="button" className="welcome-menu-brand" onClick={leave}>
        SEJIRE
      </button>
      <form className="panel" style={{ textAlign: "left", width: "100%" }} onSubmit={(e) => void onSubmit(e)}>
        <h2>{t.restore.title}</h2>
        <p className="sub">{t.restore.hint}</p>
        <textarea
          aria-label={t.restore.wordsLabel}
          rows={3}
          value={input}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          placeholder="word1 word2 … word12"
          required
        />
        {backup && <div className="sub" role="status">
          <p style={{ overflowWrap: "anywhere" }}>{backup.kind === "receipt" ? backup.name : t.restore.archiveReady(backup.name)}</p>
          {backup.kind === "nativeReceipt" && <label>Другой Arweave gateway<input aria-label="Другой Arweave gateway" value={nativeGateway} onChange={e=>setNativeGateway(e.target.value)} /></label>}
          {backup.kind === "receipt" && <>
            <p>{solanaMessages[locale].receiptRestore}</p>
            {backup.receipt.network === "devnet" && <p>{solanaMessages[locale].test}</p>}
          </>}
          {backup.kind === "paidReceipt" && <p>Квитанция сохранения в Arweave. Архив проверяется перед открытием; для расшифровки нужны ваши слова SEJIRE.</p>}
          <button type="button" className="welcome-link-quiet" disabled={busy} onClick={() => {
            setBackup(null);
            setError(null);
            setStatus("");
          }}>{t.restore.removeFile}</button>
        </div>}
        <div className="actions">
          <button className="btn ghost" type="button" onClick={leave}>
            {t.back}
          </button>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? (backup ? t.restore.openingFile : status || t.restore.searching) : (backup ? t.restore.openArchive : t.restore.open)}
          </button>
        </div>
        <button
          type="button"
          className="welcome-link-quiet"
          style={{ marginTop: "0.85rem" }}
          disabled={busy}
          aria-expanded={showFile}
          onClick={() => setShowFile((v) => !v)}
        >
          {showFile ? t.restore.hideFile : t.restore.openFile}
        </button>
        {showFile ? (
          <label className="full" style={{ marginTop: "0.55rem" }}>
            {t.restore.fileLabel}
            <input
              type="file"
              accept="application/json,.json"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void onFile(f);
              }}
            />
          </label>
        ) : null}
        {status && !busy && <p className="sub">{status}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {(showDiagnostics||error)&&diagnostics&&<details><summary>Диагностика восстановления</summary><pre>{JSON.stringify(diagnostics,null,2)}</pre></details>}
      </form>
    </section>
  );
}
