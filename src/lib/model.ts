/** A detached copy of any part of the document.
 *
 *  JSON and not `structuredClone`: the editor hands these functions its live
 *  Svelte `$state` objects, which are Proxies, and structuredClone refuses a
 *  Proxy outright with a DataCloneError. Thrown from inside an edit, that left
 *  the manifest half-changed — so the rule is that nothing here may depend on
 *  the caller having snapshotted first. A manifest is JSON by definition, so
 *  the round trip loses nothing that was ever going to reach disk. */
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Crop rectangle in source-image pixels. */
export type Crop = { x: number; y: number; w: number; h: number };

/** The picture filling the tile. A mosaic is 60 tiles sharing one asset with
 *  different crops, which is why it needs no mode of its own. */
export type Base = { asset: string; crop: Crop } | null;

/** Two stops and a direction. Deliberately not a multi-stop editor: a stop
 *  list needs its own drag UI, and two colours cover what this tool needs. */
export type Gradient = {
  from: string;
  to: string;
  angle: number; // degrees, 0 = left to right, ignored when radial
  radial?: boolean; // from the centre outwards instead of directional
  radius?: number; // radial only: multiplier on the default reach, 1 = default
  mid?: number; // 0..1, where the blend sits; past the middle one colour holds solid. 0.5 = even
};

/** Anywhere a colour can be picked, a gradient is allowed instead. */
export type Paint = string | Gradient;

export const isGradient = (paint: Paint): paint is Gradient => typeof paint !== "string";

/** Geometry is stored as fractions of the tile, never pixels: the tile size is
 *  configurable, and px values would break every layout the moment it changes. */
type Common = {
  id: string;
  x: number; // centre, 0..1 of tile width
  y: number; // centre, 0..1 of tile height
  rotation: number; // degrees
  opacity: number; // 0..1
  /* Optional so manifests written before these existed still load unchanged. */
  name?: string;
  /* Which img/text/shape this was in its stack when it was created. Kept apart
   * from the name so renaming cannot hand the number to the next layer — see
   * nameInStack. Absent on everything written before names were numbered. */
  seq?: number;
  locked?: boolean;
  hidden?: boolean;
  /* Set on a layer whose x/y (and size) are fractions of the whole wall rather
   * than of one tile — placed once across every portrait, which is why the
   * mosaic needs no mechanism of its own. Absence is the tile-local case, and
   * that is the only reason there is no "tile" value to write: a second name
   * for "not set" is a value nobody can ever be sure got assigned. Only
   * meaningful on a project-scope layer; a tile-local one has no wall to
   * span. */
  space?: "grid";
  /* A soft halo behind the layer. With no offset it is a glow — one feature
   * covers both, which is why there is no separate glow field. Optional here
   * and overridden as required on TextLayer, which had it first: everything
   * written before shapes and pictures could cast one loads unchanged. */
  shadow?: number; // blur radius as a fraction of tile width, 0 or absent = off
  shadowColor?: string;
  /* Another layer's id to clip this one to — a shape by its outline, a picture
   * by the pixels it actually has, a caption by its letters. A dangling id (the
   * layer got deleted) simply fails to resolve at render time and this one
   * draws unclipped, so nothing needs cleaning up on delete. */
  maskId?: string;
  /* Keep what falls outside the mask instead of inside it — a hole punched
   * through the layer rather than a piece cut out of it. Absent means the
   * ordinary way round. */
  maskInvert?: boolean;
  /* Set on anything a Layout put here: the picture rendered from it, and any
   * caption it keeps live. Lets one Layout find every copy of itself across
   * every tile carrying it and bring them all up to date in one pass. Absent
   * on a layer
   * created by hand. */
  layoutId?: string;
  /* Inside a Layout: keep this layer out of the rendered stamp and copy it
   * onto the tiles as a live layer instead. Baked pixels are the same pixels
   * on every tile, and the whole point here is that they should not be — a
   * caption naming the character, a logo for their class. Meaningless on a
   * layer already sitting on a tile, where a live layer is live by
   * construction. */
  perTile?: boolean;
  /* On a tile: this is such a copy, not the stamp. Both carry the same
   * layoutId and both can be images, so without this the cleanup pass that
   * removes withdrawn live layers could not tell them apart and would delete
   * the stamp. Absent on manifests written before live pictures existed —
   * there an image with a layoutId is always the stamp, which is exactly what
   * absence means here. */
  live?: boolean;
};

/** How much of a picture is trimmed off each side, as fractions of the source.
 *  All four at 0 is the whole picture, which is what absence means. */
export type Inset = { l: number; r: number; t: number; b: number };

/** What is left of a picture after the trim, as fractions of the source. */
export const cropSpan = (c: Inset) => ({ w: 1 - c.l - c.r, h: 1 - c.t - c.b });

/** Gives a trimmed picture back whole, at the size its pixels already had.
 *
 *  `scale` measures the visible part, so the trim has to be divided back out
 *  of it. Dropping the crop on its own would redraw the whole picture in the
 *  space the visible part occupied — the trim would read as having shrunk the
 *  picture rather than cropped it. */
export function uncrop(l: ImageLayer) {
  if (!l.crop) return;
  l.scale /= cropSpan(l.crop).w || 1;
  delete l.crop;
}

export type ImageLayer = Common & {
  kind: "image";
  asset: string;
  /** The width the layer occupies on the tile, as a fraction of tile width —
   *  of what the crop leaves, not of the whole picture. Trimming a side
   *  therefore narrows the layer without resizing the pixels inside it, which
   *  is the entire difference between cropping and scaling. */
  scale: number;
  /* Optional so manifests saved before flipping existed still load unchanged. */
  flipX?: boolean;
  flipY?: boolean;
  /* Likewise absent on everything written before cropping existed, and absent
   * means the whole picture. */
  crop?: Inset;
  /* Colour grading, all -1..1 with 0 (or absent) as neutral — the ranges
   * Fabric's own filters take, stored untranslated. Images only: text and
   * shapes pick their colour directly, and a second dial that turns the same
   * knob is not a feature. `hue` is a fraction of a half turn, so ±1 is ±180°. */
  brightness?: number;
  contrast?: number;
  saturation?: number;
  hue?: number;
  /* 0..1 as Fabric's Blur filter takes it — a fraction of the image's size,
   * not pixels, so the softness survives a resize. 0 or absent = sharp. */
  blur?: number;
  /* A frame around the picture, in the same units a shape's border uses: a
   * fraction of tile width. Drawn inside the edge, so framing a layer never
   * changes the space it occupies. 0 or absent = no frame. */
  borderWidth?: number;
  borderColor?: string;
  /* 0..0.5 of the picture's short side, like a rect's. One radius for all four
   * corners: per-corner control is a shape's business, and a picture wanting
   * three round corners can be masked by one. */
  cornerRadius?: number;
};

export type ShapeKind = "rect" | "ellipse" | "polygon" | "icon";

/** Which corners of a rect the radius reaches. Absent means all four, which is
 *  what every rect drawn before this did. */
export type Corners = { tl: boolean; tr: boolean; bl: boolean; br: boolean };

export type ShapeLayer = Common & {
  kind: "shape";
  shape: ShapeKind;
  w: number; // fraction of tile width
  h: number; // fraction of tile height
  cornerRadius: number; // 0..0.5 of min(w,h); rect only
  corners?: Corners; // rect only; absent means all four
  sides: number; // polygon only; rotation reuses the common field
  /* icon only: which class icon this is, by name. The artwork ships with the
   * application, so the manifest stores the name and nothing else — a layout
   * copied to another machine draws the same icon without carrying it. A name
   * no build knows draws nothing rather than guessing at a neighbour. */
  icon?: string;
  fill: Paint;
  borderColor: string;
  borderWidth: number; // fraction of tile width, 0 = no border
};

export type TextAlign = "left" | "center" | "right";

