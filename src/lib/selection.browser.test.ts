/* Reading a transform back out of a multi-selection.
 *
 * Fabric re-expresses the children of an ActiveSelection around that
 * selection's centre, so their own left/top/angle stop being absolute the
 * moment they join one. readBackLayout goes through the transform matrix for
 * exactly that reason, and these tests are what keep it honest — the failure
 * mode is silent and only visible as layers jumping after a drag. */
import * as fabric from "fabric";
import { describe, expect, it } from "vitest";

import { TILE_H, TILE_W } from "./bmp";
import { newImageLayer, newLayout } from "./model";
import { buildLayout, readBackLayout } from "./scene";
import { testDeps } from "../test/images";

/** A Layout with two blocks at known spots, built onto a real interactive
 *  canvas (ActiveSelection needs one). */
async function twoBlocks() {
  const el = document.createElement("canvas");
  document.body.append(el);
  const canvas = new fabric.Canvas(el, { width: TILE_W, height: TILE_H });

  const layout = newLayout("T");
  for (const [x, y] of [
    [0.25, 0.25],
    [0.75, 0.25],
  ]) {
    const l = newImageLayer("block:#ff00ff");
    l.x = x;
    l.y = y;
    l.scale = 0.2;
    layout.layers.push(l);
  }
  await buildLayout(canvas, layout, testDeps, true);
  return { canvas, layout, el };
}

const near = (got: number, want: number, tol = 0.002) => Math.abs(got - want) <= tol;

describe("readBackLayout", () => {
  it("is unchanged by merely joining a selection", async () => {
    const { canvas, layout } = await twoBlocks();
    try {
      const objs = canvas.getObjects();
      const loose = objs.map(readBackLayout);

      canvas.setActiveObject(new fabric.ActiveSelection(objs, { canvas }));
      canvas.renderAll();
      const grouped = objs.map(readBackLayout);

      for (const [i, g] of grouped.entries()) {
        expect(near(g.x, loose[i].x)).toBe(true);
        expect(near(g.y, loose[i].y)).toBe(true);
        expect(near(g.scale, loose[i].scale)).toBe(true);
      }
      // And they still match the model they were built from.
      expect(near(grouped[0].x, layout.layers[0].x)).toBe(true);
      expect(near(grouped[1].x, layout.layers[1].x)).toBe(true);
    } finally {
      await canvas.dispose();
    }
  });

  it("moves every member by the same amount when the selection is dragged", async () => {
    const { canvas } = await twoBlocks();
    try {
      const objs = canvas.getObjects();
      const before = objs.map(readBackLayout);

      const sel = new fabric.ActiveSelection(objs, { canvas });
      canvas.setActiveObject(sel);
      sel.set({ left: (sel.left ?? 0) + 62.4, top: (sel.top ?? 0) + 80.4 });
      sel.setCoords();
      canvas.renderAll();

      for (const [i, after] of objs.map(readBackLayout).entries()) {
        expect(near(after.x - before[i].x, 0.1)).toBe(true);
        expect(near(after.y - before[i].y, 0.1)).toBe(true);
      }
    } finally {
      await canvas.dispose();
    }
  });

  it("rotating the selection turns each member and swings it around the centre", async () => {
    const { canvas } = await twoBlocks();
    try {
      const objs = canvas.getObjects();
      const before = objs.map(readBackLayout);
      // The two blocks sit level, so the midpoint between them is the pivot.
      const mid = {
        x: (before[0].x + before[1].x) / 2,
        y: (before[0].y + before[1].y) / 2,
      };

      const sel = new fabric.ActiveSelection(objs, { canvas });
      canvas.setActiveObject(sel);
      sel.rotate(90);
      sel.setCoords();
      canvas.renderAll();

      const after = objs.map(readBackLayout);
      for (const a of after) expect(near(a.rotation, 90, 0.5)).toBe(true);

      /* A 90° turn about the midpoint maps (dx, dy) to (-dy, dx). Written in
       * tile fractions, which are not square — 624x804 — so the offsets have to
       * cross between the axes in pixels, not in fractions. */
      for (const [i, a] of after.entries()) {
        const dxPx = (before[i].x - mid.x) * TILE_W;
        const dyPx = (before[i].y - mid.y) * TILE_H;
        expect(near(a.x, mid.x + -dyPx / TILE_W, 0.01)).toBe(true);
        expect(near(a.y, mid.y + dxPx / TILE_H, 0.01)).toBe(true);
      }
    } finally {
      await canvas.dispose();
    }
  });
});
