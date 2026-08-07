/* Editor state: opens a folder, holds a manifest, writes it back. */
import { open as pickFile } from "./platform";

import { saveTiles } from "./export";
import { coverScale, gridSize, mosaicBakeCrops } from "./geometry";
import { canRedo, canUndo, checkpoint, emptyHistory, endRun, redo, undo } from "./history";
import { renderLayout } from "./layout";
import {
  bakeMosaicInto,
  clearBases,
  deleteStampCascade,
  dissolveFolder,
  duplicateLayout,
  emptyManifest,
  findLayer,
  findList,
  groupShift,
  holdersUsingLayout,
  folderOf,
  inboxIds,
  looseTiles,
  moveToProject,
  nameInStack,
  layerLabel,
  layoutFingerprint,
  layoutNeedsRestamp,
  nestingShift,
  newGroupLayer,
  newFolder,
  newImageLayer,
  newLayout,
  newProject,
  newShapeLayer,
  newTextLayer,
  placeTile,
  projectOf,
  projectTiles,
  putInFolder,
  refreshStamps,
  removeFromProjectToInbox,
  relocateLayer,
  removeLayerFrom,
  resolveLayers,
  shiftLayer,
  stampFamily,
  stampInto,
  swapPlaced,
  takeOutOfFolder,
  syncLiveLayers,
  tilesUsingLayout,
  unplaceTile,
  type ImageLayer,
  type Layer,
  type Layout,
  type Manifest,
  type Project,
  type ShapeKind,
  type ShapeLayer,
  type TextLayer,
} from "./model";
import {
  defaultDir,
  importAsset,
  listTiles,
  loadAsset,
  classify,
  dropVaultCopy,
  forgetOriginal,
  hashTiles,
  loadFingerprints,
  loadManifest,
  pruneVault,
  saveFingerprints,
  restoreTiles,
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
  /** Tiles picked on the canvas. What a new project gets built from. */
  selectedTiles: [] as string[],
  /** Where a Shift-range measures from: the last tile picked without Shift. */
  tileAnchor: "",
  /** Folder being hovered in the sidebar — its tiles get outlined on the wall,
   *  so you can see what a drawer holds without opening it. */
  hoverFolder: "",
  /** Tile row being hovered in the sidebar. Its own outline on the wall, in its
   *  own colour: a list of numbers cannot say which portrait it means, and the
   *  answer to "which one is t07" should not cost a click that changes the
   *  selection you were building. */
  hoverTile: "",
  /** Which project's wall is showing, "" for the inbox — the tiles no project
   *  has claimed. View state only: which wall you are looking at is not an edit
   *  and has no business in the manifest or in undo. */
  openProjectId: "",
  /** Every tile id the folder has, newest read wins. The inbox is derived from
   *  this and the projects, so it is never stored: the folder is where ids come
   *  from, and a second copy of that list would drift from it. */
  folderIds: [] as string[],
  /** Ids this folder had never shown us before — a first run, or characters
   *  created since the last one. Not a problem to solve, just something that
   *  has to be visible; they sit in the inbox until they are sorted. */
  newTiles: [] as string[],
  /** Ids whose file the game rewrote under us. The one question the app cannot
   *  answer itself: a restyle keeps the character, a deleted-and-refilled slot
   *  does not, and the bytes look identical either way. */
  changedTiles: [] as string[],
  /** What each tile hashed to on this open, so answering the question does not
   *  mean reading 90 MB a second time. */
  hashes: {} as Record<string, string>,
  /** The tiles a selected wall picture would be baked into — outlined on the
   *  wall so the gaps are visible before Apply rather than after. */
  coverPreview: [] as string[],
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

/** Everything between two ids, inclusive, in the order the list is in.
 *
 *  Either end missing — a shelved tile has no slot on the wall — means there
 *  is no range to take, so the click stands on its own. */
export const tileRange = (ids: string[], from: string, to: string): string[] => {
  const a = ids.indexOf(from);
  const b = ids.indexOf(to);
  if (a < 0 || b < 0) return [to];
  return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
};

/** What a click on a tile does, on the wall and in the list alike.
 *
 *  Ctrl adds or removes one, Shift takes everything from the anchor to here —
 *  the two gestures every list has. Filing twenty tiles into a drawer used to
 *  cost twenty ctrl-clicks, because Shift was merely a second Ctrl. */
export function toggleTile(id: string, mods: { ctrl?: boolean; shift?: boolean }) {
  // Picking something is the user moving on; a note about the last action has
  // had its moment and is now in the way of the selection count.
  app.error = "";
  const current = app.selectedTiles;
  /* The anchor deliberately stays where it is: a second shift-click reshapes
   * the same range rather than starting over from the last one, which is what
   * makes "a bit further down after all" one click instead of three. */
  if (mods.shift && app.tileAnchor) {
    app.selectedTiles = tileRange(visibleIds(), app.tileAnchor, id);
    return;
  }
  app.tileAnchor = id;
  if (mods.ctrl) {
    app.selectedTiles = current.includes(id) ? current.filter((t) => t !== id) : [...current, id];
    return;
  }
  // A plain click on the only selected tile clears, so there is a way out
  // without hunting for empty canvas.
  app.selectedTiles = current.length === 1 && current[0] === id ? [] : [id];
}

export const clearTiles = () => (app.selectedTiles = []);

/** Drops every pick on the wall — tiles, layer, and the outline that follows a
 *  hovered drawer. What a click on empty canvas means. */
export function clearAll() {
  app.selectedTiles = [];
  app.selected = "";
  app.hoverFolder = "";
}

/** The tiles outlined on the wall.
 *
 *  Two things want the same mark, never at once: the drawer the pointer is
 *  over in the sidebar, and — when a wall picture is selected — the tiles that
 *  picture would actually land on. The second is the answer to a question the
 *  app used to leave unanswered until after the fact; see coverPreview. */
export function assignedTiles(): string[] {
  if (app.hoverFolder) {
    return openProject()?.folders.find((f) => f.id === app.hoverFolder)?.tiles ?? [];
  }
  return app.coverPreview;
}

/** Which tiles a selected wall picture would be baked into.
 *
 *  Baking skips any tile the picture does not cover *completely*: a tile's base
 *  is always a full-bleed crop, so there is no way to store half of one and
 *  guessing at the rest would be worse than leaving it. That rule is right and
 *  it was also invisible — the app only spoke up when nothing at all was
 *  covered, so "21 of 44" looked like a wall with a row missing for no reason.
 *
 *  It bites easily: a new picture starts at scale 1, which means "as wide as
 *  the grid", and a wall of forty-four tiles is seven rows tall — so a 16:9
 *  photo at scale 1 reaches only the middle three rows. Recomputed after every
 *  drag, so the outline moves with the picture instead of reporting afterwards. */
export async function refreshCoverPreview() {
  const layer = selectedMosaic();
  const p = openProject();
  if (!layer || !p || !app.dir) {
    if (app.coverPreview.length) app.coverPreview = [];
    return;
  }
  try {
    const bmp = await loadAsset(app.dir, layer.asset);
    const crops = mosaicBakeCrops(layer, { w: bmp.width, h: bmp.height }, p.order.length);
    app.coverPreview = [...crops.keys()].map((i) => p.order[i]);
  } catch {
    // An unreadable picture is the render path's problem to report, not this
    // one's; an outline that quietly says "nothing" is the honest fallback.
    app.coverPreview = [];
  }
}

/* --- Projects. One wall each; the FaceTexture folder holds several accounts'
 * worth of portraits and a project is which of them belong together. The
 * inbox is what no project has claimed, derived rather than stored. --- */

export const projects = () => app.manifest.projects;

/** The project whose wall is showing, or undefined for the inbox. */
export const openProject = (): Project | undefined =>
  app.manifest.projects.find((p) => p.id === app.openProjectId);

/** Tiles the folder has that no project claims. */
export const inbox = () => inboxIds(app.manifest, app.folderIds);

/** What the canvas and the export are pointed at. The inbox is a wall too: the
 *  unclaimed tiles, with no picture spread over them. */
export function wall(): { ids: string[]; gridLayers: Layer[] } {
  const p = openProject();
  return p ? { ids: p.order, gridLayers: p.gridLayers } : { ids: inbox(), gridLayers: [] };
}

export function openProjectView(id: string) {
  if (app.openProjectId === id) return;
  app.openProjectId = id;
  // The pick belongs to the wall it was made on; carrying it across would leave
  // actions pointing at tiles that are no longer on screen.
  clearAll();
  app.version++;
}

/** The tile ids of the picked tiles that no project has claimed — what a new
 *  project may be built from, and why a greyed button has a readable reason. */
export const freeCount = () => inboxIds(app.manifest, app.selectedTiles).length;

/* --- The shelf: a project's tiles that have no slot on its grid yet. Sorting
 * forty-four portraits into a wall is a two-step job — collect, then arrange —
 * and this is the holding area between them. --- */

export const shelfIds = () => openProject()?.shelf ?? [];

/** Drops a shelved tile onto the grid, in front of `beforeId` or at the end.
 *  Dense: the game's grid has no holes, so neither does this. */
export async function placeTileAt(tileId: string, beforeId: string | null) {
  const p = openProject();
  if (!p) return;
  await mutate(() => placeTile(p, tileId, beforeId));
}

/** Takes a tile off the grid without giving up the project. Its layers stay:
 *  only the slot is surrendered, and the tiles after it close the gap. */
export async function unplace(tileId: string) {
  const p = openProject();
  if (!p) return;
  await mutate(() => unplaceTile(p, tileId));
}

/* --- Cosmetic folders. Drawers in the tile list, nothing more: dissolving one
 * leaves every tile on its slot with every layer still on it. --- */

export const folders = () => openProject()?.folders ?? [];

export const tileFolder = (tileId: string) => {
  const p = openProject();
  return p ? folderOf(p, tileId) : undefined;
};

/** The visible tiles no drawer has taken, in grid order. */
export const looseIds = () => {
  const p = openProject();
  return p ? looseTiles(p, visibleIds()) : visibleIds();
};

export async function newFolderHere(name: string) {
  const p = openProject();
  if (!p) return;
  await mutate(() => {
    const f = newFolder(name.trim() || `Folder ${p.folders.length + 1}`);
    // The picked tiles go straight in: making a drawer is something you do
    // *to* a selection, and an empty one would then have to be filled by hand.
    for (const id of app.selectedTiles) f.tiles.push(id);
    p.folders.push(f);
  });
}

export async function renameFolder(folderId: string, name: string) {
  const f = folders().find((x) => x.id === folderId);
  if (!f || !name.trim() || f.name === name.trim()) return;
  await mutate(() => (f.name = name.trim()), true, `folder:${folderId}`);
}

export async function removeFolder(folderId: string) {
  const p = openProject();
  if (!p) return;
  await mutate(() => dissolveFolder(p, folderId));
}

/** Puts a tile into a drawer, or back on the loose pile when `folderId` is "". */
export async function fileTile(tileId: string, folderId: string) {
  const p = openProject();
  if (!p) return;
  await mutate(() => (folderId ? putInFolder(p, folderId, tileId) : takeOutOfFolder(p, tileId)));
}

/** Hands the picked tiles to another project. Their layers, wording and
 *  pictures go with them for free — those live under the tile id, which no
 *  project owns. */
export async function moveTilesToProject(projectId: string) {
  const moving = [...app.selectedTiles];
  if (!moving.length) return;
  await mutate(() => {
    for (const id of moving) moveToProject(app.manifest, id, projectId);
    clearAll();
  });
}

/** Sends the picked tiles back to the inbox, keeping every layer on them.
 *  `wipe` is deliberately false: leaving a wall is not the same as the id
 *  turning out to be a different character, and only the change-detection pass
 *  knows which of the two happened. */
export async function releaseTilesToInbox() {
  const leaving = app.selectedTiles.filter((id) => projectOf(app.manifest, id));
  if (!leaving.length) return;
  await mutate(() => {
    for (const id of leaving) removeFromProjectToInbox(app.manifest, id, false);
    clearAll();
  });
}

export async function newProjectFrom(name: string) {
  const free = inboxIds(app.manifest, app.selectedTiles);
  await mutate(() => {
    const p = newProject(name.trim() || `Project ${app.manifest.projects.length + 1}`);
    // Straight onto the grid, in the order they sit on the inbox wall: the
    // point of building a project from a selection is to have a wall, not a
    // pile to place by hand afterwards.
    p.order = free;
    app.manifest.projects.push(p);
    app.openProjectId = p.id;
    clearAll();
  });
}

/* --- Per-tile wording. A caption a Layout keeps live is one layer drawn on
 * every tile of its group: position and style are shared, the words are
 * not. --- */

/** Everything drawn on one tile, whichever group or tile stack it comes from.
 *
 *  `resolveLayers` and not the group's list: a tile can carry a layout of its
 *  own now, and its live captions and pictures sit in the tile's own stack —
 *  looking only at the group left an individually stamped portrait with no
 *  wording panel at all. */
const drawnOn = (tileId: string) => resolveLayers(app.manifest, tileId);

/** The live captions on one tile — what its wording fields offer to edit.
 *
 *  By tile id, not by selection: the fields live in that tile's own row now,
 *  so there is no question of which tile they mean and no way for the panel to
 *  be somewhere else on the screen than the tile it belongs to. */
export const tileCaptions = (tileId: string): TextLayer[] =>
  drawnOn(tileId).filter((l): l is TextLayer => l.kind === "text");

/** The live pictures on one tile — the same bargain as a caption, one kind
 *  over: the Layout owns where and how big, the tile owns which picture. */
export const tileImages = (tileId: string): ImageLayer[] =>
  drawnOn(tileId).filter((l): l is ImageLayer => l.kind === "image" && !!l.live);

/** This tile's picture for a live image layer, or undefined when it shows the
 *  layer's own. "" is a choice, not an absence: no picture here. */
export const tileAsset = (tileId: string, layerId: string): string | undefined =>
  app.manifest.tiles[tileId]?.swap?.[layerId];

/** Every picture already in play for this layer, newest last — the gallery.
 *
 *  Class logos repeat across a wall: roughly twenty-five of them over forty-odd
 *  characters, so the second tile onwards is almost always a picture already
 *  imported. Offering those to click is the difference between one file dialog
 *  and forty. The layer's own picture leads, since that is the default every
 *  tile falls back to. */
export function tileImageChoices(tileId: string, layerId: string): string[] {
  const layer = tileImages(tileId).find((l) => l.id === layerId);
  const seen = new Set<string>(layer ? [layer.asset] : []);
  for (const tile of Object.values(app.manifest.tiles)) {
    const a = tile.swap?.[layerId];
    if (a) seen.add(a);
  }
  return [...seen];
}

/** Points one tile's live picture at an asset. "" means none — see layerAsset. */
export async function setTileAsset(tileId: string, layerId: string, asset: string) {
  const tile = app.manifest.tiles[tileId];
  if (!tile) return;
  await mutate(() => {
    // The map is optional on Tile, so a manifest written before per-tile
    // pictures existed has to grow one on first use.
    (tile.swap ??= {})[layerId] = asset;
  });
}

/** Back to the layer's own picture — the absence of a key, not "" which is the
 *  deliberate "none". */
export async function clearTileAsset(tileId: string, layerId: string) {
  const tile = app.manifest.tiles[tileId];
  if (!tile?.swap || tile.swap[layerId] === undefined) return;
  await mutate(() => delete tile.swap![layerId]);
}

/** Imports a picture and gives it to this one tile. */
export async function pickTileImage(tileId: string, layerId: string) {
  const path = await pickFile({ filters: [IMAGE_FILTER] });
  if (typeof path !== "string") return;
  await run("import", async () => {
    const asset = await importAsset(app.dir, path);
    await setTileAsset(tileId, layerId, asset);
  });
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
  await mutate(() => (tile.text[layerId] = text), true, `text:${tileId}:${layerId}`);
}

/** Drops the override so the tile follows the layer's default again — the only
 *  way back, precisely because clearing the field does not do this. */
export async function clearTileText(tileId: string, layerId: string) {
  const tile = app.manifest.tiles[tileId];
  if (!tile || !(layerId in tile.text)) return;
  await mutate(() => delete tile.text[layerId]);
}

export async function renameProject(projectId: string, name: string) {
  const p = app.manifest.projects.find((x) => x.id === projectId);
  if (!p || !name.trim() || p.name === name.trim()) return;
  await mutate(() => (p.name = name.trim()), true, `rename:${projectId}`);
}

/** Deleting a project hands its tiles back to the inbox and keeps every layer
 *  on them: artwork belongs to the tile, not to the wall it was arranged on.
 *  That is the whole point of the split, and it is why this needs no warning
 *  about losing work — there is none to lose. */
export async function deleteProject(projectId: string) {
  await mutate(() => {
    const at = app.manifest.projects.findIndex((p) => p.id === projectId);
    if (at >= 0) app.manifest.projects.splice(at, 1);
    if (app.openProjectId === projectId) app.openProjectId = "";
    clearAll();
  });
}

/** Swaps two placed tiles on the open project's grid. Only makes sense on a
 *  project: the inbox is a heap in folder order, not an arrangement. */
export async function swapTilePlaces(a: string, b: string) {
  const p = openProject();
  if (!p) return;
  await mutate(() => swapPlaced(p, a, b));
}

/* Reactive so the toolbar can grey the buttons out. Exported so a test can
 * assert how many steps an action cost — the difference between "typing a
 * word is one undo" and "one per letter" is invisible from the outside
 * otherwise. */
export const history = $state(emptyHistory<Manifest>());
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
/** Every edit goes through here.
 *
 *  `structural` is false for a drag: the canvas already shows the result, so
 *  bumping the version would tear the scene down to redraw what is correct.
 *
 *  `run` names a continuous kind of edit — one field of one layer, say — and
 *  collapses the whole burst into a single undo step. Dragging a slider fires
 *  one of these per pointer event; without it, a single drag filled a fifth of
 *  the two-hundred-step history and could only be taken back one notch at a
 *  time. */
async function mutate(fn: () => void, structural = true, run?: string) {
  /* Cleared here rather than left to time out: the status line has one slot,
   * and a note from three actions ago ("12 Kacheln geschrieben") sat there
   * hiding the live selection count and its "aufheben" link until something
   * else happened to overwrite it. Anything a mutation wants to say sets it
   * inside fn, after this. */
  app.error = "";
  const before = plain(app.manifest);
  checkpoint(history, before, run);
  try {
    fn();
  } catch (e) {
    /* An edit that throws part-way used to leave the manifest half-changed
     * with no version bump and no save: the sidebar showed the change, the
     * canvas did not, and the file on disk was a third answer. Putting the
     * recorded state back is the only way all three stay in step. */
    app.manifest = before;
    app.error = `Change failed: ${e}`;
    app.version++;
    undo(history, before);
    return;
  }
  if (structural) app.version++;
  await persist();
}

const layerExists = (id: string) => !!id && !!listOf(id);

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

/** The array a layer lives in: the open project's wall-spanning layers, or
 *  whichever tile's own stack holds it.
 *
 *  Both, because those are the only two places a layer can be — deleting or
 *  hiding one and finding nothing used to silently do nothing at all. */
const listOf = (id: string): Layer[] | undefined => {
  const grid = openProject()?.gridLayers;
  if (grid && findLayer(grid, id)) return grid;
  return Object.values(app.manifest.tiles).find((t) => !!findLayer(t.layers, id))?.layers;
};

export function selectLayer(id: string) {
  if (app.selected !== id) app.selected = id;
}

/** Hides or shows a layer — and, for a stamp, the whole assignment.
 *
 *  The eye on a stamp's row used to switch off the flattened sheet and leave
 *  the captions and logos the Layout keeps live still drawn: they have no row
 *  of their own, so "Hide" appeared to do nothing on exactly the layouts that
 *  carry something editable in the grid. */
export async function toggleLayerHidden(id: string) {
  const list = listOf(id);
  const family = list ? stampFamily(list, id) : [];
  const self = family.find((l) => l.id === id);
  if (!self) return;
  const next = !self.hidden;
  await mutate(() => {
    for (const l of family) l.hidden = next;
  });
}

/** Deletes a layer on the wall.
 *
 *  A stamp takes the Layout's live captions and pictures with it: they are
 *  copies the Layout keeps beside it, no list shows them on their own, and
 *  leaving them behind produced captions that drew on the wall with no row and
 *  no way to remove them. One click, one undo step, the whole assignment. */
export async function deleteLayer(id: string) {
  const list = listOf(id);
  const layer = list && findLayer(list, id);
  if (!list || !layer) return;
  await mutate(() => {
    // A group dissolves and hands its members back (removeLayerFrom); anything
    // else goes through the cascade, which is a no-op beyond the layer itself
    // unless that layer is a stamp.
    if (layer.kind === "group") removeLayerFrom(list, id);
    else deleteStampCascade(list, id);
    if (app.selected === id) app.selected = "";
  });
}

/** The tiles on screen, in grid order. One funnel: the canvas hit-tests
 *  through it, the band selection sorts through it, the export keys through
 *  it — the index into this list *is* the grid coordinate. */
export const visibleIds = () => wall().ids;

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
    app.error = `Saving failed: ${e}`;
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
    /* The folder's own list, kept because the inbox is derived from it rather
     * than stored: what the folder has, minus what the projects claim. Storing
     * the inbox instead would mean a second copy of this list drifting away
     * from the directory it is supposed to describe. */
    app.folderIds = ids;

    /* What the game did to the folder while we were away. Same id, different
     * bytes, is the only signal there is that a character slot was emptied and
     * refilled — and answering it wrong either throws away a restyled
     * character's design or leaves a stranger wearing it. So the app sorts and
     * the user decides; nothing is touched here. */
    const hashes = await hashTiles(app.dir, ids);
    const prints = await loadFingerprints(app.dir);
    const { fresh, changed } = classify(prints, hashes);
    for (const id of fresh) prints[id] = { original: hashes[id] };
    for (const id of Object.keys(prints)) if (!hashes[id]) delete prints[id];
    await saveFingerprints(app.dir, prints);
    app.newTiles = fresh;
    app.changedTiles = changed;
    app.hashes = hashes;

    app.deps = tauriDeps(app.dir);
    app.selected = "";
    /* Start on the overview rather than on a wall. With several accounts
     * sharing the folder there is no single "the" wall to open, and a new
     * character has to be visible somewhere the moment it appears. */
    app.openProjectId = "";
    // Undo must not reach back into the folder that was open before.
    history.past.length = 0;
    history.future.length = 0;
    app.version++;
  });
}

