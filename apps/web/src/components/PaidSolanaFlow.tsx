import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { SolanaWalletAdapter } from '@ardrive/turbo-sdk/web';
import { formatAmount, parseAmount, totalUnits, requiresLargeAmountConfirmation } from '../../../../packages/checkout/amounts';
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
  findContributionAttempt, completeContributionLocally, contributionReceipt, recoverPaidOperation,
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
  if (error instanceof PaidApiError && error.stage === 'create') {
    const safeCode = /^[a-z][a-z0-9_-]{0,63}$/.test(code) ? code : 'checkout_requires_reconciliation';
    return `Заказ не создан: ${error.status ? `HTTP ${error.status}` : 'ответ POST недоступен'}, ${safeCode}. Исходная попытка сохранена; новая оплата не начинается.`;
  }
  if (error instanceof PaidApiError && error.status === 404) return 'Сервер пока не нашёл сохранённый запрос. Продолжаем проверять тот же запрос; новый заказ не создаётся.';
  if (error instanceof PaidApiError && error.status === 401) return 'Доступ к прежнему запросу требует восстановления. Сведения о платеже остаются в этом браузере; новая оплата не начинается.';
  const known: Record<string, string> = {
    wallet_not_found: 'Кошелёк не найден. Откройте сайт в браузере с Phantom или Solflare.',
    wallet_changed: 'В кошельке выбран другой аккаунт. Продолжить можно с аккаунтом этого заказа.',
    wrong_solana_network: 'Не удалось подтвердить выбранную сеть Solana. Оплата не начинается.',
    network_fee_changed: 'Комиссия сети изменилась. Проверьте условия оплаты ещё раз.',
    network_fee_not_ready: 'Не удалось проверить комиссию сети. Оплата не начинается.',
    paid_unavailable: 'Оплата через Solana пока недоступна. Вы можете сохранить дерево по промокоду.',
    preservation_attempt_in_progress: 'Есть незавершённое сохранение этого архива. Продолжите исходную попытку.',
    legacy_checkout_pending: 'Есть незавершённая прежняя оплата этого архива. Новый платёж не начинается.',
    checkout_journal_unavailable: 'Браузер не смог сохранить сведения о попытке. Новый платёж не начинается.',
    storage_unavailable: 'Браузер не смог защитить операцию от повторной оплаты. Новый платёж не начинается.',
    invalid_paid_attempt: 'Не удалось проверить сохранённую попытку. Новый платёж не начинается.',
    previous_payment_unresolved: 'Проверяем уже начатую оплату. Новая подпись и повторный платёж не запускаются.',
    payment_not_expired: 'Предыдущее подтверждение ещё действует. Завершите открытый запрос в кошельке или попробуйте восстановление немного позже.',
    payment_recovery_busy: 'Сервер сейчас проверяет этот заказ. Повторите восстановление после завершения проверки.',
    payment_recovery_unavailable: 'Не удалось безопасно восстановить подтверждение. Заказ сохранён; можно повторить проверку.',
    preparation_changed: 'Подтверждение уже изменилось в другой вкладке. Проверьте состояние этого заказа.',
    insufficient_wallet_balance: 'На кошельке недостаточно SOL для суммы заказа и комиссии сети.',
    invalid_amount: 'Введите сумму в SOL без пробелов, запятой и округления.',
    excess_precision: 'Укажите не более девяти знаков после точки.',
    invalid_contribution_order: 'Для отдельной помощи укажите положительную сумму.',
    technical_amount_overflow: 'Сумма превышает технический предел сети Solana. Укажите меньшую сумму.',
    contribution_unavailable: 'Помощь фонду через Solana пока недоступна. Попробуйте позже.',
  };
  return known[code] ?? 'Не удалось обновить состояние операции. Проверим ту же попытку снова; повторная оплата не запускается.';
}
function delayMessage(reason?:string):string{
  const messages:Record<string,string>={
    'not-found':'Транзакция пока не найдена в сети Solana. Проверяем прежнюю подпись.',
    'executor_paused':'Исполнитель сохранения временно остановлен. Заказ остаётся в очереди.',
    'storage_network_unavailable':'Сеть хранения пока недоступна. Повторяем отправку того же архива.',
    'reference_lookup_unavailable':'Поиск платежа по ссылке заказа временно недоступен. Повторяем проверку.',
    'requires-reconciliation':'Результат операции пока неясен. Продолжаем сверку исходного заказа.',
  };
  return messages[reason??'']??'Сеть пока не вернула окончательный результат. Продолжаем проверку исходного заказа.';
}

