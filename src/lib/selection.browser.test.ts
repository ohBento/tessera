/* The geometry a gesture writes back, read off the wall the app draws.
 *
 * These ran against buildLayout — a tile-sized sheet with the layers at its
 * origin — because that was the canvas the layout editor put under your hands.
 * The wall is the only canvas now, so they build one tile of it and read the
 * same numbers back: cell 0 sits at the origin and is exactly one tile across,
 * so nothing about the coordinates changed. What did change is that they now
 * exercise the clipPath, the flattening and the interactive flags a tile layer
 * actually gets, none of which the sheet applied.
 */
import * as fabric from "fabric";
import { describe, expect, it } from "vitest";

import { TILE_H, TILE_W } from "./bmp";
import { gridSize } from "./geometry";
import {
  emptyManifest,
  emptyTile,
  newImageLayer,
  newProject,
  newShapeLayer,
  newTextLayer,
  type Layer,
} from "./model";
import {
  buildGrid,
  holdTo,
  readBack,
  scaleControls,
  snapWidth,
  trimTo,
  type Tagged,
} from "./scene";
import { testDeps } from "../test/images";

/** One tile of a wall, carrying the layers given, on a real interactive canvas.
 *
 *  `objs` is only what the tiles carry: buildGrid also lays down a background
 *  per cell, and the sheet had none, so indexing the canvas directly would pick
 *  up a different object than these tests were written against. */
async function tileWith(...layers: Layer[]) {
  const el = document.createElement("canvas");
  document.body.append(el);
  const size = gridSize(1);
  const canvas = new fabric.Canvas(el, { width: size.w, height: size.h });

  const m = emptyManifest();
  const project = newProject("T");
  project.order = ["t0"];
  m.projects = [project];
  m.tiles.t0 = emptyTile();
  m.tiles.t0.layers.push(...layers);

  await buildGrid(
    canvas,
    { ids: project.order, gridLayers: project.gridLayers },
    m,
    testDeps,
    true,
  );
  return { canvas, objs: canvas.getObjects().filter((o) => !!(o as Tagged).layerId) };
}

/** The one tile is the first cell, so the index is always 0. */
const back = (o: fabric.Object) => readBack(o as Tagged, 1, 0);

const near = (got: number, want: number, tol = 0.002) => Math.abs(got - want) <= tol;

describe("free scaling", () => {
  /** One layer of the given kind on a canvas, ready to be stretched. */
  async function one(make: () => Layer) {
    const layer = make();
    const { canvas, objs } = await tileWith(layer);
    return { canvas, layer, obj: objs[0] };
  }

  it("gives each kind the side handle it can honour, and no other", async () => {
    // A shape keeps width and height apart, so its sides stretch it.
    const shape = await one(() => newShapeLayer("rect"));
    try {
      expect(shape.obj.isControlVisible("ml")).toBe(true);
      expect(shape.obj.isControlVisible("mt")).toBe(true);
      expect(shape.obj.controls.ml.actionName).toBe("scale");
    } finally {
      await shape.canvas.dispose();
    }

    /* A picture has one scale, so a stretch has nowhere to live — its sides
     * crop it instead, which is a different action and stored in its own
     * field. Asserting the action and not just the handle, because a side
     * control that scaled a picture would look identical here and would spring
     * back on the next rebuild. */
    const picture = await one(() => newImageLayer("block:#ff00ff"));
    try {
      expect(picture.obj.isControlVisible("ml")).toBe(true);
      expect(picture.obj.isControlVisible("mt")).toBe(true);
      expect(picture.obj.controls.ml.actionName).toBe("crop");
      expect(picture.obj.controls.mb.actionName).toBe("crop");
    } finally {
      await picture.canvas.dispose();
    }

    /* A caption has all four, and not one of them is a scale: the sides set the
     * width its words wrap at, the top and bottom the height they are cut at.
     * Asserting the action as well as the handle, for the same reason the
     * picture above does — a side control that scaled a caption would look
     * identical here and would spring back on the next rebuild. */
    const text = await one(() => newTextLayer());
    try {
      expect(text.obj.isControlVisible("ml")).toBe(true);
      expect(text.obj.isControlVisible("mr")).toBe(true);
      expect(text.obj.isControlVisible("mt")).toBe(true);
      expect(text.obj.isControlVisible("mb")).toBe(true);
      expect(text.obj.controls.mt.actionName).toBe("resizing");
      expect(text.obj.controls.mb.actionName).toBe("resizing");
    } finally {
      await text.canvas.dispose();
    }
  });

  it("hands both callers the same handle rule", () => {
    /* The rule lives in scaleControls and nowhere else. It used to live in two
     * places — the scene put a caption's side handles on, LayoutCanvas took
     * every handle off again on selection — and the test above only ever asked
     * the scene, so the app shipped a caption with no handles at all while it
     * stayed green. Pinned here on the function both of them call. */
    expect(scaleControls(newTextLayer())).toEqual({
      tl: false, tr: false, bl: false, br: false,
      ml: true, mr: true, mt: true, mb: true,
    });
    expect(scaleControls(newShapeLayer("rect"))).toEqual({
      tl: true, tr: true, bl: true, br: true,
      ml: true, mr: true, mt: true, mb: true,
    });
    expect(scaleControls(newImageLayer("x.png"))).toEqual({
      tl: true, tr: true, bl: true, br: true,
      ml: true, mr: true, mt: true, mb: true,
    });
    /* A class icon is the exception among shapes. Its artwork is fitted to the
     * box, not stretched into it, so a side handle showed the icon growing for
     * as long as the mouse was down — the clip rides inside the object while a
     * drag is live — and the release refitted it and put it back. Corners only,
     * which Fabric holds proportional: what the drag shows is what is kept. */
    expect(scaleControls(newShapeLayer("icon", "Ranger"))).toEqual({
      tl: true, tr: true, bl: true, br: true,
      ml: false, mr: false, mt: false, mb: false,
    });
  });

  it("reads a stretched shape back as two different sizes", async () => {
    const { canvas, obj } = await one(() => {
      const l = newShapeLayer("rect");
      l.w = 0.4;
      l.h = 0.4;
      return l;
    });
    try {
      obj.set({ scaleX: (obj.scaleX ?? 1) * 2 });
      obj.setCoords();
      const read = back(obj);
      expect(read.scale).toBeCloseTo(0.8, 3);
      expect(read.scaleH).toBeCloseTo(0.4, 3);
      // The whole point: the two axes disagree, and both survive.
      expect(read.scale).not.toBeCloseTo(read.scaleH, 3);
    } finally {
      await canvas.dispose();
    }
  });
});

