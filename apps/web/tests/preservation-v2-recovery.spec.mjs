import {createHash} from 'node:crypto';
import {test,expect} from '@playwright/test';

const tx=n=>String.fromCharCode(65+n).repeat(43);
const sha=text=>createHash('sha256').update(text).digest('hex');
const b64=text=>Buffer.from(text).toString('base64url');
const tag=(name,value)=>({name:b64(name),value:b64(value)});
const meta=(version,options={})=>({id:version.id,tags:[tag('App-Name','SEJIRE'),tag('Type','vault-envelope'),
  ...(!options.noVault?[tag('Vault-Id',version.vaultId)]:[]),
  ...(!options.legacy?[tag('Archive-SHA256',sha(version.raw)),tag('Archive-Bytes',String(Buffer.byteLength(version.raw))),tag('Schema','sejire/envelope/v1'),
    // Exact original fund publisher: both identity/integrity bindings and fund
    // markers were present, but Protocol-Version was not published on chain.
    ...(options.funded?[tag('Preservation-Id','1'.repeat(32)),tag('Promo-Funded','true')]:
      options.missingProtocol?[]:[tag('Protocol-Version','sejire/v0.3')])]:[]),
  ...(version.parent?[tag('Parent-Tx',version.parent)]:[])],block:{height:version.height,timestamp:1700000000+version.height}});

const localOrigin='http://127.0.0.1:5178';
async function guardNetwork(context,onBlocked=()=>{}){
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==localOrigin){onBlocked();return route.abort('blockedbyclient');}
    if(url.pathname.startsWith('/api/')){
      onBlocked();return route.fulfill({status:404,contentType:'application/json',body:'{"error":"unmocked_test_api"}'});
    }
    return route.continue();
  });
  await context.routeWebSocket('**/*',route=>{
    if(new URL(route.url()).origin==='ws://127.0.0.1:5178')route.connectToServer();
    else{onBlocked();route.close({code:1008,reason:'External network disabled in recovery tests'});}
  });
}
test.beforeEach(async({context})=>guardNetwork(context));

async function setup(browser,preparer,mode={}){
  await preparer.goto('/');
  const family=await preparer.evaluate(async()=> (await import('/tests/browser-fixture.ts')).fixture());
  const base={id:tx(0),raw:family.serialized,vaultId:family.vault.vault_id,height:100,parent:null};
  // A trailing JSON space keeps the envelope valid while ensuring base64 has
  // unused final bits, so a permissive decoder can be distinguished reliably.
  if(mode.dataFallback==='noncanonical-bits'&&Buffer.byteLength(base.raw)%3===0)base.raw+=' ';
  const versions=mode.versions??[base];
  const context=await browser.newContext({locale:'ru-RU',serviceWorkers:'block'});
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
  const counts={graphql:[],metadata:[],raw:[],data:[],rendered:0,writes:0,peers:0,blocked:0,wordsInRequests:0};
  await guardNetwork(context,()=>{counts.blocked++;});
  await context.route('https://**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),host=url.hostname;
    if(req.postData()?.includes(family.words))counts.wordsInRequests++;
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
    const dataPath=/^\/tx\/([A-Za-z0-9_-]{43})\/data$/.exec(url.pathname);
    if(dataPath){
      const version=versions.find(v=>v.id===dataPath[1]);
      expect(req.method()).toBe('GET');expect(version).toBeDefined();
      expect(counts.raw).toContain(host);counts.data.push(host);
      // Opt-in only: older corrupt/unavailable-raw fixtures must never gain a
      // valid copy through this endpoint and accidentally pass recovery.
      if(!mode.dataFallback){await route.fulfill({status:503,body:'data unavailable in this fixture'});return;}
      let encoded=b64(version.raw);
      if(mode.dataFallback==='invalid-character')encoded='!'+encoded.slice(1);
      if(mode.dataFallback==='noncanonical-bits'){
        const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        const last=alphabet.indexOf(encoded.at(-1));
        encoded=encoded.slice(0,-1)+alphabet[last|1];
        expect(Buffer.from(encoded,'base64url')).toEqual(Buffer.from(version.raw));
        expect(encoded).not.toBe(b64(version.raw));
      }
      await route.fulfill({status:200,contentType:'text/plain',body:encoded});return;
    }
    const id=url.pathname.split('/').at(-1);const version=versions.find(v=>v.id===id);
    if(url.pathname===`/${id}`&&version){counts.rendered++;await route.fulfill({status:200,contentType:'text/html',body:'<html>rendered</html>'});return;}
    if(url.pathname===`/tx/${id}`&&version){
      counts.metadata.push(host);
      if(mode.metadataDown?.includes(host)){await route.fulfill({status:503,body:'down'});return;}
      const record=meta(version,{legacy,noVault:legacy,funded:mode.funded,missingProtocol:mode.missingProtocol});
      if(mode.mismatchedTag)record.tags=record.tags.map(t=>t.name===b64('Vault-Id')?tag('Vault-Id','f'.repeat(32)):t);
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(record)});return;
    }
    if(url.pathname.startsWith('/raw/')&&version){
      counts.raw.push(host);
      if(mode.rawDown?.includes(host)||mode.allRawDown){await route.fulfill({status:503,body:'down'});return;}
      const raw=mode.wrongSameLengthRaw
        ?version.raw.replace(/("ciphertext":")([^"])/,(_,prefix,char)=>prefix+(char==='A'?'B':'A'))
        :mode.rawOverride??version.raw;
      if(mode.wrongSameLengthRaw){expect(Buffer.byteLength(raw)).toBe(Buffer.byteLength(version.raw));expect(sha(raw)).not.toBe(sha(version.raw));}
      await route.fulfill({status:200,contentType:'application/octet-stream',body:raw});return;
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
function readOnly(counts){expect(counts.writes).toBe(0);expect(counts.rendered).toBe(0);expect(counts.blocked).toBe(0);expect(counts.wordsInRequests).toBe(0);}

