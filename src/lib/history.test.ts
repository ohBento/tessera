import { describe, expect, it } from "vitest";

import {
  LIMIT,
  canRedo,
  canUndo,
  checkpoint,
  emptyHistory,
  endRun,
  redo,
  undo,
  type History,
} from "./history";

/** Drives the stack the way the editor does: checkpoint the old value, then
 *  replace it. Returns whatever is "on screen" after the run. */
function apply<T>(h: History<T>, present: T, next: T) {
  checkpoint(h, present, "Edit");
  return next;
}

describe("undo", () => {
  it("returns nothing at the start of history", () => {
    expect(undo(emptyHistory<string>(), "a")).toBeUndefined();
    expect(canUndo(emptyHistory())).toBe(false);
  });

  it("walks back one step at a time, in order", () => {
    const h = emptyHistory<string>();
    let now = apply(h, "a", "b");
    now = apply(h, now, "c");

    now = undo(h, now)!.state;
    expect(now).toBe("b");
    now = undo(h, now)!.state;
    expect(now).toBe("a");
    expect(undo(h, now)).toBeUndefined();
  });
});

describe("redo", () => {
  it("returns nothing until something has been undone", () => {
    const h = emptyHistory<string>();
    const now = apply(h, "a", "b");
    expect(canRedo(h)).toBe(false);
    expect(redo(h, now)).toBeUndefined();
  });

  it("retraces exactly the steps that were undone", () => {
    const h = emptyHistory<string>();
    let now = apply(h, "a", "b");
    now = apply(h, now, "c");

    now = undo(h, now)!.state;
    now = undo(h, now)!.state;
    expect(now).toBe("a");

    now = redo(h, now)!.state;
    expect(now).toBe("b");
    now = redo(h, now)!.state;
    expect(now).toBe("c");
    expect(redo(h, now)).toBeUndefined();
  });

  it("is discarded by a new edit, because the timeline forked", () => {
    const h = emptyHistory<string>();
    let now = apply(h, "a", "b");
    now = undo(h, now)!.state;
    expect(canRedo(h)).toBe(true);

    now = apply(h, now, "different");
    expect(canRedo(h)).toBe(false);
    expect(redo(h, now)).toBeUndefined();
    // Undo still reaches the state before that new edit.
    expect(undo(h, now)!.state).toBe("a");
  });
});

describe("runs of same-kind edits collapse into one step", () => {
  /** Typing five characters: five edits, all of the same field. */
  const typeFive = (h: History<string>) => {
    for (const [i, s] of ["T", "Te", "Tes", "Test", "Test!"].entries()) {
      checkpoint(h, i === 0 ? "" : s.slice(0, -1), "Type caption", "field:a:text");
    }
  };

  it("keeps only the state from before the run started", () => {
    const h = emptyHistory<string>();
    typeFive(h);
    expect(h.past.map((s) => s.state)).toEqual([""]);
    // One press takes back the whole word, not one letter.
    expect(undo(h, "Test!")!.state).toBe("");
  });

  it("starts a new step once the run is closed", () => {
    const h = emptyHistory<string>();
    checkpoint(h, "a", "Edit", "field:a:text");
    checkpoint(h, "b", "Edit", "field:a:text");
    expect(h.past.map((s) => s.state)).toEqual(["a"]);

    /* The whole point of dropping the clock: two runs of the same kind are two
     * steps because something said the first one was over — a slider released,
     * a field left, a gesture finished — not because enough time passed. Time
     * cannot tell a fast second gesture from a slow single one. */
    endRun(h);
    checkpoint(h, "c", "Edit", "field:a:text");
    expect(h.past.map((s) => s.state)).toEqual(["a", "c"]);
  });

  it("keeps the name the run opened with", () => {
    /* A run is one gesture, so its later edits are that action continuing. Take
     * the newest name and the step ends up called after the last keystroke
     * rather than after the thing you did — and with the collapsing above, one
     * press then takes back a word under the name of its final letter. */
    const h = emptyHistory<string>();
    checkpoint(h, "a", "Type caption", "field:a:text");
    checkpoint(h, "b", "Change size", "field:a:text");
    expect(h.past.map((s) => s.label)).toEqual(["Type caption"]);
  });

  it("starts a new step when a different field is touched", () => {
    const h = emptyHistory<string>();
    checkpoint(h, "a", "Edit", "field:a:text");
    checkpoint(h, "b", "Edit", "field:a:size");
    expect(h.past.map((s) => s.state)).toEqual(["a", "b"]);
  });

  it("never collapses an edit that gave no key", () => {
    const h = emptyHistory<string>();
    checkpoint(h, "a", "Edit", undefined);
    checkpoint(h, "b", "Edit", undefined);
    expect(h.past.map((s) => s.state)).toEqual(["a", "b"]);
  });

  it("keeps collapsing however long the user takes", () => {
    const h = emptyHistory<string>();
    checkpoint(h, "a", "Edit", "field:a:size");
    // A slider held still mid-drag, then moved again, is one edit. Under the
    // old clock this became two steps and one undo left it half-dragged.
    checkpoint(h, "b", "Edit", "field:a:size");
    checkpoint(h, "c", "Edit", "field:a:size");
    expect(h.past.map((s) => s.state)).toEqual(["a"]);
  });

  it("ends the run at an undo, so typing after it is its own step", () => {
    const h = emptyHistory<string>();
    typeFive(h);
    expect(undo(h, "Test!")!.state).toBe("");
    expect(h.past).toEqual([]);

    // Same field and same key — but the run ended at the undo, so this records
    // a step instead of vanishing into the one just taken back.
    checkpoint(h, "", "Edit", "field:a:text");
    expect(h.past.map((s) => s.state)).toEqual([""]);
    // And the forked future is dropped, as any new edit does.
    expect(h.future).toEqual([]);
  });
});

describe("limit", () => {
  it("drops the oldest step rather than growing without bound", () => {
    const h = emptyHistory<number>();
    let now = 0;
    for (let i = 1; i <= LIMIT + 50; i++) now = apply(h, now, i);

    expect(h.past).toHaveLength(LIMIT);
    // The reachable floor has moved up by exactly the number dropped.
    expect(h.past[0].state).toBe(50);
  });
});

describe("taking a checkpoint back", () => {
  it("says whether it pushed one, so a failed edit undoes only its own", () => {
    /* An edit that throws puts the recorded state back and takes its own
     * checkpoint off the stack. Inside an open run there is none of its own:
     * the second and later events of a slider drag or a typed caption collapse
     * into the step the run opened with. Undoing regardless popped the step
     * belonging to the edit *before* the drag — one unrelated undo destroyed,
     * silently, by a failure somewhere else. */
    const h = emptyHistory<string>();
    expect(checkpoint(h, "A", "Edit")).toBe(true);
    expect(checkpoint(h, "B", "Edit", "field:x")).toBe(true);
    // Same run: the step to go back to is still the one it opened with.
    expect(checkpoint(h, "B2", "Edit", "field:x")).toBe(false);
    expect(h.past.map((s) => s.state)).toEqual(["A", "B"]);
  });
});

describe("snapshots", () => {
  it("keeps whatever object it was handed, so callers must pass a copy", () => {
    // Documents the contract the editor relies on: it deep-copies before
    // checkpointing. If it passed the live manifest, later edits would mutate
    // the recorded step and undo would restore the present.
    const h = emptyHistory<{ n: number }>();
    const live = { n: 1 };
    checkpoint(h, live, "Edit");
    live.n = 2;
    expect(h.past[0].state.n).toBe(2);
  });
});
