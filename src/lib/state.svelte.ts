import { invoke } from "@tauri-apps/api/core";
import { TILE_W } from "./bmp";
import { readFile, rename, writeFile } from "@tauri-apps/plugin-fs";
import {
  effectiveTile,
  emptyManifest,
  emptyTile,
  newImageLayer,
  newTextLayer,
  type Crop,
  type Effective,
  type Layer,
  type Manifest,
} from "./model";
import { join } from "@tauri-apps/api/path";
import {
  assetUrl,
  defaultDir,
  deleteSnapshot,
  importAsset,
  listSnapshots,
  listTiles,
  loadApplied,
  loadAsset,
  loadManifest,
  readSnapshot,
  restoreFromVault,
  saveApplied,
  saveManifest,
  tilePath,
  vaultOriginal,
  vaultPath,
  vaultedIds,
  writeSnapshot,
  type Applied,
} from "./project";
import { defaultMosaicRect, exportBmp, previewUrl, splitRect, tileCover } from "./render";
import { latestRelease } from "./update";

/** Previews must be rendered at least as wide as they are shown or the browser
 *  upscales them and everything looks soft. The grid is freely resizable, so
 *  this follows the real cell width instead of guessing. */
const PREVIEW_STEP = 120;
const previewFor = (cellCssWidth: number) =>
  Math.min(
    TILE_W,
    Math.max(
      PREVIEW_STEP,
      Math.ceil((cellCssWidth * (window.devicePixelRatio || 1)) / PREVIEW_STEP) * PREVIEW_STEP,
    ),
  );

export const app = $state({
  dir: "",
  manifest: emptyManifest() as Manifest,
  /** id -> object URL currently shown in the grid */
  preview: {} as Record<string, string>,
  /* A plain Set is NOT reactive inside $state — Svelte ships SvelteSet for that
   * reason. An array is deeply reactive, and membership over 60 ids is free. */
  vaulted: [] as string[],
  /** mosaic being placed over the grid, null when the view is closed */
  placing: null as null | { asset: string; url: string; w: number; h: number; rect: Crop },
  /** tile currently open in the editor, "" for none */
  editing: "",
  selectedLayer: "",
  fonts: [] as string[],
  snapshots: [] as string[],
  /** newer release tag once the update check has found one */
  update: "",
  previewW: 240,
  busy: "",
  error: "",
});

/** Raises the preview resolution when the grid grows. It never lowers it —
 *  shrinking would re-render all 60 tiles for no visible gain. */
export async function ensurePreviewWidth(cellCssWidth: number) {
  const want = previewFor(cellCssWidth);
  if (!(want > app.previewW) || !app.dir) return;
  app.previewW = want;
  await run("load", refreshAll);
}

/** What the game folder currently holds, so "dirty" means "differs from disk". */
let saved: Applied = {};
const past: Manifest[] = [];
const future: Manifest[] = [];

/** Reactive state is a deep Proxy, and structuredClone refuses to clone those —
 *  that is exactly what $state.snapshot is for. Every copy taken out of state
 *  goes through here so a raw structuredClone can never creep back in. */
const plain = <T>(value: T): T => $state.snapshot(value) as T;

const snap = () => plain(app.manifest);
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
    app.preview[id] = await previewUrl(app.dir, id, eff, app.previewW);
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
  await saveManifest(app.dir, plain(app.manifest));
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
    await refreshSnapshots();
    // Deliberately not awaited: a slow or absent network must not delay the grid.
    void latestRelease().then((tag) => (app.update = tag));
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

/** Opens the placement view. Nothing is applied until the user confirms. */
export async function startMosaic(sourcePath?: string) {
  await run("mosaic", async () => {
    const stored = app.manifest.mosaic;
    const asset = sourcePath ? await importAsset(app.dir, sourcePath) : stored?.asset;
    if (!asset) return;
    const img = await loadAsset(app.dir, asset);
    app.placing = {
      asset,
      url: await assetUrl(app.dir, asset),
      w: img.width,
      h: img.height,
      rect:
        !sourcePath && stored?.asset === asset
          ? plain(stored.rect)
          : defaultMosaicRect(img.width, img.height, visible().length),
    };
  });
}

