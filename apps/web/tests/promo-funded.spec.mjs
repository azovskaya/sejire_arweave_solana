import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mockAdminLock, adminPassword } from './admin-password.fixture.mjs';
const archive=JSON.stringify({schema:'sejire/envelope/v1',vault_id:'a'.repeat(32),cipher:'aes-gcm-256',kdf:'hkdf-sha256',iv:'AAAAAAAAAAAAAAAA',ciphertext:'A'.repeat(32),protocol:'sejire/v0.3'});
const tx='A'.repeat(43),initial='13000000000000';
const origin='http://127.0.0.1:5183';
const promo=page=>page.getByRole('region',{name:'Сохранение по промокоду',exact:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
const networkGuards=new WeakMap();

// Test only the real local UI. No request may reach an Arweave gateway,
// a production Worker, a Solana RPC, or an unmocked local API proxy.
test.beforeEach(async({context})=>{
 const blocked={http:0,websocket:0,api:0};networkGuards.set(context,blocked);
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!==origin){blocked.http++;return route.abort('blockedbyclient');}
  if(url.pathname.startsWith('/api/')){blocked.api++;return json(route,{error:'unmocked_test_api'},404);}
  return route.continue();
 });
 await context.routeWebSocket('**/*',route=>{
  if(new URL(route.url()).origin==='ws://127.0.0.1:5183')route.connectToServer();
  else{blocked.websocket++;route.close({code:1008,reason:'External network disabled in this test'});}
 });
});

async function openPromo(page,contents=archive,reload=false){
 if(reload)await page.reload();else await page.goto('/#/save');
 await page.getByLabel('Зашифрованный архив для промокода').setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from(contents)});
 await page.getByRole('button',{name:'По промокоду',exact:true}).click();
 await expect(promo(page)).toBeVisible();
 return promo(page);
}

async function savePromo(page,code='TEST-PENSIONER'){
 await promo(page).getByLabel('Промокод',{exact:true}).fill(code);
 await promo(page).getByRole('button',{name:'Сохранить бесплатно',exact:true}).click();
}

async function openEditor(page){
 await page.goto('/');
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
 await expect(page.getByRole('button',{name:'Сохранить',exact:true}).first()).toBeVisible();
}

async function openEditorPromo(page){
 await page.getByRole('button',{name:'Сохранить',exact:true}).first().click();
 await page.getByRole('dialog').getByRole('button',{name:'По промокоду',exact:true}).click();
 await expect(promo(page)).toBeVisible();
}

async function openNewEditor(page){
 await page.goto('/');
 expect(await page.evaluate(async()=>({
  draft:(await import('/src/lib/draftStorage.ts')).loadDraftTree(),
  session:(await import('/src/lib/vaultSession/session.ts')).getVaultSession(),
 }))).toEqual({draft:null,session:null});
 await page.getByRole('button',{name:'Создать моё древо',exact:true}).click();
 await page.getByRole('button',{name:'Добавить себя',exact:true}).click();
 await page.getByRole('dialog').getByLabel('Имя',{exact:true}).fill('Synthetic new member');
 await page.getByRole('dialog').getByRole('button',{name:'Добавить',exact:true}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.locator('.person-card').filter({hasText:'Synthetic new member'})).toBeVisible();
}

async function confirmNewWords(page){
 const dialog=page.getByRole('dialog');
 await dialog.getByRole('button',{name:'Создать 12 слов',exact:true}).click();
 await expect(dialog.locator('.seed-grid li')).toHaveCount(12);
 // Read and repeat only the phrase that this isolated UI just generated. It
 // stays in page memory; screenshots are taken after the seed grid is gone.
 await dialog.locator('.seed-grid').evaluate(grid=>{
  window.promoNewWords=[...grid.querySelectorAll('li')].map(item=>item.textContent.replace(/^\d+\.\s*/, '').trim()).join(' ');
 });
 await dialog.getByRole('button',{name:'Я записал(а)',exact:true}).click();
 await dialog.getByRole('textbox').evaluate(input=>{
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,window.promoNewWords);
  input.dispatchEvent(new Event('input',{bubbles:true}));
 });
 await dialog.getByRole('button',{name:'Далее',exact:true}).click();
 await expect(dialog.locator('.seed-grid')).toHaveCount(0);
 await expect(dialog.getByRole('textbox')).toHaveCount(0);
}

async function expectNativeMethods(container){
 await expect(container.getByRole('button',{name:/^(По промокоду|Через Solana)$/})).toHaveText(['По промокоду','Через Solana']);
 await expect(container.getByRole('button',{name:/за свой AR|казн|[Дд]емо|Касси|Kaspi|децентрализованную сеть|Новая версия в сеть|Навсегда · оплата|Сохранить через Solana/})).toHaveCount(0);
 await expect(container.getByText(/На адресе из ваших 12 слов нет AR|Адрес из 12 слов:|Сеть оплачивает казна|включён демо-режим/)).toHaveCount(0);
}

