/** Local build evidence only. No accepted provenance, network or publishing. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preparePermaweb } from '../../../scripts/prepare-permaweb.mjs';
import { digest, verifyRelease } from '../../../scripts/permaweb-release.mjs';
import { PORTABLE_FUNDED_PROFILE } from '../../../scripts/portable-funded-profile.mjs';

const evidence = fileURLToPath(new URL('.', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));
const before = JSON.parse(await readFile(resolve(evidence, 'source.json'), 'utf8'));
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
assert.equal(git(['rev-parse', 'HEAD']), before.localCommit);
assert.equal(git(['rev-parse', 'HEAD^{tree}']), before.tree);
assert.equal(git(['status', '--porcelain']), '', 'source must remain unchanged');

const directory = resolve(evidence, 'release');
await preparePermaweb(resolve(root, 'apps/web/dist'), directory, before.sourceCommit);
const release = await verifyRelease(directory, before.sourceCommit, { expectedProfile: PORTABLE_FUNDED_PROFILE });
const profileBytes = await readFile(resolve(directory, 'release-profile.json'));
const profile = JSON.parse(profileBytes.toString('utf8'));
assert.equal(profile.apiOrigin, before.apiOrigin);
assert.equal(release.files.some(file => file.path === 'build-provenance.json'), false);
const boundaryBytes = await readFile(resolve(directory, 'bundle-boundary.json'));
const boundary = JSON.parse(boundaryBytes.toString('utf8'));
const modules = new Set(boundary.chunks.flatMap(chunk => chunk.modules));
const summary = {
  ...before,
  completedAt: new Date().toISOString(),
  result: 'LOCAL_BUILD_AND_STATIC_VERIFICATION_PASS',
  fullCiAccepted: false,
  acceptedProvenanceCreated: false,
  sourceCleanAfterBuild: git(['status', '--porcelain']) === '',
  nodeVersion: process.version,
  directory,
  manifestSha256: release.manifestSha256,
  profileSha256: digest(profileBytes),
  bundleBoundarySha256: digest(boundaryBytes),
  manifestFileCount: release.manifest.fileCount,
  manifestTotalBytes: release.manifest.totalBytes,
  packageFileCount: release.files.length,
  packageTotalBytes: release.files.reduce((sum, file) => sum + file.bytes, 0),
  jsAssets: boundary.chunks.length,
  renderedModules: modules.size,
  recoveryFiles: release.files.filter(file => file.path.startsWith('recovery/')).length,
  reviewedDraftModulesPresent: [
    'apps/web/src/lib/personDraft.ts',
    'apps/web/src/lib/draftOwnership.ts',
    'apps/web/src/components/DraftAccess.tsx',
  ].map(path => ({ path, present: modules.has(path) })),
  files: release.files,
  logs: {
    build: { path: resolve(evidence, 'build.log'), sha256: digest(await readFile(resolve(evidence, 'build.log'))) },
  },
  boundaries: {
    expectedProfile: PORTABLE_FUNDED_PROFILE,
    expectedApiOrigin: before.apiOrigin,
    verifyRelease: 'PASS',
    portableModuleAndRecoveryBoundary: 'PASS (invoked by the existing build/prepare/release verifiers)',
    browserExecution: 'NOT_RUN',
    githubArtifactProduced: false,
    zipIsGitHubArtifact: false,
    walletOrUploadAttempted: false,
  },
  commands: [
    before.buildCommand,
    'node .cache/publication-completion/local-portable-ba6777ac/prepare-local-candidate.mjs',
  ],
};
assert.equal(summary.sourceCleanAfterBuild, true);
await writeFile(resolve(evidence, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ scope: summary.scope, result: summary.result,
  sourceCommit: summary.sourceCommit, localCommit: summary.localCommit, tree: summary.tree,
  directory, manifestSha256: summary.manifestSha256, bundleBoundarySha256: summary.bundleBoundarySha256,
  profileSha256: summary.profileSha256, manifestFileCount: summary.manifestFileCount,
  manifestTotalBytes: summary.manifestTotalBytes, packageFileCount: summary.packageFileCount,
  packageTotalBytes: summary.packageTotalBytes, jsAssets: summary.jsAssets,
  renderedModules: summary.renderedModules, recoveryFiles: summary.recoveryFiles,
  reviewedDraftModulesPresent: summary.reviewedDraftModulesPresent,
  fullCiAccepted: false, acceptedProvenanceCreated: false,
  sourceCleanAfterBuild: summary.sourceCleanAfterBuild, summary: resolve(evidence, 'summary.json') }, null, 2));
