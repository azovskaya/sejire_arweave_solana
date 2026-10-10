import { useEffect, useRef, useState } from "react";
import type { SolanaWalletAdapter } from "@ardrive/turbo-sdk/web";
import type { EnvelopeV1 } from "../lib/crypto/encrypt";
import { downloadEnvelope } from "../lib/crypto/vault";
import { useI18n } from "../lib/i18n/I18nProvider";
import { configuredNetwork, connectWallet, downloadReceipt, prepareQuote, uploadWithSolana, type PreservationReceipt, type WalletName } from "../lib/solana/client";
import { formatSol, type UploadQuote } from "../lib/solana/policy";
import { preservationError, solanaMessages } from "../lib/solana/messages";
import { uploadJournal, type UploadOperation } from "../lib/solana/journal";
import { retrieveReceiptEnvelope } from "../lib/solana/receipt";
import type { UploadPhase } from "../lib/solana/upload";
import { setLocalJson } from "../lib/storageQuota";

export function SolanaPublishPanel({ envelope: initialEnvelope, parentTxId: initialParent, onBack, onDone, onBusy, onAccepted }: {
  envelope: EnvelopeV1; parentTxId: string | null;
  onBack: () => void; onDone: (receipt: PreservationReceipt, parentTxId: string | null) => void; onBusy: (busy: boolean) => void;
  onAccepted: (receipt: PreservationReceipt, envelope: EnvelopeV1, parentTxId: string | null) => void;
}) {
  const { locale } = useI18n();
  const t = solanaMessages[locale];
  const network = configuredNetwork();
  const [envelope, setEnvelope] = useState(initialEnvelope);
  const [parentTxId, setParentTxId] = useState(initialParent);
  const [saved, setSaved] = useState<UploadOperation[]>([]);
  const [resumed, setResumed] = useState(false);
  const [wallet, setWallet] = useState<SolanaWalletAdapter | null>(null);
  const [quote, setQuote] = useState<UploadQuote | null>(null);
  const [receipt, setReceipt] = useState<PreservationReceipt | null>(null);
  const [receiptStorageFailed, setReceiptStorageFailed] = useState(false);
  const [consent, setConsent] = useState(false);
  const [allowTopUp, setAllowTopUp] = useState(false);
  const [phase, setPhase] = useState<UploadPhase | "verifying" | null>(null);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);
  useEffect(() => {
    if (!busy) return;
    const prevent = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [busy]);

  function working(value: boolean) { lock.current = value; setBusy(value); onBusy(value); }
  async function connect(name?: WalletName) {
    if (lock.current) return;
    working(true); setError(""); setQuote(null); setConsent(false); setAllowTopUp(false); setPhase(null);
    try {
      const next = name ? await connectWallet(name) : wallet;
      if (!next) return;
      setWallet(next);
      const previous = await uploadJournal.forWallet(`${network}:${next.publicKey.toString()}`);
      setSaved(previous.filter(op => op.envelope.vault_id === envelope.vault_id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setQuote(await prepareQuote(envelope, network, next.publicKey.toString()));
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      setError(preservationError(locale, code) ?? (code === "wallet_not_found" ? t.wallet : t.unavailable));
    } finally { working(false); }
  }

  function accept(result: PreservationReceipt, acceptedEnvelope = envelope, parent = parentTxId) {
    setReceipt(result);
    try {
      setReceiptStorageFailed(!setLocalJson(`sejire.solana.receipt.${result.network}.${result.receipt.id}`, result));
    } catch { setReceiptStorageFailed(true); }
    try { onAccepted(result, acceptedEnvelope, parent); } catch { setReceiptStorageFailed(true); }
  }

  async function resume(operation: UploadOperation) {
    if (lock.current || !wallet) return;
    working(true); setError(""); setQuote(null); setConsent(false); setAllowTopUp(false); setPhase(null);
    setEnvelope(operation.envelope); setParentTxId(operation.parentTxId ?? null); setResumed(true);
    try {
      if (operation.receipt) accept(operation.receipt, operation.envelope, operation.parentTxId ?? null);
      else setQuote(await prepareQuote(operation.envelope, network, wallet.publicKey.toString()));
      setSaved([]);
    } catch (e) { setError(preservationError(locale, e instanceof Error ? e.message : "") ?? t.unavailable); }
    finally { working(false); }
  }

  async function verify() {
    if (!receipt || lock.current) return;
    working(true); setError(""); setPhase("verifying"); ctrl.current = new AbortController();
    try {
      await retrieveReceiptEnvelope(receipt, { vaultId: envelope.vault_id, signal: ctrl.current.signal });
      setVerified(true);
    } catch (e) { setError(preservationError(locale, e instanceof Error ? e.message : "") ?? t.retrieveFailed); }
    finally { working(false); setPhase(null); }
  }

  async function publish() {
    if (lock.current || !wallet || !quote || !consent) return;
    if (Date.now() >= quote.expiresAt) { setQuote(null); setConsent(false); setError(t.expired); return; }
    working(true); setError(""); ctrl.current = new AbortController();
    try {
      const result = await uploadWithSolana({ envelope, parentTxId, wallet, quote, network,
        signal: ctrl.current.signal, allowTopUp, onPhase: setPhase });
      accept(result);
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      setError(preservationError(locale, code) ?? (code === "quote_expired" ? t.expired : /changed/.test(code) ? t.changed : t.failed));
      if (code !== "funding_required") { setQuote(null); setConsent(false); setAllowTopUp(false); }
    } finally { working(false); setPhase(null); }
  }

  return <section className="solana-panel" aria-label={t.title}>
    <p className={`network-note ${network === "devnet" ? "is-test" : ""}`}>{network === "devnet" ? t.test : t.live}</p>
    {resumed && <p className="sub">{t.resumed}</p>}
    {!receipt && <>
      <p className="sub">{t.privacy}</p>
      <div className="actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void connect("Phantom")}>{t.connect} Phantom</button>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void connect("Solflare")}>{t.connect} Solflare</button>
      </div>
      {saved.length > 0 && <div className="solana-quote">
        <p className="sub">{t.savedAttempt}</p>
        {saved.map(op => <button key={op.key} type="button" className="btn ghost" disabled={busy} onClick={() => void resume(op)}>
          {t.resume} · {new Date(op.createdAt).toLocaleString(locale)} · {op.dataItemId.slice(0, 8)}
        </button>)}
      </div>}
      {quote && <div className="solana-quote">
        <p className="mono publish-meta">{quote.address}</p>
        <p>{t.limit}: <strong>{formatSol(quote.maxLamports)} SOL</strong></p>
        <p className="sub">{t.fees}</p>
        <label className="consent-line"><input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} />{t.consent}</label>
        <label className="consent-line"><input type="checkbox" checked={allowTopUp} disabled={busy} onChange={e => setAllowTopUp(e.target.checked)} />{t.topUp}</label>
        <button type="button" className="btn" disabled={busy || !consent} onClick={() => void publish()}>{t.publish}</button>
      </div>}
      {wallet && !quote && !busy && <button type="button" className="btn ghost" onClick={() => void connect()}>{t.quote}</button>}
    </>}
    {busy && <p className="sub" role="status">{phase === "checking-payment" ? t.checkingPayment : phase ? t[phase] : t.working}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {receipt && <div role="status">
      <h3>{t.accepted}</h3><p className="sub">{t.pending}</p>
      {receiptStorageFailed && <p role="alert">{t.localReceipt}</p>}
      <p className="mono publish-meta">{receipt.receipt.id}</p>
      <button type="button" className="btn" onClick={() => downloadReceipt(receipt)}>{t.receipt}</button>
      <p className="sub">{t.receiptRestore}</p>
      {verified ? <p className="sub">{t.verified}</p> : <button type="button" className="btn ghost" disabled={busy} onClick={() => void verify()}>{t.verify}</button>}
    </div>}
    <div className="actions">
      <button type="button" className="btn ghost" disabled={busy} onClick={() => downloadEnvelope(envelope)}>{t.backup}</button>
      <button type="button" className="btn ghost" disabled={busy} onClick={() => receipt ? onDone(receipt, parentTxId) : onBack()}>{receipt ? t.done : t.back}</button>
    </div>
  </section>;
}
