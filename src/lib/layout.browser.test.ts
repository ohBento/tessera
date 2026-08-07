/* Runs in a real Chromium (see vitest.config.ts): Fabric and canvas.toBlob
 * both need a DOM. */
import { describe, expect, it } from "vitest";

import { TILE_H, TILE_W } from "./bmp";
import { renderLayout } from "./layout";
import * as fabric from "fabric";

import { buildLayout } from "./scene";
import { newGroupLayer, newImageLayer, newLayout, newShapeLayer, newTextLayer } from "./model";
import { testDeps } from "../test/images";

/** Decodes a PNG back into pixels, the same shape pixel-reading tests
 *  elsewhere use, so a rendered Layout can be checked the same way a BMP is. */
async function decode(bytes: Uint8Array) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  return { width: bmp.width, height: bmp.height, data: ctx.getImageData(0, 0, bmp.width, bmp.height).data };
}

describe("renderLayout", () => {
  it("renders at exactly tile resolution", async () => {
    const layout = newLayout("Leer");
    const { width, height } = await decode(await renderLayout(layout, testDeps));
    expect(width).toBe(TILE_W);
    expect(height).toBe(TILE_H);
  });

  it("puts a layer's picture where its x/y says, at tile scale", async () => {
    const layout = newLayout("Ecke");
    const l = newImageLayer("block:#ff00ff");
    l.x = 0.15;
    l.y = 0.2;
    l.scale = 0.1;
    layout.layers.push(l);

    const { data, width } = await decode(await renderLayout(layout, testDeps));
    const px = (x: number, y: number) => {
      const o = (y * width + x) * 4;
      return [data[o], data[o + 1], data[o + 2], data[o + 3]];
    };

    expect(px(Math.round(l.x * TILE_W), Math.round(l.y * TILE_H))).toEqual([255, 0, 255, 255]);
    // Far corner stays untouched (transparent, since a Layout has no background).
    expect(px(TILE_W - 2, TILE_H - 2)[3]).toBe(0);
  });

  /** A layer at a known spot, small enough that one probe pixel is unambiguous. */
  const block = (x: number, y: number) => {
    const l = newImageLayer("block:#ff00ff");
    l.x = x;
    l.y = y;
    l.scale = 0.1;
    return l;
  };

  const probe = async (layout: Parameters<typeof renderLayout>[0]) => {
    const { data, width } = await decode(await renderLayout(layout, testDeps));
    return (x: number, y: number) => {
      const o = (Math.round(y * TILE_H) * width + Math.round(x * TILE_W)) * 4;
      return [data[o], data[o + 1], data[o + 2], data[o + 3]];
    };
  };

  const MAGENTA = [255, 0, 255, 255];

  it("draws a group's members, and grouping alone moves nothing", async () => {
    const flat = newLayout("Flach");
    flat.layers.push(block(0.2, 0.3), block(0.7, 0.8));

    const grouped = newLayout("Gruppiert");
    grouped.layers.push(newGroupLayer([block(0.2, 0.3), block(0.7, 0.8)]));

    const before = await probe(flat);
    const after = await probe(grouped);
    for (const [x, y] of [
      [0.2, 0.3],
      [0.7, 0.8],
    ]) {
      expect(after(x, y)).toEqual(MAGENTA);
      expect(after(x, y)).toEqual(before(x, y));
    }
  });

  it("shifts every member when the group is moved", async () => {
    const layout = newLayout("Verschoben");
    const group = newGroupLayer([block(0.2, 0.3), block(0.7, 0.5)]);
    group.x = 0.6; // +0.1 over the neutral 0.5
    layout.layers.push(group);

    const px = await probe(layout);
    expect(px(0.3, 0.3)).toEqual(MAGENTA); // moved here
    expect(px(0.8, 0.5)).toEqual(MAGENTA);
    expect(px(0.2, 0.3)[3]).toBe(0); // and left this empty
  });

  it("hides and locks a whole group through its members", async () => {
    const layout = newLayout("Versteckte Gruppe");
    const group = newGroupLayer([block(0.3, 0.3)]);
    group.hidden = true;
    layout.layers.push(group);

    const { data } = await decode(await renderLayout(layout, testDeps));
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque++;
    expect(opaque).toBe(0);
  });

  /** How many pixels in the rendered sheet are not fully transparent. */
  async function opaqueCount(layout: Parameters<typeof renderLayout>[0]) {
    const { data } = await decode(await renderLayout(layout, testDeps));
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
    return n;
  }

  it("draws a caption, and its colour is the one asked for", async () => {
    const layout = newLayout("Text");
    const l = newTextLayer();
    l.text = "ABC";
    l.color = "#ff00ff";
    l.size = 0.2;
    l.y = 0.5;
    layout.layers.push(l);

    const { data, width } = await decode(await renderLayout(layout, testDeps));
    let magenta = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] > 200 && data[i + 3] > 200) magenta++;
    }
    // Real glyphs, not a stray pixel or a filled box.
    expect(magenta).toBeGreaterThan(400);
    expect(magenta).toBeLessThan(width * TILE_H * 0.5);
  });

  it("renders each shape kind, and a bigger one covers more", async () => {
    for (const shape of ["rect", "ellipse", "polygon"] as const) {
      const small = newLayout(shape);
      const a = newShapeLayer(shape);
      a.fill = "#ff00ff";
      small.layers.push(a);

      const big = newLayout(shape);
      const b = newShapeLayer(shape);
      b.fill = "#ff00ff";
      b.w = a.w * 2;
      b.h = a.h * 2;
      big.layers.push(b);

      const [n, m] = [await opaqueCount(small), await opaqueCount(big)];
      expect(n).toBeGreaterThan(1000);
      expect(m).toBeGreaterThan(n * 2);
    }
  });

  it("fills an ellipse with fewer pixels than the rectangle around it", async () => {
    const mk = (shape: "rect" | "ellipse") => {
      const layout = newLayout(shape);
      const l = newShapeLayer(shape);
      l.fill = "#ff00ff";
      l.w = 0.5;
      l.h = 0.5;
      layout.layers.push(l);
      return layout;
    };
    const rect = await opaqueCount(mk("rect"));
    const ellipse = await opaqueCount(mk("ellipse"));
    // pi/4 of the box, give or take antialiasing.
    expect(ellipse / rect).toBeGreaterThan(0.7);
    expect(ellipse / rect).toBeLessThan(0.85);
  });

  it("paints a gradient, so the two ends differ", async () => {
    const layout = newLayout("Verlauf");
    const l = newShapeLayer("rect");
    l.w = 0.8;
    l.h = 0.4;
    l.fill = { from: "#ff0000", to: "#0000ff", angle: 0 };
    layout.layers.push(l);

    const px = await probe(layout);
    const left = px(0.15, 0.5);
    const right = px(0.85, 0.5);
    expect(left[0]).toBeGreaterThan(left[2]); // red end
    expect(right[2]).toBeGreaterThan(right[0]); // blue end
  });

  it("gives a short caption a box no wider than the words need", async () => {
    /* The frame is the grab target. A box the width of the whole tile put the
     * handles nowhere near a two-word caption, and made left-aligned text
     * start at the tile's edge whatever x said. */
    const layout = newLayout("Kurz");
    const short = newTextLayer();
    short.text = "Hi";
    short.size = 0.08;
    layout.layers.push(short);

    const canvas = new fabric.StaticCanvas(undefined, { width: TILE_W, height: TILE_H });
    try {
      await buildLayout(canvas, layout, testDeps);
      const box = canvas.getObjects()[0];
      expect(box.width).toBeLessThan(TILE_W / 3);

      // And a caption too long for the tile still wraps at its edge.
      canvas.remove(...canvas.getObjects());
      const long = newTextLayer();
      long.text = "Ein sehr viel längerer Satz, der über die Kachel hinausliefe";
      long.size = 0.08;
      await buildLayout(canvas, { ...layout, layers: [long] }, testDeps);
      expect(canvas.getObjects()[0].width).toBe(TILE_W);
    } finally {
      await canvas.dispose();
    }
  });

  it("keeps a per-tile caption out of the stamp but bakes an ordinary one", async () => {
    const withCaption = (perTile: boolean) => {
      const layout = newLayout("PT");
      const l = newTextLayer();
      l.text = "ABC";
      l.size = 0.2;
      l.y = 0.5;
      l.perTile = perTile;
      layout.layers.push(l);
      return layout;
    };
    // Baked: real glyph pixels. Live: nothing at all in the picture, because
    // it is copied onto the tiles as a layer instead.
    expect(await opaqueCount(withCaption(false))).toBeGreaterThan(400);
    expect(await opaqueCount(withCaption(true))).toBe(0);
  });

  it("skips a hidden layer", async () => {
    const layout = newLayout("Versteckt");
    const l = newImageLayer("block:#ff00ff");
    l.x = 0.5;
    l.y = 0.5;
    l.scale = 0.5;
    l.hidden = true;
    layout.layers.push(l);

    const { data } = await decode(await renderLayout(layout, testDeps));
    // Nothing opaque anywhere — the whole canvas stayed blank.
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque++;
    expect(opaque).toBe(0);
  });
});

