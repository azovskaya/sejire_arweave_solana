/** Recover an accepted static CI artifact. No wallet, upload, payment or ArNS write. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPOSITORY, validateReleaseEvidence } from './worker-release-gate.mjs';
import { BOUNDARY_FILE, FUNDED_PROFILE, INDEPENDENT_PROFILE, INDEPENDENT_ROOT_FILES,
  PROFILE_FILE, RECOVERY_FILES, verifyIndependentBuild } from './static-release-profile.mjs';

export const BRANCH = 'feat/decentralized-arweave-20261116';
export const ARTIFACT_NAME = 'permaweb-static-release';
export const ACCEPTED_DIR = '.cache/permaweb-accepted';
export const EVIDENCE_DIR = '.cache/permaweb-upload-evidence';
export const MAX_RELEASE_BYTES = 30 * 1024 * 1024;
export const MAX_RELEASE_FILES = 256;
export const FUND_ORIGIN = 'https://sejire-sponsor.azovskaya-alissa.workers.dev';
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const ROOT_FILES = new Set(['index.html', '404.html', 'admin-lock.json', 'favicon.ico', 'favicon.svg']);
const EXTRA_ROOT_FILES = new Set([PROFILE_FILE, BOUNDARY_FILE]);
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function requireValue(ok, code) { if (!ok) throw Error(code); }
export function staticPath(name) {
  return ROOT_FILES.has(name) || EXTRA_ROOT_FILES.has(name) || RECOVERY_FILES.some(file => name === `recovery/${file}`) ||
    /^assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css|svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?|ttf)$/.test(name);
}

export function permawebRequest(env) {
  requireValue(env.GITHUB_REPOSITORY === REPOSITORY, 'permaweb_repository_mismatch');
  requireValue(env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'permaweb_manual_only');
  requireValue(env.GITHUB_REF === `refs/heads/${BRANCH}`, 'permaweb_branch_mismatch');
  requireValue(env.PERMAWEB_CONFIRM === 'pack-ready', 'permaweb_confirmation_required');
  requireValue(['prepare', 'upload'].includes(env.PERMAWEB_MODE), 'permaweb_invalid_release_mode');
  if (env.PERMAWEB_MODE === 'upload') requireValue(env.GITHUB_RUN_ATTEMPT === '1', 'permaweb_upload_rerun_requires_prior_evidence');
  requireValue(SHA.test(env.GITHUB_SHA ?? ''), 'permaweb_invalid_sha');
  const numbers = ['PERMAWEB_CI_RUN_ID', 'PERMAWEB_CI_ATTEMPT'].map(key => {
    requireValue(/^[1-9][0-9]*$/.test(env[key] ?? '') && Number.isSafeInteger(Number(env[key])), 'permaweb_invalid_run');
    return Number(env[key]);
  });
  return { sha: env.GITHUB_SHA, runId: numbers[0], attempt: numbers[1] };
}

async function githubJson(path, token, fetcher) {
  let response;
  try {
    response = await fetcher(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    requireValue(response.ok, 'permaweb_evidence_unavailable');
    return await response.json();
  } catch { throw Error('permaweb_evidence_unavailable'); }
}

export function acceptedArtifact(request, artifacts, jobs) {
  const matches = artifacts.filter(item => item.name === ARTIFACT_NAME && !item.expired);
  requireValue(matches.length === 1, 'permaweb_ambiguous_artifact');
  const item = matches[0], verify = jobs.find(job => job.name === 'verify');
  requireValue(Number.isSafeInteger(item.id) && item.id > 0 && item.workflow_run?.id === request.runId &&
    item.workflow_run.head_sha === request.sha && item.workflow_run.head_branch === BRANCH &&
    /^sha256:[a-f0-9]{64}$/.test(item.digest ?? '') && Number.isSafeInteger(item.size_in_bytes) &&
    item.size_in_bytes > 0 && item.size_in_bytes <= MAX_RELEASE_BYTES, 'permaweb_artifact_mismatch');
  // A single old artifact from an earlier attempt is not an accepted new build.
  const created = Date.parse(item.created_at), started = Date.parse(verify?.started_at), completed = Date.parse(verify?.completed_at);
  requireValue(Number.isFinite(created) && Number.isFinite(started) && Number.isFinite(completed) &&
    created >= started && created <= completed, 'permaweb_artifact_attempt_mismatch');
  return item;
}

export async function checkPermawebRelease(env, fetcher = fetch) {
  const request = permawebRequest(env);
  requireValue(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'permaweb_token_missing');
  const read = path => githubJson(path, env.GH_TOKEN, fetcher);
  const [run, ref] = await Promise.all([read(`actions/runs/${request.runId}`), read(`git/ref/heads/${BRANCH}`)]);
  const jobs = [], artifacts = [];
  for (const [target, path, key] of [
    [jobs, `actions/runs/${request.runId}/attempts/${request.attempt}/jobs`, 'jobs'],
    [artifacts, `actions/runs/${request.runId}/artifacts`, 'artifacts'],
  ]) {
    let total;
    for (let page = 1; page <= 10; page++) {
      const result = await read(`${path}?per_page=100&page=${page}`);
      requireValue(Number.isSafeInteger(result.total_count) && result.total_count > 0 && Array.isArray(result[key]), 'permaweb_evidence_incomplete');
      total ??= result.total_count;
      requireValue(total === result.total_count && result[key].length <= 100, 'permaweb_evidence_changed');
      target.push(...result[key]);
      if (target.length >= total) break;
      requireValue(result[key].length > 0, 'permaweb_evidence_incomplete');
    }
    requireValue(target.length === total && new Set(target.map(item => item.id)).size === total, 'permaweb_evidence_incomplete');
  }
  validateReleaseEvidence(request, run, ref, jobs, { branch: BRANCH });
  return { request, artifact: acceptedArtifact(request, artifacts, jobs) };
}

export async function boundedBytes(response, limit) {
  const declared = response.headers.get('content-length');
  requireValue(declared === null || /^\d+$/.test(declared) && Number(declared) <= limit, 'permaweb_response_too_large');
  requireValue(response.body, 'permaweb_response_missing');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length; requireValue(size <= limit, 'permaweb_response_too_large'); chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export function extractAcceptedZip(bytes, output) {
  requireValue(bytes.length <= MAX_RELEASE_BYTES, 'permaweb_zip_too_large');
  // Validate every path and declared size before creating the destination. Never overwrite.
  const python = `import io,pathlib,re,stat,sys,zipfile
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
 entries=z.infolist()
 if len(entries)>300: raise RuntimeError('permaweb_zip_too_many_entries')
 names=set();total=0
 for f in entries:
  p=pathlib.PurePosixPath(f.filename)
  if f.filename in names or p.is_absolute() or '..' in p.parts or '\\\\' in f.filename or str(p)!=f.filename.rstrip('/'): raise RuntimeError('permaweb_unsafe_zip_path')
  names.add(f.filename)
  if stat.S_ISLNK(f.external_attr>>16) or f.flag_bits&1: raise RuntimeError('permaweb_unsafe_zip_entry')
  if f.is_dir():
   if f.filename not in ['assets/','recovery/']: raise RuntimeError('permaweb_unexpected_zip_directory')
  elif f.filename not in ${JSON.stringify([...ROOT_FILES, ...EXTRA_ROOT_FILES, 'release-manifest.json', ...RECOVERY_FILES.map(file => `recovery/${file}`)])} and not re.fullmatch(r'assets/[A-Za-z0-9_-][A-Za-z0-9_.-]*\\.(?:js|css|svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?|ttf)',f.filename): raise RuntimeError('permaweb_unexpected_zip_file')
  total+=f.file_size
 if total>${MAX_RELEASE_BYTES}: raise RuntimeError('permaweb_zip_too_large')
 root.mkdir(parents=True,exist_ok=False)
 for f in entries:
  if f.is_dir(): continue
  target=root.joinpath(*pathlib.PurePosixPath(f.filename).parts)
  target.parent.mkdir(parents=True,exist_ok=True)
  target.write_bytes(z.read(f))
`;
  try { execFileSync('python3', ['-c', python, resolve(output)], { input: bytes, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 }); }
  catch { throw Error('permaweb_zip_rejected'); }
}

async function releaseFiles(root, dir = root) {
  requireValue((await lstat(dir)).isDirectory() && !(await lstat(dir)).isSymbolicLink(), 'permaweb_unsafe_release');
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) files.push(...await releaseFiles(root, path));
    else { requireValue(item.isFile(), 'permaweb_unsafe_release'); files.push(path.slice(root.length + 1).replaceAll('\\', '/')); }
  }
  return files.sort();
}

export async function verifyRelease(directory, sourceCommit, { provenance = false, expectedProfile } = {}) {
  requireValue(SHA.test(sourceCommit ?? ''), 'permaweb_invalid_sha');
  const root = resolve(directory), names = await releaseFiles(root);
  requireValue(names.length > 0 && names.length <= MAX_RELEASE_FILES, 'permaweb_file_count');
  const manifestBytes = await readFile(join(root, 'release-manifest.json'));
  requireValue(manifestBytes.length <= 1024 * 1024, 'permaweb_manifest_too_large');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  requireValue(manifest.schema === 'sejire/static-release/v1' && manifest.sourceCommit === sourceCommit &&
    manifest.entry === 'index.html' && manifest.fallback === '404.html' && manifest.files &&
    typeof manifest.files === 'object' && !Array.isArray(manifest.files), 'permaweb_release_manifest_mismatch');
  const paths = Object.keys(manifest.files).sort();
  const profile = manifest.profile ?? FUNDED_PROFILE;
  requireValue([FUNDED_PROFILE, INDEPENDENT_PROFILE].includes(profile) &&
    (expectedProfile === undefined || profile === expectedProfile), 'permaweb_release_profile_mismatch');
  const requiredPaths = profile === INDEPENDENT_PROFILE
    ? [...INDEPENDENT_ROOT_FILES, ...RECOVERY_FILES.map(file => `recovery/${file}`)] : [...ROOT_FILES];
  requireValue(paths.every(staticPath) && paths.length === manifest.fileCount &&
    requiredPaths.every(name => paths.includes(name)), 'permaweb_release_paths_mismatch');
  const expected = [...paths, 'release-manifest.json', ...(provenance ? ['build-provenance.json'] : [])].sort();
  requireValue(JSON.stringify(expected) === JSON.stringify(names), 'permaweb_unlisted_release_file');
  let sourceBytes = 0; const files = [];
  for (const name of names) {
    const stat = await lstat(join(root, name));
    requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_RELEASE_BYTES, 'permaweb_unsafe_release');
    const bytes = await readFile(join(root, name)), sha256 = digest(bytes);
    if (name in manifest.files) {
      requireValue(HASH.test(manifest.files[name]) && sha256 === manifest.files[name], 'permaweb_file_digest_mismatch');
      sourceBytes += bytes.length;
    }
    files.push({ path: name, bytes: bytes.length, sha256 });
  }
  requireValue(sourceBytes === manifest.totalBytes && files.reduce((sum, file) => sum + file.bytes, 0) <= MAX_RELEASE_BYTES, 'permaweb_release_size_mismatch');
  const html = await readFile(join(root, 'index.html'), 'utf8');
  requireValue(html.includes('./assets/') && !/<(?:script|link)[^>]+(?:src|href)=["'](?:https?:|\/\/|\/)/i.test(html), 'permaweb_nonportable_entry');
  for (const [, path] of html.matchAll(/(?:src|href)=["']\.\/(assets\/[^"']+)["']/g)) requireValue(paths.includes(path), 'permaweb_missing_entry_asset');
  requireValue(html === await readFile(join(root, '404.html'), 'utf8'), 'permaweb_fallback_mismatch');
  if (profile === INDEPENDENT_PROFILE) await verifyIndependentBuild(root);
  else {
    requireValue(!paths.some(path => EXTRA_ROOT_FILES.has(path) || path.startsWith('recovery/')), 'permaweb_mixed_release_profile');
    const lock = JSON.parse(await readFile(join(root, 'admin-lock.json'), 'utf8'));
    requireValue(lock.schema === 'sejire/admin-lock/v1' && lock.configured === true && lock.algorithm === 'PBKDF2-SHA256' && lock.iterations === 600000, 'permaweb_admin_lock_missing');
    const js = await Promise.all(paths.filter(path => path.startsWith('assets/') && path.endsWith('.js')).map(path => readFile(join(root, path), 'utf8')));
    requireValue(js.some(body => body.includes(FUND_ORIGIN)), 'permaweb_worker_origin_missing');
  }
  return { root, manifest, manifestSha256: digest(manifestBytes), files };
}

export function buildProvenance(evidence, release) {
  return { schema: 'sejire/permaweb-provenance/v1', artifact: ARTIFACT_NAME,
    run: evidence.request.runId, attempt: evidence.request.attempt, artifactId: evidence.artifact.id,
    sourceCommit: evidence.request.sha, publishedByCommit: evidence.request.sha, profile: release.manifest.profile ?? FUNDED_PROFILE,
    zipSha256: evidence.artifact.digest.slice(7), releaseManifestSha256: release.manifestSha256 };
}

export async function verifyAcceptedRelease(evidence, directory = ACCEPTED_DIR) {
  const release = await verifyRelease(directory, evidence.request.sha, { provenance: true, expectedProfile: INDEPENDENT_PROFILE });
  const actual = JSON.parse(await readFile(join(release.root, 'build-provenance.json'), 'utf8'));
  requireValue(JSON.stringify(actual) === JSON.stringify(buildProvenance(evidence, release)), 'permaweb_provenance_mismatch');
  return release;
}

export async function recoverPermawebRelease(env, { fetcher = fetch, directory = ACCEPTED_DIR, evidenceDirectory = EVIDENCE_DIR } = {}) {
  const evidence = await checkPermawebRelease(env, fetcher);
  const response = await fetcher(`https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${evidence.artifact.id}/zip`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GH_TOKEN}` },
    redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  const location = response.headers.get('location');
  requireValue(response.status === 302 && location && new URL(location).protocol === 'https:' && !new URL(location).username && !new URL(location).password, 'permaweb_artifact_redirect');
  // The signed storage URL never receives the GitHub credential.
  const downloaded = await fetcher(location, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  requireValue(downloaded.ok, 'permaweb_artifact_download_failed');
  const bytes = await boundedBytes(downloaded, MAX_RELEASE_BYTES);
  requireValue(digest(bytes) === evidence.artifact.digest.slice(7), 'permaweb_zip_digest_mismatch');
  requireValue(bytes.length === evidence.artifact.size_in_bytes, 'permaweb_artifact_size_mismatch');
  extractAcceptedZip(bytes, directory);
  const release = await verifyRelease(directory, evidence.request.sha, { expectedProfile: INDEPENDENT_PROFILE });
  await writeFile(join(release.root, 'build-provenance.json'), JSON.stringify(buildProvenance(evidence, release), null, 2) + '\n', { flag: 'wx' });
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(join(evidenceDirectory, 'accepted-build.json'), JSON.stringify(buildProvenance(evidence, release), null, 2) + '\n');
  return verifyAcceptedRelease(evidence, directory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const release = process.argv[2] === '--check-only'
      ? await verifyAcceptedRelease(await checkPermawebRelease(process.env))
      : await recoverPermawebRelease(process.env);
    console.log(JSON.stringify({ status: 'PASS', sourceCommit: release.manifest.sourceCommit,
      files: release.files.length, bytes: release.files.reduce((sum, file) => sum + file.bytes, 0), directory: ACCEPTED_DIR }));
  } catch (error) { console.error(error instanceof Error && /^(?:permaweb_|release_|independent_)[a-z_]+$/.test(error.message) ? error.message : 'permaweb_release_failed'); process.exitCode = 1; }
}
