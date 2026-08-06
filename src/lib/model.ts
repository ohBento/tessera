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
};

/** Anywhere a colour can be picked, a gradient is allowed instead. */
export type Paint = string | Gradient;

export const isGradient = (paint: Paint): paint is Gradient => typeof paint !== "string";

export const newGradient = (): Gradient => ({ from: "#ffffff", to: "#000000", angle: 0 });

/** Geometry is stored as fractions of the tile, never pixels: the tile size is
 *  configurable, and px values would break every layout the moment it changes. */
type Common = {
  id: string;
  x: number; // centre, 0..1 of tile width
  y: number; // centre, 0..1 of tile height
  rotation: number; // degrees
  opacity: number; // 0..1
  blend: GlobalCompositeOperation;
  /* Optional so manifests written before these existed still load unchanged. */
  name?: string;
  locked?: boolean;
  hidden?: boolean;
  /* Which coordinate space x/y (and any size) are fractions of. Absent means
   * "tile", so every manifest written before this loads unchanged. A "grid"
   * layer spans the whole wall — it is placed once, not per tile, which is why
   * the mosaic needs no mechanism of its own. Only meaningful on a
   * project-scope layer: a tile-local one has no grid to span. */
  space?: "tile" | "grid";
  /* Glow is a shadow with no offset but its own alpha, which Canvas2D's shadow
   * API cannot express — it is composited as a separate pass instead. */
  glow?: number; // blur radius as a fraction of tile width, 0 or absent = off
  glowColor?: Paint;
  glowOpacity?: number; // 0..1, independent of the layer's own opacity
  /* A shape layer's id to clip this layer to. A dangling id (the shape got
   * deleted) simply fails to resolve at render time and the layer draws
   * unclipped — no cleanup pass needed on delete. Lives on Common so both
   * image and text layers can use it. */
  maskId?: string;
  /* Set on anything a Layout put here: the picture rendered from it, and any
   * caption it keeps live. Lets one Layout find every copy of itself across
   * every overlay and bring them all up to date in one pass. Absent on a layer
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

export type ImageLayer = Common & {
  kind: "image";
  asset: string;
  scale: number;
  /* Optional so manifests saved before flipping existed still load unchanged. */
  flipX?: boolean;
  flipY?: boolean;
};

export type ShapeKind = "rect" | "ellipse" | "polygon";

export type ShapeLayer = Common & {
  kind: "shape";
  shape: ShapeKind;
  w: number; // fraction of tile width
  h: number; // fraction of tile height
  cornerRadius: number; // 0..0.5 of min(w,h); rect only
  sides: number; // polygon only; rotation reuses the common field
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
};

/** Children keep their own tile-absolute coordinates; the group's x/y is a
 *  translation applied on top, so moving a group shifts everything inside it
 *  without rewriting a single child position. Its opacity/blend apply to
 *  the flattened result, which is what makes it a real group rather than a
 *  selection: half-transparent overlapping children stop showing through each
 *  other. */
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
 *  carry absolute coordinates (see paintGroup in render.ts), so a child renders
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
   *  copy and replaces it on this tile only. */
  layers: Layer[];
  /** Text content per shared layer — style syncs across tiles, wording does not. */
  text: Record<string, string>;
  /** Picture per shared image layer, the same idea one kind over: the layout
   *  owns where and how big, the tile owns which picture. "" means this tile
   *  deliberately shows none. Optional so manifests written before per-tile
   *  pictures existed still load unchanged. */
  swap?: Record<string, string>;
};

/** A named stack of layers and the tiles it is painted on.
 *
 *  This is the whole point of v3. v2 had exactly two possibilities — one shared
 *  stack on every tile, or a detached copy on one — so "give these five tiles
 *  the same caption and keep editing it as one thing" could not be expressed at
 *  all. An overlay is that missing middle, and "shared" turns out to be just an
 *  overlay whose tile set is everything. */
