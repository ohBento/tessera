import { invoke } from "@tauri-apps/api/core";
import { readFile, rename, writeFile } from "@tauri-apps/plugin-fs";
import {
  effectiveTile,
  emptyManifest,
  emptyTile,
  newImageLayer,
  newTextLayer,
  type Effective,
  type Layer,
  type Manifest,
} from "./model";
import {
  defaultDir,
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
  type Applied,
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
  /** tile currently open in the editor, "" for none */
  editing: "",
  selectedLayer: "",
  fonts: [] as string[],
  busy: "",
  error: "",
});

/** What the game folder currently holds, so "dirty" means "differs from disk". */
let saved: Applied = {};
const past: Manifest[] = [];
const future: Manifest[] = [];

const snap = () => structuredClone($state.snapshot(app.manifest)) as Manifest;
export const effective = (id: string): Effective => effectiveTile(app.manifest, id);
export const visible = () => app.manifest.order.filter((id) => !app.manifest.hidden.includes(id));

export const dirty = () =>
  visible().filter((id) => JSON.stringify(effective(id)) !== JSON.stringify(saved[id] ?? null));
export const canUndo = () => past.length > 0;
export const canRedo = () => future.length > 0;

/** Undo is a stack of whole manifests. It holds no pixels, so a snapshot is a
 *  few tens of kB — cheaper and far harder to get wrong than inverse commands. */
function checkpoint() {
  past.push(snap());
  if (past.length > 200) past.shift();
  future.length = 0;
}

async function refresh(id: string) {
  const eff = effective(id);
  URL.revokeObjectURL(app.preview[id] ?? "");
  if (eff.base || eff.layers.length) {
    app.preview[id] = await previewUrl(app.dir, id, eff, PREVIEW_W);
    return;
  }
  // Untouched: show the true original, which lives in the vault once the game
  // file has been overwritten.
  const path = app.vaulted.includes(id) ? await vaultPath(app.dir, id) : await tilePath(app.dir, id);
  app.preview[id] = URL.createObjectURL(new Blob([await readFile(path)], { type: "image/bmp" }));
}

const refreshAll = async () => {
  for (const id of app.manifest.order) await refresh(id);
};

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

async function commit(touched?: string[]) {
  if (touched) for (const id of touched) await refresh(id);
  else await refreshAll();
  await saveManifest(app.dir, $state.snapshot(app.manifest));
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
    app.editing = "";
    if (!app.fonts.length) app.fonts = await invoke<string[]>("system_fonts");
    await refreshAll();
  });
}

export async function replaceTile(id: string, sourcePath: string) {
  await run("replace", async () => {
    checkpoint();
    const asset = await importAsset(app.dir, sourcePath);
    app.manifest.tiles[id].base = { asset, crop: tileCover(await loadAsset(app.dir, asset)) };
    await commit([id]);
  });
}

export async function fillMosaic(sourcePath: string) {
  await run("mosaic", async () => {
    checkpoint();
    const asset = await importAsset(app.dir, sourcePath);
    const img = await loadAsset(app.dir, asset);
    const ids = visible();
    const crops = mosaicCrops(img.width, img.height, ids.length);
    ids.forEach((id, i) => (app.manifest.tiles[id].base = { asset, crop: crops[i] }));
    await commit(ids);
  });
}

export async function resetTile(id: string) {
  await run("reset", async () => {
    checkpoint();
    app.manifest.tiles[id] = emptyTile();
    await commit([id]);
  });
}

/** Swaps two tiles rather than moving one and shifting the rest. The user is
 *  reproducing a fixed order the game dictates, so a move that shifts a whole
 *  range would undo positions that were already correct. */
export async function swapTiles(from: number, to: number) {
  if (from === to || from < 0) return;
  checkpoint();
  const order = app.manifest.order;
  [order[from], order[to]] = [order[to], order[from]];
  await saveManifest(app.dir, $state.snapshot(app.manifest));
}

export async function toggleHidden(id: string) {
  checkpoint();
  const hidden = app.manifest.hidden;
  const at = hidden.indexOf(id);
  if (at >= 0) hidden.splice(at, 1);
  else hidden.push(id);
  await saveManifest(app.dir, $state.snapshot(app.manifest));
}

/* ---- layers ---- */

const tileOf = (id: string) => (app.manifest.tiles[id] ??= emptyTile());

