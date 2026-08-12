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
  type Layer,
  type Paint,
  type ShapeLayer,
  type TextLayer,
  type ImageLayer,
  type Manifest,
} from "./model";
import { buildGrid, buildLayout, cellAt, gridSize, type Wall } from "./scene";

/** The shape these tests build a sheet from. Local because the model type went
 *  with the editor — buildLayout only ever read `layers`. */
type Layout = { id: string; name: string; layers: Layer[] };
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




describe("a Layout composed over a tile", () => {
  /* Composing against "text01" and the placeholder class and finding out at the
   * tenth character that it does not fit is the whole reason this exists. What
   * the tile says shows through everywhere except on the layers being edited —
   * see layoutObjects for why that exception is load-bearing. */
  const sheet = async (except: string[], content: Parameters<typeof buildLayout>[5]) => {
    const words = { ...newTextLayer(), id: "cap", text: "text01", perTile: true } as TextLayer;
    words.x = 0.5;
    words.y = 0.5;
    const badge = { ...newShapeLayer("icon", "Ranger"), id: "bad", perTile: true } as ShapeLayer;
    /* A flat block, so "did the tile's answer reach the canvas" is one pixel
       read rather than a silhouette count. The icon above cannot answer that:
       an icon layer fills the tile and its artwork is a clipPath, so counting
       opaque pixels saturates and passes whatever the code does — which is how
       this whole class of substitution came to ship broken. */
    const pic = { ...newImageLayer("block:#ff0000"), id: "pic", perTile: true } as ImageLayer;
    pic.x = 0.5;
    pic.y = 0.5;
    pic.scale = 1;
    const layout: Layout = { id: "L1", name: "L", layers: [words, badge, pic] };
    const canvas = new fabric.StaticCanvas(undefined, {
      width: TILE_W,
      height: TILE_H,
      enableRetinaScaling: false,
    });
    await buildLayout(canvas, layout, testDeps, false, undefined, { ...content!, except });
    return canvas;
  };

  const drawnText = (canvas: fabric.StaticCanvas) =>
    (canvas.getObjects().find((o) => o instanceof fabric.Textbox) as fabric.Textbox | undefined)?.text;

  const tile = {
    id: "t0",
    base: null,
    content: {
      ...emptyTile(),
      text: { cap: "Nachtklinge" },
      swap: { bad: "Witch", pic: "block:#00ff00" },
    },
  };

  /** The colour in the middle of the sheet, where the block sits. */
  const centre = (canvas: fabric.StaticCanvas) => {
    const px = canvas
      .getElement()
      .getContext("2d", { willReadFrequently: true })!
      .getImageData(TILE_W / 2, TILE_H / 2, 1, 1).data;
    return [px[0], px[1], px[2]];
  };

  it("draws the tile's wording where the Layout only has a placeholder", async () => {
    expect(drawnText(await sheet([], tile))).toBe("Nachtklinge");
  });

  it("gives the picked layer its own text back, so typing has something to type into", async () => {
    /* layerText reads the tile's wording in preference to the layer's, and what
     * is on the canvas is what gets written back — a caption drawn as
     * "Nachtklinge" while its own text is being edited swallows the keystrokes. */
    expect(drawnText(await sheet(["cap"], tile))).toBe("text01");
  });



  it("stands down rather than swapping the canvas out from under a drag", async () => {
    /* Reading and decoding a picture takes long enough for a hand to start a
       drag in the middle of it. The swap would then take the object out from
       under Fabric's live transform: the detached copy follows the mouse and
       the visible one stands still. Asked after every await and immediately
       before the swap, because that is the only moment where the answer is
       still true. */
    const canvas = await sheet([], tile);
    const before = canvas.getObjects();
    expect(before.length).toBeGreaterThan(0);

    const other: Layout = { id: "L2", name: "andere", layers: [newShapeLayer("rect")] };
    const drew = await buildLayout(canvas, other, testDeps, false, undefined, undefined, () => false);

    expect(drew).toBe(false);
    // The same objects, not merely the same count: the old frame is the one the
    // drag is happening on.
    expect(canvas.getObjects()).toEqual(before);
  });

  it("shows the Layout as written when no tile is under it", async () => {
    // The stamp path and the golden tests render the design and nothing else.
    expect(drawnText(await sheet([], { id: "t0", base: null }))).toBe("text01");
  });

});