async function enableSyntheticLegacySettings(page){
 expect(await page.evaluate(async()=>{
  const ops=await import('/src/lib/opsDesk/store.ts');
  await ops.activateOpsPassword('synthetic-browser-password');
  // Deliberately unusable fixture key: enough to activate the old UI flag,
  // incapable of signing a transaction. No admin screen or real secret is used.
  await ops.applyOpsKeyPatch({turboJwk:JSON.stringify({kty:'RSA',n:'synthetic-not-a-key',d:'synthetic-not-a-key'}),hotAddress:'Z'.repeat(43),paymentProvider:'kaspi',publishPriceMinor:'777',publishCurrency:'KZT',kaspiApiBase:'https://legacy-payments.invalid'});
  return {treasury:ops.isTreasuryPublishEnabled(),provider:ops.getOpsSettings().paymentProvider};
 })).toEqual({treasury:true,provider:'kaspi'});
}

async function mockReadOnlyDiscoveryAndRejectWallets(page){
 await page.addInitScript(()=>{
  window.promoWalletCalls=0;
  const forbidden=async()=>{window.promoWalletCalls++;throw Error('Unexpected wallet call in promo UI test');};
  window.phantom={solana:{connect:forbidden,signMessage:forbidden,signTransaction:forbidden,signAndSendTransaction:forbidden}};
  window.arweaveWallet={connect:forbidden,sign:forbidden,dispatch:forbidden};
 });
 await page.route('**/graphql',async route=>{
  expect(route.request().method()).toBe('POST');
  return json(route,{data:{transactions:{edges:[],pageInfo:{hasNextPage:false}}}});
 });
}

async function rememberExpectedTrees(page){
 return page.evaluate(async()=>{
  const current=(await import('/src/lib/draftStorage.ts')).loadDraftTree();
  window.promoExpectedTrees={...(window.promoEditorFixture?.vault.trees??{}),[current.meta.id]:current};
  return Object.keys(window.promoExpectedTrees).length;
 });
}

async function expectCompleteEditorVault(page,api,treeCount){
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.getByText(/^Сохранено в Arweave /)).toBeVisible();
 expect(api.posts).toHaveLength(1);expect(api.validations).toBe(1);
 expect(await page.evaluate(async serialized=>{
  const session=(await import('/src/lib/vaultSession/session.ts'));
  const keys=(await import('/src/lib/crypto/keys.ts')).deriveKeysFromMnemonic(session.getSessionMnemonic());
  const vault=await(await import('/src/lib/crypto/vault.ts')).openEnvelope(keys,JSON.parse(serialized));
  const current=(await import('/src/lib/draftStorage.ts')).loadDraftTree();
  return {allTreesMatch:JSON.stringify(vault.trees)===JSON.stringify(window.promoExpectedTrees),
   count:Object.keys(vault.trees).length,activeTreeMatches:vault.active_tree_id===current.meta.id,
   wordsInRequest:serialized.includes(session.getSessionMnemonic())};
 },api.posts[0].archive)).toEqual({allTreesMatch:true,count:treeCount,activeTreeMatches:true,wordsInRequest:false});
 const saved=await savedEditorArchive(page,tx);
 expect(saved.headTxId).toBe(tx);expect(saved.archive).toBe(api.posts[0].archive);expect(saved.source).toBe('network');
 expect(await activeFundAttempts(page)).toHaveLength(0);
}

async function expectNoPaymentSideEffects(page){
 expect(networkGuards.get(page.context())).toEqual({http:0,websocket:0,api:0});
 expect(await page.evaluate(()=>window.promoWalletCalls)).toBe(0);
}

