/* The real UI, mounted and clicked.
 *
 * This is the layer nothing else covers. Both bugs found by hand in this area
 * were invisible to unit tests and to the render tests: Ctrl-picking a second
 * layer collapsed the selection back to one, because the canvas answered the
 * pick by setting its active object and Fabric's selection event landed back
 * in the handler that caused it. Only a mounted component with a live Fabric
 * canvas can see that.
 *
 * It runs at all because platform.ts falls back to an in-memory filesystem
 * outside Tauri — the app opens its mock FaceTexture folder on mount, exactly
 * as it would open the real one. */
import type * as fabric from "fabric";
import { mount, tick, unmount } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";

import App from "./App.svelte";
import { resetRows, reveal } from "./lib/rows.svelte";
import {
  app,
  applyTransform,
  applyTransformBulk,
  addTileShape,
  addTileText,
  bakeMosaic,
  bulkTargets,
  changedHere,
  clearAll,
  selectLayer,
  alsoSelect,
  pickedLayers,
  groupPicked,
  ungroupLayer,
  groupHolding,
  takeOutOfGroup,
  setTileLayerField,
  archived,
  archiveSelection,
  releaseTilesToInbox,
  endGesture,
  deleteLayer,
  dropTileLayer,
  duplicateLayer,
  fileSelectionInto,
  fileTile,
  folders,
  newFolderHere,
  freeCount,
  history,
  historySteps,
  setLayerField,
  redoEdit,
  undoEdit,
  inbox,
  moveTilesToProject,
  deleteProject,
  newProjectFrom,
  addTileImage,
  resetCrop,
  say,
  fail,
  openFolder,
  openProjectView,
  projects,
  renameSnapshot,
  restoreSnapshot,
  stripSelectedTiles,
  saveToGame,
  nextSnapshotName,
  snapshots,
  takeSnapshot,
  tileLayers,
  unplace,
  visibleIds,
  renameLayer,
  tileCaptions,
  toggleLayerHidden,
  toggleLayerLocked,
  toggleTile,
  copyLayerProps,
  pasteLayerProps,
  pasteLayerOntoTiles,
  layersOnSelection,
  removeLayerFromSelection,
  setLayerHiddenOnSelection,
  setLayerLockedOnSelection,
} from "./lib/editor.svelte";
import {
  emptyManifest,
  findLayer,
  groupShift,
  isGradient,
  layerLabel,
  newImageLayer,
  newShapeLayer,
  newGroupLayer,
  clone,
  walkLayers,
  type ImageLayer,
  type ShapeLayer,
  type TextLayer,
} from "./lib/model";
import { maskChoices } from "./lib/model";
import { cellAt, textWidth, tilesChanged, wallPrint, type Tagged } from "./lib/scene";
import { TILE_H, TILE_W } from "./lib/bmp";
import { dragObject, scaleObject } from "./test/gestures";
import {
  undoLabel,
  redoLabel,
  tileHeadline,
  tileIcons,
  keepAllCharacters,
  keepCharacter,
  replaceAllCharacters,
  replaceCharacter,
  restorableCount,
  restoreProject,
} from "./lib/editor.svelte";
import { queuePick, readFile, resetMockFiles, stashPickedFile } from "./lib/platform";
import { vaultedIds } from "./lib/project";

/** Waits for a condition instead of a fixed delay: the app loads tiles and
 *  builds a Fabric scene asynchronously, and a sleep long enough to be safe on
 *  a loaded CI machine is long enough to make the suite unpleasant. */
async function until(what: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!what()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the app");
    await new Promise((r) => setTimeout(r, 25));
  }
}

let host: HTMLDivElement;
let ui: Record<string, unknown>;

async function mountApp() {
  /* Wipe the shared state first. `app` is a module-level rune, so it survives
   * an unmount — and a wait for "the folder has tiles" would then be satisfied
   * by the *previous* test's manifest and return before this mount's load had
   * even started. The load would land mid-test and take the fresh state with
   * it, which reads exactly like the app losing data. */
  app.manifest = emptyManifest();
  app.dir = "";
  app.selectedTiles = [];
  app.selected = "";
  app.openLayoutId = "";
  app.layoutSelection = [];
  app.error = "";
  // Same story for the sidebar's own state — which rows are open, what is
  // being dragged. See resetRows.
  resetRows();

  host = document.createElement("div");
  host.id = "app";
  document.body.append(host);
  ui = mount(App, { target: host });
  await until(() => !!app.dir && app.folderIds.length > 0 && !app.busy);
}

/** The app opens on the overview, so there is no wall canvas until one is
 *  entered. Clicked rather than set from the outside: the card is the only way
 *  in, and a test that bypassed it would not notice the card going missing. */
async function enterInbox() {
  const card = [...document.querySelectorAll("button")].find((b) =>
    b.textContent!.includes("Unsorted"),
  ) as HTMLButtonElement | undefined;
  if (!card) throw new Error("no way into Unsorted from the overview");
  card.click();
  await until(() => !!document.querySelector("canvas.lower-canvas"));
}

async function magentaSquare(name: string) {
  const c = new OffscreenCanvas(200, 200);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#ff00ff";
  ctx.fillRect(0, 0, 200, 200);
  const blob = await c.convertToBlob({ type: "image/png" });
  return stashPickedFile(`${name}.png`, new Uint8Array(await blob.arrayBuffer()));
}

beforeEach(async () => {
  // Only the returned teardown unmounts. Unmounting here as well double-frees
  // the previous component and Svelte rejects the second call.
  resetMockFiles();
  await mountApp();
  return async () => {
    await unmount(ui);
    host.remove();
  };
});

