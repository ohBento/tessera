import { describe, expect, it } from "vitest";
import { LINE_HEIGHT, coverCrop, gradientLine, layerFont, polygonPoints, textLines, tileCover } from "./geometry";
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
