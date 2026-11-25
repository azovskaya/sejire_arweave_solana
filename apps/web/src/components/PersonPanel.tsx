import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import type { Person } from "../lib/types";
import { lifespan } from "../lib/pedigree";
import { buildPersonDraft } from "../lib/personDraft";
import {
  protocolViewHasKin,
  type PersonProtocolView,
} from "../lib/ao/protocolKinship";
import { DateTextInput } from "./DateTextInput";
import { useI18n } from "../lib/i18n/I18nProvider";
import type { KinshipCode } from "../lib/kinship";

export type PersonPanelHandle = {
  flush: () => void;
};

type Props = {
  person: Person | null;
  relatives: { id: string; name: string; kind: "father" | "mother" | "child" }[];
  open?: boolean;
  hasFather?: boolean;
  hasMother?: boolean;
  highlightAncestors?: boolean;
  onClose: () => void;
  onChange: (person: Person) => void;
  onAdd: (role: "father" | "mother") => void;
  onSelectRelative: (id: string) => void;
  onDelete: () => void;
  onFocusAncestors?: () => void;
  showFocusAncestors?: boolean;
  protocolView?: PersonProtocolView | null;
  protocolLoading?: boolean;
};

function emptyPerson(): Person {
  return {
    id: "",
    name: "",
    sex: "U",
    born: null,
    died: null,
    birthPlace: null,
    deathPlace: null,
    burialDate: null,
    burialPlace: null,
    occupation: null,
    maidenName: null,
    parents: [],
    media: [],
    notes: "",
  };
}

function sameProfile(a: Person, b: Person) {
  return (
    a.name === b.name &&
    a.sex === b.sex &&
    a.maidenName === b.maidenName &&
    a.born === b.born &&
    a.died === b.died &&
    a.birthPlace === b.birthPlace &&
    a.deathPlace === b.deathPlace &&
    a.burialDate === b.burialDate &&
    a.burialPlace === b.burialPlace &&
    a.occupation === b.occupation &&
    (a.notes ?? "") === (b.notes ?? "")
  );
}

