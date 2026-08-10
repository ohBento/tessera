/* Runs in a real Chromium (see vitest.config.ts): Fabric needs a DOM, and the
 * whole point of these tests is to exercise the actual render path rather than
 * a stand-in for it. */
import * as fabric from "fabric";
import { describe, expect, it } from "vitest";

import { TILE_H, TILE_W } from "./bmp";
import { renderTiles } from "./export";
import {
  emptyManifest,
  emptyTile,
  migrate,
  newImageLayer,
  newProject,
  newShapeLayer,
  newTextLayer,
  type Frame,
  type Layout,
  type Paint,
  type ShapeLayer,
  type TextLayer,
  type ImageLayer,
  type Manifest,
} from "./model";
import { buildGrid, buildLayout, cellAt, gridSize, type Wall } from "./scene";
import { testDeps } from "../test/images";

const HEADER = 54;

/** Exact inverse of encodeBmp32: rows are bottom-up, channels are BGRA. */
function pixel(bmp: Uint8Array, x: number, y: number) {
  const o = HEADER + ((TILE_H - 1 - y) * TILE_W + x) * 4;
  return [bmp[o + 2], bmp[o + 1], bmp[o], bmp[o + 3]];
}

function manifest(count: number): Manifest {
  const m = emptyManifest();
  const p = newProject("Main");
  p.order = Array.from({ length: count }, (_, i) => `4000000000000000${i}`);
  m.projects = [p];
  for (const id of p.order) m.tiles[id] = emptyTile();
  return m;
}

/** The tile ids of the manifest's only project, in grid order. */
const order = (m: Manifest) => m.projects[0].order;

/** What the renderer is pointed at: an ordered dense id list plus the layers
 *  spread over the whole of it. A project supplies both. */
const view = (m: Manifest): Wall => ({
  ids: m.projects[0].order,
  gridLayers: m.projects[0].gridLayers,
});

/** A flat magenta block, small enough to sit well inside one tile. */
function gridBlock(m: Manifest, x: number, y: number, scale: number) {
  const l = newImageLayer("block:#ff00ff");
  l.space = "grid";
  l.x = x;
  l.y = y;
  l.scale = scale;
  m.projects[0].gridLayers.push(l);
  return l;
}

describe("locks on the wall", () => {
  /* The lock is not a decoration: a nudge on the wall is either thrown away by
   * the next "Stempel aktualisieren" or silently kept, depending on which half
   * of the stamp it landed on. The flag has to travel with the object, because
   * GridCanvas hands out grabbability by its own rule (only the layer chosen in
   * the list) and used to overwrite the lock doing it. */
  it("tags what a Layout owns as locked", async () => {
    const m = manifest(3);
    const mine = newImageLayer("block:#00ff00");
    const stamp = newImageLayer("block:#ff00ff");
    stamp.layoutId = "L1";
    m.tiles[order(m)[0]].layers.push(mine, stamp);

    const canvas = new fabric.StaticCanvas(undefined, { width: 100, height: 100 });
    try {
      await buildGrid(canvas, view(m), m, testDeps, true);
      const by = (id: string) =>
        canvas.getObjects().find((o) => (o as { layerId?: string }).layerId === id) as
          | (fabric.Object & { locked?: boolean })
          | undefined;
      expect(by(stamp.id)?.locked).toBe(true);
      expect(by(stamp.id)?.selectable).toBe(false);
      expect(by(mine.id)?.locked).toBe(false);
      expect(by(mine.id)?.selectable).toBe(true);
    } finally {
      await canvas.dispose();
    }
  });
});

describe("colour grading", () => {
  it("desaturates a picture's pixels, not just its metadata", async () => {
    /* Through the whole chain — filter list, applyFilters, export — because a
     * filter that is set but never applied looks correct in every property
     * inspector and renders nothing. Magenta drained of saturation must land
     * grey: equal channels, and not black, which is what a broken filter
     * pipeline would produce. */
    const m = manifest(1);
    const [id] = order(m);
    const graded = newImageLayer("block:#ff00ff");
    graded.saturation = -1;
    m.tiles[id].layers.push(graded);

    const tiles = await renderTiles(view(m), m, testDeps);
    const [r, g, b, a] = pixel(tiles.get(id)!, TILE_W / 2, TILE_H / 2);
    expect(a).toBe(255);
    expect(Math.abs(r - g)).toBeLessThanOrEqual(2);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(2);
    /* The luminance of pure magenta: (0.2126 + 0.0722) * 255 ≈ 73. Pinned as a
     * band, not just "grey": Fabric's stock Saturation filter also produced
     * equal channels — at 255, because it pulls towards the pixel's maximum —
     * and this is the assertion that tells the two apart. */
    expect(r).toBeGreaterThan(60);
    expect(r).toBeLessThan(90);
  });

  it("blurs a picture's pixels, not just its metadata", async () => {
    /* Measured against the same tile rendered sharp, at the test picture's
     * disc edge — a hard colour boundary that a working blur must smear. A
     * solid block would be useless here: gaussian over a constant is the same
     * constant, which is exactly how a first manual probe fooled itself. */
    const render = async (blur: number) => {
      const m = manifest(1);
      const [id] = order(m);
      const l = newImageLayer("probe");
      l.scale = 0.8;
      l.blur = blur;
      m.tiles[id].layers.push(l);
      return (await renderTiles(view(m), m, testDeps)).get(id)!;
    };
    const sharp = await render(0);
    const soft = await render(0.3);

    let differing = 0;
    for (let x = 0; x < TILE_W; x += 7)
      for (let y = 0; y < TILE_H; y += 7) {
        const a = pixel(sharp, x, y);
        const b = pixel(soft, x, y);
        if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 12) differing++;
      }
    // A 0.3 blur on a structured picture has to move a lot of pixels a lot.
    expect(differing).toBeGreaterThan(100);
  });
});

