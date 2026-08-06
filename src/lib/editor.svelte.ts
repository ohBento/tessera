/* Editor state: opens a folder, holds a manifest, writes it back. */
import { open as pickFile } from "./platform";

import { saveTiles } from "./export";
import { mosaicBakeCrops } from "./geometry";
import { canRedo, canUndo, checkpoint, emptyHistory, redo, undo } from "./history";
import { renderLayout } from "./layout";
import {
  addToGroup,
  bakeMosaicInto,
  emptyManifest,
  findLayer,
  findList,
  freeTiles,
  groupOf,
  groupShift,
  instanceCount,
  layoutFingerprint,
  layoutNeedsRestamp,
  nestingShift,
  newGroupLayer,
  newImageLayer,
  newLayout,
  newOverlay,
  newShapeLayer,
  newTextLayer,
  overlayOf,
  overlaysUsingLayout,
  refreshStamps,
  removeFromGroup,
  removeLayerFrom,
  shiftLayer,
  stampInto,
  swapTiles,
  syncLiveLayers,
  visibleTiles,
  type ImageLayer,
  type Layer,
  type Layout,
  type Manifest,
  type Overlay,
  type ShapeKind,
  type ShapeLayer,
  type TextLayer,
} from "./model";
import {
  defaultDir,
  importAsset,
  listTiles,
  loadAsset,
  loadManifest,
  pruneVault,
  saveGeneratedAsset,
  saveManifest,
  tauriDeps,
} from "./project";
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
  /** Tiles picked on the canvas. What a new group gets built from. */
  selectedTiles: [] as string[],
  /** Group being hovered in the sidebar — its tiles get outlined on the wall,
   *  so you can see what a group holds without clicking it. */
  hoverGroup: "",
  /** Which Layout is open for editing, "" when looking at the wall instead.
   *  View state only, not persisted — a Layout's own content is. */
  openLayoutId: "",
  /** Layer picked inside the open Layout — separate from `selected`, which is
   *  the wall's own layer picker, because the two documents' layers are
   *  disjoint and switching documents must not smear one's pick onto the
   *  other. */
  layoutSelected: "",
  /** Every layer picked in the Layout's list. `layoutSelected` is the last of
   *  these — the one the canvas puts handles on — while grouping needs the
   *  whole set. */
  layoutSelection: [] as string[],
});