async function editChildName(page,name){
 await page.locator('.person-card').filter({hasText:'Child corrected'}).click();
 await page.getByRole('dialog',{name:'Профиль: Child corrected',exact:true}).getByLabel('Имя',{exact:true}).fill(name);
 // Let the editor's ordinary debounce and focus scroll settle before closing.
 await page.clock.runFor(400);
 await expect.poll(()=>page.evaluate(async name=>(await import('/src/lib/draftStorage.ts')).loadDraftTree()?.draft.persons.child?.name===name,name)).toBe(true);
 await page.getByRole('dialog',{name:`Профиль: ${name}`,exact:true}).getByRole('button',{name:'Закрыть',exact:true}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function editorDraftRevision(page){
 return page.evaluate(async()=>{
  const draft=(await import('/src/lib/draftStorage.ts')).loadDraftTree();
  return {head:draft?.meta.head,nextVersion:draft?.meta.next_version,dirty:draft?.dirty};
 });
}

async function savedEditorArchive(page,transactionId){
 return page.evaluate(async tx=>{
  const session=(await import('/src/lib/vaultSession/session.ts')).getVaultSession();
  const version=session&&(await import('/src/lib/vaultSession/localArchive.ts')).getLocalVaultVersion(session.vaultId,tx);
  return {headTxId:session?.headTxId,vaultId:session?.vaultId,source:version?.source,parentId:version?.parentId,archive:version?JSON.stringify(version.envelope):null};
 },transactionId);
}

function requireDurableEditorAttempt(page,api){
 api.beforePost=async body=>{
  const stored=await page.evaluate(async orderId=>{
   const raw=localStorage.getItem(`sejire.fundAttempt.v1.${orderId}`);
   const session=await import('/src/lib/vaultSession/session.ts');
   const words=session.getSessionMnemonic()??window.promoNewWords??window.promoEditorFixture?.words;
   return {record:raw?JSON.parse(raw):null,
    treeId:(await import('/src/lib/draftStorage.ts')).loadDraftTree()?.meta.id,
    parentTxId:session.getVaultSession()?.headTxId??null,
    containsWords:Boolean(raw&&words&&raw.includes(words))};
  },body.orderId);
  expect(stored.record).not.toBeNull();
  expect(Object.keys(stored.record).sort()).toEqual(['version','orderId','envelope','archiveDigest','vaultId','parentTxId','treeId','createdAt'].sort());
  expect(stored.record.version).toBe(1);expect(stored.record.orderId).toBe(body.orderId);
  expect(JSON.stringify(stored.record.envelope)).toBe(body.archive);
  expect(stored.record.archiveDigest).toBe(createHash('sha256').update(body.archive).digest('hex'));
  expect(stored.record.vaultId).toBe(JSON.parse(body.archive).vault_id);
  expect(stored.record.treeId).toBe(stored.treeId);expect(stored.record.parentTxId).toBe(stored.parentTxId);
  expect(stored.containsWords).toBe(false);expect(JSON.stringify(stored.record)).not.toContain(body.code);
 };
}

async function activeFundAttempts(page){
 return page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('sejire.fundAttempt.v1.')).map(key=>JSON.parse(localStorage.getItem(key))));
}

async function reopenEditorSave(page){
 await page.getByRole('button',{name:'Продолжить сохранение',exact:true}).click();
 await expect(promo(page)).toBeVisible();
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
 const state={order:null,verification:undefined,posts:[],reads:[],validations:0,validationFailure:false,postRejection:null,readError:0,readGate:null,inFlight:0,maxInFlight:0,nextStatus:status,nextTx:tx,beforePost:null};
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
   if(state.beforePost)await state.beforePost(body);
   state.posts.push(body);
   if(state.postRejection)return json(route,{error:state.postRejection.error},state.postRejection.status);
   state.order=orderFrom(body,state.nextStatus);
   if(state.order.arweaveTxId)state.order.arweaveTxId=state.nextTx;
   if(losePostResponse)return route.abort('failed');
   return json(route,{order:state.order},state.nextStatus==='COMPLETED'?200:202);
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

async function openTransactionDetails(page){
 const details=promo(page).locator('details');
 await details.getByText('Данные сохранения',{exact:true}).click();
 const link=details.getByRole('link',{name:'Данные транзакции Arweave ↗',exact:true});
 await expect(link).toBeVisible();
 await expect(link).toHaveAttribute('href',`https://arweave.net/tx/${tx}`);
 return link;
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
 await expect(promo(page).locator('details a')).toBeHidden();
 await expect(promo(page).getByRole('button',{name:'Сохранить бесплатно',exact:true})).toHaveCount(0);
 await page.setViewportSize({width:390,height:844});
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath('promo-confirmation-mobile.png'),fullPage:true});
 await openTransactionDetails(page);
 await promo(page).getByText('Данные сохранения',{exact:true}).click();

 api.order={...api.order,createdAt:Date.now()-120_000};await checkNow(page);
 await expect(promo(page).locator('.funded-delay')).toContainText('Подтверждение занимает время');

 api.order={...api.order,status:'VERIFYING'};api.verification=verification('checking_archive',true);
 await checkNow(page);
 await expect(promo(page).getByRole('status')).toContainText('Проверяем сохранённый архив');
 await expect(promo(page).getByRole('status')).not.toContainText('Семейная история сохранена');
 await expect(promo(page).locator('.funded-delay')).toContainText('Проверка архива занимает время');
 await expect(promo(page)).not.toContainText('Подтверждение занимает время');

 api.complete();await checkNow(page);
 await expect(promo(page).getByRole('status')).toContainText('Семейная история сохранена');
 await expect(promo(page).getByRole('status')).not.toContainText('Сохраняем');
 await page.screenshot({path:testInfo.outputPath('promo-completed-mobile.png'),fullPage:true});
 const reads=api.reads.length;await page.clock.runFor(20_000);
 expect(api.reads).toHaveLength(reads);expect(api.posts).toHaveLength(1);
});

