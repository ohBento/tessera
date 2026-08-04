/* Editor state: opens a folder, holds a manifest, writes it back. */
import { open as pickFile } from "@tauri-apps/plugin-dialog";

import { saveTiles } from "./export";
import { canRedo, canUndo, checkpoint, emptyHistory, redo, undo } from "./history";
import {
  emptyManifest,
  findLayer,
  instanceCount,
  newImageLayer,
  newOverlay,
  overlayCovering,
  overlayOf,
  removeLayerFrom,
  setAssigned,
  visibleTiles,
  type Layer,
  type Manifest,
  type Overlay,
} from "./model";
import { defaultDir, importAsset, listTiles, loadManifest, saveManifest, tauriDeps } from "./project";
import type { SceneDeps, Tagged } from "./scene";

export const app = $state({
  dir: "",
  manifest: emptyManifest() as Manifest,
  deps: null as SceneDeps | null,
  busy: "",
  error: "",
  /* Bumped only by changes that alter *which* objects exist. A drag moves an
   * object Fabric is already showing, so rebuilding the scene for it would
   * throw away the live canvas to redraw what is already correct — that is the
   * loop the old editor guarded against with a JSON.stringify comparison on
   * every reactive pass. Structural changes bump; transforms do not. */
  version: 0,
  /** Layer picked in the list or on the canvas, "" for none. */
  selected: "",
  /** Tiles picked on the canvas. What a new overlay gets assigned to. */
  selectedTiles: [] as string[],
  /* What a click on the canvas means. A grid-space picture covers the whole
   * wall, so in layer mode every click lands on it and the tiles underneath are
   * unreachable — hence a mode rather than a cleverer hit test. */
  mode: "layers" as "layers" | "tiles",
});

/* Both selections deliberately survive a mode switch: assigning tiles to a
 * layer means picking the layer in one mode and the tiles in the other. */
export const setMode = (mode: typeof app.mode) => (app.mode = mode);

export function toggleTile(id: string, additive: boolean) {
  const current = app.selectedTiles;
  if (additive) {
    app.selectedTiles = current.includes(id) ? current.filter((t) => t !== id) : [...current, id];
    return;
  }
  // A plain click on the only selected tile clears, so there is a way out
  // without hunting for empty canvas.
  app.selectedTiles = current.length === 1 && current[0] === id ? [] : [id];
}

export const clearTiles = () => (app.selectedTiles = []);

/** The tiles the selected layer lands on, when that is less than everything.
 *
 *  An overlay covering the whole wall reports nothing: the mark exists to show
 *  which subset a layer reaches, and outlining every single cell says nothing
 *  while drowning out the plain tile guides. Take one tile away and the overlay
 *  pins to a list, at which point the mark appears and is worth reading. The
 *  layer list already names the overlay for the "all" case. */
export function assignedTiles(): string[] {
  if (!app.selected) return [];
  const overlay = overlayOf(app.manifest, app.selected);
  if (!overlay || overlay.tiles === "all") return [];
  return overlay.tiles;
}

/** Adds the picked tiles to the selected layer's overlay, or takes them out. */
export async function assignSelection(on: boolean) {
  const overlay = app.selected ? overlayOf(app.manifest, app.selected) : undefined;
  if (!overlay || !app.selectedTiles.length) return;
  // order, not visibleIds: a hidden tile still belongs to the project, and
  // dropping it here would quietly unassign it the moment it is hidden.
  await mutate(() => setAssigned(overlay, app.manifest.order, [...app.selectedTiles], on));
}

/* Reactive so the toolbar can grey the buttons out. */
const history = $state(emptyHistory<Manifest>());
export const undoable = () => canUndo(history);
export const redoable = () => canRedo(history);

