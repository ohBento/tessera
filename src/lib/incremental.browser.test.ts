/* rebuildTile has one job and one way to fail: it must leave the canvas in the
 * state buildGrid would have left it in. A second drawing path that disagrees
 * with the first is the failure this codebase has paid for before — every one
 * of those bugs looked like "the wall is right until you touch it".
 *
 * So the tests here never check that rebuildTile did something clever. They
 * check that its canvas is indistinguishable from a full build's: same objects
 * in the same stacking order, carrying the same tags. */
import * as fabric from "fabric";
import { describe, expect, it } from "vitest";

import {
  emptyManifest,
  emptyTile,
  newImageLayer,
  newProject,
  newTextLayer,
  type Manifest,
} from "./model";
import { buildGrid, gridSize, rebuildTile, soleTileChange, wallPrint, type Wall } from "./scene";
import { testDeps } from "../test/images";

function manifest(count: number): Manifest {
  const m = emptyManifest();
  const p = newProject("Main");
  p.order = Array.from({ length: count }, (_, i) => `4000000000000000${i}`);
  m.projects = [p];
  for (const id of p.order) m.tiles[id] = emptyTile();
  return m;
}

const order = (m: Manifest) => m.projects[0].order;
const view = (m: Manifest): Wall => ({
  ids: m.projects[0].order,
  gridLayers: m.projects[0].gridLayers,
});

function wallCanvas(count: number) {
  const size = gridSize(count);
  return new fabric.StaticCanvas(undefined, { width: size.w, height: size.h });
}

/** The canvas as something two builds can be compared by: every object's
 *  stacking position, which tile and layer it stands for, and where it sits.
 *
 *  Positions included on purpose. Tags alone would pass a rebuild that put the
 *  right object in the wrong cell, which is exactly what a single-tile path
 *  gets wrong when it loses track of the tile's index. */
const shape = (canvas: fabric.StaticCanvas) =>
  canvas.getObjects().map((o) => {
    const t = o as fabric.Object & { tileId?: string; layerId?: string; space?: string };
    return [
      o.type,
      t.space ?? "",
      t.tileId ?? "",
      t.layerId ?? "",
      Math.round(o.left ?? 0),
      Math.round(o.top ?? 0),
      Math.round(o.getScaledWidth()),
      Math.round(o.getScaledHeight()),
    ].join("|");
  });

/** A wall where every tile carries something, so a rebuild of one has
 *  neighbours it could disturb. */
function dressed(count: number): Manifest {
  const m = manifest(count);
  for (const id of order(m)) {
    const caption = newTextLayer();
    caption.text = id.slice(-2);
    caption.y = 0.8;
    m.tiles[id].layers.push(newImageLayer(`block:#00ff00`), caption);
  }
  return m;
}

