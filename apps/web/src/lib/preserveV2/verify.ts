import { PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js';
import bs58 from 'bs58';
import { parseEnvelope } from '../crypto/envelope';
import { PRESERVATION_V2_PILOT_POLICY as P, sha256 } from './policy';
import { assertDevnet, type SolanaReader } from './solana';
import type { SaveSession } from './types';

/** Accept economic equivalence, including safe ComputeBudget instructions, only after finality. */
export async function verifyPayment(session: SaveSession, signature: string, rpc: SolanaReader): Promise<void> {
  await assertDevnet(rpc);
  const tx = await rpc.getParsedTransaction(signature, {commitment: 'finalized', maxSupportedTransactionVersion: 0});
  if (!tx || tx.meta?.err || !tx.meta || !tx.transaction.signatures.includes(signature)) throw Error('payment_not_finalized');
  const keys = tx.transaction.message.accountKeys;
  if (keys[0]?.pubkey.toBase58() !== P.payer || !keys[0].signer ||
      !keys.some(k => k.pubkey.toBase58() === session.solanaReference)) throw Error('payment_identity_mismatch');
  if (tx.meta.innerInstructions?.some(x => x.instructions.length)) throw Error('unexpected_inner_instructions');
  let transfers = 0;
  for (const ix of tx.transaction.message.instructions) {
    if ('parsed' in ix && ix.program === 'system' && ix.parsed.type === 'transfer') {
      const info = ix.parsed.info as {source?: string; destination?: string; lamports?: number};
      if (info.source !== P.payer || info.destination !== P.service || info.lamports !== P.serviceLamports)
        throw Error('unexpected_value_transfer');
      transfers++;
    } else if (ix.programId.equals(new PublicKey('ComputeBudget111111111111111111111111111111'))) {
      // This program can only alter computational limits and fees, never transfer SOL.
      if ('parsed' in ix) throw Error('unrecognized_compute_budget');
      const raw = bs58.decode(ix.data);
      if (raw[0] === 2 && raw.length === 5) {
        if (new DataView(raw.buffer, raw.byteOffset).getUint32(1, true) > 1_400_000) throw Error('compute_limit_too_high');
      } else if (raw[0] === 3 && raw.length === 9) {
        if (new DataView(raw.buffer, raw.byteOffset).getBigUint64(1, true) > 1_000_000n) throw Error('priority_fee_too_high');
      } else throw Error('unsupported_compute_budget');
    } else throw Error('unexpected_payment_instruction');
  }
  if (transfers !== 1) throw Error('missing_or_duplicate_service_transfer');
}

export async function verifyRetrievedArchive(bytes: Uint8Array): Promise<void> {
  if (bytes.length !== P.archiveBytes || await sha256(bytes) !== P.archiveDigest)
    throw Error('retrieved_archive_mismatch');
  const parsed = parseEnvelope(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
  if (parsed.vault_id !== P.vaultId) throw Error('retrieved_vault_mismatch');
}

export function paymentDebugSummary(tx: ParsedTransactionWithMeta): {slot: number; feeLamports: number} {
  return {slot: tx.slot, feeLamports: tx.meta?.fee ?? 0};
}