test('A genuinely new tree confirms its words and saves directly by promo with only two network choices',async({page},testInfo)=>{
 await mockReadOnlyDiscoveryAndRejectWallets(page);
 const api=await mockPreservation(page,{expectedArchive:null,status:'COMPLETED'});requireDurableEditorAttempt(page,api);
 await page.clock.install();await page.setViewportSize({width:390,height:844});
 await openNewEditor(page);await enableSyntheticLegacySettings(page);
 await page.getByRole('button',{name:'Сохранить',exact:true}).first().click();
 await confirmNewWords(page);
 const dialog=page.getByRole('dialog');
 await expectNativeMethods(dialog);
 await expect(dialog.getByRole('button',{name:'12 слов · JSON',exact:true})).toBeEnabled();
 expect(await rememberExpectedTrees(page)).toBe(1);
 expect(api.validations).toBe(0);expect(api.posts).toHaveLength(0);
 await expect.poll(()=>dialog.locator('.modal').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath('new-tree-native-choices-mobile.png'),fullPage:true});
 await dialog.getByRole('button',{name:'По промокоду',exact:true}).click();
 await expect(promo(page).getByLabel('Промокод',{exact:true})).toBeVisible();
 await expect(dialog.getByRole('button',{name:'Через Solana',exact:true})).toHaveCount(0);
 expect(api.posts).toHaveLength(0);
 await savePromo(page);await expectCompleteEditorVault(page,api,1);
 await page.clock.runFor(20_000);expect(api.posts).toHaveLength(1);
 await expectNoPaymentSideEffects(page);
});

test('Existing vault offers direct native choices despite legacy settings and Solana stays unavailable without payment',async({page},testInfo)=>{
 await mockReadOnlyDiscoveryAndRejectWallets(page);
 const api=await mockPreservation(page,{expectedArchive:null,status:'COMPLETED'});requireDurableEditorAttempt(page,api);
 await page.clock.install();await page.setViewportSize({width:390,height:844});
 await openEditor(page);await enableSyntheticLegacySettings(page);
 await page.getByRole('button',{name:'Сохранить',exact:true}).first().click();
 const dialog=page.getByRole('dialog');
 await expectNativeMethods(dialog);
 expect(await rememberExpectedTrees(page)).toBe(2);
 await dialog.getByRole('button',{name:'Через Solana',exact:true}).click();
 const solana=dialog.getByRole('region',{name:'Оплата SOL',exact:true});
 await expect(solana.getByRole('heading',{name:'Через Solana',exact:true})).toBeVisible();
 await expect(solana).toContainText('Оплата через Solana пока недоступна. Вы можете сохранить дерево по промокоду.');
 await expect(solana.getByRole('button',{name:/Оплатить|Phantom|Wander/})).toHaveCount(0);
 await expect(promo(page)).toHaveCount(0);
 const sealed=await page.evaluate(()=>JSON.stringify(JSON.parse(localStorage.getItem(`sejire.envelope.${window.promoEditorFixture.envelope.vault_id}`))));
 await page.clock.runFor(20_000);
 expect(api.posts).toHaveLength(0);expect(api.validations).toBe(0);expect(api.reads).toHaveLength(0);
 await expectNoPaymentSideEffects(page);
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath('native-solana-unavailable-mobile.png'),fullPage:true});
 await solana.getByRole('button',{name:'Назад',exact:true}).click();
 await expectNativeMethods(dialog);
 await dialog.getByRole('button',{name:'По промокоду',exact:true}).click();
 await savePromo(page);await expectCompleteEditorVault(page,api,2);
 expect(api.posts[0].archive).toBe(sealed);
 await expectNoPaymentSideEffects(page);
});

test('Existing words continue to the same two methods and promo preserves every tree in that vault',async({page})=>{
 await mockReadOnlyDiscoveryAndRejectWallets(page);
 const api=await mockPreservation(page,{expectedArchive:null,status:'COMPLETED'});requireDurableEditorAttempt(page,api);
 await page.clock.install();await openNewEditor(page);await enableSyntheticLegacySettings(page);
 // Two encrypted prior trees plus a genuinely new editor tree. This fixture
 // does not set a session key, so the real existing-words form is required.
 await page.evaluate(async()=>{window.promoEditorFixture=await(await import('/tests/browser-fixture.ts')).fixture();});
 await page.getByRole('button',{name:'Сохранить',exact:true}).first().click();
 const dialog=page.getByRole('dialog');
 await dialog.getByRole('button',{name:'У меня уже есть слова (новая версия)',exact:true}).click();
 await dialog.getByRole('textbox').evaluate(input=>{
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,window.promoEditorFixture.words);
  input.dispatchEvent(new Event('input',{bubbles:true}));
 });
 expect(await rememberExpectedTrees(page)).toBe(3);
 await dialog.getByRole('button',{name:'Продолжить',exact:true}).click();
 await expectNativeMethods(dialog);
 await expect(dialog.getByRole('textbox')).toHaveCount(0);
 expect(api.posts).toHaveLength(0);expect(api.validations).toBe(0);
 await dialog.getByRole('button',{name:'По промокоду',exact:true}).click();
 await savePromo(page);await expectCompleteEditorVault(page,api,3);
 await page.clock.runFor(20_000);expect(api.posts).toHaveLength(1);
 await expectNoPaymentSideEffects(page);
});

