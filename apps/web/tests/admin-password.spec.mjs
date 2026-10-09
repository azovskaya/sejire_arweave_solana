import {test,expect} from '@playwright/test';
import {adminPassword,mockAdminLock} from './admin-password.fixture.mjs';

async function isolate(page){
  const requests=[];
  await mockAdminLock(page);
  await page.route('https://**/*',async route=>{
    requests.push({url:route.request().url(),body:route.request().postData()});
    if(new URL(route.request().url()).pathname==='/graphql'){
      await route.fulfill({status:200,contentType:'application/json',body:'{"data":{"transactions":{"edges":[]}}}'});return;
    }
    await route.abort();
  });
  return requests;
}
async function login(page,pass=adminPassword){
  await page.getByLabel('Пароль',{exact:true}).fill(pass);
  await page.getByRole('button',{name:'Войти'}).click();
}

test('public home has no admin controls',async({page})=>{
  await isolate(page);await page.goto('/');
  await expect(page.getByRole('button',{name:'Открыть по 12 словам'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Админ-панель'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Диагностика'})).toHaveCount(0);
});
test('restore route remains separate from admin password',async({page})=>{
  await isolate(page);await page.goto('/#/restore');
  await expect(page.getByRole('textbox',{name:'12 слов восстановления SEJIRE'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Админ-панель'})).toHaveCount(0);
});
test('admin always shows only a password; browser cannot create one',async({page})=>{
  await isolate(page);await page.goto('/#/admin');
  await expect(page.getByRole('heading',{name:'Админ-панель'})).toBeVisible();
  await expect(page.getByLabel('Пароль',{exact:true})).toHaveAttribute('type','password');
  await expect(page.getByRole('button',{name:'Создать пароль'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Диагностика'})).toHaveCount(0);
  await expect(page.getByLabel(/12 слов|мнемоник|seed|vault/i)).toHaveCount(0);
});
test('wrong password never opens Admin Desk',async({page})=>{
  await isolate(page);await page.goto('/#/admin');await login(page,'wrong password');
  await expect(page.getByRole('alert')).toHaveText('Неверный пароль');
  await expect(page.getByRole('button',{name:'Диагностика'})).toHaveCount(0);
});
test('correct password opens desk with show/hide and Enter',async({page})=>{
  await isolate(page);await page.goto('/#/admin');
  const input=page.getByLabel('Пароль',{exact:true});
  await input.fill(adminPassword);await page.getByRole('button',{name:'Показать пароль'}).click();
  await expect(input).toHaveAttribute('type','text');
  await page.getByRole('button',{name:'Скрыть пароль'}).click();
  await expect(input).toHaveAttribute('type','password');
  await input.press('Enter');
  await expect(page.getByRole('button',{name:'Диагностика'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Создать пароль'})).toHaveCount(0);
});
test('reload locks Admin Desk again',async({page})=>{
  await isolate(page);await page.goto('/#/admin');await login(page);
  await expect(page.getByRole('button',{name:'Диагностика'})).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Пароль',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Диагностика'})).toHaveCount(0);
  expect(await page.evaluate(()=>sessionStorage.getItem('sejire.ops.session'))).toBeNull();
});
test('logout erases in-memory password and returns to login',async({page})=>{
  await isolate(page);await page.goto('/#/admin');await login(page);
  await page.getByRole('button',{name:'Выйти'}).click();
  await expect(page.getByLabel('Пароль',{exact:true})).toBeVisible();
  expect(await page.evaluate(async()=> (await import('/src/lib/opsDesk/store.ts')).readSessionPassword())).toBeNull();
});
test('the same verifier works in browser A and clean browser B',async({browser})=>{
  for(let i=0;i<2;i++){
    const context=await browser.newContext({locale:'ru-RU'}),page=await context.newPage();
    await isolate(page);await page.goto('/#/admin');
    expect(await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length}))).toEqual({local:0,session:0});
    await login(page);await expect(page.getByRole('button',{name:'Диагностика'})).toBeVisible();
    await context.close();
  }
});
test('old localStorage hash and session cannot create an administrator',async({page})=>{
  await isolate(page);
  await page.addInitScript(()=>{
    localStorage.setItem('sejire.ops.v1',JSON.stringify({passwordHash:'pbkdf2$210000$fake$fake',settings:{},movements:[]}));
    sessionStorage.setItem('sejire.ops.session','old-browser-password');
  });
  await page.goto('/#/admin');
  await expect(page.getByLabel('Пароль',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>sessionStorage.getItem('sejire.ops.session'))).toBeNull();
  await login(page,'old-browser-password');
  await expect(page.getByRole('alert')).toHaveText('Неверный пароль');
});
test('disabled release placeholder fails closed',async({page})=>{
  await isolate(page);
  await page.route('**/admin-lock.json',route=>route.fulfill({status:200,contentType:'application/json',
    body:JSON.stringify({schema:'sejire/admin-lock/v1',algorithm:'PBKDF2-SHA256',configured:false,iterations:600000,salt:'',digest:''})}));
  await page.goto('/#/admin');await login(page);
  await expect(page.getByRole('button',{name:'Диагностика'})).toHaveCount(0);
  await expect(page.getByLabel('Пароль',{exact:true})).toBeVisible();
});
test('admin login reads no mnemonic and sends or logs no password',async({page})=>{
  const requests=await isolate(page),consoleMessages=[];
  page.on('console',message=>consoleMessages.push(message.text()));
  await page.addInitScript(()=>{
    window.__adminReads=[];
    const original=Storage.prototype.getItem;
    Storage.prototype.getItem=function(key){window.__adminReads.push(key);return original.call(this,key);};
  });
  await page.goto('/#/admin');await login(page);
  await expect(page.getByRole('button',{name:'Диагностика'})).toBeVisible();
  expect(new URL(page.url()).hash).not.toContain(adminPassword);
  expect(JSON.stringify(await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage))))).not.toContain(adminPassword);
  expect(await page.evaluate(()=>window.__adminReads.filter(key=>/mnemonic|seed|envelope|vault/i.test(key)))).toEqual([]);
  expect(requests.some(request=>request.url.includes(adminPassword)||request.body?.includes(adminPassword))).toBe(false);
  expect(consoleMessages.join('\n')).not.toContain(adminPassword);
});
test('protected diagnostics and AES-GCM wrapped local admin key',async({page})=>{
  await isolate(page);await page.goto('/#/admin/diagnostics');
  await expect(page.getByRole('heading',{name:'Диагностика сохранения V2'})).toHaveCount(0);
  await login(page);
  await expect(page.getByRole('heading',{name:'Диагностика сохранения V2'})).toBeVisible();
  await page.evaluate(async()=>{
    const store=await import('/src/lib/opsDesk/store.ts');
    await store.applyOpsKeyPatch({turboJwk:JSON.stringify({kty:'RSA',n:'synthetic-public',d:'synthetic-secret'})});
  });
  const disk=await page.evaluate(()=>localStorage.getItem('sejire.ops.v1'));
  expect(disk).not.toContain('synthetic-secret');
  expect(disk).toContain('"wrap"');
  await page.getByRole('button',{name:'Выйти'}).click();
  expect(await page.evaluate(async()=> (await import('/src/lib/opsDesk/store.ts')).getHotTreasury())).toBeNull();
});
