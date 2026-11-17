import { useCallback, useEffect, useRef, useState, type ComponentProps, type FormEvent } from 'react';
import type { PublishSeedModal as LegacyPublishSeedModal } from './PublishSeedModal';
import { createMnemonic, isValidMnemonic, normalizeMnemonic, splitWords } from '../lib/crypto/bip39';
import { deriveKeysFromMnemonic } from '../lib/crypto/keys';
import { downloadSeedBackup } from '../lib/crypto/seedBackup';
import { encryptJson } from '../lib/crypto/encrypt';
import { putTree } from '../lib/crypto/vault';
import { loadIndependentVaultForPublish } from '../lib/independentVault';
import { createDirectOperation, listDirectOperations } from '../lib/directArweave';
import { finalizeIndependentOperation } from '../lib/independentFinalization';
import type { DirectOperation } from '../lib/directArweave/types';
import { assertNoLegacyPreservation, hasLegacyPreservation } from '../lib/legacyPreservationGuard';
import { getSessionMnemonic, getVaultSession, setVaultSessionChecked } from '../lib/vaultSession/session';
import { setLocalJson } from '../lib/storageQuota';
import { useI18n } from '../lib/i18n/I18nProvider';
import { independentMessages } from '../lib/independentMessages';
import { DirectArweaveFlow } from './DirectArweaveFlow';
import { DirectSaveHistory } from './DirectSaveHistory';
import { LegacyPreservationNotice } from './LegacyPreservationNotice';