test('Editor completion is automatic and local storage failures only retry local completion on mobile',async({page},testInfo)=>{
 const api=await mockPreservation(page,{expectedArchive:null});
 requireDurableEditorAttempt(page,api);
 await page.clock.install();
 await page.setViewportSize({width:390,height:844});await openEditor(page);await openEditorPromo(page);
 const dialog=page.getByRole('dialog');
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
 // A confirmed network save must stay visible if this browser cannot remember
 // its archive/head or remove the active attempt. Retry only repairs local state.
 await page.evaluate(()=>{
  window.promoStorageFault={original:Storage.prototype.setItem,remove:Storage.prototype.removeItem,prefix:'sejire.vaultArchive.v1.',clear:false,rejections:0};
  Storage.prototype.setItem=function(key,value){
   if(window.promoStorageFault.prefix&&String(key).startsWith(window.promoStorageFault.prefix)){
    window.promoStorageFault.rejections++;
    throw new DOMException('Synthetic quota fault','QuotaExceededError');
   }
   return window.promoStorageFault.original.call(this,key,value);
  };
  Storage.prototype.removeItem=function(key){
   if(window.promoStorageFault.clear&&String(key).startsWith('sejire.fundAttempt.v1.')){
    window.promoStorageFault.rejections++;
    throw new DOMException('Synthetic storage fault','SecurityError');
   }
   return window.promoStorageFault.remove.call(this,key);
  };
 });
 const retry=promo(page).getByRole('button',{name:'Повторить завершение',exact:true});
 let readsAfterConfirmation;
 try{
  api.complete();await checkNow(page);
  await expect(dialog).toBeVisible();
  await expect(promo(page).getByRole('status')).toContainText('Семейная история сохранена');
  await expect(promo(page).getByRole('alert')).toContainText('обновить историю в этом браузере пока не удалось');
  await expect(promo(page).getByRole('alert')).toContainText('без нового сохранения и списания');
  await expect.poll(()=>page.evaluate(()=>window.promoStorageFault.rejections)).toBeGreaterThan(0);
  await expect(promo(page).getByRole('button',{name:'Готово',exact:true})).toHaveCount(0);
  await expect.poll(()=>dialog.locator('.modal').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await retry.scrollIntoViewIfNeeded();await expect(retry).toBeInViewport({ratio:0.99});await retry.click({trial:true});
  const link=await openTransactionDetails(page);
  await link.scrollIntoViewIfNeeded();await expect(link).toBeInViewport({ratio:0.99});await link.click({trial:true});
  await page.screenshot({path:testInfo.outputPath('promo-editor-local-retry-mobile.png'),fullPage:true});
  readsAfterConfirmation=api.reads.length;
  const failedWrites=await page.evaluate(()=>window.promoStorageFault.rejections);
  await page.clock.runFor(20_000);
  expect(await page.evaluate(()=>window.promoStorageFault.rejections)).toBe(failedWrites);
  expect(api.posts).toHaveLength(1);

  await page.evaluate(()=>{window.promoStorageFault.prefix='sejire.vaultSession.v1';window.promoStorageFault.rejections=0;});
  await retry.click();
  await expect(dialog).toBeVisible();
  await expect(promo(page).getByRole('status')).toContainText('Семейная история сохранена');
  await expect(promo(page).getByRole('alert')).toContainText('обновить историю в этом браузере пока не удалось');
  await expect.poll(()=>page.evaluate(()=>window.promoStorageFault.rejections)).toBeGreaterThan(0);
  expect(await page.evaluate(async tx=>{
   const session=(await import('/src/lib/vaultSession/session.ts')).getVaultSession();
   const version=session&&(await import('/src/lib/vaultSession/localArchive.ts')).getLocalVaultVersion(session.vaultId,tx);
   return Boolean(version)&&session.headTxId!==tx;
  },tx)).toBe(true);
  expect(api.posts).toHaveLength(1);

  await page.evaluate(()=>{window.promoStorageFault.prefix=null;window.promoStorageFault.clear=true;window.promoStorageFault.rejections=0;});
  await retry.click();
  await expect.poll(()=>page.evaluate(()=>window.promoStorageFault.rejections)).toBeGreaterThan(0);
  await expect(dialog).toBeVisible();
  await expect(promo(page).getByRole('status')).toContainText('Семейная история сохранена');
  await expect(promo(page).getByRole('alert')).toBeVisible();
  expect(await activeFundAttempts(page)).toHaveLength(1);
  expect(api.posts).toHaveLength(1);expect(api.reads).toHaveLength(readsAfterConfirmation);
 }finally{
  await page.evaluate(()=>{Storage.prototype.setItem=window.promoStorageFault.original;Storage.prototype.removeItem=window.promoStorageFault.remove;delete window.promoStorageFault;});
 }
 await retry.click();await expect(dialog).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Сохранить бесплатно',exact:true}).first()).toBeVisible();
 await expect(page.getByRole('button',{name:'Через Solana',exact:true})).toHaveCount(0);
 expect(api.posts).toHaveLength(1);expect(api.validations).toBe(1);
 const saved=await savedEditorArchive(page,tx);
 expect(saved.headTxId).toBe(tx);expect(saved.vaultId).toBe(api.order.vaultId);expect(saved.source).toBe('network');
 expect(saved.archive).toBe(api.posts[0].archive);
 expect(await activeFundAttempts(page)).toHaveLength(0);expect(api.reads).toHaveLength(readsAfterConfirmation);
});

test('Closing and reopening the actual editor resumes the exact pending archive without a successor',async({page})=>{
 const api=await mockPreservation(page,{expectedArchive:null});requireDurableEditorAttempt(page,api);
 await page.clock.install();await openEditor(page);await openEditorPromo(page);await savePromo(page);
 await expect(promo(page).getByRole('status')).toContainText('Ждём подтверждения Arweave');
 const original=api.posts[0],attempts=await activeFundAttempts(page);
 expect(attempts).toHaveLength(1);
 await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
 await editChildName(page,'Child awaiting save');
 const draftBeforeResume=await editorDraftRevision(page);
 expect(draftBeforeResume.dirty).toBe(true);
 await reopenEditorSave(page);
 await expect(promo(page).getByRole('status')).toContainText('Ждём подтверждения Arweave');
 await expect(promo(page).getByRole('button',{name:'Сохранить бесплатно',exact:true})).toHaveCount(0);
 await page.clock.runFor(20_000);
 expect(api.posts).toHaveLength(1);expect(api.validations).toBe(1);
 expect(new Set(api.reads)).toEqual(new Set([original.orderId]));
 expect(await activeFundAttempts(page)).toEqual(attempts);
 expect(await editorDraftRevision(page)).toEqual(draftBeforeResume);
 api.complete();await page.clock.runFor(6001);
 await expect(page.getByRole('dialog')).toHaveCount(0);
 const saved=await savedEditorArchive(page,tx);
 expect(saved.headTxId).toBe(tx);expect(saved.archive).toBe(original.archive);
 expect(await editorDraftRevision(page)).toEqual(draftBeforeResume);
 await page.clock.runFor(20_000);
 expect(api.posts).toHaveLength(1);expect(await activeFundAttempts(page)).toHaveLength(0);
});

test('Reloading the editor without session words or metadata recovers the pending attempt by tree',async({page})=>{
 const api=await mockPreservation(page,{expectedArchive:null});requireDurableEditorAttempt(page,api);
 await page.clock.install();await openEditor(page);await openEditorPromo(page);await savePromo(page);
 await expect(promo(page).getByRole('status')).toContainText('Ждём подтверждения Arweave');
 const original=api.posts[0],attempts=await activeFundAttempts(page);
 expect(await page.evaluate(()=>{
  const words=window.promoEditorFixture.words;
  return [localStorage,sessionStorage].some(storage=>Object.keys(storage).some(key=>String(storage.getItem(key)).includes(words)));
 })).toBe(false);
 // Keep the nonsecret navigation marker so this is an editor reload. Remove
 // vault metadata and every old digest map: recovery must use the durable tree.
 expect(await page.evaluate(()=>{
  const lastScreen=sessionStorage.getItem('sejire.lastScreen');
  sessionStorage.clear();if(lastScreen)sessionStorage.setItem('sejire.lastScreen',lastScreen);
  return Object.keys(sessionStorage).filter(key=>key!=='sejire.lastScreen').length;
 })).toBe(0);
 await page.reload();
 expect(await page.evaluate(async()=>({
  words:(await import('/src/lib/vaultSession/session.ts')).getSessionMnemonic(),
  fixturePresent:Boolean(window.promoEditorFixture),
 }))).toEqual({words:null,fixturePresent:false});
 // Reload opens only the existing attempt; no click authorizes a successor.
 await expect(promo(page)).toBeVisible();
 await expect(promo(page).getByRole('status')).toContainText('Ждём подтверждения Arweave');
 await expect(page.getByRole('textbox')).toHaveCount(0);
 expect(api.posts).toHaveLength(1);expect(api.validations).toBe(1);
 expect(await activeFundAttempts(page)).toEqual(attempts);
 api.complete();await page.clock.runFor(6001);
 await expect(page.getByRole('dialog')).toHaveCount(0);
 const saved=await savedEditorArchive(page,tx);
 expect(saved.headTxId).toBe(tx);expect(saved.vaultId).toBe(api.order.vaultId);expect(saved.archive).toBe(original.archive);
 expect(await page.evaluate(async()=>(await import('/src/lib/vaultSession/session.ts')).getSessionMnemonic())).toBeNull();
 expect(new Set(api.reads)).toEqual(new Set([original.orderId]));
 await page.clock.runFor(20_000);
 expect(api.posts).toHaveLength(1);expect(await activeFundAttempts(page)).toHaveLength(0);
});

test('A confirmed editor save finishes automatically and the next edited version needs one explicit free-save click',async({page},testInfo)=>{
 const api=await mockPreservation(page,{expectedArchive:null,status:'COMPLETED'});requireDurableEditorAttempt(page,api);
 await page.clock.install();await page.setViewportSize({width:390,height:844});
 await openEditor(page);await openEditorPromo(page);await savePromo(page);
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.getByText(/^Сохранено в Arweave /)).toBeVisible();
 await expect(page.getByRole('button',{name:'Готово',exact:true})).toHaveCount(0);
 const freeSave=page.getByRole('button',{name:'Сохранить бесплатно',exact:true});
 await expect(freeSave).toBeEnabled();
 const first=api.posts[0],firstSaved=await savedEditorArchive(page,tx);
 expect(firstSaved.headTxId).toBe(tx);expect(firstSaved.archive).toBe(first.archive);
 expect(await activeFundAttempts(page)).toHaveLength(0);
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath('promo-editor-auto-completed-mobile.png'),fullPage:true});
 await page.clock.runFor(20_000);expect(api.posts).toHaveLength(1);

 await editChildName(page,'Child revised');
 api.nextStatus='SUBMITTED';api.nextTx='B'.repeat(43);api.verification=undefined;
 await freeSave.click();
 await expect.poll(()=>api.posts.length).toBe(2);
 await expect(promo(page).getByRole('status')).toContainText('Ждём подтверждения Arweave');
 await expect(promo(page).getByRole('textbox')).toHaveCount(0);
 await expect(promo(page).getByRole('button',{name:'Сохранить бесплатно',exact:true})).toHaveCount(0);
 expect(api.posts[1].orderId).not.toBe(first.orderId);expect(api.posts[1].archive).not.toBe(first.archive);
 expect(api.validations).toBe(2);
 expect(await page.evaluate(async serialized=>{
  const words=(await import('/src/lib/vaultSession/session.ts')).getSessionMnemonic();
  const keys=(await import('/src/lib/crypto/keys.ts')).deriveKeysFromMnemonic(words);
  const vault=await(await import('/src/lib/crypto/vault.ts')).openEnvelope(keys,JSON.parse(serialized));
  return JSON.stringify(vault).includes('Child revised');
 },api.posts[1].archive)).toBe(true);
 api.complete();await page.clock.runFor(6001);
 await expect(page.getByRole('dialog')).toHaveCount(0);
 const nextSaved=await savedEditorArchive(page,api.nextTx);
 expect(nextSaved.headTxId).toBe(api.nextTx);expect(nextSaved.parentId).toBe(tx);expect(nextSaved.archive).toBe(api.posts[1].archive);
 await page.clock.runFor(20_000);expect(api.posts).toHaveLength(2);
});