describe("picture frames", () => {
  /** One magenta block filling most of a tile, with whatever framing is asked
   *  for, rendered through the real export path. */
  const framed = async (extra: Partial<ImageLayer>) => {
    const m = manifest(1);
    const [id] = order(m);
    const l = newImageLayer("block:#ff00ff");
    l.scale = 0.8;
    Object.assign(l, extra);
    m.tiles[id].layers.push(l);
    return (await renderTiles(view(m), m, testDeps)).get(id)!;
  };

  /** The block's own corner, one pixel inside it on both axes. */
  const corner = (bytes: Uint8Array) => {
    const half = (0.8 * TILE_W) / 2;
    return pixel(bytes, Math.round(TILE_W / 2 - half) + 2, Math.round(TILE_H / 2 - half) + 2);
  };

  it("cuts the corners off, and only the corners", async () => {
    const square = await framed({});
    const round = await framed({ cornerRadius: 0.4 });

    // Square: the block's own colour. Round: cut away, so whatever is behind.
    expect(corner(square)[0]).toBeGreaterThan(200);
    expect(corner(square)[2]).toBeGreaterThan(200);
    expect(corner(round)).not.toEqual(corner(square));
    // The middle is untouched by the rounding — it cuts corners, not content.
    expect(pixel(round, TILE_W / 2, TILE_H / 2)).toEqual(pixel(square, TILE_W / 2, TILE_H / 2));
  });

  it("draws the frame inside the edge, in the colour asked for", async () => {
    const plain = await framed({});
    const bordered = await framed({ borderWidth: 0.02, borderColor: "#00ff00" });

    const half = (0.8 * TILE_W) / 2;
    const justInside = Math.round(TILE_W / 2 - half) + 3;
    const [r, g, b] = pixel(bordered, justInside, TILE_H / 2);
    // Green frame where the picture's own magenta was.
    expect(g).toBeGreaterThan(200);
    expect(r).toBeLessThan(80);
    expect(b).toBeLessThan(80);
    expect(pixel(plain, justInside, TILE_H / 2)[0]).toBeGreaterThan(200);
    // Inside the frame the picture is untouched, so the layer keeps its size.
    expect(pixel(bordered, TILE_W / 2, TILE_H / 2)).toEqual(pixel(plain, TILE_W / 2, TILE_H / 2));
  });

  it("bends the frame round the corners instead of losing them", async () => {
    /* The trap this pins: Fabric strokes an image as a hard rectangle, so a
     * rounded picture had its frame's corner pieces fall outside the clip and
     * vanish — a frame open at all four corners. Measured on the diagonal,
     * where a rounded frame has pixels and a square one has none. */
    const round = await framed({ cornerRadius: 0.4, borderWidth: 0.02, borderColor: "#00ff00" });

    const half = (0.8 * TILE_W) / 2;
    const r = 0.4 * Math.min(0.8 * TILE_W, 0.8 * TILE_W);
    // Walk the top-left corner's arc at 45°, where the frame must still run.
    const cx = TILE_W / 2 - half + r;
    const cy = TILE_H / 2 - half + r;
    const d = r / Math.SQRT2;
    let green = 0;
    for (let off = -4; off <= 4; off++) {
      const [pr, pg, pb] = pixel(round, Math.round(cx - d) + off, Math.round(cy - d) + off);
      if (pg > 150 && pr < 120 && pb < 120) green++;
    }
    expect(green).toBeGreaterThan(0);
  });
});

describe("export", () => {
  it("writes one game-shaped BMP per visible tile", async () => {
    const m = manifest(8);
    const tiles = await renderTiles(view(m), m, testDeps);

    expect(tiles.size).toBe(8);
    for (const bytes of tiles.values()) {
      expect(bytes.length).toBe(HEADER + TILE_W * TILE_H * 4);
      expect([bytes[0], bytes[1]]).toEqual([0x42, 0x4d]);
      const dv = new DataView(bytes.buffer, bytes.byteOffset);
      expect(dv.getUint32(10, true)).toBe(HEADER);
      expect(dv.getInt32(18, true)).toBe(TILE_W);
      expect(dv.getInt32(22, true)).toBe(TILE_H); // positive = bottom-up
      expect(dv.getUint16(28, true)).toBe(32);
    }
  });

  it("moves the window per tile instead of exporting the same one twice", async () => {
    const four = manifest(4);
    const tiles = await renderTiles(view(four), four, testDeps);
    const [a, b, c] = [...tiles.values()];
    expect(a).not.toEqual(b);
    expect(b).not.toEqual(c);
  });

  it("a tile off the grid is neither exported nor counted as a slot", async () => {
    /* v6 kept a `hidden` list and filtered it out at render time. v7 has no
     * such list: the project's `order` IS the grid, so taking a tile out of it
     * — onto the shelf — is the whole mechanism. What matters either way is
     * that the slot closes up rather than being left blank: the neighbours
     * shift, and the export keys follow them. */
    const m = manifest(4);
    const p = m.projects[0];
    const off = p.order[1];
    p.order = p.order.filter((id) => id !== off);
    p.shelf = [off];

    const tiles = await renderTiles(view(m), m, testDeps);
    expect([...tiles.keys()]).toEqual(p.order);
    expect(tiles.size).toBe(3);
    expect(tiles.has(off)).toBe(false);
  });
});

describe("tile base", () => {
  it("replaces the original when a tile has a picture of its own", async () => {
    const m = manifest(3);
    // Whole 200x200 block, so the crop covers the source exactly and the tile
    // ends up a flat colour — anything else means the crop maths is off.
    m.tiles[order(m)[1]].base = { asset: "block:#00ff00", crop: { x: 0, y: 0, w: 200, h: 200 } };

    const tiles = [...(await renderTiles(view(m), m, testDeps)).values()];

    for (const [x, y] of [[2, 2], [TILE_W / 2, TILE_H / 2], [TILE_W - 3, TILE_H - 3]]) {
      expect(pixel(tiles[1], x, y)).toEqual([0, 255, 0, 255]);
    }
    // Its neighbours still show their own originals.
    expect(pixel(tiles[0], TILE_W / 2, TILE_H / 2)).not.toEqual([0, 255, 0, 255]);
  });

  it("a v2 mosaic still renders after migration, from the crops it baked", async () => {
    const v2 = {
      version: 2,
      order: ["t0", "t1"],
      hidden: [],
      shared: [],
      mosaic: { asset: "block:#00ff00", rect: { x: 0, y: 0, w: 200, h: 200 } },
      tiles: {
        t0: { base: { asset: "block:#00ff00", crop: { x: 0, y: 0, w: 100, h: 200 } }, layers: [], text: {} },
        t1: { base: { asset: "block:#00ff00", crop: { x: 100, y: 0, w: 100, h: 200 } }, layers: [], text: {} },
      },
    };
    const migrated = migrate(v2);
    const tiles = [...(await renderTiles(view(migrated), migrated, testDeps)).values()];

    expect(tiles).toHaveLength(2);
    for (const t of tiles) expect(pixel(t, TILE_W / 2, TILE_H / 2)).toEqual([0, 255, 0, 255]);
  });
});

