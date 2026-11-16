import { LEGACY_APP_URL } from '../lib/legacyPreservationGuard';
import { useI18n } from '../lib/i18n/I18nProvider';
import { independentMessages } from '../lib/independentMessages';

export function LegacyPreservationNotice({ blocked = false }: { blocked?: boolean }) {
  const { locale } = useI18n();
  const copy = independentMessages[locale];
  return <aside className="independent-notice" aria-label={copy.legacyTitle}>
    <strong>{copy.legacyTitle}</strong><p>{blocked ? copy.legacyBlocked : copy.legacyInfo}</p>
    <a href={LEGACY_APP_URL} target="_blank" rel="noopener noreferrer">{copy.legacyOpen}</a>
  </aside>;
}
