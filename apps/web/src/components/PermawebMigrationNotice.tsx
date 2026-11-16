import { useI18n } from '../lib/i18n/I18nProvider';
import { paidAvailabilityUi } from '../lib/checkout/paidAvailabilityMessages';
import { isStaticPermawebHost } from '../lib/permawebHost';

/** Cross-origin storage cannot be moved by a redirect. Keep the old origin
 * available for its existing orders; never put access tokens in a link. */
export function PermawebMigrationNotice() {
  const { locale } = useI18n();
  if (!isStaticPermawebHost(location.hostname)) return null;
  const copy = paidAvailabilityUi[locale];
  return <aside aria-label={copy.migrationTitle} className="permaweb-migration-note">
    <p><strong>{copy.migrationTitle}</strong></p>
    <p>{copy.migrationBody}</p>
    <p><a href="https://azovskaya.github.io/sejire_arweave_solana/" target="_blank" rel="noopener noreferrer">{copy.migrationLink}</a></p>
    <p>{copy.migrationRestore}</p>
  </aside>;
}