export type TextLayer = Common & {
  kind: "text";
  text: string; // {{id}} expands to the tile's numeric id
  font: string;
  size: number;
  /* Optional so manifests written before alignment existed still load; absent
   * means centred, which is what they all rendered as. */
  align?: TextAlign;
  /* Likewise absent means off, matching everything written before these. */
  bold?: boolean;
  italic?: boolean;
  color: Paint;
  strokeColor: string;
  strokeWidth: number;
  shadow: number;
  shadowColor: string;
  /* How wide the caption's box is, as a fraction of tile width — the width the
   * words wrap at, independent of the font size: a small font fits many
   * letters before the first break, a large one few.
   *
   * Absent means the old behaviour, a box that hugs its words. That box moved
   * as you typed: it is centred on `x`, so it grew in both directions, and
   * Fabric widens a Textbox to its longest unbreakable word behind our back —
   * which walked a left-aligned caption leftwards by half a letter or two. A
   * width that does not depend on the text cannot do that. Absent rather than
   * defaulted so no existing caption moves; dragging the side handle or typing
   * a width is what settles it. */
  w?: number;
  /* And how tall the box is, as a fraction of tile height. Lines past it are
   * cut off — the box is the promise that a caption cannot grow into whatever
   * sits beneath it, which is the whole reason to fix a height at all. Absent
   * means the box grows downwards with its lines, which is what every caption
   * written before this did. */
  h?: number;
};

/** Children keep their own tile-absolute coordinates; the group's x/y is a
 *  translation applied on top, so moving a group shifts everything inside it
 *  without rewriting a single child position.
 *
 *  Its opacity is multiplied into the children on the way down rather than
 *  applied to a flattened picture, so half-transparent children still show
 *  through each other. Nothing here flattens: a group is a shared translation
 *  and a shared fade, not a merged image. The doc used to promise the
 *  opposite, which is worth saying plainly — see layoutObjects in scene.ts,
 *  where the same limit is written down beside the code that causes it. */
export type GroupLayer = Common & {
  kind: "group";
  children: Layer[];
};

export type Layer = ImageLayer | TextLayer | ShapeLayer | GroupLayer;

/** Every layer in the tree, parents before their children. */
export function* walkLayers(layers: Layer[]): Generator<Layer> {
  for (const l of layers) {
    yield l;
    if (l.kind === "group") yield* walkLayers(l.children);
  }
}

export function findLayer(layers: Layer[], id: string): Layer | undefined {
  for (const l of walkLayers(layers)) if (l.id === id) return l;
  return undefined;
}

/** A group's x/y is a displacement applied on top of children that already
 *  carry absolute coordinates (see layoutObjects in scene.ts, which is what is
 *  left of the old render.ts), so a child renders
 *  at its own x/y plus every enclosing group's displacement. Crossing that
 *  boundary — grouping, ungrouping, dragging a layer in or out — has to fold
 *  the displacement in or out, or the layer visibly jumps by exactly that much.
 *  0.5/0.5 is the neutral position, meaning "no displacement". */
export const groupShift = (g: GroupLayer) => ({ dx: g.x - 0.5, dy: g.y - 0.5 });

/** Total displacement every group between `layers` and `id` contributes.
 *  Undefined when the layer is not nested in a group at all. */
export function nestingShift(layers: Layer[], id: string): { dx: number; dy: number } | undefined {
  for (const l of layers) {
    if (l.kind !== "group") continue;
    const own = groupShift(l);
    if (l.children.some((c) => c.id === id)) return own;
    const inner = nestingShift(l.children, id);
    if (inner) return { dx: inner.dx + own.dx, dy: inner.dy + own.dy };
  }
  return undefined;
}

export function shiftLayer(l: Layer, dx: number, dy: number) {
  l.x += dx;
  l.y += dy;
}

/** Takes a layer out of the list it sits in. A group hands its members back to
 *  that list at the same index instead of taking them with it: losing a stack
 *  of layers to one misplaced click on a folder is not a trade anyone makes
 *  knowingly, and dissolving a group has no other button. Members keep the
 *  position they were dissolved at, since the group's displacement is folded
 *  into them on the way out. */
export function removeLayerFrom(list: Layer[] | undefined, id: string) {
  if (!list) return;
  const at = list.findIndex((l) => l.id === id);
  if (at < 0) return;
  const [gone] = list.splice(at, 1);
  if (gone.kind === "group") {
    const { dx, dy } = groupShift(gone);
    for (const child of gone.children) shiftLayer(child, dx, dy);
    list.splice(at, 0, ...gone.children);
  }
}

/** Moves a layer somewhere else in the tree, keeping it where it visibly is.
 *
 *  `parentId` is the group to land in, or null for the top level. `beforeId`
 *  is the layer to land in front of, or null for the end — a position, not an
 *  index, because an index is ambiguous the moment the layer is taken out of
 *  its old slot: "position 2" before or after the removal? A dragged row only
 *  ever knows which row it is above, and that is exactly this.
 *
 *  A group's x/y displaces its members, so crossing a boundary has to swap one
 *  displacement for the other or the layer jumps by the difference — the same
 *  fold `removeLayerFrom` does on the way out of a dissolved group.
 *
 *  Refuses to put a group inside itself, which would otherwise detach the
 *  whole branch from the document with no way to reach it again. */
export function relocateLayer(
  layers: Layer[],
  id: string,
  parentId: string | null,
  beforeId: string | null,
): boolean {
  // Dropped on itself: the anchor is the thing being moved, and it stops
  // existing the moment it is lifted out, which would send it to the end.
  if (beforeId === id) return true;

  const from = findList(layers, id);
  const layer = from && findLayer(from, id);
  if (!from || !layer) return false;

  const parent = parentId ? findLayer(layers, parentId) : undefined;
  if (parentId && parent?.kind !== "group") return false;
  // A group cannot descend into itself or into anything it contains.
  if (layer.kind === "group" && parentId && [...walkLayers([layer])].some((l) => l.id === parentId))
    return false;

  const was = nestingShift(layers, id) ?? { dx: 0, dy: 0 };
  from.splice(from.indexOf(layer), 1);

  const to = parent?.kind === "group" ? parent.children : layers;
  const target = parent?.kind === "group" ? nestingShiftOf(layers, parent) : { dx: 0, dy: 0 };
  shiftLayer(layer, was.dx - target.dx, was.dy - target.dy);

  // Looked up after the removal, so the anchor's index is the one that counts.
  const before = beforeId ? to.findIndex((l) => l.id === beforeId) : -1;
  to.splice(before < 0 ? to.length : before, 0, layer);
  return true;
}

/** Total displacement a group applies to its own children: its own shift plus
 *  every group it sits in. */
function nestingShiftOf(layers: Layer[], group: Layer & { kind: "group" }) {
  const own = groupShift(group);
  const outer = nestingShift(layers, group.id) ?? { dx: 0, dy: 0 };
  return { dx: own.dx + outer.dx, dy: own.dy + outer.dy };
}

/** The array a layer sits in — the list to splice when moving or removing it. */
export function findList(layers: Layer[], id: string): Layer[] | undefined {
  if (layers.some((l) => l.id === id)) return layers;
  for (const l of layers) {
    if (l.kind !== "group") continue;
    const found = findList(l.children, id);
    if (found) return found;
  }
  return undefined;
}

export type Tile = {
  base: Base;
  /** Tile-local layers. A layer whose id matches a shared one is a detached
   *  copy and replaces it on this tile only; anything else is this tile's
   *  alone, drawn on top of whatever its group gives it — which is what lets a
   *  single portrait carry a layout without a group being invented for it. */
  layers: Layer[];
  /** Text content per shared layer — style syncs across tiles, wording does not. */
  text: Record<string, string>;
  /** Picture per shared image layer — and class per shared icon layer, which is
   *  the same idea and shares the map: the layout owns where and how big, the
   *  tile owns which picture or which class. "" means this tile deliberately
   *  shows none. Optional so manifests written before per-tile pictures existed
   *  still load unchanged. */
  swap?: Record<string, string>;
  /** Put away: out of Unsorted, into the archive, still on disk and still
   *  carrying whatever was made for it. Absent is the ordinary state — see
   *  archivedIds, and setArchived for why it is only ever true on a tile no
   *  project has claimed. */
  archived?: boolean;
};