export type Overlay = {
  id: string;
  name: string;
  /** Tile ids this is painted on. "all" follows the folder rather than pinning
   *  a list, so a new character picks it up instead of being silently skipped. */
  tiles: string[] | "all";
  layers: Layer[];
};

export const appliesTo = (o: Overlay, tileId: string) =>
  o.tiles === "all" || o.tiles.includes(tileId);

/* --- Tile groups. A group is an overlay with a fixed tile list, and tile
 * ownership is exclusive: a tile belongs to at most one group. That is what
 * lets a group be a thing you point at and edit, instead of the v4 behaviour
 * where picking a set that differed by one tile silently produced a second,
 * near-identical overlay nobody asked for.
 *
 * An "all" overlay is deliberately outside this: it is the wall axis (the
 * picture spread across the whole grid), not a group, and every tile is under
 * it by construction. --- */

/** The group owning this tile, if any. */
export const groupOf = (m: Manifest, tileId: string) =>
  m.overlays.find((o) => o.tiles !== "all" && o.tiles.includes(tileId));

/** Which of `ids` no group has claimed yet — what "add to group" may take. */
export const freeTiles = (m: Manifest, ids: string[]) => ids.filter((id) => !groupOf(m, id));

/** Adds the unclaimed tiles among `ids` to `group`, returning how many landed.
 *  Claimed ones are skipped rather than stolen: silently moving a tile out of
 *  another group would change a stamp the user cannot see from here. */
export function addToGroup(m: Manifest, group: Overlay, ids: string[]): number {
  if (group.tiles === "all") return 0;
  const free = freeTiles(m, ids);
  group.tiles = [...group.tiles, ...free];
  return free.length;
}

/** Releases a tile from its group, making it available to others again. */
export function removeFromGroup(group: Overlay, tileId: string) {
  if (group.tiles === "all") return;
  group.tiles = group.tiles.filter((t) => t !== tileId);
}

/** Swaps two tiles' places on the wall.
 *
 *  Swap, not insert: the wall mirrors the in-game character order, which is
 *  hand-built, and inserting would shift every tile after the target — one
 *  drag would then rearrange half the grid. */
export function swapTiles(m: Manifest, a: string, b: string) {
  const i = m.order.indexOf(a);
  const j = m.order.indexOf(b);
  if (i < 0 || j < 0 || i === j) return;
  [m.order[i], m.order[j]] = [m.order[j], m.order[i]];
}

/** Adds or removes tiles from an overlay.
 *
 *  Taking a tile away from an overlay that covers everything has to pin the
 *  list first, and adding the last missing tile collapses it back to "all" —
 *  otherwise an overlay that visibly covers the whole wall would still be a
 *  fixed list, and the next character to appear would silently miss it. */
export function setAssigned(o: Overlay, allIds: string[], ids: string[], on: boolean) {
  const current = new Set(coveredTiles(o, allIds));
  for (const id of ids) {
    if (on) current.add(id);
    else current.delete(id);
  }
  assignExactly(o, allIds, [...current]);
}

/** Replaces the assignment outright: the layer lands on these tiles and no
 *  others. Adding and removing cannot express this in one step — narrowing an
 *  overlay from everything to five tiles would mean deselecting the other
 *  thirty-nine by hand. */
export function assignExactly(o: Overlay, allIds: string[], ids: string[]) {
  const wanted = new Set(ids);
  const next = allIds.filter((id) => wanted.has(id));
  o.tiles = next.length === allIds.length ? "all" : next;
}

/** The overlay's assignment as a concrete list, resolving "all" against the
 *  folder as it stands right now. */
export const coveredTiles = (o: Overlay, allIds: string[]) =>
  o.tiles === "all" ? [...allIds] : o.tiles.filter((id) => allIds.includes(id));

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

export type Manifest = {
  version: 6;
  order: string[];
  hidden: string[];
  overlays: Overlay[];
  tiles: Record<string, Tile>;
  layouts: Layout[];
};

export const emptyTile = (): Tile => ({ base: null, layers: [], text: {} });

