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
};

export type ImageLayer = Common & {
  kind: "image";
  asset: string;
  scale: number;
  /* Optional so manifests saved before flipping existed still load unchanged. */
  flipX?: boolean;
  flipY?: boolean;
  /* Set when this picture is a stamp rendered from a Layout, so "Layout
   * aktualisieren" can find every copy across every overlay and refresh its
   * asset in one pass. Absent for an ordinarily imported picture. */
  layoutId?: string;
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
 *  and stampLayout in editor.svelte.ts). That split is deliberate: the layout
 *  keeps its structure, styles and per-layer editability for as long as you
 *  want to keep changing it, while what actually sits on a tile is nothing
 *  more exotic than an ordinary picture, reusing every bit of image-layer
 *  machinery that already exists. */
export type Layout = {
  id: string;
  name: string;
  layers: Layer[];
};

export const newLayout = (name: string): Layout => ({ id: newId(), name, layers: [] });

export type Manifest = {
  version: 4;
  order: string[];
  hidden: string[];
  overlays: Overlay[];
  tiles: Record<string, Tile>;
  layouts: Layout[];
};

export const emptyTile = (): Tile => ({ base: null, layers: [], text: {} });

export const emptyManifest = (): Manifest => ({
  version: 4,
  order: [],
  hidden: [],
  overlays: [],
  tiles: {},
  layouts: [],
});

/** Every overlay holding a stamp of this layout — what "Layout aktualisieren"
 *  has to refresh, and what a Layout's own editor shows as "used on N spots". */
export function overlaysUsingLayout(m: Manifest, layoutId: string): Overlay[] {
  return m.overlays.filter((o) => o.layers.some((l) => l.kind === "image" && l.layoutId === layoutId));
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

export const layerText = (texts: Record<string, string>, layer: TextLayer, tileId: string) =>
  (texts[layer.id] ?? layer.text).replaceAll("{{id}}", tileId);

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

/** v1 stored a bare {asset, crop} per tile and knew nothing about layers. */
function v1ToV2(m: Raw): Raw {
  const tiles: Record<string, Tile> = {};
  for (const [id, base] of Object.entries((m.tiles ?? {}) as Record<string, Base>)) {
    tiles[id] = { ...emptyTile(), base: base ?? null };
  }
  return { version: 2, order: (m.order as string[]) ?? [], hidden: [], shared: [], tiles };
}

/** v2 had one project-wide `shared` stack, which is exactly an overlay covering
 *  everything.
 *
 *  Its `mosaic` field is dropped rather than converted. The picture still shows:
 *  v2 baked the placement into each tile's `base` crop and those are kept
 *  verbatim, so a migrated project renders identically. What is lost is the
 *  ability to pick that placement back up and move it — which v3 does not
 *  restore in the old shape anyway, because a mosaic there is an ordinary image
 *  layer in grid space. Reconstructing one would need the source image's pixel
 *  dimensions, and migration must not touch the filesystem. */
function v2ToV3(m: Raw): Raw {
  const shared = (m.shared ?? []) as Layer[];
  return {
    version: 3,
    order: (m.order as string[]) ?? [],
    hidden: (m.hidden as string[]) ?? [],
    tiles: (m.tiles ?? {}) as Record<string, Tile>,
    overlays: shared.length ? [{ ...newOverlay("Alle Kacheln"), layers: shared }] : [],
  };
}

/** v3 had no Layouts at all — nothing to convert, just the field appearing. */
function v3ToV4(m: Raw): Raw {
  return { ...m, version: 4, layouts: [] };
}

export function migrate(raw: unknown): Manifest {
  let m = raw as Raw | null;
  if (!m || typeof m !== "object") return emptyManifest();
  if (m.version !== 2 && m.version !== 3 && m.version !== 4) m = v1ToV2(m);
  if (m.version === 2) m = v2ToV3(m);
  if (m.version === 3) m = v3ToV4(m);
  return { ...emptyManifest(), ...m } as Manifest;
}
