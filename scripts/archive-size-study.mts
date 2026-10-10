/** Offline synthetic sizes only. No RPC, wallet, upload, keys or recovery words in output. */
import { webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
import { encryptJson, decryptJson } from '../apps/web/src/lib/crypto/encrypt';
import { serializeEnvelope, MAX_BACKUP_BYTES } from '../apps/web/src/lib/crypto/envelope';
import { createTree, upsertPersonFields, commitDraft } from '../apps/web/src/lib/treeEngine';
import type { TreeStore } from '../apps/web/src/lib/types';
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const results = [];
for (const spec of [
  { trees: 1, people: 20, revisions: 1 },
  { trees: 2, people: 100, revisions: 5 },
  { trees: 4, people: 250, revisions: 10 },
  { trees: 2, people: 1000, revisions: 3 },
]) {
  const trees: Record<string, TreeStore> = {};
  for (let t = 0; t < spec.trees; t++) {
    let tree = createTree(`Synthetic family ${t}`);
    tree.meta.id = `synthetic-tree-${t}`;
    tree.meta.created_at = '2026-09-30T00:00:00.000Z';
    for (let p = 0; p < spec.people; p++) tree = upsertPersonFields(tree, {
      id: `person-${p}`, name: `Вымышленный человек ${p}`, parents: p ? [`person-${Math.floor((p - 1) / 2)}`] : [],
      notes: 'Synthetic biography. No real family data.',
      media: [{ tx: 'A'.repeat(43), kind: 'image', caption: 'Synthetic reference; no image uploaded' }],
    });
    for (let v = 0; v < spec.revisions; v++) {
      tree = upsertPersonFields(tree, { id: 'person-0', name: 'Вымышленный человек 0', notes: `Synthetic revision ${v}` });
      tree = commitDraft(tree, `Synthetic correction ${v}`);
    }
    // Canonicalize synthetic ids/time so repeated size measurements are comparable.
    const commits: TreeStore['commits'] = {};
    const versions: TreeStore['versions'] = {};
    for (let v = 1; v <= spec.revisions; v++) {
      const id = `synthetic-commit-${v}`;
      commits[id] = { ...tree.commits[tree.versions[v]], commit_id: id,
        parent_commit_id: v > 1 ? `synthetic-commit-${v - 1}` : null, created_at: '2026-09-30T00:00:00.000Z' };
      versions[v] = id;
    }
    tree = { ...tree, commits, versions, meta: { ...tree.meta, head: `synthetic-commit-${spec.revisions}` } };
    trees[tree.meta.id] = tree;
  }
  const vault = { schema: 'sejire/vault/v1', vault_id: 'a'.repeat(32), updated_at: '2026-09-30T00:00:00Z', trees, active_tree_id: Object.keys(trees)[0] };
  const key = webcrypto.getRandomValues(new Uint8Array(32));
  const envelope = await encryptJson(key, vault.vault_id, vault);
  assert.deepEqual(await decryptJson(key, envelope), vault);
  const envelopeBytes = byteLength(envelope);
  if (envelopeBytes <= MAX_BACKUP_BYTES) assert.equal(new TextEncoder().encode(serializeEnvelope(envelope)).length, envelopeBytes);
  results.push({ ...spec, personsTotal: spec.trees * spec.people, plainBytes: byteLength(vault), envelopeBytes,
    quotePlanningBytes: envelopeBytes + 4096, roundtrip: 'PASS', underTechnicalImportLimit: envelopeBytes <= MAX_BACKUP_BYTES });
}
// Existing media model stores references. Embedded bytes below are planning scenarios, NOT a new supported schema.
const attachments = [1, 5, 20].map(mib => ({ hypotheticalRawAttachmentMiB: mib,
  base64CiphertextBytesLowerBound: 4 * Math.ceil((mib * 1024 * 1024 + 16) / 3),
  status: 'MODEL_ONLY_NOT_SUPPORTED_ATTACHMENT_FORMAT' }));
console.log(JSON.stringify({ synthetic: true, externalRequests: 0, signatures: 0, paidUploads: 0,
  technicalImportLimitBytes: MAX_BACKUP_BYTES, results, attachments,
  costs: 'NOT RUN: no live quotes or uploads. Free tier is not guaranteed. 4096 overhead is an estimate, not a signed-item measurement.' }, null, 2));