test('Completing an older funded attempt preserves a newer editor head',async({page})=>{
 const api=await mockPreservation(page,{expectedArchive:null});requireDurableEditorAttempt(page,api);
 await page.clock.install();await openEditor(page);await openEditorPromo(page);await savePromo(page);
 await expect(promo(page).getByRole('status')).toContainText('Ждём подтверждения Arweave');
 const newerTx='B'.repeat(43);
 await page.evaluate(async newerTx=>{
  const session=await import('/src/lib/vaultSession/session.ts');
  session.setVaultSession({...session.getVaultSession(),headTxId:newerTx,source:'publish'});
 },newerTx);
 api.complete();await page.clock.runFor(6001);
 await expect(page.getByRole('dialog')).toHaveCount(0);
 const saved=await savedEditorArchive(page,tx);
 expect(saved.headTxId).toBe(newerTx);expect(saved.archive).toBe(api.posts[0].archive);
 expect(api.posts).toHaveLength(1);expect(await activeFundAttempts(page)).toHaveLength(0);
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
 await page.clock.install();
 await openPromo(page);await savePromo(page);
 await expect(promo(page).getByRole('status')).toContainText('Проверяем состояние сохранения');
 await openTransactionDetails(page);
 api.order={...api.order,createdAt:Date.now()-120_000};await checkNow(page);
 await expect(promo(page).locator('.funded-delay')).toHaveCount(0);
 await expect(promo(page).getByRole('button',{name:'Сохранить бесплатно',exact:true})).toHaveCount(0);
 const id=api.order.orderId;api.complete();await checkNow(page);
 await expect(promo(page).getByRole('status')).toContainText('Семейная история сохранена');
 expect(api.reads.length).toBeGreaterThan(0);expect(new Set(api.reads)).toEqual(new Set([id]));expect(api.posts).toHaveLength(1);
});