export function PaidSolanaFlow({ input, onBack, onBusy, onComplete, onAdoptAttempt }: Props) {
  const inputIdentity = input.mode === 'resume' ? `resume:${input.operationId}` : input.mode === 'contribution'
    ? 'contribution' : `create:${serializeEnvelope(input.envelope)}:${input.parentTxId}:${input.treeId}`;
  const emptyDraft = { source: inputIdentity, amount: '0', donationOnly: input.mode === 'contribution', helpOpen: input.mode === 'contribution' };
  const [draftState, setDraftState] = useState(emptyDraft);
  // Choices belong to this archive. Switching its mode keeps them; a different archive starts at zero.
  const draft = draftState.source === inputIdentity ? draftState : emptyDraft;
  const { amount, helpOpen, donationOnly } = draft;
  const [refresh, setRefresh] = useState(0);
  const helpId = useId(), amountErrorId = useId();
  const [policy, setPolicy] = useState<PaidPolicyResponse | null>(null);
  const [op, setOp] = useState<PaidOperation | null>(null);
  const [wallet, setWallet] = useState<SolanaWalletAdapter | null>(null);
  const [walletAddress, setWalletAddress] = useState('');
  const [initializing, setInitializing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [signing,setSigning]=useState(false);
  const [checking, setChecking] = useState(false);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [completionError, setCompletionError] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const context = useRef({ active: false });
  const running = useRef(false), reading = useRef(false), completing = useRef(false);
  const creationError = useRef<string | null>(null);
  const completedAttempt = useRef('');
  const latest = useRef<PaidOperation | null>(null);
  const callbacks = useRef({ onBusy, onComplete, onAdoptAttempt }); callbacks.current = { onBusy, onComplete, onAdoptAttempt };
  const activeInput:PaidInput=donationOnly&&input.mode!=='resume'?{mode:'contribution'}:input;
  const latestInput = useRef(activeInput); latestInput.current = activeInput;
  const identity = activeInput.mode === 'resume' ? activeInput.operationId : activeInput.mode==='contribution'?'contribution':serializeEnvelope(activeInput.envelope) + ':' + activeInput.parentTxId + ':' + activeInput.treeId;

  const remember = useCallback((next: PaidOperation) => {
    if (latest.current?.preparation?.preparationId !== next.preparation?.preparationId) setConsent(false);
    latest.current = next; setOp(next);
    const current = latestInput.current;
    if (current.mode === 'create' && next.intent.kind==='preservation' && (serializeEnvelope(current.envelope) !== next.serialized || current.parentTxId !== next.archive?.parentTxId)) {
      callbacks.current.onAdoptAttempt?.(next);
    }
  }, []);
  useEffect(() => {
    const current = { active: true }; context.current = current;
    const source = latestInput.current;
    setInitializing(true); setOp(null); latest.current = null; setPolicy(null);
    creationError.current = null; setError(''); setConsent(false); setCompletionError(false); completedAttempt.current = '';
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        const pending = source.mode === 'resume' ? await readPaidOperation(source.operationId) : source.mode==='contribution'?await findContributionAttempt():await (async () => {
          const found = await findPreservationAttempt({ vaultId: source.envelope.vault_id, treeId: source.treeId });
          if (found?.method === 'promo') throw Error('preservation_attempt_in_progress');
          return found?.attempt ?? null;
        })();
        if (!current.active) return;
        if (pending) {
          remember(pending);
          // A paused current policy does not erase the prior immutable order.
          const refreshed = await readPaidStatus(pending.id, controller.signal);
          if (current.active) remember(refreshed);
        } else if (source.mode === 'resume') throw Error('invalid_paid_attempt');
        else {
          const offered = await readPaidPolicy(controller.signal, source.mode === 'contribution' ? 'contribution' : 'preservation');
          if (current.active) setPolicy(offered);
        }
      })().catch(e => { if (current.active) setError(errorMessage(e)); })
        .finally(() => { if (current.active) setInitializing(false); });
    }, 0);
    return () => { current.active = false; clearTimeout(timer); controller.abort(); };
    // identity is the immutable archive or durable operation ID, not prop identity.
  }, [identity, remember, refresh]);

  const check = useCallback(async () => {
    const current = context.current, previous = latest.current;
    if (!previous || reading.current || running.current || !current.active) return;
    reading.current = true; setChecking(true);
    try { const next = await checkPaidOperation(previous.id, () => current.active); if (current.active) { remember(next); creationError.current = null; setError(''); } }
    catch (e) { if (current.active) setError(e instanceof PaidApiError && e.status === 404 && creationError.current
      ? creationError.current : errorMessage(e)); }
    finally { reading.current = false; if (current.active) setChecking(false); }
  }, [remember]);

  const completed = op?.intent.kind==='contribution' ? op?.snapshot?.record.states.payment==='verified' : op?.snapshot?.record.states.preservation === 'completed';
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
        const message = errorMessage(e);
        if (e instanceof PaidApiError && e.stage === 'create') creationError.current = message;
        setError(message);
        try {
          const old = latest.current;
          const source=latestInput.current;
          const found = old ? await readPaidOperation(old.id) : source.mode === 'create'
            ? await findPreservationAttempt({ vaultId: source.envelope.vault_id, treeId: source.treeId }).then(value => value?.method === 'paid' ? value.attempt : null)
            : source.mode==='contribution'?await findContributionAttempt():await readPaidOperation(source.operationId);
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
      const address = next.publicKey.toString();
      setConsent(false);
      if (latest.current && latest.current.intent.payer !== address) {
        setWallet(null); setWalletAddress(''); throw Error('wallet_changed');
      }
      setWallet(next); setWalletAddress(address);
    });
  }

  async function pay() {
    if (!wallet || (op?.preparation&&!consent)) return;
    await run(async () => {
      const source=latestInput.current;
      const requested=latest.current?.intent.contribution??amount;
      parseAmount(requested,9);
      const current = context.current;
      let operation=latest.current;
      if(!operation){
        if(source.mode==='resume'||!policy||!(source.mode==='contribution'?policy.contributionReady:policy.ready))throw Error(source.mode==='contribution'?'contribution_unavailable':'paid_unavailable');
        operation=await beginPaidOperation(source,wallet.publicKey.toString(),requested,policy);
        if(current.active)remember(operation);
      }
      if(!operation.order)throw Error('previous_payment_unresolved');
      if(!operation.preparation){operation=await preparePaidOperation(operation.id,wallet,()=>current.active);if(current.active){remember(operation);setConsent(false);}return;}
      if (requiresLargeAmountConfirmation(operation.order.fundContribution.amount, '100000000000') &&
          !window.confirm(`Дополнительный взнос: ${formatAmount(operation.order.fundContribution.amount,9)} SOL.\n${operation.order.fundContribution.recipient}`)) return;
      setSigning(true);
      try{
        const next = await payPaidOperation(operation.id, operation.preparation.preparationId, wallet, () => current.active);
        if (current.active) { remember(next); setConsent(false); }
      }finally{if(current.active)setSigning(false);}
    });
  }

  async function recoverWalletRequest() {
    setConsent(false);
    await run(async () => {
      const current = context.current, previous = latest.current;
      if (!previous) return;
      const next = await recoverPaidOperation(previous.id, () => current.active);
      if (current.active) remember(next);
    });
  }

  const finish = useCallback(async () => {
    const previous = latest.current, current = context.current, callback = callbacks.current.onComplete;
    if (!previous || completing.current || !current.active) return;
    completing.current = true; setFinishing(true); setCompletionError(false);
    try {
      if(previous.intent.kind==='contribution'){
        await completeContributionLocally(previous.id);
        const saved=await readPaidOperation(previous.id);if(saved&&current.active)remember(saved);
        return;
      }
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
  }, [completed, op, finish]);

  const order = op?.order, paid = op?.snapshot?.record.states.payment === 'verified';
  const contributionOnly = op ? op.intent.kind === 'contribution' : donationOnly;
  const offeredPolicy = contributionOnly ? policy?.contributionPolicy : policy?.policy;
  const offerReady = contributionOnly ? policy?.contributionReady : policy?.ready;
  const signature = op?.snapshot?.record.payment?.signature ?? op?.snapshot?.record.pendingSignature ?? op?.signature;
  const pendingPayment = op?.signingStarted || Boolean(signature);
  const unsignedWalletRequest = Boolean(op?.signingStarted && !signature && !op?.signedTransaction);
  const recoveryPending = Boolean(op?.recoveryRequestedFor);
  const envelope = op?.serialized ? parseEnvelope(JSON.parse(op.serialized)) : activeInput.mode === 'create' ? activeInput.envelope : null;
  const unavailable = !op && !initializing && !offerReady;
  const canPrepare = !initializing && !busy && !checking && !paid && !pendingPayment && !recoveryPending && !released && !op?.cancellationRequested && Boolean(order || !op && offerReady);
  const recoverable = Boolean(order && op?.preparation && op.localCompletion === 'pending' && !signature && !op.signedTransaction &&
    !op.snapshot?.execution && !paid && !released && !op.cancellationRequested);
  const network = order?.network ?? offeredPolicy?.network;
  const executionStatus = op?.snapshot?.execution?.status;
  let amountUnits: string | null = null, draftTotal: string | null = null, amountError = '';
  try {
    amountUnits = parseAmount(amount, 9);
    if (offeredPolicy) draftTotal = totalUnits(contributionOnly ? '0' : offeredPolicy.serviceLamports, amountUnits);
  } catch (e) { amountError = errorMessage(e); }
  const validDraftAmount = !amountError && amountUnits !== null && (!contributionOnly || amountUnits !== '0');
  let finalTotal: string | null = null;
  if (order && op?.preparation) {
    try { finalTotal = formatAmount(totalUnits(order.total, op.preparation.feeLamports), 9); }
    catch { /* The client rejects an amount plus fee outside the network's representation. */ }
  }

  function updateDraft(patch: Partial<typeof draft>) {
    setDraftState({ ...draft, ...patch }); setConsent(false);
  }
  function anotherContribution() {
    if (op?.intent.kind !== 'contribution' || op.localCompletion !== 'done' || busy || checking || finishing) return;
    updateDraft({ amount: '0', donationOnly: true, helpOpen: true });
    setRefresh(value => value + 1);
  }
  async function downloadContributionReceipt() {
    await run(async () => {
      const current = latest.current;
      if (!current) return;
      const receipt = await contributionReceipt(current);
      downloadJson(receipt, `sejire-contribution-receipt-${current.order!.id}.json`);
    });
  }

  let title = contributionOnly ? 'Помощь другим семьям' : 'Через Solana';
  if (completed) title = contributionOnly ? 'Спасибо! Ваш взнос поступил в фонд' : 'Семейная история сохранена';
  else if (released) title = op?.snapshot?.cancelled || op?.creationCancelled ? 'Запрос оплаты отменён' : 'Срок предложения оплаты истёк';
  else if (paid) title = executionStatus === 'requires-reconciliation' ? 'Проверяем состояние сохранения'
    : executionStatus === 'confirming' || executionStatus === 'submitted' ? 'Ждём подтверждения Arweave' : 'Оплата получена. Сохраняем дерево';
  else if (signing) title = 'Подтвердите оплату в кошельке';
  else if (unsignedWalletRequest) title = 'Подтверждение в кошельке не завершено';
  else if (pendingPayment) title = 'Проверяем оплату';
  else if (recoveryPending) title = 'Восстанавливаем подтверждение';
  else if (op?.cancellationRequested) title = 'Проверяем отмену запроса';
  else if (op && !order) title = 'Проверяем созданный запрос';

  return <section className="checkout-panel" aria-label="Оплата SOL">
    <h1>{title}</h1>
    {initializing && <p role="status">{contributionOnly ? 'Проверяем прежний взнос и условия оплаты…' : 'Проверяем прежнее сохранение и условия оплаты…'}</p>}
    {unavailable && <p>{contributionOnly ? 'Помощь фонду через Solana пока недоступна. Попробуйте позже.' : 'Оплата через Solana пока недоступна. Вы можете сохранить дерево по промокоду.'}</p>}
    {(offerReady || order) && !completed && <p>{contributionOnly ? 'Добровольная помощь фонду' : `Сохранение — ${formatAmount(order?.servicePayment.amount ?? offeredPolicy!.serviceLamports, 9)} SOL`}. Комиссия сети отдельно.</p>}
    {network && <p>Сеть оплаты: {network === 'devnet' ? 'Solana Devnet' : 'Solana Mainnet'}.{!contributionOnly && ' Хранение: Arweave Mainnet.'}</p>}
    {!order && offeredPolicy && <p style={{ overflowWrap: 'anywhere' }}>
      {!contributionOnly && <>Получатель сервисной оплаты: {offeredPolicy.serviceRecipient}<br /></>}
      Фонд: {offeredPolicy.fundRecipient}
    </p>}
    {walletAddress && <p role="status" style={{ overflowWrap: 'anywhere' }}>Кошелёк подключён: {walletAddress}</p>}
    {envelope && <button className="btn ghost" type="button" onClick={() => downloadEnvelope(envelope)}>Скачать зашифрованную копию</button>}
    {!op && (policy?.ready || policy?.contributionReady) && <>
      <button className="btn ghost" type="button" aria-expanded={helpOpen} aria-controls={helpId}
        disabled={busy || checking || initializing} onClick={() => updateDraft({ helpOpen: !helpOpen })}>Помочь другим сохранить их истории</button>
      {helpOpen && <div id={helpId}>
        <label>Добровольный взнос, SOL<input inputMode="decimal" value={amount}
          aria-invalid={Boolean(amountError)} aria-describedby={amountError ? amountErrorId : undefined}
          onChange={event => updateDraft({ amount: event.target.value })} disabled={busy || checking || initializing} /></label>
        {amountError && <p id={amountErrorId} role="alert">{amountError}</p>}
        {contributionOnly && amountUnits === '0' && <p>Укажите сумму помощи больше 0 SOL.</p>}
        {!contributionOnly && <button className="btn ghost" type="button" disabled={busy || checking || initializing || !policy?.contributionReady}
          onClick={() => updateDraft({ donationOnly: true })}>Только помочь другим</button>}
        {contributionOnly && input.mode === 'create' && <button className="btn ghost" type="button" disabled={busy || checking || initializing}
          onClick={() => updateDraft({ donationOnly: false })}>Вернуться к сохранению дерева</button>}
      </div>}
      {(amountUnits !== '0' || contributionOnly || amountError) && <p aria-live="polite">
        Добровольный взнос: {amountError || amountUnits === null ? 'проверьте сумму' : `${formatAmount(amountUnits, 9)} SOL`}
        {!contributionOnly && amount !== '0' && <button className="btn ghost" type="button" disabled={busy || checking || initializing}
          onClick={() => updateDraft({ amount: '0' })}>Убрать взнос</button>}
      </p>}
      <p>Итого без комиссии сети: {draftTotal && !amountError ? `${formatAmount(draftTotal, 9)} SOL` : 'проверьте сумму'}</p>
    </>}
    {order && <dl>
      {order.kind === 'preservation' && <><dt>Сохранение</dt><dd>{formatAmount(order.servicePayment.amount, 9)} SOL</dd>
        <dt>Получатель оплаты</dt><dd style={{ overflowWrap: 'anywhere' }}>{order.servicePayment.recipient}</dd></>}
      <dt>{contributionOnly ? 'Помощь фонду' : 'Добровольный взнос'}</dt><dd>{formatAmount(order.fundContribution.amount, 9)} SOL</dd>
      {order.fundContribution.amount !== '0' && <><dt>Получатель взноса</dt><dd style={{ overflowWrap: 'anywhere' }}>{order.fundContribution.recipient}</dd></>}
      <dt>Комиссия Solana</dt><dd>{op?.preparation ? formatAmount(op.preparation.feeLamports, 9) + ' SOL' : 'Проверяем…'}</dd>
      <dt>Итого без комиссии сети</dt><dd>{formatAmount(order.total, 9)} SOL</dd>
      {finalTotal && <><dt>Итого с комиссией сети</dt><dd>{finalTotal} SOL</dd></>}
    </dl>}
    {!paid && !pendingPayment && !completed && !released && !op?.cancellationRequested && (order || !op && offerReady) && <div className="actions">
      <button className="btn ghost" type="button" disabled={!canPrepare} onClick={() => void connect('Phantom')}>Подключить Phantom</button>
      <button className="btn ghost" type="button" disabled={!canPrepare} onClick={() => void connect('Solflare')}>Подключить Solflare</button>
    </div>}
    {wallet && !pendingPayment && !recoveryPending && !paid && !released && !op?.cancellationRequested && (order || offerReady) && <>
      {op?.preparation && <label><input type="checkbox" checked={consent} disabled={busy || checking}
        onChange={event => setConsent(event.target.checked)} /> Я проверил(а) сеть, получателей, сумму и отдельную комиссию.</label>}
      <button className="btn" type="button" disabled={!canPrepare || Boolean(op?.preparation && !consent) || !op && !validDraftAmount}
        onClick={() => void pay()}>{op?.preparation ? 'Подтвердить оплату в кошельке' : contributionOnly ? 'Только помочь другим' : 'Оплатить и сохранить'}</button>
    </>}
    {signing && <p role="status">Подтвердите оплату в кошельке</p>}
    {unsignedWalletRequest && !paid && !signing && <p role="status">Сайт пока не получил подпись от кошелька. Проверяем этот заказ. Если запрос в кошельке уже закрыт, восстановите подтверждение.</p>}
    {pendingPayment && !unsignedWalletRequest && !paid && <p role="status">Проверяем оплату. {delayMessage(op?.snapshot?.verification?.reason)} Новая подпись не запускается.</p>}
    {recoverable && !signing && <>
      {recoveryPending && <p role="status">Запрос восстановления сохранён. Проверяем его результат для того же заказа.</p>}
      <button className={unsignedWalletRequest || recoveryPending ? 'btn' : 'btn ghost'} type="button"
        disabled={initializing || busy || checking} onClick={() => void recoverWalletRequest()}>
        {unsignedWalletRequest || recoveryPending ? 'Восстановить подтверждение' : 'Обновить подтверждение'}
      </button>
      {(unsignedWalletRequest || recoveryPending) && <p className="sub">После проверки сервер обновит подтверждение этого заказа. Сумму и комиссию нужно будет проверить снова; кошелёк откроется только по вашему нажатию.</p>}
    </>}
    {paid && !completed && <p role="status">{executionStatus === 'confirming' || executionStatus === 'submitted'
      ? 'Оплата получена, архив отправлен. Ждём подтверждения сети и проверяем, что архив можно скачать.'
      : 'Оплата получена. Сохраняем дерево.'} Этот заказ продолжится после закрытия окна.</p>}
    {paid && executionStatus === 'requires-reconciliation' && <p role="alert">{delayMessage(op?.snapshot?.execution?.reason)} Повторная оплата не требуется.</p>}
    {released && <>
      <p role="status">Сервер подтвердил, что оплата не была принята. {contributionOnly
        ? 'Новый взнос можно начать отдельным действием.' : 'Зашифрованная копия остаётся доступна. Новое сохранение можно начать только отдельным действием.'}</p>
      <button className="btn" type="button" disabled={busy || checking} onClick={() => void run(async () => {
        const current = context.current; await resolveReleasedPaidOperation(op!.id); if (current.active) onBack(true);
      })}>{contributionOnly ? 'Закрыть отменённый запрос' : 'Вернуться к выбору сохранения'}</button>
    </>}
    {order && !pendingPayment && !recoveryPending && !paid && !completed && !released && <button className="btn ghost" type="button" disabled={busy || checking}
      onClick={() => void run(async () => { const current = context.current; const next = await cancelPaidOperation(op!.id); if (current.active) remember(next); })}>Отменить неоплаченный запрос</button>}
    {op?.cancellationRequested && !released && <p role="status">Проверяем отмену исходного запроса. До ответа сервера новая оплата не начинается.</p>}
    {op && !order && !released && <p role="status">{contributionOnly ? 'Сохранили сумму взноса и номер запроса.' : 'Сохранили исходный зашифрованный архив и номер запроса.'} Проверяем его состояние; новый заказ не создаётся.</p>}
    {op && !order && !released && !op.cancellationRequested && <button className="btn" type="button" disabled={busy || checking} onClick={() => void run(async () => {
      const current = context.current; const next = await retryPaidCreation(op.id, () => current.active); if (current.active) remember(next);
    })}>Повторить отправку запроса</button>}
    {op && !order && !released && <button className="btn ghost" type="button" disabled={busy || checking} onClick={() => void run(async () => {
      const current = context.current; const next = await cancelPaidCreation(op.id, () => current.active); if (current.active) remember(next);
    })}>Отменить этот запрос</button>}
    {op && !completed && !released && <button className="btn ghost" type="button" disabled={busy || checking} onClick={() => void check()}>{checking ? 'Проверяем…' : 'Проверить статус'}</button>}
    {completed && <p role="status">{contributionOnly ? `Ваш взнос ${formatAmount(order!.fundContribution.amount, 9)} SOL подтверждён. Он поможет другим семьям сохранить свои истории.` : 'Дерево сохранено. Храните ваши 12 слов SEJIRE.'}</p>}
    {signature && order && <p><a href={`https://explorer.solana.com/tx/${signature}${order.network === 'devnet' ? '?cluster=devnet' : ''}`} target="_blank" rel="noopener noreferrer">Посмотреть транзакцию Solana</a></p>}
    {completed && contributionOnly && <button className="btn ghost" type="button" disabled={busy || finishing} onClick={() => void downloadContributionReceipt()}>Скачать квитанцию</button>}
    {completed && contributionOnly && op?.localCompletion === 'done' && <button className="btn" type="button" disabled={busy || checking || finishing} onClick={anotherContribution}>Сделать ещё один взнос</button>}
    {completed && op?.snapshot?.execution?.receipt && <button className="btn ghost" type="button" onClick={() => downloadJson(op.snapshot!.execution!.receipt, `sejire-paid-receipt-${op.order!.id}.json`)}>Скачать квитанцию</button>}
    {order && <details><summary>{contributionOnly ? 'Данные взноса' : 'Данные сохранения'}</summary><p style={{ overflowWrap: 'anywhere' }}>Заказ: {order.id}</p>
      {signature && <p><a href={`https://explorer.solana.com/tx/${signature}${order.network === 'devnet' ? '?cluster=devnet' : ''}`} target="_blank" rel="noopener noreferrer">Транзакция оплаты Solana</a></p>}
      {op?.snapshot?.execution?.txId && <p><a href={`https://arweave.net/tx/${op.snapshot.execution.txId}`} target="_blank" rel="noopener noreferrer">Данные транзакции Arweave</a></p>}
      {op?.snapshot?.execution?.reason && <p>Результат проверки: {op.snapshot.execution.reason}</p>}
    </details>}
    {completionError && <>
      <p role="alert">{contributionOnly ? 'Взнос подтверждён, но браузер не смог записать завершение. Повторите завершение; новая оплата не требуется.' : 'Архив сохранён в Arweave, но браузер не смог завершить запись локальной истории. Повторите завершение; новая оплата не требуется.'}</p>
      <button className="btn" type="button" disabled={finishing} onClick={() => void finish()}>Повторить завершение</button>
    </>}
    {error && <p role="alert">{error}</p>}
    <button className="btn ghost" type="button" disabled={busy || checking || finishing} onClick={() => onBack(Boolean(op))}>Назад</button>
  </section>;
}
