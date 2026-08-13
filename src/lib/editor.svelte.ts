/* Editor state: opens a folder, holds a manifest, writes it back. */
import { open as pickFile } from "./platform";

import { saveTiles } from "./export";
import { coverScale, gridSize, mosaicBakeCrops } from "./geometry";
import {
  canRedo,
  canUndo,
  checkpoint,
  discard,
  emptyHistory,
  endRun,
  nextRedo,
  nextUndo,
  jump,
  timeline,
  redo,
  undo,
} from "./history";
import {
  bakeMosaicInto,
  clearBases,
  dissolveFolder,
  emptyManifest,
  clone,
  findLayer,
  findList,
  groupShift,
  inboxIds,
  archivedIds,
  setArchived,
  looseTiles,
  moveToProject,
  nameInStack,
  layerLabel,
  isGradient,
  nestingShift,
  newGroupLayer,
  newFolder,
  newImageLayer,
  newProject,
  newShapeLayer,
  newTextLayer,
  placeTile,
  projectOf,
  projectTiles,
  pruneToFolder,
  putInFolder,
  removeFromProjectToInbox,
  relocateLayer,
  restoreProjectInto,
  removeLayerFrom,
  resolveLayers,
  shiftLayer,
  stripTile,
  walkLayers,
  swapPlaced,
  takeOutOfFolder,
  unplaceTile,
  type ImageLayer,
  uncrop,
  type Inset,
  type Layer,
  type Manifest,
  type Project,
  type ShapeKind,
  type Paint,
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
  forgetAllOriginals,
  forgetOriginal,
  hashTiles,
  loadFingerprints,
  loadManifest,
  localStamp,
  pruneVault,
  vaultedIds,
  saveFingerprints,
  restoreTiles,
  saveGeneratedAsset,
  saveManifest,
  deleteSnapshot,
  listSnapshots,
  readSnapshot,
  writeSnapshot,
  snapshotKey,
  type SnapshotRef,
  tauriDeps,
} from "./project";
import { TILE_H } from "./bmp";
import { textWidth, type SceneDeps, type Tagged } from "./scene";

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
  /** Set when a change was written that deliberately asked for no rebuild.
   *
   *  The other half of the rule above, and it went missing for as long as the
   *  rule existed. A transform does not bump the version, so the wall's record
   *  of what it has drawn — the fingerprint the incremental redraw compares
   *  against — still describes the state before the drag. Undo then restores
   *  exactly that state, the comparison answers "nothing changed", and nothing
   *  is repainted: the model and the file hold the old position and the screen
   *  goes on showing the new one.
   *
   *  The canvas clears it when it has taken it into account. A boolean and not
   *  a count because there is nothing to count: what it says is "the drawing
   *  and the document parted company since the last build", and one is as
   *  parted as ten. */
  unprinted: false,
  /** Layer picked in the list or on the canvas, "" for none. */
  selected: "",
  /** Which tile that layer was picked on, "" for a wall-spanning one.
   *
   *  A layer id is not unique across the wall and never was: the v6→v7 fold
   *  copied every shared stack onto its tiles keeping the ids, and a design
   *  dissolved onto forty-four tiles keeps them too, on purpose — that shared id
   *  is what lets one edit reach the same layer on every selected tile. So "the
   *  selected layer" is a pair, and the id alone is a question with several
   *  right answers: whichever tile happened to be scanned first got the edit. */
  selectedTile: "",
  /** Layers picked *alongside* the one above, on the same tile — the extras of
   *  a multi-layer pick.
   *
   *  Kept beside `selected` rather than turning it into a list, which is what
   *  makes this a small thing: the panel, the bulk targets, the frame and the
   *  read-back all go on asking one question and getting one answer. Only a
   *  drag consults these, and only to hand them the same distance. */
  alsoSelected: [] as string[],
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
  /** Ids the vault holds an original for. Read on open and after anything that
   *  adds or drops a copy, because "Reset in game" is only true for these —
   *  offering it for a tile that was never written promises a restore that
   *  cannot happen. */
  vaulted: [] as string[],
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
  /** Snapshot names on disk, newest read wins. Kept in state because the list
   *  is a directory listing and nothing else would make the sidebar redraw
   *  when one is added. */
  snapshots: [] as SnapshotRef[],
  /** Every layer picked in the Layout's list. `layoutSelected` is the last of
   *  these — the one the canvas puts handles on — while grouping needs the
   *  whole set. */
  layoutSelection: [] as string[],
});

/** Everything between two ids, inclusive, in the order the list is in.
 *
 *  Either end missing — a shelved tile has no slot on the wall — means there
 *  is no range to take, so the click stands on its own. */
