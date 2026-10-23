import { assertBase58, DEVNET_ONLY_RECIPIENTS, SYSTEM_PROGRAM } from './order';

export type SolanaRecipients = Readonly<{ serviceRecipient: string; fundRecipient: string }>;
export type SolanaRecipientSettings = SolanaRecipients & Readonly<{
  schema: 'sejire/sol-recipients/v1'; revision: number; updatedAt: number;
}>;
export type SolanaRecipientAdminView = SolanaRecipients & Readonly<{
  schema: 'sejire/sol-recipients-admin/v1'; revision: number; updatedAt: number | null;
  source: 'admin' | 'deployment' | 'not-configured';
  network: 'devnet' | 'mainnet-beta' | null;
  paymentEnabled: boolean; executionEnabled: boolean; contributionEnabled: boolean;
}>;

/** Public receiving addresses only. Format validation does NOT prove ownership. */
export function validateSolanaRecipients(service: unknown, fund: unknown): SolanaRecipients {
  if (typeof service !== 'string' || typeof fund !== 'string') throw Error('invalid_solana_recipient');
  const serviceRecipient = service.trim(), fundRecipient = fund.trim();
  try { assertBase58(serviceRecipient, 32); assertBase58(fundRecipient, 32); }
  catch { throw Error('invalid_solana_recipient'); }
  if (serviceRecipient === fundRecipient) throw Error('solana_recipient_roles_overlap');
  if ([serviceRecipient, fundRecipient].includes(SYSTEM_PROGRAM)) throw Error('invalid_solana_recipient');
  // The owner-facing production form must never adopt disposable pilot wallets.
  if ([serviceRecipient, fundRecipient].some(address => DEVNET_ONLY_RECIPIENTS.includes(address))) {
    throw Error('solana_test_recipient_forbidden');
  }
  return Object.freeze({ serviceRecipient, fundRecipient });
}

export function validateSolanaRecipientSettings(value: unknown): SolanaRecipientSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_solana_recipient_settings');
  const row = value as Record<string, unknown>;
  if (row.schema !== 'sejire/sol-recipients/v1' || !Number.isSafeInteger(row.revision) ||
      (row.revision as number) < 1 || !Number.isSafeInteger(row.updatedAt) || (row.updatedAt as number) < 0) {
    throw Error('invalid_solana_recipient_settings');
  }
  const recipients = validateSolanaRecipients(row.serviceRecipient, row.fundRecipient);
  if (recipients.serviceRecipient !== row.serviceRecipient || recipients.fundRecipient !== row.fundRecipient) {
    throw Error('invalid_solana_recipient_settings');
  }
  return Object.freeze({ schema: 'sejire/sol-recipients/v1', revision: row.revision as number,
    updatedAt: row.updatedAt as number, ...recipients });
}

export function recipientPolicyVersion(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) throw Error('invalid_solana_recipient_settings');
  return `admin-sol-recipients-${revision}`;
}