describe("group opacity", () => {
  it("fades every member by the group's own opacity, nested included", async () => {
    /* The panel offers the slider on a group, so the renderer has to honour
     * it — it used to be dropped in the flattening, a control that did
     * nothing. Multiplied, not replaced: a half-faded child in a half-faded
     * group is quarter-faded. */
    const layout = newLayout("Fade");
    const dim = newShapeLayer("rect");
    dim.opacity = 0.8;
    const inner = newGroupLayer([dim]);
    inner.opacity = 0.5;
    const solo = newShapeLayer("ellipse");
    const outer = newGroupLayer([inner]);
    outer.opacity = 0.5;
    layout.layers.push(outer, solo);

    const el = document.createElement("canvas");
    document.body.append(el);
    const canvas = new fabric.Canvas(el, { width: TILE_W, height: TILE_H });
    try {
      await buildLayout(canvas, layout, testDeps, true);
      const by = (id: string) =>
        canvas.getObjects().find((o) => (o as { layerId?: string }).layerId === id);
      expect(by(dim.id)?.opacity).toBeCloseTo(0.8 * 0.5 * 0.5, 5);
      // A loose layer is untouched by someone else's group.
      expect(by(solo.id)?.opacity).toBe(1);
    } finally {
      await canvas.dispose();
    }
  });
});