describe("reading a gesture back", () => {
  it("does not read a mirrored picture as a half turn", async () => {
    const l = newImageLayer("block:#ff00ff");
    l.scale = 0.2;
    l.flipX = true;
    const { canvas, objs } = await tileWith(l);
    try {
      /* A flip lives in the matrix as a negative scale, which decomposes into
       * angle + 180. Reading angle straight off the object sidesteps that, and
       * the model stores the flip separately in any case — so what this pins is
       * that a mirrored picture comes back level rather than upside down. */
      const read = back(objs[0]);
      expect(read.rotation).toBeCloseTo(0, 3);
      expect(read.fx).toBeGreaterThan(0);
      expect(read.fy).toBeGreaterThan(0);
    } finally {
      await canvas.dispose();
    }
  });

});

describe("side handles trim a picture instead of scaling it", () => {
  /* One picture, 200px square at source, drawn half a tile wide — so one
   * source pixel is 1.56 on screen, and every number below is that factor
   * applied to a distance the pointer travelled. */
  async function picture() {
    const l = newImageLayer("block:#ff00ff");
    l.x = 0.5;
    l.y = 0.5;
    l.scale = 0.5;
    const { canvas, objs } = await tileWith(l);
    return { canvas, img: objs[0] as fabric.FabricImage };
  }

  /** Where the picture's edges are on the canvas right now. */
  const edges = (img: fabric.FabricImage) => {
    const r = img.getBoundingRect();
    return { left: r.left, right: r.left + r.width, top: r.top, bottom: r.top + r.height };
  };

  it("moves the dragged edge and leaves the opposite one standing", async () => {
    const { canvas, img } = await picture();
    try {
      const before = edges(img);
      const scale = img.scaleX;
      // Pull the left edge in to x = 300, about a third of the way across.
      trimTo(img, "l", 300, 0.5 * TILE_H);

      const after = edges(img);
      expect(near(after.right, before.right, 0.5)).toBe(true);
      expect(near(after.left, 300, 1)).toBe(true);
      // The picture inside the frame is untouched: same source pixels, same
      // size on screen. Only the window over them narrowed.
      expect(img.scaleX).toBe(scale);
      expect(img.cropX + img.width).toBe(200);
    } finally {
      await canvas.dispose();
    }
  });

  it("gives back what was trimmed and stops at the picture's own edge", async () => {
    const { canvas, img } = await picture();
    try {
      const before = edges(img);
      trimTo(img, "l", 300, 0.5 * TILE_H);
      // Now drag far past where the picture ever reached.
      trimTo(img, "l", -2000, 0.5 * TILE_H);

      expect(img.cropX).toBe(0);
      expect(img.width).toBe(200);
      /* Back to exactly the picture it started as — no blank margin was
       * dragged in, and the anchored edge never moved through any of it. */
      expect(near(edges(img).left, before.left, 0.5)).toBe(true);
      expect(near(edges(img).right, before.right, 0.5)).toBe(true);
    } finally {
      await canvas.dispose();
    }
  });

  it("trims the far side without touching where the picture starts", async () => {
    const { canvas, img } = await picture();
    try {
      const before = edges(img);
      trimTo(img, "r", 380, 0.5 * TILE_H);

      expect(img.cropX).toBe(0);
      expect(near(edges(img).left, before.left, 0.5)).toBe(true);
      expect(near(edges(img).right, 380, 1)).toBe(true);
    } finally {
      await canvas.dispose();
    }
  });

  it("trims top and bottom without narrowing the picture", async () => {
    const { canvas, img } = await picture();
    try {
      const before = edges(img);
      trimTo(img, "t", 0.5 * TILE_W, 300);

      const after = edges(img);
      expect(near(after.bottom, before.bottom, 0.5)).toBe(true);
      expect(near(after.top, 300, 1)).toBe(true);
      expect(near(after.left, before.left, 0.5)).toBe(true);
      expect(near(after.right, before.right, 0.5)).toBe(true);
      expect(img.cropY + img.height).toBe(200);
    } finally {
      await canvas.dispose();
    }
  });
});

