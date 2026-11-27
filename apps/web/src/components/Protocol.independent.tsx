import { useI18n } from '../lib/i18n/I18nProvider';
import { independentMessages } from '../lib/independentMessages';
import { independentProtocolMessages } from '../lib/independentProtocolMessages';
import { LanguageSwitch } from './LanguageSwitch';

/** Public explanation only: no account, privileged action or background request. */
export function IndependentProtocol({ onHome, onRestore, canRestore }: { onHome: () => void; onRestore: () => void; canRestore: boolean }) {
  const { locale } = useI18n();
  const copy = independentProtocolMessages[locale], direct = independentMessages[locale];
  return <main className="landing" data-deployment-profile="decentralized-direct-arweave">
    <header className="landing-header"><span className="landing-brand">SEJIRE<span aria-hidden="true">.</span></span><LanguageSwitch placement="welcome" /></header>
    <article className="independent-protocol" aria-labelledby="independent-protocol-title">
      <h1 id="independent-protocol-title">{copy.title}</h1><p className="landing-lead">{copy.lead}</p>
      <section><h2>{copy.ownershipTitle}</h2><p>{copy.ownership}</p></section>
      <section><h2>{copy.paymentTitle}</h2><p>{copy.payment}</p></section>
      <section><h2>{copy.recoveryTitle}</h2><p>{copy.recovery}</p>
        <a href="./recovery/recovery.html" download="sejire-recovery.html">{direct.offlineTool}</a></section>
      <section><h2>{copy.administrationTitle}</h2><p>{copy.administration}</p><p>{copy.previous}</p></section>
      <div className="landing-actions"><button type="button" className="btn" disabled={!canRestore} onClick={onRestore}>{copy.restore}</button>
        <button type="button" className="btn ghost" onClick={onHome}>{copy.home}</button></div>
    </article>
  </main>;
}
