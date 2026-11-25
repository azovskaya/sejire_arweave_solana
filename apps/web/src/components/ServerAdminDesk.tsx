import { useEffect } from 'react';
import { LanguageSwitch } from './LanguageSwitch';
import { FundAdmin } from './FundAdmin';
import { PreservationV2Diagnostics } from './PreservationV2Diagnostics';
import { logoutOps } from '../lib/opsDesk/store';

/** The modern owner page authorizes against the operator, never a public verifier. */
export function ServerAdminDesk({ onHome }: { onHome: () => void }) {
  useEffect(() => { logoutOps(); return () => logoutOps(); }, []);
  return <div className="ops-desk">
    <header className="ops-desk-bar">
      <button type="button" className="ops-desk-mark" onClick={onHome}><i />SEJIRE</button>
      <LanguageSwitch placement="chrome" />
    </header>
    <main className="ops-desk-main">
      <h1>Админ-панель</h1>
      <p className="sub">Оплата Solana, промокод и фонд хранения. Семейные архивы остаются зашифрованными.</p>
      <FundAdmin diagnostics={<PreservationV2Diagnostics embedded />} />
    </main>
  </div>;
}
