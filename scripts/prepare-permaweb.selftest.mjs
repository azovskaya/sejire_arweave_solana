import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {preparePermaweb} from './prepare-permaweb.mjs';

const root=await mkdtemp(join(tmpdir(),'sejire-permaweb-'));
try{
  const source=join(root,'dist');await mkdir(join(source,'assets'),{recursive:true});
  await writeFile(join(source,'index.html'),'<script src="./assets/app.js"></script>');
  await writeFile(join(source,'assets','app.js'),'const fixture=1;');
  const sha='a'.repeat(40),first=await preparePermaweb(source,join(root,'one'),sha);
  const second=await preparePermaweb(source,join(root,'two'),sha);
  assert.deepEqual(first,second,'same checked input yields the same manifest');
  assert.equal(first.fileCount,3);assert.equal(first.sourceCommit,sha);
  assert.equal(await readFile(join(root,'one','404.html'),'utf8'),await readFile(join(source,'index.html'),'utf8'));
  assert.deepEqual(JSON.parse(await readFile(join(root,'one','release-manifest.json'),'utf8')),first);
  await assert.rejects(()=>preparePermaweb(source,join(root,'one'),sha),'existing releases are never overwritten');
  await writeFile(join(source,'index.html'),'<script src="https://cdn.example/app.js"></script><a href="./assets/app.js">local</a>');
  await assert.rejects(()=>preparePermaweb(source,join(root,'invalid'),sha),/nonportable_static_entry/);
  console.log('PASS deterministic static manifest, relative entry, no release overwrite');
}finally{await rm(root,{recursive:true,force:true});}