export function toggleTile(id: string, additive: boolean) {
  // Picking something is the user moving on; a note about the last action has
  // had its moment and is now in the way of the selection count.
  app.error = "";
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

/** Drops every pick on the wall — tiles, layer, and the group outline that
 *  follows the layer. What a click on empty canvas means. */
export function clearAll() {
  app.selectedTiles = [];
  app.selected = "";
  app.hoverGroup = "";
}

/** The tiles outlined on the wall: the hovered group's, else the selected
 *  layer's group. An "all" overlay reports nothing — outlining every cell says
 *  nothing while drowning out the plain tile guides. */
export function assignedTiles(): string[] {
  const overlay = app.hoverGroup
    ? app.manifest.overlays.find((o) => o.id === app.hoverGroup)
    : app.selected
      ? overlayOf(app.manifest, app.selected)
      : undefined;
  return !overlay || overlay.tiles === "all" ? [] : overlay.tiles;
}

/* --- Tile groups. A group owns its tiles exclusively (see groupOf in
 * model.ts), which is what lets it be a thing you point at: name it, add tiles
 * to it, drop layouts on it. --- */

/** The groups shown in the sidebar — "all" overlays are the wall axis, not
 *  groups, and hold the grid picture rather than anything tile-scoped. */
export const groups = () => app.manifest.overlays.filter((o) => o.tiles !== "all");

export const findGroup = (id: string) => app.manifest.overlays.find((o) => o.id === id);

/** How many of the picked tiles are still unclaimed — drives both buttons and
 *  the status line, so a greyed button always has a readable reason. */
export const freeCount = () => freeTiles(app.manifest, app.selectedTiles).length;

export async function newGroup() {
  const free = freeTiles(app.manifest, app.selectedTiles);
  if (!free.length) return;
  await mutate(() => {
    app.manifest.overlays.push(newOverlay(`Gruppe ${groups().length + 1}`, free));
  });
}

/** Adds the picked tiles that no other group has claimed. Reports the skipped
 *  ones rather than stealing them: moving a tile between groups silently would
 *  change a stamp the user cannot see from here. */
export async function addTilesToGroup(groupId: string) {
  const group = findGroup(groupId);
  if (!group || !freeCount()) return;
  const skipped = app.selectedTiles.length - freeCount();
  await mutate(() => addToGroup(app.manifest, group, [...app.selectedTiles]));
  // "vergeben", not "in einer anderen Gruppe": a tile already in *this* group
  // is skipped too, and naming the wrong group is worse than naming none.
  if (skipped) app.error = `${skipped} Kachel(n) übersprungen — schon vergeben`;
}

export async function removeTileFromGroup(groupId: string, tileId: string) {
  const group = findGroup(groupId);
  if (!group) return;
  await mutate(() => removeFromGroup(group, tileId));
}

/** Frees every picked tile from whichever group holds it. */
export async function releaseSelectedTiles() {
  const owned = app.selectedTiles.filter((id) => groupOf(app.manifest, id));
  if (!owned.length) return;
  await mutate(() => {
    for (const id of owned) {
      const group = groupOf(app.manifest, id);
      if (group) removeFromGroup(group, id);
    }
  });
}

export const claimedCount = () =>
  app.selectedTiles.filter((id) => groupOf(app.manifest, id)).length;

/* --- Per-tile wording. A caption a Layout keeps live is one layer drawn on
 * every tile of its group: position and style are shared, the words are
 * not. --- */

/** The live captions on the tiles currently picked, deduplicated — what the
 *  wording panel offers to edit. Empty unless exactly one tile is picked,
 *  since a field showing several tiles' differing words would have to invent
 *  an answer for what typing into it means. */
export function tileCaptions(): TextLayer[] {
  if (app.selectedTiles.length !== 1) return [];
  const group = groupOf(app.manifest, app.selectedTiles[0]);
  return (group?.layers ?? []).filter((l): l is TextLayer => l.kind === "text");
}

/** This tile's wording for a caption, or undefined when it has none of its own
 *  and shows the layer's default. */
export const tileText = (tileId: string, layerId: string): string | undefined =>
  app.manifest.tiles[tileId]?.text[layerId];

/** Sets one tile's wording.
 *
 *  An emptied field stores "" and does not delete the key. Deleting it would
 *  make layerText fall back to the layer's default, so the words the user just
 *  cleared would reappear the moment the last character went — which is
 *  exactly the bug this project has already had once. */
export async function setTileText(tileId: string, layerId: string, text: string) {
  const tile = app.manifest.tiles[tileId];
  if (!tile || tile.text[layerId] === text) return;
  await mutate(() => (tile.text[layerId] = text));
}

/** Drops the override so the tile follows the layer's default again — the only
 *  way back, precisely because clearing the field does not do this. */
export async function clearTileText(tileId: string, layerId: string) {
  const tile = app.manifest.tiles[tileId];
  if (!tile || !(layerId in tile.text)) return;
  await mutate(() => delete tile.text[layerId]);
}

export async function renameGroup(groupId: string, name: string) {
  const group = findGroup(groupId);
  if (!group || !name.trim() || group.name === name.trim()) return;
  await mutate(() => (group.name = name.trim()));
}

/** Deleting a group frees its tiles and takes its stamps with them — the
 *  layers live in the group, so there is nowhere for them to go. The caller
 *  asks first when there is something to lose. */
export async function deleteGroup(groupId: string) {
  await mutate(() => {
    const at = app.manifest.overlays.findIndex((o) => o.id === groupId);
    if (at >= 0) app.manifest.overlays.splice(at, 1);
  });
}

export async function swapTilePlaces(a: string, b: string) {
  await mutate(() => swapTiles(app.manifest, a, b));
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
  /* Cleared here rather than left to time out: the status line has one slot,
   * and a note from three actions ago ("12 Kacheln geschrieben") sat there
   * hiding the live selection count and its "aufheben" link until something
   * else happened to overwrite it. Anything a mutation wants to say sets it
   * inside fn, after this. */
  app.error = "";
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
    const ids = await listTiles(app.dir);
    // Before anything reads an original: a vault copy for an id the folder no
    // longer has is either dead weight or, if BDO reuses the number, the wrong
    // picture served as that tile's pristine state.
    await pruneVault(app.dir, ids);
    app.manifest = await loadManifest(app.dir, ids);
    app.deps = tauriDeps(app.dir);
    app.selected = "";
    // Undo must not reach back into the folder that was open before.
    history.past.length = 0;
    history.future.length = 0;
    app.version++;
  });
}

