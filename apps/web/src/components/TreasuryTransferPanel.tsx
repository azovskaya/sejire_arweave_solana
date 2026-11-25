import { useEffect, useMemo, useRef, useState } from 'react';
import { claimTopupTransfer, commitTopupTransfer, readTopupTransfer, type TreasuryTopup } from '../lib/fund/adminClient';
import { AdminScope, adminError } from '../lib/fund/adminScope';
import { formatAr } from '../lib/fund/client';
import { quoteTreasuryTransfer, recoverTreasuryTransfer, signTreasuryTransfer, submitTreasuryTransfer, syncTreasuryTransfer, topupWallet, type TransferQuote } from '../lib/fund/treasuryTransfer';
import type { TransferAttempt, TransferWire } from '../lib/fund/treasuryTransferStore';

type Props = { intent: TreasuryTopup; credential: string; disabled: boolean; onTransaction: (id: string) => void; onBusy: (value: boolean) => void };
export function TreasuryTransferPanel({ intent, credential, disabled, onTransaction, onBusy }: Props) {
  const scope = useRef(new AdminScope());
  const [local, setLocal] = useState<TransferAttempt | null>(null), [remote, setRemote] = useState<TransferWire | null>(null);
  const [quote, setQuote] = useState<TransferQuote | null>(null), [consent, setConsent] = useState(false);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const authority = useMemo(() => ({
    read: (signal?: AbortSignal) => readTopupTransfer(credential, intent.id, signal),
    claim: (input: { claimId: string; unsignedTx: string }, signal?: AbortSignal) => claimTopupTransfer(credential, intent.id, input, signal),
    signed: (input: { claimId: string; signedTx: string }, signal?: AbortSignal) => commitTopupTransfer(credential, intent.id, input, signal),
  }), [credential, intent.id]);
  async function run(action: (signal: AbortSignal) => Promise<void>, initialRead = false) {
    if (disabled && !initialRead) return;
    let request; try { request = scope.current.begin(); } catch { return; }
    setBusy(true); onBusy(true); setError(''); setMessage('');
    try { await action(request.signal); }
    catch (failure) { if (scope.current.current(request)) { setError(adminError(failure)); setReady(false); } }
    finally { if (scope.current.current(request)) { setBusy(false); onBusy(false); scope.current.finish(request); } }
  }
  async function refresh(signal: AbortSignal) {
    const next = await recoverTreasuryTransfer(intent, authority, signal);
    if (signal.aborted) return;
    setLocal(next.local); setRemote(next.remote); setReady(true);
    if (next.local?.txId) onTransaction(next.local.txId);
    if (next.remote) { setQuote(null); setConsent(false); }
  }
  useEffect(() => {
    const current = scope.current; current.replace(credential);
    setLocal(null); setRemote(null); setQuote(null); setConsent(false); setReady(false);
    void run(refresh, true);
    return () => { current.clear(); onBusy(false); };
  }, [authority]);
  const signed = local?.signedTx && local.txId ? local : null;
  let signedFee: string | null = null;
  if (signed) {
    try { const raw = JSON.parse(signed.unsignedTx) as { reward?: unknown }; if (typeof raw.reward === 'string' && /^[1-9][0-9]{0,29}$/.test(raw.reward)) signedFee = raw.reward; }
    catch { /* Unknown fields cannot authorize submission. */ }
  }
  const canPrepare = ready && !local && !remote;
  const locked = disabled || busy;
  return <section className="fund-admin-form" aria-label="Перевод через Wander">
    <h4>Перевести AR через Wander</h4>
    <p>Wander подписывает один перевод с точной суммой и тегом заявки. Слова кошелька остаются в расширении. Отправка выполняется отдельной кнопкой.</p>
    <button type="button" className="btn ghost" disabled={locked} onClick={() => void run(refresh)}>Проверить сохранённую подпись</button>
    {busy && <p role="status">Проверяем перевод или ждём ответа Wander…</p>}
    {canPrepare && <>
      <button type="button" className="btn ghost" disabled={locked} onClick={() => void run(async signal => {
        const next = await quoteTreasuryTransfer(intent, topupWallet(), { signal });
        if (signal.aborted) return; setQuote(next); setConsent(false);
      })}>Подключить Wander и рассчитать комиссию</button>
      {quote && <div data-testid="topup-transfer-preview">
        <p>Сеть: <strong>Arweave Mainnet</strong></p>
        <p>Отправитель: <code>{quote.ownerAddress}</code></p>
        <p>Получатель: <code>{intent.address}</code></p>
        <p>Пополнение: <strong>{formatAr(intent.amountWinston, 12)} AR</strong></p>
        <p>Комиссия сети: <strong>{formatAr(quote.rewardWinston, 12)} AR</strong></p>
        <p>Всего с кошелька: <strong>{formatAr((BigInt(intent.amountWinston) + BigInt(quote.rewardWinston)).toString(), 12)} AR</strong></p>
        <p>Тег: <code>{intent.transferTag?.name} = {intent.transferTag?.value}</code></p>
        <label className="fund-admin-consent"><input type="checkbox" checked={consent} disabled={locked} onChange={event => setConsent(event.target.checked)} />Проверены получатель, сумма и комиссия. Разрешаю один перевод AR.</label>
        <button type="button" className="btn" disabled={locked || !consent} onClick={() => void run(async signal => {
          const next = await signTreasuryTransfer(intent, quote, topupWallet(), authority, { signal });
          if (signal.aborted) return; setLocal(next); onTransaction(next.txId!);
          await syncTreasuryTransfer(intent, authority, signal); if (signal.aborted) return;
          await refresh(signal); if (!signal.aborted) setMessage('Подпись сохранена. Проверьте реквизиты и нажмите «Отправить подписанный перевод».');
        })}>Подписать один перевод в Wander</button>
      </div>}
    </>}
    {(local || remote) && !signed && <p>Подготовка подписи уже закреплена за этой заявкой. Новая подпись не запрашивается. Если прежнее окно Wander ещё открыто, завершите его и проверьте сохранённую подпись здесь.</p>}
    {signed && <div data-testid="topup-signed-transfer">
      <p>Сеть: <strong>Arweave Mainnet</strong></p>
      <p>Подписанный перевод: <code>{signed.txId}</code></p>
      <p>Получатель: <code>{intent.address}</code>; сумма: <strong>{formatAr(intent.amountWinston, 12)} AR</strong>.</p>
      <p>Комиссия сети: <strong>{formatAr(signedFee, 12)} AR</strong>. Всего: <strong>{signedFee === null ? 'Не подтверждено' : `${formatAr((BigInt(intent.amountWinston) + BigInt(signedFee)).toString(), 12)} AR`}</strong>.</p>
      <p>Тег заявки: <code>{intent.transferTag?.name} = {intent.transferTag?.value}</code></p>
      <p>Сумма и комиссия зафиксированы в сохранённой подписи. Любой повтор отправляет этот же перевод; кошелёк не подписывает второй.</p>
      <button type="button" className="btn" disabled={locked || !ready || signedFee === null} onClick={() => void run(async signal => {
        const next = await submitTreasuryTransfer(intent, authority, { signal });
        if (signal.aborted) return; setLocal(next); onTransaction(next.txId!);
        setMessage('Узел принял подписанный перевод. Дождитесь подтверждений Arweave и нажмите «Проверить и учесть пополнение».');
      })}>{signed.submissionStarted ? 'Повторно отправить этот же перевод' : 'Отправить подписанный перевод'}</button>
      <p><a href={`https://arweave.net/tx/${signed.txId}`} target="_blank" rel="noreferrer">Проверить транзакцию Arweave</a></p>
    </div>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </section>;
}
