import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,lstat,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import {Miniflare,createFetchMock} from 'miniflare';
import {prepare,preparedValues,reviewEvidence,sha256} from '../prepare.mjs';
import {collect} from '../collect.mjs';
import {prepareProxy} from '../prepare-proxy.mjs';
import {forwardLegacyRequest} from '../src/compatibility-proxy.ts';
import {checkConfig,OBJECT_NAME,PREFIX} from '../src/config.ts';
import exporter,{CheckoutLedger} from '../src/export-only.ts';
import {validateLedgerSnapshot} from '../vendor/apps/sponsor/src/checkout/migrationSnapshot.ts';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'..');
const auth='7'.repeat(64),sourceCommit='a'.repeat(40),ownerHash='c'.repeat(64);
const evidence=objectId=>({schema:'sejire/legacy-export-source-evidence/v1',accountId:'1'.repeat(32),scriptName:'synthetic-legacy-source',sourceCommit,
  sourceVersionId:'12345678-1234-1234-1234-123456789abc',observedAt:Date.now(),lifecycle:'legacy-migrations',migrationTag:'fund-ledger-v1',compatibilityDate:'2026-07-01',compatibilityFlags:[],
  namespace:{id:'2'.repeat(32),class:'CheckoutLedger',script:'synthetic-legacy-source',use_sqlite:true},
  bindings:[{name:'CHECKOUT_LEDGER',type:'durable_object_namespace',class_name:'CheckoutLedger',namespace_id:'2'.repeat(32)},
    {name:'ADMIN_TOKEN',type:'secret_text'},{name:'PROMO_CODE_SECRET',type:'secret_text'},{name:'ARWEAVE_TREASURY_JWK',type:'secret_text'},
    {name:'IDEMPOTENCY',type:'kv_namespace'},{name:'CHECKOUT_PAID_ENABLED',type:'plain_text'}],
  object:{name:OBJECT_NAME,id:objectId,hasStoredData:true},deployment:{versions:[{id:'12345678-1234-1234-1234-123456789abc',percentage:100}]},
  maintenance:{requestedAt:Date.now()-1000,attestation:'MAINTENANCE_EXPORT_ONLY'},legacyKvDisposition:'SEPARATE_PRIVATE_EXPORT_OR_RECONCILIATION_REQUIRED'});
const configFor=id=>preparedValues(evidence(id),'8'.repeat(64)).config;
const acknowledgement=config=>({namespaceId:config.namespaceId,objectId:config.objectId,sourceCommit:config.sourceCommit,attestation:config.attestation});
const request=(path,body,credential=auth,extra={})=>({url:'https://source.example'+PREFIX+path,
  init:{method:body===undefined?'GET':'POST',headers:{...(credential?{Authorization:'Bearer '+credential}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...extra},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})}});
async function call(runtime,path,body,credential=auth,extra={}){const r=request(path,body,credential,extra),response=await runtime.dispatchFetch(r.url,r.init);return {status:response.status,body:await response.json(),headers:response.headers};}
async function seal(runtime,config){assert.equal((await call(runtime,'/status')).status,200);const response=await call(runtime,'/seal-quiescence',{target:acknowledgement(config),quiescedAt:Date.now(),evidenceSha256:'4'.repeat(64),attestation:'SOURCE_EXECUTION_STOPPED'});assert.equal(response.status,200,JSON.stringify(response.body));return response;}
const fetchMock=()=>{const m=createFetchMock();m.disableNetConnect();return m;};
const options=(directory,script,config)=>({name:'synthetic-legacy-source',modules:true,scriptPath:script,modulesRoot:dirname(script),fetchMock:fetchMock(),
  compatibilityDate:'2026-07-01',durableObjects:{CHECKOUT_LEDGER:{className:'CheckoutLedger',useSQLite:true}},durableObjectsPersist:join(directory,'db'),
  bindings:{SEJIRE_EXPORT_TOKEN:auth,SEJIRE_EXPORT_CONFIG:config}});
