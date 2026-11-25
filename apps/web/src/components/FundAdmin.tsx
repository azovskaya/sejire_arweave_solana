import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { SolanaRecipientsAdmin } from './SolanaRecipientsAdmin';
import { PaidOrdersAdmin } from './PaidOrdersAdmin';
import { TreasuryTopupAdmin } from './TreasuryTopupAdmin';
import { AdminScope, adminError, parseAdminAr, type AdminRequest } from '../lib/fund/adminScope';
import { formatAr, fundChangePromo, fundDashboard, fundEnable, fundLimit, fundReconcile, type FundDashboard } from '../lib/fund/client';

const date = (at: number | null) => at ? new Date(at).toLocaleString() : '—';
const size = (bytes: number | null) => bytes == null ? '—' : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;
type Tab = 'overview' | 'fund' | 'diagnostics';
type Props = { diagnostics?: ReactNode };

/** Server authorization is required. The credential exists only in this mounted component. */
export function FundAdmin({ diagnostics }: Props) {
  const scope = useRef(new AdminScope());
  const [password, setPassword] = useState(''), [credential, setCredential] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [data, setData] = useState<FundDashboard | null>(null);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [code, setCode] = useState(''), [confirm, setConfirm] = useState(''), [showCode, setShowCode] = useState(false), [limit, setLimit] = useState('');
  const [statusFilter, setStatusFilter] = useState('All'), [timeFilter, setTimeFilter] = useState('All time');
  const [tab, setTab] = useState<Tab>(() => location.hash.startsWith('#/admin/diagnostics') ? 'diagnostics' : 'overview');
  const [session, setSession] = useState(0);

  useEffect(() => {
    const requests = scope.current;
    const onHash = () => { if (location.hash.startsWith('#/admin/diagnostics')) setTab('diagnostics'); };
    window.addEventListener('hashchange', onHash);
    return () => { requests.clear(); window.removeEventListener('hashchange', onHash); };
  }, []);

  function clearSession() {
    scope.current.clear(); setCredential(''); setData(null); setPassword(''); setShowPassword(false);
    setError(''); setMessage(''); setBusy(false); setCode(''); setConfirm(''); setLimit(''); setShowCode(false);
    setSession(value => value + 1);
  }
  function finish(request: AdminRequest) {
    if (!scope.current.current(request)) return;
    setBusy(false); scope.current.finish(request);
  }
  async function login(event: FormEvent) {
    event.preventDefault();
    if (busy || !password.trim()) return;
    const selected = password;
    scope.current.replace(selected);
    const request = scope.current.begin();
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await fundDashboard(request.credential, request.signal);
      if (!scope.current.current(request)) return;
      setData(next); setCredential(selected); setPassword(''); setShowPassword(false); setSession(value => value + 1);
    } catch (failure) {
      if (scope.current.current(request)) { setData(null); setCredential(''); setError(adminError(failure)); }
    } finally { finish(request); }
  }
  async function refresh() {
    if (busy || !credential) return;
    const request = scope.current.begin();
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await fundDashboard(request.credential, request.signal);
      if (scope.current.current(request)) setData(next);
    } catch (failure) {
      if (scope.current.current(request)) { setData(null); setError(adminError(failure)); }
    } finally { finish(request); }
  }
  async function mutate(operation: (request: AdminRequest) => Promise<unknown>, accepted: (next: FundDashboard) => boolean,
    success: string | ((next: FundDashboard) => string), clearInput?: () => void) {
    if (busy || !credential || !data) return;
    const request = scope.current.begin();
    setBusy(true); setError(''); setMessage('');
    let readBack = false;
    try {
      await operation(request);
      if (!scope.current.current(request)) return;
      const next = await fundDashboard(request.credential, request.signal);
      if (!scope.current.current(request)) return;
      setData(next);
      readBack = true;
      if (!accepted(next)) throw Error('admin_readback_mismatch');
      setMessage(typeof success === 'function' ? success(next) : success);
      clearInput?.();
    } catch (failure) {
      if (scope.current.current(request)) { if (!readBack) setData(null); setError(adminError(failure)); }
    } finally { finish(request); }
  }

  const filtered = useMemo(() => data?.history.filter(row => {
    const status = statusFilter === 'All' || statusFilter === 'Pending' && ['RESERVED', 'SIGNED', 'SUBMITTED', 'VERIFYING', 'NEEDS_RECONCILIATION'].includes(row.status) ||
      statusFilter === 'Failed' && ['FAILED', 'RELEASED'].includes(row.status) || row.status === statusFilter.toUpperCase();
    return status && (timeFilter === 'All time' || row.createdAt >= Date.now() - (timeFilter === 'Today' ? 86400000 : 7 * 86400000));
  }) ?? [], [data, statusFilter, timeFilter]);
  let limitWinston: string | null = null, newRemaining: string | null = null;
  try {
    if (data && limit) {
      limitWinston = parseAdminAr(limit);
      newRemaining = formatAr((BigInt(limitWinston) - BigInt(data.actualSpentWinston) - BigInt(data.reservedWinston)).toString());
    }
  } catch { /* Invalid input cannot authorize an update. */ }
  const progress = data && BigInt(data.limitWinston) > 0n ? Number(BigInt(data.actualSpentWinston) * 10000n / BigInt(data.limitWinston)) / 100 : 0;

  return <section className="fund-admin" aria-label="Управление сохранениями">
    {!credential ? <form className="ops-desk-form" onSubmit={event => void login(event)}>
      <p>Войдите с паролем администратора сервера. Права проверяются сервером; слова кошелька и архива здесь не нужны.</p>
      <label>Пароль<input type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password}
        onChange={event => { clearSession(); setPassword(event.target.value); }} /></label>
      <button type="button" className="welcome-link-quiet" onClick={() => setShowPassword(value => !value)}>{showPassword ? 'Скрыть пароль' : 'Показать пароль'}</button>
      <button type="submit" className="btn" disabled={busy || !password.trim()}>Войти</button>
      {busy && <p role="status">Проверяем доступ на сервере…</p>}
    </form> : <>
      <div className="ops-desk-tabs" role="tablist" aria-label="Разделы администратора" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
        const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next].click(); tabs[next].focus();
      }}>
        <button type="button" role="tab" className={tab === 'overview' ? 'is-on' : ''} aria-selected={tab === 'overview'} onClick={() => setTab('overview')}>Обзор Solana</button>
        <button type="button" role="tab" className={tab === 'fund' ? 'is-on' : ''} aria-selected={tab === 'fund'} onClick={() => setTab('fund')}>Промокод и фонд</button>
        {diagnostics && <button type="button" role="tab" className={tab === 'diagnostics' ? 'is-on' : ''} aria-selected={tab === 'diagnostics'} onClick={() => setTab('diagnostics')}>Диагностика</button>}
      </div>
      <button type="button" className="btn ghost" onClick={clearSession}>Выйти</button>
      {tab === 'diagnostics' && diagnostics}
      {tab === 'overview' && <PaidOrdersAdmin key={session} credential={credential} />}
      {tab === 'fund' && <>
        <h2>Промокод и фонд Arweave</h2>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void refresh()}>Обновить фонд</button>
        {!data && <p>Состояние фонда не подтверждено. Обновите данные перед изменением настроек.</p>}
        {data && <>
          <SolanaRecipientsAdmin key={session} credential={credential} />
          <TreasuryTopupAdmin key={`topup-${session}`} credential={credential} />
          <div className="fund-admin-grid"><section className="ops-desk-card"><h3>Промокод</h3>
            <p>Состояние <strong>{data.promo.enabled ? 'Активен' : 'Отключён'}</strong></p>
            <p>Текущий код <strong>{data.promo.displayHint || '—'}</strong></p>
            <p>Версия {data.promo.revision} · Изменён {date(data.promo.updatedAt)}</p>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setShowCode(value => !value)}>Изменить промокод</button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => {
              const enabled = !data.promo.enabled;
              void mutate(request => fundEnable(request.credential, enabled, request.signal), next => next.promo.enabled === enabled,
                enabled ? 'Промокод включён. Настройка проверена на сервере.' : 'Промокод выключен. Начатые сохранения продолжаются.');
            }}>{data.promo.enabled ? 'Отключить промокод' : 'Включить промокод'}</button>
            {showCode && <div className="fund-admin-form">
              <label>Новый промокод<input value={code} disabled={busy} autoComplete="off" maxLength={64} onChange={event => setCode(event.target.value)} /></label>
              <label>Повторите новый промокод<input value={confirm} disabled={busy} autoComplete="off" maxLength={64} onChange={event => setConfirm(event.target.value)} /></label>
              <p>После смены прежний код перестанет действовать для новых сохранений. История и начатые запросы сохранятся.</p>
              <button type="button" className="btn" disabled={busy || !/^[A-Z0-9][A-Z0-9-]{5,63}$/.test(code.trim().toUpperCase()) || code !== confirm} onClick={() => {
                if (!window.confirm('Заменить действующий промокод? Прежний код больше не будет приниматься для новых сохранений.')) return;
                const normalized = code.trim().toUpperCase(), hint = `${normalized.slice(0, 4)}••••${normalized.slice(-2)}`, revision = data.promo.revision;
                void mutate(request => fundChangePromo(request.credential, code, confirm, request.signal),
                  next => next.promo.enabled && next.promo.revision === revision + 1 && next.promo.displayHint === hint,
                  'Новый промокод сохранён и проверен на сервере.', () => { setCode(''); setConfirm(''); setShowCode(false); });
              }}>Сохранить промокод</button>
            </div>}
            <p>По текущей версии: {data.currentRevisionTrees} сохранений · {formatAr(data.currentRevisionSpentWinston)} AR</p>
            <p>За всё время: {data.successfulTrees} сохранений · {formatAr(data.actualSpentWinston)} AR</p>
          </section><section className="ops-desk-card"><h3>Бюджет бесплатных сохранений</h3>
            <p>Кошелёк фонда <code>{data.treasuryAddress}</code></p>
            <p>Подписант: <strong>{data.signerVerified ? 'Адрес проверен' : 'Адрес не подтверждён'}</strong></p>
            <p>Баланс кошелька <strong>{data.walletBalanceWinston == null ? 'Не удалось проверить' : `${formatAr(data.walletBalanceWinston)} AR`}</strong></p>
            <p>Проверен {date(data.lastBalanceCheck)}</p>
            <p>Общий лимит промофонда <strong>{formatAr(data.limitWinston)} AR</strong></p>
            <p>Подтверждённые расходы <strong>{formatAr(data.actualSpentWinston)} AR</strong></p>
            <p>Зарезервировано <strong>{formatAr(data.reservedWinston)} AR</strong></p>
            <p>Остаток бюджета <strong>{formatAr(data.budgetRemainingWinston)} AR</strong></p>
            <p>Доступно сейчас <strong>{formatAr(data.effectiveAvailableWinston)} AR</strong></p>
            <progress max="100" value={progress} /><p>Потрачено {progress.toFixed(2)}% · {data.fundStatus}</p>
            <label>Новый общий лимит фонда (AR)<input inputMode="decimal" value={limit} disabled={busy} placeholder={formatAr(data.limitWinston)} onChange={event => setLimit(event.target.value)} /></label>
            <p>Остаток после расходов и резервов: {newRemaining ?? '—'} AR. Изменение лимита не пополняет кошелёк.</p>
            <button type="button" className="btn" disabled={busy || limitWinston === null || newRemaining === null || newRemaining.startsWith('-')} onClick={() => {
              const expected = limitWinston;
              void mutate(request => fundLimit(request.credential, limit, request.signal), next => next.limitWinston === expected,
                'Лимит фонда сохранён и проверен на сервере.', () => setLimit(''));
            }}>Сохранить лимит</button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => {
              if (!window.confirm('Проверить незавершённые сохранения и при необходимости дослать их прежние подписанные данные? Новые заказы и подписи не создаются.')) return;
              void mutate(request => fundReconcile(request.credential, request.signal), () => true,
                next => next.pending ? 'Сверка выполнена. Некоторые сохранения ещё ожидают подтверждения.' : 'Сверка фонда завершена.');
            }}>Проверить незавершённые сохранения</button>
            <p>Последняя сверка: {date(data.lastReconciliation)}</p>
          </section></div>
          <div className="fund-admin-grid"><section className="ops-desk-card"><h3>Сохранения по промокоду</h3>
            <p>Завершено {data.successfulTrees} · За 24 часа {data.today} · За 7 дней {data.last7Days}</p>
            <p>Ожидают {data.pending} · Не завершены {data.failedAttempts}</p>
            <p>Всего зашифровано {size(data.totalEncryptedBytes)} · В среднем {size(data.averageArchiveBytes)}</p>
          </section><section className="ops-desk-card"><h3>Расходы на хранение</h3>
            <p>Среднее сохранение {formatAr(data.averageActualWinston)} AR · Последнее {formatAr(data.latestActualWinston)} AR</p>
            <p>Текущая оценка для {size(data.currentQuoteBytes)}: {formatAr(data.currentQuoteWinston)} AR</p>
            <p>Оценка доступных сохранений: {data.estimatedTreesRemaining ?? 'Пока недостаточно данных'}</p>
          </section></div>
          <section><h3>История бесплатных сохранений</h3>
            <div className="fund-admin-filters"><label>Состояние<select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
              <option value="All">Все</option><option value="Completed">Завершено</option><option value="Pending">Ожидает</option><option value="Failed">Не завершено</option>
            </select></label><label>Период<select value={timeFilter} onChange={event => setTimeFilter(event.target.value)}>
              <option value="Today">24 часа</option><option value="7 days">7 дней</option><option value="All time">Всё время</option>
            </select></label></div>
            <div className="fund-admin-history"><table className="ops-desk-table"><thead><tr><th>Дата</th><th>Состояние</th><th>Размер</th><th>Расход AR</th><th>Версия кода</th><th>Arweave TX</th></tr></thead>
              <tbody>{filtered.map(row => <tr key={row.orderId}>
                <td data-label="Дата">{date(row.createdAt)}</td><td data-label="Состояние">{row.status}</td><td data-label="Размер">{size(row.archiveSizeBytes)}</td>
                <td data-label="Расход AR">{formatAr(row.actualRewardWinston)}</td><td data-label="Версия кода">{row.promoRevision}</td>
                <td data-label="Arweave TX">{row.arweaveTxId ? <a href={`https://arweave.net/${row.arweaveTxId}`} target="_blank" rel="noreferrer">{row.arweaveTxId.slice(0, 7)}…{row.arweaveTxId.slice(-5)}</a> : '—'}</td>
              </tr>)}</tbody></table></div>
          </section>
        </>}
      </>}
    </>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </section>;
}
