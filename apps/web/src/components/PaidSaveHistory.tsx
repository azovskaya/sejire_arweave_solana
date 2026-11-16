import { useEffect, useState } from 'react';
import { listPaidPreservationAttempts } from '../lib/checkout/paidJournal';
import { paidAvailabilityUi } from '../lib/checkout/paidAvailabilityMessages';
import type { PaidOperation } from '../lib/checkout/paidTypes';
import { useI18n } from '../lib/i18n/I18nProvider';
import { formatUiDateTime } from '../lib/i18n/messages';
import { PaidSolanaFlow } from './PaidSolanaFlow';
import { PermawebMigrationNotice } from './PermawebMigrationNotice';

export function PaidSaveHistory({ onBack }: { onBack: () => void }) {
  const { locale } = useI18n(), copy = paidAvailabilityUi[locale];
  const [attempts, setAttempts] = useState<PaidOperation[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    setAttempts(null); setFailed(false);
    void listPaidPreservationAttempts().then(rows => { if (live) setAttempts(rows); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [refresh]);
  if (selected) return <PaidSolanaFlow input={{ mode: 'resume', operationId: selected }} onBack={() => {
    setSelected(null); setRefresh(value => value + 1);
  }} />;
  return <section className="checkout-panel" aria-label={copy.historyTitle}>
    <h1>{copy.historyTitle}</h1>
    <p>{copy.historyHint}</p>
    <PermawebMigrationNotice />
    {!attempts && !failed && <p role="status">{copy.loading}</p>}
    {failed && <p role="alert">{copy.historyError}</p>}
    {attempts?.length === 0 && <p>{copy.historyEmpty}</p>}
    {attempts && attempts.length > 0 && <ol className="paid-save-history">
      {attempts.map(op => <li key={op.id}>
        <p><strong>{formatUiDateTime(new Date(op.createdAt).toString(), locale, '')}</strong></p>
        <p>{op.localCompletion === 'released' ? copy.released : op.snapshot?.execution?.status === 'completed' ? copy.completed : copy.pending}</p>
        <p style={{ overflowWrap: 'anywhere' }}>{copy.order}: {op.order?.id ?? op.id}</p>
        <button className="btn ghost" type="button" onClick={() => setSelected(op.id)}>{copy.openAttempt}</button>
      </li>)}
    </ol>}
    {failed && <button className="btn ghost" type="button" onClick={() => setRefresh(value => value + 1)}>{copy.retry}</button>}
    <button className="btn ghost" type="button" onClick={onBack}>{copy.back}</button>
  </section>;
}
