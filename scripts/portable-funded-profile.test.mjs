import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROFILE_FILE, RECOVERY_FILES, INDEPENDENT_PROFILE } from './static-release-profile.mjs';
import { portableProfile, publicApiOrigin, assertPortableCode, finalizePortableBoundary, verifyPortableFundedBuild,
  PORTABLE_FUNDED_PROFILE, PORTABLE_FUNDED_BRANCH, PORTABLE_FUNDED_ARTIFACT, FUNDED_REQUIRED_MODULES } from './portable-funded-profile.mjs';
import { preparePermaweb } from './prepare-permaweb.mjs';
import { permawebRequest, acceptedArtifact, verifyRelease, releaseContract } from './permaweb-release.mjs';

const API = 'https://sejire-api.azovskaya.prod.page';
const SHA = 'a'.repeat(40);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sejire-portable-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await mkdir(join(dist, 'recovery'));
  const html = '<!doctype html><script type="module" src="./assets/main.js"></script>';
  for (const name of ['index.html', '404.html']) await writeFile(join(dist, name), html);
  for (const name of ['favicon.svg', 'favicon.ico']) await writeFile(join(dist, name), '<svg/>');
  for (const name of RECOVERY_FILES) await writeFile(join(dist, 'recovery', name), name.endsWith('.json') ? '{}' : 'offline recovery fixture');
  await writeFile(join(dist, PROFILE_FILE), JSON.stringify(portableProfile(API)));
  const chunks = [{ file: 'assets/main.js', imports: [], dynamicImports: [], modules: [...FUNDED_REQUIRED_MODULES] }];
  await writeFile(join(dist, 'assets/main.js'), `const api=${JSON.stringify(API)};`);
  await finalizePortableBoundary(dist, chunks);
  return { root, dist, chunks };
}

test('portable origin is an explicit public HTTPS origin without Worker/default/credentials/path', () => {
  assert.equal(publicApiOrigin(API), API);
  for (const value of [undefined, '', 'http://api.sejire.org', API+'/', API+'/path', API+'?x=1',
    'https://u:p@api.sejire.org', 'https://localhost', 'https://127.0.0.1', 'https://[::1]',
    'https://api.invalid', 'https://api.example.com', 'https://api.workers.dev', 'https://x.pages.dev']) {
    assert.throws(() => publicApiOrigin(value), /portable_/);
  }
});

test('portable build binds SOL/promo/admin, one API, every chunk and offline recovery', async t => {
  const f = await fixture(t);
  const verified = await verifyPortableFundedBuild(f.dist, API);
  assert.equal(verified.profile, PORTABLE_FUNDED_PROFILE);
  assert.equal(verified.mandatoryCloudflare, false);
  assert.equal(verified.mandatorySejireService, true);
  assert.equal(verified.recoveryFiles, 8);
  const out = join(f.root, 'release');
  await preparePermaweb(f.dist, out, SHA);
  assert.equal((await verifyRelease(out, SHA, { expectedProfile: PORTABLE_FUNDED_PROFILE })).manifest.profile, PORTABLE_FUNDED_PROFILE);
  await assert.rejects(verifyRelease(out, SHA, { expectedProfile: INDEPENDENT_PROFILE }), /profile_mismatch/);
});

test('wrong API, extra profile properties, and fake network are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyPortableFundedBuild(f.dist, 'https://another-api.azovskaya.prod.page'), /profile_mismatch/);
  for (const patch of [{ paymentNetwork: 'devnet' }, { serviceLamports: '0' }, { mandatorySejireService: false }, { extra: true }]) {
    await writeFile(join(f.dist, PROFILE_FILE), JSON.stringify({ ...portableProfile(API), ...patch }));
    await assert.rejects(verifyPortableFundedBuild(f.dist, API), /profile_mismatch/);
  }
});