const tileRange = (ids: string[], from: string, to: string): string[] => {
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
  /* The tile the layer was picked on goes with it. It is that layer's address
     and nothing else reads it once there is no layer — but bulkTargets counts
     it as a target whatever the wall selection says, so a tile left behind
     here was still being written to after the wall it sits on had been left. */
  /* The tile the layer was picked on goes with it. It is that layer's address
     and nothing else reads it once there is no layer — but bulkTargets counts
     it as a target whatever the wall selection says, so a tile left behind
     here was still being written to after the wall it sits on had been left. */
  /* The tile the layer was picked on goes with it. It is that layer's address
     and nothing else reads it once there is no layer — but bulkTargets counts
     it as a target whatever the wall selection says, so a tile left behind
     here was still being written to after the wall it sits on had been left. */
  app.selectedTile = "";
  // With the primary gone the extras have nothing to travel with, and a drag
  // that picked up layers nobody can see picked is the worst of both.
  app.alsoSelected = [];
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

/** The changed-tile question, minus the ones put away.
 *
 *  Archiving is "not now", not "decide for me": the fingerprints are left
 *  exactly as they are, so bringing a tile back brings its question with it.
 *  What goes is the noise — a banner asking about portraits deliberately set
 *  aside is a banner nobody reads. */
export const changedHere = () => {
  const away = new Set(archived());
  return app.changedTiles.filter((id) => !away.has(id));
};

/** The tiles put away — see archivedIds. Their own wall, reached from its own
 *  card, so they are out of the way without being out of reach. */
export const archived = () => archivedIds(app.manifest, app.folderIds);

/** Whether the archive is the wall being shown. Not a project id, because it is
 *  not a project: a second value for `openProjectId` would have every reader of
 *  it asking "or is it the archive". */
export const onArchive = () => app.openProjectId === ARCHIVE;

/** The archive's stand-in id. Deliberately not a valid project id.
 *
 *  The NUL is written as an escape rather than typed into the file. A raw one
 *  in the source makes git call this whole file binary — no diff, no blame, and
 *  grep answering "Binary file matches" instead of a line number. Same string
 *  at runtime. */
export const ARCHIVE = "\u0000archive";

/** What the canvas and the export are pointed at. The inbox is a wall too: the
 *  unclaimed tiles, with no picture spread over them — and so is the archive. */
export function wall(): { ids: string[]; gridLayers: Layer[] } {
  if (onArchive()) return { ids: archived(), gridLayers: [] };
  const p = openProject();
  return p ? { ids: p.order, gridLayers: p.gridLayers } : { ids: inbox(), gridLayers: [] };
}

/** Puts the picked tiles away, or brings them back. Unclaimed tiles only —
 *  setArchived enforces that too, whatever a caller believes. */
export async function archiveSelection(away: boolean) {
  const ids = [...app.selectedTiles];
  if (!ids.length) return;
  await mutate("Archive tiles", () => {
    setArchived(app.manifest, ids, away);
    clearAll();
  });
  app.error = away ? `${ids.length} tile(s) archived` : `${ids.length} tile(s) back in Unsorted`;
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
  await mutate("Place tile", () => placeTile(p, tileId, beforeId));
}

/** Takes a tile off the grid without giving up the project. Its layers stay:
 *  only the slot is surrendered, and the tiles after it close the gap. */
export async function unplace(tileId: string) {
  const p = openProject();
  if (!p) return;
  await mutate("Take tile off the wall", () => unplaceTile(p, tileId));
}

/* --- Cosmetic folders. Drawers in the tile list, nothing more: dissolving one
 * leaves every tile on its slot with every layer still on it. --- */

export const folders = () => openProject()?.folders ?? [];

/** The visible tiles no drawer has taken, in grid order. */
export const looseIds = () => {
  const p = openProject();
  return p ? looseTiles(p, visibleIds()) : visibleIds();
};

export async function newFolderHere(name: string) {
  const p = openProject();
  if (!p) return;
  await mutate("New folder", () => {
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
  await mutate("Rename folder", () => (f.name = name.trim()), true, `folder:${folderId}`);
}

export async function removeFolder(folderId: string) {
  const p = openProject();
  if (!p) return;
  await mutate("Dissolve folder", () => dissolveFolder(p, folderId));
}

/** Puts a tile into a drawer, or back on the loose pile when `folderId` is "". */
export async function fileTile(tileId: string, folderId: string) {
  const p = openProject();
  if (!p) return;
  await mutate("File tile", () => (folderId ? putInFolder(p, folderId, tileId) : takeOutOfFolder(p, tileId)));
}

/** Files every picked tile into one group, in a single step.
 *
 *  One mutation, so one Ctrl+Z takes the whole armful back out — twenty
 *  separate calls would be twenty undo steps for one gesture. */
export async function fileSelectionInto(folderId: string) {
  const p = openProject();
  const moving = [...app.selectedTiles];
  if (!p || !moving.length) return;
  await mutate("File tiles", () => {
    for (const id of moving) putInFolder(p, folderId, id);
  });
}

/** Hands the picked tiles to another project. Their layers, wording and
 *  pictures go with them for free — those live under the tile id, which no
 *  project owns. */
export async function moveTilesToProject(projectId: string) {
  const moving = [...app.selectedTiles];
  if (!moving.length) return;
  await mutate("Move tiles to project", () => {
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
  await mutate("Release tiles to Unsorted", () => {
    for (const id of leaving) removeFromProjectToInbox(app.manifest, id, false);
    clearAll();
  });
}

/** How many of the picked tiles carry anything a strip would take. */
export const strippableCount = () =>
  app.selectedTiles.filter((id) => app.manifest.tiles[id]?.layers.length).length;

/** Takes every layer off the picked tiles — stamps, live captions and layers
 *  built by hand alike.
 *
 *  The inverse of assigning a layout, and deliberately blunter than one: a wall
 *  given the wrong design has forty-four tiles to undress, and doing it a layer
 *  at a time is the trip this exists to save.
 *
 *  `base` stays. A baked mosaic is not a layer — it is what the portrait *is*
 *  after Apply — and "Restore portraits" is the button that owns undoing it.
 *  Wording and per-tile pictures go, because both are keyed by layer id and
 *  would otherwise sit there orphaned, ready to reappear under a later stamp
 *  that happened to reuse the id.
 *
 *  One mutation, so one Ctrl+Z dresses the whole wall again. */
export async function stripSelectedTiles() {
  const stripping = app.selectedTiles.filter((id) => app.manifest.tiles[id]?.layers.length);
  if (!stripping.length) return;
  await mutate("Clear layers", () => {
    for (const id of stripping) stripTile(app.manifest.tiles[id]);
    /* Said out loud, and saying what actually went. Undressing a wall used to
     * happen in complete silence next to actions that report their count, and
     * the wording and per-tile pictures it also takes are keyed by layer id —
     * so "layers" undersells it to exactly the person who typed them. */
    app.error = `Cleared ${stripping.length} tile(s) — layers, wording and per-tile pictures`;
  });
}

export async function newProjectFrom(name: string) {
  const free = inboxIds(app.manifest, app.selectedTiles);
  await mutate("New project", () => {
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
  drawnOn(tileId).filter((l): l is ImageLayer => l.kind === "image");

/** The class icons on one tile — which is the whole point of a wall of
 *  characters. */
export const tileIcons = (tileId: string): ShapeLayer[] =>
  drawnOn(tileId).filter(
    (l): l is ShapeLayer => l.kind === "shape" && l.shape === "icon",
  );

/** What one tile says, for the row that lists it collapsed.
 *
 *  This tile's own wording only, never the Layout's default. The default is
 *  shared by every tile wearing that Layout, so a headline taken from it is
 *  forty-four rows all reading "Text" — the exact column of identical strings
 *  the id used to be. Same distinction the wording field already draws by
 *  showing the default as a placeholder rather than a value: a tile that has
 *  not been named says nothing, and gets its id back as a headline.
 *
 *  The first caption that carries something, because a Layout can hold several
 *  and the name is the one at the top. */
export const tileHeadline = (tileId: string): string => {
  for (const caption of tileCaptions(tileId)) {
    /* The caption's own words. It used to ask the tile's wording record, which
       was where a Layout's shared caption kept each portrait's name — the
       migration empties that record and the words are on the layer, so the
       headline had quietly stopped finding any and every row fell back to its
       id. */
    const own = caption.text.trim();
    /* "{{id}}" is the placeholder every tile shares, so it names none of them:
       the row prints the id on its second line already, and echoing it here
       would show the same number twice. */
    if (own && own !== "{{id}}") return own;
  }
  return "";
};

/** The live shapes on one tile that are not class icons — the rectangles,
 *  ellipses and polygons a Layout keeps live.
 *
 *  They have no per-tile *content*, which is why they had no row here and no
 *  way into the placing tool: the block of a badge could be moved by nothing
 *  and coloured by nothing while the icon cutting it could be moved. They own a
 *  colour now, and the row that carries it carries the place button too. */
export const tileShapes = (tileId: string): ShapeLayer[] =>
  drawnOn(tileId).filter((l): l is ShapeLayer => l.kind === "shape" && l.shape !== "icon");

/** Every flat colour a shape wears somewhere on this wall, newest layer last —
 *  what the swatches offer, so the second tile is a click rather than a trip
 *  through the picker.
 *
 *  Read off the shapes themselves rather than out of a per-tile record: the
 *  record was where a tile's departure from its Layout was written down, and a
 *  layer holds its own colour now. Same list either way, from the place that
 *  still has an answer.
 *
 *  Flat colours only: a gradient has no swatch that would tell you what it is,
 *  and picking one out of a row of squares that all look like a smear is not a
 *  choice anybody can make. The layer's own is always first. */
export const tilePaintChoices = (tileId: string, layerId: string): string[] => {
  const layer = tileShapes(tileId).find((l) => l.id === layerId);
  const seen = new Set<string>();
  if (layer && !isGradient(layer.fill)) seen.add(layer.fill);
  for (const id of app.folderIds)
    for (const l of tileShapes(id)) if (!isGradient(l.fill)) seen.add(l.fill);
  return [...seen];
};

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
  /* The same picture on the same layer of every other tile — read off those
   * layers now, where it used to be read out of each tile's swap record. A
   * dissolved design puts the same layer id on every tile it dressed, so the
   * gallery is the same list it always was. */
  for (const id of Object.keys(app.manifest.tiles)) {
    const l = tileImages(id).find((x) => x.id === layerId);
    if (l?.asset) seen.add(l.asset);
  }
  return [...seen];
}

/** Imports a picture and gives it to this one tile. */
export async function pickTileImage(tileId: string, layerId: string) {
  const path = await pickFile({ filters: [IMAGE_FILTER] });
  if (typeof path !== "string") return;
  await run("import", async () => {
    const asset = await importAsset(app.dir, path);
    await setTileLayerField([tileId], layerId, "asset", asset);
  });
}

export async function renameProject(projectId: string, name: string) {
  const p = app.manifest.projects.find((x) => x.id === projectId);
  if (!p || !name.trim() || p.name === name.trim()) return;
  await mutate("Rename project", () => (p.name = name.trim()), true, `rename:${projectId}`);
}

/** Deletes a project. `stripLayers` also undresses every tile it owned — the
 *  caller asks, because only the user knows whether the artwork was for these
 *  characters or for the wall that is going. Either way the tiles return to the
 *  inbox, and one Ctrl+Z brings project and layers back together. */
export async function deleteProject(projectId: string, stripLayers = false) {
  await mutate("Delete project", () => {
    const at = app.manifest.projects.findIndex((p) => p.id === projectId);
    if (at < 0) return;
    const owned = projectTiles(app.manifest.projects[at]);
    app.manifest.projects.splice(at, 1);
    if (stripLayers)
      for (const id of owned) {
        const tile = app.manifest.tiles[id];
        if (tile) stripTile(tile);
      }
    if (app.openProjectId === projectId) {
      app.openProjectId = "";
      closedByDelete = projectId;
    }
    clearAll();
  });
}

/** Swaps two placed tiles on the open project's grid. Only makes sense on a
 *  project: the inbox is a heap in folder order, not an arrangement. */
export async function swapTilePlaces(a: string, b: string) {
  const p = openProject();
  if (!p) return;
  await mutate("Swap tiles", () => swapPlaced(p, a, b));
}

/* Reactive so the toolbar can grey the buttons out. Exported so a test can
 * assert how many steps an action cost — the difference between "typing a
 * word is one undo" and "one per letter" is invisible from the outside
 * otherwise. */
export const history = $state(emptyHistory<Manifest>());
export const undoable = () => canUndo(history);
export const redoable = () => canRedo(history);

/** What the next press would take back, or put back. For the buttons, so they
 *  can say it before they are pressed rather than after. */
export const undoLabel = () => nextUndo(history);
export const redoLabel = () => nextRedo(history);

/** Every edit still remembered, newest first — what the History list draws.
 *  Reads `app.version` so the list redraws with the rest of the app: the
 *  stacks are mutated in place, and a reader that watched only them would sit
 *  on a stale render until something else happened to invalidate it. */
export const historySteps = () => (app.version, timeline(history));

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
async function mutate(label: string, fn: () => void, structural = true, run?: string) {
  /* Cleared here rather than left to time out: the status line has one slot,
   * and a note from three actions ago ("12 tile(s) written") sat there hiding
   * the live selection count and its "clear" link until something
   * else happened to overwrite it. Anything a mutation wants to say sets it
   * inside fn, after this. */
  app.error = "";
  const before = plain(app.manifest);
  const pushed = checkpoint(history, before, label, run);
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
    /* Only what this call put there. Inside an open run — a slider being
       dragged, a caption being typed — the checkpoint above pushed nothing,
       and undoing regardless popped the step belonging to the edit before it:
       one unrelated undo destroyed, silently, by a failure somewhere else.

       Discarded rather than undone: nothing changed, so there is nothing to
       put back, and undo would have left the failed edit sitting on the redo
       stack under its own name. */
    if (pushed) discard(history);
    return;
  }
  if (structural) app.version++;
  else app.unprinted = true;
  await persist();
}

const layerExists = (id: string) => !!id && !!listOf(id);

/** Undo and redo replace the whole manifest, so the scene always rebuilds.
 *
 *  The chosen layer is kept when the state landed in still has it. Dropping it
 *  unconditionally looked harmless but was not: assigning tiles needs a chosen
 *  layer to find the overlay through, so one undo left the assign action doing
 *  nothing at all, silently. */
/** The wall a delete closed, so undoing the delete can open it again.
 *
 *  Which wall you are looking at is view state and deliberately outside the
 *  document — but deleting a project has to close it, and Ctrl+Z then put the
 *  project back while leaving you standing in Unsorted. It read as an undo that
 *  had not worked. */
let closedByDelete = "";

async function travel(step: typeof undo<Manifest>, how: "Undone" | "Redone") {
  const there = step(history, plain(app.manifest));
  if (!there) return;
  const chosen = app.selected;
  app.manifest = there.state;
  app.selected = layerExists(chosen) ? chosen : "";
  if (closedByDelete && there.state.projects.some((p) => p.id === closedByDelete)) {
    app.openProjectId = closedByDelete;
    closedByDelete = "";
  }
  /* A wall the state travelled to does not have leaves nowhere to stand. Undo
     of "Project from selection", or redo of a delete, left `openProjectId`
     naming a project the document no longer holds: the canvas fell back to
     Unsorted while the sidebar highlighted nothing, the wall menu lost the two
     entries that wall exists for and offered two that silently did nothing,
     and the Snapshots list came up empty. The only way out was to notice that
     "Unsorted" — which did not look chosen — was the way back. */
  if (
    app.openProjectId &&
    app.openProjectId !== ARCHIVE &&
    !there.state.projects.some((p) => p.id === app.openProjectId)
  )
    app.openProjectId = "";
  app.version++;
  /* Said out loud, because Ctrl+Z is the one action with no target: every other
   * edit tells you what it touched by touching it, and this one can reach
   * anywhere on the wall. Before persist, so a failed save still gets the last
   * word. */
  app.error = `${how}: ${there.label}`;
  await persist();
}

export const undoEdit = () => travel(undo, "Undone");
export const redoEdit = () => travel(redo, "Redone");

/** Goes to a named step in one move — what clicking a row of the History list
 *  does. `delta` is the row's own: negative back, positive forward.
 *
 *  Shares travel's body rather than looping over undoEdit, so eight steps back
 *  redraw the wall once and write the file once instead of eight times. */
export const jumpEdit = (delta: number) =>
  travel((h, present) => jump(h, present, delta), delta < 0 ? "Undone" : "Redone");

/** The array a layer lives in: the open project's wall-spanning layers, or
 *  whichever tile's own stack holds it.
 *
 *  Both, because those are the only two places a layer can be — deleting or
 *  hiding one and finding nothing used to silently do nothing at all. */
const listOf = (id: string, tileId = app.selectedTile): Layer[] | undefined => {
  /* The named tile first. An id is unique within a tile and not across the
   * wall, so the scan below answers "some tile holding a layer by this name" —
   * fine while every such layer was a locked copy of one design, wrong the
   * moment two tiles carry the same id and either may be edited. Callers that
   * know the tile say so; the scan stays for the ones that cannot. */
  const own = tileId ? app.manifest.tiles[tileId]?.layers : undefined;
  if (own && findLayer(own, id)) return own;
  const grid = openProject()?.gridLayers;
  if (grid && findLayer(grid, id)) return grid;
  return Object.values(app.manifest.tiles).find((t) => !!findLayer(t.layers, id))?.layers;
};

/** Picks a layer, and the tile it was picked on — "" for a wall-spanning one.
 *
 *  Both together, always: leaving the tile behind from a previous pick is how
 *  an edit lands on the layer of that name on the wrong portrait. */
export function selectLayer(id: string, tileId = "") {
  /* Only when the pair actually changes. A plain pick is a fresh start and
     drops the extras of the last one — but the canvas writes the current pick
     back on every selection event, including the one Fabric fires as a drag
     begins, and that was clearing the extras a moment before they were due to
     travel. */
  if (app.selected === id && app.selectedTile === tileId) return;
  app.selected = id;
  app.selectedTile = tileId;
  if (app.alsoSelected.length) app.alsoSelected = [];
}

/** Adds a layer to the pick, or takes it out again — Ctrl-click on its row.
 *
 *  Only within one tile, and only beside a layer that is already picked: the
 *  extras are moved by handing them the distance the picked one travelled, and
 *  a distance measured on one tile means nothing on another.
 *
 *  Picking the primary itself is how the pick shrinks back to one layer: the
 *  first extra takes its place, so Ctrl-clicking down a list and then back up
 *  it leaves what you started with. */
export function alsoSelect(id: string, tileId: string) {
  if (!app.selected || tileId !== app.selectedTile) return selectLayer(id, tileId);
  if (id === app.selected) {
    const [next, ...rest] = app.alsoSelected;
    if (!next) return;
    app.selected = next;
    app.alsoSelected = rest;
    return;
  }
  app.alsoSelected = app.alsoSelected.includes(id)
    ? app.alsoSelected.filter((x) => x !== id)
    : [...app.alsoSelected, id];
}

/** Every layer the pick covers on its tile, primary first. */
export const pickedLayers = () => [app.selected, ...app.alsoSelected].filter(Boolean);

/** Wraps the picked layers of one tile in a group.
 *
 *  The group is made at the centre of the tile, where `groupShift` is nought,
 *  so the members keep the coordinates they already had and nothing moves on
 *  the way in. Dragging the group afterwards is what displaces them, all by
 *  the same amount — which is the whole of what a group is here: a
 *  displacement, a shared fade and a shared lock.
 *
 *  Top level only. A layer already inside another group would have to be
 *  hoisted out first, and "group these two" is not the gesture that should
 *  quietly restructure a tree. */
export async function groupPicked() {
  const tile = app.selectedTile;
  const list = app.manifest.tiles[tile]?.layers;
  if (!list) return;
  const at = pickedLayers()
    .map((id) => list.findIndex((l) => l.id === id))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  if (at.length < 2) return;
  await mutate("Group layers", () => {
    // Taken from the top down, so the indices below each removal still hold;
    // put back in stack order, so the group draws what the tile drew.
    const taken = [...at].reverse().map((i) => list.splice(i, 1)[0]).reverse();
    const group = newGroupLayer(taken);
    nameInStack(group, list);
    list.splice(at[0], 0, group);
    app.alsoSelected = [];
    app.selected = group.id;
  });
}

/** The group holding this layer on its tile, if one does — what decides
 *  whether "Take out of group" is offered on its row. */
export const groupHolding = (id: string, tileId = app.selectedTile): Layer | undefined =>
  [...walkLayers(app.manifest.tiles[tileId]?.layers ?? [])].find(
    (l) => l.kind === "group" && l.children.some((c) => c.id === id),
  );

/** Takes one layer out of its group and leaves it on the tile.
 *
 *  `relocateLayer` is the whole of it: it swaps the group's displacement for
 *  the top level's, so the layer stays exactly where it was drawn — crossing
 *  that boundary without the swap is how a layer jumps by the group's offset.
 *
 *  It lands immediately after the group in the stack rather than on top of
 *  everything, so leaving a group is not also a change of what covers what. */
export async function takeOutOfGroup(id: string, tileId = app.selectedTile) {
  const list = app.manifest.tiles[tileId]?.layers;
  const group = groupHolding(id, tileId);
  if (!list || !group) return;
  const at = list.findIndex((l) => l.id === group.id);
  const beforeId = at >= 0 ? (list[at + 1]?.id ?? null) : null;
  await mutate("Take out of group", () => {
    relocateLayer(list, id, null, beforeId);
  });
}

/** Dissolves a group, leaving its members where they were drawn.
 *
 *  `removeLayerFrom` is the whole of it: a group hands its members back to the
 *  list at its own index with the displacement folded into them, because
 *  losing a stack of layers to one misplaced click was never a trade worth
 *  offering. Deleting a group does the same thing — this one only says so. */
export async function ungroupLayer(id: string, tileId = app.selectedTile) {
  const list = app.manifest.tiles[tileId]?.layers;
  if (!list || list.find((l) => l.id === id)?.kind !== "group") return;
  await mutate("Ungroup layers", () => {
    removeLayerFrom(list, id);
    if (app.selected === id) app.selected = "";
  });
}

/** Hides or shows a layer — and, for a stamp, the whole assignment.
 *
 *  The eye on a stamp's row switches off the flattened sheet and the captions
 *  and logos the Layout keeps live beside it: they have no row of their own, so
 *  "Hide" would otherwise appear to do nothing on exactly the layouts that
 *  carry something editable in the grid.
 *
 *  It writes only this layer. The copies are not told — `layerShows` asks the
 *  stamp on their behalf. Writing it onto them is what this used to do, and
 *  `syncLiveLayers` rebuilds a copy from the Layout on every "Update stamps":
 *  the flag was overwritten and a hidden design came back, in the wall and in
 *  the file written to the game, with this row still saying "hidden". */
export async function toggleLayerHidden(id: string, tileId = app.selectedTile) {
  // Through the tree, the way the lock beside it already did: a group's
  // members have rows of their own, and a plain find on the tile's stack
  // answers undefined for every one of them.
  const self = anyLayer(id, tileId);
  if (!self) return;
  const next = !self.hidden;
  // Named after what it does, not after the control: "Undone: toggle layer"
  // makes you work out which way it went.
  await mutate(next ? "Hide layer" : "Show layer", () => {
    self.hidden = next;
  });
}

/** Deletes a layer on the wall.
 *
 *  A group dissolves and hands its members back rather than taking them with
 *  it — see removeLayerFrom, which is where that rule lives. */
export async function deleteLayer(id: string, tileId = app.selectedTile) {
  const list = listOf(id, tileId);
  const layer = list && findLayer(list, id);
  if (!list || !layer) return;
  await mutate("Delete layer", () => {
    removeLayerFrom(list, id);
    if (app.selected === id) app.selected = "";
  });
}

/** The tiles on screen, in grid order. One funnel: the canvas hit-tests
 *  through it, the band selection sorts through it, the export keys through
 *  it — the index into this list *is* the grid coordinate. */
export const visibleIds = () => wall().ids;

/** Runs one named piece of work, and says whether it got through.
 *
 *  The answer is there for callers that must not carry on after a failure —
 *  writing to the game folder once its safety snapshot did not go up, above
 *  all. Without it the failure was worse than invisible: the next `run` clears
 *  `app.error` as its first act, so the message was gone before anyone read
 *  it, and the write went ahead regardless. */
/** How many of these are in flight. Counted rather than flagged: saveToGame
 *  runs takeSnapshot inside itself, and the inner one's `finally` used to
 *  declare the app idle while the outer one was still writing to the game's own
 *  folder — every button came back to life, and a second write could start into
 *  the files the first was still copying. */
let running = 0;

async function run(label: string, fn: () => Promise<void>): Promise<boolean> {
  running++;
  app.busy = label;
  app.error = "";
  try {
    await fn();
    return true;
  } catch (e) {
    app.error = String(e);
    return false;
  } finally {
    if (--running === 0) app.busy = "";
  }
}

/** Every manifest write goes through here, which makes it the one place a
 *  failed write has to be reported. applyTransform is called from a canvas
 *  event handler with no await behind it, so a rejection raised further down
 *  would be an unhandled promise rejection: the model would hold changes that
 *  never reached disk, with nothing on screen saying so. */
async function persist(): Promise<boolean> {
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
    /* Everything the view has to forget, before the slow part rather than after
     * it. Opening a folder starts on the overview — with several accounts
     * sharing one there is no single "the" wall to open, and a new character
     * has to be visible somewhere the moment it appears. But hashing sixty
     * portraits takes seconds, and a click landing in that window was undone by
     * the load finishing: the wall opened and snapped back to Unsorted. What is
     * true the instant a folder is asked for belongs where it is known, not at
     * the end of the queue. */
    clearAll();
    app.openProjectId = "";
    /* Bumped with the wall it changes. Which tiles are on screen comes from
       the open project, so clearing it silently swaps the wall's coordinate
       system — and nothing redrew, because only a version bump asks for that.
       For the seconds below, the canvas went on showing the project's cells
       while every index was read off the inbox's list: a drag in that window
       wrote a position whole cell-widths out, and a tile the inbox does not
       list resolved to index -1, which is a cell above and left of the wall.
       openProjectView has bumped it for the same reason since the day it was
       written; this was the one place that changed the wall without saying so. */
    app.version++;
    /* Re-opening is the one moment the files behind the ids may all have been
     * replaced from outside — a restore, a folder copied in by hand, the game
     * regenerating a portrait. loadOriginal caches on the opposite promise, so
     * without this the wall comes back drawn from the last session's pixels. */
    forgetAllOriginals();
    const ids = await listTiles(app.dir);
    // Before anything reads an original: a vault copy for an id the folder no
    // longer has is either dead weight or, if BDO reuses the number, the wrong
    // picture served as that tile's pristine state.
    const heldBack = await pruneVault(app.dir, ids);
    app.vaulted = await vaultedIds(app.dir);
    /* A character deleted in the game takes its tile out of the document with
     * it — layers, wording and per-tile pictures included — and the undo
     * history is cleared a few lines further down, so there is no way back from
     * inside the app. loadManifest puts the document aside first and says what
     * went; the message below is the only thing standing between that and work
     * disappearing without a word. */
    const { manifest, lost, snapshot, broken, migrated } = await loadManifest(app.dir, ids);
    app.manifest = manifest;
    /* Emptied with the document it belongs to, not before it. Cleared up
       front, an edit made during those seconds pushed a checkpoint holding the
       *previous* folder's document — and one Ctrl+Z after the load then put
       that whole document back over the freshly read one, undoing the prune,
       the migration and every character the game had deleted, and saving it. */
    /* Emptied with the document it belongs to, not before it. Cleared up front,
       an edit made during the seconds this load takes pushed a checkpoint
       holding the *previous* folder's document — and one Ctrl+Z afterwards put
       the whole of it back over the freshly read one and saved it: the prune
       undone, the migration undone, tiles restored for characters the game has
       deleted. A step pushed after this line describes the document that is
       actually open, which is the one thing undo is allowed to reach.
       ponytail: not pinned by a test — the browser suite's filesystem answers
       within one macrotask, so the window this closes cannot be opened there. */
    history.past.length = 0;
    history.future.length = 0;
    history.runKey = undefined;
    /* Layers naming a layout the library no longer has: manifests from before
     * the delete cascaded, or a snapshot that brought stamps back after their
     * layout was deleted. Swept on open, same philosophy as pruneVault — the
     * library is the truth and the wall adapts. Persisted only when something
     * actually went, so a clean open writes nothing. */
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
    const { prints, broken: lostPrints } = await loadFingerprints(app.dir);
    const { fresh, changed } = classify(prints, hashes);
    for (const id of fresh) prints[id] = { original: hashes[id] };
    /* Against the folder's own list, not against the hashes. A portrait the
     * game had open when we started reads as no hash at all — hashTiles leaves
     * it out on purpose, because a file being written is not a file that
     * changed — and pruning on that deleted the record of a tile that is
     * sitting right there. What goes with it is the original hash: next open
     * the tile reads as new, whatever bytes happen to be there become its
     * "original", and the question the game's own overwrite is meant to raise
     * can never be asked again. */
    const inFolder = new Set(ids);
    const strays = Object.keys(prints).filter((id) => !inFolder.has(id));
    /* Held to the same rule as the vault four lines up, and for the same
       reason: this file is the app's memory of what the game did, everything
       downstream of it is destructive, and a listing that came back short
       would otherwise erase most of it in one open. The two used to disagree —
       one refused an empty listing and the other pruned against it regardless,
       in the same function. */
    if (strays.length <= Object.keys(prints).length / 2)
      for (const id of strays) delete prints[id];
    await saveFingerprints(app.dir, prints);
    app.newTiles = fresh;
    app.changedTiles = changed;
    app.hashes = hashes;
    await refreshSnapshots();

    app.deps = tauriDeps(app.dir);
    app.version++;
    /* Last, so nothing after it clears the line — and all of them, not the
       first that happens to be true. They come from different files and any
       two can be true at once: a bad shutdown damages the manifest and the
       fingerprints together, and the chain of `else if` this used to be then
       reported the change-detection reset and said nothing at all about the
       document having been set aside and started empty. */
    const said: string[] = [];
    if (lost.length)
      said.push(
        `${lost.length} tile(s) are no longer in the folder — their layers went with them. ` +
          `Put the portraits back and reopen, then restore "${snapshot}".`,
      );
    /* The folder came back missing most of what the vault holds, which is far
       more likely to be a folder that has not finished appearing than forty
       characters deleted at once. Nothing was thrown away; said out loud
       because a vault that stops matching the wall is otherwise noticed only
       when someone reaches for "Reset in game" and it is not there. */
    if (heldBack)
      said.push(
        `${heldBack} original(s) in the vault have no portrait in the folder. ` +
          `They were kept — check the folder is complete before writing to the game.`,
      );
    /* Worth saying even though nothing is broken on screen: the answer to "did
     * the game put a different character behind this slot" has just been reset
     * to "everything is new", and the next write to the game vaults nothing for
     * a slot that changed hands. The user is the only one who can notice. */
    if (lostPrints)
      said.push(
        `Change detection was reset — ${lostPrints} could not be read and was set aside. ` +
          `Check any portrait the game may have replaced before writing to the game.`,
      );
    if (broken)
      said.push(
        `manifest.json could not be read and was set aside as "${broken}". ` +
          `This folder starts empty — the old file is still in FaceTexture.tessera.`,
      );
    /* Said once, on the open that does it. A stamped design has just become
     * ordinary layers on every tile that wore it: the same picture, now
     * editable where it is shown, and layouts are gone. That is a change worth
     * hearing about before the first edit writes the new shape — together with
     * where the old file is, which is the only way back. */
    if (migrated)
      said.push(
        `Layouts are gone: every stamp is now editable layers on the tile itself. ` +
          `The version ${migrated.from} document was copied to "${migrated.backup}" first.`,
      );
    if (said.length) app.error = said.join(" · ");
  });
}

/* SVG is here for the same reason the blob in project.ts spells its type out:
 * a class icon arrives as one, and the render path is an image element behind
 * an object URL, which draws it without a decoder of our own. An SVG with no
 * width/height on its root tag has no intrinsic size and lands at the browser's
 * 300x150 — scalable from there, but not the size the file meant. */
const IMAGE_FILTER = { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "svg"] };

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
    await mutate("Add wall picture", () => {
      const layer = newImageLayer(asset);
      nameInStack(layer, project.gridLayers);
      layer.space = "grid";
      layer.scale = 1;
      project.gridLayers.push(layer);
      // Selected straight away, like every other insert: "Apply" acts on
      // the chosen layer, and leaving it unchosen meant the button stayed grey
      // until you went hunting for the thing you had just added.
      app.selected = layer.id;
    });
  });
}

