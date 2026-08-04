import { invoke } from "@tauri-apps/api/core";
import { TILE_W } from "./bmp";
import { readFile, rename, writeFile } from "@tauri-apps/plugin-fs";
import {
  effectiveTile,
  emptyManifest,
  emptyTile,
  findLayer,
  findList,
  groupShift,
  nestingShift,
  newGroupLayer,
  shiftLayer,
  newImageLayer,
  newShapeLayer,
  newTextLayer,
  removeLayerFrom,
  walkLayers,
  type Crop,
  type Effective,
  type Layer,
  type Manifest,
  type ShapeKind,
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
  /** ctrl-clicked tiles a bulk "add to tile" targets instead of just `editing`.
   *  Empty (or a single id) means "just the open tile" — nothing new to learn
   *  for the common case of editing one tile at a time. */
  selectedTiles: [] as string[],
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
// $state (not plain arrays) so canUndo()/canRedo() — read directly in markup,
// not through a $derived — actually re-evaluate when a checkpoint is pushed.
const past: Manifest[] = $state([]);
const future: Manifest[] = $state([]);

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

/** The true original, which lives in the vault once the game file has been
 *  overwritten, and is still the live game file otherwise. */
const originalPath = (id: string) =>
  app.vaulted.includes(id) ? vaultPath(app.dir, id) : tilePath(app.dir, id);

async function refresh(id: string) {
  const eff = effective(id);
  URL.revokeObjectURL(app.preview[id] ?? "");
  if (eff.base || eff.layers.length) {
    app.preview[id] = await previewUrl(app.dir, id, eff, app.previewW);
    return;
  }
  // Untouched, no layers: show the true original directly, no canvas needed.
  app.preview[id] = URL.createObjectURL(new Blob([await readFile(await originalPath(id))], { type: "image/bmp" }));
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

/** Which tiles a non-shared "add" targets: every ctrl-clicked tile once two or
 *  more are picked, otherwise just the one open in the editor. */
export function toggleTileSelect(id: string) {
  // Starting a multi-select while a tile is already open in the editor pulls
  // that tile in too — it was "selected" in every sense but the array.
  if (!app.selectedTiles.length && app.editing && app.editing !== id) app.selectedTiles.push(app.editing);
  const at = app.selectedTiles.indexOf(id);
  if (at >= 0) app.selectedTiles.splice(at, 1);
  else app.selectedTiles.push(id);
}

const targetTiles = () => (app.selectedTiles.length > 1 ? app.selectedTiles : [app.editing]);

/** Pushes one fresh layer per target tile — never the same object into two
 *  tiles, or dragging one would drag them all. */
function addToTiles(make: () => Layer) {
  const tiles = targetTiles();
  let lastId = "";
  for (const tid of tiles) {
    const layer = make();
    tileOf(tid).layers.push(layer);
    lastId = layer.id;
  }
  app.selectedLayer = lastId;
  return tiles;
}

export async function addImageLayer(sourcePath: string, shared: boolean) {
  await run("layer", async () => {
    checkpoint();
    const asset = await importAsset(app.dir, sourcePath);
    if (shared) {
      const layer = newImageLayer(asset);
      app.manifest.shared.push(layer);
      app.selectedLayer = layer.id;
      await commit();
    } else {
      await commit(addToTiles(() => newImageLayer(asset)));
    }
  });
}

export async function addTextLayer(shared: boolean) {
  checkpoint();
  if (shared) {
    const layer = newTextLayer();
    app.manifest.shared.push(layer);
    app.selectedLayer = layer.id;
    await commit();
  } else {
    await commit(addToTiles(newTextLayer));
  }
}

export async function addShapeLayer(shape: ShapeKind, shared: boolean) {
  checkpoint();
  if (shared) {
    const layer = newShapeLayer(shape);
    app.manifest.shared.push(layer);
    app.selectedLayer = layer.id;
    await commit();
  } else {
    await commit(addToTiles(() => newShapeLayer(shape)));
  }
}

/** Deleting a shape that some image is masked to just leaves that reference
 *  dangling — resolveLayers already treats an unresolvable maskId as "no
 *  mask", so nothing else needs to change here. */
export async function setMask(tileId: string, layerId: string, maskId: string) {
  const layer = editable(tileId, layerId);
  if (!layer) return;
  checkpointEdit();
  layer.maskId = maskId || undefined;
  await afterEdit(tileId, layerId);
}

/** Finds the object to edit: the detached copy on this tile if there is one,
 *  otherwise the shared original — editing that hits every tile. Searches into
 *  groups, so a nested layer is reachable by id alone. */
export function editable(tileId: string, layerId: string): Layer | undefined {
  return (
    findLayer(app.manifest.tiles[tileId]?.layers ?? [], layerId) ??
    findLayer(app.manifest.shared, layerId)
  );
}

const isShared = (layerId: string) =>
  [...walkLayers(app.manifest.shared)].some((s) => s.id === layerId);

/** Live edits skip the undo stack per keystroke; call `checkpointEdit` once when
 *  a drag or a field session starts. */
export const checkpointEdit = checkpoint;

const hasLocal = (tileId: string, layerId: string) =>
  !!findLayer(app.manifest.tiles[tileId]?.layers ?? [], layerId);

export async function afterEdit(tileId: string, layerId: string) {
  await commit(isShared(layerId) && !hasLocal(tileId, layerId) ? undefined : [tileId]);
}

/** The array a layer sits in — shared layers move among shared ones, tile-local
 *  layers among their own, and a grouped layer among its siblings inside the
 *  group. Moving across scopes is what detach and reattach are for. */
function ownerList(tileId: string, layerId: string) {
  // Tile-local first, matching editable(): when a shared layer has a detached
  // copy, editable() hands back the local object while this used to hand back
  // the shared list. indexOf then missed, and splice(-1, 1) quietly deleted
  // the last entry of the wrong list — which looked like a group vanishing.
  const local = findList(tileOf(tileId).layers, layerId);
  if (local) return { list: local, shared: false };
  const shared = findList(app.manifest.shared, layerId);
  if (shared) return { list: shared, shared: true };
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

/** Wraps the given layers in a new group, which takes the position of the
 *  topmost member so the visual stacking order does not jump. Members are
 *  pulled out of wherever they were, including out of other groups. */
export async function groupLayers(tileId: string, layerIds: string[]) {
  if (layerIds.length < 2) return;
  checkpoint();
  const { list, shared } = ownerList(tileId, layerIds[0]);
  const taken: Layer[] = [];
  let at = list.length;
  // In list order, not click order — grouping must not reshuffle the stack.
  for (const l of [...list]) {
    if (!layerIds.includes(l.id)) continue;
    at = Math.min(at, list.indexOf(l));
    taken.push(l);
  }
  const roots = shared ? app.manifest.shared : tileOf(tileId).layers;
  for (const l of taken) {
    // Folded in before the layer leaves, so a member pulled out of another
    // group keeps its place instead of jumping by that group's offset. The new
    // group sits at the neutral 0.5/0.5, so it adds nothing back.
    const nested = nestingShift(roots, l.id);
    if (nested) shiftLayer(l, nested.dx, nested.dy);
    const owner = ownerList(tileId, l.id).list;
    const at = owner.indexOf(l);
    if (at >= 0) owner.splice(at, 1); // splice(-1, 1) would drop a bystander
  }
  const group = newGroupLayer(taken);
  list.splice(Math.min(at, list.length), 0, group);
  app.selectedLayer = group.id;
  await commit(shared ? undefined : [tileId]);
}

/** Moves a layer into a group (or, with a null group, back out to the top
 *  level). Dropping a group into itself would detach the whole subtree, so it
 *  is refused. */
export async function moveIntoGroup(tileId: string, layerId: string, groupId: string | null) {
  const layer = editable(tileId, layerId);
  if (!layer || layerId === groupId) return;
  if (layer.kind === "group" && groupId && findLayer(layer.children, groupId)) return;

  const { list, shared } = ownerList(tileId, layerId);
  const target = groupId ? editable(tileId, groupId) : undefined;
  if (groupId && target?.kind !== "group") return;

  const at = list.indexOf(layer);
  // Never splice on a miss: splice(-1, 1) removes the last entry instead of
  // nothing, silently destroying an unrelated layer.
  if (at < 0) return;

  // The layer must stay put on screen. Its own x/y is absolute, so anything
  // the enclosing groups were adding has to be folded in on the way out and
  // taken back off on the way in — otherwise it jumps by the group's offset.
  const roots = shared ? app.manifest.shared : tileOf(tileId).layers;
  const before = nestingShift(roots, layerId) ?? { dx: 0, dy: 0 };
  const after = target?.kind === "group"
    ? (() => {
        const own = groupShift(target);
        const up = nestingShift(roots, target.id) ?? { dx: 0, dy: 0 };
        return { dx: own.dx + up.dx, dy: own.dy + up.dy };
      })()
    : { dx: 0, dy: 0 };

  checkpoint();
  list.splice(at, 1);
  shiftLayer(layer, before.dx - after.dx, before.dy - after.dy);
  if (target?.kind === "group") target.children.push(layer);
  else roots.push(layer);
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
  const sharedList = findList(app.manifest.shared, layerId);
  removeLayerFrom(sharedList, layerId);
  removeLayerFrom(findList(tileOf(tileId).layers, layerId), layerId);
  if (app.selectedLayer === layerId) app.selectedLayer = "";
  await commit(sharedList ? undefined : [tileId]);
}

/** Live while typing: updates the preview but does not touch disk. The manifest
 *  is written once on change, not once per keystroke.
 *
 *  An empty field is stored as an empty override, not by dropping the override:
 *  dropping it fell back to the layer's own text, so clearing the box made the
 *  default word reappear and a caption could not be emptied at all. That
 *  fallback dates from when the default was the literal "{{id}}" placeholder,
 *  which was the thing being escaped; the default is a plain word now, and
 *  "leave this tile blank" is the more useful thing to be able to express. */
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
