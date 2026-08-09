import { describe, expect, it } from "vitest";
import {
  bakeMosaicInto,
  DEFAULT_IMAGE_SCALE,
  DEFAULT_SHAPE_SIZE,
  DEFAULT_TEXT_SIZE,
  deleteStampCascade,
  dissolveFolder,
  dropOrphanLiveLayers,
  droppedWork,
  folderOf,
  emptyManifest,
  emptyTile,
  bakeable,
  duplicateLayout,
  findLayer,
  findList,
  inboxIds,
  archivedIds,
  setArchived,
  layerLabel,
  layerAsset,
  layerIcon,
  layerText,
  migrate,
  maskChoices,
  moveToProject,
  nameInStack,
  nestingShift,
  newGroupLayer,
  newImageLayer,
  uncrop,
  layoutFingerprint,
  layoutNeedsRestamp,
  newLayout,
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
  holdersUsingLayout,
  pruneDeadLayoutRefs,
  pruneToFolder,
  removeFromProjectToInbox,
  tilesUsingLayout,
  refreshStamps,
  relocateLayer,
  stampInto,
  stencilIds,
  swapPlaced,
  syncLiveLayers,
  type ImageLayer,
  removeLayerFrom,
  resolveLayers,
  unplaceTile,
  walkLayers,
  type Layer,
  type Manifest,
  type TextLayer,
} from "./model";

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
    m.tiles.a.layers.push({ ...newTextLayer(), id: "stale" });
    m.tiles.a.text = { stale: "Alter Name" };

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

describe("dropOrphanLiveLayers", () => {
  const stamp = (layoutId: string) => ({ ...newImageLayer("sheet.png"), layoutId });
  const caption = (layoutId: string) => ({ ...newTextLayer(), layoutId, live: true });

  it("drops a live caption whose stamp is gone", () => {
    /* Deleting a stamp used to leave its captions behind, and the list hides
     * live captions because the stamp row speaks for them — with no stamp row
     * nothing did. Four tiles on the real wall carried captions that rendered,
     * could not be selected and could not be deleted. */
    const tile = { ...emptyTile(), layers: [caption("L1")] };
    expect(dropOrphanLiveLayers(tile)).toBe(1);
    expect(tile.layers).toEqual([]);
  });

  it("keeps a live caption that still has its stamp", () => {
    const tile = { ...emptyTile(), layers: [stamp("L1"), caption("L1")] };
    expect(dropOrphanLiveLayers(tile)).toBe(0);
    expect(tile.layers).toHaveLength(2);
  });

  it("never touches a layer the user made by hand", () => {
    const tile = { ...emptyTile(), layers: [newTextLayer(), newImageLayer("own.png")] };
    expect(dropOrphanLiveLayers(tile)).toBe(0);
    expect(tile.layers).toHaveLength(2);
  });

  it("drops a caption written before the live flag existed", () => {
    // Legacy shape: text with a layoutId and no `live`. It can never gain the
    // flag afterwards, so a rule that required it would orphan these forever.
    const legacy = { ...newTextLayer(), layoutId: "L1" };
    const tile = { ...emptyTile(), layers: [legacy] };
    expect(dropOrphanLiveLayers(tile)).toBe(1);
  });
});

