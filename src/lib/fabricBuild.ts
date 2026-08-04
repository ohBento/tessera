/** Shared by TileEditor.svelte and the render harness
 *  (the real editor canvas) so the coordinate-mapping and mask-offset fixes found
 *  during the spike live in one place instead of two copies drifting apart. */
import * as fabric from "fabric";
import { assetUrl, loadAsset, loadOriginal } from "./project";
import { LINE_HEIGHT } from "./render";

/** Fabric's own `_fontSizeMult`, which it multiplies into every line advance
 *  on top of `lineHeight`. Not exported by the library, so it is mirrored
 *  here — the harness's multi-line case fails if it ever changes. */
const FABRIC_FONT_SIZE_MULT = 1.13;
import { findLayer, isGradient, layerText, type Effective, type Gradient, type Layer, type Paint } from "./model";

/** Fabric's ImageSource type doesn't include ImageBitmap (only DOM image/canvas/video
 *  elements), even though a canvas 2d context happily draws one — round-trip through
 *  a plain <canvas> once so Fabric gets an element type it recognizes. */
function toCanvas(bmp: ImageBitmap): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  return c;
}

/** The tile's background, matching render.ts's drawTile: an explicit base
 *  picture if one was set, otherwise the tile's own untouched original — a
 *  shape or text layer with nothing under it would otherwise float over
 *  whatever the canvas background happens to be instead of the face. */
export async function buildBackground(dir: string, tileId: string, eff: Effective, W: number, H: number): Promise<fabric.Object> {
  if (eff.base) {
    const img = toCanvas(await loadAsset(dir, eff.base.asset));
    const c = eff.base.crop;
    return new fabric.FabricImage(img, {
      cropX: c.x,
      cropY: c.y,
      width: c.w,
      height: c.h,
      scaleX: W / c.w,
      scaleY: H / c.h,
      left: 0,
      top: 0,
      originX: "left",
      originY: "top",
      selectable: false,
      evented: false,
    });
  }
  const img = toCanvas(await loadOriginal(dir, tileId));
  return new fabric.FabricImage(img, {
    scaleX: W / img.width,
    scaleY: H / img.height,
    left: 0,
    top: 0,
    originX: "left",
    originY: "top",
    selectable: false,
    evented: false,
  });
}

export function toFabricFill(paint: Paint, w: number, h: number): string | fabric.TFiller {
  if (!isGradient(paint)) return paint;
  const g = paint as Gradient;
  if (g.radial) {
    const r = (Math.max(w, h) / 2) * (g.radius ?? 1);
    return new fabric.Gradient({
      type: "radial",
      coords: { x1: 0, y1: 0, r1: 0, x2: 0, y2: 0, r2: r },
      colorStops: [{ offset: 0, color: g.from }, { offset: 1, color: g.to }],
    }) as fabric.TFiller;
  }
  const rad = (g.angle * Math.PI) / 180;
  const dx = (Math.cos(rad) * w) / 2;
  const dy = (Math.sin(rad) * h) / 2;
  return new fabric.Gradient({
    type: "linear",
    coords: { x1: -dx, y1: -dy, x2: dx, y2: dy },
    colorStops: [{ offset: 0, color: g.from }, { offset: 1, color: g.to }],
  }) as fabric.TFiller;
}

/** A Fabric object built from one layer carries the model id it came from, so
 *  selection events and write-back can map back to `editable(tileId, layerId)`. */
export type TaggedObject = fabric.Object & { layerId: string };

const solid = (paint: Paint) => (isGradient(paint) ? (paint as Gradient).from : paint);

/** Glow and shadow as a Fabric shadow, which is the only halo primitive it has.
 *
 *  render.ts builds a glow by blurring a silhouette with a CSS filter and
 *  compositing it under the layer, and a text shadow with ctx.shadowBlur. The
 *  two use different blur scales — `filter: blur(N)` has standard deviation N,
 *  while `shadowBlur = B` has B/2 — so a glow needs twice its radius here and a
 *  shadow needs it unchanged. Fabric holds only one shadow per object, so a
 *  layer carrying both keeps the glow: it is the one with its own colour and
 *  opacity, and therefore the one that reads as deliberate. */
function toFabricShadow(l: Layer, W: number): fabric.Shadow | undefined {
  const glow = l.glow ?? 0;
  if (glow > 0) {
    const colour = new fabric.Color(solid(l.glowColor ?? "#ffffff"));
    colour.setAlpha(l.glowOpacity ?? 1);
    return new fabric.Shadow({ color: colour.toRgba(), blur: 2 * glow * W, offsetX: 0, offsetY: 0 });
  }
  if (l.kind === "text" && l.shadow > 0) {
    return new fabric.Shadow({ color: l.shadowColor, blur: l.shadow * W, offsetX: 0, offsetY: 0 });
  }
  return undefined;
}

