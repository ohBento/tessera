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
import { newImageLayer, newShapeLayer, newTextLayer, type Layer } from "./model";

/** What these tests ever wanted from a Layout: an empty stack to fill. The type
 *  went with the editor; buildLayout takes the layers themselves now. */
const newLayout = (_name: string) => ({ layers: [] as Layer[] });
import { buildLayout, holdTo, readBackLayout, scaleControls, snapWidth, trimTo } from "./scene";
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

describe("free scaling", () => {
  /** One layer of the given kind on a canvas, ready to be stretched. */
  async function one(make: () => Layer) {
    const el = document.createElement("canvas");
    document.body.append(el);
    const canvas = new fabric.Canvas(el, { width: TILE_W, height: TILE_H });
    const layout = newLayout("S");
    layout.layers.push(make());
    await buildLayout(canvas, layout, testDeps, true);
    return { canvas, layer: layout.layers[0], obj: canvas.getObjects()[0] };
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
      const back = readBackLayout(obj);
      expect(back.scale).toBeCloseTo(0.8, 3);
      expect(back.scaleH).toBeCloseTo(0.4, 3);
      // The whole point: the two axes disagree, and both survive.
      expect(back.scale).not.toBeCloseTo(back.scaleH, 3);
    } finally {
      await canvas.dispose();
    }
  });
});

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

  it("does not read a mirrored picture as a half turn", async () => {
    const el = document.createElement("canvas");
    document.body.append(el);
    const canvas = new fabric.Canvas(el, { width: TILE_W, height: TILE_H });
    try {
      const layout = newLayout("M");
      const l = newImageLayer("block:#ff00ff");
      l.scale = 0.2;
      l.flipX = true;
      layout.layers.push(l);
      await buildLayout(canvas, layout, testDeps, true);

      /* A flip lives in the matrix as a negative scale, which decomposes into
       * angle + 180. The model stores the flip separately, so taking that at
       * face value wrote rotation 180 on the first plain drag and the next
       * rebuild stood the picture on its head. */
      const back = readBackLayout(canvas.getObjects()[0]);
      expect(back.rotation).toBeCloseTo(0, 3);
      expect(back.fx).toBeGreaterThan(0);
      expect(back.fy).toBeGreaterThan(0);
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

describe("what a mask cuts away stops being clickable", () => {
  /* A clip is a painting instruction; Fabric hit-tests the bounding box, which
   * a mask never shrinks. So a picture cropped to a small window went on
   * catching every click across its full original size — over the layers under
   * it and over bare canvas — and the only way past it was to lock the layer.
   *
   * Both directions are pinned. Losing the fall-through brings the complaint
   * back; losing the hit inside the window would be worse, because a layer you
   * can see and cannot click is one you can only reach from the list. */
  async function maskedOverBlock() {
    const el = document.createElement("canvas");
    document.body.append(el);
    const canvas = new fabric.Canvas(el, { width: TILE_W, height: TILE_H });

    const layout = newLayout("T");

    // Underneath, left of centre and well clear of the window.
    const under = newImageLayer("block:#00ff00");
    under.x = 0.15;
    under.y = 0.5;
    under.scale = 0.15;

    // On top, tile-wide, so it covers the block completely before the mask.
    const over = newImageLayer("block:#ff00ff");
    over.x = 0.5;
    over.y = 0.5;
    over.scale = 1;

    // The window: a small rect over on the right, nowhere near the block.
    const window = newShapeLayer("rect");
    window.x = 0.8;
    window.y = 0.5;
    window.w = 0.2;
    window.h = 0.2;
    over.maskId = window.id;

    layout.layers.push(under, over, window);
    await buildLayout(canvas, layout, testDeps, true);
    return { canvas, under, over };
  }

  /** Which layer a click at that spot on the canvas would pick up. */
  function layerAt(canvas: fabric.Canvas, x: number, y: number) {
    const r = canvas.upperCanvasEl.getBoundingClientRect();
    const e = new MouseEvent("mousedown", { clientX: r.left + x, clientY: r.top + y });
    /* findTarget is how Fabric answers a click. Not in the public types, and it
     * hands back a report about the hit rather than the object — reading
     * layerId straight off it silently yields undefined for every point. */
    const hit = (
      canvas as unknown as { findTarget(e: MouseEvent): { target?: fabric.FabricObject } }
    ).findTarget(e);
    return (hit.target as { layerId?: string } | undefined)?.layerId;
  }

  it("hands the click to the layer underneath", async () => {
    const { canvas, under } = await maskedOverBlock();
    try {
      // Centre of the block: covered by the masked picture, cut away from it.
      expect(layerAt(canvas, 0.15 * TILE_W, 0.5 * TILE_H)).toBe(under.id);
    } finally {
      await canvas.dispose();
    }
  });

  it("still picks the masked layer up inside its window", async () => {
    const { canvas, over } = await maskedOverBlock();
    try {
      expect(layerAt(canvas, 0.8 * TILE_W, 0.5 * TILE_H)).toBe(over.id);
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
    const el = document.createElement("canvas");
    document.body.append(el);
    const canvas = new fabric.Canvas(el, { width: TILE_W, height: TILE_H });

    const layout = newLayout("T");
    const l = newImageLayer("block:#ff00ff");
    l.x = 0.5;
    l.y = 0.5;
    l.scale = 0.5;
    layout.layers.push(l);
    await buildLayout(canvas, layout, testDeps, true);
    return { canvas, img: canvas.getObjects()[0] as fabric.FabricImage };
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
    const el = document.createElement("canvas");
    document.body.append(el);
    const canvas = new fabric.Canvas(el, { width: TILE_W, height: TILE_H });
    const layout = newLayout("T");
    const l = newImageLayer("block:#ff00ff");
    l.x = 0.5;
    l.y = 0.5;
    l.scale = 0.5;
    if (crop) l.crop = crop;
    layout.layers.push(l);
    await buildLayout(canvas, layout, testDeps, true);
    return { canvas, img: canvas.getObjects()[0] as fabric.FabricImage };
  }

  it("reports the trim and the width of what is left", async () => {
    const { canvas, img } = await built();
    try {
      trimTo(img, "l", 300, 0.5 * TILE_H);
      const back = readBackLayout(img);

      expect(back.crop?.l).toBeCloseTo(img.cropX / 200, 5);
      expect(back.crop?.r).toBeCloseTo(0, 5);
      expect(back.scale).toBeCloseTo((img.width * img.scaleX) / TILE_W, 5);
    } finally {
      await canvas.dispose();
    }
  });

  it("comes back off the canvas as the crop it was built from", async () => {
    const crop = { l: 0.25, r: 0.1, t: 0.05, b: 0.15 };
    const { canvas, img } = await built(crop);
    try {
      const back = readBackLayout(img);
      expect(back.crop?.l).toBeCloseTo(crop.l, 4);
      expect(back.crop?.r).toBeCloseTo(crop.r, 4);
      expect(back.crop?.t).toBeCloseTo(crop.t, 4);
      expect(back.crop?.b).toBeCloseTo(crop.b, 4);
      // Built at 0.5 and merely read back: a round trip must not resize it.
      expect(back.scale).toBeCloseTo(0.5, 4);
    } finally {
      await canvas.dispose();
    }
  });

  it("reports nothing at all for a picture nobody trimmed", async () => {
    const { canvas, img } = await built();
    try {
      expect(readBackLayout(img).crop).toBeUndefined();
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
    const el = document.createElement("canvas");
    document.body.append(el);
    const canvas = new fabric.Canvas(el, { width: TILE_W, height: TILE_H });
    try {
      const layout = newLayout("T");
      const l = newImageLayer("block:#ff00ff");
      l.x = 0.5;
      l.y = 0.5;
      l.scale = 0.5;
      layout.layers.push(l);
      await buildLayout(canvas, layout, testDeps, true);

      const img = canvas.getObjects()[0] as fabric.FabricImage;
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
    const el = document.createElement("canvas");
    document.body.append(el);
    const canvas = new fabric.Canvas(el, { width: TILE_W, height: TILE_H });
    const layout = newLayout("S");
    layout.layers.push(make());
    await buildLayout(canvas, layout, testDeps, true);
    return { canvas, obj: canvas.getObjects()[0] };
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
    const el = document.createElement("canvas");
    document.body.append(el);
    const canvas = new fabric.Canvas(el, { width: TILE_W, height: TILE_H });
    const layout = newLayout("H");
    layout.layers.push(make());
    await buildLayout(canvas, layout, testDeps, true);
    return { canvas, obj: canvas.getObjects()[0] as fabric.Object & { boxH?: number } };
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
