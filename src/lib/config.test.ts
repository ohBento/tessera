import { describe, expect, it } from "vitest";
import config from "../../src-tauri/tauri.conf.json";
import capabilities from "../../src-tauri/capabilities/default.json";
import { releasePage } from "./update";

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

  /* Opening a link needs the command *and* a URL in scope, and the two are
   * separate grants. `opener:allow-open-url` on its own reads like it is
   * enough — its own description says "enables the open_url command without any
   * pre-configured scope" — but the plugin ends its check on
   * `self.allowed.iter().any(...)`, which is false for an empty allow list, so
   * every call came back ForbiddenUrl.
   *
   * Same shape of failure as the missing `ask` above, and it survived two
   * releases for the same reason: outside Tauri openUrl is a no-op, so every
   * test and every browser probe passed while the shipped app did nothing when
   * the link was pressed. Reported from 0.13.0 by hand. */
  it("puts the release page inside the opener's scope, not just the command", () => {
    type Scoped = { identifier: string; allow: { url?: string; path?: string }[] };
    const patterns = (capabilities.permissions as (string | Scoped)[])
      .filter((p): p is Scoped => typeof p === "object" && p.identifier === "opener:allow-open-url")
      .flatMap((p) => p.allow.map((a) => a.url))
      .filter((u): u is string => !!u);
    expect(patterns.length).toBeGreaterThan(0);
    // The plugin matches UNIX glob, so the pattern is checked against the one
    // URL this app actually opens rather than compared as text.
    const covers = (pattern: string) =>
      new RegExp(
        `^${pattern
          .split("*")
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      ).test(releasePage);
    expect(patterns.some(covers)).toBe(true);
  });
});
