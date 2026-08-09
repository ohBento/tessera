/* The faults that only exist while a hand is on the mouse.
 *
 * Every one of these was found by the author dragging something and filming
 * it, after four hundred tests had gone green. They share a shape: the canvas
 * is right until a gesture starts, and something in the live path changes it.
 *
 * Mounted, and with a viewport that has a size. Both matter, and finding out
 * which cost an evening: a bare fabric.Canvas driven by the same events does
 * not reproduce any of this, and neither does the app mounted into a host of
 * zero width — the editor fits the sheet to its window, so no window means a
 * zoom of 0 and a render path that never runs. The mask fault appears at the
 * first mousemove and only here. */
import { mount, unmount } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";

import App from "./App.svelte";
import {
  addLayoutShape,
  app,
  newLayoutDoc,
  openLayout,
  setLayerField,
} from "./lib/editor.svelte";
import { emptyManifest } from "./lib/model";
import { resetMockFiles } from "./lib/platform";
import { countColour, dragObject, scaleObject } from "./test/gestures";

const GREEN: [number, number, number] = [0, 255, 0];

async function until(what: () => boolean, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!what()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the app");
    await new Promise((r) => setTimeout(r, 25));
  }
}

let host: HTMLDivElement;
let ui: Record<string, unknown> | undefined;

/** The app in a window big enough to draw in. */
async function editor() {
  app.manifest = emptyManifest();
  app.dir = "";
  app.selectedTiles = [];
  app.selected = "";
  app.openLayoutId = "";
  app.layoutSelection = [];
  app.error = "";

  host = document.createElement("div");
  host.id = "app";
  // A real window, or LayoutCanvas fits the sheet into nothing and the whole
  // live render path is skipped — see the note at the top.
  host.style.cssText = "width:1400px;height:900px;position:fixed;left:0;top:0";
  document.body.append(host);
  ui = mount(App, { target: host });
  await until(() => !!app.dir && app.folderIds.length > 0 && !app.busy);

  await newLayoutDoc("Gesten");
  await until(() => !!(window as { tesseraLayout?: unknown }).tesseraLayout);
  return (window as unknown as { tesseraLayout: import("fabric").Canvas }).tesseraLayout;
}

async function teardown() {
  if (ui) await unmount(ui);
  ui = undefined;
  host?.remove();
}

/** A green block cut to a class icon — the pair the icons exist for. */
async function blockCutToIcon() {
  const canvas = await editor();
  await addLayoutShape("icon", "Placeholder");
  const icon = openLayout()!.layers[0];
  await addLayoutShape("rect");
  const block = openLayout()!.layers.find((l) => l.id !== icon.id)!;
  await setLayerField(block.id, "fill", "#00ff00");
  await setLayerField(block.id, "maskId", icon.id);
  await until(() => canvas.getObjects().some((o) => !!o.clipPath?.absolutePositioned));
  const obj = canvas.getObjects().find((o) => !!o.clipPath?.absolutePositioned)!;
  return { canvas, obj };
}

describe("what a gesture does to a mask", () => {
  beforeEach(() => resetMockFiles());

  it("does not let the mask grow while the layer is dragged", async () => {
    /* The one that cost an afternoon. The stencil sat at scale 0.22 at rest
     * and at 1 from the first mousemove, so the mask covered four and a half
     * times what it should and the block came out very nearly whole —
     * reported as "the icon is zoomed".
     *
     * The cut can only shrink while dragging: the block slides out from under
     * a mask that stays where the cutter is. So anything above the resting
     * count is the fault. */
    try {
      const { canvas, obj } = await blockCutToIcon();
      const atRest = countColour(canvas, GREEN);
      expect(atRest).toBeGreaterThan(0);

      let worst = 0;
      await dragObject(canvas, obj, 40, 20, () => {
        worst = Math.max(worst, countColour(canvas, GREEN));
      });
      /* A per-cent of slack, and no more. The fault this pins is a fivefold
       * jump; what the slack absorbs is the edge of an antialiased shape
       * moving under a stencil, which was 0.7% of the count when measured. */
      expect(worst).toBeLessThanOrEqual(Math.round(atRest * 1.02));
    } finally {
      await teardown();
    }
  });

  it("keeps the cut after the layer has been let go", async () => {
    /* The same fault one step later: it survived the release, so the wall
     * stayed wrong until something rebuilt the scene. A class icon is line
     * art — it cannot fill half of the block it cuts. */
    try {
      const { canvas, obj } = await blockCutToIcon();
      /* Measured against the same canvas before the gesture, not against the
       * layer's box: the count is in device pixels — retina scaling and the
       * editor's own zoom both multiply it — and the box is in tile units. The
       * two agreed on this machine at a device ratio of 1 and would have
       * quadrupled apart on a HiDPI screen, failing for a reason that has
       * nothing to do with masks. */
      const atRest = countColour(canvas, GREEN);
      await dragObject(canvas, obj, 12, 8);
      const shown = countColour(canvas, GREEN);

      // Still there, and still a cut shape rather than the block behind it.
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThanOrEqual(Math.round(atRest * 1.02));
    } finally {
      await teardown();
    }
  });

  it("keeps a class icon the size its handle was let go at", async () => {
    /* An icon's artwork is fitted to its box rather than stretched into it, so
     * a side handle grew it for as long as the mouse was down and the rebuild
     * put it back. Corner handles only, for that reason — and a handle the
     * layer does not show cannot be grabbed, which is the same rule seen from
     * the other side.
     *
     * This one pins `freeScale`, not the mask fix the two above pin. Worth
     * saying: an earlier commit message claimed all three fail on the mask
     * bug, and only two of them do. */
    try {
      const canvas = await editor();
      await addLayoutShape("icon", "Placeholder");
      const icon = openLayout()!.layers[0];
      await setLayerField(icon.id, "fill", "#00ff00");
      await until(() => canvas.getObjects().some((o) => (o as { layerId?: string }).layerId === icon.id));
      const obj = canvas.getObjects().find((o) => (o as { layerId?: string }).layerId === icon.id)!;

      expect(obj.isControlVisible("mr")).toBe(false);
      const before = countColour(canvas, GREEN);
      await scaleObject(canvas, obj, "br", 60, 60);
      await until(() => countColour(canvas, GREEN) !== before, 3000).catch(() => {});
      expect(countColour(canvas, GREEN)).toBeGreaterThan(before);
    } finally {
      await teardown();
    }
  });
});
