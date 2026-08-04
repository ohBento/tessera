/* Undo as whole-document snapshots.
 *
 * A command pattern was deliberately not used: every edit would need a matching
 * inverse, and an inverse that is subtly wrong corrupts the document in a way
 * that only shows up several steps later. A manifest is around 20 KB of JSON,
 * so 200 of them is a few megabytes of memory in exchange for an undo that
 * cannot be wrong.
 *
 * Nothing here knows what a manifest is, which is what keeps it testable
 * without a filesystem, a canvas or a browser. */

export type History<T> = { past: T[]; future: T[] };

export const emptyHistory = <T>(): History<T> => ({ past: [], future: [] });

/** How far back undo reaches. Beyond this the oldest step is dropped. */
export const LIMIT = 200;

/** Records the state about to be replaced. Call before mutating, with a
 *  snapshot that will not be mutated afterwards — storing a live reference
 *  would let later edits rewrite history in place. */
export function checkpoint<T>(h: History<T>, present: T) {
  h.past.push(present);
  if (h.past.length > LIMIT) h.past.shift();
  // A new edit invalidates anything that was undone: the timeline forked.
  h.future.length = 0;
}

/** The state to go back to, or undefined at the start of history. */
export function undo<T>(h: History<T>, present: T): T | undefined {
  if (!h.past.length) return undefined;
  h.future.push(present);
  return h.past.pop();
}

/** The state to go forward to, or undefined if nothing was undone. */
export function redo<T>(h: History<T>, present: T): T | undefined {
  if (!h.future.length) return undefined;
  h.past.push(present);
  return h.future.pop();
}

export const canUndo = (h: History<unknown>) => h.past.length > 0;
export const canRedo = (h: History<unknown>) => h.future.length > 0;
