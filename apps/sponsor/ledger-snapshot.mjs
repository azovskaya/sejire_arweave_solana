/** Offline operator import. Never opens an existing destination, starts an
 * executor, fetches a chain, changes signed bytes, or clears a review barrier. */
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {lstat,open,readFile,rename} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {canonicalDatabasePath,acquireWriter} from './linux-writer.mjs';
import {sqliteStorage} from './linux-server.mjs';
import {SqliteAtomicOrderStore} from './src/checkout/sqliteStore.ts';
import {ApiLedger} from './src/checkout/apiLedger.ts';
import {FundLedger} from './src/fund/ledger.ts';
import {PaidLedger} from './src/checkout/paidLedger.ts';
import {RecipientSettings} from './src/checkout/recipientSettings.ts';
import {TreasuryTopupLedger} from './src/checkout/treasuryTopups.ts';
import {LEDGER_TABLES,validateLedgerSnapshot} from './src/checkout/migrationSnapshot.ts';

function schema(storage){
  const orders=new SqliteAtomicOrderStore(storage),api=new ApiLedger(storage,orders),fund=new FundLedger(storage);
  new PaidLedger(storage,orders,api);new RecipientSettings(storage);new TreasuryTopupLedger(storage,fund.treasury);
}
async function absent(path){try{await lstat(path);throw Error('ledger_import_destination_exists');}catch(error){if(error.code!=='ENOENT')throw error;}}
async function syncDirectory(path){const directory=await open(path,'r');try{await directory.sync();}finally{await directory.close();}}
async function privateFile(path,contents){const file=await open(path,'wx',0o600);try{await file.writeFile(contents);await file.sync();}finally{await file.close();}}
const digest=value=>createHash('sha256').update(value).digest('hex');
function trustedColumns(storage,name){return ['rowid',...storage.sql.exec(`PRAGMA table_info(${name})`).toArray().map(column=>column.name)];}
function checkSchema(storage,snapshot){
  const optional=new Map([['paid_orders',new Set(['submission_ack'])],['paid_payment_recoveries',new Set(['previous_signature'])]]);
  for(const table of snapshot.tables){
    const current=trustedColumns(storage,table.name);
    if(table.columns.some(column=>!current.includes(column))||current.some(column=>!table.columns.includes(column)&&!optional.get(table.name)?.has(column)))throw Error('ledger_import_schema_mismatch');
    if(current.filter(column=>table.columns.includes(column)).join(',')!==table.columns.join(','))throw Error('ledger_import_schema_mismatch');
  }
}
function load(storage,snapshot){
  storage.sql.exec('PRAGMA foreign_keys=OFF');
  try{storage.transactionSync(()=>{
    for(const name of [...LEDGER_TABLES].reverse())storage.sql.exec(`DELETE FROM ${name}`);
    storage.sql.exec('DELETE FROM sqlite_sequence');
    for(const table of snapshot.tables){
      const columns=table.columns.map(column=>'"'+column+'"').join(','),slots=table.columns.map(()=>'?').join(',');
      for(const row of table.rows)storage.sql.exec(`INSERT INTO ${table.name}(${columns}) VALUES(${slots})`,...row);
    }
    for(const sequence of snapshot.sequences){
      const ddl=storage.sql.exec('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?',sequence.name).toArray()[0]?.sql;
      if(typeof ddl!=='string'||!ddl.includes('AUTOINCREMENT'))throw Error('ledger_import_sequence_mismatch');
      const current=storage.sql.exec('SELECT seq FROM sqlite_sequence WHERE name=?',sequence.name).toArray()[0]?.seq??0;
      if(sequence.seq<current)throw Error('ledger_import_sequence_mismatch');
      storage.sql.exec('DELETE FROM sqlite_sequence WHERE name=?',sequence.name);
      storage.sql.exec('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)',sequence.name,sequence.seq);
    }
    if(storage.sql.exec('PRAGMA foreign_key_check').toArray().length)throw Error('ledger_import_foreign_key_mismatch');
    if(storage.sql.exec('SELECT version FROM schema_version').toArray().map(row=>row.version).join(',')!=='1')throw Error('ledger_import_schema_version');
    for(const name of ['fund_settings','fund_meta'])if(storage.sql.exec(`SELECT COUNT(*) AS n FROM ${name}`).toArray()[0]?.n!==1)throw Error('ledger_import_singleton_missing');
    // Re-read exact source columns and rowids: TEXT coercion, dropped bytes or
    // a partial payload import must fail before the transaction commits.
    for(const table of snapshot.tables){
      const rows=storage.sql.exec(`SELECT rowid AS __snapshot_rowid__,* FROM ${table.name} ORDER BY rowid`).toArray()
        .map(row=>table.columns.map(column=>column==='rowid'?row.__snapshot_rowid__:row[column]));
      if(JSON.stringify(rows)!==JSON.stringify(table.rows))throw Error('ledger_import_readback_mismatch');
    }
    if(storage.sql.exec('PRAGMA integrity_check').toArray()[0]?.integrity_check!=='ok')throw Error('ledger_import_integrity_failed');
  });}finally{storage.sql.exec('PRAGMA foreign_keys=ON');}
}
export async function importLedgerSnapshotFile(snapshotFile,output,expectedSnapshotSha256){
  if(typeof expectedSnapshotSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedSnapshotSha256))throw Error('ledger_import_expected_hash_required');
  const inputPath=resolve(snapshotFile),info=await lstat(inputPath);
  if(!info.isFile()||info.isSymbolicLink()||info.size>80*1024*1024||info.mode&0o077)throw Error('ledger_import_snapshot_file_invalid');
  let parsed;try{parsed=JSON.parse(await readFile(inputPath,'utf8'));}catch{throw Error('ledger_snapshot_invalid');}
  const snapshot=await validateLedgerSnapshot(parsed);
  if(snapshot.sha256!==expectedSnapshotSha256)throw Error('ledger_import_expected_hash_mismatch');
  // Validate the column contract in memory before touching the target path.
  const blueprint=new DatabaseSync(':memory:');
  try{const storage=sqliteStorage(blueprint);schema(storage);checkSchema(storage,snapshot);}finally{blueprint.close();}
  const target=await canonicalDatabasePath(output);await absent(target);await absent(target+'.restore-review.json');
  const guard=await acquireWriter(target);let db;
  try{
    for(const suffix of ['','-wal','-shm','.restore-review.json'])await absent(target+suffix);
    const marker=target+'.restore-review.json',startedAt=new Date().toISOString();
    const review={schema:'sejire/restore-review/v1',kind:'ledger-migration',sha256:null,snapshotSha256:snapshot.sha256,startedAt,
      source:snapshot.source,complete:false,requires:'RECONCILIATION_REVIEWED'};
    await privateFile(marker,JSON.stringify(review,null,2)+'\n');await syncDirectory(dirname(target));
    // Shared kernel guard and the durable marker both precede DB creation.
    await privateFile(target,'');await syncDirectory(dirname(target));
    db=new DatabaseSync(target);const storage=sqliteStorage(db);schema(storage);load(storage,snapshot);
    // Recreate only the additive queue for historical promo rows lacking it.
    // This does not sign, send, complete, debit or rewrite any source order.
    new FundLedger(storage);
    if(snapshot.alarmAt===null)await storage.deleteAlarm();else await storage.setAlarm(snapshot.alarmAt);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();db=null;
    const file=await open(target,'r');try{await file.sync();}finally{await file.close();}
    const databaseSha256=digest(await readFile(target));
    const complete={...review,complete:true,sha256:databaseSha256,importedAt:new Date().toISOString(),tables:snapshot.tables.map(({name,count,sha256})=>({name,count,sha256})),alarmAt:snapshot.alarmAt};
    const replacement=marker+'.complete';await privateFile(replacement,JSON.stringify(complete,null,2)+'\n');await rename(replacement,marker);await syncDirectory(dirname(target));
    return {schema:'sejire/ledger-import-result/v1',destination:target,databaseSha256,snapshotSha256:snapshot.sha256,
      tables:complete.tables,reviewRequired:true,startedExecutor:false,networkRequests:0};
  }finally{db?.close();guard.close();}
}
