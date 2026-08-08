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

/** Whether a keystroke belongs to a field the user is typing in.
 *
 *  Every shortcut has to ask this, and asking it as `instanceof
 *  HTMLInputElement` misses `<textarea>` — which is what the caption field is.
 *  The result was that a space never reached the text, Escape closed the whole
 *  document mid-word, and Ctrl+Z undid a model edit instead of a character.
 *  One predicate, so the next field type is fixed everywhere at once. */
export const isTyping = (el: EventTarget | Element | null): boolean =>
  el instanceof HTMLElement &&
  (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable);

export const rowsFor = (count: number) => Math.ceil(count / COLS);

/** The space the game leaves between portraits, in tile pixels.
 *
 *  Not decoration. The character grid in play is not one continuous surface,
 *  and a picture spread across the wall is cut by those gaps — the strips
 *  falling into them are never shown. Building them into the geometry is what
 *  makes the wall a preview of the game rather than of itself: a spread lines
 *  up in play, and a caption pushed towards an edge looks as wrong here as it
 *  will there.
 *
 *  One fraction for both axes, so the spacing reads as even. Measured off a
 *  screenshot of the character select, so it is close rather than exact — the
 *  game scales its grid with the window. One number to tune. */
const GAP = 0.035;
export const GAP_X = Math.round(TILE_W * GAP);
export const GAP_Y = Math.round(TILE_H * GAP);

/** Distance from one slot to the next, tile plus gap. */
const STEP_X = TILE_W + GAP_X;
const STEP_Y = TILE_H + GAP_Y;

export const gridSize = (count: number) => ({
  // The trailing gap is not part of the wall — there is nothing after the last
  // column to be separated from.
  w: COLS * STEP_X - GAP_X,
  h: rowsFor(count) * STEP_Y - GAP_Y,
});

/** Top-left corner of the nth grid slot, in grid pixels. */
export const cellAt = (index: number) => ({
  x: (index % COLS) * STEP_X,
  y: Math.floor(index / COLS) * STEP_Y,
});

/** Which slot a grid-pixel point lands on, or -1 for the gaps between slots and
 *  anywhere past the last tile. The inverse of cellAt, and it has to be built
 *  from the same step: dividing by the tile size instead — which is what the
 *  hit test used to do — leaves out the gap, so every column's hit box sat one
 *  gap further right than the tile drawn there. The drift accumulates across
 *  the row, and near the right edge of the last column it named the neighbour
 *  a fifth of a tile early. Same story down the rows. */
export function cellIndexAt(x: number, y: number, count: number): number {
  const col = Math.floor(x / STEP_X);
  const row = Math.floor(y / STEP_Y);
  if (col < 0 || col >= COLS || row < 0) return -1;
  // Landed in the space between portraits, which belongs to no tile — the game
  // shows nothing there either.
  if (x - col * STEP_X >= TILE_W || y - row * STEP_Y >= TILE_H) return -1;
  const index = row * COLS + col;
  return index < count ? index : -1;
}

/** The slots a rectangle touches, in grid order — what a rubber band picks.
 *
 *  Overlap, not containment: sweeping a thin band across a row should take the
 *  whole row, and requiring a cell to be swallowed whole would mean drawing a
 *  band taller than a tile to select anything at all. Zero-size bands touch
 *  nothing, which is what keeps a click from counting as a sweep. */
export function cellsIn(
  r: { x: number; y: number; w: number; h: number },
  count: number,
): number[] {
  if (r.w <= 0 || r.h <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const at = cellAt(i);
    if (at.x < r.x + r.w && at.x + TILE_W > r.x && at.y < r.y + r.h && at.y + TILE_H > r.y)
      out.push(i);
  }
  return out;
}

/* --- Snapping. Kept here, canvas-free, because it is the part that is easy to
 * get subtly wrong and impossible to eyeball: an off-by-one in which edge
 * lines up with which looks like "snapping feels a bit off" rather than a
 * bug. --- */

/** A box being dragged, or something to line it up against. */
export type Box = { left: number; top: number; width: number; height: number };

/** One line a box was pulled onto, in scene coordinates — what the editor
 *  draws as a guide. */
export type Guide = { axis: "x" | "y"; at: number };

export type Snap = { dx: number; dy: number; guides: Guide[] };

/** The three interesting positions along one axis: both edges and the middle. */
const stops = (start: number, size: number) => [start, start + size / 2, start + size];

/** Pulls `moving` onto whichever of `targets` lies within `threshold`.
 *
 *  Each axis is decided on its own — a box can be flush with one layer on the
 *  left while its centre lines up with another vertically, and that pairing is
 *  most of what makes snapping feel like it is helping rather than fighting.
 *  The nearest candidate wins per axis; ties go to the first, which is the
 *  sheet, because lining up with the page beats lining up with a neighbour.
 *
 *  `threshold` is in scene units and the caller converts from screen pixels,
 *  so the pull stays the same size on screen at any zoom. */
export function snapBox(moving: Box, targets: Box[], threshold: number): Snap {
  const best = { x: { d: threshold, at: 0, from: 0, hit: false }, y: { d: threshold, at: 0, from: 0, hit: false } };

  for (const t of targets) {
    const pairs = [
      ["x", stops(moving.left, moving.width), stops(t.left, t.width)],
      ["y", stops(moving.top, moving.height), stops(t.top, t.height)],
    ] as const;
    for (const [axis, mine, theirs] of pairs) {
      for (const m of mine) {
        for (const o of theirs) {
          const d = Math.abs(o - m);
          if (d < best[axis].d) best[axis] = { d, at: o, from: m, hit: true };
        }
      }
    }
  }

  const guides: Guide[] = [];
  if (best.x.hit) guides.push({ axis: "x", at: best.x.at });
  if (best.y.hit) guides.push({ axis: "y", at: best.y.at });
  return {
    dx: best.x.hit ? best.x.at - best.x.from : 0,
    dy: best.y.hit ? best.y.at - best.y.from : 0,
    guides,
  };
}

