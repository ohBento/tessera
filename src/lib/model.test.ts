import { describe, expect, it } from "vitest";
import {
  bakeMosaicInto,
  DEFAULT_IMAGE_SCALE,
  DEFAULT_SHAPE_SIZE,
  DEFAULT_TEXT_SIZE,
  dissolveFolder,
  dropOrphanLiveLayers,
  droppedWork,
  folderOf,
  emptyManifest,
  emptyTile,
  findLayer,
  findList,
  inboxIds,
  archivedIds,
  setArchived,
  layerLabel,
  layerText,
  migrate,
  maskChoices,
  moveToProject,
  nameInStack,
  nestingShift,
  newGroupLayer,
  newImageLayer,
  uncrop,
  newFolder,
  newProject,
  newShapeLayer,
  newTextLayer,
  looseTiles,
  placeTile,
  putInFolder,
  projectOf,
  projectTiles,
  clearBases,
  pruneToFolder,
  removeFromProjectToInbox,
  relocateLayer,
  stencilIds,
  swapPlaced,
  type ImageLayer,
  removeLayerFrom,
  resolveLayers,
  unplaceTile,
  walkLayers,
  type Layer,
  type Manifest,
  type ShapeLayer,
  type TextLayer,
} from "./model";

/** A v7 Layout, for the migration fixtures below — the only thing that still
 *  has to be able to describe one. The model type went with the editor. */
const newLayout = (name: string) => ({ id: `L-${name}`, name, layers: [] as Layer[] });

/** Three tiles in one project, the shape everything below starts from. */
const withProject = (): Manifest => {
  const m = emptyManifest();
  const p = newProject("Main");
  p.order = ["a", "b", "c"];
  m.projects = [p];
  m.tiles = { a: emptyTile(), b: emptyTile(), c: emptyTile() };
  return m;
};

const main = (m: Manifest) => m.projects[0];

describe("resolveLayers", () => {
  it("is the tile's own stack and nothing else", () => {
    /* v6 inherited from every overlay covering the tile, with per-tile copies
     * replacing inherited layers by id. Layouts are assigned per tile now, so a
     * layer exists in exactly one place — which is what retired the whole
     * "moved one copy, the other four are stale" class of bug. */
    const m = withProject();
    m.tiles.a.layers.push({ ...newTextLayer(), id: "own" });
    expect(resolveLayers(m, "a").map((l) => l.id)).toEqual(["own"]);
    expect(resolveLayers(m, "b")).toEqual([]);
  });

  it("answers for a tile the manifest has never heard of", () => {
    expect(resolveLayers(emptyManifest(), "ghost")).toEqual([]);
  });
});

describe("projects own tiles exclusively", () => {
  it("reports the owner, and the inbox is what no project claims", () => {
    const m = withProject();
    main(m).shelf.push("d");
    expect(projectOf(m, "a")?.name).toBe("Main");
    expect(projectOf(m, "d")?.name).toBe("Main"); // shelf counts as membership
    expect(projectOf(m, "e")).toBeUndefined();
    expect(inboxIds(m, ["a", "d", "e", "f"])).toEqual(["e", "f"]);
  });


  it("moves a tile between projects, leaving its edit state alone", () => {
    const m = withProject();
    m.tiles.a.layers.push({ ...newTextLayer(), id: "keep" });
    const other = newProject("Other");
    m.projects.push(other);

    expect(moveToProject(m, "a", other.id)).toBe(true);
    expect(main(m).order).toEqual(["b", "c"]);
    expect(other.shelf).toEqual(["a"]);
    // Layers live in m.tiles, which belongs to no project — so they travel for
    // free, and that is the whole reason membership is kept apart from content.
    expect(m.tiles.a.layers.map((l) => l.id)).toEqual(["keep"]);
  });

  it("refuses to move a tile into the project that already has it", () => {
    const m = withProject();
    expect(moveToProject(m, "a", main(m).id)).toBe(false);
    expect(main(m).order).toEqual(["a", "b", "c"]);
  });

  it("takes a tile out of its folders too, not just the grid", () => {
    const m = withProject();
    main(m).folders.push({ id: "f1", name: "Done", tiles: ["a", "b"] });
    const other = newProject("Other");
    m.projects.push(other);

    moveToProject(m, "a", other.id);
    // A folder still naming a tile the project no longer owns is a row that
    // cannot be clicked and a count that lies.
    expect(main(m).folders[0].tiles).toEqual(["b"]);
  });

  it("sends a tile back to the inbox, keeping its work unless told otherwise", () => {
    const m = withProject();
    m.tiles.a.layers.push({ ...newTextLayer(), id: "keep" });

    removeFromProjectToInbox(m, "a", false);
    expect(projectOf(m, "a")).toBeUndefined();
    expect(m.tiles.a.layers).toHaveLength(1);
  });

  it("wipes the tile when the id turned out to be a different character", () => {
    /* The game reuses a numeric id when a character slot is deleted and
     * refilled. The layers on it were composed for a face that no longer
     * exists — keeping them would dress a stranger. */
    const m = withProject();
    m.tiles.a.layers.push({ ...newTextLayer(), id: "stale", text: "Alter Name" });

    removeFromProjectToInbox(m, "a", true);
    expect(m.tiles.a).toEqual(emptyTile());
  });
});