describe("the wall", () => {
  it("opens its folder without being asked and offers a way into it", async () => {
    expect(app.dir).toContain("FaceTexture");
    expect(app.folderIds.length).toBeGreaterThan(0);
    /* The overview first, not a wall. With several accounts sharing one folder
     * there is no single wall to guess at, and every tile starts unassigned —
     * so the inbox card is the way in and has to be there before anything
     * else works. */
    expect(document.querySelector("canvas.lower-canvas")).toBeNull();
    await enterInbox();
    expect(document.querySelector("canvas.lower-canvas")).toBeTruthy();
  });

  it("keeps its guide grid off the interaction canvas", async () => {
    /* Fabric has two canvases and fires after:render for both — once for the
     * objects, once for the interaction layer it draws handles on. The guide
     * hook answered both, so a copy of the whole lattice was painted onto the
     * top canvas, which only renderTop() ever clears. Every later zoom or pan
     * redrew the objects underneath while that copy stayed where it was: a
     * second grid, offset from the real one, and tile marks that outlived the
     * selection that made them.
     *
     * Measured on the top canvas rather than by eye: at 100% display scale the
     * offset is small enough to look like anti-aliasing. */
    await enterInbox();
    const canvas = (window as { tesseraWall?: fabric.Canvas }).tesseraWall!;
    await until(() => canvas.getObjects().length > 0);

    const ink = () => {
      const { width, height } = canvas.upperCanvasEl;
      const pixels = canvas.contextTop.getImageData(0, 0, width, height).data;
      let n = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) n++;
      return n;
    };

    /* Sized here on purpose. Mounted in a bare test document the stage collapses
     * to one pixel wide and the wall is drawn at 0.02% zoom, where every guide
     * is sub-pixel and the probe reads zero however broken the hook is — a test
     * that passes by measuring nothing. */
    canvas.setDimensions({ width: 900, height: 700 });
    canvas.setViewportTransform([0.1, 0, 0, 0.1, 20, 20]);

    canvas.clearContext(canvas.contextTop);
    canvas.renderAll();
    expect(ink()).toBe(0);

    // What dragging a layer, or drawing a selection box, asks for.
    canvas.renderTop();
    expect(ink()).toBe(0);
  });


  it("edits the layer on the tile it was picked on, not the first of that name", async () => {
    /* Two tiles, one layer id. That is not a contrived shape: the v6→v7 fold
     * copied every shared stack onto its tiles keeping the ids, and a design
     * dissolved across a wall keeps them on purpose — the shared id is what
     * lets one edit reach the same layer on every selected tile.
     *
     * So "the selected layer" is a pair, and it has to stay one all the way to
     * the write. It did not: the write looked the id up by scanning every tile
     * and taking the first hit, so a caption dragged on the second tile moved
     * on the first one instead — the portrait under the pointer did not budge,
     * and a portrait somewhere else on the wall quietly did. */
    await enterInbox();
    const [a, b] = app.folderIds;

    const twin = () => {
      const l = newImageLayer("block:#00ff00");
      l.id = "shared-01";
      l.x = 0.5;
      l.y = 0.5;
      return l;
    };
    app.manifest.tiles[a].layers.push(twin());
    app.manifest.tiles[b].layers.push(twin());
    app.version++;
    await tick();

    selectLayer("shared-01", b);
    await applyTransform(
      { layerId: "shared-01", tileId: b, space: "tile", locked: false } as Tagged,
      { x: 0.25, y: 0.75, rotation: 0, scale: 0.5, scaleH: 0.5, fx: 1, fy: 1 },
    );

    const on = (tile: string) => findLayer(tileLayers(tile), "shared-01")!;
    expect(on(b).x).toBeCloseTo(0.25, 5);
    expect(on(b).y).toBeCloseTo(0.75, 5);
    // The other portrait was never asked about.
    expect(on(a).x).toBeCloseTo(0.5, 5);
    expect(on(a).y).toBeCloseTo(0.5, 5);
  });

  /* The row buttons are the third caller of that pair, and they never carried
   * the tile. A row knows perfectly well which portrait it belongs to — the
   * name button beside the eye passes it — so the eye hid, the lock locked and
   * × deleted on whichever tile the id turned up on first, unless that tile
   * happened to be the selected one. On the real document three ids sit on 14,
   * 14 and 39 of the 44 tiles, so most clicks landed elsewhere. */
  const twinned = async (id: string) => {
    await enterInbox();
    const [a, b] = app.folderIds;
    /* A shape, not a picture: the row draws what it lists, and a made-up asset
     * name has nothing behind it to draw. */
    const twin = () => {
      const l = newShapeLayer("rect");
      l.id = id;
      return l;
    };
    app.manifest.tiles[a].layers.push(twin());
    app.manifest.tiles[b].layers.push(twin());
    app.version++;
    await tick();
    // Nothing picked: what a row click does before anything else is touched.
    selectLayer("", "");
    return [a, b] as const;
  };

  it("hides the layer on the row's own tile, not the first tile holding that id", async () => {
    const [a, b] = await twinned("shared-eye");
    await toggleLayerHidden("shared-eye", b);

    expect(findLayer(tileLayers(b), "shared-eye")!.hidden).toBe(true);
    expect(findLayer(tileLayers(a), "shared-eye")!.hidden).toBeFalsy();
  });

  it("locks from a row whose tile is not the selected one", async () => {
    /* The other resolver, and the other symptom: this one does not scan, so an
     * unselected tile answered `undefined` and the click did nothing at all. */
    const [a, b] = await twinned("shared-lock");
    await toggleLayerLocked("shared-lock", b);

    expect(findLayer(tileLayers(b), "shared-lock")!.locked).toBe(true);
    expect(findLayer(tileLayers(a), "shared-lock")!.locked).toBeFalsy();
  });

  it("deletes from the row's own tile", async () => {
    const [a, b] = await twinned("shared-x");
    await deleteLayer("shared-x", b);

    expect(findLayer(tileLayers(b), "shared-x")).toBeUndefined();
    expect(findLayer(tileLayers(a), "shared-x")).toBeTruthy();
  });

  it("hides from the row that was actually clicked", async () => {
    /* The three above prove the functions honour a tile. This one proves the
     * rows hand one over, which is where the bug was: the resolvers were doing
     * what they were asked, with nobody asking for a tile at all. Clicked
     * through the DOM for that reason — calling the function with the right
     * argument cannot fail the way the button did. */
    const [a, b] = await twinned("shared-dom");

    // The rows are behind the Tiles twisty, and a shut section renders none.
    reveal("tiles");
    await tick();

    const row = document.querySelector(`[data-tile="${b}"]`) as HTMLElement;
    expect(row).toBeTruthy();
    (row.querySelector("button.twisty") as HTMLButtonElement).click();
    await tick();

    const eye = [...row.querySelectorAll("button.eye")].find(
      (e) => e.getAttribute("title") === "Hide",
    ) as HTMLButtonElement;
    expect(eye).toBeTruthy();
    eye.click();

    await until(() => !!findLayer(tileLayers(b), "shared-dom")!.hidden);
    expect(findLayer(tileLayers(a), "shared-dom")!.hidden).toBeFalsy();
  });

  it("hands the canvas handles to the picked tile's copy alone", async () => {
    /* The other half of the same pair. Matching on the id alone made every
     * copy of a dissolved design grabbable at once, and the active handles
     * landed on whichever one Fabric happened to list first. */
    await enterInbox();
    const [a, b] = app.folderIds;
    /* A shape, not a picture: the app resolves assets through Tauri and a
     * made-up name never loads, so nothing would reach the canvas to grab. */
    for (const tile of [a, b]) {
      const l = newShapeLayer("rect");
      l.id = "twin-01";
      l.w = 0.4;
      l.h = 0.4;
      app.manifest.tiles[tile].layers.push(l);
    }
    app.version++;
    await tick();

    selectLayer("twin-01", b);
    const canvas = (window as { tesseraWall?: fabric.Canvas }).tesseraWall!;
    await until(() => canvas.getObjects().some((o) => (o as Tagged).layerId === "twin-01"));
    await until(() => !!canvas.getActiveObject());

    const grabbable = canvas
      .getObjects()
      .filter((o) => (o as Tagged).layerId === "twin-01" && o.selectable);
    expect(grabbable).toHaveLength(1);
    expect((grabbable[0] as Tagged).tileId).toBe(b);
    expect((canvas.getActiveObject() as Tagged).tileId).toBe(b);
  });

  it("reaches every picked tile with one field edit, in one undo step", async () => {
    await enterInbox();
    const [a, b, c] = app.folderIds;
    for (const tile of [a, b, c]) {
      const l = newShapeLayer("rect");
      l.id = "badge-01";
      l.fill = "#111111";
      app.manifest.tiles[tile].layers.push(l);
    }
    app.version++;
    await tick();

    const steps = history.past.length;
    app.selectedTiles = [a, b];
    selectLayer("badge-01", a);
    await setTileLayerField(bulkTargets("badge-01"), "badge-01", "fill", "#ff0000");

    const fill = (tile: string) =>
      (findLayer(tileLayers(tile), "badge-01") as ShapeLayer).fill;
    expect(fill(a)).toBe("#ff0000");
    expect(fill(b)).toBe("#ff0000");
    // The tile nobody picked keeps its own.
    expect(fill(c)).toBe("#111111");
    expect(history.past.length).toBe(steps + 1);

    // And one undo puts all of them back together.
    await undoEdit();
    expect(fill(a)).toBe("#111111");
    expect(fill(b)).toBe("#111111");
  });

  it("says on the panel how many tiles it writes to", async () => {
    /* The panel's Text field writes to every selected tile carrying the layer.
     * Nothing said how many that was, and with forty-four picked one keystroke
     * replaces forty-four names typed by hand. The count is on the heading,
     * where it can be read before something is changed. */
    await enterInbox();
    const [a, b, c] = app.folderIds;
    app.selectedTiles = [a, b, c];
    await addTileText();
    const caption = tileLayers(a).at(-1)!;
    selectLayer(caption.id, a);
    reveal("props");
    await tick();
    await until(() =>
      [...document.querySelectorAll("h2")].some((h) => h.textContent!.includes("3 tiles")),
    );

    // One tile picked, no count: there is nothing to warn about.
    app.selectedTiles = [a];
    await tick();
    await until(() =>
      [...document.querySelectorAll("h2")].every((h) => !h.textContent!.includes("tiles")),
    );
  });

  it("puts the old number back when a box is typed full of nonsense", async () => {
    /* Driven through the box itself, because the fault was in the box.
     * "1e999" is a valid entry for a number field and is Infinity: the model
     * refused it, but the panel had already written String(Math.round(Infinity))
     * — "Infinity" — back into an input that cannot hold it, so the box went
     * blank. The next entry then read that blank as 0 and stored the minimum,
     * which is how typing a size too big left a caption at 30px. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileText();
    const caption = tileLayers(tile).at(-1)!;
    await setTileLayerField([tile], caption.id, "w", 0.5);
    selectLayer(caption.id, tile);
    reveal("props");
    await tick();

    const box = () => {
      const row = [...document.querySelectorAll("label.field")].find(
        (l) => l.querySelector("span")?.textContent?.trim() === "Width",
      );
      return row?.querySelector("input.num") as HTMLInputElement | undefined;
    };
    await until(() => !!box());
    const before = box()!.value;
    expect(Number(before)).toBeGreaterThan(100);

    box()!.value = "1e999";
    box()!.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    await new Promise((r) => setTimeout(r, 100));

    // The layer is the size it was, and the box says so.
    expect((findLayer(tileLayers(tile), caption.id) as TextLayer).w).toBeCloseTo(0.5, 6);
    expect(box()!.value).toBe(before);
  });

  it("refuses a size no renderer can draw, and keeps an icon square-ish", async () => {
    /* Two ways the panel could write a number the wall cannot use.
     *
     * "1e999" is a valid entry for a number field and is Infinity; the clamps
     * in the panel all read `max ?? Infinity`, so for every box without a
     * ceiling it came through. The layer draws as nothing, and the save turns
     * it into `null`, which is a layer of no size with its row still in the
     * list and no way back to a size.
     *
     * And a class icon is fitted to both its width and its height while the
     * panel offers only the width, so the slider stopped doing anything about
     * a quarter above wherever the icon started. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("rect");
    const rect = tileLayers(tile).at(-1)!;
    const was = (rect as ShapeLayer).w;
    await setTileLayerField([tile], rect.id, "w", Number("1e999"));
    expect((findLayer(tileLayers(tile), rect.id) as ShapeLayer).w).toBe(was);

    await addTileShape("icon", "Ranger");
    const icon = tileLayers(tile).at(-1)!;
    await setTileLayerField([tile], icon.id, "w", 0.9);
    const now = findLayer(tileLayers(tile), icon.id) as ShapeLayer;
    // The height follows, or the fit takes the smaller of the two and the
    // slider's upper half does nothing.
    expect(now.h).toBeCloseTo(0.9, 6);
  });

  it("reaches the tile the panel is showing, whichever tiles are picked", async () => {
    /* Reported from the code rather than by hand, and worth pinning because
     * what it looks like is a dead control: pick two tiles on the wall, click a
     * layer on a third, drag Opacity — the two change and the one whose numbers
     * are in the panel does not. Clicking a layer object sets the pair (id,
     * tile) and deliberately leaves the wall's tile selection alone, so the
     * panel showed C while the edit went to A and B.
     *
     * The tile a layer was picked on is not one more selected tile; it is the
     * layer's own address, which is why it is unioned in rather than replacing
     * the selection. */
    await enterInbox();
    const [a, b, c] = app.folderIds;
    for (const tile of [a, b, c]) {
      const l = newShapeLayer("rect");
      l.id = "plate-01";
      l.fill = "#111111";
      app.manifest.tiles[tile].layers.push(l);
    }
    app.version++;
    await tick();

    app.selectedTiles = [a, b];
    selectLayer("plate-01", c);
    expect(bulkTargets("plate-01").sort()).toEqual([a, b, c].sort());

    await setTileLayerField(bulkTargets("plate-01"), "plate-01", "fill", "#ff0000");
    const fill = (tile: string) => (findLayer(tileLayers(tile), "plate-01") as ShapeLayer).fill;
    for (const tile of [a, b, c]) expect(fill(tile)).toBe("#ff0000");
  });

  it("refuses to bake a wall picture whose look would not survive it", async () => {
    /* A baked background is an asset name and a crop rectangle, and that is all
     * `background()` draws. Everything else the panel offers for a picture —
     * the rotation, the trim, the grading dials, the frame, the opacity — is
     * drawn on the wall and would simply be missing from the forty-four files
     * written to the game. It baked anyway, and with the eye switched off it
     * baked a picture that was not even on screen. Named and refused, because
     * the alternative is a wall that disagrees with the game and says nothing.
     */
    await enterInbox();
    app.selectedTiles = app.folderIds.slice(0, 4);
    await newProjectFrom("Konto");
    const p = projects()[0].id;
    openProjectView(p);

    const picture = newImageLayer("block:#00ff88");
    picture.space = "grid";
    picture.scale = 4;
    app.manifest.projects.find((x) => x.id === p)!.gridLayers.push(picture);
    app.version++;
    selectLayer(picture.id, "");
    await tick();

    await setLayerField(picture.id, "rotation", 30);
    await bakeMosaic();
    expect(app.error).toContain("rotation");
    for (const id of app.folderIds.slice(0, 4)) expect(app.manifest.tiles[id].base).toBeNull();

    /* Straightened out, the guard lets it past. What happens after that is the
     * bake's own business and is covered where the arithmetic lives — this
     * harness has no real picture behind that asset name. */
    await setLayerField(picture.id, "rotation", 0);
    app.error = "";
    await bakeMosaic();
    expect(app.error).not.toContain("Not applied");
  });

  it("leaves no wall open that the document does not have", async () => {
    /* Undo swaps the document and nothing else, so the id of the open project
     * outlived the project itself: the canvas fell back to Unsorted while the
     * sidebar highlighted nothing, and the wall's own menu lost the two entries
     * that wall is for and offered two that silently did nothing. Both ways in
     * are here — undoing the making of a project, and redoing its deletion. */
    await enterInbox();
    app.selectedTiles = app.folderIds.slice(0, 3);
    await newProjectFrom("Konto");
    const made = projects()[0].id;
    openProjectView(made);
    expect(app.openProjectId).toBe(made);

    await undoEdit();
    expect(app.openProjectId).toBe("");

    await redoEdit();
    openProjectView(projects()[0].id);
    await deleteProject(projects()[0].id);
    await undoEdit();
    await redoEdit();
    expect(app.openProjectId).toBe("");
  });

  it("stops reaching the picked tile once the pick is dropped", async () => {
    /* The other half of the rule above, and it was missing: the tile a layer
     * was picked on always counts, so something has to stop counting it. Left
     * standing, it kept an edit reaching a tile the user had left behind —
     * possibly on another wall — because clearing the pick cleared the layer
     * and not its address. */
    await enterInbox();
    const [a, b, c] = app.folderIds;
    for (const tile of [a, b, c]) {
      const l = newShapeLayer("rect");
      l.id = "badge-77";
      app.manifest.tiles[tile].layers.push(l);
    }
    app.version++;
    await tick();

    selectLayer("badge-77", a);
    expect(bulkTargets("badge-77")).toEqual([a]);

    clearAll();
    /* What a row drop does: it names the layer without naming a tile
     * (`dropInto` writes app.selected outright). So the address left over from
     * the last pick is the one that answers — and it must be gone by now. */
    app.selectedTiles = [b, c];
    app.selected = "badge-77";
    expect(bulkTargets("badge-77").sort()).toEqual([b, c].sort());
  });

  it("starts a new undo step when the picked tiles change mid-slider", async () => {
    /* Runs collapse an edit that is still being made — dragging a slider is one
     * step, not forty. The key says two edits are of the same kind, so the tile
     * set has to be in it: without that, editing {a,b}, reselecting {c} and
     * carrying on with the same control folded both into one step, and a single
     * undo left half the wall changed. */
    await enterInbox();
    const [a, b, c] = app.folderIds;
    for (const tile of [a, b, c]) {
      const l = newShapeLayer("rect");
      l.id = "bar-01";
      app.manifest.tiles[tile].layers.push(l);
    }
    app.version++;
    await tick();

    app.selectedTiles = [a, b];
    selectLayer("bar-01", a);
    await setTileLayerField(bulkTargets("bar-01"), "bar-01", "w", 0.3);
    const afterFirst = history.past.length;

    app.selectedTiles = [c];
    selectLayer("bar-01", c);
    await setTileLayerField(bulkTargets("bar-01"), "bar-01", "w", 0.7);
    expect(history.past.length).toBe(afterFirst + 1);
  });

  it("places a dragged layer on every picked tile without compounding its size", async () => {
    /* A shape stores its size and `resize` multiplies it by what Fabric
     * scaled, so replaying the gesture on each tile would scale each one by
     * that factor again — tiles that had drifted apart would drift further.
     * The dragged layer's finished size is what the others copy. */
    await enterInbox();
    const [a, b] = app.folderIds;
    const widths: Record<string, number> = { [a]: 0.4, [b]: 0.2 };
    for (const tile of [a, b]) {
      const l = newShapeLayer("rect");
      l.id = "plate-01";
      l.w = widths[tile];
      l.h = 0.1;
      l.x = 0.5;
      app.manifest.tiles[tile].layers.push(l);
    }
    app.version++;
    await tick();

    app.selectedTiles = [a, b];
    selectLayer("plate-01", a);
    await applyTransformBulk(
      { layerId: "plate-01", tileId: a, space: "tile", locked: false } as Tagged,
      { x: 0.3, y: 0.6, rotation: 0, scale: 1, scaleH: 1, fx: 2, fy: 1 },
      [a, b],
    );

    const on = (tile: string) => findLayer(tileLayers(tile), "plate-01") as ShapeLayer;
    // The dragged one took the factor: 0.4 * 2.
    expect(on(a).w).toBeCloseTo(0.8, 5);
    // The other one matches it outright rather than doubling its own 0.2.
    expect(on(b).w).toBeCloseTo(0.8, 5);
    expect(on(b).x).toBeCloseTo(0.3, 5);
    expect(on(b).y).toBeCloseTo(0.6, 5);
  });



  it("takes a range with shift and a single tile with ctrl", async () => {
    /* Twenty tiles into a drawer used to mean twenty ctrl-clicks: the grid
     * treated shift as another ctrl, and a click in the list replaced the
     * selection outright. The range runs over wall order, so it is the same
     * answer whether it was clicked on the wall or in the list. */
    await enterInbox();
    const [a, b, c, d] = app.folderIds;

    toggleTile(a, {});
    toggleTile(c, { shift: true });
    expect(app.selectedTiles).toEqual([a, b, c]);

    // The anchor stays put, so a second shift-click reshapes the same range
    // instead of starting over from the last one.
    toggleTile(d, { shift: true });
    expect(app.selectedTiles).toEqual([a, b, c, d]);

    toggleTile(b, { ctrl: true });
    expect(app.selectedTiles).toEqual([a, c, d]);

    // Upwards from the anchor reads the same way round as downwards.
    toggleTile(d, {});
    toggleTile(b, { shift: true });
    expect(app.selectedTiles).toEqual([b, c, d]);
  });


  it("takes a range inside a drawer, over the drawer's own contents", async () => {
    /* The range ran over wall order whatever list was clicked in. A drawer
     * holds whichever tiles were filed into it, and they need not sit next to
     * each other on the wall — so shift-clicking from the drawer's first row to
     * its third swept up everything lying between them out there, tiles the
     * drawer does not hold and the eye cannot see in that list. The range is
     * taken over whichever list holds the tile now. */
    await enterInbox();
    const wall = app.folderIds.slice(0, 5);
    app.selectedTiles = [...wall];
    await newProjectFrom("Konto");
    await newFolderHere("Fertig");
    const drawer = folders()[0];
    // Every other tile, so the drawer's rows are not neighbours on the wall.
    const filed = [wall[0], wall[2], wall[4]];
    for (const id of filed) await fileTile(id, drawer.id);
    expect(folders()[0].tiles).toEqual(filed);

    app.selectedTiles = [];
    toggleTile(filed[0], {});
    toggleTile(filed[2], { shift: true });
    expect(app.selectedTiles).toEqual(filed);
  });

  it("puts the document aside and back again, leaving the game folder alone", async () => {
    /* Twenty kilobytes, not a folder copy: assets and vault copies are never
     * deleted, so a restored snapshot finds everything it names still on disk.
     * The game's own files are a separate decision — this is the document. */
    const [a, b, c] = app.folderIds;
    app.selectedTiles = [a, b, c];
    await newProjectFrom("Konto");
    expect(projects()).toHaveLength(1);

    const projectId = projects()[0].id;
    await takeSnapshot("Mit Projekt");
    expect(snapshots().map((s) => s.name)).toContain("Mit Projekt");

    // Walk away from that state.
    await deleteProject(projectId);
    expect(projects()).toHaveLength(0);

    /* Still listed with its wall gone: a snapshot naming a deleted project
     * falls back to the overview, which is the one place it can be reached from
     * — and reaching it is how the wall comes back. */
    expect(snapshots().map((s) => s.name)).toContain("Mit Projekt");

    await restoreSnapshot({ name: "Mit Projekt", projectId });
    expect(projects()).toHaveLength(1);
    expect(projects()[0].order).toEqual([a, b, c]);
  });

  it("puts one wall back without touching the wall beside it", async () => {
    /* The whole point of scoping a snapshot to a project: rolling one account's
     * arrangement back must not rearrange the account next to it. */
    const [a, b, c, d] = app.folderIds;
    app.selectedTiles = [a, b];
    await newProjectFrom("Erstes");
    const first = projects()[0].id;

    app.selectedTiles = [c, d];
    await newProjectFrom("Zweites");
    const second = projects().find((p) => p.id !== first)!.id;

    openProjectView(first);
    await takeSnapshot("Erstes wie es war");

    // Both walls change after the snapshot was taken.
    await unplace(b);
    openProjectView(second);
    await unplace(d);

    openProjectView(first);
    await restoreSnapshot({ name: "Erstes wie es war", projectId: first });

    const back = projects().find((p) => p.id === first)!;
    const untouched = projects().find((p) => p.id === second)!;
    expect(back.order).toEqual([a, b]);
    // The other wall keeps the change made to it, rather than being rolled
    // back to the state the snapshot happened to record for it.
    expect(untouched.order).toEqual([c]);
    expect(untouched.shelf).toEqual([d]);
  });

  it("takes a tile back from whoever holds it now, and says how many", async () => {
    const [a, b, c] = app.folderIds;
    app.selectedTiles = [a, b];
    await newProjectFrom("Erstes");
    const first = projects()[0].id;

    openProjectView(first);
    await takeSnapshot("Beide");

    app.selectedTiles = [c];
    await newProjectFrom("Zweites");
    const second = projects().find((p) => p.id !== first)!.id;

    // The tile changes hands after the snapshot was taken.
    app.selectedTiles = [b];
    await moveTilesToProject(second);
    expect(projects().find((p) => p.id === second)!.shelf).toContain(b);

    openProjectView(first);
    await restoreSnapshot({ name: "Beide", projectId: first });

    expect(projects().find((p) => p.id === first)!.order).toEqual([a, b]);
    // Ownership is exclusive, so the other wall gives it up — and the message
    // says so rather than letting a wall change behind the user's back.
    const other = projects().find((p) => p.id === second)!;
    expect([...other.order, ...other.shelf]).toEqual([c]);
    expect(app.note).toContain("1 tile(s) taken back");
  });


  it("refuses a rename that would land on another snapshot's file", async () => {
    /* The dedupe compared what was typed while the file was written under a
     * sanitised name, so "a/b" walked over "a_b" — no dialog, no undo, one
     * snapshot fewer. Measured on the real folder before the fix. */
    await takeSnapshot("a_b");
    await takeSnapshot("zweiter");
    const before = snapshots().length;

    await renameSnapshot({ name: "zweiter", projectId: "" }, "a/b");

    expect(snapshots()).toHaveLength(before);
    expect(snapshots().map((s) => s.name)).toContain("a_b");
    expect(snapshots().map((s) => s.name)).toContain("zweiter");
    expect(app.error).toContain("already a snapshot");
  });

  it("never lets the automatic snapshot overwrite the one before it", async () => {
    /* Named to the minute, so two writes in the same minute were one file —
     * the second replacing the restore point the first had just made, which is
     * the single moment it exists for. */
    const [a] = app.folderIds;
    app.selectedTiles = [a];
    await newProjectFrom("Konto");
    openProjectView(projects()[0].id);

    await saveToGame();
    await saveToGame();

    const auto = snapshots().filter((s) => s.name.startsWith("Before write"));
    expect(auto).toHaveLength(2);
    expect(new Set(auto.map((s) => s.name)).size).toBe(2);
  });

  it("takes one tile off the wall per click on ↩, and redraws the row", async () => {
    /* A reviewer clicked ↩ once, saw nothing move, clicked again and found two
     * tiles on the shelf. This pins the click down: one press, one tile, and a
     * list that is already showing the new state when the press returns. */
    const [a, b, c] = app.folderIds;
    app.selectedTiles = [a, b, c];
    await newProjectFrom("Konto");
    const cards = () => [...document.querySelectorAll("button")];
    await until(() => cards().some((x) => x.textContent!.includes("Konto")));
    cards()
      .find((x) => x.textContent!.includes("Konto"))!
      .click();
    await until(() => !!document.querySelector("canvas.lower-canvas"));

    // The tile list starts folded away.
    cards()
      .find((x) => x.textContent!.includes("On this wall"))!
      .click();
    const offWall = () => cards().filter((x) => x.title === "Off the wall, onto the shelf");
    await until(() => offWall().length === 3);

    offWall()[0].click();
    await until(() => projects()[0].shelf.length === 1);

    expect(projects()[0].order).toEqual([b, c]);
    // The row is gone from the list too, not just from the model — an unchanged
    // list is what invites the second click.
    await until(() => offWall().length === 2);
  });

  it("asks before overwriting the game's own files, and takes No for an answer", async () => {
    /* The only button that reaches out of the app and changes files another
     * program owns, and it asked nothing — while "Reset in game" beside it,
     * which this one undoes, asked every time. A "No" has to stop everything,
     * the safety snapshot included: it exists for the write, and taking one for
     * a write that never happens buries the real restore points. */
    const [a] = app.folderIds;
    app.selectedTiles = [a];
    await newProjectFrom("Konto");
    /* Entered through its card, not through openProjectView: which wall the
     * stage shows is the component's own state, and the toolbar is greyed out
     * on the overview — a test that set the id from outside would find the
     * button disabled for a reason that has nothing to do with the write. */
    const cards = () => [...document.querySelectorAll("button")];
    await until(() => cards().some((b) => b.textContent!.includes("Konto")));
    cards()
      .find((b) => b.textContent!.includes("Konto"))!
      .click();
    await until(() => !!document.querySelector("canvas.lower-canvas"));

    const asked: string[] = [];
    const real = window.confirm;
    window.confirm = (m?: string) => {
      asked.push(m ?? "");
      return false;
    };
    try {
      const write = [...document.querySelectorAll("button")].find(
        (b) => b.textContent!.trim() === "Write to game",
      ) as HTMLButtonElement;
      expect(write.disabled).toBe(false);
      write.click();
      await until(() => asked.length > 0);
      await until(() => !app.busy);
    } finally {
      window.confirm = real;
    }
    expect(asked[0]).toContain("over the game's portrait files");
    expect(snapshots().some((s) => s.name.startsWith("Before write"))).toBe(false);
  });



  it("lists only the open wall's snapshots", async () => {
    const [a, b] = app.folderIds;
    app.selectedTiles = [a];
    await newProjectFrom("Erstes");
    const first = projects()[0].id;
    openProjectView(first);
    await takeSnapshot("Nur Erstes");

    app.selectedTiles = [b];
    await newProjectFrom("Zweites");
    openProjectView(projects().find((p) => p.id !== first)!.id);

    expect(snapshots().map((s) => s.name)).not.toContain("Nur Erstes");
    await takeSnapshot("Nur Zweites");
    expect(snapshots().map((s) => s.name)).toEqual(["Nur Zweites"]);

    openProjectView(first);
    expect(snapshots().map((s) => s.name)).toEqual(["Nur Erstes"]);
  });

  it("drops tiles the folder no longer has when restoring", async () => {
    /* A snapshot taken before a character was deleted would otherwise put rows
     * back for a portrait that is not there any more. */
    const [a] = app.folderIds;
    await takeSnapshot("Voll");

    // The folder shrinks under us, as it does when a character is deleted.
    app.folderIds = [a];
    await restoreSnapshot({ name: "Voll", projectId: "" });
    expect(Object.keys(app.manifest.tiles)).toEqual([a]);
  });

  it("takes one before writing to the game", async () => {
    const [a] = app.folderIds;
    app.selectedTiles = [a];
    await newProjectFrom("Konto");
    openProjectView(projects()[0].id);

    const before = snapshots().length;
    await saveToGame();
    expect(snapshots().length).toBe(before + 1);
    expect(snapshots().some((s) => s.name.startsWith("Before write"))).toBe(true);
  });

  it("makes a project from the picked tiles and counts only the free ones", async () => {
    const [a, b, c] = app.folderIds;
    app.selectedTiles = [a, b, c];
    expect(freeCount()).toBe(3);

    await newProjectFrom("Erstes");
    expect(projects()).toHaveLength(1);
    expect(projects()[0].order).toEqual([a, b, c]);
    // Claimed now, so the same pick can no longer start a second project — and
    // the three are out of the inbox.
    app.selectedTiles = [a, b, c];
    expect(freeCount()).toBe(0);
    expect(inbox()).not.toContain(a);
  });




  it("lets a section be collapsed while a tile is still picked", async () => {
    /* The follow that opens the way to a picked tile reads the open sections to
     * decide what to expand, so the sections are one of its dependencies:
     * collapsing "On this wall" with a tile still selected woke it, it saw a
     * closed section under a live selection, and opened it straight back. The
     * section could not be shut at all until the tile was let go. */
    await enterInbox();
    const a = app.folderIds[0];
    toggleTile(a, { ctrl: false, shift: false });

    const head = () =>
      [...document.querySelectorAll("aside button.name")].find((b) =>
        b.textContent!.includes("right-click the wall to assign"),
      ) as HTMLButtonElement | undefined;
    await until(() => !!head());
    // The follow opened it, which is the behaviour worth keeping.
    await until(() => !!document.querySelector(`[data-tile="${a}"]`));

    head()!.click();
    await tick();
    expect(document.querySelector(`[data-tile="${a}"]`)).toBeNull();

    // And it stays shut: the tile is still picked.
    await new Promise((r) => setTimeout(r, 60));
    expect(app.selectedTiles).toContain(a);
    expect(document.querySelector(`[data-tile="${a}"]`)).toBeNull();
  });







});



