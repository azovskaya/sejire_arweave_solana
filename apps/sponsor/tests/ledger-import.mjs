import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,lstat,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {sqliteStorage,startLinuxCheckout} from '../linux-server.mjs';
import {acquireWriter} from '../linux-writer.mjs';
import {CheckoutLedger,LEDGER_OBJECT_NAME} from '../src/checkout/durableStore.ts';
import {FundLedger,TREASURY_ADDRESS} from '../src/fund/ledger.ts';
import {readOnlyLedgerSnapshot,validateLedgerSnapshot} from '../src/checkout/migrationSnapshot.ts';
import {importLedgerSnapshotFile} from '../ledger-snapshot.mjs';
import {createPaidOrderFromPolicy} from '../../../packages/checkout/paid.ts';
import {canonical} from '../../../packages/protocol/wire.ts';
import {addr} from '../src/checkout/rpcFixtures.ts';
const temp=await mkdtemp(join(tmpdir(),'sejire-ledger-import-')),sourcePath=join(temp,'source.sqlite');
const oldFetch=globalThis.fetch;let network=0;globalThis.fetch=async()=>{network++;throw Error('network_forbidden');};
const hash=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
const privateFile=(path,value)=>writeFile(path,JSON.stringify(value),{mode:0o600,flag:'wx'});
const source={platform:'cloudflare-durable-object',namespaceId:'synthetic-namespace',objectId:'1'.repeat(64),objectName:LEDGER_OBJECT_NAME,
  sourceCommit:'a'.repeat(40),quiescedAt:Date.now()-1000,exportedAt:Date.now(),attestation:'SOURCE_EXECUTION_STOPPED'};
const fields=snapshot=>({schema:snapshot.schema,source:snapshot.source,alarmAt:snapshot.alarmAt,sequences:snapshot.sequences,
  tables:snapshot.tables.map(({rows,...table})=>table)});