describe("cosmetic folders", () => {
  /* A drawer in the tile list and nothing else. It does not render, does not
   * stamp, and dissolving one must leave every tile and every layer untouched —
   * that is the whole difference from the group it replaces, which deleted
   * artwork every time someone reorganised. */
  const withFolder = () => {
    const m = withProject();
    const p = main(m);
    const f = newFolder("Done");
    p.folders = [f];
    return { m, p, f };
  };

  it("holds tiles and reports which drawer one is in", () => {
    const { p, f } = withFolder();
    expect(putInFolder(p, f.id, "a")).toBe(true);
    expect(folderOf(p, "a")?.name).toBe("Done");
    expect(folderOf(p, "b")).toBeUndefined();
  });

  it("keeps a tile in one drawer at a time", () => {
    const { p, f } = withFolder();
    const other = newFolder("Later");
    p.folders.push(other);
    putInFolder(p, f.id, "a");
    putInFolder(p, other.id, "a");
    expect(f.tiles).toEqual([]);
    expect(other.tiles).toEqual(["a"]);
  });

  it("refuses a tile the project does not own", () => {
    const { p, f } = withFolder();
    expect(putInFolder(p, f.id, "stranger")).toBe(false);
    expect(f.tiles).toEqual([]);
  });

  it("dissolving takes nothing with it", () => {
    const { m, p, f } = withFolder();
    m.tiles.a.layers.push({ ...newTextLayer(), id: "art" });
    putInFolder(p, f.id, "a");

    dissolveFolder(p, f.id);
    expect(p.folders).toEqual([]);
    // The tile keeps its slot on the grid and every layer on it.
    expect(p.order).toEqual(["a", "b", "c"]);
    expect(m.tiles.a.layers.map((l) => l.id)).toEqual(["art"]);
  });

  it("lists the tiles no drawer has taken, in grid order", () => {
    const { p, f } = withFolder();
    putInFolder(p, f.id, "b");
    expect(looseTiles(p, p.order)).toEqual(["a", "c"]);
  });
});

describe("the two invariants hold whatever order things are done in", () => {
  /* Everything downstream leans on these. `order` is the grid's coordinate
   * system — scene, export and hit-testing all index into it independently —
   * so a tile appearing twice, or in two projects, is not a cosmetic error: it
   * is two renderers disagreeing about which portrait sits in slot 7. Checked
   * as a property over a run of operations rather than case by case, because
   * the ways to break it are combinations, not single calls. */
  const invariants = (m: Manifest) => {
    const seen = new Set<string>();
    for (const p of m.projects) {
      expect(new Set(p.order).size).toBe(p.order.length); // no duplicate slots
      for (const id of projectTiles(p)) {
        expect(p.order.includes(id) && p.shelf.includes(id)).toBe(false); // disjoint
        expect(seen.has(id)).toBe(false); // owned by at most one project
        seen.add(id);
      }
    }
  };

  it("survives adding, placing, moving and releasing in any mixture", () => {
    const m = emptyManifest();
    const a = newProject("A");
    const b = newProject("B");
    m.projects = [a, b];
    for (const id of ["t0", "t1", "t2", "t3"]) m.tiles[id] = emptyTile();

    const steps: Array<() => void> = [
      () => ["t0", "t1", "t2", "t3"].forEach((id) => moveToProject(m, id, a.id)),
      () => placeTile(a, "t0", null),
      () => placeTile(a, "t1", "t0"),
      () => moveToProject(m, "t2", b.id),
      () => placeTile(b, "t2", null),
      () => swapPlaced(a, "t0", "t1"),
      () => unplaceTile(a, "t1"),
      () => moveToProject(m, "t0", b.id),
      () => removeFromProjectToInbox(m, "t3", false),
      () => placeTile(a, "t1", null),
      () => moveToProject(m, "t2", a.id),
    ];
    for (const step of steps) {
      step();
      invariants(m);
    }

    // And the run really did move things about, or the check proves nothing.
    expect(projectTiles(a).length + projectTiles(b).length).toBe(3);
    expect(projectOf(m, "t3")).toBeUndefined();
  });
});