export const emptyManifest = (): Manifest => ({
  version: 6,
  order: [],
  hidden: [],
  overlays: [],
  tiles: {},
  layouts: [],
});

/** Every overlay holding a stamp of this layout — what "Update stamps" has to
 *  refresh, and how many pictures are left behind if the layout is deleted. */
export function overlaysUsingLayout(m: Manifest, layoutId: string): Overlay[] {
  return m.overlays.filter((o) => o.layers.some((l) => l.kind === "image" && l.layoutId === layoutId));
}

/** How many portraits actually carry this layout.
 *
 *  The other number — how many groups hold a stamp — is what a refresh or a
 *  delete touches, but it says nothing about how much of the wall is at stake:
 *  one group of fifteen tiles read as "stamped 1 time" while fifteen portraits
 *  wore the design. An "all" overlay is skipped rather than counted as the
 *  whole wall: it is the wall axis, not a tile group, and nothing stamps into
 *  one. */
export function tilesUsingLayout(m: Manifest, layoutId: string): number {
  return overlaysUsingLayout(m, layoutId).reduce(
    (n, o) => n + (o.tiles === "all" ? 0 : o.tiles.length),
    0,
  );
}

/** Puts a rendered stamp of `layoutId` onto `overlay`.
 *
 *  Re-stamping the same layout onto the same tiles replaces that stamp's
 *  picture rather than stacking a second copy on top of the first — which
 *  would look like nothing happened while quietly doubling the layer count. */
