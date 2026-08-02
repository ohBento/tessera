/* BMP writer matching what Black Desert itself writes into FaceTexture:
 * 624x804, BITMAPINFOHEADER, 32 bpp BI_RGB, bottom-up, alpha 0xFF everywhere.
 * Verified against 59 of 60 real portrait files (the odd one out was 24 bpp,
 * almost certainly written by another tool). */

export const TILE_W = 624;
export const TILE_H = 804;

const HEADER = 54;
const PPM_72DPI = 2835;

export function encodeBmp32(
  rgba: Uint8ClampedArray,
  w = TILE_W,
  h = TILE_H,
): Uint8Array {
  const pixels = w * h * 4;
  if (rgba.length !== pixels) {
    throw new Error(`expected ${pixels} bytes of RGBA, got ${rgba.length}`);
  }

  const out = new Uint8Array(HEADER + pixels);
  const dv = new DataView(out.buffer);

  out[0] = 0x42;
  out[1] = 0x4d;
  dv.setUint32(2, out.length, true);
  dv.setUint32(10, HEADER, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true); // positive height = bottom-up, like the game
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 32, true);
  dv.setUint32(30, 0, true); // BI_RGB
  dv.setUint32(34, 0, true); // the game leaves image size at 0 for BI_RGB
  dv.setInt32(38, PPM_72DPI, true);
  dv.setInt32(42, PPM_72DPI, true);

  for (let y = 0; y < h; y++) {
    let s = (h - 1 - y) * w * 4;
    let d = HEADER + y * w * 4;
    for (let x = 0; x < w; x++, s += 4, d += 4) {
      out[d] = rgba[s + 2];
      out[d + 1] = rgba[s + 1];
      out[d + 2] = rgba[s];
      out[d + 3] = 0xff;
    }
  }
  return out;
}
