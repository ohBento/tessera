import { describe, expect, it } from "vitest";
import {
  assignExactly,
  bakeMosaicInto,
  coveredTiles,
  DEFAULT_IMAGE_SCALE,
  DEFAULT_SHAPE_SIZE,
  DEFAULT_TEXT_SIZE,
  effectiveTile,
  emptyManifest,
  emptyTile,
  addToGroup,
  bakeable,
  duplicateLayout,
  findLayer,
  findList,
  freeTiles,
  groupOf,
  instanceCount,
  isDetached,
  layerLabel,
  layerText,
  migrate,
  nestingShift,
  newGroupLayer,
  newImageLayer,
  layoutFingerprint,
  layoutNeedsRestamp,
  newLayout,
  newOverlay,
  newShapeLayer,
  newTextLayer,
  overlayCovering,
  overlayOf,
  overlaysUsingLayout,
  tilesUsingLayout,
  refreshStamps,
  relocateLayer,
  removeFromGroup,
  stampInto,
  swapTiles,
  syncLiveLayers,
  type ImageLayer,
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

describe("bakeMosaicInto", () => {
  it("writes each crop into its tile's base", () => {
    const m = emptyManifest();
    m.order = ["a", "b", "c"];
    m.tiles = { a: emptyTile(), b: emptyTile(), c: emptyTile() };
    const layer = newImageLayer("wall.png");
    layer.space = "grid";
    m.overlays = [{ ...newOverlay("Alle"), layers: [layer] }];

    const crops = new Map([
      [0, { x: 0, y: 0, w: 10, h: 10 }],
      [2, { x: 10, y: 0, w: 10, h: 10 }],
    ]);
    bakeMosaicInto(m, layer.id, "wall.png", crops, m.order);

    expect(m.tiles.a.base).toEqual({ asset: "wall.png", crop: crops.get(0) });
    expect(m.tiles.b.base).toBeNull(); // not in the crop map, left untouched
    expect(m.tiles.c.base).toEqual({ asset: "wall.png", crop: crops.get(2) });
  });

  it("removes the mosaic layer from its overlay", () => {
    const m = emptyManifest();
    m.order = ["a"];
    m.tiles = { a: emptyTile() };
    const layer = newImageLayer("wall.png");
    const other = { ...newTextLayer(), id: "keep" };
    m.overlays = [{ ...newOverlay("Alle"), layers: [layer, other] }];

    bakeMosaicInto(m, layer.id, "wall.png", new Map(), m.order);

    expect(m.overlays[0].layers.map((l) => l.id)).toEqual(["keep"]);
  });

  it("does nothing destructive when the layer is already gone", () => {
    const m = emptyManifest();
    m.order = ["a"];
    m.tiles = { a: emptyTile() };
    expect(() => bakeMosaicInto(m, "ghost", "wall.png", new Map(), m.order)).not.toThrow();
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

describe("overlaysUsingLayout", () => {
  it("finds every overlay carrying a stamp of this layout, and no others", () => {
    const stamped = { ...newImageLayer("render1.png"), layoutId: "L1" };
    const other = { ...newImageLayer("render2.png"), layoutId: "L2" };
    const plain = newImageLayer("hand-picked.png"); // never stamped from any layout
    const m = emptyManifest();
    m.overlays = [
      { ...newOverlay("A"), layers: [stamped] },
      { ...newOverlay("B"), layers: [other] },
      { ...newOverlay("C"), layers: [plain] },
    ];
    expect(overlaysUsingLayout(m, "L1").map((o) => o.name)).toEqual(["A"]);
    expect(overlaysUsingLayout(m, "nope")).toEqual([]);
  });
});

describe("tilesUsingLayout", () => {
  const stampOf = (layoutId: string) => ({ ...newImageLayer("r.png"), layoutId });

  it("adds up the tiles of every group holding the layout", () => {
    const m = emptyManifest();
    m.overlays = [
      { ...newOverlay("A", ["t0", "t1", "t2"]), layers: [stampOf("L1")] },
      { ...newOverlay("B", ["t3", "t4"]), layers: [stampOf("L1")] },
      { ...newOverlay("C", ["t5"]), layers: [stampOf("L2")] },
    ];
    /* The number the group count cannot give: two groups, but five portraits
     * wearing the design — and "stamped 2 time(s)" in front of a wall of
     * tiles reads as two tiles. */
    expect(tilesUsingLayout(m, "L1")).toBe(5);
    expect(tilesUsingLayout(m, "L2")).toBe(1);
    expect(tilesUsingLayout(m, "nope")).toBe(0);
  });

  it("does not count an all-tiles overlay as the whole wall", () => {
    // The wall axis, not a tile group. Nothing stamps into one, but if
    // anything ever did, "all" is not a number of tiles.
    const m = emptyManifest();
    m.overlays = [{ ...newOverlay("Alle"), layers: [stampOf("L1")] }];
    expect(m.overlays[0].tiles).toBe("all");
    expect(tilesUsingLayout(m, "L1")).toBe(0);
  });
});

describe("layoutNeedsRestamp", () => {
  const withImage = () => {
    const layout = newLayout("L");
    layout.layers.push(newImageLayer("a.png"));
    return layout;
  };

  it("says no for a layout that was never stamped", () => {
    // Nothing on any tile to bring up to date; the action for this case is
    // stamping it somewhere, not saving.
    expect(layoutNeedsRestamp(withImage())).toBe(false);
  });

  it("says no right after stamping", () => {
    const layout = withImage();
    layout.stamped = layoutFingerprint(layout);
    expect(layoutNeedsRestamp(layout)).toBe(false);
  });

  it("says yes once a layer moves", () => {
    const layout = withImage();
    layout.stamped = layoutFingerprint(layout);
    layout.layers[0].x = 0.9;
    expect(layoutNeedsRestamp(layout)).toBe(true);
  });

  it("notices a layer being hidden, added, removed or reordered", () => {
    const layout = withImage();
    layout.layers.push(newImageLayer("b.png"));
    layout.stamped = layoutFingerprint(layout);
    layout.layers[0].hidden = true;
    expect(layoutNeedsRestamp(layout)).toBe(true);

    const reordered = withImage();
    reordered.layers.push(newImageLayer("b.png"));
    reordered.stamped = layoutFingerprint(reordered);
    [reordered.layers[0], reordered.layers[1]] = [reordered.layers[1], reordered.layers[0]];
    expect(layoutNeedsRestamp(reordered)).toBe(true);

    const removed = withImage();
    removed.stamped = layoutFingerprint(removed);
    removed.layers.pop();
    expect(layoutNeedsRestamp(removed)).toBe(true);
  });

  it("can report a change that turns out to look identical", () => {
    // Hiding then unhiding leaves `hidden: false` where the key was absent
    // before, which serialises differently even though it renders the same.
    // Pinned rather than papered over with a normaliser: the cost is one
    // redundant re-render of an identical picture, and the alternative is a
    // second definition of "same" to keep in step with the layer types.
    const layout = withImage();
    layout.stamped = layoutFingerprint(layout);
    layout.layers[0].hidden = true;
    layout.layers[0].hidden = false;
    expect(layoutNeedsRestamp(layout)).toBe(true);
  });

  it("ignores a rename, which changes nothing about the picture", () => {
    const layout = withImage();
    layout.stamped = layoutFingerprint(layout);
    layout.name = "Anderer Name";
    expect(layoutNeedsRestamp(layout)).toBe(false);
  });
});

describe("stampInto", () => {
  it("adds a stamp carrying the layout it came from", () => {
    const overlay = newOverlay("A");
    const stamp = stampInto(overlay, "L1", "render1.png");
    expect(overlay.layers).toHaveLength(1);
    expect(stamp.layoutId).toBe("L1");
    expect(stamp.asset).toBe("render1.png");
  });

  it("lands the stamp filling the tile, not at the picture default", () => {
    // A stamp is rendered at exactly tile resolution, so the only scale that
    // reproduces the Layout as composed is 1. newImageLayer's 0.3 default is
    // meant for a picture dropped in by hand and would shrink the whole sheet
    // to a patch floating in the middle of the tile.
    const stamp = stampInto(newOverlay("A"), "L1", "render.png");
    expect(stamp.scale).toBe(1);
    expect(stamp.x).toBe(0.5);
    expect(stamp.y).toBe(0.5);
  });

  it("replaces the picture of an existing stamp rather than stacking a copy", () => {
    const overlay = newOverlay("A");
    const first = stampInto(overlay, "L1", "render1.png");
    const again = stampInto(overlay, "L1", "render2.png");
    expect(overlay.layers).toHaveLength(1);
    expect(again.id).toBe(first.id); // same layer, new picture
    expect(again.asset).toBe("render2.png");
  });

  it("keeps stamps of different layouts apart", () => {
    const overlay = newOverlay("A");
    stampInto(overlay, "L1", "a.png");
    stampInto(overlay, "L2", "b.png");
    expect(overlay.layers).toHaveLength(2);
  });

  it("leaves an ordinary picture alone, even in the same overlay", () => {
    const overlay = newOverlay("A");
    const plain = newImageLayer("hand-picked.png");
    overlay.layers.push(plain);
    stampInto(overlay, "L1", "render.png");
    expect(overlay.layers).toHaveLength(2);
    expect(plain.asset).toBe("hand-picked.png");
  });
});

describe("refreshStamps", () => {
  it("repoints every stamp of one layout, wherever it sits", () => {
    const m = emptyManifest();
    const a = newOverlay("A");
    const b = newOverlay("B");
    stampInto(a, "L1", "old.png");
    stampInto(b, "L1", "old.png");
    stampInto(b, "L2", "other.png");
    const untouched = newImageLayer("hand-picked.png");
    b.layers.push(untouched);
    m.overlays = [a, b];

    expect(refreshStamps(m, "L1", "new.png")).toBe(2);
    expect((a.layers[0] as ImageLayer).asset).toBe("new.png");
    expect((b.layers[0] as ImageLayer).asset).toBe("new.png");
    // Neither another layout's stamp nor a plain picture may move.
    expect((b.layers[1] as ImageLayer).asset).toBe("other.png");
    expect(untouched.asset).toBe("hand-picked.png");
  });

  it("reports zero when nothing uses the layout", () => {
    expect(refreshStamps(emptyManifest(), "nope", "new.png")).toBe(0);
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

describe("layer groups keep members where they are", () => {
  /** Where a layer actually renders: its own position plus every enclosing
   *  group's displacement — the sum buildLayout applies. */
  const at = (layers: Layer[], id: string) => {
    const l = findLayer(layers, id)!;
    const s = nestingShift(layers, id) ?? { dx: 0, dy: 0 };
    return { x: l.x + s.dx, y: l.y + s.dy };
  };

  const two = (): Layer[] => [
    { ...newImageLayer("a.png"), id: "a", x: 0.2, y: 0.3 },
    { ...newImageLayer("b.png"), id: "b", x: 0.7, y: 0.8 },
  ];

  it("does not move anything when a fresh group is formed", () => {
    const flat = two();
    const before = [at(flat, "a"), at(flat, "b")];
    const grouped: Layer[] = [newGroupLayer(flat)];
    expect([at(grouped, "a"), at(grouped, "b")]).toEqual(before);
  });

  it("moves every member when the group moves, by exactly the group's shift", () => {
    const grouped: Layer[] = [{ ...newGroupLayer(two()), x: 0.6, y: 0.4 }];
    // group at 0.6/0.4 means a displacement of +0.1/-0.1 over neutral 0.5/0.5
    expect(at(grouped, "a").x).toBeCloseTo(0.3);
    expect(at(grouped, "a").y).toBeCloseTo(0.2);
    expect(at(grouped, "b").x).toBeCloseTo(0.8);
    expect(at(grouped, "b").y).toBeCloseTo(0.7);
  });

  it("leaves members exactly where they were when the group is dissolved", () => {
    const grouped: Layer[] = [{ ...newGroupLayer(two()), x: 0.6, y: 0.4 }];
    const before = [at(grouped, "a"), at(grouped, "b")];
    removeLayerFrom(grouped, grouped[0].id);
    expect(grouped.map((l) => l.id)).toEqual(["a", "b"]);
    expect([at(grouped, "a"), at(grouped, "b")]).toEqual(before);
  });
});

describe("migrate starts anything older than v6 from a clean slate", () => {
  const crop = { x: 0, y: 0, w: 10, h: 10 };

  const old = () => ({
    version: 5,
    order: ["t2", "t0", "t1"],
    hidden: ["t1"],
    overlays: [{ ...newOverlay("Alt", ["t0"]), layers: [newImageLayer("x.png")] }],
    tiles: {
      t0: { base: { asset: "b.png", crop }, layers: [newTextLayer()], text: { alt: "Geist" } },
      t1: { base: null, layers: [], text: { weg: "verwaist" } },
      t2: emptyTile(),
    },
    layouts: [{ ...newLayout("Meins"), stamped: "abc" }],
  });

  it("takes a v1 tile's bare picture, which sat under the id itself", () => {
    const m = migrate({ version: 1, order: ["a"], tiles: { a: { asset: "x.png", crop } } });
    expect(m.version).toBe(6);
    expect(m.tiles.a.base).toEqual({ asset: "x.png", crop });
    expect(m.tiles.a.layers).toEqual([]);
  });

  it("survives a null tile and unreadable input", () => {
    expect(migrate({ version: 1, order: ["a"], tiles: { a: null } }).tiles.a.base).toBeNull();
    expect(migrate(null).version).toBe(6);
  });

  it("leaves a v6 manifest exactly as it is", () => {
    const v6 = {
      ...emptyManifest(),
      order: ["a"],
      overlays: [{ ...newOverlay("Bleibt", ["a"]), layers: [newImageLayer("y.png")] }],
    };
    expect(migrate(structuredClone(v6))).toEqual(v6);
  });

  it("drops groups, tile layers and tile captions", () => {
    const m = migrate(old());
    expect(m.version).toBe(6);
    expect(m.overlays).toEqual([]);
    expect(Object.values(m.tiles).every((t) => !t.layers.length)).toBe(true);
    expect(Object.values(m.tiles).every((t) => !Object.keys(t.text).length)).toBe(true);
  });

  it("keeps the hand-built order, the hidden tiles and each tile's picture", () => {
    const m = migrate(old());
    expect(m.order).toEqual(["t2", "t0", "t1"]);
    expect(m.hidden).toEqual(["t1"]);
    expect(m.tiles.t0.base).toEqual({ asset: "b.png", crop: { x: 0, y: 0, w: 10, h: 10 } });
  });

  it("keeps layouts but marks none of them stamped", () => {
    const m = migrate(old());
    expect(m.layouts.map((l) => l.name)).toEqual(["Meins"]);
    expect(m.layouts[0].stamped).toBeUndefined();
  });

  it("leaves the input alone and runs again to the same result", () => {
    const input = old();
    const copy = structuredClone(input);
    const once = migrate(input);
    expect(input).toEqual(copy);
    expect(migrate(once)).toEqual(once);
  });
});

describe("per-tile captions", () => {
  const liveCaption = (id: string, text = "Kachel {{id}}") => {
    const l = { ...newTextLayer(), id, text, perTile: true };
    return l;
  };

  it("keeps an emptied override empty instead of falling back", () => {
    // The bug this project already had once: clearing the field put the
    // layer's default text straight back, so it could not be cleared at all.
    const layer = liveCaption("t1", "Standard");
    expect(layerText({}, layer, "t00")).toBe("Standard");
    expect(layerText({ t1: "" }, layer, "t00")).toBe("");
    expect(layerText({ t1: "Eigen" }, layer, "t00")).toBe("Eigen");
  });

  it("expands {{id}} to the tile it lands on", () => {
    expect(layerText({}, liveCaption("t1"), "t07")).toBe("Kachel t07");
  });

  it("leaves live captions out of what gets baked", () => {
    const layout = newLayout("L");
    layout.layers.push(newImageLayer("x.png"), liveCaption("t1"));
    expect(bakeable(layout).layers.map((l) => l.kind)).toEqual(["image"]);
    // The Layout itself is untouched — the editor still shows the caption.
    expect(layout.layers).toHaveLength(2);
  });

  it("keeps a group's remaining children when a live member is dropped", () => {
    const layout = newLayout("L");
    const group = { ...newGroupLayer([newImageLayer("x.png"), liveCaption("t1")]), x: 0.7 };
    layout.layers.push(group);
    const baked = bakeable(layout).layers[0];
    expect(baked.kind).toBe("group");
    expect(baked.kind === "group" && baked.children.map((c) => c.kind)).toEqual(["image"]);
    // The displacement survives, or the remaining children would jump.
    expect(baked.x).toBe(0.7);
  });

  it("copies live captions onto the overlay and keeps their ids", () => {
    const layout = newLayout("L");
    layout.layers.push(liveCaption("t1"));
    const overlay = newOverlay("G", ["a"]);

    expect(syncLiveLayers(overlay, layout)).toBe(1);
    expect(overlay.layers).toHaveLength(1);
    expect(overlay.layers[0].id).toBe("t1");
    expect(overlay.layers[0].layoutId).toBe(layout.id);
    // perTile means nothing on a tile, where every caption is already live.
    expect((overlay.layers[0] as TextLayer).perTile).toBeUndefined();
  });

  it("updates a copy in place rather than stacking a second one", () => {
    const layout = newLayout("L");
    layout.layers.push(liveCaption("t1"));
    const overlay = newOverlay("G", ["a"]);
    syncLiveLayers(overlay, layout);

    (layout.layers[0] as TextLayer).size = 0.2;
    syncLiveLayers(overlay, layout);
    expect(overlay.layers).toHaveLength(1);
    expect((overlay.layers[0] as TextLayer).size).toBe(0.2);
  });

  it("folds a group's displacement into the copy", () => {
    const layout = newLayout("L");
    const caption = { ...liveCaption("t1"), x: 0.3, y: 0.4 };
    layout.layers.push({ ...newGroupLayer([caption]), x: 0.7, y: 0.2 });
    const overlay = newOverlay("G", ["a"]);
    syncLiveLayers(overlay, layout);
    // group at 0.7/0.2 displaces by +0.2/-0.3 over the neutral 0.5/0.5
    expect(overlay.layers[0].x).toBeCloseTo(0.5);
    expect(overlay.layers[0].y).toBeCloseTo(0.1);
  });

  it("removes a copy once its source stops being per-tile", () => {
    const layout = newLayout("L");
    layout.layers.push(liveCaption("t1"));
    const overlay = newOverlay("G", ["a"]);
    syncLiveLayers(overlay, layout);

    (layout.layers[0] as TextLayer).perTile = false;
    expect(syncLiveLayers(overlay, layout)).toBe(0);
    expect(overlay.layers).toHaveLength(0);
  });

  it("leaves another layout's copies alone", () => {
    const mine = newLayout("A");
    mine.layers.push(liveCaption("t1"));
    const theirs = newLayout("B");
    const overlay = newOverlay("G", ["a"]);
    syncLiveLayers(overlay, mine);
    syncLiveLayers(overlay, theirs);
    expect(overlay.layers).toHaveLength(1);
  });
});

describe("duplicateLayout", () => {
  const source = () => {
    const l = newLayout("Original");
    const mask = { ...newShapeLayer("rect"), id: "shape" };
    const masked = { ...newTextLayer(), id: "cap", maskId: "shape", perTile: true };
    l.layers.push(mask, { ...newGroupLayer([masked]), id: "grp" });
    l.stamped = "irgendein-fingerabdruck";
    return l;
  };

  it("gives every layer a new id, nested ones too", () => {
    const from = source();
    const copy = duplicateLayout(from, "Kopie");
    const oldIds = new Set([...walkLayers(from.layers)].map((l) => l.id));
    const newIds = [...walkLayers(copy.layers)].map((l) => l.id);

    expect(copy.id).not.toBe(from.id);
    expect(newIds).toHaveLength(3);
    expect(newIds.some((id) => oldIds.has(id))).toBe(false);
    // Ids are what per-tile wording and stamp tracking hang on, so a shared
    // one would make editing the copy move the original's captions.
    expect(new Set(newIds).size).toBe(3);
  });

  it("keeps everything else, including the per-tile flag", () => {
    const copy = duplicateLayout(source(), "Kopie");
    const caption = [...walkLayers(copy.layers)].find((l) => l.kind === "text");
    expect(copy.name).toBe("Kopie");
    expect(caption?.kind === "text" && caption.perTile).toBe(true);
    expect(copy.layers[1].kind === "group" && copy.layers[1].children).toHaveLength(1);
  });

  it("points a mask at the copy's own shape, not the original's", () => {
    const from = source();
    const copy = duplicateLayout(from, "Kopie");
    const shape = copy.layers[0];
    const caption = [...walkLayers(copy.layers)].find((l) => l.kind === "text");
    expect(caption?.maskId).toBe(shape.id);
    expect(caption?.maskId).not.toBe("shape");
  });

  it("starts unstamped, because the copy has never been on a tile", () => {
    expect(duplicateLayout(source(), "Kopie").stamped).toBeUndefined();
  });

  it("leaves the original alone", () => {
    const from = source();
    const before = structuredClone(from);
    duplicateLayout(from, "Kopie");
    expect(from).toEqual(before);
  });
});

describe("relocateLayer", () => {
  const at = (layers: Layer[], id: string) => {
    const l = findLayer(layers, id)!;
    const s = nestingShift(layers, id) ?? { dx: 0, dy: 0 };
    return { x: l.x + s.dx, y: l.y + s.dy };
  };

  /** Two loose layers and a displaced group holding a third. */
  const tree = (): Layer[] => [
    { ...newImageLayer("a.png"), id: "a", x: 0.1, y: 0.1 },
    { ...newImageLayer("b.png"), id: "b", x: 0.2, y: 0.2 },
    {
      ...newGroupLayer([{ ...newImageLayer("c.png"), id: "c", x: 0.3, y: 0.3 }]),
      id: "g",
      x: 0.7,
      y: 0.2,
    },
  ];

  it("drops a layer in front of the row it names", () => {
    const t = tree();
    expect(relocateLayer(t, "g", null, "b")).toBe(true);
    expect(t.map((l) => l.id)).toEqual(["a", "g", "b"]);
  });

  it("sends it to the end when it names nothing", () => {
    const t = tree();
    relocateLayer(t, "a", null, null);
    expect(t.map((l) => l.id)).toEqual(["b", "g", "a"]);
  });

  it("is a no-op in effect when a layer lands in front of itself", () => {
    const t = tree();
    relocateLayer(t, "b", null, "b");
    expect(t.map((l) => l.id)).toEqual(["a", "b", "g"]);
  });

  it("keeps a layer where it looks when it moves into a displaced group", () => {
    const t = tree();
    const before = at(t, "a");
    relocateLayer(t, "a", "g", null);
    expect(at(t, "a").x).toBeCloseTo(before.x);
    expect(at(t, "a").y).toBeCloseTo(before.y);
    expect(findList(t, "a")).toBe((findLayer(t, "g") as { children: Layer[] }).children);
  });

  it("keeps a layer where it looks when it leaves a group", () => {
    const t = tree();
    const before = at(t, "c");
    relocateLayer(t, "c", null, "a");
    expect(at(t, "c").x).toBeCloseTo(before.x);
    expect(at(t, "c").y).toBeCloseTo(before.y);
    expect(t.map((l) => l.id)).toEqual(["c", "a", "b", "g"]);
  });

  it("refuses to put a group inside itself", () => {
    const t = tree();
    expect(relocateLayer(t, "g", "g", null)).toBe(false);
    expect(t.map((l) => l.id)).toEqual(["a", "b", "g"]);
  });

  it("reports an unknown layer rather than pretending", () => {
    expect(relocateLayer(tree(), "zz", null, null)).toBe(false);
  });
});

describe("tile groups", () => {
  /** Two groups over five tiles, plus an "all" overlay standing in for the
   *  wall picture — which must never count as owning anything. */
  const grouped = (): Manifest => {
    const m = emptyManifest();
    m.order = ["a", "b", "c", "d", "e"];
    m.overlays = [
      newOverlay("Alle"),
      newOverlay("Eins", ["a", "b"]),
      newOverlay("Zwei", ["c"]),
    ];
    return m;
  };

  it("finds the group owning a tile, ignoring the all-overlay", () => {
    const m = grouped();
    expect(groupOf(m, "a")?.name).toBe("Eins");
    expect(groupOf(m, "c")?.name).toBe("Zwei");
    expect(groupOf(m, "d")).toBeUndefined();
  });

  it("reports only unclaimed tiles as free", () => {
    expect(freeTiles(grouped(), ["a", "c", "d", "e"])).toEqual(["d", "e"]);
  });

  it("adds only free tiles and says how many landed", () => {
    const m = grouped();
    const group = m.overlays[2];
    expect(addToGroup(m, group, ["a", "d", "e"])).toBe(2);
    expect(group.tiles).toEqual(["c", "d", "e"]);
    // "a" stayed where it was rather than being stolen.
    expect(groupOf(m, "a")?.name).toBe("Eins");
  });

  it("never adds a tile twice", () => {
    const m = grouped();
    const group = m.overlays[1];
    expect(addToGroup(m, group, ["a", "b"])).toBe(0);
    expect(group.tiles).toEqual(["a", "b"]);
  });

  it("frees a removed tile for other groups", () => {
    const m = grouped();
    removeFromGroup(m.overlays[1], "a");
    expect(groupOf(m, "a")).toBeUndefined();
    expect(addToGroup(m, m.overlays[2], ["a"])).toBe(1);
  });

  it("swaps two tiles and leaves every other position alone", () => {
    const m = grouped();
    swapTiles(m, "a", "d");
    expect(m.order).toEqual(["d", "b", "c", "a", "e"]);
  });

  it("ignores a swap with an unknown or identical tile", () => {
    const m = grouped();
    swapTiles(m, "a", "a");
    swapTiles(m, "a", "zz");
    expect(m.order).toEqual(["a", "b", "c", "d", "e"]);
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
