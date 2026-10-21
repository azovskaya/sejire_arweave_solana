/** Physical AR guard shared by promo and paid; their quotas remain independent.
 * Mutations run inside the caller's synchronous SQLite transaction. A revision
 * captured BEFORE a balance read detects concurrent debits. A persisted
 * conservative ceiling also rejects a gateway snapshot that lagged an earlier
 * debit. A higher unproven balance never automatically releases more money. */
export const winston = (value: string): bigint => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,29})$/.test(value)) throw Error('invalid_winston');
  return BigInt(value);
};
export class TreasuryGuard {
  private readonly sql: SqlStorage;
  constructor(storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS treasury_revision(address TEXT PRIMARY KEY,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS treasury_balance_ceiling(address TEXT PRIMARY KEY,balance TEXT,unobserved_debit TEXT NOT NULL DEFAULT '0');
      CREATE TABLE IF NOT EXISTS paid_holds(order_id TEXT PRIMARY KEY,budget_id TEXT NOT NULL,treasury TEXT NOT NULL,
        reward TEXT NOT NULL,actual TEXT,released INTEGER NOT NULL DEFAULT 0);`);
  }
  revision(address: string): number {
    return this.sql.exec<{revision: number}>('SELECT revision FROM treasury_revision WHERE address=?', address).toArray()[0]?.revision ?? 0;
  }
  debit(address: string, actual: string): void {
    const amount=winston(actual);
    this.sql.exec('INSERT INTO treasury_revision(address,revision) VALUES(?,1) ON CONFLICT(address) DO UPDATE SET revision=revision+1', address);
    const row=this.sql.exec<{balance:string|null;unobserved_debit:string}>('SELECT balance,unobserved_debit FROM treasury_balance_ceiling WHERE address=?',address).toArray()[0];
    if(row?.balance!==null&&row?.balance!==undefined){
      const remaining=winston(row.balance)>amount?winston(row.balance)-amount:0n;
      this.sql.exec('UPDATE treasury_balance_ceiling SET balance=? WHERE address=?',remaining.toString(),address);
    }else{
      const pending=winston(row?.unobserved_debit??'0')+amount;
      this.sql.exec('INSERT INTO treasury_balance_ceiling(address,balance,unobserved_debit) VALUES(?,NULL,?) ON CONFLICT(address) DO UPDATE SET unobserved_debit=excluded.unobserved_debit',address,pending.toString());
    }
  }
  effectiveBalance(address:string,observed:string):string{
    const row=this.sql.exec<{balance:string|null;unobserved_debit:string}>('SELECT balance,unobserved_debit FROM treasury_balance_ceiling WHERE address=?',address).toArray()[0];
    const fresh=winston(observed);
    if(row?.balance!==null&&row?.balance!==undefined)return (winston(row.balance)<fresh?winston(row.balance):fresh).toString();
    const pending=winston(row?.unobserved_debit??'0');
    return (fresh>pending?fresh-pending:0n).toString();
  }
  paidTotals(budgetId?: string, address?: string) {
    const rows = this.sql.exec<{reward: string; actual: string | null; released: number}>(
      'SELECT reward,actual,released FROM paid_holds WHERE (? IS NULL OR budget_id=?) AND (? IS NULL OR treasury=?)',
      budgetId ?? null, budgetId ?? null, address ?? null, address ?? null).toArray();
    let reserved = 0n, spent = 0n;
    for (const row of rows) {
      if (row.actual !== null) spent += winston(row.actual);
      else if (!row.released) reserved += winston(row.reward);
    }
    return {reservedWinston: reserved.toString(), actualSpentWinston: spent.toString()};
  }
  held(address: string, promoTreasury: string): string {
    let held = winston(this.paidTotals(undefined, address).reservedWinston);
    if (address === promoTreasury && this.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='fund_orders'").toArray().length) {
      const rows = this.sql.exec<{reserved: string}>(`SELECT o.reserved FROM fund_orders o
        JOIN fund_events e ON e.seq=(SELECT MAX(seq) FROM fund_events WHERE order_id=o.order_id)
        WHERE e.status IN ('RESERVED','SIGNED','SUBMITTED','VERIFYING','NEEDS_RECONCILIATION')`).toArray();
      for (const row of rows) held += winston(row.reserved);
    }
    return held.toString();
  }
  assertBalance(address: string, promoTreasury: string, balance: string, additional: string, observedRevision?: number): void {
    // Optional only for historical internal adapters. All current HTTP callers
    // supply a revision; after any paid history unversioned adapters fail closed.
    if (observedRevision === undefined) {
      if (this.sql.exec('SELECT order_id FROM paid_holds LIMIT 1').toArray().length) throw Error('balance_observation_stale');
    } else if (!Number.isSafeInteger(observedRevision) || observedRevision !== this.revision(address)) throw Error('balance_observation_stale');
    const effective=this.effectiveBalance(address,balance);
    if (winston(additional) + winston(this.held(address, promoTreasury)) > winston(effective)) throw Error('wallet_low');
    this.sql.exec('INSERT INTO treasury_balance_ceiling(address,balance,unobserved_debit) VALUES(?,?,\'0\') ON CONFLICT(address) DO UPDATE SET balance=excluded.balance,unobserved_debit=\'0\'',address,effective);
  }
  reservePaid(input: {orderId: string; budgetId: string; treasury: string; promoTreasury: string; reward: string;
    budgetLimit: string; balance: string; balanceRevision: number}): void {
    const amount = winston(input.reward), totals = this.paidTotals(input.budgetId);
    if (amount <= 0n) throw Error('invalid_reward');
    if (amount + winston(totals.reservedWinston) + winston(totals.actualSpentWinston) > winston(input.budgetLimit)) throw Error('paid_budget_exhausted');
    this.assertBalance(input.treasury, input.promoTreasury, input.balance, input.reward, input.balanceRevision);
    this.sql.exec('INSERT INTO paid_holds(order_id,budget_id,treasury,reward) VALUES(?,?,?,?)', input.orderId, input.budgetId, input.treasury, input.reward);
  }
  confirmPaid(orderId: string, reward: string): void {
    const row = this.sql.exec<{treasury: string; reward: string; actual: string | null; released: number}>(
      'SELECT treasury,reward,actual,released FROM paid_holds WHERE order_id=?', orderId).toArray()[0];
    if (!row || row.released || winston(reward)<=0n || winston(reward)>winston(row.reward)) throw Error('invalid_actual_reward');
    if (row.actual !== null) { if (row.actual !== reward) throw Error('invalid_actual_reward'); return; }
    this.sql.exec('UPDATE paid_holds SET actual=? WHERE order_id=?', reward, orderId);
    this.debit(row.treasury,reward);
  }
  releaseUnpaid(orderId: string): void {
    const row = this.sql.exec<{actual: string | null}>('SELECT actual FROM paid_holds WHERE order_id=?', orderId).toArray()[0];
    if (!row || row.actual !== null) throw Error('paid_hold_not_releasable');
    this.sql.exec('UPDATE paid_holds SET released=1 WHERE order_id=?', orderId);
  }
}
