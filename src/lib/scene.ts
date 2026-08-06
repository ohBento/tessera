/* The one scene builder. The editor canvas, the previews and the BMP export all
 * call buildGrid — there is deliberately no second drawing path, because two
 * implementations of the same rules is what made every fix break something else.
 *
 * Coordinates are grid pixels: the whole wall is COLS x rows tiles of
 * TILE_W x TILE_H. A tile is a window onto that, which is all "export tile n"
 * means — same scene, different viewportTransform. */
import * as fabric from "fabric";

import { TILE_H, TILE_W } from "./bmp";
import {
  groupShift,
  isGradient,
  layerText,
  resolveLayers,
  visibleTiles,
  type Base,
  type Layer,
  type Layout,
  type Manifest,
  type Paint,
  type ShapeLayer,
  type TextLayer,
} from "./model";
/* cellAt/gridSize/rowsFor live in geometry.ts — pure grid maths that
 * mosaicBakeCrops also needs — and are re-exported here so every existing
 * caller of scene.ts keeps working unchanged. */
export { cellAt, gridSize, rowsFor } from "./geometry";
import { cellAt, gradientLine, gridSize, LINE_HEIGHT, polygonPoints } from "./geometry";

/** What a Fabric object remembers about where it came from, so a drag can be
 *  written back to the right layer without searching the model for a match. */
export type Tagged = fabric.Object & {
  layerId: string;
  /** "" for a grid-space layer, which belongs to no single tile. */
  tileId: string;
  space: "tile" | "grid";
};

/** Fabric's ImageSource does not include ImageBitmap even though a 2d context
 *  draws one happily, so round-trip through a plain canvas once. */
function toCanvas(bmp: ImageBitmap): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  return c;
}

/** Where pixels come from. Injected rather than imported so this module never
 *  reaches for Tauri: the render chain then runs in a plain browser, which is
 *  what makes the golden tests possible at all. project.ts supplies the real
 *  implementation, tests supply synthetic pictures. */
export type SceneDeps = {
  /** The tile as the game shipped it. */
  original: (id: string) => Promise<ImageBitmap>;
  /** Object URL for an imported asset. */
  asset: (name: string) => Promise<string>;
};

async function imageObject(
  l: Layer & { kind: "image" },
  deps: SceneDeps,
  box: { w: number; h: number; x: number; y: number },
): Promise<fabric.Object> {
  const img = await fabric.FabricImage.fromURL(await deps.asset(l.asset));
  img.scaleToWidth(l.scale * box.w);
  img.set({
    originX: "center",
    originY: "center",
    left: box.x + l.x * box.w,
    top: box.y + l.y * box.h,
    angle: l.rotation,
    opacity: l.opacity,
    flipX: !!l.flipX,
    flipY: !!l.flipY,
  });
  return img;
}

/** A colour, or a Fabric gradient built from one of ours.
 *
 *  Fabric's pixel gradient coordinates start at the object's top-left corner,
 *  while gradientLine works from the centre outwards — so half the line has to
 *  be shifted back in, or the visible part of the ramp is only its second half
 *  and a red-to-blue fill starts out purple. gradientLine stays centred
 *  because that is the form the angle maths is tested in. */
function paintOf(paint: Paint, w: number, h: number): NonNullable<fabric.FabricObjectProps["fill"]> {
  if (!isGradient(paint)) return paint;
  const stops = [
    { offset: 0, color: paint.from },
    { offset: 1, color: paint.to },
  ];
  const cx = w / 2;
  const cy = h / 2;
  if (paint.radial) {
    const r = (Math.max(w, h) / 2) * (paint.radius ?? 1);
    return new fabric.Gradient({
      type: "radial",
      gradientUnits: "pixels",
      coords: { x1: cx, y1: cy, r1: 0, x2: cx, y2: cy, r2: r },
      colorStops: stops,
    });
  }
  const { x1, y1, x2, y2 } = gradientLine(paint.angle, w, h);
  return new fabric.Gradient({
    type: "linear",
    gradientUnits: "pixels",
    coords: { x1: x1 + cx, y1: y1 + cy, x2: x2 + cx, y2: y2 + cy },
    colorStops: stops,
  });
}