export const PersonPanel = forwardRef<PersonPanelHandle, Props>(function PersonPanel(
  {
  person,
  relatives,
  open = false,
  hasFather = false,
  hasMother = false,
  highlightAncestors = false,
  onClose,
  onChange,
  onAdd,
  onSelectRelative,
  onDelete,
  onFocusAncestors,
  showFocusAncestors = false,
  protocolView = null,
  protocolLoading = false,
}: Props,
  ref
) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Person>(person ?? emptyPerson());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const sheetRef = useRef<HTMLElement | null>(null);
  const draftRef = useRef(draft);
  const personRef = useRef(person);

  draftRef.current = draft;
  personRef.current = person;

  useEffect(() => {
    const next = person ?? emptyPerson();
    draftRef.current = next;
    setDraft(next);
    setConfirmDelete(false);
  }, [person]);

  useEffect(() => {
    if (!person) return;
    const el = sheetRef.current;
    if (!el) return;
    el.scrollTop = 0;
  }, [person?.id]);

  useEffect(() => {
    const el = sheetRef.current;
    if (!el || !open) return;
    function onFocusIn(e: Event) {
      const t = e.target as HTMLElement | null;
      if (!t || !t.matches("input, textarea, select")) return;
      window.setTimeout(() => {
        t.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 50);
    }
    el.addEventListener("focusin", onFocusIn);
    return () => el.removeEventListener("focusin", onFocusIn);
  }, [open, person]);

  function flushNow() {
    const base = personRef.current;
    const d = draftRef.current;
    if (!base) return;
    const next = buildPersonDraft(base, d);
    // Raw input is already durable, including a temporarily empty name. Do
    // not discard other fields merely because the user is still typing it.
    if (!sameProfile(base, next)) onChange(next);
  }

  useImperativeHandle(ref, () => ({ flush: flushNow }));

  function handleClose() {
    flushNow();
    onClose();
  }

  if (!person) {
    return (
      <aside className="person-panel is-empty" aria-hidden="true">
        <p>{t.person.empty}</p>
      </aside>
    );
  }

  function setField<K extends keyof Person>(key: K, value: Person[K]) {
    const base = personRef.current;
    if (!base) return;
    const next = buildPersonDraft(base, { ...draftRef.current, [key]: value });
    draftRef.current = next;
    setDraft(next);
    // Commit in the input event, before a pagehide/reload can cancel effects
    // or timers. A later flush must preserve these same raw spaces/partial dates.
    onChange(next);
  }

  const panelClass = open ? "person-panel is-open" : "person-panel is-docked";

  return (
    <aside
      ref={sheetRef}
      className={panelClass}
      role="dialog"
      aria-modal={open ? "true" : undefined}
      aria-label={t.person.profile(draft.name || t.person.unnamed)}
    >
      <div className="person-sheet-handle" aria-hidden />
      <header className="person-panel-head">
        <div className="person-panel-head-text">
          <h2 className="clamp-2">{draft.name || t.person.unnamed}</h2>
          <p className="sub mono">
            {lifespan(draft, { born: t.pedigree.bornAbbr, died: t.pedigree.diedAbbr }) ||
              t.person.noDates}
          </p>
        </div>
        <button type="button" className="tool-btn" onClick={handleClose} aria-label={t.person.close}>
          ×
        </button>
      </header>

      {showFocusAncestors && onFocusAncestors ? (
        <div
          className={`panel-section person-panel-focus-actions${
            highlightAncestors ? " is-hint" : ""
          }`}
        >
          <button type="button" className="btn ghost" onClick={onFocusAncestors}>
            {t.person.showAncestors}
          </button>
        </div>
      ) : null}

      <div className="person-panel-form">
        <section className="field-block">
          <label>
            {t.person.name}
            <input
              value={draft.name}
              onChange={(e) => setField("name", e.target.value)}
              onBlur={flushNow}
            />
          </label>
          <label>
            {t.person.sex}
            <select
              value={draft.sex ?? "U"}
              onChange={(e) => setField("sex", e.target.value as Person["sex"])}
            >
              <option value="U">{t.person.sexUnknown}</option>
              <option value="F">{t.person.sexF}</option>
              <option value="M">{t.person.sexM}</option>
            </select>
          </label>
        </section>

        <section className="field-block">
          <h3>{t.person.birth}</h3>
          <label>
            {t.person.date}
            <DateTextInput
              value={draft.born ?? ""}
              onChange={(v) => setField("born", v || null)}
              placeholder={t.datePh}
              aria-label={t.person.birthDateAria}
            />
          </label>
          <label>
            {t.person.place}
            <input
              value={draft.birthPlace ?? ""}
              onChange={(e) => setField("birthPlace", e.target.value || null)}
              placeholder={t.person.placePh}
            />
          </label>
        </section>

        <section className="field-block">
          <h3>{t.person.death}</h3>
          <label>
            {t.person.date}
            <DateTextInput
              value={draft.died ?? ""}
              onChange={(v) => setField("died", v || null)}
              placeholder={t.datePh}
              aria-label={t.person.deathDateAria}
            />
          </label>
          <label>
            {t.person.place}
            <input
              value={draft.deathPlace ?? ""}
              onChange={(e) => setField("deathPlace", e.target.value || null)}
              placeholder={t.person.placePh}
            />
          </label>
        </section>

        <section className="field-block">
          <h3>{t.person.notes}</h3>
          <label>
            <textarea
              rows={3}
              value={draft.notes ?? ""}
              onChange={(e) => setField("notes", e.target.value)}
              placeholder={t.person.notesPh}
            />
          </label>
        </section>

        <details className="field-block more-fields">
          <summary>{t.person.moreFacts}</summary>
          <label>
            {t.person.maiden}
            <input
              value={draft.maidenName ?? ""}
              onChange={(e) => setField("maidenName", e.target.value || null)}
              placeholder={t.person.maidenPh}
            />
          </label>
          <label>
            {t.person.occupation}
            <input
              value={draft.occupation ?? ""}
              onChange={(e) => setField("occupation", e.target.value || null)}
            />
          </label>
          <label>
            {t.person.burialDate}
            <DateTextInput
              value={draft.burialDate ?? ""}
              onChange={(v) => setField("burialDate", v || null)}
              placeholder={t.datePh}
              aria-label={t.person.burialDateAria}
            />
          </label>
          <label>
            {t.person.burialPlace}
            <input
              value={draft.burialPlace ?? ""}
              onChange={(e) => setField("burialPlace", e.target.value || null)}
              placeholder={t.person.burialPlacePh}
            />
          </label>
        </details>
      </div>

      <div className="panel-section">
        <h3>{t.person.relatives}</h3>
        <div className="rel-actions">
          {!hasFather ? (
            <button type="button" className="btn ghost" onClick={() => onAdd("father")}>
              {t.person.addFather}
            </button>
          ) : null}
          {!hasMother ? (
            <button type="button" className="btn ghost" onClick={() => onAdd("mother")}>
              {t.person.addMother}
            </button>
          ) : null}
        </div>
        {relatives.length > 0 && (
          <ul className="rel-list">
            {relatives.map((r) => (
              <li key={`${r.kind}-${r.id}`}>
                <span>{t.relation[r.kind]}</span>
                <button type="button" className="rel-link clamp-1" onClick={() => onSelectRelative(r.id)}>
                  {r.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {protocolLoading || protocolViewHasKin(protocolView) ? (
        <div className="panel-section protocol-kinship">
          <h3>{t.person.protocol}</h3>
          <p className="hint">{t.person.protocolHint}</p>
          {protocolLoading ? <p className="hint">{t.person.protocolLoading}</p> : null}
          {protocolViewHasKin(protocolView) && protocolView ? (
            <>
              {protocolView.jetiAta.some((x) => x.generation > 0) ? (
                <div>
                  <h4>{t.person.jetiAta}</h4>
                  <ol className="jeti-line">
                    {protocolView.jetiAta.map((row) => (
                      <li key={`jeti-${row.id}`}>
                        {row.generation === 0 ? (
                          <span>{row.name || row.id}</span>
                        ) : (
                          <button
                            type="button"
                            className="rel-link clamp-1"
                            onClick={() => onSelectRelative(row.id)}
                          >
                            {row.name || row.id}
                          </button>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
              {protocolView.ancestors.some((x) => x.distance > 0) ? (
                <div>
                  <h4>{t.person.ancestors}</h4>
                  <ul className="rel-list">
                    {protocolView.ancestors
                      .filter((row) => row.distance > 0)
                      .map((row) => (
                        <li key={`anc-${row.id}`}>
                          <span>{t.person.knee(row.distance)}</span>
                          <button
                            type="button"
                            className="rel-link clamp-1"
                            onClick={() => onSelectRelative(row.id)}
                          >
                            {row.name}
                          </button>
                        </li>
                      ))}
                  </ul>
                </div>
              ) : null}
              {protocolView.relatives.length > 0 ? (
                <div>
                  <h4>{t.person.relate}</h4>
                  <ul className="rel-list">
                    {protocolView.relatives.map((r) => (
                      <li key={`proto-${r.code}-${r.id}`}>
                        <span>{t.kinship[r.code as KinshipCode] ?? r.label}</span>
                        <button
                          type="button"
                          className="rel-link clamp-1"
                          onClick={() => onSelectRelative(r.id)}
                        >
                          {r.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <div className="panel-section delete-zone">
        {!confirmDelete ? (
          <button type="button" className="btn ghost danger-text" onClick={() => setConfirmDelete(true)}>
            {t.person.delete}
          </button>
        ) : (
          <div className="delete-confirm">
            <p>
              {t.person.deleteConfirm(
                draft.name ? `«${draft.name}»` : t.person.thisPerson
              )}
            </p>
            <div className="actions">
              <button type="button" className="btn ghost" onClick={() => setConfirmDelete(false)}>
                {t.cancel}
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  setConfirmDelete(false);
                  flushNow();
                  onDelete();
                }}
              >
                {t.person.delete}
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
});