export type BuildCtx = {
  dir: string;
  eff: Effective;
  tileId: string;
  W: number;
  H: number;
  /** Top-level layers become selectable/draggable; group children never do —
   *  Fabric's nested-group sub-target selection is its own can of worms, and
   *  the layer list already lets you pick and edit a nested layer's fields. */
  interactive?: boolean;
};

/** Builds a Fabric object at the layer's *absolute* tile position (fraction *
 *  W/H, same centre-origin convention as the model) — never parented into a
 *  Group here. Group nesting is handled by the caller, matching how render.ts
 *  treats a group's own x/y as a displacement on top of children that already
 *  carry absolute coordinates.
 *
 *  render.ts's ground truth (paintLayer) positions a mask purely from the
 *  mask layer's *own* x/y/rotation, in the same absolute tile space the
 *  target is drawn in — never composed with the target's own rotation or
 *  scale (a rotated or scaled-down image being masked does not rotate or
 *  shrink the mask). A relative (`absolutePositioned: false`) Fabric clip was
 *  tried instead: Fabric maps a relative clip into the *target's own local,
 *  pre-scale coordinate space, which for a heavily downscaled image made the
 *  clip enormous relative to that space — masking away all but a sliver.
 *  Back to absolute clip coordinates; dx/dy is the sum of every ancestor
 *  group's own (x-0.5)*W/H displacement, matching paintGroup flattening its
 *  children (mask included) in one pass and shifting the result as a whole.
 *  Trade-off: an absolute clip does not track a *live* interactive drag of an
 *  ancestor group in real time — it snaps to the correct spot once the drag
 *  ends and the scene rebuilds from the updated model, same as before. */
export async function buildLayerObject(l: Layer, ctx: BuildCtx, dx = 0, dy = 0): Promise<fabric.Object | null> {
  const obj = await buildRaw(l, ctx, dx, dy);
  if (!obj) return null;
  if (l.maskId && l.kind !== "group") {
    const maskLayer = findLayer(ctx.eff.layers, l.maskId);
    const clip = maskLayer ? await buildLayerObject(maskLayer, ctx) : null;
    if (clip) {
      clip.left = (clip.left ?? 0) + dx;
      clip.top = (clip.top ?? 0) + dy;
      clip.absolutePositioned = true;
      obj.clipPath = clip;
    }
  }
  return obj;
}

/** Builds the Fabric object for one layer, ignoring maskId — masking is
 *  applied by buildLayerObject for every layer alike, group child or not, so
 *  it is not lost when the layer sits inside a group. */