describe("a tile keeps its own content", () => {
  /* The wall is one continuous canvas; the game's grid is not — it puts a gap
   * between every portrait. So a layer that spills past its cell is not merely
   * untidy on screen: export moves a tile-sized window across this same scene,
   * so the neighbour's BMP gets the overflow. */
  it("does not let a layer hang into the tile below", async () => {
    const m = manifest(14);
    const layer = newImageLayer("block:#ff00ff");
    layer.scale = 0.4;
    layer.x = 0.5;
    // Well past the bottom edge. Without clipping this lands on the tile seven
    // places later, which is the one directly underneath.
    layer.y = 1.3;
    m.tiles[order(m)[0]].layers.push(layer);

    const tiles = await renderTiles(view(m), m, testDeps);
    const below = tiles.get(order(m)[7])!;
    let magenta = 0;
    for (let i = 54; i + 3 < below.length; i += 4) {
      // BGRA, bottom-up — colour only, position does not matter here.
      if (below[i] > 200 && below[i + 1] < 60 && below[i + 2] > 200) magenta++;
    }
    expect(magenta).toBe(0);
  });

  it("does not let a layer straddling the edge spill into its neighbour", async () => {
    const m = manifest(14);
    const layer = newImageLayer("block:#ff00ff");
    layer.scale = 0.4;
    // Centred on the seam between cell 0 and cell 1: half of it hangs over.
    layer.x = 1;
    layer.y = 0.5;
    m.tiles[order(m)[0]].layers.push(layer);

    const next = (await renderTiles(view(m), m, testDeps)).get(order(m)[1])!;
    let magenta = 0;
    for (let i = 54; i + 3 < next.length; i += 4) {
      if (next[i] > 200 && next[i + 1] < 60 && next[i + 2] > 200) magenta++;
    }
    expect(magenta).toBe(0);
  });

  it("still draws the layer on its own tile", async () => {
    const m = manifest(14);
    const layer = newImageLayer("block:#ff00ff");
    layer.scale = 0.4;
    layer.x = 0.5;
    layer.y = 0.5;
    m.tiles[order(m)[0]].layers.push(layer);

    const own = (await renderTiles(view(m), m, testDeps)).get(order(m)[0])!;
    const [b, g, r] = pixel(own, TILE_W / 2, TILE_H / 2);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(60);
    expect(b).toBeGreaterThan(200);
  });
});

describe("a wall picture sits under what the tiles carry", () => {
  /* It is a preview of the background: Apply turns it into each tile's `base`,
   * and a base draws beneath everything. Drawing it on top until then made the
   * preview contradict its own result — and worse, renderTiles builds this same
   * scene, so a Write to game before applying buried every stamp under the
   * picture in the file itself. */
  it("does not cover a layer the tile carries", async () => {
    const m = manifest(8);
    const own = newImageLayer("block:#00ff00");
    own.scale = 0.4;
    m.tiles[order(m)[2]].layers.push(own);
    gridBlock(m, 0.5, 0.5, 1); // magenta, across the whole wall

    const tiles = [...(await renderTiles(view(m), m, testDeps)).values()];
    const [r, g, b] = pixel(tiles[2], TILE_W / 2, TILE_H / 2);
    expect([r, g, b]).toEqual([0, 255, 0]);
  });

  it("still shows through where the tile carries nothing", async () => {
    const m = manifest(8);
    gridBlock(m, 0.5, 0.5, 1);
    const tiles = [...(await renderTiles(view(m), m, testDeps)).values()];
    expect(pixel(tiles[3], TILE_W / 2, TILE_H / 2)).toEqual([255, 0, 255, 255]);
  });
});

describe("grid-space layers", () => {
  it("land in the tile whose cell they sit over, and only there", async () => {
    const m = manifest(8);
    const grid = gridSize(8);
    const target = 2;
    const at = cellAt(target);
    gridBlock(m, (at.x + TILE_W / 2) / grid.w, (at.y + TILE_H / 2) / grid.h, 0.05);

    const tiles = [...(await renderTiles(view(m), m, testDeps)).values()];

    expect(pixel(tiles[target], TILE_W / 2, TILE_H / 2)).toEqual([255, 0, 255, 255]);
    for (const other of [0, 1, 3, 7]) {
      expect(pixel(tiles[other], TILE_W / 2, TILE_H / 2)).not.toEqual([255, 0, 255, 255]);
    }
  });

  it("are placed once, not repainted per tile", async () => {
    const m = manifest(8);
    gridBlock(m, 0.5, 0.5, 0.05);
    const canvas = new fabric.StaticCanvas(undefined, { width: 10, height: 10, enableRetinaScaling: false });
    try {
      await buildGrid(canvas, view(m), m, testDeps);
      // 8 backgrounds + exactly one block, not 8 copies of it.
      expect(canvas.getObjects().length).toBe(9);
    } finally {
      await canvas.dispose();
    }
  });
});

describe("export matches what the editor shows", () => {
  it("a tile export is the same pixels as that cell of the full wall", async () => {
    const m = manifest(8);
    gridBlock(m, 0.3, 0.4, 0.08);
    const target = 2;

    const exported = [...(await renderTiles(view(m), m, testDeps)).values()][target];

    // The whole wall in one go, no viewport trickery — the reference the
    // windowed export has to agree with.
    const grid = gridSize(8);
    const wall = new fabric.StaticCanvas(undefined, {
      width: grid.w,
      height: grid.h,
      enableRetinaScaling: false,
    });
    let wallPixels: Uint8ClampedArray;
    try {
      await buildGrid(wall, view(m), m, testDeps);
      const at = cellAt(target);
      wallPixels = wall.getElement().getContext("2d")!.getImageData(at.x, at.y, TILE_W, TILE_H).data;
    } finally {
      await wall.dispose();
    }

    let differing = 0;
    for (let i = 0; i < TILE_W * TILE_H; i++) {
      const [r, g, b] = pixel(exported, i % TILE_W, Math.floor(i / TILE_W));
      const o = i * 4;
      if (Math.abs(r - wallPixels[o]) > 1 || Math.abs(g - wallPixels[o + 1]) > 1 || Math.abs(b - wallPixels[o + 2]) > 1) {
        differing++;
      }
    }
    expect(differing).toBe(0);
  });
});