/* --- The four answers to "the game rewrote this tile", and the way back from a
 * write. These reach past the document and delete the last untouched copy of a
 * portrait, which makes them the highest-stakes code in the app; `classify` was
 * well covered, the actions taken on its verdict were not.
 *
 * The mass buttons are clicked in "answers the whole changed list at once"
 * above. What is pinned here is what that test cannot see: which of them eats
 * the vault, and which one deliberately does not. --- */
describe("keeping and replacing a character", () => {
  /** A project of `count` tiles, dressed and written to the game — which is
   *  what puts their pristine originals in the vault. */
  async function written(count: number) {
    const ids = app.folderIds.slice(0, count);
    app.selectedTiles = [...ids];
    await newProjectFrom("Konto");
    openProjectView(projects()[0].id);
    // Dressed straight onto the tiles: a layer on each is what the vault
    // question is about, and there is no other way to put one there now.
    app.selectedTiles = [...ids];
    await addTileText();
    await saveToGame();
    await until(() => ids.every((id) => app.vaulted.includes(id)));
    return ids;
  }

  it("drops the vault copy of a restyled character and keeps the layers", async () => {
    /* The vault is what loadOriginal serves as "the original", in preference to
     * the game's own file. After a restyle it holds the face from before, so
     * keeping it would mean the editor went on showing the old haircut for
     * good — seen on a real folder, thirty-five portraits deep. */
    const [a] = await written(1);

    app.hashes = { ...app.hashes, [a]: "restyled" };
    app.changedTiles = [a];
    await keepCharacter(a);

    expect(app.manifest.tiles[a].layers.length).toBeGreaterThan(0);
    expect(app.changedTiles).toEqual([]);
    expect(await vaultedIds(app.dir)).not.toContain(a);
    expect(app.vaulted).not.toContain(a);
  });

  it("leaves an archived portrait's question alone when the list is answered", async () => {
    /* Archiving is "not now", not "decide for me" — the banner leaves those out
     * and lists the rest. The two mass buttons read every changed tile instead,
     * so a portrait set aside was answered by a button that never mentioned it:
     * with "All new characters" that means its layers stripped and its vault
     * original deleted, which is the one step Ctrl+Z cannot take back. */
    const [a, b] = await written(2);
    app.hashes = { ...app.hashes, [a]: "fremder", [b]: "fremder" };
    app.changedTiles = [a, b];

    /* b is put away, so the banner asks about a alone. Archiving is only
     * offered for a tile no project has claimed, so it leaves the wall first —
     * which is what a user does with a portrait they are not ready to decide
     * about. */
    app.selectedTiles = [b];
    await releaseTilesToInbox();
    // Re-picked: releasing a tile clears the selection it was made from.
    app.selectedTiles = [b];
    await archiveSelection(true);
    app.selectedTiles = [];
    expect(changedHere()).toEqual([a]);

    await replaceAllCharacters();

    // The one on screen was answered; the one put away kept its question and
    // its original.
    expect(app.changedTiles).toEqual([b]);
    expect(app.vaulted).toContain(b);
    expect(await vaultedIds(app.dir)).toContain(b);
    expect(app.vaulted).not.toContain(a);
  });

  it("strips a tile whose slot went to a stranger, and drops that vault copy too", async () => {
    const [a] = await written(1);

    app.hashes = { ...app.hashes, [a]: "fremder" };
    app.changedTiles = [a];
    await replaceCharacter(a);

    // The layers were composed for a face that no longer exists.
    expect(app.manifest.tiles[a].layers).toEqual([]);
    expect(projects()[0].order).not.toContain(a);
    expect(await vaultedIds(app.dir)).not.toContain(a);
  });

  it("leaves the vault alone when the whole folder was regenerated", async () => {
    /* The one rule that makes the mass answer more than a loop over the
     * per-tile one. A wholesale regeneration is the opposite situation to a
     * restyle: the vault is the curated set of originals, and it is the single
     * thing this answer must not eat. */
    const [a, b] = await written(2);

    app.hashes = { ...app.hashes, [a]: "neu-a", [b]: "neu-b" };
    app.changedTiles = [a, b];
    await keepAllCharacters();

    const held = await vaultedIds(app.dir);
    expect(held).toContain(a);
    expect(held).toContain(b);
    expect(app.changedTiles).toEqual([]);
  });

  it("puts every layer back with one Ctrl+Z after answering 'all new'", async () => {
    // One mutation for the whole list, which is what makes a single undo the
    // way out of a mass answer given in error.
    const [a, b] = await written(2);

    app.hashes = { ...app.hashes, [a]: "neu-a", [b]: "neu-b" };
    app.changedTiles = [a, b];
    await replaceAllCharacters();
    expect(app.manifest.tiles[a].layers).toEqual([]);
    expect(app.manifest.tiles[b].layers).toEqual([]);

    await undoEdit();

    expect(app.manifest.tiles[a].layers.length).toBeGreaterThan(0);
    expect(app.manifest.tiles[b].layers.length).toBeGreaterThan(0);
    // The vault copies stay gone, as the per-tile button leaves them: undo
    // takes back the document, never the disk.
    expect(await vaultedIds(app.dir)).not.toContain(a);
  });
});

describe("putting the game's own portraits back", () => {
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);


  it("counts what the vault holds, not what the project owns", async () => {
    /* The dialog used to offer every tile of the project and then report "none
     * of these were written" once it was too late to say no: a tile that was
     * never written has no vault copy and nothing to undo. */
    const [a, b] = app.folderIds;
    app.selectedTiles = [a, b];
    await newProjectFrom("Konto");
    openProjectView(projects()[0].id);

    expect(restorableCount()).toBe(0);
    await restoreProject();
    expect(app.note).toContain("Nothing to put back");
  });
});

describe("the placing tool", () => {
  /* The one mode the wall has, and the only way to move a layer that is baked
   * to pixels before its cell clips it — a masked picture, a class icon. The
   * object on the canvas for those is a flat image at the cell's origin, so
   * `object:modified` refuses it outright and a transparent stand-in is dragged
   * instead.
   *
   * It went on working the whole time it had stopped doing anything: the drag
   * wrote a Frame, the tile's offset from a design that no longer exists, into
   * a record the renderer stopped reading when the stamps came apart. The
   * stand-in moved, the picture under it did not, and the next rebuild put the
   * frame back where the layer still was. Nothing failed and nothing said so,
   * which is why this is a gesture and not a unit test. */
  async function placing() {
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    /* A shape that something is cutting, which is one of the two kinds the
     * frame appears on. There is no mode to switch on any more: picking the
     * layer is the whole of it. */
    await addTileShape("rect");
    const layer = tileLayers(tile).at(-1)!;
    await addTileShape("ellipse");
    const cutter = tileLayers(tile).at(-1)!;
    await setTileLayerField([tile], layer.id, "maskId", cutter.id);
    selectLayer(layer.id, tile);

    const canvas = (window as { tesseraWall?: fabric.Canvas }).tesseraWall!;
    const current = () =>
      canvas.getObjects().find((o) => (o as Tagged & { framing?: boolean }).framing);
    await until(() => !!current());
    /* Waited out rather than taken as soon as one appears. Adding the layer
     * bumps the document, the wall redraws the tile, and the effect that owns
     * the stand-in puts up a fresh one — so the first object to show up is
     * often replaced a frame later. A gesture against that stale instance is
     * dropped on the floor by `opt.target === stand`, and the test then fails
     * having proved nothing about the code it was written for. Held still for
     * a stretch first, then taken. */
    let held = current();
    let steady = 0;
    await until(() => {
      const now = current();
      steady = now && now === held ? steady + 1 : 0;
      held = now;
      return steady >= 8;
    });
    const stand = held!;
    return { canvas, stand, tile, layerId: layer.id };
  }

  it("puts the stand-in on the layer's own tile, not on whichever tile matched first", async () => {
    const { stand, tile, layerId } = await placing();
    /* Both, and the tile especially: applyTransform resolves the stack from the
     * object's own tile, and a stand-in carrying only a layer id sent the drag
     * through a scan of the wall — which wrote it onto the first tile holding
     * that id, leaving the one under the pointer alone. */
    expect((stand as Tagged).layerId).toBe(layerId);
    expect((stand as Tagged).tileId).toBe(tile);
  });

  it("shows the frame for a layer picked in the list, with no tile picked", async () => {
    /* Reported as: I have to pick the tile *and* then the layer before the
     * frame and its ghost appear.
     *
     * They are two different things. Clicking a layer's row sets the pair
     * (id, tile) — which tile that layer was picked on — and deliberately
     * leaves the wall's tile selection alone. The frame asked the selection,
     * so it stayed away until the tile had been picked a second time. */
    const { canvas, tile, layerId } = await placing();
    // Exactly what the list leaves behind: a pair, and nothing picked on the
    // wall.
    app.selectedTiles = [];
    selectLayer(layerId, tile);
    await tick();

    await until(() =>
      canvas.getObjects().some((o) => (o as Tagged & { framing?: boolean }).framing),
    );
    const stand = canvas
      .getObjects()
      .find((o) => (o as Tagged & { framing?: boolean }).framing) as Tagged;
    expect(stand.layerId).toBe(layerId);
    expect(stand.tileId).toBe(tile);
  });

  it("moves the layer it stands for", async () => {
    const { canvas, stand, tile, layerId } = await placing();
    const before = findLayer(app.manifest.tiles[tile]!.layers, layerId)!;
    const from = { x: before.x, y: before.y };

    await dragObject(canvas, stand, 120, 90);
    await until(() => {
      const l = findLayer(app.manifest.tiles[tile]!.layers, layerId)!;
      return l.x !== from.x || l.y !== from.y;
    });

    const after = findLayer(app.manifest.tiles[tile]!.layers, layerId)!;
    /* Where the frame ended up, not where the hand pushed it: the wall pulls a
     * dragged edge onto its cell and onto the layer's neighbours, so the layer
     * is meant to land a few pixels off the raw gesture — 0.175 of the tile for
     * a drag of 0.192. What must hold is that the two agree, the picture under
     * the frame that was dragged, which is exactly what stopped being true when
     * the drag wrote a Frame record nothing read. */
    const cell = cellAt(visibleIds().indexOf(tile));
    const centre = stand.getCenterPoint();
    expect(after.x).toBeCloseTo((centre.x - cell.x) / TILE_W, 3);
    expect(after.y).toBeCloseTo((centre.y - cell.y) / TILE_H, 3);
    // And it travelled the way it was pushed, snapping or no snapping.
    expect(after.x - from.x).toBeGreaterThan(0.1);
    expect(after.y - from.y).toBeGreaterThan(0.08);
  });

  it("scales a shape by exactly what the frame was scaled by", async () => {
    /* Reported as the frame growing a little and the shape growing a lot. The
     * stand-in is built at the layer's own size, so the factor Fabric reports
     * is the factor the layer takes — anything else means the two are being
     * measured against different boxes. */
    const { canvas, stand, tile, layerId } = await placing();
    const before = { ...(findLayer(app.manifest.tiles[tile]!.layers, layerId)! as ShapeLayer) };

    canvas.fire("object:modified", {
      target: Object.assign(stand, { scaleX: 2, scaleY: 2 }) as fabric.Object,
    });
    await tick();
    await new Promise((r) => setTimeout(r, 200));

    const once = findLayer(app.manifest.tiles[tile]!.layers, layerId)! as ShapeLayer;
    expect(once.w).toBeCloseTo(before.w * 2, 4);
    expect(once.h).toBeCloseTo(before.h * 2, 4);

    /* The frame the write left behind stands for a document that has moved on,
     * so it is rebuilt from the layer rather than kept. It used to be built
     * once and never re-derived, which is what made "the frame grew a little
     * and the shape grew a lot" possible: the scale of the finished gesture sat
     * on it and was read again by the next one. Checked on the frame that is
     * actually there now, not on the detached one this test still holds. */
    await until(() => {
      const now = canvas
        .getObjects()
        .find((o) => (o as Tagged & { framing?: boolean }).framing) as fabric.Object | undefined;
      return !!now && now !== stand && (now.scaleX ?? 1) === 1;
    });
  });

  it("leaves the cell clickable while the frame is the handle", async () => {
    /* A baked layer is a tile-sized picture at the cell's origin, and it
     * answered the mouse across all of it: pressing anywhere in that cell
     * grabbed the bake rather than picking the tile, so tile selection and the
     * rubber band were dead in every cell carrying a mask or a class icon.
     * Its snap box is the cell too, so both axes had every stop at nought and
     * a nudge shorter than the snap distance came back to no movement at all.
     * The frame is the handle for these; the bake is not a second one. */
    const { canvas, layerId } = await placing();
    const bake = canvas
      .getObjects()
      .find((o) => (o as Tagged).layerId === layerId && "flattened" in o) as fabric.Object;
    expect(bake).toBeTruthy();
    await until(() => !bake.evented);
    expect(bake.selectable).toBe(false);

    // The frame is still there to grab.
    expect(
      canvas.getObjects().some((o) => (o as Tagged & { framing?: boolean }).framing),
    ).toBe(true);
  });

  it("takes the frame down when the layer is locked", async () => {
    /* The padlock's whole job is to put a layer out of reach, and the frame is
     * the one way to reach a baked one. It is built here and carries none of
     * the object's own flags, so locking a masked layer left its frame standing
     * and fully draggable — the lock looked like it had worked and had not. */
    const { canvas, tile, layerId } = await placing();
    const framing = () =>
      canvas.getObjects().some((o) => (o as Tagged & { framing?: boolean }).framing);
    expect(framing()).toBe(true);

    await toggleLayerLocked(layerId, tile);
    await until(() => !framing());

    await toggleLayerLocked(layerId, tile);
    await until(() => framing());
  });

  it("does not write a stale frame back over a panel edit", async () => {
    /* The frame is marked `keep`, so it survives every rebuild — and it was
     * built once and never re-derived. Type a Size into the panel and the layer
     * grows on the wall while the frame stays the size it was; nudge the frame
     * one pixel afterwards and the layer snaps back, because what a drop writes
     * is the frame's own box in absolute numbers. The panel edit was gone with
     * no undo step naming it. */
    const { canvas, stand, tile, layerId } = await placing();
    /* A window with a size. Mounted in a bare document the stage is one pixel
     * wide, the wall is drawn at almost no zoom, and the frame's corner handles
     * then cover its own middle — a press meant as a drag lands on a control
     * and scales instead of moving. */
    canvas.setDimensions({ width: 900, height: 700 });
    canvas.setViewportTransform([0.5, 0, 0, 0.5, 0, 0]);
    canvas.renderAll();
    await tick();
    const layer = () => findLayer(app.manifest.tiles[tile]!.layers, layerId)! as ShapeLayer;
    const grown = layer().w * 2;
    await setTileLayerField([tile], layerId, "w", grown);
    await until(() => layer().w === grown);

    // The frame that stands there now, which must be the new size's.
    const framing = () =>
      canvas.getObjects().find((o) => (o as Tagged & { framing?: boolean }).framing) as
        | fabric.Object
        | undefined;
    await until(() => !!framing() && framing() !== stand);
    const fresh = framing()!;
    const sxBefore = fresh.scaleX;
    await dragObject(canvas, fresh, 30, 0);
    await until(() => layer().x !== 0.5);

    expect(layer().w).toBeCloseTo(grown, 4);
  });

  it("takes the size from the handle a hand actually dragged", async () => {
    /* The same claim as the test above, made through Fabric's own transform
     * pipeline instead of a value assigned onto the stand-in.
     *
     * Worth the extra seconds because the shortcut skips the half of the story
     * the report was about: `_setupCurrentTransform`, the live `object:scaling`
     * work, and the rebuild that lands while the pointer is still down. A
     * gesture is also the only way to find out whether the handle exists at
     * all — `setControlsVisibility` decides that per kind, and a corner that
     * cannot be grabbed is a feature nobody has.
     *
     * Read off the stand-in after the fact on purpose: that object is the frame
     * the hand let go of, and the rebuild that follows leaves it detached with
     * the gesture's scale still on it. What must hold is that the layer ended
     * up the size that frame was — the thing the eye compares. */
    const { canvas, stand, tile, layerId } = await placing();
    const layer = () => findLayer(app.manifest.tiles[tile]!.layers, layerId)! as ShapeLayer;
    const before = { ...layer() };

    /* Measured off the frame as it is drawn, not in scene units: a handle is
     * grabbed where it appears, and this canvas is fitted to a test window that
     * has almost no width — a zoom near zero, where a flat 140 pixels is three
     * hundred tiles. dragObject takes scene units and converts; scaleObject
     * takes the canvas's own. Half again as wide is the gesture. */
    const zoom = canvas.getZoom();
    await scaleObject(
      canvas,
      stand,
      "br",
      (stand.getScaledWidth() * zoom) / 2,
      (stand.getScaledHeight() * zoom) / 2,
    );
    await until(() => layer().w !== before.w);

    // Copied, not held: findLayer hands back the live record, and a reference
    // compared against itself after the next gesture says nothing ever moved.
    const after = { ...layer() };
    expect(after.w).toBeCloseTo(((stand.width ?? 0) * (stand.scaleX ?? 1)) / TILE_W, 3);
    expect(after.h).toBeCloseTo(((stand.height ?? 0) * (stand.scaleY ?? 1)) / TILE_H, 3);
    // Pulled outwards, so it grew: a sign error would satisfy the two above.
    expect(after.w).toBeGreaterThan(before.w * 1.1);

    /* And moving it afterwards leaves the size alone. The stand-in the rebuild
     * put up is a fresh rectangle at scale 1, and the drag that follows must
     * write that size back unchanged — "the shape grew every time it was
     * touched" is what it looks like when a factor outlives its gesture. */
    const frame = canvas
      .getObjects()
      .find((o) => (o as Tagged & { framing?: boolean }).framing) as fabric.Object;
    await dragObject(canvas, frame, 120, 90);
    await until(() => layer().x !== after.x);
    expect(layer().w).toBeCloseTo(after.w, 4);
    expect(layer().h).toBeCloseTo(after.h, 4);
  });

  it("will not let a gesture scale a layer down to nothing", async () => {
    /* Seen happening: a shape left at Width 0, Height 0, gone from the wall
     * with its row still in the list.
     *
     * A shape's size is multiplied by whatever Fabric scaled, so a run of tiny
     * factors walks it towards nothing and no later gesture brings it back —
     * the panel reads 0 because it rounds, and the layer is a point on the
     * wall. Exactly nought is already caught (`patch.fx || 1`), which is why
     * this uses a factor that is small rather than zero: that is the one that
     * got through. The stand-in makes it easy to reach, being transparent —
     * there is nothing to watch disappearing as the handle crosses the far
     * side. */
    const { canvas, stand, tile, layerId } = await placing();
    const before = findLayer(app.manifest.tiles[tile]!.layers, layerId)! as ShapeLayer;
    expect(before.w).toBeGreaterThan(0);

    // What a corner handle dragged almost onto the opposite corner reports.
    canvas.fire("object:modified", {
      target: Object.assign(stand, { scaleX: 0.001, scaleY: 0.001 }) as fabric.Object,
    });
    await tick();
    await new Promise((r) => setTimeout(r, 150));

    const after = findLayer(app.manifest.tiles[tile]!.layers, layerId)! as ShapeLayer;
    expect(after.w).toBeGreaterThan(0);
    expect(after.h).toBeGreaterThan(0);
    // And still grabbable: a hundredth of a tile is about six pixels across a
    // portrait, small but not a point.
    expect(after.w).toBeGreaterThanOrEqual(0.01);
  });

  it("leaves no per-tile frame record behind", async () => {
    const { canvas, stand, tile } = await placing();
    await dragObject(canvas, stand, 60, 40);
    /* The whole point of the rewiring: the placement is on the layer, and
     * nothing grows a second copy of it beside the tile. */
    expect((app.manifest.tiles[tile] as unknown as { frame?: unknown }).frame).toBeUndefined();
  });
});

