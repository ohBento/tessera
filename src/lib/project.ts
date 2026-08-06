/* Every host call goes through platform.ts, which picks the Tauri plugins in
 * the app and an in-memory filesystem in a plain browser — that is what lets
 * the whole UI run and be tested without a native shell. */
import {
  copyFile,
  documentDir,
  exists,
  join,
  mkdir,
  readDir,
  readFile,
  readTextFile,
  remove,
  rename,
  writeFile,
  writeTextFile,
} from "./platform";

import { emptyManifest, emptyTile, migrate, type Manifest, type Tile } from "./model";
import type { SceneDeps } from "./scene";

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

async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Writes bytes into assets/ under their content hash, unless a file with that
 *  name is already there — shared by importAsset (bytes read from a picked
 *  file) and saveGeneratedAsset (bytes rendered in memory), so the hashing and
 *  write-once rule live in exactly one place. */
async function storeAsset(dir: string, bytes: Uint8Array, ext: string): Promise<string> {
  const name = `${await hashBytes(bytes)}${ext}`;
  const assets = await assetsDir(dir);
  await mkdir(assets, { recursive: true });
  const target = await join(assets, name);
  if (!(await exists(target))) await writeFile(target, bytes);
  return name;
}

/** Copies a picked image into assets/ under its content hash and returns the name. */
export async function importAsset(dir: string, sourcePath: string): Promise<string> {
  const ext = sourcePath.slice(sourcePath.lastIndexOf(".")).toLowerCase() || ".png";
  return storeAsset(dir, await readFile(sourcePath), ext);
}

/** Same content-addressed scheme as importAsset, for bytes that were rendered
 *  in memory (a Layout's stamp) rather than read from a picked file. */
export const saveGeneratedAsset = (dir: string, bytes: Uint8Array) => storeAsset(dir, bytes, ".png");

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

const originals = new Map<string, Promise<ImageBitmap>>();

/** The tile as the game shipped it: the vault copy once one exists, otherwise
 *  the file still sitting untouched in the game folder. Cacheable because both
 *  are immutable — saving vaults the pristine file *before* overwriting it, so
 *  the bytes behind a given id never change. */
export function loadOriginal(dir: string, id: string): Promise<ImageBitmap> {
  let bmp = originals.get(id);
  if (!bmp) {
    bmp = (async () => {
      const path = (await exists(await vaultPath(dir, id)))
        ? await vaultPath(dir, id)
        : await tilePath(dir, id);
      return createImageBitmap(new Blob([await readFile(path)], { type: "image/bmp" }));
    })();
    originals.set(id, bmp);
  }
  return bmp;
}

const urls = new Map<string, Promise<string>>();

/** For showing an asset in an image element, e.g. while placing the mosaic. */
export function assetUrl(dir: string, name: string): Promise<string> {
  let url = urls.get(name);
  if (!url) {
    url = (async () => URL.createObjectURL(await assetBlob(dir, name)))();
    urls.set(name, url);
  }
  return url;
}

/** The live app's pixel sources, in the shape scene.ts asks for. */
export const tauriDeps = (dir: string): SceneDeps => ({
  original: (id) => loadOriginal(dir, id),
  asset: (name) => assetUrl(dir, name),
});

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

/* A snapshot is a copy of the manifest, nothing more. A look is fully described
 * by it plus the content-hashed assets, which are never deleted — storing
 * rendered images would cost megabytes per look and lose editability. */
const snapshotDir = async (dir: string) => join(await projectDir(dir), "snapshots");

const snapshotFile = async (dir: string, name: string) =>
  join(await snapshotDir(dir), `${name.replace(/[^\w \-.]/g, "_")}.json`);

export async function listSnapshots(dir: string): Promise<string[]> {
  try {
    return (await readDir(await snapshotDir(dir)))
      .filter((e) => e.isFile && e.name.endsWith(".json"))
      .map((e) => e.name.replace(/\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}

export async function writeSnapshot(dir: string, name: string, m: Manifest) {
  await mkdir(await snapshotDir(dir), { recursive: true });
  await writeTextFile(await snapshotFile(dir, name), JSON.stringify(m, null, 2));
}

export async function readSnapshot(dir: string, name: string): Promise<Manifest> {
  return migrate(JSON.parse(await readTextFile(await snapshotFile(dir, name))));
}

export async function deleteSnapshot(dir: string, name: string) {
  await remove(await snapshotFile(dir, name));
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

/** Drops vault copies whose id is no longer in the game folder.
 *
 *  The vault is not a snapshot: each file is copied in the instant before
 *  Tessera first overwrites it, so a new character vaults itself. What it
 *  cannot see on its own is an id being *reused* — a character deleted and a
 *  new one taking the same number — where the stale copy would then be served
 *  as that tile's "original" forever. Same for the reset route: delete the folder,
 *  let the game regenerate, and the regenerated files are the new originals.
 *  Running this on open keeps the vault honest for one readDir per session. */
export async function pruneVault(dir: string, ids: string[]) {
  const keep = new Set(ids);
  for (const id of await vaultedIds(dir)) {
    if (!keep.has(id)) await remove(await vaultPath(dir, id));
  }
}
