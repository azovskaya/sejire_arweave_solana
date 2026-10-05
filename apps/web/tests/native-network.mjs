const genesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export async function fixtures(page) {
 const forbidden=[],network={tx:null,sends:0,loseResponse:false,arPosts:0,arId:null,payload:"",arFailure:false};
 await page.route('**/*',async route=>{
 const url=route.request().url();
 if(/ardrive|turbo|workers\.dev|\/api\/checkout\//.test(url)){forbidden.push(url);await route.abort();return;}
 if(url.endsWith('/graphql'))return route.fulfill({json:{data:{transactions:{edges:[]}}}});
 if(url.startsWith('https://arweave.net/')){
 const path=new URL(url).pathname;
 if(path==='/tx_anchor')return route.fulfill({contentType:'text/plain',body:'A'.repeat(64)});
 if(path==='/tx'){const tx=route.request().postDataJSON();network.arPosts++;network.arId=tx.id;network.payload=Buffer.from(tx.data??'', 'base64url').toString('utf8');if(network.arFailure){network.arFailure=false;return route.fulfill({status:503,json:{error:'fixture_stop'}});}return route.fulfill({json:{}});}
 if(path.endsWith('/status'))return route.fulfill({json:{block_height:100,block_indep_hash:'fixture',number_of_confirmations:12}});
 if(path.slice(1)===network.arId)return route.fulfill({contentType:'application/json',body:network.payload});
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