type Props = ComponentProps<typeof LegacyPublishSeedModal>;
type Mode = 'checking' | 'intro' | 'show' | 'confirm' | 'existing' | 'ready' | 'flow' | 'pending' | 'legacy';
export function PublishSeedModal({ store, onClose, onPublished, parentTxId, knownMnemonic }: Props) {
  const { t, locale } = useI18n(), copy = independentMessages[locale];
  const [phrase, setPhrase] = useState(() => knownMnemonic ?? getSessionMnemonic() ?? '');
  const [repeated, setRepeated] = useState('');
  const [mode, setMode] = useState<Mode>('checking');
  const [operationId, setOperationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(0);
  const fresh = useRef(false), wordsConfirmed = useRef(false), running = useRef(false), alive = useRef(false);
  const phraseRef = useRef(phrase); phraseRef.current = phrase;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    void Promise.all([hasLegacyPreservation(), listDirectOperations()]).then(([legacy, operations]) => {
      if (!active) return;
      if (legacy) setMode('legacy');
      else if (operations.some(op => op.state !== 'complete' && op.state !== 'cancelled')) setMode('pending');
      else setMode(isValidMnemonic(phraseRef.current) ? 'ready' : 'intro');
    }).catch(() => { if (active) { setError(copy.legacyJournal); setMode('checking'); } });
    return () => { active = false; };
  }, [checked, copy.legacyJournal]);

  const requestClose = useCallback(() => {
    if (busy || running.current) return;
    if (fresh.current && !wordsConfirmed.current && !window.confirm(t.publish.discardConfirm)) return;
    onClose();
  }, [busy, onClose, t.publish.discardConfirm]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); requestClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

  async function prepare() {
    if (running.current) return;
    running.current = true; setBusy(true); setError('');
    try {
      const normalized = normalizeMnemonic(phrase);
      if (!isValidMnemonic(normalized)) throw Error(t.publish.badMnemonic);
      await assertNoLegacyPreservation();
      if ((await listDirectOperations()).some(op => op.state !== 'complete' && op.state !== 'cancelled')) { if (alive.current) setMode('pending'); return; }
      const keys = deriveKeysFromMnemonic(normalized);
      const session = getVaultSession();
      const parent = session?.vaultId === keys.vaultId ? parentTxId ?? session.headTxId : null;
      const loaded = await loadIndependentVaultForPublish(keys, { parentTxId: parent, freshKey: fresh.current });
      if (!alive.current) return;
      const envelope = await encryptJson(keys.encKey, keys.vaultId, putTree(loaded.vault, store));
      // The durable operation is committed before replacing the generic local
      // cache. A racing earlier operation can never lose its original bytes.
      const op = await createDirectOperation({ envelope, treeId: store.meta.id, parentTxId: loaded.parentTxId });
      if (!alive.current) return;
      if (!setLocalJson('sejire.envelope.' + keys.vaultId, envelope)) throw Error(copy.localQuota);
      setVaultSessionChecked({ vaultId: keys.vaultId, headTxId: loaded.parentTxId, source: 'local' }, normalized);
      fresh.current = false;
      setOperationId(op.id); setMode('flow');
    } catch (e) {
      if (!alive.current) return;
      const code = e instanceof Error ? e.message : '';
      if (code === 'legacy_preservation_requires_original_app') setMode('legacy');
      else if (code === 'pending_direct_operation') setMode('pending');
      else setError(code === 'legacy_journal_unavailable' ? copy.legacyJournal :
        /storage|quota/i.test(code) ? copy.localQuota : code || copy.genericError);
    } finally { running.current = false; if (alive.current) setBusy(false); }
  }

  async function complete(candidate: DirectOperation) {
    const { operation: op } = await finalizeIndependentOperation(candidate.id);
    if (!op.txId) throw Error('confirmation_pending');
    if (alive.current) onPublished({ mode: 'arweave', txId: op.txId, isNewVersion: Boolean(op.parentTxId) });
  }

  function confirmWords(event: FormEvent) {
    event.preventDefault(); setError('');
    if (normalizeMnemonic(repeated) !== phrase) { setError(t.publish.badMnemonic); return; }
    wordsConfirmed.current = true; setRepeated(''); setMode('ready');
  }
  const ready = isValidMnemonic(phrase);
  return <div className="modal-backdrop" role="presentation"><section className="modal independent-publish" role="dialog" aria-modal="true" aria-labelledby="independent-publish-title">
    <h2 id="independent-publish-title">{t.publish.title}</h2><p>{store.meta.title}</p>
    {mode === 'checking' && <p role="status">…</p>}
    {mode === 'legacy' && <LegacyPreservationNotice blocked />}
    {mode === 'pending' && <DirectSaveHistory pendingOnly onBack={requestClose} />}
    {mode === 'intro' && <div className="actions">
      <button className="btn" type="button" onClick={() => { setPhrase(createMnemonic()); fresh.current = true; wordsConfirmed.current = false; setError(''); setMode('show'); }}>{copy.createWords}</button>
      <button className="btn ghost" type="button" onClick={() => { setPhrase(''); setMode('existing'); }}>{copy.haveWords}</button>
    </div>}
    {mode === 'show' && <><p>{copy.newWordsHint}</p><ol className="seed-grid">{splitWords(phrase).map((word, i) => <li key={i}><span>{i + 1}.</span> {word}</li>)}</ol>
      <button className="btn" type="button" onClick={() => setMode('confirm')}>{t.publish.iWrote}</button></>}
    {mode === 'confirm' && <form onSubmit={confirmWords}><label>{t.publish.repeat}<textarea rows={3} value={repeated} onChange={e => setRepeated(e.target.value)} autoComplete="off" autoCorrect="off" spellCheck={false} required /></label>
      <div className="actions"><button className="btn ghost" type="button" onClick={() => setMode('show')}>{copy.back}</button><button className="btn" type="submit">{t.next}</button></div></form>}
    {mode === 'existing' && <form onSubmit={e => { e.preventDefault(); if (!ready) setError(t.publish.badMnemonic); else { setPhrase(normalizeMnemonic(phrase)); fresh.current = false; wordsConfirmed.current = true; setError(''); setMode('ready'); } }}>
      <p className="sub">{copy.restoreFirst}</p><label>{copy.words}<textarea rows={3} value={phrase} onChange={e => setPhrase(e.target.value)} autoComplete="off" autoCorrect="off" spellCheck={false} required /></label>
      <button className="btn" type="submit">{t.next}</button></form>}
    {mode === 'ready' && <><p>{copy.newWordsHint}</p><p>{copy.exportReady}</p>
      <div className="actions"><button className="btn ghost" type="button" disabled={busy || !ready} onClick={() => downloadSeedBackup(phrase)}>{t.publish.seedJson}</button>
        <button className="btn" type="button" disabled={busy || !ready} onClick={() => void prepare()}>{busy ? t.publish.encrypting : copy.seal}</button></div></>}
    {mode === 'flow' && operationId && <DirectArweaveFlow operationId={operationId} onBack={requestClose} onBusy={setBusy} onComplete={complete} />}
    {error && <p role="alert">{error}</p>}
    {mode === 'checking' && error && <button className="btn ghost" type="button" onClick={() => { setError(''); setChecked(n => n + 1); }}>{copy.retry}</button>}
    {mode !== 'flow' && mode !== 'pending' && <button className="btn ghost" type="button" disabled={busy} onClick={requestClose}>{copy.close}</button>}
  </section></div>;
}