async function localCopy(s){
  await s.page.evaluate(envelope=>localStorage.setItem(`sejire.envelope.${envelope.vault_id}`,JSON.stringify(envelope)),s.family.envelope);
}

async function expectFullTree(s,{source,headTxId}){
  await expect(s.page.getByRole('button',{name:'Сохранить',exact:true}).first()).toBeVisible();
  const opened=await s.page.evaluate(async()=>{
    const session=await import('/src/lib/vaultSession/session.ts');
    const words=session.getSessionMnemonic();
    const keys=(await import('/src/lib/crypto/keys.ts')).deriveKeysFromMnemonic(words);
    const vault=await(await import('/src/lib/crypto/vault.ts')).openLocalVault(keys);
    const draft=(await import('/src/lib/draftStorage.ts')).loadDraftTree();
    return {session:session.getVaultSession(),trees:vault?.trees,activeId:draft?.meta.id,people:Object.keys(draft?.draft.persons??{}).sort()};
  });
  // Includes both independent trees, all people, and their earlier commits.
  expect(opened.trees).toEqual(s.family.vault.trees);
  expect(opened.activeId).toBe(s.family.vault.active_tree_id);
  expect(opened.people).toEqual(Object.keys(s.family.vault.trees[s.family.vault.active_tree_id].draft.persons).sort());
  expect(opened.session).toMatchObject({vaultId:s.base.vaultId,source,headTxId});
  await expect(s.page.getByRole('button',{name:/^Child corrected /})).toBeVisible();
  expect(await s.page.evaluate(()=>window.__walletCalls)).toBe(0);readOnly(s.counts);
}

