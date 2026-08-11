/* What every list in the sidebar needs and none of them owns.
 *
 * Three lists draw rows — the tiles, the projects, the layers of an open
 * Layout — and they share two things that cannot live in any one of them: the
 * set of rows that are open, because it is one accordion across all of them,
 * and the drag in progress, because only one row is ever being carried and a
 * second copy of that state would let two lists disagree about it.
 *
 * Module state rather than props, following editor.svelte.ts: a component that
 * needs this imports it, the way it imports `app`. Passing it down instead
 * would mean every list carrying the drag through its interface whether or not
 * it drags anything.
 *
 * The styling half of the same story is rows.css. */
import type { Layer } from "./model";

/* --- Which rows are open ------------------------------------------------ */

/** Every open row and section, by id — one set for the whole sidebar.
 *
 *  Projects starts open: it is the way into a wall, and a first run that shows
 *  a collapsed heading and nothing else looks like an app that failed to load
 *  its folder. Everything else earns its twisty by being long. */
const START = () => new Set<string>(["projects"]);
export const rows = $state({ open: START() });

/* Reassigned rather than mutated in place: a Set is not deeply reactive, so
 * adding to one nobody replaced leaves every twisty pointing the old way. */
const replace = () => (rows.open = new Set(rows.open));

export const isOpen = (id: string) => rows.open.has(id);

export const toggleOpen = (id: string) => {
  rows.open.has(id) ? rows.open.delete(id) : rows.open.add(id);
  replace();
};

/** Whatever was just made has to be visible. Projects and Layouts are hidden
 *  with CSS rather than dropped from the markup, so their "+" sits outside the
 *  hidden list and stays pressable while the section is shut — and the new row
 *  landed somewhere the eye could not follow. Snapshots and Folders drop their
 *  whole block, "+" included, so this does not arise there. */
export const reveal = (id: string) => {
  rows.open.add(id);
  replace();
};

/** Opens one tile row and shuts whichever was open before.
 *
 *  An accordion only for tile rows — drawers and the section heads share the
 *  same set and stay independent of each other. A row carries the wording
 *  fields and the picture gallery now, so two of them open at once is a list
 *  you have to scroll past to reach the next id. */
export function toggleTileRow(id: string, siblings: string[]) {
  const wasOpen = rows.open.has(id);
  for (const tile of siblings) rows.open.delete(tile);
  if (!wasOpen) rows.open.add(id);
  replace();
}

/* --- Dragging rows to reorder -------------------------------------------
 *
 * Native HTML drag-and-drop rather than pointer bookkeeping: it is what the
 * browser already knows how to do, and Tauri's own OS-level file drop is
 * switched off (tauri.conf.json) precisely so this keeps working.
 *
 * A row is a source, and it is a target in three places: the top third drops
 * in front of it, the bottom third behind it, and — on a group — the middle
 * third drops inside. That is the whole vocabulary; anything more needs a
 * mode. --- */

export type Where = "before" | "after" | "into";

export const drag = $state({
  /** The layer row being carried, "" for none. */
  id: "",
  /** The row it is over and which third of it, or null. */
  on: null as { id: string; where: Where } | null,
  /** The shelved tile being carried onto the wall, "" for none. Separate from
   *  `id`, which carries layer rows: the two land in different places and
   *  sharing one field would let a layer drop reorder the grid. */
  tile: "",
});

/** Which third of the row the pointer is in. "into" only where it means
 *  something, so a plain row never offers a target that cannot take it. */
export function zone(e: DragEvent, canHold: boolean): Where {
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const t = (e.clientY - box.top) / box.height;
  if (canHold && t > 0.3 && t < 0.7) return "into";
  return t < 0.5 ? "before" : "after";
}

export const startDrag = (e: DragEvent, id: string) => {
  drag.id = id;
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
};

export function over(e: DragEvent, id: string, canHold: boolean) {
  if (!drag.id || drag.id === id) return;
  e.preventDefault();
  const where = zone(e, canHold);
  if (drag.on?.id !== id || drag.on.where !== where) drag.on = { id, where };
}

export const endDrag = () => {
  drag.id = "";
  drag.on = null;
};

/** Where a drop lands, expressed as the model wants it: the row to go in front
 *  of, and the group to go inside. `after` becomes "in front of the next
 *  sibling", or the end of the list. */
export function landing(rowList: Layer[], id: string, where: Where, parentId: string | null) {
  if (where === "into") return { parentId: id, beforeId: null };
  /* `rowList` is drawn topmost-first; the model stores bottom-first, so the two
   * run in opposite directions. Dropping *above* a row means landing after it
   * in the model — which is "in front of" whatever the row above it is, or the
   * end of the list when there is nothing above. Dropping *below* it means
   * landing in front of that row itself. */
  const at = rowList.findIndex((l) => l.id === id);
  // The list the anchor lives in is where the layer lands, so a drop between
  // two children stays inside their group instead of escaping to the top.
  return { parentId, beforeId: where === "before" ? (rowList[at - 1]?.id ?? null) : id };
}

/** Back to a freshly-opened sidebar.
 *
 *  Module state outlives an unmount, the same way `app` does — and a second
 *  mount that inherits the first one's open rows is a test finding a list it
 *  never opened, or not finding one it did. The initial values are spelled
 *  once, here, so a reset cannot drift from a start. */
export function resetRows() {
  rows.open = START();
  drag.id = "";
  drag.on = null;
  drag.tile = "";
}

/* --- Editing a row's name ----------------------------------------------- */

/** Autofocus drops the caret at the end of the suggested name, so the first
 *  thing typed was appended to it — "+ Snapshot" opens its field on
 *  "Snapshot 1" and a user typing a name got "Snapshot 1Before changes", which
 *  then stayed as the snapshot's name. Selecting on focus makes typing
 *  replace, the way a rename field behaves everywhere else. */
export const selectAll = (e: FocusEvent & { currentTarget: HTMLInputElement }) =>
  e.currentTarget.select();

/* Enter and Escape both blur; Escape puts the old text back first, and the
   rename actions already ignore an unchanged name — so cancelling needs no
   flag of its own. */
export function renameKey(e: KeyboardEvent, was: string) {
  const input = e.currentTarget as HTMLInputElement;
  if (e.key === "Escape") input.value = was;
  else if (e.key !== "Enter") return;
  input.blur();
  e.stopPropagation();
}