async function buildRaw(l: Layer, ctx: BuildCtx, dx: number, dy: number): Promise<fabric.Object | null> {
  const { W, H, tileId } = ctx;
  if (l.kind === "group") {
    const kids = (
      await Promise.all(l.children.map((c) => buildLayerObject(c, ctx, dx + (l.x - 0.5) * W, dy + (l.y - 0.5) * H)))
    ).filter((o): o is fabric.Object => !!o);
    if (!kids.length) return null;
    // Caching decides whether the group is drawn flattened or child by child,
    // and both answers are wrong somewhere — measured against render.ts in
    // src/harness (see harness.html):
    //
    //   cached:   composites correctly, but rasterizes the group to a canvas
    //             sized off its bounding box, so one far-flung member drags
    //             the whole group's resolution down (blur: 0.65% -> 1.43% off)
    //   uncached: pixel-exact, but applies the group's opacity/blend to each
    //             child in turn, so overlapping members show through each
    //             other instead of fading as one object (0% -> 4.07% off)
    //
    // Flattening only changes the result when there is something to composite
    // with, so cache exactly then and stay sharp everywhere else. Matches
    // paintGroup in render.ts, which flattens for precisely these properties.
    const composited = l.opacity < 1 || l.blend !== "source-over";
    const group = new fabric.Group(kids, {
      originX: "center",
      originY: "center",
      objectCaching: composited,
    });
    // The group's own x/y is a displacement on top of children already placed
    // absolutely — Fabric just gave the group a bounding-box centre from those
    // children, so nudge it by the same delta render.ts applies.
    group.left = (group.left ?? 0) + (l.x - 0.5) * W;
    group.top = (group.top ?? 0) + (l.y - 0.5) * H;
    group.angle = l.rotation;
    group.opacity = l.opacity;
    group.shadow = toFabricShadow(l, W) ?? null;
    group.selectable = !!ctx.interactive && !l.locked;
    group.evented = !!ctx.interactive && !l.locked;
    // subTargetCheck/interactive were tried here to let a member be picked and
    // dragged on its own without dissolving the group first (lining a masked
    // layer up inside its mask). Fabric's hit-testing with those on always
    // dives to the deepest child under the pointer — it does not fall back to
    // the group even when the group is already the active object, so clicking
    // anywhere on a selected group's own rendered area silently re-targeted
    // the drag onto whichever child was under the cursor, and only that child
    // moved. A member is still reachable and individually draggable by
    // picking it in the layer list first (TileEditor's syncCanvasSelection
    // sets it active directly, bypassing hit-testing entirely) — just not by
    // clicking straight into the group on canvas.
    group.hasControls = false;
    (group as unknown as TaggedObject).layerId = l.id;
    return group;
  }

  let obj: fabric.Object;
  if (l.kind === "shape") {
    const w = l.w * W;
    const h = l.h * H;
    const fill = toFabricFill(l.fill, w, h);
    const common = {
      originX: "center" as const,
      originY: "center" as const,
      fill,
      stroke: l.borderWidth > 0 ? l.borderColor : undefined,
      strokeWidth: l.borderWidth > 0 ? l.borderWidth * W : 0,
    };
    if (l.shape === "rect") {
      obj = new fabric.Rect({ ...common, width: w, height: h, rx: Math.min(w, h) * Math.min(Math.max(l.cornerRadius, 0), 0.5), ry: Math.min(w, h) * Math.min(Math.max(l.cornerRadius, 0), 0.5) });
    } else if (l.shape === "ellipse") {
      obj = new fabric.Ellipse({ ...common, rx: w / 2, ry: h / 2 });
    } else {
      const n = Math.max(3, Math.round(l.sides));
      const points = Array.from({ length: n }, (_, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        return { x: (Math.cos(a) * w) / 2, y: (Math.sin(a) * h) / 2 };
      });
      obj = new fabric.Polygon(points, common);
    }
  } else if (l.kind === "text") {
    const text = layerText(ctx.eff.text ?? {}, l, tileId);
    // Text, not Textbox: a Textbox has a fixed width and wraps at spaces, so a
    // caption with a space in it broke onto a second line here while drawTile
    // drew it as one unbroken fillText run. Text grows with its content, which
    // is what the ground truth does.
    const align = l.align ?? "center";
    obj = new fabric.Text(text || " ", {
      // originX, not just textAlign: render.ts sets ctx.textAlign and draws at
      // the layer's x/y, so alignment moves the text relative to that anchor.
      // In Fabric that is what originX does — textAlign only distributes lines
      // within an already-placed box, so on its own it would leave every
      // alignment centred on x and disagree with the export.
      originX: align,
      originY: "center",
      fontWeight: l.bold ? "bold" : "normal",
      fontStyle: l.italic ? "italic" : "normal",
      stroke: l.strokeWidth > 0 ? l.strokeColor : undefined,
      strokeWidth: l.strokeWidth > 0 ? l.strokeWidth * W : 0,
      paintFirst: "stroke",
      strokeLineJoin: "round",
      fontSize: l.size * W,
      fontFamily: l.font,
      fill: toFabricFill(l.color, l.size * W * text.length * 0.6, l.size * W),
      textAlign: align,
      // Fabric's line advance is fontSize * lineHeight * _fontSizeMult, and
      // that last factor (1.13) is baked in, so passing LINE_HEIGHT straight
      // through would space lines ~13% wider than render.ts places them.
      // Dividing it out makes the two agree; the harness's multi-line case is
      // what would catch this drifting again.
      lineHeight: LINE_HEIGHT / FABRIC_FONT_SIZE_MULT,
    });
  } else {
    const url = await assetUrl(ctx.dir, l.asset);
    const img = await fabric.FabricImage.fromURL(url);
    const w = l.scale * W;
    img.scaleToWidth(w);
    img.set({ originX: "center", originY: "center", flipX: !!l.flipX, flipY: !!l.flipY });
    obj = img;
  }

  obj.set({
    left: l.x * W,
    top: l.y * H,
    angle: l.rotation,
    opacity: l.opacity,
    shadow: toFabricShadow(l, W),
    selectable: !!ctx.interactive && !l.locked,
    evented: !!ctx.interactive && !l.locked,
    hasControls: false,
    // NOTE: do NOT set objectCaching:false here, however tempting it looks as
    // an anti-blur measure. Fabric only passes a populated DrawContext (cache
    // size, zoom, translation) down to clipPath rendering from its *cached*
    // render branch; the uncached branch calls drawObject(ctx, false, {}) with
    // an empty one. createClipPathLayer then builds the clip's canvas via
    // createCanvasElementFor({}) — width/height undefined, so it silently
    // falls back to 300x150 — and its translate/scale become no-ops. Result:
    // every masked layer clipped against a tiny, mispositioned canvas. Groups
    // (below) can safely disable caching because a group never carries a mask.
  });
  (obj as unknown as TaggedObject).layerId = l.id;
  return obj;
}