describe("deleteStampCascade", () => {
  it("takes the layout's live layers with the stamp", () => {
    const s = { ...newImageLayer("sheet.png"), layoutId: "L1" };
    const cap = { ...newTextLayer(), layoutId: "L1", live: true };
    const logo = { ...newImageLayer("logo.png"), layoutId: "L1", live: true };
    const mine = { ...newTextLayer(), id: "mine" };
    const layers: Layer[] = [s, cap, logo, mine];

    expect(deleteStampCascade(layers, s.id)).toBe(3);
    expect(layers.map((l) => l.id)).toEqual(["mine"]);
  });

  it("leaves another layout's stamp and captions alone", () => {
    const s1 = { ...newImageLayer("a.png"), layoutId: "L1" };
    const s2 = { ...newImageLayer("b.png"), layoutId: "L2" };
    const cap2 = { ...newTextLayer(), layoutId: "L2", live: true };
    const layers: Layer[] = [s1, s2, cap2];

    deleteStampCascade(layers, s1.id);
    expect(layers.map((l) => l.id)).toEqual([s2.id, cap2.id]);
  });

  it("deletes an ordinary layer without dragging anything along", () => {
    const plain = { ...newImageLayer("hand.png"), id: "plain" };
    const cap = { ...newTextLayer(), layoutId: "L1", live: true };
    const layers: Layer[] = [plain, cap];

    expect(deleteStampCascade(layers, "plain")).toBe(1);
    expect(layers.map((l) => l.id)).toEqual([cap.id]);
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

describe("holdersUsingLayout", () => {
  it("finds every tile carrying a stamp of this layout, and no others", () => {
    const m = tilesWith({
      t0: [{ ...newImageLayer("render1.png"), layoutId: "L1" }],
      t1: [{ ...newImageLayer("render2.png"), layoutId: "L2" }],
      t2: [newImageLayer("hand-picked.png")], // never stamped from any layout
    });
    expect(holdersUsingLayout(m, "L1").map((h) => h.tiles)).toEqual([["t0"]]);
    expect(holdersUsingLayout(m, "nope")).toEqual([]);
  });
});

describe("tilesUsingLayout", () => {
  it("counts the portraits wearing the design", () => {
    const m = tilesWith({
      t0: [stampOf("L1")],
      t1: [stampOf("L1")],
      t2: [stampOf("L2")],
      t3: [],
    });
    expect(tilesUsingLayout(m, "L1")).toBe(2);
    expect(tilesUsingLayout(m, "L2")).toBe(1);
    expect(tilesUsingLayout(m, "nope")).toBe(0);
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

describe("pruneDeadLayoutRefs", () => {
  const stamp = (layoutId: string) => ({ ...newImageLayer("sheet.png"), layoutId });
  const caption = (layoutId: string) => ({ ...newTextLayer(), layoutId, live: true });

  /** A manifest whose library knows exactly one layout, "alive". */
  const withLibrary = () => {
    const m = emptyManifest();
    const layout = newLayout("Alive");
    layout.id = "alive";
    m.layouts.push(layout);
    return m;
  };

  it("drops stamp and live caption of a layout the library no longer has", () => {
    /* The measured wound: sixteen layers on a real wall named layouts deleted
     * long before, rendering pictures nobody could account for. */
    const m = withLibrary();
    m.tiles["t"] = { ...emptyTile(), layers: [stamp("dead"), caption("dead")] };
    expect(pruneDeadLayoutRefs(m)).toBe(2);
    expect(m.tiles["t"].layers).toEqual([]);
  });

  it("keeps layers of a layout that still exists, and everything hand-made", () => {
    const m = withLibrary();
    m.tiles["t"] = {
      ...emptyTile(),
      layers: [stamp("alive"), caption("alive"), newTextLayer(), newImageLayer("own.png")],
    };
    expect(pruneDeadLayoutRefs(m)).toBe(0);
    expect(m.tiles["t"].layers).toHaveLength(4);
  });

  it("takes the wording and the per-tile picture of a dead layer with it", () => {
    /* Both are keyed by layer id, and the layer is the only thing that reaches
     * them: left behind they are typed words sitting in the manifest that
     * nothing can show and nothing can clear. */
    const m = withLibrary();
    const words = caption("dead");
    const picture = stamp("dead");
    const mine = newTextLayer();
    m.tiles["t"] = {
      ...emptyTile(),
      layers: [picture, words, mine],
      text: { [words.id]: "Elani", [mine.id]: "meins" },
      swap: { [picture.id]: "face.png" },
    };

    pruneDeadLayoutRefs(m);

    expect(m.tiles["t"].text).toEqual({ [mine.id]: "meins" });
    expect(m.tiles["t"].swap).toEqual({});
  });

  it("cascades a layout deletion through every tile", () => {
    const m = withLibrary();
    m.tiles["a"] = { ...emptyTile(), layers: [stamp("alive")] };
    m.tiles["b"] = { ...emptyTile(), layers: [stamp("alive"), newTextLayer()] };
    m.layouts = [];
    expect(pruneDeadLayoutRefs(m)).toBe(2);
    expect(m.tiles["a"].layers).toEqual([]);
    expect(m.tiles["b"].layers).toHaveLength(1);
  });
});

describe("stampInto", () => {
  it("adds a stamp carrying the layout it came from", () => {
    const overlay = emptyTile();
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
    const stamp = stampInto(emptyTile(), "L1", "render.png");
    expect(stamp.scale).toBe(1);
    expect(stamp.x).toBe(0.5);
    expect(stamp.y).toBe(0.5);
  });

  it("replaces the picture of an existing stamp rather than stacking a copy", () => {
    const overlay = emptyTile();
    const first = stampInto(overlay, "L1", "render1.png");
    const again = stampInto(overlay, "L1", "render2.png");
    expect(overlay.layers).toHaveLength(1);
    expect(again.id).toBe(first.id); // same layer, new picture
    expect(again.asset).toBe("render2.png");
  });

  it("keeps stamps of different layouts apart", () => {
    const overlay = emptyTile();
    stampInto(overlay, "L1", "a.png");
    stampInto(overlay, "L2", "b.png");
    expect(overlay.layers).toHaveLength(2);
  });

  it("leaves an ordinary picture alone, even in the same stack", () => {
    const overlay = emptyTile();
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
    const a = emptyTile();
    const b = emptyTile();
    stampInto(a, "L1", "old.png");
    stampInto(b, "L1", "old.png");
    stampInto(b, "L2", "other.png");
    const untouched = newImageLayer("hand-picked.png");
    b.layers.push(untouched);
    m.tiles = { t0: a, t1: b };

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

  it("reaches a stamp sitting in a tile's own stack", () => {
    /* "Update stamps" is the only way an edited Layout reaches the wall. A
     * tile stamped on its own used to be invisible to it — the design kept
     * showing the version it was stamped at, for good. */
    const m = emptyManifest();
    const tile = emptyTile();
    stampInto(tile, "L1", "old.png");
    m.tiles = { t0: tile };

    expect(refreshStamps(m, "L1", "new.png")).toBe(1);
    expect((tile.layers[0] as ImageLayer).asset).toBe("new.png");
  });
});

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
    expect(m.version).toBe(7);
    expect(m.projects).toHaveLength(1);
    expect(m.projects[0].name).toBe("Main");
    expect(m.projects[0].order).toEqual(["t2", "t0"]);
    expect(m.projects[0].shelf).toEqual(["t1"]);
  });

  it("copies a group's stack onto each of its members", () => {
    const m = migrate(v6());
    expect(m.tiles.t0.layers.map((l) => l.id)).toEqual(["st", "cap"]);
    expect(m.tiles.t2.layers.map((l) => l.id)).toEqual(["st", "cap"]);
    // Copies, not one object shared by both — otherwise moving a layer on one
    // tile would move it on every other member of the old group.
    expect(m.tiles.t0.layers[0]).not.toBe(m.tiles.t2.layers[0]);
  });

  it("keeps layer ids, so per-tile wording still resolves", () => {
    const m = migrate(v6());
    expect(m.tiles.t0.text.cap).toBe("Krieger");
    expect(m.tiles.t0.layers.some((l) => l.id === "cap")).toBe(true);
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

  it("keeps each tile's picture and every layout", () => {
    const m = migrate(v6());
    expect(m.tiles.t0.base).toEqual({ asset: "b.png", crop });
    expect(m.layouts.map((l) => l.name)).toEqual(["Meins"]);
  });

  it("takes a v1 tile's bare picture, which sat under the id itself", () => {
    const m = migrate({ version: 1, order: ["a"], tiles: { a: { asset: "x.png", crop } } });
    expect(m.version).toBe(7);
    expect(m.tiles.a.base).toEqual({ asset: "x.png", crop });
    expect(m.projects[0].order).toEqual(["a"]);
  });

  it("survives a null tile and unreadable input", () => {
    expect(migrate({ version: 1, order: ["a"], tiles: { a: null } }).tiles.a.base).toBeNull();
    expect(migrate(null).version).toBe(7);
  });

  it("leaves the input alone and runs again to the same result", () => {
    const input = v6();
    const copy = structuredClone(input);
    const once = migrate(input);
    expect(input).toEqual(copy);
    expect(migrate(structuredClone(once))).toEqual(once);
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

  it("copies live captions onto the tile and keeps their ids", () => {
    const layout = newLayout("L");
    layout.layers.push(liveCaption("t1"));
    const overlay = emptyTile();

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
    const overlay = emptyTile();
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
    const overlay = emptyTile();
    syncLiveLayers(overlay, layout);
    // group at 0.7/0.2 displaces by +0.2/-0.3 over the neutral 0.5/0.5
    expect(overlay.layers[0].x).toBeCloseTo(0.5);
    expect(overlay.layers[0].y).toBeCloseTo(0.1);
  });

  it("lets a shape be per-tile, so a per-tile cutter may cut it", () => {
    /* A shape has no wording and no picture of its own to vary — what varies is
     * the thing cutting it. A gradient block cut by each character's class icon
     * needs the block to travel with the icon: the rule says a per-tile cutter
     * only cuts a per-tile layer, and shapes had no way to say yes to it. The
     * checkbox did not exist, so the mask just fell off as "no longer allowed". */
    const layout = newLayout("L");
    const icon = { ...newImageLayer("icon.svg"), id: "icon", perTile: true };
    const block = { ...newShapeLayer("rect"), id: "block", perTile: true, maskId: "icon" };
    layout.layers.push(icon, block);

    // The dropdown offers the per-tile icon to the per-tile shape.
    expect(maskChoices(layout.layers, "block").map((l) => l.id)).toEqual(["icon"]);
    // The stamp carries neither; both travel.
    expect(bakeable(layout).layers).toEqual([]);
    const overlay = emptyTile();
    syncLiveLayers(overlay, layout);
    expect(overlay.layers.map((l) => l.id).sort()).toEqual(["block", "icon"]);
    expect(overlay.layers.every((l) => l.live)).toBe(true);
  });

  it("sends the shape a live layer is cut by along with it", () => {
    /* The reason the two settings used to lock each other out: the layer left
     * the Layout and the thing cutting it stayed behind, so on the tile the
     * maskId resolved to nothing and the picture came back whole. */
    const layout = newLayout("L");
    const shape = { ...newShapeLayer("rect"), id: "cut" };
    const caption = { ...liveCaption("t1"), maskId: "cut" };
    layout.layers.push(shape, caption);
    const overlay = emptyTile();

    syncLiveLayers(overlay, layout);

    const copied = overlay.layers.find((l) => l.id === "cut");
    expect(copied).toBeTruthy();
    // Marked like every other copy, so the existing sweeps own it: hidden from
    // the tile list, withdrawn with the layout, gone when the layout goes.
    expect(copied!.live).toBe(true);
    expect(copied!.layoutId).toBe(layout.id);
  });

  it("folds a group's displacement into the cutter too", () => {
    // Otherwise the cut lands somewhere else entirely — there are no groups on
    // a tile to put it back.
    const layout = newLayout("L");
    const shape = { ...newShapeLayer("rect"), id: "cut", x: 0.3, y: 0.4 };
    layout.layers.push({ ...newGroupLayer([shape]), x: 0.7, y: 0.2 });
    layout.layers.push({ ...liveCaption("t1"), maskId: "cut" });
    const overlay = emptyTile();

    syncLiveLayers(overlay, layout);

    const copied = overlay.layers.find((l) => l.id === "cut")!;
    expect(copied.x).toBeCloseTo(0.5);
    expect(copied.y).toBeCloseTo(0.1);
  });

  it("withdraws the cutter once nothing on the tile is cut by it", () => {
    const layout = newLayout("L");
    layout.layers.push({ ...newShapeLayer("rect"), id: "cut" });
    layout.layers.push({ ...liveCaption("t1"), maskId: "cut" });
    const overlay = emptyTile();
    syncLiveLayers(overlay, layout);
    expect(overlay.layers).toHaveLength(2);

    delete (layout.layers[1] as TextLayer).maskId;
    syncLiveLayers(overlay, layout);

    expect(overlay.layers.map((l) => l.id)).toEqual(["t1"]);
  });

  it("removes a copy once its source stops being per-tile", () => {
    const layout = newLayout("L");
    layout.layers.push(liveCaption("t1"));
    const overlay = emptyTile();
    syncLiveLayers(overlay, layout);

    (layout.layers[0] as TextLayer).perTile = false;
    expect(syncLiveLayers(overlay, layout)).toBe(0);
    expect(overlay.layers).toHaveLength(0);
  });

  it("leaves another layout's copies alone", () => {
    const mine = newLayout("A");
    mine.layers.push(liveCaption("t1"));
    const theirs = newLayout("B");
    const overlay = emptyTile();
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

describe("per-tile pictures", () => {
  /** A Layout with one live image, stamped onto a tile. */
  const stamped = () => {
    const layout = newLayout("Klassen");
    const logo = newImageLayer("default-logo.png");
    logo.perTile = true;
    layout.layers.push(logo);
    const overlay: { layers: Layer[] } = emptyTile();
    stampInto(overlay, layout.id, "sheet.png");
    syncLiveLayers(overlay, layout);
    return { layout, overlay, logo };
  };

  it("keeps a live picture out of the stamp and beside it", () => {
    const { overlay, logo } = stamped();
    expect(overlay.layers.map((l) => l.kind)).toEqual(["image", "image"]);
    const [stamp, live] = overlay.layers as ImageLayer[];
    expect(stamp.asset).toBe("sheet.png");
    expect(stamp.live).toBeFalsy();
    // The copy keeps the layout layer's id, which is what the per-tile map
    // is keyed by.
    expect(live.id).toBe(logo.id);
    expect(live.live).toBe(true);
  });

  it("leaves the live picture alone when the stamp is re-rendered", () => {
    /* The trap: both carry the same layoutId and both are images, so a lookup
     * written on those two facts alone would overwrite a per-tile logo with
     * the whole flattened sheet.
     *
     * The live copy is put first on purpose. Fresh from syncLiveLayers it sits
     * behind the stamp, and a lookup taking the first match then finds the
     * right layer by luck — but the layer list is drag-sortable, so that order
     * is one drop away from reversing. */
    const { layout, overlay, logo } = stamped();
    overlay.layers.reverse();
    stampInto(overlay, layout.id, "sheet-v2.png");
    const live = overlay.layers.find((l) => l.id === logo.id) as ImageLayer;
    const stamp = overlay.layers.find((l) => l.id !== logo.id) as ImageLayer;
    expect(stamp.asset).toBe("sheet-v2.png");
    expect(live.asset).toBe("default-logo.png");
  });

  it("withdraws the live picture without taking the stamp with it", () => {
    // The same trap one step later: the cleanup pass must not mistake the
    // stamp for a copy that is no longer live.
    const { layout, overlay, logo } = stamped();
    layout.layers = [];
    syncLiveLayers(overlay, layout);
    expect(overlay.layers).toHaveLength(1);
    expect((overlay.layers[0] as ImageLayer).asset).toBe("sheet.png");
    expect(overlay.layers.some((l) => l.id === logo.id)).toBe(false);
  });

  it("bakes everything except the live picture", () => {
    const layout = newLayout("Gemischt");
    const baked = newImageLayer("frame.png");
    const live = newImageLayer("logo.png");
    live.perTile = true;
    layout.layers.push(baked, live);
    expect(bakeable(layout).layers.map((l) => l.id)).toEqual([baked.id]);
  });
});

describe("layerAsset", () => {
  const layer = () => ({ ...newImageLayer("default.png"), id: "L1" });

  it("falls back to the layer's own picture when the tile has none", () => {
    expect(layerAsset({}, layer())).toBe("default.png");
  });

  it("takes the tile's picture over the layer's", () => {
    expect(layerAsset({ L1: "witch.png" }, layer())).toBe("witch.png");
  });

  it('treats "" as a choice, not as absence', () => {
    /* "No picture on this tile" has to survive. `||` here would put the
     * default straight back — the same trap the caption text fell into. */
    expect(layerAsset({ L1: "" }, layer())).toBe("");
  });
});

describe("layerIcon", () => {
  const layer = () => ({ ...newShapeLayer("icon", "Ranger"), id: "L1" });

  it("falls back to the layer's own class when the tile names none", () => {
    expect(layerIcon({}, layer())).toBe("Ranger");
  });

  it("takes the tile's class over the layer's", () => {
    expect(layerIcon({ L1: "Witch" }, layer())).toBe("Witch");
  });

  it('treats "" as a choice, not as absence', () => {
    /* "No icon on this tile" has to survive, exactly as it does for a picture:
     * `||` would put the layer's class straight back. */
    expect(layerIcon({ L1: "" }, layer())).toBe("");
  });

  it("keys on the layer, so two icon layers on a tile choose apart", () => {
    /* One map per tile carries every layer's choice — a wall with a class badge
     * and a guild badge must not have one answer the other's question. */
    const guild = { ...newShapeLayer("icon", "Nova"), id: "L2" };
    const swaps = { L1: "Witch", L2: "Shai" };
    expect(layerIcon(swaps, layer())).toBe("Witch");
    expect(layerIcon(swaps, guild)).toBe("Shai");
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
    m.tiles.c.text = { L1: "Hallo" };
    // `a` is untouched and `d` is still in the folder — neither is a loss.
    m.tiles.d.layers = [newTextLayer()];
    expect(droppedWork(m, ["d"]).sort()).toEqual(["b", "c"]);
  });

  it("counts a baked picture and a per-tile swap as work", () => {
    const m = wall();
    m.tiles.a.base = { asset: "mosaic.png", crop: { x: 0, y: 0, w: 10, h: 10 } };
    m.tiles.b.swap = { L1: "face.png" };
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

  it("offers a per-tile cutter only to a layer that is per-tile itself", () => {
    /* A caption editable on the wall says something different on every tile, so
     * what it cuts has to be worked out per tile too. That is possible for a
     * layer that travels to the tile with it — a picture through each
     * character's own name — and impossible for one baked into the stamp: the
     * stamp is a single picture for the whole wall, and "which letters" has no
     * shared answer there. */
    const shape = newShapeLayer("rect");
    const words = { ...newTextLayer(), perTile: true };
    const stamped = newImageLayer("x.png");
    const alsoLive = { ...newImageLayer("y.png"), perTile: true };
    const layers = [shape, words, stamped, alsoLive];

    // Baked into the stamp: only a cutter that is baked with it will do.
    expect(maskChoices(layers, stamped.id).map((l) => l.id)).toEqual([shape.id]);
    // On the tile: anything may cut it, the per-tile caption included.
    expect(maskChoices(layers, alsoLive.id).map((l) => l.id)).toEqual([
      shape.id,
      words.id,
      stamped.id,
    ]);
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
    m.tiles.b.layers = [newTextLayer()];
    m.tiles.b.text = { L1: "Elani" };
    setArchived(m, ["b"], true);
    expect(m.tiles.b.layers).toHaveLength(1);
    expect(m.tiles.b.text).toEqual({ L1: "Elani" });
  });
});
