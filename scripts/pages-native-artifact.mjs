// Publishes only the accepted static artifact, never a local working directory.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const repo='azovskaya/sejire_arweave_solana', run=Number(process.env.CHECKED_RUN), sha=process.env.GITHUB_SHA;
const publishRoot=process.env.PUBLISH_ROOT==='1';
if (!Number.isSafeInteger(run)||run<1||!sha||!/^[a-f0-9]{40}$/.test(sha)) throw Error('An explicit checked run and source commit are required');
if (!process.env.GH_TOKEN) throw Error('GitHub Actions token required; do not pass secrets as command arguments');
const headers={Authorization:`Bearer ${process.env.GH_TOKEN}`,Accept:'application/vnd.github+json'};
async function api(path){const r=await fetch(`https://api.github.com/repos/${repo}/${path}`,{headers});if(!r.ok)throw Error(`GitHub HTTP ${r.status}`);return r.json();}
const workflow=await api(`actions/runs/${run}`);
if(workflow.head_sha!==sha||workflow.name!=='SEJIRE checks'||workflow.conclusion!=='success')throw Error('The current source commit must have successful SEJIRE checks');
const artifacts=await api(`actions/runs/${run}/artifacts`);
const matches=artifacts.artifacts.filter(a=>a.name==='native-admin-build'&&!a.expired);
if(matches.length!==1)throw Error('Exactly one accepted native build is required');
const metadata=matches[0],id=metadata.id,digest=metadata.digest?.replace(/^sha256:/,'');
if(metadata.workflow_run.id!==run||metadata.workflow_run.head_sha!==sha||!/^[a-f0-9]{64}$/.test(digest??''))throw Error('Artifact provenance or digest mismatch');
// Fetch the redirect with auth, then download from the signed storage URL without forwarding auth.
const redirect=await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,{headers,redirect:'manual'});
if(redirect.status!==302)throw Error(`Artifact redirect HTTP ${redirect.status}`);
const downloaded=await fetch(redirect.headers.get('location'));
if(!downloaded.ok)throw Error(`Artifact download HTTP ${downloaded.status}`);
const zip=Buffer.from(await downloaded.arrayBuffer());
if(createHash('sha256').update(zip).digest('hex')!==digest)throw Error('Artifact ZIP digest mismatch');
mkdirSync('.pages-download');writeFileSync('.pages-download/native.zip',zip);
execFileSync('git',['fetch','origin','gh-pages'],{stdio:'inherit'});
execFileSync('git',['worktree','add','--detach','.pages-site','origin/gh-pages'],{stdio:'inherit'});
// Validate every ZIP path before writing. Root publication overlays only build files.
execFileSync('python3',['-c',`import zipfile,pathlib,shutil
import json
publish_root=${publishRoot?'True':'False'}
root=pathlib.Path('.pages-site' if publish_root else '.pages-site/native-admin')
with zipfile.ZipFile('.pages-download/native.zip') as z:
 for f in z.infolist():
  p=pathlib.PurePosixPath(f.filename)
  if p.is_absolute() or '..' in p.parts or ((f.external_attr>>16)&0o170000)==0o120000: raise RuntimeError('Unsafe artifact path')
 if sum(f.file_size for f in z.infolist())>30000000: raise RuntimeError('Oversized artifact')
 if publish_root:
  allowed={'index.html','404.html','admin-lock.json','favicon.ico','favicon.svg'}
  for f in z.infolist():
   p=pathlib.PurePosixPath(f.filename)
   if not f.is_dir() and not (str(p) in allowed or (len(p.parts)>1 and p.parts[0]=='assets')): raise RuntimeError('Unexpected root artifact path')
  lock=json.loads(z.read('admin-lock.json'))
  if lock.get('schema')!='sejire/admin-lock/v1' or lock.get('configured') is not True: raise RuntimeError('Owner admin verifier is not configured')
  if z.read('admin-lock.json')!=pathlib.Path('apps/web/public/admin-lock.json').read_bytes(): raise RuntimeError('Admin verifier differs from checked source')
  for f in z.infolist():
   if f.is_dir(): continue
   dest=root.joinpath(*pathlib.PurePosixPath(f.filename).parts)
   dest.parent.mkdir(parents=True,exist_ok=True)
   dest.write_bytes(z.read(f))
 else:
  if root.exists(): shutil.rmtree(root)
  root.mkdir()
  z.extractall(root)
`],{stdio:'inherit'});
const destination=publishRoot?'.pages-site':'.pages-site/native-admin';
const html=readFileSync(`${destination}/index.html`,'utf8');
if(!html.includes('./assets/'))throw Error('Expected relocatable build');
const provenance={artifact:'native-admin-build',run,artifactId:id,sourceCommit:sha,zipSha256:digest,publishedByCommit:process.env.GITHUB_SHA};
writeFileSync(`${destination}/build-provenance.json`,JSON.stringify(provenance,null,2)+'\n');
console.log(`Verified source commit, successful checks, ZIP digest and relative asset paths. Published to ${publishRoot?'root':'native-admin'}; other Pages paths preserved.`);
