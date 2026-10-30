import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {webcrypto,createHash} from 'node:crypto';
import {pilot} from '../apps/sponsor/tests/protocol-pilot';
import {createOrder} from '../packages/checkout/order';
import {hash} from '../apps/sponsor/src/protocol/journal';
import {signingKey} from '../apps/sponsor/src/protocol/executor';
import {deriveKeysFromMnemonic} from '../apps/web/src/lib/crypto/keys';
import {encryptJson} from '../apps/web/src/lib/crypto/encrypt';
import {emptyVault,putTree} from '../apps/web/src/lib/crypto/vault';
import {createTree} from '../apps/web/src/lib/treeEngine';
import {addr,sig} from '../apps/sponsor/src/checkout/rpcFixtures';
Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const temp=await mkdtemp(join(tmpdir(),'sejire-offline-'));
try{
 await cp(resolve('.cache/continuation'),join(temp,'package'),{recursive:true});
 const block=join(temp,'block-network.cjs');await writeFile(block,"globalThis.fetch=()=>{throw Error('Network disabled');}; for(const name of ['node:http','node:https','node:net','node:tls','node:dns']){const m=require(name);for(const key of ['request','get','connect','createConnection','resolve','lookup'])if(m[key])m[key]=()=>{throw Error('Network disabled');};}");
 const run=(tool:string,args:string[],input='')=>{const r=spawnSync(process.execPath,['--require',block,join(temp,'package',tool+'.mjs'),...args],{cwd:temp,input,encoding:'utf8',env:{PATH:process.env.PATH}});assert.equal(r.status,0,r.stderr);return r;};
 const p=await pilot(),payer=signingKey(new Uint8Array(32).fill(17)),cap=signingKey(new Uint8Array(32).fill(18));
 const order=createOrder({id:'1'.repeat(32),kind:'contribution',network:'devnet',asset:'SOL',payer:payer.publicKey,reference:addr(4),createdAt:1000000,expiresAt:1100000,policyVersion:p.genesis.policy.version,servicePayment:{amount:'0',recipient:addr(2)},fundContribution:{amount:'5000000',recipient:addr(3)}});
 await p.engine.submit(p.engine.signed('Order',{order,accessHash:hash(cap.publicKey)},payer));
 await p.engine.reserve(order.id,sig(5),Buffer.from(new Uint8Array(32).fill(18)).toString('hex'));
 await p.engine.reconcile(order.id,Buffer.from(new Uint8Array(32).fill(18)).toString('hex'));
 const pending=createOrder({...order,id:'2'.repeat(32),asset:'SOL',reference:addr(7)});
 await p.engine.submit(p.engine.signed('Order',{order:pending,accessHash:hash(cap.publicKey)},payer));
 await p.engine.reserve(pending.id,sig(6),Buffer.from(new Uint8Array(32).fill(18)).toString('hex'));
 const saved=p.engine.export(),journal=join(temp,'journal.json'),trust=join(temp,'trust.json'),output=join(temp,'state.json');
 await writeFile(journal,JSON.stringify(saved));await writeFile(trust,JSON.stringify({creationHash:p.engine.journal.creationHash,checkpoint:saved.checkpoint}));
 run('replay-journal',[journal,trust,output]);assert.deepEqual(JSON.parse(await readFile(output,'utf8')),p.engine.journal.state);
 console.log('PASS continuation: fresh Node process, no SQLite/network/npm/GitHub, credited and pending orders preserved');
 // Public standard test mnemonic, never used for wallets or real archives.
 const words='abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
 const keys=deriveKeysFromMnemonic(words);const vault={trees:{a:{persons:{p:{id:'p'},c:{id:'c',parents:['p']}},history:['created','corrected']},b:{persons:{q:{id:'q'}},history:['created']}},active_tree_id:'a'};
 const file=join(temp,'archive.json'),plain=join(temp,'restored.json');await writeFile(file,JSON.stringify(await encryptJson(keys.encKey,keys.vaultId,vault)));
 run('recover-vault',[file,plain],words);assert.deepEqual(JSON.parse(await readFile(plain,'utf8')),vault);
 console.log('PASS continuation: standalone encrypted-file recovery, two trees/links/history, no network/payment wallet');
 const onlineVault=putTree(emptyVault(keys.vaultId),createTree('Synthetic independent recovery'));
 const onlineRaw=JSON.stringify(await encryptJson(keys.encKey,keys.vaultId,onlineVault));
 const txId='A'.repeat(43),encoded=(value:string)=>Buffer.from(value).toString('base64url');
 const tags=[['App-Name','SEJIRE'],['Type','vault-envelope'],['Schema','sejire/envelope/v1'],
  ['Protocol-Version','sejire/v0.3'],['Vault-Id',keys.vaultId],
  ['Archive-SHA256',createHash('sha256').update(onlineRaw).digest('hex')],['Archive-Bytes',String(Buffer.byteLength(onlineRaw))]]
  .map(([name,value])=>({name:encoded(name),value:encoded(value)}));
 const metadata={id:txId,tags,block:{height:100,timestamp:1700000000}};
 const mock=join(temp,'mock-gateway.cjs');
 await writeFile(mock,`const raw=${JSON.stringify(onlineRaw)},metadata=${JSON.stringify(JSON.stringify(metadata))},id=${JSON.stringify(txId)};
 globalThis.fetch=async url=>{const path=String(url);if(path.endsWith('/graphql')||path.endsWith('/ar-io/peers'))return new Response('index unavailable',{status:503});
 if(path.endsWith('/tx/'+id))return new Response(metadata,{headers:{'Content-Type':'application/json'}});
 if(path.endsWith('/raw/'+id))return new Response(raw);return new Response('unavailable',{status:503});};`);
 const networkOutput=join(temp,'network-recovered.json');
 const networkRun=spawnSync(process.execPath,['--require',mock,join(temp,'package','recover-network.mjs'),networkOutput,txId],
  {cwd:temp,input:words,encoding:'utf8',env:{PATH:process.env.PATH}});
 assert.equal(networkRun.status,0,networkRun.stderr);
 const networkResult=JSON.parse(await readFile(networkOutput,'utf8'));
 assert.equal(networkResult.schema,'sejire/independent-recovery/v1');
 assert.equal(networkResult.historyComplete,false,'known ID alone cannot certify full history without indexes');
 assert.equal(networkResult.verifiedVersions.length,1);
 assert.deepEqual(networkResult.verifiedVersions[0].vault,onlineVault);
 console.log('PASS continuation: bundled network recovery by known ID, blocked indexes, synthetic gateway, no SEJIRE server');
}finally{await rm(temp,{recursive:true,force:true});}
