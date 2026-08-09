/* Real gestures, through Fabric's own transform pipeline.
 *
 * Why this exists: on 2026-08-09 five faults were found by hand and three were
 * in the same corner — masks — because none of them exist until a gesture
 * starts. A mask that measured correctly in every test covered four and a half
 * times too much the moment a layer was dragged. The suite could not see it:
 * nothing in it moves a mouse.
 *
 * Setting `left` and calling `renderAll()` is not the same thing. It skips
 * `_setupCurrentTransform`, the `object:moving` handlers, the snapping and the
 * clipPath work inside a live render — which is where the fault lived. These
 * helpers dispatch the events a hand would.
 *
 * They only bite in the mounted app, in a window that has a size. A bare
 * fabric.Canvas driven by exactly these events keeps its mask at the right
 * scale, with or without the fix, and so does the app mounted into a host of
 * zero width — the editor fits the sheet to its window, and no window means a
 * zoom of 0. Which of the two supplies the missing ingredient is not known;
 * what is known is that the fault appears with both and with neither
 * separately. See gestures.browser.test.ts, which is written that way.
 *
 * They do not test hit-testing. A masked object answers clicks by its pixels
 * until it is picked, and the app turns that off for the picked layer
 * (LayoutCanvas.scalingRules); a bare test canvas has no such wiring, so the
 * helpers pick the object first and take the flag off, the way the app does. */
import * as fabric from "fabric";

/** Where a scene point lands on screen, as a mouse event would report it. */
function clientAt(canvas: fabric.Canvas, x: number, y: number) {
  const rect = canvas.upperCanvasEl.getBoundingClientRect();
  const vt = canvas.viewportTransform;
  return { x: rect.left + x * vt[0] + vt[4], y: rect.top + y * vt[3] + vt[5] };
}

/** The same for a point Fabric has already put through the viewport — a
 *  handle's `oCoords` is in canvas space, not scene space, and running it
 *  through the transform a second time puts the grab where nothing is. */
function clientAtCanvas(canvas: fabric.Canvas, x: number, y: number) {
  const rect = canvas.upperCanvasEl.getBoundingClientRect();
  return { x: rect.left + x, y: rect.top + y };
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

/** One press, a few moves, one release — with a repaint between each, so a
 *  caller can look at the canvas while the gesture is still open. */
async function gesture(
  canvas: fabric.Canvas,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps: number,
  during?: () => void,
) {
  const el = canvas.upperCanvasEl;
  const at = (t: number) => ({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
  });
  const fire = (type: string, p: { x: number; y: number }, buttons: number) =>
    el.dispatchEvent(
      new MouseEvent(type, { clientX: p.x, clientY: p.y, bubbles: true, buttons, button: 0 }),
    );

  fire("mousedown", from, 1);
  await frame();
  for (let i = 1; i <= steps; i++) {
    fire("mousemove", at(i / steps), 1);
    /* Painted before it is looked at. Fabric schedules its render on its own
     * frame, so awaiting one here is a race the caller loses silently — it
     * reads the canvas as it was before the move and every assertion passes.
     * The app repaints too; this only makes when deterministic. */
    canvas.renderAll();
    await frame();
    during?.();
  }
  fire("mouseup", to, 0);
  canvas.renderAll();
  await frame();
}

/** One click at a point in scene coordinates — what a hand does to choose
 *  something. Separate from dragObject because a tool that picks on mouse:down
 *  has nothing to grab yet. */
export async function clickScene(canvas: fabric.Canvas, x: number, y: number) {
  const el = canvas.upperCanvasEl;
  const p = clientAt(canvas, x, y);
  for (const type of ["mousedown", "mouseup"] as const)
    el.dispatchEvent(
      new MouseEvent(type, {
        clientX: p.x,
        clientY: p.y,
        bubbles: true,
        buttons: type === "mousedown" ? 1 : 0,
        button: 0,
      }),
    );
  canvas.renderAll();
  await frame();
}

/** Picks the object and drags it by (dx, dy) in scene units.
 *
 *  `during` is called after every move with the gesture still open — the state
 *  the eye sees and the model has not been told about yet, which is where a
 *  preview that lies shows up. */
export async function dragObject(
  canvas: fabric.Canvas,
  obj: fabric.Object,
  dx: number,
  dy: number,
  during?: () => void,
  steps = 4,
) {
  obj.perPixelTargetFind = false;
  canvas.setActiveObject(obj);
  canvas.requestRenderAll();
  await frame();

  const c = obj.getCenterPoint();
  await gesture(canvas, clientAt(canvas, c.x, c.y), clientAt(canvas, c.x + dx, c.y + dy), steps, during);
}

/** Picks the object and drags one of its scale handles by (dx, dy).
 *
 *  `corner` is Fabric's own name for it — "br" for the bottom right, "mr" for
 *  the right edge. A handle the layer does not show cannot be grabbed, which is
 *  itself worth asserting. */
export async function scaleObject(
  canvas: fabric.Canvas,
  obj: fabric.Object,
  corner: string,
  dx: number,
  dy: number,
  during?: () => void,
  steps = 4,
) {
  obj.perPixelTargetFind = false;
  canvas.setActiveObject(obj);
  canvas.requestRenderAll();
  await frame();

  obj.setCoords();
  const point = obj.oCoords?.[corner];
  if (!point) throw new Error(`no "${corner}" handle on this object`);
  await gesture(
    canvas,
    clientAtCanvas(canvas, point.x, point.y),
    clientAtCanvas(canvas, point.x + dx, point.y + dy),
    steps,
    during,
  );
}

/** How many pixels on the canvas are this colour, give or take. The measure
 *  these tests are written in: a shape is what it covers. */
export function countColour(
  canvas: fabric.Canvas,
  [r, g, b]: [number, number, number],
  tolerance = 60,
) {
  const el = canvas.lowerCanvasEl;
  const data = el.getContext("2d", { willReadFrequently: true })!.getImageData(
    0,
    0,
    el.width,
    el.height,
  ).data;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (
      Math.abs(data[i] - r) <= tolerance &&
      Math.abs(data[i + 1] - g) <= tolerance &&
      Math.abs(data[i + 2] - b) <= tolerance &&
      data[i + 3] > 128
    )
      n++;
  }
  return n;
}
