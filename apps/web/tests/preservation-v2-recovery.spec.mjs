import {createHash} from 'node:crypto';
import {test,expect} from '@playwright/test';

const tx=n=>String.fromCharCode(65+n).repeat(43);
const sha=text=>createHash('sha256').update(text).digest('hex');
const b64=text=>Buffer.from(text).toString('base64url');
const tag=(name,value)=>({name:b64(name),value:b64(value)});
const meta=(version,options={})=>({id:version.id,tags:[tag('App-Name','SEJIRE'),tag('Type','vault-envelope'),
  ...(!options.noVault?[tag('Vault-Id',version.vaultId)]:[]),
  ...(!options.legacy?[tag('Archive-SHA256',sha(version.raw)),tag('Archive-Bytes',String(Buffer.byteLength(version.raw))),tag('Schema','sejire/envelope/v1'),tag('Protocol-Version','sejire/v0.3')]:[]),
  ...(version.parent?[tag('Parent-Tx',version.parent)]:[])],block:{height:version.height,timestamp:1700000000+version.height}});

async function setup(browser,preparer,mode={}){
  await preparer.goto('/');
  const family=await preparer.evaluate(async()=> (await import('/tests/browser-fixture.ts')).fixture());
  const base={id:tx(0),raw:family.serialized,vaultId:family.vault.vault_id,height:100,parent:null};
  const versions=mode.versions??[base];
  const context=await browser.newContext({locale:'ru-RU'});
  expect((await context.storageState()).origins).toEqual([]);
  const page=await context.newPage();
  const legacy=mode.legacy??false;
  const entries=legacy?[{vaultId:base.vaultId,txIds:versions.map(v=>v.id),archiveBytes:Buffer.byteLength(base.raw),archiveSha256:sha(base.raw),reason:'legacy-test'}]:[];
  await page.addInitScript(entries=>{
    window.__SEJIRE_RECOVERY_TEST_LOCATORS__=entries;
    window.__walletCalls=0;
    window.phantom={solana:{connect:()=>{window.__walletCalls++;throw Error('wallet forbidden');},signAndSendTransaction:()=>{window.__walletCalls++;throw Error('wallet forbidden');}}};
    window.arweaveWallet={connect:()=>{window.__walletCalls++;throw Error('wallet forbidden');},sign:()=>{window.__walletCalls++;throw Error('wallet forbidden');}};
  },entries);
  const counts={graphql:[],metadata:[],raw:[],rendered:0,writes:0,peers:0};
  await context.route('https://**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),host=url.hostname;
    if(url.pathname==='/ar-io/peers'){
      counts.peers++;
      if(mode.peersDown){await route.fulfill({status:503,body:'down'});return;}
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({gateways:{'dynamic.test:443':{url:'https://dynamic.test'}}})});return;
    }
    if(url.pathname==='/graphql'){
      counts.graphql.push(host);
      if(mode.graphqlTimeout?.includes(host)){await route.abort('timedout');return;}
      if(mode.allGraphqlDown||mode.graphqlDown?.includes(host)||mode.dynamicOnly&&host!=='dynamic.test'){
        await route.fulfill({status:503,body:'down'});return;
      }
      const body=req.postDataJSON();
      const edges=(mode.emptyGraphql||legacy||mode.noCandidates||body.variables.vaultId!==base.vaultId?[]:versions.map(v=>({cursor:v.id,node:{id:v.id,block:{height:v.height,timestamp:1700000000+v.height}}})));
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:{transactions:{pageInfo:{hasNextPage:false},edges}}})});return;
    }
    const id=url.pathname.split('/').at(-1);const version=versions.find(v=>v.id===id);
    if(url.pathname===`/${id}`&&version){counts.rendered++;await route.fulfill({status:200,contentType:'text/html',body:'<html>rendered</html>'});return;}
    if(url.pathname.startsWith('/tx/')&&version){
      counts.metadata.push(host);
      if(mode.metadataDown?.includes(host)){await route.fulfill({status:503,body:'down'});return;}
      const record=meta(version,{legacy,noVault:legacy});
      if(mode.mismatchedTag)record.tags=record.tags.map(t=>t.name===b64('Vault-Id')?tag('Vault-Id','f'.repeat(32)):t);
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(record)});return;
    }
    if(url.pathname.startsWith('/raw/')&&version){
      counts.raw.push(host);
      if(mode.rawDown?.includes(host)||mode.allRawDown){await route.fulfill({status:503,body:'down'});return;}
      await route.fulfill({status:200,contentType:'application/octet-stream',body:mode.rawOverride??version.raw});return;
    }
    if(req.method()!=='GET'&&url.pathname!=='/graphql')counts.writes++;
    await route.abort();
  });
  await page.goto('/');
  const before=await page.evaluate(async()=>({local:localStorage.length,session:sessionStorage.length,db:(await indexedDB.databases()).map(x=>x.name)}));
  expect(before.local).toBe(0);expect(before.session).toBe(0);expect(before.db).not.toContain('sejire-preservation-v2');
  return {context,page,family,counts,base,versions};
}
async function runCore(page,words){return page.evaluate(async words=>(await import('/src/lib/recovery/recover.ts')).recoverVaultFromWords(words),words);}
async function runUi(page,words){
  await page.getByRole('button',{name:'Открыть по 12 словам',exact:true}).click();
  await page.getByRole('textbox',{name:'12 слов восстановления SEJIRE'}).fill(words);
  await page.getByRole('button',{name:'Открыть',exact:true}).click();
}
function readOnly(counts){expect(counts.writes).toBe(0);expect(counts.rendered).toBe(0);}