for(const cached of [false,true]){
  test(`Funded archive without Protocol-Version opens the full network tree ${cached?'with a local copy present':'in a clean browser'}`,async({browser,page:preparer},testInfo)=>{
    const s=await setup(browser,preparer,{funded:true});try{
      await s.page.setViewportSize({width:390,height:844});
      if(cached)await localCopy(s);
      await runUi(s.page,s.family.words);
      await expectFullTree(s,{source:'network',headTxId:s.base.id});
      expect(s.counts.metadata.length).toBeGreaterThan(0);expect(s.counts.raw.length).toBeGreaterThan(0);
      await expect(s.page.getByRole('heading',{name:'Выберите версию',exact:true})).toHaveCount(0);
      await expect(s.page.getByText('Найденная запись не прошла проверку.')).toHaveCount(0);
      await expect.poll(()=>s.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
      if(!cached)await s.page.screenshot({path:testInfo.outputPath('funded-words-restored-mobile.png'),fullPage:true});
    }finally{await s.context.close();}
  });
}

test('Same-gateway base64url data repairs wrong same-length raw and restores every encrypted tree',async({browser,page:preparer})=>{
  const s=await setup(browser,preparer,{funded:true,wrongSameLengthRaw:true,dataFallback:'valid'});try{
    await runUi(s.page,s.family.words);
    await expectFullTree(s,{source:'network',headTxId:s.base.id});
    expect(s.counts.data.length).toBeGreaterThan(0);
    for(const host of s.counts.data)expect(s.counts.raw).toContain(host);
  }finally{await s.context.close();}
});

for(const dataFallback of ['invalid-character','noncanonical-bits']){
  test(`Invalid base64url fallback (${dataFallback}) cannot turn wrong same-length raw into a restored vault`,async({browser,page:preparer})=>{
    const s=await setup(browser,preparer,{funded:true,wrongSameLengthRaw:true,dataFallback});try{
      await runUi(s.page,s.family.words);
      await expect(s.page.locator('.form-error')).toContainText('Архив повреждён или не совпадает с опубликованной записью.');
      await expect(s.page.getByRole('button',{name:'Сохранить',exact:true})).toHaveCount(0);
      await expect(s.page.locator('.person-card')).toHaveCount(0);
      expect(s.counts.data.length).toBeGreaterThan(0);
      expect(await s.page.evaluate(async()=>({
        session:(await import('/src/lib/vaultSession/session.ts')).getVaultSession(),
        draft:(await import('/src/lib/draftStorage.ts')).loadDraftTree(),
        cachedEnvelope:Object.keys(localStorage).some(key=>key.startsWith('sejire.envelope.')),
        walletCalls:window.__walletCalls,
      }))).toEqual({session:null,draft:null,cachedEnvelope:false,walletCalls:0});
      readOnly(s.counts);
    }finally{await s.context.close();}
  });
}

test('One local fallback is described as a browser copy and opens the complete tree',async({browser,page:preparer},testInfo)=>{
  // The exception is specific to funded metadata. An ordinary record missing
  // Protocol-Version still fails network verification; its local copy is usable.
  const s=await setup(browser,preparer,{missingProtocol:true});try{
    await s.page.setViewportSize({width:390,height:844});await localCopy(s);
    await runUi(s.page,s.family.words);
    const local=s.page.getByRole('button',{name:/Текущая локальная копия/});
    await expect(local).toBeVisible();
    await expect(s.page.getByRole('heading',{name:'Доступна копия в браузере',exact:true})).toBeVisible();
    await expect(s.page.getByText('Можно открыть сохранённую копию из этого браузера.',{exact:true})).toBeVisible();
    await expect(s.page.locator('.vault-version-item')).toHaveCount(1);
    await expect(s.page.getByText(/Найдено несколько проверенных сохранений/)).toHaveCount(0);
    await expect(s.page.getByText(/несколько веток сохранения/)).toHaveCount(0);
    await expect(s.page.getByText(/Найденная запись не прошла проверку/)).toBeVisible();
    expect(s.counts.raw).toHaveLength(0);
    await expect.poll(()=>s.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await s.page.screenshot({path:testInfo.outputPath('local-copy-fallback-mobile.png'),fullPage:true});
    await local.click();await expectFullTree(s,{source:'local',headTxId:null});
  }finally{await s.context.close();}
});

test('Verified network forks remain a real version choice and honor the selected branch',async({browser,page:preparer},testInfo)=>{
  const s=await setup(browser,preparer);try{
    s.versions.push({...s.base,id:tx(1),height:101,parent:tx(0)},{...s.base,id:tx(2),height:102,parent:tx(0)});
    await s.page.setViewportSize({width:390,height:844});
    await runUi(s.page,s.family.words);
    await expect(s.page.getByRole('heading',{name:'Выберите версию',exact:true})).toBeVisible();
    await expect(s.page.getByText('Выберите версию, которую хотите открыть.',{exact:true})).toBeVisible();
    await expect(s.page.locator('.vault-version-item')).toHaveCount(3);
    await expect(s.page.getByText(/несколько веток сохранения/)).toBeVisible();
    await expect(s.page.getByRole('button',{name:/Текущая локальная копия/})).toHaveCount(0);
    await expect.poll(()=>s.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await s.page.screenshot({path:testInfo.outputPath('verified-forks-mobile.png'),fullPage:true});
    await s.page.getByRole('button',{name:/Сеть · версия 2/}).click();
    await expectFullTree(s,{source:'network',headTxId:tx(1)});
  }finally{await s.context.close();}
});

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