export async function applyMosaic() {
  const placing = app.placing;
  if (!placing) return;
  await run("mosaic", async () => {
    checkpoint();
    const ids = visible();
    const crops = splitRect(plain(placing.rect), ids.length);
    ids.forEach((id, i) => (app.manifest.tiles[id].base = { asset: placing.asset, crop: crops[i] }));
    app.manifest.mosaic = { asset: placing.asset, rect: plain(placing.rect) };
    app.placing = null;
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
  await saveManifest(app.dir, plain(app.manifest));
}

export async function toggleHidden(id: string) {
  checkpoint();
  const hidden = app.manifest.hidden;
  const at = hidden.indexOf(id);
  if (at >= 0) hidden.splice(at, 1);
  else hidden.push(id);
  await saveManifest(app.dir, plain(app.manifest));
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

/** The list a layer actually lives in — shared layers move among shared ones,
 *  tile-local layers among their own. Moving across scopes is what detach and
 *  reattach are for. */
function ownerList(tileId: string, layerId: string) {
  const shared = app.manifest.shared;
  if (shared.some((l) => l.id === layerId)) return { list: shared, shared: true };
  return { list: tileOf(tileId).layers, shared: false };
}

export async function moveLayer(tileId: string, layerId: string, delta: number) {
  const { list, shared } = ownerList(tileId, layerId);
  const at = list.findIndex((l) => l.id === layerId);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= list.length) return;
  checkpoint();
  [list[at], list[to]] = [list[to], list[at]];
  await commit(shared ? undefined : [tileId]);
}

/** Swaps the picture of an image layer but keeps position, size and effects,
 *  so a logo can be replaced without placing it again. */
export async function swapLayerImage(tileId: string, layerId: string, sourcePath: string) {
  await run("layer", async () => {
    checkpoint();
    const asset = await importAsset(app.dir, sourcePath);
    const layer = editable(tileId, layerId);
    if (layer?.kind === "image") layer.asset = asset;
    await afterEdit(tileId, layerId);
  });
}

export async function detachLayer(tileId: string, layerId: string) {
  const shared = app.manifest.shared.find((s) => s.id === layerId);
  if (!shared) return;
  checkpoint();
  tileOf(tileId).layers.push(plain(shared));
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

/** Live while typing: updates the preview but does not touch disk. The manifest
 *  is written once on change, not once per keystroke. */
export async function setTileText(tileId: string, layerId: string, text: string) {
  tileOf(tileId).text[layerId] = text;
  await refresh(tileId);
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
      saved[id] = plain(eff);
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

/* ---- snapshots ---- */

export async function refreshSnapshots() {
  app.snapshots = await listSnapshots(app.dir);
}

export async function saveSnapshot(name: string) {
  await run("snapshot", async () => {
    await writeSnapshot(app.dir, name, plain(app.manifest));
    await refreshSnapshots();
  });
}

/** Loading a look only changes the project; nothing reaches the game folder
 *  until it is saved, and undo still gets you back. */
export async function loadSnapshot(name: string) {
  await run("snapshot", async () => {
    checkpoint();
    app.manifest = await readSnapshot(app.dir, name);
    await commit();
  });
}

export async function removeSnapshot(name: string) {
  await run("snapshot", async () => {
    await deleteSnapshot(app.dir, name);
    await refreshSnapshots();
  });
}

/* ---- export elsewhere ---- */

/** Writes every visible tile into a folder of the user's choosing, leaving the
 *  game folder alone. Hidden tiles stay out, as they do everywhere. */
export async function exportTo(target: string) {
  await run("export", async () => {
    for (const id of visible()) {
      const eff = effective(id);
      if (!eff.base && !eff.layers.length) continue;
      await writeFile(await join(target, `${id}.bmp`), await exportBmp(app.dir, id, eff));
    }
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