describe("deciding whether one tile is enough", () => {
  /* The half of this that has no pixels and all of the risk. Saying "" too
     often only costs speed — the wall is rebuilt whole and is right. Saying a
     tile's name when something else also changed leaves that something
     undrawn, and the wall disagrees with the document until the next full
     build happens to come along. Every case below is a way of being wrong in
     the second direction. */
  const print = (m: Manifest) => wallPrint(view(m), m);

  it("names the tile that changed", () => {
    const m = dressed(9);
    const before = print(m);
    const [, target] = order(m);
    m.tiles[target].layers.push(newImageLayer("disc:#ff0000"));
    expect(soleTileChange(before, print(m))).toBe(target);
  });

  it("says nothing when nothing changed", () => {
    const m = dressed(9);
    expect(soleTileChange(print(m), print(m))).toBe("");
  });

  it("refuses when two tiles changed", () => {
    const m = dressed(9);
    const before = print(m);
    const [a, b] = order(m);
    m.tiles[a].layers.push(newImageLayer("disc:#ff0000"));
    m.tiles[b].layers.push(newImageLayer("disc:#00ff00"));
    expect(soleTileChange(before, print(m))).toBe("");
  });

  it("refuses when the picture across the wall moved", () => {
    /* A grid layer is drawn once for the whole wall, so no per-tile rebuild
       can touch it — and it is the change most likely to arrive alongside a
       tile edit, since dragging it also selects it. */
    const m = dressed(9);
    const spread = newImageLayer("block:#0000ff");
    spread.space = "grid";
    m.projects[0].gridLayers.push(spread);
    const before = print(m);
    spread.x = 0.4;
    expect(soleTileChange(before, print(m))).toBe("");
  });

  it("refuses when the wall gained, lost or reordered a tile", () => {
    const m = dressed(9);
    const before = print(m);
    m.projects[0].order = [...order(m).slice(1), order(m)[0]];
    expect(soleTileChange(before, print(m))).toBe("");

    const shorter = dressed(9);
    const wasShorter = print(shorter);
    shorter.projects[0].order = order(shorter).slice(0, 8);
    expect(soleTileChange(wasShorter, print(shorter))).toBe("");
  });

  it("refuses when there is nothing to compare against", () => {
    expect(soleTileChange(null, print(dressed(9)))).toBe("");
  });

  it("notices a change that adds no layer at all", () => {
    /* Wording lives beside the layers rather than in them, and so does the
       baked background, and each changes what the tile draws. A comparison that
       only looked at `layers` would call both "no change" and leave the edit
       off the wall. There were four of these: a swapped picture, a paint colour
       and a frame were records the tile kept about a design it wore, and every
       one of them is on the layer now. */
    const m = dressed(9);
    const [target] = order(m);
    const caption = m.tiles[target].layers[1];

    for (const edit of [
      () => (m.tiles[target].text = { [caption.id]: "renamed" }),
      // A baked mosaic: the tile's own background stops being the game's file.
      () =>
        (m.tiles[target].base = {
          asset: "block:#654321",
          crop: { x: 0, y: 0, w: 624, h: 804 },
        }),
    ]) {
      const before = print(m);
      edit();
      expect(soleTileChange(before, print(m))).toBe(target);
    }
  });
});

