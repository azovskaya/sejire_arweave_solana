import {canonical} from '../../../../packages/protocol/wire';

/** Private operator artifact. It contains ciphertext, signed transactions and
 * capability hashes. It is NEVER a public/admin dashboard response. */
export const LEDGER_TABLES=[
  'schema_version','orders','used_transactions','credits','api_sessions','api_orders','paid_cancelled_keys','api_rates','api_execution',
  'paid_orders','paid_payloads','paid_archive_repairs','paid_payment_recoveries','treasury_revision','treasury_balance_ceiling','paid_holds',
  'fund_settings','fund_orders','fund_order_links','fund_events','fund_audit','fund_rates','fund_jobs','fund_meta',
  'solana_recipient_settings','solana_recipient_audit','treasury_topups','treasury_topup_audit','treasury_topup_transfers'
] as const;
const optional=new Set(['fund_order_links','fund_jobs','treasury_topups','treasury_topup_audit','treasury_topup_transfers']);
export type SnapshotSource={platform:'cloudflare-durable-object'|'linux-sqlite';namespaceId:string;objectId:string;
  objectName:'sejire-checkout-ledger-v1';sourceCommit:string;quiescedAt:number;exportedAt:number;attestation:'SOURCE_EXECUTION_STOPPED'};
type Value=string|number|null;
export type SnapshotTable={name:string;columns:string[];rows:Value[][];count:number;sha256:string};
export type LedgerSnapshot={schema:'sejire/ledger-snapshot/v1';source:SnapshotSource;alarmAt:number|null;
  sequences:{name:string;seq:number}[];tables:SnapshotTable[];sha256:string};
async function hash(value:unknown):Promise<string>{const result=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(result),byte=>byte.toString(16).padStart(2,'0')).join('');}
const tableDigest=(table:Pick<SnapshotTable,'columns'|'rows'>)=>hash({columns:table.columns,rows:table.rows});
const manifest=(snapshot:LedgerSnapshot)=>({schema:snapshot.schema,source:snapshot.source,alarmAt:snapshot.alarmAt,sequences:snapshot.sequences,
  tables:snapshot.tables.map(({rows,...table})=>table)});
const integer=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
function sourceChecked(source:SnapshotSource){
  if(!source||!['cloudflare-durable-object','linux-sqlite'].includes(source.platform)||source.objectName!=='sejire-checkout-ledger-v1'||
    Object.keys(source).sort().join(',')!=='attestation,exportedAt,namespaceId,objectId,objectName,platform,quiescedAt,sourceCommit'||
    typeof source.namespaceId!=='string'||!/^[A-Za-z0-9._-]{8,128}$/.test(source.namespaceId)||typeof source.objectId!=='string'||!/^[a-f0-9]{64}$/.test(source.objectId)||
    !/^[a-f0-9]{40}$/.test(source.sourceCommit)||!integer(source.quiescedAt)||!integer(source.exportedAt)||source.quiescedAt>source.exportedAt||source.attestation!=='SOURCE_EXECUTION_STOPPED')throw Error('ledger_snapshot_source_invalid');
}
/** Call ONLY after an owner-controlled export-only deployment has stopped all
 * old admissions/alarms and drained in-flight jobs. This helper neither freezes
 * a live worker nor attests that operator prerequisite. No source writes. */
