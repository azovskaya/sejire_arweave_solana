/** One durable alarm serves both additive ledgers. Neither queue may erase the
 * other's wake-up when its own work completes. Called after durable writes. */
export async function armCheckoutAlarm(storage: DurableObjectStorage): Promise<void> {
  const sql = storage.sql, next: number[] = [];
  if (sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='paid_orders'").toArray().length) {
    const rows = sql.exec<{next_at:number;lease_until:number}>(`SELECT next_at,lease_until FROM paid_orders
      WHERE released=0 AND (status<>'completed' OR EXISTS(SELECT 1 FROM paid_archive_repairs r
      WHERE r.order_id=paid_orders.order_id AND r.status<>'verified'))`).toArray();
    for (const row of rows) next.push(Math.max(row.next_at,row.lease_until));
  }
  if (sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='fund_jobs'").toArray().length) {
    const rows = sql.exec<{next_at:number;lease_until:number}>('SELECT next_at,lease_until FROM fund_jobs WHERE next_at IS NOT NULL').toArray();
    for (const row of rows) next.push(Math.max(row.next_at,row.lease_until));
  }
  if (!next.length) { if (storage.deleteAlarm) await storage.deleteAlarm(); return; }
  if (storage.setAlarm) await storage.setAlarm(Math.max(Date.now()+1000,Math.min(...next)));
}
