/* Pure geometry and text-layout maths, no canvas anywhere.
 *
 * What is left of the old render.ts. The drawing half of that module was a
 * second renderer alongside Fabric and is gone; these helpers survived because
 * they are the parts that were tested, correct, and are still needed — by
 * scene.ts now, and by shape, text and gradient building in M4. Keeping them
 * canvas-free is what lets them be tested in Node rather than a browser. */
import { TILE_H, TILE_W } from "./bmp";
import type { Crop, TextLayer } from "./model";

export const COLS = 7;

/** Fabric's own Text default. Anything laying out multi-line text has to agree
 *  with this or lines sit at different heights than Fabric draws them. */
export const LINE_HEIGHT = 1.16;

/** Where each line of a multi-line caption sits, relative to a block centred on
 *  the layer's y — matching Fabric's originY:"center" over the whole object. */
export function textLines(text: string, fontPx: number) {
  const lines = text.split("\n");
  const step = fontPx * LINE_HEIGHT;
  const first = -((lines.length - 1) / 2) * step;
  return lines.map((line, i) => ({ line, y: first + i * step }));
}

/** CSS font shorthand for a text layer. The order is fixed — style, weight,
 *  then size and family. Get it wrong and the whole declaration is invalid, at
 *  which point a canvas silently keeps whatever font it had before rather than
 *  reporting anything. */
export const layerFont = (layer: TextLayer, fontPx: number) =>
  `${layer.italic ? "italic " : ""}${layer.bold ? "bold " : ""}${fontPx}px "${layer.font}"`;

/** Largest rectangle of `aspect` (w/h) that fits inside sw x sh, centred.
 *  Cover-crop rather than stretch — the original tool distorted here. */
export function coverCrop(sw: number, sh: number, aspect: number): Crop {
  const w = Math.min(sw, sh * aspect);
  const h = w / aspect;
  return { x: (sw - w) / 2, y: (sh - h) / 2, w, h };
}

/** The crop that fills one tile with a picture without distorting it. */
export const tileCover = (img: { width: number; height: number }) =>
  coverCrop(img.width, img.height, TILE_W / TILE_H);

/** Endpoints of a gradient line through the centre of a bw x bh box at the
 *  given angle (degrees, 0 = left to right). Kept separate from any gradient
 *  construction so the angle maths is testable on its own. */
export function gradientLine(angle: number, bw: number, bh: number) {
  const rad = (angle * Math.PI) / 180;
  const dx = (Math.cos(rad) * bw) / 2;
  const dy = (Math.sin(rad) * bh) / 2;
  return { x1: -dx, y1: -dy, x2: dx, y2: dy };
}

/** Regular n-gon vertices inscribed in a w x h box, first point straight up. */
export function polygonPoints(sides: number, w: number, h: number) {
  const n = Math.max(3, Math.round(sides));
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return { x: (Math.cos(a) * w) / 2, y: (Math.sin(a) * h) / 2 };
  });
}
