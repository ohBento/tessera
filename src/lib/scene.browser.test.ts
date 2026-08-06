/* Runs in a real Chromium (see vitest.config.ts): Fabric needs a DOM, and the
 * whole point of these tests is to exercise the actual render path rather than
 * a stand-in for it. */
import * as fabric from "fabric";
import { describe, expect, it } from "vitest";

import { TILE_H, TILE_W } from "./bmp";
import { renderTiles } from "./export";
import { emptyManifest, emptyTile, migrate, newImageLayer, newOverlay, type Manifest } from "./model";
import { buildGrid, cellAt, gridSize } from "./scene";
import { testDeps } from "../test/images";

const HEADER = 54;

/** Exact inverse of encodeBmp32: rows are bottom-up, channels are BGRA. */
function pixel(bmp: Uint8Array, x: number, y: number) {
  const o = HEADER + ((TILE_H - 1 - y) * TILE_W + x) * 4;
  return [bmp[o + 2], bmp[o + 1], bmp[o], bmp[o + 3]];
}

function manifest(count: number): Manifest {
  const m = emptyManifest();
  m.order = Array.from({ length: count }, (_, i) => `4000000000000000${i}`);
  for (const id of m.order) m.tiles[id] = emptyTile();
  return m;
}

/** A flat magenta block, small enough to sit well inside one tile. */
function gridBlock(m: Manifest, x: number, y: number, scale: number) {
  const l = newImageLayer("block:#ff00ff");
  l.space = "grid";
  l.x = x;
  l.y = y;
  l.scale = scale;
  m.overlays.push({ ...newOverlay("Alle"), layers: [l] });
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
    m.overlays.push({ ...newOverlay("G", [m.order[0]]), layers: [mine, stamp] });

    const canvas = new fabric.StaticCanvas(undefined, { width: 100, height: 100 });
    try {
      await buildGrid(canvas, m, testDeps, true);
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

describe("export", () => {
  it("writes one game-shaped BMP per visible tile", async () => {
    const m = manifest(8);
    const tiles = await renderTiles(m, testDeps);

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
    const tiles = await renderTiles(manifest(4), testDeps);
    const [a, b, c] = [...tiles.values()];
    expect(a).not.toEqual(b);
    expect(b).not.toEqual(c);
  });

  it("hidden tiles are neither exported nor counted as a grid slot", async () => {
    const m = manifest(4);
    m.hidden = [m.order[1]];
    const tiles = await renderTiles(m, testDeps);

    expect([...tiles.keys()]).toEqual([m.order[0], m.order[2], m.order[3]]);
  });
});

describe("tile base", () => {
  it("replaces the original when a tile has a picture of its own", async () => {
    const m = manifest(3);
    // Whole 200x200 block, so the crop covers the source exactly and the tile
    // ends up a flat colour — anything else means the crop maths is off.
    m.tiles[m.order[1]].base = { asset: "block:#00ff00", crop: { x: 0, y: 0, w: 200, h: 200 } };

    const tiles = [...(await renderTiles(m, testDeps)).values()];

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
    const tiles = [...(await renderTiles(migrate(v2), testDeps)).values()];

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
    m.overlays.push({ ...newOverlay("G", [m.order[0]]), layers: [layer] });

    const tiles = await renderTiles(m, testDeps);
    const below = tiles.get(m.order[7])!;
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
    m.overlays.push({ ...newOverlay("G", [m.order[0]]), layers: [layer] });

    const next = (await renderTiles(m, testDeps)).get(m.order[1])!;
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
    m.overlays.push({ ...newOverlay("G", [m.order[0]]), layers: [layer] });

    const own = (await renderTiles(m, testDeps)).get(m.order[0])!;
    const [b, g, r] = pixel(own, TILE_W / 2, TILE_H / 2);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(60);
    expect(b).toBeGreaterThan(200);
  });
});

describe("grid-space layers", () => {
  it("land in the tile whose cell they sit over, and only there", async () => {
    const m = manifest(8);
    const grid = gridSize(8);
    const target = 2;
    const at = cellAt(target);
    gridBlock(m, (at.x + TILE_W / 2) / grid.w, (at.y + TILE_H / 2) / grid.h, 0.05);

    const tiles = [...(await renderTiles(m, testDeps)).values()];

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
      await buildGrid(canvas, m, testDeps);
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

    const exported = [...(await renderTiles(m, testDeps)).values()][target];

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
      await buildGrid(wall, m, testDeps);
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
