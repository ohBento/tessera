import { describe, expect, it } from "vitest";

import { cellsIn, snapBox } from "./geometry";
import { TILE_H as H, TILE_W as W } from "./bmp";

describe("snapBox", () => {
  const box = (left: number, top: number, w = 100, h = 100) => ({ left, top, width: w, height: h });
  /** The sheet itself: left/centre/right and top/middle/bottom. */
  const sheet = [{ left: 0, top: 0, width: W, height: H }];

  it("does nothing when nothing is near", () => {
    // Well clear of every sheet stop on both axes: the nearest is the vertical
    // middle at 402, a hundred pixels below this box's bottom edge.
    const s = snapBox(box(200, 200), sheet, 8);
    expect([s.dx, s.dy]).toEqual([0, 0]);
    expect(s.guides).toEqual([]);
  });

  it("pulls a near edge flush with the sheet", () => {
    const s = snapBox(box(5, 300), sheet, 8);
    expect(s.dx).toBe(-5);
    expect(s.guides).toContainEqual({ axis: "x", at: 0 });
  });

  it("centres a box that is nearly centred", () => {
    const s = snapBox(box(W / 2 - 50 + 3, 300), sheet, 8);
    expect(s.dx).toBe(-3);
  });

  it("decides the two axes independently", () => {
    // Left edge near a neighbour's left, vertical centre near the sheet's.
    const neighbour = box(200, 700);
    const s = snapBox(box(204, H / 2 - 50 + 2), [...sheet, neighbour], 8);
    expect(s.dx).toBe(-4);
    expect(s.dy).toBe(-2);
    expect(s.guides).toHaveLength(2);
  });

  it("lines an edge up with a neighbour's opposite edge", () => {
    // Moving box's left is 6 away from the neighbour's right — butt them up.
    const neighbour = box(100, 100);
    const s = snapBox(box(206, 400), [neighbour], 8);
    expect(s.dx).toBe(-6);
    expect(s.guides).toContainEqual({ axis: "x", at: 200 });
  });

  it("takes the nearest candidate when several are in range", () => {
    const s = snapBox(box(206, 400), [box(100, 100), box(203, 400)], 8);
    // 203 is 3 away, 200 is 6 away.
    expect(s.dx).toBe(-3);
  });

  it("never pulls further than the threshold", () => {
    const s = snapBox(box(9, 300), sheet, 8);
    expect(s.dx).toBe(0);
  });
});

