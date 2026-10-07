import {createHash} from 'node:crypto';
import {test,expect} from '@playwright/test';

const TX_ID='L'.repeat(43);
const PAYER='F8XB2iSMf8mB6fPhtwGRDjuT8wTypfARN5pscu3fjqKN';
const sha=text=>createHash('sha256').update(text).digest('hex');

async function cleanRecovery(browser,preparer,mode='success') {
  await preparer.goto('/');
  const family=await preparer.evaluate(async()=> (await import('/tests/browser-fixture.ts')).fixture());
  const original=family.serialized;
  const raw=mode==='wrong-vault'
    ? JSON.stringify({...family.envelope,vault_id:'f'.repeat(32)})
    : mode==='corrupt' ? original.slice(0,-1)+'x' : original;
  const pilot={version:'synthetic-cross-browser-v1',vaultId:family.vault.vault_id,
    archiveDigest:sha(mode==='wrong-vault'?raw:original),archiveBytes:Buffer.byteLength(mode==='wrong-vault'?raw:original),
    payer:PAYER,txId:TX_ID};
  const saveId=sha(['sejire-preservation-v2',pilot.version,pilot.vaultId,pilot.archiveDigest,pilot.payer].join('\0'));
  const context=await browser.newContext({locale:'ru-RU'});
  expect((await context.storageState()).origins).toEqual([]);
  const fresh=await context.newPage();
  const counts={vaultQueries:0,saveQueries:0,idQueries:0,rawPrimary:0,rawFallback:0,rendered:0,writes:0};
  await fresh.addInitScript(binding=>{
    window.__SEJIRE_V2_RECOVERY_TEST_PILOT__=binding;
    window.__recoveryWalletCalls=0;
    window.phantom={solana:{connect:async()=>{window.__recoveryWalletCalls++;throw Error('unexpected Phantom');}}};
    window.arweaveWallet={connect:async()=>{window.__recoveryWalletCalls++;throw Error('unexpected Wander');},
      sign:async()=>{window.__recoveryWalletCalls++;throw Error('unexpected Wander signing');}};
  },pilot);
  await context.route('https://**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/graphql'){
      const body=route.request().postDataJSON();
      const edge={node:{id:TX_ID,block:{timestamp:1_700_000_000,height:1},tags:[
        {name:'App-Name',value:'SEJIRE'},{name:'Type',value:'vault-envelope'},{name:'Save-Id',value:saveId}]}};
      let edges=[];
      if(body.query.includes('Vault-Id')) counts.vaultQueries++;
      else if(body.query.includes('Save-Id')){counts.saveQueries++;if(mode!=='unindexed')edges=[edge];}
      else if(body.query.includes('transactions(ids:')){counts.idQueries++;edges=[edge];}
      else throw Error('unexpected GraphQL query');
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:{transactions:{edges}}})});
      return;
    }
    if(url.pathname===`/${TX_ID}`){counts.rendered++;await route.fulfill({status:302,headers:{Location:'/rendered-html'}});return;}
    if(url.pathname===`/raw/${TX_ID}`){
      if(url.hostname==='arweave.net'){
        counts.rawPrimary++;await route.fulfill({status:503,body:'gateway unavailable'});return;
      }
      counts.rawFallback++;
      await route.fulfill(mode==='gateway-down'?{status:503,body:'gateway unavailable'}:
        {status:200,contentType:'application/octet-stream',body:raw});
      return;
    }
    if(route.request().method()!=='GET')counts.writes++;
    await route.abort();
  });
  await fresh.goto('/');
  const before=await fresh.evaluate(async()=>({
    local:Object.keys(localStorage).filter(key=>key.includes('envelope')||key.includes('vault')),
    session:sessionStorage.length,
    databases:(await indexedDB.databases()).map(db=>db.name),
  }));
  expect(before.local).toEqual([]);
  expect(before.session).toBe(0);
  expect(before.databases).not.toContain('sejire-preservation-v2');
  await fresh.getByRole('button',{name:'Открыть по 12 словам',exact:true}).click({timeout:5000});
  await fresh.getByRole('textbox',{name:'12 слов восстановления SEJIRE'}).fill(
    mode==='wrong-words'?'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about':family.words);
  await fresh.getByRole('button',{name:'Открыть',exact:true}).click({timeout:5000});
  return {context,fresh,family,counts};
}

test('clean browser recovers legacy V2 Save-Id TX from raw fallback with only 12 words',async({browser,page})=>{
  const {context,fresh,family,counts}=await cleanRecovery(browser,page);
  try{
    await expect(fresh.getByRole('button',{name:'Сохранить',exact:true}).first()).toBeVisible();
    const restored=await fresh.evaluate(async words=>
      (await import('/tests/browser-fixture.ts')).recovered(words),family.words);
    expect(restored?.trees).toEqual(family.vault.trees);
    expect(restored?.active_tree_id).toBe(family.vault.active_tree_id);
    expect(counts.vaultQueries).toBe(1);expect(counts.saveQueries).toBe(1);
    expect(counts.rawPrimary).toBeGreaterThan(0);expect(counts.rawFallback).toBeGreaterThan(0);
    expect(counts.rendered).toBe(0);expect(counts.writes).toBe(0);
    expect(await fresh.evaluate(()=>window.__recoveryWalletCalls)).toBe(0);
  }finally{await context.close();}
});

test('clean browser recovers confirmed pilot when public Save-Id index is empty',async({browser,page})=>{
  const {context,fresh,counts}=await cleanRecovery(browser,page,'unindexed');
  try{
    await expect(fresh.getByRole('button',{name:'Сохранить',exact:true}).first()).toBeVisible();
    expect(counts.saveQueries).toBe(1);expect(counts.idQueries).toBe(1);
    expect(counts.rendered).toBe(0);expect(counts.writes).toBe(0);
  }finally{await context.close();}
});

for(const [mode,expected] of [
  ['wrong-words','Сейф не найден'],
  ['wrong-vault','Архив в Arweave повреждён'],
  ['corrupt','Архив в Arweave повреждён'],
  ['gateway-down','Сеть Arweave недоступна'],
]){
  test(`clean browser recovery rejects ${mode} without payment or upload`,async({browser,page})=>{
    const {context,fresh,counts}=await cleanRecovery(browser,page,mode);
    try{
      await expect(fresh.getByRole('alert')).toContainText(expected);
      await expect(fresh.getByRole('button',{name:'Сохранить',exact:true})).toHaveCount(0);
      expect(counts.rendered).toBe(0);expect(counts.writes).toBe(0);
      expect(await fresh.evaluate(()=>window.__recoveryWalletCalls)).toBe(0);
    }finally{await context.close();}
  });
}
