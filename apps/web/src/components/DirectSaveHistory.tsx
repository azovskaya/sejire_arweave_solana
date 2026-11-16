import { useEffect, useState } from 'react';
import { importDirectOperation, listDirectOperations } from '../lib/directArweave';
import type { DirectOperation } from '../lib/directArweave/types';
import { DirectArweaveFlow } from './DirectArweaveFlow';
import { independentMessages } from '../lib/independentMessages';
import { useI18n } from '../lib/i18n/I18nProvider';
import { LegacyPreservationNotice } from './LegacyPreservationNotice';
import { hasLegacyPreservation } from '../lib/legacyPreservationGuard';

export function DirectSaveHistory({ onBack, pendingOnly = false }: { onBack: () => void; pendingOnly?: boolean }) {
  const { locale } = useI18n(), copy = independentMessages[locale];
  const [operations, setOperations] = useState<DirectOperation[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [legacy, setLegacy] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void Promise.all([listDirectOperations(), hasLegacyPreservation()]).then(([rows, old]) => {
      if (alive) { setOperations(rows); setLegacy(old); }
    }).catch(() => { if (alive) setError(copy.legacyJournal); });
    return () => { alive = false; };
  }, [selected, copy.legacyJournal]);
  if (selected) return <DirectArweaveFlow operationId={selected} onBack={() => setSelected(null)} />;
  const visible = operations?.filter(op => !pendingOnly || op.state !== 'complete' && op.state !== 'cancelled');
  async function importAttempt(file?: File) {
    if (!file || busy) return;
    setBusy(true); setError('');
    try {
      if (file.size > 40 * 1024 * 1024 + 32_768) throw Error('archive_too_large');
      const op = await importDirectOperation(JSON.parse(await file.text()));
      setSelected(op.id);
    } catch { setError(copy.genericError); }
    finally { setBusy(false); }
  }
  return <section className="direct-history" aria-label={copy.history}>
    <h2>{pendingOnly ? copy.pendingTitle : copy.history}</h2>
    {pendingOnly && <p>{copy.pendingInfo}</p>}
    {legacy && <LegacyPreservationNotice blocked />}
    {error && <p role="alert">{error}</p>}
    {!operations && !error && <p role="status">…</p>}
    {visible?.length === 0 && <p>{copy.historyEmpty}</p>}
    {!legacy && <div className="independent-notice"><label>{copy.importAttempt}<input type="file" accept="application/json,.json" disabled={busy} onChange={e => void importAttempt(e.target.files?.[0])} /></label><p className="sub">{copy.attemptHint}</p></div>}
    <ul className="direct-history-list">{visible?.map(op => <li key={op.id}>
      <strong>{op.state === 'complete' && op.lastError ? copy.availabilityPending : copy.states[op.state]}</strong><span>{new Date(op.createdAt).toLocaleString(locale)}</span>
      <code className="break-anywhere">{op.txId || op.archiveDigest}</code>
      <button className="btn ghost" type="button" onClick={() => setSelected(op.id)}>{copy.open}</button>
    </li>)}</ul>
    <button className="btn ghost" type="button" disabled={busy} onClick={onBack}>{copy.back}</button>
  </section>;
}
