/** Opt-in AO testnet readiness. No SOL, AR transfer or Turbo funding. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,createHash,webcrypto,createPublicKey,verify,constants} from 'node:crypto';
Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const {createData,ArweaveSigner,DataItem}=await import('../apps/sponsor/node_modules/@dha-team/arbundles/build/web/esm/webIndex.js');
const {default:signatureData}=await import('../apps/sponsor/node_modules/@dha-team/arbundles/build/web/esm/src/ar-data-base.js');
async function verified(item){if(item.signatureType!==1)return false;const key=createPublicKey({key:{kty:'RSA',e:'AQAB',n:item.owner},format:'jwk'});return verify('sha256',await signatureData(item),{key,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32},item.rawSignature);}
if(process.argv.includes('--selftest')){
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:4096,publicExponent:65537});const key=privateKey.export({format:'jwk'});
 const signer=new ArweaveSigner(key),item=createData('PUBLIC TEST METADATA',signer,{tags:[{name:'Data-Protocol',value:'ao'},{name:'Type',value:'Message'}]});await item.sign(signer);
 if(!await verified(item))throw Error('valid_signature_rejected');const raw=Buffer.from(item.getRaw());raw[raw.length-1]^=1;
 if(await verified(new DataItem(raw)))throw Error('tampered_signature_accepted');
 console.log('PASS AO readiness signing: valid RSA-PSS accepted; changed bytes rejected; no network or persisted keys');process.exit(0);
}
if(!process.argv.includes('--execute'))throw Error('Explicit --execute required');
const dir=path.join(os.homedir(),'.sejire-devnet');
if((fs.statSync(dir).mode&0o777)!==0o700)throw Error('unsafe_local_directory');
const keyfile=path.join(dir,'ao-readiness-signer.jwk.json');
if(!fs.existsSync(keyfile)){
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:4096,publicExponent:65537});
 fs.writeFileSync(keyfile,JSON.stringify(privateKey.export({format:'jwk'})),{flag:'wx',mode:0o600});
}
if((fs.statSync(keyfile).mode&0o777)!==0o600)throw Error('unsafe_signer_permissions');
const jwk=JSON.parse(fs.readFileSync(keyfile,'utf8'));
const address=createHash('sha256').update(Buffer.from(jwk.n,'base64url')).digest('base64url');
const moduleId='ISShJH1ij-hPPt9St5UFFr_8Ys3Kj5cyg7zrMGt7H9s';
const scheduler='_GQ33BkPtZrqxA84vM8Zk-N2aO0toNNu_C-l-rawrBA';
const file=path.join(dir,'ao-readiness-operation.json');
let op;
if(fs.existsSync(file))op=JSON.parse(fs.readFileSync(file,'utf8'));
else{
 const code=`local json=require('json')\nassert(Owner==${JSON.stringify(address)},'creation_owner_mismatch')\nlocal info={protocol='sejire/ao-readiness/v1',paymentJournalReady=false,creationOwner=Owner}\nHandlers.prepend('sejire-readiness-no-eval',function(m)return m.Action=='Eval' end,function(m)ao.send({Target=m.From,Data='READINESS_ONLY_EVAL_REJECTED'})end)\nHandlers.add('sejire-readiness-info',function(m)return m.Action=='ProtocolInfo' end,function(m)ao.send({Target=m.From,Data=json.encode(info)})end)\nprint(json.encode(info))`;
 const tags=[{name:'Data-Protocol',value:'ao'},{name:'Variant',value:'ao.TN.1'},{name:'Type',value:'Process'},{name:'Timestamp',value:String(Date.now())},{name:'Module',value:moduleId},{name:'Scheduler',value:scheduler},{name:'Name',value:'sejire-readiness-test-only'},{name:'On-Boot',value:'Data'},{name:'Content-Type',value:'application/lua'},{name:'App-Name',value:'SEJIRE-test-readiness'}];
 const item=createData(code,new ArweaveSigner(jwk),{tags});await item.sign(new ArweaveSigner(jwk));
 op={network:'AO-testnet',signer:address,moduleId,scheduler,processId:item.id,codeHash:createHash('sha256').update(code).digest('hex'),rawBase64:item.getRaw().toString('base64'),status:'prepared',paymentJournalReady:false};
 fs.writeFileSync(file,JSON.stringify(op),{flag:'wx',mode:0o600});
}
if(!await verified(new DataItem(Buffer.from(op.rawBase64,'base64'))))throw Error('signed_bytes_invalid');
if(op.httpStatus>=500)op.status='unknown';
const pub=()=>({network:op.network,signer:op.signer,moduleId:op.moduleId,scheduler:op.scheduler,candidateProcessId:op.processId,codeHash:op.codeHash,status:op.status,paymentJournalReady:false});
console.log(JSON.stringify(pub()));
if(op.status==='prepared'||op.status==='unknown'){
 try{
  const r=await fetch('https://mu.ao-testnet.xyz',{method:'POST',headers:{'Content-Type':'application/octet-stream','Accept':'application/json'},body:Buffer.from(op.rawBase64,'base64'),signal:AbortSignal.timeout(30000)});
  const text=await r.text();op.httpStatus=r.status;
  // Response body is public server data; cap persistence, never print request bytes/key.
  op.response=text.slice(0,2000);op.status=r.ok?'mu-accepted':r.status>=500?'unknown':'mu-rejected';fs.writeFileSync(file,JSON.stringify(op),{mode:0o600});
  console.log(JSON.stringify({...pub(),httpStatus:r.status,response:op.response}));
 }catch{op.status='unknown';fs.writeFileSync(file,JSON.stringify(op),{mode:0o600});console.log(JSON.stringify(pub()));process.exitCode=1;}
}

if(op.status!=='mu-accepted')process.exitCode=1;
