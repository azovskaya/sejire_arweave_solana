import { parseEnvelope, serializeEnvelope } from '../crypto/envelope';
import type { EnvelopeV1 } from '../crypto/encrypt';

/** Immutable release-bound permission for the single owner-run pilot. */
export const PRESERVATION_V2_PILOT_POLICY = Object.freeze({
  version: 'pilot-2026-10-07-v1', network: 'devnet',
  payer: 'F8XB2iSMf8mB6fPhtwGRDjuT8wTypfARN5pscu3fjqKN',
  service: 'ETWcxNPF3Qcwvo4NHYw6JhMiKnGwrvH1U9YEAQ3rZSWd',
  serviceLamports: 30_000_000,
  fund: 'Gy3SSxP7spgDcserSfMckPd73LeSoxdrvXeNap7huLQN', fundLamports: 0,
  arweaveNetwork: 'arweave.N.1',
  arReserve: 'qgoIFw9WsusMRapWzcFg4jNW08HSWvQkpAKOz86BUuI',
  maxWinston: 4_000_000_000n,
  vaultId: '449d6c6e8cec7700807278bc765ba116',
  archiveBytes: 28_365,
  archiveDigest: '19133b897f69e1f0d43a55217a00adee6b6dfefb73f0f6228008f5c8a702e6c8',
  fileBytes: 28_394,
  fileDigest: '003dcc12544779dce94db4e2f2395059f43bc160fff76272658ae5b6702dbdb8',
});

export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('');
}

export async function assertArchive(text: string): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length !== PRESERVATION_V2_PILOT_POLICY.archiveBytes ||
      await sha256(bytes) !== PRESERVATION_V2_PILOT_POLICY.archiveDigest ||
      parseEnvelope(JSON.parse(text)).vault_id !== PRESERVATION_V2_PILOT_POLICY.vaultId)
    throw Error('archive_not_authorized');
}

export async function importPilotFile(file: File): Promise<string> {
  if (file.size !== PRESERVATION_V2_PILOT_POLICY.fileBytes) throw Error('pilot_file_mismatch');
  const raw = await file.text();
  if (await sha256(new TextEncoder().encode(raw)) !== PRESERVATION_V2_PILOT_POLICY.fileDigest)
    throw Error('pilot_file_mismatch');
  const text = serializeEnvelope(parseEnvelope(JSON.parse(raw)));
  await assertArchive(text);
  return text;
}

export async function envelopeText(envelope: EnvelopeV1): Promise<string> {
  const text = serializeEnvelope(envelope);
  await assertArchive(text);
  return text;
}

export async function saveId(): Promise<string> {
  const p = PRESERVATION_V2_PILOT_POLICY;
  return sha256(new TextEncoder().encode(`sejire-preservation-v2\0${p.version}\0${p.vaultId}\0${p.archiveDigest}\0${p.payer}`));
}