const IMAGE_FILTER = { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] };

/** Adds a picture spanning the whole wall — what used to be "the mosaic", now
 *  an ordinary layer that happens to live in grid space.
 *
 *  Only on a project: a picture spread across the wall belongs to that wall,
 *  and the inbox is a waiting room rather than an arrangement. */
export const canAddGridImage = () => !!openProject();

export async function addGridImage() {
  const project = openProject();
  if (!project) return;
  const path = await pickFile({ filters: [IMAGE_FILTER] });
  if (typeof path !== "string") return;
  await run("import", async () => {
    // The copy into assets/ happens before the checkpoint: it touches the disk,
    // not the document, so undo has nothing to take back there.
    const asset = await importAsset(app.dir, path);
    await mutate(() => {
      const layer = newImageLayer(asset);
      nameInStack(layer, project.gridLayers);
      layer.space = "grid";
      layer.scale = 1;
      project.gridLayers.push(layer);
      // Selected straight away, like every other insert: "Anwenden" acts on
      // the chosen layer, and leaving it unchosen meant the button stayed grey
      // until you went hunting for the thing you had just added.
      app.selected = layer.id;
    });
  });
}

/** Writes a finished drag/scale/rotate back into the model.
 *
 *  A plain move skips the rebuild: Fabric has already moved the very object
 *  being dragged, so tearing the scene down would redraw what is already
 *  correct. That used to need a second condition — a layer shared across an
 *  overlay's tiles existed once in the model and many times on screen, so
 *  moving one copy left the rest stale. Every layer lives on exactly one tile
 *  now, so only `scaled` is left, and it is the half that was never optional:
 *  see the note on it. */
