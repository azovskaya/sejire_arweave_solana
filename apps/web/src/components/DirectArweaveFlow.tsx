import { useEffect, useRef, useState } from 'react';
import { cancelDirectOperation, checkDirectOperation, directReceipt, directWallet, exportDirectOperation, quoteDirectOperation, readDirectOperation, resumeDirectOperation, signDirectOperation } from '../lib/directArweave';
import type { DirectOperation } from '../lib/directArweave/types';
import { buildRecoveryKit } from '../lib/independentBackup';
import { finalizeIndependentOperation } from '../lib/independentFinalization';
import { downloadJson, downloadText } from '../lib/download';
import { useI18n } from '../lib/i18n/I18nProvider';
import { independentMessages } from '../lib/independentMessages';
import { LegacyPreservationNotice } from './LegacyPreservationNotice';
import { readDirectNodePreference, saveDirectNodePreference } from '../lib/directArweave/nodePreference';

type Props = { operationId: string; onBack: () => void; onBusy?: (busy: boolean) => void; onComplete?: (operation: DirectOperation) => Promise<void> };
function formatAr(value: string): string {
  const n = BigInt(value), whole = n / 1_000_000_000_000n;
  const part = (n % 1_000_000_000_000n).toString().padStart(12, '0').replace(/0+$/, '');
  return `${whole}${part ? '.' + part : ''} AR`;
}

async function finalizeVerified(operation: DirectOperation | null): Promise<DirectOperation | null> {
  if (operation?.state === 'complete' && !operation.lastError) {
    return (await finalizeIndependentOperation(operation.id)).operation;
  }
  return operation;
}

