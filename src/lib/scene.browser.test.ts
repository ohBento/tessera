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
  newGroupLayer,
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
import { buildGrid, cellAt, gridSize, readBack, type Tagged, type Wall } from "./scene";
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

  it("grades a framed picture once, not twice", async () => {
    /* Framing bakes the picture into a canvas of its own and hands that to
     * Fabric — and `setElement` re-runs the filter chain whenever the object
     * still has one. The grading was already in the pixels being handed over,
     * so it landed a second time: +20% brightness rendered as +40%, a 30° hue
     * turn as 60°, and the border drawn just before was graded along with the
     * picture, so a green frame on a hue-turned photograph came out some other
     * colour. Both canvases agreed about it, which is why it never looked like
     * a bug — it was simply twice what was asked for, on screen and in the
     * file written to the game.
     *
     * Measured in the middle of the picture, where the frame is not. */
    const middle = (bytes: Uint8Array) => pixel(bytes, TILE_W / 2, TILE_H / 2);
    const plainly = middle(await framed({ brightness: 0.2 }));
    const bordered = middle(await framed({ brightness: 0.2, borderWidth: 0.02 }));

    // Same picture, same dial: the frame is not a second helping of it.
    for (let i = 0; i < 3; i++) expect(bordered[i]).toBeCloseTo(plainly[i], -0.5);
    /* And the dial did something, or the two would agree for the wrong reason.
     * Read on green: the block is magenta, so red and blue are already at the
     * ceiling and brightness has nowhere to move them. */
    const ungraded = middle(await framed({}));
    expect(plainly[1]).toBeGreaterThan(ungraded[1] + 20);
  });

  it("exports what is behind a transparent picture, not black", async () => {
    /* The BMP the game reads has no alpha — encodeBmp32 forces every pixel
     * opaque — so whatever a transparent pixel says its colour is, is what
     * lands in the file. The export canvas had no ground of its own, so an
     * untouched pixel said "transparent black" and came out black, while the
     * editor showed its own dark grey behind the same picture. A PNG with
     * transparency therefore looked right on the wall and had holes in it in
     * the game.
     *
     * Measured on a tile whose whole background is a transparent picture, so
     * the only thing under it is the ground being tested. */
    const m = manifest(1);
    const [id] = order(m);
    // A disc leaves the corners transparent; the base fills the tile with it.
    m.tiles[id].base = { asset: "disc:#ff0000", crop: { x: 0, y: 0, w: 200, h: 200 } };
    const bytes = (await renderTiles(view(m), m, testDeps)).get(id)!;

    const [r, g, b, a] = pixel(bytes, 4, 4);
    expect(a).toBe(255);
    // The editor's own ground, not black.
    expect([r, g, b]).toEqual([0x17, 0x17, 0x1a]);
  });

  it("reports a caption's own width, without the outline round it", async () => {
    /* What a finished gesture reads back is what the write stores, and
     * `getScaledWidth` counts the stroke: a Textbox carries its outline as one,
     * with no `strokeUniform`. So an outlined caption reported itself wider
     * than it is, the write took that as its wrap width, and every plain move
     * made it a little wider again — ten repositionings at full outline and
     * the words wrap somewhere else than they were typed to. */
    const m = manifest(1);
    const [id] = order(m);
    const caption = { ...newTextLayer(), id: "cap", w: 0.5, strokeWidth: 0.02, text: "Aria" };
    m.tiles[id].layers.push(caption);

    const canvas = new fabric.StaticCanvas(undefined, { width: TILE_W, height: TILE_H });
    await buildGrid(canvas, view(m), m, testDeps);
    const obj = canvas.getObjects().find((o) => (o as Tagged).layerId === "cap")!;
    expect(readBack(obj as Tagged, 1, 0).scale).toBeCloseTo(0.5, 6);
  });

  it("still reports the trim it baked in", async () => {
    /* Framing means baking the trimmed window into a canvas of its own and
     * handing that to Fabric, so from then on the object *is* the window: it
     * reports no crop, and the write path reads that as the trim having been
     * let go and deletes it. Turning on a border and then nudging the picture
     * threw the trim away — on every selected tile at once, and with the
     * editor showing nothing until the next rebuild.
     *
     * Asked of readBack, which is what a finished gesture reads. */
    const m = manifest(1);
    const [id] = order(m);
    const crop = { l: 0.1, r: 0.1, t: 0.1, b: 0.1 };
    const l = newImageLayer("block:#ff00ff");
    l.scale = 0.8;
    l.crop = { ...crop };
    l.borderWidth = 0.02;
    m.tiles[id].layers.push(l);

    const canvas = new fabric.StaticCanvas(undefined, { width: TILE_W, height: TILE_H });
    await buildGrid(canvas, view(m), m, testDeps);
    const obj = canvas.getObjects().find((o) => (o as Tagged).layerId === l.id)!;
    expect(readBack(obj as Tagged, 1, 0).crop).toEqual(crop);
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

  it("agrees with the canvas the editor actually builds", async () => {
    /* The test above compares one buildGrid against another, so it cannot see a
     * difference between the *editor's* canvas and the export's — and that is
     * exactly where the two had drifted: the editor paints on #17171a and the
     * export canvas had no ground at all, so transparent pixels handed over
     * their straight colour and the BMP came out with black holes where the
     * wall showed dark grey. Nothing in the suite compared the two.
     *
     * Built the way GridCanvas builds it: interactive, with the same ground.
     * A tile whose whole background is a picture with transparent corners, so
     * what is being compared is the ground showing through. */
    const m = manifest(4);
    const [id] = order(m);
    const target = 0;
    m.tiles[id].base = { asset: "disc:#ff0000", crop: { x: 0, y: 0, w: 200, h: 200 } };
    const caption = { ...newTextLayer(), id: "cap", text: "Aria", y: 0.7 };
    m.tiles[id].layers.push(caption);

    const exported = (await renderTiles(view(m), m, testDeps)).get(id)!;

    const grid = gridSize(4);
    const editor = new fabric.Canvas(undefined, {
      width: grid.w,
      height: grid.h,
      enableRetinaScaling: false,
      backgroundColor: "#17171a",
    });
    let shown: Uint8ClampedArray;
    try {
      await buildGrid(editor, view(m), m, testDeps, true);
      editor.renderAll();
      const at = cellAt(target);
      shown = editor.getElement().getContext("2d")!.getImageData(at.x, at.y, TILE_W, TILE_H).data;
    } finally {
      await editor.dispose();
    }

    let differing = 0;
    for (let i = 0; i < TILE_W * TILE_H; i++) {
      const [r, g, b] = pixel(exported, i % TILE_W, Math.floor(i / TILE_W));
      const o = i * 4;
      // Composited against the same ground on both sides, so anti-aliased
      // edges land on the same colour rather than within a tolerance of it.
      if (
        Math.abs(r - shown[o]) > 1 ||
        Math.abs(g - shown[o + 1]) > 1 ||
        Math.abs(b - shown[o + 2]) > 1
      )
        differing++;
    }
    expect(differing).toBe(0);
  });
});

