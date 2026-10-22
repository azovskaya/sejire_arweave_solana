import { validatePaidPolicy, validateContributionPolicy, SOLANA_GENESIS, PAID_SERVICE_LAMPORTS, type PaidPolicy, type ContributionPolicy } from '../../../../packages/checkout/paid';
import { validatePaidArchive, type PaidArchiveBinding } from '../../../../packages/checkout/order';
import { parseEnvelope, serializeEnvelope } from '../../../web/src/lib/crypto/envelope';
import { envelopeDigest } from '../../../web/src/lib/solana/policy';
import { winston } from './treasuryGuard';

export type PaidEnv = {
  CHECKOUT_PAID_ENABLED?: string;
  CHECKOUT_CONTRIBUTION_ENABLED?: string;
  CHECKOUT_PAID_EXECUTION_ENABLED?: string;
  CHECKOUT_PAID_NETWORK?: string;
  CHECKOUT_PAID_POLICY_VERSION?: string;
  CHECKOUT_SERVICE_RECIPIENT?: string;
  CHECKOUT_FUND_RECIPIENT?: string;
  CHECKOUT_PAID_TREASURY_ADDRESS?: string;
  CHECKOUT_PAID_AR_BUDGET_ID?: string;
  CHECKOUT_PAID_AR_BUDGET_WINSTON?: string;
  CHECKOUT_PAID_MAX_REWARD_WINSTON?: string;
  MAX_ENVELOPE_BYTES?: string;
  ARWEAVE_TREASURY_JWK?: string;
};
/** Only deployment configuration supplies money, destinations and networks. No
 * production address/budget is borrowed from the devnet pilot or promo quota. */
export function configuredPaidPolicy(env: PaidEnv): {policy: PaidPolicy; budgetLimit: string} {
  const network = env.CHECKOUT_PAID_NETWORK;
  if (network !== 'devnet' && network !== 'mainnet-beta') throw Error('paid_not_configured');
  try {
    const policy = validatePaidPolicy({schema:'sejire/checkout-policy/v1',version:env.CHECKOUT_PAID_POLICY_VERSION,
      network,genesisHash:SOLANA_GENESIS[network],serviceLamports:PAID_SERVICE_LAMPORTS,
      serviceRecipient:env.CHECKOUT_SERVICE_RECIPIENT,fundRecipient:env.CHECKOUT_FUND_RECIPIENT,
      storage:{kind:'arweave-direct',network:'arweave.N.1',treasuryAddress:env.CHECKOUT_PAID_TREASURY_ADDRESS,
        budgetId:env.CHECKOUT_PAID_AR_BUDGET_ID,maxBytes:Number(env.MAX_ENVELOPE_BYTES),maxRewardWinston:env.CHECKOUT_PAID_MAX_REWARD_WINSTON}});
    const budgetLimit = env.CHECKOUT_PAID_AR_BUDGET_WINSTON ?? '';
    if (winston(budgetLimit) < winston(policy.storage.maxRewardWinston) || winston(budgetLimit) <= 0n) throw Error('paid_not_configured');
    return {policy,budgetLimit};
  } catch { throw Error('paid_not_configured'); }
}
/** Standalone admission needs the public SOL roles only. No AR signer, budget,
 * upload readiness or placeholder storage settings are borrowed for this path. */
export function configuredContributionPolicy(env: PaidEnv): ContributionPolicy {
  const network = env.CHECKOUT_PAID_NETWORK;
  if (network !== 'devnet' && network !== 'mainnet-beta') throw Error('contribution_not_configured');
  try {
    return validateContributionPolicy({ schema:'sejire/contribution-policy/v1', version:env.CHECKOUT_PAID_POLICY_VERSION,
      network, genesisHash:SOLANA_GENESIS[network], serviceLamports:'0',
      serviceRecipient:env.CHECKOUT_SERVICE_RECIPIENT, fundRecipient:env.CHECKOUT_FUND_RECIPIENT });
  } catch { throw Error('contribution_not_configured'); }
}
export async function checkedPaidArchive(serialized: string, binding: PaidArchiveBinding, maxBytes: number): Promise<void> {
  const archive = validatePaidArchive(binding);
  if (typeof serialized !== 'string' || serialized.length > maxBytes) throw Error('envelope_too_large');
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.length > maxBytes || bytes.length !== archive.bytes) throw Error('archive_mismatch');
  let value:unknown;
  try { value=JSON.parse(serialized); } catch { throw Error('invalid_envelope'); }
  const envelope = parseEnvelope(value);
  if (serializeEnvelope(envelope) !== serialized) throw Error('archive_not_canonical');
  if (envelope.vault_id !== archive.vaultId || await envelopeDigest(serialized) !== archive.digest) throw Error('archive_mismatch');
}
