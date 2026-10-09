// Read-only smoke test of the deployed V2 UI. No wallets, signatures or transfers.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '../apps/web/node_modules/playwright/index.mjs';

const base='https://azovskaya.github.io/sejire_arweave_solana/native-admin/';
const sha=process.env.GITHUB_SHA;
assert(/^[a-f0-9]{40}$/.test(sha??''),'Exact deployment source commit required');
mkdirSync('.pages-evidence',{recursive:true});
let ready=false;
for(let i=0;i<24;i++){
  try{
    const response=await fetch(base+'build-provenance.json',{cache:'no-store'});
    if(response.ok){const provenance=await response.json();
      if(provenance.sourceCommit===sha && provenance.publishedByCommit===sha){ready=true;break;}}
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,5000));
}
assert(ready,'Published V2 build provenance was not reachable');

const browser=await chromium.launch();
const errors=[],failed=[],local=[],forbidden=[];
try{
  for(let i=0;i<2;i++){
    const context=await browser.newContext({locale:'ru-RU',viewport:i?{width:390,height:844}:{width:1280,height:900}});
    const page=await context.newPage();
    await page.route(/\/graphql(?:\?|$)/,route=>route.fulfill({status:200,contentType:'application/json',body:'{"data":{"transactions":{"edges":[]}}}'}));
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    page.on('requestfailed',r=>failed.push({url:r.url(),reason:r.failure()?.errorText}));
    page.on('request',r=>{const u=new URL(r.url());
      if(/turbo|ardrive|workers\.dev|\/api\/checkout\//.test(u.hostname+u.pathname))forbidden.push(r.url());
      if(['localhost','127.0.0.1','::1'].includes(u.hostname)||u.protocol==='file:')local.push(r.url());
    });
    page.on('response',r=>{if(r.status()>=400)failed.push({url:r.url(),status:r.status()});});

    let response=await page.goto(base+'#/save',{waitUntil:'networkidle'});
    assert.equal(response.status(),200);
    await page.getByRole('heading',{name:'Сохранить семейную историю',exact:true}).waitFor();
    assert(await page.getByText('Solana Devnet · комиссия сети отдельно').isVisible());
    assert(await page.getByText('Хранение: Arweave Mainnet').isVisible());
    assert.deepEqual(await page.getByRole('list',{name:'Ход сохранения'}).getByRole('listitem').allTextContents(),
      ['Оплата','Сохранение','Готово']);
    assert(await page.getByLabel('Зашифрованный архив пилота').isVisible());
    assert.equal(await page.getByRole('heading',{name:'Центр управления'}).count(),0);
    assert.equal(await page.getByRole('button',{name:'Начать новый тест'}).count(),0);
    await page.screenshot({path:`.pages-evidence/v2-save-${i}.png`,fullPage:true});

    await page.goto(base+'#/admin',{waitUntil:'networkidle'});
    assert.equal(new URL(page.url()).hash,'#/admin');
    await page.getByRole('heading',{name:'Настройка администратора',exact:true}).waitFor();
    assert.equal(await page.getByRole('heading',{name:'Диагностика сохранения V2'}).count(),0);
    await page.getByLabel('Создайте пароль').fill('Synthetic public smoke password 2026!');
    await page.getByLabel('Повторите пароль').fill('Synthetic public smoke password 2026!');
    await page.getByRole('button',{name:'Создать пароль'}).click();
    await page.getByRole('button',{name:'Диагностика',exact:true}).click();
    await page.getByRole('heading',{name:'Диагностика сохранения V2',exact:true}).waitFor();
    assert(await page.getByText('Сохранение V2 на этом устройстве не найдено.',{exact:true}).isVisible());
    assert.equal(await page.getByRole('heading',{name:'Центр управления'}).count(),0);
    assert.equal(await page.getByRole('button',{name:'Подготовить это сохранение'}).count(),0);
    await page.reload({waitUntil:'networkidle'});
    assert.equal(new URL(page.url()).hash,'#/admin');
    await page.getByRole('button',{name:'Диагностика',exact:true}).click();
    await page.getByRole('heading',{name:'Диагностика сохранения V2',exact:true}).waitFor();
    await page.screenshot({path:`.pages-evidence/v2-admin-${i}.png`,fullPage:true});
    await page.goto(base+'#/restore?diagnostics=1',{waitUntil:'networkidle'});
    await page.getByRole('textbox',{name:'12 слов восстановления SEJIRE'}).waitFor();
    assert(await page.getByRole('button',{name:'Открыть',exact:true}).isVisible());
    assert.equal(await page.getByRole('button',{name:'Оплатить 0.03 SOL'}).count(),0);
    await page.screenshot({path:`.pages-evidence/recovery-${i}.png`,fullPage:true});
    await context.close();
  }
  assert.deepEqual(local,[],'Requests to owner computer');
  assert.deepEqual(forbidden,[],'Legacy payment/cloud API requested');
  assert.deepEqual(failed,[],'Failed public resources');
  assert.deepEqual(errors,[],'Browser errors');
  writeFileSync('.pages-evidence/result.json',JSON.stringify({status:'PASS',base,sourceCommit:sha,cleanContexts:2,
    routes:['#/save','#/admin','#/restore?diagnostics=1'],errors,failed,local,forbidden,walletConnected:false},null,2));
  console.log('PASS public V2 save, diagnostics and recovery entry in desktop and mobile browsers; no wallet actions.');
}finally{await browser.close();}