describe("carrying one layer's properties to another", () => {
  /* Photoshop's Copy/Paste Layer Style, which is where the idea came from.
   * Widened on purpose: there the placement stays behind, and here it is most
   * of the point — two captions on two portraits in exactly the same spot at
   * exactly the same size is what cannot be done by eye across forty-four
   * tiles. */
  const twoShapes = async () => {
    await enterInbox();
    const [a, b] = app.folderIds;
    for (const t of [a, b]) {
      app.selectedTiles = [t];
      await addTileShape("rect");
    }
    return [
      { tile: a, layer: tileLayers(a).at(-1)! as ShapeLayer },
      { tile: b, layer: tileLayers(b).at(-1)! as ShapeLayer },
    ] as const;
  };

  it("makes the target a twin, without taking its identity", async () => {
    const [from, to] = await twoShapes();
    Object.assign(from.layer, { x: 0.2, y: 0.3, w: 0.4, opacity: 0.5, fill: "#ff0000" });
    const wasCalled = to.layer.id;

    copyLayerProps(from.layer.id, from.tile);
    await pasteLayerProps(to.layer.id, to.tile);

    const now = findLayer(tileLayers(to.tile), wasCalled) as ShapeLayer;
    expect(now.x).toBeCloseTo(0.2, 5);
    expect(now.w).toBeCloseTo(0.4, 5);
    expect(now.opacity).toBeCloseTo(0.5, 5);
    expect(now.fill).toBe("#ff0000");
    // Its own, both of them: an id it shares with the source is the one shape
    // the wall cannot hold, and the layer stayed on its own tile.
    expect(now.id).toBe(wasCalled);
    expect(findLayer(tileLayers(from.tile), from.layer.id)).toBeTruthy();
  });

  it("clears a field the source does not have", async () => {
    /* The half-copy: the target keeps its old shadow, takes the source's
     * colour, and comes out looking like neither. Nothing on screen would say
     * why, which is what makes it worth a test of its own. */
    const [from, to] = await twoShapes();
    to.layer.shadow = 0.05;
    to.layer.shadowColor = "#000000";

    copyLayerProps(from.layer.id, from.tile);
    await pasteLayerProps(to.layer.id, to.tile);

    const now = findLayer(tileLayers(to.tile), to.layer.id)!;
    expect(now.shadow).toBeUndefined();
    expect(now.shadowColor).toBeUndefined();
  });

  it("carries only the placement between two kinds, and leaves the wording", async () => {
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("rect");
    const shape = tileLayers(tile).at(-1)! as ShapeLayer;
    shape.x = 0.25;
    shape.opacity = 0.4;
    await addTileText();
    const caption = tileLayers(tile).at(-1)! as TextLayer;
    caption.text = "{{id}}";
    const size = caption.size;

    copyLayerProps(shape.id, tile);
    await pasteLayerProps(caption.id, tile);

    const now = findLayer(tileLayers(tile), caption.id) as TextLayer;
    expect(now.x).toBeCloseTo(0.25, 5);
    expect(now.opacity).toBeCloseTo(0.4, 5);
    // A shape has no wording and no font size to hand over, and a caption that
    // took the shape's kind-specific fields would be undrawable.
    expect(now.text).toBe("{{id}}");
    expect(now.size).toBe(size);
    expect((now as unknown as Record<string, unknown>).w).toBeUndefined();
  });

  it("leaves what you are doing alone: hidden and locked stay put", async () => {
    const [from, to] = await twoShapes();
    from.layer.hidden = true;
    from.layer.locked = true;

    copyLayerProps(from.layer.id, from.tile);
    await pasteLayerProps(to.layer.id, to.tile);

    const now = findLayer(tileLayers(to.tile), to.layer.id)!;
    expect(now.hidden).toBeFalsy();
    expect(now.locked).toBeFalsy();
  });

  it("puts the copied layer on every picked tile under one id", async () => {
    /* The whole point of the action: one id across the selection is what makes
     * a later drag move all of them, so this checks the id and then checks
     * that the wall agrees by asking bulkTargets, which is what the drag
     * actually consults. */
    await enterInbox();
    const [a, b, c] = app.folderIds;
    app.selectedTiles = [a];
    await addTileShape("rect");
    const src = tileLayers(a).at(-1)! as ShapeLayer;
    src.fill = "#00ff88";

    copyLayerProps(src.id, a);
    app.selectedTiles = [a, b, c];
    await pasteLayerOntoTiles();

    for (const t of [b, c]) {
      const got = findLayer(tileLayers(t), src.id) as ShapeLayer;
      expect(got).toBeTruthy();
      expect(got.fill).toBe("#00ff88");
    }
    expect(bulkTargets(src.id).sort()).toEqual([a, b, c].sort());
  });

  it("leaves a tile its own wording and takes everything else", async () => {
    /* The decision this action turns on. Captions typed one at a time are
     * worth keeping; it is their placement and look that should stop being one
     * decision per tile. A tile with no such layer has nothing of its own to
     * keep and gets the whole thing, wording included. */
    await enterInbox();
    const [a, b, c] = app.folderIds;
    for (const t of [a, b]) {
      app.selectedTiles = [t];
      await addTileText();
    }
    const src = tileLayers(a).at(-1)! as TextLayer;
    const mine = tileLayers(b).at(-1)! as TextLayer;
    src.text = "Alpha";
    src.x = 0.2;
    src.size = 0.09;
    mine.id = src.id;
    mine.text = "Beta";
    mine.x = 0.8;

    copyLayerProps(src.id, a);
    app.selectedTiles = [b, c];
    await pasteLayerOntoTiles();

    const onB = findLayer(tileLayers(b), src.id) as TextLayer;
    expect(onB.text).toBe("Beta");
    expect(onB.x).toBeCloseTo(0.2, 5);
    expect(onB.size).toBeCloseTo(0.09, 5);
    // Nothing of its own to keep, so it takes the wording too.
    expect((findLayer(tileLayers(c), src.id) as TextLayer).text).toBe("Alpha");
  });

  it("takes one layer off the picked tiles and leaves the rest standing", async () => {
    await enterInbox();
    const [a, b, c] = app.folderIds;
    app.selectedTiles = [a, b, c];
    await addTileShape("rect");
    await addTileText();
    const shape = tileLayers(a).at(-2)!;
    const caption = tileLayers(a).at(-1)!;

    // Only two of the three, so the third proves the reach is the selection.
    app.selectedTiles = [a, b];
    const steps = historySteps().length;
    await removeLayerFromSelection(caption.id);

    for (const t of [a, b]) {
      expect(findLayer(tileLayers(t), caption.id)).toBeUndefined();
      expect(findLayer(tileLayers(t), shape.id)).toBeTruthy();
    }
    expect(findLayer(tileLayers(c), caption.id)).toBeTruthy();
    expect(historySteps().length).toBe(steps + 1);
  });

  it("lists what is on the selection, with how far a removal would reach", async () => {
    await enterInbox();
    const [a, b, c] = app.folderIds;
    app.selectedTiles = [a, b, c];
    await addTileShape("rect");
    app.selectedTiles = [a];
    await addTileText();

    app.selectedTiles = [a, b, c];
    const listed = layersOnSelection();
    expect(listed).toHaveLength(2);
    // Widest reach first, so the blunt instrument is not the one you have to
    // hunt for.
    expect(listed[0].tiles).toBe(3);
    expect(listed[1].tiles).toBe(1);
  });

  it("switches a layer off across the selection, whatever each tile said before", async () => {
    /* Set outright, not flipped per tile. With the flag disagreeing between
     * tiles a toggle hides half and shows half, which reads as a bug whichever
     * way it was meant — so the menu asks for a direction and gets one. */
    await enterInbox();
    const [a, b, c] = app.folderIds;
    app.selectedTiles = [a, b, c];
    await addTileShape("rect");
    const id = tileLayers(a).at(-1)!.id;
    findLayer(tileLayers(b), id)!.hidden = true;

    app.selectedTiles = [a, b];
    await setLayerHiddenOnSelection(id, true);
    expect(findLayer(tileLayers(a), id)!.hidden).toBe(true);
    expect(findLayer(tileLayers(b), id)!.hidden).toBe(true);
    // Not picked, not touched.
    expect(findLayer(tileLayers(c), id)!.hidden).toBeFalsy();

    await setLayerHiddenOnSelection(id, false);
    expect(findLayer(tileLayers(a), id)!.hidden).toBeFalsy();
    expect(findLayer(tileLayers(b), id)!.hidden).toBeFalsy();
  });

  it("locks and unlocks across the selection in one step each", async () => {
    await enterInbox();
    const [a, b] = app.folderIds;
    app.selectedTiles = [a, b];
    await addTileShape("rect");
    const id = tileLayers(a).at(-1)!.id;

    const steps = historySteps().length;
    await setLayerLockedOnSelection(id, true);
    for (const t of [a, b]) expect(findLayer(tileLayers(t), id)!.locked).toBe(true);
    expect(historySteps().length).toBe(steps + 1);

    await setLayerLockedOnSelection(id, false);
    for (const t of [a, b]) expect(findLayer(tileLayers(t), id)!.locked).toBeFalsy();
  });

  it("renames the layer on the row's own tile", async () => {
    /* The third caller of the (id, tile) pair, and it resolved through
     * anyLayer, which answers for the selected tile alone — so a rename typed
     * on an unselected row wrote nothing at all. */
    await enterInbox();
    const [a, b] = app.folderIds;
    app.selectedTiles = [a, b];
    await addTileShape("rect");
    const id = tileLayers(a).at(-1)!.id;
    selectLayer("", "");

    await renameLayer(id, "Frame", b);
    expect(findLayer(tileLayers(b), id)!.name).toBe("Frame");
    expect(findLayer(tileLayers(a), id)!.name).not.toBe("Frame");
  });

  it("carries a whole group to other tiles, members and all", async () => {
    /* A group copied onto a tile has to arrive with what is in it, and each
     * member with its own look — otherwise "copy this arrangement to those
     * portraits" means rebuilding it by hand on each one.
     *
     * It falls out of the two rules already in place rather than needing a
     * third: the clipboard holds a deep copy, so a group brings its children;
     * and a tile that has no layer of that id gets the whole thing. The ids
     * come with it, which is what makes the copies one layer across the wall
     * from then on — drag one, they all move. */
    await enterInbox();
    const [a, b] = app.folderIds;
    app.selectedTiles = [a];
    await addTileShape("rect");
    const one = tileLayers(a).at(-1)!;
    await setTileLayerField([a], one.id, "fill", "#00ff88");
    await addTileShape("ellipse");
    const two = tileLayers(a).at(-1)!;
    await setTileLayerField([a], two.id, "x", 0.8);
    selectLayer(one.id, a);
    alsoSelect(two.id, a);
    await groupPicked();
    const group = tileLayers(a).find((l) => l.kind === "group")!;

    copyLayerProps(group.id, a);
    app.selectedTiles = [b];
    await pasteLayerOntoTiles();

    const landed = tileLayers(b).find((l) => l.id === group.id);
    expect(landed?.kind).toBe("group");
    // Both members, under their own ids, with what they looked like.
    const onB = (id: string) => findLayer(tileLayers(b), id) as ShapeLayer | undefined;
    expect(onB(one.id)?.fill).toBe("#00ff88");
    expect(onB(two.id)?.x).toBeCloseTo(0.8, 6);
    // One layer across two tiles now: a drag on the group reaches both.
    app.selectedTiles = [a, b];
    expect(bulkTargets(group.id).sort()).toEqual([a, b].sort());
  });

  it("leaves each tile's own wording inside a pasted group", async () => {
    /* The contract this paste is written to: a tile already carrying the layer
     * keeps what its copy *says* and takes everything else. It held for a
     * loose caption and not for one inside a group — the group's members were
     * replaced wholesale, so a nameplate group carried across forty-four
     * portraits gave every one of them the first tile's name. Worse than it
     * sounds: a caption inside a group has no per-tile text field in the row,
     * so there is nothing on screen to notice it with, and one undo is the
     * only way back. */
    await enterInbox();
    const [a, b] = app.folderIds;
    app.selectedTiles = [a];
    await addTileShape("rect");
    const plate = tileLayers(a).at(-1)!;
    await addTileText();
    const caption = tileLayers(a).at(-1)!;
    selectLayer(plate.id, a);
    alsoSelect(caption.id, a);
    await groupPicked();
    const group = tileLayers(a).find((l) => l.kind === "group")!;

    // The arrangement is carried to the second portrait, whole.
    copyLayerProps(group.id, a);
    app.selectedTiles = [b];
    await pasteLayerOntoTiles();
    expect(findLayer(tileLayers(b), group.id)).toBeTruthy();

    // Then each portrait is named by hand — the work being protected here.
    await setTileLayerField([a], caption.id, "text", "Aria");
    await setTileLayerField([b], caption.id, "text", "Bern");
    // And the look is changed on the first one, and carried again.
    await setTileLayerField([a], plate.id, "fill", "#00ff88");

    copyLayerProps(group.id, a);
    app.selectedTiles = [b];
    await pasteLayerOntoTiles();

    const on = (tile: string, id: string) => findLayer(tileLayers(tile), id)!;
    // The look travelled; the name stayed.
    expect((on(b, plate.id) as ShapeLayer).fill).toBe("#00ff88");
    expect((on(b, caption.id) as TextLayer).text).toBe("Bern");
    expect((on(a, caption.id) as TextLayer).text).toBe("Aria");
  });

  it("refuses to put two layers of one name on the same tile", async () => {
    /* Found by hand: a row of tiles was given an ellipse, then a group holding
     * a copy of that same ellipse was pasted onto one of them. The tile ended
     * up with the id twice — once inside the group, once beside it — and every
     * lookup in this app finds a layer by id and takes the first hit. So the
     * eye and the lock clicked on the row inside the group went to the layer
     * outside it.
     *
     * The invariant is "an id is unique within a tile", and the paste is the
     * one thing that could break it. It skips such a tile and says so. */
    await enterInbox();
    const [a, b] = app.folderIds;
    app.selectedTiles = [a];
    await addTileShape("ellipse");
    const shared = tileLayers(a).at(-1)!;
    await addTileShape("rect");
    const other = tileLayers(a).at(-1)!;
    selectLayer(shared.id, a);
    alsoSelect(other.id, a);
    await groupPicked();
    const group = tileLayers(a).find((l) => l.kind === "group")!;

    // The second tile already carries the same ellipse, loose.
    app.selectedTiles = [b];
    copyLayerProps(shared.id, a);
    await pasteLayerOntoTiles();
    expect(findLayer(tileLayers(b), shared.id)).toBeTruthy();

    // Now the group, whose member would be that id a second time.
    copyLayerProps(group.id, a);
    app.selectedTiles = [b];
    await pasteLayerOntoTiles();

    expect(tileLayers(b).some((l) => l.kind === "group")).toBe(false);
    expect([...walkLayers(tileLayers(b))].filter((l) => l.id === shared.id)).toHaveLength(1);
    expect(app.error).toContain("skipped");
  });

  it("still opens the row of a tile that already carries an id twice", async () => {
    /* Documents written before the guard have such tiles: a loose layer and a
     * group holding a copy of it, one id twice. The guard stops new ones being
     * made and does nothing for those, and the report is that the tile's row
     * will not open at all — so the state has to be survivable, not merely
     * unreachable. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("ellipse");
    const loose = tileLayers(tile).at(-1)!;
    // What the old paste left behind: the same id again, inside a group.
    const twin = { ...clone(loose), id: loose.id };
    app.manifest.tiles[tile].layers.push(newGroupLayer([twin]));
    app.version++;
    await tick();

    reveal("tiles");
    reveal(tile);
    await tick();
    await new Promise((r) => setTimeout(r, 200));

    /* Both rows, drawn. The old assertion counted every `button.name` under the
     * tile — which includes the tile's own — so it was satisfied by the header
     * alone and passed while the list below it drew nothing at all. Svelte threw
     * on the repeated key instead of drawing, exactly as reported, and the test
     * written for that report could not see it. */
    const under = (sel: string) => document.querySelectorAll(`[data-tile="${tile}"] ${sel}`).length;
    // Both stacked rows, and — the half that used to throw — a colour gallery
    // for each of the two shapes the tile carries under the one id.
    expect(under("ul.indent > li")).toBe(2);
    expect(under("p.sub")).toBe(2);
    expect(under(".gallery")).toBe(2);
  });

  it("says nothing when the tiles already carry that very group", async () => {
    /* The other half of the guard above, and the one that must stay quiet. A
     * tile holding the same group is not a collision — it is the same layer,
     * and writing over it is the whole point of pasting onto tiles that have
     * it. The ids inside it are its own, so nothing is being duplicated.
     *
     * Pinned because the two cases look alike from outside and only one of
     * them should warn: a warning on this one would train the eye to ignore
     * the other. */
    await enterInbox();
    const [a, b, c] = app.folderIds;
    app.selectedTiles = [a];
    await addTileShape("rect");
    const one = tileLayers(a).at(-1)!;
    await addTileShape("ellipse");
    const two = tileLayers(a).at(-1)!;
    selectLayer(one.id, a);
    alsoSelect(two.id, a);
    await groupPicked();
    const group = tileLayers(a).find((l) => l.kind === "group")!;

    // Both tiles get the group first.
    copyLayerProps(group.id, a);
    app.selectedTiles = [b, c];
    await pasteLayerOntoTiles();
    expect(app.error).toBe("");
    for (const t of [b, c]) expect(findLayer(tileLayers(t), group.id)).toBeTruthy();

    // Change it on the source, then paste again onto the same two.
    await setTileLayerField([a], one.id, "fill", "#123456");
    copyLayerProps(group.id, a);
    app.selectedTiles = [b, c];
    await pasteLayerOntoTiles();

    expect(app.error).toBe("");
    for (const t of [b, c]) {
      // Once, not twice, and the member took the change.
      expect([...walkLayers(tileLayers(t))].filter((l) => l.id === group.id)).toHaveLength(1);
      expect((findLayer(tileLayers(t), one.id) as ShapeLayer).fill).toBe("#123456");
    }
  });

  it("opens the menu on the row and pastes through it", async () => {
    const [from, to] = await twoShapes();
    from.layer.x = 0.15;
    app.version++;
    reveal("tiles");
    await tick();

    const open = async (tile: string) => {
      const row = document.querySelector(`[data-tile="${tile}"]`) as HTMLElement;
      (row.querySelector("button.twisty") as HTMLButtonElement).click();
      // The rows are created by the click, not before it.
      await tick();
      return row;
    };
    const item = (text: string) =>
      [...document.querySelectorAll("button")].find((b) =>
        b.textContent!.trim().startsWith(text),
      ) as HTMLButtonElement;

    (await open(from.tile)).querySelector("li")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
    );
    await tick();
    item("Copy properties").click();
    await tick();

    (await open(to.tile)).querySelector("li")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
    );
    await tick();
    // Named, not just "Paste": the menu says what would land.
    expect(item("Paste from")).toBeTruthy();
    item("Paste from").click();

    await until(() => findLayer(tileLayers(to.tile), to.layer.id)!.x === 0.15);
  });
});