/** A cosmetic drawer in the tile list — "Done", "Season", whatever helps.
 *
 *  Holds tile ids and nothing else. It does not render, does not stamp, and
 *  dissolving one never touches a tile or a layer. That is the whole difference
 *  from the Overlay it replaces, which was a tile set *and* a layer stack at
 *  once — so reorganising the wall meant deleting artwork. */
export type Folder = { id: string; name: string; tiles: string[] };

/** One wall.
 *
 *  The FaceTexture folder is shared by every account on the machine, so "all
 *  the tiles on disk" was never a wall — it was several walls in a heap, and
 *  the app had no way to say which portrait belonged to which. A project is
 *  that answer: which tiles belong together, and in which order.
 *
 *  `order` is the grid, dense: position n is the nth slot, exactly what the
 *  game shows, and it is the coordinate system every renderer indexes by.
 *  `shelf` is everything else the project owns — collected but not placed. The
 *  two are disjoint, and together they are the membership. */
export type Project = {
  id: string;
  name: string;
  order: string[];
  shelf: string[];
  /** Grid-space layers: the picture spread across this wall. All that is left
   *  of the wall itself, and the only place a layer is not tile-local. */
  gridLayers: Layer[];
  folders: Folder[];
};

export const newProject = (name: string): Project => ({
  id: newId(),
  name,
  order: [],
  shelf: [],
  gridLayers: [],
  folders: [],
});

/** Everything a project owns, placed or not. */
export const projectTiles = (p: Project) => [...p.order, ...p.shelf];

/** The project owning this tile, if any. Ownership is exclusive — a character
 *  belongs to one account — so this is an answer, not a list. */
export const projectOf = (m: Manifest, tileId: string) =>
  m.projects.find((p) => p.order.includes(tileId) || p.shelf.includes(tileId));

/** Which of `ids` no project has claimed and nobody has put away. Derived and
 *  never stored: the folder is where ids come from, and a stored inbox would be
 *  a second copy of that list to keep in step with it. */
export const inboxIds = (m: Manifest, folderIds: string[]) =>
  folderIds.filter((id) => !projectOf(m, id) && !m.tiles[id]?.archived);

/** Put away rather than thrown away.
 *
 *  BDO never deletes a portrait file — a character deleted in the game leaves
 *  its picture behind for good — so Unsorted only ever grows, and the faces of
 *  characters that no longer exist sit in it forever. This is the way to say
 *  "not this one, ever" without touching the folder, which Tessera has no
 *  business doing.
 *
 *  Only an unclaimed tile can be archived: a tile in a project has a wall it
 *  belongs to, and "archived but placed" would be a state every count and every
 *  write would have to ask about. Taking it out of the project first is the
 *  existing way, one click that already exists. */
export const archivedIds = (m: Manifest, folderIds: string[]) =>
  folderIds.filter((id) => !projectOf(m, id) && !!m.tiles[id]?.archived);

export function setArchived(m: Manifest, ids: string[], away: boolean) {
  for (const id of ids) {
    const tile = m.tiles[id];
    // Never against a claimed tile, whatever the caller believes.
    if (!tile || projectOf(m, id)) continue;
    if (away) tile.archived = true;
    else delete tile.archived;
  }
}

/** Takes a tile out of every list a project keeps it in, folders included. A
 *  folder still naming a tile the project no longer owns is a row that cannot
 *  be clicked and a count that lies. */
function detach(p: Project, tileId: string) {
  p.order = p.order.filter((t) => t !== tileId);
  p.shelf = p.shelf.filter((t) => t !== tileId);
  for (const f of p.folders) f.tiles = f.tiles.filter((t) => t !== tileId);
}

/** Puts one project's slice of `from` back into `into`, and says how many tiles
 *  had to be taken off another wall to do it.
 *
 *  What a project-scoped snapshot restores: the project record itself — its
 *  order, shelf, folders and grid layers — plus the layers, wording and
 *  pictures on the tiles it owns. Every other project keeps exactly what it
 *  has, which is the whole point of scoping a snapshot to one wall.
 *
 *  The one place it cannot leave others alone is a tile that has since moved:
 *  ownership is exclusive, so putting the old arrangement back means taking
 *  that tile off whichever wall holds it now. Taking one silently changes a wall
 *  the user is not looking at, so this counts them and hands the number back
 *  for the caller to say out loud.
 *
 *  Layouts are deliberately untouched. They are a library shared by every
 *  project, a stamp on a tile is an ordinary picture that renders from its
 *  asset whether or not the Layout still exists, and rolling one wall back is
 *  no reason to resurrect a design another wall is done with. */
export function restoreProjectInto(into: Manifest, from: Manifest, projectId: string): number {
  const src = from.projects.find((p) => p.id === projectId);
  if (!src) return 0;
  const owned = projectTiles(src);

  let taken = 0;
  for (const id of owned) {
    const holder = projectOf(into, id);
    if (!holder || holder.id === projectId) continue;
    detach(holder, id);
    taken++;
  }

  // Back where it was in the list, not at the end: the order of the projects is
  // the order of the cards on the overview, and a rollback should not reshuffle
  // them.
  const at = into.projects.findIndex((p) => p.id === projectId);
  if (at >= 0) into.projects[at] = src;
  else into.projects.push(src);

  for (const id of owned) if (from.tiles[id]) into.tiles[id] = from.tiles[id];
  return taken;
}

/** Hands a tile from whichever project holds it to another, onto its shelf.
 *
 *  The edit state travels for free: layers, wording and pictures live in
 *  `m.tiles` keyed by tile id, which belongs to no project. Only membership
 *  moves, which is why this is three list operations and not a deep copy. */
export function moveToProject(m: Manifest, tileId: string, toId: string): boolean {
  const to = m.projects.find((p) => p.id === toId);
  if (!to || projectTiles(to).includes(tileId)) return false;
  const from = projectOf(m, tileId);
  if (from) detach(from, tileId);
  to.shelf.push(tileId);
  return true;
}

/** Sends a tile back to the inbox.
 *
 *  `wipe` is the difference between "this character left this wall" and "this
 *  id is a different character now". The game reuses a numeric id when a slot
 *  is deleted and refilled, and the layers on it were composed for a face that
 *  no longer exists — keeping them would dress a stranger. Only the caller
 *  knows which happened, which is why this takes the answer rather than
 *  guessing at it. */
export function removeFromProjectToInbox(m: Manifest, tileId: string, wipe: boolean) {
  const p = projectOf(m, tileId);
  if (p) detach(p, tileId);
  if (wipe) m.tiles[tileId] = emptyTile();
}

/** Shelf to grid.
 *
 *  `beforeId` is the placed tile to land in front of, or null for the end — a
 *  position rather than an index, the same vocabulary relocateLayer uses, and
 *  for the same reason: an index is ambiguous once the tile is lifted out of
 *  wherever it was. Dense by construction, because the game's grid has no
 *  holes. */
export function placeTile(p: Project, tileId: string, beforeId: string | null) {
  if (!projectTiles(p).includes(tileId) || tileId === beforeId) return;
  p.shelf = p.shelf.filter((t) => t !== tileId);
  p.order = p.order.filter((t) => t !== tileId);
  const at = beforeId ? p.order.indexOf(beforeId) : -1;
  p.order.splice(at < 0 ? p.order.length : at, 0, tileId);
}

/** Grid back to shelf. The tile keeps everything on it; it gives up its slot,
 *  and the tiles after it close the gap. */
export function unplaceTile(p: Project, tileId: string) {
  if (!p.order.includes(tileId)) return;
  p.order = p.order.filter((t) => t !== tileId);
  p.shelf.push(tileId);
}

/** Swaps two placed tiles.
 *
 *  Swap, not insert: the wall mirrors the in-game character order, which is
 *  hand-built, and inserting would shift every tile after the target — one drag
 *  would then rearrange half the grid. Dropping in from the shelf is the
 *  opposite case and does insert, because there the tile has no slot to trade. */
export function swapPlaced(p: Project, a: string, b: string) {
  const i = p.order.indexOf(a);
  const j = p.order.indexOf(b);
  if (i < 0 || j < 0 || i === j) return;
  [p.order[i], p.order[j]] = [p.order[j], p.order[i]];
}

