export const TREASURY_ADDRESS = 'qgoIFw9WsusMRapWzcFg4jNW08HSWvQkpAKOz86BUuI';
export const INITIAL_LIMIT = '13000000000000';
export type FundStatus = 'RESERVED'|'SIGNED'|'SUBMITTED'|'VERIFYING'|'COMPLETED'|'FAILED'|'RELEASED'|'NEEDS_RECONCILIATION';
const active = new Set<FundStatus>(['RESERVED','SIGNED','SUBMITTED','VERIFYING','NEEDS_RECONCILIATION']);
const terminal = new Set<FundStatus>(['COMPLETED','FAILED','RELEASED']);
const money = (s: string) => { if (!/^(0|[1-9][0-9]{0,29})$/.test(s)) throw Error('invalid_winston'); return BigInt(s); };
export function parseAr(value: string): string {
  if (!/^(0|[1-9][0-9]{0,5})(?:\.[0-9]{1,12})?$/.test(value)) throw Error('invalid_ar_amount');
  const [whole, fraction=''] = value.split('.'); return (BigInt(whole)*1000000000000n+BigInt(fraction.padEnd(12,'0'))).toString();
}
export type FundOrder = {preservationId:string;orderId:string;promoRevision:number;archiveSizeBytes:number;archiveDigest:string;vaultId:string;estimatedRewardWinston:string;reservedRewardWinston:string;actualRewardWinston:string|null;arweaveTxId:string|null;status:FundStatus;createdAt:number;uploadedAt:number|null;verifiedAt:number|null;signedTransaction?:string|null;preparedTransaction?:string|null};
export class FundLedger {
  private sql: SqlStorage;
  constructor(private storage: DurableObjectStorage) {
    this.sql=storage.sql;
    storage.transactionSync(()=>this.sql.exec(`
      CREATE TABLE IF NOT EXISTS fund_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL,code_hash TEXT NOT NULL,display_hint TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,limit_winston TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fund_orders(order_id TEXT PRIMARY KEY,preservation_id TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,archive_bytes INTEGER NOT NULL,digest TEXT NOT NULL,vault_id TEXT NOT NULL,estimate TEXT NOT NULL,reserved TEXT NOT NULL,created_at INTEGER NOT NULL,prepared_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fund_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,order_id TEXT NOT NULL,status TEXT NOT NULL,tx_id TEXT,actual TEXT,signed_json TEXT,at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS fund_events_order ON fund_events(order_id,seq);
      CREATE TABLE IF NOT EXISTS fund_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,action TEXT NOT NULL,details TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS fund_rates(bucket TEXT PRIMARY KEY,start INTEGER NOT NULL,count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS fund_meta(id INTEGER PRIMARY KEY CHECK(id=1),reconciled_at INTEGER);`));
    this.sql.exec('INSERT OR IGNORE INTO fund_settings VALUES(1,0,\'\',\'\',0,0,0,?)',INITIAL_LIMIT);
    this.sql.exec('INSERT OR IGNORE INTO fund_meta(id,reconciled_at) VALUES(1,NULL)');
  }
  settings(){return this.sql.exec<{enabled:number;code_hash:string;display_hint:string;revision:number;created_at:number;updated_at:number;limit_winston:string}>('SELECT * FROM fund_settings WHERE id=1').toArray()[0];}
  private orders(includeSigned=false):FundOrder[]{
    const rows=this.sql.exec<{order_id:string;preservation_id:string;revision:number;archive_bytes:number;digest:string;vault_id:string;estimate:string;reserved:string;created_at:number;prepared_json:string;status:FundStatus;tx_id:string|null;actual:string|null;signed_json:string|null;uploaded_at:number|null;verified_at:number|null}>(`SELECT o.*,e.status,e.tx_id,e.actual,e.signed_json,
      (SELECT MIN(at) FROM fund_events WHERE order_id=o.order_id AND status IN ('SUBMITTED','VERIFYING','COMPLETED')) AS uploaded_at,
      (SELECT MIN(at) FROM fund_events WHERE order_id=o.order_id AND status='COMPLETED') AS verified_at
      FROM fund_orders o JOIN fund_events e ON e.seq=(SELECT MAX(seq) FROM fund_events WHERE order_id=o.order_id) ORDER BY o.created_at DESC`).toArray();
    return rows.map(r=>({preservationId:r.preservation_id,orderId:r.order_id,promoRevision:r.revision,archiveSizeBytes:r.archive_bytes,archiveDigest:r.digest,vaultId:r.vault_id,estimatedRewardWinston:r.estimate,reservedRewardWinston:r.reserved,actualRewardWinston:r.actual,arweaveTxId:r.tx_id,status:r.status,createdAt:r.created_at,uploadedAt:r.uploaded_at,verifiedAt:r.verified_at,...(includeSigned?{signedTransaction:r.signed_json,preparedTransaction:r.prepared_json}:{})}));
  }
  order(id:string,includeSigned=false){return this.orders(includeSigned).find(x=>x.orderId===id)??null;}
  summary(now=Date.now()){
    const settings=this.settings(),orders=this.orders(),done=orders.filter(x=>x.status==='COMPLETED');
    const spent=done.reduce((n,x)=>n+money(x.actualRewardWinston??'0'),0n);
    const reserved=orders.filter(x=>active.has(x.status)).reduce((n,x)=>n+money(x.reservedRewardWinston),0n);
    const limit=money(settings.limit_winston),remaining=limit>spent+reserved?limit-spent-reserved:0n;
    const sizes=done.map(x=>x.archiveSizeBytes),costs=done.map(x=>money(x.actualRewardWinston??'0'));
    return {promo:{enabled:Boolean(settings.enabled),displayHint:settings.display_hint,revision:settings.revision,createdAt:settings.created_at,updatedAt:settings.updated_at},treasuryAddress:TREASURY_ADDRESS,
      limitWinston:settings.limit_winston,actualSpentWinston:spent.toString(),reservedWinston:reserved.toString(),budgetRemainingWinston:remaining.toString(),
      successfulTrees:done.length,today:done.filter(x=>x.verifiedAt!==null&&x.verifiedAt>=now-86400000).length,last7Days:done.filter(x=>x.verifiedAt!==null&&x.verifiedAt>=now-7*86400000).length,
      failedAttempts:orders.filter(x=>x.status==='FAILED'||x.status==='RELEASED').length,pending:orders.filter(x=>active.has(x.status)).length,
      totalEncryptedBytes:sizes.reduce((a,b)=>a+b,0),averageArchiveBytes:sizes.length?Math.round(sizes.reduce((a,b)=>a+b,0)/sizes.length):null,
      largestArchiveBytes:sizes.length?Math.max(...sizes):null,smallestArchiveBytes:sizes.length?Math.min(...sizes):null,
      averageActualWinston:costs.length?(spent/BigInt(costs.length)).toString():null,
      minActualWinston:costs.length?costs.reduce((a,b)=>a<b?a:b).toString():null,maxActualWinston:costs.length?costs.reduce((a,b)=>a>b?a:b).toString():null,
      latestActualWinston:done[0]?.actualRewardWinston??null,currentRevisionTrees:done.filter(x=>x.promoRevision===settings.revision).length,
      currentRevisionSpentWinston:done.filter(x=>x.promoRevision===settings.revision).reduce((n,x)=>n+money(x.actualRewardWinston??'0'),0n).toString(),
      lastReconciliation:this.sql.exec<{reconciled_at:number|null}>('SELECT reconciled_at FROM fund_meta WHERE id=1').toArray()[0].reconciled_at,
      history:orders.map(({signedTransaction,...x})=>x)};
  }
  async rate(bucket:string,limit:number,now=Date.now()){
    this.storage.transactionSync(()=>{const row=this.sql.exec<{start:number;count:number}>('SELECT start,count FROM fund_rates WHERE bucket=?',bucket).toArray()[0];
      if(row&&now-row.start<60000&&row.count>=limit)throw Error('rate_limited');
      this.sql.exec('INSERT INTO fund_rates VALUES(?,?,1) ON CONFLICT(bucket) DO UPDATE SET start=?,count=?',bucket,now,now,row&&now-row.start<60000?row.count+1:1);});await this.storage.sync();
  }
  async promo(hash:string,hint:string,now=Date.now()){
    this.storage.transactionSync(()=>{const s=this.settings(),revision=s.revision+1;
      this.sql.exec('UPDATE fund_settings SET enabled=1,code_hash=?,display_hint=?,revision=?,created_at=CASE WHEN created_at=0 THEN ? ELSE created_at END,updated_at=? WHERE id=1',hash,hint,revision,now,now);
      this.sql.exec('INSERT INTO fund_audit(action,details,at) VALUES(?,?,?)','PROMO_CHANGED',JSON.stringify({oldRevision:s.revision,newRevision:revision}),now);});await this.storage.sync();return this.summary();
  }
  async enable(enabled:boolean,now=Date.now()){
    if(enabled&&!this.settings().code_hash)throw Error('promo_missing');
    this.sql.exec('UPDATE fund_settings SET enabled=?,updated_at=? WHERE id=1',enabled?1:0,now);
    this.sql.exec('INSERT INTO fund_audit(action,details,at) VALUES(?,?,?)',enabled?'PROMO_ENABLED':'PROMO_DISABLED','{}',now);
    await this.storage.sync();return this.summary();
  }
  async limit(value:string,now=Date.now()){
    const amount=money(value),s=this.settings(),summary=this.summary(),spent=money(summary.actualSpentWinston);
    if(amount<spent)throw Error('limit_below_spent');
    if(amount<spent+money(summary.reservedWinston))throw Error('limit_below_reserved');
    this.storage.transactionSync(()=>{this.sql.exec('UPDATE fund_settings SET limit_winston=? WHERE id=1',value);
      this.sql.exec('INSERT INTO fund_audit(action,details,at) VALUES(?,?,?)','FUND_LIMIT_CHANGED',JSON.stringify({oldLimit:s.limit_winston,newLimit:value}),now);});await this.storage.sync();return this.summary();
  }
  async reserve(input:{orderId:string;preservationId:string;hash:string;archiveSizeBytes:number;archiveDigest:string;vaultId:string;reward:string;estimated:string;prepared:string;balance:string},now=Date.now()){
    const amount=money(input.reward);money(input.estimated);const walletBalance=money(input.balance);if(amount<=0n)throw Error('invalid_reward');
    const result=this.storage.transactionSync(()=>{
      const prior=this.order(input.orderId,true);if(prior){if(prior.archiveDigest!==input.archiveDigest||prior.archiveSizeBytes!==input.archiveSizeBytes||prior.vaultId!==input.vaultId)throw Error('archive_changed');return prior;}
      const s=this.settings();if(!s.enabled)throw Error('promo_disabled');if(!s.code_hash||s.code_hash!==input.hash)throw Error('promo_invalid');
      const summary=this.summary(now);if(amount>money(summary.budgetRemainingWinston))throw Error('fund_exhausted');
      if(amount+money(summary.reservedWinston)>walletBalance)throw Error('wallet_low');
      this.sql.exec('INSERT INTO fund_orders VALUES(?,?,?,?,?,?,?,?,?,?)',input.orderId,input.preservationId,s.revision,input.archiveSizeBytes,input.archiveDigest,input.vaultId,input.estimated,input.reward,now,input.prepared);
      this.sql.exec('INSERT INTO fund_events(order_id,status,at) VALUES(?,?,?)',input.orderId,'RESERVED',now);
      return this.order(input.orderId,true)!;});await this.storage.sync();return result;
  }
  async event(input:{orderId:string;status:FundStatus;txId?:string;actual?:string;signed?:string},now=Date.now()){
    const next=this.storage.transactionSync(()=>{const prior=this.order(input.orderId,true);if(!prior)throw Error('order_not_found');
      if(terminal.has(prior.status)||prior.status===input.status)return prior;
      if(input.status==='SIGNED'){if(prior.arweaveTxId)return prior;if(prior.status!=='RESERVED'||!input.txId||!input.signed)throw Error('invalid_signed_tx');}
      if(prior.arweaveTxId&&input.txId&&prior.arweaveTxId!==input.txId)throw Error('tx_conflict');
      if(input.status==='COMPLETED'&&(!prior.arweaveTxId||!input.actual||money(input.actual)<=0n||money(input.actual)>money(prior.reservedRewardWinston)))throw Error('invalid_actual_reward');
      if((input.status==='FAILED'||input.status==='RELEASED')&&prior.arweaveTxId)throw Error('signed_tx_must_reconcile');
      this.sql.exec('INSERT INTO fund_events(order_id,status,tx_id,actual,signed_json,at) VALUES(?,?,?,?,?,?)',input.orderId,input.status,input.txId??prior.arweaveTxId,input.actual??prior.actualRewardWinston,input.signed??prior.signedTransaction,now);
      return this.order(input.orderId,true)!;});await this.storage.sync();return next;
  }
  async reconciled(now=Date.now()){
    const seen=new Set<string>();
    for(const row of this.orders()){
      if(row.arweaveTxId){if(seen.has(row.arweaveTxId))throw Error('fund_ledger_inconsistent');seen.add(row.arweaveTxId);}
      if(row.status==='COMPLETED'&&(!row.arweaveTxId||!row.actualRewardWinston||money(row.actualRewardWinston)>money(row.reservedRewardWinston)))throw Error('fund_ledger_inconsistent');
    }
    this.sql.exec('UPDATE fund_meta SET reconciled_at=? WHERE id=1',now);
    this.sql.exec('INSERT INTO fund_audit(action,details,at) VALUES(?,?,?)','FUND_RECONCILED','{}',now);await this.storage.sync();return this.summary(now);
  }
}
