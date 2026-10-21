import { useCallback, useEffect, useRef, useState } from 'react';
import type { EnvelopeV1 } from '../lib/crypto/encrypt';
import { serializeEnvelope } from '../lib/crypto/envelope';
import { FundApiError, journalKey, preserveFunded, readFundOrder, validatePromo, type FundOrderResult, type FundOrderView } from '../lib/fund/client';
import { fundError, fundStatus, rejectedBeforeReservation, terminalFundStatus } from '../lib/fund/status';
import { clearFundAttempt, findFundAttempt, saveFundAttempt } from '../lib/fund/journal';
import { rememberFundedPromo } from '../lib/fund/preference';
import { envelopeDigest } from '../lib/solana/policy';

const POLL_MS = 6000;
const validOrderId = /^[a-f0-9]{32}$/;
const steps = ['Запрос принят', 'Подтверждение Arweave', 'Архив проверен'];

async function assertCompletedArchive(order: FundOrderView, envelope: EnvelopeV1) {
  const archive = serializeEnvelope(envelope);
  if (order?.status !== 'COMPLETED' || !order.arweaveTxId || !/^[A-Za-z0-9_-]{43}$/.test(order.arweaveTxId) ||
      order.vaultId !== envelope.vault_id || order.archiveDigest !== await envelopeDigest(archive) ||
      order.archiveSizeBytes !== new TextEncoder().encode(archive).byteLength) throw Error('invalid_order_response');
}

type Props = {
  envelope: EnvelopeV1;
  parentTxId?: string | null;
  treeId?: string | null;
  autoSaveCode?: string | null;
  autoComplete?: boolean;
  onDone?: (order: FundOrderView) => void | Promise<void>;
};

