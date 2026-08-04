/** Renders every case down both paths and reports how far apart they are.
 *
 *  render.ts is the ground truth — it produces the exported BMP — so any
 *  disagreement means the Fabric editor is wrong. Results are also written to
 *  `window.__harness` so they can be read programmatically instead of squinted
 *  at, which is the whole point of this page. */
import * as fabric from "fabric";
import { TILE_H, TILE_W } from "../lib/bmp";
import { drawTile } from "../lib/render";
import { buildBackground, buildLayerObject, type BuildCtx } from "../lib/fabricBuild";
import { cases, type Case } from "./cases";

const W = 640;
const H = Math.round((W * TILE_H) / TILE_W);
const DIR = "/mock";
const TILE_ID = "40000000014726120";

/** Windows display scaling makes the app's WebView report a devicePixelRatio
 *  above 1, which this browser may not. Fabric scales its canvas by it and caps
 *  cache canvases by area, so sharpness can differ from a plain DPR-1 run —
 *  ?dpr=1.5 reproduces that here. */
const DPR = Number(new URLSearchParams(location.search).get("dpr")) || 0;
if (DPR) fabric.config.configure({ devicePixelRatio: DPR });

/** Anti-aliasing and text hinting differ slightly between a 2D path fill and
 *  Fabric's own render, so a handful of edge pixels will never match exactly.
 *  Only a channel difference past this counts as a real disagreement. */
const CHANNEL_TOLERANCE = 16;

export type Result = {
  name: string;
  note: string;
  meanAbs: number;
  badPct: number;
  error?: string;
};

async function renderGroundTruth(c: Case): Promise<ImageData> {
  const canvas = await drawTile(DIR, TILE_ID, c.eff, W, H);
  return canvas.getContext("2d")!.getImageData(0, 0, W, H);
}

async function renderFabric(c: Case): Promise<ImageData> {
  // Rendered on a scratch element, never the one shown: dispose() wipes the
  // canvas it was attached to, which would leave the displayed copy blank and
  // any later pixel inspection reading an empty image.
  const el = canvasEl(W, H);
  // Attached to the document, because Fabric's retina handling reads live
  // layout — an orphan canvas can rasterize differently from the editor's.
  el.style.position = "absolute";
  el.style.left = "-10000px";
  document.body.append(el);
  const fc = new fabric.Canvas(el, { width: W, height: H, renderOnAddRemove: false });
  // Deliberately no backgroundColor: drawTile has none either, and a colour on
  // one side only would register as a difference across the whole tile.
  // `interactive` matches TileEditor exactly — it is the one build-path flag
  // that differs between this harness and the real editor.
  const ctx: BuildCtx = { dir: DIR, eff: c.eff, tileId: TILE_ID, W, H, interactive: true };
  const objs: fabric.Object[] = [await buildBackground(DIR, TILE_ID, c.eff, W, H)];
  for (const l of c.eff.layers) {
    if (l.hidden) continue;
    const obj = await buildLayerObject(l, ctx);
    if (obj) objs.push(obj);
  }
  fc.add(...objs);
  fc.renderAll();
  // With retina scaling the backing store is larger than the displayed size;
  // sample it the way the screen does — full backing store scaled back down —
  // so the comparison reflects what the user actually sees.
  let data: ImageData;
  if (el.width !== W || el.height !== H) {
    const shrunk = canvasEl(W, H);
    const sctx = shrunk.getContext("2d")!;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(el, 0, 0, el.width, el.height, 0, 0, W, H);
    data = sctx.getImageData(0, 0, W, H);
  } else {
    data = el.getContext("2d")!.getImageData(0, 0, W, H);
  }
  await fc.dispose();
  el.remove();
  return data;
}

/** Mean absolute channel difference plus the share of pixels that are off by
 *  more than the tolerance. The second number is the useful one: a small patch
 *  in badly the wrong place barely moves the mean but is exactly the kind of
 *  bug this catches. */
function compare(a: ImageData, b: ImageData, diffEl: HTMLCanvasElement) {
  const out = diffEl.getContext("2d")!.createImageData(a.width, a.height);
  let total = 0;
  let bad = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let worst = 0;
    for (let ch = 0; ch < 4; ch++) {
      const d = Math.abs(a.data[i + ch] - b.data[i + ch]);
      total += d;
      if (d > worst) worst = d;
    }
    const off = worst > CHANNEL_TOLERANCE;
    if (off) bad++;
    // Disagreements in red over a dimmed copy of the truth, so the difference
    // is legible in place rather than as an abstract silhouette.
    out.data[i] = off ? 255 : a.data[i] * 0.25;
    out.data[i + 1] = off ? 0 : a.data[i + 1] * 0.25;
    out.data[i + 2] = off ? 0 : a.data[i + 2] * 0.25;
    out.data[i + 3] = 255;
  }
  diffEl.getContext("2d")!.putImageData(out, 0, 0);
  const pixels = a.data.length / 4;
  return { meanAbs: total / a.data.length, badPct: (bad / pixels) * 100 };
}

function canvasEl(width: number, height: number) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

function show(canvas: HTMLCanvasElement, into: HTMLElement, label: string) {
  const fig = document.createElement("figure");
  const cap = document.createElement("figcaption");
  cap.textContent = label;
  canvas.style.width = "220px";
  fig.append(canvas, cap);
  into.append(fig);
}

async function run() {
  // Fabric measures text itself; comparing before webfonts settle would report
  // a difference that disappears a moment later.
  await document.fonts.ready;

  const root = document.getElementById("out")!;
  const results: Result[] = [];
  /* Kept around so a case can be re-measured from the console — where exactly
   * the two differ, sample colours, bounding boxes — without re-rendering. */
  const pixels: Record<string, { truth: ImageData; fabric: ImageData }> = {};

  for (const c of cases()) {
    const row = document.createElement("section");
    const head = document.createElement("h2");
    head.textContent = c.name;
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = c.note;
    const strip = document.createElement("div");
    strip.className = "strip";
    row.append(head, note, strip);
    root.append(row);

    try {
      const truth = await renderGroundTruth(c);
      const fabricData = await renderFabric(c);

      const truthEl = canvasEl(W, H);
      truthEl.getContext("2d")!.putImageData(truth, 0, 0);
      const fabricEl = canvasEl(W, H);
      fabricEl.getContext("2d")!.putImageData(fabricData, 0, 0);
      const diffEl = canvasEl(W, H);

      const { meanAbs, badPct } = compare(truth, fabricData, diffEl);
      results.push({ name: c.name, note: c.note, meanAbs, badPct });
      pixels[c.name] = { truth, fabric: fabricData };

      show(truthEl, strip, "render.ts (truth)");
      show(fabricEl, strip, "fabric");
      show(diffEl, strip, "diff");

      const score = document.createElement("p");
      score.className = badPct > 1 ? "score bad" : "score ok";
      score.textContent = `off pixels: ${badPct.toFixed(2)}%   mean abs: ${meanAbs.toFixed(2)}`;
      row.append(score);
    } catch (e) {
      results.push({ name: c.name, note: c.note, meanAbs: NaN, badPct: NaN, error: String(e) });
      const err = document.createElement("p");
      err.className = "score bad";
      err.textContent = `FAILED: ${e}`;
      row.append(err);
    }
  }

  const w = window as unknown as { __harness: Result[]; __pixels: typeof pixels };
  w.__harness = results;
  w.__pixels = pixels;
  document.getElementById("status")!.textContent =
    `done — ${results.length} cases, worst ${Math.max(...results.map((r) => r.badPct || 0)).toFixed(2)}% off`;
}

run();
