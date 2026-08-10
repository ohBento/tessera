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
  addLayoutText,
  app,
  assignTileLayout,
  closeLayoutDoc,
  newLayoutDoc,
  openLayout,
  setLayerField,
  saveLayout,
  setTileAsset,
  visibleIds,
} from "./lib/editor.svelte";
import { emptyManifest, findLayer, type TextLayer } from "./lib/model";
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

/** A button by its tooltip. The rail and the tile rows are icons, so there is
 *  no text to match on — and the title is what a hand hovers to find them too. */
const byTitle = (title: string) =>
  [...document.querySelectorAll("button")].find((b) => b.title === title) as
    | HTMLButtonElement
    | undefined;

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

      /* The way a hand gets there: click the tile, which opens its row, then
       * press the place button beside the picture in that row. The tool takes
       * what to place from the list rather than from a click on the canvas —
       * a wall is layers all the way across, and clicking to choose one would
       * take the tile-selection drag with it. */
      const cell = cellAt(visibleIds().indexOf(tile));
      await clickScene(wallCanvas, cell.x + TILE_W / 2, cell.y + TILE_H / 2);
      await until(() => !!byTitle("Place this on this tile"), 8000, "the tile's own row to open");
      byTitle("Place this on this tile")!.click();
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

  it("places a caption too, and offers it no handle that resizes it", async () => {
    /* The reason the tool grew past pictures: a caption clear of the chin on
     * forty-three portraits lands on it on the forty-fourth, and the tile is
     * the only place that can say so. What it may not do is change the type
     * size — one caption larger than the rest reads as a mistake rather than
     * as a choice — so the corner and side handles are not offered. */
    try {
      await wall();

      await newLayoutDoc("Schrift");
      await addLayoutText();
      const layout = openLayout()!;
      const caption = layout.layers[0];
      if (caption.kind !== "text") throw new Error("addLayoutText made something else");
      const before = { x: caption.x, y: caption.y, size: caption.size };
      /* Live, or it bakes into the stamp and the tile has no copy of its own to
         place — only `perTile` layers are copied onto the tiles (bakeable). */
      await setLayerField(caption.id, "perTile", true);

      const tile = app.folderIds[0];
      await assignTileLayout(tile, layout.id);
      await closeLayoutDoc();
      await until(
        () => ((window as { tesseraWall?: Canvas }).tesseraWall?.getObjects().length ?? 0) > 0,
        8000,
        "the wall to come back with its tiles",
      );
      const wallCanvas = (window as unknown as { tesseraWall: Canvas }).tesseraWall;

      const cell = cellAt(visibleIds().indexOf(tile));
      await clickScene(wallCanvas, cell.x + TILE_W / 2, cell.y + TILE_H / 2);
      await until(() => !!byTitle("Place this on this tile"), 8000, "the tile's own row to open");
      byTitle("Place this on this tile")!.click();
      await until(() => !!wallCanvas.getActiveObject(), 8000, "the stand-in to appear");

      const stand = wallCanvas.getActiveObject()!;
      // No zoom on a caption: corners and sides both gone, the turn handle stays.
      expect(stand.isControlVisible("br")).toBe(false);
      expect(stand.isControlVisible("mr")).toBe(false);
      expect(stand.isControlVisible("mtr")).toBe(true);

      await dragObject(wallCanvas, stand, 50, 30);
      /* The caption's own copy on the tile, not the Layout's: every other tile
       * keeps the caption where the design put it. */
      const written = app.manifest.tiles[tile].layers.find((l) => l.kind === "text")!;
      await until(() => !!app.manifest.tiles[tile].frame?.[written.id], 5000, "the placement to be written");

      const f = app.manifest.tiles[tile].frame![written.id];
      expect(Math.abs(f.x)).toBeGreaterThan(0);
      expect(Math.abs(f.y)).toBeGreaterThan(0);
      // Dragged, not resized — whatever the stand-in did, no zoom was stored.
      expect(f.z).toBeCloseTo(1, 6);

      const shared = app.manifest.layouts.find((l) => l.id === layout.id)!.layers[0];
      if (shared.kind !== "text") throw new Error("the layer stopped being a caption");
      expect(shared.x).toBeCloseTo(before.x, 6);
      expect(shared.y).toBeCloseTo(before.y, 6);
      expect(shared.size).toBeCloseTo(before.size, 6);
    } finally {
      await teardown();
    }
  });

  it("carries the choice to the next tile that has the same layer", async () => {
    /* What makes forty-four tiles bearable. A live copy keeps the id of the
     * layer it came from, so the same choice means something on every tile the
     * Layout is stamped on: click the next portrait and the frame is already on
     * its caption.
     *
     * It hung on one line. Fabric clears its selection whenever a press lands
     * on bare canvas, and the wall answered that by dropping the chosen layer —
     * so the frame died on the way to the tile it was being carried to. */
    try {
      await wall();

      await newLayoutDoc("Wanderung");
      await addLayoutText();
      const layout = openLayout()!;
      const caption = layout.layers[0];
      await setLayerField(caption.id, "perTile", true);

      const [first, second] = app.folderIds;
      await assignTileLayout(first, layout.id);
      await assignTileLayout(second, layout.id);
      await closeLayoutDoc();
      await until(
        () => ((window as { tesseraWall?: Canvas }).tesseraWall?.getObjects().length ?? 0) > 0,
        8000,
        "the wall to come back with its tiles",
      );
      const wallCanvas = (window as unknown as { tesseraWall: Canvas }).tesseraWall;

      const at = (id: string) => cellAt(visibleIds().indexOf(id));
      await clickScene(wallCanvas, at(first).x + TILE_W / 2, at(first).y + TILE_H / 2);
      await until(() => !!byTitle("Place this on this tile"), 8000, "the tile's own row to open");
      byTitle("Place this on this tile")!.click();
      await until(() => !!wallCanvas.getActiveObject(), 8000, "the stand-in to appear");
      const onFirst = wallCanvas.getActiveObject()!.left ?? 0;

      // Low in the cell, clear of the frame: this has to be a press on the wall.
      await clickScene(wallCanvas, at(second).x + TILE_W / 2, at(second).y + TILE_H * 0.9);
      await until(
        () => (wallCanvas.getActiveObject()?.left ?? onFirst) !== onFirst,
        5000,
        "the frame to move to the second tile",
      );
      const moved = wallCanvas.getActiveObject()!;
      expect((moved as { framing?: boolean }).framing).toBe(true);
      // One cell further along, not merely somewhere else.
      expect((moved.left ?? 0) - onFirst).toBeCloseTo(at(second).x - at(first).x, 3);
    } finally {
      await teardown();
    }
  });

  it("gives a live shape a row of its own, and lets one axis go", async () => {
    /* A shape carries no per-tile content, so it had no row in the tile list —
     * and with no row there was no way into the tool. For the badge, that meant
     * the icon cutting the block could be placed and the block itself could
     * not. It owns a colour now, and the row that carries the colour carries
     * the way in.
     *
     * And a side handle does what it shows: a bar drawn longer on one portrait
     * is a decision, unlike a face stretched on one, so `freeScale` decides who
     * gets the handles and `zh` carries the result. */
    try {
      await wall();

      await newLayoutDoc("Balken");
      await addLayoutShape("rect");
      const layout = openLayout()!;
      const bar = layout.layers[0];
      await setLayerField(bar.id, "perTile", true);

      const tile = app.folderIds[0];
      await assignTileLayout(tile, layout.id);
      await closeLayoutDoc();
      await until(
        () => ((window as { tesseraWall?: Canvas }).tesseraWall?.getObjects().length ?? 0) > 0,
        8000,
        "the wall to come back with its tiles",
      );
      const wallCanvas = (window as unknown as { tesseraWall: Canvas }).tesseraWall;

      const cell = cellAt(visibleIds().indexOf(tile));
      await clickScene(wallCanvas, cell.x + TILE_W / 2, cell.y + TILE_H / 2);
      await until(() => !!byTitle("Place this on this tile"), 8000, "the shape's own row to open");
      byTitle("Place this on this tile")!.click();
      await until(() => !!wallCanvas.getActiveObject(), 8000, "the stand-in to appear");

      const stand = wallCanvas.getActiveObject()!;
      // Sides as well as corners — the handle that stretches is offered.
      expect(stand.isControlVisible("mr")).toBe(true);
      await scaleObject(wallCanvas, stand, "mr", 90, 0);
      await until(() => !!app.manifest.tiles[tile].frame?.[bar.id], 5000, "the placement to be written");

      const f = app.manifest.tiles[tile].frame![bar.id];
      expect(f.z).toBeGreaterThan(1.1);
      // Wider, not taller: the axis nobody touched stayed where it was.
      expect(f.zh).toBeCloseTo(1, 2);
    } finally {
      await teardown();
    }
  });

  it("keeps the ghost on top after the first drag", async () => {
    /* The faint whole picture is the only thing to aim by when a mask hides
     * most of what is being dragged. It showed for the first drag and never
     * again: writing a placement rebuilds the wall, `buildGrid` adds its
     * objects to a canvas the ghost survived on, and Fabric adds to the top —
     * so from the second drag on the ghost lay under the tile's own artwork.
     * The frame still looked right, because Fabric draws the active object's
     * controls on the upper canvas whatever is buried below. */
    try {
      await wall();

      queuePick(await magentaSquare("bild"));
      await newLayoutDoc("Maskiert");
      await addLayoutShape("icon", "Placeholder");
      const icon = openLayout()!.layers[0];
      await addLayoutImage();
      const pic = openLayout()!.layers.find((l) => l.id !== icon.id)!;
      await setLayerField(pic.id, "perTile", true);
      await setLayerField(icon.id, "perTile", true);
      await setLayerField(pic.id, "maskId", icon.id);

      const tile = app.folderIds[0];
      await assignTileLayout(tile, openLayout()!.id);
      await closeLayoutDoc();
      await until(
        () => ((window as { tesseraWall?: Canvas }).tesseraWall?.getObjects().length ?? 0) > 0,
        8000,
        "the wall to come back with its tiles",
      );
      const wallCanvas = (window as unknown as { tesseraWall: Canvas }).tesseraWall;

      const cell = cellAt(visibleIds().indexOf(tile));
      await clickScene(wallCanvas, cell.x + TILE_W / 2, cell.y + TILE_H / 2);
      await until(() => !!byTitle("Place this on this tile"), 8000, "the tile's own row to open");
      byTitle("Place this on this tile")!.click();
      await until(() => !!wallCanvas.getActiveObject(), 8000, "the stand-in to appear");

      await dragObject(wallCanvas, wallCanvas.getActiveObject()!, 40, 25);
      await until(() => !!app.manifest.tiles[tile].frame?.[pic.id], 5000, "the placement to be written");
      /* The rebuild the write sets off is asynchronous, and it is the rebuild
         that does the damage — asserting before it lands measures the canvas
         the drag left behind and passes on a wall that is about to be wrong. */
      await until(() => !app.busy, 5000, "the wall to settle");
      await new Promise((r) => setTimeout(r, 400));

      /* Above everything the rebuild put back — which is what "visible" means
         on a canvas. The stand-in is the last object; the ghost is under it and
         over the wall. */
      const objects = wallCanvas.getObjects();
      const stand = objects.findIndex((o: FabricObject) => (o as { framing?: boolean }).framing);
      const ghost = objects.findIndex(
        (o: FabricObject) => (o as { keep?: boolean }).keep && !(o as { framing?: boolean }).framing,
      );
      expect(stand).toBe(objects.length - 1);
      expect(ghost).toBe(objects.length - 2);
    } finally {
      await teardown();
    }
  });

  it("takes the frame away when the tile it moved to shows nothing there", async () => {
    /* "Show no picture on this tile" is a real answer, so the layer is still on
     * the tile and still listed — there is simply nothing to stand on. The
     * frame used to survive that: the tool bailed before clearing its own
     * furniture, so the violet box stayed on the previous portrait while the
     * selection had moved on, and the next drag wrote onto a tile nobody was
     * pointing at. */
    try {
      await wall();

      queuePick(await magentaSquare("bild"));
      await newLayoutDoc("Leer");
      await addLayoutImage();
      const layout = openLayout()!;
      const pic = layout.layers[0];
      await setLayerField(pic.id, "perTile", true);

      const [first, second] = app.folderIds;
      await assignTileLayout(first, layout.id);
      await assignTileLayout(second, layout.id);
      // The second portrait is told to show none of it.
      await setTileAsset(second, pic.id, "");
      await closeLayoutDoc();
      await until(
        () => ((window as { tesseraWall?: Canvas }).tesseraWall?.getObjects().length ?? 0) > 0,
        8000,
        "the wall to come back with its tiles",
      );
      const wallCanvas = (window as unknown as { tesseraWall: Canvas }).tesseraWall;
      const framesOn = () =>
        wallCanvas.getObjects().filter((o: FabricObject) => (o as { framing?: boolean }).framing);

      const at = (id: string) => cellAt(visibleIds().indexOf(id));
      await clickScene(wallCanvas, at(first).x + TILE_W / 2, at(first).y + TILE_H / 2);
      await until(() => !!byTitle("Place this on this tile"), 8000, "the tile's own row to open");
      byTitle("Place this on this tile")!.click();
      await until(() => framesOn().length === 1, 8000, "the stand-in to appear");

      await clickScene(wallCanvas, at(second).x + TILE_W / 2, at(second).y + TILE_H * 0.9);
      await until(() => app.selectedTiles[0] === second, 5000, "the second tile to be picked");
      await until(() => framesOn().length === 0, 5000, "the frame to be taken down");
      // And nothing was written behind our back onto the tile we left.
      expect(app.manifest.tiles[first].frame?.[pic.id]).toBeUndefined();
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

  it("keeps a dragged caption where it was let go when the stamps are updated", async () => {
    /* From a screen recording: a caption with a fixed width, used as a mask, on
     * a Layout stamped across the wall. Dragging it moved it — the X field went
     * 69 to 92 — and "Update stamps" put it back to 69.
     *
     * Driven through the canvas rather than through the model, because a plain
     * move takes a path of its own: it skips the version bump, so nothing
     * rebuilds until something else asks for one, and the something else here
     * is the button that is supposed to keep it. */
    try {
      const canvas = await editor();
      await addLayoutText();
      const caption = openLayout()!.layers[0];
      await setLayerField(caption.id, "perTile", true);
      await setLayerField(caption.id, "text", "TEXT");
      await setLayerField(caption.id, "w", 0.07);
      await setLayerField(caption.id, "h", 0.9);
      await addLayoutShape("rect");
      const block = openLayout()!.layers.find((l) => l.id !== caption.id)!;
      await setLayerField(block.id, "perTile", true);
      await setLayerField(block.id, "fill", "#00ff00");
      await setLayerField(block.id, "maskId", caption.id);
      const layoutId = openLayout()!.id;
      await until(() =>
        canvas.getObjects().some((o: FabricObject) => !!o.clipPath?.absolutePositioned),
      );

      const stencil = canvas
        .getObjects()
        .find((o) => (o as { layerId?: string }).layerId === caption.id)!;
      const before = findLayer(openLayout()!.layers, caption.id)!.x;
      await dragObject(canvas, stencil, 30, 0);
      await until(
        () => findLayer(openLayout()!.layers, caption.id)!.x !== before,
        5000,
        "the drag to be written",
      );
      const moved = findLayer(openLayout()!.layers, caption.id)!.x;

      // Stamped somewhere, or there is nothing for the button to update.
      await assignTileLayout(app.folderIds[0], layoutId);
      await saveLayout(layoutId);
      expect(findLayer(openLayout()!.layers, caption.id)!.x).toBeCloseTo(moved, 6);
    } finally {
      await teardown();
    }
  });

  it("does not shift a caption's hole the moment it is touched", async () => {
    /* A caption with a width of its own, used as a mask. Nudging it one pixel
     * must move the hole one pixel — and the hole is a separate object with
     * `absolutePositioned`, kept in register by syncMasks while the gesture is
     * open. Any jump beyond the nudge is that bookkeeping disagreeing with
     * where the renderer puts the same stencil, which is what a rebuild
     * afterwards silently corrects: the model was right all along and only the
     * canvas was wrong, so "it comes back when I press Update". */
    try {
      const canvas = await editor();
      await addLayoutText();
      /* The reported Layout, to the number: Impact at 81px in a 42x714 box,
         punched out of a 138x804 strip of paint with rounded corners. */
      const caption = openLayout()!.layers[0];
      await setLayerField(caption.id, "text", "Descr");
      await setLayerField(caption.id, "font", "Impact");
      await setLayerField(caption.id, "size", 81 / TILE_W);
      await setLayerField(caption.id, "w", 42 / TILE_W);
      await setLayerField(caption.id, "h", 714 / TILE_H);
      await addLayoutShape("rect");
      const block = openLayout()!.layers.find((l) => l.id !== caption.id)!;
      await setLayerField(block.id, "fill", "#00ff00");
      await setLayerField(block.id, "w", 138 / TILE_W);
      await setLayerField(block.id, "h", 1);
      await setLayerField(block.id, "cornerRadius", 0.36);
      await setLayerField(block.id, "maskId", caption.id);
      // Inverted: the letters are punched out of the paint rather than filled
      // with it, which is the arrangement the report came from.
      await setLayerField(block.id, "maskInvert", true);
      await until(() =>
        canvas.getObjects().some((o: FabricObject) => !!o.clipPath?.absolutePositioned),
      );

      const cut = canvas.getObjects().find((o: FabricObject) => !!o.clipPath?.absolutePositioned)!;
      const stencil = canvas
        .getObjects()
        .find((o) => (o as { layerId?: string }).layerId === caption.id)!;
      const read = () => {
        const c = cut.clipPath!;
        return {
          left: Math.round(c.left ?? 0),
          top: Math.round(c.top ?? 0),
          sx: Number((c.scaleX ?? 1).toFixed(3)),
          sy: Number((c.scaleY ?? 1).toFixed(3)),
          w: Math.round(c.width ?? 0),
        };
      };
      const before = read();
      await dragObject(canvas, stencil, 1, 0);
      const after = read();
      /* The hole is wherever the stencil is, to the pixel. Measured against the
         stencil rather than against the nudge, and that distinction is the
         finding: a one-pixel nudge of this caption lands it six pixels to the
         *left*, and the hole goes with it. So the mask bookkeeping is sound and
         something in the drag is not — which is the fault the recording shows,
         one layer further down than it looked. */
      expect(after.left).toBeCloseTo(stencil.getCenterPoint().x, -0.5);
      expect(after.top).toBeCloseTo(stencil.getCenterPoint().y, -0.5);
      /* And at the size it was. The same bookkeeping copies the stencil's scale
         onto the hole, and the stencil on canvas is not built the way the hole
         is — a class icon's stencil once sat at 0.22 at rest and was handed a 1
         on the first mousemove, which made its mask four and a half times too
         big. Whatever the equivalent is for a caption belongs here. */
      expect({ sx: after.sx, sy: after.sy }).toEqual({ sx: before.sx, sy: before.sy });

      /* And the paint keeps its shape through a drag the length of the reported
         one. Inverted, so this counts the strip minus the letters: it grows if
         the holes shrink and shrinks if they spread. Either way it must not
         move much — 23px sideways inside a strip 138 wide changes what the
         letters sit over, not how much of the strip is left. */
      const paint = () => countColour(canvas, GREEN);
      const still = paint();
      let widest = still;
      await dragObject(canvas, stencil, 22, 0, () => {
        widest = Math.max(widest, paint());
      });
      expect(widest).toBeLessThan(Math.round(still * 1.1));
      expect(paint()).toBeLessThan(Math.round(still * 1.1));
    } finally {
      await teardown();
    }
  });

  it("keeps a caption's cut whole while the caption is dragged", async () => {
    /* Words as a stencil. Dragging the caption drags the hole with it — that is
     * what syncMasks is for — and the cut must stay the same size on the way:
     * it may land somewhere else, but letters do not lose their strokes in
     * transit. Reported as "it partly disappears, and only comes back on
     * Update". */
    try {
      const canvas = await editor();
      await addLayoutText();
      const words = openLayout()!.layers[0];
      /* Centred and small, and put back in the middle after the wording
         changes it. A left-aligned caption holds its left edge while its box
         grows, so setting the text alone walks the centre right — correct, and
         it swamped the first version of this test. */
      await setLayerField(words.id, "align", "center");
      await setLayerField(words.id, "text", "MM");
      await setLayerField(words.id, "size", 0.12);
      await setLayerField(words.id, "x", 0.5);
      await setLayerField(words.id, "y", 0.5);
      await addLayoutShape("rect");
      const block = openLayout()!.layers.find((l) => l.id !== words.id)!;
      await setLayerField(block.id, "fill", "#00ff00");
      /* The block fills the tile, so nothing the drag does can carry a letter
         off its edge — a smaller cut then means the stencil went wrong, not
         that the words left the paint. */
      await setLayerField(block.id, "w", 1);
      await setLayerField(block.id, "h", 1);
      await setLayerField(block.id, "maskId", words.id);
      await until(() =>
        canvas.getObjects().some((o: FabricObject) => !!o.clipPath?.absolutePositioned),
      );
      const stencil = canvas
        .getObjects()
        .find((o) => (o as { layerId?: string }).layerId === words.id)!;

      const atRest = countColour(canvas, GREEN);
      expect(atRest).toBeGreaterThan(0);
      const before = stencil.getCenterPoint();
      const originBefore = { x: stencil.originX, y: stencil.originY, w: stencil.width };
      let worst = atRest;
      await dragObject(canvas, stencil, 24, 16, () => {
        worst = Math.min(worst, countColour(canvas, GREEN));
      });
      /* The letters keep their weight all the way. A tenth of slack for the
         antialiased edges moving over different background, and no more —
         what this pins is a cut that thins out or vanishes mid-drag. */
      /* A tenth of slack for antialiased edges over different background, and
         no more: what this pins is a cut that thins out or vanishes mid-drag. */
      expect(worst).toBeGreaterThan(Math.round(atRest * 0.9));
      expect(countColour(canvas, GREEN)).toBeGreaterThan(Math.round(atRest * 0.9));

      /* And the hole went exactly where the hand did. Measured on the canvas
         and in the model, because the first version of this test moved the
         caption 224px and blamed the drag: a left-aligned caption holds its
         left edge while its box grows, so setting the wording had walked its
         centre right long before any mouse came near it. */
      const centre = stencil.getCenterPoint();
      expect(centre.x - before.x).toBeCloseTo(24, -0.5);
      expect(centre.y - before.y).toBeCloseTo(16, -0.5);
      const now = openLayout()!.layers.find((l) => l.id === words.id)!;
      expect((now.x - 0.5) * TILE_W).toBeCloseTo(24, -0.5);
      expect(originBefore.x).toBe("center");
    } finally {
      await teardown();
    }
  });
});