describe("a trim survives the trip back into the model", () => {
  /* The coupling worth pinning: `scale` measures what the crop leaves, so the
   * two have to be read back together. Storing one without the other puts the
   * picture back at the wrong size on the next rebuild, and nothing about the
   * canvas would look wrong until then. */
  async function built(crop?: { l: number; r: number; t: number; b: number }) {
    const l = newImageLayer("block:#ff00ff");
    l.x = 0.5;
    l.y = 0.5;
    l.scale = 0.5;
    if (crop) l.crop = crop;
    const { canvas, objs } = await tileWith(l);
    return { canvas, img: objs[0] as fabric.FabricImage };
  }

  it("reports the trim and the width of what is left", async () => {
    const { canvas, img } = await built();
    try {
      trimTo(img, "l", 300, 0.5 * TILE_H);
      const read = back(img);

      expect(read.crop?.l).toBeCloseTo(img.cropX / 200, 5);
      expect(read.crop?.r).toBeCloseTo(0, 5);
      expect(read.scale).toBeCloseTo((img.width * img.scaleX) / TILE_W, 5);
    } finally {
      await canvas.dispose();
    }
  });

  it("comes back off the canvas as the crop it was built from", async () => {
    const crop = { l: 0.25, r: 0.1, t: 0.05, b: 0.15 };
    const { canvas, img } = await built(crop);
    try {
      const read = back(img);
      expect(read.crop?.l).toBeCloseTo(crop.l, 4);
      expect(read.crop?.r).toBeCloseTo(crop.r, 4);
      expect(read.crop?.t).toBeCloseTo(crop.t, 4);
      expect(read.crop?.b).toBeCloseTo(crop.b, 4);
      // Built at 0.5 and merely read back: a round trip must not resize it.
      expect(read.scale).toBeCloseTo(0.5, 4);
    } finally {
      await canvas.dispose();
    }
  });

  it("reports nothing at all for a picture nobody trimmed", async () => {
    const { canvas, img } = await built();
    try {
      expect(back(img).crop).toBeUndefined();
    } finally {
      await canvas.dispose();
    }
  });
});

describe("the crop handle is wired to the mouse", () => {
  /* Everything above calls trimTo directly. This one goes through Fabric:
   * press the handle, move, release. It is the half that unit-level tests
   * cannot see — a control assigned to the wrong property, or an action Fabric
   * never dispatches, would leave all of them green and the handle dead. */
  it("trims the picture when its left handle is dragged", async () => {
    const l = newImageLayer("block:#ff00ff");
    l.x = 0.5;
    l.y = 0.5;
    l.scale = 0.5;
    const { canvas, objs } = await tileWith(l);
    try {
      const img = objs[0] as fabric.FabricImage;
      canvas.setActiveObject(img);
      canvas.renderAll();

      const r = canvas.upperCanvasEl.getBoundingClientRect();
      const at = (x: number, y: number, type: string, on: EventTarget) =>
        on.dispatchEvent(
          new MouseEvent(type, {
            clientX: r.left + x,
            clientY: r.top + y,
            bubbles: true,
            button: 0,
          }),
        );

      // The left handle sits on the left edge at half height.
      const edge = img.getBoundingRect();
      at(edge.left, 0.5 * TILE_H, "mousedown", canvas.upperCanvasEl);
      at(edge.left + 90, 0.5 * TILE_H, "mousemove", document);
      at(edge.left + 90, 0.5 * TILE_H, "mouseup", document);

      expect(img.cropX).toBeGreaterThan(0);
      expect(img.width).toBeLessThan(200);
      // Trimmed, not squashed: the picture behind the frame is the same size.
      expect(img.scaleX).toBeCloseTo(img.scaleY, 6);
    } finally {
      await canvas.dispose();
    }
  });
});

