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
  findLayer,
  groupShift,
  isGradient,
  layerAsset,
  layerText,
  nestingShift,
  resolveLayers,
  stencilIds,
  type Base,
  type Layer,
  type Layout,
  type Manifest,
  type Corners,
  type Paint,
  type ShapeLayer,
  type TextLayer,
} from "./model";

/** Which wall to draw: an ordered, dense list of tile ids — position n is grid
 *  slot n — and the layers spread across the whole of it.
 *
 *  A structural type rather than `Project`, because the inbox is a wall too:
 *  the tiles no project has claimed, with no picture over them. Passing the
 *  list in also ends the old arrangement where the scene, the export and the
 *  canvas each derived it from the manifest separately and had to agree by
 *  luck — the index into it is the grid coordinate system. */
export type Wall = { ids: string[]; gridLayers: Layer[] };
/* cellAt/gridSize/rowsFor live in geometry.ts — pure grid maths that
 * mosaicBakeCrops also needs — and are re-exported here so every existing
 * caller of scene.ts keeps working unchanged. */
export { cellAt, gridSize, rowsFor } from "./geometry";
import {
  cellAt,
  gradientLine,
  gridSize,
  LINE_HEIGHT,
  polygonPoints,
  snapEdges,
  type Box,
  type Edge,
  type Guide,
} from "./geometry";

/** What a Fabric object remembers about where it came from, so a drag can be
 *  written back to the right layer without searching the model for a match. */
