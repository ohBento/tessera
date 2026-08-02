import { copyFile, exists, mkdir, readDir, readFile, rename, writeFile } from "@tauri-apps/plugin-fs";
import { documentDir, join } from "@tauri-apps/api/path";
import { encodeBmp32, TILE_H, TILE_W } from "./bmp";

export type Portrait = { id: string; path: string; url: string };

export async function defaultDir() {
  return join(await documentDir(), "Black Desert", "FaceTexture");
}

/** The vault sits next to FaceTexture so it survives a game reinstall of the folder. */
async function vaultDir(dir: string) {
  return join(dir, "..", "FaceTexture.tessera-vault");
}

export async function loadPortraits(dir: string): Promise<Portrait[]> {
  const entries = await readDir(dir);
  const names = entries
    .filter((e) => e.isFile && e.name.toLowerCase().endsWith(".bmp"))
    .map((e) => e.name)
    .sort();

  // ponytail: every tile held as a blob (~2 MB each, ~120 MB at 60 tiles).
  // Swap for the asset protocol if memory becomes a problem.
  return Promise.all(
    names.map(async (name) => {
      const path = await join(dir, name);
      const bytes = await readFile(path);
      const url = URL.createObjectURL(new Blob([bytes], { type: "image/bmp" }));
      return { id: name.replace(/\.bmp$/i, ""), path, url };
    }),
  );
}

/** Scales to cover the tile and centre-crops the overflow — never distorts. */
export function renderCover(img: ImageBitmap): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(TILE_W, TILE_H);
  const ctx = canvas.getContext("2d")!;
  const scale = Math.max(TILE_W / img.width, TILE_H / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (TILE_W - w) / 2, (TILE_H - h) / 2, w, h);
  return ctx.getImageData(0, 0, TILE_W, TILE_H).data;
}

/** Copies the untouched original into the vault once, before anything is overwritten. */
async function vaultOriginal(dir: string, path: string, id: string) {
  const vault = await vaultDir(dir);
  if (!(await exists(vault))) await mkdir(vault, { recursive: true });
  const backup = await join(vault, `${id}.bmp`);
  if (!(await exists(backup))) await copyFile(path, backup);
}

export async function savePortrait(dir: string, p: Portrait, rgba: Uint8ClampedArray) {
  await vaultOriginal(dir, p.path, p.id);
  const tmp = `${p.path}.tmp`;
  await writeFile(tmp, encodeBmp32(rgba));
  await rename(tmp, p.path);
}
