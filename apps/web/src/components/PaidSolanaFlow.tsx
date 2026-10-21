import { useCallback, useEffect, useRef, useState } from 'react';
import type { SolanaWalletAdapter } from '@ardrive/turbo-sdk/web';
import { formatAmount, requiresLargeAmountConfirmation } from '../../../../packages/checkout/amounts';
import { downloadEnvelope } from '../lib/crypto/vault';
import { parseEnvelope, serializeEnvelope } from '../lib/crypto/envelope';
import { downloadJson } from '../lib/download';
import { connectWallet, type WalletName } from '../lib/solana/client';
import { readPaidOperation } from '../lib/checkout/paidJournal';
import { findPreservationAttempt } from '../lib/checkout/vaultGuard';
import { finalizeStandalonePaid } from '../lib/checkout/paidFinalize';
import {
  beginPaidOperation, checkPaidOperation, paidCompletion, payPaidOperation,
  preparePaidOperation, readPaidPolicy, readPaidStatus, PaidApiError, cancelPaidOperation, resolveReleasedPaidOperation, retryPaidCreation, cancelPaidCreation,
} from '../lib/checkout/paidClient';
import type { PaidCompletion, PaidInput, PaidOperation, PaidPolicyResponse } from '../lib/checkout/paidTypes';

type Props = {
  input: PaidInput;
  onBack: (hasAttempt: boolean) => void;
  onBusy?: (busy: boolean) => void;
  onComplete?: (result: PaidCompletion) => Promise<void>;
  onAdoptAttempt?: (operation: PaidOperation) => void;
};

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && error.code === 4001) return 'Кошелёк отклонил подпись. Оплата не отправлена. Можно подтвердить тот же запрос или отменить его.';
  const code = error instanceof Error ? error.message : '';
  if (error instanceof PaidApiError && error.status === 404) return 'Сервер пока не нашёл сохранённый запрос. Продолжаем проверять тот же запрос; новый заказ не создаётся.';
  if (error instanceof PaidApiError && error.status === 401) return 'Доступ к прежнему запросу требует восстановления. Платёж и зашифрованный архив сохранены в этом браузере; новая оплата не начинается.';
  const known: Record<string, string> = {
    wallet_not_found: 'Кошелёк не найден. Откройте сайт в браузере с Phantom или Solflare.',
    wallet_changed: 'В кошельке выбран другой аккаунт. Продолжить можно с аккаунтом этого заказа.',
    wrong_solana_network: 'Не удалось подтвердить выбранную сеть Solana. Оплата не начинается.',
    network_fee_changed: 'Комиссия сети изменилась. Проверьте условия оплаты ещё раз.',
    network_fee_not_ready: 'Не удалось проверить комиссию сети. Оплата не начинается.',
    paid_unavailable: 'Оплата через Solana пока недоступна. Вы можете сохранить дерево по промокоду.',
    preservation_attempt_in_progress: 'Есть незавершённое сохранение этого архива. Продолжите исходную попытку.',
    legacy_checkout_pending: 'Есть незавершённая прежняя оплата этого архива. Новый платёж не начинается.',
    checkout_journal_unavailable: 'Браузер не смог сохранить сведения о попытке. Скачайте зашифрованную копию; новый платёж не начинается.',
    storage_unavailable: 'Браузер не смог защитить сохранение от повторной оплаты. Скачайте зашифрованную копию.',
    invalid_paid_attempt: 'Не удалось проверить сохранённую попытку. Исходный архив остаётся в браузере; новый платёж не начинается.',
    previous_payment_unresolved: 'Проверяем уже начатую оплату. Новая подпись и повторный платёж не запускаются.',
  };
  return known[code] ?? 'Не удалось обновить состояние сохранения. Проверим ту же попытку снова; повторная оплата не запускается.';
}

