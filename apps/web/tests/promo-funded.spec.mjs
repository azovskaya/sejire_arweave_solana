import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mockAdminLock, adminPassword } from './admin-password.fixture.mjs';
const archive=JSON.stringify({schema:'sejire/envelope/v1',vault_id:'a'.repeat(32),cipher:'aes-gcm-256',kdf:'hkdf-sha256',iv:'AAAAAAAAAAAAAAAA',ciphertext:'A'.repeat(32),protocol:'sejire/v0.3'});
const tx='A'.repeat(43),initial='13000000000000';
const origin='http://127.0.0.1:5183';
const promo=page=>page.getByRole('region',{name:'Сохранение по промокоду',exact:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});

// Test only the real local UI. No request may reach an Arweave gateway,
// a production Worker, a Solana RPC, or an unmocked local API proxy.
test.beforeEach(async({context})=>{
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!==origin)return route.abort('blockedbyclient');
  if(url.pathname.startsWith('/api/'))return json(route,{error:'unmocked_test_api'},404);
  return route.continue();
 });
 await context.routeWebSocket('**/*',route=>{
  if(new URL(route.url()).origin==='ws://127.0.0.1:5183')route.connectToServer();
  else route.close({code:1008,reason:'External network disabled in this test'});
 });
});

async function openPromo(page,contents=archive,reload=false){
 if(reload)await page.reload();else await page.goto('/#/save');
 await page.getByLabel('Зашифрованный архив для промокода').setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from(contents)});
 await page.getByRole('button',{name:'Промокод',exact:true}).click();
 await expect(promo(page)).toBeVisible();
 return promo(page);
}

async function savePromo(page,code='TEST-PENSIONER'){
 await promo(page).getByLabel('Промокод',{exact:true}).fill(code);
 await promo(page).getByRole('button',{name:'Сохранить бесплатно',exact:true}).click();
}

function orderFrom(body,status='SUBMITTED'){
 const completed=status==='COMPLETED';
 const signed=!['RESERVED','FAILED','RELEASED'].includes(status);
 return {preservationId:body.preservationId,orderId:body.orderId,promoRevision:1,
  archiveSizeBytes:Buffer.byteLength(body.archive),archiveDigest:createHash('sha256').update(body.archive).digest('hex'),vaultId:JSON.parse(body.archive).vault_id,
  estimatedRewardWinston:'3000000000',reservedRewardWinston:'3000000000',actualRewardWinston:completed?'3000000000':null,
  arweaveTxId:signed?tx:null,status,createdAt:Date.now(),uploadedAt:signed?Date.now():null,verifiedAt:completed?Date.now():null};
}

function verification(stage,transactionConfirmed=false){
 return {stage,transactionConfirmed,confirmations:transactionConfirmed?20:0,reason:null,checkedAt:Date.now()};
}

async function mockPreservation(page,{status='SUBMITTED',losePostResponse=false,expectedArchive=archive}={}){
 const state={order:null,verification:undefined,posts:[],reads:[],validations:0,validationFailure:false,postRejection:null,readError:0,readGate:null,inFlight:0,maxInFlight:0};
 state.complete=()=>{
  state.order={...state.order,status:'COMPLETED',actualRewardWinston:'3000000000',verifiedAt:Date.now()};
  state.verification=verification('verified',true);
 };
 await page.route('**/api/fund/**',async route=>{
  const request=route.request(),url=new URL(request.url());
  expect(url.origin).toBe(origin);
  if(url.pathname==='/api/fund/validate'&&request.method()==='POST'){
   state.validations++;
   if(state.validationFailure)return route.abort('failed');
   return json(route,{accepted:true});
  }
  if(url.pathname==='/api/fund/orders'&&request.method()==='POST'){
   const body=request.postDataJSON();
   expect(Object.keys(body).sort()).toEqual(['archive','code','orderId','preservationId']);
   expect(body.orderId).toMatch(/^[a-f0-9]{32}$/);
   expect(body.preservationId).toBe(body.orderId);
   if(expectedArchive!==null)expect(body.archive).toBe(expectedArchive);
   else{
    expect(Object.keys(JSON.parse(body.archive)).sort()).toEqual(Object.keys(JSON.parse(archive)).sort());
    expect(JSON.stringify(body)).not.toMatch(/recoveryWords|seedPhrase|plaintextTree|familyName|Synthetic family|Child corrected/);
   }
   state.posts.push(body);
   if(state.postRejection)return json(route,{error:state.postRejection.error},state.postRejection.status);
   state.order=orderFrom(body,status);
   if(losePostResponse)return route.abort('failed');
   return json(route,{order:state.order},status==='COMPLETED'?200:202);
  }
  if(url.pathname.startsWith('/api/fund/orders/')&&request.method()==='GET'){
   const id=url.pathname.split('/').at(-1);
   state.reads.push(id);state.inFlight++;state.maxInFlight=Math.max(state.maxInFlight,state.inFlight);
   try{
    expect(id).toBe(state.order?.orderId);
    if(state.readGate)await state.readGate;
    if(state.readError)return await json(route,{error:state.readError===404?'order_not_found':'fund_unavailable'},state.readError);
    return await json(route,{order:state.order,...(state.verification?{verification:state.verification}:{})});
   }finally{state.inFlight--;}
  }
  return json(route,{error:'unexpected_fund_request'},404);
 });
 return state;
}

