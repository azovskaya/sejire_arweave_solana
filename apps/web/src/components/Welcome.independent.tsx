import { useState } from 'react';
import { loadDraftTree } from '../lib/draftStorage';
import { useI18n } from '../lib/i18n/I18nProvider';
import { landingMessages } from '../lib/i18n/landing';
import { LanguageSwitch } from './LanguageSwitch';
import { clearVaultSession, getSessionMnemonic, getVaultSession } from '../lib/vaultSession/session';
import { independentMessages } from '../lib/independentMessages';
import { LegacyPreservationNotice } from './LegacyPreservationNotice';
import { independentProtocolMessages } from '../lib/independentProtocolMessages';

type Props = { onStartNew: (title: string) => void; onContinueDraft: () => void; onRestoreSeed: () => void; onHistory: () => void; onProtocol: () => void; draftWritable?: boolean };
export function Welcome({ onStartNew, onContinueDraft, onRestoreSeed, onHistory, onProtocol, draftWritable = true }: Props) {
  const { t, locale } = useI18n();
  const copy = landingMessages[locale], direct = independentMessages[locale];
  const [openVaultId, setOpenVaultId] = useState(() => getSessionMnemonic() ? getVaultSession()?.vaultId ?? null : null);
  const [archiveClosed, setArchiveClosed] = useState(false);
  const hasDraft = Boolean(loadDraftTree());
  function startFresh() {
    if (hasDraft && !window.confirm(t.welcome.replaceDraftConfirm)) return;
    onStartNew(t.defaultTreeTitle);
  }
  return <main className="landing" data-deployment-profile="decentralized-direct-arweave">
    <header className="landing-header"><span className="landing-brand">SEJIRE<span aria-hidden="true">.</span></span><LanguageSwitch placement="welcome" /></header>
    <section className="landing-hero">
      <p className="landing-eyebrow">{copy.eyebrow}</p><h1>{copy.title}</h1><p className="landing-lead">{copy.lead}</p>
      <div className="landing-actions">
        <button type="button" className="btn" disabled={!draftWritable} onClick={hasDraft ? onContinueDraft : startFresh}>{hasDraft ? t.welcome.continueDraft : copy.start}</button>
        <button type="button" className="btn ghost" disabled={!draftWritable} onClick={onRestoreSeed}>{t.welcome.restoreSeed}</button>
        {hasDraft && <button type="button" className="welcome-link-quiet" disabled={!draftWritable} onClick={startFresh}>{t.welcome.newTree}</button>}
      </div>
      <p className="sub">{copy.free}</p><p className="sub">{direct.independentLead}</p>
      {openVaultId && <div><p className="sub" role="status">{copy.openArchive}</p>
        <button className="welcome-link-quiet" type="button" onClick={() => { clearVaultSession(); setOpenVaultId(null); setArchiveClosed(true); }}>{copy.closeArchive}</button></div>}
      {archiveClosed && <p role="status" className="sub">{copy.archiveClosed}</p>}
    </section>
    <ol className="landing-steps">{copy.steps.map(([number, title, detail]) => <li key={number}><span className="landing-number" aria-hidden="true">{number}</span><h2>{title}</h2><p>{detail}</p></li>)}</ol>
    <footer className="landing-footer">
      <button type="button" className="welcome-link-quiet" onClick={onHistory}>{direct.history}</button>
      <button type="button" className="welcome-link-quiet" onClick={onProtocol}>{independentProtocolMessages[locale].link}</button>
      <a className="welcome-link-quiet" href="./recovery/recovery.html" download="sejire-recovery.html">{direct.offlineTool}</a>
      <p>{copy.heritage}</p><p className="sub">{copy.privacy}</p>
      <LegacyPreservationNotice />
    </footer>
  </main>;
}
