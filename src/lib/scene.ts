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
  cropSpan,
  cutApplies,
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
  type Inset,
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

/** Trims a picture to the part its layer shows.
 *
 *  Fabric's own cropX/cropY with width/height, which is a window onto the
 *  source rather than a resize of it — the pixels inside keep the size they
 *  had, which is the whole point of cropping instead of scaling. Everything
 *  downstream then measures the layer by what is left: scaleToWidth divides by
 *  the cropped width, so `scale` is the width of the visible part. */
export function applyCrop(img: fabric.FabricImage, crop: Inset | undefined) {
  if (!crop) return;
  const src = img.getOriginalSize();
  const span = cropSpan(crop);
  img.cropX = crop.l * src.width;
  img.cropY = crop.t * src.height;
  // A degenerate trim would divide by zero in scaleToWidth; one pixel of
  // picture is the least a layer can honestly be.
  img.width = Math.max(1, span.w * src.width);
  img.height = Math.max(1, span.h * src.height);
}

/** The SVG saturate matrix over Rec. 709 luma, for the layer's -1..1 dial.
 *
 *  Not Fabric's own Saturation filter: that one pulls every channel towards the
 *  pixel's maximum, so draining a pure magenta ended at white instead of grey.
 *  This matrix fades each pixel towards its luminance — what every photo tool
 *  means by desaturating — and past 0 the same matrix oversaturates. */
function saturationMatrix(v: number) {
  const s = v + 1; // dial -1..1 → saturate factor 0..2, 1 = untouched
  const [lr, lg, lb] = [0.2126, 0.7152, 0.0722];
  // prettier-ignore
  return [
    lr + (1 - lr) * s, lg * (1 - s),      lb * (1 - s),      0, 0,
    lr * (1 - s),      lg + (1 - lg) * s, lb * (1 - s),      0, 0,
    lr * (1 - s),      lg * (1 - s),      lb + (1 - lb) * s, 0, 0,
    0,                 0,                 0,                 1, 0,
  ];
}

async function imageObject(
  l: Layer & { kind: "image" },
  deps: SceneDeps,
  box: { w: number; h: number; x: number; y: number },
): Promise<fabric.Object> {
  const img = await fabric.FabricImage.fromURL(await deps.asset(l.asset));
  applyCrop(img, l.crop);
  /* Only the dials that were touched: applyFilters bakes a new element, and
   * paying that on every image for four no-op filters would slow the wall for
   * nothing. Baked here means a stamp carries the graded pixels for free. */
  const filters = [
    l.brightness ? new fabric.filters.Brightness({ brightness: l.brightness }) : null,
    l.contrast ? new fabric.filters.Contrast({ contrast: l.contrast }) : null,
    l.saturation ? new fabric.filters.ColorMatrix({ matrix: saturationMatrix(l.saturation) }) : null,
    l.hue ? new fabric.filters.HueRotation({ rotation: l.hue }) : null,
    l.blur ? new fabric.filters.Blur({ blur: l.blur }) : null,
  ].filter((f) => f !== null);
  if (filters.length) {
    img.filters = filters;
    img.applyFilters();
  }
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
  frameImage(img, l, box);
  if (l.shadow) {
    /* nonScaling, unlike a caption's: a picture is drawn at natural size and
     * scaled down hard, and a blur that scaled with it would be a smear. The
     * stored number is in tile pixels and should land as tile pixels. */
    img.shadow = new fabric.Shadow({
      color: l.shadowColor ?? "#000000",
      blur: l.shadow * box.w,
      offsetX: 0,
      offsetY: 0,
      nonScaling: true,
    });
  }
  return img;
}

/** Rounded corners and a frame, baked into the picture's own pixels.
 *
 *  Not a clipPath, which is where this started: an object has one clipPath slot
 *  and three things want it — the corners, the cell a tile layer must stay
 *  inside, and a mask. Nesting them to intersect looked right and rendered
 *  wrong; the picture came back blended with what lay under it, because the
 *  inner clip is composited through the outer one's transform. Baking sidesteps
 *  the whole question: pixels compose with everything, and the stamp carries
 *  the frame for free.
 *
 *  Runs after the filters and before the scaling, so it grades what it frames
 *  and frames what will be scaled. The crop is baked with it — the frame has to
 *  follow the visible window, not the picture the window was cut from.
 *
 *  Widths arrive as fractions of a tile and are drawn in the picture's own
 *  pixels, so the conversion is the scale the layer is about to be given. A
 *  frame asked for as 1% of a tile lands as 1% of a tile at any picture size. */