describe("masks", () => {
  const decodeProbe = async (layout: Parameters<typeof renderLayout>[0]) => {
    const bytes = await renderLayout(layout, testDeps);
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return (x: number, y: number) => {
      const o = (Math.round(y * TILE_H) * bmp.width + Math.round(x * TILE_W)) * 4;
      return [data[o], data[o + 1], data[o + 2], data[o + 3]];
    };
  };

  /** A picture over the whole sheet, and a small circle in the middle of it. */
  function sheet() {
    const layout = newLayout("Maske");
    const pic = newImageLayer("block:#ff00ff");
    pic.x = 0.5;
    pic.y = 0.5;
    pic.scale = 1;
    const hole = newShapeLayer("ellipse");
    hole.x = 0.5;
    hole.y = 0.5;
    hole.w = 0.3;
    hole.h = 0.3;
    layout.layers.push(hole, pic);
    return { layout, pic, hole };
  }

  it("keeps what lies inside the shape and drops the rest", async () => {
    const { layout, pic, hole } = sheet();
    pic.maskId = hole.id;
    const px = await decodeProbe(layout);
    expect(px(0.5, 0.5)).toEqual([255, 0, 255, 255]);
    // Well outside the circle but well inside the picture.
    expect(px(0.1, 0.5)[3]).toBe(0);
  });

  it("turns it round when inverted", async () => {
    const { layout, pic, hole } = sheet();
    pic.maskId = hole.id;
    pic.maskInvert = true;
    const px = await decodeProbe(layout);
    expect(px(0.5, 0.5)[3]).toBe(0);
    expect(px(0.1, 0.5)).toEqual([255, 0, 255, 255]);
  });

  it("does not paint the shape it cuts with", async () => {
    /* The shape is the hole, not something in the picture. Given a fill of its
     * own, what shows through the hole has to be the picture's colour and not
     * the shape's — and the shape lies on top, so it would win if it painted. */
    const { layout, pic, hole } = sheet();
    hole.fill = "#00ff00";
    layout.layers = [pic, hole];
    pic.maskId = hole.id;

    const px = await decodeProbe(layout);
    expect(px(0.5, 0.5)).toEqual([255, 0, 255, 255]);
    expect(px(0.1, 0.5)[3]).toBe(0);
  });

  it("cuts where the shape sits, group displacement and all", async () => {
    const layout = newLayout("Maske im Verbund");
    const pic = newImageLayer("block:#ff00ff");
    pic.x = 0.5;
    pic.y = 0.5;
    pic.scale = 1;
    const hole = newShapeLayer("rect");
    hole.x = 0.5;
    hole.y = 0.5;
    hole.w = 0.2;
    hole.h = 0.2;
    const group = newGroupLayer([hole]);
    // A group's x is measured from the middle (groupShift), so 0.75 shifts
    // its member a quarter of the tile to the right.
    group.x = 0.75;
    pic.maskId = hole.id;
    layout.layers.push(group, pic);

    const px = await decodeProbe(layout);
    expect(px(0.75, 0.5)).toEqual([255, 0, 255, 255]);
    expect(px(0.5, 0.5)[3]).toBe(0);
  });

  it("draws unclipped when the shape is gone", async () => {
    const { layout, pic } = sheet();
    pic.maskId = "nie-dagewesen";
    const px = await decodeProbe(layout);
    expect(px(0.1, 0.5)).toEqual([255, 0, 255, 255]);
  });
});

