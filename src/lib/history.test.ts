import { describe, expect, it } from "vitest";

import { LIMIT, canRedo, canUndo, checkpoint, emptyHistory, redo, undo, type History } from "./history";

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
