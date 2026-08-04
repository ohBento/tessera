import { encodeBmp32, TILE_H, TILE_W } from "./bmp";
import { findLayer, isGradient, layerText, type Crop, type Effective, type Layer, type Paint, type ShapeLayer, type TextLayer } from "./model";
import { loadAsset, loadOriginal } from "./project";

export const COLS = 7;

/** Fabric's own Text default. The editor and this path have to agree on it or
 *  a multi-line caption sits at different heights in the preview and the BMP. */
export const LINE_HEIGHT = 1.16;

/** fillText draws no line breaks at all — it would render "a\nb" as one run —
 *  so lines are placed by hand. The block is centred on the layer's y, matching
 *  Fabric's originY:"center" over the whole text object. */
export function textLines(text: string, fontPx: number) {
  const lines = text.split("\n");
  const step = fontPx * LINE_HEIGHT;
  const first = -((lines.length - 1) / 2) * step;
  return lines.map((line, i) => ({ line, y: first + i * step }));
}

/** CSS font shorthand for a text layer. The order is fixed — style, weight,
 *  then size and family. Get it wrong and the whole declaration is invalid,
 *  at which point a canvas silently keeps whatever font it had before rather
 *  than reporting anything. */
export const layerFont = (layer: TextLayer, fontPx: number) =>
  `${layer.italic ? "italic " : ""}${layer.bold ? "bold " : ""}${fontPx}px "${layer.font}"`;

/** Largest rectangle of `aspect` (w/h) that fits inside sw x sh, centred.
 *  Cover-crop rather than stretch — the original tool distorted here. */
export function coverCrop(sw: number, sh: number, aspect: number): Crop {
  const w = Math.min(sw, sh * aspect);
  const h = w / aspect;
  return { x: (sw - w) / 2, y: (sh - h) / 2, w, h };
}

export const gridRows = (count: number) => Math.ceil(count / COLS);

export const gridAspect = (count: number) => (COLS * TILE_W) / (gridRows(count) * TILE_H);

/** Where the grid sits on the source image before the user moves it. */
export const defaultMosaicRect = (sw: number, sh: number, count: number) =>
  coverCrop(sw, sh, gridAspect(count));

/** Hands each tile its own cell of the placed rectangle. */
export function splitRect(rect: Crop, count: number): Crop[] {
  const rows = gridRows(count);
  const cw = rect.w / COLS;
  const ch = rect.h / rows;
  return Array.from({ length: count }, (_, i) => ({
    x: rect.x + (i % COLS) * cw,
    y: rect.y + Math.floor(i / COLS) * ch,
    w: cw,
    h: ch,
  }));
}

/** One image spread over the grid at its default placement. */
export const mosaicCrops = (sw: number, sh: number, count: number) =>
  splitRect(defaultMosaicRect(sw, sh, count), count);

export const tileCover = (img: { width: number; height: number }) =>
  coverCrop(img.width, img.height, TILE_W / TILE_H);

/** Endpoints of a gradient line through the centre of a bw x bh box at the
 *  given angle (degrees, 0 = left to right). Kept pure and separate from
 *  CanvasGradient construction so the angle math is testable without a
 *  canvas. */
export function gradientLine(angle: number, bw: number, bh: number) {
  const rad = (angle * Math.PI) / 180;
  const dx = (Math.cos(rad) * bw) / 2;
  const dy = (Math.sin(rad) * bh) / 2;
  return { x1: -dx, y1: -dy, x2: dx, y2: dy };
}

/** Resolves a solid colour or a Gradient into a CanvasGradient sized to a
 *  bounding box centred on the current transform origin. Called after the
 *  layer's own translate/rotate, so (0,0) is already the layer's centre. */
function resolvePaint(
  ctx: OffscreenCanvasRenderingContext2D,
  paint: Paint,
  bw: number,
  bh: number,
): string | CanvasGradient {
  if (!isGradient(paint)) return paint;
  let grad: CanvasGradient;
  if (paint.radial) {
    grad = ctx.createRadialGradient(0, 0, 0, 0, 0, (Math.max(bw, bh) / 2) * (paint.radius ?? 1));
  } else {
    const { x1, y1, x2, y2 } = gradientLine(paint.angle, bw, bh);
    grad = ctx.createLinearGradient(x1, y1, x2, y2);
  }
  grad.addColorStop(0, paint.from);
  grad.addColorStop(1, paint.to);
  return grad;
}

