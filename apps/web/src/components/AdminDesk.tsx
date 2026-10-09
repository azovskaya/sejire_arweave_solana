import { useEffect, useState, type FormEvent } from "react";
import { useI18n } from "../lib/i18n/I18nProvider";
import { formatUiDateTime } from "../lib/i18n/messages";
import { LanguageSwitch } from "./LanguageSwitch";
import { fetchNetworkSaves, mergeOpsOverview } from "../lib/opsDesk/feed";
import { fetchAdminNetworkOverview, type NetworkOverview } from "../lib/opsDesk/networkOverview";
import {
  activateOpsPassword,
  applyOpsKeyPatch,
  changeOpsPassword,
  getHotTreasury,
  listOpsMovements,
  loadOpsSecrets,
  loginOps,
  logoutOps,
  opsNeedsSetup,
  passwordTooShort,
  redactOpsKeys,
  setGeneratedTreasury,
  setupOpsPassword,
  readSessionPassword,
} from "../lib/opsDesk/store";
import { verifyAdminLock } from "../lib/opsDesk/adminLock";
import { addressFromTreasuryJson, generateTreasuryWallet, treasuryBalanceAr } from "../lib/opsDesk/treasury";
import type { OpsOverview, RedactedOpsKeys } from "../lib/opsDesk/types";
import { PreservationV2Diagnostics } from "./PreservationV2Diagnostics";

type Props = { onHome: () => void; v2Diagnostics?: boolean };
type Tab = "overview" | "keys" | "password" | "diagnostics";
const v2Copy={
  ru:{setup:'Настройка администратора',login:'Админ-панель',createPassword:'Создайте пароль',repeat:'Повторите пароль',create:'Создать пароль',password:'Пароль',show:'Показать пароль',hide:'Скрыть пароль',diagnostics:'Диагностика',wrong:'Неверный пароль'},
  kk:{setup:'Әкімшіні баптау',login:'Әкімші панелі',createPassword:'Құпия сөз жасаңыз',repeat:'Құпия сөзді қайталаңыз',create:'Құпия сөз жасау',password:'Құпия сөз',show:'Құпия сөзді көрсету',hide:'Құпия сөзді жасыру',diagnostics:'Диагностика',wrong:'Құпия сөз қате'},
  en:{setup:'Administrator setup',login:'Admin panel',createPassword:'Create a password',repeat:'Repeat password',create:'Create password',password:'Password',show:'Show password',hide:'Hide password',diagnostics:'Diagnostics',wrong:'Wrong password'},
};

function tenge(n: number, currency: string): string {
  if (currency === "KZT") return `${new Intl.NumberFormat("ru-KZ").format(n)} ₸`;
  return `${n} ${currency}`;
}

