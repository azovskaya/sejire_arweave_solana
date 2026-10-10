import { useState } from 'react';
import { NativeCheckoutPanel } from './NativeCheckoutPanel';
import { CheckoutPublishPanel } from '@sejire/payment-panels';
import { checkoutMessages } from '../lib/checkout/messages';
import { loadDraftTree } from '../lib/draftStorage';
import { useI18n } from '../lib/i18n/I18nProvider';
import { landingMessages } from '../lib/i18n/landing';
import { LanguageSwitch } from './LanguageSwitch';

type Props = {
  onStartNew: (title: string) => void;
  onContinueDraft: () => void;
  onRestoreSeed: () => void;
  onCashier: () => void;
};

export function Welcome({ onStartNew, onContinueDraft, onRestoreSeed, onCashier }: Props) {
  const [supportOpen, setSupportOpen] = useState(false);
  const hasDraft = Boolean(loadDraftTree());
  const { t, locale } = useI18n();
  const copy = landingMessages[locale];
  function startFresh() {
    if (hasDraft && !window.confirm(t.welcome.replaceDraftConfirm)) return;
    onStartNew(t.defaultTreeTitle);
  }
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
    </section>
    <ol className="landing-steps">
      {copy.steps.map(([number, title, detail]) => <li key={number}>
        <span className="landing-number" aria-hidden="true">{number}</span>
        <h2>{title}</h2><p>{detail}</p>
      </li>)}
    </ol>
    <footer className="landing-footer">
      {import.meta.env.VITE_CHECKOUT_ENABLED === "1" && <button type="button" className="btn ghost" onClick={() => setSupportOpen(true)}>{checkoutMessages[locale].support}</button>}
      <p>{copy.heritage}</p><p className="sub">{copy.privacy}</p>
      {import.meta.env.VITE_QA_TOOLS === '1' && <button type="button" className="welcome-link-quiet" onClick={onCashier}>{t.welcome.cashier}</button>}
    </footer>
  </main>;
}