/** What the canvas reports back after a transform: absolute sizes for layers
 *  whose size is measured off the object, raw factors for those whose size is
 *  written onto it. */
type Transform = {
  scale: number;
  scaleH: number;
  fx: number;
  fy: number;
  /** Only a caption has one, and only once a height handle was dragged. */
  boxH?: number;
  /** Only a picture has one, and only once its side handles were used. */
  crop?: Inset;
  /** Set by the wall's stand-in, and only by it: `scale`/`scaleH` are the size
   *  the layer should end up, not a factor to apply to the size it has.
   *
   *  A shape's size is otherwise multiplied by what Fabric scaled, which is
   *  right for the object that *is* the layer — Fabric resets its scale on the
   *  next rebuild, so each gesture contributes its factor once. The stand-in is
   *  not rebuilt on that clock: it keeps the scale of the gesture that just
   *  ended, so the next write applies that factor a second time and the one
   *  after it a third. Seen as a frame that grew once and a shape that grew
   *  again every time it was touched. */
  absolute?: boolean;
};

/** Smallest a gesture may leave a layer: a hundredth of a tile, about six
 *  pixels across a portrait.
 *
 *  Zero is a one-way door. A shape's size is *multiplied* by what Fabric
 *  scaled, so once w or h reaches nought no gesture can bring it back —
 *  anything times zero is zero — and a picture at scale 0 has no box left to
 *  grab. Reached in ordinary use: dragging a corner handle past the opposite
 *  corner, which the stand-in makes easy because it is transparent and there
 *  is nothing to see going. The layer vanishes off the wall with its row still
 *  in the list, and nothing but undo puts it back. */