describe("cellsIn", () => {
  /** A band across the middle of the first row, of the given width in tiles. */
  const acrossRow = (tiles: number) => ({ x: 0, y: H / 2, w: tiles * W, h: 1 });

  it("takes every cell a thin band sweeps, not only the ones it swallows", () => {
    // One pixel tall — containment would find nothing here.
    expect(cellsIn(acrossRow(7), 12)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("stops at the tiles that exist, not at the row width", () => {
    expect(cellsIn({ x: 0, y: 0, w: 7 * W, h: 2 * H }, 9)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("takes a column block out of both rows", () => {
    expect(cellsIn({ x: 0, y: 0, w: 2 * W, h: 2 * H }, 12)).toEqual([0, 1, 7, 8]);
  });

  it("ignores a band that touches only a shared edge", () => {
    // Exactly on the boundary between cell 0 and cell 1: neither is entered.
    expect(cellsIn({ x: W, y: 0, w: 0, h: H }, 12)).toEqual([]);
  });

  it("takes the two cells a band straddling their border touches", () => {
    expect(cellsIn({ x: W - 5, y: 0, w: 10, h: 10 }, 12)).toEqual([0, 1]);
  });

  it("finds nothing outside the grid", () => {
    expect(cellsIn({ x: -3 * W, y: 0, w: W, h: H }, 12)).toEqual([]);
  });
});
import {
  cellAt,
  coverCrop,
  gridSize,
  gradientLine,
  layerFont,
  LINE_HEIGHT,
  mosaicBakeCrops,
  polygonPoints,
  textLines,
  tileCover,
} from "./geometry";
import { TILE_H, TILE_W } from "./bmp";
import { isGradient, newTextLayer } from "./model";

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

describe("tileCover", () => {
  it("fills the tile without distorting, whatever shape the source is", () => {
    for (const [w, h] of [[4000, 100], [100, 4000], [1920, 1080]]) {
      const c = tileCover({ width: w, height: h });
      expect(c.w / c.h).toBeCloseTo(TILE_W / TILE_H, 8);
      expect(c.x + c.w).toBeLessThanOrEqual(w + 1e-9);
      expect(c.y + c.h).toBeLessThanOrEqual(h + 1e-9);
    }
  });
});

describe("mosaicBakeCrops", () => {
  // Same proportions as the 7x9 grid itself, so scale 1 spans it exactly —
  // any other aspect would leave a gap on one axis even at "full" scale.
  const natural = gridSize(60);

  it("bakes every tile when the picture exactly covers the whole grid", () => {
    const crops = mosaicBakeCrops({ x: 0.5, y: 0.5, scale: 1 }, natural, 60);
    expect(crops.size).toBe(60);
    // Adjacent tiles' crops tile the source without gaps or overlap.
    const c0 = crops.get(0)!;
    const c1 = crops.get(1)!;
    expect(c1.x).toBeCloseTo(c0.x + c0.w, 6);
    expect(c1.y).toBeCloseTo(c0.y, 6);
    const c7 = crops.get(7)!; // first tile of the second row
    expect(c7.x).toBeCloseTo(c0.x, 6);
    expect(c7.y).toBeCloseTo(c0.y + c0.h, 6);
  });

  it("matches each tile's own aspect, not the source's", () => {
    for (const crop of mosaicBakeCrops({ x: 0.5, y: 0.5, scale: 1 }, natural, 60).values()) {
      expect(crop.w / crop.h).toBeCloseTo(TILE_W / TILE_H, 6);
    }
  });

  it("only bakes tiles the picture fully covers, leaving the rest untouched", () => {
    // Scaled down and shifted so it sits over roughly the top-left quadrant.
    const crops = mosaicBakeCrops({ x: 0.25, y: 0.22, scale: 0.5 }, natural, 60);
    expect(crops.size).toBeGreaterThan(0);
    expect(crops.size).toBeLessThan(60);
    expect(crops.has(0)).toBe(true); // top-left tile, well inside
    expect(crops.has(59)).toBe(false); // bottom-right tile, nowhere near it
  });

  it("bakes nothing when the picture does not fully cover any single tile", () => {
    const crops = mosaicBakeCrops({ x: 0.5, y: 0.5, scale: 0.05 }, natural, 60);
    expect(crops.size).toBe(0);
  });

  it("rejects a real gap even a few pixels short of full coverage", () => {
    // Sized to exactly span the grid, then nudged 5 grid px off-centre — a real
    // shortfall, not float noise, and must still be rejected on the far side.
    const grid = gridSize(60);
    const shifted = mosaicBakeCrops({ x: 0.5 + 5 / grid.w, y: 0.5, scale: 1 }, natural, 60);
    expect(shifted.has(0)).toBe(false); // left edge now short by 5px
    expect(shifted.has(6)).toBe(true); // right edge only more overshot, still fine
  });

  it("accepts sub-pixel float slack as full coverage", () => {
    const grid = gridSize(60);
    const barely = mosaicBakeCrops({ x: 0.5 + 0.001 / grid.w, y: 0.5, scale: 1 }, natural, 60);
    expect(barely.size).toBe(60);
  });

  it("reproduces the exact pixels a screen would show — no distortion", () => {
    // A picture exactly the size of one tile, centred over tile 0's cell.
    const grid = gridSize(60);
    const cell = cellAt(0);
    const centreX = (cell.x + TILE_W / 2) / grid.w;
    const centreY = (cell.y + TILE_H / 2) / grid.h;
    const oneTile = { w: 1000, h: (1000 * TILE_H) / TILE_W };
    const crops = mosaicBakeCrops({ x: centreX, y: centreY, scale: TILE_W / grid.w }, oneTile, 60);
    const crop = crops.get(0)!;
    expect(crop.x).toBeCloseTo(0, 6);
    expect(crop.y).toBeCloseTo(0, 6);
    expect(crop.w).toBeCloseTo(oneTile.w, 6);
    expect(crop.h).toBeCloseTo(oneTile.h, 6);
  });
});

describe("gradientLine", () => {
  it("runs left to right at 0 degrees", () => {
    const { x1, y1, x2, y2 } = gradientLine(0, 100, 40);
    expect(x1).toBeCloseTo(-50);
    expect(y1).toBeCloseTo(0);
    expect(x2).toBeCloseTo(50);
    expect(y2).toBeCloseTo(0);
  });

  it("runs top to bottom at 90 degrees", () => {
    const { x1, y1, x2, y2 } = gradientLine(90, 100, 40);
    expect(x1).toBeCloseTo(0);
    expect(y1).toBeCloseTo(-20);
    expect(x2).toBeCloseTo(0);
    expect(y2).toBeCloseTo(20);
  });

  it("is centred on the origin regardless of angle", () => {
    for (const angle of [0, 37, 90, 180, 271]) {
      const { x1, y1, x2, y2 } = gradientLine(angle, 80, 50);
      expect((x1 + x2) / 2).toBeCloseTo(0);
      expect((y1 + y2) / 2).toBeCloseTo(0);
    }
  });
});

describe("textLines", () => {
  it("keeps a single line on the layer's own baseline", () => {
    expect(textLines("one", 40)).toEqual([{ line: "one", y: 0 }]);
  });

  it("centres a block of lines on that baseline", () => {
    // fillText ignores \n entirely, so lines are placed by hand; the block has
    // to stay centred on y or a caption drifts as lines are added.
    const rows = textLines("a\nb", 40);
    expect(rows.map((r) => r.line)).toEqual(["a", "b"]);
    expect(rows[0].y).toBeCloseTo(-rows[1].y, 10);
    expect(rows[1].y - rows[0].y).toBeCloseTo(40 * LINE_HEIGHT, 10);
  });

  it("keeps blank lines, so an empty line still takes space", () => {
    expect(textLines("a\n\nb", 10)).toHaveLength(3);
  });
});

describe("layerFont", () => {
  const base = { ...newTextLayer(), font: "Segoe UI" };

  it("omits style and weight when neither is set", () => {
    expect(layerFont(base, 40)).toBe('40px "Segoe UI"');
  });

  it("puts style before weight, then size and family", () => {
    // A CSS font shorthand in the wrong order is invalid outright, and a
    // canvas responds by silently keeping its previous font.
    expect(layerFont({ ...base, bold: true, italic: true }, 40)).toBe('italic bold 40px "Segoe UI"');
    expect(layerFont({ ...base, bold: true }, 40)).toBe('bold 40px "Segoe UI"');
    expect(layerFont({ ...base, italic: true }, 40)).toBe('italic 40px "Segoe UI"');
  });
});

describe("isGradient", () => {
  it("tells a plain colour from a gradient object", () => {
    expect(isGradient("#ffffff")).toBe(false);
    expect(isGradient({ from: "#fff", to: "#000", angle: 0 })).toBe(true);
  });
});

describe("polygonPoints", () => {
  it("starts pointing straight up", () => {
    const pts = polygonPoints(6, 100, 100);
    expect(pts[0].x).toBeCloseTo(0);
    expect(pts[0].y).toBeCloseTo(-50);
  });

  it("is centred on the origin for any point count", () => {
    for (const sides of [3, 5, 6, 8, 12]) {
      const pts = polygonPoints(sides, 80, 50);
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      expect(cx).toBeCloseTo(0);
      expect(cy).toBeCloseTo(0);
    }
  });

  it("clamps below 3 sides and rounds fractional counts", () => {
    expect(polygonPoints(2, 10, 10)).toHaveLength(3);
    expect(polygonPoints(5.6, 10, 10)).toHaveLength(6);
  });

  it("uses independent width and height radii, not a single circle", () => {
    // A very wide, short box: the left/right points should be far out,
    // the top/bottom points should be close in — never a perfect circle.
    const pts = polygonPoints(4, 200, 20);
    const xs = pts.map((p) => Math.abs(p.x));
    const ys = pts.map((p) => Math.abs(p.y));
    expect(Math.max(...xs)).toBeGreaterThan(Math.max(...ys) * 5);
  });
});