export async function addImageLayer(sourcePath: string, shared: boolean) {
  await run("layer", async () => {
    checkpoint();
    const asset = await importAsset(app.dir, sourcePath);
    const layer = newImageLayer(asset);
    if (shared) app.manifest.shared.push(layer);
    else tileOf(app.editing).layers.push(layer);
    app.selectedLayer = layer.id;
    await commit(shared ? undefined : [app.editing]);
  });
}

export async function addTextLayer(shared: boolean) {
  checkpoint();
  const layer = newTextLayer();
  if (shared) app.manifest.shared.push(layer);
  else tileOf(app.editing).layers.push(layer);
  app.selectedLayer = layer.id;
  await commit(shared ? undefined : [app.editing]);
}

/** Finds the object to edit: the detached copy on this tile if there is one,
 *  otherwise the shared original — editing that hits every tile. */
export function editable(tileId: string, layerId: string): Layer | undefined {
  return (
    app.manifest.tiles[tileId]?.layers.find((l) => l.id === layerId) ??
    app.manifest.shared.find((s) => s.id === layerId)
  );
}

const isShared = (layerId: string) => app.manifest.shared.some((s) => s.id === layerId);

/** Live edits skip the undo stack per keystroke; call `checkpointEdit` once when
 *  a drag or a field session starts. */
export const checkpointEdit = checkpoint;

export async function afterEdit(tileId: string, layerId: string) {
  await commit(isShared(layerId) && !app.manifest.tiles[tileId]?.layers.some((l) => l.id === layerId)
    ? undefined
    : [tileId]);
}

export async function detachLayer(tileId: string, layerId: string) {
  const shared = app.manifest.shared.find((s) => s.id === layerId);
  if (!shared) return;
  checkpoint();
  tileOf(tileId).layers.push(structuredClone($state.snapshot(shared)) as Layer);
  await commit([tileId]);
}

export async function reattachLayer(tileId: string, layerId: string) {
  checkpoint();
  const layers = tileOf(tileId).layers;
  const at = layers.findIndex((l) => l.id === layerId);
  if (at >= 0) layers.splice(at, 1);
  await commit([tileId]);
}

export async function deleteLayer(tileId: string, layerId: string) {
  checkpoint();
  const shared = app.manifest.shared.findIndex((s) => s.id === layerId);
  if (shared >= 0) app.manifest.shared.splice(shared, 1);
  const layers = tileOf(tileId).layers;
  const at = layers.findIndex((l) => l.id === layerId);
  if (at >= 0) layers.splice(at, 1);
  if (app.selectedLayer === layerId) app.selectedLayer = "";
  await commit(shared >= 0 ? undefined : [tileId]);
}

export async function setTileText(tileId: string, layerId: string, text: string) {
  tileOf(tileId).text[layerId] = text;
  await commit([tileId]);
}

/* ---- writing ---- */

/** Only changed tiles are written, each via .tmp + rename so an interrupted
 *  save cannot leave a half-written BMP in the game folder. Hidden tiles are
 *  never touched. */
export async function saveToGame() {
  await run("save", async () => {
    for (const id of dirty()) {
      const eff = effective(id);
      await vaultOriginal(app.dir, id);
      if (!app.vaulted.includes(id)) app.vaulted.push(id);
      if (eff.base || eff.layers.length) {
        const path = await tilePath(app.dir, id);
        await writeFile(`${path}.tmp`, await exportBmp(app.dir, id, eff));
        await rename(`${path}.tmp`, path);
      } else {
        await restoreFromVault(app.dir, id);
      }
      saved[id] = structuredClone(eff);
    }
    await saveApplied(app.dir, saved);
  });
}

export async function restoreAll() {
  await run("restore", async () => {
    checkpoint();
    for (const id of app.vaulted) await restoreFromVault(app.dir, id);
    app.manifest.shared = [];
    for (const id of app.manifest.order) app.manifest.tiles[id] = emptyTile();
    await commit();
    saved = {};
    await saveApplied(app.dir, saved);
  });
}

/* ---- history ---- */

async function apply(m: Manifest) {
  app.manifest = m;
  await commit();
}

export async function undo() {
  const prev = past.pop();
  if (!prev) return;
  future.push(snap());
  await apply(prev);
}

export async function redo() {
  const next = future.pop();
  if (!next) return;
  past.push(snap());
  await apply(next);
}