export function AdminDesk({ onHome, v2Diagnostics=false }: Props) {
  const { t, locale } = useI18n();
  const a = t.admin;
  const copy=v2Copy[locale];
  const [phase, setPhase] = useState<"boot" | "setup" | "login" | "desk">("boot");
  const [tab, setTab] = useState<Tab>(()=>location.hash.startsWith('#/admin/diagnostics')?'diagnostics':'overview');
  const [showPassword,setShowPassword]=useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [overview, setOverview] = useState<OpsOverview | null>(null);
  const [networkOverview,setNetworkOverview]=useState<NetworkOverview|null>(null);
  const [keys, setKeys] = useState<RedactedOpsKeys | null>(null);
  const [turboPaste, setTurboPaste] = useState("");
  const [sitePaste, setSitePaste] = useState("");
  const [kaspiPaste, setKaspiPaste] = useState("");
  const [point, setPoint] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [provider, setProvider] = useState<"mock" | "kaspi">("mock");
  const [price, setPrice] = useState("1500");
  const [currency, setCurrency] = useState("KZT");
  const [clearTreasury, setClearTreasury] = useState(false);
  const [clearSite, setClearSite] = useState(false);
  const [clearKaspi, setClearKaspi] = useState(false);
  const [onceJwk, setOnceJwk] = useState<string | null>(null);
  const [onceAddr, setOnceAddr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live=true;
    if (v2Diagnostics) {
      logoutOps();
      setPhase('login');
      return;
    }
    if(opsNeedsSetup()){setPhase('setup');return;}
    const existing=readSessionPassword();
    if(!existing){setPhase('login');return;}
    void loginOps(existing).then(async valid=>{
      if(!live)return;
      if(!valid){logoutOps();setPhase('login');return;}
      setPhase('desk');await refreshDesk();
    }).catch(()=>{if(live){logoutOps();setPhase('login');}});
    return()=>{live=false;};
  }, [v2Diagnostics]);

  useEffect(()=>{
    if(!v2Diagnostics)return;
    const onHash=()=>{if(location.hash.startsWith('#/admin/diagnostics'))setTab('diagnostics');};
    window.addEventListener('hashchange',onHash);
    return()=>window.removeEventListener('hashchange',onHash);
  },[v2Diagnostics]);

  async function refreshDesk() {
    const secrets = await loadOpsSecrets();
    let balance: string | null = null;
    const jwk = secrets.turboJwk || getHotTreasury()?.jwk;
    if (jwk) {
      try {
        balance = await treasuryBalanceAr(jwk);
      } catch {
        balance = null;
      }
    }
    const withBal = redactOpsKeys(balance);
    setKeys(withBal);
    setPoint(withBal.kaspiTradePointId);
    setApiBase(withBal.kaspiApiBase);
    setProvider(withBal.paymentProvider);
    setPrice(withBal.publishPriceMinor);
    setCurrency(withBal.publishCurrency);
    let network: Awaited<ReturnType<typeof fetchNetworkSaves>> = [];
    if(!v2Diagnostics)try {
      network = await fetchNetworkSaves();
    } catch {
      network = [];
    }
    setOverview(
      mergeOpsOverview({
        network,
        movements: v2Diagnostics?[]:listOpsMovements(),
        treasuryAddress: withBal.treasuryAddress,
        treasuryReady: withBal.treasuryConfigured,
        kaspiReady: withBal.kaspiTokenConfigured,
        provider: withBal.paymentProvider,
        currency: withBal.publishCurrency,
      })
    );
    if(v2Diagnostics){
      try{setNetworkOverview(await fetchAdminNetworkOverview());}
      catch{setNetworkOverview({archives:null,trees:null,saves:null,payments:null,paidCount:null,
        receivedLamports:null,arweaveError:true,solanaError:true});}
    }
    setTurboPaste("");
    setSitePaste("");
    setKaspiPaste("");
    setClearTreasury(false);
    setClearSite(false);
    setClearKaspi(false);
  }

  async function onSetup(e: FormEvent) {
    e.preventDefault();
    if(busy)return;
    setErr(null);
    if (pass !== pass2) {
      setErr(a.mismatch);
      return;
    }
    try {
      setBusy(true);
      await setupOpsPassword(pass);
      setPass("");
      setPass2("");
      setPhase("desk");
      await refreshDesk();
    } catch (e) {
      setErr(e instanceof Error && e.message === "password_too_short" ? a.short : a.failed);
    } finally {setBusy(false);}
  }

  async function onLogin(e: FormEvent) {
    e.preventDefault();
    if(busy)return;
    setErr(null);
    setBusy(true);
    try {
      const okLogin = v2Diagnostics ? await verifyAdminLock(pass) : await loginOps(pass);
      if (!okLogin) {setErr(v2Diagnostics?copy.wrong:a.wrong);return;}
      if (v2Diagnostics) await activateOpsPassword(pass.normalize("NFC"));
      setPass("");
      setPhase("desk");
      await refreshDesk();
    } catch {setErr(a.failed);}
    finally {setBusy(false);}
  }

  async function onSaveKeys() {
    setErr(null);
    setOk(null);
    setBusy(true);
    try {
      let hotAddress: string | undefined;
      if (turboPaste.trim()) hotAddress = await addressFromTreasuryJson(turboPaste.trim());
      await applyOpsKeyPatch({
        turboJwk: turboPaste,
        siteJwk: sitePaste,
        kaspiMerchantToken: kaspiPaste,
        kaspiTradePointId: point,
        kaspiApiBase: apiBase,
        paymentProvider: provider,
        publishPriceMinor: price,
        publishCurrency: currency,
        clearTreasury,
        clearSiteKey: clearSite,
        clearKaspiToken: clearKaspi,
        hotAddress,
      });
      setOk(a.savedKeys);
      await refreshDesk();
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      setErr(code === "turbo_jwk_invalid" || code === "site_jwk_invalid" ? a.invalidJwk : a.failed);
    } finally {
      setBusy(false);
    }
  }

  async function onGenerate() {
    setErr(null);
    setOk(null);
    if (keys?.treasuryConfigured && !window.confirm(a.replaceConfirm)) return;
    setBusy(true);
    try {
      const generated = await generateTreasuryWallet();
      await setGeneratedTreasury(generated.jwk, generated.address);
      setOnceJwk(generated.jwk);
      setOnceAddr(generated.address);
      setOk(a.generated);
      await refreshDesk();
    } catch {
      setErr(a.failed);
    } finally {
      setBusy(false);
    }
  }

  async function onChangePassword(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setOk(null);
    if (pass !== pass2) {
      setErr(a.mismatch);
      return;
    }
    try {
      await changeOpsPassword(pass);
      setPass("");
      setPass2("");
      setOk(a.changed);
    } catch (e) {
      setErr(
        e instanceof Error && e.message === "password_too_short"
          ? a.short
          : passwordTooShort(pass)
            ? a.short
            : a.failed
      );
    }
  }

  function leave() {
    logoutOps();
    setPass('');setPass2('');setKeys(null);setOverview(null);setNetworkOverview(null);setTab('overview');setShowPassword(false);
    setTurboPaste('');setSitePaste('');setKaspiPaste('');setOnceJwk(null);setOnceAddr(null);
    if(v2Diagnostics)setPhase('login');
    else onHome();
  }

  return (
    <div className="ops-desk">
      <header className="ops-desk-bar">
        <button type="button" className="ops-desk-mark" onClick={onHome}>
          <i />
          SEJIRE
        </button>
        <LanguageSwitch placement="chrome" />
      </header>
      <main className="ops-desk-main">
        <h1>{v2Diagnostics?(phase==='setup'?copy.setup:copy.login):a.title}</h1>
        {phase==='desk'&&<><p className="sub">{a.sub}</p><p className="ops-desk-note">{a.pagesHint}</p></>}
        {err && <p className="form-error" role="alert">{err}</p>}
        {ok && <p className="ops-desk-ok">{ok}</p>}

        {phase === "setup" && !v2Diagnostics && (
          <form className="ops-desk-form" onSubmit={(e) => void onSetup(e)}>
            <p className="sub">{a.setupHint}</p>
            <label>
              <span>{v2Diagnostics?copy.createPassword:a.password}</span>
              <input type={showPassword?'text':'password'} autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
            </label>
            <label>
              <span>{v2Diagnostics?copy.repeat:a.passwordAgain}</span>
              <input type={showPassword?'text':'password'} autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
            </label>
            {v2Diagnostics&&<button type="button" className="welcome-link-quiet" onClick={()=>setShowPassword(value=>!value)}>{showPassword?copy.hide:copy.show}</button>}
            <button className="btn" type="submit" disabled={busy}>
              {v2Diagnostics?copy.create:a.create}
            </button>
          </form>
        )}

        {phase === "login" && (
          <form className="ops-desk-form" onSubmit={(e) => void onLogin(e)}>
            <label>
              <span>{v2Diagnostics?copy.password:a.password}</span>
              <input type={showPassword?'text':'password'} autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
            </label>
            {v2Diagnostics&&<button type="button" className="welcome-link-quiet" onClick={()=>setShowPassword(value=>!value)}>{showPassword?copy.hide:copy.show}</button>}
            <button className="btn" type="submit" disabled={busy}>
              {a.enter}
            </button>
          </form>
        )}

        {phase === "desk" && (
          <>
            <div className="ops-desk-tabs" role="tablist">
              <button type="button" className={tab === "overview" ? "is-on" : ""} onClick={() => setTab("overview")}>
                {a.tabOverview}
              </button>
              <button type="button" className={tab === "keys" ? "is-on" : ""} onClick={() => setTab("keys")}>
                {a.tabKeys}
              </button>
              {!v2Diagnostics && <button type="button" className={tab === "password" ? "is-on" : ""} onClick={() => setTab("password")}>
                {a.tabPassword}
              </button>}
              {v2Diagnostics&&<button type="button" className={tab === "diagnostics" ? "is-on" : ""} onClick={() => setTab("diagnostics")}>
                {copy.diagnostics}
              </button>}
            </div>

            {v2Diagnostics&&tab==='diagnostics'&&<PreservationV2Diagnostics embedded />}

            {v2Diagnostics&&tab==='overview'&&(
              <div data-testid="admin-network-overview">
                <p className="sub">Solana Devnet</p>
                {!networkOverview&&<p>Загружаем сетевые данные…</p>}
                {networkOverview&&(networkOverview.arweaveError||networkOverview.solanaError)&&
                  <p role="status">{networkOverview.solanaError?'Не удалось проверить Solana':'Сетевые данные временно недоступны'}</p>}
                <div className="ops-desk-cards">
                  <div className="ops-desk-card"><em>Деревьев</em><strong>{networkOverview?.trees??'—'}</strong></div>
                  <div className="ops-desk-card"><em>Сохранений</em><strong>{networkOverview?.saves??'—'}</strong></div>
                  <div className="ops-desk-card"><em>Оплат подтверждено</em><strong>{networkOverview?.paidCount??'—'}</strong></div>
                  <div className="ops-desk-card"><em>Получено</em><strong>{networkOverview?.receivedLamports==null?'—':`${(networkOverview.receivedLamports/1e9).toFixed(2)} SOL`}</strong></div>
                </div>
                <h2>Arweave</h2>
                <table className="ops-desk-table"><thead><tr><th>Время</th><th>Сейф</th><th>TX</th><th>Статус</th></tr></thead>
                  <tbody>{networkOverview?.archives?.map(row=><tr key={row.txId}>
                    <td>{formatUiDateTime(row.at,locale,'—')}</td><td>{row.vaultFp}</td>
                    <td><a href={`https://viewblock.io/arweave/tx/${row.txId}`} target="_blank" rel="noreferrer">{row.txId.slice(0,6)}…{row.txId.slice(-4)}</a></td>
                    <td>{row.status}</td></tr>)}</tbody></table>
                <h2>Solana</h2>
                <table className="ops-desk-table"><thead><tr><th>Время</th><th>Сумма</th><th>Плательщик</th><th>Signature</th><th>Статус</th></tr></thead>
                  <tbody>{networkOverview?.payments?.map(row=><tr key={row.signature}>
                    <td>{formatUiDateTime(row.at,locale,'—')}</td><td>{(row.lamports/1e9).toFixed(2)} SOL</td>
                    <td>{row.payer.slice(0,6)}…{row.payer.slice(-4)}</td>
                    <td><a href={`https://explorer.solana.com/tx/${row.signature}?cluster=devnet`} target="_blank" rel="noreferrer">{row.signature.slice(0,6)}…{row.signature.slice(-4)}</a></td>
                    <td>{row.status}</td></tr>)}</tbody></table>
              </div>
            )}
            {!v2Diagnostics&&tab === "overview" && overview && (
              <div>
                <p className="sub">
                  {a.treasury}: {overview.treasuryReady ? a.has : a.none}
                  {overview.treasuryAddress
                    ? ` · ${overview.treasuryAddress.slice(0, 6)}…${overview.treasuryAddress.slice(-4)}`
                    : ""}
                  {keys?.treasuryBalanceAr != null ? ` · ${keys.treasuryBalanceAr} AR` : ""}
                  {" · "}
                  Kaspi: {overview.kaspiReady ? a.has : a.none}
                </p>
                <div className="ops-desk-cards">
                  <div className="ops-desk-card">
                    <em>{a.trees}</em>
                    <strong>{overview.trees}</strong>
                  </div>
                  <div className="ops-desk-card">
                    <em>{a.saves}</em>
                    <strong>{overview.saves}</strong>
                  </div>
                  <div className="ops-desk-card">
                    <em>{a.payments}</em>
                    <strong>{overview.paidCount}</strong>
                  </div>
                  <div className="ops-desk-card">
                    <em>{a.sum}</em>
                    <strong>{tenge(overview.paidMinor, overview.currency)}</strong>
                  </div>
                </div>
                <h2>{a.whenTrees}</h2>
                <table className="ops-desk-table">
                  <thead>
                    <tr>
                      <th>{a.when}</th>
                      <th>{a.vault}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.network.length === 0 ? (
                      <tr>
                        <td colSpan={2} className="ops-desk-empty">
                          {a.emptyTrees}
                        </td>
                      </tr>
                    ) : (
                      overview.network.map((row) => (
                        <tr key={row.txId}>
                          <td>{formatUiDateTime(row.at, locale, "—")}</td>
                          <td>
                            {row.vaultFp}
                            <span className="ops-desk-tx"> {row.txId.slice(0, 6)}…</span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
                <h2>{a.pays}</h2>
                <table className="ops-desk-table">
                  <thead>
                    <tr>
                      <th>{a.when}</th>
                      <th>{a.sum}</th>
                      <th>{a.path}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.payments.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="ops-desk-empty">
                          {a.emptyPays}
                        </td>
                      </tr>
                    ) : (
                      overview.payments.map((p, i) => (
                        <tr key={`${p.at}-${i}`}>
                          <td>{formatUiDateTime(p.at, locale, "—")}</td>
                          <td>{tenge(p.amountMinor, p.currency)}</td>
                          <td>
                            {p.provider} · {p.status === "saved" ? a.savedNet : a.paid}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
                <p className="sub">{a.arweaveLag}</p>
              </div>
            )}

            {tab === "keys" && keys && (
              <div className="ops-desk-form">
                <p className="sub">{a.keysHint}</p>
                {provider === "mock" && keys.treasuryConfigured && <p className="ops-desk-warn">{a.mockWarn}</p>}
                <p>
                  {a.treasury}: <strong>{keys.treasuryAddress || (keys.treasuryConfigured ? a.has : a.none)}</strong>
                </p>
                {keys.treasuryAddress && (
                  <p className="sub">
                    {a.fundHint}{" "}
                    <button
                      type="button"
                      className="welcome-link-quiet"
                      onClick={() => void navigator.clipboard.writeText(keys.treasuryAddress || "")}
                    >
                      {a.copyAddr}
                    </button>
                  </p>
                )}
                <div className="actions" style={{ flexDirection: "column", alignItems: "stretch" }}>
                  <button className="btn" type="button" disabled={busy} onClick={() => void onGenerate()}>
                    {busy ? a.generating : a.createTreasury}
                  </button>
                </div>
                {onceJwk && (
                  <div className="ops-desk-once">
                    <p>
                      <strong>{a.once}</strong> {onceAddr}
                    </p>
                    <p className="sub">{a.onceHint}</p>
                    <textarea readOnly value={onceJwk} rows={6} />
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(onceJwk)}
                    >
                      {a.copyJson}
                    </button>
                  </div>
                )}
                <label>
                  <span>{a.pasteJwk}</span>
                  <textarea rows={4} value={turboPaste} onChange={(e) => setTurboPaste(e.target.value)} />
                </label>
                {keys.treasuryConfigured && <p className="sub">{a.alreadyTreasury}</p>}
                <label className="ops-desk-check">
                  <input type="checkbox" checked={clearTreasury} onChange={(e) => setClearTreasury(e.target.checked)} />
                  {a.clearTreasury}
                </label>
                <label>
                  <span>{a.siteJwk}</span>
                  <textarea rows={3} value={sitePaste} onChange={(e) => setSitePaste(e.target.value)} />
                </label>
                <label className="ops-desk-check">
                  <input type="checkbox" checked={clearSite} onChange={(e) => setClearSite(e.target.checked)} />
                  {a.clearSite}
                </label>
                <label>
                  <span>{a.kaspiToken}</span>
                  <input type="password" autoComplete="off" value={kaspiPaste} onChange={(e) => setKaspiPaste(e.target.value)} />
                </label>
                <label className="ops-desk-check">
                  <input type="checkbox" checked={clearKaspi} onChange={(e) => setClearKaspi(e.target.checked)} />
                  {a.clearKaspi}
                </label>
                <label>
                  <span>{a.tradePoint}</span>
                  <input value={point} onChange={(e) => setPoint(e.target.value)} />
                </label>
                <label>
                  <span>{a.api}</span>
                  <input value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="https://pay.kaspi.kz/api/v2" />
                </label>
                <label>
                  <span>{a.payPath}</span>
                  <select value={provider} onChange={(e) => setProvider(e.target.value === "kaspi" ? "kaspi" : "mock")}>
                    <option value="mock">{a.mock}</option>
                    <option value="kaspi">{a.kaspiPay}</option>
                  </select>
                </label>
                <label>
                  <span>{a.price}</span>
                  <input inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} />
                </label>
                <label>
                  <span>{a.currency}</span>
                  <input value={currency} onChange={(e) => setCurrency(e.target.value)} />
                </label>
                <button className="btn" type="button" disabled={busy} onClick={() => void onSaveKeys()}>
                  {a.saveKeys}
                </button>
              </div>
            )}

            {tab === "password" && !v2Diagnostics && (
              <form className="ops-desk-form" onSubmit={(e) => void onChangePassword(e)}>
                <label>
                  <span>{a.newPass}</span>
                  <input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
                </label>
                <label>
                  <span>{a.passwordAgain}</span>
                  <input type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
                </label>
                <button className="btn" type="submit">
                  {a.changePass}
                </button>
              </form>
            )}

            <div className="actions" style={{ marginTop: "1.4rem" }}>
              <button className="btn ghost" type="button" onClick={leave}>
                {a.logout}
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
