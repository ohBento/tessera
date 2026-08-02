import { describe, expect, it } from "vitest";
import { COLS, coverCrop, defaultMosaicRect, mosaicCrops, splitRect } from "./render";
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

describe("splitRect", () => {
  it("splits a freely placed rectangle, not just the default one", () => {
    // A rectangle the user zoomed into and dragged off-centre.
    const rect = { x: 120, y: 55, w: 700, h: 700 / ((COLS * TILE_W) / (9 * TILE_H)) };
    const crops = splitRect(rect, 60);

    expect(crops[0].x).toBe(rect.x);
    expect(crops[0].y).toBe(rect.y);
    expect(crops[6].x + crops[6].w).toBeCloseTo(rect.x + rect.w, 10);
    expect(crops[59].y + crops[59].h).toBeCloseTo(rect.y + rect.h, 10);
  });

  it("agrees with the default placement", () => {
    expect(splitRect(defaultMosaicRect(2000, 1500, 60), 60)).toEqual(mosaicCrops(2000, 1500, 60));
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
