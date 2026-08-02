import { describe, expect, it } from "vitest";
import { COLS, coverCrop, mosaicCrops } from "./render";
import { TILE_H, TILE_W } from "./bmp";

describe("coverCrop", () => {
  it("keeps the full width when the source is wider than the target", () => {
    const c = coverCrop(1000, 1000, TILE_W / TILE_H);
    expect(c.w).toBeCloseTo(776.1, 1);
    expect(c.h).toBe(1000);
    expect(c.x).toBeCloseTo(111.9, 1); // centred
    expect(c.y).toBe(0);
  });

  it("never crops outside the source", () => {
    for (const [w, h] of [[100, 4000], [4000, 100], [624, 804]]) {
      const c = coverCrop(w, h, TILE_W / TILE_H);
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(w + 1e-9);
      expect(c.y + c.h).toBeLessThanOrEqual(h + 1e-9);
    }
  });

  it("matches the tile aspect exactly", () => {
    const c = coverCrop(3000, 1200, TILE_W / TILE_H);
    expect(c.w / c.h).toBeCloseTo(TILE_W / TILE_H, 10);
  });
});

describe("mosaicCrops", () => {
  it("tiles the grid without gaps or overlap", () => {
    const crops = mosaicCrops(2000, 1500, 60);
    expect(crops).toHaveLength(60);
    expect(crops[1].x).toBeCloseTo(crops[0].x + crops[0].w, 10);
    expect(crops[COLS].y).toBeCloseTo(crops[0].y + crops[0].h, 10);
    expect(crops[COLS].x).toBeCloseTo(crops[0].x, 10);
  });

  it("gives every cell the tile aspect, so no piece is distorted", () => {
    for (const c of mosaicCrops(2000, 1500, 60)) {
      expect(c.w / c.h).toBeCloseTo(TILE_W / TILE_H, 8);
    }
  });

  it("handles an incomplete last row", () => {
    // 60 tiles at 7 columns is 9 rows with 3 empty slots — the real case.
    const crops = mosaicCrops(2000, 1500, 60);
    const rows = Math.ceil(60 / COLS);
    const last = crops[59];
    expect(rows).toBe(9);
    expect(last.y + last.h).toBeLessThanOrEqual(1500 + 1e-9);
  });
});
