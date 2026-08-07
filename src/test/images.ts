/** Synthetic pixel sources for the golden tests, adapted from the old render
 *  harness's mockProject.ts.
 *
 *  Two properties matter and both are load-bearing:
 *  - Deterministic per name, so a golden image is reproducible across runs.
 *  - The ImageBitmap and the data URL for a given name come off the *same*
 *    canvas, so a difference between the two routes can never masquerade as a
 *    real rendering difference. */
import type { SceneDeps } from "../lib/scene";

const TILE_W = 624;
const TILE_H = 804;

function hueFor(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** Strongly asymmetric on purpose: an off-centre disc plus a corner wedge. A
 *  symmetric test picture scores a mirrored or 180°-rotated result as perfect,
 *  which is exactly the class of bug these tests exist to catch. */
function paint(name: string, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const hue = hueFor(name);

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

  return c;
}

/** A flat, fully opaque square in one colour. Used where a test needs to ask
 *  "did this exact colour land on this exact pixel" without the answer being
 *  muddied by a gradient or an edge. */
function block(colour: string, size = 200): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, size, size);
  return c;
}

/** A filled disc on transparency. What a PNG logo looks like to a mask: the
 *  cut has to follow the pixels that are actually there, not the box they
 *  arrived in. */
function disc(colour: string, size = 200): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.3, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

const canvases = new Map<string, HTMLCanvasElement>();

const canvasFor = (key: string, make: () => HTMLCanvasElement) => {
  let c = canvases.get(key);
  if (!c) {
    c = make();
    canvases.set(key, c);
  }
  return c;
};

/** "block:#rrggbb" yields a flat colour block, "disc:#rrggbb" a filled circle
 *  on transparency, anything else the asymmetric test picture. */
const assetCanvas = (name: string) =>
  canvasFor(`asset:${name}`, () =>
    name.startsWith("block:")
      ? block(name.slice(6))
      : name.startsWith("disc:")
        ? disc(name.slice(5))
        : paint(name, 400, 300),
  );

export const testDeps: SceneDeps = {
  original: (id) => createImageBitmap(canvasFor(`tile:${id}`, () => paint(id, TILE_W, TILE_H))),
  asset: async (name) => assetCanvas(name).toDataURL("image/png"),
};