describe("a caption's width handle snaps", () => {
  /** One layer on a real interactive canvas — the same shape the free-scaling
   *  block above uses, spelled again because that one is scoped to it. */
  async function one(make: () => Layer) {
    const { canvas, objs } = await tileWith(make());
    return { canvas, obj: objs[0] };
  }

  /* It did not, and the reason was the event: Fabric gives a Textbox's side
   * handle a `changeWidth` action that writes `width` and leaves `scaleX` at
   * one, firing `object:resizing` — while the snapping hung on
   * `object:scaling`. So the caption was the one layer that slid past every
   * guide in the sheet. */
  it("pulls the dragged edge onto a nearby line and leaves the other one still", async () => {
    const { canvas, obj } = await one(() => {
      const l = newTextLayer();
      l.x = 0.5;
      l.y = 0.5;
      l.w = 0.3;
      l.text = "Text";
      return l;
    });
    try {
      obj.setCoords();
      const before = obj.getBoundingRect();
      // A line four pixels beyond the right edge — inside the eight-pixel pull.
      const target = { left: before.left + before.width + 4, top: 0, width: 0, height: TILE_H };

      const guides = snapWidth(obj, "mr", [target], 8);

      expect(guides.length).toBe(1);
      obj.setCoords();
      const after = obj.getBoundingRect();
      expect(after.left + after.width).toBeCloseTo(target.left, 0);
      // The edge the pointer is not holding does not move.
      expect(after.left).toBeCloseTo(before.left, 0);
    } finally {
      await canvas.dispose();
    }
  });

  it("leaves a rotated caption alone", async () => {
    // Its bounding rect has no edge that belongs to the box any more.
    const { canvas, obj } = await one(() => {
      const l = newTextLayer();
      l.w = 0.3;
      l.rotation = 20;
      return l;
    });
    try {
      obj.setCoords();
      const before = obj.getBoundingRect();
      const guides = snapWidth(obj, "mr", [{ left: before.left + before.width + 4, top: 0, width: 0, height: TILE_H }], 8);
      expect(guides).toEqual([]);
    } finally {
      await canvas.dispose();
    }
  });
});

describe("a caption's height handle", () => {
  async function one(make: () => Layer) {
    const { canvas, objs } = await tileWith(make());
    return { canvas, obj: objs[0] as fabric.Object & { boxH?: number } };
  }

  const held = () =>
    Object.assign(newTextLayer(), { x: 0.5, y: 0.5, w: 0.4, h: 0.2, text: "Text" });

  it("drags the bottom edge and leaves the top one where it was", async () => {
    /* The box is centred on the layer, so growing it downwards has to move the
     * centre down by half — the same bookkeeping a picture's crop does. */
    const { canvas, obj } = await one(held);
    try {
      const was = 0.2 * TILE_H;
      const topEdge = (obj.top ?? 0) - was / 2;

      expect(holdTo(obj, "b", 0, topEdge + 300)).toBe(true);

      expect(obj.boxH).toBeCloseTo(300, 0);
      expect((obj.top ?? 0) - (obj.boxH ?? 0) / 2).toBeCloseTo(topEdge, 0);
      // The clip follows the pointer rather than appearing when the drag ends.
      expect((obj.clipPath as fabric.Rect).height).toBeCloseTo(300, 0);
    } finally {
      await canvas.dispose();
    }
  });

  it("never lets the box collapse to nothing", async () => {
    const { canvas, obj } = await one(held);
    try {
      const topEdge = (obj.top ?? 0) - (0.2 * TILE_H) / 2;
      holdTo(obj, "b", 0, topEdge - 500);
      expect(obj.boxH).toBeGreaterThanOrEqual(8);
    } finally {
      await canvas.dispose();
    }
  });

  it("snaps the dragged edge onto a nearby line", async () => {
    /* The height handle reports itself as `resizing`, like the width one, so
     * both ends of the box arrive at the same listener and get the same pull —
     * which is the whole reason snapWidth measures the box vertically rather
     * than the text. */
    const { canvas, obj } = await one(held);
    try {
      const was = 0.2 * TILE_H;
      const bottom = (obj.top ?? 0) + was / 2;
      const line = { left: 0, top: bottom + 4, width: TILE_W, height: 0 };

      const guides = snapWidth(obj, "mb", [line], 8);

      expect(guides.length).toBe(1);
      expect((obj.top ?? 0) + (obj.boxH ?? 0) / 2).toBeCloseTo(line.top, 0);
    } finally {
      await canvas.dispose();
    }
  });
});
