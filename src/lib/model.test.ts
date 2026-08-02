import { describe, expect, it } from "vitest";
import {
  effectiveTile,
  emptyManifest,
  emptyTile,
  isDetached,
  layerText,
  migrate,
  newTextLayer,
  resolveLayers,
  type Manifest,
  type TextLayer,
} from "./model";

const withShared = (): Manifest => {
  const m = emptyManifest();
  const shared = { ...newTextLayer(), id: "s1", text: "shared" };
  m.shared = [shared];
  m.order = ["a", "b"];
  m.tiles = { a: emptyTile(), b: emptyTile() };
  return m;
};

describe("resolveLayers", () => {
  it("puts shared layers on every tile", () => {
    const m = withShared();
    expect(resolveLayers(m, "a").map((l) => l.id)).toEqual(["s1"]);
    expect(resolveLayers(m, "b").map((l) => l.id)).toEqual(["s1"]);
  });

  it("lets a detached copy replace the shared one on that tile only", () => {
    const m = withShared();
    m.tiles.a.layers.push({ ...(m.shared[0] as TextLayer), text: "local" });

    expect((resolveLayers(m, "a")[0] as TextLayer).text).toBe("local");
    expect((resolveLayers(m, "b")[0] as TextLayer).text).toBe("shared");
    expect(resolveLayers(m, "a")).toHaveLength(1); // replaced, not added
    expect(isDetached(m, "a", "s1")).toBe(true);
    expect(isDetached(m, "b", "s1")).toBe(false);
  });

  it("keeps tile-only layers on top of shared ones", () => {
    const m = withShared();
    m.tiles.a.layers.push({ ...newTextLayer(), id: "own" });
    expect(resolveLayers(m, "a").map((l) => l.id)).toEqual(["s1", "own"]);
  });
});

describe("effectiveTile", () => {
  it("changes for every tile when a shared layer changes", () => {
    const m = withShared();
    const before = JSON.stringify(effectiveTile(m, "b"));
    (m.shared[0] as TextLayer).color = "#ff0000";
    expect(JSON.stringify(effectiveTile(m, "b"))).not.toBe(before);
  });
});

describe("layerText", () => {
  const layer = { ...newTextLayer(), id: "s1", text: "{{id}}" };

  it("expands the tile id", () => {
    expect(layerText({}, layer, "40000000004743219")).toBe("40000000004743219");
  });

  it("prefers the per-tile override, so style syncs but wording does not", () => {
    expect(layerText({ s1: "Ranger" }, layer, "40000000004743219")).toBe("Ranger");
  });
});

describe("migrate", () => {
  it("lifts a v1 manifest into the layered model", () => {
    const v1 = {
      version: 1,
      order: ["a"],
      tiles: { a: { asset: "x.png", crop: { x: 0, y: 0, w: 10, h: 10 } } },
    };
    const m = migrate(v1);
    expect(m.version).toBe(2);
    expect(m.order).toEqual(["a"]);
    expect(m.tiles.a.base).toEqual({ asset: "x.png", crop: { x: 0, y: 0, w: 10, h: 10 } });
    expect(m.tiles.a.layers).toEqual([]);
    expect(m.shared).toEqual([]);
  });

  it("survives a null tile and unreadable input", () => {
    expect(migrate({ version: 1, order: ["a"], tiles: { a: null } }).tiles.a.base).toBeNull();
    expect(migrate(null).version).toBe(2);
  });
});