const MIN_SPAN = 0.01;

function resize(layer: Layer, patch: Transform) {
  if (layer.kind === "image") {
    layer.scale = Math.max(patch.scale, MIN_SPAN);
    /* `scale` measures what the crop leaves, so the two travel together: a
     * side handle changes both, and storing one without the other would put
     * the picture back at the wrong size on the next rebuild. */
    if (patch.crop) layer.crop = patch.crop;
    else delete layer.crop;
  } else if (layer.kind === "text") {
    /* Two gestures, told apart by what Fabric did with them. A side handle on a
     * Textbox changes `width` and leaves scaleX at 1; a corner scales the whole
     * object and leaves the width alone. So a factor of one means the width is
     * the news, and anything else means the letters are.
     *
     * The corner takes the box with it, or scaling a caption up would keep the
     * old wrap width and break the line in a place nobody asked for. */
    const dragged = Math.abs(patch.fx - 1) < 0.001;
    /* A corner still says nothing a caption can store: the font size is a
     * field and only a field, so a corner scale is ignored here exactly as it
     * always was. Only the side handles have somewhere to land now.
     *
     * And only once the width is actually what moved: a plain drag reports the
     * box's current width, and writing that back would quietly pin a caption
     * that was still hugging its words while the user only moved it. "Once you
     * touch it" has to mean the handle, not the layer. */
    if (dragged && (layer.w !== undefined || Math.abs(patch.scale - textWidth(layer)) > 0.002)) {
      layer.w = Math.max(patch.scale, MIN_SPAN);
    }
    // Only ever present when a top or bottom handle was actually dragged.
    if (patch.boxH !== undefined) layer.h = Math.max(patch.boxH / TILE_H, MIN_SPAN);
  } else if (layer.kind === "shape") {
    /* Multiplied by what Fabric actually scaled, not set from the object's
     * measured width. A shape is built at exactly w×h with scaleX 1, so a
     * plain drag reports 1 and leaves the size alone — measuring instead made
     * a polygon shrink on every drag, since a regular n-gon's bounding box is
     * smaller than the box it is inscribed in. Both axes on their own: a shape
     * is the one kind that can be stretched. */
    layer.w = Math.max(patch.absolute ? patch.scale : layer.w * (patch.fx || 1), MIN_SPAN);
    layer.h = Math.max(patch.absolute ? patch.scaleH : layer.h * (patch.fy || 1), MIN_SPAN);
  }
}
/** The extras of a multi-layer pick, as live layers — the ones a drag on the
 *  picked layer has to take along.
 *
 *  Only when the object being dragged *is* the picked layer, and only on its
 *  own tile. A drag on something else is not the pick moving, and a distance
 *  measured on one tile means nothing on another. */
const travellers = (obj: Tagged): Layer[] => {
  if (!app.alsoSelected.length || obj.layerId !== app.selected || obj.tileId !== app.selectedTile)
    return [];
  const list = app.manifest.tiles[obj.tileId]?.layers ?? [];
  return app.alsoSelected.map((id) => findLayer(list, id)).filter((l): l is Layer => !!l);
};

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
  /** Overrides the rule below, and the wall's stand-in is why it exists. The
   *  rule reads "the canvas already shows the result", which holds only while
   *  the object the hand moved is the layer. Dragging the stand-in moves a
   *  transparent rectangle; the layer it stands for is a different object, and
   *  nothing redraws that without a rebuild. */
  structural?: boolean,
) {
  /* The object's own tile decides, not a scan of the wall. Every canvas object
   * carries the tile it was built for, so the one thing that cannot be
   * ambiguous here is which stack to write to — and a scan that happened to
   * find the same id on an earlier tile wrote the drag onto that portrait
   * instead, leaving the one under the pointer untouched. */
  const list = obj.tileId
    ? (app.manifest.tiles[obj.tileId]?.layers ?? [])
    : (listOf(obj.layerId, "") ?? []);
  const layer = findLayer(list, obj.layerId);
  if (!layer) return;
  /* A layer inside a group renders at its own position plus every enclosing
   * group's displacement, so the position read off the canvas has that folded
   * in — subtract it again, exactly as the Layout path does, or the layer jumps
   * by the group's offset on the first drag. Groups reach tiles now. */
  const shift = nestingShift(list, obj.layerId) ?? { dx: 0, dy: 0 };
  /* The extras of a multi-layer pick travel the same distance, not to the same
     place — measured before the write, because after it the layer no longer
     remembers where it started. Only a move is handed on: a scale would have to
     be about a shared centre, which is a different sum and a different feature.
     Inside the one mutate, so the whole thing is one undo step. */
  const along = travellers(obj);
  const step = { dx: patch.x - shift.dx - layer.x, dy: patch.y - shift.dy - layer.y };
  await mutate("Move layer", () => {
    layer.x = patch.x - shift.dx;
    layer.y = patch.y - shift.dy;
    layer.rotation = patch.rotation;
    resize(layer, patch);
    for (const l of along) {
      l.x += step.dx;
      l.y += step.dy;
    }
    /* The extras count as a rebuild too — the fourth shape of the same fault.
       "The canvas already shows the result" is true of the object under the
       pointer and false of every layer carried along with it: those are other
       Fabric objects that no hand touched. Without this the model moved them
       and the wall did not, until something unrelated bumped the document. */
  }, structural ?? (scaled(patch) || along.length > 0));
  /* After the write, not before: the outline answers "where would this land"
   * and a plain drag does not bump `version`, so nothing else would recompute
   * it. Cheap — the picture is already decoded and cached. */
  void refreshCoverPreview();
}