/* --- Cosmetic folders. A drawer in the tile list, so forty-four rows can be
 * put away as they are finished. It never reaches the canvas: no rendering, no
 * stamping, and dissolving one leaves every tile exactly where it was. --- */

export const newFolder = (name: string): Folder => ({ id: newId(), name, tiles: [] });

/** The drawer a tile is in, if any. One at a time — a tile in two drawers would
 *  appear twice in a list whose whole job is to be scannable. */
export const folderOf = (p: Project, tileId: string) =>
  p.folders.find((f) => f.tiles.includes(tileId));

/** Puts a tile away. Refuses one the project does not own: a drawer naming a
 *  stranger is a row that cannot be clicked. */
export function putInFolder(p: Project, folderId: string, tileId: string): boolean {
  const f = p.folders.find((x) => x.id === folderId);
  if (!f || !projectTiles(p).includes(tileId)) return false;
  for (const other of p.folders) other.tiles = other.tiles.filter((t) => t !== tileId);
  f.tiles.push(tileId);
  return true;
}

/** Back out of the drawer, onto the loose pile. */
export function takeOutOfFolder(p: Project, tileId: string) {
  for (const f of p.folders) f.tiles = f.tiles.filter((t) => t !== tileId);
}

/** Removes the drawer and nothing else. The tiles keep their slots, their
 *  layers and their layouts — which is the entire reason this replaced the
 *  group, where the same click threw artwork away. */
export function dissolveFolder(p: Project, folderId: string) {
  const at = p.folders.findIndex((f) => f.id === folderId);
  if (at >= 0) p.folders.splice(at, 1);
}

/** Of `ids`, the ones no drawer has taken, in the order given. */
export const looseTiles = (p: Project, ids: string[]) => ids.filter((id) => !folderOf(p, id));

/** A tile-sized composition, edited on its own — not on the wall — and kept
 *  around as a reusable document rather than being consumed the moment it is
 *  used. It is never rendered directly onto a tile; it is only ever rendered
 *  to a flat picture and *that* is what gets stamped (see ImageLayer.layoutId
 *  and assignLayout in editor.svelte.ts). That split is deliberate: the layout
 *  keeps its structure, styles and per-layer editability for as long as you
 *  want to keep changing it, while what actually sits on a tile is nothing
 *  more exotic than an ordinary picture, reusing every bit of image-layer
 *  machinery that already exists. */
export type Layout = {
  id: string;
  name: string;
  layers: Layer[];
  /** Fingerprint of `layers` as they were when this Layout was last rendered
   *  and stamped. Absent until the first stamp. Comparing it against the
   *  current fingerprint is what tells "there are changes the tiles have not
   *  seen yet" apart from "the tiles are already showing this". */
  stamped?: string;
};

export const newLayout = (name: string): Layout => ({ id: newId(), name, layers: [] });

/** A copy of a Layout under a new name, with fresh ids all the way down.
 *
 *  The ids have to change. Per-tile wording lives in `tile.text` keyed by layer
 *  id, and `syncLiveLayers` finds the copy of a caption by id — so a duplicate
 *  that kept them would quietly share both with the original, and editing one
 *  would move the other's captions. Mask references are remapped as they are
 *  copied, so they keep pointing inside the duplicate rather than back at the
 *  layer they were cloned from.
 *
 *  `stamped` is deliberately not carried over: the copy has never been put on
 *  a tile, so it has nothing to be out of date with. */
export function duplicateLayout(layout: Layout, name: string): Layout {
  const swap = new Map<string, string>();
  const renumber = (layers: Layer[]): Layer[] =>
    layers.map((l) => {
      const copy = clone(l);
      copy.id = newId();
      swap.set(l.id, copy.id);
      if (copy.kind === "group") copy.children = renumber(copy.children);
      return copy;
    });

  const layers = renumber(layout.layers);
  for (const l of walkLayers(layers)) if (l.maskId) l.maskId = swap.get(l.maskId);
  return { id: newId(), name, layers };
}

/** Copies layers within one Layout, offset a little so the copy is visible.
 *
 *  Fresh ids all the way down, and mask references remapped inside the copied
 *  set — a duplicate pointing back at the original's stencil would move when
 *  the original was edited, which is exactly the surprise duplicating is meant
 *  to avoid. A mask naming something *outside* the set keeps pointing there,
 *  because that layer is still the one meant.
 *
 *  Takes the layers themselves rather than ids, because a selection can name
 *  something nested in a group and only the caller knows which list each one
 *  came out of — the copy has to go back into that same list, or duplicating a
 *  layer inside a group would quietly do nothing.
 *
 *  Names are left to the caller too: only it knows the stack the copies are
 *  about to join, and that is what decides the next free number. */
export function duplicateLayers(picked: Layer[], nudge = 0.02): Layer[] {
  const swap = new Map<string, string>();
  const renumber = (from: Layer[]): Layer[] =>
    from.map((l) => {
      const copy = clone(l);
      copy.id = newId();
      swap.set(l.id, copy.id);
      if (copy.kind === "group") copy.children = renumber(copy.children);
      return copy;
    });

  const copies = renumber(picked);
  for (const l of walkLayers(copies)) {
    if (l.maskId && swap.has(l.maskId)) l.maskId = swap.get(l.maskId);
  }
  /* Only the layers actually picked move: a group's children carry absolute
   * coordinates, and nudging them as well would shift them twice. */
  for (const l of copies) {
    l.x += nudge;
    l.y += nudge;
  }
  return copies;
}

/** Cheap content fingerprint of a Layout's layers.
 *
 *  A hash rather than the JSON itself: the comparison only ever needs to
 *  detect difference, and keeping a second full copy of every layout inside
 *  the manifest would be a lot of bytes to answer one yes/no question. */
export function layoutFingerprint(layout: Layout): string {
  const json = JSON.stringify(layout.layers);
  let h = 5381;
  for (let i = 0; i < json.length; i++) h = ((h * 33) ^ json.charCodeAt(i)) >>> 0;
  // Length alongside the hash, so two different layouts colliding on the hash
  // still have to also match in size before being called identical.
  return `${h.toString(36)}-${json.length.toString(36)}`;
}

/** Whether this Layout has edits the stamps on the tiles do not show yet.
 *  False for one never stamped: there is nothing to bring up to date, and the
 *  action for that case is stamping it somewhere in the first place. */
export const layoutNeedsRestamp = (layout: Layout) =>
  layout.stamped !== undefined && layout.stamped !== layoutFingerprint(layout);

/** Tiles are global, keyed by the id the game gave them; projects only say
 *  which wall an id belongs to. That split is what lets a tile move between
 *  projects without its layers, wording or pictures going anywhere. */
export type Manifest = {
  version: 7;
  projects: Project[];
  tiles: Record<string, Tile>;
  layouts: Layout[];
};

export const emptyTile = (): Tile => ({ base: null, layers: [], text: {} });

export const emptyManifest = (): Manifest => ({
  version: 7,
  projects: [],
  tiles: {},
  layouts: [],
});

/** Somewhere a stamp can sit, paired with the tiles it reaches.
 *
 *  There are two such places and they are deliberately not the same type: a
 *  group's stack, and one tile's own. Everything that acts on stamps — refresh,
 *  count, delete — has to reach both, and having each of them ask "wall or
 *  tile?" separately is how one of the two quietly gets left out. */
export type StampHolder = { layers: Layer[]; tiles: string[] };

/** Every such place in the document — one tile's own stack, and that is now the
 *  only kind. Kept as a named concept because refresh, count and delete all ask
 *  the same question, and asking it three times separately is how one of them
 *  quietly stops matching the others. */
function stampHolders(m: Manifest): StampHolder[] {
  return Object.entries(m.tiles).map(([id, t]) => ({ layers: t.layers, tiles: [id] }));
}

/** Every place holding a stamp of this layout — what "Update stamps" has to
 *  refresh, and how many pictures are left behind if the layout is deleted. */
