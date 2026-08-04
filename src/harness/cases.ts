/** The layer constellations the harness renders down both paths.
 *
 *  Each case is deliberately built around one thing that has actually broken
 *  during the Fabric migration, so a regression shows up as a number rather
 *  than as a screenshot someone has to interpret. */
import {
  newGroupLayer,
  newImageLayer,
  newShapeLayer,
  newTextLayer,
  type Effective,
  type Layer,
} from "../lib/model";

export type Case = { name: string; eff: Effective; note: string };

/** Layers are built through the real factories so every default matches what
 *  the app itself would create; only the fields a case is about get overridden. */
const at = <T extends Layer>(l: T, x: number, y: number): T => ({ ...l, x, y });

function shape(kind: "rect" | "ellipse" | "polygon", x: number, y: number, over: Partial<ReturnType<typeof newShapeLayer>> = {}) {
  return { ...at(newShapeLayer(kind), x, y), ...over };
}

function image(asset: string, x: number, y: number, over: Partial<ReturnType<typeof newImageLayer>> = {}) {
  return { ...at(newImageLayer(asset), x, y), ...over };
}

function text(content: string, x: number, y: number, over: Partial<ReturnType<typeof newTextLayer>> = {}) {
  return { ...at(newTextLayer(), x, y), text: content, ...over };
}

const eff = (layers: Layer[]): Effective => ({ base: null, layers, text: {} });

