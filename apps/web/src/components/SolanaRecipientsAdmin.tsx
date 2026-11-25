import { useEffect, useRef, useState } from 'react';
import { solanaRecipientSettings, saveSolanaRecipients } from '../lib/fund/client';
import { validateSolanaRecipients, type SolanaRecipientAdminView } from '../../../../packages/checkout/recipients';
import { AdminScope, type AdminRequest } from '../lib/fund/adminScope';

const messages: Record<string, string> = {
  admin_unauthorized: 'Нужен действующий доступ администратора сервера.',
  invalid_solana_recipient: 'Вставьте публичные адреса получения SOL из кошельков. Не вводите слова восстановления или приватные ключи.',
  solana_recipient_roles_overlap: 'Для оплаты сохранений и помощи укажите два разных адреса.',
  solana_test_recipient_forbidden: 'Этот адрес относится к прежним тестовым кошелькам. Укажите свой адрес для настоящих поступлений.',
  solana_recipient_revision_conflict: 'Настройки уже изменены в другой вкладке. Загрузите сохранённые адреса и проверьте их.',
  invalid_solana_recipient_settings: 'Не удалось проверить настройки адресов.',
  solana_recipient_settings_unavailable: 'Сервер настроек временно недоступен.',
  rate_limited: 'Слишком много запросов. Повторите действие позднее.',
};
function errorText(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  return messages[code] ?? 'Не удалось подтвердить результат запроса. Загрузите сохранённые адреса перед повторным изменением.';
}
function checked(value: SolanaRecipientAdminView) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      value.schema !== 'sejire/sol-recipients-admin/v1' ||
      !['not-configured', 'deployment', 'admin'].includes(value.source) ||
      ![null, 'devnet', 'mainnet-beta'].includes(value.network) ||
      typeof value.serviceRecipient !== 'string' || typeof value.fundRecipient !== 'string' ||
      typeof value.paymentEnabled !== 'boolean' || typeof value.executionEnabled !== 'boolean') throw Error('invalid_solana_recipient_settings');
  if (value.source !== 'not-configured') validateSolanaRecipients(value.serviceRecipient, value.fundRecipient);
  return value;
}
export function SolanaRecipientsAdmin({ credential }: { credential: string }) {
  const [data, setData] = useState<SolanaRecipientAdminView | null>(null);
  const [service, setService] = useState(''), [fund, setFund] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const scope = useRef(new AdminScope());
  function accept(value: SolanaRecipientAdminView) {
    const next = checked(value);
    setData(next); setService(next.serviceRecipient); setFund(next.fundRecipient);
  }
  function finish(request: AdminRequest) {
    if (!scope.current.current(request)) return;
    setBusy(false); scope.current.finish(request);
  }
  async function load() {
    let request;
    try { request = scope.current.begin(); } catch { return; }
    setBusy(true); setError(''); setMessage('');
    try { const value = await solanaRecipientSettings(request.credential, request.signal); if (scope.current.current(request)) accept(value); }
    catch (e) { if (scope.current.current(request)) { setData(null); setError(errorText(e)); } }
    finally { finish(request); }
  }
  useEffect(() => {
    const current = scope.current;
    current.replace(credential); setData(null); setService(''); setFund(''); setError(''); setMessage('');
    if (credential) void load();
    return () => current.clear();
  }, [credential]);
  const dirty = Boolean(data && (service.trim() !== data.serviceRecipient || fund.trim() !== data.fundRecipient));
  let validation = '';
  try { validateSolanaRecipients(service, fund); } catch (e) { validation = errorText(e); }
  async function reload() {
    if (busy) return;
    if (dirty && !window.confirm('Загрузить сохранённые адреса вместо несохранённых изменений?')) return;
    await load();
  }
  async function save() {
    if (!data || busy || validation || !dirty) return;
    const addresses = validateSolanaRecipients(service, fund), revision = data.revision;
    if (data.source !== 'not-configured' && !window.confirm(`Изменить получателей для НОВЫХ заказов?\n\nОплата сохранений:\n${addresses.serviceRecipient}\n\nПомощь другим:\n${addresses.fundRecipient}\n\nУже созданные заказы сохранят прежние адреса.`)) return;
    let request;
    try { request = scope.current.begin(); } catch { return; }
    setBusy(true); setError(''); setMessage('');
    try {
      await saveSolanaRecipients(request.credential, { ...addresses, expectedRevision: revision }, request.signal);
      if (!scope.current.current(request)) return;
      const confirmed = checked(await solanaRecipientSettings(request.credential, request.signal));
      if (!scope.current.current(request)) return;
      accept(confirmed);
      if (confirmed.serviceRecipient !== addresses.serviceRecipient || confirmed.fundRecipient !== addresses.fundRecipient || confirmed.revision !== revision + 1) {
        setError(messages.solana_recipient_revision_conflict);
      } else setMessage('Адреса сохранены на сервере и проверены повторным чтением.');
    } catch (e) { if (scope.current.current(request)) setError(errorText(e)); }
    finally { finish(request); }
  }
  return <section className="ops-desk-card" aria-label="Получатели оплаты SOL">
    <h3>Получатели оплаты SOL</h3>
    <p>Здесь нужны только публичные адреса получения SOL. Ключи и слова восстановления не нужны.</p>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>Получатель оплаты сохранений
        <input value={service} onChange={event => { setService(event.target.value); setMessage(''); }}
          disabled={busy || !data} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={64}
          aria-describedby="sol-service-note" placeholder="Публичный адрес Solana" />
      </label>
      <p id="sol-service-note">На этот адрес поступают 0,03 SOL за сохранение дерева.</p>
      <label>Получатель помощи
        <input value={fund} onChange={event => { setFund(event.target.value); setMessage(''); }}
          disabled={busy || !data} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={64}
          aria-describedby="sol-fund-note" placeholder="Другой публичный адрес Solana" />
      </label>
      <p id="sol-fund-note">На этот адрес поступают добровольные взносы на сохранение историй других семей.</p>
      {(service || fund) && validation && <p>{validation}</p>}
      <p>Проверьте, что оба кошелька принадлежат вам. Проверка формата адреса не подтверждает владение кошельком.</p>
      <button type="submit" className="btn" disabled={busy || !data || !dirty || Boolean(validation)}>Сохранить адреса</button>
      <button type="button" className="btn ghost" disabled={busy} onClick={() => void reload()}>Загрузить сохранённые адреса</button>
    </form>
    {busy && <p role="status">Проверяем настройки сервера…</p>}
    {data && <>
      <p>Сеть оплаты: <strong>{data.network === 'mainnet-beta' ? 'Solana Mainnet' : data.network === 'devnet' ? 'Solana Devnet — тестовая' : 'ещё не настроена'}</strong>.</p>
      <p>Версия адресов: {data.revision}. {data.updatedAt ? `Сохранено: ${new Date(data.updatedAt).toLocaleString()}.` : 'Адреса из админки ещё не сохранены.'}</p>
      {(!data.paymentEnabled || !data.executionEnabled) && <p>Оплата SOL пока выключена. Сохранение адресов само по себе не включает платежи и не списывает средства фонда.</p>}
      <p>Изменения относятся только к новым заказам. Уже начатые платежи и сохранения продолжаются с прежними реквизитами.</p>
    </>}
  </section>;
}