export function holdersUsingLayout(m: Manifest, layoutId: string): StampHolder[] {
  return stampHolders(m).filter((h) =>
    h.layers.some((l) => l.kind === "image" && l.layoutId === layoutId),
  );
}

/** How many portraits actually carry this layout.
 *
 *  The other number — how many places hold a stamp — is what a refresh or a
 *  delete touches, but it says nothing about how much of the wall is at stake:
 *  one group of fifteen tiles read as "stamped 1 time" while fifteen portraits
 *  wore the design. */
export function tilesUsingLayout(m: Manifest, layoutId: string): number {
  return holdersUsingLayout(m, layoutId).reduce((n, h) => n + h.tiles.length, 0);
}

/** Puts a rendered stamp of `layoutId` into a layer stack — a group's or one
 *  tile's own; it needs nothing from either but the list.
 *
 *  Re-stamping the same layout onto the same tiles replaces that stamp's
 *  picture rather than stacking a second copy on top of the first — which
 *  would look like nothing happened while quietly doubling the layer count. */
export function stampInto(into: { layers: Layer[] }, layoutId: string, asset: string): ImageLayer {
  // Not a live picture the same Layout keeps on these tiles: that also carries
  // this layoutId, and grabbing it here would overwrite a per-tile logo with
  // the whole flattened sheet.
  const existing = into.layers.find(
    (l): l is ImageLayer => l.kind === "image" && l.layoutId === layoutId && !l.live,
  );
  if (existing) {
    existing.asset = asset;
    return existing;
  }
  const stamp = newImageLayer(asset);
  stamp.layoutId = layoutId;
  /* A stamp is rendered at exactly tile resolution, so 1 is the only scale that
   * reproduces the Layout as it was composed. newImageLayer's smaller default
   * is for a picture dropped in by hand, where landing full-bleed would be
   * wrong — here it shrank the whole sheet to a patch in the middle of the
   * tile, which reads as "the stamp did not arrive". */
  stamp.scale = 1;
  into.layers.push(stamp);
  return stamp;
}

/** Points every stamp of `layoutId` at a freshly rendered picture, wherever it
 *  sits. Returns how many were refreshed — a design used in several places has
 *  to update everywhere at once, not be re-stamped by hand at each. */
export function refreshStamps(m: Manifest, layoutId: string, asset: string): number {
  let n = 0;
  for (const h of stampHolders(m)) {
    for (const l of h.layers) {
      /* `!l.live` for the reason stampInto states: a live copy is a per-tile
         picture or a cutter that travelled, and pointing it at the flattened
         sheet would replace what the tile chose. syncLiveLayers happened to
         repair it straight afterwards, which made the count wrong ("36 stamp(s)
         updated" for twelve) and the correctness a matter of call order. */
      if (l.kind === "image" && l.layoutId === layoutId && !l.live) {
        l.asset = asset;
        n++;
      }
    }
  }
  return n;
}

const newId = () => Math.random().toString(36).slice(2, 10);

const common = (id = newId()): Common => ({
  id,
  x: 0.5,
  y: 0.5,
  rotation: 0,
  opacity: 1,
});

export const DEFAULT_IMAGE_SCALE = 0.3;
export const DEFAULT_TEXT_SIZE = 0.08;
export const DEFAULT_SHAPE_SIZE = 0.3;

export const newImageLayer = (asset: string): ImageLayer => ({
  ...common(),
  kind: "image",
  asset,
  scale: DEFAULT_IMAGE_SCALE,
  flipX: false,
  flipY: false,
});

export const newShapeLayer = (shape: ShapeKind, icon?: string): ShapeLayer => ({
  ...common(),
  kind: "shape",
  shape,
  ...(icon ? { icon } : {}),
  w: DEFAULT_SHAPE_SIZE,
  h: DEFAULT_SHAPE_SIZE,
  cornerRadius: 0,
  sides: 6,
  fill: "#ffffff",
  borderColor: "#000000",
  borderWidth: 0,
});

export const newGroupLayer = (children: Layer[] = []): GroupLayer => ({
  ...common(),
  kind: "group",
  children,
});

export const newTextLayer = (): TextLayer => ({
  ...common(),
  kind: "text",
  /* Plain word, not the "{{id}}" placeholder: that default made an emptied
   * field snap back to literal braces the user then could not clear. The
   * placeholder still works, it just has to be typed on purpose. */
  text: "Text",
  font: "Segoe UI",
  size: DEFAULT_TEXT_SIZE,
  /* New captions start at their anchor and grow to the right. Existing layers
   * carry no align and keep falling back to "center", so this changes what is
   * created from now on rather than re-laying-out anyone's finished tiles. */
  align: "left",
  color: "#ffffff",
  strokeColor: "#000000",
  strokeWidth: 0,
  shadow: 0,
  shadowColor: "#000000",
  y: 0.9,
});

const LAYER_PREFIX: Record<Layer["kind"], string> = {
  image: "img",
  text: "text",
  shape: "shape",
  group: "group",
};

/* A shape is named after what it is, and for an icon that is the class rather
 * than the word "icon": a stack of Ranger01, Witch01, Witch02 says what is in
 * it at a glance. Spaces go, so "Dark Knight" numbers as DarkKnight01 and reads
 * like every other layer name. */
const prefixOf = (l: Layer) =>
  l.kind !== "shape"
    ? LAYER_PREFIX[l.kind]
    : l.shape === "icon"
      ? (l.icon ?? "icon").replace(/\s+/g, "")
      : l.shape;

/** Names a layer for the stack it is about to join: img01, text01, img02.
 *
 *  The count comes off a hidden `seq`, never off the names, because renaming
 *  is the whole point of a name: img02 renamed to "classIcon" is still the
 *  second picture, and a third one arriving as img02 would sit in the list
 *  beside a name that no longer says so. Per stack, so a Layout counts for
 *  itself and the wall for itself — the two are never read together.
 *
 *  A stack written before any of this carries no numbers at all and starts
 *  again at one. Nothing is renamed for it: a name someone typed is theirs. */
export function nameInStack(layer: Layer, layers: Layer[]) {
  /* A shape is named for the shape it is. Rectangle, ellipse and polygon all
   * came out "shapeNN", which in a list of five is three kinds of thing wearing
   * one name and no icon to tell them apart. */
  const prefix = prefixOf(layer);
  // Counted per prefix, not per kind: sharing one counter across all shapes
  // made the first rectangle beside a polygon come out "rect02", with no
  // rect01 anywhere to explain it.
  let n = 0;
  for (const l of walkLayers(layers)) if (prefixOf(l) === prefix) n = Math.max(n, l.seq ?? 0);
  layer.seq = n + 1;
  layer.name = `${prefix}${String(layer.seq).padStart(2, "0")}`;
}

/** Every shape in this Layout that some layer is using as a mask.
 *
 *  A stencil stops drawing itself the moment it is one: it is the hole, not
 *  something in the picture. Asked once per render, and once by the list so a
 *  shape that has vanished from the canvas can say why. */
export const stencilIds = (layers: Layer[]): Set<string> => {
  const all = [...walkLayers(layers)];
  const by = (id: string) => all.find((l) => l.id === id);
  return new Set(
    all
      // A switched-off layer is not cutting anything, so the shape it names is
      // an ordinary shape again — otherwise it would sit there invisible with
      // nothing on screen to say why.
      .filter((l) => !l.hidden)
      /* And a named cutter that the renderer refuses is not cutting either.
       * This used to be the one place that made a layer invisible without
       * knowing the rule, so a cutter whose consumer had just been switched to
       * per-tile paid the price — gone from the Layout — without doing the
       * work: on the tile nothing named it and it drew in full. Editor and wall
       * showed two different pictures. */
      .filter((l) => cutApplies(l, l.maskId ? by(l.maskId) : undefined))
      .map((l) => l.maskId)
      .filter((id): id is string => !!id),
  );
};