export function cases(): Case[] {
  const list: Case[] = [];

  list.push({
    name: "tile original as background",
    note: "One trivial layer, so drawTile falls back to the tile's own original underneath.",
    eff: eff([shape("rect", 0.5, 0.05, { w: 0.05, h: 0.02 })]),
  });

  list.push({
    name: "explicit base picture, cropped",
    note: "eff.base with a crop — the mosaic path, where base and layers share no code.",
    eff: {
      base: { asset: "mosaic.png", crop: { x: 40, y: 30, w: 200, h: 180 } },
      layers: [shape("rect", 0.5, 0.05, { w: 0.05, h: 0.02 })],
      text: {},
    },
  });

  list.push({
    name: "single shape",
    note: "Baseline geometry: centre-origin fraction to pixels, no masking involved.",
    eff: eff([shape("rect", 0.5, 0.5)]),
  });

  list.push({
    name: "off-centre rotated shape",
    note: "Position and rotation away from the neutral centre, where offset errors show.",
    eff: eff([shape("ellipse", 0.3, 0.7, { rotation: 30, w: 0.4, h: 0.2 })]),
  });

  list.push({
    name: "single image",
    note: "Image scaling: model scale is a fraction of tile width, aspect from the asset.",
    eff: eff([image("boss.png", 0.5, 0.5)]),
  });

  {
    // The reported "image on shape is far too small" case.
    const mask = shape("polygon", 0.6, 0.6, { sides: 6 });
    const target = image("boss.png", 0.6, 0.6, { maskId: mask.id });
    list.push({
      name: "image masked by shape",
      note: "Regression case: a downscaled image clipped by a polygon.",
      eff: eff([mask, target]),
    });
  }

  {
    // The reported "shape on text is fuzzy/distorted" case.
    const mask = text("MASK", 0.5, 0.5, { size: 0.16 });
    const target = shape("rect", 0.5, 0.5, { w: 0.7, h: 0.2, fill: "#40e0d0", maskId: mask.id });
    list.push({
      name: "shape masked by text",
      note: "Text as a clip source. Fabric lays text out itself, so expect some drift here.",
      eff: eff([mask, target]),
    });
  }

  {
    const mask = image("stencil.png", 0.5, 0.5);
    const target = shape("rect", 0.5, 0.5, { w: 0.6, h: 0.4, fill: "#40e0d0", maskId: mask.id });
    list.push({
      name: "shape masked by image",
      note: "Newly added image-as-mask path, fully opaque stencil.",
      eff: eff([mask, target]),
    });
  }

  {
    // The real-world stencil: a cut-out PNG. render.ts masks by the alpha
    // shape; Fabric's clipPath uses an image's geometry, so this is where the
    // two are expected to disagree if Fabric cannot do alpha masking.
    const mask = image("cutout.png", 0.5, 0.5);
    const target = shape("rect", 0.5, 0.5, { w: 0.6, h: 0.4, fill: "#40e0d0", maskId: mask.id });
    list.push({
      name: "shape masked by transparent image",
      note: "Cut-out stencil: alpha shape (truth) vs. Fabric's clipPath geometry.",
      eff: eff([mask, target]),
    });
  }

  {
    // The reported "still fuzzy in Fabric, fine in the tile preview" case: a
    // stencil made of thin lines. Soft rasterization of the clip is invisible
    // on a blob but destroys detail like this.
    const mask = image("fine-stencil.png", 0.5, 0.5);
    const target = shape("rect", 0.5, 0.5, { w: 0.6, h: 0.5, fill: "#40e0d0", maskId: mask.id });
    list.push({
      name: "shape masked by fine-detail image",
      note: "Thin-line stencil — reproduces the blurry mask edges reported in the editor.",
      eff: eff([mask, target]),
    });
  }

  {
    // Multi-word text: drawTile renders one unbroken fillText line, so anything
    // that wraps (Fabric's Textbox has a width and breaks on spaces) shows here.
    list.push({
      name: "multi-word text",
      note: "Spaces must not wrap: drawTile renders a single line.",
      eff: eff([text("TWO WORDS HERE", 0.5, 0.45, { size: 0.07 })]),
    });
  }

  {
    // Alignment moves the text relative to its anchor, which is originX in
    // Fabric and ctx.textAlign in render.ts — easy to have agree only by
    // accident at "center", so both off-centre alignments are checked.
    for (const align of ["left", "right"] as const) {
      list.push({
        name: `text aligned ${align}`,
        note: `Anchor handling: ${align}-aligned text must sit identically in both paths.`,
        eff: eff([text("ALIGNED", 0.5, 0.45, { size: 0.08, align })]),
      });
    }
  }

  {
    // Rebuilt from a reported "still fuzzy" tile: a glowing rectangle clipped
    // to a rotated, semi-transparent text layer. Glow, shadow and text outline
    // were never covered by any other case, which is exactly how a whole
    // family of effects stayed missing from the Fabric side unnoticed.
    const mask = text("Text", 0.35, 0.5, { size: 0.295, rotation: -90, opacity: 0.74, align: "left" });
    const target = shape("rect", 0.35, 0.5, {
      w: 0.3,
      h: 0.55,
      fill: "#40e0d0",
      borderWidth: 0.003,
      maskId: mask.id,
      glow: 0.08,
      glowColor: "#6aa9c0",
      glowOpacity: 0.5,
    });
    list.push({
      name: "glowing shape masked by rotated text",
      note: "The reported fuzzy case, rebuilt: glow + rotation + opacity + text mask.",
      eff: eff([mask, target]),
    });
  }

  {
    // Straight from a real project file: a height of 110 (i.e. 110x the tile,
    // ~90000px) typed into the number box, which accepts values past the
    // slider's max. drawTile just draws past the edge; Fabric caps its cache
    // canvas and rasterizes the object — and its mask — at a few percent of
    // the needed resolution, which is what "fuzzy" turned out to be.
    const mask = text("Text", 0.35, 0.5, { size: 0.295, rotation: -90 });
    const target = shape("rect", 0.12, 0.71, { w: 0.3, h: 110, fill: "#0fd8db", maskId: mask.id });
    list.push({
      name: "shape with out-of-range height, masked",
      note: "Oversized geometry from a real manifest — cache capping wrecks resolution.",
      eff: eff([mask, target]),
    });
  }

  list.push({
    name: "glow on a plain shape",
    note: "Glow alone — isolates it from masking.",
    eff: eff([shape("ellipse", 0.5, 0.5, { fill: "#40e0d0", glow: 0.06, glowColor: "#ffffff", glowOpacity: 0.8 })]),
  });

  list.push({
    name: "text with outline and shadow",
    note: "Text stroke and drop shadow — neither is built on the Fabric side.",
    eff: eff([text("EDGE", 0.5, 0.5, { size: 0.12, strokeWidth: 0.004, strokeColor: "#000000", shadow: 0.03, shadowColor: "#000000" })]),
  });

  {
    list.push({
      name: "bold italic text",
      note: "Weight and style must reach both the CSS font shorthand and Fabric's fontWeight/fontStyle.",
      eff: eff([text("STYLED", 0.5, 0.45, { size: 0.09, bold: true, italic: true })]),
    });
  }

  {
    list.push({
      name: "multi-line text",
      note: "Explicit line breaks (Shift+Enter): fillText ignores \\n, so lines are placed by hand.",
      eff: eff([text("FIRST\nSECOND LINE", 0.5, 0.45, { size: 0.07 })]),
    });
  }

  {
    // Children carry absolute coordinates; the group's own x/y is a displacement.
    const kids = [shape("rect", 0.35, 0.4, { w: 0.2, h: 0.2 }), image("boss.png", 0.6, 0.6)];
    list.push({
      name: "group, undisplaced",
      note: "Group at the neutral 0.5/0.5 — must render exactly like its loose children.",
      eff: eff([{ ...newGroupLayer(kids) }]),
    });
  }

  {
    const kids = [shape("rect", 0.35, 0.4, { w: 0.2, h: 0.2 }), image("boss.png", 0.6, 0.6)];
    list.push({
      name: "group, displaced",
      note: "Group moved off centre: the classic bounding-box-vs-displacement bug.",
      eff: eff([at(newGroupLayer(kids), 0.35, 0.62)]),
    });
  }

  {
    // The reported "mask inside a moved group drags behind" case.
    const mask = shape("polygon", 0.55, 0.5, { sides: 6 });
    const target = image("boss.png", 0.55, 0.5, { maskId: mask.id });
    list.push({
      name: "masked layer inside displaced group",
      note: "Both mask and target nested, group displaced — the ancestor-offset case.",
      eff: eff([at(newGroupLayer([mask, target]), 0.4, 0.6)]),
    });
  }

  {
    // The reported blur case: text and image grouped with a shape that blows
    // the group's bounding box up. Opacity stays 1 so this measures sharpness
    // alone, with no compositing difference mixed in.
    const kids = [
      shape("rect", 0.5, 0.5, { w: 0.9, h: 0.8, fill: "#20303a" }),
      text("SHARP", 0.5, 0.35, { size: 0.1 }),
      image("boss.png", 0.5, 0.65),
    ];
    list.push({
      name: "group with box-inflating shape (blur case)",
      note: "Text and image grouped with a large shape — where group cache resolution showed as blur.",
      eff: eff([newGroupLayer(kids)]),
    });
  }

  {
    // Same idea, taken to the extreme: one member reaches far outside the tile,
    // so the group's bounding box — and with it its cache canvas — explodes.
    // If Fabric caps that canvas and scales it back down, everything in the
    // group is rasterized coarsely, which is what blur from caching looks like.
    const kids = [
      shape("rect", 2.6, 1.9, { w: 3.5, h: 3.0, fill: "#20303a" }),
      text("SHARP", 0.5, 0.35, { size: 0.1 }),
      image("boss.png", 0.5, 0.6),
    ];
    list.push({
      name: "group with far-outside member (cache cap)",
      note: "Bounding box far beyond the tile — tests whether cache capping degrades the whole group.",
      eff: eff([newGroupLayer(kids)]),
    });
  }

  {
    // Overlapping children at group opacity: the flattening question. Painting
    // children individually at 0.5 lets them show through each other; painting
    // the flattened group at 0.5 does not.
    const kids = [
      shape("rect", 0.42, 0.45, { w: 0.35, h: 0.35, fill: "#ff5040" }),
      shape("ellipse", 0.58, 0.55, { w: 0.35, h: 0.35, fill: "#40e0d0" }),
    ];
    list.push({
      name: "group opacity over overlapping children",
      note: "Isolates flattening: overlap must not show through at group opacity 0.5.",
      eff: eff([{ ...newGroupLayer(kids), opacity: 0.5 }]),
    });
  }

  list.push({
    name: "opacity and rotation on a group",
    note: "Group-level opacity must apply to the flattened result, not per child.",
    eff: eff([{ ...at(newGroupLayer([shape("rect", 0.4, 0.45, { w: 0.3, h: 0.3 }), shape("ellipse", 0.55, 0.55, { w: 0.3, h: 0.3, fill: "#40e0d0" })]), 0.5, 0.5), opacity: 0.5, rotation: 15 }]),
  });

  return list;
}
