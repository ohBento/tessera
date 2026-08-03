import { encodeBmp32, TILE_H, TILE_W } from "./bmp";
import { layerText, type Crop, type Effective, type Layer } from "./model";
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

async function paintLayer(
  ctx: OffscreenCanvasRenderingContext2D,
  dir: string,
  tileId: string,
  eff: Effective,
  layer: Layer,
  w: number,
  h: number,
) {
  ctx.save();
  ctx.globalAlpha = layer.opacity;
  ctx.globalCompositeOperation = layer.blend;
  ctx.filter = layer.filter || "none";
  ctx.translate(layer.x * w, layer.y * h);
  ctx.rotate((layer.rotation * Math.PI) / 180);

  if (layer.kind === "image") {
    const img = await loadAsset(dir, layer.asset);
    ctx.scale(layer.flipX ? -1 : 1, layer.flipY ? -1 : 1);
    const dw = layer.scale * w;
    const dh = (dw * img.height) / img.width;
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  } else {
    const text = layerText(eff.text, layer, tileId);
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
    ctx.fillStyle = layer.color;
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