async function checkNow(page){
 await promo(page).getByRole('button',{name:'Проверить статус',exact:true}).click();
}

test('Admin changes one promo and cumulative limit; user preserves encrypted archive without Solana',async({page},testInfo)=>{
 await mockAdminLock(page);
 let code='',revision=0,enabled=false,limit=initial,spent=0n;
 const rows=[];
 const dashboard=()=>({promo:{enabled,displayHint:code?`${code.slice(0,4)}••••${code.slice(-2)}`:'',revision,createdAt:Date.now(),updatedAt:Date.now()},treasuryAddress:'qgoIFw9WsusMRapWzcFg4jNW08HSWvQkpAKOz86BUuI',signerVerified:true,
  limitWinston:limit,actualSpentWinston:spent.toString(),reservedWinston:'0',budgetRemainingWinston:(BigInt(limit)-spent).toString(),walletBalanceWinston:'68996561462544',lastBalanceCheck:Date.now(),
  currentQuoteWinston:'3000000000',currentQuoteBytes:rows.length?archive.length:6144,effectiveAvailableWinston:(BigInt(limit)-spent).toString(),estimatedTreesRemaining:rows.length?String((BigInt(limit)-spent)/3000000000n):null,
  fundStatus:'HEALTHY',successfulTrees:rows.length,today:rows.length,last7Days:rows.length,failedAttempts:0,pending:0,totalEncryptedBytes:rows.reduce((n,x)=>n+x.archiveSizeBytes,0),
  averageArchiveBytes:rows.length?archive.length:null,largestArchiveBytes:rows.length?archive.length:null,smallestArchiveBytes:rows.length?archive.length:null,
  averageActualWinston:rows.length?'3000000000':null,minActualWinston:rows.length?'3000000000':null,maxActualWinston:rows.length?'3000000000':null,latestActualWinston:rows.length?'3000000000':null,
  currentRevisionTrees:rows.filter(x=>x.promoRevision===revision).length,currentRevisionSpentWinston:String(BigInt(rows.filter(x=>x.promoRevision===revision).length)*3000000000n),lastReconciliation:null,history:rows});
 await page.route('**/api/fund/**',async route=>{const url=new URL(route.request().url()),path=url.pathname,method=route.request().method(),body=method==='POST'?route.request().postDataJSON():null;
  expect(url.origin).toBe(origin);
  let status=200,value={};
  if(path.startsWith('/api/fund/admin/')&&route.request().headers()['authorization']!==`Bearer ${adminPassword}`){status=401;value={error:'admin_unauthorized'};}
  else if(path.endsWith('/balance'))value={treasuryAddress:'qgoIFw9WsusMRapWzcFg4jNW08HSWvQkpAKOz86BUuI',walletBalanceWinston:'68996561462544',lastBalanceCheck:Date.now()};
  else if(path.endsWith('/dashboard'))value=dashboard();
  else if(path.endsWith('/promo')){code=body.code.trim().toUpperCase();revision++;enabled=true;value=dashboard();}
  else if(path.endsWith('/enabled')){enabled=body.enabled;value=dashboard();}
  else if(path.endsWith('/limit')){limit=String(BigInt(body.limitAr)*1000000000000n);value=dashboard();}
  else if(path.endsWith('/validate')){if(!enabled){status=409;value={error:'promo_disabled'};}else if(body.code.trim().toUpperCase()!==code){status=400;value={error:'promo_invalid'};}else value={accepted:true};}
  else if(path==='/api/fund/orders'&&method==='POST'){
   expect(Object.keys(body).sort()).toEqual(['archive','code','orderId','preservationId']);
   expect(Object.keys(JSON.parse(body.archive)).sort()).toEqual(Object.keys(JSON.parse(archive)).sort());
   expect(JSON.stringify(body)).not.toMatch(/recoveryWords|seedPhrase|plaintextTree|familyName/);
   const row={...orderFrom(body,'COMPLETED'),promoRevision:revision};rows.push(row);spent+=3000000000n;value={order:row};}
  else if(path.startsWith('/api/fund/orders/'))value={order:rows.find(x=>x.orderId===path.split('/').at(-1))};
  else {status=404;value={error:'not_found'};}
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('/#/admin');await page.getByLabel('Пароль',{exact:true}).fill(adminPassword);await page.getByRole('button',{name:'Войти'}).click();
 await page.getByRole('button',{name:'Free Preservation Fund'}).click();
 await page.getByLabel('Server admin credential').fill(adminPassword);await page.getByRole('button',{name:'Refresh balance and dashboard'}).click();
 await expect(page.getByText('13.000000 AR').first()).toBeVisible();
 await page.getByRole('button',{name:'Change promo code'}).click();await page.getByLabel('New promo code',{exact:true}).fill('TEST-PENSIONER');await page.getByLabel('Confirm new promo code').fill('TEST-PENSIONER');
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'SAVE NEW CODE'}).click();await expect(page.getByText('TEST••••ER')).toBeVisible();
 await openPromo(page);await savePromo(page);
 await expect(promo(page).getByRole('status')).toContainText('Семейная история сохранена');await expect(page.getByRole('button',{name:'Оплатить 0.03 SOL'})).toHaveCount(0);
 await openPromo(page,archive,true);
 await expect(promo(page).getByRole('status')).toContainText('Семейная история сохранена');expect(rows).toHaveLength(1);
 await page.goto('/#/admin');await page.getByLabel('Пароль',{exact:true}).fill(adminPassword);await page.getByRole('button',{name:'Войти'}).click();await page.getByRole('button',{name:'Free Preservation Fund'}).click();
 await page.getByLabel('Server admin credential').fill(adminPassword);await page.getByRole('button',{name:'Refresh balance and dashboard'}).click();
 await expect(page.getByText('Saved trees 1')).toBeVisible();
 await page.screenshot({path:testInfo.outputPath('promo-funded-admin.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:testInfo.outputPath('promo-funded-admin-mobile.png'),fullPage:true});
 await expect(page.getByText('0.003000 AR',{exact:false}).first()).toBeVisible();await expect(page.getByRole('link',{name:/AAAAAAA/})).toBeVisible();
 await page.getByRole('button',{name:'Change promo code'}).click();await page.getByLabel('New promo code',{exact:true}).fill('TEST-PENSIONER-2');await page.getByLabel('Confirm new promo code').fill('TEST-PENSIONER-2');
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'SAVE NEW CODE'}).click();
 await page.getByLabel('New cumulative limit (AR)').fill('26');await page.getByRole('button',{name:'UPDATE FUND LIMIT'}).click();
 await expect(page.getByText('26.000000 AR').first()).toBeVisible();await expect(page.getByText('Saved trees 1')).toBeVisible();
 const nextArchive=JSON.parse(archive);nextArchive.ciphertext='B'+nextArchive.ciphertext.slice(1);
 await openPromo(page,JSON.stringify(nextArchive));
 await savePromo(page);await expect(promo(page).getByRole('alert')).toContainText('Неверный промокод.');expect(rows).toHaveLength(1);
 await savePromo(page,'TEST-PENSIONER-2');await expect(promo(page).getByRole('status')).toContainText('Семейная история сохранена');expect(rows).toHaveLength(2);
});

test('Pending transaction explains confirmation and archive verification before showing success',async({page},testInfo)=>{
 const api=await mockPreservation(page);
 await page.clock.install();
 await openPromo(page);await savePromo(page);
 await expect(promo(page).getByRole('status')).toContainText('Ждём подтверждения Arweave');
 await expect(promo(page).getByRole('link',{name:/Arweave/})).toHaveAttribute('href',`https://arweave.net/${tx}`);
 await expect(promo(page).getByRole('button',{name:'Сохранить бесплатно',exact:true})).toHaveCount(0);
 await page.setViewportSize({width:390,height:844});
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath('promo-confirmation-mobile.png'),fullPage:true});

 api.order={...api.order,status:'VERIFYING'};api.verification=verification('checking_archive',true);
 await checkNow(page);
 await expect(promo(page).getByRole('status')).toContainText('Проверяем сохранённый архив');
 await expect(promo(page).getByRole('status')).not.toContainText('Семейная история сохранена');

 api.complete();await checkNow(page);
 await expect(promo(page).getByRole('status')).toContainText('Семейная история сохранена');
 await expect(promo(page).getByRole('status')).not.toContainText('Сохраняем');
 await page.screenshot({path:testInfo.outputPath('promo-completed-mobile.png'),fullPage:true});
 const reads=api.reads.length;await page.clock.runFor(20_000);
 expect(api.reads).toHaveLength(reads);expect(api.posts).toHaveLength(1);
});