describe("placing tiles in the grid", () => {
  it("moves a shelf tile in front of the named one and closes no holes", () => {
    const m = withProject();
    const p = main(m);
    p.shelf = ["x"];
    placeTile(p, "x", "b");
    expect(p.order).toEqual(["a", "x", "b", "c"]);
    expect(p.shelf).toEqual([]);
  });

  it("appends when there is nothing to land in front of", () => {
    const m = withProject();
    const p = main(m);
    p.shelf = ["x"];
    placeTile(p, "x", null);
    expect(p.order).toEqual(["a", "b", "c", "x"]);
  });

  it("re-places an already placed tile without duplicating it", () => {
    const m = withProject();
    const p = main(m);
    placeTile(p, "c", "a");
    expect(p.order).toEqual(["c", "a", "b"]);
  });

  it("ignores a tile the project does not own, and a drop onto itself", () => {
    const m = withProject();
    const p = main(m);
    placeTile(p, "stranger", "a");
    placeTile(p, "b", "b");
    expect(p.order).toEqual(["a", "b", "c"]);
  });

  it("unplaces back to the shelf, and the grid closes up", () => {
    const m = withProject();
    const p = main(m);
    unplaceTile(p, "b");
    expect(p.order).toEqual(["a", "c"]);
    expect(p.shelf).toEqual(["b"]);
  });

  it("swaps two placed tiles rather than shifting the rest", () => {
    // The wall mirrors a hand-built in-game order; inserting would rearrange
    // everything after the target on a single drag.
    const m = withProject();
    swapPlaced(main(m), "a", "c");
    expect(main(m).order).toEqual(["c", "b", "a"]);
  });

  it("leaves the order alone when a swap partner is not placed", () => {
    const m = withProject();
    main(m).shelf = ["x"];
    swapPlaced(main(m), "a", "x");
    expect(main(m).order).toEqual(["a", "b", "c"]);
  });
});



describe("bakeMosaicInto", () => {
  const withMosaic = () => {
    const m = withProject();
    const layer = newImageLayer("wall.png");
    layer.space = "grid";
    main(m).gridLayers.push(layer);
    return { m, layer };
  };

  it("writes each crop into the tile sitting in that slot", () => {
    const { m, layer } = withMosaic();
    const crops = new Map([
      [0, { x: 0, y: 0, w: 10, h: 10 }],
      [2, { x: 10, y: 0, w: 10, h: 10 }],
    ]);
    bakeMosaicInto(m, main(m), layer.id, "wall.png", crops);

    expect(m.tiles.a.base).toEqual({ asset: "wall.png", crop: crops.get(0) });
    expect(m.tiles.b.base).toBeNull(); // not in the crop map, left untouched
    expect(m.tiles.c.base).toEqual({ asset: "wall.png", crop: crops.get(2) });
  });

  it("removes the mosaic layer from the project it spanned", () => {
    const { m, layer } = withMosaic();
    const other = { ...newTextLayer(), id: "keep" };
    main(m).gridLayers.push(other);

    bakeMosaicInto(m, main(m), layer.id, "wall.png", new Map());
    expect(main(m).gridLayers.map((l) => l.id)).toEqual(["keep"]);
  });

  it("does nothing destructive when the layer is already gone", () => {
    const { m } = withMosaic();
    expect(() => bakeMosaicInto(m, main(m), "ghost", "wall.png", new Map())).not.toThrow();
  });
});

const stampOf = (layoutId: string) => ({ ...newImageLayer("r.png"), layoutId });

/** Tiles carrying the given stamps, as the manifest stores them. */
const tilesWith = (spec: Record<string, Layer[]>): Manifest => {
  const m = emptyManifest();
  for (const [id, layers] of Object.entries(spec)) m.tiles[id] = { ...emptyTile(), layers };
  return m;
};






describe("clearBases", () => {
  const baked = (asset: string) => ({
    ...emptyTile(),
    base: { asset, crop: { x: 0, y: 0, w: 10, h: 10 } },
  });

  it("gives every baked tile its portrait back and counts them", () => {
    /* background() in scene.ts never reads the portrait while a base is set,
     * and baking was one-way: a wall carrying 44 baked backgrounds from an
     * earlier session had no button anywhere that could clear one, which reads
     * from the outside as an app that cannot load its own folder. */
    const m = emptyManifest();
    m.tiles = { t0: baked("mosaic.jpg"), t1: baked("mosaic.jpg"), t2: emptyTile() };

    expect(clearBases(m)).toBe(2);
    expect(Object.values(m.tiles).every((t) => t.base === null)).toBe(true);
  });

  it("leaves the layers alone — only the background was baked", () => {
    const m = emptyManifest();
    const tile = baked("mosaic.jpg");
    tile.layers = [newTextLayer()];
    m.tiles = { t0: tile };

    clearBases(m);
    expect(m.tiles.t0.layers).toHaveLength(1);
  });

  it("reports zero when no tile is baked", () => {
    expect(clearBases(emptyManifest())).toBe(0);
  });
});

