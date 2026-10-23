import { validateSolanaRecipients, validateSolanaRecipientSettings, recipientPolicyVersion,
  type SolanaRecipientSettings } from '../../../../packages/checkout/recipients';
import type { CheckoutPolicy } from '../../../../packages/checkout/paid';
import type { PaidEnv } from './paidPolicy';

type Row = { revision: number; service_recipient: string; fund_recipient: string; updated_at: number };
/** Additive singleton and append-only audit in the EXISTING checkout Durable Object. */
export class RecipientSettings {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.transactionSync(() => storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS solana_recipient_settings (
        id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL,
        service_recipient TEXT NOT NULL, fund_recipient TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS solana_recipient_audit (
        revision INTEGER PRIMARY KEY, previous_json TEXT, current_json TEXT NOT NULL, changed_at INTEGER NOT NULL);
    `));
  }
  get(): SolanaRecipientSettings | null {
    const row = this.storage.sql.exec<Row>('SELECT revision,service_recipient,fund_recipient,updated_at FROM solana_recipient_settings WHERE id=1').toArray()[0];
    return row ? validateSolanaRecipientSettings({ schema: 'sejire/sol-recipients/v1', revision: row.revision,
      serviceRecipient: row.service_recipient, fundRecipient: row.fund_recipient, updatedAt: row.updated_at }) : null;
  }
  async save(input: unknown, now: number): Promise<SolanaRecipientSettings> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('invalid_solana_recipient_settings');
    const value = input as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !== 'expectedRevision,fundRecipient,serviceRecipient' ||
        !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0 ||
        !Number.isSafeInteger(now) || now < 0) throw Error('invalid_solana_recipient_settings');
    const addresses = validateSolanaRecipients(value.serviceRecipient, value.fundRecipient);
    const result = this.storage.transactionSync(() => {
      const old = this.get();
      // A retried save after a lost response is harmless and does not add an audit row.
      if (old && old.serviceRecipient === addresses.serviceRecipient && old.fundRecipient === addresses.fundRecipient) return old;
      if ((old?.revision ?? 0) !== value.expectedRevision) throw Error('solana_recipient_revision_conflict');
      const revision = (old?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw Error('invalid_solana_recipient_settings');
      const next: SolanaRecipientSettings = { schema: 'sejire/sol-recipients/v1', revision, updatedAt: now, ...addresses };
      this.storage.sql.exec('INSERT INTO solana_recipient_settings(id,revision,service_recipient,fund_recipient,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,service_recipient=excluded.service_recipient,fund_recipient=excluded.fund_recipient,updated_at=excluded.updated_at',
        revision, addresses.serviceRecipient, addresses.fundRecipient, now);
      this.storage.sql.exec('INSERT INTO solana_recipient_audit(revision,previous_json,current_json,changed_at) VALUES(?,?,?,?)',
        revision, old ? JSON.stringify(old) : null, JSON.stringify(next), now);
      return next;
    });
    await this.storage.sync();
    return result;
  }
  /** Called only for a NEW order, inside the DO admission critical section. */
  assertPolicy(policy: CheckoutPolicy): void {
    const current = this.get();
    if (current && (policy.serviceRecipient !== current.serviceRecipient || policy.fundRecipient !== current.fundRecipient ||
        policy.version !== recipientPolicyVersion(current.revision))) throw Error('payment_settings_changed');
  }
}

/** Never changes feature gates, budgets, networks, keys or an existing order. */
export function withRecipientSettings<T extends PaidEnv>(env: T, saved: SolanaRecipientSettings | null): T {
  if (!saved) return env;
  const settings = validateSolanaRecipientSettings(saved);
  return { ...env, CHECKOUT_SERVICE_RECIPIENT: settings.serviceRecipient,
    CHECKOUT_FUND_RECIPIENT: settings.fundRecipient,
    CHECKOUT_PAID_POLICY_VERSION: recipientPolicyVersion(settings.revision) };
}
