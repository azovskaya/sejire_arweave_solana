import { useEffect, useRef, useState } from 'react';
import { formatSol, networkLabel, readPaidOverview, solanaTransactionUrl, type AdminPaidOverview } from '../lib/fund/adminClient';
import { AdminScope, adminError } from '../lib/fund/adminScope';
import { formatAr } from '../lib/fund/client';

const when = (at: number) => new Date(at).toLocaleString();
const statusLabels: Record<string, string> = {
  verified: 'Оплата подтверждена', confirmed: 'Оплата подтверждена', 'awaiting-payment': 'Ожидает оплаты',
  'requires-reconciliation': 'Требует сверки', cancelled: 'Отменён', 'not-applicable': 'Хранение не требуется',
  queued: 'В очереди', prepared: 'Подготовлен', signing: 'Подписывается', signed: 'Подписан',
  submitted: 'Отправлен в Arweave', confirming: 'Ожидает подтверждения Arweave', completed: 'Хранение подтверждено',
  expired: 'Срок истёк', awaiting: 'Ожидает', failed: 'Не завершён',
};
const stateLabel = (value: string) => statusLabels[value.toLowerCase()] ?? `Состояние: ${value}`;
export function PaidOrdersAdmin({ credential }: { credential: string }) {
  const scope = useRef(new AdminScope());
  const [data, setData] = useState<AdminPaidOverview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const load = async (cursor: string | null = null) => {
    let request;
    try { request = scope.current.begin(); } catch { return; }
    setBusy(true); setError('');
    try {
      const next = await readPaidOverview(request.credential, request.signal, cursor);
      if (!scope.current.current(request)) return;
      setData(previous => cursor === null || !previous ? next : { ...next,
        orders: [...previous.orders, ...next.orders.filter(row => !previous.orders.some(old => old.id === row.id))] });
    } catch (failure) {
      if (scope.current.current(request)) { setData(null); setError(adminError(failure)); }
    } finally {
      if (scope.current.current(request)) { setBusy(false); scope.current.finish(request); }
    }
  };
  useEffect(() => {
    const current = scope.current;
    current.replace(credential); setData(null); setError('');
    void load();
    return () => current.clear();
  }, [credential]);
  return <section data-testid="admin-paid-overview" aria-label="Журнал оплаты Solana">
    <h2>Сохранения через Solana</h2>
    <p>Поступления и состояния берутся из авторизованного журнала оператора. Обновление обзора только читает данные.</p>
    <button type="button" className="btn ghost" disabled={busy} onClick={() => void load()}>Обновить обзор Solana</button>
    {busy && <p role="status">Загружаем журнал сервера…</p>}
    {error && <p role="alert">{error}</p>}
    {!data && <p>Поступления и количество сохранений пока не подтверждены.</p>}
    {data && <>
      <section className="ops-desk-card"><h3>Действующие настройки</h3>
        <p>Сеть новых заказов: <strong>{networkLabel(data.configuredNetwork)}</strong></p>
        <p>Цена сохранения: <strong>{formatSol(data.policy.serviceLamports)} SOL</strong> плюс комиссия сети.</p>
        <p>Приём платежей: <strong>{data.policy.paymentEnabled ? 'Включён' : 'Выключен'}</strong>. Исполнение сохранений: <strong>{data.policy.executionEnabled ? 'Включено' : 'Выключено'}</strong>.</p>
        <p>Получатель оплаты: <code>{data.policy.serviceRecipient ?? 'Не настроен'}</code></p>
        <p>Получатель добровольной помощи: <code>{data.policy.fundRecipient ?? 'Не настроен'}</code></p>
        <p>Максимальный зашифрованный архив: <strong>{data.policy.maxArchiveBytes === null ? 'Не подтверждён' : `${(data.policy.maxArchiveBytes / 1024).toLocaleString()} KiB`}</strong>.</p>
        <p>Проверено: {when(data.checkedAt)}. Адреса получателей меняются в разделе «Промокод и фонд».</p>
      </section>
      <div className="fund-admin-grid">{data.totals.map(total => <section className="ops-desk-card" key={total.network} data-testid={`admin-paid-total-${total.network}`}>
        <h3>{networkLabel(total.network)}</h3>
        {total.network === 'devnet' && <p>Тестовые операции не входят в реальные поступления Mainnet.</p>}
        <p>Заказов: {total.totalOrders} · Оплата подтверждена: {total.paymentConfirmed}</p>
        <p>Хранение завершено: {total.storageCompleted} · Ожидают: {total.pending} · Не завершены: {total.failed}</p>
        <p>Подтверждённая оплата сохранений: <strong>{formatSol(total.serviceLamports)} SOL</strong></p>
        <p>Подтверждённая добровольная помощь: <strong>{formatSol(total.contributionLamports)} SOL</strong></p>
      </section>)}</div>
      {data.totals.length === 0 && <p>В журнале пока нет заказов с оплатой SOL.</p>}
      <h3>Заказы</h3>
      <p>Подтверждение оплаты и завершение хранения показаны отдельно. Количество заказов не означает количество уникальных семей или деревьев.</p>
      <div className="fund-admin-history"><table className="ops-desk-table"><thead><tr>
        <th>Дата и заказ</th><th>Сеть и назначение</th><th>Оплата</th><th>Хранение</th><th>Сумма SOL</th><th>Транзакции</th>
      </tr></thead><tbody>{data.orders.map(row => {
        const url = solanaTransactionUrl(row);
        return <tr key={row.id}>
          <td data-label="Дата и заказ">{when(row.createdAt)}<br /><code>{row.id}</code></td>
          <td data-label="Сеть и назначение">{networkLabel(row.network)}<br />{row.kind === 'preservation' ? 'Сохранение' : 'Добровольная помощь'}</td>
          <td data-label="Оплата">{stateLabel(row.paymentStatus)}</td><td data-label="Хранение">{stateLabel(row.storageStatus)}
            {row.archiveBytes !== undefined && <><br />{(row.archiveBytes / 1024).toFixed(1)} KiB</>}
            {row.rewardWinston !== undefined && <><br />{formatAr(row.rewardWinston)} AR</>}</td>
          <td data-label="Сумма SOL">Сохранение: {formatSol(row.serviceLamports)}<br />Помощь: {formatSol(row.contributionLamports)}</td>
          <td data-label="Транзакции">{url ? <a href={url} target="_blank" rel="noreferrer">Транзакция SOL</a> : 'Оплата не подтверждена'}
            {row.arweaveTxId && <><br /><a href={`https://arweave.net/${row.arweaveTxId}`} target="_blank" rel="noreferrer">Архив Arweave</a></>}</td>
        </tr>;
      })}</tbody></table></div>
      {data.orders.length === 0 && <p>Нет записей для отображения.</p>}
      {data.hasMore && <button type="button" className="btn ghost" disabled={busy} onClick={() => void load(data.cursor)}>Показать предыдущие заказы</button>}
    </>}
  </section>;
}
