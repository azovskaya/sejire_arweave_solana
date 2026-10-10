import { useEffect, useRef, useState } from 'react';
import type { SolanaWalletAdapter } from '@ardrive/turbo-sdk/web';
import type { EnvelopeV1 } from '../lib/crypto/encrypt';
import { downloadEnvelope } from '../lib/crypto/vault';
import { connectWallet, type WalletName, downloadReceipt } from '../lib/solana/client';
import type { PreservationReceipt } from '../lib/solana/receipt';
import { formatSol } from '../lib/solana/policy';
import { checkoutMessages } from '../lib/checkout/messages';
import { useI18n } from '../lib/i18n/I18nProvider';
import { downloadJson } from '../lib/download';
import { formatAmount, parseAmount, requiresLargeAmountConfirmation } from '../../../../packages/checkout/amounts';
import { startOrder, createOrResume, prepare, pay, reconcile, execute, operations, preservationReceipt, type Operation, type Prepared } from '../lib/checkout/client';

type Props = { envelope?: EnvelopeV1; parentTxId?: string | null; onBack: () => void; onBusy?: (busy: boolean) => void;
  onDone?: (receipt: PreservationReceipt, parentTxId: string | null) => void; onAccepted?: (receipt: PreservationReceipt, envelope: EnvelopeV1, parentTxId: string | null) => void };