describe("layerText", () => {
  it("expands the tile id, which is what makes one caption read as forty", () => {
    const layer = { ...newTextLayer(), id: "s1", text: "{{id}}" };
    expect(layerText(layer, "40000000004743219")).toBe("40000000004743219");
  });

  it("leaves words that name no placeholder alone", () => {
    /* The per-tile override this used to prefer is gone with the record that
       held it: a caption belongs to its tile, so its own text is the answer. */
    const layer = { ...newTextLayer(), id: "s1", text: "Nachtklinge" };
    expect(layerText(layer, "40000000004743219")).toBe("Nachtklinge");
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

describe("migrate v6 into one project", () => {
  const crop = { x: 0, y: 0, w: 10, h: 10 };

  /** A v6 manifest of the shape the real wall had: a hand-built order, one
   *  hidden tile, a group holding a stamp, an "all" overlay carrying the wall
   *  picture, and a tile left with an orphaned live caption. */
  const v6 = () => ({
    version: 6,
    order: ["t2", "t0", "t1"],
    hidden: ["t1"],
    overlays: [
      {
        id: "g1",
        name: "Gruppe",
        tiles: ["t0", "t2"],
        layers: [
          { ...newImageLayer("sheet.png"), id: "st", layoutId: "L1" },
          { ...newTextLayer(), id: "cap", layoutId: "L1", live: true },
        ],
      },
      {
        id: "all",
        name: "Alle",
        tiles: "all",
        layers: [{ ...newImageLayer("wall.jpg"), id: "wall", space: "grid" }],
      },
    ],
    tiles: {
      t0: { base: { asset: "b.png", crop }, layers: [], text: { cap: "Krieger" } },
      t1: { base: null, layers: [{ ...newTextLayer(), id: "waise", layoutId: "gone", live: true }], text: {} },
      t2: emptyTile(),
    },
    layouts: [{ ...newLayout("Meins"), id: "L1", stamped: "abc" }],
  });

  it("puts every tile in one project, hidden ones on the shelf", () => {
    /* The grid is dense now, so there is nowhere for a hidden tile to sit —
     * but dropping it would lose the membership, so it keeps that and gives up
     * only its slot. The order itself is half an hour of hand-dragging and has
     * to come through untouched. */
    const m = migrate(v6());
    expect(m.version).toBe(8);
    expect(m.projects).toHaveLength(1);
    expect(m.projects[0].name).toBe("Main");
    expect(m.projects[0].order).toEqual(["t2", "t0"]);
    expect(m.projects[0].shelf).toEqual(["t1"]);
  });

  it("copies a group's stack onto each of its members", () => {
    /* The stamp "st" is gone by the end of the chain: v8 dissolves it into the
     * layers of the layout it named, and this fixture's layout holds none. What
     * has to survive is the copy the group put on each tile, on both tiles,
     * and as two objects rather than one shared between them. */
    const m = migrate(v6());
    expect(m.tiles.t0.layers.map((l) => l.id)).toEqual(["cap"]);
    expect(m.tiles.t2.layers.map((l) => l.id)).toEqual(["cap"]);
    // Copies, not one object shared by both — otherwise moving a layer on one
    // tile would move it on every other member of the old group.
    expect(m.tiles.t0.layers[0]).not.toBe(m.tiles.t2.layers[0]);
  });

  it("keeps layer ids, so per-tile wording lands in the layer itself", () => {
    /* The id is what carried the wording across the v6 fold, and it is what
     * carries it into the layer in v8 — the record is emptied once the words
     * are where they are drawn from. */
    const m = migrate(v6());
    expect(m.tiles.t0.text).toEqual({});
    const cap = m.tiles.t0.layers.find((l) => l.id === "cap") as TextLayer;
    expect(cap.text).toBe("Krieger");
  });

  it("gives the wall picture to the project, not to the tiles", () => {
    const m = migrate(v6());
    expect(m.projects[0].gridLayers.map((l) => l.id)).toEqual(["wall"]);
    expect(Object.values(m.tiles).every((t) => !t.layers.some((l) => l.id === "wall"))).toBe(true);
  });

  it("sweeps out live layers whose stamp is gone", () => {
    // Four tiles on the real wall carried these: captions that rendered but
    // could be neither selected nor deleted.
    const m = migrate(v6());
    expect(m.tiles.t1.layers).toEqual([]);
  });

  it("keeps each tile's picture, and takes the layouts away", () => {
    const m = migrate(v6());
    expect(m.tiles.t0.base).toEqual({ asset: "b.png", crop });
    // v8 has no layouts: what they held is on the tiles that wore them.
    expect((m as unknown as { layouts?: unknown[] }).layouts ?? []).toHaveLength(0);
  });

  it("takes a v1 tile's bare picture, which sat under the id itself", () => {
    const m = migrate({ version: 1, order: ["a"], tiles: { a: { asset: "x.png", crop } } });
    expect(m.version).toBe(8);
    expect(m.tiles.a.base).toEqual({ asset: "x.png", crop });
    expect(m.projects[0].order).toEqual(["a"]);
  });

  it("survives a null tile and unreadable input", () => {
    expect(migrate({ version: 1, order: ["a"], tiles: { a: null } }).tiles.a.base).toBeNull();
    expect(migrate(null).version).toBe(8);
  });

  it("leaves the input alone and runs again to the same result", () => {
    const input = v6();
    const copy = structuredClone(input);
    const once = migrate(input);
    expect(input).toEqual(copy);
    expect(migrate(structuredClone(once))).toEqual(once);
  });

  it("reads a document from a newer build rather than gutting it", () => {
    /* A version this build has never heard of matched none of the tests and
     * fell through to toV6, which reads a shape that stopped existing two
     * versions ago: projects, folders, the shelf and every tile layer were
     * dropped. Reachable by starting an older Tessera once — the first thing
     * anyone does when a new version misbehaves. */
    const doc = emptyManifest();
    const p = newProject("Main");
    p.order = ["t0"];
    p.folders = [{ id: "f1", name: "Done", tiles: ["t0"] }];
    doc.projects = [p];
    doc.tiles.t0 = { base: null, layers: [newTextLayer()], text: {} };

    const fromNewer = { ...structuredClone(doc), version: 9, wallpaper: "unknown to us" };
    const back = migrate(fromNewer);

    expect(back.projects.map((x) => x.name)).toEqual(["Main"]);
    expect(back.projects[0].folders[0].tiles).toEqual(["t0"]);
    expect(back.tiles.t0.layers.length).toBe(1);
    // What this build has no name for rides along instead of being dropped —
    // the whole reason reading it as v7 is a bounded guess.
    expect((back as unknown as Record<string, unknown>).wallpaper).toBe("unknown to us");
  });
});

describe("migrate v7 into v8: stamps dissolve into the tiles they dressed", () => {
  /* A v7 manifest of the shape a real wall had. The layout holds a baked
   * picture, a baked shape and one live caption; the tile wears the stamp, its
   * own layer above it, and the caption copy the stamp brought. */
  const v7 = () => ({
    version: 7,
    projects: [{ ...newProject("Main"), id: "p1", order: ["t0", "t1"] }],
    layouts: [
      {
        ...newLayout("Meins"),
        id: "L1",
        stamped: "abc",
        layers: [
          { ...newImageLayer("frame.png"), id: "frame", x: 0.5, y: 0.5, scale: 0.8 },
          { ...newShapeLayer("rect"), id: "bar", w: 0.6, h: 0.05 },
          { ...newTextLayer(), id: "cap", perTile: true, text: "{{id}}" },
        ],
      },
    ],
    tiles: {
      t0: {
        ...emptyTile(),
        layers: [
          { ...newImageLayer("baked.png"), id: "stamp", layoutId: "L1", scale: 1 },
          { ...newShapeLayer("ellipse"), id: "mine", w: 0.2, h: 0.2 },
          { ...newTextLayer(), id: "cap", layoutId: "L1", live: true, x: 0.5, y: 0.9 },
        ],
        text: { cap: "Nachtklinge" },
        swap: { frame: "eigenes.png" },
        paint: { bar: "#ff0000" },
        frame: { cap: { x: 0.1, y: -0.05, z: 1, a: 15 } },
      },
      t1: { ...emptyTile(), layers: [] },
    },
  });

  const at = (m: Manifest, tile: string) => m.tiles[tile].layers.map((l) => l.id);

  it("puts the layout's baked layers where the stamp stood", () => {
    /* Order is the whole risk here. A live copy is appended to the end of the
     * stack and draws over everything; the stamp itself sits lower. Dropping
     * the full layout in at the stamp's position would push the tile's own
     * layer down under a design that used to sit beneath it. */
    const m = migrate(v7());
    expect(at(m, "t0")).toEqual(["frame", "bar", "mine", "cap"]);
    expect(m.version).toBe(8);
  });

  it("keeps the live copy rather than the layout's per-tile original", () => {
    /* Both carry id "cap". The copy is the one the tile has been editing — it
     * holds the wording, the placement and the eye — so the bakeable filter
     * leaves the original out and the copy stays put. Two layers with one id on
     * one tile would be a stack that cannot be addressed. */
    const m = migrate(v7());
    const caps = m.tiles.t0.layers.filter((l) => l.id === "cap");
    expect(caps).toHaveLength(1);
    expect((caps[0] as TextLayer).text).toBe("Nachtklinge");
  });

  it("folds the per-tile records into the layers and drops the records", () => {
    const m = migrate(v7());
    const by = (id: string) => findLayer(m.tiles.t0.layers, id)!;
    expect((by("frame") as ImageLayer).asset).toBe("eigenes.png");
    expect((by("bar") as ShapeLayer).fill).toBe("#ff0000");
    expect((by("cap") as TextLayer).text).toBe("Nachtklinge");
    expect(m.tiles.t0.text).toEqual({});
    expect((m.tiles.t0 as Record<string, unknown>).swap).toBeUndefined();
    expect((m.tiles.t0 as Record<string, unknown>).paint).toBeUndefined();
    expect((m.tiles.t0 as Record<string, unknown>).frame).toBeUndefined();
  });

  it("applies a frame only to the layer that was actually framed", () => {
    /* framed() runs at draw time for live copies and for nothing else, so a
     * frame record belonging to a withdrawn copy describes a layer that is
     * drawing unframed today. Folding every record found would move layers
     * nobody ever placed — silent, and visible only as a wall that shifted. */
    const doc = v7();
    doc.tiles.t0.frame = {
      cap: { x: 0.1, y: -0.05, z: 1, a: 15 },
      // No live copy by this name: left over from one that was withdrawn.
      bar: { x: 0.4, y: 0.4, z: 2, a: 0 },
    } as (typeof doc.tiles.t0)["frame"];
    const m = migrate(doc);
    const cap = findLayer(m.tiles.t0.layers, "cap") as TextLayer;
    const bar = findLayer(m.tiles.t0.layers, "bar") as ShapeLayer;
    expect(cap.x).toBeCloseTo(0.6, 5);
    expect(cap.rotation).toBeCloseTo(15, 5);
    // Untouched: still the layout's own numbers.
    expect(bar.x).toBeCloseTo(0.5, 5);
    expect(bar.w).toBeCloseTo(0.6, 5);
  });

  it("carries a hidden stamp's eye onto everything it dissolved into", () => {
    const doc = v7();
    doc.tiles.t0.layers[0] = { ...doc.tiles.t0.layers[0], hidden: true };
    const m = migrate(doc);
    expect(findLayer(m.tiles.t0.layers, "frame")!.hidden).toBe(true);
    expect(findLayer(m.tiles.t0.layers, "bar")!.hidden).toBe(true);
    // The tile's own layer was never part of that assignment.
    expect(findLayer(m.tiles.t0.layers, "mine")!.hidden).toBeFalsy();
  });

  it("dissolves a stamp whose layout is gone to nothing, records and all", () => {
    const doc = v7();
    doc.layouts = [];
    const m = migrate(doc);
    // Its own layer and the copy survive; the stamp and the design go.
    expect(at(m, "t0")).toEqual(["mine", "cap"]);
    expect(m.tiles.t0.text).toEqual({});
  });

  it("keeps an orphaned live copy, which is what the wall was drawing", () => {
    /* Nothing has swept these since v7, and layerShows only consults a stamp
     * that is present — so a copy whose stamp was deleted goes on drawing.
     * Deleting it here would be a visible loss nobody asked for. */
    const doc = v7();
    doc.tiles.t1.layers = [
      { ...newTextLayer(), id: "waise", layoutId: "gone", live: true, text: "bleibt" },
    ] as (typeof doc.tiles.t1)["layers"];
    const m = migrate(doc);
    expect(at(m, "t1")).toEqual(["waise"]);
    expect((findLayer(m.tiles.t1.layers, "waise") as TextLayer).text).toBe("bleibt");
  });

  it("strips the flags that only meant something while layouts existed", () => {
    const m = migrate(v7());
    for (const l of m.tiles.t0.layers) {
      const raw = l as unknown as Record<string, unknown>;
      expect(raw.layoutId).toBeUndefined();
      expect(raw.live).toBeUndefined();
      expect(raw.perTile).toBeUndefined();
    }
    /* Emptied here rather than absent: the field is still on the type until
     * the layout editor itself is taken out. Written so it keeps passing once
     * it is. */
    expect((m as unknown as { layouts?: unknown[] }).layouts ?? []).toHaveLength(0);
  });

  it("leaves its input alone and runs again to the same result", () => {
    const input = v7();
    const copy = structuredClone(input);
    const once = migrate(input);
    expect(input).toEqual(copy);
    expect(migrate(structuredClone(once))).toEqual(once);
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


describe("pruneToFolder", () => {
  /** One project holding three tiles: two placed, one shelved, and a folder
   *  naming two of them. */
  const wall = () => {
    const m = emptyManifest();
    const p = newProject("Main");
    p.order = ["a", "b"];
    p.shelf = ["c"];
    p.folders = [{ id: "f1", name: "Done", tiles: ["a", "c"] }];
    m.projects = [p];
    for (const id of ["a", "b", "c"]) m.tiles[id] = emptyTile();
    return m;
  };

  it("takes tiles the folder no longer has out of grid, shelf and drawers", () => {
    /* A project naming an id nothing has leaves a hole in the wall and a row
     * that cannot be clicked. The v6 version pruned order, hidden and tiles but
     * not the groups, and that left exactly that kind of junk behind. */
    const m = pruneToFolder(wall(), ["a"]);
    expect(m.projects[0].order).toEqual(["a"]);
    expect(m.projects[0].shelf).toEqual([]);
    expect(m.projects[0].folders[0].tiles).toEqual(["a"]);
  });

  it("leaves an emptied project standing", () => {
    // Losing a character is not a reason to throw away the wall someone built,
    // and an empty one is a click from gone.
    const m = pruneToFolder(wall(), ["z"]);
    expect(m.projects).toHaveLength(1);
    expect(m.projects[0].order).toEqual([]);
  });

  it("drops tile state the folder no longer backs, and adopts new ids", () => {
    const m = pruneToFolder(wall(), ["b", "d"]);
    expect(Object.keys(m.tiles).sort()).toEqual(["b", "d"]);
  });

  it("leaves a new id unclaimed, which is what the inbox is", () => {
    const m = pruneToFolder(wall(), ["a", "b", "c", "z"]);
    expect(projectOf(m, "z")).toBeUndefined();
    expect(inboxIds(m, ["a", "b", "c", "z"])).toEqual(["z"]);
  });
});

describe("droppedWork", () => {
  const wall = () => {
    const m = emptyManifest();
    for (const id of ["a", "b", "c", "d"]) m.tiles[id] = emptyTile();
    return m;
  };

  it("names only the tiles that lose something", () => {
    const m = wall();
    m.tiles.b.layers = [newTextLayer()];
    m.tiles.c.layers = [{ ...newTextLayer(), text: "Hallo" }];
    // `a` is untouched and `d` is still in the folder — neither is a loss.
    m.tiles.d.layers = [newTextLayer()];
    expect(droppedWork(m, ["d"]).sort()).toEqual(["b", "c"]);
  });

  it("counts a baked picture and a tile's own caption as work", () => {
    const m = wall();
    m.tiles.a.base = { asset: "mosaic.png", crop: { x: 0, y: 0, w: 10, h: 10 } };
    m.tiles.b.layers = [{ ...newTextLayer(), text: "Nachtklinge" }];
    expect(droppedWork(m, []).sort()).toEqual(["a", "b"]);
  });

  it("says nothing on an ordinary open", () => {
    // Every id in the folder gets an empty tile on load. If those counted, the
    // warning would fire on every single start.
    expect(droppedWork(wall(), ["a", "b", "c", "d"])).toEqual([]);
  });
});

describe("layer names", () => {
  it("numbers each kind for itself, per stack", () => {
    const layers: Layer[] = [];
    for (const l of [newImageLayer("a.png"), newTextLayer(), newImageLayer("b.png")]) {
      nameInStack(l, layers);
      layers.push(l);
    }
    expect(layers.map((l) => l.name)).toEqual(["img01", "text01", "img02"]);
  });

  it("names a shape for the shape it is, and counts each one for itself", () => {
    /* Rectangle, ellipse and polygon all came out "shapeNN" — three kinds of
     * thing under one name in a list with no icons. Sharing the counter was the
     * other half: the first rectangle beside a polygon read "rect02". */
    const layers: Layer[] = [];
    for (const l of [
      newShapeLayer("polygon"),
      newShapeLayer("rect"),
      newShapeLayer("rect"),
      newShapeLayer("ellipse"),
    ]) {
      nameInStack(l, layers);
      layers.push(l);
    }
    expect(layers.map((l) => l.name)).toEqual(["polygon01", "rect01", "rect02", "ellipse01"]);
  });

  it("does not hand a renamed layer's number to the next one", () => {
    /* The whole reason the count is not read off the names: img02 renamed to
     * "classIcon" is still the second picture, and a third one that came back
     * as img02 would sit in the list next to a name that no longer says so. */
    const layers: Layer[] = [];
    for (const l of [newImageLayer("a.png"), newImageLayer("b.png")]) {
      nameInStack(l, layers);
      layers.push(l);
    }
    layers[1].name = "classIcon";

    const third = newImageLayer("c.png");
    nameInStack(third, layers);
    expect(third.name).toBe("img03");
  });

  it("counts a picture inside a group", () => {
    const inner = newImageLayer("a.png");
    nameInStack(inner, []);
    const layers: Layer[] = [newGroupLayer([inner])];

    const next = newImageLayer("b.png");
    nameInStack(next, layers);
    expect(next.name).toBe("img02");
  });

  it("leaves an old stack alone and starts at one", () => {
    // Nothing written before this carries a number, and nothing gets renamed
    // for it — a name the user typed is theirs.
    const old = newImageLayer("logo.png");
    old.name = "logo";
    const next = newImageLayer("b.png");
    nameInStack(next, [old]);
    expect(next.name).toBe("img01");
    expect(old.name).toBe("logo");
  });
});

describe("masks", () => {
  it("offers every layer that draws, except the one being masked", () => {
    /* A shape cuts with its outline, a picture with the pixels it has, a
     * caption with its letters — all three are on offer. Only a group is not:
     * it is a displacement, and draws nothing of its own to cut with. */
    const shape = newShapeLayer("rect");
    const words = newTextLayer();
    const pic = newImageLayer("x.png");
    const layers = [shape, words, pic];
    expect(maskChoices(layers, pic.id).map((l) => l.id)).toEqual([shape.id, words.id]);
    // A layer clipped to its own outline is either nothing or a no-op.
    expect(maskChoices(layers, shape.id).map((l) => l.id)).toEqual([words.id, pic.id]);
  });

  it("looks inside groups, but never offers the group itself", () => {
    const inner = newShapeLayer("rect");
    const pic = newImageLayer("x.png");
    expect(maskChoices([newGroupLayer([inner]), pic], pic.id).map((l) => l.id)).toEqual([inner.id]);
  });

  it("counts a shape as a stencil only while something visible cuts with it", () => {
    const shape = newShapeLayer("rect");
    const pic = newImageLayer("x.png");
    pic.maskId = shape.id;
    expect([...stencilIds([shape, pic])]).toEqual([shape.id]);

    /* Switched off, it is cutting nothing — and the shape has to come back, or
     * it would sit there invisible with nothing on screen to say why. */
    pic.hidden = true;
    expect([...stencilIds([shape, pic])]).toEqual([]);
  });
});

describe("uncrop", () => {
  it("gives the whole picture back at the size its pixels already had", () => {
    const l = newImageLayer("logo.png");
    l.scale = 0.3;
    // Half the width and a fifth of the height cut away.
    l.crop = { l: 0.3, r: 0.2, t: 0.1, b: 0.1 };

    uncrop(l);

    expect(l.crop).toBeUndefined();
    /* The visible half was drawn 0.3 tiles wide, so the whole picture is
     * 0.3 / 0.5. Leaving scale alone instead would redraw all of it in the
     * space half of it occupied, which reads as the crop having shrunk the
     * picture — the one thing cropping must never do. */
    expect(l.scale).toBeCloseTo(0.6, 6);
  });

  it("leaves the pixels that were kept exactly where they were", () => {
    /* Reported as "Reset crop shifts the picture": trim the right edge and the
     * whole picture jumps left when it comes back, by half of what was trimmed.
     * Trimming holds the far edge still — the window's centre moves — and
     * giving the picture back grows it about that moved centre, so the part
     * that never went anywhere ends up somewhere else. The kept pixels are the
     * fixed point of this operation. */
    const l = newImageLayer("logo.png");
    // A picture half a tile wide, centred, with a fifth of its width trimmed
    // off the right: the window is 0.4 wide and its centre sits at 0.45.
    l.scale = 0.4;
    l.x = 0.45;
    l.crop = { l: 0, r: 0.2, t: 0, b: 0 };

    uncrop(l);

    expect(l.scale).toBeCloseTo(0.5, 6);
    expect(l.x).toBeCloseTo(0.5, 6);
  });

  it("puts a picture trimmed at the top back down where it was", () => {
    /* The same sum on the other axis, and the one the model cannot do alone: a
     * layer stores its width and the height follows from the picture's own
     * proportions, so the caller has to say how tall it is. A square picture
     * half a tile wide is 0.5 * 624 / 804 of a tile tall. */
    const l = newImageLayer("logo.png");
    const tall = (0.5 * 624) / 804;
    l.scale = 0.5 * 0.8; // a fifth off the top narrows nothing, but scale is width
    l.scale = 0.5;
    l.y = 0.5 + (0.2 / 2) * tall; // trimming the top moved the window's centre down
    l.crop = { l: 0, r: 0, t: 0.2, b: 0 };

    uncrop(l, 1);

    expect(l.y).toBeCloseTo(0.5, 6);
  });

  it("leaves a picture that was never cropped exactly as it is", () => {
    const l = newImageLayer("logo.png");
    l.scale = 0.3;
    uncrop(l);
    expect(l.scale).toBe(0.3);
    expect(l.crop).toBeUndefined();
  });
});

describe("archiving a tile", () => {
  /* BDO never deletes a portrait, so Unsorted only grows: the faces of
   * characters that no longer exist sit in it forever. Archiving is the way to
   * say "not this one" without touching the folder. */
  const folder = ["a", "b", "c"];
  const withTiles = () => {
    const m = emptyManifest();
    for (const id of folder) m.tiles[id] = emptyTile();
    return m;
  };

  it("takes a tile out of the inbox and puts it in the archive", () => {
    const m = withTiles();
    setArchived(m, ["b"], true);
    expect(inboxIds(m, folder)).toEqual(["a", "c"]);
    expect(archivedIds(m, folder)).toEqual(["b"]);
  });

  it("brings it back", () => {
    const m = withTiles();
    setArchived(m, ["b"], true);
    setArchived(m, ["b"], false);
    expect(inboxIds(m, folder)).toEqual(folder);
    expect(archivedIds(m, folder)).toEqual([]);
    // Absent again, not `false`: the ordinary state is the missing key, and a
    // manifest full of `archived: false` is noise that reads as a decision.
    expect("archived" in m.tiles.b).toBe(false);
  });

  it("refuses a tile a project has claimed", () => {
    /* "Archived but placed" would be a state every count and every write had to
     * ask about. Taking it out of the project first is a click that exists. */
    const m = withTiles();
    const p = newProject("Main");
    p.order = ["a"];
    m.projects = [p];

    setArchived(m, ["a"], true);

    expect(m.tiles.a.archived).toBeUndefined();
    expect(archivedIds(m, folder)).toEqual([]);
  });

  it("keeps the work on an archived tile", () => {
    // Put away, not thrown away: it comes back with what was made for it.
    const m = withTiles();
    m.tiles.b.layers = [{ ...newTextLayer(), id: "L1", text: "Elani" }];
    setArchived(m, ["b"], true);
    expect(m.tiles.b.layers).toHaveLength(1);
    expect((m.tiles.b.layers[0] as TextLayer).text).toBe("Elani");
  });
});
