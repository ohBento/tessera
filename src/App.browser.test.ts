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
import { resetRows } from "./lib/rows.svelte";
import {
  addLayoutShape,
  addLayoutText,
  app,
  applyLayoutTransform,
  applyTransform,
  applyTransformBulk,
  addTileText,
  bulkTargets,
  selectLayer,
  setTileLayerField,
  assignLayoutToSelection,
  assignLayoutToWall,
  canGroupLayers,
  archived,
  archiveSelection,
  closeLayoutDoc,
  dropLayoutLayer,
  duplicateLayoutLayers,
  endGesture,
  deleteLayer,
  freeCount,
  history,
  setLayerField,
  redoEdit,
  undoEdit,
  groupLayoutLayers,
  inbox,
  layouts,
  moveLayersIntoGroup,
  moveTilesToProject,
  deleteProject,
  newProjectFrom,
  openFolder,
  openProjectView,
  projects,
  remainingFor,
  renameSnapshot,
  restoreSnapshot,
  deleteLayoutDoc,
  deleteLayoutLayers,
  setTileFrame,
  setTileText,
  removeLayoutFrom,
  wearing,
  stripSelectedTiles,
  saveToGame,
  snapshots,
  takeSnapshot,
  tileLayers,
  unplace,
  renameLayer,
  setLayoutSelection,
  tileCaptions,
  toggleLayerHidden,
  toggleLayoutPick,
  toggleTile,
} from "./lib/editor.svelte";
import {
  addLayoutImage,
  assignTileLayout,
  newLayoutDoc,
  openLayout,
  saveLayout,
} from "./lib/editor.svelte";
import {
  emptyManifest,
  findLayer,
  groupShift,
  isGradient,
  layerLabel,
  newImageLayer,
  newShapeLayer,
  type ImageLayer,
  type ShapeLayer,
  type TextLayer,
} from "./lib/model";
import {
  layerShows,
  offLayouts,
} from "./lib/stamps";
import { maskChoices, maskOffers } from "./lib/model";
import { textWidth, type Tagged } from "./lib/scene";
import {
  canSaveLayout,
  undoLabel,
  openLayoutDoc,
  tileAsset,
  tileIcons,
  tileText,
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

  it("stamps a per-tile caption onto the tile, live", async () => {
    /* Through the editor, not the model: the unit tests hand syncLiveLayers
     * plain objects, and the app hands it Svelte $state proxies — which is a
     * different thing entirely, and the difference silently broke the whole
     * feature. Anything reachable only through a real edit belongs here. */
    const [a] = app.folderIds;

    await newLayoutDoc("Mit Text");
    await addLayoutText();
    const caption = openLayout()!.layers[0];
    await setLayerField(caption.id, "perTile", true);
    await setLayerField(caption.id, "text", "Kachel {{id}}");

    await assignTileLayout(a, openLayout()!.id);

    expect(app.error).toBe("");
    expect(tileLayers(a).map((l) => l.kind)).toEqual(["image", "text"]);
    // Recorded, or "Update stamps" would be greyed out forever.
    expect(openLayout()!.stamped).toBeTruthy();
    // And the tile's own row can find it.
    expect(tileCaptions(a)).toHaveLength(1);
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

  it("puts the toolbar's caption on the picked tiles when no layout is open", async () => {
    /* The same button in two places. Inside a Layout it joins the sheet; on the
     * wall it goes onto the picked tiles, which is what the sheet used to be
     * the only way to do. Clicked rather than called, because the wiring is the
     * thing being tested — the actions themselves have their own test. */
    await enterInbox();
    const [a, b] = app.folderIds;
    app.selectedTiles = [a, b];
    await tick();

    const insert = [...document.querySelectorAll("button")].find(
      (x) => x.title.startsWith("Insert text"),
    ) as HTMLButtonElement | undefined;
    if (!insert) throw new Error("no insert-text button in the toolbar");
    // It says where it will land, so the same glyph twice is never a guess.
    expect(insert.title).toContain("2 selected tiles");
    expect(insert.disabled).toBe(false);

    insert.click();
    await until(() => tileLayers(a).some((l) => l.kind === "text"));
    expect(tileLayers(b).some((l) => l.kind === "text")).toBe(true);
    // And it went to the tiles, not into a layout nobody opened.
    expect(layouts()).toHaveLength(0);
  });

  it("adds a caption to every picked tile at once, sharing its id", async () => {
    /* The shared id is the point, not an accident: it is what makes the new
     * caption bulk-editable straight away, and it is the shape a stamped
     * design left behind minus the stamp. */
    await enterInbox();
    const [a, b, c] = app.folderIds;
    const steps = history.past.length;

    app.selectedTiles = [a, b];
    await addTileText();

    const caption = (tile: string) => tileLayers(tile).find((l) => l.kind === "text");
    expect(caption(a)).toBeTruthy();
    expect(caption(b)).toBeTruthy();
    expect(caption(c)).toBeUndefined();
    expect(caption(a)!.id).toBe(caption(b)!.id);
    expect(history.past.length).toBe(steps + 1);

    // And it is immediately what a bulk edit reaches.
    expect(bulkTargets(caption(a)!.id).sort()).toEqual([a, b].sort());
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

  it("stamps one layout onto every picked tile in one step", async () => {
    /* Assigning was one dropdown per row: forty-four visits to give a wall its
     * design, forty-four renders of the same flat sheet, forty-four undo
     * steps. The picture is identical for all of them, so it is rendered once
     * and every tile is pointed at it inside a single mutation. */
    const [a, b, c] = app.folderIds;

    queuePick(await magentaSquare("blatt"));
    await newLayoutDoc("Rahmen");
    await addLayoutImage();
    await closeLayoutDoc();

    const steps = history.past.length;
    app.selectedTiles = [a, b, c];
    await assignLayoutToSelection(layouts()[0].id);

    for (const id of [a, b, c]) expect(tileLayers(id)).toHaveLength(1);
    // One asset for all three: the same rendered sheet, not three of them.
    const assets = new Set([a, b, c].map((id) => (tileLayers(id)[0] as ImageLayer).asset));
    expect(assets.size).toBe(1);
    expect(history.past.length).toBe(steps + 1);
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
    expect(app.error).toContain("1 tile(s) taken back");
  });

  it("answers the whole changed list at once, each way round", async () => {
    /* The mass case: the game regenerated the folder wholesale. "All same"
     * records the files as seen and keeps every layer; "All new" strips the
     * tiles and sends them back to Unsorted. Driven through the buttons, since
     * the alert only exists when changedTiles says so. */
    const [a, b] = app.folderIds;
    app.selectedTiles = [a, b];
    await newProjectFrom("Konto");
    queuePick(await magentaSquare("massen"));
    await newLayoutDoc("Massentest");
    await addLayoutImage();
    await closeLayoutDoc();
    await assignTileLayout(a, layouts()[0].id);
    expect(app.manifest.tiles[a].layers.length).toBeGreaterThan(0);

    // Still on the overview — nothing here entered a wall — where the alert lives.
    app.hashes = { ...app.hashes, [a]: "neu-a", [b]: "neu-b" };
    app.changedTiles = [a, b];
    await until(
      () => ![...document.querySelectorAll("button")].every((x) => x.textContent!.trim() !== "All same characters"),
    );
    const byLabel = (t: string) =>
      [...document.querySelectorAll("button")].find((x) => x.textContent!.trim() === t)!;

    byLabel("All same characters").click();
    await until(() => app.changedTiles.length === 0);
    // Layers untouched, ownership untouched: same characters, new bytes.
    expect(app.manifest.tiles[a].layers.length).toBeGreaterThan(0);
    expect(projects()).toHaveLength(1);

    app.hashes = { ...app.hashes, [a]: "neu2-a" };
    app.changedTiles = [a];
    await until(
      () => ![...document.querySelectorAll("button")].every((x) => x.textContent!.trim() !== "All new characters"),
    );
    /* Answered yes on purpose: this is the button that deletes the vaulted
       originals, so it asks first now — and a test that let the dialog default
       to "no" would be testing nothing. */
    const asked: string[] = [];
    const real = window.confirm;
    window.confirm = (m?: string) => {
      asked.push(m ?? "");
      return true;
    };
    try {
      byLabel("All new characters").click();
      await until(() => app.changedTiles.length === 0);
    } finally {
      window.confirm = real;
    }
    expect(asked[0]).toContain("vaulted originals are deleted");
    // A stranger inherited the slot: bare, and back on the unsorted pile.
    expect(app.manifest.tiles[a].layers).toEqual([]);
    expect(projects()[0].order).toEqual([b]);
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

  it("sweeps stamps of a deleted layout out of a restored snapshot", async () => {
    /* A project snapshot restores the wall and its tiles but deliberately not
     * the layout library, so one taken before a layout was deleted put that
     * layout's stamps back with nothing left to name them — pictures labelled
     * with a raw id, sitting on the tiles until the next start. The rule is
     * that a layout and its layers do not survive each other, and it has to
     * hold on this route too.
     *
     * A document-wide snapshot is the case that needs no sweep: it brings the
     * library back with it, so the stamps have their layout again. */
    const [a] = app.folderIds;
    app.selectedTiles = [a];
    await newProjectFrom("Konto");
    const projectId = projects()[0].id;
    openProjectView(projectId);

    queuePick(await magentaSquare("blatt"));
    await newLayoutDoc("Rahmen");
    await addLayoutImage();
    await closeLayoutDoc();
    await assignTileLayout(a, layouts()[0].id);
    expect(tileLayers(a).length).toBeGreaterThan(0);

    await takeSnapshot("Mit Layout");
    await deleteLayoutDoc(layouts()[0].id);
    expect(tileLayers(a)).toHaveLength(0);

    await restoreSnapshot({ name: "Mit Layout", projectId });

    expect(layouts()).toHaveLength(0);
    // The stamp does not come back on its own, with no layout left to name it.
    expect(tileLayers(a)).toHaveLength(0);
  });

  it("says how many tiles it undressed instead of doing it in silence", async () => {
    const [a] = app.folderIds;
    queuePick(await magentaSquare("blatt2"));
    await newLayoutDoc("Rahmen");
    await addLayoutImage();
    await closeLayoutDoc();
    await assignTileLayout(a, layouts()[0].id);

    app.selectedTiles = [a];
    await stripSelectedTiles();

    expect(tileLayers(a)).toHaveLength(0);
    expect(app.error).toContain("1 tile(s)");
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

  it("shows one row for a layout, not a second for the picture it keeps live", async () => {
    /* A layout with a per-tile picture puts two layers on the tile: the stamp
     * and the live copy. Both are images carrying the same layoutId, so a rule
     * written on kind alone kept both — the tile read "2 layout(s)" and the
     * two rows marked different things on the wall. Live captions were already
     * hidden; the picture is the same kind of copy. */
    const a = app.folderIds[0];

    queuePick(await magentaSquare("logo"));
    await newLayoutDoc("Mit Logo");
    await addLayoutImage();
    const pic = openLayout()!.layers[0];
    await setLayerField(pic.id, "perTile", true);
    await assignTileLayout(a, openLayout()!.id);
    await until(() => tileLayers(a).length === 2);

    // Through the list, because the list is where it was wrong.
    await closeLayoutDoc();
    /* The tile-section head, not the project row of the same name — both read
     * "Unsorted" now, and only this one carries the count. */
    const section = [...document.querySelectorAll("aside button.name")].find((b) =>
      b.textContent!.includes("right-click the wall to assign"),
    ) as HTMLButtonElement;
    section.click();

    const row = () =>
      [...document.querySelectorAll("aside button.name")].find((b) =>
        b.textContent!.trim().startsWith(a),
      );
    await until(() => !!row());
    expect(row()!.textContent).toContain("1 layout(s)");
  });

  it("a class per tile takes what the icon cuts along with it", async () => {
    /* The real setup, from a real manifest: a block of colour cut to the class
     * icon. The mask is chosen while both are ordinary Layout layers; the
     * switch comes after. The rule only lets a per-tile cutter cut a per-tile
     * layer, so flipping it used to void the mask in silence — the block kept a
     * maskId that no longer applied, the dropdown stopped listing the icon, and
     * the wall showed a whole rectangle beside a badge instead of one cut to
     * the other. */
    await newLayoutDoc("Klassenschnitt");
    await addLayoutShape("icon", "Ranger");
    const icon = openLayout()!.layers[0];
    await addLayoutShape("rect");
    const block = openLayout()!.layers.find((l) => l.id !== icon.id)!;
    await setLayerField(block.id, "maskId", icon.id);

    await setLayerField(icon.id, "perTile", true);

    const now = (id: string) => openLayout()!.layers.find((l) => l.id === id)!;
    expect(now(block.id).perTile).toBe(true);
    // And the cutter is still on offer for it, which is the same fact stated
    // by the control the user actually looks at.
    expect(maskChoices(openLayout()!.layers, block.id).map((l) => l.id)).toContain(icon.id);
  });

  it("choosing a mask that lives on the tiles takes the layer along", async () => {
    /* The other half of the same rule. A per-tile cutter may only cut a
     * per-tile layer, so a plain rectangle could not be cut by a class icon
     * that names a class per tile — and the dropdown answered by leaving the
     * icon out entirely, with nothing said. It is offered now, and picking it
     * sends the rectangle to the tiles as well, which is the only way the pair
     * can exist at all. */
    await newLayoutDoc("Maske folgt");
    await addLayoutShape("icon", "Ranger");
    const icon = openLayout()!.layers[0];
    await setLayerField(icon.id, "perTile", true);
    await addLayoutShape("rect");
    const block = openLayout()!.layers.find((l) => l.id !== icon.id)!;
    expect(block.perTile).toBeFalsy();

    // The icon is on offer even though today's rule would refuse it.
    expect(maskOffers(openLayout()!.layers, block.id).map((l) => l.id)).toContain(icon.id);

    await setLayerField(block.id, "maskId", icon.id);

    const now = openLayout()!.layers.find((l) => l.id === block.id)!;
    expect(now.perTile).toBe(true);
    // And the cut is legal, so it will actually render.
    expect(maskChoices(openLayout()!.layers, block.id).map((l) => l.id)).toContain(icon.id);
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

  it("hiding a stamp hides the whole assignment, live layers and all", async () => {
    /* The stamp's row speaks for the copies a Layout keeps beside it — they
     * have no row of their own. Hiding it and leaving those drawn meant the
     * eye did nothing you could see: the caption and the logo stayed on the
     * wall with nothing left to switch them off.
     *
     * Asserted as what draws, not as which flags are set. This test used to
     * check that `hidden` had been copied onto the live layer, and that copy
     * was itself the bug below: it pinned the mechanism, so the mechanism could
     * not be corrected without the test objecting. */
    const a = app.folderIds[0];
    await newLayoutDoc("Mit Text");
    await addLayoutText();
    const caption = openLayout()!.layers[0];
    await setLayerField(caption.id, "perTile", true);
    await assignTileLayout(a, openLayout()!.id);
    await until(() => tileLayers(a).length === 2);
    const shows = () => {
      const off = offLayouts(tileLayers(a));
      return tileLayers(a).map((l) => layerShows(l, off));
    };
    expect(shows()).toEqual([true, true]);

    const stamp = tileLayers(a).find((l) => l.kind === "image")!;
    await toggleLayerHidden(stamp.id);
    expect(shows()).toEqual([false, false]);

    // And back, in one press.
    await toggleLayerHidden(stamp.id);
    expect(shows()).toEqual([true, true]);
  });

  it("keeps a hidden assignment hidden when the layout is updated", async () => {
    /* The eye said "off", "Update stamps" was pressed, and the design came
     * back — captions and all, into the 624x804 file written to the game —
     * with the row still saying "hidden".
     *
     * `syncLiveLayers` rebuilds every live copy from the Layout's own layer, so
     * anything mirrored onto that copy is overwritten. `hidden` was the one
     * thing the tile owned there. It is asked for now rather than stored twice:
     * a copy draws when neither its own eye nor its stamp's is closed. */
    const a = app.folderIds[0];
    await newLayoutDoc("Verschwunden");
    await addLayoutText();
    const caption = openLayout()!.layers[0];
    await setLayerField(caption.id, "perTile", true);
    const layoutId = openLayout()!.id;
    await assignTileLayout(a, layoutId);
    await until(() => tileLayers(a).length === 2);

    const stamp = tileLayers(a).find((l) => l.kind === "image")!;
    await toggleLayerHidden(stamp.id);

    // The design is edited and stamped again, which is the whole loop.
    await setLayerField(caption.id, "size", 0.14);
    await saveLayout(layoutId);
    await until(() => tileLayers(a).length === 2);

    const off = offLayouts(tileLayers(a));
    expect(tileLayers(a).map((l) => layerShows(l, off))).toEqual([false, false]);
    // And one press still brings the whole assignment back.
    await toggleLayerHidden(tileLayers(a).find((l) => l.kind === "image")!.id);
    const back = offLayouts(tileLayers(a));
    expect(tileLayers(a).map((l) => layerShows(l, back))).toEqual([true, true]);
  });

  it("clearing a tile's layers leaves it archived, and keeps its framing out of the way", async () => {
    /* `{ ...emptyTile(), base }` was a whitelist of what to keep, and `Tile`
     * has grown `swap`, `frame` and `archived` since it was written — each one
     * joined the throw-away side in silence. The last of those meant that
     * clearing the layers on a portrait you had put away quietly brought it
     * back onto the Unsorted wall. Named `stripTile` now, so it cannot drop a
     * field it has never heard of. */
    const a = app.folderIds[0];
    await newLayoutDoc("Weg damit");
    await addLayoutText();
    const caption = openLayout()!.layers[0];
    await setLayerField(caption.id, "perTile", true);
    await assignTileLayout(a, openLayout()!.id);
    await closeLayoutDoc();
    await until(() => tileLayers(a).length === 2);
    await setTileFrame(a, caption.id, { x: 0.2, y: 0, z: 1, a: 0 });

    app.selectedTiles = [a];
    await archiveSelection(true);
    expect(archived()).toContain(a);

    app.selectedTiles = [a];
    await stripSelectedTiles();
    expect(tileLayers(a)).toEqual([]);
    // Still put away — the clearing was of its artwork, not of the tile.
    expect(archived()).toContain(a);
    // And its placement went with the layers it belonged to.
    expect(app.manifest.tiles[a].frame).toBeUndefined();
  });

  it("takes one layout off the tiles that wear it, and nothing else", async () => {
    /* The inverse of assigning, and it has to be as thorough. A stamp removed
     * on its own leaves the captions and logos the Layout keeps live beside it
     * drawing on the wall with no row to switch them off — the fault
     * deleteStampCascade exists for — and the tile's own wording, pictures and
     * placements are keyed to those same ids.
     *
     * And it takes only what was asked for: a second design on the same tile
     * stays, which is the whole reason the menu names the layout rather than
     * offering one blunt "clear". */
    const [a, b] = app.folderIds;
    await newLayoutDoc("Weg");
    await addLayoutText();
    const doomed = openLayout()!;
    const caption = doomed.layers[0];
    await setLayerField(caption.id, "perTile", true);
    await closeLayoutDoc();

    await newLayoutDoc("Bleibt");
    const keeper = openLayout()!;
    await addLayoutShape("rect");
    await closeLayoutDoc();

    for (const id of [a, b]) {
      await assignTileLayout(id, doomed.id);
      await assignTileLayout(id, keeper.id);
    }
    await until(() => tileLayers(a).length === 3);
    await setTileText(a, caption.id, "Nachtklinge");
    await setTileFrame(a, caption.id, { x: 0.1, y: 0, z: 1, a: 0 });
    expect(wearing(doomed.id, [a, b])).toEqual([a, b]);

    await removeLayoutFrom(doomed.id, [a]);

    // Gone from the one asked for, stamp and live caption together.
    expect(tileLayers(a).some((l) => l.layoutId === doomed.id)).toBe(false);
    // And its wording and placement with it — both keyed by the caption's id.
    expect(app.manifest.tiles[a].text[caption.id]).toBeUndefined();
    expect(app.manifest.tiles[a].frame?.[caption.id]).toBeUndefined();
    // The other design on the same tile is untouched.
    expect(tileLayers(a).some((l) => l.layoutId === keeper.id)).toBe(true);
    // And so is the tile that was not named.
    expect(wearing(doomed.id, [a, b])).toEqual([b]);
  });

  it("deleting a stamp takes its live caption with it", async () => {
    /* The defect this replaces: the caption survived, no list showed it —
     * they are hidden because the stamp row speaks for them — and it went on
     * rendering on the wall with no row and no way out. Four tiles on the real
     * wall ended up like that. */
    const a = app.folderIds[0];
    await newLayoutDoc("Mit Text");
    await addLayoutText();
    const caption = openLayout()!.layers[0];
    await setLayerField(caption.id, "perTile", true);
    await assignTileLayout(a, openLayout()!.id);
    await until(() => tileLayers(a).length === 2);

    const stamp = tileLayers(a).find((l) => l.kind === "image")!;
    await deleteLayer(stamp.id);
    expect(tileLayers(a)).toEqual([]);
  });

  it("renames a layout from its row", async () => {
    await newLayoutDoc("Alt");
    await closeLayoutDoc();
    await until(() => !app.openLayoutId);

    /* Through the DOM, because the bug was in the DOM: rename and open cannot
     * share the name button — the first click of a double-click would open
     * the document and unmount the row, so the second click landed on nothing
     * and layouts were unrenamable. Double-click renames (like a group row),
     * the pencil opens. */
    const name = [...document.querySelectorAll("aside button.name")].find((b) =>
      b.textContent!.includes("Alt"),
    ) as HTMLButtonElement;
    name.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await until(() => !!document.querySelector("aside input.rename"));

    const input = document.querySelector("aside input.rename") as HTMLInputElement;
    input.value = "Neu";
    input.dispatchEvent(new Event("blur"));
    await until(() => layouts()[0]?.name === "Neu");
    // Renaming must not have opened the document as a side effect.
    expect(app.openLayoutId).toBe("");

    // And the pencil is what opens the editor now.
    const pencil = [...document.querySelectorAll("aside button")].find(
      (b) => (b as HTMLElement).title === "Edit layout",
    ) as HTMLButtonElement;
    pencil.click();
    await until(() => app.openLayoutId === layouts()[0].id);
  });

  it("spends nothing on a rename that changes nothing", async () => {
    await newLayoutDoc("Nur gucken");
    await addLayoutText();
    const layer = openLayout()!.layers[0];
    const steps = history.past.length;

    /* What a cancelled rename does: Escape restores the display label into the
     * field and blur still fires. Writing it back in has to leave both the
     * name and the history exactly as they were. */
    await renameLayer(layer.id, layerLabel(layer));
    expect(history.past.length).toBe(steps);
    expect(findLayer(openLayout()!.layers, layer.id)!.name).toBe("text01");

    // A real rename still lands and costs its one step.
    await renameLayer(layer.id, "Mein Text");
    expect(findLayer(openLayout()!.layers, layer.id)!.name).toBe("Mein Text");
    expect(history.past.length).toBe(steps + 1);
  });
});

describe("dressing a whole wall", () => {
  it("counts only the tiles that still lack the layout, and stamps just those", async () => {
    /* The two-click way to dress a second account's wall. Placed tiles only —
     * the shelf is a waiting area and the game never sees it — and never a
     * second stamp on a tile that already wears the design, so the number in
     * the menu is the work that will actually happen. */
    const [a, b, c] = app.folderIds;
    app.selectedTiles = [a, b, c];
    await newProjectFrom("Konto");
    const project = projects()[0];
    openProjectView(project.id);
    // One of the three waits on the shelf rather than on the wall.
    await unplace(c);

    await newLayoutDoc("Rahmen");
    await addLayoutShape("rect");
    await closeLayoutDoc();
    const layout = layouts()[0].id;

    expect(remainingFor(layout).sort()).toEqual([a, b].sort());

    // One tile gets it the ordinary way first; the count has to drop.
    await assignTileLayout(a, layout);
    expect(remainingFor(layout)).toEqual([b]);

    await assignLayoutToWall(layout);

    expect(remainingFor(layout)).toEqual([]);
    expect(tileLayers(b).some((l) => l.layoutId === layout)).toBe(true);
    // The shelved one is untouched: it was never on the wall.
    expect(tileLayers(c)).toEqual([]);
  });
});

describe("the sheets over the page", () => {
  const sheet = (label: string) => document.querySelector(`[role="dialog"][aria-label="${label}"]`);
  const press = (key: string) =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

  it("does not open the keyboard sheet under the icon grid", async () => {
    /* Both sheets sit at the same z-index and the grid comes later in the
     * markup, so it covers anything opened behind it. `?` toggled its sheet
     * regardless: it went up out of sight, and the next press put it away
     * again — a key that did nothing, twice. */
    await newLayoutDoc("Blätter");
    // Matched on the start of the title: it now names where the icon will land
    // ("into the layout", "onto 3 selected tiles"), which is not what this test
    // is about.
    const icons = () =>
      [...document.querySelectorAll("button")].find((b) =>
        b.title.startsWith("Class icon"),
      ) as HTMLButtonElement;
    await until(() => !!icons() && !icons().disabled);
    icons().click();
    await until(() => !!sheet("Class icons"));

    press("?");
    await tick();
    expect(sheet("Keyboard and mouse")).toBeNull();

    // And it is the grid in the way, not the key: with the grid gone it opens.
    press("Escape");
    await until(() => !sheet("Class icons"));
    press("?");
    await until(() => !!sheet("Keyboard and mouse"));
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
    queuePick(await magentaSquare("tresor"));
    await newLayoutDoc("Tresortest");
    await addLayoutImage();
    await closeLayoutDoc();
    for (const id of ids) await assignTileLayout(id, layouts()[0].id);
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

  it("writes the vault copies over the folder and leaves the document alone", async () => {
    const [a] = app.folderIds;
    const pristine = await readFile(`${app.dir}/${a}.bmp`);
    app.selectedTiles = [a];
    await newProjectFrom("Konto");
    openProjectView(projects()[0].id);
    queuePick(await magentaSquare("zurueck"));
    await newLayoutDoc("Zurücktest");
    await addLayoutImage();
    await closeLayoutDoc();
    await assignTileLayout(a, layouts()[0].id);
    await saveToGame();
    expect(same(await readFile(`${app.dir}/${a}.bmp`), pristine)).toBe(false);

    await restoreProject();

    expect(same(await readFile(`${app.dir}/${a}.bmp`), pristine)).toBe(true);
    expect(app.error).toContain("put back");
    /* "Show the originals in game again", not "throw the work away": every
     * layer stays, and Write to game puts it all back. */
    expect(app.manifest.tiles[a].layers.length).toBeGreaterThan(0);
  });

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
    expect(app.error).toContain("Nothing to put back");
  });
});

describe("the collapsed tile row", () => {
  const row = (id: string) =>
    document.querySelector(`[data-tile="${id}"] .grouphead .name`) as HTMLButtonElement | null;

  /** One tile on a wall, wearing a Layout with a caption and a class icon. */
  async function dressed() {
    const [a] = app.folderIds;
    app.selectedTiles = [a];
    await newProjectFrom("Konto");
    openProjectView(projects()[0].id);
    await newLayoutDoc("Zeilentest");
    await addLayoutText();
    await addLayoutShape("icon", "Ranger");
    // Both have to travel to the tiles, or the tile owns neither its wording
    // nor its class and the row has nothing of its own to show.
    for (const l of openLayout()!.layers) await setLayerField(l.id, "perTile", true);
    await closeLayoutDoc();
    await assignTileLayout(a, layouts()[0].id);
    /* The list is behind its heading, and the heading is a real button — a test
     * that reached past it would keep passing after the rows stopped being
     * reachable. */
    const heading = [...document.querySelectorAll("aside button")].find((b) =>
      b.textContent!.includes("On this wall"),
    ) as HTMLButtonElement;
    heading.click();
    await until(() => !!row(a));
    return a;
  }

  it("leads with what the tile says and keeps the id on the second line", async () => {
    /* "40000000005773694" identifies a file and nobody else. At forty-four
     * portraits the list was a column of digits to be matched against the wall
     * by counting. */
    const a = await dressed();

    // Unnamed: the id is still the headline, and it is not printed twice.
    expect(row(a)!.textContent).toContain(a);
    expect(row(a)!.querySelector(".usage")!.textContent).not.toContain(a);

    await setTileText(a, tileCaptions(a)[0].id, "Nachtklinge");

    await until(() => !!row(a)?.textContent?.includes("Nachtklinge"));
    // The number stays: it is what the folder is sorted by, and the only way to
    // line a row up with a file.
    expect(row(a)!.querySelector(".usage")!.textContent).toContain(a);
  });

  it("takes its headline from this tile, never from the Layout's default", async () => {
    /* The default belongs to every tile wearing that Layout, so a headline read
     * from it is forty-four rows all saying "text01" — the same column of
     * identical strings the id was. */
    const a = await dressed();
    const caption = tileCaptions(a)[0];
    expect(caption.text.length).toBeGreaterThan(0);

    expect(row(a)!.textContent).not.toContain(caption.text);
    expect(row(a)!.textContent).toContain(a);
  });

  it("opens the class grid for that tile, from the row", async () => {
    // The class is half of "who is this" and used to be one expand away, so a
    // wall being dressed was read by opening forty-four rows one at a time.
    const a = await dressed();
    const icon = document.querySelector(`[data-tile="${a}"] .grouphead .rowicon`) as HTMLButtonElement;
    expect(icon).toBeTruthy();

    icon.click();
    await until(() => !!document.querySelector('[role="dialog"][aria-label="Class icons"]'));
    // For this tile, not for the layer: picking here must not restyle the
    // Layout out from under every other portrait wearing it.
    expect(document.querySelector('[aria-label="Class icons"] h2')!.textContent).toContain(
      "Class for this tile",
    );

    const witch = [...document.querySelectorAll(".icongrid button")].find(
      (b) => (b as HTMLElement).title === "Witch",
    ) as HTMLButtonElement;
    witch.click();

    await until(() => tileAsset(a, tileIcons(a)[0].id) === "Witch");
    // And the Layout's own icon is untouched.
    expect(tileIcons(a)[0].icon).toBe("Ranger");
  });
});

describe("typing a wall's names", () => {
  /** Three tiles on a wall, all wearing a Layout whose caption is per-tile. */
  async function three() {
    const ids = app.folderIds.slice(0, 3);
    app.selectedTiles = [...ids];
    await newProjectFrom("Konto");
    openProjectView(projects()[0].id);
    await newLayoutDoc("Namen");
    await addLayoutText();
    await setLayerField(openLayout()!.layers[0].id, "perTile", true);
    await closeLayoutDoc();
    for (const id of ids) await assignTileLayout(id, layouts()[0].id);
    const heading = [...document.querySelectorAll("aside button")].find((b) =>
      b.textContent!.includes("On this wall"),
    ) as HTMLButtonElement;
    heading.click();
    await until(() => !!document.querySelector(`[data-tile="${ids[0]}"]`));
    return ids;
  }

  const field = (id: string) =>
    document.querySelector<HTMLInputElement>(`[data-tile="${id}"] .field input`);

  async function typeInto(id: string, text: string) {
    const input = field(id)!;
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // The layer's own words now, not an override sitting on top of them.
    await until(() => (tileCaptions(id)[0] as TextLayer).text === text);
  }

  const enter = (id: string, shift = false) =>
    field(id)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: shift, bubbles: true }));

  it("carries the cursor into the next tile, and closes the one behind it", async () => {
    /* Naming a wall is the one job here that is forty-four of the same thing,
     * and the list is an accordion: without this, every name costs a reach for
     * the mouse to open the next row. */
    const [a, b] = await three();
    document.querySelector<HTMLButtonElement>(`[data-tile="${a}"] .twisty`)!.click();
    await until(() => !!field(a));
    await typeInto(a, "Nachtklinge");

    enter(a);

    await until(() => !!field(b));
    expect(document.activeElement).toBe(field(b));
    // Closed behind you, or the next row is a metre down the page by tile ten.
    expect(field(a)).toBeNull();
  });

  it("goes back on Shift+Enter and stops at both ends", async () => {
    const [a, b, c] = await three();
    document.querySelector<HTMLButtonElement>(`[data-tile="${a}"] .twisty`)!.click();
    await until(() => !!field(a));

    enter(a);
    await until(() => !!field(b));
    enter(b, true);
    await until(() => !!field(a));
    expect(document.activeElement).toBe(field(a));

    // The first row has nowhere to go back to, and the row stays put.
    enter(a, true);
    await until(() => document.activeElement !== field(a));
    expect(field(a)).toBeTruthy();

    // And the last row does not wrap round to the first: a second pass that
    // started itself would type over the name just given.
    document.querySelector<HTMLButtonElement>(`[data-tile="${c}"] .twisty`)!.click();
    await until(() => !!field(c));
    enter(c);
    await until(() => document.activeElement !== field(c));
    expect(field(c)).toBeTruthy();
    expect(field(a)).toBeNull();
  });
});


describe("undo that says what it takes back", () => {
  const byPrefix = (prefix: string) =>
    [...document.querySelectorAll("button")].find((b) =>
      (b as HTMLElement).title.startsWith(prefix),
    ) as HTMLButtonElement;

  it("names the step on the button before it is pressed, and in the line after", async () => {
    /* Ctrl+Z is the one action with no target: every other edit tells you what
     * it touched by touching it, and this one can reach anywhere on the wall. */
    await newLayoutDoc("Namenstest");
    await addLayoutText();

    await until(() => !!byPrefix("Undo "));
    expect(byPrefix("Undo ").title).toContain("add caption");

    await undoEdit();

    expect(app.error).toBe("Undone: Add caption");
    // And the same edit is what the other button now offers to put back.
    expect(byPrefix("Redo ").title).toContain("add caption");
  });

  it("names the gesture, not its last keystroke", async () => {
    /* Typing collapses into one step, and the step is named by the edit that
     * opened the run — take the newest name and it ends up called after the
     * last letter rather than after the thing you did. */
    const [a] = app.folderIds;
    app.selectedTiles = [a];
    await newProjectFrom("Konto");
    await newLayoutDoc("Tippen");
    await addLayoutText();
    await setLayerField(openLayout()!.layers[0].id, "perTile", true);
    await closeLayoutDoc();
    await assignTileLayout(a, layouts()[0].id);
    const caption = tileCaptions(a)[0];

    for (const word of ["N", "Na", "Nac", "Nacht"]) await setTileText(a, caption.id, word);

    expect(undoLabel()).toBe("Type caption");
    await undoEdit();
    // One press takes the whole word back, not one letter.
    expect(tileText(a, caption.id)).toBeUndefined();
    expect(app.error).toBe("Undone: Type caption");
  });

  it("puts it back on redo, and says that too", async () => {
    /* redo shares travel() with undo, so this is thin — but nothing pressed it
     * at all before, and "shares the code path" stops being true the first time
     * someone special-cases one of travel's two callers. */
    await newLayoutDoc("Wiederholen");
    await addLayoutText();
    const before = openLayout()!.layers.length;

    await undoEdit();
    expect(openLayout()!.layers.length).toBe(before - 1);

    await redoEdit();

    expect(openLayout()!.layers.length).toBe(before);
    expect(app.error).toBe("Redone: Add caption");
  });
});

describe("the right-click menu", () => {
  /* Every action this menu offers is well tested as a function, and the menu
   * that invokes them for most users was never opened by anything. A wrong
   * `disabled`, an item wired to the neighbouring handler, or a regression in
   * ContextMenu itself would all ship in silence. */
  const items = () =>
    [...document.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[];

  it("opens on the wall and acts on the tile under the cursor", async () => {
    const [a, b] = app.folderIds;
    app.selectedTiles = [a, b];
    await newProjectFrom("Konto");
    queuePick(await magentaSquare("menue"));
    await newLayoutDoc("Menütest");
    await addLayoutImage();
    /* Closing a Layout lands back on the overview, so the wall has to be
       entered after that or there is no canvas to right-click on. */
    await closeLayoutDoc();
    /* Entered by clicking its card, the way the other wall tests do it: the
       card is the only way in, and openProjectView alone leaves the overview
       showing — with no canvas to right-click on. */
    const cards = () => [...document.querySelectorAll("button")];
    await until(() => cards().some((x) => x.textContent!.includes("Konto")));
    cards().find((x) => x.textContent!.includes("Konto"))!.click();
    await until(() => !!document.querySelector("canvas.lower-canvas"));

    /* Through the stage's own handler with a real event, so the retargeting
       rule is exercised too: a right-click on a tile outside the selection
       takes that tile rather than acting on what was picked before. */
    app.selectedTiles = [a];
    const stage = document.querySelector(".stage") as HTMLElement;
    expect(stage).toBeTruthy();
    stage.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }));
    await until(() => items().length > 0);

    const assign = items().find((i) => i.textContent!.includes("Assign layout"))!;
    expect(assign).toBeTruthy();
    assign.click();
    await until(() => items().some((i) => i.textContent!.includes("Menütest")));
    items().find((i) => i.textContent!.includes("Menütest"))!.click();

    // The menu did what the function does — and closed behind itself.
    await until(() => tileLayers(app.selectedTiles[0]).length > 0);
    await until(() => items().length === 0);
  });
});
