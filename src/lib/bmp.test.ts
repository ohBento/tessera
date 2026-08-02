import { describe, expect, it } from "vitest";
import { encodeBmp32, TILE_H, TILE_W } from "./bmp";

/* Byte-exact expectations taken from a real FaceTexture file's first 54 bytes:
 * 424d 369f1e00 00000000 36000000 28000000 70020000 24030000 0100 2000
 * 00000000 00000000 130b0000 130b0000 00000000 00000000 */
describe("encodeBmp32", () => {
  const rgba = new Uint8ClampedArray(TILE_W * TILE_H * 4);
  rgba[0] = 10; // R of the top-left pixel
  rgba[1] = 20; // G
  rgba[2] = 30; // B
  const bmp = encodeBmp32(rgba);
  const dv = new DataView(bmp.buffer);

  it("matches the header the game writes", () => {
    expect(bmp[0]).toBe(0x42);
    expect(bmp[1]).toBe(0x4d);
    expect(bmp.length).toBe(2_006_838);
    expect(dv.getUint32(2, true)).toBe(2_006_838);
    expect(dv.getUint32(10, true)).toBe(54);
    expect(dv.getUint32(14, true)).toBe(40);
    expect(dv.getInt32(18, true)).toBe(624);
    expect(dv.getInt32(22, true)).toBe(804); // positive = bottom-up
    expect(dv.getUint16(28, true)).toBe(32);
    expect(dv.getUint32(30, true)).toBe(0);
    expect(dv.getUint32(34, true)).toBe(0);
    expect(dv.getInt32(38, true)).toBe(2835);
  });

  it("writes the top row last, as BGRA", () => {
    const lastRow = 54 + (TILE_H - 1) * TILE_W * 4;
    expect(bmp[lastRow]).toBe(30); // B
    expect(bmp[lastRow + 1]).toBe(20); // G
    expect(bmp[lastRow + 2]).toBe(10); // R
    expect(bmp[lastRow + 3]).toBe(0xff);
  });

  it("rejects a buffer of the wrong size", () => {
    expect(() => encodeBmp32(new Uint8ClampedArray(4))).toThrow();
  });
});