describe("the layer panel", () => {
  /* It was imported and never rendered. Master put it inside the Layout editor
   * and nowhere else, so taking that editor out took the only way to a layer's
   * font, colour, shadow, corners, grading and mask with it — on a build whose
   * whole point is that every asset is a layer you can edit. Nothing failed:
   * the fields were simply not on the screen, which no test could see because
   * none of them looked. */
  async function pickedShape() {
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("rect");
    const layer = tileLayers(tile).at(-1)!;
    selectLayer(layer.id, tile);
    await tick();
    return { tile, layer };
  }

  const headings = () =>
    [...document.querySelectorAll("aside h2")].map((h) => h.textContent!.trim());

  const field = (name: string) =>
    [...document.querySelectorAll("aside label.field")].find(
      (l) => l.querySelector("span")?.textContent!.trim() === name,
    );

  it("shows the picked layer's fields, and nothing when nothing is picked", async () => {
    const { layer } = await pickedShape();
    expect(headings()).toContain(layerLabel(layer));
    expect(field("Fill")).toBeTruthy();

    selectLayer("", "");
    await tick();
    expect(headings()).not.toContain(layerLabel(layer));
  });

  it("offers a layer on the same tile as a mask", async () => {
    /* The control was gated on being inside a Layout, which was where shapes
     * and pictures used to share a stack. A tile is that stack now — the
     * component's own siblings/maskOffers already read off the tile — so the
     * gate was the last thing keeping masking off the wall. */
    const { tile } = await pickedShape();
    app.selectedTiles = [tile];
    await addTileText();
    const cutter = tileLayers(tile).at(-1)!;
    const shape = tileLayers(tile).find((l) => l.kind === "shape")!;
    selectLayer(shape.id, tile);
    await tick();

    const mask = field("Mask")!;
    expect(mask).toBeTruthy();
    const offered = [...mask.querySelectorAll("option")].map((o) => o.textContent!.trim());
    expect(offered).toContain(layerLabel(cutter));
  });

  it("keeps a cutter on the canvas, invisible, so it can still be grabbed", async () => {
    /* A layer that is cutting another one draws nothing, and used to have no
     * object at all — so there was nothing on the wall to click and the placing
     * tool's stand-in was the only handle a mask had. Asked here as two things
     * at once, because either alone is satisfied by the old behaviour: there is
     * an object for it, and that object paints nothing. */
    const { tile } = await pickedShape();
    const cutter = tileLayers(tile).at(-1)!;
    app.selectedTiles = [tile];
    await addTileShape("ellipse");
    const cutLayer = tileLayers(tile).at(-1)!;
    await setTileLayerField([tile], cutLayer.id, "maskId", cutter.id);
    await tick();

    const canvas = (window as { tesseraWall?: fabric.Canvas }).tesseraWall!;
    await until(() =>
      canvas.getObjects().some((o) => (o as Tagged).layerId === cutter.id),
    );
    const obj = canvas.getObjects().find((o) => (o as Tagged).layerId === cutter.id)!;
    expect(obj.opacity).toBe(0);
    // And the layer it cuts is still baked, which is what made the cutter
    // undrawable in the first place.
    const cutObj = canvas.getObjects().find((o) => (o as Tagged).layerId === cutLayer.id);
    expect((cutObj as Tagged & { flattened?: boolean }).flattened).toBe(true);
  });

  it("re-cuts the picture when the mask under it is moved", async () => {
    /* Seen in a clip: the mask's frame moved to the other end of the tile and
     * the cut-out picture stayed exactly where it was, until anything else
     * happened to redraw the tile.
     *
     * A plain move skips the rebuild because the object the hand moved is the
     * layer and the canvas already shows the result. A cutter breaks that
     * premise: what changes on screen is the *other* layer's pixels, and those
     * are baked. Asked of the canvas — the bake has to be a new object —
     * because the model was never the part that was wrong. */
    const { tile } = await pickedShape();
    const cutter = tileLayers(tile).at(-1)!;
    app.selectedTiles = [tile];
    await addTileShape("ellipse");
    const cutLayer = tileLayers(tile).at(-1)!;
    await setTileLayerField([tile], cutLayer.id, "maskId", cutter.id);
    await tick();

    const canvas = (window as { tesseraWall?: fabric.Canvas }).tesseraWall!;
    const bake = () => canvas.getObjects().find((o) => (o as Tagged).layerId === cutLayer.id);
    await until(() => !!bake());
    let held = bake();
    let steady = 0;
    await until(() => {
      const now = bake();
      steady = now && now === held ? steady + 1 : 0;
      held = now;
      return steady >= 8;
    });
    const was = held!;

    const stencil = canvas.getObjects().find((o) => (o as Tagged).layerId === cutter.id)!;
    stencil.set({ left: (stencil.left ?? 0) + 90 });
    stencil.setCoords();
    canvas.fire("object:modified", { target: stencil });

    // A new object for the cut layer: the bake was made again, with the mask
    // where it now is.
    await until(() => !!bake() && bake() !== was, 3000);
    expect(bake()).toBeTruthy();
    expect(bake()).not.toBe(was);
  });

  it("writes a field onto every picked tile in one step", async () => {
    const { tile, layer } = await pickedShape();
    const second = app.folderIds[1];
    app.selectedTiles = [tile, second];
    await addTileShape("rect");
    const onBoth = tileLayers(tile).at(-1)!;
    selectLayer(onBoth.id, tile);
    await tick();

    const before = historySteps().length;
    await setTileLayerField([tile, second], onBoth.id, "fill", "#22cc55");
    const here = findLayer(app.manifest.tiles[tile]!.layers, onBoth.id) as ShapeLayer;
    const there = findLayer(app.manifest.tiles[second]!.layers, onBoth.id) as ShapeLayer;
    expect(here.fill).toBe("#22cc55");
    expect(there.fill).toBe("#22cc55");
    // One step, not two: the panel is a bulk editor and undo has to match.
    expect(historySteps().length).toBe(before + 1);
    void layer;
  });
});

describe("what the wall lost with the layout editor", () => {
  /* Rebuilt from the list of tests the demolition removed. Most of that list
   * described stamps and assignments and went with them; these are the ones
   * whose behaviour survived the move onto the tiles, so losing their cover
   * was an accident rather than a consequence. */

  it("adds a layer to every picked tile under one id", async () => {
    /* One id across the wall is what makes a bulk edit possible at all: the
     * panel, the row and a drag all find the layer on each tile by the id of
     * the one that was picked. Insert them under separate ids and every edit
     * silently reaches one tile. */
    await enterInbox();
    const [a, b] = app.folderIds;
    app.selectedTiles = [a, b];
    await addTileText();

    const here = tileLayers(a).at(-1)!;
    const there = tileLayers(b).at(-1)!;
    expect(there.id).toBe(here.id);
    expect(historySteps().at(-1)?.label).toBe("Add caption");
  });

  it("keeps a tile archived when its layers are cleared", async () => {
    /* Clearing used to hand the tile back a fresh empty one, which took the
     * archived flag with it and put the portrait back on the wall — the whole
     * reason stripTile names the fields it clears instead of rebuilding. */
    await enterInbox();
    const [id] = app.folderIds;
    app.selectedTiles = [id];
    await addTileShape("rect");
    await archiveSelection(true);
    expect(archived()).toContain(id);

    app.selectedTiles = [id];
    await stripSelectedTiles();
    expect(tileLayers(id)).toHaveLength(0);
    expect(archived()).toContain(id);
  });

  it("leads with what the tile says, and treats the shared placeholder as no name", async () => {
    /* The headline reads the caption's own words. It used to ask the tile's
     * wording record — where a Layout's shared caption kept each portrait's
     * name — and the migration empties that, so every row had quietly fallen
     * back to its id. */
    await enterInbox();
    const [id] = app.folderIds;
    app.selectedTiles = [id];
    await addTileText();
    const caption = tileLayers(id).at(-1)!;

    // A caption every tile shares names none of them.
    await setTileLayerField([id], caption.id, "text", "{{id}}");
    expect(tileHeadline(id)).toBe("");

    await setTileLayerField([id], caption.id, "text", "Nachtklinge");
    expect(tileHeadline(id)).toBe("Nachtklinge");
  });

  it("names the step the undo button is about to take back", async () => {
    /* Ctrl+Z on a wall of forty-four portraits can reach anywhere, and every
     * other edit says what it touched by touching it. This one has to say so
     * in words before it is pressed. */
    await enterInbox();
    const [id] = app.folderIds;
    app.selectedTiles = [id];
    await addTileShape("rect");
    expect(undoLabel()).toBe("Add shape");

    await undoEdit();
    expect(redoLabel()).toBe("Add shape");
  });

  it("keeps one gesture to one undo step", async () => {
    /* A slider is a burst of writes. Each one landing in the history would
     * make Ctrl+Z walk back through a drag a pixel at a time — so a run key
     * folds them, and a different field starts a new step. */
    await enterInbox();
    const [id] = app.folderIds;
    app.selectedTiles = [id];
    await addTileShape("rect");
    const shape = tileLayers(id).at(-1)!;
    const steps = historySteps().length;

    for (const o of [0.9, 0.8, 0.7]) await setTileLayerField([id], shape.id, "opacity", o);
    expect(historySteps().length).toBe(steps + 1);

    await setTileLayerField([id], shape.id, "fill", "#123456");
    expect(historySteps().length).toBe(steps + 2);
  });

  it("opens the class grid for that tile, from its row", async () => {
    /* The sheet is App's — one of them serves the whole window — so the row
     * asks for it rather than owning one. The pair it hands over is what
     * decides whether the pick writes this tile's layer or a wall-wide one,
     * and it used to write a per-tile record that nothing read. */
    await enterInbox();
    const [id] = app.folderIds;
    app.selectedTiles = [id];
    await addTileShape("icon", "Ranger");
    await tick();

    const badge = [...document.querySelectorAll("button.swatch.art")].at(-1) as HTMLButtonElement;
    expect(badge).toBeTruthy();
    badge.click();
    await tick();

    const witch = [...document.querySelectorAll("button")].find(
      (b) => b.title === "Witch",
    ) as HTMLButtonElement;
    expect(witch).toBeTruthy();
    witch.click();
    await until(() => (tileIcons(id)[0]?.icon ?? "") === "Witch");
    expect(undoLabel()).toBe("Change icon");
  });
});

describe("a new project's order", () => {
  it("keeps the order the tiles were clicked in", async () => {
    /* The wall's order is the in-game order and is handwork — see the note on
     * placeTile. So a project built from a selection has to keep the order the
     * hand put them in, not sort them back into the order the folder lists
     * them. Ctrl-click appends, and this is what says so. */
    await enterInbox();
    const [a, b, c] = app.folderIds;
    toggleTile(c, {});
    toggleTile(a, { ctrl: true });
    toggleTile(b, { ctrl: true });
    expect(app.selectedTiles).toEqual([c, a, b]);

    await newProjectFrom("Konto");
    expect(projects()[0].order).toEqual([c, a, b]);
  });
});

describe("what the status line says", () => {
  it("keeps a failure and a success apart, newest wins", async () => {
    /* One field carried both, so "44 tile(s) written" and "Saving failed" were
     * the same sentence in the same place in the same colour — and a standing
     * failure sat over the success that followed it until something cleared it.
     * Two fields, and each setter drops the other. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];

    fail("it went wrong");
    expect(app.error).toBe("it went wrong");
    expect(app.note).toBe("");

    say("it went right");
    expect(app.note).toBe("it went right");
    expect(app.error).toBe("");

    fail("wrong again");
    expect(app.error).toBe("wrong again");
    expect(app.note).toBe("");

    // Picking something up is moving on: the line goes quiet, both halves of it.
    toggleTile(tile, {});
    expect(app.error).toBe("");
    expect(app.note).toBe("");
  });

  it("marks a failure and leaves a note plain", async () => {
    await enterInbox();
    reveal("tiles");
    const line = () => document.querySelector(".status")!;
    fail("a red thing");
    await until(() => !!line().querySelector(".bad"));
    expect(line().querySelector(".bad")!.textContent).toContain("a red thing");

    say("a plain thing");
    await until(() => !line().querySelector(".bad"));
    expect(line().textContent).toContain("a plain thing");
  });
});

describe("reaching the whole selection", () => {
  it("gives every picked tile's picture its edges back", async () => {
    /* Reset crop was the odd one out: the panel's heading says how many tiles
     * it writes to, and this button gave one picture back its edges while the
     * other forty-three kept the trim. */
    await enterInbox();
    const [a, b] = app.folderIds;
    app.selectedTiles = [a, b];
    // Placed by hand rather than through the file picker: what is under test is
    // the reach of the button, not how a picture gets onto a tile.
    const id = "pic";
    for (const tile of [a, b]) {
      const l = newImageLayer("block:#00ff88");
      l.id = id;
      l.crop = { l: 0.1, r: 0.1, t: 0.1, b: 0.1 };
      app.manifest.tiles[tile].layers.push(l);
    }
    app.version++;
    await tick();
    const on = (tile: string) =>
      findLayer(app.manifest.tiles[tile]!.layers, id) as unknown as { crop?: unknown };
    expect(on(a).crop).toBeTruthy();
    expect(on(b).crop).toBeTruthy();

    selectLayer(id, a);
    await resetCrop(id);

    expect(on(a).crop).toBeUndefined();
    expect(on(b).crop).toBeUndefined();
    // One step back, not two: the pair went in a single write.
    await undoEdit();
    expect(on(a).crop).toBeTruthy();
    expect(on(b).crop).toBeTruthy();
  });

  it("puts a picture back where its own pixels were", async () => {
    /* Reported: trim the right edge, press Reset crop, and the picture jumps
     * left by half of what was trimmed — up when the bottom had been pulled in,
     * and so on round. Trimming holds the far edge still, so the window's
     * centre moves; the model's sum is tested next to `uncrop`, and this is the
     * path through the panel, where the picture's own proportions have to be
     * measured before the sum can be done at all. The test asset is square. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    // Imported through the picker, so the picture is a real file the panel can
    // measure — which is the half of this that a hand-made layer cannot test.
    queuePick(await magentaSquare("square"));
    await addTileImage();
    const layer = tileLayers(tile).at(-1)!;
    const id = layer.id;
    const trimmed = findLayer(app.manifest.tiles[tile]!.layers, id) as unknown as {
      scale: number;
      x: number;
      y: number;
      crop?: unknown;
    };
    trimmed.scale = 0.5;
    // A fifth off the top: the window's centre sits that much lower. The
    // picture is square, so its full height is 0.5 * 624 / 804 of a tile.
    const tall = (0.5 * TILE_W) / TILE_H;
    trimmed.crop = { l: 0, r: 0, t: 0.2, b: 0 };
    trimmed.x = 0.5;
    trimmed.y = 0.5 + 0.1 * tall;
    app.version++;
    selectLayer(id, tile);
    await tick();

    await resetCrop(id);

    const after = findLayer(app.manifest.tiles[tile]!.layers, id) as unknown as {
      x: number;
      y: number;
      crop?: unknown;
    };
    expect(after.crop).toBeUndefined();
    expect(after.y).toBeCloseTo(0.5, 5);
    expect(after.x).toBeCloseTo(0.5, 5);
  });

  it("picks a class for every picked tile", async () => {
    /* The other button that reached one tile from a panel whose heading says
     * how many it writes to. Driven through the sheet, because the reach is
     * decided where the icon is clicked. */
    await enterInbox();
    const [a, b] = app.folderIds;
    app.selectedTiles = [a, b];
    await addTileShape("icon", "Ranger");
    const id = tileLayers(a).at(-1)!.id;
    selectLayer(id, a);
    reveal("props");
    await tick();

    // The Class row's button carries the class in force, "Ranger" here.
    const button = [...document.querySelectorAll<HTMLButtonElement>("aside button.wide")].find(
      (x) => x.closest("label")?.querySelector("span")?.textContent === "Class",
    );
    expect(button).toBeTruthy();
    button!.click();
    await tick();

    const witch = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (x) => x.title === "Witch",
    );
    expect(witch).toBeTruthy();
    witch!.click();

    const icon = (tile: string) =>
      (findLayer(app.manifest.tiles[tile]!.layers, id) as unknown as { icon?: string }).icon;
    await until(() => icon(a) === "Witch");
    expect(icon(b)).toBe("Witch");
  });
});