export async function readOnlyLedgerSnapshot(storage:DurableObjectStorage,source:SnapshotSource):Promise<LedgerSnapshot>{
  sourceChecked(source);const alarmAt=await storage.getAlarm();
  const data=storage.transactionSync(()=>{
    const inventory=storage.sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(row=>row.name);
    const unknown=inventory.filter(name=>!LEDGER_TABLES.includes(name as typeof LEDGER_TABLES[number])&&name!=='sqlite_sequence'&&name!=='sejire_alarm'&&!name.startsWith('_cf_'));
    if(unknown.length)throw Error('ledger_snapshot_unknown_table');
    for(const name of LEDGER_TABLES)if(!optional.has(name)&&!inventory.includes(name))throw Error('ledger_snapshot_schema_upgrade_required');
    for(const name of ['paid_orders','fund_jobs','api_execution'])if(inventory.includes(name)&&storage.sql.exec(`SELECT 1 FROM ${name} WHERE lease_until>? LIMIT 1`,Date.now()).toArray().length)throw Error('ledger_snapshot_active_lease');
    const tables=LEDGER_TABLES.filter(name=>inventory.includes(name)).map(name=>{
      const columns=['rowid',...storage.sql.exec<{name:string}>(`PRAGMA table_info(${name})`).toArray().map(row=>row.name)];
      const rows=storage.sql.exec<Record<string,Value>>(`SELECT rowid AS __snapshot_rowid__,* FROM ${name} ORDER BY rowid`).toArray()
        .map(row=>columns.map(column=>column==='rowid'?row.__snapshot_rowid__:row[column]));
      return {name,columns,rows,count:rows.length,sha256:''};
    });
    const sequences=inventory.includes('sqlite_sequence')?storage.sql.exec<{name:string;seq:number}>('SELECT name,seq FROM sqlite_sequence ORDER BY name').toArray():[];
    return {tables,sequences};
  });
  // Bound the first artifact version explicitly. A larger ledger requires a
  // separately reviewed chunked export, never a silently truncated snapshot.
  if(new TextEncoder().encode(JSON.stringify(data)).length>64*1024*1024)throw Error('ledger_snapshot_requires_chunked_export');
  for(const table of data.tables)table.sha256=await tableDigest(table);
  const snapshot:LedgerSnapshot={schema:'sejire/ledger-snapshot/v1',source,alarmAt,...data,sha256:''};
  snapshot.sha256=await hash(manifest(snapshot));await validateLedgerSnapshot(snapshot);return snapshot;
}
export async function validateLedgerSnapshot(input:unknown):Promise<LedgerSnapshot>{
  const snapshot=input as LedgerSnapshot;
  if(!snapshot||snapshot.schema!=='sejire/ledger-snapshot/v1'||!Array.isArray(snapshot.tables)||!Array.isArray(snapshot.sequences)||
    Object.keys(snapshot).sort().join(',')!=='alarmAt,schema,sequences,sha256,source,tables'||snapshot.alarmAt!==null&&!integer(snapshot.alarmAt))throw Error('ledger_snapshot_invalid');
  sourceChecked(snapshot.source);
  const names=new Set<string>();
  for(const table of snapshot.tables){
    if(!table||!LEDGER_TABLES.includes(table.name as typeof LEDGER_TABLES[number])||names.has(table.name)||!Array.isArray(table.columns)||
      Object.keys(table).sort().join(',')!=='columns,count,name,rows,sha256'||
      !table.columns.length||table.columns[0]!=='rowid'||new Set(table.columns).size!==table.columns.length||
      !table.columns.every(name=>typeof name==='string'&&/^[a-z_]+$/.test(name))||!Array.isArray(table.rows)||table.count!==table.rows.length||!integer(table.count))throw Error('ledger_snapshot_table_invalid');
    names.add(table.name);let previous=0;
    for(const row of table.rows){
      if(!Array.isArray(row)||row.length!==table.columns.length||row.some(value=>value!==null&&typeof value!=='string'&&!(typeof value==='number'&&Number.isSafeInteger(value)))||!integer(row[0])||Number(row[0])<=previous)throw Error('ledger_snapshot_row_invalid');
      previous=Number(row[0]);
    }
    if(await tableDigest(table)!==table.sha256)throw Error('ledger_snapshot_table_hash_mismatch');
  }
  for(const name of LEDGER_TABLES)if(!optional.has(name)&&!names.has(name))throw Error('ledger_snapshot_table_missing');
  const counters=new Set<string>();for(const counter of snapshot.sequences){
    if(!counter||!names.has(counter.name)||counters.has(counter.name)||!integer(counter.seq))throw Error('ledger_snapshot_sequence_invalid');counters.add(counter.name);
  }
  if(await hash(manifest(snapshot))!==snapshot.sha256)throw Error('ledger_snapshot_manifest_hash_mismatch');
  return snapshot;
}