/** Regular n-gon vertices inscribed in a w x h box, first point straight up.
 *  Pure and separate from Path2D construction so it is testable without a
 *  canvas — Path2D does not exist outside a browser. */
export function polygonPoints(sides: number, w: number, h: number) {
  const n = Math.max(3, Math.round(sides));
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return { x: (Math.cos(a) * w) / 2, y: (Math.sin(a) * h) / 2 };
  });
}

/** Path centred on the current transform origin, in tile pixels. */
function shapePath(layer: ShapeLayer, tileW: number, tileH: number): Path2D {
  const w = layer.w * tileW;
  const h = layer.h * tileH;
  const path = new Path2D();
  if (layer.shape === "rect") {
    const r = Math.min(w, h) * Math.min(Math.max(layer.cornerRadius, 0), 0.5);
    path.roundRect(-w / 2, -h / 2, w, h, r);
  } else if (layer.shape === "ellipse") {
    path.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else {
    const [first, ...rest] = polygonPoints(layer.sides, w, h);
    path.moveTo(first.x, first.y);
    for (const p of rest) path.lineTo(p.x, p.y);
    path.closePath();
  }
  return path;
}

/** The mask's own alpha shape, drawn under whatever composite operation the
 *  caller has set. Not drawSilhouette: that one recolours an image by
 *  switching the context to "source-in", which overrides the caller's
 *  "destination-in" and repaints the masked layer flat instead of cutting it.
 *  Text and shapes have no such step, which is why only image masks broke. */
function drawMaskAlpha(
  ctx: OffscreenCanvasRenderingContext2D,
  layer: Layer,
  img: ImageBitmap | null,
  text: string,
  w: number,
  h: number,
) {
  if (layer.kind === "image" && img) {
    ctx.scale(layer.flipX ? -1 : 1, layer.flipY ? -1 : 1);
    const dw = layer.scale * w;
    const dh = (dw * img.height) / img.width;
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    return;
  }
  drawSilhouette(ctx, layer, img, text, w, h, "#fff");
}

/** Draws the layer's silhouette in a single flat colour, alpha preserved —
 *  used to build the glow halo. For images, the drawn picture is recoloured
 *  via "source-in" since an image's own colours are not what a glow should be
 *  shaped from. */
function drawSilhouette(
  ctx: OffscreenCanvasRenderingContext2D,
  layer: Layer,
  img: ImageBitmap | null,
  text: string,
  w: number,
  h: number,
  color: Paint,
) {
  if (layer.kind === "image" && img) {
    ctx.scale(layer.flipX ? -1 : 1, layer.flipY ? -1 : 1);
    const dw = layer.scale * w;
    const dh = (dw * img.height) / img.width;
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = resolvePaint(ctx, color, dw, dh);
    ctx.fillRect(-dw / 2, -dh / 2, dw, dh);
  } else if (layer.kind === "text") {
    const fontPx = layer.size * w;
    ctx.font = layerFont(layer, fontPx);
    ctx.textAlign = layer.align ?? "center";
    ctx.textBaseline = "middle";
    const rows = textLines(text, fontPx);
    const widest = Math.max(...rows.map((r) => ctx.measureText(r.line).width));
    ctx.fillStyle = resolvePaint(ctx, color, widest, fontPx);
    for (const r of rows) ctx.fillText(r.line, 0, r.y);
  } else if (layer.kind === "shape") {
    ctx.fillStyle = resolvePaint(ctx, color, layer.w * w, layer.h * h);
    ctx.fill(shapePath(layer, w, h));
  }
}

/** Glow is a blurred, independently-opaque halo — Canvas2D's own shadow API
 *  ties shadow alpha to the shape's fill alpha, which cannot express "faint
 *  glow behind a fully opaque layer". Built as two extra offscreen passes
 *  instead: silhouette, then blur, then composited under the real layer. */
function paintGlow(
  main: OffscreenCanvasRenderingContext2D,
  layer: Layer,
  img: ImageBitmap | null,
  text: string,
  w: number,
  h: number,
) {
  if (!layer.glow) return;
  const shape = new OffscreenCanvas(w, h);
  const sctx = shape.getContext("2d")!;
  sctx.setTransform(main.getTransform());
  drawSilhouette(sctx, layer, img, text, w, h, layer.glowColor || "#ffffff");

  const blurred = new OffscreenCanvas(w, h);
  const bctx = blurred.getContext("2d")!;
  bctx.filter = `blur(${layer.glow * w}px)`;
  bctx.drawImage(shape, 0, 0);

  main.save();
  main.setTransform(1, 0, 0, 1, 0, 0);
  main.globalAlpha = layer.glowOpacity ?? 1;
  main.drawImage(blurred, 0, 0);
  main.restore();
}

/** Draws a list of layers in order, skipping hidden ones. Groups recurse
 *  through here, which is what makes nesting work at any depth. */
async function paintLayers(
  ctx: OffscreenCanvasRenderingContext2D,
  dir: string,
  tileId: string,
  eff: Effective,
  layers: Layer[],
  w: number,
  h: number,
) {
  for (const layer of layers) {
    if (layer.hidden) continue;
    await paintLayer(ctx, dir, tileId, eff, layer, w, h);
  }
}

/** A group flattens its children onto their own canvas first, then composites
 *  that once. Painting them straight onto the parent would apply the group's
 *  opacity per child, so overlapping half-transparent members would show
 *  through each other instead of fading as one object. */
async function paintGroup(
  ctx: OffscreenCanvasRenderingContext2D,
  dir: string,
  tileId: string,
  eff: Effective,
  layer: Layer & { kind: "group" },
  w: number,
  h: number,
) {
  const inner = new OffscreenCanvas(w, h);
  const ictx = inner.getContext("2d")!;
  ictx.imageSmoothingQuality = "high";
  await paintLayers(ictx, dir, tileId, eff, layer.children, w, h);

  ctx.save();
  ctx.globalAlpha = layer.opacity;
  ctx.globalCompositeOperation = layer.blend;
  // Children carry absolute tile coordinates, so the group's own x/y is a
  // displacement from centre rather than a position — 0.5/0.5 means "unmoved".
  ctx.translate(w / 2 + (layer.x - 0.5) * w, h / 2 + (layer.y - 0.5) * h);
  ctx.rotate((layer.rotation * Math.PI) / 180);
  ctx.drawImage(inner, -w / 2, -h / 2);
  ctx.restore();
}

/** Draws just the layer's own picture/glyphs/fill — no transform, no mask, no
 *  effects. Shared by the normal paint path and the text-mask scratch canvas
 *  below, which both need exactly this and nothing more. */
function drawLayerContent(
  ctx: OffscreenCanvasRenderingContext2D,
  layer: Layer,
  img: ImageBitmap | null,
  text: string,
  w: number,
  h: number,
) {
  if (layer.kind === "image" && img) {
    ctx.scale(layer.flipX ? -1 : 1, layer.flipY ? -1 : 1);
    const dw = layer.scale * w;
    const dh = (dw * img.height) / img.width;
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  } else if (layer.kind === "text") {
    const fontPx = layer.size * w;
    ctx.font = layerFont(layer, fontPx);
    ctx.textAlign = layer.align ?? "center";
    ctx.textBaseline = "middle";
    if (layer.shadow > 0) {
      ctx.shadowBlur = layer.shadow * w;
      ctx.shadowColor = layer.shadowColor;
    }
    const rows = textLines(text, fontPx);
    if (layer.strokeWidth > 0) {
      ctx.lineWidth = layer.strokeWidth * w;
      ctx.strokeStyle = layer.strokeColor;
      ctx.lineJoin = "round";
      for (const r of rows) ctx.strokeText(r.line, 0, r.y);
    }
    const widest = Math.max(...rows.map((r) => ctx.measureText(r.line).width));
    ctx.fillStyle = resolvePaint(ctx, layer.color, widest, fontPx);
    for (const r of rows) ctx.fillText(r.line, 0, r.y);
  } else if (layer.kind === "shape") {
    const path = shapePath(layer, w, h);
    ctx.fillStyle = resolvePaint(ctx, layer.fill, layer.w * w, layer.h * h);
    ctx.fill(path);
    if (layer.borderWidth > 0) {
      ctx.lineWidth = layer.borderWidth * w;
      ctx.strokeStyle = layer.borderColor;
      ctx.stroke(path);
    }
  }
}

async function paintLayer(
  ctx: OffscreenCanvasRenderingContext2D,
  dir: string,
  tileId: string,
  eff: Effective,
  layer: Layer,
  w: number,
  h: number,
) {
  if (layer.kind === "group") return paintGroup(ctx, dir, tileId, eff, layer, w, h);

  const img = layer.kind === "image" ? await loadAsset(dir, layer.asset) : null;
  const text = layer.kind === "text" ? layerText(eff.text, layer, tileId) : "";
  const maskLayer = layer.maskId ? findLayer(eff.layers, layer.maskId) : undefined;

  if (maskLayer?.kind === "text" || maskLayer?.kind === "image") {
    // Neither text nor an image has a Path2D to clip against like a shape
    // does, so this layer is rendered in isolation on its own canvas and then
    // cut down to the mask's silhouette via destination-in. Doing that on the
    // shared tile canvas directly would erase everything already painted
    // underneath it, not just this layer.
    const scratch = new OffscreenCanvas(w, h);
    const sctx = scratch.getContext("2d")!;
    sctx.imageSmoothingQuality = "high";
    sctx.save();
    sctx.translate(layer.x * w, layer.y * h);
    sctx.rotate((layer.rotation * Math.PI) / 180);
    paintGlow(sctx, layer, img, text, w, h);
    drawLayerContent(sctx, layer, img, text, w, h);
    sctx.restore();

    const maskImg = maskLayer.kind === "image" ? await loadAsset(dir, maskLayer.asset) : null;
    const maskText = maskLayer.kind === "text" ? layerText(eff.text, maskLayer, tileId) : "";
    sctx.save();
    sctx.globalCompositeOperation = "destination-in";
    sctx.translate(maskLayer.x * w, maskLayer.y * h);
    sctx.rotate((maskLayer.rotation * Math.PI) / 180);
    drawMaskAlpha(sctx, maskLayer, maskImg, maskText, w, h);
    sctx.restore();

    ctx.save();
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = layer.blend;
      ctx.drawImage(scratch, 0, 0);
    ctx.restore();
    return;
  }

  const mask = maskLayer?.kind === "shape" ? maskLayer : undefined;

  ctx.save();
  if (mask) {
    // Clip in the mask's own frame, then reset the transform: clip() is
    // recorded in device space once applied, so it survives the reset while
    // the image below still gets its own independent position and rotation.
    ctx.translate(mask.x * w, mask.y * h);
    ctx.rotate((mask.rotation * Math.PI) / 180);
    ctx.clip(shapePath(mask, w, h));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  ctx.translate(layer.x * w, layer.y * h);
  ctx.rotate((layer.rotation * Math.PI) / 180);

  paintGlow(ctx, layer, img, text, w, h);

  ctx.globalAlpha = layer.opacity;
  ctx.globalCompositeOperation = layer.blend;
  drawLayerContent(ctx, layer, img, text, w, h);
  ctx.restore();
}

/** The single render path. Preview and export differ only in size, so what the
 *  user sees is what the game gets.
 *
 *  A tile with layers but no explicit base picture falls back to its own
 *  original as the background — without it, a shape or text added straight onto
 *  an untouched tile had nothing under it and the face vanished. */
export async function drawTile(dir: string, tileId: string, eff: Effective, w: number, h: number) {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";

  if (eff.base) {
    const img = await loadAsset(dir, eff.base.asset);
    const c = eff.base.crop;
    ctx.drawImage(img, c.x, c.y, c.w, c.h, 0, 0, w, h);
  } else if (eff.layers.length) {
    ctx.drawImage(await loadOriginal(dir, tileId), 0, 0, w, h);
  }
  await paintLayers(ctx, dir, tileId, eff, eff.layers, w, h);
  return canvas;
}

/** Previews render at display size — 60 tiles at full 624x804 would cost
 *  ~120 MB of canvases for pixels nobody looks at. */
export async function previewUrl(dir: string, tileId: string, eff: Effective, w: number) {
  const canvas = await drawTile(dir, tileId, eff, w, Math.round((w * TILE_H) / TILE_W));
  return URL.createObjectURL(await canvas.convertToBlob({ type: "image/png" }));
}

export async function exportBmp(dir: string, tileId: string, eff: Effective) {
  const canvas = await drawTile(dir, tileId, eff, TILE_W, TILE_H);
  return encodeBmp32(canvas.getContext("2d")!.getImageData(0, 0, TILE_W, TILE_H).data);
}