export async function applyTransform(
  obj: Tagged,
  patch: Pick<Layer, "x" | "y" | "rotation"> & Transform,
) {
  const list = listOf(obj.layerId) ?? app.manifest.tiles[obj.tileId]?.layers ?? [];
  const layer = findLayer(list, obj.layerId);
  if (!layer) return;
  await mutate(() => {
    layer.x = patch.x;
    layer.y = patch.y;
    layer.rotation = patch.rotation;
    resize(layer, patch);
  }, scaled(patch));
  /* After the write, not before: the outline answers "where would this land"
   * and a plain drag does not bump `version`, so nothing else would recompute
   * it. Cheap — the picture is already decoded and cached. */
  void refreshCoverPreview();
}

/** Did this gesture actually scale something?
 *
 *  Fabric leaves the factor it applied sitting on the object, and a size that
 *  is *multiplied* by that factor — a caption's, a shape's — would take it
 *  again on the very next gesture. Two plain drags after one scale by 1.5 left
 *  the model 3.4x larger than what was on screen, silently, because skipping
 *  the rebuild meant nothing ever put the object's own scale back to 1.
 *  Rebuilding is what resets it, so a gesture that scaled has to ask for one. */
const scaled = (p: Transform) => p.fx !== 1 || p.fy !== 1;