/** Geometry shared by every non-image layer: centre origin, tile fractions
 *  turned into pixels of the box it is being drawn into. */
const place = (l: Layer, box: { w: number; h: number; x: number; y: number }) => ({
  originX: "center" as const,
  originY: "center" as const,
  left: box.x + l.x * box.w,
  top: box.y + l.y * box.h,
  angle: l.rotation,
  opacity: l.opacity,
});

/** A caption.
 *
 *  fabric.Textbox rather than Text, because a caption that runs past the tile
 *  should wrap rather than bleed into the neighbour — a tile is a hard edge,
 *  not a suggestion. Sizes are fractions of tile width so a layout survives a
 *  change of tile resolution, the same rule the rest of the model follows. */
function textObject(l: TextLayer, box: { w: number; h: number; x: number; y: number }, tileId: string, texts: Record<string, string>) {
  const size = l.size * box.w;
  const obj = new fabric.Textbox(layerText(texts, l, tileId), {
    ...place(l, box),
    width: box.w,
    fontSize: size,
    fontFamily: l.font,
    fontStyle: l.italic ? "italic" : "normal",
    fontWeight: l.bold ? "bold" : "normal",
    textAlign: l.align ?? "center",
    lineHeight: LINE_HEIGHT,
    fill: paintOf(l.color, box.w, size),
    stroke: l.strokeWidth ? l.strokeColor : undefined,
    strokeWidth: l.strokeWidth * box.w,
    // Stroke centred on the glyph outline eats into the letter shapes; painted
    // behind the fill it reads as an outline, which is what it is for.
    paintFirst: "stroke",
    splitByGrapheme: false,
  });
  if (l.shadow) {
    obj.shadow = new fabric.Shadow({
      color: l.shadowColor,
      blur: l.shadow * box.w,
      offsetX: 0,
      offsetY: 0,
    });
  }
  return obj;
}

/** A rectangle, ellipse or regular polygon. */
function shapeObject(l: ShapeLayer, box: { w: number; h: number; x: number; y: number }) {
  const w = l.w * box.w;
  const h = l.h * box.h;
  const common = {
    ...place(l, box),
    fill: paintOf(l.fill, w, h),
    stroke: l.borderWidth ? l.borderColor : undefined,
    strokeWidth: l.borderWidth * box.w,
    // Border grows outward from the edge rather than being scaled with the
    // object, so a 2px border stays 2px when the shape is resized.
    strokeUniform: true,
  };
  if (l.shape === "ellipse") return new fabric.Ellipse({ ...common, rx: w / 2, ry: h / 2 });
  if (l.shape === "polygon")
    return new fabric.Polygon(polygonPoints(l.sides, w, h), { ...common, objectCaching: false });
  return new fabric.Rect({
    ...common,
    width: w,
    height: h,
    // A radius past half the short side is not a rounder rectangle, it is a
    // broken path — Canvas draws nothing at all past that point.
    rx: Math.min(l.cornerRadius, 0.5) * Math.min(w, h),
    ry: Math.min(l.cornerRadius, 0.5) * Math.min(w, h),
  });
}

/** Any layer as a Fabric object, or undefined for a kind that has no shape of
 *  its own (a group, which is a displacement over its members). */
async function layerObject(
  l: Layer,
  deps: SceneDeps,
  box: { w: number; h: number; x: number; y: number },
  tileId: string,
  texts: Record<string, string>,
): Promise<fabric.Object | undefined> {
  if (l.kind === "image") return imageObject(l, deps, box);
  if (l.kind === "text") return textObject(l, box, tileId, texts);
  if (l.kind === "shape") return shapeObject(l, box);
  return undefined;
}

/** What fills the tile before any layer: the picture set for it if there is
 *  one, otherwise the untouched original. A shape or caption with nothing under
 *  it would otherwise float over the canvas background instead of the face.
 *
 *  The `base` path is also how a project migrated from v2 keeps its mosaic:
 *  that version baked the placement into each tile's crop, and those crops are
 *  carried over verbatim. */