describe("blend modes", () => {
  /** Mid-grey under, red over — a pair whose product is nothing like either of
   *  them, so "multiply happened" and "the top layer simply drew" cannot be
   *  confused. Normal stacking leaves 255,0,0 here; multiplying leaves 128,0,0. */
  const stacked = (m: Manifest, id: string, extra: Partial<ImageLayer> = {}) => {
    const under = newImageLayer("block:#808080");
    under.scale = 0.9;
    const over = newImageLayer("block:#ff0000");
    over.scale = 0.5;
    Object.assign(over, extra);
    m.tiles[id].layers.push(under, over);
    return over;
  };

  it("mixes a layer with what is under it in the tile", async () => {
    const m = manifest(1);
    const [id] = order(m);
    stacked(m, id, { blend: "multiply" });

    const [r, g, b] = pixel(
      (await renderTiles(view(m), m, testDeps)).get(id)!,
      TILE_W / 2,
      TILE_H / 2,
    );
    expect(Math.abs(r - 128)).toBeLessThanOrEqual(2);
    expect(g).toBe(0);
    expect(b).toBe(0);
  });

  it("leaves a layer alone when no mode is set", async () => {
    /* The other half of the pair: without it, a test that only checks the
     * multiplied value cannot tell a working mode from a renderer that darkens
     * everything. */
    const m = manifest(1);
    const [id] = order(m);
    stacked(m, id);

    const [r] = pixel((await renderTiles(view(m), m, testDeps)).get(id)!, TILE_W / 2, TILE_H / 2);
    expect(r).toBe(255);
  });

  it("still mixes when the layer is baked to pixels first", async () => {
    /* A masked layer is rasterised onto a transparent canvas of its own before
     * it reaches the cell. Setting the mode on the inner draw would mix it with
     * that emptiness — nothing — and the wall would show plain stacking. This
     * is the test that says the mode is set on the object that lands on the
     * tile. */
    const m = manifest(1);
    const [id] = order(m);
    const hole = newShapeLayer("ellipse");
    hole.id = "cutter";
    hole.w = hole.h = 0.4;
    m.tiles[id].layers.push(hole);
    stacked(m, id, { blend: "multiply", maskId: "cutter" });

    const [r, g, b] = pixel(
      (await renderTiles(view(m), m, testDeps)).get(id)!,
      TILE_W / 2,
      TILE_H / 2,
    );
    expect(Math.abs(r - 128)).toBeLessThanOrEqual(2);
    expect(g).toBe(0);
    expect(b).toBe(0);
  });

  it("comes out of the export the way the editor drew it", async () => {
    /* Two render paths meet here: mixing depends on what has already been drawn,
     * so a ground the export canvas lacked — or objects added in a different
     * order — would show up as a different colour rather than as an error. The
     * only way to know is to compare the pixels. */
    const m = manifest(4);
    const [id] = order(m);
    stacked(m, id, { blend: "multiply" });

    const exported = (await renderTiles(view(m), m, testDeps)).get(id)!;

    const grid = gridSize(4);
    const editor = new fabric.Canvas(undefined, {
      width: grid.w,
      height: grid.h,
      enableRetinaScaling: false,
      backgroundColor: "#17171a",
    });
    let shown: Uint8ClampedArray;
    try {
      await buildGrid(editor, view(m), m, testDeps, true);
      editor.renderAll();
      const at = cellAt(0);
      shown = editor.getElement().getContext("2d")!.getImageData(at.x, at.y, TILE_W, TILE_H).data;
    } finally {
      await editor.dispose();
    }

    let differing = 0;
    for (let i = 0; i < TILE_W * TILE_H; i++) {
      const [r, g, b] = pixel(exported, i % TILE_W, Math.floor(i / TILE_W));
      const o = i * 4;
      if (
        Math.abs(r - shown[o]) > 1 ||
        Math.abs(g - shown[o + 1]) > 1 ||
        Math.abs(b - shown[o + 2]) > 1
      )
        differing++;
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

describe("a mask is a form, not a paint", () => {
  /* The gap a reviewer named: masks were measured in the Layout and on the
   * tile, and the two sets of numbers never met. They disagreed on four things
   * at once — an inverted mask came out as its exact complement, and the
   * cutter's opacity, outline and shadow changed the cut on one side only.
   *
   * There is one render path now, so there is nothing left to compare it
   * against. What the comparison was really pinning is stated here directly:
   * how much of the tile a cut layer covers, and what must not change it. Two
   * renders of the wall where there used to be a sheet and a wall — which is a
   * stronger test, because both sides can now be wrong together and still fail.
   */

  /** How much of an exported tile the green picture covers. A BMP has no alpha
   *  to speak of, so the layer's own colour is what says "covered".
   *
   *  "Green wins here", not "green exactly": a cutter's shadow used to widen
   *  the cut by a soft ring, and a test that only counted pure green could not
   *  see the ring at all — it passed whatever the code did. */
  const covered = (bmp: Uint8Array) => {
    let n = 0;
    for (let y = 0; y < TILE_H; y += 3) {
      for (let x = 0; x < TILE_W; x += 3) {
        const [r, g, b] = pixel(bmp, x, y);
        if (g > r + 40 && g > b + 40) n++;
      }
    }
    return n * 9;
  };

  /** A tile-wide green picture cut to a rect covering a quarter of the tile,
   *  exported and counted. `tweak` is the difference under test. */
  async function cutOnTile(tweak: (cutter: ShapeLayer, pic: ImageLayer) => void) {
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

    const m = manifest(2);
    const id = order(m)[0];
    m.tiles[id].layers.push(cutter, pic);
    const tiles = [...(await renderTiles(view(m), m, testDeps)).values()];
    return covered(tiles[0]);
  }

  /** Within a few per cent: antialiasing at the edge of a 312x402 rectangle is
   *  a 1px band of about 1400 pixels. */
  const close = (a: number, b: number) => Math.abs(a - b) < Math.max(a, b) * 0.05;

  it("leaves the cutter's own area standing and nothing else", async () => {
    const cut = await cutOnTile(() => {});
    // Half the width by half the height of the tile.
    expect(close(cut, TILE_W * 0.5 * (TILE_H * 0.5))).toBe(true);
  });

  it("keeps the outside, not the inside, when the mask is inverted", async () => {
    /* The one that was exactly backwards: the editor showed a hole, the tile
     * and the BMP showed only the filled middle.
     *
     * Measured against the same picture uncut rather than against the tile:
     * the block is square and drawn a tile wide, so at 624x804 it never covers
     * the top and bottom bands. What must hold is that the two cuts are each
     * other's complement — together they are the whole picture and no more. */
    const uncut = await cutOnTile((_, pic) => delete pic.maskId);
    const plain = await cutOnTile(() => {});
    const inverted = await cutOnTile((_, pic) => (pic.maskInvert = true));
    expect(plain).toBeGreaterThan(0);
    expect(inverted).toBeGreaterThan(0);
    expect(close(plain + inverted, uncut)).toBe(true);
  });

  it("lets neither the cutter's opacity nor its outline change the cut", async () => {
    // A mask is a form: half-transparent does not mean half-cut, and an
    // outline is not part of the shape.
    const plain = await cutOnTile(() => {});
    const dressed = await cutOnTile((cutter) => {
      cutter.opacity = 0.5;
      cutter.borderWidth = 0.03;
      cutter.borderColor = "#ffffff";
    });
    expect(close(plain, dressed)).toBe(true);
  });

  /* A cutter's shadow is stripped by silhouette() too, and deliberately has no
     test: the halo survives the cut only at low alpha, and against the tile's
     own background no threshold told the cases apart — the assertion passed
     whatever the code did. A green light that cannot go red is worse than none.
     The opacity-and-outline case above covers the same rule with real teeth.

     Gone with the sheet: a test that reset a clipPath's transform the way
     Fabric does at the start of a drag, and asked what was left. A cut layer
     on a tile is composited to pixels before it reaches the canvas, so there is
     no live clipPath for Fabric to reset — the stand-in is what moves one now,
     and App.browser covers that. */
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

  it("runs a gradient across the caption, not across the tile", async () => {
    /* Fabric anchors a pixel gradient at the object's own top-left and spans
     * its width. The ramp was built 624 wide — the tile — so a caption a
     * hundred pixels across showed only its first sixth: a red-to-blue fade
     * read as flat red, and Angle, Balance and Reach barely moved anything.
     *
     * Measured as the difference between the two ends of the word, which is
     * the whole claim: a gradient that arrives has two different colours in
     * it. */
    const m = manifest(2);
    const id = order(m)[0];
    /* On a flat black tile: the mock portrait underneath is a painted test
       picture and would otherwise answer for the letters. */
    m.tiles[id].base = { asset: "block:#000000", crop: { x: 0, y: 0, w: 200, h: 200 } };
    m.tiles[id].layers.push({
      ...caption({ w: 0.5, align: "center" }),
      text: "IIIIIIII",
      color: { from: "#ff0000", to: "#0000ff", angle: 0 },
    });
    const [bmp] = [...(await renderTiles(view(m), m, testDeps)).values()];

    /* The leftmost and rightmost columns carrying ink, and what colour they
     * carry. Anything that is not the tile's own portrait counts as ink here,
     * which the strong primaries make safe. */
    const ink: { x: number; px: number[] }[] = [];
    for (let x = 0; x < TILE_W; x++) {
      for (let y = 0; y < TILE_H; y += 2) {
        const px = pixel(bmp, x, y);
        // The letters are the only strongly red or strongly blue thing here.
        if (px[0] > 120 && px[1] < 90) ink.push({ x, px });
        else if (px[2] > 120 && px[1] < 90) ink.push({ x, px });
      }
    }
    expect(ink.length).toBeGreaterThan(0);
    const first = ink.reduce((a, b) => (a.x <= b.x ? a : b));
    const last = ink.reduce((a, b) => (a.x >= b.x ? a : b));
    /* Red at one end and blue at the other, not red fading to purple: a ramp
     * built for the tile only ever showed the caption its first stretch. */
    /* How far the ramp travels between the first and last inked column. Built
       for the caption it swings 176 of a possible 255; built for the tile, the
       letters only ever saw a slice of it and the same measurement gives 70. */
    const swing = first.px[0] - first.px[2] - (last.px[0] - last.px[2]);
    expect(swing).toBeGreaterThan(130);
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




describe("a caption says what the tile is", () => {
  /* "{{id}}" resolving per tile is a real feature with nothing on screen to
   * announce it: one caption added to forty portraits reads as forty different
   * names. layerText is unit-tested, but what matters is that the wall draws
   * the resolved words — the sheet used to be where that was checked, against a
   * tile composed underneath it, and the sheet is gone.
   *
   * Gone with it, and not replaced: the layers being edited kept showing the
   * design's own placeholder while their neighbours showed the wall, and a
   * half-finished render could stand down rather than swap the canvas out from
   * under a drag. Both were the sheet answering for a tile it was drawn over.
   * The wall draws the tile itself, so neither question exists. */
  it("draws the tile's own id where the caption only has a placeholder", async () => {
    const m = manifest(2);
    const id = order(m)[0];
    const caption = { ...newTextLayer(), id: "cap", text: "{{id}}" };
    m.tiles[id].layers.push(caption);

    const grid = gridSize(order(m).length);
    const canvas = new fabric.StaticCanvas(undefined, {
      width: grid.w,
      height: grid.h,
      enableRetinaScaling: false,
    });
    try {
      await buildGrid(canvas, view(m), m, testDeps);
      const drawn = canvas
        .getObjects()
        .find((o) => o instanceof fabric.Textbox) as fabric.Textbox | undefined;
      expect(drawn?.text).toBe(id);
    } finally {
      await canvas.dispose();
    }
  });
});

describe("what a tile carries beyond a flat list", () => {
  /* Two things Phase 0 gave the tile path and nothing has rendered since: a
   * group, which displaces its children instead of drawing, and a shared bake
   * for a cut layer, which is what stopped a masked wall from taking the
   * browser down. */

  it("displaces a group's children and draws nothing for the group itself", async () => {
    const m = manifest(2);
    const id = order(m)[0];
    const inner = { ...newShapeLayer("rect"), id: "inner" };
    inner.x = 0.5;
    inner.y = 0.5;
    inner.w = 0.2;
    inner.h = 0.2;
    const group = { ...newGroupLayer([inner]), id: "grp" };
    // A group's own x/y is the displacement it applies to what it holds.
    group.x = 0.5 + 0.25;
    group.y = 0.5;
    m.tiles[id].layers.push(group);

    const grid = gridSize(order(m).length);
    const canvas = new fabric.StaticCanvas(undefined, {
      width: grid.w,
      height: grid.h,
      enableRetinaScaling: false,
    });
    try {
      await buildGrid(canvas, view(m), m, testDeps, true);
      const drawn = canvas.getObjects().filter((o) => (o as { layerId?: string }).layerId);
      // The group is not an object; its child is, and it has moved with it.
      expect(drawn.map((o) => (o as { layerId?: string }).layerId)).toEqual(["inner"]);
      const at = cellAt(0);
      expect(drawn[0].left).toBeCloseTo(at.x + 0.75 * TILE_W, 0);
    } finally {
      await canvas.dispose();
    }
  });

  it("bakes one canvas for a cut layer and hands it to every tile that matches", async () => {
    /* cutToShape composites onto a tile-sized canvas. Before the bake was
     * shared, a wall of 301 asked for 602 of them — about 1.2GB, and the
     * browser went down mid-render rather than merely slowing. Two tiles
     * carrying the same cut layer have to come out holding the same element. */
    const m = manifest(2);
    const [a, b] = order(m);
    const cutter = { ...newShapeLayer("ellipse"), id: "cut" };
    cutter.w = 0.3;
    cutter.h = 0.3;
    const pic = { ...newImageLayer("block:#00ff00"), id: "pic" };
    pic.scale = 1;
    pic.maskId = "cut";
    for (const id of [a, b]) m.tiles[id].layers.push({ ...cutter }, { ...pic });

    const grid = gridSize(order(m).length);
    const canvas = new fabric.StaticCanvas(undefined, {
      width: grid.w,
      height: grid.h,
      enableRetinaScaling: false,
    });
    try {
      await buildGrid(canvas, view(m), m, testDeps, true);
      const cut = canvas
        .getObjects()
        .filter((o) => (o as { layerId?: string }).layerId === "pic") as fabric.FabricImage[];
      expect(cut).toHaveLength(2);
      expect(cut[0].getElement()).toBe(cut[1].getElement());
    } finally {
      await canvas.dispose();
    }
  });
});