test('An unavailable provider reports a failed check and recovers the same existing attempt without a new save',async({page},testInfo)=>{
 await mockReadOnlyDiscoveryAndRejectWallets(page);
 const api=await mockPreservation(page),id='d'.repeat(32),createdAt=Date.parse('2026-10-20T09:00:00Z');
 api.order={...orderFrom({orderId:id,preservationId:id,archive},'NEEDS_RECONCILIATION'),createdAt};
 api.verification={...verification('attention'),reason:'network_unavailable'};
 const attempt={version:1,orderId:id,envelope:JSON.parse(archive),archiveDigest:api.order.archiveDigest,
  vaultId:api.order.vaultId,parentTxId:null,treeId:null,createdAt};
 await page.addInitScript(attempt=>localStorage.setItem(`sejire.fundAttempt.v1.${attempt.orderId}`,JSON.stringify(attempt)),attempt);
 const writes=[];
 page.on('request',request=>{
  const path=new URL(request.url()).pathname;
  if(path.startsWith('/api/')&&request.method()!=='GET')writes.push(`${request.method()} ${path}`);
 });
 await page.clock.install({time:new Date('2026-10-21T09:00:00Z')});
 await page.setViewportSize({width:390,height:844});await openPromo(page);
 await expect(promo(page).getByRole('heading',{name:'Не удалось проверить сохранение',exact:true})).toBeVisible();
 await expect(promo(page).getByRole('status')).toContainText('автоматически проверять эту же попытку');
 await expect(promo(page).locator('.funded-delay')).toHaveCount(0);
 await expect(promo(page).locator('.funded-check-time')).toContainText('Последняя попытка проверки: 21.10.2026');
 await expect(promo(page).locator('.funded-check-time')).toContainText(/\d{2}:\d{2}:\d{2}/);
 await expect(promo(page).getByRole('button',{name:'Сохранить бесплатно',exact:true})).toHaveCount(0);
 await expect(promo(page).locator('details a')).toBeHidden();
 await expect(promo(page).locator('a[href="https://arweave.net/'+tx+'"]')).toHaveCount(0);
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath('promo-provider-unavailable-mobile.png'),fullPage:true});
 await openTransactionDetails(page);
 await expect(promo(page).getByRole('link',{name:/Открыть дерево/})).toHaveCount(0);
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);

 // Each transition comes only from the automatic GET for the existing ID.
 api.order={...api.order,status:'VERIFYING'};
 api.verification={...verification('checking_archive',true),reason:'archive_unavailable'};
 await page.clock.runFor(6_001);
 await expect(promo(page).getByRole('status')).toContainText('Проверяем сохранённый архив');
 await expect(promo(page).locator('.funded-delay')).toContainText('Проверка архива занимает время');
 const confirmationStep=promo(page).getByRole('listitem').filter({hasText:'Подтверждение Arweave'});
 await expect(confirmationStep).toHaveClass(/is-done/);

 api.order={...api.order,status:'NEEDS_RECONCILIATION'};
 api.verification={...verification('attention'),reason:'network_unavailable'};
 await page.clock.runFor(6_001);
 await expect(promo(page).getByRole('status')).toContainText('Не удалось проверить сохранение');
 await expect(promo(page).locator('.funded-delay')).toHaveCount(0);
 await expect(confirmationStep).not.toHaveClass(/is-done/);

 api.order={...api.order,status:'VERIFYING'};
 api.verification={...verification('awaiting_confirmation'),reason:'network_pending'};
 await page.clock.runFor(6_001);
 await expect(promo(page).getByRole('status')).toContainText('Ждём подтверждения Arweave');
 await expect(promo(page).locator('.funded-delay')).toContainText('Подтверждение занимает время');
 await expect(confirmationStep).not.toHaveClass(/is-done/);
 api.complete();await page.clock.runFor(6_001);
 await expect(promo(page).getByRole('status')).toContainText('Семейная история сохранена');
 await expect(promo(page).locator('.funded-delay')).toHaveCount(0);
 const reads=api.reads.length;await page.clock.runFor(20_000);
 expect(api.reads).toHaveLength(reads);expect(new Set(api.reads)).toEqual(new Set([id]));expect(api.maxInFlight).toBe(1);
 expect(api.posts).toHaveLength(0);expect(api.validations).toBe(0);expect(writes).toEqual([]);
 expect(await activeFundAttempts(page)).toEqual([attempt]);
 await expectNoPaymentSideEffects(page);
});

test('A failed status request is visible and a later automatic check recovers',async({page})=>{
 const api=await mockPreservation(page);
 await page.clock.install({time:new Date('2026-10-21T09:00:00Z')});
 await openPromo(page);await savePromo(page);
 await expect(promo(page).getByRole('status')).toContainText('Ждём подтверждения Arweave');
 api.order={...api.order,createdAt:Date.parse('2026-10-20T09:00:00Z')};await checkNow(page);
 await expect(promo(page).locator('.funded-delay')).toContainText('Подтверждение занимает время');
 await page.clock.setSystemTime(new Date('2026-10-22T09:00:00Z'));
 api.readError=503;await checkNow(page);
 await expect(promo(page).getByRole('alert')).toContainText('Не удалось обновить статус');
 await expect(promo(page).getByRole('alert')).toContainText('автоматически');
 await expect(promo(page).locator('.funded-delay')).toHaveCount(0);
 await expect(promo(page).locator('.funded-check-time')).toContainText('Последняя попытка проверки: 22.10.2026');
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
