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
  app,
  applyTransform,
  applyTransformBulk,
  addTileShape,
  addTileText,
  bulkTargets,
  selectLayer,
  setTileLayerField,
  archived,
  archiveSelection,
  endGesture,
  deleteLayer,
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
  openFolder,
  openProjectView,
  projects,
  renameSnapshot,
  restoreSnapshot,
  stripSelectedTiles,
  saveToGame,
  snapshots,
  takeSnapshot,
  tileLayers,
  unplace,
  visibleIds,
  renameLayer,
  tileCaptions,
  toggleLayerHidden,
  toggleTile,
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
import { maskChoices } from "./lib/model";
import { cellAt, textWidth, type Tagged } from "./lib/scene";
import { TILE_H, TILE_W } from "./lib/bmp";
import { dragObject } from "./test/gestures";
import {
  undoLabel,
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
    expect(app.error).toContain("Nothing to put back");
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
    await addTileShape("rect");
    const layer = tileLayers(tile).at(-1)!;
    selectLayer(layer.id, tile);

    const mode = [...document.querySelectorAll("button")].find((b) =>
      (b.title ?? "").startsWith("Place a tile's own layers"),
    ) as HTMLButtonElement;
    mode.click();

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

  it("leaves no per-tile frame record behind", async () => {
    const { canvas, stand, tile } = await placing();
    await dragObject(canvas, stand, 60, 40);
    /* The whole point of the rewiring: the placement is on the layer, and
     * nothing grows a second copy of it beside the tile. */
    expect((app.manifest.tiles[tile] as unknown as { frame?: unknown }).frame).toBeUndefined();
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
