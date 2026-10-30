import {createHash} from 'node:crypto';
import {cp,mkdir,readFile,readdir,stat,writeFile} from 'node:fs/promises';
import {resolve,relative,join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
async function files(root,dir=root){
  const entries=[];
  for(const item of await readdir(dir,{withFileTypes:true})){
    const path=join(dir,item.name);
    if(item.isDirectory())entries.push(...await files(root,path));
    else if(item.isFile())entries.push(relative(root,path).split('\\').join('/'));
    else throw Error('unsafe_static_asset');
  }
  return entries.sort();
}
/** Deterministic local release. The upload and ArNS update are separate owner actions. */
export async function preparePermaweb(source,out,sourceCommit){
  if(!/^[a-f0-9]{40}$/.test(sourceCommit))throw Error('invalid_source_commit');
  const src=resolve(source),dst=resolve(out);
  if(src===dst||dst.startsWith(src+'/'))throw Error('invalid_release_path');
  await mkdir(dirname(dst),{recursive:true});
  await cp(src,dst,{recursive:true,force:false,errorOnExist:true});
  const html=await readFile(join(dst,'index.html'),'utf8');
  if(!html.includes('./assets/')||/<(?:script|link)[^>]+(?:src|href)=["']https?:\/\//i.test(html))throw Error('nonportable_static_entry');
  await writeFile(join(dst,'404.html'),html);
  const names=(await files(dst)).filter(name=>name!=='release-manifest.json');
  const hashes={};let bytes=0;
  for(const name of names){const path=join(dst,name),info=await stat(path);if(!info.isFile())throw Error('unsafe_static_asset');
    const data=await readFile(path);hashes[name]=sha256(data);bytes+=data.length;}
  const manifest={schema:'sejire/static-release/v1',sourceCommit,entry:'index.html',fallback:'404.html',
    fileCount:names.length,totalBytes:bytes,files:hashes};
  await writeFile(join(dst,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}

if(process.argv[1]&&resolve(process.argv[1])===new URL(import.meta.url).pathname){
  const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const manifest=await preparePermaweb('apps/web/dist','.cache/permaweb-release',sha);
  console.log(`Prepared static release: ${manifest.fileCount} files, ${manifest.totalBytes} bytes; no upload or payment.`);
}
