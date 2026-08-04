/** Stand-in for lib/project.ts in the render harness (see harness.html).
 *
 *  project.ts is the only Tauri dependency of render.ts and fabricBuild.ts —
 *  everything else in the render chain (model.ts, bmp.ts) is plain TS. Swapping
 *  just this module via vite.harness.config.ts lets both render paths run in a
 *  normal browser, so the Fabric canvas can be diffed against render.ts's
 *  drawTile without a Tauri shell and without touching the production build.
 *
 *  The pictures are generated, deterministic, and — crucially — identical
 *  whether they are fetched as an ImageBitmap (render.ts's route) or as a URL
 *  (fabricBuild.ts's route). A difference between those two would show up as a
 *  fake diff and discredit every result. */

const TILE_W = 624;
const TILE_H = 804;

/** Distinct but stable per name, so two different assets never look alike and
 *  the same asset always looks the same across runs. */
function hueFor(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** A picture with strong, asymmetric features: an off-centre disc, a corner
 *  wedge and a grid. Symmetric test images hide exactly the bugs this harness
 *  exists to catch — a mirrored or 180°-rotated result would score as perfect. */
function paint(name: string, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const hue = hueFor(name);

  // A name containing "cut" yields a picture that is transparent outside a
  // disc. Stencils in the real project are cut-out PNGs/SVGs, and a fully
  // opaque test image cannot tell an alpha-shaped mask from a bounding box.
  // "fine" yields thin spokes and rings on transparency — a stencil with real
  // detail. A coarse blob cannot reveal a mask that is rasterized too softly,
  // which is exactly the complaint this has to reproduce.
  if (name.includes("fine")) {
    ctx.translate(w / 2, h / 2);
    const r = Math.min(w, h);
    ctx.strokeStyle = `hsl(${hue} 70% 55%)`;
    ctx.lineWidth = Math.max(1.5, r * 0.012);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 0.12, Math.sin(a) * r * 0.12);
      ctx.lineTo(Math.cos(a) * r * 0.46, Math.sin(a) * r * 0.46);
      ctx.stroke();
    }
    for (const ring of [0.2, 0.32, 0.44]) {
      ctx.beginPath();
      ctx.arc(0, 0, r * ring, 0, Math.PI * 2);
      ctx.stroke();
    }
    return c;
  }

  if (name.includes("cut")) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.42, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = `hsl(${hue} 60% 45%)`;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = `hsl(${(hue + 140) % 360} 70% 65%)`;
    ctx.fillRect(0, 0, w, h * 0.35);
    ctx.restore();
    return c;
  }

  ctx.fillStyle = `hsl(${hue} 60% 45%)`;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = `hsl(${(hue + 140) % 360} 70% 65%)`;
  ctx.beginPath();
  ctx.arc(w * 0.35, h * 0.4, Math.min(w, h) * 0.22, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = `hsl(${(hue + 40) % 360} 80% 30%)`;
  ctx.beginPath();
  ctx.moveTo(w, 0);
  ctx.lineTo(w, h * 0.45);
  ctx.lineTo(w * 0.55, 0);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 2;
  for (let x = 0; x <= w; x += Math.max(16, Math.round(w / 8))) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += Math.max(16, Math.round(h / 8))) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  return c;
}

/* One canvas per key, shared by both accessors — this is what guarantees the
 * ImageBitmap and the URL carry identical pixels. */
const canvases = new Map<string, HTMLCanvasElement>();

/** Assets are square-ish and clearly not tile-shaped, so a path that wrongly
 *  assumes tile proportions is visible rather than silently plausible. */
const canvasFor = (key: string, w: number, h: number) => {
  let c = canvases.get(key);
  if (!c) {
    c = paint(key, w, h);
    canvases.set(key, c);
  }
  return c;
};

export function loadAsset(_dir: string, name: string): Promise<ImageBitmap> {
  return createImageBitmap(canvasFor(`asset:${name}`, 400, 300));
}

export function loadOriginal(_dir: string, id: string): Promise<ImageBitmap> {
  return createImageBitmap(canvasFor(`tile:${id}`, TILE_W, TILE_H));
}

export function assetUrl(_dir: string, name: string): Promise<string> {
  return Promise.resolve(canvasFor(`asset:${name}`, 400, 300).toDataURL("image/png"));
}
