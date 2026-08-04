import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMAGE_SCALE,
  DEFAULT_SHAPE_SIZE,
  DEFAULT_TEXT_SIZE,
  effectiveTile,
  emptyManifest,
  emptyTile,
  findLayer,
  findList,
  isDetached,
  layerLabel,
  layerText,
  migrate,
  nestingShift,
  newGroupLayer,
  newImageLayer,
  newShapeLayer,
  newTextLayer,
  removeLayerFrom,
  resetTransform,
  resolveLayers,
  walkLayers,
  type Layer,
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
    layer.blend = "multiply";

    resetTransform(layer);

    expect(layer.rotation).toBe(0);
    expect(layer.opacity).toBe(1);
    expect(layer.scale).toBe(DEFAULT_IMAGE_SCALE);
    expect(layer.flipX).toBe(false);
    // Untouched on purpose — a reset that also discards effects or moves the
    // layer back to centre would be a bigger surprise than the fix it offers.
    expect(layer.x).toBe(0.1);
    expect(layer.y).toBe(0.9);
    expect(layer.blend).toBe("multiply");
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

describe("group traversal", () => {
  const nested = () => {
    const deep = { ...newShapeLayer("rect"), id: "deep" };
    const inner = { ...newGroupLayer([deep]), id: "inner" };
    const top = { ...newTextLayer(), id: "top" };
    return { deep, inner, top, layers: [top, inner] };
  };

  it("walks parents before their children, at any depth", () => {
    const { layers } = nested();
    expect([...walkLayers(layers)].map((l) => l.id)).toEqual(["top", "inner", "deep"]);
  });

  it("finds a layer buried in a group", () => {
    const { layers, deep } = nested();
    expect(findLayer(layers, "deep")).toBe(deep);
    expect(findLayer(layers, "nope")).toBeUndefined();
  });

  it("returns the array a layer actually sits in, not the root", () => {
    const { layers, inner } = nested();
    expect(findList(layers, "deep")).toBe(inner.children);
    expect(findList(layers, "top")).toBe(layers);
    expect(findList(layers, "nope")).toBeUndefined();
  });

  it("deleting a group keeps its members, at the group's own index", () => {
    const { layers } = nested();
    removeLayerFrom(layers, "inner");
    expect(layers.map((l) => l.id)).toEqual(["top", "deep"]);
  });

  it("deleting a plain layer removes just that layer", () => {
    const { layers } = nested();
    removeLayerFrom(layers, "top");
    expect(layers.map((l) => l.id)).toEqual(["inner"]);
  });

  it("members keep their rendered position when a displaced group dissolves", () => {
    // A group's x/y displaces its children on top of their own coordinates, so
    // dissolving it has to fold that displacement into them — otherwise every
    // member jumps back by the group's offset the moment the group is gone.
    const child = { ...newShapeLayer("rect"), id: "child", x: 0.4, y: 0.7 };
    const group = { ...newGroupLayer([child]), id: "grp", x: 0.65, y: 0.3 };
    const layers: Layer[] = [group];

    removeLayerFrom(layers, "grp");

    expect(layers.map((l) => l.id)).toEqual(["child"]);
    expect(layers[0].x).toBeCloseTo(0.4 + 0.15, 10); // 0.65 - 0.5
    expect(layers[0].y).toBeCloseTo(0.7 - 0.2, 10); // 0.30 - 0.5
  });

  it("leaves members untouched when the group sits at the neutral position", () => {
    const child = { ...newShapeLayer("rect"), id: "child", x: 0.4, y: 0.7 };
    const layers: Layer[] = [{ ...newGroupLayer([child]), id: "grp" }];
    removeLayerFrom(layers, "grp");
    expect(layers[0].x).toBeCloseTo(0.4, 10);
    expect(layers[0].y).toBeCloseTo(0.7, 10);
  });
});

describe("nestingShift", () => {
  it("is undefined for a layer that is not in any group", () => {
    const layers: Layer[] = [{ ...newShapeLayer("rect"), id: "loose" }];
    expect(nestingShift(layers, "loose")).toBeUndefined();
  });

  it("reports the enclosing group's displacement", () => {
    const child = { ...newShapeLayer("rect"), id: "child" };
    const layers: Layer[] = [{ ...newGroupLayer([child]), id: "grp", x: 0.65, y: 0.3 }];
    const shift = nestingShift(layers, "child")!;
    expect(shift.dx).toBeCloseTo(0.15, 10);
    expect(shift.dy).toBeCloseTo(-0.2, 10);
  });

  it("accumulates through nested groups", () => {
    const child = { ...newShapeLayer("rect"), id: "child" };
    const inner = { ...newGroupLayer([child]), id: "inner", x: 0.6, y: 0.5 };
    const outer = { ...newGroupLayer([inner]), id: "outer", x: 0.7, y: 0.4 };
    const shift = nestingShift([outer], "child")!;
    expect(shift.dx).toBeCloseTo(0.1 + 0.2, 10);
    expect(shift.dy).toBeCloseTo(0 - 0.1, 10);
  });
});

describe("newTextLayer", () => {
  it("defaults to a plain word, so clearing the field cannot strand a placeholder", () => {
    expect(newTextLayer().text).toBe("Text");
  });
});