/** The currently selected grid-space picture, if that is what is selected —
 *  what "Anwenden" acts on. */
function selectedMosaic(): ImageLayer | undefined {
  const l = app.selected ? findLayer(listOf(app.selected) ?? [], app.selected) : undefined;
  return l?.kind === "image" && l.space === "grid" ? l : undefined;
}

export const canBakeMosaic = () => !!selectedMosaic();

/** How many tiles the selected wall picture reaches, out of the wall — the
 *  number on the Apply button, so the gap is a fact before it is a surprise. */
export const coverCounts = () => ({
  covered: app.coverPreview.length,
  total: openProject()?.order.length ?? 0,
});

/** Sizes and centres the selected wall picture so it encloses the whole grid.
 *
 *  One press for the guarantee. The picture keeps its proportions, so whichever
 *  axis is short decides the scale and the other one overhangs — there is no
 *  arrangement that lays all four edges on the wall's unless the shapes match.
 *  Centred as well as sized, because a correctly sized picture nudged sideways
 *  still leaves a column bare. */
export async function coverTheWall() {
  const layer = selectedMosaic();
  const p = openProject();
  if (!layer || !p) return;
  await run("fit", async () => {
    const bmp = await loadAsset(app.dir, layer.asset);
    const scale = coverScale({ w: bmp.width, h: bmp.height }, gridSize(p.order.length));
    await mutate(() => {
      layer.scale = scale;
      layer.x = 0.5;
      layer.y = 0.5;
    });
    await refreshCoverPreview();
  });
}

