import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  createMnemonic,
  isValidMnemonic,
  normalizeMnemonic,
  splitWords,
} from "../lib/crypto/bip39";
import { deriveKeysFromMnemonic, fingerprintVaultId } from "../lib/crypto/keys";
import { downloadSeedBackup } from "../lib/crypto/seedBackup";
import type { TreeStore } from "../lib/types";
import {
  downloadEnvelope,
  putTree,
  sealVault,
} from "../lib/crypto/vault";
import type { EnvelopeV1 } from "../lib/crypto/encrypt";
import { loadVaultForPublish } from "../lib/arweave/loadVault";
import { addressFromJwk, jwkFromSeed } from "../lib/arweave/wallet";
import { getWalletBalanceAr, publishEnvelope } from "../lib/arweave/publish";
import { isDemoPublishEnabled, isSponsorPublishEnabled } from "../lib/sponsor/config";
import {
  getHotTreasury,
  getOpsSettings,
  isTreasuryPublishEnabled,
  recordOpsMovement,
} from "../lib/opsDesk/store";
import {
  sponsorCheckout,
  sponsorHealth,
  sponsorMockPay,
  sponsorPublish,
  sponsorSessionStatus,
  type CheckoutResponse,
} from "../lib/sponsor/client";
import {
  getSessionMnemonic,
  getVaultSession,
  setVaultSession,
  updateVaultHead,
} from "../lib/vaultSession/session";
import {
  archiveLocalVaultVersion,
  makeLocalVersionId,
} from "../lib/vaultSession/localArchive";
import { useI18n } from "../lib/i18n/I18nProvider";

import { NativeCheckoutPanel } from './NativeCheckoutPanel';
import { PreservationV2 } from './PreservationV2';
import { CheckoutPublishPanel, SolanaPublishPanel } from '@sejire/payment-panels';
import { solanaMessages } from "../lib/solana/messages";
import type { PreservationReceipt } from "../lib/solana/client";

type Props = {
  store: TreeStore;
  onClose: () => void;
  onPublished: (info: {
    txId?: string;
    mode: "export" | "arweave" | "sponsor" | "demo" | "solana" | "solana-test";
    address?: string;
    mock?: boolean;
    isNewVersion?: boolean;
  }) => void;
  /** Previous network TX under the same 12 words (for Parent-Tx). */
  parentTxId?: string | null;
  /** Session mnemonic — skip re-entry when saving a new version. */
  knownMnemonic?: string | null;
};

type Mode =
  | "intro"
  | "create-show"
  | "create-confirm"
  | "create-ready"
  | "existing"
  | "new-version"
  | "busy"
  | "fund-wait"
  | "pay"
  | "solana";

function formatPrice(amountMinor: number, currency: string): string {
  const cur = currency.toUpperCase();
  if (cur === "KZT" || cur === "₸") return `${amountMinor} ₸`;
  if (cur === "USD") return `$${(amountMinor / 100).toFixed(2)}`;
  return `${amountMinor} ${cur}`;
}

