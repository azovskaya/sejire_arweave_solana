// Read-only smoke of the deployed root build. Never handles the owner's password.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from '../apps/web/node_modules/playwright/index.mjs';

const base='https://azovskaya.github.io/sejire_arweave_solana/';
const sha=process.env.GITHUB_SHA;
assert(/^[a-f0-9]{40}$/.test(sha??''),'Exact deployment source commit required');
mkdirSync('.pages-evidence',{recursive:true});

let published=false;
for(let attempt=0;attempt<24;attempt++){
  try{
    const response=await fetch(base+'build-provenance.json',{cache:'no-store'});
    if(response.ok){
      const value=await response.json();
      if(value.sourceCommit===sha&&value.publishedByCommit===sha){published=true;break;}
    }
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,5000));
}
assert(published,'Root provenance does not match the checked source commit');
const lockResponse=await fetch(base+'admin-lock.json',{cache:'no-store'});
assert.equal(lockResponse.status,200);
const lock=await lockResponse.json();
assert.equal(lock.schema,'sejire/admin-lock/v1');
assert.equal(lock.algorithm,'PBKDF2-SHA256');
assert.equal(lock.iterations,600000);
assert.equal(lock.configured,true);

const browser=await chromium.launch();
try{
  for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
    const context=await browser.newContext({locale:'ru-RU',viewport});
    const page=await context.newPage(),failed=[],assets=[];
    page.on('request',request=>{
      const url=new URL(request.url());
      if(url.origin===new URL(base).origin){
        assert(!url.pathname.includes('/native-admin/'),'Root app loaded a native-admin asset');
        if(url.pathname.includes('/assets/'))assets.push(url.pathname);
      }
    });
    page.on('requestfailed',request=>{
      if(new URL(request.url()).origin===new URL(base).origin)failed.push('request');
    });
    page.on('response',response=>{
      if(new URL(response.url()).origin===new URL(base).origin&&response.status()>=400)failed.push(String(response.status()));
    });
    const root=await page.goto(base,{waitUntil:'networkidle'});
    assert.equal(root.status(),200);
    await page.getByRole('button',{name:'Открыть по 12 словам'}).waitFor();
    assert.equal(await page.getByRole('heading',{name:'Админ-панель'}).count(),0);
    await page.goto(base+'#/admin',{waitUntil:'networkidle'});
    await page.getByRole('heading',{name:'Админ-панель'}).waitFor();
    assert(await page.getByLabel('Пароль',{exact:true}).isVisible());
    assert.equal(await page.getByRole('button',{name:'Создать пароль'}).count(),0);
    assert.equal(await page.getByRole('button',{name:'Диагностика',exact:true}).count(),0);
    assert.equal(await page.getByLabel(/12 слов|мнемоник|seed|vault/i).count(),0);
    await page.getByLabel('Пароль',{exact:true}).fill('synthetic wrong password');
    await page.getByRole('button',{name:'Войти'}).click();
    await page.getByRole('alert').waitFor();
    assert.equal((await page.getByRole('alert').textContent())?.trim(),'Неверный пароль');
    assert.equal(await page.getByRole('button',{name:'Диагностика',exact:true}).count(),0);
    await page.reload({waitUntil:'networkidle'});
    await page.getByLabel('Пароль',{exact:true}).waitFor();
    await page.goto(base+'#/restore',{waitUntil:'networkidle'});
    await page.getByRole('textbox',{name:'12 слов восстановления SEJIRE'}).waitFor();
    assert.equal(await page.getByLabel('Пароль',{exact:true}).count(),0);
    assert(assets.some(path=>/\/assets\/.*\.js$/.test(path)),'No root JavaScript asset loaded');
    assert.deepEqual(failed,[],'Root assets failed to load');
    await context.close();
  }
  writeFileSync('.pages-evidence/root-result.json',JSON.stringify({status:'PASS',sourceCommit:sha,
    contexts:2,routes:['/','#/admin','#/restore'],ownerPasswordUsed:false,assetsFromRoot:true},null,2));
  console.log('PASS public root, protected admin login, separate restore and root assets in two clean contexts.');
}finally{await browser.close();}