/** Svelte's proxies do not survive the structured clone that Tauri's IPC and
 *  JSON.stringify perform on them the way a plain object does. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Every edit goes through here: record the state being replaced, change it,
 *  save. The snapshot is a deep copy on purpose — handing history the live
 *  manifest would let the next edit rewrite the recorded step in place, and
 *  undo would restore the present.
 *
 *  `structural` is false for a drag: the canvas already shows the result, so
 *  bumping the version would tear the scene down to redraw what is correct. */
async function mutate(fn: () => void, structural = true) {
  checkpoint(history, plain(app.manifest));
  fn();
  if (structural) app.version++;
  await persist();
}

const layerExists = (id: string) =>
  !!id &&
  (!!overlayOf(app.manifest, id) ||
    Object.values(app.manifest.tiles).some((t) => !!findLayer(t.layers, id)));

/** Undo and redo replace the whole manifest, so the scene always rebuilds.
 *
 *  The chosen layer is kept when the state landed in still has it. Dropping it
 *  unconditionally looked harmless but was not: assigning tiles needs a chosen
 *  layer to find the overlay through, so one undo left the assign action doing
 *  nothing at all, silently. */
async function travel(step: typeof undo<Manifest>) {
  const there = step(history, plain(app.manifest));
  if (!there) return;
  const chosen = app.selected;
  app.manifest = there;
  app.selected = layerExists(chosen) ? chosen : "";
  app.version++;
  await persist();
}

export const undoEdit = () => travel(undo);
export const redoEdit = () => travel(redo);

/** Every overlay layer paired with the overlay it came from — what the layer
 *  list renders. Tile-local layers are not in here; nothing creates them yet. */
export const layerRows = () =>
  app.manifest.overlays.flatMap((o) => o.layers.map((layer) => ({ overlay: o, layer })));

/** The project-wide overlay, created on first use. A grid-space layer covers
 *  the whole wall, so it only belongs somewhere that covers the whole wall. */
function allTiles(): Overlay {
  const existing = app.manifest.overlays.find((o) => o.tiles === "all");
  if (existing) return existing;
  app.manifest.overlays.push(newOverlay("Alle Kacheln"));
  // Read it back out rather than using the value pushed: Svelte hands back a
  // proxy, and mutating the raw object would not be reactive.
  return app.manifest.overlays[app.manifest.overlays.length - 1];
}

/** The array a layer lives in, whichever overlay owns it. */
const listOf = (id: string) => overlayOf(app.manifest, id)?.layers;

export function selectLayer(id: string) {
  if (app.selected !== id) app.selected = id;
}

export async function toggleLayerHidden(id: string) {
  const l = findLayer(listOf(id) ?? [], id);
  if (!l) return;
  await mutate(() => (l.hidden = !l.hidden));
}

export async function deleteLayer(id: string) {
  await mutate(() => {
    removeLayerFrom(listOf(id), id);
    if (app.selected === id) app.selected = "";
  });
}

/** `up` means visually on top, which is the end of the draw order — the list is
 *  shown topmost-first, so the two run in opposite directions. Movement stays
 *  inside the layer's own overlay; moving between overlays is reassignment, not
 *  reordering, and gets its own action. */
export async function moveLayer(id: string, up: boolean) {
  const list = listOf(id);
  if (!list) return;
  const at = list.findIndex((l) => l.id === id);
  const to = at + (up ? 1 : -1);
  if (at < 0 || to < 0 || to >= list.length) return;
  await mutate(() => ([list[at], list[to]] = [list[to], list[at]]));
}

export const visibleIds = () => visibleTiles(app.manifest);

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

/** Every manifest write goes through here, which makes it the one place a
 *  failed write has to be reported. applyTransform is called from a canvas
 *  event handler with no await behind it, so a rejection raised further down
 *  would be an unhandled promise rejection: the model would hold changes that
 *  never reached disk, with nothing on screen saying so. */
export async function persist(): Promise<boolean> {
  try {
    await saveManifest(app.dir, plain(app.manifest));
    return true;
  } catch (e) {
    app.error = `Speichern fehlgeschlagen: ${e}`;
    return false;
  }
}

