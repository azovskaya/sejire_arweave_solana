import { useEffect, useRef, useState } from 'react';
import type { EnvelopeV1 } from '../lib/crypto/encrypt';
import { envelopeText, importPilotFile, PRESERVATION_V2_PILOT_POLICY as P } from '../lib/preserveV2/policy';
import { beginSave, currentSession, pay, prepareArweave, reconcileSave, saveToArweave } from '../lib/preserveV2/machine';
import type { SaveSession } from '../lib/preserveV2/types';

type Props = { envelope?: EnvelopeV1 | null; treeName?: string; onBack?: () => void; onBusy?: (busy: boolean) => void };
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

export function PreservationV2({envelope,treeName,onBack,onBusy}: Props) {
  const [session,setSession] = useState<SaveSession>();
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [info,setInfo] = useState('');
  const running = useRef(false);
  useEffect(() => {
    let live=true;
    void (async()=>{
      try {
        if (envelope) await beginSave(await envelopeText(envelope));
        const next=await reconcileSave() ?? await currentSession();
        if(live) setSession(next);
      } catch(e) { if(live) setError(message(e)); }
    })();
    return()=>{live=false;};
  },[envelope]);

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
  async function payNow() {
    await run(async()=>{
      const result=await pay();
      setInfo(result.state==='SOLANA_PAID'?'Оплата подтверждена.':result.state==='SOLANA_PENDING'?'Проверяем платёж в сети. Повторной оплаты нет.':'');
      return result;
    });
  }
  async function saveNow() {
    await run(async()=>{
      const {reward}=await prepareArweave();
      const ar=(Number(BigInt(reward))/1e12).toFixed(12);
      if(!window.confirm(`Arweave Mainnet · реальные AR\nТекущая цена: ${ar} AR\nМаксимум: 0.004 AR\nАрхив: ${P.archiveBytes} байт\nSHA-256: ${P.archiveDigest}\n\nПодписать эту транзакцию в Wander и отправить тот же подписанный архив?`))
        return currentSession();
      setInfo('Загрузка зашифрованного архива...');
      return saveToArweave(reward);
    });
  }
  const state=session?.state;
  const paid=Boolean(state && !['READY','SOLANA_PREPARED','SOLANA_PENDING','BLOCKED'].includes(state));
  const stored=state==='COMPLETE';
  return <section className="native-checkout" aria-label="Сохранить семейную историю">
    <h1>Сохранить семейную историю</h1>
    <h2>{treeName || 'Мой род'}</h2>
    <p>Данные сохраняются в зашифрованном архиве. Ваши 12 слов SEJIRE остаются у вас.</p>
    <p><strong>Оплата: 0.03 SOL</strong><br/>Solana Devnet · комиссия сети отдельно</p>
    <p><strong>Хранение: Arweave Mainnet</strong><br/>Реальные AR · до 0.004 AR</p>
    <ol aria-label="Ход сохранения"><li>{paid?'✓ ':''}Оплата</li><li>{stored?'✓ ':''}Сохранение</li><li>{stored?'✓ ':''}Готово</li></ol>
    {!session && <label>Зашифрованный архив пилота<input type="file" accept="application/json,.json" onChange={e=>void choose(e.target.files?.[0])}/></label>}
    {session && !paid && state!=='BLOCKED' && <button className="btn" disabled={busy || state==='SOLANA_PENDING'} onClick={()=>void payNow()}>Оплатить 0.03 SOL</button>}
    {state==='SOLANA_PENDING' && <><p>Проверяем оплату. Повторный платёж заблокирован.</p><button className="btn ghost" disabled={busy} onClick={()=>void run(async()=>reconcileSave())}>Проверить статус</button></>}
    {paid && !stored && <p>✓ Оплата подтверждена</p>}
    {(state==='SOLANA_PAID'||state==='AR_READY') && <button className="btn" disabled={busy || Boolean(session?.arSigningStarted)} onClick={()=>void saveNow()}>Сохранить навсегда</button>}
    {(state==='AR_SIGNED'||state==='AR_UPLOADING'||state==='AR_PENDING_CONFIRMATION') && <><p>{state==='AR_PENDING_CONFIRMATION'?'Проверяем Arweave и скачанный архив...':'Загрузка зашифрованного архива...'}</p><button className="btn ghost" disabled={busy} onClick={()=>void run(async()=>reconcileSave())}>Проверить статус</button></>}
    {stored && <><p>✓ Семейная история сохранена навсегда</p><a className="btn" href="#/restore">Проверить восстановление</a></>}
    {state==='BLOCKED' && <p role="alert">Сохранение остановлено для предотвращения повторного расхода. Нужна проверка операции.</p>}
    {info && <p role="status">{info}</p>}{error && <p role="alert">{error}</p>}
    {onBack && <button className="btn ghost" disabled={busy} onClick={onBack}>Назад</button>}
  </section>;
}