/** What a layer may be cut to: anything else in this Layout that draws.
 *
 *  A shape cuts with its outline, a picture with the pixels it actually has —
 *  a PNG badge is mostly transparent, and clipping to the box it arrived in
 *  would defeat the point — and a caption with its letters.
 *
 *  Groups are out: a group is a displacement, not a picture, and it draws
 *  nothing of its own to cut with. Itself is out too, since a layer clipped to
 *  its own outline is either a no-op or an empty picture.
 *
 *  So is anything editable in the grid. Its content is different on every tile
 *  by design, so it cannot be the thing that decides one shape — and it is
 *  stripped out of the stamp entirely, which had the editor clipping with it
 *  while the picture written to the game did not.
 *
 *  Two layers masking each other is left possible — both become stencils,
 *  nothing draws, and one click puts it back. */
/** Whether `cutter` actually cuts `l` — the single answer four places need.
 *
 *  A cutter that is editable in the grid says something different on every
 *  tile, so what it cuts has to be resolved per tile as well. That is exactly
 *  what a per-tile layer is: both travel to the tile, and the cut is computed
 *  there against this tile's own words. A stamped layer cannot use one — the
 *  stamp is a single picture shared by every wall tile, and there is no shared
 *  answer to "which letters".
 *
 *  Written once and asked by the dropdown, the renderer, the stencil rule and
 *  the copy that travels to the tile, because a rule that four places state in
 *  their own words is a rule that will disagree with itself — and it did: the
 *  stencil rule was the one that had never heard of `perTile`. */
export const cutApplies = (l: Layer, cutter: Layer | undefined): boolean =>
  !!cutter && cutter.kind !== "group" && cutter.id !== l.id && (!cutter.perTile || !!l.perTile);

export const maskChoices = (layers: Layer[], layerId: string): Layer[] => {
  const self = findLayer(layers, layerId);
  return self ? [...walkLayers(layers)].filter((l) => cutApplies(self, l)) : [];
};

export const layerLabel = (l: Layer) => {
  if (l.name) return l.name;
  if (l.kind === "text") return l.text;
  if (l.kind === "shape") return l.shape;
  if (l.kind === "group") return l.kind;
  return l.asset.replace(/\.[^.]+$/, "").slice(0, 8);
};

/** What a tile draws, bottom-first.
 *
 *  One line, and it used to be twenty: a tile inherited from every overlay
 *  covering it, with per-tile copies replacing inherited layers by id. Layouts
 *  are assigned per tile now, so a tile's own stack is the whole story — and a
 *  layer exists in exactly one place, which is what retired the "moved one
 *  copy, the other four are stale" class of bug outright. Grid-space layers
 *  belong to the project and are drawn once over the whole wall, not per tile. */
export const resolveLayers = (m: Manifest, id: string): Layer[] => m.tiles[id]?.layers ?? [];

/** What one tile's copy of a caption actually says.
 *
 *  `??` and not `||`: an override of "" means the user emptied this tile's
 *  caption on purpose and it has to stay empty. Falling back on a falsy value
 *  would put the layer's default text back the moment the last character was
 *  deleted — so an override is only absent when its key is absent, and
 *  clearing the field stores "" rather than removing it. */
export const layerText = (texts: Record<string, string>, layer: TextLayer, tileId: string) =>
  (texts[layer.id] ?? layer.text).replaceAll("{{id}}", tileId);

/** Which picture one tile shows for a live image layer, or "" for none.
 *
 *  Same `??` reasoning as layerText: "" is a real answer — this tile shows no
 *  logo on purpose — and only an absent key falls back to the layer's own
 *  picture. `||` here would put the default back the moment someone chose
 *  "none". */
export const layerAsset = (swaps: Record<string, string>, layer: ImageLayer) =>
  swaps[layer.id] ?? layer.asset;

/** Which class one tile shows for a live icon layer, or "" for none.
 *
 *  The same map as a picture's, one kind over. A wall of characters is the
 *  reason the icons exist at all: one layer, placed and coloured once in the
 *  Layout, and each portrait naming its own class. Stored by name — the
 *  artwork ships with the application, so there is nothing to import and
 *  nothing to carry. */
export const layerIcon = (swaps: Record<string, string>, layer: ShapeLayer) =>
  swaps[layer.id] ?? layer.icon;

/** A layer a Layout keeps live on the tiles instead of baking into its stamp.
 *  Text carries its own wording per tile, an image its own picture — the same
 *  bargain either way: the Layout owns how it looks, the tile owns what it
 *  says or shows.
 *
 *  A shape is in the club for a quieter reason: it has no per-tile content of
 *  its own, but the thing that cuts it can — a gradient block cut by each
 *  character's own class icon. The rule says a per-tile cutter may only cut a
 *  per-tile layer, and without this a shape could never satisfy it: the
 *  checkbox did not exist for shapes, so the combination was simply
 *  unreachable and the mask fell off as "no longer allowed". */
export type LiveLayer = TextLayer | ImageLayer | ShapeLayer;

/** Is this layer on a tile a Layout's live copy, rather than its stamp?
 *
 *  Both carry the same layoutId and both can be images, so kind alone cannot
 *  tell them apart — `live` is what says which is which. Text counts either
 *  way: a stamp is never text, and captions stamped before `live` existed
 *  carry no flag at all.
 *
 *  One rule, because three places ask it: the withdrawal pass below, and the
 *  tile list, which speaks for a Layout with a single row. Written twice, the
 *  list's copy said "text" where this one says "a copy" — so a per-tile
 *  picture appeared as a second row for the same layout. */
export const isLiveCopy = (l: Layer) => !!l.layoutId && (!!l.live || l.kind === "text");

const perTileLayers = (layout: Layout): LiveLayer[] =>
  [...walkLayers(layout.layers)].filter((l): l is LiveLayer => l.kind !== "group" && !!l.perTile);

/** The Layout as it goes into the stamp: everything except the live captions.
 *
 *  Groups are rebuilt without their live members rather than dropped, so the
 *  displacement a group applies to its remaining children still holds. */
export function bakeable(layout: Layout): Layout {
  const keep = (layers: Layer[]): Layer[] =>
    layers
      .filter((l) => !(l.kind !== "group" && l.perTile))
      .map((l) => (l.kind === "group" ? { ...l, children: keep(l.children) } : l));
  return { ...layout, layers: keep(layout.layers) };
}

/** Puts a Layout's live captions on the tile, beside its stamp, and takes
 *  away the ones it no longer has.
 *
 *  Ids are carried over deliberately: per-tile wording lives in `tile.text`
 *  keyed by layer id, so keeping the id is what lets a caption be repositioned
 *  or restyled in the Layout without every tile losing what it says.
 *
 *  A caption nested in a group renders at its own position plus that group's
 *  displacement; there is no group on the tile, so the displacement is folded
 *  in on the way over — the same fold removeLayerFrom does when a group is
 *  dissolved. */
/** The layers a live copy needs beside it to look the way it did in the Layout.
 *
 *  Only one so far: the shape it is cut by. A per-tile layer leaves the Layout
 *  and the thing that cuts it does not, so on the tile its `maskId` used to
 *  resolve to nothing and the picture came back whole — which is why the two
 *  settings locked each other out. Sending the cutter along is what unlocks
 *  them.
 *
 *  Nested cutters get the same fold as the layer itself: there are no groups on
 *  a tile, so the displacement has to be baked into the position on the way
 *  over or the cut lands somewhere else entirely.
 *
 *  A cutter that is itself editable in the grid needs no copy from here: it is
 *  already on its way over as a live layer of its own, wording and all. What it
 *  may not do is cut something that stays behind in the stamp — cutApplies is
 *  where that is decided, for this and for every other reader. */
function cuttersFor(live: LiveLayer[], layout: Layout): Layer[] {
  const out: Layer[] = [];
  const travelling = new Set(live.map((l) => l.id));
  for (const l of live) {
    if (!l.maskId) continue;
    const cutter = findLayer(layout.layers, l.maskId);
    if (!cutApplies(l, cutter) || !cutter) continue;
    /* A cutter that is per-tile in its own right is already on its way over as
     * a live layer — the loop below copies it, wording and all. Copying it
     * here as well would just write the same id twice. */
    if (travelling.has(cutter.id) || out.some((x) => x.id === cutter.id)) continue;
    const shift = nestingShift(layout.layers, cutter.id) ?? { dx: 0, dy: 0 };
    out.push({ ...clone(cutter), x: cutter.x + shift.dx, y: cutter.y + shift.dy });
  }
  return out;
}

