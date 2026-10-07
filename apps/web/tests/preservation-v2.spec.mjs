import {test,expect} from '@playwright/test';
import {archive} from './preservation-v2.fixture.mjs';
import {installV2Mock} from './preservation-v2.mock.mjs';

async function start(page){
  await page.addInitScript(installV2Mock);
  await page.goto('/#/save');
  await page.getByLabel('Зашифрованный архив пилота').setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from(archive)});
  await expect(page.getByRole('button',{name:'Оплатить 0.03 SOL'})).toBeEnabled();
}
async function saved(page){return page.evaluate(async()=>{
  const policy=await import('/src/lib/preserveV2/policy.ts');
  const store=await import('/src/lib/preserveV2/store.ts');
  return store.readSession(await policy.saveId());
});}
async function count(page,key){return page.evaluate(k=>Number(localStorage.getItem(`v2mock:${k}`)??0),key);}
async function set(page,key,value){await page.evaluate(([k,v])=>localStorage.setItem(`v2mock:${k}`,String(v)),[key,value]);}
async function payOnce(page){await page.getByRole('button',{name:'Оплатить 0.03 SOL'}).click();await expect(page.getByText('✓ Оплата подтверждена')).toBeVisible();}
async function signOnce(page){await expect(page.getByText(/Текущая цена хранения:/)).toBeVisible();await page.getByRole('button',{name:'Сохранить навсегда'}).click();}

test('V2 route shows the three stages and exact pilot limits without wallet access',async({page})=>{
  let walletCalls=0;
  await page.addInitScript(()=>{
    Object.defineProperty(window,'phantom',{value:{solana:{isPhantom:true,connect:()=>{window.__walletCalls=(window.__walletCalls??0)+1;throw Error('unexpected wallet call');}}}});
    Object.defineProperty(window,'arweaveWallet',{value:{connect:()=>{window.__walletCalls=(window.__walletCalls??0)+1;throw Error('unexpected wallet call');}}});
  });
  await page.goto('/#/save');
  await expect(page.getByRole('heading',{name:'Сохранить семейную историю'})).toBeVisible();
  await expect(page.getByText('Solana Devnet · комиссия сети отдельно')).toBeVisible();
  await expect(page.getByText('Реальные AR · до 0.004 AR')).toBeVisible();
  await expect(page.getByRole('list',{name:'Ход сохранения'}).locator('li')).toHaveCount(3);
  await expect(page.getByRole('button',{name:'Оплатить 0.03 SOL'})).toHaveCount(0);
  walletCalls=await page.evaluate(()=>window.__walletCalls??0);expect(walletCalls).toBe(0);
});

test('wrong file is rejected before either wallet',async({page})=>{
  await page.goto('/#/save');
  await page.getByLabel('Зашифрованный архив пилота').setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from('{"synthetic":true}')});
  await expect(page.getByRole('alert')).toContainText('Файл архива не совпадает');
  await expect(page.getByRole('button',{name:'Оплатить 0.03 SOL'})).toHaveCount(0);
});

test('V2 diagnostics are read-only and do not expose the legacy operator',async({page})=>{
  await page.goto('/#/admin');
  await expect(page.getByRole('heading',{name:'Диагностика сохранения V2'})).toBeVisible();
  await expect(page.getByRole('button',{name:'На главную'})).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(1);
  await expect(page.getByText('Сохранение V2 на этом устройстве не найдено.')).toBeVisible();
});

test('full V2 browser journey completes automatically with one Phantom and one Wander signature',async({page})=>{
  await start(page);
  await payOnce(page);
  await expect(page.getByText(/Текущая цена хранения:/)).toBeVisible();
  expect(await count(page,'wanderConnects')).toBe(0);
  await signOnce(page);
  await expect(page.getByText('✓ Семейная история сохранена навсегда')).toBeVisible();
  await expect(page.getByRole('link',{name:'Проверить восстановление'})).toBeVisible();
  expect(await count(page,'phantomCalls')).toBe(1);
  expect(await count(page,'wanderSigns')).toBe(1);
  expect((await saved(page)).state).toBe('COMPLETE');
  await page.reload();
  await expect(page.getByText('✓ Семейная история сохранена навсегда')).toBeVisible();
  expect(await count(page,'phantomCalls')).toBe(1);expect(await count(page,'wanderSigns')).toBe(1);
});