for(const [name,mode] of [
  ['A primary Vault-Id GraphQL and raw gateway',{}],
  ['B first GraphQL times out second works',{graphqlTimeout:['arweave.net']}],
  ['C dynamic AR.IO gateway indexes when static GraphQL unavailable',{dynamicOnly:true}],
  ['D all GraphQL unavailable, legacy locator finds TX',{legacy:true,allGraphqlDown:true}],
  ['E empty GraphQL and legacy locator finds TX',{legacy:true,emptyGraphql:true}],
  ['F first metadata gateway down',{metadataDown:['dynamic.test']}],
  ['G two raw gateways fail and third succeeds',{rawDown:['dynamic.test','arweave.net']}],
  ['H rendered URL HTML ignored, raw succeeds',{}],
  ['T clean browser words only',{legacy:true,allGraphqlDown:true}],
]){
  test(name,async({browser,page:preparer})=>{
    const s=await setup(browser,preparer,mode);try{
      const result=await runCore(s.page,s.family.words);
      expect(result.ok).toBe(true);expect(result.headTxId).toBe(s.base.id);
      if(name.startsWith('C'))expect(s.counts.graphql).toContain('dynamic.test');
      if(name.startsWith('D'))expect(s.counts.graphql.length).toBeGreaterThan(0);
      if(name.startsWith('G'))expect(new Set(s.counts.raw).size).toBeGreaterThanOrEqual(3);
      readOnly(s.counts);expect(await s.page.evaluate(()=>window.__walletCalls)).toBe(0);
    }finally{await s.context.close();}
  });
}

test('UI clean browser opens family tree from legacy locator without GraphQL',async({browser,page:preparer})=>{
  const s=await setup(browser,preparer,{legacy:true,allGraphqlDown:true});try{
    await runUi(s.page,s.family.words);
    await expect(s.page.getByRole('button',{name:'Сохранить',exact:true}).first()).toBeVisible();
    const opened=await s.page.evaluate(async words=>(await import('/tests/browser-fixture.ts')).recovered(words),s.family.words);
    expect(opened.trees).toEqual(s.family.vault.trees);readOnly(s.counts);
  }finally{await s.context.close();}
});