/** Moves a layer by a fraction of a tile — the write behind dragging a baked
 *  layer, whose position cannot be read off the canvas but whose displacement
 *  can. See the note in GridCanvas's object:modified for why the two differ.
 *
 *  Structural, unlike an ordinary drag: the object on screen is a picture of
 *  the layer taken before the move, so unlike a plain drag there is nothing
 *  correct left on the canvas to preserve. It has to be baked again.
 *
 *  Reaches the same tiles a drag would, by the same rule. */
export async function nudgeLayer(obj: Tagged, dx: number, dy: number) {
  if (!dx && !dy) return;
  const picked = bulkTargets(obj.layerId);
  const tiles = picked.length > 1 ? picked : [obj.tileId];
  // The extras of a multi-layer pick, exactly as on the ordinary drag path.
  const along = travellers(obj);
  await mutate("Move layer", () => {
    for (const t of tiles) {
      const l = findLayer(app.manifest.tiles[t]?.layers ?? [], obj.layerId);
      if (!l) continue;
      l.x += dx;
      l.y += dy;
    }
    for (const l of along) {
      l.x += dx;
      l.y += dy;
    }
  });
}

/** Puts a layer exactly where another one ended up — placement and size, not
 *  identity: its picture, wording, colour and mask are its own.
 *
 *  Absolute values, copied after the gesture has been folded into the layer
 *  that was dragged. Replaying the gesture instead would be wrong for shapes:
 *  `resize` multiplies a shape's w and h by what Fabric scaled, so the same
 *  factor applied to a tile that had drifted would push it further out. The
 *  intent behind dragging with several tiles picked is "put it here on all of
 *  them", so here is what gets copied. */
function copyPlacement(to: Layer, from: Layer, shift: { dx: number; dy: number }) {
  to.x = from.x + shift.dx;
  to.y = from.y + shift.dy;
  to.rotation = from.rotation;
  if (to.kind === "image" && from.kind === "image") {
    to.scale = from.scale;
    if (from.crop) to.crop = { ...from.crop };
    else delete to.crop;
  } else if (to.kind === "text" && from.kind === "text") {
    to.w = from.w;
    to.h = from.h;
  } else if (to.kind === "shape" && from.kind === "shape") {
    to.w = from.w;
    to.h = from.h;
  }
}

/** A canvas gesture, written to the same layer on every tile in `tileIds` —
 *  one undo step.
 *
 *  Only the dragged tile's layer sees the gesture; the rest are placed to match
 *  it. Fabric moved exactly one object, so every other tile has to be rebuilt
 *  to show the change — which is why more than one target forces a structural
 *  bump even when nothing scaled. */
export async function applyTransformBulk(
  obj: Tagged,
  patch: Pick<Layer, "x" | "y" | "rotation"> & Transform,
  tileIds: string[],
) {
  const own = app.manifest.tiles[obj.tileId]?.layers ?? [];
  const layer = findLayer(own, obj.layerId);
  if (!layer) return;
  const others = tileIds
    .filter((t) => t !== obj.tileId)
    .map((t) => app.manifest.tiles[t]?.layers ?? [])
    .map((list) => ({ list, layer: findLayer(list, obj.layerId) }))
    .filter((x): x is { list: Layer[]; layer: Layer } => !!x.layer);
  if (!others.length) return applyTransform(obj, patch);

  const shift = nestingShift(own, obj.layerId) ?? { dx: 0, dy: 0 };
  await mutate(
    "Move layer",
    () => {
      layer.x = patch.x - shift.dx;
      layer.y = patch.y - shift.dy;
      layer.rotation = patch.rotation;
      resize(layer, patch);
      /* Each target's own nesting, not the dragged one's: the same layer can
       * sit inside a group on one tile and loose on another, and a position is
       * stored relative to whatever encloses it. */
      for (const { list, layer: other } of others)
        copyPlacement(other, layer, nestingShift(list, obj.layerId) ?? { dx: 0, dy: 0 });
    },
    true,
  );
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
 *  what "Apply" acts on. */
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
    await mutate("Cover the wall", () => {
      layer.scale = scale;
      layer.x = 0.5;
      layer.y = 0.5;
    });
    await refreshCoverPreview();
  });
}

/** How many tiles are showing a baked mosaic instead of their own portrait —
 *  the number on the button, so it says what it is about to touch. */
/** How many portraits on *this* wall are hidden under a baked mosaic. Counted
 *  on the wall in front of you, like the button that acts on it. */
export const bakedCount = () =>
  visibleIds().filter((id) => !!app.manifest.tiles[id]?.base).length;

/** Takes every baked background off the wall at once. One mutation, so one
 *  Ctrl+Z puts the whole mosaic back — which is why this asks nothing first. */
export async function clearMosaic() {
  const n = bakedCount();
  if (!n) return;
  const ids = visibleIds();
  await mutate("Clear wall picture", () => {
    clearBases(app.manifest, ids);
    app.error = `${n} portrait(s) restored`;
  });
}

/** Bakes the selected grid-space picture into every tile it fully covers, then
 *  removes it: a mosaic in place is a background, not a floating object, and
 *  should not keep sitting on top of other layers or stay draggable once it is
 *  where it belongs. Re-positioning means adding a new picture and baking
 *  again — there is deliberately no "unbake". */
/** What Apply cannot carry into a tile's `base`.
 *
 *  A baked background is an asset name and a crop rectangle — `background()`
 *  draws it with nothing else. Everything below is drawn on the wall by
 *  `imageObject` and would simply be absent from the file written to the game:
 *  a picture turned on the wall came out square-on, a graded one came out raw,
 *  a half-transparent one came out solid, and one with the eye switched off
 *  came out anyway. The wall showed one thing and forty-four portraits held
 *  another, with nothing said either way.
 *
 *  Named rather than silently ignored, and refused rather than approximated:
 *  the fix that would honour them is to bake the rendered pixels instead of
 *  re-deriving a crop, which means writing a picture per tile. ponytail: this
 *  is the honest half of that, and it is the half that stops work being lost. */
function unbakeable(l: ImageLayer): string[] {
  const off: string[] = [];
  if (l.hidden) off.push("hidden");
  if (l.rotation) off.push("rotation");
  if (l.crop) off.push("crop");
  if (l.flipX || l.flipY) off.push("flip");
  if (l.opacity !== 1) off.push("opacity");
  for (const k of ["brightness", "contrast", "saturation", "hue", "blur"] as const)
    if (l[k]) off.push(k);
  if (l.borderWidth) off.push("border");
  if (l.cornerRadius) off.push("corners");
  if (l.shadow) off.push("shadow");
  return off;
}

export async function bakeMosaic() {
  const layer = selectedMosaic();
  const project = openProject();
  if (!layer || !project) return;
  const off = unbakeable(layer);
  if (off.length) {
    app.error =
      `Not applied: a baked background keeps only the placement, so ${off.join(", ")} ` +
      `would be lost. Reset ${off.length > 1 ? "those" : "that"} first, or leave the picture live.`;
    return;
  }
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
    await mutate("Apply wall picture", () => {
      bakeMosaicInto(app.manifest, project, layer.id, layer.asset, crops);
      app.selected = "";
    });
  });
}

/* --- Answering "the game rewrote this tile". Two answers, and only the user
 * has them: the same character with a new haircut, or a different character
 * who inherited the slot number. --- */

/** Writes "this is what the file looked like when we last agreed about it".
 *
 *  Only when there is something to write. A missing hash means the read failed
 *  — the game had the file open, most likely — and the empty string that used
 *  to be stored instead is an original no file can ever match: `classify`
 *  compares the real hash against it and reports the tile as changed, on every
 *  open, for good. A record left alone is at worst out of date; a record of ""
 *  is a question that answers itself wrongly forever. */
const recordOriginal = (prints: Record<string, { original: string }>, id: string) => {
  const hash = app.hashes[id];
  if (hash) prints[id] = { original: hash };
};

/** Records the file as it stands now and leaves everything else alone — the
 *  character is the same one, wearing something new. The layers were composed
 *  for them and stay. */
export async function keepCharacter(id: string) {
  await run("recheck", async () => {
    /* The vault copy goes first, and the fingerprint after it. It holds the
     * face from before the restyle, and loadOriginal prefers it over the
     * game's own file — keeping it would mean the editor went on showing the
     * old haircut for good.
     *
     * The order is the whole point: the fingerprint is the durable record that
     * says "we have seen this file and agreed about it", and writing it first
     * meant a drop that failed left the record saying so anyway. The question
     * could then never be asked again, for a portrait whose old original was
     * still sitting in the vault being served. */
    await dropVaultCopy(app.dir, id);
    app.vaulted = app.vaulted.filter((x) => x !== id);
    forgetOriginal(id);
    const { prints } = await loadFingerprints(app.dir);
    recordOriginal(prints, id);
    await saveFingerprints(app.dir, prints);
    app.changedTiles = app.changedTiles.filter((x) => x !== id);
    app.version++;
    app.error = "Kept. The vault's copy of the old face was released.";
  });
}

/** Treats the id as a stranger: the layers on it were composed for a face that
 *  no longer exists, so they go, the tile returns to the inbox, and the vault
 *  copy of the old portrait is thrown away — it would otherwise keep being
 *  served as this slot's "original". */
export async function replaceCharacter(id: string) {
  await run("recheck", async () => {
    /* The undoable part first, the irreversible part after it, and the durable
       record last of all. Undo puts the layers back and cannot put the vault
       copy back, so the message says which half it reaches — "Undone: Replace
       character" over a portrait whose original is gone for good is a promise
       this app cannot keep. */
    await mutate("Replace character", () => removeFromProjectToInbox(app.manifest, id, true));
    await dropVaultCopy(app.dir, id);
    app.vaulted = app.vaulted.filter((x) => x !== id);
    forgetOriginal(id);
    const { prints } = await loadFingerprints(app.dir);
    recordOriginal(prints, id);
    await saveFingerprints(app.dir, prints);
    app.changedTiles = app.changedTiles.filter((x) => x !== id);
    app.error = "Layers cleared. Ctrl+Z brings them back — the vault's original is gone.";
  });
}

/** Answers "same character" for the whole list at once — the case where the
 *  game regenerated the folder wholesale and every face is still who it was.
 *
 *  Deliberately NOT keepCharacter in a loop: the single click drops the tile's
 *  vault copy, because after a real restyle the vault holds the old face. A
 *  mass regeneration is the opposite situation — the vault is the curated set
 *  of originals, and it is the one thing this answer must not eat. So the new
 *  files are recorded as seen and the vault stays untouched; a face that truly
 *  did change still has its per-tile button, with the stricter behaviour. */
