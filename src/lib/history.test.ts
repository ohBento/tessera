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
  checkpoint(h, present);
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

    now = undo(h, now)!;
    expect(now).toBe("b");
    now = undo(h, now)!;
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

    now = undo(h, now)!;
    now = undo(h, now)!;
    expect(now).toBe("a");

    now = redo(h, now)!;
    expect(now).toBe("b");
    now = redo(h, now)!;
    expect(now).toBe("c");
    expect(redo(h, now)).toBeUndefined();
  });

  it("is discarded by a new edit, because the timeline forked", () => {
    const h = emptyHistory<string>();
    let now = apply(h, "a", "b");
    now = undo(h, now)!;
    expect(canRedo(h)).toBe(true);

    now = apply(h, now, "different");
    expect(canRedo(h)).toBe(false);
    expect(redo(h, now)).toBeUndefined();
    // Undo still reaches the state before that new edit.
    expect(undo(h, now)).toBe("a");
  });
});

describe("runs of same-kind edits collapse into one step", () => {
  /** Typing five characters: five edits, all of the same field. */
  const typeFive = (h: History<string>) => {
    for (const [i, s] of ["T", "Te", "Tes", "Test", "Test!"].entries()) {
      checkpoint(h, i === 0 ? "" : s.slice(0, -1), "field:a:text");
    }
  };

  it("keeps only the state from before the run started", () => {
    const h = emptyHistory<string>();
    typeFive(h);
    expect(h.past).toEqual([""]);
    // One press takes back the whole word, not one letter.
    expect(undo(h, "Test!")).toBe("");
  });

  it("starts a new step once the run is closed", () => {
    const h = emptyHistory<string>();
    checkpoint(h, "a", "field:a:text");
    checkpoint(h, "b", "field:a:text");
    expect(h.past).toEqual(["a"]);

    /* The whole point of dropping the clock: two runs of the same kind are two
     * steps because something said the first one was over — a slider released,
     * a field left, a gesture finished — not because enough time passed. Time
     * cannot tell a fast second gesture from a slow single one. */
    endRun(h);
    checkpoint(h, "c", "field:a:text");
    expect(h.past).toEqual(["a", "c"]);
  });

  it("starts a new step when a different field is touched", () => {
    const h = emptyHistory<string>();
    checkpoint(h, "a", "field:a:text");
    checkpoint(h, "b", "field:a:size");
    expect(h.past).toEqual(["a", "b"]);
  });

  it("never collapses an edit that gave no key", () => {
    const h = emptyHistory<string>();
    checkpoint(h, "a", undefined);
    checkpoint(h, "b", undefined);
    expect(h.past).toEqual(["a", "b"]);
  });

  it("keeps collapsing however long the user takes", () => {
    const h = emptyHistory<string>();
    checkpoint(h, "a", "field:a:size");
    // A slider held still mid-drag, then moved again, is one edit. Under the
    // old clock this became two steps and one undo left it half-dragged.
    checkpoint(h, "b", "field:a:size");
    checkpoint(h, "c", "field:a:size");
    expect(h.past).toEqual(["a"]);
  });

  it("ends the run at an undo, so typing after it is its own step", () => {
    const h = emptyHistory<string>();
    typeFive(h);
    expect(undo(h, "Test!")).toBe("");
    expect(h.past).toEqual([]);

    // Same field and same key — but the run ended at the undo, so this records
    // a step instead of vanishing into the one just taken back.
    checkpoint(h, "", "field:a:text");
    expect(h.past).toEqual([""]);
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
    expect(h.past[0]).toBe(50);
  });
});

describe("snapshots", () => {
  it("keeps whatever object it was handed, so callers must pass a copy", () => {
    // Documents the contract the editor relies on: it deep-copies before
    // checkpointing. If it passed the live manifest, later edits would mutate
    // the recorded step and undo would restore the present.
    const h = emptyHistory<{ n: number }>();
    const live = { n: 1 };
    checkpoint(h, live);
    live.n = 2;
    expect(h.past[0].n).toBe(2);
  });
});
