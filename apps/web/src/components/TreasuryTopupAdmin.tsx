import { useEffect, useRef, useState } from 'react';
import { confirmTreasuryTopup, prepareTreasuryTopup, readTreasuryTopups, type TreasuryTopup, type TreasuryTopups } from '../lib/fund/adminClient';
import { AdminScope, adminError, parseAdminAr, type AdminRequest } from '../lib/fund/adminScope';
import { formatAr } from '../lib/fund/client';
import { TreasuryTransferPanel } from './TreasuryTransferPanel';

type PreparedRequest = { requestId: string; address: string; amountWinston: string; expectedRevision: number };
const makeId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
const when = (at: number | null) => at === null ? '—' : new Date(at).toLocaleString();

export function TreasuryTopupAdmin({ credential }: { credential: string }) {
  const scope = useRef(new AdminScope()), pendingPrepare = useRef<PreparedRequest | null>(null);
  const pageById = useRef(new Map<string, string | null>());
  const [data, setData] = useState<TreasuryTopups | null>(null);
  const [address, setAddress] = useState(''), [amount, setAmount] = useState('');
  const [selectedId, setSelectedId] = useState(''), [txId, setTxId] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);
  const locked = busy || transferBusy;
  function finish(request: AdminRequest) {
    if (!scope.current.current(request)) return;
    setBusy(false); scope.current.finish(request);
  }
  function accept(next: TreasuryTopups, cursor: string | null = null, append = false) {
    for (const row of next.intents) pageById.current.set(row.id, cursor);
    setData(previous => !append || !previous ? next : { ...next,
      intents: [...previous.intents.filter(row => !next.intents.some(fresh => fresh.id === row.id)), ...next.intents] });
    setAddress(previous => next.treasuries.some(row => row.address === previous) ? previous : next.treasuries[0]?.address ?? '');
  }
  async function load(cursor: string | null = null) {
    if (transferBusy) return;
    let request;
    try { request = scope.current.begin(); } catch { return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await readTreasuryTopups(request.credential, request.signal, cursor);
      if (!scope.current.current(request)) return;
      accept(next, cursor, cursor !== null);
      const pending = pendingPrepare.current;
      const recovered = pending && next.intents.find(row => row.id === pending.requestId && row.address === pending.address && row.amountWinston === pending.amountWinston);
      if (pending && recovered) {
        setSelectedId(pending.requestId); pendingPrepare.current = null; setUncertain(false); setAmount('');
        setMessage(recovered.status === 'credited' ? 'Пополнение уже учтено. Новый перевод по этой заявке не требуется.' : 'Подготовленная заявка найдена в журнале. Используйте её реквизиты для перевода.');
      } else if (pending) {
        const latest = next.treasuries.find(row => row.address === pending.address);
        if (latest) pendingPrepare.current = { ...pending, expectedRevision: latest.revision };
      }
    } catch (failure) {
      if (scope.current.current(request)) { setData(null); setError(adminError(failure)); }
    } finally { finish(request); }
  }
  useEffect(() => {
    const current = scope.current;
    current.replace(credential); pendingPrepare.current = null; pageById.current.clear();
    setData(null); setSelectedId(''); setTxId(''); setAmount(''); setUncertain(false); setMessage('');
    void load();
    return () => { current.clear(); pendingPrepare.current = null; pageById.current.clear(); };
  }, [credential]);
  const treasury = data?.treasuries.find(row => row.address === address);
  const selected = data?.intents.find(row => row.id === selectedId) ?? null;
  const selectedTreasury = data?.treasuries.find(row => row.address === selected?.address);
  let amountWinston: string | null = null;
  try { const n = parseAdminAr(amount); if (BigInt(n) > 0n) amountWinston = n; } catch { /* The button stays disabled. */ }

  async function readback(request: AdminRequest, id: string, cursor: string | null = null) {
    const seen = new Set<string>();
    // The durable row cursor stays valid when a different session adds new intents.
    // GET pages only; this never repeats a mutation while seeking its result.
    for (;;) {
      const next = await readTreasuryTopups(request.credential, request.signal, cursor);
      if (!scope.current.current(request)) return null;
      const found = next.intents.find(row => row.id === id);
      if (found) { accept(next, cursor); return { next, found }; }
      if (!next.hasMore || !next.cursor || seen.has(next.cursor)) throw Error('admin_readback_mismatch');
      seen.add(next.cursor); cursor = next.cursor;
    }
  }
  async function prepare() {
    if (locked || !treasury || amountWinston === null && !pendingPrepare.current) return;
    const input = pendingPrepare.current ?? { requestId: makeId(), address: treasury.address, amountWinston: amountWinston!, expectedRevision: treasury.revision };
    if (!pendingPrepare.current && !window.confirm(`Подготовить пополнение ${formatAr(input.amountWinston, 12)} AR?\n\nСначала сервер создаст заявку. Переводите средства только после появления подтверждённых реквизитов.`)) return;
    let request;
    try { request = scope.current.begin(); } catch { return; }
    pendingPrepare.current = input; setBusy(true); setError(''); setMessage('');
    try {
      const result = await prepareTreasuryTopup(request.credential, input, request.signal);
      if (!scope.current.current(request)) return;
      if (result.intent.id !== input.requestId || result.intent.address !== input.address || result.intent.amountWinston !== input.amountWinston) throw Error('admin_readback_mismatch');
      const checked = await readback(request, input.requestId);
      if (!checked || !scope.current.current(request)) return;
      if (checked.found.address !== input.address || checked.found.amountWinston !== input.amountWinston) throw Error('admin_readback_mismatch');
      pendingPrepare.current = null; setUncertain(false); setSelectedId(input.requestId); setTxId(''); setAmount('');
      setMessage(checked.found.status === 'credited' ? 'Пополнение уже учтено. Новый перевод по этой заявке не требуется.' : 'Заявка сохранена и проверена на сервере. Теперь можно выполнить один перевод по её реквизитам.');
    } catch (failure) {
      if (scope.current.current(request)) {
        setUncertain(true); setError(adminError(failure));
        setMessage('Подготовка ещё не подтверждена. Сначала обновите журнал. Повтор подготовки использует тот же номер заявки; новый перевод не выполняйте.');
      }
    } finally { finish(request); }
  }
  async function confirm() {
    if (locked || !selected || !selected.transferTag || !selectedTreasury || !/^[A-Za-z0-9_-]{43}$/.test(txId)) return;
    const expected = selected, submittedTx = txId, revision = selectedTreasury.revision;
    if (!window.confirm(`Проверить перевод ${submittedTx} и учесть ${formatAr(expected.amountWinston, 12)} AR для заявки ${expected.id}?`)) return;
    let request;
    try { request = scope.current.begin(); } catch { return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await confirmTreasuryTopup(request.credential, expected.id, { txId: submittedTx, expectedRevision: revision }, request.signal);
      if (!scope.current.current(request)) return;
      if (result.intent.id !== expected.id || result.intent.status !== 'credited' || result.intent.txId !== submittedTx ||
          result.intent.creditedWinston !== expected.amountWinston) throw Error('admin_readback_mismatch');
      const checked = await readback(request, expected.id, pageById.current.get(expected.id) ?? null);
      if (!checked || !scope.current.current(request)) return;
      const confirmedTreasury = checked.next.treasuries.find(row => row.address === expected.address);
      if (!isCredited(checked.found, expected, submittedTx) || checked.found.creditedRevision !== result.intent.creditedRevision ||
          !confirmedTreasury || confirmedTreasury.revision < (checked.found.creditedRevision ?? Infinity)) throw Error('admin_readback_mismatch');
      setTxId(''); setMessage(result.reused ? 'Этот перевод уже учтён. Повторного увеличения доступного баланса нет.' : 'Пополнение подтверждено и учтено. Итог проверен повторным чтением сервера.');
    } catch (failure) {
      if (scope.current.current(request)) setError(adminError(failure));
    } finally { finish(request); }
  }
  return <section className="ops-desk-card" aria-label="Пополнение фонда AR">
    <h3>Пополнение фонда AR</h3>
    <p>Пополнение выполняется в три шага: подготовить заявку, отправить точную сумму AR с тегом этой заявки со своего другого кошелька, затем проверить публичную транзакцию.</p>
    <p>Сначала подготовьте заявку. Переводы, сделанные раньше, не увеличивают учтённый баланс повторно. Ключи и слова кошелька здесь не вводятся.</p>
    <button type="button" className="btn ghost" disabled={locked} onClick={() => void load()}>Обновить пополнения</button>
    {busy && <p role="status">Проверяем пополнения на сервере…</p>}
    {!data && <p>Учтённый баланс ещё не подтверждён. Загрузите данные перед действием.</p>}
    {data && <>
      <p>Проверено: {when(data.checkedAt)}. Для перевода нужно не менее {data.minimumConfirmations} подтверждений Arweave.</p>
      <label>Кошелёк для пополнения<select value={address} disabled={locked || uncertain} onChange={event => { setAddress(event.target.value); setMessage(''); }}>
        {data.treasuries.map(row => <option key={row.address} value={row.address}>{row.address}</option>)}
      </select></label>
      {treasury && <>
        <p>Адрес: <code>{treasury.address}</code></p>
        <p>Ревизия учёта: {treasury.revision}. Учтённый остаток: <strong>{treasury.ceilingWinston === null ? 'Ещё не зафиксирован' : `${formatAr(treasury.ceilingWinston, 12)} AR`}</strong>.</p>
        <p>Резервы: {formatAr(treasury.heldWinston, 12)} AR. Расходы, ещё не видимые в балансе узла: {formatAr(treasury.unobservedDebitWinston, 12)} AR.</p>
      </>}
      <label>Сумма нового пополнения (AR)<input inputMode="decimal" value={amount} disabled={locked || uncertain} autoComplete="off" placeholder="1.000000000000" onChange={event => { setAmount(event.target.value); setMessage(''); }} /></label>
      <button type="button" className="btn" disabled={locked || !treasury || amountWinston === null && !pendingPrepare.current} onClick={() => void prepare()}>
        {uncertain ? 'Повторить подготовку той же заявки' : 'Подготовить пополнение'}</button>
      <p>Подготовка заявки не переводит деньги. Новый учтённый остаток появится после проверки перевода. Общий лимит промофонда меняется отдельно.</p>
      <label>Заявка для перевода или проверки<select value={selectedId} disabled={locked} onChange={event => { setSelectedId(event.target.value); setTxId(''); setMessage(''); }}>
        <option value="">Выберите заявку</option>
        {data.intents.map(row => <option key={row.id} value={row.id}>{when(row.createdAt)} · {formatAr(row.amountWinston, 12)} AR · {row.status === 'credited' ? 'Учтено' : 'Подготовлено'} · {row.id}</option>)}
      </select></label>
      {selected && <div data-testid="admin-topup-selected">
        <p>Заявка: <code>{selected.id}</code> · {selected.status === 'credited' ? 'Учтено' : 'Подготовлено'}</p>
        <p>Получатель: <code>{selected.address}</code></p>
        {selected.status === 'prepared' && selected.transferTag ? <p>Отправьте ровно <strong>{formatAr(selected.amountWinston, 12)} AR</strong> нативным переводом AR с указанным ниже тегом. Комиссия отправителя оплачивается отдельно.</p> : selected.status === 'credited' ?
          <p>Учтённая сумма: <strong>{formatAr(selected.amountWinston, 12)} AR</strong>. Новый перевод по этой заявке не требуется.</p> : null}
        {selected.status === 'prepared' && (selected.transferTag ? <>
          <p><strong>Обязательный тег перевода.</strong> Перевод без этого тега или с другим значением не будет учтён. Используйте способ отправки AR, который позволяет добавить точный тег в подписанную транзакцию.</p>
          <TreasuryTransferPanel key={selected.id} intent={selected} credential={credential} disabled={busy} onTransaction={setTxId} onBusy={setTransferBusy} />
          <details><summary>Реквизиты для другого кошелька</summary>
          <label>Имя тега пополнения<input readOnly value={selected.transferTag.name} /></label>
          <button type="button" className="btn ghost" onClick={() => void navigator.clipboard.writeText(selected.transferTag!.name).catch(() => setError('Не удалось скопировать. Выделите и скопируйте имя тега вручную.'))}>Скопировать имя тега</button>
          <label>Значение тега пополнения<input readOnly value={selected.transferTag.value} /></label>
          <button type="button" className="btn ghost" onClick={() => void navigator.clipboard.writeText(selected.transferTag!.value).catch(() => setError('Не удалось скопировать. Выделите и скопируйте значение тега вручную.'))}>Скопировать значение тега</button>
          </details>
        </> : <p role="alert">У этой старой заявки нет обязательного тега. Подготовьте новую заявку перед переводом. Старую транзакцию нельзя привязать к новой заявке.</p>)}
        <p>Подготовлено: {when(selected.createdAt)}; высота Arweave: {selected.baselineHeight}. Перевод должен подтвердиться в более позднем блоке.</p>
        {selected.status === 'credited' ? <p>Учтено {when(selected.confirmedAt)}, ревизия {selected.creditedRevision}. <a href={`https://arweave.net/${selected.txId}`} target="_blank" rel="noreferrer">Транзакция пополнения</a></p> : selected.transferTag ? <>
          <label>Публичный ID транзакции Arweave<input value={txId} disabled={locked} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={43} onChange={event => { setTxId(event.target.value.trim()); setMessage(''); }} /></label>
          <button type="button" className="btn" disabled={locked || !selectedTreasury || !/^[A-Za-z0-9_-]{43}$/.test(txId)} onClick={() => void confirm()}>Проверить и учесть пополнение</button>
          <p>Проверка не отправляет ещё один перевод. Если ответ задержался, сначала обновите журнал; тот же перевод учитывается только один раз.</p>
        </> : null}
      </div>}
      {data.hasMore && <button type="button" className="btn ghost" disabled={locked} onClick={() => void load(data.cursor)}>Показать предыдущие пополнения</button>}
    </>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </section>;
}
function isCredited(actual: TreasuryTopup, expected: TreasuryTopup, txId: string) {
  return actual.id === expected.id && actual.address === expected.address && actual.amountWinston === expected.amountWinston &&
    actual.status === 'credited' && actual.txId === txId && actual.creditedWinston === expected.amountWinston;
}
