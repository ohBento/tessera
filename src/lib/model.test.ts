import { describe, expect, it } from "vitest";
import {
  assignExactly,
  coveredTiles,
  DEFAULT_IMAGE_SCALE,
  DEFAULT_SHAPE_SIZE,
  DEFAULT_TEXT_SIZE,
  effectiveTile,
  emptyManifest,
  emptyTile,
  findLayer,
  findList,
  instanceCount,
  isDetached,
  layerLabel,
  layerText,
  migrate,
  nestingShift,
  newGroupLayer,
  newImageLayer,
  newOverlay,
  newShapeLayer,
  newTextLayer,
  overlayCovering,
  overlayOf,
  removeLayerFrom,
  setAssigned,
  resetTransform,
  resolveLayers,
  walkLayers,
  type Layer,
  type Manifest,
  type TextLayer,
} from "./model";

/** Three tiles and one overlay covering all of them — the v2 "shared" case,
 *  which v3 expresses as an overlay whose tile set is everything. */
const withOverlay = (tiles: string[] | "all" = "all"): Manifest => {
  const m = emptyManifest();
  m.order = ["a", "b", "c"];
  m.tiles = { a: emptyTile(), b: emptyTile(), c: emptyTile() };
  m.overlays = [{ ...newOverlay("Alle", tiles), layers: [{ ...newTextLayer(), id: "s1", text: "shared" }] }];
  return m;
};

const overlayLayer = (m: Manifest) => m.overlays[0].layers[0] as TextLayer;

describe("resolveLayers", () => {
  it("puts an all-tiles overlay on every tile", () => {
    const m = withOverlay();
    for (const id of m.order) expect(resolveLayers(m, id).map((l) => l.id)).toEqual(["s1"]);
  });

  it("puts a subset overlay only on the tiles it names", () => {
    const m = withOverlay(["a", "c"]);
    expect(resolveLayers(m, "a").map((l) => l.id)).toEqual(["s1"]);
    expect(resolveLayers(m, "b")).toEqual([]);
    expect(resolveLayers(m, "c").map((l) => l.id)).toEqual(["s1"]);
  });

  it("stacks several overlays in their own order", () => {
    const m = withOverlay();
    m.overlays.push({ ...newOverlay("Obendrauf", ["b"]), layers: [{ ...newTextLayer(), id: "t2" }] });
    expect(resolveLayers(m, "a").map((l) => l.id)).toEqual(["s1"]);
    expect(resolveLayers(m, "b").map((l) => l.id)).toEqual(["s1", "t2"]);
  });

  it("lets a detached copy replace the overlay's layer on that tile only", () => {
    const m = withOverlay();
    m.tiles.a.layers.push({ ...overlayLayer(m), text: "local" });

    expect((resolveLayers(m, "a")[0] as TextLayer).text).toBe("local");
    expect((resolveLayers(m, "b")[0] as TextLayer).text).toBe("shared");
    expect(resolveLayers(m, "a")).toHaveLength(1); // replaced, not added
    expect(isDetached(m, "a", "s1")).toBe(true);
    expect(isDetached(m, "b", "s1")).toBe(false);
  });

  it("does not count a detached copy on a tile the overlay never covered", () => {
    const m = withOverlay(["a"]);
    m.tiles.b.layers.push({ ...overlayLayer(m), text: "orphan" });
    expect(isDetached(m, "b", "s1")).toBe(false);
    // It is simply a tile-local layer there, not an override of anything.
    expect(resolveLayers(m, "b").map((l) => l.id)).toEqual(["s1"]);
  });

  it("keeps tile-only layers on top of inherited ones", () => {
    const m = withOverlay();
    m.tiles.a.layers.push({ ...newTextLayer(), id: "own" });
    expect(resolveLayers(m, "a").map((l) => l.id)).toEqual(["s1", "own"]);
  });
});

describe("setAssigned", () => {
  const all = ["a", "b", "c"];

  it("pins the list when a tile is taken away from an all-tiles overlay", () => {
    const o = newOverlay("x");
    setAssigned(o, all, ["b"], false);
    expect(o.tiles).toEqual(["a", "c"]);
  });

  it("collapses back to all when the last missing tile is added", () => {
    const o = newOverlay("x", ["a", "c"]);
    setAssigned(o, all, ["b"], true);
    // Not ["a","b","c"] — a pinned list would silently skip the next character
    // the folder gains, while "all" follows it.
    expect(o.tiles).toBe("all");
  });

  it("keeps the folder's order rather than the order tiles were clicked", () => {
    const o = newOverlay("x", []);
    setAssigned(o, all, ["c", "a"], true);
    expect(o.tiles).toEqual(["a", "c"]);
  });

  it("ignores tiles already in or already out", () => {
    const o = newOverlay("x", ["a"]);
    setAssigned(o, all, ["a"], true);
    expect(o.tiles).toEqual(["a"]);
    setAssigned(o, all, ["b"], false);
    expect(o.tiles).toEqual(["a"]);
  });

  it("can empty an overlay completely", () => {
    const o = newOverlay("x");
    setAssigned(o, all, all, false);
    expect(o.tiles).toEqual([]);
  });

  it("drops tiles the folder no longer has", () => {
    const o = newOverlay("x", ["a", "gone"]);
    setAssigned(o, all, ["b"], true);
    expect(o.tiles).toEqual(["a", "b"]);
  });
});