export function PaidSolanaFlow({ input, onBack, onBusy, onComplete, onAdoptAttempt }: Props) {
  const [policy, setPolicy] = useState<PaidPolicyResponse | null>(null);
  const [op, setOp] = useState<PaidOperation | null>(null);
  const [wallet, setWallet] = useState<SolanaWalletAdapter | null>(null);
  const [amount, setAmount] = useState('0');
  const [initializing, setInitializing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [completionError, setCompletionError] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const context = useRef({ active: false });
  const running = useRef(false), reading = useRef(false), completing = useRef(false);
  const completedAttempt = useRef('');
  const latest = useRef<PaidOperation | null>(null);
  const callbacks = useRef({ onBusy, onComplete, onAdoptAttempt }); callbacks.current = { onBusy, onComplete, onAdoptAttempt };
  const latestInput = useRef(input); latestInput.current = input;
  const identity = input.mode === 'resume' ? input.operationId : serializeEnvelope(input.envelope) + ':' + input.parentTxId + ':' + input.treeId;

  const remember = useCallback((next: PaidOperation) => {
    latest.current = next; setOp(next);
    const current = latestInput.current;
    if (current.mode === 'create' && (serializeEnvelope(current.envelope) !== next.serialized || current.parentTxId !== next.archive.parentTxId)) {
      callbacks.current.onAdoptAttempt?.(next);
    }
  }, []);
  useEffect(() => {
    const current = { active: true }; context.current = current;
    const source = latestInput.current;
    setInitializing(true); setOp(null); latest.current = null; setPolicy(null); setWallet(null);
    setError(''); setConsent(false); setCompletionError(false); completedAttempt.current = '';
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        const pending = source.mode === 'resume' ? await readPaidOperation(source.operationId) : await (async () => {
          const found = await findPreservationAttempt({ vaultId: source.envelope.vault_id, treeId: source.treeId });
          if (found?.method === 'promo') throw Error('preservation_attempt_in_progress');
          return found?.attempt ?? null;
        })();
        if (!current.active) return;
        if (pending) {
          remember(pending); setAmount(pending.intent.contribution);
          // A paused current policy does not erase the prior immutable order.
          const refreshed = await readPaidStatus(pending.id, controller.signal);
          if (current.active) remember(refreshed);
        } else if (source.mode === 'resume') throw Error('invalid_paid_attempt');
        else {
          const offered = await readPaidPolicy(controller.signal);
          if (current.active) setPolicy(offered);
        }
      })().catch(e => { if (current.active) setError(errorMessage(e)); })
        .finally(() => { if (current.active) setInitializing(false); });
    }, 0);
    return () => { current.active = false; clearTimeout(timer); controller.abort(); };
    // identity is the immutable archive or durable operation ID, not prop identity.
  }, [identity, remember]);

  const check = useCallback(async () => {
    const current = context.current, previous = latest.current;
    if (!previous || reading.current || running.current || !current.active) return;
    reading.current = true; setChecking(true);
    try { const next = await checkPaidOperation(previous.id, () => current.active); if (current.active) { remember(next); setError(''); } }
    catch (e) { if (current.active) setError(errorMessage(e)); }
    finally { reading.current = false; if (current.active) setChecking(false); }
  }, [remember]);

  const completed = op?.snapshot?.record.states.preservation === 'completed';
  const released = op?.snapshot?.expired === true || op?.creationCancelled === true;
  useEffect(() => {
    if (!op?.id || initializing || completed || released || op.localCompletion !== 'pending') return;
    let live = true, timer: ReturnType<typeof setTimeout>;
    const tick = async () => { await check(); if (live) timer = setTimeout(() => void tick(), 6000); };
    timer = setTimeout(() => void tick(), 6000);
    return () => { live = false; clearTimeout(timer); };
  }, [op?.id, op?.localCompletion, initializing, completed, released, check]);

  async function run(action: () => Promise<void>) {
    if (running.current || reading.current || initializing) return;
    const current = context.current;
    running.current = true; setBusy(true); callbacks.current.onBusy?.(true); setError('');
    try { await action(); }
    catch (e) {
      if (current.active) {
        setError(errorMessage(e));
        try {
          const old = latest.current;
          const found = old ? await readPaidOperation(old.id) : input.mode === 'create'
            ? await findPreservationAttempt({ vaultId: input.envelope.vault_id, treeId: input.treeId }).then(value => value?.method === 'paid' ? value.attempt : null)
            : await readPaidOperation(input.operationId);
          if (found && current.active) remember(found);
        } catch { /* Keep the original operation and visible failure. */ }
      }
    } finally { running.current = false; callbacks.current.onBusy?.(false); if (current.active) setBusy(false); }
  }

  async function connect(name: WalletName) {
    await run(async () => {
      const current = context.current;
      const next = await connectWallet(name);
      if (!current.active) return;
      setWallet(next); setConsent(false);
      let operation = latest.current;
      if (!operation) {
        if (input.mode !== 'create' || !policy?.ready) throw Error('paid_unavailable');
        operation = await beginPaidOperation(input, next.publicKey.toString(), amount, policy);
      }
      if (current.active) remember(operation);
      if (!current.active) return;
      if (operation.intent.payer !== next.publicKey.toString()) throw Error('wallet_changed');
      if (!operation.signingStarted && !operation.signature) {
        operation = await preparePaidOperation(operation.id, next, () => current.active);
        if (current.active) remember(operation);
      }
    });
  }

  async function pay() {
    if (!op?.preparation || !wallet || !consent) return;
    await run(async () => {
      if (requiresLargeAmountConfirmation(op.order!.fundContribution.amount, '100000000000') &&
          !window.confirm(`Дополнительный взнос: ${formatAmount(op.order!.fundContribution.amount, 9)} SOL.\n${op.order!.fundContribution.recipient}`)) return;
      const current = context.current;
      const next = await payPaidOperation(op.id, op.preparation!.preparationId, wallet, () => current.active);
      if (current.active) { remember(next); setConsent(false); }
    });
  }

  const finish = useCallback(async () => {
    const previous = latest.current, current = context.current, callback = callbacks.current.onComplete;
    if (!previous || completing.current || !current.active) return;
    completing.current = true; setFinishing(true); setCompletionError(false);
    try {
      const result = await paidCompletion(previous);
      if (!result) throw Error('checkout_completion_mismatch');
      if (!current.active) return;
      if (callback) await callback(result);
      else {
        await finalizeStandalonePaid(result, () => current.active);
        const saved = await readPaidOperation(previous.id);
        if (saved && current.active) remember(saved);
      }
    } catch { if (current.active) setCompletionError(true); }
    finally { completing.current = false; if (current.active) setFinishing(false); }
  }, [remember]);

  useEffect(() => {
    if (!completed || !op || op.localCompletion === 'done' || completedAttempt.current === op.id) return;
    completedAttempt.current = op.id; void finish();
  }, [completed, op, onComplete, finish]);

  const order = op?.order, paid = op?.snapshot?.record.states.payment === 'verified';
  const pendingPayment = op?.signingStarted || Boolean(op?.signature);
  const envelope = op ? parseEnvelope(JSON.parse(op.serialized)) : input.mode === 'create' ? input.envelope : null;
  const unavailable = !op && !initializing && !policy?.ready;
  const canPrepare = !initializing && !busy && !checking && !paid && !pendingPayment && !released && !op?.cancellationRequested && Boolean(order || !op && policy?.ready);
  let title = 'Через Solana';
  if (completed) title = 'Семейная история сохранена';
  else if (released) title = op?.snapshot?.cancelled || op?.creationCancelled ? 'Запрос оплаты отменён' : 'Срок предложения оплаты истёк';
  else if (paid) title = op?.snapshot?.execution?.status === 'requires-reconciliation' ? 'Проверяем состояние сохранения' : 'Ждём подтверждения Arweave';
  else if (pendingPayment) title = 'Проверяем оплату';
  else if (op?.cancellationRequested) title = 'Проверяем отмену запроса';
  else if (op && !order) title = 'Проверяем созданный запрос';

  return <section className="checkout-panel" aria-label="Оплата SOL">
    <h1>{title}</h1>
    {initializing && <p role="status">Проверяем прежнее сохранение и условия оплаты…</p>}
    {unavailable && <p>Оплата через Solana пока недоступна. Вы можете сохранить дерево по промокоду.</p>}
    {(policy?.ready || order) && !completed && <p>Сохранение — <strong>0.03 SOL</strong>. Дополнительный взнос по желанию; комиссия сети отдельно.</p>}
    {(order || policy?.policy) && <p>Сеть оплаты: {(order?.network ?? policy?.policy?.network) === 'devnet' ? 'Solana Devnet' : 'Solana Mainnet'}. Хранение: Arweave Mainnet.</p>}
    {envelope && <button className="btn ghost" type="button" onClick={() => downloadEnvelope(envelope)}>Скачать зашифрованную копию</button>}
    {!op && policy?.ready && <label>Дополнительный взнос, SOL<input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} disabled={busy || initializing} /></label>}
    {order && <dl>
      <dt>Сохранение</dt><dd>{formatAmount(order.servicePayment.amount, 9)} SOL</dd>
      <dt>Получатель оплаты</dt><dd style={{ overflowWrap: 'anywhere' }}>{order.servicePayment.recipient}</dd>
      <dt>Дополнительный взнос</dt><dd>{formatAmount(order.fundContribution.amount, 9)} SOL</dd>
      {order.fundContribution.amount !== '0' && <><dt>Получатель взноса</dt><dd style={{ overflowWrap: 'anywhere' }}>{order.fundContribution.recipient}</dd></>}
      <dt>Комиссия Solana</dt><dd>{op?.preparation ? formatAmount(op.preparation.feeLamports, 9) + ' SOL' : 'Проверяем…'}</dd>
      <dt>Итого без комиссии сети</dt><dd>{formatAmount(order.total, 9)} SOL</dd>
    </dl>}
    {!paid && !pendingPayment && !completed && !released && !op?.cancellationRequested && (order || !op && policy?.ready) && <div className="actions">
      <button className="btn ghost" type="button" disabled={!canPrepare} onClick={() => void connect('Phantom')}>Подключить Phantom</button>
      <button className="btn ghost" type="button" disabled={!canPrepare} onClick={() => void connect('Solflare')}>Подключить Solflare</button>
    </div>}
    {op?.preparation && wallet && !pendingPayment && !paid && !released && !op.cancellationRequested && <>
      <label><input type="checkbox" checked={consent} disabled={busy || checking} onChange={event => setConsent(event.target.checked)} /> Я проверил(а) сеть, получателей, сумму и отдельную комиссию.</label>
      <button className="btn" type="button" disabled={!consent || busy || checking} onClick={() => void pay()}>Оплатить {formatAmount(order!.total, 9)} SOL</button>
    </>}
    {pendingPayment && !paid && <p role="status">Проверяем ту же оплату. Новая подпись и повторное списание не запускаются.</p>}
    {paid && !completed && <p role="status">Оплата подтверждена. Проверяем транзакцию Arweave и зашифрованный архив. Этот заказ продолжится после закрытия окна.</p>}
    {paid && op?.snapshot?.execution?.status === 'requires-reconciliation' && <p role="alert">Сохранение пока не удалось проверить. Продолжаем проверку этого заказа автоматически; повторная оплата не требуется.</p>}
    {released && <><p role="status">Сервер подтвердил, что оплата не была принята. Зашифрованная копия остаётся доступна. Новое сохранение можно начать только отдельным действием.</p><button className="btn" type="button" disabled={busy || checking} onClick={() => void run(async () => { const current = context.current; await resolveReleasedPaidOperation(op!.id); if (current.active) onBack(true); })}>Вернуться к выбору сохранения</button></>}
    {order && !pendingPayment && !paid && !completed && !released && <button className="btn ghost" type="button" disabled={busy || checking} onClick={() => void run(async () => { const current = context.current; const next = await cancelPaidOperation(op!.id); if (current.active) remember(next); })}>Отменить неоплаченный запрос</button>}
    {op?.cancellationRequested && !released && <p role="status">Проверяем отмену исходного запроса. До ответа сервера новая оплата не начинается.</p>}
    {op && !order && !released && <p role="status">Сохранили исходный зашифрованный архив и номер запроса. Проверяем его состояние; новый заказ не создаётся.</p>}
    {op && !order && !released && !op.cancellationRequested && <button className="btn" type="button" disabled={busy || checking} onClick={() => void run(async () => {
      const current=context.current;const next=await retryPaidCreation(op.id,()=>current.active);if(current.active)remember(next);
    })}>Повторить отправку запроса</button>}
    {op && !order && !released && <button className="btn ghost" type="button" disabled={busy || checking} onClick={() => void run(async () => {
      const current=context.current;const next=await cancelPaidCreation(op.id,()=>current.active);if(current.active)remember(next);
    })}>Отменить этот запрос</button>}
    {op && !completed && !released && <button className="btn ghost" type="button" disabled={busy || checking} onClick={() => void check()}>{checking ? 'Проверяем…' : 'Проверить статус'}</button>}
    {completed && <p role="status">Архив подтверждён и проверен. Храните ваши 12 слов SEJIRE.</p>}
    {completed && op?.snapshot?.execution?.receipt && <button className="btn ghost" type="button" onClick={() => downloadJson(op.snapshot!.execution!.receipt, `sejire-paid-receipt-${op.order!.id}.json`)}>Скачать квитанцию</button>}
    {order && <details><summary>Данные сохранения</summary><p style={{ overflowWrap: 'anywhere' }}>Заказ: {order.id}</p>
      {op?.signature && <p><a href={`https://explorer.solana.com/tx/${op.signature}${order.network === 'devnet' ? '?cluster=devnet' : ''}`} target="_blank" rel="noopener noreferrer">Транзакция оплаты Solana</a></p>}
      {op?.snapshot?.execution?.txId && <p><a href={`https://arweave.net/tx/${op.snapshot.execution.txId}`} target="_blank" rel="noopener noreferrer">Данные транзакции Arweave</a></p>}
      {op?.snapshot?.execution?.reason && <p>Результат проверки: {op.snapshot.execution.reason}</p>}
    </details>}
    {completionError && <><p role="alert">Архив сохранён в Arweave, но браузер не смог завершить запись локальной истории. Повторите завершение; новая оплата не требуется.</p><button className="btn" type="button" disabled={finishing} onClick={() => void finish()}>Повторить завершение</button></>}
    {error && <p role="alert">{error}</p>}
    <button className="btn ghost" type="button" disabled={busy || finishing} onClick={() => onBack(Boolean(op))}>Назад</button>
  </section>;
}
