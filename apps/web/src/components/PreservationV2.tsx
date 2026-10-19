import { useEffect, useRef, useState } from 'react';
import type { EnvelopeV1 } from '../lib/crypto/encrypt';
import { parseEnvelope } from '../lib/crypto/envelope';
import { envelopeText, importPilotFile, PRESERVATION_V2_PILOT_POLICY as P } from '../lib/preserveV2/policy';
import { beginSave, currentSession, pay, prepareArweave, reconcileSave, saveToArweave } from '../lib/preserveV2/machine';
import type { SaveSession } from '../lib/preserveV2/types';
import type { FundOrderView } from '../lib/fund/client';
import { PromoFundedFlow } from './PromoFundedFlow';
import { useI18n } from '../lib/i18n/I18nProvider';

type Props = {
  envelope?: EnvelopeV1 | null;
  treeName?: string;
  treeId?: string;
  parentTxId?: string | null;
  resumeFunded?: boolean;
  quickFundedCode?: string | null;
  initialMethod?: 'choose' | 'promo' | 'solana';
  onBack?: () => void;
  onBusy?: (busy: boolean) => void;
  onFundedDone?: (order: FundOrderView) => void | Promise<void>;
};
const message = (error: unknown) => {
  const code = error instanceof Error ? error.message : 'unknown_error';
  const known: Record<string,string> = {
    archive_not_authorized:'Для пилота разрешён только указанный зашифрованный архив.',
    pilot_file_mismatch:'Файл архива не совпадает с разрешённым пилотом.',
    wrong_phantom_account:'В Phantom выбран другой аккаунт.',
    wrong_wander_address:'В Wander выбран другой адрес.',
    ar_budget_unavailable:'Цена выше 0.004 AR или на резерве недостаточно средств.',
    payment_requires_reconciliation:'Сначала требуется проверить прежнюю оплату.',
    ar_signature_requires_reconciliation:'Нужна проверка предыдущей подписи Wander.',
  };
  return known[code] ?? 'Операция пока не завершена. Прогресс сохранён; проверьте его позже.';
};

