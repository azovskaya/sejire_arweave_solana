import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Person, TreeStore } from "../lib/types";
import { saveDraftTree } from "../lib/draftStorage";
import { type GuideState, defaultGuide, saveGuide } from "../lib/guide";
import { pickDefaultFocus, pickHomeFocus, splitParents, type AddMeSlot } from "../lib/pedigree";
import { PedigreeView } from "./PedigreeView";
import { PersonPanel, type PersonPanelHandle } from "./PersonPanel";
import { AddPersonModal, type AddPersonPayload } from "./AddPersonModal";
import { PublishSeedModal } from "./PublishSeedModal";
import { VaultVersionsModal, vaultPersonCount } from "./VaultVersionsModal";
import {
  activePersons,
  commitDraft,
  removeDraftPerson,
  restoreDraftPerson,
  setDraftPerson,
} from "../lib/treeEngine";
import { SHEZHIRE_MAX_GENERATIONS, type PdfLocale } from "../lib/i18n/pdf";
import type { ShezhireTemplateId } from "../lib/pdf/shezhireTemplates";
import { downloadTreeJson, readTreeJsonFile, coerceTreeStore } from "../lib/treeJson";
import { formatShezhireAffiliation } from "../lib/zhuzRu";
import { ShezhireMetaModal } from "./ShezhireMetaModal";
import { ShezhireTemplateModal } from "./ShezhireTemplateModal";
import {
  clearVaultSession,
  getSessionMnemonic,
  getVaultSession,
} from "../lib/vaultSession/session";
import type { VaultV1 } from "../lib/crypto/vault";
import { pickPdfRootId } from "../lib/pdfRoot";
import { mirrorStoreToProtocol } from "../lib/ao/protocolMirror";
import {
  queryPersonFromDraft,
  type PersonProtocolView,
} from "../lib/ao/protocolKinship";
import { useI18n } from "../lib/i18n/I18nProvider";
import { solanaMessages } from "../lib/solana/messages";
import { LanguageSwitch } from "./LanguageSwitch";

function uid() {
  return `p_${Math.random().toString(36).slice(2, 9)}`;
}

type Props = {
  store: TreeStore;
  guide: GuideState;
  onStoreChange: (store: TreeStore | ((prev: TreeStore) => TreeStore)) => void;
  onGuideChange: (guide: GuideState) => void;
  onHome: () => void;
};

type PendingAdd =
  | { type: "self" }
  | { type: "parent"; childId: string; role: "father" | "mother" };

type ToastState = {
  message: string;
  undo?: () => void;
  actionLabel?: string;
};