export function syncLiveLayers(into: { layers: Layer[] }, layout: Layout): number {
  const live = perTileLayers(layout);
  const cutters = cuttersFor(live, layout);
  // Both kept, so the withdrawal pass below leaves the cutters standing for as
  // long as something on the tile is still cut by them.
  const wanted = new Set([...live, ...cutters].map((l) => l.id));

  for (const cutter of cutters) {
    const copy: Layer = { ...cutter, layoutId: layout.id, perTile: undefined, live: true };
    const at = into.layers.findIndex((l) => l.id === cutter.id);
    if (at >= 0) into.layers[at] = copy;
    else into.layers.push(copy);
  }

  for (const src of live) {
    const shift = nestingShift(layout.layers, src.id) ?? { dx: 0, dy: 0 };
    const copy: LiveLayer = {
      ...clone(src),
      x: src.x + shift.dx,
      y: src.y + shift.dy,
      layoutId: layout.id,
      // Meaningless once it is on a tile, where a live layer is live by
      // construction — and `live` is what says so.
      perTile: undefined,
      live: true,
    };
    const at = into.layers.findIndex((l) => l.id === src.id);
    if (at >= 0) into.layers[at] = copy;
    else into.layers.push(copy);
  }

  /* Withdraw the copies this Layout no longer keeps live. `live` is what keeps
   * the stamp out of it: the stamp is an image carrying the same layoutId, and
   * a rule written on kind and layoutId alone would delete the whole design
   * the moment a per-tile picture was switched off. */
  for (let i = into.layers.length - 1; i >= 0; i--) {
    const l = into.layers[i];
    if (isLiveCopy(l) && l.layoutId === layout.id && !wanted.has(l.id)) into.layers.splice(i, 1);
  }
  return live.length;
}

/** Brings a manifest into line with the folder it belongs to.
 *
 *  Characters get created and deleted between sessions — and a folder can be
 *  deleted wholesale, which BDO answers by regenerating it with different ids.
 *  The folder always wins: what it no longer has, the manifest stops naming.
 *
 *  Every list naming a tile is pruned — a project's grid and shelf, and the
 *  cosmetic folders inside it — because a project keeping an id nothing has
 *  leaves a hole in the wall and a row that cannot be clicked. An emptied
 *  project or folder is left standing: deleting someone's wall because a
 *  character was deleted is not a decision the folder gets to make.
 *
 *  Ids the folder has and no project claims simply become the inbox, which is
 *  derived rather than stored and so needs nothing done to it here.
 *
 *  Pure surgery, no filesystem: loadManifest supplies the ids. */
export function pruneToFolder(m: Manifest, ids: string[]): Manifest {
  const has = new Set(ids);
  for (const id of Object.keys(m.tiles)) if (!has.has(id)) delete m.tiles[id];
  for (const id of ids) m.tiles[id] ??= emptyTile();
  for (const p of m.projects) {
    p.order = p.order.filter((id) => has.has(id));
    p.shelf = p.shelf.filter((id) => has.has(id));
    for (const f of p.folders) f.tiles = f.tiles.filter((id) => has.has(id));
  }
  return m;
}

/** Which of the tiles `pruneToFolder` is about to delete carry work — layers, a
 *  baked picture, wording, or a per-tile swap.
 *
 *  The prune is right: the folder wins. What was wrong is that it happened in
 *  silence. A character deleted in BDO, or a folder the game regenerated with
 *  new numbers, takes an evening of layers with it, and the undo history is
 *  cleared on the same open — so nothing on screen ever said a thing was gone.
 *  The caller asks this first, puts the un-pruned document aside as a snapshot,
 *  and says so.
 *
 *  An untouched tile is not work: every id in the folder gets an empty tile on
 *  load, and reporting those would mean a warning on every ordinary open. */
export function droppedWork(m: Manifest, ids: string[]): string[] {
  const has = new Set(ids);
  return Object.keys(m.tiles).filter((id) => {
    const t = m.tiles[id];
    if (has.has(id) || !t) return false;
    return (
      !!t.base ||
      t.layers.length > 0 ||
      Object.keys(t.text).length > 0 ||
      Object.keys(t.swap ?? {}).length > 0
    );
  });
}

/** Drops every layer whose `layoutId` names a layout the library no longer has,
 *  on every tile, and says how many went.
 *
 *  The enforcement of one rule: a layout and its layers on the wall do not
 *  survive each other. Deleting a layout cascades through this, and it runs
 *  again on every open — because there are ways for dead references to arrive
 *  that no cascade can see: manifests written before the cascade existed, and a
 *  project snapshot bringing back stamps of a layout deleted since it was
 *  taken. Without the sweep those sat on the tiles as pictures nothing could
 *  name, which on a real wall was sixteen layers nobody could account for.
 *
 *  Top-level only, which is where every stamp and live copy lives — stampInto
 *  and syncLiveLayers push into the tile's own list, never into a group.
 *
 *  The wording and the per-tile picture go with the layer, because both are
 *  keyed by layer id and the layer is what reaches them. Only here, though, and
 *  deliberately not when a Layout merely switches a caption off: there the same
 *  id comes back the moment it is switched on again, and with it every word
 *  that was typed on every tile. A deleted Layout has no way back. */
export function pruneDeadLayoutRefs(m: Manifest): number {
  const alive = new Set(m.layouts.map((l) => l.id));
  let dropped = 0;
  for (const tile of Object.values(m.tiles)) {
    const before = tile.layers.length;
    const gone = tile.layers.filter((l) => l.layoutId && !alive.has(l.layoutId));
    tile.layers = tile.layers.filter((l) => !l.layoutId || alive.has(l.layoutId));
    for (const l of gone) {
      delete tile.text[l.id];
      delete tile.swap?.[l.id];
    }
    dropped += before - tile.layers.length;
  }
  return dropped;
}

/** Drops live layers whose stamp is gone.
 *
 *  A Layout keeps its per-tile captions and pictures beside the stamp it
 *  rendered, and syncLiveLayers is only ever called where a stamp of the same
 *  layout already sits. So a live layer whose layoutId has no stamp in the same
 *  stack cannot have been put there on purpose — it is what deleting the stamp
 *  left behind, before the delete learned to take them along.
 *
 *  Invisible ones, at that: the list hides live captions because the stamp row
 *  speaks for them, and with no stamp row nothing did. Four tiles on the real
 *  wall carried captions that rendered, could not be selected, and could not be
 *  deleted. Run on load, so a wall repairs itself rather than needing the user
 *  to go looking. */
export function dropOrphanLiveLayers(tile: Tile): number {
  const stamped = new Set(
    tile.layers.filter((l) => l.kind === "image" && l.layoutId && !l.live).map((l) => l.layoutId),
  );
  const before = tile.layers.length;
  tile.layers = tile.layers.filter((l) => !(l.layoutId && !stamped.has(l.layoutId)));
  return before - tile.layers.length;
}

/** A stamp and every live layer the same Layout keeps beside it.
 *
 *  The list shows one row for the lot, so everything that row does — hide,
 *  delete — has to reach the copies as well: they have no row of their own,
 *  and a caption left drawing on the wall with nothing to switch it off is
 *  precisely the bug this has already produced twice.
 *
 *  Anything that is not a stamp is a family of one, which is what keeps the
 *  callers free of special cases. */
export function stampFamily(layers: Layer[], stampId: string): Layer[] {
  const stamp = layers.find((l) => l.id === stampId);
  if (!stamp) return [];
  const owner = stamp.kind === "image" && !stamp.live ? stamp.layoutId : undefined;
  return layers.filter(
    (l) => l.id === stampId || (owner !== undefined && l.layoutId === owner && isLiveCopy(l)),
  );
}

/** Deletes a stamp and every live layer the same Layout keeps beside it.
 *
 *  They are copies the Layout owns, not artwork of the tile's own: without the
 *  stamp they belong to nothing. One click, one undo step, the whole
 *  assignment gone. */