export async function keepAllCharacters() {
  /* The list on screen, not every changed tile. Archiving is "not now", so the
     banner leaves those out — and this answered for them anyway: a tile
     deliberately set aside had its question closed by a button that never
     mentioned it. */
  const ids = changedHere();
  if (!ids.length) return;
  await run("recheck", async () => {
    const { prints } = await loadFingerprints(app.dir);
    for (const id of ids) recordOriginal(prints, id);
    await saveFingerprints(app.dir, prints);
    const done = new Set(ids);
    app.changedTiles = app.changedTiles.filter((id) => !done.has(id));
    /* No cache to drop and no rebuild: the vault copies stay, and they are
     * exactly what loadOriginal is already serving. */
  });
}

/** Answers "new character" for the whole list at once: every changed tile is
 *  stripped, sent back to the inbox, and its vault copy dropped — one mutation,
 *  so one Ctrl+Z puts all the layers back (the vault copies stay gone, as with
 *  the per-tile button). */
export async function replaceAllCharacters() {
  // The list on screen — see keepAllCharacters. The dialog counts these too.
  const ids = changedHere();
  if (!ids.length) return;
  await run("recheck", async () => {
    // Undoable first, irreversible second, the durable record last.
    await mutate("Replace characters", () => {
      for (const id of ids) removeFromProjectToInbox(app.manifest, id, true);
    });
    const dropped = new Set(ids);
    app.vaulted = app.vaulted.filter((x) => !dropped.has(x));
    for (const id of ids) {
      await dropVaultCopy(app.dir, id);
      forgetOriginal(id);
    }
    const { prints } = await loadFingerprints(app.dir);
    for (const id of ids) recordOriginal(prints, id);
    await saveFingerprints(app.dir, prints);
    app.changedTiles = app.changedTiles.filter((id) => !dropped.has(id));
    app.error = `${ids.length} tile(s) cleared. Ctrl+Z brings the layers back — the vault's originals are gone.`;
  });
}

/** Only a project can be written: the inbox is the tiles nobody has arranged
 *  yet, and writing it would push unfinished portraits into the game. */
export const canSaveToGame = () => !!openProject()?.order.length;

/** How many of this project's tiles could be put back: the ones the vault
 *  actually holds an original for, placed or shelved alike — a tile written to
 *  the game keeps its vault copy whether or not it still has a slot.
 *
 *  Counting everything the project owns was a promise the folder could not
 *  keep: the dialog offered twelve portraits and the status line answered
 *  "none of these were written" once it was too late to say no. */
