/** Public synthetic fixtures only. The fixed seed must never protect personal data. */
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { entropyToMnemonic } from '../../apps/web/node_modules/@scure/bip39/index.js';
import { wordlist } from '../../apps/web/node_modules/@scure/bip39/wordlists/english.js';
import { deriveKeysFromMnemonic } from '../../apps/web/src/lib/crypto/keys';
import { encryptJson } from '../../apps/web/src/lib/crypto/encrypt';
import { buildRecoveryKit } from '../../apps/web/src/lib/independentBackup';
import type { VaultV1 } from '../../apps/web/src/lib/crypto/vault';
import type { TreeStore, Person } from '../../apps/web/src/lib/types';
import { createTree, commitDraft, setDraftPerson, removeDraftPerson, restoreDraftPerson } from '../../apps/web/src/lib/treeEngine';

export const PROPERTY_SEED = 0x5e171118;
export const PROPERTY_CASES = 16;
export const UNICODE = ['Әлия Ғұмарқызы', 'Ёлка — Семён', 'NFD: e\u0301 / NFC: é', '李家 / 山田',
  'العائلة', 'עברית', '👨‍👩‍👧‍👦 🌳', 'A\u0000B\nC\r\nD\t"\\', '\u2028line\u2029paragraph', '</script><img src=x onerror=alert(1)>'];

export function seededRandom(seed = PROPERTY_SEED) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; };
}
const iso = (offset: number) => new Date(Date.UTC(2026, 0, 1) + offset * 1000).toISOString();

function stableHistory(store: TreeStore, index: number): TreeStore {
  // Production creates timestamps/IDs; canonicalize just those nondeterministic
  // fixture labels after taking real production snapshots. Snapshot bytes stay intact.
  const commits: TreeStore['commits'] = {}, versions: TreeStore['versions'] = {};
  let parent: string | null = null;
  for (let version = 1; version < store.meta.next_version; version++) {
    const original = store.commits[store.versions[version]], id = `${store.meta.id}_commit_${version}`;
    commits[id] = { ...original, commit_id: id, parent_commit_id: parent, created_at: iso(index * 100 + version) };
    versions[version] = id; parent = id;
  }
  return { ...store, meta: { ...store.meta, head: parent }, commits, versions };
}

export async function productionFixture(index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= PROPERTY_CASES) throw Error('invalid_fixture_index');
  const random = seededRandom(PROPERTY_SEED ^ (index + 1));
  const words = entropyToMnemonic(Uint8Array.from({ length: 16 }, () => Math.floor(random() * 256)), wordlist);
  const keys = deriveKeysFromMnemonic(words), trees: Record<string, TreeStore> = {};
  const treeCount = 1 + index % 4, generations = [1, 3, 8, 13][index % 4], revisions = 2 + index % 5;
  try {
    for (let treeIndex = 0; treeIndex < treeCount; treeIndex++) {
      const id = `synthetic_${index}_${treeIndex}`;
      let tree = createTree(`PUBLIC SYNTHETIC ${UNICODE[(index + treeIndex) % UNICODE.length]}`);
      tree.meta = { ...tree.meta, id, created_at: iso(index * 1000 + treeIndex), clanName: 'Тестовый род',
        tamgaUrl: 'ar://' + 'M'.repeat(43) };
      for (let generation = 0; generation < generations; generation++) {
        const person: Person = { id: `${id}_g${generation}`, name: UNICODE[(generation + treeIndex) % UNICODE.length],
          sex: ['M', 'F', 'U'][generation % 3] as Person['sex'],
          born: generation % 2 ? null : `${1800 + generation * 18}-01-02`,
          parents: generation ? [`${id}_g${generation - 1}`] : [],
          notes: `PUBLIC SYNTHETIC ${Math.floor(random() * 1_000_000)} ${UNICODE[(index + generation + 3) % UNICODE.length]}`,
          media: [{ tx: 'M'.repeat(43), kind: 'document', caption: 'Ссылка, не встроенные байты' }],
          birthPlace: 'Алматы', occupation: 'PUBLIC SYNTHETIC', tombstone: false };
        tree = setDraftPerson(tree, person);
      }
      for (let version = 1; version <= revisions; version++) {
        const personId = `${id}_g${(version - 1) % generations}`;
        tree = setDraftPerson(tree, { ...tree.draft.persons[personId], notes: `Revision ${version} ${UNICODE[version % UNICODE.length]}` });
        if (version === 2) tree = removeDraftPerson(tree, personId);
        if (version === 3) tree = restoreDraftPerson(tree, `${id}_g${1 % generations}`);
        tree = commitDraft(tree, `PUBLIC SYNTHETIC history ${version} ${UNICODE[(version + index) % UNICODE.length]}`);
      }
      tree = setDraftPerson(tree, { ...tree.draft.persons[`${id}_g0`], name: `Uncommitted ${UNICODE[index % UNICODE.length]}` });
      trees[id] = stableHistory(tree, index * 4 + treeIndex);
    }
    const vault: VaultV1 & { synthetic_future: unknown } = {
      schema: 'sejire/vault/v1', vault_id: keys.vaultId, updated_at: iso(index), trees,
      active_tree_id: Object.keys(trees)[index % treeCount],
      synthetic_future: { nested: [null, false, 0, '', [1, { text: UNICODE }]],
        // Preserve unknown keys as data; this object must never be merged into prototypes.
        escaped: JSON.parse('{"__proto__":{"synthetic_only":true},"constructor":"keep"}') },
    };
    const envelope = await encryptJson(keys.encKey, keys.vaultId, vault);
    // Both compact and deliberately pretty historical envelope bytes are supported.
    const archiveText = index % 2 ? JSON.stringify(envelope, null, 2) + '\r\n' : JSON.stringify(envelope);
    const kit = await buildRecoveryKit(archiveText);
    return { index, words, vault, envelope, archiveText, kit, expectedPlaintext: JSON.stringify(vault),
      counts: { trees: treeCount, persons: treeCount * generations, generations, commits: treeCount * revisions } };
  } finally { keys.seed.fill(0); keys.master.fill(0); keys.encKey.fill(0); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4 || process.argv[2] !== '--output') throw Error('fixture_usage');
  // Browser integration consumes this private temporary file, not stdout/logs.
  const fixtures = await Promise.all([0, 3, 10, 15].map(productionFixture));
  await writeFile(process.argv[3], JSON.stringify({ seed: PROPERTY_SEED, fixtures }), { flag: 'wx', mode: 0o600 });
}
