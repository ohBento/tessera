/** Stand-in for lib/project.ts, one level up from mockProject.ts: this one backs
 *  the *full app* (state.svelte.ts's whole import surface), not just the
 *  render/fabricBuild pair, so App.svelte can mount and reach a populated
 *  TileEditor without a Tauri shell. Scratch tool for the layout-check page —
 *  not wired into vite.config.ts, delete alongside layout-check.html once the
 *  editor-pane width bug is confirmed fixed. */

import { emptyManifest, emptyTile, newImageLayer, newShapeLayer, newTextLayer, type Manifest, type Tile } from "../lib/model";

type Applied = Record<string, Tile>;

const TILE_IDS = ["tile_A", "tile_B", "tile_C"];

function paint(hue: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 624;
  c.height = 804;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = `hsl(${hue} 55% 40%)`;
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

const tileCanvases = new Map(TILE_IDS.map((id, i) => [id, paint(i * 90)]));

export const defaultDir = async () => "C:/mock/FaceTexture";

export async function listTiles(_dir: string) {
  return TILE_IDS;
}

export async function loadManifest(_dir: string, ids: string[]): Promise<Manifest> {
  const m = emptyManifest();
  for (const id of ids) m.tiles[id] = emptyTile();
  const shape = newShapeLayer("polygon");
  shape.name = "poly_test";
  const text = newTextLayer();
  text.name = "text_test";
  const image = newImageLayer("mock.png");
  image.name = "img_test";
  m.tiles["tile_A"].layers = [shape, text, image];
  m.order = ids;
  return m;
}

export async function vaultedIds(_dir: string): Promise<string[]> {
  return [];
}

export async function loadApplied(_dir: string): Promise<Applied> {
  return {};
}

export async function listSnapshots(_dir: string): Promise<string[]> {
  return [];
}

export async function loadOriginal(_dir: string, id: string): Promise<ImageBitmap> {
  return createImageBitmap(tileCanvases.get(id) ?? paint(0));
}

export async function loadAsset(_dir: string, _name: string): Promise<ImageBitmap> {
  return createImageBitmap(paint(200));
}

export async function assetUrl(_dir: string, _name: string): Promise<string> {
  return paint(200).toDataURL("image/png");
}

// Unused by the layout check but statically imported by state.svelte.ts.
export async function deleteSnapshot(_dir: string, _name: string) {}
export async function importAsset(_dir: string, _sourcePath: string) { return ""; }
export async function readSnapshot(_dir: string, _name: string): Promise<Manifest> { return emptyManifest(); }
export async function restoreFromVault(_dir: string, _id: string) {}
export async function saveApplied(_dir: string, _tiles: Applied) {}
export async function saveManifest(_dir: string, _m: Manifest) {}
export const tilePath = async (_dir: string, id: string) => `${id}.bmp`;
export async function vaultOriginal(_dir: string, _id: string) {}
export const vaultPath = async (_dir: string, id: string) => `vault/${id}.bmp`;
export async function writeSnapshot(_dir: string, _name: string, _m: Manifest) {}
