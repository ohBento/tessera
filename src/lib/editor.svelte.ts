/* Editor state: opens a folder, holds a manifest, writes it back. */
import { open as pickFile } from "@tauri-apps/plugin-dialog";

import { saveTiles } from "./export";
import {
  emptyManifest,
  findLayer,
  newImageLayer,
  newOverlay,
  overlayOf,
  removeLayerFrom,
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
});

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
  l.hidden = !l.hidden;
  app.version++;
  await persist();
}

export async function deleteLayer(id: string) {
  removeLayerFrom(listOf(id), id);
  if (app.selected === id) app.selected = "";
  app.version++;
  await persist();
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
  [list[at], list[to]] = [list[to], list[at]];
  app.version++;
  await persist();
}

export const visibleIds = () => app.manifest.order.filter((id) => !app.manifest.hidden.includes(id));

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

/** Svelte's proxies do not survive the structured clone that Tauri's IPC and
 *  JSON.stringify perform on them the way a plain object does. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));

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
    app.version++;
  });
}

export async function pickFolder() {
  const dir = await pickFile({ directory: true, defaultPath: await defaultDir() });
  if (typeof dir === "string") await openFolder(dir);
}

/** Adds a picture spanning the whole wall — what used to be "the mosaic", now
 *  an ordinary layer that happens to live in grid space. */
export async function addGridImage() {
  const path = await pickFile({
    filters: [{ name: "Bilder", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
  });
  if (typeof path !== "string") return;
  await run("import", async () => {
    const layer = newImageLayer(await importAsset(app.dir, path));
    layer.space = "grid";
    layer.scale = 1;
    allTiles().layers.push(layer);
    app.version++;
    await persist();
  });
}

/** Writes a finished drag/scale/rotate back into the model. Deliberately does
 *  not bump `version`: the canvas already shows this, and rebuilding would
 *  fight the interaction that produced it. */
export async function applyTransform(obj: Tagged, patch: Pick<Layer, "x" | "y" | "rotation"> & { scale: number }) {
  const list = listOf(obj.layerId) ?? app.manifest.tiles[obj.tileId]?.layers ?? [];
  const layer = findLayer(list, obj.layerId);
  if (!layer) return;
  layer.x = patch.x;
  layer.y = patch.y;
  layer.rotation = patch.rotation;
  if (layer.kind === "image") layer.scale = patch.scale;
  await persist();
}

export async function saveToGame() {
  await run("save", async () => {
    if (!app.deps) throw new Error("kein Ordner geöffnet");
    const n = await saveTiles(app.dir, plain(app.manifest), app.deps);
    app.error = `${n} Kacheln geschrieben`;
  });
}
