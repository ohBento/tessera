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

/** Where the grid was laid over the source image. Kept so the placement stays
 *  editable instead of being computed once and lost. */
export type Mosaic = { asset: string; rect: Crop } | null;

export type Manifest = {
  version: 2;
  order: string[];
  hidden: string[];
  /** Project-scope layers: they exist once and appear on every tile. */
  shared: Layer[];
  tiles: Record<string, Tile>;
  mosaic?: Mosaic;
};

export const emptyTile = (): Tile => ({ base: null, layers: [], text: {} });

export const emptyManifest = (): Manifest => ({
  version: 2,
  order: [],
  hidden: [],
  shared: [],
  tiles: {},
  mosaic: null,
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

/** Shared layers first, in their own order, each replaced by a detached copy
 *  where the tile has one. Tile-only layers follow on top. */
export function resolveLayers(m: Manifest, id: string): Layer[] {
  const tile = m.tiles[id] ?? emptyTile();
  const local = new Map(tile.layers.map((l) => [l.id, l]));
  const sharedIds = new Set(m.shared.map((s) => s.id));
  return [
    ...m.shared.map((s) => local.get(s.id) ?? s),
    ...tile.layers.filter((l) => !sharedIds.has(l.id)),
  ];
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
  m.shared.some((s) => s.id === layerId) && (m.tiles[id]?.layers.some((l) => l.id === layerId) ?? false);

export const layerText = (texts: Record<string, string>, layer: TextLayer, tileId: string) =>
  (texts[layer.id] ?? layer.text).replaceAll("{{id}}", tileId);

/** v1 stored a bare {asset, crop} per tile and knew nothing about layers. */
export function migrate(raw: unknown): Manifest {
  const m = raw as Record<string, unknown>;
  if (!m || typeof m !== "object") return emptyManifest();
  if (m.version === 2) return { ...emptyManifest(), ...(m as object) } as Manifest;

  const tiles: Record<string, Tile> = {};
  for (const [id, base] of Object.entries((m.tiles ?? {}) as Record<string, Base>)) {
    tiles[id] = { ...emptyTile(), base: base ?? null };
  }
  return { ...emptyManifest(), order: (m.order as string[]) ?? [], tiles };
}