async function seed(directory,seedScript,variant={}){
  const runtime=new Miniflare(options(directory,seedScript,{}));
  const operation=async body=>{const response=await runtime.dispatchFetch('https://seed.example',{method:'POST',headers:{'X-Synthetic':'fixture-only','Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,200,(await response.clone().text()).slice(0,300));return response.json();};
  try{await operation({action:'seed'});const saved=await operation({action:'seed-data',alarmAt:variant.alarmAt??null,...variant}),sourceEvidence=evidence(saved.objectId);
    return {...saved,sourceEvidence,config:preparedValues(sourceEvidence,sha256(JSON.stringify(sourceEvidence))).config};}finally{await runtime.dispose();}
}
const passed=[];const test=async(name,fn)=>{await fn();passed.push(name);console.log('PASS legacy export: '+name);};

if(process.argv[2]==='restart-child'){
  const directory=process.argv[3],manifest=JSON.parse(await readFile(join(directory,'restart.json'),'utf8'));
  const runtime=new Miniflare(options(directory,manifest.script,manifest.config));
  try{const status=await call(runtime,'/status'),snapshot=await call(runtime,'/snapshot',acknowledgement(manifest.config));
    assert.equal(status.status,200);assert.equal(snapshot.status,200);assert.equal(status.body.originalAlarmAt,manifest.alarmAt);
    assert.equal(snapshot.body.sha256,manifest.snapshotSha256);assert.equal(status.body.freezeSha256,manifest.freezeSha256);
    await validateLedgerSnapshot(snapshot.body);console.log('PASS legacy export child: process restart preserves the exact frozen snapshot and original alarm');
  }finally{await runtime.dispose();}
}else{
  const temp=await mkdtemp(join(tmpdir(),'sejire-private-export-'));
  let active;
  try{
    const seedScript=join(temp,'seed.mjs'),exportScript=join(temp,'export.mjs');
    await build({entryPoints:[join(here,'seed-worker.ts')],bundle:true,platform:'browser',format:'esm',target:'es2022',outfile:seedScript});
    const bundled=await build({entryPoints:[join(root,'src/export-only.ts')],bundle:true,platform:'browser',format:'esm',target:'es2022',outfile:exportScript,metafile:true});
    await test('closed bundle contains only export entry, config and two pinned snapshot codec sources',async()=>{
      const inputNames=Object.keys(bundled.metafile.inputs).map(path=>resolve(path)).sort();
      assert.deepEqual(inputNames,[join(root,'src/config.ts'),join(root,'src/export-only.ts'),join(root,'vendor/apps/sponsor/src/checkout/migrationSnapshot.ts'),join(root,'vendor/packages/protocol/wire.ts')].sort());
      assert.equal(sha256(await readFile(join(root,'vendor/apps/sponsor/src/checkout/migrationSnapshot.ts'))),'0edf86b74bd33c97a9e7de29d04944a41414da020460f94d1e20a849ea917491');
      assert.equal(sha256(await readFile(join(root,'vendor/packages/protocol/wire.ts'))),'07f36cf19d2b6e9a4b400f3a9d223b632b050e412c90a2e876550f4efcb674d5');
    });
    await test('offline preparation pins identity, retains secret binding types and cannot request a class lifecycle change',async()=>{
      const e=evidence('3'.repeat(64)),input=join(temp,'evidence.json'),out=join(temp,'prepared');await writeFile(input,JSON.stringify(e),{mode:0o600});
      const result=await prepare(input,out),metadata=JSON.parse(await readFile(join(out,'upload-metadata.json'),'utf8'));
      assert.equal(result.deployed,false);assert.deepEqual(metadata.migrations,{old_tag:'fund-ledger-v1',new_tag:'fund-ledger-v1',steps:[]});
      assert.equal(metadata.bindings[0].namespace_id,e.namespace.id);assert.equal(metadata.bindings[0].class_name,'CheckoutLedger');
      assert(metadata.keep_bindings.includes('secret_text'));assert(metadata.keep_bindings.includes('kv_namespace'));assert(metadata.keep_bindings.includes('plain_text'));
      assert(!('exports'in metadata));for(const word of ['new_sqlite_classes','new_classes','deleted_classes','renamed_classes','transferred_classes'])assert.equal(JSON.stringify(metadata).includes(word),false);
      assert.equal((await lstat(out)).mode&0o777,0o700);for(const file of await readdir(out))assert.equal((await lstat(join(out,file))).mode&0o777,0o600);
      await assert.rejects(()=>prepare(input,out),{code:'EEXIST'});
      for(const mutate of [x=>x.maintenance.attestation='SOURCE_EXECUTION_STOPPED',x=>x.namespace.id='4'.repeat(32),x=>x.namespace.script='another-worker',x=>x.namespace.use_sqlite=false,
        x=>x.namespace.class='WrongClass',x=>x.object.hasStoredData=false,x=>x.deployment.versions[0].percentage=50,x=>x.lifecycle='exports',
        x=>x.observedAt-=3600001,x=>x.bindings[1].text='synthetic-secret-must-be-rejected',x=>x.bindings.push({...x.bindings[0],name:'SECOND_LEDGER'}),
        x=>x.bindings.push({name:'SEJIRE_EXPORT_CONFIG',type:'json'})]){
        const bad=structuredClone(e);mutate(bad);assert.throws(()=>reviewEvidence(bad),/export_source_evidence_invalid/);
      }
      assert.throws(()=>checkConfig({...result,maintenanceRequestedAt:1}),/export_configuration_invalid/);
    });
    const normal=join(temp,'normal'),alarmAt=Date.now()+3600000,saved=await seed(normal,seedScript,{alarmAt});
    active=new Miniflare(options(normal,exportScript,saved.config));
    await test('workerd rejects unauthenticated, browser, legacy execution and oversized requests',async()=>{
      assert.equal((await call(active,'/status',undefined,null)).status,401);
      assert.equal((await call(active,'/status',undefined,'9'.repeat(64))).status,401);
      assert.equal((await call(active,'/status',undefined,auth,{Origin:'https://attacker.example'})).status,403);
      for(const path of ['/api/checkout/orders','/api/fund/orders','/v1/publish','/api/fund/admin/treasury-topups/prepare']){
        const response=await active.dispatchFetch('https://source.example'+path,{method:'POST',body:'{}',headers:{Authorization:'Bearer '+auth}});assert.equal(response.status,404);
      }
      assert.equal((await call(active,'/snapshot',{},auth)).body.error,'export_target_acknowledgement_required');
      const oversize=await Promise.race([call(active,'/snapshot','x'.repeat(5000)),new Promise((_,reject)=>setTimeout(()=>reject(Error('oversized_body_hung')),2000))]);
      assert.equal(oversize.body.error,'export_request_too_large');
      const response=await active.dispatchFetch('https://source.example'+PREFIX+'/status',{method:'POST',headers:{Authorization:'Bearer '+auth},body:'{}'});assert.equal(response.status,405);
    });
    let firstSnapshot,firstStatus;
    await test('snapshot is blocked until a separate once-only quiescence seal after exporter adoption',async()=>{
      const frozen=await call(active,'/freeze',acknowledgement(saved.config));assert.equal(frozen.body.quiescence,'unsealed');assert.equal(frozen.body.sourceQuiescence,null);
      assert.equal((await call(active,'/snapshot',acknowledgement(saved.config))).body.error,'export_quiescence_seal_required');
      const input={target:acknowledgement(saved.config),quiescedAt:frozen.body.frozenAt-1,evidenceSha256:'4'.repeat(64),attestation:'SOURCE_EXECUTION_STOPPED'};
      assert.equal((await call(active,'/seal-quiescence',input)).body.error,'export_quiescence_before_freeze');
      input.quiescedAt=Date.now();const sealed=await call(active,'/seal-quiescence',input);assert.equal(sealed.status,200);assert.equal(sealed.body.quiescence,'owner-attested');
      assert.deepEqual((await call(active,'/seal-quiescence',input)).body,sealed.body);
      assert.equal((await call(active,'/seal-quiescence',{...input,evidenceSha256:'5'.repeat(64)})).body.error,'export_quiescence_conflict');
    });
    await test('real SQLite export preserves capabilities, exact signed bytes, reservations, revision, promo hash and original alarm',async()=>{
      const frozen=await call(active,'/freeze',acknowledgement(saved.config));assert.equal(frozen.status,200);assert.equal(frozen.body.originalAlarmAt,alarmAt);assert.equal(frozen.body.currentAlarmAt,null);
      firstStatus=frozen.body;const response=await call(active,'/snapshot',acknowledgement(saved.config));assert.equal(response.status,200,JSON.stringify(response.body));firstSnapshot=response.body;
      await validateLedgerSnapshot(firstSnapshot);assert.equal(firstSnapshot.alarmAt,alarmAt);assert.equal(firstSnapshot.tables.length,29);
      const table=name=>firstSnapshot.tables.find(t=>t.name===name);
      assert(table('api_sessions').rows.some(row=>row.includes(ownerHash)));assert(table('api_orders').rows.some(row=>row.includes('synthetic-idempotency-key')));
      assert(table('paid_payloads').rows.some(row=>row.includes('{"synthetic":"exact signed bytes \\n Қазақ шежіресі"}')));
      assert(table('fund_events').rows.some(row=>row.includes('{"fixture":"same immutable signed promo bytes"}')));
      assert(table('fund_settings').rows.some(row=>row.includes('b'.repeat(64))));assert(table('paid_holds').rows.some(row=>row.includes('70')));
      assert(table('treasury_revision').rows.some(row=>row.includes(3)));assert.equal(response.headers.get('X-Sejire-Freeze-Sha256'),frozen.body.freezeSha256);
      assert.equal(JSON.stringify(firstSnapshot).includes('must-not-enter-sql-snapshot'),false);assert.equal(JSON.stringify(firstSnapshot).includes(auth),false);
      assert(response.headers.get('Cache-Control').includes('no-store'));assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
      assert.deepEqual((await call(active,'/snapshot',acknowledgement(saved.config))).body,firstSnapshot);
      assert.equal((await call(active,'/alarm-reconciliation',{target:acknowledgement(saved.config),restoredAlarmAt:null,evidenceSha256:'5'.repeat(64),attestation:'ALARM_STATE_RECONCILED'})).body.error,'export_alarm_already_observed');
    });
    await test('operator collector saves an authenticated, hash-linked private snapshot and freeze sidecar without retries',async()=>{
      const configFile=join(temp,'collect-config.json'),tokenFile=join(temp,'synthetic-token'),out=join(temp,'collected');
      await writeFile(configFile,JSON.stringify(saved.config),{mode:0o600});await writeFile(tokenFile,auth,{mode:0o600});let calls=0;
      const localFetch=async(url,init)=>{calls++;assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer '+auth);return active.dispatchFetch(url,init);};
      const result=await collect({origin:'https://source.example',configFile,tokenFile,outputDirectory:out},localFetch);
      assert.equal(calls,3);assert.equal(result.snapshotSha256,firstSnapshot.sha256);assert.equal(result.executorStarted,false);
      const sidecar=JSON.parse(await readFile(join(out,'private-freeze-sidecar.json'),'utf8'));assert.equal(sidecar.freeze.originalAlarmAt,alarmAt);assert.equal(sidecar.snapshotSha256,result.snapshotSha256);
      assert.equal(sidecar.config.sourceEvidenceSha256,saved.config.sourceEvidenceSha256);assert.equal(sidecar.legacyKvExported,false);
      for(const file of await readdir(out)){assert.equal((await lstat(join(out,file))).mode&0o777,0o600);assert.equal((await readFile(join(out,file),'utf8')).includes(auth),false);}
      await assert.rejects(()=>collect({origin:'https://source.example',configFile,tokenFile,outputDirectory:out},localFetch),{code:'EEXIST'});assert.equal(calls,3);
      await assert.rejects(()=>collect({origin:'http://source.example',configFile,tokenFile,outputDirectory:join(temp,'bad-origin')},localFetch),/export_https_origin_required/);
      await assert.rejects(()=>collect({origin:'https://source.example',configFile,tokenFile,outputDirectory:join(temp,'changed-snapshot')},async(url,init)=>{
        const response=await active.dispatchFetch(url,init);if(url.endsWith('/snapshot')){const body=await response.json();body.tables[0].sha256='0'.repeat(64);return Response.json(body,{headers:response.headers});}return response;
      }),/ledger_snapshot_table_hash_mismatch/);
    });
    await active.dispose();active=null;
    await test('independent process restart returns the same snapshot rather than a fresh blank namespace',async()=>{
      await writeFile(join(normal,'restart.json'),JSON.stringify({script:exportScript,config:saved.config,alarmAt,snapshotSha256:firstSnapshot.sha256,freezeSha256:firstStatus.freezeSha256}),{mode:0o600});
      await new Promise((done,reject)=>{const child=spawn(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),'restart-child',normal],{stdio:'inherit',cwd:root});child.on('error',reject);child.on('exit',code=>code===0?done():reject(Error('restart_child_failed')));});
      const inspect=new Miniflare(options(normal,seedScript,{}));try{
        const response=await inspect.dispatchFetch('https://seed.example',{method:'POST',headers:{'X-Synthetic':'fixture-only','Content-Type':'application/json'},body:JSON.stringify({action:'inspect'})});
        const state=await response.json();assert.equal(state.executions,0);assert.equal(state.alarmAt,null);assert.equal(state.unrelated,'must-not-enter-sql-snapshot');assert.equal(state.freeze.originalAlarmAt,alarmAt);
      }finally{await inspect.dispose();}
    });
    let proxyConfig,proxyScript;
    await test('compatibility bundle is prepared only for the same private snapshot and frozen namespace',async()=>{
      const evidenceFile=join(temp,'proxy-source-evidence.json'),original=join(temp,'proxy-original-preparation'),cutover=join(temp,'cutover.json'),out=join(temp,'proxy-prepared');
      await writeFile(evidenceFile,JSON.stringify(saved.sourceEvidence),{mode:0o600});await prepare(evidenceFile,original);
      proxyConfig={schema:'sejire/legacy-compatibility-proxy/v1',linuxOrigin:'https://linux.example',namespaceId:saved.config.namespaceId,objectId:saved.config.objectId,sourceCommit:saved.config.sourceCommit,
        sourceSnapshotSha256:firstSnapshot.sha256,sourceFreezeSha256:firstStatus.freezeSha256,cutoverEvidenceSha256:'9'.repeat(64),acceptedAt:Date.now(),attestation:'LINUX_IMPORT_AND_LEGACY_ORIGINS_VERIFIED'};
      await writeFile(cutover,JSON.stringify(proxyConfig),{mode:0o600});const result=await prepareProxy(original,join(temp,'collected/private-freeze-sidecar.json'),cutover,out);
      assert.equal(result.deployed,false);assert.equal(result.sourceSnapshotSha256,firstSnapshot.sha256);proxyScript=join(out,'compatibility-proxy.mjs');
      const metadata=JSON.parse(await readFile(join(out,'upload-metadata.json'),'utf8'));assert.equal(metadata.bindings[0].namespace_id,saved.config.namespaceId);
      assert.equal(metadata.bindings[0].class_name,'CheckoutLedger');assert.deepEqual(metadata.migrations.steps,[]);assert(metadata.keep_bindings.includes('secret_text'));
      const wrong=join(temp,'wrong-cutover.json');await writeFile(wrong,JSON.stringify({...proxyConfig,sourceSnapshotSha256:'0'.repeat(64)}),{mode:0o600});
      await assert.rejects(()=>prepareProxy(original,join(temp,'collected/private-freeze-sidecar.json'),wrong,join(temp,'wrong-proxy')),/compatibility_cutover_mismatch/);
    });
    await test('workerd compatibility proxy preserves exact body, auth, idempotency and Origin while stripping old Host and spoofed IP headers',async()=>{
      const mock=fetchMock(),payload=' { "signed" : "synthetic exact bytes \\n Қазақ", "key":"old-client-key" } ',responseBody='{"status":"same-old-order"}\n';let forwards=0,forwardError,forwardedBody;
      mock.get('https://linux.example').intercept({path:'/api/checkout/orders',method:'POST'}).reply(options=>{
        try{
        forwards++;const h=new Headers(options.headers);assert.notEqual(h.get('host'),'old-worker.example');assert.equal(h.get('authorization'),'Bearer old-capability');
        assert.equal(h.get('idempotency-key'),'old-idempotency-key');assert.equal(h.get('origin'),'https://old-frontend.example');
        for(const name of ['forwarded','x-forwarded-for','x-real-ip','cf-connecting-ip','connection','proxy-authorization'])assert.equal(h.get(name),null,name);
        forwardedBody=new Response(options.body).text();
        return {statusCode:200,data:responseBody,responseOptions:{headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'https://old-frontend.example','Connection':'x-hop','x-hop':'remove-me'}}};
        }catch(error){forwardError=error;return {statusCode:500,data:'synthetic-forward-assertion-failed'};}
      });
      const settings=options(normal,proxyScript,saved.config);settings.fetchMock=mock;settings.bindings.SEJIRE_COMPAT_PROXY_CONFIG=proxyConfig;
      const runtime=new Miniflare(settings);try{
        const response=await runtime.dispatchFetch('https://old-worker.example/api/checkout/orders',{method:'POST',body:payload,headers:{Host:'old-worker.example',Authorization:'Bearer old-capability','Idempotency-Key':'old-idempotency-key',
          Origin:'https://old-frontend.example','Content-Type':'application/json',Forwarded:'for=attacker','X-Forwarded-For':'198.51.100.7','X-Real-IP':'198.51.100.8','CF-Connecting-IP':'198.51.100.9',Connection:'keep-alive','Proxy-Authorization':'secret-do-not-forward'}});
        if(forwardError)throw forwardError;assert.equal(forwards,1,'expected one intercepted Linux request');
        assert.equal(await forwardedBody,payload);
        assert.equal(response.status,200,await response.clone().text());assert.equal(await response.text(),responseBody);assert.equal(response.headers.get('Access-Control-Allow-Origin'),'https://old-frontend.example');
        assert.equal(response.headers.get('x-hop'),null);assert.equal(forwards,1);
        for(const path of ['/v1/admin','/v1/publish','/protocol/checkpoint','/api/fundamental/orders'])assert.equal((await runtime.dispatchFetch('https://old-worker.example'+path)).status,410);
        assert.equal((await runtime.dispatchFetch('https://old-worker.example/api/fund/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(2*1024*1024+1)})).status,503);
        assert.equal(forwards,1);
        // The private export route still works and the source executor stays frozen.
        assert.equal((await call(runtime,'/status')).body.freezeSha256,firstStatus.freezeSha256);
      }finally{await runtime.dispose();}
    });
    await test('compatibility refuses unsealed/mismatched source, redirects and uncertain POST without a second attempt',async()=>{
      let calls=0;const config=saved.config,baseEnv={SEJIRE_EXPORT_CONFIG:config,SEJIRE_EXPORT_TOKEN:auth,SEJIRE_COMPAT_PROXY_CONFIG:proxyConfig,
        CHECKOUT_LEDGER:{idFromName:()=>({toString:()=>config.objectId}),idFromString:()=>config.objectId,get:()=>({fetch:async()=>Response.json(firstStatus)})}};
      const make=()=>new Request('https://old-worker.example/api/fund/orders',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer old-capability'},body:'{"same":"request"}'});
      let response=await forwardLegacyRequest(make(),baseEnv,async()=>{calls++;throw Error('synthetic-lost-ack');});assert.equal(response.status,502);assert.equal((await response.json()).error,'compatibility_upstream_outcome_unknown');assert.equal(calls,1);
      response=await forwardLegacyRequest(make(),baseEnv,async(_url,init)=>{calls++;assert.equal(init.redirect,'manual');return new Response(null,{status:307,headers:{Location:'https://other.example'}});});assert.equal(response.status,502);assert.equal(calls,2);
      response=await forwardLegacyRequest(make(),{...baseEnv,SEJIRE_COMPAT_PROXY_CONFIG:{...proxyConfig,sourceFreezeSha256:'0'.repeat(64)}},async()=>{calls++;return new Response('unexpected');});assert.equal(response.status,503);assert.equal(calls,2);
      response=await forwardLegacyRequest(make(),baseEnv,async()=>{calls++;return new Response('x'.repeat(4*1024*1024+1));});assert.equal(response.status,502);assert.equal(calls,3);
      const oldStub=baseEnv.CHECKOUT_LEDGER.get;baseEnv.CHECKOUT_LEDGER.get=()=>({fetch:async()=>Response.json({...firstStatus,quiescence:'unsealed'})});
      response=await forwardLegacyRequest(make(),baseEnv,async()=>{calls++;return new Response('unexpected');});assert.equal(response.status,503);assert.equal(calls,3);baseEnv.CHECKOUT_LEDGER.get=oldStub;
    });
    await test('wrong namespace-derived object ID fails before obtaining a Durable Object stub',async()=>{
      let calls=0;const env={SEJIRE_EXPORT_TOKEN:auth,SEJIRE_EXPORT_CONFIG:saved.config,CHECKOUT_LEDGER:{idFromName:()=>({toString:()=> '0'.repeat(64)}),get:()=>{calls++;throw Error('must_not_get');}}};
      const r=request('/status');const response=await exporter.fetch(new Request(r.url,r.init),env);assert.equal(response.status,409);assert.equal((await response.json()).error,'export_namespace_object_mismatch');assert.equal(calls,0);
    });
    await test('null alarm is unconfirmed until explicit immutable reconciliation; read and replay cannot acknowledge it',async()=>{
      const directory=join(temp,'null-alarm'),current=await seed(directory,seedScript);
      const runtime=new Miniflare(options(directory,exportScript,current.config));try{
        const status=await call(runtime,'/status');assert.equal(status.body.alarmObservation,'null-unconfirmed');assert.equal(status.body.alarmReconciliation,null);
        await seal(runtime,current.config);
        assert.equal((await call(runtime,'/snapshot',acknowledgement(current.config))).body.error,'export_alarm_reconciliation_required');
        const body={target:acknowledgement(current.config),restoredAlarmAt:null,evidenceSha256:'5'.repeat(64),attestation:'ALARM_STATE_RECONCILED'};
        assert.equal((await call(runtime,'/alarm-reconciliation',{...body,attestation:'guess'})).status,409);
        const accepted=await call(runtime,'/alarm-reconciliation',body);assert.equal(accepted.status,200);assert.equal(accepted.body.originalAlarmAt,null);assert.equal(accepted.body.alarmObservation,'null-unconfirmed');
        assert.equal(accepted.body.alarmReconciliation.evidenceSha256,body.evidenceSha256);
        assert.deepEqual((await call(runtime,'/alarm-reconciliation',body)).body,accepted.body);
        assert.equal((await call(runtime,'/alarm-reconciliation',{...body,restoredAlarmAt:123})).body.error,'export_alarm_reconciliation_conflict');
        const snapshot=await call(runtime,'/snapshot',acknowledgement(current.config));assert.equal(snapshot.status,200);assert.equal(snapshot.body.alarmAt,null);await validateLedgerSnapshot(snapshot.body);
        assert.equal(snapshot.headers.get('X-Sejire-Freeze-Sha256'),accepted.body.freezeSha256);
      }finally{await runtime.dispose();}
    });
    await test('documented first-running-alarm null case records fired/unknown and refuses a snapshot',async()=>{
      const values=new Map(),id='6'.repeat(64),config=configFor(id);let alarm=null,sqlCalls=0;
      const transaction={get:async key=>structuredClone(values.get(key)),put:async(key,value)=>{values.set(key,structuredClone(value));},getAlarm:async()=>alarm,deleteAlarm:async()=>{alarm=null;}};
      const storage={...transaction,transaction:async fn=>fn(transaction),sql:{exec(){sqlCalls++;throw Error('SQL_must_not_run_before_reconciliation');}}};
      const env={SEJIRE_EXPORT_TOKEN:auth,SEJIRE_EXPORT_CONFIG:config,CHECKOUT_LEDGER:{idFromName:()=>({toString:()=>id})}};
      const object=new CheckoutLedger({id:{toString:()=>id},storage,blockConcurrencyWhile:fn=>fn()},env);
      await object.alarm();const sealing=request('/seal-quiescence',{target:acknowledgement(config),quiescedAt:Date.now(),evidenceSha256:'4'.repeat(64),attestation:'SOURCE_EXECUTION_STOPPED'});
      assert.equal((await object.fetch(new Request(sealing.url,sealing.init))).status,200);
      const r=request('/snapshot',acknowledgement(config)),response=await object.fetch(new Request(r.url,r.init));
      assert.equal(response.status,409);assert.equal((await response.json()).error,'export_alarm_reconciliation_required');assert.equal(sqlCalls,0);
      const record=values.get('sejire:legacy-export:freeze:v1');assert.equal(record.originalAlarmAt,null);assert.equal(record.alarmObservation,'null-unconfirmed');assert(Number.isSafeInteger(record.alarmInvocationObservedAt));
      assert.equal(record.alarmReconciliation,null);
    });
    await test('active paid, promo and legacy upload leases are rejected with SQL history retained',async()=>{
      for(const leaseTable of ['paid_orders','fund_jobs','api_execution']){
        const directory=join(temp,leaseTable),current=await seed(directory,seedScript,{alarmAt:Date.now()+3600000,leaseTable});
        const runtime=new Miniflare(options(directory,exportScript,current.config));try{await seal(runtime,current.config);assert.equal((await call(runtime,'/snapshot',acknowledgement(current.config))).body.error,'ledger_snapshot_active_lease');}finally{await runtime.dispose();}
      }
    });
    await test('unknown tables and unsupported old schema are rejected rather than initialized or silently omitted',async()=>{
      for(const [variant,expected] of [[{unknown:true},'ledger_snapshot_unknown_table'],[{incomplete:true},'ledger_snapshot_schema_upgrade_required']]){
        const directory=join(temp,expected),current=await seed(directory,seedScript,{alarmAt:Date.now()+3600000,...variant});
        const runtime=new Miniflare(options(directory,exportScript,current.config));try{await seal(runtime,current.config);assert.equal((await call(runtime,'/snapshot',acknowledgement(current.config))).body.error,expected);}finally{await runtime.dispose();}
      }
    });
    console.log(JSON.stringify({schema:'sejire/legacy-export-test-results/v1',passed:passed.length,groups:passed,node:process.version,externalNetworkRequests:0,productionOperations:0,
      realWorkerd:true,realPersistentSQLite:true,firstRunningAlarmNull:'documented API semantics simulated in focused unit test',cloudflareUploadApi:'not called; metadata validated offline only'}));
  }finally{await active?.dispose();await rm(temp,{recursive:true,force:true});}
}