function recalc(snapshot){for(const t of snapshot.tables){t.count=t.rows.length;t.sha256=hash({columns:t.columns,rows:t.rows});}snapshot.sha256=hash(fields(snapshot));return snapshot;}
const passed=[];async function test(name,fn){await fn();passed.push(name);console.log('PASS ledger import: '+name);}
let sourceDb;
try{
  sourceDb=new DatabaseSync(sourcePath);const storage=sqliteStorage(sourceDb),id={equals(other){return other===id;}},gates=[];
  new CheckoutLedger({id,storage,blockConcurrencyWhile(fn){const p=Promise.resolve().then(fn);gates.push(p);return p;},waitUntil(){throw Error('unexpected_executor');}},
    {CHECKOUT_LEDGER:{idFromName(name){assert.equal(name,LEDGER_OBJECT_NAME);return id;}}});await Promise.all(gates);
  const token='synthetic-existing-owner-capability',ownerHash=hash(token),order=await createPaidOrderFromPolicy({schema:'sejire/contribution-policy/v1',version:'synthetic-old-v1',network:'mainnet-beta',
    genesisHash:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',serviceLamports:'0',serviceRecipient:addr(2),fundRecipient:addr(3)},
    {id:'a'.repeat(32),kind:'contribution',payer:addr(1),reference:addr(4),createdAt:Date.now()-1000,expiresAt:Date.now()+1000000,contribution:'1000'});
  const policy={schema:'sejire/contribution-policy/v1',version:'synthetic-old-v1',network:'mainnet-beta',genesisHash:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',serviceLamports:'0',serviceRecipient:addr(2),fundRecipient:addr(3)};
  storage.sql.exec('INSERT INTO orders(id,network,reference,order_json,states_json) VALUES(?,?,?,?,?)',order.id,order.network,order.reference,JSON.stringify(order),JSON.stringify({payment:'awaiting-payment',preservation:'not-applicable',contribution:'awaiting-payment'}));
  storage.sql.exec('INSERT INTO api_sessions(hash,expires_at) VALUES(?,?)',ownerHash,Date.now()+1000000);
  storage.sql.exec('INSERT INTO api_orders(order_id,owner,idem_key,intent) VALUES(?,?,?,?)',order.id,ownerHash,'synthetic-existing-key','synthetic-immutable-request');
  storage.sql.exec('INSERT INTO paid_cancelled_keys(owner,key) VALUES(?,?)',ownerHash,'synthetic-cancelled-key');
  storage.sql.exec('INSERT INTO paid_orders(order_id,policy_json,status,next_at) VALUES(?,?,?,?)',order.id,JSON.stringify(policy),'offered',order.expiresAt);
  const opaque='{"synthetic":"ciphertext + exact signed bytes \\n Қазақ шежіресі"}';
  // Payloads are opaque here. Import must not parse/re-encode/re-sign them.
  storage.sql.exec('INSERT INTO paid_payloads(order_id,kind,payload) VALUES(?,?,?)',order.id,'migration-fixture',opaque);
  const fund=new FundLedger(storage);await fund.promo('b'.repeat(64),'synthetic hint');
  const promo=await fund.reserve({orderId:'c'.repeat(32),preservationId:'d'.repeat(32),hash:'b'.repeat(64),archiveSizeBytes:256,archiveDigest:'e'.repeat(64),vaultId:'f'.repeat(32),
    reward:'20',estimated:'15',prepared:opaque,balance:'1000',balanceRevision:0});
  await fund.event({orderId:promo.orderId,status:'SIGNED',txId:'S'.repeat(43),signed:opaque});
  storage.sql.exec('INSERT INTO paid_holds(order_id,budget_id,treasury,reward,actual,released) VALUES(?,?,?,?,?,?)','historical-paid-spend','synthetic-budget',TREASURY_ADDRESS,'100','70',0);
  storage.sql.exec('UPDATE treasury_balance_ceiling SET balance=? WHERE address=?','930',TREASURY_ADDRESS);
  storage.sql.exec('INSERT INTO treasury_revision(address,revision) VALUES(?,?)',TREASURY_ADDRESS,1);
  // Older supported schema has neither autonomous promo jobs nor these later
  // optional columns. No source history is fabricated during import.
  storage.sql.exec('DROP TABLE fund_jobs');storage.sql.exec('ALTER TABLE paid_orders DROP COLUMN submission_ack');
  storage.sql.exec('ALTER TABLE paid_payment_recoveries DROP COLUMN previous_signature');
  await storage.setAlarm(Date.now()+60000);
  let snapshot,file,target,result;
  await test('quiesced source snapshot covers exact payloads, capability hashes, idempotency, holds, ceiling, events and alarm',async()=>{
    snapshot=await readOnlyLedgerSnapshot(storage,source);await validateLedgerSnapshot(snapshot);
    assert(snapshot.tables.length>=24);assert.equal(snapshot.tables.find(t=>t.name==='paid_payloads').rows[0].at(-1),opaque);
    assert(snapshot.tables.find(t=>t.name==='api_sessions').rows.some(row=>row.includes(ownerHash)));
    assert.equal(JSON.stringify(snapshot).includes(token),false,'bearer plaintext is not in the database');
    storage.sql.exec('UPDATE paid_orders SET lease_until=? WHERE order_id=?',Date.now()+60000,order.id);
    await assert.rejects(()=>readOnlyLedgerSnapshot(storage,source),/ledger_snapshot_active_lease/);
    storage.sql.exec('UPDATE paid_orders SET lease_until=0 WHERE order_id=?',order.id);
    storage.sql.exec('INSERT INTO api_execution(order_id,plan_json,lease_until) VALUES(?,?,?)',order.id,'{"synthetic":"legacy-upload"}',Date.now()+60000);
    await assert.rejects(()=>readOnlyLedgerSnapshot(storage,source),/ledger_snapshot_active_lease/,'legacy upload lease is also an active obligation');
    storage.sql.exec('DELETE FROM api_execution WHERE order_id=?',order.id);
    file=join(temp,'source-snapshot.json');await privateFile(file,snapshot);
  });
  await test('private new-path import verifies every row and preserves legacy bytes while rebuilding only promo job metadata',async()=>{
    target=join(temp,'imported.sqlite');result=await importLedgerSnapshotFile(file,target,snapshot.sha256);
    assert.equal(result.reviewRequired,true);assert.equal(result.startedExecutor,false);assert.equal(result.networkRequests,0);
    assert.equal((await lstat(target)).mode&0o777,0o600);
    const db=new DatabaseSync(target,{readOnly:true});try{
      for(const table of snapshot.tables){const rows=db.prepare(`SELECT rowid AS __snapshot_rowid__,* FROM ${table.name} ORDER BY rowid`).all().map(row=>table.columns.map(c=>c==='rowid'?row.__snapshot_rowid__:row[c]));assert.deepEqual(rows,table.rows,table.name);}
      assert.equal(db.prepare('SELECT COUNT(*) n FROM fund_jobs').get().n,1);
      assert.equal(db.prepare('SELECT balance FROM treasury_balance_ceiling WHERE address=?').get(TREASURY_ADDRESS).balance,'930');
      assert.equal(db.prepare('SELECT revision FROM treasury_revision WHERE address=?').get(TREASURY_ADDRESS).revision,1);
      assert.equal(db.prepare('SELECT owner,idem_key FROM api_orders').get().owner,ownerHash);
      assert.equal(db.prepare('SELECT at FROM sejire_alarm').get().at,snapshot.alarmAt);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
    }finally{db.close();}
    const marker=JSON.parse(await readFile(target+'.restore-review.json','utf8'));assert.equal(marker.complete,true);assert.equal(marker.sha256,result.databaseSha256);assert.equal(marker.snapshotSha256,snapshot.sha256);
  });
  await test('restored database cannot start, overwrite another ledger, bypass alias exclusion or race the existing writer',async()=>{
    await assert.rejects(()=>startLinuxCheckout({dbPath:target}),/linux_restore_review_required/);
    const bytes=await readFile(target);await assert.rejects(()=>importLedgerSnapshotFile(file,target,snapshot.sha256),/ledger_import_destination_exists/);assert.deepEqual(await readFile(target),bytes);
    const alias=join(temp,'alias.sqlite');await symlink(target,alias);await assert.rejects(()=>importLedgerSnapshotFile(file,alias,snapshot.sha256),/ledger_import_destination_exists/);
    const locked=join(temp,'new-locked.sqlite'),guard=await acquireWriter(locked);
    try{await assert.rejects(()=>importLedgerSnapshotFile(file,locked,snapshot.sha256),/backend_writer_already_active/);}finally{guard.close();}
    await assert.rejects(()=>lstat(locked),{code:'ENOENT'});
  });
  await test('bad pinned hash, tampered payload, omitted tables and unexpected columns fail before opening a destination',async()=>{
    await assert.rejects(()=>importLedgerSnapshotFile(file,join(temp,'wrong-pin.sqlite'),'0'.repeat(64)),/ledger_import_expected_hash_mismatch/);
    const changed=structuredClone(snapshot);changed.tables.find(t=>t.name==='paid_payloads').rows[0][3]='modified';
    const changedFile=join(temp,'modified.json');await privateFile(changedFile,changed);await assert.rejects(()=>importLedgerSnapshotFile(changedFile,join(temp,'modified.sqlite'),snapshot.sha256),/ledger_snapshot_table_hash_mismatch/);
    const omitted=structuredClone(snapshot);omitted.tables=omitted.tables.filter(t=>t.name!=='used_transactions');recalc(omitted);
    const omittedFile=join(temp,'omitted.json');await privateFile(omittedFile,omitted);await assert.rejects(()=>importLedgerSnapshotFile(omittedFile,join(temp,'omitted.sqlite'),omitted.sha256),/ledger_snapshot_table_missing/);
    const altered=structuredClone(snapshot),table=altered.tables.find(t=>t.name==='api_sessions');table.columns[1]='unexpected_column';recalc(altered);
    const alteredFile=join(temp,'schema.json');await privateFile(alteredFile,altered);await assert.rejects(()=>importLedgerSnapshotFile(alteredFile,join(temp,'schema.sqlite'),altered.sha256),/ledger_import_schema_mismatch/);
    for(const name of ['wrong-pin','modified','omitted','schema'])await assert.rejects(()=>lstat(join(temp,name+'.sqlite')),{code:'ENOENT'});
  });
  await test('foreign-key corruption rolls back imported rows and leaves a durable review barrier instead of starting partial state',async()=>{
    const corrupt=structuredClone(snapshot);corrupt.tables.find(t=>t.name==='api_orders').rows[0][2]='0'.repeat(64);recalc(corrupt);
    const input=join(temp,'orphan.json'),output=join(temp,'orphan.sqlite');await privateFile(input,corrupt);
    await assert.rejects(()=>importLedgerSnapshotFile(input,output,corrupt.sha256),/ledger_import_foreign_key_mismatch/);
    assert.equal(JSON.parse(await readFile(output+'.restore-review.json','utf8')).complete,false);
    await assert.rejects(()=>startLinuxCheckout({dbPath:output}),/linux_restore_review_required/);
    const db=new DatabaseSync(output,{readOnly:true});try{assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n,0);}finally{db.close();}
    assert.equal(network,0);
  });
  console.log(`ledger-import: PASS (${passed.length} groups); synthetic private snapshot, no live source, no network, no executor`);
}finally{sourceDb?.close();globalThis.fetch=oldFetch;await rm(temp,{recursive:true,force:true});}
