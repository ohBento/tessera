/* A real DOM, because iconArt parses the markup with DOMParser.
 *
 * The failure this guards is silent. The artwork is pulled in by a Vite glob
 * and parsed at first use, so a moved folder, a renamed pattern or a file the
 * parser cannot read produces no error anywhere — the class is simply not in
 * the picker, and nothing goes red. Everything below would. */
import { describe, expect, it } from "vitest";

import { ICON_NAMES, PLACEHOLDER_ICON, iconArt } from "./icons";

describe("the class icons that ship with the application", () => {
  it("finds them all, and puts the placeholder first", () => {
    // The set the game has, plus the mark for "not decided yet".
    expect(ICON_NAMES.length).toBeGreaterThan(30);
    expect(ICON_NAMES[0]).toBe(PLACEHOLDER_ICON);
    // Sorted after that, so the picker reads like a list rather than a folder.
    const classes = ICON_NAMES.slice(1);
    expect(classes).toEqual([...classes].sort((a, b) => a.localeCompare(b)));
  });

  it("names them by class, not by file", () => {
    for (const name of ICON_NAMES) {
      expect(name).not.toMatch(/\.svg$/i);
      expect(name).not.toMatch(/^Class Icon/i);
      expect(name.trim()).toBe(name);
    }
    // A two-word class keeps its space — the picker shows it, the layer name
    // strips it. Both were wrong once in the same afternoon.
    expect(ICON_NAMES).toContain("Dark Knight");
  });

  it("draws every one of them", () => {
    for (const name of ICON_NAMES) {
      const art = iconArt(name);
      expect(art, `${name} has no artwork`).not.toBeNull();
      expect(art!.paths.length, `${name} has no paths`).toBeGreaterThan(0);
      // A box to fit into. Zero here divides by itself in iconShape and puts
      // the icon on screen at its raw 1024px, which is how a stencil blew up
      // over a whole tile once already.
      expect(art!.w).toBeGreaterThan(0);
      expect(art!.h).toBeGreaterThan(0);
      for (const p of art!.paths) expect(p.d.length).toBeGreaterThan(0);
    }
  });

  it("answers null for a class it does not have", () => {
    // Rather than throwing: a manifest can name a class this build never had,
    // and a Layout that fails to open is worse than an icon that does not draw.
    expect(iconArt("Not A Class")).toBeNull();
    expect(iconArt("")).toBeNull();
  });
});