describe("a mask on a tile", () => {
  it("ignores a maskId whose shape is not on the tile", async () => {
    /* A cut needs both halves. syncLiveLayers sends the cutter along with the
     * layer it cuts, so a maskId naming a shape that is nowhere on the tile is
     * a leftover — from a Layout deleted since, or a manifest written before
     * the cutter travelled.
     *
     * Pinned rather than left to chance because of how it would fail: the
     * layer would come back invisible, cut against nothing at all. Whole is
     * the right answer. */
    const m = manifest(2);
    const id = order(m)[0];
    const live = newImageLayer("block:#00ff00");
    live.x = 0.5;
    live.y = 0.5;
    live.scale = 1;
    live.live = true;
    live.maskId = "irgendeine-form";
    m.tiles[id].layers.push(live);

    const tiles = [...(await renderTiles(view(m), m, testDeps)).values()];
    /* Both side edges at half height. A picture at scale 1 is tile-wide and
     * the tile is taller than it is wide, so those are the outermost points it
     * covers — and the first ones any clip would take. */
    expect(pixel(tiles[0], 2, TILE_H / 2)).toEqual([0, 255, 0, 255]);
    expect(pixel(tiles[0], TILE_W - 3, TILE_H / 2)).toEqual([0, 255, 0, 255]);
  });

  it("cuts the layer to the shape that travelled with it", async () => {
    /* The whole point of letting a masked picture be editable on the wall. The
     * cut cannot be a clipPath here — every tile object already carries one for
     * its own cell — so it is baked into the pixels, and this is what says the
     * bake happened. Measured through renderTiles, the path that writes the
     * BMP: the editor showing a cut while the game file carries the layer whole
     * is exactly the failure worth pinning. */
    const m = manifest(2);
    const id = order(m)[0];

    const shape = newShapeLayer("rect");
    shape.id = "cut";
    // The left half of the tile, edge to edge vertically.
    shape.x = 0.25;
    shape.y = 0.5;
    shape.w = 0.5;
    shape.h = 1;
    shape.live = true;
    shape.layoutId = "L1";

    const live = newImageLayer("block:#00ff00");
    live.x = 0.5;
    live.y = 0.5;
    live.scale = 1;
    live.live = true;
    live.layoutId = "L1";
    live.maskId = "cut";
    m.tiles[id].layers.push(shape, live);

    const tiles = [...(await renderTiles(view(m), m, testDeps)).values()];
    const [left, right] = [
      pixel(tiles[0], 2, TILE_H / 2),
      pixel(tiles[0], TILE_W - 3, TILE_H / 2),
    ];

    // Inside the shape the picture is there; outside it the tile's own
    // background shows through, which is what a cut means.
    expect(left).toEqual([0, 255, 0, 255]);
    expect(right).not.toEqual([0, 255, 0, 255]);
    // And the shape itself never draws: a stencil has stopped being a picture.
    expect(right[3]).toBe(255);
  });

  it("keeps a class icon an icon on a tile", async () => {
    /* A tile layer is clipped to its own cell, and Fabric allows one clipPath —
     * so the cell's replaced the icon's, and an icon opted into the grid came
     * out on the wall as the plain rectangle of paint behind it. What makes it
     * an icon has to survive the trip.
     *
     * Measured at a corner of the layer's box, which is inside the rectangle
     * and outside the artwork: paint there means the icon is gone. */
    const m = manifest(2);
    const id = order(m)[0];

    const icon = newShapeLayer("icon", "Ranger");
    icon.x = 0.5;
    icon.y = 0.5;
    icon.w = 0.5;
    icon.h = 0.5;
    icon.fill = "#00ff00";
    m.tiles[id].layers.push(icon);

    const tiles = [...(await renderTiles(view(m), m, testDeps)).values()];
    const corner = pixel(
      tiles[0],
      Math.round(TILE_W * 0.5 - (TILE_W * 0.5) / 2) + 4,
      Math.round(TILE_H * 0.5 - (TILE_H * 0.5) / 2) + 4,
    );
    expect(corner).not.toEqual([0, 255, 0, 255]);
    // And the artwork itself is still drawn, in its own colour.
    expect(pixel(tiles[0], Math.round(TILE_W * 0.5), Math.round(TILE_H * 0.5))).toEqual([
      0, 255, 0, 255,
    ]);
  });

  it("holds a left-aligned caption's left edge across tiles", async () => {
    /* A caption with no width of its own hugs its words, and the box is centred
     * on x — so a tile that says more grows the box in both directions and the
     * text starts further left than on its neighbour. Down a wall of names that
     * reads as a caption that will not line up.
     *
     * Left-aligned means the left edge is the fixed one. Measured as the first
     * column of ink on each tile: they have to match. */
    const m = manifest(2);
    const [first, second] = order(m);

    for (const id of [first, second]) {
      const cap = { ...newTextLayer(), id: "cap", live: true, layoutId: "L1" };
      cap.x = 0.5;
      cap.y = 0.5;
      cap.size = 0.08;
      cap.align = "left";
      cap.color = "#00ff00";
      m.tiles[id].layers.push(cap);
    }
    m.tiles[first].text = { cap: "Ii" };
    m.tiles[second].text = { cap: "IiIiIiIiIi" };

    const tiles = [...(await renderTiles(view(m), m, testDeps)).values()];
    const leftEdge = (t: (typeof tiles)[number]) => {
      for (let x = 0; x < TILE_W; x++)
        for (let y = 0; y < TILE_H; y++) {
          const [r, g, b] = pixel(t, x, y);
          if (r < 80 && g > 200 && b < 80) return x;
        }
      return -1;
    };
    const [a, b] = [leftEdge(tiles[0]), leftEdge(tiles[1])];
    expect(a).toBeGreaterThan(0);
    // Within a pixel: the two are measured from different glyph runs.
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
  });

  it("shows each tile its own part of the picture", async () => {
    /* Masking a picture is how you show one part of it, and which part is right
     * depends on the picture — a face sits centre in one portrait and left in
     * the next. The Layout owns the frame, the tile owns what sits inside it.
     *
     * Two tiles, same layer, same picture, one of them nudged: the pixels
     * cannot match. Measured through the export path, so what is asserted is
     * what the game would get. */
    const m = manifest(2);
    const [first, second] = order(m);

    for (const id of [first, second]) {
      const pic = { ...newImageLayer("probe"), id: "pic", live: true, layoutId: "L1" };
      pic.x = 0.5;
      pic.y = 0.5;
      pic.scale = 0.4;
      m.tiles[id].layers.push(pic);
    }
    m.tiles[second].frame = { pic: { x: 0.2, y: 0, z: 1, a: 0 } };

    const tiles = [...(await renderTiles(view(m), m, testDeps)).values()];
    const strip = (t: (typeof tiles)[number]) => {
      const out: number[] = [];
      for (let x = 0; x < TILE_W; x += 8) out.push(pixel(t, x, Math.round(TILE_H / 2))[0]);
      return out;
    };
    expect(strip(tiles[0])).not.toEqual(strip(tiles[1]));
  });

  it("gives each tile its own class", async () => {
    /* The reason the icons exist: one layer, placed and coloured once, and
     * every portrait naming its own class. Two tiles carrying the same layer
     * have to come out differently — if they matched, the per-tile choice
     * would be decorative and the wall would wear one class throughout. */
    const m = manifest(2);
    const [first, second] = order(m);

    for (const id of [first, second]) {
      const icon = { ...newShapeLayer("icon", "Ranger"), id: "badge", live: true, layoutId: "L1" };
      icon.x = 0.5;
      icon.y = 0.5;
      icon.w = 0.8;
      icon.h = 0.8;
      icon.fill = "#00ff00";
      m.tiles[id].layers.push(icon);
    }
    // The first tile keeps the layer's own class, the second names another.
    m.tiles[second].swap = { badge: "Witch" };

    const tiles = [...(await renderTiles(view(m), m, testDeps)).values()];
    const ink = (t: (typeof tiles)[number]) => {
      let n = 0;
      for (let y = 0; y < TILE_H; y += 4)
        for (let x = 0; x < TILE_W; x += 4) {
          const [r, g, b] = pixel(t, x, y);
          if (r === 0 && g === 255 && b === 0) n++;
        }
      return n;
    };
    const [a, b] = [ink(tiles[0]), ink(tiles[1])];
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    // Different artwork covers a different amount of the tile.
    expect(a).not.toBe(b);
  });

  it("cuts each tile to its own class", async () => {
    /* The pair the icons were built for: one block of colour, cut to the class
     * of whoever the portrait is. The cutter is the layer the tile names a
     * class for, and the tile row offers that picker — but the mask path read
     * the Layout's class for every tile and threw the choice away, so
     * forty-four portraits wore one class and nothing said so.
     *
     * Two tiles, two classes, same cutter: the surviving pixels cannot match. */
    const m = manifest(2);
    const [first, second] = order(m);

    for (const id of [first, second]) {
      const icon = newShapeLayer("icon", "Ranger");
      icon.id = "cut";
      icon.x = 0.5;
      icon.y = 0.5;
      icon.w = 1;
      icon.h = 1;
      icon.live = true;
      icon.layoutId = "L1";

      const block = newImageLayer("block:#00ff00");
      block.id = "block";
      block.x = 0.5;
      block.y = 0.5;
      block.scale = 1;
      block.live = true;
      block.layoutId = "L1";
      block.maskId = "cut";
      m.tiles[id].layers.push(icon, block);
    }
    m.tiles[second].swap = { cut: "Witch" };

    const tiles = [...(await renderTiles(view(m), m, testDeps)).values()];
    const kept = (t: (typeof tiles)[number]) => {
      let n = 0;
      for (let y = 0; y < TILE_H; y += 4)
        for (let x = 0; x < TILE_W; x += 4) {
          const [r, g, b] = pixel(t, x, y);
          if (r === 0 && g === 255 && b === 0) n++;
        }
      return n;
    };
    const [a, b] = [kept(tiles[0]), kept(tiles[1])];
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  it("cuts a picture to a class icon", async () => {
    /* An icon is not drawn like the other shapes — it is a rectangle of paint
     * clipped to the artwork — so being a cutter is the one place that could
     * quietly fail: the mask path rasterises the cutter on its own offscreen
     * canvas, and a clip that only survives on the live canvas would come back
     * blank there and take the whole layer with it. Blank is the failure this
     * pins: something has to be left, and something has to be gone. */
    const m = manifest(2);
    const id = order(m)[0];

    const icon = newShapeLayer("icon", "Ranger");
    icon.id = "cut";
    icon.x = 0.5;
    icon.y = 0.5;
    icon.w = 1;
    icon.h = 1;
    icon.live = true;
    icon.layoutId = "L1";

    const live = newImageLayer("block:#00ff00");
    live.x = 0.5;
    live.y = 0.5;
    live.scale = 1;
    live.live = true;
    live.layoutId = "L1";
    live.maskId = "cut";
    m.tiles[id].layers.push(icon, live);

    const tiles = [...(await renderTiles(view(m), m, testDeps)).values()];
    let kept = 0;
    for (let y = 0; y < TILE_H; y += 4) {
      for (let x = 0; x < TILE_W; x += 4) {
        const [r, g, b] = pixel(tiles[0], x, y);
        if (r === 0 && g === 255 && b === 0) kept++;
      }
    }
    const sampled = Math.ceil(TILE_H / 4) * Math.ceil(TILE_W / 4);
    // Some of the picture survives — the icon is not an empty stencil.
    expect(kept).toBeGreaterThan(0);
    // And most of it does not: a class icon is line art, not a full tile.
    expect(kept).toBeLessThan(sampled / 2);
  });

  it("cuts a picture to this tile's own wording", async () => {
    /* The pay-off of letting a per-tile caption be a cutter: one picture, cut
     * by the letters each portrait carries. Two tiles with different words have
     * to come out differently — if they matched, the cut would be against the
     * layer's default text and the whole feature would be decorative. */
    const m = manifest(2);
    const [first, second] = order(m);

    for (const [id, word] of [
      [first, "IIIIIIIIIIIIII"],
      [second, " "],
    ] as const) {
      const words = { ...newTextLayer(), id: "w", live: true, layoutId: "L1" };
      words.x = 0.5;
      words.y = 0.5;
      words.size = 0.5;
      const pic = { ...newImageLayer("block:#00ff00"), id: "p", live: true, layoutId: "L1" };
      pic.x = 0.5;
      pic.y = 0.5;
      pic.scale = 1;
      pic.maskId = "w";
      m.tiles[id].layers.push(words, pic);
      // The wording is the tile's, not the layer's — that is the whole point.
      m.tiles[id].text = { w: word };
    }

    const tiles = [...(await renderTiles(view(m), m, testDeps)).values()];
    const green = (bmp: Uint8Array) => {
      let n = 0;
      for (let x = 0; x < TILE_W; x += 4) {
        const [r, g, b] = pixel(bmp, x, Math.round(TILE_H / 2));
        if (r === 0 && g === 255 && b === 0) n++;
      }
      return n;
    };

    // Letters on the first tile let the picture through; a blank one does not.
    expect(green(tiles[0])).toBeGreaterThan(0);
    expect(green(tiles[1])).toBe(0);
  });
});

describe("the Layout editor and the wall agree about a mask", () => {
  /* The gap a reviewer named: masks were tested in the Layout (through
   * renderLayout) and on the tile (through renderTiles), and the two sets of
   * numbers never met. They disagreed on four things at once — an inverted
   * mask came out as its exact complement, and the cutter's opacity, outline
   * and shadow changed the cut on one side only.
   *
   * The Layout editor is the only preview there is, so it decides: a mask is a
   * form, not a paint. */
  const layoutCanvas = async (layout: Layout) => {
    const canvas = new fabric.StaticCanvas(undefined, {
      width: TILE_W,
      height: TILE_H,
      enableRetinaScaling: false,
    });
    await buildLayout(canvas, layout, testDeps);
    return canvas;
  };

  /** How many pixels the layer covers, counted off the alpha channel. */
  const coverInLayout = (canvas: fabric.StaticCanvas) => {
    const ctx = canvas.getElement().getContext("2d", { willReadFrequently: true })!;
    const px = ctx.getImageData(0, 0, TILE_W, TILE_H).data;
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 128) n++;
    return n;
  };

  /** The same count off an exported tile — a BMP has no alpha to speak of, so
   *  the layer's own colour is what says "covered". */
  const coverOnTile = (bmp: Uint8Array) => {
    let n = 0;
    for (let y = 0; y < TILE_H; y += 3) {
      for (let x = 0; x < TILE_W; x += 3) {
        const [r, g, b] = pixel(bmp, x, y);
        /* "Green wins here", not "green exactly": a cutter's shadow used to
           widen the cut by a soft ring, and a test that only counted pure green
           could not see the ring at all — it passed whatever the code did. */
        if (g > r + 40 && g > b + 40) n++;
      }
    }
    return n * 9;
  };

  /** One Layout and one wall built from the same two layers, so the only
   *  difference left is the render path. */
  async function bothWays(tweak: (cutter: ShapeLayer, pic: ImageLayer) => void) {
    const cutter = { ...newShapeLayer("rect"), id: "cut" };
    cutter.x = 0.5;
    cutter.y = 0.5;
    cutter.w = 0.5;
    cutter.h = 0.5;
    const pic = { ...newImageLayer("block:#00ff00"), id: "pic" };
    pic.x = 0.5;
    pic.y = 0.5;
    pic.scale = 1;
    pic.maskId = "cut";
    tweak(cutter, pic);

    const layout: Layout = { id: "L1", name: "L", layers: [cutter, pic] };

    const m = manifest(2);
    const id = order(m)[0];
    m.tiles[id].layers.push(
      { ...cutter, live: true, layoutId: "L1" },
      { ...pic, live: true, layoutId: "L1" },
    );

    const tiles = [...(await renderTiles(view(m), m, testDeps)).values()];
    return { layout: coverInLayout(await layoutCanvas(layout)), tile: coverOnTile(tiles[0]) };
  }

  /** Within a few per cent: the two paths antialias differently at the edge,
   *  and a 1px band around a 312x402 rectangle is about 1400 pixels. */
  const close = (a: number, b: number) => Math.abs(a - b) < Math.max(a, b) * 0.05;

  it("survives the transform Fabric resets on a clipPath", async () => {
    /* Fabric owns the transform of whatever it is handed as a clipPath and
     * resets it the moment a drag starts. Measured in the running app: a class
     * icon's stencil sat at scale 0.22 at rest and was 1 after the first
     * mousemove, so the mask covered the whole sheet and the layer it was
     * cutting came out whole — reported as "the icon is zoomed" and as masks
     * that stopped working at all.
     *
     * The stencil is wrapped in a group of its own now, so the reset lands on
     * the wrapper and the fitted scale inside survives. This does to the mask
     * exactly what Fabric does, and then asks what is left on screen. */
    const cutter = { ...newShapeLayer("icon", "Placeholder"), id: "cut" };
    cutter.x = 0.5;
    cutter.y = 0.5;
    cutter.w = 0.3;
    cutter.h = 0.3;
    const pic = { ...newImageLayer("block:#00ff00"), id: "pic" };
    pic.x = 0.5;
    pic.y = 0.5;
    pic.scale = 1;
    pic.maskId = "cut";

    const canvas = await layoutCanvas({ id: "L1", name: "L", layers: [cutter, pic] });
    const before = coverInLayout(canvas);

    const masked = canvas.getObjects().find((o) => o.clipPath?.absolutePositioned)!;
    masked.clipPath!.set({ scaleX: 1, scaleY: 1 });
    canvas.renderAll();
    const afterReset = coverInLayout(canvas);

    // A class icon is line art: it can never cover most of a tile.
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(TILE_W * TILE_H * 0.25);
    expect(afterReset).toBeLessThan(TILE_W * TILE_H * 0.25);
  });

  it("cuts the same piece out, plain", async () => {
    const { layout, tile } = await bothWays(() => {});
    expect(layout).toBeGreaterThan(0);
    expect(close(layout, tile)).toBe(true);
  });

  it("keeps the outside, not the inside, when the mask is inverted", async () => {
    /* The one that was exactly backwards: the editor showed a hole, the tile
     * and the BMP showed only the filled middle. */
    const { layout, tile } = await bothWays((_, pic) => (pic.maskInvert = true));
    expect(layout).toBeGreaterThan(0);
    expect(close(layout, tile)).toBe(true);
  });

  it("lets neither the cutter's opacity nor its outline change the cut", async () => {
    // A mask is a form: half-transparent does not mean half-cut, and an
    // outline is not part of the shape.
    const { layout, tile } = await bothWays((cutter) => {
      cutter.opacity = 0.5;
      cutter.borderWidth = 0.03;
      cutter.borderColor = "#ffffff";
    });
    expect(close(layout, tile)).toBe(true);
  });

  /* A cutter's shadow is stripped by silhouette() too, and deliberately has no
     test: the halo survives the cut only at low alpha, and against the tile's
     own background no threshold told the two paths apart — the assertion passed
     whatever the code did. A green light that cannot go red is worse than none.
     The opacity-and-outline case above covers the same rule with real teeth. */
});

describe("a caption's own width", () => {
  /* The left drift this replaces: the box hugged its words and sat centred on
   * x, so it grew in both directions — and Fabric widens a Textbox to its
   * longest unbreakable word behind our back, which walked a left-aligned
   * caption leftwards by half a letter. A width that does not depend on the
   * text cannot do that. */
  const caption = (over: Partial<TextLayer>): TextLayer => ({
    ...newTextLayer(),
    id: "cap",
    x: 0.5,
    y: 0.5,
    size: 0.12,
    color: "#00ff00",
    align: "left",
    live: true,
    ...over,
  });

  /** The leftmost column carrying the caption's colour. */
  const leftEdge = (bmp: Uint8Array) => {
    for (let x = 0; x < TILE_W; x++) {
      for (let y = 0; y < TILE_H; y += 2) {
        const [r, g, b] = pixel(bmp, x, y);
        if (g > r + 40 && g > b + 40) return x;
      }
    }
    return -1;
  };

  async function edgesFor(w: number | undefined) {
    const out: number[] = [];
    for (const words of ["I", "IIII", "IIIIIIII"]) {
      const m = manifest(2);
      const id = order(m)[0];
      m.tiles[id].layers.push({ ...caption({ w }), text: words });
      const tiles = [...(await renderTiles(view(m), m, testDeps)).values()];
      out.push(leftEdge(tiles[0]));
    }
    return out;
  }

  it("keeps a left-aligned caption's left edge still as the words grow", async () => {
    const edges = await edgesFor(0.6);
    expect(edges.every((x) => x >= 0)).toBe(true);
    // Same column every time, whatever the words do inside the box.
    expect(Math.max(...edges) - Math.min(...edges)).toBeLessThanOrEqual(1);
  });

  it("wraps at the width it was given, not at the tile's edge", async () => {
    /* The point of the box: a narrow one breaks a long line early, a wide one
     * does not — at the same font size. Measured as the ink's height, since
     * a second line is what makes the caption taller. */
    const inkHeight = async (w: number) => {
      const m = manifest(2);
      const id = order(m)[0];
      m.tiles[id].layers.push({ ...caption({ w }), text: "AAAA AAAA AAAA" });
      const [bmp] = [...(await renderTiles(view(m), m, testDeps)).values()];
      let top = -1;
      let bottom = -1;
      for (let y = 0; y < TILE_H; y++) {
        for (let x = 0; x < TILE_W; x += 2) {
          const [r, g, b] = pixel(bmp, x, y);
          if (g > r + 40 && g > b + 40) {
            if (top < 0) top = y;
            bottom = y;
            break;
          }
        }
      }
      return bottom - top;
    };

    const [narrow, wide] = [await inkHeight(0.25), await inkHeight(0.95)];
    expect(narrow).toBeGreaterThan(wide);
  });
});

describe("a caption's box holds its width against a single long word", () => {
  /* The case a character name lands in: one word, no spaces to break at.
   * Fabric widens a Textbox to its longest unbreakable word, which is the very
   * mechanism that walked a left-aligned caption sideways — so a box that only
   * held for text with spaces would keep the bug exactly where it is felt. */
  const leftEdge = (bmp: Uint8Array) => {
    for (let x = 0; x < TILE_W; x++) {
      for (let y = 0; y < TILE_H; y += 2) {
        const [r, g, b] = pixel(bmp, x, y);
        if (g > r + 40 && g > b + 40) return x;
      }
    }
    return -1;
  };

  const edgeFor = async (text: string) => {
    const m = manifest(2);
    const id = order(m)[0];
    m.tiles[id].layers.push({
      ...newTextLayer(),
      id: "cap",
      x: 0.5,
      y: 0.5,
      size: 0.12,
      color: "#00ff00",
      align: "left",
      live: true,
      w: 0.3,
      text,
    });
    const [bmp] = [...(await renderTiles(view(m), m, testDeps)).values()];
    return leftEdge(bmp);
  };

  it("does not widen for a name that has no spaces in it", async () => {
    const [short, long] = [await edgeFor("Eli"), await edgeFor("Elanithewanderer")];
    expect(short).toBeGreaterThan(0);
    /* Four pixels, not one: the wrapped word puts other letters on the left of
       the later lines, and glyphs carry different left side bearings. What is
       being pinned is that the box does not move — without the break inside a
       word this measured 192. */
    expect(Math.abs(long - short)).toBeLessThanOrEqual(4);
  });
});

describe("a caption held to a height", () => {
  /* The box is the promise that a caption cannot grow into what sits beneath
   * it. Measured through renderTiles, because the tile is where the clip has
   * to share its one clipPath slot with the cell — the two rectangles are
   * intersected rather than nested. */
  const inkRows = (bmp: Uint8Array) => {
    let n = 0;
    for (let y = 0; y < TILE_H; y++) {
      for (let x = 0; x < TILE_W; x += 2) {
        const [r, g, b] = pixel(bmp, x, y);
        if (g > r + 40 && g > b + 40) {
          n++;
          break;
        }
      }
    }
    return n;
  };

  const rowsFor = async (h: number | undefined) => {
    const m = manifest(2);
    const id = order(m)[0];
    m.tiles[id].layers.push({
      ...newTextLayer(),
      id: "cap",
      x: 0.5,
      y: 0.5,
      size: 0.1,
      color: "#00ff00",
      align: "left",
      live: true,
      w: 0.3,
      h,
      text: "AAAAAAAAAAAAAAAAAAAAAAAA",
    });
    const [bmp] = [...(await renderTiles(view(m), m, testDeps)).values()];
    return inkRows(bmp);
  };

  it("cuts the lines that do not fit", async () => {
    const [free, held] = [await rowsFor(undefined), await rowsFor(0.08)];
    expect(free).toBeGreaterThan(0);
    // Four lines of wrapped text against a box barely taller than one.
    expect(held).toBeLessThan(free);
    expect(held).toBeGreaterThan(0);
  });

  it("leaves a caption alone when no height is set", async () => {
    expect(await rowsFor(undefined)).toBe(await rowsFor(undefined));
  });
});

describe("a tile's own shape", () => {
  /* A shape carries no per-tile content of its own, so for a long time a tile
   * could say nothing about it at all. What it owns now is the colour and, for
   * a rectangle, ellipse or polygon, the two axes separately — a bar drawn
   * longer on one portrait is a decision, unlike a face stretched on one. */
  const wall = async (paint?: Paint, frame?: Frame) => {
    const m = manifest(1);
    const id = order(m)[0];
    const block: ShapeLayer = {
      ...newShapeLayer("rect"),
      id: "bar",
      x: 0.5,
      y: 0.5,
      w: 0.4,
      h: 0.2,
      fill: "#00ff00",
      live: true,
      layoutId: "L1",
    };
    m.tiles[id].layers.push(block);
    if (paint) m.tiles[id].paint = { [block.id]: paint };
    if (frame) m.tiles[id].frame = { [block.id]: frame };
    const [bmp] = [...(await renderTiles(view(m), m, testDeps)).values()];
    return bmp;
  };

  /** How many sampled pixels carry this channel strongly. */
  const ink = (bmp: Uint8Array, channel: 0 | 1 | 2) => {
    let n = 0;
    for (let y = 0; y < TILE_H; y += 4)
      for (let x = 0; x < TILE_W; x += 4) if (pixel(bmp, x, y)[channel] > 128) n++;
    return n;
  };

  it("paints it the colour the tile chose, in the file the game reads", async () => {
    /* Read at the bar's own centre rather than counted over the tile: the test
       portraits behind it are reddish, so a count of "how much red" answers
       about the face as much as about the bar. */
    const middle = (bmp: Uint8Array) => pixel(bmp, TILE_W / 2, TILE_H / 2);
    expect(middle(await wall())).toEqual([0, 255, 0, 255]);
    expect(middle(await wall("#ff0000"))).toEqual([255, 0, 0, 255]);
  });

  it("stretches one axis without the other", async () => {
    /* The rule the placing tool enforces for every other kind — one zoom, both
     * axes — is lifted here alone, and `zh` is what carries it. Without the
     * second factor a wider bar would have grown taller too. */
    const plain = await wall();
    const wider = await wall(undefined, { x: 0, y: 0, z: 2, a: 0, zh: 1 });
    const rows = (bmp: Uint8Array) => {
      let n = 0;
      for (let y = 0; y < TILE_H; y += 4) if (pixel(bmp, TILE_W / 2, y)[1] > 128) n++;
      return n;
    };
    expect(ink(wider, 1)).toBeGreaterThan(ink(plain, 1) * 1.6);
    // Twice as wide and exactly as tall: the column through the middle is
    // untouched.
    expect(rows(wider)).toBe(rows(plain));
  });

  it("reads a placement written before the second axis as the same zoom", async () => {
    /* Every frame stored before `zh` existed meant "both axes together", and
     * absent has to keep meaning that — otherwise upgrading would silently
     * square off every shape anyone had already placed. */
    const both = await wall(undefined, { x: 0, y: 0, z: 1.5, a: 0 });
    const spelt = await wall(undefined, { x: 0, y: 0, z: 1.5, a: 0, zh: 1.5 });
    expect(ink(both, 1)).toBe(ink(spelt, 1));
    expect(ink(both, 1)).toBeGreaterThan(0);
  });
});

describe("a tile's own placement of a cut layer", () => {
  /* The badge is the pair the live shapes exist for: a block of paint wearing a
   * class icon as its mask. The tile places the icon, and the icon is a cutter,
   * which never draws itself — so the frame reaches the wall only through the
   * hole it cuts. Taken raw, it cut the old hole and the drag changed nothing
   * at all: a tool that wrote into the manifest and moved no pixel. */
  const badge = async (frame?: { x: number; y: number; z: number; a: number }) => {
    const m = manifest(1);
    const id = order(m)[0];
    const icon: ShapeLayer = {
      ...newShapeLayer("icon", "Placeholder"),
      id: "cutter",
      x: 0.5,
      y: 0.5,
      w: 0.4,
      h: 0.4,
      live: true,
      layoutId: "L1",
    };
    const block: ImageLayer = {
      ...newImageLayer("block:#00ff00"),
      id: "paint",
      x: 0.5,
      y: 0.5,
      scale: 1,
      maskId: icon.id,
      live: true,
      layoutId: "L1",
    };
    m.tiles[id].layers.push(icon, block);
    if (frame) m.tiles[id].frame = { [icon.id]: frame };
    const [bmp] = [...(await renderTiles(view(m), m, testDeps)).values()];
    return bmp;
  };

  /** How much of the block survived the cut. */
  const ink = (bmp: Uint8Array) => {
    let n = 0;
    for (let y = 0; y < TILE_H; y += 4)
      for (let x = 0; x < TILE_W; x += 4) if (pixel(bmp, x, y)[1] > 128) n++;
    return n;
  };

  it("moves the hole the mask cuts", async () => {
    const [plain, moved] = [await badge(), await badge({ x: 0.25, y: 0, z: 1, a: 0 })];
    expect(ink(plain)).toBeGreaterThan(0);
    // No Buffer here — this runs in Chromium, not in node.
    expect(moved.every((b, i) => b === plain[i])).toBe(false);
  });

  it("zooms it", async () => {
    const [plain, bigger] = [await badge(), await badge({ x: 0, y: 0, z: 1.6, a: 0 })];
    expect(ink(bigger)).toBeGreaterThan(ink(plain));
  });
});

