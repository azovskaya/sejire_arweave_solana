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
type RecoveryFailure = { operationId: string; preparationId: string; message: string };
type FailureStage = 'заказ' | 'подготовка' | 'сеть/RPC' | 'комиссия' | 'баланс' | 'кошелёк' | 'фиксация подписи' | 'отправка' | 'проверка оплаты' | 'хранение';
function failureDetails(error: unknown): { stage: FailureStage; code: string } {
  const code = error instanceof Error ? error.message : error && typeof error === 'object' && 'code' in error && error.code === 4001 ? 'wallet_rejected' : 'unknown';
  const safe = /^[a-z][a-z0-9_-]{0,63}$/.test(code) ? code : 'unknown';
  const stage: FailureStage = error instanceof PaidApiError && error.stage === 'create' ? 'заказ' :
    /wallet|context_changed/.test(safe) ? 'кошелёк' : /fee/.test(safe) ? 'комиссия' : /balance/.test(safe) ? 'баланс' :
    /solana|rpc|network/.test(safe) ? 'сеть/RPC' : /prepar|recovery|expired/.test(safe) ? 'подготовка' :
    /reserv|signature|signed/.test(safe) ? 'фиксация подписи' : /send|broadcast/.test(safe) ? 'отправка' :
    /storage|archive|execution|preservation|completion/.test(safe) ? 'хранение' : 'проверка оплаты';
  return { stage, code: safe };
}

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
    payment_preparation_expired: 'Подготовка транзакции устарела. Проверяем прежнюю попытку и обновляем её для этого заказа.',
    solana_unavailable: 'Сеть Solana временно недоступна. Запрос сохранён; повторите действие позже.',
    solana_rpc_malformed: 'Сеть Solana вернула неверный ответ. Подпись не запрашивалась; повторите действие позже.',
    wallet_result_unknown: 'Phantom не вернул надёжный результат. Проверяем тот же заказ; новая подпись не запрашивается.',
    checkout_request_timed_out: 'Сервер не ответил вовремя. Сверяем тот же запрос; новую оплату не запускаем.',
    paid_unavailable: 'Оплата через Solana пока недоступна. Вы можете сохранить дерево по промокоду.',
    preservation_attempt_in_progress: 'Есть незавершённое сохранение этого архива. Продолжите исходную попытку.',
    legacy_checkout_pending: 'Есть незавершённая прежняя оплата этого архива. Новый платёж не начинается.',
    checkout_journal_unavailable: 'Браузер не смог сохранить сведения о попытке. Новый платёж не начинается.',
    storage_unavailable: 'Браузер не смог защитить операцию от повторной оплаты. Новый платёж не начинается.',
    invalid_paid_attempt: 'Не удалось проверить сохранённую попытку. Новый платёж не начинается.',
    previous_payment_unresolved: 'Проверяем уже начатую оплату. Новая подпись и повторный платёж не запускаются.',
    payment_not_expired: 'Предыдущее подтверждение ещё действует. Если в кошельке есть открытый запрос, завершите его; иначе повторите восстановление немного позже.',
    payment_recovery_busy: 'Сервер сейчас проверяет этот заказ. Повторите восстановление после завершения проверки.',
    payment_recovery_unavailable: 'Не удалось восстановить подтверждение. Заказ сохранён; повторите восстановление немного позже.',
    preparation_changed: 'Подтверждение уже изменилось в другой вкладке. Проверьте состояние этого заказа.',
    insufficient_wallet_balance: 'На кошельке недостаточно SOL для суммы заказа и комиссии сети.',
    invalid_amount: 'Введите сумму в SOL без пробелов, запятой и округления.',
    excess_precision: 'Укажите не более девяти знаков после точки.',
    invalid_contribution_order: 'Для отдельной помощи укажите положительную сумму.',
    technical_amount_overflow: 'Сумма превышает технический предел сети Solana. Укажите меньшую сумму.',
    contribution_unavailable: 'Помощь фонду через Solana пока недоступна. Попробуйте позже.',
  };
  if (known[code]) return known[code];
  const { stage } = failureDetails(error);
  if (stage === 'кошелёк') return 'Не получили подтверждение от кошелька. Проверяем эту попытку; новая подпись без вашего действия не запрашивается.';
  if (stage === 'хранение') return 'Оплата сохранена в заказе, но архив ещё не подтверждён. Продолжим сохранение без повторной оплаты.';
  if (stage === 'сеть/RPC' || stage === 'комиссия' || stage === 'баланс') return 'Не удалось проверить условия Solana. Подпись не запрашивалась; повторите действие позже.';
  if (stage === 'подготовка') return 'Подготовка оплаты не завершилась. Исходный заказ сохранён; повторите действие.';
  if (stage === 'фиксация подписи' || stage === 'отправка' || stage === 'проверка оплаты') return 'Результат оплаты пока неясен. Сверяем эту попытку; новая подпись не запрашивается.';
  return 'Не удалось подтвердить заказ. Сохранённую попытку можно безопасно продолжить.';
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
  const [phase, setPhase] = useState<'preparing' | 'checking' | 'saving'>('preparing');
  const [signing,setSigning]=useState(false);
  const [recovering, setRecovering] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [diagnostic, setDiagnostic] = useState<{ stage: FailureStage; code: string } | null>(null);
  const [recoveryFailure, setRecoveryFailure] = useState<RecoveryFailure | null>(null);
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
    if (latest.current?.id === next.id && next.revision < latest.current.revision) return;
    setRecoveryFailure(previous => previous && (previous.operationId !== next.id ||
      previous.preparationId !== next.preparation?.preparationId || next.localCompletion !== 'pending' ||
      next.creationCancelled || next.snapshot?.expired || next.snapshot?.cancelled || next.signature ||
      next.snapshot?.record.pendingSignature || next.snapshot?.record.payment) ? null : previous);
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
    creationError.current = null; setError(''); setDiagnostic(null); setRecoveryFailure(null); setRecovering(false);
    setCompletionError(false); completedAttempt.current = '';
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
      })().catch(e => { if (current.active) { setError(errorMessage(e)); setDiagnostic(failureDetails(e)); } })
        .finally(() => { if (current.active) setInitializing(false); });
    }, 0);
    return () => { current.active = false; clearTimeout(timer); controller.abort(); };
    // identity is the immutable archive or durable operation ID, not prop identity.
  }, [identity, remember, refresh]);

  const check = useCallback(async () => {
    const current = context.current, previous = latest.current;
    if (!previous || reading.current || running.current || !current.active) return;
    reading.current = true; setChecking(true);
    try { const next = await checkPaidOperation(previous.id, () => current.active); if (current.active) {
      remember(next); creationError.current = null;
      if (next.snapshot?.record.states.payment === 'verified' || next.snapshot?.record.states.preservation === 'completed') { setError(''); setDiagnostic(null); }
    } }
    catch (e) { if (current.active) {
      setError(previous => previous || (e instanceof PaidApiError && e.status === 404 && creationError.current ? creationError.current : errorMessage(e)));
      setDiagnostic(previous => previous || failureDetails(e));
    } }
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

  async function run(action: () => Promise<void>, kind: 'other' | 'recovery' = 'other') {
    if (running.current || initializing) return;
    const current = context.current;
    const recoveryTarget = kind === 'recovery' && latest.current?.preparation
      ? { operationId: latest.current.id, preparationId: latest.current.recoveryRequestedFor ?? latest.current.preparation.preparationId } : null;
    running.current = true; setBusy(true); callbacks.current.onBusy?.(true); setError(''); setDiagnostic(null);
    if (kind === 'recovery') { setRecoveryFailure(null); setRecovering(true); }
    try { await action(); }
    catch (e) {
      if (current.active) {
        const message = errorMessage(e);
        setDiagnostic(failureDetails(e));
        if (e instanceof PaidApiError && e.stage === 'create') creationError.current = message;
        if (recoveryTarget) setRecoveryFailure({ ...recoveryTarget, message });
        else setError(message);
        try {
          const old = latest.current;
          const source=latestInput.current;
          const found = old ? await readPaidOperation(old.id) : source.mode === 'create'
            ? await findPreservationAttempt({ vaultId: source.envelope.vault_id, treeId: source.treeId }).then(value => value?.method === 'paid' ? value.attempt : null)
            : source.mode==='contribution'?await findContributionAttempt():await readPaidOperation(source.operationId);
          if (found && current.active) {
            if (recoveryTarget && found.id === recoveryTarget.operationId && found.recoveryRequestedFor)
              setRecoveryFailure({ ...recoveryTarget, preparationId: found.recoveryRequestedFor, message });
            remember(found);
          }
        } catch { /* Keep the original operation and visible failure. */ }
      }
    } finally {
      running.current = false; callbacks.current.onBusy?.(false);
      if (current.active) { setBusy(false); if (kind === 'recovery') setRecovering(false); }
    }
  }

  async function connect(name: WalletName) {
    await run(async () => {
      const current = context.current;
      const next = await connectWallet(name, () => { if (current.active) setSigning(true); });
      if (!current.active) return;
      const address = next.publicKey.toString();
      if (latest.current && latest.current.intent.payer !== address) {
        setWallet(null); setWalletAddress(''); throw Error('wallet_changed');
      }
      setWallet(next); setWalletAddress(address);
    });
  }

  async function pay() {
    await run(async () => {
      setPhase('preparing');
      const source=latestInput.current;
      const requested=latest.current?.intent.contribution??amount;
      parseAmount(requested,9);
      const current = context.current;
      let operation=latest.current;
      if (operation?.snapshot?.record.states.payment === 'verified' || operation?.signingStarted || operation?.signature || operation?.recoveryRequestedFor) {
        setPhase(operation.snapshot?.record.states.payment === 'verified' ? 'saving' : 'checking');
        if (operation.recoveryRequestedFor && !operation.signature) {
          operation = await recoverPaidOperation(operation.id, () => current.active);
        } else {
          operation = await checkPaidOperation(operation.id, () => current.active);
          if (operation.signingStarted && !operation.signature && !operation.snapshot?.record.pendingSignature &&
              operation.snapshot?.record.states.payment !== 'verified') {
            operation = await recoverPaidOperation(operation.id, () => current.active);
          }
        }
        if (current.active) remember(operation);
        if (operation.snapshot?.record.states.payment === 'verified' || operation.signingStarted || operation.signature || operation.recoveryRequestedFor) return;
      }
      let connected = wallet;
      if (!connected) {
        connected = await connectWallet('Phantom', () => { if (current.active) setSigning(true); });
        if (!current.active) return;
        const address = connected.publicKey.toString();
        if (operation && operation.intent.payer !== address) throw Error('wallet_changed');
        setWallet(connected); setWalletAddress(address);
      }
      if(!operation){
        if(source.mode==='resume'||!policy||!(source.mode==='contribution'?policy.contributionReady:policy.ready))throw Error(source.mode==='contribution'?'contribution_unavailable':'paid_unavailable');
        operation=await beginPaidOperation(source,connected.publicKey.toString(),requested,policy);
        if(current.active)remember(operation);
      }
      if(!operation.order){operation=await retryPaidCreation(operation.id,()=>current.active);if(current.active)remember(operation);}
      if(!operation.order)throw Error('previous_payment_unresolved');
      if (operation.signingStarted || operation.signature || operation.snapshot?.record.pendingSignature || operation.snapshot?.record.payment) return;
      if(!operation.preparation){operation=await preparePaidOperation(operation.id,connected,()=>current.active);if(current.active)remember(operation);}
      const payableOrder = operation.order;
      if (!payableOrder || !operation.preparation) throw Error('previous_payment_unresolved');
      if (requiresLargeAmountConfirmation(payableOrder.fundContribution.amount, '100000000000') &&
          !window.confirm(`Дополнительный взнос: ${formatAmount(payableOrder.fundContribution.amount,9)} SOL.\n${payableOrder.fundContribution.recipient}`)) return;
      try {
        let next: PaidOperation;
        try { next = await payPaidOperation(operation.id, operation.preparation!.preparationId, connected, () => current.active); }
        catch (e) {
          if (!(e instanceof Error) || e.message !== 'payment_preparation_expired') throw e;
          operation = await recoverPaidOperation(operation.id, () => current.active);
          if (current.active) remember(operation);
          if (!operation.preparation || operation.signingStarted || operation.signature || operation.snapshot?.record.states.payment === 'verified') return;
          next = await payPaidOperation(operation.id, operation.preparation.preparationId, connected, () => current.active);
        }
        if (current.active) remember(next);
        if (current.active) setPhase('checking');
      } finally { if(current.active)setSigning(false); }
    });
  }

  async function recoverWalletRequest() {
    await run(async () => {
      const current = context.current, previous = latest.current;
      if (!previous) return;
      const next = await recoverPaidOperation(previous.id, () => current.active);
      if (current.active) remember(next);
    }, 'recovery');
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
  const canPrepare = !initializing && !busy && !released && !op?.cancellationRequested && Boolean(order || !op && offerReady);
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
    setDraftState({ ...draft, ...patch });
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
  else if (signing) title = 'Подтвердите в Phantom';
  else if (recovering) title = 'Проверяем возможность восстановления';
  else if (recoveryPending) title = 'Восстановление не завершено';
  else if (unsignedWalletRequest) title = 'Подтверждение в кошельке не завершено';
  else if (pendingPayment) title = 'Проверяем оплату';
  else if (op?.cancellationRequested) title = 'Проверяем отмену запроса';
  else if (op && !order) title = 'Проверяем созданный запрос';

  const price = order?.servicePayment.amount ?? offeredPolicy?.serviceLamports;
  const status = completed ? 'Сохранено' : signing ? 'Подтвердите в Phantom' : paid || finishing || phase === 'saving' && busy ? 'Сохраняем' :
    pendingPayment || checking || phase === 'checking' && busy ? 'Проверяем оплату' : busy ? 'Готовим оплату' : '';
  const primaryText = unavailable ? 'Повторить проверку' : completionError ? 'Завершить сохранение' : released ? 'Вернуться к сохранению' :
    paid || pendingPayment || recoveryPending || op && !order ? 'Продолжить сохранение' :
    contributionOnly ? 'Подтвердить взнос в Phantom' : `Оплатить ${price ? formatAmount(price, 9) : '…'} SOL и сохранить`;
  return <section className="checkout-panel" aria-label="Оплата SOL">
    <h1>{title}</h1>
    {initializing && <p role="status">Проверяем прежнее сохранение и условия оплаты…</p>}
    {unavailable && <p>{contributionOnly ? 'Помощь фонду через Solana пока недоступна.' : 'Оплата через Solana пока недоступна. Вы можете сохранить дерево по промокоду.'}</p>}
    {(offerReady || order) && !completed && <>
      {!contributionOnly && <p>Стоимость сохранения: {price ? formatAmount(price, 9) : '…'} SOL.</p>}
      <p>Комиссия Solana отдельно: {op?.preparation ? `оценка ${formatAmount(op.preparation.feeLamports, 9)} SOL` : 'уточняется перед подтверждением в Phantom'}.</p>
      <p>Оплата: {network === 'devnet' ? 'Solana Devnet' : 'Solana Mainnet'}. {!contributionOnly && 'Зашифрованное хранение: Arweave Mainnet.'}</p>
      {walletAddress && <p style={{ overflowWrap: 'anywhere' }}>Phantom: {walletAddress}</p>}
      {!walletAddress && !pendingPayment && !paid && <p>При первом использовании Phantom может сначала запросить разрешение на подключение.</p>}
    </>}
    {!op && (policy?.ready || policy?.contributionReady) && <>
      <button className="btn ghost" type="button" aria-expanded={helpOpen} aria-controls={helpId}
        disabled={busy || initializing} onClick={() => updateDraft({ helpOpen: !helpOpen })}>Добровольный взнос (необязательно)</button>
      {helpOpen && <div id={helpId}>
        <label>Добровольный взнос, SOL<input inputMode="decimal" value={amount}
          aria-invalid={Boolean(amountError)} aria-describedby={amountError ? amountErrorId : undefined}
          onChange={event => updateDraft({ amount: event.target.value })} disabled={busy || initializing} /></label>
        {amountError && <p id={amountErrorId} role="alert">{amountError}</p>}
        {contributionOnly && amountUnits === '0' && <p>Укажите сумму помощи больше 0 SOL.</p>}
        {!contributionOnly && <button className="btn ghost" type="button" disabled={busy || initializing || !policy?.contributionReady}
          onClick={() => updateDraft({ donationOnly: true })}>Только помочь другим</button>}
        {contributionOnly && input.mode === 'create' && <button className="btn ghost" type="button" disabled={busy || initializing}
          onClick={() => updateDraft({ donationOnly: false })}>Вернуться к сохранению дерева</button>}
      </div>}
      <p>Итого без комиссии сети: {draftTotal && !amountError ? `${formatAmount(draftTotal, 9)} SOL` : 'проверьте сумму'}</p>
    </>}
    {status && <p role="status">{status}</p>}
    {paid && !completed && <p>Оплата подтверждена. Архив завершается автоматически; этот заказ продолжится после закрытия окна.</p>}
    {pendingPayment && !paid && !signing && <p>Сверяем прежнюю попытку. Новая подпись не запрашивается, пока результат не определён.</p>}
    {op && !order && !released && <p>Заказ сохранён в браузере. Продолжаем тот же запрос без создания нового.</p>}
    {released && <p>Сервер подтвердил завершение неоплаченного запроса. Зашифрованная копия доступна в подробностях.</p>}
    {completed && <p role="status">{contributionOnly ? 'Взнос подтверждён.' : 'Семейная история сохранена. Храните ваши 12 слов SEJIRE.'}</p>}
    {error && <p role="alert">{error}</p>}
    {recoveryFailure && !error && <p role="alert">{recoveryFailure.message}</p>}
    {completionError && <p role="alert">Архив сохранён, но запись локальной истории не завершилась. Повторная оплата не требуется.</p>}
    {!completed && <button className="btn" type="button"
      disabled={busy || finishing || initializing || !unavailable && !released && !completionError && !canPrepare && !pendingPayment && !paid && !recoveryPending && !(op && !order) || !unavailable && !op && !validDraftAmount}
      onClick={() => void (unavailable ? setRefresh(value => value + 1) : completionError ? finish() : released ? run(async () => { await resolveReleasedPaidOperation(op!.id); onBack(true); }) : pay())}>
      {busy ? status || 'Продолжаем…' : primaryText}
    </button>}
    {completed && contributionOnly && op?.localCompletion === 'done' && <button className="btn" type="button" disabled={busy || finishing} onClick={anotherContribution}>Сделать ещё один взнос</button>}
    <details><summary>Подробнее</summary>
      {diagnostic && <p>Этап: {diagnostic.stage}. Код: {diagnostic.code}.</p>}
      {order && <dl>
        {order.kind === 'preservation' && <><dt>Получатель сохранения</dt><dd style={{ overflowWrap: 'anywhere' }}>{order.servicePayment.recipient}</dd></>}
        <dt>Добровольный взнос</dt><dd>{formatAmount(order.fundContribution.amount, 9)} SOL</dd>
        {order.fundContribution.amount !== '0' && <><dt>Получатель взноса</dt><dd style={{ overflowWrap: 'anywhere' }}>{order.fundContribution.recipient}</dd></>}
        <dt>Итого без комиссии</dt><dd>{formatAmount(order.total, 9)} SOL</dd>
        {finalTotal && <><dt>Итого с оценкой комиссии</dt><dd>{finalTotal} SOL</dd></>}
      </dl>}
      {!order && offeredPolicy && <p style={{ overflowWrap: 'anywhere' }}>Получатель сохранения: {offeredPolicy.serviceRecipient}<br />Фонд: {offeredPolicy.fundRecipient}</p>}
      {order && <p style={{ overflowWrap: 'anywhere' }}>Заказ: {order.id}</p>}
      {signature && order && <p><a href={`https://explorer.solana.com/tx/${signature}${order.network === 'devnet' ? '?cluster=devnet' : ''}`} target="_blank" rel="noopener noreferrer">Транзакция Solana</a></p>}
      {op?.snapshot?.execution?.txId && <p><a href={`https://arweave.net/tx/${op.snapshot.execution.txId}`} target="_blank" rel="noopener noreferrer">Архив Arweave</a></p>}
      {op?.snapshot?.execution?.reason && <p>Диагностика хранения: {op.snapshot.execution.reason}</p>}
      {op?.snapshot?.verification?.reason && <p>Диагностика оплаты: {op.snapshot.verification.reason}</p>}
      {envelope && <button className="btn ghost" type="button" onClick={() => downloadEnvelope(envelope)}>Скачать зашифрованную копию</button>}
      {!wallet && !paid && !pendingPayment && !completed && <button className="btn ghost" type="button" disabled={busy} onClick={() => void connect('Solflare')}>Использовать Solflare</button>}
      {order && !pendingPayment && !paid && !completed && !released && !op?.cancellationRequested && <button className="btn ghost" type="button" disabled={busy} onClick={() => void run(async () => { const next = await cancelPaidOperation(op!.id); remember(next); })}>Отменить неоплаченный запрос</button>}
      {op && !order && !released && <button className="btn ghost" type="button" disabled={busy} onClick={() => void run(async () => { const next = await cancelPaidCreation(op.id); remember(next); })}>Отменить этот запрос</button>}
      {op && !completed && !released && <button className="btn ghost" type="button" disabled={busy} onClick={() => void check()}>Проверить статус</button>}
      {recoverable && <button className="btn ghost" type="button" disabled={busy} onClick={() => void recoverWalletRequest()}>Восстановить подтверждение</button>}
      {completed && contributionOnly && <button className="btn ghost" type="button" onClick={() => void downloadContributionReceipt()}>Скачать квитанцию</button>}
      {completed && op?.snapshot?.execution?.receipt && <button className="btn ghost" type="button" onClick={() => downloadJson(op.snapshot!.execution!.receipt, `sejire-paid-receipt-${op.order!.id}.json`)}>Скачать квитанцию</button>}
    </details>
    <button className="btn ghost" type="button" disabled={busy || finishing} onClick={() => onBack(Boolean(op))}>Назад</button>
  </section>;
}
