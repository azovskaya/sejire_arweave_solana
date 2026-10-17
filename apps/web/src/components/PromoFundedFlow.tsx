import { useEffect, useState } from 'react';
import type { EnvelopeV1 } from '../lib/crypto/encrypt';
import { journalKey, preserveFunded, readFundOrder, validatePromo, type FundOrderView } from '../lib/fund/client';

const errors:Record<string,string>={
  promo_invalid:'Неверный промокод.',
  promo_disabled:'Промокод временно недоступен.',
  fund_exhausted:'Лимит бесплатных сохранений исчерпан.',
  wallet_low:'Фонд временно недоступен.',
  fund_provider_unavailable:'Фонд временно недоступен.',
  archive_changed:'Архив изменился. Начните сохранение заново.'
};

export function PromoFundedFlow({envelope}:{envelope:EnvelopeV1}){
  const [code,setCode]=useState(''),[order,setOrder]=useState<FundOrderView|null>(null),[orderId,setOrderId]=useState(''),[key,setKey]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let live=true;setOrder(null);setOrderId('');setKey('');void journalKey(envelope).then(async k=>{if(!live)return;setKey(k);const id=sessionStorage.getItem(k);if(id){setOrderId(id);try{const result=await readFundOrder(id);if(live)setOrder(result.order);}catch{}}});return()=>{live=false;};},[envelope]);
  const pendingOrderId=order?.orderId,pendingStatus=order?.status;
  useEffect(()=>{if(!pendingOrderId||['COMPLETED','FAILED','RELEASED'].includes(pendingStatus??''))return;let live=true;const timer=setInterval(()=>{void readFundOrder(pendingOrderId).then(x=>{if(live)setOrder(x.order);}).catch(()=>{});},6000);return()=>{live=false;clearInterval(timer);};},[pendingOrderId,pendingStatus]);

  async function save(){
    if(busy||!key||!code.trim())return;
    setBusy(true);setError('');
    try{
      await validatePromo(code);
      let id=orderId;
      if(!id){id=crypto.randomUUID().replace(/-/g,'');sessionStorage.setItem(key,id);setOrderId(id);}
      const result=await preserveFunded(envelope,code,id);
      setOrder(result.order);
    }catch(e){setError(errors[(e as Error).message]||'Сохранение требует проверки. Повторный платёж не создаётся.');}
    finally{setBusy(false);}
  }

  return <section className="funded-flow" aria-label="Сохранение по промокоду">
    <h2>Промокод</h2>
    {!order&&<>
      <input aria-label="Промокод" placeholder="Введите промокод" value={code} autoComplete="off" onChange={e=>setCode(e.target.value)} />
      <button type="button" className="btn" disabled={busy||!code.trim()||!key} onClick={()=>void save()}>{busy?'Сохраняем…':'Сохранить бесплатно'}</button>
    </>}
    {order&&<>
      {order.status==='COMPLETED'
        ? <p role="status">✓ Сохранено</p>
        : <p role="status">Сохраняем…</p>}
      {order.arweaveTxId&&<a href={`https://arweave.net/${order.arweaveTxId}`} target="_blank" rel="noreferrer">Arweave TX</a>}
      {['FAILED','RELEASED'].includes(order.status)&&<button className="btn ghost" onClick={()=>{if(key)sessionStorage.removeItem(key);setOrder(null);setOrderId('');setCode('');}}>Попробовать снова</button>}
    </>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}