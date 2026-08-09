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
import type { Canvas, FabricObject } from "fabric";
import { mount, unmount } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";

import App from "./App.svelte";
import {
  addLayoutImage,
  addLayoutShape,
  app,
  assignTileLayout,
  closeLayoutDoc,
  newLayoutDoc,
  openLayout,
  setLayerField,
  visibleIds,
} from "./lib/editor.svelte";
import { emptyManifest } from "./lib/model";
import { queuePick, resetMockFiles, stashPickedFile } from "./lib/platform";
import { cellAt } from "./lib/scene";
import { TILE_H, TILE_W } from "./lib/bmp";
import { clickScene, countColour, dragObject, scaleObject } from "./test/gestures";

const GREEN: [number, number, number] = [0, 255, 0];

/** A picture to put on a tile. */
async function magentaSquare(name: string) {
  const c = new OffscreenCanvas(200, 200);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#ff00ff";
  ctx.fillRect(0, 0, 200, 200);
  const blob = await c.convertToBlob({ type: "image/png" });
  return stashPickedFile(`${name}.png`, new Uint8Array(await blob.arrayBuffer()));
}

async function until(what: () => boolean, ms = 8000, what_for = "the app") {
  const deadline = Date.now() + ms;
  while (!what()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what_for}`);
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
  return (window as unknown as { tesseraLayout: Canvas }).tesseraLayout;
}

/** The same, but standing on a wall: the overview has no canvas, and closing a
 *  Layout from there goes back to the overview rather than to a project. */
async function wall() {
  app.manifest = emptyManifest();
  app.dir = "";
  app.selectedTiles = [];
  app.openLayoutId = "";
  app.layoutSelection = [];

  host = document.createElement("div");
  host.id = "app";
  host.style.cssText = "width:1400px;height:900px;position:fixed;left:0;top:0";
  document.body.append(host);
  ui = mount(App, { target: host });
  await until(() => !!app.dir && app.folderIds.length > 0 && !app.busy);

  const card = [...document.querySelectorAll("button")].find((b) =>
    b.textContent!.includes("Unsorted"),
  ) as HTMLButtonElement | undefined;
  if (!card) throw new Error("no way into Unsorted from the overview");
  card.click();
  await until(() => !!(window as { tesseraWall?: unknown }).tesseraWall, 8000, "the wall canvas");
  return (window as unknown as { tesseraWall: Canvas }).tesseraWall;
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
  await until(() => canvas.getObjects().some((o: FabricObject) => !!o.clipPath?.absolutePositioned));
  const obj = canvas.getObjects().find((o: FabricObject) => !!o.clipPath?.absolutePositioned)!;
  return { canvas, obj };
}

describe("framing a picture on the wall", () => {
  beforeEach(() => resetMockFiles());

  it("writes what was dragged onto the tile, not onto the layer", async () => {
    /* The tile owns which picture and which part of it; the Layout owns where
     * the frame is and how big. So a drag with the framing tool has to land in
     * the tile's own map and leave the shared layer exactly as it was —
     * otherwise framing one portrait would move all forty-four. */
    try {
      await wall();

      queuePick(await magentaSquare("bild"));
      await newLayoutDoc("Bild");
      await addLayoutImage();
      const layout = openLayout()!;
      const pic = layout.layers[0];
      if (pic.kind !== "image") throw new Error("addLayoutImage made something else");
      const before = { x: pic.x, y: pic.y, scale: pic.scale };
      await setLayerField(pic.id, "perTile", true);

      const tile = app.folderIds[0];
      await assignTileLayout(tile, layout.id);
      await closeLayoutDoc();
      /* After the round trip, not before it: opening a Layout takes the wall's
         canvas down and coming back builds a new one, so a reference taken
         earlier points at a disposed canvas with nothing on it. */
      await until(
        () => ((window as { tesseraWall?: Canvas }).tesseraWall?.getObjects().length ?? 0) > 0,
        8000,
        "the wall to come back with its tiles",
      );
      const wallCanvas = (window as unknown as { tesseraWall: Canvas }).tesseraWall;

      // By its title: the tool is an icon in the rail, so there is no text to
      // match, and the title is what a hand hovers to find it too.
      const button = [...document.querySelectorAll("button")].find((b) =>
        b.title.startsWith("Frame a tile's picture"),
      ) as HTMLButtonElement;
      button.click();
      await until(() => button.getAttribute("aria-pressed") === "true", 8000, "the framing tool to switch on");

      // Click the tile the picture is on, then drag what the tool framed.
      const cell = cellAt(visibleIds().indexOf(tile));
      await clickScene(wallCanvas, cell.x + TILE_W / 2, cell.y + TILE_H / 2);
      await until(() => !!wallCanvas.getActiveObject(), 8000, "the stand-in to appear");
      await dragObject(wallCanvas, wallCanvas.getActiveObject()!, 60, 40);
      await until(() => !!app.manifest.tiles[tile].frame?.[pic.id], 5000, "the frame to be written");

      /* The frame is still standing after the release. A rebuild follows the
       * write immediately, and it used to take the frame with it: it blinked
       * out at the end of every drag and came back a moment later, which on a
       * few nudges in a row is all one sees. */
      expect(wallCanvas.getObjects().some((o: FabricObject) => (o as { framing?: boolean }).framing)).toBe(true);
      expect(wallCanvas.getActiveObject()).toBeTruthy();

      const f = app.manifest.tiles[tile].frame![pic.id];
      expect(Math.abs(f.x)).toBeGreaterThan(0);
      expect(Math.abs(f.y)).toBeGreaterThan(0);

      // The shared layer is where it was: every other tile keeps its framing.
      const shared = app.manifest.layouts.find((l) => l.id === layout.id)!.layers[0];
      expect(shared.x).toBeCloseTo(before.x, 6);
      expect(shared.y).toBeCloseTo(before.y, 6);
      if (shared.kind !== "image") throw new Error("the layer stopped being a picture");
      expect(shared.scale).toBeCloseTo(before.scale, 6);
    } finally {
      await teardown();
    }
  });
});

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