export function DirectArweaveFlow({ operationId, onBack, onBusy, onComplete }: Props) {
  const { locale } = useI18n();
  const copy = independentMessages[locale];
  const [initialNode] = useState(() => {
    try { return { value: readDirectNodePreference() ?? '', error: '' }; }
    catch (error) { return { value: '', error: error instanceof Error ? error.message : 'storage_unavailable' }; }
  });
  const [operation, setOperation] = useState<DirectOperation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialNode.error);
  const [node, setNode] = useState(initialNode.value);
  const alive = useRef(false), running = useRef(false);
  const options = () => {
    const selected = saveDirectNodePreference(node);
    return selected ? { nodes: [selected] } : {};
  };
  useEffect(() => {
    alive.current = true;
    void readDirectOperation(operationId).then(finalizeVerified).then(value => { if (alive.current) { setOperation(value ?? null); if (!value) setError('operation_missing'); } })
      .catch(() => { if (alive.current) setError('storage_unavailable'); });
    return () => { alive.current = false; };
  }, [operationId]);

  // Background checks only read. Uploading or signing always needs a visible click.
  useEffect(() => {
    if (!operation?.txId || operation.state === 'complete' || busy) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void checkDirectOperation(operationId, { signal: controller.signal })
        .then(finalizeVerified)
        .then(next => { if (!controller.signal.aborted && alive.current) setOperation(next); })
        .catch(() => { /* The explicit check shows actionable errors. */ });
    }, 8_000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [operation?.updatedAt, operation?.txId, operation?.state, operationId, busy]);

  useEffect(() => {
    if (operation?.state !== 'signing') return;
    const timer = setInterval(() => {
      void readDirectOperation(operationId).then(next => { if (alive.current && next) setOperation(next); }).catch(() => {});
    }, 2_000);
    return () => clearInterval(timer);
  }, [operation?.state, operationId]);

  async function run(action: () => Promise<DirectOperation | void>) {
    if (running.current) return;
    running.current = true; setBusy(true); onBusy?.(true); setError('');
    try {
      const next = await action();
      const finalized = await finalizeVerified(next ?? await readDirectOperation(operationId) ?? null);
      if (alive.current) setOperation(finalized);
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : 'unknown_error');
        setOperation(await readDirectOperation(operationId).catch(() => null) ?? null);
      }
    } finally {
      running.current = false;
      if (alive.current) { setBusy(false); onBusy?.(false); }
    }
  }
  async function getQuote() {
    const selectedOptions = options();
    const connected = directWallet();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const address = await Promise.race([
      (async () => { await connected.connect(['ACCESS_ADDRESS', 'ACCESS_PUBLIC_KEY', 'SIGN_TRANSACTION'], { name: 'SEJIRE' }); return connected.getActiveAddress(); })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error('wallet_unavailable')), 25_000); }),
    ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
    return quoteDirectOperation(operationId, address, selectedOptions);
  }
  async function signAndSend() {
    if (!operation?.quote) return;
    const selectedOptions = options();
    const signed = await signDirectOperation(operationId, directWallet(), operation.quote.rewardWinston, selectedOptions);
    if (alive.current) setOperation(signed);
    if (!signed.signedTx || !signed.txId) return signed;
    return resumeDirectOperation(operationId, selectedOptions);
  }
  async function kit() {
    if (!operation) return;
    const receipt = operation.txId && operation.signedTx ? directReceipt(operation) : null;
    downloadJson(await buildRecoveryKit(operation.archiveText, receipt), `sejire-recovery-${operation.vaultId.slice(0, 8)}-${operation.id.slice(0, 8)}.json`);
  }
  const currentError = error || operation?.lastError || '';
  function errorMessage(code: string): string {
    if (code === 'wallet_unavailable') return copy.walletRequired;
    if (code === 'legacy_journal_unavailable') return copy.legacyJournal;
    if (/storage_|browser_locks/.test(code)) return copy.localQuota;
    if (code === 'signature_pending') return copy.uncertain;
    if (code === 'insufficient_ar') return locale === 'ru' ? 'На выбранном кошельке недостаточно AR для указанной комиссии.' : locale === 'kk' ? 'Таңдалған әмиянда комиссияға AR жеткіліксіз.' : 'The selected wallet has insufficient AR for this fee.';
    if (/quote_(changed|expired|required)/.test(code)) return locale === 'ru' ? 'Цена изменилась или устарела. Обновите её перед подписью.' : locale === 'kk' ? 'Баға өзгерді немесе ескірді. Қол қою алдында жаңартыңыз.' : 'The price changed or expired. Refresh it before signing.';
    if (/wallet_(rejected|changed)/.test(code)) return locale === 'ru' ? 'Кошелёк отклонил запрос или выбран другой адрес. Проверьте операцию перед продолжением.' : locale === 'kk' ? 'Әмиян сұрауды қабылдамады немесе басқа мекенжай таңдалды. Операцияны тексеріңіз.' : 'The wallet declined or its address changed. Review the operation before continuing.';
    if (/invalid_node/.test(code)) return locale === 'ru' ? 'Укажите HTTPS-адрес узла без пароля, пути и параметров или очистите поле и повторите действие для узлов по умолчанию.' : locale === 'kk' ? 'Құпиясөзсіз, жолсыз және параметрсіз HTTPS мекенжайын көрсетіңіз немесе әдепкі түйіндер үшін өрісті тазалап, әрекетті қайталаңыз.' : 'Enter an HTTPS node origin without credentials, path or query, or clear the field and retry the action to use the default nodes.';
    if (/archive_integrity/.test(code)) return copy.badFile;
    return copy.genericError;
  }
  return <section className="direct-save" aria-label={copy.title}>
    <h2>{copy.title}</h2><p>{copy.directLead}</p>
    {operation && <>
      <p role="status"><strong>{operation.state === 'complete' && operation.lastError ? copy.availabilityPending : copy.states[operation.state]}</strong></p>
      <p className="sub">{copy.size}: {operation.archiveBytes.toLocaleString(locale)} B<br />SHA-256: <span className="break-anywhere">{operation.archiveDigest}</span></p>
      {operation.txId && <p className="sub">Arweave ID: <code className="break-anywhere">{operation.txId}</code></p>}
      {operation.state === 'signing' && <p role="alert">{copy.uncertain}</p>}
      {operation.state === 'complete' && !operation.lastError ? <p>{copy.confirmed}</p> : operation.signedTx ? <p>{copy.signedInfo}</p> : <p className="sub">{copy.kitLocal}</p>}
      <details className="direct-node"><summary>{copy.node}</summary>
        <label>{copy.node}<input type="url" value={node} disabled={busy || operation.state === 'signing'} placeholder="https://node.example.org" autoComplete="off" onChange={e => setNode(e.target.value)} /></label>
        <p className="sub">{copy.nodeHint}</p>
        <p className="sub">{locale === 'ru' ? 'Адрес применяется после нажатия действия и сохраняется для этой вкладки, включая перезагрузку. Пустое поле возвращает узлы по умолчанию.' : locale === 'kk' ? 'Мекенжай әрекет батырмасын басқаннан кейін қолданылып, осы қойындыда, қайта жүктегенде де сақталады. Бос өріс әдепкі түйіндерді қайтарады.' : 'The address is applied when you choose an action and is kept for this tab, including reloads. An empty field restores the default nodes.'}</p>
      </details>
      {operation.state === 'prepared' && <>
        {operation.quote && <div className="direct-quote"><p>{copy.wallet}: <code className="break-anywhere">{operation.quote.ownerAddress}</code></p>
          <p><strong>{copy.price}: {formatAr(operation.quote.rewardWinston)}</strong></p><p className="sub">{copy.feeOnly}</p></div>}
        <div className="actions">
          <button className="btn ghost" type="button" disabled={busy} onClick={() => void run(getQuote)}>{operation.quote ? copy.refreshQuote : copy.connectQuote}</button>
          {operation.quote && <button className="btn" type="button" disabled={busy} onClick={() => void run(signAndSend)}>{copy.signSend} · {formatAr(operation.quote.rewardWinston)}</button>}
        </div>
      </>}
      {operation.signedTx && <div className="actions">
        {operation.state !== 'complete' && <button className="btn" type="button" disabled={busy} onClick={() => void run(() => resumeDirectOperation(operationId, options()))}>{copy.resume}</button>}
        {operation.state === 'complete' && operation.lastError === 'archive_unavailable' && <button className="btn" type="button" disabled={busy} onClick={() => void run(() => resumeDirectOperation(operationId, options()))}>{copy.repair}</button>}
        <button className="btn ghost" type="button" disabled={busy} onClick={() => void run(() => checkDirectOperation(operationId, options()))}>{copy.check}</button>
      </div>}
      <div className="independent-notice">
        <p>{copy.kitDescription}</p>
        <div className="actions">
          <button className="btn" type="button" disabled={busy} onClick={() => void run(kit)}>{copy.kit}</button>
          <button className="btn ghost" type="button" onClick={() => downloadText(operation.archiveText, `sejire-encrypted-${operation.id.slice(0, 8)}.json`)}>{copy.cipherFile}</button>
          {operation.txId && operation.signedTx && <button className="btn ghost" type="button" onClick={() => { try { downloadJson(directReceipt(operation), `sejire-transaction-${operation.txId}.json`); } catch { setError('receipt_invalid'); } }}>{copy.receipt}</button>}
          {operation.signedTx && <button className="btn ghost" type="button" onClick={() => { try { downloadJson(exportDirectOperation(operation), `sejire-upload-${operation.txId}.json`); } catch { setError('signature_invalid'); } }}>{copy.exportAttempt}</button>}
        </div>
        <a href="./recovery/recovery.html" download="sejire-recovery.html">{copy.offlineTool}</a><p className="sub">{copy.retention}</p>
      </div>
      {operation.state === 'prepared' && !operation.signingIntent && <button className="btn ghost" type="button" disabled={busy} onClick={() => void run(() => cancelDirectOperation(operationId))}>{copy.cancelPrepared}</button>}
    </>}
    {currentError === 'legacy_preservation_requires_original_app' ? <LegacyPreservationNotice blocked /> : currentError && <p role="alert">{errorMessage(currentError)}</p>}
    {!operation && !currentError && <p role="status">…</p>}
    <div className="actions">
      {operation?.state === 'complete' && !operation.lastError && onComplete && <button className="btn" type="button" disabled={busy} onClick={() => void run(() => onComplete(operation))}>{copy.done}</button>}
      <button className="btn ghost" type="button" disabled={busy} onClick={onBack}>{copy.back}</button>
    </div>
  </section>;
}