export const restorableCount = () => {
  const p = openProject();
  if (!p) return 0;
  const held = new Set(app.vaulted);
  return projectTiles(p).filter((id) => held.has(id)).length;
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

/* --- Snapshots. The document, put aside under a name, so a wall can be tried
 * out and walked back from. Twenty kilobytes each: assets and vault copies are
 * never deleted, so a restored snapshot finds everything it names still on
 * disk. See project.ts for why the folder itself is not copied. --- */

/** The snapshots of the wall in front of you.
 *
 *  A snapshot belongs to the project it was taken in, and only that project
 *  lists it: rolling one account's wall back is not an offer the next account
 *  should be shown. With no project open the list is the document-wide ones —
 *  which is also where every snapshot written before this split lands, since a
 *  file with no project in its name is exactly that. */
export const snapshots = () =>
  app.snapshots.filter((s) =>
    app.openProjectId
      ? s.projectId === app.openProjectId
      : /* On the overview: the document-wide ones, and any left behind by a
           project that has since been deleted. Those name a wall nothing lists
           any more, and without a home here they would be unreachable — which
           matters most in the one case they are for, since restoring one builds
           the deleted project back. */
        !s.projectId || !app.manifest.projects.some((p) => p.id === s.projectId),
  );

async function refreshSnapshots() {
  app.snapshots = app.dir ? await listSnapshots(app.dir) : [];
}

/** Whether a name would land on a snapshot this project already has.
 *
 *  Compared by file key rather than by the text, because that is what decides
 *  whether one overwrites the other: writeSnapshot has no idea a file is
 *  already there, and there is no undo behind a snapshot. */
const snapshotTaken = (name: string) =>
  snapshots().some((s) => snapshotKey(s.name) === snapshotKey(name));

/** `base`, or the first "base (2)", "base (3)" that is free.
 *
 *  Every snapshot written by the app rather than typed by hand goes through
 *  here. The one before a write to the game is named to the minute, so two
 *  writes in the same minute used to be one file — the second quietly replacing
 *  the restore point the first had just made, which is the one moment it exists
 *  for. */
function freeSnapshotName(base: string) {
  if (!snapshotTaken(base)) return base;
  for (let n = 2; ; n++) if (!snapshotTaken(`${base} (${n})`)) return `${base} (${n})`;
}

/** Puts the document aside under a name, tagged with the wall it was taken on,
 *  and says whether it landed.
 *
 *  The whole manifest goes in either way — twenty kilobytes, and a project's
 *  slice of it cannot be read back without the rest to prune against. What the
 *  tag decides is who sees it and how much of it comes back.
 *
 *  The answer matters to one caller: the snapshot before a write to the game is
 *  a safety net, and writing over the game's files after the net failed to go
 *  up is the one order that must not happen. */
export async function takeSnapshot(name: string): Promise<boolean> {
  if (!app.dir) return false;
  return await run("snapshot", async () => {
    await writeSnapshot(
      app.dir,
      { name: freeSnapshotName(name), projectId: app.openProjectId },
      { manifest: plain(app.manifest), prints: (await loadFingerprints(app.dir)).prints },
    );
    await refreshSnapshots();
  });
}

/** A default name that does not collide, so the row can be renamed rather than
 *  demanding a dialog first. Counted per project, because that is the list it
 *  will appear in — two walls may both have a "Snapshot 1", and their files do
 *  not collide because the project id is part of the filename. */
export const nextSnapshotName = () => {
  for (let n = 1; ; n++) if (!snapshotTaken(`Snapshot ${n}`)) return `Snapshot ${n}`;
};

export async function renameSnapshot(ref: SnapshotRef, to: string) {
  const name = to.trim();
  if (!app.dir || !name || name === ref.name) return;
  if (snapshotTaken(name)) {
    // Said out loud rather than swallowed: the field springs back to the old
    // name, which on its own looks like a dropped keystroke.
    app.error = `There is already a snapshot called "${name}"`;
    return;
  }
  await run("snapshot", async () => {
    const moved = { name, projectId: ref.projectId };
    await writeSnapshot(app.dir, moved, await readSnapshot(app.dir, ref));
    await deleteSnapshot(app.dir, ref);
    await refreshSnapshots();
  });
}

export async function removeSnapshot(ref: SnapshotRef) {
  if (!app.dir) return;
  await run("snapshot", async () => {
    await deleteSnapshot(app.dir, ref);
    await refreshSnapshots();
  });
}

/** Puts a snapshot back.
 *
 *  How much comes back is what the snapshot was taken on. One taken with a wall
 *  open puts that wall back and leaves every other project alone; one taken
 *  with none open is the whole document, which is what all of them used to be.
 *
 *  The game folder is not touched either way: what is on disk there is a
 *  separate decision, and "Write to game" is where it gets made. Pruned to the
 *  ids the folder actually has, because a snapshot from before a character was
 *  deleted would otherwise put rows back for portraits that no longer exist.
 *
 *  One mutation, so Ctrl+Z undoes the whole restore. */
export async function restoreSnapshot(ref: SnapshotRef) {
  if (!app.dir) return;
  await run("snapshot", async () => {
    const snap = await readSnapshot(app.dir, ref);
    const stored = pruneToFolder(snap.manifest, app.folderIds);

    if (!ref.projectId) {
      /* ponytail: the fingerprints are written outside the mutation, so Ctrl+Z
       * takes the document back and leaves them describing the restored state.
       * The cost is one wrong answer to "did the game change this file" on the
       * next open, which the user is asked about and can correct; the fix is
       * teaching undo about state that lives outside the manifest, which is a
       * bigger machine than the bug. Left deliberately, written down here. */
      await saveFingerprints(app.dir, snap.prints);
      await mutate("Restore snapshot", () => {
        app.manifest = stored;
        /* Inside the mutation, so the sweep is part of the same undo step. A
         * snapshot predates any layout deleted since it was taken, and putting
         * it back therefore puts stamps back too — which stood on the tiles as
         * pictures named by a raw id until the next start. The rule is that a
         * layout and its layers do not survive each other; it has to hold here
         * as well, not only on open. */
        clearAll();
        app.openProjectId = "";
      });
      app.error = `Restored "${ref.name}"`;
      return;
    }

    /* Only this wall's answers about its own portraits. The file holds every
     * project's, and writing all of them back would undo change-detection
     * decisions made on walls this restore is supposed to leave alone. */
    const owned = new Set(
      projectTiles(stored.projects.find((p) => p.id === ref.projectId) ?? newProject("")),
    );
    const { prints } = await loadFingerprints(app.dir);
    for (const id of owned) if (snap.prints[id]) prints[id] = snap.prints[id];
    await saveFingerprints(app.dir, prints);

    /* Tiles the wall has picked up since the snapshot was taken. The snapshot's
     * project record replaces the current one wholesale, so they are not in it
     * — they land in Unsorted, keeping their layers. Counted here because the
     * message used to name only the tiles taken *from* other projects, and a
     * portrait quietly leaving this wall is the half a user notices. */
    const heldNow = projectTiles(
      app.manifest.projects.find((p) => p.id === ref.projectId) ?? newProject(""),
    );
    const released = heldNow.filter((id) => !owned.has(id)).length;

    let taken = 0;
    await mutate("Restore snapshot", () => {
      taken = restoreProjectInto(app.manifest, stored, ref.projectId);
      // Same reason as the document-wide route above.
      clearAll();
    });
    const also = [
      taken ? `${taken} tile(s) taken back from another project` : "",
      released ? `${released} newer tile(s) sent to Unsorted` : "",
    ].filter(Boolean);
    app.error = also.length
      ? `Restored "${ref.name}" — ${also.join(", ")}`
      : `Restored "${ref.name}"`;
  });
}

export async function saveToGame() {
  const project = openProject();
  if (!project) return;
  /* A restore point before the one action that overwrites the game's own
   * files. Nobody thinks to take one first, and this is the moment they would
   * wish they had. */
  const stamp = localStamp();
  /* And no write if it failed. The snapshot is the only way back from this
   * action, so going ahead without one turns a full disk into lost work. The
   * message takeSnapshot left in app.error stays, because the write that would
   * have cleared it never starts. */
  if (!(await takeSnapshot(`Before write ${stamp}`))) return;
  await run("save", async () => {
    if (!app.deps) throw new Error("no folder open");
    /* Asked again, after the snapshot has been written. `project` above is a
       live reference into the document, and taking a snapshot is a real file
       write — an undo landing in that window replaces app.manifest wholesale,
       leaving that reference pointing into a document nobody is looking at any
       more. The tiles would then be rendered from the new document into the
       old one's slot order, written over the game's own portraits, and marked
       as written, so the next open would report nothing wrong. */
    const now = openProject();
    if (now?.id !== project.id) throw new Error("the wall changed — nothing was written");
    /* Snapshotted together: the id list positions the export window and keys
     * the result, so it has to be the same list the scene is built from. */
    const n = await saveTiles(
      app.dir,
      { ids: plain(now.order), gridLayers: plain(now.gridLayers) },
      plain(app.manifest),
      app.deps,
    );
    // The write vaults every original it touched on the way past, so what
    // "Reset in game" can put back has just grown.
    app.vaulted = await vaultedIds(app.dir);
    app.error = `${n} tile(s) written`;
  });
}

/* --- Recovered from the layout section: these are wall functions that
 * happened to live inside it. --- */
/** Edits one field of a layer. Everything the properties panel changes goes
 *  through here, so each edit is one undo step and one save. */
/** Fields that change how wide a caption's box is. */
const WIDTH_FIELDS = new Set(["text", "size", "font", "bold", "italic"]);

/** Any field any kind of layer has.
 *
 *  `keyof Layer` would only be the handful every kind shares, since Layer is a
 *  union — so a caption's `size` would not typecheck. Spelling the union out
 *  still rejects a field that exists nowhere, which is the typo this is
 *  guarding against; pairing the right field with the right kind is the
 *  caller's job, and the properties panel does it by rendering each field
 *  inside the branch that narrowed the layer to that kind. */
export type LayerField = keyof TextLayer | keyof ShapeLayer | keyof ImageLayer;

/** Writes one field onto one layer, keeping an anchored caption's edge put.
 *
 *  A caption's x is its centre, so longer words used to push it out sideways in
 *  both directions — one line of a stack crept left while the next stayed put.
 *  Left-aligned text has its anchor at the left edge and right-aligned at the
 *  right, so the centre is moved by half the change to leave that edge where it
 *  was. Centred text grows around its middle, which is the point of it.
 *
 *  Measured per layer, which is why this is a function rather than two lines at
 *  the one call site: the same edit across several tiles meets a different
 *  string on each of them once wording lives on the tile, and one width
 *  measured from whichever tile happened to be first would drift all the
 *  others. */
function writeField(layer: Layer, key: LayerField, value: unknown) {
  /* A number field takes "1e999", which is a valid number and is Infinity.
     Every clamp in the panel is `Math.min(Math.max(v, min), max ?? Infinity)`,
     so for the boxes with no ceiling — a shape's width, a font size, an
     outline, a border, a shadow — it came through whole. The layer then draws
     as nothing, and JSON.stringify writes `null` on the way to disk, so after
     a save it is a layer of no size at all with its row still in the list and
     no way back. Refused where every field passes rather than in each box. */
  if (typeof value === "number" && !Number.isFinite(value)) return;
  const anchored =
    layer.kind === "text" && WIDTH_FIELDS.has(key) && (layer.align ?? "center") !== "center";
  const was = anchored ? textWidth(layer) : 0;
  (layer as unknown as Record<string, unknown>)[key] = value;
  /* A class icon is fitted to both its width and its height, and the panel
     offers only the width for one — so past about a quarter more than it
     started at, the height became the smaller of the two and the slider did
     nothing for the rest of its travel. The corner handles keep the two in
     step; this keeps the panel in step with them. */
  if (key === "w" && layer.kind === "shape" && layer.shape === "icon" && typeof value === "number")
    layer.h = value;
  if (!anchored) return;
  const grew = textWidth(layer as TextLayer) - was;
  layer.x += ((layer as TextLayer).align === "right" ? -grew : grew) / 2;
}

/** The field's own name, spaced out: one setter stands behind every slider,
 *  swatch and dropdown in the panel, so a single label for the lot would read
 *  "Change property" forty different ways. */
const fieldLabel = (key: LayerField) =>
  `Change ${String(key).replace(/([A-Z])/g, " $1").toLowerCase()}`;

/** Which tiles a field edit reaches: every selected tile that carries a layer
 *  by this id, or just the one the layer was picked on.
 *
 *  Matched on the id alone and deliberately not on the name. Ids are shared
 *  across tiles because one design was put on all of them, which is exactly the
 *  set an edit should reach. Auto-names collide between unrelated layers and
 *  would reach tiles nobody pointed at. */
export const bulkTargets = (id: string): string[] => {
  const scope = app.selectedTiles.length > 1 ? [...app.selectedTiles] : [];
  /* The tile the layer was picked on always counts, whatever is picked on the
   * wall. It is not one more selected tile — it is this layer's own address,
   * and leaving it out is what made the properties panel edit every tile
   * except the one whose numbers it was showing: click two tiles, then click a
   * layer on a third, and the slider moved the two and not the one under the
   * hand. */
  if (app.selectedTile && !scope.includes(app.selectedTile)) scope.push(app.selectedTile);
  return scope.filter((t) => !!findLayer(app.manifest.tiles[t]?.layers ?? [], id));
};

/** One field, on the same layer of every tile in `tileIds` — one undo step.
 *
 *  The wall's answer to what a Layout used to do by owning the design: pick the
 *  tiles, change the thing once. Selection is the whole mechanism, so there is
 *  no link to go stale and nothing to re-sync; GIMP 3 dropped its chain icons
 *  for the same reason. */
export async function setTileLayerField(
  tileIds: string[],
  id: string,
  key: LayerField,
  value: unknown,
) {
  const targets = tileIds
    .map((t) => findLayer(app.manifest.tiles[t]?.layers ?? [], id))
    .filter((l): l is Layer => !!l && (l as unknown as Record<string, unknown>)[key] !== value);
  if (!targets.length) return;
  await mutate(
    fieldLabel(key),
    () => {
      for (const layer of targets) writeField(layer, key, value);
    },
    true,
    /* The tile set belongs in the key. Without it, editing {A,B}, reselecting
     * {C} and carrying on with the same slider folds both into one undo step —
     * the run only ends when the key changes. */
    `field:${id}:${key}:${tileIds.join(",")}`,
  );
}

/** The layer behind an id: a tile's, where the selection names one, otherwise
 *  the open wall's own. Two places, because those are the only two a layer can
 *  live in now. */
const anyLayer = (id: string, tileId = app.selectedTile): Layer | undefined =>
  findLayer(app.manifest.tiles[tileId]?.layers ?? [], id) ??
  findLayer(openProject()?.gridLayers ?? [], id);

/** The layer the panel is showing: whatever is picked, on its own tile or
 *  across the whole wall. The tile is asked first, which is what keeps two
 *  tiles carrying the same layer id apart. */
export const pickedLayer = (): Layer | undefined =>
  app.selected ? anyLayer(app.selected) : undefined;

/** One field on one layer — the wall-spanning case, and the fallback for a
 *  layer picked with no tile behind it. A layer on a tile goes through
 *  setTileLayerField, which reaches every tile the selection covers. */
export async function setLayerField(id: string, key: LayerField, value: unknown) {
  const layer = anyLayer(id);
  if (!layer || (layer as unknown as Record<string, unknown>)[key] === value) return;
  await mutate(
    fieldLabel(key),
    () => writeField(layer, key, value),
    true,
    // One run per field per layer: typing a caption is one step, and switching
    // to a different slider starts a new one.
    `field:${id}:${key}`,
  );
}

/** Gives a trimmed picture back whole — see `uncrop`, which is where the sums
 *  live, because "reset" has to put the scale back as well as the crop. */
export async function resetCrop(id: string) {
  const layer = anyLayer(id);
  if (layer?.kind !== "image" || !layer.crop) return;
  await mutate("Reset crop", () => uncrop(layer), true);
}

/** Ends the current undo run, so the next edit starts a new step. The one
 *  thing history cannot work out for itself: a run key says two edits are of
 *  the same kind, not that the user is still in the middle of making them.
 *  Called at every boundary — a finished canvas gesture here, and every form
 *  control's `change` event in App.svelte. */
export const endGesture = () => endRun(history);

/** `name` lives on Common, so one function renames every kind of layer. */
export async function renameLayer(id: string, name: string, tileId = app.selectedTile) {
  const layer = anyLayer(id, tileId);
  if (!layer) return;
  const next = name.trim();
  /* Typing the text already shown is not a rename. The input is prefilled
   * with layerLabel — the display label, which for an unnamed layer is a
   * fallback, not layer.name — so without the second check a cancelled rename
   * (Escape restores the label, blur still fires) wrote that fallback in as a
   * real name and burned an undo step on nothing. */
  if (next === (layer.name ?? "") || next === layerLabel(layer)) return;
  await mutate("Rename layer", () => (layer.name = next || undefined));
}

/** One tile's own layers — what the tile list shows under its row. */
export const tileLayers = (tileId: string) => app.manifest.tiles[tileId]?.layers ?? [];

/** The project owning this tile, if any — what the tile list shows as context,
 *  and what says whether a tile is still sitting in the inbox. */
export const tileProject = (tileId: string) => projectOf(app.manifest, tileId);

/** Locking takes a layer out of Fabric's hit testing (makeInteractive in
 *  scene.ts), so it stops being draggable while staying visible. */
export async function toggleLayerLocked(id: string, tileId = app.selectedTile) {
  const layer = anyLayer(id, tileId);
  if (!layer) return;
  await mutate("Lock or unlock layer", () => (layer.locked = !layer.locked));
}

/* What "copy the properties" leaves behind, when both layers are of a kind.
 *
 * Identity, because the pair (id, tile) is what says which layer this is and
 * two layers answering to one id on one tile is the one shape nothing here
 * copes with. Content, because a caption that took on another's wording would
 * not be a caption with the same look — it would be the same caption twice,
 * and the crop goes with it since it is measured in one particular picture's
 * pixels. Hidden and locked, because they are where you are in the work rather
 * than what the layer looks like: a paste that switches a layer off reads as a
 * bug however well documented. `space` reinterprets x and y against the whole
 * wall instead of the tile, so carrying it across would fling the layer off
 * somewhere. The last two are leftovers of the layout editor. */
const KEPT_ON_PASTE = new Set([
  "id",
  "name",
  "seq",
  "kind",
  /* `children` is deliberately absent. A group's members are what the group
     *is*, so copying one onto another tile has to bring them — otherwise
     "put this arrangement on those portraits" means building it again by
     hand on each. ("layers" stood here once; no layer has a field by that
     name, so it excluded nothing and said something untrue.) */
  "asset",
  "text",
  "icon",
  "crop",
  "hidden",
  "locked",
  "space",
  "layoutId",
  "live",
]);

/* All that can travel between two layers of different kinds. A picture has no
 * font and a caption has no corner radius, so between kinds there is nothing
 * but the placement and the two things every layer can do. */
const ACROSS_KINDS = new Set([
  "x",
  "y",
  "rotation",
  "opacity",
  "shadow",
  "shadowColor",
  "maskId",
  "maskInvert",
]);

/** The layer whose properties were copied, if any — a snapshot, not a
 *  reference, so editing or deleting the original afterwards leaves what was
 *  copied alone. Deliberately not saved with the document: it is a clipboard,
 *  and a clipboard that survives a restart is a surprise, not a feature. */
let copied: { layer: Layer; tile: string } | undefined;

/** What the paste item names, so the menu can say what it would paste rather
 *  than leaving it to be remembered. The tile comes with it for the same
 *  reason it comes with everything else here: one id is not a layer. */
export const copiedLayer = () => copied;

export function copyLayerProps(id: string, tileId = app.selectedTile) {
  const layer = anyLayer(id, tileId);
  if (layer) copied = { layer: clone(layer), tile: tileId };
}

/** Makes one layer the twin of another — everything but what it is and what it
 *  shows. Photoshop's Paste Layer Style, widened: there the placement stays
 *  behind, and here it is most of the point. Two captions on two portraits sit
 *  in exactly the same spot at exactly the same size, which is the thing that
 *  cannot be done by eye across forty-four tiles.
 *
 *  A field the source does not have is removed rather than left standing. A
 *  half-copy is worse than none: the layer would come out with the source's
 *  colour and its own old shadow, and nothing on screen would say why. */
function writeProps(to: Layer, from: Layer) {
  const travels = (k: string) =>
    !KEPT_ON_PASTE.has(k) && (from.kind === to.kind || ACROSS_KINDS.has(k));
  const rec = to as unknown as Record<string, unknown>;
  for (const k of Object.keys(rec)) if (travels(k) && !(k in from)) delete rec[k];
  for (const [k, v] of Object.entries(from)) {
    /* A group's members travel — that is what makes "put this arrangement on
       those portraits" one action — but each tile keeps what its own copy of a
       member *says*. Replacing the list outright is what the rest of this
       function is careful never to do: a nameplate group pasted across
       forty-four portraits gave all of them tile one's caption, and the row
       that would show it is not even drawn for a layer inside a group.
       A member the target does not have arrives whole; one it has takes the
       same treatment its loose twin would. */
    if (k === "children" && to.kind === "group" && from.kind === "group") {
      const mine = new Map(to.children.map((c) => [c.id, c]));
      to.children = from.children.map((c) => {
        const own = mine.get(c.id);
        if (!own) return clone(c);
        writeProps(own, c);
        return own;
      });
      continue;
    }
    if (travels(k)) rec[k] = clone(v);
  }
}

export async function pasteLayerProps(id: string, tileId = app.selectedTile) {
  const from = copied?.layer;
  const to = anyLayer(id, tileId);
  if (!from || !to || (copied!.tile === tileId && from.id === id)) return;
  /* The same rule the paste onto tiles keeps, and this had none: an id has to
     stay unique within a tile. Pasting one group's properties onto another
     brought the first group's members with it, so a tile ended up with the
     same id twice — once in each group — and every lookup takes the first hit.
     The two rows then disagreed about which layer they were. */
  /* Only what a paste actually brings an id for: the target keeps its own id,
     so a group's members are the only ids that can arrive. Between two layers
     that are not groups nothing can collide at all. */
  const bringing = new Set(
    from.kind === "group" ? [...walkLayers(from.children)].map((l) => l.id) : [],
  );
  const mine = new Set([...walkLayers([to])].map((l) => l.id));
  const own = tileId ? (app.manifest.tiles[tileId]?.layers ?? []) : (openProject()?.gridLayers ?? []);
  if (bringing.size && [...walkLayers(own)].some((l) => bringing.has(l.id) && !mine.has(l.id))) {
    app.error = "Not pasted — this tile already carries a layer of that name";
    return;
  }
  await mutate("Paste properties", () => writeProps(to, from));
}

/** Puts the copied layer on every picked tile, under one id — which is what
 *  makes them one layer from then on: a later drag moves all of them and a
 *  later field edit reaches all of them, in one undo step.
 *
 *  A tile already carrying that id keeps what its layer *says* — its wording,
 *  its picture, its icon — and takes everything else. That is the case this
 *  exists for: forty-four captions typed one at a time are forty-four
 *  different names worth keeping, and it is only their placement and look that
 *  should stop being forty-four separate decisions.
 *
 *  A tile without it gets the whole layer, wording included, because there is
 *  nothing of its own to keep. Its name is not renumbered on the way in: these
 *  are meant to be one layer seen on many tiles, and nameInStack would give
 *  each copy a different name. */
export async function pasteLayerOntoTiles() {
  const from = copied?.layer;
  const tiles = app.selectedTiles.filter((t) => app.manifest.tiles[t]);
  if (!from || !tiles.length) return;
  /* Everything the paste brings, a group's members included. An id has to stay
     unique within a tile: every lookup in this app finds a layer by id and
     takes the first hit, so a second layer of that name somewhere else on the
     same tile makes the eye, the lock, the delete and the drag land wherever
     the walk happens to reach first. Pasting a group onto a tile that already
     carried one of its members did exactly that — the row inside the group was
     clicked and the layer outside it went dark. */
  const bringing = new Set([...walkLayers([from])].map((l) => l.id));
  const done: string[] = [];
  const clashed: string[] = [];
  await mutate(`Paste layer onto ${tiles.length} tile(s)`, () => {
    for (const t of tiles) {
      const own = app.manifest.tiles[t].layers;
      const to = findLayer(own, from.id);
      /* The layer being written over is allowed to hold these ids — it is the
         same layer. Anywhere else on the tile is a collision, and the tile is
         left alone: refusing is recoverable, a tile with two layers of one name
         is a puzzle nobody can see. */
      const mine = to ? new Set([...walkLayers([to])].map((l) => l.id)) : new Set<string>();
      if ([...walkLayers(own)].some((l) => bringing.has(l.id) && !mine.has(l.id))) {
        clashed.push(t);
        continue;
      }
      if (to) writeProps(to, from);
      else own.push(clone(from));
      done.push(t);
    }
    if (done.length) selectLayer(from.id, done[0]);
    // Said out loud: a paste that quietly reached six tiles of eight is the
    // kind of thing found a week later.
    if (clashed.length)
      app.error =
        `Pasted onto ${done.length} tile(s); ${clashed.length} skipped — ` +
        `already carrying a layer of that name`;
  });
}

/** Every layer the picked tiles carry, one entry per id — what the wall's
 *  "Remove layer" submenu lists.
 *
 *  Keyed by id rather than by name, because the id is what a removal has to
 *  name: two layers can wear one label and only one of them is meant. The
 *  count is what tells you how far the click reaches before you make it. */
export const layersOnSelection = (): { id: string; label: string; tiles: number }[] => {
  const seen = new Map<string, { id: string; label: string; tiles: number }>();
  for (const t of app.selectedTiles)
    for (const l of walkLayers(app.manifest.tiles[t]?.layers ?? [])) {
      const had = seen.get(l.id);
      if (had) had.tiles++;
      else seen.set(l.id, { id: l.id, label: layerLabel(l), tiles: 1 });
    }
  return [...seen.values()].sort((a, b) => b.tiles - a.tiles || a.label.localeCompare(b.label));
};

/** Switches one layer off, or on, across every picked tile carrying it — one
 *  undo step.
 *
 *  Set outright rather than flipped per tile: with fourteen tiles the flag can
 *  disagree between them, and "toggle" would then hide seven and show seven
 *  and read as a bug whichever way you meant it. The menu asks for a direction
 *  and gets one. Same for the lock beside it. */
export async function setLayerHiddenOnSelection(id: string, hidden: boolean) {
  await writeFlagOnSelection(id, hidden ? "Hide layer" : "Show layer", (l) => {
    if (hidden) l.hidden = true;
    else delete l.hidden;
  });
}

export async function setLayerLockedOnSelection(id: string, locked: boolean) {
  await writeFlagOnSelection(id, locked ? "Lock layer" : "Unlock layer", (l) => {
    if (locked) l.locked = true;
    else delete l.locked;
  });
}

async function writeFlagOnSelection(id: string, label: string, write: (l: Layer) => void) {
  const found = app.selectedTiles
    .map((t) => findLayer(app.manifest.tiles[t]?.layers ?? [], id))
    .filter((l): l is Layer => !!l);
  if (!found.length) return;
  await mutate(label, () => found.forEach(write));
}

/** Takes one layer off every picked tile that has it — one undo step.
 *
 *  Between "Clear all layers", which undresses a tile completely, and the × on
 *  a row, which reaches exactly one tile. Undressing forty tiles to be rid of
 *  one caption is the trip this saves. */
export async function removeLayerFromSelection(id: string) {
  const tiles = app.selectedTiles.filter(
    (t) => !!findLayer(app.manifest.tiles[t]?.layers ?? [], id),
  );
  if (!tiles.length) return;
  await mutate("Remove layer", () => {
    for (const t of tiles) removeLayerFrom(app.manifest.tiles[t].layers, id);
    if (app.selected === id) app.selected = "";
  });
}

/** Reorders a tile's own stack. Takes the list rather than an owner, so the
 *  project's wall picture and a tile's stack are the same call. */
async function dropInto(layers: Layer[] | undefined, id: string, beforeId: string | null) {
  if (!layers) return;
  // Checked on a copy first, so a refused move costs neither an undo step nor
  // a save.
  const trial = plain(layers) as Layer[];
  if (!relocateLayer(trial, id, null, beforeId)) return;
  await mutate("Reorder layer", () => {
    relocateLayer(layers, id, null, beforeId);
    app.selected = id;
  });
}

export const dropTileLayer = (tileId: string, id: string, beforeId: string | null) =>
  dropInto(app.manifest.tiles[tileId]?.layers, id, beforeId);

/** Puts a new layer on every selected tile — one undo step.
 *
 *  The same id on each of them, deliberately. That shared id is what makes the
 *  new layer bulk-editable straight away: pick the tiles again later and one
 *  edit reaches all of them. It is the same shape a stamped design left behind,
 *  minus the stamp.
 *
 *  Named per tile rather than once, because a name is a position in that tile's
 *  own stack — the third caption on one portrait may be the first on another,
 *  and a name claiming otherwise is worse than a name that differs. */
async function addToTiles(label: string, make: () => Layer) {
  const tiles = app.selectedTiles.filter((t) => app.manifest.tiles[t]);
  if (!tiles.length) return;
  const proto = make();
  await mutate(label, () => {
    for (const t of tiles) {
      const l = clone(proto);
      nameInStack(l, app.manifest.tiles[t].layers);
      app.manifest.tiles[t].layers.push(l);
    }
    selectLayer(proto.id, tiles[0]);
  });
}

/** Adds a picture to every selected tile. */
export async function addTileImage() {
  if (!app.selectedTiles.length) return;
  const path = await pickFile({ filters: [IMAGE_FILTER] });
  if (typeof path !== "string") return;
  await run("import", async () => {
    const asset = await importAsset(app.dir, path);
    await addToTiles("Add picture", () => newImageLayer(asset));
  });
}

/** Adds a caption to every selected tile.
 *
 *  Near the bottom, where a portrait's name goes, and "{{id}}" resolves against
 *  each tile as it is drawn — so one caption added to forty tiles reads as
 *  forty different names without anything further being typed. */
export async function addTileText() {
  await addToTiles("Add caption", () => {
    const l = newTextLayer();
    l.y = 0.85;
    return l;
  });
}

export async function addTileShape(shape: ShapeKind, icon?: string) {
  await addToTiles("Add shape", () => newShapeLayer(shape, icon));
}

