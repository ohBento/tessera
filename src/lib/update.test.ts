import { describe, expect, it, vi } from "vitest";
import { isNewer, latestRelease } from "./update";

describe("latestRelease", () => {
  it("asks nobody outside the shipped application", async () => {
    /* The browser build reports "0.0.0-browser", which every tag beats, so an
     * unguarded check would announce an update on the dev server and in every
     * mounted test — and reach across the network to do it. A suite that asks
     * GitHub is a suite that fails on a train. */
    const fetched = vi.spyOn(globalThis, "fetch");
    try {
      expect(await latestRelease()).toBe("");
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      fetched.mockRestore();
    }
  });
});

describe("isNewer", () => {
  it("compares numerically, not as text", () => {
    expect(isNewer("0.10.0", "0.9.0")).toBe(true); // "0.10" < "0.9" as strings
    expect(isNewer("0.9.0", "0.10.0")).toBe(false);
  });

  it("ignores a leading v", () => {
    expect(isNewer("v1.1.0", "1.0.0")).toBe(true);
  });

  it("treats missing fields as zero", () => {
    expect(isNewer("1.2.1", "1.2")).toBe(true);
    expect(isNewer("1.2", "1.2.0")).toBe(false);
  });

  it("is false for the same version", () => {
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
  });
});
