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

/** Takes the newest step off without offering it as a redo.
 *
 *  What an edit that threw calls. Its checkpoint records a state that was
 *  never actually left, so `undo` is the wrong tool even though it pops the
 *  same entry: undo *moves* the step to the redo stack, and the redo it then
 *  offers is to put back an edit that never happened. Invisible while the only
 *  witness was a Redo button quietly going live; plain as day once a list
 *  showed the step sitting there, named, above the line. */
export function discard(h: History<unknown>): void {
  h.past.pop();
  endRun(h);
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

/** One edit as a list can show it: what it was called, how far it is from
 *  where you are standing, and whether it is currently in force.
 *
 *  `delta` is what to hand `jump` to get there — negative back, positive
 *  forward — so a row carries its own destination and the list needs no index
 *  arithmetic of its own. */
export type Moment = { label: string; delta: number; done: boolean };

/** Every edit still remembered, newest first, with `now` falling between the
 *  last undone one and the first that is still in force.
 *
 *  Newest first because every other list in this app is: the layers, the
 *  stamps, the projects. An undo list that ran the other way would be the one
 *  place where the top of the list is the oldest thing. */
export function timeline(h: History<unknown>): Moment[] {
  const out: Moment[] = [];
  /* Undone, furthest-forward first. `future` is a stack whose top is the next
   * redo, so walking it from the bottom gives the order they would come back
   * in, reversed — which is the same as newest first. */
  for (let i = 0; i < h.future.length; i++) {
    out.push({ label: h.future[i].label, delta: h.future.length - i, done: false });
  }
  /* In force, newest first. A step's label names the edit that replaced the
   * state it holds, so past[n-1] is the most recent thing you did. */
  for (let i = h.past.length - 1; i >= 0; i--) {
    out.push({ label: h.past[i].label, delta: i - h.past.length, done: true });
  }
  return out;
}

/** Moves `delta` steps at once — negative back, positive forward — and hands
 *  back where it landed, or undefined if it could not move at all.
 *
 *  One call rather than a loop at the call site, because every intermediate
 *  state is a state nobody asked to see: undoing eight steps one at a time
 *  redraws the wall eight times and writes the file eight times, and a caller
 *  that forgot to suppress that made "go back to before I started" cost eight
 *  saves. What the loop here changes is only the stacks; the caller applies
 *  the destination once.
 *
 *  Stops early rather than throwing if the stack runs out. The list a user
 *  clicks is drawn from these same stacks, so asking for more than exists
 *  means the two disagreed — and landing at the end is a better answer to that
 *  than an exception in the middle of a mutation. */
export function jump<T>(h: History<T>, present: T, delta: number): Step<T> | undefined {
  const move = delta < 0 ? undo : redo;
  let landed: Step<T> | undefined;
  let state = present;
  for (let i = 0; i < Math.abs(delta); i++) {
    const next = move(h, state);
    if (!next) break;
    landed = next;
    state = next.state;
  }
  return landed;
}