test('a lazy chunk cannot smuggle a Worker, fixture, dependency, or a different module graph', async t => {
  const f = await fixture(t);
  const extra = { file: 'assets/lazy.js', imports: [], dynamicImports: [], modules: ['apps/web/src/lib/checkout/paidTypes.ts'] };
  f.chunks[0].dynamicImports = [extra.file];
  await writeFile(join(f.dist, extra.file), 'export const ready=true;');
  await finalizePortableBoundary(f.dist, [...f.chunks, extra]);
  await verifyPortableFundedBuild(f.dist, API);
  await writeFile(join(f.dist, extra.file), 'fetch("https://old-service.workers.dev")');
  await finalizePortableBoundary(f.dist, [...f.chunks, extra]);
  await assert.rejects(verifyPortableFundedBuild(f.dist, API), /cloudflare_endpoint/);
  await writeFile(join(f.dist, extra.file), 'export const ready=true;');
  for (const forbidden of ['node_modules/@ardrive/turbo-sdk/web/index.js', 'node_modules/@cloudflare/workers/foo.js',
    'apps/sponsor/src/fund/api.ts', 'apps/web/tests/fixture.ts']) {
    extra.modules = [forbidden]; await finalizePortableBoundary(f.dist, [...f.chunks, extra]);
    await assert.rejects(verifyPortableFundedBuild(f.dist, API), /forbidden_module/);
  }
});

test('changed JS bytes, missing recovery, old UI verifier and absent required runtime fail closed', async t => {
  const f = await fixture(t);
  const js = join(f.dist, 'assets/main.js'), original = await readFile(js);
  await writeFile(js, Buffer.concat([original, Buffer.from('console.log(1);')]));
  await assert.rejects(verifyPortableFundedBuild(f.dist, API), /digest_mismatch/);
  await writeFile(js, original);
  await writeFile(join(f.dist, 'admin-lock.json'), '{}');
  await assert.rejects(verifyPortableFundedBuild(f.dist, API), /legacy_admin_file/);
  await rm(join(f.dist, 'admin-lock.json'));
  f.chunks[0].modules = f.chunks[0].modules.slice(1);
  await finalizePortableBoundary(f.dist, f.chunks);
  await assert.rejects(verifyPortableFundedBuild(f.dist, API), /required_module_missing/);
  await rm(join(f.dist, 'recovery/recover.mjs'));
  await assert.rejects(verifyPortableFundedBuild(f.dist, API), /required_file_missing/);
});

test('portable release gets its own exact branch and artifact; independent contract is preserved', () => {
  const env = { GITHUB_REPOSITORY:'azovskaya/sejire_arweave_solana', GITHUB_EVENT_NAME:'workflow_dispatch',
    GITHUB_REF:`refs/heads/${PORTABLE_FUNDED_BRANCH}`, GITHUB_SHA:SHA, PERMAWEB_MODE:'prepare',
    PERMAWEB_CONFIRM:'pack-ready', PERMAWEB_CI_RUN_ID:'7', PERMAWEB_CI_ATTEMPT:'1', PERMAWEB_PROFILE:PORTABLE_FUNDED_PROFILE };
  const request = permawebRequest(env);
  assert.equal(request.profile, PORTABLE_FUNDED_PROFILE);
  assert.throws(() => permawebRequest({ ...env, PERMAWEB_PROFILE:undefined }), /branch_mismatch/);
  assert.throws(() => permawebRequest({ ...env, GITHUB_REF:'refs/heads/main' }), /branch_mismatch/);
  assert.throws(() => permawebRequest({ ...env, PERMAWEB_PROFILE:'anything' }), /profile_mismatch/);
  assert.equal(releaseContract().branch, 'feat/decentralized-arweave-20261116');
  const artifact = { id:1, name:PORTABLE_FUNDED_ARTIFACT, expired:false, workflow_run:{id:7,head_sha:SHA,head_branch:PORTABLE_FUNDED_BRANCH},
    digest:'sha256:'+'b'.repeat(64),size_in_bytes:1024,created_at:'2026-11-25T10:01:00Z' };
  const jobs = [{name:'verify',started_at:'2026-11-25T10:00:00Z',completed_at:'2026-11-25T10:02:00Z'}];
  assert.equal(acceptedArtifact(request,[artifact],jobs).id,1);
  assert.throws(() => acceptedArtifact(request,[{...artifact,name:'permaweb-static-release'}],jobs), /ambiguous_artifact/);
  assert.throws(() => acceptedArtifact(request,[{...artifact,workflow_run:{...artifact.workflow_run,head_branch:'main'}}],jobs), /artifact_mismatch/);
});

test('published source rejects private key material and test drivers', () => {
  for (const source of ['-----BEGIN PRIVATE KEY-----', '{"d":"'+'a'.repeat(101)+'"}', '__SEJIRE_FAKE_TEST_DRIVER__']) {
    assert.throws(() => assertPortableCode(source), /portable_/);
  }
});
