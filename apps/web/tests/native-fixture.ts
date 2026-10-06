/** PUBLIC reproducible test-only keys: never fund, never submit to a real network. */
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { canonical } from '../../../packages/protocol/wire';
import { configHash, CONFIG_DOMAIN, acceptancePayload, type Config } from '../src/lib/native/config';
import { newJob,orderPayload } from '../src/lib/native/jobs';
import { preparePayment, solWallet } from '../src/lib/native/payment';
import { installWallet, fixture } from './browser-fixture';
const seed=new Uint8Array(32).fill(17),key=Keypair.fromSeed(seed);
const sign=(value:unknown)=>({publicKey:key.publicKey.toBase58(),signature:bs58.encode(ed25519.sign(new TextEncoder().encode(canonical(value)),seed))});
export async function setup() {
 installWallet();
 const injected=(window as unknown as {phantom:{solana:{signMessage:(bytes:Uint8Array)=>Promise<unknown>;publicKey:unknown}}}).phantom.solana;
 const signMessage=injected.signMessage;injected.signMessage=async bytes=>({signature:await signMessage(bytes),publicKey:injected.publicKey});
 const family=await fixture();
 const config:Config={domain:CONFIG_DOMAIN,project:'SEJIRE',version:1,previous:null,environment:'devnet',createdAt:Date.now(),nonce:'a'.repeat(32),serviceLamports:'30000000',wallets:{service:bs58.encode(new Uint8Array(32).fill(2)),fund:bs58.encode(new Uint8Array(32).fill(3)),arReserve:'A'.repeat(43)},managers:[key.publicKey.toBase58()],threshold:1,solanaRpcs:['https://api.devnet.solana.com'],arweaveNodes:['https://arweave.net'],arweaveNetwork:'arweave.N.1',upload:{maxBytes:1048576,maxRewardWinston:'10000',acceptingUntil:Date.now()+1800000},identifiers:{protocol:null,release:null}};
 const chain={schema:'sejire/config-chain/v1' as const,versions:[{config,signatures:[sign(config)],acceptance:[sign(acceptancePayload(config))]}]};
 return {config,chain,anchor:await configHash(config),family};
}
export async function jobFixture(withFund=false,donation=false) {
 const result=await setup(),wallet=solWallet();
 const job=await newJob(result.config,key.publicKey.toBase58(),withFund||donation?'0.005':'0',donation?undefined:result.family.envelope,wallet);
 const prep=await preparePayment(result.config,job);prep.transaction.sign(key);job.signedPayment=prep.transaction.serialize().toString('base64');job.paymentSignature=bs58.encode(prep.transaction.signature!);job.signingStarted=true;job.attempt!.phase='signed';
 const compiled=prep.transaction.compileMessage();
 const tx={version:'legacy',slot:100,blockTime:Math.ceil(job.order.createdAt/1000),meta:{err:null,fee:5000,innerInstructions:[],preBalances:compiled.accountKeys.map(()=>1000000000),postBalances:compiled.accountKeys.map(()=>1000000000),preTokenBalances:[],postTokenBalances:[]},transaction:{signatures:[job.paymentSignature],message:{header:compiled.header,accountKeys:compiled.accountKeys.map(k=>k.toBase58()),recentBlockhash:compiled.recentBlockhash,instructions:compiled.instructions}}};
 return {...result,job,tx,package:{schema:'sejire/native-job-package/v1',chain:result.chain,job}};
}
export async function decodeBroadcast(raw:string) {
 const {Transaction}=await import('@solana/web3.js');const {Buffer}=await import('buffer');
 const tx=Transaction.from(Buffer.from(raw,'base64')),m=tx.compileMessage();
 return {version:'legacy',slot:100,blockTime:Math.ceil(Date.now()/1000),meta:{err:null,fee:5000,innerInstructions:[],preBalances:m.accountKeys.map(()=>1000000000),postBalances:m.accountKeys.map(()=>1000000000),preTokenBalances:[],postTokenBalances:[]},transaction:{signatures:[bs58.encode(tx.signature!)],message:{header:m.header,accountKeys:m.accountKeys.map(k=>k.toBase58()),recentBlockhash:m.recentBlockhash,instructions:m.instructions}}};
}
/** Signed synthetic stopped policy: proves readiness rejects before any order signature. */
export async function stoppedSetup() {
 const v=await setup();v.config.upload.acceptingUntil=0;
 v.chain.versions[0]={config:v.config,signatures:[sign(v.config)],acceptance:[sign(acceptancePayload(v.config))]};
 return {...v,anchor:await configHash(v.config)};
}
/** Full local browser journey: synthetic RSA owner and public RPC fixtures; never a real wallet. */
export async function journeySetup() {
 const v=await setup();const {arClient}=await import('../src/lib/native/arweave');const ar=arClient('https://arweave.net');const jwk=await ar.wallets.generate();v.config.wallets.arReserve=await ar.wallets.jwkToAddress(jwk);v.chain.versions[0]={config:v.config,signatures:[sign(v.config)],acceptance:[sign(acceptancePayload(v.config))]};v.anchor=await configHash(v.config);
 Object.assign(window,{arweaveWallet:{async connect(){},async getActiveAddress(){return v.config.wallets.arReserve;},async getActivePublicKey(){return jwk.n;},async sign(raw:unknown){const tx=ar.transactions.fromRaw(raw as never);await ar.transactions.sign(tx,jwk);return tx.toJSON();}}});
 const {trustChain}=await import('../src/lib/native/session');await trustChain(v.chain,v.anchor);return v;
}
export async function legacyUnknownFixture() {
 const v=await setup(),wallet=solWallet();const job=await newJob(v.config,key.publicKey.toBase58(),'0',v.family.envelope,wallet);job.order.id='9bb9b792bbb948fe88935a1aa4a2cd51';job.signatures=[sign(orderPayload(job))];job.signingStarted=true;
 const {trustChain}=await import('../src/lib/native/session');const {saveJob,writeCache}=await import('../src/lib/native/cache');await trustChain(v.chain,v.anchor);await saveJob(job);await writeCache('active-saving',job.order.id);return {...v,job};
}