describe("escape during a drag", () => {
  it("puts the layer back and writes nothing", async () => {
    /* The way out of a drag that went wrong. Until now the only way out was to
     * finish it and press Ctrl+Z — a write to the document and a save, to undo
     * something that was never meant, and with several tiles picked the wrong
     * drag has landed on all of them by then. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("rect");
    const id = tileLayers(tile).at(-1)!.id;
    selectLayer(id, tile);
    await tick();

    const canvas = (window as { tesseraWall?: fabric.Canvas }).tesseraWall!;
    const objectFor = () =>
      canvas.getObjects().find((o) => {
        const t = o as Tagged;
        return t.layerId === id && t.tileId === tile;
      }) as Tagged | undefined;
    await until(() => !!objectFor());
    const obj = objectFor()!;

    const at = () => ({ ...(findLayer(app.manifest.tiles[tile]!.layers, id) as unknown as { x: number; y: number }) });
    const from = at();
    const stood = obj.getCenterPoint();
    const steps = historySteps().length;

    // Once, not on every step of the gesture: the harness calls this on each
    // move, and a second Escape after the drag is cancelled means what Escape
    // means the rest of the time — drop the layer.
    let pressed = false;
    await dragObject(canvas, obj, 120, 90, () => {
      if (pressed) return;
      pressed = true;
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await tick();
    await new Promise((r) => setTimeout(r, 120));

    const after = at();
    expect(after.x).toBeCloseTo(from.x, 6);
    expect(after.y).toBeCloseTo(from.y, 6);
    // Nothing to undo: a cancelled gesture is not an edit.
    expect(historySteps().length).toBe(steps);
    /* On screen too, not merely in the document. Clearing Fabric's transform is
       enough to write nothing, but the object would sit where the hand left it
       until something redrew the tile — a picture that disagrees with the
       document it is a picture of. */
    const back = (canvas.getObjects().find((o) => {
      const t = o as Tagged;
      return t.layerId === id && t.tileId === tile;
    }) as Tagged).getCenterPoint();
    expect(back.x).toBeCloseTo(stood.x, 1);
    expect(back.y).toBeCloseTo(stood.y, 1);

    // And the layer is still the one picked, ready to be dragged again.
    expect(app.selected).toBe(id);
  });
});

describe("the arrow keys", () => {
  const press = (key: string, shift = false) =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true }));

  it("nudges the picked layer a tile pixel, and ten with shift", async () => {
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("rect");
    const id = tileLayers(tile).at(-1)!.id;
    selectLayer(id, tile);
    const at = () => findLayer(app.manifest.tiles[tile]!.layers, id)!;
    const from = at().x;

    press("ArrowRight");
    await until(() => at().x !== from);
    expect(at().x).toBeCloseTo(from + 1 / TILE_W, 6);

    const one = at().x;
    press("ArrowRight", true);
    await until(() => at().x !== one);
    expect(at().x).toBeCloseTo(one + 10 / TILE_W, 6);

    // Down is down: y grows towards the chin, as everywhere else.
    const before = at().y;
    press("ArrowDown");
    await until(() => at().y !== before);
    expect(at().y).toBeCloseTo(before + 1 / TILE_H, 6);
  });

  it("reaches every picked tile, the way a drag does", async () => {
    await enterInbox();
    const [a, b] = app.folderIds;
    app.selectedTiles = [a, b];
    await addTileShape("rect");
    const id = tileLayers(a).at(-1)!.id;
    selectLayer(id, a);
    const on = (tile: string) => findLayer(app.manifest.tiles[tile]!.layers, id)!;
    const from = { a: on(a).x, b: on(b).x };

    press("ArrowLeft");
    await until(() => on(a).x !== from.a);
    expect(on(a).x).toBeCloseTo(from.a - 1 / TILE_W, 6);
    expect(on(b).x).toBeCloseTo(from.b - 1 / TILE_W, 6);
  });
});

describe("blend mode in the panel", () => {
  const blendBox = () =>
    [...document.querySelectorAll<HTMLSelectElement>("aside label.field select")].find(
      (s) => s.closest("label")!.querySelector("span")!.textContent === "Blend",
    );

  it("writes the picked mode onto the layer", async () => {
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("rect");
    const shape = tileLayers(tile).at(-1)!;
    selectLayer(shape.id, tile);
    reveal("props");
    await tick();
    await until(() => !!blendBox());

    const box = blendBox()!;
    // Every mode the canvas has, so the menu cannot quietly lose one.
    expect(box.options.length).toBe(13);
    box.value = "multiply";
    box.dispatchEvent(new Event("change", { bubbles: true }));

    const mode = () =>
      (findLayer(app.manifest.tiles[tile]!.layers, shape.id) as unknown as { blend?: string })
        .blend;
    await until(() => mode() === "multiply");
    expect(undoLabel()).toBe("Change blend");
  });

  it("does not offer one on a group", async () => {
    /* A group is a displacement its members are drawn by — there is no object of
     * its own on the canvas for a mode to mix, so offering the control would
     * promise something no pixel follows. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("rect");
    const one = tileLayers(tile).at(-1)!;
    await addTileShape("ellipse");
    const two = tileLayers(tile).at(-1)!;
    selectLayer(one.id, tile);
    alsoSelect(two.id, tile);
    await groupPicked();

    const group = tileLayers(tile).find((l) => l.kind === "group")!;
    selectLayer(group.id, tile);
    reveal("props");
    await tick();
    // Wait for the panel to be showing the group before reading what it lacks.
    await until(() =>
      [...document.querySelectorAll("aside p.empty")].some((p) =>
        p.textContent!.includes("carries its children"),
      ),
    );
    expect(blendBox()).toBeUndefined();
  });
});

describe("lining layers up", () => {
  const press = (title: string) => {
    const button = [...document.querySelectorAll("button")].find((b) =>
      b.title.startsWith(title),
    ) as HTMLButtonElement | undefined;
    expect(button).toBeTruthy();
    expect(button!.disabled).toBe(false);
    button!.click();
  };
  const boxed = (tile: string, id: string) =>
    findLayer(app.manifest.tiles[tile]!.layers, id) as unknown as { x: number; w: number };

  it("puts the picked layers against the tile's edge from the toolbar", async () => {
    /* The arithmetic has its own tests in geometry.ts; what this holds is the
     * wiring — that the button reaches the layers the pick names, and that
     * both of them move, not just the one the panel is showing. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("rect");
    const a = tileLayers(tile).at(-1)!;
    await addTileShape("ellipse");
    const b = tileLayers(tile).at(-1)!;
    await setTileLayerField([tile], a.id, "x", 0.3);
    await setTileLayerField([tile], b.id, "x", 0.75);
    selectLayer(a.id, tile);
    alsoSelect(b.id, tile);
    await tick();

    press("Line up on the left");
    await until(() => boxed(tile, a.id).x !== 0.3);
    // Left edge on the tile's left edge: a layer's x is its centre.
    expect(boxed(tile, a.id).x).toBeCloseTo(boxed(tile, a.id).w / 2, 5);
    expect(boxed(tile, b.id).x).toBeCloseTo(boxed(tile, b.id).w / 2, 5);
    expect(undoLabel()).toBe("Line up on the left");
  });

  it("lines a grouped layer up where it is drawn, not where it is stored", async () => {
    /* A group's x/y is a displacement its children are drawn by, so a child's
     * own coordinate is not where it is on the tile. Aligning on the stored
     * number would leave it hanging off the edge by the group's offset —
     * exactly the jump every other boundary in this app has to fold in. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("rect");
    const one = tileLayers(tile).at(-1)!;
    await addTileShape("ellipse");
    const two = tileLayers(tile).at(-1)!;
    selectLayer(one.id, tile);
    alsoSelect(two.id, tile);
    await groupPicked();
    const group = tileLayers(tile).find((l) => l.kind === "group")!;
    // A fifth of a tile to the right: 0.5 is the neutral, undisplaced position.
    await setTileLayerField([tile], group.id, "x", 0.7);

    selectLayer(one.id, tile);
    await tick();
    press("Line up on the left");
    await until(() => boxed(tile, one.id).x !== 0.5);

    const child = boxed(tile, one.id);
    expect(child.x + 0.2).toBeCloseTo(child.w / 2, 5);
  });
});

describe("the wall follows the wheel", () => {
  /* The bug this pins was reported as "the zoom only takes effect once I click
   * something else", with panning moving in steps for the same reason. Neither
   * was slowness: Fabric asks for the repaint after a viewport change only when
   * renderOnAddRemove is on, and it is off here so that building a wall of
   * forty-four does not request a frame per object. So the transform moved and
   * nothing painted until an unrelated event happened to. */
  it("paints after a wheel zoom, with no other event to prompt it", async () => {
    await enterInbox();
    const canvas = (window as { tesseraWall?: fabric.Canvas }).tesseraWall!;
    await until(() => canvas.getObjects().length > 0);

    /* Counting after:render is not enough: Fabric fires it for the interaction
       layer too, and handling the wheel repaints that whichever way this goes —
       a version of this test that counted those passed without the fix. What
       has to be true is that the wheel asks for a frame of the object canvas. */
    let asked = 0;
    const original = canvas.requestRenderAll.bind(canvas);
    canvas.requestRenderAll = () => {
      asked++;
      return original();
    };
    const before = canvas.getZoom();

    canvas.upperCanvasEl.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -240, clientX: 40, clientY: 40, bubbles: true }),
    );

    expect(canvas.getZoom()).not.toBe(before);
    expect(asked).toBeGreaterThan(0);
  });
});

describe("three the demolition took and nobody missed", () => {
  /* The last of the list in removed-tests.txt. None of them describes anything
   * that changed with the layouts — they went because the file they lived in
   * was cut, which is a worse reason than the other twenty-three had. */

  const press = (key: string, init: KeyboardEventInit = {}) =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));

  const sheetOpen = (heading: string) =>
    [...document.querySelectorAll("h2")].some((h) => h.textContent!.trim() === heading);

  it("does not open the keyboard sheet under the icon grid", async () => {
    /* Both sheets sit at the same z-index and the grid is later in the markup,
     * so it wins. Without the guard `?` opened the keyboard sheet out of sight
     * and the key looked broken. */
    await enterInbox();
    const [id] = app.folderIds;
    app.selectedTiles = [id];
    await addTileShape("icon", "Ranger");
    await tick();

    const badge = [...document.querySelectorAll("button.swatch.art")].at(-1) as HTMLButtonElement;
    badge.click();
    await tick();
    expect(sheetOpen("Keyboard and mouse")).toBe(false);

    press("?");
    await tick();
    expect(sheetOpen("Keyboard and mouse")).toBe(false);

    // Escape closes the grid, and then the key works.
    press("Escape");
    await tick();
    press("?");
    await tick();
    expect(sheetOpen("Keyboard and mouse")).toBe(true);
  });

  it("files a drawerful of tiles as one step, and says which way it went", async () => {
    /* The drawer's "+" filed the tiles one at a time — twenty tiles, twenty
     * checkpoints, twenty saves racing each other, and nineteen more presses of
     * Ctrl+Z than the gesture deserved. The context menu had used the bulk
     * writer for this all along.
     *
     * And three labels named one direction for an action that goes both ways:
     * "Undone: Archive tiles" over tiles coming back out of the archive says
     * the opposite of what happened. */
    await enterInbox();
    const ids = app.folderIds.slice(0, 3);
    app.selectedTiles = [...ids];
    await newProjectFrom("Konto");
    const p = projects()[0].id;
    openProjectView(p);
    await newFolderHere("Fertig");
    const folder = folders()[0];

    app.selectedTiles = [...ids];
    const steps = historySteps().length;
    await fileSelectionInto(folder.id);
    expect(historySteps().length).toBe(steps + 1);
    expect(folders()[0].tiles.sort()).toEqual([...ids].sort());
    // One press puts all three back out.
    await undoEdit();
    expect(folders()[0].tiles).toEqual([]);

    // The label follows the direction.
    app.selectedTiles = [ids[0]];
    await fileTile(ids[0], folder.id);
    expect(history.past.at(-1)?.label).toBe("File tile");
    await fileTile(ids[0], "");
    expect(history.past.at(-1)?.label).toBe("Take tile out of its folder");
  });

  it("lists two snapshots of one name without taking the sidebar down", async () => {
    /* Names are kept apart within one scope, and the overview deliberately
     * lists the document-wide snapshots together with any left behind by a
     * deleted project. So two "Snapshot 1" taken on different walls meet in one
     * list — and a keyed `each` throws on the pair rather than drawing it,
     * which takes the sidebar with it in the packaged build as well as in
     * development. */
    await enterInbox();
    app.selectedTiles = app.folderIds.slice(0, 2);
    await newProjectFrom("Konto");
    const p = projects()[0].id;

    // One on the overview, one inside the project, under the same name — which
    // each scope allows, because their files are keyed by the project too.
    // Making a project opens it, so the overview has to be gone back to.
    openProjectView("");
    await takeSnapshot("Snapshot 1");
    openProjectView(p);
    await takeSnapshot("Snapshot 1");
    expect(new Set(app.snapshots.map((s) => s.name)).size).toBe(1);
    expect(app.snapshots).toHaveLength(2);

    // The project goes; its snapshot stays and lands in the overview's list.
    await deleteProject(p);
    reveal("snapshots");
    await tick();
    await new Promise((r) => setTimeout(r, 150));

    expect(snapshots().length).toBe(2);
    // The list drew both, and the sidebar is still standing.
    expect(document.querySelectorAll("aside").length).toBeGreaterThan(0);
  });

  it("leaves Delete to a dropdown that has the keyboard", async () => {
    /* A select takes the keyboard the way a field does — letters jump to a
     * name, the arrows walk the list — and the panel's Font and Mask controls
     * are two of them. Delete pressed there reached the global handler and took
     * the layer off its tile: the cursor was in a control belonging to the very
     * layer that vanished. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileText();
    const caption = tileLayers(tile).at(-1)!;
    selectLayer(caption.id, tile);
    reveal("props");
    await tick();

    const font = [...document.querySelectorAll("label.field")]
      .find((l) => l.querySelector("span")?.textContent?.trim() === "Font")
      ?.querySelector("select") as HTMLSelectElement;
    expect(font).toBeTruthy();
    font.focus();
    font.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    await tick();
    await new Promise((r) => setTimeout(r, 80));

    expect(findLayer(tileLayers(tile), caption.id)).toBeTruthy();

    // The same key with the focus anywhere else does take the layer off, or
    // this proves nothing about the dropdown.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    await until(() => !findLayer(tileLayers(tile), caption.id));
  });

  it("ignores undo and delete while a long action is reading the document", async () => {
    /* Every button that changes the document is disabled while one of these
     * runs. The keys were not — and "Write to game" holds a reference to the
     * open project across the snapshot it writes first, so an undo landing in
     * that window swapped the document out from under a write already under
     * way: portraits rendered from the new document into the old one's slot
     * order, into the game's own folder, and recorded as written, so the next
     * open reported nothing wrong. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("rect");
    const layer = tileLayers(tile).at(-1)!;
    await setTileLayerField([tile], layer.id, "x", 0.9);
    selectLayer(layer.id, tile);

    app.busy = "save";
    press("z", { ctrlKey: true });
    await tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(findLayer(tileLayers(tile), layer.id)!.x).toBeCloseTo(0.9, 6);
    press("Delete");
    await tick();
    expect(findLayer(tileLayers(tile), layer.id)).toBeTruthy();

    // And they come back when it is over.
    app.busy = "";
    press("z", { ctrlKey: true });
    await until(() => findLayer(tileLayers(tile), layer.id)!.x !== 0.9);
  });

  it("puts the game's portraits back without touching the document", async () => {
    /* The vault holds what BDO shipped, and putting it back is the way out of a
     * wall that went wrong. It writes files and nothing else: the layers stay,
     * so the wall on screen is unchanged and one more click undoes nothing. */
    await enterInbox();
    const [a] = app.folderIds;
    app.selectedTiles = [a];
    await addTileShape("rect");
    await newProjectFrom("Konto");
    openProjectView(projects()[0].id);
    const before = JSON.stringify(app.manifest);

    await saveToGame();
    await until(() => !app.busy);
    await restoreProject();
    await until(() => !app.busy);

    expect(app.note).toContain("put back in the game");
    expect(JSON.stringify(app.manifest)).toBe(before);
  });

  it("opens the wall's menu on the tile under the cursor", async () => {
    /* The tile under the cursor is the one meant, unless it is already part of
     * the selection — then the selection is what was meant, which is the rule
     * every file manager uses. It used to re-target only when nothing at all
     * was picked, so right-clicking tile A while B and C were selected quietly
     * acted on B and C. */
    await enterInbox();
    const canvas = (window as { tesseraWall?: fabric.Canvas }).tesseraWall!;
    await until(() => canvas.getObjects().length > 0);

    /* Sized and placed by hand, for the reason the guide-grid test above gives:
       mounted in a bare document the stage collapses to a pixel wide and the
       wall is drawn at 0.02% zoom, where every cell centre rounds to the same
       point and tileAtEvent cannot tell them apart. */
    canvas.setDimensions({ width: 900, height: 700 });
    canvas.setViewportTransform([0.1, 0, 0, 0.1, 0, 0]);
    canvas.renderAll();
    await tick();

    const stage = document.querySelector(".stage") as HTMLElement;
    const rightClickAt = (x: number, y: number) => {
      stage.dispatchEvent(
        new MouseEvent("contextmenu", { clientX: x, clientY: y, bubbles: true }),
      );
    };

    /* Which cell a point lands on is GridCanvas's own arithmetic, and guessing
       at it from here only tests the guess — an earlier version of this put the
       second click a row off and failed on the coordinates rather than on the
       rule. So the point is asked once what it means, and the answer is reused. */
    /* Recomputed before every click, never cached. Setting the selection runs
       the effects that own the viewport, so a point worked out once points
       somewhere else by the next click — an earlier version of this asked the
       same coordinates twice and got two different tiles. */
    const firstCell = () => {
      const r = canvas.upperCanvasEl.getBoundingClientRect();
      const vt = canvas.viewportTransform!;
      const at = cellAt(0);
      return {
        x: r.left + (at.x + TILE_W / 2) * vt[0] + vt[4],
        y: r.top + (at.y + TILE_H / 2) * vt[3] + vt[5],
      };
    };

    // A tile nobody picked becomes the selection.
    app.selectedTiles = [];
    await tick();
    let p = firstCell();
    rightClickAt(p.x, p.y);
    await tick();
    const under = app.selectedTiles[0];
    expect(under).toBeTruthy();

    /* And the same click inside an existing selection leaves it whole. It used
       to re-target whenever anything at all was picked, so right-clicking one
       of three selected tiles quietly acted on one. */
    const other = visibleIds().find((id) => id !== under)!;

    /* The case that separates the two rules, and the reason this test exists.
       Both the old rule and the new one leave an existing selection alone when
       the click lands inside it, and both take a tile when nothing is picked —
       so neither of those can tell them apart. This one can: a click on a tile
       the selection does not contain has to re-target, and the rule it replaced
       only re-targeted when nothing at all was picked. */
    app.selectedTiles = [other];
    await tick();
    p = firstCell();
    rightClickAt(p.x, p.y);
    await tick();
    expect(app.selectedTiles).toEqual([under]);

    // And a click inside the selection leaves it whole.
    app.selectedTiles = [under, other];
    await tick();
    p = firstCell();
    rightClickAt(p.x, p.y);
    await tick();
    expect(app.selectedTiles).toEqual([under, other]);
  });
});

