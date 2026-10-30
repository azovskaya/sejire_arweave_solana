import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import bs58 from 'bs58';

const origin='http://127.0.0.1:5185', tx='A'.repeat(43);
const panel=page=>page.getByRole('region',{name:'Оплата SOL',exact:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
const networkState=()=>({ready:true,contributionReady:true,balance:'1000000000000000',requests:[],denied:[],creates:0,admissions:0,createKeys:[],bodies:[],prepares:0,reserves:0,sends:[],cancels:0,reconciles:0,
  recoveries:0,recoveryTransitions:{},lostRecovery:false,recoveryFee:'6000',recoveryError:null,recoveryGate:null,
  finish:false,paid:false,phase:'queued',createError:null,lostCreate:false,lostReserve:false,lostSend:false,lostVerify:false,lostCancel:false,
  wrongGenesis:false,wrongOrder:false,feeNull:false,rpcUnavailable:false,height:50,snapshot:null,archive:null,key:null,unknownSignature:null,dropBeforeAdmission:false,tombstone:false});

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
   s.record.pendingSignature=signature;s.record.payment={signature,feeLamports:s.preparation?.feeLamports??'5000'};
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
    if(state.createError)return json(route,{error:state.createError},503);
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
   if(method==='POST'&&path===`/orders/${order.id}/recover`){
    state.recoveries++;
    expect(Object.keys(body)).toEqual(['preparationId']);
    if(state.snapshot.record.pendingSignature||state.snapshot.record.payment)return json(route,{error:'previous_payment_unresolved'},409);
    const stored=await page.evaluate(async key=>(await import('/src/lib/checkout/paidJournal.ts')).readPaidOperation(key),state.key);
    expect(stored.recoveryRequestedFor).toBe(body.preparationId);
    expect(stored.signature).toBeUndefined();expect(stored.signedTransaction).toBeUndefined();
    if(state.recoveryGate)await state.recoveryGate;
    if(state.recoveryError)return json(route,{error:state.recoveryError},409);
    if(!state.recoveryTransitions[body.preparationId]){
     expect(body.preparationId).toBe(state.snapshot.preparation.preparationId);
     state.snapshot.preparation=await page.evaluate(async({snapshot,generation,fee})=>(await import('/tests/paid-fixture.ts')).recoveredPreparation(snapshot,generation,fee),
      {snapshot:state.snapshot,generation:Object.keys(state.recoveryTransitions).length+1,fee:state.recoveryFee});
     state.recoveryTransitions[body.preparationId]=state.snapshot.preparation.preparationId;
     state.snapshot.verification=null;
    }
    expect(state.recoveryTransitions[body.preparationId]).toBe(state.snapshot.preparation.preparationId);
    if(state.lostRecovery){state.lostRecovery=false;return route.abort('failed');}
    return json(route,await update(page));
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
   if(state.rpcUnavailable)return json(route,{error:'temporarily_unavailable'},503);
   if(body.method==='getGenesisHash')result=state.wrongGenesis?'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d':'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
   else if(body.method==='getBalance')return route.fulfill({contentType:'application/json',body:`{"jsonrpc":"2.0","id":${JSON.stringify(body.id)},"result":{"value":${state.balance}}}`});
   else if(body.method==='getFeeForMessage')result={value:state.feeNull?null:Number(state.snapshot?.preparation?.feeLamports??'5000')};
   else if(body.method==='getBlockHeight')result=state.height;
   else if(body.method==='sendTransaction'){
    expect(state.reserves).toBeGreaterThan(0);
    result=bs58.encode(Buffer.from(body.params[0],'base64').subarray(1,65));
    expect(result).toBe(state.snapshot.record.pendingSignature);
    const stored=await page.evaluate(async key=>(await import('/src/lib/checkout/paidJournal.ts')).readPaidOperation(key),state.key);
    expect(body.params[0]).toBe(stored.signedTransaction);
    state.sends.push(body.params[0]);state.paid=true;
    if(state.lostSend){state.lostSend=false;return route.abort('failed');}
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
async function resumePaid(page){
 if(!(await panel(page).count()))await page.getByRole('button',{name:'Продолжить сохранение',exact:true}).first().click();
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

test('disabled policy keeps encrypted backup available and never calls a wallet',async({page,context})=>{
 const state=await installNetwork(context);state.ready=false;await openEditor(page);await openPaid(page);
 await expect(panel(page)).toContainText('Оплата через Solana пока недоступна');
 await expect(panel(page).getByRole('button',{name:/Оплатить/})).toHaveCount(0);
 await panel(page).getByText('Подробнее',{exact:true}).click();
 await expect(panel(page).getByRole('button',{name:'Скачать зашифрованную копию'})).toBeVisible();
 expect(state.creates).toBe(0);expect(await page.evaluate(()=>window.paidWallet.connects)).toBe(0);
});

test('one click connects Phantom, signs once, completes one archive and restores it',async({page,context,browser})=>{
 const state=await installNetwork(context);await openEditor(page);await openPaid(page);
 const button=panel(page).getByRole('button',{name:'Оплатить 0.03 SOL и сохранить'});
 await expect(button).toBeVisible();await expect(panel(page)).toContainText('Комиссия Solana отдельно: уточняется');
 await expect(panel(page).getByRole('checkbox')).toHaveCount(0);
 await expect(panel(page).getByRole('button',{name:/Подключить Phantom|Подтвердить оплату|Обновить подтверждение|Восстановить подтверждение|Проверить статус/})).toHaveCount(0);
 await button.click();await expect.poll(()=>state.sends.length).toBe(1);
 expect(state.creates).toBe(1);expect(state.admissions).toBe(1);expect(state.reserves).toBe(1);
 expect(await page.evaluate(()=>({connects:window.paidWallet.connects,signs:window.paidWallet.signCount}))).toEqual({connects:1,signs:1});
 state.finish=true;await expect.poll(async()=>(await saved(page,state.key)).op.localCompletion,{timeout:30000}).toBe('done');
 const result=await saved(page,state.key);expect(result.archive).toBe(state.archive);expect(result.op.localCompletion).toBe('done');
 await cleanRestore(browser,state,await page.evaluate(()=>window.paidFamily.words),result.op.snapshot.execution.receipt);
 expect(state.sends).toHaveLength(1);expect(state.creates).toBe(1);
});

test('Phantom rejection is visible and an explicit retry reuses the same order and connection',async({page,context})=>{
 const state=await installNetwork(context);await openEditor(page);await openPaid(page);
 await page.evaluate(()=>{window.paidWallet.reject=true;});
 await panel(page).getByRole('button',{name:'Оплатить 0.03 SOL и сохранить'}).click();
 await expect(panel(page).getByRole('alert')).toContainText('Кошелёк отклонил подпись');
 expect(state.creates).toBe(1);expect(state.sends).toHaveLength(0);
 await page.evaluate(()=>{window.paidWallet.reject=false;});
 await panel(page).getByRole('button',{name:'Оплатить 0.03 SOL и сохранить'}).click();
 await expect.poll(()=>state.sends.length).toBe(1);
 expect(state.creates).toBe(1);expect(await page.evaluate(()=>window.paidWallet.connects)).toBe(1);
 expect(await page.evaluate(()=>window.paidWallet.signCount)).toBe(2);
});

test('unknown wallet outcome remains visible through polling and reload without another signature',async({page,context})=>{
 const state=await installNetwork(context);await openEditor(page);await openPaid(page);
 await page.evaluate(()=>{window.paidWallet.unknown=true;});
 await panel(page).getByRole('button',{name:'Оплатить 0.03 SOL и сохранить'}).click();
 await expect(panel(page).getByRole('alert')).toContainText('Phantom не вернул надёжный результат');
 await page.waitForTimeout(6500);
 await expect(panel(page).getByRole('alert')).toContainText('Phantom не вернул надёжный результат');
 expect(state.sends).toHaveLength(0);expect(state.creates).toBe(1);
 await page.reload();await resumePaid(page);await expect(panel(page).getByRole('button',{name:'Продолжить сохранение'})).toBeVisible();
 expect(state.sends).toHaveLength(0);expect(state.creates).toBe(1);
});

test('insufficient balance, null fee and unavailable RPC never ask Phantom to sign',async({page,context})=>{
 const state=await installNetwork(context);await openEditor(page);await openPaid(page);
 state.balance='100';await panel(page).getByRole('button',{name:'Оплатить 0.03 SOL и сохранить'}).click();
 await expect(panel(page).getByRole('alert')).toContainText('недостаточно SOL');
 state.balance='1000000000000000';state.feeNull=true;
 await panel(page).getByRole('button',{name:'Оплатить 0.03 SOL и сохранить'}).click();
 await expect(panel(page).getByRole('alert')).toContainText('комиссию сети');
 state.feeNull=false;state.rpcUnavailable=true;
 await panel(page).getByRole('button',{name:'Оплатить 0.03 SOL и сохранить'}).click();
 await expect(panel(page).getByRole('alert')).toContainText('Сеть Solana временно недоступна');
 expect(await page.evaluate(()=>window.paidWallet.signCount)).toBe(0);expect(state.creates).toBe(1);expect(state.sends).toHaveLength(0);
});

test('wrong Solana genesis fails closed before signing',async({page,context})=>{
 const state=await installNetwork(context);state.wrongGenesis=true;await openEditor(page);await openPaid(page);
 await panel(page).getByRole('button',{name:'Оплатить 0.03 SOL и сохранить'}).click();
 await expect(panel(page).getByRole('alert')).toContainText('Сеть Solana');
 expect(await page.evaluate(()=>window.paidWallet.signCount)).toBe(0);expect(state.creates).toBe(1);expect(state.sends).toHaveLength(0);
});

test('expired unsigned blockhash is renewed for the same order before one wallet request',async({page,context})=>{
 const state=await installNetwork(context);state.height=101;await openEditor(page);await openPaid(page);
 await panel(page).getByRole('button',{name:'Оплатить 0.03 SOL и сохранить'}).click();
 await expect.poll(()=>state.recoveries).toBe(1);await expect.poll(()=>state.sends.length).toBe(1);
 expect(state.creates).toBe(1);expect(await page.evaluate(()=>window.paidWallet.signCount)).toBe(1);
});

test('lost create response resumes the original idempotency key, ciphertext and order',async({page,context})=>{
 const state=await installNetwork(context);state.lostCreate=true;await openEditor(page);await openPaid(page);
 await panel(page).getByRole('button',{name:'Оплатить 0.03 SOL и сохранить'}).click();
 await expect(panel(page).getByRole('alert')).toBeVisible();expect(state.admissions).toBe(1);
 await page.reload();await resumePaid(page);await panel(page).getByRole('button',{name:'Продолжить сохранение'}).click();
 await expect.poll(()=>state.sends.length).toBe(1);
 expect(state.creates).toBe(1);expect(state.admissions).toBe(1);expect(state.bodies[0].serialized).toBe(state.archive);
});

test('request lost before admission retries only the stored idempotency key',async({page,context})=>{
 const state=await installNetwork(context);state.dropBeforeAdmission=true;await openEditor(page);await openPaid(page);
 await panel(page).getByRole('button',{name:'Оплатить 0.03 SOL и сохранить'}).click();
 await expect(panel(page).getByRole('alert')).toBeVisible();expect(state.admissions).toBe(0);
 await panel(page).getByRole('button',{name:'Продолжить сохранение'}).click();
 await expect.poll(()=>state.sends.length).toBe(1);
 expect(state.creates).toBe(2);expect(new Set(state.createKeys).size).toBe(1);expect(state.admissions).toBe(1);
 expect(state.bodies[0].serialized).toBe(state.bodies[1].serialized);
});

test('lost reserve response persists signed bytes and reconciles without a second signature',async({page,context})=>{
 const state=await installNetwork(context);state.lostReserve=true;await openEditor(page);await openPaid(page);
 await panel(page).getByRole('button',{name:'Оплатить 0.03 SOL и сохранить'}).click();
 await expect(panel(page).getByRole('alert')).toBeVisible();
 const prior=await saved(page,state.key);expect(prior.op.signature).toBeTruthy();expect(prior.op.signedTransaction).toBeTruthy();
 await panel(page).getByRole('button',{name:'Продолжить сохранение'}).click();
 await expect.poll(()=>state.sends.length).toBe(1);
 expect(state.creates).toBe(1);expect(await page.evaluate(()=>window.paidWallet.signCount)).toBe(1);
});

test('lost send response reconciles one transaction and never signs a replacement',async({page,context})=>{
 const state=await installNetwork(context);state.lostSend=true;await openEditor(page);await openPaid(page);
 await panel(page).getByRole('button',{name:'Оплатить 0.03 SOL и сохранить'}).click();
 await expect.poll(()=>state.sends.length).toBe(1);
 await panel(page).getByText('Подробнее',{exact:true}).click();
 await panel(page).getByRole('button',{name:'Проверить статус'}).click();
 expect(state.creates).toBe(1);expect(state.sends).toHaveLength(1);
 expect(await page.evaluate(()=>window.paidWallet.signCount)).toBe(1);
});

test('lost verify response and later Arweave completion reuse the paid order',async({page,context})=>{
 const state=await installNetwork(context);state.lostVerify=true;await openEditor(page);await openPaid(page);
 await panel(page).getByRole('button',{name:'Оплатить 0.03 SOL и сохранить'}).click();
 await expect.poll(()=>state.sends.length).toBe(1);
 await expect(panel(page).getByRole('alert')).toBeVisible();
 await panel(page).getByRole('button',{name:'Продолжить сохранение'}).click();
 state.finish=true;await expect.poll(async()=>(await saved(page,state.key)).op.localCompletion,{timeout:30000}).toBe('done');
 expect(state.creates).toBe(1);expect(state.sends).toHaveLength(1);
 expect(await page.evaluate(()=>window.paidWallet.signCount)).toBe(1);
});

test('a late Phantom result keeps signed bytes after the page closes its panel',async({page,context})=>{
 const state=await installNetwork(context);await openEditor(page);await openPaid(page);
 await page.evaluate(()=>{window.paidWallet.hold=true;});
 await panel(page).getByRole('button',{name:'Оплатить 0.03 SOL и сохранить'}).evaluate(button=>button.click());
 await expect.poll(()=>page.evaluate(()=>window.paidWallet.signCount)).toBe(1);
 await page.evaluate(()=>{location.hash='#/restore';});
 await expect(panel(page)).toHaveCount(0);
 await page.evaluate(()=>{window.paidWallet.hold=false;window.paidWallet.release();});
 await expect.poll(async()=>Boolean((await saved(page,state.key)).op.signature)).toBe(true);
 expect(state.creates).toBe(1);expect(state.sends).toHaveLength(0);
});

test('expiry while Phantom is open keeps the late signature and does not create a replacement',async({page,context})=>{
 const state=await installNetwork(context);await openEditor(page);await openPaid(page);
 await page.evaluate(()=>{window.paidWallet.hold=true;});
 await panel(page).getByRole('button',{name:'Оплатить 0.03 SOL и сохранить'}).evaluate(button=>button.click());
 await expect.poll(()=>page.evaluate(()=>window.paidWallet.signCount)).toBe(1);
 state.height=101;
 await page.evaluate(()=>{window.paidWallet.hold=false;window.paidWallet.release();});
 await expect.poll(async()=>Boolean((await saved(page,state.key)).op.signature)).toBe(true);
 expect(state.creates).toBe(1);expect(state.sends).toHaveLength(0);
});

test('double click and a second tab keep one operation and one wallet signature',async({page,context})=>{
 const state=await installNetwork(context);await openEditor(page);await openPaid(page);
 await page.evaluate(()=>{window.paidWallet.hold=true;});
 await panel(page).getByRole('button',{name:'Оплатить 0.03 SOL и сохранить'}).evaluate(button=>{button.click();button.click();});
 await expect.poll(()=>page.evaluate(()=>window.paidWallet.signCount)).toBe(1);
 const family=await page.evaluate(()=>window.paidFamily);
 const other=await context.newPage();await other.goto(origin);
 await other.getByRole('button',{name:'Открыть по 12 словам',exact:true}).click();
 await other.getByRole('button',{name:'Открыть из файла',exact:true}).click();
 await other.locator('input[type=file]').setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from(family.serialized)});
 await other.evaluate(words=>{window.secondFamily={words};},family.words);await enterWords(other,'secondFamily');
 await other.getByRole('button',{name:'Восстановить архив',exact:true}).click();
 await other.evaluate(async()=>(await import('/tests/paid-fixture.ts')).installWallet());
 await resumePaid(other);
 await page.evaluate(()=>{window.paidWallet.hold=false;window.paidWallet.release();});
 await expect(panel(other).getByRole('button',{name:'Продолжить сохранение'})).toBeVisible();
 await panel(other).getByRole('button',{name:'Продолжить сохранение'}).click();
 await expect.poll(()=>state.sends.length).toBe(1);
 expect(state.creates).toBe(1);expect(await other.evaluate(()=>window.paidWallet.signCount)).toBe(0);
});

test('confirmed payment continues one Arweave archive after reload without another wallet call',async({page,context})=>{
 const state=await installNetwork(context);await openEditor(page);await openPaid(page);
 await panel(page).getByRole('button',{name:'Оплатить 0.03 SOL и сохранить'}).click();
 await expect.poll(()=>state.sends.length).toBe(1);state.phase='requires-reconciliation';
 await page.reload();await resumePaid(page);await expect(panel(page).getByRole('button',{name:'Продолжить сохранение'})).toBeVisible();
 expect(state.creates).toBe(1);expect(state.sends).toHaveLength(1);
 state.finish=true;await expect.poll(async()=>(await saved(page,state.key)).op.localCompletion,{timeout:30000}).toBe('done');
 expect(state.creates).toBe(1);expect(state.sends).toHaveLength(1);
});