async function background(
  base: Base,
  tileId: string,
  deps: SceneDeps,
  at: { x: number; y: number },
): Promise<fabric.Object> {
  const common = {
    left: at.x,
    top: at.y,
    originX: "left" as const,
    originY: "top" as const,
    selectable: false,
    evented: false,
  };
  if (base) {
    const img = await fabric.FabricImage.fromURL(await deps.asset(base.asset));
    img.set({
      ...common,
      cropX: base.crop.x,
      cropY: base.crop.y,
      width: base.crop.w,
      height: base.crop.h,
      scaleX: TILE_W / base.crop.w,
      scaleY: TILE_H / base.crop.h,
    });
    return img;
  }
  const bmp = toCanvas(await deps.original(tileId));
  return new fabric.FabricImage(bmp, {
    ...common,
    scaleX: TILE_W / bmp.width,
    scaleY: TILE_H / bmp.height,
  });
}

/** Only corner handles: the model carries one `scale` per image layer, so a
 *  side handle would offer a non-uniform stretch it cannot store.
 *
 *  `allowRotate` is false for a grid-space image: it gets baked into every
 *  tile's `base` (see mosaicBakeCrops in geometry.ts), and `Base` has no
 *  rotation field — a rotated picture would have no crop that reproduces it.
 *  Disabling the handle here is what stops that state from being reachable at
 *  all, rather than baking it wrong later. */
function makeInteractive(obj: fabric.Object, locked: boolean, allowRotate = true) {
  obj.selectable = !locked;
  obj.evented = !locked;
  obj.hasControls = !locked;
  obj.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false, mtr: allowRotate });
}

/** Fills `canvas` with the whole wall. Backgrounds are inert; layers are
 *  interactive when `interactive` is set (the editor) and not when it is not
 *  (export, previews, golden tests). */
export async function buildGrid(
  canvas: fabric.StaticCanvas,
  m: Manifest,
  deps: SceneDeps,
  interactive = false,
): Promise<void> {
  canvas.remove(...canvas.getObjects());

  const ids = visibleTiles(m);
  const grid = gridSize(ids.length);

  for (const [index, id] of ids.entries()) {
    const at = cellAt(index);
    canvas.add(await background(m.tiles[id]?.base ?? null, id, deps, at));

    const box = { w: TILE_W, h: TILE_H, x: at.x, y: at.y };
    const texts = m.tiles[id]?.text ?? {};
    for (const l of resolveLayers(m, id)) {
      if (l.hidden || l.space === "grid") continue;
      // Groups are a wall-side concept only in Layouts; on a tile they would
      // need the same flattening layoutObjects does, and nothing creates one
      // here yet.
      const obj = await layerObject(l, deps, box, id, texts);
      if (!obj) continue;
      if (interactive) makeInteractive(obj, !!l.locked);
      else obj.selectable = obj.evented = false;
      Object.assign(obj, { layerId: l.id, tileId: id, space: "tile" });
      canvas.add(obj);
    }
  }

  /* Grid-space layers span the whole wall, so they are placed once on top of
   * everything — drawing them per tile would paint the same pixels COLS*rows
   * times over.
   *
   * ponytail: an overlay's tile set does not restrict its grid-space layers;
   * they always cover the full wall. Restricting one would mean clipping it to
   * the union of the assigned cells. Nothing asks for that yet, and the editor
   * only ever puts grid-space layers in the "all" overlay, so the two agree in
   * practice. Add the clip when a subset overlay needs one. */
  for (const l of m.overlays.flatMap((o) => o.layers)) {
    if (l.hidden || l.kind !== "image" || l.space !== "grid") continue;
    const obj = await imageObject(l, deps, { w: grid.w, h: grid.h, x: 0, y: 0 });
    if (interactive) makeInteractive(obj, !!l.locked, false);
    else obj.selectable = obj.evented = false;
    Object.assign(obj, { layerId: l.id, tileId: "", space: "grid" });
    canvas.add(obj);
  }

  canvas.renderAll();
}