test('Editor promo modal stays usable on mobile and Done returns to the tree with its confirmed archive',async({page},testInfo)=>{
 const api=await mockPreservation(page,{expectedArchive:null});
 await page.setViewportSize({width:390,height:844});await page.goto('/');
 // Generate synthetic words and family data inside this isolated page only.
 // The words never leave browser memory or appear in snapshots/test output.
 const encrypted=await page.evaluate(async()=>{
  window.promoEditorFixture=await(await import('/tests/browser-fixture.ts')).fixture();
  return window.promoEditorFixture.serialized;
 });
 await page.getByRole('button',{name:'Открыть по 12 словам',exact:true}).click();
 await page.getByRole('button',{name:'Открыть из файла',exact:true}).click();
 await page.locator('input[type=file]').setInputFiles({name:'synthetic-editor.json',mimeType:'application/json',buffer:Buffer.from(encrypted)});
 await page.getByRole('textbox',{name:'12 слов восстановления SEJIRE'}).evaluate(input=>{
  const setValue=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
  setValue.call(input,window.promoEditorFixture.words);
  input.dispatchEvent(new Event('input',{bubbles:true}));
 });
 await page.getByRole('button',{name:'Восстановить архив',exact:true}).click();
 await page.getByRole('button',{name:'Сохранить',exact:true}).first().click();
 const dialog=page.getByRole('dialog');
 await dialog.getByRole('button',{name:'Сохранить через Solana',exact:true}).click();
 await dialog.getByRole('button',{name:'Промокод',exact:true}).click();
 await savePromo(page);
 await expect(promo(page).getByRole('status')).toContainText('Ждём подтверждения Arweave');
 await expect(promo(page).getByRole('button',{name:'Проверить статус',exact:true})).toBeEnabled();
 await expect.poll(()=>dialog.locator('.modal').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 for(const button of await dialog.getByRole('button').all()){
  // The modal's 92dvh bound lands on a fractional pixel at this viewport.
  // Allow that rounding while also requiring a usable, unobstructed control.
  await button.scrollIntoViewIfNeeded();await expect(button).toBeInViewport({ratio:0.99});await button.click({trial:true});
 }
 await promo(page).getByRole('status').scrollIntoViewIfNeeded();
 await page.screenshot({path:testInfo.outputPath('promo-editor-waiting-mobile.png'),fullPage:true});
 api.complete();await checkNow(page);
 await expect(promo(page).getByRole('status')).toContainText('Семейная история сохранена');
 await expect.poll(()=>dialog.locator('.modal').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
 const done=promo(page).getByRole('button',{name:'Готово',exact:true});
 await done.scrollIntoViewIfNeeded();await expect(done).toBeInViewport({ratio:0.99});await done.click({trial:true});
 const link=promo(page).getByRole('link',{name:/Arweave/});
 await link.scrollIntoViewIfNeeded();await expect(link).toBeInViewport({ratio:0.99});await link.click({trial:true});
 await page.screenshot({path:testInfo.outputPath('promo-editor-completed-mobile.png'),fullPage:true});
 // A confirmed network save must stay visible if this browser cannot remember
 // its archive or head. Retrying Done only repairs that local bookkeeping.
 await page.evaluate(()=>{
  window.promoStorageFault={original:Storage.prototype.setItem,prefix:'sejire.vaultArchive.v1.',rejections:0};
  Storage.prototype.setItem=function(key,value){
   if(String(key).startsWith(window.promoStorageFault.prefix)){
    window.promoStorageFault.rejections++;
    throw new DOMException('Synthetic quota fault','QuotaExceededError');
   }
   return window.promoStorageFault.original.call(this,key,value);
  };
 });
 try{
  await done.click();
  await expect(dialog).toBeVisible();
  await expect(promo(page).getByRole('status')).toContainText('Семейная история сохранена');
  await expect(promo(page).getByRole('alert')).toContainText('обновить историю в этом браузере пока не удалось');
  await expect(promo(page).getByRole('alert')).toContainText('повторное сохранение не требуется');
  expect(await page.evaluate(()=>window.promoStorageFault.rejections)).toBeGreaterThan(0);
  expect(api.posts).toHaveLength(1);

  await page.evaluate(()=>{window.promoStorageFault.prefix='sejire.vaultSession.v1';window.promoStorageFault.rejections=0;});
  await done.click();
  await expect(dialog).toBeVisible();
  await expect(promo(page).getByRole('status')).toContainText('Семейная история сохранена');
  await expect(promo(page).getByRole('alert')).toContainText('обновить историю в этом браузере пока не удалось');
  expect(await page.evaluate(()=>window.promoStorageFault.rejections)).toBeGreaterThan(0);
  expect(await page.evaluate(async tx=>{
   const session=(await import('/src/lib/vaultSession/session.ts')).getVaultSession();
   const version=session&&(await import('/src/lib/vaultSession/localArchive.ts')).getLocalVaultVersion(session.vaultId,tx);
   return Boolean(version)&&session.headTxId!==tx;
  },tx)).toBe(true);
  expect(api.posts).toHaveLength(1);
 }finally{
  await page.evaluate(()=>{Storage.prototype.setItem=window.promoStorageFault.original;delete window.promoStorageFault;});
 }
 await done.click();await expect(dialog).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Сохранить',exact:true}).first()).toBeVisible();
 await expect(page.getByRole('button',{name:'Сохранить через Solana',exact:true})).toHaveCount(0);
 expect(api.posts).toHaveLength(1);expect(api.validations).toBe(1);
 const saved=await page.evaluate(async tx=>{
  const session=(await import('/src/lib/vaultSession/session.ts')).getVaultSession();
  const version=session&&(await import('/src/lib/vaultSession/localArchive.ts')).getLocalVaultVersion(session.vaultId,tx);
  return {headTxId:session?.headTxId,vaultId:session?.vaultId,source:version?.source,archive:version?JSON.stringify(version.envelope):null};
 },tx);
 expect(saved.headTxId).toBe(tx);expect(saved.vaultId).toBe(api.order.vaultId);expect(saved.source).toBe('network');
 expect(saved.archive).toBe(api.posts[0].archive);
});

for(const status of ['FAILED','RELEASED']){
 test(`${status} is an explicit unfinished result, not an endless saving indicator`,async({page})=>{
  const api=await mockPreservation(page,{status});
  await page.clock.install();
  await openPromo(page);await savePromo(page);
  await expect(promo(page).getByRole('status')).toContainText('Сохранение не завершено');
  await expect(promo(page).getByRole('status')).not.toContainText('Сохраняем');
  await page.clock.runFor(20_000);
  expect(api.posts).toHaveLength(1);expect(api.reads).toHaveLength(0);
  await promo(page).getByRole('button',{name:'Попробовать снова',exact:true}).click();
  await expect(promo(page).getByRole('button',{name:'Сохранить бесплатно',exact:true})).toBeVisible();
  expect(api.posts).toHaveLength(1);expect(api.reads).toHaveLength(0);
 });
}

test('An uncertain submission explains the check and preserves its existing transaction',async({page})=>{
 const api=await mockPreservation(page,{status:'NEEDS_RECONCILIATION'});
 await openPromo(page);await savePromo(page);
 await expect(promo(page).getByRole('status')).toContainText('Проверяем состояние сохранения');
 await expect(promo(page).getByRole('link',{name:/Arweave/})).toHaveAttribute('href',`https://arweave.net/${tx}`);
 await expect(promo(page).getByRole('button',{name:'Сохранить бесплатно',exact:true})).toHaveCount(0);
 const id=api.order.orderId;api.complete();await checkNow(page);
 await expect(promo(page).getByRole('status')).toContainText('Семейная история сохранена');
 expect(api.reads.length).toBeGreaterThan(0);expect(new Set(api.reads)).toEqual(new Set([id]));expect(api.posts).toHaveLength(1);
});

test('A failed status request is visible and a later automatic check recovers',async({page})=>{
 const api=await mockPreservation(page);
 await page.clock.install();
 await openPromo(page);await savePromo(page);
 await expect(promo(page).getByRole('status')).toContainText('Ждём подтверждения Arweave');
 api.readError=503;await checkNow(page);
 await expect(promo(page).getByRole('alert')).toContainText('Не удалось обновить статус');
 await expect(promo(page).getByRole('alert')).toContainText('автоматически');
 await expect(promo(page).getByRole('button',{name:'Сохранить бесплатно',exact:true})).toHaveCount(0);
 api.readError=0;api.complete();await page.clock.runFor(15_001);
 await expect(promo(page).getByRole('status')).toContainText('Семейная история сохранена');
 await expect(promo(page).getByRole('alert')).toHaveCount(0);
 expect(api.posts).toHaveLength(1);expect(new Set(api.reads)).toEqual(new Set([api.order.orderId]));
});

test('A lost POST response and reopening the same archive only read the original order',async({page})=>{
 const api=await mockPreservation(page,{losePostResponse:true});
 let releaseRead;api.readGate=new Promise(resolve=>{releaseRead=resolve;});
 try{
  await openPromo(page);await savePromo(page);
  await expect(promo(page).getByRole('status')).toContainText('Проверяем состояние сохранения');
  await expect.poll(()=>api.reads.length).toBe(1);
  await expect(promo(page).getByRole('button',{name:'Сохранить бесплатно',exact:true})).toHaveCount(0);
  expect(api.posts).toHaveLength(1);const id=api.posts[0].orderId;
  releaseRead();api.readGate=null;
  await expect(promo(page).getByRole('status')).toContainText('Ждём подтверждения Arweave');

  await openPromo(page,archive,true);
  await expect(promo(page).getByRole('status')).toContainText('Ждём подтверждения Arweave');
  expect(api.posts).toHaveLength(1);expect(api.validations).toBe(1);
  expect(api.reads.every(value=>value===id)).toBe(true);
  api.complete();await checkNow(page);
  await expect(promo(page).getByRole('status')).toContainText('Семейная история сохранена');
  expect(api.posts).toHaveLength(1);expect(new Set(api.reads)).toEqual(new Set([id]));
 }finally{releaseRead?.();}
});

test('A temporarily missing order after response loss never enables a replacement save',async({page})=>{
 const api=await mockPreservation(page,{losePostResponse:true});api.readError=404;
 await openPromo(page);await savePromo(page);
 await expect.poll(()=>api.reads.length).toBeGreaterThan(0);
 await expect(promo(page).getByRole('alert')).toBeVisible();
 await expect(promo(page).getByRole('button',{name:'Сохранить бесплатно',exact:true})).toHaveCount(0);
 const id=api.posts[0].orderId;
 await openPromo(page,archive,true);
 await expect(promo(page).getByRole('alert')).toBeVisible();
 await expect(promo(page).getByRole('button',{name:'Сохранить бесплатно',exact:true})).toHaveCount(0);
 api.readError=0;api.complete();await checkNow(page);
 await expect(promo(page).getByRole('status')).toContainText('Семейная история сохранена');
 expect(api.validations).toBe(1);expect(api.posts).toHaveLength(1);expect(new Set(api.reads)).toEqual(new Set([id]));
});

test('The old sessionStorage order resumes after upgrading without asking to save again',async({page})=>{
 const api=await mockPreservation(page),id='c'.repeat(32);
 api.order=orderFrom({orderId:id,preservationId:id,archive},'VERIFYING');
 const key=`sejire-funded:${createHash('sha256').update(archive).digest('hex')}`;
 await page.addInitScript(({key,id})=>sessionStorage.setItem(key,id),{key,id});
 await openPromo(page);
 await expect(promo(page).getByRole('status')).toContainText('Ждём подтверждения Arweave');
 await expect(promo(page).getByRole('button',{name:'Сохранить бесплатно',exact:true})).toHaveCount(0);
 api.complete();await checkNow(page);
 await expect(promo(page).getByRole('status')).toContainText('Семейная история сохранена');
 expect(api.validations).toBe(0);expect(api.posts).toHaveLength(0);expect(new Set(api.reads)).toEqual(new Set([id]));
});

for(const rejection of [{error:'fund_exhausted',status:409},{error:'fund_prepare_failed',status:503}]){
 test(`${rejection.error} before reservation offers an explicit retry of the same request`,async({page})=>{
  const api=await mockPreservation(page,{status:'COMPLETED'});api.postRejection=rejection;
  await page.clock.install();await openPromo(page);await savePromo(page);
  await expect(promo(page).getByRole('heading',{name:'Сохранение не началось',exact:true})).toBeVisible();
  await expect(promo(page).getByRole('alert')).toBeVisible();
  await expect(promo(page).getByRole('button',{name:'Сохранить бесплатно',exact:true})).toBeEnabled();
  await expect(promo(page).getByRole('button',{name:'Проверить статус',exact:true})).toHaveCount(0);
  await page.clock.runFor(20_000);
  expect(api.posts).toHaveLength(1);expect(api.reads).toHaveLength(0);
  const id=api.posts[0].orderId;

  await openPromo(page,archive,true);
  await expect(promo(page).getByRole('heading',{name:'Сохранение не началось',exact:true})).toBeVisible();
  await page.clock.runFor(20_000);
  expect(api.posts).toHaveLength(1);expect(api.reads).toHaveLength(0);expect(api.validations).toBe(1);

  api.postRejection=null;await savePromo(page);
  await expect(promo(page).getByRole('status')).toContainText('Семейная история сохранена');
  expect(api.posts).toHaveLength(2);expect(api.posts[1].orderId).toBe(id);expect(api.validations).toBe(2);
 });
}

test('Preflight network failure keeps the form and does not promise nonexistent automatic tracking',async({page})=>{
 const api=await mockPreservation(page,{status:'COMPLETED'});api.validationFailure=true;
 await page.clock.install();await openPromo(page);await savePromo(page);
 await expect(promo(page).getByRole('alert')).toContainText('Не удалось проверить промокод');
 await expect(promo(page).getByRole('alert')).not.toContainText('автоматически');
 await expect(promo(page).getByRole('button',{name:'Сохранить бесплатно',exact:true})).toBeEnabled();
 await expect(promo(page).getByRole('button',{name:'Проверить статус',exact:true})).toHaveCount(0);
 await page.clock.runFor(20_000);
 expect(api.posts).toHaveLength(0);expect(api.reads).toHaveLength(0);expect(api.validations).toBe(1);
 const key=`sejire-funded:${createHash('sha256').update(archive).digest('hex')}`;
 expect(await page.evaluate(key=>sessionStorage.getItem(key),key)).toBeNull();
 api.validationFailure=false;await savePromo(page);
 await expect(promo(page).getByRole('status')).toContainText('Семейная история сохранена');
 expect(api.posts).toHaveLength(1);expect(api.validations).toBe(2);
});

test('Polling waits for a slow request to finish and cannot overlap a manual check',async({page})=>{
 const api=await mockPreservation(page);
 await page.clock.install();
 await openPromo(page);await savePromo(page);
 await expect(promo(page).getByRole('status')).toContainText('Ждём подтверждения Arweave');
 await expect(promo(page).getByRole('button',{name:'Проверить статус',exact:true})).toBeEnabled();
 const initialReads=api.reads.length;
 let releaseRead;api.readGate=new Promise(resolve=>{releaseRead=resolve;});
 try{
  await checkNow(page);await expect.poll(()=>api.reads.length).toBe(initialReads+1);
  await expect(promo(page).getByRole('button',{name:'Проверяем…',exact:true})).toBeDisabled();
  await page.clock.runFor(19_000);
  expect(api.reads).toHaveLength(initialReads+1);expect(api.maxInFlight).toBe(1);
  releaseRead();api.readGate=null;
  await expect(promo(page).getByRole('button',{name:'Проверить статус',exact:true})).toBeEnabled();
  await page.clock.runFor(6_001);await expect.poll(()=>api.reads.length).toBe(initialReads+2);
  expect(api.maxInFlight).toBe(1);expect(api.posts).toHaveLength(1);
 }finally{releaseRead?.();}
});