export function PublishSeedModal({
  store,
  onClose,
  onPublished,
  parentTxId: parentTxProp,
  knownMnemonic: knownMnemonicProp,
}: Props) {
  const { t, locale } = useI18n();
  const st = solanaMessages[locale];
  const SolanaSavePanel = import.meta.env.VITE_NATIVE_AR_ENABLED === "1" ? NativeCheckoutPanel : import.meta.env.VITE_CHECKOUT_ENABLED === "1" ? CheckoutPublishPanel : SolanaPublishPanel;
  const solanaBusy = useRef(false);
  const freshKey = useRef(false);
  const solanaReturnMode = useRef<Mode>("create-ready");
  const sponsorOn = isSponsorPublishEnabled();
  const demoOn = isDemoPublishEnabled();
  const treasuryOn = isTreasuryPublishEnabled();
  const session = getVaultSession();
  const knownMnemonic = knownMnemonicProp ?? getSessionMnemonic();
  const parentTxId = parentTxProp ?? session?.headTxId ?? null;
  const hasSessionKey = Boolean(knownMnemonic && isValidMnemonic(normalizeMnemonic(knownMnemonic)));

  const [mode, setMode] = useState<Mode>(hasSessionKey ? "new-version" : "intro");
  const [mnemonic, setMnemonic] = useState(hasSessionKey ? normalizeMnemonic(knownMnemonic!) : "");
  const [confirm, setConfirm] = useState("");
  const [existing, setExisting] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [seedFileSaved, setSeedFileSaved] = useState(false);
  const [sealedEnvelope, setSealedEnvelope] = useState<EnvelopeV1 | null>(null);
  const [checkout, setCheckout] = useState<CheckoutResponse | null>(null);
  const [priceHint, setPriceHint] = useState<string | null>(null);
  const [publishParentTx, setPublishParentTx] = useState<string | null>(parentTxId);
  const words = useMemo(() => (mnemonic ? splitWords(mnemonic) : []), [mnemonic]);

  function confirmDiscardSeed() {
    return window.confirm(t.publish.discardConfirm);
  }

  const seedLocked =
    mode === "create-show" ||
    mode === "create-confirm" ||
    mode === "create-ready" ||
    mode === "busy" ||
    mode === "fund-wait" ||
    mode === "pay" ||
    mode === "solana" ||
    mode === "new-version";

  useEffect(() => {
    if (!sponsorOn) return;
    void sponsorHealth()
      .then((h) => {
        if (h.priceMinor != null && h.currency) {
          setPriceHint(formatPrice(h.priceMinor, h.currency));
        }
      })
      .catch(() => {
        setPriceHint(null);
      });
  }, [sponsorOn]);

  useEffect(() => {
    if (mode !== "pay" || !checkout || checkout.mockPayable) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const st = await sponsorSessionStatus(checkout.sessionId);
        if (!cancelled && st.paid) {
          setStatus(t.publish.kaspiPaid);
        }
      } catch {
        /* сеть кассира могла моргнуть — следующая попытка */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [mode, checkout]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (mode === "busy" || solanaBusy.current) {
        e.preventDefault();
        return;
      }
      if (
        mode === "create-show" ||
        mode === "create-confirm" ||
        mode === "create-ready" ||
        mode === "fund-wait" ||
        mode === "pay" ||
        mode === "solana" ||
        mode === "new-version"
      ) {
        e.preventDefault();
        if (mode === "new-version") {
          onClose();
          return;
        }
        if (!confirmDiscardSeed()) return;
        setMode("intro");
        setMnemonic("");
        setConfirm("");
        setError(null);
        setWalletAddress(null);
        setSeedFileSaved(false);
        setSealedEnvelope(null);
        setCheckout(null);
        return;
      }
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, onClose]);

  async function sealForPhrase(phrase: string): Promise<{
    keys: ReturnType<typeof deriveKeysFromMnemonic>;
    envelope: EnvelopeV1;
    parentTx: string | null;
  }> {
    const keys = deriveKeysFromMnemonic(phrase);
    setStatus(t.publish.vaultFp(fingerprintVaultId(keys.vaultId)));
    const loaded = await loadVaultForPublish(keys, {
      parentTxId: publishParentTx && /^[A-Za-z0-9_-]{43}$/.test(publishParentTx) ? publishParentTx : null,
      freshKey: freshKey.current,
    });
    setPublishParentTx(loaded.parentTxId);
    const vault = putTree(loaded.vault, store);
    setStatus(t.publish.encrypting);
    const envelope = await sealVault(keys, vault);
    return { keys, envelope, parentTx: loaded.parentTxId };
  }

  function rememberSession(
    keys: ReturnType<typeof deriveKeysFromMnemonic>,
    phrase: string,
    txId?: string
  ) {
    freshKey.current = false;
    setVaultSession(
      {
        vaultId: keys.vaultId,
        headTxId: txId ?? publishParentTx,
        source: txId ? "publish" : session?.source ?? "publish",
      },
      phrase
    );
    if (txId) updateVaultHead(txId);
  }

  function archiveVersion(
    keys: ReturnType<typeof deriveKeysFromMnemonic>,
    envelope: EnvelopeV1,
    id: string,
    parentTx: string | null,
    source: "network" | "sponsor" | "export" | "demo"
  ) {
    archiveLocalVaultVersion({
      id,
      vaultId: keys.vaultId,
      parentId: parentTx,
      source,
      envelope,
    });
  }

  async function startSolanaFlow(phrase: string) {
    solanaReturnMode.current = mode;
    setMode("busy"); setError(null);
    try {
      const { envelope, parentTx } = await sealForPhrase(phrase);
      setSealedEnvelope(envelope); setPublishParentTx(parentTx); setMnemonic(phrase);
      setMode("solana"); setStatus("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode(solanaReturnMode.current);
    }
  }

  function recordSolana(receipt: PreservationReceipt, acceptedEnvelope: EnvelopeV1, acceptedParent: string | null) {
    const keys = deriveKeysFromMnemonic(mnemonic);
    const live = receipt.network === "mainnet-beta";
    if (live) {
      archiveVersion(keys, acceptedEnvelope, receipt.receipt.id, acceptedParent, "network");
      rememberSession(keys, mnemonic, receipt.receipt.id);
      freshKey.current = false;
    }
  }

  function finishSolana(receipt: PreservationReceipt, acceptedParent: string | null) {
    const live = receipt.network === "mainnet-beta";
    onPublished({ mode: live ? "solana" : "solana-test", txId: receipt.receipt.id,
      isNewVersion: Boolean(acceptedParent) });
  }

  async function runDemoPublish(phrase: string) {
    setMode("busy");
    setError(null);
    setWalletAddress(null);
    try {
      const { keys, envelope, parentTx } = await sealForPhrase(phrase);
      setStatus(t.publish.demoSaving);
      const id = makeLocalVersionId("demo");
      archiveVersion(keys, envelope, id, parentTx, "demo");
      rememberSession(keys, phrase, id);
      onPublished({
        mode: "demo",
        txId: id,
        isNewVersion: Boolean(parentTx),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode(hasSessionKey ? "new-version" : "create-ready");
    }
  }

  async function runSelfFundPublish(phrase: string) {
    setMode("busy");
    setError(null);
    setWalletAddress(null);
    try {
      const { keys, envelope, parentTx } = await sealForPhrase(phrase);
      setStatus(t.publish.makingAddress);
      const jwk = await jwkFromSeed(keys.seed);
      const address = await addressFromJwk(jwk);
      setWalletAddress(address);
      const balance = await getWalletBalanceAr(jwk);
      setStatus(t.publish.sending(address.slice(0, 8), balance));
      const result = await publishEnvelope(jwk, envelope, {
        parentTxId: parentTx,
        updatedAt: new Date().toISOString(),
      });
      if (!result.ok) {
        downloadEnvelope(envelope);
        const fundHint = result.needsFunds
          ? t.publish.fundHint
          : "";
        setError(`${result.error}${fundHint}`);
        setMnemonic(phrase);
        setMode(result.needsFunds ? "fund-wait" : "intro");
        return;
      }
      archiveVersion(keys, envelope, result.txId, parentTx, "network");
      rememberSession(keys, phrase, result.txId);
      onPublished({
        mode: "arweave",
        txId: result.txId,
        address,
        isNewVersion: Boolean(parentTx),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode(mnemonic ? "fund-wait" : hasSessionKey ? "new-version" : "intro");
    }
  }

  async function runTreasuryPublish(phrase: string) {
    const hot = getHotTreasury();
    if (!hot) {
      await runSelfFundPublish(phrase);
      return;
    }
    setMode("busy");
    setError(null);
    setWalletAddress(hot.address);
    try {
      const { keys, envelope, parentTx } = await sealForPhrase(phrase);
      const jwk = JSON.parse(hot.jwk) as Awaited<ReturnType<typeof jwkFromSeed>>;
      const balance = await getWalletBalanceAr(jwk);
      setStatus(t.publish.sendingTreasury(hot.address.slice(0, 8), balance));
      const result = await publishEnvelope(jwk, envelope, {
        parentTxId: parentTx,
        updatedAt: new Date().toISOString(),
      });
      if (!result.ok) {
        downloadEnvelope(envelope);
        const fundHint = result.needsFunds ? t.publish.fundHint : "";
        setError(`${result.error}${fundHint}`);
        setMnemonic(phrase);
        setMode(result.needsFunds ? "fund-wait" : "intro");
        return;
      }
      const settings = getOpsSettings();
      recordOpsMovement({
        kind: "saved",
        amountMinor: Number(settings.publishPriceMinor) || 0,
        currency: settings.publishCurrency,
        provider: "treasury",
        txId: result.txId,
        vaultId: keys.vaultId,
      });
      archiveVersion(keys, envelope, result.txId, parentTx, "network");
      rememberSession(keys, phrase, result.txId);
      onPublished({
        mode: "arweave",
        txId: result.txId,
        address: hot.address,
        isNewVersion: Boolean(parentTx),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode(mnemonic ? "fund-wait" : hasSessionKey ? "new-version" : "intro");
    }
  }

  async function runLocalExport(phrase: string) {
    setMode("busy");
    setError(null);
    setWalletAddress(null);
    try {
      const { keys, envelope, parentTx } = await sealForPhrase(phrase);
      const id = makeLocalVersionId("local");
      archiveVersion(keys, envelope, id, parentTx, "export");
      downloadEnvelope(envelope);
      rememberSession(keys, phrase, id);
      onPublished({ mode: "export", txId: id, isNewVersion: Boolean(parentTx) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode(hasSessionKey ? "new-version" : "intro");
    }
  }

  /** Seal → checkout → pay screen (Kaspi or mock). */
  async function startSponsorFlow(phrase: string) {
    setMode("busy");
    setError(null);
    setWalletAddress(null);
    setCheckout(null);
    setSealedEnvelope(null);
    try {
      const { keys, envelope, parentTx } = await sealForPhrase(phrase);
      setSealedEnvelope(envelope);
      setPublishParentTx(parentTx);
      setStatus(t.publish.checkout);
      const sessionPay = await sponsorCheckout({
        vaultId: envelope.vault_id,
        successUrl: typeof window !== "undefined" ? window.location.href : undefined,
        cancelUrl: typeof window !== "undefined" ? window.location.href : undefined,
      });
      setCheckout(sessionPay);
      setMnemonic(phrase);
      rememberSession(keys, phrase);
      setMode("pay");
      setStatus("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode(hasSessionKey ? "new-version" : "create-ready");
    }
  }

  async function confirmPaidAndPublish() {
    if (!checkout || !sealedEnvelope) {
      setError(t.publish.noSession);
      return;
    }
    setMode("busy");
    setError(null);
    try {
      if (checkout.mockPayable) {
        setStatus(t.publish.mockConfirm);
        await sponsorMockPay(checkout.sessionId);
      } else {
        setStatus(t.publish.kaspiAsk);
        let paid = false;
        for (let i = 0; i < 8; i += 1) {
          const st = await sponsorSessionStatus(checkout.sessionId);
          if (st.paid) {
            paid = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (!paid) {
          throw new Error(
            t.publish.kaspiWait
          );
        }
      }
      setStatus(t.publish.uploading);
      const result = await sponsorPublish(checkout.sessionId, sealedEnvelope, {
        parentTxId: publishParentTx,
      });
      const keys = deriveKeysFromMnemonic(mnemonic);
      archiveVersion(keys, sealedEnvelope, result.txId, publishParentTx, "sponsor");
      rememberSession(keys, mnemonic, result.txId);
      onPublished({
        mode: "sponsor",
        txId: result.txId,
        mock: result.mock,
        isNewVersion: Boolean(publishParentTx),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode("pay");
    }
  }

  function startCreate() {
    if (mnemonic && !confirmDiscardSeed()) return;
    setMnemonic(createMnemonic());
    freshKey.current = true;
    setConfirm("");
    setError(null);
    setWalletAddress(null);
    setSeedFileSaved(false);
    setSealedEnvelope(null);
    setCheckout(null);
    setPublishParentTx(null);
    setMode("create-show");
  }

  function onConfirmCreate(e: FormEvent) {
    e.preventDefault();
    if (normalizeMnemonic(confirm) !== normalizeMnemonic(mnemonic)) {
      setError(t.publish.mismatch);
      return;
    }
    setError(null);
    setSeedFileSaved(false);
    setMode("create-ready");
  }

  function saveSeedFile() {
    if (normalizeMnemonic(confirm) !== normalizeMnemonic(mnemonic)) {
      setError(t.publish.repeatFirst);
      return;
    }
    try {
      downloadSeedBackup(mnemonic);
      setSeedFileSaved(true);
      setStatus(t.publish.seedDownloaded);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onExisting(e: FormEvent) {
    e.preventDefault();
    const phrase = normalizeMnemonic(existing);
    if (!isValidMnemonic(phrase)) {
      setError(t.publish.badMnemonic);
      return;
    }
    setMnemonic(phrase);
    freshKey.current = false;
    if (import.meta.env.VITE_PUBLISH_MODE === "solana") await startSolanaFlow(phrase);
    else if (sponsorOn) await startSponsorFlow(phrase);
    else if (demoOn) await runDemoPublish(phrase);
    else if (treasuryOn) await runTreasuryPublish(phrase);
    else await runSelfFundPublish(phrase);
  }

  async function exportFileOnly() {
    if (normalizeMnemonic(confirm) !== normalizeMnemonic(mnemonic)) {
      setError(t.publish.repeatRecord);
      return;
    }
    await runLocalExport(mnemonic);
  }

  async function copyAddress() {
    if (!walletAddress) return;
    try {
      await navigator.clipboard.writeText(walletAddress);
      setStatus(t.publish.copiedStatus);
    } catch {
      setStatus(t.publish.copyManual);
    }
  }

  function requestClose() {
    if (mode === "busy" || solanaBusy.current) return;
    if (seedLocked && mnemonic && mode !== "new-version") {
      if (!confirmDiscardSeed()) return;
    }
    onClose();
  }

  const primarySaveLabel = demoOn
    ? t.publish.demoNew
    : sponsorOn
      ? t.publish.payNew(priceHint ? ` ~${priceHint}` : "")
      : treasuryOn
        ? t.publish.treasuryNew
        : t.publish.networkNew;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal panel">
        <h2>{t.publish.title}</h2>
        <p className="sub">
          {t.publish.lead}
          {demoOn && t.publish.leadDemo}
          {sponsorOn && (
            <>
              {t.publish.leadSponsor}
              {priceHint ? ` (~${priceHint})` : ""}.
            </>
          )}
          {!demoOn && !sponsorOn && treasuryOn && t.publish.leadTreasury}
        </p>

        {mode === "solana" && sealedEnvelope && import.meta.env.VITE_PRESERVATION_V2_ENABLED === "1" && (
          <PreservationV2 envelope={sealedEnvelope} treeName={store.meta.title}
            onBusy={(busy) => { solanaBusy.current = busy; }}
            onBack={() => setMode(solanaReturnMode.current)} />
        )}
        {mode === "solana" && sealedEnvelope && import.meta.env.VITE_PRESERVATION_V2_ENABLED !== "1" && (
          <SolanaSavePanel {...(import.meta.env.VITE_NATIVE_AR_ENABLED === "1" ? {treeName:store.meta.title,recoveryKeyInMemory:isValidMnemonic(normalizeMnemonic(mnemonic))} : {})} envelope={sealedEnvelope} parentTxId={publishParentTx}
            onAccepted={recordSolana}
            onBusy={(busy) => { solanaBusy.current = busy; }}
            onBack={() => setMode(solanaReturnMode.current)}
            onDone={finishSolana} />
        )}

        {mode === "new-version" && (
          <div>
            <p className="sub">
              {t.publish.newVersionHint}
              {session?.vaultId ? ` (${fingerprintVaultId(session.vaultId)})` : ""}.
              {publishParentTx
                ? t.publish.prevKept(publishParentTx.slice(0, 8))
                : t.publish.oldKept}
            </p>
            <div className="actions" style={{ flexDirection: "column", alignItems: "stretch" }}>
              {!demoOn && <button className="btn" type="button" onClick={() => void startSolanaFlow(mnemonic)}>{st.save}</button>}
              {demoOn && (
                <button className="btn" type="button" onClick={() => void runDemoPublish(mnemonic)}>
                  {primarySaveLabel}
                </button>
              )}
              {sponsorOn && (
                <button
                  className="btn"
                  type="button"
                  onClick={() => void startSponsorFlow(mnemonic)}
                >
                  {primarySaveLabel}
                </button>
              )}
              {treasuryOn && !demoOn && !sponsorOn && (
                <button
                  className="btn"
                  type="button"
                  onClick={() => void runTreasuryPublish(mnemonic)}
                >
                  {primarySaveLabel}
                </button>
              )}
              {!demoOn && (
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => void runSelfFundPublish(mnemonic)}
                >
                  {sponsorOn || treasuryOn ? t.publish.selfArNew : t.publish.networkNew}
                </button>
              )}
              <button className="btn ghost" type="button" onClick={() => void runLocalExport(mnemonic)}>
                {t.publish.localCipher}
              </button>
              <button
                className="btn ghost"
                type="button"
                onClick={() => {
                  setMode("intro");
                  setMnemonic("");
                }}
              >
                {t.publish.otherWords}
              </button>
              <button className="btn ghost" type="button" onClick={requestClose}>
                {t.cancel}
              </button>
            </div>
          </div>
        )}

        {mode === "intro" && (
          <div className="actions" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <button className="btn" type="button" onClick={startCreate}>
              {t.publish.createWords}
            </button>
            <button className="btn ghost" type="button" onClick={() => setMode("existing")}>
              {t.publish.haveWords}
            </button>
            <button className="btn ghost" type="button" onClick={requestClose}>
              {t.cancel}
            </button>
          </div>
        )}

        {mode === "create-show" && (
          <div>
            <p className="sub">
              {t.publish.writeNow}
            </p>
            <ol className="seed-grid">
              {words.map((w, i) => (
                <li key={`${w}-${i}`}>
                  <span>{i + 1}.</span> {w}
                </li>
              ))}
            </ol>
            <div className="actions">
              <button
                className="btn ghost"
                type="button"
                onClick={() => {
                  if (!confirmDiscardSeed()) return;
                  setMnemonic("");
                  setMode("intro");
                }}
              >
                {t.back}
              </button>
              <button className="btn" type="button" onClick={() => setMode("create-confirm")}>
                {t.publish.iWrote}
              </button>
            </div>
          </div>
        )}

        {mode === "create-confirm" && (
          <form onSubmit={onConfirmCreate}>
            <p className="sub">{t.publish.repeat}</p>
            <textarea
              rows={3}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <div className="actions">
              <button className="btn ghost" type="button" onClick={() => setMode("create-show")}>
                {t.back}
              </button>
              <button className="btn" type="submit">
                {t.next}
              </button>
            </div>
          </form>
        )}

        {mode === "create-ready" && (
          <div>
            <p className="sub">{t.publish.matched}</p>
            <div className="actions" style={{ flexDirection: "column", alignItems: "stretch" }}>
              <button className="btn" type="button" onClick={saveSeedFile}>
                {seedFileSaved ? t.publish.seedJsonAgain : t.publish.seedJson}
              </button>
              {!demoOn && <button className="btn" type="button" onClick={() => void startSolanaFlow(mnemonic)}>{st.save}</button>}
              {demoOn && (
                <button className="btn" type="button" onClick={() => void runDemoPublish(mnemonic)}>
                  {t.publish.demoSave}
                </button>
              )}
              {sponsorOn && (
                <button
                  className="btn"
                  type="button"
                  onClick={() => void startSponsorFlow(mnemonic)}
                >
                  {t.publish.foreverPay(priceHint ? ` ~${priceHint}` : "")}
                </button>
              )}
              {treasuryOn && !demoOn && !sponsorOn && (
                <button
                  className="btn"
                  type="button"
                  onClick={() => void runTreasuryPublish(mnemonic)}
                >
                  {t.publish.treasurySave}
                </button>
              )}
              {!demoOn && (
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => void runSelfFundPublish(mnemonic)}
                >
                  {sponsorOn || treasuryOn ? t.publish.selfArFallback : t.publish.selfArMain}
                </button>
              )}
              <button className="btn ghost" type="button" onClick={() => void exportFileOnly()}>
                {t.publish.localTree}
              </button>
              <button className="btn ghost" type="button" onClick={() => setMode("create-confirm")}>
                {t.back}
              </button>
            </div>
            {seedFileSaved && status && <p className="sub">{status}</p>}
          </div>
        )}

        {mode === "pay" && checkout && (
          <div>
            <p className="sub">
              {t.publish.payLine(
                formatPrice(checkout.amountMinor, checkout.currency),
                checkout.provider === "mock" ? t.publish.viaMock : t.publish.viaKaspi,
                publishParentTx ? t.publish.newVerShort : ""
              )}
            </p>
            {checkout.payUrl && (
              <p className="sub">
                <a href={checkout.payUrl} target="_blank" rel="noopener noreferrer">
                  {t.publish.openKaspi}
                </a>
              </p>
            )}
            <div className="actions" style={{ flexDirection: "column", alignItems: "stretch" }}>
              <button className="btn" type="button" onClick={() => void confirmPaidAndPublish()}>
                {checkout.mockPayable ? t.publish.paidMock : t.publish.paidLive}
              </button>
              <button
                className="btn ghost"
                type="button"
                onClick={() => {
                  setCheckout(null);
                  setSealedEnvelope(null);
                  setMode(hasSessionKey ? "new-version" : "create-ready");
                }}
              >
                {t.back}
              </button>
            </div>
          </div>
        )}

        {mode === "existing" && (
          <form onSubmit={(e) => void onExisting(e)}>
            <p className="sub">{t.publish.existingHint}</p>
            <textarea
              rows={3}
              value={existing}
              onChange={(e) => setExisting(e.target.value)}
              placeholder="word1 word2 … word12"
              required
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <div className="actions">
              <button className="btn ghost" type="button" onClick={() => setMode("intro")}>
                {t.back}
              </button>
              <button className="btn" type="submit">
                {import.meta.env.VITE_PUBLISH_MODE === "solana" ? st.save : demoOn
                  ? t.publish.demoSaveBtn
                  : sponsorOn
                    ? t.publish.encryptPay
                    : treasuryOn
                      ? t.publish.treasurySave
                      : t.publish.encryptSend}
              </button>
            </div>
          </form>
        )}

        {mode === "busy" && (
          <div>
            <p className="sub">{status || t.publish.busy}</p>
            {walletAddress && (
              <p className="sub mono publish-meta">
                {t.publish.addressFromWords} {walletAddress}
              </p>
            )}
          </div>
        )}

        {mode === "fund-wait" && (
          <div>
            <p className="sub">{t.publish.fundLead}</p>
            {walletAddress && (
              <button
                type="button"
                className="publish-address"
                onClick={() => void copyAddress()}
                title={t.publish.copyTitle}
              >
                {walletAddress}
                <span className="publish-address-hint">
                  {status === t.publish.copiedStatus ? t.publish.copied : t.publish.copyHint}
                </span>
              </button>
            )}
            <ol className="fund-steps">
              <li>{t.publish.fund1}</li>
              <li>{t.publish.fund2}</li>
              <li>{t.publish.fund3}</li>
              <li>{t.publish.fund4}</li>
              <li>{t.publish.fund5}</li>
            </ol>
            <div className="actions" style={{ flexDirection: "column", alignItems: "stretch" }}>
              <button
                className="btn"
                type="button"
                onClick={() =>
                  void (treasuryOn ? runTreasuryPublish(mnemonic) : runSelfFundPublish(mnemonic))
                }
              >
                {t.publish.send}
              </button>
              {sponsorOn && (
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => void startSponsorFlow(mnemonic)}
                >
                  {t.publish.payInstead}
                </button>
              )}
              {demoOn && (
                <button className="btn ghost" type="button" onClick={() => void runDemoPublish(mnemonic)}>
                  {t.publish.demoInstead}
                </button>
              )}
              <button className="welcome-link-quiet" type="button" onClick={requestClose}>
                {t.close}
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="form-error-block">
            <p className="form-error">{error}</p>
            {walletAddress && mode !== "fund-wait" && (
              <p className="sub mono publish-meta">
                {t.publish.addressLabel} {walletAddress}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
