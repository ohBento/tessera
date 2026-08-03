/** Crop rectangle in source-image pixels. */
export type Crop = { x: number; y: number; w: number; h: number };

/** The picture filling the tile. A mosaic is 60 tiles sharing one asset with
 *  different crops, which is why it needs no mode of its own. */
export type Base = { asset: string; crop: Crop } | null;

/** Geometry is stored as fractions of the tile, never pixels: the tile size is
 *  configurable, and px values would break every layout the moment it changes. */
type Common = {
  id: string;
  x: number; // centre, 0..1 of tile width
  y: number; // centre, 0..1 of tile height
  rotation: number; // degrees
  opacity: number; // 0..1
  blend: GlobalCompositeOperation;
  filter: string; // CSS filter chain, "" for none
  /* Optional so manifests written before these existed still load unchanged. */
  name?: string;
  locked?: boolean;
};

export type ImageLayer = Common & {
  kind: "image";
  asset: string;
  scale: number;
  /* Optional so manifests saved before flipping existed still load unchanged. */
  flipX?: boolean;
  flipY?: boolean;
};

export type TextLayer = Common & {
  kind: "text";
  text: string; // {{id}} expands to the tile's numeric id
  font: string;
  size: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  shadow: number;
  shadowColor: string;
};

export type Layer = ImageLayer | TextLayer;

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
  filter: "",
});

export const DEFAULT_IMAGE_SCALE = 0.3;
export const DEFAULT_TEXT_SIZE = 0.08;

export const newImageLayer = (asset: string): ImageLayer => ({
  ...common(),
  kind: "image",
  asset,
  scale: DEFAULT_IMAGE_SCALE,
  flipX: false,
  flipY: false,
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
  } else {
    layer.size = DEFAULT_TEXT_SIZE;
  }
}

export const newTextLayer = (): TextLayer => ({
  ...common(),
  kind: "text",
  text: "{{id}}",
  font: "Segoe UI",
  size: 0.08,
  color: "#ffffff",
  strokeColor: "#000000",
  strokeWidth: 0,
  shadow: 0,
  shadowColor: "#000000",
  y: 0.9,
});

export const layerLabel = (l: Layer) =>
  l.name || (l.kind === "text" ? l.text : l.asset.replace(/\.[^.]+$/, "").slice(0, 8));

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
