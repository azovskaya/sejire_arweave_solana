import { useState } from 'react';
import { NativeCheckoutPanel } from './NativeCheckoutPanel';
import { CheckoutPublishPanel } from '@sejire/payment-panels';
import { checkoutMessages } from '../lib/checkout/messages';
import { loadDraftTree } from '../lib/draftStorage';
import { useI18n } from '../lib/i18n/I18nProvider';
import { landingMessages } from '../lib/i18n/landing';
import { LanguageSwitch } from './LanguageSwitch';
import { clearVaultSession, getSessionMnemonic, getVaultSession } from '../lib/vaultSession/session';
import { forgetFundedPromo } from '../lib/fund/preference';
import { PaidSolanaFlow } from './PaidSolanaFlow';

type Props = {
  onStartNew: (title: string) => void;
  onContinueDraft: () => void;
  onRestoreSeed: () => void;
  onCashier: () => void;
};

export function Welcome({ onStartNew, onContinueDraft, onRestoreSeed, onCashier }: Props) {
  const [supportOpen, setSupportOpen] = useState(false);
  const [openVaultId, setOpenVaultId] = useState(() => getSessionMnemonic() ? getVaultSession()?.vaultId ?? null : null);
  const [archiveClosed, setArchiveClosed] = useState(false);
  const hasDraft = Boolean(loadDraftTree());
  const { t, locale } = useI18n();
  const copy = landingMessages[locale];
  const contributionCheckout = import.meta.env.VITE_PRESERVATION_V2_ENABLED === '1';
  function startFresh() {
    if (hasDraft && !window.confirm(t.welcome.replaceDraftConfirm)) return;
    onStartNew(t.defaultTreeTitle);
  }
  function closeArchive() {
    if (openVaultId) forgetFundedPromo(openVaultId);
    clearVaultSession();
    setOpenVaultId(null);
    setArchiveClosed(true);
  }
  if (supportOpen && contributionCheckout) return <main className="landing"><PaidSolanaFlow input={{ mode: 'contribution' }} onBack={() => setSupportOpen(false)} /></main>;
  if (supportOpen && import.meta.env.VITE_NATIVE_AR_ENABLED === "1") return <main className="landing"><NativeCheckoutPanel onBack={() => setSupportOpen(false)} /></main>;
  if (supportOpen) return <main className="landing"><CheckoutPublishPanel onBack={() => setSupportOpen(false)} /></main>;
  return <main className="landing">
    <header className="landing-header">
      <span className="landing-brand">SEJIRE<span aria-hidden="true">.</span></span>
      <LanguageSwitch placement="welcome" />
    </header>
    <section className="landing-hero">
      <p className="landing-eyebrow">{copy.eyebrow}</p>
      <h1>{copy.title}</h1>
      <p className="landing-lead">{copy.lead}</p>
      <div className="landing-actions">
        <button type="button" className="btn" onClick={hasDraft ? onContinueDraft : startFresh}>
          {hasDraft ? t.welcome.continueDraft : copy.start}
        </button>
        <button type="button" className="btn ghost" onClick={onRestoreSeed}>{t.welcome.restoreSeed}</button>
        {hasDraft && <button type="button" className="welcome-link-quiet" onClick={startFresh}>{t.welcome.newTree}</button>}
      </div>
      <p className="sub">{copy.free}</p>
      {openVaultId && <div>
        <p className="sub" role="status">{copy.openArchive}</p>
        <button type="button" className="welcome-link-quiet" onClick={closeArchive}>{copy.closeArchive}</button>
      </div>}
      {archiveClosed && <p className="sub" role="status">{copy.archiveClosed}</p>}
    </section>
    <ol className="landing-steps">
      {copy.steps.map(([number, title, detail]) => <li key={number}>
        <span className="landing-number" aria-hidden="true">{number}</span>
        <h2>{title}</h2><p>{detail}</p>
      </li>)}
    </ol>
    <footer className="landing-footer">
      {contributionCheckout
        ? <button type="button" className="welcome-link-quiet" onClick={() => setSupportOpen(true)}>Помочь другим сохранить их истории</button>
        : import.meta.env.VITE_CHECKOUT_ENABLED === "1" && <button type="button" className="btn ghost" onClick={() => setSupportOpen(true)}>{checkoutMessages[locale].support}</button>}
      <p>{copy.heritage}</p><p className="sub">{copy.privacy}</p>
      {import.meta.env.VITE_QA_TOOLS === '1' && <button type="button" className="welcome-link-quiet" onClick={onCashier}>{t.welcome.cashier}</button>}
    </footer>
  </main>;
}