describe("masks and the stamp", () => {
  const probe = async (layout: Parameters<typeof renderLayout>[0]) => {
    const bytes = await renderLayout(layout, testDeps);
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return (x: number, y: number) => {
      const o = (Math.round(y * TILE_H) * bmp.width + Math.round(x * TILE_W)) * 4;
      return [data[o], data[o + 1], data[o + 2], data[o + 3]];
    };
  };

  it("keeps a mask shape out of the stamp even when its only user is live", async () => {
    /* bakeable() strips the layers a Layout keeps live on the tiles, and the
     * stencil set was worked out from what was left — so a shape whose only
     * user was such a layer stopped counting as a hole and painted itself into
     * the stamp instead. That stamp goes onto every tile wearing the Layout,
     * and from there into the BMP the game reads. */
    const layout = newLayout("Loch fuer eine lebende Ebene");
    const hole = newShapeLayer("ellipse");
    hole.x = 0.5;
    hole.y = 0.5;
    hole.w = 0.3;
    hole.h = 0.3;
    hole.fill = "#00ff00";
    const live = newImageLayer("block:#ff00ff");
    live.x = 0.5;
    live.y = 0.5;
    live.scale = 1;
    live.perTile = true;
    live.maskId = hole.id;
    layout.layers.push(hole, live);

    const px = await probe(layout);
    // The stamp holds neither the live picture nor the shape that cuts it.
    expect(px(0.5, 0.5)[3]).toBe(0);
  });
});

describe("masks and the eye", () => {
  const probe = async (layout: Parameters<typeof renderLayout>[0]) => {
    const bytes = await renderLayout(layout, testDeps);
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return (x: number, y: number) => {
      const o = (Math.round(y * TILE_H) * bmp.width + Math.round(x * TILE_W)) * 4;
      return [data[o], data[o + 1], data[o + 2], data[o + 3]];
    };
  };

  function sheet() {
    const layout = newLayout("Auge");
    const hole = newShapeLayer("ellipse");
    hole.x = 0.5;
    hole.y = 0.5;
    hole.w = 0.3;
    hole.h = 0.3;
    const pic = newImageLayer("block:#ff00ff");
    pic.x = 0.5;
    pic.y = 0.5;
    pic.scale = 1;
    pic.maskId = hole.id;
    layout.layers.push(hole, pic);
    return { layout, pic, hole };
  }

  it("stops cutting once the shape is switched off", async () => {
    // The eye has to mean the same thing everywhere: a shape that is not there
    // cannot be the reason half a picture is missing.
    const { layout, hole } = sheet();
    hole.hidden = true;
    const px = await probe(layout);
    expect(px(0.1, 0.5)).toEqual([255, 0, 255, 255]);
  });

  it("gives a shape back once nothing masks with it any more", async () => {
    /* A shape is only a hole while something is using it. With its one user
     * switched off it is an ordinary shape again — otherwise it would sit
     * there invisible with nothing on screen to say why. */
    const { layout, pic, hole } = sheet();
    hole.fill = "#00ff00";
    pic.hidden = true;
    const px = await probe(layout);
    expect(px(0.5, 0.5)).toEqual([0, 255, 0, 255]);
  });
});
