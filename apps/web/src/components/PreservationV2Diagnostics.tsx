import { useEffect, useState } from 'react';
import { currentSession } from '../lib/preserveV2/machine';
import type { SaveSession } from '../lib/preserveV2/types';

/** Read-only admin diagnostics. Never render ciphertext, signed transaction bytes or recovery material. */
export function PreservationV2Diagnostics({onHome,embedded=false}:{onHome?:()=>void;embedded?:boolean}) {
  const [session,setSession]=useState<SaveSession>();
  const [error,setError]=useState(false);
  useEffect(()=>{let live=true;void currentSession().then(s=>{if(live)setSession(s);}).catch(()=>{if(live)setError(true);});return()=>{live=false;};},[]);
  const content=<section aria-label="Диагностика сохранения V2">
    <h1>Диагностика сохранения V2</h1>
    {error?<p>Локальный журнал недоступен.</p>:!session?<p>Сохранение V2 на этом устройстве не найдено.</p>:<dl>
      <dt>Состояние</dt><dd>{session.state}</dd>
      <dt>Создано</dt><dd>{new Date(session.createdAt).toLocaleString()}</dd>
      <dt>Обновлено</dt><dd>{new Date(session.updatedAt).toLocaleString()}</dd>
      <dt>Размер архива</dt><dd>{session.archiveBytes} байт</dd>
      <dt>SHA-256 архива</dt><dd>{session.archiveDigest}</dd>
      <dt>Solana signature</dt><dd>{session.solanaSignature??'—'}</dd>
      <dt>Arweave ID</dt><dd>{session.arTransactionId??'—'}</dd>
      <dt>Последний безопасный код</dt><dd>{session.lastError??'—'}</dd>
    </dl>}
    {!embedded&&onHome&&<button className="btn ghost" onClick={onHome}>На главную</button>}
  </section>;
  return embedded?content:<main className="landing">{content}</main>;
}