test('reload after Phantom broadcast discovers the same payment without another popup',async({page})=>{
  await start(page);await set(page,'phantomLost','1');
  await page.getByRole('button',{name:'Оплатить 0.03 SOL'}).click();
  await expect.poll(async()=>(await saved(page)).state).toBe('SOLANA_PENDING');
  const before=await saved(page);await page.reload();
  await expect(page.getByText('✓ Оплата подтверждена')).toBeVisible();
  const after=await saved(page);expect(after.saveId).toBe(before.saveId);expect(after.solanaReference).toBe(before.solanaReference);
  expect(await count(page,'phantomCalls')).toBe(1);
});

test('reload after SOLANA_PAID re-quotes without reconnecting Phantom or Wander',async({page})=>{
  await start(page);await payOnce(page);const before=await saved(page);
  await page.reload();await expect(page.getByText(/Текущая цена хранения:/)).toBeVisible();
  expect((await saved(page)).saveId).toBe(before.saveId);
  expect(await count(page,'phantomCalls')).toBe(1);expect(await count(page,'wanderConnects')).toBe(0);
});

test('reload after saved Wander signature resumes same Arweave ID without re-signing',async({page})=>{
  await start(page);await payOnce(page);await set(page,'uploadMode','pause-before');await signOnce(page);
  await expect.poll(async()=>(await saved(page)).state).toBe('AR_UPLOADING');
  const before=await saved(page);expect(before.arSignedTransaction).toBeTruthy();
  await set(page,'uploadMode','normal');await page.reload();
  await expect(page.getByText('✓ Семейная история сохранена навсегда')).toBeVisible();
  const after=await saved(page);expect(after.arTransactionId).toBe(before.arTransactionId);
  expect(after.saveId).toBe(before.saveId);expect(await count(page,'wanderSigns')).toBe(1);
});

test('reload mid Arweave upload persists chunk progress and resumes same transaction',async({page})=>{
  await start(page);await payOnce(page);await set(page,'uploadMode','pause-mid');await signOnce(page);
  await expect.poll(async()=>(await saved(page)).arUploadProgress?.chunkIndex).toBe(1);
  const before=await saved(page);await set(page,'uploadMode','normal');await page.reload();
  await expect(page.getByText('✓ Семейная история сохранена навсегда')).toBeVisible();
  const after=await saved(page);expect(after.arTransactionId).toBe(before.arTransactionId);
  expect(after.saveId).toBe(before.saveId);expect(await count(page,'wanderSigns')).toBe(1);
});

test('reload while awaiting Arweave confirmation completes automatically after inclusion',async({page})=>{
  await start(page);await payOnce(page);await set(page,'confirmed','0');await signOnce(page);
  await expect.poll(async()=>(await saved(page)).state).toBe('AR_PENDING_CONFIRMATION');
  const before=await saved(page);await page.reload();
  await expect(page.getByText('Проверяем Arweave и скачанный архив...')).toBeVisible();
  await set(page,'confirmed','1');
  await expect(page.getByText('✓ Семейная история сохранена навсегда')).toBeVisible();
  const after=await saved(page);expect(after.arTransactionId).toBe(before.arTransactionId);
  expect(after.saveId).toBe(before.saveId);expect(await count(page,'wanderSigns')).toBe(1);
});

test('gateway payload with wrong SHA never shows COMPLETE',async({page})=>{
  await start(page);await payOnce(page);await set(page,'confirmed','0');await signOnce(page);
  await expect.poll(async()=>(await saved(page)).state).toBe('AR_PENDING_CONFIRMATION');
  await set(page,'gatewayPayload','{"tampered":true}');await set(page,'confirmed','1');
  await expect.poll(async()=>(await saved(page)).lastError).toBe('retrieved_archive_mismatch');
  expect((await saved(page)).state).toBe('AR_PENDING_CONFIRMATION');
  await expect(page.getByText('✓ Семейная история сохранена навсегда')).toHaveCount(0);
});

test('lost Wander response before persistence allows a safe same-session retry',async({page})=>{
  await start(page);await payOnce(page);await set(page,'wanderLost','1');await signOnce(page);
  await expect.poll(async()=>(await saved(page)).arSigningStarted).toBe(true);
  const before=await saved(page);await page.reload();
  await expect(page.getByRole('button',{name:'Сохранить навсегда'})).toBeEnabled();
  expect((await saved(page)).arSignedTransaction).toBeUndefined();
  await set(page,'wanderLost','0');await signOnce(page);
  await expect(page.getByText('✓ Семейная история сохранена навсегда')).toBeVisible();
  expect((await saved(page)).saveId).toBe(before.saveId);expect(await count(page,'phantomCalls')).toBe(1);
});