export function stampInto(overlay: Overlay, layoutId: string, asset: string): ImageLayer {
  // Not a live picture the same Layout keeps on these tiles: that also carries
  // this layoutId, and grabbing it here would overwrite a per-tile logo with
  // the whole flattened sheet.
  const existing = overlay.layers.find(
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
  overlay.layers.push(stamp);
  return stamp;
}

/** Points every stamp of `layoutId` at a freshly rendered picture, wherever it
 *  sits. Returns how many were refreshed — a design used in several places has
 *  to update everywhere at once, not be re-stamped by hand at each. */
export function refreshStamps(m: Manifest, layoutId: string, asset: string): number {
  let n = 0;
  for (const o of m.overlays) {
    for (const l of o.layers) {
      if (l.kind === "image" && l.layoutId === layoutId) {
        l.asset = asset;
        n++;
      }
    }
  }
  return n;
}

export const newOverlay = (name: string, tiles: string[] | "all" = "all"): Overlay => ({
  id: newId(),
  name,
  tiles,
  layers: [],
});

export const newId = () => Math.random().toString(36).slice(2, 10);

const common = (id = newId()): Common => ({
  id,
  x: 0.5,
  y: 0.5,
  rotation: 0,
  opacity: 1,
  blend: "source-over",
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

export const newShapeLayer = (shape: ShapeKind): ShapeLayer => ({
  ...common(),
  kind: "shape",
  shape,
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

/** Resets size, rotation and opacity to their defaults but keeps position and
 *  every effect — those are rarely what a user wants to lose by mistake. */
export function resetTransform(layer: Layer) {
  layer.rotation = 0;
  layer.opacity = 1;
  if (layer.kind === "image") {
    layer.scale = DEFAULT_IMAGE_SCALE;
    layer.flipX = false;
    layer.flipY = false;
  } else if (layer.kind === "shape") {
    layer.w = DEFAULT_SHAPE_SIZE;
    layer.h = DEFAULT_SHAPE_SIZE;
  } else if (layer.kind === "text") {
    layer.size = DEFAULT_TEXT_SIZE;
  }
}

export const newTextLayer = (): TextLayer => ({
  ...common(),
  kind: "text",
  /* Plain word, not the "{{id}}" placeholder: that default made an emptied
   * field snap back to literal braces the user then could not clear. The
   * placeholder still works, it just has to be typed on purpose. */
  text: "Text",
  font: "Segoe UI",
  size: 0.08,
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

export const layerLabel = (l: Layer) => {
  if (l.name) return l.name;
  if (l.kind === "text") return l.text;
  if (l.kind === "shape") return l.shape;
  if (l.kind === "group") return l.kind;
  return l.asset.replace(/\.[^.]+$/, "").slice(0, 8);
};

/** Every overlay that covers this tile, in overlay order then layer order, each
 *  layer replaced by the tile's detached copy where one exists. Tile-only layers
 *  follow on top. */
export function resolveLayers(m: Manifest, id: string): Layer[] {
  const tile = m.tiles[id] ?? emptyTile();
  const local = new Map(tile.layers.map((l) => [l.id, l]));
  const inherited: Layer[] = [];
  const fromOverlay = new Set<string>();
  for (const o of m.overlays) {
    if (!appliesTo(o, id)) continue;
    for (const l of o.layers) {
      fromOverlay.add(l.id);
      inherited.push(local.get(l.id) ?? l);
    }
  }
  return [...inherited, ...tile.layers.filter((l) => !fromOverlay.has(l.id))];
}

/** Exactly what a tile renders to, shared layers folded in. Comparing this
 *  against what was last written is what makes a shared-layer edit mark every
 *  tile dirty without any extra bookkeeping. */
export const effectiveTile = (m: Manifest, id: string) => ({
  base: m.tiles[id]?.base ?? null,
  layers: resolveLayers(m, id),
  text: m.tiles[id]?.text ?? {},
});

export type Effective = ReturnType<typeof effectiveTile>;

export const isDetached = (m: Manifest, id: string, layerId: string) =>
  m.overlays.some((o) => appliesTo(o, id) && o.layers.some((l) => l.id === layerId)) &&
  (m.tiles[id]?.layers.some((l) => l.id === layerId) ?? false);

/** The tiles that are actually drawn, in grid order. */
export const visibleTiles = (m: Manifest) => m.order.filter((id) => !m.hidden.includes(id));

/** How many times the canvas draws a layer.
 *
 *  A layer in an overlay covering five tiles exists once in the document and
 *  five times on screen. Anything that changes it has to know which, because
 *  moving one copy leaves the other four stale until the scene rebuilds. */
export function instanceCount(m: Manifest, layerId: string, space: "tile" | "grid"): number {
  if (space === "grid") return 1;
  const overlay = overlayOf(m, layerId);
  if (!overlay) return 1; // tile-local: exists on exactly one tile
  return overlay.tiles === "all" ? visibleTiles(m).length : overlay.tiles.length;
}

/** An existing overlay covering exactly these tiles, order irrelevant.
 *
 *  Without this, picking the same five tiles twice would leave two overlays
 *  with identical assignments that then have to be kept in step by hand. An
 *  "all" overlay never matches a list, even one naming every tile: the two
 *  differ in what happens when a character is added. */
export function overlayCovering(overlays: Overlay[], ids: string[]): Overlay | undefined {
  const wanted = [...new Set(ids)].sort().join(" ");
  return overlays.find(
    (o) => o.tiles !== "all" && [...new Set(o.tiles)].sort().join(" ") === wanted,
  );
}

/** The overlay a layer belongs to, if it is not tile-local. Searches nested
 *  layers too, so a layer inside a group still resolves to its overlay. */
export const overlayOf = (m: Manifest, layerId: string) =>
  m.overlays.find((o) => !!findLayer(o.layers, layerId));

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

/** A layer a Layout keeps live on the tiles instead of baking into its stamp.
 *  Text carries its own wording per tile, an image its own picture — the same
 *  bargain either way: the Layout owns how it looks, the tile owns what it
 *  says or shows. */
export type LiveLayer = TextLayer | ImageLayer;

export const perTileLayers = (layout: Layout): LiveLayer[] =>
  [...walkLayers(layout.layers)].filter(
    (l): l is LiveLayer => (l.kind === "text" || l.kind === "image") && !!l.perTile,
  );

/** The Layout as it goes into the stamp: everything except the live captions.
 *
 *  Groups are rebuilt without their live members rather than dropped, so the
 *  displacement a group applies to its remaining children still holds. */
export function bakeable(layout: Layout): Layout {
  const keep = (layers: Layer[]): Layer[] =>
    layers
      .filter((l) => !((l.kind === "text" || l.kind === "image") && l.perTile))
      .map((l) => (l.kind === "group" ? { ...l, children: keep(l.children) } : l));
  return { ...layout, layers: keep(layout.layers) };
}

/** Puts a Layout's live captions on an overlay, beside its stamp, and takes
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
export function syncLiveLayers(overlay: Overlay, layout: Layout): number {
  const live = perTileLayers(layout);
  const wanted = new Set(live.map((l) => l.id));

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
    const at = overlay.layers.findIndex((l) => l.id === src.id);
    if (at >= 0) overlay.layers[at] = copy;
    else overlay.layers.push(copy);
  }

  /* Withdraw the copies this Layout no longer keeps live. `live` is what keeps
   * the stamp out of it: the stamp is an image carrying the same layoutId, and
   * a rule written on kind and layoutId alone would delete the whole design
   * the moment a per-tile picture was switched off. */
  for (let i = overlay.layers.length - 1; i >= 0; i--) {
    const l = overlay.layers[i];
    /* Text counts as a copy whether or not it carries the flag: a stamp is
     * never text, and captions stamped before `live` existed would otherwise
     * be orphaned here forever — a withdrawn caption is only ever replaced
     * while it is still live, so it can never gain the flag afterwards. */
    const copy = l.live || l.kind === "text";
    if (copy && l.layoutId === layout.id && !wanted.has(l.id)) overlay.layers.splice(i, 1);
  }
  return live.length;
}

/** Brings a manifest into line with the folder it belongs to.
 *
 *  Characters get created and deleted between sessions — and a folder can be
 *  deleted wholesale, which BDO answers by regenerating it with different ids.
 *  The folder always wins: what it no longer has, the manifest stops naming.
 *
 *  Groups are pruned too, which they were not: they kept ids nothing had, and
 *  listed them as members. An emptied group is left standing rather than
 *  removed — deleting someone's group because a character was is a decision
 *  the folder does not get to make, and an empty group is one click away from
 *  gone. An "all" overlay is the wall axis and follows the folder by
 *  construction, so it has no list to prune.
 *
 *  Pure surgery, no filesystem: loadManifest supplies the ids. */
export function pruneToFolder(m: Manifest, ids: string[]): Manifest {
  m.order = [...m.order.filter((id) => ids.includes(id)), ...ids.filter((id) => !m.order.includes(id))];
  m.hidden = m.hidden.filter((id) => ids.includes(id));
  for (const id of Object.keys(m.tiles)) if (!ids.includes(id)) delete m.tiles[id];
  for (const id of ids) m.tiles[id] ??= emptyTile();
  for (const o of m.overlays) {
    if (o.tiles !== "all") o.tiles = o.tiles.filter((id) => ids.includes(id));
  }
  return m;
}

/** Writes baked crops into their tiles' `base` and removes the mosaic layer
 *  that produced them — a mosaic in place is a background, not a floating
 *  object, and should not keep sitting on top of other layers once it is
 *  where it belongs.
 *
 *  Pure Manifest surgery, no asset loading or canvas involved, which is what
 *  lets the whole effect of "Anwenden" be tested without Tauri: only reading
 *  the picture's natural pixel size (to feed mosaicBakeCrops) needs it. */
export function bakeMosaicInto(
  m: Manifest,
  layerId: string,
  asset: string,
  crops: Map<number, Crop>,
  order: string[],
) {
  for (const [index, crop] of crops) {
    m.tiles[order[index]].base = { asset, crop };
  }
  const overlay = overlayOf(m, layerId);
  if (overlay) removeLayerFrom(overlay.layers, layerId);
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

export function migrate(raw: unknown): Manifest {
  const m = raw as Raw | null;
  if (!m || typeof m !== "object") return emptyManifest();
  return { ...emptyManifest(), ...(m.version === 6 ? m : toV6(m)) } as Manifest;
}
