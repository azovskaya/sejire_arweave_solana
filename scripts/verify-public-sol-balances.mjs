// Read-only real browser requests from the actual public Pages origin. No wallets/config writes/fixtures.
import {chromium} from '../apps/web/node_modules/playwright/index.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
const base='https://azovskaya.github.io/sejire_arweave_solana/native-admin/';
const output=process.argv[2]??'.cache/public-sol-read/result.json';
const browser=await chromium.launch();
try{
 const context=await browser.newContext(),page=await context.newPage();await page.goto(base+'#/admin',{waitUntil:'networkidle'});
 const result=await page.evaluate(async()=>{
  const endpoint='https://api.devnet.solana.com',genesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',entries=[];let id=0;
  async function call(method,params=[]){const start=Date.now(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);let httpStatus,rpcCode,retryAfter;
   try{const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:controller.signal});httpStatus=response.status;retryAfter=response.headers.get('Retry-After');const data=await response.json();rpcCode=data.error?.code;entries.push({method,endpoint,durationMs:Date.now()-start,httpStatus,rpcCode,retryAfter,status:response.ok&&!data.error?'ok':'error',result:data.result});return data.result;
   }catch(error){entries.push({method,endpoint,durationMs:Date.now()-start,httpStatus,rpcCode,status:controller.signal.aborted?'timeout':httpStatus!==undefined?'invalid-json':'network-failure',error:String(error)});}finally{clearTimeout(timer);}
  }
  const networkVerified=(await call('getGenesisHash'))===genesis;
  for(const address of ['ETWcxNPF3Qcwvo4NHYw6JhMiKnGwrvH1U9YEAQ3rZSWd','Gy3SSxP7spgDcserSfMckPd73LeSoxdrvXeNap7huLQN'])await call('getBalance',[address,{commitment:'finalized'}]);
  await call('getSignaturesForAddress',['ETWcxNPF3Qcwvo4NHYw6JhMiKnGwrvH1U9YEAQ3rZSWd',{limit:1,commitment:'finalized'}]);
  await call('getTransaction',['mkFCDSqaRrVBdhqiNqs7Wp8jY9T3RxppqB4LhQURCpiEkc9B3EL95T9kDrbbWagATTBdD4owQqccTekQu3Bvfqh',{commitment:'finalized',encoding:'json',maxSupportedTransactionVersion:0}]);
  return {origin:location.origin,endpoint,network:'devnet',networkVerified,entries,checkedAt:new Date().toISOString(),walletConnected:false,fixture:false,scope:'Published default RPC and approved public devnet recipients; not owner browser/configuration'};
 });
 mkdirSync(output.slice(0,output.lastIndexOf('/')),{recursive:true});writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,entries:result.entries.map(({result,...entry})=>({...entry,balance:entry.method==='getBalance'?result?.value:undefined}))},null,2));
 // External availability is an observation, never silently labelled PASS or fixed by fixtures.
 console.log(result.networkVerified&&result.entries.filter(e=>e.method==='getBalance').every(e=>e.status==='ok')?'PASS real public-browser finalized balances':'BLOCKED real public-browser balance read; diagnostics saved');
 await context.close();
}finally{await browser.close();}
