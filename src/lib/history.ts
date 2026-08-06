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

export type History<T> = {
  past: T[];
  future: T[];
  /** What the last checkpoint was for, and when — see `checkpoint`. */
  runKey?: string;
  runAt?: number;
};

/* runKey and runAt are spelled out rather than left to appear on first write:
 * the editor wraps this in a Svelte $state proxy, and a field that is not
 * there when the proxy is built does not reliably survive one. */
export const emptyHistory = <T>(): History<T> => ({
  past: [],
  future: [],
  runKey: undefined,
  runAt: 0,
});

/** How far back undo reaches. Beyond this the oldest step is dropped. */
export const LIMIT = 200;

/** How long a run of same-kind edits keeps collapsing into one step. Long
 *  enough to cover typing at speed and a slider being dragged, short enough
 *  that going back to a field after a pause starts a fresh step. */
export const RUN_MS = 700;

/** Records the state about to be replaced. Call before mutating, with a
 *  snapshot that will not be mutated afterwards — storing a live reference
 *  would let later edits rewrite history in place.
 *
 *  `key` collapses a run of edits of the same kind into one step: while the
 *  same key keeps arriving without a pause, the checkpoint taken at the start
 *  of the run is the one that stays, because that is the state a user means
 *  to go back to. Without it, typing a caption cost one undo step per
 *  character — thirty presses to take back one word, and thirty of the two
 *  hundred steps gone. Edits with no key never collapse. */
export function checkpoint<T>(h: History<T>, present: T, key?: string, now = Date.now()) {
  const sameRun = key !== undefined && h.runKey === key && now - (h.runAt ?? 0) < RUN_MS;
  h.runKey = key;
  h.runAt = now;
  if (sameRun) return;

  h.past.push(present);
  if (h.past.length > LIMIT) h.past.shift();
  // A new edit invalidates anything that was undone: the timeline forked.
  h.future.length = 0;
}

/* Travelling ends whatever run was in progress. Without this, typing after an
 * undo would collapse into the step just taken back, and the next undo would
 * jump two edits at once. */
const endRun = (h: History<unknown>) => {
  h.runKey = undefined;
  h.runAt = undefined;
};

/** The state to go back to, or undefined at the start of history. */
export function undo<T>(h: History<T>, present: T): T | undefined {
  if (!h.past.length) return undefined;
  endRun(h);
  h.future.push(present);
  return h.past.pop();
}

/** The state to go forward to, or undefined if nothing was undone. */
export function redo<T>(h: History<T>, present: T): T | undefined {
  if (!h.future.length) return undefined;
  endRun(h);
  h.past.push(present);
  return h.future.pop();
}

export const canUndo = (h: History<unknown>) => h.past.length > 0;
export const canRedo = (h: History<unknown>) => h.future.length > 0;