export function PreservationV2({envelope,treeName,treeId,parentTxId,resumeFunded,quickFundedCode,initialMethod='choose',onBack,onBusy,onFundedDone}: Props) {
  const { t } = useI18n();
  const [session,setSession] = useState<SaveSession>();
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [info,setInfo] = useState('');
  const [reward,setReward] = useState<string>();
  const [promoEnvelope,setPromoEnvelope] = useState<EnvelopeV1|null>(null);
  const [saveMethod,setSaveMethod] = useState<'choose'|'promo'|'solana'>(resumeFunded || quickFundedCode ? 'promo' : initialMethod);
  const paidFlowActive = (saveMethod === 'solana' && import.meta.env.VITE_NATIVE_SOL_MAINNET === '1') || (!envelope && !promoEnvelope);
  const running = useRef(false);
  useEffect(() => {
    if (!paidFlowActive) return;
    let live=true;
    void (async()=>{
      try {
        if (envelope) {
          try { await beginSave(await envelopeText(envelope)); }
          catch (error) { if(error instanceof Error && error.message==='archive_not_authorized'){if(live)setSession(undefined);return;} throw error; }
        }
        const next=await currentSession();
        if(live) setSession(next);
      } catch(e) { if(live) setError(message(e)); }
    })();
    return()=>{live=false;};
  },[envelope,paidFlowActive]);

  // Pending network work is always reconciled from the durable session, including after reload.
  useEffect(()=>{
    if (!paidFlowActive) return;
    const recoverableBlocked=session?.state==='BLOCKED' && session.lastError==='signed_ar_transaction_mismatch' &&
      Boolean(session.arSignedTransaction&&session.arTransactionId);
    if(!['SOLANA_PENDING','AR_SIGNED','AR_UPLOADING','AR_PENDING_CONFIRMATION'].includes(session?.state??'') &&
       !(session?.state==='AR_READY'&&session.arSigningStarted) && !recoverableBlocked)return;
    let active=true,timer:ReturnType<typeof setTimeout>,attempt=0;
    const tick=async()=>{
      try{const next=await reconcileSave();if(active&&next){setSession(next);setError('');}}
      catch(e){if(active)setError(message(e));}
      if(active)timer=setTimeout(()=>void tick(),Math.min(10_000,1_500+attempt++*1_000));
    };
    timer=setTimeout(()=>void tick(),250);
    return()=>{active=false;clearTimeout(timer);};
  },[session?.state,session?.arSigningStarted,paidFlowActive]);

  useEffect(()=>{
    if(!paidFlowActive || busy || (session?.state!=='SOLANA_PAID'&&session?.state!=='AR_READY'))return;
    if(session.arSigningStarted || (session.state==='AR_READY'&&reward))return;
    let active=true;
    void prepareArweave().then(({session:next,reward:price})=>{
      if(active){setSession(next);setReward(price);setError('');}
    }).catch(e=>{if(active)setError(message(e));});
    return()=>{active=false;};
  },[session?.state,session?.arSigningStarted,reward,busy,paidFlowActive]);

  async function run(action:()=>Promise<SaveSession | void>) {
    if(running.current) return;
    running.current=true;setBusy(true);onBusy?.(true);setError('');
    try { const result=await action(); setSession(result ?? await currentSession()); }
    catch(e) {setError(message(e));setSession(await currentSession().catch(()=>undefined));}
    finally {running.current=false;setBusy(false);onBusy?.(false);}
  }
  async function choose(file?:File) {
    if(!file)return;
    await run(async()=>beginSave(await importPilotFile(file)));
  }
  async function choosePromo(file?:File){
    if(!file)return;setError('');
    try{if(file.size>524288)throw Error('envelope_too_large');setPromoEnvelope(parseEnvelope(JSON.parse(await file.text())));}
    catch{setError('Не удалось прочитать зашифрованный архив.');}
  }
  async function payNow() {
    await run(async()=>{
      const result=await pay();
      setInfo(result.state==='SOLANA_PAID'?'Оплата подтверждена.':result.state==='SOLANA_PENDING'?'Проверяем платёж в сети. Повторной оплаты нет.':'');
      return result;
    });
  }
  async function saveNow() {
    if(!reward)return;
    const confirmedReward=reward;
    setReward(undefined);
    setInfo('Загрузка зашифрованного архива...');
    await run(async()=>{
      return saveToArweave(confirmedReward);
    });
  }
  const activeEnvelope=envelope||promoEnvelope;
  if(activeEnvelope&&saveMethod==='choose')return <section className="native-checkout" aria-label="Сохранить семейную историю">
    <h1>Сохранить семейную историю</h1>
    <h2>{treeName || 'Мой род'}</h2>
    <div className="actions" style={{flexDirection:'column',alignItems:'stretch',gap:'12px'}}>
      <button className="btn" type="button" onClick={()=>setSaveMethod('promo')}>{t.publish.saveWithPromo}</button>
      <button className="btn ghost" type="button" onClick={()=>setSaveMethod('solana')}>{t.publish.saveWithSolana}</button>
    </div>
    {onBack&&<button className="btn ghost" type="button" onClick={onBack}>Назад</button>}
  </section>;

  if(activeEnvelope&&saveMethod==='promo')return <section className="native-checkout" aria-label="Сохранить по промокоду">
    <h1>Сохранить семейную историю</h1>
    <PromoFundedFlow envelope={activeEnvelope} parentTxId={parentTxId} treeId={treeId}
      autoSaveCode={resumeFunded ? null : quickFundedCode} autoComplete={Boolean(onFundedDone)} onDone={onFundedDone??onBack}/>
    <button className="btn ghost" type="button" onClick={()=>setSaveMethod('choose')}>Назад</button>
  </section>;

  if(activeEnvelope&&saveMethod==='solana'&&import.meta.env.VITE_NATIVE_SOL_MAINNET!=='1')return <section className="native-checkout" aria-label="Оплата SOL">
    <h1>{t.publish.saveWithSolana}</h1>
    <p>{t.publish.solanaUnavailable}</p>
    <button className="btn ghost" type="button" onClick={()=>setSaveMethod('choose')}>Назад</button>
  </section>;

  const state=session?.state;
  const blockedAfterPayment=state==='BLOCKED' && Boolean(session?.arSignedTransaction||session?.arTransactionId||session?.arSigningStarted);
  const paid=Boolean(state && (!['READY','SOLANA_PREPARED','SOLANA_PENDING','BLOCKED'].includes(state) || blockedAfterPayment));
  const stored=state==='COMPLETE';
  return <section className="native-checkout" aria-label="Сохранить семейную историю">
    <h1>Сохранить семейную историю</h1>
    <h2>{treeName || 'Мой род'}</h2>
    <p>Данные сохраняются в зашифрованном архиве. Ваши 12 слов SEJIRE остаются у вас.</p>
    <h3>Обычное сохранение через Solana</h3>
    <p><strong>Оплата: 0.03 SOL</strong><br/>Solana Devnet · комиссия сети отдельно</p>
    <p><strong>Хранение: Arweave Mainnet</strong><br/>Реальные AR · до 0.004 AR</p>
    <ol aria-label="Ход сохранения"><li>{paid?'✓ ':''}Оплата</li><li>{stored?'✓ ':''}Сохранение</li><li>{stored?'✓ ':''}Готово</li></ol>
    {!session && !envelope && <label>Зашифрованный архив пилота<input type="file" accept="application/json,.json" onChange={e=>void choose(e.target.files?.[0])}/></label>}
    {session && !paid && state!=='BLOCKED' && <button className="btn" disabled={busy || state==='SOLANA_PENDING'} onClick={()=>void payNow()}>Оплатить 0.03 SOL</button>}
    {state==='SOLANA_PENDING' && <p>Проверяем оплату в Solana. Повторного платежа нет.</p>}
    {paid && !stored && <p>✓ Оплата подтверждена</p>}
    {(state==='SOLANA_PAID'||state==='AR_READY') && <>
      <p>{reward?`Текущая цена хранения: ${(Number(BigInt(reward))/1e12).toFixed(12)} AR. Максимум 0.004 AR.`:'Проверяем текущую цену Arweave...'}</p>
      <p>Архив: {P.archiveBytes} байт · SHA-256: {P.archiveDigest}</p>
      <button className="btn" disabled={busy || !reward || Boolean(session?.arSigningStarted)} onClick={()=>void saveNow()}>Сохранить навсегда</button>
    </>}
    {(state==='AR_SIGNED'||state==='AR_UPLOADING'||state==='AR_PENDING_CONFIRMATION') && <p>{state==='AR_PENDING_CONFIRMATION'
      ? session?.lastError==='ar_retrieval_failed'
        ? 'Архив пока не удалось скачать из Arweave. Повторяем проверку автоматически.'
        : 'Проверяем Arweave и скачанный архив...'
      : 'Загрузка зашифрованного архива...'}</p>}
    {stored && <><p>✓ Семейная история сохранена навсегда</p><a className="btn" href="#/restore">Проверить восстановление</a></>}
    {state==='BLOCKED' && <p role="alert">{blockedAfterPayment?'Оплата подтверждена. Проверяем уже подписанную транзакцию Wander; новая оплата и новая подпись не запускаются.':'Сохранение остановлено для предотвращения повторного расхода. Нужна проверка операции.'}</p>}
    {info && state!=='BLOCKED' && <p role="status">{info}</p>}{error && <p role="alert">{error}</p>}
    {!envelope&&!promoEnvelope&&<label>Зашифрованный архив для промокода<input type="file" accept="application/json,.json" onChange={e=>void choosePromo(e.target.files?.[0])}/></label>}
    {(envelope||promoEnvelope)&&<PromoFundedFlow envelope={(envelope||promoEnvelope)!} parentTxId={parentTxId} treeId={treeId}
      autoSaveCode={resumeFunded ? null : quickFundedCode} autoComplete={Boolean(onFundedDone)} onDone={onFundedDone??onBack}/>}
    {onBack && <button className="btn ghost" disabled={busy} onClick={onBack}>Назад</button>}
  </section>;
}
