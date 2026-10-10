/** Opt-in LOCAL devnet E2E. Never run in CI: test keypair stays outside Git.
 * Node 22: npm exec --prefix apps/sponsor -- tsx scripts/devnet-sol-checkout.mjs <preview HTTPS> <plain|with-fund|donation> [--execute]
 * Catalina: node --experimental-loader ./scripts/offline-ts-loader.mjs scripts/devnet-sol-checkout.mjs ...
 * No faucet, mainnet, new signature after uncertainty, or secret output.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto, randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createMnemonic } from '../apps/web/src/lib/crypto/bip39.ts';
import { deriveKeysFromMnemonic } from '../apps/web/src/lib/crypto/keys.ts';
import { emptyVault, putTree, openEnvelope } from '../apps/web/src/lib/crypto/vault.ts';
import { encryptJson } from '../apps/web/src/lib/crypto/encrypt.ts';
import { createTree, upsertPersonFields, commitDraft } from '../apps/web/src/lib/treeEngine.ts';
const SERVICE='ETWcxNPF3Qcwvo4NHYw6JhMiKnGwrvH1U9YEAQ3rZSWd', FUND='Gy3SSxP7spgDcserSfMckPd73LeSoxdrvXeNap7huLQN';
const PAYER='Hn9ELgjKXrb7svZM9XtDYozGTirxo5e1tWRy1J1v4vwF', GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const [endpoint,scenario,execute]=process.argv.slice(2);
if(endpoint==='--help'){console.log('Local opt-in SOL checkout: <approved preview origin> <plain|with-fund|donation> [--execute]. No CI secrets, no mainnet.');process.exit(0);}
if (!endpoint || !['plain','with-fund','donation'].includes(scenario)) throw Error('Specify approved preview origin and scenario; --execute is opt-in');
const origin=new URL(endpoint);
if(origin.protocol!=='https:' || !origin.hostname.startsWith('sejire-devnet-preview.') || !origin.hostname.endsWith('.workers.dev') || origin.username || origin.password || origin.search || origin.hash || origin.pathname!=='/') throw Error('Only isolated HTTPS preview origin allowed');
globalThis.crypto=webcrypto;
vm.runInThisContext(fs.readFileSync(new URL('../apps/web/node_modules/@solana/web3.js/lib/index.iife.js',import.meta.url),'utf8'));
const w=globalThis.solanaWeb3, c=new w.Connection('https://api.devnet.solana.com','finalized');
const dir=path.join(os.homedir(),'.sejire-devnet');
if((fs.statSync(dir).mode&0o777)!==0o700)throw Error('Unsafe secret directory permissions');
const file=path.join(dir,`sol-${scenario}-operation.json`);
function save(value){fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});}
const sha=s=>createHash('sha256').update(s).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let op;
async function api(route,body,extras={}) {
 const response=await fetch(origin.origin+'/api/checkout'+route,{method:body===undefined?'GET':'POST',headers:{Origin:origin.origin,'Content-Type':'application/json',...(op?.token?{Authorization:'Bearer '+op.token}:{}),...extras},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
 const value=await response.json(); if(!response.ok)throw Error(`API ${response.status}: ${value.error??'request_failed'}`); return value;
}
function checkOrder(o){assert.equal(o.network,'devnet');assert.equal(o.asset.symbol,'SOL');assert.equal(o.asset.mint,null);assert.equal(o.asset.decimals,9);assert.equal(o.payer,PAYER);assert.equal(o.servicePayment.recipient,SERVICE);assert.equal(o.fundContribution.recipient,FUND);assert.equal(o.servicePayment.amount,scenario==='donation'?'0':'30000000');assert.equal(o.fundContribution.amount,scenario==='plain'?'0':'5000000');assert.equal(o.total,(BigInt(o.servicePayment.amount)+BigInt(o.fundContribution.amount)).toString());if(op.serialized){assert.equal(o.archive.digest,sha(op.serialized));assert.equal(o.archive.bytes,Buffer.byteLength(op.serialized));}}
try {
 assert.equal(await c.getGenesisHash(),GENESIS);
 if(fs.existsSync(file)){if((fs.statSync(file).mode&0o777)!==0o600)throw Error('Unsafe journal permissions');op=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(op.origin,origin.origin);}
 else {
  op={origin:origin.origin,scenario,idempotency:randomBytes(16).toString('hex'),balanceBefore:await c.getBalance(new w.PublicKey(PAYER),'finalized')};
  if(scenario!=='donation'){
   op.words=createMnemonic();const keys=deriveKeysFromMnemonic(op.words);
   let first=upsertPersonFields(createTree('Synthetic family A'),{id:'parent',name:'Synthetic parent',parents:[]});
   first=upsertPersonFields(first,{id:'child',name:'Synthetic child',parents:['parent']});first=commitDraft(first,'First synthetic revision');
   first=commitDraft(upsertPersonFields(first,{id:'child',name:'Synthetic corrected child',parents:['parent']}),'Synthetic correction');
   const second=commitDraft(upsertPersonFields(createTree('Synthetic family B'),{id:'other',name:'Synthetic other',parents:[]}),'Synthetic second tree');
   op.vault=putTree(putTree(emptyVault(keys.vaultId),second),first);op.serialized=JSON.stringify(await encryptJson(keys.encKey,keys.vaultId,op.vault));
  }
  save(op);
 }
 if(!op.token){const session=await api('/session',{});op.token=session.accessToken;save(op);}
 if(!op.order){const created=await api('/orders',{kind:scenario==='donation'?'contribution':'preservation',payer:PAYER,contribution:scenario==='plain'?'0':'0.005',...(op.serialized?{archive:{digest:sha(op.serialized),bytes:Buffer.byteLength(op.serialized)}}:{})},{'Idempotency-Key':op.idempotency});op.order=created.record.order;save(op);}
 checkOrder(op.order);
 let snapshot=await api(`/orders/${op.order.id}`);
 if(snapshot.record.pendingSignature){if(op.signature)assert.equal(op.signature,snapshot.record.pendingSignature);else throw Error('Server signature absent from local journal; manual reconciliation required');}
 if(!op.signature && snapshot.record.states.payment!=='verified'){
  const prep=await api(`/orders/${op.order.id}/prepare`,{});
  const tx=new w.Transaction({feePayer:new w.PublicKey(PAYER),recentBlockhash:prep.blockhash});
  for(const part of [op.order.servicePayment,op.order.fundContribution])if(part.amount!=='0'){
   const data=Buffer.alloc(12);data.writeUInt32LE(2);data.writeBigUInt64LE(BigInt(part.amount),4);
   tx.add(new w.TransactionInstruction({programId:w.SystemProgram.programId,keys:[{pubkey:new w.PublicKey(PAYER),isSigner:true,isWritable:true},{pubkey:new w.PublicKey(part.recipient),isSigner:false,isWritable:true},{pubkey:new w.PublicKey(op.order.reference),isSigner:false,isWritable:false}],data}));
  }
  const fee=(await c.getFeeForMessage(tx.compileMessage(),'finalized')).value;
  if(fee!==5000)throw Error('Unexpected network fee; review required');
  const before=await c.getBalance(new w.PublicKey(PAYER),'finalized');
  console.log(JSON.stringify({network:'devnet',payer:PAYER,balanceBeforeLamports:before,serviceRecipient:SERVICE,fundRecipient:FUND,serviceLamports:op.order.servicePayment.amount,fundLamports:op.order.fundContribution.amount,feeLamports:String(fee),maximumSpendLamports:(BigInt(op.order.total)+BigInt(fee)).toString(),orderId:op.order.id}));
  if(execute!=='--execute'){console.log('Prepared only; no signing or transfer. Re-run with --execute after reviewing these values.');process.exit(0);}
  if(BigInt(before)<BigInt(op.order.total)+BigInt(fee)||Date.now()>op.order.expiresAt)throw Error('Balance or order expiry blocks signing');
  const keyfile=path.join(dir,'test-payer.json');if((fs.statSync(keyfile).mode&0o777)!==0o600)throw Error('Unsafe key permissions');
  const signer=w.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyfile,'utf8'))));assert.equal(signer.publicKey.toBase58(),PAYER);
  tx.sign(signer);
  const bs58=(await import('../apps/sponsor/node_modules/bs58/index.js')).default;
  op.signature=bs58.encode(tx.signature);op.signedBase64=tx.serialize().toString('base64');save(op);
 }
 if(snapshot.record.states.payment!=='verified'){
  if(execute!=='--execute')throw Error('Saved operation awaits opt-in reconciliation');
  await api(`/orders/${op.order.id}/reserve`,{signature:op.signature});
  const status=(await c.getSignatureStatuses([op.signature],{searchTransactionHistory:true})).value[0];
  if(!status){if(Date.now()>op.order.expiresAt)throw Error('Expired unknown payment; reconcile only, no rebroadcast');await c.sendRawTransaction(Buffer.from(op.signedBase64,'base64'),{skipPreflight:false,maxRetries:2});}
  for(let i=0;i<120;i++){snapshot=await api(`/orders/${op.order.id}/reconcile`,{});if(snapshot.record.states.payment==='verified')break;await sleep(1000);}
  if(snapshot.record.states.payment!=='verified')throw Error('Payment unresolved; same signature retained');
 }
 const originalPayment=JSON.stringify(snapshot.record.payment);snapshot=await api(`/orders/${op.order.id}/reconcile`,{});assert.equal(JSON.stringify(snapshot.record.payment),originalPayment);
 let hashVerified=null,restoreVerified=null;
 if(op.serialized){
  for(let i=0;i<30;i++){snapshot=await api(`/orders/${op.order.id}/execute`,{serialized:op.serialized});if(snapshot.execution?.retrieved)break;await sleep(2000);}
  if(!snapshot.execution?.retrieved)throw Error('Upload accepted or unresolved; retrieval not yet proven');
  const fetched=await fetch(`https://ar-io.dev/raw/${snapshot.execution.id}`,{signal:AbortSignal.timeout(30000)});
  if(!fetched.ok)throw Error('Independent retrieval failed');const bytes=Buffer.from(await fetched.arrayBuffer());assert.equal(sha(bytes),op.order.archive.digest);hashVerified=true;
  const keys=deriveKeysFromMnemonic(op.words),restored=await openEnvelope(keys,JSON.parse(bytes.toString()));assert.deepEqual(restored,op.vault);
  assert.deepEqual(await openEnvelope(keys,JSON.parse(op.serialized)),op.vault);restoreVerified=true;
 }
 const evidence={network:'devnet',payer:PAYER,serviceRecipient:SERVICE,fundRecipient:FUND,balanceBeforeLamports:op.balanceBefore,balanceAfterLamports:await c.getBalance(new w.PublicKey(PAYER),'finalized'),signature:op.signature,explorer:`https://explorer.solana.com/tx/${op.signature}?cluster=devnet`,serviceLamports:op.order.servicePayment.amount,fundLamports:op.order.fundContribution.amount,networkFeeLamports:snapshot.record.payment.feeLamports,orderId:op.order.id,orderState:snapshot.record.states,receipt:snapshot.execution?.accepted??null,dataItemId:snapshot.execution?.id??null,sha256:hashVerified,restore:restoreVerified,repeatCreditUnchanged:true,phantom:'NOT RUN',arweaveSettlement:'NOT PROVEN'};
 op.evidence=evidence;save(op);fs.writeFileSync(path.join(dir,`sol-${scenario}-public-evidence.json`),JSON.stringify(evidence,null,2),{mode:0o600});console.log(JSON.stringify(evidence,null,2));
} catch {
 // Do not print SDK errors, request headers, recovery words or local journal contents.
 console.error('Live test BLOCKED/incomplete. Local journal retained outside Git; reconcile existing order/signature before retry.');process.exitCode=1;
}
