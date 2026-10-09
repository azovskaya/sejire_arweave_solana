import {test,expect} from '@playwright/test';
const password='Synthetic admin password 2026!';
async function isolate(page){
  const requests=[];
  await page.route('https://**/*',async route=>{
    requests.push({url:route.request().url(),method:route.request().method(),body:route.request().postData()});
    if(new URL(route.request().url()).pathname==='/graphql'){
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:{transactions:{edges:[]}}})});return;
    }
    await route.abort();
  });
  return requests;
}
async function create(page){
  await page.goto('/#/admin');
  await expect(page.getByRole('heading',{name:'Настройка администратора'})).toBeVisible();
  await page.getByLabel('Создайте пароль').fill(password);
  await page.getByLabel('Повторите пароль').fill(password);
  await page.getByRole('button',{name:'Создать пароль'}).click();
  await expect(page.getByRole('heading',{name:'Админ-панель'})).toBeVisible();
}

test('1 public home has no admin controls',async({page})=>{
  await isolate(page);await page.goto('/');
  await expect(page.getByRole('button',{name:'Открыть по 12 словам'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Админ-панель'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Диагностика'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Касса'})).toHaveCount(0);
});
test('2 restore route remains a separate 12-word user flow',async({page})=>{
  await isolate(page);await page.goto('/#/restore');
  await expect(page.getByRole('textbox',{name:'12 слов восстановления SEJIRE'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Настройка администратора'})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Админ-панель'})).toHaveCount(0);
});
test('3 admin without password shows setup only',async({page})=>{
  await isolate(page);await page.goto('/#/admin');
  await expect(page.getByRole('heading',{name:'Настройка администратора'})).toBeVisible();
  await expect(page.getByLabel('Создайте пароль')).toHaveAttribute('type','password');
  await expect(page.getByLabel('Повторите пароль')).toHaveAttribute('type','password');
  await expect(page.getByRole('button',{name:'Диагностика'})).toHaveCount(0);
  await expect(page.getByLabel(/12 слов|мнемоник|seed|vault/i)).toHaveCount(0);
});
test('4 wrong password does not unlock admin',async({page})=>{
  await isolate(page);await create(page);await page.getByRole('button',{name:'Выйти'}).click();
  await expect(page.getByRole('heading',{name:'Админ-панель'})).toBeVisible();
  await page.getByLabel('Пароль',{exact:true}).fill('wrong password 2026');
  await page.getByRole('button',{name:'Войти'}).click();
  await expect(page.getByRole('alert')).toHaveText('Неверный пароль');
  await expect(page.getByRole('button',{name:'Диагностика'})).toHaveCount(0);
});
test('5 correct password opens desk; show/hide and Enter work',async({page})=>{
  await isolate(page);await create(page);await page.getByRole('button',{name:'Выйти'}).click();
  const input=page.getByLabel('Пароль',{exact:true});
  await input.fill(password);await page.getByRole('button',{name:'Показать пароль'}).click();
  await expect(input).toHaveAttribute('type','text');
  await page.getByRole('button',{name:'Скрыть пароль'}).click();
  await expect(input).toHaveAttribute('type','password');
  await input.press('Enter');
  await expect(page.getByRole('button',{name:'Диагностика'})).toBeVisible();
});
test('6 logout clears session and returns to password screen',async({page})=>{
  await isolate(page);await create(page);await page.getByRole('button',{name:'Выйти'}).click();
  await expect(page.getByLabel('Пароль',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>sessionStorage.getItem('sejire.ops.session'))).toBeNull();
  await page.reload();await expect(page.getByRole('button',{name:'Войти'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Диагностика'})).toHaveCount(0);
});
test('7 admin asks for password only and protects diagnostics deep link',async({page})=>{
  await isolate(page);await page.goto('/#/admin/diagnostics');
  await expect(page.getByRole('heading',{name:'Настройка администратора'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Диагностика сохранения V2'})).toHaveCount(0);
  await expect(page.getByLabel(/12 слов|мнемоник|seed|vault/i)).toHaveCount(0);
  await create(page);
  await page.getByRole('button',{name:'Диагностика'}).click();
  await expect(page.getByRole('heading',{name:'Диагностика сохранения V2'})).toBeVisible();
});
test('8 admin login neither reads recovery mnemonic nor sends password',async({page})=>{
  const requests=await isolate(page);
  await page.addInitScript(()=>{
    window.__adminReads=[];
    const original=Storage.prototype.getItem;
    Storage.prototype.getItem=function(key){window.__adminReads.push(key);return original.call(this,key);};
  });
  await create(page);
  const disk=await page.evaluate(()=>localStorage.getItem('sejire.ops.v1'));
  expect(disk).not.toContain(password);
  expect(new URL(page.url()).hash).not.toContain(password);
  expect(await page.evaluate(()=>window.__adminReads.filter(key=>/mnemonic|seed|envelope|vault/i.test(key)))).toEqual([]);
  expect(requests.some(request=>request.url.includes(password)||request.body?.includes(password))).toBe(false);
  await page.getByRole('button',{name:'Выйти'}).click();
});
test('admin JWK remains AES-GCM wrapped in persistent storage',async({page})=>{
  await isolate(page);await create(page);
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
