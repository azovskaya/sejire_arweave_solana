// Reproducible synthetic fixture only. Never accepts a database path or env file.
import {writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(process.argv[2]??'../sejire-code-audit-20261125');
const {sqliteStorage}=await import(pathToFileURL(resolve(root,'apps/sponsor/linux-server.mjs')));
const {CheckoutLedger}=await import(pathToFileURL(resolve(root,'apps/sponsor/src/checkout/durableStore.ts')));
const db=new DatabaseSync(':memory:'),storage=sqliteStorage(db),gates=[];
const id={equals(other){return other===id;}};
const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('network_forbidden');};
try{
  new CheckoutLedger({id,storage,blockConcurrencyWhile(fn){const p=Promise.resolve().then(fn);gates.push(p);return p;},waitUntil(){throw Error('executor_forbidden');}},
    {CHECKOUT_LEDGER:{idFromName(){return id;}}});await Promise.all(gates);
  const schema=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='sejire_alarm' ORDER BY rowid").all().map(row=>row.sql);
  const fixture={schema,source:{localCommit:'0151154adfeecbd05b267ba791ad7841e93d607c',remoteCommit:'23037bd',tree:'ce00da8cfe9c13e04d68c1a3f465a52b704f9d17'},schemaSha256:createHash('sha256').update(JSON.stringify(schema)).digest('hex')};
  await writeFile(resolve(dirname(fileURLToPath(import.meta.url)),'schema-fixture.json'),JSON.stringify(fixture,null,2)+'\n');
  console.log(JSON.stringify({fixtureTables:schema.length,schemaSha256:fixture.schemaSha256,networkRequests:0}));
}finally{globalThis.fetch=oldFetch;db.close();}
