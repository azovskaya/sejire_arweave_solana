// No fixtures, injected wallets, configuration changes, signatures or live payments.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '../apps/web/node_modules/playwright/index.mjs';
const base='https://azovskaya.github.io/sejire_arweave_solana/native-admin/';
const sha=process.env.GITHUB_SHA;assert(/^[a-f0-9]{40}$/.test(sha??''),'Exact deployment source commit required');
mkdirSync('.pages-evidence',{recursive:true});
let ready=false;
for(let i=0;i<24;i++){
 try{const r=await fetch(base+'build-provenance.json',{cache:'no-store'});if(r.ok&&(await r.json()).sourceCommit===sha){ready=true;break;}}catch{}
 await new Promise(r=>setTimeout(r,5000));
}
assert(ready,'Published build provenance was not reachable');
const browser=await chromium.launch();const errors=[],failed=[],local=[],forbidden=[];const contexts=[];
try{
 for(let i=0;i<2;i++){
  const context=await browser.newContext({locale:'ru-RU',viewport:i===1?{width:390,height:844}:{width:1280,height:900}});contexts.push(context);const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  page.on('requestfailed',r=>failed.push({url:r.url(),reason:r.failure()?.errorText}));
  page.on('request',r=>{const u=new URL(r.url());if(/turbo|ardrive|workers\.dev|\/api\/checkout\//.test(u.hostname+u.pathname))forbidden.push(r.url());if(['localhost','127.0.0.1','::1'].includes(u.hostname)||u.protocol==='file:')local.push(r.url());});
  page.on('response',r=>{if(r.status()>=400)failed.push({url:r.url(),status:r.status()});});
  const response=await page.goto(base+'#/admin',{waitUntil:'networkidle'});assert.equal(response.status(),200);
  await page.getByRole('heading',{name:'Центр управления',exact:true}).waitFor();
  await page.getByRole('heading',{name:'Настроим SEJIRE',exact:true}).waitFor();
  for(const name of ['Обзор','Сохранения','Кошельки','Настройки'])assert(await page.getByRole('button',{name,exact:true}).isVisible());
  assert(!(await page.getByLabel('JSON конфигурации',{exact:true}).isVisible()));
  assert(await page.getByText('Режим просмотра',{exact:true}).isVisible());
  assert((await page.getByRole('article').filter({has:page.getByRole('heading',{name:'Цена хранения',exact:true})}).innerText()).includes('0.03 SOL'));
  await page.screenshot({path:`.pages-evidence/dashboard-${i}.png`,fullPage:true});
  await page.getByRole('button',{name:'Настройки',exact:true}).click();
  assert(await page.getByRole('button',{name:'Подготовить пилот: 0.004 AR и 30 минут',exact:true}).isDisabled(),'Viewer cannot activate pilot window');
  await page.getByRole('heading',{name:'Одна согласованная ручная загрузка',exact:true}).waitFor();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Pilot settings must fit mobile viewport');
  await page.getByRole('button',{name:'Кошельки',exact:true}).click();
  for(const name of ['Основная казна SEJIRE','Фонд памяти поколений','AR-резерв хранения'])await page.getByRole('heading',{name,exact:true}).waitFor();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await page.locator('details.admin-advanced > summary').click();
  assert(await page.getByLabel('Доверенный genesis SHA-256',{exact:true}).isVisible());
  assert(await page.getByRole('button',{name:'Опубликовать конфигурацию в Arweave (сейчас отключено)',exact:true}).isDisabled());
  await page.locator('details.admin-advanced > summary').click();
  await page.screenshot({path:`.pages-evidence/admin-wallets-${i}.png`,fullPage:true});
  await page.reload({waitUntil:'networkidle'});assert.equal(new URL(page.url()).hash,'#/admin');
  await page.getByRole('heading',{name:'Центр управления',exact:true}).waitFor();
  await page.getByRole('button',{name:'На главную',exact:true}).click();
  await page.getByRole('button',{name:'Открыть по 12 словам',exact:true}).waitFor();
  await page.getByRole('button',{name:'Открыть по 12 словам',exact:true}).click();
  await page.getByRole('button',{name:'Открыть из файла',exact:true}).waitFor();
  await page.screenshot({path:`.pages-evidence/recovery-${i}.png`,fullPage:true});
  await context.close();
 }
 assert.deepEqual(local,[],'Requests to owner computer');assert.deepEqual(forbidden,[],'Legacy payment/cloud API requested');assert.deepEqual(failed,[],'Failed public resources');assert.deepEqual(errors,[],'Browser errors');
 writeFileSync('.pages-evidence/result.json',JSON.stringify({status:'PASS',base,admin:base+'#/admin',sourceCommit:sha,cleanContexts:2,errors,failed,local,forbidden,fixture:false,walletConnected:false},null,2));
 console.log('PASS actual public HTTPS UI: two clean contexts, admin/wallets, 0.03 SOL, reload, recovery screen, no local requests or browser errors. No wallet operations.');
}finally{await browser.close();}
