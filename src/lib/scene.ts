/* The one scene builder. The editor canvas, the previews and the BMP export all
 * call buildGrid — there is deliberately no second drawing path, because two
 * implementations of the same rules is what made every fix break something else.
 *
 * Coordinates are grid pixels: the whole wall is COLS x rows tiles of
 * TILE_W x TILE_H. A tile is a window onto that, which is all "export tile n"
 * means — same scene, different viewportTransform.
 *
 * Drawable objects are constructed here and only here. `new fabric.Rect`, a
 * Textbox, `FabricImage.fromURL` and the cache-averse settings they need
 * (see the objectCaching note near the cell clipping) do not belong in other
 * files: a canvas component keeps its Canvas/Point/selection plumbing, but
 * what gets drawn is built in this one, or the next cache trap lands in a
 * file that has never heard of it. */
import * as fabric from "fabric";

import { TILE_H, TILE_W } from "./bmp";
import { iconArt } from "./icons";
import {
  cropSpan,
  cutApplies,
  findLayer,
  groupShift,
  isGradient,
  layerText,
  nestingShift,
  resolveLayers,
  stencilIds,
  type Base,
  type GroupLayer,
  type Layer,
  type Manifest,
  type Corners,
  type Inset,
  type Paint,
  type ShapeLayer,
  type TextLayer,
  type Tile,
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
  /** A whole-tile bake of the layer rather than the layer itself — a mask or a
   *  class icon. Its transform describes the bake, not the placement, so
   *  readBack must never be written back from one. */
  flattened?: boolean;
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

/** A tile-sized offscreen canvas, handed to `fn` and disposed however it ends.
 *
 *  The two offscreen renderers (BMP export, Layout stamp) share it so the
 *  quirks live once:
 *  - retina scaling off, or the backing store is multiplied by
 *    devicePixelRatio and getImageData hands back a differently sized buffer
 *    than encodeBmp32 wants;
 *  - Fabric v6+ disposes asynchronously, and not awaiting it leaves the
 *    element half torn down and quietly corrupts the next canvas built on it. */
export async function withTileCanvas<T>(
  fn: (canvas: fabric.StaticCanvas) => Promise<T>,
): Promise<T> {
  const canvas = new fabric.StaticCanvas(undefined, {
    width: TILE_W,
    height: TILE_H,
    enableRetinaScaling: false,
  });
  try {
    return await fn(canvas);
  } finally {
    await canvas.dispose();
  }
}

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

/* --- The placing tool's furniture — see GridCanvas. Built here rather than
 * there so the renderer's own reading of a layer (crop, flip) and the
 * cache-averse settings stay in the file that documents them. --- */

/** The whole of a dragged picture, for the faint ghost a mask makes necessary.
 *
 *  Trimmed and flipped the way the renderer draws it, or the ghost is the
 *  shape of the whole file rather than of the part on the tile — four times
 *  too tall on a picture cropped to a strip — and shows pixels the wall does
 *  not. Crop first, then measure: `scale` is the width of what is left, which
 *  is the whole point of the crop/scale distinction. */
export async function ghostImage(
  l: Layer & { kind: "image" },
  deps: SceneDeps,
): Promise<fabric.FabricImage> {
  const img = await fabric.FabricImage.fromURL(await deps.asset(l.asset));
  applyCrop(img, l.crop);
  img.set({ flipX: !!l.flipX, flipY: !!l.flipY });
  return img;
}

/** The transparent stand-in the placing tool drags: the layer itself is baked
 *  and clipped into its cell, so grabbing it would take the mask along — what
 *  is dragged is a plain rectangle at the layer's place.
 *
 *  objectCaching off for the reason the cell clipping spells out below: a
 *  cached object is drawn from a bitmap rendered before the latest change. */
export function standRect(
  place: { originX: "center"; originY: "center"; left: number; top: number; angle: number },
  width: number,
  height: number,
): fabric.Rect {
  return new fabric.Rect({
    ...place,
    width,
    height,
    fill: "rgba(0,0,0,0.001)",
    stroke: "#a685ff",
    strokeWidth: 1,
    strokeUniform: true,
    selectable: true,
    evented: true,
    hasBorders: true,
    objectCaching: false,
  });
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
  // What the baked window was cut from, for cropOff — which can no longer
  // measure it off an element that is already the cut.
  Object.assign(img, { bakedCrop: l.crop });
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

/** How big a live layer sits on a tile, as fractions of the tile — whichever
 *  fields it happens to keep its size in.
 *
 *  The tool that places a layer per tile needs one answer for all three kinds,
 *  both to draw its frame at the right size and to turn a dragged handle back
 *  into a zoom factor. A caption's height is the box it is held to, or the one
 *  line it currently is when it has none.
 *
 *  A picture answers with its width twice over: how tall it comes out depends
 *  on the pixels behind it, which are not in the manifest. The one caller that
 *  needs a picture's height has the decoded image in hand and takes it from
 *  there.
 *
 *  `w` is a fraction of tile width and `h` of tile height, which is what makes
 *  the caption's fallback the awkward one: `size` is a fraction of tile *width*
 *  (see textObject), so a line of it has to be carried across the aspect ratio
 *  or the frame comes out 804/624 — 29% — too tall. `l.h` needs no such thing;
 *  it is a height fraction already. */
/** The layer cutting this one, if any is and it is showing.
 *
 *  A cutter that is hidden stops cutting: the eye has to mean the same thing
 *  everywhere, and something that is not there cannot be why half a picture is
 *  missing. */
export const cutterOf = (l: Layer, siblings: Layer[]): Layer | undefined => {
  const c = l.maskId ? siblings.find((x) => x.id === l.maskId) : undefined;
  return c && cutApplies(l, c) && !c.hidden ? c : undefined;
};

/** Whether the wall draws this layer as a tile-sized picture rather than as
 *  itself: a class icon, which wears its artwork as a clipPath and so cannot
 *  also wear the cell, or anything a mask is cutting.
 *
 *  Read outside the renderer as well — the wall's frame appears exactly on
 *  these, because their own object is a whole-tile bake whose handles would sit
 *  at the corners of the cell rather than at the edges of the layer. One rule
 *  in one place, so the frame and the bake can never disagree about which
 *  layers need it. */
export const isFlattened = (l: Layer, siblings: Layer[]) =>
  !!cutterOf(l, siblings) || (l.kind === "shape" && l.shape === "icon");

export const layerSize = (l: Layer): { w: number; h: number } =>
  l.kind === "image"
    ? { w: l.scale, h: l.scale }
    : l.kind === "shape"
      ? { w: l.w, h: l.h }
      : l.kind === "text"
        ? { w: textWidth(l), h: l.h ?? (l.size * LINE_HEIGHT * TILE_W) / TILE_H }
        : l.kind === "group"
          ? groupReach(l)
          : { w: 1, h: 1 };

/** How far a group's members reach from the group's own point, doubled — the
 *  box a frame has to be to cover them while staying centred on what the drag
 *  writes.
 *
 *  Centred rather than tight on purpose: the group's x/y is the thing being
 *  moved, so a box measured around the members' own middle would slide out
 *  from under the handles the moment it was dragged. A little larger than it
 *  needs to be is the price, and an empty group falls back to the whole cell
 *  so there is still something to grab. */
function groupReach(g: GroupLayer): { w: number; h: number } {
  let w = 0;
  let h = 0;
  for (const c of g.children) {
    const size = layerSize(c);
    w = Math.max(w, Math.abs(c.x - g.x) + size.w / 2);
    h = Math.max(h, Math.abs(c.y - g.y) + size.h / 2);
  }
  return w && h ? { w: w * 2, h: h * 2 } : { w: 1, h: 1 };
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
function textObject(l: TextLayer, box: { w: number; h: number; x: number; y: number }, tileId: string) {
  const size = l.size * box.w;
  /* A Layout shows the caption as written, placeholder and all: it is a
   * template, and what you edit there has to be what you typed. Only a tile
   * resolves "{{id}}", because only a tile knows which id. This is also what
   * makes typing on the canvas safe — what is drawn is what gets written
   * back, so editing cannot silently swallow the placeholder. */
  const words = tileId ? layerText(l, tileId) : l.text;
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
  /* Where the box sits when it has no width of its own and the words are not
   * the Layout's. Such a box hugs its words and is centred on x, so a longer
   * name grows it in both directions — and a left-aligned caption then starts
   * further left on the tile that happens to say more. The Layout editor hides
   * this by nudging x as you type; a tile has no such moment, and forty tiles
   * with forty names came out as forty different left edges.
   *
   * So the edge the alignment names is what is held: the left one for
   * left-aligned text, the right one for right-aligned, both measured against
   * the Layout's own wording — the caption you see in the editor. Centred text
   * keeps growing both ways, which is what centring means. */
  const anchored = place(l, box);
  if (!l.w && tileId && words !== l.text) {
    const own = boxWidth(l.text, style, size, box.w);
    const here = boxWidth(words, style, size, box.w);
    const align = l.align ?? "center";
    if (align === "left") anchored.left += (here - own) / 2;
    else if (align === "right") anchored.left -= (here - own) / 2;
  }

  const obj = new fabric.Textbox(words, {
    ...anchored,
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
    /* Stamped onto the object, because the handles and the snap have no other
     * way to know it: a Textbox's own height is the height of its lines, which
     * is what the box is there to disagree with. Without this the first drag
     * measured the text and jumped. */
    (obj as fabric.Object & { boxH?: number }).boxH = held.height;
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
function shapeObject(
  l: ShapeLayer,
  box: { w: number; h: number; x: number; y: number },
  stencilOnly = false,
) {
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
  if (l.shape === "icon") return iconShape(l, common, w, h, stencilOnly);
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

/** A class icon in whatever paint the layer carries.
 *
 *  The colour is a plain rectangle and the icon is its clipPath, rather than
 *  the icon's paths being filled one by one. Two things fall out of that for
 *  free: a gradient runs across the whole icon instead of restarting inside
 *  every stroke of it, and Fabric masks by alpha, so the fill-opacity the
 *  artwork uses for shading survives as a softer part of the same colour.
 *
 *  A name no build knows draws nothing — an empty group clips everything away
 *  — which is the honest outcome for a layout made by a newer version. */
function iconShape(
  l: ShapeLayer,
  common: Record<string, unknown>,
  w: number,
  h: number,
  stencilOnly: boolean,
): fabric.Object {
  const art = l.icon ? iconArt(l.icon) : null;
  const paths = (art?.paths ?? []).map(
    (p) =>
      new fabric.Path(p.d, {
        fill: "#ffffff",
        opacity: p.opacity,
        // The artwork is drawn with holes — a ring is one path, not two — and
        // the nonzero rule fills them in.
        fillRule: "evenodd",
        objectCaching: false,
      }),
  );
  const stencil = new fabric.Group(paths, { objectCaching: false });
  if (art) {
    /* Fitted to the box the layer asked for, by the ink rather than by the
     * 1024 square it was drawn on: the icons do not all reach their edges, and
     * fitting the canvas would make some classes visibly smaller than others
     * at the same width. */
    const scale = Math.min(w / (stencil.width || 1), h / (stencil.height || 1));
    stencil.set({ scaleX: scale, scaleY: scale });
  }
  /* The stroke would trace the rectangle rather than the icon, and the clip
   * then cuts every visible part of it away, so the paint keeps the placement
   * and drops the outline. The properties panel hides the border rows for an
   * icon for the same reason. */
  const { stroke: _stroke, strokeWidth: _strokeWidth, ...paint } = common;

  /* Cutting with an icon hands back the outline itself, not a rectangle wearing
   * it. Fabric uses a cutter as its own clipPath, and a clipPath inside a
   * clipPath does not survive the absolute positioning that puts a mask where
   * the layer is — measured, the cut layer came back entirely blank. The
   * outline is all a cut needs anyway: a mask is a form, not a paint. */
  if (stencilOnly) {
    const { fill: _fill, shadow: _shadow, ...where } = paint;
    stencil.set({ ...where, originX: "center", originY: "center" });
    return stencil;
  }
  // A clipPath is placed from the centre of what it clips, so the group sits at
  // the origin rather than where its paths happened to be drawn.
  stencil.set({ originX: "center", originY: "center", left: 0, top: 0 });
  return new fabric.Rect({ ...paint, width: w, height: h, clipPath: stencil });
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
  /* Set by the two paths that want a cutter rather than a drawing. Only the
   * class icon reads it — every other kind is already its own outline. */
  stencilOnly = false,
): Promise<fabric.Object | undefined> {
  if (l.kind === "image") return imageObject(l, deps, box);
  if (l.kind === "text") return textObject(l, box, tileId);
  if (l.kind === "shape") return shapeObject(l, box, stencilOnly);
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
export const freeScale = (l: Layer) =>
  /* Except a class icon. Its artwork is fitted to the box rather than stretched
   * into it, so a one-axis drag showed the icon stretching for as long as the
   * mouse was down and snapping back on release — the clip travels inside the
   * object while the drag is live, and the rebuild refits it. Corner handles
   * only, and Fabric holds those proportional, so what the drag shows is what
   * the release keeps. */
  l.kind === "shape" && l.shape !== "icon";

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
  const text = l.kind === "text";
  return {
    tl: corners,
    tr: corners,
    bl: corners,
    br: corners,
    ml: sides || text,
    mr: sides || text,
    // A caption's top and bottom set the height its lines are cut at — see
    // heightControls. They are not a scale either; nothing here is.
    mt: sides || text,
    mb: sides || text,
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

/** The box a caption is held to, read off the live object mid-drag.
 *
 *  `boxH` is scratch: the height the handle has dragged to, in scene pixels,
 *  before it is written back to the model as a fraction. Absent means the box
 *  is still whatever the words need, which is the height the first drag starts
 *  from. */
type Boxed = fabric.Object & { boxH?: number };

const boxHeightOf = (t: Boxed) => t.boxH ?? (t.height ?? 0) * (t.scaleY ?? 1);

/** Drags a caption's box taller or shorter, holding the opposite edge.
 *
 *  The box is centred on the layer, so growing it downwards means moving the
 *  centre down by half — the same bookkeeping trimTo does for a picture, with
 *  the height living on the object rather than in a crop. The clipPath is
 *  moved with it so the cut follows the pointer instead of appearing when the
 *  drag ends. */
export function holdTo(t: Boxed, side: "t" | "b", _x: number, y: number): boolean {
  if ((t.angle ?? 0) % 360 !== 0) return false;
  const was = boxHeightOf(t);
  const centre = t.top ?? 0;
  // The edge nobody is dragging.
  const fixed = side === "b" ? centre - was / 2 : centre + was / 2;
  const next = Math.max(8, side === "b" ? y - fixed : fixed - y);
  if (Math.abs(next - was) < 0.5) return false;

  t.boxH = next;
  t.top = side === "b" ? fixed + next / 2 : fixed - next / 2;
  const clip = t.clipPath as fabric.Rect | undefined;
  if (clip) clip.set({ top: (t.top ?? 0) - next / 2, height: next });
  t.setCoords();
  return true;
}

const heightControl = (side: "t" | "b", y: number) =>
  new fabric.Control({
    x: 0,
    y,
    /* Named for what Fabric already calls a width drag on a Textbox, so both
       ends of the box arrive at one listener and get one snap. */
    actionName: "resizing",
    cursorStyle: "ns-resize",
    actionHandler: (_e, transform, px, py) => holdTo(transform.target as Boxed, side, px, py),
  });

/** Top and bottom handles that set a caption's box height. Built per object
 *  for the same reason the crop handles are. */
const heightControls = () => ({ mt: heightControl("t", -0.5), mb: heightControl("b", 0.5) });

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
 *  Both axes, because a caption's height handle is the same kind of action one
 *  field over: `holdTo` writes `boxH`, not a scale, and reports itself as
 *  `resizing` too.
 *
 *  Same bargain as snapScale: the opposite edge must not move, so the change is
 *  answered with half of it on `left` or `top` — the box is centred, so it
 *  grows both ways unless told otherwise. */
export function snapWidth(
  target: Boxed,
  corner: string,
  targets: Box[],
  threshold: number,
): Guide[] {
  const edges = HANDLE_EDGES[corner];
  if (!edges || (target.angle ?? 0) % 360 !== 0) return [];

  target.setCoords();
  const drawn = target.getBoundingRect();
  if (!drawn.width) return [];
  /* Vertically the object's own rect is the text, not the box — a clipped
   * caption is drawn shorter than the lines it holds, and taller than the box
   * when they overflow it. The box is what the handle drags and what the guide
   * has to meet, so the height comes from there. */
  const height = boxHeightOf(target);
  const box = {
    left: drawn.left,
    width: drawn.width,
    top: (target.top ?? 0) - height / 2,
    height,
  };
  const snap = snapEdges(box, edges, targets, threshold);
  if (!snap.dx && !snap.dy) return [];

  if (snap.dx) {
    const grew = edges.includes("right") ? snap.dx : -snap.dx;
    const width = (target.width ?? 0) + grew / (target.scaleX || 1);
    if (width <= 0) return [];
    target.set({ width });
    // The edge the pointer is not holding stays where it was.
    target.left = (target.left ?? 0) + (edges.includes("right") ? grew / 2 : -grew / 2);
  }
  if (snap.dy) {
    const grew = edges.includes("bottom") ? snap.dy : -snap.dy;
    const next = height + grew;
    if (next <= 8) return [];
    target.boxH = next;
    target.top = (target.top ?? 0) + (edges.includes("bottom") ? grew / 2 : -grew / 2);
    const clip = target.clipPath as fabric.Rect | undefined;
    if (clip) clip.set({ top: (target.top ?? 0) - next / 2, height: next });
  }
  target.setCoords();
  return snap.guides.filter((g) => (g.axis === "x" ? !!snap.dx : !!snap.dy));
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
  if (l.kind === "text") obj.controls = { ...obj.controls, ...heightControls() };
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
 *  Two offscreen canvases per masked layer per tile, so a wall of forty-four
 *  costs eighty-eight small renders on every rebuild. Measured (see
 *  perf.browser.test.ts, "what a mask costs"): 321ms against 156ms for the
 *  same wall unmasked — a mask roughly doubles the build, about 3.7ms a tile.
 *
 *  Left as it is, and the number is why rather than a shrug. Full rebuilds
 *  stopped being the common case when rebuildTile landed: an edit redraws one
 *  tile, and the whole wall is only rebuilt when its shape changes — reordered,
 *  a wall picture moved, a project opened. 321ms there is not a wall anyone
 *  waits on.
 *
 *  The cache this note used to prescribe — key on cutter + picture, the way
 *  the icon bake in buildGrid does — is worth a caveat before anyone builds
 *  it. It pays only where two tiles cut the same picture with the same shape,
 *  and a masked layer that is the same on every tile would be baked into the
 *  stamp rather than copied live onto each one. So the hit rate depends on
 *  what people actually build, which the benchmark above cannot tell us: it
 *  measures the cache's best case, forty-four identical composites. Measure a
 *  real masked wall before writing the cache, not this one. */
async function cutToShape(
  l: Layer,
  obj: fabric.Object,
  cutter: Layer,
  deps: SceneDeps,
  tileId: string,
): Promise<fabric.FabricImage | undefined> {
  /* "" is a real answer, and it means this tile shows nothing: no picture to
   * cut with is not the same as no mask, so the layer does not fall back to
   * drawing whole — the caller drops it. Chosen deliberately on 2026-08-09
   * over the other reading, because a tile that was told "no icon here" asking
   * for a bare rectangle of paint instead is the louder surprise.
   *
   * The cutter is read as it stands. It used to be resolved against the tile's
   * swap record first — the Layout owned the picture, the tile owned which one
   * — and the layer carries its own answer now. */
  if (cutter.kind === "image" && !cutter.asset) return undefined;
  if (cutter.kind === "shape" && cutter.shape === "icon" && !cutter.icon) return undefined;

  const shape = await layerObject(
    silhouette(cutter),
    deps,
    { w: TILE_W, h: TILE_H, x: 0, y: 0 },
    tileId,
    true,
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
  /* Collected, then swapped in one pass at the end.
   *
   * Clearing first and filling as the pictures arrive meant the wall flashed
   * on every rebuild — and a rebuild runs on every edit, so nudging a picture
   * a few times made the whole grid blink under the hand. Held back, the old
   * wall simply stays up until the new one is ready; at 63ms a rebuild nobody
   * sees a pause, and on the first open the tiles arrive together instead of
   * filling in one black square at a time.
   *
   * Objects someone else put here are left alone — the framing tool keeps its
   * frame and its ghost on this canvas, and they are not this function's to
   * throw away. */
  const out: fabric.Object[] = [];

  const ids = wall.ids;
  const grid = gridSize(ids.length);

  /* Three passes, because the wall picture belongs between them: every tile's
   * background, then anything spread across the wall, then what the tiles
   * themselves carry. Tiles never overlap — each is clipped to its own cell —
   * so splitting the per-tile work in two changes nothing about them.
   *
   * Started together rather than one after the next. Each background reads a
   * two-megabyte BMP and decodes it, and awaiting them in turn made a wall of
   * forty-four sit black for as long as forty-four disk reads take — in a row.
   * They are added in id order once they are all in, because the order they
   * finish in is not the order they are stacked in. */
  /* One tile's flattened icon is every tile's, when it is the same icon at the
   * same size in the same colour. A wall of forty-four characters draws maybe
   * five distinct classes, and each one used to cost its own 624x804 offscreen
   * render — measured at 44 tiles: 147ms a rebuild, and a rebuild runs on every
   * property edit anywhere.
   *
   * Declared here and dropped when the function returns, deliberately. A cache
   * that outlives the render it serves needs to know when a layer changed, and
   * getting that wrong is a stale wall that nothing explains — this one cannot
   * be stale because it never sees a second state. */
  const flattened = new Map<string, HTMLCanvasElement>();

  const backgrounds = await Promise.all(
    ids.map((id, index) => background(m.tiles[id]?.base ?? null, id, deps, cellAt(index))),
  );
  out.push(...backgrounds);
  /* Which tile each background belongs to, so a single-tile rebuild can find
     the one it replaces. Nothing draws differently for it — the object is not
     a layer and carries no layerId — but an untagged object is one no
     incremental pass can reason about. */
  for (const [index, obj] of backgrounds.entries())
    Object.assign(obj, { tileId: ids[index], space: "base" });

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
    out.push(obj);
  }

  for (const [index, id] of ids.entries()) {
    out.push(...(await tileLayerObjects(id, index, m, deps, interactive, flattened)));
  }

  /* Foreign objects stay, and stay on top. Fabric adds to the end of the list,
     so leaving them where they were buried them under the wall the moment it
     was rebuilt: the placing tool's ghost — the faint whole picture you aim by
     when a mask hides most of what you are dragging — showed for the first drag
     and never again, because the first drag is the first rebuild. Its frame
     looked fine throughout, Fabric drawing an active object's controls on the
     upper canvas whatever is buried below it. Taken off and put back last, in
     their own order. */
  const kept = canvas.getObjects().filter((o) => (o as { keep?: boolean }).keep);
  canvas.remove(...canvas.getObjects());
  for (const obj of out) canvas.add(obj);
  for (const obj of kept) canvas.add(obj);
  canvas.renderAll();
}

/** What one tile draws on top of its background — the unit both buildGrid and
 *  rebuildTile are made of. The background is not in here because the whole
 *  wall's are fetched together (see the note on Promise.all above), and a
 *  single tile's is one await either way.
 *
 *  `flattened` is passed in rather than kept here so a whole-wall build still
 *  shares one icon bake across every tile that wants it; a single-tile rebuild
 *  hands in a map of its own and throws it away, which is the same rule as
 *  before — a cache that outlives its render can go stale. */
/** A stack with its groups dissolved into it. A group draws nothing of its own
 *  — it is a displacement, a shared fade and a shared lock — so folding all
 *  three into its children leaves a flat list that paints the same picture.
 *  layoutObjects reaches the same result by recursing; the wall flattens first
 *  instead, because everything downstream of it (stencilIds, offLayouts, the
 *  cutter lookup, the draw loop) then goes on reading one list and needs no
 *  tree walk of its own.
 *
 *  A hidden group takes its children with it, exactly as in a Layout: the eye
 *  on the row has to mean what it says. */
/** What the wall actually draws for one tile: its stack with the groups folded
 *  away, each member carrying its group's displacement, fade and lock.
 *
 *  Exported because the frame has to follow the same list. Reading the tile's
 *  own stack instead meant a layer inside a group could not be found at all —
 *  it is not in that array — so picking one showed no frame and no ghost. The
 *  positions here are the drawn ones, which is what a frame is for; the write
 *  goes back through applyTransform, which subtracts the nesting again. */
export const drawnLayers = (m: Manifest, tileId: string): Layer[] =>
  dissolved(resolveLayers(m, tileId));

function dissolved(layers: Layer[], dx = 0, dy = 0, fade = 1, locked = false): Layer[] {
  const out: Layer[] = [];
  for (const l of layers) {
    if (l.kind === "group") {
      if (l.hidden) continue;
      const own = groupShift(l);
      out.push(
        ...dissolved(l.children, dx + own.dx, dy + own.dy, fade * l.opacity, locked || !!l.locked),
      );
      continue;
    }
    const moved = dx || dy || fade !== 1 || locked;
    out.push(
      moved
        ? ({ ...l, x: l.x + dx, y: l.y + dy, opacity: l.opacity * fade, locked: locked || !!l.locked } as Layer)
        : l,
    );
  }
  return out;
}

async function tileLayerObjects(
  id: string,
  index: number,
  m: Manifest,
  deps: SceneDeps,
  interactive: boolean,
  flattened: Map<string, HTMLCanvasElement>,
): Promise<fabric.Object[]> {
  const out: fabric.Object[] = [];
  {
    const at = cellAt(index);
    const box = { w: TILE_W, h: TILE_H, x: at.x, y: at.y };
    /* A tile can carry a cutter now: a per-tile layer that is masked brings the
     * shape along, because the Layout it came from is not there to look it up
     * in. Same rule as in a Layout — a shape that is cutting something has
     * stopped being a picture and does not draw itself. */
    const own = dissolved(resolveLayers(m, id));
    const stencils = stencilIds(own);
    /* Empty, and kept as a name rather than deleted at every call site: a
     * layer's own eye is the only one there is now. It used to compose with
     * the eye on the stamp that put it here, because a live copy had no row of
     * its own to switch off. */
    for (const l of own) {
      if (l.hidden || l.space === "grid") continue;
      /* A layer that is cutting another one draws nothing — but it is still a
       * layer somebody has to be able to move and resize, and until now it had
       * no object at all: nothing on the canvas to click, so the placing tool's
       * stand-in was the only handle it had. Built like any other and made
       * fully transparent instead, which puts it back on the ordinary path —
       * drag, scale, snap and read-back all work on it without a case of their
       * own.
       *
       * Invisible and clickable is only safe because of the rule the wall
       * already keeps: none but the layer picked in the list is evented, so
       * this can never swallow a click meant for something else. In the export
       * it is transparent and inert like everywhere else, so the picture
       * written to the game is unchanged. */
      const stencil = stencils.has(l.id);
      // "" is a real answer — no picture on this tile — and the layer simply
      // does not render.
      if (l.kind === "image" && !l.asset) continue;
      /* Cut before placed. The shape sits in tile coordinates, so the layer is
       * built at the tile's own origin, composited against it, and the finished
       * picture is moved into the cell — after which the cell clip below
       * applies to it like to anything else.
       *
       * A cutter that is hidden stops cutting: the eye has to mean the same
       * thing everywhere, and something that is not there cannot be why half a
       * picture is missing. */
      const cut = cutterOf(l, own);
      /* A class icon is paint wearing the artwork as its clipPath, and every
       * tile layer is about to be given the cell as its clipPath — Fabric
       * allows one, so the cell would replace the artwork and the icon would
       * reach the wall as the bare rectangle behind it. Flattened to pixels
       * first, like a cut layer, it arrives as a picture that the cell can clip
       * like any other. */
      const flat = isFlattened(l, own);
      const local = flat ? { ...box, x: 0, y: 0 } : box;
      /* Keyed on the whole resolved layer — and, for a cut one, on the cutter
       * and the tile's choice of picture for it too: everything that changes
       * the pixels is in the key, so two tiles share a canvas only when they
       * would have drawn the same ones. Over-keying costs a miss, never a wrong
       * tile.
       *
       * Captions are left out of the cut cache rather than keyed carefully.
       * layerText resolves "{{id}}" against the tile, so two tiles almost never
       * agree on a caption's pixels — the entry would be written once per tile
       * and read never, which is the cost of a cache with none of the benefit.
       *
       * The cut half of this was the note cutToShape left open: cache by cutter
       * and picture, but measure a real masked wall first. Measured. Two
       * tile-sized canvases per masked layer per tile is 602 of them on a wall
       * of 301, about 1.2GB, and the browser goes down mid-render rather than
       * merely slowing — the entire wall shares one bake now. */
      const cacheable = flat && l.kind !== "text" && (!cut || cut.kind !== "text");
      const key = cacheable
        ? JSON.stringify([l, cut ?? null])
        : "";
      const hit = key ? flattened.get(key) : undefined;
      let obj: fabric.Object;
      if (hit) {
        obj = new fabric.FabricImage(hit, { originX: "left", originY: "top" });
      } else {
        const drawn = await layerObject(l, deps, local, id);
        if (!drawn) continue;
        const made = cut ? await cutToShape(l, drawn, cut, deps, id) : drawn;
        if (!made) continue;
        if (flat) {
          /* A cut layer arrives as a picture already — cutToShape composited it
           * onto a canvas of its own — so it is taken as it is rather than
           * rasterised a second time. */
          const canvas =
            cut && made instanceof fabric.FabricImage
              ? (made.getElement() as HTMLCanvasElement)
              : await toTileCanvas(made);
          if (key) flattened.set(key, canvas);
          obj = new fabric.FabricImage(canvas, { originX: "left", originY: "top" });
        } else {
          obj = made;
        }
      }
      if (flat) {
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
      /* A clip only has to exist where something would otherwise escape. A
       * layer that already sits inside its cell is clipped by a rectangle it
       * never touches — and pays for it twice, because the clip is what forces
       * objectCaching off, so every repaint of the wall rasterises the layer
       * from scratch.
       *
       * That is most of what a wall costs. At 301 tiles the paint was 423 of
       * 450ms with two layers a tile, and it grew faster than the object count
       * once tiles carried more: 3.0x the objects, 4.7x the paint. Letting the
       * layers that stay home keep Fabric's cache is what closes that gap.
       *
       * Shadows are excluded rather than measured: getBoundingRect does not
       * account for one, so a shadow is exactly the thing that reaches past a
       * box this check believes is safe. */
      const inside = (() => {
        if (l.shadow) return false;
        const b = obj.getBoundingRect();
        return b.left >= left && b.top >= top && b.left + b.width <= right && b.top + b.height <= bottom;
      })();
      if (!inside) {
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
      }
      /* Anything a Layout put here is positioned in the Layout, full stop. The
       * wall would be the wrong place to judge it from — the game's grid has
       * gaps, so a caption nudged towards an edge here can end up in a gap or
       * on the neighbour in play — and "Stempel aktualisieren" would throw the
       * nudge away anyway, since the Layout is where the position comes from.
       * Better not to offer the drag than to revert it later. */
      const locked = !!l.locked || !!l.layoutId;
      if (interactive) makeInteractive(obj, locked ? { ...l, locked: true } : l);
      else obj.selectable = obj.evented = false;
      /* A bake is tile-sized whatever the layer inside it measures, so a scale
       * factor read off it says nothing about the layer — the handles were
       * offering a gesture whose result could not be written down. Dragging
       * one still works: the distance from the cell's origin is the distance
       * the hand moved, which is what object:modified writes. */
      if (flat && interactive) {
        obj.hasControls = false;
        obj.lockScalingX = obj.lockScalingY = obj.lockRotation = true;
      }
      /* `flattened` says this object is a whole-tile picture of a layer rather
       * than the layer itself — a mask or a class icon, baked because the cell
       * clip has the one clipPath slot. It sits at the cell's origin at scale 1
       * whatever the layer says, so `readBack` measures the bake and not the
       * placement: dragging one and writing that back puts the layer at 0,0 and
       * loses where it actually was. The wall's stand-in exists for these, and
       * the flag is how it knows. */
      // The cutter's own pixels are not the point — the hole it makes in
      // something else is. It is here to be grabbed, not to be seen.
      if (stencil) obj.opacity = 0;
      Object.assign(obj, { layerId: l.id, tileId: id, space: "tile", locked, flattened: flat });
      out.push(obj);
    }
  }
  return out;
}

/** What is drawn on a canvas, as strings a later state can be compared
 *  against — see wallPrint and soleTileChange. */
export type WallPrint = { ids: string; grid: string; tiles: Map<string, string> };

/** The wall as three comparable things: which tiles are on it and in what
 *  order, the picture spread across it, and what each tile carries.
 *
 *  A tile's drawing comes from `m.tiles[id]` and its slot, and from nothing
 *  else — resolveLayers reads that one record, and an asset name is
 *  content-hashed, so the same name is always the same pixels. That is what
 *  makes a comparison a safe substitute for asking every mutating function to
 *  declare what it touched. */
export const wallPrint = (wall: Wall, m: Manifest): WallPrint => ({
  ids: wall.ids.join(","),
  grid: JSON.stringify(wall.gridLayers),
  tiles: new Map(wall.ids.map((id) => [id, JSON.stringify(m.tiles[id] ?? null)])),
});

/** Which tiles changed between two states, or null when the wall itself did —
 *  no previous state, a different id list, or a moved picture across the grid.
 *  An empty list means nothing changed at all.
 *
 *  Deliberately timid about null. Every null is a full rebuild, which is only
 *  slow; a wrong "just these" is a wall that quietly disagrees with the
 *  document, which is a bug the user finds long after the edit that caused it. */
export function tilesChanged(before: WallPrint | null, after: WallPrint): string[] | null {
  if (!before || before.ids !== after.ids || before.grid !== after.grid) return null;
  const changed: string[] = [];
  for (const [id, print] of after.tiles) if (before.tiles.get(id) !== print) changed.push(id);
  return changed;
}

/** The one tile that changed, or "" when the answer is anything else —
 *  including several at once. Kept as its own name because "exactly one" is
 *  the question the single-tile redraw path asks. */
export function soleTileChange(before: WallPrint | null, after: WallPrint): string {
  const changed = tilesChanged(before, after);
  return changed?.length === 1 ? changed[0] : "";
}

/** Where an object sits in the wall's stack. Backgrounds under the picture
 *  spread across the wall, that under the tiles' own layers, and anything a
 *  caller put here of its own on top — the order buildGrid builds in, written
 *  down so a single tile's objects can be slotted back into it. */
function rank(o: fabric.Object): number {
  if ((o as { keep?: boolean }).keep) return 3;
  const space = (o as { space?: string }).space;
  return space === "base" ? 0 : space === "grid" ? 1 : 2;
}

/** Where an object belongs in the stack, as one number that sorts: the band it
 *  is in, then the slot its tile has on the wall.
 *
 *  The slot is the part that is easy to leave out and easy to miss. Tiles
 *  never overlap, so a rebuilt tile's objects sitting at the end of their band
 *  looks identical on screen — and every later comparison against a full build
 *  disagrees, which is how a second drawing path starts drifting from the
 *  first. */
const stackKey = (slot: Map<string, number>) => (o: fabric.Object) =>
  rank(o) * 1e6 + (slot.get((o as { tileId?: string }).tileId ?? "") ?? -1);

/** Redraws one tile in place, leaving the rest of the wall standing.
 *
 *  buildGrid costs about three milliseconds a tile, and it runs on every edit:
 *  measured at 301 tiles a nudged caption froze the interface for the best
 *  part of a second, all of it spent redrawing 300 tiles that had not changed.
 *  This draws the one that did.
 *
 *  Only what a tile owns. Anything that changes the wall — its id list, the
 *  picture across it, or a Layout every tile wears — still means a full
 *  build, and the caller is what decides that (see GridCanvas): a wrong "only
 *  this tile" is a wall that quietly disagrees with the document, which is
 *  far worse than a slow one.
 *
 *  Only this tile's objects are taken off, and the new ones are put back where
 *  they belong. Clearing the canvas and re-adding everything is the obvious
 *  shape and the wrong one: Fabric's remove() finds each object by scanning
 *  its list, so tearing down a wall of nine hundred costs nine hundred scans
 *  of nine hundred — measured at 301 tiles, a "single tile" rebuild that way
 *  came to 524ms against a full build's 1205ms, which is not a saving worth
 *  the second code path. Taking off three objects and inserting three costs
 *  six. */
export async function rebuildTile(
  canvas: fabric.StaticCanvas,
  id: string,
  wall: Wall,
  m: Manifest,
  deps: SceneDeps,
  interactive = false,
  /* Off when a caller is redrawing several tiles in a row, so the wall is
   * painted once at the end instead of once per tile.
   *
   * Painting is nearly the whole cost of this function — at 301 tiles a single
   * tile measured 497ms, of which 449ms was the paint — so a loop that repaints
   * per tile is slower than rebuilding the entire wall: eight tiles came to
   * 4126ms against a full build's 990ms. Measured, after a small-set redraw was
   * added and turned out to be a pessimisation. */
  render = true,
): Promise<void> {
  const index = wall.ids.indexOf(id);
  if (index < 0) return;

  const fresh = await background(m.tiles[id]?.base ?? null, id, deps, cellAt(index));
  Object.assign(fresh, { tileId: id, space: "base" });
  const objects = [
    fresh,
    ...(await tileLayerObjects(id, index, m, deps, interactive, new Map())),
  ];

  /* `keep` is checked first and not left to the rank: an object someone else
     put here is never this function's to throw away, whatever it claims to
     stand on — the placing tool's frame stands on the very tile being
     redrawn. */
  const mine = canvas
    .getObjects()
    .filter((o) => !(o as { keep?: boolean }).keep && (o as { tileId?: string }).tileId === id);
  canvas.remove(...mine);

  const key = stackKey(new Map(wall.ids.map((tile, i) => [tile, i])));
  for (const obj of objects) {
    /* The first object that belongs above this one; the end of the list when
       there is none. Walking is fine — it is a few hundred integer compares
       per object, against the render this whole function exists to avoid. */
    const mineKey = key(obj);
    const list = canvas.getObjects();
    let at = list.length;
    for (let i = 0; i < list.length; i++) {
      if (key(list[i]) > mineKey) {
        at = i;
        break;
      }
    }
    canvas.insertAt(at, obj);
  }
  if (render) canvas.renderAll();
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
    /* The same two the Layout reads back. The side and height handles are put
     * on wall objects too (makeInteractive does not ask which canvas it is on),
     * so leaving these out meant a crop or a caption height dragged on the wall
     * was measured, applied to the object, and then dropped on the way to the
     * model — the gesture worked and the next rebuild undid it. */
    crop: cropOff(obj),
    boxH: (obj as { boxH?: number }).boxH,
    rotation: obj.angle ?? 0,
  };
}

/** The trim a picture is currently showing through, or nothing at all.
 *
 *  Undefined rather than four zeroes for an untrimmed picture, so a layer that
 *  was never cropped stores no crop — and every layer that is not a picture
 *  answers the same way. */
function cropOff(obj: fabric.Object): Inset | undefined {
  const img = obj as fabric.FabricImage;
  /* A framed picture is a different picture by the time it gets here: drawing
     the border means baking the trimmed window into a canvas of its own and
     handing that to Fabric, so `getOriginalSize` reports the window and cropX
     is nought — and the measurement below then answers "not trimmed at all".
     `resize` reads that as the trim having been let go and deletes it, so
     turning on a border and nudging the picture untrimmed it, and did so on
     every selected tile at once.

     What was baked in is remembered at the moment it is baked, and handed back
     here unchanged. ponytail: it comes back unchanged, so the side handles do
     nothing on a framed picture rather than measuring it against the wrong
     image — a dead handle where there used to be a compounding wrong crop.
     Trimming a framed picture wants frameImage to stop replacing the element;
     that is a bigger change than this one. */
  const baked = (obj as { bakedCrop?: Inset }).bakedCrop;
  if (baked) return { ...baked };
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