describe("instanceCount", () => {
  it("counts one copy per tile an overlay covers", () => {
    const m = withOverlay(["a", "c"]);
    expect(instanceCount(m, "s1", "tile")).toBe(2);
  });

  it("follows the folder for an all-tiles overlay, minus hidden tiles", () => {
    const m = withOverlay();
    expect(instanceCount(m, "s1", "tile")).toBe(3);
    m.hidden = ["b"];
    expect(instanceCount(m, "s1", "tile")).toBe(2);
  });

  it("counts a grid-space layer once however many tiles it spans", () => {
    const m = withOverlay();
    expect(instanceCount(m, "s1", "grid")).toBe(1);
  });

  it("counts a tile-local layer once", () => {
    const m = withOverlay();
    m.tiles.a.layers.push({ ...newTextLayer(), id: "own" });
    expect(instanceCount(m, "own", "tile")).toBe(1);
  });
});

describe("assignExactly", () => {
  const all = ["a", "b", "c"];

  it("narrows an all-tiles overlay to just the named ones", () => {
    const o = newOverlay("x");
    assignExactly(o, all, ["b"]);
    expect(o.tiles).toEqual(["b"]);
  });

  it("collapses to all when the selection is everything", () => {
    const o = newOverlay("x", ["a"]);
    assignExactly(o, all, ["c", "b", "a"]);
    expect(o.tiles).toBe("all");
  });

  it("keeps folder order and drops unknown ids", () => {
    const o = newOverlay("x", []);
    assignExactly(o, all, ["c", "ghost", "a"]);
    expect(o.tiles).toEqual(["a", "c"]);
  });
});

describe("coveredTiles", () => {
  const all = ["a", "b", "c"];

  it("resolves all against the folder as it stands", () => {
    expect(coveredTiles(newOverlay("x"), all)).toEqual(all);
  });

  it("hides ids the folder no longer has", () => {
    expect(coveredTiles(newOverlay("x", ["a", "gone"]), all)).toEqual(["a"]);
  });
});

describe("overlayCovering", () => {
  it("matches the same tiles in any order", () => {
    const o = newOverlay("x", ["c", "a"]);
    expect(overlayCovering([o], ["a", "c"])).toBe(o);
    expect(overlayCovering([o], ["a", "c", "a"])).toBe(o);
  });

  it("does not match a different set", () => {
    const o = newOverlay("x", ["a", "c"]);
    expect(overlayCovering([o], ["a"])).toBeUndefined();
    expect(overlayCovering([o], ["a", "b", "c"])).toBeUndefined();
  });

  it("never matches an all-tiles overlay, even against a list naming everything", () => {
    // The two differ in what happens when a character appears: "all" picks it
    // up, a list does not. Collapsing them would silently change behaviour.
    expect(overlayCovering([newOverlay("x")], ["a", "b"])).toBeUndefined();
  });
});

describe("overlayOf", () => {
  it("finds the owning overlay, including for a nested layer", () => {
    const m = withOverlay();
    const nested = { ...newTextLayer(), id: "deep" };
    m.overlays[0].layers.push(newGroupLayer([nested]));
    expect(overlayOf(m, "deep")?.name).toBe("Alle");
    expect(overlayOf(m, "nope")).toBeUndefined();
  });
});

describe("effectiveTile", () => {
  it("changes for every covered tile when the overlay's layer changes", () => {
    const m = withOverlay();
    const before = JSON.stringify(effectiveTile(m, "b"));
    overlayLayer(m).color = "#ff0000";
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
  const crop = { x: 0, y: 0, w: 10, h: 10 };

  it("lifts a v1 manifest all the way to v3", () => {
    const m = migrate({ version: 1, order: ["a"], tiles: { a: { asset: "x.png", crop } } });
    expect(m.version).toBe(3);
    expect(m.order).toEqual(["a"]);
    expect(m.tiles.a.base).toEqual({ asset: "x.png", crop });
    expect(m.tiles.a.layers).toEqual([]);
    expect(m.overlays).toEqual([]);
  });

  it("turns a v2 shared stack into one overlay covering everything", () => {
    const shared = [{ ...newTextLayer(), id: "s1" }];
    const m = migrate({ version: 2, order: ["a", "b"], hidden: ["b"], shared, tiles: {} });

    expect(m.version).toBe(3);
    expect(m.overlays).toHaveLength(1);
    expect(m.overlays[0].tiles).toBe("all");
    expect(m.overlays[0].layers.map((l) => l.id)).toEqual(["s1"]);
    expect(m.hidden).toEqual(["b"]);
    // The dead v2 fields must not ride along, or they outlive their meaning.
    expect("shared" in m).toBe(false);
    expect("mosaic" in m).toBe(false);
  });

  it("makes no overlay for a v2 project that had no shared layers", () => {
    expect(migrate({ version: 2, order: [], shared: [], tiles: {} }).overlays).toEqual([]);
  });

  it("keeps a v2 mosaic visible by carrying its baked crops over", () => {
    // v2 stored the placement twice: an editable `mosaic` rect and the crop it
    // had already baked into each tile. Only the latter decides what renders,
    // so dropping the former loses re-editability, never the picture.
    const m = migrate({
      version: 2,
      order: ["a"],
      shared: [],
      mosaic: { asset: "wall.png", rect: { x: 5, y: 5, w: 70, h: 90 } },
      tiles: { a: { base: { asset: "wall.png", crop }, layers: [], text: {} } },
    });
    expect(m.tiles.a.base).toEqual({ asset: "wall.png", crop });
  });

  it("leaves a v3 manifest alone", () => {
    const v3 = emptyManifest();
    v3.overlays = [newOverlay("Schon v3")];
    expect(migrate(structuredClone(v3))).toEqual(v3);
  });

  it("survives a null tile and unreadable input", () => {
    expect(migrate({ version: 1, order: ["a"], tiles: { a: null } }).tiles.a.base).toBeNull();
    expect(migrate(null).version).toBe(3);
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
