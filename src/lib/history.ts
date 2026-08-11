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

/** A state, and the name of the edit at its boundary.
 *
 *  The label belongs to the edit that *replaced* this state, which is what
 *  makes one string serve both directions: popping it off `past` undoes that
 *  edit, and the entry pushed onto `future` in its place redoes the same one. */
export type Step<T> = { state: T; label: string };

export type History<T> = {
  past: Step<T>[];
  future: Step<T>[];
  /** What the run in progress is for — see `checkpoint`. */
  runKey?: string;
};

/* runKey is spelled out rather than left to appear on first write: the editor
 * wraps this in a Svelte $state proxy, and a field that is not there when the
 * proxy is built does not reliably survive one. */
export const emptyHistory = <T>(): History<T> => ({
  past: [],
  future: [],
  runKey: undefined,
});

/** How far back undo reaches. Beyond this the oldest step is dropped. */
export const LIMIT = 200;

/** Records the state about to be replaced. Call before mutating, with a
 *  snapshot that will not be mutated afterwards — storing a live reference
 *  would let later edits rewrite history in place.
 *
 *  `key` collapses a run of edits of the same kind into one step: while the
 *  same key keeps arriving, the checkpoint taken at the start of the run is
 *  the one that stays, because that is the state a user means to go back to.
 *  Without it, typing a caption cost one undo step per character — thirty
 *  presses to take back one word, and thirty of the two hundred steps gone.
 *  Edits with no key never collapse.
 *
 *  A run ends when a different key arrives, at an undo or redo, or when
 *  `endRun` is called — never on a clock. It used to expire after 700ms, and
 *  the reason that had to go is that a wall clock does not know what a gesture
 *  is: two complete drags in quick succession were merged into one step, so a
 *  single undo jumped back past both, while the same two drags done slowly
 *  cost two. Editors that get this right have the code that knows where the
 *  gesture ends say so, which is what `endRun` is for. It also made the
 *  behaviour untestable without faking time, and one measurement of mine was
 *  wrong by a factor of twenty-five because a background tab throttles
 *  timers. */
/** Returns whether it pushed a step, which a caller that has to take its own
 *  checkpoint back needs to know: inside an open run there is nothing of its
 *  own on the stack, and undoing anyway pops the step before it — an edit that
 *  threw mid-drag quietly destroyed an unrelated one. */
export function checkpoint<T>(h: History<T>, present: T, label: string, key?: string): boolean {
  const sameRun = key !== undefined && h.runKey === key;
  h.runKey = key;
  /* The first edit of a run names the step. A run is one gesture — a slider
   * dragged, a caption typed — so its later edits are the same action
   * continuing, and taking the newest name would leave the step called after
   * the last keystroke rather than after the thing you did. */
  if (sameRun) return false;

  h.past.push({ state: present, label });
  if (h.past.length > LIMIT) h.past.shift();
  // A new edit invalidates anything that was undone: the timeline forked.
  h.future.length = 0;
  return true;
}

/** Closes the run in progress, so the next edit starts a new step whatever key
 *  it carries. What a pointer release, a committed field or a finished gesture
 *  calls.
 *
 *  Travelling calls it too. Without that, typing after an undo would collapse
 *  into the step just taken back, and the next undo would jump two edits. */
export const endRun = (h: History<unknown>) => {
  h.runKey = undefined;
};

/** The step to go back to, or undefined at the start of history. */
export function undo<T>(h: History<T>, present: T): Step<T> | undefined {
  const step = h.past.pop();
  if (!step) return undefined;
  endRun(h);
  // Same label the other way round: what this takes back is what a redo puts
  // back, so the two entries name one edit rather than two.
  h.future.push({ state: present, label: step.label });
  return step;
}

/** The step to go forward to, or undefined if nothing was undone. */
export function redo<T>(h: History<T>, present: T): Step<T> | undefined {
  const step = h.future.pop();
  if (!step) return undefined;
  endRun(h);
  h.past.push({ state: present, label: step.label });
  return step;
}

export const canUndo = (h: History<unknown>) => h.past.length > 0;
export const canRedo = (h: History<unknown>) => h.future.length > 0;

/** What the next press would take back, or put back — "" for neither.
 *
 *  So a button can say what it is about to do *before* it is pressed. Ctrl+Z on
 *  a wall of forty-four portraits is otherwise a guess, and the guess is only
 *  checked by making it. */
export const nextUndo = (h: History<unknown>) => h.past.at(-1)?.label ?? "";
export const nextRedo = (h: History<unknown>) => h.future.at(-1)?.label ?? "";
