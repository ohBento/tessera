import { describe, expect, it } from "vitest";
import config from "../../src-tauri/tauri.conf.json";
import capabilities from "../../src-tauri/capabilities/default.json";

describe("window config", () => {
  /* Tauri's own schema: "Disabling it is required to use HTML5 drag and drop on
   * the frontend on Windows." Left at its default of true, the OS drag handler
   * swallows every dragstart/drop in the grid and reordering silently does
   * nothing. Guarded here because the symptom points nowhere near this file. */
  it("keeps OS drag-drop off so the grid can be reordered", () => {
    expect(config.app.windows[0].dragDropEnabled).toBe(false);
  });
});

describe("capabilities", () => {
  /* Every dialog command the app calls has to be granted here, or Tauri denies
   * it at runtime and the call rejects.
   *
   * `ask` was missing, and the shape of that failure is why it survived so
   * long: it is only reached when there is something to lose — deleting a
   * group that holds stamps, or a layout that is stamped somewhere — and the
   * caller awaited it inside a condition, so a rejection aborted the whole
   * action before the delete. The button did nothing, silently. Outside Tauri
   * `ask` falls back to window.confirm, so every test and every browser probe
   * passed while the packaged app was broken. */
  const granted = new Set(
    capabilities.permissions.filter((p): p is string => typeof p === "string"),
  );

  it.each(["dialog:allow-ask", "dialog:allow-open"])("grants %s", (permission) => {
    expect(granted.has(permission)).toBe(true);
  });
});