export type Tagged = fabric.Object & {
  layerId: string;
  /** "" for a grid-space layer, which belongs to no single tile. */
  tileId: string;
  space: "tile" | "grid";
  /** Whether this object refuses to be grabbed, carried along so a caller that
   *  hands out grabbability by some other rule can still honour the lock. */
  locked: boolean;
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

/** How wide a caption's box is: hugging its words, never past the tile.
 *
 *  One measurement, because two callers need the same answer — the renderer,
 *  and the editor keeping a left-aligned caption's left edge still while its
 *  words change length. Two spellings of it would drift, and the drift would
 *  show up as text creeping sideways as you type. */
function boxWidth(
  words: string,
  style: Partial<fabric.TextProps>,
  size: number,
  limit: number,
): number {
  const measured = new fabric.Text(words, style).width ?? limit;
  return Math.min(Math.max(measured, size), limit);
}

/** The width a caption would occupy on a tile, as a fraction of tile width. */
export function textWidth(l: TextLayer): number {
  const size = l.size * TILE_W;
  return (
    boxWidth(
      l.text,
      {
        fontSize: size,
        fontFamily: l.font,
        fontStyle: l.italic ? "italic" : "normal",
        fontWeight: l.bold ? "bold" : "normal",
      } as Partial<fabric.TextProps>,
      size,
      TILE_W,
    ) / TILE_W
  );
}

/** A caption.
 *
 *  fabric.Textbox rather than Text, because a caption that runs past the tile
 *  should wrap rather than bleed into the neighbour — a tile is a hard edge,
 *  not a suggestion. Sizes are fractions of tile width so a layout survives a
 *  change of tile resolution, the same rule the rest of the model follows. */
function textObject(l: TextLayer, box: { w: number; h: number; x: number; y: number }, tileId: string, texts: Record<string, string>) {
  const size = l.size * box.w;
  /* A Layout shows the caption as written, placeholder and all: it is a
   * template, and what you edit there has to be what you typed. Only a tile
   * resolves "{{id}}", because only a tile knows which id. This is also what
   * makes typing on the canvas safe — what is drawn is what gets written
   * back, so editing cannot silently swallow the placeholder. */
  const words = tileId ? layerText(texts, l, tileId) : l.text;
  const style = {
    fontSize: size,
    fontFamily: l.font,
    fontStyle: l.italic ? "italic" : "normal",
    fontWeight: l.bold ? "bold" : "normal",
  } as const;

  /* The box hugs short text and only wraps once it would leave the tile.
   *
   * A Textbox needs a width up front, and using the whole tile for it made the
   * transform frame stretch far past a two-word caption — you grabbed a handle
   * nowhere near the letters, and left-aligned text started at the tile's edge
   * whatever x said. Measuring first costs one throwaway object and makes the
   * frame mean what it looks like it means. */
  const obj = new fabric.Textbox(words, {
    ...place(l, box),
    width: boxWidth(words, style, size, box.w),
    ...style,
    textAlign: l.align ?? "center",
    lineHeight: LINE_HEIGHT,
    fill: paintOf(l.color, box.w, size),
    stroke: l.strokeWidth ? l.strokeColor : undefined,
    strokeWidth: l.strokeWidth * box.w,
    // Stroke centred on the glyph outline eats into the letter shapes; painted
    // behind the fill it reads as an outline, which is what it is for.
    paintFirst: "stroke",
    splitByGrapheme: false,
    /* Editable only in a Layout, where the raw text is what is on screen and
     * LayoutCanvas writes it back when editing ends. On a tile the caption is
     * a copy showing resolved words, with no path back to the Layout that owns
     * them — typing there would change something that gets overwritten by the
     * next stamp update. */
    editable: !tileId,
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
  // A radius past half the short side is not a rounder rectangle, it is a
  // broken path — Canvas draws nothing at all past that point.
  const r = Math.min(l.cornerRadius, 0.5) * Math.min(w, h);
  const corners = l.corners;
  /* The plain Rect stays for the plain case, which is every rect drawn before
   * corners existed: Fabric places a Path by its own bounding box rather than
   * by the box it was asked for, and there is no reason to put every existing
   * layout through that just so a rarer one can have three round corners. */
  if (!corners || (corners.tl && corners.tr && corners.bl && corners.br)) {
    return new fabric.Rect({ ...common, width: w, height: h, rx: r, ry: r });
  }
  return new fabric.Path(cornerPath(w, h, r, corners), { ...common, objectCaching: false });
}

/** A rectangle rounded only where `corners` says so, drawn around its centre.
 *
 *  Around the centre because that is the origin every layer here is placed by;
 *  a path starting at 0,0 would hang down and to the right of where it was
 *  asked to sit. */
function cornerPath(w: number, h: number, r: number, c: Corners): string {
  const x = -w / 2;
  const y = -h / 2;
  const arc = (rad: number, toX: number, toY: number) =>
    rad ? `A ${rad} ${rad} 0 0 1 ${toX} ${toY}` : `L ${toX} ${toY}`;
  const [tl, tr, br, bl] = [c.tl ? r : 0, c.tr ? r : 0, c.br ? r : 0, c.bl ? r : 0];
  return [
    `M ${x + tl} ${y}`,
    `L ${x + w - tr} ${y}`,
    arc(tr, x + w, y + tr),
    `L ${x + w} ${y + h - br}`,
    arc(br, x + w - br, y + h),
    `L ${x + bl} ${y + h}`,
    arc(bl, x, y + h - bl),
    `L ${x} ${y + tl}`,
    arc(tl, x + tl, y),
    "Z",
  ].join(" ");
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

/** Which layers can be stretched out of proportion.
 *
 *  Only shapes: they keep width and height as separate fields. An image
 *  carries a single `scale` and a caption a single `size`, so a stretch has
 *  nowhere to be stored and would spring back the moment the scene rebuilt —
 *  better not to offer the handle than to offer one that lies. */
export const freeScale = (l: Layer) => l.kind === "shape";

/** Which edges each handle has hold of. */
const HANDLE_EDGES: Record<string, Edge[]> = {
  tl: ["left", "top"],
  tr: ["right", "top"],
  bl: ["left", "bottom"],
  br: ["right", "bottom"],
  ml: ["left"],
  mr: ["right"],
  mt: ["top"],
  mb: ["bottom"],
};

/** Pulls the edges under the pointer onto nearby lines, mid-resize, and says
 *  which lines they landed on so the caller can draw them.
 *
 *  The correction is applied here rather than handed back, because every
 *  caller would otherwise repeat the same anchor bookkeeping: the opposite
 *  side must not move a pixel, and the only way to be sure of that across
 *  Fabric's origin handling is to scale, measure where the box actually ended
 *  up, and shift it back by the difference.
 *
 *  A rotated frame is left alone. Its bounding rect has no edge that belongs
 *  to the object, and scaling along one is not a scale at all. */
export function snapScale(
  target: fabric.Object,
  corner: string,
  targets: Box[],
  threshold: number,
  uniform: boolean,
): Guide[] {
  const edges = HANDLE_EDGES[corner];
  if (!edges || (target.angle ?? 0) % 360 !== 0) return [];

  target.setCoords();
  const box = target.getBoundingRect();
  if (!box.width || !box.height) return [];
  const snap = snapEdges(box, edges, targets, threshold);
  if (!snap.dx && !snap.dy) return [];

  /* Growing rightwards adds the correction to the width; growing leftwards
   * subtracts it, because the edge that moved is the one the width is measured
   * from. */
  let fx = snap.dx ? (box.width + (edges.includes("right") ? snap.dx : -snap.dx)) / box.width : 1;
  let fy = snap.dy ? (box.height + (edges.includes("bottom") ? snap.dy : -snap.dy)) / box.height : 1;
  let guides = snap.guides;

  /* An image or a caption has one size field, so both axes take the same
   * factor or the next rebuild would throw half of it away. The gentler pull
   * wins and the other axis follows it — and only the winner's guide is drawn,
   * since the edge that merely came along does not actually land on anything. */
  if (uniform) {
    const useX = snap.dx !== 0 && (snap.dy === 0 || Math.abs(1 - fx) <= Math.abs(1 - fy));
    fx = fy = useX ? fx : fy;
    guides = guides.filter((g) => g.axis === (useX ? "x" : "y"));
  }
  if (fx <= 0 || fy <= 0) return [];

  target.scaleX = (target.scaleX ?? 1) * fx;
  target.scaleY = (target.scaleY ?? 1) * fy;
  target.setCoords();
  const now = target.getBoundingRect();
  // Where the anchored side has to stay: the edge the pointer is not holding.
  const wantLeft = edges.includes("left") ? box.left + box.width - now.width : box.left;
  const wantTop = edges.includes("top") ? box.top + box.height - now.height : box.top;
  target.left = (target.left ?? 0) + (wantLeft - now.left);
  target.top = (target.top ?? 0) + (wantTop - now.top);
  target.setCoords();
  return guides;
}

/** `allowRotate` is false for a grid-space image: it gets baked into every
 *  tile's `base` (see mosaicBakeCrops in geometry.ts), and `Base` has no
 *  rotation field — a rotated picture would have no crop that reproduces it.
 *  Disabling the handle here is what stops that state from being reachable at
 *  all, rather than baking it wrong later. */
function makeInteractive(obj: fabric.Object, l: Layer, allowRotate = true) {
  const locked = !!l.locked;
  obj.selectable = !locked;
  obj.evented = !locked;
  obj.hasControls = !locked;
  const sides = freeScale(l);
  obj.setControlsVisibility({ ml: sides, mr: sides, mt: sides, mb: sides, mtr: allowRotate });
}

/** Fills `canvas` with the whole wall. Backgrounds are inert; layers are
 *  interactive when `interactive` is set (the editor) and not when it is not
 *  (export, previews, golden tests). */
export async function buildGrid(
  canvas: fabric.StaticCanvas,
  wall: Wall,
  m: Manifest,
  deps: SceneDeps,
  interactive = false,
): Promise<void> {
  canvas.remove(...canvas.getObjects());

  const ids = wall.ids;
  const grid = gridSize(ids.length);

  /* Three passes, because the wall picture belongs between them: every tile's
   * background, then anything spread across the wall, then what the tiles
   * themselves carry. Tiles never overlap — each is clipped to its own cell —
   * so splitting the per-tile work in two changes nothing about them. */
  for (const [index, id] of ids.entries()) {
    canvas.add(await background(m.tiles[id]?.base ?? null, id, deps, cellAt(index)));
  }

  /* The picture spread across this wall. Once, not per tile — drawing it per
   * cell would paint the same pixels COLS*rows times over.
   *
   * Under the tiles' own layers, not over them. It is a preview of the
   * background: Apply turns it into each tile's `base`, and a base draws
   * beneath everything, so putting it on top made the preview contradict its
   * own result. It also reached the file — renderTiles builds this same scene,
   * so writing to the game before applying buried every stamp under the
   * picture in the BMP itself. */
  for (const l of wall.gridLayers) {
    if (l.hidden || l.kind !== "image" || l.space !== "grid") continue;
    const obj = await imageObject(l, deps, { w: grid.w, h: grid.h, x: 0, y: 0 });
    if (interactive) makeInteractive(obj, l, false);
    else obj.selectable = obj.evented = false;
    Object.assign(obj, { layerId: l.id, tileId: "", space: "grid", locked: !!l.locked });
    canvas.add(obj);
  }

  for (const [index, id] of ids.entries()) {
    const at = cellAt(index);
    const box = { w: TILE_W, h: TILE_H, x: at.x, y: at.y };
    const texts = m.tiles[id]?.text ?? {};
    const swaps = m.tiles[id]?.swap ?? {};
    for (const raw of resolveLayers(m, id)) {
      if (raw.hidden || raw.space === "grid") continue;
      /* This tile's own picture, where it has one. Resolved before the object
       * is built rather than inside imageObject, so the swap map stays a wall
       * concern: a Layout has no tiles and nothing to swap. "" is a real
       * answer — no picture on this tile — and the layer simply does not
       * render, which is why the check is on the resolved value and not on
       * whether a key exists. */
      const l =
        raw.kind === "image" && raw.live ? { ...raw, asset: layerAsset(swaps, raw) } : raw;
      if (l.kind === "image" && !l.asset) continue;
      // Groups are a wall-side concept only in Layouts; on a tile they would
      // need the same flattening layoutObjects does, and nothing creates one
      // here yet.
      const obj = await layerObject(l, deps, box, id, texts);
      if (!obj) continue;
      /* Held inside its own cell. The wall is one continuous surface but the
       * game's grid is not — it puts a gap between every portrait — so
       * anything hanging over an edge is content the player will never see
       * where the editor showed it. Export already dropped the overflow, by
       * accident rather than by rule; clipping makes the preview tell the
       * truth instead of inviting a placement that cannot survive.
       *
       * objectCaching off because a cached object is drawn from a bitmap that
       * was rendered before the clip applied, which shows up as the clip
       * simply not working. */
      obj.clipPath = new fabric.Rect({
        left: at.x,
        top: at.y,
        width: TILE_W,
        height: TILE_H,
        originX: "left",
        originY: "top",
        absolutePositioned: true,
      });
      obj.objectCaching = false;
      /* Anything a Layout put here is positioned in the Layout, full stop. The
       * wall would be the wrong place to judge it from — the game's grid has
       * gaps, so a caption nudged towards an edge here can end up in a gap or
       * on the neighbour in play — and "Stempel aktualisieren" would throw the
       * nudge away anyway, since the Layout is where the position comes from.
       * Better not to offer the drag than to revert it later. */
      const locked = !!l.locked || !!l.layoutId;
      if (interactive) makeInteractive(obj, locked ? { ...l, locked: true } : l);
      else obj.selectable = obj.evented = false;
      Object.assign(obj, { layerId: l.id, tileId: id, space: "tile", locked });
      canvas.add(obj);
    }
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
  /* Overridable because the stamp path renders a stripped copy of the Layout
   * (see bakeable) and the answer has to come from the whole of it. */
  stencils = stencilIds(layout.layers),
): Promise<void> {
  canvas.remove(...canvas.getObjects());
  const objs = await layoutObjects(layout.layers, deps, interactive, { dx: 0, dy: 0 }, false, 1, {
    root: layout.layers,
    stencils,
  });
  for (const obj of objs) canvas.add(obj);
  canvas.renderAll();
}

/** What a layer needs to know about masking that its own fields cannot say:
 *  where to look a mask id up, and which shapes have stopped being pictures. */
type Masking = { root: Layer[]; stencils: Set<string> };

/** Builds the clip path for one layer, or nothing when it has no mask.
 *
 *  The shape is drawn at its own place on the sheet, group displacement folded
 *  in exactly as the visible copy would have been — a mask that ignored the
 *  group it sits in would cut somewhere else entirely.
 *
 *  `absolutePositioned` because a clipPath is otherwise expressed relative to
 *  the clipped object's own centre, which would drag the hole around with
 *  whatever it is cutting. A dangling id resolves to nothing and the layer
 *  draws unclipped, which is the documented behaviour of a deleted shape. */
async function maskFor(l: Layer, deps: SceneDeps, m: Masking): Promise<fabric.Object | undefined> {
  if (!l.maskId) return undefined;
  const cutter = findLayer(m.root, l.maskId);
  /* Anything that draws: a shape cuts with its outline, a picture with the
   * pixels it has, a caption with its letters. A group draws nothing of its
   * own — it is a displacement — so there is nothing there to cut with.
   *
   * A switched-off layer stops cutting. The eye has to mean the same thing
   * everywhere: something that is not there cannot be why half a picture is
   * missing, and nothing else on screen would have explained it. */
  if (!cutter || cutter.kind === "group" || cutter.hidden) return undefined;
  const shift = nestingShift(m.root, cutter.id) ?? { dx: 0, dy: 0 };
  const placed = { ...cutter, x: cutter.x + shift.dx, y: cutter.y + shift.dy } as Layer;
  const obj = await layerObject(placed, deps, { w: TILE_W, h: TILE_H, x: 0, y: 0 }, "", {});
  if (!obj) return undefined;
  obj.absolutePositioned = true;
  obj.inverted = !!l.maskInvert;
  return obj;
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
 *  A group's opacity is multiplied into its members on the way down, like the
 *  displacement — the panel offers the slider, so ignoring the value made a
 *  control that does nothing.
 *
 *  ponytail: multiplied opacity is not the same as fading a merged picture —
 *  half-transparent overlapping children show through each other. Swap in a
 *  real fabric.Group when that difference matters. */
async function layoutObjects(
  layers: Layer[],
  deps: SceneDeps,
  interactive: boolean,
  shift: { dx: number; dy: number },
  locked: boolean,
  fade: number,
  masking: Masking,
): Promise<fabric.Object[]> {
  const out: fabric.Object[] = [];
  for (const l of layers) {
    if (l.hidden) continue;
    if (l.kind === "group") {
      const own = groupShift(l);
      // Hiding, locking or fading a group has to reach its members, or the
      // row would claim something the canvas does not do.
      out.push(
        ...(await layoutObjects(
          l.children,
          deps,
          interactive,
          { dx: shift.dx + own.dx, dy: shift.dy + own.dy },
          locked || !!l.locked,
          fade * l.opacity,
          masking,
        )),
      );
      continue;
    }
    const placed = { ...l, x: l.x + shift.dx, y: l.y + shift.dy, opacity: l.opacity * fade } as Layer;
    const obj = await layerObject(placed, deps, { w: TILE_W, h: TILE_H, x: 0, y: 0 }, "", {});
    if (!obj) continue;
    const mask = await maskFor(l, deps, masking);
    if (mask) {
      obj.clipPath = mask;
      /* A cached object is painted from a bitmap rendered before the clip
       * applied, which shows up as the mask simply not working — the same trap
       * the tile clip fell into further up. */
      obj.objectCaching = false;
    }
    // A locked group locks its members, so the flag has to travel down.
    if (interactive) makeInteractive(obj, locked ? { ...l, locked: true } : l);
    else obj.selectable = obj.evented = false;

    /* A shape someone masks with is the hole, not something in the picture, so
     * it paints nothing — in the editor and in the stamp alike.
     *
     * It still gets an object, though, or it could never be moved again: the
     * list picks a layer by finding its object, and a stencil skipped outright
     * would be a mask you can set and then never adjust. Deaf to the pointer,
     * because it lies exactly over the part of the picture it lets through and
     * would otherwise swallow every click meant for what is underneath. The
     * row remains the way in. */
    if (masking.stencils.has(l.id)) {
      obj.opacity = 0;
      obj.evented = false;
      // Said outright rather than inferred from the opacity: a layer someone
      // faded to nothing by hand is still an ordinary layer.
      Object.assign(obj, { stencil: true });
    }
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
    scaleH: obj.getScaledHeight() / box.h,
    fx: obj.scaleX ?? 1,
    fy: obj.scaleY ?? 1,
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
  const { translateX, translateY, scaleX, scaleY, angle } = fabric.util.qrDecompose(
    obj.calcTransformMatrix(),
  );
  /* A mirrored object carries its flip in the matrix as a negative scale, and
   * a decomposition has no way to tell that apart from a half turn: it reports
   * angle + 180 and, on one axis, a negative factor. The model keeps flipX and
   * flipY as their own fields and the renderer applies them itself, so the
   * half turn has to come back out here — otherwise a plain drag of a mirrored
   * picture wrote rotation 180 into the model and the next rebuild stood it on
   * its head. */
  const fx = Math.abs(scaleX);
  const fy = Math.abs(scaleY);
  const turn = obj.flipX ? 180 : 0;
  return {
    x: translateX / TILE_W,
    y: translateY / TILE_H,
    scale: (fx * (obj.width ?? 0)) / TILE_W,
    // Read separately rather than assumed equal: a shape keeps width and
    // height apart, so stretching one side has to survive the round trip.
    scaleH: (fy * (obj.height ?? 0)) / TILE_H,
    /* The raw factors, for layers whose size is written straight onto the
     * object rather than derived from it. A shape is built at its exact w×h
     * with no scaling, so after a plain drag these are 1 and its size must not
     * change — deriving the size from obj.width instead shrank a polygon by
     * 13% on every drag, because a regular n-gon's bounding box is smaller
     * than the box it is inscribed in. */
    fx,
    fy,
    rotation: (((angle - turn) % 360) + 360) % 360,
  };
}
