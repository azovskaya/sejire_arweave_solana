import { useEffect, useRef, useState } from 'react';
import type { EnvelopeV1 } from '../lib/crypto/encrypt';
import { serializeEnvelope } from '../lib/crypto/envelope';
import { FundApiError, journalKey, preserveFunded, readFundOrder, validatePromo, type FundOrderResult, type FundOrderView } from '../lib/fund/client';
import { fundError, fundStatus, rejectedBeforeReservation, terminalFundStatus } from '../lib/fund/status';

const POLL_MS = 6000;
const validOrderId = /^[a-f0-9]{32}$/;
const steps = ['Запрос принят', 'Подтверждение Arweave', 'Архив проверен'];

type Props = { envelope: EnvelopeV1; onDone?: (order: FundOrderView) => void };

export function PromoFundedFlow({ envelope, onDone }: Props) {
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
  const context = useRef({ active: false });
  const saving = useRef(false);
  const reading = useRef(false);
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
    void journalKey(JSON.parse(archive) as EnvelopeV1).then(nextKey => {
      if (!live) return;
      let id: string | null;
      let rejection: string | null;
      try { id = sessionStorage.getItem(nextKey); rejection = sessionStorage.getItem(nextKey + ':rejected'); }
      catch { throw Error('storage_unavailable'); }
      if (id && !validOrderId.test(id)) throw Error('invalid_saved_order');
      setKey(nextKey);
      if (id) { setOrderId(id); setStartedAt(Date.now()); }
      if (id && rejection) {
        try {
          const saved = JSON.parse(rejection) as { version?: number; orderId?: string; code?: string };
          if (saved.version === 1 && saved.orderId === id && saved.code && rejectedBeforeReservation.has(saved.code)) {
            setRejected(saved.code); setError(fundError(new Error(saved.code)));
          }
        } catch { /* An unreadable hint must still check the existing order. */ }
      }
    }).catch(e => { if (live) setError(fundError(e)); })
      .finally(() => { if (live) setInitializing(false); });
    return () => { live = false; current.active = false; };
  }, [archive]);

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
        setCheckedAt(next.verification?.checkedAt ?? Date.now());
        setStartedAt(next.order.createdAt);
        setError('');
        failures = 0;
        finished = terminalFundStatus(next.order.status);
      } catch (e) {
        if (live) { failures++; setError(fundError(e)); }
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

  async function save() {
    if (saving.current || (orderId && !rejected) || !key || !code.trim()) return;
    const current = context.current;
    let attemptedId: string | null = null;
    saving.current = true; setSubmitting(true); setError(''); setStartedAt(Date.now());
    try {
      await validatePromo(code);
      if (!current.active) return;
      // Persist before the only order POST. A timeout must resume this request.
      const id = orderId || crypto.randomUUID().replace(/-/g, '');
      try { sessionStorage.setItem(key, id); sessionStorage.removeItem(key + ':rejected'); }
      catch { throw Error('storage_unavailable'); }
      setOrderId(id); setRejected(null); attemptedId = id;
      const next = await preserveFunded(envelope, code, id);
      if (!next.order || next.order.orderId !== id) throw Error('invalid_order_response');
      if (current.active) {
        setResult(next); setCheckedAt(next.verification?.checkedAt ?? Date.now());
        setStartedAt(next.order.createdAt); setCode('');
      }
    } catch (e) {
      if (current.active) {
        setError(fundError(e, attemptedId === null));
        if (attemptedId && e instanceof FundApiError && rejectedBeforeReservation.has(e.message)) {
          setRejected(e.message);
          try { sessionStorage.setItem(key + ':rejected', JSON.stringify({ version: 1, orderId: attemptedId, code: e.message })); }
          catch { /* Keep the id; a reload will conservatively check it. */ }
        }
      }
    } finally {
      saving.current = false;
      if (current.active) setSubmitting(false);
    }
  }

  function checkNow() {
    if (reading.current || submitting || terminal) return;
    setRefresh(value => value + 1);
  }

  function retryStopped() {
    if (!terminal || !order || order.arweaveTxId || !key) return;
    try { sessionStorage.removeItem(key); sessionStorage.removeItem(key + ':rejected'); }
    catch { setError(fundError(new Error('storage_unavailable'))); return; }
    setResult(null); setOrderId(''); setStartedAt(null); setCheckedAt(null);
    setCode(''); setError(''); setRejected(null);
  }

  function finish() {
    if (order?.status !== 'COMPLETED' || !order.arweaveTxId || !onDone) return;
    try { onDone(order); }
    catch { setError('Запись в Arweave подтверждена, но обновить историю в этом браузере пока не удалось. Сохраните ссылку Arweave TX; повторное сохранение не требуется.'); }
  }

  const tracking = Boolean((orderId && !rejected) || submitting);
  const presentation = fundStatus(order, result?.verification, submitting);
  const completed = order?.status === 'COMPLETED';
  const confirmed = completed || Boolean(result?.verification?.transactionConfirmed);
  const doneSteps = completed ? 3 : confirmed ? 2 : order ? 1 : 0;
  const delayed = !terminal && startedAt !== null && now - startedAt >= 60000;

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
      {delayed && <p className="funded-delay">Подтверждение занимает время. Продолжаем проверку автоматически. Повторно сохранять не нужно.</p>}
      {!terminal && <p className="funded-reassurance">Проверяем ту же попытку. Новая транзакция и повторное списание не запускаются.</p>}
      <div className="funded-actions">
        {!terminal && <button type="button" className="btn ghost" disabled={checking || submitting}
          onClick={checkNow}>{checking ? 'Проверяем…' : 'Проверить статус'}</button>}
        {completed && onDone && <button type="button" className="btn" onClick={finish}>Готово</button>}
        {terminal && !completed && !order?.arweaveTxId && <button type="button" className="btn ghost" onClick={retryStopped}>Попробовать снова</button>}
        {order?.arweaveTxId && <a href={'https://arweave.net/' + order.arweaveTxId} target="_blank" rel="noreferrer">Arweave TX ↗</a>}
      </div>
      {checkedAt !== null && <p className="funded-check-time">Статус проверен: {new Date(checkedAt).toLocaleTimeString('ru-RU')}</p>}
      <details className="funded-details">
        <summary>Данные сохранения</summary>
        <dl><dt>Номер запроса</dt><dd><code>{orderId}</code></dd>
          {order && <><dt>Размер архива</dt><dd>{order.archiveSizeBytes.toLocaleString('ru-RU')} байт</dd></>}
          {order?.arweaveTxId && <><dt>Транзакция Arweave</dt><dd><code>{order.arweaveTxId}</code></dd></>}
        </dl>
      </details>
    </>}
    {error && <p className="funded-error" role="alert">{error}</p>}
  </section>;
}