function frameImage(
  img: fabric.FabricImage,
  l: Layer & { kind: "image" },
  box: { w: number; h: number },
) {
  const w = Math.round(img.width);
  const h = Math.round(img.height);
  const radius = Math.min(l.cornerRadius ?? 0, 0.5) * Math.min(w, h);
  // Source pixels per tile pixel, undoing the scale the layer is about to get.
  const border = (l.borderWidth ?? 0) * box.w * (w / (l.scale * box.w));
  if (!radius && !border) return;

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d")!;
  const trace = (inset: number) => {
    const r = Math.max(0, radius - inset);
    ctx.beginPath();
    ctx.moveTo(inset + r, inset);
    ctx.arcTo(w - inset, inset, w - inset, h - inset, r);
    ctx.arcTo(w - inset, h - inset, inset, h - inset, r);
    ctx.arcTo(inset, h - inset, inset, inset, r);
    ctx.arcTo(inset, inset, w - inset, inset, r);
    ctx.closePath();
  };

  ctx.save();
  trace(0);
  ctx.clip();
  // The crop window, drawn to fill the new canvas — cropX/cropY are cleared
  // below, or the trim would be taken a second time off the framed copy.
  ctx.drawImage(img.getElement(), img.cropX ?? 0, img.cropY ?? 0, w, h, 0, 0, w, h);
  ctx.restore();

  if (border) {
    // Inset by half, so the whole stroke lands inside the picture's edge and
    // framing never changes the space the layer occupies.
    trace(border / 2);
    ctx.lineWidth = border;
    ctx.strokeStyle = l.borderColor ?? "#000000";
    ctx.stroke();
  }

  img.setElement(out);
  img.cropX = 0;
  img.cropY = 0;
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
  /* `mid` slides the blend along the line: past 0.5 the transition band keeps
   * its width but one colour holds solid before or after it, which is what
   * "make this colour more prominent" means. */
  const mid = paint.mid ?? 0.5;
  const stops = [
    { offset: Math.max(0, 2 * mid - 1), color: paint.from },
    { offset: Math.min(1, 2 * mid), color: paint.to },
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
  // A caption with a width of its own does not grow with its words, so there
  // is nothing for the caller to compensate.
  if (l.w) return l.w;
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

/** The rectangle a caption with a fixed height is held to, in scene
 *  coordinates — or nothing when it has none and may grow with its lines.
 *
 *  Centred on the layer like everything else, so raising the height opens the
 *  box equally at the top and the bottom and the words stay where they are. */
export function captionBox(
  l: TextLayer,
  box: { w: number; h: number; x: number; y: number },
): { left: number; top: number; width: number; height: number } | undefined {
  if (!l.h) return undefined;
  const width = (l.w ?? 1) * box.w;
  const height = l.h * box.h;
  return {
    left: box.x + l.x * box.w - width / 2,
    top: box.y + l.y * box.h - height / 2,
    width,
    height,
  };
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
    /* A set width wins over measuring: that is the whole point of it. What the
       words do inside is wrap, which is what a Textbox is for. */
    width: l.w ? l.w * box.w : boxWidth(words, style, size, box.w),
    ...style,
    textAlign: l.align ?? "center",
    lineHeight: LINE_HEIGHT,
    fill: paintOf(l.color, box.w, size),
    stroke: l.strokeWidth ? l.strokeColor : undefined,
    strokeWidth: l.strokeWidth * box.w,
    // Stroke centred on the glyph outline eats into the letter shapes; painted
    // behind the fill it reads as an outline, which is what it is for.
    paintFirst: "stroke",
    /* Break inside a word once the box has a width of its own. Fabric only
       breaks at spaces otherwise, and widens the box to its longest unbreakable
       word instead — which is how a character name, one word and no spaces,
       pushed a left-aligned caption 192px sideways with a width set. A box that
       only held for text with spaces would keep the bug exactly where it is
       felt. Without a width the old behaviour stands: nothing to hold to. */
    splitByGrapheme: !!l.w,
    /* Editable only in a Layout, where the raw text is what is on screen and
     * LayoutCanvas writes it back when editing ends. On a tile the caption is
     * a copy showing resolved words, with no path back to the Layout that owns
     * them — typing there would change something that gets overwritten by the
     * next stamp update. */
    editable: !tileId,
  });
  /* Cut to the box when it has a height. A clipPath is the cheap way to do it
     and the slot is free here — unless the caption is masked, in which case
     maskFor claims it in layoutObjects and the mask wins. On a tile the two are
     never in competition: the mask is baked into pixels long before this. */
  const held = captionBox(l, box);
  if (held) {
    obj.clipPath = new fabric.Rect({
      ...held,
      originX: "left",
      originY: "top",
      absolutePositioned: true,
    });
    obj.objectCaching = false;
  }
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
    // Same halo a caption casts, offset zero — see textObject.
    shadow: l.shadow
      ? new fabric.Shadow({
          color: l.shadowColor ?? "#000000",
          blur: l.shadow * box.w,
          offsetX: 0,
          offsetY: 0,
        })
      : undefined,
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

/** Which layers have side handles at all, whatever those handles then do: a
 *  shape stretches by them, a picture crops by them, a caption has neither.
 *
 *  Spelled once because it has two callers that must not drift — the scene
 *  puts the handles on the object, and LayoutCanvas re-applies the rule every
 *  time the selection changes. When they disagreed, the second silently undid
 *  the first and pictures shipped with no handle to crop by. */
export const sideHandles = (l: Layer) => freeScale(l) || l.kind === "image";

/** Which of the eight scale handles a layer may show — the one answer, for the
 *  two places that have to agree.
 *
 *  They did not: the scene put a caption's side handles on, and LayoutCanvas
 *  took every handle off again the moment it was selected, so the app showed
 *  none at all while the test on the scene's rule stayed green. The comment
 *  beside sideHandles already warned that a second spelling would drift; this
 *  is what it looks like when it does.
 *
 *  A caption: sides yes, they set the width its words wrap at — Fabric's
 *  Textbox turns those two into `width` rather than `scaleX`, which is exactly
 *  the field the model keeps. Corners no, its size is a font size and belongs
 *  to the properties field. Top and bottom no, its height is however many
 *  lines the words need, and a handle that springs back is worse than none. */
export const scaleControls = (l: Layer) => {
  const corners = l.kind !== "text";
  const sides = sideHandles(l);
  return {
    tl: corners,
    tr: corners,
    bl: corners,
    br: corners,
    ml: sides || l.kind === "text",
    mr: sides || l.kind === "text",
    mt: sides,
    mb: sides,
  };
};

/* --- Cropping a picture by its side handles.
 *
 * A picture's side handles trim it; only its corners scale it. The two are
 * genuinely different actions — one changes how much of the source shows, the
 * other how big those pixels are drawn — and Fabric's own scaling cannot
 * express the first, because a clip is not a scale.
 *
 * Own controls rather than converting a scale afterwards. `uniformScaling` is
 * on for pictures so their corners stay proportional, and it forces a side
 * handle onto both axes as well; turning it off to free the sides frees the
 * corners with it, and re-imposing proportion inside object:scaling is exactly
 * the correction LayoutCanvas tried once and threw out. A control with its own
 * action sidesteps the setting entirely. --- */

type CropSide = "l" | "r" | "t" | "b";

/** The edge each drag has to leave standing: pulling the left in must not
 *  shift the right. */
const CROP_ANCHOR = {
  l: { ox: "right", oy: "center" },
  r: { ox: "left", oy: "center" },
  t: { ox: "center", oy: "bottom" },
  b: { ox: "center", oy: "top" },
} as const;

/** Moves one edge of the window a picture shows itself through.
 *
 *  Source pixels throughout: the pointer's distance from the anchored edge is
 *  divided by the layer's own scale, so the picture inside the frame never
 *  changes size — the frame is the only thing that moves. Pulling outwards
 *  gives back what was trimmed and stops at the picture's own edge; there is
 *  no blank margin to drag into. */
export function trimTo(img: fabric.FabricImage, side: CropSide, x: number, y: number): boolean {
  const across = side === "l" || side === "r";
  const { ox, oy } = CROP_ANCHOR[side];
  const anchor = img.translateToOriginPoint(img.getRelativeCenterPoint(), ox, oy);
  /* Undo the layer's own rotation first, so the drag is measured along the
   * picture's edge rather than the screen's. */
  const p = new fabric.Point(x, y).rotate(-fabric.util.degreesToRadians(img.angle ?? 0), anchor);
  const scale = (across ? img.scaleX : img.scaleY) || 1;
  const asked = Math.abs(across ? p.x - anchor.x : p.y - anchor.y) / scale;

  const src = img.getOriginalSize();
  const total = across ? src.width : src.height;
  const from = (across ? img.cropX : img.cropY) ?? 0;
  const shown = (across ? img.width : img.height) ?? 0;
  const most = side === "l" || side === "t" ? from + shown : total - from;
  const next = Math.min(Math.max(Math.round(asked), 1), most);
  if (next === shown) return false;

  // The far edge of the window in source pixels, which is what stays put.
  const end = from + shown;
  if (across) {
    img.cropX = side === "l" ? end - next : from;
    img.width = next;
  } else {
    img.cropY = side === "t" ? end - next : from;
    img.height = next;
  }
  /* Width and height grow about the centre, so half the change lands on the
   * side nobody is dragging. Putting the anchor back where it was is what
   * makes the opposite edge hold still. */
  img.setPositionByOrigin(anchor, ox, oy);
  img.setCoords();
  return true;
}

const cropControl = (side: CropSide, x: number, y: number) =>
  new fabric.Control({
    x,
    y,
    actionName: "crop",
    cursorStyle: side === "l" || side === "r" ? "ew-resize" : "ns-resize",
    actionHandler: (_e, transform, px, py) =>
      trimTo(transform.target as fabric.FabricImage, side, px, py),
  });

/** Side handles that trim rather than scale. Built per object: a Control
 *  carries no state, but assigning to `obj.controls` must not reach the
 *  prototype and give every layer in the app a crop handle. */
const cropControls = () => ({
  ml: cropControl("l", -0.5, 0),
  mr: cropControl("r", 0.5, 0),
  mt: cropControl("t", 0, -0.5),
  mb: cropControl("b", 0, 0.5),
});

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

/** Pulls a caption's box edge onto nearby lines while its width is dragged.
 *
 *  Its own function because a Textbox's side handle is not a scale: Fabric
 *  gives it a `changeWidth` action that writes `width` and leaves `scaleX` at
 *  one, and fires `object:resizing` rather than `object:scaling`. snapScale
 *  never heard about it, which is why the caption was the one layer that did
 *  not snap to anything.
 *
 *  Same bargain as snapScale: the opposite edge must not move, so the width
 *  change is answered with half of it on `left` — the box is centred, so it
 *  grows both ways unless told otherwise. */
export function snapWidth(
  target: fabric.Object,
  corner: string,
  targets: Box[],
  threshold: number,
): Guide[] {
  const edges = HANDLE_EDGES[corner];
  if (!edges || (target.angle ?? 0) % 360 !== 0) return [];

  target.setCoords();
  const box = target.getBoundingRect();
  if (!box.width) return [];
  const snap = snapEdges(box, edges, targets, threshold);
  if (!snap.dx) return [];

  const grew = edges.includes("right") ? snap.dx : -snap.dx;
  const width = (target.width ?? 0) + grew / (target.scaleX || 1);
  if (width <= 0) return [];
  target.set({ width });
  // The edge the pointer is not holding stays where it was.
  target.left = (target.left ?? 0) + (edges.includes("right") ? grew / 2 : -grew / 2);
  target.setCoords();
  return snap.guides.filter((g) => g.axis === "x");
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
  /* Fabric's stock blue frame, recoloured to the app's accent. Here and not
   * per canvas, because this is the one door every interactive object walks
   * through — the trap this function's comment below already names. */
  obj.borderColor = "#cbb8ff";
  obj.cornerColor = "#0e0b16";
  obj.cornerStrokeColor = "#cbb8ff";
  obj.transparentCorners = false;
  if (l.kind === "image") obj.controls = { ...obj.controls, ...cropControls() };
  obj.setControlsVisibility({ ...scaleControls(l), mtr: allowRotate });
}

/** Draws one object into an offscreen tile-sized canvas and hands back the
 *  element. */
async function toTileCanvas(obj: fabric.Object): Promise<HTMLCanvasElement> {
  const off = new fabric.StaticCanvas(undefined, {
    width: TILE_W,
    height: TILE_H,
    // Off, or the element comes back at twice the size on a HiDPI screen and
    // the two canvases stop lining up pixel for pixel.
    enableRetinaScaling: false,
  });
  off.add(obj);
  off.renderAll();
  const el = off.getElement();
  /* Copied out before disposing: Fabric clears the element it owns, and the
   * caller needs the pixels, not the canvas. */
  const keep = document.createElement("canvas");
  keep.width = TILE_W;
  keep.height = TILE_H;
  keep.getContext("2d")!.drawImage(el, 0, 0);
  await off.dispose();
  return keep;
}

/** A tile layer cut to the shape of another one, as pixels.
 *
 *  Baked rather than clipped, and that is not a preference: `buildGrid` gives
 *  every tile object a `clipPath` of its own cell, Fabric allows exactly one,
 *  and nesting them was tried here before — it rendered the tile blended with
 *  the background instead of clipped. `frameImage` solved the same problem the
 *  same way for borders and rounded corners.
 *
 *  Tile-local coordinates on the way in, so the composite is one tile square
 *  and the caller places the result in its cell afterwards.
 *
 *  ponytail: two offscreen canvases per masked layer per tile, so a wall of
 *  forty-four costs eighty-eight small renders on every rebuild. Only masked
 *  per-tile layers pay it, which is a deliberate and rare arrangement. Cache by
 *  cutter + picture if a real wall ever feels slow. */
async function cutToShape(
  l: Layer,
  obj: fabric.Object,
  cutter: Layer,
  deps: SceneDeps,
  tileId: string,
  texts: Record<string, string>,
  swaps: Record<string, string>,
): Promise<fabric.FabricImage | undefined> {
  /* The cutter's own per-tile picture, where the tile chose one. It is the
   * same layer either way — it just happens to be cutting rather than drawing,
   * and it used to keep the Layout's picture in that role while honouring the
   * tile's in the other. "" is a real answer: this tile deliberately shows
   * none, so there is nothing to cut with and the layer draws whole, exactly
   * as it does when the cutter cannot be resolved at all. */
  const stencilLayer =
    cutter.kind === "image" ? { ...cutter, asset: layerAsset(swaps, cutter) } : cutter;
  if (stencilLayer.kind === "image" && !stencilLayer.asset) return undefined;

  const shape = await layerObject(
    silhouette(stencilLayer),
    deps,
    { w: TILE_W, h: TILE_H, x: 0, y: 0 },
    tileId,
    texts,
  );
  if (!shape) return undefined;

  const [drawn, stencil] = [await toTileCanvas(obj), await toTileCanvas(shape)];
  const ctx = drawn.getContext("2d")!;
  /* Keep the layer where the shape has pixels — or everywhere it has none,
   * which is what inverting a mask means: a hole punched through rather than a
   * piece cut out. Fabric spells the same pair `inverted` on a clipPath. */
  ctx.globalCompositeOperation = l.maskInvert ? "destination-out" : "destination-in";
  ctx.drawImage(stencil, 0, 0);
  return new fabric.FabricImage(drawn, { originX: "left", originY: "top" });
}

/** A cutter reduced to its shape.
 *
 *  A mask is a form, not a paint. Fabric enforces that in its own clipPath by
 *  overriding fill, dropping the stroke and ignoring opacity and shadow; this
 *  path rasterises the layer for real and would otherwise let all four change
 *  the cut — a half-transparent fill cutting softly, an outline widening the
 *  hole by 70% on a caption, a shadow fraying its edge. Measured, all of it, as
 *  a difference between what the Layout editor showed and what the wall wrote.
 *  The editor is the only preview there is, so it wins. */
const silhouette = (l: Layer): Layer => {
  const bare = { ...l, opacity: 1, shadow: 0, rotation: l.rotation };
  if (bare.kind === "shape") return { ...bare, fill: "#000000", borderWidth: 0 };
  if (bare.kind === "text") return { ...bare, color: "#000000", strokeWidth: 0 };
  if (bare.kind === "image") return { ...bare, borderWidth: 0 };
  return bare;
};

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
    /* A tile can carry a cutter now: a per-tile layer that is masked brings the
     * shape along, because the Layout it came from is not there to look it up
     * in. Same rule as in a Layout — a shape that is cutting something has
     * stopped being a picture and does not draw itself. */
    const own = resolveLayers(m, id);
    const stencils = stencilIds(own);
    for (const raw of own) {
      if (raw.hidden || raw.space === "grid" || stencils.has(raw.id)) continue;
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
      /* Cut before placed. The shape sits in tile coordinates, so the layer is
       * built at the tile's own origin, composited against it, and the finished
       * picture is moved into the cell — after which the cell clip below
       * applies to it like to anything else.
       *
       * A cutter that is hidden stops cutting, exactly as in a Layout: the eye
       * has to mean the same thing everywhere, and something that is not there
       * cannot be why half a picture is missing. */
      const cutter = l.maskId ? own.find((x) => x.id === l.maskId) : undefined;
      const cut = cutApplies(l, cutter) && !cutter!.hidden ? cutter : undefined;
      const local = cut ? { ...box, x: 0, y: 0 } : box;
      const drawn = await layerObject(l, deps, local, id, texts);
      if (!drawn) continue;
      const obj = cut ? await cutToShape(l, drawn, cut, deps, id, texts, swaps) : drawn;
      if (!obj) continue;
      if (cut) {
        obj.left = at.x;
        obj.top = at.y;
      }
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
      /* The cell, and — for a caption held to a height — the box as well.
       * Fabric allows one clipPath, but both are axis-aligned rectangles, so
       * their intersection is a third one and no nesting is needed. A rotated
       * caption is left to the cell alone: its box is not axis-aligned any
       * more, and a rectangle cannot express that overlap. */
      const held = l.kind === "text" && !l.rotation ? captionBox(l, box) : undefined;
      const cell = { left: at.x, top: at.y, right: at.x + TILE_W, bottom: at.y + TILE_H };
      const left = held ? Math.max(cell.left, held.left) : cell.left;
      const top = held ? Math.max(cell.top, held.top) : cell.top;
      const right = held ? Math.min(cell.right, held.left + held.width) : cell.right;
      const bottom = held ? Math.min(cell.bottom, held.top + held.height) : cell.bottom;
      obj.clipPath = new fabric.Rect({
        left,
        top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
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
  /* One rule, one function — see cutApplies. Asked here as well as by the
   * dropdown, so a manifest that already names a cutter the list would not
   * offer behaves the same in both places. */
  if (!cutter || cutter.hidden || !cutApplies(l, cutter)) return undefined;
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
      /* A clip changes what is painted, not the box Fabric hit-tests, so a
       * masked picture goes on swallowing clicks across its whole original
       * extent — over empty canvas, and over the layers below it. Per-pixel
       * finding answers the question by rendering the object, clipPath and all,
       * so what can be clicked is what can be seen. Only on masked layers: it
       * costs a render per hit test, and everywhere else the bounding box is
       * both cheaper and the right answer. */
      obj.perPixelTargetFind = true;
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
/** The trim a picture is currently showing through, or nothing at all.
 *
 *  Undefined rather than four zeroes for an untrimmed picture, so a layer that
 *  was never cropped stores no crop — and every layer that is not a picture
 *  answers the same way. */
function cropOff(obj: fabric.Object): Inset | undefined {
  const img = obj as fabric.FabricImage;
  if (typeof img.getOriginalSize !== "function") return undefined;
  const src = img.getOriginalSize();
  if (!src.width || !src.height) return undefined;
  const from = { l: (img.cropX ?? 0) / src.width, t: (img.cropY ?? 0) / src.height };
  const crop = {
    ...from,
    r: 1 - from.l - (img.width ?? 0) / src.width,
    b: 1 - from.t - (img.height ?? 0) / src.height,
  };
  // Rounding noise from the source-pixel round trip, not a trim.
  const trimmed = Object.values(crop).some((v) => v > 0.0005);
  return trimmed ? crop : undefined;
}

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
    /** What the side handles trimmed off the picture, if anything. */
    crop: cropOff(obj),
    rotation: (((angle - turn) % 360) + 360) % 360,
  };
}