export function deleteStampCascade(layers: Layer[], stampId: string): number {
  const doomed = new Set(stampFamily(layers, stampId).map((l) => l.id));
  /* Spliced in place rather than returned as a new array: the caller hands us a
   * live Svelte $state array. Backwards, so removing one does not shift the
   * index of the next. */
  for (let i = layers.length - 1; i >= 0; i--) if (doomed.has(layers[i].id)) layers.splice(i, 1);
  return doomed.size;
}

/** Writes baked crops into their tiles' `base` and removes the mosaic layer
 *  that produced them — a mosaic in place is a background, not a floating
 *  object, and should not keep sitting on top of other layers once it is
 *  where it belongs.
 *
 *  Pure Manifest surgery, no asset loading or canvas involved, which is what
 *  lets the whole effect of "Apply" be tested without Tauri: only reading
 *  the picture's natural pixel size (to feed mosaicBakeCrops) needs it. */
export function bakeMosaicInto(
  m: Manifest,
  project: Project,
  layerId: string,
  asset: string,
  crops: Map<number, Crop>,
) {
  /* The crop map is keyed by grid index, so it and the project must be the same
   * one mosaicBakeCrops was measured against — that is why the project is
   * passed rather than a loose id list. */
  for (const [index, crop] of crops) {
    const id = project.order[index];
    if (m.tiles[id]) m.tiles[id].base = { asset, crop };
  }
  removeLayerFrom(project.gridLayers, layerId);
}

/** Drops every baked mosaic background, so each tile shows its own portrait
 *  again. Returns how many had one.
 *
 *  bakeMosaicInto was deliberately one-way — a mosaic in place is a background,
 *  and repositioning it means baking a new picture over the old. That held
 *  until a wall came back from an earlier session with all forty-four
 *  backgrounds set and nothing anywhere that could clear one: undo had long
 *  since been dropped with the session, and `background()` never even reads the
 *  portrait while a base is there. From the outside that is indistinguishable
 *  from an app that cannot load its own folder.
 *
 *  The pixels were never at risk — the originals sit in the vault and in the
 *  game folder, and the mosaic keeps its content-addressed asset — so this
 *  gives back the only thing that was actually lost, which is the way out. */
export function clearBases(m: Manifest, ids?: string[]): number {
  /* Bounded by the wall it was pressed on. Document-wide it reached across
   * accounts: the button sits in one project's toolbar, its tooltip says "every
   * tile", and a user with three walls read that as "every tile of this one" —
   * while it cleared mosaics off projects that were not even on screen, where
   * the Ctrl+Z that would have caught it is invisible. */
  const wanted = ids && new Set(ids);
  let n = 0;
  for (const [id, tile] of Object.entries(m.tiles)) {
    if (!tile.base || (wanted && !wanted.has(id))) continue;
    tile.base = null;
    n++;
  }
  return n;
}

type Raw = Record<string, unknown>;

/** Anything older than v6 arrives as a clean slate.
 *
 *  There used to be a chain here, converting each version's idea of a shared
 *  stack into the next one's. All of it built overlays, and v6 keeps none —
 *  the editors that made them are gone, and what came through was a mixture
 *  nobody could work with: groups from a mode that no longer exists, layers
 *  pinned straight onto a tile with no list that could show or delete them,
 *  and captions keyed to layers that had stopped existing. The tile-local
 *  layers only became visible at all once the renderer learned to draw text,
 *  at which point they surfaced as words with no explanation and no way out.
 *
 *  Three things are carried over, because they are the ones that cannot be
 *  redone in a minute:
 *  - `order`, built by hand to match the game's own arrangement,
 *  - `hidden`,
 *  - each tile's `base`, which is a background rather than a group or a layer.
 *    v1 kept that as a bare {asset, crop} directly under the tile id; every
 *    later version under `base`, so both shapes are accepted.
 *
 *  Layouts survive as designs, minus their `stamped` fingerprint: nothing is
 *  stamped any more, so claiming otherwise would grey out the one button that
 *  puts them back on the wall. */
function toV6(m: Raw): Raw {
  const tiles: Record<string, Tile> = {};
  for (const [id, raw] of Object.entries((m.tiles ?? {}) as Record<string, Tile | Base>)) {
    const base = raw && "asset" in raw ? (raw as NonNullable<Base>) : ((raw as Tile)?.base ?? null);
    tiles[id] = { ...emptyTile(), base };
  }
  const layouts = ((m.layouts ?? []) as Layout[]).map(({ stamped: _dropped, ...rest }) => rest);
  return {
    version: 6,
    order: (m.order as string[]) ?? [],
    hidden: (m.hidden as string[]) ?? [],
    overlays: [],
    tiles,
    layouts,
  };
}

/** A v6 overlay, kept only so the migration can read one. Nothing else in the
 *  codebase knows the type any more. */
type V6Overlay = { id: string; name: string; tiles: string[] | "all"; layers: Layer[] };

/** v6 → v7: everything lands in one project called "Main".
 *
 *  The arrangement is what must survive. `order` was built by hand to match the
 *  game's own grid — half an hour of dragging that nobody should repeat — so it
 *  becomes Main's grid verbatim. Hidden tiles keep their membership but give up
 *  their slot: the grid is dense now, and `hidden` was only ever a way of
 *  keeping a tile out of it.
 *
 *  Overlays are folded down onto the tiles they covered, because there is
 *  nowhere else left for them to live. A group's stack is copied onto each
 *  member — cloned, or all of them would share one layer object and moving one
 *  would move the lot — keeping layer ids, since per-tile wording and pictures
 *  are keyed by exactly those. Where a tile already had its own copy of a
 *  layer, that copy wins: it is what v6's resolveLayers drew, and a migration
 *  must not change what anyone sees. Grid-space layers go to the project, which
 *  is where a picture spread across the wall belongs now.
 *
 *  Then every tile is swept for live layers whose stamp is gone. Four tiles on
 *  the real wall carried captions that rendered but could be neither selected
 *  nor deleted, and a migration is the right place to stop carrying them. */
function toV7(m: Raw): Raw {
  /* Deep, not a spread: the tiles are rewritten in place below — layers
   * prepended, orphans swept — and a shallow copy hands back the caller's own
   * objects to do it to. A migration that edits its input is a trap for every
   * caller that reads a file once and migrates it twice. */
  const tiles = clone((m.tiles ?? {}) as Record<string, Tile>);
  const overlays = (m.overlays ?? []) as V6Overlay[];
  const order = (m.order as string[]) ?? [];
  const hidden = new Set((m.hidden as string[]) ?? []);

  const main = newProject("Main");
  main.order = order.filter((id) => !hidden.has(id));
  main.shelf = order.filter((id) => hidden.has(id));

  /* Gathered per tile before anything is written, so one overlay's layers keep
   * their order among themselves. Prepending them one at a time as they were
   * found would have reversed every stack. */
  const inherited = new Map<string, Layer[]>();
  for (const o of overlays) {
    const covered = o.tiles === "all" ? order : o.tiles;
    for (const l of o.layers) {
      if (l.space === "grid") {
        main.gridLayers.push(clone(l));
        continue;
      }
      for (const id of covered) {
        const list = inherited.get(id) ?? [];
        list.push(clone(l));
        inherited.set(id, list);
      }
    }
  }
  for (const [id, list] of inherited) {
    const tile = (tiles[id] ??= emptyTile());
    const own = new Set(tile.layers.map((l) => l.id));
    tile.layers = [...list.filter((l) => !own.has(l.id)), ...tile.layers];
  }

  for (const tile of Object.values(tiles)) dropOrphanLiveLayers(tile);

  return { version: 7, projects: [main], tiles, layouts: (m.layouts ?? []) as Layout[] };
}

export function migrate(raw: unknown): Manifest {
  const m = raw as Raw | null;
  if (!m || typeof m !== "object") return emptyManifest();
  if (m.version === 7) return { ...emptyManifest(), ...m } as Manifest;
  return { ...emptyManifest(), ...toV7(m.version === 6 ? m : toV6(m)) } as Manifest;
}
