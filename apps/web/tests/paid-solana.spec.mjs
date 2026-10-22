import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import bs58 from 'bs58';

const origin='http://127.0.0.1:5185', tx='A'.repeat(43);
const panel=page=>page.getByRole('region',{name:'Оплата SOL',exact:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
const networkState=()=>({ready:true,contributionReady:true,balance:'1000000000000000',requests:[],denied:[],creates:0,admissions:0,createKeys:[],bodies:[],prepares:0,reserves:0,sends:[],cancels:0,reconciles:0,
  finish:false,paid:false,phase:'queued',lostCreate:false,lostReserve:false,lostVerify:false,lostCancel:false,
  wrongGenesis:false,wrongOrder:false,snapshot:null,archive:null,key:null,unknownSignature:null,dropBeforeAdmission:false,tombstone:false});

async function installNetwork(context,state=networkState()){
 await context.addInitScript(()=>localStorage.setItem('sejire.locale','ru'));
 await context.routeWebSocket('**/*',route=>{
  if(new URL(route.url()).origin==='ws://127.0.0.1:5185')route.connectToServer();
  else{state.denied.push('external websocket');route.close({code:1008,reason:'Synthetic test only'});}
 });
 const update=async page=>{
  if(state.paid&&state.snapshot){
   const s=state.snapshot,signature=s.record.pendingSignature??state.unknownSignature;
   expect(signature).toBeTruthy();
   s.record.pendingSignature=signature;s.record.payment={signature,feeLamports:'5000'};
   s.record.states.payment='verified';s.record.states.preservation=s.record.order.kind==='contribution'?'not-applicable':'ready';
   s.record.states.contribution=s.record.order.fundContribution.amount==='0'?'not-requested':'received';
   s.verification={status:'verified'};
   s.execution=s.record.order.kind==='contribution'?null:{kind:'arweave-direct',txId:state.phase==='queued'?null:tx,status:state.phase,verification:null};
   if(state.finish&&s.record.order.kind==='preservation')state.snapshot=await page.evaluate(async s=>(await import('/tests/paid-fixture.ts')).completedSnapshot(s),s);
  }
  const result=structuredClone(state.snapshot);
  if(state.wrongOrder&&result?.record.order.kind==='preservation')result.record.order.archive.parentTxId='Z'.repeat(43);
  return result;
 };
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),page=req.frame().page();
  if(url.origin===origin&&!url.pathname.startsWith('/api/'))return route.continue();
  if(url.origin===origin&&url.pathname.startsWith('/api/checkout/')){
   const method=req.method(),path=url.pathname.slice('/api/checkout'.length),body=req.postData()?req.postDataJSON():null;
   state.requests.push(`${method} ${path}`);
   if((path==='/policy'||path==='/policy/contribution')&&method==='GET'){
    const offered=await page.evaluate(async()=>(await import('/tests/paid-fixture.ts')).offeredPolicy());
    return json(route,{ready:state.ready,contributionReady:state.contributionReady,
     ...(state.ready?{policy:offered.policy,policyHash:offered.policyHash}:{reason:'paid_unavailable'}),
     ...(state.contributionReady?{contributionPolicy:offered.contributionPolicy,contributionPolicyHash:offered.contributionPolicyHash}:{contributionReason:'contribution_unavailable'})});
   }
   if(path==='/session'&&method==='POST')return json(route,{accessToken:'f'.repeat(64),expiresAt:Date.now()+3600000});
   if(path==='/orders'&&method==='POST'){
    state.creates++;state.key=req.headers()['idempotency-key'];state.bodies.push(body);
    state.createKeys.push(state.key);
    const saved=await page.evaluate(async key=>{
     const op=await(await import('/src/lib/checkout/paidJournal.ts')).readPaidOperation(key);
     if(window.paidWallet)window.paidWallet.key=key;
     return {op,wordsStored:JSON.stringify(op).includes(window.paidFamily?.words??'not-present')};
    },state.key);
    expect(saved.wordsStored).toBe(false);expect(saved.op.createAttempted).toBe(true);
    expect(req.headers().authorization).toBe(`Bearer ${saved.op.token}`);
    if(body.kind==='contribution'){
     expect(saved.op.intent.kind).toBe('contribution');expect(saved.op.serialized).toBeNull();expect(saved.op.archive).toBeNull();expect(saved.op.treeId).toBeNull();
     expect(body).not.toHaveProperty('serialized');expect(body).not.toHaveProperty('archive');state.archive=null;
    }else{
     expect(saved.op.serialized).toBe(body.serialized);expect(saved.op.archive).toEqual(body.archive);
     expect(body.archive.digest).toBe(createHash('sha256').update(body.serialized).digest('hex'));
     expect(body.archive.bytes).toBe(Buffer.byteLength(body.serialized));state.archive=body.serialized;
    }
    if(state.tombstone)return json(route,{error:'paid_request_cancelled'},409);
    if(state.dropBeforeAdmission){state.dropBeforeAdmission=false;return route.abort('failed');}
    state.admissions++;state.paid=false;state.finish=false;state.phase='queued';
    state.snapshot=await page.evaluate(async({body,index})=>(await import('/tests/paid-fixture.ts')).initialSnapshot(body,index),{body,index:state.admissions});
    if(state.lostCreate){state.lostCreate=false;return route.abort('failed');}
    return json(route,await update(page));
   }
   if(path===`/orders/by-key/${state.key}/cancel`&&method==='POST'){
    if(state.snapshot)return json(route,await update(page));
    state.tombstone=true;
    if(state.lostCancel){state.lostCancel=false;return route.abort('failed');}
    return json(route,{schema:'sejire/paid-request-cancellation/v1',status:'cancelled',key:state.key});
   }
   if(path===`/orders/by-key/${state.key}`&&method==='GET'&&state.tombstone)return json(route,{schema:'sejire/paid-request-cancellation/v1',status:'cancelled',key:state.key});
   if(!state.snapshot)return json(route,{error:'order_not_found'},404);
   const order=state.snapshot.record.order;
   if(method==='GET'&&(path===`/orders/${order.id}`||path===`/orders/by-key/${state.key}`)){
    await page.evaluate(key=>{if(window.paidWallet)window.paidWallet.key=key;},state.key);
    return json(route,await update(page));
   }
   if(method==='POST'&&path===`/orders/${order.id}/prepare`){
    state.prepares++;state.snapshot.preparation??=await page.evaluate(async s=>(await import('/tests/paid-fixture.ts')).preparation(s),state.snapshot);
    return json(route,state.snapshot.preparation);
   }
   if(method==='POST'&&path===`/orders/${order.id}/reserve`){
    expect(state.snapshot.expired).toBe(false);expect(body.preparationId).toBe(state.snapshot.preparation.preparationId);
    const stored=await page.evaluate(async key=>(await import('/src/lib/checkout/paidJournal.ts')).readPaidOperation(key),state.key);
    expect(stored.signature).toBe(body.signature);expect(stored.signedTransaction).toBeTruthy();
    state.reserves++;state.snapshot.record.pendingSignature=body.signature;
    state.snapshot.record.states.payment='requires-reconciliation';
    if(state.lostReserve){state.lostReserve=false;return route.abort('failed');}
    return json(route,await update(page));
   }
   if(method==='POST'&&path===`/orders/${order.id}/cancel`){
    expect(state.snapshot.record.payment).toBeUndefined();expect(state.snapshot.record.pendingSignature).toBeUndefined();
    expect(body.preparationId).toBe(state.snapshot.preparation?.preparationId??null);
    state.cancels++;state.snapshot.expired=true;state.snapshot.cancelled=true;
    if(state.lostCancel){state.lostCancel=false;return route.abort('failed');}
    return json(route,await update(page));
   }
   if(method==='POST'&&(path===`/orders/${order.id}/verify`||path===`/orders/${order.id}/reconcile`)){
    state.reconciles++;
    state.snapshot.verification=state.paid?{status:'verified'}:{status:'requires-reconciliation',reason:'not-found'};
    if(state.lostVerify){state.lostVerify=false;return route.abort('failed');}
    return json(route,await update(page));
   }
   if(method==='POST'&&path===`/orders/${order.id}/execute`){
    expect(body).toEqual({});expect(state.paid).toBe(true);expect(order.kind).toBe('preservation');state.phase='confirming';return json(route,await update(page));
   }
  }
  if(url.origin==='https://api.devnet.solana.com'&&req.method()==='POST'){
   const body=req.postDataJSON();let result;
   if(body.method==='getGenesisHash')result=state.wrongGenesis?'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d':'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
   else if(body.method==='getBalance')return route.fulfill({contentType:'application/json',body:`{"jsonrpc":"2.0","id":${JSON.stringify(body.id)},"result":{"value":${state.balance}}}`});
   else if(body.method==='getFeeForMessage')result={value:5000};
   else if(body.method==='getBlockHeight')result=50;
   else if(body.method==='sendTransaction'){
    expect(state.reserves).toBeGreaterThan(0);
    result=bs58.encode(Buffer.from(body.params[0],'base64').subarray(1,65));
    expect(result).toBe(state.snapshot.record.pendingSignature);
    const stored=await page.evaluate(async key=>(await import('/src/lib/checkout/paidJournal.ts')).readPaidOperation(key),state.key);
    expect(body.params[0]).toBe(stored.signedTransaction);
    state.sends.push(body.params[0]);state.paid=true;
   }else{state.denied.push('unmocked RPC');return route.abort('blockedbyclient');}
   return json(route,{jsonrpc:'2.0',id:body.id,result});
  }
  const gateways=['arweave.net','g8way.io','ar-io.net','turbo-gateway.com','arweave-search.goldsky.com'];
  if(url.protocol==='https:'&&gateways.includes(url.hostname)){
   if(url.pathname==='/ar-io/peers')return json(route,{gateways:{}});
   if(url.pathname==='/graphql')return json(route,{data:{transactions:{pageInfo:{hasNextPage:false},edges:state.finish?[{node:{id:tx,block:{height:100,timestamp:1700000000}}}]:[]}}});
   if(state.finish&&state.archive){
    if(url.pathname===`/raw/${tx}`)return route.fulfill({status:404,body:'synthetic raw unavailable'});
    if(url.pathname===`/tx/${tx}/data`)return route.fulfill({contentType:'text/plain',body:Buffer.from(state.archive).toString('base64url')});
    if(url.pathname===`/tx/${tx}`){
     const tag=(name,value)=>({name:Buffer.from(name).toString('base64url'),value:Buffer.from(value).toString('base64url')});
     const order=state.snapshot.record.order,envelope=JSON.parse(state.archive);
     const owner=Buffer.from(new Uint8Array(512).fill(19)).toString('base64url');
     return json(route,{id:tx,owner,reward:'100',tags:[tag('App-Name','SEJIRE'),tag('Type','vault-envelope'),tag('Schema',envelope.schema),tag('Protocol-Version',envelope.protocol),
      tag('Vault-Id',envelope.vault_id),tag('Archive-SHA256',order.archive.digest),tag('Archive-Bytes',String(order.archive.bytes)),tag('Preservation-Id',order.id),
      ...(order.archive.parentTxId?[tag('Parent-Tx',order.archive.parentTxId)]:[])]});
    }
   }
  }
  state.denied.push(`${req.method()} ${url.origin}${url.pathname}`);return route.abort('blockedbyclient');
 });
 return state;
}

