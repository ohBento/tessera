import {
  copyFile,
  exists,
  mkdir,
  readDir,
  readFile,
  readTextFile,
  rename,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { documentDir, join } from "@tauri-apps/api/path";

import { emptyManifest, emptyTile, migrate, type Manifest, type Tile } from "./model";

export async function defaultDir() {
  return join(await documentDir(), "Black Desert", "FaceTexture");
}

/** Everything Tessera owns lives beside the folder it edits, never inside it. */
export const projectDir = (dir: string) => join(dir, "..", "FaceTexture.tessera");
const manifestPath = async (dir: string) => join(await projectDir(dir), "manifest.json");
export const assetsDir = async (dir: string) => join(await projectDir(dir), "assets");
export const vaultDir = async (dir: string) => join(await projectDir(dir), "vault");

export async function listTiles(dir: string) {
  const entries = await readDir(dir);
  return entries
    .filter((e) => e.isFile && e.name.toLowerCase().endsWith(".bmp"))
    .map((e) => e.name.replace(/\.bmp$/i, ""))
    .sort();
}

export const tilePath = (dir: string, id: string) => join(dir, `${id}.bmp`);

export async function loadManifest(dir: string, ids: string[]): Promise<Manifest> {
  let m = emptyManifest();
  try {
    m = migrate(JSON.parse(await readTextFile(await manifestPath(dir))));
  } catch {
    // no project yet, or unreadable — start clean rather than block the folder
  }
  // Characters get created and deleted between sessions; the folder wins.
  m.order = [...m.order.filter((id) => ids.includes(id)), ...ids.filter((id) => !m.order.includes(id))];
  m.hidden = m.hidden.filter((id) => ids.includes(id));
  for (const id of Object.keys(m.tiles)) if (!ids.includes(id)) delete m.tiles[id];
  for (const id of ids) m.tiles[id] ??= emptyTile();
  return m;
}

/** What was last written into the game folder. Kept out of the manifest on
 *  purpose: undo must never change what is already on disk. */
const appliedPath = async (dir: string) => join(await projectDir(dir), "applied.json");

export type Applied = Record<string, Tile>;

export async function loadApplied(dir: string): Promise<Applied> {
  try {
    return JSON.parse(await readTextFile(await appliedPath(dir)));
  } catch {
    return {};
  }
}

export async function saveApplied(dir: string, tiles: Applied) {
  await mkdir(await projectDir(dir), { recursive: true });
  await writeTextFile(await appliedPath(dir), JSON.stringify(tiles));
}

export async function saveManifest(dir: string, m: Manifest) {
  const path = await manifestPath(dir);
  await mkdir(await projectDir(dir), { recursive: true });
  await writeTextFile(`${path}.tmp`, JSON.stringify(m, null, 2));
  await rename(`${path}.tmp`, path);
}

/** Copies a picked image into assets/ under its content hash and returns the name. */
export async function importAsset(dir: string, sourcePath: string): Promise<string> {
  const bytes = await readFile(sourcePath);
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const hash = Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const ext = sourcePath.slice(sourcePath.lastIndexOf(".")).toLowerCase() || ".png";
  const name = `${hash}${ext}`;

  const assets = await assetsDir(dir);
  await mkdir(assets, { recursive: true });
  const target = await join(assets, name);
  if (!(await exists(target))) await writeFile(target, bytes);
  return name;
}

/** SVG needs its type spelled out or the blob will not decode at all. */
const mime = (name: string) => (name.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "");

const assetBlob = async (dir: string, name: string) =>
  new Blob([await readFile(await join(await assetsDir(dir), name))], { type: mime(name) });

const bitmaps = new Map<string, Promise<ImageBitmap>>();

export function loadAsset(dir: string, name: string): Promise<ImageBitmap> {
  let bmp = bitmaps.get(name);
  if (!bmp) {
    bmp = (async () => createImageBitmap(await assetBlob(dir, name)))();
    bitmaps.set(name, bmp);
  }
  return bmp;
}

const urls = new Map<string, Promise<string>>();

/** For showing an asset in an <img>, e.g. while placing the mosaic. */
export function assetUrl(dir: string, name: string): Promise<string> {
  let url = urls.get(name);
  if (!url) {
    url = (async () => URL.createObjectURL(await assetBlob(dir, name)))();
    urls.set(name, url);
  }
  return url;
}

/** Copies an untouched original into the vault. Never overwrites what is already there. */
export async function vaultOriginal(dir: string, id: string) {
  const vault = await vaultDir(dir);
  await mkdir(vault, { recursive: true });
  const backup = await join(vault, `${id}.bmp`);
  if (!(await exists(backup))) await copyFile(await tilePath(dir, id), backup);
}

export const vaultPath = async (dir: string, id: string) => join(await vaultDir(dir), `${id}.bmp`);

export async function restoreFromVault(dir: string, id: string) {
  const backup = await vaultPath(dir, id);
  if (await exists(backup)) await copyFile(backup, await tilePath(dir, id));
}

export async function vaultedIds(dir: string): Promise<string[]> {
  try {
    return (await readDir(await vaultDir(dir)))
      .filter((e) => e.isFile && e.name.toLowerCase().endsWith(".bmp"))
      .map((e) => e.name.replace(/\.bmp$/i, ""));
  } catch {
    return [];
  }
}
