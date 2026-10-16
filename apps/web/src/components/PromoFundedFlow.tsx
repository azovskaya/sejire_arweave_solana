import { useEffect, useState } from 'react';
import type { EnvelopeV1 } from '../lib/crypto/encrypt';
import { journalKey, preserveFunded, readFundOrder, validatePromo, type FundOrderView } from '../lib/fund/client';
const errors:Record<string,string>={promo_invalid:'Promo code is invalid.',promo_disabled:'Free preservation is currently unavailable.',fund_exhausted:'Free preservation fund is temporarily unavailable.',wallet_low:'Free preservation fund is temporarily unavailable.',fund_provider_unavailable:'Fund provider unavailable.',archive_changed:'The encrypted archive changed. Start a new preservation order.'};
export function PromoFundedFlow({envelope}:{envelope:EnvelopeV1}){
  const [code,setCode]=useState(''),[accepted,setAccepted]=useState(false),[order,setOrder]=useState<FundOrderView|null>(null),[orderId,setOrderId]=useState(''),[key,setKey]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let live=true;setAccepted(false);setOrder(null);setOrderId('');setKey('');void journalKey(envelope).then(async k=>{if(!live)return;setKey(k);const id=sessionStorage.getItem(k);if(id){setOrderId(id);try{const result=await readFundOrder(id);if(live)setOrder(result.order);}catch{ /* order remains locally journalled */ }}});return()=>{live=false;};},[envelope]);
  const pendingOrderId=order?.orderId,pendingStatus=order?.status;
  useEffect(()=>{if(!pendingOrderId||['COMPLETED','FAILED','RELEASED'].includes(pendingStatus??''))return;let live=true;const timer=setInterval(()=>{void readFundOrder(pendingOrderId).then(x=>{if(live)setOrder(x.order);}).catch(()=>{});},6000);return()=>{live=false;clearInterval(timer);};},[pendingOrderId,pendingStatus]);
  async function apply(){setBusy(true);setError('');try{await validatePromo(code);setAccepted(true);}catch(e){setError(errors[(e as Error).message]||'Free preservation is temporarily unavailable.');}finally{setBusy(false);}}
  async function save(){if(!accepted||busy||!key)return;setBusy(true);setError('');try{let id=orderId;if(!id){id=crypto.randomUUID().replace(/-/g,'');sessionStorage.setItem(key,id);setOrderId(id);}const result=await preserveFunded(envelope,code,id);setOrder(result.order);setCode('');}catch(e){setError(errors[(e as Error).message]||'Preservation needs reconciliation. The same order will be checked; no new payment is started.');}finally{setBusy(false);}}
  return <section className="funded-flow" aria-label="Free preservation">
    <h2>Have a promo code?</h2><p>SEJIRE pays Arweave storage for an encrypted archive. Your Solana payment: 0 SOL.</p>
    {!order&&<><label>Promo code<input value={code} autoComplete="off" onChange={e=>{setCode(e.target.value);setAccepted(false);}}/></label>
      <button type="button" className="btn ghost" disabled={busy||!code.trim()} onClick={()=>void apply()}>Apply promo code</button>
      {accepted&&<><p role="status">✓ Promo code accepted. Your preservation will be funded by SEJIRE.</p><button type="button" className="btn" disabled={busy||!key} onClick={()=>void save()}>Preserve encrypted tree for free</button></>}</>}
    {order&&<><p role="status">Status: {order.status}{order.status==='COMPLETED'?' · Verified and complete.':' · Checking the same Arweave transaction.'}</p>
      {order.arweaveTxId&&<a href={`https://arweave.net/${order.arweaveTxId}`} target="_blank" rel="noreferrer">Arweave transaction {order.arweaveTxId.slice(0,7)}…{order.arweaveTxId.slice(-5)}</a>}
      {order.status==='COMPLETED'&&<p>✓ Семейная история сохранена навсегда. Ваши слова SEJIRE остаются у вас.</p>}
      {['FAILED','RELEASED'].includes(order.status)&&<button className="btn ghost" onClick={()=>{if(key)sessionStorage.removeItem(key);setOrder(null);setOrderId('');setAccepted(false);setCode('');}}>Start a new preservation order</button>}</>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