async function enterWords(page,source='paidFamily'){
 await page.getByRole('textbox',{name:'12 слов восстановления SEJIRE'}).evaluate((input,key)=>{
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,window[key].words);
  input.dispatchEvent(new Event('input',{bubbles:true}));
 },source);
}
async function openEditor(page){
 await page.goto(origin);
 const encrypted=await page.evaluate(async()=>{window.paidFamily=await(await import('/tests/paid-fixture.ts')).family();return window.paidFamily.serialized;});
 await page.getByRole('button',{name:'Открыть по 12 словам',exact:true}).click();
 await page.getByRole('button',{name:'Открыть из файла',exact:true}).click();
 await page.locator('input[type=file]').setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from(encrypted)});
 await enterWords(page);await page.getByRole('button',{name:'Восстановить архив',exact:true}).click();
 await expect(page.getByRole('button',{name:'Сохранить',exact:true}).first()).toBeVisible();
 await page.evaluate(async()=>(await import('/tests/paid-fixture.ts')).installWallet());
}
async function openPaid(page){
 await page.getByRole('button',{name:'Сохранить',exact:true}).first().click();
 await page.getByRole('dialog').getByRole('button',{name:'Через Solana',exact:true}).click();
 await expect(panel(page)).toBeVisible();
}
async function requestPayment(page,{contribution=false,wallet='Phantom'}={}){
 await panel(page).getByRole('button',{name:`Подключить ${wallet}`,exact:true}).click();
 const create=panel(page).getByRole('button',{name:contribution?'Только помочь другим':'Оплатить и сохранить',exact:true});
 const confirm=panel(page).getByRole('button',{name:'Подтвердить оплату в кошельке',exact:true});
 await expect(create.or(confirm)).toBeVisible();
 if(await create.count())await create.click();
}
async function prepare(page,options){
 await requestPayment(page,options);
 await expect(panel(page).getByRole('checkbox')).toBeVisible();
}
async function pay(page){
 await panel(page).getByRole('checkbox').check();
 await panel(page).getByRole('button',{name:'Подтвердить оплату в кошельке',exact:true}).click();
}
async function check(page){
 const button=panel(page).getByRole('button',{name:'Проверить статус',exact:true});
 await expect(button).toBeEnabled();await button.click();
}
async function saved(page,key){
 return page.evaluate(async key=>{
  const op=await(await import('/src/lib/checkout/paidJournal.ts')).readPaidOperation(key);
  const session=await import('/src/lib/vaultSession/session.ts');
  const version=op?.archive&&(await import('/src/lib/vaultSession/localArchive.ts')).getLocalVaultVersion(op.archive.vaultId,'A'.repeat(43));
  return {op,session:session.getVaultSession(),wordsInMemory:Boolean(session.getSessionMnemonic()),archive:version?JSON.stringify(version.envelope):null,parent:version?.parentId};
 },key);
}
async function cleanRestore(browser,state,words,receipt){
 const context=await browser.newContext({baseURL:origin,locale:'ru-RU',serviceWorkers:'block'}),page=await context.newPage();
 await installNetwork(context,state);await page.goto(origin);
 await page.evaluate(words=>{window.paidRestore={words};},words);
 await page.getByRole('button',{name:'Открыть по 12 словам',exact:true}).click();
 if(receipt){await page.getByRole('button',{name:'Открыть из файла',exact:true}).click();await page.locator('input[type=file]').setInputFiles({name:'synthetic-paid-receipt.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(receipt))});}
 await enterWords(page,'paidRestore');
 await page.getByRole('button',{name:receipt?'Восстановить архив':'Открыть',exact:true}).click();
 await expect(page.locator('.person-card').filter({hasText:'Child corrected'})).toBeVisible();
 const recovered=await page.evaluate(async()=>{
  const session=await import('/src/lib/vaultSession/session.ts'),keys=(await import('/src/lib/crypto/keys.ts')).deriveKeysFromMnemonic(session.getSessionMnemonic());
  const vault=await(await import('/src/lib/crypto/vault.ts')).openLocalVault(keys);
  return {count:Object.keys(vault.trees).length,active:vault.trees[vault.active_tree_id].draft.persons.child.name,
   head:session.getVaultSession().headTxId,cache:localStorage.getItem('sejire.envelope.'+keys.vaultId),
   archived:JSON.stringify((await import('/src/lib/vaultSession/localArchive.ts')).getLocalVaultVersion(keys.vaultId,'A'.repeat(43)).envelope),wallet:Boolean(window.phantom)};
 });
 expect(recovered).toEqual({count:2,active:'Child corrected',head:tx,cache:state.archive,archived:state.archive,wallet:false});
 await context.close();
}

test('disabled public policy leaves promo and encrypted backup available without any wallet or order',async({page,context})=>{
 const state=await installNetwork(context);state.ready=false;
 await openEditor(page);await openPaid(page);
 await expect(panel(page).getByText('Оплата через Solana пока недоступна. Вы можете сохранить дерево по промокоду.')).toBeVisible();
 await expect(panel(page).getByRole('button',{name:/Оплатить|Подключить/})).toHaveCount(0);
 await expect(panel(page).getByRole('button',{name:'Скачать зашифрованную копию'})).toBeVisible();
 expect(state.creates).toBe(0);expect(await page.evaluate(()=>window.paidWallet.connects)).toBe(0);expect(state.denied).toEqual([]);
});

test('modern editor pays once, checks archive proof, retries only local completion and restores both trees from receipt and words',async({page,context,browser},testInfo)=>{
 const state=await installNetwork(context);await page.setViewportSize({width:390,height:844});
 await openEditor(page);await openPaid(page);
 const downloadEvent=page.waitForEvent('download');await panel(page).getByRole('button',{name:'Скачать зашифрованную копию'}).click();
 const backup=await readFile(await(await downloadEvent).path(),'utf8');
 await prepare(page);expect(JSON.stringify(JSON.parse(backup))).toBe(state.archive);
 await expect(panel(page)).toContainText('0.000005 SOL');await expect(panel(page).getByText('0 SOL',{exact:true})).toBeVisible();
 await pay(page);await expect(panel(page).getByRole('heading',{name:'Оплата получена. Сохраняем дерево'})).toBeVisible();
 expect(state.sends).toHaveLength(1);expect(state.creates).toBe(1);
 await check(page);await expect.poll(()=>state.requests.some(value=>value.endsWith('/execute'))).toBe(true);
 await expect(panel(page).getByRole('heading',{name:'Ждём подтверждения Arweave'})).toBeVisible();
 expect(await page.evaluate(async bytes=>(await import('/tests/paid-fixture.ts')).transfers(bytes),state.sends[0])).toEqual([
  {recipient:state.snapshot.record.order.servicePayment.recipient,lamports:'30000000'},
 ]);
 await expect(panel(page).getByRole('button',{name:'Проверить статус',exact:true})).toBeEnabled();
 await page.screenshot({path:testInfo.outputPath('paid-waiting-mobile.png'),fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.evaluate(async()=>{
  window.failPaidLocal=true;const original=Storage.prototype.setItem;
  Storage.prototype.setItem=function(key,value){if(window.failPaidLocal&&key.startsWith('sejire.vaultArchive.v1.'))throw new DOMException('Synthetic quota','QuotaExceededError');return original.call(this,key,value);};
  const s=await import('/src/lib/vaultSession/session.ts');s.setVaultSession({...s.getVaultSession(),headTxId:'C'.repeat(43),source:'publish'},s.getSessionMnemonic());
 });
 state.finish=true;await check(page);
 await expect(panel(page).getByRole('alert')).toContainText('локальной истории');
 await page.screenshot({path:testInfo.outputPath('paid-local-retry-mobile.png'),fullPage:true});
 expect((await saved(page,state.key)).op.localCompletion).toBe('pending');expect(state.sends).toHaveLength(1);
 await page.evaluate(()=>{window.failPaidLocal=false;});await panel(page).getByRole('button',{name:'Повторить завершение'}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByText(/^Сохранено в Arweave /)).toBeVisible();
 const local=await saved(page,state.key);expect(local.op.localCompletion).toBe('done');expect(local.archive).toBe(state.archive);
 expect(local.session.headTxId).toBe('C'.repeat(43));expect(local.parent).toBeNull();
 expect(await page.evaluate(()=>window.paidWallet.signCount)).toBe(1);
 await page.screenshot({path:testInfo.outputPath('paid-workspace-success-mobile.png'),fullPage:true});
 const receiptDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Скачать квитанцию',exact:true}).click();
 const receipt=JSON.parse(await readFile(await(await receiptDownload).path(),'utf8'));
 expect(receipt).toEqual(state.snapshot.execution.receipt);
 const words=await page.evaluate(()=>window.paidFamily.words);
 await cleanRestore(browser,state,words,receipt);await cleanRestore(browser,state,words,null);
 expect(state.sends).toHaveLength(1);expect(state.creates).toBe(1);expect(state.denied).toEqual([]);
});

test('lost create response reload uses the original GET-by-key and exact ciphertext with no reseal or second POST',async({page,context})=>{
 const state=await installNetwork(context);state.lostCreate=true;await openEditor(page);await openPaid(page);
 await requestPayment(page);
 await expect(panel(page).getByRole('heading',{name:'Проверяем созданный запрос'})).toBeVisible();
 const before=await saved(page,state.key);expect(before.op.order).toBeUndefined();
 await page.reload();await expect(panel(page)).toBeVisible();
 await expect(panel(page).getByRole('button',{name:'Подключить Phantom'})).toBeEnabled();
 const after=await saved(page,state.key);expect(after.op.serialized).toBe(before.op.serialized);expect(after.op.id).toBe(before.op.id);
 expect(after.wordsInMemory).toBe(false);expect(state.creates).toBe(1);expect(state.prepares).toBe(0);
 expect(state.requests).toContain(`GET /orders/by-key/${state.key}`);expect(state.sends).toHaveLength(0);expect(state.denied).toEqual([]);
});

test('request dropped before admission retries explicitly with the same key, token and ciphertext after reload',async({page,context})=>{
 const state=await installNetwork(context);state.dropBeforeAdmission=true;await openEditor(page);await openPaid(page);
 await requestPayment(page);
 await expect(panel(page).getByRole('button',{name:'Повторить отправку запроса'})).toBeEnabled();
 const original=await saved(page,state.key);await page.reload();await expect(panel(page).getByRole('alert')).toContainText('не нашёл');
 expect(state.creates).toBe(1);expect(state.admissions).toBe(0);
 await panel(page).getByRole('button',{name:'Повторить отправку запроса'}).click();
 await expect(panel(page).getByRole('button',{name:'Подключить Phantom'})).toBeEnabled();
 const after=await saved(page,state.key);expect(after.op.serialized).toBe(original.op.serialized);expect(after.op.token).toBe(original.op.token);
 expect(state.createKeys).toEqual([state.key,state.key]);expect(state.creates).toBe(2);expect(state.admissions).toBe(1);
 expect(state.prepares).toBe(0);expect(state.sends).toHaveLength(0);expect(state.denied).toEqual([]);
});

test('lost pre-admission cancellation response resumes the same tombstone and never creates an order',async({page,context})=>{
 const state=await installNetwork(context);state.dropBeforeAdmission=true;await openEditor(page);await openPaid(page);
 await requestPayment(page);
 await expect(panel(page).getByRole('button',{name:'Отменить этот запрос'})).toBeEnabled();state.lostCancel=true;
 await panel(page).getByRole('button',{name:'Отменить этот запрос'}).click();
 await expect(panel(page).getByRole('heading',{name:'Проверяем отмену запроса'})).toBeVisible();
 await page.reload();await expect(panel(page).getByRole('heading',{name:'Запрос оплаты отменён'})).toBeVisible();
 expect((await saved(page,state.key)).op.creationCancelled).toBe(true);
 await panel(page).getByRole('button',{name:'Вернуться к выбору сохранения'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 expect((await saved(page,state.key)).op.localCompletion).toBe('released');expect(state.creates).toBe(1);expect(state.admissions).toBe(0);
 expect(state.reserves).toBe(0);expect(state.sends).toHaveLength(0);expect(state.denied).toEqual([]);
});

test('unknown wallet result reload reconciles the same reference without another signature, payment or order',async({page,context})=>{
 const state=await installNetwork(context);await openEditor(page);await openPaid(page);await prepare(page);
 await page.evaluate(()=>{window.paidWallet.unknown=true;});await pay(page);
 await expect(panel(page).getByRole('heading',{name:'Проверяем оплату'})).toBeVisible();
 await expect(panel(page).getByRole('button',{name:/Оплатить|Отменить неоплаченный/})).toHaveCount(0);
 state.unknownSignature=await page.evaluate(()=>window.paidWallet.signature);
 expect((await saved(page,state.key)).op.signature).toBeUndefined();
 await page.reload();await expect(panel(page).getByRole('heading',{name:'Проверяем оплату'})).toBeVisible();
 expect(await page.evaluate(()=>Boolean(window.phantom))).toBe(false);
 state.paid=true;state.finish=true;await check(page);
 await expect(page.getByRole('dialog')).toHaveCount(0);expect((await saved(page,state.key)).op.localCompletion).toBe('done');
 expect(state.creates).toBe(1);expect(state.reserves).toBe(0);expect(state.sends).toHaveLength(0);expect(state.denied).toEqual([]);
});

test('lost reserve response never broadcasts early and resumes only identical stored signed bytes',async({page,context})=>{
 const state=await installNetwork(context);state.lostReserve=true;await openEditor(page);await openPaid(page);await prepare(page);await pay(page);
 await expect(panel(page).getByRole('heading',{name:'Проверяем оплату'})).toBeVisible();expect(state.sends).toHaveLength(0);
 const signed=(await saved(page,state.key)).op.signedTransaction;expect(signed).toBeTruthy();
 await page.reload();await expect(panel(page)).toBeVisible();await check(page);
 await expect.poll(()=>state.sends.length).toBe(1);expect(state.sends[0]).toBe(signed);
 state.finish=true;await check(page);await expect(page.getByRole('dialog')).toHaveCount(0);
 expect(state.creates).toBe(1);expect(state.denied).toEqual([]);
});

test('explicit 4001 cancellation, including a lost response, needs acknowledgement before any next save',async({page,context})=>{
 const state=await installNetwork(context);await openEditor(page);await openPaid(page);await prepare(page);
 await page.evaluate(()=>{window.paidWallet.reject=true;});await pay(page);
 await expect(panel(page).getByRole('alert')).toContainText('отклонил подпись');expect(state.sends).toHaveLength(0);
 state.lostCancel=true;await panel(page).getByRole('button',{name:'Отменить неоплаченный запрос'}).click();
 await expect(panel(page).getByRole('heading',{name:'Проверяем отмену запроса'})).toBeVisible();
 await page.reload();await expect(panel(page).getByRole('heading',{name:'Запрос оплаты отменён'})).toBeVisible();
 expect((await saved(page,state.key)).op.localCompletion).toBe('pending');
 await panel(page).getByRole('button',{name:'Вернуться к выбору сохранения'}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);expect((await saved(page,state.key)).op.localCompletion).toBe('released');
 expect(state.creates).toBe(1);expect(state.cancels).toBe(1);expect(state.reserves).toBe(0);expect(state.denied).toEqual([]);
});

test('two tabs and switching to promo adopt one durable paid attempt without new orders or ciphertext',async({page,context})=>{
 const state=await installNetwork(context);await openEditor(page);await openPaid(page);await prepare(page);
 const original=await saved(page,state.key),other=await context.newPage();await other.goto(origin);
 await other.getByRole('button',{name:'Продолжить',exact:true}).click();
 await expect(panel(other)).toBeVisible();expect((await saved(other,state.key)).op.serialized).toBe(original.op.serialized);
 await expect(other.getByRole('region',{name:'Сохранение по промокоду'})).toHaveCount(0);
 await other.evaluate(async()=>{
  const op=await(await import('/src/lib/checkout/paidJournal.ts')).findPaidAttempt({treeId:(await import('/src/lib/draftStorage.ts')).loadDraftTree().meta.id});
  window.guardedPromoResult=await(await import('/src/lib/checkout/vaultGuard.ts')).saveGuardedFundAttempt({orderId:'e'.repeat(32),envelope:JSON.parse(op.serialized),parentTxId:op.archive.parentTxId,treeId:op.treeId}).then(()=>false,error=>error.message==='preservation_attempt_in_progress');
 });
 expect(await other.evaluate(()=>window.guardedPromoResult)).toBe(true);
 await other.evaluate(async()=>{(await import('/tests/paid-fixture.ts')).installWallet();});await prepare(other);
 await Promise.all([panel(page).getByRole('checkbox').check(),panel(other).getByRole('checkbox').check()]);
 await Promise.all([panel(page).getByRole('button',{name:'Подтвердить оплату в кошельке',exact:true}).click(),panel(other).getByRole('button',{name:'Подтвердить оплату в кошельке',exact:true}).click()]);
 await expect.poll(()=>state.sends.length).toBe(1);
 expect((await page.evaluate(()=>window.paidWallet.signCount))+(await other.evaluate(()=>window.paidWallet.signCount))).toBe(1);
 expect(state.creates).toBe(1);expect((await saved(other,state.key)).op.serialized).toBe(original.op.serialized);expect(state.denied).toEqual([]);
 await other.close();
});

test('wrong network or changed order is stopped before wallet signature',async({page,context})=>{
 const state=await installNetwork(context);await openEditor(page);await openPaid(page);await prepare(page);state.wrongGenesis=true;
 await pay(page);await expect(panel(page).getByRole('alert')).toContainText('сеть Solana');
 expect(await page.evaluate(()=>window.paidWallet.signCount)).toBe(0);expect(state.reserves).toBe(0);expect(state.sends).toHaveLength(0);
 state.wrongGenesis=false;state.wrongOrder=true;await check(page);await expect(panel(page).getByRole('alert')).toBeVisible();
 await pay(page);expect(await page.evaluate(()=>window.paidWallet.signCount)).toBe(0);expect(state.creates).toBe(1);expect(state.denied).toEqual([]);
});

test('navigation while wallet is open journals the returned signature without late reserve or broadcast',async({page,context})=>{
 const state=await installNetwork(context);await openEditor(page);await openPaid(page);await prepare(page);
 await page.evaluate(()=>{window.paidWallet.hold=true;});await pay(page);
 await expect.poll(()=>page.evaluate(()=>window.paidWallet.signCount)).toBe(1);
 await page.evaluate(()=>{location.hash='#/restore';});await expect(panel(page)).toHaveCount(0);
 await page.evaluate(()=>{window.paidWallet.release();});
 await expect.poll(async()=>(await saved(page,state.key)).op.signature).toBeTruthy();
 expect(state.reserves).toBe(0);expect(state.sends).toHaveLength(0);expect(state.creates).toBe(1);expect(state.denied).toEqual([]);
});

const helpName='Помочь другим сохранить их истории';
const amountInput=page=>panel(page).getByRole('textbox',{name:'Добровольный взнос, SOL'});
async function vaultState(page){
 return page.evaluate(async()=>({
  draft:JSON.stringify((await import('/src/lib/draftStorage.ts')).loadDraftTree()),
  session:JSON.stringify((await import('/src/lib/vaultSession/session.ts')).getVaultSession()),
  archives:Object.fromEntries(Object.keys(localStorage).filter(key=>key.startsWith('sejire.vaultArchive.')||key.startsWith('sejire.envelope.')).sort().map(key=>[key,localStorage.getItem(key)])),
 }));
}
async function standalone(page){
 await page.goto(origin);
 await expect(page.getByRole('button',{name:'Только помочь другим',exact:true})).toHaveCount(0);
 await expect(page.getByRole('textbox',{name:'Добровольный взнос, SOL'})).toHaveCount(0);
 await page.getByRole('button',{name:helpName,exact:true}).click();
 await expect(panel(page).getByRole('heading',{name:'Помощь другим семьям'})).toBeVisible();
 await expect(amountInput(page)).toHaveValue('0');
 await page.evaluate(async()=>(await import('/tests/paid-fixture.ts')).installWallet());
}

test('help starts hidden at zero, both wallet connections create nothing, and a fresh save resets its draft contribution',async({page,context})=>{
 const state=await installNetwork(context);await openEditor(page);await openPaid(page);
 await expect(panel(page).getByRole('button',{name:helpName})).toHaveAttribute('aria-expanded','false');
 await expect(amountInput(page)).toHaveCount(0);await expect(panel(page)).toContainText('Итого без комиссии сети: 0.03 SOL');
 await panel(page).getByRole('button',{name:'Подключить Phantom',exact:true}).click();
 await panel(page).getByRole('button',{name:'Подключить Solflare',exact:true}).click();
 await expect(panel(page).getByRole('button',{name:'Оплатить и сохранить',exact:true})).toBeEnabled();
 expect(state.creates).toBe(0);expect(state.prepares).toBe(0);expect(state.requests.filter(value=>value.startsWith('POST '))).toEqual([]);
 expect(await page.evaluate(()=>({connects:window.paidWallet.connects,signs:window.paidWallet.signCount}))).toEqual({connects:2,signs:0});
 await panel(page).getByRole('button',{name:helpName}).click();await amountInput(page).fill('0.123456789');
 await panel(page).getByRole('button',{name:'Назад',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Через Solana',exact:true}).click();
 await expect(panel(page).getByRole('button',{name:helpName})).toHaveAttribute('aria-expanded','false');
 await expect(panel(page)).toContainText('Итого без комиссии сети: 0.03 SOL');
 await panel(page).getByRole('button',{name:helpName}).click();await expect(amountInput(page)).toHaveValue('0');
 expect(state.creates).toBe(0);expect(state.sends).toEqual([]);expect(state.denied).toEqual([]);
});

test('collapsed help retains the visible amount; switching intent preserves the archive and amount until explicitly removed',async({page,context})=>{
 const state=await installNetwork(context);await openEditor(page);await openPaid(page);
 // Opening preservation seals its candidate once. Only the following mode changes must leave that exact candidate untouched.
 const before=await vaultState(page);
 const backupDownload=page.waitForEvent('download');await panel(page).getByRole('button',{name:'Скачать зашифрованную копию'}).click();
 const backup=await readFile(await(await backupDownload).path(),'utf8');
 await panel(page).getByRole('button',{name:helpName}).click();await amountInput(page).fill('1.25');
 await panel(page).getByRole('button',{name:helpName}).click();await expect(amountInput(page)).toHaveCount(0);
 await expect(panel(page)).toContainText('Добровольный взнос: 1.25 SOL');await expect(panel(page)).toContainText('Итого без комиссии сети: 1.28 SOL');
 await panel(page).getByRole('button',{name:helpName}).click();await panel(page).getByRole('button',{name:'Только помочь другим',exact:true}).click();
 await expect(panel(page).getByRole('heading',{name:'Помощь другим семьям'})).toBeVisible();await expect(amountInput(page)).toHaveValue('1.25');
 await expect(panel(page)).toContainText('Итого без комиссии сети: 1.25 SOL');
 await expect(panel(page).getByRole('button',{name:'Скачать зашифрованную копию'})).toHaveCount(0);
 await panel(page).getByRole('button',{name:'Вернуться к сохранению дерева'}).click();
 await expect(panel(page).getByRole('heading',{name:'Через Solana'})).toBeVisible();await expect(amountInput(page)).toHaveValue('1.25');
 await expect(panel(page)).toContainText('Итого без комиссии сети: 1.28 SOL');
 const againDownload=page.waitForEvent('download');await panel(page).getByRole('button',{name:'Скачать зашифрованную копию'}).click();
 expect(await readFile(await(await againDownload).path(),'utf8')).toBe(backup);expect(await vaultState(page)).toEqual(before);
 await panel(page).getByRole('button',{name:helpName}).click();await panel(page).getByRole('button',{name:'Убрать взнос'}).click();
 await expect(panel(page)).toContainText('Итого без комиссии сети: 0.03 SOL');await expect(panel(page).getByRole('button',{name:'Убрать взнос'})).toHaveCount(0);
 expect(state.creates).toBe(0);expect(state.sends).toEqual([]);expect(state.denied).toEqual([]);
});

test('preservation plus a precise optional contribution uses one signature and exactly two transfers',async({page,context})=>{
 const state=await installNetwork(context);await openEditor(page);await openPaid(page);
 await panel(page).getByRole('button',{name:helpName}).click();await amountInput(page).fill('7.000000001');
 await prepare(page);await expect(amountInput(page)).toHaveCount(0);await expect(panel(page).getByRole('button',{name:helpName})).toHaveCount(0);
 expect(state.snapshot.record.order.total).toBe('7030000001');
 await pay(page);await expect.poll(()=>state.sends.length).toBe(1);
 expect(await page.evaluate(async bytes=>(await import('/tests/paid-fixture.ts')).transfers(bytes),state.sends[0])).toEqual([
  {recipient:state.snapshot.record.order.servicePayment.recipient,lamports:'30000000'},
  {recipient:state.snapshot.record.order.fundContribution.recipient,lamports:'7000000001'},
 ]);
 expect(await page.evaluate(()=>window.paidWallet.signCount)).toBe(1);expect(state.creates).toBe(1);
 state.finish=true;await check(page);await expect(page.getByRole('dialog')).toHaveCount(0);
 expect((await saved(page,state.key)).op.localCompletion).toBe('done');expect(state.denied).toEqual([]);
});

test('invalid decimal and excessive precision cannot create an intent; insufficient balance never invokes the wallet',async({page,context})=>{
 const state=await installNetwork(context);await openEditor(page);await openPaid(page);
 await panel(page).getByRole('button',{name:'Подключить Phantom',exact:true}).click();
 await panel(page).getByRole('button',{name:helpName}).click();
 for(const amount of ['1,2','1e3','0.0000000001','18446744074']){
  await amountInput(page).fill(amount);await expect(amountInput(page)).toHaveAttribute('aria-invalid','true');
  await expect(panel(page).getByRole('button',{name:'Оплатить и сохранить',exact:true})).toBeDisabled();
 }
 expect(state.creates).toBe(0);
 await amountInput(page).fill('0.1');await prepare(page);state.balance='130004999';await pay(page);
 await expect(panel(page).getByRole('alert')).toContainText('недостаточно SOL');
 expect(await page.evaluate(()=>window.paidWallet.signCount)).toBe(0);expect(state.reserves).toBe(0);expect(state.sends).toEqual([]);
 expect((await saved(page,state.key)).op.signingStarted).toBe(false);expect(state.denied).toEqual([]);
});

test('the quiet welcome link opens standalone Solflare help without a tree or AR policy, with a receipt and an explicit new zero-default contribution',async({page,context},testInfo)=>{
 const state=await installNetwork(context);state.ready=false;await page.setViewportSize({width:390,height:844});await standalone(page);
 const before=await vaultState(page);expect(before).toEqual({draft:'null',session:'null',archives:{}});
 expect(state.requests).toContain('GET /policy/contribution');
 await expect(panel(page)).not.toContainText('Хранение:');await expect(panel(page)).not.toContainText('Сохранение —');
 await panel(page).getByRole('button',{name:'Подключить Solflare',exact:true}).click();
 await expect(panel(page).getByRole('button',{name:'Только помочь другим',exact:true})).toBeDisabled();expect(state.creates).toBe(0);
 await amountInput(page).fill('0.2');await prepare(page,{contribution:true,wallet:'Solflare'});
 const firstKey=state.key,firstOrder=state.snapshot.record.order;
 expect(firstOrder.kind).toBe('contribution');expect(firstOrder.servicePayment.amount).toBe('0');expect(firstOrder.total).toBe('200000000');
 expect(firstOrder).not.toHaveProperty('archive');expect(firstOrder).not.toHaveProperty('storage');
 await pay(page);await expect(panel(page).getByRole('heading',{name:'Спасибо! Ваш взнос поступил в фонд'})).toBeVisible();
 await expect(panel(page).getByRole('button',{name:'Сделать ещё один взнос'})).toBeEnabled();
 expect((await saved(page,firstKey)).op.localCompletion).toBe('done');expect(await vaultState(page)).toEqual(before);
 expect(await page.evaluate(async bytes=>(await import('/tests/paid-fixture.ts')).transfers(bytes),state.sends[0])).toEqual([{recipient:firstOrder.fundContribution.recipient,lamports:'200000000'}]);
 const receiptDownload=page.waitForEvent('download');await panel(page).getByRole('button',{name:'Скачать квитанцию'}).click();
 const receipt=JSON.parse(await readFile(await(await receiptDownload).path(),'utf8'));
 expect(receipt).toMatchObject({schema:'sejire/contribution-receipt/v1',status:'verified',orderId:firstOrder.id,serviceLamports:'0',contributionLamports:'200000000',fundRecipient:firstOrder.fundContribution.recipient,paymentSignature:state.snapshot.record.payment.signature,feeLamports:'5000'});
 expect(receipt).not.toHaveProperty('archive');expect(receipt).not.toHaveProperty('vaultId');
 await page.screenshot({path:testInfo.outputPath('contribution-complete-mobile.png'),fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await panel(page).getByRole('button',{name:'Сделать ещё один взнос'}).click();await expect(amountInput(page)).toHaveValue('0');
 await expect(panel(page).getByRole('button',{name:'Только помочь другим',exact:true})).toBeDisabled();expect(state.creates).toBe(1);
 await amountInput(page).fill('0.000000001');await prepare(page,{contribution:true,wallet:'Solflare'});await pay(page);
 await expect(panel(page).getByRole('button',{name:'Сделать ещё один взнос'})).toBeEnabled();
 expect(state.key).not.toBe(firstKey);expect(state.creates).toBe(2);expect(state.sends).toHaveLength(2);expect(await page.evaluate(()=>window.paidWallet.signCount)).toBe(2);
 expect(state.requests.some(value=>value.endsWith('/execute'))).toBe(false);expect(state.archive).toBeNull();expect(await vaultState(page)).toEqual(before);expect(state.denied).toEqual([]);
});

test('an uncertain standalone payment resumes the original intent after reload even when new contributions are disabled',async({page,context})=>{
 const state=await installNetwork(context);await standalone(page);await amountInput(page).fill('0.15');await prepare(page,{contribution:true});
 const original=await saved(page,state.key);await page.evaluate(()=>{window.paidWallet.unknown=true;});await pay(page);
 await expect(panel(page).getByRole('heading',{name:'Проверяем оплату'})).toBeVisible();state.unknownSignature=await page.evaluate(()=>window.paidWallet.signature);
 state.ready=false;state.contributionReady=false;await page.reload();await expect(panel(page)).toHaveCount(0);
 await page.getByRole('button',{name:helpName,exact:true}).click();await expect(panel(page).getByRole('heading',{name:'Проверяем оплату'})).toBeVisible();
 await expect(panel(page).getByRole('button',{name:/Подключить|Подтвердить оплату/})).toHaveCount(0);
 expect(await page.evaluate(()=>Boolean(window.phantom))).toBe(false);
 const resumed=await saved(page,state.key);expect(resumed.op.id).toBe(original.op.id);expect(resumed.op.intent).toEqual(original.op.intent);expect(resumed.op.serialized).toBeNull();
 state.paid=true;await check(page);await expect(panel(page).getByRole('heading',{name:'Спасибо! Ваш взнос поступил в фонд'})).toBeVisible();
 await expect(panel(page).getByRole('button',{name:'Сделать ещё один взнос'})).toBeEnabled();
 expect((await saved(page,state.key)).op.localCompletion).toBe('done');expect(state.creates).toBe(1);expect(state.sends).toEqual([]);expect(state.reserves).toBe(0);
 expect(state.requests.some(value=>value.endsWith('/execute'))).toBe(false);expect(state.denied).toEqual([]);
});

test('an unfinished standalone contribution never opens over the editor or its pending promo preservation',async({page,context})=>{
 const state=await installNetwork(context);await openEditor(page);await openPaid(page);
 await panel(page).getByRole('button',{name:helpName}).click();await amountInput(page).fill('0.1');
 await panel(page).getByRole('button',{name:'Только помочь другим',exact:true}).click();await prepare(page,{contribution:true});
 const contributionKey=state.key;await panel(page).getByRole('button',{name:'Назад',exact:true}).click();
 // A newly opened save returns to its version-choice step; closing that step is explicit.
 await expect(panel(page)).toHaveCount(0);await page.getByRole('dialog').getByRole('button',{name:'Отмена',exact:true}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);
 const pending=await page.evaluate(async()=>{
  const draft=(await import('/src/lib/draftStorage.ts')).loadDraftTree();
  return (await import('/src/lib/checkout/vaultGuard.ts')).saveGuardedFundAttempt({orderId:'e'.repeat(32),envelope:window.paidFamily.envelope,parentTxId:null,treeId:draft.meta.id});
 });
 await page.route('**/api/fund/orders/*',route=>{
  expect(route.request().method()).toBe('GET');
  return json(route,{order:{preservationId:pending.orderId,orderId:pending.orderId,promoRevision:1,archiveSizeBytes:Buffer.byteLength(JSON.stringify(pending.envelope)),archiveDigest:pending.archiveDigest,vaultId:pending.vaultId,parentTxId:null,
   estimatedRewardWinston:'100',reservedRewardWinston:'100',actualRewardWinston:null,arweaveTxId:'B'.repeat(43),status:'SUBMITTED',createdAt:pending.createdAt,uploadedAt:pending.createdAt,verifiedAt:null}});
 });
 await page.getByRole('button',{name:'Сохранить',exact:true}).first().click();
 await expect(page.getByRole('region',{name:'Сохранение по промокоду',exact:true})).toBeVisible();await expect(panel(page)).toHaveCount(0);
 const found=await page.evaluate(async()=>{
  const draft=(await import('/src/lib/draftStorage.ts')).loadDraftTree();
  const guard=await import('/src/lib/checkout/vaultGuard.ts'),journal=await import('/src/lib/checkout/paidJournal.ts');
  const pending=await guard.findPreservationAttempt({treeId:draft.meta.id});
  return {method:pending?.method,paid:await journal.findPaidAttempt({treeId:draft.meta.id}),contribution:(await journal.findContributionAttempt())?.id};
 });
 expect(found).toEqual({method:'promo',paid:null,contribution:contributionKey});expect(state.creates).toBe(1);expect(state.sends).toEqual([]);expect(state.denied).toEqual([]);
});