for(const [name,mode,expected] of [
  ['I forged Vault-Id tag cannot decrypt',{rawOverride:null},'DECRYPT_FAILED'],
  ['J changed raw bytes rejected',{rawOverride:'corrupt'},'RAW_HASH_MISMATCH'],
  ['K correct hash but different envelope vault ID',{},'VAULT_ID_MISMATCH'],
  ['L invalid decrypted vault rejected',{},'INVALID_VAULT'],
  ['M wrong words never open',{wrongWords:true},'NO_CANDIDATES'],
  ['N all discovery providers unavailable',{allGraphqlDown:true},'DISCOVERY_UNAVAILABLE'],
  ['O responding discovery has no candidates',{noCandidates:true},'NO_CANDIDATES'],
  ['P candidate but all raw gateways unavailable',{allRawDown:true},'DATA_UNAVAILABLE'],
]){
  test(name,async({browser,page:preparer})=>{
    const s=await setup(browser,preparer,mode);try{
      let words=s.family.words;
      if(mode.wrongWords)words='abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
      if(name.startsWith('I')){
        const other=await s.page.evaluate(async(vault)=>{
          const {encryptJson}=await import('/src/lib/crypto/encrypt.ts');
          const bytes=new Uint8Array(32).fill(7);return JSON.stringify(await encryptJson(bytes,vault.vault_id,vault));
        },s.family.vault);
        s.base.raw=other;
      }
      if(name.startsWith('K')){
        const wrong=JSON.stringify({...s.family.envelope,vault_id:'f'.repeat(32)});
        s.base.raw=wrong;
      }
      if(name.startsWith('L')){
        const invalid=await s.page.evaluate(async words=>{
          const {deriveKeysFromMnemonic}=await import('/src/lib/crypto/keys.ts');
          const {encryptJson}=await import('/src/lib/crypto/encrypt.ts');
          const keys=deriveKeysFromMnemonic(words);
          return JSON.stringify(await encryptJson(keys.encKey,keys.vaultId,{schema:'sejire/vault/v1',vault_id:keys.vaultId,trees:{},active_tree_id:null}));
        },words);s.base.raw=invalid;
      }
      const result=await runCore(s.page,words);
      expect(result.ok).toBe(false);expect(result.code).toBe(expected);readOnly(s.counts);
    }finally{await s.context.close();}
  });
}

test('Q sequential versions resolve v3 HEAD',async({browser,page:preparer})=>{
  const s=await setup(browser,preparer);try{
    s.versions.push({...s.base,id:tx(1),height:101,parent:tx(0)},{...s.base,id:tx(2),height:102,parent:tx(1)});
    const result=await runCore(s.page,s.family.words);expect(result.ok).toBe(true);expect(result.headTxId).toBe(tx(2));expect(result.versions).toHaveLength(3);
  }finally{await s.context.close();}
});
test('R decryptable forks preserved with explicit MULTIPLE_VERIFIED_HEADS',async({browser,page:preparer})=>{
  const s=await setup(browser,preparer);try{
    s.versions.push({...s.base,id:tx(1),height:101,parent:tx(0)},{...s.base,id:tx(2),height:102,parent:tx(0)});
    const result=await runCore(s.page,s.family.words);expect(result.ok).toBe(true);expect(result.code).toBe('MULTIPLE_VERIFIED_HEADS');
    expect(result.forks).toHaveLength(1);expect(result.headTxId).toBe(tx(2));
  }finally{await s.context.close();}
});
test('S same TX from many providers dedupes once',async({browser,page:preparer})=>{
  const s=await setup(browser,preparer);try{
    const result=await runCore(s.page,s.family.words);expect(result.ok).toBe(true);
    expect(result.diagnostics.candidateCount).toBe(1);expect(result.versions).toHaveLength(1);
    expect(s.counts.graphql.length).toBeGreaterThanOrEqual(3);
  }finally{await s.context.close();}
});
test('U recovery makes no wallet or payment or upload calls',async({browser,page:preparer})=>{
  const s=await setup(browser,preparer,{legacy:true,allGraphqlDown:true});try{
    const result=await runCore(s.page,s.family.words);expect(result.ok).toBe(true);
    expect(await s.page.evaluate(()=>window.__walletCalls)).toBe(0);readOnly(s.counts);
  }finally{await s.context.close();}
});
