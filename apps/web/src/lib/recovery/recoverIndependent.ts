import { isValidMnemonic, normalizeMnemonic } from '../crypto/bip39';
import { deriveKeysFromMnemonic } from '../crypto/keys';
import { active, directNodes, scoped } from '../directArweave/network';
import type { DirectOptions } from '../directArweave/types';
import { discoverIndependentVaultVersions } from '../independentDiscovery';
import { newDiagnostics } from './diagnostics';
import { RecoveryFailure } from './errors';
import { resolveHead } from './head';
import { retrieveNativeVault } from './historicalNative';
import { LegacyLocatorProvider } from './providers/legacyLocatorProvider';
import type { HeadCandidate, RecoveryResult, RecoveryStage, VerifiedVersion } from './types';

type Options = DirectOptions & { txHints?: readonly string[]; onStage?: (stage: RecoveryStage) => void };
const ID = /^[A-Za-z0-9_-]{43}$/;

/** Arweave-only search and restore. No hosted search provider, AO process,
 * gateway registry or peer-list service is consulted. An index supplies IDs;
 * native signatures, Merkle roots and AES-GCM authenticate every opened vault.
 * Retrieval does not establish consensus inclusion or complete history. */
export async function recoverIndependentVaultFromWords(words: string, options: Options = {}): Promise<RecoveryResult> {
  const diagnostics = newDiagnostics();
  const stage = (value: RecoveryStage) => { diagnostics.stage = value; options.onStage?.(value); };
  if (!isValidMnemonic(words)) return { ok: false, code: 'INVALID_WORDS', diagnostics: { ...diagnostics, code: 'INVALID_WORDS' } };
  const keys = deriveKeysFromMnemonic(normalizeMnemonic(words));
  try {
    // Capture once: changing a session preference mid-search cannot switch the
    // index and ciphertext transport to different operators without a new action.
    return await scoped({ ...options, nodes: directNodes(options) }, async readOptions => {
      stage('discover');
      const discovery = await discoverIndependentVaultVersions(keys.vaultId, readOptions);
      diagnostics.providers.push(...discovery.providers);
      const legacy = await new LegacyLocatorProvider().discover({ vaultId: keys.vaultId, signal: readOptions.signal!, fetcher: fetch });
      const candidates = new Map<string, HeadCandidate>();
      for (const candidate of [...legacy.candidates,
        ...(options.txHints ?? []).filter(id => ID.test(id)).slice(0, 300).map(txId => ({ txId, source: 'known-id' })), ...discovery.candidates]) {
        if (!candidates.has(candidate.txId)) candidates.set(candidate.txId, candidate);
      }
      const selected = [...candidates.values()].slice(0, 300);
      diagnostics.candidateCount = selected.length;
      if (!selected.length) throw new RecoveryFailure(discovery.responded ? 'NO_CANDIDATES' : 'DISCOVERY_UNAVAILABLE');
      stage('found');
      const versions: VerifiedVersion[] = [];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(3, selected.length) }, async () => {
        while (next < selected.length && !readOptions.signal?.aborted) {
          const candidate = selected[next++];
          try {
            stage('download');
            const result = await retrieveNativeVault(candidate.txId, keys, readOptions);
            active(readOptions.signal); stage('verify');
            versions.push({ ...result, txId: candidate.txId, blockHeight: null,
              blockTimestamp: candidate.blockTimestamp ?? null, sources: candidate.source.split(',') });
            diagnostics.verifiedCount = versions.length;
          } catch { /* Retain already verified versions if the bounded search expires. */ }
        }
      }));
      if (!versions.length) throw new RecoveryFailure('DATA_UNAVAILABLE');
      stage('open');
      const { head, forks } = resolveHead(versions);
      // Finite, replaceable index responses cannot certify that every version
      // has been found. The UI asks the owner to choose a verified snapshot.
      return { ok: true as const, vault: head.vault, headTxId: head.txId, versions, forks, incomplete: true,
        code: forks.length ? 'MULTIPLE_VERIFIED_HEADS' as const : undefined, diagnostics };
    });
  } catch (error) {
    const code = error instanceof RecoveryFailure ? error.code : 'DATA_UNAVAILABLE';
    diagnostics.code = code;
    return { ok: false, code, diagnostics };
  } finally { keys.seed.fill(0); keys.master.fill(0); keys.encKey.fill(0); }
}