const IMAGE_FILTER = { name: "Bilder", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] };

/** The picked file's name, without folders or extension.
 *
 *  Assets are stored under their content hash, so the original name is gone by
 *  the time a layer exists — which is why layers used to be called "813b27fb".
 *  Capturing it here is the only chance. */
const baseName = (path: string) =>
  path
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.[^.]+$/, "") ?? "";

/** Why stamping the current selection cannot go ahead, or "" when it can.
 *
 *  A stamp lands on a whole group, never on a hand-picked set of tiles — that
 *  is what a group is for. So a selection only works when it *is* a group:
 *  every tile in one and the same group, or every tile still free (which makes
 *  a new one). Anything in between has no answer that is not a guess.
 *
 *  This used to guess, and the guess was silent and wrong: picking one owned
 *  tile and one free tile stamped the owned tile's *whole* group and dropped
 *  the free one, so tiles nobody chose got a stamp and a chosen one did not. */
function stampBlocker(ids: string[]): string {
  if (!ids.length) return "Keine Kacheln gewählt";
  const owners = new Set(ids.map((id) => groupOf(app.manifest, id)?.id ?? ""));
  if (owners.size > 1) {
    return owners.has("")
      ? "Auswahl mischt freie und vergebene Kacheln — erst zu einer Gruppe machen"
      : "Auswahl liegt in mehreren Gruppen — im Gruppen-Panel zuweisen";
  }
  const group = groupOf(app.manifest, ids[0]);
  // One group, but only part of it: stamping would reach tiles left unpicked.
  if (group && group.tiles !== "all" && group.tiles.length !== ids.length) {
    return `„${group.name}" hat ${group.tiles.length} Kacheln — ganze Gruppe wählen oder im Panel zuweisen`;
  }
  return "";
}

/** The group a stamp from the wall lands in — only ever called once
 *  stampBlocker has confirmed the selection is exactly one group, or free. */