export function CheckoutPublishPanel({ envelope, parentTxId = null, onBack, onBusy, onDone, onAccepted }: Props) {
  const { locale } = useI18n(), t = checkoutMessages[locale];
  const [amount, setAmount] = useState('0'), [wallet, setWallet] = useState<SolanaWalletAdapter | null>(null);
  const [op, setOp] = useState<Operation | null>(null), [prepared, setPrepared] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState(false), [consent, setConsent] = useState(false), [error, setError] = useState(''), [resumed, setResumed] = useState(false);
  const lock = useRef(false), accepted = useRef(false);
  const currentEnvelope = op?.envelope ?? envelope, snapshot = op?.snapshot, order = op?.order;
  const verified = snapshot?.record.states.payment === 'verified', complete = Boolean(snapshot?.execution?.retrieved);
  useEffect(() => {
    let mounted = true;
    operations().then(list => {
      const pending = list.filter(item => envelope ? item.envelope?.vault_id === envelope.vault_id : item.intent.kind === 'contribution')
        .filter(item => item.snapshot?.record.states.preservation !== 'completed' && (item.intent.kind !== 'contribution' || item.snapshot?.record.states.contribution !== 'received')).at(-1);
      if (mounted && pending) { setOp(pending); setAmount(pending.intent.contribution); setResumed(true); }
    }).catch(() => { if (mounted) setError(t.unavailable); });
    return () => { mounted = false; };
  }, [envelope, t.unavailable]);
  async function run(action: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(true); onBusy?.(true); setError('');
    try { await action(); }
    catch (e) {
      const rejected = e && typeof e === 'object' && 'code' in e && e.code === 4001;
      setError(rejected ? t.rejected : `${t.unavailable} (${e instanceof Error ? e.message : 'verification-pending'})`);
      const list = await operations().catch(() => []);
      const recent = list.filter(item => envelope ? item.envelope?.vault_id === envelope.vault_id : item.intent.kind === 'contribution').at(-1);
      if (recent) setOp({ ...recent });
    } finally { lock.current = false; setBusy(false); onBusy?.(false); }
  }
  async function check(name?: WalletName) {
    await run(async () => {
      setPrepared(null); setConsent(false);
      const next = name ? await connectWallet(name) : wallet;
      if (!next) throw new Error('wallet_not_found'); setWallet(next);
      parseAmount(amount, 9);
      const operation = op ? await createOrResume(op, next) : await startOrder(next.publicKey.toString(), amount, envelope, next);
      if (operation.order?.payer !== next.publicKey.toString()) throw new Error('wallet_changed');
      setOp({ ...operation }); setConsent(false);
      if (!operation.signature && !operation.signingStarted) setPrepared(await prepare(operation));
    });
  }
  function accept(operation: Operation) {
    if (operation.snapshot?.execution?.accepted && operation.envelope && !accepted.current) {
      accepted.current = true; onAccepted?.(preservationReceipt(operation), operation.envelope, parentTxId);
    }
  }
  async function finishPayment() {
    await run(async () => {
      if (!op || !wallet || !prepared || !consent) return;
      if (requiresLargeAmountConfirmation(op.order!.fundContribution.amount, '100000000000') && !window.confirm(`${t.large} ${formatAmount(op.order!.fundContribution.amount, 9)} SOL. ${t.check}\n${op.order!.fundContribution.recipient}`)) return;
      await pay(op, wallet, prepared); setPrepared(null); setOp({ ...op });
      for (let i = 0; i < 12 && op.snapshot?.record.states.payment !== 'verified'; i++) { await new Promise(resolve => setTimeout(resolve, 5000)); await reconcile(op); setOp({ ...op }); }
      if (op.snapshot?.record.states.payment === 'verified' && op.envelope) { await execute(op); accept(op); setOp({ ...op }); }
    });
  }
  async function resume() {
    await run(async () => {
      if (!op) return; await createOrResume(op);
      if (op.signature || op.snapshot?.record.pendingSignature) await reconcile(op);
      if (op.snapshot?.record.states.payment === 'verified' && op.envelope) { await execute(op); accept(op); }
      setOp({ ...op });
    });
  }
  return <section aria-label={envelope ? t.title : t.support} className="checkout-panel">
    <h3>{envelope ? t.title : t.support}</h3><p>{t.test}</p><p className="sub">{t.recoverWords}</p>
    {currentEnvelope && <button type="button" className="btn ghost" onClick={() => downloadEnvelope(currentEnvelope)}>{t.backup}</button>}
    {resumed && <p role="status">{t.recover}</p>}
    {!order && <>
      <label htmlFor="checkout-contribution">{t.add}</label>
      <input id="checkout-contribution" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} disabled={busy || Boolean(op)} aria-describedby="checkout-sum-note" />
      <p id="checkout-sum-note">{t.amount}</p>
      <div className="actions">{['0.001', '0.005', '0.01', '0.1', '1'].map(value => <button type="button" className="btn ghost" key={value} disabled={busy || Boolean(op)} onClick={() => setAmount(value)}>{value} SOL</button>)}</div>
    </>}
    {order && <dl>
      <dt>{t.service}</dt><dd>{formatAmount(order.servicePayment.amount, 9)} SOL</dd>
      {order.servicePayment.amount !== '0' && <><dt>{t.recipient}</dt><dd style={{ overflowWrap: 'anywhere' }}>{order.servicePayment.recipient}</dd></>}
      <dt>{t.contribution}</dt><dd>{formatAmount(order.fundContribution.amount, 9)} SOL</dd>
      <dt>{t.recipient} — {t.fund}</dt><dd style={{ overflowWrap: 'anywhere' }}>{order.fundContribution.recipient}</dd>
      <dt>{t.fee}</dt><dd>{prepared ? formatSol(prepared.feeLamports) : snapshot?.record.payment ? formatSol(snapshot.record.payment.feeLamports) : '—'} SOL</dd>
      <dt>SOL</dt><dd>{formatAmount(order.total, 9)}</dd>
    </dl>}
    {!op?.signature && !op?.signingStarted && !verified && <div className="actions">
      <button type="button" className="btn ghost" onClick={() => check('Phantom')} disabled={busy}>Phantom — {t.prepare}</button>
      <button type="button" className="btn ghost" onClick={() => check('Solflare')} disabled={busy}>Solflare — {t.prepare}</button>
    </div>}
    {prepared && !op?.signature && !verified && <>
      <label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} disabled={busy} /> {t.consent}</label>
      <button type="button" className="btn" disabled={busy || !consent} onClick={finishPayment}>{t.pay} {order ? formatAmount(order.total, 9) : ''} SOL + {formatSol(prepared.feeLamports)} SOL</button>
    </>}
    {op && (op.signature || op.signingStarted || verified) && !complete && !(verified && !currentEnvelope) && <button type="button" className="btn" disabled={busy} onClick={resume}>{verified ? t.upload : t.resume}</button>}
    <div role="status" aria-live="polite">{complete ? t.complete : snapshot?.execution?.accepted ? t.accepted : verified ? (currentEnvelope ? t.verified : '') : op?.signature ? t.unknown : ''}</div>
    {verified && order?.fundContribution.amount !== '0' && <p>{t.thanks}</p>}
    {snapshot?.execution?.accepted && op && <button type="button" className="btn ghost" onClick={() => downloadReceipt(preservationReceipt(op))}>{t.receipt}</button>}
    {verified && op && <button type="button" className="btn ghost" onClick={() => downloadJson({ schema: 'sejire/payment-receipt/v1', network: 'devnet', order: op.order, payment: op.snapshot?.record.payment }, `sejire-payment-${order?.id}.json`)}>SOL — {t.receipt}</button>}
    {snapshot?.record.payment && <p><a href={`https://explorer.solana.com/tx/${snapshot.record.payment.signature}?cluster=devnet`} target="_blank" rel="noreferrer">Solana devnet</a></p>}
    {error && <p role="alert" style={{ overflowWrap: 'anywhere' }}>{error}</p>}
    <div className="actions"><button type="button" className="btn ghost" onClick={onBack} disabled={busy}>{t.back}</button>
      {complete && op && <button type="button" className="btn" onClick={() => onDone?.(preservationReceipt(op), parentTxId)} disabled={busy}>{t.done}</button>}</div>
  </section>;
}