/** How many tiles are showing a baked mosaic instead of their own portrait —
 *  the number on the button, so it says what it is about to touch. */
export const bakedCount = () => Object.values(app.manifest.tiles).filter((t) => !!t.base).length;

/** Takes every baked background off the wall at once. One mutation, so one
 *  Ctrl+Z puts the whole mosaic back — which is why this asks nothing first. */
export async function clearMosaic() {
  const n = bakedCount();
  if (!n) return;
  await mutate(() => {
    clearBases(app.manifest);
    app.error = `${n} portrait(s) restored`;
  });
}

/** Bakes the selected grid-space picture into every tile it fully covers, then
 *  removes it: a mosaic in place is a background, not a floating object, and
 *  should not keep sitting on top of other layers or stay draggable once it is
 *  where it belongs. Re-positioning means adding a new picture and baking
 *  again — there is deliberately no "unbake". */
export async function bakeMosaic() {
  const layer = selectedMosaic();
  const project = openProject();
  if (!layer || !project) return;
  await run("bake", async () => {
    const bmp = await loadAsset(app.dir, layer.asset);
    /* Measured against the same project the bake writes into. The crop map is
     * keyed by grid index, so a count from one wall and a placement on another
     * would put crops on the wrong portraits. */
    const crops = mosaicBakeCrops(layer, { w: bmp.width, h: bmp.height }, project.order.length);
    if (!crops.size) {
      app.error = "The picture does not fully cover any tile";
      return;
    }
    await mutate(() => {
      bakeMosaicInto(app.manifest, project, layer.id, layer.asset, crops);
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
  // Both, not just the one: leaving layoutSelection behind carried the
  // previous document's layer id into the next one, where a Ctrl-click then
  // built a two-layer selection out of one visible row and the properties
  // panel quietly stayed away.
  setLayoutSelection([]);
};
export const closeLayoutDoc = () => {
  app.openLayoutId = "";
  setLayoutSelection([]);
};

/** Copies a Layout and opens the copy, which is what you wanted it for.
 *
 *  The name gets a suffix rather than a counter: "Layout 1 Kopie 2" says which
 *  one it came from, where "Layout 4" does not. */
export async function duplicateLayoutDoc(id: string) {
  const layout = app.manifest.layouts.find((l) => l.id === id);
  if (!layout) return;
  const taken = new Set(app.manifest.layouts.map((l) => l.name));
  let name = `${layout.name} Copy`;
  for (let n = 2; taken.has(name); n++) name = `${layout.name} Copy ${n}`;

  await mutate(() => {
    const copy = duplicateLayout($state.snapshot(layout), name);
    app.manifest.layouts.push(copy);
    app.openLayoutId = copy.id;
    setLayoutSelection([]);
  });
}

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
  /* Typing the text already shown is not a rename. The input is prefilled
   * with layerLabel — the display label, which for an unnamed layer is a
   * fallback, not layer.name — so without the second check a cancelled rename
   * (Escape restores the label, blur still fires) wrote that fallback in as a
   * real name and burned an undo step on nothing. */
  if (next === (layer.name ?? "") || next === layerLabel(layer)) return;
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

export async function addLayoutImage() {
  const layout = openLayout();
  if (!layout) return;
  const path = await pickFile({ filters: [IMAGE_FILTER] });
  if (typeof path !== "string") return;
  await run("import", async () => {
    const asset = await importAsset(app.dir, path);
    await mutate(() => {
      const l = newImageLayer(asset);
      nameInStack(l, layout.layers);
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
    /* Left, like every other new caption. Centring here was right while a
     * caption's box was a whole tile wide — left-aligned text then started at
     * the tile's edge whatever x said — but the box hugs its own words now
     * (see textObject), so the anchor is already where the letters are. */
    nameInStack(l, layout.layers);
    layout.layers.push(l);
    selectLayoutLayer(l.id);
  });
}

export async function addLayoutShape(shape: ShapeKind) {
  const layout = openLayout();
  if (!layout) return;
  await mutate(() => {
    const l = newShapeLayer(shape);
    nameInStack(l, layout.layers);
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
  await mutate(
    () => {
      layer[key] = value;
    },
    true,
    // One run per field per layer: typing a caption is one step, and switching
    // to a different slider starts a new one.
    `field:${id}:${key}`,
  );
}

/** Writes a finished drag/scale/rotate back into a Layout's own layer. A plain
 *  move skips the rebuild — nothing inside one Layout is ever shared with
 *  itself, so there is no second instance left showing a stale position — but
 *  a scale must rebuild; see `scaled`. */
export async function applyLayoutTransform(
  layerId: string,
  patch: Pick<Layer, "x" | "y" | "rotation"> & Transform,
  /** Names the gesture, so a multi-selection's one write per member collapses
   *  into a single undo step instead of one per layer. */
  gesture?: string,
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
    resize(layer, patch);
  }, scaled(patch), gesture);
}

/** Ends the current undo run, so the next edit starts a new step. The one
 *  thing history cannot work out for itself: a run key says two edits are of
 *  the same kind, not that the user is still in the middle of making them.
 *  Called at every boundary — a finished canvas gesture here, and every form
 *  control's `change` event in App.svelte. */
export const endGesture = () => endRun(history);

/** Folds a canvas resize back into whatever field a layer keeps its size in.
 *
 *  `patch.scale` is the object's on-screen width as a fraction of the tile, so
 *  each kind has to undo its own way of turning a model value into that width
 *  — an image scales its picture, a caption its font size, a shape its box.
 *  Fabric's own scaleX is deliberately not stored: the scene is rebuilt from
 *  the model, so anything left in scaleX would be applied twice. */
/** What the canvas reports back after a transform: absolute sizes for layers
 *  whose size is measured off the object, raw factors for those whose size is
 *  written onto it. */
type Transform = { scale: number; scaleH: number; fx: number; fy: number };

function resize(layer: Layer, patch: Transform) {
  if (layer.kind === "image") {
    layer.scale = patch.scale;
  } else if (layer.kind === "shape") {
    /* Multiplied by what Fabric actually scaled, not set from the object's
     * measured width. A shape is built at exactly w×h with scaleX 1, so a
     * plain drag reports 1 and leaves the size alone — measuring instead made
     * a polygon shrink on every drag, since a regular n-gon's bounding box is
     * smaller than the box it is inscribed in. Both axes on their own: a shape
     * is the one kind that can be stretched. */
    layer.w *= patch.fx || 1;
    layer.h *= patch.fy || 1;
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
    // Counted in the list the group is spliced into, which no longer holds its
    // members — they moved inside it, and nameInStack walks in there anyway.
    nameInStack(group, kept);
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

/** Drops a Layout layer in front of another, optionally into a group.
 *
 *  `parentId` null means the top level. What the list's drag-and-drop calls;
 *  the ↑/↓ buttons stay for the keyboard and for precision. */
export async function dropLayoutLayer(id: string, parentId: string | null, beforeId: string | null) {
  const layout = openLayout();
  if (!layout) return;
  // Checked on a copy first, so a refused move — a group into itself — costs
  // neither an undo step nor a save.
  const trial = plain(layout.layers) as Layer[];
  if (!relocateLayer(trial, id, parentId, beforeId)) return;
  await mutate(() => {
    relocateLayer(layout.layers, id, parentId, beforeId);
    setLayoutSelection([id]);
  });
}

/** The same for a stamp on the wall, which has no nesting to worry about —
 *  only the order things are drawn in. Takes the list rather than an owner, so
 *  the project's wall picture and a tile's own stack are the same call. */
async function dropInto(layers: Layer[] | undefined, id: string, beforeId: string | null) {
  if (!layers) return;
  // Checked on a copy first, so a refused move costs neither an undo step nor
  // a save.
  const trial = plain(layers) as Layer[];
  if (!relocateLayer(trial, id, null, beforeId)) return;
  await mutate(() => {
    relocateLayer(layers, id, null, beforeId);
    app.selected = id;
  });
}

export const dropTileLayer = (tileId: string, id: string, beforeId: string | null) =>
  dropInto(app.manifest.tiles[tileId]?.layers, id, beforeId);

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

/** Renders `layout` and points a stamp at the result. */
async function stampAsset(layout: Layout): Promise<{ asset: string; seen: string }> {
  const seen = layoutFingerprint(layout);
  const bytes = await renderLayout(layout, app.deps!);
  return { asset: await saveGeneratedAsset(app.dir, bytes), seen };
}

/** Puts a layout into a tile's own layer stack. */
async function stampOnto(into: { layers: Layer[] } | undefined, layoutId: string) {
  const layout = app.manifest.layouts.find((l) => l.id === layoutId);
  if (!into || !layout || !app.deps) return;
  await run("stamp", async () => {
    const { asset, seen } = await stampAsset(layout);
    await mutate(() => {
      stampInto(into, layoutId, asset);
      // After the stamp, so a live caption sits on top of the picture it was
      // composed over rather than behind it.
      syncLiveLayers(into, layout);
      layout.stamped = seen;
    });
  });
}

/** Stamps a layout onto one portrait — the only way a layout reaches a tile
 *  now that groups no longer hold layers of their own. */
export const assignTileLayout = (tileId: string, layoutId: string) =>
  stampOnto(app.manifest.tiles[tileId], layoutId);

/** One tile's own layers — what the tile list shows under its row. */
export const tileLayers = (tileId: string) => app.manifest.tiles[tileId]?.layers ?? [];

/** The project owning this tile, if any — what the tile list shows as context,
 *  and what says whether a tile is still sitting in the inbox. */
export const tileProject = (tileId: string) => projectOf(app.manifest, tileId);

/** How many places hold a stamp of this Layout — what a refresh re-renders and
 *  what a delete leaves behind, so both are counted in the unit they act on. */
export const layoutUsage = (layoutId: string) => holdersUsingLayout(app.manifest, layoutId).length;

/** How many portraits carry it — the other half of the picture, and the one a
 *  wall of tiles reads first. Shown beside the group count rather than instead
 *  of it: the two answer different questions and neither implies the other. */
export const layoutTiles = (layoutId: string) => tilesUsingLayout(app.manifest, layoutId);

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
      // the Layout has to reach everywhere it is used, the same as the picture.
      for (const h of holdersUsingLayout(app.manifest, layoutId)) syncLiveLayers(h, layout);
      layout.stamped = seen;
      app.error = `${n} stamp(s) updated`;
    });
  });
}

/* --- Answering "the game rewrote this tile". Two answers, and only the user
 * has them: the same character with a new haircut, or a different character
 * who inherited the slot number. --- */

/** Records the file as it stands now and leaves everything else alone — the
 *  character is the same one, wearing something new. The layers were composed
 *  for them and stay. */
export async function keepCharacter(id: string) {
  await run("recheck", async () => {
    const prints = await loadFingerprints(app.dir);
    prints[id] = { original: app.hashes[id] ?? "" };
    await saveFingerprints(app.dir, prints);
    /* The vault copy goes too. It holds the face from before the restyle, and
     * loadOriginal prefers it over the game's own file — keeping it would mean
     * the editor went on showing the old haircut for good. */
    await dropVaultCopy(app.dir, id);
    forgetOriginal(id);
    app.changedTiles = app.changedTiles.filter((x) => x !== id);
    app.version++;
  });
}

/** Treats the id as a stranger: the layers on it were composed for a face that
 *  no longer exists, so they go, the tile returns to the inbox, and the vault
 *  copy of the old portrait is thrown away — it would otherwise keep being
 *  served as this slot's "original". */
export async function replaceCharacter(id: string) {
  await run("recheck", async () => {
    const prints = await loadFingerprints(app.dir);
    prints[id] = { original: app.hashes[id] ?? "" };
    await saveFingerprints(app.dir, prints);
    await dropVaultCopy(app.dir, id);
    forgetOriginal(id);
    await mutate(() => removeFromProjectToInbox(app.manifest, id, true));
    app.changedTiles = app.changedTiles.filter((x) => x !== id);
  });
}

/** Only a project can be written: the inbox is the tiles nobody has arranged
 *  yet, and writing it would push unfinished portraits into the game. */
export const canSaveToGame = () => !!openProject()?.order.length;

/** How many of this project's tiles could be put back — everything it owns,
 *  placed or shelved, since a tile written to the game keeps its vault copy
 *  whether or not it still has a slot. */
export const restorableCount = () => {
  const p = openProject();
  return p ? projectTiles(p).length : 0;
};

/** Writes the game's own portraits back over this project's tiles.
 *
 *  Touches the game folder and nothing else: every layer, layout and slot stays
 *  exactly as it is, so this is "show the originals in game again" rather than
 *  "throw the work away", and Write to game puts it all back. Nothing to undo
 *  either — the manifest never changed, which is why no checkpoint is taken. */
export async function restoreProject() {
  const p = openProject();
  if (!p) return;
  const ids = projectTiles(p);
  await run("restore", async () => {
    const n = await restoreTiles(app.dir, ids);
    app.error = n
      ? `${n} portrait(s) put back in the game`
      : "Nothing to put back — none of these were written";
    /* No rebuild, and no cache to drop: loadOriginal already prefers the vault
     * copy over the file in the game folder, and the vault copy is exactly what
     * was just written there. The editor's idea of each original is unchanged,
     * so the wall on screen is already right. */
  });
}

export async function saveToGame() {
  const project = openProject();
  if (!project) return;
  await run("save", async () => {
    if (!app.deps) throw new Error("no folder open");
    /* Snapshotted together: the id list positions the export window and keys
     * the result, so it has to be the same list the scene is built from. */
    const n = await saveTiles(
      app.dir,
      { ids: plain(project.order), gridLayers: plain(project.gridLayers) },
      plain(app.manifest),
      app.deps,
    );
    app.error = `${n} tiles written`;
  });
}