function groupFor(ids: string[]): Overlay {
  const existing = groupOf(app.manifest, ids[0]);
  if (existing) return existing;
  app.manifest.overlays.push(newOverlay(`Gruppe ${groups().length + 1}`, [...ids]));
  // Read it back out rather than using the value pushed: Svelte hands back a
  // proxy, and mutating the raw object would not be reactive.
  return app.manifest.overlays[app.manifest.overlays.length - 1];
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
      layer.name = baseName(path);
      layer.space = "grid";
      layer.scale = 1;
      allTiles().layers.push(layer);
      // Selected straight away, like every other insert: "Anwenden" acts on
      // the chosen layer, and leaving it unchosen meant the button stayed grey
      // until you went hunting for the thing you had just added.
      app.selected = layer.id;
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
export async function applyTransform(
  obj: Tagged,
  patch: Pick<Layer, "x" | "y" | "rotation"> & { scale: number; scaleH: number },
) {
  const list = listOf(obj.layerId) ?? app.manifest.tiles[obj.tileId]?.layers ?? [];
  const layer = findLayer(list, obj.layerId);
  if (!layer) return;
  const shared = instanceCount(app.manifest, obj.layerId, obj.space) > 1;
  await mutate(() => {
    layer.x = patch.x;
    layer.y = patch.y;
    layer.rotation = patch.rotation;
    resize(layer, patch.scale, patch.scaleH);
  }, shared);
}

/** The currently selected grid-space picture, if that is what is selected —
 *  what "Anwenden" acts on. */
function selectedMosaic(): ImageLayer | undefined {
  const l = app.selected ? findLayer(listOf(app.selected) ?? [], app.selected) : undefined;
  return l?.kind === "image" && l.space === "grid" ? l : undefined;
}

export const canBakeMosaic = () => !!selectedMosaic();

/** Bakes the selected grid-space picture into every tile it fully covers, then
 *  removes it: a mosaic in place is a background, not a floating object, and
 *  should not keep sitting on top of other layers or stay draggable once it is
 *  where it belongs. Re-positioning means adding a new picture and baking
 *  again — there is deliberately no "unbake". */
export async function bakeMosaic() {
  const layer = selectedMosaic();
  if (!layer) return;
  await run("bake", async () => {
    const bmp = await loadAsset(app.dir, layer.asset);
    const ids = visibleIds();
    const crops = mosaicBakeCrops(layer, { w: bmp.width, h: bmp.height }, ids.length);
    if (!crops.size) {
      app.error = "Bild deckt keine Kachel vollständig ab";
      return;
    }
    await mutate(() => {
      bakeMosaicInto(app.manifest, layer.id, layer.asset, crops, ids);
      app.selected = "";
    });
  });
}

/* --- Layouts: tile-sized documents composed on their own, then rendered to a
 * flat picture and stamped onto tiles as an ordinary image layer. Editing one
 * means editing this document and re-stamping — there is no live link between
 * a Layout's own layers and what ends up on a tile. --- */

export const layouts = () => app.manifest.layouts;
export const openLayout = () => app.manifest.layouts.find((l) => l.id === app.openLayoutId);

export async function newLayoutDoc(name: string) {
  await mutate(() => {
    const l = newLayout(name.trim() || `Layout ${app.manifest.layouts.length + 1}`);
    app.manifest.layouts.push(l);
    app.openLayoutId = l.id;
    app.layoutSelected = "";
  });
}

/* Neither opening nor closing touches app.selectedTiles: the flow this exists
 * for is picking tiles on the wall, then opening a layout to check or tweak
 * it, then closing and stamping onto the same picked tiles — clearing the
 * selection on either transition would break exactly that. */
export const openLayoutDoc = (id: string) => {
  app.openLayoutId = id;
  app.layoutSelected = "";
};
export const closeLayoutDoc = () => {
  app.openLayoutId = "";
  app.layoutSelected = "";
};

export async function deleteLayoutDoc(id: string) {
  await mutate(() => {
    const at = app.manifest.layouts.findIndex((l) => l.id === id);
    if (at >= 0) app.manifest.layouts.splice(at, 1);
    if (app.openLayoutId === id) closeLayoutDoc();
  });
}

export async function renameLayout(id: string, name: string) {
  const layout = app.manifest.layouts.find((l) => l.id === id);
  if (!layout || !name.trim() || layout.name === name.trim()) return;
  await mutate(() => (layout.name = name.trim()));
}

/** A layer by id in whichever document holds it: the open Layout's own list,
 *  or the wall's overlays. Rename and lock work the same in both, so they take
 *  this rather than each document getting its own copy. */
const anyLayer = (id: string) =>
  findLayer(openLayout()?.layers ?? [], id) ?? findLayer(listOf(id) ?? [], id);

/** `name` lives on Common, so one function renames every kind of layer. */
export async function renameLayer(id: string, name: string) {
  const layer = anyLayer(id);
  if (!layer) return;
  const next = name.trim();
  await mutate(() => (layer.name = next || undefined));
}

/** Locking takes a layer out of Fabric's hit testing (makeInteractive in
 *  scene.ts), so it stops being draggable while staying visible. */
export async function toggleLayerLocked(id: string) {
  const layer = anyLayer(id);
  if (!layer) return;
  await mutate(() => (layer.locked = !layer.locked));
}

/** Picks one layer, from the canvas or from a plain list click.
 *
 *  A layer already inside the current multi-selection keeps that selection.
 *  Without that, Ctrl-picking a second row collapsed the set straight back to
 *  one: the pick moves `layoutSelected`, the canvas follows by setting its
 *  active object, Fabric fires selection:created, and the handler landed back
 *  here — undoing the very selection that caused it. */
/** Replaces the Layout's whole selection — what the canvas reports after a
 *  rubber band, and what the list writes when several rows are picked. */
export function setLayoutSelection(ids: string[]) {
  app.layoutSelection = ids;
  app.layoutSelected = ids.at(-1) ?? "";
}

export function selectLayoutLayer(id: string) {
  if (app.layoutSelected !== id) app.layoutSelected = id;
  app.layoutSelection = id ? [id] : [];
}

export async function toggleLayoutLayerHidden(id: string) {
  const l = findLayer(openLayout()?.layers ?? [], id);
  if (!l) return;
  await mutate(() => (l.hidden = !l.hidden));
}

/** Deletes a layer. On a group this dissolves it instead, handing the members
 *  back — see removeLayerFrom. */
export async function deleteLayoutLayer(id: string) {
  const layout = openLayout();
  if (!layout) return;
  await mutate(() => {
    removeLayerFrom(findList(layout.layers, id) ?? layout.layers, id);
    app.layoutSelection = app.layoutSelection.filter((x) => x !== id);
    if (app.layoutSelected === id) app.layoutSelected = "";
  });
}

/** Same top-first draw order as moveLayer, scoped to the list the layer sits
 *  in — a member moves within its group, not out of it. */
export async function moveLayoutLayer(id: string, up: boolean) {
  const list = openLayout() && findList(openLayout()!.layers, id);
  if (!list) return;
  const at = list.findIndex((l) => l.id === id);
  const to = at + (up ? 1 : -1);
  if (at < 0 || to < 0 || to >= list.length) return;
  await mutate(() => ([list[at], list[to]] = [list[to], list[at]]));
}

export async function addLayoutImage() {
  const layout = openLayout();
  if (!layout) return;
  const path = await pickFile({ filters: [IMAGE_FILTER] });
  if (typeof path !== "string") return;
  await run("import", async () => {
    const asset = await importAsset(app.dir, path);
    await mutate(() => {
      const l = newImageLayer(asset);
      l.name = baseName(path);
      layout.layers.push(l);
      selectLayoutLayer(l.id);
    });
  });
}

/** Adds a caption to the open Layout.
 *
 *  A Layout is rendered once and stamped as a flat picture, so every tile gets
 *  the same words — the "{{id}}" placeholder cannot vary here the way it does
 *  in a tile-local caption, because by the time the stamp lands there is no
 *  text left, only pixels. Per-tile wording needs a layer on the tile itself,
 *  which buildGrid now draws but nothing yet creates. */
export async function addLayoutText() {
  const layout = openLayout();
  if (!layout) return;
  await mutate(() => {
    const l = newTextLayer();
    // Dead centre, not the 0.9 a tile caption defaults to: a Layout is a blank
    // sheet, and something dropped at the bottom edge reads as misplaced.
    l.y = 0.5;
    /* Centred, or it is not actually in the middle: a caption's box is a whole
     * tile wide, and left-aligned text starts at that box's left edge however
     * the box itself is placed. The default of "left" is right for a caption
     * pinned along the bottom of a tile, and wrong for one dropped in the
     * middle of a sheet. */
    l.align = "center";
    layout.layers.push(l);
    selectLayoutLayer(l.id);
  });
}

export async function addLayoutShape(shape: ShapeKind) {
  const layout = openLayout();
  if (!layout) return;
  await mutate(() => {
    const l = newShapeLayer(shape);
    layout.layers.push(l);
    selectLayoutLayer(l.id);
  });
}

/** Any field any kind of layer has.
 *
 *  `keyof Layer` would only be the handful every kind shares, since Layer is a
 *  union — so a caption's `size` would not typecheck. Spelling the union out
 *  still rejects a field that exists nowhere, which is the typo this is
 *  guarding against; pairing the right field with the right kind is the
 *  caller's job, and the properties panel does it by rendering each field
 *  inside the branch that narrowed the layer to that kind. */
export type LayerField = keyof TextLayer | keyof ShapeLayer | keyof ImageLayer;

/** Edits one field of a layer. Everything the properties panel changes goes
 *  through here, so each edit is one undo step and one save. */
export async function setLayerField(id: string, key: LayerField, value: unknown) {
  const layer = anyLayer(id) as Record<string, unknown> | undefined;
  if (!layer || layer[key] === value) return;
  await mutate(() => {
    layer[key] = value;
  });
}

/** Writes a finished drag/scale/rotate back into a Layout's own layer. Unlike
 *  applyTransform on the wall, this always skips the rebuild: nothing inside
 *  one Layout is ever shared with itself, so there is never a second instance
 *  left showing a stale position. */
export async function applyLayoutTransform(
  layerId: string,
  patch: Pick<Layer, "x" | "y" | "rotation"> & { scale: number; scaleH: number },
) {
  const layout = openLayout();
  const layer = findLayer(layout?.layers ?? [], layerId);
  if (!layout || !layer) return;
  /* A layer inside a group renders at its own position plus every enclosing
   * group's displacement, so the position read off the canvas has that folded
   * in — subtract it again or the layer jumps by the group's offset on the
   * first drag after grouping. */
  const shift = nestingShift(layout.layers, layerId) ?? { dx: 0, dy: 0 };
  await mutate(() => {
    layer.x = patch.x - shift.dx;
    layer.y = patch.y - shift.dy;
    layer.rotation = patch.rotation;
    resize(layer, patch.scale, patch.scaleH);
  }, false);
}

/** Folds a canvas resize back into whatever field a layer keeps its size in.
 *
 *  `patch.scale` is the object's on-screen width as a fraction of the tile, so
 *  each kind has to undo its own way of turning a model value into that width
 *  — an image scales its picture, a caption its font size, a shape its box.
 *  Fabric's own scaleX is deliberately not stored: the scene is rebuilt from
 *  the model, so anything left in scaleX would be applied twice. */
function resize(layer: Layer, scale: number, scaleH: number) {
  if (layer.kind === "image") {
    layer.scale = scale;
  } else if (layer.kind === "text") {
    // A caption's box is one tile wide, so the width fraction *is* the factor.
    layer.size *= scale || 1;
  } else if (layer.kind === "shape") {
    // Both axes on their own: a shape is the one kind that can be stretched,
    // and tying height to width is what made every shape square forever.
    layer.w = scale;
    layer.h = scaleH;
  }
}

/* --- Layer groups inside a Layout. A group is which layers move together —
 * the other axis from a tile group, which is which tiles a stack lands on. --- */

/** Layers picked in the Layout's list, in list order. Multi-select is what
 *  grouping needs and a single pick is just the one-element case, so the two
 *  selections are the same field. */
export const layoutPicked = () => app.layoutSelection;

export function toggleLayoutPick(id: string, additive: boolean) {
  const at = app.layoutSelection.indexOf(id);
  if (!additive) {
    app.layoutSelection = at >= 0 && app.layoutSelection.length === 1 ? [] : [id];
  } else {
    app.layoutSelection =
      at >= 0
        ? app.layoutSelection.filter((x) => x !== id)
        : [...app.layoutSelection, id];
  }
  app.layoutSelected = app.layoutSelection.at(-1) ?? "";
}

/** Grouping needs at least two, and only top-level layers: a group inside a
 *  group is a nesting level with no button to get back out of. */
export function canGroupLayers(): boolean {
  const list = openLayout()?.layers ?? [];
  const picked = app.layoutSelection.filter((id) => list.some((l) => l.id === id));
  return picked.length >= 2;
}

export async function groupLayoutLayers() {
  const layout = openLayout();
  if (!layout || !canGroupLayers()) return;
  const picked = new Set(app.layoutSelection);
  await mutate(() => {
    const members = layout.layers.filter((l) => picked.has(l.id));
    /* The group goes where the *topmost* member was, so nothing that was
     * above a member ends up below the group. findIndex gives the bottom-most
     * one, which restacked the pick: grouping A and C out of A,B,C,D put the
     * group under B, and C stopped drawing over it.
     *
     * Counted in the list with the members removed, since that is the list the
     * group is spliced into. */
    const kept = layout.layers.filter((l) => !picked.has(l.id));
    let topMost = -1;
    for (const [i, l] of layout.layers.entries()) if (picked.has(l.id)) topMost = i;
    const above = layout.layers.slice(topMost + 1).filter((l) => !picked.has(l.id)).length;
    const group = newGroupLayer(members);
    group.name = `Gruppe ${kept.filter((l) => l.kind === "group").length + 1}`;
    kept.splice(kept.length - above, 0, group);
    layout.layers = kept;
    setLayoutSelection([group.id]);
  });
}

/** The groups a Layout holds, for the "move into" menu. Top level only —
 *  nesting a group inside a group is a level with no button to climb back out
 *  of, so it is not offered. */
export const layoutGroups = () =>
  (openLayout()?.layers ?? []).filter((l): l is Layer & { kind: "group" } => l.kind === "group");

/** Moves the picked layers into an existing group, keeping them where they
 *  visibly are: a group's x/y is a displacement applied on top of its members,
 *  so entering one has to subtract that displacement or everything jumps by
 *  exactly the group's offset. The mirror of what removeLayerFrom folds in on
 *  the way out. */
export async function moveLayersIntoGroup(groupId: string, layerIds: string[]) {
  const layout = openLayout();
  const group = layout && findLayer(layout.layers, groupId);
  if (!layout || group?.kind !== "group") return;

  /* Every layer that is not already in this group, wherever it currently
   * sits. Looking only at the top level made this a silent no-op on a layer
   * nested in some other group — it still cleared the selection and pushed an
   * undo step, so it looked like something had happened. */
  const own = new Set(group.children.map((c) => c.id));
  const moving = layerIds.filter((id) => id !== groupId && !own.has(id));
  if (!moving.length) return;

  await mutate(() => {
    const target = groupShift(group);
    const taken: Layer[] = [];
    for (const id of moving) {
      const from = findList(layout.layers, id);
      const layer = from && findLayer(from, id);
      if (!from || !layer) continue;
      // Where it renders now, minus where the target group will put it: the
      // layer has to stay exactly where it visibly is.
      const was = nestingShift(layout.layers, id) ?? { dx: 0, dy: 0 };
      from.splice(from.indexOf(layer), 1);
      shiftLayer(layer, was.dx - target.dx, was.dy - target.dy);
      group.children.push(layer);
      taken.push(layer);
    }
    if (taken.length) setLayoutSelection(taken.map((l) => l.id));
  });
}

/** Dissolves a group, leaving its members where they visibly are.
 *
 *  removeLayerFrom already does exactly this — it hands a group's children back
 *  to the list at the group's index with the displacement folded in, precisely
 *  so one misplaced click on a folder cannot take a stack of layers with it. */
export async function ungroupLayoutLayers(groupId: string) {
  const layout = openLayout();
  if (!layout) return;
  await mutate(() => {
    removeLayerFrom(layout.layers, groupId);
    app.layoutSelection = app.layoutSelection.filter((id) => id !== groupId);
    if (app.layoutSelected === groupId) app.layoutSelected = "";
  });
}

/** Renders `layout` and points a stamp at the result. Shared by stamping from
 *  the wall and assigning from a group's own row, which differ only in how the
 *  target group is found. */
async function stampAsset(layout: Layout): Promise<{ asset: string; seen: string }> {
  const seen = layoutFingerprint(layout);
  const bytes = await renderLayout(layout, app.deps!);
  return { asset: await saveGeneratedAsset(app.dir, bytes), seen };
}

/** Puts a layout onto a named group — the sidebar's "Layout zuweisen". */
export async function assignLayout(groupId: string, layoutId: string) {
  const group = findGroup(groupId);
  const layout = app.manifest.layouts.find((l) => l.id === layoutId);
  if (!group || !layout || !app.deps) return;
  await run("stamp", async () => {
    const { asset, seen } = await stampAsset(layout);
    await mutate(() => {
      stampInto(group, layoutId, asset);
      // After the stamp, so a live caption sits on top of the picture it was
      // composed over rather than behind it.
      syncLiveLayers(group, layout);
      layout.stamped = seen;
    });
  });
}

/** Renders the layout once and drops the result onto the picked tiles as an
 *  ordinary image layer. Stamping the same tile set again with the same
 *  layout updates that stamp's picture in place rather than stacking a
 *  duplicate — overlayFor already reuses the matching overlay, and finding the
 *  matching layoutId inside it is the rest. */
export const canStampLayout = () => !stampBlocker(app.selectedTiles);

/** Why the stamp button is off, for the status line — a greyed button with no
 *  reason reads as broken. */
export const stampHint = () => stampBlocker(app.selectedTiles);

export async function stampLayout(layoutId: string) {
  const layout = app.manifest.layouts.find((l) => l.id === layoutId);
  if (!layout || !app.deps) return;
  /* Checked up front, not inside the edit: rendering writes a PNG into
   * assets/ and mutate() takes an undo checkpoint, so bailing out halfway left
   * an unreferenced file behind and an undo step for something that never
   * happened. */
  const blocked = stampBlocker(app.selectedTiles);
  if (blocked) {
    app.error = blocked;
    return;
  }
  await run("stamp", async () => {
    // Taken before the render, not after: it records the state that actually
    // went into the picture, so an edit made while rendering still counts as
    // unsaved rather than being silently marked as already stamped.
    const { asset, seen } = await stampAsset(layout);
    await mutate(() => {
      const group = groupFor(app.selectedTiles);
      stampInto(group, layoutId, asset);
      // After the stamp, so a live caption sits on top of the picture it was
      // composed over rather than behind it.
      syncLiveLayers(group, layout);
      layout.stamped = seen;
    });
  });
}

/** How many spots a Layout is currently stamped onto — shown next to it so a
 *  design nobody uses anymore is visibly safe to delete. */
export const layoutUsage = (layoutId: string) => overlaysUsingLayout(app.manifest, layoutId).length;

/** Whether saving would do anything: the Layout has to be stamped somewhere,
 *  and changed since. Offering it otherwise gives a button that re-renders an
 *  identical picture and looks like it did nothing. */
export function canSaveLayout(layoutId: string): boolean {
  const layout = app.manifest.layouts.find((l) => l.id === layoutId);
  return !!layout && !!layoutUsage(layoutId) && layoutNeedsRestamp(layout);
}

/** Re-renders once and refreshes every existing stamp of this Layout across
 *  every overlay, so a design used in several places updates everywhere at
 *  once instead of being re-stamped by hand at each. */
export async function saveLayout(layoutId: string) {
  const layout = app.manifest.layouts.find((l) => l.id === layoutId);
  if (!layout || !app.deps || !canSaveLayout(layoutId)) return;
  await run("save", async () => {
    const { asset, seen } = await stampAsset(layout);
    await mutate(() => {
      const n = refreshStamps(app.manifest, layoutId, asset);
      // Live captions travel with the stamp: repositioning or restyling one in
      // the Layout has to reach every group using it, the same as the picture.
      for (const o of overlaysUsingLayout(app.manifest, layoutId)) syncLiveLayers(o, layout);
      layout.stamped = seen;
      app.error = `${n} Stempel aktualisiert`;
    });
  });
}

export async function saveToGame() {
  await run("save", async () => {
    if (!app.deps) throw new Error("kein Ordner geöffnet");
    const n = await saveTiles(app.dir, plain(app.manifest), app.deps);
    app.error = `${n} Kacheln geschrieben`;
  });
}