export function PromoFundedFlow({ envelope, parentTxId, treeId, autoSaveCode, autoComplete = false, onDone }: Props) {
  const [code, setCode] = useState('');
  const [result, setResult] = useState<FundOrderResult | null>(null);
  const [orderId, setOrderId] = useState('');
  const [key, setKey] = useState('');
  const [initializing, setInitializing] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const [refresh, setRefresh] = useState(0);
  const [completing, setCompleting] = useState(false);
  const [completionError, setCompletionError] = useState(false);
  const context = useRef({ active: false });
  const saving = useRef(false);
  const reading = useRef(false);
  const finishing = useRef(false);
  const completionAttempt = useRef('');
  const autoStarted = useRef('');
  // Exact ciphertext keeps a parent render from resetting an active check.
  const archive = serializeEnvelope(envelope);
  const order = result?.order ?? null;
  const terminal = terminalFundStatus(order?.status);

  useEffect(() => {
    const current = { active: true };
    context.current = current;
    let live = true;
    setResult(null); setOrderId(''); setKey(''); setError('');
    setCheckedAt(null); setStartedAt(null); setInitializing(true); setSubmitting(false); setRejected(null);
    setCompleting(false); setCompletionError(false); completionAttempt.current = '';
    const exactEnvelope = JSON.parse(archive) as EnvelopeV1;
    void (async () => {
      const [keyResult, pendingResult] = await Promise.allSettled([
        journalKey(exactEnvelope),
        findFundAttempt({ vaultId: exactEnvelope.vault_id, treeId }),
      ]);
      if (!live) return;
      if (keyResult.status === 'rejected') throw keyResult.reason;
      const nextKey = keyResult.value;
      let pending;
      if (pendingResult.status === 'fulfilled') pending = pendingResult.value;
      else {
        // An imported original file can recover an old session-only ID even
        // when the old envelope cache is absent. The journal verifies both its
        // exact digest and ID; this path only resumes a GET, never a new POST.
        if (!(pendingResult.reason instanceof Error) || pendingResult.reason.message !== 'fund_attempt_in_progress') throw pendingResult.reason;
        let legacyId: string | null = null;
        try { legacyId = sessionStorage.getItem(nextKey); } catch { /* retain the original blocker */ }
        if (!legacyId || !validOrderId.test(legacyId)) throw pendingResult.reason;
        pending = await saveFundAttempt({ orderId: legacyId, envelope: exactEnvelope, parentTxId, treeId });
        if (!live) return;
      }
      if (pending) {
        if (serializeEnvelope(pending.envelope) === archive) {
          setKey(nextKey); setOrderId(pending.orderId); setStartedAt(pending.createdAt);
          return;
        }
        if (autoComplete || treeId) throw Error('fund_attempt_in_progress');
        // Standalone imports retain their success screen and support reopening
        // the same file. A different file can replace only a proven completion.
        const previous = await readFundOrder(pending.orderId);
        if (previous.order?.orderId !== pending.orderId || previous.order.status !== 'COMPLETED') throw Error('fund_attempt_in_progress');
        await assertCompletedArchive(previous.order, pending.envelope);
        if (!live) return;
        await clearFundAttempt(pending.orderId, pending.vaultId);
      }
      let id: string | null = null;
      let rejection: string | null = null;
      try { id = sessionStorage.getItem(nextKey); rejection = sessionStorage.getItem(nextKey + ':rejected'); }
      catch { /* The durable journal, not sessionStorage, protects a new save. */ }
      if (id && !validOrderId.test(id)) throw Error('invalid_saved_order');
      let savedRejection: string | null = null;
      if (id && rejection) {
        try {
          const saved = JSON.parse(rejection) as { version?: number; orderId?: string; code?: string };
          if (saved.version === 1 && saved.orderId === id && saved.code && rejectedBeforeReservation.has(saved.code)) {
            savedRejection = saved.code;
          }
        } catch { /* An unreadable hint must still check the existing order. */ }
      }
      if (id && !savedRejection) {
        await saveFundAttempt({ orderId: id, envelope: exactEnvelope, parentTxId, treeId });
      }
      if (!live) return;
      setKey(nextKey);
      if (id) { setOrderId(id); setStartedAt(Date.now()); }
      if (savedRejection) { setRejected(savedRejection); setError(fundError(new Error(savedRejection))); }
    })().catch(e => { if (live) setError(fundError(e)); })
      .finally(() => { if (live) setInitializing(false); });
    return () => { live = false; current.active = false; };
  }, [archive, parentTxId, treeId, autoComplete]);

  useEffect(() => {
    if (!orderId || submitting || terminal || rejected) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const controller = new AbortController();
    const tick = async () => {
      if (!live) return;
      reading.current = true;
      setChecking(true);
      let finished = false;
      try {
        const next = await readFundOrder(orderId, controller.signal);
        if (!next.order || next.order.orderId !== orderId) throw Error('invalid_order_response');
        if (!live) return;
        setResult(previous => previous?.order.status === 'COMPLETED' ? previous : next);
        // A completed request can report an unavailable provider. This marks
        // the attempt, not proof that Arweave confirmed the transaction.
        setCheckedAt(Date.now());
        setStartedAt(next.order.createdAt);
        setError('');
        failures = 0;
        finished = terminalFundStatus(next.order.status);
      } catch (e) {
        if (live) { failures++; setError(fundError(e)); setCheckedAt(Date.now()); }
      } finally {
        if (live) {
          reading.current = false;
          setChecking(false);
          // The delay starts after the response, so slow requests cannot pile up.
          if (!finished) timer = setTimeout(() => void tick(), Math.min(15000, POLL_MS + failures * 3000));
        }
      }
    };
    void tick();
    return () => {
      live = false; controller.abort(); clearTimeout(timer);
      reading.current = false;
    };
  }, [orderId, submitting, terminal, rejected, refresh]);

  useEffect(() => {
    if ((!orderId && !submitting) || terminal || rejected) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [orderId, submitting, terminal, rejected]);

  const save = useCallback(async (selectedCode = code) => {
    if (saving.current || (orderId && !rejected) || !key || !selectedCode.trim()) return;
    const current = context.current;
    let attemptedId: string | null = null;
    saving.current = true; setSubmitting(true); setError(''); setStartedAt(Date.now());
    try {
      const validation = await validatePromo(selectedCode);
      if (!validation.accepted) throw Error('promo_invalid');
      if (!current.active) return;
      rememberFundedPromo(envelope.vault_id, selectedCode);
      // Persist before the only order POST. A timeout must resume this request.
      const id = orderId || crypto.randomUUID().replace(/-/g, '');
      await saveFundAttempt({ orderId: id, envelope, parentTxId, treeId });
      try { sessionStorage.setItem(key, id); sessionStorage.removeItem(key + ':rejected'); }
      catch { /* The exact encrypted request is already durable. */ }
      attemptedId = id;
      if (current.active) { setOrderId(id); setRejected(null); }
      // Closing the dialog after journaling must not abandon the accepted click.
      const next = await preserveFunded(envelope, selectedCode, id);
      if (!next.order || next.order.orderId !== id) throw Error('invalid_order_response');
      if (current.active) {
        setResult(next); setCheckedAt(Date.now());
        setStartedAt(next.order.createdAt); setCode('');
      }
    } catch (e) {
      let safeRejection: string | null = null;
      if (attemptedId && e instanceof FundApiError && rejectedBeforeReservation.has(e.message)) {
        try {
          await clearFundAttempt(attemptedId, envelope.vault_id);
          safeRejection = e.message;
          try {
            sessionStorage.setItem(key, attemptedId);
            sessionStorage.setItem(key + ':rejected', JSON.stringify({ version: 1, orderId: attemptedId, code: e.message }));
          } catch { /* The server explicitly refused before reservation. */ }
        } catch { /* If cleanup fails, retain and check the existing request. */ }
      }
      if (current.active) {
        setError(fundError(e, attemptedId === null));
        if (safeRejection) setRejected(safeRejection);
      }
    } finally {
      saving.current = false;
      if (current.active) setSubmitting(false);
    }
  }, [code, orderId, rejected, key, envelope, parentTxId, treeId]);

  useEffect(() => {
    if (!autoSaveCode || initializing || !key || orderId || rejected || autoStarted.current === key) return;
    // Only a fresh, explicit Workspace click supplies autoSaveCode. StrictMode
    // cleanup cancels its first timer before validation or a POST can start.
    const timer = setTimeout(() => {
      autoStarted.current = key;
      setCode(autoSaveCode);
      void save(autoSaveCode);
    }, 0);
    return () => clearTimeout(timer);
  }, [autoSaveCode, initializing, key, orderId, rejected, save]);

  function checkNow() {
    if (reading.current || submitting || terminal) return;
    setRefresh(value => value + 1);
  }

  async function retryStopped() {
    if (!terminal || !order || order.arweaveTxId || !key) return;
    try {
      await clearFundAttempt(order.orderId, envelope.vault_id);
      sessionStorage.removeItem(key); sessionStorage.removeItem(key + ':rejected');
    }
    catch { setError(fundError(new Error('storage_unavailable'))); return; }
    setResult(null); setOrderId(''); setStartedAt(null); setCheckedAt(null);
    setCode(''); setError(''); setRejected(null);
  }

  const finish = useCallback(async () => {
    if (finishing.current || order?.status !== 'COMPLETED' || !order.arweaveTxId || !onDone) return;
    const current = context.current;
    finishing.current = true; setCompleting(true); setCompletionError(false); setError('');
    try {
      await assertCompletedArchive(order, JSON.parse(archive) as EnvelopeV1);
      if (!current.active) return;
      // The editor callback writes/read-checks local history and HEAD before
      // clearing its journal. Standalone imports have no editor to finalize.
      if (!autoComplete) await clearFundAttempt(order.orderId, envelope.vault_id);
      if (!current.active) return;
      await onDone(order);
    } catch {
      if (current.active) {
        setCompletionError(true);
        setError('Запись в Arweave подтверждена, но обновить историю в этом браузере пока не удалось. Ссылка Arweave TX сохранена. «Повторить завершение» обновит только историю, без нового сохранения и списания.');
      }
    } finally {
      finishing.current = false;
      if (current.active) setCompleting(false);
    }
  }, [order, onDone, envelope.vault_id, archive, autoComplete]);

  useEffect(() => {
    if (!autoComplete || !onDone || order?.status !== 'COMPLETED' || !order.arweaveTxId) return;
    const id = order.orderId + ':' + order.arweaveTxId;
    if (completionAttempt.current === id) return;
    const timer = setTimeout(() => {
      completionAttempt.current = id;
      void finish();
    }, 0);
    return () => clearTimeout(timer);
  }, [autoComplete, onDone, order, finish]);

  const tracking = Boolean((orderId && !rejected) || submitting);
  const presentation = fundStatus(order, result?.verification, submitting);
  const completed = order?.status === 'COMPLETED';
  const confirmed = completed || Boolean(result?.verification?.transactionConfirmed);
  const doneSteps = completed ? 3 : confirmed ? 2 : order ? 1 : 0;
  const delayed = !terminal && !submitting && !error && presentation.tone === 'pending' &&
    (confirmed || order?.status === 'SUBMITTED' || order?.status === 'VERIFYING') &&
    startedAt !== null && now - startedAt >= 60000;

  return <section className="funded-flow" aria-label="Сохранение по промокоду">
    <h2>Сохранение за счёт фонда</h2>
    <p className="funded-intro">Для вас бесплатно. Хранение оплачивает фонд SEJIRE.</p>
    {!tracking && <>
      {rejected && <h3>Сохранение не началось</h3>}
      <label>Промокод
        <input placeholder="Введите промокод" value={code} autoComplete="off"
          disabled={initializing || submitting} onChange={e => setCode(e.target.value)} />
      </label>
      <button type="button" className="btn funded-primary"
        disabled={initializing || submitting || !code.trim() || !key} onClick={() => void save()}>
        Сохранить бесплатно
      </button>
      {initializing && <p role="status">Проверяем предыдущие сохранения…</p>}
    </>}
    {tracking && <>
      <div className={'funded-status funded-status--' + presentation.tone} role="status" aria-live="polite" aria-atomic="true">
        <span className="funded-status-icon" aria-hidden="true">{completed ? '✓' : presentation.tone === 'attention' ? '!' : '…'}</span>
        <div><h3>{presentation.title}</h3><p>{presentation.description}</p></div>
      </div>
      <ol className="funded-steps" aria-label="Ход бесплатного сохранения">
        {steps.map((label, index) => <li key={label}
          className={index < doneSteps ? 'is-done' : index === doneSteps && !terminal ? 'is-current' : ''}
          aria-current={index === doneSteps && !terminal ? 'step' : undefined}>
          <span aria-hidden="true">{index < doneSteps ? '✓' : index + 1}</span>{label}
        </li>)}
      </ol>
      {delayed && <p className="funded-delay">{confirmed
        ? 'Проверка архива занимает время. Продолжаем автоматически проверять его доступность и целостность. Повторно сохранять не нужно.'
        : 'Подтверждение занимает время. Продолжаем проверку автоматически. Повторно сохранять не нужно.'}</p>}
      {!terminal && <p className="funded-reassurance">Проверяем ту же попытку. Новая транзакция и повторное списание не запускаются.</p>}
      <div className="funded-actions">
        {!terminal && <button type="button" className="btn ghost" disabled={checking || submitting}
          onClick={checkNow}>{checking ? 'Проверяем…' : 'Проверить статус'}</button>}
        {completed && onDone && (!autoComplete || completionError) && <button type="button" className="btn" disabled={completing}
          onClick={() => void finish()}>{completionError ? 'Повторить завершение' : 'Готово'}</button>}
        {completed && completing && <p role="status">Записываем результат в историю…</p>}
        {terminal && !completed && !order?.arweaveTxId && <button type="button" className="btn ghost" onClick={() => void retryStopped()}>Попробовать снова</button>}
      </div>
      {checkedAt !== null && <p className="funded-check-time">Последняя попытка проверки: {new Date(checkedAt).toLocaleString('ru-RU')}</p>}
      <details className="funded-details">
        <summary>Данные сохранения</summary>
        <dl><dt>Номер запроса</dt><dd><code>{orderId}</code></dd>
          {order && <><dt>Размер архива</dt><dd>{order.archiveSizeBytes.toLocaleString('ru-RU')} байт</dd></>}
          {order?.arweaveTxId && <><dt>Транзакция Arweave</dt><dd><code>{order.arweaveTxId}</code></dd></>}
        </dl>
        {order?.arweaveTxId && <p><a href={'https://arweave.net/tx/' + order.arweaveTxId} target="_blank" rel="noreferrer">Данные транзакции Arweave ↗</a></p>}
      </details>
    </>}
    {error && <p className="funded-error" role="alert">{error}</p>}
  </section>;
}
