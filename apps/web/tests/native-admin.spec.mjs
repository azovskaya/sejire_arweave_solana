import { test, expect } from '@playwright/test';
import bs58 from 'bs58';
const genesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
async function fixtures(page) {
 const forbidden=[],network={tx:null,sends:0,loseResponse:false};
 await page.route('**/*',async route=>{
 const url=route.request().url();
 if(/ardrive|turbo|workers\.dev|\/api\/checkout\//.test(url)){forbidden.push(url);await route.abort();return;}
 if(url.endsWith('/graphql'))return route.fulfill({json:{data:{transactions:{edges:[]}}}});
 if(url.startsWith('https://arweave.net/')){
 const path=new URL(url).pathname;
 if(path==='/info')return route.fulfill({json:{network:'arweave.N.1',height:100,version:5}});
 if(path.startsWith('/price/'))return route.fulfill({contentType:'text/plain',body:'1000'});
 if(path.endsWith('/balance'))return route.fulfill({contentType:'text/plain',body:'100000'});
 throw Error('unexpected AR fixture '+path);
 }
 if(url.startsWith('https://api.devnet.solana.com')) {
 const p=route.request().postDataJSON();let result;
 if(p.method==='getBlockHeight')result=100;
 else if(p.method==='getGenesisHash')result=genesis;
 else if(p.method==='getLatestBlockhash')result={context:{slot:100},value:{blockhash:'11111111111111111111111111111111',lastValidBlockHeight:200}};
 else if(p.method==='getFeeForMessage')result={context:{slot:100},value:5000};
 else if(p.method==='getBalance')result={context:{slot:100},value:1000000000};
 else if(p.method==='getSignaturesForAddress')result=[];
 else if(p.method==='getSignatureStatuses')result={context:{slot:100},value:network.tx?[{slot:100,err:null,confirmations:null,confirmationStatus:'finalized'}]:[null]};
 else if(p.method==='getTransaction')result=network.tx;
 else if(p.method==='sendTransaction'){network.sends++;network.tx=await page.evaluate(async raw=>(await import('/tests/native-fixture.ts')).decodeBroadcast(raw),p.params[0]);if(network.loseResponse){network.loseResponse=false;await route.abort('failed');return;}result=network.tx.transaction.signatures[0];}
 else throw Error('unexpected RPC fixture '+p.method);
 return route.fulfill({json:{jsonrpc:'2.0',id:p.id,result}});
 }
 if(new URL(url).hostname!=='127.0.0.1'&&new URL(url).hostname!=='localhost'){forbidden.push(url);await route.abort();return;}
 await route.continue();
 });
 await page.addInitScript(()=>localStorage.setItem('sejire.locale','ru'));
 return {forbidden,network};
}
async function setup(page){await page.goto('/#/admin');return page.evaluate(async()=> (await import('/tests/native-fixture.ts')).setup());}
async function advanced(page){const d=page.locator('details.admin-advanced');if(!await d.evaluate(e=>e.open))await d.locator('summary').first().click();}
async function importConfig(page,value){await advanced(page);await page.getByLabel('Доверенный genesis SHA-256',{exact:true}).fill(value.anchor);await page.getByLabel('Импорт конфигурации или задания').setInputFiles({name:'config.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value.chain))});await expect(page.getByRole('status')).toContainText('Подписи и цепочка проверены');}
test('signed three-role configuration, no password, live-format balances, default spending disabled',async({page})=>{
 const f=await fixtures(page),value=await setup(page);await importConfig(page,value);
 await page.getByRole('button',{name:'Кошельки',exact:true}).click();await page.getByRole('button',{name:'Черновик следующей версии'}).click();
 await expect(page.getByLabel('Основная казна SEJIRE',{exact:true})).toHaveValue(value.config.wallets.service);await expect(page.getByLabel('Фонд памяти поколений SEJIRE',{exact:true})).toHaveValue(value.config.wallets.fund);await expect(page.getByLabel('AR-резерв основной казны SEJIRE',{exact:true})).toHaveValue(value.config.wallets.arReserve);
 await page.getByRole('button',{name:'Проверить сети и балансы'}).click();await expect(page.getByRole('article').filter({has:page.getByRole('heading',{name:'Основная казна SEJIRE',exact:true})})).toContainText('1 SOL');
 await expect(page.getByRole('button',{name:'Опубликовать конфигурацию в Arweave (сейчас отключено)'})).toBeDisabled();expect(f.forbidden).toEqual([]);
});
test('tampered configuration rejected and cannot become active',async({page})=>{
 await fixtures(page);const v=await setup(page);v.chain.versions[0].config.serviceLamports='1';await advanced(page);await page.getByLabel('Доверенный genesis SHA-256',{exact:true}).fill(v.anchor);await page.getByLabel('Импорт конфигурации или задания').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(v.chain))});await expect(page.getByRole('alert')).toContainText('untrusted_genesis');
});
test('configuration recovery in clean browser without previous cache or account',async({page,browser})=>{
 await fixtures(page);const v=await setup(page);await importConfig(page,v);const ctx=await browser.newContext();const clean=await ctx.newPage();await fixtures(clean);await clean.goto('/#/admin');await importConfig(clean,v);await expect(clean.getByText(/Подписи проверены · версия 1/)).toBeVisible();await ctx.close();
});
for(const mode of ['plain','fund','donation'])test('portable '+mode+' order: RPC finality, reload reconciliation, no false archive success',async({page})=>{
 const f=await fixtures(page);await page.goto('/#/admin');const v=await page.evaluate(async mode=>(await import('/tests/native-fixture.ts')).jobFixture(mode==='fund',mode==='donation'),mode);f.network.tx=v.tx;
 await advanced(page);await page.getByLabel('Доверенный genesis SHA-256',{exact:true}).fill(v.anchor);await page.getByLabel('Импорт конфигурации или задания').setInputFiles({name:'job.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(v.package))});await expect(page.getByRole('status')).toContainText('Задание проверено');
 await page.getByRole('button',{name:'Сверить оплату через RPC',exact:true}).click();await expect(page.locator('pre').filter({hasText:'Solana finalized'})).toContainText('Архив ещё не считается сохранённым');
 await page.getByRole('button',{name:'Сверить оплату через RPC',exact:true}).click();await expect(page.locator('pre').filter({hasText:'Solana finalized'})).toContainText(mode==='donation'?'fundContribution':'servicePayment');
 if(mode==='fund')await expect(page.locator('pre').filter({hasText:'Solana finalized'})).toContainText('fundContribution');
 await page.reload();await importConfig(page,v);await page.getByRole('button',{name:'Сохранения',exact:true}).click();await page.getByLabel('Выбранный заказ').selectOption(v.job.order.id);await page.getByRole('button',{name:'Сверить оплату через RPC',exact:true}).click();await expect(page.locator('pre').filter({hasText:'Solana finalized'})).toBeVisible();expect(f.forbidden).toEqual([]);
});
async function checkoutConfig(page,v) {
 await page.locator('details.saving-details > summary').click();
 await page.getByLabel('Доверенный genesis SHA-256',{exact:true}).fill(v.anchor);
 await page.getByLabel('Подписанная конфигурация',{exact:true}).setInputFiles({name:'config.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(v.chain))});
 await page.getByRole('button',{name:'Проверить конфигурацию',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('Конфигурация проверена');
}
async function openPreservation(page,family) {
 await page.getByRole('button',{name:'Открыть по 12 словам',exact:true}).click();await page.getByRole('button',{name:'Открыть из файла',exact:true}).click();
 await page.locator('input[type=file]').setInputFiles({name:'archive.json',mimeType:'application/json',buffer:Buffer.from(family.serialized)});await page.getByRole('textbox',{name:'12 слов восстановления SEJIRE'}).fill(family.words);await page.getByRole('button',{name:'Восстановить архив',exact:true}).click();
 await page.getByRole('button',{name:'Сохранить',exact:true}).first().click();await page.getByRole('button',{name:'Сохранить через Solana',exact:true}).click();
}
for(const mode of ['plain','fund','donation'])test('native user UI '+mode+' payment and portable handoff without Turbo or cloud',async({page})=>{
 const f=await fixtures(page);await page.goto('/');const v=await page.evaluate(async()=>(await import('/tests/native-fixture.ts')).setup());
 if(mode==='donation')await page.getByRole('button',{name:'Поддержать сохранение других семей'}).click();else await openPreservation(page,v.family);
 await checkoutConfig(page,v);await page.getByLabel('Добровольный вклад SOL').fill(mode==='plain'?'0':'0.005');await page.getByRole('button',{name:'Подключить Phantom и подписать заказ'}).click();
 await expect(page.getByRole('status')).toContainText('Заказ подписан');await expect(page.locator('dd').filter({hasText:mode==='donation'?/^0 SOL →/:/^0.03 SOL →/})).toBeVisible();
 await page.getByRole('checkbox',{name:'Подтверждаю показанные суммы, сеть и адреса'}).check();await page.getByRole('button',{name:/^Оплатить /}).click();await expect(page.getByRole('status')).toContainText('Оплата подтверждена');
 await page.getByRole('button',{name:'Сверить прежний платёж'}).click();await expect(page.getByRole('status')).toContainText('Solana finalized');expect(f.network.sends).toBe(1);
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Экспорт задания для админки'}).click();expect((await download).suggestedFilename()).toMatch(/^sejire-job-/);expect(f.forbidden).toEqual([]);
});
test('native user wallet rejection, retry, lost reply and browser reload do not make a second payment',async({page})=>{
 const f=await fixtures(page);await page.goto('/');const v=await page.evaluate(async()=>(await import('/tests/native-fixture.ts')).setup());await page.getByRole('button',{name:'Поддержать сохранение других семей'}).click();await checkoutConfig(page,v);await page.getByLabel('Добровольный вклад SOL').fill('0.005');await page.getByRole('button',{name:'Подключить Phantom и подписать заказ'}).click();await expect(page.getByRole('status')).toContainText('Заказ подписан');
 await page.evaluate(()=>window.fixtureWallet.reject=true);await page.getByRole('checkbox',{name:'Подтверждаю показанные суммы, сеть и адреса'}).check();await page.getByRole('button',{name:/^Оплатить /}).click();await expect(page.getByRole('alert')).toContainText('Подпись явно отклонена');expect(f.network.sends).toBe(0);
 await page.evaluate(()=>window.fixtureWallet.reject=false);f.network.loseResponse=true;await page.getByRole('button',{name:/^Оплатить /}).click();await expect(page.getByRole('status')).toContainText('Оплата подтверждена');expect(f.network.sends).toBe(1);
 await page.reload();await page.evaluate(async()=>(await import('/tests/native-fixture.ts')).setup());await page.getByRole('button',{name:'Поддержать сохранение других семей'}).click();await checkoutConfig(page,v);const options=page.getByLabel('Продолжить прежний заказ').locator('option');const id=await options.last().getAttribute('value');await page.getByLabel('Продолжить прежний заказ').selectOption(id);await page.getByRole('button',{name:'Сверить прежний платёж'}).click();await expect(page.getByRole('status')).toContainText('Solana finalized');expect(f.network.sends).toBe(1);expect(f.forbidden).toEqual([]);
});

test('new installation starts guided setup, hides technical JSON, and reviews without money',async({page})=>{
 const f=await fixtures(page);await page.goto('/#/admin');await expect(page.getByRole('heading',{name:'Настроим SEJIRE',exact:true})).toBeVisible();await expect(page.getByLabel('JSON конфигурации')).not.toBeVisible();await expect(page.getByText('Режим просмотра',{exact:true})).toBeVisible();
 const v=await page.evaluate(async()=>(await import('/tests/native-fixture.ts')).setup());
 await page.getByRole('button',{name:'Далее',exact:true}).click();await page.getByRole('button',{name:'Подключить Phantom',exact:true}).click();await page.getByRole('button',{name:'Далее',exact:true}).click();
 await page.getByLabel('Адрес основной казны',{exact:true}).fill(v.config.wallets.service);await page.getByRole('button',{name:'Далее',exact:true}).click();await page.getByLabel('Адрес фонда',{exact:true}).fill(v.config.wallets.service);await expect(page.getByRole('button',{name:'Далее',exact:true})).toBeDisabled();await page.getByLabel('Адрес фонда',{exact:true}).fill(v.config.wallets.fund);await page.getByRole('button',{name:'Далее',exact:true}).click();await page.getByLabel('Адрес AR-резерва',{exact:true}).fill(v.config.wallets.arReserve);await page.getByRole('button',{name:'Далее',exact:true}).click();await expect(page.getByRole('heading',{name:'Проверьте настройки',exact:true})).toBeVisible();await expect(page.locator('.admin-summary')).toContainText('0.03 SOL');expect(f.network.sends).toBe(0);
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Подписать и создать конфигурацию',exact:true}).click();const anchorDownload=await download;expect(anchorDownload.suggestedFilename()).toBe('sejire-trust-anchor.json');const {readFile}=await import('node:fs/promises');const anchorBytes=await readFile(await anchorDownload.path());const configDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Скачать подписанную конфигурацию',exact:true}).click();const configBytes=await readFile(await (await configDownload).path());const exported=JSON.parse(configBytes.toString());expect(exported.versions[0].signatures).toHaveLength(1);expect(exported.versions[0].acceptance).toHaveLength(1);const clean=await page.context().browser().newContext();const other=await clean.newPage();await fixtures(other);await other.goto('/#/admin');await other.getByText('Уже есть настройки SEJIRE? Восстановить',{exact:true}).click();await other.getByLabel('Файл доверия',{exact:true}).setInputFiles({name:'sejire-trust-anchor.json',mimeType:'application/json',buffer:anchorBytes});await other.getByLabel('Подписанная конфигурация для восстановления',{exact:true}).setInputFiles({name:'config.json',mimeType:'application/json',buffer:configBytes});await expect(other.getByRole('heading',{name:'Настроим SEJIRE',exact:true})).not.toBeVisible();await expect(other.getByRole('heading',{name:'Состояние SEJIRE',exact:true})).toBeVisible();await clean.close();await expect(page.getByRole('heading',{name:'Конфигурация SEJIRE создана',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Настроим SEJIRE',exact:true})).not.toBeVisible();expect(f.network.sends).toBe(0);expect(f.forbidden).toEqual([]);
});
test('trusted owner dashboard and wallet cards; viewer cannot apply unsigned changes',async({page})=>{
 await fixtures(page);const v=await setup(page);await importConfig(page,v);await page.locator('details.admin-advanced > summary').click();await expect(page.getByRole('heading',{name:'Состояние SEJIRE',exact:true})).toBeVisible();await expect(page.getByRole('article').filter({has:page.getByRole('heading',{name:'Цена хранения',exact:true})})).toContainText('0.03 SOL');await page.getByRole('button',{name:'Проверить состояние системы',exact:true}).click();await expect(page.getByRole('article').filter({has:page.getByRole('heading',{name:'Основная казна SEJIRE',exact:true})})).toContainText('1 SOL');await expect(page.getByRole('article').filter({has:page.getByRole('heading',{name:'AR-резерв',exact:false})})).toContainText('0.0000001 AR');
 await page.getByRole('button',{name:'Кошельки',exact:true}).click();for(const name of ['Основная казна SEJIRE','Фонд памяти поколений','AR-резерв хранения'])await expect(page.getByRole('heading',{name,exact:true})).toBeVisible();await page.getByRole('button',{name:'Настройки',exact:true}).click();await expect(page.getByRole('button',{name:'Подписать изменения',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Проверить и применить изменения',exact:true})).toBeDisabled();
 await advanced(page);for(const name of ['Доверенный genesis SHA-256','JSON конфигурации','Solana RPC','Arweave узлы'])await expect(page.getByLabel(name,{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Проверить и применить подписанную версию',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Подтвердить управляющий Phantom',exact:true}).click();await expect(page.getByText('Управляющий кошелёк подтверждён',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Подготовить изменение настроек',exact:true}).click();await page.getByLabel('Цена сохранения (SOL)',{exact:true}).fill('0.04');await page.getByLabel('Цена сохранения (SOL)',{exact:true}).blur();await page.getByRole('button',{name:'Проверить и применить изменения',exact:true}).click();await expect(page.getByRole('alert')).toContainText('management_threshold');await expect(page.getByText(/Подписи проверены · версия 1/)).toBeVisible();
});
test('mobile admin retains setup, menu and advanced with no horizontal page overflow',async({page})=>{
 await fixtures(page);await page.setViewportSize({width:390,height:844});await page.goto('/#/admin');await expect(page.getByRole('heading',{name:'Настроим SEJIRE',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Далее',exact:true})).toBeVisible();await page.getByRole('button',{name:'Кошельки',exact:true}).click();await expect(page.getByRole('heading',{name:'Кошельки проекта',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await advanced(page);await expect(page.getByLabel('JSON конфигурации')).toBeVisible();
});

test('missing wallet is understandable; account change and rejected message remove manager access',async({page})=>{
 await fixtures(page);await page.goto('/#/admin');await page.getByRole('button',{name:'Далее',exact:true}).click();await page.getByRole('button',{name:'Подключить Phantom',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Phantom не найден');
 const v=await page.evaluate(async()=>(await import('/tests/native-fixture.ts')).setup());await importConfig(page,v);await page.getByRole('button',{name:'Настройки',exact:true}).click();await page.evaluate(()=>window.fixtureWallet.rejectMessage=true);await page.getByRole('button',{name:'Подтвердить управляющий Phantom',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Подпись отменена');await expect(page.getByRole('button',{name:'Подписать изменения',exact:true})).toBeDisabled();
 await page.evaluate(()=>window.fixtureWallet.rejectMessage=false);await page.getByRole('button',{name:'Подтвердить управляющий Phantom',exact:true}).click();await expect(page.getByText('Управляющий кошелёк подтверждён',{exact:true})).toBeVisible();await page.evaluate(()=>window.fixtureWallet.emit('accountChanged'));await expect(page.getByText('Режим просмотра',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Подписать изменения',exact:true})).toBeDisabled();
});

test('signed address rotation preserves old order and RPC payment recipients',async({page})=>{
 const f=await fixtures(page);await page.goto('/#/admin');const v=await page.evaluate(async()=>(await import('/tests/native-fixture.ts')).jobFixture(false,false));f.network.tx=v.tx;await advanced(page);await page.getByLabel('Доверенный genesis SHA-256',{exact:true}).fill(v.anchor);await page.getByLabel('Импорт конфигурации или задания').setInputFiles({name:'job.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(v.package))});await expect(page.getByRole('status')).toContainText('Задание проверено');await page.getByRole('button',{name:'Подтвердить управляющий Phantom',exact:true}).click();await page.getByRole('button',{name:'Кошельки',exact:true}).click();const card=page.getByRole('article').filter({has:page.getByRole('heading',{name:'Основная казна SEJIRE',exact:true})});await card.getByRole('button',{name:'Заменить адрес',exact:true}).click();const next=bs58.encode(new Uint8Array(32).fill(4));await page.getByLabel('Новый публичный адрес Основная казна SEJIRE',{exact:true}).fill(next);await page.getByRole('button',{name:'Подписать замену адреса',exact:true}).click();await page.getByRole('button',{name:'Применить подписанную замену',exact:true}).click();await expect(page.getByText(/Подписи проверены · версия 2/)).toBeVisible();await page.getByRole('button',{name:'Сохранения',exact:true}).click();await page.getByRole('button',{name:'Сверить оплату через RPC',exact:true}).click();const result=page.locator('pre').filter({hasText:'Solana finalized'});await expect(result).toContainText(v.config.wallets.service);await expect(result).not.toContainText(next);expect(f.network.sends).toBe(0);
});
test('network failure never invents a treasury balance or readiness',async({page})=>{
 await fixtures(page);const v=await setup(page);await importConfig(page,v);await page.route('https://api.devnet.solana.com*',route=>route.fulfill({status:429,body:'rate limited'}));await page.getByRole('button',{name:'Проверить состояние системы',exact:true}).click();await expect(page.locator('.admin-status')).toContainText('Ошибка сети');await expect(page.getByRole('article').filter({has:page.getByRole('heading',{name:'Основная казна SEJIRE',exact:true})})).toContainText('Нет данных');
});

test('public balances never wait for history and history failure preserves them',async({page})=>{
 await fixtures(page);const v=await setup(page);await importConfig(page,v);let history=0;
 await page.route('https://api.devnet.solana.com*',async route=>{const p=route.request().postDataJSON();if(p.method==='getSignaturesForAddress'){history++;return;}await route.fallback();});
 await page.getByRole('button',{name:'Проверить состояние системы',exact:true}).click();const card=page.getByRole('article').filter({has:page.getByRole('heading',{name:'Основная казна SEJIRE',exact:true})});await expect(card).toContainText('1 SOL');expect(history).toBe(0);
 await advanced(page);await page.getByRole('button',{name:'Загрузить историю основной казны',exact:true}).click();await expect(card).toContainText('1 SOL');await expect(page.getByRole('alert')).toContainText('rpc-timeout',{timeout:15000});await expect(card).toContainText('1 SOL');expect(history).toBe(1);
});
test('HTTP 429 is diagnosed separately; other treasury and AR remain visible',async({page})=>{
 await fixtures(page);const v=await setup(page);await importConfig(page,v);
 await page.route('https://api.devnet.solana.com*',async route=>{const p=route.request().postDataJSON();if(p.method==='getBalance'&&p.params[0]===v.config.wallets.service)return route.fulfill({status:429,headers:{'Retry-After':'60'},body:'rate limited'});await route.fallback();});
 await page.getByRole('button',{name:'Проверить состояние системы',exact:true}).click();await expect(page.getByRole('article').filter({has:page.getByRole('heading',{name:'Фонд памяти поколений',exact:true})})).toContainText('1 SOL');await expect(page.getByRole('article').filter({has:page.getByRole('heading',{name:'AR-резерв',exact:false})})).toContainText('0.0000001 AR');await expect(page.getByText('Основная казна: rpc-rate-limited',{exact:true})).toBeVisible();await expect(page.getByRole('article').filter({has:page.getByRole('heading',{name:'Основная казна SEJIRE',exact:true})})).toContainText('Нет данных');await advanced(page);await expect(page.locator('pre').filter({hasText:'diagnostics'})).toContainText('429');
});
test('wrong genesis rejects SOL balances without hiding AR',async({page})=>{
 await fixtures(page);const v=await setup(page);await importConfig(page,v);let balances=0;
 await page.route('https://api.devnet.solana.com*',async route=>{const p=route.request().postDataJSON();if(p.method==='getBlockHeight')result=100;
 else if(p.method==='getGenesisHash')return route.fulfill({json:{jsonrpc:'2.0',id:p.id,result:'wrong-genesis'}});if(p.method==='getBalance')balances++;await route.fallback();});
 await page.getByRole('button',{name:'Проверить состояние системы',exact:true}).click();await expect(page.locator('.admin-status')).toContainText('Ошибка сети');await expect(page.getByRole('article').filter({has:page.getByRole('heading',{name:'Основная казна SEJIRE',exact:true})})).toContainText('Нет данных');await expect(page.getByRole('article').filter({has:page.getByRole('heading',{name:'AR-резерв',exact:false})})).toContainText('0.0000001 AR');expect(balances).toBe(0);
});
test('real deadline reports timeout; second balance appears before timeout; stale value is marked',async({page})=>{
 await fixtures(page);const v=await setup(page);await importConfig(page,v);await page.getByRole('button',{name:'Проверить состояние системы',exact:true}).click();const service=page.getByRole('article').filter({has:page.getByRole('heading',{name:'Основная казна SEJIRE',exact:true})});await expect(service).toContainText('1 SOL');await expect(page.getByRole('button',{name:'Проверить состояние системы',exact:true})).toBeEnabled();
 await page.route('https://api.devnet.solana.com*',async route=>{const p=route.request().postDataJSON();if(p.method==='getBalance'&&p.params[0]===v.config.wallets.service)return;await route.fallback();});await page.getByRole('button',{name:'Проверить состояние системы',exact:true}).click();await expect(page.getByRole('article').filter({has:page.getByRole('heading',{name:'Фонд памяти поколений',exact:true})})).toContainText('1 SOL');await expect(page.getByText('Основная казна: rpc-timeout',{exact:true})).toBeVisible({timeout:25000});await expect(service).toContainText('1 SOL');await expect(service).toContainText('обновить не удалось');
});
