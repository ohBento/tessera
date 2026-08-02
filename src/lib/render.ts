import { encodeBmp32, TILE_H, TILE_W } from "./bmp";
import { loadAsset, type Crop, type Manifest } from "./project";

export const COLS = 7;

/** Largest rectangle of `aspect` (w/h) that fits inside sw x sh, centred.
 *  Cover-crop rather than stretch — the original tool distorted here. */
export function coverCrop(sw: number, sh: number, aspect: number): Crop {
  const w = Math.min(sw, sh * aspect);
  const h = w / aspect;
  return { x: (sw - w) / 2, y: (sh - h) / 2, w, h };
}

/** One image spread over the grid: cover the whole grid once, then hand each
 *  tile its own cell of that rectangle. */
export function mosaicCrops(sw: number, sh: number, count: number): Crop[] {
  const rows = Math.ceil(count / COLS);
  const grid = coverCrop(sw, sh, (COLS * TILE_W) / (rows * TILE_H));
  const cw = grid.w / COLS;
  const ch = grid.h / rows;
  return Array.from({ length: count }, (_, i) => ({
    x: grid.x + (i % COLS) * cw,
    y: grid.y + Math.floor(i / COLS) * ch,
    w: cw,
    h: ch,
  }));
}

export const tileCover = (img: { width: number; height: number }) =>
  coverCrop(img.width, img.height, TILE_W / TILE_H);

async function draw(dir: string, tile: NonNullable<Manifest["tiles"][string]>, w: number, h: number) {
  const img = await loadAsset(dir, tile.asset);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  const c = tile.crop;
  ctx.drawImage(img, c.x, c.y, c.w, c.h, 0, 0, w, h);
  return canvas;
}

/** Preview at display size — rendering 60 tiles at full 624x804 would cost
 *  ~120 MB of canvases for pixels nobody looks at. */
export async function previewUrl(dir: string, tile: NonNullable<Manifest["tiles"][string]>, w: number) {
  const canvas = await draw(dir, tile, w, Math.round((w * TILE_H) / TILE_W));
  return URL.createObjectURL(await canvas.convertToBlob({ type: "image/png" }));
}

export async function exportBmp(dir: string, tile: NonNullable<Manifest["tiles"][string]>) {
  const canvas = await draw(dir, tile, TILE_W, TILE_H);
  const data = canvas.getContext("2d")!.getImageData(0, 0, TILE_W, TILE_H).data;
  return encodeBmp32(data);
}
