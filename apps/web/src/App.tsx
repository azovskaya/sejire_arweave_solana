import { useEffect, useState } from "react";
import { Welcome } from "./components/Welcome";
import { Workspace } from "./components/Workspace";
import { RestoreSeed } from "./components/RestoreSeed";
import { NativeCheckoutPanel } from "./components/NativeCheckoutPanel";
import { PreservationV2 } from "./components/PreservationV2";
import { NativeAdminDesk } from "./components/NativeAdminDesk";
import { AdminDesk } from "./components/AdminDesk";
import { FundAdmin } from "./components/FundAdmin";
import { DraftAccessNotice, useDraftAccess, useDraftDocument } from "./components/DraftAccess";
import { isOpsHash, openOpsHash } from "./lib/opsDesk/route";
import type { TreeStore } from "./lib/types";
import { loadDraftTree } from "./lib/draftStorage";
import {
  defaultGuide,
  loadGuide,
  startGuidedTree,
  type GuideState,
} from "./lib/guide";
import {
  readLastScreen,
  rememberScreen,
  shouldResumeDraft,
} from "./lib/lastScreen";

type Screen = "welcome" | "work" | "restore" | "admin" | "fund-admin" | "saving";

function bootApp(): { screen: Screen; store: TreeStore | null; guide: GuideState } {
  if (typeof location !== "undefined" && location.hash.startsWith("#/fund-admin")) {
    return { screen: "fund-admin", store: null, guide: defaultGuide() };
  }
  if (typeof location !== "undefined" && isOpsHash(location.hash)) {
    return { screen: "admin", store: null, guide: defaultGuide() };
  }
  if(typeof location!=="undefined"&&location.hash.startsWith("#/save"))return {screen:"saving",store:loadDraftTree(),guide:loadGuide()??defaultGuide()};
  if(typeof location!=="undefined"&&location.hash.startsWith("#/restore"))return {screen:"restore",store:null,guide:defaultGuide()};
  const draft = loadDraftTree();
  if (shouldResumeDraft(readLastScreen(), Boolean(draft)) && draft) {
    return {
      screen: "work",
      store: draft,
      guide: loadGuide() ?? { ...defaultGuide(), step: "done" },
    };
  }
  return { screen: "welcome", store: null, guide: defaultGuide() };
}

export default function App() {
  const [boot] = useState(() => ({ ...bootApp(), hash: location.hash }));
  const [savingRoute, setSavingRoute] = useState(() => location.hash);
  const [savingNavigation, setSavingNavigation] = useState(0);
  const [screen, setScreen] = useState<Screen>(boot.screen);
  const access = useDraftAccess();
  const draft = useDraftDocument(access, boot);
  const { store, guide } = draft;

  function go(next: Screen) {
    if (next === "admin") {
      openOpsHash();
      setScreen("admin");
      return;
    }
    const hash = next === "restore" ? "#/restore" : next === "saving" ? "#/save" : next === "fund-admin" ? "#/fund-admin" : "";
    history.replaceState(null, "", location.pathname + location.search + hash);
    rememberScreen(next === "work" || next === "welcome" || next === "restore" ? next : "welcome");
    setScreen(next);
  }

  useEffect(() => {
    function onHash() {
      if (location.hash.startsWith("#/fund-admin")) setScreen("fund-admin");
      else if (isOpsHash(location.hash)) setScreen("admin");
      else if(location.hash.startsWith("#/save")){setSavingRoute(location.hash);setSavingNavigation(n=>n+1);setScreen("saving");}
      else if(location.hash.startsWith("#/restore"))setScreen("restore");
      else setScreen("welcome");
    }
    window.addEventListener("hashchange", onHash);
    // A fragment may change between the initial render and effect subscription.
    // Preserve unchanged empty-URL draft resume, but reconcile real navigation.
    if (location.hash !== boot.hash) onHash();
    return () => window.removeEventListener("hashchange", onHash);
  }, [boot.hash]);

  function startNew(title: string) {
    // A new tree belongs to the archive already unlocked in this tab. Closing
    // that archive is a separate explicit action on the welcome screen.
    const started = startGuidedTree(title);
    if (draft.replace(started.store, started.guide)) go("work");
  }

  function continueDraft() {
    if (!draft.pending && loadDraftTree() && draft.loadSaved()) go("work");
  }

  return (
    <div className={screen === "work" ? "app-shell is-work" : "app-shell"}>
      <DraftAccessNotice access={access} document={draft} onHome={() => go("welcome")} />
      {screen === "welcome" && (
        <Welcome
          onStartNew={startNew}
          onContinueDraft={continueDraft}
          onRestoreSeed={() => go("restore")}
          onCashier={() => go("admin")}
          draftWritable={draft.ready && !draft.pending}
        />
      )}

      {screen === "saving" && <main className="landing">{import.meta.env.VITE_PRESERVATION_V2_ENABLED === "1"
        ? <PreservationV2 key={savingRoute+':'+savingNavigation} legacyPilot={savingRoute.split('?')[0] === '#/save/legacy-pilot'} treeName={store?.meta.title} onBack={() => go(store?"work":"welcome")} />
        : <NativeCheckoutPanel key={savingRoute+':'+savingNavigation} resume treeName={store?.meta.title} onBack={() => go(store?"work":"welcome")} />}</main>}
      {screen === "admin" && (import.meta.env.VITE_PRESERVATION_V2_ENABLED === "1"
        ? <AdminDesk onHome={() => go("welcome")} v2Diagnostics />
        : <NativeAdminDesk onHome={() => go("welcome")} />)}

      {screen === "fund-admin" && (
        <main className="landing">
          <FundAdmin />
          <button className="btn ghost" type="button" onClick={() => go("welcome")}>На главную</button>
        </main>
      )}

      {screen === "restore" && draft.ready && !draft.pending && (
        <RestoreSeed
          key={access.token?.epoch}
          onBack={() => go("welcome")}
          onRestored={continueDraft}
        />
      )}

      {screen === "work" && store && draft.ready && (
        <Workspace
          key={access.token?.epoch}
          store={store}
          guide={guide}
          onStoreChange={(next) => draft.updateStore(next, store.meta.id)}
          onGuideChange={(next) => draft.updateGuide(next, store.meta.id)}
          onDraftReplace={draft.replace}
          onDraftReload={draft.loadSaved}
          onHome={() => go("welcome")}
        />
      )}
    </div>
  );
}
