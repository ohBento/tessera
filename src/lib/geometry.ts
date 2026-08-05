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

export const rowsFor = (count: number) => Math.ceil(count / COLS);

export const gridSize = (count: number) => ({
  w: COLS * TILE_W,
  h: rowsFor(count) * TILE_H,
});

/** Top-left corner of the nth grid slot, in grid pixels. */
export const cellAt = (index: number) => ({
  x: (index % COLS) * TILE_W,
  y: Math.floor(index / COLS) * TILE_H,
});

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

/** Which tiles a positioned grid-space picture fully covers, and the crop of
 *  the picture's own pixels landing on each — the inverse of scene.ts placing
 *  an image at `layer.x/y` (grid fraction, centre origin) scaled to
 *  `layer.scale * gridWidth`.
 *
 *  A tile's `base` always fills the whole tile — there is no partial-coverage
 *  crop to fall back on — so a tile the picture only partly overlaps is left
 *  out rather than stretched or guessed at. Rotation is not a parameter on
 *  purpose: `Base` has no rotation field, so a rotated picture has no crop that
 *  could reproduce it, and this signature is what stops a caller from trying. */
export function mosaicBakeCrops(
  layer: { x: number; y: number; scale: number },
  natural: { w: number; h: number },
  cellCount: number,
): Map<number, Crop> {
  const grid = gridSize(cellCount);
  const dispW = layer.scale * grid.w;
  const dispH = dispW * (natural.h / natural.w);
  const imgLeft = layer.x * grid.w - dispW / 2;
  const imgTop = layer.y * grid.h - dispH / 2;
  const imgRight = imgLeft + dispW;
  const imgBottom = imgTop + dispH;
  const natPerGrid = natural.w / dispW;

  const eps = 0.5; // grid pixels — absorbs float rounding, not a real gap
  const out = new Map<number, Crop>();
  for (let i = 0; i < cellCount; i++) {
    const at = cellAt(i);
    const fits =
      imgLeft <= at.x + eps &&
      imgTop <= at.y + eps &&
      imgRight >= at.x + TILE_W - eps &&
      imgBottom >= at.y + TILE_H - eps;
    if (!fits) continue;
    out.set(i, {
      x: (at.x - imgLeft) * natPerGrid,
      y: (at.y - imgTop) * natPerGrid,
      w: TILE_W * natPerGrid,
      h: TILE_H * natPerGrid,
    });
  }
  return out;
}
