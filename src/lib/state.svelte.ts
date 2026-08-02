import { readFile, rename, writeFile } from "@tauri-apps/plugin-fs";
import {
  defaultDir,
  emptyManifest,
  importAsset,
  listTiles,
  loadApplied,
  loadAsset,
  loadManifest,
  restoreFromVault,
  saveApplied,
  saveManifest,
  tilePath,
  vaultOriginal,
  vaultPath,
  vaultedIds,
  type Manifest,
} from "./project";
import { exportBmp, mosaicCrops, previewUrl, tileCover } from "./render";

export const PREVIEW_W = 120;

export const app = $state({
  dir: "",
  manifest: emptyManifest() as Manifest,
  /** id -> object URL currently shown in the grid */
  preview: {} as Record<string, string>,
  /* A plain Set is NOT reactive inside $state — Svelte ships SvelteSet for that
   * reason. An array is deeply reactive, and membership over 60 ids is free. */
  vaulted: [] as string[],
  busy: "",
  error: "",
});

/** What the game folder currently holds, so "dirty" means "differs from disk". */
let saved: Manifest["tiles"] = {};
const past: Manifest[] = [];
const future: Manifest[] = [];

export const dirty = () =>
  app.manifest.order.filter(
    (id) => JSON.stringify(app.manifest.tiles[id] ?? null) !== JSON.stringify(saved[id] ?? null),
  );
export const canUndo = () => past.length > 0;
export const canRedo = () => future.length > 0;

/** Undo is a stack of whole manifests. It holds no pixels, so a snapshot is a
 *  few tens of kB — cheaper and far harder to get wrong than inverse commands. */
function checkpoint() {
  past.push(structuredClone($state.snapshot(app.manifest)) as Manifest);
  if (past.length > 200) past.shift();
  future.length = 0;
}

async function refresh(id: string) {
  const tile = app.manifest.tiles[id];
  URL.revokeObjectURL(app.preview[id] ?? "");
  if (tile) {
    app.preview[id] = await previewUrl(app.dir, tile, PREVIEW_W);
    return;
  }
  // Without an override the tile shows the true original, which lives in the
  // vault once the game file has been overwritten.
  const path = app.vaulted.includes(id) ? await vaultPath(app.dir, id) : await tilePath(app.dir, id);
  app.preview[id] = URL.createObjectURL(new Blob([await readFile(path)], { type: "image/bmp" }));
}

async function run(label: string, fn: () => Promise<void>) {
  app.busy = label;
  app.error = "";
  try {
    await fn();
  } catch (e) {
    app.error = String(e);
  } finally {
    app.busy = "";
  }
}

export async function open(dir?: string) {
  await run("load", async () => {
    app.dir = dir ?? (await defaultDir());
    const ids = await listTiles(app.dir);
    app.manifest = await loadManifest(app.dir, ids);
    app.vaulted = await vaultedIds(app.dir);
    saved = await loadApplied(app.dir);
    past.length = 0;
    future.length = 0;
    app.preview = {};
    for (const id of app.manifest.order) await refresh(id);
  });
}

export async function replaceTile(id: string, sourcePath: string) {
  await run("replace", async () => {
    checkpoint();
    const asset = await importAsset(app.dir, sourcePath);
    app.manifest.tiles[id] = { asset, crop: tileCover(await loadAsset(app.dir, asset)) };
    await refresh(id);
    await saveManifest(app.dir, $state.snapshot(app.manifest));
  });
}

export async function fillMosaic(sourcePath: string) {
  await run("mosaic", async () => {
    checkpoint();
    const asset = await importAsset(app.dir, sourcePath);
    const img = await loadAsset(app.dir, asset);
    const crops = mosaicCrops(img.width, img.height, app.manifest.order.length);
    app.manifest.order.forEach((id, i) => (app.manifest.tiles[id] = { asset, crop: crops[i] }));
    for (const id of app.manifest.order) await refresh(id);
    await saveManifest(app.dir, $state.snapshot(app.manifest));
  });
}

export async function resetTile(id: string) {
  await run("reset", async () => {
    checkpoint();
    delete app.manifest.tiles[id];
    await refresh(id);
    await saveManifest(app.dir, $state.snapshot(app.manifest));
  });
}

export async function reorder(from: number, to: number) {
  if (from === to) return;
  checkpoint();
  const [id] = app.manifest.order.splice(from, 1);
  app.manifest.order.splice(to, 0, id);
  await saveManifest(app.dir, $state.snapshot(app.manifest));
}

/** Only changed tiles are written, each via .tmp + rename so an interrupted
 *  save cannot leave a half-written BMP in the game folder. */
export async function saveToGame() {
  await run("save", async () => {
    for (const id of dirty()) {
      const tile = app.manifest.tiles[id];
      await vaultOriginal(app.dir, id);
      if (!app.vaulted.includes(id)) app.vaulted.push(id);
      if (tile) {
        const path = await tilePath(app.dir, id);
        await writeFile(`${path}.tmp`, await exportBmp(app.dir, tile));
        await rename(`${path}.tmp`, path);
      } else {
        await restoreFromVault(app.dir, id);
      }
    }
    saved = structuredClone($state.snapshot(app.manifest.tiles));
    await saveApplied(app.dir, saved);
  });
}

export async function restoreAll() {
  await run("restore", async () => {
    checkpoint();
    for (const id of app.vaulted) await restoreFromVault(app.dir, id);
    app.manifest.tiles = {};
    for (const id of app.manifest.order) await refresh(id);
    await saveManifest(app.dir, $state.snapshot(app.manifest));
    saved = {};
    await saveApplied(app.dir, saved);
  });
}

async function apply(m: Manifest) {
  app.manifest = m;
  for (const id of app.manifest.order) await refresh(id);
  await saveManifest(app.dir, $state.snapshot(app.manifest));
}

export async function undo() {
  const prev = past.pop();
  if (!prev) return;
  future.push(structuredClone($state.snapshot(app.manifest)) as Manifest);
  await apply(prev);
}

export async function redo() {
  const next = future.pop();
  if (!next) return;
  past.push(structuredClone($state.snapshot(app.manifest)) as Manifest);
  await apply(next);
}