export function Workspace({ store, guide, onStoreChange, onGuideChange, onHome }: Props) {
  const { locale, t } = useI18n();
  const pdfLocale = locale as PdfLocale;
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [pending, setPending] = useState<PendingAdd | null>(null);
  const [showPublish, setShowPublish] = useState(false);
  const [publishStore, setPublishStore] = useState<TreeStore | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimer = useRef<number | null>(null);
  const jsonInputRef = useRef<HTMLInputElement | null>(null);
  const moreRef = useRef<HTMLDetailsElement | null>(null);
  const panelRef = useRef<PersonPanelHandle | null>(null);
  const [ancestorsHint, setAncestorsHint] = useState(false);
  const [showShezhireMeta, setShowShezhireMeta] = useState(false);
  const [showShezhireTemplate, setShowShezhireTemplate] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [protocolView, setProtocolView] = useState<PersonProtocolView | null>(null);
  const [protocolLoading, setProtocolLoading] = useState(false);
  const vaultSession = getVaultSession();

  const shezhireLine = useMemo(
    () => formatShezhireAffiliation(store.meta?.zhuz, store.meta?.clanName),
    [store.meta?.zhuz, store.meta?.clanName]
  );

  function closeMoreMenu() {
    if (moreRef.current) moreRef.current.open = false;
  }

  function confirmReplaceDraft(action: string) {
    const count = Object.keys(store.draft.persons).length;
    if (count === 0) return true;
    return window.confirm(t.workspace.replaceDraft(count, action));
  }

  useEffect(() => {
    if (!saveDraftTree(store)) {
      setToast({ message: t.quota });
    }
  }, [store]);

  useEffect(() => {
    saveGuide(guide);
  }, [guide]);

  useEffect(() => {
    const id = pickDefaultFocus(store.draft, focusId ?? guide.selfId);
    setFocusId(id);
    if (!selectedId && id) setSelectedId(id);
  }, [store.draft, guide.selfId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!selectedId || !profileOpen) return;
    const mq = window.matchMedia("(max-width: 900px)");
    if (!mq.matches) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [selectedId, profileOpen]);

  useEffect(() => {
    if (!selectedId || !profileOpen) {
      setProtocolView(null);
      setProtocolLoading(false);
      return;
    }
    let cancelled = false;
    setProtocolLoading(true);
    const timer = window.setTimeout(() => {
      void queryPersonFromDraft(store, selectedId)
        .then((view) => {
          if (!cancelled) setProtocolView(view);
        })
        .catch(() => {
          if (!cancelled) setProtocolView(null);
        })
        .finally(() => {
          if (!cancelled) setProtocolLoading(false);
        });
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selectedId, profileOpen, store]);

  const people = activePersons(store.draft);
  const selected = selectedId ? store.draft.persons[selectedId] ?? null : null;
  const homeFocusId = pickHomeFocus(store.draft, guide.selfId);

  const relatives = useMemo(() => {
    if (!selected) return [];
    const list: { id: string; name: string; kind: "father" | "mother" | "child" }[] = [];
    const { fatherId, motherId } = splitParents(store.draft, selected.id);
    if (fatherId) list.push({ id: fatherId, name: store.draft.persons[fatherId].name, kind: "father" });
    if (motherId) list.push({ id: motherId, name: store.draft.persons[motherId].name, kind: "mother" });
    for (const p of people) {
      if (p.parents.includes(selected.id)) {
        list.push({ id: p.id, name: p.name, kind: "child" });
      }
    }
    return list;
  }, [selected, store.draft, people]);

  function persist(next: TreeStore) {
    onStoreChange(next);
  }

  function flash(message: string, undo?: () => void, actionLabel?: string) {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ message, undo, actionLabel });
    toastTimer.current = window.setTimeout(() => setToast(null), undo ? 7000 : 3200);
  }

  function openProfile(id: string) {
    setSelectedId(id);
    setProfileOpen(true);
    const showAncestors = Boolean(focusId && id !== focusId);
    if (showAncestors) {
      try {
        const key = "sejire.hint.ancestors.v1";
        if (!sessionStorage.getItem(key)) {
          sessionStorage.setItem(key, "1");
          setAncestorsHint(true);
          window.setTimeout(() => setAncestorsHint(false), 4000);
        }
      } catch {
        /* ignore */
      }
    }
  }

  function closeProfile() {
    panelRef.current?.flush();
    setProfileOpen(false);
    setSelectedId(null);
    setAncestorsHint(false);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // PublishSeedModal / VaultVersionsModal handle their own Escape (seed-safe).
      if (showPublish || showVersions) return;
      if (pending) {
        setPending(null);
        return;
      }
      if (profileOpen) {
        closeProfile();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showPublish, showVersions, pending, profileOpen]);

  const onPersonChange = useCallback(
    (person: Person) => {
      onStoreChange((prev) => setDraftPerson(prev, person));
    },
    [onStoreChange]
  );

  function completeAdd(data: AddPersonPayload) {
    if (!pending) return;
    const id = uid();
    const person: Person = {
      id,
      name: data.name,
      sex: data.sex ?? "U",
      born: data.born || null,
      died: data.died || null,
      birthPlace: data.birthPlace.trim() || null,
      deathPlace: data.deathPlace.trim() || null,
      burialDate: data.burialDate || null,
      burialPlace: data.burialPlace.trim() || null,
      occupation: data.occupation.trim() || null,
      maidenName: data.maidenName.trim() || null,
      parents: [],
      media: [],
      notes: data.notes.trim() || "",
      tombstone: false,
    };

    let next = store;
    let nextGuide = { ...guide };

    if (pending.type === "self") {
      next = setDraftPerson(store, person);
      nextGuide = { ...guide, selfId: id, step: "mother" };
      setFocusId(id);
      setSelectedId(id);
      setProfileOpen(false);
      flash(t.workspace.flashAddParents);
    } else if (pending.type === "parent") {
      person.sex = pending.role === "father" ? "M" : "F";
      next = setDraftPerson(store, person);
      const child = next.draft.persons[pending.childId];
      if (child) {
        const parents = [...child.parents];
        if (!parents.includes(id)) {
          if (pending.role === "mother") parents.unshift(id);
          else parents.push(id);
        }
        next = setDraftPerson(next, { ...child, parents });
      }
      if (pending.role === "mother") nextGuide.motherId = id;
      if (pending.role === "father") nextGuide.fatherId = id;
      setSelectedId(id);
      setProfileOpen(true);
      flash(pending.role === "mother" ? t.workspace.flashMotherAdded : t.workspace.flashFatherAdded);
    }

    persist(next);
    onGuideChange(nextGuide);
    setPending(null);
  }

  function openPublish() {
    if (!people.length) {
      flash(t.workspace.flashNeedPerson);
      return;
    }
    let next = store;
    if (store.dirty) {
      next = commitDraft(store, t.workspace.commitBeforeSave);
      persist(next);
    }
    void mirrorStoreToProtocol(next).catch(() => {
      /* локальное зеркало не должно ломать сохранение сейфа */
    });
    setPublishStore(next);
    setShowPublish(true);
  }

  function setFocus(id: string) {
    panelRef.current?.flush();
    setFocusId(id);
    setSelectedId(id);
    setProfileOpen(false);
    setAncestorsHint(false);
    const name = store.draft.persons[id]?.name;
    flash(name ? t.workspace.flashFocus(name) : t.workspace.flashReflow);
  }

  async function exportClassicPdf() {
    const id = pickPdfRootId({ selectedId: selectedId, focusId, homeId: homeFocusId });
    if (!id || !people.length) {
      flash(t.workspace.flashNeedPerson);
      return;
    }
    try {
      const { downloadClassicTreePdf } = await import("../lib/pdf/classicTreePdf");
      const paper = await downloadClassicTreePdf({
        snapshot: store.draft,
        focusId: id,
        meta: store.meta,
        locale: pdfLocale,
      });
      flash(t.workspace.flashPdfTree(paper));
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  function openShezhirePdfPicker() {
    const id = pickPdfRootId({ selectedId: selectedId, focusId, homeId: homeFocusId });
    if (!id || !people.length) {
      flash(t.workspace.flashNeedPerson);
      return;
    }
    setShowShezhireTemplate(true);
  }

  async function exportShezhirePdf(template: ShezhireTemplateId) {
    const id = pickPdfRootId({ selectedId: selectedId, focusId, homeId: homeFocusId });
    if (!id || !people.length) {
      flash(t.workspace.flashNeedPerson);
      return;
    }
    setShowShezhireTemplate(false);
    try {
      const { downloadShezhirePdf } = await import("../lib/pdf/shezhirePdf");
      await downloadShezhirePdf({
        snapshot: store.draft,
        startId: id,
        meta: store.meta,
        locale: pdfLocale,
        maxGenerations: SHEZHIRE_MAX_GENERATIONS,
        template,
      });
      flash(t.workspace.flashPdfShezhire);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  function exportJson() {
    try {
      downloadTreeJson(store, guide);
      flash(t.workspace.flashJson);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  function applyVaultVersion(vault: VaultV1) {
    const treeId = vault.active_tree_id;
    const next = coerceTreeStore(treeId ? vault.trees[treeId] : Object.values(vault.trees)[0]);
    if (!next) {
      flash(t.workspace.flashNoTrees);
      return;
    }
    if (!confirmReplaceDraft(t.workspace.replaceOpenVersion)) return;
    const selfId = pickHomeFocus(next.draft, null);
    const nextGuide = { ...defaultGuide(), step: "done" as const, selfId };
    if (!saveDraftTree(next)) flash(t.quota);
    saveGuide(nextGuide);
    onStoreChange(next);
    onGuideChange(nextGuide);
    setFocusId(selfId);
    setSelectedId(selfId);
    setProfileOpen(false);
    setShowVersions(false);
    flash(t.workspace.flashVersionOpened(vaultPersonCount(vault)));
  }

  function goHome() {
    clearVaultSession();
    onHome();
  }

  async function importJsonFile(file: File | null) {
    if (!file) return;
    if (!confirmReplaceDraft(t.workspace.replaceJson)) return;
    const result = await readTreeJsonFile(file);
    if (!result.ok) {
      flash(result.error);
      return;
    }
    if (!saveDraftTree(result.store)) flash(t.quota);
    saveGuide(result.guide);
    onStoreChange(result.store);
    onGuideChange(result.guide);
    setFocusId(pickHomeFocus(result.store.draft, result.guide.selfId));
    setSelectedId(result.guide.selfId ?? pickDefaultFocus(result.store.draft, null));
    setProfileOpen(false);
    flash(t.workspace.flashImported(Object.keys(result.store.draft.persons).length));
  }

  const modalTitle =
    pending?.type === "self"
      ? t.workspace.addSelf
      : pending?.type === "parent"
        ? pending.role === "mother"
          ? t.workspace.addMother
          : t.workspace.addFather
        : "";

  return (
    <div className="app-frame">
      <header className="app-topbar">
        <div className="brand">
          <span className="brand-glyph" aria-hidden />
          <div>
            <strong>SEJIRE</strong>
            {shezhireLine ? (
              <button
                type="button"
                className="tree-shezhire is-set"
                onClick={() => setShowShezhireMeta(true)}
                title={t.workspace.zhuzRuTitle}
              >
                {shezhireLine}
              </button>
            ) : null}
          </div>
        </div>
        <nav className="top-actions">
          <LanguageSwitch placement="chrome" />
          <button type="button" className="btn" onClick={openPublish}>
            {t.workspace.save}
          </button>
          <details className="top-more" ref={moreRef}>
            <summary className="btn ghost" aria-label={t.workspace.moreMenu}>
              ⋯
            </summary>
            <div className="top-more-menu" role="menu">
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  closeMoreMenu();
                  setShowShezhireMeta(true);
                }}
                title={t.workspace.zhuzRuTitle}
              >
                {t.workspace.zhuzRu}
              </button>
              {people.length >= 1 && (
                <>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => {
                      closeMoreMenu();
                      void exportClassicPdf();
                    }}
                  >
                    {t.workspace.pdfTree}
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => {
                      closeMoreMenu();
                      openShezhirePdfPicker();
                    }}
                  >
                    {t.workspace.pdfShezhire}
                  </button>
                </>
              )}
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  closeMoreMenu();
                  exportJson();
                }}
                title={t.workspace.exportJsonTitle}
              >
                {t.workspace.exportJson}
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  closeMoreMenu();
                  jsonInputRef.current?.click();
                }}
                title={t.workspace.importJsonTitle}
              >
                {t.workspace.importJson}
              </button>
              {vaultSession?.vaultId ? (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    closeMoreMenu();
                    setShowVersions(true);
                  }}
                  title={t.workspace.versionsTitle}
                >
                  {t.workspace.versions}
                </button>
              ) : null}
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  closeMoreMenu();
                  goHome();
                }}
              >
                {t.workspace.home}
              </button>
            </div>
          </details>
          <input
            ref={jsonInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              void importJsonFile(file);
              e.target.value = "";
            }}
          />
        </nav>
      </header>

      {toast && (
        <div className="toast" role="status">
          <span>{toast.message}</span>
          {toast.undo ? (
            <button
              type="button"
              className="toast-undo"
              onClick={() => {
                toast.undo?.();
                setToast(null);
              }}
            >
              {toast.actionLabel ?? t.undo}
            </button>
          ) : null}
        </div>
      )}

      <div className={`workspace-main${profileOpen && selected ? " has-panel" : ""}`}>
        <PedigreeView
          snapshot={store.draft}
          focusId={focusId}
          homeFocusId={homeFocusId}
          selectedId={selectedId}
          onSelect={openProfile}
          onSetFocus={setFocus}
          onEmptyStart={() => setPending({ type: "self" })}
          onAddRelative={(slot: AddMeSlot) =>
            setPending({ type: "parent", childId: slot.childId, role: slot.role })
          }
        />

        {selected && profileOpen ? (
          <button
            type="button"
            className="person-sheet-backdrop"
            aria-label={t.workspace.closeProfile}
            onClick={closeProfile}
          />
        ) : null}

        <PersonPanel
          ref={panelRef}
          person={selected}
          relatives={relatives}
          protocolView={protocolView}
          protocolLoading={protocolLoading}
          open={profileOpen}
          hasFather={Boolean(selected && relatives.some((r) => r.kind === "father"))}
          hasMother={Boolean(selected && relatives.some((r) => r.kind === "mother"))}
          highlightAncestors={ancestorsHint}
          onClose={closeProfile}
          onChange={onPersonChange}
          showFocusAncestors={Boolean(selected && focusId && selected.id !== focusId)}
          onFocusAncestors={() => {
            if (!selected) return;
            setAncestorsHint(false);
            setFocus(selected.id);
          }}
          onSelectRelative={(id) => openProfile(id)}
          onDelete={() => {
            if (!selected) return;
            const removedId = selected.id;
            const removedName = selected.name;
            const wasFocus = focusId === removedId;
            const afterRemove = removeDraftPerson(store, removedId);
            persist(afterRemove);
            setSelectedId(null);
            setProfileOpen(false);
            if (wasFocus) {
              setFocusId(pickDefaultFocus(afterRemove.draft, homeFocusId));
            }
            flash(t.workspace.flashRemoved(removedName), () => {
              const restored = restoreDraftPerson(afterRemove, removedId);
              persist(restored);
              setSelectedId(removedId);
              setProfileOpen(true);
              if (wasFocus) setFocusId(removedId);
              flash(t.workspace.flashRestored);
            });
          }}
          onAdd={(role) => {
            if (!selected) return;
            setPending({ type: "parent", childId: selected.id, role });
          }}
        />
      </div>

      {pending && (
        <AddPersonModal
          title={modalTitle}
          defaultSex={
            pending.type === "parent" ? (pending.role === "mother" ? "F" : "M") : "U"
          }
          askSex={pending.type === "self"}
          onCancel={() => setPending(null)}
          onSave={completeAdd}
        />
      )}

      {showPublish && publishStore && (
        <PublishSeedModal
          store={publishStore}
          parentTxId={getVaultSession()?.headTxId ?? null}
          knownMnemonic={getSessionMnemonic()}
          onClose={() => {
            setShowPublish(false);
            setPublishStore(null);
          }}
          onPublished={({ mode, txId, mock, isNewVersion }) => {
            setShowPublish(false);
            setPublishStore(null);
            const ver = isNewVersion ? t.workspace.publishedNewVersion : "";
            const short = txId?.slice(0, 10) ?? "";
            const shorter = txId?.slice(0, 8) ?? "";
            if (mode === "solana" || mode === "solana-test") {
              flash(mode === "solana" ? solanaMessages[locale].success : solanaMessages[locale].testSuccess);
            } else if (mode === "demo") {
              flash(t.workspace.publishedDemo(short, ver));
            } else if (mode === "sponsor") {
              flash(
                mock
                  ? t.workspace.publishedSponsorMock(short, ver)
                  : t.workspace.publishedForever(shorter, ver)
              );
            } else if (mode === "arweave") {
              flash(t.workspace.publishedArweave(shorter, ver));
            } else {
              flash(t.workspace.publishedFile(short, ver));
            }
          }}
        />
      )}

      {showVersions && (
        <VaultVersionsModal
          onClose={() => setShowVersions(false)}
          onOpenVersion={applyVaultVersion}
        />
      )}

      {showShezhireTemplate && (
        <ShezhireTemplateModal
          onClose={() => setShowShezhireTemplate(false)}
          onPick={(template) => void exportShezhirePdf(template)}
        />
      )}

      {showShezhireMeta && (
        <ShezhireMetaModal
          meta={store.meta}
          onClose={() => setShowShezhireMeta(false)}
          onSave={({ zhuz, clanName }) => {
            onStoreChange((prev) => ({
              ...prev,
              dirty: true,
              meta: {
                ...prev.meta,
                zhuz,
                clanName,
              },
            }));
            setShowShezhireMeta(false);
            flash(zhuz || clanName ? t.workspace.flashZhuzSaved : t.workspace.flashZhuzCleared);
          }}
        />
      )}
    </div>
  );
}
