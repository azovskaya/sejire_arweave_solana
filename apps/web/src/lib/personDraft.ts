import type { Person } from "./types";

/** Capture the exact editable values, including spaces and partial dates.
 * A flush also runs when opening a reloaded, untouched profile; it must not
 * normalize another field. DateTextInput owns its explicit blur conversion.
 * Relationships and media always come from the current tree, not the panel.
 */
export function buildPersonDraft(base: Person, draft: Person): Person {
  return {
    ...base,
    ...draft,
    id: base.id,
    parents: base.parents,
    media: base.media ?? [],
    tombstone: base.tombstone ?? false,
  };
}