export async function openFolder(dir?: string) {
  await run("load", async () => {
    app.dir = dir ?? (await defaultDir());
    app.manifest = await loadManifest(app.dir, await listTiles(app.dir));
    app.deps = tauriDeps(app.dir);
    app.selected = "";
    // Undo must not reach back into the folder that was open before.
    history.past.length = 0;
    history.future.length = 0;
    app.version++;
  });
}

export async function pickFolder() {
  const dir = await pickFile({ directory: true, defaultPath: await defaultDir() });
  if (typeof dir === "string") await openFolder(dir);
}

const IMAGE_FILTER = { name: "Bilder", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] };

/** The overlay covering exactly these tiles, reusing one if it already exists —
 *  otherwise picking the same five tiles twice would leave two overlays that
 *  have to be kept in step by hand. */
function overlayFor(ids: string[]): Overlay {
  const existing = overlayCovering(app.manifest.overlays, ids);
  if (existing) return existing;
  app.manifest.overlays.push(newOverlay(`${ids.length} Kacheln`, [...ids]));
  // Read it back out rather than using the value pushed: Svelte hands back a
  // proxy, and mutating the raw object would not be reactive.
  return app.manifest.overlays[app.manifest.overlays.length - 1];
}

/** Adds a picture to every selected tile as one shared layer: editing it later
 *  changes all of them at once, which is the whole reason overlays exist. */
export async function addImageToSelection() {
  if (!app.selectedTiles.length) return;
  const path = await pickFile({ filters: [IMAGE_FILTER] });
  if (typeof path !== "string") return;
  await run("import", async () => {
    const asset = await importAsset(app.dir, path);
    await mutate(() => {
      const overlay = overlayFor(app.selectedTiles);
      const layer = newImageLayer(asset);
      overlay.layers.push(layer);
      app.selected = layer.id;
    });
  });
}

/** Adds a picture spanning the whole wall — what used to be "the mosaic", now
 *  an ordinary layer that happens to live in grid space. */
export async function addGridImage() {
  const path = await pickFile({ filters: [IMAGE_FILTER] });
  if (typeof path !== "string") return;
  await run("import", async () => {
    // The copy into assets/ happens before the checkpoint: it touches the disk,
    // not the document, so undo has nothing to take back there.
    const asset = await importAsset(app.dir, path);
    await mutate(() => {
      const layer = newImageLayer(asset);
      layer.space = "grid";
      layer.scale = 1;
      allTiles().layers.push(layer);
    });
  });
}

/** Writes a finished drag/scale/rotate back into the model.
 *
 *  A single-instance layer skips the rebuild: Fabric has already moved the very
 *  object being dragged, so tearing the scene down would redraw what is already
 *  correct. A shared layer must rebuild, because Fabric moved one copy and the
 *  others are still sitting at the old position — the model says one thing and
 *  the canvas shows another until something redraws them. */
export async function applyTransform(obj: Tagged, patch: Pick<Layer, "x" | "y" | "rotation"> & { scale: number }) {
  const list = listOf(obj.layerId) ?? app.manifest.tiles[obj.tileId]?.layers ?? [];
  const layer = findLayer(list, obj.layerId);
  if (!layer) return;
  const shared = instanceCount(app.manifest, obj.layerId, obj.space) > 1;
  await mutate(() => {
    layer.x = patch.x;
    layer.y = patch.y;
    layer.rotation = patch.rotation;
    if (layer.kind === "image") layer.scale = patch.scale;
  }, shared);
}

export async function saveToGame() {
  await run("save", async () => {
    if (!app.deps) throw new Error("kein Ordner geöffnet");
    const n = await saveTiles(app.dir, plain(app.manifest), app.deps);
    app.error = `${n} Kacheln geschrieben`;
  });
}