describe("two guards the wall was given and nothing checked", () => {
  async function wallWith(make: () => Promise<void>) {
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await make();
    const layer = tileLayers(tile).at(-1)!;
    selectLayer(layer.id, tile);
    const canvas = (window as { tesseraWall?: fabric.Canvas }).tesseraWall!;
    await until(() => canvas.getObjects().some((o) => (o as Tagged).layerId === layer.id));
    return { canvas, tile, layer };
  }

  it("puts the wall back when a drag is undone", async () => {
    /* A plain drag deliberately asks for no rebuild, because the object the
     * hand moved is the layer and the canvas is already right. What that skips
     * is the *record* of what the canvas shows: the fingerprint the incremental
     * redraw compares against still describes the wall before the drag.
     *
     * So the undo restores exactly the state the fingerprint remembers, the
     * comparison answers "nothing changed", and nothing is repainted. The
     * status line says "Undone: Move layer", the model holds the old position,
     * the file on disk holds the old position, and the wall — and anything
     * rendered from what the wall thinks it has — goes on showing the new one.
     *
     * Read off the canvas on purpose. Asked of the model this passes today. */
    const { canvas, tile, layer } = await wallWith(() => addTileShape("rect"));
    const at = () =>
      canvas.getObjects().find((o) => (o as Tagged).layerId === layer.id)?.left ?? NaN;
    // Settled first: a rebuild still owed from building the tile would land
    // afterwards and refresh the fingerprint by accident.
    await new Promise((r) => setTimeout(r, 500));
    const obj = canvas.getObjects().find((o) => (o as Tagged).layerId === layer.id)! as Tagged;
    const was = { left: at(), x: findLayer(tileLayers(tile), layer.id)!.x };

    /* The write a plain move makes, asked for outright rather than through a
     * gesture: `structural: false` is the contract — "the canvas already shows
     * this, do not rebuild" — and every drag whose object comes back at scale 1
     * takes it. Moving the object first is the half a hand would have done. */
    obj.set({ left: (obj.left ?? 0) + 80 });
    obj.setCoords();
    await applyTransform(
      obj,
      {
        x: was.x + 80 / TILE_W,
        y: findLayer(tileLayers(tile), layer.id)!.y,
        rotation: 0,
        fx: 1,
        fy: 1,
        scale: (findLayer(tileLayers(tile), layer.id) as ShapeLayer).w,
        scaleH: (findLayer(tileLayers(tile), layer.id) as ShapeLayer).h,
      },
      false,
    );
    expect(at()).toBeGreaterThan(was.left + 20);

    await undoEdit();
    await until(() => findLayer(tileLayers(tile), layer.id)!.x === was.x);
    // Given long enough that a rebuild would have landed if one were coming.
    await new Promise((r) => setTimeout(r, 400));
    expect(at()).toBeCloseTo(was.left, 0);
  });

  it("stops answering the mouse the moment its padlock is clicked", async () => {
    /* The lock no longer rebuilds the wall — it changes no pixels, and doing so
     * across fourteen tiles was throwing the whole wall away and baking every
     * mask again. What it must still do is take the layer out of reach, and
     * the flag the canvas was reading is written when the object is built: it
     * says what was true then. Read off the document instead. */
    const { canvas, tile, layer } = await wallWith(() => addTileShape("rect"));
    const obj = () =>
      canvas.getObjects().find((o) => (o as Tagged).layerId === layer.id) as fabric.Object;
    await until(() => !!obj()?.evented);

    await toggleLayerLocked(layer.id, tile);
    await tick();
    await until(() => !obj().evented);
    expect(obj().selectable).toBe(false);

    // And back again, without a rebuild in either direction.
    await toggleLayerLocked(layer.id, tile);
    await tick();
    await until(() => obj().evented);
  });

  it("moves a flattened layer by the distance dragged, never to its bake's corner", async () => {
    /* A cut layer and a class icon are composited to pixels and placed at the
     * cell's origin, so the object on the canvas sits at 0,0 at scale 1 whatever
     * the model says. Reading its transform back as a position would write that
     * over a real placement and the layer would jump to the corner of its tile.
     *
     * That used to be avoided by refusing the drop, which left the gesture half
     * done: Fabric moves the object during the drag whatever the handler
     * decides, so the icon lay where it was dropped with the model still
     * holding the old position, until some later action rebuilt the tile and it
     * jumped back. Reported as "the tile only updates once I do something
     * else".
     *
     * What is readable is the distance: the bake starts at the cell's origin,
     * so how far it has left that is how far the hand moved. Both halves are
     * asserted here — the layer moves by exactly that, and it does not land at
     * the corner, which is what the refusal was protecting. */
    const { canvas, tile, layer } = await wallWith(() => addTileShape("icon", "Ranger"));
    /* Not the frame, and waited for rather than taken. The frame now appears by
     * itself on exactly these layers and carries the same layerId, so the wall
     * briefly holds one object for this layer that the renderer did not build —
     * `flattened` is the mark of one that it did. */
    type Baked = fabric.Object & { flattened?: boolean };
    const bake = () =>
      canvas
        .getObjects()
        .find((o) => (o as Tagged).layerId === layer.id && "flattened" in o) as Baked | undefined;
    await until(() => !!bake());
    const obj = bake()!;
    expect(obj.flattened).toBe(true);
    // No handles on a bake: a factor read off a tile-sized picture says nothing
    // about the layer inside it.
    expect(obj.hasControls).toBe(false);

    const before = { ...findLayer(app.manifest.tiles[tile]!.layers, layer.id)! };
    obj.set({ left: (obj.left ?? 0) + 120, top: (obj.top ?? 0) + 90 });
    obj.setCoords();
    canvas.fire("object:modified", { target: obj });
    await until(() => findLayer(app.manifest.tiles[tile]!.layers, layer.id)!.x !== before.x);

    const after = findLayer(app.manifest.tiles[tile]!.layers, layer.id)!;
    expect(after.x).toBeCloseTo(before.x + 120 / TILE_W, 6);
    expect(after.y).toBeCloseTo(before.y + 90 / TILE_H, 6);
    // The failure the refusal existed for: the bake's own origin, written in.
    expect(after.x).toBeGreaterThan(0.1);
  });

  it("does not count a bake's displacement twice when two drags run together", async () => {
    /* The distance a bake has moved is read from the cell's origin, which is
     * where the next rebuild puts it back. Two gestures close enough together
     * that the rebuild has not landed between them therefore read the first
     * one's distance a second time: 120 then 80 more comes out as 320 instead
     * of 200, and a picture walks off its tile in a few drags.
     *
     * The same shape as the stand-in's factor — a number that only means what
     * it says while something resets it. */
    const { canvas, tile, layer } = await wallWith(() => addTileShape("icon", "Ranger"));
    type Baked = fabric.Object & { flattened?: boolean };
    const bake = () =>
      canvas
        .getObjects()
        .find((o) => (o as Tagged).layerId === layer.id && "flattened" in o) as Baked | undefined;
    await until(() => !!bake());
    const obj = bake()!;
    const from = { ...findLayer(app.manifest.tiles[tile]!.layers, layer.id)! };

    obj.set({ left: (obj.left ?? 0) + 120 });
    obj.setCoords();
    canvas.fire("object:modified", { target: obj });
    await until(() => findLayer(app.manifest.tiles[tile]!.layers, layer.id)!.x !== from.x);

    // Straight on, on the same object, before any rebuild can put it back.
    obj.set({ left: (obj.left ?? 0) + 80 });
    obj.setCoords();
    canvas.fire("object:modified", { target: obj });
    await new Promise((r) => setTimeout(r, 400));

    const after = findLayer(app.manifest.tiles[tile]!.layers, layer.id)!;
    expect(after.x).toBeCloseTo(from.x + 200 / TILE_W, 4);
  });

  it("leaves the wording to the panel, not the tile's row", async () => {
    /* The row carried a wording field per caption and the panel carries one
     * too. The row's was a single-line input, so the one thing a caption most
     * often wants — a second line — could only be typed in the panel. Two
     * fields for one value with only one of them able to hold it, so the row's
     * is gone; this holds it gone. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileText();
    reveal("tiles");
    reveal(tile);
    await tick();
    await until(() => !!document.querySelector(`[data-tile="${tile}"]`));

    expect(document.querySelectorAll(`[data-tile="${tile}"] .field input`)).toHaveLength(0);

    // The panel still has it, and it takes more than one line.
    selectLayer(tileLayers(tile).at(-1)!.id, tile);
    reveal("props");
    await tick();
    const wording = () =>
      [...document.querySelectorAll<HTMLTextAreaElement>("aside label.field textarea")].filter(
        (t) => t.closest("label")!.querySelector("span")!.textContent === "Text",
      );
    await until(() => wording().length === 1);
  });

  it("keeps a tile's wording field when the caption is put in a group", async () => {
    /* The row's own fields are built from what the tile draws, and that reading
     * stopped at the top level. So grouping a nameplate — the rectangle and the
     * caption on it, the most ordinary tidying there is — took the wording box
     * out of the row, dropped the headline back to the seventeen-digit id, and
     * stopped the Enter-walk on that tile. Naming forty-four portraits is the
     * job this app exists for, and tidying up broke it. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("rect");
    const plate = tileLayers(tile).at(-1)!;
    await addTileText();
    const caption = tileLayers(tile).at(-1)!;
    await setTileLayerField([tile], caption.id, "text", "Aria");
    expect(tileCaptions(tile).map((l) => l.id)).toContain(caption.id);
    expect(tileHeadline(tile)).toBe("Aria");

    selectLayer(plate.id, tile);
    alsoSelect(caption.id, tile);
    await groupPicked();

    // Still the tile's caption, still its headline.
    expect(tileCaptions(tile).map((l) => l.id)).toContain(caption.id);
    expect(tileHeadline(tile)).toBe("Aria");
  });

  it("takes them along with several tiles picked too", async () => {
    /* The same gesture meant two different things depending on how many
     * portraits happened to be selected: with one tile picked a Ctrl-picked
     * second layer came along, with two or more it stayed where it was.
     *
     * They travel on the tile the hand was on. The other tiles get the dragged
     * layer's placement copied — copying a *distance* onto a layer that sits
     * somewhere else on that portrait would move it where nobody pointed. */
    await enterInbox();
    const [a, b] = app.folderIds;
    app.selectedTiles = [a, b];
    await addTileShape("rect");
    const one = tileLayers(a).at(-1)!;
    await addTileShape("ellipse");
    const two = tileLayers(a).at(-1)!;
    await setTileLayerField([a, b], two.id, "y", 0.8);

    selectLayer(one.id, a);
    alsoSelect(two.id, a);
    const was = {
      one: { ...findLayer(tileLayers(a), one.id)! },
      two: { ...findLayer(tileLayers(a), two.id)! },
      twoOnB: { ...findLayer(tileLayers(b), two.id)! },
    };

    await applyTransformBulk(
      { layerId: one.id, tileId: a, space: "tile", locked: false } as Tagged,
      { x: was.one.x + 0.2, y: was.one.y, rotation: 0, scale: 0.3, scaleH: 0.3, fx: 1, fy: 1 },
      [a, b],
    );

    // The dragged layer landed on both tiles, as it always did.
    expect(findLayer(tileLayers(a), one.id)!.x).toBeCloseTo(was.one.x + 0.2, 6);
    expect(findLayer(tileLayers(b), one.id)!.x).toBeCloseTo(was.one.x + 0.2, 6);
    /* The extra travelled the same distance — on every picked tile, keeping
     * the place it has on each of them. That is the difference between the two
     * halves: the dragged layer is placed, the extra is nudged. */
    expect(findLayer(tileLayers(a), two.id)!.x).toBeCloseTo(was.two.x + 0.2, 6);
    expect(findLayer(tileLayers(a), two.id)!.y).toBeCloseTo(was.two.y, 6);
    expect(findLayer(tileLayers(b), two.id)!.x).toBeCloseTo(was.twoOnB.x + 0.2, 6);
    expect(findLayer(tileLayers(b), two.id)!.y).toBeCloseTo(was.twoOnB.y, 6);
  });

  it("takes the layers picked alongside it the same distance", async () => {
    /* Two layers on one tile, neither in a group: Ctrl-click adds the second to
     * the pick and a drag on the first carries both.
     *
     * The same distance, not to the same place — they keep the gap between
     * them, which is the whole reason for moving two at once. One undo step for
     * the pair, because it was one gesture. */
    const { canvas, tile, layer } = await wallWith(async () => {
      await addTileShape("rect");
      const first = tileLayers(app.folderIds[0]).at(-1)!;
      await setTileLayerField([app.folderIds[0]], first.id, "x", 0.3);
    });
    app.selectedTiles = [tile];
    await addTileShape("ellipse");
    const mate = tileLayers(tile).at(-1)!;
    await setTileLayerField([tile], mate.id, "y", 0.8);

    selectLayer(layer.id, tile);
    alsoSelect(mate.id, tile);
    expect(pickedLayers()).toEqual([layer.id, mate.id]);

    canvas.setDimensions({ width: 900, height: 700 });
    canvas.setViewportTransform([0.5, 0, 0, 0.5, 0, 0]);
    canvas.renderAll();
    await tick();
    const current = () => canvas.getObjects().find((o) => (o as Tagged).layerId === layer.id);
    let held = current();
    let steady = 0;
    await until(() => {
      const now = current();
      steady = now && now === held ? steady + 1 : 0;
      held = now;
      return steady >= 8;
    });

    const was = {
      one: { ...findLayer(tileLayers(tile), layer.id)! },
      two: { ...findLayer(tileLayers(tile), mate.id)! },
    };
    const steps = historySteps().length;
    /* Where the second one is *drawn*, before and after. The model half of this
     * was right from the first day and the wall did not follow: the extras are
     * separate Fabric objects that no hand touched, and a plain move asks for
     * no rebuild because "the canvas already shows the result" — true of the
     * object under the pointer, false of every other one carried along. */
    const mateAt = () =>
      canvas.getObjects().find((o) => (o as Tagged).layerId === mate.id)?.left ?? NaN;
    const mateWas = mateAt();
    await dragObject(canvas, held!, 60, 0);
    await until(() => findLayer(tileLayers(tile), layer.id)!.x !== was.one.x);

    const now = {
      one: findLayer(tileLayers(tile), layer.id)!,
      two: findLayer(tileLayers(tile), mate.id)!,
    };
    expect(now.one.x - was.one.x).toBeGreaterThan(0.05);
    expect(now.two.x - was.two.x).toBeCloseTo(now.one.x - was.one.x, 6);
    // Its own y is untouched: they travelled, they did not line up.
    expect(now.two.y).toBeCloseTo(was.two.y, 6);
    expect(historySteps().length).toBe(steps + 1);

    // And the wall shows the second one where the model now has it.
    await until(() => Number.isFinite(mateAt()) && mateAt() !== mateWas);
    expect(mateAt() - mateWas).toBeCloseTo((now.two.x - was.two.x) * TILE_W, 0);
  });

  it("groups the picked layers without moving them, and lets them go again", async () => {
    /* A group is made at the centre of the tile, where its displacement is
     * nought — so the members keep the coordinates they had and nothing shifts
     * on the way in. Letting them go folds the displacement back, so they stay
     * where they were drawn however far the group was moved in between. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("rect");
    const one = tileLayers(tile).at(-1)!;
    await setTileLayerField([tile], one.id, "x", 0.25);
    await addTileShape("ellipse");
    const two = tileLayers(tile).at(-1)!;
    await setTileLayerField([tile], two.id, "y", 0.75);
    const was = { one: { ...findLayer(tileLayers(tile), one.id)! }, two: { ...findLayer(tileLayers(tile), two.id)! } };

    selectLayer(one.id, tile);
    alsoSelect(two.id, tile);
    await groupPicked();

    const group = tileLayers(tile).find((l) => l.kind === "group")!;
    expect(group).toBeTruthy();
    expect(tileLayers(tile)).toHaveLength(1);
    expect(app.selected).toBe(group.id);
    // Still exactly where they were: the members are found through the tree.
    expect(findLayer(tileLayers(tile), one.id)!.x).toBeCloseTo(was.one.x, 6);
    expect(findLayer(tileLayers(tile), two.id)!.y).toBeCloseTo(was.two.y, 6);

    await ungroupLayer(group.id, tile);
    expect(tileLayers(tile)).toHaveLength(2);
    expect(findLayer(tileLayers(tile), one.id)!.x).toBeCloseTo(was.one.x, 6);
    expect(findLayer(tileLayers(tile), two.id)!.y).toBeCloseTo(was.two.y, 6);
  });

  it("moves every member when the group is dragged", async () => {
    /* The point of the thing. A group draws nothing of its own — it is
     * dissolved into its members before anything is painted — so it gets the
     * same frame a bake does, and what the drag writes is the group's own x/y.
     * The members follow because that is what a group's position means. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("rect");
    const one = tileLayers(tile).at(-1)!;
    await addTileShape("ellipse");
    const two = tileLayers(tile).at(-1)!;
    await setTileLayerField([tile], two.id, "x", 0.7);

    selectLayer(one.id, tile);
    alsoSelect(two.id, tile);
    await groupPicked();
    const group = tileLayers(tile).find((l) => l.kind === "group")!;
    const was = {
      group: { ...group },
      one: { ...findLayer(tileLayers(tile), one.id)! },
      two: { ...findLayer(tileLayers(tile), two.id)! },
    };

    const canvas = (window as { tesseraWall?: fabric.Canvas }).tesseraWall!;
    await until(() =>
      canvas.getObjects().some((o) => (o as Tagged & { framing?: boolean }).framing),
    );
    const stand = canvas
      .getObjects()
      .find((o) => (o as Tagged & { framing?: boolean }).framing)!;
    expect((stand as Tagged).layerId).toBe(group.id);

    stand.set({ left: (stand.left ?? 0) + 120 });
    stand.setCoords();
    canvas.fire("object:modified", { target: stand });
    await until(() => findLayer(tileLayers(tile), group.id)!.x !== was.group.x);

    /* The group moved and the members did not: their own coordinates are
     * relative to it, and the displacement is what carries them. Read off the
     * model rather than the canvas, because the canvas has no group on it at
     * all — that is the whole reason this needed a frame. */
    const now = findLayer(tileLayers(tile), group.id)!;
    expect(now.x - was.group.x).toBeCloseTo(120 / TILE_W, 4);
    expect(findLayer(tileLayers(tile), one.id)!.x).toBeCloseTo(was.one.x, 6);
    expect(findLayer(tileLayers(tile), two.id)!.x).toBeCloseTo(was.two.x, 6);
  });

  it("keeps a group's frame the size of what is in it after it moves", async () => {
    /* A group's x/y is a displacement, neutral at 0.5, and its members are
     * drawn at their own coordinates plus it. The frame's reach was measured
     * from the group's own x instead of from the neutral middle, so every move
     * grew the box by twice the displacement: half a tile to the right and the
     * frame came out three times too wide, hanging off the members it is meant
     * to enclose — and the snap reasons about that box too. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("rect");
    const one = tileLayers(tile).at(-1)!;
    await addTileShape("ellipse");
    const two = tileLayers(tile).at(-1)!;
    selectLayer(one.id, tile);
    alsoSelect(two.id, tile);
    await groupPicked();
    const group = tileLayers(tile).find((l) => l.kind === "group")!;

    const canvas = (window as { tesseraWall?: fabric.Canvas }).tesseraWall!;
    const frame = () =>
      canvas.getObjects().find((o) => (o as Tagged & { framing?: boolean }).framing) as
        | fabric.Object
        | undefined;
    await until(() => !!frame());
    const first = frame()!;
    const before = first.getScaledWidth();

    // Moved half a tile. The members did not move relative to the group, so
    // the box that encloses them is the same size in the same place on the
    // tile — only the whole thing has shifted.
    await setTileLayerField([tile], group.id, "x", 1);
    await until(() => !!frame() && frame() !== first);

    expect(frame()!.getScaledWidth()).toBeCloseTo(before, 0);
  });

  it("duplicates a layer onto its own tile, clear of the original", async () => {
    /* There was no way to have two of something that share a look. The route
     * was: insert a fresh layer (which lands on every selected tile), copy the
     * properties across through two context menus, then drag the copy off the
     * original it landed exactly on top of. The keyboard sheet has claimed a
     * duplicate exists for longer than one did.
     *
     * Fresh ids all the way down, or the copy and the original answer to the
     * same name on one tile and every lookup takes the first hit. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("rect");
    const one = tileLayers(tile).at(-1)!;
    await setTileLayerField([tile], one.id, "fill", "#00ff88");

    await duplicateLayer(one.id, tile);

    const own = tileLayers(tile);
    expect(own).toHaveLength(2);
    const copy = own.find((l) => l.id !== one.id)! as ShapeLayer;
    // Its own id and name, the original's look, and not hidden behind it.
    expect(copy.id).not.toBe(one.id);
    expect(copy.name).not.toBe(one.name);
    expect(copy.fill).toBe("#00ff88");
    expect(copy.x).toBeGreaterThan((findLayer(own, one.id) as ShapeLayer).x);
    // And it is what the panel is now showing.
    expect(app.selected).toBe(copy.id);

    /* A group comes with its members, each of them under an id of its own —
     * two layers of one name on a tile is the shape nothing here copes with. */
    await addTileShape("ellipse");
    const two = tileLayers(tile).at(-1)!;
    selectLayer(one.id, tile);
    alsoSelect(two.id, tile);
    await groupPicked();
    const group = tileLayers(tile).find((l) => l.kind === "group")!;
    await duplicateLayer(group.id, tile);

    const ids = [...walkLayers(tileLayers(tile))].map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    const groups = tileLayers(tile).filter((l) => l.kind === "group");
    expect(groups).toHaveLength(2);
    expect(groups[0].kind === "group" && groups[0].children).toHaveLength(2);
    /* And every one of them wears a name of its own. The members came out
     * carrying the names they were copied from, so the tile listed polygon01
     * and ellipse01 twice and only the group's own number told them apart. */
    const names = [...walkLayers(tileLayers(tile))].map((l) => l.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("puts a layer into a group that already exists, where it was drawn", async () => {
    /* The model has taken a parent since the day groups arrived, and the row
     * list computes the answer for a drop in a row's middle third — but the
     * flag that offers that third was hard-coded false and the drop was written
     * as "no parent". So a group could be made and never added to: the only way
     * to put a fifth layer in a group of four was to dissolve it, re-select all
     * five and group again.
     *
     * Crossing the boundary swaps the top level's displacement for the group's,
     * which is what keeps the layer where it is drawn. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("rect");
    const one = tileLayers(tile).at(-1)!;
    await addTileShape("ellipse");
    const two = tileLayers(tile).at(-1)!;
    selectLayer(one.id, tile);
    alsoSelect(two.id, tile);
    await groupPicked();
    const group = tileLayers(tile).find((l) => l.kind === "group")!;
    await setTileLayerField([tile], group.id, "x", 0.75);

    // A third layer, loose, at a place of its own.
    await addTileShape("rect");
    const joiner = tileLayers(tile).at(-1)!;
    await setTileLayerField([tile], joiner.id, "x", 0.2);
    const drawnAt = findLayer(tileLayers(tile), joiner.id)!.x;

    await dropTileLayer(tile, joiner.id, group.id, null);

    expect(groupHolding(joiner.id, tile)?.id).toBe(group.id);
    expect(tileLayers(tile).some((l) => l.id === joiner.id)).toBe(false);
    /* Same place on the tile, now said in the group's coordinates: its own x
     * plus the group's quarter-tile shift is where it was. */
    expect(findLayer(tileLayers(tile), joiner.id)!.x + 0.25).toBeCloseTo(drawnAt, 6);
  });

  it("colours a group's row and its members' rows, and nothing else", async () => {
    /* Asked for as: give grp01 red and every layer in it shows red — and
     * nothing in the layers' own properties or on the wall changes. So it is a
     * mark on the row, held once on the group: a member wears its group's
     * rather than carrying a copy, which is why recolouring cannot half-apply
     * and why a layer taken out of the group loses the colour by leaving. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("rect");
    const one = tileLayers(tile).at(-1)!;
    await setTileLayerField([tile], one.id, "fill", "#00ff88");
    await addTileShape("ellipse");
    const two = tileLayers(tile).at(-1)!;
    selectLayer(one.id, tile);
    alsoSelect(two.id, tile);
    await groupPicked();
    const group = tileLayers(tile).find((l) => l.kind === "group")!;
    reveal(group.id);
    reveal("tiles");
    await tick();

    await setTileLayerField([tile], group.id, "tint", "#ff0000");
    await tick();
    const painted = () =>
      [...document.querySelectorAll("li.tinted")].map(
        (el) => (el as HTMLElement).style.getPropertyValue("--tint") || "",
      );
    // The group's row and both of its members', all in the one colour.
    await until(() => painted().length === 3);
    expect(new Set(painted())).toEqual(new Set(["#ff0000"]));

    /* What must not have happened: the members' own colours are their own, and
     * the wall has nothing to redraw — a mark on a row is not a pixel. */
    expect((findLayer(tileLayers(tile), one.id) as ShapeLayer).fill).toBe("#00ff88");
    expect(findLayer(tileLayers(tile), two.id)!.tint).toBeUndefined();
    const wall = { ids: visibleIds(), gridLayers: [] };
    const before = wallPrint(wall, clone(app.manifest));
    await setTileLayerField([tile], group.id, "tint", "#0000ff");
    expect(tilesChanged(before, wallPrint(wall, clone(app.manifest)))).toEqual([]);
  });

  it("says why a group cannot be put inside itself", async () => {
    /* The one drop the model refuses: a group inside itself, or inside
     * anything it holds, takes the whole branch out of reach of every list.
     * The row springing back reads as a drag that never registered, so the
     * refusal says what it is. (A row dropped on itself never gets this far —
     * the drag layer ignores its own row, which is the right kind of nothing.)
     */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("rect");
    const one = tileLayers(tile).at(-1)!;
    await addTileShape("ellipse");
    const two = tileLayers(tile).at(-1)!;
    selectLayer(one.id, tile);
    alsoSelect(two.id, tile);
    await groupPicked();
    const group = tileLayers(tile).find((l) => l.kind === "group")!;
    const steps = historySteps().length;

    app.error = "";
    await dropTileLayer(tile, group.id, group.id, null);
    expect(app.error).toContain("inside itself");
    // Into one of its own members, which is the same mistake one level down.
    app.error = "";
    await dropTileLayer(tile, group.id, one.id, null);
    expect(app.error).toContain("inside itself");

    // And nothing moved, and no step was spent saying so.
    expect(groupHolding(one.id, tile)?.id).toBe(group.id);
    expect(historySteps().length).toBe(steps);
  });

  it("takes a layer out of its group and leaves it where it was drawn", async () => {
    /* Crossing that boundary swaps one displacement for another: the group's
     * for the top level's. Without the swap the layer jumps by the group's
     * offset, which is exactly the thing nobody asked for when they said "take
     * this one out". */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("rect");
    const one = tileLayers(tile).at(-1)!;
    await addTileShape("ellipse");
    const two = tileLayers(tile).at(-1)!;
    selectLayer(one.id, tile);
    alsoSelect(two.id, tile);
    await groupPicked();

    const group = tileLayers(tile).find((l) => l.kind === "group")!;
    await setTileLayerField([tile], group.id, "x", 0.75);
    // Where it is drawn: its own x plus the group's quarter-tile shift.
    const drawnAt = findLayer(tileLayers(tile), two.id)!.x + 0.25;

    expect(groupHolding(two.id, tile)?.id).toBe(group.id);
    await takeOutOfGroup(two.id, tile);

    expect(groupHolding(two.id, tile)).toBeUndefined();
    expect(tileLayers(tile).some((l) => l.id === two.id)).toBe(true);
    // Same place on the tile, now said in its own coordinates.
    expect(findLayer(tileLayers(tile), two.id)!.x).toBeCloseTo(drawnAt, 6);
    // The group keeps the other one.
    expect(groupHolding(one.id, tile)?.id).toBe(group.id);
  });

  it("hides and deletes a layer that sits inside a group", async () => {
    /* Every row in the list carries an eye, a lock and a ×, and the rows for a
     * group's children are drawn by the same snippet as the rest. Two of the
     * three did nothing there: the finder walks the tree, the writer looked at
     * the top level only, and they disagreed in silence. The lock beside them
     * worked, which is what made it read as a fluke rather than a rule.
     *
     * The delete was the worse half. It got past its own guard — that one
     * walks — and then removed nothing, while still pushing a step named
     * "Delete layer" that undoes to the same picture. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("rect");
    const one = tileLayers(tile).at(-1)!;
    await addTileShape("ellipse");
    const two = tileLayers(tile).at(-1)!;
    selectLayer(one.id, tile);
    alsoSelect(two.id, tile);
    await groupPicked();
    const group = tileLayers(tile).find((l) => l.kind === "group")!;

    await toggleLayerHidden(two.id, tile);
    expect(findLayer(tileLayers(tile), two.id)!.hidden).toBe(true);
    await toggleLayerHidden(two.id, tile);
    expect(findLayer(tileLayers(tile), two.id)!.hidden).toBeFalsy();

    await deleteLayer(two.id, tile);
    expect(findLayer(tileLayers(tile), two.id)).toBeUndefined();
    // The group is still there with the other one in it: a member leaving is
    // not the group dissolving.
    expect(groupHolding(one.id, tile)?.id).toBe(group.id);
  });

  it("takes a grouped layer off every picked tile", async () => {
    /* The wall menu counts with a walk and removed without one, so "Remove
     * layer — 2 tile(s)" reported two and reached none. */
    await enterInbox();
    const [a, b] = app.folderIds;
    app.selectedTiles = [a, b];
    await addTileShape("rect");
    const one = tileLayers(a).at(-1)!;
    await addTileShape("ellipse");
    const two = tileLayers(a).at(-1)!;
    for (const t of [a, b]) {
      selectLayer(one.id, t);
      alsoSelect(two.id, t);
      await groupPicked();
    }
    app.selectedTiles = [a, b];
    expect(layersOnSelection().find((l) => l.id === two.id)?.tiles).toBe(2);

    await removeLayerFromSelection(two.id);
    for (const t of [a, b]) expect(findLayer(tileLayers(t), two.id)).toBeUndefined();
  });

  it("frames a layer picked inside a group, where the group has put it", async () => {
    /* Reported as: clicking the picture inside a group shows no frame and no
     * ghost on the wall.
     *
     * The frame looked the layer up in the tile's own stack, and a layer inside
     * a group is not in that array — it is in the group's children. It reads
     * what the wall draws instead, which is the stack with the groups folded
     * away and their displacement carried by the members. That second half
     * matters as much as the first: the frame has to stand where the layer is
     * drawn, not where its own coordinates say. */
    await enterInbox();
    const tile = app.folderIds[0];
    app.selectedTiles = [tile];
    await addTileShape("icon", "Ranger");
    const member = tileLayers(tile).at(-1)!;
    await addTileShape("rect");
    const other = tileLayers(tile).at(-1)!;
    selectLayer(member.id, tile);
    alsoSelect(other.id, tile);
    await groupPicked();

    const group = tileLayers(tile).find((l) => l.kind === "group")!;
    // Move the group, so the member's drawn place and its own differ.
    await setTileLayerField([tile], group.id, "x", 0.75);
    selectLayer(member.id, tile);

    const canvas = (window as { tesseraWall?: fabric.Canvas }).tesseraWall!;
    await until(() =>
      canvas.getObjects().some((o) => (o as Tagged & { framing?: boolean }).framing),
    );
    const stand = canvas
      .getObjects()
      .find((o) => (o as Tagged & { framing?: boolean }).framing)!;
    expect((stand as Tagged).layerId).toBe(member.id);

    // Where the wall draws it: the member's own x plus the group's shift.
    const inside = findLayer(tileLayers(tile), member.id)!;
    const cell = cellAt(visibleIds().indexOf(tile));
    expect((stand.left ?? 0) - cell.x).toBeCloseTo((inside.x + 0.25) * TILE_W, 0);
  });

  it("pulls a dragged layer onto its cell's centre", async () => {
    /* The wall snaps a tile layer against its own cell and its neighbours on
     * that tile — the same pull the layout editor had, with the cell where the
     * sheet used to be. Asserted as an outcome: dragged to just short of the
     * centre, it has to land exactly on it. */
    const { canvas, tile, layer } = await wallWith(async () => {
      await addTileShape("rect");
      const l = tileLayers(app.folderIds[0]).at(-1)!;
      await setTileLayerField([app.folderIds[0]], l.id, "x", 0.3);
    });

    /* Given a real size and zoom first, for the reason the guide-grid test
       gives: mounted in a bare document the stage collapses to a pixel wide and
       the wall is drawn at 0.02% zoom, where a drag of sixty scene pixels is
       sub-pixel on screen and Fabric's transform does nothing at all. */
    canvas.setDimensions({ width: 900, height: 700 });
    canvas.setViewportTransform([0.5, 0, 0, 0.5, 0, 0]);
    canvas.renderAll();
    await tick();

    /* Held still first. Setting the field bumps the document and the wall
       redraws the tile, so the object fetched a moment earlier is replaced and
       the gesture lands on an orphan — the same race the placing-tool tests
       ran into, with the same silent pass-or-fail. */
    const current = () => canvas.getObjects().find((o) => (o as Tagged).layerId === layer.id);
    let held = current();
    let steady = 0;
    await until(() => {
      const now = current();
      steady = now && now === held ? steady + 1 : 0;
      held = now;
      return steady >= 8;
    });
    const obj = held!;
    /* The number, not the layer. findLayer hands back the live object, so
       holding it and comparing `.x` against itself later is a condition that
       can never come true — this test waited out its own deadline on exactly
       that while the drag underneath had worked perfectly. */
    const startX = findLayer(app.manifest.tiles[tile]!.layers, layer.id)!.x;
    // Short of the middle by a couple of scene pixels: inside the pull, and
    // nowhere near it without one.
    const gap = (0.5 - startX) * TILE_W - 3;
    await dragObject(canvas, obj, gap, 0);
    await until(() => findLayer(app.manifest.tiles[tile]!.layers, layer.id)!.x !== startX);

    const landed = findLayer(app.manifest.tiles[tile]!.layers, layer.id)!;
    expect(landed.x).toBeCloseTo(0.5, 3);
  });

  it("keeps drawing the layer it is dragging when the tile is rebuilt under it", async () => {
    /* Reported as: with one tile picked, dragging a layer moves only the frame
     * — the layer stays where it was and catches up the moment anything in the
     * panel is changed. With every tile picked it follows live.
     *
     * A rebuild takes the tile's objects off the canvas and puts new ones back.
     * Fabric holds the one being dragged, so it goes on transforming an object
     * that is no longer on the canvas: its controls are drawn from the active
     * object and keep moving, while the lower canvas shows the fresh object
     * standing at the old position. The drop still writes — object:modified
     * carries the detached object and its transform is real — so the model is
     * right and only the picture is wrong, until the next structural change
     * rebuilds and finally draws it.
     *
     * Two things had to be true at once for the earlier attempt at this test to
     * miss it. The bump has to change something on *this* tile, or
     * tilesChanged returns an empty list and no object is replaced at all; and
     * it has to land inside the gesture, which is what every other drag test
     * here carefully waits out. */
    const tile0 = () => app.folderIds[0];
    const { canvas, tile, layer } = await wallWith(async () => {
      await addTileText();
      await addTileShape("rect");
    });
    const caption = tileLayers(tile0()).find((l) => l.kind === "text")!;

    canvas.setDimensions({ width: 900, height: 700 });
    canvas.setViewportTransform([0.5, 0, 0, 0.5, 0, 0]);
    canvas.renderAll();
    await tick();

    const current = () => canvas.getObjects().find((o) => (o as Tagged).layerId === layer.id);
    let held = current();
    let steady = 0;
    await until(() => {
      const now = current();
      steady = now && now === held ? steady + 1 : 0;
      held = now;
      return steady >= 8;
    });
    const obj = held!;

    let bumped = false;
    await dragObject(canvas, obj, 90, 0, () => {
      if (bumped) return;
      bumped = true;
      // What changing a field in the panel does, on this tile, right now.
      void setTileLayerField([tile], caption.id, "opacity", 0.5);
    });
    await until(() => !canvas.getObjects().includes(obj), 3000).catch(() => {});

    /* The object the wall is drawing has to be the one the hand moved. Asked of
     * the canvas rather than the model, because the model was never the part
     * that was wrong. */
    const drawn = current();
    expect(drawn).toBeTruthy();
    const cell = cellAt(visibleIds().indexOf(tile));
    expect((drawn!.left ?? 0) - cell.x).toBeCloseTo(
      findLayer(app.manifest.tiles[tile]!.layers, layer.id)!.x * TILE_W,
      0,
    );
  });
});