/** Which side of a box the pointer has hold of. */
export type Edge = "left" | "right" | "top" | "bottom";

/** How far the edges under the pointer must travel to land on a nearby line.
 *
 *  Scaling is not moving. Only the dragged edges go anywhere; the opposite
 *  side is the anchor and has to stay exactly where it is — so the whole-box
 *  correction snapBox computes would drag that anchor along with it, and a box
 *  already flush on its anchor side would report "nothing to do" while the
 *  edge under the pointer sailed past everything.
 *
 *  Edges only, no middles: a half-scaled box lining its centre up with
 *  something is a coincidence rather than an intent, and pulling towards it
 *  would fight the hand that is sizing the thing. */
export function snapEdges(moving: Box, edges: Edge[], targets: Box[], threshold: number): Snap {
  const best = {
    x: { d: threshold, at: 0, from: 0, hit: false },
    y: { d: threshold, at: 0, from: 0, hit: false },
  };
  const at = (e: Edge) =>
    e === "left"
      ? moving.left
      : e === "right"
        ? moving.left + moving.width
        : e === "top"
          ? moving.top
          : moving.top + moving.height;

  for (const t of targets) {
    for (const e of edges) {
      const axis = e === "left" || e === "right" ? "x" : "y";
      const mine = at(e);
      const theirs = axis === "x" ? [t.left, t.left + t.width] : [t.top, t.top + t.height];
      for (const o of theirs) {
        const d = Math.abs(o - mine);
        if (d < best[axis].d) best[axis] = { d, at: o, from: mine, hit: true };
      }
    }
  }

  const guides: Guide[] = [];
  if (best.x.hit) guides.push({ axis: "x", at: best.x.at });
  if (best.y.hit) guides.push({ axis: "y", at: best.y.at });
  return {
    dx: best.x.hit ? best.x.at - best.x.from : 0,
    dy: best.y.hit ? best.y.at - best.y.from : 0,
    guides,
  };
}

/* --- Align and distribute. GIMP's tool, reduced to what a tile sheet needs:
 * six edges against a fixed reference, and equal gaps between three or more.
 * Pure deltas in, deltas out, so the maths is testable without a canvas and
 * the caller decides what a box actually is. --- */

export type AlignEdge = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";

/** How far to move each box so the chosen edge lines up with `ref`'s.
 *  One axis per call — the other delta is always 0 — because aligning
 *  horizontally must not disturb vertical positions, and vice versa. */
export function alignBoxes(boxes: Box[], edge: AlignEdge, ref: Box): { dx: number; dy: number }[] {
  const want = {
    left: ref.left,
    centerX: ref.left + ref.width / 2,
    right: ref.left + ref.width,
    top: ref.top,
    centerY: ref.top + ref.height / 2,
    bottom: ref.top + ref.height,
  }[edge];
  return boxes.map((b) => {
    const mine = {
      left: b.left,
      centerX: b.left + b.width / 2,
      right: b.left + b.width,
      top: b.top,
      centerY: b.top + b.height / 2,
      bottom: b.top + b.height,
    }[edge];
    const d = want - mine;
    return edge === "left" || edge === "centerX" || edge === "right"
      ? { dx: d, dy: 0 }
      : { dx: 0, dy: d };
  });
}

/** Equal gaps along one axis — GIMP's "distribute gaps". The outermost two
 *  boxes stay where they are; the space left over between them is split into
 *  identical gaps. Deltas come back in the order the boxes went in, so the
 *  caller can zip them with whatever the boxes stand for. Fewer than three
 *  boxes have no middle to spread, so nothing moves. */
export function distributeBoxes(boxes: Box[], axis: "x" | "y"): { dx: number; dy: number }[] {
  const none = boxes.map(() => ({ dx: 0, dy: 0 }));
  if (boxes.length < 3) return none;

  const start = axis === "x" ? (b: Box) => b.left : (b: Box) => b.top;
  const size = axis === "x" ? (b: Box) => b.width : (b: Box) => b.height;

  const order = boxes.map((b, i) => i).sort((a, b) => start(boxes[a]) - start(boxes[b]));
  const first = boxes[order[0]];
  const last = boxes[order[order.length - 1]];
  const span = start(last) + size(last) - start(first);
  const gap = (span - order.reduce((sum, i) => sum + size(boxes[i]), 0)) / (order.length - 1);

  let at = start(first);
  const out = none;
  for (const i of order) {
    const d = at - start(boxes[i]);
    out[i] = axis === "x" ? { dx: d, dy: 0 } : { dx: 0, dy: d };
    at += size(boxes[i]) + gap;
  }
  return out;
}

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

/** The scale at which a wall picture just encloses the whole grid.
 *
 *  `scale` is the picture's width as a share of the grid's, and the height
 *  follows from the picture's own proportions — one number, so the four edges
 *  cannot be laid on the grid's four edges at once. The shorter axis decides:
 *  a picture wider in proportion than the grid has to be blown up until its
 *  height reaches, and a taller one until its width does.
 *
 *  Enclosing the grid is exactly the condition under which baking reaches every
 *  tile, since the per-tile test is "does the picture cover this cell whole" and
 *  every cell is inside the grid box. Which is why this exists: a picture
 *  dropped in at scale 1 is only as wide as the wall, and on a seven-row wall
 *  that leaves the top and bottom rows bare with nothing saying so. */
export const coverScale = (
  natural: { w: number; h: number },
  grid: { w: number; h: number },
) => Math.max(1, grid.h / (grid.w * (natural.h / natural.w)));

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
