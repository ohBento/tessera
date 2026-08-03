import { encodeBmp32, TILE_H, TILE_W } from "./bmp";
import { isGradient, layerText, type Crop, type Effective, type Layer, type Paint } from "./model";
import { loadAsset } from "./project";

export const COLS = 7;

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
    grad = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(bw, bh) / 2);
  } else {
    const { x1, y1, x2, y2 } = gradientLine(paint.angle, bw, bh);
    grad = ctx.createLinearGradient(x1, y1, x2, y2);
  }
  grad.addColorStop(0, paint.from);
  grad.addColorStop(1, paint.to);
  return grad;
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
  color: string,
) {
  if (layer.kind === "image" && img) {
    ctx.scale(layer.flipX ? -1 : 1, layer.flipY ? -1 : 1);
    const dw = layer.scale * w;
    const dh = (dw * img.height) / img.width;
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = color;
    ctx.fillRect(-dw / 2, -dh / 2, dw, dh);
  } else if (layer.kind === "text") {
    ctx.font = `${layer.size * w}px "${layer.font}"`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, 0, 0);
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
  drawSilhouette(sctx, layer, img, text, w, layer.glowColor || "#ffffff");

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

async function paintLayer(
  ctx: OffscreenCanvasRenderingContext2D,
  dir: string,
  tileId: string,
  eff: Effective,
  layer: Layer,
  w: number,
  h: number,
) {
  const img = layer.kind === "image" ? await loadAsset(dir, layer.asset) : null;
  const text = layer.kind === "text" ? layerText(eff.text, layer, tileId) : "";

  ctx.save();
  ctx.translate(layer.x * w, layer.y * h);
  ctx.rotate((layer.rotation * Math.PI) / 180);

  paintGlow(ctx, layer, img, text, w, h);

  ctx.globalAlpha = layer.opacity;
  ctx.globalCompositeOperation = layer.blend;
  ctx.filter = layer.filter || "none";

  if (layer.kind === "image" && img) {
    ctx.scale(layer.flipX ? -1 : 1, layer.flipY ? -1 : 1);
    const dw = layer.scale * w;
    const dh = (dw * img.height) / img.width;
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  } else if (layer.kind === "text") {
    ctx.font = `${layer.size * w}px "${layer.font}"`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (layer.shadow > 0) {
      ctx.shadowBlur = layer.shadow * w;
      ctx.shadowColor = layer.shadowColor;
    }
    if (layer.strokeWidth > 0) {
      ctx.lineWidth = layer.strokeWidth * w;
      ctx.strokeStyle = layer.strokeColor;
      ctx.lineJoin = "round";
      ctx.strokeText(text, 0, 0);
    }
    const metrics = ctx.measureText(text);
    ctx.fillStyle = resolvePaint(ctx, layer.color, metrics.width, layer.size * w);
    ctx.fillText(text, 0, 0);
  }
  ctx.restore();
}

/** The single render path. Preview and export differ only in size, so what the
 *  user sees is what the game gets. */
export async function drawTile(dir: string, tileId: string, eff: Effective, w: number, h: number) {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";

  if (eff.base) {
    const img = await loadAsset(dir, eff.base.asset);
    const c = eff.base.crop;
    ctx.drawImage(img, c.x, c.y, c.w, c.h, 0, 0, w, h);
  }
  for (const layer of eff.layers) await paintLayer(ctx, dir, tileId, eff, layer, w, h);
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
