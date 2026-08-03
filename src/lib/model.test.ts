import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMAGE_SCALE,
  DEFAULT_SHAPE_SIZE,
  DEFAULT_TEXT_SIZE,
  effectiveTile,
  emptyManifest,
  emptyTile,
  isDetached,
  layerLabel,
  layerText,
  migrate,
  newImageLayer,
  newShapeLayer,
  newTextLayer,
  resetTransform,
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

describe("resetTransform", () => {
  it("resets rotation, opacity and size but leaves position and effects alone", () => {
    const layer = newImageLayer("x.png");
    layer.x = 0.1;
    layer.y = 0.9;
    layer.rotation = 45;
    layer.opacity = 0.4;
    layer.scale = 1.5;
    layer.flipX = true;
    layer.filter = "blur(2px)";

    resetTransform(layer);

    expect(layer.rotation).toBe(0);
    expect(layer.opacity).toBe(1);
    expect(layer.scale).toBe(DEFAULT_IMAGE_SCALE);
    expect(layer.flipX).toBe(false);
    // Untouched on purpose — a reset that also discards effects or moves the
    // layer back to centre would be a bigger surprise than the fix it offers.
    expect(layer.x).toBe(0.1);
    expect(layer.y).toBe(0.9);
    expect(layer.filter).toBe("blur(2px)");
  });

  it("resets text size the same way", () => {
    const layer = newTextLayer();
    layer.size = 0.3;
    resetTransform(layer);
    expect(layer.size).toBe(DEFAULT_TEXT_SIZE);
  });

  it("resets a shape's width and height, not just one dimension", () => {
    const layer = newShapeLayer("rect");
    layer.w = 0.9;
    layer.h = 0.1;
    resetTransform(layer);
    expect(layer.w).toBe(DEFAULT_SHAPE_SIZE);
    expect(layer.h).toBe(DEFAULT_SHAPE_SIZE);
  });
});

describe("newShapeLayer", () => {
  it("defaults to a square, uncoloured border and solid white fill", () => {
    const layer = newShapeLayer("polygon");
    expect(layer.shape).toBe("polygon");
    expect(layer.w).toBe(layer.h);
    expect(layer.cornerRadius).toBe(0);
    expect(layer.sides).toBe(6);
    expect(layer.borderWidth).toBe(0);
  });
});

describe("layerLabel for shapes", () => {
  it("falls back to the shape kind when unnamed", () => {
    expect(layerLabel(newShapeLayer("ellipse"))).toBe("ellipse");
  });

  it("prefers an explicit name", () => {
    const layer = newShapeLayer("rect");
    layer.name = "Frame";
    expect(layerLabel(layer)).toBe("Frame");
  });
});