describe("rebuilding one tile", () => {
  it("leaves the canvas as a full build would", async () => {
    const m = dressed(9);
    const [, , target] = order(m);

    const incremental = wallCanvas(9);
    const full = wallCanvas(9);
    try {
      await buildGrid(incremental, view(m), m, testDeps, true);

      // The edit: one tile gains a picture the others do not have.
      const added = newImageLayer("disc:#ff0000");
      added.scale = 0.3;
      m.tiles[target].layers.push(added);

      await rebuildTile(incremental, target, view(m), m, testDeps, true);
      await buildGrid(full, view(m), m, testDeps, true);

      expect(shape(incremental)).toEqual(shape(full));
    } finally {
      await incremental.dispose();
      await full.dispose();
    }
  });

  it("puts a tile that lost its last layer back to bare", async () => {
    /* The direction that is easy to get wrong: adding objects is visible, and
       failing to remove the old ones is not — the new layer draws over the
       stale one and looks perfect until the layer is deleted. */
    const m = dressed(9);
    const [target] = order(m);

    const incremental = wallCanvas(9);
    const full = wallCanvas(9);
    try {
      await buildGrid(incremental, view(m), m, testDeps, true);
      m.tiles[target].layers = [];
      await rebuildTile(incremental, target, view(m), m, testDeps, true);
      await buildGrid(full, view(m), m, testDeps, true);

      expect(shape(incremental)).toEqual(shape(full));
      expect(incremental.getObjects().filter((o) => (o as { tileId?: string }).tileId === target))
        .toHaveLength(1); // its background, and nothing else
    } finally {
      await incremental.dispose();
      await full.dispose();
    }
  });

  it("keeps the rebuilt tile under the picture spread across the wall", async () => {
    /* The stacking rule a naive splice breaks. A tile's background belongs
       under the wall picture; appending the rebuilt one at the end of the list
       would draw it over the top, and the preview would contradict what Apply
       produces. */
    const m = dressed(9);
    const spread = newImageLayer("block:#0000ff");
    spread.space = "grid";
    m.projects[0].gridLayers.push(spread);
    const [target] = order(m);

    const canvas = wallCanvas(9);
    try {
      await buildGrid(canvas, view(m), m, testDeps, true);
      await rebuildTile(canvas, target, view(m), m, testDeps, true);

      const objects = canvas.getObjects();
      const spreadAt = objects.findIndex((o) => (o as { space?: string }).space === "grid");
      const backgroundAt = objects.findIndex(
        (o) => (o as { tileId?: string; space?: string }).tileId === target && (o as { space?: string }).space === "base",
      );
      const layerAt = objects.findIndex(
        (o) => (o as { tileId?: string; space?: string }).tileId === target && (o as { space?: string }).space === "tile",
      );
      expect(backgroundAt).toBeLessThan(spreadAt);
      expect(layerAt).toBeGreaterThan(spreadAt);
    } finally {
      await canvas.dispose();
    }
  });

  it("does not throw away what the placing tool put on the canvas", async () => {
    /* `keep` objects are the frame and ghost a drag is being aimed with, and
       the tile they stand on is the one being redrawn — the full build learned
       this the hard way (see buildGrid), and a per-tile path is the more
       tempting place to get it wrong. */
    const m = dressed(9);
    const [target] = order(m);

    const canvas = wallCanvas(9);
    try {
      await buildGrid(canvas, view(m), m, testDeps, true);
      const frame = new fabric.Rect({ width: 10, height: 10 });
      Object.assign(frame, { keep: true, tileId: target });
      canvas.add(frame);

      await rebuildTile(canvas, target, view(m), m, testDeps, true);

      const objects = canvas.getObjects();
      expect(objects).toContain(frame);
      expect(objects[objects.length - 1]).toBe(frame);
    } finally {
      await canvas.dispose();
    }
  });

  it("ignores a tile that is not on this wall", async () => {
    const m = dressed(9);
    const canvas = wallCanvas(9);
    try {
      await buildGrid(canvas, view(m), m, testDeps, true);
      const before = shape(canvas);
      await rebuildTile(canvas, "not-a-tile", view(m), m, testDeps, true);
      expect(shape(canvas)).toEqual(before);
    } finally {
      await canvas.dispose();
    }
  });
});

describe("a canvas that does not paint per object still paints on a zoom", () => {
  /* renderOnAddRemove is off on the wall, so building it does not repaint once
   * per object — a wall of forty-four was asking for hundreds of frames it
   * threw away. Fabric hangs something else on that same flag:
   *
   *   setViewportTransform(vpt) {
   *     this.viewportTransform = vpt;
   *     this.calcViewportBoundaries();
   *     this.renderOnAddRemove && this.requestRenderAll();
   *   }
   *
   * So with it off, a zoom and a pan change the transform and ask for nothing.
   * The screen then catches up only when something else happens to paint —
   * reported as "zoom only takes effect when I click something", and as a pan
   * that moves in steps. The flag reads as "render on add/remove"; it is the
   * canvas's auto-render switch, and the viewport rides on it. */
  it("asks for no frame at all — which is why GridCanvas asks for its own", async () => {
    const el = document.createElement("canvas");
    document.body.append(el);
    const canvas = new fabric.Canvas(el, { width: 400, height: 300, renderOnAddRemove: false });
    try {
      let asked = 0;
      const original = canvas.requestRenderAll.bind(canvas);
      canvas.requestRenderAll = () => {
        asked++;
        return original();
      };

      /* Asserted the way it actually is, so that a Fabric upgrade which starts
         requesting the frame itself fails here and whoever reads it can take
         the explicit calls in GridCanvas back out. */
      canvas.zoomToPoint(new fabric.Point(10, 10), 2);
      expect(asked).toBe(0);
      canvas.relativePan(new fabric.Point(15, 15));
      expect(asked).toBe(0);

      // And with the flag on, Fabric does ask — so this really is that switch.
      canvas.renderOnAddRemove = true;
      canvas.zoomToPoint(new fabric.Point(10, 10), 3);
      expect(asked).toBeGreaterThan(0);
    } finally {
      await canvas.dispose();
      el.remove();
    }
  });
});