/** Fills `canvas` with one Layout's own layers, at tile scale (624x804) — the
 *  document a Layout is always edited as, per scale/mosaicBakeCrops in
 *  geometry.ts caring only about tile-sized content elsewhere too.
 *
 *  Images only for now: text, shapes and groups arrive with the render depth
 *  work, at which point this gains the same kind-by-kind branches buildGrid's
 *  tile loop will gain. Until then a non-image layer is silently skipped
 *  rather than left to throw, so an old layout doc missing that support still
 *  opens and shows what it can. */
export async function buildLayout(
  canvas: fabric.StaticCanvas,
  layout: Layout,
  deps: SceneDeps,
  interactive = false,
): Promise<void> {
  canvas.remove(...canvas.getObjects());
  for (const obj of await layoutObjects(layout.layers, deps, interactive, { dx: 0, dy: 0 }, false)) {
    canvas.add(obj);
  }
  canvas.renderAll();
}

/** One Layout's layers as Fabric objects, groups flattened into their members.
 *
 *  A group is a displacement, not a container: children carry absolute
 *  coordinates and the group's x/y shifts them (see groupShift in model.ts).
 *  Drawing them as loose objects shifted by that amount therefore renders
 *  identically to nesting them in a fabric.Group, and keeps every child
 *  individually clickable — which is the whole point of grouping here, since
 *  the list is what selects a group and the canvas is what edits one layer.
 *
 *  ponytail: a group's own opacity and blend are not applied to the flattened
 *  result — with loose objects there is nothing to flatten. Swap in a real
 *  fabric.Group when half-transparent overlapping children must stop showing
 *  through each other. */
async function layoutObjects(
  layers: Layer[],
  deps: SceneDeps,
  interactive: boolean,
  shift: { dx: number; dy: number },
  locked: boolean,
): Promise<fabric.Object[]> {
  const out: fabric.Object[] = [];
  for (const l of layers) {
    if (l.hidden) continue;
    if (l.kind === "group") {
      const own = groupShift(l);
      // Hiding or locking a group has to reach its members, or the row would
      // claim something the canvas does not do.
      out.push(
        ...(await layoutObjects(
          l.children,
          deps,
          interactive,
          { dx: shift.dx + own.dx, dy: shift.dy + own.dy },
          locked || !!l.locked,
        )),
      );
      continue;
    }
    const placed = { ...l, x: l.x + shift.dx, y: l.y + shift.dy } as Layer;
    const obj = await layerObject(placed, deps, { w: TILE_W, h: TILE_H, x: 0, y: 0 }, "", {});
    if (!obj) continue;
    if (interactive) makeInteractive(obj, locked || !!l.locked);
    else obj.selectable = obj.evented = false;
    Object.assign(obj, { layerId: l.id, tileId: "", space: "tile" });
    out.push(obj);
  }
  return out;
}

/** Reads a dragged/scaled/rotated object back out in model terms. The inverse
 *  of the placement in imageObject, and the only place that inverse exists. */
export function readBack(obj: Tagged, tileCount: number, index: number) {
  const box =
    obj.space === "grid"
      ? { ...gridSize(tileCount), x: 0, y: 0 }
      : { w: TILE_W, h: TILE_H, ...cellAt(index) };
  return {
    x: ((obj.left ?? 0) - box.x) / box.w,
    y: ((obj.top ?? 0) - box.y) / box.h,
    scale: obj.getScaledWidth() / box.w,
    rotation: obj.angle ?? 0,
  };
}

/** Same inverse as readBack, for a Layout's own canvas — a document with no
 *  grid index to look a cell up by, always exactly one tile in size.
 *
 *  Read off the transform matrix rather than left/top/angle, because those are
 *  relative to the parent once an object sits inside a multi-selection: Fabric
 *  re-expresses children of an ActiveSelection around that selection's centre,
 *  so a dragged group of layers would otherwise write back positions near the
 *  origin. The matrix is absolute either way, which makes this one code path
 *  instead of one per case. */
export function readBackLayout(obj: fabric.Object) {
  const { translateX, translateY, scaleX, angle } = fabric.util.qrDecompose(
    obj.calcTransformMatrix(),
  );
  return {
    x: translateX / TILE_W,
    y: translateY / TILE_H,
    scale: (scaleX * (obj.width ?? 0)) / TILE_W,
    rotation: angle,
  };
}
