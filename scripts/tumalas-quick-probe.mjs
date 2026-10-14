import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
await mkdir('tumalas-quick-output',{recursive:true});
const target='https://tumalas.kz/wp-admin/admin-ajax.php?action=tuma_cached_childnew_get&id=14&nodeid=14';
const targetWww='https://www.tumalas.kz/wp-admin/admin-ajax.php?action=tuma_cached_childnew_get&id=14&nodeid=14';
const enc=encodeURIComponent(target);
const attempts=[
 ['direct',target,{}],
 ['direct-www',targetWww,{}],
 ['direct-post','https://tumalas.kz/wp-admin/admin-ajax.php',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'action=tuma_cached_childnew_get&id=14&nodeid=14'}],
 ['jina-http','https://r.jina.ai/http://tumalas.kz/wp-admin/admin-ajax.php?action=tuma_cached_childnew_get%26id=14%26nodeid=14',{}],
 ['jina-https','https://r.jina.ai/https://tumalas.kz/wp-admin/admin-ajax.php?action=tuma_cached_childnew_get%26id=14%26nodeid=14',{}],
 ['allorigins',`https://api.allorigins.win/raw?url=${enc}`,{}],
 ['allorigins-get',`https://api.allorigins.win/get?url=${enc}`,{}],
 ['corsproxy',`https://corsproxy.io/?url=${enc}`,{}],
 ['codetabs',`https://api.codetabs.com/v1/proxy?quest=${enc}`,{}],
 ['thingproxy',`https://thingproxy.freeboard.io/fetch/${target}`,{}],
 ['translate','https://tumalas-kz.translate.goog/wp-admin/admin-ajax.php?action=tuma_cached_childnew_get&id=14&nodeid=14&_x_tr_sl=kk&_x_tr_tl=en&_x_tr_hl=en',{}],
 ['r.jina-home','https://r.jina.ai/http://tumalas.kz/mobi/',{}],
];
const result=await Promise.all(attempts.map(async([name,url,init])=>{
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);const start=Date.now();
 try{const r=await fetch(url,{...init,signal:controller.signal,redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36','accept':'application/json,text/plain,*/*','referer':'https://tumalas.kz/mobi/','origin':'https://tumalas.kz',...(init.headers||{})}});const bytes=new Uint8Array(await r.arrayBuffer());const text=new TextDecoder().decode(bytes);let json=null;try{json=JSON.parse(text)}catch{};await writeFile(resolve('tumalas-quick-output',`${name}.txt`),bytes);return{name,url,status:r.status,finalUrl:r.url,ct:r.headers.get('content-type'),bytes:bytes.length,json:Array.isArray(json)?{type:'array',length:json.length,first:json[0]}:json&&{type:typeof json,keys:Object.keys(json).slice(0,20)},preview:text.slice(0,800),ms:Date.now()-start}}catch(e){return{name,url,error:e instanceof Error?e.message:String(e),ms:Date.now()-start}}finally{clearTimeout(timer)}}));
await writeFile('tumalas-quick-output/results.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
