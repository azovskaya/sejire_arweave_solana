import { useEffect, useMemo, useState } from 'react';
import { formatAr, fundChangePromo, fundDashboard, fundEnable, fundLimit, fundReconcile, publicFundBalance, type FundDashboard } from '../lib/fund/client';
const errors:Record<string,string>={admin_unauthorized:'Server admin credential required.',limit_below_spent:'Fund limit cannot be lower than actual confirmed spend.',limit_below_reserved:'Fund limit cannot be lower than confirmed spend plus active reservations.',fund_provider_unavailable:'Fund provider unavailable.',invalid_promo_format:'Use at least 6 letters, digits or hyphens.',promo_confirmation_mismatch:'Promo code confirmation does not match.',fund_ledger_inconsistent:'Fund ledger has inconsistent records. Review the server audit before enabling new uploads.'};
const date=(at:number|null)=>at?new Date(at).toLocaleString():'—';
const size=(bytes:number|null)=>bytes==null?'—':bytes>=1048576?`${(bytes/1048576).toFixed(2)} MB`:`${(bytes/1024).toFixed(1)} KB`;
export function FundAdmin(){
  const [credential,setCredential]=useState(''),[data,setData]=useState<FundDashboard|null>(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const [publicBalance,setPublicBalance]=useState<{treasuryAddress:string;walletBalanceWinston:string|null;lastBalanceCheck:number|null}|null>(null);
  const [code,setCode]=useState(''),[confirm,setConfirm]=useState(''),[showCode,setShowCode]=useState(false),[limit,setLimit]=useState('');
  const [statusFilter,setStatusFilter]=useState('All'),[timeFilter,setTimeFilter]=useState('All time');
  async function refresh(){setBusy(true);setError('');try{setPublicBalance(await publicFundBalance());if(credential)setData(await fundDashboard(credential));}catch(e){setData(null);setError(errors[(e as Error).message]||(e as Error).message);}finally{setBusy(false);}}
  useEffect(()=>{let live=true;void publicFundBalance().then(balance=>{if(live)setPublicBalance(balance);}).catch(()=>{if(live)setPublicBalance(null);});return()=>{live=false;};},[]);
  async function mutate(operation:()=>Promise<unknown>,success:string,interpretPending=false){setBusy(true);setError('');setMessage('');try{const result=await operation() as {pending?:number};setMessage(interpretPending&&result.pending?'Reconciliation checked the fund; some transactions remain pending.':success);setData(await fundDashboard(credential));}catch(e){setError(errors[(e as Error).message]||(e as Error).message);}finally{setBusy(false);}}
  const filtered=useMemo(()=>data?.history.filter(row=>{
    const status=statusFilter==='All'||(statusFilter==='Pending'&&['RESERVED','SIGNED','SUBMITTED','VERIFYING','NEEDS_RECONCILIATION'].includes(row.status))||(statusFilter==='Failed'&&['FAILED','RELEASED'].includes(row.status))||row.status===statusFilter.toUpperCase();
    const time=timeFilter==='All time'||row.createdAt>=Date.now()-(timeFilter==='Today'?86400000:7*86400000);return status&&time;})??[],[data,statusFilter,timeFilter]);
  let newRemaining:string|null=null;try{if(data&&limit){const [w,f='']=limit.split('.');if(/^\d+$/.test(w)&&/^\d{0,12}$/.test(f)){const next=BigInt(w)*1000000000000n+BigInt(f.padEnd(12,'0'));newRemaining=formatAr((next-BigInt(data.actualSpentWinston)).toString());}}}catch{ /* invalid preview */ }
  const progress=data&&BigInt(data.limitWinston)>0n?Number(BigInt(data.actualSpentWinston)*10000n/BigInt(data.limitWinston))/100:0;
  return <section className="fund-admin" aria-label="Free Preservation Fund"><h2>FREE PRESERVATION FUND</h2>
    <label>Server admin credential<input type="password" autoComplete="off" value={credential} onChange={e=>setCredential(e.target.value)}/></label>
    <button className="btn ghost" disabled={busy} onClick={()=>void refresh()}>Refresh balance and dashboard</button>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    {!data&&<div className="ops-desk-card"><p>Treasury <code>{publicBalance?.treasuryAddress??'qgoIFw9WsusMRapWzcFg4jNW08HSWvQkpAKOz86BUuI'}</code></p>
      <p>Live wallet balance <strong>{publicBalance?.walletBalanceWinston==null?'Balance unavailable':`${formatAr(publicBalance.walletBalanceWinston)} AR`}</strong></p>
      <p>Last balance check {date(publicBalance?.lastBalanceCheck??null)}</p><p>Enter the server admin credential to view and manage the fund.</p></div>}
    {data&&<>
      <div className="fund-admin-grid"><section className="ops-desk-card"><h3>PROMO CODE</h3>
        <p>Status <strong>{data.promo.enabled?'ACTIVE':'DISABLED'}</strong></p><p>Current code <strong>{data.promo.displayHint||'—'}</strong></p>
        <p>Revision {data.promo.revision} · Changed {date(data.promo.updatedAt)}</p>
        <button className="btn ghost" onClick={()=>setShowCode(v=>!v)}>Change promo code</button>
        <button className="btn ghost" disabled={busy} onClick={()=>void mutate(()=>fundEnable(credential,!data.promo.enabled),data.promo.enabled?'Promo disabled.':'Promo enabled.')}>{data.promo.enabled?'Disable':'Enable'}</button>
        {showCode&&<div className="fund-admin-form"><label>New promo code<input value={code} autoComplete="off" onChange={e=>setCode(e.target.value)}/></label>
          <label>Confirm new promo code<input value={confirm} autoComplete="off" onChange={e=>setConfirm(e.target.value)}/></label>
          <p>Changing the promo code will invalidate the previous code.</p>
          <button className="btn" disabled={busy||!code||code!==confirm} onClick={()=>{if(window.confirm('Changing the promo code will invalidate the previous code.'))void mutate(async()=>{await fundChangePromo(credential,code,confirm);setCode('');setConfirm('');setShowCode(false);},'New promo code is active. Previous promo code is no longer valid.');}}>SAVE NEW CODE</button></div>}
        <p>Current revision: {data.currentRevisionTrees} trees · {formatAr(data.currentRevisionSpentWinston)} AR</p>
        <p>All time: {data.successfulTrees} trees · {formatAr(data.actualSpentWinston)} AR</p>
      </section>
      <section className="ops-desk-card"><h3>ARWEAVE FUND</h3>
        <p>Treasury <code>{data.treasuryAddress.slice(0,7)}…{data.treasuryAddress.slice(-5)}</code></p>
        <p>Live wallet balance <strong>{data.walletBalanceWinston==null?'Balance unavailable':`${formatAr(data.walletBalanceWinston)} AR`}</strong></p>
        <p>Last balance check {date(data.lastBalanceCheck)}</p>
        <p>Promo fund limit <strong>{formatAr(data.limitWinston)} AR</strong></p><p>Actual confirmed spend <strong>{formatAr(data.actualSpentWinston)} AR</strong></p>
        <p>Reserved / in progress <strong>{formatAr(data.reservedWinston)} AR</strong></p><p>Budget remaining <strong>{formatAr(data.budgetRemainingWinston)} AR</strong></p>
        <p>Effective available now <strong>{formatAr(data.effectiveAvailableWinston)} AR</strong></p>
        <progress max="100" value={progress}/><p>Spent {progress.toFixed(2)}% · {data.fundStatus}</p>
        <label>New cumulative limit (AR)<input inputMode="decimal" value={limit} placeholder={formatAr(data.limitWinston)} onChange={e=>setLimit(e.target.value)}/></label>
        <p>Current actual spend: {formatAr(data.actualSpentWinston)} AR · New remaining budget: {newRemaining??'—'} AR</p>
        <button className="btn" disabled={busy||newRemaining==null||newRemaining.startsWith('-')} onClick={()=>void mutate(async()=>{await fundLimit(credential,limit);setLimit('');},'Fund limit updated successfully.')}>UPDATE FUND LIMIT</button>
        <button className="btn ghost" disabled={busy} onClick={()=>void mutate(()=>fundReconcile(credential),'Fund reconciled successfully.',true)}>RECONCILE FUND</button>
        <p>Last reconciliation: {date(data.lastReconciliation)}</p>
      </section></div>
      <div className="fund-admin-grid"><section className="ops-desk-card"><h3>PRESERVATIONS</h3>
        <p>Saved trees {data.successfulTrees} · Today {data.today} · Last 7 days {data.last7Days}</p>
        <p>Pending {data.pending} · Failed {data.failedAttempts}</p>
        <p>Total encrypted bytes {size(data.totalEncryptedBytes)} · Average {size(data.averageArchiveBytes)}</p>
        <p>Largest {size(data.largestArchiveBytes)} · Smallest {size(data.smallestArchiveBytes)}</p>
      </section><section className="ops-desk-card"><h3>COST & CAPACITY</h3>
        <p>Average/tree {formatAr(data.averageActualWinston)} AR · Latest/tree {formatAr(data.latestActualWinston)} AR</p>
        <p>Min {formatAr(data.minActualWinston)} AR · Max {formatAr(data.maxActualWinston)} AR</p>
        <p>Total actual {formatAr(data.actualSpentWinston)} AR · Current network price estimate ({size(data.currentQuoteBytes)}) {formatAr(data.currentQuoteWinston)} AR</p>
        <p>Estimated funded preservations remaining: {data.estimatedTreesRemaining??'Not enough data yet'}</p>
      </section></div>
      <section><h3>FUNDED PRESERVATION HISTORY</h3><div className="fund-admin-filters"><label>Status<select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}>{['All','Completed','Pending','Failed'].map(x=><option key={x}>{x}</option>)}</select></label>
        <label>Period<select value={timeFilter} onChange={e=>setTimeFilter(e.target.value)}>{['Today','7 days','All time'].map(x=><option key={x}>{x}</option>)}</select></label></div>
        <div className="fund-admin-history"><table className="ops-desk-table"><thead><tr><th>Date</th><th>Status</th><th>Archive size</th><th>Actual cost AR</th><th>Promo revision</th><th>Arweave TX</th><th>Preservation ID</th></tr></thead>
          <tbody>{filtered.map(row=><tr key={row.orderId}><td data-label="Date">{date(row.createdAt)}</td><td data-label="Status">{row.status}</td><td data-label="Archive size">{size(row.archiveSizeBytes)}</td><td data-label="Actual cost AR">{formatAr(row.actualRewardWinston)}</td><td data-label="Promo revision">{row.promoRevision}</td>
            <td data-label="Arweave TX">{row.arweaveTxId?<a href={`https://arweave.net/${row.arweaveTxId}`} target="_blank" rel="noreferrer">{row.arweaveTxId.slice(0,7)}…{row.arweaveTxId.slice(-5)}</a>:'—'}</td>
            <td data-label="Preservation ID"><code>{row.preservationId.slice(0,8)}…</code></td></tr>)}</tbody></table></div>
      </section>
    </>}
  </section>;
}
