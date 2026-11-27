import { useEffect, useRef, useState, type FormEvent } from 'react';
import { isValidMnemonic, normalizeMnemonic } from '../lib/crypto/bip39';
import { deriveKeysFromMnemonic } from '../lib/crypto/keys';
import { MAX_BACKUP_BYTES, parseEnvelope, serializeEnvelope } from '../lib/crypto/envelope';
import { openEnvelope, openLocalVault, type VaultV1 } from '../lib/crypto/vault';
import type { EnvelopeV1 } from '../lib/crypto/encrypt';
import { parseIndependentBackup, type IndependentBackup } from '../lib/independentBackup';
import { retrieveDirectReceipt, retrieveDirectTransaction } from '../lib/directArweave';
import { recoverIndependentVaultFromWords } from '../lib/recovery/recoverIndependent';
import { retrieveHistoricalNative, retrieveNativeVault } from '../lib/recovery/historicalNative';
import { active, scoped } from '../lib/directArweave/network';
import { listIndependentVaultVersions } from '../lib/independentDiscovery';
import type { VerifiedVersion } from '../lib/recovery/types';
import type { TreeStore } from '../lib/types';
import { coerceTreeStore } from '../lib/treeJson';
import { loadDraftTree } from '../lib/draftStorage';
import { activePersons } from '../lib/treeEngine';
import { assertDraftWriteToken, currentDraftWriteToken } from '../lib/draftOwnership';
import { acceptVaultVersion } from '../lib/vaultSession/selection';
import { archiveLocalVaultVersion, getLocalVaultVersion } from '../lib/vaultSession/localArchive';
import { useI18n } from '../lib/i18n/I18nProvider';
import { independentMessages } from '../lib/independentMessages';
import { readDirectNodePreference, saveDirectNodePreference } from '../lib/directArweave/nodePreference';

