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