type Props = { onRestored: (store?: TreeStore) => void; onBack: () => void };
export function RestoreSeed({ onRestored, onBack }: Props) {
  const { locale, t } = useI18n(), copy = independentMessages[locale];
  const [draftToken] = useState(currentDraftWriteToken);
  const nodeError = locale === 'ru' ? 'Адрес узла недействителен. Укажите HTTPS-адрес или очистите поле узла и повторите действие.' : locale === 'kk' ? 'Түйін мекенжайы жарамсыз. HTTPS мекенжайын көрсетіңіз немесе өрісті тазалап, әрекетті қайталаңыз.' : 'The node address is invalid. Enter an HTTPS origin or clear the node field and retry the action.';
  const [initialNode] = useState(() => {
    try { return { value: readDirectNodePreference() ?? '', error: '' }; }
    catch (error) { return { value: '', error: error instanceof Error ? error.message : 'storage_unavailable' }; }
  });
  const [words, setWords] = useState('');
  const [txId, setTxId] = useState('');
  const [gateway, setGateway] = useState(initialNode.value);
  const [file, setFile] = useState<{ name: string; backup: Exclude<IndependentBackup, { kind: 'words' }> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialNode.error ? /storage/.test(initialNode.error) ? copy.localQuota : nodeError : '');
  const [status, setStatus] = useState('');
  const [versions, setVersions] = useState<VerifiedVersion[]>([]);
  const [local, setLocal] = useState<VaultV1 | null>(null);
  const running = useRef(false);
  const alive = useRef(false), operationAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; operationAbort.current?.abort(); };
  }, []);
  function ensureActive() {
    if (!alive.current || operationAbort.current?.signal.aborted) throw Error('aborted');
    assertDraftWriteToken(draftToken);
  }
  function options() {
    ensureActive();
    const selected = saveDirectNodePreference(gateway);
    return { ...(selected ? { nodes: [selected] } : {}), signal: operationAbort.current?.signal };
  }

  async function finish(vault: VaultV1, envelope: EnvelopeV1 | null, head: string | null, parent: string | null, phrase: string) {
    ensureActive();
    const keys = deriveKeysFromMnemonic(phrase);
    if (!envelope) {
      // The button opens the current local copy. Read and decrypt the same
      // envelope together, rather than pairing a stale React vault with a
      // cache that another tab could have replaced since discovery.
      const cached = localStorage.getItem('sejire.envelope.' + keys.vaultId);
      if (!cached) throw Error('storage_unavailable');
      envelope = parseEnvelope(JSON.parse(cached));
      vault = await openEnvelope(keys, envelope);
    }
    // Navigation can unmount this screen while a fetch or decryption is still
    // pending. Its late result must not prompt, select a vault, or replace edits.
    ensureActive();
    if (!vault || vault.schema !== 'sejire/vault/v1' || vault.vault_id !== keys.vaultId ||
      !vault.trees || typeof vault.trees !== 'object' || Array.isArray(vault.trees) ||
      Object.entries(vault.trees).some(([id, tree]) => id === '__proto__' || id === 'constructor' || !coerceTreeStore(tree)) ||
      (vault.active_tree_id !== null && !Object.hasOwn(vault.trees, vault.active_tree_id))) throw Error('invalid_backup');
    const tree = coerceTreeStore(vault.active_tree_id ? vault.trees[vault.active_tree_id] : Object.values(vault.trees)[0]);
    if (!tree) throw Error('invalid_backup');
    const existing = loadDraftTree();
    if (existing && activePersons(existing.draft).length && !window.confirm(t.restore.replaceDraft)) return;
    ensureActive();
    if (envelope) {
      parseEnvelope(envelope);
      if (envelope.vault_id !== keys.vaultId) throw Error('invalid_backup');
      if (head) {
        archiveLocalVaultVersion({ id: head, vaultId: keys.vaultId, parentId: parent, source: 'network', envelope });
        const saved = getLocalVaultVersion(keys.vaultId, head);
        if (!saved || saved.parentId !== parent || serializeEnvelope(saved.envelope) !== serializeEnvelope(envelope)) throw Error('storage_unavailable');
      }
    }
    const accepted = acceptVaultVersion({ vault, envelope, mnemonic: phrase, session: {
      vaultId: keys.vaultId, headTxId: head, source: head ? 'network' : file ? 'file' : 'local',
    } }, () => true, draftToken);
    if (!accepted) return;
    onRestored(accepted);
  }
  async function openId(id: string, phrase: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) throw Error('invalid_transaction');
    const selectedOptions = options();
    // The signed native header and original data root bind this ID to these
    // exact bytes. A gateway response alone is not a confirmation proof.
    try {
      const result = await retrieveDirectTransaction(id, selectedOptions);
      const keys = deriveKeysFromMnemonic(phrase);
      const vault = await openEnvelope(keys, result.envelope);
      await finish(vault, result.envelope, id, result.receipt.parentTxId, phrase);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'receipt_invalid') throw error;
      // Historical native saves have their own signed tag contract. Their
      // reader retains signature/data-root/AES checks without relaxing the
      // modern writer or pretending that an old receipt is a new one.
      const result = await retrieveHistoricalNative(id, phrase, selectedOptions);
      await finish(result.vault, result.envelope, id, result.parentTxId, phrase);
    }
  }
  async function run(action: () => Promise<void>) {
    if (running.current || !alive.current) return;
    const controller = new AbortController(); operationAbort.current = controller;
    running.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (e) {
      if (!alive.current || controller.signal.aborted) return;
      const code = e instanceof Error ? e.message : '';
      setError(code === 'invalid_node' ? nodeError : /storage/.test(code) ? copy.localQuota : /network|unavailable|confirmation|receipt/.test(code) ? copy.noArchive : copy.badFile);
    } finally {
      if (operationAbort.current === controller) operationAbort.current = null;
      running.current = false;
      if (alive.current) { setBusy(false); setStatus(''); }
    }
  }
  async function choose(selected?: File) {
    if (!selected) return;
    await run(async () => {
      if (selected.size > MAX_BACKUP_BYTES * 2 + 16_384) throw Error('invalid_backup');
      const backup = await parseIndependentBackup(await selected.text());
      ensureActive();
      if (backup.kind === 'words') { setWords(backup.mnemonic); return; }
      setFile({ name: selected.name, backup }); setVersions([]); setLocal(null);
    });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const phrase = normalizeMnemonic(words);
    if (!isValidMnemonic(phrase)) { setError(t.restore.needWords); return; }
    await run(async () => {
      const keys = deriveKeysFromMnemonic(phrase);
      setVersions([]); setLocal(null);
      const backup = file?.backup;
      if (backup?.kind === 'vault') {
        // A portable file does not need the network. An attached locator is
        // descriptive; it must not silently become a verified on-chain HEAD.
        await finish(await openEnvelope(keys, backup.envelope), backup.envelope, null, null, phrase);
        return;
      }
      if (backup?.kind === 'receipt') {
        if (backup.receipt.vaultId !== keys.vaultId) throw Error('invalid_backup');
        setStatus(copy.search);
        const envelope = await retrieveDirectReceipt(backup.receipt, options());
        await finish(await openEnvelope(keys, envelope), envelope, backup.receipt.transactionId, backup.receipt.parentTxId, phrase);
        return;
      }
      const known = backup?.kind === 'legacyLocator' ? backup.txId : txId.trim();
      if (known) { setStatus(copy.search); await openId(known, phrase); return; }
      setStatus(copy.search);
      const selectedOptions = options(), selected = selectedOptions.nodes?.[0];
      const localVault = await openLocalVault(keys);
      ensureActive();
      setLocal(localVault);
      if (selected) {
        const verified: VerifiedVersion[] = [];
        await scoped(selectedOptions, async scopedOptions => {
          const listed = await listIndependentVaultVersions(keys.vaultId, { node: selected, limit: 15, signal: scopedOptions.signal });
          for (const candidate of listed) {
            active(scopedOptions.signal);
            try {
              const version = await retrieveNativeVault(candidate.txId, keys, scopedOptions);
              verified.push({ ...version, txId: candidate.txId, blockHeight: null,
                blockTimestamp: candidate.blockTimestamp, sources: [selected] });
            } catch { active(scopedOptions.signal); }
          }
        }).catch(() => { /* Keep any verified versions and the separately selectable local file. */ });
        ensureActive();
        if (verified.length) { setVersions(verified); setStatus(copy.partial); }
        else if (!localVault) throw Error('archive_unavailable');
        else setError(copy.noArchive);
        return;
      }
      const found = await recoverIndependentVaultFromWords(phrase, { signal: selectedOptions.signal });
      ensureActive();
      if (found.ok) {
        // Searching can be incomplete or contain forks. The owner chooses the
        // version; openId verifies its signed header before adopting its HEAD.
        setVersions(found.versions); setStatus(copy.partial);
      } else if (!localVault) throw Error('archive_unavailable');
      else setError(copy.noArchive);
    });
  }
  return <main className="landing"><section className="independent-restore">
    <h1>{copy.lookupTitle}</h1><p>{copy.lookupLead}</p>
    <form onSubmit={submit}>
      <label>{copy.words}<textarea rows={3} value={words} disabled={busy} onChange={e => { setWords(e.target.value); setVersions([]); setLocal(null); }} autoComplete="off" autoCorrect="off" spellCheck={false} required /></label>
      <label>{copy.chooseFile}<input type="file" accept="application/json,.json" disabled={busy} onChange={e => void choose(e.target.files?.[0])} /></label>
      {file && <div><p className="break-anywhere">{file.name}</p>{file.backup.kind === 'vault' && <p className="sub">{copy.localRecovery}</p>}
        <button type="button" className="welcome-link-quiet" disabled={busy} onClick={() => setFile(null)}>{copy.clearFile}</button></div>}
      {!file && <label>{copy.transaction}<input value={txId} onChange={e => setTxId(e.target.value)} disabled={busy} autoComplete="off" spellCheck={false} maxLength={43} /></label>}
      {file?.backup.kind !== 'vault' && <details><summary>{copy.node}</summary><label>{copy.node}<input value={gateway} type="url" placeholder="https://node.example.org" onChange={e => setGateway(e.target.value)} disabled={busy} autoComplete="off" /></label><p className="sub">{copy.nodeHint}</p>
        <p className="sub">{locale === 'ru' ? `Адрес применяется после нажатия «${copy.recover}» и сохраняется для этой вкладки, включая перезагрузку. Пустое поле возвращает узлы по умолчанию. Если узел не поддерживает поиск, укажите ID транзакции или откройте файл.` : locale === 'kk' ? 'Мекенжай қалпына келтіруді бастағанда қолданылып, осы қойындыда, қайта жүктегенде де сақталады. Бос өріс әдепкі түйіндерді қайтарады. Түйін іздеуді қолдамаса, транзакция ID-сін көрсетіңіз немесе файлды ашыңыз.' : 'The address is applied when you restore and is kept for this tab, including reloads. An empty field restores the default nodes. If the node has no search index, enter a transaction ID or open a file.'}</p>
      </details>}
      <div className="actions"><button type="submit" className="btn" disabled={busy}>{copy.recover}</button><button type="button" className="btn ghost" disabled={busy} onClick={onBack}>{copy.back}</button></div>
    </form>
    {status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
    {(versions.length > 0 || local) && <section><h2>{copy.chooseVersion}</h2><p className="sub">{copy.partial}</p>
      <ul className="direct-history-list">{versions.map(version => <li key={version.txId}><code className="break-anywhere">{version.txId}</code>
        <button className="btn ghost" type="button" disabled={busy} onClick={() => void run(() => openId(version.txId, normalizeMnemonic(words)))}>{copy.open}</button></li>)}</ul>
      {local && <button className="btn ghost" type="button" disabled={busy} onClick={() => void run(() => finish(local, null, null, null, normalizeMnemonic(words)))}>{t.restore.localCopy}</button>}
    </section>}
    <p><a href="./recovery/recovery.html" download="sejire-recovery.html">{copy.offlineTool}</a></p>
  </section></main>;
}
